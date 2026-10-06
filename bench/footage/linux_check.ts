#!/usr/bin/env node
// The server's platform: do the Linux x86-64 prebuilts (onnxruntime-node, sqlite-vec) install and give the same
// vectors as on the Mac? docker_x64.sh runs the check half in node:24-slim (linux/amd64, emulated on Apple Silicon —
// correctness only, its speed means nothing).
//   node bench/footage/linux_check.ts --dump     (on the Mac) frames as raw RGB + the Mac's vectors → cache/footage/work/linux/
//   node bench/footage/linux_check.ts --check    (in the container) the same frames → vectors, compared; sqlite-vec KNN
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BENCH, CLIPS_DIR, WORK_DIR } from './common.ts';
import { cosine, type Dtype, loadEmbedder } from './embed.ts';

const dir = path.join(WORK_DIR, 'linux');
const VARIANTS = ['siglip2-b16:q8', 'siglip-b16:q8', 'clip-b32:q8'];
const FRAMES = [40, 300, 700, 1200, 1800];

if (process.argv.includes('--dump')) {
  const { framesAt } = await import('./embed.ts');
  fs.mkdirSync(dir, { recursive: true });
  const out: Record<string, number[][]> = {};
  for (const v of VARIANTS) {
    const [key, dtype] = v.split(':') as [string, Dtype];
    const e = await loadEmbedder(key, dtype, 4, { text: false });
    const rgb = await framesAt(path.join(CLIPS_DIR, 'reel_lifestyle.mp4'), FRAMES, e.size, 'pad');
    fs.writeFileSync(path.join(dir, `frames-${e.size}.bin`), Buffer.concat(rgb.map((f) => Buffer.from(f))));
    out[v] = (await e.images(rgb)).map((x) => Array.from(x));
    await e.dispose();
  }
  fs.writeFileSync(path.join(dir, 'mac.json'), JSON.stringify(out));
  console.log('dumped', Object.keys(out).join(', '));
}

if (process.argv.includes('--check')) {
  const mac = JSON.parse(fs.readFileSync(path.join(dir, 'mac.json'), 'utf8')) as Record<string, number[][]>;
  const report: string[] = [`${process.platform}-${process.arch} · node ${process.version} · ${os.cpus()[0]?.model ?? ''}`];
  for (const v of VARIANTS) {
    const [key, dtype] = v.split(':') as [string, Dtype];
    const e = await loadEmbedder(key, dtype, 2, { text: false });
    const raw = fs.readFileSync(path.join(dir, `frames-${e.size}.bin`));
    const n = e.size * e.size * 3;
    const rgb = FRAMES.map((_, i) => new Uint8Array(raw.subarray(i * n, (i + 1) * n)));
    const t0 = performance.now();
    const vecs = await e.images(rgb);
    const ms = (performance.now() - t0) / rgb.length;
    const sims = vecs.map((x, i) => cosine(x, Float32Array.from(mac[v]?.[i] ?? [])));
    report.push(`${v}: cosine to the Mac's vectors min ${Math.min(...sims).toFixed(5)} · ${Math.round(ms)} ms/frame (emulated, not a speed)`);
    await e.dispose();
  }
  const sv = await import('sqlite-vec');
  const db = new DatabaseSync(':memory:', { allowExtension: true });
  db.loadExtension(sv.getLoadablePath());
  db.exec('CREATE VIRTUAL TABLE v USING vec0(embedding float[4])');
  db.prepare('INSERT INTO v (rowid, embedding) VALUES (1, ?), (2, ?)').run(
    new Uint8Array(Float32Array.from([1, 0, 0, 0]).buffer),
    new Uint8Array(Float32Array.from([0, 1, 0, 0]).buffer),
  );
  const hit = db.prepare('SELECT rowid FROM v WHERE embedding MATCH ? AND k = 1').get(new Uint8Array(Float32Array.from([0.9, 0.1, 0, 0]).buffer)) as {
    rowid: number;
  };
  report.push(`sqlite-vec ${(db.prepare('SELECT vec_version() v').get() as { v: string }).v}: nearest = ${hit.rowid} (want 1)`);
  console.log(report.join('\n'));
  fs.writeFileSync(path.join(dir, `check-${process.platform}-${process.arch}.txt`), `${report.join('\n')}\n`);
  void BENCH;
}
