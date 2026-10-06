// Every way access ends cuts an open MCP wait and listen at once (A12 VE3b-5). An open response remembers a "yes" for
// RECHECK_MIN_MS (server/routes/mcp.ts stillFor), so a way that forgot to call accessEnded() (lib/auth.ts) would hand
// the very next note to someone who just lost the right to read it. Each test opens a listen (warmed: its "yes" is
// fresh) and a wait, ends access one way, writes a note at once, and asserts the wait got no text and the listen was
// cut without hearing it. Each fails when that way's accessEnded() is taken out (checked by hand: see the commit).
// Below them, at the library's level: every way access ends calls accessEnded() — the ways no stream above opens too —
// and only those (A12-D11): an unauthenticated `/oauth/revoke` with a junk token, or a bad refresh, made every open
// stream on the server re-check and rewrote grants.json, which every stream reads.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Role, User } from '../../lib/auth.ts';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, sleep, until } from '../lib/helpers.ts';
import { cookieFrom, type Reply, tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');
const oauth = await import('../../lib/oauth/store.ts');
const store = await import('../../lib/store.ts');
const ws = await import('../../lib/workspaces.ts');
const { RECHECK_MIN_MS } = await import('../../server/routes/mcp.ts');

const { port, request } = await startApp({ feed: 50, headers: { Host: 'review.test' } });
const PASSWORD = 'a long password';
const origin = { Origin: PUBLIC };
const clients: Client[] = [];
after(async () => {
  for (const c of clients) await c.close().catch(() => {});
});

const session = (r: Reply) =>
  [r.headers['set-cookie']]
    .flat()
    .map((c) => String(c).split(';')[0])
    .find((c) => c.startsWith('vr_session=')) || cookieFrom(r);
async function signIn(email: string): Promise<Record<string, string>> {
  const r = await request('POST', '/api/auth/login', { body: { email, password: PASSWORD }, headers: origin });
  assert.equal(r.status, 200, r.text);
  return { Cookie: session(r), ...origin };
}

const owner = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: PASSWORD, role: 'owner' });
const ownerSession = await signIn('olivia@example.com');
const clip = makeVideo(path.join(dir, 'in/spot.mp4'), { dur: 1 });
age(clip);
const up = await tusUpload(request, clip, { filename: 'spot.mp4', folder: 'Spots' }, { Authorization: `Bearer ${auth.createToken(owner.id, 'setup').token}` });
assert.equal(up.status, 200, up.text);
const slug = up.json().slug as string;
const noteHere = (text: string) => store.addComment(slug, { frame: 3, text, author: 'Olivia' });

// A public client registered as an app would be, so /oauth/revoke takes its tokens.
const reg = (
  await request('POST', '/oauth/register', { body: { redirect_uris: ['http://127.0.0.1:9/cb'], token_endpoint_auth_method: 'none', client_name: 'Probe' } })
).json();

type Kind = 'token' | 'session' | 'oauth';
let n = 0;
/** A member who reaches /mcp with an API token, a browser session or an app's access token. */
async function subject(kind: Kind) {
  const email = `m${++n}@example.com`;
  const user = await auth.createUser({ email, name: `Member ${n}`, password: PASSWORD, role: 'member' });
  if (kind === 'token') return { user, headers: { Authorization: `Bearer ${auth.createToken(user.id, 'agent').token}` }, refresh: '' };
  if (kind === 'session') return { user, headers: await signIn(email), refresh: '' };
  const verifier = crypto.randomBytes(32).toString('base64url');
  const asked = oauth.createRequest({
    client: { client_id: reg.client_id, kind: 'dcr', name: 'Probe', host: null, redirect_uris: ['http://127.0.0.1:9/cb'], auth: 'none' },
    redirect_uri: 'http://127.0.0.1:9/cb',
    state: null,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    scopes: ['review:read'],
    resource: `${PUBLIC}/mcp`,
  });
  const t = oauth.redeemCode({
    code: oauth.createCode(asked, user),
    client_id: reg.client_id,
    redirect_uri: 'http://127.0.0.1:9/cb',
    code_verifier: verifier,
    resource: `${PUBLIC}/mcp`,
  });
  return { user, headers: { Authorization: `Bearer ${t.access_token}` }, refresh: t.refresh_token };
}
type Subject = Awaited<ReturnType<typeof subject>>;

