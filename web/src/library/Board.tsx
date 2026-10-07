// Where everything stands, as a board inside the library: four lanes (needs you · being fixed · approved · final).
// The lane is the stage, so a card doesn't repeat it: poster, name, one quiet line on what happened last, and the
// next step as a small action when it's yours. The board fills the page under the toolbar and each lane scrolls its
// own cards under a head that stays (the page itself doesn't scroll); lanes keep a readable width and the board scrolls
// sideways instead of squeezing them. Phones stack the lanes and scroll the page.
//
// Cards move between lanes: dragged (library/boardDrag.ts, loaded on the first press on a card), with ⌥← / ⌥→ on a
// focused one, or with "Move to" in its menu (phones). A move is the sign-off that puts the video there
// (library/moves.ts, library/moving.tsx). While a card is dragged, the lanes it can't go to dim and the one under it
// lights up with the card's place in it — the board's own order, never a manual one —; under the carried card a label
// says what dropping does.

import { useQueryClient } from '@tanstack/react-query';
import {
  type KeyboardEvent,
  memo,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { LANES } from '../../../lib/stage.ts';
import type { NextStep, StageInfo } from '../../../lib/types.ts';
import { cancelPrefetch, prefetchVideo } from '../api/prefetch.ts';
import { spriteUrl } from '../api/sprite.ts';
import type { VideoSummary } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { useLang } from '../i18n/T.tsx';
import { cardClick, onActivate } from '../lib/a11y.ts';
import { useScrollEdges } from '../lib/hooks.ts';
import { loader, useLoaded, usePainted } from '../lib/lazy.ts';
import { go } from '../lib/nav.ts';
import { useWindowed, WINDOW_FROM } from '../lib/windowing.ts';
import { cardRun, RunEdge, RunLine } from '../sessions/RunLine.tsx';
import { isOpen } from '../sessions/runState.ts';
import { laneLabel, nextLabel } from '../status/stageText.ts';
import { LANE_SHAPE } from '../ui/glyphs.ts';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { ContextMenu, IconButton, Menu } from '../ui/primitives.tsx';
import { SkLine } from '../ui/Skeleton.tsx';
import type { DragHost, Press } from './boardDrag.ts';
import { ShareState } from './marks.tsx';
import { type LaneId, laneOf, lanes } from './model.ts';
import { type Ask, moveCode, useMoveState } from './moved.ts';
import { type Move, movesOf, nextMove } from './moves.ts';
import { Poster, posterUrl } from './Poster.tsx';
import { UnsentMark } from './unsent.tsx';
import { openVideo, useCardKit, useVideoMenu } from './useVideoMenu.tsx';

/** What happened last, in a few words: the lane already says the stage. */
export function boardLine(s: StageInfo): string {
  switch (s.stage) {
    case 'to_review':
      if (s.approval_stale) return t('V{w} approved · V{v} new', { v: s.v, w: s.approval_stale.v });
      return s.v > 1 ? t('V{v} new', { v: s.v }) : t('First version');
    case 'changes':
      return s.open ? t('{n} note open|{n} notes open', { n: s.open }) : t('Changes requested');
    case 'in_progress':
      return t('An agent is on it');
    case 'check_fixes':
      return t('{n} fix to check|{n} fixes to check', { n: s.to_verify });
    case 'team_approved':
      return t('Approved V{v}', { v: s.team?.v ?? s.v });
    case 'with_client':
      return t('Out for review');
    case 'client_approved':
      return t('Approved V{v} via link', { v: s.client?.v ?? s.v });
    case 'final':
      return s.final_superseded ? t('Final V{v} · V{w} new', { v: s.final?.v ?? s.v, w: s.final_superseded }) : t('Final V{v}', { v: s.final?.v ?? s.v });
  }
}

/** What agents are doing now (sessions/Live.tsx), for the cards: loaded after the first paint, like the sidebar's. */
const agentNow = loader(() => import('../sessions/Live.tsx'));

/** Before that arrives: the working line without a step, in the same box. */
function OnIt({ agent }: { agent: string | null }) {
  const words = agent ? t('is working on it') : t('An agent is working on it');
  return (
    <span className="bcard-agent" data-testid="bcard-agent">
      <KeyGlyph shape="ease" className="nav-kg live" />
      <span className="bcard-text">
        {agent && <b>{agent}</b>} {words}
      </span>
    </span>
  );
}

/** What happened, when the card's button already says what to do about it ("Fixed in V26" over "Check 2 fixes"). */
const happened = (s: StageInfo): string => (s.stage === 'check_fixes' ? t('Fixed in V{v}', { v: s.v }) : boardLine(s));

/** Next steps that are the viewer's to take (the rest — an agent working, the client deciding — is the line above). */
const YOURS: NextStep['kind'][] = ['review', 'verify', 'send', 'finalize', 'carry', 'reopen'];

interface CardProps {
  v: VideoSummary;
  where: string | null;
  home?: string | null;
  folders: string[];
  /** Being dragged: it waits, faded, in its place while its copy follows the pointer. */
  lifted?: boolean;
  /** Just moved here: it settles in. */
  landed?: boolean;
  /** Its move asks for a sentence for the agent, here on the card. */
  ask?: Ask | null;
}

// A press that may become a drag (boardDrag.ts): called off when a card's menu opens instead (a long press on touch).
let pressOff: (() => void) | null = null;
const cancelPress = () => {
  pressOff?.();
  pressOff = null;
};

// The board mounted now. A press outlives a remount of the board (the library screen is swapped for its loaded self
// right after the page opens, which is when the first press loads the drag code): it talks to whichever board is
// mounted, through `liveHost`, and is only called off when no board comes back.
const liveHost: { current: DragHost | null } = { current: null };
const proxyHost = (first: HTMLElement): DragHost => ({
  get board() {
    return liveHost.current?.board ?? first;
  },
  begin: (slug, card) => liveHost.current?.begin(slug, card) ?? null,
  over: (lane) => liveHost.current?.over(lane),
  drop: (lane) => liveHost.current?.drop(lane),
  cancel: () => liveHost.current?.cancel(),
  lock: (on) => liveHost.current?.lock(on),
});

const BoardCard = memo(function BoardCard({ v, where, home, folders, lifted, landed, ask }: CardProps) {
  useLang(); // memo'd: renders again on a language switch by itself
  const [menuOpen, setMenuOpen] = useState(false);
  const qc = useQueryClient();
  const { items, dialogs } = useVideoMenu(v, { home, folders });
  const next = v.stage.next;
  // the step is the viewer's: the button says what to do, the line above it what happened (never the same words twice)
  const yours = YOURS.includes(next.kind);
  // an agent at work on the video: who, and what it is doing now (the live monitor, loaded after the first paint)
  const working = v.stage.stage === 'in_progress';
  const Now = useLoaded(agentNow, usePainted());
  // the agent's work on it, when the server keeps it (lib/types.ts Run): its line, its edge, and Answer when it asks
  const run = cardRun(v);
  // a question or options waiting: Answer opens the video on it (a permission is said where it can be explained)
  const asks = run?.state === 'needs_you' && run.needs?.kind !== 'permission' && run.needs?.kind !== 'sign_in';
  const line = <span className="bcard-text">{yours ? happened(v.stage) : boardLine(v.stage)}</span>;
  const share = v.stage.share && (v.stage.stage === 'team_approved' || v.stage.stage === 'with_client');
  const menu = (open: boolean) => {
    setMenuOpen(open);
    if (!open) return;
    cancelPress();
    // its "Move to" is a click away: the move's code comes along
    moveCode.load().catch(() => {});
  };
  return (
    <ContextMenu items={items} onOpenChange={menu}>
      {/* biome-ignore lint/a11y/useSemanticElements: the card holds its own menu button */}
      <div
        className={`bcard ${menuOpen ? 'menu-open' : ''} ${lifted ? 'lifted' : ''} ${landed ? 'landed' : ''}`}
        role="link"
        tabIndex={0}
        aria-label={t('Review {name}', { name: v.name })}
        aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
        data-slug={v.slug}
        data-stage={v.stage.stage}
        data-nav
        onClick={cardClick((e) => openVideo(v.slug, e), '.bcard-menu, .bcard-next, .bcard-ask')}
        onKeyDown={onActivate(() => openVideo(v.slug))}
        onPointerEnter={() => prefetchVideo(qc, v.slug)}
        onPointerLeave={cancelPrefetch}
        onFocus={() => prefetchVideo(qc, v.slug, { now: true })}
      >
        <Poster
          src={v.hash ? posterUrl(v) : null}
          sprite={v.hash ? spriteUrl(v.slug, v.hash) : null}
          slug={v.slug}
          width={v.width}
          height={v.height}
          frame={16 / 10}
          className="bthumb"
        >
          <RunEdge run={run} />
        </Poster>
        <div className="bcard-row">
          <b className="bcard-name" title={v.name}>
            {v.name}
          </b>
          <UnsentMark slug={v.slug} />
          {v.sample && <span className="sample-mark">{t('Sample')}</span>}
          <div className="bcard-menu">
            <Menu
              onOpenChange={menu}
              trigger={<IconButton className="btn ghost sm icon-only" label={t('Actions for {name}', { name: v.name })} icon="more" />}
              items={items}
            />
          </div>
        </div>
        {where && (
          <span className="bcard-where" title={where}>
            {where}
          </span>
        )}
        <div className="bcard-line" data-testid="status-pill" data-stage={v.stage.stage}>
          {run ? (
            <RunLine run={run} say={Now?.sayWords} />
          ) : share ? (
            <ShareState stage={v.stage} />
          ) : Now ? (
            <Now.CardAgentLine slug={v.slug} agent={v.session?.name ?? null} working={working} watch={working || v.stage.stage === 'changes'}>
              {line}
            </Now.CardAgentLine>
          ) : working ? (
            <OnIt agent={v.session?.name ?? null} />
          ) : (
            line
          )}
        </div>
        {ask && moveCode.ready ? (
          <moveCode.ready.MoveNote a={ask} />
        ) : asks ? (
          <button
            type="button"
            className="btn sm bcard-next"
            onClick={() => go(v.slug, run?.needs?.note ? `c=${encodeURIComponent(run.needs.note)}` : undefined)}
            data-testid="bcard-answer"
          >
            {t('Answer')}
          </button>
        ) : (
          yours && (
            <button type="button" className="btn sm bcard-next" onClick={() => openVideo(v.slug)}>
              {nextLabel(next)}
            </button>
          )
        )}
        {dialogs}
      </div>
    </ContextMenu>
  );
});

interface BoardProps {
  videos: VideoSummary[];
  where: (v: VideoSummary) => string | null;
  home?: string | null;
  folders: string[];
}

/** Lanes side by side (not the phones' stack): each lane then windows its cards on its own (lib/windowing.ts), and
 * cards are dragged between them (phones move them from their menu). The query is library.css's standing board. */
const besideQuery = '(min-width: 640px) and (min-height: 481px), (min-width: 640px) and (hover: hover), (min-width: 640px) and (pointer: fine)';
const lanesBeside = () => typeof window !== 'undefined' && window.matchMedia(besideQuery).matches;

const dragCode = loader(() => import('./boardDrag.ts'));

/** A card on its way to another lane. */
interface Drag {
  slug: string;
  from: LaneId;
  /** Where it may go, and what each move does. */
  moves: Map<LaneId, Move>;
  /** The lane that would take it now. */
  over: LaneId | null;
  /** Its height, for its place in the lane that would take it. */
  height: number;
}

interface Slot {
  index: number;
  height: number;
  lane: string;
}

export function Board({ videos, where, home, folders }: BoardProps) {
  const long = videos.length > WINDOW_FROM;
  const beside = lanesBeside();
  const kit = useCardKit();
  const { ask, landed } = useMoveState();
  // lanes wider than the page scroll sideways: a soft edge only where there is more to see (none when all fit)
  const [scrollRef, edges] = useScrollEdges<HTMLDivElement>('x');
  const boardEl = useRef<HTMLDivElement | null>(null);
  const setBoard = useCallback(
    (el: HTMLDivElement | null) => {
      boardEl.current = el;
      scrollRef(el);
    },
    [scrollRef],
  );
  const [drag, setDrag] = useState<Drag | null>(null);
  // what a drag's callbacks read: the drag outlives renders of the board under it
  const now = useRef({ videos, kit, drag });
  now.current = { videos, kit, drag };
  const locked = useRef(false);

  const host = useMemo<Omit<DragHost, 'board'>>(
    () => ({
      begin: (slug, card) => {
        const v = now.current.videos.find((x) => x.slug === slug);
        if (!v) return null;
        const moves = new Map(movesOf(v, now.current.kit.can).map((m) => [m.to, m]));
        setDrag({ slug, from: laneOf(v.stage.stage), moves, over: null, height: card.offsetHeight });
        return moves as Map<string, Move>;
      },
      over: (lane) => setDrag((d) => (d && d.over !== lane ? { ...d, over: lane as LaneId | null } : d)),
      drop: (lane) => {
        const d = now.current.drag;
        setDrag(null);
        const v = d && now.current.videos.find((x) => x.slug === d.slug);
        if (v) now.current.kit.move(v, lane as LaneId, { inPlace: true });
      },
      cancel: () => setDrag(null),
      lock: (on) => {
        locked.current = on;
      },
    }),
    [],
  );

  // A press on a card (not on its buttons) may become a drag: its code is asked for now and takes over when it arrives,
  // unless the pointer is up by then (a click, which opens the video as ever).
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || !lanesBeside()) return;
    const target = e.target as Element;
    const card = target.closest<HTMLElement>('.bcard[data-slug]');
    if (!card || !e.currentTarget.contains(card) || target.closest('button, a, input, textarea, select, .bcard-ask')) return;
    // a mouse drag doesn't select the card's words on the way
    if (e.pointerType === 'mouse') e.preventDefault();
    cancelPress();
    moveCode.load().catch(() => {});
    const press: Press = { x: e.clientX, y: e.clientY, pointerId: e.pointerId, pointerType: e.pointerType, card, slug: card.dataset.slug as string };
    let up = false;
    const release = (ev: PointerEvent) => {
      if (ev.pointerId === press.pointerId) up = true;
    };
    const stop = () => {
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
    };
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    dragCode.load().then((m) => {
      stop();
      // the board may have been remounted while the code came: the live one takes the press
      const board = liveHost.current?.board ?? boardEl.current;
      if (up || !board) return;
      pressOff = m.startPress(proxyHost(board), press);
    }, stop);
  };

  // A touch drag holds the lanes still: the browser waits for an answer before it scrolls only for listeners that
  // were there when the touch began.
  useEffect(() => {
    const el = boardEl.current;
    if (!el || !navigator.maxTouchPoints) return;
    const hold = (e: TouchEvent) => {
      if (locked.current) e.preventDefault();
    };
    el.addEventListener('touchmove', hold, { passive: false });
    return () => el.removeEventListener('touchmove', hold);
  }, []);
  // this board is the live one while it is mounted; gone without another taking its place, a press is called off
  useEffect(() => {
    const me = boardEl.current ? { ...host, board: boardEl.current } : null;
    liveHost.current = me;
    return () => {
      if (liveHost.current === me) liveHost.current = null;
      requestAnimationFrame(() => {
        if (!liveHost.current) cancelPress();
      });
    };
  }, [host]);

  // ⌥← / ⌥→ on a card: to the nearest lane it may go to on that side.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    const card = e.target as HTMLElement;
    if (!card.matches?.('.bcard[data-slug]')) return;
    const v = videos.find((x) => x.slug === card.dataset.slug);
    if (!v) return;
    e.preventDefault();
    const m = nextMove(v, e.key === 'ArrowLeft' ? -1 : 1, kit.can);
    if (m) kit.move(v, m.to, { inPlace: true, focus: true });
  };

  const at = drag ? videos.findIndex((x) => x.slug === drag.slug) : -1;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a press on a card inside may become a drag; ⌥← / ⌥→ move a focused card
    <div className={`board ${edges} ${drag ? 'dragging' : ''}`} ref={setBoard} data-testid="library-board" onPointerDown={onPointerDown} onKeyDown={onKeyDown}>
      {lanes(videos).map((l) => {
        const m = drag?.moves.get(l.id);
        const state = !drag ? undefined : l.id === drag.from ? 'from' : !m ? 'no' : drag.over === l.id ? 'lit' : 'ok';
        // its place: the board's order puts it among this lane's cards where it would stand
        const slot: Slot | null =
          drag && m && state === 'lit'
            ? {
                index: videos.slice(0, Math.max(0, at)).filter((x) => laneOf(x.stage.stage) === l.id).length,
                height: drag.height,
                lane: l.id,
              }
            : null;
        const card = (v: VideoSummary) => (
          <BoardCard
            key={v.slug}
            v={v}
            where={where(v)}
            home={home}
            folders={folders}
            lifted={drag?.slug === v.slug}
            landed={landed === v.slug}
            ask={ask?.slug === v.slug && ask.kind === 'note' && ask.inPlace ? ask : null}
          />
        );
        // Being fixed says, quietly, how many agents are at it now (needs-you and gone-quiet ones aren't working)
        const agents = new Set(
          l.id === 'fixing'
            ? l.videos.flatMap((x) => (x.run && isOpen(x.run) && x.run.state !== 'needs_you' && x.run.state !== 'lost' ? [x.run.agent.name] : []))
            : [],
        ).size;
        return (
          <Lane
            key={l.id}
            id={l.id}
            label={`${laneLabel(l.id)}: ${l.videos.length}`}
            count={l.videos.length}
            note={agents ? t('{n} agent working|{n} agents working', { n: agents }) : null}
            drop={state}
          >
            {l.videos.length ? (
              <LaneCards videos={l.videos} long={long} beside={beside} slot={slot} card={card} />
            ) : (
              <div className="lane-cards">{slot ? <DropSlot {...slot} /> : <LaneEmpty id={l.id} />}</div>
            )}
          </Lane>
        );
      })}
    </div>
  );
}

