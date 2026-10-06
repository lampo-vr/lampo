// covers: lib/footage/analyse.ts lib/footage/indexer.ts
// Footage search's work follows the video's length, not how it is cut (A13 MEDIA-3): a clip that cuts every few frames
// made a keyframe per shot (a 10 s clip at 240 fps, 400 keyframes: 80 × the docs' set), and a picture job took the next
// 48 keyframes in frame order and decoded from the first to the last, so a single long take's six keyframes made one job
// decode 50 minutes of an hour. Now a shot is at least half a second (shorter ones join the next), a video has at most
// 60 keyframes a minute, and a picture job reads keyframes within one analysis chunk of its first.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { age, encodeOnce, FFMPEG, isolatedEnv, tmpdir } from '../lib/helpers.ts';

// a stand-in ffmpeg that notes every command line, then does the real work
const work = tmpdir('vr-footage-bounds-');
const standIn = path.join(work, 'ffmpeg');
fs.writeFileSync(standIn, `#!/bin/sh\necho "$*" >> ${JSON.stringify(path.join(work, 'args'))}\nexec ${JSON.stringify(FFMPEG)} "$@"\n`, { mode: 0o755 });

const { dir } = isolatedEnv({ vars: { VR_FOOTAGE: 'auto', VR_FOOTAGE_MODEL: 'fake', VR_OCR: 'off', VR_FFMPEG: standIn, VR_FOOTAGE_HWACCEL: 'off' } });
const store = await import('../../lib/store.ts');
const { CHUNK_FRAMES, newReading, readChunk, shotsOf } = await import('../../lib/footage/analyse.ts');
const { createEmbedder, resetEmbedder } = await import('../../lib/footage/embedder.ts');
const { indexNow, targets } = await import('../../lib/footage/indexer.ts');
const { closeIndexes } = await import('../../lib/footage/db.ts');

const e = createEmbedder({ kind: 'fake' });
resetEmbedder(e);
after(() => {
  resetEmbedder();
  closeIndexes();
});

const clip = (name: string, args: string[]) => {
  const file = encodeOnce(path.join(dir, 'footage', name), ['-v', 'error', ...args, '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  age(file);
  return file;
};

test('a clip that cuts every tenth of a second has a few keyframes a second at most, not one per cut', async () => {
  // 10 s at 50 fps; every 5 frames the whole picture flips to white and back: a cut each time
  const strobe = clip('strobe.mp4', [
    ...['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=50:d=10'],
    ...['-vf', "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='mod(floor(n/5),2)'"],
  ]);
  const meta = { fps: 50, width: 160, height: 90 };
  const r = newReading();
  while (!r.ended && r.frames < 500) await readChunk(strobe, meta, r, Math.min(500, r.frames + CHUNK_FRAMES));
  const shots = shotsOf(r, meta);
  const keyframes = shots.reduce((n, s) => n + s.keyframes.length, 0);
  assert.ok(keyframes <= 10, `${keyframes} keyframes in 10 s (${shots.length} shots): at most 60 a minute`);
  assert.ok(
    shots.every((s) => s.end - s.in >= 25),
    `shots of ${shots.map((s) => s.end - s.in).join(', ')} frames: none under half a second`,
  );
  for (const s of shots) for (const k of s.keyframes) assert.ok(k >= s.in && k < s.end);
});

test('a single long take is read a chunk at a time: no picture job decodes from one end of it to the other', { timeout: 300_000 }, async () => {
  // three minutes at 25 fps without a cut: its keyframes lie 30 s apart, 4,500 frames in all
  const take = clip('take.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=180', '-g', '250']);
  store.createOrGetReview(take, { by: 'tester' });
  fs.rmSync(path.join(work, 'args'), { force: true });
  assert.equal(await indexNow(targets(), { e }), 1);
  // the picture jobs: one ffmpeg each, its frames picked by a select (lib/probe.ts selectFrames: eq(n,f) for a frame,
  // between(n,a,b)*… for evenly spaced ones) counted from the first one sought to
  const spans = fs
    .readFileSync(path.join(work, 'args'), 'utf8')
    .split('\n')
    .filter((l) => l.includes("select='"))
    .map((l) => Math.max(...[...l.matchAll(/(?:eq\(n\\?,|between\(n\\?,\d+\\?,)(\d+)\)/g)].map((m) => Number(m[1]))));
  assert.ok(spans.length >= 2, `${spans.length} picture jobs`);
  assert.ok(spans.every(Number.isFinite), `every picture job's frames read: ${spans}`);
  assert.ok(Math.max(...spans) <= CHUNK_FRAMES, `a picture job decoded ${Math.max(...spans)} frames past its first keyframe`);
});
