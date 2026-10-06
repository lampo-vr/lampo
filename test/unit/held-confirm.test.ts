// Who may confirm a held account, with whose password (A12 INV-REV-1, A12-D8). A held account carries a password that
// whoever made it chose — someone signing up, or anyone who took an invite with the address (the invite's maker holds
// its link too). Its confirm link proves the inbox, not the password, so:
// - in the browser that chose the password (its `vr_signup` mark) or signed in as the account, the link confirms it;
// - anywhere else, the opener types the password that was chosen, or chooses a new one — which, like a reset, leaves
//   behind the invites taken with the old one;
// - the address's owner signing up, asking for their invite or for the link again never confirms someone else's
//   password: a sign-up with another password gets a reset link, an invite-mode sign-up its pending invites too.
// Ported from the invite/confirm review's repros (t2 O1a, O7, O9; t7 I2), with the behaviour the fix gives.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Config } from '../../lib/config.ts';
import { isolatedEnv } from '../lib/helpers.ts';
import { client, type Reply } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_TRUST_PROXY: 'loopback', VR_SIGNUP: 'open' } });
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const { onSignup } = await import('../../server/signup.ts');
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const { readOutbox } = await import('../../lib/mail/index.ts');
type User = import('../../lib/auth.ts').User;

const PW = 'a long password';
const OUTBOX = path.join(dir, 'cache', 'outbox');

/** A server over HTTP with these settings (sign-up open by default: the Cloud path). */
async function serve(cfg: Partial<Config>) {
  const ctx = createContext({ cfg: { ...loadConfig(), ...cfg }, token: 'unused', onSignup });
  ctx.setup.token = null;
  const srv = http.createServer(createApp(ctx));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const request = client((srv.address() as AddressInfo).port, { Connection: 'close', Host: 'review.test' });
  let n = 0;
  const from = () => ({ Origin: PUBLIC, 'X-Forwarded-For': `198.51.100.${(n++ % 250) + 1}` });
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) => request('POST', url, { body, headers: { ...from(), ...headers } });
  const close = () => {
    ctx.mail.stop();
    srv.close();
  };
  return { ctx, post, request, close };
}

const cookie = (r: Reply, name: string) =>
  [r.headers['set-cookie']]
    .flat()
    .filter(Boolean)
    .map((c) => String(c).split(';')[0] as string)
    .find((c) => c.startsWith(`${name}=`) && c.length > name.length + 1) ?? '';
const linkIn = (text: string, kind: 'vt' | 'rt' | 'inv') => new RegExp(`#/(?:verify|reset|invite)/(${kind}_[\\w-]+)`).exec(text)?.[1] as string;
let seen = 0;
/** The mails sent to an address since the last look, oldest first. */
async function newMail(s: { ctx: { mail: { flush(): Promise<void> } } }, address: string) {
  await s.ctx.mail.flush();
  const all = readOutbox(OUTBOX);
  const out = all.slice(seen).filter((m) => m.to === address);
  seen = all.length;
  return out;
}
const user = (email: string) => auth.findUserByEmail(email) as User;
const where = (email: string, names: Record<string, string>) =>
  ws
    .workspacesOf(user(email).id)
    .map((x) => `${names[x.workspace.id] ?? 'own'}:${x.role}`)
    .sort();

let open: Awaited<ReturnType<typeof serve>>;
let WM = '';
let malloryInvite: (email?: string) => Promise<string>;
before(async () => {
  open = await serve({ signup: 'open' });
  await auth.createUser({ email: 'owner@agency.example', name: 'Agency Owner', password: PW, role: 'owner' });
  const mallory = await auth.createUser({ email: 'mallory@example.com', name: 'Mallory', password: PW, role: 'reviewer' });
  WM = ws.createWorkspace({ name: 'Side project', ownerId: mallory.id }).id;
  // Mallory's own invites, made out to nobody: she takes them herself with whatever address she likes.
  // (or made out to the address she means to take: she holds that link as much as its inbox does)
  malloryInvite = async (email?: string) => {
    const made = auth.createInvite({ role: 'member', workspace: WM, by: { id: mallory.id, name: 'Mallory' }, ...(email ? { email } : {}) });
    return made.token;
  };
});
after(() => open.close());
const names = () => ({ [WM]: 'WM' });

