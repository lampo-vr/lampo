// Searching a workspace's footage: the request read into filters + a description (query.ts), the description embedded
// by the model's text side, every keyframe's vector scanned in JS (no vector database: bench/footage/RESULTS.md), each
// shot scored by its best keyframe (z-scored over the shots searched), plus the words found in its on-screen text or
// in what is said, filtered by what the request names. The answer is the shots (types.ts: the contract), the compact
// list an agent reads, and on request one contact sheet (sheet.ts).
import fs from 'node:fs';
import path from 'node:path';
import { slugify } from '../paths.ts';
import { renderKey } from '../renderKey.ts';
import { wsKey } from '../scope.ts';
import * as store from '../store.ts';
import { cachedTranscript, transcriptFile } from '../transcripts.ts';
import type { Review, Version } from '../types.ts';
import { generation, hasIndex, openIndex, type RenderRow, type ShotRow } from './db.ts';
import { type Embedder, embedder } from './embedder.ts';
import { type Target, targets } from './indexer.ts';
import { readRequest } from './query.ts';
import { footageState } from './settings.ts';
import { wordMatch } from './text.ts';
import {
  FOOTAGE_VERSION,
  type FootageAnswer,
  type FootageAspect,
  type FootageIndexState,
  type FootageMotion,
  type FootageRequest,
  type FootageShot,
} from './types.ts';

export const DEFAULT_LIMIT = 6;
export const MAX_LIMIT = 50;

export const aspectOf = (w: number, h: number): FootageAspect => (w / h > 1.2 ? '16:9' : w / h < 0.83 ? '9:16' : '1:1');

interface Shot extends ShotRow {
  /** Keyframes: their frames, and where each one's vector is in `vecs` (−1: none of this model yet). */
  kfFrames: number[];
  kfRows: number[];
}

interface Loaded {
  gen: number;
  model: string;
  renders: Map<string, RenderRow>;
  byRender: Map<string, Shot[]>;
  dim: number;
  vecs: Float32Array;
  /** Per vector row: the shot it belongs to. */
  rowShot: Shot[];
}

// The index of each workspace as it was last read, kept while it doesn't change (a search re-reads only what moved) and
// let go after ten minutes without a search (3 KB a keyframe in memory: a hosted server holds many workspaces).
const loaded = new Map<string, Loaded & { at: number }>();
const KEEP_MS = 10 * 60_000;

function load(model: string): Loaded | null {
  if (!hasIndex()) return null;
  const db = openIndex();
  const key = wsKey('footage');
  const now = Date.now();
  for (const [k, l] of loaded) if (k !== key && now - l.at > KEEP_MS) loaded.delete(k);
  const gen = generation(db);
  const had = loaded.get(key);
  if (had && had.gen === gen && had.model === model) {
    had.at = now;
    return had;
  }
  const renders = new Map((db.prepare('SELECT * FROM renders').all() as unknown as RenderRow[]).map((r) => [r.key, r]));
  const byRender = new Map<string, Shot[]>();
  const byId = new Map<number, Shot>();
  for (const s of db.prepare('SELECT * FROM shots ORDER BY render, f_in').all() as unknown as ShotRow[]) {
    const shot: Shot = { ...s, kfFrames: [], kfRows: [] };
    byId.set(s.id, shot);
    const list = byRender.get(s.render) ?? [];
    list.push(shot);
    byRender.set(s.render, list);
  }
  const rows = db
    .prepare('SELECT k.shot_id, k.frame, v.vec FROM keyframes k LEFT JOIN vectors v ON v.kf_id = k.id AND v.model = ? ORDER BY k.shot_id, k.frame')
    .all(model) as { shot_id: number; frame: number; vec: Uint8Array | null }[];
  const dim = rows.find((r) => r.vec)?.vec?.byteLength ? (rows.find((r) => r.vec)?.vec?.byteLength as number) / 4 : 0;
  const withVec = rows.filter((r) => r.vec && r.vec.byteLength === dim * 4).length;
  const vecs = new Float32Array(withVec * dim);
  const rowShot: Shot[] = [];
  for (const r of rows) {
    const s = byId.get(r.shot_id);
    if (!s) continue;
    s.kfFrames.push(r.frame);
    if (r.vec && dim && r.vec.byteLength === dim * 4) {
      vecs.set(new Float32Array(r.vec.buffer, r.vec.byteOffset, dim), rowShot.length * dim);
      s.kfRows.push(rowShot.length);
      rowShot.push(s);
    } else s.kfRows.push(-1);
  }
  const l = { gen, model, renders, byRender, dim, vecs, rowShot, at: now };
  loaded.set(key, l);
  return l;
}

