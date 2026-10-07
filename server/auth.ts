// Who is asking: a signed session cookie (browser) or an API token (CLI, MCP, agents) — on a hosted server and on a
// person's own machine alike. On their own machine a request from the machine itself (loopback, no proxy headers) is
// its owner without signing in, and so is a phone that opened the LAN link (--lan). A hosted server's first account is
// made with the one-time setup token printed at start.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { voidLinks } from '../lib/accountLinks.ts';
import * as auth from '../lib/auth.ts';
import { AVATAR_FILE, AVATAR_LIMITS, avatarKey, people, removeAvatar, saveAvatar } from '../lib/avatars.ts';
import type { Config } from '../lib/config.ts';
import { wellFormed } from '../lib/names.ts';
import { afterNewPassword } from '../lib/newPassword.ts';
import { vrTokenName } from '../lib/oauth/clients.ts';
import { GrantError, listApps, redeemVrCode } from '../lib/oauth/store.ts';
import { isOperator } from '../lib/operator.ts';
import { can } from '../lib/permissions.ts';
import { forgetDevicesOf } from '../lib/push/index.ts';
import { addressKey, RateLimit } from '../lib/rateLimit.ts';
import { DEFAULT_WORKSPACE } from '../lib/scope.ts';
import { rootStorage } from '../lib/storage/index.ts';
import type { AuthStatus, MemberView, MyWorkspace } from '../lib/types.ts';
import * as workspaces from '../lib/workspaces.ts';
import { type AccountMail, describeDevice } from './accountMail.ts';
import { type Extension, gate, NO_EXTENSION } from './extension.ts';
import { fail, LanQuery, queryOr, router, sendInternal } from './http.ts';

export interface Auth {
  /** local: a request from the machine itself; lan: a phone with the LAN link's cookie; cookie / token: signed in. */
  via: 'local' | 'lan' | 'cookie' | 'token';
  /** Author name for notes. */
  name: string;
  /** The account's role in `workspace` (lib/workspaces.ts): what every permission check reads. */
  role: auth.Role;
  /** The account. */
  user: auth.User | null;
  /** The workspace this request works in: an API token's own, the session's current one, the machine's #1. */
  workspace: string;
  /** The session cookie again with a fresh "last active" (idle timeout), for the guard to send back. */
  refresh?: { value: string; maxAge: number };
  /** The request carries the session cookie under its old name (`vr_session`): `used` = its value when it is the
   * session this request is signed in with. Over https the guard moves it to `__Host-vr_session` (sessionUpdates). */
  oldName?: { used: string | null };
  /** via token: which one — MCP counts its open waits and listens per token (server/routes/mcp.ts), and a one-time upload
   * URL checks it again when used (server/uploadTickets.ts). */
  tokenId?: string;
  /** When this access ends by itself — a token's expiry, a session's hard or idle end (ms since the epoch); none: it
   * doesn't. What remembers a yes for a while (MCP's open streams) never remembers it past this. */
  until?: number;
  /** via cookie: when the person signed in with this session (ms; absent for a cookie from before it was kept). */
  signedIn?: number;
}

/** The session cookie's Set-Cookie value; Secure whenever the request or the public URL is https, and then named
 * `__Host-vr_session` (sessionName). */
export const sessionCookie = (value: string, maxAge: number, secure: boolean): string =>
  [`${sessionName(secure)}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`, ...(secure ? ['Secure'] : [])].join('; ');
/** A cookie of this name gone from the browser. */
const expired = (name: string, secure: boolean): string =>
  [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0', ...(secure ? ['Secure'] : [])].join('; ');

/**
 * What the guard sends back about the session a request came with: the cookie again with a fresh "last active" (idle
 * timeout), and over https the move from `vr_session` to `__Host-vr_session` — the same session under the new name,
 * the old one expired — so a browser signed in before keeps its session (A12 WEB-9).
 */
export function sessionUpdates(a: Auth | undefined, secure: boolean): string[] {
  if (a?.via !== 'cookie') return [];
  const moving = secure && !!a.oldName;
  const value = a.refresh?.value ?? (moving ? a.oldName?.used : null);
  // a moved session keeps its own end inside its claims: the browser may hold it as long as any session lasts
  const out = value ? [sessionCookie(value, a.refresh?.maxAge ?? auth.SESSION_DAYS * 86400, secure)] : [];
  if (moving) out.push(expired(COOKIE, true));
  return out;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: Auth;
  }
}

export const COOKIE = 'vr_session';
/**
 * The session cookie's name over https (A12 WEB-9): a browser takes a `__Host-` cookie only from this exact host,
 * Secure, for the whole site — a sibling subdomain can't set or overwrite it (session fixation). Over plain http (the
 * machine, a local test) browsers refuse the prefix, so the name stays `vr_session`.
 */
export const HOST_COOKIE = '__Host-vr_session';
export const sessionName = (secure: boolean): string => (secure ? HOST_COOKIE : COOKIE);
/** Remembers that this browser signed in to an account before (lib/auth.ts signDevice). */
const DEVICE_COOKIE = 'vr_device';
/** The invites one account may make in an hour, and revoke (A13 AUTH-1, VERIFY-3: invites.json is the whole server's). */
export const INVITES_PER_HOUR = 60;

export const cookieOf = (req: Request, name: string): string | null => {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
};

/** The session cookie a request carries, under either name (one signed in before this name came keeps `vr_session`). */
export const sessionOf = (req: Request): string | null => cookieOf(req, HOST_COOKIE) ?? cookieOf(req, COOKIE);

const bearer = (req: Request): string | null => /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1] || null;

const PROXY_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'cf-ray'];
const isLoopback = (ip: string) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
/**
 * A request from the machine itself. Anything that came through a proxy or the tunnel is remote, even though a
 * reverse proxy or cloudflared connects from localhost.
 */
export const isLocal = (req: Request): boolean => isLoopback(req.socket.remoteAddress || '') && !PROXY_HEADERS.some((h) => req.headers[h]);

/**
 * The OS account behind a loopback connection, from the kernel's TCP tables as Linux lists them (/proc/net/tcp and
 * tcp6: the connecting end's row — local port `peerPort`, remote port `ourPort`, established — and its uid column).
 * Null when it can't be told: no such row, no tables (macOS, Windows). Pure: the tables are given.
 */
export function peerUidFrom(tables: string[], peerPort: number, ourPort: number): number | null {
  const port = (addr: string | undefined) => Number.parseInt(addr?.split(':').at(-1) ?? '', 16);
  for (const table of tables)
    for (const line of table.split('\n')) {
      const f = line.trim().split(/\s+/);
      if (f.length < 8 || f[3] !== '01') continue;
      if (port(f[1]) !== peerPort || port(f[2]) !== ourPort) continue;
      const uid = Number(f[7]);
      if (Number.isInteger(uid) && uid >= 0) return uid;
    }
  return null;
}

const TCP_TABLES = ['/proc/net/tcp', '/proc/net/tcp6'];
// Asked once per connection: a kept-alive socket carries many requests.
const peerUids = new WeakMap<object, number | null>();
/** The account behind a loopback request, where the system says (Linux); null elsewhere or when it can't be told. */
function loopbackPeerUid(req: Request): number | null {
  const s = req.socket;
  if (!s || peerUids.has(s)) return s ? (peerUids.get(s) ?? null) : null;
  let uid: number | null = null;
  if (process.platform === 'linux' && s.remotePort && s.localPort) {
    const tables: string[] = [];
    for (const f of TCP_TABLES)
      try {
        tables.push(fs.readFileSync(f, 'utf8'));
      } catch {}
    uid = peerUidFrom(tables, s.remotePort, s.localPort);
  }
  peerUids.set(s, uid);
  return uid;
}

/**
 * The visitor behind a request that came through the machine's Cloudflare tunnel: cloudflared connects from loopback
 * for everyone, marks what it forwards with cf-ray and names the visitor in cf-connecting-ip. Null for anything else.
 * Only for the machine (its tunnel capability); a hosted server goes by its trust-proxy setting.
 */
export function tunnelVisitor(req: Request): string | null {
  if (!isLoopback(req.socket.remoteAddress || '') || !req.headers['cf-ray']) return null;
  const ip = String(req.headers['cf-connecting-ip'] || '').trim();
  return net.isIP(ip) ? ip : null;
}