/** A lane: its head, then its cards in a box of their own that scrolls under it (a soft edge where there is more).
 * While a card is dragged, `drop` says what the lane is to it: `from` its own, `lit` the one that would take it, `ok`
 * one that could, `no` one it can't go to. */
function Lane({
  id,
  label,
  count,
  note,
  drop,
  children,
}: {
  id: string;
  label?: string;
  count: ReactNode;
  /** A quiet word beside the count ("2 agents working"). */
  note?: string | null;
  drop?: string;
  children: ReactNode;
}) {
  const [scrollRef, edges] = useScrollEdges<HTMLDivElement>('y');
  return (
    <section className="lane" data-lane={id} data-drop={drop} aria-label={label}>
      <h2 className="lane-head">
        <KeyGlyph shape={LANE_SHAPE[id] ?? 'outline'} />
        {laneLabel(id)}
        {note && (
          <span className="lane-note" data-testid="lane-note">
            {note}
          </span>
        )}
        <span className="lane-count">{count}</span>
      </h2>
      <div ref={scrollRef} className={`lane-scroll ${edges}`} data-testid="lane-scroll">
        {children}
      </div>
    </section>
  );
}

const smooth = () => !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Where the dragged card would land in the lit lane: its place with the lane's keyframe on a track (an empty lane's
 * slot, set). In a long lane it comes into view. What dropping does is said under the lifted card (boardDrag.ts). */