/** wait_for_feedback over /mcp: whatever came before the response ended (a cut stream ends without an answer). */
function waitFor(headers: Record<string, string>): Promise<{ text: string; ms: number }> {
  const t = Date.now();
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait_for_feedback', arguments: { timeout_s: 20 } } });
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/mcp',
        agent: false,
        headers: {
          Host: 'review.test',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-06-18',
          'content-length': String(Buffer.byteLength(body)),
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          raw += d;
        });
        const done = () => resolve({ text: raw, ms: Date.now() - t });
        res.on('close', done);
        res.on('error', done);
      },
    );
    req.on('error', (e) => resolve({ text: `[${e.message}]`, ms: Date.now() - t }));
    req.end(body);
  });
}

async function accessEnds(kind: Kind, end: (s: Subject) => unknown, made?: { subject: Subject; workspace: string; quiet?: boolean }) {
  const s = made?.subject ?? (await subject(kind));
  // Once the store has a second workspace, a note is written in the workspace the subject works in.
  const note = (text: string) => (made ? ws.inWorkspace(made.workspace, () => noteHere(text)) : noteHere(text));
  const c = new Client({ name: 'access-ends', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Host: 'review.test', ...s.headers } } }),
  );
  clients.push(c);
  const heard: string[] = [];
  c.setNotificationHandler('notifications/resources/updated', (m) => {
    heard.push(m.params.uri);
  });
  const sub = await c.listen({ resourceSubscriptions: ['vr://inbox'] });
  let closed = false;
  sub.closed.then(() => {
    closed = true;
  });
  // Warm: the listen hears a note while access lasts, so its "yes" is fresh when access ends.
  note('while still in');
  await until(() => heard.length, 'the listen hears a note while access lasts');
  const waiting = waitFor(s.headers);
  // The wait past its own sign-in check (the listen above fails this test without accessEnded() even if it isn't).
  await sleep(500);
  heard.length = 0;
  await end(s);
  // With nothing else happening (no event, so no look at the access files either), only accessEnded() can cut it now.
  if (made?.quiet) await until(() => closed, 'the listen cut at once, with nothing else happening', RECHECK_MIN_MS - 1000);
  note('CONFIDENTIAL: after access ended');
  const got = await waiting;
  assert.doesNotMatch(got.text, /CONFIDENTIAL/, 'the wait handed nothing over');
  assert.ok(got.ms < RECHECK_MIN_MS + 2000, `the wait ended with its access (${got.ms} ms), not at its own time`);
  await until(() => closed, 'the listen cut', RECHECK_MIN_MS - 1000);
  assert.deepEqual(heard, [], 'and the listen heard nothing after access ended');
}

test('signing out (POST /api/auth/logout: revokeSession) cuts a browser session’s wait and listen', () =>
  accessEnds('session', (s) => request('POST', '/api/auth/logout', { headers: s.headers })));

test('signing out everywhere (signOutEverywhere) cuts them', () =>
  accessEnds('session', async (s) => assert.equal((await request('POST', '/api/auth/logout-everywhere', { headers: s.headers })).status, 200)));

test('a new password (updateUser) cuts a session’s', () => accessEnds('session', (s) => auth.updateUser(s.user.id, { password: 'a brand new password' })));

test('a removed account (deleteUser) cuts a token’s', () => accessEnds('token', (s) => auth.deleteUser(s.user.id)));

test('an app disconnected by an admin (DELETE /api/admin/apps/:id: revokeGrant) cuts the app’s', () =>
  accessEnds('oauth', async (s) => {
    const app = oauth.listApps(s.user.id)[0];
    assert.ok(app, 'the app is listed');
    assert.equal((await request('DELETE', `/api/admin/apps/${app.id}`, { headers: ownerSession })).status, 200);
  }));