/** Mallory takes her own invite as `email` with her password: a held account the address's inbox now hears about. */
async function squat(email: string, { addressed = false, name }: { addressed?: boolean; name?: string } = {}) {
  const r = await open.post('/api/auth/invite/accept', {
    token: await malloryInvite(addressed ? email : undefined),
    name: name ?? `Not ${email.split('@')[0]}`,
    email,
    password: 'mallory knows this',
  });
  assert.deepEqual(r.json(), { held: true });
  assert.ok(auth.isGated(user(email)));
  return { mark: cookie(r, 'vr_signup'), link: linkIn((await newMail(open, email)).find((m) => m.kind === 'verify')?.text ?? '', 'vt') };
}

test('INV-REV-1 (O9), D8: the confirm link opened anywhere but where the password was chosen asks for it, or for a new one', async () => {
  const email = 'eli@client.example';
  const { link } = await squat(email);
  // Eli opens the link mailed to him, in his own browser: nothing is confirmed until he proves the password or sets one.
  const asked = await open.post('/api/auth/verify', { token: link });
  assert.equal(asked.status, 409, asked.text);
  assert.equal(asked.json().state, 'password');
  assert.equal(asked.json().email, 'e•••@client.example');
  assert.deepEqual(asked.json().joins, [{ workspace: 'Side project', by: 'Mallory', role: 'member' }], 'the page says what confirming would join');
  assert.ok(auth.isGated(user(email)), 'still held, the link still good');
  const wrong = await open.post('/api/auth/verify', { token: link, password: 'not the password!' });
  assert.equal(wrong.status, 403, wrong.text);
  assert.equal(wrong.json().state, 'password');
  assert.ok(auth.isGated(user(email)));
  // "That wasn't me": a password of his own, the invites taken with the other one left behind.
  const own = await open.post('/api/auth/verify', { token: link, new_password: 'elis own password' });
  assert.equal(own.status, 200, own.text);
  assert.deepEqual([own.json().released, own.json().signedIn], [true, true]);
  assert.match(cookie(own, 'vr_session'), /^vr_session=/);
  assert.deepEqual(where(email, names()), ['own:owner'], 'a workspace of his own (open sign-up), not Mallory’s');
  assert.equal(ws.roleIn(WM, user(email).id), null);
  assert.equal((await open.post('/api/auth/login', { email, password: 'mallory knows this' })).status, 401);
  assert.equal((await open.post('/api/auth/login', { email, password: 'elis own password' })).status, 200);
  assert.equal((await open.post('/api/auth/verify', { token: link })).status, 410, 'used');
});

test('the person who chose the password confirms from anywhere: by its browser, by typing it, or signed in as it', async () => {
  // In the browser that took the invite: confirmed and signed in at once, invites taken (WEB-1's case).
  const a = 'ana@client.example';
  const s1 = await squat(a);
  const here = await open.post('/api/auth/verify', { token: s1.link }, { Cookie: s1.mark });
  assert.equal(here.status, 200, here.text);
  assert.deepEqual([here.json().released, here.json().signedIn], [true, true]);
  assert.deepEqual(where(a, names()), ['WM:member']);
  // On another device, typing the password chosen: confirmed, signed in there, invites taken.
  const b = 'bo@client.example';
  const s2 = await squat(b);
  const typed = await open.post('/api/auth/verify', { token: s2.link, password: 'mallory knows this' });
  assert.equal(typed.status, 200, typed.text);
  assert.deepEqual([typed.json().released, typed.json().signedIn], [true, true]);
  assert.deepEqual(where(b, names()), ['WM:member']);
  // Signed in as the held account itself (its "Check your inbox" screen): its session goes on, confirmed.
  const c = 'cy@client.example';
  const s3 = await squat(c);
  const held = cookie(await open.post('/api/auth/login', { email: c, password: 'mallory knows this' }), 'vr_session');
  const mine = await open.post('/api/auth/verify', { token: s3.link }, { Cookie: held });
  assert.equal(mine.status, 200, mine.text);
  assert.deepEqual(where(c, names()), ['WM:member']);
});

