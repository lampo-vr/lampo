// The folder picker of "Move to…", "Add video" and the upload dialog: one control — a search field over the list — to
// find a project or folder, pick it, or make a new one: the "New project" row at the list's end becomes a name field,
// and a name typed in the search that isn't there yet is offered as "Create “name”" (/ for a folder in it).
// Keys: ↑/↓ move through the list, ↵ picks (a new project's name: creates it), ⌘↵ is the dialog's primary action.
// In a form it folds to one field showing the choice (FolderField), opened in place by a click.
import { type KeyboardEvent, useId, useMemo, useRef, useState } from 'react';
import { useVideoActions } from '../api/mutations.ts';
import type { FolderSuggestion, VideoSummary } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { crumbs, leaf } from '../lib/nav.ts';
import { toastError, toastUndo } from '../lib/toast.ts';
import { I } from '../ui/icons.tsx';
import { IconButton, Modal } from '../ui/primitives.tsx';

const normPath = (s: string) =>
  String(s || '')
    .split('/')
    .map((x) => x.trim())
    .filter(Boolean)
    .join('/');
const depthOf = (p: string) => p.split('/').length - 1;

/** A row of the list: a project or folder (or "No project", or one to create), or the "New project" row. */
type Entry =
  | { kind: 'folder'; key: string; f: string | null; label: string; badge?: string | null; indent?: number; create?: boolean }
  | { kind: 'new'; key: 'new' };

interface FolderPickerProps {
  folders: string[];
  value: string | null;
  onChange: (f: string | null) => void;
  suggestion?: FolderSuggestion | null;
  autoFocus?: boolean;
  /** Folded back into its field (FolderField): Esc in the search and the ⌃ at its end close the list. */
  onClose?: () => void;
}

export function FolderPicker({ folders, value, onChange, suggestion, autoFocus = false, onClose }: FolderPickerProps) {
  const [q, setQ] = useState('');
  // the "New project" row's name while it is a field (null: the row)
  const [naming, setNaming] = useState<string | null>(null);
  // the row the keys moved to, for the search it was moved in (another search starts from its own first row)
  const [moved, setMoved] = useState<{ q: string; at: number } | null>(null);
  const id = useId();
  const search = useRef<HTMLInputElement>(null);
  const typed = normPath(q);
  const shown = useMemo(() => folders.filter((f) => !q || f.toLowerCase().includes(q.toLowerCase())), [folders, q]);
  const newSuggestion = suggestion?.folder && !folders.includes(suggestion.folder) ? suggestion.folder : null;
  const canCreate = !!typed && !folders.includes(typed) && typed !== newSuggestion;

  const entries: Entry[] = [];
  if (!q && newSuggestion)
    entries.push({ kind: 'folder', key: `s:${newSuggestion}`, f: newSuggestion, label: crumbs(newSuggestion), badge: t('SUGGESTED · NEW'), create: true });
  if (!q) entries.push({ kind: 'folder', key: 'none', f: null, label: t('No project') });
  for (const f of shown)
    entries.push({
      kind: 'folder',
      key: `f:${f}`,
      f,
      label: q ? crumbs(f) : leaf(f),
      indent: q ? 0 : depthOf(f),
      badge: suggestion?.folder === f && !q ? t('SUGGESTED') : null,
    });
  if (canCreate) entries.push({ kind: 'folder', key: `c:${typed}`, f: typed, label: t('Create “{crumbs}”', { crumbs: crumbs(typed) }), create: true });
  if (!q) entries.push({ kind: 'new', key: 'new' });

  // Where the keys start: the first match while searching, else the current choice.
  const current = entries.findIndex((e) => e.kind === 'folder' && e.f === value && !e.create);
  const start = q ? 0 : Math.max(0, current);
  const active = moved && moved.q === q && moved.at < entries.length ? moved.at : start;
  const rowId = (at: number) => `${id}-r${at}`;

  const pick = (f: string | null) => {
    onChange(f);
    setQ('');
    setNaming(null);
    setMoved(null);
  };
  const choose = (e: Entry | undefined) => {
    if (!e) return;
    if (e.kind === 'new') setNaming('');
    else pick(e.f);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const at = Math.min(entries.length - 1, Math.max(0, active + (e.key === 'ArrowDown' ? 1 : -1)));
      setMoved({ q, at });
      document.getElementById(rowId(at))?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) {
      // ⌘↵ belongs to the dialog (its primary action), plain Enter to the list
      e.preventDefault();
      choose(entries[active]);
    } else if (e.key === 'Escape' && onClose) {
      // a search first goes back to the whole list, then the list folds away (the dialog stays: data-escape="own")
      e.preventDefault();
      if (q) setQ('');
      else onClose();
    }
  };

  return (
    <div className="fp" data-escape={onClose ? 'own' : undefined} data-testid="folder-picker">
      <div className="fp-search">
        <I name="search" size={15} />
        <input
          ref={search}
          className="fp-input"
          role="combobox"
          aria-expanded
          aria-controls={`${id}-list`}
          aria-activedescendant={naming === null ? rowId(active) : undefined}
          aria-label={t('Find a project')}
          autoFocus={autoFocus}
          placeholder={t('Find a project, or type a new name')}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setNaming(null);
          }}
          onKeyDown={onKey}
        />
        {onClose && <IconButton className="btn ghost sm icon-only fp-fold" label={t('Close the list')} icon="down" size={14} onClick={onClose} />}
      </div>
      <div className="fp-list" role="listbox" id={`${id}-list`} aria-label={t('Projects')}>
        {entries.map((e, at) =>
          e.kind === 'new' ? (
            naming !== null ? (
              <NewProject
                key={e.key}
                name={naming}
                setName={setNaming}
                taken={folders}
                onCreate={(name) => pick(name)}
                onCancel={() => {
                  setNaming(null);
                  search.current?.focus();
                }}
              />
            ) : (
              <button
                key={e.key}
                id={rowId(at)}
                type="button"
                role="option"
                aria-selected={false}
                tabIndex={-1}
                className={`fp-row fp-new ${at === active ? 'active' : ''}`}
                onClick={() => choose(e)}
                onMouseMove={() => at !== active && setMoved({ q, at })}
                data-testid="fp-new"
              >
                <I name="plus" size={14} />
                <span className="grow ellipsis">{t('New project')}</span>
              </button>
            )
          ) : (
            <button
              key={e.key}
              id={rowId(at)}
              type="button"
              role="option"
              aria-selected={!e.create && value === e.f}
              tabIndex={-1}
              className={`fp-row ${!e.create && value === e.f ? 'sel' : ''} ${e.create ? 'create' : ''} ${at === active ? 'active' : ''}`}
              style={e.indent ? { paddingLeft: `calc(var(--sp-2) + ${e.indent} * var(--sp-4))` } : undefined}
              onClick={() => choose(e)}
              onMouseMove={() => at !== active && setMoved({ q, at })}
            >
              <I name={e.create ? 'plus' : e.f ? 'folder' : 'archive'} size={14} />
              <span className="grow ellipsis">{e.label}</span>
              {e.badge && <span className="badge claude">{e.badge}</span>}
              {!!q && at === active && <kbd>↵</kbd>}
              {!e.create && value === e.f && <I name="check" size={14} className="fp-check" />}
            </button>
          ),
        )}
        {q && !entries.length && <div className="fp-none">{t('No project or folder matches.')}</div>}
      </div>
    </div>
  );
}

