// Fix previews: an agent attaches a still or clip of a fix made in the project, the reviewer verifies on it, and the
// next render is compared with it automatically (match → confirmed, mismatch → back to "check fixes").
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { age, FFMPEG, isolatedEnv, makeVideo } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const { attachPreview, confirmPreviews, matchPreview, previewsToCheck } = await import('../../lib/previews.ts');
const { stageOf } = await import('../../lib/stage.ts');
const { reviewDir } = await import('../../lib/paths.ts');

const W = 320;
const H = 180;
const FPS = 25;
const ffmpeg = (...args: string[]) => execFileSync(FFMPEG, ['-v', 'error', ...args, '-y']);
// A frame exactly as the render shows it (like a project export of an unchanged comp): frame N at (N − 0.5) / fps.
const still = (src: string, frame: number, out: string, vf = 'null') => {
  ffmpeg('-ss', ((frame - 0.5) / FPS).toFixed(6), '-i', src, '-frames:v', '1', '-vf', vf, out);
  return out;
};
const BOX = 'drawbox=x=40:y=30:w=80:h=50:color=white:t=fill';

const src = path.join(dir, 'renders/spot.mp4');
makeVideo(src, { w: W, h: H, fps: FPS, dur: 2, pattern: 'testsrc2' });
age(src);
store.createOrGetReview(src, { by: 'tester' });
const slug = path.resolve(src).split('/').join('__');
const note = store.addComment(slug, { frame: 10, text: 'Logo zu früh', author: 'tester' });
const v1 = () => store.loadReview(slug)?.versions[0] as NonNullable<ReturnType<typeof store.loadReview>>['versions'][number];
const shots = path.join(dir, 'shots');
fs.mkdirSync(shots, { recursive: true });

test('matching: the same frame (also re-encoded or at half resolution) matches, a changed one does not', async () => {
  const ver = v1();
  const meta = store.loadReview(slug)?.meta || {};
  const cases = {
    same: still(src, 10, path.join(shots, 'same.png')),
    jpeg: still(src, 10, path.join(shots, 'jpeg.jpg')),
    half: still(src, 10, path.join(shots, 'half.png'), `scale=${W / 2}:${H / 2}`),
    changed: still(src, 10, path.join(shots, 'changed.png'), BOX),
    neighbour: still(src, 14, path.join(shots, 'neighbour.png')),
  };
  const p = { id: 'p_test', kind: 'still' as const, frame: 10, v: 1, by: 'agent:x', at: '', width: W, height: H, file: '', bytes: 0 };
  const diff: Record<string, number> = {};
  for (const [name, file] of Object.entries(cases)) {
    const r = await matchPreview(file, name === 'half' ? { ...p, width: W / 2, height: H / 2 } : p, src, ver, meta, 10);
    diff[name] = r.diff;
    assert.equal(r.match, ['same', 'jpeg', 'half'].includes(name), `${name}: block difference ${r.diff}`);
  }
  assert.ok(diff.same < 2, `an exact export differs only by rounding (${diff.same})`);
  assert.ok(diff.changed > 20, `a filled box is far over the threshold (${diff.changed})`);
});

