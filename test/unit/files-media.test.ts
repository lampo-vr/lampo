// covers: lib/fileMedia.ts server/routes/files.ts lib/files.ts
// What the Files tab's rows show of footage, pictures and sound (lib/fileMedia.ts): a clip's length and size, a
// picture's size, a sound's length, read from the bytes on this disk; a poster for footage and pictures, made once and
// served as an immutable picture of that version. Nothing for other kinds, for bytes ffmpeg can't read (remembered,
// never tried again), for trashed files or another workspace's; reviewers see none of it (404). A folder's row says who
// changed it last: its newest file's change.
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
const auth = await import('../../lib/auth.ts');
const folders = await import('../../lib/folders.ts');
const workspaces = await import('../../lib/workspaces.ts');
const { inWorkspace } = await import('../../lib/scope.ts');
const { cacheDir } = await import('../../lib/paths.ts');
const { POSTER_BOX, SCRUB_BOX, SCRUB_FRAMES } = await import('../../lib/fileMedia.ts');
const { probe } = await import('../../lib/probe.ts');

const { port } = await startApp();

interface Raw {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
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
        resolve({ status: res.statusCode || 0, headers: res.headers, body: b, text: b.toString('utf8'), json: () => JSON.parse(b.toString('utf8')) });
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
const rita = await auth.createUser({ email: 'rita@example.com', name: 'Rita', password: PASSWORD, role: 'reviewer' });
const bea = await auth.createUser({ email: 'bea@example.com', name: 'Bea', password: PASSWORD, role: 'owner' });
const other = workspaces.createWorkspace({ name: 'Other studio', ownerId: bea.id });
const token = (u: { id: string }, workspace = 'w1') => ({ Authorization: `Bearer ${auth.createToken(u.id, 'agent', { workspace }).token}` });
const asOlivia = token(olivia);
const asRita = token(rita);
const asBea = token(bea, other.id);
inWorkspace('w1', () => folders.createFolder('Acme'));

/** Pushes `list` into `folder` (one PUT per file to its ticket on the media host). */
async function push(who: Record<string, string>, folder: string, list: { path: string; data: Buffer }[]) {
  const answer = await api('POST', '/api/files/uploads', who, { folder, files: list.map((f) => ({ path: f.path, size: f.data.length, sha256: sha(f.data) })) });
  assert.equal(answer.status, 200, answer.text);
  for (const [i, slot] of (answer.json().uploads as { url?: string }[]).entries()) {
    if (!slot.url) continue;
    const put = await raw('PUT', new URL(slot.url).pathname, { host: MEDIA, body: must(list[i]).data });
    assert.equal(put.status, 200, put.text);
  }
}
const idsIn = async (folder: string, who = asOlivia): Promise<Record<string, string>> => {
  const r = await api('GET', `/api/files?folder=${enc(folder)}&deep=1&own=1`, who);
  assert.equal(r.status, 200, r.text);
  return Object.fromEntries(r.json().files.map((f: { path: string; id: string }) => [f.path, f.id]));
};

// real media: a 3 s 320×180 clip, a 400×300 picture, a 2 s sound; a text; bytes named like a clip that aren't one
const media = path.join(dir, 'media');
fs.mkdirSync(media, { recursive: true });
const clip = fs.readFileSync(makeVideo(path.join(media, 'clip.mp4'), { w: 320, h: 180, dur: 3 }));
execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=400x300', '-frames:v', '1', path.join(media, 'still.png')]);
const still = fs.readFileSync(path.join(media, 'still.png'));
execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', path.join(media, 'tone.wav')]);
const tone = fs.readFileSync(path.join(media, 'tone.wav'));
const notes = Buffer.from('Spring sale: 30 s and 15 s cuts.\n');
const broken = crypto.randomBytes(5000);
await push(asOlivia, 'Acme', [
  { path: 'Footage/A001C003.mp4', data: clip },
  { path: 'Stills/hero.png', data: still },
  { path: 'Music/bed.wav', data: tone },
  { path: 'Brief.txt', data: notes },
  { path: 'Footage/B001C001.mov', data: broken },
]);
const ids = await idsIn('Acme');
const clipId = must(ids['Footage/A001C003.mp4']);
const stillId = must(ids['Stills/hero.png']);
const toneId = must(ids['Music/bed.wav']);
const textId = must(ids['Brief.txt']);
const brokenId = must(ids['Footage/B001C001.mov']);

test('lengths and sizes: footage both, a picture its size, sound its length; other kinds and unreadable bytes nothing', async () => {
  const r = await api('GET', `/api/files/media?ids=${[clipId, stillId, toneId, textId, brokenId].join(',')}`, asOlivia);
  assert.equal(r.status, 200, r.text);
  const { files } = r.json();
  assert.equal(files[clipId].width, 320);
  assert.equal(files[clipId].height, 180);
  assert.ok(Math.abs(files[clipId].seconds - 3) < 0.2, `the clip's length: ${files[clipId].seconds}`);
  // a poster only where one can be made: the rows ask for none that would be a 404
  assert.equal(files[clipId].poster, true, 'footage has a poster');
  assert.deepEqual(files[stillId], { width: 400, height: 300, poster: true }, 'a picture has no length');
  assert.ok(Math.abs(files[toneId].seconds - 2) < 0.2 && files[toneId].width === undefined, `the sound: ${JSON.stringify(files[toneId])}`);
  assert.equal(files[toneId].poster, undefined, 'sound has no poster');
  assert.equal(files[textId], undefined, 'a text has nothing to show');
  assert.equal(files[brokenId], undefined, 'bytes ffprobe can’t read: nothing');
  // read once, kept by content: the cache answers the next look
  const cached = inWorkspace('w1', () => path.join(cacheDir(), 'file-media', `${sha(clip)}.json`));
  assert.ok(fs.existsSync(cached), 'kept in the workspace’s cache');
});

test('a poster: footage and pictures, a JPEG within its box, immutable; nothing for other kinds or unreadable bytes', async () => {
  const p = await api('GET', `/api/files/${clipId}/poster?v=1`, asOlivia);
  assert.equal(p.status, 200, p.text);
  assert.equal(p.headers['content-type'], 'image/jpeg');
  assert.match(String(p.headers['cache-control']), /immutable/);
  const out = path.join(dir, 'poster.jpg');
  fs.writeFileSync(out, p.body);
  const m = await probe(out);
  assert.equal(m.width, POSTER_BOX.width, 'a 16:9 clip fills the box’s width');
  assert.equal(m.height, POSTER_BOX.height);
  const s = await api('GET', `/api/files/${stillId}/poster`, asOlivia);
  assert.equal(s.status, 200, s.text);
  fs.writeFileSync(out, s.body);
  const sm = await probe(out);
  assert.ok(sm.height === POSTER_BOX.height && sm.width === 96, `a 4:3 picture keeps its shape: ${sm.width}×${sm.height}`);
  for (const [id, what] of [
    [toneId, 'sound'],
    [textId, 'a text'],
    [brokenId, 'unreadable bytes'],
  ])
    assert.equal((await api('GET', `/api/files/${id}/poster`, asOlivia)).status, 404, `${what}: no poster`);
  assert.ok(
    inWorkspace('w1', () => fs.existsSync(path.join(cacheDir(), 'file-media', `${sha(broken)}.none`))),
    'unreadable bytes are remembered, never tried again',
  );
  assert.equal((await api('GET', `/api/files/${clipId}/poster?v=7`, asOlivia)).status, 404, 'a version that isn’t there');
});

test('a clip’s scrub strip: its frames side by side, each within the box; nothing for a picture', async () => {
  const r = await api('GET', `/api/files/${clipId}/scrub?v=1`, asOlivia);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers['content-type'], 'image/jpeg');
  const out = path.join(dir, 'scrub.jpg');
  fs.writeFileSync(out, r.body);
  const m = await probe(out);
  assert.equal(m.width, SCRUB_BOX.width * SCRUB_FRAMES);
  assert.equal(m.height, SCRUB_BOX.height);
  assert.equal((await api('GET', `/api/files/${stillId}/scrub`, asOlivia)).status, 404, 'a picture: no strip');
  assert.equal((await api('GET', `/api/files/${clipId}/scrub`, asRita)).status, 404, 'a reviewer: nothing there');
});

