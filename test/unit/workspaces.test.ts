// Workspaces, the model: where each one's files live, the move of a hosted store to workspaces (a backup first,
// nothing moved, idempotent), createWorkspace — the seam sign-up calls —, memberships and their rules, and the
// guarantee that work which loses its workspace is refused instead of reading workspace #1.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { WorkspaceChange } from '../../lib/workspaces.ts';
import { isolatedEnv, vr } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: 'http://review.test' } });
const DATA = path.join(dir, 'data');
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const paths = await import('../../lib/paths.ts');
const scope = await import('../../lib/scope.ts');
const store = await import('../../lib/store.ts');
const { storage, workspaceKey } = await import('../../lib/storage/index.ts');
const { heavy } = await import('../../lib/jobs.ts');
const oauth = await import('../../lib/oauth/store.ts');
const shares = await import('../../lib/shares.ts');

const owner = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'olivias password', role: 'owner' });
const mia = await auth.createUser({ email: 'mia@example.com', name: 'Mia', password: 'mias password 1', role: 'reviewer' });
const { info: oldToken } = auth.createToken(owner.id, 'laptop');
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(DATA, rel), 'utf8'));

test('before the move: workspace #1 alone, its members every account with its own role, nothing written', () => {
  assert.equal(ws.isMigrated(), false);
  assert.deepEqual(ws.workspaceIds(), ['w1']);
  assert.equal(ws.roleIn('w1', owner.id), 'owner');
  assert.equal(ws.roleIn('w1', mia.id), 'reviewer');
  assert.equal(ws.homeWorkspace(mia.id), 'w1');
  assert.equal(fs.existsSync(ws.WORKSPACES_FILE), false);
  // the store is where it always was
  assert.deepEqual(paths.workspaceRoot('w1'), { data: paths.DATA, versions: paths.VERSIONS, cache: paths.CACHE });
  assert.equal(paths.dataDir(), paths.DATA, 'outside any workspace: #1 while it is the only one');
  assert.equal(scope.currentWorkspace(), 'w1');
});

test('workspace ids: w1 or w_ + 12 random characters; anything else is no path at all', () => {
  for (const bad of ['w2', 'w_ABCDEFGHIJKL', 'w_short', '../w1', 'w_abcdefghijkl/..', ''])
    assert.throws(() => paths.workspaceRoot(bad), /not a workspace id/, bad);
  const r = paths.workspaceRoot('w_abcdefghijkl');
  assert.equal(r.data, path.join(paths.DATA, 'w', 'w_abcdefghijkl'));
  assert.equal(r.versions, path.join(paths.VERSIONS, 'w', 'w_abcdefghijkl'));
  assert.equal(r.cache, path.join(paths.CACHE, 'w', 'w_abcdefghijkl'));
  assert.throws(() => scope.inWorkspace('w_nope', () => 1), /not a workspace id/);
  // `w` (the folder the others live in) is never a video of workspace #1
  assert.equal(paths.validSlug('w'), false);
});

