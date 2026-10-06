// What an error may tell whom. The machine's owner at the machine (`via: 'local'`: the app on loopback, a stdio MCP
// server, `vr`) sees every error as it is: the paths are their own files, the tool output is their own ffmpeg. Anyone
// else — a review-link visitor (even on the machine, through the tunnel or the LAN), a signed-in person on another
// device, an agent with a token or an app, every caller of a hosted server — gets a sentence meant for them, with a ref
// to the log line that holds the rest. Decided by who asks, never by the mode.
import crypto from 'node:crypto';
import { NoWorkspaceError } from './paths.ts';

/** Who an answer is for: the machine's owner at the machine, or anyone else. */
export type Audience = 'owner' | 'other';

// What a tool or the system said, carried on in a message of our own: `<binary> exited <code>: <stderr>` (lib/probe.ts
// run; `null` when a signal ended it — a crash, the OOM killer), ffmpeg's `[mjpeg @ 0x…]` log contexts, a file system
// error's `ENOENT: no such file or directory, open '…'`.
const TOOL_OUTPUT = /\bexited (?:-?\d+|null): |@ 0x[0-9a-f]{4,}|\bE[A-Z]{2,}: [a-z]/;

/**
 * Marks an error as the server's business wherever it goes (an object store's or a speech engine's answer: storage keys,
 * bucket names, tracebacks, internal hosts, model paths). Returns it.
 */
export function internal<E>(e: E): E {
  if (e && typeof e === 'object') (e as { internal?: boolean }).internal = true;
  return e;
}

/**
 * A failure told again with words of our own in front of it (`voice/a: …`: which item failed). The failure stays its
 * cause, so the new error is to every audience what the cause was — internal, or a sentence of its own (`publicText`),
 * both found through the cause — and it answers with the cause's status and Retry-After, which statusOf and the error
 * handler read off the error itself. `new Error(prefix + e.message)` keeps none of that: an object store's XML went out
 * to tokens as a 422 (A12 OPTM-1).
 */
export function restated(prefix: string, cause: unknown): Error {
  const e = new Error(`${prefix}${(cause as Error)?.message ?? String(cause)}`, { cause });
  const o = (cause && typeof cause === 'object' ? cause : {}) as { status?: unknown; retryAfter?: unknown };
  if (typeof o.status === 'number') Object.assign(e, { status: o.status });
  if (typeof o.retryAfter === 'number') Object.assign(e, { retryAfter: o.retryAfter });
  return e;
}

/**
 * Whether an error's text is the server's business: a tool's raw output (a RunError carries `stderr`), a file system
 * error (`syscall`, `errno`), an error marked `internal` (object stores, speech engines), work that lost its workspace,
 * or a message that carries any of them on. The error's `cause` chain counts too (a route that turned a failure into a
 * 4xx keeps it as the cause). A message of our own that repeats what the caller asked for (a path they typed) is theirs
 * already: it isn't hidden, so the same question gets the same answer whatever is behind it.
 */
export function isInternal(e: unknown): boolean {
  let x: unknown = e;
  for (let depth = 0; x && typeof x === 'object' && depth < 5; depth++) {
    const o = x as { stderr?: unknown; syscall?: unknown; errno?: unknown; internal?: unknown; message?: unknown; cause?: unknown };
    if (typeof o.stderr === 'string' || typeof o.syscall === 'string' || typeof o.errno === 'number' || o.internal === true || x instanceof NoWorkspaceError)
      return true;
    if (typeof o.message === 'string' && TOOL_OUTPUT.test(o.message)) return true;
    x = o.cause;
  }
  return false;
}

/** The sentence someone other than the owner gets instead, by status. */
function sentenceFor(status: number): string {
  if (status >= 500) return 'something went wrong on the server';
  if (status === 422 || status === 415) return 'that file could not be read or converted';
  if (status === 404 || status === 410) return 'not found';
  if (status === 409) return 'that can’t be done right now';
  return 'that request could not be handled';
}

/** Walks an error and its causes (a route's `failFrom` keeps what failed as `cause`); the first value `pick` finds. */
function inChain<T>(e: unknown, pick: (o: Record<string, unknown>) => T | undefined): T | undefined {
  let x: unknown = e;
  for (let depth = 0; x && typeof x === 'object' && depth < 5; depth++) {
    const hit = pick(x as Record<string, unknown>);
    if (hit !== undefined) return hit;
    x = (x as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * The text an error may show `audience`: as it is for the owner. For anyone else, decided before the status a caller
 * gives it (an MCP tool reports every error as a 400, a route wraps a failure as a 4xx): an error about the server's
 * state rather than the request (workspaces.json can't be read) carries its own sentence, `publicText` — on it or on
 * what caused it —, said with no ref and not logged per request (the state is logged once where it is noticed); an error
 * that is itself the server's fault (its own status ≥ 500) or internal gets a plain sentence with a ref, the whole error
 * in the log under that ref; a 4xx of our own words about the request is shown as it is.
 */
export function publicMessage(e: unknown, audience: Audience, { status = 500, where = '' }: { status?: number; where?: string } = {}): string {
  const message = (e as Error)?.message ?? String(e);
  if (audience === 'owner') return message;
  const own = inChain(e, (o) => (typeof o.publicText === 'string' ? o.publicText : undefined));
  if (own !== undefined) return own;
  const fault = inChain(e, (o) => (typeof o.status === 'number' && o.status >= 500 ? o.status : undefined));
  if (fault !== undefined && fault > status) status = fault;
  if (status < 500 && !isInternal(e)) return message;
  const ref = crypto.randomBytes(4).toString('hex');
  console.error(`${where ? `[${where}] ` : ''}${ref}`, (e as Error)?.stack || message, ...causes(e));
  return `${sentenceFor(status)} (ref ${ref})`;
}

/**
 * A failure kept to be read later (a transcript that failed, a recording that couldn't be heard) as `audience` may read
 * it: as it is for the owner; `fallback` for anyone else. What a speech engine says when it fails (a traceback, an
 * internal host, a model's path) is the server's business whatever it looks like, and a kept failure is only ever one.
 * Not logged again: it was when it happened.
 */
export const shownTo = (audience: Audience, message: string, fallback: string): string => (audience === 'owner' ? message : fallback);

/**
 * The status an error answers with: its own when it is ours (HttpError, a body parser's, a status we set), else
 * `fallback`. An internal error's own status is someone else's — an object store refusing with a 403 is a fault of this
 * server, not the caller's: a 500.
 */
export function statusOf(e: unknown, fallback = 500): number {
  const o = (e && typeof e === 'object' ? e : {}) as { status?: unknown; statusCode?: unknown };
  const own = Number(o.status || o.statusCode) || 0;
  if (!own) return fallback;
  return isInternal(e) ? 500 : own;
}

/** What an error was caused by, for the log line. */
function causes(e: unknown): string[] {
  const out: string[] = [];
  let x = (e as { cause?: unknown })?.cause;
  for (let depth = 0; x && depth < 4; depth++) {
    out.push(`\n  caused by: ${(x as Error)?.stack || String(x)}`);
    x = (x as { cause?: unknown })?.cause;
  }
  return out;
}
