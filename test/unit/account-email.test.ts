// Accounts and email (server mode, VR_SIGNUP=invite): one-time links (random, hashed at rest, single use, short-lived),
// answers that never tell whether an address has an account, sign-up held until its address is confirmed, forgot
// password → every other session ends, a change of address confirmed from the new inbox with a notice to the old one,
// invites by email (send, resend, revoke), the account notices, the onSignup seam for open sign-up, and the limits.
// Every message goes to the log transport's outbox, read back here; nothing is sent anywhere.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';
import { client, type Reply } from '../lib/http.ts';
import { registeredRoutes } from '../lib/routes.ts';

const PUBLIC = 'http://review.test';
// Behind a proxy on this machine, so each request can come from its own address (X-Forwarded-For): the per-address
// limits are tested on purpose below, not tripped by a whole file of requests from 127.0.0.1.
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_SIGNUP: 'invite', VR_TRUST_PROXY: 'loopback' } });
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const auth = await import('../../lib/auth.ts');
const links = await import('../../lib/accountLinks.ts');
type User = import('../../lib/auth.ts').User;
const { readOutbox } = await import('../../lib/mail/index.ts');

// Everything the server logs while these run: no line may carry an address or a token.
const logged: string[] = [];
const original = { log: console.log, warn: console.warn, error: console.error };
for (const k of ['log', 'warn', 'error'] as const) console[k] = (...a: unknown[]) => logged.push(a.map(String).join(' '));
after(() => Object.assign(console, original));

const { ctx, app, request } = await startApp({ headers: { Connection: 'close', Host: 'review.test' } });
after(() => ctx.mail.stop());

const OUTBOX = path.join(dir, 'cache', 'outbox');
const origin = { Origin: PUBLIC };
/** The cookies an answer set, ready for a Cookie header (session and device). */
const cookiesOf = (r: Reply) =>
  [r.headers['set-cookie']]
    .flat()
    .filter(Boolean)
    .map((c) => String(c).split(';')[0])
    .join('; ');
let n = 0;
const somewhere = () => ({ 'X-Forwarded-For': `198.51.100.${(n++ % 250) + 1}` });
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  request('POST', url, { body, headers: { ...origin, ...somewhere(), ...headers } });
/** The messages sent to an address since `since` (the outbox index), after the queue has run. */
async function mailTo(address: string, since = 0) {
  await ctx.mail.flush();
  return readOutbox(OUTBOX)
    .slice(since)
    .filter((m) => m.to === address);
}
const outboxSize = async () => {
  await ctx.mail.flush();
  return readOutbox(OUTBOX).length;
};
const tokenIn = (text: string, prefix: 'vt' | 'rt' | 'inv') => new RegExp(`#/(?:verify|reset|invite)/(${prefix}_[\\w-]+)`).exec(text)?.[1] as string;

let ownerHeaders: Record<string, string>;
before(async () => {
  await auth.createUser({ email: 'owner@example.com', name: 'Olivia Hart', password: 'olivias password', role: 'owner' });
  ctx.setup.token = null;
  const login = await post('/api/auth/login', { email: 'owner@example.com', password: 'olivias password' });
  assert.equal(login.status, 200, login.text);
  ownerHeaders = { Cookie: cookiesOf(login) };
});

// ---------------------------------------------------------------- the links

test('a link is random, hashed at rest, works once, ends, and a newer one replaces it', () => {
  const user = auth.findUserByEmail('owner@example.com') as User;
  const now = Date.now();
  const a = links.issueLink('reset', user.id, user.email, now);
  assert.match(a.token, /^rt_[A-Za-z0-9_-]{43}$/);
  const onDisk = fs.readFileSync(links.LINKS_FILE, 'utf8');
  assert.ok(!onDisk.includes(a.token), 'only the hash is stored');
  assert.equal((fs.statSync(links.LINKS_FILE).mode & 0o777).toString(8), '600');
  assert.equal(links.peekLink('reset', a.token).state, 'ok');
  assert.equal(links.peekLink('verify', a.token).state, 'invalid', 'a reset token is no confirm token');
  assert.equal(links.peekLink('reset', `${a.token.slice(0, -1)}x`).state, 'invalid');
  assert.equal(links.peekLink('reset', a.token, now + 61 * 60e3).state, 'expired', 'a reset link lasts an hour');
  const b = links.issueLink('reset', user.id, user.email, now);
  assert.equal(links.peekLink('reset', a.token).state, 'used', 'the older link stopped working');
  assert.equal(links.useLink('reset', b.token).state, 'ok');
  assert.equal(links.useLink('reset', b.token).state, 'used', 'once only');
  const v = links.issueLink('verify', user.id, user.email, now);
  assert.equal(links.peekLink('verify', v.token, now + 23 * 3600e3).state, 'ok');
  assert.equal(links.peekLink('verify', v.token, now + 25 * 3600e3).state, 'expired', 'a confirm link lasts a day');
  assert.equal(links.voidLinks(user.id), 1);
});

// ---------------------------------------------------------------- forgot password

