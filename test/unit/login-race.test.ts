// A sign-in whose password check is still running when the account goes (deleted, an unconfirmed sign-up swept away,
// disabled, or given a new password) is answered like an address without an account: the same 401 as for an address
// nobody has, no session, no token, no sign-in alert. checkLogin (server/auth.ts) reads the account again once the
// check is done; it used to go on with the account as it was when the check began (a 403 "not in any workspace", or
// for an unconfirmed sign-up a session for an account that was gone). The check is held by standing in front of
// crypto.scrypt before lib/auth.ts wraps it, so each account goes at a known moment: while the server hashes the
// password it was given.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { after, before, mock, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';
import type { Reply } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
// Behind a proxy on this machine: each sign-in comes from its own address, so no limit is reached by the file itself.
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_TRUST_PROXY: 'loopback' } });

// The next scrypt waits for the test: armed right before a sign-in, it is that sign-in's password check.
const scrypt = crypto.scrypt;
let next: { reached: () => void; go: Promise<void> } | null = null;
mock.method(crypto, 'scrypt', (...args: unknown[]) => {
  const held = next;
  next = null;
  if (!held) return Reflect.apply(scrypt, crypto, args);
  held.reached();
  held.go.then(() => Reflect.apply(scrypt, crypto, args));
});
function holdNextCheck(): { reached: Promise<void>; release: () => void } {
  let reached = () => {};
  let release = () => {};
  const at = new Promise<void>((r) => {
    reached = r;
  });
  next = {
    reached,
    go: new Promise<void>((r) => {
      release = r;
    }),
  };
  return { reached: at, release };
}

const auth = await import('../../lib/auth.ts');
const workspaces = await import('../../lib/workspaces.ts');
const { deleteAccount } = await import('../../lib/deletion.ts');
const { readOutbox } = await import('../../lib/mail/index.ts');
type User = import('../../lib/auth.ts').User;

const { ctx, request } = await startApp({ headers: { Connection: 'close', Host: 'review.test', Origin: PUBLIC } });
after(() => ctx.mail.stop());
const OUTBOX = path.join(dir, 'cache', 'outbox');
const PASSWORD = 'a long password';

