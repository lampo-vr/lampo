// One rate limiter for sign-in, invites, OAuth, MCP and review links: the limit itself, and memory that stays
// bounded when every request brings a new key (an IPv6 visitor can make up addresses at will). And Memo, what was
// costly to make kept while it is asked for: bounded by entries and bytes, and fair between groups (workspaces).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Memo, RateLimit } from '../../lib/rateLimit.ts';

const clock = () => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

test('take: the limit per window, then how long to wait, then free again', () => {
  const c = clock();
  const lim = new RateLimit(3, 60_000, { now: c.now });
  assert.deepEqual([lim.take('a'), lim.take('a'), lim.take('a'), lim.take('a')], [true, true, true, false]);
  assert.equal(lim.retryAfter('a'), 60);
  assert.equal(lim.take('b'), true, 'per key');
  c.advance(30_000);
  assert.equal(lim.retryAfter('a'), 30);
  c.advance(30_000);
  assert.equal(lim.retryAfter('a'), 0);
  assert.equal(lim.take('a'), true);
});

test('hit counts failures; reset forgets them', () => {
  const lim = new RateLimit(2, 60_000);
  lim.hit('ip');
  assert.equal(lim.retryAfter('ip'), 0);
  lim.hit('ip');
  assert.ok(lim.retryAfter('ip') > 0);
  lim.reset('ip');
  assert.equal(lim.retryAfter('ip'), 0);
});

test('keys are forgotten once their window has passed, even if they never come back', () => {
  const c = clock();
  const lim = new RateLimit(5, 60_000, { now: c.now });
  for (let i = 0; i < 1000; i++) lim.hit(`2001:db8::${i.toString(16)}`);
  assert.equal(lim.size, 1000);
  c.advance(60_001);
  lim.take('someone else');
  assert.equal(lim.size, 1, 'the one-off keys are gone');
});

test('the table never holds more than maxKeys, and a busy key is the last to go', () => {
  const lim = new RateLimit(5, 60_000, { maxKeys: 100 });
  lim.hit('target');
  for (let i = 0; i < 1000; i++) {
    lim.hit(`flood-${i}`);
    if (i % 50 === 0) lim.hit('target');
  }
  assert.ok(lim.size <= 100, `bounded (${lim.size})`);
  lim.hit('target');
  lim.hit('target');
  assert.ok(lim.retryAfter('target') > 0, 'its count survived the flood');
});

const groupOf = (key: string) => key.split('|')[0] as string;
/** What one entry of `key` weighing `value` takes in a memo (its key and the entry come on top of the value). */
const weightOf = (key: string, value: number): number => {
  const probe = new Memo<number>(10, { weigh: (x) => x, groupOf });
  probe.set(key, value);
  return probe.bytes();
};
const name = (g: string, i: number) => `${g}|${String(i).padStart(2, '0')}`;
/** Which of a group's first `n` names the memo still holds (asking is a use: only call it where that doesn't matter). */
const held = (memo: Memo<number>, g: string, n: number) => Array.from({ length: n }, (_, i) => name(g, i)).filter((k) => memo.get(k) !== undefined);

test('a memo holds what its bytes and entries allow, the least recently used going first; a hit is a use', () => {
  const w = weightOf('A|00', 1000);
  const memo = new Memo<number>(100, { maxBytes: 8 * w, weigh: (x) => x, groupOf });
  for (let i = 0; i < 20; i++) memo.set(name('A', i), 1000);
  assert.equal(memo.size, 8, 'as many as the bytes allow');
  assert.equal(memo.bytes(), 8 * w);
  assert.equal(memo.get(name('A', 12)), 1000, 'the oldest kept, asked for');
  memo.set(name('A', 20), 1000);
  assert.equal(memo.get(name('A', 12)), 1000, 'what was asked for stays');
  assert.equal(memo.get(name('A', 13)), undefined, 'the least recently used went in its place');
  // something heavier than the whole isn't kept, and nothing else goes for it
  memo.set('A|huge', 9 * w);
  assert.equal(memo.get('A|huge'), undefined);
  assert.equal(memo.size, 8);
  // by entries too, whatever the bytes
  const few = new Memo<number>(3, { groupOf });
  for (let i = 0; i < 10; i++) few.set(name('A', i), i);
  assert.deepEqual(held(few, 'A', 10), [name('A', 7), name('A', 8), name('A', 9)]);
  few.delete(name('A', 8));
  assert.deepEqual([few.size, few.sizeOf('A'), few.get(name('A', 8))], [2, 2, undefined]);
});

test('a full memo makes room in the group holding the most: no group pushes another below its own size', () => {
  const w = weightOf('A|00', 1000);
  const memo = new Memo<number>(100, { maxBytes: 8 * w, weigh: (x) => x, groupOf });
  // alone, a group may use it all
  for (let i = 0; i < 8; i++) memo.set(name('A', i), 1000);
  assert.equal(memo.bytes('A'), 8 * w);
  // another group's flood takes it down to the flood's own size, and no further: then the flood makes its own room
  for (let i = 0; i < 50; i++) memo.set(name('B', i), 1000);
  assert.deepEqual([memo.sizeOf('A'), memo.sizeOf('B')], [4, 4]);
  assert.deepEqual(held(memo, 'A', 8), [name('A', 4), name('A', 5), name('A', 6), name('A', 7)], 'A keeps what it used last');
  // a small group never gives way while a bigger one holds more
  memo.set(name('C', 0), 1000);
  for (let i = 50; i < 99; i++) memo.set(name('B', i), 1000);
  assert.equal(memo.get(name('C', 0)), 1000, 'C kept its one');
  assert.ok(memo.bytes() <= 8 * w);
  assert.ok(memo.sizeOf('A') >= 1 && memo.sizeOf('A') <= memo.sizeOf('B'), `A ${memo.sizeOf('A')}, B ${memo.sizeOf('B')}`);
  // the same by entries
  const few = new Memo<number>(4, { groupOf });
  few.set(name('A', 0), 0);
  few.set(name('A', 1), 0);
  for (let i = 0; i < 20; i++) few.set(name('B', i), 0);
  assert.deepEqual([few.sizeOf('A'), few.sizeOf('B')], [2, 2]);
});
