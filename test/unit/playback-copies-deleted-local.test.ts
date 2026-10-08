// On a person's own machine (the local storage adapter, playback copies in cache/): a deleted video's scrub copy goes
// with it, as from a bucket (playback-copies-deleted.test.ts), and the copy of a video that stays is left alone.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { age, isolatedEnv, makeVideo, must } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const { CACHE, slugify } = await import('../../lib/paths.ts');
const { renderKey } = await import('../../lib/renderKey.ts');
const { queued } = await import('../../lib/jobs.ts');
const { createPlayback } = await import('../../server/playback.ts');

const drained = async () => {
  for (let i = 0; i < 1200 && queued() > 0; i++) await new Promise((r) => setTimeout(r, 50));
};

function track(rel: string, freq: number) {
  const file = makeVideo(path.join(dir, rel), { w: 320, h: 180, dur: 1, freq });
  age(file);
  const { review } = store.createOrGetReview(file, { by: 'tester' });
  const ver = must(review.versions[0], 'v1');
  return { slug: slugify(file), review, ver, copy: path.join(CACHE, 'scrub', `${renderKey(ver)}.mp4`) };
}

test('a deleted video’s scrub copy leaves cache/; another video’s stays', async () => {
  const gone = track('proj/export/gone.mp4', 900);
  const kept = track('proj/export/kept.mp4', 950);
  const pb = createPlayback(() => {});
  pb.playable(gone.review, gone.ver, { build: true });
  pb.playable(kept.review, kept.ver, { build: true });
  await drained();
  assert.ok(fs.existsSync(gone.copy) && fs.existsSync(kept.copy), 'both copies made');
  assert.ok(store.removeVideo(gone.slug, 'tester'));
  await store.removalsSettled();
  assert.equal(fs.existsSync(gone.copy), false, 'the deleted video’s copy is gone');
  assert.ok(fs.existsSync(kept.copy), 'the other video’s copy stays');
});
