// Two processes uploading one video at once (the server and a `vr push` on it): the bytes of version N are stored
// before the review's lock is taken, so an upload holds a reservation from choosing N until N is registered. Another
// upload meanwhile is refused at once (409), never waited for and never written; one left by a process that died, or
// by an earlier run of this pid, is taken over.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { age, isolatedEnv, makeVideo, must } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const { DATA, slugify, VERSIONS } = await import('../../lib/paths.ts');

let n = 0;
/** A render with its own picture (so every upload is new bytes). */
function render(): string {
  const file = path.join(dir, 'incoming', `r${++n}.mp4`);
  const patterns = ['testsrc', 'testsrc2', 'smptebars', 'rgbtestsrc', 'yuvtestsrc', 'smptehdbars', 'pal75bars', 'pal100bars'];
  makeVideo(file, { w: 64, h: 36, dur: 0.5, audio: false, pattern: patterns[n % patterns.length] });
  age(file);
  return file;
}
const slug = slugify(store.uploadVideoPath('Raw', 'spot.mp4'));
const upload = () => store.ingestUpload(render(), { name: 'spot.mp4', folder: 'Raw', by: 'olivia' });
const stored = () => (fs.existsSync(path.join(VERSIONS, slug)) ? fs.readdirSync(path.join(VERSIONS, slug)).sort() : []);
const reservation = path.join(DATA, '.uploads', slug);
/** A reservation someone else holds: its owner (pid@host) and the run of that pid. */
function held(owner: string, run = 'another run'): void {
  fs.mkdirSync(reservation, { recursive: true });
  fs.writeFileSync(path.join(reservation, 'owner'), owner);
  fs.writeFileSync(path.join(reservation, 'run'), run);
}
const refused = (e: Error & { status?: number }) => e.status === 409 && /another upload of this video is in progress/.test(e.message);

test('the first upload while another process holds the video: 409, nothing stored', async () => {
  held(`${process.ppid}@${os.hostname()}`);
  const t0 = Date.now();
  await assert.rejects(upload(), refused);
  assert.ok(Date.now() - t0 < 5000, 'refused at once, not waited for');
  assert.deepEqual(stored(), []);
  assert.equal(store.loadReview(slug), null);
  fs.rmSync(reservation, { recursive: true, force: true });

  const first = await upload();
  assert.equal(first.version.v, 1);
  assert.ok(!fs.existsSync(reservation), 'released once registered');
});

test('the next version while another process holds the video: 409, v1’s bytes untouched', async () => {
  const before = fs.readFileSync(path.join(VERSIONS, slug, 'v1.mp4'));
  held(`${process.ppid}@${os.hostname()}`);
  await assert.rejects(upload(), refused);
  assert.deepEqual(stored(), ['v1.mp4']);
  assert.deepEqual(fs.readFileSync(path.join(VERSIONS, slug, 'v1.mp4')), before);
  assert.equal(must(store.loadReview(slug)).versions.length, 1);
  fs.rmSync(reservation, { recursive: true, force: true });
});

test('a reservation left by a process that died, or by an earlier run of this pid, is taken over', async () => {
  const dead = must(spawnSync(process.execPath, ['-e', '']).pid, 'a finished pid');
  held(`${dead}@${os.hostname()}`);
  assert.equal((await upload()).version.v, 2);
  held(`${process.pid}@${os.hostname()}`, 'an earlier run');
  assert.equal((await upload()).version.v, 3);
  assert.ok(!fs.existsSync(reservation));
});

test('an upload that fails while it holds the video releases it', async () => {
  // Storing v4 fails: something that isn't a render sits where it would go.
  const blocker = path.join(VERSIONS, slug, 'v4.mp4');
  fs.mkdirSync(path.join(blocker, 'x'), { recursive: true });
  await assert.rejects(upload(), (e: Error & { status?: number }) => e.status !== 409);
  assert.ok(!fs.existsSync(reservation));
  fs.rmSync(blocker, { recursive: true, force: true });
  assert.equal((await upload()).version.v, 4);
});
