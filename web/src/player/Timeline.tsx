// Canvas timeline: ruler (a partial render's patched stretch along its foot), note markers (range notes as bars from
// in to out), Auto-check findings, freeze ranges,
// per-frame waveform, project words/segments, in/out, playhead; hovering shows the frame under the pointer (from the
// render's sprite) and what is there. A section is marked by dragging across the notes lane (or shift-dragging
// anywhere; on touch: press and hold, then drag) — the hover says so, the cursor turns to a crosshair —, its ends drag
// like handles and its chip (TimelineControls.tsx) says what is marked and what to do with it.
// Zoom: the control (ZoomControl.tsx: zoom out · the level · zoom in) has a place of its own, never on the timeline —
// the transport row's slot (`zoomAt`), or on a phone a quiet row above the ruler with only zoom in until it is zoomed;
// ⌘/ctrl + wheel, a trackpad pinch (Safari's gesture events too) or two fingers; pan: shift + wheel / horizontal scroll
// or the overview's box (a strip along the foot while zoomed), keys = − 0 Z ⇧Z via the 'vr-zoom' event. The first time
// zooming would help, a tip points at the control, until dismissed or used (`vr.zoomhint`). Far enough in, every frame
// is a cell of the ruler with its number (timelineView.ts).
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { formatRange, rangeRows } from '../../../lib/range.ts';
import { spriteBackground, spriteTile } from '../../../lib/sprite.ts';
import { noteKind, timecode } from '../../../lib/time.ts';
import type { DiffRange, FrameRange, FreezeRange, PlacedComment, Retime, Severity } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { useLang } from '../i18n/T.tsx';
import { usePhone, useTouch } from '../lib/media.ts';
import { usePrefs } from '../lib/prefs.ts';
import { cssVar, useTheme, withAlpha } from '../lib/theme.ts';
import { KIND_SHAPE, SEVERITY_SHAPE, SHAPES, type Shape } from '../ui/glyphs.ts';
import type { FrameStore } from './frameStore.ts';
import { useRangeHint } from './rangeHint.ts';
import { SectionChip } from './TimelineControls.tsx';
import {
  CELL_PX,
  chipLeft,
  clampView,
  fitView,
  followFrame,
  isFit,
  overviewBox,
  panTo,
  restoredView,
  type View,
  zoomAround,
  zoomLevel,
  zoomTarget,
} from './timelineView.ts';
import { ZoomControl } from './ZoomControl.tsx';

// Achromatic like the rest of the chrome; colour only for notes and freezes. The colours are the theme's tokens
// (base.css), read when the theme changes: a canvas doesn't follow CSS by itself.
const TOKENS = {
  bg: '--tl-bg',
  film: '--tl-film',
  hole: '--tl-hole',
  lane: '--tl-lane',
  grid: '--tl-grid',
  tick: '--tl-tick',
  text: '--tl-text',
  wave: '--tl-wave',
  waveRms: '--tl-wave-rms',
  waveIn: '--tl-wave-in',
  waveRmsIn: '--tl-wave-rms-in',
  must: '--must',
  should: '--should',
  nice: '--nice',
  idea: '--idea',
  ok: '--ok',
  verified: '--tl-verified',
  closed: '--tl-closed',
  agent: '--claude',
  ivory: '--playhead',
  segA: '--tl-seg-a',
  segB: '--tl-seg-b',
  words: '--tl-words',
  wordText: '--tl-word-text',
  selected: '--fg-hi',
  brand: '--brand',
} as const;
type Palette = Record<keyof typeof TOKENS, string>;

function readPalette(el: Element): Palette {
  const p = {} as Palette;
  for (const [k, name] of Object.entries(TOKENS)) p[k as keyof Palette] = cssVar(el, name);
  return p;
}

const PERF = 10;
const RULER = 16;
const MARKS = 22;
// One height whatever the timeline shows: its lanes arrive on their own time (the version diff, the words, project
// segments), and a timeline that grew with them would squeeze the picture above it. The waveform takes what the other
// lanes leave (46 px with the change lane, as before; more without it, less with words).
const HEIGHT = 105;
const SEG = 7;
const WORDS = 18;
const CHG = 11; // "what changed vs the previous version" lane
const VIEWS = 6; // how much of the version was watched (the viewers band), while it is shown
const OVER = 8; // while zoomed: the whole video along the foot, the window on it as a box to drag
// The zoom's tip is said once per browser (player and review links alike), for a video longer than this: shorter ones
// show their frames well enough whole.
const HINT_SECONDS = 2;
const HINT_KEY = 'vr.zoomhint';
const NO_TAB: readonly string[] = [];

// Range bars that overlap or touch take a second row (lib/range.ts rangeRows); the bar's top from the notes lane's top.
const barTop = (rows: Map<string, number>, id: string) => ([...rows.values()].some(Boolean) ? (rows.get(id) ? 18 : 13) : 16);

// Canvas paths for the keyframe glyphs, made once.
const paths = new Map<Shape, Path2D>();
function glyphPath(shape: Shape): Path2D {
  let p = paths.get(shape);
  if (!p) {
    p = new Path2D(SHAPES[shape]);
    paths.set(shape, p);
  }
  return p;
}

function markerColor(C: Palette, c: TimelineComment) {
  if (c.status === 'fixed') return C.ok;
  if (c.status === 'verified') return withAlpha(C.verified, 0.45);
  if (c.status === 'wontfix') return C.closed;
  if (noteKind(c) !== 'feedback') return C.agent;
  return C[c.severity] || C.should;
}

export type TimelineComment = Pick<PlacedComment, 'id' | 'status' | 'author' | 'kind' | 'frameHere' | 'text' | 'timecode' | 'check_again'> & {
  severity: Severity;
  rangeHere?: FrameRange | null;
};
export interface TimelineWord {
  w: string;
  in: number;
  out: number;
}
export interface TimelineSegment {
  in: number;
  out: number;
}
/** An Auto-check finding: a hollow diamond above the notes, so it never reads as a note. */
export interface TimelineFinding {
  key: string;
  frame: number;
  severity: Severity;
  label: string;
}

