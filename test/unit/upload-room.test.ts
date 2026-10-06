// Uploads started and not finished hold their room (A13 MEDIA-5): the disk's reserve and the workspace's plan were
// checked once per upload against what was stored, so five 90 MB uploads were accepted with 100 MB of room and a 100 MB
// plan, and 300 MB of their bytes landed (tus keeps an unfinished upload 24 h). Now the bytes every open upload (tus, or
// a one-time URL streaming now) still brings count for the disk, its declared size counts for the plan, an account has
// at most OPEN_UPLOADS_PER_ACCOUNT open, and a PATCH whose rest no longer fits on the disk is refused. Only uploads that
// moved lately hold room, and nobody holds all of it from the others (A13 VERIFY-1, below).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv({ vars: { VR_MODE: 'server', VR_FOOTAGE: 'off', VR_OCR: 'off' } });
const { startApp } = await import('../lib/app.ts');
const auth = await import('../../lib/auth.ts');
const { freeBytes } = await import('../../server/ready.ts');
const { usageOf } = await import('../../server/extension.ts');
const { HttpError } = await import('../../server/http.ts');
const paths = await import('../../lib/paths.ts');
const { ctx, request } = await startApp();
const owner = await auth.createUser({ email: 'o@example.com', name: 'Owner', password: 'a long password', role: 'owner' });
// a hosted store with its list of workspaces (w1 and one more)
const workspaces = await import('../../lib/workspaces.ts');
workspaces.createWorkspace({ name: 'Other', ownerId: owner.id });
const asOwner = { Authorization: `Bearer ${auth.createToken(owner.id, 't', { workspace: 'w1' }).token}` };
// someone with a workspace of their own
const mallory = await auth.createUser({ email: 'm@example.com', name: 'Mallory', password: 'a long password', role: 'reviewer' });
const theirs = workspaces.createWorkspace({ name: 'Mallory Films', ownerId: mallory.id });
const asMallory = { Authorization: `Bearer ${auth.createToken(mallory.id, 't', { workspace: theirs.id }).token}` };

const MB = 1e6;
const uploads = path.join(paths.CACHE, 'uploads');
const tus = { 'Tus-Resumable': '1.0.0' };
const meta = `filename ${Buffer.from('a.mp4').toString('base64')},folder ${Buffer.from('X').toString('base64')}`;
const create = (bytes: number, who: Record<string, string> = asOwner) =>
  request('POST', '/api/uploads', { headers: { ...who, ...tus, 'Upload-Length': String(bytes), 'Upload-Metadata': meta } });
