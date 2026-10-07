// `vr watch` and the stdio MCP server's change feed follow the event log of the workspace their process works in
// (VR_WORKSPACE), never workspace #1's (audit A12, WS-2). An operator who runs an agent for team B on a hosted store
// must not feed it team A's notes, and B's agent must hear its own. Both workspaces hold a video of the same path, so
// the slug alone can't tell them apart.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { age, isolatedEnv, makeVideo, ROOT, sleep, vr, vrAsync } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: 'http://review.test' } });
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const store = await import('../../lib/store.ts');
const { inWorkspace } = await import('../../lib/scope.ts');
const { slugify } = await import('../../lib/paths.ts');
const { reviewUri } = await import('../../mcp/format.ts');

const owner = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'olivias password', role: 'owner' });
const bravo = ws.createWorkspace({ name: 'Bravo', ownerId: owner.id }).id;
const file = makeVideo(path.join(dir, 'proj/export/spot.mp4'), { dur: 1 });
age(file);
const slug = slugify(file);
for (const w of ['w1', bravo]) assert.equal(slugify(inWorkspace(w, () => store.createOrGetReview(file, { by: 'tester' })).review.video), slug);

const childEnv = { ...env, VR_REMOTE: '0', VR_WORKSPACE: bravo } as Record<string, string>;
const closers: (() => unknown)[] = [];
after(async () => {
  for (const c of closers) await c();
});

async function until(what: string, fn: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
let n = 0;
const note = (w: string, text: string) => inWorkspace(w, () => store.addComment(slug, { frame: ++n, text, author: 'Mia' }));

test('vr watch with VR_WORKSPACE prints its workspace’s notes, never workspace #1’s', async () => {
  const child = vrAsync(['watch', '--everyone'], childEnv);
  closers.push(() => child.kill());
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  child.stderr.on('data', (d) => {
    err += d;
  });
  await until('the watch to start', () => err.includes('lampo watch:'));
  await sleep(300);
  note('w1', 'ALPHA confidential note');
  note(bravo, 'bravo own note');
  await until('bravo’s note', () => out.includes('bravo own note'));
  await sleep(900);
  assert.doesNotMatch(out, /ALPHA/);
  child.kill();
});

test('the stdio MCP server with VR_WORKSPACE follows its workspace’s log', async () => {
  const c = new Client({ name: 'stdio-bravo', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'bin/vr-mcp')], env: childEnv, stderr: 'inherit' }));
  closers.push(() => c.close());
  const updates: string[] = [];
  c.setNotificationHandler('notifications/resources/updated', (u) => {
    updates.push(u.params.uri);
  });
  const sub = await c.listen({ resourceSubscriptions: ['vr://inbox', reviewUri(slug)] });
  note('w1', 'ALPHA second note');
  await sleep(1500);
  assert.equal(updates.length, 0, `nothing heard from workspace #1: ${updates.join(', ')}`);
  note(bravo, 'bravo second note');
  await until('bravo’s note', () => updates.includes('vr://inbox') && updates.includes(reviewUri(slug)));
  await sub.close();
  // and what its tools read is that workspace's too, whichever request runs them
  const open = await c.callTool({ name: 'get_open_notes', arguments: { video: slug, images: 'none' } });
  const text = (open.content as { type: string; text?: string }[]).map((p) => p.text ?? '').join('\n');
  assert.match(text, /bravo second note/);
  assert.doesNotMatch(text, /ALPHA/);
});

test('VR_WORKSPACE naming no workspace of this store: vr and the stdio MCP server refuse, in one sentence (A12-D1)', () => {
  const phantom = { ...childEnv, VR_WORKSPACE: 'w_nothere12345' };
  const r = vr(['ls'], phantom);
  assert.equal(r.code, 1);
  assert.equal(r.err.trim(), 'lampo: VR_WORKSPACE=w_nothere12345 is not a workspace of this store (lampo admin workspaces lists them)');
  assert.equal(r.out, '');
  const mcp = spawnSync(process.execPath, [path.join(ROOT, 'bin/vr-mcp')], { env: phantom, input: '', encoding: 'utf8', timeout: 20000 });
  assert.equal(mcp.status, 1);
  assert.equal(mcp.stderr.trim(), 'lampo-mcp: VR_WORKSPACE=w_nothere12345 is not a workspace of this store (lampo admin workspaces lists them)');
  // Nothing was made for it: no phantom store to find later.
  for (const root of [env.VR_DATA, env.VR_CACHE]) assert.equal(fs.existsSync(path.join(String(root), 'w', 'w_nothere12345')), false);
  // Not an id at all: one sentence too, no stack trace.
  const bad = vr(['ls'], { ...childEnv, VR_WORKSPACE: '../w1' });
  assert.equal(bad.code, 1);
  assert.equal(bad.err.trim().split('\n').length, 1, bad.err);
  // A workspace the store has, and none named (#1), still work.
  assert.equal(vr(['ls'], childEnv).code, 0);
  assert.equal(vr(['ls'], { ...childEnv, VR_WORKSPACE: '' }).code, 0);
});