/** A secret compared in constant time. */
export function sameToken(given: unknown, token: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The LAN link's cookie (set by the guard when a phone opens the QR link). */
export const LAN_COOKIE = 'vr_t';

export interface IdentifyOptions {
  /** The app runs on the person's own machine: a request from the machine itself is its owner. */
  machine: boolean;
  /** The LAN link's token (--lan): a device that opened the QR link is the owner too. */
  lanToken?: string | null;
  /** The OS account behind a loopback request, null when it can't be told (tests replace it; default: Linux's tables). */
  peerUid?: (req: Request) => number | null;
  /** This process's OS account (tests); null: the system has none to compare (Windows). */
  uid?: number | null;
}

/**
 * Who a request is from. `touch: false` asks again for a request already let in (an open stream: MCP waits and listens,
 * /api/events), which is no new use of its token: `last_used` stays.
 */
export type Identify = (req: Request, opts?: { touch?: boolean }) => Auth | null;

/**
 * Identifies the caller: an API token, else the session cookie, else — on the person's own machine — the machine's
 * owner for requests from the machine itself or a device with the LAN link. Never rejects. A token that doesn't check
 * out is nobody, even from the machine itself: whoever sent it meant to be someone else.
 */
export function createIdentify({ machine, lanToken = null, peerUid = loopbackPeerUid, uid = process.getuid?.() ?? null }: IdentifyOptions): Identify {
  // Another account on a shared machine reaches the same localhost port (A12 AGENT-9): where the system says who is
  // connecting, only this account (or root, which reads the store anyway) is the machine's owner. Where it can't tell
  // (macOS, Windows) every account on the machine is trusted, as SECURITY.md says.
  const ownAccount = (req: Request): boolean => {
    if (uid === null) return true;
    const peer = peerUid(req);
    return peer === null || peer === uid || peer === 0;
  };
  return (req, { touch = true } = {}) => {
    const token = bearer(req);
    if (token) {
      const hit = auth.verifyToken(token, { touch });
      if (!hit) return null;
      // A token acts in its own workspace, with the role its person has there now: one that left it is nobody.
      const workspace = auth.tokenWorkspace(hit.token);
      const role = workspaces.roleIn(workspace, hit.user.id);
      const until = hit.token.expires ? Date.parse(hit.token.expires) : Number.NaN;
      return role
        ? { via: 'token', name: hit.user.name, role, user: hit.user, workspace, tokenId: hit.token.id, ...(Number.isFinite(until) ? { until } : {}) }
        : null;
    }
    const host = cookieOf(req, HOST_COOKIE);
    const before = cookieOf(req, COOKIE);
    const cookie = host ?? before;
    const s = cookie ? auth.checkSession(cookie) : null;
    // a `vr_session` beside or instead of the new name: the guard moves or drops it over https (sessionUpdates)
    const oldName = before !== null ? { oldName: { used: host === null ? before : null } } : {};
    if (s) {
      // The workspace the session switched to while the person is still a member there, else where they work.
      const workspace = workspaces.sessionWorkspace(s.user.id, s.workspace);
      const role = workspace ? workspaces.roleIn(workspace, s.user.id) : null;
      // A sign-up held until its address is confirmed belongs to no workspace yet (server/signup.ts places it then): it
      // is signed in to confirm it — the permission table lets it reach nothing else — and works in none (''), so
      // anything that would touch a workspace is refused, never someone else's.
      if ((!workspace || !role) && auth.isGated(s.user))
        return {
          via: 'cookie',
          name: s.user.name,
          role: 'reviewer',
          user: s.user,
          workspace: '',
          until: s.until,
          ...(s.refresh ? { refresh: s.refresh } : {}),
          ...(s.signedIn ? { signedIn: s.signedIn } : {}),
          ...oldName,
        };
      if (!workspace || !role) return null;
      return {
        via: 'cookie',
        name: s.user.name,
        role,
        user: s.user,
        workspace,
        until: s.until,
        ...(s.refresh ? { refresh: s.refresh } : {}),
        ...(s.signedIn ? { signedIn: s.signedIn } : {}),
        ...oldName,
      };
    }
    if (!machine) return null;
    // The LAN link's cookie, or the link itself on the first request (the guard sets the cookie on the way).
    const lan = !!lanToken && (sameToken(cookieOf(req, LAN_COOKIE), lanToken) || sameToken(queryOr(LanQuery, req)?.t, lanToken));
    if (!lan && (!isLocal(req) || !ownAccount(req))) return null;
    // The machine's owner owns workspace #1, the only one a machine has.
    const owner = auth.localOwner();
    return owner ? { via: lan ? 'lan' : 'local', name: owner.name, role: owner.role, user: owner, workspace: DEFAULT_WORKSPACE } : null;
  };
}

/** A hosted server's identify (tests and tools that only know tokens and cookies). */
export const identify: Identify = createIdentify({ machine: false });

export function requireUser(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth) throw fail(401, 'please sign in');
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth) throw fail(401, 'please sign in');
  if (!can(req.auth.role, 'admin')) throw fail(403, 'only admins can do that');
  next();
}

/**
 * The author for a write: agents may label themselves ("agent:reels-2") so their notes read as agent notes; everyone
 * else writes as themselves. Reviewers can't: their notes must never pass for an agent's.
 */
export function actor(req: Request, by?: string | null): string {
  if (!req.auth) throw fail(401, 'please sign in');
  if (by && /^agent:[\w.@ -]{1,80}$/.test(by) && can(req.auth.role, 'agents')) return by;
  return req.auth.name;
}

// ---------------------------------------------------------------- routes

const Email = z.string().max(254);
const Password = z.string().max(1024);
const RoleSchema = z.enum(['owner', 'admin', 'member', 'reviewer']);
const Setup = z.object({ token: z.string(), email: Email, name: z.string().max(80), password: Password });
const Login = z.object({ email: Email, password: Password });
// Days a new API token works; without it, until revoked.
const TokenDays = z.number().int().min(1).max(3650).optional();
const WorkspaceId = z.string().regex(workspaces.WORKSPACE_ID, 'not a workspace id');
const TokenLogin = Login.extend({ name: z.string().max(80).optional(), days: TokenDays, workspace: WorkspaceId.optional() });
// `vr login` from the browser: the one-time code its loopback listener got, the PKCE verifier and where the code went.
const CodeLogin = z
  .object({
    code: z.string().min(1).max(200),
    code_verifier: z.string().min(43).max(128),
    redirect_uri: z.string().max(200),
  })
  .strict();
const NewToken = z.object({ name: z.string().max(80).optional(), days: TokenDays });
const AvatarBody = z
  .object({
    data: z
      .string()
      .min(1)
      .max(Math.ceil(AVATAR_LIMITS.bytes / 3) * 4 + 4),
  })
  .strict();

const MePatch = z.object({
  name: z.string().max(80).optional(),
  email: Email.optional(),
  password: Password.optional(),
  current_password: Password.optional(),
  prefs: z
    .object({
      theme: z.enum(['light', 'dark', 'system']).optional(),
      lang: z.enum(['en', 'de', 'auto']).optional(),
      // [] is Automatic (any language, detected); null goes back to the server's list
      voice_languages: z
        .array(z.string().regex(/^[a-z]{2}$/))
        .max(8)
        .nullable()
        .optional(),
      // On the machine: sending something to an agent that isn't running asks, starts it, or only sends.
      wake: z.enum(['ask', 'start', 'send']).optional(),
      // An email when the account signs in from a browser or `vr` it hasn't seen.
      signin_alerts: z.boolean().optional(),
    })
    .strict()
    .optional(),
  // The language the page was in: emails this change sends speak it unless the account chose one.
  lang: z.enum(['en', 'de']).optional(),
});
const Lang = z.enum(['en', 'de']).optional();
const NewUser = z.object({ email: Email, name: z.string().max(80), password: Password, role: RoleSchema.default('member'), lang: Lang });
const NewInvite = z.object({
  role: RoleSchema.default('member'),
  name: z.string().max(80).nullish(),
  email: Email.nullish(),
  days: z.number().int().min(1).max(90).optional(),
  // Email it to `email` too (the link is made either way).
  send: z.boolean().optional(),
  lang: Lang,
});
const InviteSend = z.object({ lang: Lang });
const InviteToken = z.object({ token: z.string().max(200) });
const InviteAccept = InviteToken.extend({ name: z.string().max(80), email: Email, password: Password, lang: Lang });
const UserPatch = z.object({
  name: z.string().max(80).optional(),
  email: Email.optional(),
  role: RoleSchema.optional(),
  disabled: z.boolean().optional(),
  password: Password.optional(),
  /** Your own password or address through this route needs your current password, as in Profile. */
  current_password: z.string().max(1024).optional(),
});

