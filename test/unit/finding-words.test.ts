// Every Auto-check finding says what, why and what the guess rests on in the viewer's words (player/findingWords.ts),
// from its fields — never the check's English sentence, except for a result from before the fields existed.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { QaItem } from '../../web/src/api/types.ts';
import { findingWords } from '../../web/src/player/findingWords.ts';

const item = (x: Partial<QaItem> & Pick<QaItem, 'key' | 'kind'>): QaItem => ({ severity: 'should', frame: 0, text: 'ENGLISH FROM THE CHECK', ...x });

test('a freeze says how long, the limit at this frame rate, and what the guess rests on', () => {
  const w = findingWords(item({ key: 'freeze:40', kind: 'freeze', frame: 40, range: { in: 40, out: 55 }, likely: 'problem', why: 'sound-continues' }), 25);
  assert.equal(w.what, 'The picture stops for 0.64 s while the sound goes on');
  assert.equal(w.why, 'Nothing moved for 16 frames (0.64 s). Auto-check flags still stretches from 6 frames (0.24 s) inside the video.');
  assert.equal(w.verdict, 'problem');
  // a problem rests on a stall's marks, never on the sound going on alone
  assert.equal(
    w.reason,
    'Looks like a problem: the motion stops dead or jumps ahead after it while the sound carries on, so frames are likely missing or rendering stalled.',
  );
  const pause = findingWords(item({ key: 'freeze:128', kind: 'freeze', frame: 128, range: { in: 128, out: 148 }, likely: 'intended', why: 'pause' }), 25);
  assert.equal(pause.verdict, 'intended');
  assert.match(pause.what, /while the sound pauses/);
  const eased = findingWords(item({ key: 'freeze:17', kind: 'freeze', frame: 17, range: { in: 17, out: 29 }, likely: 'intended', why: 'eased' }), 24);
  assert.equal(eased.what, 'The motion comes to rest for 0.54 s');
  assert.equal(eased.verdict, 'intended');
  assert.match(eased.reason || '', /^Looks intended: the motion slows into it and goes on without a jump/);
  const still = findingWords(item({ key: 'freeze:60', kind: 'freeze', frame: 60, range: { in: 60, out: 75 }, likely: 'intended', why: 'still-before' }), 25);
  assert.equal(still.what, 'The picture stays still for 0.64 s');
  assert.equal(still.verdict, 'intended');
  assert.match(still.reason || '', /^Looks intended: nothing was moving just before it/);
  // 60 fps: the limit is 12 frames
  assert.match(
    findingWords(item({ key: 'freeze:40', kind: 'freeze', frame: 40, range: { in: 40, out: 80 }, why: 'mid-shot' }), 60).why,
    /from 12 frames \(0\.2 s\)/,
  );
  const repeated = findingWords(item({ key: 'freeze:short', kind: 'freeze', frame: 75, holds: [{ in: 75, out: 78 }], why: 'repeated' }), 25);
  assert.equal(repeated.what, 'The same frame shows 4 times in a row');
  assert.equal(repeated.verdict, 'problem');
  const many = findingWords(
    item({ key: 'freeze:holds', kind: 'freeze', frame: 10, holds: Array.from({ length: 7 }, (_, i) => ({ in: 10 + i * 20, out: 17 + i * 20 })) }),
    25,
  );
  assert.equal(many.what, 'The picture holds still 7 times, 0.32 s each');
  assert.equal(many.verdict, 'intended');
});

test('every other kind in its own words', () => {
  const words = [
    item({ key: 'flash:12', kind: 'flash-frame', frame: 12, likely: 'problem' }),
    item({ key: 'black:30', kind: 'black-frames', frame: 30, range: { in: 30, out: 33 }, why: 'black-gap' }),
    item({ key: 'black:90', kind: 'black-frames', frame: 90, range: { in: 90, out: 115 }, why: 'black-dip', severity: 'nice' }),
    item({ key: 'loudness:lufs', kind: 'loudness', value: -20.3, severity: 'nice' }),
    item({ key: 'loudness:peak', kind: 'loudness', frame: 50, value: -0.2 }),
    item({ key: 'clip:50', kind: 'clipping', frame: 50, range: { in: 50, out: 60 } }),
    item({ key: 'silence:125', kind: 'silence', frame: 125, range: { in: 125, out: 154 }, severity: 'nice' }),
    item({ key: 'typo:1', kind: 'typo', frame: 40, word: 'Hintergrnud', guess: 'Hintergrund', line: 'Der Hintergrnud ist zu hell' }),
    item({ key: 'zone:ig-caption:1', kind: 'safe-zone', frame: 40, zone: 'ig-caption', line: 'Link in bio' }),
  ].map((x) => findingWords(x, 25, 'German'));
  for (const w of words) {
    assert.ok(!w.what.includes('ENGLISH FROM THE CHECK'), `its own words: ${w.what}`);
    assert.ok(w.why.length > 20, `why: ${w.why}`);
  }
  const [flash, gap, dip, lufs, peak, clip, silence, typo, zone] = words;
  assert.equal(flash.verdict, 'problem');
  assert.equal(gap.what, '4 black frames between two shots');
  assert.equal(gap.verdict, 'problem');
  assert.equal(dip.verdict, 'intended');
  assert.equal(lufs.what, 'The whole video is quiet: −20.3 LUFS');
  assert.equal(lufs.verdict, null);
  assert.equal(peak.what, 'The loudest peak reaches −0.2 dBTP');
  assert.equal(clip.what, 'The sound hits full scale for 11 frames');
  assert.equal(silence.verdict, null);
  assert.match(silence.reason || '', /^Can’t tell/);
  assert.equal(typo.what, '“Hintergrnud” may be misspelled: “Hintergrund”?');
  assert.match(typo.why, /No German dictionary/);
  assert.equal(typo.quote, 'Der Hintergrnud ist zu hell');
  assert.equal(zone.what, 'Text sits under Instagram’s caption');
});

test('a finding from before these fields: the check’s own sentence, no guess', () => {
  const w = findingWords(item({ key: 'typo:2', kind: 'typo', frame: 4, text: 'Possible typo "Skincrae" → "Skincare"?', detail: 'In "Skincrae Routine"' }), 25);
  assert.equal(w.what, 'Possible typo "Skincrae" → "Skincare"?');
  assert.equal(w.verdict, null);
  const old = findingWords(item({ key: 'freeze:40', kind: 'freeze', frame: 40, range: { in: 40, out: 55 } }), 25);
  assert.equal(old.what, 'The picture stands still for 0.64 s');
  assert.equal(old.verdict, null);
});
