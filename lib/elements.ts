// Element maps (v1): where each named element of a render is, frame by frame, as the renderer that made it knows it
// (any renderer can write one, docs/agents.md). A note is read against the map of the version it was written on: what
// its drawing points at (`#card`), so an agent fixes the element rather than a pixel.
// The rules come from a renderer's own review loop (keys thinned to straight lines, runs for when an element is on
// screen, the closest match under a box, an arrow by its tip, the full-frame ground only under a large box).
// Browser-safe.
import { z } from 'zod';
import { oneLine } from './time.ts';
import type { Comment, ElementKey, ElementMap, ElementRun, MapElement, NotePointer, ReviewPointers, Shape, Version } from './types.ts';

export const ELEMENT_LIMITS = {
  elements: 500,
  /** Keys per element: this many, or one per frame of the version when it has more (a long film with a moving camera). */
  keys: 2000,
  runs: 2000,
  /** The whole map as JSON. */
  bytes: 1024 * 1024,
  name: 80,
  kind: 20,
  /** Thinning: a key a straight line between its neighbours already gives within this many pixels is dropped. */
  thin: 3,
} as const;

/** What a note line names of its elements; the rest is "+N". */
export const SHOWN_ELEMENTS = 3;
/** At most this many element ids per note in structured answers. */
const MAX_POINTED = 20;
/** A long range is read at this many frames spread over it (both ends and the note's own frame among them)… */
const RANGE_SAMPLES = 60;
/** …and at most this many more where the elements near its drawing change (keys, the ends of runs). */
const RANGE_CHANGES = 240;

/** A map that can't be stored, and why: the caller's to fix (HTTP 400). Nothing of it was kept. */
export class ElementMapError extends Error {
  status = 400;
}

const refuse = (message: string): never => {
  throw new ElementMapError(`the elements map is refused: ${message}`);
};

// ---------------------------------------------------------------- validation

const frame = z.number().int().min(0).max(10_000_000);
const pixels = z.number().positive().max(100_000);
/** One line, trimmed, then at most `max` characters: names reach agents' lines. */
const words = (max: number) =>
  z
    .string()
    .transform((s) => oneLine(s).trim())
    .pipe(z.string().max(max, `at most ${max} characters`));

const key = z.tuple([frame, z.number(), z.number(), z.number().min(0), z.number().min(0)]);
const run = z.tuple([frame, frame]);

const element = z
  .object({
    // ids key objects wherever a map is read (names by id): never one of an object's own names
    id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,40}$/, 'an id is 1–40 letters, digits, _ or -')
      .refine((id) => !['__proto__', 'constructor', 'prototype'].includes(id), 'that id is taken by the format'),
    name: words(ELEMENT_LIMITS.name),
    kind: words(ELEMENT_LIMITS.kind),
    keys: z.array(key).min(1, 'an element needs a key'),
    runs: z.array(run).max(ELEMENT_LIMITS.runs, `at most ${ELEMENT_LIMITS.runs} runs`).optional(),
  })
  .superRefine((el, ctx) => {
    for (let i = 1; i < el.keys.length; i++)
      if ((el.keys[i] as ElementKey)[0] <= (el.keys[i - 1] as ElementKey)[0])
        ctx.addIssue({ code: 'custom', path: ['keys', i], message: 'keys must be sorted by frame, one per frame' });
    const runs = el.runs ?? [];
    for (let i = 0; i < runs.length; i++) {
      const [a, b] = runs[i] as ElementRun;
      if (a > b) ctx.addIssue({ code: 'custom', path: ['runs', i], message: 'a run is [from, to] with from ≤ to' });
      else if (i > 0 && a <= (runs[i - 1] as ElementRun)[1])
        ctx.addIssue({ code: 'custom', path: ['runs', i], message: 'runs must be sorted and must not overlap' });
    }
  });

const mapSchema = z
  .object({
    v: z.literal(1, 'v must be 1 (the map format)'),
    fps: z.number().positive().max(1000),
    size: z.tuple([pixels, pixels]),
    elements: z.array(element).max(ELEMENT_LIMITS.elements, `at most ${ELEMENT_LIMITS.elements} elements`),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    m.elements.forEach((el, i) => {
      if (seen.has(el.id)) ctx.addIssue({ code: 'custom', path: ['elements', i, 'id'], message: `"${el.id}" is used twice: ids are unique` });
      seen.add(el.id);
    });
  });

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

