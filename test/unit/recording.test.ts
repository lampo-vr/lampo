// Recorded feedback → draft notes (lib/recording.ts): which frame a word was said on comes from the event log on the
// audio's clock; pauses, sentence ends and jumps split what was said; short fragments join a neighbour; playing across
// frames makes a range; the pointer's rest or a click makes a spot; shapes go to the nearest utterance, or stand alone.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanText, frameAt, playingAt, ringAt, segmentRecording, spotDuring, utterances } from '../../lib/recording.ts';
import type { RecordingEvent, Shape } from '../../lib/types.ts';

const words = (list: [string, number, number][]) => list.map(([text, t0, t1]) => ({ text, t0, t1 }));
const seq = () => {
  let n = 0;
  return () => `d_${++n}`;
};
const base = { fps: 25, frames: 500, width: 1920, height: 1080 };
const segment = (w: ReturnType<typeof words>, events: RecordingEvent[]) => segmentRecording({ ...base, words: w, events, newId: seq() });

test('paused on F120 while a word is spoken: a note on F120, not on the wall clock', () => {
  const events: RecordingEvent[] = [
    { t: 0, k: 'frame', f: 40 },
    { t: 0.3, k: 'seek', f: 120 },
    { t: 0.3, k: 'frame', f: 120 },
  ];
  const [d] = segment(
    words([
      ['The', 1.0, 1.2],
      ['logo', 1.2, 1.5],
      ['lands', 1.5, 1.8],
      ['too', 1.8, 2.0],
      ['early.', 2.0, 2.4],
    ]),
    events,
  );
  assert.equal(d.frame, 120);
  assert.equal(d.range, null);
  assert.equal(d.text, 'The logo lands too early.');
  assert.equal(d.t0, 1);
  assert.equal(d.t1, 2.4);
});

test('the frame on screen is read at the word, with the first frame before any event', () => {
  const events: RecordingEvent[] = [
    { t: 0.5, k: 'frame', f: 10 },
    { t: 2, k: 'frame', f: 11 },
  ];
  assert.equal(frameAt(events, 0), 10);
  assert.equal(frameAt(events, 1.99), 10);
  assert.equal(frameAt(events, 2), 11);
  assert.equal(frameAt([], 3), 0);
  assert.equal(
    playingAt(
      [
        { t: 1, k: 'play' },
        { t: 3, k: 'pause' },
      ],
      2,
    ),
    true,
  );
  assert.equal(
    playingAt(
      [
        { t: 1, k: 'play' },
        { t: 3, k: 'pause' },
      ],
      3.5,
    ),
    false,
  );
});

test('said while it played across frames: a range from the first frame to the last', () => {
  const events: RecordingEvent[] = [
    { t: 0, k: 'frame', f: 60 },
    { t: 0.9, k: 'play' },
  ];
  for (let i = 0; i <= 60; i++) events.push({ t: 1 + i * 0.04, k: 'frame', f: 60 + i });
  events.push({ t: 3.5, k: 'pause' });
  const [d] = segment(
    words([
      ['This', 1.2, 1.4],
      ['stretch', 1.4, 1.8],
      ['is', 1.8, 1.9],
      ['too', 1.9, 2.1],
      ['dark.', 2.1, 2.6],
    ]),
    events,
  );
  // 1.2 s → frame 65 (the last sample at or before 1.2), 2.6 s → frame 100
  assert.deepEqual(d.range, { in: 65, out: 100 });
  assert.equal(d.frame, 65);
});

test('pauses, sentence ends and jumps split; a fragment joins its neighbour', () => {
  const events: RecordingEvent[] = [
    { t: 0, k: 'frame', f: 0 },
    { t: 6.0, k: 'seek', f: 200 },
  ];
  const w = words([
    ['Okay', 0.2, 0.5],
    ['the', 0.6, 0.7],
    ['title', 0.7, 1.0],
    ['is', 1.0, 1.1],
    ['small.', 1.1, 1.4],
    // a sentence end and a breath: a new note
    ['Also', 1.9, 2.1],
    ['the', 2.1, 2.2],
    ['colour', 2.2, 2.6],
    ['is', 2.6, 2.7],
    ['off', 2.7, 3.0],
    // a long pause: a new note
    ['Make', 4.2, 4.4],
    ['it', 4.4, 4.5],
    ['warmer', 4.5, 5.0],
    ['please', 5.0, 5.9],
    // a jump between two words (no pause): a new note on the frame jumped to
    ['Here', 6.02, 6.3],
    ['the', 6.3, 6.4],
    ['cut', 6.4, 6.6],
    ['jumps.', 6.6, 7.0],
  ]);
  const groups = utterances(w, events);
  assert.deepEqual(
    groups.map((g) => g.map((x) => x.text).join(' ')),
    ['Okay the title is small.', 'Also the colour is off', 'Make it warmer please', 'Here the cut jumps.'],
  );
  const drafts = segment(w, events);
  assert.deepEqual(
    drafts.map((d) => d.frame),
    [0, 0, 0, 200],
  );
  // "yes" alone after a pause joins the note before it
  const joined = utterances(
    words([
      ['The', 0, 0.2],
      ['music', 0.2, 0.6],
      ['is', 0.6, 0.7],
      ['loud.', 0.7, 1.0],
      ['Yes.', 2.2, 2.4],
    ]),
    [],
  );
  assert.equal(joined.length, 1);
  assert.equal(joined[0].length, 5);
});

