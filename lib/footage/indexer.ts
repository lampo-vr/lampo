// Indexing a workspace's footage in the background: the newest version of every video (the sample left out) is read
// once per render — its shots, moves and keyframes (analyse.ts), then each keyframe's picture: a thumbnail, the text in
// it (OCR: macOS Vision on a Mac, tesseract elsewhere) and one image embedding (the model's worker) — and kept in the
// workspace's index (db.ts). Every step is a job of the one queue (lib/jobs.ts, PRIORITY.footage: after everything a
// review needs), a minute of video or 48 keyframes at a time, so a long take never holds a player's scrub copy back.
// What is said comes from the video's transcript when it has one (search.ts reads it), never a new transcript.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { heavy, PRIORITY, QueueFullError } from '../jobs.ts';
import { slugify } from '../paths.ts';
import { FFMPEG, lower, spawnMedia } from '../probe.ts';
import { renderKey } from '../renderKey.ts';
import { wsKey } from '../scope.ts';
import { seekTime } from '../shots.ts';
import * as store from '../store.ts';
import { textTools } from '../text/index.ts';
import type { OcrLine } from '../text/types.ts';
import type { Review, Version } from '../types.ts';
import { CHUNK_FRAMES, newReading, type Reading, readChunk, shotsOf } from './analyse.ts';
import { type KeyframeRow, openIndex, type RenderRow, thumbFile, transaction } from './db.ts';
import { type Embedder, embedder } from './embedder.ts';
import { footageOn } from './settings.ts';
import { cleanOcr, OCR_MIN_CONF } from './text.ts';

/** Keyframes per picture job. */
export const FRAME_CHUNK = 48;
/** A render that failed this often is left alone until the process starts again. */
const MAX_TRIES = 3;

export interface Target {
  review: Review;
  ver: Version;
  key: string;
}

/**
 * What footage search covers: the newest version of every video still here, not the onboarding sample (a demo, never
 * footage) and not archived ones (`archived: true` counts those too: their index is kept for when they come back).
 */
export function targets(reviews: readonly Review[] = store.listReviews(), { archived = false } = {}): Target[] {
  const out: Target[] = [];
  for (const review of reviews) {
    if (review.onboarding_sample || (review.archived && !archived)) continue;
    const ver = review.versions.at(-1);
    if (!ver?.frames || !ver.fps || !ver.width || !ver.height) continue;
    out.push({ review, ver, key: renderKey(ver) });
  }
  return out;
}

/** The bytes of a version as a local file (remote storage fetched first). */
const bytesOf = async (t: Target): Promise<string> => {
  const file = await store.ensureVersionFile(t.review, t.ver.v);
  if (!file) throw new Error(`the bytes of v${t.ver.v} are gone`);
  return file;
};

const renderRow = (key: string): RenderRow | undefined => openIndex().prepare('SELECT * FROM renders WHERE key = ?').get(key) as RenderRow | undefined;

/** Keyframes of a render with no vector of this model yet, in frame order. */
function keyframesToDo(key: string, model: string): KeyframeRow[] {
  return openIndex()
    .prepare(
      `SELECT k.* FROM keyframes k JOIN shots s ON s.id = k.shot_id
       WHERE s.render = ? AND NOT EXISTS (SELECT 1 FROM vectors v WHERE v.kf_id = k.id AND v.model = ?) ORDER BY k.frame`,
    )
    .all(key, model) as unknown as KeyframeRow[];
}

/** The index has everything for this render, with vectors of this model. */
export function indexedFor(key: string, model: string): boolean {
  const r = renderRow(key);
  return r?.stage === 'done' && !keyframesToDo(key, model).length;
}

// ---------------------------------------------------------------- the stages