test('an app revoking its own refresh token (RFC 7009 POST /oauth/revoke) cuts its', () =>
  accessEnds('oauth', async (s) => {
    const r = await request('POST', '/oauth/revoke', { body: { token: s.refresh, client_id: reg.client_id } });
    assert.equal(r.status, 200, r.text);
  }));

// The server's operator disables an account (server/routes/operator.ts): everything it had open ends at once — quiet:
// the listen must be cut before anything else happens (a note would make it look again by itself), so only the
// route's accessEnded() can have cut it.
const operatorDisables = async (s: Subject) => {
  const r = await request('POST', `/api/operator/accounts/${s.user.id}/disable`, { body: {}, headers: ownerSession });
  assert.equal(r.status, 200, r.text);
};
test('an account disabled by the server’s operator (POST /api/operator/accounts/:id/disable) cuts its token’s wait and listen', async () =>
  accessEnds('token', operatorDisables, { subject: await subject('token'), workspace: 'w1', quiet: true }));
test('an account disabled by the server’s operator cuts its browser session’s too', async () =>
  accessEnds('session', operatorDisables, { subject: await subject('session'), workspace: 'w1', quiet: true }));

// ---------------------------------------------------------------- the library: every way, and only those

const LIB_RESOURCE = 'http://review.test/mcp';
let endedCount = 0;
auth.onAccessEnded(() => {
  endedCount++;
});
/** How many times `fn` endedCount access. */
const endsLib = async (fn: () => unknown): Promise<number> => {
  const before = endedCount;
  await fn();
  return endedCount - before;
};
const fileKeyOf = (file: string) => {
  try {
    const st = fs.statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return 'none';
  }
};

let m = 0;
const libPerson = async (role: Role = 'member') => auth.createUser({ email: `p${++m}@example.com`, name: `Person ${m}`, password: 'a long password', role });
/** An app connected through OAuth for `user`, as the token endpoint makes it. */
function libApp(user: User, client_id = `app-${++m}`) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const client = { client_id, kind: 'dcr' as const, name: client_id, host: null, redirect_uris: ['http://127.0.0.1:9/cb'], auth: 'none' as const };
  const asked = oauth.createRequest({
    client,
    redirect_uri: 'http://127.0.0.1:9/cb',
    state: null,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    scopes: ['review:read'],
    resource: LIB_RESOURCE,
  });
  const code = oauth.createCode(asked, auth.getUser(user.id) as User);
  const tokens = oauth.redeemCode({ code, client_id, redirect_uri: 'http://127.0.0.1:9/cb', code_verifier: verifier, resource: LIB_RESOURCE });
  return { ...tokens, client_id, code, verifier };
}

test('A12-D11: what ends nothing tells no open stream, and leaves the files every stream reads as they are', async () => {
  const mia = await libPerson();
  const app = libApp(mia);
  const grants = fileKeyOf(oauth.GRANTS_FILE);
  // RFC 7009 from anyone, with anything: a junk token, another client's real one, a token of no grant at all.
  assert.equal(await endsLib(() => oauth.revokeToken('vro_junk', app.client_id)), 0, 'a junk token');
  assert.equal(await endsLib(() => oauth.revokeToken('', app.client_id)), 0, 'no token');
  assert.equal(await endsLib(() => oauth.revokeToken(app.refresh_token, 'someone-else')), 0, 'another client’s token');
  // A refresh that refreshes nothing.
  assert.equal(
    await endsLib(() => assert.throws(() => oauth.refresh({ refresh_token: 'vrr_junk', client_id: app.client_id }), /unknown/)),
    0,
    'a junk refresh',
  );
  assert.equal(await endsLib(() => assert.throws(() => oauth.refresh({ refresh_token: '', client_id: app.client_id }))), 0, 'an empty refresh');
  assert.equal(fileKeyOf(oauth.GRANTS_FILE), grants, 'grants.json untouched');
  // Nobody to end.
  const nobody = await libPerson();
  assert.equal(await endsLib(() => oauth.revokeAppsOf(nobody.id)), 0, 'an account without apps');
  assert.equal(await endsLib(() => oauth.revokeAppsIn(nobody.id, 'w1')), 0, 'no apps in that workspace');
  assert.equal(await endsLib(() => auth.revokeTokensOf(nobody.id)), 0, 'an account without tokens');
  assert.equal(await endsLib(() => auth.signOutEverywhere('u_nobody')), 0, 'no such account');
  assert.equal(await endsLib(() => auth.sweepUnconfirmed()), 0, 'no sign-up to sweep');
  assert.equal(fileKeyOf(oauth.GRANTS_FILE), grants, 'grants.json still untouched');
  // The app still works: nothing above revoked it.
  assert.ok(oauth.verifyAccess(app.access_token, LIB_RESOURCE, { touch: false }));
});

