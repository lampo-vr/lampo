// Partial renders against ffmpeg: the shots found in a render, a part sent only where a note allows it and only with
// the length it replaces (409 otherwise), its seams checked against the base, the splice frame-exact at and around both
// seams (compared with ffmpeg's own decode of the base and the part), its sound blended only when it differs, never
// final, and the next full render compared with the approved part.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { cutFrames, FFMPEG, fixBox, isolatedEnv, makeShotsVideo } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const { shotCuts } = await import('../../lib/cuts.ts');
const { snapToShots, partLine } = await import('../../lib/part.ts');
const { ingestPart, confirmParts, partsToConfirm } = await import('../../lib/parts.ts');
const { ensureSplice } = await import('../../lib/splice.ts');
const { eventLine } = await import('../../lib/eventLine.ts');
const { claudePrompt } = await import('../../lib/prompt.ts');
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const FPS = 25;
const N = 120;
const W = 320;
const H = 180;
const base = makeShotsVideo(path.join(dir, 'renders/spot.mp4'));
const fixed = makeShotsVideo(path.join(dir, 'renders/spot-fixed.mp4'), { extra: fixBox(40, 79) });
const spill = makeShotsVideo(path.join(dir, 'renders/spot-spill.mp4'), { extra: fixBox(30, 79) });
const quiet = makeShotsVideo(path.join(dir, 'renders/spot-quiet.mp4'), { extra: fixBox(40, 79), volume: 0.3 });
const cutOut = cutFrames;

const { review: r1, version: v1 } = await store.ingestUpload(base, { name: 'spot.mp4', folder: 'Tests', by: 'tester', keep: true });
const { slugify } = await import('../../lib/paths.ts');
const SLUG = slugify(r1.video);
let partNote = '';

test('the render’s shots, and a note that allows a part of them', async () => {
  const cuts = await shotCuts(base, v1);
  assert.deepEqual(cuts, [40, 80]);
  const part = snapToShots(cuts, v1.frames, { in: 50, out: 50 });
  assert.deepEqual(part, { in: 40, out: 79, shot: 2, to_shot: 2, handles: 12 });
  const c = store.addComment(SLUG, { frame: 50, text: 'The logo is missing here', part, author: 'Mia' });
  partNote = c.id;
  assert.deepEqual(c.part, part);
  // every agent format carries one line, and only for the note that allows it
  const line = partLine(part);
  assert.equal(line, 'PART RENDER OK: frames 40–79 (shot 2), handles 12');
  const ev = store.readEvents().findLast((e) => e.id === c.id);
  assert.ok(ev && eventLine(ev).includes(` · ${line}`));
  assert.ok(store.renderInbox(store.inboxEvents()).includes(`- ${line}`));
  const review = store.loadReview(SLUG) as NonNullable<ReturnType<typeof store.loadReview>>;
  assert.ok(store.renderReviewMd(review).includes(`- ${line}`));
  assert.ok(claudePrompt(review).includes(line));
  store.addComment(SLUG, { frame: 100, text: 'Fine otherwise', author: 'Mia' });
  assert.equal(claudePrompt(store.loadReview(SLUG) as typeof review).split('PART RENDER OK').length, 2, 'one note, one line');
});

test('a part is refused where nobody allowed one, or when its length changed', async () => {
  const at0 = cutOut(fixed, 0, 52, path.join(dir, 'parts/at0.mp4'));
  await assert.rejects(ingestPart(at0, { slug: SLUG, name: 'part.mp4', by: 'agent:x', keep: true, at: 0 }), (e: Error & { status?: number }) => {
    assert.equal(e.status, 409);
    assert.match(e.message, /no note allows a part render at frame 0 of v1 .*send a full render/);
    return true;
  });
  // five frames longer than the shot it replaces: what follows would move
  const longer = cutOut(fixed, 28, 97, path.join(dir, 'parts/longer.mp4'));
  await assert.rejects(ingestPart(longer, { slug: SLUG, name: 'part.mp4', by: 'agent:x', keep: true, at: 40 }), (e: Error & { status?: number }) => {
    assert.equal(e.status, 409);
    assert.match(e.message, /^the length changed: frames 40–79 with 12 handles are 64 frames, the part has 69\. .*send a full render$/);
    return true;
  });
  assert.equal(store.loadReview(SLUG)?.versions.length, 1, 'nothing was registered');
});

test('a part whose handles differ from the base: the seam jumps', async () => {
  const p = cutOut(spill, 28, 92, path.join(dir, 'parts/spill.mp4'));
  const r = await ingestPart(p, { slug: SLUG, name: 'part.mp4', by: 'agent:x', keep: true, at: 40 });
  assert.equal(r.version.v, 2);
  const seam = r.version.part?.seam;
  assert.ok(seam && seam !== 'clean' && seam.jump === 40, JSON.stringify(seam));
});

