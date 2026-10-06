// Workspaces, who is who: the session works in one workspace at a time (switching re-signs it), API tokens and app
// connections act in the workspace they were made in, roles are per workspace, invites join one, OAuth consent names it
// and caps the app at the person's role there, and admins of one workspace never reach another's people.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { User } from '../../lib/auth.ts';
import type { AuthStatus, OAuthRequestView } from '../../lib/types.ts';
import { isolatedEnv } from '../lib/helpers.ts';

// Anyone may make a workspace here (VR_WORKSPACE_CREATE=anyone; the default is the owners of #1, workspace-create.test.ts).
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_WORKSPACE_CREATE: 'anyone' } });
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const { readOutbox } = await import('../../lib/mail/index.ts');

let server: http.Server;
let base = '';
const PASSWORD = 'a long password';
let ctx: ReturnType<typeof createContext>;

before(async () => {
  let app: http.RequestListener = (_req, res) => res.end();
  server = http.createServer((req, res) => app(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ctx = createContext({ cfg: loadConfig({ ...process.env, VR_PUBLIC_URL: base }), token: 'unused' });
  app = createApp(ctx) as unknown as http.RequestListener;
  // The store as it was before workspaces: Olivia owns it, Rita reviews.
  await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: PASSWORD, role: 'owner' });
  await auth.createUser({ email: 'rita@example.com', name: 'Rita', password: PASSWORD, role: 'reviewer' });
});
after(() => {
  ctx?.mail.stop();
  server.closeAllConnections();
  server.close();
});

interface Res {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: bodies are checked field by field
  json: () => Promise<any>;
  cookie: string | null;
  /** The `vr_signup` cookie an answer set (a sign-up's or an invite's browser mark). */
  signup: string | null;
}
async function call(method: string, path: string, { cookie, token, body }: { cookie?: string; token?: string; body?: unknown } = {}): Promise<Res> {
  const headers: Record<string, string> = { origin: base };
  if (cookie) headers.cookie = cookie;
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = r.headers.getSetCookie().find((c) => c.startsWith('vr_session='));
  const mark = r.headers.getSetCookie().find((c) => c.startsWith('vr_signup='));
  const text = await r.text();
  return { status: r.status, json: async () => JSON.parse(text), cookie: set ? set.split(';')[0] : null, signup: mark ? mark.split(';')[0] : null };
}
/** The confirm link last mailed to an address (the log transport's outbox). */
async function confirmLink(address: string): Promise<string> {
  await ctx.mail.flush();
  const mail = readOutbox(`${dir}/cache/outbox`)
    .filter((m) => m.to === address && m.kind === 'verify')
    .at(-1);
  const token = /#\/verify\/(vt_[\w-]+)/.exec(mail?.text ?? '')?.[1];
  assert.ok(token, `a confirm link went to ${address}`);
  return token as string;
}
async function signIn(email: string): Promise<string> {
  const r = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(r.status, 200, await r.json().then((j) => j.error));
  return r.cookie as string;
}
const status = async (cookie: string): Promise<AuthStatus> => (await call('GET', '/api/auth/status', { cookie })).json();

let olivia = '';
let acme = '';
let mia = '';
let miaToken = '';
let oliviaAcmeToken = '';
let oliviaW1Token = '';

test('one workspace: nothing changes — status names it, the switcher has nothing to switch to', async () => {
  olivia = await signIn('olivia@example.com');
  const s = await status(olivia);
  assert.equal(s.workspace?.id, 'w1');
  assert.equal(s.workspace?.role, 'owner');
  assert.equal(s.workspaces?.length, 1);
  assert.equal(s.user?.role, 'owner');
  assert.equal(ws.isMigrated(), false, 'a store with one workspace is left as it is');
});

