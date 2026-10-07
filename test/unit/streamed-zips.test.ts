// covers: server/routes/publish.ts server/routes/yourData.ts
// The zips the server makes as it sends them, on a hosted server: a publishing kit's (GET /api/posts/:id/kit/kit.zip,
// anyone who may draft) and a person's own data (GET /api/auth/me/export). A HEAD gets the headers and reads nothing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, makeVideo, must } from '../lib/helpers.ts';
import { tusUpload } from '../lib/http.ts';

const APP = 'review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: `http://${APP}` } });
const { port, request } = await startApp({ headers: { Host: APP } });
const auth = await import('../../lib/auth.ts');
const store = await import('../../lib/store.ts');
const posts = await import('../../lib/publish/posts.ts');
const kit = await import('../../lib/publish/kit.ts');
const { avatarKey } = await import('../../lib/avatars.ts');
const { rootStorage } = await import('../../lib/storage/index.ts');

const olivia = await auth.createUser({ email: 'o@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
const max = await auth.createUser({ email: 'm@example.com', name: 'Max', password: 'a long password', role: 'member' });
const asOwner = { Authorization: `Bearer ${auth.createToken(olivia.id, 't').token}` };
const asMax = { Cookie: `vr_session=${auth.signSession(max)}` };

// A final video with a made kit, its encode as big as a real one: far more than a socket holds, so sending it waits
const clip = makeVideo(path.join(dir, 'in/spot.mp4'), { w: 320, h: 180, dur: 0.5 });
const up = await tusUpload(request, clip, { filename: 'spot.mp4', folder: 'Brand' }, asOwner);
assert.equal(up.status, 200, up.text);
const slug: string = up.json().slug;
store.setApproval(slug, { status: 'approved' }, 'Olivia');
store.setFinal(slug, {}, 'Olivia');
const { post } = posts.draftPost({ slug, platform: 'youtube', fields: { description: 'Spring is here.' }, by: 'Olivia' });
const made = await kit.makeKit(post, must(store.loadReview(slug)));
assert.equal(made.state, 'ready', made.error);
const kitFiles = made.files.filter((f) => f.kind !== 'zip').map((f) => path.join(kit.kitDir(post.id), f.name));
const video = must(made.files.find((f) => f.kind === 'video')).name;
fs.writeFileSync(path.join(kit.kitDir(post.id), video), Buffer.alloc(24 * 1024 * 1024, 1));
const kitZip = `/api/posts/${post.id}/kit/kit.zip`;

// Max's export carries his picture: as big, so it too is more than a socket holds
const picture = 'u_0123456789ab-01234567.jpg';
fs.mkdirSync(path.dirname(rootStorage().localPath(avatarKey(picture))), { recursive: true });
fs.writeFileSync(rootStorage().localPath(avatarKey(picture)), Buffer.alloc(16 * 1024 * 1024, 2));
auth.setAvatar(max.id, picture);
const exportZip = '/api/auth/me/export';

interface Got {
  status: number;
  headers: http.IncomingHttpHeaders;
  bytes: number;
}
function send(url: string, headers: Record<string, string>, method = 'GET'): Promise<Got> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { Host: APP, ...headers }, agent: false }, (res) => {
      let bytes = 0;
      res.on('data', (d: Buffer) => (bytes += d.length));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, bytes }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** What `fn` got, and every read stream the server opened on the kit's files meanwhile. */
async function readsDuring<T>(fn: () => Promise<T>): Promise<{ got: T; opened: string[] }> {
  const opened: string[] = [];
  const real = fs.createReadStream;
  const files = fs as { createReadStream: typeof fs.createReadStream };
  files.createReadStream = ((...a: Parameters<typeof fs.createReadStream>) => {
    if (kitFiles.includes(String(a[0]))) opened.push(String(a[0]));
    return real.apply(fs, a);
  }) as typeof fs.createReadStream;
  try {
    return { got: await fn(), opened };
  } finally {
    files.createReadStream = real;
  }
}

test('a HEAD of the kit’s zip answers its headers and reads none of its files; a GET still sends every byte', async () => {
  const length = kit.kitZip(post.id).length;
  assert.ok(length > 24 * 1024 * 1024);
  const { got: h, opened } = await readsDuring(() => send(kitZip, asMax, 'HEAD'));
  assert.deepEqual(opened, [], 'a HEAD opened no file of the kit');
  assert.equal(h.status, 200);
  assert.equal(Number(h.headers['content-length']), length);
  assert.equal(h.headers['content-type'], 'application/zip');
  assert.match(String(h.headers['content-disposition']), /^attachment; filename="spot-youtube-kit\.zip"/);
  assert.equal(h.bytes, 0);
  const full = await readsDuring(() => send(kitZip, asMax));
  assert.equal(full.opened.length, kitFiles.length, 'a GET reads each file of the kit (the count works)');
  assert.equal(full.got.bytes, length, 'every byte of the zip');
});

test('a HEAD of a person’s export answers its headers and sends nothing', async () => {
  const h = await send(exportZip, asMax, 'HEAD');
  assert.equal(h.status, 200);
  assert.equal(h.headers['content-type'], 'application/zip');
  assert.equal(h.headers['cache-control'], 'no-store');
  assert.ok(Number(h.headers['content-length']) > 16 * 1024 * 1024, 'the picture is in it');
  assert.equal(h.bytes, 0);
});