test('a still of the fix, the reviewer verifies on it, the stage waits for the render, final is refused', async () => {
  const file = still(src, 10, path.join(shots, 'fix.png'), BOX);
  const a = await attachPreview(note.id, file, {
    kind: 'still',
    fixed: true,
    note: 'Logo steht jetzt erst ab 0:01',
    source: { app: 'After Effects', comp: 'Main', time: 0.4 },
    by: 'agent:promo',
  });
  assert.ok(fs.existsSync(file), "the agent's own file stays where it is");
  assert.match(a.preview.id, /^p_[a-f0-9]{10}$/);
  assert.deepEqual([a.preview.kind, a.preview.frame, a.preview.v, a.preview.width], ['still', 10, 1, W]);
  assert.ok(fs.existsSync(path.join(reviewDir(slug), 'previews', a.preview.file)), 'stored in data/<slug>/previews');
  assert.equal(a.comment.status, 'fixed');
  const fix = a.comment.replies.at(-1);
  assert.equal(fix?.preview, a.preview.id);
  assert.match(fix?.text || '', /^Logo steht jetzt erst ab 0:01 Preview: still of 00:00:10 \(f10\) on top of v1\.$/);

  const verified = store.updateComment(note.id, { status: 'verified', preview: a.preview.id, by: 'tester' });
  assert.deepEqual(verified.verified_on, { preview: a.preview.id, v: 1 });
  const review = store.loadReview(slug);
  assert.ok(review);
  const st = stageOf(review);
  assert.equal(st.on_preview, 1);
  assert.equal(st.open, 0);
  assert.equal(st.stage, 'changes', 'resolved for the reviewer; the render is the next move');
  assert.match(st.detail, /^1 fix checked on a preview · V2 to render$/);
  assert.throws(() => store.setFinal(slug, {}, 'tester'), /verified on a preview only .*render the next version first/);
  assert.equal(previewsToCheck(review).length, 0, 'nothing to compare before a newer render exists');
});

test('the next render contains the fix: confirmed, the note stays verified, final is possible', async () => {
  makeVideo(src, { w: W, h: H, fps: FPS, dur: 2, pattern: 'testsrc2' });
  ffmpeg('-i', src, '-vf', BOX, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'copy', `${src}.fixed.mp4`);
  fs.renameSync(`${src}.fixed.mp4`, src);
  age(src);
  store.sync(slug);
  assert.equal(previewsToCheck(store.loadReview(slug) as never).length, 1);
  assert.equal(await confirmPreviews(slug), 1);
  const c = store.findComment(note.id)?.comment;
  assert.equal(c?.status, 'verified');
  assert.equal(c?.verified_on, undefined);
  assert.equal(c?.previews?.[0].confirmed?.v, 2);
  assert.ok((c?.previews?.[0].confirmed?.diff ?? 99) < 7);
  assert.match(c?.replies.at(-1)?.text || '', /^V2 matches the preview this fix was verified on/);
  const ev = store.readEvents({ limit: 5 }).at(-1);
  assert.deepEqual([ev?.type, ev?.by, ev?.id, ev?.reply?.preview], ['preview', 'system', note.id, c?.previews?.[0].id]);
  assert.equal(stageOf(store.loadReview(slug) as never).on_preview, 0);
  store.setFinal(slug, {}, 'tester');
  store.reopenFinal(slug, {}, 'tester');
});