test('INV-REV-1 (O1a): the address’s owner signing up with a password of their own gets a reset link, never the held account’s confirmation', async () => {
  const email = 'vera@client.example';
  await squat(email);
  const signup = await open.post('/api/auth/signup', { name: 'Vera V', email, password: 'veras own password' });
  assert.deepEqual([signup.status, signup.json()], [200, { ok: true }]);
  const got = await newMail(open, email);
  assert.deepEqual(
    got.map((m) => m.kind),
    ['reset'],
    'a link to choose her password, not the confirmation of the one someone else chose',
  );
  // Her browser's mark doesn't open the held account: the confirm link mailed before still asks there.
  const reset = await open.post('/api/auth/reset', { token: linkIn(got[0]?.text ?? '', 'rt'), password: 'veras own password' });
  assert.equal(reset.status, 200, reset.text);
  assert.deepEqual(where(email, names()), ['own:owner']);
  assert.equal((await open.post('/api/auth/login', { email, password: 'mallory knows this' })).status, 401);
});

test('signing up again with the password chosen sends the confirm link again, and this browser’s confirms it (VA-7)', async () => {
  const email = 'dan@client.example';
  const first = await open.post('/api/auth/signup', { name: 'Dan', email, password: 'dans own password' });
  assert.equal(first.status, 200);
  await newMail(open, email);
  // Another browser, the same password: the link again, and that browser is the one it signs in.
  const again = await open.post('/api/auth/signup', { name: 'Dan', email, password: 'dans own password' });
  const got = await newMail(open, email);
  assert.deepEqual(
    got.map((m) => m.kind),
    ['verify'],
  );
  const ok = await open.post('/api/auth/verify', { token: linkIn(got[0]?.text ?? '', 'vt') }, { Cookie: cookie(again, 'vr_signup') });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json().signedIn, true);
});

test('INV-REV-1 (O7): “send it again” signed out sends the held account’s link, which asks the opener for its password', async () => {
  const email = 'quinn@client.example';
  await squat(email);
  assert.equal((await open.post('/api/auth/verify/resend', { email })).status, 200);
  const [mail] = await newMail(open, email);
  assert.equal(mail?.kind, 'verify');
  const asked = await open.post('/api/auth/verify', { token: linkIn(mail?.text ?? '', 'vt') });
  assert.deepEqual([asked.status, asked.json().state], [409, 'password']);
  const own = await open.post('/api/auth/verify', { token: linkIn(mail?.text ?? '', 'vt'), new_password: 'quinns own password' });
  assert.equal(own.status, 200, own.text);
  assert.equal(ws.roleIn(WM, user(email).id), null);
  assert.equal((await open.post('/api/auth/login', { email, password: 'mallory knows this' })).status, 401);
});

test('INV-REV-1 (I2): with VR_SIGNUP=invite the invited person asking again gets their invite, and the held account can’t be confirmed with its password', async () => {
  const inv = await serve({ signup: 'invite' });
  try {
    const carla = await auth.createUser({ email: 'carla@client.example', name: 'Carla', password: PW, role: 'reviewer' });
    const WC = ws.createWorkspace({ name: 'Client', ownerId: carla.id }).id;
    const email = 'iris@client.example';
    const real = auth.createInvite({ role: 'admin', email, workspace: WC, by: { id: carla.id, name: 'Carla' } });
    await squat(email);
    assert.deepEqual((await inv.post('/api/auth/signup', { email })).json(), { ok: true });
    const got = await newMail(inv, email);
    assert.ok(
      got.some((m) => m.kind === 'invite' && linkIn(m.text, 'inv') === real.token),
      `Carla’s invite again: ${got.map((m) => m.kind)}`,
    );
    const link = linkIn(got.find((m) => m.kind === 'verify')?.text ?? '', 'vt');
    if (link) assert.equal((await inv.post('/api/auth/verify', { token: link })).json().state, 'password', 'the held account’s link asks');
    // Iris takes Carla's invite with her own password: the inbox gets a reset, which hands her the address…
    const taken = await inv.post('/api/auth/invite/accept', { token: real.token, name: 'Iris', email, password: 'iris own password' });
    assert.deepEqual(taken.json(), { held: true });
    const reset = linkIn((await newMail(inv, email)).find((m) => m.kind === 'reset')?.text ?? '', 'rt');
    assert.equal((await inv.post('/api/auth/reset', { token: reset, password: 'iris own password' })).status, 200);
    assert.equal(ws.roleIn(WM, user(email).id), null, 'never Mallory’s workspace');
    // …and Carla's invite, taken again, joins her at once.
    const joined = await inv.post('/api/auth/invite/accept', { token: real.token, name: 'Iris', email, password: 'iris own password' });
    assert.equal(joined.status, 200, joined.text);
    assert.equal(ws.roleIn(WC, user(email).id), 'admin');
  } finally {
    inv.close();
  }
});

