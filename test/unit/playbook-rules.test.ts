// Rules one at a time (web/src/playbook/starters.ts): a list read as its items (a wrapped line stays with its rule), one
// taken out without touching the others, one added under the rest, how many a text holds, and the starter rules a
// playbook doesn't say yet — by their words, so a rule someone retyped with other punctuation isn't offered again.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ruleCount, ruleFromNotes, ruleItems, starterRules, unusedStarters, withLines, withoutRule } from '../../web/src/playbook/starters.ts';

test('a list reads as its rules, a wrapped line with the rule before it; anything more is text', () => {
  assert.deepEqual(ruleItems('- One\n* Two\n  still two\n\n1. Three'), [
    { text: 'One', from: 0, to: 0 },
    { text: 'Two still two', from: 1, to: 2 },
    { text: 'Three', from: 4, to: 4 },
  ]);
  assert.deepEqual(ruleItems(''), []);
  assert.equal(ruleItems('## Sound\n- -14 LUFS'), null, 'a heading: edited as text');
  assert.equal(ruleItems('Keep it calm.\n- One'), null, 'a paragraph');
});

test('one rule out, the rest as written', () => {
  const text = '- One\n- Two\n  wrapped\n- Three';
  const items = ruleItems(text) ?? [];
  assert.equal(withoutRule(text, items[1]), '- One\n- Three');
  assert.equal(withoutRule(text, items[0]), '- Two\n  wrapped\n- Three');
  assert.equal(withoutRule('- Only', { from: 0, to: 0 }), '');
});

test('rules added under what is written, a list item each', () => {
  assert.equal(withLines('', ['Logo small']), '- Logo small');
  assert.equal(withLines('- One\n\n', ['- Two', '* Three', '  ']), '- One\n- Two\n- Three');
  assert.equal(withLines('- One', []), '- One');
  assert.equal(ruleFromNotes({ tag: 'logo', count: 3, examples: [{ text: 'Logo smaller', video: 'Reel' }] } as never), 'Logo: Logo smaller');
});

test('how many rules a text holds', () => {
  assert.equal(ruleCount(''), 0);
  assert.equal(ruleCount('- a\n- b\n- c'), 3);
  assert.equal(ruleCount('## Sound\n- a\n- b'), 2);
  assert.equal(ruleCount('Keep it calm.'), 1);
});

test('starter rules a playbook doesn’t say yet, by their words', () => {
  const all = starterRules();
  assert.equal(unusedStarters('').length, all.length);
  const safe = all[0].line;
  const loud = all[1].line;
  assert.ok(!unusedStarters(`- ${safe}`).some((s) => s.line === safe), 'said: not offered');
  assert.ok(!unusedStarters('', `- ${loud.toUpperCase().replace(/,/g, '')}.`).some((s) => s.line === loud), 'said above, retyped');
  assert.equal(unusedStarters(`- ${safe}`, `- ${loud}`).length, all.length - 2);
});
