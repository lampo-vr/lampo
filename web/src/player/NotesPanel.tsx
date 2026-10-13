// The notes sidebar, in Linear's lines: its head ("Notes 7", then a filter, ⋯ with the other views and review mode,
// Record, + Note), the agent's line under it (RunStrip.tsx), and the notes grouped by where they stand — what needs you
// (an agent's questions), the fixes to check (its header is the panel's door to check mode), the open ones, and the done
// ones folded at the end (noteGroups.ts). A row each, the selected one open as its card (CommentCard.tsx). While playing,
// the note at the playhead is marked and the list follows it, unless the person is scrolling or typing. While the review
// loads (`counts: null`) it is the same panel: the head is real, the rows wait as placeholders of the same shape.

import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { isQuestion } from '../../../lib/time.ts';
import type { FrameRange, PlacedComment, RunPlanItem } from '../api/types.ts';
import { perLang, t } from '../i18n/index.ts';
import { T } from '../i18n/T.tsx';
import { tagLabel } from '../i18n/terms.ts';
import { useMeasuredWindow, WINDOW_FROM } from '../lib/windowing.ts';
import type { EmptyArtName } from '../ui/emptyArt.tsx';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { IconButton, Kbd, Menu, type MenuEntry, Tip } from '../ui/primitives.tsx';
import { Skeleton, SkeletonRegion, SkLine } from '../ui/Skeleton.tsx';
import { Button, EmptyState } from '../ui/system.tsx';
import { asksWithPicks } from './AskCard.tsx';
import { CommentCard, type RangePlay } from './CommentCard.tsx';
import type { FrameStore } from './frameStore.ts';
import type { GroupId } from './noteGroups.ts';
import { noteAt } from './noteRows.ts';
import { NO_FIND, type TranscriptFind, TranscriptMeta, TranscriptTools, TranscriptView, type TranscriptViewProps } from './Transcript.tsx';

/** `active`: every note in its group (a phone: what needs you and what is open); `check`: the fixes waiting for a check. */
export type Filter = 'active' | 'questions' | 'mine' | 'closed' | 'all' | 'check';
/** The panel shows the notes, what is said in the render (Transcript.tsx), or the agent's work (AgentView.tsx). */
export type PanelView = 'notes' | 'transcript' | 'agent';
const VIEWS = perLang((): { id: PanelView; label: string }[] => [
  { id: 'notes', label: t('Notes') },
  { id: 'transcript', label: t('Transcript') },
  { id: 'agent', label: t('Agent') },
]);
/** A note the plan holds a line for while the runs are on their way (the brief says work goes on). */
export const PLAN_PENDING: RunPlanItem = { id: '', state: 'todo' };

/** Phones: the notes live in a bottom sheet that peeks (header only), covers half the screen, or most of it. */
export type SheetState = 'peek' | 'half' | 'full';
export interface SheetProps {
  state: SheetState;
  setState: (s: SheetState) => void;
  /** The press-and-hold voice button (walkie-talkie). */
  mic?: ReactNode;
}
const SHEET_ORDER: SheetState[] = ['peek', 'half', 'full'];

/** open = feedback to act on (ideas and questions are not work items); the rest are the lengths of the lists (`current`:
 * what needs the person and what is open, a phone's default; `check`: the fixes waiting for a check). */
type Counts = {
  open: number;
  fixed: number;
  active: number;
  mine: number;
  closed: number;
  all: number;
  questions: number;
  check: number;
  current: number;
};

/** What a phone's peeking sheet says it holds: what it shows when opened (what needs you and what is open), else how
 * many notes there are, else that there are none. */
const peekCount = (n: Counts): string => (n.current ? t('{n} open', { n: n.current }) : n.all ? t('{n} note|{n} notes', { n: n.all }) : t('No notes yet'));

const FILTERS = perLang((): { id: Exclude<Filter, 'active'>; label: string; count: keyof Counts }[] => [
  { id: 'questions', label: t('Questions'), count: 'questions' },
  { id: 'mine', label: t('Mine'), count: 'mine' },
  { id: 'closed', label: t('Closed'), count: 'closed' },
  { id: 'all', label: t('All'), count: 'all' },
]);
/** A phone's selector (`viewPick`): which notes the sheet shows, then the filter menu's lists. */
const PHONE_VIEWS = perLang((): { id: Filter; label: string; count: keyof Counts }[] => [
  { id: 'active', label: t('Open'), count: 'current' },
  { id: 'check', label: t('To check'), count: 'check' },
  { id: 'closed', label: t('Done'), count: 'closed' },
  { id: 'all', label: t('All'), count: 'all' },
  { id: 'mine', label: t('Mine'), count: 'mine' },
  { id: 'questions', label: t('Questions'), count: 'questions' },
]);
const GROUP_LABEL = perLang((): Record<GroupId, string> => ({ needs: t('Needs you'), check: t('To check'), open: t('Open'), done: t('Done') }));
const EMPTY = perLang(
  (): Record<Filter, { art: EmptyArtName; title: string }> => ({
    active: { art: 'clear', title: t('All clear') },
    questions: { art: 'clear', title: t('No questions') },
    mine: { art: 'clear', title: t('Nothing open from you') },
    closed: { art: 'list', title: t('Nothing closed yet') },
    all: { art: 'note', title: t('No notes yet') },
    check: { art: 'clear', title: t('No fixes to check') },
  }),
);