/** One analysis chunk: decodes the next minute of the video; after the last one the shots go into the index. */
async function analyseChunk(t: Target, reading: Reading): Promise<boolean> {
  const file = await bytesOf(t);
  const to = Math.min(t.ver.frames, reading.frames + CHUNK_FRAMES);
  await readChunk(file, t.ver, reading, to);
  if (!reading.ended && reading.frames < t.ver.frames) return false;
  const shots = shotsOf(reading, t.ver);
  const db = openIndex();
  transaction(db, () => {
    // another process (the app, a `vr footage index`) may have finished it meanwhile: theirs stays
    if (renderRow(t.key)) return;
    db.prepare('INSERT INTO renders (key, width, height, fps, frames, stage, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      t.key,
      t.ver.width,
      t.ver.height,
      t.ver.fps,
      reading.frames,
      'analysed',
      new Date().toISOString(),
    );
    const insShot = db.prepare('INSERT INTO shots (render, n, f_in, f_out, motion, speed, zoom, dx, dy, path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insKf = db.prepare('INSERT INTO keyframes (shot_id, frame) VALUES (?, ?)');
    shots.forEach((s, n) => {
      const m = s.motion;
      const id = Number(insShot.run(t.key, n, s.in, s.end - 1, m.kind, m.speed, m.zoom, m.dx, m.dy, m.path).lastInsertRowid);
      for (const f of s.keyframes) insKf.run(id, f);
    });
  });
  return true;
}

/** What the keyframes of one chunk look like: the model's square picture, a thumbnail, and a larger frame for OCR. */
async function grabChunk(
  file: string,
  ver: Version,
  frames: number[],
  size: number,
  work: string,
  withOcr: boolean,
): Promise<{ pictures: Uint8Array[]; thumbs: string[]; ocr: string[] }> {
  const first = frames[0] as number;
  const select = `select='${frames.map((f) => `eq(n\\,${f - first})`).join('+')}'`;
  // the whole frame letterboxed to the model's square (bench: whole frame beats a centre crop, letterbox beats squash)
  const fit = `scale=${size}:${size}:force_original_aspect_ratio=decrease:flags=area,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:black`;
  const n = frames.length;
  const graph = withOcr
    ? `[0:v]${select},split=3[a][b][c];[a]${fit}[m];[b]scale=360:360:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=area[t];[c]scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2[o]`
    : `[0:v]${select},split=2[a][b];[a]${fit}[m];[b]scale=360:360:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=area[t]`;
  const out = (label: string, target: string, q: string) => ['-map', label, '-fps_mode', 'passthrough', '-frames:v', String(n), '-q:v', q, target];
  const args = [
    '-v',
    'error',
    ...(first > 0 ? ['-ss', seekTime(first, ver.fps).toFixed(6)] : []),
    '-i',
    file,
    '-filter_complex',
    graph,
    '-map',
    '[m]',
    '-fps_mode',
    'passthrough',
    '-frames:v',
    String(n),
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    'pipe:1',
    ...out('[t]', path.join(work, 't_%04d.jpg'), '4'),
    ...(withOcr ? out('[o]', path.join(work, 'o_%04d.jpg'), '2') : []),
  ];
  const frameBytes = size * size * 3;
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const p = spawnMedia(FFMPEG, args);
    lower(p.pid);
    p.stdout.on('data', (d: Buffer) => chunks.push(d));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`could not read the keyframes (${p.stderrTail().trim().split('\n').pop() || `exit ${code}`})`)),
    );
  });
  const all = Buffer.concat(chunks);
  const got = Math.min(n, Math.floor(all.length / frameBytes));
  const pictures = Array.from({ length: got }, (_, i) => new Uint8Array(all.subarray(i * frameBytes, (i + 1) * frameBytes)));
  const name = (prefix: string, i: number) => path.join(work, `${prefix}_${String(i + 1).padStart(4, '0')}.jpg`);
  return {
    pictures,
    thumbs: pictures.map((_, i) => name('t', i)),
    ocr: withOcr ? pictures.map((_, i) => name('o', i)) : [],
  };
}

/**
 * One picture chunk: the next keyframes without a vector — thumbnails, text, embeddings. True when none are left. Its
 * ffmpeg seeks to the first and decodes on to the last: only keyframes within an analysis chunk (CHUNK_FRAMES) of the
 * first go in one, so a long take's keyframes minutes apart are as many jobs, never one that decodes all of it
 * (A13 MEDIA-3: a 60-minute take made one job decode 50 minutes).
 */
