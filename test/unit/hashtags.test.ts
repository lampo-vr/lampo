// "#" in a note's text tags it (web/src/player/hashtags.ts): the word at the caret, the tags that fit it, taking the
// "#word" out when one is picked, and whole "#tags" left in the text when the note is saved.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TAGS } from '../../lib/time.ts';
import { dropHash, hashAt, matchTags, takeHashtags } from '../../web/src/player/hashtags.ts';

const EN: Record<string, string> = { 'text/typo': 'text/typo', 'audio/music': 'audio/music', 'love-it': 'love it' };
const label = (tag: string) => EN[tag] ?? tag;
const DE: Record<string, string> = { timing: 'Timing', 'audio/music': 'Ton/Musik', 'love-it': 'gefällt mir' };
const labelDe = (tag: string) => DE[tag] ?? tag;

test('the "#word" at the caret: after a space or at the start, the caret at its end', () => {
  assert.deepEqual(hashAt('#', 1), { start: 0, end: 1, query: '' });
  assert.deepEqual(hashAt('Logo early #Tim', 15), { start: 11, end: 15, query: 'tim' });
  assert.deepEqual(hashAt('Music #audio/mu', 15), { start: 6, end: 15, query: 'audio/mu' });
  assert.equal(hashAt('Logo early #tim', 10), null, 'the caret before the #');
  assert.equal(hashAt('mail@x.com#', 11), null, 'a # inside a word is no tag');
  assert.equal(hashAt('#timing is off', 4), null, 'the caret in the middle of the word');
  assert.equal(hashAt('#tim more', 9), null, 'a space after it ends it');
});

test('tags fit by any word of their id or their label, in their order', () => {
  assert.deepEqual(matchTags(TAGS, '', label), TAGS);
  assert.deepEqual(matchTags(TAGS, 'ti', label), ['timing']);
  assert.deepEqual(matchTags(TAGS, 'mu', label), ['audio/music']);
  assert.deepEqual(matchTags(TAGS, 'typo', label), ['text/typo']);
  assert.deepEqual(matchTags(TAGS, 'lo', label), ['love-it']);
  assert.deepEqual(matchTags(TAGS, 'ton', labelDe), ['audio/music'], 'the label in the UI’s language');
  assert.deepEqual(matchTags(TAGS, 'zzz', label), []);
});

test('picking a tag takes its "#word" out and closes the gap', () => {
  const at = hashAt('Logo early #tim', 15);
  assert.ok(at);
  assert.deepEqual(dropHash('Logo early #tim', at), { text: 'Logo early ', caret: 11 });
  const mid = hashAt('#ti and more', 3);
  assert.ok(mid);
  assert.deepEqual(dropHash('#ti and more', mid), { text: 'and more', caret: 0 });
});

test('whole #tags left in the text become tags when the note is saved; anything else stays as written', () => {
  assert.deepEqual(takeHashtags('Logo too early #timing', TAGS, label), { text: 'Logo too early', tags: ['timing'] });
  assert.deepEqual(takeHashtags('#sfx louder, #love-it here #sfx', TAGS, label), { text: 'louder, here', tags: ['sfx', 'love-it'] });
  assert.deepEqual(takeHashtags('Colour #color/grade.', TAGS, label), { text: 'Colour.', tags: ['color/grade'] });
  assert.deepEqual(takeHashtags('Music #ton/musik', TAGS, labelDe), { text: 'Music', tags: ['audio/music'] });
  const plain = 'Shot #3 is late  (keep  spacing)';
  assert.deepEqual(takeHashtags(plain, TAGS, label), { text: plain, tags: [] }, 'no tag, no change');
});
