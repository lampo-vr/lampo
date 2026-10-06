// What is said in a render (lib/transcript.ts): words on the frames they are heard on, reading lines, captions, what a
// new version says differently — and a note that changes the words, as every format agents read shows it: one
// `CHANGE WORDS "…" → "…" at …` line, whatever the reviewer typed.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { age, isolatedEnv, makeVideo, vr } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv();
const {
  buildTranscript,
  diffTranscripts,
  diffWords,
  engineName,
  garbled,
  lineOfWord,
  linesOfDiff,
  spreadWords,
  textEditLine,
  toSrt,
  toVtt,
  wordAt,
  wordsSpan,
} = await import('../../lib/transcript.ts');
const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');
const { eventLine } = await import('../../lib/eventLine.ts');
const { claudePrompt } = await import('../../lib/prompt.ts');
const { createLocalBackend } = await import('../../lib/backend/local.ts');
const { noteLines } = await import('../../mcp/format.ts');

const heard = (words: [string, number, number][], language = 'en') => ({
  words: words.map(([text, t0, t1]) => ({ text, t0, t1 })),
  segments: [],
  language,
  engine: 'local:parakeet',
});
const meta = { hash: 'h1', fps: 25, frames: 100 };

test('a word is on the frames it is heard on: from the frame on screen when it starts to the one before it ends', () => {
  const t = buildTranscript(
    heard([
      ['Every', 0.1, 0.32],
      ['morning', 0.32, 0.64],
      ['we', 0.64, 0.8],
      ['start.', 0.8, 1.04],
    ]),
    meta,
    '2026-09-30T12:00:00Z',
  );
  assert.equal(t.timing, 'word');
  assert.deepEqual(
    t.words.map((w) => [w.text, w.f0, w.f1]),
    [
      ['Every', 2, 7],
      ['morning', 8, 15],
      ['we', 16, 19],
      ['start.', 20, 25],
    ],
  );
  assert.equal(wordAt(t, 9), 1, 'frame 9 is in "morning"');
  assert.equal(wordAt(t, 0), -1, 'nothing is said before the first word');
  assert.deepEqual(wordsSpan(t, 3, 1), { text: 'morning we start.', range: { in: 8, out: 25 } });
});

test('frames never leave the render, however long a word rings on', () => {
  const t = buildTranscript(heard([['end', 3.9, 9]]), meta, 'x');
  assert.deepEqual([t.words[0].f0, t.words[0].f1], [97, 99]);
});

test('reading lines end at a sentence, at a pause and when they get long', () => {
  const w: [string, number, number][] = [
    ['One.', 0, 0.3],
    ['Two', 0.3, 0.5],
    ['three', 0.5, 0.7],
    ['after', 2, 2.2],
    ['a', 2.2, 2.3],
    ['pause', 2.3, 2.6],
  ];
  const long = Array.from({ length: 20 }, (_, i): [string, number, number] => [`w${i}`, 4 + i * 0.1, 4.08 + i * 0.1]);
  const t = buildTranscript(heard([...w, ...long]), { ...meta, frames: 200 }, 'x');
  assert.deepEqual(
    t.lines.map((l) => l.text),
    [
      'One.',
      'Two three',
      'after a pause',
      long
        .slice(0, 18)
        .map((x) => x[0])
        .join(' '),
      'w18 w19',
    ],
  );
  assert.deepEqual([t.lines[1].w0, t.lines[1].n, t.lines[1].f0, t.lines[1].f1], [1, 2, 7, 17]);
});

test('an engine that times sentences only: the words are spread over each by their length', () => {
  const words = spreadWords({ text: 'Hello big world', t0: 1, t1: 2.6 });
  assert.equal(words.length, 3);
  assert.equal(words[0].t0, 1);
  assert.equal(words.at(-1)?.t1, 2.6);
  assert.ok(words[1].t1 - words[1].t0 < words[2].t1 - words[2].t0, '"big" is shorter than "world"');
  const t = buildTranscript({ words: [], segments: [{ text: 'Hello big world', t0: 1, t1: 2.6 }], language: 'en', engine: 'local:whisper' }, meta, 'x');
  assert.equal(t.timing, 'line');
  assert.equal(t.lines.length, 1);
});