test('making a workspace: its owner is who made it, the session moves into it, the store is migrated once', async () => {
  const made = await call('POST', '/api/workspaces', { cookie: olivia, body: { name: 'Acme Films' } });
  assert.equal(made.status, 200);
  const { workspace } = await made.json();
  acme = workspace.id;
  assert.match(acme, /^w_[a-z0-9]{12}$/);
  assert.deepEqual([workspace.name, workspace.role, workspace.current], ['Acme Films', 'owner', true]);
  assert.ok(made.cookie, 'the session cookie is re-signed for the new workspace');
  olivia = made.cookie as string;
  const s = await status(olivia);
  assert.equal(s.workspace?.id, acme);
  assert.deepEqual(
    s.workspaces?.map((w) => [w.name, w.current]),
    [
      ['Workspace', false],
      ['Acme Films', true],
    ],
  );
  assert.equal(ws.isMigrated(), true);
  // an API token can't make one, nor switch
  const { token } = auth.createToken((auth.findUserByEmail('olivia@example.com') as User).id, 't');
  assert.equal((await call('POST', '/api/workspaces', { token, body: { name: 'X' } })).status, 403);
  assert.equal((await call('POST', '/api/workspaces/switch', { token, body: { id: acme } })).status, 403);
});

test('invites join the workspace they were made in; the new member sees only that one', async () => {
  const inv = await call('POST', '/api/admin/invites', { cookie: olivia, body: { role: 'reviewer', email: 'mia@example.com' } });
  assert.equal(inv.status, 200);
  const { url, invite } = await inv.json();
  assert.equal(invite.workspace, acme);
  const token = url.split('/#/invite/')[1];
  const peek = await call('POST', '/api/auth/invite/peek', { body: { token } });
  assert.equal((await peek.json()).workspace, 'Acme Films', 'the link says which workspace it joins');
  // Taking it proves no inbox (whoever made the invite holds its link too): Mia is held, in no workspace, until her
  // address is confirmed — then the invite's workspace and role are hers, and the browser that took it is signed in.
  const accepted = await call('POST', '/api/auth/invite/accept', { body: { token, name: 'Mia', email: 'mia@example.com', password: PASSWORD } });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { held: true });
  assert.equal(accepted.cookie, null, 'nobody is signed in by the link alone');
  const held = auth.findUserByEmail('mia@example.com') as User;
  assert.deepEqual([auth.isGated(held), ws.workspacesOf(held.id).length], [true, 0]);
  const confirmed = await call('POST', '/api/auth/verify', { cookie: accepted.signup as string, body: { token: await confirmLink('mia@example.com') } });
  assert.equal(confirmed.status, 200);
  assert.equal((await confirmed.json()).signedIn, true);
  mia = confirmed.cookie as string;
  const s = await status(mia);
  assert.equal(s.workspace?.id, acme);
  assert.equal(s.user?.role, 'reviewer');
  assert.deepEqual(
    s.workspaces?.map((w) => w.id),
    [acme],
  );
  // workspace #1 is no workspace of hers: switching there is "no such workspace", like any id
  assert.equal((await call('POST', '/api/workspaces/switch', { cookie: mia, body: { id: 'w1' } })).status, 404);
  assert.equal((await call('POST', '/api/workspaces/switch', { cookie: mia, body: { id: 'w_aaaaaaaaaaaa' } })).status, 404);
  // reviewers don't run the workspace
  assert.equal((await call('GET', '/api/admin/users', { cookie: mia })).status, 403);
  assert.equal((await call('PATCH', '/api/workspaces/current', { cookie: mia, body: { name: 'Mine' } })).status, 403);
});

test('an invite opened by someone signed in says where they stand; an account joins with its password, throttled like sign-in', async () => {
  const theo = await ws.createAccountIn('w1', { email: 'theo@example.com', name: 'Theo', password: PASSWORD, role: 'member' });
  const theoCookie = await signIn('theo@example.com');
  const open = (await (await call('POST', '/api/admin/invites', { cookie: olivia, body: { role: 'reviewer' } })).json()).url.split('/#/invite/')[1];
  const forZoe = (await (await call('POST', '/api/admin/invites', { cookie: olivia, body: { role: 'reviewer', email: 'zoe@example.com' } })).json()).url.split(
    '/#/invite/',
  )[1];
  const peek = async (token: string, cookie?: string) => (await call('POST', '/api/auth/invite/peek', { cookie, body: { token } })).json();
  // nothing about anyone without a session; the workspace's own owner is a member; Theo (in #1 only) may join; an
  // invite made out to another address is "other", never which address
  assert.equal((await peek(open)).you, undefined);
  assert.deepEqual([(await peek(open, olivia)).you, (await peek(open, olivia)).workspace_id], ['member', acme]);
  assert.deepEqual([(await peek(open, theoCookie)).you, (await peek(open, theoCookie)).workspace_id], ['join', undefined]);
  const other = await peek(forZoe, theoCookie);
  assert.equal(other.you, 'other');
  assert.equal(other.email, null);
  // guessing Theo's password through the invite: answered like any address (nothing tells it has an account), then
  // throttled like a sign-in (the link stays valid)
  const tries: string[] = [];
  for (let i = 0; i < 9; i++) {
    const r = await call('POST', '/api/auth/invite/accept', { body: { token: open, name: 'Xavier', email: 'theo@example.com', password: `wrong guess ${i}` } });
    tries.push(`${r.status} ${r.status === 200 ? JSON.stringify(await r.json()) : ''}`.trim());
  }
  assert.deepEqual(tries, [...Array(8).fill('200 {"held":true}'), '429']);
  assert.equal(ws.roleIn(acme, theo.id), null);
  assert.equal((await peek(open)).role, 'reviewer', 'still valid');
});

