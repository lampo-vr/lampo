// Invites on a server with workspaces prove no inbox (audit A12 verification: VA-1, the core of WS-3): whoever made an
// invite holds its link as much as the person it went to, and anyone may run a workspace. So taking an invite never
// makes a confirmed account, never takes a held sign-up's address, answers the same for every address, and the
// invite's workspace and role wait for the address to be confirmed from its inbox; once a person proved their address,
// no workspace admin sets their password. The attacks from the verification, end to end over HTTP, on a hosted server
// open to sign-ups (the Cloud path). Every message goes to the log transport's outbox.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';
import { client, type Reply, type Request } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
// Anyone may run a workspace here (VR_WORKSPACE_CREATE=anyone): the server this is about.
const { dir } = isolatedEnv({
  vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_SIGNUP: 'open', VR_TRUST_PROXY: 'loopback', VR_WORKSPACE_CREATE: 'anyone' },
});
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const auth = await import('../../lib/auth.ts');
type User = import('../../lib/auth.ts').User;
const ws = await import('../../lib/workspaces.ts');
const { readOutbox } = await import('../../lib/mail/index.ts');

const ctx = createContext({ cfg: loadConfig(), token: 'unused' });
let server: http.Server;
let request: Request;
before(async () => {
  server = http.createServer(createApp(ctx));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  request = client((server.address() as AddressInfo).port, { Connection: 'close', Host: 'review.test' });
});
after(() => {
  ctx.mail.stop();
  server.closeAllConnections();
  server.close();
});

const OUTBOX = path.join(dir, 'cache', 'outbox');
let n = 0;
/** Each request from an address of its own (behind the loopback proxy): the per-address limits aren't what's tested. */
const h = (extra: Record<string, string> = {}) => ({ Origin: PUBLIC, 'X-Forwarded-For': `198.51.100.${(n++ % 250) + 1}`, ...extra });
const cookies = (r: Reply) =>
  [r.headers['set-cookie']]
    .flat()
    .filter(Boolean)
    .map((c) => String(c).split(';')[0]);
const session = (r: Reply) => ({
  Cookie: cookies(r)
    .filter((c) => c.startsWith('vr_session='))
    .join('; '),
});
const mark = (r: Reply) => ({
  Cookie: cookies(r)
    .filter((c) => c.startsWith('vr_signup='))
    .join('; '),
});
const post = (url: string, body: unknown, headers: Record<string, string> = {}) => request('POST', url, { body, headers: h(headers) });
async function mailTo(address: string) {
  await ctx.mail.flush();
  return readOutbox(OUTBOX).filter((m) => m.to === address);
}
const linkIn = (text: string, kind: 'vt' | 'rt') => new RegExp(`#/(?:verify|reset)/(${kind}_[\\w-]+)`).exec(text)?.[1] as string;
const lastLink = async (address: string, kind: 'verify' | 'reset') =>
  linkIn((await mailTo(address)).filter((m) => m.kind === kind).at(-1)?.text ?? '', kind === 'verify' ? 'vt' : 'rt');
const tokenOf = (r: Reply) => String(r.json().url).split('/#/invite/')[1] as string;
const PW = 'a long password';

let mallory: Record<string, string>;
let malloryWs = '';
before(async () => {
  await auth.createUser({ email: 'owner@agency.example', name: 'Agency Owner', password: PW, role: 'owner' });
  ctx.setup.token = null;
  await auth.createUser({ email: 'ceo@client.example', name: 'Client CEO', password: PW, role: 'member' });
  await auth.createUser({ email: 'mallory@example.com', name: 'Mallory', password: PW, role: 'reviewer' });
  // Mallory runs a workspace of her own (anyone may here, VR_WORKSPACE_CREATE=anyone).
  const signedIn = await post('/api/auth/login', { email: 'mallory@example.com', password: PW });
  const made = await post('/api/workspaces', { name: 'Side project' }, session(signedIn));
  assert.equal(made.status, 200, made.text);
  mallory = session(made);
  malloryWs = made.json().workspace.id;
});

