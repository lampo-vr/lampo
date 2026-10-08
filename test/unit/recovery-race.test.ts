// A change asked for in a session that ends before the change is saved — the person resets the password, signs out
// everywhere, or the account is disabled — changes nothing: no password, no address waiting for its link (and no link
// mailed), no fresh session, no API token, invite or notification device, no deleted account; the recovered password
// keeps working and the person's new session goes on. lib/auth.ts checks the request's access (its session's epoch and
// id) inside the lock that saves the change, after every await: the current password checked, the new one hashed, the
// body read. A reset and "sign out everywhere" also call off an address change still waiting for its link. And a reset
// link the person asked for outlives a password changed in a session, so whoever holds a session can't keep the
// person's recovery dead; those changes are capped per account.
//
// The awaits are held two ways: crypto.scrypt is stood in front of before lib/auth.ts wraps it (the hash is computed
// for real, only its result waits, picked by the password it hashes), and a request's body is sent only once the test
// says so (its headers went first: the server identified the caller then).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { after, mock, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';
import type { Reply } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
// Behind a proxy on this machine: each request comes from its own address, so no per-address limit is reached by the
// file itself.
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_TRUST_PROXY: 'loopback' } });

// The result of the next scrypt over a given password waits for the test (it is computed meanwhile).
const realScrypt = crypto.scrypt;
const armed = new Map<string, { reached: () => void; go: Promise<void> }>();
mock.method(crypto, 'scrypt', (...args: unknown[]) => {
  const done = args.pop() as (...result: unknown[]) => void;
  const held = typeof args[0] === 'string' ? armed.get(args[0]) : undefined;
  if (held) armed.delete(args[0] as string);
  Reflect.apply(realScrypt, crypto, [
    ...args,
    (...result: unknown[]) => {
      if (!held) return done(...result);
      held.reached();
      void held.go.then(() => done(...result));
    },
  ]);
});
function holdScryptOf(password: string): { reached: Promise<void>; release: () => void } {
  let reached = () => {};
  let release = () => {};
  const at = new Promise<void>((r) => {
    reached = r;
  });
  armed.set(password.normalize('NFKC'), { reached, go: new Promise<void>((r) => (release = r)) });
  return { reached: at, release };
}

const auth = await import('../../lib/auth.ts');
const links = await import('../../lib/accountLinks.ts');
const oauth = await import('../../lib/oauth/store.ts');
const push = await import('../../lib/push/index.ts');
const { readOutbox } = await import('../../lib/mail/index.ts');
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
type User = import('../../lib/auth.ts').User;

// The server identified a held request (its headers are in, its body isn't): the test goes on from there.
const context = createContext({ cfg: loadConfig(), token: 'unused' });
const identified = new Map<string, () => void>();
const identify = context.identify;
context.identify = (req, o) => {
  const a = identify(req, o);
  const key = req.headers['x-held'];
  if (typeof key === 'string') identified.get(key)?.();
  return a;
};
const HOST = { Host: 'review.test', Origin: PUBLIC };
const { ctx, port, request } = await startApp({ ctx: context, headers: { Connection: 'close', ...HOST } });
after(() => ctx.mail.stop());
const OUTBOX = path.join(dir, 'cache', 'outbox');

const OLD = 'the old password';
const RECOVERED = 'the recovered password';
const OTHER = 'the other party’s password';

let n = 0;
const somewhere = () => ({ 'X-Forwarded-For': `198.51.100.${(n++ % 250) + 1}` });
/** The session cookie an answer set ('' for none), ready for a Cookie header. */
const cookieOf = (r: Reply) =>
  [r.headers['set-cookie']]
    .flat()
    .filter(Boolean)
    .map((c) => String(c).split(';')[0])
    .filter((c) => /vr_session=./.test(c))
    .join('; ');
