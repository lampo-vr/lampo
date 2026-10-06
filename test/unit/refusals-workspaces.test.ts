// Refusals on a store with workspaces no other test reached (audit A12, TEST-5), pinned as they are: a new name is
// refused when someone in any of the person's workspaces has it, and only then; an app allowed into a workspace its
// person has left is refused at /mcp even when leaving revoked nothing (a code redeemed after leaving).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { before, test } from 'node:test';
import type { User } from '../../lib/auth.ts';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';
import { cookieFrom } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const grants = await import('../../lib/oauth/store.ts');
const { request } = await startApp({ headers: { Host: 'review.test', Origin: PUBLIC } });

const PASSWORD = 'a long password';
const people: Record<string, User> = {};
let acme = '';
before(async () => {
  for (const name of ['Olivia', 'Mia', 'Rita'])
    people[name] = await auth.createUser({
      email: `${name.toLowerCase()}@example.com`,
      name,
      password: PASSWORD,
      role: name === 'Olivia' ? 'owner' : 'member',
    });
  // #1: Olivia, Mia, Rita. Acme: Olivia (its owner), Ben, Rita.
  acme = ws.createWorkspace({ name: 'Acme Films', ownerId: people.Olivia?.id as string }).id;
  people.Ben = await ws.createAccountIn(acme, { email: 'ben@example.com', name: 'Ben', password: PASSWORD, role: 'member' });
  ws.addMember(acme, people.Rita?.id as string, 'member');
  assert.ok(ws.isMigrated());
});

const signIn = async (email: string) => cookieFrom(await request('POST', '/api/auth/login', { body: { email, password: PASSWORD } }));
const rename = async (email: string, name: string) => request('PATCH', '/api/auth/me', { body: { name }, headers: { Cookie: await signIn(email) } });

test('a name someone in any of the person’s workspaces has is refused; a name only another team has is fine', async () => {
  const sameTeam = await rename('mia@example.com', 'OLIVIA');
  assert.deepEqual([sameTeam.status, sameTeam.json().error], [400, 'the name "OLIVIA" is taken']);
  // Olivia's session works in #1, but she works in Acme too, with Ben.
  const otherOfHers = await rename('olivia@example.com', 'ben');
  assert.deepEqual([otherOfHers.status, otherOfHers.json().error], [400, 'the name "ben" is taken']);
  // Mia never works with Ben: a store without workspaces would refuse this (names.test.ts), one with them doesn't.
  const elsewhere = await rename('mia@example.com', 'Ben');
  assert.equal(elsewhere.status, 200, elsewhere.text);
  assert.equal(elsewhere.json().user.name, 'Ben');
});

test('an app allowed into a workspace its person has left since is refused at /mcp, even when leaving revoked nothing', async () => {
  const rita = people.Rita as User;
  const verifier = crypto.randomBytes(32).toString('base64url');
  const redirect_uri = 'http://127.0.0.1:9/cb';
  const asked: Parameters<typeof grants.createCode>[0] = {
    id: 'req',
    client: { client_id: 'vrc_test', kind: 'dcr', name: 'Test app', host: null },
    redirect_uri,
    state: null,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    scopes: ['review:read'],
    resource: `${PUBLIC}/mcp`,
    expires: Date.now() + 60_000,
  };
  // Rita allows the app in Acme and in #1, then leaves Acme before it redeems its codes: leaving revokes the apps she
  // has there, and this one had no grant yet. Redeeming doesn't ask about workspaces; /mcp does.
  const inAcme = grants.createCode(asked, rita, acme);
  const inW1 = grants.createCode(asked, rita, 'w1');
  ws.removeMember(acme, rita.id);
  const redeem = (code: string) =>
    grants.redeemCode({ code, client_id: 'vrc_test', redirect_uri, code_verifier: verifier, resource: `${PUBLIC}/mcp` }).access_token;
  const mcp = (access: string) =>
    request('POST', '/mcp', {
      body: { jsonrpc: '2.0', id: 1, method: 'ping' },
      headers: { Authorization: `Bearer ${access}`, Accept: 'application/json, text/event-stream' },
    });
  const left = await mcp(redeem(inAcme));
  assert.equal(left.status, 401);
  assert.equal(left.json().error, 'this app was allowed into a workspace its person no longer works in: connect it again');
  assert.match(String(left.headers['www-authenticate']), /^Bearer realm="video-review", .*error="invalid_token"$/);
  assert.equal((await mcp(redeem(inW1))).status, 200, 'the app she allowed where she still works goes on');
});
