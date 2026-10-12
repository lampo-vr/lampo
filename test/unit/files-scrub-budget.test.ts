// covers: lib/fileMedia.ts server/routes/files.ts lib/shots.ts lib/prune.ts
// What a Files picture costs the account that asks (lib/fileMedia.ts, lib/shots.ts countedGrab): a clip's scrub strip
// counts as the frames it decodes; a run that started and made nothing stays counted and is remembered, so a broken
// clip is tried once, then refused from its mark without ffmpeg; a burst of new strips can't pass the budget together;
// a trashed file shows no picture; the per-file facts and marks are bounded by count.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { FFMPEG, isolatedEnv, makeVideo, must } from '../lib/helpers.ts';

const APP = 'review.test';
const MEDIA = 'media.review.test';
const { dir } = isolatedEnv({
  vars: { VR_MODE: 'server', VR_PUBLIC_URL: `http://${APP}`, VR_MEDIA_ORIGIN: `http://${MEDIA}`, VR_FOOTAGE: 'off', VR_OCR: 'off' },
});
// a small budget, so that a few strips reach it (the server takes it when it starts)
const { GRAB_LIMITS } = await import('../../lib/shots.ts');
GRAB_LIMITS.perAccount = 20;
const auth = await import('../../lib/auth.ts');
const folders = await import('../../lib/folders.ts');
const workspaces = await import('../../lib/workspaces.ts');
const { inWorkspace } = await import('../../lib/scope.ts');
const { cacheDir } = await import('../../lib/paths.ts');
const { SCRUB_FRAMES } = await import('../../lib/fileMedia.ts');
const { pruneDir } = await import('../../lib/prune.ts');

const { port } = await startApp();

