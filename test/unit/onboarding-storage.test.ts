// The first run's sample on a hosted server whose renders live in an S3 bucket: made through the storage adapter like
// any upload (both versions in the bucket, the notes' screenshots made from a working copy), and removed from the
// bucket too — nothing of a removed sample stays behind, here or there; and removing a sample never removes a video.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { mockS3 } from '../lib/mockStores.ts';

const s3 = await mockS3();
const { dir } = isolatedEnv({
  vars: {
    VR_MODE: 'server',
    VR_STORAGE: 's3',
    VR_S3_ENDPOINT: s3.url,
    VR_S3_BUCKET: 'bucket',
    VR_S3_ACCESS_KEY_ID: 'AKTEST',
    VR_S3_SECRET_ACCESS_KEY: 'shh',
    VR_S3_REGION: 'auto',
  },
});
const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');
const { createSample, findSample } = await import('../../lib/sample.ts');
after(() => s3.close());

const keysOf = (slug: string) => [...s3.objects.keys()].filter((k) => k.includes(slug)).sort();

test('made through the storage adapter: both versions in the bucket, notes with screenshots', async () => {
  const review = await createSample({ by: 'Sam', byId: 'u_000000000001', lang: 'en' });
  const s = slugify(review.video);
  assert.deepEqual(keysOf(s), [`versions/${s}/v1.mp4`, `versions/${s}/v2.mp4`]);
  assert.deepEqual(
    review.versions.map((v) => v.stored),
    ['s3', 's3'],
  );
  for (const c of review.comments) assert.ok(c.shots?.clean && fs.existsSync(path.join(dir, 'data', s, c.shots.clean)), `${c.id} has its frame`);
  assert.equal(findSample()?.video, review.video);
  assert.equal((await createSample({ by: 'Mia' })).video, review.video, 'one sample per store');
});

test('removed for good: the review here and its renders in the bucket', async () => {
  const sample = findSample();
  assert.ok(sample);
  const s = slugify(sample.video);
  store.removeSample(s);
  assert.equal(store.loadReview(s), null);
  for (let i = 0; i < 100 && keysOf(s).length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(keysOf(s), [], 'nothing left in the bucket');
  assert.equal(findSample(), undefined);
});

test('removing a sample never removes a video that isn’t one', async () => {
  const file = makeVideo(path.join(dir, 'in/spot.mp4'), { dur: 1 });
  const { review } = await store.ingestUpload(file, { name: 'spot.mp4', folder: 'Acme', by: 'Sam' });
  const s = slugify(review.video);
  assert.throws(() => store.removeSample(s), /not a sample/);
  assert.ok(store.loadReview(s), 'still there');
  assert.deepEqual(keysOf(s), [`versions/${s}/v1.mp4`]);
});
