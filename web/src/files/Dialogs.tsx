// The Files tab's small dialogs: a name (rename a file or folder, make a folder) and a place (move to another folder
// of the area, or into another project's or folder's files). Each says what is wrong with a name before it is sent
// (lib/fileText.ts: what a path can be; a name taken here), and the change shows at once (FilesPage.tsx).
import { useEffect, useMemo, useRef, useState } from 'react';
import { caseKey, dirOf, filePathProblem } from '../../../lib/fileText.ts';
import { useLibrary } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { crumbs } from '../lib/nav.ts';
import { I } from '../ui/icons.tsx';
import { Modal } from '../ui/primitives.tsx';
import { SkLine } from '../ui/Skeleton.tsx';
import { Select } from '../ui/select.tsx';
import { filesUnder } from './api.ts';
import { spaced } from './model.ts';

/** A name for a file or a folder in `dir` of the area: renaming (`was` its name now) or making one. */
export function NameDialog({
  title,
  action,
  dir,
  was = '',
  taken,
  onDone,
  onClose,
}: {
  title: string;
  action: string;
  dir: string;
  was?: string;
  /** Is a path there already (another file or folder)? */
  taken: (path: string) => boolean;
  onDone: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(was);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.focus();
    // the name without its extension, as a Finder does
    const dot = was.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : was.length);
  }, [was]);
  const n = name.trim() === name ? name : name.trim();
  const path = dir ? `${dir}/${n}` : n;
  const problem = !n
    ? null
    : n.includes('/')
      ? t('A name has no “/” in it: Move to… puts it in another folder')
      : filePathProblem(path)
        ? t('That name can’t be used here: {why}', { why: filePathProblem(path) ?? '' })
        : n !== was && taken(path)
          ? t('“{name}” is here already', { name: n })
          : null;
  const ready = !!n && !problem && n !== was;
  const go = () => ready && onDone(n);
  return (
    <Modal
      title={title}
      onClose={onClose}
      width={440}
      foot={
        <>
          <span className="grow" />
          <button type="button" className="btn" data-keys="Esc" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn primary" disabled={!ready} onClick={go} data-testid="files-name-go">
            {action}
          </button>
        </>
      }
    >
      <label className="pf-dlg-field">
        <span className="pf-dlg-label">{t('Name')}</span>
        <input
          ref={field}
          className="input"
          value={name}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              go();
            }
          }}
          aria-invalid={!!problem}
          data-testid="files-name"
        />
        <span className={`pf-dlg-note ${problem ? 'bad' : ''}`}>{problem ?? (dir ? t('In {where}', { where: spaced(dir) }) : t('At the top'))}</span>
      </label>
    </Modal>
  );
}

/** Where to: a folder of this area (or a new one, typed), or another project's or folder's files. */
export function MoveDialog({
  area,
  what,
  from,
  onDone,
  onClose,
}: {
  area: string;
  /** What moves, in words ("spot.aep", "3 files"). */
  what: string;
  /** The folder it is in now (it isn't offered). */
  from: string;
  onDone: (to: { area: string; dir: string }) => void;
  onClose: () => void;
}) {
  const library = useLibrary().data;
  const [to, setTo] = useState(area);
  const [dirs, setDirs] = useState<string[] | null>(null);
  const [dir, setDir] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  useEffect(() => {
    let live = true;
    setDirs(null);
    setDir(null);
    filesUnder(to, '', 5000)
      .then((rows) => {
        if (!live) return;
        const all = new Set<string>();
        for (const r of rows) for (let d = dirOf(r.path); d; d = dirOf(d)) all.add(d);
        setDirs([...all].sort((a, b) => a.localeCompare(b)));
      })
      .catch(() => live && setDirs([]));
    return () => {
      live = false;
    };
  }, [to]);
  const areas = useMemo(() => ['', ...(library?.folders ?? [])], [library]);
  const clean = typed.trim().replace(/^\/+|\/+$/g, '');
  const typedProblem = clean ? filePathProblem(`${clean}/x`) : null;
  const target = clean && !typedProblem ? clean : dir;
  const same = to === area && (target ?? '') === from;
  const ready = target !== null && !same && !typedProblem;
  return (
    <Modal
      title={t('Move {what}', { what })}
      onClose={onClose}
      width={480}
      foot={
        <>
          <span className="grow" />
          <button type="button" className="btn" data-keys="Esc" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!ready}
            onClick={() => ready && onDone({ area: to, dir: target ?? '' })}
            data-testid="files-move-go"
          >
            {t('Move')}
          </button>
        </>
      }
    >
      <div className="pf-dlg-move">
        <div className="pf-dlg-field">
          <span className="pf-dlg-label">{t('Files of')}</span>
          <Select label={t('Files of')} value={to} onChange={setTo} options={areas.map((a) => ({ value: a, label: a ? crumbs(a) : t('House') }))} />
        </div>
        <div className="pf-dlg-field">
          <span className="pf-dlg-label">{t('Folder')}</span>
          <ul className="pf-dlg-dirs" aria-label={t('Folder')}>
            {dirs === null ? (
              <li className="pf-dlg-dir pending" aria-hidden="true">
                <SkLine w="10em" />
              </li>
            ) : (
              ['', ...dirs].map((d) => (
                <li key={d || '.'}>
                  <button
                    type="button"
                    aria-pressed={!clean && dir === d}
                    className={`pf-dlg-dir ${!clean && dir === d ? 'on' : ''}`}
                    disabled={to === area && d === from}
                    onClick={() => {
                      setDir(d);
                      setTyped('');
                    }}
                  >
                    <I name={d ? 'folder' : 'files'} size={14} />
                    <span className="ellipsis">{d ? spaced(d) : t('At the top')}</span>
                    {to === area && d === from && <span className="pf-dlg-here">{t('here now')}</span>}
                  </button>
                </li>
              ))
            )}
          </ul>
          <input
            className="input"
            placeholder={t('Or a new folder: Footage/Day 3')}
            value={typed}
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
            aria-label={t('A new folder')}
            data-testid="files-move-new"
          />
          {typedProblem && <span className="pf-dlg-note bad">{typedProblem}</span>}
        </div>
      </div>
    </Modal>
  );
}

/** A path taken in a list of names (case-blind: macOS and Windows would make two names one). */
export const takenIn = (paths: Iterable<string>) => {
  const keys = new Set([...paths].map(caseKey));
  return (p: string) => keys.has(caseKey(p));
};