interface NotesPanelProps {
  slug: string;
  /** The video's file name (where "Reference a frame…" starts). */
  videoName: string;
  v: number;
  latestV: number;
  frame: number;
  /** The frame on screen while playing (frameStore.ts): the panel renders only when the notes under it change. */
  live?: FrameStore;
  filter: Filter;
  setFilter: (f: Filter) => void;
  /** null: the review is still loading. */
  counts: Counts | null;
  list: PlacedComment[];
  selected: string | null;
  /** A note picked on purpose (the list, the timeline, N, a link) rather than reached by the playhead: on a phone the
   * sheet brings its card into view whole. `n` tells two picks of one note apart. */
  picked?: { id: string; n: number } | null;
  onSelect: (c: PlacedComment) => void;
  /** Playing: the note at the playhead stays marked a moment past its frame and the list follows it. */
  playing?: boolean;
  /** The tags of the notes in the chosen filter with their counts (noteRows.ts tagCounts), and the one picked. */
  tags?: [string, number][];
  tag?: string | null;
  setTag?: (tag: string | null) => void;
  onLightbox: (src: string) => void;
  /** Range notes: the video's frame rate (for their duration), playing one, and the range on repeat right now. */
  fps?: number;
  onPlayRange?: (c: PlacedComment, how: RangePlay) => void;
  rangeLoop?: FrameRange | null;
  canCompose: boolean;
  /** Notes not sent yet wait above the list, their Send the raised action: + Note steps down (one primary at a time). */
  quietNew?: boolean;
  onCompose: () => void;
  verifyCount: number;
  /** Open notes from an earlier version where the version on screen changed (its diff): a hint on their rows. */
  changedHere?: ReadonlySet<string>;
  /** An archived project's video (lib/archived.ts): its notes are read, nothing new is written. */
  readOnly?: boolean;
  verifying: boolean;
  onVerify: () => void;
  /** Review mode: start (or leave) stepping through the open notes. */
  onReview: () => void;
  reviewing: boolean;
  /** The Auto-check chip (AutoCheck.tsx), in the head when it found something. */
  autoCheck: ReactNode;
  composer: ReactNode;
  /** The Record button (recorded feedback), beside + Note. */
  record?: ReactNode;
  /** Recordings being heard or waiting to be reviewed: their drafts, above the notes. */
  recording?: ReactNode;
  /** Phones: bottom sheet behaviour; absent on tablets and desktops (the classic side panel). */
  sheet?: SheetProps;
  /** Above the list (phones: the verify panel, which has no room over the picture). */
  top?: ReactNode;
  view: PanelView;
  setView: (v: PanelView) => void;
  /** The run strip (RunStrip.tsx): under the panel's head, in a slot that is there from the first paint. Phones show it
   * above the dock instead. */
  strip?: ReactNode;
  /** The Agent tab, where the video has an agent; `live` while it works (the tab's hourglass turns). */
  agentTab?: { live: boolean } | null;
  /** The Agent view, once its code is here. */
  agentView?: ReactNode;
  /** The work's plan by note (its line under each note row), the agent's name, and whether open notes keep a line's
   * room while the runs arrive. */
  plans?: Map<string, RunPlanItem>;
  planName?: string;
  planPending?: boolean;
  /** The list's groups: the first row of each (its header goes above it), how many each holds, and whether the done ones
   * are shown (folded at the end otherwise). */
  firsts?: Map<string, GroupId>;
  groupCounts?: Record<GroupId, number>;
  doneOpen?: boolean;
  setDoneOpen?: (open: boolean) => void;
  /** Auto-check found something (or couldn't run): its chip in the head; with nothing to say it stays away. */
  autoCheckFound?: boolean;
  /** The "To check" header's Check is the view's raised door (the top bar doesn't offer it). */
  checkPrimary?: boolean;
  /** More than one person wrote the notes: each row names its author on its second line. */
  showAuthor?: boolean;
  /** The video has speech, or a transcript is on its way or there: the head offers the Transcript beside the Notes. */
  transcriptTab?: boolean;
  /** What the transcript tab needs from the player. */
  transcript: Pick<TranscriptViewProps, 'base' | 'onSeek' | 'onPlay' | 'onChangeWords' | 'onRerun' | 'edits'>;
}

// Drag the handle to resize the sheet; on release it snaps to the nearest position (a flick moves one step). The
// positions are mobile.css's: half 44 % of the screen, full all but 190 px and the top inset. While it moves, the
// picture keeps its minimum (mobile.css: the sheet is held to its grid row), as it does with the sheet half open.
const full = () => {
  const bar = document.querySelector('.phone-player > .topbar');
  return window.innerHeight - 190 - (bar ? Number.parseFloat(getComputedStyle(bar).paddingTop) || 0 : 0);
};
const snaps = () => ({ peek: 0, half: window.innerHeight * 0.44, full: full() }) as Record<SheetState, number>;