test('VA-1: an invite link takes no held sign-up’s address; the sign-up’s own link still confirms it', async () => {
  // Vera signs up and hasn't opened her link yet.
  const signup = await post('/api/auth/signup', { name: 'Vera Victim', email: 'vera@client.example', password: 'veras own password' });
  assert.equal(signup.status, 200, signup.text);
  const vera = auth.findUserByEmail('vera@client.example') as User;
  assert.ok(auth.isGated(vera));
  // Mallory makes an invite that names no address and takes it as vera@.
  const inv = await post('/api/admin/invites', { role: 'member' }, mallory);
  assert.equal(inv.status, 200, inv.text);
  const taken = await post('/api/auth/invite/accept', { token: tokenOf(inv), name: 'Not Vera', email: 'vera@client.example', password: 'mallory knows this' });
  assert.deepEqual([taken.status, taken.json()], [200, { held: true }], 'answered like any address');
  assert.deepEqual(
    cookies(taken).map((c) => c.split('=')[0]),
    ['vr_signup'],
    'nobody signed in',
  );
  const after = auth.findUserByEmail('vera@client.example') as User;
  assert.deepEqual([after.id, after.name, after.password, auth.isGated(after)], [vera.id, 'Vera Victim', vera.password, true], 'Vera’s sign-up, as it was');
  assert.equal(ws.roleIn(malloryWs, vera.id), null);
  assert.equal((await post('/api/auth/login', { email: 'vera@client.example', password: 'mallory knows this' })).status, 401);
  assert.equal((await post('/api/auth/token', { email: 'vera@client.example', password: 'mallory knows this' })).status, 401);
  assert.equal((await post('/api/auth/invite/peek', { token: tokenOf(inv) })).status, 200, 'the invite is still pending');
  // Vera's own password and her own link work: she is in, in a workspace of her own, never Mallory's.
  assert.equal((await post('/api/auth/login', { email: 'vera@client.example', password: 'veras own password' })).status, 200);
  const confirmed = await post('/api/auth/verify', { token: await lastLink('vera@client.example', 'verify') }, mark(signup));
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.deepEqual([confirmed.json().released, confirmed.json().signedIn], [true, true]);
  assert.equal(ws.roleIn(malloryWs, vera.id), null);
  assert.equal(ws.workspacesOf(vera.id).length, 1);
  // What Vera's inbox got for Mallory's try: a reset link (only she gets it; it lets her in with a password of her own).
  // Her sign-up's link and that reset each go out 100–500 ms after their answer, at random (A12 INV-REV-8), so either
  // may come first; the welcome follows the confirmation.
  const kinds = (await mailTo('vera@client.example')).map((m) => m.kind);
  assert.deepEqual([[...kinds.slice(0, 2)].sort(), kinds.slice(2)], [['reset', 'verify'], ['welcome']], kinds.join());
});

test('WS-3: an invite a workspace owner takes for someone else’s address makes no confirmed account and reaches nothing', async () => {
  const start = (await mailTo('dana@client.example')).length;
  // "Add a user" invites and emails the invite, and hands its link to the inviter all the same.
  const added = await post('/api/admin/users', { email: 'dana@client.example', name: 'Dana', password: PW, role: 'admin' }, mallory);
  assert.equal(added.status, 200, added.text);
  const self = await post('/api/auth/invite/accept', { token: tokenOf(added), name: 'Dana', email: 'dana@client.example', password: 'mallory knows this' });
  assert.deepEqual([self.status, self.json()], [200, { held: true }]);
  const dana = auth.findUserByEmail('dana@client.example') as User;
  assert.ok(dana.unverified && auth.isGated(dana), 'held: never confirmed by an invite');
  assert.deepEqual([dana.role, ws.workspacesOf(dana.id).length], ['reviewer', 0], 'no role and no workspace until the address is confirmed');
  // Mallory's password signs in to "Check your inbox", nothing else: no library, no token.
  const held = session(await post('/api/auth/login', { email: 'dana@client.example', password: 'mallory knows this' }));
  const lib = await request('GET', '/api/library', { headers: held });
  assert.deepEqual([lib.status, lib.json().unconfirmed], [403, true]);
  assert.equal((await post('/api/auth/token', { email: 'dana@client.example', password: 'mallory knows this' })).status, 403);
  assert.equal((await post('/api/auth/tokens', { name: 'cli' }, held)).status, 403);
  assert.equal((await post('/api/auth/invite/peek', { token: tokenOf(added) })).status, 200, 'the invite waits for the address');
  // Only Dana's inbox got the way in.
  assert.deepEqual(
    (await mailTo('dana@client.example')).slice(start).map((m) => m.kind),
    ['invite', 'verify'],
  );
});

