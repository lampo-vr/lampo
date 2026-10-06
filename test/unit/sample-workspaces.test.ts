// The first run's sample on a server with workspaces (A12 WS-8): each workspace asking gets its own, even when two ask
// within the seconds it takes to make one — a second click in the same workspace still waits for the first.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: 'http://review.test' } });
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const scope = await import('../../lib/scope.ts');
const { createSample, findSample } = await import('../../lib/sample.ts');

const alma = await auth.createUser({ email: 'alma@example.com', name: 'Alma', password: 'almas password', role: 'owner' });
const bo = await auth.createUser({ email: 'bo@example.com', name: 'Bo', password: 'bos password 1', role: 'reviewer' });
const B = ws.createWorkspace({ name: 'Bravo', ownerId: bo.id }).id;

test('WS-8: two workspaces asking for the sample at once get one each; one workspace asking twice gets one', async () => {
  const [a1, b1, a2] = await Promise.all([
    scope.inWorkspace('w1', () => createSample({ by: 'Alma', byId: alma.id })),
    scope.inWorkspace(B, () => createSample({ by: 'Bo', byId: bo.id })),
    scope.inWorkspace('w1', () => createSample({ by: 'Alma', byId: alma.id })),
  ]);
  assert.equal(a1, a2, 'a second click in the same workspace waits for the first');
  assert.notEqual(a1, b1);
  assert.equal(
    scope.inWorkspace('w1', () => findSample()?.onboarding_sample?.by),
    'Alma',
  );
  assert.equal(
    scope.inWorkspace(B, () => findSample()?.onboarding_sample?.by),
    'Bo',
    'B has a sample of its own',
  );
});
