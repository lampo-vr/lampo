// `vr ref` and `vr add --overall` on the local store: an image, a link and a moment of another render on a note, and
// what `vr show` and `vr watch` tell the agent afterwards.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { age, FFMPEG, isolatedEnv, makeVideo, vr } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv({ vars: { VR_BY: 'agent:promo' } });
const store = await import('../../lib/store.ts');
const { eventLine } = await import('../../lib/eventLine.ts');

const video = makeVideo(path.join(dir, 'renders/spot.mp4'), { w: 320, h: 180, fps: 25, dur: 2, pattern: 'testsrc2' });
const other = makeVideo(path.join(dir, 'renders/other.mp4'), { w: 320, h: 180, fps: 25, dur: 2, freq: 660 });
age(video);
age(other);
store.createOrGetReview(video, { by: 'tester' });
store.createOrGetReview(other, { by: 'tester' });
const slug = path.resolve(video).split('/').join('__');
const note = store.addComment(slug, { frame: 10, text: 'Mehr Tempo', author: 'tester' });
const png = path.join(dir, 'ref.png');
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=200x100', '-frames:v', '1', '-y', png]);

test('vr ref: an image, a link and a moment of another render, each with a note (a reply) or a caption', () => {
  const img = vr(['ref', note.id, png, '--caption', 'Farbe so', '--note', 'So meine ich die Farbe'], env);
  assert.equal(img.code, 0, img.err);
  assert.match(img.out, /reference r_[a-f0-9]{10} image 200×100 — "Farbe so" \(by agent:promo\)/);
  const link = vr(['ref', note.id, 'https://example.com/pace', '--note', 'Tempo wie hier'], env);
  assert.equal(link.code, 0, link.err);
  // --to takes a timecode like --at (a plain number is a frame, as before)
  const moment = vr(['ref', note.id, '--video', 'other.mp4', '--at', '00:00:12', '--to', '00:00:20', '--note', 'Wie im anderen'], env);
  assert.equal(moment.code, 0, moment.err);
  assert.match(moment.out, /frame of other\.mp4 v1 at 00:00:12 \(f12\) to 00:00:20 \(f20\)/);
  const bare = vr(['ref', note.id], env);
  assert.notEqual(bare.code, 0);
  assert.match(bare.err, /usage: lampo ref/);

  const show = vr(['show', note.id], env);
  assert.equal(show.code, 0, show.err);
  const refs = show.out.split('\n').filter((l) => /^\s+ref r_/.test(l));
  assert.equal(refs.length, 3, show.out);
  const file = show.out.match(/\n\s+(\/\S+\.png)\n/)?.[1];
  assert.ok(file && fs.existsSync(file), `the image's path on this machine: ${file}`);
});

test('vr add --overall: a note about the whole video (no screenshots), flagged for agents; vr watch lines', () => {
  const r = vr(['add', 'spot.mp4', '--overall', '--text', 'Insgesamt zu hektisch', '--kind', 'feedback'], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /about the whole video/);
  const c = store.loadReview(slug)?.comments.find((x) => x.text === 'Insgesamt zu hektisch');
  assert.equal(c?.scope, 'video');
  assert.equal(c?.shots, null);
  const open = vr(['open', 'spot.mp4', '--all'], env);
  assert.match(open.out, /OVERALL: about the whole video/, open.err);
  // What `vr watch` prints for them (one line per event).
  const lines = store.readEvents({ limit: 20 }).map(eventLine).join('\n');
  assert.match(lines, /overall: about the whole video, not frame 0/);
  assert.match(lines, /REPLY c_\w+ .* \+ 1 reference/);
});