test('WS-3: taking an invite tells nothing about which addresses have accounts', async () => {
  const inv = await post('/api/admin/invites', { role: 'member' }, mallory);
  const token = tokenOf(inv);
  const before = auth.listUsers().length;
  // a confirmed account, an account in another workspace, a held one, a free address — short password and long
  const addresses = ['ceo@client.example', 'owner@agency.example', 'dana@client.example', 'nobody@client.example'];
  for (const password of ['x', 'a guess that is long enough']) {
    const answers = [];
    for (const email of addresses) {
      const r = await post('/api/auth/invite/accept', { token, name: 'Probe', email, password });
      answers.push(JSON.stringify([r.status, r.json(), cookies(r).map((c) => c.split('=')[0])]));
    }
    assert.equal(new Set(answers).size, 1, `${password}: ${answers.join(' | ')}`);
  }
  assert.equal(auth.listUsers().length, before + 1, 'only the free address got a (held) account');
  assert.ok(auth.isGated(auth.findUserByEmail('nobody@client.example')));
  assert.equal(ws.roleIn(malloryWs, (auth.findUserByEmail('ceo@client.example') as User).id), null, 'nobody joined');
  assert.equal((await post('/api/auth/invite/peek', { token })).status, 200, 'and the invite is as it was');
});

test('WS-3: an address taken back with a reset is its person’s: the workspace admin who made it sets nothing', async () => {
  const dana = auth.findUserByEmail('dana@client.example') as User;
  // Dana takes her address back from her inbox: in with her own password, never in the squatter's workspace.
  await post('/api/auth/forgot', { email: 'dana@client.example' });
  const reset = await post('/api/auth/reset', { token: await lastLink('dana@client.example', 'reset'), password: 'danas real password' });
  assert.equal(reset.status, 200, reset.text);
  assert.equal(auth.isGated(auth.getUser(dana.id)), false);
  assert.equal(ws.roleIn(malloryWs, dana.id), null, 'the invite Mallory took for her address doesn’t follow a reset');
  const again = await request('PATCH', `/api/admin/users/${dana.id}`, { body: { password: 'mallory again 123' }, headers: h(mallory) });
  assert.equal(again.status, 404, again.text);
  assert.equal((await post('/api/auth/login', { email: 'dana@client.example', password: 'mallory again 123' })).status, 401);
  assert.equal((await post('/api/auth/login', { email: 'dana@client.example', password: 'danas real password' })).status, 200);

  // Someone who does confirm the address of an invite taken for them (their link, from their inbox) works in that
  // workspace only — and their password is theirs from then on.
  const inv = await post('/api/admin/invites', { role: 'member', email: 'eli@client.example' }, mallory);
  const took = await post('/api/auth/invite/accept', { token: tokenOf(inv), name: 'Eli', email: 'eli@client.example', password: 'mallory knows this' });
  assert.deepEqual(took.json(), { held: true });
  const eli = auth.findUserByEmail('eli@client.example') as User;
  const link = await lastLink('eli@client.example', 'verify');
  // In another browser the link asks for the password the account was made with (INV-REV-1): Eli was told it.
  const asked = await post('/api/auth/verify', { token: link });
  assert.deepEqual([asked.status, asked.json().state], [409, 'password']);
  const confirmed = await post('/api/auth/verify', { token: link, password: 'mallory knows this' });
  assert.deepEqual([confirmed.status, confirmed.json().signedIn], [200, true], 'another browser, the password typed: confirmed and in');
  assert.equal(ws.roleIn(malloryWs, eli.id), 'member');
  assert.ok(ws.accountIsOnlyIn(malloryWs, eli.id));
  const set = await request('PATCH', `/api/admin/users/${eli.id}`, { body: { password: 'mallory again 123' }, headers: h(mallory) });
  assert.equal(set.status, 403, set.text);
  assert.match(set.json().error, /their password is theirs/);
  // An account nobody confirmed, made for this workspace alone (`vr admin create-user`): its admin sets a password.
  const made = await ws.createAccountIn(malloryWs, { email: 'temp@client.example', name: 'Temp', password: PW, role: 'member' });
  assert.equal((await request('PATCH', `/api/admin/users/${made.id}`, { body: { password: 'a temporary one' }, headers: h(mallory) })).status, 200);
});