/**
 * A map as sent (parsed JSON), checked whole: the shape, the caps, sorted keys and runs, unique ids, names on one line.
 * Throws ElementMapError naming the first problem; nothing of a bad map is ever kept. Unknown fields are dropped.
 */
export function checkElementMap(value: unknown): ElementMap {
  const json = JSON.stringify(value ?? null);
  if (bytesOf(json) > ELEMENT_LIMITS.bytes) refuse(`it is over ${ELEMENT_LIMITS.bytes / 1024 / 1024} MB`);
  const r = mapSchema.safeParse(value);
  if (!r.success) {
    const issue = r.error.issues[0];
    refuse(`${issue?.path.length ? `${issue.path.join('.')}: ` : ''}${issue?.message ?? 'malformed'}`);
  }
  return r.data as ElementMap;
}

/** A map file's text (`lampo push --elements`, `lampo elements`, MCP `track_video`): its size first, then JSON, then the map. */
export function readElementMap(text: string): ElementMap {
  if (bytesOf(text) > ELEMENT_LIMITS.bytes) refuse(`it is over ${ELEMENT_LIMITS.bytes / 1024 / 1024} MB`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    refuse(`not JSON (${(e as Error).message})`);
  }
  return checkElementMap(value);
}

/**
 * A checked map made the version's: refused on a part (its frames are another file's), at another frame rate or
 * shape, or with more keys per element than max(2000, the version's frames); scaled to the version's pixels when it
 * was written at another size, and thinned (keys a straight line already gives within 3 px).
 */
export function fitElementMap(
  map: ElementMap,
  ver: Pick<Version, 'v' | 'fps' | 'frames' | 'width' | 'height' | 'part'>,
): { map: ElementMap; scaled_from?: [number, number] } {
  if (ver.part) refuse(`V${ver.v} is a part: attach the map to a full render`);
  if (Math.abs(map.fps - ver.fps) > 0.01) refuse(`it is at ${map.fps} fps, v${ver.v} at ${ver.fps}: write it at the version's frame rate`);
  const [w, h] = map.size;
  if (Math.abs(w / h - ver.width / ver.height) > 0.01 * (ver.width / ver.height))
    refuse(`it is ${w}×${h}, v${ver.v} is ${ver.width}×${ver.height}: write the map of this format`);
  const cap = Math.max(ELEMENT_LIMITS.keys, ver.frames);
  map.elements.forEach((el, i) => {
    if (el.keys.length > cap) refuse(`elements.${i}.keys: ${el.keys.length} keys, at most ${cap} for v${ver.v} (${ver.frames} frames)`);
  });
  const kx = ver.width / w;
  const ky = ver.height / h;
  const scaled = Math.abs(kx - 1) > 1e-9 || Math.abs(ky - 1) > 1e-9;
  const px = (n: number) => Math.round(n * 100) / 100;
  const elements = map.elements.map((el) => {
    const keys = scaled ? el.keys.map(([f, x, y, bw, bh]): ElementKey => [f, px(x * kx), px(y * ky), px(bw * kx), px(bh * ky)]) : el.keys;
    return { id: el.id, name: el.name, kind: el.kind, keys: thin(keys), ...(el.runs ? { runs: el.runs } : {}) };
  });
  return { map: { v: 1, fps: map.fps, size: [ver.width, ver.height], elements }, ...(scaled ? { scaled_from: [w, h] as [number, number] } : {}) };
}

// ---------------------------------------------------------------- where an element is

/**
 * Drops keys a straight line between their neighbours already gives (within `tol` px: enough for a note to point at
 * an element). Keys on consecutive frames are one stretch; a stretch keeps its ends, so no line is drawn across a gap.
 */
export function thin(keys: readonly ElementKey[], tol: number = ELEMENT_LIMITS.thin): ElementKey[] {
  const stretches: ElementKey[][] = [];
  for (const k of keys) {
    const s = stretches.at(-1);
    if (s && k[0] === (s.at(-1) as ElementKey)[0] + 1) s.push(k);
    else stretches.push([k]);
  }
  return stretches.flatMap((s) => line(s, tol));
}

