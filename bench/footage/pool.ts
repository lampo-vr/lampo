#!/usr/bin/env node
// Pooled judgements (as in TREC): the distractor photos that reached some model's top 5 for a query, one sheet per
// query, to look at and judge by hand. The ones that do answer the query go into its keys in queries.json (22 did, in two rounds);
// the rest stay wrong answers. Re-run after adding models or queries.
//   node bench/footage/eval.ts && node bench/footage/pool.ts [eval.json] → cache/footage/work/pool/<query>.jpg
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BENCH, fontFile, IMAGES_DIR, RESULTS_DIR, readJson, WORK_DIR } from './common.ts';

const ev = readJson<{ pool: Record<string, Record<string, number>> }>(path.join(RESULTS_DIR, process.argv[2] || 'eval.json'));
const { queries } = readJson<{ queries: { id: string; q: string }[] }>(path.join(BENCH, 'queries.json'));
const font = fontFile().replace(/:/g, '\\:');
const out = path.join(WORK_DIR, 'pool');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const [qid, keys] of Object.entries(ev.pool)) {
  const ks = Object.entries(keys)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k)
    .slice(0, 8);
  console.log(`${qid} ${queries.find((x) => x.id === qid)?.q ?? ''}: ${ks.join(' ')}`);
  const parts = ks.map(
    (k, i) =>
      `[${i}:v]scale=300:200:force_original_aspect_ratio=decrease,pad=300:200:(ow-iw)/2:(oh-ih)/2:gray,drawtext=fontfile='${font}':text='${i + 1} ${k}':x=4:y=4:fontsize=13:fontcolor=yellow:box=1:boxcolor=black@0.7[t${i}]`,
  );
  const layout = ks.map((_, i) => `${(i % 4) * 300}_${Math.floor(i / 4) * 200}`).join('|');
  const graph =
    ks.length === 1
      ? `${parts[0]};[t0]copy[s]`
      : `${parts.join(';')};${ks.map((_, i) => `[t${i}]`).join('')}xstack=inputs=${ks.length}:layout=${layout}:fill=black[s]`;
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    ...ks.flatMap((k) => ['-i', path.join(IMAGES_DIR, `${k}.jpg`)]),
    '-filter_complex',
    graph,
    '-map',
    '[s]',
    '-frames:v',
    '1',
    '-q:v',
    '5',
    path.join(out, `${qid}.jpg`),
  ]);
}