test('forgot password answers the same for every address; only an account gets a link', async () => {
  const start = await outboxSize();
  await auth.createUser({ email: 'gone@example.com', name: 'Gone', password: 'a long password', role: 'member' });
  const gone = auth.findUserByEmail('gone@example.com') as User;
  await auth.updateUser(gone.id, { disabled: true });
  const answers = await Promise.all(
    ['owner@example.com', 'nobody@example.com', 'gone@example.com'].map((email) => post('/api/auth/forgot', { email, lang: 'en' })),
  );
  for (const a of answers) {
    assert.equal(a.status, 200, a.text);
    assert.deepEqual(a.json(), { ok: true });
  }
  const sent = (await mailTo('owner@example.com', start)).filter((m) => m.kind === 'reset');
  assert.equal(sent.length, 1);
  assert.equal((await mailTo('nobody@example.com', start)).length, 0);
  assert.equal((await mailTo('gone@example.com', start)).length, 0, 'a disabled account gets nothing');
  assert.match(sent[0]?.text ?? '', /http:\/\/review\.test\/#\/reset\/rt_/);
});

// A13 VERIFY-4: forgot password sent a reset to a sign-up nobody confirmed, so one address asking resets for sign-ups of
// its own filled the resets' lane and a real person's reset waited past its link's hour. Such an account gets its
// confirmation instead (its page takes a new password, as a reset's does); whoever asks hears the same as for anyone.
test('forgot password for a sign-up nobody confirmed sends its confirmation, never a reset; the answer is the same', async () => {
  await post('/api/admin/invites', { role: 'reviewer', email: 'hal@example.com' }, ownerHeaders);
  const hal = await heldFromBefore('hal@example.com', 'Hal Held', 'hals password 1');
  const start = await outboxSize();
  const answers = await Promise.all(['hal@example.com', 'nobody2@example.com'].map((email) => post('/api/auth/forgot', { email, lang: 'en' })));
  for (const a of answers) assert.deepEqual([a.status, a.json()], [200, { ok: true }]);
  const mail = await mailTo('hal@example.com', start);
  assert.deepEqual(
    mail.map((m) => m.kind),
    ['verify'],
    'its confirmation, not a reset',
  );
  // the link takes a new password, as a reset would: confirmed, in with it, the one it was made with gone
  const done = await post('/api/auth/verify', { token: tokenIn(mail[0]?.text ?? '', 'vt'), new_password: 'hals own new password' });
  assert.equal(done.status, 200, done.text);
  assert.equal(auth.isGated(auth.getUser(hal.id)), false);
  assert.equal((await post('/api/auth/login', { email: 'hal@example.com', password: 'hals own new password' })).status, 200);
  assert.equal((await post('/api/auth/login', { email: 'hal@example.com', password: 'hals password 1' })).status, 401);
});

test('INV-REV-8: what an address with an account costs the server happens a while after the answer, never right after it', async () => {
  // The answer is the same for every address; the work for an existing one (a link, a queued email) used to follow at
  // once, so a request sent right after showed whether there was an account. It now runs 100–500 ms later.
  const owner = auth.findUserByEmail('owner@example.com') as User;
  const linksFor = () =>
    fs.existsSync(links.LINKS_FILE)
      ? (JSON.parse(fs.readFileSync(links.LINKS_FILE, 'utf8')) as { links: { user: string; kind: string }[] }).links.filter(
          (l) => l.user === owner.id && l.kind === 'reset',
        ).length
      : 0;
  const before = linksFor();
  const t0 = performance.now();
  const r = await post('/api/auth/forgot', { email: 'owner@example.com' });
  assert.equal(r.status, 200);
  while (linksFor() === before) {
    assert.ok(performance.now() - t0 < 5000, 'the link was made');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(performance.now() - t0 >= 100, `made ${Math.round(performance.now() - t0)} ms after the request: not right after the answer`);
});

test('reset: the link sets a new password once, every other session ends, this browser is in, a notice follows', async () => {
  await auth.createUser({ email: 'mia@example.com', name: 'Mia Keller', password: 'mias old password', role: 'member' });
  const laptop = { Cookie: cookiesOf(await post('/api/auth/login', { email: 'mia@example.com', password: 'mias old password' })) };
  assert.equal((await request('GET', '/api/auth/me', { headers: laptop })).status, 200);
  const start = await outboxSize();
  await post('/api/auth/forgot', { email: 'Mia@Example.com', lang: 'de' });
  const [mail] = await mailTo('mia@example.com', start);
  assert.equal(mail?.lang, 'de', 'in the language it was asked in');
  const token = tokenIn(mail?.text ?? '', 'rt');
  const peek = await post('/api/auth/reset/peek', { token });
  assert.deepEqual(peek.json(), { email: 'm•••@example.com', expires: peek.json().expires });
  // A password that can't be used doesn't spend the link.
  assert.equal((await post('/api/auth/reset', { token, password: 'short' })).status, 400);
  const done = await post('/api/auth/reset', { token, password: 'mias new password' });
  assert.equal(done.status, 200, done.text);
  const here = { Cookie: cookiesOf(done) };
  assert.equal((await request('GET', '/api/auth/me', { headers: here })).status, 200, 'this browser is signed in');
  assert.equal((await request('GET', '/api/auth/me', { headers: laptop })).status, 401, 'the other session is gone');
  assert.equal((await post('/api/auth/login', { email: 'mia@example.com', password: 'mias old password' })).status, 401);
  assert.equal((await post('/api/auth/login', { email: 'mia@example.com', password: 'mias new password' })).status, 200);
  const again = await post('/api/auth/reset', { token, password: 'another new password' });
  assert.equal(again.status, 410);
  assert.equal(again.json().state, 'used');
  const notice = (await mailTo('mia@example.com', start)).find((m) => m.kind === 'password-changed');
  assert.ok(notice, 'a "your password was changed" notice');
  assert.equal(notice?.lang, 'en', 'notices speak the account’s language (none chosen: English)');
});

test('an expired or unknown reset link says so; guessing is throttled', async () => {
  const user = auth.findUserByEmail('mia@example.com') as User;
  const old = links.issueLink('reset', user.id, user.email, Date.now() - 2 * 3600e3);
  const expired = await post('/api/auth/reset/peek', { token: old.token });
  assert.equal(expired.status, 410);
  assert.equal(expired.json().state, 'expired');
  const unknown = await post('/api/auth/reset/peek', { token: `rt_${'x'.repeat(43)}` });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json().state, 'invalid');
});

// ---------------------------------------------------------------- sign-up (VR_SIGNUP=invite)

/**
 * A sign-up held from before this release: VR_SIGNUP=invite then made the account from the address alone, with the
 * invite's role, using the invite up. Stores may still hold some, until confirmed or swept after a week.
 */
async function heldFromBefore(email: string, name: string, password: string): Promise<User> {
  const id = auth.pendingInvitesFor(email)[0] as string;
  const { user } = await auth.acceptInvite(auth.inviteToken(id) as string, { name, email, password });
  const f = JSON.parse(fs.readFileSync(auth.USERS_FILE, 'utf8')) as { users: User[] };
  const u = f.users.find((x) => x.id === user.id) as User;
  u.unverified = new Date().toISOString();
  u.signup = u.unverified;
  fs.writeFileSync(auth.USERS_FILE, JSON.stringify(f, null, 2));
  return auth.getUser(user.id) as User;
}

/** The invites an admin sees for an address. */
const invitesFor = async (email: string) =>
  (await request('GET', '/api/admin/invites', { headers: ownerHeaders })).json().invites.filter((i: { email: string }) => i.email === email) as {
    status: string;
    role: string;
  }[];

test('sign-up answers the same for an invited address, an existing account and a stranger; the invited get their invite again', async () => {
  const made = await post('/api/admin/invites', { role: 'member', email: 'ida@example.com' }, ownerHeaders);
  assert.equal(made.status, 200, made.text);
  const start = await outboxSize();
  const answers = await Promise.all([
    post('/api/auth/signup', { email: 'ida@example.com', lang: 'en' }),
    post('/api/auth/signup', { name: 'Someone', email: 'owner@example.com', password: 'whatever pass 1', lang: 'en' }),
    post('/api/auth/signup', { email: 'stranger@example.com', lang: 'en' }),
  ]);
  for (const a of answers) {
    assert.equal(a.status, 200, a.text);
    assert.deepEqual(a.json(), { ok: true });
    assert.ok(!cookiesOf(a).includes('vr_session'), 'nobody is signed in by signing up');
    assert.match(cookiesOf(a), /^vr_signup=[\w-]{32}$/, 'every answer marks the browser alike');
  }
  const [invite] = await mailTo('ida@example.com', start);
  assert.equal(invite?.kind, 'invite', 'the invite itself, again');
  assert.equal(`${PUBLIC}/#/invite/${tokenIn(invite?.text ?? '', 'inv')}`, made.json().url, 'with its own link');
  assert.equal((await mailTo('owner@example.com', start)).map((m) => m.kind).join(), 'signup-exists', 'the owner of the address hears');
  assert.equal((await mailTo('stranger@example.com', start)).length, 0, 'an address nobody invited gets no mail');
  assert.equal(auth.findUserByEmail('stranger@example.com'), null);
  assert.equal(auth.findUserByEmail('ida@example.com'), null, 'no account: only the invite’s link makes one');
  assert.deepEqual(
    (await invitesFor('ida@example.com')).map((i) => i.status),
    ['pending'],
  );
  // "Send it again" from the sign-up page sends the invite again too.
  const again = await outboxSize();
  assert.equal((await post('/api/auth/verify/resend', { email: 'ida@example.com' })).status, 200);
  assert.equal((await mailTo('ida@example.com', again)).map((m) => m.kind).join(), 'invite');
});

test('AUTH-1: knowing an invited address gets an outsider nothing, and the invitee keeps the invite and its role', async () => {
  const made = await post('/api/admin/invites', { role: 'admin', email: 'vic@example.com' }, ownerHeaders);
  assert.equal(made.status, 200, made.text);
  const start = await outboxSize();
  // Mallory signs up as the invited address, with her own password and a name of her choosing.
  const signup = await post('/api/auth/signup', { name: 'Mallory', email: 'vic@example.com', password: 'mallorys password', lang: 'en' });
  assert.deepEqual([signup.status, signup.json()], [200, { ok: true }]);
  assert.equal(auth.findUserByEmail('vic@example.com'), null, 'no account was made');
  const login = await post('/api/auth/login', { email: 'vic@example.com', password: 'mallorys password' });
  assert.equal(login.status, 401, 'her password opens nothing');
  // Nothing went anywhere but the invited address, and that is the invite (its link), not a link that confirms a
  // password someone else chose.
  const sent = await mailTo('vic@example.com', start);
  assert.deepEqual(
    sent.map((m) => m.kind),
    ['invite'],
  );
  assert.equal(readOutbox(OUTBOX).slice(start).length, sent.length, 'no mail to anyone else');
  assert.deepEqual(
    (await invitesFor('vic@example.com')).map((i) => [i.status, i.role]),
    [['pending', 'admin']],
  );
  // Vic opens the link (a forwarded copy of it would not do for another address) and is in as admin, with her password.
  const token = tokenIn(sent[0]?.text ?? '', 'inv');
  const forwarded = await post('/api/auth/invite/accept', { token, name: 'Mallory', email: 'mallory@example.com', password: 'mallorys password' });
  assert.equal(forwarded.status, 400, 'the invite is for its address only');
  const joined = await post('/api/auth/invite/accept', { token, name: 'Vic Lund', email: 'vic@example.com', password: 'vics own password' });
  assert.equal(joined.status, 200, joined.text);
  assert.equal(joined.json().user.role, 'admin');
  assert.equal((await post('/api/auth/login', { email: 'vic@example.com', password: 'mallorys password' })).status, 401);
  assert.equal((await post('/api/auth/login', { email: 'vic@example.com', password: 'vics own password' })).status, 200);
});

test('AUTH-1, VA-1: a sign-up held at an invited address (made before this release) can’t send its link elsewhere, and no link takes it away: the inbox decides', async () => {
  await post('/api/admin/invites', { role: 'admin', email: 'una@example.com' }, ownerHeaders);
  const squat = await heldFromBefore('una@example.com', 'Mallory Two', 'mallorys password 2');
  const held = { Cookie: cookiesOf(await post('/api/auth/login', { email: 'una@example.com', password: 'mallorys password 2' })), ...origin };
  const start = await outboxSize();
  const moved = await request('PATCH', '/api/auth/me', { body: { email: 'mallory@example.com', current_password: 'mallorys password 2' }, headers: held });
  assert.equal(moved.status, 403, moved.text);
  assert.equal(auth.getUser(squat.id)?.pending_email, undefined);
  assert.equal((await mailTo('mallory@example.com', start)).length, 0, 'no link to another inbox');
  // The owner invites Una again (a held sign-up blocks no invite), but an invite's link takes no held sign-up away: it
  // could be anyone's link (VA-1). The held sign-up and its session stay.
  const again = await post('/api/admin/invites', { role: 'admin', email: 'una@example.com' }, ownerHeaders);
  assert.equal(again.status, 200, again.text);
  const token = /#\/invite\/(inv_[\w-]+)$/.exec(again.json().url)?.[1] as string;
  const refused = await post('/api/auth/invite/accept', { token, name: 'Una Berg', email: 'una@example.com', password: 'unas own password' });
  assert.equal(refused.status, 400, refused.text);
  assert.equal(auth.findUserByEmail('una@example.com')?.id, squat.id, 'the held sign-up is still there');
  assert.equal((await request('GET', '/api/auth/me', { headers: held })).status, 200);
  // Una takes her address from her inbox: forgot password sends a sign-up nobody confirmed its confirmation (A13
  // VERIFY-4), whose page takes a new password as a reset's does — in with a password of her own, whoever held it
  // signed out.
  const asked = await outboxSize();
  await post('/api/auth/forgot', { email: 'una@example.com' });
  const confirm = tokenIn((await mailTo('una@example.com', asked)).find((m) => m.kind === 'verify')?.text ?? '', 'vt');
  const done = await post('/api/auth/verify', { token: confirm, new_password: 'unas own password' });
  assert.equal(done.status, 200, done.text);
  assert.equal(auth.isGated(auth.getUser(squat.id)), false, 'confirmed by her inbox');
  assert.equal((await request('GET', '/api/auth/me', { headers: held })).status, 401, 'the held session is gone');
  assert.equal((await post('/api/auth/login', { email: 'una@example.com', password: 'mallorys password 2' })).status, 401);
  assert.equal((await post('/api/auth/login', { email: 'una@example.com', password: 'unas own password' })).status, 200);
});

test('A12-D7: an AUTH-1 attack in flight at the upgrade (a held invite sign-up whose confirmation was moved to another inbox) ends at the next start', async () => {
  // Before AUTH-1: Mallory signed up as Dee's invited address (the invite's role came with it), moved the account's
  // address to her own inbox and got that link. The account is still held, its pending address and link hers.
  await post('/api/admin/invites', { role: 'admin', email: 'dee@example.com' }, ownerHeaders);
  const squat = await heldFromBefore('dee@example.com', 'Mallory Three', 'mallorys password 3');
  const f = JSON.parse(fs.readFileSync(auth.USERS_FILE, 'utf8')) as { users: User[] };
  (f.users.find((u) => u.id === squat.id) as User).pending_email = 'mallory3@example.com';
  fs.writeFileSync(auth.USERS_FILE, JSON.stringify(f, null, 2));
  const moved = links.issueLink('verify', squat.id, 'mallory3@example.com');
  const own = links.issueLink('reset', squat.id, 'dee@example.com');
  // The start's pass: no held account keeps an address change (a held account can't ask for one any more).
  assert.equal(auth.forgetHeldChanges(), 1);
  assert.equal(auth.getUser(squat.id)?.pending_email, undefined);
  assert.equal(links.peekLink('verify', moved.token).state, 'used', 'the link in Mallory’s inbox is void');
  assert.equal(links.peekLink('reset', own.token).state, 'ok', 'what went to Dee’s own inbox stays');
  // Mallory knows the password she chose: even with it, her link lets nobody in.
  const tried = await post('/api/auth/verify', { token: moved.token, password: 'mallorys password 3' });
  assert.ok([409, 410].includes(tried.status), `${tried.status} ${tried.text}`);
  assert.ok(auth.isGated(auth.getUser(squat.id)), 'still held: nobody was let in with the invite’s role');
  assert.equal((await post('/api/auth/login', { email: 'mallory3@example.com', password: 'mallorys password 3' })).status, 401);
  assert.equal(auth.forgetHeldChanges(), 0, 'once');
  auth.deleteUser(squat.id);
});

test('a held sign-up can sign in, but reaches nothing until its address is confirmed', async () => {
  // (Held sign-ups come from VR_SIGNUP=open now, and from before this release: one of those, with Ida's invite.)
  const ida = await heldFromBefore('ida@example.com', 'Ida Berg', 'idas password 1');
  ctx.accountMail.verify(ida, ida.email, 'en');
  const login = await post('/api/auth/login', { email: 'ida@example.com', password: 'idas password 1' });
  assert.equal(login.status, 200);
  const held = { Cookie: cookiesOf(login) };
  const me = await request('GET', '/api/auth/me', { headers: held });
  assert.equal(me.status, 200);
  assert.ok(me.json().user.unverified && me.json().user.signup);
  const lib = await request('GET', '/api/library', { headers: held });
  assert.equal(lib.status, 403);
  assert.equal(lib.json().unconfirmed, true);
  assert.equal((await post('/api/auth/token', { email: 'ida@example.com', password: 'idas password 1' })).status, 403, 'no API token either');
  // Every private route but the few that lead to confirming.
  const open = new Set(['/api/auth/status', '/api/auth/me', '/api/auth/logout', '/api/auth/logout-everywhere', '/api/info']);
  const leaks: string[] = [];
  for (const [m, p] of registeredRoutes(app)) {
    if (m !== 'GET' || /[:{]/.test(p) || open.has(p) || !/^\/(api|media|data)\//.test(p) || p === '/api/events') continue;
    const r = await request('GET', p, { headers: held });
    if (r.status !== 403) leaks.push(`${p} → ${r.status}`);
  }
  assert.deepEqual(leaks, []);
});

test('the confirm link lets a held sign-up in and welcomes; used again it says so', async () => {
  const start = 0;
  const [mail] = (await mailTo('ida@example.com', start)).filter((m) => m.kind === 'verify');
  const token = tokenIn(mail?.text ?? '', 'vt');
  // Not the browser that signed up (a sign-up from before this release has none): the page asks for the password the
  // account was made with, or a new one (INV-REV-1, A12-D8); nothing is confirmed until then, the link stays good.
  const asked = await post('/api/auth/verify', { token });
  assert.deepEqual([asked.status, asked.json().state], [409, 'password']);
  assert.ok(auth.isGated(auth.findUserByEmail('ida@example.com')));
  const done = await post('/api/auth/verify', { token, password: 'idas password 1' });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json().released, true);
  assert.equal(done.json().signedIn, true, 'the password proven: this browser is in');
  const here = { Cookie: cookiesOf(done) };
  assert.equal((await request('GET', '/api/library', { headers: here })).status, 200, 'in');
  assert.ok((await mailTo('ida@example.com', start)).some((m) => m.kind === 'welcome'));
  const again = await post('/api/auth/verify', { token });
  assert.equal(again.status, 410);
  assert.deepEqual([again.json().state, again.json().confirmed], ['used', true]);
});

test('a held sign-up keeps its address: a mistyped one is a new sign-up, its link goes nowhere else', async () => {
  await post('/api/admin/invites', { role: 'reviewer', email: 'leo@exmaple.com' }, ownerHeaders);
  await heldFromBefore('leo@exmaple.com', 'Leo Typo', 'leos password 1');
  const held = { Cookie: cookiesOf(await post('/api/auth/login', { email: 'leo@exmaple.com', password: 'leos password 1' })) };
  const start = await outboxSize();
  const fix = await request('PATCH', '/api/auth/me', {
    body: { email: 'leo@example.com', current_password: 'leos password 1' },
    headers: { ...held, ...origin },
  });
  assert.equal(fix.status, 403, fix.text);
  assert.match(fix.json().error, /sign up again/);
  assert.equal((await mailTo('leo@example.com', start)).length, 0, 'no link to another address');
  assert.equal(auth.findUserByEmail('leo@exmaple.com')?.pending_email, undefined);
  assert.throws(() => auth.setPendingEmail((auth.findUserByEmail('leo@exmaple.com') as User).id, 'leo@example.com'), /sign up again/);
  // A name or a picture are its own to change meanwhile.
  assert.equal((await request('PATCH', '/api/auth/me', { body: { name: 'Leo Typo-Fix' }, headers: { ...held, ...origin } })).status, 200);
  auth.deleteUser((auth.findUserByEmail('leo@exmaple.com') as User).id);
});

// ---------------------------------------------------------------- a change of address

test('changing your address: confirmed from the new inbox, the old address hears, sign-in follows', async () => {
  const mia = { Cookie: cookiesOf(await post('/api/auth/login', { email: 'mia@example.com', password: 'mias new password' })) };
  const start = await outboxSize();
  const wrong = await request('PATCH', '/api/auth/me', {
    body: { email: 'mia@studio.example', current_password: 'nope nope nope' },
    headers: { ...mia, ...origin },
  });
  assert.equal(wrong.status, 403, 'the current password is asked');
  const asked = await request('PATCH', '/api/auth/me', {
    body: { email: 'mia@studio.example', current_password: 'mias new password' },
    headers: { ...mia, ...origin },
  });
  assert.equal(asked.status, 200, asked.text);
  assert.equal(asked.json().user.email, 'mia@example.com', 'the old address until the link is used');
  assert.equal(asked.json().user.pending_email, 'mia@studio.example');
  const [mail] = await mailTo('mia@studio.example', start);
  assert.equal(mail?.kind, 'verify-change');
  const done = await post('/api/auth/verify', { token: tokenIn(mail?.text ?? '', 'vt') });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json().signedIn, false, 'a change of address signs nobody in');
  assert.equal((await mailTo('mia@example.com', start)).map((m) => m.kind).join(), 'email-changed');
  assert.equal((await post('/api/auth/login', { email: 'mia@studio.example', password: 'mias new password' })).status, 200);
  assert.equal((await post('/api/auth/login', { email: 'mia@example.com', password: 'mias new password' })).status, 401);
});

test('a pending change can be called off; its link then does nothing', async () => {
  const mia = { Cookie: cookiesOf(await post('/api/auth/login', { email: 'mia@studio.example', password: 'mias new password' })), ...origin };
  const start = await outboxSize();
  await request('PATCH', '/api/auth/me', { body: { email: 'mia@other.example', current_password: 'mias new password' }, headers: mia });
  const [mail] = await mailTo('mia@other.example', start);
  const off = await request('POST', '/api/auth/email/cancel', { headers: mia });
  assert.equal(off.status, 200);
  assert.equal(off.json().user.pending_email, undefined);
  const stale = await post('/api/auth/verify', { token: tokenIn(mail?.text ?? '', 'vt') });
  assert.equal(stale.status, 409);
  assert.equal(auth.findUserByEmail('mia@studio.example')?.email, 'mia@studio.example');
});

test('INV-REV-11: a sign-up nobody confirmed doesn’t keep an address from the account whose owner confirms it there', async () => {
  // Someone signed up with Nora's new address and never confirmed it. Nora's change to it got no link (another account
  // had the address), and a link would have answered 409. The address's own inbox now settles it: Nora's.
  await post('/api/admin/invites', { role: 'reviewer', email: 'nora@new.example' }, ownerHeaders);
  const squat = await heldFromBefore('nora@new.example', 'Not Nora', 'someone elses password');
  await auth.createUser({ email: 'nora@example.com', name: 'Nora Lind', password: 'noras long password', role: 'member' });
  const nora = { Cookie: cookiesOf(await post('/api/auth/login', { email: 'nora@example.com', password: 'noras long password' })), ...origin };
  const start = await outboxSize();
  const asked = await request('PATCH', '/api/auth/me', { body: { email: 'nora@new.example', current_password: 'noras long password' }, headers: nora });
  assert.equal(asked.status, 200, asked.text);
  const [mail] = await mailTo('nora@new.example', start);
  assert.equal(mail?.kind, 'verify-change', 'the link goes to the new inbox');
  const done = await post('/api/auth/verify', { token: tokenIn(mail?.text ?? '', 'vt') });
  assert.equal(done.status, 200, done.text);
  assert.equal(auth.findUserByEmail('nora@new.example')?.name, 'Nora Lind');
  assert.equal(auth.getUser(squat.id), null, 'the unconfirmed sign-up is gone');
  // A confirmed account keeps its address: nobody's change takes it.
  await auth.createUser({ email: 'olaf@example.com', name: 'Olaf Berg', password: 'olafs long password', role: 'member' });
  const start2 = await outboxSize();
  const taken = await request('PATCH', '/api/auth/me', { body: { email: 'olaf@example.com', current_password: 'noras long password' }, headers: nora });
  assert.equal(taken.status, 200, 'the same answer');
  await ctx.mail.flush();
  assert.deepEqual(await mailTo('olaf@example.com', start2), [], 'and no link');
});

test('AUTH-4: a password reset ends the account’s API tokens and connected apps, not only its sessions', async () => {
  const oauth = await import('../../lib/oauth/store.ts');
  const otto = await auth.createUser({ email: 'otto@example.com', name: 'Otto Sand', password: 'ottos first password', role: 'member' });
  // Whoever had the password made a token, and connected an app.
  const { token } = auth.createToken(otto.id, 'made by whoever had the password');
  const bearer = { Authorization: `Bearer ${token}` };
  assert.equal((await request('GET', '/api/library', { headers: bearer })).status, 200);
  const verifier = 'v'.repeat(43);
  const client = {
    client_id: 'https://app.example.com/client',
    kind: 'cimd' as const,
    name: 'App',
    host: 'app.example.com',
    redirect_uris: [],
    auth: 'none' as const,
  };
  const resource = `${PUBLIC}/mcp`;
  const req = oauth.createRequest({
    client,
    redirect_uri: 'https://app.example.com/cb',
    state: null,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    scopes: ['review:read'],
    resource,
  });
  const app = oauth.redeemCode({
    code: oauth.createCode(req, otto),
    client_id: client.client_id,
    redirect_uri: 'https://app.example.com/cb',
    code_verifier: verifier,
  });
  assert.ok(oauth.verifyAccess(app.access_token, resource), 'the app works');
  // Otto resets his password from his inbox: the token and the app stop working too.
  const start = await outboxSize();
  await post('/api/auth/forgot', { email: 'otto@example.com' });
  const reset = tokenIn((await mailTo('otto@example.com', start))[0]?.text ?? '', 'rt');
  assert.equal((await post('/api/auth/reset', { token: reset, password: 'ottos second password' })).status, 200);
  assert.equal((await request('GET', '/api/library', { headers: bearer })).status, 401, 'the token is gone');
  assert.deepEqual(auth.listTokens(otto.id), []);
  assert.equal(oauth.verifyAccess(app.access_token, resource), null, 'and so is the app');
});

test('VA-4: an OAuth code issued before a reset or a new password is worth nothing after it; a new password ends connected apps', async () => {
  const oauth = await import('../../lib/oauth/store.ts');
  const client = {
    client_id: 'https://app.example.com/client',
    kind: 'cimd' as const,
    name: 'App',
    host: 'app.example.com',
    redirect_uris: [],
    auth: 'none' as const,
  };
  const resource = `${PUBLIC}/mcp`;
  const verifier = 'w'.repeat(43);
  const ask = () =>
    oauth.createRequest({
      client,
      redirect_uri: 'https://app.example.com/cb',
      state: null,
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      scopes: ['review:read'],
      resource,
    });
  const redeem = (code: string) => oauth.redeemCode({ code, client_id: client.client_id, redirect_uri: 'https://app.example.com/cb', code_verifier: verifier });
  const rhea = await auth.createUser({ email: 'rhea@example.com', name: 'Rhea Stone', password: 'rheas first password', role: 'member' });
  // A code allowed a moment before the reset (they last a minute): after it, it makes no connection.
  const early = oauth.createCode(ask(), rhea);
  const start = await outboxSize();
  await post('/api/auth/forgot', { email: 'rhea@example.com' });
  const reset = tokenIn((await mailTo('rhea@example.com', start))[0]?.text ?? '', 'rt');
  assert.equal((await post('/api/auth/reset', { token: reset, password: 'rheas second password' })).status, 200);
  assert.throws(
    () => redeem(early),
    (e: Error & { code?: string }) => e.code === 'invalid_grant',
  );
  // The same for a code the epoch moved past without the code store hearing of it (another process changed it).
  const stale = oauth.createCode(ask(), auth.getUser(rhea.id) as User);
  auth.signOutEverywhere(rhea.id);
  assert.throws(() => redeem(stale), /changed since this code was issued/);
  // A Profile password change ends the apps connected before it, and the codes not redeemed yet.
  const app = redeem(oauth.createCode(ask(), auth.getUser(rhea.id) as User));
  assert.ok(oauth.verifyAccess(app.access_token, resource));
  const pending = oauth.createCode(ask(), auth.getUser(rhea.id) as User);
  const session = { Cookie: cookiesOf(await post('/api/auth/login', { email: 'rhea@example.com', password: 'rheas second password' })), ...origin };
  const changed = await request('PATCH', '/api/auth/me', {
    body: { password: 'rheas third password', current_password: 'rheas second password' },
    headers: session,
  });
  assert.equal(changed.status, 200, changed.text);
  assert.equal(oauth.verifyAccess(app.access_token, resource), null, 'the connected app');
  assert.throws(
    () => redeem(pending),
    (e: Error & { code?: string }) => e.code === 'invalid_grant',
  );
  assert.deepEqual(oauth.listApps(rhea.id), []);
});

test('WEB-2: signing out everywhere and a password reset reach the devices: their notifications stop', async () => {
  const push = await import('../../lib/push/index.ts');
  const keys = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
  const device = (user: string, n: string) => push.subscribe({ endpoint: `https://fcm.googleapis.com/fcm/send/${user}-${n}`, keys, user, name: n });
  const pia = await auth.createUser({ email: 'pia.phone@example.com', name: 'Pia Phone', password: 'pias first password', role: 'member' });
  const other = await auth.createUser({ email: 'ole@example.com', name: 'Ole', password: 'oles long password', role: 'member' });
  device(other.id, 'his phone');
  // Pia's phone is lost: from her laptop she signs out everywhere.
  device(pia.id, 'lost phone');
  device(pia.id, 'laptop');
  const laptop = { Cookie: cookiesOf(await post('/api/auth/login', { email: 'pia.phone@example.com', password: 'pias first password' })), ...origin };
  assert.equal(push.countSubs(pia.id), 2);
  assert.equal((await request('POST', '/api/auth/logout-everywhere', { headers: laptop })).status, 200);
  assert.equal(push.countSubs(pia.id), 0, 'no device of hers hears from the server any more');
  assert.equal(push.countSubs(other.id), 1, 'nobody else’s devices are touched');
  // Again with a reset from her inbox.
  device(pia.id, 'new phone');
  const start = await outboxSize();
  await post('/api/auth/forgot', { email: 'pia.phone@example.com' });
  const reset = tokenIn((await mailTo('pia.phone@example.com', start))[0]?.text ?? '', 'rt');
  assert.equal((await post('/api/auth/reset', { token: reset, password: 'pias second password' })).status, 200);
  assert.equal(push.countSubs(pia.id), 0);
  assert.equal(push.countSubs(other.id), 1);
});

test('VA-3: an API token registers no device; any new password ends the account’s devices; signing out everywhere and a reset clear the browser', async () => {
  const push = await import('../../lib/push/index.ts');
  const keys = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
  const subscription = (n: string) => ({ subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/quinn-${n}`, keys }, name: n });
  const quinn = await auth.createUser({ email: 'quinn@example.com', name: 'Quinn Ray', password: 'quinns first password', role: 'member' });
  // A token (an agent, a script) gets no lasting way to the account's notifications: agents have no service worker.
  const { token } = auth.createToken(quinn.id, 'agent');
  const byToken = await request('POST', '/api/push/subscribe', { body: subscription('agent'), headers: { Authorization: `Bearer ${token}` } });
  assert.deepEqual([byToken.status, byToken.json().person], [403, true]);
  assert.equal(push.countSubs(quinn.id), 0);
  // Her laptop does; then she changes her password in Profile: every device of hers goes.
  const laptop = { Cookie: cookiesOf(await post('/api/auth/login', { email: 'quinn@example.com', password: 'quinns first password' })), ...origin };
  const mine = await request('POST', '/api/push/subscribe', { body: subscription('laptop'), headers: laptop });
  assert.equal(mine.status, 200, mine.text);
  push.subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/quinn-phone', keys, user: quinn.id, name: 'phone' });
  assert.equal(push.countSubs(quinn.id), 2);
  const changed = await request('PATCH', '/api/auth/me', {
    body: { password: 'quinns second password', current_password: 'quinns first password' },
    headers: laptop,
  });
  assert.equal(changed.status, 200, changed.text);
  assert.equal(push.countSubs(quinn.id), 0, 'a Profile password change');
  // An admin setting it (one team, no workspaces) too.
  push.subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/quinn-phone', keys, user: quinn.id, name: 'phone' });
  const set = await request('PATCH', `/api/admin/users/${quinn.id}`, { body: { password: 'quinns third password' }, headers: { ...ownerHeaders, ...origin } });
  assert.equal(set.status, 200, set.text);
  assert.equal(push.countSubs(quinn.id), 0, 'an admin’s');
  // Signing out everywhere and a reset tell this browser to drop its cache and storage (never the new session's cookie).
  const again = { Cookie: cookiesOf(await post('/api/auth/login', { email: 'quinn@example.com', password: 'quinns third password' })), ...origin };
  const out = await request('POST', '/api/auth/logout-everywhere', { headers: again });
  assert.equal(out.status, 200);
  assert.equal(out.headers['clear-site-data'], '"cache", "storage"');
  const start = await outboxSize();
  await post('/api/auth/forgot', { email: 'quinn@example.com' });
  const reset = await post('/api/auth/reset', {
    token: tokenIn((await mailTo('quinn@example.com', start))[0]?.text ?? '', 'rt'),
    password: 'quinns fourth password',
  });
  assert.equal(reset.status, 200, reset.text);
  assert.equal(reset.headers['clear-site-data'], '"cache", "storage"');
  assert.match(cookiesOf(reset), /vr_session=/, 'signed in all the same');
});

test('AUTH-3: a new address or password ends the links sent before: a reset link to the old inbox resets nothing', async () => {
  const nils = await auth.createUser({ email: 'nils@example.com', name: 'Nils Berg', password: 'nils first password', role: 'member' });
  const session = { Cookie: cookiesOf(await post('/api/auth/login', { email: 'nils@example.com', password: 'nils first password' })), ...origin };
  // A reset link goes to the old inbox; then Nils moves to a new address and confirms it there.
  const start = await outboxSize();
  await post('/api/auth/forgot', { email: 'nils@example.com' });
  const oldReset = tokenIn((await mailTo('nils@example.com', start))[0]?.text ?? '', 'rt');
  assert.equal((await post('/api/auth/reset/peek', { token: oldReset })).status, 200, 'a working link so far');
  const moved = await request('PATCH', '/api/auth/me', { body: { email: 'nils@new.example', current_password: 'nils first password' }, headers: session });
  assert.equal(moved.status, 200, moved.text);
  const confirm = (await mailTo('nils@new.example', start)).find((m) => m.kind === 'verify-change');
  assert.equal((await post('/api/auth/verify', { token: tokenIn(confirm?.text ?? '', 'vt') })).status, 200);
  // Whoever holds the old inbox can't set the password any more.
  const taken = await post('/api/auth/reset', { token: oldReset, password: 'taken over now!' });
  assert.ok([409, 410].includes(taken.status), `${taken.status} ${taken.text}`);
  assert.equal((await post('/api/auth/login', { email: 'nils@new.example', password: 'taken over now!' })).status, 401);
  assert.equal((await post('/api/auth/login', { email: 'nils@new.example', password: 'nils first password' })).status, 200);
  // Even a link to the current address that was out before a change goes: an admin's change of address…
  links.issueLink('reset', nils.id, 'nils@new.example');
  const beforeAdmin = links.issueLink('verify', nils.id, 'nils@new.example');
  const reset1 = links.issueLink('reset', nils.id, 'nils@new.example');
  await auth.updateUser(nils.id, { email: 'nils@third.example' });
  assert.equal(links.peekLink('reset', reset1.token).state, 'used', 'voided with the address');
  assert.equal(links.peekLink('verify', beforeAdmin.token).state, 'used');
  // A new password (in Profile, and the admin route alike: both go through updateUser) ends the confirmations sent
  // before; a reset link to the address the account has stays, so a session holder can't keep the person's recovery
  // dead by changing the password (the inbox could ask for another link anyway). Only a reset spends it.
  const reset2 = links.issueLink('reset', nils.id, 'nils@third.example');
  const verify2 = links.issueLink('verify', nils.id, 'nils@third.example');
  const relog = { Cookie: cookiesOf(await post('/api/auth/login', { email: 'nils@third.example', password: 'nils first password' })), ...origin };
  const changed = await request('PATCH', '/api/auth/me', {
    body: { password: 'nils second password', current_password: 'nils first password' },
    headers: relog,
  });
  assert.equal(changed.status, 200, changed.text);
  assert.equal(links.peekLink('verify', verify2.token).state, 'used');
  assert.equal(links.peekLink('reset', reset2.token).state, 'ok');
  assert.equal((await post('/api/auth/reset', { token: reset2.token, password: 'nils third password' })).status, 200);
  assert.equal(links.peekLink('reset', reset2.token).state, 'used');
});

// ---------------------------------------------------------------- invites by email

test('an invite is emailed, sent again, and once revoked its link is dead', async () => {
  const start = await outboxSize();
  const made = await post('/api/admin/invites', { role: 'reviewer', name: 'Noa', email: 'noa@example.com', send: true, lang: 'de' }, ownerHeaders);
  assert.equal(made.status, 200, made.text);
  assert.equal(made.json().sent, true);
  assert.equal(made.json().invite.sent_count, 1);
  const [mail] = await mailTo('noa@example.com', start);
  assert.equal(mail?.kind, 'invite');
  assert.equal(mail?.lang, 'de');
  assert.match(mail?.subject ?? '', /^Eine Einladung zu Lampo auf review\.test$/);
  assert.ok(mail?.text.includes('Von einem Konto namens „Olivia Hart“.'), mail?.text);
  const token = tokenIn(mail?.text ?? '', 'inv');
  assert.equal(`${PUBLIC}/#/invite/${token}`, made.json().url, 'the emailed link is the copied link');
  const again = await post(`/api/admin/invites/${made.json().invite.id}/send`, {}, ownerHeaders);
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json().invite.sent_count, 2);
  assert.equal((await mailTo('noa@example.com', start)).length, 2);
  assert.equal((await request('DELETE', `/api/admin/invites/${made.json().invite.id}`, { headers: { ...ownerHeaders, ...origin } })).status, 200);
  assert.equal((await post('/api/auth/invite/peek', { token })).status, 404);
  assert.equal((await post(`/api/admin/invites/${made.json().invite.id}/send`, {}, ownerHeaders)).status, 404, 'a revoked invite is not sent again');
  assert.equal((await post('/api/admin/invites', { role: 'reviewer', send: true }, ownerHeaders)).status, 400, 'sending needs an address');
});

test('an invite emailed and accepted: in at once; an invite without an address: in, and the address gets a link', async () => {
  const made = await post('/api/admin/invites', { role: 'member', email: 'kai@example.com', send: true }, ownerHeaders);
  const [mail] = (await mailTo('kai@example.com')).filter((m) => m.kind === 'invite');
  const token = tokenIn(mail?.text ?? '', 'inv');
  assert.ok(made.json().url.endsWith(token));
  const joined = await post('/api/auth/invite/accept', { token, name: 'Kai Lund', email: 'kai@example.com', password: 'kais password 1' });
  assert.equal(joined.status, 200, joined.text);
  assert.equal(joined.json().user.unverified, undefined, 'the inviter vouched for the address');

  const open = await post('/api/admin/invites', { role: 'reviewer' }, ownerHeaders);
  const start = await outboxSize();
  const anyone = await post('/api/auth/invite/accept', {
    token: /#\/invite\/(inv_[\w-]+)$/.exec(open.json().url)?.[1],
    name: 'Ana Ruiz',
    email: 'ana@example.com',
    password: 'anas password 1',
  });
  assert.equal(anyone.status, 200, anyone.text);
  assert.ok(anyone.json().user.unverified, 'nobody vouched for the address');
  assert.ok(!auth.isGated(anyone.json().user), 'but the person is in');
  const [verify] = await mailTo('ana@example.com', start);
  assert.equal(verify?.kind, 'verify');
  assert.match(verify?.text ?? '', /You joined review\.test/);
  assert.equal((await request('GET', '/api/library', { headers: { Cookie: cookiesOf(anyone) } })).status, 200);
});

// ---------------------------------------------------------------- notices

test('notices: disabled, removed, and a sign-in from a new browser when asked for', async () => {
  await auth.createUser({ email: 'zoe@example.com', name: 'Zoe', password: 'zoes password 1', role: 'member' });
  const zoe = auth.findUserByEmail('zoe@example.com') as User;
  const start = await outboxSize();
  const first = await post(
    '/api/auth/login',
    { email: 'zoe@example.com', password: 'zoes password 1' },
    { 'User-Agent': 'Mozilla/5.0 (Macintosh) Chrome/140 Safari/537' },
  );
  assert.equal((await mailTo('zoe@example.com', start)).length, 0, 'sign-in alerts are off until chosen');
  const zoeHeaders = { Cookie: cookiesOf(first), ...origin };
  assert.equal((await request('PATCH', '/api/auth/me', { body: { prefs: { signin_alerts: true } }, headers: zoeHeaders })).status, 200);
  // The same browser (its device cookie): nothing. Another one: an alert.
  await post('/api/auth/login', { email: 'zoe@example.com', password: 'zoes password 1' }, { Cookie: cookiesOf(first) });
  assert.equal((await mailTo('zoe@example.com', start)).length, 0);
  await post(
    '/api/auth/login',
    { email: 'zoe@example.com', password: 'zoes password 1' },
    { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Version/18.0 Mobile Safari/604.1' },
  );
  const alert = (await mailTo('zoe@example.com', start)).find((m) => m.kind === 'new-sign-in');
  assert.match(alert?.text ?? '', /Safari on iPhone/);
  await request('PATCH', `/api/admin/users/${zoe.id}`, { body: { disabled: true }, headers: { ...ownerHeaders, ...origin } });
  await request('DELETE', `/api/admin/users/${zoe.id}`, { headers: { ...ownerHeaders, ...origin } });
  const kinds = (await mailTo('zoe@example.com', start)).map((m) => m.kind);
  assert.deepEqual(kinds, ['new-sign-in', 'account-disabled', 'account-removed']);
});

// ---------------------------------------------------------------- limits, logs, the seam

test('asking for links is limited per email and per address; guessing links is throttled', async () => {
  const codes: number[] = [];
  for (let i = 0; i < 7; i++) codes.push((await post('/api/auth/forgot', { email: 'flood@example.com' })).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429], 'five an hour for one address, from anywhere');
  const one = { 'X-Forwarded-For': '203.0.113.7' };
  const fromOne: number[] = [];
  for (let i = 0; i < 21; i++) fromOne.push((await post('/api/auth/forgot', { email: `p${i}@example.com` }, one)).status);
  assert.equal(fromOne.filter((c) => c === 429).length, 1, 'twenty in 15 minutes from one address');
  const guess = { 'X-Forwarded-For': '203.0.113.8' };
  const guesses: number[] = [];
  for (let i = 0; i < 31; i++) guesses.push((await post('/api/auth/reset/peek', { token: `rt_${'y'.repeat(43)}` }, guess)).status);
  assert.deepEqual([guesses[29], guesses[30]], [404, 429], 'thirty wrong links, then a wait');
  assert.equal((await post('/api/auth/verify', { token: `vt_${'y'.repeat(43)}` }, guess)).status, 429, 'for every kind of link');
});

test('no log line names an address or carries a link', async () => {
  await ctx.mail.flush();
  const mailLines = logged.filter((l) => l.startsWith('mail:'));
  assert.ok(mailLines.length > 10, `${mailLines.length} mail lines`);
  for (const l of logged) {
    assert.ok(!/[\w.+-]+@[\w-]+\.[\w.]+/.test(l), `an address in the log: ${l}`);
    assert.ok(!/\b(vt|rt|inv)_[\w-]{20,}/.test(l), `a token in the log: ${l}`);
  }
});

test('sign-ups nobody confirmed within a week are removed', async () => {
  await post('/api/admin/invites', { role: 'reviewer', email: 'late@example.com' }, ownerHeaders);
  await heldFromBefore('late@example.com', 'Late Larry', 'larrys password');
  assert.ok(auth.findUserByEmail('late@example.com'));
  assert.equal(auth.sweepUnconfirmed(7, Date.now() + 6 * 86400e3), 0);
  assert.equal(auth.sweepUnconfirmed(7, Date.now() + 8 * 86400e3), 1);
  assert.equal(auth.findUserByEmail('late@example.com'), null);
});

test('INV-REV-10: a held sign-up asked for a new link is kept a week from that link, not from its sign-up', async () => {
  // Signed up six and a half days ago, a new link asked for today: the sweep took the account the next morning, and
  // the link in the inbox led nowhere. The week now counts from the newest link sent to the account's address.
  await post('/api/admin/invites', { role: 'reviewer', email: 'slow@example.com' }, ownerHeaders);
  const held = await heldFromBefore('slow@example.com', 'Slow Sam', 'sams password');
  const f = JSON.parse(fs.readFileSync(auth.USERS_FILE, 'utf8')) as { users: User[] };
  const u = f.users.find((x) => x.id === held.id) as User;
  u.signup = new Date(Date.now() - 6.5 * 86400e3).toISOString();
  fs.writeFileSync(auth.USERS_FILE, JSON.stringify(f, null, 2));
  const made = () =>
    fs.existsSync(links.LINKS_FILE)
      ? (JSON.parse(fs.readFileSync(links.LINKS_FILE, 'utf8')) as { links: { user: string; kind: string }[] }).links.filter(
          (l) => l.user === held.id && l.kind === 'verify',
        ).length
      : 0;
  const before = made();
  assert.equal((await post('/api/auth/verify/resend', { email: 'slow@example.com' })).status, 200);
  await ctx.mail.flush();
  assert.equal(made(), before + 1, 'a new link');
  assert.equal(auth.sweepUnconfirmed(7, Date.now() + 86400e3), 0, 'kept while its new link is a day old');
  assert.ok(auth.getUser(held.id));
  assert.equal(auth.sweepUnconfirmed(7, Date.now() + 8 * 86400e3), 1, 'gone a week after its newest link');
});

test('open sign-up goes through the onSignup seam: it runs once the address is confirmed, never before', async () => {
  const calls: string[] = [];
  let fail = true;
  const openCtx = createContext({
    cfg: { ...loadConfig(), signup: 'open' },
    token: 'unused',
    onSignup: ({ user }) => {
      calls.push(user.email);
      if (fail) throw new Error('workspace store is busy');
    },
  });
  const openApp = createApp(openCtx);
  const s = http.createServer(openApp);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const req = client((s.address() as AddressInfo).port, { Connection: 'close', Host: 'review.test', ...origin });
  try {
    const made = await req('POST', '/api/auth/signup', { body: { name: 'Pia Open', email: 'pia@example.com', password: 'pias password 1' } });
    assert.equal(made.status, 200, made.text);
    assert.deepEqual(calls, [], 'not at sign-up');
    const pia = auth.findUserByEmail('pia@example.com') as User;
    assert.equal(pia.role, 'reviewer', 'the least role until the seam gives them their own workspace');
    await openCtx.mail.flush();
    const mail = readOutbox(OUTBOX).filter((m) => m.to === 'pia@example.com' && m.kind === 'verify')[0];
    const token = tokenIn(mail?.text ?? '', 'vt');
    // (in the browser that signed up: its mark)
    const mark = { Cookie: cookiesOf(made) };
    const broken = await req('POST', '/api/auth/verify', { body: { token }, headers: mark });
    assert.equal(broken.status, 500);
    assert.deepEqual(calls, ['pia@example.com']);
    assert.ok(auth.isGated(auth.findUserByEmail('pia@example.com')), 'still held: the seam failed');
    fail = false;
    const ok = await req('POST', '/api/auth/verify', { body: { token }, headers: mark });
    assert.equal(ok.status, 200, 'the link was not used up by the failure');
    assert.deepEqual(calls, ['pia@example.com', 'pia@example.com']);
    assert.equal(auth.isGated(auth.findUserByEmail('pia@example.com')), false);
  } finally {
    openCtx.mail.stop();
    s.close();
  }
  // Without a seam an open sign-up is refused outright (and the server would not have started).
  const noSeam = createContext({ cfg: { ...loadConfig(), signup: 'open' }, token: 'unused', onSignup: null });
  const s2 = http.createServer(createApp(noSeam));
  await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
  const req2 = client((s2.address() as AddressInfo).port, { Connection: 'close', Host: 'review.test', ...origin });
  assert.equal((await req2('POST', '/api/auth/signup', { body: { name: 'Q', email: 'q@example.com', password: 'qs password 12' } })).status, 404);
  noSeam.mail.stop();
  s2.close();
});

test('WEB-1: a confirm link signs in the browser that signed up, nobody else, and never over someone else’s session', async () => {
  const openCtx = createContext({ cfg: { ...loadConfig(), signup: 'open' }, token: 'unused', onSignup: () => {} });
  const s = http.createServer(createApp(openCtx));
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const req = client((s.address() as AddressInfo).port, { Connection: 'close', Host: 'review.test', ...origin });
  const signUp = async (email: string, name: string) => {
    const r = await req('POST', '/api/auth/signup', { body: { name, email, password: 'a long password 1' } });
    assert.equal(r.status, 200, r.text);
    return cookiesOf(r);
  };
  const linkTo = async (email: string) => {
    await openCtx.mail.flush();
    return tokenIn(readOutbox(OUTBOX).filter((m) => m.to === email && m.kind === 'verify')[0]?.text ?? '', 'vt');
  };
  try {
    // Bea signs up in her browser (it gets its cookie; nobody is signed in).
    const beaBrowser = await signUp('bea@example.com', 'Bea Open');
    assert.match(beaBrowser, /^vr_signup=/);
    const token = await linkTo('bea@example.com');
    // The owner, signed in here, opens Bea's link (sent to her, say, or planted on a page): refused, the owner stays
    // signed in as the owner, Bea stays held and her link still works.
    const swapped = await req('POST', '/api/auth/verify', { body: { token }, headers: ownerHeaders });
    assert.equal(swapped.status, 409, swapped.text);
    assert.equal(swapped.json().state, 'other');
    assert.equal(swapped.headers['set-cookie'], undefined, 'no session of Bea’s here');
    assert.equal((await request('GET', '/api/auth/me', { headers: ownerHeaders })).json().user.email, 'owner@example.com');
    assert.ok(auth.isGated(auth.findUserByEmail('bea@example.com')));
    // A browser where nobody is signed in and that didn't sign up: nothing is confirmed until the password the account
    // was made with is typed (or a new one chosen: INV-REV-1, A12-D8); then this browser is in.
    const elsewhere = await req('POST', '/api/auth/verify', { body: { token } });
    assert.deepEqual([elsewhere.status, elsewhere.json().state], [409, 'password']);
    assert.ok(!cookiesOf(elsewhere).includes('vr_session'));
    assert.ok(auth.isGated(auth.findUserByEmail('bea@example.com')));
    const typed = await req('POST', '/api/auth/verify', { body: { token, password: 'a long password 1' } });
    assert.equal(typed.status, 200, typed.text);
    assert.deepEqual([typed.json().released, typed.json().signedIn], [true, true]);
    // Cid's own browser opens Cid's link: signed in there.
    const cidBrowser = await signUp('cid@example.com', 'Cid Open');
    const own = await req('POST', '/api/auth/verify', { body: { token: await linkTo('cid@example.com') }, headers: { Cookie: cidBrowser } });
    assert.equal(own.status, 200, own.text);
    assert.equal(own.json().signedIn, true);
    assert.match(cookiesOf(own), /vr_session=/);
    // A reset link signs its browser in too: never over someone else's session either.
    const bea = auth.findUserByEmail('bea@example.com') as User;
    const reset = links.issueLink('reset', bea.id, bea.email);
    const overOwner = await req('POST', '/api/auth/reset', { body: { token: reset.token, password: 'beas new password' }, headers: ownerHeaders });
    assert.equal(overOwner.status, 409, overOwner.text);
    assert.equal(links.peekLink('reset', reset.token).state, 'ok', 'the link is not spent');
  } finally {
    openCtx.mail.stop();
    s.close();
  }
});

test('sign-up is off by default', async () => {
  const off = createContext({ cfg: { ...loadConfig(), signup: 'off' }, token: 'unused' });
  const s = http.createServer(createApp(off));
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const req = client((s.address() as AddressInfo).port, { Connection: 'close', Host: 'review.test', ...origin });
  assert.equal((await req('POST', '/api/auth/signup', { body: { name: 'R', email: 'r@example.com', password: 'rs password 123' } })).status, 404);
  off.mail.stop();
  s.close();
});
