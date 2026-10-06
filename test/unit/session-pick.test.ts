// The agent picker's rules (web/src/sessions/pick.ts): the assigned agent is always the first row and preselected —
// also while it isn't running — and Assign only acts when the choice differs from what is assigned. Before, an
// assigned agent that wasn't running preselected "No agent", and Assign silently removed the assignment.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Session, SessionRef } from '../../web/src/api/types.ts';
import { changes, initialPick, pickerRows } from '../../web/src/sessions/pick.ts';

const session = (name: string, o: Partial<Session> = {}): Session => ({
  name,
  sessionId: `s-${name}`,
  pid: 1,
  cwd: `/work/${name}`,
  kind: 'interactive',
  status: 'idle',
  startedAt: 0,
  ...o,
});
const assigned = (name: string, o: Partial<SessionRef> = {}): SessionRef => ({
  name,
  id: null,
  cwd: null,
  assigned: '2026-09-30T10:00:00+02:00',
  by: 'Sam',
  ...o,
});

test('an assigned agent that is not running is the first row, marked, and preselected', () => {
  const running = [session('reel-cut'), session('promo-edit')];
  const current = assigned('launch-edit', { agent: 'codex', cwd: '/work/launch' });
  const rows = pickerRows(running, current);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].name, 'launch-edit');
  assert.equal(rows[0].notRunning, true);
  assert.equal(rows[0].agent, 'codex');
  assert.equal(rows[0].cwd, '/work/launch');
  assert.deepEqual(
    rows.slice(1).map((r) => r.name),
    ['reel-cut', 'promo-edit'],
  );
  const sel = initialPick(rows, current, null);
  assert.equal(sel?.name, 'launch-edit');
  assert.equal(changes(sel, current), false, 'Assign does nothing until the choice changes');
});

test('an assigned agent that runs moves to the top and is preselected', () => {
  const running = [session('reel-cut'), session('launch-edit')];
  const current = assigned('launch-edit', { id: 's-launch-edit' });
  const rows = pickerRows(running, current);
  assert.deepEqual(
    rows.map((r) => [r.name, !!r.notRunning]),
    [
      ['launch-edit', false],
      ['reel-cut', false],
    ],
  );
  assert.equal(changes(initialPick(rows, current, null), current), false);
});

test('picking another agent or "No agent" is a change; the same one again is not', () => {
  const current = assigned('launch-edit');
  const rows = pickerRows([session('reel-cut')], current);
  assert.equal(changes(rows[1], current), true);
  assert.equal(changes(null, current), true, 'removing the assignment is a deliberate choice');
  assert.equal(changes(rows[0], current), false);
});

test('without an assignment the suggestion is preselected and choosing someone is a change', () => {
  const rows = pickerRows([session('reel-cut')], null);
  assert.equal(rows.length, 1);
  const suggestion = rows[0];
  assert.equal(initialPick(rows, null, suggestion), suggestion);
  assert.equal(changes(suggestion, null), true);
  assert.equal(changes(null, null), false, 'no agent stays no agent');
});