function DropSlot({ lane, height }: Slot) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: smooth() ? 'smooth' : 'auto' });
  }, []);
  return (
    <div ref={ref} className="bcard-slot" style={{ height }} data-testid="drop-slot" data-lane={lane} aria-hidden="true">
      <span className="bcard-slot-track">
        <KeyGlyph shape={LANE_SHAPE[lane] ?? 'outline'} pop />
      </span>
    </div>
  );
}

/** What lands in a lane, said while it is empty. */
function laneEmpty(id: string): [title: string, body: string] {
  switch (id) {
    case 'needs_you':
      return [t('Nothing to review'), t('New versions and fixes to check land here.')];
    case 'fixing':
      return [t('Nothing being fixed'), t('Notes an agent is working on land here.')];
    case 'approved':
      return [t('Nothing approved yet'), t('Approved videos wait here.')];
    default:
      return [t('No finals yet'), t('Videos you mark final land here.')];
  }
}

/** An empty lane keeps a card's place: the poster's slot with the lane's keyframe in it, then what lands here. */
function LaneEmpty({ id }: { id: string }) {
  const [title, body] = laneEmpty(id);
  return (
    <div className="lane-empty" data-testid="lane-empty">
      <div className="lane-empty-slot" aria-hidden="true">
        <KeyGlyph shape={LANE_SHAPE[id] ?? 'outline'} />
      </div>
      <p className="lane-empty-title">{title}</p>
      <p className="lane-empty-body">{body}</p>
    </div>
  );
}

