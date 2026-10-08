// A phone plays a copy made for it (server/playback.ts): the scrub copy is full size at CRF 14, more than a phone's
// connection carries. A phone (its User-Agent) asking for a version bigger than PHONE_FROM gets `phone` (the team's
// player) or `phoneMedia` (a review link) once the copy exists: at most 1280 px on the long side, every frame at its
// own time, no B-frames, a keyframe every 10 frames, so stepping stays frame-exact. A computer is never told of one,
// a small version gets none, and `?p=1` never streams other bytes than the phone copy's.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, md5, slugOf, until } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const shares = await import('../../lib/shares.ts');
const { FFPROBE } = await import('../../lib/probe.ts');

function track(rel: string, w: number, h: number): { slug: string; file: string } {
  const file = makeVideo(path.join(dir, rel), { w, h, fps: 25, dur: 2, pattern: 'testsrc2', gop: 48 });
  age(file);
  store.createOrGetReview(file, { by: 'tester' });
  return { slug: slugOf(file), file };
}
const big = track('proj/export/big.mp4', 1600, 900);
const small = track('proj/export/small.mp4', 320, 180);

const { port } = await startApp({ token: 'test-token', loadSessions: async () => [] });

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

interface Reply {
  status: number;
  body: Buffer;
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
  json: () => any;
}
// `guest`: a visitor from elsewhere (a review link); otherwise the machine's own owner
const get = (url: string, ua: string, guest = false): Promise<Reply> =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: url, headers: { 'user-agent': ua, ...(guest ? { 'x-forwarded-for': '203.0.113.9' } : {}) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({ status: res.statusCode || 0, body, json: () => JSON.parse(body.toString('utf8')) });
        });
      })
      .on('error', reject);
  });

const probe = (file: string, entries: string): string =>
  execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', entries, '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
/** Every video frame's presentation time, in order. */
const frameTimes = (file: string): number[] =>
  probe(file, 'packet=pts_time')
    .split('\n')
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b);
/** The longest run of frames between keyframes. */
const longestGop = (file: string): number => {
  let gap = 0;
  let worst = 0;
  for (const line of probe(file, 'packet=flags').split('\n')) {
    if (!line) continue;
    if (line.includes('K')) gap = 0;
    else worst = Math.max(worst, ++gap);
  }
  return worst + 1;
};

test('a computer is never told of a phone copy; a phone gets one for a big version, frame-exact and phone-sized', async () => {
  const page = `/api/review/${encodeURIComponent(big.slug)}`;
  const desk = (await get(page, MAC)).json();
  assert.equal(desk.media[1].phone, undefined, 'a computer plays the scrub copy or the render');
  // Not there yet: its URL streams nothing else meanwhile.
  const early = await get(`/media/${encodeURIComponent(big.slug)}/v1?h=x&p=1`, MAC);
  assert.equal(early.status, 404, 'no other bytes under the phone copy’s URL while it is being made');
  // A phone asks: the copy is made, and named once it exists (a background job: up to a minute on a loaded machine).
  const url: string = await until(async () => (await get(page, IPHONE)).json().media[1].phone, 'the phone copy', 60_000);
  assert.match(url, /[?&]p=1(&|$)/);
  const media = await get(url, IPHONE);
  assert.equal(media.status, 200, media.body.toString().slice(0, 200));
  const copy = path.join(dir, 'phone-copy.mp4');
  fs.writeFileSync(copy, media.body);
  assert.equal(probe(copy, 'stream=width,height'), '1280,720', 'at most 1280 px on the long side');
  assert.equal(probe(copy, 'stream=has_b_frames'), '0', 'no B-frames');
  assert.ok(longestGop(copy) <= 10, `a keyframe every 10 frames (longest run ${longestGop(copy)})`);
  const want = frameTimes(big.file);
  const got = frameTimes(copy);
  assert.equal(got.length, want.length, 'every frame');
  for (const [i, t] of got.entries()) assert.ok(Math.abs(t - want[i]) < 1e-3, `frame ${i} at ${t}, the render has it at ${want[i]}`);
  assert.ok(media.body.length < fs.statSync(big.file).size * 4, 'not the size of the scrub copy');
  // An Android phone gets the same copy; a computer still isn't told of it.
  assert.equal((await get(page, ANDROID)).json().media[1].phone, url);
  assert.equal((await get(page, MAC)).json().media[1].phone, undefined);
});

test('a small version plays as it is on a phone: no copy, and its phone URL streams nothing', async () => {
  const page = `/api/review/${encodeURIComponent(small.slug)}`;
  assert.equal((await get(page, IPHONE)).json().media[1].phone, undefined);
  const none = await get(`/media/${encodeURIComponent(small.slug)}/v1?p=1`, IPHONE);
  assert.equal(none.status, 404);
});

test('a review link: a phone plays the phone copy (never the original), a computer the link’s own copy', async () => {
  const token = shares.createShare(big.slug, { label: 'Client', download: 'preview' }).token;
  const id = (await get(`/api/g/${token}`, IPHONE, true)).json().videos[0].slug;
  const page = `/api/g/${token}/review/${id}`;
  const url: string = await until(async () => (await get(page, IPHONE, true)).json().phoneMedia, 'the link’s phone copy', 60_000);
  assert.match(url, new RegExp(`^/media/g/${token}/`));
  const media = await get(url, IPHONE, true);
  assert.equal(media.status, 200);
  assert.notEqual(md5(media.body), md5(fs.readFileSync(big.file)), 'never the original');
  const owner = (await get(`/api/review/${encodeURIComponent(big.slug)}`, IPHONE)).json().media[1].phone;
  assert.equal(md5(media.body), md5((await get(owner, IPHONE)).body), 'the one phone copy of the version');
  assert.equal((await get(page, MAC, true)).json().phoneMedia, undefined, 'a computer is never told of it');
});
