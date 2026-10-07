// Partial renders, opt-in: a person allows an agent to render only the shots a note is about (snapped to the render's
// own cuts); the agent sends that stretch with a few frames either side (its handles) and Lampo splices it into the
// version it patches for playback (lib/splice.ts). Never the default: without a person's PART RENDER OK an agent
// renders in full, and a part is never final — the next full render is compared with what was approved.
// Browser-safe (no Node imports): the server, `lampo`, MCP and the UI share these rules.
import { oneLine, timecode } from './time.ts';
import type { Comment, FrameRange, PartOk, PartRequest, Version, VersionPart } from './types.ts';

/** Frames an agent renders beyond each end of a part, unless it says otherwise. */
export const PART_HANDLES = 12;
/** At most this many handle frames on each side. */
export const MAX_HANDLES = 48;

/** The shot frame `f` lies in, counted from 1: one more than the cuts at or before it. */
export const shotAt = (cuts: readonly number[], f: number): number => 1 + cuts.filter((c) => c > 0 && c <= f).length;

/**
 * The stretch to render for a note at `r` (a frame is a one-frame range): from the first frame of the shot it starts in
 * to the last frame of the shot it ends in. `cuts` = the first frame of every shot but the first.
 */
export function snapToShots(cuts: readonly number[], frames: number, r: FrameRange, handles = PART_HANDLES): PartRequest {
  const sorted = [...new Set(cuts)].filter((c) => Number.isInteger(c) && c > 0 && c < frames).sort((a, b) => a - b);
  const a = Math.max(0, Math.min(frames - 1, Math.min(r.in, r.out)));
  const b = Math.max(a, Math.min(frames - 1, Math.max(r.in, r.out)));
  let start = 0;
  for (const c of sorted) if (c <= a) start = c;
  const end = (sorted.find((c) => c > b) ?? frames) - 1;
  return { in: start, out: end, shot: shotAt(sorted, a), to_shot: shotAt(sorted, b), handles };
}

/** Whether a stretch is the whole video (one shot): nothing to gain from rendering only a part of it. */
export const isWhole = (p: Pick<PartRequest, 'in' | 'out'>, frames: number): boolean => p.in <= 0 && p.out >= frames - 1;

const shots = (p: PartRequest) => (p.shot ? ` (shot${p.to_shot && p.to_shot > p.shot ? `s ${p.shot}–${p.to_shot}` : ` ${p.shot}`})` : '');

/**
 * The one line every agent format prints for a note (or request) that allows a partial render:
 * "PART RENDER OK: frames 96–188 (shot 4), handles 12". Without it, agents render in full.
 */
export const partLine = (p: PartRequest): string => oneLine(`PART RENDER OK: frames ${p.in}–${p.out}${shots(p)}, handles ${p.handles ?? PART_HANDLES}`);

/**
 * The stretch a part render for a note may cover, as `lampo push --part-at` checks it (lib/parts.ts allowedParts): the
 * note's PART RENDER OK on the newest version's frames. Null where no person allowed one, or the note won't be fixed.
 */
export function partOk(versions: readonly Version[], c: Pick<Comment, 'part' | 'status' | 'v'>): PartOk | null {
  const base = versions.at(-1);
  if (!c.part || c.status === 'wontfix' || !base) return null;
  const p = onGrid(c.part, versions.find((x) => x.v === c.v)?.fps ?? base.fps, base.fps);
  return { from: p.in, to: p.out };
}

/** Appended to a note's line in every agent format: " · part f96–f188", or nothing. */
export const partOkWords = (p: PartOk | null): string => (p ? ` · part f${p.from}–f${p.to}` : '');

/** The base frames a part replaces, both ends included. */
export const partSpan = (p: Pick<VersionPart, 'at' | 'frames'>): FrameRange => ({ in: p.at, out: p.at + p.frames - 1 });

/** The handle frames a part's file has before and after the stretch it replaces (fewer at the video's ends). */
export function partBounds(p: Pick<VersionPart, 'at' | 'frames' | 'handles'>, baseFrames: number): { pre: number; post: number } {
  return { pre: Math.max(0, Math.min(p.handles, p.at)), post: Math.max(0, Math.min(p.handles, baseFrames - p.at - p.frames)) };
}