test('admins see and manage their workspace’s people only; another team’s are no such user', async () => {
  const users = (await (await call('GET', '/api/admin/users', { cookie: olivia })).json()).users;
  assert.deepEqual(users.map((u: { name: string; role: string }) => [u.name, u.role]).sort(), [
    ['Mia', 'reviewer'],
    ['Olivia', 'owner'],
  ]);
  const rita = auth.findUserByEmail('rita@example.com') as User;
  assert.equal((await call('PATCH', `/api/admin/users/${rita.id}`, { cookie: olivia, body: { role: 'admin' } })).status, 404);
  assert.equal((await call('DELETE', `/api/admin/users/${rita.id}`, { cookie: olivia })).status, 404);
  // the account itself of someone who also works elsewhere is theirs: Olivia is in #1 too
  await ws.addMember(acme, (auth.findUserByEmail('rita@example.com') as User).id, 'admin');
  const ritaAcme = await signIn('rita@example.com');
  const switched = await call('POST', '/api/workspaces/switch', { cookie: ritaAcme, body: { id: acme } });
  assert.equal(switched.status, 200);
  const rAdmin = switched.cookie as string;
  const oliviaId = (auth.findUserByEmail('olivia@example.com') as User).id;
  assert.equal((await call('PATCH', `/api/admin/users/${oliviaId}`, { cookie: rAdmin, body: { password: 'taken over now!' } })).status, 403);
  // roles are per workspace: Mia becomes a member of Acme, nothing else changes
  const miaId = (auth.findUserByEmail('mia@example.com') as User).id;
  const promoted = await call('PATCH', `/api/admin/users/${miaId}`, { cookie: olivia, body: { role: 'member' } });
  assert.equal(promoted.status, 200);
  assert.equal((await promoted.json()).user.role, 'member');
  assert.equal(ws.roleIn(acme, miaId), 'member');
  assert.equal(ws.roleIn('w1', miaId), null);
  // Rita is an admin of Acme and a reviewer of #1
  assert.equal(ws.roleIn('w1', (auth.findUserByEmail('rita@example.com') as User).id), 'reviewer');
});