// What is said in a shot, from its render's transcript (read again only when the file changed).
const saidCache = new Map<string, { mtime: number; words: { f0: number; text: string }[] }>();
function saidIn(ver: Version, f0: number, f1: number): string {
  const key = renderKey(ver);
  let mtime = 0;
  try {
    mtime = fs.statSync(transcriptFile(key)).mtimeMs;
  } catch {
    return '';
  }
  const ck = wsKey(key);
  let c = saidCache.get(ck);
  if (!c || c.mtime !== mtime) {
    c = { mtime, words: (cachedTranscript(ver)?.words ?? []).map((w) => ({ f0: Math.round((w.f0 + w.f1) / 2), text: w.text })) };
    saidCache.set(ck, c);
  }
  return c.words
    .filter((w) => w.f0 >= f0 && w.f0 <= f1)
    .map((w) => w.text.trim())
    .join(' ');
}

/** How far the workspace's index is. */
export function indexState(list: Target[] = targets(), model: string = embedder().key): FootageIndexState {
  const st = footageState();
  const l = load(model);
  let indexed = 0;
  let failed = 0;
  for (const t of list) {
    const r = l?.renders.get(t.key);
    if (r?.stage === 'failed') failed++;
    else if (r?.stage === 'done' && (l?.byRender.get(t.key) ?? []).every((s) => s.kfRows.every((x) => x >= 0))) indexed++;
  }
  return { on: st.on, ...(st.why ? { note: st.why } : {}), videos: list.length, indexed, waiting: st.on ? list.length - indexed - failed : 0, failed };
}

export interface FindOptions {
  /** The caller is the machine itself: shots carry the render's path on this disk. */
  local?: boolean;
  embedder?: Embedder;
}

interface Cand {
  t: Target;
  s: Shot;
  r: RenderRow;
}

/** Ranks the workspace's shots for a request: the contract every caller gets (types.ts). */
export async function find(req: FootageRequest, o: FindOptions = {}): Promise<FootageAnswer> {
  const e = o.embedder ?? embedder();
  const read = readRequest(req);
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(req.limit ?? DEFAULT_LIMIT)));
  const list = targets();
  const index = indexState(list, e.key);
  const answer = (shots: FootageShot[], searched: number): FootageAnswer => ({
    footage_version: FOOTAGE_VERSION,
    query: req.query,
    read,
    shots,
    searched,
    index,
  });
  // off: nothing is searched (an index made while it was on is kept for when it comes back)
  const l = index.on ? load(e.key) : null;
  if (!l) return answer([], 0);
  // the shots of the videos covered, each under the first video holding its render
  const cands: Cand[] = [];
  const seen = new Set<string>();
  for (const t of list) {
    const r = l.renders.get(t.key);
    if (!r || seen.has(t.key)) continue;
    seen.add(t.key);
    for (const s of l.byRender.get(t.key) ?? []) cands.push({ t, s, r });
  }
  const embedded = cands.filter((c) => c.s.kfRows.some((x) => x >= 0));
  // the description is matched by the model's text side; while the model is still downloading, filters and words only
  const qvec = read.show && embedded.length && e.ready() ? ((await e.texts([read.show]))[0] ?? null) : null;
  if (read.show && !qvec && cands.length)
    index.note = !embedded.length
      ? 'no picture of these videos is indexed here yet: this answer used the filters and words only'
      : 'the footage model is still downloading: this answer used the filters and words only';
  // similarity of each candidate's best keyframe; z-scored over those that have vectors
  const best = new Map<Shot, { sim: number; frame: number }>();
  if (qvec && l.dim === qvec.length) {
    for (const c of embedded) {
      let top = Number.NEGATIVE_INFINITY;
      let frame = c.s.kfFrames[0] ?? c.s.f_in;
      c.s.kfRows.forEach((row, i) => {
        if (row < 0) return;
        let dot = 0;
        const base = row * l.dim;
        for (let d = 0; d < l.dim; d++) dot += (l.vecs[base + d] as number) * (qvec[d] as number);
        if (dot > top) {
          top = dot;
          frame = c.s.kfFrames[i] as number;
        }
      });
      best.set(c.s, { sim: top, frame });
    }
  }
  const sims = [...best.values()].map((b) => b.sim);
  const mean = sims.reduce((a, b) => a + b, 0) / (sims.length || 1);
  const sd = Math.sqrt(sims.reduce((a, b) => a + (b - mean) ** 2, 0) / (sims.length || 1)) || 1;
  const hits: { c: Cand; score: number; frame: number; matched: ('text' | 'said')[]; said: string }[] = [];
  for (const c of qvec ? cands.filter((x) => best.has(x.s)) : cands) {
    const { s, r, t } = c;
    const fps = r.fps || t.ver.fps;
    const secs = (s.f_out - s.f_in + 1) / fps;
    if (read.aspect && aspectOf(r.width, r.height) !== read.aspect) continue;
    if (read.min_s !== undefined && secs < read.min_s) continue;
    if (read.max_s !== undefined && secs > read.max_s) continue;
    if (read.no_text && s.text) continue;
    const b = best.get(s);
    let score = b ? (b.sim - mean) / sd : 0;
    if (read.motion) {
      const ok = read.motion.includes(s.motion as FootageMotion);
      // a bonus, not a filter: a misread move (2 % of shots) keeps its shot in the list (bench: hard filter costs 2 points)
      score += ok ? 1 : -0.5;
      if (ok && read.speed && s.speed === read.speed) score += 0.2;
    }
    const matched: ('text' | 'said')[] = [];
    const said = read.words && read.words_in !== 'text' ? saidIn(t.ver, s.f_in, s.f_out) : '';
    if (read.words) {
      const field = read.words_in === 'said' ? said : read.words_in === 'text' ? s.text : `${s.text} ${said}`;
      const m = wordMatch(read.words, field);
      if (m > 0) {
        score += m >= 0.5 ? 4 * m : 2 * m;
        if (read.words_in !== 'said' && wordMatch(read.words, s.text) > 0) matched.push('text');
        if (read.words_in !== 'text' && wordMatch(read.words, said) > 0) matched.push('said');
      }
    }
    // a request that is only words ("where the voice-over says …") lists only shots with those words
    if (!qvec && read.words && !matched.length) continue;
    const middle = s.kfFrames[Math.floor((s.kfFrames.length - 1) / 2)] ?? s.f_in;
    hits.push({ c, score, frame: b?.frame ?? middle, matched, said });
  }
  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, limit);
  const files = new Map<string, string | null>();
  const shots: FootageShot[] = [];
  for (const h of top) {
    const { s, r, t } = h.c;
    const fps = r.fps || t.ver.fps;
    const slug = slugify(t.review.video);
    if (o.local && !files.has(slug)) files.set(slug, await store.ensureVersionFile(t.review, t.ver.v).catch(() => null));
    const file = o.local ? files.get(slug) : null;
    const move = s.motion as FootageMotion;
    shots.push({
      id: `s${s.id}`,
      video: slug,
      name: path.basename(t.review.video),
      folder: t.review.folder ?? null,
      v: t.ver.v,
      fps,
      in: s.f_in,
      out: s.f_out,
      t0: round(s.f_in / fps, 3),
      t1: round((s.f_out + 1) / fps, 3),
      length_s: round((s.f_out - s.f_in + 1) / fps, 1),
      width: r.width,
      height: r.height,
      aspect: aspectOf(r.width, r.height),
      move,
      speed: move === 'static' || move === 'handheld' ? null : ((s.speed as 'slow' | 'fast' | null) ?? null),
      frame: h.frame,
      text: s.text,
      said: h.said || saidIn(t.ver, s.f_in, s.f_out),
      score: round(h.score, 2),
      ...(h.matched.length ? { matched: h.matched } : {}),
      ...(file ? { file } : {}),
    });
  }
  return answer(shots, cands.length);
}

