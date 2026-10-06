// Recorded feedback: what someone said while they watched becomes draft notes on the frames that were on screen.
// Pure and browser-safe (no Node imports): the server makes the drafts once the speech engine has heard the audio
// (lib/recordings.ts), the tests feed it synthetic words and event logs.
//
// The recording's clock is the audio's: every event carries its second on it (types.ts RecordingEvent), and so does
// every word the engine heard. Which frame a word was said on is therefore read from the event log, never guessed from
// the wall clock: the last frame event at or before the word.
//
// One draft per utterance: words run together until a pause (≥ PAUSE_SPLIT s), a sentence end followed by a breath
// (≥ SENTENCE_GAP s), or a jump to another frame (a seek between two words). Fragments shorter than MIN_WORDS words and
// MIN_SECONDS join the neighbour on the same stretch of video. Said while the video stood on one frame → a note on that
// frame; said while it played (or was stepped) across frames → a range note from the first frame to the last. The
// pointer resting (or a click) on the picture while it was said → a spot, drawn as a ring; shapes drawn meanwhile → the
// note's drawing. Shapes drawn with nothing said near them still become drafts (a drawing is feedback too). Every draft
// is feedback, also one that ends with a question mark: a person's "can we …?" asks for a change; questions are what
// agents ask people.
import { autoTags } from './autotag.ts';
import type { FrameRange, Point, RecordingDraft, RecordingEvent, Shape } from './types.ts';

/** A recording is at most ten minutes; its event log at most this many entries. */
export const RECORDING_MAX_SECONDS = 600;
export const RECORDING_MAX_EVENTS = 40_000;
/** How often the recorder writes down the frame while the video plays (seconds), and the pointer (while over it). */
export const FRAME_SAMPLE = 0.05;
export const POINTER_SAMPLE = 0.1;

export const PAUSE_SPLIT = 0.8;
/** A recorded note's own clip: a little before its first word and after its last, so none is cut. */
export function clipBounds(t0: number, t1: number): { from: number; to: number } {
  const from = Math.max(0, t0 - 0.25);
  return { from, to: Math.max(from + 0.3, t1 + 0.35) };
}
const SENTENCE_GAP = 0.35;
const MIN_WORDS = 3;
const MIN_SECONDS = 0.8;
/** A seek this close to a word boundary counts as between the two words. */
const SEEK_SLACK = 0.05;
/** The pointer and shapes count for an utterance a little before and after it (people point, then talk). */
const POINTER_REACH = 0.4;
const STROKE_REACH = 1.2;
/** A rest: the pointer stays within this distance (share of the picture's diagonal-ish, normalized units) this long. */
const REST_RADIUS = 0.035;
const REST_SECONDS = 0.6;
/** Pointer samples further apart than this: it left the picture in between. */
const POINTER_GAP = 0.35;
/** Shapes drawn with nothing said: one draft per frame, shapes within this many seconds of each other together. */
const STROKES_TOGETHER = 3;

export interface HeardWord {
  text: string;
  t0: number;
  t1: number;
}

export interface SegmentInput {
  words: readonly HeardWord[];
  events: readonly RecordingEvent[];
  /** The version the recording was made on. */
  fps: number;
  frames: number;
  width: number;
  height: number;
  /** New draft ids (the caller's randomness; tests pass a counter). */
  newId: () => string;
}

const clampFrame = (f: number, frames: number) => Math.max(0, Math.min(frames - 1, Math.round(f)));
const byTime = <T extends { t: number }>(list: readonly T[]) => [...list].sort((a, b) => a.t - b.t);

/** The frame on screen at second `t`: the last frame (or seek) event at or before it; the first one before any. */
export function frameAt(events: readonly RecordingEvent[], t: number): number {
  let f: number | null = null;
  for (const e of events) {
    if (e.k !== 'frame' && e.k !== 'seek') continue;
    if (e.t > t) break;
    f = e.f;
  }
  if (f !== null) return f;
  const first = events.find((e) => e.k === 'frame' || e.k === 'seek');
  return first && 'f' in first ? first.f : 0;
}

/** Whether the video was playing at second `t` (it starts paused unless the first play/pause says otherwise). */
export function playingAt(events: readonly RecordingEvent[], t: number): boolean {
  let playing = false;
  for (const e of events) {
    if (e.t > t) break;
    if (e.k === 'play') playing = true;
    if (e.k === 'pause') playing = false;
  }
  return playing;
}