test('VE3b-5: every way access really ends tells the open streams (a forgotten call fails here)', async () => {
  const cases: [string, () => Promise<unknown> | unknown][] = [
    ['an API token revoked', async () => auth.revokeToken(auth.createToken((await libPerson()).id, 't').info.id)],
    [
      'every token of an account',
      async () => {
        const p = await libPerson();
        auth.createToken(p.id, 't');
        return auth.revokeTokensOf(p.id);
      },
    ],
    [
      'the tokens in a workspace (left it)',
      async () => {
        const p = await libPerson();
        auth.createToken(p.id, 't');
        return auth.revokeTokensIn(p.id, 'w1');
      },
    ],
    ['a new password', async () => auth.updateUser((await libPerson()).id, { password: 'another long password' })],
    ['an account disabled', async () => auth.updateUser((await libPerson()).id, { disabled: true })],
    ['an account deleted', async () => auth.deleteUser((await libPerson()).id)],
    ['signed out everywhere', async () => auth.signOutEverywhere((await libPerson()).id)],
    ['one session signed out', async () => auth.revokeSession(auth.signSession((await libPerson()) as User))],
    ['an app disconnected in Settings', async () => oauth.revokeApp(oauth.listApps((await withLibApp()).id)[0]?.id as string)],
    ['an account’s apps (removed, new password)', async () => oauth.revokeAppsOf((await withLibApp()).id)],
    ['an account’s apps in a workspace (left it)', async () => oauth.revokeAppsIn((await withLibApp()).id, 'w1')],
    [
      'RFC 7009 with the refresh token',
      async () => {
        const a = libApp(await libPerson());
        return oauth.revokeToken(a.refresh_token, a.client_id);
      },
    ],
    [
      'RFC 7009 with the access token',
      async () => {
        const a = libApp(await libPerson());
        return oauth.revokeToken(a.access_token, a.client_id);
      },
    ],
    [
      'a refresh token used twice (it leaked)',
      async () => {
        const a = libApp(await libPerson());
        oauth.refresh({ refresh_token: a.refresh_token, client_id: a.client_id });
        assert.throws(() => oauth.refresh({ refresh_token: a.refresh_token, client_id: a.client_id }), /already used/);
      },
    ],
    [
      'an authorization code used twice',
      async () => {
        const a = libApp(await libPerson());
        assert.throws(() => oauth.redeemCode({ code: a.code, client_id: a.client_id, redirect_uri: 'http://127.0.0.1:9/cb', code_verifier: a.verifier }));
      },
    ],
    [
      'a sign-up nobody confirmed, whose address another account confirms (A12 INV-REV-11)',
      async () => {
        const r = await auth.signUp({ email: `held${++m}@example.com`, name: `Held ${m}`, password: 'a long password', mode: 'open', anyName: true });
        assert.ok('made' in r);
        const p = await libPerson();
        auth.setPendingEmail(p.id, r.made.email);
        auth.confirmAddress(p.id, r.made.email);
        assert.equal(auth.getUser(r.made.id), null, 'the held sign-up is gone');
      },
    ],
  ];
  const withLibApp = async () => {
    const p = await libPerson();
    libApp(p);
    return p;
  };
  for (const [what, fn] of cases) assert.ok((await endsLib(fn)) >= 1, what);
  // A member removed from a workspace (the store moved to workspaces for it).
  const owner = await libPerson('owner');
  ws.migrateWorkspaces();
  const b = ws.createWorkspace({ name: 'Bravo', ownerId: owner.id });
  const leaving = await libPerson();
  ws.addMember(b.id, leaving.id, 'member');
  assert.ok((await endsLib(() => ws.removeMember(b.id, leaving.id))) >= 1, 'a member removed');
  // … or disabled there by its admins (A12 INV-REV-2: the membership is suspended, the account stays).
  const suspended = await libPerson();
  ws.addMember(b.id, suspended.id, 'member');
  assert.ok((await endsLib(() => ws.suspendMember(b.id, suspended.id, true))) >= 1, 'a member suspended');
  // The server's operator takes a workspace down — suspended, or deleted with its members' accounts that worked nowhere
  // else — and a person deletes their own account (A13 CLOUD-5, PEOPLE-1: lib/deletion.ts).
  const deletion = await import('../../lib/deletion.ts');
  const held = ws.createWorkspace({ name: 'Held', ownerId: owner.id });
  assert.ok((await endsLib(() => ws.suspendWorkspace(held.id, { by: owner.id, reason: 'a test' }))) >= 1, 'a workspace suspended');
  const doomed = ws.createWorkspace({ name: 'Doomed', ownerId: owner.id });
  const onlyThere = await libPerson();
  ws.addMember(doomed.id, onlyThere.id, 'member');
  if (ws.roleIn('w1', onlyThere.id)) ws.removeMember('w1', onlyThere.id);
  assert.ok((await endsLib(() => deletion.deleteWorkspace(doomed.id, 'operator'))) >= 1, 'a workspace deleted');
  assert.equal(auth.getUser(onlyThere.id), null, 'with the account that worked nowhere else');
  const quitter = await libPerson();
  if (!ws.roleIn('w1', quitter.id)) ws.addMember('w1', quitter.id, 'member');
  assert.ok((await endsLib(() => deletion.deleteAccount(quitter.id, 'self'))) >= 1, 'an account its person deleted');
});