let partV = 0;
test('a clean part: the next version, the whole video on screen, its own bytes kept as sent', async () => {
  const p = cutOut(fixed, 28, 92, path.join(dir, 'parts/fixed.mp4'));
  const r = await ingestPart(p, { slug: SLUG, name: 'part.mp4', by: 'agent:x', keep: true, at: 40, handles: 12 });
  partV = r.version.v;
  assert.equal(partV, 3);
  assert.deepEqual(r.version.part, { of: 2, at: 40, frames: 40, handles: 12, seam: 'clean' });
  // the whole video's numbers, the part's own bytes
  assert.deepEqual([r.version.frames, r.version.fps, r.version.width, r.version.height], [N, FPS, W, H]);
  assert.equal(r.version.size, fs.statSync(p).size);
  const review = store.loadReview(SLUG) as NonNullable<ReturnType<typeof store.loadReview>>;
  assert.equal(fs.statSync(store.versionFile(review, partV) as string).size, fs.statSync(p).size, 'versions/ keeps the part as sent');
  assert.equal(review.frames, N);
  // the same bytes again: nothing new
  const again = await ingestPart(p, { slug: SLUG, name: 'part.mp4', by: 'agent:x', keep: true, at: 40, handles: 12 });
  assert.ok(again.duplicate);
});

// Grey 96×54 pictures of frame n of a file, decoded by ffmpeg (select=eq(n,N): the frame grabs' definition).
const SW = 96;
const SH = 54;
const frameOf = (file: string, n: number): Buffer =>
  execFileSync(
    FFMPEG,
    [
      '-v',
      'error',
      '-i',
      file,
      '-vf',
      `select=eq(n\\,${n}),scale=${SW}:${SH}:flags=area,format=gray`,
      '-fps_mode',
      'passthrough',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-',
    ],
    {
      maxBuffer: 1 << 24,
    },
  );
const mad = (a: Buffer, b: Buffer) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs((a[i] as number) - (b[i] as number));
  return s / a.length;
};

test('the splice is frame-exact at and around both seams', async () => {
  const review = store.loadReview(SLUG) as NonNullable<ReturnType<typeof store.loadReview>>;
  const ver = review.versions.find((x) => x.v === partV) as NonNullable<(typeof review.versions)[number]>;
  const spliced = await ensureSplice(review, ver);
  assert.ok(!spliced.includes(`${path.sep}versions${path.sep}`), 'never in versions/');
  assert.equal(await store.ensureVersionFile(review, partV), spliced, 'posters, grabs and analysis read the whole video');
  // every frame at N / fps
  const pts = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', spliced], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .map(Number)
    .sort((a, b) => a - b);
  assert.equal(pts.length, N);
  for (const [i, t] of pts.entries()) assert.ok(Math.abs(t - i / FPS) < 1e-3, `frame ${i} at ${t}`);
  const partFile = store.versionFile(review, partV) as string;
  // frame f of the video comes from the base outside 40–79, from the part's file (f − 40 + 12 handles) inside
  const expected = (f: number): [string, number] => (f >= 40 && f < 80 ? [partFile, f - 40 + 12] : [base, f]);
  for (const f of [0, 38, 39, 40, 41, 78, 79, 80, 81, N - 1]) {
    const shown = frameOf(spliced, f);
    const [file, n] = expected(f);
    const own = mad(shown, frameOf(file, n));
    assert.ok(own < 2.5, `frame ${f}: ${own} from ${path.basename(file)} f${n}`);
    // and not a neighbour: the frame before or after is further away
    for (const k of [n - 1, n + 1].filter((k) => k >= 0 && k < (file === base ? N : 64))) {
      const other = mad(shown, frameOf(file, k));
      assert.ok(own < other, `frame ${f} is f${n} of ${path.basename(file)}, not f${k} (${own} vs ${other})`);
    }
  }
  // the fix is there, the base around it unchanged
  assert.ok(mad(frameOf(spliced, 60), frameOf(fixed, 60)) < 2.5);
  assert.ok(mad(frameOf(spliced, 30), frameOf(base, 30)) < 2.5);
});

// Loudness (RMS) of a file's sound between two frames.
function rms(file: string, a: number, b: number): number {
  const pcm = execFileSync(
    FFMPEG,
    ['-v', 'error', '-i', file, '-af', `atrim=start=${a / FPS}:end=${b / FPS}`, '-ac', '1', '-ar', '12000', '-f', 's16le', '-'],
    {
      maxBuffer: 1 << 26,
    },
  );
  const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  let q = 0;
  for (const x of s) q += (x / 32768) ** 2;
  return Math.sqrt(q / s.length);
}
const duration = (file: string, stream: 'a:0' | 'v:0') =>
  Number(
    execFileSync('ffprobe', ['-v', 'error', '-select_streams', stream, '-show_entries', 'stream=duration', '-of', 'csv=p=0', file], {
      encoding: 'utf8',
    }).trim(),
  );

