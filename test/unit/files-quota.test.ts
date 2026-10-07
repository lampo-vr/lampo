// covers: lib/files.ts server/routes/files.ts server/routes/uploads.ts server/routes/library.ts
// Project files and the plan's storage, on a hosted server: what isn't counted is bounded. The safety net (the trash,
// replaced versions) holds at most its cap — a quarter of the plan, and never more than what the files count (or a
// floor) with no plan at all — and the oldest goes at once when it passes it, with its bytes. Uploads waiting for their
// commit count until committed or purged after their day, and nothing a push asks for (least of all one the plan
// refused) makes them younger. Whatever comes back (out of the trash, an older version) is checked against the plan.
// A file keeps a bounded number of older versions, and bringing back the bytes it has already makes nothing new.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';

const APP = 'review.test';
const MEDIA = 'media.review.test';
isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: `http://${APP}`, VR_MEDIA_ORIGIN: `http://${MEDIA}`, VR_FOOTAGE: 'off', VR_OCR: 'off' } });
const auth = await import('../../lib/auth.ts');
const files = await import('../../lib/files.ts');
const fileAreas = await import('../../lib/fileAreas.ts');
const { FILE_LIMITS } = await import('../../lib/fileText.ts');
const workspaces = await import('../../lib/workspaces.ts');
const { inWorkspace } = await import('../../lib/scope.ts');
const { refusal, usageOf } = await import('../../server/extension.ts');

const { port, ctx } = await startApp();

// The plan as the Cloud module decides it: what counts + what this asks for ≤ the plan's storage, else 402. What the
// module says the plan holds (`storageBytes`) is a separate knob: null is a module (or a server) that doesn't say.
const PLAN = 10_000;
let storage: number | null = PLAN;
const real = ctx.extension;
ctx.extension = {
  ...real,
  async check(w: string, gate: string, bytes = 0) {
    if (gate !== 'upload') return;
    const used = usageOf(w).bytes;
    if (used + bytes > PLAN)
      throw refusal({
        ok: false,
        reason: 'storage',
        message: `This workspace has ${PLAN} bytes of storage`,
        needed: bytes,
        room: { videos: 0, bytes: 0 },
        fits: 'team',
      });
  },
  storageBytes: async () => storage,
};

