// The Files tab's rows, one anatomy for every one of them and one height whatever it is doing: a box to tick (under the
// pointer, while picking), what it is — a small picture of footage and pictures, else its kind's glyph —, its name with
// what it holds beside it (a folder's files, a clip's or a sound's length, its version), its size, who changed it last
// and when (a person's picture, or an agent's mark), and its actions at the end (shown under the pointer, on the row
// the keys are on and on touch screens; their room is always there). A folder says who changed it last as a file does:
// its newest file. A file on its way says how far it got; the loading state is the same rows with their words waiting.
import { type MouseEvent, type ReactNode, useState } from 'react';
import type { FileDirInfo, FileMedia } from '../../../lib/types.ts';
import { usePeople } from '../api/auth.ts';
import { t } from '../i18n/index.ts';
import { ago } from '../lib/format.ts';
import { Avatar, Progress } from '../ui/controls.tsx';
import { AgentMark, I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { KindIcon } from '../ui/kindIcons.tsx';
import { IconButton, Menu, type MenuEntry } from '../ui/primitives.tsx';
import { SkLine } from '../ui/Skeleton.tsx';
import { posterUrl } from './api.ts';
import { type FileRow, firstDir, lengthOf, nameOf, type Order, pictured, type SortBy, size, spaced, type Who, whoOf } from './model.ts';
import type { FileUpload } from './uploadStore.ts';

/** How a row stands in the list: under the keys, opened beside the list, ticked for the bar. */
export interface RowLook {
  active: boolean;
  picked: boolean;
  checked: boolean;
}

export interface Common extends RowLook {
  id: string;
  /** Ticking: only where several can be picked. */
  onCheck?: (e: MouseEvent) => void;
  onPress: (e: MouseEvent) => void;
  menu: MenuEntry[];
  /** The actions beside ⋯ (a file's Download and Copy for an agent, the trash's Restore). */
  quick?: ReactNode;
  testid?: string;
}

function rowClass(l: RowLook, more = '') {
  return `pf-row ${l.active ? 'active' : ''} ${l.picked ? 'picked' : ''} ${l.checked ? 'checked' : ''} ${more}`;
}

/** The box to tick, at the row's start: there under the pointer, on the row the keys are on, and once picking began. */
export function Tick({ checked, onCheck, label }: { checked: boolean; onCheck?: (e: MouseEvent) => void; label: string }) {
  return (
    <span className="pf-c pf-c-tick">
      {onCheck && (
        // biome-ignore lint/a11y/useSemanticElements: a box drawn at the row's start that takes a click, not a form field
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

/**
 * What a row is, in one box of a fixed size (nothing moves when a picture arrives): footage's and pictures' poster in
 * their own shape, over the kind's glyph that stands until it has loaded and stays when there is none.
 */
function Lead({ children, poster, onLook }: { children: ReactNode; poster?: string | null; onLook?: () => void }) {
  const [shown, setShown] = useState<'wait' | 'ok' | 'none'>('wait');
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: Space is Quick Look's key, on the list
    <span
      className={`pf-c pf-c-lead ${onLook ? 'looks' : ''}`}
      onClick={
        onLook &&
        ((e) => {
          e.stopPropagation();
          onLook();
        })
      }
    >
      <span className={`pf-thumb ${poster && shown === 'ok' ? 'has-pic' : ''}`}>
        <span className="pf-thumb-glyph">{children}</span>
        {poster && shown !== 'none' && (
          <img src={poster} alt="" loading="lazy" decoding="async" draggable={false} onLoad={() => setShown('ok')} onError={() => setShown('none')} />
        )}
      </span>
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

/** Who changed it last and when, in one cell: "Sam · 1 h ago". */
function Changed({ who, at }: { who: Who | null; at: string | null }) {
  return (
    <span className="pf-c pf-c-changed" title={at ? new Date(at).toLocaleString() : undefined}>
      {who && <WhoTag who={who} />}
      {at && (
        <span className="pf-when">
          {who && <span className="pf-when-sep"> · </span>}
          {ago(at)}
        </span>
      )}
    </span>
  );
}

/**
 * The row's actions: shown under the pointer, on the row the keys are on, its menu open and on touch screens. Only the
 * keys' row takes Tab (one stop for the list, not three per row).
 */
function Acts({ quick, menu, name, onOpen, active }: { quick?: ReactNode; menu: MenuEntry[]; name: string; onOpen: (o: boolean) => void; active: boolean }) {
  return (
    <span className="pf-c pf-c-acts">
      {quick}
      <Menu
        onOpenChange={onOpen}
        trigger={
          <IconButton className="btn ghost sm icon-only pf-more" label={t('More for {name}', { name })} icon="more" size={15} tabIndex={active ? 0 : -1} />
        }
        items={menu}
      />
    </span>
  );
}

/**
 * The quiet words beside a name: a clip's or a sound's length and a version past the first (`facts`, a few letters that
 * stay whole), and where a match was found (`where`, a path that gives way first when the room runs out).
 */
function fileMeta(f: FileRow, media: FileMedia | undefined, showDir: boolean): { facts: string[]; where: string | null } {
  const dir = f.path.slice(0, Math.max(0, f.path.length - nameOf(f.path).length - 1));
  return {
    facts: [...(media?.seconds ? [lengthOf(media.seconds)] : []), ...(f.v > 1 ? [`V${f.v}`] : [])],
    where: showDir && dir ? spaced(dir) : null,
  };
}

export function FileRowView({
  f,
  upload,
  showDir,
  media,
  onLook,
  ...p
}: Common & { f: FileRow; upload?: FileUpload; showDir?: boolean; media?: FileMedia; onLook?: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const name = nameOf(f.path);
  const going = upload && upload.state !== 'done' && upload.state !== 'canceled' ? upload : null;
  const meta = fileMeta(f, media, !!showDir);
  // a picture only once the server said it has one (nothing asked for that would be a 404)
  const poster = media?.poster && pictured(f.kind) ? posterUrl(f.id, f.v) : null;
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
      <Tick checked={p.checked} onCheck={p.onCheck} label={t('Pick {name}', { name })} />
      <Lead key={poster ?? ''} poster={poster} onLook={onLook}>
        <KindIcon kind={f.kind} />
      </Lead>
      <span className="pf-c pf-c-name">
        <span className="pf-name" title={f.path}>
          {name}
        </span>
        {going ? (
          <Going u={going} />
        ) : (
          <>
            {meta.facts.length > 0 && <span className="pf-meta pf-meta-facts">{meta.facts.join(' · ')}</span>}
            {meta.where && <span className="pf-meta">{meta.where}</span>}
          </>
        )}
      </span>
      <span className="pf-c pf-c-size">{size(f.size)}</span>
      {going ? <Changed who={null} at={null} /> : <Changed who={whoOf(f)} at={f.at} />}
      {/* a phone's second line: length or version · size · when */}
      <span className="pf-c pf-c-sub">
        {going ? goingWords(going) : [...meta.facts, ...(meta.where ? [meta.where] : []), size(f.size), ago(f.at)].join(' · ')}
      </span>
      <Acts quick={p.quick} menu={p.menu} name={name} onOpen={setMenuOpen} active={p.active} />
    </div>
  );
}

/** How far a file on its way got, in words. */
export function goingWords(u: FileUpload): string {
  if (u.state === 'conflict' && u.conflict) return t('changed since: V{v} by {name}', { v: u.conflict.v, name: u.conflict.agent ?? u.conflict.by });
  if (u.state === 'room') return t('waiting for room');
  if (u.state === 'failed') return u.error ?? t('didn’t arrive');
  if (u.state === 'waiting' || !u.sent) return t('waiting');
  return t('uploading {pct}% · {sent} of {size}', { pct: Math.floor((u.sent / (u.size || 1)) * 100), sent: size(u.sent), size: size(u.size) });
}

function Going({ u }: { u: FileUpload }) {
  const pct = u.size ? Math.min(100, (u.sent / u.size) * 100) : 0;
  return (
    <span className={`pf-meta pf-going ${u.state}`}>
      {u.state === 'conflict' ? <KeyGlyph shape="half" size={9} /> : <KeyGlyph shape="outline" size={9} />}
      <span className="pf-going-words">{goingWords(u)}</span>
      {u.state === 'uploading' && <Progress className="pf-up-bar" value={pct} label={t('Uploading {name}', { name: nameOf(u.path) })} />}
    </span>
  );
}

/** A file on its way that isn't in the list yet: the row it will be, with how far it got. */
export function GoingRowView({ u, id }: { u: FileUpload; id: string }) {
  const name = nameOf(u.path);
  return (
    <div id={id} className="pf-row going" role="option" tabIndex={-1} aria-selected={false} aria-disabled={true} data-testid="file-row-going">
      <Tick checked={false} label={name} />
      <Lead>
        <KindIcon kind="other" />
      </Lead>
      <span className="pf-c pf-c-name">
        <span className="pf-name" title={u.path}>
          {name}
        </span>
        <Going u={u} />
      </span>
      <span className="pf-c pf-c-size">{size(u.size)}</span>
      <Changed who={null} at={null} />
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
      <Tick checked={p.checked} onCheck={p.onCheck} label={t('Pick {name}', { name })} />
      <Lead>
        <I name="folder" size={16} />
      </Lead>
      <span className="pf-c pf-c-name">
        <span className="pf-name" title={d.path}>
          {name}
        </span>
        <span className="pf-meta" data-testid="dir-facts">
          {facts}
          {going && going.pct !== null && ` · ${t('{pct}% here', { pct: going.pct })}`}
        </span>
      </span>
      <span className="pf-c pf-c-size">{d.files ? size(d.bytes) : ''}</span>
      <Changed who={d.changed ? whoOf(d.changed) : null} at={d.changed?.at ?? null} />
      <span className="pf-c pf-c-sub">{d.files ? `${facts} · ${size(d.bytes)}${d.changed ? ` · ${ago(d.changed.at)}` : ''}` : facts}</span>
      <Acts quick={p.quick} menu={p.menu} name={name} onOpen={setMenuOpen} active={p.active} />
    </div>
  );
}

/** A row while the list is on its way: the anatomy with its words waiting. */
export function RowPending({ w }: { w: string }) {
  return (
    <div className="pf-row pending" aria-hidden="true">
      <span className="pf-c pf-c-tick" />
      <span className="pf-c pf-c-lead">
        <span className="pf-thumb">
          <span className="pf-thumb-glyph">
            <KeyGlyph shape="outline" size={10} />
          </span>
        </span>
      </span>
      <span className="pf-c pf-c-name">
        <SkLine w={w} />
      </span>
      <span className="pf-c pf-c-size">
        <SkLine w="3em" />
      </span>
      <span className="pf-c pf-c-changed">
        <SkLine w="7em" />
      </span>
      <span className="pf-c pf-c-sub">
        <SkLine w="11em" />
      </span>
      <span className="pf-c pf-c-acts" />
    </div>
  );
}

/** A column's name that orders the list: pressed, by it (again: the other way), the arrow saying which way. */
function SortHead({ by, label, order, onOrder }: { by: SortBy; label: string; order: Order; onOrder: (by: SortBy) => void }) {
  const on = order.by === by;
  const way =
    by === 'name'
      ? order.dir === 'asc'
        ? t('A to Z')
        : t('Z to A')
      : by === 'size'
        ? order.dir === 'desc'
          ? t('largest first')
          : t('smallest first')
        : order.dir === 'desc'
          ? t('newest first')
          : t('oldest first');
  return (
    <button
      type="button"
      className={`pf-sort-head ${on ? 'on' : ''}`}
      onClick={() => onOrder(by)}
      aria-pressed={on}
      aria-label={on ? t('{column}, ordered {way}', { column: label, way }) : t('Order by {column}', { column: label })}
      data-testid={`files-order-${by}`}
    >
      {label}
      <I name={(on ? order.dir : firstDir(by)) === 'asc' ? 'sortAsc' : 'sortDesc'} size={12} className="pf-sort-arrow" />
    </button>
  );
}

/**
 * The columns' names over the list, each one ordering it (the trash's are plain: it is newest first), with what the list
 * holds beside Name; on a phone, where there are no columns, what it holds and the order as one compact control.
 */
export function Columns({ trash, order, onOrder, count }: { trash?: boolean; order?: Order; onOrder?: (by: SortBy) => void; count?: ReactNode }) {
  const head = (by: SortBy, label: string) => (order && onOrder ? <SortHead by={by} label={label} order={order} onOrder={onOrder} /> : label);
  return (
    <div className="pf-row pf-cols">
      <span className="pf-c pf-c-tick" />
      <span className="pf-c pf-c-lead" />
      <span className="pf-c pf-c-name">
        {head('name', t('Name'))}
        {count !== undefined && (
          <span className="pf-count" data-testid="files-count">
            {count}
          </span>
        )}
      </span>
      <span className="pf-c pf-c-size">{head('size', t('Size'))}</span>
      <span className="pf-c pf-c-changed">{head('changed', trash ? t('Trashed') : t('Changed'))}</span>
      <span className="pf-c pf-c-acts">
        {order && onOrder && (
          <Menu
            trigger={<IconButton className="btn ghost sm icon-only pf-order-menu" label={t('Order')} icon="sortable" size={14} />}
            items={(
              [
                ['name', t('Name')],
                ['size', t('Size')],
                ['changed', t('Last changed')],
              ] as const
            ).map(([by, label]) => ({ label, checked: order.by === by, onClick: () => onOrder(by) }))}
          />
        )}
      </span>
    </div>
  );
}
