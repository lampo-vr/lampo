// Upload tickets: a one-time URL, valid 15 minutes, that takes one plain PUT (`curl -T render.mp4 <url>`). For agents
// that reach the server through MCP and have a shell but no API token in it (Codex or Claude Code connected with
// OAuth, a cloud sandbox): the MCP tool `request_upload` hands one out, bound to who asked and to the video it names;
// `attach_preview` hands out one for a fix preview (a still or clip of a note's fix, lib/previews.ts).
// GET on the same URL reports the outcome for an hour. Kept in memory: one app process per store (docs/docker.md).
import crypto from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import { hasItem, type OptionAttached, type OptionTarget } from '../lib/askOptions.ts';
import * as auth from '../lib/auth.ts';
import { fileName, folderName, slugName } from '../lib/inputs.ts';
import { listApps } from '../lib/oauth/store.ts';
import { MAX_HANDLES } from '../lib/part.ts';
import { type Action, can } from '../lib/permissions.ts';
import type { Attached, PreviewTarget } from '../lib/previews.ts';
import type { RefAttached, RefTarget } from '../lib/refs.ts';
import { currentWorkspace } from '../lib/scope.ts';
import { scopeAllows } from '../lib/scopes.ts';
import * as store from '../lib/store.ts';
import type { GuestRef, OptionGroup, UploadResult } from '../lib/types.ts';
import { roleIn } from '../lib/workspaces.ts';
import { sessionOf } from './auth.ts';
import { fail } from './http.ts';

const TICKET = /^vrup_[\w-]{32}$/;
const TICKET_MS = 15 * 60_000;

export const TicketInput = z.object({
  filename: fileName,
  folder: folderName.nullish(),
  slug: slugName.nullish(),
  /** A partial render of `slug` (lib/part.ts): the frame its stretch starts at, and its handles. */
  part_at: z.number().int().min(0).nullish(),
  handles: z.number().int().min(0).max(MAX_HANDLES).nullish(),
});
export type TicketRequest = z.infer<typeof TicketInput>;

/** Where an upload goes: a file name, and a folder for a new video or the slug of an existing one. */
export interface UploadMeta {
  name: string;
  folder: string | null;
  slug: string | null;
  /** A partial render of `slug` (lib/part.ts). */
  part?: { at: number; handles?: number };
}

// tus metadata are strings; tickets send numbers.
const frameNumber = (x: unknown, what: string, max = Number.MAX_SAFE_INTEGER): number | undefined => {
  if (x === undefined || x === null || x === '') return undefined;
  const n = typeof x === 'number' ? x : /^\d{1,9}$/.test(String(x)) ? Number(x) : Number.NaN;
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`${what} must be a whole number of frames`);
  return n;
};

/** Checks upload metadata (tus or ticket); throws with a message for people. */
export function uploadMeta(m: {
  filename?: string;
  name?: string;
  folder?: string | null;
  slug?: string | null;
  part_at?: string | number | null;
  handles?: string | number | null;
}): UploadMeta {
  const slug = m.slug || null;
  const at = frameNumber(m.part_at, 'part_at');
  const handles = frameNumber(m.handles, 'handles', MAX_HANDLES);
  if (at !== undefined && !slug) throw new Error('a part needs the video it patches (slug)');
  if (slug) {
    const review = store.loadReview(slug);
    if (!review) throw new Error('no such video');
    // A part is kept like an upload whichever way the video arrived (lib/store.ts uploadTarget).
    if (!store.isUpload(review) && at === undefined) throw new Error('that video is tracked from a file on disk; re-render it to its path instead');
  }
  return {
    name: store.uploadName(m.filename || m.name || ''),
    folder: store.uploadFolder(m.folder),
    slug,
    ...(at !== undefined ? { part: { at, ...(handles !== undefined ? { handles } : {}) } } : {}),
  };
}

/** A reference as a review link answers it: what the link shows of it, never the note or the owner's names. */
export interface GuestRefAnswer {
  ref: GuestRef | null;
}

export type Outcome =
  | { status: 'processing' }
  | { status: 'done'; result: UploadResult | Attached | RefAttached | GuestRefAnswer | OptionAttached }
  /** `code`: the status to answer with (409: a part that can't be one), else 422. */
  | { status: 'failed'; error: string; code?: number };

/**
 * What the PUT becomes: a render (the next version of a video, or a new one; `byId`: the account of the ticket's `by`),
 * a fix preview, or a reference on a note.
 */
