// The notes sidebar: its head (Notes · Transcript, the Auto-check chip, Record, + Note), the filters — Open · Questions ·
// Mine · Closed · All, then the notes' tags with their counts —, the verify call to action, what is not sent yet, the
// composer and the notes: a row each, the selected one open as its card (CommentCard.tsx), a group header where the
// author or the sitting changes (noteRows.ts). While playing, the note at the playhead is marked and the list follows
// it, unless the person is scrolling or typing. While the review loads (`counts: null`) it is the same panel: the head
// and tabs are real, their numbers and the rows wait as placeholders of the same shape, so nothing moves when they arrive.

import { Tabs } from 'radix-ui';
import { type CSSProperties, type ReactNode, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { FrameRange, PlacedComment, RunPlanItem } from '../api/types.ts';
import { perLang, t } from '../i18n/index.ts';
import { T } from '../i18n/T.tsx';
import { tagLabel } from '../i18n/terms.ts';
import { useScrollEdges } from '../lib/hooks.ts';
import { useMeasuredWindow, WINDOW_FROM } from '../lib/windowing.ts';
import type { EmptyArtName } from '../ui/emptyArt.tsx';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { IconButton, Kbd, Tip } from '../ui/primitives.tsx';
import { Skeleton, SkeletonRegion, SkLine } from '../ui/Skeleton.tsx';
import { EmptyState } from '../ui/system.tsx';
import { CommentCard, type RangePlay } from './CommentCard.tsx';
import type { FrameStore } from './frameStore.ts';
import { groupStarts, noteAt } from './noteRows.ts';
import { NO_FIND, type TranscriptFind, TranscriptMeta, TranscriptTools, TranscriptView, type TranscriptViewProps } from './Transcript.tsx';

export type Filter = 'active' | 'questions' | 'mine' | 'closed' | 'all';
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

/** open = feedback to act on (ideas and questions are not work items); the rest are the lengths of the lists. */
type Counts = { open: number; fixed: number; active: number; mine: number; closed: number; all: number; questions: number };

const FILTERS = perLang((): { id: Filter; label: string; count: keyof Counts; title?: string }[] => [
  { id: 'active', label: t('Open'), count: 'active', title: t('Open notes and fixes waiting to be checked') },
  { id: 'questions', label: t('Questions'), count: 'questions', title: t('Questions from agents, waiting for your answer') },
  { id: 'mine', label: t('Mine'), count: 'mine', title: t('Your own notes that are still open') },
  { id: 'closed', label: t('Closed'), count: 'closed' },
  { id: 'all', label: t('All'), count: 'all' },
]);
const EMPTY = perLang(
  (): Record<Filter, { art: EmptyArtName; title: string }> => ({
    active: { art: 'clear', title: t('All clear') },
    questions: { art: 'clear', title: t('No questions') },
    mine: { art: 'clear', title: t('Nothing open from you') },
    closed: { art: 'list', title: t('Nothing closed yet') },
    all: { art: 'note', title: t('No notes yet') },
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
  /** An archived project's video (lib/archived.ts): its notes are read, nothing new is written. */
  readOnly?: boolean;
  verifying: boolean;
  onVerify: () => void;
  /** Review mode: start (or leave) stepping through the open notes. */
  onReview: () => void;
  reviewing: boolean;
  /** The Auto-check chip (AutoCheck.tsx), in the head row beside Record and + Note. */
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
  /** The strip offers Check fixes: the list's own call to check steps back (one place to press). */
  verifyInStrip?: boolean;
  /** What the transcript tab needs from the player. */
  transcript: Pick<TranscriptViewProps, 'base' | 'onSeek' | 'onPlay' | 'onChangeWords' | 'onRerun' | 'edits'>;
}

// Drag the handle to resize the sheet; on release it snaps to the nearest position (a flick moves one step).
function useSheetDrag(sheet: SheetProps | undefined) {
  const drag = useRef<{ y: number; h: number; id: number; lastY: number; lastT: number; v: number } | null>(null);
  const [live, setLive] = useState<number | null>(null);
  const snaps = () => {
    const vh = window.innerHeight;
    return { peek: 0, half: vh * 0.5, full: vh * 0.82 } as Record<SheetState, number>;
  };
  if (!sheet) return { live: null, handle: {} };
  const handle = {
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => {
      const el = e.currentTarget.parentElement;
      if (!el) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { y: e.clientY, h: el.getBoundingClientRect().height, id: e.pointerId, lastY: e.clientY, lastT: performance.now(), v: 0 };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLButtonElement>) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      const h = Math.max(56, Math.min(window.innerHeight * 0.9, d.h + (d.y - e.clientY)));
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
      if (Math.abs(moved) < 6) {
        // a tap on the handle: open from peek, otherwise close
        sheet.setState(sheet.state === 'peek' ? 'half' : 'peek');
        return;
      }
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

/** The rows while the notes load: a group header and rows of the loaded anatomy, so nothing moves when they arrive. */
function NoteRowsPending() {
  return (
    <SkeletonRegion label={t('Loading the notes')} className="note-list">
      {['72%', '54%', '80%', '46%', '64%'].map((w, i) => (
        <div key={w} className="note note-row pending">
          {i === 0 && (
            <div className="note-group">
              <Skeleton w={18} h={18} r={999} />
              <SkLine w="9em" />
            </div>
          )}
          <div className="nr">
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
      ))}
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

export function NotesPanel(p: NotesPanelProps) {
  const { counts: n, filter, sheet } = p;
  // the note at the playhead: while playing it stays marked a second past its frame (one frame is 1/25 s)
  const hold = p.playing ? Math.round(p.fps ?? 25) : 0;
  const here = useSyncExternalStore(p.live ? p.live.subscribe : still, () => noteAt(p.list, p.live ? p.live.get() : p.frame, hold) ?? '');
  const starts = useMemo(() => groupStarts(p.list), [p.list]);
  const { live, handle } = useSheetDrag(sheet);
  // the filters fit the panel; where a language's words (or many tags) don't, they scroll with soft edges rather than
  // being cut
  const [filtersRef, filtersEdges] = useScrollEdges<HTMLDivElement>();
  const [tagsRef, tagsEdges] = useScrollEdges<HTMLFieldSetElement>();
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
  const style: CSSProperties | undefined = sheet && live !== null ? { height: live, transition: 'none' } : undefined;
  const words = p.view === 'transcript';
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
  return (
    <Tabs.Root asChild value={filter} onValueChange={(f) => p.setFilter(f as Filter)}>
      <div
        className={
          sheet ? `side grain nsheet nsheet-${sheet.state}${p.composer ? ' composing' : ''}${words ? ' words' : ''}` : `side grain${words ? ' words' : ''}`
        }
        style={style}
      >
        {sheet && (
          <button type="button" className="nsheet-handle" {...handle} aria-label={sheet.state === 'peek' ? t('Show notes') : t('Hide notes')}>
            <span />
          </button>
        )}
        <div className="side-head">
          <div className="side-title">
            <div className={`side-views${p.agentTab ? ' three' : ''}`} role="tablist" aria-label={t('Notes or transcript')}>
              {VIEWS()
                .filter((x) => x.id !== 'agent' || p.agentTab)
                .map((x) => (
                  <button
                    key={x.id}
                    type="button"
                    role="tab"
                    aria-selected={p.view === x.id}
                    className={p.view === x.id ? 'on' : ''}
                    onClick={() => pickView(x.id)}
                    data-testid={`panel-${x.id}`}
                  >
                    {x.label}
                    {x.id === 'agent' && p.agentTab?.live && <KeyGlyph shape="ease" className="nav-kg live side-view-kg" />}
                  </button>
                ))}
            </div>
            {/* the notes' numbers are on the tabs below; the transcript's head says which version it heard */}
            {words && (
              <span className="side-count">
                <TranscriptMeta slug={p.slug} v={p.v} />
              </span>
            )}
            <span className="grow" />
            {!words && !agent && !sheet && p.autoCheck}
            {!words && !agent && n && n.active > 1 && (
              <IconButton
                className={`btn sm ghost icon-only ${p.reviewing ? 'on' : ''}`}
                label={p.reviewing ? t('Leave review mode') : t('Go through the open notes')}
                shortcut="N"
                icon="reviewMode"
                size={16}
                onClick={p.onReview}
                aria-pressed={p.reviewing}
              />
            )}
            {sheet?.mic}
            {p.record}
            {!p.readOnly && (
              <Tip content={t('New note')} shortcut="C">
                <button
                  type="button"
                  className={p.quietNew ? 'btn sm' : 'btn sm primary'}
                  onClick={p.onCompose}
                  disabled={!p.canCompose}
                  data-testid="new-note"
                >
                  <I name="plus" size={14} /> {t('Note')}
                </button>
              </Tip>
            )}
          </div>
          {p.strip}
          {agent ? null : words ? (
            <TranscriptTools find={find} setFind={setFind} v={p.v} base={base} />
          ) : (
            <div className="note-filters">
              <Tabs.List ref={filtersRef} className={`tabs note-tabs ${filtersEdges}`} aria-label={t('Which notes')}>
                {FILTERS()
                  .filter((f) => f.id !== 'questions' || (n && n.questions > 0) || filter === 'questions')
                  .map((f) => (
                    <Tabs.Trigger key={f.id} value={f.id} className={filter === f.id ? 'on' : ''} title={f.title}>
                      {/* a list with nothing in it is just its word: the row fits the panel in every language */}
                      {f.label} {(!n || n[f.count] > 0) && <span className="n">{n ? n[f.count] : <SkLine w="1ch" />}</span>}
                    </Tabs.Trigger>
                  ))}
              </Tabs.List>
              {/* the notes' tags under them, one line that is always there (its room doesn't wait for the notes): one
                  picked narrows the list, combined with the filter above */}
              <fieldset ref={tagsRef} className={`note-tagf ${tagsEdges}`} aria-label={t('Tags')} data-testid="tag-filters">
                {sheet && p.autoCheck && <span className="note-tagf-ac">{p.autoCheck}</span>}
                {!n ? (
                  ['3em', '4em', '3.5em'].map((w) => (
                    <span key={w} className="tagf pending">
                      <SkLine w={w} />
                    </span>
                  ))
                ) : !p.tags?.length ? (
                  <span className="note-tagnone">{t('No tags yet · type # in a note')}</span>
                ) : (
                  p.tags.map(([tag, count]) => (
                    <button
                      key={tag}
                      type="button"
                      className={`tagf ${p.tag === tag ? 'on' : ''}`}
                      aria-pressed={p.tag === tag}
                      onClick={() => p.setTag?.(p.tag === tag ? null : tag)}
                      data-tag={tag}
                    >
                      {tag === 'love-it' && <I name="heart" size={11} />}
                      {tagLabel(tag)} <span className="n">{count}</span>
                    </button>
                  ))
                )}
              </fieldset>
            </div>
          )}
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
        {!words && !agent && (
          <Tabs.Content value={filter} asChild>
            <div className="side-scroll" ref={scroller}>
              {!n && <NoteRowsPending />}
              {p.top}
              {p.recording}
              {p.verifyCount > 0 && filter !== 'closed' && !p.verifying && !p.verifyInStrip && (
                <div className="verify-cta">
                  <I name="fixed" size={18} />
                  <span className="grow">
                    <b>{t('{n} fix to check|{n} fixes to check', { n: p.verifyCount })}</b>
                    <span>{t('before and after, on V{latestV}', { latestV: p.latestV })}</span>
                  </span>
                  <button type="button" className="btn sm ok" onClick={p.onVerify}>
                    {t('Check now')} {!sheet && <Kbd>⇧V</Kbd>}
                  </button>
                </div>
              )}
              {p.composer}
              <NoteRows
                list={p.list}
                reveal={following ? here : p.selected}
                note={(c) => (
                  <CommentCard
                    key={c.id}
                    c={c}
                    slug={p.slug}
                    videoName={p.videoName}
                    currentV={p.v}
                    latestV={p.latestV}
                    here={here === c.id}
                    selected={p.selected === c.id}
                    groupHead={starts.has(c.id)}
                    onSelect={p.onSelect}
                    onLightbox={p.onLightbox}
                    fps={p.fps}
                    onPlayRange={p.onPlayRange}
                    looping={!!p.rangeLoop && !!c.rangeHere && p.rangeLoop.in === c.rangeHere.in && p.rangeLoop.out === c.rangeHere.out}
                    checkMode={!!p.verifying}
                    plan={p.plans?.get(c.id) ?? (p.planPending && c.status === 'open' && (!c.kind || c.kind === 'feedback') ? PLAN_PENDING : undefined)}
                    planName={p.planName}
                  />
                )}
              />
              {n && !p.list.length && !p.composer && !p.recording && p.tag && (
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
              {n && !p.list.length && !p.composer && !p.recording && !p.tag && (
                <EmptyState
                  size="sm"
                  className="side-empty"
                  art={filter === 'active' && !n.all ? 'note' : EMPTY()[filter].art}
                  title={filter === 'active' && !n.all ? t('No notes yet') : EMPTY()[filter].title}
                  tips={
                    filter === 'active' && !sheet && !p.readOnly
                      ? [
                          <T k="<0>C</0> writes a note on this frame" key="c" tags={[(c) => <kbd>{c}</kbd>]} />,
                          <T k="Set <0>I</0> and <1>O</1> first to note a range" key="r" tags={[(c) => <kbd>{c}</kbd>, (c) => <kbd>{c}</kbd>]} />,
                        ]
                      : undefined
                  }
                >
                  {filter === 'active' &&
                    !p.readOnly &&
                    (sheet
                      ? t('Pause on a frame, tap + Note, draw on it — or hold the mic and talk.')
                      : t('Pause on a frame and say what should change: the note stays on that exact frame.'))}
                </EmptyState>
              )}
            </div>
          </Tabs.Content>
        )}
      </div>
    </Tabs.Root>
  );
}
