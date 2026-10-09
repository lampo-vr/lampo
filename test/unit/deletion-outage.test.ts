// A workspace deleted while its storage is down. The decision is made once it leaves the registry: the erasure log
// names it and the billing module hears it before anything that can fail (the accounts it leaves in none, its files),
// so an outage later in the sequence can't leave a workspace gone from the app that is still billed or that a restored
// backup would bring back. Its files stay until the storage answers again: the next maintenance pass erases what the log
// names and the registry no longer has — bounded per pass, never a workspace still in the registry, nothing at all while
// the registry can't be read. And the billing module's question, "was this workspace erased?", is answered from the
// erasure log alone: yes only for a deletion it records, never for a workspace merely missing from the registry (a blip,
// a restore), and no answer at all while the log can't be read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import type { CloudModule } from '../../server/extension.ts';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';
import { cookieFrom } from '../lib/http.ts';
import { mockBunny } from '../lib/mockStores.ts';

const PUBLIC = 'http://review.test';
const bunny = await mockBunny();
const { dir } = isolatedEnv({
  vars: {
    VR_MODE: 'server',
    VR_PUBLIC_URL: PUBLIC,
    VR_STORAGE: 'bunny',
    VR_BUNNY_ZONE: 'zone',
    VR_BUNNY_ACCESS_KEY: 'secret',
    VR_BUNNY_STORAGE_URL: bunny.url,
  },
});
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const ext = await import('../../server/extension.ts');
const deletion = await import('../../lib/deletion.ts');
const { ERASURES_FILE, listErasures, recordErasure } = await import('../../lib/erasure.ts');
const { rootStorage } = await import('../../lib/storage/index.ts');

const { ctx, request } = await startApp({ headers: { Host: 'review.test' } });
after(async () => {
  ctx.mail.stop();
  await bunny.close();
});

const PASSWORD = 'a long password';
const origin = { Origin: PUBLIC };
const host = ext.hostContext({ publicUrl: PUBLIC, who: ext.callerOf, sameOrigin: ext.sameOriginOf(PUBLIC) });
const erased = (w: string) => host.workspaceErased(w);
await auth.createUser({ email: 'olivia@example.com', name: 'Olivia Hart', password: PASSWORD, role: 'owner' });

/** A file in the bucket under `w/<id>/`, as a render or a reference would be. */
async function objectIn(w: string, name: string) {
  const file = path.join(dir, `${w}-${name}`);
  fs.writeFileSync(file, `bytes of ${name}`);
  await rootStorage().put(`w/${w}/versions/teaser/${name}`, file, { keep: true });
}
const objectsOf = (w: string) => [...bunny.objects.keys()].filter((k) => k.startsWith(`w/${w}/`));
const foldersOf = (w: string) => Object.values(ws.workspaceRoot(w)).filter((d) => fs.existsSync(d));

const heard: string[] = [];
const module: CloudModule = {
  name: 'test-billing',
  entitlements: {
    get: async () => null,
    canUpload: async () => ({ ok: true }),
    canAddMember: async () => ({ ok: true }),
    canAddVideo: async () => ({ ok: true }),
    canShare: async () => ({ ok: true }),
  },
  routes: [],
  workspaces: {
    deleted: async (e) => {
      heard.push(e.workspace);
    },
  },
};
ctx.extension = ext.createExtension(module, host);
let B = '';
let bobId = '';

test('the module asks the erasure log: erased only when it records the deletion, and no answer while it can’t be read', async () => {
  // the store has workspaces (as every hosted server's start makes it), and Bob's is one of them
  ws.migrateWorkspaces();
  const bob = await auth.createUser({ email: 'bob@example.com', name: 'Bob Lane', password: PASSWORD, role: 'member' });
  bobId = bob.id;
  B = ws.createWorkspace({ name: 'Kestrel Motion', ownerId: bob.id }).id;
  if (ws.roleIn('w1', bob.id)) ws.removeMember('w1', bob.id);
  await objectIn(B, 'v1.mp4');
  fs.writeFileSync(path.join(ws.workspaceRoot(B).data, 'notes.json'), '{"the team’s":"work"}');

  // no log yet: nothing was erased
  assert.equal(fs.existsSync(ERASURES_FILE), false);
  assert.equal(await erased(B), false);
  assert.equal(await erased('w1'), false);
  // a workspace the registry doesn't have is not therefore erased (a blip, a restore from before it was made)
  assert.equal(await erased('w_zzzzzzzzzzzz'), false);
  const kept = fs.readFileSync(ws.WORKSPACES_FILE);
  try {
    fs.writeFileSync(ws.WORKSPACES_FILE, '{"workspaces": [');
    assert.equal(await erased(B), false, 'a registry that can’t be read erases nothing');
  } finally {
    fs.writeFileSync(ws.WORKSPACES_FILE, kept, { mode: 0o600 });
  }
  // erased: the log records it
  recordErasure('workspace', 'w_erased000001', 'operator');
  assert.equal(await erased('w_erased000001'), true);
  assert.equal(await erased(B), false);
  // a log that can't be read gives no answer
  const log = fs.readFileSync(ERASURES_FILE);
  fs.rmSync(ERASURES_FILE);
  fs.mkdirSync(ERASURES_FILE);
  try {
    await assert.rejects(async () => erased('w_erased000001'));
    await assert.rejects(async () => erased(B));
  } finally {
    fs.rmSync(ERASURES_FILE, { recursive: true });
    fs.writeFileSync(ERASURES_FILE, log, { mode: 0o600 });
  }
  assert.equal(await erased('w_erased000001'), true);
});

