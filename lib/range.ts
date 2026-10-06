// A note about a stretch of the video ("from 0:12 to 0:14 the music is too loud"): its range of frames, how people and
// agents read it, and which frames stand for it in a picture. Shared with the browser: no Node imports here.
import { timecode, timeToFrame } from './time.ts';
import type { FrameRange } from './types.ts';

/** Frames in a range, both ends included. */
export const rangeFrames = (r: FrameRange): number => r.out - r.in + 1;

/** How long a range plays, in seconds (both end frames included). */
export const rangeSeconds = (r: FrameRange, fps: number): number => rangeFrames(r) / fps;

/** "2.3 s", "0.52 s" (short ranges keep two decimals), "12 s", "1:05 min". */
export function formatSeconds(s: number): string {
  if (s >= 60) {
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.round(s - m * 60)).padStart(2, '0')} min`;
  }
  if (s >= 10) return `${Math.round(s)} s`;
  // under a second two decimals, without a trailing zero (0.7 s, 0.04 s)
  return `${s < 1 ? String(Number(s.toFixed(2))) : s.toFixed(1)} s`;
}

/** "00:12:03 → 00:14:10" */
export const rangeTimecodes = (r: FrameRange, fps: number): string => `${timecode(r.in, fps)} → ${timecode(r.out, fps)}`;

/** "00:12:03 → 00:14:10 · 2.3 s": how the player and the client page show a range. */
export const formatRange = (r: FrameRange, fps: number): string => `${rangeTimecodes(r, fps)} · ${formatSeconds(rangeSeconds(r, fps))}`;

/** "00:12:03 → 00:14:10 (f360–f372, 2.3 s)": how agents read a range (vr show, INBOX.md, MCP). */
export const describeRange = (r: FrameRange, fps: number): string => `${rangeTimecodes(r, fps)} (f${r.in}–f${r.out}, ${formatSeconds(rangeSeconds(r, fps))})`;

/**
 * A range as the store keeps it: whole frames, in ≤ out (a range given backwards is turned round), inside a render of
 * `frames` frames. Throws on anything else — a range past the end of the render is a mistake, not something to clip
 * quietly. A single frame (in = out) is fine; null stays null.
 */
export function normalizeRange(r: FrameRange | null | undefined, frames: number): FrameRange | null {
  if (!r) return null;
  if (!Number.isFinite(r.in) || !Number.isFinite(r.out)) throw new Error('a range needs two frame numbers');
  const a = Math.round(Math.min(r.in, r.out));
  const b = Math.round(Math.max(r.in, r.out));
  if (a < 0) throw new Error(`the range starts before the first frame (f${a})`);
  if (frames > 0 && b > frames - 1) throw new Error(`the range ends after the last frame (f${b}; the render has frames 0–${frames - 1})`);
  return { in: a, out: b };
}

/**
 * The frames that stand for a range in one picture: the first and the last and, between them, as evenly spread as
 * whole frames allow — at most `max` (every frame of a range shorter than that). Ascending, no repeats.
 */
export function stripFrames(r: FrameRange, max = 6): number[] {
  const n = rangeFrames(r);
  if (n <= 0) return [];
  const count = Math.max(1, Math.min(max, n));
  if (count === 1) return [r.in];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const f = r.in + Math.round((i * (n - 1)) / (count - 1));
    if (out.at(-1) !== f) out.push(f);
  }
  return out;
}

/** Where a range note's own frame sits: where it was written if that is inside the range, else the range's start. */
/**
 * Rows for range bars drawn in one lane: a range that overlaps or touches one on row 0 goes to row 1 (more than two
 * at once share row 1), so two stretches never read as one bar. Keyed by id; notes without a range are left out.
 */
export function rangeRows(items: { id: string; rangeHere?: FrameRange | null }[] | undefined): Map<string, number> {
  const rows = new Map<string, number>();
  const ends = [-1, -1];
  const ranged = (items || []).filter((x): x is { id: string; rangeHere: FrameRange } => !!x.rangeHere);
  for (const c of ranged.sort((a, b) => a.rangeHere.in - b.rangeHere.in)) {
    const row = c.rangeHere.in > ends[0] ? 0 : 1;
    ends[row] = Math.max(ends[row], c.rangeHere.out);
    rows.set(c.id, row);
  }
  return rows;
}

export const frameInRange = (frame: number, r: FrameRange | null): number => (r && (frame < r.in || frame > r.out) ? r.in : frame);

/**
 * A range on the frame grid of a render with another frame rate (the same times in seconds): from the frame on screen
 * when its first frame starts through the frame on screen when its last frame ends, within the render's `frames`.
 * Mapping the last frame by its start (like a single frame) would drop the rest of it.
 */
export function rangeOnGrid(r: FrameRange, fromFps: number, toFps: number, frames: number): FrameRange {
  const last = Math.max(0, frames - 1);
  const start = Math.min(timeToFrame(r.in / fromFps, toFps), last);
  // The frame before the one that starts at (or after) the range's end; the epsilon absorbs float error at an exact edge.
  const end = Math.ceil(((r.out + 1) * toFps) / fromFps - 1e-6) - 1;
  return { in: start, out: Math.max(start, Math.min(end, last)) };
}
