// A graceful stop waits for uploads being registered and the heavy job that is running, starts no queued job, and
// gives up after its timeout. (Own file: draining the job queue is for the rest of the process.)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolatedEnv, sleep } from '../lib/helpers.ts';

isolatedEnv();
const { heavy } = await import('../../lib/jobs.ts');
const { createInFlight, drain } = await import('../../server/shutdown.ts');

test('drain waits for tracked work and the running job, and starts nothing queued', async () => {
  const done: string[] = [];
  const inflight = createInFlight();
  // The clock starts before the 80 ms upload does: measured from after it, any pause of a loaded machine in between
  // came off the wait and the check failed although drain had waited.
  const t = Date.now();
  inflight.track(sleep(80).then(() => done.push('upload registered')));
  heavy(() => sleep(60).then(() => done.push('running job')), 0);
  heavy(() => done.push('queued job'), 1);
  assert.equal(await drain(inflight, 5000), true);
  assert.ok(Date.now() - t >= 70, 'it waited');
  assert.deepEqual(done.sort(), ['running job', 'upload registered']);
  await sleep(30);
  assert.ok(!done.includes('queued job'), 'queued work is left for the next process');
});

test('drain gives up after its timeout, and a failed upload does not count as pending', async () => {
  const inflight = createInFlight();
  inflight.track(Promise.reject(new Error('not a video'))).catch(() => {});
  inflight.track(new Promise(() => {}));
  const t = Date.now();
  assert.equal(await drain(inflight, 60), false);
  // Returning at all is the timeout (one promise never settles); the bound is a backstop, loose enough for a busy machine.
  assert.ok(Date.now() - t < 4000);
  assert.equal(await drain(createInFlight(), 60), true, 'nothing to wait for');
});