test('a row seen for the first time asks for its length and its picture at once: both are made, neither fails', async () => {
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240', '-frames:v', '1', path.join(media, 'still2.png')]);
  const fresh = fs.readFileSync(path.join(media, 'still2.png'));
  await push(asOlivia, 'Acme', [{ path: 'Stills/table.png', data: fresh }]);
  const id = must((await idsIn('Acme'))['Stills/table.png']);
  const answers = await Promise.all([
    api('GET', `/api/files/media?ids=${id}`, asOlivia),
    api('GET', `/api/files/${id}/poster`, asOlivia),
    api('GET', `/api/files/${id}/poster`, asOlivia),
    api('GET', `/api/files/media?ids=${id}`, asOlivia),
  ]);
  assert.deepEqual(
    answers.map((a) => a.status),
    [200, 200, 200, 200],
    answers.map((a) => a.text.slice(0, 80)).join(' | '),
  );
  assert.deepEqual(answers[0]?.json().files[id], { width: 320, height: 240, poster: true });
});

test('reviewers see none of it; another workspace’s ids are nobody’s; trashed files show nothing; ids are checked', async () => {
  assert.equal((await api('GET', `/api/files/media?ids=${clipId}`, asRita)).status, 404, 'a reviewer: nothing there');
  assert.equal((await api('GET', `/api/files/${clipId}/poster`, asRita)).status, 404);
  const theirs = await api('GET', `/api/files/media?ids=${clipId}`, asBea);
  assert.equal(theirs.status, 200, theirs.text);
  assert.deepEqual(theirs.json().files, {}, 'another workspace’s file: left out like one nobody has');
  assert.equal((await api('GET', `/api/files/${clipId}/poster`, asBea)).status, 404);
  for (const bad of ['', 'fl_x', '../etc', `${clipId};rm`, Array.from({ length: 201 }, (_, i) => `fl_${String(i).padStart(12, '0')}`).join(',')])
    assert.equal((await api('GET', `/api/files/media?ids=${enc(bad)}`, asOlivia)).status, 400, `ids ${bad.slice(0, 20)}: refused`);
  assert.equal((await api('GET', `/api/files/media?ids=${clipId}&path=/etc`, asOlivia)).status, 400, 'nothing else is taken');
  assert.equal((await api('DELETE', `/api/files/${toneId}`, asOlivia)).status, 200);
  assert.deepEqual((await api('GET', `/api/files/media?ids=${toneId}`, asOlivia)).json().files, {}, 'a trashed file: nothing');
});

test('a folder’s row says who changed it last: its newest file’s change', async () => {
  const r = await api('GET', `/api/files?folder=Acme&own=1`, asOlivia);
  assert.equal(r.status, 200, r.text);
  const footage = r.json().dirs.find((d: { path: string }) => d.path === 'Footage');
  assert.equal(footage.changed.by, 'Olivia');
  assert.ok(Date.parse(footage.changed.at) > 0, 'when');
});
