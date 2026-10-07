// The library as a table: a row per video, columns you can sort by, groups as header rows, and the same menus as the
// cards. On phones every row folds into two lines (thumbnail, name, stage).

import { useQueryClient } from '@tanstack/react-query';
import { memo, type ReactNode, type Ref, useLayoutEffect, useRef, useState } from 'react';
import { enc } from '../api/client.ts';
import { cancelPrefetch, prefetchVideo } from '../api/prefetch.ts';
import { spriteUrl } from '../api/sprite.ts';
import type { VideoSummary } from '../api/types.ts';
import { perLang, t } from '../i18n/index.ts';
import { useLang } from '../i18n/T.tsx';
import { cardClick } from '../lib/a11y.ts';
import { ago } from '../lib/format.ts';
import { useWindowed, WINDOW_FROM } from '../lib/windowing.ts';
import { RunEdge, RunLine } from '../sessions/RunLine.tsx';
import { cardRun } from '../sessions/runState.ts';
import { StatusPill } from '../status/StatusPill.tsx';
import { I, type IconName } from '../ui/icons.tsx';
import { ContextMenu, IconButton, Menu } from '../ui/primitives.tsx';
import { Skeleton, SkLine } from '../ui/Skeleton.tsx';
import { DRAG_VIDEO, dragChip } from './drag.ts';
import { ShareState } from './marks.tsx';
import type { Section, SortBy } from './model.ts';
import { summaryLine } from './model.ts';
import { Poster, posterUrl } from './Poster.tsx';
import { UnsentMark } from './unsent.tsx';
import { openVideo, useVideoMenu } from './useVideoMenu.tsx';

interface RowProps {
  v: VideoSummary;
  where?: string | null;
  home?: string | null;
  folders: string[];
}

const Row = memo(function Row({ v, where, home, folders }: RowProps) {
  useLang(); // memo'd: renders again on a language switch by itself
  const [menuOpen, setMenuOpen] = useState(false);
  const qc = useQueryClient();
  const { items, dialogs, organize } = useVideoMenu(v, { home, folders });
  const n = v.counts;
  const run = cardRun(v);
  return (
    <ContextMenu items={items} onOpenChange={setMenuOpen}>
      <tr
        className={`lrow ${v.archived ? 'archived' : ''} ${menuOpen ? 'menu-open' : ''}`}
        data-slug={v.slug}
        onClick={cardClick((e) => openVideo(v.slug, e), 'a, .lrow-menu')}
        onPointerEnter={() => prefetchVideo(qc, v.slug)}
        onPointerLeave={cancelPrefetch}
        onFocus={() => prefetchVideo(qc, v.slug, { now: true })}
        draggable={organize}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_VIDEO, v.slug);
          e.dataTransfer.effectAllowed = 'move';
          dragChip(e, v.name, e.currentTarget);
        }}
      >
        <td className="lc-name">
          <Poster
            src={v.hash ? posterUrl(v) : null}
            sprite={v.hash ? spriteUrl(v.slug, v.hash) : null}
            slug={v.slug}
            width={v.width}
            height={v.height}
            frame={16 / 9}
            className="lthumb"
          >
            <RunEdge run={run} />
          </Poster>
          <span className="lname">
            <a href={`#/v/${enc(v.slug)}`} className="ellipsis" draggable={false} data-nav>
              {v.name}
            </a>
            <span className="lwhere ellipsis">
              {where ? `${where} · ` : ''}V{v.v}
              {v.sample && ` · ${t('Sample')}`}
              {run ? (
                <>
                  {' · '}
                  <RunLine run={run} />
                </>
              ) : v.run === undefined && v.agent_status ? (
                ` · ${v.agent_status.text}`
              ) : (
                ''
              )}
              <UnsentMark slug={v.slug} />
            </span>
          </span>
        </td>
        <td className="lc-stage">
          <StatusPill info={v.stage} size="sm" />
        </td>
        <td className="lc-notes num">
          {n.open > 0 ? (
            <span
              className={n.must ? 'must' : ''}
              title={
                n.must
                  ? t('{n} open note, {must} must-fix|{n} open notes, {must} must-fix', { n: n.open, must: n.must })
                  : t('{n} open note|{n} open notes', { n: n.open })
              }
            >
              {n.open}
            </span>
          ) : n.fixed > 0 ? null : (
            // nothing open and nothing to check: one dash (beside a fix to check it read "– ✓1")
            <span className="faint">–</span>
          )}
          {n.fixed > 0 && (
            <span className="ok" title={t('{n} fix to check|{n} fixes to check', { n: n.fixed })}>
              <I name="check" size={11} />
              {n.fixed}
            </span>
          )}
        </td>
        <td className="lc-client">
          <ShareState stage={v.stage} />
        </td>
        <td className="lc-date">{ago(v.mtime)}</td>
        <td className="lc-menu">
          <div className="lrow-menu">
            <Menu
              onOpenChange={setMenuOpen}
              trigger={<IconButton className="btn ghost sm icon-only" label={t('Actions for {name}', { name: v.name })} icon="more" />}
              items={items}
            />
          </div>
          {dialogs}
        </td>
      </tr>
    </ContextMenu>
  );
});

const COLUMNS = perLang((): { key: string; label: string; sort?: SortBy; className: string }[] => [
  { key: 'name', label: t('Name'), sort: 'name', className: 'lc-name' },
  { key: 'stage', label: t('Stage'), sort: 'stage', className: 'lc-stage' },
  { key: 'notes', label: t('Open'), sort: 'open', className: 'lc-notes num' },
  { key: 'client', label: t('Review link'), className: 'lc-client' },
  { key: 'date', label: t('Updated'), sort: 'recent', className: 'lc-date' },
]);

