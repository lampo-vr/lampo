// `vr push --part-at` on the local store, for a render linked on this machine: the note's PART RENDER OK in `vr open`,
// the part as the next version (by frame or timecode), refused without its video or with another length, and the
// render on disk never taken for a re-render afterwards.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { age, cutFrames, fixBox, isolatedEnv, makeShotsVideo, vr } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv({ vars: { VR_BY: 'agent:promo' } });
const store = await import('../../lib/store.ts');

const video = makeShotsVideo(path.join(dir, 'Spot/export/spot.mp4'));
age(video);
store.createOrGetReview(video, { by: 'tester' });
const slug = path.resolve(video).split('/').join('__');
const note = store.addComment(slug, { frame: 50, text: 'Logo missing', part: { in: 40, out: 79, shot: 2, to_shot: 2, handles: 12 }, author: 'Mia' });
const fixed = makeShotsVideo(path.join(dir, 'renders/fixed.mp4'), { extra: fixBox(40, 79) });

test('vr open: the note says a part is fine', () => {
  const r = vr(['open', 'spot.mp4'], env);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes(`\n    Logo missing\n    PART RENDER OK: frames 40–79 (shot 2), handles 12\n`), r.out);
  assert.match(r.out, new RegExp(`${note.id} +OPEN`));
});

test('vr push --part-at: only with its video, only with the length it replaces', () => {
  const part = cutFrames(fixed, 28, 92, path.join(dir, 'parts/part.mp4'));
  assert.match(vr(['push', part, '--part-at', '40'], env).err, /a part goes into a video: lampo push part\.mp4 --to <video> --part-at <frame>/);
  const longer = vr(['push', cutFrames(fixed, 28, 97, path.join(dir, 'parts/longer.mp4')), '--to', 'spot.mp4', '--part-at', '40'], env);
  assert.notEqual(longer.code, 0);
  assert.match(longer.err, /the length changed: frames 40–79 with 12 handles are 64 frames, the part has 69/);
  // 00:01:15 at 25 fps is frame 40
  const r = vr(['push', part, '--to', 'spot.mp4', '--part-at', '00:01:15'], env);
  assert.equal(r.code, 0, r.err);
  assert.match(
    r.out,
    /^new version: .*spot\.mp4 \(v2, a part: frames 40–79 of v1\) · seams clean\n {4}a part is never final: send a full render once it is approved\nNow listen with lampo watch \(keep it running\): the person's notes arrive together when they press Send\.\n$/,
  );
  const json = JSON.parse(vr(['push', part, '--to', 'spot.mp4', '--part-at', '40', '--json'], env).out);
  assert.equal(json.duplicate, true);
  // the file on disk is still V1's: syncing finds nothing new
  assert.equal(vr(['sync', 'spot.mp4'], env).code, 0);
  assert.deepEqual(
    store.loadReview(slug)?.versions.map((v) => v.part?.of ?? null),
    [null, 1],
  );
});

test('a full render to the path after a part is the next version; the part’s bytes stay as they were', () => {
  const versions = path.join(`${env.VR_DATA}-versions`, slug);
  const before = fs.readFileSync(path.join(versions, 'v2.mp4'));
  fs.copyFileSync(fixed, video);
  age(video);
  const r = vr(['sync', 'spot.mp4'], env);
  assert.equal(r.code, 0, r.err);
  const review = store.loadReview(slug);
  assert.deepEqual(
    review?.versions.map((v) => v.part?.of ?? null),
    [null, 1, null],
  );
  assert.ok(before.equals(fs.readFileSync(path.join(versions, 'v2.mp4'))), 'versions/v2 is never written over');
  assert.equal(fs.statSync(path.join(versions, 'v3.mp4')).size, fs.statSync(fixed).size, 'the re-render has its own number');
});