const round = (x: number, d: number): number => Math.round(x * 10 ** d) / 10 ** d;
/** Shots of the workspace's index by id (`s412`), for a contact sheet: in the order asked, unknown ids left out. */
export function shotsById(ids: readonly string[], model: string = embedder().key): { shot: FootageShot; render: string }[] {
  const l = load(model);
  if (!l) return [];
  const byKey = new Map<string, Target>();
  for (const t of targets()) if (!byKey.has(t.key)) byKey.set(t.key, t);
  const out: { shot: FootageShot; render: string }[] = [];
  const all = new Map<number, Shot>();
  for (const list of l.byRender.values()) for (const s of list) all.set(s.id, s);
  for (const id of ids) {
    const n = /^s(\d{1,12})$/.exec(id.trim())?.[1];
    const s = n ? all.get(Number(n)) : undefined;
    const t = s ? byKey.get(s.render) : undefined;
    const r = s ? l.renders.get(s.render) : undefined;
    if (!s || !t || !r) continue;
    const fps = r.fps || t.ver.fps;
    out.push({
      render: s.render,
      shot: {
        id: `s${s.id}`,
        video: slugify(t.review.video),
        name: path.basename(t.review.video),
        folder: t.review.folder ?? null,
        v: t.ver.v,
        fps,
        in: s.f_in,
        out: s.f_out,
        t0: round(s.f_in / fps, 3),
        t1: round((s.f_out + 1) / fps, 3),
        length_s: round((s.f_out - s.f_in + 1) / fps, 1),
        width: r.width,
        height: r.height,
        aspect: aspectOf(r.width, r.height),
        move: s.motion as FootageMotion,
        speed: (s.speed as 'slow' | 'fast' | null) ?? null,
        frame: s.kfFrames[Math.floor((s.kfFrames.length - 1) / 2)] ?? s.f_in,
        text: s.text,
        said: saidIn(t.ver, s.f_in, s.f_out),
        score: 0,
      },
    });
  }
  return out;
}

/** The review and version a shot of the answer is in (to grab a frame of it). */
export function targetOf(slug: string): { review: Review; ver: Version } | null {
  const review = store.loadReview(slug);
  const ver = review?.versions.at(-1);
  return review && ver ? { review, ver } : null;
}

/** Tests: forget what was read. */
export function forgetLoaded(): void {
  loaded.clear();
  saidCache.clear();
}
