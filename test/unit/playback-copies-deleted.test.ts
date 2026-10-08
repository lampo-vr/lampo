// A deleted video takes its playback copies with it (server/playback.ts): the scrub copy (full size at CRF 14, in effect
// the video), the proxy of a codec browsers can't play and a phone's copy, from the bucket and from this server's
// working copies — whether a video without notes is deleted or the first run's sample is removed, in any workspace, and
// also when the video goes while its copy is still being made. A render another video still has keeps its copies: the
// same bytes put up twice share them (renderKey). The deleted video's own prefixes go from the bucket too (a draft's
// reference lives there). And a key removed from the bucket is no longer said to be stored.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { encodeOnce, isolatedEnv, makeVideo, until } from '../lib/helpers.ts';
import { mockBunny } from '../lib/mockStores.ts';

const bunny = await mockBunny();
const { dir } = isolatedEnv({
  vars: {
    VR_MODE: 'server',
    VR_PUBLIC_URL: 'http://review.test',
    VR_STORAGE: 'bunny',
    VR_BUNNY_ZONE: 'zone',
    VR_BUNNY_ACCESS_KEY: 'secret',
    VR_BUNNY_STORAGE_URL: bunny.url,
    VR_BUNNY_CDN_URL: 'https://cdn.review.test',
    VR_BUNNY_TOKEN_KEY: 'token-key',
  },
});
const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');
const { renderKey } = await import('../../lib/renderKey.ts');
const { queued } = await import('../../lib/jobs.ts');
const { rootStorage, setStorage, storage } = await import('../../lib/storage/index.ts');
const { createPlayback } = await import('../../server/playback.ts');
const { createSample } = await import('../../lib/sample.ts');
const auth = await import('../../lib/auth.ts');
const workspaces = await import('../../lib/workspaces.ts');
const { enterProcessWorkspace, inWorkspace } = await import('../../lib/scope.ts');

const drained = async () => {
  for (let i = 0; i < 1200 && queued() > 0; i++) await new Promise((r) => setTimeout(r, 50));
};
after(async () => {
  await drained();
  await bunny.close();
});

const pb = createPlayback(() => {});
type Version = Awaited<ReturnType<typeof store.ingestUpload>>['version'];
const copies = (ver: Version) => ['scrub', 'proxies', 'phone'].map((d) => `${d}/${renderKey(ver)}.mp4`);
const inBucket = (keys: string[]) => keys.filter((k) => bunny.objects.has(k));
/** Gone from the bucket, or why not (the keys still there). */
const goneFromBucket = (keys: string[]) =>
  until(
    () => !inBucket(keys).length,
    () => `still in the bucket: ${inBucket(keys).join(', ')}`,
  );

const bob = await auth.createUser({ email: 'bob@example.com', name: 'Bob', password: 'bobs long password', role: 'owner' });
// a second workspace: work outside one is refused from now on, so this file works in workspace #1 unless it says so
enterProcessWorkspace();
const B = workspaces.createWorkspace({ name: 'Bravo', ownerId: bob.id }).id;

async function upload(name: string, file: string, folder = 'Acme') {
  const { review, version } = await store.ingestUpload(file, { name, folder, by: 'tester', keep: true });
  return { review, version, slug: slugify(review.video) };
}

test('a deleted video’s copies go: the scrub copy, a phone’s copy, a proxy, from the bucket and the working copies', async () => {
  const big = await upload('big.mp4', makeVideo(path.join(dir, 'in/big.mp4'), { w: 1280, h: 720, dur: 1 }));
  const mov = path.join(dir, 'in/master.mov');
  encodeOnce(mov, [
    ...['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25:duration=1'],
    ...['-c:v', 'mpeg4', '-q:v', '5', '-pix_fmt', 'yuv420p'],
  ]);
  const odd = await upload('master.mov', mov);
  pb.playable(big.review, big.version, { build: true });
  pb.phone(big.review, big.version, true);
  pb.playable(odd.review, odd.version);
  await drained();
  const made = [`scrub/${renderKey(big.version)}.mp4`, `phone/${renderKey(big.version)}.mp4`, `proxies/${renderKey(odd.version)}.mp4`];
  assert.deepEqual(inBucket(made), made, 'the three copies were made and stored');
  // what else a video keeps under its own name in the bucket: a draft's reference, a fix preview
  const extra = path.join(dir, 'in/extra.bin');
  fs.writeFileSync(extra, 'bytes');
  const own = [store.refKey(big.slug, 'r_0123456789ab.jpg'), store.previewKey(big.slug, 'p_0123456789ab.jpg')];
  for (const key of own) await storage().put(key, extra, { keep: true });

  assert.ok(store.removeVideo(big.slug, 'tester'));
  assert.ok(store.removeVideo(odd.slug, 'tester'));
  await goneFromBucket([...made, ...own, `versions/${big.slug}/v1.mp4`, `versions/${odd.slug}/v1.mov`]);
  for (const key of made) {
    assert.equal(fs.existsSync(storage().localPath(key)), false, `no working copy of ${key}`);
    assert.equal(storage().has(key), false, `${key} is not said to be stored any more`);
  }
});