test('vr admin with VR_WORKSPACE: list-users shows the roles in that workspace (never #1’s), invite and create-user work there (WS-2)', async () => {
  // Ben works in Bravo only, as its admin; his account's own `role` is workspace #1's mirror ("reviewer").
  const ben = await ws.createAccountIn(bravo, { email: 'ben@example.com', name: 'Ben', password: 'bens password 1', role: 'admin' });
  assert.equal(auth.getUser(ben.id)?.role, 'reviewer');
  const row = (out: string, email: string) => out.split('\n').find((l) => l.includes(email)) ?? '';

  const inBravo = vr(['admin', 'list-users'], childEnv);
  assert.equal(inBravo.code, 0, inBravo.err);
  assert.match(inBravo.out, new RegExp(`^roles in ${bravo} \\(Bravo\\)`));
  assert.match(row(inBravo.out, 'ben@example.com'), /^admin\s+ben@example\.com\s+Ben$/);
  assert.match(row(inBravo.out, 'olivia@example.com'), /^owner\s+olivia@example\.com\s+Olivia {2}\(also owner in w1\)$/);

  const inOne = vr(['admin', 'list-users'], { ...childEnv, VR_WORKSPACE: '' });
  assert.match(row(inOne.out, 'ben@example.com'), new RegExp(`^–\\s+ben@example\\.com\\s+Ben {2}\\(also admin in ${bravo}\\)$`), 'not a member of #1');
  assert.equal(vr(['admin', 'list-users', '--workspace', bravo], { ...childEnv, VR_WORKSPACE: '' }).out, inBravo.out);

  type Listed = { email: string; role: string | null; workspaces: { id: string; name: string; role: string }[] };
  const listed = (e: Record<string, string>) => JSON.parse(vr(['admin', 'list-users', '--json'], e).out) as Listed[];
  const b = listed(childEnv).find((u) => u.email === 'ben@example.com');
  assert.equal(b?.role, 'admin');
  assert.deepEqual(b?.workspaces, [{ id: bravo, name: 'Bravo', role: 'admin' }]);
  assert.equal(listed({ ...childEnv, VR_WORKSPACE: '' }).find((u) => u.email === 'ben@example.com')?.role, null);

  // What the command adds goes to that workspace too.
  const inv = JSON.parse(vr(['admin', 'invite', '--email', 'cara@example.com', '--json'], childEnv).out);
  assert.equal(inv.invite.workspace, bravo);
  const made = vr(['admin', 'create-user', '--email', 'dan@example.com', '--name', 'Dan', '--password', 'dans password 1'], childEnv);
  assert.equal(made.code, 0, made.err);
  const dan = auth.findUserByEmail('dan@example.com');
  assert.equal(ws.roleIn(bravo, String(dan?.id)), 'member');
  assert.equal(ws.roleIn('w1', String(dan?.id)), null);
});

test('vr admin invite says which workspace its link is for; invites and revoke-invite keep to the workspace they work in (VE1-3)', () => {
  const inOne = { ...childEnv, VR_WORKSPACE: '' };
  const told = vr(['admin', 'invite', '--role', 'owner', '--email', 'erin@example.com'], childEnv);
  assert.equal(told.code, 0, told.err);
  assert.match(told.out, new RegExp(`^invites a owner \\(erin@example\\.com\\) into workspace ${bravo} \\(Bravo\\); works once`, 'm'));
  const ours = JSON.parse(vr(['admin', 'invite', '--email', 'finn@example.com', '--json'], inOne).out).invite.id as string;

  const listed = vr(['admin', 'invites'], childEnv).out;
  assert.match(listed, new RegExp(`^invites into ${bravo} \\(Bravo\\); every workspace's: --all$`, 'm'));
  assert.match(listed, /erin@example\.com/);
  assert.doesNotMatch(listed, /finn@example\.com/, 'workspace #1’s invite is not Bravo’s');
  const every = vr(['admin', 'invites', '--all'], childEnv).out;
  assert.match(every, new RegExp(`erin@example\\.com .* ${bravo}$`, 'm'));
  assert.match(every, /finn@example\.com .* w1$/m);
  const json = JSON.parse(vr(['admin', 'invites', '--json'], childEnv).out) as { email?: string; workspace: string }[];
  assert.ok(json.every((i) => i.workspace === bravo));

  // #1's invite can't be revoked from Bravo by accident; in its own workspace it can
  const wrong = vr(['admin', 'revoke-invite', ours], childEnv);
  assert.notEqual(wrong.code, 0);
  assert.match(wrong.err, new RegExp(`no pending invite ${ours} in workspace ${bravo} \\(Bravo\\)`));
  const right = vr(['admin', 'revoke-invite', ours, '--workspace', 'w1'], childEnv);
  assert.equal(right.code, 0, right.err);
  assert.match(right.out, new RegExp(`^revoked ${ours} in workspace w1 `));
});
