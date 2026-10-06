// covers: lib/auth.ts server/auth.ts
// invites.json is one file for the whole server, and every /api/auth/status read it (myWorkspaces → invitedInto): any
// workspace's admin could grow it without bound, 268 ms per create and 61 ms of blocked server per status at 40,000
// invites (A13 AUTH-1). Now an account makes at most 60 invites an hour, a workspace has at most 200 waiting, revoked
// and expired invites leave the file 30 days after they ended (accepted ones stay: they say who invited whom), and
// the file is parsed once until it changes. Revoked and expired ones count toward the 200 while the file keeps them,
// and an account revokes at most 60 an hour: making and revoking at once kept 43,000 per account (A13 VERIFY-3).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mock, test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';

// The clock moves by hours and days here: Date is a stand-in from before the app starts (its limits read it).
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-06T09:00:00Z') });
const HOUR = 3600_000;
const PUBLIC = 'http://review.test';
isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const { startApp } = await import('../lib/app.ts');
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const { request } = await startApp({ headers: { Host: 'review.test', Origin: PUBLIC } });

const olivia = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
const mallory = await auth.createUser({ email: 'mallory@example.com', name: 'Mallory', password: 'a long password', role: 'reviewer' });
const m = ws.createWorkspace({ name: 'Mallory Films', ownerId: mallory.id });
const asOlivia = () => ({ headers: { Cookie: `vr_session=${auth.signSession(olivia)}` } });
const asMallory = () => ({ headers: { Cookie: `vr_session=${auth.signSession(mallory, 30, m.id)}` } });
const invite = () => request('POST', '/api/admin/invites', { body: { role: 'reviewer' }, ...asMallory() });
const stored = () =>
  (JSON.parse(fs.readFileSync(auth.INVITES_FILE, 'utf8')) as { invites: { id: string; created: string; revoked?: string; accepted?: unknown }[] }).invites;

test('an account makes at most 60 invites an hour: the 61st is answered 429 with Retry-After', async () => {
  for (let i = 0; i < 60; i++) assert.equal((await invite()).status, 200);
  const more = await invite();
  assert.equal(more.status, 429, more.text);
  assert.ok(Number(more.headers['retry-after']) > 0);
  mock.timers.tick(HOUR);
  assert.equal((await invite()).status, 200, 'an hour later it may go on');
});

test('a workspace has at most 200 invites waiting or ended unused in 30 days: a revoked one makes no room', async () => {
  // 61 so far; a few more hours of the most an account may
  while (stored().length < 200) {
    mock.timers.tick(HOUR);
    for (let i = 0; i < 60 && stored().length < 200; i++) assert.equal((await invite()).status, 200);
  }
  mock.timers.tick(HOUR);
  const more = await invite();
  assert.equal(more.status, 429, more.text);
  assert.match(more.json().error, /200 invites/);
  // A13 VERIFY-3: a revoked invite stays in the file 30 days, so it counts as long (making and revoking at once was
  // 1,440 invites a day per account, 43,000 kept)
  const one = stored()[0]?.id as string;
  assert.equal((await request('DELETE', `/api/admin/invites/${one}`, asMallory())).status, 200);
  const after = await invite();
  assert.equal(after.status, 429, `a new invite after revoking one: ${after.status}`);
});

test('revoked and expired invites leave invites.json 30 days after they ended; accepted ones stay', async () => {
  const before = stored();
  assert.ok(before.length >= 200);
  // one accepted long ago: who invited whom stays known
  const kept = { ...before[1], id: 'i_acceptedlong', accepted: { at: before[1]?.created, user: olivia.id, name: 'Olivia' } };
  fs.writeFileSync(auth.INVITES_FILE, `${JSON.stringify({ invites: [...before, kept] }, null, 2)}\n`);
  // every invite here lasts 7 days: 38 days on, all have ended more than 30 days ago
  mock.timers.tick(38 * 24 * HOUR);
  assert.equal((await invite()).status, 200);
  const after = stored();
  assert.equal(after.length, 2, `${after.length} invites kept: the new one and the accepted one`);
  assert.ok(after.some((i) => i.id === 'i_acceptedlong'));
});

test('making and revoking at once stops at 200 a workspace in 30 days: the file stays small', async () => {
  // one is waiting since the test before
  let made = 0;
  let refused = 0;
  for (let h = 0; h < 4; h++) {
    mock.timers.tick(HOUR);
    for (let i = 0; i < 60; i++) {
      const r = await invite();
      if (r.status !== 200) {
        assert.equal(r.status, 429, r.text);
        refused++;
        continue;
      }
      made++;
      assert.equal((await request('DELETE', `/api/admin/invites/${r.json().invite.id}`, asMallory())).status, 200);
    }
  }
  assert.equal(made, 199, `${made} made and revoked in four hours (${refused} refused)`);
  assert.ok(stored().length <= 201, `${stored().length} invites kept`);
  // 30 days after they ended, they make room again
  mock.timers.tick(31 * 24 * HOUR);
  assert.equal((await invite()).status, 200);
});

test('an account revokes at most 60 invites an hour', async () => {
  // Olivia's own workspace: 61 invites over two hours
  const made: string[] = [];
  for (let i = 0; i < 61; i++) {
    if (i === 60) mock.timers.tick(HOUR);
    const r = await request('POST', '/api/admin/invites', { body: { role: 'reviewer' }, ...asOlivia() });
    assert.equal(r.status, 200, r.text);
    made.push(r.json().invite.id);
  }
  const codes: number[] = [];
  for (const id of made) codes.push((await request('DELETE', `/api/admin/invites/${id}`, asOlivia())).status);
  assert.deepEqual(codes.slice(0, 60), Array(60).fill(200));
  assert.equal(codes[60], 429, 'the 61st revoke in the hour');
  // what isn't there costs nothing and counts nothing
  mock.timers.tick(HOUR);
  assert.equal((await request('DELETE', '/api/admin/invites/i_000000000000', asOlivia())).status, 404);
  assert.equal((await request('DELETE', `/api/admin/invites/${made[60]}`, asOlivia())).status, 200, 'an hour later it may go on');
});

test('/api/auth/status reads invites.json once while it stays the same', async () => {
  const reads = mock.method(fs, 'readFileSync');
  try {
    for (let i = 0; i < 10; i++) assert.equal((await request('GET', '/api/auth/status', asOlivia())).json().user?.name, 'Olivia');
    const ofInvites = reads.mock.calls.filter((c) => String(c.arguments[0]) === auth.INVITES_FILE).length;
    assert.ok(ofInvites <= 1, `invites.json read ${ofInvites} times for 10 status calls`);
  } finally {
    reads.mock.restore();
  }
});