test('createWorkspace: a store moves to workspaces first (a backup, w1 named outright), then the new one with its owner', () => {
  shares.createShare('__@uploads__Old__a.mp4', { label: 'Old link' });
  auth.createInvite({ role: 'member', email: 'nina@example.com', by: { id: owner.id, name: 'Olivia' } });
  const seen: WorkspaceChange[] = [];
  const off = ws.onWorkspaceChange((e) => seen.push(e));
  const usersBefore = read('users.json');
  const made = ws.createWorkspace({ name: '  Acme​ Studio ', ownerId: mia.id });
  off();
  assert.match(made.id, /^w_[a-z0-9]{12}$/);
  assert.equal(made.name, 'Acme Studio', 'cleaned of invisible characters');
  assert.deepEqual(seen, [{ type: 'created', workspace: made.id, members: 1, email: 'mia@example.com' }]);
  // the move: a backup of what it touched, before touching it
  const backups = fs.readdirSync(path.join(DATA, 'backups'));
  assert.equal(backups.length, 1);
  const backup = path.join(DATA, 'backups', backups[0] as string);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backup, 'users.json'), 'utf8')), usersBefore);
  assert.ok(fs.existsSync(path.join(backup, 'invites.json')) && fs.existsSync(path.join(backup, 'shares.json')));
  assert.equal(fs.statSync(path.join(backup, 'users.json')).mode & 0o777, 0o600);
  // workspace #1 is every account with its role; tokens and invites from before name it outright
  assert.equal(ws.isMigrated(), true);
  assert.equal(fs.statSync(ws.WORKSPACES_FILE).mode & 0o777, 0o600);
  const w1 = ws.getWorkspace('w1');
  assert.deepEqual(
    w1?.members.map((m) => [m.user, m.role]),
    [
      [owner.id, 'owner'],
      [mia.id, 'reviewer'],
    ],
  );
  assert.equal(read('users.json').tokens.find((t: { id: string }) => t.id === oldToken.id).workspace, 'w1');
  assert.ok(read('invites.json').invites.every((i: { workspace?: string }) => i.workspace === 'w1'));
  // nothing of workspace #1 moved: its link file is where it was, unchanged
  assert.equal(
    scope.inWorkspace('w1', () => shares.listShares()[0]?.label),
    'Old link',
  );
  // the new one: its owner, its own folders, nobody else
  assert.deepEqual(
    ws.membersOf(made.id).map((m) => [m.user, m.role]),
    [[mia.id, 'owner']],
  );
  for (const d of Object.values(paths.workspaceRoot(made.id))) assert.ok(fs.statSync(d).isDirectory(), d);
  assert.equal(ws.roleIn(made.id, owner.id), null, 'the owner of #1 is nobody in another team’s workspace');
  assert.equal(ws.roleIn(made.id, mia.id), 'owner');
  assert.equal(ws.homeWorkspace(mia.id), 'w1', 'a member of #1 starts there');
  assert.deepEqual(
    ws.myWorkspaces(mia.id, made.id).map((w) => [w.id, w.role, w.current]),
    [
      ['w1', 'reviewer', false],
      [made.id, 'owner', true],
    ],
  );
});

test('the move is idempotent: a second run touches nothing and makes no second backup', () => {
  const before = fs.readFileSync(ws.WORKSPACES_FILE, 'utf8');
  assert.deepEqual(ws.migrateWorkspaces(), { migrated: false, backup: null });
  assert.equal(fs.readFileSync(ws.WORKSPACES_FILE, 'utf8'), before);
  assert.equal(fs.readdirSync(path.join(DATA, 'backups')).length, 1);
});

test('createWorkspace refuses what it must: a missing or disabled owner, an empty or overlong name', () => {
  assert.throws(() => ws.createWorkspace({ name: 'X', ownerId: 'u_nobody' }), /no such account/);
  assert.throws(() => ws.createWorkspace({ name: ' ​ ', ownerId: owner.id }), /1–80/);
  assert.throws(() => ws.createWorkspace({ name: 'x'.repeat(81), ownerId: owner.id }), /1–80/);
});

test('once a second workspace exists, work that lost its workspace is refused instead of reading #1', async () => {
  const b = ws.listWorkspaces().find((w) => w.id !== 'w1')?.id as string;
  assert.throws(() => paths.dataDir(), scope.NoWorkspaceError);
  assert.throws(() => store.listReviews(), scope.NoWorkspaceError);
  assert.equal(
    scope.inWorkspace(b, () => paths.dataDir()),
    paths.workspaceRoot(b).data,
  );
  assert.equal(
    scope.inWorkspace('w1', () => paths.dataDir()),
    paths.DATA,
  );
  // a job queued for B runs for B, whichever workspace's job ends before it and starts it
  const order: string[] = [];
  const first = scope.inWorkspace('w1', () => heavy(() => new Promise((r) => setTimeout(() => r(order.push(scope.currentWorkspace())), 20))));
  const second = scope.inWorkspace(b, () => heavy(() => order.push(scope.currentWorkspace())));
  await Promise.all([first, second]);
  assert.deepEqual(order, ['w1', b]);
});

