// The on-demand gate is shared by workspaces (A13 VERIFY-2). It was first come, first served for the whole server: one
// account's 300 parallel frame requests took its four places and its hundred waiting ones, and another workspace's
// person saving a note (its screenshot is a frame grab) was answered 503 in 19 ms. Now, while the server has several
// workspaces, each has at most ON_DEMAND.perWorkspace places running and waiting; an account's new frames are counted
// (429 past its limit); and a note whose screenshot finds no place is saved without it, the screenshot following from
// the job queue: a note is never lost to a busy server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, FFMPEG, isolatedEnv, makeVideo, tmpdir, until } from '../lib/helpers.ts';
import { tusUpload } from '../lib/http.ts';

// A slow stand-in for ffmpeg: it marks itself while it runs, per workspace (the one whose files it reads), and writes
// down how many of that workspace's ran at once; then it does the real work.
const work = tmpdir('vr-gate-share-');
const marks = path.join(work, 'marks');
fs.mkdirSync(marks);
const standIn = path.join(work, 'ffmpeg');
fs.writeFileSync(
  standIn,
  [
    '#!/bin/sh',
    `m=${JSON.stringify(marks)}`,
    'tag=o',
    `if [ -f ${JSON.stringify(path.join(work, 'flooder'))} ]; then f=$(cat ${JSON.stringify(path.join(work, 'flooder'))}); case "$*" in *"/w/$f/"*) tag=f ;; esac; fi`,
    'touch "$m/$tag.$$"',
    `ls "$m" | grep -c "^$tag\\." >> ${JSON.stringify(path.join(work, 'seen-'))}"$tag"`,
    'sleep 0.3',
    `${JSON.stringify(FFMPEG)} "$@"`,
    's=$?',
    'rm -f "$m/$tag.$$"',
    'exit $s',
    '',
  ].join('\n'),
  { mode: 0o755 },
);

const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_FFMPEG: standIn, VR_FOOTAGE: 'off', VR_OCR: 'off' } });
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const store = await import('../../lib/store.ts');
const { reviewDir } = await import('../../lib/paths.ts');
const { inWorkspace } = await import('../../lib/scope.ts');
const { queued } = await import('../../lib/jobs.ts');
const { RateLimit } = await import('../../lib/rateLimit.ts');
const { ctx, request } = await startApp();

const vera = await auth.createUser({ email: 'v@example.com', name: 'Vera', password: 'a long password', role: 'owner' });
const mallory = await auth.createUser({ email: 'm@example.com', name: 'Mallory', password: 'a long password', role: 'reviewer' });
const theirs = ws.createWorkspace({ name: 'Mallory Films', ownerId: mallory.id });
fs.writeFileSync(path.join(work, 'flooder'), theirs.id);
const asVera = { Authorization: `Bearer ${auth.createToken(vera.id, 't', { workspace: 'w1' }).token}` };
const asMallory = { Authorization: `Bearer ${auth.createToken(mallory.id, 't', { workspace: theirs.id }).token}` };

// 20 s at 25 fps: 500 frames, each one a grab of its own until it was made once
const upload = async (name: string, who: Record<string, string>) => {
  const clip = makeVideo(path.join(dir, `in/${name}`), { w: 320, h: 180, fps: 25, dur: 20 });
  age(clip);
  const up = await tusUpload(request, clip, { filename: name, folder: 'X' }, who);
  assert.equal(up.status, 200, up.text);
  return up.json().slug as string;
};
const flooded = await upload('flood.mp4', asMallory);
const spot = await upload('spot.mp4', asVera);
// the uploads' own warm-up (poster, analysis, Auto-check) runs in the job queue first
await until(() => queued() === 0, 'the warm-ups to finish', 300_000);

/** `n` frame requests at once, from `from` on; `seen` gets each status as it comes back. */
const flood = (who: Record<string, string>, slug: string, from: number, n: number, seen: number[]) =>
  Promise.all(
    Array.from({ length: n }, (_, i) =>
      request('GET', `/api/review/${slug}/frame?frame=${from + i}`, { headers: who }).then((r) => {
        seen.push(r.status);
        return r;
      }),
    ),
  );
const most = (tag: string) => {
  const f = path.join(work, `seen-${tag}`);
  return fs.existsSync(f) ? Math.max(0, ...fs.readFileSync(f, 'utf8').trim().split('\n').map(Number)) : 0;
};

test("one account's flood of frames takes its own workspace's places: another workspace's note gets its screenshot", { timeout: 300_000 }, async () => {
  // what is counted from here on: the flood (the uploads' warm-up ran several of its own at once in one job)
  for (const tag of ['f', 'o']) fs.rmSync(path.join(work, `seen-${tag}`), { force: true });
  const seen: number[] = [];
  const all = flood(asMallory, flooded, 0, 300, seen);
  // the flood has filled what it may: some of it is turned away
  await until(() => seen.some((s) => s === 503), 'the flood to fill its places', 60_000);
  const note = await request('POST', `/api/review/${spot}/comments`, { headers: asVera, body: { frame: 10, text: 'logo too small' } });
  assert.equal(note.status, 200, `the other workspace's note: ${note.status} ${note.text}`);
  assert.ok(note.json().shots?.clean, 'saved with its screenshot');
  const rs = await all;
  assert.ok(
    rs.some((r) => r.status === 503 && Number(r.headers['retry-after']) > 0),
    'the flood was told to come back later',
  );
  assert.ok(most('f') <= 2, `${most('f')} of the flooding workspace's ffmpeg ran at once`);
});

test('a note whose screenshot finds no place is saved without it, and the screenshot follows', { timeout: 300_000 }, async () => {
  const seen: number[] = [];
  // Vera's own workspace is busy with her own frames now
  const all = flood(asVera, spot, 100, 300, seen);
  await until(() => seen.some((s) => s === 503), 'the flood to fill its places', 60_000);
  const note = await request('POST', `/api/review/${spot}/comments`, {
    headers: asVera,
    body: { frame: 20, text: 'cut earlier', drawing: [{ type: 'box', x: 10, y: 10, w: 50, h: 40 }] },
  });
  assert.equal(note.status, 200, `the note: ${note.status} ${note.text}`);
  const id = note.json().id as string;
  await all;
  const shotsOf = () => inWorkspace('w1', () => store.loadReview(spot)?.comments.find((c) => c.id === id)?.shots);
  await until(() => !!shotsOf()?.marked, 'the screenshots to follow', 120_000);
  const shots = shotsOf();
  const folder = inWorkspace('w1', () => reviewDir(spot));
  for (const f of [shots?.clean, shots?.marked]) assert.ok(f && fs.existsSync(path.join(folder, f)), `${f} is there`);
});

test("an account's new frames are counted: past its limit, 429; a frame made before still comes", { timeout: 300_000 }, async () => {
  ctx.frameGrabs = new RateLimit(5, 3600_000);
  const codes: number[] = [];
  for (let f = 400; f < 406; f++) codes.push((await request('GET', `/api/review/${flooded}/frame?frame=${f}`, { headers: asMallory })).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429]);
  const over = await request('GET', `/api/review/${flooded}/frame?frame=406`, { headers: asMallory });
  assert.equal(over.status, 429);
  assert.ok(Number(over.headers['retry-after']) > 0, 'says when to ask again');
  assert.equal((await request('GET', `/api/review/${flooded}/frame?frame=400`, { headers: asMallory })).status, 200, 'made before: no grab');
  // another account is counted on its own
  assert.equal((await request('GET', `/api/review/${spot}/frame?frame=400`, { headers: asVera })).status, 200);
});
