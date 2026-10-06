// Refusals and limits no other test reached (audit A12, TEST-5), pinned as they are: asking for a confirm link again
// answers alike for every address and is limited, and signed in it really sends one; a reset link from the inbox
// confirms the address and lets a held sign-up in; malformed OAuth clients and redirect URIs are refused by the guard
// that names the problem; /oauth/authorize and /mcp slow a burst down. Server mode, VR_SIGNUP=invite, every message
// in the log transport's outbox.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import type { User } from '../../lib/auth.ts';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';
import type { Reply } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
// Behind a proxy on this machine, so each request names its own address and the per-address limits trip only on purpose.
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_SIGNUP: 'invite', VR_TRUST_PROXY: 'loopback' } });
const auth = await import('../../lib/auth.ts');
const links = await import('../../lib/accountLinks.ts');
const { readOutbox } = await import('../../lib/mail/index.ts');
const clients = await import('../../lib/oauth/clients.ts');
const { ctx, request } = await startApp({ headers: { Host: 'review.test', Origin: PUBLIC } });

const PASSWORD = 'a long password';
let n = 0;
const somewhere = () => ({ 'X-Forwarded-For': `198.51.100.${(n++ % 250) + 1}` });
const post = (url: string, body: unknown, headers: Record<string, string> = {}) => request('POST', url, { body, headers: { ...somewhere(), ...headers } });
const session = (r: Reply) =>
  [r.headers['set-cookie']]
    .flat()
    .map((c) => String(c).split(';')[0])
    .find((c) => c.startsWith('vr_session=')) || '';
async function signIn(email: string, password = PASSWORD): Promise<string> {
  const r = await post('/api/auth/login', { email, password });
  assert.equal(r.status, 200, r.text);
  return session(r);
}
/** Every message to an address so far, once the route's after-answer work and the queue have run. */
async function mailTo(address: string) {
  await new Promise(setImmediate);
  await ctx.mail.flush();
  return readOutbox(path.join(dir, 'cache', 'outbox')).filter((m) => m.to === address);
}
const kindsTo = async (address: string) => (await mailTo(address)).map((m) => m.kind);
const linkIn = (text: string | undefined, kind: 'verify' | 'reset') => new RegExp(`#/${kind}/((?:vt|rt)_[\\w-]+)`).exec(text ?? '')?.[1] ?? '';

let owner: User;
before(async () => {
  owner = await auth.createUser({ email: 'owner@example.com', name: 'Olivia Hart', password: PASSWORD, role: 'owner' });
});
const by = () => ({ id: owner.id, name: owner.name });
/**
 * A sign-up held until its address is confirmed, as stores from before AUTH-1 still hold them (an invite sign-up made
 * the account from the address alone then; now only the invite's link makes one): written the way that code left it.
 */
async function held(email: string, name: string): Promise<User> {
  const { token } = auth.createInvite({ role: 'member', email, by: by() });
  const { user } = await auth.acceptInvite(token, { name, email, password: PASSWORD });
  const f = JSON.parse(fs.readFileSync(auth.USERS_FILE, 'utf8')) as { users: User[] };
  const u = f.users.find((x) => x.id === user.id) as User;
  u.unverified = new Date().toISOString();
  u.signup = u.unverified;
  fs.writeFileSync(auth.USERS_FILE, JSON.stringify(f, null, 2));
  const made = auth.getUser(user.id) as User;
  assert.ok(auth.isGated(made));
  return made;
}
/** In, but unconfirmed: an invite made out to nobody, taken with an address nobody vouched for. */
async function unconfirmed(email: string, name: string): Promise<User> {
  const { token } = auth.createInvite({ role: 'member', by: by() });
  const { user: u } = await auth.acceptInvite(token, { name, email, password: PASSWORD }, { confirm: true });
  assert.ok(u.unverified && !auth.isGated(u));
  return u;
}

// ---------------------------------------------------------------- the confirm link again (POST /api/auth/verify/resend)

test('signed out, asking for the confirm link again answers the same for a held sign-up, an unconfirmed account and a stranger', async () => {
  await held('hal@example.com', 'Hal Held');
  await unconfirmed('lou@example.com', 'Lou Loose');
  const answers = await Promise.all(['hal@example.com', 'lou@example.com', 'nobody@example.com'].map((email) => post('/api/auth/verify/resend', { email })));
  for (const a of answers) {
    assert.equal(a.status, 200, a.text);
    assert.equal(a.text, '{"ok":true}');
    assert.equal(a.headers['set-cookie'], undefined);
  }
  assert.deepEqual(await kindsTo('hal@example.com'), ['verify'], 'only a held sign-up is sent its link');
  assert.deepEqual(await kindsTo('lou@example.com'), [], 'an account that is in asks signed in');
  assert.deepEqual(await kindsTo('nobody@example.com'), []);
  const none = await post('/api/auth/verify/resend', {});
  assert.deepEqual([none.status, none.json().error], [400, 'which address?']);
  const bad = await post('/api/auth/verify/resend', { email: 'not an address' });
  assert.deepEqual([bad.status, bad.json().error], [400, 'that is not an email address']);
});