const patch = (at: string, chunk: Buffer, offset = 0, who: Record<string, string> = asOwner) =>
  request('PATCH', at, { body: chunk, headers: { ...who, ...tus, 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' } });
/** The upload's bytes last changed `minutes` ago: what tus's folder says of an upload nobody sends to. */
const still = (at: string, minutes: number) => {
  const then = new Date(Date.now() - minutes * 60_000);
  fs.utimesSync(path.join(uploads, path.basename(at)), then, then);
};

// The plan as the Cloud module decides it (decideUpload): what is stored + what this upload asks for ≤ the plan's.
let planBytes = Number.POSITIVE_INFINITY;
const realExtension = ctx.extension;
ctx.extension = {
  ...realExtension,
  async check(w: string, gate: string, bytes = 0) {
    if (gate === 'upload' && usageOf(w).bytes + bytes > planBytes) throw new HttpError(402, `This workspace has ${planBytes / MB} MB of storage`);
  },
};
/** Leaves `bytes` of room on the disk above the reserve (the reserve is set from the disk's free space now). */
const room = (bytes: number) => {
  ctx.cfg.min_free_bytes = (freeBytes(uploads) as number) - bytes;
};
const reset = () => {
  for (const f of fs.readdirSync(uploads)) fs.rmSync(path.join(uploads, f), { force: true, recursive: true });
  planBytes = Number.POSITIVE_INFINITY;
  ctx.cfg.min_free_bytes = 0;
};

test('the disk counts what open uploads still bring: a second upload that would overfill it is refused', async () => {
  reset();
  room(1000 * MB);
  const first = await create(600 * MB);
  assert.equal(first.status, 201, first.text);
  const second = await create(600 * MB);
  assert.equal(second.status, 507, `600 MB more with 400 MB left: ${second.status}`);
  // an upload that is cancelled gives its room back
  const gone = await request('DELETE', String(first.headers.location), { headers: { ...asOwner, ...tus } });
  assert.equal(gone.status, 204, gone.text);
  const again = await create(600 * MB);
  assert.equal(again.status, 201, again.text);
});

test("the plan counts the workspace's open uploads: two that together pass the plan are not both taken", async () => {
  reset();
  planBytes = 100 * MB;
  assert.equal((await create(60 * MB)).status, 201);
  const second = await create(60 * MB);
  assert.equal(second.status, 402, `60 MB more on a 100 MB plan with 60 MB on its way: ${second.status}`);
  // a one-time upload URL counts them too
  const ticket = await request('POST', '/api/uploads/tickets', { body: { filename: 'b.mp4', folder: 'X' }, headers: asOwner });
  assert.equal(ticket.status, 200, ticket.text);
  const put = await request('PUT', new URL(ticket.json().url).pathname, { body: Buffer.alloc(60 * MB) });
  assert.equal(put.status, 402, `a 60 MB PUT beside 60 MB on its way: ${put.status}`);
});

test('an account has at most 50 uploads open at once', async () => {
  reset();
  for (let i = 0; i < 50; i++) assert.equal((await create(1)).status, 201);
  const more = await create(1);
  assert.equal(more.status, 429, `the 51st open upload: ${more.status}`);
});

test('a PATCH whose rest no longer fits on the disk is refused, not written', async () => {
  reset();
  room(1000 * MB);
  const up = await create(60 * MB);
  assert.equal(up.status, 201, up.text);
  const at = String(up.headers.location);
  assert.equal((await patch(at, Buffer.alloc(MB, 7))).status, 204);
  // the disk filled up meanwhile (something else wrote to it): 30 MB left for the 59 MB still to come
  room(30 * MB);
  const next = await patch(at, Buffer.alloc(MB, 7), MB);
  assert.equal(next.status, 507, `a PATCH with 59 MB to come and 30 MB of room: ${next.status}`);
});

// A13 VERIFY-1: room was held by every upload declared, sent or not, for its whole day: one account's eleven 90 MB
// uploads that never sent a byte kept another workspace's 20 MB upload out (507). Now only uploads that moved in the
// last UPLOAD_ROOM.stalledMs hold room, and what one account or workspace holds counts against anyone else's upload up
// to UPLOAD_ROOM.share of the room.
test('an upload that has sent nothing for ten minutes holds no room; sent to again, its rest must fit beside the others', async () => {
  reset();
  room(1000 * MB);
  const first = await create(600 * MB);
  assert.equal(first.status, 201, first.text);
  const at = String(first.headers.location);
  still(at, 11);
  const second = await create(600 * MB);
  assert.equal(second.status, 201, `600 MB beside an upload silent for 11 minutes: ${second.status} ${second.text}`);
  // it comes back: 600 MB still to come beside 600 MB on their way, in room for 1000
  const back = await patch(at, Buffer.alloc(MB, 7));
  assert.equal(back.status, 507, `the silent one sent to again: ${back.status}`);
  // a silent minute or two is no stall
  reset();
  room(1000 * MB);
  const slow = await create(600 * MB);
  still(String(slow.headers.location), 2);
  assert.equal((await create(600 * MB)).status, 507, 'an upload two minutes quiet still holds its room');
});

test("one account's uploads count against another workspace's at most half the room: they don't keep it out", async () => {
  reset();
  room(1000 * MB);
  // uploads declared and never sent, as many as fit
  const made: string[] = [];
  for (let i = 0; i < 12; i++) {
    const r = await create(90 * MB, asMallory);
    if (r.status === 201) made.push(String(r.headers.location));
  }
  assert.equal(made.length, 11, 'alone, an account may take the room');
  const other = await create(20 * MB);
  assert.equal(other.status, 201, `another workspace's 20 MB upload: ${other.status} ${other.text}`);
  // holding more than its share, the one gives way: its own next bytes no longer fit beside the others'
  const more = await patch(made[0] as string, Buffer.alloc(MB, 7), 0, asMallory);
  assert.equal(more.status, 507, `more of an upload of the one holding the room: ${more.status}`);
  const mine = await patch(String(other.headers.location), Buffer.alloc(MB, 7));
  assert.equal(mine.status, 204, `the other workspace's upload goes on: ${mine.status} ${mine.text}`);
});
