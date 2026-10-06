// Who makes workspaces on a hosted server (A12-D9). Whoever runs one invites and mails people and takes turns in the
// job queue, so by default only whoever runs the server makes them (VR_WORKSPACE_CREATE=owners; lib/operator.ts: no
// LAMPO_OPERATOR here, so the owners of workspace #1).
// An instance that lets anyone make them (anyone) gives each account a few (VR_WORKSPACE_CREATE_LIMIT, 3), counted on
// the server across restarts: the workspaces it made, the one sign-up gave it included; the operator has no limit.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { User } from '../../lib/auth.ts';
import type { Config } from '../../lib/config.ts';
import { isolatedEnv } from '../lib/helpers.ts';
import { client } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');

const olivia = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
const rita = await auth.createUser({ email: 'rita@example.com', name: 'Rita', password: 'a long password', role: 'reviewer' });

/** A server with these settings, and a way to ask it as someone signed in in the browser. */
async function serve(cfg: Partial<Config>) {
  const ctx = createContext({ cfg: { ...loadConfig(), ...cfg }, token: 'unused' });
  const srv = http.createServer(createApp(ctx));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const request = client((srv.address() as AddressInfo).port, { Host: 'review.test', Origin: PUBLIC });
  const as = (u: User) => ({ headers: { Cookie: `vr_session=${auth.signSession(u)}` } });
  return {
    // what the route allows, and what the account menu offers (/api/auth/status): always the same answer
    may: async (u: User) => {
      const allowed = (await request('GET', '/api/workspaces', as(u))).json().create as boolean;
      const offered = (await request('GET', '/api/auth/status', as(u))).json().workspace_create === true;
      assert.equal(offered, allowed, `the account menu offers "New workspace…" exactly when it may: ${u.name}`);
      return allowed;
    },
    make: (u: User, name: string) => request('POST', '/api/workspaces', { body: { name }, ...as(u) }),
    close: () => {
      ctx.mail.stop();
      srv.close();
    },
  };
}

test('VR_WORKSPACE_CREATE is owners unless set to anyone; VR_WORKSPACE_CREATE_LIMIT is 3 unless set', () => {
  const env = { ...process.env };
  delete env.VR_WORKSPACE_CREATE;
  delete env.VR_WORKSPACE_CREATE_LIMIT;
  assert.equal(loadConfig(env).workspace_create, 'owners');
  assert.equal(loadConfig({ ...env, VR_WORKSPACE_CREATE: 'anyone' }).workspace_create, 'anyone');
  assert.equal(loadConfig({ ...env, VR_WORKSPACE_CREATE: 'everyone' }).workspace_create, 'owners', 'anything else is the safe one');
  assert.equal(loadConfig(env).workspace_create_limit, 3);
  assert.equal(loadConfig({ ...env, VR_WORKSPACE_CREATE_LIMIT: '10' }).workspace_create_limit, 10);
  assert.equal(loadConfig({ ...env, VR_WORKSPACE_CREATE_LIMIT: '0' }).workspace_create_limit, 0);
  assert.equal(loadConfig({ ...env, VR_WORKSPACE_CREATE_LIMIT: 'lots' }).workspace_create_limit, 3);
});

test('A12-D9: by default only the owners of workspace #1 make workspaces, as many as they need', async () => {
  const s = await serve({});
  try {
    assert.equal(await s.may(rita), false);
    const refused = await s.make(rita, 'Side project');
    assert.equal(refused.status, 403, refused.text);
    assert.match(refused.json().error, /only whoever runs it makes new workspaces/);
    assert.equal(await s.may(olivia), true);
    for (const name of ['Client A', 'Client B', 'Client C', 'Client D']) assert.equal((await s.make(olivia, name)).status, 200, name);
    assert.equal(await s.may(olivia), true, 'the operator’s team has no limit');
    assert.equal(ws.workspacesMadeBy(olivia.id), 4);
  } finally {
    s.close();
  }
});

test('A12-D9: where anyone may, each account makes a few — counted on the server, the one sign-up gave included', async () => {
  const s = await serve({ workspace_create: 'anyone', workspace_create_limit: 2 });
  try {
    assert.equal(await s.may(rita), true);
    assert.equal((await s.make(rita, 'Side project')).status, 200);
    assert.equal((await s.make(rita, 'Other project')).status, 200);
    assert.equal(await s.may(rita), false, 'the app stops offering it');
    const third = await s.make(rita, 'One more');
    assert.equal(third.status, 403, third.text);
    assert.match(third.json().error, /at most 2 workspaces/);
    // A sign-up's own workspace is one of them; a workspace made before `by` was kept counts for its first owner.
    const pia = await auth.createUser({ email: 'pia@example.com', name: 'Pia', password: 'a long password', role: 'reviewer' });
    const own = ws.createWorkspace({ name: 'Pia', ownerId: pia.id, signup: true });
    const file = JSON.parse(fs.readFileSync(ws.WORKSPACES_FILE, 'utf8')) as { workspaces: { id: string; by?: string }[] };
    for (const w of file.workspaces) if (w.id === own.id) delete w.by;
    fs.writeFileSync(ws.WORKSPACES_FILE, JSON.stringify(file));
    assert.equal(ws.workspacesMadeBy(pia.id), 1);
    assert.equal((await s.make(pia, 'Second')).status, 200);
    assert.equal((await s.make(pia, 'Third')).status, 403);
    // Owners of workspace #1 have none.
    for (const name of ['Client E', 'Client F', 'Client G']) assert.equal((await s.make(olivia, name)).status, 200, name);
  } finally {
    s.close();
  }
  // A restart forgets nothing: the count is the server's, not a timer's.
  const again = await serve({ workspace_create: 'anyone', workspace_create_limit: 2 });
  try {
    assert.equal((await again.make(rita, 'After a restart')).status, 403);
  } finally {
    again.close();
  }
});
