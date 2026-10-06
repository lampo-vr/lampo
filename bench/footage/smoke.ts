#!/usr/bin/env node
// Quick check that every model loads and agrees with itself: three frames of the coffee reel against three captions.
//   node bench/footage/smoke.ts [model …]
import path from 'node:path';
import { CLIPS_DIR } from './common.ts';
import { cosine, type Dtype, framesAt, loadEmbedder } from './embed.ts';
import { MODELS } from './models.ts';

const keys = process.argv.slice(2).length ? process.argv.slice(2) : MODELS.map((m) => m.key);
const frames = [37, 112, 700]; // coffee on white, latte art being poured, a latte in a glass
const captions = ['a cup of black coffee on a white table', 'pouring milk to make latte art', 'a latte in a glass with a spoon'];
for (const key of keys) {
  const m = MODELS.find((x) => x.key === key);
  for (const dtype of Object.keys(m?.vision ?? {}) as Dtype[]) {
    const t0 = performance.now();
    const e = await loadEmbedder(key, dtype, 4);
    const load = performance.now() - t0;
    const imgs = await e.images(await framesAt(path.join(CLIPS_DIR, 'reel_coffee.mp4'), frames, e.size, 'crop'));
    const txt = await e.texts(captions);
    const sims = imgs.map((v) => txt.map((t) => cosine(v, t).toFixed(3)).join(' '));
    const right = imgs.filter((v, i) => txt.map((t) => cosine(v, t)).indexOf(Math.max(...txt.map((t) => cosine(v, t)))) === i).length;
    console.log(`${key} ${dtype}: load ${Math.round(load)} ms, dim ${imgs[0]?.length}, diagonal ${right}/3 | ${sims.join(' | ')}`);
    await e.dispose();
  }
}
