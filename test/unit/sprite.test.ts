// Hover-scrub sprites: the browser-safe layout (lib/sprite.ts), the sprite itself (lib/media.ts), its place at the end
// of the job queue, and the routes: 202 until it is made, then the image; share links only reach the videos they cover.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, FFMPEG, isolatedEnv, makeVideo, must, rawRgb, sleep, slugOf } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const folders = await import('../../lib/folders.ts');
const shares = await import('../../lib/shares.ts');
const { heavy, PRIORITY } = await import('../../lib/jobs.ts');
const { sprite } = await import('../../lib/media.ts');
const { SPRITE_COUNT, SPRITE_VERSION, spriteBackground, spriteFrame, spriteLayout, spriteTile, spriteUrl } = await import('../../lib/sprite.ts');

const FFPROBE = FFMPEG.replace(/ffmpeg$/, 'ffprobe');
const size = (file: string) =>
  execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();

test('layout: tiles fit the card’s 16:10 frame at twice its size, even sizes, percentages for CSS', () => {
  assert.deepEqual(spriteLayout(1920, 1080), { cols: 6, rows: 4, count: 24, tileW: 480, tileH: 270, width: 2880, height: 1080 });
  const portrait = spriteLayout(1080, 1920);
  assert.deepEqual([portrait.tileW, portrait.tileH], [168, 300], 'a reel fills the frame’s height');
  const scope = spriteLayout(2048, 858);
  assert.deepEqual([scope.tileW, scope.tileH], [480, 202], 'a scope render fills its width');
  assert.equal(spriteUrl('a b', '0123456789abcdef'), `/api/sprite/a%20b.jpg?h=0123456789&s=${SPRITE_VERSION}`, 'the layout version busts caches');
  const four5 = spriteLayout(1080, 1350);
  assert.ok(four5.tileW % 2 === 0 && four5.tileH % 2 === 0);
  assert.ok(Math.abs(four5.tileW / four5.tileH - 0.8) < 0.02, `4:5 stays 4:5 (${four5.tileW}×${four5.tileH})`);
  assert.equal(spriteFrame(0, 240), 5, 'the middle of the first slice');
  assert.equal(spriteFrame(SPRITE_COUNT - 1, 240), 235);
  assert.equal(spriteFrame(SPRITE_COUNT - 1, 10), 9, 'never past the last frame');
  assert.deepEqual([spriteTile(0), spriteTile(0.5), spriteTile(1)], [0, 12, 23]);
  assert.deepEqual(spriteBackground(0), { size: '600% 400%', position: '0% 0%' });
  assert.deepEqual(spriteBackground(23), { size: '600% 400%', position: '100% 100%' });
  assert.equal(spriteBackground(7).position, '20% 33.33333333333333%');
});

test('the sprite: a 6×4 grid of the render, tiles in order, small enough for a card', async () => {
  const file = makeVideo(path.join(dir, 'clips/wide.mp4'), { w: 640, h: 360, dur: 2, pattern: 'testsrc2', audio: false });
  const review = store.createOrGetReview(file, { by: 'tester' }).review;
  const ver = must(review.versions.at(-1));
  const out = await sprite(file, ver, review.meta);
  assert.equal(size(out), '2880,1080');
  // testsrc2 is a worst case (hard edges, saturated colour, text in every tile: ~290 KB); calm footage comes out near
  // 100 KB, a busy 1080p test pattern near 240 KB.
  assert.ok(fs.statSync(out).size < 320_000, `${fs.statSync(out).size} bytes`);
  // testsrc2 moves every frame: the first and the last tile show different moments.
  const tile = (i: number) => {
    const { tileW, tileH } = spriteLayout(640, 360);
    return rawRgb(['-i', out, '-vf', `crop=${tileW}:${tileH}:${(i % 6) * tileW}:${Math.floor(i / 6) * tileH}`]);
  };
  assert.notDeepEqual(tile(0), tile(23));
  const again = await sprite(file, ver, review.meta);
  assert.equal(again, out, 'cached by the render');
  assert.ok(path.basename(out).includes(`.v${SPRITE_VERSION}.`), 'the layout version is part of the cache key: old sprites are made again');
});

test("the queue: a sprite waits for every other kind of review work; footage search's index waits even for the sprite", async () => {
  // footage's index (lib/footage/) is not a review's work: it comes after everything a review needs, the sprite included
  for (const [kind, p] of Object.entries(PRIORITY)) if (kind !== 'sprite' && kind !== 'footage') assert.ok(PRIORITY.sprite > p, `sprite after ${kind}`);
  assert.ok(PRIORITY.footage > PRIORITY.sprite, 'footage after the sprite');
  const order: string[] = [];
  let release = () => {};
  const gate = heavy(() => new Promise<void>((r) => (release = r)), PRIORITY.scrub);
  const jobs = [
    heavy(() => order.push('sprite'), PRIORITY.sprite),
    heavy(() => order.push('crc'), PRIORITY.crc),
    heavy(() => order.push('qa'), PRIORITY.qa),
    heavy(() => order.push('scrub'), PRIORITY.scrub),
  ];
  await sleep(10);
  release();
  await Promise.all([gate, ...jobs]);
  assert.deepEqual(order, ['scrub', 'qa', 'crc', 'sprite']);
});

// ---------------------------------------------------------------- routes