/** A card's height before one has been measured. */
const CARD_GUESS = 240;

// A long lane renders the cards near the view (lib/windowing.ts). Cards differ in height (a folder line, a next step),
// so each one's height is remembered by video once it has been on screen; the others count as the average. A dragged
// card's place (`slot`) stands among them; when it is beyond the rendered cards the lane scrolls to it.
function LaneCards({
  videos,
  long,
  beside,
  slot,
  card,
}: {
  videos: VideoSummary[];
  long: boolean;
  beside: boolean;
  slot: Slot | null;
  card: (v: VideoSummary) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const [measured, setMeasured] = useState({ version: 0, gap: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!long || !el) return;
    let changed = false;
    for (const c of el.querySelectorAll<HTMLElement>(':scope > [data-slug]')) {
      const slug = c.dataset.slug as string;
      if (heights.current.get(slug) !== c.offsetHeight) {
        heights.current.set(slug, c.offsetHeight);
        changed = true;
      }
    }
    const gap = Number.parseFloat(getComputedStyle(el).rowGap) || 0;
    if (changed || gap !== measured.gap) setMeasured((m) => ({ version: m.version + 1, gap }));
  });
  // A wider lane has taller posters: everything is measured again.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!long || !el) return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      heights.current.clear();
      setMeasured((m) => ({ ...m, version: m.version + 1 }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [long]);
  // Row positions follow the cards (another filter, another order) and what was measured of them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new identity whenever either changes is the point
  const version = useMemo(() => ({}), [videos, measured.version]);
  const known = [...heights.current.values()];
  const average = known.length ? known.reduce((a, b) => a + b, 0) / known.length : CARD_GUESS;
  const height = (i: number) => heights.current.get((videos[i] as VideoSummary).slug) ?? average;
  const w = useWindowed(ref, {
    enabled: long,
    rows: videos.length,
    height,
    gap: measured.gap,
    version,
    beside,
  });
  const first = w.on ? w.first : 0;
  const shown = w.on ? videos.slice(w.first, w.last + 1) : videos;
  const inWindow = !!slot && slot.index >= first && slot.index <= first + shown.length;
  // a place beyond the rendered cards: the lane scrolls to about where it is, and the window follows
  const far = slot && !inWindow ? slot.index : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the place goes beyond the window (the heights it reads change all the time)
  useLayoutEffect(() => {
    const box = far !== null ? ref.current?.closest<HTMLElement>('.lane-scroll') : null;
    if (!box || far === null) return;
    let top = 0;
    for (let i = 0; i < far; i++) top += height(i) + measured.gap;
    box.scrollTop = Math.max(0, top - box.clientHeight / 3);
  }, [far]);
  const items = shown.map(card);
  if (slot && inWindow) items.splice(slot.index - first, 0, <DropSlot key="drop-slot" {...slot} />);
  return (
    <div ref={ref} className="lane-cards" style={w.on ? { paddingTop: w.before, paddingBottom: w.after } : undefined}>
      {items}
    </div>
  );
}

/** The board while the library loads: the four lanes with their real heads, a couple of cards of the cards' shape. */
export function BoardPending() {
  return (
    <div className="board" aria-hidden="true">
      {LANES.map((l) => (
        <Lane key={l.id} id={l.id} count={<SkLine w="1.2em" />}>
          <div className="lane-cards">
            {['80%', '64%'].map((w) => (
              <div key={w} className="bcard pending">
                <div className="sk bthumb" style={{ aspectRatio: 16 / 10 }} />
                <div className="bcard-row">
                  <b className="bcard-name">
                    <SkLine w={w} />
                  </b>
                </div>
                <div className="bcard-line">
                  <SkLine w="50%" />
                </div>
              </div>
            ))}
          </div>
        </Lane>
      ))}
    </div>
  );
}