// Last: the store has workspaces now (the test above moved it), so this subject's notes are written in workspace #1.
test('removed from a workspace (removeMember) cuts the session’s wait and listen there, while the account stays', async () => {
  const user = await auth.createUser({ email: 'leaving@example.com', name: 'Leaving', password: PASSWORD, role: 'member' });
  const elsewhere = ws.createWorkspace({ name: 'Elsewhere', ownerId: owner.id });
  if (!ws.roleIn('w1', user.id)) ws.addMember('w1', user.id, 'member');
  ws.addMember(elsewhere.id, user.id, 'member');
  const subjectInW1: Subject = { user, headers: { Cookie: `vr_session=${auth.signSession(user, 1, 'w1')}`, ...origin }, refresh: '' };
  await accessEnds(
    'session',
    (s) => {
      assert.equal(ws.removeMember('w1', s.user.id).account, false, 'still in another workspace: the account stays');
    },
    { subject: subjectInW1, workspace: 'w1', quiet: true },
  );
});

// A person deletes their own account (POST /api/auth/me/delete, A13 PEOPLE-1): every way in it had ends at once — quiet,
// so only the deletion's accessEnded() can have cut the listen.
test('an account its person deletes (POST /api/auth/me/delete) cuts its session’s wait and listen', async () => {
  const user = await auth.createUser({ email: 'quitting@example.com', name: 'Quitting', password: PASSWORD, role: 'member' });
  if (!ws.roleIn('w1', user.id)) ws.addMember('w1', user.id, 'member');
  const subjectInW1: Subject = { user, headers: await signIn('quitting@example.com'), refresh: '' };
  await accessEnds(
    'session',
    async (s) => {
      const r = await request('POST', '/api/auth/me/delete', { body: { password: PASSWORD }, headers: s.headers });
      assert.equal(r.status, 200, r.text);
      assert.equal(auth.getUser(s.user.id), null);
    },
    { subject: subjectInW1, workspace: 'w1', quiet: true },
  );
});
