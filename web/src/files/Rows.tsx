// The Files tab's rows, one anatomy for every one of them and one height whatever it is doing: what it is (its kind's
// glyph, or a box to tick under the pointer), its name, what kind of file and which version, its size, who changed it
// last (a person's picture, or an agent's mark), when, and its actions at the end (shown under the pointer, the keys
// and on touch screens; their room is always there). A folder says what it holds; a file on its way says how far it
// got, with a 3 px bar in its kind's place; the loading state is the same rows with their words waiting.
import { type MouseEvent, type ReactNode, useState } from 'react';
import type { FileDirInfo } from '../../../lib/types.ts';
import { usePeople } from '../api/auth.ts';
import { t } from '../i18n/index.ts';
import { ago } from '../lib/format.ts';
import { Avatar, Progress } from '../ui/controls.tsx';
import { AgentMark, I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { KindIcon } from '../ui/kindIcons.tsx';
import { IconButton, Menu, type MenuEntry } from '../ui/primitives.tsx';
import { SkLine } from '../ui/Skeleton.tsx';
import { type FileRow, nameOf, size, spaced, typeLabel, type Who, whoOf } from './model.ts';
import type { FileUpload } from './uploadStore.ts';

/** How a row stands in the list: under the keys, opened beside the list, ticked for the bar. */
export interface RowLook {
  active: boolean;
  picked: boolean;
  checked: boolean;
}

interface Common extends RowLook {
  id: string;
  /** Ticking (the box in the glyph's place): only where several can be picked. */
  onCheck?: (e: MouseEvent) => void;
  onPress: (e: MouseEvent) => void;
  menu: MenuEntry[];
  /** The one action beside ⋯ (a file's Download, the trash's Restore). */
  quick?: ReactNode;
  testid?: string;
}

function rowClass(l: RowLook, more = '') {
  return `pf-row ${l.active ? 'active' : ''} ${l.picked ? 'picked' : ''} ${l.checked ? 'checked' : ''} ${more}`;
}

/** The glyph's cell: the kind (or a folder), a box to tick in its place under the pointer and once ticked. */
function Lead({ children, checked, onCheck, label }: { children: ReactNode; checked: boolean; onCheck?: (e: MouseEvent) => void; label: string }) {
  return (
    <span className="pf-c pf-c-lead">
      <span className="pf-glyph">{children}</span>
      {onCheck && (
        // biome-ignore lint/a11y/useSemanticElements: a box drawn in the glyph's place that takes a click, not a form field
        <button
          type="button"
          className={`pf-tick ${checked ? 'on' : ''}`}
          role="checkbox"
          aria-checked={checked}
          aria-label={label}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onCheck(e);
          }}
        >
          <I name="check" size={12} />
        </button>
      )}
    </span>
  );
}

/** Who made a version: an agent's mark and name, or a person's picture and name. */
export function WhoTag({ who, size: px = 18 }: { who: Who; size?: number }) {
  const picture = usePeople();
  return (
    <span className={`pf-who ${who.agent ? 'agent' : ''}`} title={who.agent ? t('{name} (agent)', { name: who.name }) : who.name}>
      {who.agent ? (
        <span className="pf-who-mark">
          <AgentMark kind={who.agent} size={px - 4} />
        </span>
      ) : (
        <Avatar name={who.name} src={picture(who.name)} size={px} kind="person" />
      )}
      <span className="pf-who-name">{who.name}</span>
    </span>
  );
}

function Acts({ quick, menu, name, onOpen }: { quick?: ReactNode; menu: MenuEntry[]; name: string; onOpen: (o: boolean) => void }) {
  return (
    <span className="pf-c pf-c-acts">
      {quick}
      <Menu
        onOpenChange={onOpen}
        trigger={<IconButton className="btn ghost sm icon-only pf-more" label={t('More for {name}', { name })} icon="more" size={15} tabIndex={-1} />}
        items={menu}
      />
    </span>
  );
}

