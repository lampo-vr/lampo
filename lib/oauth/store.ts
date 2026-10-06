// OAuth state of a hosted server, for apps that connect to its MCP endpoint (MCP authorization 2026-07-28):
//   pending authorization requests  memory, 10 min  what the consent screen shows; one decision each
//   authorization codes             memory, 60 s    one-time, PKCE-bound; reuse revokes what the code produced
//     (`vr login`'s: 2 min, redeemed for an API token at POST /api/auth/token — redeemVrCode)
//   grants ("connected apps")       data/oauth/grants.json (0600)
//     one per consent: user, client, scopes, the resource the tokens are bound to, the current refresh token and the
//     live access tokens (all stored as sha256). Refresh tokens rotate on every use; presenting an old one again means
//     it leaked, and the whole grant is revoked.
// Access tokens are opaque (vro_…), short-lived and only valid at the MCP endpoint they were issued for.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { accessEnded, getUser, revokeToken as revokeApiToken, type User } from '../auth.ts';
import { DATA, isoLocal } from '../paths.ts';
import { Recent } from '../rateLimit.ts';
import type { Scope } from '../scopes.ts';
import { deepFreeze, withLock, writeAtomic } from '../store.ts';
import { compareTime } from '../time.ts';
import type { PublicApp } from '../types.ts';
import { type ClientInfo, OAUTH_DIR } from './clients.ts';

export const GRANTS_FILE = path.join(OAUTH_DIR, 'grants.json');
const LOCK_DIR = path.join(DATA, '.oauth');

export const ACCESS_TTL_S = 3600;
const REFRESH_TTL_MS = 60 * 86400_000;
const CODE_TTL_MS = 60_000;
/**
 * How long a code for `vr login` works (tests shorten it): its loopback listener redeems it at once, but over SSH the
 * person pastes the address a browser on another computer ended on, which takes a moment.
 */
export const VR_CODE = { ttlMs: 120_000 };
const REQUEST_TTL_MS = 10 * 60_000;
/** Rotated refresh tokens remembered per grant, to spot a replay. */
const USED_REFRESH_KEPT = 50;

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const random = (prefix: string) => `${prefix}${crypto.randomBytes(32).toString('base64url')}`;
const sameHash = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ---------------------------------------------------------------- pending authorization requests

/**
 * What a pending request keeps of its client: what the consent screen and the code need. Never the registration's
 * every redirect URI: that was ~20 KB per request anyone signed out could make (A13 AUTH-2).
 */
export type RequestClient = Pick<ClientInfo, 'client_id' | 'kind' | 'name' | 'host'>;

export interface AuthRequest {
  id: string;
  client: RequestClient;
  redirect_uri: string;
  state: string | null;
  code_challenge: string;
  scopes: Scope[];
  resource: string;
  expires: number;
  /** `vr login` (lib/oauth/clients.ts VR_CLIENT): the computer, as it names itself, and the days its token works. */
  vr?: VrAsk;
}

export interface VrAsk {
  machine: string;
  /** Days the API token works; null: until revoked. */
  days: number | null;
}

/**
 * The pending requests: anyone signed out makes them (GET /oauth/authorize), so a bounded map (`Recent`: the ones made
 * longest ago go first, an expired one when it is asked for); server/routes/oauth.ts lists it with `keptInMemory` and
 * lets one address have only so many waiting.
 */
export const PENDING_REQUESTS_KEPT = 10_000;
export const pendingRequests = new Recent<AuthRequest>(PENDING_REQUESTS_KEPT);

const sweep = <T extends { expires: number }>(m: Map<string, T>) => {
  const now = Date.now();
  for (const [k, v] of m) if (v.expires <= now) m.delete(k);
};

/** A pending request for a client (resolved, or what of it a request keeps): only the slim part is kept. */
export function createRequest(r: Omit<AuthRequest, 'id' | 'expires' | 'client'> & { client: ClientInfo | RequestClient }): AuthRequest {
  const { client_id, kind, name, host } = r.client;
  const req: AuthRequest = {
    ...r,
    client: { client_id, kind, name, host },
    id: crypto.randomBytes(24).toString('base64url'),
    expires: Date.now() + REQUEST_TTL_MS,
  };
  pendingRequests.set(req.id, req);
  return req;
}