test('TEST-1: an owner can’t take over the account of someone another workspace relies on; the last owner stays', async () => {
  // Olivia owns Acme; Rita is an admin there and a reviewer of #1. Olivia may manage Rita (an owner manages admins),
  // so what refuses these is the account rule (accountIsOnlyIn), not the owners-only one.
  const ritaId = (auth.findUserByEmail('rita@example.com') as User).id;
  const before = auth.getUser(ritaId) as User;
  for (const body of [{ password: 'taken over now!' }, { email: 'rita@taken.example' }, { name: 'Rita (fired)' }]) {
    const r = await call('PATCH', `/api/admin/users/${ritaId}`, { cookie: olivia, body });
    assert.equal(r.status, 403, JSON.stringify(body));
    assert.match((await r.json()).error, /also work in another workspace/, JSON.stringify(body));
  }
  const after = auth.getUser(ritaId) as User;
  assert.deepEqual([after.password, after.email, after.disabled, after.name], [before.password, before.email, before.disabled, before.name]);
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'rita@example.com', password: PASSWORD } })).status, 200, 'she still signs in');
  // Disabling her is Acme's, and Acme's only (INV-REV-2): her membership here is suspended, her account untouched.
  const off = await call('PATCH', `/api/admin/users/${ritaId}`, { cookie: olivia, body: { disabled: true } });
  assert.equal(off.status, 200);
  assert.deepEqual([ws.roleIn(acme, ritaId), ws.roleIn('w1', ritaId), auth.getUser(ritaId)?.disabled], [null, 'reviewer', undefined]);
  assert.equal((await call('PATCH', `/api/admin/users/${ritaId}`, { cookie: olivia, body: { disabled: false } })).status, 200);
  assert.equal(ws.roleIn(acme, ritaId), 'admin');
  // Her role here is Acme's to change.
  const demoted = await call('PATCH', `/api/admin/users/${ritaId}`, { cookie: olivia, body: { role: 'member' } });
  assert.equal(demoted.status, 200);
  assert.equal(ws.roleIn(acme, ritaId), 'member');
  await call('PATCH', `/api/admin/users/${ritaId}`, { cookie: olivia, body: { role: 'admin' } });
  // Someone who works only in a workspace they alone own can't disable themselves: it would be left ownerless.
  const solo = await auth.createUser({ email: 'solo@example.com', name: 'Solo', password: PASSWORD, role: 'reviewer' });
  ws.createWorkspace({ name: 'Solo Studio', ownerId: solo.id });
  const soloSession = await signIn('solo@example.com');
  const off2 = await call('PATCH', `/api/admin/users/${solo.id}`, { cookie: soloSession, body: { disabled: true } });
  assert.equal(off2.status, 400);
  assert.match((await off2.json()).error, /cannot disable yourself/);
  assert.equal(auth.getUser(solo.id)?.disabled, undefined);
});

test('API tokens act in the workspace they were made in, with the role there; leaving takes them along', async () => {
  const made = await call('POST', '/api/auth/tokens', { cookie: olivia, body: { name: 'acme laptop' } });
  oliviaAcmeToken = (await made.json()).token;
  const me = await (await call('GET', '/api/auth/me', { token: oliviaAcmeToken })).json();
  assert.equal(me.workspace.id, acme);
  // the token lists Acme's people (Rita joined it as an admin), not #1's
  const viaToken = (await (await call('GET', '/api/admin/users', { token: oliviaAcmeToken })).json()).users.map((u: { name: string }) => u.name);
  assert.deepEqual(viaToken.sort(), ['Mia', 'Olivia', 'Rita']);
  // her session lists only Acme's tokens
  const w1Session = (await call('POST', '/api/workspaces/switch', { cookie: olivia, body: { id: 'w1' } })).cookie as string;
  oliviaW1Token = (await (await call('POST', '/api/auth/tokens', { cookie: w1Session, body: { name: 'w1 laptop' } })).json()).token;
  const inW1 = (await (await call('GET', '/api/auth/tokens', { cookie: w1Session })).json()).tokens.map((t: { name: string }) => t.name);
  const inAcme = (await (await call('GET', '/api/auth/tokens', { cookie: olivia })).json()).tokens.map((t: { name: string }) => t.name);
  assert.ok(inW1.includes('w1 laptop') && !inW1.includes('acme laptop'));
  assert.ok(inAcme.includes('acme laptop') && !inAcme.includes('w1 laptop'));
  assert.equal((await (await call('GET', '/api/auth/me', { token: oliviaW1Token })).json()).workspace.id, 'w1');
  // vr login names a workspace, or gets the person's first
  const login = await call('POST', '/api/auth/token', { body: { email: 'mia@example.com', password: PASSWORD } });
  miaToken = (await login.json()).token;
  assert.equal((await (await call('GET', '/api/auth/me', { token: miaToken })).json()).workspace.id, acme);
  const wrong = await call('POST', '/api/auth/token', { body: { email: 'mia@example.com', password: PASSWORD, workspace: 'w1' } });
  assert.equal(wrong.status, 403);
  // Mia leaves Acme: her token, her session — and with no workspace left, her account — are gone
  const miaId = (auth.findUserByEmail('mia@example.com') as User).id;
  assert.equal((await call('DELETE', `/api/admin/users/${miaId}`, { cookie: olivia })).status, 200);
  assert.equal((await call('GET', '/api/auth/me', { token: miaToken })).status, 401);
  assert.equal((await call('GET', '/api/library', { cookie: mia })).status, 401);
  assert.equal(auth.getUser(miaId), null);
});

