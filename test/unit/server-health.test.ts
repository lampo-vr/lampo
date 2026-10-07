// The server setup's health check (server/routes/serverHealth.ts): what a team on this server will need, for the people
// who run it — the owners and admins of its first workspace, signed in as themselves. It says where things stand
// without a secret (the relay by host and port, never its user or password), and its test mail goes to the asker's own
// address now: to the outbox without a relay, through the relay with one (a refused relay is a sentence, not its
// reply), a few in ten minutes. Members, reviewers, API tokens and the owner of any other workspace get nothing.
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';
import { cookieFrom } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');
type User = import('../../lib/auth.ts').User;
const ws = await import('../../lib/workspaces.ts');
const { loadConfig } = await import('../../lib/config.ts');
const { readOutbox } = await import('../../lib/mail/index.ts');
const { DATA } = await import('../../lib/paths.ts');

// Two apps on one store: this one without a relay (the outbox), the other with one that refuses every connection.
const { ctx, request } = await startApp();
const SECRET = 'sup3r-secret-pass';
const relayed = await startApp({
  cfg: {
    ...loadConfig(),
    mail: { ...loadConfig().mail, transport: 'smtp', smtp_url: `smtps://lampo%40review.test:${SECRET}@127.0.0.1:1`, from: 'Lampo <lampo@review.test>' },
  },
});
after(() => {
  ctx.mail.stop();
  relayed.ctx.mail.stop();
});

const OUTBOX = path.join(dir, 'cache', 'outbox');
const origin = { Origin: PUBLIC };
const as = (cookie: string) => ({ headers: { Cookie: cookie, ...origin } });
let owner = '';
const people: Record<string, string> = {};

test('the owner of the server’s first workspace reads its health: the address, storage, mail, speech', async () => {
  const ok = await request('POST', '/api/auth/setup', {
    body: { email: 'mia@review.test', name: 'Mia Lang', password: 'correct horse battery', token: ctx.setup.token },
    headers: origin,
  });
  assert.equal(ok.status, 200, ok.text);
  owner = cookieFrom(ok);
  const r = await request('GET', '/api/server/health', as(owner));
  assert.equal(r.status, 200, r.text);
  const h = r.json();
  assert.deepEqual(h.public_url, { ok: false, url: PUBLIC }, 'plain http off this machine: review links would leak over the wire');
  assert.equal(h.storage.kind, 'local');
  assert.equal(h.storage.writable, true, 'written to and read back just now');
  assert.equal(h.storage.ok, true);
  assert.equal(typeof h.storage.free_bytes, 'number');
  assert.equal(h.storage.where, null, 'no folder on this disk for anyone but the machine itself (ONB-1)');
  assert.ok(!r.text.includes(DATA), 'the data folder appears nowhere in the answer');
  assert.deepEqual(h.mail, { ok: false, transport: 'log', from: 'lampo@review.test', relay: null }, 'no relay: the outbox');
  assert.deepEqual([h.stt.ok, h.stt.state], [false, 'off']);
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('with a relay: its host and port, never its user or password', async () => {
  const r = await relayed.request('GET', '/api/server/health', as(owner));
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json().mail, { ok: true, transport: 'smtp', from: 'lampo@review.test', relay: '127.0.0.1:1' });
  for (const secret of [SECRET, 'lampo%40review.test', 'smtps://']) assert.ok(!r.text.includes(secret), `no ${secret} in the answer`);
});

test('the test mail goes to the asker’s own address now: the outbox without a relay; a few in ten minutes', async () => {
  const r = await request('POST', '/api/server/mail-test', { body: { lang: 'en' }, ...as(owner) });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json(), { ok: true, to: 'mia@review.test' });
  const sent = readOutbox(OUTBOX).filter((m) => m.kind === 'test' && m.to === 'mia@review.test');
  assert.equal(sent.length, 1, 'written to the outbox at once (not queued)');
  assert.equal((await request('POST', '/api/server/mail-test', { body: {}, ...as(owner) })).status, 200);
  assert.equal((await request('POST', '/api/server/mail-test', { body: {}, ...as(owner) })).status, 200);
  const fourth = await request('POST', '/api/server/mail-test', { body: {}, ...as(owner) });
  assert.equal(fourth.status, 429, fourth.text);
  assert.ok(Number(fourth.headers['retry-after']) > 0);
  assert.equal((await request('POST', '/api/server/mail-test', { body: { to: 'else@example.com' }, ...as(owner) })).status, 400, 'only the asker’s');
});