export function FileRowView({ f, upload, showDir, ...p }: Common & { f: FileRow; upload?: FileUpload; showDir?: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const name = nameOf(f.path);
  const dir = f.path.slice(0, Math.max(0, f.path.length - name.length - 1));
  const going = upload && upload.state !== 'done' && upload.state !== 'canceled' ? upload : null;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: an option of the listbox, whose keys (↑↓, ↵, Space, ⌫, X) the list takes
    <div
      id={p.id}
      className={rowClass(p, `${menuOpen ? 'menu-open' : ''} ${going ? 'going' : ''}`)}
      role="option"
      tabIndex={-1}
      aria-selected={p.checked || p.picked}
      data-id={f.id}
      data-testid={p.testid ?? 'file-row'}
      onClick={p.onPress}
    >
      <Lead checked={p.checked} onCheck={p.onCheck} label={t('Pick {name}', { name })}>
        <KindIcon kind={f.kind} />
      </Lead>
      <span className="pf-c pf-c-name">
        <span className="pf-name" title={f.path}>
          {name}
        </span>
        {showDir && dir && <span className="pf-dir">{spaced(dir)}</span>}
      </span>
      {going ? (
        <Going u={going} />
      ) : (
        <span className="pf-c pf-c-kind">
          <span className="pf-kind">{typeLabel(f.path, f.kind)}</span>
          {f.v > 1 && <span className="pf-v">V{f.v}</span>}
        </span>
      )}
      <span className="pf-c pf-c-size">{size(f.size)}</span>
      <span className="pf-c pf-c-who">
        <WhoTag who={whoOf(f)} />
      </span>
      <span className="pf-c pf-c-when" title={new Date(f.at).toLocaleString()}>
        {going ? t('now') : ago(f.at)}
      </span>
      {/* a phone's second line: kind · size · when */}
      <span className="pf-c pf-c-sub">
        {going ? goingWords(going) : `${typeLabel(f.path, f.kind)}${f.v > 1 ? ` · V${f.v}` : ''} · ${size(f.size)} · ${ago(f.at)}`}
      </span>
      <Acts quick={p.quick} menu={p.menu} name={name} onOpen={setMenuOpen} />
    </div>
  );
}

/** How far a file on its way got, in words. */
function goingWords(u: FileUpload): string {
  if (u.state === 'conflict' && u.conflict) return t('changed since: V{v} by {name}', { v: u.conflict.v, name: u.conflict.agent ?? u.conflict.by });
  if (u.state === 'room') return t('waiting for room');
  if (u.state === 'failed') return u.error ?? t('didn’t arrive');
  if (u.state === 'waiting' || !u.sent) return t('waiting');
  return t('uploading {pct}% · {sent} of {size}', { pct: Math.floor((u.sent / (u.size || 1)) * 100), sent: size(u.sent), size: size(u.size) });
}

function Going({ u }: { u: FileUpload }) {
  const pct = u.size ? Math.min(100, (u.sent / u.size) * 100) : 0;
  return (
    <span className={`pf-c pf-c-kind pf-going ${u.state}`}>
      <span className="pf-kind">
        {u.state === 'conflict' ? <KeyGlyph shape="half" size={9} /> : <KeyGlyph shape="outline" size={9} />}
        {goingWords(u)}
      </span>
      {u.state === 'uploading' && <Progress className="pf-up-bar" value={pct} label={t('Uploading {name}', { name: nameOf(u.path) })} />}
    </span>
  );
}

/** A file on its way that isn't in the list yet: the row it will be, with how far it got. */
export function GoingRowView({ u, id }: { u: FileUpload; id: string }) {
  const name = nameOf(u.path);
  return (
    <div id={id} className="pf-row going" role="option" tabIndex={-1} aria-selected={false} aria-disabled={true} data-testid="file-row-going">
      <Lead checked={false} label={name}>
        <KindIcon kind="other" />
      </Lead>
      <span className="pf-c pf-c-name">
        <span className="pf-name" title={u.path}>
          {name}
        </span>
      </span>
      <Going u={u} />
      <span className="pf-c pf-c-size">{size(u.size)}</span>
      <span className="pf-c pf-c-who" />
      <span className="pf-c pf-c-when">{t('now')}</span>
      <span className="pf-c pf-c-sub">{goingWords(u)}</span>
      <span className="pf-c pf-c-acts" />
    </div>
  );
}

