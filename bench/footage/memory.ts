#!/usr/bin/env node
// Peak memory of each half alone, as the app would run them: the image side in the indexing worker (load + 16 frames,
// batch 8) and the text side where queries are answered (load + 5 queries). One fresh process per measurement.
//   node bench/footage/memory.ts [--variants siglip2-b16:q8,…]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { CLIPS_DIR, RESULTS_DIR, writeJson } from './common.ts';
import { type Dtype, framesAt, loadEmbedder } from './embed.ts';

if (process.argv[2] === '--child') {
  const [key, dtype] = (process.argv[3] as string).split(':') as [string, Dtype];
  const part = process.argv[4];
  const base = process.memoryUsage().rss;
  if (part === 'vision') {
    const e = await loadEmbedder(key, dtype, 4, { text: false });
    const f = await framesAt(
      path.join(CLIPS_DIR, 'reel_lifestyle.mp4'),
      Array.from({ length: 16 }, (_, i) => 30 + i * 90),
      e.size,
      'pad',
    );
    await e.images(f.slice(0, 8));
    await e.images(f.slice(8));
  } else {
    const e = await loadEmbedder(key, dtype, 4, { vision: false });
    for (const q of ['a photo of waves', 'a photo of a pug in a blanket', 'a photo of latte art', 'a photo of a city at night', 'a photo of a runner'])
      await e.texts([q]);
  }
  console.log(JSON.stringify({ baseMB: Math.round(base / 1e6), peakMB: Math.round(process.resourceUsage().maxRSS / 1024) }));
} else {
  const i = process.argv.indexOf('--variants');
  const variants = (i > 0 ? (process.argv[i + 1] as string) : 'clip-b32:fp32,clip-b32:q8,siglip-b16:q8,siglip2-b16:q8,mobileclip-s2:fp32').split(',');
  const rows: Record<string, unknown>[] = [];
  for (const v of variants) {
    const r: Record<string, unknown> = { variant: v };
    for (const part of ['vision', 'text']) {
      const out = spawnSync(process.execPath, [process.argv[1] as string, '--child', v, part], { encoding: 'utf8' });
      const line = out.stdout.trim().split('\n').pop() || '{}';
      r[part] = JSON.parse(line.startsWith('{') ? line : '{}');
    }
    rows.push(r);
    console.log(JSON.stringify(r));
  }
  writeJson(path.join(RESULTS_DIR, 'memory.json'), rows);
}