export function getRequest(id: string): AuthRequest | null {
  const r = pendingRequests.get(id);
  if (r && r.expires <= Date.now()) pendingRequests.delete(id);
  return r && r.expires > Date.now() ? r : null;
}

/** A consent decision uses the request up: it can't be allowed twice, or allowed after it was denied. */
export function takeRequest(id: string): AuthRequest | null {
  const r = getRequest(id);
  pendingRequests.delete(id);
  return r;
}

// ---------------------------------------------------------------- authorization codes

interface Code {
  user: string;
  client_id: string;
  client_name: string;
  client_host: string | null;
  client_kind: ClientInfo['kind'];
  redirect_uri: string;
  code_challenge: string;
  scopes: Scope[];
  resource: string;
  expires: number;
  /** Set once redeemed: a second try revokes this grant. */
  grant: string | null;
  /** The workspace the person allowed the app into (the consent screen named it). */
  workspace: string;
  /**
   * The account's epoch when the person allowed it (lib/auth.ts): a new password, signing out everywhere or disabling
   * moves it on, and a code from before is worth nothing after — it would become a fresh grant the change never saw.
   */
  epoch: number;
  /** A code for `vr login`: redeemed for an API token (redeemVrCode), never for a grant. */
  vr?: VrAsk;
  /** The API token a `vr login` code made, once redeemed: a second try revokes it. */
  token?: string;
}

const codes = new Map<string, Code>();

/** A one-time code for what the person allowed: the app acts for `user` in `workspace` (absent: workspace #1). */
export function createCode(req: AuthRequest, user: User, workspace = 'w1'): string {
  sweep(codes);
  const code = random('vra_');
  codes.set(sha256(code), {
    user: user.id,
    client_id: req.client.client_id,
    client_name: req.client.name,
    client_host: req.client.host,
    client_kind: req.client.kind,
    redirect_uri: req.redirect_uri,
    code_challenge: req.code_challenge,
    scopes: req.scopes,
    resource: req.resource,
    expires: Date.now() + (req.vr ? VR_CODE.ttlMs : CODE_TTL_MS),
    grant: null,
    workspace,
    epoch: user.epoch,
    ...(req.vr ? { vr: req.vr } : {}),
  });
  return code;
}

/** The codes an account was given and hasn't redeemed stop working (a new password: lib/newPassword.ts). */
export function voidCodesOf(userId: string): number {
  let n = 0;
  for (const [k, c] of codes)
    if (c.user === userId && !c.grant && !c.token) {
      codes.delete(k);
      n++;
    }
  return n;
}

export class GrantError extends Error {
  /** OAuth error code for the token endpoint: invalid_grant, invalid_target, invalid_scope. */
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const pkceOk = (verifier: string, challenge: string) =>
  /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) && sameHash(crypto.createHash('sha256').update(verifier).digest('base64url'), challenge);