interface FilmListProps {
  sections: Section[];
  sort: SortBy;
  onSort: (s: SortBy) => void;
  where: (v: VideoSummary, s: Section) => string | null;
  home?: string | null;
  folders: string[];
  onOpenSection: (folder: string) => void;
}

function ListHead({ sort, onSort }: { sort: SortBy; onSort: (s: SortBy) => void }) {
  return (
    <thead>
      <tr>
        {COLUMNS().map((c) => {
          const active = c.sort === sort;
          const icon: IconName = active ? (c.sort === 'name' || c.sort === 'stage' ? 'sortAsc' : 'sortDesc') : 'sortable';
          return (
            <th key={c.key} className={c.className} scope="col" aria-sort={active ? (icon === 'sortAsc' ? 'ascending' : 'descending') : undefined}>
              {c.sort ? (
                <button type="button" className={`lsort ${active ? 'on' : ''}`} onClick={() => c.sort && onSort(c.sort)}>
                  {c.label}
                  <I name={icon} size={12} />
                </button>
              ) : (
                c.label
              )}
            </th>
          );
        })}
        <th className="lc-menu">
          <span className="sr-only">{t('Actions')}</span>
        </th>
      </tr>
    </thead>
  );
}

export function FilmList({ sections, sort, onSort, where, home, folders, onOpenSection }: FilmListProps) {
  const grouped = sections.length > 1 || !!sections[0]?.title;
  const long = sections.reduce((n, s) => n + s.videos.length, 0) > WINDOW_FROM;
  return (
    <table className="ltable" data-testid="library-list">
      <ListHead sort={sort} onSort={onSort} />
      {sections.map((s) => (
        <tbody key={s.key}>
          {grouped && s.title && (
            <tr className="lgroup">
              <th colSpan={6} scope="colgroup">
                {s.folder ? (
                  <button type="button" className="lgroup-link" onClick={() => s.folder && onOpenSection(s.folder)}>
                    {s.title}
                  </button>
                ) : (
                  <span>{s.title}</span>
                )}
                <span className="lgroup-count">{s.videos.length}</span>
                <span className="lgroup-sum">{summaryLine(s.videos)}</span>
              </th>
            </tr>
          )}
          <SectionRows videos={s.videos} long={long} row={(v) => <Row key={v.slug} v={v} where={where(v, s)} home={home} folders={folders} />} />
        </tbody>
      ))}
    </table>
  );
}

/** A row's height before one has been measured (the desktop table's). */
const ROW_GUESS = 57;
// The last one measured: a list that appears again (a layout switch back) starts from it, not from the guess.
let rowSeen = 0;

// A long group renders the rows near the view, with spacer rows for the others (lib/windowing.ts).
function SectionRows({ videos, long, row }: { videos: VideoSummary[]; long: boolean; row: (v: VideoSummary) => ReactNode }) {
  const top = useRef<HTMLTableRowElement>(null);
  const [height, setHeight] = useState(rowSeen);
  useLayoutEffect(() => {
    if (!long) return;
    const h = top.current?.parentElement?.querySelector<HTMLElement>('tr.lrow')?.offsetHeight;
    if (h) rowSeen = h;
    if (h && h !== (height || ROW_GUESS)) setHeight(h);
  });
  const w = useWindowed(top, { enabled: long, rows: videos.length, height: () => height || ROW_GUESS, gap: 0, version: height });
  if (!w.on) return videos.map(row);
  return (
    <>
      <Spacer ref={top} height={w.before} />
      {videos.slice(w.first, w.last + 1).map(row)}
      <Spacer height={w.after} />
    </>
  );
}

function Spacer({ height, ref }: { height: number; ref?: Ref<HTMLTableRowElement> }) {
  return (
    <tr ref={ref} data-spacer>
      <td colSpan={6} style={{ height, padding: 0, border: 0 }} />
    </tr>
  );
}

/** The table while the library loads: its real head (the columns sort already) and rows of the rows' height. */
export function FilmListPending({ sort, onSort, grouped }: { sort: SortBy; onSort: (s: SortBy) => void; grouped: boolean }) {
  return (
    <table className="ltable">
      <ListHead sort={sort} onSort={onSort} />
      <tbody aria-hidden="true">
        {grouped && (
          <tr className="lgroup">
            <th colSpan={6} scope="colgroup">
              <span>
                <SkLine w="7em" />
              </span>
            </th>
          </tr>
        )}
        {['62%', '48%', '56%', '40%', '52%', '44%'].map((w) => (
          <tr key={w} className="lrow pending">
            <td className="lc-name">
              <div className="sk lthumb" style={{ aspectRatio: 16 / 9 }} />
              <span className="lname">
                <span className="ellipsis">
                  <SkLine w={w} />
                </span>
                <span className="lwhere ellipsis">
                  <SkLine w="5em" />
                </span>
              </span>
            </td>
            <td className="lc-stage">
              <Skeleton w={84} h={22} r={999} />
            </td>
            <td className="lc-notes num">
              <SkLine w="1.2em" />
            </td>
            <td className="lc-client" />
            <td className="lc-date">
              <SkLine w="4.5em" />
            </td>
            <td className="lc-menu" />
          </tr>
        ))}
      </tbody>
    </table>
  );
}