export function DirRowView({ d, going, ...p }: Common & { d: FileDirInfo; going?: { files: number; pct: number | null } }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const name = nameOf(d.path);
  const facts = d.files
    ? t('{n} file|{n} files', { n: d.files })
    : going
      ? t('{n} file on its way|{n} files on their way', { n: going.files })
      : t('Empty folder');
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: an option of the listbox, whose keys (↑↓, ↵, ⌫, X) the list takes
    <div
      id={p.id}
      className={rowClass(p, `dir ${menuOpen ? 'menu-open' : ''}`)}
      role="option"
      tabIndex={-1}
      aria-selected={p.checked}
      data-path={d.path}
      data-testid={p.testid ?? 'dir-row'}
      onClick={p.onPress}
    >
      <Lead checked={p.checked} onCheck={p.onCheck} label={t('Pick {name}', { name })}>
        <I name="folder" size={16} />
      </Lead>
      <span className="pf-c pf-c-name">
        <span className="pf-name" title={d.path}>
          {name}
        </span>
      </span>
      <span className="pf-c pf-c-kind">
        <span className="pf-kind">{facts}</span>
        {going && going.pct !== null && <span className="pf-v">{t('{pct}% here', { pct: going.pct })}</span>}
      </span>
      <span className="pf-c pf-c-size">{d.files ? size(d.bytes) : ''}</span>
      <span className="pf-c pf-c-who" />
      <span className="pf-c pf-c-when" />
      <span className="pf-c pf-c-sub">{d.files ? `${facts} · ${size(d.bytes)}` : facts}</span>
      <Acts quick={p.quick} menu={p.menu} name={name} onOpen={setMenuOpen} />
    </div>
  );
}

/** A row while the list is on its way: the anatomy with its words waiting. */
export function RowPending({ w }: { w: string }) {
  return (
    <div className="pf-row pending" aria-hidden="true">
      <span className="pf-c pf-c-lead">
        <span className="pf-glyph">
          <KeyGlyph shape="outline" size={10} />
        </span>
      </span>
      <span className="pf-c pf-c-name">
        <SkLine w={w} />
      </span>
      <span className="pf-c pf-c-kind">
        <SkLine w="7em" />
      </span>
      <span className="pf-c pf-c-size">
        <SkLine w="3em" />
      </span>
      <span className="pf-c pf-c-who">
        <SkLine w="5em" />
      </span>
      <span className="pf-c pf-c-when">
        <SkLine w="3em" />
      </span>
      <span className="pf-c pf-c-sub">
        <SkLine w="11em" />
      </span>
      <span className="pf-c pf-c-acts" />
    </div>
  );
}

/** The columns' names over the list (wide screens). */
export function Columns({ trash }: { trash?: boolean }) {
  return (
    // the columns' names, for the eye: each row's cells say what they are by themselves
    <div className="pf-row pf-cols" aria-hidden="true">
      <span className="pf-c pf-c-lead" />
      <span className="pf-c pf-c-name">{t('Name')}</span>
      <span className="pf-c pf-c-kind">{trash ? t('Where it was') : t('Kind')}</span>
      <span className="pf-c pf-c-size">{t('Size')}</span>
      <span className="pf-c pf-c-who">{trash ? t('Trashed by') : t('Changed by')}</span>
      <span className="pf-c pf-c-when">{trash ? t('Trashed') : t('Changed')}</span>
      <span className="pf-c pf-c-sub" />
      <span className="pf-c pf-c-acts" />
    </div>
  );
}