test('A12-D14: a second sign-up in the same browser keeps the first’s confirm link signing in there', async () => {
  const first = await open.post('/api/auth/signup', { name: 'Fay One', email: 'fay@client.example', password: 'fays own password' });
  const mark = cookie(first, 'vr_signup');
  const firstLink = linkIn((await newMail(open, 'fay@client.example'))[0]?.text ?? '', 'vt');
  // The same browser signs up again, for another address (a typo, a second account): it keeps its mark.
  const second = await open.post('/api/auth/signup', { name: 'Fay Two', email: 'fay2@client.example', password: 'fays other password' }, { Cookie: mark });
  assert.equal(cookie(second, 'vr_signup'), mark, 'the browser keeps one mark');
  const secondLink = linkIn((await newMail(open, 'fay2@client.example'))[0]?.text ?? '', 'vt');
  const one = await open.post('/api/auth/verify', { token: firstLink }, { Cookie: mark });
  assert.equal(one.status, 200, one.text);
  assert.equal(one.json().signedIn, true, 'the first link still signs this browser in');
  // and the second's too (here without the first's session: a link never signs over someone else's)
  const two = await open.post('/api/auth/verify', { token: secondLink }, { Cookie: mark });
  assert.deepEqual([two.status, two.json().signedIn], [200, true]);
  // A mark that isn't one of ours is never kept: a browser can't choose its own.
  const odd = await open.post(
    '/api/auth/signup',
    { name: 'Fay Three', email: 'fay3@client.example', password: 'fays third password' },
    { Cookie: 'vr_signup=not-a-mark' },
  );
  assert.match(cookie(odd, 'vr_signup'), /^vr_signup=[\w-]{32}$/);
});

// From the verification of this fix (verify-F1a): the invite made out to the address, a squatter signing up again, and
// the limit on guessing the password at the confirm page.
test('INV-REV-1: an invite made out to the address, taken by its maker, is the same: the address’s owner sets a password of their own', async () => {
  const email = 'vic2@client.example';
  const { link } = await squat(email, { addressed: true });
  const asked = await open.post('/api/auth/verify', { token: link });
  assert.deepEqual([asked.status, asked.json().state], [409, 'password']);
  const set = await open.post('/api/auth/verify', { token: link, new_password: 'the victims own password' });
  assert.equal(set.status, 200, set.text);
  assert.equal(ws.roleIn(WM, user(email).id), null, 'not in the maker’s workspace');
  assert.equal((await open.post('/api/auth/login', { email, password: 'mallory knows this' })).status, 401);
  assert.equal((await open.post('/api/auth/login', { email, password: 'the victims own password' })).status, 200);
  assert.ok((await open.post('/api/auth/verify', { token: link, password: 'mallory knows this' })).status >= 400, 'the link is spent');
});

test('INV-REV-1: a squatter signing up again with the password chosen gets nothing: the link goes to the inbox', async () => {
  const email = 'vic3@client.example';
  await squat(email);
  const again = await open.post('/api/auth/signup', { name: 'Not vic3', email, password: 'mallory knows this' });
  assert.equal(again.status, 200);
  assert.deepEqual(
    (await newMail(open, email)).map((m) => m.kind),
    ['verify'],
  );
  assert.equal((await newMail(open, 'mallory@example.com')).length, 0, 'nothing reaches her');
});

test('INV-REV-1: the confirm page takes 10 wrong passwords per account, then waits — the right one too', async () => {
  const email = 'vic4@client.example';
  const { link } = await squat(email);
  const codes: number[] = [];
  for (let i = 0; i < 12; i++) codes.push((await open.post('/api/auth/verify', { token: link, password: `wrong guess ${i}` })).status);
  assert.deepEqual(codes.slice(0, 10), Array(10).fill(403));
  assert.deepEqual(codes.slice(10), [429, 429]);
  assert.equal((await open.post('/api/auth/verify', { token: link, password: 'mallory knows this' })).status, 429);
  assert.ok(auth.isGated(user(email)), 'still held');
});

