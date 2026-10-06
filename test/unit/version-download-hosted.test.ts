// covers: server/routes/downloads.ts server/routes/media.ts server/playback.ts server/permissions.ts lib/storage/mediaHost.ts
// One version of a video downloaded by the team on a hosted server with its own media host: who may (the `download`
// right, the same as a folder's zip: owners, admins and members, signed in or with a token; reviewers watch and leave
// notes, they don't take renders home), and what they get — a redirect to a signed URL on the media host that lives
// minutes and names nothing, where the file comes as an attachment named "<video> V<n>.<ext>", in ranges, each
// workspace its own bytes. A download that picks up where it broke off gets all the rest there, a review link's too.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { encodeOnce, isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { tusUpload } from '../lib/http.ts';

const APP = 'review.test';
const MEDIA = 'media.review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: `http://${APP}`, VR_MEDIA_ORIGIN: `http://${MEDIA}` } });
const { openMedia } = await import('../../lib/storage/mediaHost.ts');
const { SIGNED_URL_SECONDS } = await import('../../lib/storage/index.ts');
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const shares = await import('../../lib/shares.ts');
type User = import('../../lib/auth.ts').User;

const { port, request } = await startApp();

interface Raw {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}
function raw(url: string, { host = APP, headers = {} }: { host?: string; headers?: Record<string, string> } = {}) {
  return new Promise<Raw>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: url, headers: { Host: host, ...headers }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
/** The path of a redirect's URL on the media host. */
const onMedia = (location: unknown): string => {
  const u = new URL(String(location));
  assert.equal(u.host, MEDIA, `redirected to the media host: ${location}`);
  return u.pathname;
};
const sealedOf = (location: unknown) => String(new URL(String(location)).pathname.split('/')[3]);

const make = async (email: string, name: string, role: 'owner' | 'admin' | 'member' | 'reviewer') =>
  auth.createUser({ email, name, password: 'a long password', role });
const session = (u: User) => ({ Cookie: `vr_session=${auth.signSession(u)}` });
const bearer = (u: User, workspace?: string) => ({ Authorization: `Bearer ${auth.createToken(u.id, 'test', workspace ? { workspace } : {}).token}` });

const olivia = await make('o@example.com', 'Olivia', 'owner');
const ada = await make('a@example.com', 'Ada', 'admin');
const max = await make('m@example.com', 'Max', 'member');
const rita = await make('r@example.com', 'Rita', 'reviewer');
const asOwner = bearer(olivia);

// Two versions of one upload: the same name in the same folder is its next version.
const v1File = makeVideo(path.join(dir, 'in/v1/spot.mp4'), { w: 320, h: 180, dur: 1, gop: 10, pattern: 'testsrc' });
const v2File = makeVideo(path.join(dir, 'in/v2/spot.mp4'), { w: 320, h: 180, dur: 1, gop: 10, pattern: 'testsrc2', freq: 660 });
const up1 = await tusUpload(request, v1File, { filename: 'spot.mp4', folder: 'Acme' }, asOwner);
assert.equal(up1.status, 200, up1.text);
const slug: string = up1.json().slug;
const up2 = await tusUpload(request, v2File, { filename: 'spot.mp4', folder: 'Acme' }, asOwner);
assert.equal(up2.status, 200, up2.text);
assert.equal(up2.json().v, 2);
const bytes = { 1: fs.readFileSync(v1File), 2: fs.readFileSync(v2File) } as const;

// Over 8 MB (noise, lossless): more than one of the player's chunks.
const bigFile = encodeOnce(path.join(dir, 'in/noise.mp4'), [
  ...['-v', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=640x360:d=1.2:r=25', '-vf', 'noise=alls=100:allf=t,format=yuv420p'],
  ...['-c:v', 'libx264', '-qp', '0', '-preset', 'ultrafast'],
]);
const upBig = await tusUpload(request, bigFile, { filename: 'noise.mp4', folder: 'Acme' }, asOwner);
assert.equal(upBig.status, 200, upBig.text);
const bigSlug: string = upBig.json().slug;
const bigBytes = fs.readFileSync(bigFile);

const url = (s: string, q = '') => `/api/review/${encodeURIComponent(s)}/download${q}`;

test('who may download a version: owners, admins and members, in the app or with a token; reviewers and strangers may not', async () => {
  const allowed: [string, Record<string, string>][] = [
    ['owner', session(olivia)],
    ['admin', session(ada)],
    ['member', session(max)],
    ['member’s token', bearer(max)],
  ];
  for (const [who, headers] of allowed) {
    const info = await raw(url(slug, '/info?v=1'), { headers });
    assert.equal(info.status, 200, `${who}: ${info.body}`);
    assert.equal(JSON.parse(info.body.toString()).name, 'spot V1.mp4');
    const r = await raw(url(slug, '?v=1'), { headers });
    assert.equal(r.status, 302, `${who}: ${r.body}`);
    onMedia(r.headers.location);
  }
  const refused: [string, Record<string, string>, number][] = [
    ['reviewer', session(rita), 403],
    ['reviewer’s token', bearer(rita), 403],
    ['signed out', {}, 401],
  ];
  for (const [who, headers, status] of refused)
    for (const u of [url(slug, '?v=1'), url(slug, '/info?v=1'), url(slug)]) {
      const r = await raw(u, { headers });
      assert.equal(r.status, status, `${who} ${u} → ${r.status}`);
      assert.equal(r.headers.location, undefined, `${who}: no URL handed out`);
    }
  // a token revoked: asked again, nothing
  const token = auth.createToken(max.id, 'revoked soon');
  assert.equal((await raw(url(slug), { headers: { Authorization: `Bearer ${token.token}` } })).status, 302);
  assert.ok(auth.revokeToken(token.info.id, max.id));
  assert.equal((await raw(url(slug), { headers: { Authorization: `Bearer ${token.token}` } })).status, 401);
});

test('the media host hands out the version’s own bytes as an attachment named after it, for minutes, in ranges', async () => {
  for (const v of [1, 2] as const) {
    const r = await raw(url(slug, `?v=${v}`), { headers: session(max) });
    assert.equal(r.status, 302);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.match(String(r.headers.location), new RegExp(`/spot%20V${v}\\.mp4$`), 'the URL’s last part is the file’s name');
    assert.doesNotMatch(String(r.headers.location), new RegExp(slug), 'the URL names no video');
    const claims = openMedia<{ k: string; n: string }>(sealedOf(r.headers.location));
    assert.equal(claims?.k, `versions/${slug}/v${v}.mp4`, 'the version’s own file, not a copy made for playing');
    assert.equal(claims?.n, `spot V${v}.mp4`);
    const life = (claims?.e ?? 0) - Math.floor(Date.now() / 1000);
    assert.ok(life > 60 && life <= SIGNED_URL_SECONDS.download + 60, `the URL lives ${life} s`);

    const got = await raw(onMedia(r.headers.location), { host: MEDIA });
    assert.equal(got.status, 200);
    assert.equal(got.headers['content-disposition'], `attachment; filename="spot V${v}.mp4"; filename*=UTF-8''spot%20V${v}.mp4`);
    assert.ok(got.body.equals(bytes[v]), `V${v} as it was uploaded`);
    assert.equal(got.headers['set-cookie'], undefined);
    const part = await raw(onMedia(r.headers.location), { host: MEDIA, headers: { Range: 'bytes=0-99' } });
    assert.equal(part.status, 206);
    assert.ok(part.body.equals(bytes[v].subarray(0, 100)));
  }
});

test('a download that broke off picks up where it stopped on the media host: all the rest, a review link’s too', async () => {
  assert.ok(bigBytes.length > 9 * 1024 * 1024, `the big render is ${bigBytes.length} bytes`);
  const from = 1000;
  const team = await raw(url(bigSlug), { headers: session(max) });
  const link = shares.createShare(bigSlug, { label: 'Delivery', download: 'original' });
  const guest = await raw(`/api/g/${link.token}/download/${shares.guestId(link, bigSlug)}/v1?kind=original`);
  for (const [who, r] of [
    ['the team', team],
    ['a review link', guest],
  ] as const) {
    assert.equal(r.status, 302, `${who}: ${r.body}`);
    const rest = await raw(onMedia(r.headers.location), { host: MEDIA, headers: { Range: `bytes=${from}-` } });
    assert.equal(rest.status, 206, who);
    assert.equal(rest.headers['content-range'], `bytes ${from}-${bigBytes.length - 1}/${bigBytes.length}`, who);
    assert.ok(rest.body.equals(bigBytes.subarray(from)), `${who}: every byte from where it stopped`);
  }
  // what the player plays still comes in bounded chunks
  const played = await raw(`/media/${encodeURIComponent(bigSlug)}/v1`, { headers: session(max) });
  const chunk = await raw(onMedia(played.headers.location), { host: MEDIA, headers: { Range: 'bytes=0-' } });
  assert.equal(Number(chunk.headers['content-length']), 8 * 1024 * 1024);
});

test('each workspace downloads its own bytes; another workspace’s video is nobody’s here', async () => {
  const bob = await make('b@example.com', 'Bob', 'reviewer');
  const B = ws.createWorkspace({ name: 'Bravo', ownerId: bob.id }).id;
  ws.removeMember('w1', bob.id);
  const asBob = bearer(bob, B);
  // the same folder and file name in B: the same video id, other bytes; and one only B has
  const theirs = makeVideo(path.join(dir, 'in/b/spot.mp4'), { w: 320, h: 180, dur: 1, gop: 10, pattern: 'rgbtestsrc', freq: 880 });
  assert.equal((await tusUpload(request, theirs, { filename: 'spot.mp4', folder: 'Acme' }, asBob)).json().slug, slug);
  const only = makeVideo(path.join(dir, 'in/b/only.mp4'), { w: 320, h: 180, dur: 1, gop: 10, pattern: 'smptebars' });
  const onlySlug: string = (await tusUpload(request, only, { filename: 'only.mp4', folder: 'Acme' }, asBob)).json().slug;

  const bobs = await raw(url(slug, '?v=1'), { headers: asBob });
  assert.equal(bobs.status, 302, String(bobs.body));
  assert.ok(openMedia<{ k: string }>(sealedOf(bobs.headers.location))?.k.startsWith(`w/${B}/`));
  assert.ok((await raw(onMedia(bobs.headers.location), { host: MEDIA })).body.equals(fs.readFileSync(theirs)));
  const olivias = await raw(url(slug, '?v=1'), { headers: asOwner });
  assert.ok((await raw(onMedia(olivias.headers.location), { host: MEDIA })).body.equals(bytes[1]));

  for (const u of [url(onlySlug), url(onlySlug, '/info')]) assert.equal((await raw(u, { headers: asOwner })).status, 404, `${u} from w1`);
  assert.equal((await raw(url(slug, '?v=2'), { headers: asBob })).status, 404, 'B has one version of it');
});