/** "New project", become a field: the name (/ for a folder in it), ↵ makes it, Esc goes back to the row. */
function NewProject({
  name,
  setName,
  taken,
  onCreate,
  onCancel,
}: {
  name: string;
  setName: (n: string) => void;
  taken: string[];
  onCreate: (name: string) => void;
  onCancel: () => void;
}) {
  const clean = normPath(name);
  const exists = !!clean && taken.includes(clean);
  return (
    <div className="fp-row fp-naming" data-escape="own" data-testid="fp-naming">
      <I name="plus" size={14} />
      <input
        className="fp-input"
        autoFocus
        value={name}
        maxLength={400}
        aria-label={t('Name of the new project')}
        placeholder={t('Project name  ·  / for a folder in it')}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => !clean && onCancel()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (clean) onCreate(clean);
          }
        }}
      />
      {clean && <span className="fp-hint">{exists ? t('Already there: ↵ picks it') : t('↵ creates it')}</span>}
    </div>
  );
}

interface FolderFieldProps {
  folders: string[];
  /** undefined: not known yet (the suggestion is on its way). */
  value: string | null | undefined;
  onChange: (f: string | null) => void;
  suggestion?: FolderSuggestion | null;
  /** Said beside the choice (why it was suggested). */
  note?: string | null;
}

/** The choice in a form: one field that shows it, opened in place into the picker; picking folds it again. */
export function FolderField({ folders, value, onChange, suggestion, note }: FolderFieldProps) {
  const [open, setOpen] = useState(false);
  const field = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    // back on the field, so the keys carry on from where the choice is (⌘↵ still sends the dialog)
    requestAnimationFrame(() => field.current?.focus({ preventScroll: true }));
  };
  if (open)
    return (
      <FolderPicker
        folders={folders}
        value={value ?? null}
        suggestion={suggestion}
        autoFocus
        onClose={close}
        onChange={(f) => {
          onChange(f);
          close();
        }}
      />
    );
  return (
    <button ref={field} type="button" className="folder-field" aria-haspopup="listbox" onClick={() => setOpen(true)} data-testid="folder-field">
      <I name={value === null ? 'archive' : 'folder'} size={15} />
      <span className="grow ellipsis">{value ? crumbs(value) : value === null ? t('No project') : '…'}</span>
      {value && !folders.includes(value) && <span className="badge claude">{t('NEW')}</span>}
      {note && <span className="folder-field-note ellipsis">{note}</span>}
      <I name="down" size={14} className="folder-field-chev" />
    </button>
  );
}

export function MoveModal({ video, folders, onClose }: { video: VideoSummary; folders: string[]; onClose: () => void }) {
  const [sel, setSel] = useState<string | null>(video.folder || null);
  const { move } = useVideoActions();
  const submit = async () => {
    try {
      const from = video.folder || null;
      await move.mutateAsync({ slug: video.slug, folder: sel });
      toastUndo(`${video.name} → ${sel ? crumbs(sel) : t('No project')}`, () => move.mutateAsync({ slug: video.slug, folder: from }));
      onClose();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Modal
      title={t('Move {name}', { name: video.name })}
      onClose={onClose}
      width={520}
      foot={
        <>
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn primary" onClick={submit} disabled={move.isPending || sel === (video.folder || null)}>
            {t('Move here')}
          </button>
        </>
      }
    >
      <FolderPicker folders={folders} value={sel} onChange={setSel} autoFocus />
    </Modal>
  );
}
