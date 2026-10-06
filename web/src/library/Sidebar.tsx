// Library sidebar: views, the videos opened last (Recent), the project/folder tree (drag videos and folders onto it)
// and the agents. While the library
// loads it is the same sidebar: the views are known without data (only their counts wait), the projects are rows of
// the same height, so nothing moves when the data arrives.

import { useQueryClient } from '@tanstack/react-query';
import { type DragEvent, type ReactElement, type ReactNode, useEffect, useMemo, useState } from 'react';
import { agentKindOfRef } from '../../../lib/agentKind.ts';
import { archivedIn } from '../../../lib/archived.ts';
import { useAuthStatus, useCan } from '../api/auth.ts';
import { enc } from '../api/client.ts';
import { useFolderActions } from '../api/mutations.ts';
import { useBilling } from '../api/queries.ts';
import type { ArchivedProjectInfo, VideoSummary } from '../api/types.ts';
import { billingCode } from '../billing/code.ts';
import { trialLineDue } from '../billing/due.ts';
import { t } from '../i18n/index.ts';
import { useVisibleForYou } from '../inbox/hidden.ts';
import { cardClick, onActivate } from '../lib/a11y.ts';
import { isProject } from '../lib/folders.ts';
import { loader, useLoaded, usePainted } from '../lib/lazy.ts';
import { crumbs, goView, type LibraryView, leaf, within } from '../lib/nav.ts';
import { posterUrl } from '../lib/posterUrl.ts';
import { forgetGone, RECENT_SHOWN, useRecent } from '../lib/recent.ts';
import { toast, toastError, toastUndo } from '../lib/toast.ts';
import { SessionHover } from '../sessions/Sessions.tsx';
import { LazyShareModal } from '../share/LazyShareModal.tsx';
import { stageLabel } from '../status/stageText.ts';
import { STAGE_SHAPE } from '../ui/glyphs.ts';
import { AgentMark, I, type IconName } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { ScrollArea } from '../ui/plain.tsx';
import { Confirm, ContextMenu, IconButton, Menu, type MenuEntry } from '../ui/primitives.tsx';
import { SkLine } from '../ui/Skeleton.tsx';
import { archivedCode } from './archiving.ts';
import { arrowNav } from './arrowNav.ts';
import { downloadFolder } from './downloadFolder.ts';
import { DRAG_FOLDER, DRAG_VIDEO, type Dropped, useDrop } from './drag.ts';

const parentOf = (p: string) => p.split('/').slice(0, -1).join('/');

const EXPANDED = 'vr.expanded';
const loadExpanded = () => {
  try {
    return new Set<string>(JSON.parse(localStorage.getItem(EXPANDED) || '[]'));
  } catch {
    return new Set<string>();
  }
};

