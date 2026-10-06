// An answer that says "not now" (503: the server can't check the link this moment — a store file being repaired, a full
// queue; 429: too many requests) is not a link or video that's gone. Client pages ask to come back and look again by
// themselves, when the server says (Retry-After), never sooner than a few seconds or later than two minutes.
export const notNow = (e: unknown): boolean => {
  const status = (e as { status?: unknown } | null)?.status;
  return status === 503 || status === 429;
};

/** When a query should ask again: after a "not now", as the server says (else 10 s); otherwise as it would anyway. */
export function askAgainIn(e: unknown, otherwise: number): number {
  if (!notNow(e)) return otherwise;
  const after = (e as { retryAfter?: unknown }).retryAfter;
  return typeof after === 'number' && after > 0 ? Math.min(Math.max(after * 1000, 5000), 120_000) : 10_000;
}
