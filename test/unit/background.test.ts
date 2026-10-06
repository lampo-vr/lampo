// Jobs keyed by a render's bytes (server/background.ts): two videos can hold the same render (a copy tracked twice,
// the same export uploaded to two folders). The one that asks second joins the job the first started — and must hear
// its end too: the player waits for that event ("Checking this render…" stayed up for good before). An Auto-check
// that fails is remembered: every look at the player and every poll started it again, and "Checking…" never ended.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { isolatedEnv, makeVideo, must, sleep, until } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const { createBackground, sharedJobs } = await import('../../server/background.ts');
const { createPlayback } = await import('../../server/playback.ts');
const { slugify } = await import('../../lib/paths.ts');

test('sharedJobs: the first to ask starts the job, everyone who asked hears it, a finished job starts afresh', () => {
  const jobs = sharedJobs();
  assert.equal(jobs.join('h1', 'a', 1), true, 'the first starts it');
  assert.equal(jobs.join('h1', 'b', 2), false, 'the second joins');
  assert.equal(jobs.join('h1', 'a', 1), false, 'asking again changes nothing');
  assert.deepEqual(jobs.waiting('h1'), [
    { slug: 'a', v: 1 },
    { slug: 'b', v: 2 },
  ]);
  assert.equal(jobs.join('h2', 'c', 1), true, 'other bytes, another job');
  jobs.done('h1');
  assert.deepEqual(jobs.waiting('h1'), []);
  assert.equal(jobs.join('h1', 'b', 2), true, 'after it ended, a new request starts it again');
});

test('the Auto-check of a render two videos share announces its end to both', async () => {
  const file = makeVideo(path.join(dir, 'a/export/spot.mp4'), { w: 160, h: 90, fps: 25, dur: 1 });
  const copy = path.join(dir, 'b/export/spot-copy.mp4');
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.copyFileSync(file, copy);
  const one = store.createOrGetReview(file, { by: 'tester' }).review;
  const two = store.createOrGetReview(copy, { by: 'tester' }).review;
  assert.equal(must(one.versions[0]).hash, must(two.versions[0]).hash, 'the same bytes');
  const heard: { type: string; slug?: string; v?: number }[] = [];
  const broadcast = (type: string, data: { slug?: string; v?: number }) => heard.push({ type, slug: data.slug, v: data.v });
  const background = createBackground(
    broadcast as never,
    createPlayback(() => {}),
    { projectFiles: false },
  );
  assert.ok('pending' in background.startQa(one, 1), 'the first starts the check');
  assert.ok('pending' in background.startQa(two, 1), 'the second joins it');
  const done = (slug: string) => heard.some((e) => e.type === 'qa' && e.slug === slug && e.v === 1);
  const slugs = [one, two].map((r) => slugify(r.video));
  for (let t = Date.now(); Date.now() - t < 60_000 && !slugs.every(done); ) await sleep(100);
  assert.ok(done(slugs[0] as string), 'the first video hears the check end');
  assert.ok(done(slugs[1] as string), 'the second one too');
  assert.ok('qa' in background.startQa(two, 1), 'and finds the result');
});

test('a full queue: what someone asked for is refused with a clear answer, a warm-up passes it by, and asking again joins the job already waiting (D2)', async () => {
  const jobs = await import('../../lib/jobs.ts');
  // other bytes than the test above's (its Auto-check left an analysis for them)
  const file = makeVideo(path.join(dir, 'c/export/teaser.mp4'), { w: 160, h: 90, fps: 25, dur: 1, pattern: 'smptebars' });
  const review = store.createOrGetReview(file, { by: 'tester' }).review;
  const background = createBackground(
    (() => {}) as never,
    createPlayback(() => {}),
    { projectFiles: false },
  );
  let release = () => {};
  const held = new Promise<void>((started) =>
    jobs.heavy(
      () =>
        new Promise<void>((r) => {
          release = r;
          started();
        }),
      jobs.PRIORITY.scrub,
    ),
  );
  await held;
  try {
    // asking twice for the same analysis queues one job, not one per ask
    const before = jobs.queued();
    assert.equal(background.startAnalysis(review, 1), true);
    assert.equal(background.startAnalysis(review, 1), true);
    assert.equal(jobs.queued(), before + 1);
    jobs.QUEUE_LIMITS.perWorkspace = 1;
    for (const ask of [() => background.startQa(review, 1), () => background.startSprite(review), () => background.startCuts(review, 1)])
      assert.throws(ask, jobs.QueueFullError, 'refused in words (a 503 for the route), not "pending" forever');
    assert.doesNotThrow(() => background.warm(review), 'a warm-up passes a full queue by');
  } finally {
    jobs.QUEUE_LIMITS.perWorkspace = Number.POSITIVE_INFINITY;
    release();
  }
  // nothing was remembered as failed: asked again with room, the sprite starts
  assert.ok('pending' in background.startSprite(review) || 'sprite' in background.startSprite(review));
});

test('an Auto-check that fails is said, not started again on every ask; Run again tries once more', async (t) => {
  const file = makeVideo(path.join(dir, 'd/export/unreadable.mp4'), { w: 160, h: 90, fps: 25, dur: 1, pattern: 'rgbtestsrc' });
  const review = store.createOrGetReview(file, { by: 'tester' }).review;
  const slug = slugify(review.video);
  // the version's bytes as kept turn out unreadable: every ffmpeg run on them fails (a decode error, not a crash)
  const kept = store.snapshotPath(slug, 1, path.extname(file));
  fs.mkdirSync(path.dirname(kept), { recursive: true });
  fs.writeFileSync(kept, Buffer.alloc(64 * 1024, 7));
  const logged: string[] = [];
  t.mock.method(console, 'error', (...a: unknown[]) => logged.push(a.join(' ')));
  let ended = 0;
  const broadcast = (type: string, data: { slug?: string }) => {
    if (type === 'qa' && data.slug === slug) ended++;
  };
  const background = createBackground(
    broadcast as never,
    createPlayback(() => {}),
    { projectFiles: false },
  );
  assert.ok('pending' in background.startQa(review, 1), 'the first ask starts the check');
  await until(() => ended === 1, 'the player waiting on the check hears that it ended');
  const failed = background.startQa(review, 1) as { none?: true; failed?: true; error?: string };
  assert.ok(failed.none && failed.failed, `said as failed, not pending: ${JSON.stringify(failed)}`);
  assert.ok(failed.error && !/ffmpeg|exited|Invalid data/i.test(failed.error), `a sentence of ours, never ffmpeg's output: ${failed.error}`);
  assert.deepEqual(background.startQa(review, 1), failed, 'asking again starts nothing');
  assert.equal(logged.filter((l) => l.startsWith('qa')).length, 1, "the server's log has the details, once");
  // Run again: one more try, which fails the same way and is said again
  assert.ok('pending' in background.startQa(review, 1, [], true), 'Run again starts it once more');
  await until(() => ended === 2, 'its end is heard too');
  assert.ok('failed' in background.startQa(review, 1));
  assert.equal(logged.filter((l) => l.startsWith('qa')).length, 2);
});
