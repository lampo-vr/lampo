// What Auto-check's findings mean (lib/findings.ts): whether a hold looks intended or like a problem and how it is
// listed, where a finding is, and dismissals that hold for the same stretch in a later version.
import assert from 'node:assert/strict';
import test from 'node:test';
import { dismissedBy, FREEZE, holdListing, holdVerdict, isStretchKey, listFrames, sameStretch, stallMark, stretchOf, undismissed } from '../../lib/findings.ts';

const at25 = { frames: 200, fps: 25, sound: 1, fromCut: false };

test('a hold on the first or last frames opens or closes the video: intended, not listed', () => {
  for (const r of [
    { in: 0, out: 30 },
    { in: 1, out: 12 },
  ]) {
    const v = holdVerdict(r, at25);
    assert.deepEqual(v, { likely: 'intended', why: 'opening' });
    assert.equal(holdListing(r, v, 25), 'none');
  }
  const end = { in: 170, out: 199 };
  assert.deepEqual(holdVerdict(end, at25), { likely: 'intended', why: 'end-card' });
  assert.equal(holdListing(end, holdVerdict(end, at25), 25), 'none');
  // two frames before the end still closes it
  assert.equal(holdVerdict({ in: 150, out: 198 }, at25).why, 'end-card');
});

test('a scan from before the motion was measured: a few repeated frames read as a hitch, whatever the sound', () => {
  const r = { in: 75, out: 78 };
  for (const sound of [1, 0, null]) {
    const v = holdVerdict(r, { ...at25, sound });
    assert.deepEqual(v, { likely: 'problem', why: 'repeated' });
    assert.equal(holdListing(r, v, 25), 'short');
  }
  // the same 6 frames are a hold at 25 fps and repeated frames at 60 (a hold starts at 0.2 s there: 12 frames)
  assert.equal(listFrames(25), 6);
  assert.equal(listFrames(60), 12);
  assert.notEqual(holdVerdict({ in: 40, out: 45 }, at25).why, 'repeated');
  assert.equal(holdVerdict({ in: 40, out: 45 }, { ...at25, fps: 60 }).why, 'repeated');
});

test('a scan from before the motion was measured: the sound decides — going on, a problem; paused, a beat', () => {
  const r = { in: 40, out: 55 };
  assert.deepEqual(holdVerdict(r, at25), { likely: 'problem', why: 'sound-continues' });
  assert.deepEqual(holdVerdict(r, { ...at25, sound: FREEZE.soundShare }), { likely: 'problem', why: 'sound-continues' });
  assert.deepEqual(holdVerdict(r, { ...at25, sound: 0.1 }), { likely: 'intended', why: 'pause' });
  // no sound to go by: a moving shot that stops
  assert.deepEqual(holdVerdict(r, { ...at25, sound: null }), { likely: 'problem', why: 'mid-shot' });
  // still from the cut on: a held shot, sound or not
  assert.deepEqual(holdVerdict(r, { ...at25, fromCut: true }), { likely: 'intended', why: 'held-shot' });
});

// How the picture moves at a hold's edges (lib/media.ts measures it): steps in multiples of the still limit
const moving = { before: 16, steady: 15, lead: 16, inside: 0, jump: 16, after: 16 };
const stall = { ...moving, jump: 95 }; // copies in the middle of motion, then the frames it skipped at once
const stuck = { ...moving, jump: 15 }; // the motion stops dead and goes on where it was (time paused)
const eased = { before: 12, steady: 0, lead: 1.6, inside: 0, jump: 1.6, after: 24 }; // slows into it, picks up again
const crawl = { before: 9.5, steady: 3.2, lead: 3.2, inside: 0, jump: 3.2, after: 28 }; // whole-pixel steps, slowing down
const drift = { ...moving, inside: 0.7 }; // frames that still differ: a slow drift or grain, no copies
const popIn = { before: 0, steady: 0, lead: 30, inside: 0, jump: 40, after: 2 }; // nothing moved before it