function line(keys: ElementKey[], tol: number): ElementKey[] {
  if (keys.length <= 2) return keys;
  const out = [keys[0] as ElementKey];
  let a = 0;
  for (let i = 2; i < keys.length; i++) {
    const [fa, ...ba] = keys[a] as ElementKey;
    const [fi, ...bi] = keys[i] as ElementKey;
    // would a line from a to i miss any key in between?
    for (let j = a + 1; j < i; j++) {
      const [fj, ...bj] = keys[j] as ElementKey;
      const u = (fj - fa) / (fi - fa);
      if (bj.some((v, k) => Math.abs((ba[k] as number) + ((bi[k] as number) - (ba[k] as number)) * u - v) > tol)) {
        out.push(keys[i - 1] as ElementKey);
        a = i - 1;
        break;
      }
    }
  }
  out.push(keys.at(-1) as ElementKey);
  return out;
}

type Box = [number, number, number, number];

/** The last index whose frame is at or before `f` (0 when none is). */
function keyAt(keys: readonly ElementKey[], f: number): number {
  let lo = 0;
  let hi = keys.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((keys[mid] as ElementKey)[0] <= f) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function inRuns(runs: readonly ElementRun[], f: number): boolean {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = runs[mid] as ElementRun;
    if (f < a) hi = mid - 1;
    else if (f > b) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * An element's box [x, y, w, h] at frame f, or null when it is not on screen then: outside its runs, or (without runs)
 * before its first key or after its last. Inside, it moves in a straight line from key to key.
 */
export function boxAt(el: Pick<MapElement, 'keys' | 'runs'>, f: number): Box | null {
  const k = el.keys;
  if (el.runs && !inRuns(el.runs, f)) return null;
  if (!k.length || (!el.runs && (f < (k[0] as ElementKey)[0] || f > (k.at(-1) as ElementKey)[0]))) return null;
  const i = keyAt(k, f);
  const a = k[i] as ElementKey;
  const b = k[i + 1];
  if (!b || a[0] >= f || b[0] === a[0]) return [a[1], a[2], a[3], a[4]];
  const u = (f - a[0]) / (b[0] - a[0]);
  return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u, a[4] + (b[4] - a[4]) * u];
}

const area = (b: Box) => Math.max(0, b[2]) * Math.max(0, b[3]);
const inter = (p: Box, q: Box) =>
  Math.max(0, Math.min(p[0] + p[2], q[0] + q[2]) - Math.max(p[0], q[0])) * Math.max(0, Math.min(p[1] + p[3], q[1] + q[3]) - Math.max(p[1], q[1]));
const distance = ([x, y]: [number, number], b: Box) => Math.hypot(Math.max(b[0] - x, 0, x - b[0] - b[2]), Math.max(b[1] - y, 0, y - b[1] - b[3]));

// Every box an element ever has lies inside its keys' extent (between keys the edges move in straight lines): a quick
// test that skips what can't be near a drawing before any box is worked out.
const extents = new WeakMap<MapElement, Box>();
function extentOf(el: MapElement): Box {
  let e = extents.get(el);
  if (!e) {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [, x, y, w, h] of el.keys) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + w);
      y1 = Math.max(y1, y + h);
    }
    e = [x0, y0, x1 - x0, y1 - y0];
    extents.set(el, e);
  }
  return e;
}

/** What a drawn shape covers: a box (a freehand ring by its extent) or, for an arrow, its tip and tail. */
type Region = { box: Box } | { tip: [number, number]; tail: [number, number] };
function region(s: Shape): Region | null {
  if (s.type === 'box') return { box: [Math.min(s.x, s.x + s.w), Math.min(s.y, s.y + s.h), Math.abs(s.w), Math.abs(s.h)] };
  if (s.type === 'arrow') return { tip: [s.x2, s.y2], tail: [s.x1, s.y1] };
  const pts = s.points || [];
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { box: [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)] };
}

interface Hit {
  el: MapElement;
  score: number;
}

/** The elements on screen at frame f that may matter (`near`: their extent passes this test), with their boxes. */
function onScreen(map: ElementMap, f: number, near: (extent: Box) => boolean): { el: MapElement; box: Box }[] {
  const out: { el: MapElement; box: Box }[] = [];
  for (const el of map.elements) {
    if (!near(extentOf(el))) continue;
    const box = boxAt(el, f);
    if (box && area(box) > 0) out.push({ el, box });
  }
  return out;
}

