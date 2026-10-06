// The core promise: the screenshot for frame N is frame N (seek-based grab == decode-and-count ground truth).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import type { ProbeResult } from '../../lib/types.ts';
import { isolatedEnv, makeVideo, md5, rawRgb } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const { grabFrame, colorFilter, seekTime, renderMarked } = await import('../../lib/shots.ts');
const { probe, FFPROBE } = await import('../../lib/probe.ts');
// The frames a decoder counts in the file: what probe's frame count must say, whichever ffmpeg made the clip.
const decoded = (file: string) =>
  Number(
    execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file], {
      encoding: 'utf8',
    }),
  );

// ffmpeg's decode order counter: the n-th decoded frame, with the same colour conversion as grabFrame.
const truth = (file: string, n: number, meta: ProbeResult) =>
  rawRgb(['-i', file, '-vf', `select=eq(n\\,${n}),${colorFilter(meta)}`, '-fps_mode', 'passthrough']);

async function check(file: string, frames: number[]): Promise<ProbeResult> {
  const meta = await probe(file);
  for (const n of frames) {
    const out = path.join(dir, `f${n}.png`);
    await grabFrame(file, n, meta, out);
    const got = md5(rawRgb(['-i', out]));
    assert.equal(got, md5(truth(file, n, meta)), `frame ${n} of ${path.basename(file)}`);
    if (n > 0) assert.notEqual(got, md5(truth(file, n - 1, meta)), `frame ${n - 1} differs from ${n} (test clip sanity)`);
  }
  return meta;
}

test('seekTime lands half a frame early', () => {
  assert.equal(seekTime(0, 30), 0);
  assert.equal(seekTime(363, 30), 362.5 / 30);
});

test('30 fps H.264 with B-frames: first, GOP boundaries, middle, last', async () => {
  const file = makeVideo(path.join(dir, 'c30.mp4'), { w: 320, h: 180, fps: 30, dur: 3 });
  const meta = await check(file, [0, 1, 29, 47, 48, 49, 60, 88, 89]);
  assert.equal(meta.frames, 90);
  assert.equal(decoded(file), 90);
});

test('23.976 fps', async () => {
  const file = makeVideo(path.join(dir, 'c2398.mp4'), { w: 320, h: 180, fps: '24000/1001', dur: 2 });
  const meta = await check(file, [0, 1, 23, 24, 25, 46]);
  // 2 s at 23.976 is 47.95 frames: ffmpeg 8 writes 47, 5.1 writes 48. Whatever is in the file, probe must count it.
  assert.ok(meta.frames === 47 || meta.frames === 48, `2 s at 23.976: ${meta.frames} frames`);
  assert.equal(meta.frames, decoded(file), 'probe counts the frames a decoder finds');
  assert.ok(Math.abs(meta.fps - 23.976) < 0.001);
});

test('25 fps landscape', async () => {
  await check(makeVideo(path.join(dir, 'c25.mp4'), { w: 256, h: 144, fps: 25, dur: 2 }), [0, 12, 24, 25, 49]);
});

test('renderMarked burns the drawing in at video resolution', async () => {
  const file = makeVideo(path.join(dir, 'm.mp4'), { w: 160, h: 90, fps: 30, dur: 1 });
  const meta = await probe(file);
  const clean = await grabFrame(file, 5, meta, path.join(dir, 'm_clean.png'));
  const marked = await renderMarked(clean, [{ type: 'box', x: 10, y: 10, w: 80, h: 50 }], 160, 90, path.join(dir, 'm_marked.png'));
  const a = rawRgb(['-i', clean]);
  const b = rawRgb(['-i', marked]);
  assert.equal(a.length, b.length, 'same dimensions');
  assert.notEqual(md5(a), md5(b));
  const same = await renderMarked(clean, [], 160, 90, path.join(dir, 'm_same.png'));
  assert.equal(md5(rawRgb(['-i', same])), md5(a), 'no drawing → marked equals clean');
});

test('a range note gets a strip: the chosen frames, left to right and row by row, each frame-exact', async () => {
  const { grabStrip } = await import('../../lib/shots.ts');
  const { stripFrames } = await import('../../lib/range.ts');
  const file = makeVideo(path.join(dir, 'strip.mp4'), { w: 320, h: 180, fps: 30, dur: 3 });
  const meta = await probe(file);
  const frames = stripFrames({ in: 10, out: 70 });
  assert.deepEqual(frames, [10, 22, 34, 46, 58, 70]);
  const out = await grabStrip(file, frames, meta, path.join(dir, 'strip.jpg'));
  // 3 × 2 tiles of 426 × 240 (the picture scaled to 426 wide), each with a 2 px black border.
  const W = 3 * 430;
  const H = 2 * 244;
  const px = rawRgb(['-i', out]);
  assert.equal(px.length, W * H * 3, `the strip is ${W} × ${H}`);
  const tile = (i: number) => {
    const x0 = (i % 3) * 430 + 2;
    const y0 = Math.floor(i / 3) * 244 + 2;
    const t = Buffer.alloc(426 * 240 * 3);
    for (let y = 0; y < 240; y++) px.copy(t, y * 426 * 3, ((y0 + y) * W + x0) * 3, ((y0 + y) * W + x0 + 426) * 3);
    return t;
  };
  const scaled = (n: number) => rawRgb(['-i', file, '-vf', `select=eq(n\\,${n}),${colorFilter(meta)},scale=426:240`, '-fps_mode', 'passthrough']);
  const truths = frames.map(scaled);
  const diff = (a: Buffer, b: Buffer) => {
    let s = 0;
    for (let k = 0; k < a.length; k++) s += Math.abs((a[k] as number) - (b[k] as number));
    return s / a.length;
  };
  for (let i = 0; i < frames.length; i++) {
    const d = truths.map((tr) => diff(tile(i), tr));
    const best = d.indexOf(Math.min(...d));
    assert.equal(best, i, `tile ${i} shows frame ${frames[i]} (closest: ${frames[best]}; differences ${d.map((x) => x.toFixed(1)).join(', ')})`);
  }
});
