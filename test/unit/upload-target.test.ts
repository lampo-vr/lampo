// Which video an upload belongs to: the same name in the same folder is its next version; anything else is a video
// of its own — never, by an accident of its path, another video's next version (the id writes "/" as "__", videos
// move and get archived, macOS folders ignore case). Files on disk whose paths share an id are refused, not mixed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { age, isolatedEnv, makeVideo, must } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const folders = await import('../../lib/folders.ts');
const { reviewDir, slugify, VERSIONS } = await import('../../lib/paths.ts');

let n = 0;
/** A render with its own picture (so every upload is new bytes). */
function render(): string {
  const file = path.join(dir, 'incoming', `r${++n}.mp4`);
  const patterns = ['testsrc', 'testsrc2', 'smptebars', 'rgbtestsrc', 'yuvtestsrc', 'smptehdbars', 'pal75bars', 'pal100bars'];
  makeVideo(file, { w: 64, h: 36, dur: 0.5, pattern: patterns[n % patterns.length], freq: 200 + n * 40 });
  age(file);
  return file;
}
const upload = (name: string, folder: string) => store.ingestUpload(render(), { name, folder, keep: true, by: 'olivia' });
const versionsOf = (video: string) => must(store.loadReview(slugify(video))).versions.length;

test('the same name in the same folder is the next version', async () => {
  const a = await upload('spot.mp4', 'Same');
  const b = await upload('spot.mp4', 'Same');
  assert.equal(b.created, false);
  assert.equal(b.review.video, a.review.video);
  assert.equal(b.version.v, 2);
});

test('"__" in a name is not a "/": Acme/Promo__final.mp4 is not Acme/Promo/final.mp4', async () => {
  const a = await upload('final.mp4', 'Acme/Promo');
  const b = await upload('Promo__final.mp4', 'Acme');
  assert.equal(b.created, true, 'a video of its own');
  assert.notEqual(slugify(b.review.video), slugify(a.review.video));
  assert.equal(b.review.source?.name, 'Promo__final.mp4');
  assert.equal(b.review.folder, 'Acme');
  assert.equal(versionsOf(a.review.video), 1, 'the first video is untouched');
});

test('a video moved elsewhere, or archived, is not where a new upload of its name lands', async () => {
  const moved = await upload('promo.mp4', 'Client A');
  folders.moveVideo(slugify(moved.review.video), 'Client B');
  const again = await upload('promo.mp4', 'Client A');
  assert.equal(again.created, true, 'a new video in Client A');
  assert.equal(again.review.folder, 'Client A');
  assert.equal(versionsOf(moved.review.video), 1, 'the moved video (and Client B’s review link) got nothing');

  const old = await upload('teaser.mp4', 'Old');
  store.addComment(slugify(old.review.video), { frame: 1, text: 'keep me', author: 'olivia' });
  assert.ok(store.removeVideo(slugify(old.review.video))?.archived, 'archived (it has notes)');
  const fresh = await upload('teaser.mp4', 'Old');
  assert.equal(fresh.created, true, 'a new video you can see, not v2 of the archived one');
  assert.ok(!fresh.review.archived);
  assert.equal(versionsOf(old.review.video), 1);
});

test('a folder name with a backslash is refused before anything is stored', async () => {
  await assert.rejects(async () => upload('x.mp4', 'Q3\\Drafts'), /backslash/);
  const kept = fs.existsSync(VERSIONS) ? fs.readdirSync(VERSIONS).filter((d) => d.includes('\\')) : [];
  assert.deepEqual(kept, [], 'no orphaned bytes in versions/');
});

test('files on disk whose paths share an id are refused, not mixed up', () => {
  const a = makeVideo(path.join(dir, 'work/a/b.mp4'), { w: 64, h: 36, dur: 0.5 });
  const b = makeVideo(path.join(dir, 'work/a__b.mp4'), { w: 64, h: 36, dur: 0.5, pattern: 'smptebars' });
  age(a);
  age(b);
  assert.equal(store.createOrGetReview(a).created, true);
  assert.throws(() => store.createOrGetReview(b), /share one id/);
  assert.equal(must(store.loadReview(slugify(a))).video, path.resolve(a));
});

test('a version’s bytes go into versions/ only under the video’s lock: never over one another writer registers meanwhile', async () => {
  const first = await upload('race.mp4', 'Locks');
  const slug = slugify(first.review.video);
  const v2 = path.join(VERSIONS, slug, 'v2.mp4');
  // another process holds the video's lock (the watcher registering a re-render as V2, say): it is alive and its lock is fresh
  const lock = path.join(reviewDir(slug), '.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner'), `${process.ppid}@${(await import('node:os')).hostname()}`);
  try {
    await assert.rejects(
      async () => upload('race.mp4', 'Locks'),
      (e: Error & { status?: number }) => e.status === 503,
    );
    assert.equal(fs.existsSync(v2), false, 'nothing written at V2 while the lock was someone else’s');
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
  const second = await upload('race.mp4', 'Locks');
  assert.equal(second.version.v, 2);
  assert.ok(fs.existsSync(v2), 'stored once the lock was this upload’s');
});
