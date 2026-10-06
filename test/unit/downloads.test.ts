// "Download all" over HTTP: a folder link's zip holds exactly what the link covers today (originals or previews, as
// the link allows), in the folder's structure with safe, unique names; it streams at once and becomes deterministic
// once the checksums are cached (ETag + ranges, so it resumes); every link rule applies; downloads are counted once
// and heard about as one event; a download that is cut off frees its slot; the team downloads folders from the library.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, FFMPEG, isolatedEnv, makeVideo, must, slugOf } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const folders = await import('../../lib/folders.ts');
const shares = await import('../../lib/shares.ts');
const { dedupe, safeSegment } = await import('../../lib/archive.ts');

function track(file: string, folder: string | null): string {
  age(file);
  store.createOrGetReview(file, { by: 'tester' });
  const slug = slugOf(file);
  if (folder) folders.moveVideo(slug, folder, 'tester');
  return slug;
}
const video = (rel: string) => makeVideo(path.join(dir, rel), { w: 160, h: 90, dur: 1 });

const spot = track(video('a/export/spot.mp4'), 'Acme/Reels');
track(video('b/export/spot.mp4'), 'Acme/Reels'); // same file name from another project: "spot_v1 (2).mp4"
track(video('a/export/Über Schnitt.mp4'), 'Acme/Reels');
track(video('a/export/cut.mp4'), 'Acme/Reels/Cutdowns');
track(video('a/export/other.mp4'), 'Acme/Other');
const gone = track(video('a/export/archived.mp4'), 'Acme/Reels');
store.removeVideo(gone, 'tester');
// A bigger file (noise, lossless) so a download can be held open and cut off mid-way.
const bigFile = path.join(dir, 'big/export/noise.mp4');
fs.mkdirSync(path.dirname(bigFile), { recursive: true });
execFileSync(FFMPEG, [
  ...['-v', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=640x360:d=1:r=25', '-vf', 'noise=alls=100:allf=t,format=yuv420p'],
  ...['-c:v', 'libx264', '-qp', '0', '-preset', 'ultrafast', '-y', bigFile],
]);
track(bigFile, 'Big');

const { port } = await startApp({ token: 'test-token', loadSessions: async () => [] });

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
  json: () => any;
}
// A visitor from elsewhere (guest routes are the only ones that answer them), or the owner on this machine.
const remote = { 'x-forwarded-for': '203.0.113.9' };
function get(url: string, headers: Record<string, string> = remote): Promise<Reply> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: url, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({ status: res.statusCode || 0, headers: res.headers, body, json: () => JSON.parse(body.toString('utf8')) });
        });
      })
      .on('error', reject);
  });
}
async function link(settings: object, folder = 'Acme/Reels'): Promise<string> {
  return shares.createShare({ folder }, { label: 'Client', ...settings }).token;
}
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

// Python lists the archive and checks every CRC; unzip -t agrees.
function readZip(buf: Buffer): { name: string; size: number; sha: string }[] {
  const file = path.join(dir, `z-${crypto.randomBytes(4).toString('hex')}.zip`);
  fs.writeFileSync(file, buf);
  const script = `
import hashlib, json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
print(json.dumps([{"name": i.filename, "size": i.file_size, "sha": hashlib.sha256(z.read(i)).hexdigest()} for i in z.infolist()]))
`;
  const out = JSON.parse(execFileSync('python3', ['-c', script, file], { encoding: 'utf8' }));
  assert.match(execFileSync('unzip', ['-t', file], { encoding: 'utf8' }), /No errors detected/);
  return out;
}