test('INV-REV-4: names tell people apart in a workspace: a held account named like a member is asked for another name when it joins', async () => {
  // Two people take invites into Side project under the same name; the first to confirm joins as it.
  const one = await squat('kate.one@client.example', { name: 'Kate Doe' });
  const two = await squat('kate.two@client.example', { name: 'Kate Doe' });
  assert.equal((await open.post('/api/auth/verify', { token: one.link }, { Cookie: one.mark })).status, 200);
  assert.equal(ws.roleIn(WM, user('kate.one@client.example').id), 'member');
  // The second is refused with the link unused, and asked for another name.
  const asked = await open.post('/api/auth/verify', { token: two.link }, { Cookie: two.mark });
  assert.equal(asked.status, 409, asked.text);
  assert.deepEqual([asked.json().state, asked.json().name], ['name', 'Kate Doe']);
  assert.ok(auth.isGated(user('kate.two@client.example')), 'still held');
  // A name already in use there is refused the same way; another one joins.
  assert.equal((await open.post('/api/auth/verify', { token: two.link, name: 'kate doe' }, { Cookie: two.mark })).json().state, 'name');
  const joined = await open.post('/api/auth/verify', { token: two.link, name: 'Kate Dee' }, { Cookie: two.mark });
  assert.equal(joined.status, 200, joined.text);
  assert.equal(ws.roleIn(WM, user('kate.two@client.example').id), 'member');
  assert.equal(user('kate.two@client.example').name, 'Kate Dee');
  const named = ws.membersOf(WM).map((m) => auth.getUser(m.user)?.name);
  assert.equal(named.filter((n) => n === 'Kate Doe').length, 1, 'one Kate Doe in Side project');
});

test('INV-REV-5: a held account renaming itself learns nothing of other teams’ names', async () => {
  const email = 'hal@client.example';
  await squat(email, { name: 'Hal Held' });
  const login = await open.post('/api/auth/login', { email, password: 'mallory knows this' });
  assert.equal(login.status, 200, login.text);
  const held = { Cookie: cookie(login, 'vr_session') };
  // "Agency Owner" is a name only workspace #1 uses: the same answer as for a name nobody has.
  const other = await open.request('PATCH', '/api/auth/me', { body: { name: 'Agency Owner' }, headers: { Origin: PUBLIC, ...held } });
  const free = await open.request('PATCH', '/api/auth/me', { body: { name: 'Nobody Has This Name' }, headers: { Origin: PUBLIC, ...held } });
  assert.deepEqual([other.status, free.status], [200, 200], other.text);
});

test('INV-REV-6: guessing the address an invite is made out to is limited per invite, then nobody learns more', async () => {
  const token = await malloryInvite('the.invitee@client.example');
  const codes: number[] = [];
  for (let i = 0; i < 6; i++)
    codes.push((await open.post('/api/auth/invite/accept', { token, name: 'Guess', email: `guess${i}@client.example`, password: 'a long password 9' })).status);
  assert.deepEqual(codes, [400, 400, 400, 400, 400, 429], 'five wrong addresses, then a wait');
  // The right address now waits too: the answer never tells which one it is.
  const right = await open.post('/api/auth/invite/accept', { token, name: 'Invitee', email: 'the.invitee@client.example', password: 'a long password 9' });
  assert.equal(right.status, 429);
});

test('INV-REV-7: a plan’s member limit holds when a held account joins: refused with the link unused, in once there is room', async () => {
  const { HttpError } = await import('../../server/http.ts');
  const one = await squat('plan.one@client.example');
  const full = ws.membersOf(WM).length;
  const plain = open.ctx.extension;
  open.ctx.extension = {
    ...plain,
    async check(workspace: string, gate: string) {
      if (gate === 'member' && workspace === WM && ws.membersOf(WM).length >= full) throw new HttpError(402, 'this plan has room for no one else');
    },
  };
  try {
    const refused = await open.post('/api/auth/verify', { token: one.link }, { Cookie: one.mark });
    assert.equal(refused.status, 402, refused.text);
    assert.ok(auth.isGated(user('plan.one@client.example')), 'still held, the link unused');
    assert.equal(ws.membersOf(WM).length, full, 'nobody over the plan');
  } finally {
    open.ctx.extension = plain;
  }
  const room = await open.post('/api/auth/verify', { token: one.link }, { Cookie: one.mark });
  assert.equal(room.status, 200, room.text);
  assert.equal(ws.roleIn(WM, user('plan.one@client.example').id), 'member');
});