test('a session in a workspace it lost falls back to where the person still works', async () => {
  const ritaId = (auth.findUserByEmail('rita@example.com') as User).id;
  const rita = (await call('POST', '/api/workspaces/switch', { cookie: await signIn('rita@example.com'), body: { id: acme } })).cookie as string;
  assert.equal((await status(rita)).workspace?.id, acme);
  ws.removeMember(acme, ritaId);
  const s = await status(rita);
  assert.equal(s.workspace?.id, 'w1', 'back home, as a reviewer');
  assert.equal(s.user?.role, 'reviewer');
});

// ---------------------------------------------------------------- OAuth

const b64url = (b: Buffer) => b.toString('base64url');
const REDIRECT = 'http://127.0.0.1:65000/callback';

/** An app asks to connect (registered, PKCE, the authorize redirect): the consent request's id. */
async function startConsent(cookie: string, scope: string) {
  const reg = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Agent', redirect_uris: [REDIRECT] }),
  });
  const client_id = ((await reg.json()) as { client_id: string }).client_id;
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const q = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 's',
    resource: `${base}/mcp`,
    scope,
  });
  const first = await fetch(`${base}/oauth/authorize?${q}`, { redirect: 'manual', headers: { cookie } });
  const id = /^\/\?consent#\/oauth\/([A-Za-z0-9_-]+)$/.exec(first.headers.get('location') || '')?.[1] as string;
  return { id, client_id, verifier };
}
/** The consent screen's view, and its answer (the workspace the screen showed, as the app sends it). */
const consentView = async (cookie: string, id: string) =>
  (await (await fetch(`${base}/api/oauth/requests/${id}`, { headers: { cookie } })).json()) as OAuthRequestView;
const decide = (cookie: string, id: string, body: object) =>
  fetch(`${base}/api/oauth/requests/${id}`, {
    method: 'POST',
    headers: { cookie, origin: base, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function connectApp(cookie: string, scope: string) {
  const { id, client_id, verifier } = await startConsent(cookie, scope);
  const view = await consentView(cookie, id);
  const decided = await decide(cookie, id, { allow: true, ...(view.workspace ? { workspace: view.workspace.id } : {}) });
  const code = new URL(((await decided.json()) as { redirect: string }).redirect).searchParams.get('code') as string;
  const tokens = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id, redirect_uri: REDIRECT }).toString(),
  });
  return { view, access: ((await tokens.json()) as { access_token: string }).access_token };
}

async function mcp(access: string, method: string, params: object = {}) {
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${access}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: r.status, text: await r.text() };
}

test('OAuth: consent names the workspace, the app acts there only, capped at the person’s role there', async () => {
  // Rita: reviewer in #1, back to admin in Acme
  const ritaId = (auth.findUserByEmail('rita@example.com') as User).id;
  ws.addMember(acme, ritaId, 'admin');
  const rita = (await call('POST', '/api/workspaces/switch', { cookie: await signIn('rita@example.com'), body: { id: acme } })).cookie as string;
  const inAcme = await connectApp(rita, 'review:act');
  assert.equal(inAcme.view.workspace?.name, 'Acme Films', 'the consent screen names where the app will act');
  assert.deepEqual(inAcme.view.capped, [], 'an admin of Acme can use what she allows');
  const w1 = (await call('POST', '/api/workspaces/switch', { cookie: rita, body: { id: 'w1' } })).cookie as string;
  const inW1 = await connectApp(w1, 'review:act');
  assert.equal(inW1.view.workspace?.id, 'w1');
  assert.ok(inW1.view.capped.includes('review:act'), 'a reviewer in #1: acting is capped there');
  // each app lists its own workspace's apps
  const appsAcme = (await (await call('GET', '/api/auth/apps', { cookie: rita })).json()).apps;
  const appsW1 = (await (await call('GET', '/api/auth/apps', { cookie: w1 })).json()).apps;
  assert.equal(appsAcme.length, 1);
  assert.equal(appsW1.length, 1);
  assert.notEqual(appsAcme[0].id, appsW1[0].id);
  // the apps work, each in its own workspace; once she leaves Acme its app is refused
  assert.equal(
    (await mcp(inAcme.access, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'a', version: '1' } })).status,
    200,
  );
  ws.removeMember(acme, ritaId);
  assert.equal((await mcp(inAcme.access, 'tools/list')).status, 401);
  assert.equal(
    (await mcp(inW1.access, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'a', version: '1' } })).status,
    200,
  );
});

