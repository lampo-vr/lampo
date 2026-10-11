// The Files tab as a grid (the media-first direction): big pictures, the name under each. A clip's or a picture's
// poster in its own shape on a dark frame, its length and size on it, scrubbing under the pointer; a folder a mosaic of
// the first pictures inside it, or its glyph; anything else its kind's glyph. The box to tick and ⋯ come with the
// pointer, as on the list's rows; a click on the picture is Quick Look, anywhere else on the tile what a row's click is.
import { type ReactNode, useState } from 'react';
import type { FileDirInfo, FileMedia } from '../../../lib/types.ts';
import { t } from '../i18n/index.ts';
import { ago } from '../lib/format.ts';
import { I } from '../ui/icons.tsx';
import { KindIcon } from '../ui/kindIcons.tsx';
import { IconButton, Menu, type MenuEntry } from '../ui/primitives.tsx';
import { posterUrl } from './api.ts';
import { type FileRow, lengthOf, nameOf, type Order, pictured, type SortBy, size, whoOf } from './model.ts';
import { type Common, goingWords, Tick } from './Rows.tsx';
import { ScrubPicture } from './Scrub.tsx';
import type { FileUpload } from './uploadStore.ts';

/** "A001C006_interview_wi…rec709_v2.mov": the start gives way, the end (the extension and a little before it) stays. */
function CutName({ name }: { name: string }) {
  const dot = name.lastIndexOf('.');
  const keep = Math.min(name.length, dot > 0 && name.length - dot <= 6 ? name.length - dot + 6 : 8);
  return (
    <span className="pf-name pf-tile-name" title={name}>
      {name.length > 18 ? (
        <>
          <span className="pf-cut-a">{name.slice(0, name.length - keep)}</span>
          <span className="pf-cut-b">{name.slice(name.length - keep)}</span>
        </>
      ) : (
        <span className="pf-cut-a">{name}</span>
      )}
    </span>
  );
}

function tileClass(p: Common, more = '') {
  return `pf-tile ${p.active ? 'active' : ''} ${p.picked ? 'picked' : ''} ${p.checked ? 'checked' : ''} ${more}`;
}

function TileActs({ menu, name, onOpen, active }: { menu: MenuEntry[]; name: string; onOpen: (o: boolean) => void; active: boolean }) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: only keeps the tile's click off ⋯
    <span className="pf-tile-acts" onClick={(e) => e.stopPropagation()}>
      <Menu
        onOpenChange={onOpen}
        trigger={
          <IconButton
            className="btn sm icon-only pf-more pf-tile-more"
            label={t('More for {name}', { name })}
            icon="more"
            size={15}
            tabIndex={active ? 0 : -1}
          />
        }
        items={menu}
      />
    </span>
  );
}

export function FileTileView({ f, media, onLook, ...p }: Common & { f: FileRow; media?: FileMedia; onLook: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const name = nameOf(f.path);
  const who = whoOf(f);
  const pic = !!media?.poster && pictured(f.kind);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: an option of the listbox, whose keys the grid takes
    <div
      id={p.id}
      className={tileClass(p, menuOpen ? 'menu-open' : '')}
      role="option"
      tabIndex={-1}
      aria-selected={p.checked || p.picked}
      data-id={f.id}
      data-testid={p.testid ?? 'file-row'}
      onClick={p.onPress}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: Space is Quick Look's key */}
      <span
        className={`pf-tile-pic ${pic ? 'pic' : ''}`}
        onClick={(e) => {
          if ((e.target as Element).closest('.pf-tick, .pf-tile-acts')) return;
          if (e.metaKey || e.ctrlKey || e.shiftKey) return;
          e.stopPropagation();
          onLook();
        }}
      >
        {pic ? (
          <ScrubPicture f={f} media={media} />
        ) : (
          <span className="pf-tile-glyph">
            <KindIcon kind={f.kind} size={30} />
          </span>
        )}
        <span className="pf-tile-badges">
          {media?.seconds ? <span className="pf-tile-badge">{lengthOf(media.seconds)}</span> : <span />}
          <span className="pf-tile-badge">{size(f.size)}</span>
        </span>
        <Tick checked={p.checked} onCheck={p.onCheck} label={t('Pick {name}', { name })} />
        <TileActs menu={p.menu} name={name} onOpen={setMenuOpen} active={p.active} />
      </span>
      <span className="pf-tile-text">
        <CutName name={name} />
        <span className="pf-tile-meta">{[...(f.v > 1 ? [`V${f.v}`] : []), who.name, ago(f.at)].join(' · ')}</span>
      </span>
    </div>
  );
}