interface TimelineProps {
  frames: number;
  fps: number;
  frame: number;
  /** The frame on screen while playing (frameStore.ts): the playhead follows it without the timeline rendering again. */
  live?: FrameStore;
  onSeek: (f: number) => void;
  inPt?: number | null;
  outPt?: number | null;
  peaks?: number[];
  rms?: number[];
  comments?: TimelineComment[];
  /** Holds (frames that look the same); `quiet`: Auto-check doesn't think it a problem (an end card, a pause). */
  freezes?: (FreezeRange & { quiet?: boolean })[];
  words?: TimelineWord[] | null;
  segments?: TimelineSegment[] | null;
  selected: string | null;
  onSelect: (id: string) => void;
  changes?: DiffRange[];
  retimes?: Retime[];
  findings?: TimelineFinding[];
  onPickFinding?: (key: string) => void;
  /** The render's hover-scrub sprite (lib/sprite.ts) once it exists, and the picture's aspect (width / height). */
  sprite?: string | null;
  aspect?: number;
  /** A range drawn on the timeline (both ends included); without it, dragging only scrubs. */
  onRange?: (r: FrameRange) => void;
  /** An end of the in/out range dragged to a frame; without it, the ends don't move. */
  onRangeEdge?: (edge: 'in' | 'out', f: number) => void;
  /** The marked section is what a note is being written about: drawn lit, and its chip offers no "Write a note". */
  writing?: boolean;
  /** The section chip's "Write a note on it" (C / ↵). */
  onMarkNote?: () => void;
  /** The section chip's "Clear the section" (Esc). */
  onMarkClear?: () => void;
  /** The window to start from (remembered per video) and where to tell a new one (null: the whole video). */
  zoomMemory?: { initial: unknown; onChange: (view: View | null) => void };
  /** The client pages' words. */
  client?: boolean;
  /** Where the zoom control goes: an element of the transport row (beside the speed and the sound), null while that
   * element isn't there yet (nothing renders, so nothing jumps), or left out: a row of its own above the ruler (a
   * phone). Never on the timeline itself. */
  zoomAt?: HTMLElement | null;
  /** The zoom's one-time tip waits: something floats over the picture's foot, where it would stand (check mode's card,
   * a review walk, a recording). It comes back once that is gone, until it is dismissed or used. */
  zoomTipWaits?: boolean;
  /** Who watched this version, per hundredth (lib/watch.ts): a band above the notes, the more watched the stronger, the
   * stretches watched again and again underlined. Null: no band. */
  views?: { retention: number[]; rewatched: { from: number; to: number; plays: number }[] } | null;
  /** A partial render (lib/part.ts): the stretch it patches, quiet along the ruler's foot like a work area, and the
   * frame its seam jumps at — the one lit mark. `label` is what pointing at the stretch says. */
  patch?: (FrameRange & { jump: number | null; label: string }) | null;
}

type Gesture =
  /** `at`: the frame under the pointer now, where letting go ends the section */
  | { kind: 'range'; anchor: number; at: number; moved: boolean }
  | { kind: 'edge'; edge: 'in' | 'out'; start: number; at: number }
  /** the overview's box, taken `grab` frames from its middle */
  | { kind: 'pan'; grab: number };
// A finger held this long without moving starts a range instead of scrubbing.
const LONG_PRESS_MS = 420;

interface Hover {
  x: number;
  f: number;
  c: TimelineComment | null;
  q: TimelineFinding | null;
  /** The word under the pointer, on the words lane. */
  w: string | null;
  touch: boolean;
  /** Where the pointer is: over an end of the range, over the notes lane (where dragging draws a range), over the
   * viewers band, or over the overview while zoomed. */
  zone?: 'edge' | 'lane' | 'views' | 'over' | null;
  /** Over an end: which one. */
  edge?: 'in' | 'out' | null;
}

