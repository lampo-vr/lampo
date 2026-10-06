// covers: server/routes/downloads.ts server/playback.ts
// One version of a video downloaded by the team, on a person's own machine: the file as it was linked, named
// "<video> V<n>.<ext>", streamed with ranges (a download that picks up where it broke off gets all the rest), whatever
// the browser plays (a codec it can't play still downloads as itself); asked for by the video and its version only —
// never a path —, refused for a version that doesn't exist, whose bytes are gone or whose video was removed; and
// recorded nowhere, like the team's folder zips.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, encodeOnce, isolatedEnv, makeVideo, must, slugOf } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const { versionFileName } = await import('../../lib/archive.ts');

const { port } = await startApp({ token: 'test-token', loadSessions: async () => [] });

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
  json: () => any;
}
/** As the owner of this machine (loopback, no proxy headers), or as anyone else with `headers`. */
function get(url: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode || 0, headers: res.headers, body, json: () => JSON.parse(body.toString('utf8')) });
      });
    });
    req.on('error', reject);
    req.end();
  });
}
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** A linked render with two versions: V1 kept in versions/ when V2 was rendered over it. */
const spotFile = path.join(dir, 'proj/export/Über Spot.mp4');
makeVideo(spotFile, { w: 160, h: 90, dur: 1, pattern: 'testsrc' });
age(spotFile, 120);
store.createOrGetReview(spotFile, { by: 'tester' });
const spot = slugOf(spotFile);
const v1Bytes = fs.readFileSync(spotFile);
makeVideo(spotFile, { w: 160, h: 90, dur: 1, pattern: 'testsrc2', freq: 660 });
age(spotFile, 60);
store.sync(spot);
const v2Bytes = fs.readFileSync(spotFile);
assert.deepEqual(
  must(store.loadReview(spot)).versions.map((v) => v.v),
  [1, 2],
);

// Over 8 MB (noise, lossless): more than one of the player's chunks.
const bigFile = encodeOnce(path.join(dir, 'proj/export/noise.mp4'), [
  ...['-v', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=640x360:d=1.2:r=25', '-vf', 'noise=alls=100:allf=t,format=yuv420p'],
  ...['-c:v', 'libx264', '-qp', '0', '-preset', 'ultrafast'],
]);
age(bigFile);
store.createOrGetReview(bigFile, { by: 'tester' });
const big = slugOf(bigFile);
const bigBytes = fs.readFileSync(bigFile);

const url = (slug: string, q = '') => `/api/review/${encodeURIComponent(slug)}/download${q}`;

test('the name: the video’s, its version as the app writes it, the extension it was rendered with — safe everywhere', () => {
  assert.equal(versionFileName('/renders/export/Über Spot.mp4', 3), 'Über Spot V3.mp4');
  assert.equal(versionFileName('/@uploads/Acme/Reels/teaser.MOV', 12), 'teaser V12.mov');
  assert.equal(versionFileName('/renders/a:b|c?.mp4', 1), 'a_b_c_ V1.mp4');
  assert.equal(versionFileName('/renders/CON.mp4', 1), '_CON V1.mp4');
  assert.equal(versionFileName('/renders/clip', 2), 'clip V2.mp4', 'no extension: the container most renders are');
});

test('what a download will be, before it starts: the version, its name, its size and where it is', async () => {
  const newest = await get(url(spot, '/info'));
  assert.equal(newest.status, 200, newest.body.toString());
  assert.deepEqual(newest.json(), { v: 2, name: 'Über Spot V2.mp4', bytes: v2Bytes.length, url: url(spot, '?v=2') });
  assert.equal(newest.headers['cache-control'], 'no-store');
  assert.deepEqual((await get(url(spot, '/info?v=1'))).json(), { v: 1, name: 'Über Spot V1.mp4', bytes: v1Bytes.length, url: url(spot, '?v=1') });
});

test('each version downloads as it was rendered, as an attachment with its name', async () => {
  for (const [v, bytes] of [
    [1, v1Bytes],
    [2, v2Bytes],
  ] as const) {
    const r = await get(url(spot, `?v=${v}`));
    assert.equal(r.status, 200, r.body.toString().slice(0, 200));
    assert.equal(r.headers['content-disposition'], `attachment; filename="_ber Spot V${v}.mp4"; filename*=UTF-8''%C3%9Cber%20Spot%20V${v}.mp4`);
    assert.equal(r.headers['content-type'], 'video/mp4');
    assert.equal(r.headers['accept-ranges'], 'bytes');
    assert.equal(r.headers['cache-control'], 'private, no-cache');
    assert.equal(Number(r.headers['content-length']), bytes.length);
    assert.equal(sha(r.body), sha(bytes), `V${v}: the rendered bytes, unchanged`);
  }
  // no version named: the newest
  assert.equal(sha((await get(url(spot))).body), sha(v2Bytes));
  const head = await get(url(spot, '?v=1'), {}, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers['content-length']), v1Bytes.length);
  assert.equal(head.body.length, 0);
});