export interface Tokens {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** authorization_code grant: one redemption per code, same client and redirect URI, PKCE verified, same resource. */
export function redeemCode(o: {
  code: string;
  client_id: string;
  redirect_uri: string | undefined;
  code_verifier: string | undefined;
  resource?: string;
}): Tokens {
  const key = sha256(o.code || '');
  const c = codes.get(key);
  if (!c || c.expires <= Date.now()) throw new GrantError('invalid_grant', 'the authorization code is unknown or has expired');
  // `vr login`'s code makes an API token at POST /api/auth/token, never an app's grant here; shown, it is used up.
  if (c.vr) {
    codes.delete(key);
    throw new GrantError('invalid_grant', 'the authorization code is unknown or has expired');
  }
  if (c.grant) {
    // RFC 6749 §4.1.2: a code used twice was probably stolen; what it produced goes too.
    codes.delete(key);
    revokeGrant(c.grant, 'authorization code reused');
    throw new GrantError('invalid_grant', 'the authorization code was already used');
  }
  // Any failed redemption uses the code up as well: codes are single-shot, a stolen one can't be retried.
  const refuse = (code: string, message: string) => {
    codes.delete(key);
    return new GrantError(code, message);
  };
  if (c.client_id !== o.client_id) throw refuse('invalid_grant', 'the code was issued to another client');
  if (!o.redirect_uri || o.redirect_uri !== c.redirect_uri) throw refuse('invalid_grant', 'redirect_uri does not match the authorization request');
  if (!o.code_verifier || !pkceOk(o.code_verifier, c.code_challenge)) throw refuse('invalid_grant', 'PKCE verification failed');
  if (o.resource !== undefined && o.resource !== c.resource) throw refuse('invalid_target', 'resource does not match the authorization request');
  const user = getUser(c.user);
  if (!user || user.disabled) throw refuse('invalid_grant', 'the account is not active');
  if (user.epoch !== c.epoch) throw refuse('invalid_grant', 'the account’s password or sessions changed since this code was issued: sign in again');
  const access = random('vro_');
  const refresh = random('vrr_');
  const grant: Grant = {
    id: `g_${crypto.randomBytes(6).toString('hex')}`,
    user: c.user,
    client_id: c.client_id,
    client_name: c.client_name,
    client_host: c.client_host,
    client_kind: c.client_kind,
    scopes: c.scopes,
    resource: c.resource,
    created: isoLocal(),
    last_used: null,
    refresh: { hash: sha256(refresh), expires: Date.now() + REFRESH_TTL_MS },
    used_refresh: [],
    access: [{ hash: sha256(access), expires: Date.now() + ACCESS_TTL_S * 1000 }],
    ...(c.workspace !== 'w1' ? { workspace: c.workspace } : {}),
  };
  change((g) => {
    g.push(grant);
  });
  c.grant = grant.id;
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: c.scopes.join(' ') };
}

/** What a `vr login` code was allowed for: the account, the workspace the consent screen named, the computer. */
export interface VrCodeUse extends VrAsk {
  user: User;
  workspace: string;
}

/**
 * `vr login`'s code for its API token (POST /api/auth/token): one redemption, the same redirect URI, PKCE verified, the
 * account as it was when the person allowed it. `mint` makes the token once all of that holds (it may still refuse:
 * the code is used up then too). A second try with the same code means someone else saw the answer: the token the first
 * one made is revoked as well (RFC 6749 §4.1.2), and so it ends for whoever holds it.
 */
export function redeemVrCode<T extends { info: { id: string } }>(
  o: { code: string; redirect_uri: string; code_verifier: string },
  mint: (use: VrCodeUse) => T,
): T {
  const key = sha256(o.code || '');
  const c = codes.get(key);
  if (!c?.vr || c.expires <= Date.now()) throw new GrantError('invalid_grant', 'the sign-in code is unknown or has expired: run vr login again');
  if (c.token) {
    codes.delete(key);
    revokeApiToken(c.token, c.user);
    throw new GrantError('invalid_grant', 'the sign-in code was already used, so the token it made is revoked too: run vr login again');
  }
  const refuse = (message: string) => {
    codes.delete(key);
    return new GrantError('invalid_grant', message);
  };
  if (o.redirect_uri !== c.redirect_uri) throw refuse('redirect_uri does not match the sign-in');
  if (!pkceOk(o.code_verifier, c.code_challenge)) throw refuse('PKCE verification failed');
  const user = getUser(c.user);
  if (!user || user.disabled) throw refuse('the account is not active');
  if (user.epoch !== c.epoch) throw refuse('the account’s password or sessions changed since you allowed it: run vr login again');
  let made: T;
  try {
    made = mint({ user, workspace: c.workspace, machine: c.vr.machine, days: c.vr.days });
  } catch (e) {
    codes.delete(key);
    throw e;
  }
  c.token = made.info.id;
  return made;
}

// ---------------------------------------------------------------- grants

interface Grant {
  id: string;
  user: string;
  client_id: string;
  client_name: string;
  client_host: string | null;
  client_kind: ClientInfo['kind'];
  scopes: Scope[];
  resource: string;
  created: string;
  last_used: string | null;
  refresh: { hash: string; expires: number } | null;
  used_refresh: string[];
  /** `scopes`: a token from a refresh that asked for less than the grant (RFC 6749 §6); without it, the grant's. */
  access: { hash: string; expires: number; scopes?: Scope[] }[];
  revoked?: string;
  revoked_reason?: string;
  /** The workspace the app acts in (absent: workspace #1, grants from before workspaces). */
  workspace?: string;
}