test('deleted while the storage is down: out of the registry, written down and unbilled at once; the files wait', async () => {
  const login = await request('POST', '/api/auth/login', { body: { email: 'bob@example.com', password: PASSWORD }, headers: origin });
  assert.equal(login.status, 200, login.text);
  bunny.deleteStatus = 503;
  let r!: Awaited<ReturnType<typeof request>>;
  try {
    r = await request('POST', '/api/workspaces/current/delete', { body: { name: 'Kestrel Motion' }, headers: { Cookie: cookieFrom(login), ...origin } });
  } finally {
    bunny.deleteStatus = null;
  }
  assert.equal(ws.getWorkspace(B), null, 'out of the registry');
  assert.ok(
    listErasures().some((e) => e.kind === 'workspace' && e.id === B && e.by === 'owner'),
    'the erasure log names it: a restored backup can’t bring it back',
  );
  assert.equal(await erased(B), true, 'the module’s hourly round reads it as erased, even had its hook been lost');
  await ctx.extension.idle();
  assert.deepEqual(heard, [B], 'billing heard it');
  assert.equal(auth.getUser(bobId), null, 'Bob worked nowhere else');
  // the workspace is deleted for everyone, so the answer says so and its people are told; its files follow
  assert.equal(r.status, 200, r.text);
  // the outage kept them
  assert.equal(objectsOf(B).length, 1, 'its object is still in the bucket');
  assert.ok(foldersOf(B).length, 'its folders are still on the disk');
});

test('the next maintenance pass finishes it: the objects and the folders go, once; nothing else is touched', async () => {
  const w1Before = [...bunny.objects.keys()].filter((k) => !k.startsWith('w/'));
  const first = await deletion.finishDeletions();
  assert.deepEqual(first.erased, [B]);
  assert.deepEqual(first.failed, []);
  assert.deepEqual(objectsOf(B), [], 'the bucket holds nothing of it');
  assert.deepEqual(foldersOf(B), [], 'nor does the disk');
  assert.deepEqual(
    [...bunny.objects.keys()].filter((k) => !k.startsWith('w/')),
    w1Before,
  );
  const again = await deletion.finishDeletions();
  assert.deepEqual(again, { erased: [], failed: [], left: 0 }, 'nothing left to do');
});

test('a pass is bounded, keeps failures for the next one, and never erases a workspace the registry has', async () => {
  // three deletions the log names whose folders stayed (the storage down each time), and one restored from a backup
  const gone = ['w_aaaaaaaaaaa1', 'w_aaaaaaaaaaa2', 'w_aaaaaaaaaaa3'];
  for (const id of gone) {
    recordErasure('workspace', id, 'operator');
    fs.mkdirSync(ws.workspaceRoot(id).data, { recursive: true });
    await objectIn(id, 'v1.mp4');
  }
  const carol = await auth.createUser({ email: 'carol@example.com', name: 'Carol Reyes', password: PASSWORD, role: 'member' });
  const C = ws.createWorkspace({ name: 'Back from a backup', ownerId: carol.id }).id;
  if (ws.roleIn('w1', carol.id)) ws.removeMember('w1', carol.id);
  await objectIn(C, 'v1.mp4');
  recordErasure('workspace', C, 'owner');

  bunny.deleteStatus = 503;
  try {
    const failing = await deletion.finishDeletions({ max: 1 });
    assert.deepEqual(failing.erased, []);
    assert.equal(failing.failed.length, 1, 'one tried, refused');
    assert.equal(failing.left, 3, 'all three still wait');
  } finally {
    bunny.deleteStatus = null;
  }
  for (const id of gone) assert.equal(objectsOf(id).length, 1, `${id} kept while the storage was down`);

  const first = await deletion.finishDeletions({ max: 2 });
  assert.equal(first.erased.length, 2);
  assert.equal(first.left, 1);
  const second = await deletion.finishDeletions({ max: 2 });
  assert.equal(second.erased.length, 1);
  assert.deepEqual([...first.erased, ...second.erased].sort(), gone);
  for (const id of gone) {
    assert.deepEqual(objectsOf(id), []);
    assert.deepEqual(foldersOf(id), []);
  }
  // C is in the registry: a restore brought it back, and only `lampo admin erasures --apply` deletes it again
  assert.ok(ws.getWorkspace(C));
  assert.equal(objectsOf(C).length, 1);
  assert.ok(foldersOf(C).length);
});

test('while the registry can’t be read, a pass erases nothing', async () => {
  const id = 'w_bbbbbbbbbbb1';
  recordErasure('workspace', id, 'operator');
  fs.mkdirSync(ws.workspaceRoot(id).data, { recursive: true });
  await objectIn(id, 'v1.mp4');
  const kept = fs.readFileSync(ws.WORKSPACES_FILE);
  try {
    fs.writeFileSync(ws.WORKSPACES_FILE, 'not json');
    const r = await deletion.finishDeletions();
    assert.deepEqual(r.erased, []);
    assert.equal(objectsOf(id).length, 1);
    assert.ok(foldersOf(id).length);
  } finally {
    fs.writeFileSync(ws.WORKSPACES_FILE, kept, { mode: 0o600 });
  }
  assert.deepEqual((await deletion.finishDeletions()).erased, [id]);
});
