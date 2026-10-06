// Who runs the server is one rule (lib/operator.ts isOperator): LAMPO_OPERATOR when it names anyone, else the owners of
// the first workspace. Everything that is the server's rather than a workspace's goes by it — the funnel and the admin
// pages, `operator` in /api/auth/status (the account menu's way there, the server's setup), the speech engine's model
// path and last error in /api/info, the server's health check, and making workspaces (VR_WORKSPACE_CREATE=owners, no
// limit with anyone). A role in workspace #1 is no part of it: on a live server someone invited there as an owner was
// walked through the server's setup. With the list set, the owner who set the server up and an owner and an admin
// invited into #1 get none of it; the listed operator, a member there, gets all of it; unset, #1's owners do again.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';
import { cookieFrom } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_STT: 'local', VR_STT_PREFETCH: '0' } });
const MODEL = path.join(dir, 'srv', 'models', 'whisper-house-finetune.gguf');
process.env.VR_STT_MODEL = MODEL;
const auth = await import('../../lib/auth.ts');
const { operatorList } = await import('../../lib/config.ts');
const { setupVariant } = await import('../../lib/onboarding.ts');

const { ctx, request } = await startApp({ headers: { Host: 'review.test' } });
const PASSWORD = 'a long enough password';
const origin = { Origin: PUBLIC };
const as = (cookie: string) => ({ headers: { Cookie: cookie, ...origin } });

// Olivia set the server up (its first workspace's owner); Noor works in it as a member and is the one LAMPO_OPERATOR
// names; Ivan and Ada were invited into it as an owner and an admin.
const setup = await request('POST', '/api/auth/setup', {
  body: { email: 'olivia@example.com', name: 'Olivia Hart', password: PASSWORD, token: ctx.setup.token },
  headers: origin,
});
assert.equal(setup.status, 200, setup.text);
const olivia = cookieFrom(setup);
async function invited(role: 'owner' | 'admin', name: string, email: string): Promise<string> {
  const made = await request('POST', '/api/admin/invites', { body: { role, email }, ...as(olivia) });
  assert.equal(made.status, 200, made.text);
  const token = /inv_[A-Za-z0-9_-]{32}/.exec(made.json().url)?.[0];
  const took = await request('POST', '/api/auth/invite/accept', { body: { token, name, email, password: PASSWORD }, headers: origin });
  assert.equal(took.status, 200, took.text);
  return cookieFrom(took);
}
const ivan = await invited('owner', 'Ivan Petrov', 'ivan@example.com');
const ada = await invited('admin', 'Ada Brooks', 'ada@example.com');
await auth.createUser({ email: 'noor@example.com', name: 'Noor Haddad', password: PASSWORD, role: 'member' });
const login = await request('POST', '/api/auth/login', { body: { email: 'noor@example.com', password: PASSWORD }, headers: origin });
assert.equal(login.status, 200, login.text);
const noor = cookieFrom(login);

const status = async (cookie: string) => (await request('GET', '/api/auth/status', as(cookie))).json();
/** What one person gets of the server's own, as the matrix's rows. */
async function grants(cookie: string) {
  const st = await status(cookie);
  return {
    funnel: (await request('GET', '/api/operator/funnel', as(cookie))).status,
    workspaces: (await request('GET', '/api/operator/workspaces', as(cookie))).status,
    accounts: (await request('GET', '/api/operator/accounts', as(cookie))).status,
    statusOperator: st.operator === true,
    speechPath: (await request('GET', '/api/info', as(cookie))).json().stt.model === MODEL,
    health: (await request('GET', '/api/server/health', as(cookie))).status,
    mayCreate: st.workspace_create === true,
    setup: setupVariant({
      role: st.user.role,
      machine: st.via === 'local',
      signupWorkspace: !!st.workspace?.signup,
      firstWorkspace: !st.workspace || st.workspace.id === 'w1',
      invited: !!st.workspace?.invited,
      operator: !!st.operator,
    }),
  };
}
const NONE = { funnel: 404, workspaces: 404, accounts: 404, statusOperator: false, speechPath: false, health: 404, mayCreate: false };
const ALL = { funnel: 200, workspaces: 200, accounts: 200, statusOperator: true, speechPath: true, health: 200, mayCreate: true };
const without = <T extends { setup: unknown }>(g: T) => {
  const { setup: _s, ...rest } = g;
  return rest;
};