test('a relay that refuses: a sentence to fix it by, not what the relay said', async () => {
  const r = await relayed.request('POST', '/api/server/mail-test', { body: {}, ...as(owner) });
  assert.equal(r.status, 502, r.text);
  assert.match(r.json().error, /LAMPO_SMTP_URL/);
  for (const secret of [SECRET, 'ECONNREFUSED', '127.0.0.1']) assert.ok(!r.text.includes(secret), `no ${secret} in the answer`);
});

test('admins of the first workspace too; members, reviewers, tokens and other workspaces’ owners get nothing', async () => {
  for (const [name, role] of [
    ['Ada', 'admin'],
    ['Max', 'member'],
    ['Rae', 'reviewer'],
  ] as const) {
    await auth.createUser({ email: `${name.toLowerCase()}@review.test`, name, password: 'a long enough password', role });
    const login = await request('POST', '/api/auth/login', {
      body: { email: `${name.toLowerCase()}@review.test`, password: 'a long enough password' },
      headers: origin,
    });
    assert.equal(login.status, 200, login.text);
    people[role] = cookieFrom(login);
  }
  // the server's own checks are whoever runs it (lib/operator.ts: no LAMPO_OPERATOR here, so #1's owners), never a
  // role in #1 as such: an admin there works there and runs nothing
  for (const role of ['admin', 'member', 'reviewer']) {
    assert.equal((await request('GET', '/api/server/health', as(people[role] as string))).status, 404, role);
    assert.equal((await request('POST', '/api/server/mail-test', { body: {}, ...as(people[role] as string) })).status, 404, role);
  }
  const mia = auth.findUserByEmail('mia@review.test') as User;
  const { token } = auth.createToken(mia.id, 'script');
  const byToken = await request('GET', '/api/server/health', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(byToken.status, 403, byToken.text);
  assert.equal(byToken.json().person, true, 'people only');
  assert.equal((await request('POST', '/api/server/mail-test', { body: {}, headers: { Authorization: `Bearer ${token}` } })).status, 403);
  // the owner of another workspace (an open sign-up has one) is a customer: no such page for them
  const zoe = await auth.createUser({ email: 'zoe@example.com', name: 'Zoe', password: 'a long enough password', role: 'member' });
  ws.createWorkspace({ name: 'Zoe Films', ownerId: zoe.id });
  ws.removeMember('w1', zoe.id);
  const zl = await request('POST', '/api/auth/login', { body: { email: 'zoe@example.com', password: 'a long enough password' }, headers: origin });
  const zc = cookieFrom(zl);
  const zs = (await request('GET', '/api/auth/status', as(zc))).json();
  assert.equal(zs.workspace.role, 'owner');
  assert.notEqual(zs.workspace.id, 'w1');
  assert.equal((await request('GET', '/api/server/health', as(zc))).status, 404);
  assert.equal((await request('POST', '/api/server/mail-test', { body: {}, ...as(zc) })).status, 404);
  assert.equal((await request('GET', '/api/server/health')).status, 401, 'signed out');
  // and on a hosted server nobody is shown folders of its disk, the operator neither
  assert.equal((await request('GET', '/api/onboarding/folders', as(owner))).status, 404);
  assert.equal((await request('GET', '/api/onboarding/agents', as(owner))).status, 404);
});

test('the routes are in the permission table, people only', async () => {
  const { ruleFor, personOnly } = await import('../../server/permissions.ts');
  for (const [m, p] of [
    ['GET', '/api/server/health'],
    ['POST', '/api/server/mail-test'],
  ] as const) {
    assert.deepEqual(ruleFor(m, p), { rule: 'self', listed: true }, 'the route itself asks who runs the server');
    assert.equal(personOnly(m, p), true);
  }
});
