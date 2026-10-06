// A store that moved to workspaces and then lost data/workspaces.json (a partial restore, a deleted file) or can't read
// it must fail closed. Without the file a store reads as workspace #1 alone with every account a member, so every other
// team would read the first one's work, and the next start would write that down for good (audit A12, WS-5). Instead
// nothing that asks for a membership answers, the move refuses to run, and the server doesn't start. A store that never
// moved (the app on a person's own machine) is untouched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { age, isolatedEnv, makeVideo, ROOT, sleep, tmpdir, vr } from '../lib/helpers.ts';
import { client, cookieFrom } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir, env } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');

const owner = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'olivias password', role: 'owner' });

/** The real process on a store: a hosted start, or the machine's. */
function start(store: string, extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'server/index.ts')], {
    env: {
      PATH: process.env.PATH,
      HOME: store,
      VR_DATA: path.join(store, 'data'),
      VR_CACHE: path.join(store, 'cache'),
      VR_CONFIG: path.join(store, 'none.json'),
      VR_PORT: '1',
      VR_STT: 'off',
      ...extra,
    },
    encoding: 'utf8',
    timeout: 20000,
  });
  return { status: r.status, err: r.stderr };
}
const hosted = { VR_MODE: 'server', VR_PUBLIC_URL: 'https://review.test', VR_TRUST_PROXY: 'loopback' };

test('a moved store without workspaces.json: no account becomes a member of #1, the move refuses, the server stays down', async () => {
  const b = ws.createWorkspace({ name: 'Bravo', ownerId: owner.id });
  const bob = await ws.createAccountIn(b.id, { email: 'bob@example.com', name: 'Bob', password: 'bobs password 1', role: 'owner' });
  assert.equal(ws.roleIn('w1', bob.id), null, 'Bob works in Bravo only');
  assert.equal(ws.roleIn('w1', owner.id), 'owner');
  const saved = fs.readFileSync(ws.WORKSPACES_FILE, 'utf8');

  fs.rmSync(ws.WORKSPACES_FILE);
  assert.throws(() => ws.roleIn('w1', bob.id), ws.WorkspacesLostError);
  assert.throws(() => ws.roleIn(b.id, bob.id), /workspaces\.json is missing, but this store moved to workspaces/);
  assert.throws(() => ws.isMigrated(), ws.WorkspacesLostError);
  assert.throws(() => ws.listWorkspaces(), ws.WorkspacesLostError);
  assert.throws(() => ws.migrateWorkspaces(), ws.WorkspacesLostError);
  assert.equal(fs.existsSync(ws.WORKSPACES_FILE), false, 'nothing re-derived and written down');

  const r = start(dir, hosted);
  assert.equal(r.status, 1, r.err);
  assert.match(r.err, /^video-review: .*workspaces\.json is missing, but this store moved to workspaces .*restore it from your backup/m);
  assert.doesNotMatch(r.err, /\n\s+at /, 'one plain sentence, no stack trace');
  assert.equal(fs.existsSync(ws.WORKSPACES_FILE), false, 'the start wrote nothing either');
  // the machine's start refuses the same store
  assert.equal(start(dir).status, 1);
  // and so does `vr`
  const listed = vr(['admin', 'workspaces', 'list'], env);
  assert.notEqual(listed.code, 0);
  assert.match(listed.err, /workspaces\.json is missing/);

  // unreadable is the same: nothing implied
  fs.writeFileSync(ws.WORKSPACES_FILE, '{"workspaces": [{"id": "w1", ');
  assert.throws(() => ws.roleIn('w1', bob.id), /workspaces\.json can't be read/);
  const bad = start(dir, hosted);
  assert.equal(bad.status, 1);
  assert.match(bad.err, /^video-review: .*workspaces\.json can't be read/m);

  // the file back: everything as it was
  fs.writeFileSync(ws.WORKSPACES_FILE, saved);
  assert.equal(ws.roleIn('w1', bob.id), null);
  assert.equal(ws.roleIn(b.id, bob.id), 'owner');
  assert.equal(ws.roleIn('w1', owner.id), 'owner');
});

test('every sign of the move counts on its own: a backup, a workspace folder with something in it, a stamped token', () => {
  const users = fs.readFileSync(path.join(dir, 'data', 'users.json'), 'utf8');
  const signs: [string, (data: string) => void][] = [
    ['a backup', (data) => fs.mkdirSync(path.join(data, 'backups', 'workspaces-20261002T120000-abcdef'), { recursive: true })],
    [
      'a workspace folder with something in it',
      (data) => {
        fs.mkdirSync(path.join(data, 'w', 'w_abcdefghijkl', 'spot.mp4'), { recursive: true });
        fs.writeFileSync(path.join(data, 'w', 'w_abcdefghijkl', 'spot.mp4', 'review.json'), '{}');
      },
    ],
    [
      'a stamped token',
      (data) => {
        const f = JSON.parse(users);
        f.tokens = [{ id: 't_1', user: owner.id, name: 'laptop', hash: 'x', created: '2026-10-01T10:00:00+02:00', workspace: 'w1' }];
        fs.writeFileSync(path.join(data, 'users.json'), JSON.stringify(f));
      },
    ],
  ];
  for (const [what, make] of signs) {
    const store = tmpdir('vr-lost-');
    const data = path.join(store, 'data');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'users.json'), users);
    make(data);
    const r = start(store, hosted);
    assert.equal(r.status, 1, what);
    assert.match(r.err, /workspaces\.json is missing, but this store (moved to workspaces|has workspace folders)/, what);
  }
});

