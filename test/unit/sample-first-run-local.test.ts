// The machine's very first start (server/firstSample.ts): a store without videos gets its owner and, with the owner's
// first run, the sample in the library — made in the background, by the owner, once. A later start makes no second.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv({ config: { user: 'Sam Rivera' }, vars: { VR_ONBOARDING_SAMPLE: 'on' } });
const auth = await import('../../lib/auth.ts');
const store = await import('../../lib/store.ts');
const { findSample } = await import('../../lib/sample.ts');
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');

const { ctx, request } = await startApp();

test('the first start: the owner’s first run finds the sample in the library', async () => {
  await ctx.inflight.settled();
  const owner = auth.localOwner();
  assert.ok(owner?.prefs?.onboarding, 'the owner has a first run');
  const sample = findSample();
  assert.ok(sample, 'the sample is there');
  assert.equal(sample.onboarding_sample?.by_id, owner.id);
  const lib = (await request('GET', '/api/library')).json();
  assert.deepEqual(
    lib.videos.map((v: { sample?: boolean }) => !!v.sample),
    [true],
    'the library shows it, marked as the sample',
  );
});

test('a later start makes no second one', async () => {
  const again = createContext({ cfg: loadConfig(), token: 'unused' });
  await again.inflight.settled();
  assert.equal(store.listReviews().filter((r) => r.onboarding_sample).length, 1);
});
