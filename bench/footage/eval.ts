#!/usr/bin/env node
// Retrieval quality on the 45 queries (queries.json) for every model variant in the index, plus how well the
// pipeline itself reads the footage (cuts, camera moves, on-screen text) against make.ts's ground truth.
//   node bench/footage/eval.ts [--db file] [--json out.json] [--detail model]
// A result counts when the detected shot lies mostly (≥ 50 %) inside a shot that answers the query.
// Metrics: R@1 / R@5 = share of queries with a right shot first / in the first five; MRR over the first ten.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BENCH, CLIPS_DIR, RESULTS_DIR, readJson, WORK_DIR, writeJson } from './common.ts';
import { type Dtype, loadEmbedder } from './embed.ts';
import {
  aspectOf,
  cleanOcr,
  type Hit,
  type LoadedIndex,
  loadIndex,
  OCR_MIN_CONF,
  type Parsed,
  parseQuery,
  prompt,
  type SearchOptions,
  search,
} from './find.ts';
import type { Source, TruthClip, TruthShot } from './make.ts';

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] as string) : dflt;
};
const dbFile = arg('db', path.join(WORK_DIR, 'index.db'));
const jsonOut = arg('json', path.join(RESULTS_DIR, 'eval.json'));
const detail = arg('detail', '');
const ocr = arg('ocr', '') || undefined;
const only = arg('variants', '');

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

/** The truth shot a detected shot mostly lies in (≥ 50 % of its frames), if any. */
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

interface Score {
  r1: number;
  r5: number;
  mrr: number;
  n: number;
  byTag: Record<string, { r5: number; n: number }>;
  misses: string[];
}

function score(ix: LoadedIndex, runs: { q: Query; hits: Hit[] }[]): Score {
  let r1 = 0;
  let r5 = 0;
  let mrr = 0;
  const byTag: Score['byTag'] = {};
  const misses: string[] = [];
  for (const { q, hits } of runs) {
    const rank = hits.findIndex((h) => {
      const m = truthOf(h.shot.clip, h.shot.in, h.shot.out);
      return m ? answers(m.t, m.clip, q.rel) : false;
    });
    if (rank === 0) r1++;
    if (rank >= 0 && rank < 5) r5++;
    if (rank >= 0 && rank < 10) mrr += 1 / (rank + 1);
    for (const t of q.tags) {
      byTag[t] ??= { r5: 0, n: 0 };
      (byTag[t] as { r5: number; n: number }).n++;
      if (rank >= 0 && rank < 5) (byTag[t] as { r5: number; n: number }).r5++;
    }
    if (rank < 0 || rank >= 5) misses.push(`${q.id} (${rank < 0 ? '>10' : rank + 1})`);
  }
  void ix;
  const n = runs.length;
  return { r1: r1 / n, r5: r5 / n, mrr: mrr / n, n, byTag, misses };
}