test('a mistyped VR_WORKSPACE on the machine makes nothing, and a stray empty workspace folder never stops the app (VC-2)', () => {
  const store = tmpdir('vr-typo-');
  const data = path.join(store, 'data');
  const machine = {
    PATH: process.env.PATH,
    HOME: store,
    VR_DATA: data,
    VR_CACHE: path.join(store, 'cache'),
    VR_CONFIG: path.join(store, 'none.json'),
    VR_STT: 'off',
  };
  const file = makeVideo(path.join(store, 'proj', 'spot.mp4'), { dur: 1 });
  age(file);
  assert.equal(vr(['track', file], machine).code, 0);
  const typo = vr(['track', file], { ...machine, VR_WORKSPACE: 'w_abcdefghijkl' });
  assert.equal(typo.code, 1);
  assert.match(typo.err, /^vr: VR_WORKSPACE=w_abcdefghijkl is not a workspace of this store/);
  for (const root of [data, `${data}-versions`, path.join(store, 'cache')]) assert.equal(fs.existsSync(path.join(root, 'w')), false, `nothing made in ${root}`);
  // The app's start gets past its workspace check: it stops at the next step here, a cloud module that isn't there.
  const startsPast = (what: string) => {
    const r = start(store, { VR_CLOUD_MODULE: path.join(store, 'no-such-module.js') });
    assert.equal(r.status, 1, what);
    assert.match(r.err, /^video-review: VR_CLOUD_MODULE could not be loaded/m, `${what}: ${r.err}`);
    assert.doesNotMatch(r.err, /workspaces\.json/, what);
  };
  startsPast('a store that never moved');
  // An empty folder for a workspace (an older `vr` made one for a mistyped id) proves nothing: the app starts, `vr` works.
  fs.mkdirSync(path.join(data, 'w', 'w_abcdefghijkl', 'spot.mp4'), { recursive: true });
  startsPast('a stray empty workspace folder');
  assert.equal(vr(['ls'], machine).code, 0);
  // One with files in it does stop the start; the sentence names the folder and what to do, never a backup there isn't.
  fs.writeFileSync(path.join(data, 'w', 'w_abcdefghijkl', 'spot.mp4', 'review.json'), '{}');
  const r = start(store);
  assert.equal(r.status, 1);
  assert.match(r.err, /^video-review: .*workspaces\.json is missing, but this store has workspace folders with files in .* \(w_abcdefghijkl\)/m);
  assert.match(r.err, /if this store never had workspaces, those folders are left over .* move them out of /);
  assert.doesNotMatch(r.err, /backup/);
  assert.doesNotMatch(r.err, /\n\s+at /);
});