export type TicketTarget =
  | { kind: 'render'; meta: UploadMeta; byId?: string }
  | { kind: 'preview'; preview: PreviewTarget }
  | { kind: 'ref'; ref: RefTarget }
  /** The file of an item a question with options offers (lib/askOptions.ts). */
  | { kind: 'option'; option: OptionTarget };

export interface Ticket {
  by: string;
  /** The workspace it was handed out in: what the PUT works in, whoever sends it. */
  ws: string;
  target: TicketTarget;
  expires: number;
  used: boolean;
  outcome?: Outcome;
  /** Throws when the ticket may no longer be used (a review link revoked or expired since it was handed out). */
  check?: () => void;
  /** What the uploader gets back for a reference (a client: the link's view of it). */
  present?: (r: RefAttached) => GuestRefAnswer;
  /** Whose URL it is, and whose open URLs it counts among (TicketGuard). */
  owner?: string;
  pool?: string;
}

/**
 * Checked again when the URL is used, and what the uploader gets back. A review link's visitor: the link still valid. A
 * member of the team: the one who asked would still get in and may still do it (`teamGuard`) — the URL works for 15
 * minutes, and a removal, a revoked token or a disabled account in between ends it (A12 VA2-3).
 */
export interface TicketGuard {
  check?: () => void;
  present?: (r: RefAttached) => GuestRefAnswer;
  /** Whose URL it is (an account, a link's visitor): each holds only so many open at once (OPEN_PER_OWNER). */
  owner?: string;
  /** Whose open URLs it counts among in its workspace (the team, one review link's visitors): OPEN_PER_POOL. */
  pool?: string;
}

/** Upload URLs one account (or one review-link visitor) may hold open at once. */
export const OPEN_PER_OWNER = 50;
/** …and a workspace's team together, or one review link's visitors together. */
export const OPEN_PER_POOL = 500;

/**
 * Who asked for a team member's URL, as what identifying them again needs — never the request itself, which a URL
 * would otherwise keep alive for 75 minutes: the account and workspace, and the API token, session or OAuth grant they
 * came with (and an app's scopes).
 */
export interface TicketIssuer {
  via: 'local' | 'lan' | 'cookie' | 'token' | 'oauth';
  user: string;
  ws: string;
  /** An API token's id. */
  token?: string;
  /** The session cookie's value (checked as a sign-in is: revoked, expired, the account's epoch). */
  session?: string;
  /** An OAuth app's grant id: the app stays allowed while the grant does, whatever its hour-long access tokens do. */
  grant?: string;
  scopes?: readonly string[];
}

/** The issuer of a request signed in over HTTP (null for nobody). */
export function issuerOf(req: Request): TicketIssuer | null {
  const a = req.auth;
  if (!a?.user) return null;
  return {
    via: a.via,
    user: a.user.id,
    ws: a.workspace,
    ...(a.via === 'token' && a.tokenId ? { token: a.tokenId } : {}),
    ...(a.via === 'cookie' ? { session: sessionOf(req) ?? undefined } : {}),
  };
}

/** Whether the issuer would still get in as then — same account, its token, session or app still valid — and may `action`. */
export function issuerStill(i: TicketIssuer, action: Action): boolean {
  if (i.via === 'local') return true;
  const user = auth.getUser(i.user);
  if (!user || user.disabled) return false;
  if (i.via === 'token') {
    const t = auth.listTokens(i.user).find((x) => x.id === i.token);
    if (!t || auth.tokenExpired(t) || auth.tokenWorkspace(t) !== i.ws) return false;
  } else if (i.via === 'cookie') {
    const s = i.session ? auth.checkSession(i.session) : null;
    if (!s || s.user.id !== i.user) return false;
  } else if (i.via === 'oauth') {
    if (!i.grant || !listApps(i.user, i.ws).some((g) => g.id === i.grant)) return false;
  }
  const role = roleIn(i.ws, i.user);
  if (!role || !can(role, action)) return false;
  return !i.scopes || scopeAllows(i.scopes, action);
}

/** The guard of a URL handed to a member of the team: checked again, when it is used, as `issuerStill`. */
export const teamGuard = (issuer: TicketIssuer | null, action: Action): TicketGuard => ({
  ...(issuer ? { owner: `user:${issuer.user}` } : {}),
  pool: 'team',
  check: () => {
    if (!issuer || !issuerStill(issuer, action)) throw fail(403, 'whoever asked for this upload URL may no longer upload here; ask for a new one');
  },
});