// ---------------------------------------------------------------- pipeline accuracy (independent of the model)
function pipelineAccuracy() {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const shots = db
    .prepare('SELECT s.id, c.file, c.fps, s.f_in AS a, s.f_out AS b, s.motion, s.speed, s.text, s.said FROM shots s JOIN clips c ON c.id = s.clip_id')
    .all() as { id: number; file: string; fps: number; a: number; b: number; motion: string; text: string; said: string }[];
  if (ocr) {
    const lines = db.prepare('SELECT k.shot_id, o.text, o.conf FROM ocr o JOIN keyframes k ON k.id = o.kf_id WHERE o.engine = ?').all(ocr) as {
      shot_id: number;
      text: string;
      conf: number;
    }[];
    for (const s of shots)
      s.text = cleanOcr(
        lines.filter((l) => l.shot_id === s.id),
        OCR_MIN_CONF[ocr] ?? 0.75,
      ).join(' · ');
  }
  db.close();
  // cuts: every truth cut found within ±1 frame?
  let truthCuts = 0;
  let found = 0;
  let detCuts = 0;
  let right = 0;
  for (const c of truth) {
    const tc = c.shots.slice(1).map((s) => s.in);
    const dc = shots.filter((s) => s.file === c.file && s.a > 0).map((s) => s.a);
    truthCuts += tc.length;
    detCuts += dc.length;
    found += tc.filter((x) => dc.some((y) => Math.abs(x - y) <= 1)).length;
    right += dc.filter((y) => tc.some((x) => Math.abs(x - y) <= 1)).length;
  }
  // camera moves and text, on detected shots matched to truth
  const conf: Record<string, Record<string, number>> = {};
  let mOk = 0;
  let mN = 0;
  // text: burned-in captions (make.ts), text that is part of the photo (flagged in sources.json), and anything the OCR
  // reports elsewhere — product labels, signs, screens in the distractor photos are real text too, so that last count
  // is not an error rate (RESULTS.md says what was looked at by eye)
  const text = { captions: { found: 0, of: 0, missed: [] as string[] }, inPicture: { found: 0, of: 0 }, elsewhere: { shots: 0, of: 0, said: [] as string[] } };
  for (const s of shots) {
    const m = truthOf(s.file, s.a, s.b);
    if (!m) continue;
    const want = m.t.motion === 'push-in-fast' ? 'push-in' : m.t.motion;
    conf[want] ??= {};
    (conf[want] as Record<string, number>)[s.motion] = ((conf[want] as Record<string, number>)[s.motion] ?? 0) + 1;
    mN++;
    if (want === s.motion) mOk++;
    const saw = !!s.text;
    if (m.t.text) {
      text.captions.of++;
      if (saw) text.captions.found++;
      else text.captions.missed.push(`${m.t.id} "${m.t.text}"`);
    } else if (sources.get(m.t.key)?.text_in_picture) {
      text.inPicture.of++;
      if (saw) text.inPicture.found++;
    } else {
      text.elsewhere.of++;
      if (saw) {
        text.elsewhere.shots++;
        text.elsewhere.said.push(`${m.t.key}: "${s.text.slice(0, 40)}"`);
      }
    }
  }
  return {
    shots: { truth: truth.reduce((n, c) => n + c.shots.length, 0), detected: shots.length },
    cuts: { truth: truthCuts, detected: detCuts, recall: found / truthCuts, precision: right / Math.max(1, detCuts) },
    motion: { accuracy: mOk / mN, n: mN, confusion: conf },
    text,
  };
}

