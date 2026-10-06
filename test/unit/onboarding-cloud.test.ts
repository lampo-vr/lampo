// The setup's server side on a server open to sign-ups (Lampo Cloud's shape): the website's plan rides with a sign-up
// through its confirm link (known ids only), the setup is over once it says so and keeps the agent picked, and who the
// workspace's videos are for is its owners' and admins' to say — people only, checked by zod, kept on the workspace,
// shown to its members in /api/auth/status, ordering Get started — and never shows in another workspace.
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';
import type { Reply } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_SIGNUP: 'open', VR_TRUST_PROXY: 'loopback' } });
const auth = await import('../../lib/auth.ts');
type User = import('../../lib/auth.ts').User;
const ws = await import('../../lib/workspaces.ts');
const { readOutbox } = await import('../../lib/mail/index.ts');

const { ctx, request } = await startApp({ headers: { Connection: 'close', Host: 'review.test' } });
after(() => ctx.mail.stop());

const OUTBOX = path.join(dir, 'cache', 'outbox');
const origin = { Origin: PUBLIC };
const cookiesOf = (r: Reply) =>
  [r.headers['set-cookie']]
    .flat()
    .filter(Boolean)
    .map((c) => String(c).split(';')[0])
    .join('; ');
let n = 0;
const somewhere = () => ({ 'X-Forwarded-For': `198.51.100.${(n++ % 250) + 1}` });
const send = (method: string, url: string, body: unknown, headers: Record<string, string> = {}) =>
  request(method, url, { body, headers: { ...origin, ...somewhere(), ...headers } });
const get = (url: string, headers: Record<string, string>) => request('GET', url, { headers: { ...somewhere(), ...headers } });

/** Confirms an address from the outbox's newest confirm link, in the browser of `made` (its cookie): the session. */
async function confirm(email: string, made: Reply): Promise<Record<string, string>> {
  await ctx.mail.flush();
  const mail = readOutbox(OUTBOX)
    .filter((m) => m.to === email && m.kind === 'verify')
    .at(-1);
  const token = /#\/verify\/(vt_[\w-]+)/.exec(mail?.text ?? '')?.[1];
  assert.ok(token, `a confirm link went to ${email}`);
  const done = await send('POST', '/api/auth/verify', { token }, { Cookie: cookiesOf(made) });
  assert.equal(done.status, 200, done.text);
  return { Cookie: cookiesOf(done) };
}

/** Signs up (with whatever `extra` the website's link carried), confirms from the outbox, and returns the session. */
async function signUp(email: string, name: string, extra: Record<string, unknown> = {}): Promise<Record<string, string>> {
  const made = await send('POST', '/api/auth/signup', { name, email, password: 'a long enough password', lang: 'en', ...extra });
  assert.equal(made.status, 200, made.text);
  return confirm(email, made);
}

let ana: Record<string, string>;
test('the website’s plan rides with the sign-up through its confirm link; anything else is ignored', async () => {
  ana = await signUp('ana@example.com', 'Ana Lima', { plan: 'cloud-team' });
  const status = (await get('/api/auth/status', ana)).json();
  assert.equal(status.user.prefs.onboarding.plan, 'cloud-team', 'on the account, past the confirm link');
  assert.equal(status.user.prefs.onboarding.setup_due, true);
  assert.equal((await get('/api/onboarding', ana)).json().plan, 'cloud-team', 'Get started offers it');

  const other = await signUp('ben@example.com', 'Ben Ode', { plan: 'cloud-enterprise' });
  const benStatus = (await get('/api/auth/status', other)).json();
  assert.equal(benStatus.user.prefs.onboarding.plan, undefined, 'an unknown id is dropped, not refused');
  assert.equal((await get('/api/onboarding', other)).json().plan, null);
  // too long is a malformed request, like any other field
  assert.equal(
    (await send('POST', '/api/auth/signup', { name: 'C', email: 'c@example.com', password: 'a long enough password', plan: 'x'.repeat(41) })).status,
    400,
  );
});