let n = 0;
const somewhere = () => ({ 'X-Forwarded-For': `198.51.100.${++n}`, 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Version/18.0 Mobile Safari/604.1' });
const signIn = (email: string) => request('POST', '/api/auth/login', { body: { email, password: PASSWORD }, headers: somewhere() });
const vrLogin = (email: string) => request('POST', '/api/auth/token', { body: { email, password: PASSWORD, name: 'laptop' }, headers: somewhere() });
const mailTo = async (address: string) => {
  await ctx.mail.flush();
  return readOutbox(OUTBOX).filter((m) => m.to === address);
};
/** What an answer tells: its status, its body and the cookies it sets (none, for an address without an account). */
const told = (r: Reply) => ({
  status: r.status,
  body: r.json(),
  cookies: [r.headers['set-cookie']]
    .flat()
    .filter(Boolean)
    .map((c) => String(c).split('=')[0]),
});

/** An account that asked for sign-in alerts, so a sign-in from a new browser would mail it. */
async function person(email: string, name: string): Promise<User> {
  const u = await auth.createUser({ email, name, password: PASSWORD, role: 'member' });
  return auth.updateUser(u.id, { prefs: { signin_alerts: true } });
}

/** A sign-in held in its password check while `gone` takes the account away; then let go. */
async function raced(ask: () => Promise<Reply>, gone: () => unknown): Promise<Reply> {
  const held = holdNextCheck();
  const answer = ask();
  await held.reached;
  await gone();
  held.release();
  return answer;
}

let unknown: ReturnType<typeof told>;
before(async () => {
  await auth.createUser({ email: 'owner@example.com', name: 'Olivia', password: PASSWORD, role: 'owner' });
  ctx.setup.token = null;
  // the answer for an address that never had an account, which every raced sign-in must match
  unknown = told(await signIn('nobody@example.com'));
  assert.equal(unknown.status, 401);
  assert.deepEqual(unknown.cookies, [], 'an unknown address sets no cookie');
  // and a sign-in that isn't raced works, alert and all (so the ones below fail for the race, not for the setup)
  await person('control@example.com', 'Control');
  const fine = await signIn('control@example.com');
  assert.equal(fine.status, 200, fine.text);
  assert.ok(told(fine).cookies.includes('vr_session'));
  assert.deepEqual(
    (await mailTo('control@example.com')).map((m) => m.kind),
    ['new-sign-in'],
  );
});

test('an account deleted while its password is checked: the unknown address’s answer, no session, no alert', async () => {
  const mia = await person('mia@example.com', 'Mia');
  const r = await raced(
    () => signIn('mia@example.com'),
    () => deleteAccount(mia.id, 'self'),
  );
  assert.equal(auth.getUser(mia.id), null, 'the account is gone');
  assert.deepEqual(told(r), unknown, r.text);
  assert.deepEqual(
    (await mailTo('mia@example.com')).map((m) => m.kind),
    [],
    'nothing mailed to the address',
  );
});

test('an unconfirmed sign-up swept away while its password is checked: no session for an account that is gone', async () => {
  const made = await auth.signUp({ email: 'held@example.com', name: 'Held', password: PASSWORD, mode: 'open' });
  assert.ok('made' in made);
  await auth.updateUser(made.made.id, { prefs: { signin_alerts: true } });
  const r = await raced(
    () => signIn('held@example.com'),
    () => auth.sweepUnconfirmed(7, Date.now() + 8 * 86_400_000),
  );
  assert.equal(auth.getUser(made.made.id), null, 'the sign-up is gone');
  assert.deepEqual(told(r), unknown, r.text);
  assert.deepEqual(await mailTo('held@example.com'), []);
});

test('an account disabled, or given a new password, while its old password is checked: the same answer', async () => {
  const kim = await person('kim@example.com', 'Kim');
  const disabled = await raced(
    () => signIn('kim@example.com'),
    () => auth.updateUser(kim.id, { disabled: true }),
  );
  assert.deepEqual(told(disabled), unknown, disabled.text);
  const max = await person('max@example.com', 'Max');
  const renewed = await raced(
    () => signIn('max@example.com'),
    () => auth.updateUser(max.id, { password: 'a brand new password' }),
  );
  assert.deepEqual(told(renewed), unknown, renewed.text);
  assert.deepEqual([...(await mailTo('kim@example.com')), ...(await mailTo('max@example.com'))], []);
  // the new password signs in as ever
  const again = await request('POST', '/api/auth/login', { body: { email: 'max@example.com', password: 'a brand new password' }, headers: somewhere() });
  assert.equal(again.status, 200, again.text);
});

test('`vr login` for an account deleted while its password is checked: no token, the unknown address’s answer', async () => {
  const zoe = await person('zoe@example.com', 'Zoe');
  const r = await raced(
    () => vrLogin('zoe@example.com'),
    () => deleteAccount(zoe.id, 'self'),
  );
  const nobody = await vrLogin('nobody@example.com');
  assert.deepEqual(told(r), told(nobody), r.text);
  assert.equal(r.json().token, undefined);
  assert.deepEqual(auth.listTokens(zoe.id), []);
  assert.deepEqual(await mailTo('zoe@example.com'), []);
});

// Taking an invite with an existing account, on a server with workspaces (lib/auth.ts acceptInvite's hold mode), checks
// the password in its own code. The account must still be the one checked once the check is done — the same id, the
// same password, not disabled —, or the answer is the one every address that doesn't join now gets ({held: true}, no
// session) and nobody joins. It used to join the account as it was read before the check: a password changed meanwhile
// still joined the workspace, and a disabled or deleted account got a session cookie that worked nowhere.
let team: { id: string; cookie: string } | null = null;
/** The session cookie an answer sets, ready to send. */
const sessionOf = (r: Reply): string =>
  [r.headers['set-cookie']]
    .flat()
    .filter(Boolean)
    .map((c) => String(c).split(';')[0])
    .filter((c) => c.startsWith('vr_session='))
    .join('; ');
/** An invite into the owner's second workspace (made by the first call: the store has workspaces from then on). */
async function inviteLink(): Promise<{ token: string; ws: string }> {
  if (!team) {
    const owner = await signIn('owner@example.com');
    assert.equal(owner.status, 200, owner.text);
    const made = await request('POST', '/api/workspaces', { body: { name: 'Side project' }, headers: { ...somewhere(), Cookie: sessionOf(owner) } });
    assert.equal(made.status, 200, made.text);
    team = { id: made.json().workspace.id, cookie: sessionOf(made) };
  }
  const r = await request('POST', '/api/admin/invites', { body: { role: 'member' }, headers: { ...somewhere(), Cookie: team.cookie } });
  assert.equal(r.status, 200, r.text);
  return { token: String(r.json().url).split('/#/invite/')[1] as string, ws: team.id };
}
const accept = (token: string, email: string) =>
  request('POST', '/api/auth/invite/accept', { body: { token, name: 'Invited', email, password: PASSWORD }, headers: somewhere() });
/** What an address that doesn't join now is told: an address nobody has, taking an invite. */
let told0: ReturnType<typeof told> | null = null;
const heldAnswer = async () => {
  told0 ??= told(await accept((await inviteLink()).token, 'nobody-invited@example.com'));
  return told0;
};

test('an account taking an invite while its password is changed doesn’t join: the answer every address gets, no session', async () => {
  const held = await heldAnswer();
  assert.deepEqual(held.body, { held: true });
  assert.ok(!held.cookies.includes('vr_session'), 'nobody is signed in');
  // not raced, an account with its password joins at once (so the ones below fail for the race, not for the setup)
  const ctl = await person('joins@example.com', 'Joins');
  const into = await inviteLink();
  const fine = await accept(into.token, 'joins@example.com');
  assert.equal(fine.status, 200, fine.text);
  assert.ok(told(fine).cookies.includes('vr_session'));
  assert.equal(workspaces.roleIn(into.ws, ctl.id), 'member');

  const pat = await person('pat@example.com', 'Pat');
  const invite = await inviteLink();
  const r = await raced(
    () => accept(invite.token, 'pat@example.com'),
    () => auth.updateUser(pat.id, { password: 'a brand new password' }),
  );
  assert.deepEqual(told(r), held, r.text);
  assert.equal(workspaces.roleIn(invite.ws, pat.id), null, 'the old password joined nothing');
});

test('an account disabled or deleted while it takes an invite: the held answer, not a session cookie that works nowhere', async () => {
  const held = await heldAnswer();
  const dee = await person('dee@example.com', 'Dee');
  const one = await inviteLink();
  const disabled = await raced(
    () => accept(one.token, 'dee@example.com'),
    () => auth.updateUser(dee.id, { disabled: true }),
  );
  assert.deepEqual(told(disabled), held, disabled.text);
  assert.equal(workspaces.roleIn(one.ws, dee.id), null);

  const del = await person('del@example.com', 'Del');
  const two = await inviteLink();
  const deleted = await raced(
    () => accept(two.token, 'del@example.com'),
    () => deleteAccount(del.id, 'self'),
  );
  assert.equal(auth.getUser(del.id), null, 'the account is gone');
  assert.deepEqual(told(deleted), held, deleted.text);
});