test('each workspace has its own store: the same video name in two workspaces is two videos, events in their own log', () => {
  const b = ws.listWorkspaces().find((w) => w.id !== 'w1')?.id as string;
  const slug = '__@uploads__Reels__intro.mp4';
  const make = (who: string) => {
    fs.mkdirSync(paths.reviewDir(slug), { recursive: true });
    fs.writeFileSync(
      paths.reviewFile(slug),
      JSON.stringify({ video: '/@uploads/Reels/intro.mp4', versions: [], comments: [], created: '2026-10-01T10:00:00+02:00', who }),
    );
  };
  scope.inWorkspace('w1', () => make('w1'));
  scope.inWorkspace(b, () => make(b));
  const listed = (w: string) => scope.inWorkspace(w, () => store.listReviews().map((r) => (r as unknown as { who: string }).who));
  assert.deepEqual(listed('w1'), ['w1']);
  assert.deepEqual(listed(b), [b], 'listings are cached per file, never per slug');
  assert.deepEqual(listed('w1'), ['w1']);
  scope.inWorkspace(b, () => store.logFolderEvent({ type: 'download', by: 'guest:x', folder: 'Reels', text: 'b only' }));
  assert.ok(fs.readFileSync(path.join(paths.workspaceRoot(b).data, 'events.jsonl'), 'utf8').includes('b only'));
  assert.ok(!fs.existsSync(path.join(paths.DATA, 'events.jsonl')) || !fs.readFileSync(path.join(paths.DATA, 'events.jsonl'), 'utf8').includes('b only'));
  // storage keys: #1 as always, others under w/<id>/
  assert.equal(
    scope.inWorkspace('w1', () => storage().localPath('versions/x/v1.mp4')),
    path.join(paths.VERSIONS, 'x', 'v1.mp4'),
  );
  assert.equal(
    scope.inWorkspace(b, () => storage().localPath('versions/x/v1.mp4')),
    path.join(paths.VERSIONS, 'w', b, 'x', 'v1.mp4'),
  );
  assert.equal(workspaceKey('versions/x/v1.mp4', b), `w/${b}/versions/x/v1.mp4`);
  assert.equal(workspaceKey('versions/x/v1.mp4', 'w1'), 'versions/x/v1.mp4');
});

