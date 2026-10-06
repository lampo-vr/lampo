// The first run's sample, asked for at once by several clicks or tabs, and removed while it warms up (sweep 3 ONB-4):
// one making, and only the request that started it says `created: true`, warms it up and tells the library; the
// others get the same sample with `created: false`. Removed while its warm-up runs, the warm-up stops quietly: no
// "proxy failed", no "the bytes … are gone" in the log for a video nobody has any more.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, until } from '../lib/helpers.ts';

isolatedEnv({ config: { user: 'Sam Rivera' }, vars: { VR_STT: 'off' } });
const store = await import('../../lib/store.ts');
const jobs = await import('../../lib/jobs.ts');

const { ctx, request } = await startApp();

const samples = () => store.listReviews().filter((r) => r.onboarding_sample).length;
const make = () => request('POST', '/api/onboarding/sample', { body: {} });

test('three asks at once: one sample, made once, warmed up and told once; one of them says it made it', async () => {
  const warmed: string[] = [];
  const told: string[] = [];
  const { warm } = ctx.background;
  const { broadcast } = ctx;
  ctx.background.warm = (review) => {
    warmed.push(review.video);
    warm(review);
  };
  ctx.broadcast = ((type: string, data: unknown) => {
    if (type === 'library') told.push(JSON.stringify(data));
    return broadcast(type as never, data as never);
  }) as typeof ctx.broadcast;
  try {
    const answers = await Promise.all([make(), make(), make()]);
    for (const a of answers) assert.equal(a.status, 200, a.text);
    const slugs = new Set(answers.map((a) => a.json().slug));
    assert.equal(slugs.size, 1, 'the same sample for all three');
    assert.deepEqual(answers.map((a) => a.json().created).sort(), [false, false, true], 'one made it');
    assert.equal(samples(), 1);
    assert.equal(warmed.length, 1, `warmed up once: ${warmed}`);
    assert.equal(told.length, 1, `the library told once: ${told}`);
  } finally {
    ctx.background.warm = warm;
    ctx.broadcast = broadcast;
  }
  await until(() => jobs.queued() === 0, 'its warm-up done');
});

test('removed while its warm-up runs: the warm-up stops quietly', async () => {
  const removed = await request('DELETE', '/api/onboarding/sample');
  assert.equal(removed.status, 200, removed.text);
  await until(() => jobs.queued() === 0, 'nothing waiting');
  const logged: string[] = [];
  const error = console.error;
  console.error = (...a: unknown[]) => {
    logged.push(a.map(String).join(' '));
  };
  try {
    const made = await make();
    assert.equal(made.status, 200, made.text);
    assert.equal(made.json().created, true);
    // the warm-up is queued (a poster, the analysis, the diff of V2 against V1, a scrub copy): the sample goes now
    const gone = await request('DELETE', '/api/onboarding/sample');
    assert.equal(gone.status, 200, gone.text);
    await until(() => jobs.queued() === 0, 'the warm-up over');
  } finally {
    console.error = error;
  }
  assert.equal(samples(), 0);
  const noise = logged.filter((l) => /proxy failed|are gone|No such file|ENOENT/.test(l));
  assert.deepEqual(noise, [], 'nothing said about a video nobody has any more');
});
