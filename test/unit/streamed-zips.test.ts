// covers: server/http.ts server/routes/publish.ts server/routes/yourData.ts server/routes/downloads.ts
// The zips the server makes as it sends them, on a hosted server: a publishing kit's (GET /api/posts/:id/kit/kit.zip,
// anyone who may draft) and a person's own data (GET /api/auth/me/export), through `sendStreamed` like the folder zips.
// A HEAD gets the headers and reads nothing; a viewer who goes away halfway ends the answer: no file stays open behind
// it, no handler waits on for good.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, makeVideo, must, until } from '../lib/helpers.ts';
import { tusUpload } from '../lib/http.ts';

const APP = 'review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: `http://${APP}` } });
const { port, request, server } = await startApp({ headers: { Host: APP } });
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

/** Asks for `url` and goes away once the first bytes are in, as a closed tab does. */
const abort = (url: string, headers: Record<string, string>) =>
  new Promise<void>((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, headers: { Host: APP, ...headers }, agent: false }, (res) => {
      res.once('data', () => req.destroy());
      res.once('end', resolve);
    });
    req.on('close', resolve);
    req.on('error', () => resolve());
    req.end();
  });

// The server's side of each answer: a handler still waiting holds on to its response (a listener that never fires).
const answers: http.ServerResponse[] = [];
server.prependListener('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
  if (req.url === kitZip || req.url === exportZip) answers.push(res);
});
const done = (res: http.ServerResponse) => res.destroyed && res.listenerCount('drain') === 0 && res.listenerCount('close') === 0;
const waiting = (from: number) => answers.slice(from).filter((res) => !done(res)).length;

// Open descriptors of this process (the app runs in it): on Linux those of the kit's files, macOS can't name them.
const fdDir = fs.existsSync('/proc/self/fd') ? '/proc/self/fd' : '/dev/fd';
const openFiles = () =>
  fdDir === '/proc/self/fd'
    ? fs.readdirSync(fdDir).filter((fd) => {
        try {
          return kitFiles.includes(fs.readlinkSync(path.join(fdDir, fd)));
        } catch {
          return false;
        }
      }).length
    : fs.readdirSync(fdDir).length;

test('a kit’s zip broken off halfway closes the kit’s files, and its handler ends', async () => {
  const before = openFiles();
  const from = answers.length;
  for (let i = 0; i < 20; i++) await abort(kitZip, asMax);
  assert.equal(answers.length, from + 20);
  await until(
    () => waiting(from) === 0 && openFiles() <= before,
    () => `${waiting(from)} of 20 handlers still wait; open ${fdDir === '/proc/self/fd' ? 'kit files' : 'descriptors'} ${before} → ${openFiles()}`,
  );
});

test('an export broken off halfway ends its handler', async () => {
  const from = answers.length;
  for (let i = 0; i < 2; i++) await abort(exportZip, asMax);
  assert.equal(answers.length, from + 2);
  await until(
    () => waiting(from) === 0,
    () => `${waiting(from)} of 2 handlers still wait`,
  );
  // and one that is let through gets every byte
  const whole = await send(exportZip, asMax);
  assert.equal(whole.status, 200);
  assert.equal(whole.bytes, Number(whole.headers['content-length']));
});

test('sendStreamed: a viewer gone stops the reading at once and closes what the bytes came from', async () => {
  const { sendStreamed } = await import('../../server/http.ts');
  type Send = Parameters<typeof sendStreamed>;
  let read = 0;
  let closed = 0;
  let ended = 0;
  async function* endless() {
    try {
      for (;;) {
        read++;
        yield Buffer.alloc(1 << 20);
      }
    } finally {
      closed++;
    }
  }
  const own = http.createServer((req, res) => {
    void sendStreamed(req as unknown as Send[0], res as unknown as Send[1], endless, 'test').then(() => ended++);
  });
  await new Promise<void>((r) => own.listen(0, '127.0.0.1', r));
  const at = (own.address() as import('node:net').AddressInfo).port;
  try {
    for (let i = 0; i < 5; i++)
      await new Promise<void>((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: at, path: '/', agent: false }, (res) => res.once('data', () => req.destroy()));
        req.on('close', resolve);
        req.on('error', () => resolve());
        req.end();
      });
    await until(
      () => ended === 5 && closed === 5,
      () => `${ended} of 5 ended, ${closed} sources closed`,
    );
    const after = read;
    await new Promise((r) => setImmediate(r));
    assert.equal(read, after, 'nothing more is read once they are gone');
  } finally {
    own.closeAllConnections();
    await new Promise((r) => own.close(r));
  }
});
