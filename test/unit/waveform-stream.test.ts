// covers: lib/media.ts lib/probe.ts
// A version's waveform is measured while ffmpeg decodes its audio, never held whole: what it gives per frame is what
// measuring the whole decode at once gave (also when a sample is split between two pieces of the pipe), and audio
// longer than one decode could hold (past 1 GiB, about twelve hours) still has its waveform. The long one comes from a
// stand-in ffmpeg that writes a known pattern and then a bounded run of silence.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Version } from '../../lib/types.ts';
import { FFMPEG, isolatedEnv, makeVideo, tmpdir } from '../lib/helpers.ts';

const FPS = 25;
const SR = 12000;
const PER_FRAME = SR / FPS;
const FRAMES = 10;

// The stand-in: the pattern (frame k has one sample of (k + 1) × 1000 in it), then just over 1 GiB of silence.
const work = tmpdir('vr-waveform-');
const pattern = path.join(work, 'pattern.s16le');
{
  const pcm = Buffer.alloc(FRAMES * PER_FRAME * 2);
  for (let k = 0; k < FRAMES; k++) pcm.writeInt16LE((k + 1) * 1000, (k * PER_FRAME + 7) * 2);
  fs.writeFileSync(pattern, pcm);
}
const standIn = path.join(work, 'ffmpeg');
fs.writeFileSync(standIn, `#!/bin/sh\ncat ${JSON.stringify(pattern)}\nhead -c ${2 ** 30 + 2} /dev/zero\n`, { mode: 0o755 });

const { dir } = isolatedEnv({ vars: { VR_FFMPEG: standIn } });
const { frameMeter, waveform } = await import('../../lib/media.ts');

/** What the waveform was before it streamed: the whole decode in memory, then frame by frame. */
function measuredWhole(pcm: Buffer, frames: number, perFrame: number) {
  const samples = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length - (pcm.length % 2)));
  const peaks = new Array<number>(frames).fill(0);
  const rms = new Array<number>(frames).fill(0);
  for (let f = 0; f < frames; f++) {
    const a = Math.floor(f * perFrame);
    const b = Math.min(samples.length, Math.floor((f + 1) * perFrame));
    let pk = 0;
    let sq = 0;
    for (let i = a; i < b; i++) {
      const v = Math.abs(samples[i] as number) / 32768;
      if (v > pk) pk = v;
      sq += v * v;
    }
    peaks[f] = Math.round(pk * 1000) / 1000;
    rms[f] = b > a ? Math.round(Math.sqrt(sq / (b - a)) * 1000) / 1000 : 0;
  }
  return { peaks, rms };
}

test('measured as it is decoded, every frame reads as the whole decode measured at once did, in pieces of any size', () => {
  const clip = makeVideo(path.join(dir, 'tone.mp4'), { fps: 30, dur: 3, freq: 523 });
  const pcm = execFileSync(FFMPEG, ['-v', 'error', '-i', clip, '-map', '0:a:0', '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'], {
    maxBuffer: 1 << 26,
  });
  // more frames than the audio has: the ones past its end stay 0
  const frames = 95;
  const want = measuredWhole(pcm, frames, SR / 30);
  for (const piece of [pcm.length, 4096, 4097, 1, 3]) {
    const meter = frameMeter(frames, SR / 30);
    for (let at = 0; at < pcm.length; at += piece) meter.feed(pcm.subarray(at, at + piece));
    assert.deepEqual(meter.result(), want, `in pieces of ${piece} bytes`);
  }
  assert.ok(
    want.peaks.slice(0, 80).every((p) => p > 0.05),
    'the tone is heard',
  );
});

test('audio longer than one decode could hold still has its waveform, frame by frame', { timeout: 120_000 }, async () => {
  const ver = { hash: 'a'.repeat(40), sample: 'b'.repeat(40), fps: FPS, frames: FRAMES } as Pick<Version, 'hash' | 'sample' | 'fps' | 'frames'>;
  const w = await waveform(path.join(dir, 'any.mp4'), ver);
  assert.equal(w.audio, true, 'the waveform was measured');
  assert.deepEqual(
    w.peaks,
    Array.from({ length: FRAMES }, (_, k) => Math.round((((k + 1) * 1000) / 32768) * 1000) / 1000),
  );
  assert.ok(w.rms.every((r) => r > 0));
});