test('a render without the fix: back to "check fixes" with the reason', async () => {
  const second = store.addComment(slug, { frame: 30, text: 'Unterzeile fehlt', author: 'tester' });
  const moved = 'drawbox=x=200:y=110:w=90:h=40:color=black:t=fill';
  const a = await attachPreview(second.id, still(src, 30, path.join(shots, 'fix2.png'), moved), { kind: 'still', fixed: true, by: 'agent:promo' });
  store.updateComment(second.id, { status: 'verified', preview: a.preview.id, by: 'tester' });
  // v3: re-rendered without that change.
  ffmpeg('-i', src, '-vf', 'eq=brightness=0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'copy', `${src}.v3.mp4`);
  fs.renameSync(`${src}.v3.mp4`, src);
  age(src);
  store.sync(slug);
  assert.equal(await confirmPreviews(slug), 1);
  const c = store.findComment(second.id)?.comment;
  assert.equal(c?.status, 'fixed');
  assert.equal(c?.fixed_in_v, 3);
  assert.equal(c?.verified_on, undefined);
  assert.equal(c?.previews?.[0].mismatch?.v, 3);
  assert.match(
    c?.replies.at(-1)?.text || '',
    /^V3 doesn't match the preview this fix was verified on \(block difference [\d.]+, a match stays below 7\): check it again\.$/,
  );
  assert.equal(stageOf(store.loadReview(slug) as never).stage, 'check_fixes');
  assert.equal(await confirmPreviews(slug), 0, 'settled once');
});

test('a clip: re-encoded for browsers, compared by its first and last frame', async () => {
  const third = store.addComment(slug, { frame: 5, text: 'Übergang zu hart', author: 'tester' });
  const clip = path.join(shots, 'clip.mov');
  // One second of the current render starting at frame 5, as a project would export it (another codec on purpose). Cut
  // by frame number: where an input seek lands differs between ffmpeg versions.
  ffmpeg('-i', src, '-vf', 'trim=start_frame=5:end_frame=30,setpts=PTS-STARTPTS', '-c:v', 'mpeg4', '-q:v', '2', '-an', clip);
  const a = await attachPreview(third.id, clip, { kind: 'clip', frame: 5, by: 'agent:promo' });
  assert.equal(a.preview.kind, 'clip');
  assert.equal(a.preview.frames, 25);
  assert.match(a.preview.file, /\.mp4$/);
  assert.equal(a.comment.status, 'open', 'without fixed it is a reply');
  assert.equal(a.comment.replies.at(-1)?.preview, a.preview.id);
  const ver = store.loadReview(slug)?.versions.at(-1);
  assert.ok(ver);
  const stored = path.join(reviewDir(slug), 'previews', a.preview.file);
  const r = await matchPreview(stored, a.preview, src, ver, store.loadReview(slug)?.meta || {}, 5);
  assert.ok(r.match, `the clip is the render: block difference ${r.diff}`);
});

test('refused: another frame shape, a still that is a video, a frame past the end, an unknown preview', async () => {
  const portrait = path.join(shots, 'portrait.png');
  ffmpeg('-f', 'lavfi', '-i', 'color=c=red:s=180x320', '-frames:v', '1', portrait);
  await assert.rejects(attachPreview(note.id, portrait, { kind: 'still', by: 'agent:x' }), /is 180×320 but v3 is 320×180/);
  await assert.rejects(attachPreview(note.id, src, { kind: 'still', by: 'agent:x' }), /a still must be a PNG, JPEG or WebP image/);
  await assert.rejects(attachPreview(note.id, still(src, 3, path.join(shots, 'x.png')), { kind: 'still', frame: 999, by: 'agent:x' }), /outside 0–49/);
  assert.throws(() => store.updateComment(note.id, { status: 'verified', preview: 'p_0000000000', by: 'tester' }), /has no preview p_0000000000/);
});

test('deleting a note removes its previews', async () => {
  const c = store.addComment(slug, { frame: 40, text: 'weg damit', author: 'tester' });
  const a = await attachPreview(c.id, still(src, 40, path.join(shots, 'del.png')), { kind: 'still', by: 'agent:x' });
  const file = path.join(reviewDir(slug), 'previews', a.preview.file);
  assert.ok(fs.existsSync(file));
  store.deleteComment(c.id, 'tester');
  for (let i = 0; i < 20 && fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(!fs.existsSync(file));
});

test('what agents read: vr watch lines and INBOX.md say verified on a preview, confirmed, check again', async () => {
  const { eventLine } = await import('../../lib/eventLine.ts');
  const lines = store.readEvents({ limit: 200 }).map(eventLine).join('\n');
  assert.match(lines, new RegExp(`VERIFIED ON A PREVIEW \\(the next render must contain it\\) ${note.id} .* by tester`));
  assert.match(lines, new RegExp(`PREVIEW CONFIRMED ${note.id} 00:00:10 spot\\.mp4 — "V2 matches the preview this fix was verified on`));
  assert.match(lines, /CHECK AGAIN c_[0-9a-f]{6} 00:01:05 spot\.mp4 by system — "V3 doesn't match the preview/);
  const inbox = store.renderInbox(store.inboxEvents());
  assert.match(inbox, /· VERIFIED ON A PREVIEW \(the next render must contain it\) ·/);
  assert.match(inbox, /· CHECK AGAIN ·/);
});