test('memberships: invites join a workspace, accounts with an address join with their own password, owners stay', async () => {
  const b = ws.listWorkspaces().find((w) => w.id !== 'w1')?.id as string;
  // Olivia (owner of #1) is invited into B: she joins with her own account and password
  const { token } = auth.createInvite({
    role: 'member',
    email: 'olivia@example.com',
    by: { id: mia.id, name: 'Mia' },
    workspace: b,
    isMember: (u) => !!ws.roleIn(b, u.id),
  });
  // a wrong password changes nothing (the route answers it like a free address: lib/auth.ts acceptInvite)
  const wrong = await ws.acceptInviteIn(token, { name: 'Someone', email: 'olivia@example.com', password: 'not her password' });
  assert.deepEqual([wrong.kind, wrong.user.id, ws.roleIn(b, owner.id)], ['taken', owner.id, null]);
  const joined = await ws.acceptInviteIn(token, { name: 'Someone', email: 'olivia@example.com', password: 'olivias password' });
  assert.deepEqual([joined.kind, joined.user.id], ['in', owner.id]);
  assert.equal(ws.roleIn(b, owner.id), 'member');
  assert.equal(auth.getUser(owner.id)?.role, 'owner', 'her role in #1 is untouched');
  // a free address: a held account in no workspace, the invite kept for it until its address is confirmed
  const open = auth.createInvite({ role: 'admin', by: { id: mia.id, name: 'Mia' }, workspace: b });
  const held = await ws.acceptInviteIn(open.token, { name: 'Hal', email: 'hal@example.com', password: 'hals password 1' });
  assert.deepEqual([held.kind, auth.isGated(held.user), ws.workspacesOf(held.user.id).length], ['held', true, 0]);
  assert.equal(auth.peekInvite(open.token)?.role, 'admin', 'still pending');
  auth.confirmAddress(held.user.id, 'hal@example.com');
  assert.deepEqual(ws.placeSignup(held.user.id), { workspace: b, created: false });
  assert.equal(ws.roleIn(b, held.user.id), 'admin', 'the invite’s role, now that the address is confirmed');
  assert.equal(auth.peekInvite(open.token), null, 'and the invite is used');
  // inviting someone who is a member already is refused; an account elsewhere is not
  assert.throws(
    () =>
      auth.createInvite({ role: 'member', email: 'olivia@example.com', by: { id: mia.id, name: 'Mia' }, workspace: b, isMember: (u) => !!ws.roleIn(b, u.id) }),
    /already exists/,
  );
  // a new account in B: its name must differ from B's people only
  await assert.rejects(ws.createAccountIn(b, { email: 'other@example.com', name: 'Mia', password: 'another password', role: 'member' }), /taken/);
  const tom = await ws.createAccountIn(b, { email: 'tom@example.com', name: 'Tom', password: 'toms password 1', role: 'admin' });
  assert.equal(ws.roleIn(b, tom.id), 'admin');
  assert.equal(ws.roleIn('w1', tom.id), null, 'not a member of #1');
  assert.equal(auth.getUser(tom.id)?.role, 'reviewer', 'the account itself carries no role of #1');
  // the last owner stays; roles change; leaving takes the workspace's tokens with it, not the others
  await assert.rejects(ws.setMemberRole(b, mia.id, 'admin'), /last owner/);
  assert.throws(() => ws.removeMember(b, mia.id), /last owner/);
  await ws.setMemberRole(b, owner.id, 'admin');
  assert.equal(ws.roleIn(b, owner.id), 'admin');
  const inB = auth.createToken(owner.id, 'b', { workspace: b });
  const inW1 = auth.createToken(owner.id, 'w1');
  assert.deepEqual(ws.removeMember(b, owner.id), { account: false });
  assert.equal(auth.verifyToken(inB.token), null);
  assert.ok(auth.verifyToken(inW1.token), 'her token for #1 still works');
  // someone in no workspace any more has no account any more
  assert.deepEqual(ws.removeMember(b, tom.id), { account: true });
  assert.equal(auth.getUser(tom.id), null);
  // grants: an app allowed into B acts in B
  assert.equal(oauth.listApps(undefined, b).length, 0);
});

test('renaming a workspace; the CLI lists, creates and migrates', () => {
  const b = ws.listWorkspaces().find((w) => w.id !== 'w1')?.id as string;
  assert.equal(ws.renameWorkspace(b, 'Acme Films').name, 'Acme Films');
  assert.throws(() => ws.renameWorkspace('w_zzzzzzzzzzzz', 'X'), /no such workspace/);
  const list = vr(['admin', 'workspaces', '--json'], env);
  assert.equal(list.code, 0, list.err);
  const parsed = JSON.parse(list.out);
  assert.equal(parsed.migrated, true);
  assert.deepEqual(
    parsed.workspaces.map((w: { id: string; name: string }) => [w.id, w.name]),
    [
      ['w1', 'Workspace'],
      [b, 'Acme Films'],
    ],
  );
  const made = vr(['admin', 'workspaces', 'create', '--name', 'Third', '--owner', 'olivia@example.com', '--json'], env);
  assert.equal(made.code, 0, made.err);
  const third = JSON.parse(made.out);
  assert.equal(ws.roleIn(third.id, owner.id), 'owner');
  assert.match(vr(['admin', 'workspaces', 'migrate'], env).out, /nothing to do/);
  assert.match(vr(['admin', 'workspaces', 'create', '--name', 'X', '--owner', 'nobody@example.com'], env).err, /existing account/);
  // an invite for a workspace from the CLI
  const inv = vr(['admin', 'invite', '--workspace', third.id, '--email', 'zoe@example.com', '--json'], env);
  assert.equal(inv.code, 0, inv.err);
  assert.equal(JSON.parse(inv.out).invite.workspace, third.id);
  assert.match(vr(['admin', 'invite', '--workspace', 'w_nonexistent1'], env).err, /no workspace/);
});

test('on a person’s own machine there are no workspaces to create', () => {
  const r = vr(['admin', 'workspaces', 'create', '--name', 'X', '--owner', 'olivia@example.com'], { ...env, VR_MODE: '' });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /hosted server/);
});