function track(rel: string, folder: string | null): string {
  const file = makeVideo(path.join(dir, rel), { w: 320, h: 180, dur: 1 });
  age(file);
  store.createOrGetReview(file, { by: 'tester' });
  const slug = slugOf(file);
  if (folder) folders.moveVideo(slug, folder, 'tester');
  return slug;
}
const spot = track('proj/export/spot.mp4', 'Acme/Reels');
const other = track('proj/export/other.mp4', 'Acme/Other');

const { base } = await startApp({ token: 'test-token', loadSessions: async () => [] });

const guest = { 'x-forwarded-for': '203.0.113.7' };
// The sprite is a background job queued behind the poster: on a loaded machine (or CI's two cores) it takes a while.
async function untilReady(url: string, headers: Record<string, string> = {}): Promise<Response> {
  for (let i = 0; i < 600; i++) {
    const res = await fetch(base + url, { headers });
    if (res.status !== 202) return res;
    await sleep(100);
  }
  throw new Error(`${url} never got ready`);
}

test('GET /api/sprite: 202 with Retry-After while it is made, then the image, cached for good', async () => {
  const url = `/api/sprite/${encodeURIComponent(spot)}.jpg?v=1`;
  const first = await fetch(base + url);
  assert.equal(first.status, 202);
  assert.ok(Number(first.headers.get('retry-after')) >= 1);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await first.json(), { preparing: true });
  const done = await untilReady(url);
  assert.equal(done.status, 200);
  assert.equal(done.headers.get('content-type'), 'image/jpeg');
  assert.match(done.headers.get('cache-control') || '', /immutable/);
  const unknown = await fetch(`${base}/api/sprite/nope.jpg`);
  assert.equal(unknown.status, 404);
});

test('share links: the room serves sprites of its own videos only, and lists where they are', async () => {
  const room = shares.createShare({ folder: 'Acme/Reels' }, { by: 'tester', label: 'Reels' });
  const single = shares.createShare({ slug: other }, { by: 'tester', label: 'Other' });
  const link = (await (await fetch(`${base}/api/g/${room.token}`, { headers: guest })).json()) as {
    videos: { slug: string; name: string; sprite?: string }[];
  };
  const listed = must(link.videos.find((v) => v.name === 'spot.mp4'));
  assert.match(listed.slug, /^v_/, 'named by its id within the link, not its path');
  assert.equal(listed.sprite, `/api/g/${room.token}/sprite/${listed.slug}?v=1&s=${SPRITE_VERSION}`);
  assert.equal((await untilReady(must(listed.sprite), guest)).status, 200);
  assert.equal((await fetch(`${base}/api/g/${room.token}/sprite/${encodeURIComponent(other)}`, { headers: guest })).status, 404, 'not in the room');
  assert.equal((await fetch(`${base}/api/g/${single.token}/sprite/${encodeURIComponent(spot)}`, { headers: guest })).status, 404, 'another video');
  assert.notEqual((await fetch(`${base}/api/g/${single.token}/sprite/${encodeURIComponent(other)}`, { headers: guest })).status, 404);
  shares.revokeShare(room.token);
  assert.equal((await fetch(`${base}/api/g/${room.token}/sprite/${encodeURIComponent(spot)}`, { headers: guest })).status, 404, 'revoked');
});

test('renders in remote storage: fetched once to make the sprite, never again to serve it', async () => {
  const { createRemoteStorage, setStorage } = await import('../../lib/storage/index.ts');
  const { reviewFile } = await import('../../lib/paths.ts');
  // A render whose only copy lives in (mock) Bunny storage, like every upload on a hosted server.
  const file = makeVideo(path.join(dir, 'proj/export/remote.mp4'), { w: 320, h: 180, dur: 1, pattern: 'testsrc2' });
  age(file);
  store.createOrGetReview(file, { by: 'tester' });
  const slug = slugOf(file);
  const key = store.versionKey(slug, 1, '.mp4');
  const bucket = path.join(dir, 'bucket');
  fs.mkdirSync(path.dirname(path.join(bucket, key)), { recursive: true });
  fs.renameSync(store.snapshotPath(slug, 1, '.mp4'), path.join(bucket, key));
  fs.rmSync(file);
  const json = JSON.parse(fs.readFileSync(reviewFile(slug), 'utf8'));
  json.versions[0].stored = 'bunny';
  fs.writeFileSync(reviewFile(slug), JSON.stringify(json));

  let downloads = 0;
  const workDir = path.join(dir, 'work');
  setStorage(
    createRemoteStorage(
      {
        kind: 'bunny',
        put: async () => {},
        get: async (k, to) => {
          downloads++;
          fs.copyFileSync(path.join(bucket, k), to);
        },
        read: (k, start, end) => {
          downloads++;
          return fs.createReadStream(path.join(bucket, k), { start, end });
        },
        check: async () => {},
        remove: async () => {},
        url: () => null,
        origins: () => [],
      },
      { workDir },
    ),
  );
  try {
    const url = `/api/sprite/${encodeURIComponent(slug)}.jpg?v=1`;
    assert.equal((await fetch(base + url)).status, 202);
    assert.equal((await untilReady(url)).status, 200);
    assert.equal(downloads, 1, 'the job fetched the render to tile it');
    // The working copy is gone (the cache is size-capped): serving the finished sprite must not fetch it again.
    fs.rmSync(workDir, { recursive: true, force: true });
    for (let i = 0; i < 3; i++) assert.equal((await fetch(base + url)).status, 200);
    assert.equal(downloads, 1, 'a cached sprite costs no storage download');
  } finally {
    setStorage(null);
  }
});
