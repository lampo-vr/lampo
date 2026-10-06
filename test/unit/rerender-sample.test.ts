// A re-render in a codec with a constant frame size (uncompressed, v210, DNxHD/HR) that changes only frames in the
// middle keeps the file's size, first and last MiB, so its `hash` stays the same. It is a new version all the same
// (the file on disk and an upload of it), its derived files (posters, proxies, transcripts, …) are its own, and the
// same bytes again are still not.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { age, FFMPEG, isolatedEnv, must } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const { slugify, reviewFile } = await import('../../lib/paths.ts');
const { quickHash } = await import('../../lib/probe.ts');
const { renderKey } = await import('../../lib/renderKey.ts');

/** 3 s of raw uyvy422 at 25 fps (115,200 bytes a frame, 8.6 MB); `flash` turns one frame white. */
function raw(file: string, flash?: number): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const vf = flash === undefined ? 'null' : `drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(n,${flash})'`;
  execFileSync(FFMPEG, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=25:duration=3',
    '-vf',
    vf,
    '-c:v',
    'rawvideo',
    '-pix_fmt',
    'uyvy422',
    '-y',
    file,
  ]);
  return file;
}
const first = raw(path.join(dir, 'renders/first.mov'));
const flashed = raw(path.join(dir, 'renders/flashed.mov'), 37);

/** Renders the file again over `to`, the way an editor does (new bytes, new mtime). */
function renderOver(from: string, to: string, secondsAgo: number): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  age(to, secondsAgo);
}

test('the two renders share size, head and tail: only a frame in the middle differs', () => {
  assert.equal(fs.statSync(first).size, fs.statSync(flashed).size);
  assert.equal(quickHash(first), quickHash(flashed));
  assert.notDeepEqual(fs.readFileSync(first), fs.readFileSync(flashed));
});

test('a file on disk: the re-render is v2, the same bytes again are not a v3', () => {
  const video = path.join(dir, 'project/export/spot.mov');
  renderOver(first, video, 120);
  const { review } = store.createOrGetReview(video, { by: 'tester' });
  const slug = slugify(review.video);
  const v1 = must(review.versions[0]);

  renderOver(flashed, video, 60);
  const res = must(store.sync(slug));
  assert.equal(res.review.versions.length, 2, 'the re-render is registered');
  const v2 = must(res.review.versions[1]);
  assert.ok(v1.sample && v2.sample, 'a new version carries its sample');
  assert.equal(v2.hash, v1.hash, '`hash` keeps its meaning');
  assert.notEqual(v2.sample, v1.sample);
  assert.notEqual(renderKey(v2), renderKey(v1), 'derived files are cached apart');
  assert.deepEqual(fs.readFileSync(must(store.versionFile(res.review, 2))), fs.readFileSync(flashed));
  assert.deepEqual(fs.readFileSync(must(store.versionFile(res.review, 1))), fs.readFileSync(first), 'v1 keeps its own bytes');

  renderOver(flashed, video, 30);
  const again = must(store.sync(slug));
  assert.equal(again.review.versions.length, 2, 'the same bytes again are no new version');
  assert.equal(again.review.versions[1]?.mtime, new Date(fs.statSync(video).mtimeMs).toISOString());
});

test('a version from before samples: its stored bytes are looked at instead', () => {
  const video = path.join(dir, 'project/export/older.mov');
  renderOver(first, video, 120);
  const { review } = store.createOrGetReview(video, { by: 'tester' });
  const slug = slugify(review.video);
  // As an older store wrote it.
  const json = JSON.parse(fs.readFileSync(reviewFile(slug), 'utf8'));
  delete json.versions[0].sample;
  fs.writeFileSync(reviewFile(slug), JSON.stringify(json));

  renderOver(first, video, 90);
  assert.equal(must(store.sync(slug)).review.versions.length, 1, 'touched, not re-rendered');
  const v1 = must(store.loadReview(slug)?.versions[0]);
  assert.equal(v1.sample, undefined, 'its key stays its hash (its cached files stay valid)');
  assert.equal(renderKey(v1), v1.hash);

  renderOver(flashed, video, 60);
  const res = must(store.sync(slug));
  assert.equal(res.review.versions.length, 2, 'the re-render is registered');
  assert.notEqual(renderKey(must(res.review.versions[1])), renderKey(v1));
});

test('uploads: the re-render is the next version, the same bytes again a duplicate', async () => {
  const copy = (from: string) => {
    const to = path.join(dir, 'incoming', `${Math.random().toString(36).slice(2)}.mov`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    return to;
  };
  const a = await store.ingestUpload(copy(first), { name: 'spot.mov', folder: 'Raw', by: 'olivia' });
  assert.equal(a.created, true);
  const b = await store.ingestUpload(copy(flashed), { name: 'spot.mov', folder: 'Raw', by: 'olivia' });
  assert.equal(b.duplicate, false, 'not a duplicate: a frame changed');
  assert.equal(b.version.v, 2);
  const c = await store.ingestUpload(copy(flashed), { name: 'spot.mov', folder: 'Raw', by: 'olivia' });
  assert.equal(c.duplicate, true);
  assert.equal(c.version.v, 2);

  // v2 from before samples: its stored bytes decide.
  const slug = slugify(b.review.video);
  const json = JSON.parse(fs.readFileSync(reviewFile(slug), 'utf8'));
  delete json.versions[1].sample;
  fs.writeFileSync(reviewFile(slug), JSON.stringify(json));
  assert.equal((await store.ingestUpload(copy(flashed), { name: 'spot.mov', folder: 'Raw', by: 'olivia' })).duplicate, true);
  const d = await store.ingestUpload(copy(first), { name: 'spot.mov', folder: 'Raw', by: 'olivia' });
  assert.equal(d.duplicate, false);
  assert.equal(d.version.v, 3);
});
