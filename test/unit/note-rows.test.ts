// The notes list's rules (web/src/player/noteRows.ts): a group header only where the author or the sitting changes, the
// tags the filter row offers with their counts, the note the playhead is at, and ↑ / ↓ through the list.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstLine, groupStarts, noteAt, noteTags, SITTING_MS, stepNote, tagCounts, withTag } from '../../web/src/player/noteRows.ts';

const at = (min: number) => new Date(Date.UTC(2026, 9, 3, 10, 0) + min * 60_000).toISOString();
const note = (id: string, author: string, created: string, more: Record<string, unknown> = {}) => ({ id, author, created, ...more });

test('a group header goes above the first row and wherever the author or the sitting changes', () => {
  const list = [
    note('a', 'Sam', at(0)),
    note('b', 'Sam', at(3)),
    note('c', 'Sam', at(9)),
    note('d', 'guest:Mia', at(10)),
    note('e', 'guest:Mia', at(12)),
    note('f', 'Sam', at(14)),
    // the same person, another sitting: written more than half an hour after the row above
    note('g', 'Sam', at(14 + SITTING_MS / 60_000 + 1)),
    note('h', 'Sam', at(14 + SITTING_MS / 60_000 + 2)),
  ];
  assert.deepEqual([...groupStarts(list)], ['a', 'd', 'f', 'g']);
  // ownership goes by account where there is one: a renamed account is still the same person
  assert.deepEqual([...groupStarts([note('x', 'Sam', at(0), { author_id: 'u1' }), note('y', 'Samuel', at(1), { author_id: 'u1' })])], ['x']);
  assert.deepEqual([...groupStarts([])], []);
  // thirty notes by one person in one sitting: one header
  const thirty = Array.from({ length: 30 }, (_, i) => note(`n${i}`, 'Sam', at(i)));
  assert.equal(groupStarts(thirty).size, 1);
});

test('tags: the ones a note carries, else what its words suggest; counted once per note, the most used first', () => {
  assert.deepEqual(noteTags({ tags: ['story'], text: 'the whoosh sfx' }), ['story']);
  assert.deepEqual(noteTags({ tags: [], text: 'Whoosh sfx, the music too loud' }), ['audio/music', 'sfx']);
  assert.deepEqual(noteTags({ text: 'Fine' }), []);
  const list = [
    { tags: ['sfx'] },
    { tags: ['sfx', 'sfx'] },
    { tags: ['story'] },
    { text: 'door slam sfx' },
    { tags: ['motion'] },
    { tags: ['story', 'motion'] },
    { text: 'nothing to see' },
  ];
  assert.deepEqual(tagCounts(list), [
    ['sfx', 3],
    ['motion', 2],
    ['story', 2],
  ]);
  assert.equal(withTag(list, 'story').length, 2);
  assert.equal(withTag(list, null).length, list.length);
  assert.equal(withTag(list, 'graphic').length, 0);
});

test('the note at the playhead: on its frame, inside its section, a moment past it while playing; the latest wins', () => {
  const list = [
    { id: 'whole', scope: 'video', frameHere: 0, rangeHere: null },
    { id: 'p10', frameHere: 10 },
    { id: 'r20', frameHere: 20, rangeHere: { in: 20, out: 60 } },
    { id: 'p30', frameHere: 30 },
  ];
  assert.equal(noteAt(list, 0), null, 'a note about the whole video has no moment');
  assert.equal(noteAt(list, 10), 'p10');
  assert.equal(noteAt(list, 11), null);
  assert.equal(noteAt(list, 11, 25), 'p10', 'held while playing');
  assert.equal(noteAt(list, 25), 'r20');
  assert.equal(noteAt(list, 30), 'p30', 'a note inside a section wins on its frame');
  assert.equal(noteAt(list, 31), 'r20');
  assert.equal(noteAt(list, 61), null);
});

test('↑ / ↓ step through the list as shown, from the selected note or from an end', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(stepNote(list, null, 1)?.id, 'a');
  assert.equal(stepNote(list, null, -1)?.id, 'c');
  assert.equal(stepNote(list, 'a', 1)?.id, 'b');
  assert.equal(stepNote(list, 'b', -1)?.id, 'a');
  assert.equal(stepNote(list, 'c', 1), null, 'the end stays the end');
  assert.equal(stepNote(list, 'gone', 1)?.id, 'a', 'a note no longer listed: from the top');
  assert.equal(stepNote([], null, 1), null);
});

test('a row shows the first line of a note', () => {
  assert.equal(firstLine('Hold the hero shot\nIt needs a moment'), 'Hold the hero shot');
  assert.equal(firstLine('  one line  '), 'one line');
  assert.equal(firstLine(null), '');
});