interface NavInputProps {
  depth: number;
  defaultValue?: string;
  placeholder?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

function NavInput({ depth, defaultValue = '', placeholder, onSubmit, onCancel }: NavInputProps) {
  const [val, setVal] = useState(defaultValue);
  return (
    <div className="nav-item editing" style={{ paddingLeft: 10 + depth * 14 }}>
      <span className="twisty" />
      <I name="folder" size={15} />
      <input
        className="nav-input"
        autoFocus
        value={val}
        placeholder={placeholder}
        onChange={(e) => setVal(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={onCancel}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && val.trim()) onSubmit(val.trim().replace(/\//g, '-'));
          if (e.key === 'Escape') onCancel();
        }}
      />
    </div>
  );
}

interface NavItemProps {
  icon?: IconName;
  /** Stands where the icon does, when it isn't one of the icon set (an agent's mark). */
  lead?: ReactNode;
  label: ReactNode;
  /** null: a count on its way. */
  count?: number | null;
  /** What the count counts, for screen readers ("videos"): where the row's name doesn't say it. */
  countOf?: string;
  active?: boolean;
  onClick: () => void;
  dot?: ReactNode;
  drop?: (d: Dropped) => void;
  depth?: number;
  twisty?: ReactNode;
  actions?: ReactNode;
  draggable?: boolean;
  onDragStart?: (e: DragEvent) => void;
  title?: string;
  /** Right-click / long-press: the same items as the row's ⋯ menu. */
  menu?: MenuEntry[];
  /** Wraps the row (e.g. a hover card). */
  wrap?: (row: ReactElement) => ReactElement;
  testId?: string;
}

function NavItem({
  icon,
  lead,
  label,
  count,
  countOf,
  active,
  onClick,
  dot,
  drop,
  depth = 0,
  twisty,
  actions,
  draggable,
  onDragStart,
  title,
  menu,
  wrap,
  testId,
}: NavItemProps) {
  const d = useDrop(drop || (() => {}), drop ? [DRAG_VIDEO, DRAG_FOLDER] : []);
  const row = (
    // biome-ignore lint/a11y/useSemanticElements: the card holds its own buttons, which an <a> or <button> cannot contain
    <div
      className={`nav-item ${active ? 'active' : ''} ${d.over ? 'drop' : ''}`}
      aria-current={active ? 'page' : undefined}
      style={{ paddingLeft: 10 + depth * 14 }}
      role="link"
      tabIndex={0}
      data-nav
      onClick={cardClick(onClick, '.nav-actions')}
      onKeyDown={onActivate(onClick)}
      title={title}
      data-testid={testId}
      draggable={draggable}
      onDragStart={onDragStart}
      {...(drop ? d.props : {})}
    >
      {twisty ?? null}
      {lead ?? (icon && <I name={icon} size={15} />)}
      <span className="nav-label ellipsis">{label}</span>
      {dot}
      {count !== undefined && (
        <span className="nav-count">
          {count === null ? <SkLine w="1.4em" /> : count}
          {countOf && count !== null && <span className="sr-only"> {countOf}</span>}
        </span>
      )}
      {actions && <span className="nav-actions">{actions}</span>}
    </div>
  );
  const withMenu = menu ? <ContextMenu items={menu}>{row}</ContextMenu> : row;
  return wrap ? wrap(withMenu) : withMenu;
}

/** One of the videos opened last while the library loads: the row's height and shape, its name on its way. */
const PendingRecent = ({ w }: { w: string }) => (
  <div className="nav-item pending" aria-hidden="true" style={{ paddingLeft: 10 }}>
    <span className="nav-thumb" />
    <span className="nav-label">
      <SkLine w={w} />
    </span>
  </div>
);
const PENDING_WIDTHS = ['62%', '48%', '70%', '54%', '66%'];
/** What agents are doing now (sessions/Live.tsx), for the Agents rows: loaded after the first paint. */
const agentNow = loader(() => import('../sessions/Live.tsx'));

/**
 * The videos opened last in the player (lib/recent.ts), newest first: a small poster, the name and where it stands.
 * Nothing yet, or only videos that are gone or archived (or in an archived project): no section. While the library loads, as many rows as it will
 * most likely show, so nothing below moves.
 */
function RecentNav({ videos, pending }: { videos: VideoSummary[]; pending: boolean }) {
  const slugs = useRecent();
  const bySlug = useMemo(() => new Map(videos.map((v) => [v.slug, v])), [videos]);
  // Deleted videos leave the list for good (archived ones only hide: they come back when restored).
  useEffect(() => {
    if (!pending && slugs.length) forgetGone((s) => !bySlug.has(s));
  }, [pending, slugs, bySlug]);
  const rows = pending
    ? []
    : slugs
        .map((s) => bySlug.get(s))
        .filter((v): v is VideoSummary => !!v && !v.archived && !v.project_archived)
        .slice(0, RECENT_SHOWN);
  const count = pending ? Math.min(slugs.length, RECENT_SHOWN) : rows.length;
  if (!count) return null;
  return (
    <div className="nav-section" data-testid="nav-recent">
      <div className="nav-head">{t('Recent')}</div>
      {pending
        ? PENDING_WIDTHS.slice(0, count).map((w) => <PendingRecent key={w} w={w} />)
        : rows.map((v) => (
            <NavItem
              key={v.slug}
              lead={<span className="nav-thumb">{v.hash && <img src={posterUrl(v)} alt="" decoding="async" draggable={false} />}</span>}
              label={
                <>
                  {v.name}
                  <span className="sr-only"> · {stageLabel(v.stage.stage)}</span>
                </>
              }
              dot={
                <span className="nav-stage" data-stage={v.stage.stage}>
                  <KeyGlyph shape={STAGE_SHAPE[v.stage.stage]} className="nav-kg" />
                </span>
              }
              onClick={() => {
                location.hash = `#/v/${enc(v.slug)}`;
              }}
              testId="nav-recent-item"
            />
          ))}
    </div>
  );
}

type Editing = { mode: 'new'; parent: string } | { mode: 'rename'; path: string } | null;

interface SidebarProps {
  /** Missing while the library loads. */
  videos?: VideoSummary[];
  folders?: string[];
  /** The archived projects (lib/archived.ts): out of the tree, behind the Archived row. */
  archived?: Record<string, ArchivedProjectInfo>;
  view: LibraryView;
  onMoveVideo: (slug: string, folder: string | null) => void;
  /** In the phone drawer: the library opens the share sheet itself (the drawer closes first). */
  onShareFolder?: (folder: string) => void;
}

const NONE: never[] = [];
const NO_ARCHIVE: Record<string, ArchivedProjectInfo> = {};

/** A project row while the library loads: a folder row's height and shape, its name on its way. */
const PendingRow = ({ w }: { w: string }) => (
  <div className="nav-item pending" aria-hidden="true" style={{ paddingLeft: 10 }}>
    <span className="twisty none" />
    <I name="folder" size={15} />
    <span className="nav-label">
      <SkLine w={w} />
    </span>
    <span className="nav-count">
      <SkLine w="1.4em" />
    </span>
  </div>
);

/** What deleting a project or folder does, in a sentence: only it goes; a folder's videos and folders move up a level,
 * a project's videos have no project then and its folders become projects. */
function whatMovesUp(videos: number, subfolders: number, target: string | null): string {
  if (!videos && !subfolders) return t('It’s empty, so nothing else changes.');
  if (target === null)
    return [
      videos && t('Only the project goes: {n} video moves to No project.|Only the project goes: {n} videos move to No project.', { n: videos }),
      subfolders && t('Its {n} folder becomes a project.|Its {n} folders become projects.', { n: subfolders }),
    ]
      .filter(Boolean)
      .join(' ');
  const parts = [videos && t('{n} video|{n} videos', { n: videos }), subfolders && t('{n} folder|{n} folders', { n: subfolders })].filter(
    (x): x is string => !!x,
  );
  const what = parts.length === 2 ? t('{a} and {b}', { a: parts[0], b: parts[1] }) : parts[0];
  return t('Only the folder goes: {what} moves up to {target}.|Only the folder goes: {what} move up to {target}.', { n: videos + subfolders, what, target });
}

export function Sidebar({ videos: loaded, folders: all = NONE, archived = NO_ARCHIVE, view, onMoveVideo, onShareFolder }: SidebarProps) {
  const pending = !loaded;
  const videos = loaded ?? NONE;
  // An archived project leaves the tree (it and its folders), and its videos the counts: the Archived row holds them.
  const folders = useMemo(() => all.filter((f) => !archivedIn(f, archived)), [all, archived]);
  const archivedCount = Object.keys(archived).length;
  // Reviewers browse projects but don't reorganize them.
  const can = useCan();
  const organize = can('organize');
  const share = can('share');
  const download = can('download');
  const [expanded, setExpanded] = useState(loadExpanded);
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);
  const actions = useFolderActions();
  // The inbox's count is the bell's: what waits for you (asked once someone is signed in; on its way until then).
  const forYou = useVisibleForYou(!!useAuthStatus().data?.user);
  const waiting = forYou.data ? forYou.data.total : forYou.error ? undefined : null;
  const live = videos.filter((v) => !v.archived && !v.project_archived);
  const qc = useQueryClient();
  const me = useAuthStatus().data?.user?.name ?? null;
  // The trial at the foot, above Settings (billing/Banner.tsx): its room from the first paint when the plan this browser
  // kept says one runs, its words and ruler once their code is here (the library asks for the plan; this reads it)
  const billing = useBilling(false).data;
  const Trial = useLoaded(billingCode, usePainted(!!billing))?.TrialLine;
  const viewFolder = view.kind === 'folder' || view.kind === 'playbook' ? view.id : null;
  // on an archived project's page, the Archived row is where you are
  const inArchive = view.kind === 'archived' || (!!viewFolder && !!archivedIn(viewFolder, archived));

  const toggle = (f: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      n.has(f) ? n.delete(f) : n.add(f);
      try {
        localStorage.setItem(EXPANDED, JSON.stringify([...n]));
      } catch {}
      return n;
    });
  // Reveal the folder that is open (and its parents).
  useEffect(() => {
    if (!viewFolder) return;
    const parts = viewFolder.split('/');
    const need = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
    setExpanded((s) => (need.every((p) => s.has(p)) ? s : new Set([...s, ...need])));
  }, [viewFolder]);