export interface IssuedTicket {
  /** Absolute when a base URL is known, else a path. */
  url: string;
  expires: string;
}

export interface UploadTickets {
  /**
   * A one-time upload URL for `by` (account `byId`), who must be allowed to upload (the caller checks now, `guard` when
   * it is used). Throws on bad metadata.
   */
  issue(input: TicketRequest, by: string, base: string | null, byId: string | undefined, guard: TicketGuard): IssuedTicket;
  /** A one-time URL for a fix preview of a note; `by` must be allowed to resolve notes (the caller checks; `guard` again at use). */
  issuePreview(target: PreviewTarget, by: string, base: string | null, guard: TicketGuard): IssuedTicket;
  /** A one-time URL for an image or clip reference on a note; `by` may add it (the caller checks; `guard` again at use). */
  issueRef(target: RefTarget, by: string, base: string | null, guard: TicketGuard): IssuedTicket;
  /**
   * A one-time URL for the file of an item a question with options offers; `by` asked it (the caller checks; `guard`
   * again at use). `offered`: the question's options while it isn't written yet (its URLs come first: a refusal leaves
   * no question behind) — else the item is looked up.
   */
  issueOption(target: OptionTarget, by: string, base: string | null, guard: TicketGuard, offered?: OptionGroup[]): IssuedTicket;
  /** Takes back a URL handed out for something that wasn't made after all: it neither works nor counts as open. */
  drop(url: string): void;
  /** The ticket behind a URL's last segment, or null (unknown, malformed, or gone). */
  get(raw: string): Ticket | null;
}

/** `origin`: where one-time URLs point whatever base a caller names (the app's own media host, VR_MEDIA_ORIGIN). */
export function createUploadTickets({ origin = null }: { origin?: string | null } = {}): UploadTickets {
  const tickets = new Map<string, Ticket>();
  const hashOf = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
  function mint(target: TicketTarget, by: string, base: string | null, guard: TicketGuard): IssuedTicket {
    // Kept an hour past expiry, so the outcome can still be read.
    for (const [k, t] of tickets) if (Date.now() > t.expires + 3600_000) tickets.delete(k);
    const ws = currentWorkspace();
    if (guard.owner || guard.pool) {
      let mine = 0;
      let pooled = 0;
      for (const t of tickets.values()) {
        if (t.used || Date.now() > t.expires) continue;
        if (guard.owner && t.owner === guard.owner) mine++;
        if (guard.pool && t.pool === guard.pool && t.ws === ws) pooled++;
      }
      if (mine >= OPEN_PER_OWNER)
        throw Object.assign(fail(429, `${OPEN_PER_OWNER} upload URLs are open already: use them, or wait until they expire`), { retryAfter: 60 });
      if (pooled >= OPEN_PER_POOL) throw Object.assign(fail(429, 'too many upload URLs are open here right now: try again in a minute'), { retryAfter: 60 });
    }
    const token = `vrup_${crypto.randomBytes(24).toString('base64url')}`;
    const expires = Date.now() + TICKET_MS;
    tickets.set(hashOf(token), { by, ws, target, expires, used: false, ...guard });
    return { url: `${origin || base || ''}/api/uploads/direct/${token}`, expires: new Date(expires).toISOString() };
  }
  return {
    issue: (input, by, base, byId, guard) => mint({ kind: 'render', meta: uploadMeta(input), ...(byId ? { byId } : {}) }, by, base, guard),
    issuePreview(target, by, base, guard) {
      if (!store.findComment(target.comment)) throw new Error(`no note ${target.comment}`);
      return mint({ kind: 'preview', preview: target }, by, base, guard);
    },
    issueRef(target, by, base, guard) {
      if (!target.draft && !store.findComment(target.comment)) throw new Error(`no note ${target.comment}`);
      return mint({ kind: 'ref', ref: target }, by, base, guard);
    },
    issueOption(target, by, base, guard, offered) {
      const has = offered
        ? offered.some((g) => g.id === target.group && g.items.some((it) => it.id === target.item))
        : hasItem(target.ask, target.group, target.item);
      if (!has) throw new Error(`no item ${target.group}/${target.item} on ${target.ask}`);
      return mint({ kind: 'option', option: target }, by, base, guard);
    },
    drop(url) {
      const raw = url.split('/').pop() ?? '';
      if (TICKET.test(raw)) tickets.delete(hashOf(raw));
    },
    get: (raw) => (TICKET.test(raw) ? tickets.get(hashOf(raw)) || null : null),
  };
}
