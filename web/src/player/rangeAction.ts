// What the composer offers to change a note's moment, from the frame on screen — one action that names the frame it
// uses, or nothing to do (and a line that says how). Browser-safe and pure, so the composer and its tests agree.
import type { FrameRange } from '../../../lib/types.ts';

export type RangeAction =
  /** One frame: a stretch from it to a second later ("Until 00:13:03"), or from a second earlier at the very end. */
  | { kind: 'until' | 'from'; range: FrameRange; at: number }
  /** A stretch: its end or its start moves to the frame on screen ("End at …" / "Start at …", O / I). */
  | { kind: 'end' | 'start'; range: FrameRange; at: number }
  /** The frame on screen is the stretch's first frame (play on to its end) or its last one (it ends here). */
  | { kind: 'at-start' | 'at-end' };

export function rangeAction(now: number, range: FrameRange | null, fps: number, frames: number): RangeAction {
  const last = Math.max(0, frames - 1);
  if (!range) {
    const span = Math.max(1, Math.round(fps));
    if (now + span <= last) return { kind: 'until', range: { in: now, out: now + span }, at: now + span };
    const from = Math.max(0, now - span);
    return { kind: 'from', range: { in: from, out: now }, at: from };
  }
  if (now < range.in) return { kind: 'start', range: { in: now, out: range.out }, at: now };
  if (now === range.in) return { kind: 'at-start' };
  if (now === range.out) return { kind: 'at-end' };
  return { kind: 'end', range: { in: range.in, out: Math.min(now, last) }, at: Math.min(now, last) };
}
