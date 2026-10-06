// What a way to a platform does (lib/publish/youtube.ts, lib/publish/zernio.ts; direct Meta, TikTok, LinkedIn and X
// adapters fit the same shape later): check its secret and list the accounts it posts as, send a post, say where a sent
// post stands, take back one it still holds. The queue (lib/publish/queue.ts) calls them; nothing else does.
import { oneLine } from '../time.ts';
import type { ConnectionKind, Post, PublishAccount } from '../types.ts';
import type { ConnectionSecret } from './connections.ts';

/** An upload the platform can resume (YouTube's session URL), kept sealed on the post between tries. */
export interface UploadSession {
  url: string;
  total: number;
}

/** What is sent: the post, its exact file, its cover. */
export interface PublishTarget {
  post: Post;
  /** The final version's file, or the platform's encode of it. */
  file: string;
  bytes: number;
  /** Seconds (Facebook: a Reel up to 90 s, a video beyond). */
  duration: number;
  /** A JPEG of the cover frame, when one was chosen. */
  cover: string | null;
  /** Where the cover frame is, in milliseconds (Instagram's thumb offset). */
  coverMs: number | null;
  account: PublishAccount | null;
  /** The same for every try of one publish (a lost answer sent again is the same post), new on a person's retry. */
  key: string;
  /** The upload a try before left off at, if any. */
  session: UploadSession | null;
  /**
   * A try before got as far as the request that makes the post (`committing`): a session the platform no longer knows
   * may have made it already, so it is never replaced by a new upload (A12 PUB-1).
   */
  committed?: boolean;
  /** Keeps (or forgets, null) the upload to resume on the next try. The queue forgets it once the post's id is kept. */
  keepSession(s: UploadSession | null): void;
  /**
   * Said right before the request that can make the post exist at the platform (YouTube: the last bytes; Zernio: the
   * post). From then on a failure without the platform's answer is never sent again by itself (A12 PUB-1): an upload
   * session finds out where it stands; without one the post is `sent`, for a person to look.
   */
  committing(): void;
  progress(sent: number, total: number): void;
}

/** Where a post stands on the platform after a send or a look. `processing`: sent, the platform isn't done with it. */
export interface Outcome {
  state: 'posted' | 'scheduled' | 'processing';
  remote_id: string;
  url: string | null;
  /** YouTube kept the upload private (an API project that hasn't passed YouTube's audit). */
  locked?: boolean;
  /** Something worth a line in the history ("the cover wasn't set: …"). */
  note?: string;
}

/** Keeps a secret that changed on the way (a fresh access token), sealed again. */
export type KeepSecret = (s: ConnectionSecret) => void;

export interface Adapter {
  kind: ConnectionKind;
  /** Checks the secret against the platform and lists the accounts it posts as. */
  accounts(secret: ConnectionSecret, keep: KeepSecret): Promise<PublishAccount[]>;
  publish(target: PublishTarget, secret: ConnectionSecret, keep: KeepSecret): Promise<Outcome>;
  /** Where a sent post stands now. */
  status(post: Post, secret: ConnectionSecret, keep: KeepSecret): Promise<Outcome>;
  /** Takes back a post the platform still holds (a schedule), when the platform lets this connection do that. */
  cancel?(post: Post, secret: ConnectionSecret, keep: KeepSecret): Promise<void>;
}

/**
 * The platform said no, or couldn't be reached. `message` is the reason as a sentence a person reads (never a token or
 * a header); `transient` ones are tried again later; `auth`: the connection's sign-in or key no longer works.
 */
export class PublishError extends Error {
  transient: boolean;
  auth: boolean;
  /** The platform said no to the request that would have made the post: nothing was made (a 4xx refusal). */
  notSent?: boolean;
  /** The platform answered that the post it holds (this id) failed: the outcome, not a lost answer. */
  remoteId?: string;
  /** How long to wait before the next try, when the platform said (a quota resets tomorrow). */
  retryAfterMs?: number;
  constructor(message: string, o: { transient?: boolean; auth?: boolean; retryAfterMs?: number; notSent?: boolean } = {}) {
    super(sentence(message));
    this.transient = !!o.transient;
    this.auth = !!o.auth;
    if (o.notSent) this.notSent = true;
    if (o.retryAfterMs) this.retryAfterMs = o.retryAfterMs;
  }
}

/** Accounts one connection keeps at most, and how much of a platform's account fields is kept (A12 PUB-16). */
export const ACCOUNTS_MAX = 100;
export const ACCOUNT_FIELD_MAX = 120;

/**
 * The accounts a platform named, as a connection keeps them: each field one line and cut, at most ACCOUNTS_MAX of them.
 * A platform's answer is bounded only by the 4 MB answer cap, and these names reach the composer, events and agents. An
 * id longer than a post can name (120 characters) or empty is no account to post as, so it is left out, never cut.
 */
export function keptAccounts(list: PublishAccount[]): PublishAccount[] {
  const cut = (v: unknown) => [...oneLine(String(v ?? '')).trim()].slice(0, ACCOUNT_FIELD_MAX).join('');
  const out: PublishAccount[] = [];
  const seen = new Set<string>();
  for (const a of list) {
    const id = String(a?.id ?? '');
    if (!id || id.length > ACCOUNT_FIELD_MAX || oneLine(id) !== id || seen.has(`${a.platform}\n${id}`)) continue;
    seen.add(`${a.platform}\n${id}`);
    const name = cut(a.name) || id;
    const detail = cut(a.detail);
    out.push({ id, platform: a.platform, name, ...(detail ? { detail } : {}) });
    if (out.length >= ACCOUNTS_MAX) break;
  }
  return out;
}

/** A platform's words as one sentence: one line, at most 300 characters, a capital first and a full stop last. */
export function sentence(s: string): string {
  const t = oneLine(String(s || '').trim()).slice(0, 300);
  if (!t) return 'The platform refused it.';
  const capital = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(capital) ? capital : `${capital}.`;
}

/** Seconds of a Retry-After header, as milliseconds (absent or unreadable: undefined). */
export function retryAfterOf(h: string | string[] | undefined): number | undefined {
  const v = Array.isArray(h) ? h[0] : h;
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return Math.min(n, 86400) * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : undefined;
}