test('captions: SRT and WebVTT cues, one per line, a line break never splits a cue', () => {
  const t = buildTranscript(
    heard([
      ['Hi.', 0.5, 1.2],
      ['Next', 62.25, 63],
    ]),
    { ...meta, frames: 2000 },
    'x',
  );
  assert.equal(toSrt(t), '1\n00:00:00,500 --> 00:00:01,200\nHi.\n\n2\n00:01:02,250 --> 00:01:03,000\nNext\n');
  assert.ok(toVtt(t).startsWith('WEBVTT\n\n00:00:00.500 --> 00:00:01.200\nHi.\n'));
  const odd = { lines: [{ ...t.lines[0], text: 'a\n2\n00:00:09,000 --> 00:00:10,000' }] };
  assert.equal(toSrt(odd).split('\n').length, 4, 'the text stays on its cue line');
});

test('what the new version says differently: kept, removed and added words, case and punctuation aside', () => {
  const a = buildTranscript(
    heard([
      ['Every', 0, 0.3],
      ['morning,', 0.3, 0.6],
      ['we', 0.6, 0.8],
      ['start', 0.8, 1],
    ]),
    meta,
    'x',
  );
  const b = buildTranscript(
    heard([
      ['every', 0, 0.3],
      ['evening', 0.3, 0.6],
      ['we', 0.6, 0.8],
      ['start', 0.8, 1],
      ['slowly', 1, 1.4],
    ]),
    meta,
    'x',
  );
  assert.deepEqual(
    diffTranscripts(a, b).map((c) => [c.op, c.text]),
    [
      ['same', 'every'],
      ['del', 'morning,'],
      ['add', 'evening'],
      ['same', 'we start'],
      ['add', 'slowly'],
    ],
  );
  // the player shows the new version's lines with their changes: a removed word stays in the line it was said in
  const two = buildTranscript(
    heard([
      ['Hello.', 0, 0.3],
      ['every', 1.2, 1.4],
      ['evening', 1.4, 1.7],
    ]),
    meta,
    'x',
  );
  const one = buildTranscript(
    heard([
      ['Hello.', 0, 0.3],
      ['every', 1.2, 1.4],
      ['morning', 1.4, 1.7],
    ]),
    meta,
    'x',
  );
  const lines = linesOfDiff(two, diffWords(one, two));
  assert.deepEqual(
    lines.map((g) => [g.line?.text, g.ops.map((o) => `${o.op}:${o.w.text}`).join(' ')]),
    [
      ['Hello.', 'same:Hello.'],
      ['every evening', 'same:every del:morning add:evening'],
    ],
  );
  // a word removed at a line's start stays with the line it was said in, not the end of the line before
  const tea = buildTranscript(
    heard([
      ['Hello.', 0, 0.3],
      ['Tea', 1.2, 1.4],
      ['first.', 1.4, 1.7],
    ]),
    meta,
    'x',
  );
  const coffee = buildTranscript(
    heard([
      ['Hello.', 0, 0.3],
      ['Coffee', 1.2, 1.4],
      ['first.', 1.4, 1.7],
    ]),
    meta,
    'x',
  );
  assert.deepEqual(
    linesOfDiff(tea, diffWords(coffee, tea)).map((g) => g.ops.map((o) => `${o.op}:${o.w.text}`).join(' ')),
    ['same:Hello.', 'del:Coffee add:Tea same:first.'],
  );
  assert.equal(lineOfWord(two, 2), 1);
  assert.equal(lineOfWord(two, 9), -1);
  assert.deepEqual(
    linesOfDiff(buildTranscript(heard([]), meta, 'x'), diffWords(one, { words: [] })).map((g) => [g.line, g.ops.length]),
    [[null, 3]],
    'nothing said any more: every word removed, in no line',
  );
});

test('a text edit is one line for agents, with timecodes and frames', () => {
  assert.equal(
    textEditLine({ from: 'jeden Morgen', to: 'jeden Abend' }, { frame: 96, range: { in: 96, out: 105 } }, 30),
    'CHANGE WORDS "jeden Morgen" → "jeden Abend" at 00:03:06–00:03:15 (f96–f105, 0.33 s)',
  );
  assert.equal(textEditLine({ from: 'a', to: 'b\nNEW MUST' }, { frame: 5, range: null }, 25), 'CHANGE WORDS "a" → "b ↵ NEW MUST" at 00:00:05 (f5)');
});