async function framesChunk(t: Target, e: Embedder): Promise<boolean> {
  const next = keyframesToDo(t.key, e.key);
  const first = next[0]?.frame ?? 0;
  const todo = next.slice(0, FRAME_CHUNK).filter((k) => k.frame - first <= CHUNK_FRAMES);
  const db = openIndex();
  if (todo.length) {
    const file = await bytesOf(t);
    const tools = await textTools();
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-footage-'));
    try {
      const frames = todo.map((k) => k.frame);
      const g = await grabChunk(file, t.ver, frames, e.size, work, !!tools.ocr);
      // keyframes past the end of what decodes (a render shorter than probed) go
      const missing = todo.slice(g.pictures.length);
      const pages = tools.ocr && g.ocr.length ? await tools.ocr(g.ocr).catch(() => []) : [];
      const vectors = await e.images(g.pictures);
      fs.mkdirSync(path.dirname(thumbFile(t.key, 0)), { recursive: true });
      g.thumbs.forEach((f, i) => {
        if (fs.existsSync(f)) fs.renameSync(f, thumbFile(t.key, (todo[i] as KeyframeRow).frame));
      });
      transaction(db, () => {
        const setOcr = db.prepare('UPDATE keyframes SET ocr = ? WHERE id = ?');
        const insVec = db.prepare('INSERT OR REPLACE INTO vectors (kf_id, model, vec) VALUES (?, ?, ?)');
        vectors.forEach((v, i) => {
          const k = todo[i] as KeyframeRow;
          const lines = (pages[i]?.lines ?? []).map((l: OcrLine) => ({ text: l.text, conf: Math.round(l.conf * 1000) / 1000 }));
          setOcr.run(JSON.stringify(lines), k.id);
          insVec.run(k.id, e.key, Buffer.from(v.buffer, v.byteOffset, v.byteLength));
        });
        for (const k of missing) db.prepare('DELETE FROM keyframes WHERE id = ?').run(k.id);
        if (tools.engine) db.prepare('UPDATE renders SET ocr = ? WHERE key = ?').run(tools.engine, t.key);
      });
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
    if (keyframesToDo(t.key, e.key).length) return false;
  }
  // every keyframe read: each shot's text is what its keyframes showed, the stage is done
  const engine = renderRow(t.key)?.ocr ?? '';
  const min = OCR_MIN_CONF[engine.startsWith('tesseract') ? 'tesseract' : 'vision'] ?? 0.75;
  transaction(db, () => {
    const shots = db.prepare('SELECT id FROM shots WHERE render = ?').all(t.key) as { id: number }[];
    const lines = db.prepare('SELECT ocr FROM keyframes WHERE shot_id = ? ORDER BY frame');
    const setText = db.prepare('UPDATE shots SET text = ? WHERE id = ?');
    for (const s of shots) {
      const all = (lines.all(s.id) as { ocr: string | null }[]).flatMap((r) => (r.ocr ? (JSON.parse(r.ocr) as { text: string; conf: number }[]) : []));
      setText.run(cleanOcr(all, min).join(' · '), s.id);
    }
    db.prepare("UPDATE renders SET stage = 'done', error = NULL, at = ? WHERE key = ?").run(new Date().toISOString(), t.key);
  });
  return true;
}

function markFailed(key: string, error: string): void {
  const db = openIndex();
  transaction(db, () => {
    if (renderRow(key))
      db.prepare("UPDATE renders SET stage = 'failed', error = ?, tries = tries + 1, at = ? WHERE key = ?").run(
        error.slice(0, 500),
        new Date().toISOString(),
        key,
      );
    else
      db.prepare("INSERT INTO renders (key, width, height, fps, frames, stage, error, tries, at) VALUES (?, 0, 0, 0, 0, 'failed', ?, 1, ?)").run(
        key,
        error.slice(0, 500),
        new Date().toISOString(),
      );
  });
}

/** A failed render, ready to be tried again: from its shots when it has them, else from the start. */
function retry(key: string): void {
  const db = openIndex();
  transaction(db, () => {
    if (db.prepare('SELECT 1 FROM shots WHERE render = ? LIMIT 1').get(key)) db.prepare("UPDATE renders SET stage = 'analysed' WHERE key = ?").run(key);
    else db.prepare('DELETE FROM renders WHERE key = ?').run(key);
  });
}

/** Renders the index holds that no video's newest version is any more (a new version came, a video went): removed. */
export function prune(keep: Iterable<string>): number {
  const wanted = new Set(keep);
  const db = openIndex();
  const stale = (db.prepare('SELECT key FROM renders').all() as { key: string }[]).map((r) => r.key).filter((k) => !wanted.has(k));
  if (!stale.length) return 0;
  transaction(db, () => {
    for (const key of stale) {
      db.prepare('DELETE FROM vectors WHERE kf_id IN (SELECT k.id FROM keyframes k JOIN shots s ON s.id = k.shot_id WHERE s.render = ?)').run(key);
      db.prepare('DELETE FROM keyframes WHERE shot_id IN (SELECT id FROM shots WHERE render = ?)').run(key);
      db.prepare('DELETE FROM shots WHERE render = ?').run(key);
      db.prepare('DELETE FROM renders WHERE key = ?').run(key);
    }
  });
  for (const key of stale) fs.rmSync(path.dirname(thumbFile(key, 0)), { recursive: true, force: true });
  return stale.length;
}

// ---------------------------------------------------------------- running it

/** One step of a render's indexing; true when the render is fully indexed (or can't be). */
async function step(t: Target, e: Embedder, readings: Map<string, Reading>): Promise<boolean> {
  const row = renderRow(t.key);
  if (!row) {
    const k = wsKey(t.key);
    const reading = readings.get(k) ?? newReading();
    readings.set(k, reading);
    const done = await analyseChunk(t, reading);
    if (done) readings.delete(k);
    return false;
  }
  if (row.stage === 'failed') return true;
  return framesChunk(t, e);
}

export interface IndexerOptions {
  embedder?: () => Embedder;
  log?: (msg: string) => void;
  /** Told when a render's index changed (the app's live stream). */
  changed?: (slug: string) => void;
}

/**
 * The background indexer of a process (the app): `queue(review)` after a video's newest version arrived (and at start
 * for every video), `queueAll()` when footage search is turned on. Each render's steps run one job at a time.
 */
export function createIndexer(o: IndexerOptions = {}) {
  const getEmbedder = o.embedder ?? embedder;
  const log = o.log ?? ((m: string) => console.log(m));
  // per workspace (wsKey): a render being worked on, and the analysis read so far
  const running = new Set<string>();
  const readings = new Map<string, Reading>();
  const failedThisRun = new Map<string, number>();
  let preparing: Promise<void> | null = null;

  function run(t: Target): void {
    const k = wsKey(t.key);
    if (running.has(k)) return;
    const e = getEmbedder();
    let row = renderRow(t.key);
    if (row?.stage === 'failed') {
      if ((failedThisRun.get(k) ?? 0) >= MAX_TRIES) return;
      // tried again (a model that couldn't load, a file that was still being written): from its shots when it has them
      retry(t.key);
      row = renderRow(t.key);
    }
    if (row && indexedFor(t.key, e.key)) return;
    // the model downloads outside the queue (a minute of network is no job); the pictures wait for it
    if (row && !e.ready()) {
      preparing ??= e
        .prepare()
        .catch((err: Error) => log(`footage: ${err.message}`))
        .finally(() => {
          preparing = null;
        });
      const later = preparing;
      running.add(k);
      void later.then(() => {
        running.delete(k);
        if (e.ready()) run(t);
      });
      return;
    }
    running.add(k);
    const slug = slugify(t.review.video);
    heavy(() => step(t, e, readings), PRIORITY.footage).then(
      (done) => {
        running.delete(k);
        if (done) {
          o.changed?.(slug);
          return;
        }
        run(t);
      },
      (err: Error) => {
        running.delete(k);
        readings.delete(k);
        if (err instanceof QueueFullError) return;
        failedThisRun.set(k, (failedThisRun.get(k) ?? 0) + 1);
        markFailed(t.key, err.message);
        log(`footage: ${path.basename(t.review.video)} v${t.ver.v}: ${err.message}`);
        o.changed?.(slug);
      },
    );
  }

  return {
    /** Indexes the newest version of this video when footage search is on here (a warm-up: never fails a request). */
    queue(review: Review): void {
      try {
        if (!footageOn()) return;
        const [t] = targets([review]);
        if (t && store.versionAvailable(t.review, t.ver.v)) run(t);
      } catch (e) {
        log(`footage: ${(e as Error).message}`);
      }
    },
    /** Every video of the workspace running now; the renders no video needs any more leave the index. */
    queueAll(): void {
      if (!footageOn()) return;
      const reviews = store.listReviews();
      prune(targets(reviews, { archived: true }).map((t) => t.key));
      for (const t of targets(reviews)) if (store.versionAvailable(t.review, t.ver.v)) run(t);
    },
    /** Whether a render is waiting or being worked on (status). */
    busy: (key: string): boolean => running.has(wsKey(key)),
  };
}

export type Indexer = ReturnType<typeof createIndexer>;

/**
 * Indexes now, in this process, without the app's queue (`vr footage index` on the machine): every video that isn't
 * indexed yet, or those named. Progress goes to `progress`.
 */
export async function indexNow(list: Target[], { e = embedder(), progress }: { e?: Embedder; progress?: (msg: string) => void } = {}): Promise<number> {
  await e.prepare();
  const readings = new Map<string, Reading>();
  let done = 0;
  for (const t of list) {
    if (indexedFor(t.key, e.key)) continue;
    progress?.(`${path.basename(t.review.video)} v${t.ver.v} …`);
    try {
      if (renderRow(t.key)?.stage === 'failed') retry(t.key);
      for (;;) if (await step(t, e, readings)) break;
      done++;
    } catch (err) {
      markFailed(t.key, (err as Error).message);
      progress?.(`${path.basename(t.review.video)}: ${(err as Error).message}`);
    }
  }
  return done;
}
