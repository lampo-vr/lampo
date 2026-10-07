#!/usr/bin/env node
// The app's own footage search (lib/footage/) on the bench's test set: every clip tracked as a video in a throwaway
// store, indexed by the app's indexer with the real model, the 45 requests (and the German ones) asked through the same
// find() that `lampo footage find` and find_footage use, scored as eval.ts scores the prototype. What it should reproduce:
// RESULTS.md, SigLIP B/16 int8 pad with the description alone (93 / 100 / 0.96 with tesseract; 93 / 100 / 0.96 with
// Vision for the template variant).
//   node bench/footage/app-eval.ts [--store dir] [--json out.json] [--fresh] [--ocr tesseract]
// Needs make.ts's clips (LAMPO_FOOTAGE_CACHE) and downloads the model on first use (LAMPO_FOOTAGE_MODELS moves it).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { settings } from '../../lib/env.ts';
import { BENCH, CLIPS_DIR, readJson, writeJson } from './common.ts';
import type { Source, TruthClip, TruthShot } from './make.ts';

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] as string) : dflt;
};
const STORE = path.resolve(arg('store', path.join(os.tmpdir(), 'vr-footage-app-eval')));
if (process.argv.includes('--fresh')) fs.rmSync(STORE, { recursive: true, force: true });
// Lampo's modules against a throwaway store, never a live one
const CONFIG = path.join(STORE, 'config.json');
process.env.LAMPO_DATA = path.join(STORE, 'data');
process.env.LAMPO_CACHE = path.join(STORE, 'cache');
process.env.LAMPO_CONFIG = CONFIG;
process.env.LAMPO_STT = 'off';
// --ocr tesseract: what a Linux server reads text with (default: Vision on a Mac, tesseract elsewhere)
if (arg('ocr', '')) process.env.LAMPO_OCR = arg('ocr', '');
process.env.LAMPO_FOOTAGE = settings.LAMPO_FOOTAGE || 'auto';
for (const k of ['SERVER', 'TOKEN', 'MODE', 'FOOTAGE_MODEL']) {
  delete process.env[`VR_${k}`];
  delete process.env[`LAMPO_${k}`];
}
fs.mkdirSync(STORE, { recursive: true });
if (!fs.existsSync(CONFIG)) fs.writeFileSync(CONFIG, '{}');

const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');
const { renderKey } = await import('../../lib/renderKey.ts');
const { transcriptFile } = await import('../../lib/transcripts.ts');
const { buildTranscript } = await import('../../lib/transcript.ts');
const { targets, indexNow } = await import('../../lib/footage/indexer.ts');
const { find } = await import('../../lib/footage/search.ts');
const { embedder } = await import('../../lib/footage/embedder.ts');
const { openIndex } = await import('../../lib/footage/db.ts');

interface Rel {
  keys?: string[];
  set?: string;
  motion?: string[];
  aspect?: '16:9' | '9:16';
  minSec?: number;
  text?: string;
  said?: string;
}
interface Query {
  id: string;
  q: string;
  tags: string[];
  rel: Rel;
}
const Q = readJson<{ sets: Record<string, string[]>; queries: Query[]; german?: { id: string; like: string; q: string }[] }>(path.join(BENCH, 'queries.json'));
const truth = readJson<TruthClip[]>(path.join(CLIPS_DIR, 'truth.json'));
const sources = new Map(readJson<Source[]>(path.join(BENCH, 'sources.json')).map((s) => [s.key, s]));
const hasVoice = truth.some((c) => c.shots.some((s) => s.said));
const aspectOf = (w: number, h: number) => (w / h > 1.2 ? '16:9' : w / h < 0.83 ? '9:16' : '1:1');

function answers(t: TruthShot, clip: TruthClip, r: Rel): boolean {
  const keys = r.keys ?? (r.set ? Q.sets[r.set] : undefined);
  if (keys && !keys.includes(t.key)) return false;
  if (r.motion && !r.motion.includes(t.motion)) return false;
  if (r.aspect && aspectOf(clip.width, clip.height) !== r.aspect) return false;
  if (r.minSec !== undefined && (t.out - t.in) / clip.fps < r.minSec) return false;
  if (r.text === 'none' && (t.text || sources.get(t.key)?.text_in_picture)) return false;
  if (r.text && r.text !== 'none' && t.text !== r.text) return false;
  if (r.said && !(t.said || '').toLowerCase().includes(r.said.toLowerCase())) return false;
  return true;
}
/** The truth shot a found shot [a, b) mostly lies in (≥ 50 % of its frames). */
function truthOf(clipFile: string, a: number, b: number): { t: TruthShot; clip: TruthClip } | null {
  const clip = truth.find((c) => c.file === clipFile);
  if (!clip) return null;
  let best: TruthShot | null = null;
  let ov = 0;
  for (const t of clip.shots) {
    const o = Math.min(b, t.out) - Math.max(a, t.in);
    if (o > ov) {
      ov = o;
      best = t;
    }
  }
  return best && ov >= 0.5 * (b - a) ? { t: best, clip } : null;
}

