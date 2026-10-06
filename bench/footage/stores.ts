#!/usr/bin/env node
// Where the vectors live: three embedded options with no server, at 10k and 100k vectors of 768 dimensions (SigLIP).
//   js-flat     vectors as BLOBs in a plain SQLite table (node:sqlite, built in), read into one Float32Array, scanned
//   sqlite-vec  the vec0 virtual table (brute-force KNN in C, a 160 KB extension), float32 and int8
//   lancedb     a Lance dataset on disk (Rust, ~200 MB native module), flat search and an IVF-PQ index
// Isolation: every option is measured with one store per workspace (Lampo's dataDir() per workspace) and with 10
// workspaces in one store, filtered by a workspace column (sqlite-vec partition key, LanceDB where-prefilter).
//   node bench/footage/stores.ts [--sizes 10000,100000] [--queries 50] [--stores flat,vec,lance] [--tag x]
// Vectors: the index's real keyframe vectors (index.db) plus noise, so neighbourhoods look like real ones; queries are
// the real text queries. Recall@10 is against the exact answer.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { median, pct, RESULTS_DIR, WORK_DIR, writeJson } from './common.ts';
import { loadEmbedder } from './embed.ts';
import { parseQuery, prompt } from './find.ts';

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] as string) : dflt;
};
const SIZES = arg('sizes', '10000,100000').split(',').map(Number);
const NQ = Number(arg('queries', '50'));
const STORES = arg('stores', 'flat,vec,lance').split(',');
const MODEL = 'siglip-b16:q8:pad';
const Q8 = "vec_quantize_int8(?, 'unit')";
const dir = path.join(WORK_DIR, 'stores');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

// ---------------------------------------------------------------- data
const src = new DatabaseSync(path.join(WORK_DIR, 'index.db'), { readOnly: true });
const real = (src.prepare('SELECT vec FROM vectors WHERE model = ?').all(MODEL) as { vec: Uint8Array }[]).map(
  (r) => new Float32Array(r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.vec.byteLength)),
);
src.close();
const D = real[0]?.length ?? 768;
let seed = 42;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
function synth(n: number): Float32Array {
  const out = new Float32Array(n * D);
  for (let i = 0; i < n; i++) {
    const base = real[i % real.length] as Float32Array;
    let s = 0;
    for (let d = 0; d < D; d++) {
      const v = (base[d] as number) + (0.6 * gauss()) / Math.sqrt(D);
      out[i * D + d] = v;
      s += v * v;
    }
    const k = 1 / Math.sqrt(s);
    for (let d = 0; d < D; d++) out[i * D + d] = (out[i * D + d] as number) * k;
  }
  return out;
}
const { queries } = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'queries.json'), 'utf8')) as {
  queries: { q: string }[];
};
const [key, dtype] = MODEL.split(':') as [string, 'q8'];
const te = await loadEmbedder(key, dtype, 4, { vision: false });
const qtexts = queries.map((q) => prompt(parseQuery(q.q).semantic || q.q));
const qvecs = (await te.texts(qtexts)).slice(0, NQ);
await te.dispose();

const du = (p: string): number => {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.size;
  return fs.readdirSync(p).reduce((s, f) => s + du(path.join(p, f)), 0);
};
const ms = (xs: number[]) => ({ min: +Math.min(...xs).toFixed(2), p50: +median(xs).toFixed(2), p95: +pct(xs, 95).toFixed(2) });

function exactTop(vecs: Float32Array, n: number, q: Float32Array, k = 10, from = 0): number[] {
  const scores = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const b = (from + i) * D;
    for (let d = 0; d < D; d++) s += (vecs[b + d] as number) * (q[d] as number);
    scores[i] = s;
  }
  // partial selection of the k best
  const top: number[] = [];
  for (let i = 0; i < n; i++) {
    if (top.length < k) {
      top.push(i);
      top.sort((a, b) => (scores[b] as number) - (scores[a] as number));
    } else if ((scores[i] as number) > (scores[top[k - 1] as number] as number)) {
      top[k - 1] = i;
      top.sort((a, b) => (scores[b] as number) - (scores[a] as number));
    }
  }
  return top.map((i) => i + from);
}
const recall = (got: number[], want: number[]) => got.filter((g) => want.includes(g)).length / want.length;