test('a person asking "can we …?" asks for a change (feedback); fillers come off the edges only', () => {
  const [d] = segment(
    words([
      ['ähm', 0.1, 0.3],
      ['can', 0.4, 0.6],
      ['we', 0.6, 0.7],
      ['see', 0.7, 0.9],
      ['it', 0.9, 1.0],
      ['bigger?', 1.0, 1.4],
    ]),
    [{ t: 0, k: 'frame', f: 5 }],
  );
  assert.equal(d.text, 'Can we see it bigger?');
  assert.equal(d.severity, 'should');
  assert.ok(!('kind' in d));
  assert.equal(cleanText(['uhm', 'the', 'ähm', 'logo', 'um']), 'The ähm logo');
  assert.equal(cleanText(['ähm']), '');
});

test('the pointer resting on the picture while it was said makes a spot, drawn as a ring', () => {
  const events: RecordingEvent[] = [{ t: 0, k: 'frame', f: 30 }];
  // wanders, then rests near (0.3, 0.4) from 1.0 s to 2.2 s
  events.push({ t: 0.5, k: 'pointer', x: 0.8, y: 0.8 }, { t: 0.7, k: 'pointer', x: 0.5, y: 0.6 });
  for (let t = 1.0; t <= 2.2; t += 0.1) events.push({ t: Math.round(t * 10) / 10, k: 'pointer', x: 0.3 + (t > 1.5 ? 0.005 : 0), y: 0.4 });
  const [d] = segment(
    words([
      ['This', 1.1, 1.3],
      ['logo', 1.3, 1.6],
      ['here', 1.6, 1.9],
      ['is', 1.9, 2.0],
      ['blurry.', 2.0, 2.3],
    ]),
    events,
  );
  assert.ok(d.spot, 'a spot');
  assert.ok(Math.abs((d.spot as number[])[0] - 0.3) < 0.01 && Math.abs((d.spot as number[])[1] - 0.4) < 0.01, `${d.spot}`);
  assert.equal(d.drawing.length, 1);
  const ring = d.drawing[0] as Extract<Shape, { type: 'freehand' }>;
  assert.equal(ring.type, 'freehand');
  // centred on the spot in video pixels
  const xs = ring.points.map((p) => p[0]);
  assert.ok(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - (d.spot as number[])[0] * 1920) <= 2);
  // a click wins over a rest; moving without resting is no spot
  const clicked: RecordingEvent[] = [...events, { t: 1.5, k: 'click', x: 0.7, y: 0.2 }];
  assert.deepEqual(
    spotDuring(
      clicked.sort((a, b) => a.t - b.t),
      1.1,
      2.3,
    ),
    [0.7, 0.2],
  );
  assert.equal(
    spotDuring(
      Array.from({ length: 20 }, (_, i): RecordingEvent => ({ t: i * 0.1, k: 'pointer', x: i * 0.05, y: 0.5 })),
      0,
      2,
    ),
    null,
  );
  // a gap in the samples (the pointer left the picture) ends a rest
  assert.equal(
    spotDuring(
      [
        { t: 1, k: 'pointer', x: 0.5, y: 0.5 },
        { t: 1.3, k: 'pointer', x: 0.5, y: 0.5 },
        { t: 2.0, k: 'pointer', x: 0.5, y: 0.5 },
      ],
      1,
      2,
    ),
    null,
  );
  assert.equal(ringAt([0.5, 0.5], 1000, 1000).type, 'freehand');
});

test('shapes go to the utterance nearest in time and set its frame; lone shapes make drafts of their own', () => {
  const box: Shape = { type: 'box', x: 100, y: 100, w: 200, h: 100 };
  const arrow: Shape = { type: 'arrow', x1: 0, y1: 0, x2: 50, y2: 50 };
  const events: RecordingEvent[] = [
    { t: 0, k: 'frame', f: 50 },
    { t: 0.5, k: 'stroke', f: 50, shape: box },
    { t: 3, k: 'seek', f: 300 },
    { t: 8, k: 'stroke', f: 300, shape: arrow },
  ];
  const drafts = segment(
    words([
      ['Too', 1.0, 1.2],
      ['much', 1.2, 1.4],
      ['text', 1.4, 1.7],
      ['here.', 1.7, 2.0],
    ]),
    events,
  );
  assert.equal(drafts.length, 2);
  assert.deepEqual(drafts[0].drawing, [box]);
  assert.equal(drafts[0].frame, 50);
  assert.equal(drafts[0].spot, undefined, 'a drawing, no ring on top');
  assert.equal(drafts[1].text, '');
  assert.equal(drafts[1].frame, 300);
  assert.deepEqual(drafts[1].drawing, [arrow]);
});

test('nothing heard and nothing drawn: no drafts; frames stay inside the version', () => {
  assert.deepEqual(segment([], [{ t: 0, k: 'frame', f: 3 }]), []);
  const [d] = segment(
    words([
      ['Way', 0, 0.3],
      ['past', 0.3, 0.6],
      ['the', 0.6, 0.7],
      ['end.', 0.7, 1],
    ]),
    [{ t: 0, k: 'frame', f: 9999 }],
  );
  assert.equal(d.frame, 499);
});
