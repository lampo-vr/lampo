// The operator's funnel (server/routes/operator.ts): only an owner of the server's first workspace, signed in as
// themselves, on a hosted server, reads it; an admin or member there, the owner of any other workspace, a token, the
// app on a person's own machine are answered as if there were no such page. Before anything was counted it says so
// (`counting: false`); the module's own two steps arrive through the host (HostContext.funnel) and count once.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';
import { cookieFrom } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_SIGNUP: 'open' } });
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const { NO_EXTENSION, hostContext, placeSignupOf } = await import('../../server/extension.ts');

const { ctx, request } = await startApp({ headers: { Host: 'review.test' } });
const PASSWORD = 'a long password';
const origin = { Origin: PUBLIC };
const as = (cookie: string) => ({ headers: { Cookie: cookie, ...origin } });
async function signIn(email: string): Promise<string> {
  const r = await request('POST', '/api/auth/login', { body: { email, password: PASSWORD }, headers: origin });
  assert.equal(r.status, 200, r.text);
  return cookieFrom(r);
}

const ops = await auth.createUser({ email: 'ops@example.com', name: 'Ops', password: PASSWORD, role: 'owner' });
await auth.createUser({ email: 'ada@example.com', name: 'Ada', password: PASSWORD, role: 'admin' });
await auth.createUser({ email: 'max@example.com', name: 'Max', password: PASSWORD, role: 'member' });
const owner = await signIn('ops@example.com');
const admin = await signIn('ada@example.com');
const member = await signIn('max@example.com');

test('the operator reads the funnel; before anything was counted it says so', async () => {
  ctx.extension = { ...NO_EXTENSION, name: 'test-billing', billing: true };
  const r = await request('GET', '/api/operator/funnel', as(owner));
  assert.equal(r.status, 200, r.text);
  const f = r.json();
  assert.equal(f.counting, false);
  assert.equal(f.weeks, 8, 'eight weeks unless asked');
  assert.equal(f.cohorts.length, 8);
  assert.ok(f.cohorts.every((c: { signups: number }) => c.signups === 0));
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal((await request('GET', '/api/operator/funnel?weeks=12', as(owner))).json().cohorts.length, 12);
  for (const q of ['weeks=5', 'weeks=all', 'weeks=4&who=x']) assert.equal((await request('GET', `/api/operator/funnel?${q}`, as(owner))).status, 400, q);
});

test('a sign-up counts, and the module’s own steps arrive through the host once', async () => {
  const held = await auth.signUp({ email: 'zoe@example.com', name: 'Zoe', password: PASSWORD, mode: 'open', anyName: true });
  const zoe = 'made' in held && held.made ? held.made : assert.fail(JSON.stringify(held));
  const placed = placeSignupOf(zoe.id);
  assert.ok(placed.workspace && placed.own);
  const host = hostContext({ publicUrl: PUBLIC, who: () => null, sameOrigin: () => false });
  host.funnel?.(placed.workspace as string, 'plan_paid', { plan: 'team' });
  host.funnel?.(placed.workspace as string, 'trial_end', { active: false });
  host.funnel?.('w_nosuchthing0', 'plan_paid', { plan: 'team' });
  host.funnel?.(placed.workspace as string, 'signup' as never);
  const f = (await request('GET', '/api/operator/funnel?weeks=4', as(owner))).json();
  assert.equal(f.counting, true);
  const week = f.cohorts.at(-1);
  assert.equal(week.signups, 1);
  assert.equal(week.mature, false);
  assert.equal(week.reached.plan_paid, null, 'read once the week’s trials have ended');
  assert.equal(week.reached.trial_end, null);
  const { readFileSync } = await import('node:fs');
  const { FUNNEL_FILE } = await import('../../lib/funnel.ts');
  const steps = JSON.parse(readFileSync(FUNNEL_FILE, 'utf8')).workspaces[placed.workspace as string].steps;
  assert.deepEqual(Object.keys(steps).sort(), ['plan_paid', 'signup'], 'an idle trial’s end is no step; nothing of a module’s mistakes');
  assert.equal(steps.plan_paid.plan, 'team');
});