function raw(
  method: string,
  url: string,
  { host = APP, headers = {}, body }: { host?: string; headers?: Record<string, string>; body?: Buffer | string } = {},
) {
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
  return new Promise<{ status: number; text: string; json: () => any }>((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const h = { Host: host, ...(data ? { 'content-length': String(data.length) } : {}), ...headers };
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => {
        const b = Buffer.concat(chunks);
        resolve({ status: res.statusCode || 0, text: b.toString('utf8'), json: () => JSON.parse(b.toString('utf8')) });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}
const api = (method: string, url: string, who: Record<string, string>, body?: unknown) =>
  raw(method, url, {
    headers: { ...who, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

const member = await auth.createUser({ email: 'm@example.com', name: 'Member', password: 'a long password', role: 'member' });
const owner = await auth.createUser({ email: 'o@example.com', name: 'Owner', password: 'a long password', role: 'owner' });
const bea = await auth.createUser({ email: 'b@example.com', name: 'Bea', password: 'a long password', role: 'reviewer' });
workspaces.createWorkspace({ name: 'Other studio', ownerId: bea.id });
const asMember = { Authorization: `Bearer ${auth.createToken(member.id, 'agent', { workspace: 'w1' }).token}` };
const asOwner = { Authorization: `Bearer ${auth.createToken(owner.id, 'owner agent', { workspace: 'w1' }).token}` };

/** A push of one file, its bytes sent to its one-time URL: the push's answer, the PUT's. */
async function push(p: string, data: Buffer, extra: object = {}, who: Record<string, string> = asMember) {
  const answer = await api('POST', '/api/files/uploads', who, { files: [{ path: p, size: data.length, sha256: sha(data) }], ...extra });
  if (answer.status !== 200) return { answer, put: null };
  const slot = answer.json().uploads[0];
  const put = slot.url ? await raw('PUT', new URL(slot.url).pathname, { host: MEDIA, body: data }) : null;
  return { answer, put };
}
/** The bytes of the workspace's blobs on this disk. */
const onDisk = (): number => {
  const dir = inWorkspace('w1', () => path.join(fileAreas.filesDir(), 'sha256'));
  let bytes = 0;
  const walk = (d: string) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else bytes += fs.statSync(path.join(d, e.name)).size;
    }
  };
  walk(dir);
  return bytes;
};
const usage = async () => (await api('GET', '/api/files/usage', asMember)).json();
/** Everything live to the trash, and the purge run as if a month had passed: a clean slate for the next test. */
async function clean() {
  storage = PLAN;
  const list = (await api('GET', '/api/files?deep=1&limit=1000', asMember)).json();
  for (const f of list.files) await api('DELETE', `/api/files/${f.id}`, asOwner);
  await inWorkspace('w1', () => files.purgeFiles({ now: Date.now() + 40 * 86_400_000, cap: 0 }));
  assert.equal(onDisk(), 0, 'a clean slate');
}
const shardOf = (h: string) => inWorkspace('w1', () => path.join(fileAreas.filesDir(), 'blobs', `${h.slice(0, 2)}.json`));
const blobAt = (h: string): string => JSON.parse(fs.readFileSync(shardOf(h), 'utf8'))[h].at;

const DAY = 86_400_000;
const CAP = PLAN * FILE_LIMITS.keptShare;
/** The purge as it runs `hours` from now (the hourly one, or the one a change sets off). */
const purgeIn = (hours: number) => inWorkspace('w1', () => files.purgeFiles({ now: Date.now() + hours * 3600e3 }));
const trash = async (who = asOwner) => (await api('GET', '/api/files/trash', who)).json();

test('a file bigger than the safety net’s cap stays restorable; what it holds over the cap counts until it may go', async () => {
  await clean();
  const big = await push('big.bin', crypto.randomBytes(3000), {}, asOwner);
  const id = big.put?.json().commit.files[0].id;
  const del = await api('DELETE', `/api/files/${id}`, asOwner);
  assert.equal(del.status, 200, del.text);
  // it went in just now: never taken early within its first day, and the answer says when it may go
  const goes = Date.parse(del.json().purge_at) - Date.parse(del.json().trashed_at);
  assert.ok(goes >= DAY - 2000 && goes <= DAY + 2000, `purge_at a day on (over the cap), not 30 days: ${del.json().purge_at}`);
  assert.deepEqual(
    (await trash()).files.map((f: { id: string }) => f.id),
    [id],
  );
  const u = await usage();
  assert.equal(u.kept_cap, CAP);
  assert.equal(u.over, 3000 - CAP, 'what it holds over the cap counts');
  assert.equal(u.bytes, 3000 - CAP);
  assert.equal(usageOf('w1').bytes, 3000 - CAP, 'and the plan sees it');
  // the excess counts: a push the plan only had room for before is refused
  const refused = await push('more.bin', crypto.randomBytes(9600));
  assert.equal(refused.answer.status, 402, refused.answer.text);
  // the purge leaves it alone within its day…
  assert.equal((await purgeIn(1)).trash, 0);
  assert.equal((await trash()).files.length, 1);
  // …and it is still the owner's to bring back
  const back = await api('POST', `/api/files/${id}/restore`, asOwner, {});
  assert.equal(back.status, 200, back.text);
  assert.equal((await usage()).over, 0);
  // trashed again: a day later it may go early (oldest first), and then the excess no longer counts
  assert.equal((await api('DELETE', `/api/files/${id}`, asOwner)).status, 200);
  const later = await purgeIn(25);
  assert.equal(later.trash, 1, JSON.stringify(later));
  assert.equal((await trash()).files.length, 0);
});

test('a member deleting a folder over the cap leaves every file in it restorable', async () => {
  await clean();
  assert.equal((await api('POST', '/api/folders', asOwner, { path: 'Proj' })).status, 200);
  await push('a.bin', crypto.randomBytes(3000), { folder: 'Proj' }, asOwner);
  await push('b.bin', crypto.randomBytes(3000), { folder: 'Proj' }, asOwner);
  const del = await api('DELETE', '/api/folders?path=Proj', asMember);
  assert.ok(del.status === 200 || del.status === 204, del.text);
  const t = await trash();
  assert.deepEqual(t.files.map((f: { path: string }) => f.path).sort(), ['Proj/a.bin', 'Proj/b.bin'], 'nothing lost');
  const group = t.dirs.find((d: { path: string }) => d.path === 'Proj');
  const back = await api('POST', `/api/files/${group.id}/restore`, asOwner, {});
  assert.equal(back.status, 200, back.text);
  assert.equal(back.json().files, 2);
});

test('someone’s new version never takes another’s trash that went in within the day', async () => {
  await clean();
  const keep = await push('owners.bin', crypto.randomBytes(2000), {}, asOwner);
  const keepId = keep.put?.json().commit.files[0].id;
  assert.equal((await api('DELETE', `/api/files/${keepId}`, asOwner)).status, 200);
  const churn = await push('churn.bin', crypto.randomBytes(1000));
  assert.equal(churn.put?.status, 200);
  const v2 = crypto.randomBytes(1000);
  const ask = await api('POST', '/api/files/uploads', asMember, { files: [{ path: 'churn.bin', size: v2.length, sha256: sha(v2), base: 1 }] });
  assert.equal((await raw('PUT', new URL(ask.json().uploads[0].url).pathname, { host: MEDIA, body: v2 })).status, 200);
  assert.ok((await usage()).kept > CAP, 'the net is over its cap');
  assert.deepEqual(
    (await trash()).files.map((f: { id: string }) => f.id),
    [keepId],
  );
  assert.equal((await api('POST', `/api/files/${keepId}/restore`, asOwner, {})).status, 200);
});

test('bringing back an older version keeps the one it replaced restorable', async () => {
  await clean();
  const v1 = crypto.randomBytes(1000);
  const first = await push('cut.bin', v1);
  const id = first.put?.json().commit.files[0].id;
  const v2 = crypto.randomBytes(3000);
  const ask = await api('POST', '/api/files/uploads', asMember, { files: [{ path: 'cut.bin', size: v2.length, sha256: sha(v2), base: 1 }] });
  assert.equal((await raw('PUT', new URL(ask.json().uploads[0].url).pathname, { host: MEDIA, body: v2 })).status, 200);
  const revert = await api('POST', `/api/files/${id}/restore`, asMember, { v: 1 });
  assert.equal(revert.status, 200, revert.text);
  assert.equal(revert.json().sha256, sha(v1));
  // V2 (bigger than the cap) is one of its versions still, and comes back
  const h = (await api('GET', `/api/files/${id}/history`, asMember)).json();
  assert.ok(
    h.versions.some((x: { v: number; sha256: string }) => x.v === 2 && x.sha256 === sha(v2)),
    JSON.stringify(h.versions),
  );
  const again = await api('POST', `/api/files/${id}/restore`, asMember, { v: 2 });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json().sha256, sha(v2));
});

test('trash again and again: the excess counts, so the loop ends in the plan’s refusal, not on the disk', async () => {
  await clean();
  let refused = 0;
  for (let i = 0; i < 6; i++) {
    const { answer, put } = await push(`Footage/take${i}.bin`, crypto.randomBytes(9000));
    if (answer.status === 402) {
      refused++;
      continue;
    }
    assert.equal(answer.status, 200, `push ${i}: ${answer.text}`);
    assert.equal(put?.status, 200, put?.text);
    assert.equal((await api('DELETE', `/api/files/${put?.json().commit.files[0].id}`, asMember)).status, 200);
  }
  assert.ok(refused >= 5, `${refused} of 6 refused`);
  assert.ok(onDisk() <= PLAN, `${onDisk()} bytes on disk`);
  const u = await usage();
  assert.ok(u.bytes <= PLAN, JSON.stringify(u));
  // a day on, what is over the cap may go, and there is room again
  await purgeIn(25);
  assert.equal((await usage()).over, 0);
});

test('with no plan that says, the safety net is bounded all the same', async () => {
  await clean();
  storage = null;
  const u = await usage();
  assert.equal(u.kept_cap, Math.max(FILE_LIMITS.keptFloor, u.bytes), 'what counts, or the floor');
  assert.equal(files.keptCap(null, 3e10), 3e10, 'no more than what the files count');
  assert.equal(files.keptCap(null, 0), FILE_LIMITS.keptFloor);
  assert.equal(files.keptCap(1e11, 1e9), FILE_LIMITS.keptFloor, 'a plan never lifts it past the ceiling');
  assert.equal(files.keptCap(1e10, 1e10), 1e10 * FILE_LIMITS.keptShare);
});

test('uploads waiting for their commit count toward the plan: a loop of them ends in a refusal', async () => {
  await clean();
  const first = await push('stash/0.bin', crypto.randomBytes(9000), { commit: false });
  assert.equal(first.put?.status, 200, first.put?.text);
  assert.equal(first.put?.json().commit, undefined, 'stored only');
  const u = await usage();
  assert.equal(u.pending, 9000);
  assert.equal(u.bytes, 9000, 'counted while it waits');
  assert.equal(usageOf('w1').bytes, 9000, 'the plan sees it');
  const second = await push('stash/1.bin', crypto.randomBytes(9000), { commit: false });
  assert.equal(second.answer.status, 402, second.answer.text);
  assert.equal(second.answer.json().reason, 'storage');
  // committed, it is a file like any other (counted once)
  const data = (await usage()).bytes;
  assert.equal(data, 9000);
});

test('a push never makes waiting bytes younger, least of all one the plan refused: they go after their day', async () => {
  await clean();
  const data = crypto.randomBytes(4000);
  const first = await push('stash/a.bin', data, { commit: false });
  assert.equal(first.put?.status, 200);
  // as if uploaded 23 hours ago
  const s = JSON.parse(fs.readFileSync(shardOf(sha(data)), 'utf8'));
  s[sha(data)].at = new Date(Date.now() - 23 * 3600e3).toISOString();
  fs.writeFileSync(shardOf(sha(data)), JSON.stringify(s));
  const aged = blobAt(sha(data));
  // a push naming it beside more than the plan takes: refused, and its age as it was
  const refused = await api('POST', '/api/files/uploads', asMember, {
    files: [
      { path: 'again/a.bin', size: data.length, sha256: sha(data) },
      { path: 'again/big.bin', size: 9000 },
    ],
    commit: false,
  });
  assert.equal(refused.status, 402, refused.text);
  assert.equal(blobAt(sha(data)), aged, 'a refused push changes nothing');
  // a push naming it alone (it counts already: nothing more to count) doesn't make it younger either
  const named = await api('POST', '/api/files/uploads', asMember, { files: [{ path: 'again/a.bin', size: data.length, sha256: sha(data) }], commit: false });
  assert.equal(named.status, 200, named.text);
  assert.deepEqual(named.json().uploads, [{ path: 'again/a.bin', stored: true }]);
  assert.equal(blobAt(sha(data)), aged);
  // two hours later its day is over: the purge takes it, and it counts no more
  const out = await inWorkspace('w1', () => files.purgeFiles({ now: Date.now() + 2 * 3600e3 }));
  assert.equal(out.blobs, 1, JSON.stringify(out));
  assert.equal((await usage()).bytes, 0);
});

test('what comes back counts again: out of the trash or an older version, past the plan is refused with its numbers', async () => {
  await clean();
  storage = 10 * PLAN; // a safety net of 25,000: room for all this test trashes and replaces
  const a = await push('a.bin', crypto.randomBytes(6000));
  const aId = a.put?.json().commit.files[0].id;
  assert.equal((await api('DELETE', `/api/files/${aId}`, asMember)).status, 200);
  const b = await push('b.bin', crypto.randomBytes(6000));
  assert.equal(b.put?.status, 200, b.put?.text);
  const back = await api('POST', `/api/files/${aId}/restore`, asMember, {});
  assert.equal(back.status, 402, back.text);
  assert.equal(back.json().reason, 'storage');
  assert.equal(back.json().needed, 6000);
  assert.ok(
    (await api('GET', '/api/files/trash', asMember)).json().files.some((f: { id: string }) => f.id === aId),
    'still in the trash',
  );
  // an older version brought back as the newest: the same check
  assert.equal((await api('DELETE', `/api/files/${b.put?.json().commit.files[0].id}`, asMember)).status, 200);
  const v1 = crypto.randomBytes(6000);
  const c = await push('c.bin', v1);
  const cId = c.put?.json().commit.files[0].id;
  const v2 = crypto.randomBytes(1000);
  const next = await api('POST', '/api/files/uploads', asMember, { files: [{ path: 'c.bin', size: v2.length, sha256: sha(v2), base: 1 }] });
  assert.equal((await raw('PUT', new URL(next.json().uploads[0].url).pathname, { host: MEDIA, body: v2 })).status, 200);
  await push('d.bin', crypto.randomBytes(4000));
  const revert = await api('POST', `/api/files/${cId}/restore`, asMember, { v: 1 });
  assert.equal(revert.status, 402, revert.text);
  assert.equal(revert.json().needed, 6000);
  // with room again (d trashed), it comes back
  const d = (await api('GET', '/api/files?deep=1', asMember)).json().files.find((f: { path: string }) => f.path === 'd.bin');
  assert.equal((await api('DELETE', `/api/files/${d.id}`, asMember)).status, 200);
  const ok = await api('POST', `/api/files/${cId}/restore`, asMember, { v: 1 });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json().sha256, sha(v1));
});

test('a file keeps a bounded number of older versions; bringing back the bytes it has makes nothing new', async () => {
  await clean();
  storage = 100 * PLAN;
  const first = Buffer.from('version 1\n');
  const p = await push('notes.txt', first);
  const id = p.put?.json().commit.files[0].id;
  for (let v = 2; v <= FILE_LIMITS.versions + 5; v++) {
    const data = Buffer.from(`version ${v}\n`);
    const ask = await api('POST', '/api/files/uploads', asMember, { files: [{ path: 'notes.txt', size: data.length, sha256: sha(data), base: v - 1 }] });
    assert.equal(ask.status, 200, ask.text);
    assert.equal((await raw('PUT', new URL(ask.json().uploads[0].url).pathname, { host: MEDIA, body: data })).status, 200);
  }
  const h = (await api('GET', `/api/files/${id}/history`, asMember)).json();
  assert.equal(h.versions[0].v, FILE_LIMITS.versions + 5);
  assert.equal(h.versions.length, FILE_LIMITS.versions + 1, 'the current one and the newest older ones');
  // bring back the newest older one, then the same bytes again: the second makes no version
  const older = h.versions[1].v;
  const once = await api('POST', `/api/files/${id}/restore`, asMember, { v: older });
  assert.equal(once.json().v, FILE_LIMITS.versions + 6);
  const twice = await api('POST', `/api/files/${id}/restore`, asMember, { v: older });
  assert.equal(twice.status, 200, twice.text);
  assert.equal(twice.json().v, FILE_LIMITS.versions + 6, 'its bytes are the file’s already: nothing new');
  const after = (await api('GET', `/api/files/${id}/history`, asMember)).json();
  assert.equal(after.versions.length, FILE_LIMITS.versions + 1);
});