test('a stall: copies of one frame in the middle of motion that stops dead or jumps on after it', () => {
  assert.equal(stallMark(stall), 'jump');
  assert.equal(stallMark(stuck), 'stop');
  for (const m of [eased, crawl, drift, popIn]) assert.equal(stallMark(m), null, JSON.stringify(m));
  // an ease placed on whole pixels creeps in single steps with still frames between: not "moving on every frame"
  assert.equal(stallMark({ ...crawl, steady: 0, before: 3.2 }), null);
  // a jump only counts against the motion around it
  assert.equal(stallMark({ ...stall, after: 60 }), 'stop');
  assert.equal(stallMark({ ...stall, after: 60, steady: 0 }), null);
});

test('without a stall’s marks a hold is intended, whatever the sound does: a music bed goes on through every pause', () => {
  const r = { in: 40, out: 55 };
  for (const sound of [1, null])
    for (const m of [eased, crawl, drift])
      assert.deepEqual(holdVerdict(r, { ...at25, sound, motion: m }), { likely: 'intended', why: 'eased' }, JSON.stringify(m));
  assert.deepEqual(holdVerdict(r, { ...at25, motion: popIn }), { likely: 'intended', why: 'still-before' });
  // the verdicts that were right stay: a held shot from a cut, a pause with the sound, an opening, an end card
  assert.deepEqual(holdVerdict(r, { ...at25, fromCut: true, motion: popIn }), { likely: 'intended', why: 'held-shot' });
  assert.deepEqual(holdVerdict(r, { ...at25, sound: 0.1, motion: eased }), { likely: 'intended', why: 'pause' });
  assert.equal(holdVerdict({ in: 0, out: 30 }, { ...at25, motion: stall }).why, 'opening');
  assert.equal(holdVerdict({ in: 170, out: 199 }, { ...at25, motion: stall }).why, 'end-card');
  // a stall: the sound decides as before
  assert.deepEqual(holdVerdict(r, { ...at25, motion: stall }), { likely: 'problem', why: 'sound-continues' });
  assert.deepEqual(holdVerdict(r, { ...at25, motion: stuck, sound: null }), { likely: 'problem', why: 'mid-shot' });
  assert.deepEqual(holdVerdict(r, { ...at25, motion: stall, sound: 0 }), { likely: 'intended', why: 'pause' });
  assert.deepEqual(holdVerdict(r, { ...at25, motion: stall, fromCut: true }), { likely: 'intended', why: 'held-shot' });
});

test('a few frames: a hitch only with a stall’s marks; motion coming to rest that briefly isn’t listed', () => {
  const r = { in: 75, out: 78 };
  assert.deepEqual(holdVerdict(r, { ...at25, motion: stall }), { likely: 'problem', why: 'repeated' });
  const v = holdVerdict(r, { ...at25, motion: eased });
  assert.deepEqual(v, { likely: 'intended', why: 'eased' });
  assert.equal(holdListing(r, v, 25), 'none');
  assert.equal(holdListing(r, holdVerdict(r, { ...at25, motion: popIn }), 25), 'none');
  // long enough for a pause of its own: listed, as minor (lib/qa.ts)
  assert.equal(holdListing({ in: 40, out: 55 }, holdVerdict({ in: 40, out: 55 }, { ...at25, motion: eased }), 25), 'one');
});

test('long holds: a stall is listed however long it lasts, a still shot that looks intended is not', () => {
  const long = { in: 40, out: 120 }; // 3.2 s
  assert.equal(holdListing(long, holdVerdict(long, at25), 25), 'one');
  assert.equal(holdListing(long, holdVerdict(long, { ...at25, fromCut: true }), 25), 'none');
  assert.equal(holdListing(long, holdVerdict(long, { ...at25, sound: 0 }), 25), 'none');
  const short = { in: 40, out: 60 }; // 0.84 s: an intended pause is still listed (as minor in lib/qa.ts)
  assert.equal(holdListing(short, holdVerdict(short, { ...at25, sound: 0 }), 25), 'one');
});

