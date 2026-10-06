// Carrying an approval over is only for the render the version diff compared: a newer one that arrived while the diff
// ran was never looked at, so it doesn't get "approved, identical to v1".
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { age, isolatedEnv, makeVideo, must } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');

const file = path.join(dir, 'proj/export/spot.mp4');
const render = (pattern: string, ago: number) => {
  makeVideo(file, { w: 64, h: 36, dur: 0.5, pattern });
  age(file, ago);
};

test('an approval carries over to the render that was compared, and never to one that arrived since', () => {
  render('testsrc', 90);
  store.createOrGetReview(file, { by: 'tester' });
  const slug = slugify(file);
  store.setApproval(slug, { status: 'approved', v: 1 }, 'tester', { party: 'team' });
  render('testsrc2', 60);
  store.sync(slug);
  // The route compared v1 with v2 (identical, say); meanwhile the agent rendered v3.
  render('smptebars', 30);
  store.sync(slug);
  assert.deepEqual(
    must(store.loadReview(slug)).versions.map((v) => v.v),
    [1, 2, 3],
  );
  const verdicts = () => must(store.loadReview(slug)).approvals?.length ?? 0;
  const before = verdicts();
  assert.throws(
    () => store.carryApproval(slug, 1, 'tester', 2),
    (e: Error & { status?: number }) => e.status === 409 && /v3 arrived/.test(e.message),
  );
  assert.equal(verdicts(), before, 'nothing recorded');
  const carried = store.carryApproval(slug, 1, 'tester', 3);
  assert.equal(carried?.v, 3);
});
