// One rate limiter for sign-in, invites, OAuth, MCP and review links: the limit itself, and memory that stays
// bounded when every request brings a new key (an IPv6 visitor can make up addresses at will).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RateLimit } from '../../lib/rateLimit.ts';

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