test('sound: the base’s straight through, or the part’s blended in where it differs', async () => {
  const review = store.loadReview(SLUG) as NonNullable<ReturnType<typeof store.loadReview>>;
  const same = await ensureSplice(review, review.versions.find((x) => x.v === partV) as never);
  assert.ok(Math.abs(rms(same, 50, 70) - rms(base, 50, 70)) < 0.005, 'the same sound: the base plays on');
  // a quieter part: its sound over its stretch, the base's around it, the length unchanged
  store.addComment(SLUG, { frame: 90, text: 'Last shot', part: { in: 80, out: 119, shot: 3, to_shot: 3, handles: 12 }, author: 'Mia' });
  const p = cutOut(quiet, 68, 120, path.join(dir, 'parts/quiet.mp4'));
  const r = await ingestPart(p, { slug: SLUG, name: 'part.mp4', by: 'agent:x', keep: true, at: 80 });
  assert.deepEqual(r.version.part, { of: partV, at: 80, frames: 40, handles: 12, seam: 'clean' });
  const review2 = store.loadReview(SLUG) as typeof review;
  const out = await ensureSplice(review2, r.version);
  const loud = rms(base, 20, 70);
  assert.ok(Math.abs(rms(out, 20, 70) - loud) < 0.005, `before the seam: the base (${rms(out, 20, 70)} vs ${loud}; part ${rms(out, 85, 115)})`);
  assert.ok(Math.abs(rms(out, 85, 115) - 0.3 * loud) < 0.006, `after it: the part's (${rms(out, 85, 115)} vs ${0.3 * loud})`);
  assert.ok(Math.abs(duration(out, 'a:0') - N / FPS) < 2 / FPS, `sound as long as the video: ${duration(out, 'a:0')}`);
  // and the picture of a part of a part comes from the files as sent
  assert.ok(mad(frameOf(out, 60), frameOf(fixed, 60)) < 2.5);
  assert.ok(mad(frameOf(out, 100), frameOf(quiet, 100)) < 2.5);
  partV = r.version.v;
});

test('a part is never final; the next full render is compared with the approved parts', async () => {
  assert.throws(
    () => store.setFinal(SLUG, {}, 'Mia'),
    (e: Error & { status?: number }) => e.status === 409 && /^V4 is a part \(frames 80–119 rendered into V3\): only a full render can be final/.test(e.message),
  );
  store.setApproval(SLUG, { status: 'approved', v: 3 }, 'Mia', { party: 'team' });
  store.setApproval(SLUG, { status: 'approved', v: 4 }, 'Mia', { party: 'team' });
  // a full render with the fix: it matches what was approved
  const full = await store.ingestUpload(fixed, { name: 'spot.mp4', slug: SLUG, by: 'agent:x', keep: true });
  assert.equal(full.version.part, undefined);
  let review = store.loadReview(SLUG) as NonNullable<ReturnType<typeof store.loadReview>>;
  // V2 (the seam that jumped) was never approved: nothing to answer for
  assert.deepEqual(
    partsToConfirm(review).map((x) => x.v),
    [3, 4],
  );
  assert.equal(await confirmParts(SLUG), 2);
  review = store.loadReview(SLUG) as typeof review;
  const v3 = review.versions.find((x) => x.v === 3)?.part;
  const v4 = review.versions.find((x) => x.v === 4)?.part;
  assert.equal(v3?.confirmed?.v, 5, 'the fix in V3 is in V5');
  // the picture is compared (V4's quieter sound is not the question)
  assert.equal(v4?.confirmed?.v, 5);
  assert.match(
    store.readEvents().findLast((e) => e.type === 'version')?.text || '',
    /^V5 matches the part approved in V4 \(frames 80–119, block difference [\d.]+\)\.$/,
  );
  assert.equal(partsToConfirm(review).length, 0, 'once');
});

test('a full render that lost the fix: where it differs, and the note goes back to check', async () => {
  const slug2 = (await store.ingestUpload(base, { name: 'other.mp4', folder: 'Tests', by: 'tester', keep: true })).review.video;
  const s2 = slugify(slug2);
  const c = store.addComment(s2, { frame: 50, text: 'Logo', part: { in: 40, out: 79, shot: 2, to_shot: 2, handles: 12 }, author: 'Mia' });
  const p = cutOut(fixed, 28, 92, path.join(dir, 'parts/fixed2.mp4'));
  await ingestPart(p, { slug: s2, name: 'part.mp4', by: 'agent:x', keep: true, at: 40 });
  store.updateComment(c.id, { status: 'fixed', fixed_in_v: 2, by: 'agent:x' });
  store.updateComment(c.id, { status: 'verified', by: 'Mia' });
  await store.ingestUpload(base, { name: 'other.mp4', slug: s2, by: 'agent:x', keep: true });
  assert.equal(await confirmParts(s2), 1);
  const review = store.loadReview(s2) as NonNullable<ReturnType<typeof store.loadReview>>;
  const mismatch = review.versions[1]?.part?.mismatch;
  assert.equal(mismatch?.v, 3);
  assert.equal(mismatch?.frame, 40, 'the first frame of the stretch that differs');
  const note = review.comments.find((x) => x.id === c.id);
  assert.equal(note?.status, 'fixed', 'back to check');
  assert.match(note?.replies.at(-1)?.text || '', /^V3 differs from the part approved in V2 at 00:01:15 \(f40, block difference [\d.]+\): check it again\.$/);
  void partNote;
});