test('a trial’s end the module tells without `active`: the workspace’s own log says whether anything happened lately', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { eventsFile } = await import('../../lib/store.ts');
  const { FUNNEL_FILE } = await import('../../lib/funnel.ts');
  const { activeLately } = await import('../../server/extension.ts');
  const place = async (email: string) => {
    const held = await auth.signUp({ email, name: email.split('@')[0], password: PASSWORD, mode: 'open', anyName: true });
    const made = 'made' in held && held.made ? held.made : assert.fail(JSON.stringify(held));
    return placeSignupOf(made.id).workspace as string;
  };
  const said = (at: number) => ({ at: new Date(at).toISOString(), type: 'comment', by: 'Ivo', video: 'v', slug: 'v', session: null });
  const write = (w: string, at: number) => {
    fs.mkdirSync(path.dirname(eventsFile(w)), { recursive: true });
    fs.appendFileSync(eventsFile(w), `${JSON.stringify(said(at))}\n`);
  };
  const idle = await place('ivo@example.com');
  const busy = await place('una@example.com');
  const stale = await place('ole@example.com');
  write(busy, Date.now() - 2 * 86_400_000);
  write(stale, Date.now() - 4 * 86_400_000);
  assert.equal(activeLately(idle), false, 'nothing logged');
  assert.equal(activeLately(busy), true, 'two days ago');
  assert.equal(activeLately(stale), false, 'four days ago');
  const host = hostContext({ publicUrl: PUBLIC, who: () => null, sameOrigin: () => false });
  // the cloud module calls it once per trial from its sweep, without `active`
  for (const w of [idle, busy, stale]) host.funnel?.(w, 'trial_end', { plan: 'team' });
  const steps = (w: string) => Object.keys(JSON.parse(fs.readFileSync(FUNNEL_FILE, 'utf8')).workspaces[w]?.steps ?? {});
  assert.ok(steps(busy).includes('trial_end'), 'active at its end');
  assert.ok(!steps(idle).includes('trial_end') && !steps(stale).includes('trial_end'), 'idle trials’ ends are no step');
  // the module's own word, when it gives one, goes first
  host.funnel?.(stale, 'trial_end', { active: true });
  assert.ok(steps(stale).includes('trial_end'));
});

test('nobody else: admins and members of the first workspace, another workspace’s owner, tokens, signed out', async () => {
  for (const [who, c] of [
    ['admin', admin],
    ['member', member],
  ] as const) {
    const r = await request('GET', '/api/operator/funnel', as(c));
    assert.equal(r.status, 404, `${who}: ${r.text}`);
  }
  const lee = await auth.createUser({ email: 'lee@example.com', name: 'Lee', password: PASSWORD, role: 'member' });
  ws.createWorkspace({ name: 'Lee Films', ownerId: lee.id });
  if (ws.roleIn('w1', lee.id)) ws.removeMember('w1', lee.id);
  const leeC = await signIn('lee@example.com');
  assert.equal((await request('GET', '/api/auth/status', as(leeC))).json().workspace.role, 'owner');
  assert.equal((await request('GET', '/api/operator/funnel', as(leeC))).status, 404, 'a customer, not the operator');
  const byToken = await request('GET', '/api/operator/funnel', { headers: { Authorization: `Bearer ${auth.createToken(ops.id, 'script').token}` } });
  assert.equal(byToken.status, 403, byToken.text);
  assert.equal(byToken.json().person, true);
  assert.equal((await request('GET', '/api/operator/funnel')).status, 401);
});

test('the app on a person’s own machine has no operator', async () => {
  ctx.hosted = false;
  try {
    assert.equal((await request('GET', '/api/operator/funnel', as(owner))).status, 404);
  } finally {
    ctx.hosted = true;
  }
});
