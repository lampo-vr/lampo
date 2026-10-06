// "Disable" by a workspace's admin on a server with workspaces (A12 INV-REV-2): it shuts the person out of that
// workspace — their sessions there, its tokens and apps — and nothing else. Whoever runs a workspace may be anyone, so
// a disable that reached the account would make an address dead server-wide: no reset, sign-up or other invite could
// bring it back. The account stays the person's; the admin who suspended them can let them in again.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';
import { client, type Reply, type Request } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_TRUST_PROXY: 'loopback' } });
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const { readOutbox } = await import('../../lib/mail/index.ts');
type User = import('../../lib/auth.ts').User;

const PW = 'a long password';
const ctx = createContext({ cfg: loadConfig(), token: 'unused' });
let server: http.Server;
let request: Request;
let n = 0;
const from = () => ({ Origin: PUBLIC, 'X-Forwarded-For': `198.51.100.${(n++ % 250) + 1}` });
const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
  request(method, url, { ...(body === undefined ? {} : { body }), headers: { ...from(), ...headers } });
const cookieOf = (r: Reply) => ({ Cookie: String([r.headers['set-cookie']].flat()[0]).split(';')[0] as string });
const signIn = async (email: string, password = PW) => {
  const r = await call('POST', '/api/auth/login', { email, password });
  assert.equal(r.status, 200, r.text);
  return cookieOf(r);
};
const kinds = async (address: string) => {
  await ctx.mail.flush();
  return readOutbox(path.join(dir, 'cache', 'outbox'))
    .filter((m) => m.to === address)
    .map((m) => m.kind);
};

let olivia: User;
let pat: User;
let bob: User;
let WA = '';
let WB = '';
let asOlivia: Record<string, string>;
before(async () => {
  server = http.createServer(createApp(ctx));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  request = client((server.address() as AddressInfo).port, { Connection: 'close', Host: 'review.test' });
  ctx.setup.token = null;
  olivia = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: PW, role: 'owner' });
  bob = await auth.createUser({ email: 'bob@other.example', name: 'Bob', password: PW, role: 'reviewer' });
  WA = ws.createWorkspace({ name: 'Acme', ownerId: olivia.id }).id;
  WB = ws.createWorkspace({ name: 'Other', ownerId: bob.id }).id;
  // Pat works in Acme only, and proved the address (it's theirs).
  pat = await auth.createUser({ email: 'pat@example.com', name: 'Pat', password: PW, role: 'reviewer' });
  ws.addMember(WA, pat.id, 'member');
  auth.confirmAddress(pat.id, pat.email);
  const s = await signIn('olivia@example.com');
  asOlivia = cookieOf(await call('POST', '/api/workspaces/switch', { id: WA }, s));
});
after(() => {
  ctx.mail.stop();
  server.close();
});

test('INV-REV-2: Acme’s owner disables Pat: out of Acme (sessions, tokens), the account still Pat’s', async () => {
  const { token } = auth.createToken(pat.id, 'agent', { workspace: WA });
  const off = await call('PATCH', `/api/admin/users/${pat.id}`, { disabled: true }, asOlivia);
  assert.equal(off.status, 200, off.text);
  assert.ok(off.json().user.disabled, 'Acme’s list shows Pat disabled');
  assert.equal(auth.getUser(pat.id)?.disabled, undefined, 'the account itself is not disabled');
  assert.equal(ws.roleIn(WA, pat.id), null, 'no role in Acme while suspended');
  assert.equal((await call('GET', '/api/library', undefined, { Authorization: `Bearer ${token}` })).status, 401, 'Acme’s token stopped');
  const list = (await call('GET', '/api/admin/users', undefined, asOlivia)).json().users as { id: string; disabled?: string }[];
  assert.ok(list.find((u) => u.id === pat.id)?.disabled, 'still listed in Acme, as disabled');
  // The address is Pat's: a reset reaches it, and another team's invite joins it with Pat's own password.
  await call('POST', '/api/auth/forgot', { email: 'pat@example.com' });
  assert.ok((await kinds('pat@example.com')).includes('reset'), 'a reset link reaches Pat');
  const inv = auth.createInvite({
    role: 'member',
    email: 'pat@example.com',
    workspace: WB,
    by: { id: bob.id, name: 'Bob' },
    isMember: (u) => !!ws.roleIn(WB, u.id),
  });
  const joined = await call('POST', '/api/auth/invite/accept', { token: inv.token, name: 'Pat', email: 'pat@example.com', password: PW });
  assert.equal(joined.status, 200, joined.text);
  assert.equal(ws.roleIn(WB, pat.id), 'member');
  assert.equal(ws.roleIn(WA, pat.id), null, 'and Acme stays shut');
  // Pat's sessions land in Other now; Acme isn't in the switcher.
  const s = await signIn('pat@example.com');
  const status = (await call('GET', '/api/auth/status', undefined, s)).json();
  assert.equal(status.workspace.id, WB);
  assert.deepEqual(
    status.workspaces.map((w: { id: string }) => w.id),
    [WB],
  );
  assert.equal((await call('POST', '/api/workspaces/switch', { id: WA }, s)).status, 404);
});

test('INV-REV-2: Acme lets Pat in again; Pat’s role there is as it was', async () => {
  const on = await call('PATCH', `/api/admin/users/${pat.id}`, { disabled: false }, asOlivia);
  assert.equal(on.status, 200, on.text);
  assert.equal(on.json().user.disabled, undefined);
  assert.equal(ws.roleIn(WA, pat.id), 'member');
});

test('INV-REV-2: Other’s owner can’t touch Pat’s Acme membership; nobody suspends themselves or the last owner', async () => {
  const asBob = cookieOf(await call('POST', '/api/workspaces/switch', { id: WB }, await signIn('bob@other.example')));
  // Bob suspends Pat in Other only
  assert.equal((await call('PATCH', `/api/admin/users/${pat.id}`, { disabled: true }, asBob)).status, 200);
  assert.equal(ws.roleIn(WB, pat.id), null);
  assert.equal(ws.roleIn(WA, pat.id), 'member', 'Acme isn’t Other’s business');
  assert.equal((await call('PATCH', `/api/admin/users/${olivia.id}`, { disabled: true }, asOlivia)).status, 400, 'not yourself');
  assert.equal((await call('PATCH', `/api/admin/users/${bob.id}`, { disabled: true }, asBob)).status, 400, 'not yourself (the last owner)');
});
