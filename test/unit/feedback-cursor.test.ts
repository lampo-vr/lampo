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
