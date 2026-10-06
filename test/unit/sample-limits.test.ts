// The first run's sample on a hosted server, asked for by whoever may upload (an agent's token too): making it copies
// two renders through storage and runs ffprobe and ffmpeg, removing it deletes them again. So a workspace makes and
// removes it a few times in ten minutes at most (429 with Retry-After), and never starts one past a full job queue
// (503): sweep 3 ONB-3.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: 'http://review.test', VR_STT: 'off' } });
const auth = await import('../../lib/auth.ts');
const jobs = await import('../../lib/jobs.ts');
const store = await import('../../lib/store.ts');

const { request } = await startApp({ headers: { Connection: 'close' } });

const max = await auth.createUser({ email: 'max@review.test', name: 'Max', password: 'a long enough password', role: 'member' });
const asMax = { Authorization: `Bearer ${auth.createToken(max.id, 'agent').token}` };
const samples = () => store.listReviews().filter((r) => r.onboarding_sample).length;
const make = () => request('POST', '/api/onboarding/sample', { body: {}, headers: asMax });
const remove = () => request('DELETE', '/api/onboarding/sample', { headers: asMax });

test('a workspace whose job queue is full starts no sample (503), and nothing is made', async () => {
  const kept = { ...jobs.QUEUE_LIMITS };
  Object.assign(jobs.QUEUE_LIMITS, { perWorkspace: 0, reserved: 0 });
  try {
    const r = await make();
    assert.equal(r.status, 503, r.text);
  } finally {
    Object.assign(jobs.QUEUE_LIMITS, kept);
  }
  assert.equal(samples(), 0);
});

test('made and removed in a loop: the workspace’s turns run out (429, Retry-After), what is there stays as it is', async () => {
  const seen: number[] = [];
  let refused = null as Awaited<ReturnType<typeof make>> | null;
  for (let i = 0; i < 8 && !refused; i++) {
    const a = await make();
    seen.push(a.status);
    if (a.status === 429) {
      refused = a;
      break;
    }
    assert.equal(a.status, 200, a.text);
    const b = await remove();
    seen.push(b.status);
    if (b.status === 429) refused = b;
  }
  assert.ok(refused, `a loop runs out: ${seen}`);
  assert.ok(seen.length <= 11, `within five turns or so: ${seen}`);
  assert.ok(Number(refused.headers['retry-after']) > 0, 'when to come back');
  // asking for the sample that is there costs nothing: it is handed back
  if (samples()) {
    const again = await make();
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json().created, false);
  }
});