// ---------------------------------------------------------------- retrieval
async function main() {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const variants = (db.prepare('SELECT DISTINCT model FROM vectors ORDER BY model').all() as { model: string }[])
    .map((r) => r.model)
    .filter((m) => !only || only.split(',').includes(m));
  db.close();
  const queries = Q.queries.filter((q) => hasVoice || !q.tags.includes('said'));
  const parsed = new Map<string, Parsed>(queries.map((q) => [q.id, parseQuery(q.q)]));
  const textVecs = new Map<string, Map<string, Float32Array>>(); // model key → text → vector
  const pool: Record<string, Record<string, number>> = {};
  const out: Record<string, unknown> = { queries: queries.length, pipeline: pipelineAccuracy(), variants: {} };
  const table: string[] = [
    '| variant | R@1 | R@5 | MRR | German R@5 | raw query R@5 | no template R@5 | 1 keyframe R@5 | mean of keyframes R@5 | motion hard R@5 | text soft R@5 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const v of variants) {
    const [key, dtype] = v.split(':') as [string, Dtype];
    if (!textVecs.has(key)) {
      const e = await loadEmbedder(key, dtype, 4, { vision: false });
      const texts = new Set<string>();
      for (const q of queries) {
        const p = parsed.get(q.id) as Parsed;
        if (p.semantic) {
          texts.add(prompt(p.semantic));
          texts.add(p.semantic);
        }
        texts.add(prompt(q.q));
      }
      for (const g of Q.german ?? []) texts.add(parseQuery(g.q).semantic);
      const list = [...texts];
      const vecs = await e.texts(list);
      textVecs.set(key, new Map(list.map((t, i) => [t, vecs[i] as Float32Array])));
      await e.dispose();
    }
    const tv = textVecs.get(key) as Map<string, Float32Array>;
    const ix = loadIndex(dbFile, v, ocr);
    const run = (o: SearchOptions & { template?: boolean }) =>
      score(
        ix,
        queries.map((q) => {
          const p = parsed.get(q.id) as Parsed;
          const qv = o.raw
            ? (tv.get(prompt(q.q)) as Float32Array)
            : p.semantic
              ? (tv.get(o.template === false ? p.semantic : prompt(p.semantic)) as Float32Array)
              : null;
          return { q, hits: search(ix, qv, p, { k: 10, ...o }) };
        }),
      );
    const base = run({});
    // the same requests typed in German (no English template around them)
    const german = score(
      ix,
      (Q.german ?? []).flatMap((g) => {
        const like = queries.find((q) => q.id === g.like);
        if (!like) return [];
        const p = parseQuery(g.q);
        return [{ q: { ...like, id: g.id }, hits: search(ix, tv.get(p.semantic) as Float32Array, p, { k: 10 }) }];
      }),
    );
    // pooled judgements: the distractors that reach a top 5, to look at and judge by hand
    for (const q of queries) {
      const p = parsed.get(q.id) as Parsed;
      const qv = p.semantic ? (tv.get(prompt(p.semantic)) as Float32Array) : null;
      for (const h of search(ix, qv, p, { k: 5 })) {
        const m = truthOf(h.shot.clip, h.shot.in, h.shot.out);
        if (m?.t.key.startsWith('x_') && !answers(m.t, m.clip, q.rel)) {
          pool[q.id] ??= {};
          (pool[q.id] as Record<string, number>)[m.t.key] = ((pool[q.id] as Record<string, number>)[m.t.key] ?? 0) + 1;
        }
      }
    }
    const res = {
      german,
      base,
      raw: run({ raw: true }),
      noTemplate: run({ template: false }),
      oneKeyframe: run({ oneKeyframe: true }),
      mean: run({ agg: 'mean' }),
      motionHard: run({ motionMode: 'hard' }),
      textSoft: run({ textMode: 'soft' }),
    };
    (out.variants as Record<string, unknown>)[v] = res;
    const p = (x: number) => `${Math.round(x * 100)}`;
    table.push(
      `| ${v} | ${p(base.r1)} | **${p(base.r5)}** | ${base.mrr.toFixed(2)} | ${p(german.r5)} | ${p(res.raw.r5)} | ${p(res.noTemplate.r5)} | ${p(res.oneKeyframe.r5)} | ${p(res.mean.r5)} | ${p(res.motionHard.r5)} | ${p(res.textSoft.r5)} |`,
    );
    console.log(v.padEnd(26), `R@1 ${p(base.r1)}  R@5 ${p(base.r5)}  MRR ${base.mrr.toFixed(2)}  misses: ${base.misses.join(' ')}`);
    if (detail === v)
      for (const q of queries) {
        const pq = parsed.get(q.id) as Parsed;
        const qv = pq.semantic ? (tv.get(prompt(pq.semantic)) as Float32Array) : null;
        const hits = search(ix, qv, pq, { k: 5 });
        console.log(
          `  ${q.id} ${q.q}\n     ${hits
            .map((h) => {
              const m = truthOf(h.shot.clip, h.shot.in, h.shot.out);
              return `${m ? m.t.key : '?'}${m && answers(m.t, m.clip, q.rel) ? '✓' : ''}(${h.shot.motion})`;
            })
            .join('  ')}`,
        );
      }
  }
  // tags for the best variant by R@5 then MRR
  const best = Object.entries(out.variants as Record<string, { base: Score }>).sort((a, b) => b[1].base.r5 - a[1].base.r5 || b[1].base.mrr - a[1].base.mrr)[0];
  out.table = table.join('\n');
  out.pool = pool;
  out.best = best?.[0];
  writeJson(jsonOut, out);
  console.log(`\n${table.join('\n')}\n`);
  if (best) console.log('by tag (best):', JSON.stringify(best[1].base.byTag));
  console.log('pipeline:', JSON.stringify(out.pipeline, null, 1));
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

await main();
