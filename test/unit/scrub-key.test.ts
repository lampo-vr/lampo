// One render, one scrub copy: the owner's player (playable) and a review link's preview (preview) name it by
// renderKey(ver), never by ver.hash alone (audit A12, INV-3). Keyed differently, every render that was both played and
// opened through a link was transcoded twice and stored twice (on Bunny/S3: uploaded twice).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { age, isolatedEnv, makeVideo, sleep } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const { renderKey } = await import('../../lib/renderKey.ts');
const { createPlayback } = await import('../../server/playback.ts');
const { queued } = await import('../../lib/jobs.ts');

test('the player and a review link share one scrub copy of a render', async () => {
  const file = makeVideo(path.join(dir, 'renders/spot.mp4'), { w: 160, h: 90, dur: 2, gop: 48 });
  age(file);
  const { review } = store.createOrGetReview(file, { by: 'tester' });
  const ver = review.versions.at(-1);
  assert.ok(ver);
  assert.notEqual(renderKey(ver), ver.hash, 'a render registered with a sample: its key is not its hash');
  const playback = createPlayback(() => {});
  assert.equal(playback.playable(review, ver, { build: true }).scrub, 'building');
  playback.preview(review, ver);
  const until = Date.now() + 60_000;
  while (queued() && Date.now() < until) await sleep(100);
  const scrubs = fs.readdirSync(path.join(dir, 'cache', 'scrub')).filter((f) => f.endsWith('.mp4'));
  assert.deepEqual(scrubs, [`${renderKey(ver)}.mp4`]);
  const p = playback.preview(review, ver);
  assert.equal(p.ready, true);
  assert.equal(p.main?.key, `scrub/${renderKey(ver)}.mp4`);
});