test('WS-12: consent grants the workspace the screen showed, never another one the session switched to meanwhile', async () => {
  const inAcme = (await call('POST', '/api/workspaces/switch', { cookie: await signIn('olivia@example.com'), body: { id: acme } })).cookie as string;
  const { id } = await startConsent(inAcme, 'review:read');
  const shown = await consentView(inAcme, id);
  assert.equal(shown.workspace?.id, acme, 'the screen says Acme');
  // Another tab switches the session to #1; the screen still says Acme when she allows.
  const inW1 = (await call('POST', '/api/workspaces/switch', { cookie: inAcme, body: { id: 'w1' } })).cookie as string;
  const before = (await (await call('GET', '/api/auth/apps', { cookie: inW1 })).json()).apps.length;
  const moved = await decide(inW1, id, { allow: true, workspace: acme });
  const said = (await moved.json()) as { state?: string; workspace?: string };
  assert.deepEqual([moved.status, said.state, said.workspace], [409, 'workspace', 'w1'], 'refused, saying where the session works now');
  // Without saying which (a page from before), a server with several workspaces doesn't guess either.
  assert.equal((await decide(inW1, id, { allow: true })).status, 409);
  assert.equal((await (await call('GET', '/api/auth/apps', { cookie: inW1 })).json()).apps.length, before, 'no app in #1');
  // The request waits: the screen asks again, names #1 now, and that answer is the one granted.
  const again = await consentView(inW1, id);
  assert.equal(again.workspace?.id, 'w1');
  const granted = await decide(inW1, id, { allow: true, workspace: 'w1' });
  const body = await granted.text();
  assert.equal(granted.status, 200, body);
  assert.ok(new URL((JSON.parse(body) as { redirect: string }).redirect).searchParams.get('code'));
  // Deny needs no workspace: nothing is granted anywhere.
  const other = await startConsent(inW1, 'review:read');
  assert.equal((await decide(inW1, other.id, { allow: false })).status, 200);
});

test('WS-3: the owner of a self-made workspace makes no account for anyone else, learns nothing of who has one, and invites in fixed words', async () => {
  // Rita, a reviewer of #1, makes a workspace of her own (VR_WORKSPACE_CREATE=anyone lets her).
  const rita = await signIn('rita@example.com');
  const made = await call('POST', '/api/workspaces', { cookie: rita, body: { name: 'Totally Legit' } });
  assert.equal(made.status, 200);
  const squat = made.cookie as string;
  const ritaWs = (await made.json()).workspace.id;
  const outbox = () => readOutbox(`${dir}/cache/outbox`);
  await ctx.mail.flush();
  const start = outbox().length;
  // "Add a user" for an address that has an account and for one that doesn't: the same answer, and no account made.
  const add = (email: string) =>
    call('POST', '/api/admin/users', { cookie: squat, body: { email, name: 'Dana', password: 'danas password 1', role: 'admin' } });
  const [existing, fresh] = [await add('olivia@example.com'), await add('dana@client.example')];
  assert.deepEqual([existing.status, fresh.status], [200, 200]);
  const [a, b] = [await existing.json(), await fresh.json()];
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), 'the same answer either way');
  assert.equal(a.user, undefined, 'no account handed back');
  assert.ok(a.invite && b.invite, 'an invite instead');
  assert.equal(auth.findUserByEmail('dana@client.example'), null, 'no account for an address nobody confirmed');
  assert.equal(ws.roleIn(ritaWs, (auth.findUserByEmail('olivia@example.com') as User).id), null, 'and nobody joined');
  // The invites went out in the server's words; what Rita typed is quoted.
  await ctx.mail.flush();
  const sent = outbox()
    .slice(start)
    .filter((m) => m.kind === 'invite');
  assert.deepEqual(sent.map((m) => m.to).sort(), ['dana@client.example', 'olivia@example.com']);
  for (const m of sent) {
    assert.equal(m.subject, `An invite to Lampo on ${new URL(base).host}`);
    assert.ok(m.text.includes('From an account named “Rita”, for a workspace named “Totally Legit”.'), m.text);
  }
  // A member's address is the member's to change, in Profile: an admin's attempt says nothing about the address.
  const nina = await ws.createAccountIn(acme, { email: 'nina@example.com', name: 'Nina', password: PASSWORD, role: 'member' });
  const probe = (email: string) => call('PATCH', `/api/admin/users/${nina.id}`, { cookie: olivia, body: { email } });
  const [taken, free] = [await probe('rita@example.com'), await probe('nobody-yet@example.com')];
  assert.deepEqual([taken.status, free.status], [403, 403]);
  assert.equal((await taken.json()).error, (await free.json()).error);
  // Profile: an address another account uses is answered like any other, and its owner gets no link.
  const before = outbox().length;
  const ninaSession = await signIn('nina@example.com');
  const moveTo = (email: string) => call('PATCH', '/api/auth/me', { cookie: ninaSession, body: { email, current_password: PASSWORD } });
  const [m1, m2] = [await moveTo('olivia@example.com'), await moveTo('nina.new@example.com')];
  assert.deepEqual([m1.status, m2.status], [200, 200]);
  assert.deepEqual([(await m1.json()).user.pending_email, (await m2.json()).user.pending_email], ['olivia@example.com', 'nina.new@example.com']);
  await ctx.mail.flush();
  assert.deepEqual(
    outbox()
      .slice(before)
      .map((m) => m.to),
    ['nina.new@example.com'],
  );
});

