// The first run's sample (lib/sample.ts): a real two-version cut of Lampo's brand film, committed in lib/sample-film/.
// The two files are the same picture frame for frame — same size, rate, frame count and duration, the same pixels
// everywhere but where the title sits (over the car in V1, on the hill in V2) — and the sample made from them carries
// the notes that tell the loop: the teammate's must on V1 fixed in V2 and waiting for a check, an idea answered, the
// agent's question with answers to pick. None of it is logged, and the committed files stay as they are.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv();
const { FFMPEG, probe } = await import('../../lib/probe.ts');
const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');
const { SAMPLE_CAR_FRAME, SAMPLE_FILES, SAMPLE_FRAMES, SAMPLE_SCRIPTS, SAMPLE_TITLE, SAMPLE_VIDEO, createSample, findSample, samplePlan } = await import(
  '../../lib/sample.ts'
);

type Rect = { x: number; y: number; w: number; h: number };
const { width: W, height: H } = SAMPLE_VIDEO;

/** Frame `n` of a file as ffmpeg decodes it (select=eq(n,N), the app's frame grab), in grey. */
const frame = (file: string, n: number): Buffer =>
  execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${n}),format=gray`, '-frames:v', '1', '-f', 'rawvideo', '-'], {
    maxBuffer: W * H * 2,
  });
const inside = (r: Rect, x: number, y: number, pad = 0) => x >= r.x - pad && x < r.x + r.w + pad && y >= r.y - pad && y < r.y + r.h + pad;
/** The mean difference of two grey frames over the pixels `where` picks. */
function meanDiff(a: Buffer, b: Buffer, where: (x: number, y: number) => boolean): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (where(x, y)) {
        sum += Math.abs((a[y * W + x] as number) - (b[y * W + x] as number));
        n++;
      }
  return sum / n;
}

test('the two committed versions: the same size, rate, frames and length, with sound, and small', async () => {
  const [a, b] = await Promise.all([probe(SAMPLE_FILES[1]), probe(SAMPLE_FILES[2])]);
  for (const p of [a, b]) {
    assert.equal(p.width, W);
    assert.equal(p.height, H);
    assert.equal(p.fps, SAMPLE_VIDEO.fps);
    assert.equal(p.frames, SAMPLE_FRAMES);
    assert.ok(p.audio, 'a sound for the waveform lane');
  }
  assert.equal(a.duration, b.duration, 'the same length');
  for (const f of Object.values(SAMPLE_FILES)) assert.ok(fs.statSync(f).size < 400_000, `${f} stays small`);
});

test('frame for frame the same picture: V1 and V2 differ only where the title sits', () => {
  const titles = (x: number, y: number) => inside(SAMPLE_TITLE[1].touched, x, y, 4) || inside(SAMPLE_TITLE[2].touched, x, y, 4);
  for (const n of [0, 12, SAMPLE_CAR_FRAME, 96, SAMPLE_FRAMES - 1]) {
    const [a, b] = [frame(SAMPLE_FILES[1], n), frame(SAMPLE_FILES[2], n)];
    assert.equal(a.length, W * H, `V1 has frame ${n}`);
    assert.equal(b.length, W * H, `V2 has frame ${n}`);
    // the encoder rounds each file its own way: well under one grey level on average is the same picture
    const rest = meanDiff(a, b, (x, y) => !titles(x, y));
    assert.ok(rest < 1, `frame ${n}: outside the titles the versions match (mean difference ${rest.toFixed(2)})`);
    for (const v of [1, 2] as const) {
      const d = meanDiff(a, b, (x, y) => inside(SAMPLE_TITLE[v].letters, x, y));
      assert.ok(d > 20, `frame ${n}: V${v}'s title is only in V${v} (mean difference ${d.toFixed(1)})`);
    }
    // and the title is white letters: brighter in the version that has it
    const bright = (f: Buffer, r: Rect) => meanDiff(f, Buffer.alloc(W * H), (x, y) => inside(r, x, y));
    assert.ok(bright(a, SAMPLE_TITLE[1].letters) > bright(b, SAMPLE_TITLE[1].letters), 'V1: the title over the car');
    assert.ok(bright(b, SAMPLE_TITLE[2].letters) > bright(a, SAMPLE_TITLE[2].letters), 'V2: the title on the hill');
  }
});

test('the titles: over the car in V1, on the hill (lower right) in V2', () => {
  const [t1, t2] = [SAMPLE_TITLE[1].letters, SAMPLE_TITLE[2].letters];
  assert.ok(Math.abs(t1.x - W * 0.17) < 8 && Math.abs(t1.y - H * 0.6) < 12, 'V1 at 17 % / 60 %');
  assert.ok(t1.w > W * 0.4 && t1.h < H * 0.1, 'one line');
  assert.ok(Math.abs(t2.x + t2.w - W * 0.94) < 8, 'V2 ends 6 % from the right edge');
  assert.ok(t2.y > H * 0.7 && t2.h > t1.h * 1.8, 'V2 low, on two lines');
});

