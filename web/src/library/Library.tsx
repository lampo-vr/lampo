// The library: every video under review, in four layouts — grid, compact, list and a board of stages —
// filtered, sorted and grouped from one calm toolbar. What goes where is decided in model.ts. While it loads it is the
// same page: the top bar, the sidebar, the title and the toolbar are real, and only what the data decides (counts,
// names, posters) waits as placeholders of its own size — so nothing moves when the data arrives.
import { useQueryClient } from '@tanstack/react-query';
import { lazy, type ReactNode, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { archivedIn } from '../../../lib/archived.ts';
import { can as roleCan } from '../../../lib/permissions.ts';
import { LANES } from '../../../lib/stage.ts';
import { compareTime } from '../../../lib/time.ts';
import { useAuthStatus, useCan, useLikelyRole } from '../api/auth.ts';
import { useSettle, useVideoActions } from '../api/mutations.ts';
import { usePlaybooks } from '../api/playbooks.ts';
import { useBilling, useFolderSuggestion, useInfo, useLibrary } from '../api/queries.ts';
import type { VideoSummary } from '../api/types.ts';
import { billingCode } from '../billing/code.ts';
import { bannerDue } from '../billing/due.ts';
import { t } from '../i18n/index.ts';
import { T, useLang } from '../i18n/T.tsx';
import { InboxKeys, InboxModeSwitch, InboxTally } from '../inbox/Tally.tsx';
import { InboxViewPending } from '../inbox/ViewPending.tsx';
import { chromeLibrary, rememberLibrary } from '../lib/chromeHint.ts';
import { isProject } from '../lib/folders.ts';
import { fileName } from '../lib/format.ts';
import { loader, screen, useLoaded, usePainted } from '../lib/lazy.ts';
import { crumbs, goView, type LibraryView, leaf } from '../lib/nav.ts';
import { usePrefs } from '../lib/prefs.ts';
import { copyText, toast, toastError, toastUndo } from '../lib/toast.ts';
import { WINDOW_FROM } from '../lib/windowing.ts';
import { getStartedCode, roomOf, useFirstRun } from '../onboarding/state.ts';
import { PALETTE_KEY } from '../palette/PaletteButton.tsx';
import { PlaybookPending } from '../playbook/PlaybookShell.tsx';
import { LazyShareModal } from '../share/LazyShareModal.tsx';
import type { EmptyArtName } from '../ui/emptyArt.tsx';
import { Spinner } from '../ui/feedback.tsx';
import { I } from '../ui/icons.tsx';
import { Drawer, IconButton, Menu, type MenuEntry, Tip } from '../ui/primitives.tsx';
import { SkeletonRegion, SkLine } from '../ui/Skeleton.tsx';
import { Button, EmptyState } from '../ui/system.tsx';
import { VIDEO_ACCEPT } from '../uploads/formats.ts';
import { useFileDrop } from '../uploads/useFileDrop.ts';
import { ArchivedBanner } from './ArchivedBanner.tsx';
import { AskLead, useFolderAsk } from './AskLead.tsx';
import { archivedCode, useArchived } from './archiving.ts';
import { arrowNav } from './arrowNav.ts';
import { Board, BoardPending } from './Board.tsx';
import { downloadFolder } from './downloadFolder.ts';
import { Film, FilmPending } from './Film.tsx';
import { FilmGrid } from './FilmGrid.tsx';
import { FilmList, FilmListPending } from './FilmList.tsx';
import { FilterButton, FilterChips } from './Filters.tsx';
import { InsightsPending, PeriodPicker } from './InsightsFrame.tsx';
import { LibraryTopbar } from './LibraryTopbar.tsx';
import {
  applyFilters,
  decodeRules,
  encodeRules,
  type FilterField,
  type FilterRule,
  type GroupBy,
  groupVideos,
  LAYOUTS,
  type LaneFilter,
  type Layout,
  LIBRARY_PER_TAB,
  LIBRARY_PREFS,
  laneCounts,
  type Section,
  type SortBy,
  scope,
  sortVideos,
} from './model.ts';
import { moveCode, useMovedVideos, useMoveState, useMoves } from './moved.ts';
import { SectionHead } from './SectionHead.tsx';
import { Sidebar } from './Sidebar.tsx';
import { Toolbar } from './Toolbar.tsx';
import { useUnsentCounts } from './unsent.tsx';
import { type CardKit, CardKitContext } from './useVideoMenu.tsx';

// The uploader (tus) loads the first time someone uploads.
// A folder's playbook: the editors and diffs load when one is first opened (PlaybookShell stands in meanwhile).
const PlaybookPage = screen(loader(() => import('../playbook/PlaybookPage.tsx')));
// The inbox view is a chunk of its own, asked for at once when the page opens on it.
const inboxViewCode = loader(() => import('../inbox/InboxView.tsx'));
if (/^#\/(inbox|for-you|verify)\b/.test(location.hash)) void inboxViewCode.load().catch(() => {});
const InboxView = screen(inboxViewCode);
// Insights too: its frame and loading state ride here (InsightsFrame.tsx), the page arrives when it is opened.
const insightsCode = loader(() => import('./Insights.tsx'));
if (/^#\/insights\b/.test(location.hash)) void insightsCode.load().catch(() => {});
const Insights = screen(insightsCode);
// Add video opens on a click or a drop, never in the first paint: its code (and the folder picker's) comes right after.
const addVideoCode = loader(() => import('./AddVideo.tsx'));
// The Archived page comes at once when the page opens on it.
if (/^#\/archived\b/.test(location.hash)) void archivedCode.load().catch(() => {});
const UploadDialog = lazy(() => import('../uploads/UploadDialog.tsx').then((m) => ({ default: m.UploadDialog })));

/** What "Make one with an agent" copies: the person's agent makes the video with whatever it has, puts it up for review
 * and works the notes; an agent that isn't connected yet asks the person to connect it. No tool named, no token. */
const makePrompt = (upload: boolean) =>
  upload
    ? t(
        'Make a short video: <what it’s for, who it’s for, how long>. When it’s rendered, put it into Lampo for review with `vr push <file> --folder "<Project>"`, then read my notes with `vr open <video>` and fix them. If `vr` isn’t set up yet, ask me to connect you in Lampo (Settings → Connect an agent).',
      )
    : t(
        'Make a short video: <what it’s for, who it’s for, how long>. When it’s rendered, put it into Lampo for review with `vr track <file> --me`, then read my notes with `vr open <video>` and fix them.',
      );

// Empty library: the first render dropping onto an empty layer, what to do, the one button — and, with no video yet,
// the person's agent making one (its prompt copied). `upload`: whoever opens it uploads (not at the machine itself, or
// a hosted server); at the machine a render is linked. Reviewers can't add videos: they wait for someone who can.
function EmptyLibrary({ onAdd, upload, connect, locked }: { onAdd: (() => void) | null; upload: boolean; connect: boolean; locked?: boolean }) {
  if (!onAdd)
    return (
      <EmptyState art="library" titleAs="h2" className="empty-library" title={t('Nothing to review yet')}>
        {t('Videos show up here as soon as someone on the team uploads them.')}
      </EmptyState>
    );
  return (
    <EmptyState
      art="library"
      titleAs="h2"
      className="empty-library"
      title={t('Nothing to review yet')}
      action={
        upload ? (
          <Button variant={locked ? 'secondary' : 'primary'} icon={locked ? 'lock' : 'upload'} onClick={onAdd}>
            {t('Upload video')} <kbd>U</kbd>
          </Button>
        ) : (
          <Button variant="primary" icon="plus" onClick={onAdd}>
            {t('Add video')} <kbd>A</kbd>
          </Button>
        )
      }
      secondary={
        <Tip content={makePrompt(upload)}>
          <button
            type="button"
            className="btn ghost"
            data-testid="make-with-agent"
            onClick={async () => {
              if (await copyText(makePrompt(upload))) toast(t('Prompt copied: paste it to your agent and fill in what the video is for'), 'ok');
            }}
          >
            <I name="spark" size={14} /> {t('Make one with an agent')}
          </button>
        </Tip>
      }
      tips={[t('Drop video files anywhere on this page')]}
      foot={
        <>
          {t('No video yet? Your agent can make one and put it here for review.')}
          {connect && (
            <>
              {' '}
              <a className="btn-link" href="#/settings/mcp">
                {t('Connect an agent')}
              </a>
            </>
          )}
        </>
      }
    >
      {upload
        ? t('Upload a video, and every note you pin reaches the agent that made it, frame-exact.')
        : t('Add a video, assign the agent that made it, and every note you pin reaches it frame-exact.')}
    </EmptyState>
  );
}

/** What a view says when it has nothing to show. */
interface Empty {
  art: EmptyArtName;
  title: string;
  body?: string;
  /** "Open the library": a view of some of the videos, empty now, points at all of them. */
  toLibrary?: boolean;
  tip?: ReactNode;
}

interface Page {
  crumb: string[];
  crumbPaths?: (string | null)[];
  title: string;
  insights?: boolean;
  /** What waits for you instead of videos (the inbox view). */
  inbox?: boolean;
  /** The archived projects instead of videos (the Archived view). */
  archive?: boolean;
  /** A folder's playbook instead of its videos (the folder's second tab). */
  playbook?: boolean;
  /** The folder a page is about: its header has the Videos · Playbook tabs. */
  folder?: string;
  empty: Empty;
}

function pageOf(view: LibraryView): Page {
  switch (view.kind) {
    case 'inbox':
      return { crumb: [], title: t('Inbox'), inbox: true, empty: { art: 'inbox', title: '' } };
    case 'insights':
      return { crumb: [], title: t('Insights'), insights: true, empty: { art: 'insights', title: '' } };
    case 'archived':
      return { crumb: [], title: t('Archived'), archive: true, empty: { art: 'filed', title: '' } };
    case 'unsorted':
      // shown only while some video has no project (the sidebar row goes with the last one; Library sends #/unsorted on)
      return {
        crumb: [],
        title: t('No project'),
        empty: { art: 'filed', title: t('Everything is in a project'), body: t('Videos without a project show up here.'), toLibrary: true },
      };
    case 'session':
      return {
        crumb: [],
        title: view.id,
        empty: { art: 'agents', title: t('No videos from this agent'), body: t('The videos it puts up show up here.') },
      };
    case 'folder':
    case 'playbook': {
      // a crumb only inside a project: where the folder sits ("Northwind / Social"); a project is its own top
      const parts = view.id.split('/');
      return {
        crumb: parts.slice(0, -1),
        crumbPaths: parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/')),
        title: leaf(view.id),
        folder: view.id,
        playbook: view.kind === 'playbook',
        empty: {
          art: 'folder',
          title: isProject(view.id) ? t('This project is empty') : t('This folder is empty'),
          body: t('Drag videos onto it in the sidebar, or add one.'),
        },
      };
    }
    default:
      return {
        crumb: [],
        title: t('All videos'),
        empty: { art: 'library', title: t('Nothing here'), body: t('Videos you add show up here, sorted into their projects.') },
      };
  }
}

/** "Launch film › Cuts" under a section's folder; the whole path where the section isn't a folder. */
function whereIn(v: VideoSummary, base: string | null): string | null {
  if (!v.folder) return base ? null : t('No project');
  if (!base) return crumbs(v.folder);
  if (v.folder === base) return null;
  return v.folder.startsWith(`${base}/`) ? crumbs(v.folder.slice(base.length + 1)) : crumbs(v.folder);
}

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback);

interface Totals {
  videos: number;
  open: number;
  must: number;
}

/** Where you are, the title, and the tally (null: on its way). The title comes from the route, so it is there at once. */
/**
 * A folder's two sides: its videos (how many is beside the title), and its playbook, with the suggestions waiting on
 * it and on the playbooks of folders inside it (its page points to those).
 */
function FolderTabs({ folder, playbook, pending }: { folder: string; playbook: boolean; pending: boolean }) {
  const books = usePlaybooks(!pending).data?.playbooks ?? [];
  const own = books.find((p) => p.scope === folder)?.pending || 0;
  const waiting = books.filter((p) => p.scope === folder || p.scope.startsWith(`${folder}/`)).reduce((n, p) => n + p.pending, 0);
  return (
    <div className="hero-tabs-row">
      <div className="tabs hero-tabs" role="tablist" aria-label={t('Folder')}>
        <button
          type="button"
          role="tab"
          aria-selected={!playbook}
          className={playbook ? '' : 'on'}
          onClick={() => goView({ kind: 'folder', id: folder })}
          data-testid="folder-tab-videos"
        >
          <I name="film" size={14} />
          {t('Videos')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={playbook}
          className={playbook ? 'on' : ''}
          onClick={() => goView({ kind: 'playbook', id: folder })}
          data-testid="folder-tab-playbook"
        >
          <I name="playbook" size={14} />
          {t('Playbook')}
          {waiting > 0 && (
            <span
              className="n q"
              title={
                own === waiting
                  ? t('{n} suggestion waiting|{n} suggestions waiting', { n: waiting })
                  : t('{n} suggestion waiting here and in folders inside|{n} suggestions waiting here and in folders inside', { n: waiting })
              }
            >
              {waiting}
            </span>
          )}
        </button>
      </div>
    </div>
  );
}

function Hero({
  page,
  totals,
  onShare,
  pending,
  archived,
  projects,
  menu,
}: {
  page: Page;
  totals: Totals | null;
  onShare?: () => void;
  pending: boolean;
  /** The page is an archived project's (or a folder in one): the banner instead of Share; `onRestore` for who may. */
  archived?: { onRestore?: () => void } | null;
  /** The Archived view: how many projects it holds (null: on its way). */
  projects?: number | null;
  /** A project's own ⋯ (its owners and admins): what it does to the project as a whole, Archive among it. */
  menu?: MenuEntry[] | null;
}) {
  return (
    <div className="hero">
      {/* a crumb only inside a project (the top views, projects and agents have none); its line stays, so titles never move */}
      <div className="crumb">
        {page.crumb.map((c, i) => {
          const to = page.crumbPaths?.[i];
          return (
            <span key={page.crumb.slice(0, i + 1).join('/')}>
              {i > 0 && <i>/</i>}
              {to ? (
                <button type="button" onClick={() => goView({ kind: 'folder', id: to })}>
                  {c}
                </button>
              ) : (
                <span>{c}</span>
              )}
            </span>
          );
        })}
      </div>
      <div className="hero-row">
        <h1>{page.title}</h1>
        {page.inbox && <InboxTally pending={pending} />}
        {page.inbox && <InboxKeys pending={pending} />}
        {page.inbox && <InboxModeSwitch />}
        {page.archive && (
          <div className="tally">
            <span>
              {projects == null ? (
                <SkLine w="5em" />
              ) : (
                <>
                  <b>{projects}</b> {t('project|projects', { n: projects })}
                </>
              )}
            </span>
          </div>
        )}
        {!page.insights &&
          !page.inbox &&
          !page.archive &&
          (totals ? (
            // two quiet facts: how many, and what matters most in them (must-fix notes, else open notes) — what waits for
            // you is the inbox's to count
            <div className="tally">
              <span>
                <b>{totals.videos}</b> {t('video|videos', { n: totals.videos })}
              </span>
              {totals.must > 0 ? (
                <span className="must">
                  <b>{totals.must}</b> {t('must-fix')}
                </span>
              ) : (
                totals.open > 0 && (
                  <span>
                    <b>{totals.open}</b> {t('open note|open notes', { n: totals.open })}
                  </span>
                )
              )}
            </div>
          ) : (
            <div className="tally">
              <span>
                <SkLine w="11em" />
              </span>
            </div>
          ))}
        {page.insights && <PeriodPicker />}
        {archived ? (
          <ArchivedBanner onRestore={archived.onRestore} />
        ) : (
          onShare && (
            <Tip
              content={
                page.folder && isProject(page.folder) ? t('A review link for everything in this project') : t('A review link for everything in this folder')
              }
            >
              <button type="button" className="btn sm hero-share" onClick={onShare}>
                <I name="send" size={14} /> {page.folder && isProject(page.folder) ? t('Share project') : t('Share folder')}
              </button>
            </Tip>
          )
        )}
        {!archived && menu && (
          <Menu
            trigger={<IconButton className={`btn sm ghost icon-only hero-more${onShare ? '' : ' alone'}`} label={t('Project actions')} icon="more" size={15} />}
            items={menu}
          />
        )}
      </div>
      {page.folder && <FolderTabs folder={page.folder} playbook={!!page.playbook} pending={pending} />}
    </div>
  );
}

/**
 * Videos without a project, at the machine: one quiet line where they are, with an example from this library (where
 * "Sort into projects" would put the first of them, from where it sits on disk).
 */
function UnfiledRow({ videos, onSort, busy }: { videos: VideoSummary[]; onSort: () => void; busy: boolean }) {
  const first = videos.find((v) => !v.video.startsWith('/@uploads/')) ?? null;
  const to = useFolderSuggestion(first?.video ?? null).data?.suggestion?.folder;
  return (
    <div className="unfiled" data-testid="unfiled">
      <I name="folder" size={15} />
      <span className="grow">
        {first && to ? (
          <T
            k="Drag them onto a project, or sort them by where they sit on disk: <0>{name}</0> goes to <1>{folder}</1>."
            values={{ name: first.name, folder: crumbs(to) }}
            tags={[(c) => <b>{c}</b>, (c) => <b>{c}</b>]}
          />
        ) : (
          t('Drag them onto a project, or sort them by where they sit on disk.')
        )}
      </span>
      <Button size="sm" icon="folder" onClick={onSort} disabled={busy}>
        {busy && <Spinner />} {t('Sort into projects')}
      </Button>
    </div>
  );
}

/** The Archived page's rows while their code or the library is on its way: the rows' own shape (library.css). */
const ArchivedPending = () => (
  <ul className="arch-list" aria-hidden="true">
    {['9em', '6em'].map((w) => (
      <li key={w} className="arch-row pending">
        <span className="arch-open">
          <I name="archive" size={16} />
          <span className="arch-name">
            <SkLine w={w} />
          </span>
          <span className="arch-meta">
            <SkLine w="11em" />
          </span>
        </span>
      </li>
    ))}
  </ul>
);

/** The layout's own shapes while the library loads: a section of cards, the table, or the four lanes. */
function Pending({ layout, group, sort, onSort }: { layout: Layout; group: GroupBy; sort: SortBy; onSort: (s: SortBy) => void }) {
  if (layout === 'list') return <FilmListPending sort={sort} onSort={onSort} grouped={group !== 'none'} />;
  if (layout === 'board') return <BoardPending />;
  const compact = layout === 'compact';
  return (
    <section className="lib-section" aria-hidden="true">
      {group !== 'none' && (
        <div className="shead">
          <span className="shead-toggle" />
          <span className="shead-title">
            <SkLine w="6em" />
          </span>
          <span className="shead-count">
            <SkLine w="1em" />
          </span>
        </div>
      )}
      <div className={`grid ${compact ? 'compact' : ''}`}>
        {Array.from({ length: compact ? 12 : 8 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
          <FilmPending key={i} compact={compact} />
        ))}
      </div>
    </section>
  );
}

/**
 * `pending`: drawn before the server has said who you are (App's loading state for this route) — the same page,
 * nothing asked for yet. The real one takes over from it without a pixel moving.
 */
export default function Library({ view, pending = false }: { view: LibraryView; pending?: boolean }) {
  const { data, error, refetch } = useLibrary(!pending);
  // projects archived or restored a moment ago are so at once (./archiving.ts)
  const now = useArchived(data);
  const archivedProjects = now.archived;
  // a video moved to another lane stands there at once, before the server has it (library/moving.tsx)
  const videos = useMovedVideos(now.videos);
  const folders = data?.folders ?? [];
  // where a video can go or be uploaded to: no archived project, nor a folder in one
  const openFolders = useMemo(() => folders.filter((f) => !archivedIn(f, archivedProjects)), [folders, archivedProjects]);
  // the project this page is about is archived: read only, with a banner (and Restore for its owners and admins)
  const shutHere = (view.kind === 'folder' || view.kind === 'playbook') && data ? archivedIn(view.id, archivedProjects) : null;
  const qc = useQueryClient();
  const [prefs, setPref] = usePrefs(LIBRARY_PREFS, LIBRARY_PER_TAB);
  const [adding, setAdding] = useState(false);
  const Add = useLoaded(addVideoCode, usePainted(!pending) || adding);
  const [sharingFolder, setSharingFolder] = useState<string | null>(null);
  // Phones and small tablets: the sidebar lives in a drawer; any navigation closes it.
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => {
    if (!navOpen) return;
    const close = () => setNavOpen(false);
    window.addEventListener('hashchange', close);
    return () => window.removeEventListener('hashchange', close);
  }, [navOpen]);
  // Asked with the library, not by the loading state drawn before the server said who you are.
  const info = useInfo(!pending);
  // Where a billing provider runs: the trial's last days, a grace period or read-only, the moments of value (one chunk)
  const Billing = useLoaded(billingCode, usePainted(!pending && !!info?.billing));
  // the banner's code comes after the first paint: its room is held from the start when the plan this browser kept
  // (or the server's answer) says one will show, so the library doesn't drop when it arrives
  const billing = useBilling(!pending && !!info?.billing).data;
  const bannerRoom = !Billing && bannerDue(billing);
  // the server's operator suspended this workspace (A13 CLOUD-5): it says so above everything, and why nothing changes
  const status = useAuthStatus().data;
  const suspended = status?.workspace?.suspended ? status.workspace.name : null;
  // read-only (the plan, or the suspension): Add video is locked and explains itself instead of failing later (audit B-M8)
  const locked = billing?.state === 'read-only' || !!suspended;
  const [roPop, setRoPop] = useState(false);
  // At the machine the app runs on, a render is linked where it lives (and picked up again on every re-render);
  // anyone else — a teammate, a phone, everybody on a hosted server — uploads it. Dropping files uploads everywhere.
  const atMachine = status?.via === 'local';
  const linkHere = atMachine && !!info?.capabilities?.linkFiles;
  const can = useCan();
  const mayUpload = can('upload');
  const restoreHere = shutHere && can('archive') ? () => void archivedCode.load().then((m) => m.restoreProject(qc, shutHere), toastError) : undefined;
  const Arch = useLoaded(archivedCode, view.kind === 'archived');
  // A folder's Share button stands from the first paint (the role this browser saw last), not once the videos arrive
  const likelyRole = useLikelyRole();
  const mayShareLikely = !!likelyRole && roleCan(likelyRole, 'share');
  // A project's page has its own ⋯ for its owners and admins (from the first paint: the role this browser saw last), as
  // its row in the sidebar has: download it, archive it (with Undo; the page then says so).
  const me = status?.user?.name ?? null;
  const projectMenu: MenuEntry[] | null =
    (view.kind === 'folder' || view.kind === 'playbook') && isProject(view.id) && likelyRole && roleCan(likelyRole, 'archive')
      ? [
          roleCan(likelyRole, 'download') && { label: t('Download project'), icon: 'download', onClick: () => void downloadFolder(view.id) },
          'sep',
          {
            label: t('Archive project'),
            icon: 'archive',
            onClick: () => void archivedCode.load().then((m) => m.archiveProject(qc, view.id, me), toastError),
          },
        ]
      : null;
  const [dropped, setDropped] = useState<File[] | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const upload = () =>
    suspended
      ? toast(t('{workspace} is suspended: nothing can be added for now.', { workspace: suspended }), 'error')
      : locked
        ? setRoPop(true)
        : picker.current?.click();
  const add = () => (!mayUpload ? undefined : linkHere && !locked ? setAdding(true) : upload());
  const dragging = useFileDrop(mayUpload, (files) => {
    // dropped on "Add video" too: the upload takes over from the dialog
    setAdding(false);
    setDropped(files);
  });
  // The first run (onboarding/): Get started above All videos; its code comes when it shows (the setup runs first).
  const firstRun = useFirstRun();
  const Ob = useLoaded(getStartedCode, firstRun.shown && !firstRun.setup && !pending);
  // a new account's first visit is its setup (onboarding/Setup.tsx): until it is finished or skipped, All videos opens
  // Welcome instead (accounts from before the setup never see it)
  const toSetup = firstRun.setup && view.kind === 'all' && !pending;
  useLayoutEffect(() => {
    if (toSetup) location.replace('#/welcome');
  }, [toSetup]);
  const obProps = { add: mayUpload ? add : null, upload: !linkHere };
  // its room while its code arrives: the card's height (folded, with the machine's foot, its steps on a phone)
  const obRoom = roomOf(firstRun, linkHere && firstRun.variant === 'local');
  const actions = useVideoActions();
  const { move, autoSort } = actions;
  // Every card reads what it may do and the actions from here, not from hooks of its own (useVideoMenu.tsx).
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  // "2 not sent" on the videos where you kept notes to send later (one request for every card).
  // With nothing loaded the page itself says what went wrong; a toast is for a refresh that failed over shown data.
  const hasData = !!data;
  useUnsentCounts(can('comment'), hasData);
  useEffect(() => {
    if (error && hasData) toastError(error);
  }, [error, hasData]);

  const layout = pick<Layout>(prefs.layout, LAYOUTS, 'grid');
  const moveTo = useMoves(can, useSettle());
  const onBoard = layout === 'board';
  const kit = useMemo<CardKit>(() => ({ can, actions: actionsRef, move: moveTo, board: onBoard }), [can, moveTo, onBoard]);
  const group = pick<GroupBy>(prefs.group, ['folder', 'stage', 'none'], 'folder');
  const sort = pick<SortBy>(prefs.sort, ['recent', 'name', 'stage', 'open'], 'recent');
  const lane = pick<LaneFilter>(prefs.lane, ['all', ...LANES.map((l) => l.id)], 'all');
  const q = String(prefs.q || '');
  const session = String(prefs.session || '');
  const archived = !!prefs.archived;
  const rules = decodeRules(prefs.rules);
  const setRules = (r: FilterRule[]) => {
    setPref('rules', encodeRules(r));
    // The old agent select lives on as the Agent filter.
    if (session) setPref('session', '');
  };
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterField, setFilterField] = useState<FilterField | null>(null);

  // Keys: A / N add a video (linked at the machine, uploaded elsewhere), U uploads, 1–4 switch the layout, / filters,
  // F opens the filter chips.
  const keys = useRef({ add, upload, setPref, mayUpload, filter: () => setFilterOpen(true) });
  keys.current = { add, upload, setPref, mayUpload, filter: () => setFilterOpen(true) };
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if ((e.target as Element | null)?.closest?.('input, textarea, select, [role=dialog], [role=menu]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'a' || e.key === 'n') {
        e.preventDefault();
        keys.current.add();
      } else if (e.key === 'u' && keys.current.mayUpload) {
        e.preventDefault();
        keys.current.upload();
      } else if (/^[1-4]$/.test(e.key)) {
        keys.current.setPref('layout', LAYOUTS[Number(e.key) - 1]);
      } else if (e.key === '/') {
        e.preventDefault();
        filterRef.current?.focus();
      } else if (e.key === 'f') {
        e.preventDefault();
        keys.current.filter();
      }
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, []);

  // "Add a video" from the command palette arrives as #/?add: open the dialog (or the file picker) once, then tidy up.
  const loaded = !!videos;
  useEffect(() => {
    if (!loaded) return;
    const check = () => {
      if (location.hash !== '#/?add') return;
      history.replaceState(null, '', '#/');
      keys.current.add();
    };
    check();
    window.addEventListener('hashchange', check);
    return () => window.removeEventListener('hashchange', check);
  }, [loaded]);

  // Which names each folder holds already: the upload dialog says which files become a new version.
  const uploaded = useMemo(() => {
    const m = new Map<string | null, Set<string>>();
    for (const v of videos || []) {
      if (!v.video.startsWith('/@uploads/') || v.archived) continue;
      const k = v.folder || null;
      m.set(k, (m.get(k) || new Set()).add(fileName(v.video)));
    }
    return m;
  }, [videos]);

  const moveVideo = async (slug: string, folder: string | null) => {
    const v = videos?.find((x) => x.slug === slug);
    if (!v || (v.folder || null) === (folder || null)) return;
    try {
      const from = v.folder || null;
      await move.mutateAsync({ slug, folder });
      toastUndo(`${v.name} → ${folder ? crumbs(folder) : t('No project')}`, () => move.mutateAsync({ slug, folder: from }));
    } catch (e) {
      toastError(e);
    }
  };
  const sortAll = async () => {
    try {
      const r = await autoSort.mutateAsync();
      toast(r.moved ? t('Sorted {n} video into projects|Sorted {n} videos into projects', { n: r.moved }) : t('Nothing to sort'), 'ok');
    } catch (e) {
      toastError(e);
    }
  };

  const page = pageOf(view);
  const inScope = useMemo(() => scope(videos ?? [], view), [videos, view]);
  // Chips count what the other filters leave, so a number never promises cards that aren't there.
  const rulesKey = String(prefs.rules || '');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the rules are read from their string
  const beforeLane = useMemo(() => applyFilters(inScope, { q, session, lane: 'all', archived, rules }), [inScope, q, session, archived, rulesKey]);
  const shown = useMemo(() => sortVideos(applyFilters(beforeLane, { q: '', session: '', lane, archived: true }), sort), [beforeLane, lane, sort]);
  const lang = useLang();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a section's title is words ("No project")
  const sections = useMemo(() => groupVideos(shown, group, view), [shown, group, view, lang]);
  const counts = useMemo(() => laneCounts(beforeLane), [beforeLane]);
  const totals = useMemo((): Totals => {
    const live = inScope.filter((v) => !v.archived);
    return {
      videos: live.length,
      open: live.reduce((s, v) => s + v.counts.open, 0),
      must: live.reduce((s, v) => s + v.counts.must, 0),
    };
  }, [inScope]);
  const unsortedCount = (videos || []).filter((v) => !v.folder && !v.archived).length;
  // Sorting by where files sit on disk is the machine's (linked renders); it shows with the videos it is about: inside
  // the No-project group of the cards, else (the No-project view, the list, the board, other groupings) above them
  const unfiledHere = (view.kind === 'all' || view.kind === 'unsorted') && unsortedCount > 0 && !!info?.capabilities?.linkFiles;
  const unfiledInSection = view.kind === 'all' && (layout === 'grid' || layout === 'compact') && group === 'folder';
  // Where renders were linked from lately (not uploads): Add video's browser starts in the newest, the others a click away
  const recentDirs = useMemo(() => {
    const out: string[] = [];
    for (const v of [...(videos || [])].sort((a, b) => compareTime(b.added, a.added))) {
      if (v.video.startsWith('/@uploads/')) continue;
      const dir = v.video.slice(0, v.video.lastIndexOf('/'));
      if (dir && !out.includes(dir)) out.push(dir);
      if (out.length === 3) break;
    }
    return out;
  }, [videos]);
  // "No project" is a place only while a video has no project (its sidebar row goes with the last one): an old link or
  // the last video filed away lands on All videos instead of an empty page
  const noProjectGone = view.kind === 'unsorted' && !!videos && unsortedCount === 0;
  useEffect(() => {
    if (noProjectGone) location.replace('#/');
  }, [noProjectGone]);
  const archivedCount = inScope.filter((v) => v.archived).length;
  // An empty library has no sidebar (bare). While it loads, what this browser saw last decides (lib/chromeHint.ts); one
  // that never saw it here (a new account's first visit) draws the top bar alone and lets the answer decide — a whole
  // skeleton with a sidebar and cards jumped 250 px to the empty state.
  const [seen] = useState(chromeLibrary);
  const emptyNow = videos ? !videos.length && !folders.length : null;
  const bare = emptyNow ?? seen === 'empty';
  const unseen = emptyNow === null && seen === null;
  useEffect(() => {
    if (emptyNow !== null) rememberLibrary(emptyNow);
  }, [emptyNow]);
  const filtering = !!q || !!session || lane !== 'all' || rules.length > 0;
  const clearFilters = () => {
    setPref('q', '');
    setPref('session', '');
    setPref('lane', 'all');
    setPref('rules', '');
  };
  let collapsed: string[] = [];
  try {
    collapsed = JSON.parse(String(prefs.collapsed || '[]'));
  } catch {}
  const toggleSection = (key: string) =>
    setPref('collapsed', JSON.stringify(collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key]));
  const base = view.kind === 'folder' ? view.id : null;
  const whereFor = (v: VideoSummary, s?: Section) => whereIn(v, s?.folder ?? base);
  // A question an agent asked here before the first version leads the content (AskLead.tsx). It comes with the inbox's
  // list, which this browser keeps: the content waits for that list only on a first visit, so the block never pushes
  // the videos down when it comes.
  const folderAsk = useFolderAsk(base, !pending);

  const content = () => {
    if (!shown.length)
      return filtering ? (
        <EmptyState
          art="filter"
          titleAs="h2"
          title={t('Nothing matches')}
          action={
            <Button icon="x" onClick={clearFilters}>
              {t('Clear filters')}
            </Button>
          }
          tips={[<T k="{key} searches notes too" key="k" values={{ key: <kbd>{PALETTE_KEY}</kbd> }} />]}
        >
          {t('Try fewer filters or another word.')}
        </EmptyState>
      ) : (
        <EmptyState
          art={page.empty.art}
          titleAs="h2"
          // under a question an agent waits on, a quieter place: it is not what this page is about now
          size={folderAsk.lead ? 'sm' : 'md'}
          className={folderAsk.lead ? 'asked' : ''}
          title={page.empty.title}
          action={
            (view.kind === 'folder' || view.kind === 'all') && mayUpload && !shutHere ? (
              // a question waiting above is the one thing to do here: adding a video steps back
              <Button variant={locked || folderAsk.lead ? 'secondary' : 'primary'} icon={locked ? 'lock' : linkHere ? 'plus' : 'upload'} onClick={add}>
                {view.kind === 'all'
                  ? linkHere
                    ? t('Add video')
                    : t('Upload video')
                  : linkHere
                    ? t('Add a video to {title}', { title: page.title })
                    : t('Upload a video to {title}', { title: page.title })}
              </Button>
            ) : (
              page.empty.toLibrary && (
                <a className="btn primary" href="#/">
                  {t('Open the library')}
                </a>
              )
            )
          }
          tips={[
            ...(page.empty.tip ? [page.empty.tip] : []),
            ...((view.kind === 'folder' || view.kind === 'all') && mayUpload && !shutHere ? [t('Drop video files anywhere on this page')] : []),
          ]}
        >
          {page.empty.body}
        </EmptyState>
      );
    if (layout === 'board') return <Board videos={shown} where={(v) => whereFor(v)} home={info?.home} folders={openFolders} />;
    if (layout === 'list')
      return (
        <FilmList
          sections={sections}
          sort={sort}
          onSort={(s) => setPref('sort', s)}
          where={whereFor}
          home={info?.home}
          folders={openFolders}
          onOpenSection={(f) => goView({ kind: 'folder', id: f })}
        />
      );
    const titled = sections.length > 1 || !!sections[0]?.folder;
    return sections.map((s, si) => {
      const closed = titled && collapsed.includes(s.key);
      return (
        <section key={s.key} className="lib-section" aria-label={s.title}>
          {titled && s.title && (
            <SectionHead
              section={s}
              collapsed={closed}
              onToggle={() => toggleSection(s.key)}
              // nothing goes into an archived project
              onDropVideo={shutHere ? undefined : moveVideo}
              current={s.folder === base}
            />
          )}
          {s.key === '~' && unfiledHere && !closed && <UnfiledRow videos={s.videos} onSort={sortAll} busy={autoSort.isPending} />}
          {!closed && (
            <FilmGrid
              videos={s.videos}
              compact={layout === 'compact'}
              long={shown.length > WINDOW_FROM}
              card={(v, i) => (
                <Film
                  key={v.slug}
                  v={v}
                  home={info?.home}
                  folders={openFolders}
                  where={s.key === '~' ? null : whereFor(v, s)}
                  compact={layout === 'compact'}
                  priority={si === 0 && i < 8}
                />
              )}
            />
          )}
        </section>
      );
    });
  };

  const libContent = (
    // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move between the items inside (each one focusable)
    <div className={`lib-content layout-${layout}`} onKeyDown={arrowNav} data-testid="library-content" data-layout={layout}>
      {videos && folderAsk.known ? (
        <>
          {/* a question waiting in an archived project waits as it is: nothing is answered there until it is restored */}
          {base && !shutHere && <AskLead ask={folderAsk} folder={base} />}
          {content()}
        </>
      ) : (
        <SkeletonRegion label={t('Loading the library')}>
          <Pending layout={layout} group={group} sort={sort} onSort={(x) => setPref('sort', x)} />
        </SkeletonRegion>
      )}
    </div>
  );

  return (
    <CardKitContext value={kit}>
      <div className="page">
        {/* not knowing yet whether there is a sidebar, the bar is an empty library's (the account in it on a phone, the
            drawer's button holding its place): what turns up then moves nothing in it */}
        <LibraryTopbar
          onNav={bare || unseen ? null : !videos ? 'wait' : () => setNavOpen(true)}
          onAdd={videos && mayUpload ? add : undefined}
          locked={locked}
          quiet={!!folderAsk.lead}
        >
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            accept={VIDEO_ACCEPT}
            onChange={(e) => {
              const files = [...(e.target.files || [])];
              e.target.value = '';
              if (files.length) setDropped(files);
            }}
            data-testid="upload-input"
          />
        </LibraryTopbar>
        {/* never seen here: nothing under the bar until the library says what it holds — a page drawn either way (with a
            sidebar or without) would move as a whole when the answer said the other */}
        {unseen && !error ? (
          <div className="lib grain bare" role="status" aria-busy="true" aria-label={t('Loading the library')} data-testid="skeleton" />
        ) : (
          <div className={`lib grain ${bare ? 'bare' : ''}`}>
            {!bare && <Sidebar videos={videos ?? undefined} folders={data?.folders} archived={archivedProjects} view={view} onMoveVideo={moveVideo} />}
            {videos && !bare && navOpen && (
              <Drawer open={navOpen} onOpenChange={setNavOpen} title={t('Menu')}>
                <Sidebar
                  videos={videos}
                  folders={folders}
                  archived={archivedProjects}
                  view={view}
                  onMoveVideo={moveVideo}
                  onShareFolder={(f) => {
                    setNavOpen(false);
                    setSharingFolder(f);
                  }}
                />
              </Drawer>
            )}
            <main className="lib-scroll">
              {suspended && (
                <section className="lib-suspended" role="status" data-testid="suspended-banner">
                  <I name="lock" size={15} />
                  <span>
                    <b>{t('{workspace} is suspended.', { workspace: suspended })}</b>{' '}
                    {t(
                      'Whoever runs this server holds it read-only: you can watch, read and download, but nothing can change, and its review links don’t open.',
                    )}
                  </span>
                </section>
              )}
              {/* suspended, the plan's nudges wait: nothing can be bought or changed until the operator lifts it */}
              {suspended ? null : Billing ? <Billing.BillingBanner /> : bannerRoom && <div className="lib-banner-room" aria-hidden="true" />}
              {!videos && error ? (
                <EmptyState
                  art="error"
                  titleAs="h2"
                  title={t('The library didn’t load')}
                  action={
                    <Button variant="primary" icon="refresh" onClick={() => void refetch()}>
                      {t('Try again')}
                    </Button>
                  }
                >
                  {(error as Error).message}
                </EmptyState>
              ) : bare ? (
                <>
                  {firstRun.shown && !firstRun.setup && (Ob ? <Ob.GetStarted {...obProps} /> : <div {...obRoom} aria-hidden="true" />)}
                  <EmptyLibrary onAdd={mayUpload ? add : null} upload={!linkHere} connect={can('agents')} locked={locked} />
                </>
              ) : (
                <>
                  <Hero
                    page={page}
                    pending={pending}
                    totals={videos ? totals : null}
                    onShare={(view.kind === 'folder' || view.kind === 'playbook') && mayShareLikely ? () => setSharingFolder(view.id) : undefined}
                    archived={shutHere ? { onRestore: restoreHere } : null}
                    menu={projectMenu}
                    projects={page.archive ? (data ? Object.keys(archivedProjects).length : null) : undefined}
                  />
                  {page.insights ? (
                    <Suspense fallback={<InsightsPending />}>
                      <Insights pending={pending} />
                    </Suspense>
                  ) : page.inbox ? (
                    <Suspense fallback={<InboxViewPending />}>
                      <InboxView pending={pending} />
                    </Suspense>
                  ) : page.archive ? (
                    <div className="lib-content" data-testid="library-content">
                      {Arch && videos ? <Arch.ArchivedView videos={videos} archived={archivedProjects} /> : <ArchivedPending />}
                    </div>
                  ) : page.playbook && view.kind === 'playbook' ? (
                    <Suspense fallback={<PlaybookPending scope={view.id} />}>
                      <PlaybookPage scope={view.id} pending={pending} />
                    </Suspense>
                  ) : (
                    <>
                      {/* one block for the controls: in the board's page (which doesn't scroll, library.css) their margins
                        still add up as they do in the other layouts */}
                      <div className="lib-controls">
                        {firstRun.shown &&
                          !firstRun.setup &&
                          view.kind === 'all' &&
                          (Ob ? <Ob.GetStarted {...obProps} /> : <div {...obRoom} aria-hidden="true" />)}
                        <Toolbar
                          filterRef={filterRef}
                          q={q}
                          onQ={(x) => setPref('q', x)}
                          lane={lane}
                          onLane={(x) => setPref('lane', x)}
                          counts={videos ? counts : null}
                          layout={layout}
                          onLayout={(x) => setPref('layout', x)}
                          group={group}
                          onGroup={(x) => setPref('group', x)}
                          sort={sort}
                          onSort={(x) => setPref('sort', x)}
                          // there while the library loads too, so the toolbar doesn't shift when it arrives
                          filter={
                            <FilterButton
                              videos={videos ? inScope.filter((v) => archived || !v.archived) : []}
                              rules={rules}
                              onRules={setRules}
                              open={filterOpen}
                              onOpen={setFilterOpen}
                              field={filterField}
                              onField={setFilterField}
                            />
                          }
                          archived={archived}
                          archivedCount={archivedCount}
                          onArchived={(x) => setPref('archived', x)}
                        />
                        <FilterChips
                          rules={rules}
                          onRules={setRules}
                          onEdit={(f) => {
                            setFilterField(f);
                            setFilterOpen(true);
                          }}
                        />

                        {unfiledHere && !unfiledInSection && (
                          <UnfiledRow videos={(videos || []).filter((v) => !v.folder && !v.archived)} onSort={sortAll} busy={autoSort.isPending} />
                        )}
                      </div>

                      {libContent}
                    </>
                  )}
                </>
              )}
            </main>
          </div>
        )}
        {dragging && (
          <div className="drop-veil" aria-hidden="true">
            <div className="drop-frame">
              <I name="upload" size={28} />
              <h2>{t('Drop to upload')}</h2>
              <p>
                {suspended
                  ? t('{workspace} is suspended: nothing can be added for now.', { workspace: suspended })
                  : locked
                    ? t('Drop anyway: it waits until there’s room.')
                    : view.kind === 'folder' && !shutHere
                      ? t('Into {folder}; you can still pick another.', { folder: crumbs(view.id) })
                      : t('Into the library; you can still pick a project.')}
              </p>
            </div>
          </div>
        )}
        {dropped && info && (
          <Suspense fallback={null}>
            <UploadDialog
              files={dropped}
              folders={openFolders}
              defaultFolder={view.kind === 'folder' && !shutHere ? view.id : null}
              maxBytes={info.features.upload_max_bytes}
              existing={uploaded}
              onClose={() => setDropped(null)}
            />
          </Suspense>
        )}
        {sharingFolder && <LazyShareModal folder={sharingFolder} onClose={() => setSharingFolder(null)} />}
        {adding && Add && (
          <Add.default
            onClose={() => setAdding(false)}
            onUpload={() => {
              setAdding(false);
              upload();
            }}
            home={info?.home}
            folders={openFolders}
            defaultFolder={view.kind === 'folder' && !shutHere ? view.id : undefined}
            recent={recentDirs}
          />
        )}
        <MoveAsks />
        {roPop && Billing && <Billing.ReadOnlyPop onClose={() => setRoPop(false)} />}
        {Billing && <Billing.LinkOpenMoment />}
      </div>
    </CardKitContext>
  );
}

/** A move's questions that aren't on a card (its Confirm; the sentence where the card isn't on the board). They come
 * from the move's code, which is here once a move asks. */
function MoveAsks() {
  const { ask } = useMoveState();
  const M = moveCode.ready;
  return ask && M ? <M.MoveAsks /> : null;
}