test('the setup is over once it says so, and keeps the agent picked in it', async () => {
  const picked = await send('PUT', '/api/onboarding', { agent: 'cursor' }, ana);
  assert.equal(picked.status, 200, picked.text);
  assert.deepEqual([picked.json().onboarding.agent, picked.json().onboarding.setup_done], ['cursor', undefined]);
  assert.equal((await send('PUT', '/api/onboarding', { agent: 'gemini' }, ana)).status, 400, 'known agents only');
  assert.equal((await send('PUT', '/api/onboarding', { setup: 'skipped' }, ana)).status, 400);
  const over = await send('PUT', '/api/onboarding', { setup: 'done', agent: 'claude-code' }, ana);
  assert.equal(over.status, 200, over.text);
  const o = over.json().onboarding;
  assert.match(o.setup_done, /^\d{4}-/);
  assert.equal(o.setup_due, true, 'the mark that it was due stays');
  assert.equal(o.agent, 'claude-code');
  const again = await send('PUT', '/api/onboarding', { setup: 'done' }, ana);
  assert.equal(again.json().onboarding.setup_done, o.setup_done, 'the first time is kept');
  assert.equal((await get('/api/auth/status', ana)).json().user.prefs.onboarding.setup_done, o.setup_done, 'every device knows');
});

test('the first run is the person’s own: an API token can’t end a setup, put Get started away or pick the agent (ONB-2)', async () => {
  const ivo = await signUp('ivo@example.com', 'Ivo');
  const me = auth.findUserByEmail('ivo@example.com');
  assert.ok(me);
  const { token } = auth.createToken(me.id, 'script', { workspace: ws.signupWorkspaceOf(me.id) ?? undefined });
  const before = (await get('/api/onboarding', ivo)).json().onboarding;
  for (const change of [{ setup: 'done' }, { hidden: true }, { agent: 'codex' }]) {
    const r = await send('PUT', '/api/onboarding', change, { Authorization: `Bearer ${token}` });
    assert.equal(r.status, 403, `${JSON.stringify(change)}: ${r.text}`);
    assert.equal(r.json().person, true, 'a person’s act');
  }
  const after = (await get('/api/onboarding', ivo)).json().onboarding;
  assert.deepEqual([after.setup_done, after.hidden, after.agent], [before.setup_done, before.hidden, before.agent], 'nothing changed');
  assert.equal((await send('PUT', '/api/onboarding', { hidden: true }, ivo)).status, 200, 'the person themselves may');
});

test('who the videos are for: the owner says it, zod checks it, the workspace keeps it, Get started follows it', async () => {
  const put = (body: unknown, headers = ana) => send('PUT', '/api/workspaces/current/persona', body, headers);
  assert.deepEqual(
    (await get('/api/onboarding', ana)).json().steps.map((s: { id: string }) => s.id),
    ['sample', 'agent', 'video', 'share', 'invite'],
  );
  const r = await put({ personas: ['inhouse', 'other'], personaOther: '  Training\nvideos  ' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json().workspace.personas, r.json().workspace.personaOther], [['inhouse', 'other'], 'Training videos'], 'one line');
  const status = (await get('/api/auth/status', ana)).json();
  assert.deepEqual(status.workspace.personas, ['inhouse', 'other'], 'members read it with the workspace');
  assert.equal(ws.getWorkspace(status.workspace.id)?.personaOther, 'Training videos');
  assert.deepEqual(
    (await get('/api/onboarding', ana)).json().steps.map((s: { id: string }) => s.id),
    ['sample', 'agent', 'invite', 'video', 'share'],
    'an in-house team invites before it uploads',
  );
  // "something else" without its pick is not kept
  const plain = await put({ personas: ['creator'], personaOther: 'ignored' });
  assert.deepEqual([plain.json().workspace.personas, plain.json().workspace.personaOther], [['creator'], undefined]);
  assert.deepEqual(
    (await get('/api/onboarding', ana)).json().steps.map((s: { id: string }) => s.id),
    ['sample', 'agent', 'video', 'share'],
    'a channel alone invites nobody',
  );
  // zod: unknown kinds, a pick twice, too many, extra fields, too many words
  for (const bad of [
    { personas: ['studio'] },
    { personas: ['agency', 'agency'] },
    { personas: ['agency', 'inhouse', 'creator', 'other', 'agency'] },
    { personas: [], extra: 1 },
    { personas: ['other'], personaOther: 'x'.repeat(121) },
    {},
  ])
    assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
  const cleared = await put({ personas: [] });
  assert.equal(cleared.json().workspace.personas, undefined, 'an empty list clears them');
});

