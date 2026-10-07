// wait_for_feedback hands out at most 20 events at a time. When more arrived, it gives the oldest 20 and a cursor
// just past them — the rest come with the next call — instead of the newest 20 and a cursor past all (which lost the
// older ones for good).
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewEvent } from '../../lib/types.ts';

const { after, parseCursor } = await import('../../mcp/feedback.ts');

test('more events than one call shows: every one arrives, once, oldest first', () => {
  // 25 events over 5 seconds, five per second (timestamps have one-second resolution).
  const base = Date.parse('2026-09-30T10:00:00Z');
  const events = Array.from(
    { length: 25 },
    (_, i) => ({ id: `c_${String(i).padStart(6, '0')}`, at: new Date(base + Math.floor(i / 5) * 1000).toISOString() }) as ReviewEvent,
  );
  const got: string[] = [];
  let cursor = parseCursor(new Date(base - 1000).toISOString());
  for (let call = 0; call < 3; call++) {
    const { fresh, next } = after(events, cursor, 20);
    assert.ok(fresh.length <= 20, `call ${call} handed out ${fresh.length}`);
    got.push(...fresh.map((e) => e.id as string));
    cursor = parseCursor(next);
  }
  assert.deepEqual(
    got,
    events.map((e) => e.id),
  );
});

test('a cursor from one video’s wait, used for every video’s, skips none of theirs that came later', () => {
  const T = Date.parse('2026-10-05T12:00:07Z');
  const ev = (slug: string, id: string, dt: number) => ({ at: new Date(T + dt).toISOString(), type: 'comment', slug, id }) as ReviewEvent;
  const events = [ev('A.mp4', 'c_a1', 0), ev('B.mp4', 'c_b1', 1000), ev('B.mp4', 'c_b2', 2000)];
  const start = parseCursor(new Date(T - 1000).toISOString());
  const onA = after(events, start, 20, (e) => e.slug === 'A.mp4');
  assert.deepEqual(
    onA.fresh.map((e) => e.id),
    ['c_a1'],
  );
  // the cursor stands after A's note, not after B's the wait only looked at
  assert.deepEqual(
    after(events, parseCursor(onA.next), 20).fresh.map((e) => e.id),
    ['c_b1', 'c_b2'],
  );
  assert.deepEqual(
    after(events, parseCursor(onA.next), 20, (e) => e.slug === 'B.mp4').fresh.map((e) => e.id),
    ['c_b1', 'c_b2'],
  );
  // a wait that hands out nothing keeps its cursor where it was
  const none = after(events, start, 20, (e) => e.slug === 'C.mp4');
  assert.deepEqual([none.fresh.length, none.next], [0, `${new Date(T - 1000).toISOString()}#0`]);
});