export default function Timeline({
  frames,
  fps,
  frame,
  live,
  onSeek,
  inPt,
  outPt,
  peaks,
  rms,
  comments,
  freezes,
  words,
  segments,
  selected,
  onSelect,
  changes,
  retimes,
  findings,
  onPickFinding,
  sprite,
  aspect = 16 / 9,
  onRange,
  onRangeEdge,
  views = null,
  patch = null,
  writing = false,
  onMarkNote,
  onMarkClear,
  zoomMemory,
  client,
  zoomAt,
  zoomTipWaits = false,
}: TimelineProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  const [view, setView] = useState<View>(() => restoredView(zoomMemory?.initial, frames) ?? fitView(frames));
  const [hover, setHover] = useState<Hover | null>(null);
  const drag = useRef(false);
  const gesture = useRef<Gesture | null>(null);
  // what the pointer is doing now (the chip steps aside while an end or the overview is dragged)
  const [busy, setBusy] = useState<Gesture['kind'] | null>(null);
  // ⇧ held over the timeline: dragging anywhere marks a section (the cursor and the hint say so)
  const [shift, setShift] = useState(false);
  const touchScreen = useTouch();
  const phone = usePhone();
  const [draft, setDraft] = useState<FrameRange | null>(null);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; id: number } | null>(null);
  const [fontsReady, setFontsReady] = useState(false);
  const theme = useTheme();
  // the canvas's words (NO AUDIO, WAVEFORM…) are drawn again after a language switch
  const lang = useLang();
  // the composer pointing at its moment: the note's range lit, or the range an action would make (rangeHint.ts)
  const hint = useRangeHint();
  const palette = useRef<{ theme: string; C: Palette } | null>(null);
  useEffect(() => {
    document.fonts?.ready.then(() => setFontsReady(true));
  }, []);
  const hasChg = !!(changes?.length || retimes?.length);
  const height = HEIGHT;
  const band = views?.retention.length ? VIEWS : 0;
  // the notes lane's top: under the ruler, and under the viewers band while it shows
  const marksTop = PERF + RULER + band;
  const zoomed = !isFit(view, frames);
  // while zoomed the overview takes the foot, from the waveform like every other lane
  const over = zoomed ? OVER : 0;
  const wave = HEIGHT - PERF - RULER - band - MARKS - (hasChg ? CHG : 0) - (segments?.length ? SEG : 0) - (words?.length ? WORDS : 0) - over;
  const yWave = marksTop + MARKS + (hasChg ? CHG : 0);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(100, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // another version, another length: the same window where it still fits
  useEffect(() => setView((v) => restoredView(v, frames) ?? fitView(frames)), [frames]);

  const [v0, v1] = view;
  const pxPerFrame = width / (v1 - v0);
  const xOf = useCallback((f: number) => (f - v0) * pxPerFrame, [v0, pxPerFrame]);
  const fOf = useCallback((x: number) => Math.max(0, Math.min(frames - 1, Math.floor(v0 + x / pxPerFrame))), [v0, pxPerFrame, frames]);

  const zoom = useCallback((factor: number, anchorFrame?: number) => setView((v) => zoomAround(v, factor, anchorFrame ?? (v[0] + v[1]) / 2, frames)), [frames]);

  // A new window is remembered (per video, by whoever keeps it) once it has settled — or at once when the page goes.
  const memory = useRef(zoomMemory);
  memory.current = zoomMemory;
  const shown = useRef(view);
  shown.current = view;
  const remember = useCallback(() => {
    const [a, b] = shown.current;
    const r = (x: number) => Math.round(x * 100) / 100;
    memory.current?.onChange(isFit([a, b], frames) ? null : [r(a), r(b)]);
  }, [frames]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new window, told once it has settled
  useEffect(() => {
    const id = setTimeout(remember, 500);
    return () => clearTimeout(id);
  }, [v0, v1, remember]);
  useEffect(() => {
    window.addEventListener('pagehide', remember);
    return () => {
      window.removeEventListener('pagehide', remember);
      remember();
    };
  }, [remember]);

  // keep the playhead in view
  useEffect(() => setView((cur) => followFrame(cur, frame, frames)), [frame, frames]);

  // While playing, the view follows the playhead from the live frame, without rendering unless it has to scroll: zoomed
  // in, it pages on as the playhead reaches the edge, so it never runs off the timeline.
  useEffect(() => live?.subscribe(() => setView((cur) => followFrame(cur, live.get(), frames))), [live, frames]);

  // The keys zoom around the playhead (Z: to the marked section); read at key time, so the listener isn't swapped on
  // every frame while playing.
  const frameRef = useRef(frame);
  frameRef.current = live ? live.get() : frame;
  const marked = useRef({ inPt, outPt, fps });
  marked.current = { inPt, outPt, fps };
  const toTarget = useCallback(() => {
    const { inPt: a, outPt: b, fps: rate } = marked.current;
    const section = a != null && b != null ? { in: Math.min(a, b), out: Math.max(a, b) } : null;
    setView((v) => zoomTarget(v, section, frameRef.current, rate, frames));
  }, [frames]);
  useEffect(() => {
    const f = (e: Event) => {
      const k = (e as CustomEvent<string>).detail;
      if (k === 'in') zoom(0.5, frameRef.current);
      else if (k === 'out') zoom(2, frameRef.current);
      else if (k === 'section') toTarget();
      else setView(fitView(frames));
    };
    window.addEventListener('vr-zoom', f);
    return () => window.removeEventListener('vr-zoom', f);
  }, [zoom, toTarget, frames]);

  // ⇧ while the pointer is over the timeline: the cursor and the hint change to "drag to mark a section"
  const hovering = !!hover && !hover.touch;
  useEffect(() => {
    if (!hovering) return;
    const key = (e: KeyboardEvent) => e.key === 'Shift' && setShift(e.type === 'keydown');
    window.addEventListener('keydown', key);
    window.addEventListener('keyup', key);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('keyup', key);
    };
  }, [hovering]);

  // ⌘/ctrl + wheel zooms around the frame under the pointer (Chrome and Firefox send a trackpad's pinch the same way);
  // never the page. Safari sends a pinch as gesture events, which zoom its page unless taken. The listeners read the
  // window at event time, so a pinch keeps its start across the renders it causes.
  const pinchG = useRef<{ view: View; anchor: number } | null>(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const at = (clientX: number) => {
      const [a, b] = shown.current;
      const x = clientX - el.getBoundingClientRect().left;
      return { ppf: Math.max(1, el.clientWidth) / (b - a), f: a + (x * (b - a)) / Math.max(1, el.clientWidth) };
    };
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        // lines (Firefox) and pages count as pixels; one notch of a mouse wheel zooms about 1.8×, a pinch smoothly
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
        zoom(Math.exp(Math.max(-60, Math.min(60, dy)) * 0.01), at(e.clientX).f);
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
        e.preventDefault();
        const d = (e.shiftKey ? e.deltaY : e.deltaX) / at(e.clientX).ppf;
        setView(([a, b]) => clampView(a + d, b - a, frames));
      }
    };
    type SafariGesture = Event & { scale?: number; clientX?: number };
    // On a touch screen two fingers are the pointers' pinch below (iOS sends both): the gesture only keeps the page still.
    const gStart = (e: Event) => {
      e.preventDefault();
      if (touches.current.size) return;
      pinchG.current = { view: shown.current, anchor: at((e as SafariGesture).clientX ?? el.getBoundingClientRect().left + el.clientWidth / 2).f };
    };
    const gChange = (e: Event) => {
      e.preventDefault();
      const g = pinchG.current;
      const scale = (e as SafariGesture).scale;
      if (!g || touches.current.size || !scale) return;
      setView(zoomAround(g.view, 1 / scale, g.anchor, frames));
    };
    const gEnd = (e: Event) => {
      e.preventDefault();
      pinchG.current = null;
    };
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('gesturestart', gStart);
    el.addEventListener('gesturechange', gChange);
    el.addEventListener('gestureend', gEnd);
    return () => {
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('gesturestart', gStart);
      el.removeEventListener('gesturechange', gChange);
      el.removeEventListener('gestureend', gEnd);
    };
  }, [zoom, frames]);

  // ---------------------------------------------------------------- draw
  // Everything but the playhead lives on the canvas and only redraws when the view or the data changes; the
  // playhead is a composited overlay, so playback and scrubbing move one element instead of repainting the strip.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fontsReady redraws the labels once the webfonts are in, theme repaints the colours, lang redraws the words
  useEffect(() => {
    const canvas = cv.current;
    if (!canvas) return;
    if (palette.current?.theme !== theme) palette.current = { theme, C: readPalette(canvas) };
    const C = palette.current.C;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(width * dpr);
    const ch = Math.round(height * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
      canvas.style.height = `${height}px`;
    }
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = C.bg;
    g.fillRect(0, 0, width, height);
    g.font = "500 8.5px 'Martian Mono Variable', ui-monospace, monospace";
    g.textBaseline = 'middle';

    // film perforations, locked to frames so they travel with zoom and pan
    g.fillStyle = C.film;
    g.fillRect(0, 0, width, PERF);
    g.fillStyle = C.hole;
    const perfStep = Math.max(1, Math.round(15 / pxPerFrame));
    for (let f = Math.floor(v0 / perfStep) * perfStep; f <= v1 + perfStep; f += perfStep) {
      const x = xOf(f);
      if (g.roundRect) {
        g.beginPath();
        g.roundRect(x - 3.5, 2.5, 7, 5, 1.4);
        g.fill();
      } else g.fillRect(x - 3.5, 2.5, 7, 5);
    }

    const yRuler = PERF;
    const yViews = PERF + RULER;
    const yMarks = marksTop;
    const yChg = yMarks + MARKS;
    const ySeg = yWave + wave;
    const yWords = ySeg + (segments?.length ? SEG : 0);
    const yOver = height - over;
    // the lanes a marked section and the composer's ghost cover: everything under the perforations but the overview
    const tall = height - PERF - over;

    // lanes
    g.fillStyle = C.lane;
    g.fillRect(0, yWave, width, wave);

    // who watched: per pixel, the share of the viewers who played that hundredth (achromatic, like the chrome)
    if (band && views) {
      g.fillStyle = C.lane;
      g.fillRect(0, yViews, width, band);
      const part = (f: number) => Math.min(99, Math.max(0, Math.floor((f / Math.max(1, frames)) * 100)));
      for (let x = 0; x < width; x++) {
        const f = v0 + x / pxPerFrame;
        if (f < 0 || f >= frames) continue;
        const r = views.retention[part(f)] ?? 0;
        if (!r) continue;
        g.fillStyle = withAlpha(C.ivory, 0.12 + 0.68 * r);
        g.fillRect(x, yViews + 1, 1, band - 2);
      }
      g.fillStyle = C.ivory;
      for (const w of views.rewatched) {
        const a = xOf((w.from / 100) * frames);
        const b = xOf(((w.to + 1) / 100) * frames);
        if (b < 0 || a > width) continue;
        g.fillRect(a, yViews + band - 1, Math.max(2, b - a), 1);
      }
    }

    // in/out (or the range being drawn): hatched like a marked section of film
    const rin = draft ? draft.in : inPt;
    const rout = draft ? draft.out : outPt;
    if (rin != null || rout != null) {
      const a = xOf(rin ?? 0);
      const b = xOf((rout ?? frames - 1) + 1);
      const pc = document.createElement('canvas');
      pc.width = pc.height = 8;
      const pg = pc.getContext('2d');
      if (!pg) return;
      // lit while a note is being written about it, or while the composer's head is pointed at
      pg.strokeStyle = withAlpha(C.ivory, hint.lit || writing ? 0.3 : 0.13);
      pg.lineWidth = 1.5;
      pg.beginPath();
      pg.moveTo(-2, 10);
      pg.lineTo(10, -2);
      pg.stroke();
      g.fillStyle = g.createPattern(pc, 'repeat') || 'transparent';
      g.fillRect(a, PERF, b - a, tall);
      g.fillStyle = C.ivory;
      if (rin != null) g.fillRect(a - 1, PERF, 2, tall);
      if (rout != null) g.fillRect(b - 1, PERF, 2, tall);
      // handles: a tab on each end, from the perforation strip into the ruler, with a grip in it — both ends of a
      // finished section can be dragged (at every zoom level)
      if (onRangeEdge && rin != null && rout != null && !draft) {
        for (const x of [a, b]) {
          g.fillStyle = C.ivory;
          if (g.roundRect) {
            g.beginPath();
            g.roundRect(x - 4, 0, 8, PERF + 7, [0, 0, 2.5, 2.5]);
            g.fill();
          } else g.fillRect(x - 4, 0, 8, PERF + 7);
          g.fillStyle = C.bg;
          g.fillRect(x - 1.5, 3, 1, PERF + 1);
          g.fillRect(x + 0.5, 3, 1, PERF + 1);
        }
      }
    }

    // what an action in the composer would make: a dashed outline over the lanes
    if (hint.ghost) {
      const a = xOf(hint.ghost.in);
      const b = Math.max(a + 2, xOf(hint.ghost.out + 1));
      g.fillStyle = withAlpha(C.ivory, 0.08);
      g.fillRect(a, PERF, b - a, tall);
      g.strokeStyle = withAlpha(C.ivory, 0.75);
      g.lineWidth = 1;
      g.setLineDash([3, 3]);
      g.strokeRect(a + 0.5, PERF + 0.5, b - a - 1, tall - 1);
      g.setLineDash([]);
    }

    // ruler: round times; zoomed far enough, one cell per frame with its number (a whole second's first frame also
    // with its timecode where that fits), so a frame can be picked by its cell
    const secPx = pxPerFrame * fps;
    const steps = [1 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const step = steps.find((s) => s * secPx >= 70) || 600;
    const minor = steps
      .filter((s) => s < step)
      .reverse()
      .find((s) => s * secPx >= 9);
    if (pxPerFrame >= 7) {
      g.fillStyle = C.grid;
      for (let f = Math.floor(v0); f <= v1; f++) g.fillRect(Math.round(xOf(f)), yWave, 1, wave);
    }
    if (pxPerFrame >= CELL_PX) {
      for (let f = Math.floor(v0); f < v1 && f < frames; f++) {
        const x = xOf(f);
        const tc = timecode(f, fps);
        const second = tc.endsWith(':00');
        if (f % 2) {
          g.fillStyle = C.lane;
          g.fillRect(x, yRuler, pxPerFrame, RULER);
        }
        g.fillStyle = second ? C.text : C.tick;
        g.fillRect(Math.round(x), yRuler + (second ? 0 : 6), 1, second ? RULER : RULER - 6);
        const label = second && g.measureText(tc).width + 8 <= pxPerFrame ? tc : String(f);
        const w = g.measureText(label).width;
        if (w + 6 > pxPerFrame || x + pxPerFrame > width) continue;
        g.fillStyle = C.text;
        g.fillText(label, x + (pxPerFrame - w) / 2, yRuler + RULER / 2 + 0.5);
      }
    } else {
      g.fillStyle = C.tick;
      if (minor) {
        const f0 = Math.floor(v0 / fps / minor) * minor;
        for (let t = f0; t * fps <= v1; t += minor) {
          const x = Math.round(xOf(t * fps)) + 0.5;
          g.fillRect(x, yRuler + RULER - 4, 1, 4);
        }
      }
      const t0 = Math.floor(v0 / fps / step) * step;
      for (let t = t0; t * fps <= v1 + 1; t += step) {
        const f = Math.round(t * fps);
        const x = Math.round(xOf(f)) + 0.5;
        g.fillStyle = C.tick;
        g.fillRect(x, yRuler + 3, 1, RULER - 3);
        const label = step < 1 ? timecode(f, fps) : timecode(f, fps).slice(0, -3);
        if (x + 6 + g.measureText(label).width > width) continue;
        g.fillStyle = C.text;
        g.fillText(label, x + 4, yRuler + RULER / 2 + 0.5);
      }
    }

    // a partial render's stretch: a quiet bar along the ruler's foot with its ends ticked, like a work area; the frame
    // where its seam jumps is the one mark that lights up (a keyframe in the brand's colour)
    if (patch) {
      const a = xOf(patch.in);
      const b = Math.max(a + 2, xOf(patch.out + 1));
      if (b >= 0 && a <= width) {
        g.fillStyle = withAlpha(C.ivory, 0.5);
        g.fillRect(a, yRuler + RULER - 2, b - a, 2);
        g.fillRect(a, yRuler + RULER - 7, 1, 7);
        g.fillRect(b - 1, yRuler + RULER - 7, 1, 7);
      }
      if (patch.jump !== null) {
        const x = xOf(patch.jump);
        const y = yRuler + RULER - 4;
        g.fillStyle = C.brand;
        g.beginPath();
        g.moveTo(x, y - 4);
        g.lineTo(x + 4, y);
        g.lineTo(x, y + 4);
        g.lineTo(x - 4, y);
        g.closePath();
        g.fill();
      }
    }

    // waveform (one peak per frame)
    if (peaks?.length) {
      const mid = yWave + wave / 2;
      const amp = wave / 2 - 3;
      const fin = rin ?? -1;
      const fout = rout ?? -1;
      for (let x = 0; x < width; x++) {
        const fa = Math.floor(v0 + x / pxPerFrame);
        const fb = Math.max(fa + 1, Math.floor(v0 + (x + 1) / pxPerFrame));
        let pk = 0;
        let r = 0;
        for (let f = fa; f < fb && f < peaks.length; f++) {
          if (peaks[f] > pk) pk = peaks[f];
          if (rms && rms[f] > r) r = rms[f];
        }
        if (!pk) continue;
        const inside = fin >= 0 && fout >= 0 && fa >= fin && fa <= fout;
        const hp = Math.max(1, Math.sqrt(pk) * amp);
        g.fillStyle = inside ? C.waveIn : C.wave;
        g.fillRect(x, mid - hp, 1, hp * 2);
        if (rms) {
          const hr = Math.max(0.5, Math.sqrt(r) * amp);
          g.fillStyle = inside ? C.waveRmsIn : C.waveRms;
          g.fillRect(x, mid - hr, 1, hr * 2);
        }
      }
    } else {
      g.fillStyle = C.text;
      g.fillText(peaks ? t('NO AUDIO') : t('WAVEFORM…'), 8, yWave + wave / 2);
    }

    // what changed since the previous version
    if (hasChg) {
      g.fillStyle = C.lane;
      g.fillRect(0, yChg, width, CHG);
      for (const r of changes || []) {
        const a = xOf(r.in);
        const b = Math.max(a + 2, xOf(r.out + 1));
        if (b < 0 || a > width) continue;
        if (r.kind === 'audio') {
          g.fillStyle = withAlpha(C.ivory, 0.35);
          for (let x = Math.floor(a); x < b; x += 3) g.fillRect(x, yChg + 5, 1.5, CHG - 7);
        } else {
          g.shadowColor = withAlpha(C.ivory, 0.6);
          g.shadowBlur = 6;
          g.fillStyle = C.ivory;
          g.fillRect(a, yChg + 2, b - a, 5);
          g.shadowBlur = 0;
        }
      }
      for (const t of retimes || []) {
        const x = xOf(t.frame);
        g.fillStyle = C.should;
        g.beginPath();
        g.moveTo(x - 4, yChg + 1);
        g.lineTo(x + 4, yChg + 1);
        g.lineTo(x, yChg + CHG - 1);
        g.closePath();
        g.fill();
      }
    }

    // freezes
    for (const r of freezes || []) {
      const a = xOf(r.in);
      const b = Math.max(a + 3, xOf(r.out + 1));
      g.fillStyle = r.quiet ? withAlpha(C.tick, 0.7) : withAlpha(C.must, 0.85);
      g.fillRect(a, yMarks + MARKS - 5, b - a, 4);
    }

    // segments (project timeline)
    if (segments?.length) {
      segments.forEach((s, i) => {
        const a = xOf(s.in);
        const b = xOf(s.out);
        if (b < 0 || a > width) return;
        g.fillStyle = i % 2 ? C.segA : C.segB;
        g.fillRect(a, ySeg + 1, Math.max(1, b - a - 1), SEG - 2);
      });
    }

    // words: each in its own box, the text clipped to it (shortened with … when it doesn't fit, left out when even that
    // wouldn't be readable); the whole word shows on hover
    if (words?.length) {
      g.font = "500 10.5px 'Instrument Sans Variable', -apple-system, sans-serif";
      for (const w of words) {
        const a = xOf(w.in);
        if (a > width) break;
        const b = xOf(w.out);
        if (b < 0) continue;
        const bw = Math.max(1, b - a - 1);
        g.fillStyle = C.words;
        g.fillRect(a, yWords + 3, bw, WORDS - 6);
        const label = fitText(g, w.w, bw - 6);
        if (!label) continue;
        g.save();
        g.beginPath();
        g.rect(a, yWords, bw, WORDS);
        g.clip();
        g.fillStyle = C.wordText;
        g.fillText(label, a + 3, yWords + WORDS / 2);
        g.restore();
      }
    }

    // comments: a range note is a bar from its first to its last frame under its keyframe (ticks at both ends); the
    // selected one also tints its stretch of the waveform
    const rows = rangeRows(comments);
    for (const c of comments || []) {
      const x = xOf(c.frameHere);
      const col = markerColor(C, c);
      if (c.rangeHere) {
        const a = xOf(c.rangeHere.in);
        const b = Math.max(a + 3, xOf(c.rangeHere.out + 1));
        if (b >= 0 && a <= width) {
          const faded = c.status === 'verified' || c.status === 'wontfix';
          const y = yMarks + barTop(rows, c.id);
          g.fillStyle = col;
          g.globalAlpha = faded ? 0.3 : 0.75;
          if (g.roundRect) {
            g.beginPath();
            g.roundRect(a, y, b - a, 4, 2);
            g.fill();
          } else g.fillRect(a, y, b - a, 4);
          g.fillRect(a, y - 2.5, 1.5, 8);
          g.fillRect(b - 1.5, y - 2.5, 1.5, 8);
          g.globalAlpha = 1;
          if (c.id === selected) {
            g.fillStyle = withAlpha(col, 0.14);
            g.fillRect(a, yWave, b - a, wave);
          }
        }
      }
      if (x < -8 || x > width + 8) continue;
      // A keyframe per note (ui/glyphs.ts), shape by what it is — the same glyphs as the notes panel: must solid,
      // should half, nice hollow, an idea a circle; a question an hourglass, an info note a square. A closed note fades.
      const cy = yMarks + 10;
      const look = noteKind(c);
      const shape: Shape = look === 'feedback' ? SEVERITY_SHAPE[c.severity] || 'half' : KIND_SHAPE[look];
      const k = 11 / 12;
      const glyph = glyphPath(shape);
      g.save();
      g.translate(x - 6 * k, cy - 6 * k);
      g.scale(k, k);
      g.fillStyle = col;
      if (c.status === 'verified' || c.status === 'wontfix') g.globalAlpha = 0.55;
      g.fill(glyph, 'evenodd');
      g.globalAlpha = 1;
      // outlines drawn in the glyph's own space, so they sit on its edge at any scale
      const ring = glyphPath('diamond');
      if (c.check_again) {
        g.strokeStyle = C.should;
        g.lineWidth = 1.5 / k;
        g.stroke(ring);
      }
      if (c.id === selected) {
        g.strokeStyle = C.selected;
        g.lineWidth = 1.5 / k;
        g.stroke(ring);
      }
      g.restore();
      if (c.id === selected) {
        g.fillStyle = withAlpha(C.selected, 0.25);
        g.fillRect(Math.round(x), yWave, 1, wave);
      }
    }

    // Auto-check findings: hollow diamonds in the top of the marks lane
    for (const q of findings || []) {
      const x = xOf(q.frame);
      if (x < -6 || x > width + 6) continue;
      const cy = yMarks + 4;
      g.beginPath();
      g.moveTo(x, cy - 4);
      g.lineTo(x + 4, cy);
      g.lineTo(x, cy + 4);
      g.lineTo(x - 4, cy);
      g.closePath();
      g.fillStyle = C.bg;
      g.fill();
      g.strokeStyle = C[q.severity] || C.nice;
      g.lineWidth = 1.5;
      g.stroke();
    }

    // zoomed: the whole video along the foot — the notes as ticks, the marked section, and the window as a box to drag
    // (the playhead on it is the overlay's, Playhead below)
    if (over) {
      const s = width / frames;
      g.fillStyle = C.film;
      g.fillRect(0, yOver, width, over);
      for (const c of comments || []) {
        g.fillStyle = markerColor(C, c);
        g.fillRect(Math.round(c.frameHere * s), yOver + 2, 1.5, over - 4);
      }
      if (rin != null || rout != null) {
        const a = (rin ?? 0) * s;
        g.fillStyle = withAlpha(C.ivory, 0.45);
        g.fillRect(a, yOver + 2, Math.max(2, ((rout ?? frames - 1) + 1) * s - a), over - 4);
      }
      const box = overviewBox([v0, v1], frames, width);
      g.fillStyle = withAlpha(C.ivory, 0.16);
      g.fillRect(box.x, yOver + 0.5, box.w, over - 1);
      g.strokeStyle = withAlpha(C.ivory, 0.8);
      g.lineWidth = 1;
      g.strokeRect(Math.round(box.x) + 0.5, yOver + 0.5, Math.max(3, Math.round(box.w) - 1), over - 1);
    }
  }, [
    width,
    height,
    wave,
    v0,
    v1,
    pxPerFrame,
    frames,
    fps,
    inPt,
    outPt,
    peaks,
    rms,
    comments,
    freezes,
    words,
    segments,
    selected,
    xOf,
    fontsReady,
    changes,
    retimes,
    hasChg,
    theme,
    lang,
    findings,
    draft,
    onRangeEdge,
    hint,
    views,
    band,
    marksTop,
    patch,
    writing,
    over,
    yWave,
  ]);

  // playhead: a frame-wide gate when zoomed in, an ivory line with a head in the perforation strip
  const gate = pxPerFrame > 3;
  const pw = Math.max(1.5, pxPerFrame);
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;

  // ---------------------------------------------------------------- pointer
  // A finger covers far more than a cursor: markers answer within 18 px of a touch, 7 px of a mouse.
  const hitComment = (x: number, y: number, touch = false) => {
    if (y < marksTop - (touch ? 8 : 0) || y > marksTop + MARKS + (touch ? 8 : 0)) return null;
    let best: TimelineComment | null = null;
    let bd = touch ? 18 : 7;
    const rows = rangeRows(comments);
    for (const c of comments || []) {
      let d = Math.abs(xOf(c.frameHere) - x);
      // a range note answers along its whole bar, on its own row (just less eagerly than a keyframe under the pointer)
      const top = marksTop + barTop(rows, c.id);
      const onBar = touch ? y >= top - 4 && y <= top + 8 : y >= top - 3 && y <= top + 6;
      if (c.rangeHere && onBar && x >= xOf(c.rangeHere.in) - 2 && x <= xOf(c.rangeHere.out + 1) + 2) d = Math.min(d, 1.5);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  };
  // The end of the in/out range under the pointer (a finger gets more room).
  const edgeAt = (x: number, touch = false): 'in' | 'out' | null => {
    if (!onRangeEdge || inPt == null || outPt == null) return null;
    const tol = touch ? 14 : 6;
    if (Math.abs(x - xOf(inPt)) <= tol) return 'in';
    if (Math.abs(x - xOf(outPt + 1)) <= tol) return 'out';
    return null;
  };
  const inLane = (y: number) => y >= marksTop && y <= marksTop + MARKS;
  const inViews = (y: number) => band > 0 && y >= PERF + RULER && y < marksTop;
  // the overview along the foot while zoomed (a finger gets a little more of the waveform above it)
  const inOver = (y: number, touch = false) => over > 0 && y >= height - over - (touch ? 6 : 1);
  const overFrame = (x: number) => Math.max(0, Math.min(frames - 1, Math.floor((x / width) * frames)));
  const startRange = (f: number) => {
    gesture.current = { kind: 'range', anchor: f, at: f, moved: false };
    drag.current = false;
    setBusy('range');
    setDraft({ in: f, out: f });
  };
  // Drawing a section or moving an end past the edge of a zoomed timeline brings more of the video into view.
  const nudge = (x: number) => {
    const past = x < 0 ? x : x > width ? x - width : 0;
    if (zoomed && past) setView((v) => clampView(v[0] + past / pxPerFrame / 3, v[1] - v[0], frames));
  };
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  const hitFinding = (x: number, y: number, touch = false) => {
    if (!findings?.length || y < marksTop - (touch ? 8 : 0) || y > marksTop + 10) return null;
    let best: TimelineFinding | null = null;
    let bd = touch ? 18 : 6;
    for (const q of findings) {
      const d = Math.abs(xOf(q.frame) - x);
      if (d < bd) {
        bd = d;
        best = q;
      }
    }
    return best;
  };
  const wordAt = (y: number, f: number) => {
    if (!words?.length || y < height - over - WORDS || y >= height - over) return null;
    return words.find((w) => f >= w.in && f < w.out)?.w ?? null;
  };
  const pos = (e: ReactPointerEvent) => {
    const r = (cv.current as HTMLCanvasElement).getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const scrub = useRef<{ raf: number; f: number | null; last: number | null }>({ raf: 0, f: null, last: null });
  useEffect(() => () => cancelAnimationFrame(scrub.current.raf), []);
  const seekSoon = (f: number) => {
    const s = scrub.current;
    s.f = f;
    if (s.raf) return;
    s.raf = requestAnimationFrame(() => {
      s.raf = 0;
      if (s.f !== null && s.f !== s.last) {
        s.last = s.f;
        onSeek(s.f);
      }
    });
  };
  // Two fingers pinch-zoom around their midpoint (the view they started from, scaled by the spread); one finger scrubs.
  const touches = useRef(new Map<number, number>());
  const pinch = useRef<{ d0: number; view: View; anchor: number } | null>(null);
  const startPinch = () => {
    const xs = [...touches.current.values()];
    if (xs.length !== 2) return;
    const [a, b] = view;
    const mid = (xs[0] + xs[1]) / 2;
    pinch.current = { d0: Math.max(12, Math.abs(xs[0] - xs[1])), view: [a, b], anchor: a + mid / (width / (b - a)) };
    drag.current = false;
    setHover(null);
  };
  const movePinch = () => {
    const p = pinch.current;
    const xs = [...touches.current.values()];
    if (!p || xs.length !== 2) return;
    const d = Math.max(12, Math.abs(xs[0] - xs[1]));
    setView(zoomAround(p.view, p.d0 / d, p.anchor, frames));
  };
  const down = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const [x, y] = pos(e);
    const touch = e.pointerType === 'touch';
    if (touch) {
      touches.current.set(e.pointerId, x);
      if (touches.current.size === 2) {
        cancelPress();
        gesture.current = null;
        setDraft(null);
        e.currentTarget.setPointerCapture(e.pointerId);
        return startPinch();
      }
    }
    // the overview: its box is taken where it was pressed (elsewhere, the box jumps there) and moves along the video
    if (inOver(y, touch)) {
      const f = (x / width) * frames;
      const grab = f >= v0 && f <= v1 ? f - (v0 + v1) / 2 : 0;
      gesture.current = { kind: 'pan', grab };
      setBusy('pan');
      setView((v) => panTo(v, f - grab, frames));
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    const edge = edgeAt(x, touch);
    if (edge && inPt != null && outPt != null) {
      // Dragging an end shows its frame on the stage as it moves; letting go shows the range's start again.
      gesture.current = { kind: 'edge', edge, start: inPt, at: edge === 'in' ? inPt : outPt };
      setBusy('edge');
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    const c = hitComment(x, y, touch);
    if (c) {
      onSelect(c.id);
      return;
    }
    const q = hitFinding(x, y, touch);
    if (q && onPickFinding) {
      onPickFinding(q.key);
      return;
    }
    const f = fOf(x);
    e.currentTarget.setPointerCapture(e.pointerId);
    // Across the notes lane, or with shift anywhere: a range. A plain click there still seeks (on release).
    if (onRange && !touch && (e.shiftKey || inLane(y))) return startRange(f);
    drag.current = true;
    scrub.current.last = f;
    onSeek(f);
    if (touch) {
      setHover({ x, f, c: null, q: null, w: null, touch: true });
      // Held still: the finger draws a range from here instead of scrubbing.
      if (onRange) {
        cancelPress();
        const id = e.pointerId;
        press.current = {
          x,
          id,
          timer: setTimeout(() => {
            press.current = null;
            if (!touches.current.has(id) || touches.current.size !== 1) return;
            startRange(f);
            navigator.vibrate?.(8);
          }, LONG_PRESS_MS),
        };
      }
    }
  };
  const move = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const [x, y] = pos(e);
    const g0 = gesture.current;
    if (g0?.kind === 'pan') {
      setView((v) => panTo(v, (x / width) * frames - g0.grab, frames));
      return;
    }
    if (g0?.kind === 'edge') {
      nudge(x);
      // an end stops at the other one: a section is at least a frame long, its start never after its end
      const f = g0.edge === 'in' ? Math.min(fOf(x), outPt ?? frames - 1) : Math.max(fOf(x), inPt ?? 0);
      g0.at = f;
      if (g0.edge === 'in') g0.start = f;
      onRangeEdge?.(g0.edge, f);
      seekSoon(f);
      setHover({ x, f, c: null, q: null, w: null, touch: e.pointerType === 'touch', zone: 'edge', edge: g0.edge });
      return;
    }
    if (g0?.kind === 'range') {
      nudge(x);
      const f = fOf(x);
      if (f !== g0.anchor) g0.moved = true;
      g0.at = f;
      setDraft({ in: Math.min(g0.anchor, f), out: Math.max(g0.anchor, f) });
      setHover({ x, f, c: null, q: null, w: null, touch: e.pointerType === 'touch', zone: 'lane' });
      return;
    }
    if (e.pointerType === 'touch' && touches.current.has(e.pointerId)) {
      touches.current.set(e.pointerId, x);
      if (press.current && Math.abs(press.current.x - x) > 8) cancelPress();
      if (pinch.current) return movePinch();
      if (!drag.current) return;
    }
    const touch = e.pointerType === 'touch';
    const overview = !drag.current && inOver(y, touch);
    const f = overview ? overFrame(x) : fOf(x);
    if (drag.current) seekSoon(f);
    if (!touch) setShift(e.shiftKey);
    const c = touch || overview ? null : hitComment(x, y);
    const q = touch || c || overview ? null : hitFinding(x, y);
    const w = overview ? null : wordAt(y, f);
    const edge = touch || c || q || overview ? null : edgeAt(x);
    const zone = overview ? 'over' : touch || c || q ? null : edge ? 'edge' : onRange && inLane(y) ? 'lane' : inViews(y) ? 'views' : null;
    setHover((h) =>
      h && h.f === f && h.c === c && h.q === q && h.w === w && h.zone === zone && h.edge === edge && Math.abs(h.x - x) < 1
        ? h
        : { x, f, c, q, w, touch, zone, edge },
    );
  };
  const up = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    cancelPress();
    const g0 = gesture.current;
    gesture.current = null;
    setBusy(null);
    if (g0?.kind === 'range') {
      // from the gesture, not `draft`: that is the last render's, and on a busy machine the release comes before the
      // last moves have rendered — the section would end a few frames short of where it was let go
      const r = { in: Math.min(g0.anchor, g0.at), out: Math.max(g0.anchor, g0.at) };
      setDraft(null);
      if (g0.moved && r.out > r.in) onRange?.(r);
      else onSeek(g0.anchor);
    }
    // an end let go: back to where the range starts (the note's frame), after the last frame the drag showed
    if (g0?.kind === 'edge') {
      const s = scrub.current;
      if (s.raf) cancelAnimationFrame(s.raf);
      s.raf = 0;
      s.f = null;
      s.last = g0.start;
      onSeek(g0.start);
    }
    drag.current = false;
    if (e.pointerType === 'touch') {
      touches.current.delete(e.pointerId);
      if (touches.current.size < 2) pinch.current = null;
      setHover(null);
    }
  };

  const section = inPt != null && outPt != null ? { in: Math.min(inPt, outPt), out: Math.max(inPt, outPt) } : null;
  const label = draft
    ? formatRange(draft, fps)
    : busy === 'edge' && section
      ? formatRange(section, fps)
      : hover?.c
        ? `${hover.c.rangeHere ? formatRange(hover.c.rangeHere, fps) : hover.c.id} · ${hover.c.text?.slice(0, 40) || hover.c.timecode}`
        : hover?.q
          ? `${t('Auto-check')} · ${hover.q.label}`
          : hover?.zone === 'edge' && section
            ? timecode(hover.edge === 'out' ? section.out : section.in, fps)
            : hover?.zone === 'views' && views
              ? `${timecode(hover.f, fps)} · ${viewsWords(views, hover.f, frames)}`
              : hover
                ? `${timecode(hover.f, fps)}${hover.w ? ` · ${hover.w}` : hover.zone === 'lane' ? '' : ` · f${hover.f}`}${patch && !hover.w && hover.zone !== 'lane' && hover.f >= patch.in && hover.f <= patch.out ? ` · ${patch.label}` : ''}`
                : '';
  // The quiet line beside it: what dragging does here (a mouse only; a finger holds, then drags)
  const tip =
    draft || busy || !hover || hover.touch || hover.c || hover.q || hover.zone === 'views'
      ? null
      : hover.zone === 'edge'
        ? hover.edge === 'out'
          ? t('Drag to move the end')
          : t('Drag to move the start')
        : hover.zone === 'over'
          ? t('Drag to move along the video')
          : !onRange
            ? null
            : hover.zone === 'lane' || shift
              ? t('Drag to mark a section')
              : t('⇧ drag to mark a section');
  const cursor =
    busy === 'pan'
      ? 'grabbing'
      : hover?.zone === 'over'
        ? 'grab'
        : hover?.c || hover?.q
          ? 'pointer'
          : busy === 'edge' || hover?.zone === 'edge'
            ? 'ew-resize'
            : draft || hover?.zone === 'lane' || (shift && onRange)
              ? 'crosshair'
              : 'col-resize';
  // The marked section's chip: low inside it (on the waveform), beside a handle when the section is too narrow; it
  // steps aside while the section is drawn or an end is dragged (the hover then names the range), and goes with the
  // section out of view.
  const chip = useRef<HTMLElement>(null);
  const [chipW, setChipW] = useState(160);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the chip's width changes only with its words
  useLayoutEffect(() => {
    const w = chip.current?.offsetWidth;
    if (w && Math.abs(w - chipW) > 0.5) setChipW(w);
  }, [section?.in, section?.out, touchScreen]);
  const sa = section ? xOf(section.in) : 0;
  const sb = section ? xOf(section.out + 1) : 0;
  const showChip = !!section && !draft && busy !== 'edge' && sb >= 0 && sa <= width;
  const level = zoomLevel(view, frames);
  const cells = pxPerFrame >= CELL_PX;
  // The zoom's tip: once per browser, for a video long enough to want it, until dismissed or the timeline is zoomed.
  const [hintPrefs, setHintPref] = usePrefs(HINT_KEY, NO_TAB);
  const [hintGone, setHintGone] = useState(false);
  const hinting = !hintPrefs.seen && !hintGone && frames > HINT_SECONDS * fps;
  useEffect(() => {
    if (hinting && zoomed) setHintPref('seen', true);
  }, [hinting, zoomed, setHintPref]);
  const zoomHint =
    hinting && !zoomed && !zoomTipWaits
      ? {
          touch: touchScreen,
          onDismiss: () => {
            setHintGone(true);
            setHintPref('seen', true);
          },
        }
      : null;
  const zoomControl = (
    <ZoomControl
      level={level}
      frames={frames}
      section={!!section}
      compact={phone}
      client={client}
      hint={zoomHint}
      onIn={() => zoom(0.5, frameRef.current)}
      onOut={() => zoom(2, frameRef.current)}
      onToggle={() => (zoomed ? setView(fitView(frames)) : toTarget())}
    />
  );
  // the hover's chip stays whole inside the timeline, however long its words
  const hoverEl = useRef<HTMLDivElement>(null);
  const [hoverW, setHoverW] = useState(80);
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured when its words change
  useLayoutEffect(() => {
    const w = hoverEl.current?.offsetWidth;
    if (w && Math.abs(w - hoverW) > 0.5) setHoverW(w);
  }, [label, tip]);
  // The frame preview: as wide as a thumbnail for wide pictures, as tall as one for tall ones.
  const pw0 = aspect >= 1 ? 176 : Math.round(118 * aspect);
  const ph0 = Math.round(pw0 / aspect);
  const tile = hover && sprite && !hover.touch ? spriteBackground(spriteTile(hover.f / frames)) : null;
  return (
    <div className="tl-wrap">
      {zoomAt === undefined && <div className="tl-head">{zoomControl}</div>}
      {zoomAt && createPortal(zoomControl, zoomAt)}
      {tile && hover && (
        <div
          className="tl-preview"
          style={{
            left: Math.min(Math.max(hover.x, pw0 / 2 + 2), width - pw0 / 2 - 2),
            width: pw0,
            height: ph0,
            backgroundImage: `url("${sprite}")`,
            backgroundSize: tile.size,
            backgroundPosition: tile.position,
          }}
          aria-hidden="true"
        />
      )}
      <div
        className="timeline"
        ref={wrap}
        onPointerLeave={() => setHover(null)}
        // what the canvas shows for the composer, readable without its pixels (suites, and a hint for devtools)
        data-lit={hint.lit || undefined}
        data-ghost={hint.ghost ? `${hint.ghost.in}-${hint.ghost.out}` : undefined}
        // the viewers band, readable without its pixels: the hundredths anyone watched, and the rewatched stretches
        data-views={band && views ? views.retention.filter((r) => r > 0).length : undefined}
        data-rewatched={band && views?.rewatched.length ? views.rewatched.map((w) => `${w.from}-${w.to}`).join(' ') : undefined}
        // a partial render's patched stretch and where its seam jumps
        data-part={patch ? `${patch.in}-${patch.out}` : undefined}
        data-seam={patch ? (patch.jump === null ? 'clean' : `jump:${patch.jump}`) : undefined}
        // the window while zoomed (first frame–end), and whether every frame is a cell of its own
        data-view={zoomed ? `${Math.round(v0 * 100) / 100}-${Math.round(v1 * 100) / 100}` : undefined}
        data-cells={cells || undefined}
        data-writing={(writing && !!section) || undefined}
      >
        <canvas ref={cv} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} style={{ cursor }} />
        <Playhead
          frame={frame}
          live={live}
          x={(f) => Math.round((xOf(f) + (gate ? pw / 2 : 0)) * dpr) / dpr}
          height={height - over}
          gate={gate ? pw : 0}
          over={over ? { x: (f) => Math.round(((f + 0.5) / frames) * width * dpr) / dpr, top: height - over, height: over } : null}
        />
        {showChip && section && (
          <SectionChip
            ref={chip}
            section={section}
            fps={fps}
            frames={frames}
            frame={frame}
            live={live}
            writing={writing}
            touch={touchScreen}
            client={client}
            onNote={onMarkNote}
            onClear={onMarkClear}
            onEdge={onRangeEdge}
            onZoom={toTarget}
            style={{ left: chipLeft(sa, sb, chipW, width), top: yWave + Math.max(2, wave - 23) }}
          />
        )}
        {hover && (label || tip) && (
          <div className="tl-hover" ref={hoverEl} style={{ left: Math.min(Math.max(hover.x, hoverW / 2 + 2), width - hoverW / 2 - 2) }}>
            {label && <span data-testid="tl-hover">{label}</span>}
            {tip && (
              <span className="tl-tip" data-testid="tl-tip">
                {tip}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** What the viewers band says at a frame: how many of the viewers watched it, and whether it was watched again. */
function viewsWords(views: NonNullable<TimelineProps['views']>, f: number, frames: number): string {
  const part = Math.min(99, Math.max(0, Math.floor((f / Math.max(1, frames)) * 100)));
  const pct = Math.round((views.retention[part] ?? 0) * 100);
  const again = views.rewatched.find((w) => part >= w.from && part <= w.to);
  const seen = t('{n} % of viewers watched this', { n: pct });
  return again ? `${seen} · ${t('played {n}×', { n: again.plays })}` : seen;
}

/** `text`, or as much of it as fits in `max` px with an ellipsis; null when not even three letters would. */
function fitText(g: CanvasRenderingContext2D, text: string, max: number): string | null {
  if (max <= 0) return null;
  if (g.measureText(text).width <= max) return text;
  for (let n = text.length - 1; n >= 3; n--) {
    const t = `${text.slice(0, n)}…`;
    if (g.measureText(t).width <= max) return t;
  }
  return null;
}

const still = () => () => {};

/** The playhead alone renders per frame while playing (it reads the live frame when there is one); zoomed, a tick on the
 * overview shows where it is in the whole video. */
function Playhead({
  frame,
  live,
  x,
  height,
  gate,
  over,
}: {
  frame: number;
  live?: FrameStore;
  x: (f: number) => number;
  height: number;
  gate: number;
  over: { x: (f: number) => number; top: number; height: number } | null;
}) {
  const f = useSyncExternalStore(live ? live.subscribe : still, live ? live.get : () => frame);
  return (
    <>
      <div className="tl-playhead" style={{ transform: `translate3d(${x(f)}px,0,0)`, height }}>
        {gate > 0 && <div className="tl-gate" style={{ width: gate, left: -gate / 2 }} />}
      </div>
      {over && <div className="tl-over-head" style={{ transform: `translate3d(${over.x(f)}px,0,0)`, top: over.top, height: over.height }} />}
    </>
  );
}