interface Raw {
  status: number;
  text: string;
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
  json: () => any;
}
function raw(
  method: string,
  url: string,
  { host = APP, headers = {}, body }: { host?: string; headers?: Record<string, string>; body?: Buffer | string } = {},
) {
  return new Promise<Raw>((resolve, reject) => {
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
const enc = encodeURIComponent;

const PASSWORD = 'a long password';
const olivia = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: PASSWORD, role: 'owner' });
const mo = await auth.createUser({ email: 'mo@example.com', name: 'Mo', password: PASSWORD, role: 'member' });
// (a second workspace: the registry the server reads, as on a hosted server with several)
const bea = await auth.createUser({ email: 'bea@example.com', name: 'Bea', password: PASSWORD, role: 'owner' });
workspaces.createWorkspace({ name: 'Other studio', ownerId: bea.id });
const token = (u: { id: string }) => ({ Authorization: `Bearer ${auth.createToken(u.id, 'agent', { workspace: 'w1' }).token}` });
const asOlivia = token(olivia);
const asMo = token(mo);
inWorkspace('w1', () => folders.createFolder('Acme'));

async function push(who: Record<string, string>, list: { path: string; data: Buffer }[]) {
  const answer = await api('POST', '/api/files/uploads', who, {
    folder: 'Acme',
    files: list.map((f) => ({ path: f.path, size: f.data.length, sha256: sha(f.data) })),
  });
  assert.equal(answer.status, 200, answer.text);
  for (const [i, slot] of (answer.json().uploads as { url?: string }[]).entries()) {
    if (!slot.url) continue;
    const put = await raw('PUT', new URL(slot.url).pathname, { host: MEDIA, body: must(list[i]).data });
    assert.equal(put.status, 200, put.text);
  }
}

// clips that differ in their sound (so in their bytes): a strip of each is new work
const media = path.join(dir, 'media');
fs.mkdirSync(media, { recursive: true });
const clipOf = (n: number) => fs.readFileSync(makeVideo(path.join(media, `clip-${n}.mp4`), { w: 160, h: 90, dur: 2, freq: 300 + n * 50 }));
// a clip ffprobe reads (its header says 2 s at 160×90) whose frames aren't there: its index first, its data cut short
const whole = makeVideo(path.join(media, 'whole.mp4'), { w: 160, h: 90, dur: 2, freq: 990 });
const front = path.join(media, 'front.mp4');
execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', whole, '-c', 'copy', '-movflags', '+faststart', front]);
const full = fs.readFileSync(front);
let at = 0;
let cut = full.length;
while (at + 8 <= full.length) {
  const size = full.readUInt32BE(at);
  if (full.toString('latin1', at + 4, at + 8) === 'mdat') {
    cut = at + 8 + 64;
    break;
  }
  if (size < 8) break;
  at += size;
}
const broken = full.subarray(0, cut);
assert.ok(cut < full.length, 'the clip lost its frames');

await push(asOlivia, [{ path: 'Footage/broken.mp4', data: broken }, ...[1, 2, 3, 4, 5, 6, 7].map((n) => ({ path: `Footage/C00${n}.mp4`, data: clipOf(n) }))]);
const listed = await api('GET', `/api/files?folder=${enc('Acme')}&deep=1&own=1`, asOlivia);
const ids: Record<string, string> = Object.fromEntries(listed.json().files.map((f: { path: string; id: string }) => [f.path, f.id]));
const idOf = (p: string) => must(ids[p]);
const scrub = (p: string, who: Record<string, string>) => api('GET', `/api/files/${idOf(p)}/scrub?v=1`, who);

test('a broken clip: tried once and counted as the frames it cost, then refused from its mark', async () => {
  // ffmpeg is reached: its header gives a length and a size
  const facts = (await api('GET', `/api/files/media?ids=${idOf('Footage/broken.mp4')}`, asOlivia)).json().files[idOf('Footage/broken.mp4')];
  assert.ok(facts?.seconds > 0 && facts?.poster === true, `the broken clip reads as a clip: ${JSON.stringify(facts)}`);
  assert.equal((await scrub('Footage/broken.mp4', asOlivia)).status, 404, 'no strip of it');
  const mark = inWorkspace('w1', () => path.join(cacheDir(), 'file-media', `${sha(broken)}.scrub.none`));
  assert.ok(fs.existsSync(mark), 'remembered');
  assert.equal((await scrub('Footage/broken.mp4', asOlivia)).status, 404, 'asked again: the mark answers');
  // 20 a window: the failed run kept its 8 (the second ask cost nothing), one good strip takes 8 more, and the next
  // can't have its 8
  assert.equal(SCRUB_FRAMES, 8);
  assert.equal((await scrub('Footage/C001.mp4', asOlivia)).status, 200);
  const over = await scrub('Footage/C002.mp4', asOlivia);
  assert.equal(over.status, 429, `the budget holds: ${over.status} ${over.text}`);
  // a strip made before is no new work: served whatever is left
  assert.equal((await scrub('Footage/C001.mp4', asOlivia)).status, 200);
});

test('a burst of new strips: no more than the budget lets through, however many are in flight together', async () => {
  const answers = await Promise.all(['Footage/C003.mp4', 'Footage/C004.mp4', 'Footage/C005.mp4', 'Footage/C006.mp4'].map((p) => scrub(p, asMo)));
  const statuses = answers.map((a) => a.status).sort();
  assert.deepEqual(statuses, [200, 200, 429, 429], answers.map((a) => `${a.status} ${a.text.slice(0, 60)}`).join(' | '));
});

test('a trashed file shows no picture, as a purged one', async () => {
  const id = idOf('Footage/C007.mp4');
  assert.equal((await api('DELETE', `/api/files/${id}`, asOlivia)).status, 200);
  for (const what of ['poster', 'scrub']) assert.equal((await api('GET', `/api/files/${id}/${what}?v=1`, asMo)).status, 404, `its ${what}`);
});

test('the facts and marks are bounded by count: each weighs a disk block', () => {
  const d = path.join(dir, 'marks');
  fs.mkdirSync(d, { recursive: true });
  for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(d, `${String(i).padStart(64, '0')}.none`), '');
  fs.writeFileSync(path.join(d, 'keep.jpg'), Buffer.alloc(10));
  pruneDir(d, 40 * 4096, (f) => f.endsWith('.none'), 4096);
  const left = fs.readdirSync(d);
  assert.equal(left.filter((f) => f.endsWith('.none')).length, 40);
  assert.ok(left.includes('keep.jpg'), 'what the filter leaves out stays');
});