/** "part (00:04–00:07)": the stretch a part version patches, in seconds of the video. */
export function partWhere(p: Pick<VersionPart, 'at' | 'frames'>, fps: number): string {
  const s = partSpan(p);
  const mmss = (f: number) => timecode(f, fps).slice(0, -3);
  return `${mmss(s.in)}–${mmss(s.out + 1)}`;
}

/** A stretch of one version's own file, in its frames [from, to). */
export interface Segment {
  v: number;
  from: number;
  to: number;
}

/**
 * Which frames of which uploaded files make version `v`, in order: a full render is its own file; a part is its base's
 * segments with its own frames in the middle — resolved down to files as they were uploaded, so a part of a part
 * never re-encodes a re-encode. Empty when a version is unknown.
 */
export function spliceSegments(versions: readonly Version[], v: number, depth = 0): Segment[] {
  const ver = versions.find((x) => x.v === v);
  if (!ver) return [];
  const p = ver.part;
  if (!p) return [{ v, from: 0, to: ver.frames }];
  if (depth > 64 || p.of >= v) return [];
  const base = spliceSegments(versions, p.of, depth + 1);
  if (!base.length) return [];
  const { pre } = partBounds(p, ver.frames);
  return merge([...slice(base, 0, p.at), { v, from: pre, to: pre + p.frames }, ...slice(base, p.at + p.frames, ver.frames)]);
}

// The output frames [a, b) of a segment list (segments laid end to end from frame 0).
function slice(segs: readonly Segment[], a: number, b: number): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const s of segs) {
    const len = s.to - s.from;
    const lo = Math.max(a, at);
    const hi = Math.min(b, at + len);
    if (hi > lo) out.push({ v: s.v, from: s.from + (lo - at), to: s.from + (hi - at) });
    at += len;
  }
  return out;
}

function merge(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    const last = out.at(-1);
    if (last && last.v === s.v && last.to === s.from) last.to = s.to;
    else if (s.to > s.from) out.push({ ...s });
  }
  return out;
}

/** Where frame `f` of version `v` comes from: a frame of one uploaded file. Null outside the video. */
export function sourceFrame(versions: readonly Version[], v: number, f: number): { v: number; frame: number } | null {
  let at = 0;
  for (const s of spliceSegments(versions, v)) {
    const len = s.to - s.from;
    if (f >= at && f < at + len) return { v: s.v, frame: s.from + (f - at) };
    at += len;
  }
  return null;
}

/** The newest full render at or before `v` (what a part ultimately patches). */
export function fullAtOrBefore(versions: readonly Version[], v: number): Version | null {
  for (let i = versions.length - 1; i >= 0; i--) {
    const x = versions[i] as Version;
    if (x.v <= v && !x.part) return x;
  }
  return null;
}

/** The part versions between the full render before `v` and `v` (the ones a full render `v` has to answer for). */
export function partsBefore(versions: readonly Version[], v: number): Version[] {
  const out: Version[] = [];
  for (let i = versions.length - 1; i >= 0; i--) {
    const x = versions[i] as Version;
    if (x.v >= v) continue;
    if (!x.part) break;
    out.unshift(x);
  }
  return out;
}

/** The same stretch on another render's frame grid (the same seconds). */
export function onGrid(p: PartRequest, fromFps: number, toFps: number): PartRequest {
  if (Math.abs(fromFps - toFps) < 1e-6) return p;
  const at = (f: number) => Math.round((f * toFps) / fromFps);
  return { ...p, in: at(p.in), out: Math.max(at(p.in), at(p.out + 1) - 1) };
}

/**
 * Where a part sent at base frame `at` with `length` frames (handles included) ends, if it replaces whole shots:
 * the first stretch end it fits — a requested part's end, a cut of the base, or the video's end. Null: the length
 * changed (a part never ripples the rest of the video).
 */
export function partEnd(o: { at: number; length: number; handles: number; baseFrames: number; ends: readonly number[] }): number | null {
  const pre = Math.min(o.handles, o.at);
  const ends = [...new Set([...o.ends, o.baseFrames])].filter((e) => e > o.at && e <= o.baseFrames).sort((a, b) => a - b);
  for (const end of ends) {
    const post = Math.min(o.handles, o.baseFrames - end);
    if (pre + (end - o.at) + post === o.length) return end;
  }
  return null;
}
