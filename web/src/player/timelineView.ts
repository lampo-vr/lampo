// Which frames the timeline shows (its window on the video) and what the zoom control says about it — pure, so the
// timeline, its overview and their tests agree. A view is [first, end) in frames, fractional while it pans: frame f is
// drawn from (f − first) × px-per-frame. Zoomed far enough, every frame is a cell of its own (CELL_PX).
import type { FrameRange } from '../../../lib/types.ts';

export type View = readonly [number, number];

/** The fewest frames the timeline ever shows across: far enough in to pick one frame by its cell, even on a phone. */
export const MIN_SPAN = 10;
/** From this many pixels per frame each frame is a cell of the ruler with its number in it. */
export const CELL_PX = 20;

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** The narrowest window a video of `frames` frames can have. */
export const minSpan = (frames: number): number => Math.min(frames, MIN_SPAN);

/** The whole video. */
export const fitView = (frames: number): View => [0, frames];

/** Showing the whole video (to half a frame). */
export const isFit = (view: View, frames: number): boolean => view[1] - view[0] >= frames - 0.5;

/** A window `span` frames wide starting at `a`, kept inside the video and no narrower than the minimum. */
export function clampView(a: number, span: number, frames: number): View {
  const s = clamp(span, minSpan(frames), frames);
  const start = clamp(a, 0, frames - s);
  return [start, start + s];
}

/** Zoomed by `factor` (< 1 in, > 1 out) with `anchor` (a frame) staying where it is on screen. */
export function zoomAround(view: View, factor: number, anchor: number, frames: number): View {
  const [a, b] = view;
  const span = clamp((b - a) * factor, minSpan(frames), frames);
  const at = (anchor - a) / (b - a);
  return clampView(anchor - span * at, span, frames);
}

/** A window `span` frames wide with frame `f` in its middle. */
export const aroundFrame = (f: number, span: number, frames: number): View => clampView(f + 0.5 - span / 2, span, frames);

/** The marked section and a little room either side, so both of its handles can be taken. */
export function sectionView(r: FrameRange, frames: number, room = 0.15): View {
  const len = r.out - r.in + 1;
  const span = Math.max(minSpan(frames), len * (1 + 2 * room));
  return aroundFrame((r.in + r.out) / 2, span, frames);
}

/**
 * What Z shows: the marked section, or about a second around the playhead (every frame a cell on a laptop). Pressed
 * again where it already is: the whole video.
 */
export function zoomTarget(view: View, section: FrameRange | null, frame: number, fps: number, frames: number): View {
  const target = section ? sectionView(section, frames) : aroundFrame(frame, Math.max(MIN_SPAN, Math.round(fps)), frames);
  const same = Math.abs(target[0] - view[0]) < 0.5 && Math.abs(target[1] - view[1]) < 0.5;
  return same ? fitView(frames) : target;
}

/** The window that keeps frame `f` in view: the same one while it is inside, else the page that starts just before it. */
export function followFrame(view: View, f: number, frames: number): View {
  const [a, b] = view;
  if (f >= a && f < b) return view;
  const span = b - a;
  return clampView(f - span * 0.1, span, frames);
}

/** The window moved so its middle is at frame `centre` (the overview's box dragged or clicked). */
export const panTo = (view: View, centre: number, frames: number): View => clampView(centre - (view[1] - view[0]) / 2, view[1] - view[0], frames);

/** What the zoom control says: the whole video, how many frames are across, or how many times closer it is. */
export type ZoomLevel = { kind: 'fit' } | { kind: 'frames'; n: number } | { kind: 'times'; z: string };
export function zoomLevel(view: View, frames: number): ZoomLevel {
  if (isFit(view, frames)) return { kind: 'fit' };
  const span = view[1] - view[0];
  if (span <= 100) return { kind: 'frames', n: Math.round(span) };
  const z = frames / span;
  return { kind: 'times', z: z < 10 ? String(Math.round(z * 10) / 10) : String(Math.round(z)) };
}

/** A remembered window for a video of `frames` frames, if it still fits one (a version can be shorter). */
export function restoredView(saved: unknown, frames: number): View | null {
  if (!Array.isArray(saved) || saved.length !== 2) return null;
  const [a, b] = saved;
  if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b) || b <= a || b > frames) return null;
  const v = clampView(a, b - a, frames);
  return isFit(v, frames) ? null : v;
}

/** Where the window sits on the overview (a strip `width` px wide showing the whole video): its box's left and width. */
export function overviewBox(view: View, frames: number, width: number): { x: number; w: number } {
  const x = (view[0] / frames) * width;
  return { x, w: Math.max(4, ((view[1] - view[0]) / frames) * width) };
}

/** Where the section's chip goes on a timeline `width` px wide: centred over the section's span [a, b] in px when it fits
 * inside, else beside the end handle (or the start's, at the right edge) so it never covers a handle; always inside. */
export function chipLeft(a: number, b: number, chip: number, width: number, gap = 8): number {
  const inside = b - a >= chip + 2 * gap;
  let x = inside ? (a + b - chip) / 2 : b + gap;
  if (!inside && x + chip > width) x = a - gap - chip;
  return clamp(x, 2, Math.max(2, width - chip - 2));
}
