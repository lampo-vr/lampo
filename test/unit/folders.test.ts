import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { age, isolatedEnv, makeVideo, must, tmpdir } from '../lib/helpers.ts';

// browse_root = the temp dir, so project paths below it read like ~/Development/… ones. Home is a temp dir of its own:
// the machine's may hold the temp dir (a CI runner's TMPDIR lives under its home), and "outside home" below must be.
const base = tmpdir();
const { dir } = isolatedEnv({ config: { browse_root: base }, vars: { HOME: tmpdir('vr-home-') } });
const store = await import('../../lib/store.ts');
const folders = await import('../../lib/folders.ts');
const { slugify, DEV } = await import('../../lib/paths.ts');

const review = (slug: string) => must(store.loadReview(slug), slug);
const clip = (rel: string) => {
  const f = makeVideo(path.join(base, rel), { dur: 0.4, w: 64, h: 36, audio: false });
  age(f);
  store.createOrGetReview(f, { by: 'tester' });
  return slugify(f);
};
const a = clip('ACME/REELS/spring-sale/export/ad_9x16.mp4');
const b = clip('ACME/REELS/spring-sale/export/ad_4x5.mp4');
const z = clip('Globex/launch-film/remotion/out/film.mp4');
const deep = clip('ACME/REELS/inside-acme/ep02_budget/export/ep02.mp4');

test('browse_root from config.json drives project names', () => {
  assert.equal(DEV, base);
  assert.equal(review(a).project, 'ACME/REELS/spring-sale');
});

test('normFolder trims, collapses and drops empty segments', () => {
  assert.equal(folders.normFolder(' ACME / /  Reels  Ads '), 'ACME/Reels Ads');
  assert.equal(folders.normFolder(''), null);
  assert.equal(folders.normFolder(null), null);
  assert.equal(must(folders.normFolder('x'.repeat(80))).length, 60);
});

test('suggestFolder: project path without generic render folders, max three levels', () => {
  const s = (slug: string) => folders.suggestFolder(review(slug).video);
  assert.equal(s(a).folder, 'ACME/REELS/spring-sale');
  assert.equal(s(z).folder, 'Globex/launch-film', 'remotion/out are stripped');
  assert.equal(s(deep).folder, 'ACME/REELS/inside-acme', 'capped at three levels');
  const outside = makeVideo(path.join(tmpdir(), 'somewhere/export/x.mp4'), { dur: 0.3, w: 32, h: 18, audio: false });
  assert.equal(folders.suggestFolder(outside).folder, 'somewhere', 'outside browse_root/home: just the folder name');
});

// Outside home, generic render folders are stripped before the last name is taken (not "final").
test('suggestFolder outside home skips generic render folders', () => {
  const outside = makeVideo(path.join(tmpdir(), 'somewhere/renders/final/x.mp4'), { dur: 0.3, w: 32, h: 18, audio: false });
  assert.equal(folders.suggestFolder(outside).folder, 'somewhere');
});

test('moveVideo files a video (creating parents) and suggestFolder then follows its siblings', () => {
  const r = folders.moveVideo(a, 'ACME/Spring Sale Ads', 'tester');
  assert.equal(r.folder, 'ACME/Spring Sale Ads');
  assert.deepEqual(folders.allFolders(), ['ACME', 'ACME/Spring Sale Ads']);
  const s = folders.suggestFolder(review(b).video);
  assert.deepEqual(s, { folder: 'ACME/Spring Sale Ads', reason: 'where its sibling renders are', exists: true });
  assert.equal(store.readEvents().at(-1)?.type, 'moved');
  assert.ok(!fs.readFileSync(store.INBOX_FILE, 'utf8').includes('MOVED'), 'filing is not inbox news');
});

test('createFolder keeps empty folders', () => {
  folders.createFolder('Globex/Launch/Drafts');
  assert.ok(folders.allFolders().includes('Globex/Launch/Drafts'));
  assert.ok(folders.allFolders().includes('Globex'));
});

test('renameFolder moves the subtree and every video in it', () => {
  folders.moveVideo(b, 'ACME/Spring Sale Ads/4x5', 'tester');
  folders.renameFolder('ACME/Spring Sale Ads', 'ACME/Spring Sale', 'tester');
  assert.equal(review(a).folder, 'ACME/Spring Sale');
  assert.equal(review(b).folder, 'ACME/Spring Sale/4x5');
  assert.ok(!folders.allFolders().some((f) => f.startsWith('ACME/Spring Sale Ads')));
  assert.throws(() => folders.renameFolder('ACME', 'ACME/inner'), /into itself/);
  assert.throws(() => folders.renameFolder('ACME/Spring Sale', 'Globex'), /already exists/);
});

test('deleteFolder lifts videos and subfolders one level up, nothing is lost', () => {
  const parent = folders.deleteFolder('ACME/Spring Sale', 'tester');
  assert.equal(parent, 'ACME');
  assert.equal(review(a).folder, 'ACME');
  assert.equal(review(b).folder, 'ACME/4x5');
  folders.deleteFolder('ACME', 'tester');
  assert.equal(review(a).folder, null, 'top-level delete → Unsorted');
  assert.equal(review(b).folder, '4x5');
  assert.equal(store.listReviews().length, 4);
});

test('moveVideo(null) returns a video to Unsorted', () => {
  folders.moveVideo(z, 'Globex', 'tester');
  assert.equal(folders.moveVideo(z, null, 'tester').folder, null);
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'folders.json'), 'utf8'));
  assert.ok(Array.isArray(json.folders));
});
