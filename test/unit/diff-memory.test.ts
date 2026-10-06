// The version diff (lib/diff.ts) streams both renders: it keeps a window of the older one's frames around the frame it
// compares, never every decoded frame of both (A13 MEDIA-1: two small uploads at 240 fps held ~700 MB, a 4 h one would
// hold hundreds of GB). Memory must not grow with the length of the videos.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { DiffReport, Version } from '../../lib/types.ts';
import { isolatedEnv, makeVideo, tmpdir } from '../lib/helpers.ts';

isolatedEnv();
const { diffVersions } = await import('../../lib/diff.ts');
const { probeSync, quickHash } = await import('../../lib/probe.ts');

const dir = tmpdir('vr-diff-memory-');
const ver = (f: string, v: number): Version => ({ v, hash: quickHash(f), mtime: '', size: fs.statSync(f).size, registered: '', ...probeSync(f) });
// Square clips: the analysis frame is 160×160 grey (25.6 kB), so every second at 25 fps is 640 kB held if all are kept.
const clip = (name: string, seconds: number, pattern: string) =>
  makeVideo(path.join(dir, name), { w: 64, h: 64, fps: 25, dur: seconds, pattern, audio: false, gop: 250 });

/** The most Buffer memory (ArrayBuffers) held above where it started while fn ran. */
async function peakBuffers<T>(fn: () => Promise<T>): Promise<{ result: T; peak: number }> {
  const base = process.memoryUsage().arrayBuffers;
  let peak = 0;
  const poll = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().arrayBuffers - base);
  }, 2);
  try {
    const result = await fn();
    peak = Math.max(peak, process.memoryUsage().arrayBuffers - base);
    return { result, peak };
  } finally {
    clearInterval(poll);
  }
}

const MB = 1e6;

test('the diff of two 2-minute versions holds about as much as the diff of two 30-second ones', { timeout: 180_000 }, async () => {
  const shortA = clip('short-a.mp4', 30, 'testsrc2');
  const shortB = clip('short-b.mp4', 30, 'testsrc');
  const longA = clip('long-a.mp4', 120, 'testsrc2');
  const longB = clip('long-b.mp4', 120, 'testsrc');
  const short = await peakBuffers(() => diffVersions(shortA, ver(shortA, 1), shortB, ver(shortB, 2)));
  const long = await peakBuffers(() => diffVersions(longA, ver(longA, 1), longB, ver(longB, 2)));
  const d = long.result as DiffReport;
  assert.equal(d.new.frames, 3000, 'every frame of the new version was compared');
  assert.equal(d.old.frames, 3000, 'every frame of the old version was counted');
  // All frames of both 2-minute versions are 2 × 3000 × 25.6 kB = 154 MB (twice that while they were joined).
  console.log(`peak Buffer memory: 30 s ${Math.round(short.peak / MB)} MB, 2 min ${Math.round(long.peak / MB)} MB`);
  assert.ok(long.peak < 40 * MB, `the 2-minute diff held ${Math.round(long.peak / MB)} MB of frames`);
  assert.ok(long.peak < short.peak + 16 * MB, `4× the frames held ${Math.round(long.peak / MB)} MB vs ${Math.round(short.peak / MB)} MB`);
});
