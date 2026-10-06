// Media work someone waits for runs ffmpeg outside the job queue (a frame for an agent, a note's screenshots, a contact
// sheet, a reference): at most ON_DEMAND.atOnce runs of it at once across the server, each on two threads, the rest
// waiting their turn, and past ON_DEMAND.waiting a 503 with Retry-After (A13 MEDIA-4: one viewer's 40 parallel frame
// requests ran 33 ffmpeg with 573 threads; a container may be held to 1024 processes and threads in all).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, FFMPEG, isolatedEnv, makeVideo, tmpdir, until } from '../lib/helpers.ts';
import { tusUpload } from '../lib/http.ts';

// A counting stand-in for ffmpeg: it marks itself while it runs, writes down how many ran at once and with what
// arguments, takes a moment, then does the real work.
const work = tmpdir('vr-on-demand-');
const marks = path.join(work, 'marks');
fs.mkdirSync(marks);
const standIn = path.join(work, 'ffmpeg');
fs.writeFileSync(
  standIn,
  [
    '#!/bin/sh',
    `m=${JSON.stringify(marks)}`,
    'touch "$m/run.$$"',
    `ls "$m" | grep -c '^run\\.' >> ${JSON.stringify(path.join(work, 'seen'))}`,
    `echo "$*" >> ${JSON.stringify(path.join(work, 'args'))}`,
    'sleep 0.2',
    `${JSON.stringify(FFMPEG)} "$@"`,
    's=$?',
    'rm -f "$m/run.$$"',
    'exit $s',
    '',
  ].join('\n'),
  { mode: 0o755 },
);

const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_FFMPEG: standIn, VR_FOOTAGE: 'off', VR_OCR: 'off' } });
const auth = await import('../../lib/auth.ts');
const { queued } = await import('../../lib/jobs.ts');
const probe = await import('../../lib/probe.ts');
const { request } = await startApp();
const owner = await auth.createUser({ email: 'o@example.com', name: 'Owner', password: 'a long password', role: 'owner' });
(await import('../../lib/workspaces.ts')).createWorkspace({ name: 'Other', ownerId: owner.id });
const asOwner = { Authorization: `Bearer ${auth.createToken(owner.id, 't', { workspace: 'w1' }).token}` };

const clip = makeVideo(path.join(dir, 'in/spot.mp4'), { w: 320, h: 180, fps: 25, dur: 3 });
age(clip);
const up = await tusUpload(request, clip, { filename: 'spot.mp4', folder: 'X' }, asOwner);
assert.equal(up.status, 200, up.text);
const slug = up.json().slug as string;
// the upload's own warm-up (poster, analysis, Auto-check) runs in the job queue first: it isn't what is counted here
await until(() => queued() === 0, 'the warm-up to finish', 120_000);

const fresh = () => {
  for (const f of ['seen', 'args']) fs.rmSync(path.join(work, f), { force: true });
};
const most = () => Math.max(0, ...fs.readFileSync(path.join(work, 'seen'), 'utf8').trim().split('\n').map(Number));
const frames = (from: number, n: number) =>
  Promise.all(Array.from({ length: n }, (_, i) => request('GET', `/api/review/${slug}/frame?frame=${from + i}`, { headers: asOwner })));

// This server has two workspaces: one of them has its share of the gate (A13 VERIFY-2, media-gate-share.test.ts).
test('parallel frame requests take turns: two of a workspace at once (four on the server), each on two threads', { timeout: 300_000 }, async () => {
  fresh();
  const { atOnce, waiting } = probe.ON_DEMAND.perWorkspace;
  const rs = await frames(0, atOnce + waiting);
  assert.deepEqual([...new Set(rs.map((r) => r.status))], [200], 'every frame came, in turn');
  assert.ok(most() <= 2, `${most()} ffmpeg ran at once`);
  const grabs = fs.readFileSync(path.join(work, 'args'), 'utf8').trim().split('\n');
  assert.equal(grabs.length, atOnce + waiting);
  for (const a of grabs) assert.match(a, /-filter_threads 2 .*-threads 2 .*-i .*-threads 2 /, a);
  assert.deepEqual([probe.ON_DEMAND.atOnce, atOnce, waiting], [4, 2, 10], 'the defaults');
});

test('past the waiting places, a frame request is answered 503 with Retry-After at once', { timeout: 300_000 }, async () => {
  fresh();
  const was = { ...probe.ON_DEMAND };
  probe.ON_DEMAND.waiting = 6;
  try {
    const rs = await frames(40, 30);
    const busy = rs.filter((r) => r.status === 503);
    assert.ok(busy.length >= 30 - probe.ON_DEMAND.atOnce - 6, `${busy.length} of 30 answered 503`);
    assert.ok(
      busy.every((r) => Number(r.headers['retry-after']) > 0),
      'each says when to ask again',
    );
    assert.match(busy[0]?.json().error ?? '', /busy/);
    assert.ok(most() <= probe.ON_DEMAND.atOnce, `${most()} ffmpeg ran at once`);
  } finally {
    Object.assign(probe.ON_DEMAND, was);
  }
});