// ---------------------------------------------------------------- the store: every clip a video, its voice-over heard
const files = fs
  .readdirSync(CLIPS_DIR)
  .filter((f) => f.endsWith('.mp4'))
  .sort();
for (const f of files) store.createOrGetReview(path.join(CLIPS_DIR, f), { by: 'bench' });
for (const r of store.listReviews()) {
  const ver = r.versions.at(-1);
  const words = path.join(CLIPS_DIR, path.basename(r.video).replace(/\.mp4$/, '.words.json'));
  if (!ver || !fs.existsSync(words)) continue;
  // what is said, as if the video's transcript had been made (the app reads transcripts it has; it makes none)
  const w = readJson<{ language: string; words: { text: string; t0: number; t1: number }[] }>(words);
  const t = buildTranscript({ words: w.words, segments: [], language: w.language, engine: 'bench:say' }, ver, new Date().toISOString());
  fs.mkdirSync(path.dirname(transcriptFile(renderKey(ver))), { recursive: true });
  fs.writeFileSync(transcriptFile(renderKey(ver)), JSON.stringify(t));
}

// ---------------------------------------------------------------- indexing, timed
const e = embedder();
await e.prepare();
const list = targets();
const footageSecs = list.reduce((s, t) => s + t.ver.duration, 0);
const cpu0 = process.cpuUsage();
const t0 = performance.now();
const n = await indexNow(list, { e, progress: (m) => process.stderr.write(`  ${m}\n`) });
const wallS = (performance.now() - t0) / 1000;
const cpu = process.cpuUsage(cpu0);
const db = openIndex();
const count = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
const shotsN = count('SELECT count(*) AS n FROM shots');
const kfN = count('SELECT count(*) AS n FROM keyframes');
const ocr = (db.prepare('SELECT DISTINCT ocr FROM renders').all() as { ocr: string }[]).map((r) => r.ocr).join(', ');
const dirBytes = (d: string): number => {
  let s = 0;
  if (!fs.existsSync(d)) return 0;
  for (const x of fs.readdirSync(d, { withFileTypes: true })) s += x.isDirectory() ? dirBytes(path.join(d, x.name)) : fs.statSync(path.join(d, x.name)).size;
  return s;
};
const footageDir = path.join(STORE, 'cache', 'footage');
const index = {
  videos: list.length,
  indexed_now: n,
  footage_s: Math.round(footageSecs),
  shots: shotsN,
  keyframes: kfN,
  ocr,
  wall_s: Math.round(wallS),
  // this process only: decoding (ffmpeg), OCR and the model's worker are children (their parent's RUSAGE_CHILDREN)
  main_cpu_s: Math.round((cpu.user + cpu.system) / 1e6),
  index_mb:
    Math.round(
      (['index.db', 'index.db-wal'].reduce((b, f) => b + (fs.existsSync(path.join(footageDir, f)) ? fs.statSync(path.join(footageDir, f)).size : 0), 0) / 1e6) *
        10,
    ) / 10,
  thumbs_mb: Math.round((dirBytes(path.join(footageDir, 'thumbs')) / 1e6) * 10) / 10,
};
console.log('index', JSON.stringify(index));