test('VA-1, WS-3: an invite waits for an address to be confirmed, and the first one confirmed takes it (VR_SIGNUP=off)', async () => {
  // An invite that names nobody, taken by two people: two held accounts, nothing used up, nobody in yet.
  const url = (await (await call('POST', '/api/admin/invites', { cookie: olivia, body: { role: 'member' } })).json()).url as string;
  const token = url.split('/#/invite/')[1];
  const take = (name: string, email: string) => call('POST', '/api/auth/invite/accept', { body: { token, name, email, password: PASSWORD } });
  const [xena, yuri] = [await take('Xena', 'xena@example.com'), await take('Yuri', 'yuri@example.com')];
  for (const r of [xena, yuri]) assert.deepEqual([r.status, await r.json(), r.cookie], [200, { held: true }, null]);
  const [x, y] = ['xena@example.com', 'yuri@example.com'].map((e) => auth.findUserByEmail(e) as User);
  assert.equal(ws.roleIn(acme, x.id), null);
  assert.equal((await call('POST', '/api/auth/invite/peek', { body: { token } })).status, 200, 'still pending');
  // Xena confirms first, in the browser that took the invite: she is in, a member of Acme.
  const first = await call('POST', '/api/auth/verify', { cookie: xena.signup as string, body: { token: await confirmLink('xena@example.com') } });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).signedIn, true);
  assert.equal(ws.roleIn(acme, x.id), 'member');
  assert.equal((await call('POST', '/api/auth/invite/peek', { body: { token } })).status, 404, 'used, by her');
  // Yuri's link comes too late: refused and unused, he stays held, and the server open to nobody makes him no workspace.
  const second = await call('POST', '/api/auth/verify', { cookie: yuri.signup as string, body: { token: await confirmLink('yuri@example.com') } });
  assert.equal(second.status, 409);
  assert.equal((await second.json()).state, 'invite');
  assert.equal(auth.isGated(auth.getUser(y.id)), true);
  assert.deepEqual(ws.workspacesOf(y.id), []);
  // …and again, however often he opens it (INV-REV-3: the first refusal used to drop his claim, the second open then
  // confirmed him into no workspace at all).
  const third = await call('POST', '/api/auth/verify', { cookie: yuri.signup as string, body: { token: await confirmLink('yuri@example.com') } });
  assert.deepEqual([third.status, (await third.json()).state], [409, 'invite']);
  assert.equal(auth.isGated(auth.getUser(y.id)), true);
});

test('the machine’s owner owns workspace #1 (local mode: one workspace, as always)', () => {
  const owner = auth.findUserByEmail('olivia@example.com') as User;
  assert.equal(ws.roleIn('w1', owner.id), 'owner');
  assert.equal(ws.homeWorkspace(owner.id), 'w1');
});