test('a store that never moved reads as before: workspace #1 alone, every account in it with its own role', () => {
  // A store that never moved marks nobody outside #1 (only a moved one does).
  const f = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'users.json'), 'utf8'));
  for (const u of f.users) delete u.outside_w1;
  const users = JSON.stringify(f);
  for (const mode of [{ VR_MODE: 'local' }, { VR_MODE: 'server' }]) {
    const store = tmpdir('vr-fresh-');
    fs.mkdirSync(path.join(store, 'data'), { recursive: true });
    fs.writeFileSync(path.join(store, 'data', 'users.json'), users);
    const r = vr(['admin', 'workspaces', 'list', '--json'], { ...env, ...mode, VR_DATA: path.join(store, 'data'), VR_CACHE: path.join(store, 'cache') });
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out);
    assert.equal(out.migrated, false);
    assert.deepEqual(
      out.workspaces.map((w: { id: string; members: number }) => [w.id, w.members]),
      [['w1', 2]],
    );
  }
});

test('a running server whose workspaces.json goes away answers 503 in one sentence and stays up; a failed read is never kept (VC-1)', async () => {
  const { loadConfig } = await import('../../lib/config.ts');
  const { createContext } = await import('../../server/context.ts');
  const { createApp } = await import('../../server/app.ts');
  const { startServerFeed } = await import('../../server/feed.ts');
  const c = ws.createWorkspace({ name: 'Charlie', ownerId: owner.id });
  await ws.createAccountIn(c.id, { email: 'cleo@example.com', name: 'Cleo', password: 'cleos password 1', role: 'owner' });
  const saved = fs.readFileSync(ws.WORKSPACES_FILE, 'utf8');
  const ctx = createContext({ cfg: loadConfig(), token: 'unused' });
  const server = http.createServer(createApp(ctx));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const request = client(port, { Host: 'review.test' });
  // What the process logs, and anything that would have ended it (a timer that throws: the feed's tick, the streams' ping).
  const crashes: unknown[] = [];
  const crash = (e: unknown) => crashes.push(e);
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
  const logged: string[] = [];
  const { error, log } = console;
  console.error = (...a: unknown[]) => logged.push(a.join(' '));
  console.log = (...a: unknown[]) => logged.push(a.join(' '));
  const feed = startServerFeed(ctx, 30);
  ctx.hub.startPing(30);
  try {
    const login = await request('POST', '/api/auth/login', { body: { email: 'cleo@example.com', password: 'cleos password 1' }, headers: { Origin: PUBLIC } });
    assert.equal(login.status, 200, login.text);
    const cookie = cookieFrom(login);
    assert.equal((await request('GET', '/api/library', { headers: { cookie } })).status, 200);
    // Cleo's live stream, open while the file goes
    const stream = await new Promise<http.IncomingMessage>((ok) =>
      http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { Host: 'review.test', cookie } }, ok),
    );
    assert.equal(stream.statusCode, 200);
    stream.resume();
    const ended = new Promise<void>((r) => stream.on('close', r));

    fs.rmSync(ws.WORKSPACES_FILE);
    await sleep(400); // a dozen ticks of the feed and pings of the stream
    assert.deepEqual(crashes, [], 'nothing ended the process');
    await ended; // the stream is cut: whether Cleo may still read can't be told
    const r = await request('GET', '/api/library', { headers: { cookie } });
    assert.equal(r.status, 503);
    assert.equal(r.json().error, 'the server can’t read its list of workspaces right now: try again later');
    assert.equal((await request('GET', '/api/auth/status', { headers: { cookie } })).status, 503);
    const ready = await request('GET', '/readyz');
    assert.equal(ready.status, 503);
    assert.equal(ready.json().checks.data, false);
    const lostLines = logged.filter((l) => /^video-review: .*workspaces\.json is missing, but this store moved/.test(l));
    assert.equal(lostLines.length, 1, `said once, not per tick or request:\n${logged.join('\n')}`);
    assert.ok(!logged.some((l) => /\n\s+at /.test(l)), 'no stack trace per request');

    // A read that fails for a moment (here: no permission; root reads anything) is a 503 too, and is never kept: once
    // the file can be read again it counts, though it is the same file as when the read failed (inode, size, mtime).
    fs.writeFileSync(ws.WORKSPACES_FILE, saved);
    if (process.getuid?.() !== 0) {
      fs.chmodSync(ws.WORKSPACES_FILE, 0o000);
      assert.equal((await request('GET', '/api/library', { headers: { cookie } })).status, 503);
      assert.throws(() => ws.roleIn('w1', owner.id), /workspaces\.json can't be read \(EACCES\)/);
      fs.chmodSync(ws.WORKSPACES_FILE, 0o600);
    }
    assert.equal((await request('GET', '/api/library', { headers: { cookie } })).status, 200);
    assert.equal((await request('GET', '/readyz')).status, 200);
    await sleep(100);
    assert.ok(logged.includes('workspaces: the list of workspaces can be read again'), logged.join('\n'));
    assert.deepEqual(crashes, []);
  } finally {
    console.error = error;
    console.log = log;
    process.off('uncaughtException', crash);
    process.off('unhandledRejection', crash);
    feed.stop();
    server.closeAllConnections();
    server.close();
    if (!fs.existsSync(ws.WORKSPACES_FILE)) fs.writeFileSync(ws.WORKSPACES_FILE, saved);
    fs.chmodSync(ws.WORKSPACES_FILE, 0o600);
  }
});