// "ähm", "uh" and friends at the edges of what was said (never inside it: they may be words there).
const FILLER = /^(?:äh+m*|ähm|öh+m*|hm+|uh+m*|um+|erm+|ehm+)[,.…]*$/i;

/** What was heard, lightly cleaned: fillers off the edges, spaces collapsed, a capital first letter. */
export function cleanText(words: readonly string[]): string {
  const list = words.map((w) => w.trim()).filter(Boolean);
  while (list.length && FILLER.test(list[0])) list.shift();
  while (list.length && FILLER.test(list[list.length - 1])) list.pop();
  const s = list
    .join(' ')
    .replace(/\s+([,.;:!?…])/g, '$1')
    .trim();
  return s ? s[0].toLocaleUpperCase() + s.slice(1) : '';
}

const endsSentence = (w: string) => /[.!?…]["'»”)]*$/.test(w.trim());

/** Words into utterances: pauses, sentence ends with a breath, and jumps split them; short fragments join a neighbour. */
export function utterances(words: readonly HeardWord[], events: readonly RecordingEvent[]): HeardWord[][] {
  const list = [...words].filter((w) => w.text.trim() && Number.isFinite(w.t0) && Number.isFinite(w.t1)).sort((a, b) => a.t0 - b.t0);
  const seeks = events.filter((e) => e.k === 'seek').map((e) => e.t);
  const seekBetween = (a: HeardWord, b: HeardWord) => seeks.some((s) => s >= a.t1 - SEEK_SLACK && s <= b.t0 + SEEK_SLACK);
  const groups: HeardWord[][] = [];
  let cur: HeardWord[] = [];
  for (const w of list) {
    const prev = cur[cur.length - 1];
    if (prev) {
      const gap = w.t0 - prev.t1;
      if (gap >= PAUSE_SPLIT || (endsSentence(prev.text) && gap >= SENTENCE_GAP) || seekBetween(prev, w)) {
        groups.push(cur);
        cur = [];
      }
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);
  // Fragments ("okay", "and here") join the neighbour they belong to: not across a jump, the nearer one in time.
  const short = (g: HeardWord[]) => g.length < MIN_WORDS && g[g.length - 1].t1 - g[0].t0 < MIN_SECONDS;
  for (let i = 0; i < groups.length && groups.length > 1; ) {
    const g = groups[i];
    if (!short(g)) {
      i++;
      continue;
    }
    const before = i > 0 && !seekBetween(groups[i - 1][groups[i - 1].length - 1], g[0]) ? groups[i - 1] : null;
    const after = i < groups.length - 1 && !seekBetween(g[g.length - 1], groups[i + 1][0]) ? groups[i + 1] : null;
    const gapBefore = before ? g[0].t0 - before[before.length - 1].t1 : Number.POSITIVE_INFINITY;
    const gapAfter = after ? after[0].t0 - g[g.length - 1].t1 : Number.POSITIVE_INFINITY;
    if (before && gapBefore <= gapAfter) {
      before.push(...g);
      groups.splice(i, 1);
    } else if (after) {
      after.unshift(...g);
      groups.splice(i, 1);
    } else i++;
  }
  return groups;
}

/** The frames on screen from second t0 to t1: where it started, every change in between, where it ended. */
function framesDuring(events: readonly RecordingEvent[], t0: number, t1: number): number[] {
  const out = [frameAt(events, t0)];
  for (const e of events) {
    if (e.t <= t0) continue;
    if (e.t > t1) break;
    if (e.k === 'frame' || e.k === 'seek') out.push(e.f);
  }
  out.push(frameAt(events, t1));
  return out;
}

/** Where the pointer pointed while something was said: the last click, else its longest rest; null when neither. */
export function spotDuring(events: readonly RecordingEvent[], t0: number, t1: number): Point | null {
  const from = t0 - POINTER_REACH;
  const to = t1 + POINTER_REACH;
  let click: Point | null = null;
  const samples: { t: number; x: number; y: number }[] = [];
  for (const e of events) {
    if (e.t < from) continue;
    if (e.t > to) break;
    if (e.k === 'click') click = [e.x, e.y];
    if (e.k === 'pointer' || e.k === 'click') samples.push({ t: e.t, x: e.x, y: e.y });
  }
  if (click) return click;
  let best: { secs: number; x: number; y: number } | null = null;
  let start = 0;
  for (let i = 1; i <= samples.length; i++) {
    const anchor = samples[start];
    const s = samples[i];
    const breaks = !s || s.t - samples[i - 1].t > POINTER_GAP || Math.hypot(s.x - anchor.x, s.y - anchor.y) > REST_RADIUS;
    if (!breaks) continue;
    const run = samples.slice(start, i);
    const secs = run[run.length - 1].t - run[0].t;
    if (secs >= REST_SECONDS && (!best || secs > best.secs)) {
      best = { secs, x: run.reduce((a, p) => a + p.x, 0) / run.length, y: run.reduce((a, p) => a + p.y, 0) / run.length };
    }
    start = i;
  }
  return best ? [best.x, best.y] : null;
}

/** A spot as a shape the marked screenshot draws: a ring around it (freehand, closed), in video pixels. */
export function ringAt(spot: Point, width: number, height: number): Shape {
  const r = Math.max(12, Math.round(Math.min(width, height) * 0.045));
  const cx = spot[0] * width;
  const cy = spot[1] * height;
  const points: Point[] = [];
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    points.push([Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r)]);
  }
  return { type: 'freehand', points };
}