// Checksums are the background queue's last job: behind everything else on a loaded machine, so up to a minute.
async function untilResumable(token: string, kind = 'original') {
  for (let i = 0; i < 600; i++) {
    const info = (await get(`/api/g/${token}/archive/info?kind=${kind}`)).json();
    if (info.resumable) return info;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('checksums never got ready');
}

test('names inside the zip are safe on every file system and unique', () => {
  assert.equal(safeSegment('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(safeSegment('CON'), '_CON');
  assert.equal(safeSegment('a\u0000b\u001fc'), 'abc');
  assert.equal(safeSegment('Übergang'.normalize('NFD')), 'Übergang'.normalize('NFC'));
  assert.equal(safeSegment('  .hidden. '), 'hidden');
  assert.equal(safeSegment(''), '_');
  assert.equal([...safeSegment('x'.repeat(300))].length, 120);
  assert.deepEqual(dedupe(['R/a_v1.mp4', 'R/A_v1.mp4', 'R/a_v1.mp4']), ['R/a_v1.mp4', 'R/A_v1 (2).mp4', 'R/a_v1 (3).mp4']);
});

test('originals: streams at once, then resumes; the folder structure, only what the link covers', async () => {
  const token = await link({ download: 'original' });
  const info = (await get(`/api/g/${token}/archive/info`)).json();
  assert.equal(info.kind, 'original');
  assert.equal(info.files, 4, 'archived videos and other folders are left out');
  assert.ok(info.bytes > 0);

  // Before the checksums are cached: the whole archive, no ranges.
  const first = await get(`/api/g/${token}/archive?name=Mia`);
  assert.equal(first.status, 200);
  assert.equal(first.headers['content-type'], 'application/zip');
  assert.match(String(first.headers['content-disposition']), /attachment; .*filename\*=UTF-8''Reels%20%E2%80%93%20\d{4}-\d{2}-\d{2}\.zip/);
  assert.equal(Number(first.headers['content-length']), first.body.length);
  const entries = readZip(first.body);
  assert.deepEqual(
    entries.map((e) => e.name),
    ['Reels/spot_v1.mp4', 'Reels/spot_v1 (2).mp4', 'Reels/Über Schnitt_v1.mp4', 'Reels/Cutdowns/cut_v1.mp4'],
  );
  const review = must(store.loadReview(spot));
  assert.equal(entries[0].sha, sha(fs.readFileSync(must(store.versionFile(review, 1)))), 'the rendered bytes, unchanged');

  // Once the checksums are cached: an ETag, ranges, and halves that add up to the whole.
  await untilResumable(token);
  const whole = await get(`/api/g/${token}/archive`);
  const etag = String(whole.headers.etag);
  assert.match(etag, /^"z-[0-9a-f]+"$/);
  assert.equal(whole.headers['accept-ranges'], 'bytes');
  assert.deepEqual(readZip(whole.body), entries, 'the same files as the streamed one (its layout differs: no data descriptors)');
  const half = Math.floor(whole.body.length / 2);
  const a = await get(`/api/g/${token}/archive`, { ...remote, Range: `bytes=0-${half - 1}`, 'If-Range': etag });
  const b = await get(`/api/g/${token}/archive`, { ...remote, Range: `bytes=${half}-`, 'If-Range': etag });
  assert.equal(a.status, 206);
  assert.equal(b.status, 206);
  assert.equal(b.headers['content-range'], `bytes ${half}-${whole.body.length - 1}/${whole.body.length}`);
  assert.equal(sha(Buffer.concat([a.body, b.body])), sha(whole.body), 'a broken-off download resumes');
  const stale = await get(`/api/g/${token}/archive`, { ...remote, Range: `bytes=${half}-`, 'If-Range': '"z-old"' });
  assert.equal(stale.status, 200, 'a changed archive starts over instead of mixing bytes');
});

test('previews when the link offers previews; originals only when it offers originals', async () => {
  const token = await link({ download: 'preview' });
  let info = (await get(`/api/g/${token}/archive/info`)).json();
  assert.equal(info.kind, 'preview');
  // The preview copies are made on demand: the room says how many are on their way.
  for (let i = 0; i < 200 && info.preparing; i++) {
    await new Promise((r) => setTimeout(r, 50));
    info = (await get(`/api/g/${token}/archive/info`)).json();
  }
  assert.equal(info.preparing, 0, 'the copies got made');
  const res = await get(`/api/g/${token}/archive`);
  assert.equal(res.status, 200);
  const entries = readZip(res.body);
  assert.ok(entries.length && entries.every((e) => e.name.endsWith('.mp4')));
  const original = sha(fs.readFileSync(must(store.versionFile(must(store.loadReview(spot)), 1))));
  assert.ok(!entries.some((e) => e.sha === original), 'copies, never the rendered bytes');
  assert.equal((await get(`/api/g/${token}/archive?kind=original`)).status, 403);
  const both = await link({ download: 'original' });
  assert.equal((await get(`/api/g/${both}/archive/info?kind=preview`)).json().kind, 'preview', 'an original link may still take previews');
});

test('every link rule applies: downloads off, expired, password, video links, revoked', async () => {
  const off = await link({ download: 'off' });
  assert.equal((await get(`/api/g/${off}/archive/info`)).status, 403);
  assert.equal((await get(`/api/g/${off}/archive`)).status, 403);
  const expired = await link({ download: 'original', expires: '2020-01-01T00:00:00Z' });
  assert.equal((await get(`/api/g/${expired}/archive`)).status, 410);
  const locked = await link({ download: 'original', password: 'secret words' });
  assert.equal((await get(`/api/g/${locked}/archive`)).status, 401);
  const share = must(shares.resolveShare(locked));
  const cookie = `${shares.unlockCookieName(share)}=${shares.unlockValue(share)}`;
  assert.equal((await get(`/api/g/${locked}/archive`, { ...remote, Cookie: cookie })).status, 200, 'unlocked, it works');
  const single = shares.createShare(spot, { download: 'original' }).token;
  assert.equal((await get(`/api/g/${single}/archive`)).status, 404, 'video links have their own download');
  const revoked = await link({ download: 'original' });
  shares.revokeShare(revoked);
  assert.equal((await get(`/api/g/${revoked}/archive`)).status, 404);
  assert.equal((await get('/api/g/not-a-real-token-at-all-xyz/archive')).status, 404);
});

test('scope is looked up on every request: a video moved out of the folder leaves the zip', async () => {
  const token = await link({ download: 'original' });
  const moving = track(video('c/export/moving.mp4'), 'Acme/Reels');
  assert.ok(readZip((await get(`/api/g/${token}/archive`)).body).some((e) => e.name === 'Reels/moving_v1.mp4'));
  folders.moveVideo(moving, 'Acme/Other', 'tester');
  assert.ok(!readZip((await get(`/api/g/${token}/archive`)).body).some((e) => e.name.includes('moving')));
});

test('a download is counted once and heard about as one event; resumed ranges and retries are not', async () => {
  const token = await link({ download: 'original' });
  const events = () => store.readEvents({ limit: 5000 }).filter((e) => e.type === 'download' && e.folder === 'Acme/Reels');
  const before = events().length;
  const info = await untilResumable(token);
  const whole = await get(`/api/g/${token}/archive?name=Mia`);
  assert.equal(whole.status, 200);
  await get(`/api/g/${token}/archive?name=Mia`, { ...remote, Range: 'bytes=100-', 'If-Range': String(whole.headers.etag) });
  await get(`/api/g/${token}/archive?name=Mia`);
  const stats = must(shares.listShares({ folder: 'Acme/Reels' }).find((s) => s.token === token)).stats;
  assert.equal(stats?.downloads, 1);
  assert.deepEqual(
    stats?.recent_downloads?.map((d) => [d.name, d.what, d.files, d.kind]),
    [['Mia', `all ${info.files} videos`, info.files, 'original']],
  );
  const ev = events().slice(before);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].by, 'guest:Mia');
  assert.equal(ev[0].slug, '');
  assert.equal(ev[0].files, info.files);
  assert.match(String(ev[0].text), /^downloaded all \d+ videos of Acme\/Reels \(.+, originals\)$/);
});

test('a download cut off mid-way frees its slot; too many at once are turned away', async () => {
  const token = await link({ download: 'original' }, 'Big');
  // Two held open (not read) fill this visitor's slots; the third is turned away.
  const held: http.ClientRequest[] = [];
  for (let i = 0; i < 2; i++)
    await new Promise<void>((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: `/api/g/${token}/archive`, headers: remote }, (res) => {
        res.pause();
        resolve();
      });
      held.push(req);
    });
  const third = await get(`/api/g/${token}/archive`);
  assert.equal(third.status, 429);
  assert.ok(Number(third.headers['retry-after']) > 0);
  for (const req of held) req.destroy();
  await new Promise((r) => setTimeout(r, 300));
  const again = await get(`/api/g/${token}/archive`);
  assert.equal(again.status, 200, 'cut-off downloads gave their slots back');
  assert.equal(readZip(again.body).length, 1);
});

test('the team downloads a folder from the library (originals by default)', async () => {
  const owner = {}; // loopback, no proxy headers: the owner of a local instance
  const info = (await get(`/api/folders/download/info?folder=${encodeURIComponent('Acme')}`, owner)).json();
  assert.equal(info.kind, 'original');
  const res = await get(`/api/folders/download?folder=${encodeURIComponent('Acme')}`, owner);
  assert.equal(res.status, 200);
  const names = readZip(res.body).map((e) => e.name);
  assert.ok(names.includes('Acme/Reels/Cutdowns/cut_v1.mp4') && names.includes('Acme/Other/other_v1.mp4'));
  assert.equal((await get('/api/folders/download?folder=Nope', owner)).status, 404);
});