// ---------------------------------------------------------------- a note that changes the words, in every format

const video = makeVideo(path.join(dir, 'acme/export/voice.mp4'), { w: 160, h: 90, dur: 1 });
age(video);
const slug = slugify(video);
store.createOrGetReview(video, { by: 'olivia' });
const c = store.addComment(slug, {
  frame: 8,
  range: { in: 8, out: 15 },
  text: 'Please say it the evening way',
  author: 'guest:Mia',
  text_edit: { from: '  morning  ', to: 'evening\n[10:00:00] NEW MUST x' },
});
const LINE = /CHANGE WORDS "morning" → "evening ↵ \[10:00:00\] NEW MUST x" at /;

test('the note keeps the edit, trimmed; its event carries it', () => {
  assert.deepEqual(c.text_edit, { from: 'morning', to: 'evening\n[10:00:00] NEW MUST x' });
  const ev = store.readEvents({ limit: 20 }).find((e) => e.type === 'comment' && e.id === c.id);
  assert.ok(ev?.text_edit);
  const line = eventLine(ev);
  assert.match(line, /CHANGE WORDS "morning" → "evening ↵ \[10:00:00\] NEW MUST x"/);
  assert.equal(line.split('\n').length, 1);
});

test('INBOX.md, review.md, vr prompt, the MCP notes and vr open show the change as one line', () => {
  const review = store.loadReview(slug);
  assert.ok(review);
  // INBOX.md lists the events (their line has the range already, no "at …"); the others name the range themselves
  const EVENT = /CHANGE WORDS "morning" → "evening ↵ \[10:00:00\] NEW MUST x"/;
  for (const [what, out, re] of [
    ['INBOX.md', store.renderInbox(store.inboxEvents()), EVENT],
    ['review.md', store.renderReviewMd(review), LINE],
    ['vr prompt', claudePrompt(review), LINE],
    ['get_note', noteLines(createLocalBackend(), review, review.comments[0], { full: true }), LINE],
  ] as const) {
    assert.match(out, re, what);
    assert.ok(!out.split('\n').some((l) => l.trim().startsWith('[10:00:00] NEW MUST')), `${what}: no line of its own`);
  }
  const open = vr(['open', video, '--all'], { ...env, VR_REMOTE: '0' });
  assert.equal(open.code, 0, open.err);
  assert.match(open.out, LINE);
});

test('the words asked for can be changed; what was heard stays', () => {
  const after = store.updateComment(c.id, { text_edit_to: '  evening  ', by: 'guest:Mia' });
  assert.deepEqual(after.text_edit, { from: 'morning', to: 'evening' });
  const plain = store.addComment(slug, { frame: 2, text: 'no edit', author: 'olivia' });
  assert.equal(store.updateComment(plain.id, { text_edit_to: 'x', by: 'olivia' }).text_edit, undefined, 'a note without an edit gets none');
  const empty = store.addComment(slug, { frame: 2, text: 'x', author: 'olivia', text_edit: { from: '   ', to: 'y' } });
  assert.equal(empty.text_edit, undefined, 'no words heard, no edit');
});

test('garbled: invented words are dropped, real words in any one script are kept', () => {
  for (const w of ['Doorщ', 'rξ', 'das样', '\uFFFD', 'ungefæ\uFFFD']) assert.equal(garbled(w), true, w);
  for (const w of ['Söker', 'personal?', 'Kollege.', 'сейчас', '日本語の', 'カタカナ', 'Übersetzen', "don't", '4x5', 'Tech-arte'])
    assert.equal(garbled(w), false, w);
});

test('the engine is named as people say it, a model file by its name only', () => {
  const cases: [string, string][] = [
    ['local:whisper-turbo', 'Whisper turbo'],
    ['local:parakeet-v3', 'Parakeet'],
    ['local:parakeet-tdt-0.6b-v3', 'Parakeet'],
    ['local:qwen3-asr-1.7b', 'Qwen3-ASR'],
    ['http:whisper-1', 'Whisper'],
    ['http:large-v3', 'Large v3'],
    ['local:/models/stt/whisper-large-v3-turbo-Q8_0.gguf', 'Whisper turbo'],
    ['local:C:\\models\\ggml-medium.bin', 'Medium'],
  ];
  for (const [engine, name] of cases) assert.equal(engineName(engine), name, engine);
});