test('the same bytes in another video keep their copies until the last video with them goes', async () => {
  const file = makeVideo(path.join(dir, 'in/twice.mp4'), { w: 320, h: 180, dur: 1, freq: 600 });
  const a = await upload('twice.mp4', file, 'A');
  const b = await upload('twice.mp4', file, 'B');
  const archived = await upload('twice.mp4', file, 'C');
  assert.equal(renderKey(a.version), renderKey(b.version), 'one render, one key');
  store.addComment(archived.slug, { frame: 3, text: 'Keep this one', author: 'Mia' });
  pb.playable(a.review, a.version, { build: true });
  await drained();
  const [scrub] = copies(a.version) as [string];
  assert.ok(bunny.objects.has(scrub));
  store.removeVideo(b.slug, 'tester');
  await store.removalsSettled();
  assert.ok(bunny.objects.has(scrub), 'A still plays from it');
  store.removeVideo(a.slug, 'tester');
  // a video with notes is archived, not deleted: it can come back, and plays from the same copy
  assert.ok(store.removeVideo(archived.slug, 'tester')?.archived);
  await store.removalsSettled();
  assert.ok(bunny.objects.has(scrub), 'the archived video still has the render');
  store.unarchive(archived.slug);
  for (const c of store.loadReview(archived.slug)?.comments ?? []) store.deleteComment(c.id, 'Mia');
  store.removeVideo(archived.slug, 'tester');
  await goneFromBucket([scrub]);
});

test('a video deleted while its copy is being made: the copy goes as soon as it is stored', async () => {
  const late = await upload('late.mp4', makeVideo(path.join(dir, 'in/late.mp4'), { w: 320, h: 180, dur: 1, freq: 700 }));
  const [scrub] = copies(late.version) as [string];
  const base = rootStorage();
  let deleted = false;
  // the person deletes the video while its copy is encoded (most of a copy's time): the deletion has taken what was
  // there by the time the encoded file lands and is uploaded
  setStorage({
    ...base,
    async commit(key, contentType) {
      if (key === scrub && !deleted) {
        const encoded = fs.readFileSync(base.localPath(key));
        deleted = !!store.removeVideo(late.slug, 'tester');
        await store.removalsSettled();
        fs.mkdirSync(path.dirname(base.localPath(key)), { recursive: true });
        fs.writeFileSync(base.localPath(key), encoded);
      }
      return base.commit(key, contentType);
    },
  });
  try {
    pb.playable(late.review, late.version, { build: true });
    await drained();
  } finally {
    setStorage(base);
  }
  assert.ok(deleted, 'deleted while its copy was made');
  await goneFromBucket([scrub]);
  assert.equal(storage().has(scrub), false);
});

test('removing the first run’s sample takes its copies too', async () => {
  const review = await createSample({ by: 'Sam', byId: bob.id, lang: 'en' });
  const s = slugify(review.video);
  for (const ver of review.versions) {
    pb.preview(review, ver);
    pb.phone(review, ver, true);
  }
  await drained();
  const made = inBucket(review.versions.flatMap(copies));
  assert.ok(made.length >= review.versions.length, `its copies: ${made.join(', ')}`);
  store.removeSample(s);
  await goneFromBucket(made);
});

test('another workspace: its copies go under its own prefix, never the same render’s copy in workspace #1', async () => {
  const file = makeVideo(path.join(dir, 'in/both.mp4'), { w: 320, h: 180, dur: 1, freq: 800 });
  const here = await upload('both.mp4', file);
  const there = await inWorkspace(B, () => upload('both.mp4', file));
  pb.playable(here.review, here.version, { build: true });
  await inWorkspace(B, () => pb.playable(there.review, there.version, { build: true }));
  await drained();
  const [scrub] = copies(here.version) as [string];
  const theirs = `w/${B}/${scrub}`;
  assert.deepEqual(inBucket([scrub, theirs]), [scrub, theirs], 'one copy in each workspace');
  inWorkspace(B, () => store.removeVideo(there.slug, 'bob'));
  await goneFromBucket([theirs]);
  await store.removalsSettled();
  assert.ok(bunny.objects.has(scrub), 'workspace #1’s video still plays from its own');
});

test('a key removed from the bucket is no longer said to be stored, even with its working copy evicted before', async () => {
  const key = 'scrub/0123456789abcdef0123456789abcdef01234567.mp4';
  const file = path.join(dir, 'in/copy.bin');
  fs.writeFileSync(file, 'a copy');
  await storage().put(key, file, { keep: true });
  // the working copy evicted (pruneWorkCache): its marker alone says the bucket has it
  fs.rmSync(storage().localPath(key));
  assert.equal(storage().has(key), true);
  await storage().remove(key);
  assert.equal(bunny.objects.has(key), false);
  assert.equal(storage().has(key), false, 'nothing left that says it is stored');
});