const post = (url: string, body: unknown, cookie = '') => request('POST', url, { body, headers: { ...somewhere(), ...(cookie ? { Cookie: cookie } : {}) } });
const patch = (url: string, body: unknown, cookie: string) => request('PATCH', url, { body, headers: { ...somewhere(), Cookie: cookie } });
const me = (cookie: string) => request('GET', '/api/auth/me', { headers: { ...somewhere(), Cookie: cookie } });
const login = (email: string, password: string) => post('/api/auth/login', { email, password });
async function mailTo(to: string, kind?: string) {
  await ctx.mail.flush();
  return readOutbox(OUTBOX).filter((m) => m.to === to && (!kind || m.kind === kind));
}
async function linkMailed(to: string, kind: 'reset' | 'verify') {
  const m = (await mailTo(to)).filter((x) => String(x.kind).startsWith(kind)).at(-1);
  return new RegExp(`#/(?:verify|reset)/(${kind === 'reset' ? 'rt' : 'vt'}_[\\w-]+)`).exec(m?.text ?? '')?.[1] as string;
}
/** The person recovers the account from another browser: forgot → the mailed link → a new password. Their new session. */
async function recover(email: string, password = RECOVERED): Promise<string> {
  assert.equal((await post('/api/auth/forgot', { email })).status, 200);
  const token = await linkMailed(email, 'reset');
  assert.ok(token, 'a reset link was mailed');
  const r = await post('/api/auth/reset', { token, password });
  assert.equal(r.status, 200, r.text);
  return cookieOf(r);
}
/** An account and a session of it (the other party's, in these tests). */
async function account(email: string, role: 'owner' | 'member' = 'member'): Promise<{ u: User; cookie: string }> {
  const u = await auth.createUser({ email, name: email.split('@')[0] as string, password: OLD, role });
  ctx.setup.token = null;
  const r = await login(email, OLD);
  assert.equal(r.status, 200, r.text);
  return { u, cookie: cookieOf(r) };
}

/** A request whose headers go now and whose body only on `send()`; `identified` once the server knows who sent it. */
function heldBody(method: string, url: string, body: unknown, cookie: string): { identified: Promise<void>; send: () => Promise<Reply> } {
  const key = String(++n);
  const data = Buffer.from(JSON.stringify(body));
  const known = new Promise<void>((r) => identified.set(key, r));
  let end = () => {};
  const reply = new Promise<Reply>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: url,
        headers: { ...HOST, ...somewhere(), Cookie: cookie, 'Content-Type': 'application/json', 'Content-Length': data.length, 'X-Held': key },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          text += d;
        });
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, text, json: () => JSON.parse(text) }));
      },
    );
    req.on('error', reject);
    req.flushHeaders();
    end = () => req.end(data);
  });
  return {
    identified: known,
    send: () => {
      end();
      return reply;
    },
  };
}

/** After a refused change: the recovered password works, the other party's doesn't, and no session came of it. */
async function recoveryHolds(email: string, refused: Reply, victim: string, other = OTHER) {
  assert.equal(refused.status, 401, refused.text);
  assert.equal(cookieOf(refused), '', 'a refused change mints no session');
  assert.equal((await login(email, RECOVERED)).status, 200, 'the recovered password works');
  assert.equal((await login(email, other)).status, 401, 'the other party’s does not');
  assert.equal((await me(victim)).status, 200, 'the person’s new session goes on');
}

// ---------------------------------------------------------------- a password change in flight

for (const [route, window] of [
  ['Profile', 'the current password’s check'],
  ['Profile', 'hashing the new password'],
  ['the admin route on yourself', 'the current password’s check'],
  ['the admin route on yourself', 'hashing the new password'],
] as const)
  test(`${route}: a password change held in ${window} while the person resets changes nothing`, async () => {
    const email = `${route === 'Profile' ? 'p' : 'a'}${window.startsWith('the') ? 1 : 2}@example.com`;
    const { u, cookie } = await account(email, 'owner');
    const hold = holdScryptOf(window.startsWith('the current') ? OLD : OTHER);
    const url = route === 'Profile' ? '/api/auth/me' : `/api/admin/users/${u.id}`;
    const pending = patch(url, { current_password: OLD, password: OTHER }, cookie);
    await hold.reached;
    const victim = await recover(email);
    const notices = (await mailTo(email, 'password-changed')).length;
    assert.equal((await me(cookie)).status, 401, 'the reset ended the old session');
    const epoch = auth.getUser(u.id)?.epoch;
    hold.release();
    await recoveryHolds(email, await pending, victim);
    assert.equal(auth.getUser(u.id)?.epoch, epoch, 'nothing moved the account on');
    assert.equal((await mailTo(email, 'password-changed')).length, notices, 'no notice of a change that never happened');
  });