test('only owners and admins say it, and only as people (an API token is refused); another workspace never sees it', async () => {
  const anaUser = auth.findUserByEmail('ana@example.com') as User;
  const anaWs = (await get('/api/auth/status', ana)).json().workspace.id as string;
  await send('PUT', '/api/workspaces/current/persona', { personas: ['agency'] }, ana);
  // a member of Ana's workspace (invited) may read it but not change it; Get started's order is a member's own
  const inv = await send('POST', '/api/admin/invites', { role: 'member', email: 'mia@example.com' }, ana);
  assert.equal(inv.status, 200, inv.text);
  const token = /inv_[A-Za-z0-9_-]{32}/.exec(inv.json().url)?.[0];
  const acc = await send('POST', '/api/auth/invite/accept', { token, name: 'Mia', email: 'mia@example.com', password: 'mias long password' });
  assert.equal(acc.status, 200, acc.text);
  // on a server with workspaces an invite proves no inbox: the address is confirmed first, then the invite taken
  const mia = acc.json().held ? await confirm('mia@example.com', acc) : { Cookie: cookiesOf(acc) };
  const miaStatus = (await get('/api/auth/status', mia)).json();
  assert.equal(miaStatus.workspace.id, anaWs);
  assert.deepEqual(miaStatus.workspace.personas, ['agency']);
  assert.equal((await send('PUT', '/api/workspaces/current/persona', { personas: ['creator'] }, mia)).status, 403, 'a member');
  const ob = (await get('/api/onboarding', mia)).json();
  assert.deepEqual(ob.invited_by, { name: 'Ana Lima', role: 'owner' }, 'who invited them, for their Welcome');
  // an API token of the owner's: a person's act only
  const { token: api } = auth.createToken(anaUser.id, 'script', { workspace: anaWs });
  const byToken = await send('PUT', '/api/workspaces/current/persona', { personas: ['creator'] }, { Authorization: `Bearer ${api}` });
  assert.equal(byToken.status, 403, byToken.text);
  assert.equal(byToken.json().person, true);
  // Ben's workspace is his own: Ana's picks never show there, his never in hers
  const ben = (await send('POST', '/api/auth/login', { email: 'ben@example.com', password: 'a long enough password' })).headers;
  const benCookie = {
    Cookie: [ben['set-cookie']]
      .flat()
      .filter(Boolean)
      .map((c) => String(c).split(';')[0])
      .join('; '),
  };
  const benStatus = (await get('/api/auth/status', benCookie)).json();
  assert.notEqual(benStatus.workspace.id, anaWs);
  assert.equal(benStatus.workspace.personas, undefined);
  assert.equal((await send('PUT', '/api/workspaces/current/persona', { personas: ['creator'] }, benCookie)).status, 200);
  assert.deepEqual((await get('/api/auth/status', ana)).json().workspace.personas, ['agency'], 'Ana’s as it was');
  assert.equal((await get('/api/onboarding', benCookie)).json().invited_by, null, 'nobody invited Ben');
});

test('the routes are in the permission table, people only', async () => {
  const { ruleFor, personOnly } = await import('../../server/permissions.ts');
  assert.deepEqual(ruleFor('PUT', '/api/workspaces/current/persona'), { rule: 'admin', listed: true });
  assert.equal(personOnly('PUT', '/api/workspaces/current/persona'), true);
  assert.deepEqual(ruleFor('PUT', '/api/onboarding'), { rule: 'self', listed: true });
  assert.equal(personOnly('PUT', '/api/onboarding'), true);
});