interface Stroke {
  t: number;
  f: number;
  shape: Shape;
}

/** The drafts a recording makes, in the order they were said. */
export function segmentRecording(input: SegmentInput): RecordingDraft[] {
  const events = byTime(input.events);
  const { frames, width, height, newId } = input;
  const groups = utterances(input.words, events);
  const strokes: Stroke[] = events
    .filter((e): e is Extract<RecordingEvent, { k: 'stroke' }> => e.k === 'stroke')
    .map((e) => ({ t: e.t, f: e.f, shape: e.shape }));

  // Every shape goes to the utterance nearest in time, when one is near enough; the rest make drafts of their own.
  const mine = groups.map(() => [] as Stroke[]);
  const loose: Stroke[] = [];
  for (const s of strokes) {
    let best = -1;
    let bestGap = Number.POSITIVE_INFINITY;
    groups.forEach((g, i) => {
      const t0 = g[0].t0;
      const t1 = g[g.length - 1].t1;
      const gap = s.t < t0 ? t0 - s.t : s.t > t1 ? s.t - t1 : 0;
      if (gap <= STROKE_REACH && gap < bestGap) {
        best = i;
        bestGap = gap;
      }
    });
    if (best >= 0) mine[best].push(s);
    else loose.push(s);
  }

  const drafts: RecordingDraft[] = groups.map((g, i) => {
    const t0 = g[0].t0;
    const t1 = g[g.length - 1].t1;
    const seen = framesDuring(events, t0, t1).map((f) => clampFrame(f, frames));
    const lo = Math.min(...seen);
    const hi = Math.max(...seen);
    let range: FrameRange | null = hi > lo ? { in: lo, out: hi } : null;
    let frame = range ? range.in : seen[0];
    const drawn = mine[i];
    // A shape belongs to the frame it was drawn on: the note sits there (inside its range, when it has one).
    if (drawn.length) {
      const f = clampFrame(drawn[drawn.length - 1].f, frames);
      if (range && (f < range.in || f > range.out)) range = { in: Math.min(range.in, f), out: Math.max(range.out, f) };
      frame = f;
    }
    const heard = cleanText(g.map((w) => w.text));
    const spot = drawn.length ? null : spotDuring(events, t0, t1);
    const drawing = drawn.length ? drawn.map((s) => s.shape) : spot ? [ringAt(spot, width, height)] : [];
    return {
      id: newId(),
      frame,
      range,
      text: heard,
      heard,
      severity: 'should',
      tags: autoTags(heard),
      drawing,
      t0: round3(t0),
      t1: round3(t1),
      ...(spot ? { spot: [round3(spot[0]), round3(spot[1])] as Point } : {}),
    };
  });

  // Shapes drawn with nothing said: one draft per frame drawn on, shapes close in time together.
  const alone: Stroke[][] = [];
  for (const s of loose) {
    const last = alone[alone.length - 1];
    const prev = last?.[last.length - 1];
    if (prev && prev.f === s.f && s.t - prev.t <= STROKES_TOGETHER) last.push(s);
    else alone.push([s]);
  }
  for (const set of alone)
    drafts.push({
      id: newId(),
      frame: clampFrame(set[0].f, frames),
      range: null,
      text: '',
      heard: '',
      severity: 'should',
      tags: [],
      drawing: set.map((s) => s.shape),
      t0: round3(set[0].t),
      t1: round3(set[set.length - 1].t),
    });
  return drafts.sort((a, b) => a.t0 - b.t0);
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