test('the sample’s words: the same story in English and German, answers to pick on the question', () => {
  for (const lang of ['en', 'de'] as const) {
    const s = SAMPLE_SCRIPTS[lang];
    assert.match(s.name, /\.mp4$/);
    assert.ok(s.agent.startsWith('agent:'), 'the agent writes as an agent');
    assert.ok(!s.reviewer.startsWith('agent:') && !s.reviewer.startsWith('guest:'));
    assert.equal(s.question.choices.length, 2, 'lib/choices.ts takes 2–4');
    for (const text of [s.title.text, s.title.fix, s.idea.text, s.idea.reply, s.question.text]) assert.ok(text.length > 20 && !text.includes('\n'), text);
  }
  assert.equal(SAMPLE_SCRIPTS.en.title.text, 'The title covers the car. Move it off the road, onto the hill.');
  assert.deepEqual(SAMPLE_SCRIPTS.en.question.choices, ['Fade it out', 'Hold it']);
  assert.notEqual(SAMPLE_SCRIPTS.de.name, SAMPLE_SCRIPTS.en.name);
  assert.equal(SAMPLE_SCRIPTS.de.folder, 'Beispiel');
});

test('the notes sit inside the film: the idea on the opening, the must where the car meets the title, the question late', () => {
  const plan = samplePlan('en');
  assert.deepEqual([plan.idea.frame, plan.title.frame, plan.question.frame], [12, SAMPLE_CAR_FRAME, 96]);
  for (const f of [plan.idea.frame, plan.title.frame, plan.question.frame]) assert.ok(f > 0 && f < SAMPLE_FRAMES);
  const [box] = plan.title.drawing;
  assert.equal(box?.type, 'box');
  if (box?.type === 'box') {
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.w <= W && box.y + box.h <= H, 'inside the picture');
    const t = SAMPLE_TITLE[1].letters;
    assert.ok(box.x <= t.x && box.y <= t.y && box.x + box.w >= t.x + t.w && box.y + box.h >= t.y + t.h, 'around the V1 title');
    // the car at frame 35 drives just under the title's middle (about 48 % across, 69 % down)
    assert.ok(inside(box, W * 0.48, H * 0.69), 'and the car under it');
  }
  assert.equal(plan.title.severity, 'must', 'the note whose fix waits to be checked');
  assert.equal(plan.idea.severity, 'idea', 'an idea never holds the video back');
});

test('made from the committed versions: V1 and V2, the three notes, the fix waiting for a check, nothing logged', async () => {
  const before = Object.values(SAMPLE_FILES).map((f) => fs.statSync(f).size);
  const events = store.readEvents({ limit: 100 }).length;
  const review = await createSample({ by: 'Sam', byId: 'u_000000000001', lang: 'en' });
  assert.equal(review.video.split('/').pop(), 'Lampo sample.mp4');
  assert.equal(review.folder, 'Sample');
  assert.deepEqual(
    review.versions.map((v) => [v.v, v.frames, v.fps, v.width, v.height]),
    [
      [1, SAMPLE_FRAMES, 24, W, H],
      [2, SAMPLE_FRAMES, 24, W, H],
    ],
  );
  assert.equal(review.onboarding_sample?.by, 'Sam');
  assert.equal(review.versions[1]?.by, 'agent:Sample agent', 'V2 is the agent’s');
  const must = review.comments.find((c) => c.severity === 'must');
  assert.ok(must);
  assert.deepEqual([must.v, must.frame, must.author, must.status, must.fixed_in_v], [1, SAMPLE_CAR_FRAME, 'Alex', 'fixed', 2]);
  assert.match(must.replies?.at(-1)?.text ?? '', /lower right, on the hill/);
  assert.ok(must.shots?.clean, 'with its frame');
  const idea = review.comments.find((c) => c.severity === 'idea');
  assert.ok(idea);
  assert.deepEqual([idea.v, idea.frame, idea.author], [1, 12, 'Alex']);
  const q = review.comments.find((c) => c.kind === 'question');
  assert.ok(q);
  assert.deepEqual([q.v, q.frame, q.author], [2, 96, 'agent:Sample agent']);
  assert.deepEqual(q.choices, ['Fade it out', 'Hold it']);
  assert.equal(store.readEvents({ limit: 100 }).length, events, 'the sample logs no events');
  assert.deepEqual(
    Object.values(SAMPLE_FILES).map((f) => fs.statSync(f).size),
    before,
    'the committed versions are copied, never moved',
  );
  assert.equal(findSample()?.video, review.video);
  assert.equal((await createSample({ by: 'Mia' })).video, review.video, 'one sample per store');
  store.removeSample(slugify(review.video));
  assert.equal(findSample(), undefined);
  for (const f of Object.values(SAMPLE_FILES)) assert.ok(fs.existsSync(f), 'removing the sample leaves the committed files alone');
});
