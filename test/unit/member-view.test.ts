// A13 PEOPLE-3: what a workspace's admins read about their members is who they are there (memberView), never what the
// account keeps for itself — its prefs (other workspaces' ids and dates, first runs, a sign-up's plan) or a new address
// waiting for its link. Carol works in A (w1) and in Bob's workspace B; in A she puts a conversion moment away and starts
// moving to a new address. Bob, admin of B, lists B's members (with his session and his token) and changes her role
// there: none of it shows. Carol herself still reads all of it in /api/auth/me.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';
import { cookieFrom } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_ALLOW_HTTP: '1' } });
const { ctx, request } = await startApp({ headers: { Host: 'review.test' } });
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const PASSWORD = 'a long password';
const origin = { Origin: PUBLIC };

await auth.createUser({ email: 'alice@example.com', name: 'Alice', password: PASSWORD, role: 'owner' });
const carol = await auth.createUser({ email: 'carol@example.com', name: 'Carol', password: PASSWORD, role: 'member' });
const bob = await auth.createUser({ email: 'bob@example.com', name: 'Bob', password: PASSWORD, role: 'reviewer' });
const B = ws.createWorkspace({ name: 'Bravo', ownerId: bob.id }).id;
ws.addMember(B, carol.id, 'reviewer');
ws.removeMember('w1', bob.id);
const login = async (email: string, w?: string) => {
  const r = await request('POST', '/api/auth/login', { body: { email, password: PASSWORD }, headers: origin });
  let c = cookieFrom(r);
  if (w) c = cookieFrom(await request('POST', '/api/workspaces/switch', { body: { id: w }, headers: { Cookie: c, ...origin } }));
  return { Cookie: c, ...origin };
};
const carolA = await login('carol@example.com', 'w1');
assert.equal((await request('PUT', '/api/moments/banner', { body: { until: new Date(Date.now() + 5 * 86400e3).toISOString() }, headers: carolA })).status, 200);
const moving = await request('PATCH', '/api/auth/me', { body: { email: 'carol.private@newjob.example', current_password: PASSWORD }, headers: carolA });
assert.equal(moving.status, 200, moving.text);
assert.equal(auth.getUser(carol.id)?.pending_email, 'carol.private@newjob.example');
const bobB = await login('bob@example.com');
const token = (await request('POST', '/api/auth/tokens', { body: { name: 'bob agent' }, headers: bobB })).json().token as string;

const PRIVATE = /carol\.private@newjob\.example|"prefs"|"moments"|"pending_email"|"onboarding"|w1/;

test('an admin’s member list (session or token) shows who Carol is in B, nothing her account keeps for itself', async () => {
  for (const [who, h] of [
    ['Bob (session)', bobB],
    ['Bob (API token)', { Authorization: `Bearer ${token}` }],
  ] as const) {
    const r = await request('GET', '/api/admin/users', { headers: h });
    assert.equal(r.status, 200, r.text);
    const c = (r.json().users as Record<string, unknown>[]).find((u) => u.id === carol.id);
    assert.ok(c, `${who} sees Carol`);
    assert.deepEqual(Object.keys(c).sort(), ['apps', 'created', 'email', 'id', 'name', 'role', 'tokens'].sort(), `${who}: ${JSON.stringify(c)}`);
    assert.equal(c.role, 'reviewer', 'her role in B');
    assert.equal(c.email, 'carol@example.com');
    assert.doesNotMatch(JSON.stringify(c), PRIVATE, who);
  }
});

test('changing her role answers with the same view; Bob changing his own still gets his own record', async () => {
  const r = await request('PATCH', `/api/admin/users/${carol.id}`, { body: { role: 'member' }, headers: bobB });
  assert.equal(r.status, 200, r.text);
  assert.doesNotMatch(JSON.stringify(r.json().user), PRIVATE);
  assert.equal(r.json().user.role, 'member');
  const me = await request('PATCH', `/api/admin/users/${bob.id}`, { body: { name: 'Bob Lane' }, headers: bobB });
  assert.equal(me.status, 200, me.text);
  assert.equal(me.json().user.has_password, true, 'yourself: your own record');
});

test('Carol herself still reads all of it', async () => {
  const me = (await request('GET', '/api/auth/me', { headers: carolA })).json().user;
  assert.equal(me.pending_email, 'carol.private@newjob.example');
  assert.ok(me.prefs?.moments?.w1, 'her own moments');
  ctx.mail.stop();
});