test('ranges: a part, and a download that picks up where it broke off gets all the rest (not a player’s 8 MB)', async () => {
  const part = await get(url(spot, '?v=1'), { Range: 'bytes=0-99' });
  assert.equal(part.status, 206);
  assert.equal(part.headers['content-range'], `bytes 0-99/${v1Bytes.length}`);
  assert.deepEqual(part.body, v1Bytes.subarray(0, 100));
  assert.match(String(part.headers['content-disposition']), /^attachment; /);

  assert.ok(bigBytes.length > 9 * 1024 * 1024, `the big render is ${bigBytes.length} bytes`);
  const from = 1000;
  const rest = await get(url(big), { Range: `bytes=${from}-` });
  assert.equal(rest.status, 206);
  assert.equal(rest.headers['content-range'], `bytes ${from}-${bigBytes.length - 1}/${bigBytes.length}`);
  assert.equal(Number(rest.headers['content-length']), bigBytes.length - from);
  assert.equal(sha(rest.body), sha(bigBytes.subarray(from)), 'every byte from where it stopped');
  const tail = await get(url(big), { Range: 'bytes=-10' });
  assert.deepEqual(tail.body, bigBytes.subarray(bigBytes.length - 10));
  assert.equal((await get(url(big), { Range: `bytes=${bigBytes.length}-` })).status, 416);
  // the player's own route still hands out bounded chunks
  const played = await get(`/media/${encodeURIComponent(big)}/v1`, { Range: 'bytes=0-' });
  assert.equal(played.status, 206);
  assert.equal(Number(played.headers['content-length']), 8 * 1024 * 1024);
});

test('a codec browsers can’t play downloads as itself, never as the copy the player gets', async () => {
  const mov = path.join(dir, 'proj/export/master.mov');
  encodeOnce(mov, [
    ...['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25:duration=1'],
    ...['-c:v', 'mpeg4', '-q:v', '5', '-pix_fmt', 'yuv420p'],
  ]);
  age(mov);
  store.createOrGetReview(mov, { by: 'tester' });
  const slug = slugOf(mov);
  assert.equal(must(store.loadReview(slug)).meta?.codec, 'mpeg4');
  const r = await get(url(slug, '?v=1'));
  assert.equal(r.status, 200, r.body.toString().slice(0, 200));
  assert.match(String(r.headers['content-disposition']), /filename\*=UTF-8''master%20V1\.mov$/);
  assert.equal(sha(r.body), sha(fs.readFileSync(mov)), 'the .mov as rendered, not an H.264 proxy');
});

test('the linked file itself streams when its copy in versions/ isn’t there; bytes that are gone are a 410', async () => {
  const file = path.join(dir, 'proj/export/linked.mp4');
  makeVideo(file, { w: 160, h: 90, dur: 1, pattern: 'smptebars' });
  age(file);
  store.createOrGetReview(file, { by: 'tester' });
  const slug = slugOf(file);
  const kept = must(store.versionFile(must(store.loadReview(slug)), 1));
  if (kept !== file) fs.rmSync(kept);
  assert.equal(store.versionFile(must(store.loadReview(slug)), 1), file, 'only the linked file is left');
  const r = await get(url(slug));
  assert.equal(r.status, 200);
  assert.equal(sha(r.body), sha(fs.readFileSync(file)));

  // rendered over with something else: version 1's bytes are nowhere now
  makeVideo(file, { w: 160, h: 90, dur: 1, pattern: 'rgbtestsrc' });
  for (const u of [url(slug, '/info?v=1'), url(slug, '?v=1')]) {
    const gone = await get(u);
    assert.equal(gone.status, 410, `${u} → ${gone.status}`);
    assert.match(gone.json().error, /bytes of this version are gone/);
  }
});

test('a version that doesn’t exist is a 404, a removed video a 410; only `v` is asked, never a path', async () => {
  assert.equal((await get(url(spot, '?v=3'))).status, 404);
  assert.equal((await get(url(spot, '/info?v=3'))).status, 404);
  assert.equal((await get(url('nobody', '?v=1'))).status, 404);
  for (const q of ['?v=0', '?v=-1', '?v=1.5', '?v=abc', '?v=1&path=/etc/hosts', '?path=/etc/hosts', '?v=1&file=v1.mp4', '?key=versions/x/v1.mp4']) {
    const r = await get(url(spot, q));
    assert.equal(r.status, 400, `${q} → ${r.status}`);
    assert.ok(!r.headers['content-disposition'], `${q}: nothing downloads`);
  }
  // a path where the video's id goes names no video
  for (const slug of ['..%2F..%2Fetc%2Fhosts', encodeURIComponent(spotFile), '%2Fetc%2Fhosts']) {
    const r = await get(`/api/review/${slug}/download?v=1`);
    assert.equal(r.status, 404, `${slug} → ${r.status}`);
  }

  const removed = path.join(dir, 'proj/export/removed.mp4');
  makeVideo(removed, { w: 160, h: 90, dur: 1, pattern: 'testsrc', freq: 880 });
  age(removed);
  store.createOrGetReview(removed, { by: 'tester' });
  const slug = slugOf(removed);
  store.mutate(slug, (r) => {
    r.archived = new Date().toISOString();
  });
  for (const u of [url(slug, '/info'), url(slug)]) {
    const r = await get(u);
    assert.equal(r.status, 410, `${u} → ${r.status}`);
    assert.match(r.json().error, /removed: restore it/);
  }
  store.unarchive(slug);
  assert.equal((await get(url(slug))).status, 200, 'restored, it downloads again');
});

test('a download records nothing: no event, as for the team’s folder zips', async () => {
  const lines = () => (fs.existsSync(store.eventsFile()) ? fs.readFileSync(store.eventsFile(), 'utf8').split('\n').filter(Boolean).length : 0);
  const before = lines();
  assert.equal((await get(url(spot, '?v=1'))).status, 200);
  assert.equal((await get(url(spot, '/info'))).status, 200);
  assert.equal(lines(), before);
});

test('only the machine’s owner here: someone else on the network is asked to sign in', async () => {
  const r = await get(url(spot, '?v=1'), { 'x-forwarded-for': '203.0.113.9' });
  assert.ok([401, 403].includes(r.status), `a visitor → ${r.status}`);
  assert.ok(!r.headers['content-disposition']);
});