test('asking for the confirm link again is limited: five an hour per address, twenty in 15 minutes from one place', async () => {
  const perEmail: Reply[] = [];
  for (let i = 0; i < 6; i++) perEmail.push(await post('/api/auth/verify/resend', { email: 'flood@example.com' }));
  assert.deepEqual(
    perEmail.map((r) => r.status),
    [200, 200, 200, 200, 200, 429],
  );
  const wait = perEmail[5] as Reply;
  assert.match(wait.json().error, /^too many requests for this address, try again in \d+ min$/);
  assert.ok(Number(wait.headers['retry-after']) > 0);
  const here = { 'X-Forwarded-For': '203.0.113.9' };
  const perPlace: Reply[] = [];
  for (let i = 0; i < 21; i++) perPlace.push(await post('/api/auth/verify/resend', { email: `p${i}@example.com` }, here));
  assert.equal(perPlace.filter((r) => r.status === 200).length, 20);
  const last = perPlace[20] as Reply;
  assert.equal(last.status, 429);
  assert.match(last.json().error, /^too many requests from here, try again in \d+ min$/);
});

test('signed in, the link really goes again: to an unconfirmed address, or to a new one waiting for its link', async () => {
  const lou = await signIn('lou@example.com');
  const again = await post('/api/auth/verify/resend', { lang: 'de' }, { Cookie: lou });
  assert.equal(again.status, 200, again.text);
  assert.deepEqual(again.json(), { ok: true, to: 'l•••@example.com' });
  const [mail] = await mailTo('lou@example.com');
  assert.deepEqual([mail?.kind, mail?.lang], ['verify', 'de']);
  assert.match(linkIn(mail?.text, 'verify'), /^vt_/);

  await auth.createUser({ email: 'max@example.com', name: 'Max Moved', password: PASSWORD, role: 'member' });
  const max = await signIn('max@example.com');
  const confirmed = await post('/api/auth/verify/resend', {}, { Cookie: max });
  assert.deepEqual([confirmed.status, confirmed.json().error], [409, 'your address is confirmed already']);
  const moving = await request('PATCH', '/api/auth/me', { body: { email: 'max@studio.example', current_password: PASSWORD }, headers: { Cookie: max } });
  assert.equal(moving.status, 200, moving.text);
  const pending = await post('/api/auth/verify/resend', {}, { Cookie: max });
  assert.deepEqual(pending.json(), { ok: true, to: 'm•••@studio.example' });
  assert.deepEqual(await kindsTo('max@studio.example'), ['verify-change', 'verify-change']);
  assert.deepEqual(await kindsTo('max@example.com'), [], 'the confirmed address gets nothing until the change is made');
  // An API token is no session: it asks like someone signed out.
  const token = auth.createToken((auth.findUserByEmail('max@example.com') as User).id, 'script').token;
  const viaToken = await post('/api/auth/verify/resend', {}, { Authorization: `Bearer ${token}` });
  assert.deepEqual([viaToken.status, viaToken.json().error], [400, 'which address?']);
});

// ---------------------------------------------------------------- a reset link proves the inbox (POST /api/auth/reset)

/** Forgot password → the link from the inbox → a new password; the answer of the reset. */
async function resetFromInbox(email: string): Promise<Reply> {
  assert.equal((await post('/api/auth/forgot', { email })).status, 200);
  const mail = (await mailTo(email)).find((m) => m.kind === 'reset');
  const done = await post('/api/auth/reset', { token: linkIn(mail?.text, 'reset'), password: 'a brand new password' });
  assert.equal(done.status, 200, done.text);
  return done;
}

test('a reset from the inbox lets a held sign-up in: the address is confirmed, a welcome, and this browser is signed in', async () => {
  const hana = await held('hana@example.com', 'Hana Held');
  const heldIn = await signIn('hana@example.com');
  assert.equal((await request('GET', '/api/library', { headers: { Cookie: heldIn } })).status, 403, 'held');
  // Forgot password sends a held sign-up its confirmation now (A13 VERIFY-4, account-email.test.ts): a reset link it
  // was sent before still works, as here.
  const { token } = links.issueLink('reset', hana.id, hana.email);
  const done = await post('/api/auth/reset', { token, password: 'a brand new password' });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json().user.unverified, undefined);
  assert.equal(auth.isGated(auth.getUser(hana.id)), false);
  assert.deepEqual(await kindsTo('hana@example.com'), ['welcome', 'password-changed']);
  assert.equal((await request('GET', '/api/library', { headers: { Cookie: session(done) } })).status, 200, 'in');
  assert.equal((await request('GET', '/api/library', { headers: { Cookie: heldIn } })).status, 401, 'the session from before the new password ended');
});