test('on a hosted store an empty workspace folder still proves the move, and nobody who left #1 or was made for another team has a role there to come back to (VE1-2)', async () => {
  // Frank was an admin of #1, joined Delta and left #1; Erin was made for Delta. Delta is new and empty.
  const delta = ws.createWorkspace({ name: 'Delta', ownerId: owner.id });
  const frank = await ws.createAccountIn('w1', { email: 'frank@example.com', name: 'Frank', password: 'franks password 1', role: 'admin' });
  ws.addMember(delta.id, frank.id, 'member');
  ws.removeMember('w1', frank.id);
  const erin = await ws.createAccountIn(delta.id, { email: 'erin@example.com', name: 'Erin', password: 'erins password 1', role: 'member' });
  for (const u of [frank, erin]) {
    const stored = auth.getUser(u.id);
    assert.equal(stored?.role, 'reviewer', `${u.name}: no role of #1's on the account`);
    assert.equal(stored?.outside_w1, true);
    assert.equal('outside_w1' in auth.publicUser(stored as NonNullable<typeof stored>), false, 'never sent to anyone');
  }
  const users = fs.readFileSync(path.join(dir, 'data', 'users.json'), 'utf8');
  const cloud = (store: string) => ({ ...hosted, VR_CLOUD_MODULE: path.join(store, 'no-such-module.js') });
  const storeWith = (make: (data: string) => void) => {
    const store = tmpdir('vr-empty-ws-');
    const data = path.join(store, 'data');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'users.json'), users);
    make(data);
    return store;
  };

  // The file lost, the move's backup pruned, no token, invite or app outside #1 — only Delta's empty folder: refused, with
  // both ways out (a folder alone can't tell a moved store from one that kept a stray folder; the Info of VE1r2).
  const empty = storeWith((data) => fs.mkdirSync(path.join(data, 'w', delta.id), { recursive: true }));
  const r = start(empty, cloud(empty));
  assert.equal(r.status, 1);
  assert.match(
    r.err,
    new RegExp(
      `^video-review: .*workspaces\\.json is missing, but this store has workspace folders in .*${delta.id}.*if this store had workspaces, restore it from your backup.*; if it never had`,
      'm',
    ),
  );
  assert.equal(fs.existsSync(path.join(empty, 'data', 'workspaces.json')), false, 'nothing written down');

  // With every sign gone too, the store reads as never moved: Frank and Erin are no members of #1 (Frank no admin), and
  // the move a hosted start makes writes #1 down without them.
  const none = storeWith(() => {});
  const listed = JSON.parse(vr(['admin', 'list-users', '--json'], { ...env, VR_DATA: path.join(none, 'data'), VR_CACHE: path.join(none, 'cache') }).out);
  const roleOf = (email: string) => listed.find((u: { email: string }) => u.email === email)?.role;
  assert.equal(roleOf('olivia@example.com'), 'owner');
  assert.equal(roleOf('frank@example.com'), null);
  assert.equal(roleOf('erin@example.com'), null);
  assert.match(start(none, cloud(none)).err, /VR_CLOUD_MODULE could not be loaded/);
  const written = JSON.parse(fs.readFileSync(path.join(none, 'data', 'workspaces.json'), 'utf8'));
  const w1 = written.workspaces[0].members.map((m: { user: string }) => m.user);
  assert.ok(w1.includes(owner.id));
  assert.ok(!w1.includes(frank.id) && !w1.includes(erin.id));

  // An account from before the mirror was kept (Frank as he was: "admin", no mark) gets it at the next hosted start.
  const stale = storeWith((data) => {
    const f = JSON.parse(users);
    const u = f.users.find((x: { id: string }) => x.id === frank.id);
    u.role = 'admin';
    delete u.outside_w1;
    fs.writeFileSync(path.join(data, 'users.json'), JSON.stringify(f));
    fs.copyFileSync(ws.WORKSPACES_FILE, path.join(data, 'workspaces.json'));
  });
  assert.match(start(stale, cloud(stale)).err, /VR_CLOUD_MODULE could not be loaded/);
  const after = JSON.parse(fs.readFileSync(path.join(stale, 'data', 'users.json'), 'utf8')).users.find((x: { id: string }) => x.id === frank.id);
  assert.equal(after.role, 'reviewer');
  assert.equal(after.outside_w1, true);
});