test('sign out everywhere while a Profile password change is being hashed: the change is refused, no session comes of it', async () => {
  const email = 'everywhere@example.com';
  const { u, cookie: other } = await account(email);
  const own = cookieOf(await login(email, OLD));
  const hold = holdScryptOf(OTHER);
  const pending = patch('/api/auth/me', { current_password: OLD, password: OTHER }, other);
  await hold.reached;
  assert.equal((await post('/api/auth/logout-everywhere', {}, own)).status, 200);
  const epoch = auth.getUser(u.id)?.epoch;
  hold.release();
  const r = await pending;
  assert.equal(r.status, 401, r.text);
  assert.equal(cookieOf(r), '');
  assert.equal(auth.getUser(u.id)?.epoch, epoch);
  assert.equal((await login(email, OTHER)).status, 401);
  assert.equal((await login(email, OLD)).status, 200, 'the password stays what it was');
});

test('an account disabled while its own password change is being hashed stays as it was: disabled, its password unchanged', async () => {
  const { u, cookie } = await account('disabled@example.com');
  const stored = auth.getUser(u.id)?.password;
  const hold = holdScryptOf(OTHER);
  const pending = patch('/api/auth/me', { current_password: OLD, password: OTHER }, cookie);
  await hold.reached;
  await auth.updateUser(u.id, { disabled: true });
  hold.release();
  const r = await pending;
  assert.equal(r.status, 401, r.text);
  assert.equal(cookieOf(r), '');
  assert.ok(auth.getUser(u.id)?.disabled);
  assert.equal(auth.getUser(u.id)?.password, stored);
});

// ---------------------------------------------------------------- an address change

test('Profile: an address change held in the current password’s check while the person resets waits for nothing and mails nothing', async () => {
  const email = 'mover@example.com';
  const outsider = 'outsider@example.net';
  const { u, cookie } = await account(email, 'owner');
  const hold = holdScryptOf(OLD);
  const pending = patch('/api/auth/me', { current_password: OLD, email: outsider }, cookie);
  await hold.reached;
  const victim = await recover(email);
  hold.release();
  const r = await pending;
  assert.equal(r.status, 401, r.text);
  assert.equal(auth.getUser(u.id)?.pending_email, undefined);
  assert.deepEqual(await mailTo(outsider), [], 'no link to the other inbox');
  assert.equal(auth.getUser(u.id)?.email, email);
  assert.equal((await me(victim)).status, 200);
});

test('an address change waiting for its link is called off by a reset, and by signing out everywhere: its link confirms nothing', async () => {
  const email = 'waiting@example.com';
  const { u, cookie } = await account(email);
  assert.equal((await patch('/api/auth/me', { current_password: OLD, email: 'elsewhere1@example.net' }, cookie)).status, 200);
  const first = await linkMailed('elsewhere1@example.net', 'verify');
  assert.ok(first);
  await recover(email);
  assert.equal(auth.getUser(u.id)?.pending_email, undefined, 'a reset calls it off');
  assert.notEqual((await post('/api/auth/verify', { token: first })).status, 200);
  // again, signed out everywhere (no new password)
  const session = cookieOf(await login(email, RECOVERED));
  assert.equal((await patch('/api/auth/me', { current_password: RECOVERED, email: 'elsewhere2@example.net' }, session)).status, 200);
  const second = await linkMailed('elsewhere2@example.net', 'verify');
  assert.ok(second);
  assert.equal((await post('/api/auth/logout-everywhere', {}, session)).status, 200);
  assert.equal(auth.getUser(u.id)?.pending_email, undefined, 'signing out everywhere calls it off');
  assert.notEqual((await post('/api/auth/verify', { token: second })).status, 200);
  assert.equal(auth.getUser(u.id)?.email, email);
  // a change asked for together with a new password waits under the new one
  const third = cookieOf(await login(email, RECOVERED));
  const both = await patch('/api/auth/me', { current_password: RECOVERED, password: 'a password of their own', email: 'elsewhere3@example.net' }, third);
  assert.equal(both.status, 200, both.text);
  assert.equal(auth.getUser(u.id)?.pending_email, 'elsewhere3@example.net');
  assert.equal((await post('/api/auth/verify', { token: await linkMailed('elsewhere3@example.net', 'verify') })).status, 200);
  assert.equal(auth.getUser(u.id)?.email, 'elsewhere3@example.net');
});

// ---------------------------------------------------------------- recovery can't be kept dead

