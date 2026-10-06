// `vr source` and `vr preview` on the local store: where a render came from, a still of the fix before rendering, and
// what `vr show` tells the agent afterwards (project time of the note, the preview, the fix).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { age, FFMPEG, isolatedEnv, makeVideo, vr } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv({ vars: { VR_BY: 'agent:promo' } });
const store = await import('../../lib/store.ts');

const FPS = 25;
const video = makeVideo(path.join(dir, 'renders/spot.mp4'), { w: 320, h: 180, fps: FPS, dur: 2, pattern: 'testsrc2' });
age(video);
store.createOrGetReview(video, { by: 'tester' });
const slug = path.resolve(video).split('/').join('__');
const note = store.addComment(slug, { frame: 10, text: 'Logo zu früh', author: 'tester' });
const still = path.join(dir, 'fix.png');
execFileSync(FFMPEG, [
  '-v',
  'error',
  '-ss',
  ((10 - 0.5) / FPS).toFixed(6),
  '-i',
  video,
  '-frames:v',
  '1',
  '-vf',
  'drawbox=x=40:y=30:w=80:h=50:color=white:t=fill',
  '-y',
  still,
]);

test('vr source: where the render came from (project name only)', () => {
  const r = vr(['source', 'spot.mp4', '--app', 'After Effects', '--project', '/Volumes/Jobs/spot.aep', '--comp', 'Main', '--start-frame', '12'], env);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), 'v1: After Effects · spot.aep · Main (from frame 12)');
  assert.deepEqual(store.loadReview(slug)?.versions[0].source, { app: 'After Effects', project: 'spot.aep', comp: 'Main', start_frame: 12 });
  assert.match(vr(['source', 'spot.mp4'], env).err, /--app/);
});

test('vr preview --fixed: the still becomes the fix; vr show gives project time, the fix and the preview', () => {
  const r = vr(['preview', note.id, still, '--fixed', '--note', 'Logo kommt später'], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out.trim(), new RegExp(`^${note.id}: preview p_[a-f0-9]{10} still of f10 on v1 by agent:promo · marked fixed$`));
  const show = vr(['show', note.id], env).out;
  assert.match(show, /source: After Effects · spot\.aep · Main \(from frame 12\)/);
  assert.match(show, /project: 0\.880 s · frame 22 in After Effects · spot\.aep · Main \(from frame 12\) \(v1\)/);
  assert.match(show, /↳ agent:promo \[fixed v1\]: Logo kommt später Preview: still of 00:00:10 \(f10\) on top of v1\./);
  assert.match(show, /preview p_[a-f0-9]{10} still of f10 on v1 by agent:promo/);
});

test('vr preview refuses what is not a picture of this video, vr fix an unknown preview', () => {
  // A video file is taken as a clip: two seconds from the note's frame run past the end of the render.
  assert.match(vr(['preview', note.id, video], env).err, /the clip runs past the end of v1 \(frame 10 \+ 50 frames\)/);
  const wrong = vr(['preview', note.id, path.join(dir, 'missing.png')], env);
  assert.notEqual(wrong.code, 0);
  assert.match(vr(['fix', note.id, '--note', 'x', '--preview', 'p_0000000000'], env).err, /has no preview p_0000000000/);
});
