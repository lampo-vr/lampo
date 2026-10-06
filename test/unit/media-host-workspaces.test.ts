// covers: lib/storage/mediaHost.ts server/routes/downloads.ts server/routes/media.ts
// The media host (VR_MEDIA_ORIGIN) on a server with two workspaces that hold the same video id in the same folder: each
// plays, zips and hands its folder links only its own bytes, though nobody is signed in there and the URL names no
// workspace (it is sealed in). An expired folder link's zip doesn't start there, and the sealed zip path is no way
// around the app host's sign-in (sweep 2 MH-2: a zip run in the wrong workspace shipped green before).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { tusUpload } from '../lib/http.ts';

const APP = 'review.test';
const MEDIA = 'media.review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: `http://${APP}`, VR_MEDIA_ORIGIN: `http://${MEDIA}` } });
const { openMedia } = await import('../../lib/storage/mediaHost.ts');
const { inWorkspace } = await import('../../lib/scope.ts');
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const shares = await import('../../lib/shares.ts');
const { port, request } = await startApp();

interface Raw {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}
function raw(method: string, url: string, { host = APP, headers = {} }: { host?: string; headers?: Record<string, string> } = {}) {
  return new Promise<Raw>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { Host: host, ...headers }, agent: false }, (res) => {
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

const alice = await auth.createUser({ email: 'a@example.com', name: 'Alice', password: 'a long password', role: 'owner' });
const bob = await auth.createUser({ email: 'b@example.com', name: 'Bob', password: 'a long password', role: 'reviewer' });
const B = ws.createWorkspace({ name: 'Bravo', ownerId: bob.id }).id;
ws.removeMember('w1', bob.id);
const asAlice = { Authorization: `Bearer ${auth.createToken(alice.id, 'a', { workspace: 'w1' }).token}` };
const asBob = { Authorization: `Bearer ${auth.createToken(bob.id, 'b', { workspace: B }).token}` };

// The same folder and file name in both workspaces: the same video id, other bytes.
const aBytes = fs.readFileSync(makeVideo(path.join(dir, 'a/intro.mp4'), { w: 320, h: 180, dur: 1, gop: 10, pattern: 'testsrc', freq: 440 }));
const bBytes = fs.readFileSync(makeVideo(path.join(dir, 'b/intro.mp4'), { w: 320, h: 180, dur: 1, gop: 10, pattern: 'rgbtestsrc', freq: 880 }));
assert.ok(!aBytes.equals(bBytes));
const upA = await tusUpload(request, path.join(dir, 'a/intro.mp4'), { filename: 'intro.mp4', folder: 'Reels' }, asAlice);
const upB = await tusUpload(request, path.join(dir, 'b/intro.mp4'), { filename: 'intro.mp4', folder: 'Reels' }, asBob);
assert.equal(upA.status, 200, upA.text);
assert.equal(upB.status, 200, upB.text);
const slug: string = upA.json().slug;
assert.equal(upB.json().slug, slug, 'the same video id in both workspaces');

const has = (zip: Buffer, bytes: Buffer) => zip.includes(bytes.subarray(0, 4096));

test('each workspace’s player gets its own render from the media host', async () => {
  for (const [who, headers, bytes, inB] of [
    ['bob', asBob, bBytes, true],
    ['alice', asAlice, aBytes, false],
  ] as const) {
    const r = await raw('GET', `/media/${encodeURIComponent(slug)}/v1`, { headers });
    assert.equal(r.status, 302, `${who}: ${r.body}`);
    const sealed = String(onMedia(r.headers.location).split('/')[3]);
    const key = openMedia<{ k: string }>(sealed)?.k ?? '';
    assert.equal(key.startsWith(`w/${B}/`), inB, `${who}'s key ${key}`);
    const got = await raw('GET', onMedia(r.headers.location), { host: MEDIA });
    assert.equal(got.status, 200);
    assert.ok(got.body.equals(bytes), `${who} got their own workspace's bytes`);
  }
});

test('each workspace’s team zip of the same folder holds its own render, never the other’s', async () => {
  for (const [who, headers, mine, theirs] of [
    ['bob', asBob, bBytes, aBytes],
    ['alice', asAlice, aBytes, bBytes],
  ] as const) {
    const r = await raw('GET', '/api/folders/download?folder=Reels', { headers });
    assert.equal(r.status, 302, `${who}: ${r.body}`);
    const zip = await raw('GET', onMedia(r.headers.location), { host: MEDIA });
    assert.equal(zip.status, 200, `${who}'s zip: ${zip.body.toString().slice(0, 200)}`);
    assert.ok(has(zip.body, mine), `${who}'s zip holds their render`);
    assert.ok(!has(zip.body, theirs), `${who}'s zip never holds the other workspace's render`);
  }
});

test('a folder link of the second workspace zips that workspace’s render', async () => {
  const link = inWorkspace(B, () => shares.createShare({ folder: 'Reels' }, { label: 'Room', download: 'original' }));
  const r = await raw('GET', `/api/g/${link.token}/archive?kind=original&name=Mia`);
  assert.equal(r.status, 302, r.body.toString());
  const zip = await raw('GET', onMedia(r.headers.location), { host: MEDIA });
  assert.equal(zip.status, 200, zip.body.toString().slice(0, 200));
  assert.ok(has(zip.body, bBytes) && !has(zip.body, aBytes));
});

test('a folder link that expired after the redirect: its zip doesn’t start on the media host', async () => {
  const link = inWorkspace(B, () => shares.createShare({ folder: 'Reels' }, { label: 'Soon over', download: 'original' }));
  const r = await raw('GET', `/api/g/${link.token}/archive?kind=original&name=Mia`);
  assert.equal(r.status, 302, r.body.toString());
  const at = onMedia(r.headers.location);
  assert.ok(inWorkspace(B, () => shares.updateShare(link.token, { expires: new Date(Date.now() - 1000).toISOString() })));
  const zip = await raw('GET', at, { host: MEDIA });
  assert.equal(zip.status, 410, `an expired link's zip: ${zip.status}`);
  assert.ok(!has(zip.body, bBytes));
});

test('the sealed zip path is the media host’s only: on the app host it is 401 signed out and 404 signed in', async () => {
  const r = await raw('GET', '/api/folders/download?folder=Reels', { headers: asAlice });
  assert.equal(r.status, 302, r.body.toString());
  const at = onMedia(r.headers.location);
  assert.match(at, /^\/media\/z\//);
  assert.equal((await raw('GET', at)).status, 401, 'signed out');
  const signedIn = await raw('GET', at, { headers: asAlice });
  assert.equal(signedIn.status, 404, `signed in: ${signedIn.status}`);
  assert.ok(!has(signedIn.body, aBytes));
  assert.equal((await raw('GET', at, { host: MEDIA })).status, 200, 'where it belongs, it works');
});