  const children = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const f of folders) {
      const p = parentOf(f);
      m.set(p, [...(m.get(p) || []), f]);
    }
    return m;
  }, [folders]);
  const stats = useMemo(() => {
    const m = new Map<string, { n: number; must: boolean; open: number }>();
    for (const f of folders) {
      const inside = live.filter((v) => within(v.folder, f));
      m.set(f, { n: inside.length, must: inside.some((v) => v.counts.must > 0), open: inside.reduce((s, v) => s + v.counts.open, 0) });
    }
    return m;
  }, [folders, live]);
  const sessions = useMemo(() => {
    const m = new Map<string, { n: number; active: boolean; ref: NonNullable<VideoSummary['session']> }>();
    for (const v of live) {
      if (!v.session) continue;
      const s = m.get(v.session.name) || { n: 0, active: false, ref: v.session };
      s.n++;
      s.active ||= !!v.sessionActive;
      m.set(v.session.name, s);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [live]);
  // What each agent is doing now, in its row: its code and data come after the first paint (the start's budget), and
  // nothing shows until an agent does something.
  const Now = useLoaded(agentNow, usePainted() && sessions.length > 0 && can('agents'));

  const create = async (parent: string, name: string) => {
    setEditing(null);
    const path = parent ? `${parent}/${name}` : name;
    try {
      await actions.create.mutateAsync(path);
      if (parent) setExpanded((s) => new Set([...s, parent]));
      goView({ kind: 'folder', id: path });
    } catch (e) {
      toastError(e);
    }
  };
  const moveFolder = async (from: string, to: string, undo = true) => {
    try {
      await actions.rename.mutateAsync({ from, to });
      if (viewFolder && within(viewFolder, from)) goView({ kind: 'folder', id: to + viewFolder.slice(from.length) });
      if (undo)
        toastUndo(parentOf(from) === parentOf(to) ? t('Renamed to {leaf}', { leaf: leaf(to) }) : t('Moved to {crumbs}', { crumbs: crumbs(to) }), () =>
          moveFolder(to, from, false),
        );
    } catch (e) {
      toastError(e);
    }
  };
  const rename = async (from: string, name: string) => {
    setEditing(null);
    const p = parentOf(from);
    const to = p ? `${p}/${name}` : name;
    if (to !== from) await moveFolder(from, to);
  };
  const dropOn = (target: string | null) => (d: Dropped) => {
    if (d.video) return onMoveVideo(d.video, target);
    const folder = d.folder;
    if (folder && folder !== target && !(target && within(target, folder))) moveFolder(folder, target ? `${target}/${leaf(folder)}` : leaf(folder));
  };
  const remove = async (f: string) => {
    setDeleting(null);
    try {
      const r = await actions.remove.mutateAsync(f);
      if (viewFolder && within(viewFolder, f)) goView(r.parent ? { kind: 'folder', id: r.parent } : { kind: 'all' });
      toast(t('Deleted {leaf}', { leaf: leaf(f) }), 'ok');
    } catch (e) {
      toastError(e);
    }
  };

  // Archived at once, with Undo; the request goes once the toast is gone (Archived.tsx).
  const archive = (f: string) => void archivedCode.load().then((m) => m.archiveProject(qc, f, me), toastError);

  // The ⋯ menu and the right-click menu of a row, naming what it acts on: a project (top level) or a folder in one.
  const folderMenu = (f: string): MenuEntry[] => {
    const p = isProject(f);
    // a project is put away by its owners and admins (lib/archived.ts): out of sight, nothing lost, back in one click
    const archiveIt = p && can('archive') && { label: t('Archive project'), icon: 'archive' as const, onClick: () => archive(f) };
    const shareIt = share && {
      label: p ? t('Share project…') : t('Share folder…'),
      icon: 'link' as const,
      onClick: () => (onShareFolder ? onShareFolder(f) : setSharing(f)),
    };
    const downloadIt = download && {
      label: p ? t('Download project') : t('Download folder'),
      icon: 'download' as const,
      onClick: () => void downloadFolder(f),
    };
    return organize
      ? [
          { label: t('New folder'), icon: 'folderPlus', onClick: () => setEditing({ mode: 'new', parent: f }) },
          { label: p ? t('Rename project') : t('Rename folder'), icon: 'edit', onClick: () => setEditing({ mode: 'rename', path: f }) },
          'sep',
          shareIt,
          downloadIt,
          'sep',
          archiveIt,
          { label: p ? t('Delete project…') : t('Delete folder…'), icon: 'trash', danger: true, onClick: () => setDeleting(f) },
        ]
      : [shareIt, downloadIt];
  };

  const renderTree = (parent: string, depth: number): ReactNode =>
    (children.get(parent) || []).map((f) => {
      const kids = children.has(f);
      const st = stats.get(f) || { n: 0, must: false };
      const open = expanded.has(f);
      if (editing?.mode === 'rename' && editing.path === f)
        return <NavInput key={f} depth={depth} defaultValue={leaf(f)} onSubmit={(n) => rename(f, n)} onCancel={() => setEditing(null)} />;
      return (
        <div key={f}>
          <NavItem
            depth={depth}
            label={leaf(f)}
            title={crumbs(f)}
            icon={open && kids ? 'folderOpen' : 'folder'}
            active={viewFolder === f}
            onClick={() => goView({ kind: 'folder', id: f })}
            count={st.n}
            dot={st.must ? <KeyGlyph shape="diamond" className="nav-kg must" /> : null}
            drop={organize ? dropOn(f) : undefined}
            draggable={organize}
            onDragStart={(e) => {
              e.stopPropagation();
              e.dataTransfer.setData(DRAG_FOLDER, f);
              e.dataTransfer.effectAllowed = 'move';
            }}
            twisty={
              kids ? (
                <IconButton
                  className={`twisty ${open ? 'open' : ''}`}
                  label={open ? t('Collapse {leaf}', { leaf: leaf(f) }) : t('Expand {leaf}', { leaf: leaf(f) })}
                  tip={open ? t('Collapse') : t('Expand')}
                  icon="right"
                  size={11}
                  tabIndex={-1}
                  aria-expanded={open}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(f);
                  }}
                />
              ) : (
                <span className="twisty none" />
              )
            }
            menu={folderMenu(f)}
            actions={
              organize && (
                <>
                  <IconButton
                    className="nav-act nav-new"
                    label={t('New folder')}
                    icon="folderPlus"
                    size={14}
                    onClick={() => setEditing({ mode: 'new', parent: f })}
                  />
                  <Menu
                    sideOffset={2}
                    trigger={<IconButton className="nav-act" label={isProject(f) ? t('Project actions') : t('Folder actions')} icon="more" size={14} />}
                    items={folderMenu(f)}
                  />
                </>
              )
            }
          />
          {editing?.mode === 'new' && editing.parent === f && (
            <NavInput depth={depth + 1} placeholder={t('Folder name')} onSubmit={(n) => create(f, n)} onCancel={() => setEditing(null)} />
          )}
          {open && kids && renderTree(f, depth + 1)}
        </div>
      );
    });

  const unsorted = live.filter((v) => !v.folder).length;
  const projectsDrop = useDrop(dropOn(null), [DRAG_FOLDER]);

  return (
    <aside className="nav grain">
      {/* The aside carries the background and grain and stays put; this scrolls (grain on a scroller ends after a screenful). */}
      <ScrollArea className="nav-sa" viewportClassName="nav-scroll">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: ↑/↓ walk the rows inside (each one focusable), as in the library's grid and list */}
        <div className="nav-sections" onKeyDown={arrowNav}>
          <div className="nav-section">
            {/* Your turn first: the inbox holds everything that waits for you (the bell's number); where every video
                stands is All videos' lane chips (Needs you · Being fixed · Approved · Final), the board's words. */}
            <NavItem
              icon="bell"
              label={t('Inbox')}
              count={waiting}
              active={view.kind === 'inbox'}
              onClick={() => goView({ kind: 'inbox' })}
              testId="nav-inbox"
            />
            <NavItem
              icon="film"
              label={t('All videos')}
              count={pending ? null : live.length}
              active={view.kind === 'all'}
              onClick={() => goView({ kind: 'all' })}
              testId="nav-all"
            />
            <NavItem icon="chart" label={t('Insights')} active={view.kind === 'insights'} onClick={() => goView({ kind: 'insights' })} />
          </div>

          <RecentNav videos={videos} pending={pending} />

          <div className="nav-section">
            <div className={`nav-head ${organize && projectsDrop.over ? 'drop' : ''}`} {...(organize ? projectsDrop.props : {})}>
              {t('Projects')}
              {organize && (
                <IconButton className="nav-act" label={t('New project')} icon="plus" size={14} onClick={() => setEditing({ mode: 'new', parent: '' })} />
              )}
            </div>
            {editing?.mode === 'new' && editing.parent === '' && (
              <NavInput depth={0} placeholder={t('Project name')} onSubmit={(n) => create('', n)} onCancel={() => setEditing(null)} />
            )}
            {pending ? ['58%', '44%', '66%'].map((w) => <PendingRow key={w} w={w} />) : renderTree('', 0)}
            {/* videos in no project: a row of the tree's own shape, there only while there are some (or it is open) */}
            {((!pending && unsorted > 0) || view.kind === 'unsorted') && (
              <NavItem
                twisty={<span className="twisty none" />}
                icon="inbox"
                label={t('No project')}
                count={pending ? null : unsorted}
                active={view.kind === 'unsorted'}
                onClick={() => goView({ kind: 'unsorted' })}
                drop={organize ? dropOn(null) : undefined}
                testId="nav-unsorted"
              />
            )}
            {/* the archived projects, out of the tree: a row of its shape, there while there are some (or one is open) */}
            {((!pending && archivedCount > 0) || inArchive) && (
              <NavItem
                twisty={<span className="twisty none" />}
                icon="archive"
                label={t('Archived')}
                count={pending ? null : archivedCount}
                countOf={t('project|projects', { n: archivedCount })}
                active={inArchive}
                onClick={() => goView({ kind: 'archived' })}
                testId="nav-archived"
              />
            )}
            {organize && !pending && !folders.length && !(editing?.mode === 'new' && editing.parent === '') && (
              <button type="button" className="nav-empty" onClick={() => setEditing({ mode: 'new', parent: '' })}>
                <I name="plus" size={13} /> {t('New project')}
              </button>
            )}
          </div>

          {sessions.length > 0 && (
            <div className="nav-section">
              <div className="nav-head">{t('Agents')}</div>
              {sessions.map(([name, s]) => {
                return (
                  <NavItem
                    key={name}
                    lead={<AgentMark kind={agentKindOfRef(s.ref)} size={15} />}
                    label={
                      <>
                        {name}
                        {Now && <Now.AgentNowText agent={name} />}
                      </>
                    }
                    count={s.n}
                    countOf={t('video|videos', { n: s.n })}
                    dot={
                      Now ? (
                        <Now.AgentNowDot agent={name} active={s.active} />
                      ) : (
                        <KeyGlyph shape={s.active ? 'ease' : 'outline'} className={`nav-kg ${s.active ? 'live' : ''}`} />
                      )
                    }
                    active={view.kind === 'session' && view.id === name}
                    onClick={() => goView({ kind: 'session', id: name })}
                    wrap={(row) => (
                      <SessionHover session={s.ref} active={s.active} videos={s.n} side="right">
                        {row}
                      </SessionHover>
                    )}
                  />
                );
              })}
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Settings and the theme — in the phone drawer too, where the account chip isn't. The language lives in Settings. */}
      {/* Settings: the one way in on a phone (the account chip isn't there) and a visible one at a desk (the account menu
          and ⌘, are the others). The theme is a setting (Appearance), with a quick row in the account menu. */}
      {trialLineDue(billing) && (
        <div className="nav-trial-wrap">{Trial && billing ? <Trial billing={billing} /> : <span className="nav-trial" aria-hidden="true" />}</div>
      )}
      <div className="nav-foot">
        <a className="nav-settings" href="#/settings" data-testid="settings-link">
          <I name="settings" size={15} />
          <span className="grow">{t('Settings')}</span>
          <kbd className="kbd">⌘,</kbd>
        </a>
      </div>

      {sharing && <LazyShareModal folder={sharing} onClose={() => setSharing(null)} />}
      {deleting && (
        <Confirm
          title={isProject(deleting) ? t('Delete the project “{name}”?', { name: leaf(deleting) }) : t('Delete the folder “{name}”?', { name: leaf(deleting) })}
          action={isProject(deleting) ? t('Delete project') : t('Delete folder')}
          danger
          busy={actions.remove.isPending}
          onClose={() => setDeleting(null)}
          onConfirm={() => remove(deleting)}
        >
          {whatMovesUp(
            live.filter((v) => v.folder === deleting).length,
            (children.get(deleting) || []).length,
            parentOf(deleting) ? leaf(parentOf(deleting)) : null,
          )}
        </Confirm>
      )}
    </aside>
  );
}