test('a reset from the inbox confirms an unconfirmed address too, without a welcome (that account was in already)', async () => {
  const una = await unconfirmed('una@example.com', 'Una Loose');
  const done = await resetFromInbox('una@example.com');
  assert.equal(done.json().user.unverified, undefined);
  assert.equal(auth.getUser(una.id)?.unverified, undefined);
  assert.deepEqual(await kindsTo('una@example.com'), ['reset', 'password-changed']);
});

// ---------------------------------------------------------------- OAuth: malformed clients, the consent screen's limit

test('a client that is unknown or whose metadata URL is malformed: 401 invalid_client, saying which', async () => {
  const token = (body: object, headers: Record<string, string> = {}) =>
    post('/oauth/token', { grant_type: 'authorization_code', code: 'x', ...body }, headers).then((r) => [r.status, r.json(), r.headers['www-authenticate']]);
  assert.deepEqual(await token({ client_id: 'vrc_nobody' }), [
    401,
    { error: 'invalid_client', error_description: 'unknown client_id: register first (or use a client ID metadata document URL)' },
    undefined,
  ]);
  // https:// makes it a metadata document URL; a space in the host makes it no URL at all (nothing is fetched).
  assert.deepEqual(await token({ client_id: 'https://exa mple.com/meta.json' }), [
    401,
    { error: 'invalid_client', error_description: 'client_id is not a valid URL' },
    undefined,
  ]);
  const basic = { Authorization: `Basic ${Buffer.from('vrc_nobody:a secret').toString('base64')}` };
  assert.deepEqual(await token({}, basic), [
    401,
    { error: 'invalid_client', error_description: 'unknown client_id: register first (or use a client ID metadata document URL)' },
    'Basic realm="video-review"',
  ]);
});

// The error page is told a code of a fixed set and nothing else (A12 WEB-6): no description rides along.
const errorOf = (r: Reply) => {
  assert.equal(r.status, 302);
  const at = String(r.headers.location);
  assert.ok(at.startsWith('/#/oauth/error?'), at);
  const q = new URLSearchParams(at.slice(at.indexOf('?') + 1));
  assert.equal(q.get('error_description'), null, `no words of the request on the page: ${at}`);
  return q.get('error');
};

test('a redirect URI that is no URL matches no registration; the matching helpers never throw on one', async () => {
  const { client_id } = clients.registerClient({ redirect_uris: ['http://127.0.0.1:7777/cb'], client_name: 'Test app' });
  const r = await request('GET', `/oauth/authorize?${new URLSearchParams({ client_id: String(client_id), redirect_uri: 'not a url', response_type: 'code' })}`);
  // Only the code reaches the error page (A12 WEB-6): the page says it in its own words.
  assert.equal(errorOf(r), 'invalid_request');
  assert.equal(clients.redirectMatches(['http://127.0.0.1:7777/cb'], 'not a url'), false);
  // Registration parses every URI, so a stored one that isn't a URL comes only from a hand-edited clients.json.
  assert.equal(clients.redirectMatches(['::not a url'], 'http://127.0.0.1:7777/cb'), false);
  assert.equal(clients.isLoopbackRedirect('not a url'), false);
});

test('the consent screen slows a burst from one address down; another address goes on', async () => {
  const here = { 'X-Forwarded-For': '203.0.113.20' };
  const answers: (string | null)[] = [];
  for (let i = 0; i < 120; i++) answers.push(errorOf(await request('GET', '/oauth/authorize', { headers: here })));
  // 120 a minute — and the 120th is refused already: the request is counted before the limit is checked.
  assert.equal(answers[118], 'invalid_client');
  assert.equal(answers[119], 'slow_down');
  assert.equal(answers.filter((e) => e === 'slow_down').length, 1);
  assert.equal(errorOf(await request('GET', '/oauth/authorize', { headers: { 'X-Forwarded-For': '203.0.113.21' } })), 'invalid_client');
});

// ---------------------------------------------------------------- /mcp under a burst

test('/mcp answers a burst from one caller with 429 and Retry-After', async () => {
  const agent = await auth.createUser({ email: 'agent@example.com', name: 'Ada Agent', password: PASSWORD, role: 'member' });
  const headers = { Authorization: `Bearer ${auth.createToken(agent.id, 'burst').token}`, Accept: 'application/json, text/event-stream' };
  const ping = () => request('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'ping' }, headers });
  const statuses: number[] = [];
  for (let i = 0; i < 600; i += 50) statuses.push(...(await Promise.all(Array.from({ length: 50 }, ping))).map((r) => r.status));
  // 600 a minute — and, as at /oauth/authorize, the 600th is refused already.
  assert.equal(statuses.filter((s) => s === 429).length, 1);
  assert.deepEqual([...new Set(statuses.filter((s) => s !== 429))], [200]);
  const more = await ping();
  assert.equal(more.status, 429);
  assert.deepEqual(more.json(), { error: 'too many requests' });
  const wait = Number(more.headers['retry-after']);
  assert.ok(wait >= 1 && wait <= 60, String(more.headers['retry-after']));
});