test('a reset link outlives password changes made in a session, which are capped: whoever holds one can’t keep recovery dead', async () => {
  const email = 'looped@example.com';
  const { cookie } = await account(email);
  // The person asks for a link; meanwhile the session holder changes the password again and again.
  assert.equal((await post('/api/auth/forgot', { email })).status, 200);
  const token = await linkMailed(email, 'reset');
  let session = cookie;
  let password = OLD;
  for (let i = 1; i <= 5; i++) {
    const next = `changed for the ${i}. time`;
    const r = await patch('/api/auth/me', { current_password: password, password: next }, session);
    assert.equal(r.status, 200, r.text);
    session = cookieOf(r);
    password = next;
    assert.equal(links.peekLink('reset', token).state, 'ok', 'the person’s link still works');
  }
  const sixth = await patch('/api/auth/me', { current_password: password, password: 'once more' }, session);
  assert.equal(sixth.status, 429, sixth.text);
  assert.ok(Number(sixth.headers['retry-after']) > 0);
  // The person's link resets the account, and the session holder is out.
  const reset = await post('/api/auth/reset', { token, password: RECOVERED });
  assert.equal(reset.status, 200, reset.text);
  assert.equal((await me(session)).status, 401);
  assert.equal((await login(email, RECOVERED)).status, 200);
  assert.equal((await login(email, password)).status, 401);
  // A reset spends the link, and any other reset link out.
  assert.equal(links.peekLink('reset', token).state, 'used');
});

// ---------------------------------------------------------------- what else a session makes that recovery ends

test('an API token asked for by a session whose body arrives after the reset is never made', async () => {
  const email = 'tokens@example.com';
  const { u, cookie } = await account(email);
  const asked = heldBody('POST', '/api/auth/tokens', { name: 'kept' }, cookie);
  await asked.identified;
  await recover(email);
  const r = await asked.send();
  assert.equal(r.status, 401, r.text);
  assert.deepEqual(auth.listTokens(u.id), []);
});

test('an invite asked for by an admin’s session whose body arrives after signing out everywhere is never made', async () => {
  const email = 'inviter@example.com';
  const { u, cookie } = await account(email, 'owner');
  const asked = heldBody('POST', '/api/admin/invites', { role: 'admin', email: 'friend@example.net' }, cookie);
  await asked.identified;
  auth.signOutEverywhere(u.id);
  const r = await asked.send();
  assert.equal(r.status, 401, r.text);
  assert.equal(
    auth.listInvites().some((i) => i.email === 'friend@example.net'),
    false,
  );
});

test('a device subscribed by a session whose body arrives after signing out everywhere gets no notifications', async () => {
  const { u, cookie } = await account('device@example.com');
  const keys = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
  const asked = heldBody(
    'POST',
    '/api/push/subscribe',
    { subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${u.id}`, keys }, name: 'phone' },
    cookie,
  );
  await asked.identified;
  auth.signOutEverywhere(u.id);
  const r = await asked.send();
  assert.equal(r.status, 401, r.text);
  assert.equal(push.countSubs(u.id), 0);
});

test('deleting the account with a password checked while the person resets deletes nothing', async () => {
  const email = 'kept@example.com';
  const { u, cookie } = await account(email);
  const hold = holdScryptOf(OLD);
  const pending = post('/api/auth/me/delete', { password: OLD }, cookie);
  await hold.reached;
  const victim = await recover(email);
  hold.release();
  const r = await pending;
  assert.equal(r.status, 401, r.text);
  assert.ok(auth.getUser(u.id), 'the account is still there');
  assert.equal((await me(victim)).status, 200);
});

// Held before this check too (a code carries the epoch it was allowed under), kept here with its siblings.
test('an app allowed by a session whose answer arrives after signing out everywhere gets a code worth nothing', async () => {
  const { u, cookie } = await account('consent@example.com');
  const verifier = 'v'.repeat(43);
  const client = {
    client_id: 'https://app.example.com/client',
    kind: 'cimd' as const,
    name: 'App',
    host: 'app.example.com',
    redirect_uris: [],
    auth: 'none' as const,
  };
  const ask = oauth.createRequest({
    client,
    redirect_uri: 'https://app.example.com/cb',
    state: null,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    scopes: ['review:read'],
    resource: `${PUBLIC}/mcp`,
  });
  const asked = heldBody('POST', `/api/oauth/requests/${ask.id}`, { allow: true }, cookie);
  await asked.identified;
  auth.signOutEverywhere(u.id);
  const r = await asked.send();
  const code = r.status === 200 ? new URL(r.json().redirect).searchParams.get('code') : null;
  if (code)
    assert.throws(
      () => oauth.redeemCode({ code, client_id: client.client_id, redirect_uri: 'https://app.example.com/cb', code_verifier: verifier }),
      (e: Error & { code?: string }) => e.code === 'invalid_grant',
    );
  assert.deepEqual(oauth.listApps(u.id), []);
});
