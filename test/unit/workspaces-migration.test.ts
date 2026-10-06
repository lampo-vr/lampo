// The move of a hosted store to workspaces, on a copy of a real-shaped store: one made by the app itself (people in
// every role, a disabled one, API tokens, invites pending, used and revoked, an app connected through OAuth, videos with
// versions, notes, replies and verdicts, a video and a folder review link with a visitor, folders, the House playbook,
// what someone put aside, who watched, a draft) plus a review link from before tokens were hashed. The copy is moved
// with `vr admin workspaces migrate`; the original in-process, the way a hosted server's start does. Nothing moves and
// nothing changes but the stamps, the backup holds the files as they were, the app answers exactly as before, and a
// second run does nothing.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { User } from '../../lib/auth.ts';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, sleep, tmpdir, vr } from '../lib/helpers.ts';
import { tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir, env } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const grants = await import('../../lib/oauth/store.ts');
const paths = await import('../../lib/paths.ts');
const { readOutbox } = await import('../../lib/mail/index.ts');

const { ctx, request } = await startApp({ headers: { Host: 'review.test' } });

const PASSWORD = 'a long password';
const origin = { Origin: PUBLIC };
const enc = encodeURIComponent;
const ok = <T extends { status: number; text: string }>(r: T, what: string): T => {
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text.slice(0, 200)}`);
  return r;
};

let ownerToken = '';
let ownerCookie = '';
let linkToken = '';
let pendingInvite = '';
let slug = '';
const before_: Record<string, string> = {};

/** Every file of a tree with its hash (locks and temp files aside). */
function treeOf(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const f = path.join(d, e.name);
      if (e.name === '.lock' || e.name.endsWith('.tmp')) continue;
      if (e.isDirectory()) walk(f);
      else out.set(path.relative(root, f), crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'));
    }
  };
  walk(root);
  return out;
}

test('a real-shaped hosted store, made by the app before workspaces', async () => {
  const owner = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: PASSWORD, role: 'owner' });
  await auth.createUser({ email: 'ada@example.com', name: 'Ada', password: PASSWORD, role: 'admin' });
  await auth.createUser({ email: 'max@example.com', name: 'Max', password: PASSWORD, role: 'member' });
  const rita = await auth.createUser({ email: 'rita@example.com', name: 'Rita', password: PASSWORD, role: 'reviewer' });
  const gone = await auth.createUser({ email: 'gone@example.com', name: 'Gone', password: PASSWORD, role: 'member' });
  await auth.updateUser(gone.id, { disabled: true });
  ownerToken = auth.createToken(owner.id, 'laptop').token;
  auth.createToken(rita.id, 'ci', { days: 30 });
  const login = ok(await request('POST', '/api/auth/login', { body: { email: 'olivia@example.com', password: PASSWORD }, headers: origin }), 'login');
  ownerCookie = String([login.headers['set-cookie']].flat()[0]).split(';')[0];
  const asOwner = { Cookie: ownerCookie, ...origin };
  const bearer = { Authorization: `Bearer ${ownerToken}` };

  // videos with versions, notes, a reply, verdicts
  const clip = makeVideo(path.join(dir, 'in/spot.mp4'), { dur: 1 });
  age(clip);
  slug = ok(await tusUpload(request, clip, { filename: 'spot.mp4', folder: 'Acme/Reels' }, bearer), 'upload').json().slug;
  const clip2 = makeVideo(path.join(dir, 'in2/spot.mp4'), { dur: 1, pattern: 'smptebars' });
  age(clip2);
  ok(await tusUpload(request, clip2, { filename: 'spot.mp4', folder: 'Acme/Reels' }, bearer), 'v2');
  const other = makeVideo(path.join(dir, 'in/teaser.mp4'), { dur: 1, pattern: 'rgbtestsrc' });
  age(other);
  ok(await tusUpload(request, other, { filename: 'teaser.mp4', folder: 'Acme' }, bearer), 'teaser');
  const note = ok(
    await request('POST', `/api/review/${enc(slug)}/comments`, { body: { frame: 3, text: 'Logo later', severity: 'must' }, headers: asOwner }),
    'note',
  ).json();
  ok(await request('PATCH', `/api/comments/${note.id}`, { body: { note: 'agreed' }, headers: asOwner }), 'reply');
  ok(await request('PUT', `/api/review/${enc(slug)}/approval`, { body: { status: 'changes', note: 'one more pass', v: 2 }, headers: asOwner }), 'verdict');
  // review links: a video link visited, a folder link
  linkToken = ok(await request('POST', `/api/review/${enc(slug)}/shares`, { body: { label: 'Client' }, headers: asOwner }), 'link').json().token;
  ok(await request('POST', '/api/folder-shares', { body: { folder: 'Acme', label: 'Acme room' }, headers: asOwner }), 'folder link');
  ok(await request('GET', `/api/g/${linkToken}`), 'visit');
  // invites: pending, used, revoked
  pendingInvite = ok(await request('POST', '/api/admin/invites', { body: { role: 'member', email: 'nina@example.com' }, headers: asOwner }), 'invite')
    .json()
    .url.split('/#/invite/')[1];
  const used = ok(await request('POST', '/api/admin/invites', { body: { role: 'reviewer' }, headers: asOwner }), 'invite 2')
    .json()
    .url.split('/#/invite/')[1];
  ok(await request('POST', '/api/auth/invite/accept', { body: { token: used, name: 'Uma', email: 'uma@example.com', password: PASSWORD } }), 'accept');
  const revoked = ok(await request('POST', '/api/admin/invites', { body: { role: 'member' }, headers: asOwner }), 'invite 3').json().invite.id;
  ok(await request('DELETE', `/api/admin/invites/${revoked}`, { headers: asOwner }), 'revoke');
  // an app connected through OAuth (the grant as the token endpoint writes it)
  const req = grants.createRequest({
    client: {
      client_id: 'https://app.example.com/meta.json',
      name: 'Agent',
      host: 'app.example.com',
      kind: 'cimd',
      redirect_uris: ['https://app.example.com/cb'],
    } as never,
    redirect_uri: 'https://app.example.com/cb',
    state: null,
    code_challenge: crypto.createHash('sha256').update('v'.repeat(43)).digest('base64url'),
    scopes: ['review:read'],
    resource: `${PUBLIC}/mcp`,
  });
  const code = grants.createCode(req, owner);
  grants.redeemCode({ code, client_id: 'https://app.example.com/meta.json', redirect_uri: 'https://app.example.com/cb', code_verifier: 'v'.repeat(43) });
  // folders, the House playbook, what someone put aside, who watched, a draft
  ok(await request('POST', '/api/folders', { body: { path: 'Globex' }, headers: asOwner }), 'folder');
  ok(
    await request('PUT', '/api/playbook/text', { body: { section: 'rules', content: '- Logo on every end card', message: 'rules' }, headers: asOwner }),
    'playbook',
  );
  ok(await request('POST', '/api/for-you/dismiss', { body: { keys: ['x'] }, headers: asOwner }), 'dismiss');
  ok(await request('POST', `/api/review/${enc(slug)}/watch`, { body: { v: 2, seen: 'f'.repeat(25), secs: 3 }, headers: asOwner }), 'watch');
  ok(await request('POST', `/api/review/${enc(slug)}/drafts`, { body: { frame: 1, text: 'later' }, headers: asOwner }), 'draft');
  // a review link from before tokens were hashed (shares.json keyed by the token itself)
  const sharesFile = path.join(paths.DATA, 'shares.json');
  const shares = JSON.parse(fs.readFileSync(sharesFile, 'utf8'));
  shares.shares.oldlinkoldlinkoldlink123 = {
    slug,
    label: 'Old',
    created: '2026-01-01T10:00:00+01:00',
    by: 'Olivia',
    stats: { opens: 0, last_opened: null, reviewers: [] },
  };
  fs.writeFileSync(sharesFile, JSON.stringify(shares));
  await sleep(1000);
  assert.equal(ws.isMigrated(), false);
  for (const url of [
    '/api/library',
    `/api/review/${enc(slug)}`,
    '/api/admin/users',
    '/api/admin/invites',
    `/api/review/${enc(slug)}/shares`,
    '/api/auth/tokens',
  ]) {
    before_[url] = ok(await request('GET', url, { headers: { Cookie: ownerCookie } }), url).text;
  }
});

let copy = '';
test('the copy, moved with `vr admin workspaces migrate`: a backup first, stamps, the list — nothing else touched', () => {
  copy = tmpdir('vr-copy-');
  for (const d of ['data', 'data-versions']) fs.cpSync(path.join(dir, d), path.join(copy, d), { recursive: true });
  const original = { data: treeOf(path.join(copy, 'data')), versions: treeOf(path.join(copy, 'data-versions')) };
  const raw = (rel: string) => fs.readFileSync(path.join(copy, 'data', rel), 'utf8');
  const usersBefore = JSON.parse(raw('users.json'));
  const invitesBefore = JSON.parse(raw('invites.json'));
  const grantsBefore = JSON.parse(raw('oauth/grants.json'));
  const filesBefore = { users: raw('users.json'), invites: raw('invites.json'), grants: raw('oauth/grants.json'), shares: raw('shares.json') };
  const at = { ...env, VR_DATA: path.join(copy, 'data'), VR_CACHE: path.join(copy, 'cache') };
  const moved = vr(['admin', 'workspaces', 'migrate', '--json'], at);
  assert.equal(moved.code, 0, moved.err);
  const r = JSON.parse(moved.out);
  assert.equal(r.migrated, true);
  // the backup: the files it touched, as they were, readable by the server's user only
  assert.ok(r.backup.startsWith(path.join(copy, 'data', 'backups')));
  for (const [rel, text] of [
    ['users.json', filesBefore.users],
    ['invites.json', filesBefore.invites],
    ['oauth/grants.json', filesBefore.grants],
    ['shares.json', filesBefore.shares],
  ] as const) {
    assert.equal(fs.readFileSync(path.join(r.backup, rel), 'utf8'), text, rel);
    assert.equal(fs.statSync(path.join(r.backup, rel)).mode & 0o777, 0o600, rel);
  }
  // nothing moved and nothing changed — renders, reviews, events, links, playbooks, drafts — but these
  const after = { data: treeOf(path.join(copy, 'data')), versions: treeOf(path.join(copy, 'data-versions')) };
  assert.deepEqual(after.versions, original.versions, 'versions/ untouched');
  const touched = new Set(['users.json', 'invites.json', path.join('oauth', 'grants.json'), 'workspaces.json']);
  for (const [rel, hash] of original.data) if (!touched.has(rel)) assert.equal(after.data.get(rel), hash, rel);
  const added = [...after.data.keys()].filter((k) => !original.data.has(k));
  assert.deepEqual(
    added.filter((k) => !k.startsWith('backups')),
    ['workspaces.json'],
  );
  // the stamps: workspace #1 named outright, the rest of every record as it was
  const users = JSON.parse(raw('users.json'));
  assert.deepEqual(users.users, usersBefore.users, 'accounts as they were');
  assert.deepEqual(
    users.tokens.map(({ workspace, ...t }: { workspace: string }) => {
      assert.equal(workspace, 'w1');
      return t;
    }),
    usersBefore.tokens,
  );
  assert.deepEqual(
    JSON.parse(raw('invites.json')).invites.map(({ workspace, ...i }: { workspace: string }) => {
      assert.equal(workspace, 'w1');
      return i;
    }),
    invitesBefore.invites,
  );
  assert.deepEqual(
    JSON.parse(raw('oauth/grants.json')).grants.map(({ workspace, ...g }: { workspace: string }) => {
      assert.equal(workspace, 'w1');
      return g;
    }),
    grantsBefore.grants,
  );
  // the list: workspace #1 with every account (the disabled one too) in its role
  const list = JSON.parse(raw('workspaces.json'));
  assert.equal(fs.statSync(path.join(copy, 'data', 'workspaces.json')).mode & 0o777, 0o600);
  assert.deepEqual(
    list.workspaces.map((w: { id: string }) => w.id),
    ['w1'],
  );
  assert.deepEqual(
    list.workspaces[0].members.map((m: { user: string; role: string }) => [m.user, m.role]),
    usersBefore.users.map((u: { id: string; role: string }) => [u.id, u.role]),
  );
});

test('the move is idempotent: a second run does nothing and makes no second backup', () => {
  const at = { ...env, VR_DATA: path.join(copy, 'data'), VR_CACHE: path.join(copy, 'cache') };
  const before = treeOf(path.join(copy, 'data'));
  const again = vr(['admin', 'workspaces', 'migrate', '--json'], at);
  assert.equal(again.code, 0, again.err);
  assert.deepEqual(JSON.parse(again.out), { migrated: false, backup: null });
  assert.deepEqual(treeOf(path.join(copy, 'data')), before);
  assert.equal(fs.readdirSync(path.join(copy, 'data', 'backups')).length, 1);
});

test('the original, moved the way a server’s start does: the app answers exactly as before', async () => {
  const r = ws.migrateWorkspaces();
  assert.equal(r.migrated, true);
  assert.equal(ws.isMigrated(), true);
  for (const [url, text] of Object.entries(before_)) {
    const now = ok(await request('GET', url, { headers: { Cookie: ownerCookie } }), url);
    assert.deepEqual(JSON.parse(now.text), JSON.parse(text), url);
  }
  // the token from before works, in workspace #1, as the owner
  const me = ok(await request('GET', '/api/auth/me', { headers: { Authorization: `Bearer ${ownerToken}` } }), 'me').json();
  assert.equal(me.role, 'owner');
  assert.equal(me.workspace.id, 'w1');
  // the review links work — the new-style one and the one from before hashed tokens
  assert.equal((await request('GET', `/api/g/${linkToken}`)).status, 200);
  assert.equal((await request('GET', '/api/g/oldlinkoldlinkoldlink123')).status, 200);
  // the pending invite still invites into workspace #1, and the person who takes it is a member there
  const peek = ok(await request('POST', '/api/auth/invite/peek', { body: { token: pendingInvite } }), 'peek').json();
  assert.equal(peek.role, 'member');
  const nina = ok(
    await request('POST', '/api/auth/invite/accept', { body: { token: pendingInvite, name: 'Nina', email: 'nina@example.com', password: PASSWORD } }),
    'accept',
  );
  // (a store with workspaces: held until the address is confirmed, then a member)
  assert.deepEqual(nina.json(), { held: true });
  await ctx.mail.flush();
  const link = /#\/verify\/(vt_[\w-]+)/.exec(
    readOutbox(path.join(dir, 'cache', 'outbox'))
      .filter((m) => m.to === 'nina@example.com')
      .at(-1)?.text ?? '',
  )?.[1];
  // (opened elsewhere than the browser that took the invite: with the password chosen there)
  const confirmed = ok(await request('POST', '/api/auth/verify', { body: { token: link, password: PASSWORD } }), 'confirm');
  assert.equal(ws.roleIn('w1', confirmed.json().user.id), 'member');
  // the disabled account stays disabled, and roles are what they were
  assert.equal(ws.roleIn('w1', (auth.findUserByEmail('gone@example.com') as User).id), null);
  assert.equal(ws.roleIn('w1', (auth.findUserByEmail('rita@example.com') as User).id), 'reviewer');
});
