// Footage search reads a request in plain words into filters + what the picture shows (lib/footage/query.ts, as
// measured in bench/footage), and answers an agent in compact lines (lib/footage/lines.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactList, shotLine } from '../../lib/footage/lines.ts';
import { parseRequest, readFilters, readRequest } from '../../lib/footage/query.ts';
import { cleanOcr, wordMatch } from '../../lib/footage/text.ts';
import type { FootageAnswer, FootageShot } from '../../lib/footage/types.ts';

test('a request names its filters and what the picture shows', () => {
  assert.deepEqual(parseRequest('product close-up on white, slow push-in, ≥ 2 s, 9:16, no text'), {
    show: 'product close-up on white',
    aspect: '9:16',
    min_s: 2,
    no_text: true,
    motion: ['push-in'],
    speed: 'slow',
  });
  assert.deepEqual(parseRequest('a dog on a beach, under 4 s, handheld'), { show: 'dog on a beach', max_s: 4, motion: ['handheld'] });
  // German: hochkant, Ranfahrt, mindestens … Sekunden
  assert.deepEqual(parseRequest('Hochkant, langsame Ranfahrt auf eine Pizza, mindestens 3 Sekunden'), {
    show: 'auf eine Pizza',
    aspect: '9:16',
    min_s: 3,
    motion: ['push-in'],
    speed: 'slow',
  });
});

test('a pan is a camera move only where it can’t be a frying pan', () => {
  assert.equal(parseRequest('frying pan with eggs on a stove').motion, undefined);
  assert.deepEqual(parseRequest('aerial pan across a city skyline at night').motion, ['pan-left', 'pan-right']);
});

test('words on screen and words said: quoted, after a cue, or in capitals', () => {
  const said = parseRequest('the shot where the voice-over says "battery lasts all week"');
  assert.equal(said.words, 'battery lasts all week');
  assert.equal(said.words_in, 'said');
  const sign = parseRequest('the STREET CLOSED sign');
  assert.equal(sign.words, 'STREET CLOSED');
  assert.equal(sign.words_in, 'text');
  assert.match(sign.show, /STREET CLOSED/, 'words in the picture stay in the description too');
  const name = parseRequest('lower third with the name Anna Berg');
  assert.equal(name.words, 'Anna Berg');
  assert.equal(name.words_in, 'text');
});

test('filters given on their own win over the words', () => {
  const r = readRequest({ query: 'a dog, 9:16', aspect: '16:9', motion: 'pan', text: 'none', min_s: 1 });
  assert.equal(r.aspect, '16:9');
  assert.deepEqual(r.motion, ['pan-left', 'pan-right']);
  assert.equal(r.no_text, true);
  assert.equal(r.min_s, 1);
  assert.equal(r.show, 'dog');
  const words = readRequest({ query: 'a shop window, no text', text: 'SALE' });
  assert.equal(words.no_text, undefined, 'words on screen are not "no text"');
  assert.equal(words.words, 'SALE');
  assert.deepEqual(readRequest({ query: 'kitchen', said: 'fresh basil' }), { show: 'kitchen', words: 'fresh basil', words_in: 'said' });
  assert.deepEqual(readFilters(parseRequest('product close-up on white, slow push-in, ≥ 2 s, 9:16, no text')), ['9:16', 'slow push-in', '≥2s', 'no text']);
});

test('on-screen text keeps confident lines with real words; words match with one OCR slip', () => {
  assert.deepEqual(
    cleanOcr(
      [
        { text: 'FREE SHIPPING', conf: 0.9 },
        { text: 'ee BLE', conf: 0.9 },
        { text: 'Anna Berg', conf: 0.3 },
      ],
      0.5,
    ),
    ['FREE SHIPPING'],
  );
  assert.equal(wordMatch('free shipping', 'FREE SHIPPlNG · 30 %'), 1, 'one edit in a word of 5+ letters');
  assert.equal(wordMatch('street closed', 'STREET OPEN'), 0.5);
  assert.equal(wordMatch('the', 'the'), 0, 'stop words alone match nothing');
});

const shot = (over: Partial<FootageShot>): FootageShot => ({
  id: 's7',
  video: 'v',
  name: 'take_031.mp4',
  folder: 'Footage/Acme',
  v: 1,
  fps: 25,
  in: 503,
  out: 577,
  t0: 20.12,
  t1: 23.12,
  length_s: 3,
  width: 1080,
  height: 1920,
  aspect: '9:16',
  move: 'push-in',
  speed: 'fast',
  frame: 540,
  text: '',
  said: '',
  score: 3.31,
  ...over,
});

test('the compact list: a head naming what was read, one line per shot, how far the index is', () => {
  assert.equal(shotLine(shot({})), 's7 Footage/Acme/take_031.mp4 00:20:03–00:23:02 3.0s 9:16 push-in fast · 3.3');
  // what a person named or a picture said can't start a line of its own
  assert.equal(shotLine(shot({ name: 'a\nb.mp4', folder: null, text: 'SALE\n-30%', matched: ['text'] })).split('\n').length, 1);
  const a: FootageAnswer = {
    footage_version: 1,
    query: 'q',
    read: parseRequest('product close-up on white, slow push-in, ≥ 2 s, 9:16, no text'),
    shots: [shot({}), shot({ id: 's9', v: 2, move: 'static', speed: null, score: 1.04 })],
    searched: 341,
    index: { on: true, videos: 4, indexed: 3, waiting: 1, failed: 0 },
  };
  assert.deepEqual(compactList(a).split('\n'), [
    '2 of 341 shots · "product close-up on white" · 9:16 · slow push-in · ≥2s · no text',
    's7 Footage/Acme/take_031.mp4 00:20:03–00:23:02 3.0s 9:16 push-in fast · 3.3',
    's9 Footage/Acme/take_031.mp4 V2 00:20:03–00:23:02 3.0s 9:16 static · 1.0',
    '(indexed 3 of 4 videos, 1 still being indexed)',
  ]);
  assert.match(
    compactList({ ...a, shots: [], index: { on: false, note: 'footage search is off here', videos: 0, indexed: 0, waiting: 0, failed: 0 } }),
    /\(footage search is off here\)$/,
  );
});
