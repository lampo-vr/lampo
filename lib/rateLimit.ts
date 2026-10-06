// Sliding-window rate limits in memory (sign-in, invites, OAuth, MCP, review-link passwords and notes), and `Recent`, a
// map of what was seen lately with the same bound. Keys are IPs,
// accounts, tokens or links, and a visitor can make up new ones at will (an IPv6 /64 is a lot of addresses), so the
// table is bounded twice: a key is dropped once its window has passed (swept at most once per window), and it never
// holds more than `maxKeys`, least recently used first. The cap is high on purpose: evicting a key forgets its
// history, so filling the table to wipe someone's own count has to cost that many requests within one window.

/**
 * The key a limit counts an address under. One IPv6 connection usually holds a whole /64 (2^64 addresses a visitor can
 * pick from at will), so an IPv6 address counts as its /64; an IPv4 address (also written IPv4-mapped, `::ffff:a.b.c.d`)
 * as itself. Anything else (a name, 'unknown') is kept as it is.
 */
export function addressKey(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4) return v4[1] as string;
  if (!ip.includes(':')) return ip;
  const bare = ip.replace(/%.*$/, '').toLowerCase();
  const [head, tail = ''] = bare.split('::');
  const left = head ? head.split(':') : [];
  const right = bare.includes('::') ? (tail ? tail.split(':') : []) : [];
  if (left.length + right.length > 8 || [...left, ...right].some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return ip;
  const groups = bare.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  if (groups.length !== 8) return ip;
  return `${groups
    .slice(0, 4)
    .map((h) => h.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

export interface RateLimitOptions {
  /** Keys kept at most (default 50,000: a few MB at worst). */
  maxKeys?: number;
  /** The clock, for tests. */
  now?: () => number;
}

/**
 * A map of what was seen lately, keyed by what visitors send (an address, a link and a video, a name): it never holds
 * more than `max` entries, the ones set longest ago going first. For "once per visitor and half hour" and the like,
 * where forgetting a key early only means counting it again.
 */
export class Recent<V> {
  private readonly map = new Map<string, V>();
  private readonly max: number;

  constructor(max = 10_000) {
    this.max = max;
  }

  get size(): number {
    return this.map.size;
  }

  get(key: string): V | undefined {
    return this.map.get(key);
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }

  delete(key: string): void {
    this.map.delete(key);
  }
}

export class RateLimit {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private nextSweep = 0;

  constructor(max: number, windowMs: number, { maxKeys = 50_000, now = Date.now }: RateLimitOptions = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.now = now;
  }

  /** Keys held right now (tests and diagnostics). */
  get size(): number {
    return this.hits.size;
  }

  /** One more for the key when it's under the limit: true, and counted. Over it: false, and not counted. */
  take(key: string): boolean {
    if (this.recent(key).length >= this.max) return false;
    this.hit(key);
    return true;
  }

  /** Whether the key is under the limit, without counting anything (count what landed with `hit`). */
  allows(key: string): boolean {
    return this.recent(key).length < this.max;
  }

  /** Counts one for the key, allowed or not (e.g. a failed sign-in). */
  hit(key: string): void {
    const list = this.recent(key);
    list.push(this.now());
    this.hits.delete(key);
    this.hits.set(key, list);
    while (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value as string);
  }

  /** Seconds until the key may go again; 0 when it may go now. */
  retryAfter(key: string): number {
    const list = this.recent(key);
    return list.length >= this.max ? Math.max(1, Math.ceil((list[0] + this.windowMs - this.now()) / 1000)) : 0;
  }

  /** Forgets the key (e.g. after a successful sign-in). */
  reset(key: string): void {
    this.hits.delete(key);
  }

  /** The key's hits inside the window; drops the key when there are none, and sweeps the table now and then. */
  private recent(key: string): number[] {
    const now = this.now();
    if (now >= this.nextSweep) {
      this.nextSweep = now + this.windowMs;
      for (const [k, list] of this.hits) if (!list.length || now - (list.at(-1) as number) >= this.windowMs) this.hits.delete(k);
    }
    const list = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }
}
