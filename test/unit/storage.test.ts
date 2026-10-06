// Storage adapters: the URL signers against their reference vectors, Bunny and S3 against local mock servers, the
// working-copy cache, and a hosted server that keeps its renders in Bunny and hands the player signed CDN URLs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, makeVideo, tmpdir } from '../lib/helpers.ts';
import { tusUpload } from '../lib/http.ts';
import { mockBunny, mockS3 } from '../lib/mockStores.ts';

const bunny = await mockBunny();
const { dir } = isolatedEnv({
  vars: {
    VR_MODE: 'server',
    VR_STORAGE: 'bunny',
    VR_BUNNY_ZONE: 'zone',
    VR_BUNNY_ACCESS_KEY: 'secret',
    VR_BUNNY_STORAGE_URL: bunny.url,
    VR_BUNNY_CDN_URL: 'https://cdn.review.test',
    VR_BUNNY_TOKEN_KEY: 'token-key',
  },
});
const { signBunnyUrl } = await import('../../lib/storage/bunnyToken.ts');
const { signRequest, presignGet, createS3Store } = await import('../../lib/storage/s3.ts');
const { createBunnyStore } = await import('../../lib/storage/bunny.ts');
const { createRemoteStorage } = await import('../../lib/storage/index.ts');
const { queued } = await import('../../lib/jobs.ts');
const auth = await import('../../lib/auth.ts');
const store = await import('../../lib/store.ts');
const { renderKey } = await import('../../lib/renderKey.ts');

// Background work (scrub copies, pre-review) still talks to the mock zone after the last test.
after(async () => {
  for (let i = 0; i < 600 && queued() > 0; i++) await new Promise((r) => setTimeout(r, 50));
  await bunny.close();
});

// The hosted server for the tests at the end. Every top-level await stays above the first test: node:test runs the
// file's `after` hooks once the tests registered so far are done.
const { server, request } = await startApp();

test('Bunny token auth matches the reference vectors (BunnyCDN.TokenAuthentication e2e/vectors.json)', () => {
  const H = 'https://token-tester.b-cdn.net';
  const at = { expiresAt: 1598024587 };
  const cases: [string, object, string][] = [
    ['/300kb.jpg', {}, 'HS256-o10JRWlsAItyAsdKS6jJKjabHN4FrFsplDHPV1idcX4&expires=1598024587'],
    ['/300kb.jpg', { countriesAllowed: 'CA,US' }, 'HS256-i5s3Uv7mnrFfN5nznwU2BxhILpnipYeE18TapV0WNFM&token_countries=CA%2CUS&expires=1598024587'],
    ['/300kb.jpg', { countriesBlocked: 'RU,CN' }, 'HS256-JS8dSuBSjSH-W2-xhdkCPC36-2rlxfDCQJjlNMPqKZQ&token_countries_blocked=RU%2CCN&expires=1598024587'],
    ['/abc/300kb.jpg', { pathAllowed: '/abc' }, 'HS256-uVZvT3SbEoVKYJyDJgbcsDmSFf73cv-uNUVaJiKWpbQ&token_path=%2Fabc&expires=1598024587'],
    ['/300kb.jpg', { ignoreParams: true }, 'HS256-1lwWBD_c1IAGSj1UKPoxreu8ePDQ-Z9FoWLcRn_RRH0&token_ignore_params=true&expires=1598024587'],
    ['/300kb.jpg', { speedLimit: 1000 }, 'HS256-DAVapqNNED3Z7JkjRTYX0UOIHNtbHEuuhRNEc4A7mMQ&limit=1000&expires=1598024587'],
  ];
  for (const [p, o, want] of cases) assert.equal(signBunnyUrl(H + p, 'SecurityKey', { ...o, ...at }), `${H}${p}?token=${want}`);
  assert.equal(
    signBunnyUrl(`${H}/videos/v1.mp4`, 'SecurityKey', { ...at, isDirectory: true, pathAllowed: '/videos/' }).startsWith(`${H}/bcdn_token=HS256-`),
    true,
  );
});