/**
 * Elements under a box, the closest match first (overlap over union, so a card inside a big panel beats the panel). The
 * ground (an element filling most of the frame) counts only under a box about as large.
 */
function underBox(map: ElementMap, f: number, box: Box): Hit[] {
  const [W, H] = map.size;
  const big = area(box) >= W * H * 0.5;
  const hits = onScreen(map, f, (e) => inter(e, box) > 0)
    .filter((x) => big || area(x.box) < W * H * 0.8)
    .map(({ el, box: b }) => {
      const i = inter(box, b);
      return { el, score: i / (area(box) + area(b) - i), inside: i / area(b) };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!hits.length) return [];
  const top = (hits[0] as { score: number }).score;
  return hits.filter((h, i) => i === 0 || h.score >= top * 0.25 || h.inside >= 0.9).slice(0, 3);
}

/** The element a point is on (the innermost), else the nearest within reach; the ground only with `ground`. */
function underPoint(map: ElementMap, f: number, p: [number, number], reach: number, ground = false): MapElement[] {
  const [W, H] = map.size;
  const on = onScreen(map, f, (e) => distance(p, e) <= reach)
    .filter(({ box }) => ground || area(box) < W * H * 0.8)
    .map(({ el, box }) => ({ el, d: distance(p, box), a: area(box) }));
  const inside = on.filter((h) => h.d === 0).sort((a, b) => a.a - b.a);
  if (inside.length) return [(inside[0] as { el: MapElement }).el];
  return on
    .filter((h) => h.d <= reach)
    .sort((a, b) => a.d - b.d)
    .slice(0, 1)
    .map((h) => h.el);
}

/**
 * The frames a note is read at: its own, or every frame of a short range. A long one is read at RANGE_SAMPLES frames
 * spread over it (both ends and the note's frame among them) and where the elements that may be near its drawing
 * change: their keys and the ends of their runs inside it — so something on screen for a moment is still found.
 */
function framesOf(c: Pick<Comment, 'frame' | 'range'>, map: ElementMap, near: (extent: Box) => boolean): number[] {
  if (!c.range) return [c.frame];
  const a = Math.min(c.range.in, c.range.out);
  const b = Math.max(c.range.in, c.range.out);
  if (b - a + 1 <= RANGE_SAMPLES) return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const out = new Set<number>([c.frame]);
  for (let i = 0; i < RANGE_SAMPLES; i++) out.add(Math.round(a + ((b - a) * i) / (RANGE_SAMPLES - 1)));
  const changes = new Set<number>();
  for (const el of map.elements) {
    if (!near(extentOf(el))) continue;
    for (const [f] of el.keys) if (f >= a && f <= b) changes.add(f);
    for (const [from, to] of el.runs ?? []) for (const f of [from, to]) if (f >= a && f <= b) changes.add(f);
  }
  // at most RANGE_CHANGES of them, spread evenly: a range over a long film with a moving camera stays quick
  const all = [...changes].sort((x, y) => x - y);
  const step = Math.max(1, all.length / RANGE_CHANGES);
  for (let i = 0; i < all.length; i += step) out.add(all[Math.floor(i)] as number);
  return [...out].sort((x, y) => x - y);
}

/**
 * What a note points at in the map of its version: the elements under its drawing at its frame — a box (a freehand
 * ring by its extent) names the closest matches, an arrow what its tip is on, else what its tail starts on ("move this
 * there"), else the ground under its tip. A range names what is under the drawing anywhere across it, the closest
 * match first. A drawing over empty space ("put it here") names nothing and the element `near`est its middle. No
 * drawing, or a note about the whole video: nothing.
 */
export function pointedAt(c: Pick<Comment, 'frame' | 'range' | 'drawing' | 'scope'>, map: ElementMap): NotePointer {
  if (c.scope === 'video' || !map.elements.length) return { elements: [] };
  const shapes = (c.drawing || []).map(region).filter((s): s is Region => !!s);
  if (!shapes.length) return { elements: [] };
  const [W, H] = map.size;
  const reach = Math.hypot(W, H) * 0.06;
  // what can be under a shape at some frame: its extent meets a box, or is within reach of an arrow's ends
  const nearAny = (e: Box) => shapes.some((s) => ('box' in s ? inter(e, s.box) > 0 : distance(s.tip, e) <= reach || distance(s.tail, e) <= reach));
  const frames = framesOf(c, map, nearAny);
  const ids: string[] = [];
  for (const s of shapes) {
    // each element's best match across the frames, then how often it was there
    const best = new Map<MapElement, { score: number; n: number; at: number }>();
    for (const f of frames) {
      const got: Hit[] =
        'box' in s
          ? underBox(map, f, s.box)
          : ([underPoint(map, f, s.tip, reach), underPoint(map, f, s.tail, reach), underPoint(map, f, s.tip, 0, true)].find((x) => x.length) ?? []).map(
              (el) => ({
                el,
                score: 1,
              }),
            );
      for (const h of got) {
        const b = best.get(h.el);
        if (!b) best.set(h.el, { score: h.score, n: 1, at: best.size });
        else {
          b.score = Math.max(b.score, h.score);
          b.n++;
        }
      }
    }
    const order = [...best.entries()].sort(([, p], [, q]) => q.score - p.score || q.n - p.n || p.at - q.at);
    for (const [el] of order) if (!ids.includes(el.id)) ids.push(el.id);
  }
  if (ids.length) return { elements: ids.slice(0, MAX_POINTED) };
  // over empty space ("put it here"): the element nearest the drawing's middle, at the note's own frame
  const box = shapes.find((s): s is { box: Box } => 'box' in s)?.box;
  const near = box ? underPoint(map, c.frame, [box[0] + box[2] / 2, box[1] + box[3] / 2], Infinity)[0] : undefined;
  return near ? { elements: [], near: near.id } : { elements: [] };
}

// ---------------------------------------------------------------- what agents read

/** No note points at anything (no maps, or a server from before them). */
export const NO_POINTERS: ReviewPointers = Object.freeze({ notes: {}, names: {} }) as ReviewPointers;

/** A note's pointer in a review's answer, if it has one. */
export const pointerIn = (p: ReviewPointers, id: string): NotePointer | undefined => (Object.hasOwn(p.notes, id) ? p.notes[id] : undefined);

/** A note's elements as structured answers carry them (`lampo open --json`, `get_open_notes`): ids, and the one it is near. */
export const pointerFields = (p: NotePointer | undefined): { elements: string[]; near?: string } => ({
  elements: p?.elements ?? [],
  ...(p?.near ? { near: p.near } : {}),
});

/** The ids a note's line shows: up to three it is on, else the one it is near. */
export const shownIds = (p: NotePointer | null | undefined): string[] =>
  !p ? [] : p.elements.length ? p.elements.slice(0, SHOWN_ELEMENTS) : p.near ? [p.near] : [];

/** Appended to a note's line in every agent format: " · on #title, #card +2", " · near #card", or nothing. */
export function onWords(p: NotePointer | null | undefined): string {
  if (!p) return '';
  if (p.elements.length) {
    const more = p.elements.length - SHOWN_ELEMENTS;
    return ` · on ${shownIds(p)
      .map((id) => `#${id}`)
      .join(', ')}${more > 0 ? ` +${more}` : ''}`;
  }
  return p.near ? ` · near #${p.near}` : '';
}

/**
 * One line under a video's header naming the elements its notes' lines show, once each: `elements: #title "Title",
 * #card "Price card"` (an element whose name is its id goes by the id alone). '' when no note points at one.
 */
export function legendLine(pointers: Iterable<NotePointer | null | undefined>, names: ReadonlyMap<string, string> | Record<string, string>): string {
  const seen: string[] = [];
  for (const p of pointers) for (const id of shownIds(p)) if (!seen.includes(id)) seen.push(id);
  if (!seen.length) return '';
  const nameOf = (id: string) => (names instanceof Map ? names.get(id) : Object.hasOwn(names, id) ? (names as Record<string, string>)[id] : undefined);
  return oneLine(
    `elements: ${seen
      .map((id) => {
        const n = nameOf(id);
        return n && n !== id ? `#${id} "${n.replace(/"/g, "'")}"` : `#${id}`;
      })
      .join(', ')}`,
  );
}