// ---------------------------------------------------------------- reading the footage: cuts, moves, captions
const slugToClip = new Map(store.listReviews().map((r) => [slugify(r.video), path.basename(r.video)]));
const shots = db.prepare('SELECT s.render, s.f_in, s.f_out, s.motion, s.text FROM shots s').all() as {
  render: string;
  f_in: number;
  f_out: number;
  motion: string;
  text: string;
}[];
const clipOfRender = new Map(list.map((t) => [t.key, path.basename(t.review.video)]));
let cutsFound = 0;
let cutsTruth = 0;
let cutsRight = 0;
let cutsDet = 0;
let moveOk = 0;
let moveN = 0;
const captions = { found: 0, of: 0 };
for (const c of truth) {
  const det = shots.filter((s) => clipOfRender.get(s.render) === c.file);
  const tc = c.shots.slice(1).map((s) => s.in);
  const dc = det.filter((s) => s.f_in > 0).map((s) => s.f_in);
  cutsTruth += tc.length;
  cutsDet += dc.length;
  cutsFound += tc.filter((x) => dc.some((y) => Math.abs(x - y) <= 1)).length;
  cutsRight += dc.filter((y) => tc.some((x) => Math.abs(x - y) <= 1)).length;
  for (const s of det) {
    const m = truthOf(c.file, s.f_in, s.f_out + 1);
    if (!m) continue;
    const want = m.t.motion === 'push-in-fast' ? 'push-in' : m.t.motion;
    moveN++;
    if (want === s.motion) moveOk++;
    if (m.t.text) {
      captions.of++;
      if (s.text) captions.found++;
    }
  }
}
const reading = {
  cuts: `${cutsFound} of ${cutsTruth} found (±1 frame), ${cutsDet - cutsRight} false`,
  moves: `${((100 * moveOk) / moveN).toFixed(1)} % of ${moveN} shots right`,
  captions: `${captions.found} of ${captions.of}`,
};
console.log('reading', JSON.stringify(reading));

// ---------------------------------------------------------------- retrieval
interface Score {
  r1: number;
  r5: number;
  mrr: number;
  n: number;
  misses: string[];
}
async function score(runs: { q: Query; query: string }[]): Promise<Score> {
  let r1 = 0;
  let r5 = 0;
  let mrr = 0;
  const misses: string[] = [];
  for (const { q, query } of runs) {
    const a = await find({ query, limit: 10 }, { embedder: e });
    const rank = a.shots.findIndex((s) => {
      const clip = slugToClip.get(s.video);
      const m = clip ? truthOf(clip, s.in, s.out + 1) : null;
      return m ? answers(m.t, m.clip, q.rel) : false;
    });
    if (rank === 0) r1++;
    if (rank >= 0 && rank < 5) r5++;
    if (rank >= 0 && rank < 10) mrr += 1 / (rank + 1);
    if (rank < 0 || rank >= 5) misses.push(`${q.id} (${rank < 0 ? '>10' : rank + 1})`);
  }
  const k = runs.length;
  return { r1: r1 / k, r5: r5 / k, mrr: mrr / k, n: k, misses };
}
const queries = Q.queries.filter((q) => hasVoice || !q.tags.includes('said'));
const t1 = performance.now();
const base = await score(queries.map((q) => ({ q, query: q.q })));
const perQueryMs = (performance.now() - t1) / queries.length;
const german = await score(
  (Q.german ?? []).flatMap((g) => {
    const like = queries.find((q) => q.id === g.like);
    return like ? [{ q: { ...like, id: g.id }, query: g.q }] : [];
  }),
);
const p = (x: number) => Math.round(x * 100);
console.log(
  `app (siglip-b16-int8, pad, description alone, OCR ${ocr}): R@1 ${p(base.r1)}  R@5 ${p(base.r5)}  MRR ${base.mrr.toFixed(2)}  (${base.n} requests; misses ${base.misses.join(' ') || 'none'})`,
);
console.log(`German: R@1 ${p(german.r1)}  R@5 ${p(german.r5)}  MRR ${german.mrr.toFixed(2)}  (${german.n} requests)`);
console.log(`search: ${perQueryMs.toFixed(0)} ms per request (text embedding + scan + ranking)`);
// what an agent reads for the first request: the compact list (6 shots) and one contact sheet
const { compactList } = await import('../../lib/footage/lines.ts');
const { sheet } = await import('../../lib/footage/service.ts');
const { approxTokens, imageTokens } = await import('../tokens/count.ts');
const first = await find({ query: (queries[0] as Query).q }, { embedder: e });
const made = await sheet(
  first.shots.map((x) => x.id),
  path.join(STORE, 'q01-sheet.jpg'),
);
const tokens = { list: approxTokens(compactList(first)), sheet: imageTokens(made.width, made.height), sheet_px: `${made.width}×${made.height}` };
console.log(`${compactList(first)}\nagent reads: list ${tokens.list} tokens + sheet ${tokens.sheet} (${tokens.sheet_px}, ${made.file})`);
const out = arg('json', '');
if (out) writeJson(out, { index, reading, base, german, perQueryMs: Math.round(perQueryMs), tokens });
e.stop();
// the model's worker exits on its own once told: wait for it, so a parent counting its children's CPU counts it too
await new Promise((r) => setTimeout(r, 2000));
