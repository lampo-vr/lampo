// A review link the server can't check this moment (503: folders.json being repaired, a full queue; 429) is not a link
// that's gone: the client page asks to come back and asks again by itself, as soon as the server says (A12 VE1r2-4).
// The page itself is checked in test/e2e/share.mjs; here, the rule both client queries use.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askAgainIn, notNow } from '../../web/src/lib/busy.ts';

/** What web/src/api/client.ts throws for an answer that isn't ok (its ApiError, without the browser's types). */
class ApiError extends Error {
  status: number;
  retryAfter: number | null;
  constructor(message: string, status: number, retryAfter: number | null = null) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

test('503 and 429 are "not now"; anything else is what it says', () => {
  assert.equal(notNow(new ApiError('that isn’t available right now: try again later', 503)), true);
  assert.equal(notNow(new ApiError('too many requests', 429, 30)), true);
  for (const status of [404, 410, 403, 500]) assert.equal(notNow(new ApiError('x', status)), false, String(status));
  assert.equal(notNow(null), false);
  assert.equal(notNow(new Error('network')), false);
});

test('a "not now" is asked again when the server says, within 5 s and 2 min; else at the usual pace', () => {
  assert.equal(askAgainIn(new ApiError('busy', 503, 60), 20_000), 60_000);
  assert.equal(askAgainIn(new ApiError('busy', 503), 20_000), 10_000, 'no Retry-After: soon');
  assert.equal(askAgainIn(new ApiError('slow down', 429, 1), 20_000), 5000);
  assert.equal(askAgainIn(new ApiError('slow down', 429, 3600), 20_000), 120_000);
  assert.equal(askAgainIn(new ApiError('gone', 404), 20_000), 20_000);
  assert.equal(askAgainIn(null, 20_000), 20_000);
});
