// Accounts for teams (server mode): invite links (one-time, revocable, expiring, throttled) and the reviewer role,
// checked route by route against lib/permissions.ts. The last test walks every route the app registers, so a new
// writing route can't slip past the permission table.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { cookieFrom, tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');
const { readOutbox } = await import('../../lib/mail/index.ts');
type User = import('../../lib/auth.ts').User;
const { can, ROLE_ACTIONS } = await import('../../lib/permissions.ts');
const { ruleFor } = await import('../../server/permissions.ts');
const { GUEST_PATH } = await import('../../server/guard.ts');

// Fresh connections: refusals answer before reading the body, which can end a kept-alive socket mid-test.
const { ctx, app, request } = await startApp({ headers: { Connection: 'close' } });

const origin = { Origin: PUBLIC };
const bearerOf = (token: string) => ({ Authorization: `Bearer ${token}` });
const tokenOf = async (email: string, password: string) =>
  (await request('POST', '/api/auth/token', { body: { email, password }, headers: origin })).json().token as string;

/** Signed in in the app: people are managed by people (an API token manages no one, server/permissions.ts PERSON_ONLY). */
const sessionOf = (u: { id: string } | null) => ({ Cookie: `vr_session=${auth.signSession(auth.getUser(u?.id ?? '') as User)}`, ...origin });

let owner: Record<string, string>;
let admin: Record<string, string>;
let member: Record<string, string>;
let memberToken: Record<string, string>;

before(async () => {
  const o = await auth.createUser({ email: 'owner@example.com', name: 'Olivia', password: 'olivias password', role: 'owner' });
  const a = await auth.createUser({ email: 'ada@example.com', name: 'Ada', password: 'adas password 1', role: 'admin' });
  const m = await auth.createUser({ email: 'max@example.com', name: 'Max', password: 'maxs password 1', role: 'member' });
  ctx.setup.token = null;
  owner = sessionOf(o);
  admin = sessionOf(a);
  member = sessionOf(m);
  memberToken = bearerOf(await tokenOf('max@example.com', 'maxs password 1'));
});

const tokenIn = (url: string) => /#\/invite\/(inv_[\w-]+)$/.exec(url)?.[1] as string;

test('the matrix: reviewers watch, comment, verify and approve; members do the work; admins run the server', () => {
  assert.deepEqual([...ROLE_ACTIONS.reviewer].sort(), ['approve', 'comment', 'verify', 'view']);
  assert.equal(can('member', 'admin'), false);
  assert.equal(can('member', 'upload'), true);
  assert.equal(can('member', 'finalize'), true);
  assert.equal(can('reviewer', 'finalize'), false, 'reviewers approve, they do not decide what ships');
  assert.equal(can('admin', 'admin'), true);
  assert.equal(can(null, 'view'), false);
});

let reviewerCookie = '';

test('an invite link signs someone up once, with the role it was made for', async () => {
  const made = await request('POST', '/api/admin/invites', { body: { role: 'reviewer', email: 'Rita@Example.com', name: 'Rita' }, headers: admin });
  assert.equal(made.status, 200, made.text);
  const { invite, url } = made.json();
  assert.ok(url.startsWith(`${PUBLIC}/#/invite/inv_`), url);
  assert.equal(invite.status, 'pending');
  assert.equal(invite.email, 'rita@example.com');
  assert.equal(invite.by, 'Ada');
  const token = tokenIn(url);
  // Only a hash and a sealed copy are stored.
  const onDisk = fs.readFileSync(path.join(dir, 'data', 'invites.json'), 'utf8');
  assert.ok(!onDisk.includes(token));
  assert.equal((fs.statSync(path.join(dir, 'data', 'invites.json')).mode & 0o777).toString(8), '600');
  // Admins can copy the link again.
  assert.equal((await request('GET', `/api/admin/invites/${invite.id}/link`, { headers: admin })).json().url, url);

  const peek = await request('POST', '/api/auth/invite/peek', { body: { token }, headers: origin });
  assert.equal(peek.status, 200, peek.text);
  // An invite made out to an e-mail doesn't say which: a leaked link must not tell its reader what to type.
  assert.deepEqual({ role: peek.json().role, by: peek.json().by, email: peek.json().email }, { role: 'reviewer', by: 'Ada', email: null });
  assert.ok(!peek.text.includes('rita@'), peek.text);

  const weak = await request('POST', '/api/auth/invite/accept', {
    body: { token, name: 'Rita', email: 'rita@example.com', password: 'short' },
    headers: origin,
  });
  assert.equal(weak.status, 400);
  assert.equal((await request('POST', '/api/auth/invite/peek', { body: { token }, headers: origin })).status, 200, 'a failed accept keeps the invite');

  const ok = await request('POST', '/api/auth/invite/accept', {
    body: { token, name: 'Rita', email: 'rita@example.com', password: 'ritas password' },
    headers: origin,
  });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json().user.role, 'reviewer');
  reviewerCookie = cookieFrom(ok);
  assert.equal((await request('GET', '/api/library', { headers: { Cookie: reviewerCookie } })).status, 200, 'signed in right away');

  const again = await request('POST', '/api/auth/invite/accept', {
    body: { token, name: 'Rita Two', email: 'rita2@example.com', password: 'ritas password' },
    headers: origin,
  });
  assert.equal(again.status, 404, 'used once');
  const listed = (await request('GET', '/api/admin/invites', { headers: admin })).json().invites;
  assert.equal(listed.find((i: { id: string }) => i.id === invite.id).status, 'accepted');
  assert.equal(listed.find((i: { id: string }) => i.id === invite.id).accepted_by, 'Rita');
});