export function DirTileView({ d, media, ...p }: Common & { d: FileDirInfo; media?: Record<string, FileMedia> }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const name = nameOf(d.path);
  const pics = (d.pics ?? []).filter((x) => media?.[x.id]?.poster).slice(0, 4);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: an option of the listbox, whose keys the grid takes
    <div
      id={p.id}
      className={tileClass(p, `dir ${menuOpen ? 'menu-open' : ''}`)}
      role="option"
      tabIndex={-1}
      aria-selected={p.checked}
      data-path={d.path}
      data-testid={p.testid ?? 'dir-row'}
      onClick={p.onPress}
    >
      <span className={`pf-tile-pic dir ${pics.length ? 'pic' : ''}`}>
        {pics.length ? (
          <span className={`pf-mosaic n${pics.length}`}>
            {pics.map((x) => (
              <img key={x.id} src={posterUrl(x.id, x.v)} alt="" loading="lazy" decoding="async" draggable={false} />
            ))}
          </span>
        ) : (
          <span className="pf-tile-glyph">
            <I name="folder" size={34} />
          </span>
        )}
        <span className="pf-tile-badges">
          <span className="pf-tile-badge folder">
            <I name="folder" size={12} />
            {d.files ? t('{n} file|{n} files', { n: d.files }) : t('Empty folder')}
          </span>
          {d.files ? <span className="pf-tile-badge">{size(d.bytes)}</span> : <span />}
        </span>
        <Tick checked={p.checked} onCheck={p.onCheck} label={t('Pick {name}', { name })} />
        <TileActs menu={p.menu} name={name} onOpen={setMenuOpen} active={p.active} />
      </span>
      <span className="pf-tile-text">
        <CutName name={name} />
        <span className="pf-tile-meta">{d.changed ? [whoOf(d.changed).name, ago(d.changed.at)].join(' · ') : t('Empty folder')}</span>
      </span>
    </div>
  );
}

/** A file on its way: its tile, with how far it got along the picture's foot. */
export function GoingTile({ u, id }: { u: FileUpload; id: string }) {
  const pct = u.size ? Math.min(100, (u.sent / u.size) * 100) : 0;
  return (
    <div id={id} className="pf-tile going" role="option" tabIndex={-1} aria-selected={false} aria-disabled={true} data-testid="file-row-going">
      <span className="pf-tile-pic">
        <span className="pf-tile-glyph">
          <I name="upload" size={26} />
        </span>
        <span className="pf-tile-progress" style={{ width: `${pct}%` }} />
      </span>
      <span className="pf-tile-text">
        <CutName name={nameOf(u.path)} />
        <span className="pf-tile-meta">{goingWords(u)}</span>
      </span>
    </div>
  );
}

export function TilePending() {
  return (
    <div className="pf-tile pending" aria-hidden="true">
      <span className="pf-tile-pic" />
      <span className="pf-tile-text">
        <span className="pf-tile-name sk" />
        <span className="pf-tile-meta sk" />
      </span>
    </div>
  );
}

/** Over the grid: what it holds, and the order (one control: a grid has no columns to press). */
export function GridHead({ order, onOrder, count }: { order: Order; onOrder: (by: SortBy) => void; count: ReactNode }) {
  const label = order.by === 'name' ? t('Name') : order.by === 'size' ? t('Size') : t('Last changed');
  return (
    <div className="pf-grid-head">
      <span className="pf-count" data-testid="files-count">
        {count}
      </span>
      <Menu
        trigger={
          <button type="button" className="btn ghost sm pf-grid-order" data-testid="files-order">
            <I name={order.dir === 'asc' ? 'sortAsc' : 'sortDesc'} size={14} />
            {label}
          </button>
        }
        items={(
          [
            ['name', t('Name')],
            ['size', t('Size')],
            ['changed', t('Last changed')],
          ] as const
        ).map(([by, l]) => ({ label: l, checked: order.by === by, onClick: () => onOrder(by) }))}
      />
    </div>
  );
}

/** How many columns the grid has now (↑↓ move by a row of tiles). */
export const columnsOf = (el: HTMLElement | null): number => (el ? getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length : 1) || 1;