function useSheetDrag(sheet: SheetProps | undefined) {
  const drag = useRef<{ y: number; h: number; id: number; lastY: number; lastT: number; v: number } | null>(null);
  const [live, setLive] = useState<number | null>(null);
  // a drag ends with its release; the click that may follow it is not a tap
  const dragged = useRef(false);
  if (!sheet) return { live: null, handle: {} };
  const handle = {
    // A tap opens from peek, otherwise closes — on the click, not the release: the sheet's move puts something else under
    // the finger (the agent's line, the dock), and a touch's click is aimed where the finger was once the release has
    // changed the page, so it opened the Agent view as the sheet closed. The keyboard's Enter and Space come this way too.
    onClick: () => {
      if (dragged.current) {
        dragged.current = false;
        return;
      }
      sheet.setState(sheet.state === 'peek' ? 'half' : 'peek');
    },
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => {
      const el = e.currentTarget.parentElement;
      if (!el) return;
      dragged.current = false;
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { y: e.clientY, h: el.getBoundingClientRect().height, id: e.pointerId, lastY: e.clientY, lastT: performance.now(), v: 0 };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLButtonElement>) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      const h = Math.max(56, Math.min(full(), d.h + (d.y - e.clientY)));
      if (Math.abs(d.y - e.clientY) > 4) setLive(h);
      // velocity of the last movement (px per ms, up = positive): a flick, not the whole drag
      const now = performance.now();
      if (now > d.lastT) d.v = (d.lastY - e.clientY) / (now - d.lastT);
      d.lastY = e.clientY;
      d.lastT = now;
    },
    onPointerUp: (e: ReactPointerEvent<HTMLButtonElement>) => {
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      const moved = d.y - e.clientY;
      setLive(null);
      // a tap: its click does it
      if (Math.abs(moved) < 6) return;
      dragged.current = true;
      const v = performance.now() - d.lastT < 80 ? d.v : 0;
      const i = SHEET_ORDER.indexOf(sheet.state);
      if (Math.abs(v) > 0.6) return sheet.setState(SHEET_ORDER[Math.max(0, Math.min(2, i + (v > 0 ? 1 : -1)))]);
      const h = d.h + moved;
      const s = snaps();
      const best = SHEET_ORDER.reduce((a, b) => (Math.abs(s[b] - h) < Math.abs(s[a] - h) ? b : a), 'peek' as SheetState);
      sheet.setState(best);
    },
    onPointerCancel: () => {
      drag.current = null;
      setLive(null);
    },
  };
  return { live, handle };
}

const still = () => () => {};

/** A row's height before one has been measured (a one-line row; a group header or the open card are measured). */
const NOTE_GUESS = 34;
const noteKey = (c: PlacedComment) => c.id;

// A video with hundreds of notes renders the ones near the view (lib/windowing.ts); a shorter list renders whole.
// `reveal`: the row that must be there (the selected one, or the one the playhead is at while the list follows it).
function NoteRows({ list, note, reveal }: { list: PlacedComment[]; note: (c: PlacedComment) => ReactNode; reveal: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const long = list.length > WINDOW_FROM;
  const at = reveal ? list.findIndex((c) => c.id === reveal) : -1;
  const w = useMeasuredWindow(ref, list, noteKey, { enabled: long, guess: NOTE_GUESS, reveal: at >= 0 ? at : null });
  if (!long) return <div className="note-list">{list.map(note)}</div>;
  return (
    <div ref={ref} className="note-list note-rows" style={{ paddingTop: w.before, paddingBottom: w.after }} data-windowed>
      {list.slice(w.first, w.last + 1).map(note)}
    </div>
  );
}

/** The rows while the notes load: a group's header and rows of the loaded anatomy, so nothing moves when they arrive. */
function NoteRowsPending() {
  const row = (w: string) => (
    <div key={w} className="note note-row pending">
      <div className="nr nr-stack">
        <span className="nr-tc">
          <SkLine w="5.5em" />
        </span>
        <span className="nr-kg">
          <Skeleton w={10} h={10} r={2} />
        </span>
        <span className="nr-text">
          <SkLine w={w} />
        </span>
      </div>
    </div>
  );
  const [first, ...rest] = ['72%', '54%', '80%', '46%', '64%'];
  return (
    <SkeletonRegion label={t('Loading the notes')} className="note-list">
      <div className="note-sect-wrap">
        <div className="note-sect">
          <SkLine w="4em" />
        </div>
        {row(first)}
      </div>
      {rest.map(row)}
    </SkeletonRegion>
  );
}

/** Scrolls `scroller` (never the page around it) so `row` is in view: `follow` puts it a third from the top when it
 * has left the view; otherwise as little as brings it — and as much of it as fits — into view. */
function bringIntoView(scroller: HTMLElement, row: HTMLElement, follow: boolean) {
  // a list as tall as its notes (stacked under the picture, where the page scrolls) is never moved for them
  if (scroller.scrollHeight <= scroller.clientHeight + 1 || getComputedStyle(scroller).overflowY === 'visible') return;
  const box = scroller.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  const pad = 12;
  let by = 0;
  if (follow) {
    if (r.top < box.top + pad || r.bottom > box.bottom - pad) by = r.top - (box.top + box.height / 3);
  } else if (r.top < box.top + pad) by = r.top - box.top - pad;
  else if (r.bottom > box.bottom - pad) by = Math.min(r.bottom - box.bottom + pad, r.top - box.top - pad);
  if (Math.abs(by) >= 1) scroller.scrollBy({ top: by, behavior: follow ? 'smooth' : 'auto' });
}

const rowOf = (scroller: HTMLElement, id: string) => scroller.querySelector<HTMLElement>(`[data-note="${CSS.escape(id)}"]`);

/** Where `el`'s items stop: the end of its content box. */
const contentEnd = (el: HTMLElement) => el.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(el).paddingRight);
/** Every item of `el` inside its padding. */
const inside = (el: HTMLElement) => {
  const end = contentEnd(el);
  return [...el.children].every((c) => c.getBoundingClientRect().right <= end + 0.5);
};
/** …and on one row: a line that wraps puts an item on a second row rather than past its end. */
const oneRow = (el: HTMLElement) => {
  const end = contentEnd(el);
  const shown = [...el.children].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 0);
  const mid = (r: DOMRect) => r.top + r.height / 2;
  const first = shown[0];
  return !first || shown.every((r) => r.right <= end + 0.5 && Math.abs(mid(r) - mid(first)) < 1);
};

