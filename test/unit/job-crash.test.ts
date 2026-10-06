// A background job that takes the whole process down (out of memory, a crash in a native module) must not do it again
// on every start: the start-up warm-up used to queue the same diff again, a crash loop until someone removed the video
// (A13 MEDIA-1). The job's marker stays behind when the process dies; the next start counts it, and after
// CRASHES_ALLOWED such ends the job is not started again by itself. A graceful stop is no crash.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { age, FFMPEG, isolatedEnv, makeVideo, ROOT, slugOf } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv();
const store = await import('../../lib/store.ts');

// A video with two versions: every start warms its newest one, which queues the diff of V2 against V1.
const file = path.join(dir, 'proj/export/film.mp4');
makeVideo(file, { w: 160, h: 90, dur: 1 });
age(file);
store.createOrGetReview(file, { by: 'tester' });
makeVideo(file, { w: 160, h: 90, dur: 1, freq: 880, pattern: 'testsrc2' });
age(file);
const slug = slugOf(file);
assert.equal(store.sync(slug)?.review.versions.length, 2);

// ffmpeg as it behaves on a render that brings the server down: the diff's decode kills the process that started it
// (as the kernel's out-of-memory killer would); everything else is the real ffmpeg.
const standIn = path.join(dir, 'ffmpeg-crash');
fs.writeFileSync(
  standIn,
  `#!/bin/sh\nfor a in "$@"; do case "$a" in *gblur=sigma=0.8*) kill -9 $PPID; sleep 5; exit 1;; esac; done\nexec ${JSON.stringify(FFMPEG)} "$@"\n`,
  { mode: 0o755 },
);

// One start of the server, as far as the warm-up goes: every video warmed, then the queue run dry.
const start = `
const { createBackground } = await import(${JSON.stringify(path.join(ROOT, 'server/background.ts'))});
const store = await import(${JSON.stringify(path.join(ROOT, 'lib/store.ts'))});
const { queued } = await import(${JSON.stringify(path.join(ROOT, 'lib/jobs.ts'))});
const bg = createBackground(() => {}, { playable() {} });
for (const r of store.listReviews()) bg.warm(r);
while (queued()) await new Promise((r) => setTimeout(r, 20));
const review = store.loadReview(${JSON.stringify(slug)});
console.log(JSON.stringify(bg.startDiff(review, 2)));
`;
const run = () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', start], {
    env: { ...env, VR_FFMPEG: standIn },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { killed: r.signal === 'SIGKILL', out: r.stdout.trim(), err: r.stderr };
};

test('a job that killed the process is not started again on every start', { timeout: 600_000 }, () => {
  const starts = [run(), run(), run(), run()];
  const crashed = starts.map((s) => s.killed);
  assert.deepEqual(crashed.slice(0, 1), [true], 'the first start crashes on the diff, as the render makes it');
  assert.ok(crashed.filter(Boolean).length <= 2, `crashes on four starts: ${JSON.stringify(crashed)}`);
  const last = starts.at(-1) as (typeof starts)[number];
  assert.equal(last.killed, false, last.err);
  const answer = JSON.parse(last.out.split('\n').at(-1) as string);
  assert.equal(answer.none, true, last.out);
  assert.match(answer.error, /stopped the server/, 'whoever opens the comparison is told why there is none');
});

test('a job a graceful stop interrupts (SIGTERM, Ctrl-C) is no crash: it runs again on the next start', () => {
  // what server/index.ts's stop() does while a job runs, three times over
  const stopWhileRunning = `
const jobs = await import(${JSON.stringify(path.join(ROOT, 'lib/jobs.ts'))});
const guard = await import(${JSON.stringify(path.join(ROOT, 'lib/crashGuard.ts'))});
jobs.heavy(() => new Promise(() => {}), 2, { key: 'w1:analysis:abc' });
await new Promise((r) => setTimeout(r, 50));
guard.jobsInterrupted();
process.exit(0);
`;
  for (let i = 0; i < 3; i++) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', stopWhileRunning], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  const ask = `const g = await import(${JSON.stringify(path.join(ROOT, 'lib/crashGuard.ts'))}); console.log(g.crashedTooOften('w1:analysis:abc'));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', ask], { env, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), 'false', r.stderr);
});