test('invites: revocable, they expire, and only admins make them (owners only by owners)', async () => {
  const one = (await request('POST', '/api/admin/invites', { body: { role: 'member' }, headers: owner })).json();
  assert.equal((await request('DELETE', `/api/admin/invites/${one.invite.id}`, { headers: admin })).status, 200);
  assert.equal((await request('POST', '/api/auth/invite/peek', { body: { token: tokenIn(one.url) }, headers: origin })).status, 404);
  assert.equal((await request('GET', `/api/admin/invites/${one.invite.id}/link`, { headers: admin })).status, 404);

  const two = (await request('POST', '/api/admin/invites', { body: { role: 'member', days: 1 }, headers: owner })).json();
  const file = path.join(dir, 'data', 'invites.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.invites.find((i: { id: string }) => i.id === two.invite.id).expires = new Date(Date.now() - 3600_000).toISOString();
  fs.writeFileSync(file, JSON.stringify(data));
  assert.equal((await request('POST', '/api/auth/invite/peek', { body: { token: tokenIn(two.url) }, headers: origin })).status, 404);
  const listed = (await request('GET', '/api/admin/invites', { headers: admin })).json().invites;
  assert.equal(listed.find((i: { id: string }) => i.id === two.invite.id).status, 'expired');

  assert.equal((await request('POST', '/api/admin/invites', { body: { role: 'owner' }, headers: admin })).status, 403, 'admins cannot mint owners');
  const co = await request('POST', '/api/admin/invites', { body: { role: 'owner' }, headers: owner });
  assert.equal(co.status, 200);
  // An owner's invite is an owner's business: an admin who copied its link could accept it and become an owner.
  const coId = co.json().invite.id;
  assert.equal((await request('GET', `/api/admin/invites/${coId}/link`, { headers: admin })).status, 403, 'admins cannot copy an owner invite');
  assert.equal((await request('DELETE', `/api/admin/invites/${coId}`, { headers: admin })).status, 403, 'nor revoke it');
  assert.equal((await request('GET', `/api/admin/invites/${coId}/link`, { headers: owner })).json().url, co.json().url);
  assert.equal((await request('POST', '/api/admin/invites', { body: { role: 'member' }, headers: member })).status, 403);
  assert.equal((await request('POST', '/api/admin/invites', { body: { email: 'max@example.com' }, headers: owner })).status, 400, 'existing account');
  assert.equal((await request('POST', '/api/admin/invites', { body: { role: 'reviewer' } })).status, 401);
  // A foreign page can't accept on someone's behalf (login CSRF).
  assert.equal((await request('POST', '/api/auth/invite/peek', { body: { token: 'inv_x' }, headers: { Origin: 'https://evil.test' } })).status, 403);
});

test('reviewers: allowed to watch, comment, confirm and approve — and nothing else', async () => {
  const rita = { Cookie: reviewerCookie, ...origin };
  // A reviewer makes their own API token (for vr / MCP), which carries the same role.
  const made = await request('POST', '/api/auth/tokens', { body: { name: 'laptop' }, headers: rita });
  assert.equal(made.status, 200, made.text);
  const reviewer = bearerOf(made.json().token);

  const file = makeVideo(path.join(dir, 'clips', 'spot.mp4'), { w: 160, h: 90, dur: 1 });
  const up = await tusUpload(request, file, { filename: 'spot.mp4', folder: 'Acme' }, owner);
  assert.equal(up.status, 200, up.text);
  const slug = encodeURIComponent(up.json().slug);
  const ownersNote = (await request('POST', `/api/review/${slug}/comments`, { body: { frame: 3, text: 'Logo größer' }, headers: owner })).json();

  const allowed: [string, string, unknown?][] = [
    ['GET', '/api/library'],
    ['GET', `/api/review/${slug}`],
    ['GET', `/media/${slug}/v1`],
    ['GET', '/api/inbox'],
    ['GET', '/api/insights'],
    ['PATCH', `/api/comments/${ownersNote.id}`, { note: 'Sehe ich auch so' }],
    ['PATCH', `/api/comments/${ownersNote.id}`, { status: 'verified' }],
    ['PATCH', `/api/comments/${ownersNote.id}`, { status: 'open' }],
    ['GET', '/api/status'],
  ];
  for (const [method, url, body] of allowed) {
    const r = await request(method, url, { body, headers: reviewer });
    assert.ok(r.status < 300, `${method} ${url} → ${r.status} ${r.text.slice(0, 120)}`);
  }
  // They approve in the app; a token (their vr or MCP agent) never signs off.
  const approve = { status: 'approved', note: 'passt' };
  assert.equal((await request('PUT', `/api/review/${slug}/approval`, { body: approve, headers: reviewer })).status, 403);
  assert.equal((await request('PUT', `/api/review/${slug}/approval`, { body: approve, headers: rita })).status, 200);
  const mine = await request('POST', `/api/review/${slug}/comments`, { body: { frame: 5, text: 'Farbe', by: 'agent:sneaky' }, headers: reviewer });
  assert.equal(mine.status, 200, mine.text);
  assert.equal(mine.json().author, 'Rita', 'reviewers cannot write as an agent');
  assert.equal((await request('PATCH', `/api/comments/${mine.json().id}`, { body: { text: 'Farbe wärmer' }, headers: reviewer })).status, 200);

  const refused: [string, string, unknown?][] = [
    ['PATCH', `/api/comments/${ownersNote.id}`, { text: 'rewritten' }],
    ['PATCH', `/api/comments/${ownersNote.id}`, { status: 'fixed' }],
    ['PATCH', `/api/comments/${ownersNote.id}`, { status: 'wontfix', note: 'nah' }],
    ['PATCH', `/api/comments/${ownersNote.id}`, { fixed_in_v: 2 }],
    ['DELETE', `/api/comments/${ownersNote.id}`],
    ['POST', '/api/uploads'],
    ['DELETE', `/api/library/${slug}`],
    ['POST', `/api/library/${slug}/restore`],
    ['POST', '/api/folders', { path: 'Rita' }],
    ['PATCH', '/api/folders', { from: 'Acme', to: 'Acme 2' }],
    ['DELETE', '/api/folders', { path: 'Acme' }],
    ['POST', '/api/folders/auto'],
    ['PUT', `/api/review/${slug}/folder`, { folder: 'Elsewhere' }],
    ['PUT', `/api/review/${slug}/session`, { session: null }],
    ['POST', `/api/review/${slug}/sync`],
    ['GET', `/api/review/${slug}/shares`],
    ['POST', `/api/review/${slug}/shares`, { label: 'Client' }],
    ['DELETE', '/api/shares/abcdefghijklmnopqrstuvwx'],
    ['PATCH', '/api/shares/abcdefghijklmnopqrstuvwx', { label: 'x' }],
    ['GET', '/api/shares/abcdefghijklmnopqrstuvwx/qr'],
    ['GET', '/api/folder-shares?folder=Acme'],
    ['POST', '/api/folder-shares', { folder: 'Acme', label: 'Client' }],
    ['GET', '/api/admin/webhooks'],
    ['POST', '/api/admin/webhooks', { url: 'https://hooks.example.com/x' }],
    ['POST', `/api/review/${slug}/request`, { text: 'please fix' }],
    ['PUT', `/api/review/${slug}/agent-status`, { text: 'rendering' }],
    ['POST', '/api/agents/heartbeat', { session_id: 's', name: 'n' }],
    ['POST', `/api/qa/${slug}/1/rerun`],
    ['POST', `/api/qa/${slug}/dismiss`, { key: 'x' }],
    ['GET', '/api/folders/download?folder=Acme'],
    ['GET', '/api/folders/download/info?folder=Acme'],
    ['GET', '/api/admin/users'],
    ['GET', '/api/admin/invites'],
    ['POST', '/api/admin/invites', { role: 'reviewer' }],
    ['PUT', `/api/review/${slug}/final`, { confirm: true }],
    ['DELETE', `/api/review/${slug}/final`],
  ];
  for (const [method, url, body] of refused) {
    const r = await request(method, url, { body, headers: reviewer });
    assert.equal(r.status, 403, `${method} ${url} → ${r.status} ${r.text.slice(0, 120)}`);
  }
  // Their own note: theirs to delete. Members may still edit anyone's notes.
  assert.equal((await request('DELETE', `/api/comments/${mine.json().id}`, { headers: reviewer })).status, 200);
  assert.equal((await request('PATCH', `/api/comments/${ownersNote.id}`, { body: { text: 'Logo viel größer' }, headers: member })).status, 200);
  assert.equal((await request('POST', '/api/folders', { body: { path: 'Max' }, headers: member })).status, 200);
  // Members decide what ships (in the app; their token doesn't); the reviewer's approval above is part of the history.
  assert.equal((await request('PUT', `/api/review/${slug}/final`, { body: { confirm: true }, headers: memberToken })).status, 403);
  const login = await request('POST', '/api/auth/login', { body: { email: 'max@example.com', password: 'maxs password 1' }, headers: origin });
  const max = { Cookie: cookieFrom(login), ...origin };
  const final = await request('PUT', `/api/review/${slug}/final`, { body: { confirm: true }, headers: max });
  assert.equal(final.status, 200, final.text);
  assert.equal(final.json().stage.stage, 'final');
  assert.equal((await request('DELETE', `/api/review/${slug}/final`, { headers: max })).status, 200);
});

test('roles: the last owner stays an owner; admins change members to reviewers and back', async () => {
  const users = (await request('GET', '/api/admin/users', { headers: owner })).json().users as { id: string; role: string; name: string }[];
  const olivia = users.find((u) => u.name === 'Olivia') as { id: string };
  const max = users.find((u) => u.name === 'Max') as { id: string };
  assert.equal((await request('PATCH', `/api/admin/users/${olivia.id}`, { body: { role: 'reviewer' }, headers: owner })).status, 400);
  assert.equal((await request('PATCH', `/api/admin/users/${max.id}`, { body: { role: 'reviewer' }, headers: admin })).status, 200);
  assert.equal((await request('POST', '/api/folders', { body: { path: 'Max 2' }, headers: member })).status, 403, 'the new role applies at once');
  assert.equal((await request('PATCH', `/api/admin/users/${max.id}`, { body: { role: 'member' }, headers: admin })).status, 200);
  assert.equal((await request('POST', '/api/folders', { body: { path: 'Max 2' }, headers: member })).status, 200);
});

test('every writing route is in the permission table', () => {
  // Express 5 keeps routes on router layers; nested routers (app.use(router)) have their own stack.
  interface Layer {
    route?: { path: string | string[]; methods: Record<string, boolean> };
    handle?: { stack?: Layer[] };
  }
  const found: [string, string][] = [];
  const walk = (stack: Layer[]) => {
    for (const l of stack) {
      if (l.route) {
        for (const p of [l.route.path].flat())
          for (const [m, on] of Object.entries(l.route.methods)) if (on) found.push([m === '_all' ? 'POST' : m.toUpperCase(), p]);
      } else if (l.handle?.stack) walk(l.handle.stack);
    }
  };
  walk((app as unknown as { router: { stack: Layer[] } }).router.stack);
  assert.ok(found.length > 40, `found ${found.length} routes`);
  const sample = (p: string) => p.replace(/\{\*[a-z]+\}/gi, 'x/y').replace(/:[a-z]+/gi, 'x');
  const missing = found
    .filter(([m]) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(m))
    .map(([m, p]) => [m, sample(p)] as const)
    .filter(([m, p]) => !GUEST_PATH.test(p) && !ruleFor(m, p).listed)
    .filter(([, p]) => !/^\/api\/auth\//.test(p));
  assert.deepEqual(missing, [], 'add these to ROUTE_ACTIONS in server/permissions.ts');
});

test('guessing invite tokens gets throttled', async () => {
  let last = 0;
  for (let i = 0; i < 35 && last !== 429; i++)
    last = (await request('POST', '/api/auth/invite/peek', { body: { token: `inv_${'x'.repeat(32)}` }, headers: origin })).status;
  assert.equal(last, 429);
});

test('an API token makes no more tokens and signs no one out everywhere: people do that in the app', async () => {
  assert.equal(
    (await request('POST', '/api/auth/tokens', { body: { name: 'forever' }, headers: memberToken })).status,
    403,
    'a leaked 1-day token could mint a lasting one',
  );
  assert.equal((await request('POST', '/api/auth/logout-everywhere', { headers: memberToken })).status, 403);
  const login = await request('POST', '/api/auth/login', { body: { email: 'max@example.com', password: 'maxs password 1' }, headers: origin });
  const max = { Cookie: cookieFrom(login), ...origin };
  assert.equal((await request('POST', '/api/auth/tokens', { body: { name: 'laptop', days: 1 }, headers: max })).status, 200);
});

test('an admin who is removed, disabled or demoted leaves no working invite behind', async () => {
  // (the invite list, not /invite/peek: the throttling test above used up this address's guesses)
  const statusOf = async (id: string) =>
    ((await request('GET', '/api/admin/invites', { headers: owner })).json().invites as { id: string; status: string }[]).find((x) => x.id === id)?.status;
  for (const [i, change] of [
    ['demoted', { role: 'member' }],
    ['disabled', { disabled: true }],
    ['removed', null],
  ] as const) {
    const u = await auth.createUser({ email: `adam${i}@example.com`, name: `Adam ${i}`, password: 'adams password 1', role: 'admin' });
    const adam = sessionOf(u);
    const made = await request('POST', '/api/admin/invites', { body: { role: 'admin' }, headers: adam });
    assert.equal(made.status, 200, made.text);
    assert.equal(await statusOf(made.json().invite.id), 'pending');
    const r = change
      ? await request('PATCH', `/api/admin/users/${u.id}`, { body: change, headers: owner })
      : await request('DELETE', `/api/admin/users/${u.id}`, { headers: owner });
    assert.equal(r.status, 200, r.text);
    assert.equal(await statusOf(made.json().invite.id), 'revoked', `the invite of an admin who was ${i}`);
  }
});

test('admins manage the credentials of members and admins, never of owners', async () => {
  const olivia = auth.listUsers().find((u) => u.role === 'owner');
  assert.ok(olivia);
  const kept = auth.createToken(olivia.id, 'olivia laptop').info;
  const listed = (await request('GET', '/api/admin/tokens', { headers: admin })).json().tokens as { id: string; user: string }[];
  assert.ok(!listed.some((t) => t.user === olivia.id), 'an owner’s tokens are not listed to admins');
  assert.equal((await request('DELETE', `/api/admin/tokens/${kept.id}`, { headers: admin })).status, 403);
  assert.ok((await request('GET', '/api/admin/tokens', { headers: owner })).json().tokens.some((t: { id: string }) => t.id === kept.id));
  assert.equal((await request('DELETE', `/api/admin/tokens/${kept.id}`, { headers: owner })).status, 200);
});

test('AUTH-2: an owner’s API token can’t take its account, mint people or hand out roles; your own password needs your current one', async () => {
  const olivia = auth.findUserByEmail('owner@example.com') as User;
  const max = auth.findUserByEmail('max@example.com') as User;
  const ownerToken = bearerOf(await tokenOf('owner@example.com', 'olivias password'));
  // The attack: the token sets its own account's address and password, signs in with them, mints a lasting token.
  const taken = await request('PATCH', `/api/admin/users/${olivia.id}`, {
    body: { email: 'owned@example.net', password: 'taken over now!' },
    headers: ownerToken,
  });
  assert.equal(taken.status, 403, taken.text);
  assert.equal((await request('POST', '/api/auth/login', { body: { email: 'owned@example.net', password: 'taken over now!' }, headers: origin })).status, 401);
  assert.equal(auth.getUser(olivia.id)?.email, 'owner@example.com');
  // …nor through Profile, nor anyone's credentials, account, role, membership, invite, token, webhook or workspace.
  const refused: [string, string, object?][] = [
    ['PATCH', '/api/auth/me', { password: 'taken over now!', current_password: 'olivias password' }],
    ['PATCH', '/api/auth/me', { email: 'owned@example.net', current_password: 'olivias password' }],
    ['PATCH', `/api/admin/users/${max.id}`, { password: 'taken over now!' }],
    ['PATCH', `/api/admin/users/${max.id}`, { role: 'admin' }],
    ['DELETE', `/api/admin/users/${max.id}`],
    ['POST', '/api/admin/users', { email: 'mine@example.net', name: 'Mine', password: 'mine mine mine', role: 'owner' }],
    ['POST', '/api/admin/invites', { role: 'owner' }],
    ['POST', '/api/auth/tokens', { name: 'forever' }],
    ['POST', '/api/admin/webhooks', { url: 'https://hooks.example.com/x' }],
    ['POST', '/api/workspaces', { name: 'Mine' }],
  ];
  for (const [method, url, body] of refused) {
    const r = await request(method, url, { body, headers: ownerToken });
    assert.equal(r.status, 403, `${method} ${url} → ${r.status} ${r.text.slice(0, 120)}`);
  }
  assert.equal(auth.getUser(max.id)?.role, 'member');
  assert.equal(auth.findUserByEmail('mine@example.net'), null);
  // Reading stays open to the token, and so does what isn't a credential.
  assert.equal((await request('GET', '/api/admin/users', { headers: ownerToken })).status, 200);
  assert.equal((await request('PATCH', '/api/auth/me', { body: { prefs: { theme: 'dark' } }, headers: ownerToken })).status, 200);
  // In the app: someone else's password as before; your own only with your current one.
  assert.equal((await request('PATCH', `/api/admin/users/${max.id}`, { body: { password: 'maxs new password' }, headers: owner })).status, 200);
  const bare = await request('PATCH', `/api/admin/users/${olivia.id}`, { body: { password: 'olivias new password' }, headers: owner });
  assert.equal(bare.status, 403, bare.text);
  const wrong = { password: 'olivias new password', current_password: 'not hers at all' };
  assert.equal((await request('PATCH', `/api/admin/users/${olivia.id}`, { body: wrong, headers: owner })).status, 403);
  const right = { password: 'olivias new password', current_password: 'olivias password' };
  assert.equal((await request('PATCH', `/api/admin/users/${olivia.id}`, { body: right, headers: owner })).status, 200);
  assert.equal(
    (await request('POST', '/api/auth/login', { body: { email: 'owner@example.com', password: 'olivias new password' }, headers: origin })).status,
    200,
  );
});

test('VA-2: your own address through the admin route follows Profile: it waits for its link, and tells nothing of who has an account', async () => {
  const olivia = auth.findUserByEmail('owner@example.com') as User;
  const me = sessionOf(olivia);
  await ctx.mail.flush();
  const before = readOutbox(path.join(dir, 'cache', 'outbox')).length;
  const asked: { status: number; email: string; pending: string }[] = [];
  for (const email of ['max@example.com', 'olivia.new@example.com']) {
    const r = await request('PATCH', `/api/admin/users/${olivia.id}`, { body: { email, current_password: 'olivias new password' }, headers: me });
    asked.push({ status: r.status, email: r.json().user?.email, pending: r.json().user?.pending_email });
  }
  assert.deepEqual(asked, [
    { status: 200, email: 'owner@example.com', pending: 'max@example.com' },
    { status: 200, email: 'owner@example.com', pending: 'olivia.new@example.com' },
  ]);
  assert.equal(auth.getUser(olivia.id)?.email, 'owner@example.com', 'the address waits for its link');
  await ctx.mail.flush();
  assert.deepEqual(
    readOutbox(path.join(dir, 'cache', 'outbox'))
      .slice(before)
      .map((m) => [m.kind, m.to]),
    [['verify-change', 'olivia.new@example.com']],
    'a link to the free address only',
  );
  assert.equal((await request('POST', '/api/auth/email/cancel', { headers: me })).status, 200);
  // And without the current password, nothing.
  const bare = await request('PATCH', `/api/admin/users/${olivia.id}`, { body: { email: 'olivia.other@example.com' }, headers: me });
  assert.equal(bare.status, 403);
  assert.equal(auth.getUser(olivia.id)?.pending_email, undefined);
});
