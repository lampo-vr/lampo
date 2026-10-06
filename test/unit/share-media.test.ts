// What a review link's player streams: the render's own bytes only on links that offer the original as a download.
// Every other link plays a copy (the file its "Preview" download is), made on demand whatever the render's keyframe
// gaps, and until it exists the player is told to wait (425 + Retry-After). The copy keeps every frame's timestamp.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, md5, must, slugOf } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const shares = await import('../../lib/shares.ts');
const { FFPROBE } = await import('../../lib/probe.ts');

function track(rel: string, gop: number): { slug: string; file: string } {
  const file = makeVideo(path.join(dir, rel), { w: 160, h: 90, dur: 1, gop });
  age(file);
  store.createOrGetReview(file, { by: 'tester' });
  return { slug: slugOf(file), file };
}
// Long keyframe gaps (the owner's player gets a scrub copy too) and short ones (the owner plays the render itself).
const long = track('proj/export/long.mp4', 48);
const short = track('proj/export/short.mp4', 5);

const { port } = await startApp({ token: 'test-token', loadSessions: async () => [] });

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
  json: () => any;
}
// A visitor from elsewhere.
const get = (url: string): Promise<Reply> =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: url, headers: { 'x-forwarded-for': '203.0.113.9' } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({ status: res.statusCode || 0, headers: res.headers, body, json: () => JSON.parse(body.toString('utf8')) });
        });
      })
      .on('error', reject);
  });

const original = (slug: string) => fs.readFileSync(must(store.versionFile(must(store.loadReview(slug)), 1)));

/** The link's media URL for its video, and what the player streams from it once it plays. */
async function play(token: string): Promise<{ page: Reply; waited: Reply[]; media: Reply }> {
  const id = (await get(`/api/g/${token}`)).json().videos[0].slug;
  const plain = `/media/g/${token}/${id}/v1`;
  const waited: Reply[] = [];
  // The copy is a background job: up to a minute on a loaded machine.
  for (let i = 0; i < 1200; i++) {
    const page = await get(`/api/g/${token}/review/${id}`);
    assert.equal(page.status, 200, page.body.toString());
    const url = page.json().media;
    const media = await get(url || plain);
    if (media.status !== 425) {
      // Ready between the two requests: the page asked for before it doesn't name it yet, the next one does.
      if (!url) continue;
      return { page, waited, media };
    }
    waited.push(media);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the copy never got ready');
}

/** Every video frame's presentation time, in order. */
const frameTimes = (file: string): number[] =>
  execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b);

for (const [name, video] of [
  ['long keyframe gaps', long],
  ['short keyframe gaps', short],
] as const)
  test(`a preview link plays a copy, never the render's bytes (${name})`, async () => {
    const token = shares.createShare(video.slug, { label: 'Client', download: 'preview' }).token;
    const { page, waited, media } = await play(token);
    assert.equal(media.status, 200, media.body.toString());
    assert.notEqual(md5(media.body), md5(original(video.slug)), 'not the original');
    for (const w of waited) assert.ok(Number(w.headers['retry-after']) > 0, 'the player is told when to ask again');
    // The same file the link's "Preview" download hands out.
    const download = await get(page.json().download.preview);
    assert.equal(download.status, 200);
    assert.equal(md5(download.body), md5(media.body), 'the preview download is the file the player plays');
    // Frame-exact all the same: every frame of the render, at its own time.
    const copy = path.join(dir, `copy-${token}.mp4`);
    fs.writeFileSync(copy, media.body);
    const want = frameTimes(video.file);
    const got = frameTimes(copy);
    assert.equal(got.length, want.length, 'every frame');
    for (const [i, t] of got.entries()) assert.ok(Math.abs(t - want[i]) < 1e-3, `frame ${i} at ${t}, the render has it at ${want[i]}`);
    // Asking for "the original" by URL changes nothing.
    const id = page.json().slug;
    for (const q of ['', '?s=0', `?h=${page.json().media.split('h=')[1]?.slice(0, 10)}`]) {
      const again = await get(`/media/g/${token}/${id}/v1${q}`);
      assert.equal(md5(again.body), md5(media.body), `/media/g/…/v1${q}`);
    }
  });

test('a link with downloads off plays a copy too; an original link streams the render', async () => {
  const off = shares.createShare(long.slug, { label: 'Watchers' }).token;
  const watched = await play(off);
  assert.notEqual(md5(watched.media.body), md5(original(long.slug)));
  const full = shares.createShare(short.slug, { label: 'Agency', download: 'original' }).token;
  const id = (await get(`/api/g/${full}`)).json().videos[0].slug;
  const media = await get(`/media/g/${full}/${id}/v1`);
  assert.equal(media.status, 200);
  assert.equal(md5(media.body), md5(original(short.slug)), 'the original, as the link offers it anyway');
});