test('LAMPO_OPERATOR set: the owner who set the server up, an owner and an admin invited into #1 get none of it', async () => {
  ctx.cfg.operators = operatorList('noor@example.com');
  try {
    for (const [who, cookie] of [
      ['the owner who set the server up, not on the list', olivia],
      ['an owner invited into #1', ivan],
      ['an admin invited into #1', ada],
    ] as const) {
      const g = await grants(cookie);
      assert.deepEqual(without(g), NONE, who);
      assert.equal(g.setup, 'invited', `${who}: a teammate's setup, never the server's`);
    }
    assert.deepEqual(without(await grants(noor)), ALL, 'the listed operator, a member of #1, gets all of it');
    // making a workspace: refused to them, not to her
    const make = (cookie: string, name: string) => request('POST', '/api/workspaces', { body: { name }, ...as(cookie) });
    for (const c of [olivia, ivan, ada]) assert.equal((await make(c, 'Side project')).status, 403);
    assert.equal((await make(noor, 'Operations')).status, 200);
  } finally {
    ctx.cfg.operators = [];
  }
});

test('anyone may make workspaces (VR_WORKSPACE_CREATE=anyone): a few each, and no limit for the listed operator only', async () => {
  const before = { create: ctx.cfg.workspace_create, limit: ctx.cfg.workspace_create_limit };
  ctx.cfg.operators = operatorList('noor@example.com');
  ctx.cfg.workspace_create = 'anyone';
  ctx.cfg.workspace_create_limit = 1;
  try {
    const make = (cookie: string, name: string) => request('POST', '/api/workspaces', { body: { name }, ...as(cookie) });
    assert.equal((await make(ivan, 'Ivan’s first')).status, 200);
    const second = await make(ivan, 'Ivan’s second');
    assert.equal(second.status, 403, `an owner of #1 not on the list has the limit: ${second.text}`);
    assert.equal((await status(ivan)).workspace_create, undefined);
    // Noor made one in the test above: more, as many as she needs
    for (const name of ['Operations 2', 'Operations 3']) assert.equal((await make(noor, name)).status, 200, name);
    assert.equal((await status(noor)).workspace_create, true);
  } finally {
    ctx.cfg.operators = [];
    ctx.cfg.workspace_create = before.create;
    ctx.cfg.workspace_create_limit = before.limit;
  }
});

test('the list names an id too; unset, the first workspace’s owners run the server again', async () => {
  const ids = Object.fromEntries(auth.listUsers().map((u) => [u.email, u.id]));
  ctx.cfg.operators = operatorList(ids['olivia@example.com']);
  try {
    const g = await grants(olivia);
    assert.deepEqual(without(g), ALL, 'listed by id');
    assert.equal(g.setup, 'server', 'the server’s setup is the operator’s');
    assert.deepEqual(without(await grants(noor)), NONE, 'no longer listed');
  } finally {
    ctx.cfg.operators = [];
  }
  // unset: #1's owners (the fallback that keeps a self-hosted server from locking itself out), never its admins
  assert.deepEqual(without(await grants(olivia)), ALL);
  assert.deepEqual(without(await grants(ada)), NONE, 'an admin of #1');
  assert.deepEqual(without(await grants(noor)), NONE, 'a member of #1');
  assert.equal((await grants(olivia)).setup, 'server');
  assert.equal((await grants(ivan)).setup, 'invited', 'an invited owner never gets the server’s setup');
});