test('where a finding is: its range, a summary’s first hold, its frame; nothing for the whole video', () => {
  assert.deepEqual(stretchOf({ key: 'freeze:40', kind: 'freeze', frame: 40, range: { in: 40, out: 55 } }), { in: 40, out: 55 });
  assert.deepEqual(
    stretchOf({
      key: 'freeze:short',
      kind: 'freeze',
      frame: 75,
      holds: [
        { in: 75, out: 78 },
        { in: 90, out: 92 },
      ],
    }),
    { in: 75, out: 78 },
  );
  assert.deepEqual(stretchOf({ key: 'flash:12', kind: 'flash-frame', frame: 12 }), { in: 12, out: 12 });
  assert.equal(stretchOf({ key: 'loudness:lufs', kind: 'loudness', frame: 0 }), null);
  assert.ok(isStretchKey('freeze:40') && isStretchKey('black:7'));
  assert.ok(!isStretchKey('freeze:short') && !isStretchKey('typo:1a2b3c4d') && !isStretchKey('loudness:peak'));
});

test('the same stretch: both ends within a quarter second (or a tenth of a long one)', () => {
  assert.ok(sameStretch({ in: 40, out: 55 }, { in: 42, out: 57 }, 25));
  assert.ok(sameStretch({ in: 40, out: 55 }, { in: 46, out: 61 }, 25));
  assert.ok(!sameStretch({ in: 40, out: 55 }, { in: 47, out: 62 }, 25));
  assert.ok(!sameStretch({ in: 40, out: 55 }, { in: 40, out: 90 }, 25), 'a hold that grew is another one');
  // a long hold may move by a tenth of its length
  assert.ok(sameStretch({ in: 100, out: 400 }, { in: 125, out: 420 }, 25));
});

test('"That’s intended" holds for the same stretch in a later version, for that kind only', () => {
  const dismissed = { qa_dismissed: ['freeze:40'], qa_stretches: { 'freeze:40': { in: 40, out: 55 } } };
  const moved = { key: 'freeze:42', kind: 'freeze', frame: 42, range: { in: 42, out: 57 } };
  assert.ok(dismissedBy({ key: 'freeze:40', kind: 'freeze', frame: 40, range: { in: 40, out: 55 } }, dismissed, 25), 'its own key');
  assert.ok(dismissedBy(moved, dismissed, 25), 'two frames later in the next version');
  assert.ok(!dismissedBy({ key: 'freeze:90', kind: 'freeze', frame: 90, range: { in: 90, out: 110 } }, dismissed, 25), 'another hold');
  assert.ok(!dismissedBy({ key: 'flash:42', kind: 'flash-frame', frame: 42 }, dismissed, 25), 'another kind on the same frames');
  assert.ok(!dismissedBy({ key: 'freeze:short', kind: 'freeze', frame: 40, holds: [{ in: 40, out: 43 }] }, dismissed, 25), 'a summary goes by its key');
  assert.ok(dismissedBy({ key: 'freeze:short', kind: 'freeze', frame: 75 }, { qa_dismissed: ['freeze:short'] }, 25));
  // dismissed before stretches were kept: its first frame, within the slack
  const older = { qa_dismissed: ['black:120'] };
  assert.ok(dismissedBy({ key: 'black:123', kind: 'black-frames', frame: 123, range: { in: 123, out: 126 } }, older, 25));
  assert.ok(!dismissedBy({ key: 'black:140', kind: 'black-frames', frame: 140, range: { in: 140, out: 143 } }, older, 25));
  // words and measures stay put: their keys decide
  assert.ok(dismissedBy({ key: 'loudness:lufs', kind: 'loudness', frame: 0 }, { qa_dismissed: ['loudness:lufs'] }, 25));
  assert.ok(!dismissedBy({ key: 'typo:aaaa', kind: 'typo', frame: 40, range: { in: 40, out: 55 } }, dismissed, 25));
  assert.deepEqual(
    undismissed([moved, { key: 'freeze:90', kind: 'freeze', frame: 90, range: { in: 90, out: 110 } }], dismissed, 25).map((x) => x.key),
    ['freeze:90'],
  );
  assert.equal(undismissed([moved], {}, 25).length, 1, 'nothing dismissed');
});
