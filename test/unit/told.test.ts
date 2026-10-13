// covers: lib/told.ts mcp/feedback.ts
// What an agent was told of each video (lib/told.ts) and the inbox a wait hands over (mcp/feedback.ts inbox): a place
// per agent and video, kept in the workspace's own folder (a restart reads it back), never moving back, bounded; and a
// wait hands everything after a video's place whatever cursor it brings, after the cursor where nothing was told.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { ReviewEvent } from '../../lib/types.ts';
import { tmpdir } from '../lib/helpers.ts';

const { markTold, toldPlace, toldPlaces, TOLD_KEEP } = await import('../../lib/told.ts');
const { inbox, parseCursor, readPlace } = await import('../../mcp/feedback.ts');

const folder = () => tmpdir('vr-told-');

test('a place per agent and video, kept in the workspace’s folder, never moving back; other workspaces and agents apart', () => {
  const a = folder();
  const b = folder();
  markTold(a, 'mcp-1', { 'loop.mp4': { at: 1000, seen: 2 } });
  assert.deepEqual(toldPlace(a, 'mcp-1', 'loop.mp4'), { at: 1000, seen: 2 });
  assert.equal(toldPlace(a, 'mcp-2', 'loop.mp4'), null, 'another agent was told nothing');
  assert.equal(toldPlace(b, 'mcp-1', 'loop.mp4'), null, 'another workspace knows nothing of it');
  // never back: an older place leaves it where it is, a later one moves it
  markTold(a, 'mcp-1', { 'loop.mp4': { at: 1000, seen: 1 } });
  assert.deepEqual(toldPlace(a, 'mcp-1', 'loop.mp4'), { at: 1000, seen: 2 });
  markTold(a, 'mcp-1', { 'loop.mp4': { at: 2000, seen: 0 }, 'other.mp4': { at: 500, seen: 1 } });
  assert.deepEqual(toldPlaces(a, 'mcp-1'), { 'loop.mp4': { at: 2000, seen: 0 }, 'other.mp4': { at: 500, seen: 1 } });
  // on disk, the workspace's own, and only for its owner; what is read back is what was written (a restart forgets nothing)
  const file = path.join(a, 'told.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(raw.marks[`mcp-1\u0000loop.mp4`].slice(0, 2), [2000, 0]);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('Title'), 'agents and videos, nothing anyone wrote');
});

test('bounded: past TOLD_KEEP marks the oldest go; a file that can’t be read tells nothing and is never written over', () => {
  const a = folder();
  const many: Record<string, { at: number; seen: number }> = {};
  for (let i = 0; i < TOLD_KEEP; i++) many[`v${i}.mp4`] = { at: 1000, seen: 0 };
  markTold(a, 'old', many, 1);
  markTold(a, 'new', { 'x.mp4': { at: 5000, seen: 1 } }, 2);
  const marks = JSON.parse(fs.readFileSync(path.join(a, 'told.json'), 'utf8')).marks;
  assert.equal(Object.keys(marks).length, TOLD_KEEP);
  assert.deepEqual(toldPlace(a, 'new', 'x.mp4'), { at: 5000, seen: 1 });
  // can't be read (cut short, edited by hand): no floor — waits go by their cursor — and the file stays as it is
  const b = folder();
  const file = path.join(b, 'told.json');
  fs.writeFileSync(file, '{ not json');
  const said: string[] = [];
  const was = console.error;
  console.error = (...a: unknown[]) => said.push(a.join(' '));
  try {
    assert.equal(toldPlace(b, 'mcp-1', 'loop.mp4'), null);
    assert.deepEqual(toldPlaces(b, 'mcp-1'), {});
    markTold(b, 'mcp-1', { 'loop.mp4': { at: 1000, seen: 1 } });
    markTold(b, 'mcp-1', { 'loop.mp4': { at: 2000, seen: 1 } });
  } finally {
    console.error = was;
  }
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json', 'never written over');
  assert.equal(toldPlace(b, 'mcp-1', 'loop.mp4'), null);
  assert.equal(said.filter((l) => /told\.json can't be read/.test(l)).length, 1, `said once in the log: ${JSON.stringify(said)}`);
  // put right (here: removed), it is written again
  fs.rmSync(file);
  markTold(b, 'mcp-1', { 'loop.mp4': { at: 3000, seen: 1 } });
  assert.deepEqual(toldPlace(b, 'mcp-1', 'loop.mp4'), { at: 3000, seen: 1 });
});

test('the inbox: after a video’s place whatever the cursor; after the cursor where nothing was told; each thing once; a read moves the place only past what it told of', async () => {
  const T = Date.parse('2026-10-11T12:00:00Z');
  const ev = (slug: string, id: string, dt: number) => ({ at: new Date(T + dt).toISOString(), type: 'comment', slug, id }) as ReviewEvent;
  // N1 and N2 on A (N2 while the agent rendered), a note on B, then the agent's cursor from its upload, after all of them
  const events = [ev('A', 'n1', 0), ev('A', 'n2', 2000), ev('B', 'b1', 2000), ev('A', 'n3', 5000)];
  const cursor = parseCursor(`${new Date(T + 3000).toISOString()}#0`);
  // told of A up to N1 (it read the notes then): N2 comes despite the cursor; B (never told) goes by the cursor
  const told = { A: { at: T, seen: 1 } };
  const got = inbox(events, cursor, (s) => told[s as 'A'] ?? null);
  assert.deepEqual(
    got.fresh.map((e) => e.id),
    ['n2', 'n3'],
  );
  assert.deepEqual(got.places, { A: { at: T + 5000, seen: 1 } });
  assert.equal(got.next, `${new Date(T + 5000).toISOString()}#1`, 'the cursor after the last handed out, never before the one given');
  // told up to there: nothing again, whatever cursor (an old one too)
  const after = inbox(events, parseCursor(new Date(T - 60_000).toISOString()), (s) => (s === 'A' ? got.places.A : null));
  assert.deepEqual(
    after.fresh.map((e) => e.id),
    ['b1'],
    'B was never told: an old cursor brings its note',
  );
  // two events of A in one second, the first told: the second still comes
  const same = [ev('A', 'n1', 0), ev('A', 'n2', 0)];
  assert.deepEqual(
    inbox(same, parseCursor(new Date(T + 9000).toISOString()), () => ({ at: T, seen: 1 })).fresh.map((e) => e.id),
    ['n2'],
  );
  // a read moves the place past what it told of, never past what it didn't: an approval, a verdict on a note it left out
  const note = (id: string, dt: number, type = 'comment') => ({ ...ev('A', id, dt), type, by: 'Mia' }) as ReviewEvent;
  const log = [note('n1', 0), note('n2', 1000), { ...note('', 2000, 'approval'), id: undefined } as ReviewEvent, note('n3', 3000)];
  const b = { events: async () => log } as unknown as Parameters<typeof readPlace>[0];
  const to = { at: T + 5000, seen: 0 };
  assert.deepEqual(await readPlace(b, 'A', { at: T, seen: 1 }, new Set(['n2', 'n3']), to), { at: T + 1000, seen: 1 }, 'stops before the approval');
  assert.deepEqual(await readPlace(b, 'A', { at: T + 2000, seen: 1 }, new Set(['n3']), to), to, 'all it passes was told: up to the read');
  assert.deepEqual(await readPlace(b, 'A', null, new Set(), to), to, 'nothing told yet: the read is where it starts');
  // a second's events held apart in the log (an older one written between them): counted per second, as the cursor is
  const apart = [ev('A', 'n1', 0), ev('B', 'b1', -9000), ev('A', 'n2', 0)];
  assert.deepEqual(
    inbox(apart, parseCursor(`${new Date(T).toISOString()}#1`), () => null).fresh.map((e) => e.id),
    ['n2'],
  );
});