/**
 * Puts `data-fit` on `el` at the first level, 0 … `last`, at which `fits` holds (what it says less at each is notes.css's)
 * — again when its width changes (the window, a phone turned) and when its words do (a count, a view, the language,
 * Auto-check's answer), and when `again` does. The levels are an attribute and are not watched, nor is the height a
 * level changes.
 */
function useFit(el: HTMLElement | null, last: number, fits: (el: HTMLElement) => boolean, again?: unknown) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: `again` says the words shown changed without a mutation (a sheet opening shows its head's)
  useLayoutEffect(() => {
    if (!el) return;
    const fit = () => {
      for (let level = 0; level <= last; level++) {
        el.dataset.fit = String(level);
        if (fits(el)) return;
      }
    };
    fit();
    let width = el.getBoundingClientRect().width;
    const ro = new ResizeObserver(() => {
      const now = el.getBoundingClientRect().width;
      if (now === width) return;
      width = now;
      if (now) fit();
    });
    ro.observe(el);
    const mo = new MutationObserver(fit);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    void document.fonts?.ready.then(fit);
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [el, last, fits, again]);
}

export function NotesPanel(p: NotesPanelProps) {
  const { counts: n, filter, sheet } = p;
  // the note at the playhead: while playing it stays marked a second past its frame (one frame is 1/25 s)
  const hold = p.playing ? Math.round(p.fps ?? 25) : 0;
  const here = useSyncExternalStore(p.live ? p.live.subscribe : still, () => noteAt(p.list, p.live ? p.live.get() : p.frame, hold) ?? '');
  const { live, handle } = useSheetDrag(sheet);
  // Phones: a new note starts at the top of the sheet, tools first, whatever was scrolled before.
  const scroller = useRef<HTMLDivElement>(null);
  const composing = !!p.composer;
  const inSheet = !!sheet;
  useEffect(() => {
    if (composing && inSheet) scroller.current?.scrollTo({ top: 0 });
  }, [composing, inSheet]);
  // The list follows the playhead while playing — unless the person scrolls it (a wheel, a finger, the keys, the bar;
  // it waits a few seconds after the last) or is typing.
  const scrolledAt = useRef(0);
  useEffect(() => {
    const el = scroller.current;
    // the transcript follows its own words (Transcript.tsx)
    if (!el || p.view === 'transcript') return;
    const mark = () => {
      scrolledAt.current = performance.now();
    };
    const bar = (e: PointerEvent) => e.target === el && mark();
    el.addEventListener('wheel', mark, { passive: true });
    el.addEventListener('touchmove', mark, { passive: true });
    el.addEventListener('keydown', mark);
    el.addEventListener('pointerdown', bar);
    return () => {
      el.removeEventListener('wheel', mark);
      el.removeEventListener('touchmove', mark);
      el.removeEventListener('keydown', mark);
      el.removeEventListener('pointerdown', bar);
    };
  }, [p.view]);
  const following = !!p.playing && !!here && !composing;
  useEffect(() => {
    const el = scroller.current;
    if (!following || !el) return;
    if (performance.now() - scrolledAt.current < 3000 || document.activeElement?.matches('input, textarea, select, [contenteditable="true"]')) return;
    const row = rowOf(el, here);
    if (row) bringIntoView(el, row, true);
  }, [following, here]);
  // The selected note (a click, ↑ / ↓, the playhead reaching it) is brought into view as it opens.
  const selected = p.selected;
  useEffect(() => {
    const el = scroller.current;
    const row = selected && el ? rowOf(el, selected) : null;
    if (el && row) bringIntoView(el, row, false);
  }, [selected]);
  // Phones: a note picked on purpose (the list, the timeline, N, a link) comes to the sheet's top, whole — its Reply and
  // its decision in reach without scrolling: a peeking sheet opens, and grows to full where the card needs the room
  // (measured against the sheet's own heights, as the drag snaps to them, not a height still on its way). A question
  // with answers to pick (AskCard.tsx) comes up so too when the notes arrive and whenever the sheet is raised: its
  // question and first answer in view, the picture shrinking above as for an opened note. Not while typing (the
  // keyboard has the screen: phoneSheet.ts useKeyboard), writing a note or checking fixes.
  const reveal = useRef<{ id: string; ask: boolean } | null>(null);
  const lastPick = useRef(0);
  const askSeen = useRef<string | null>(null);
  // where the head ended when a question last came up: the line under it can grow a moment later (Auto-check's chip
  // arriving), and the question goes up again with it — not once the sheet is put away
  const askDone = useRef<{ id: string; head: number; at: number } | null>(null);
  const sheetWas = useRef<SheetState | undefined>(sheet?.state);
  const askId = sheet && p.view === 'notes' && !p.readOnly ? (p.list.find((c) => isQuestion(c) && asksWithPicks(c))?.id ?? null) : null;
  useLayoutEffect(() => {
    const pick = p.picked;
    if (pick && pick.n !== lastPick.current) {
      lastPick.current = pick.n;
      reveal.current = sheet ? { id: pick.id, ask: false } : null;
    }
    const raised = sheetWas.current === 'peek' && !!sheet && sheet.state !== 'peek';
    sheetWas.current = sheet?.state;
    if (askId && !reveal.current && (askSeen.current !== askId || raised)) reveal.current = { id: askId, ask: true };
    askSeen.current = askId;
    const el = scroller.current;
    const headNow = () => {
      const box = el?.closest('.nsheet')?.getBoundingClientRect();
      return el && box ? el.getBoundingClientRect().top - box.top : 0;
    };
    const done = askDone.current;
    if (!reveal.current && sheet?.state !== 'peek' && done && done.id === askId && performance.now() - done.at < 3000 && Math.abs(headNow() - done.head) > 1)
      reveal.current = { id: done.id, ask: true };
    const want = reveal.current;
    if (!sheet || !el || !want) return;
    const typing = document.activeElement?.matches('input, textarea, select, [contenteditable="true"]');
    if ((!want.ask && p.selected !== want.id) || composing || p.verifying || typing) {
      reveal.current = null;
      return;
    }
    // held sideways the notes are a part of the page, no sheet to move (its handle is gone): the page is theirs
    if (!(el.closest('.nsheet')?.querySelector('.nsheet-handle') as HTMLElement | null)?.offsetParent) {
      reveal.current = null;
      return;
    }
    const card = rowOf(el, want.id);
    // a picked note's card opens with this render or the next; a question that can't be answered here is a row
    if (!card || (want.ask ? !card.matches('[data-testid=ask-card]') : !card.classList.contains('active'))) {
      if (want.ask) reveal.current = null;
      return;
    }
    if (sheet.state === 'peek') return sheet.setState('half');
    const pad = 12;
    const top = card.getBoundingClientRect().top;
    // what must be in view: the whole card, or a question's words and its first answer
    const need = want.ask ? (card.querySelector('[data-testid=ask-pick], .opt-ask')?.getBoundingClientRect().bottom ?? top) - top : card.offsetHeight;
    const sheetBox = el.closest('.nsheet')?.getBoundingClientRect();
    const head = sheetBox ? el.getBoundingClientRect().top - sheetBox.top : 0;
    const room = snaps()[sheet.state] - head - Number.parseFloat(getComputedStyle(el).paddingBottom) - pad;
    if (sheet.state === 'half' && need > room) return sheet.setState('full');
    el.scrollTop += top - el.getBoundingClientRect().top - pad;
    reveal.current = null;
    if (want.ask) askDone.current = { id: want.id, head, at: performance.now() };
  });
  const style: CSSProperties | undefined = sheet && live !== null ? { height: live, transition: 'none' } : undefined;
  const words = p.view === 'transcript';
  // a phone in check mode: the sheet is check mode's card (p.top) and nothing else; on a desk the card floats on the stage
  const checking = !!sheet && !!p.verifying && !!p.top;
  const agent = p.view === 'agent';
  // The transcript's search and comparison stay while you switch back and forth; a first version has nothing to compare.
  const [find, setFind] = useState<TranscriptFind>(NO_FIND);
  const base = p.transcript.base;
  useEffect(() => {
    if (base === null) setFind((f) => (f.diff ? { ...f, diff: false } : f));
  }, [base]);
  const pickView = (v: PanelView) => {
    p.setView(v);
    // a tab picked on a peeking sheet shows what it picked
    if (sheet?.state === 'peek') sheet.setState('half');
  };
  const notesView = !words && !agent;
  // The head is one row whatever its words: where they don't fit, it says less, measured, step by step — Auto-check's
  // chip without its name, the tabs a size smaller, the chip its number alone, + Note its plus alone, then the notes'
  // count left to the groups' headers (`data-fit`, notes.css). A sheet opening shows the head's words (at rest they are
  // hidden): fit them again.
  const [titleEl, setTitleEl] = useState<HTMLDivElement | null>(null);
  useFit(titleEl, 5, inside, sheet?.state);
  // A phone's line under the head is one row too, in German as in English, at 360 px as at 390: what Auto-check found
  // as its number alone (its words are in its label), then the door to checking fixes in its short words — never a word
  // cut, and never a second line for what fits on one.
  const [chipsEl, setChipsEl] = useState<HTMLDivElement | null>(null);
  useFit(sheet ? chipsEl : null, 2, oneRow, sheet?.state);
  // The filter's menu: the lists (the groups are what it shows by default) and the tags; a filter on shows as a chip
  const filterItems: MenuEntry[] = [
    ...FILTERS()
      .filter((f) => f.id !== 'questions' || (n && n.questions > 0) || filter === 'questions')
      .map((f) => ({
        label: n ? `${f.label} · ${n[f.count]}` : f.label,
        checked: filter === f.id,
        onClick: () => p.setFilter(filter === f.id ? 'active' : f.id),
      })),
    !!p.tags?.length && { heading: t('Tags') },
    ...(p.tags ?? []).map(([tag, count]) => ({
      label: `${tagLabel(tag)} · ${count}`,
      checked: p.tag === tag,
      onClick: () => p.setTag?.(p.tag === tag ? null : tag),
    })),
  ];
  const listFilter = filter !== 'active' ? FILTERS().find((f) => f.id === filter) : null;
  // The views as quiet text tabs in the head: the Notes with their count, the Transcript where there is speech (or the
  // transcript is open), and the Agent view only while it is open (the agent's line and ⋯ open it: a third word in
  // the head at 360 px would crowd it).
  const tabs = (['notes', (p.transcriptTab || words) && 'transcript', agent && 'agent'] as const).filter((v): v is PanelView => !!v);
  const tabKeys = (e: ReactKeyboardEvent<HTMLButtonElement>, at: number) => {
    const to = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
    if (to === null) return;
    // handled here: the player's arrows step frames otherwise (useShortcuts.ts leaves a handled key alone)
    e.preventDefault();
    const v = tabs[(to + tabs.length) % tabs.length];
    pickView(v);
    document.getElementById(`np-tab-${v}`)?.focus();
  };
  const tabWords = (v: PanelView) => (
    <>
      {VIEWS().find((x) => x.id === v)?.label}
      {v === 'notes' && <span className="np-count">{n ? n.all : <SkLine w="1.5em" />}</span>}
      {v === 'agent' && p.agentTab?.live && <KeyGlyph shape="ease" className="nav-kg live" />}
    </>
  );
  // ⋯: the Agent view, and review mode (N) where there are notes to go through
  const moreItems: MenuEntry[] = [
    !!p.agentTab && { label: t('Agent'), checked: agent, onClick: () => pickView(agent ? 'notes' : 'agent') },
    'sep',
    notesView &&
      !!n &&
      n.active > 1 && {
        label: p.reviewing ? t('Leave review mode') : t('Go through the open notes'),
        icon: 'reviewMode',
        shortcut: 'N',
        checked: p.reviewing,
        onClick: p.onReview,
      },
  ];
  // A phone's selector, at the start of the line under the head: which notes the sheet shows — what is open (with what
  // needs you; its default), the fixes to check, the done ones, all — then the filter menu's lists and the tags. It says
  // the one shown, with its count.
  const pickItem = (v: ReturnType<typeof PHONE_VIEWS>[number]): MenuEntry => ({
    label: n ? `${v.label} · ${n[v.count]}` : v.label,
    checked: filter === v.id,
    onClick: () => p.setFilter(v.id),
  });
  const views = PHONE_VIEWS().filter((v) => v.id !== 'questions' || (n && n.questions > 0) || filter === 'questions');
  const shownView = PHONE_VIEWS().find((v) => v.id === filter) ?? PHONE_VIEWS()[0];
  const viewPick = sheet && notesView && (
    <Menu
      align="start"
      trigger={
        <button type="button" className={`btn sm np-pick${filter !== 'active' || p.tag ? ' on' : ''}`} data-testid="notes-view">
          <span className="sr-only">{t('Notes shown:')} </span>
          {shownView.label}
          <span className="n">{n ? n[shownView.count] : <SkLine w="1em" />}</span>
          <I name="down" size={14} />
        </button>
      }
      items={[
        ...views.slice(0, 4).map(pickItem),
        'sep',
        ...views.slice(4).map(pickItem),
        !!p.tags?.length && { heading: t('Tags') },
        ...(p.tags ?? []).map(([tag, count]) => ({
          label: `${tagLabel(tag)} · ${count}`,
          checked: p.tag === tag,
          onClick: () => p.setTag?.(p.tag === tag ? null : tag),
        })),
      ]}
    />
  );
  // A phone's door to checking the fixes while its list doesn't show their group (the selector's To check does): on the
  // line under the head, beside ⋯, raised as the To check header's would be. Where the line has no room for its words
  // it says "Check 2" (the line's last level, notes.css); its label keeps them all.
  const checkWords = t('Check {n} fix|Check {n} fixes', { n: p.verifyCount });
  const sheetCheck = sheet && notesView && p.verifyCount > 0 && !p.verifying && !p.readOnly && !p.groupCounts?.check && (
    <Button
      size="sm"
      variant={p.checkPrimary ? 'primary' : 'ghost'}
      onClick={p.onVerify}
      aria-label={checkWords}
      data-short={`${t('Check')} ${p.verifyCount}`}
      className="np-check"
      data-testid="check-sheet"
    >
      <span className="np-check-words">{checkWords}</span>
    </Button>
  );
  const filterButton = notesView && (
    <Menu
      align="end"
      trigger={
        <IconButton
          className={`btn sm ghost icon-only ${listFilter || p.tag ? 'on' : ''}`}
          label={t('Filter')}
          icon="filter"
          size={16}
          data-testid="notes-filter"
        />
      }
      items={filterItems}
    />
  );
  const moreButton = (
    <Menu
      align="end"
      trigger={<IconButton className="btn sm ghost icon-only" label={t('More')} icon="more" size={16} data-testid="notes-more" />}
      items={moreItems}
    />
  );
  const groupCounts = p.groupCounts;
  // a group's header: its name and count; "To check" carries the panel's door to check mode, "Done" folds
  const sectionHead = (g: GroupId) =>
    g === 'done' ? (
      <button type="button" className="note-sect note-fold" data-group="done" aria-expanded onClick={() => p.setDoneOpen?.(false)} data-testid="group-done">
        <span className="note-sect-name">{GROUP_LABEL()[g]}</span>
        <span className="n">{groupCounts?.[g] ?? 0}</span>
        <I name="down" size={14} className="note-fold-chev" />
      </button>
    ) : (
      <div className="note-sect" data-group={g} data-testid={`group-${g}`}>
        <span className="note-sect-name">{GROUP_LABEL()[g]}</span>
        <span className="n">{groupCounts?.[g] ?? 0}</span>
        <span className="grow" />
        {g === 'check' && p.verifyCount > 0 && !p.verifying && !p.readOnly && (
          <Button size="sm" variant={p.checkPrimary ? 'primary' : 'ghost'} onClick={p.onVerify} data-testid="check-group">
            {t('Check')} {!sheet && <Kbd>⇧V</Kbd>}
          </Button>
        )}
      </div>
    );
  return (
    <div
      className={
        sheet
          ? `side grain nsheet nsheet-${sheet.state}${p.composer ? ' composing' : ''}${words ? ' words' : ''}${live !== null ? ' dragging' : ''}`
          : `side grain${words ? ' words' : ''}`
      }
      style={style}
    >
      {sheet && (
        <button type="button" className="nsheet-handle" {...handle} aria-label={sheet.state === 'peek' ? t('Show notes') : t('Hide notes')}>
          <span />
        </button>
      )}
      <div className="side-head">
        <div className="side-title np-head" ref={setTitleEl}>
          {/* A phone's sheet at rest says what is in it and opens with a tap anywhere on its row (mobile.css: shown in
              place of the head's tools while it peeks); the handle alone, 22 px, was the way in. */}
          {sheet && (
            <button
              type="button"
              className="nsheet-open"
              onClick={() => sheet.setState('half')}
              data-testid="notes-open"
              aria-label={p.view === 'notes' && n ? `${t('Show notes')} · ${peekCount(n)}` : t('Show notes')}
            >
              <span className="nsheet-open-word">{VIEWS().find((x) => x.id === p.view)?.label ?? t('Notes')}</span>
              {p.view === 'notes' && <span className="nsheet-open-n">{n ? peekCount(n) : <SkLine w="4em" />}</span>}
              <I name="down" size={16} className="nsheet-open-chev" />
            </button>
          )}
          {tabs.length > 1 ? (
            <div className="np-tabs" role="tablist" aria-label={t('Notes or transcript')}>
              {tabs.map((v, i) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  id={`np-tab-${v}`}
                  className="np-tab"
                  aria-selected={p.view === v}
                  tabIndex={p.view === v ? 0 : -1}
                  onClick={() => pickView(v)}
                  onKeyDown={(e) => tabKeys(e, i)}
                  data-testid={`panel-${v}`}
                >
                  {tabWords(v)}
                </button>
              ))}
            </div>
          ) : (
            // one view: its name, as the open tab would read
            <h2 className="np-tabs">
              <span className="np-tab" aria-current="true" data-testid="panel-notes">
                {tabWords('notes')}
              </span>
            </h2>
          )}
          {/* the transcript's head says which version it heard */}
          {words && (
            <span className="side-count">
              <TranscriptMeta slug={p.slug} v={p.v} />
            </span>
          )}
          <span className="grow" />
          {/* Auto-check only when it found something: in the head on a desk, on the line under it on a phone (no room) */}
          {notesView && p.autoCheckFound && !sheet && p.autoCheck}
          {!sheet && filterButton}
          {!sheet && moreButton}
          {sheet?.mic}
          {p.record}
          {!p.readOnly && (
            <Tip content={t('New note')} shortcut="C">
              <button
                type="button"
                className={p.quietNew ? 'btn sm new-note' : 'btn sm primary new-note'}
                onClick={p.onCompose}
                disabled={!p.canCompose}
                data-testid="new-note"
                aria-label={t('Note')}
              >
                <I name="plus" size={14} /> <span className="new-note-word">{t('Note')}</span>
              </button>
            </Tip>
          )}
        </div>
        {/* The line under the head: a filter that is on (a chip that takes it off); on a phone the selector of which
            notes it shows, what Auto-check found, the door to checking fixes and ⋯, so its head keeps room for the
            views, the mic, Record and + Note */}
        {notesView && !checking && (sheet || listFilter || p.tag) && (
          <div className="np-chips" data-testid="notes-filters-on" ref={setChipsEl}>
            {viewPick}
            {sheet && p.autoCheckFound && p.autoCheck}
            {listFilter && !sheet && (
              <button type="button" className="chip np-chip" onClick={() => p.setFilter('active')} data-filter={listFilter.id}>
                {listFilter.label}
                <I name="x" size={12} />
                <span className="sr-only">{t('Clear the filter')}</span>
              </button>
            )}
            {p.tag && (
              <button type="button" className="chip np-chip" onClick={() => p.setTag?.(null)} data-tag={p.tag}>
                #{tagLabel(p.tag)}
                <I name="x" size={12} />
                <span className="sr-only">{t('Clear the filter')}</span>
              </button>
            )}
            {sheet && (
              <span className="np-tools">
                {sheetCheck}
                {moreButton}
              </span>
            )}
          </div>
        )}
        {p.strip}
        {words && !checking && <TranscriptTools find={find} setFind={setFind} v={p.v} base={base} />}
      </div>
      {words && (
        <TranscriptView
          {...p.transcript}
          slug={p.slug}
          v={p.v}
          fps={p.fps ?? 25}
          frame={p.frame}
          live={p.live}
          find={find}
          composer={p.composer}
          scroller={scroller}
        />
      )}
      {agent && (
        <div className="av-host" data-testid="agent-panel">
          {p.agentView ?? <NoteRowsPending />}
        </div>
      )}
      {notesView && (
        <div className="side-scroll" ref={scroller}>
          {checking ? p.top : null}
          {!checking && !n && <NoteRowsPending />}
          {!checking && p.top}
          {!checking && p.recording}
          {!checking && p.composer}
          {!checking && (
            <NoteRows
              list={p.list}
              reveal={following ? here : p.selected}
              note={(c) => {
                const card = (
                  <CommentCard
                    key={c.id}
                    c={c}
                    slug={p.slug}
                    videoName={p.videoName}
                    currentV={p.v}
                    latestV={p.latestV}
                    here={here === c.id}
                    selected={p.selected === c.id}
                    showAuthor={p.showAuthor}
                    onSelect={p.onSelect}
                    onLightbox={p.onLightbox}
                    fps={p.fps}
                    onPlayRange={p.onPlayRange}
                    looping={!!p.rangeLoop && !!c.rangeHere && p.rangeLoop.in === c.rangeHere.in && p.rangeLoop.out === c.rangeHere.out}
                    checkMode={!!p.verifying}
                    plan={
                      p.plans?.get(c.id) ??
                      (p.planPending && (c.status === 'open' || c.status === 'fixed') && (!c.kind || c.kind === 'feedback') ? PLAN_PENDING : undefined)
                    }
                    planName={p.planName}
                    changedIn={p.changedHere?.has(c.id) ? p.v : undefined}
                  />
                );
                const g = p.firsts?.get(c.id);
                return g ? (
                  <div key={c.id} className="note-sect-wrap" data-group-start={g}>
                    {sectionHead(g)}
                    {card}
                  </div>
                ) : (
                  card
                );
              }}
            />
          )}
          {/* the done notes, folded at the end */}
          {!checking && n && !p.doneOpen && (groupCounts?.done ?? 0) > 0 && (
            <button
              type="button"
              className="note-sect note-fold"
              data-group="done"
              aria-expanded={false}
              onClick={() => p.setDoneOpen?.(true)}
              data-testid="group-done"
            >
              <span className="note-sect-name">{GROUP_LABEL().done}</span>
              <span className="n">{groupCounts?.done}</span>
              <I name="right" size={14} className="note-fold-chev" />
            </button>
          )}
          {!checking && n && !p.list.length && !p.composer && !p.recording && p.tag && (
            <EmptyState
              size="sm"
              className="side-empty"
              art="list"
              title={t('No {tag} notes here', { tag: tagLabel(p.tag) })}
              action={
                <button type="button" className="btn sm" onClick={() => p.setTag?.(null)}>
                  {t('Show every tag')}
                </button>
              }
            />
          )}
          {!checking && n && !p.list.length && !p.composer && !p.recording && !p.tag && (
            <EmptyState
              size="sm"
              className="side-empty"
              art={filter === 'active' && !n.all ? 'note' : EMPTY()[filter].art}
              title={filter === 'active' && !n.all ? t('No notes yet') : EMPTY()[filter].title}
              tips={
                filter === 'active' && !n.all && !sheet && !p.readOnly
                  ? [
                      <T k="<0>C</0> writes a note on this frame" key="c" tags={[(c) => <kbd>{c}</kbd>]} />,
                      <T k="Set <0>I</0> and <1>O</1> first to note a range" key="r" tags={[(c) => <kbd>{c}</kbd>, (c) => <kbd>{c}</kbd>]} />,
                    ]
                  : undefined
              }
            >
              {filter === 'active' &&
                !n.all &&
                !p.readOnly &&
                (sheet
                  ? t('Pause on a frame, tap + Note, draw on it — or hold the mic and talk.')
                  : t('Pause on a frame and say what should change: the note stays on that exact frame.'))}
            </EmptyState>
          )}
        </div>
      )}
    </div>
  );
}