// well-formed like every body (server/http.ts parse): a name kept with a lone surrogate breaks every URL built from it
const parse = <S extends z.ZodType>(schema: S, value: unknown): z.output<S> => {
  const r = schema.safeParse(wellFormed(value ?? {}));
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw fail(400, `invalid body: ${issue?.path.length ? `${issue.path.join('.')}: ` : ''}${issue?.message || 'malformed'}`);
};

// Errors from lib/auth.ts and lib/workspaces.ts are the user's fault (taken name, short password, the last owner): a
// 4xx with the message (workspaces say which).
const statusOf = (e: unknown) => (e instanceof workspaces.WorkspaceError || e instanceof auth.TooManyInvitesError ? e.status : 400);
const userError = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    throw fail(statusOf(e), (e as Error).message);
  }
};
const userErrorAsync = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    throw fail(statusOf(e), (e as Error).message);
  }
};

/** The account as this request's workspace sees it: its role there (an account's own `role` is workspace #1's). */
export const userIn = (u: auth.User, workspace: string, role?: auth.Role | null): auth.PublicUser => {
  // disabled here by this workspace's admins (a suspended membership: the account itself goes on elsewhere)
  const suspended = u.disabled ? null : workspaces.suspendedIn(workspace, u.id);
  return {
    ...auth.publicUser(u),
    role: role ?? workspaces.roleIn(workspace, u.id) ?? workspaces.membersOf(workspace).find((m) => m.user === u.id)?.role ?? u.role,
    ...(suspended ? { disabled: suspended } : {}),
  };
};

/**
 * Someone as a workspace's admins see them (A13 PEOPLE-3): who they are and their role here — never what the account
 * keeps for itself (its prefs carry other workspaces' ids and dates, its first runs and a sign-up's plan; a new address
 * waits for its link; its sign-ins), which is for `/api/auth/me` alone.
 */
export const memberView = (u: auth.User, workspace: string, role?: auth.Role | null): MemberView => {
  const seen = userIn(u, workspace, role);
  return {
    id: seen.id,
    email: seen.email,
    name: seen.name,
    role: seen.role,
    created: seen.created,
    ...(seen.disabled ? { disabled: seen.disabled } : {}),
    ...(seen.avatar ? { avatar: seen.avatar } : {}),
    ...(seen.unverified ? { unverified: seen.unverified } : {}),
  };
};

/**
 * The workspaces a request is told of: the person's, for the switcher — an API token's only its own. A token acts in one
 * workspace, and an agent given one for a client must not learn the names and sizes of the person's other clients'
 * (A12 WS-10).
 */
export function shownWorkspaces(a: Pick<Auth, 'user' | 'workspace'> & Partial<Pick<Auth, 'via'>>): MyWorkspace[] {
  if (!a.user) return [];
  const mine = workspaces.myWorkspaces(a.user.id, a.workspace);
  return a.via === 'token' ? mine.filter((w) => w.current) : mine;
}

/** What the app shell is told about where it works: the current workspace and the others the account belongs to. */
export function workspaceFacts(a: Pick<Auth, 'user' | 'workspace'> & Partial<Pick<Auth, 'via'>>): Pick<AuthStatus, 'workspace' | 'workspaces'> {
  if (!a.user) return {};
  const mine = shownWorkspaces(a);
  const current = mine.find((w) => w.current);
  return { ...(current ? { workspace: current } : {}), workspaces: mine };
}

export interface AuthRoutesOptions {
  cfg: Config;
  /** One-time token printed at startup while no account exists; null afterwards. */
  setupToken: () => string | null;
  setupDone: () => void;
  /** What a plan may limit (server/extension.ts): a new member. None on a self-hosted server. */
  extension?: () => Extension;
  /** The emails accounts get (invites, notices, sign-in alerts, confirming a new address). */
  accountMail: AccountMail;
  /** The setup page made the server's first account (the first run's sample comes next: server/firstSample.ts). */
  onSetup?: (user: auth.User) => void;
}