test('SigV4 matches the AWS documentation examples (GET object, presigned URL)', () => {
  const c = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1' };
  const now = new Date('2013-05-24T00:00:00Z');
  const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const h = signRequest(c, 'GET', 'https://examplebucket.s3.amazonaws.com/test.txt', { range: 'bytes=0-9' }, empty, now);
  assert.match(h.Authorization, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
  assert.match(
    presignGet(c, 'https://examplebucket.s3.amazonaws.com/test.txt', 86400, now),
    /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/,
  );
});

const scratch = tmpdir('vr-storage-');
const bytesOf = async (chunks: AsyncIterable<Buffer>) => {
  const all: Buffer[] = [];
  for await (const c of chunks) all.push(c);
  return Buffer.concat(all);
};
const sample = (name: string, size: number) => {
  const f = path.join(scratch, name);
  fs.writeFileSync(f, Buffer.from(Array.from({ length: size }, (_, i) => (i * 7) % 251)));
  return f;
};

test('Bunny adapter: upload with checksum, download, signed CDN URLs, directory delete', async () => {
  const store = createBunnyStore({ zone: 'zone', access_key: 'secret', storage_url: bunny.url, cdn_url: 'https://cdn.x.test', token_key: 'k', prefix: 'rv' });
  const f = sample('a.bin', 300_000);
  await store.put('versions/__@uploads__A b__c.mp4/v1.mp4', f);
  assert.deepEqual(bunny.objects.get('rv/versions/__@uploads__A b__c.mp4/v1.mp4'), fs.readFileSync(f));
  const back = path.join(scratch, 'back.bin');
  await store.get('versions/__@uploads__A b__c.mp4/v1.mp4', back);
  assert.deepEqual(fs.readFileSync(back), fs.readFileSync(f));
  const url = store.url('versions/__@uploads__A b__c.mp4/v1.mp4', 3600) as string;
  assert.match(url, /^https:\/\/cdn\.x\.test\/rv\/versions\/__%40uploads__A%20b__c\.mp4\/v1\.mp4\?token=HS256-[\w-]+&expires=\d+$/);
  await assert.rejects(store.get('versions/nope.mp4', back), /404/);
  const read = (start: number, end: number) => bytesOf(store.read('versions/__@uploads__A b__c.mp4/v1.mp4', start, end));
  assert.deepEqual(await read(1000, 250_999), fs.readFileSync(f).subarray(1000, 251_000), 'ranged reads stream exactly the asked bytes');
  await store.check();
  await assert.rejects(createBunnyStore({ zone: 'zone', access_key: 'wrong', storage_url: bunny.url }).check(), /401/);
  await store.remove('versions/__@uploads__A b__c.mp4/');
  assert.equal(bunny.objects.size, 0);
  await assert.rejects(createBunnyStore({ zone: 'zone', access_key: 'wrong', storage_url: bunny.url }).put('x', f), /401/);
});

test('S3 adapter: single and multipart uploads, download, prefix delete, presigned URLs', async () => {
  const s3 = await mockS3();
  try {
    const store = createS3Store(
      { endpoint: s3.url, bucket: 'bucket', access_key_id: 'AKTEST', secret_access_key: 'shh', region: 'auto' },
      { partSize: 64 * 1024 },
    );
    const small = sample('small.bin', 10_000);
    const big = sample('big.bin', 200_000);
    await store.put('versions/s/v1.mp4', small);
    await store.put('versions/s/v2.mp4', big);
    assert.deepEqual(s3.objects.get('versions/s/v2.mp4'), fs.readFileSync(big), 'parts reassembled in order');
    assert.ok(
      s3.requests.some((r) => r.path.includes('partNumber=4')),
      'four parts',
    );
    const back = path.join(scratch, 's3back.bin');
    await store.get('versions/s/v2.mp4', back);
    assert.deepEqual(fs.readFileSync(back), fs.readFileSync(big));
    const part = await bytesOf(store.read('versions/s/v2.mp4', 70_000, 139_999));
    assert.deepEqual(part, fs.readFileSync(big).subarray(70_000, 140_000));
    assert.equal(s3.requests.at(-1)?.headers.range, 'bytes=70000-139999', 'a signed Range request');
    await store.check();
    await assert.rejects(
      createS3Store({ endpoint: s3.url, bucket: 'bucket', access_key_id: 'WRONG', secret_access_key: 'shh', region: 'auto' }).check(),
      /403/,
    );
    assert.match(store.url('versions/s/v1.mp4', 600) as string, /X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKTEST%2F\d{8}%2Fauto%2Fs3%2Faws4_request/);
    await store.remove('versions/s/');
    assert.equal(s3.objects.size, 0);
  } finally {
    await s3.close();
  }
});

test('MEDIA-5: a prefix delete on S3 reads each listed key as XML text, once, and deletes that very key', async () => {
  const s3 = await mockS3();
  try {
    const store = createS3Store({ endpoint: s3.url, bucket: 'bucket', access_key_id: 'AKTEST', secret_access_key: 'shh', region: 'auto' });
    const file = sample('tiny.bin', 10);
    // What a key holds is the key: "&lt;" spelled out in a name must not become "<" (decoded twice), a CR must come back.
    const keys = ['refs/s/a&b.jpg', 'refs/s/c<d>.jpg', 'refs/s/x&lt;y.jpg', 'refs/s/"q\'.jpg', 'refs/s/r\rn.jpg', 'refs/s/&amp;.jpg'];
    for (const k of keys) await store.put(k, file);
    await store.put('refs/t/keep.jpg', file);
    await store.remove('refs/s/');
    assert.deepEqual([...s3.objects.keys()], ['refs/t/keep.jpg']);
  } finally {
    await s3.close();
  }
});

test('working copies: uploaded files stay cached, evicted ones are fetched again, unfinished ones are never evicted', async () => {
  const work = path.join(scratch, 'work');
  const store = createRemoteStorage(createBunnyStore({ zone: 'zone', access_key: 'secret', storage_url: bunny.url }), {
    workDir: work,
    workCacheBytes: 250_000,
  });
  const a = sample('w1.bin', 200_000);
  await store.put('versions/x/v1.mp4', a);
  assert.ok(fs.existsSync(path.join(work, 'versions/x/v1.mp4.stored')));
  assert.ok(!fs.existsSync(a), 'moved into the working copies');
  // A second file pushes the cache over its cap: the least recently used stored copy goes.
  await store.put('versions/x/v2.mp4', sample('w2.bin', 200_000));
  assert.equal(fs.existsSync(path.join(work, 'versions/x/v1.mp4')), false);
  const again = await store.ensureLocal('versions/x/v1.mp4');
  assert.equal(fs.statSync(again as string).size, 200_000);
  assert.equal(await store.ensureLocal('versions/x/v9.mp4'), null);
  // Written in place but not committed (no marker): the cache never deletes the only copy.
  const pending = path.join(work, 'scrub/h.mp4');
  fs.mkdirSync(path.dirname(pending), { recursive: true });
  fs.writeFileSync(pending, Buffer.alloc(300_000));
  await store.put('versions/x/v3.mp4', sample('w3.bin', 10));
  assert.ok(fs.existsSync(pending));
  await store.commit('scrub/h.mp4');
  assert.ok(bunny.objects.has('scrub/h.mp4'));
  await store.remove('versions/x/');
});

// ---------------------------------------------------------------- a hosted server on Bunny

let bearer: Record<string, string>;
before(async () => {
  const user = await auth.createUser({ email: 'o@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
  bearer = { Authorization: `Bearer ${auth.createToken(user.id, 'test').token}` };
});

test('hosted on Bunny: uploads land in the zone, the player gets signed CDN URLs, frames come from working copies', async () => {
  bunny.objects.clear();
  const video = makeVideo(path.join(dir, 'in/clip.mp4'), { w: 320, h: 180, dur: 1 });
  const up = await tusUpload(request, video, { filename: 'clip.mp4', folder: 'Acme' }, bearer);
  assert.equal(up.status, 200, up.text);
  const { slug } = up.json();
  const key = `versions/${slug}/v1.mp4`;
  assert.deepEqual(bunny.objects.get(key), fs.readFileSync(video));
  const review = store.loadReview(slug);
  assert.equal(review?.versions[0].stored, 'bunny');

  const media = await request('GET', `/media/${encodeURIComponent(slug)}/v1`, { headers: bearer });
  assert.equal(media.status, 302);
  assert.match(String(media.headers.location), /^https:\/\/cdn\.review\.test\/versions\/__%40uploads__Acme__clip\.mp4\/v1\.mp4\?token=HS256-/);
  assert.match(String(media.headers['content-security-policy'] || ''), /media-src 'self' blob: https:\/\/cdn\.review\.test/);

  // Evict the working copy: grabbing a frame for a note fetches it back from the zone.
  fs.rmSync(path.join(dir, 'cache/work/versions'), { recursive: true, force: true });
  const note = await request('POST', `/api/review/${encodeURIComponent(slug)}/comments`, { body: { frame: 5, text: 'hier' }, headers: bearer });
  assert.equal(note.status, 200, note.text);
  assert.ok(fs.existsSync(path.join(dir, 'cache/work/versions', slug, 'v1.mp4')));

  // A video without notes is deleted everywhere, including the zone.
  const other = await tusUpload(request, makeVideo(path.join(dir, 'in/other.mp4'), { w: 160, h: 90, dur: 1 }), { filename: 'other.mp4' }, bearer);
  const otherSlug = other.json().slug;
  assert.ok(bunny.objects.has(`versions/${otherSlug}/v1.mp4`));
  assert.equal((await request('DELETE', `/api/library/${encodeURIComponent(otherSlug)}`, { headers: bearer })).status, 200);
  for (let i = 0; i < 50 && bunny.objects.has(`versions/${otherSlug}/v1.mp4`); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(bunny.objects.has(`versions/${otherSlug}/v1.mp4`), false);
});

const drained = async () => {
  for (let i = 0; i < 600 && queued() > 0; i++) await new Promise((r) => setTimeout(r, 50));
};
const renderGets = (slug: string) => bunny.requests.filter((r) => r.method === 'GET' && decodeURIComponent(r.path).includes(`/versions/${slug}/`)).length;

test('hosted on Bunny: a cached poster or waveform never downloads the render again (player and review links)', async () => {
  const shares = await import('../../lib/shares.ts');
  const up = await tusUpload(request, makeVideo(path.join(dir, 'in/cached.mp4'), { w: 320, h: 180, dur: 1 }), { filename: 'cached.mp4' }, bearer);
  const { slug } = up.json();
  const s = encodeURIComponent(slug);
  const token = shares.createShare(slug, { label: 'Client' }).token;
  const urls = [
    [`/api/poster/${s}.jpg`, bearer],
    [`/api/waveform/${s}/1`, bearer],
    [`/api/g/${token}/poster/${s}`, {}],
    [`/api/g/${token}/waveform/${s}`, {}],
  ] as const;
  for (const [url, headers] of urls) assert.equal((await request('GET', url, { headers })).status, 200, url);
  await drained();
  fs.rmSync(path.join(dir, 'cache/work/versions'), { recursive: true, force: true });
  const before = renderGets(slug);
  for (const [url, headers] of urls) assert.equal((await request('GET', url, { headers })).status, 200, url);
  assert.equal(renderGets(slug), before, 'everything was cached: nothing may be fetched from the zone');
});

test('hosted on Bunny: a render with short keyframe gaps plays natively after a restart without being fetched again', async () => {
  const { createPlayback } = await import('../../server/playback.ts');
  const clip = makeVideo(path.join(dir, 'in/short-gop.mp4'), { w: 160, h: 90, dur: 1, gop: 10 });
  const { slug } = (await tusUpload(request, clip, { filename: 'short-gop.mp4' }, bearer)).json();
  await drained();
  const review = store.loadReview(slug);
  assert.ok(review);
  const ver = review.versions[0];
  assert.equal(createPlayback(() => {}).playable(review, ver).scrub, 'native', 'probed once, at upload');
  fs.rmSync(path.join(dir, 'cache/work/versions'), { recursive: true, force: true });
  const before = renderGets(slug);
  // A fresh process: nothing in memory.
  const p = createPlayback(() => {}).playable(review, ver, { build: true });
  await drained();
  assert.equal(p.scrub, 'native');
  assert.equal(renderGets(slug), before, 'the keyframe probe is remembered, not repeated');
});

test('hosted on Bunny: warming up after a restart downloads renders one at a time', async () => {
  const { createBackground } = await import('../../server/background.ts');
  const { createPlayback } = await import('../../server/playback.ts');
  const slugs: string[] = [];
  for (let i = 0; i < 4; i++) {
    const clip = makeVideo(path.join(dir, `in/warm${i}.mp4`), { w: 160, h: 90, dur: 1, freq: 300 + i * 100 });
    slugs.push((await tusUpload(request, clip, { filename: `warm${i}.mp4` }, bearer)).json().slug);
  }
  await drained();
  // A restart on a fresh box: no working copies, no posters.
  fs.rmSync(path.join(dir, 'cache/work/versions'), { recursive: true, force: true });
  fs.rmSync(path.join(dir, 'cache/posters'), { recursive: true, force: true });
  const broadcast = () => {};
  const background = createBackground(broadcast, createPlayback(broadcast), { projectFiles: false });
  bunny.getDelayMs = 40;
  bunny.maxParallelGets = 0;
  try {
    for (const slug of slugs) {
      const review = store.loadReview(slug);
      assert.ok(review);
      background.warm(review);
    }
    await drained();
  } finally {
    bunny.getDelayMs = 0;
  }
  assert.equal(bunny.maxParallelGets, 1, 'one render download at a time');
  for (const slug of slugs) {
    const ver = store.loadReview(slug)?.versions[0];
    assert.ok(ver && fs.existsSync(path.join(dir, 'cache/posters', `${renderKey(ver)}.jpg`)), `poster of ${slug}`);
  }
});

test('hosted on Bunny: "Download all" streams from the zone in ranges, bigger than the working copies, and resumes after eviction', async () => {
  const { setStorage } = await import('../../lib/storage/index.ts');
  const work = path.join(dir, 'cache/work-small');
  const clips = [0, 1, 2].map((i) => makeVideo(path.join(dir, `in/big${i}.mp4`), { w: 320, h: 180, dur: 1, freq: 200 + i * 150 }));
  // The working copies can't hold the whole folder, so its archive has to stream from the zone.
  const cap = clips.reduce((n, c) => n + fs.statSync(c).size, 0) - 1;
  setStorage(createRemoteStorage(createBunnyStore({ zone: 'zone', access_key: 'secret', storage_url: bunny.url }), { workDir: work, workCacheBytes: cap }));
  try {
    for (const [i, clip] of clips.entries()) assert.equal((await tusUpload(request, clip, { filename: `big${i}.mp4`, folder: 'Big' }, bearer)).status, 200);
    await drained();
    const port = (server.address() as AddressInfo).port;
    const get = async (url: string, headers: Record<string, string> = {}) => {
      const r = await fetch(`http://127.0.0.1:${port}${url}`, { headers: { ...bearer, ...headers } });
      return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) };
    };
    const seen = bunny.requests.length;
    const info = async () => JSON.parse((await get('/api/folders/download/info?folder=Big&kind=original')).body.toString());
    assert.equal(
      (await info()).bytes,
      clips.reduce((n, c) => n + fs.statSync(c).size, 0),
      'sizes known without downloading',
    );
    await drained();
    assert.equal((await info()).resumable, true, 'checksums computed straight from the zone');

    const full = await get('/api/folders/download?folder=Big&kind=original');
    assert.equal(full.status, 200);
    const etag = String(full.headers.get('etag'));
    assert.match(etag, /^"z-/);
    for (const clip of clips) assert.ok(full.body.includes(fs.readFileSync(clip)), `${path.basename(clip)} is in the zip, byte for byte`);
    const renderGetsSince = bunny.requests.slice(seen).filter((r) => r.method === 'GET' && r.path.includes('/versions/'));
    assert.ok(renderGetsSince.length > 0);
    assert.ok(
      renderGetsSince.every((r) => /^bytes=\d+-\d+$/.test(String(r.headers.range))),
      'every read is a ranged read: nothing is pulled into the working copies',
    );

    // A phone lost the connection halfway; meanwhile every working copy is gone.
    await drained();
    fs.rmSync(work, { recursive: true, force: true });
    const half = Math.floor(full.body.length / 2);
    const rest = await get('/api/folders/download?folder=Big&kind=original', { Range: `bytes=${half}-`, 'If-Range': etag });
    assert.equal(rest.status, 206);
    assert.ok(rest.body.equals(full.body.subarray(half)), 'the resumed part is byte-identical');
  } finally {
    setStorage(null);
  }
});

test('readiness: a Bunny zone with the wrong password fails /readyz, and the log (not the answer) says why', async () => {
  const { setStorage } = await import('../../lib/storage/index.ts');
  const { createReadiness } = await import('../../server/ready.ts');
  assert.equal((await request('GET', '/readyz')).json().checks.storage, true);
  setStorage(createRemoteStorage(createBunnyStore({ zone: 'zone', access_key: 'wrong', storage_url: bunny.url })));
  const log = console.error;
  const logged: string[] = [];
  console.error = (m: string) => logged.push(m);
  try {
    const r = await createReadiness({ minFree: 0, stopping: () => false }).check();
    assert.equal(r.ok, false);
    assert.deepEqual(r.checks, { data: true, disk: true, ffmpeg: true, storage: false });
    assert.match(r.details.storage || '', /401/);
    assert.ok(
      logged.some((l) => /not ready \(storage\): bunny zone: HTTP 401/.test(l)),
      logged.join(' | '),
    );
  } finally {
    console.error = log;
    setStorage(null);
  }
});
