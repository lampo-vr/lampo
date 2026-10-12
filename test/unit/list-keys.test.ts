// React keys for an agent's steps (web/src/lib/listKeys.ts): never one key twice, and a step arriving on top leaves
// the keys below it as they were.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newestFirstKeys } from '../../web/src/lib/listKeys.ts';

const base = (s: { at: string; text: string }) => `${s.at}-${s.text}`;

test('two steps alike in one second get two keys', () => {
  const at = '2026-10-12T11:16:05+02:00';
  const steps = [
    { at, text: 'Reading the open notes' },
    { at, text: 'Waiting for your answer' },
    { at, text: 'Reading the open notes' },
  ];
  const keys = newestFirstKeys(steps, base);
  assert.equal(new Set(keys).size, steps.length, keys.join(' | '));
  assert.deepEqual(keys, [`${at}-Reading the open notes#2`, `${at}-Waiting for your answer`, `${at}-Reading the open notes`]);
});

test('a step on top keeps the keys of the ones below it', () => {
  const at = '2026-10-12T11:16:05+02:00';
  const older = [
    { at, text: 'Reading the open notes' },
    { at, text: 'Waiting for your answer' },
    { at, text: 'Reading the open notes' },
  ];
  const before = newestFirstKeys(older, base);
  const after = newestFirstKeys([{ at, text: 'Reading the open notes' }, ...older], base);
  assert.deepEqual(after.slice(1), before);
  assert.equal(new Set(after).size, after.length);
  assert.deepEqual(newestFirstKeys([], base), []);
});