/** Signing a browser in and out: the session cookie (and the device cookie that says it signed in here before). */
export function sessionCookies(cfg: Config) {
  const secure = (req: Request) => req.secure || !!cfg.public_url?.startsWith('https:');
  const cookie = (req: Request, name: string, value: string, maxAge: number) =>
    [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`, ...(secure(req) ? ['Secure'] : [])].join('; ');
  return {
    /** `workspace`: where the session works (absent: where the person works, lib/workspaces.ts sessionWorkspace). */
    set(req: Request, res: Response, user: auth.User, workspace?: string | null): void {
      // every new session is a sign-in (the operator's accounts page shows the last one)
      auth.noteSignIn(user.id);
      res.setHeader('Set-Cookie', [
        cookie(req, sessionName(secure(req)), auth.signSession(user, auth.SESSION_DAYS, workspace ?? undefined), auth.SESSION_DAYS * 86400),
        cookie(req, DEVICE_COOKIE, auth.signDevice(user), auth.DEVICE_DAYS * 86400),
        // over https the session's old name goes (sessionName)
        ...(secure(req) && cookieOf(req, COOKIE) !== null ? [cookie(req, COOKIE, '', 0)] : []),
      ]);
    },
    /** The session cookie gone, under both names. */
    clear: (req: Request, res: Response) =>
      res.setHeader('Set-Cookie', [cookie(req, COOKIE, '', 0), ...(secure(req) ? [cookie(req, HOST_COOKIE, '', 0)] : [])]),
    /** Whether this browser signed in to the account before (its device cookie names it). */
    known: (req: Request, user: auth.User) => auth.deviceAccount(cookieOf(req, DEVICE_COOKIE)) === user.id,
    /**
     * The browser that signed up or took an invite (`vr_signup`, 24 hours like the confirm link it goes with; only
     * /api/auth reads it): every such answer sets one, so it tells nothing; a held account made then keeps its sha256,
     * and its confirm link signs in this browser only (login CSRF).
     */
    signup: (req: Request, res: Response, value: string, maxAge: number) =>
      res.append('Set-Cookie', cookie(req, SIGNUP_COOKIE, value, maxAge).replace('Path=/', 'Path=/api/auth')),
    /**
     * This browser's mark: the one it has when it is one of ours (24 random bytes), so a second sign-up or invite here
     * keeps the first's confirm link signing this browser in (A12-D14); else a new one. A value of any other shape is
     * never kept — a page can't hand a browser a mark it chose.
     */
    mark: (req: Request): string => {
      const v = cookieOf(req, SIGNUP_COOKIE);
      return v && /^[A-Za-z0-9_-]{32}$/.test(v) ? v : crypto.randomBytes(24).toString('base64url');
    },
    /** Whether this request comes from the browser a held account was made in. */
    signedUpHere: (req: Request, user: auth.User): boolean => {
      const v = cookieOf(req, SIGNUP_COOKIE);
      if (!v || !user.signup_browser) return false;
      const a = Buffer.from(sha256(v));
      const b = Buffer.from(user.signup_browser);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },
  };
}

/**
 * What a browser is told to drop when it signs out everywhere or resets the password (someone else may have had the
 * account): the HTTP cache (renders and pictures are cached as immutable) and its storage (IndexedDB, localStorage,
 * service workers — and with them a push subscription). Never its cookies: a reset signs the browser in.
 */
export const CLEAR_SITE_DATA = '"cache", "storage"';

/** See sessionCookies().signup. */
export const SIGNUP_COOKIE = 'vr_signup';
export const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

export function authRoutes({ cfg, setupToken, setupDone, extension = () => NO_EXTENSION, accountMail, onSetup }: AuthRoutesOptions): Router {
  const r = router();
  // A new member is what a plan may limit (a 402 with its sentence); signing in, roles and removing never are.
  const memberGate = gate(extension, 'member');
  // Failed sign-ins, three ways: one address trying many accounts, one address guessing one account, and one account
  // guessed from everywhere. The last one never stops a browser that signed in to the account before, so nobody can
  // lock a person out of their own account by guessing wrong on purpose — but such a browser isn't free to guess
  // either: its device cookie (which a copy carries to any address) has a budget of its own, and the account a looser
  // ceiling for all its known browsers together (AUTH-5). Attempts without that cookie always count against the
  // account's limit, from wherever they come.
  const WINDOW = 15 * 60000;
  const byIp = new RateLimit(20, WINDOW);
  const byAccountAndIp = new RateLimit(8, WINDOW);
  const byAccount = new RateLimit(30, WINDOW);
  const byDevice = new RateLimit(10, WINDOW);
  const byKnownBrowsers = new RateLimit(60, WINDOW);
  // Successful ones too, per account and per address: each is a session, and each sign-out an id the server keeps until
  // that session would have ended (lib/auth.ts revokeSession). A browser that signed in before is not exempt here.
  const HOUR = 60 * 60000;
  const signInsByAccount = new RateLimit(30, HOUR);
  const signInsByIp = new RateLimit(30, HOUR);
  // Codes `vr login` brings back from the browser, per address: each one random and one-time, so a handful is plenty.
  const vrCodes = new RateLimit(30, WINDOW);
  const cookies = sessionCookies(cfg);
  const setCookie = cookies.set;
  const clearCookie = cookies.clear;
  // What only the person does, in the app — never an API token (an agent, a script, a leaked token): making more tokens
  // (a short-lived one could mint a lasting one), signing every session out, changing a password or an address. The
  // routes for it are listed in server/permissions.ts PERSON_ONLY; this says it where the body decides.
  const person = (req: Request, what: string) => {
    if (req.auth?.via === 'token') throw fail(403, `${what} signed in, in the app: not with an API token`);
  };
  // A sign-in from a browser (or a `vr`) the account hasn't used before: an email when the person asked for those.
  const alert = (user: auth.User, device: string) => {
    if (user.prefs?.signin_alerts) accountMail.newSignIn(user, device);
  };
  /** Where a person who just signed in works: the workspace they last used here if still theirs, else their first. */
  const signedInto = (req: Request, user: auth.User): string => {
    const before = sessionOf(req);
    const named = before ? auth.checkSession(before)?.workspace : null;
    const ws = workspaces.sessionWorkspace(user.id, named);
    // held until its address is confirmed: no workspace yet, and none needed to confirm it
    if (!ws && auth.isGated(user)) return '';
    if (!ws) throw fail(403, 'this account is not in any workspace any more: ask a workspace owner to invite you');
    return ws;
  };

  // Throttled password check shared by the browser login and `vr login`.
  async function checkLogin(req: Request, email: string, password: string): Promise<auth.User> {
    const ip = addressKey(req.ip || 'unknown');
    const account = auth.emailKey(email);
    const pair = `${account}\n${ip}`;
    const user = auth.findUserByEmail(email);
    // A browser that signed in to this account before: which one (each sign-in mints its own cookie).
    const deviceCookie = cookieOf(req, DEVICE_COOKIE);
    const device = user && deviceCookie && auth.deviceAccount(deviceCookie) === user.id ? `${account}\n${sha256(deviceCookie)}` : null;
    const accountWait = device ? Math.max(byDevice.retryAfter(device), byKnownBrowsers.retryAfter(account)) : byAccount.retryAfter(account);
    const wait = Math.max(byIp.retryAfter(ip), byAccountAndIp.retryAfter(pair), accountWait);
    if (wait) {
      throw Object.assign(fail(429, `too many sign-in attempts, try again in ${Math.ceil(wait / 60)} min`), { retryAfter: wait });
    }
    const ok = await auth.verifyPassword(password, user?.password || (await auth.dummyHash()));
    // The account as it is now that the check is done: one deleted, disabled or given a new password meanwhile is
    // answered like an address without an account — no session, no token, no mail for what is gone.
    const now = ok && user ? auth.findUserByEmail(email) : null;
    const same = now && user && now.id === user.id && now.password === user.password && !now.disabled ? now : null;
    if (!same) {
      byIp.hit(ip);
      byAccountAndIp.hit(pair);
      byAccount.hit(account);
      if (device) {
        byDevice.hit(device);
        byKnownBrowsers.hit(account);
      }
      throw fail(401, 'wrong email or password');
    }
    byAccountAndIp.reset(pair);
    const busy = Math.max(signInsByAccount.retryAfter(same.id), signInsByIp.retryAfter(ip));
    if (busy) throw Object.assign(fail(429, `too many sign-ins, try again in ${Math.ceil(busy / 60)} min`), { retryAfter: busy });
    signInsByAccount.hit(same.id);
    signInsByIp.hit(ip);
    return same;
  }

  r.get('/api/auth/status', (req, res) => {
    const a = req.auth;
    const out: AuthStatus = {
      mode: cfg.mode,
      setup: cfg.mode === 'server' && !auth.hasUsers(),
      user: a?.user ? userIn(a.user, a.workspace, a.role) : null,
      via: a?.via || null,
      ...(a ? workspaceFacts(a) : {}),
      // what the account menu offers ("New workspace…", with one workspace too): the rule POST /api/workspaces keeps
      ...(a?.user && a.via === 'cookie' && cfg.mode === 'server' && workspaces.mayCreateWorkspace(a.user.id, cfg) ? { workspace_create: true } : {}),
      // the server's operator (lib/operator.ts): the account menu's way to the operator pages, for them alone
      ...(a?.user && a.via === 'cookie' && isOperator(cfg, a.user.id) ? { operator: true } : {}),
    };
    res.json(out);
  });

  r.post('/api/auth/setup', express.json(), async (req, res) => {
    const b = parse(Setup, req.body);
    const expected = setupToken();
    if (!expected || auth.hasUsers()) throw fail(409, 'setup is already done');
    const a = Buffer.from(b.token.trim());
    const want = Buffer.from(expected);
    if (a.length !== want.length || !crypto.timingSafeEqual(a, want)) throw fail(403, 'wrong setup token (see the server log)');
    // The first account owns workspace #1.
    const user = await userErrorAsync(() =>
      workspaces.createAccountIn(DEFAULT_WORKSPACE, { email: b.email, name: b.name, password: b.password, role: 'owner' }),
    );
    setupDone();
    onSetup?.(user);
    setCookie(req, res, user, DEFAULT_WORKSPACE);
    res.json({ user: userIn(user, DEFAULT_WORKSPACE), ...workspaceFacts({ user, workspace: DEFAULT_WORKSPACE }) });
  });

  r.post('/api/auth/login', express.json(), async (req, res) => {
    const b = parse(Login, req.body);
    const user = await checkLogin(req, b.email, b.password);
    const ws = signedInto(req, user);
    if (!cookies.known(req, user)) alert(user, describeDevice(req.headers['user-agent'], accountMail.langOf(user)));
    setCookie(req, res, user, ws);
    // Where the session works and the person's other workspaces, as /api/auth/status says them.
    res.json({ user: userIn(user, ws), ...workspaceFacts({ user, workspace: ws }) });
  });

  // `vr login`: email + password → a named API token (no cookie); or, from the browser, the code the person allowed on
  // the consent screen (server/routes/oauth.ts, client `vr`) + its PKCE verifier → the same token, named after the machine.
  r.post('/api/auth/token', express.json(), async (req, res) => {
    if (req.body && typeof req.body === 'object' && 'code' in req.body) return codeLogin(req, res);
    const b = parse(TokenLogin, req.body);
    const user = await checkLogin(req, b.email, b.password);
    // A sign-up that isn't confirmed can do nothing yet; a token would only be a way around that.
    if (auth.isGated(user)) throw fail(403, 'confirm your email address first: the link is in your inbox');
    // The token acts in the workspace asked for (vr login --workspace), else where the person works.
    const ws = b.workspace ?? workspaces.homeWorkspace(user.id);
    if (!ws || !workspaces.roleIn(ws, user.id))
      throw fail(403, b.workspace ? 'you are not a member of that workspace' : 'this account is not in any workspace any more');
    const { token, info } = auth.createToken(user.id, b.name || 'vr login', { days: b.days, ...(ws !== DEFAULT_WORKSPACE ? { workspace: ws } : {}) });
    auth.noteSignIn(user.id);
    alert(user, b.name || 'vr login');
    // `several`: the person (who just gave their password) works in more than one: `vr login` names the token's.
    res.json({ token, info: auth.publicToken(info), user: userIn(user, ws), several: workspaces.workspacesOf(user.id).length > 1 });
  });

  function codeLogin(req: Request, res: Response): void {
    const ip = addressKey(req.ip || 'unknown');
    const wait = vrCodes.retryAfter(ip);
    if (wait) throw Object.assign(fail(429, `too many sign-in attempts, try again in ${Math.ceil(wait / 60)} min`), { retryAfter: wait });
    vrCodes.hit(ip);
    const b = parse(CodeLogin, req.body);
    let made: { token: string; info: auth.ApiToken; user: auth.User; workspace: string };
    try {
      made = redeemVrCode(b, ({ user, workspace, machine, days }) => {
        if (auth.isGated(user)) throw fail(403, 'confirm your email address first: the link is in your inbox');
        // the workspace the consent screen named, still the person's
        if (!workspaces.roleIn(workspace, user.id)) throw fail(403, 'you are not a member of that workspace any more');
        const name = vrTokenName(machine);
        return { ...auth.createToken(user.id, name, { days, ...(workspace !== DEFAULT_WORKSPACE ? { workspace } : {}) }), user, workspace };
      });
    } catch (e) {
      if (e instanceof GrantError) throw fail(400, e.message);
      throw e;
    }
    alert(made.user, made.info.name);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      token: made.token,
      info: auth.publicToken(made.info),
      user: userIn(made.user, made.workspace),
      several: workspaces.workspacesOf(made.user.id).length > 1,
    });
  }

  r.post('/api/auth/logout', (req, res) => {
    // Ends the session on the server too: a copy of this cookie stops working, the person's other devices don't.
    for (const cookie of [cookieOf(req, HOST_COOKIE), cookieOf(req, COOKIE)]) if (cookie) auth.revokeSession(cookie);
    clearCookie(req, res);
    res.json({ ok: true });
  });

  r.post('/api/auth/logout-everywhere', requireUser, (req, res) => {
    person(req, 'signing out everywhere');
    const user = req.auth?.user;
    if (user) {
      auth.signOutEverywhere(user.id);
      // Its devices stop hearing from the server too (push carries note texts to lock screens).
      forgetDevicesOf(user.id);
    }
    clearCookie(req, res);
    // And this browser keeps nothing of the account: no cached answers, no stored library, no service worker (and so no
    // push subscription) — the page clears what it can too (WEB-2), this reaches what it can't.
    res.setHeader('Clear-Site-Data', CLEAR_SITE_DATA);
    res.json({ ok: true });
  });

  r.get('/api/auth/me', requireUser, (req, res) => {
    const a = req.auth as Auth;
    res.json({ user: a.user ? userIn(a.user, a.workspace, a.role) : null, name: a.name, role: a.role, via: a.via, mode: cfg.mode, ...workspaceFacts(a) });
  });

  /**
   * Your own password or address, by one set of rules wherever it is asked (Profile, and the admin route on yourself):
   * a person's, in the app, never an API token's (server/permissions.ts); your current password first — except the
   * machine owner's very first password and address, set at the machine itself, never from a phone that merely holds
   * the LAN link (the link would become a lasting credential). A held sign-up keeps its address. A new address waits for
   * the link mailed to it (when this server can email): until then the account keeps signing in with the old one, a typo
   * locks nobody out, and the answer is the same whether another account has the address or not.
   */
  async function ownCredentials(req: Request, me: auth.User, b: { email?: string; password?: string; current_password?: string }) {
    const first = !me.password && req.auth?.via === 'local';
    const newEmail = b.email !== undefined && !auth.sameEmail(me.email, b.email) ? b.email : undefined;
    if (newEmail !== undefined && auth.isGated(me)) throw fail(403, auth.HELD_ADDRESS);
    if (b.password !== undefined || newEmail !== undefined) {
      person(req, 'a password or an email address is changed');
      if (!first && !(b.current_password && (await auth.verifyPassword(b.current_password, me.password)))) throw fail(403, 'current password is wrong');
    }
    const pending = newEmail !== undefined && accountMail.enabled && !first;
    if (pending) {
      // Each new address is emailed: a few an hour per account (a typo, then the right one), within the account's share
      // of the server's mail (lib/mail) — hundreds of changes once pushed everyone's password resets past their links.
      const wait = Math.max(addressChanges.retryAfter(me.id), accountMail.accountWait(me.id));
      if (wait) throw Object.assign(fail(429, `too many address changes for now: try again in ${Math.ceil(wait / 60)} min`), { retryAfter: wait });
      addressChanges.hit(me.id);
      userError(() => auth.setPendingEmail(me.id, newEmail as string));
    }
    return { first, pending, email: pending ? undefined : newEmail, password: b.password };
  }
  type Own = Awaited<ReturnType<typeof ownCredentials>>;
  /** What follows a change ownCredentials let through, once it is saved: the new address's link, this session, notices. */
  function afterOwnChange(req: Request, res: Response, user: auth.User, own: Own, lang?: string) {
    // (Not to an address another account keeps: the answer is the same, and nobody's inbox gets someone else's link. A
    // sign-up nobody confirmed keeps none: the link lets that inbox decide — A12 INV-REV-11.)
    if (own.pending && !auth.addressKept(user.pending_email as string)) accountMail.verify(user, user.pending_email as string, accountMail.langOf(user, lang));
    if (own.password !== undefined) {
      // A password change signs out other sessions; keep this one (in the workspace it works in). Any reset link still
      // out stops working.
      const a = req.auth as Auth;
      if (a.via === 'cookie') setCookie(req, res, user, a.workspace);
      voidLinks(user.id, 'reset');
      afterNewPassword(user.id);
      if (!own.first) accountMail.passwordChanged(user);
    }
  }
  /** With workspaces a name only has to differ from the people of the workspaces its account works in. */
  const nameFreeFor = (user: auth.User, name: string) => {
    const n = userError(() => auth.checkName(name));
    if (workspaces.workspacesOf(user.id, { suspended: true }).some(({ workspace }) => workspaces.nameTaken(workspace.id, n, user.id)))
      throw fail(400, `the name "${n}" is taken`);
  };

  r.patch('/api/auth/me', express.json(), requireUser, async (req, res) => {
    const me = req.auth?.user;
    if (!me) throw fail(401, 'please sign in');
    const b = parse(MePatch, req.body);
    const own = await ownCredentials(req, me, b);
    const a = req.auth as Auth;
    // With workspaces a name differs from the people of the account's workspaces; an account in none yet (held) is told
    // apart when it joins one (placeSignup) — never checked across the server, which would tell it the names of other
    // teams' people (A12 INV-REV-5). A store without workspaces is one team: told apart from everyone, as always.
    const migrated = workspaces.isMigrated();
    if (migrated && b.name !== undefined) nameFreeFor(me, b.name);
    const user = await userErrorAsync(() =>
      auth.updateUser(me.id, { name: b.name, email: own.email, password: own.password, prefs: b.prefs }, { memberships: migrated }),
    );
    afterOwnChange(req, res, user, own, b.lang);
    res.json({ user: userIn(user, a.workspace) });
  });

  // A profile picture: sent inline (base64), cut to its centre square and stored (lib/avatars.ts).
  r.put('/api/auth/me/avatar', express.json({ limit: '12mb' }), requireUser, async (req, res) => {
    const me = req.auth?.user;
    if (!me) throw fail(401, 'please sign in');
    const { data } = parse(AvatarBody, req.body);
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length) throw fail(400, 'data is empty or not base64');
    if (bytes.length > AVATAR_LIMITS.bytes) throw fail(413, `a profile picture may be at most ${AVATAR_LIMITS.bytes / 1024 / 1024} MB`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-avatar-in-'));
    try {
      const file = path.join(dir, 'picture');
      fs.writeFileSync(file, bytes);
      const user = await userErrorAsync(() => saveAvatar(me.id, file));
      res.json({ user: userIn(user, (req.auth as Auth).workspace) });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  r.delete('/api/auth/me/avatar', requireUser, async (req, res) => {
    const me = req.auth?.user;
    if (!me) throw fail(401, 'please sign in');
    res.json({ user: userIn(await removeAvatar(me.id), (req.auth as Auth).workspace) });
  });

  // The team's pictures, for avatars beside notes and replies (by the name notes carry). Signed-in only: review links
  // show initials.
  r.get('/api/people', requireUser, (req, res) => {
    // The people of this workspace only: another team's names and faces are nobody's business here.
    const ids = new Set(workspaces.membersOf((req.auth as Auth).workspace).map((m) => m.user));
    res.json({ people: people((u) => ids.has(u.id)) });
  });

  r.get('/api/avatars/:file', requireUser, async (req, res) => {
    const file = req.params.file as string;
    // Only pictures of this workspace's people (an account's picture is its own; another team's stay theirs).
    const ids = new Set(workspaces.membersOf((req.auth as Auth).workspace).map((m) => m.user));
    if (!AVATAR_FILE.test(file) || !auth.listUsers().some((u) => u.avatar === file && ids.has(u.id))) throw fail(404, 'not found');
    const local = await rootStorage().ensureLocal(avatarKey(file));
    if (!local) throw fail(404, 'not found');
    // The name changes with the picture, so a copy never goes stale.
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    // our own store's file, which may sit under a dot folder (~/.video-review): sendInternal allows that
    sendInternal(res.type('image/jpeg'), local);
  });

  // ---------------------------------------------------------------- own API tokens

  // Your tokens for the workspace you work in now: a token acts in one workspace.
  const inThis = (req: Request) => (t: auth.ApiToken) => auth.tokenWorkspace(t) === (req.auth as Auth).workspace;
  r.get('/api/auth/tokens', requireUser, (req, res) => {
    const me = req.auth?.user;
    res.json({ tokens: me ? auth.listTokens(me.id).filter(inThis(req)).map(auth.publicToken) : [] });
  });

  r.post('/api/auth/tokens', express.json(), requireUser, (req, res) => {
    person(req, 'new API tokens are made');
    const me = req.auth?.user;
    if (!me) throw fail(401, 'please sign in');
    const b = parse(NewToken, req.body);
    const ws = (req.auth as Auth).workspace;
    const { token, info } = auth.createToken(me.id, b.name || 'token', { days: b.days, ...(ws !== DEFAULT_WORKSPACE ? { workspace: ws } : {}) });
    res.json({ token, info: auth.publicToken(info) });
  });

  r.delete('/api/auth/tokens/:id', requireUser, (req, res) => {
    const me = req.auth?.user;
    if (!me) throw fail(401, 'please sign in');
    res.json({ ok: auth.revokeToken(req.params.id as string, me.id, (req.auth as Auth).workspace) });
  });

  // ---------------------------------------------------------------- admin

  // Admins manage members and admins; owners are managed by owners only — in the workspace the request works in.
  const mayManage = (req: Request, target: auth.User | null, role?: auth.Role) => {
    const mine = req.auth?.role;
    if (mine === 'owner') return;
    const theirs = target ? workspaces.roleIn((req.auth as Auth).workspace, target.id) : null;
    if (theirs === 'owner' || role === 'owner') throw fail(403, 'only owners can manage owners');
  };
  /** A member of this request's workspace; anyone else is no such user here (another team's people stay unseen). */
  const memberOf = (req: Request, id: string): auth.User => {
    const ws = (req.auth as Auth).workspace;
    const u = auth.getUser(id);
    if (!u || !workspaces.membersOf(ws).some((m) => m.user === u.id)) throw fail(404, 'no such user');
    return u;
  };

  r.get('/api/admin/users', requireAdmin, (req, res) => {
    // The members of this workspace, each with their role here and their tokens and apps for it.
    const ws = (req.auth as Auth).workspace;
    const tokens = auth.listTokens().filter((t) => auth.tokenWorkspace(t) === ws);
    const apps = listApps(undefined, ws);
    const members = workspaces.membersOf(ws);
    res.json({
      users: members.flatMap((m) => {
        const u = auth.getUser(m.user);
        if (!u) return [];
        return [{ ...memberView(u, ws, m.role), tokens: tokens.filter((t) => t.user === u.id).length, apps: apps.filter((a) => a.user === u.id).length }];
      }),
    });
  });

  /**
   * A workspace's invites are emailed out of its own share of the server's hourly mail (lib/mail): over it, the answer
   * says so — before anything is made — and when to try again (A12: one workspace used up everyone's budget).
   */
  const mailRoom = (ws: string, account: string | undefined): void => {
    const team = accountMail.workspaceWait(ws);
    const own = account ? accountMail.accountWait(account) : 0;
    const wait = Math.max(team, own);
    if (wait)
      throw Object.assign(
        fail(
          429,
          `${team ? 'this workspace has' : 'you have'} emailed all the invites ${team ? 'it' : 'you'} may for this hour: make the invite without emailing it and copy its link, or try again in ${Math.ceil(wait / 60)} min`,
        ),
        { retryAfter: wait },
      );
  };
  // An address change emails the new address: a few an hour per account (a typo, then the right one), and within the
  // account's share of the server's mail (lib/mail).
  const addressChanges = new RateLimit(5, 3600_000);
  // Invites one account makes in an hour, emailed or not, and revokes (keyed by account id): each rewrites invites.json.
  const invitesMade = new RateLimit(INVITES_PER_HOUR, 3600_000);
  const invitesRevoked = new RateLimit(INVITES_PER_HOUR, 3600_000);

  r.post('/api/admin/users', express.json(), requireAdmin, memberGate, async (req, res) => {
    const { lang, ...b } = parse(NewUser, req.body);
    mayManage(req, null, b.role);
    const me = req.auth as Auth;
    const ws = me.workspace;
    if (workspaces.isMigrated()) {
      if (accountMail.enabled) mailRoom(ws, me.user?.id);
      // A server with workspaces: whoever runs one may be anyone (VR_WORKSPACE_CREATE), so nobody makes an account — a
      // password, a confirmed address — for someone else's address. The address gets an invite into this workspace
      // instead (its link makes the account with the person's own password, or adds the account they have), sent with
      // fixed words: the same answer whatever the address, so nothing tells whether it has an account on this server.
      const { token, invite } = userError(() =>
        auth.createInvite({
          role: b.role,
          name: b.name,
          email: b.email,
          by: { id: me.user?.id || 'local', name: me.name },
          ...(ws !== DEFAULT_WORKSPACE ? { workspace: ws } : {}),
          isMember: (u) => !!workspaces.roleIn(ws, u.id),
        }),
      );
      const sent = accountMail.invite(invite, token, accountMail.langOf(me.user, lang), me.user?.id);
      res.json({ invite: (sent && auth.markInviteSent(invite.id)) || invite, url: inviteUrl(req, token), sent });
      return;
    }
    // One team on the server (no workspaces): its admins vouch for the people they add, as always.
    const user = await userErrorAsync(() => workspaces.createAccountIn(ws, b));
    res.json({ user: memberView(user, ws) });
  });

  r.patch('/api/admin/users/:id', express.json(), requireAdmin, async (req, res) => {
    const target = memberOf(req, req.params.id as string);
    const { current_password, ...patch } = parse(UserPatch, req.body);
    mayManage(req, target, patch.role);
    // Your own password or address: Profile's rules exactly (ownCredentials) — never a token (PERSON_ONLY), your current
    // password, the first one at the machine only, a new address through its link. Someone else's is an admin's below.
    const self = target.id === req.auth?.user?.id;
    const own = self ? await ownCredentials(req, target, { email: patch.email, password: patch.password, current_password }) : null;
    const b = own ? { ...patch, email: own.email, password: own.password } : patch;
    const newEmail = b.email !== undefined && !auth.sameEmail(target.email, b.email);
    const ws = (req.auth as Auth).workspace;
    // The person hears what was done to their account, at the address they had (confirmed addresses only).
    // (`notice`: the account was disabled — a store without workspaces; a suspension here is this workspace's alone, like
    // being removed from it while the account stays, and sends nothing)
    const tell = (user: auth.User, { notice = true }: { notice?: boolean } = {}) => {
      if (notice && b.disabled && !target.disabled) accountMail.disabled(target);
      if (user.email !== target.email) accountMail.emailChanged(target.email, user, !target.unverified);
      if (own) afterOwnChange(req, res, user, own);
      else if (b.password !== undefined) {
        voidLinks(user.id, 'reset');
        afterNewPassword(user.id);
        accountMail.passwordChanged(user);
      }
    };
    if (!workspaces.isMigrated()) {
      // A store without workspaces: the account and its role are one, as always.
      const user = await userErrorAsync(() => auth.updateUser(target.id, b));
      tell(user);
      res.json({ user: self ? userIn(user, ws) : memberView(user, ws) });
      return;
    }
    const { role, disabled, ...account } = b;
    // Disabling is this workspace's (A12 INV-REV-2): the membership is suspended, never the account — whoever runs a
    // workspace may be anyone, and a disabled account's address could come back through nothing (no reset, sign-up or
    // other invite). An account disabled the old way is let in again by those who may change it.
    if (disabled !== undefined) {
      if (self) throw fail(400, 'you cannot disable yourself');
      userError(() => workspaces.suspendMember(ws, target.id, disabled));
      if (!disabled && target.disabled && workspaces.accountIsOnlyIn(ws, target.id))
        await userErrorAsync(() => auth.updateUser(target.id, { disabled: false }, { memberships: true }));
    }
    if (Object.values(account).some((v) => v !== undefined)) {
      // Someone else's account itself (name, email, password) is only this workspace's to change when the person works
      // nowhere else: otherwise one team could take over someone another team relies on.
      if (!self && !workspaces.accountIsOnlyIn(ws, target.id))
        throw fail(403, 'they also work in another workspace: only they can change their account (roles here are yours to change)');
      // An address is its person's, confirmed from its inbox (Profile): an admin who could set one could also learn,
      // from the refusal, which addresses have accounts on this server.
      if (newEmail && !self) throw fail(403, 'an address is changed by its person, in Profile (it is confirmed from the new inbox)');
      // A password too, once its person proved the address from their inbox (a confirm or reset link): whoever runs a
      // workspace may be anyone, and an account taken back with a reset must stay its person's. An admin sets one only
      // for an account nobody confirmed (made with `vr admin create-user`, or before workspaces).
      if (account.password !== undefined && !self && auth.addressProven(target))
        throw fail(403, 'their password is theirs: they confirmed their address, so they change it themselves (Forgot password? on the sign-in screen)');
      if (account.name !== undefined) nameFreeFor(target, account.name);
    }
    if (role !== undefined) await userErrorAsync(() => workspaces.setMemberRole(ws, target.id, role));
    const user = Object.values(account).some((v) => v !== undefined)
      ? await userErrorAsync(() => auth.updateUser(target.id, account, { memberships: true }))
      : (auth.getUser(target.id) as auth.User);
    tell(user, { notice: false });
    // yourself: your own record (Profile reads it); anyone else: what an admin sees of them
    res.json({ user: self ? userIn(user, ws) : memberView(user, ws) });
  });

  // Removes someone from this workspace (on a store without workspaces: their account, as always). An account left
  // in no workspace goes too.
  r.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
    const target = memberOf(req, req.params.id as string);
    mayManage(req, target);
    if (target.id === req.auth?.user?.id) throw fail(400, 'you cannot remove yourself');
    // Out of this workspace; the account goes (and hears so) only when it works nowhere else.
    const { account } = userError(() => workspaces.removeMember((req.auth as Auth).workspace, target.id));
    if (account) accountMail.removed(target);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- invites

  // The link opens the app's accept screen; the token stays in the fragment, so it never reaches logs or referrers.
  const inviteUrl = (req: Request, token: string) => `${cfg.public_url || `${req.protocol}://${req.get('host')}`}/#/invite/${token}`;

  r.get('/api/admin/invites', requireAdmin, (req, res) => {
    res.json({ invites: auth.listInvites((req.auth as Auth).workspace) });
  });

  r.post('/api/admin/invites', express.json(), requireAdmin, memberGate, (req, res) => {
    const b = parse(NewInvite, req.body);
    mayManage(req, null, b.role);
    if (b.send && !b.email?.trim()) throw fail(400, 'an invite is emailed to the address it is made out to: add one');
    if (b.send && !accountMail.enabled) throw fail(409, 'this server has no public URL to build links from, so it can’t email invites: copy the link instead');
    const me = req.auth as Auth;
    const ws = me.workspace;
    // invites.json is the whole server's: one account's invites an hour are bounded (and a workspace's waiting ones, in
    // createInvite), so no admin of any workspace can grow it without end (A13 AUTH-1)
    const who = me.user?.id || 'local';
    const wait = invitesMade.retryAfter(who);
    if (wait)
      throw Object.assign(
        fail(429, `you have made ${INVITES_PER_HOUR} invites this hour (the most one account may): try again in ${Math.ceil(wait / 60)} min`),
        {
          retryAfter: wait,
        },
      );
    if (b.send) mailRoom(ws, me.user?.id);
    // With workspaces an address with an account elsewhere may be invited (it joins with its own password).
    const isMember = workspaces.isMigrated() ? (u: auth.User) => !!workspaces.roleIn(ws, u.id) : undefined;
    const { token, invite } = userError(() =>
      auth.createInvite({
        role: b.role,
        name: b.name,
        email: b.email,
        days: b.days,
        by: { id: me.user?.id || 'local', name: me.name },
        ...(ws !== DEFAULT_WORKSPACE ? { workspace: ws } : {}),
        ...(isMember ? { isMember } : {}),
      }),
    );
    invitesMade.hit(who); // counted when it landed
    // Emailed in the inviter's language: they wrote the name and know who reads it.
    const sent = !!b.send && accountMail.invite(invite, token, accountMail.langOf(me.user, b.lang), me.user?.id);
    res.json({ invite: (sent && auth.markInviteSent(invite.id)) || invite, url: inviteUrl(req, token), sent });
  });

  // Email a pending invite (again) to the address it is made out to.
  r.post('/api/admin/invites/:id/send', express.json(), requireAdmin, (req, res) => {
    const id = req.params.id as string;
    mayManageInvite(req, id);
    const b = parse(InviteSend, req.body);
    // This workspace's invites only: another team's is no such invite.
    const token = auth.inviteToken(id, (req.auth as Auth).workspace);
    const invite = token ? auth.pendingInvite(id) : null;
    if (!invite || !token) throw fail(404, 'no pending invite with that id');
    if (!invite.email) throw fail(400, 'this invite names no email address: copy its link instead');
    if (!accountMail.enabled) throw fail(409, 'this server has no public URL to build links from, so it can’t email invites');
    mailRoom((req.auth as Auth).workspace, req.auth?.user?.id);
    if (!accountMail.invite(invite, token, accountMail.langOf(req.auth?.user, b.lang), req.auth?.user?.id))
      throw fail(429, 'too many emails to this address for now: copy the link instead, or try again later');
    res.json({ invite: auth.markInviteSent(id) });
  });

  // An invite for an owner is managed like an owner: an admin who could copy its link could accept it themselves.
  const mayManageInvite = (req: Request, id: string) => {
    const invite = auth.listInvites((req.auth as Auth).workspace).find((i) => i.id === id);
    if (invite) mayManage(req, null, invite.role);
  };

  // Copy the link of a pending invite again (this workspace's invites only).
  r.get('/api/admin/invites/:id/link', requireAdmin, (req, res) => {
    mayManageInvite(req, req.params.id as string);
    const token = auth.inviteToken(req.params.id as string, (req.auth as Auth).workspace);
    if (!token) throw fail(404, 'no pending invite with that id');
    res.json({ url: inviteUrl(req, token) });
  });

  r.delete('/api/admin/invites/:id', requireAdmin, (req, res) => {
    mayManageInvite(req, req.params.id as string);
    // bounded like making them (A13 VERIFY-3), counted when one was revoked
    const who = (req.auth as Auth).user?.id || 'local';
    const wait = invitesRevoked.retryAfter(who);
    if (wait)
      throw Object.assign(
        fail(429, `you have revoked ${INVITES_PER_HOUR} invites this hour (the most one account may): try again in ${Math.ceil(wait / 60)} min`),
        {
          retryAfter: wait,
        },
      );
    if (!auth.revokeInvite(req.params.id as string, (req.auth as Auth).workspace)) throw fail(404, 'no pending invite with that id');
    invitesRevoked.hit(who);
    res.json({ ok: true });
  });

  // Public: the accept screen asks what the link is for, then creates the account. Wrong tokens are throttled per
  // address, like sign-in (the tokens are unguessable anyway; this keeps the log quiet).
  const inviteTries = new RateLimit(30, 15 * 60000);
  const checkInvite = (req: Request, token: string) => {
    const ip = addressKey(req.ip || 'unknown');
    const wait = inviteTries.retryAfter(ip);
    if (wait) throw Object.assign(fail(429, `too many attempts, try again in ${Math.ceil(wait / 60)} min`), { retryAfter: wait });
    const peek = auth.peekInvite(token.trim());
    if (!peek) {
      inviteTries.hit(ip);
      throw fail(404, 'this invite link is not valid anymore: it was used, revoked or has expired');
    }
    return peek;
  };

  r.post('/api/auth/invite/peek', express.json(), (req, res) => {
    const token = parse(InviteToken, req.body).token;
    const peek = checkInvite(req, token);
    // Which workspace it joins, by name, once a server has more than one (the link's reader was sent it).
    const ws = auth.pendingInviteWorkspace(token.trim());
    const w = ws && workspaces.listWorkspaces().length > 1 ? workspaces.getWorkspace(ws) : null;
    // Someone signed in here: whether they are in it already, may join it with their account, or the invite is made out
    // to another address (never which one).
    const me = req.auth?.via === 'cookie' ? req.auth.user : null;
    const you = w && me ? (workspaces.roleIn(w.id, me.id) ? 'member' : auth.inviteFits(token.trim(), me.email) ? 'join' : 'other') : null;
    // Its name once someone chose it: a sign-up's workspace starts out called after its owner, a person's name, not a
    // team's (the inviter is named anyway). `several` keeps "join with your account" either way.
    const named = w && workspaces.workspaceNamed(w.id) ? w.name : null;
    res.json({
      ...peek,
      ...(w ? { several: true } : {}),
      ...(named ? { workspace: named } : {}),
      ...(you ? { you } : {}),
      ...(w && you === 'member' ? { workspace_id: w.id } : {}),
    });
  });

  // What an invite taken on a server with workspaces sends the address (at most one notice an hour per address): the
  // answer is the same whatever happened, so only the address's inbox learns what it was.
  const acceptNotices = new RateLimit(1, HOUR);
  // Addresses tried on an invite made out to another one, per invite: a few typos are told so; past them every address
  // waits, the right one too — so the link's holder can't find the address it was made out to by guessing (A12
  // INV-REV-6). Keyed by the token's hash (the token itself never sits in memory longer than the request).
  const wrongAddresses = new RateLimit(5, 15 * 60000);

  r.post('/api/auth/invite/accept', express.json(), async (req, res) => {
    const b = parse(InviteAccept, req.body);
    checkInvite(req, b.token);
    const token = b.token.trim();
    const ws = auth.pendingInviteWorkspace(token);
    // The workspace's plan may have no room for one more person now (a 402 with its sentence; the link stays valid).
    await extension().check(ws ?? DEFAULT_WORKSPACE, 'member');
    const input = { name: b.name, email: b.email, password: b.password };
    if (!workspaces.isMigrated()) {
      // One team on the server: its admins vouch for whom they invite. A new account, in at once (an address that has
      // an account is refused, a held sign-up's too); an address the invite didn't name gets a link to confirm it.
      const out = await userErrorAsync(() => workspaces.acceptInviteIn(token, input, { confirm: accountMail.enabled }));
      const user = out.user;
      if (user.unverified) accountMail.verify(user, user.email, accountMail.langOf(user, b.lang), { invited: true });
      setCookie(req, res, user, ws);
      res.json({ user: userIn(user, ws ?? DEFAULT_WORKSPACE), ...workspaceFacts({ user, workspace: ws ?? DEFAULT_WORKSPACE }) });
      return;
    }
    // A server with workspaces: whoever made the invite holds its link as much as the person it went to, so the link
    // proves no inbox. An account that gives its own password joins now; every other answer is one and the same —
    // `{held: true}`, nobody signed in, the browser marked —, a free address gets a held account the invite waits for,
    // and the address's inbox decides (lib/auth.ts acceptInvite). Someone signed in as the address is told a wrong
    // password, throttled like a sign-in: they know the account is there.
    const guessed = sha256(token);
    const guessWait = wrongAddresses.retryAfter(guessed);
    if (guessWait) throw Object.assign(fail(429, `too many attempts, try again in ${Math.ceil(guessWait / 60)} min`), { retryAfter: guessWait });
    if (!auth.inviteFits(token, b.email)) {
      wrongAddresses.hit(guessed);
      byIp.hit(req.ip || 'unknown');
      throw fail(400, 'this invite is for another e-mail address');
    }
    const me = req.auth?.via === 'cookie' ? req.auth.user : null;
    if (me && auth.sameEmail(me.email, b.email)) await checkLogin(req, b.email, b.password);
    else if (!accountMail.enabled)
      // (a hosted server without a public URL: a local test only — config.ts) Nothing could confirm the address.
      throw fail(409, 'this server can’t email the link that confirms an address (it has no public URL), so an invite can’t be taken here');
    // Every try counts against the address and this caller like a failed sign-in, whatever the address: an invite link
    // is no way around the sign-in limits, and a limit reached says nothing about who has an account.
    const ip = req.ip || 'unknown';
    const account = auth.emailKey(b.email);
    const pair = `${account}\n${ip}`;
    const wait = Math.max(byIp.retryAfter(ip), byAccountAndIp.retryAfter(pair), byAccount.retryAfter(account));
    if (wait) throw Object.assign(fail(429, `too many attempts, try again in ${Math.ceil(wait / 60)} min`), { retryAfter: wait });
    const browser = cookies.mark(req);
    const out = await userErrorAsync(() => workspaces.acceptInviteIn(token, input, { confirm: true, browser: sha256(browser) }));
    if (out.kind === 'in') {
      byAccountAndIp.reset(pair);
      const user = out.user;
      // Signed in where the invite led.
      setCookie(req, res, user, ws);
      res.json({ user: userIn(user, ws ?? DEFAULT_WORKSPACE), ...workspaceFacts({ user, workspace: ws ?? DEFAULT_WORKSPACE }) });
      return;
    }
    byIp.hit(ip);
    byAccountAndIp.hit(pair);
    byAccount.hit(account);
    cookies.signup(req, res, browser, 24 * 3600);
    res.json({ held: true });
    const lang = accountMail.langOf(null, b.lang);
    // (a while after the answer, which is the same whatever happened: A12 INV-REV-8)
    accountMail.afterwards('invite', () => {
      {
        const u = out.user;
        // A held account made or kept for this invite: its link (only the inbox gets it; the browser that took the
        // invite is signed in by it, no other).
        if (out.kind === 'held') {
          accountMail.verify(u, u.email, accountMail.langOf(u, lang));
          return;
        }
        if (u.disabled || acceptNotices.retryAfter(u.email)) return;
        acceptNotices.hit(u.email);
        // Someone's held sign-up: a reset link, which only that inbox gets and which lets the address's owner in with a
        // password of their own (whoever made the held account may not have been them).
        if (auth.isGated(u)) accountMail.reset(u, accountMail.langOf(u, lang));
        // An account that's there: its owner hears someone tried (sign in, then open the invite again).
        else accountMail.signupExists(u, accountMail.langOf(u, lang));
      }
    });
  });

  // An owner's credentials are an owner's business, like the owner (mayManage): admins see and revoke everyone else's.
  // Only this workspace's tokens: another team's are not even listed.
  const ownerIds = (ws: string) => new Set(workspaces.membersOf(ws).flatMap((m) => (m.role === 'owner' ? [m.user] : [])));
  r.get('/api/admin/tokens', requireAdmin, (req, res) => {
    const ws = (req.auth as Auth).workspace;
    const hidden = req.auth?.role === 'owner' ? new Set<string>() : ownerIds(ws);
    res.json({
      tokens: auth
        .listTokens()
        .filter((t) => auth.tokenWorkspace(t) === ws && !hidden.has(t.user))
        .map(auth.publicToken),
    });
  });

  r.delete('/api/admin/tokens/:id', requireAdmin, (req, res) => {
    const ws = (req.auth as Auth).workspace;
    const t = auth.listTokens().find((x) => x.id === req.params.id && auth.tokenWorkspace(x) === ws);
    if (t) mayManage(req, auth.getUser(t.user));
    res.json({ ok: auth.revokeToken(req.params.id as string, undefined, ws) });
  });

  return r;
}
