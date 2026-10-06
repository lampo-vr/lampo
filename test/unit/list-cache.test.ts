// listReviews() keeps parsed reviews while their file is unchanged. It must never serve a stale review: not after
// `vr` in another process rewrites one (atomic rename), not after an in-place edit of the same size, not after a
// write of our own, and not after a video's folder is gone. What it returns is shared, so it is read-only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { age, isolatedEnv, makeVideo } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const { reviewFile, reviewDir, slugify } = await import('../../lib/paths.ts');

const file = makeVideo(path.join(dir, 'proj/export/spot.mp4'), { dur: 1 });
age(file);
store.createOrGetReview(file, { by: 'tester' });
const slug = slugify(file);
const listed = () => {
  const r = store.listReviews().find((x) => x.video === path.resolve(file));
  assert.ok(r, 'listed');
  return r;
};

test('a rewrite by another process (atomic rename, like vr) shows at once', () => {
  assert.equal(listed().comments.length, 0);
  const raw = JSON.parse(fs.readFileSync(reviewFile(slug), 'utf8'));
  raw.comments.push({ id: 'c_abcdef', v: 1, frame: 2, text: 'from another process', author: 'agent:x', status: 'open', created: '2026-09-29T10:00:00+02:00' });
  const tmp = `${reviewFile(slug)}.other.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw));
  fs.renameSync(tmp, reviewFile(slug));
  assert.equal(listed().comments[0]?.text, 'from another process');
});

test('an in-place edit of the same size shows too (the mtime changed)', () => {
  const before = fs.readFileSync(reviewFile(slug), 'utf8');
  const after = before.replace('from another process', 'FROM ANOTHER PROCESS');
  assert.equal(after.length, before.length);
  listed();
  fs.writeFileSync(reviewFile(slug), after);
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(reviewFile(slug), t, t);
  assert.equal(listed().comments[0]?.text, 'FROM ANOTHER PROCESS');
});

test('our own writes show at once, and a listed review is read-only', () => {
  const r = listed();
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.comments) && Object.isFrozen(r.versions[0]), 'frozen all the way down');
  assert.throws(() => {
    (r.comments as unknown[]).push({});
  }, TypeError);
  store.addComment(slug, { frame: 3, text: 'Logo später', author: 'tester' });
  assert.equal(listed().comments.length, 2);
  const fresh = store.loadReview(slug);
  assert.ok(fresh && !Object.isFrozen(fresh), 'loadReview hands out its own copy to change');
});

test('a removed folder drops out', () => {
  fs.rmSync(reviewDir(slug), { recursive: true, force: true });
  assert.equal(store.listReviews().length, 0);
});
