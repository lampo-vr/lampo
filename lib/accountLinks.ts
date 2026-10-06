// One-time links that an email carries: confirming an address (`vt_…`, 24 hours) and choosing a new password
// (`rt_…`, 60 minutes). data/account-links.json (0600) keeps only each token's SHA-256, the account and the address it
// was sent to — never the token. A link works once; a newer link of the same kind for the same account voids the older
// ones; used, voided and expired links are kept a week, so the page can say "already used" or "expired" instead of
// "unknown" (that tells nothing about any account: only someone holding the link learns it).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA, isoLocal } from './paths.ts';
import { withLock, writeAtomic } from './store.ts';

export type LinkKind = 'verify' | 'reset';

export const LINK_TTL_MS: Record<LinkKind, number> = { verify: 24 * 3600e3, reset: 60 * 60e3 };
const PREFIX: Record<LinkKind, string> = { verify: 'vt_', reset: 'rt_' };
/** 32 random bytes, base64url: 43 characters after the prefix. */
export const LINK_TOKEN: Record<LinkKind, RegExp> = { verify: /^vt_[A-Za-z0-9_-]{43}$/, reset: /^rt_[A-Za-z0-9_-]{43}$/ };
const KEEP_MS = 7 * 86400e3;

export interface AccountLink {
  id: string;
  kind: LinkKind;
  /** sha256 of the token, hex. */
  hash: string;
  user: string;
  /** The address the link was sent to: for a change of address, the new one. */
  email: string;
  created: string;
  /** ms */
  expires: number;
  used?: string;
  /** A newer link of the same kind replaced it, or what it was for changed (a password set, the change cancelled). */
  void?: string;
}

export type LinkState = 'ok' | 'expired' | 'used' | 'invalid';

export const LINKS_FILE = path.join(DATA, 'account-links.json');
const LOCK_DIR = path.join(DATA, '.account-links');
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

function load(): AccountLink[] {
  try {
    return (JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8')) as { links?: AccountLink[] }).links ?? [];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

function change<T>(fn: (links: AccountLink[]) => T): T {
  fs.mkdirSync(DATA, { recursive: true });
  return withLock(LOCK_DIR, () => {
    const now = Date.now();
    // Links long past are forgotten: a week after they ended nobody needs to be told which way they ended.
    const links = load().filter((l) => now - Math.max(l.expires, Date.parse(l.used || l.void || '') || 0) < KEEP_MS);
    const out = fn(links);
    writeAtomic(LINKS_FILE, `${JSON.stringify({ links }, null, 2)}\n`);
    fs.chmodSync(LINKS_FILE, 0o600);
    return out;
  });
}

/** A new link for the account; older unused ones of the same kind stop working. Returns the token (shown nowhere else). */
export function issueLink(kind: LinkKind, user: string, email: string, now = Date.now()): { token: string; expires: number } {
  const token = `${PREFIX[kind]}${crypto.randomBytes(32).toString('base64url')}`;
  const expires = now + LINK_TTL_MS[kind];
  change((links) => {
    for (const l of links) if (l.kind === kind && l.user === user && !l.used && !l.void) l.void = isoLocal();
    links.push({ id: `l_${crypto.randomBytes(6).toString('hex')}`, kind, hash: sha256(token), user, email, created: isoLocal(new Date(now)), expires });
  });
  return { token, expires };
}

/** When each account was last sent a link at an address (ms), by `${user} ${email}`: what waits on one may not end first. */
export function newestLinks(): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of load()) {
    const k = `${l.user} ${l.email}`;
    out.set(k, Math.max(out.get(k) ?? 0, Date.parse(l.created) || 0));
  }
  return out;
}

function find(links: AccountLink[], kind: LinkKind, token: string): AccountLink | null {
  if (!LINK_TOKEN[kind].test(token)) return null;
  const want = Buffer.from(sha256(token));
  return links.find((l) => l.kind === kind && crypto.timingSafeEqual(Buffer.from(l.hash), want)) ?? null;
}

const stateOf = (l: AccountLink | null, now: number): LinkState => (!l ? 'invalid' : l.used || l.void ? 'used' : l.expires <= now ? 'expired' : 'ok');

/** What a link is now, without using it (the reset page asks before showing its form). */
export function peekLink(kind: LinkKind, token: string, now = Date.now()): { state: LinkState; link: AccountLink | null } {
  const l = find(load(), kind, token);
  const state = stateOf(l, now);
  return { state, link: state === 'ok' ? l : l && { ...l } };
}

/** Uses a link up, atomically: of two requests with the same token, one gets it. */
export function useLink(kind: LinkKind, token: string, now = Date.now()): { state: LinkState; link: AccountLink | null } {
  return change((links) => {
    const l = find(links, kind, token);
    const state = stateOf(l, now);
    if (state === 'ok' && l) l.used = isoLocal(new Date(now));
    return { state, link: l ? { ...l } : null };
  });
}

/** A removed account's links go altogether (their records name its address): none of it is told used or expired any more. */
export function forgetLinksOf(user: string): number {
  if (!fs.existsSync(LINKS_FILE)) return 0;
  return change((links) => {
    const before = links.length;
    for (let i = links.length - 1; i >= 0; i--) if (links[i]?.user === user) links.splice(i, 1);
    return before - links.length;
  });
}

/**
 * Voids an account's unused links (all, or one kind, or only those sent to one address): a password was set, the
 * account went away, a change was cancelled.
 */
export function voidLinks(user: string, kind?: LinkKind, to?: string): number {
  if (!fs.existsSync(LINKS_FILE)) return 0;
  return change((links) => {
    let n = 0;
    for (const l of links)
      if (l.user === user && (!kind || l.kind === kind) && (!to || l.email === to) && !l.used && !l.void) {
        l.void = isoLocal();
        n++;
      }
    return n;
  });
}