const results: Record<string, unknown>[] = [];
const row = (r: Record<string, unknown>) => {
  results.push(r);
  console.log(JSON.stringify(r));
};

for (const N of SIZES) {
  const vecs = synth(N);
  const wsOf = (i: number) => `w${i % 10}`;
  const exact = qvecs.map((q) => exactTop(vecs, N, q));

  // ------------------------------------------------ js-flat: BLOBs in node:sqlite, scanned in JS
  if (STORES.includes('flat')) {
    const f = path.join(dir, `flat-${N}.db`);
    const db = new DatabaseSync(f);
    db.exec('PRAGMA journal_mode = WAL; CREATE TABLE v (id INTEGER PRIMARY KEY, ws TEXT, vec BLOB)');
    const t0 = performance.now();
    db.exec('BEGIN');
    const ins = db.prepare('INSERT INTO v (id, ws, vec) VALUES (?, ?, ?)');
    for (let i = 0; i < N; i++) ins.run(BigInt(i), wsOf(i), new Uint8Array(vecs.buffer, i * D * 4, D * 4));
    db.exec('COMMIT');
    const insertMs = performance.now() - t0;
    db.close();
    const t1 = performance.now();
    const rd = new DatabaseSync(f, { readOnly: true });
    const loaded = new Float32Array(N * D);
    let i = 0;
    for (const r of rd.prepare('SELECT vec FROM v ORDER BY id').iterate() as Iterable<{ vec: Uint8Array }>) {
      loaded.set(new Float32Array(r.vec.buffer, r.vec.byteOffset, D), i * D);
      i++;
    }
    rd.close();
    const loadMs = performance.now() - t1;
    const times: number[] = [];
    let rec = 0;
    qvecs.forEach((q, j) => {
      const t = performance.now();
      const top = exactTop(loaded, N, q);
      times.push(performance.now() - t);
      rec += recall(top, exact[j] as number[]);
    });
    row({
      store: 'js-flat (node:sqlite BLOBs + JS scan)',
      N,
      insertMs: Math.round(insertMs),
      openMs: Math.round(loadMs),
      query: ms(times),
      recall10: rec / qvecs.length,
      diskMB: +(du(f) / 1e6).toFixed(1),
      memMB: +((N * D * 4) / 1e6).toFixed(0),
    });
  }

  // ------------------------------------------------ sqlite-vec
  const sqliteVec = await import('sqlite-vec');
  for (const kind of STORES.includes('vec') ? (['float', 'int8'] as const) : []) {
    const f = path.join(dir, `vec-${kind}-${N}.db`);
    const db = new DatabaseSync(f, { allowExtension: true });
    db.loadExtension(sqliteVec.getLoadablePath());
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`CREATE VIRTUAL TABLE v USING vec0(ws TEXT PARTITION KEY, embedding ${kind === 'float' ? 'float' : 'int8'}[${D}] distance_metric=cosine)`);
    const t0 = performance.now();
    db.exec('BEGIN');
    const ins = db.prepare(`INSERT INTO v (rowid, ws, embedding) VALUES (?, ?, ${kind === 'float' ? '?' : Q8})`);
    for (let i = 0; i < N; i++) ins.run(BigInt(i), wsOf(i), new Uint8Array(vecs.buffer, i * D * 4, D * 4));
    db.exec('COMMIT');
    const insertMs = performance.now() - t0;
    const knnAll = db.prepare(`SELECT rowid FROM v WHERE embedding MATCH ${kind === 'float' ? '?' : Q8} AND k = 10`);
    const knnWs = db.prepare(`SELECT rowid FROM v WHERE embedding MATCH ${kind === 'float' ? '?' : Q8} AND k = 10 AND ws = ?`);
    const times: number[] = [];
    const timesWs: number[] = [];
    let rec = 0;
    let leak = 0;
    qvecs.forEach((q, j) => {
      const qb = new Uint8Array(q.buffer, q.byteOffset, q.byteLength);
      let t = performance.now();
      const top = (knnAll.all(qb) as { rowid: number }[]).map((r) => Number(r.rowid));
      times.push(performance.now() - t);
      rec += recall(top, exact[j] as number[]);
      t = performance.now();
      const ws = (knnWs.all(qb, 'w3') as { rowid: number }[]).map((r) => Number(r.rowid));
      timesWs.push(performance.now() - t);
      leak += ws.filter((id) => wsOf(id) !== 'w3').length;
    });
    db.close();
    row({
      store: `sqlite-vec vec0 ${kind}[${D}]`,
      N,
      insertMs: Math.round(insertMs),
      query: ms(times),
      recall10: rec / qvecs.length,
      oneOfTenWorkspaces: { query: ms(timesWs), otherWorkspaceRows: leak },
      diskMB: +(du(f) / 1e6).toFixed(1),
    });
  }

  // ------------------------------------------------ lancedb
  const lancedb = await import('@lancedb/lancedb');
  const arrow = await import('apache-arrow');
  if (STORES.includes('lance')) {
    const p = path.join(dir, `lance-${N}`);
    const conn = await lancedb.connect(p);
    const vecType = new arrow.FixedSizeList(D, new arrow.Field('item', new arrow.Float32(), true));
    const vecData = arrow.makeData({ type: vecType, length: N, nullCount: 0, child: arrow.makeData({ type: new arrow.Float32(), length: N * D, data: vecs }) });
    const table = new arrow.Table({
      id: arrow.vectorFromArray(
        Array.from({ length: N }, (_, i) => i),
        new arrow.Int32(),
      ),
      ws: arrow.vectorFromArray(
        Array.from({ length: N }, (_, i) => wsOf(i)),
        new arrow.Utf8(),
      ),
      vector: arrow.makeVector(vecData),
    });
    const t0 = performance.now();
    const tbl = await conn.createTable('kf', table as never, { mode: 'overwrite' });
    const insertMs = performance.now() - t0;
    const run = async (opts: { ws?: string; refine?: number }) => {
      const times: number[] = [];
      let rec = 0;
      let leak = 0;
      for (const [j, q] of qvecs.entries()) {
        const t = performance.now();
        let s = tbl.vectorSearch(Array.from(q)).distanceType('cosine').limit(10);
        if (opts.ws) s = s.where(`ws = '${opts.ws}'`);
        if (opts.refine) s = s.refineFactor(opts.refine);
        const rows = (await s.select(['id', 'ws']).toArray()) as { id: number; ws: string }[];
        times.push(performance.now() - t);
        const ids = rows.map((r) => Number(r.id));
        if (!opts.ws) rec += recall(ids, exact[j] as number[]);
        if (opts.ws) leak += rows.filter((r) => r.ws !== opts.ws).length;
      }
      return { query: ms(times), recall10: opts.ws ? undefined : rec / qvecs.length, otherWorkspaceRows: opts.ws ? leak : undefined };
    };
    const flat = await run({});
    const flatWs = await run({ ws: 'w3' });
    row({ store: 'lancedb flat', N, insertMs: Math.round(insertMs), ...flat, oneOfTenWorkspaces: flatWs, diskMB: +(du(p) / 1e6).toFixed(1) });
    if (N >= 10000) {
      const t1 = performance.now();
      await tbl.createIndex('vector', {
        config: lancedb.Index.ivfPq({ numPartitions: Math.round(Math.sqrt(N)), numSubVectors: D / 16, distanceType: 'cosine' }),
      });
      const indexMs = performance.now() - t1;
      const ivf = await run({});
      const ivfRefine = await run({ refine: 10 });
      const ivfWs = await run({ ws: 'w3' });
      row({
        store: 'lancedb IVF-PQ',
        N,
        indexMs: Math.round(indexMs),
        ...ivf,
        refined10: ivfRefine,
        oneOfTenWorkspaces: ivfWs,
        diskMB: +(du(p) / 1e6).toFixed(1),
      });
    }
  }
}
writeJson(path.join(RESULTS_DIR, `stores${arg('tag', '') ? `-${arg('tag', '')}` : ''}.json`), { dim: D, queries: qvecs.length, results });
