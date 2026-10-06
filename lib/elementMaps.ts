// Element maps on disk (lib/elements.ts has the rules): one per version, keyed by its render (`renderKey`: two renders
// can share a hash), beside the review in the workspace's data — `data/<slug>/elements/<renderKey>.json`. Never in
// versions/ (which can't be regenerated) and never in cache/: a renderer wrote it, and Lampo can't make it again.
// Notes are read against it on every read, so a map attached after the notes counts for them too.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkElementMap, fitElementMap, pointedAt } from './elements.ts';
import { reviewDir, slugify } from './paths.ts';
import { renderKey } from './renderKey.ts';
import { wsKey } from './scope.ts';
import type { Comment, ElementMap, ElementsAttached, NotePointer, Review, ReviewPointers, Version } from './types.ts';

/** Where a version's map lives. */
export const elementsFile = (slug: string, ver: Pick<Version, 'hash' | 'sample'>): string => path.join(reviewDir(slug), 'elements', `${renderKey(ver)}.json`);

/** No such version: the caller asked for one the video doesn't have (HTTP 404). */
export class NoVersionError extends Error {
  status = 404;
}

/**
 * Attaches a map to version `v` (the newest when absent), replacing the one it had: checked whole and made the
 * version's (lib/elements.ts), then written at once. Throws ElementMapError (400) for a bad map — nothing is kept.
 */
export function attachElements(review: Review, v: number | undefined, value: unknown): ElementsAttached {
  const ver = v === undefined ? review.versions.at(-1) : review.versions.find((x) => x.v === v);
  if (!ver) throw new NoVersionError(v === undefined ? 'the video has no version' : `no v${v}`);
  const { map, scaled_from } = fitElementMap(checkElementMap(value), ver);
  const file = elementsFile(slugify(review.video), ver);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map));
  fs.renameSync(tmp, file);
  maps.delete(wsKey(file));
  return { v: ver.v, elements: map.elements.length, keys: map.elements.reduce((n, el) => n + el.keys.length, 0), ...(scaled_from ? { scaled_from } : {}) };
}

// Parsed maps by file, while the file is unchanged (a map is read for every note line of its version). Never mutated.
const maps = new Map<string, { stamp: string; map: ElementMap | null }>();
const MAPS_KEPT = 16;
// What a note points at, by everything that decides it: the map file as it is and the note's frame, range and drawing.
const pointed = new Map<string, NotePointer>();
const POINTED_KEPT = 4000;

const kept = <V>(cache: Map<string, V>, key: string, value: V, max: number): V => {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > max) cache.delete(cache.keys().next().value as string);
  return value;
};

/** A version's map and the stamp of its file, or null when it has none (or the file is unreadable: never half a map). */
function mapOf(slug: string, ver: Version): { map: ElementMap; stamp: string } | null {
  const file = elementsFile(slug, ver);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const key = wsKey(file);
  const stamp = `${file}|${st.mtimeMs}|${st.size}`;
  const hit = maps.get(key);
  if (hit && hit.stamp === stamp) return hit.map ? { map: hit.map, stamp } : null;
  let map: ElementMap | null = null;
  try {
    map = checkElementMap(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    map = null;
  }
  kept(maps, key, { stamp, map }, MAPS_KEPT);
  return map ? { map, stamp } : null;
}

/** The map attached to version `v` of a review, or null. */
export function elementMap(review: Review, v: number): ElementMap | null {
  const ver = review.versions.find((x) => x.v === v);
  return ver ? (mapOf(slugify(review.video), ver)?.map ?? null) : null;
}

/** What one note points at in its version's map; null when the version has no map or the note points at nothing. */
export function pointerOf(review: Review, c: Comment): NotePointer | null {
  if (c.scope === 'video' || !c.drawing?.length) return null;
  const ver = review.versions.find((x) => x.v === c.v);
  if (!ver) return null;
  const got = mapOf(slugify(review.video), ver);
  if (!got) return null;
  const key = wsKey(
    crypto
      .createHash('sha1')
      .update(`${got.stamp}|${c.frame}|${c.range ? `${c.range.in}-${c.range.out}` : ''}|${JSON.stringify(c.drawing)}`)
      .digest('hex'),
  );
  const p = pointed.get(key) ?? kept(pointed, key, pointedAt(c, got.map), POINTED_KEPT);
  return p.elements.length || p.near ? p : null;
}

/** The notes (of these) that point at elements, and the names of the elements they point at. */
export function pointersOf(review: Review, comments: readonly Comment[]): ReviewPointers {
  const notes: Record<string, NotePointer> = {};
  const names: Record<string, string> = Object.create(null);
  for (const c of comments) {
    const p = pointerOf(review, c);
    if (!p) continue;
    notes[c.id] = p;
    const map = elementMap(review, c.v);
    for (const id of [...p.elements, ...(p.near ? [p.near] : [])]) {
      const el = map?.elements.find((e) => e.id === id);
      if (el && !Object.hasOwn(names, id)) names[id] = el.name;
    }
  }
  return { notes, names: { ...names } };
}