test('a hosted store read by a `vr` without VR_MODE=server is still read as hosted, and the move never writes #1 alone over workspace folders (VE1r2-3)', async () => {
  const echo = ws.createWorkspace({ name: 'Echo', ownerId: owner.id });
  await ws.createAccountIn(echo.id, { email: 'gil@example.com', name: 'Gil', password: 'gils password 12', role: 'owner' });
  const users = fs.readFileSync(path.join(dir, 'data', 'users.json'), 'utf8');
  /** An operator's shell outside the container: the store's folders, no VR_MODE. */
  const shell = (store: string) => ({
    PATH: process.env.PATH,
    HOME: store,
    VR_DATA: path.join(store, 'data'),
    VR_CACHE: path.join(store, 'cache'),
    VR_CONFIG: path.join(store, 'none.json'),
    VR_STT: 'off',
  });
  // S10: the file lost, the backups pruned, only Echo's folder left (empty: nobody in Echo uploaded yet).
  const store = tmpdir('vr-shell-');
  const data = path.join(store, 'data');
  fs.mkdirSync(path.join(data, 'w', echo.id), { recursive: true });
  fs.writeFileSync(path.join(data, 'users.json'), users);
  const listed = vr(['admin', 'list-users'], shell(store));
  assert.equal(listed.code, 1, 'read by its shape: a hosted store (accounts, none of them the machine’s own)');
  assert.match(listed.err, /workspaces\.json is missing, but this store has workspace folders in .*\(w_[a-z0-9]{12}\)/);
  const moved = vr(['admin', 'workspaces', 'migrate'], shell(store));
  assert.equal(moved.code, 1, moved.out);
  assert.match(moved.err, /if this store had workspaces, restore it from your backup of .*; if it never had/);
  assert.equal(fs.existsSync(path.join(data, 'workspaces.json')), false, 'nothing written');
  assert.equal(fs.readFileSync(path.join(data, 'users.json'), 'utf8'), users, 'no token or invite stamped either');

  // The machine's own store with a stray empty folder: read as ever (VC-2), but the move refuses until it is moved out.
  const mine = tmpdir('vr-mine-');
  const mineData = path.join(mine, 'data');
  fs.mkdirSync(path.join(mineData, 'w', 'w_abcdefghijkl'), { recursive: true });
  const f = JSON.parse(users);
  f.users = [{ ...f.users.find((u: { id: string }) => u.id === owner.id), local: true }];
  f.tokens = [];
  fs.writeFileSync(path.join(mineData, 'users.json'), JSON.stringify(f));
  assert.equal(vr(['admin', 'list-users'], shell(mine)).code, 0, 'reads go on');
  const typo = vr(['admin', 'workspaces', 'migrate'], shell(mine));
  assert.equal(typo.code, 1);
  assert.match(typo.err, /workspace folders in .*\(w_abcdefghijkl\).* move those folders out of /);
  assert.equal(fs.existsSync(path.join(mineData, 'workspaces.json')), false);
  fs.rmSync(path.join(mineData, 'w'), { recursive: true });
  assert.equal(vr(['admin', 'workspaces', 'migrate'], shell(mine)).code, 0, 'once they are out of the way it moves');
  assert.equal(fs.existsSync(path.join(mineData, 'workspaces.json')), true);
});