/** The workspace a grant acts in. */
const grantWorkspace = (g: Pick<Grant, 'workspace'>): string => g.workspace || 'w1';

/** Whether an app connection acts in a workspace other than #1: a sign that the store moved to workspaces. */
export const grantsElsewhere = (): boolean => current().grants.some((g) => grantWorkspace(g) !== 'w1');

// Every request an app makes reads the grants (and so does every open MCP stream when it asks again), so the file is
// parsed again only when it changed (inode, size, mtime — every write is an atomic rename), like users.json, with the
// live access tokens indexed by their hash. What reads get is shared and frozen; changes go through change().
let parsed: { key: string; grants: readonly Grant[]; byAccess: Map<string, Grant> } | null = null;
function current(): NonNullable<typeof parsed> {
  let key = 'none';
  try {
    const st = fs.statSync(GRANTS_FILE);
    key = `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (parsed?.key === key) return parsed;
  const grants = deepFreeze(load());
  const byAccess = new Map<string, Grant>();
  for (const g of grants) for (const a of g.access) byAccess.set(a.hash, g);
  parsed = { key, grants, byAccess };
  return parsed;
}

function load(): Grant[] {
  try {
    return (JSON.parse(fs.readFileSync(GRANTS_FILE, 'utf8')) as { grants?: Grant[] }).grants || [];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

/** Expired access tokens go; revoked grants and ones whose refresh token ran out are kept for 30 days, then dropped. */
function prune(grants: Grant[]): Grant[] {
  const now = Date.now();
  const keepUntil = now - 30 * 86400_000;
  return grants.filter((g) => {
    g.access = g.access.filter((a) => a.expires > now);
    const ended = g.revoked ? Date.parse(g.revoked) : g.refresh && g.refresh.expires > now ? null : (g.refresh?.expires ?? 0);
    return ended === null || ended > keepUntil;
  });
}

function save(grants: Grant[]): void {
  fs.mkdirSync(OAUTH_DIR, { recursive: true, mode: 0o700 });
  writeAtomic(GRANTS_FILE, `${JSON.stringify({ grants: prune(grants) }, null, 2)}\n`);
  fs.chmodSync(GRANTS_FILE, 0o600);
}

const change = <T>(fn: (g: Grant[]) => T): T =>
  withLock(LOCK_DIR, () => {
    const g = load();
    const out = fn(g);
    save(g);
    return out;
  });

const active = (g: Grant, now = Date.now()) => !g.revoked && !!g.refresh && g.refresh.expires > now;

function revokeGrant(id: string, reason: string): boolean {
  const done = change((all) => {
    const g = all.find((x) => x.id === id);
    if (!g || g.revoked) return false;
    g.revoked = isoLocal();
    g.revoked_reason = reason;
    g.refresh = null;
    g.access = [];
    return true;
  });
  if (done) accessEnded();
  return done;
}

/** refresh_token grant: rotates the refresh token; an already-rotated one revokes the grant (it leaked). */
export function refresh(o: { refresh_token: string; client_id: string; scope?: string; resource?: string }): Tokens {
  const hash = sha256(o.refresh_token || '');
  const now = Date.now();
  // A token no grant ever held (junk, a guess) is refused without writing grants.json or telling open streams anything:
  // anyone may call the token endpoint (A12-D11).
  if (!current().grants.some((g) => (g.refresh && sameHash(g.refresh.hash, hash)) || g.used_refresh.includes(hash)))
    throw new GrantError('invalid_grant', 'the refresh token is unknown, expired or revoked');
  let revoked = false;
  const out = change((all): Tokens | GrantError => {
    const replay = all.find((g) => g.used_refresh.includes(hash));
    if (replay) {
      if (!replay.revoked) {
        replay.revoked = isoLocal();
        replay.revoked_reason = 'refresh token reused';
        replay.refresh = null;
        replay.access = [];
        revoked = true;
      }
      return new GrantError('invalid_grant', 'this refresh token was already used; the connection has been revoked for safety');
    }
    const g = all.find((x) => x.refresh && sameHash(x.refresh.hash, hash));
    if (!g || !active(g, now)) return new GrantError('invalid_grant', 'the refresh token is unknown, expired or revoked');
    if (g.client_id !== o.client_id) return new GrantError('invalid_grant', 'the refresh token belongs to another client');
    if (o.resource !== undefined && o.resource !== g.resource) return new GrantError('invalid_target', 'resource does not match the grant');
    let scopes = g.scopes;
    if (o.scope !== undefined) {
      const asked = String(o.scope).split(/\s+/).filter(Boolean);
      if (asked.some((s) => !g.scopes.includes(s as Scope))) return new GrantError('invalid_scope', 'a refresh cannot widen the scope');
      scopes = g.scopes.filter((s) => asked.includes(s));
    }
    const user = getUser(g.user);
    if (!user || user.disabled) return new GrantError('invalid_grant', 'the account is not active');
    const access = random('vro_');
    const next = random('vrr_');
    g.used_refresh = [...g.used_refresh, g.refresh?.hash as string].slice(-USED_REFRESH_KEPT);
    g.refresh = { hash: sha256(next), expires: now + REFRESH_TTL_MS };
    g.access.push({ hash: sha256(access), expires: now + ACCESS_TTL_S * 1000, ...(scopes.length < g.scopes.length ? { scopes } : {}) });
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: next, scope: scopes.join(' ') };
  });
  if (out instanceof GrantError) {
    // A replayed refresh token revoked its grant: what that app holds open ends now. Any other refusal ended nothing.
    if (revoked) accessEnded();
    throw out;
  }
  return out;
}

/**
 * RFC 7009: a refresh token revokes its whole grant, an access token just itself. Unknown tokens are no error — and end
 * nothing: anyone may call it, so only a token one of this client's grants holds writes the file or tells open streams
 * (A12-D11).
 */
export function revokeToken(token: string, client_id: string): void {
  const hash = sha256(token || '');
  const holds = (g: Grant) => g.client_id === client_id && ((!!g.refresh && sameHash(g.refresh.hash, hash)) || g.access.some((a) => sameHash(a.hash, hash)));
  if (!current().grants.some(holds)) return;
  revoking(() =>
    change((all) => {
      let ended = false;
      for (const g of all) {
        if (!holds(g)) continue;
        if (g.refresh && sameHash(g.refresh.hash, hash)) {
          g.revoked = isoLocal();
          g.revoked_reason = 'revoked by the app';
          g.refresh = null;
          g.access = [];
        } else g.access = g.access.filter((a) => !sameHash(a.hash, hash));
        ended = true;
      }
      return ended;
    }),
  );
}

/** A change that may end some app's access: when it did, open streams ask again at once (lib/auth.ts accessEnded). */
function revoking(fn: () => boolean): void {
  if (fn()) accessEnded();
}

// last_used is written at most once a minute per grant, not on every request.
const lastWrite = new Map<string, number>();

export interface AccessCheck {
  user: User;
  scopes: Scope[];
  grant: string;
  client_name: string;
  /** The workspace the app acts in: the person's role there caps it (∩ its scopes). */
  workspace: string;
  /** When this access token ends by itself (ms since the epoch): an hour after it was issued. */
  expires: number;
}

/**
 * An access token presented at `resource`: known, unexpired, its grant active, its account active, and issued for this
 * very resource (RFC 8707 audience). Null for anything else. `touch: false` (an open stream asking again whether its
 * caller still gets in) leaves `last_used` alone: it says when the app last asked for something, not that it is connected.
 */
export function verifyAccess(token: string, resource: string, { touch = true }: { touch?: boolean } = {}): AccessCheck | null {
  if (!token.startsWith('vro_')) return null;
  const hash = sha256(token);
  const now = Date.now();
  const g = current().byAccess.get(hash);
  const issued = g?.access.find((a) => sameHash(a.hash, hash));
  if (!g || !issued || issued.expires <= now || g.revoked || g.resource !== resource) return null;
  const user = getUser(g.user);
  if (!user || user.disabled) return null;
  if (touch && now - (lastWrite.get(g.id) || 0) > 60_000) {
    lastWrite.set(g.id, now);
    change((all) => {
      const x = all.find((y) => y.id === g.id);
      if (x) x.last_used = isoLocal();
    });
  }
  return { user, scopes: issued?.scopes ?? g.scopes, grant: g.id, client_name: g.client_name, workspace: grantWorkspace(g), expires: issued.expires };
}

const publicApp = (g: Grant): PublicApp => ({
  id: g.id,
  user: g.user,
  client_name: g.client_name,
  client_host: g.client_host,
  verified: g.client_kind === 'cimd',
  scopes: g.scopes,
  created: g.created,
  last_used: g.last_used,
  ...(g.workspace && g.workspace !== 'w1' ? { workspace: g.workspace } : {}),
});

/** Clients someone is connected with (an active grant): client registrations that must not be evicted. */
export const connectedClientIds = (): Set<string> =>
  new Set(
    current()
      .grants.filter((g) => active(g))
      .map((g) => g.client_id),
  );

/** Connected apps (active grants), newest first; one user's or everyone's, in one workspace when given. */
export function listApps(userId?: string, workspace?: string): PublicApp[] {
  return current()
    .grants.filter((g) => active(g) && (!userId || g.user === userId) && (workspace === undefined || grantWorkspace(g) === workspace))
    .sort((a, b) => compareTime(b.created, a.created))
    .map(publicApp);
}

/** Disconnects an app: its refresh and access tokens stop working at once. Scoped to a user unless an admin asks, and
 * to a workspace when given (an admin of one workspace never reaches another's apps). */
export function revokeApp(id: string, userId?: string, workspace?: string): boolean {
  const g = current().grants.find((x) => x.id === id);
  if (!g || (userId && g.user !== userId) || (workspace !== undefined && grantWorkspace(g) !== workspace)) return false;
  return revokeGrant(id, 'disconnected in settings');
}

/** Revokes every grant `which` picks (none: nothing written, nobody told). */
function revokeWhere(which: (g: Grant) => boolean, reason: string): void {
  const pick = (g: Grant) => !g.revoked && which(g);
  if (!current().grants.some(pick)) return;
  revoking(() =>
    change((all) => {
      let ended = false;
      for (const g of all)
        if (pick(g)) {
          g.revoked = isoLocal();
          g.revoked_reason = reason;
          g.refresh = null;
          g.access = [];
          ended = true;
        }
      return ended;
    }),
  );
}

/** When an account goes away, so do its connections. */
export function revokeAppsOf(userId: string, reason = 'account removed'): void {
  revokeWhere((g) => g.user === userId, reason);
}

/**
 * A deleted account's or workspace's connections, gone from grants.json altogether (revoked first, so open streams ask
 * again): nothing of them is kept, not even revoked. Their tokens then name no grant and are refused like any unknown.
 */
export function forgetGrants(which: { user: string } | { workspace: string }): number {
  const pick = (g: Grant) => ('user' in which ? g.user === which.user : grantWorkspace(g) === which.workspace);
  if (!current().grants.some(pick)) return 0;
  revokeWhere(pick, 'user' in which ? 'account removed' : 'workspace deleted');
  return change((all) => {
    const before = all.length;
    for (let i = all.length - 1; i >= 0; i--) if (pick(all[i] as Grant)) all.splice(i, 1);
    return before - all.length;
  });
}

/** Disconnects a person's apps in one workspace (they left it): the others keep working. */
export function revokeAppsIn(userId: string, workspace: string): void {
  revokeWhere((g) => g.user === userId && grantWorkspace(g) === workspace, 'left the workspace');
}

/** The move to workspaces (lib/workspaces.ts): grants from before name workspace #1 outright. Idempotent. */
export function stampGrants(ws = 'w1'): number {
  if (!current().grants.some((g) => !g.workspace)) return 0;
  return change((all) => {
    let n = 0;
    for (const g of all)
      if (!g.workspace) {
        g.workspace = ws;
        n++;
      }
    return n;
  });
}
