// Accounts. Plain files like the rest of the store, readable only by the server's user:
//   data/users.json   {"users": [...], "tokens": [...]}  passwords as scrypt hashes, API tokens as sha256
//   data/invites.json {"invites": [...]}                  one-time sign-up links: sha256 for lookup, sealed for admins
//   data/secret.key   32 random bytes that sign session cookies (and seal invite links)
// On a person's own machine the first start creates their owner account (ensureLocalOwner); it has no password until
// they set one, and the server signs them in automatically when the request comes from the machine itself.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { newestLinks, voidLinks } from './accountLinks.ts';
import { settings } from './env.ts';
import { isGated } from './gate.ts';
import { accountAddress } from './mail/mime.ts';
import { cleanDisplayName, cutChars, looksReserved, nameSkeleton } from './names.ts';
import { startOnboarding } from './onboarding.ts';
import { DATA, isoLocal } from './paths.ts';
import { can } from './permissions.ts';
import { Recent } from './rateLimit.ts';
import { isSignupPlan } from './setupFlow.ts';
import { deepFreeze, withLock, writeAtomic } from './store.ts';
import { compareTime } from './time.ts';
import type { InvitePeek, MomentId, OnboardingPrefs, PublicInvite, PublicToken, PublicUser, Role, SignupPlan, UserPrefsPatch } from './types.ts';

export type { PublicInvite, PublicToken, PublicUser, Role } from './types.ts';
export const ROLES: readonly Role[] = ['owner', 'admin', 'member', 'reviewer'];

// The public shapes live in types.ts (the web UI imports them); the stored records add the secrets.
export interface User extends PublicUser {
  /** scrypt$N$r$p$salt$hash (base64url). */
  password: string;
  /** Bumped to sign out every session of the user (password change, "sign out everywhere", disabling). */
  epoch: number;
  /**
   * A held sign-up: sha256 of the random value the signing-up browser got as a cookie. Its confirm link signs in that
   * browser only — anyone else who opens it confirms the address and signs in with the password (login CSRF).
   */
  signup_browser?: string;
  /**
   * When the account's address was last proven from its inbox (a confirm link or a reset link used). From then on the
   * person's credentials are theirs alone: no workspace admin sets them (server/auth.ts).
   */
  proven?: string;
  /**
   * Not a member of workspace #1 (it left, or was made for another workspace): `role` is then no role of #1's, and a
   * store read without workspaces.json never counts the account in #1 (lib/workspaces.ts implied). Absent: `role` is
   * its role in #1 — every account of a store without workspaces.
   */
  outside_w1?: true;
  /** When the account last signed in (a new session, or `lampo login` making a token): the server's operator reads it. */
  signed_in?: string;
  /**
   * When the person last used the app through their session (a request with its cookie; written at most once an hour,
   * noteSeen). With `signed_in` it is the operator's "last active": a session made before `signed_in` was kept, or one
   * kept for weeks, never signs in again. Only the operator's answers and the person's own export carry it.
   */
  seen?: string;
}

/**
 * Whether the address was ever proven from its inbox by the account's owner: `proven`, or a sign-up confirmed before
 * that was recorded (a confirmed sign-up keeps `signup` and loses `unverified`).
 */
export const addressProven = (u: Pick<User, 'proven' | 'signup' | 'unverified'>): boolean => !!u.proven || (!!u.signup && !u.unverified);

export interface ApiToken extends PublicToken {
  /** sha256 of the token, hex. */
  hash: string;
}

/** A signed-out session: its id until the cookie would have expired anyway. */
interface RevokedSession {
  s: string;
  until: number;
}

interface UsersFile {
  users: User[];
  tokens: ApiToken[];
  /** Sessions signed out on one device (the cookie is stateless, so the server remembers which ones ended). */
  revoked?: RevokedSession[];
  /**
   * When the server began to keep `seen` (its first one): an account made since then with neither stamp never signed
   * in, while one made before may have, unrecorded.
   */
  seen_since?: string;
}

export const USERS_FILE = path.join(DATA, 'users.json');
export const INVITES_FILE = path.join(DATA, 'invites.json');
export const SECRET_FILE = path.join(DATA, 'secret.key');
const LOCK_DIR = path.join(DATA, '.auth');

const scrypt = promisify(crypto.scrypt) as (pw: crypto.BinaryLike, salt: crypto.BinaryLike, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const b64 = (b: Buffer) => b.toString('base64url');
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function publicUser(u: User): PublicUser {
  const { password: _p, epoch: _e, signup_browser: _b, proven: _v, outside_w1: _o, signed_in: _i, seen: _s, ...rest } = u;
  return { ...rest, has_password: !!u.password };
}
/** A token as the API shows it: no hash; `workspace` only when it isn't #1 (absent means #1, as before workspaces). */
export function publicToken(t: ApiToken): PublicToken {
  const { hash: _h, workspace, ...rest } = t;
  return { ...rest, ...(workspace && workspace !== 'w1' ? { workspace } : {}) };
}

function load(): UsersFile {
  try {
    const f = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) as Partial<UsersFile>;
    return {
      users: f.users || [],
      tokens: f.tokens || [],
      ...(f.revoked?.length ? { revoked: f.revoked } : {}),
      ...(f.seen_since ? { seen_since: f.seen_since } : {}),
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { users: [], tokens: [] };
    throw e;
  }
}

// Every request reads this file (a token or a session names its account), so it is parsed again only when it changed:
// inode, size or mtime (every write is an atomic rename, from this process or `lampo admin` in another). What the reads
// return is shared between callers and frozen; changes go through change(), which loads the file fresh.
let parsed: { key: string; file: UsersFile; revoked: Set<string> } | null = null;
function current(): { file: UsersFile; revoked: Set<string> } {
  let key = 'none';
  try {
    const st = fs.statSync(USERS_FILE);
    key = `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (parsed?.key === key) return parsed;
  const file = deepFreeze(load());
  parsed = { key, file, revoked: new Set((file.revoked || []).map((r) => r.s)) };
  return parsed;
}
const read = (): UsersFile => current().file;

function save(f: UsersFile): void {
  fs.mkdirSync(DATA, { recursive: true });
  writeAtomic(USERS_FILE, `${JSON.stringify(f, null, 2)}\n`);
  fs.chmodSync(USERS_FILE, 0o600);
}

const change = <T>(fn: (f: UsersFile) => T): T =>
  withLock(LOCK_DIR, () => {
    const f = load();
    const out = fn(f);
    save(f);
    return out;
  });

// ---------------------------------------------------------------- the access a change was asked with

/**
 * The access a request came in with: its account, that account's epoch then (a session's cookie carries it) and the
 * session's id. Whatever ends access moves the epoch on (a new password, a reset, "sign out everywhere", disabling) or
 * remembers the session as signed out. A change asked for with it is saved only while it still holds — checked inside
 * the lock that saves it, after every await (a password checked, a new one hashed, a body read): otherwise a request
 * that began before a recovery lands after it, and puts back what the recovery ended (a password, an address, a
 * token, a session).
 */
export interface Access {
  user: string;
  epoch: number;
  /** A session's id (its cookie's `s`); absent for the machine's owner at the machine, who has no session. */
  session?: string;
}

/** The access a change was asked with ended before the change was saved: nothing was changed. */
export class AccessEndedError extends Error {
  status = 401;
  constructor() {
    super('you were signed out meanwhile (a new password, a reset, “sign out everywhere” or a disabled account), so nothing was changed: sign in again');
  }
}

const holdsIn = (users: readonly User[], signedOut: (s: string) => boolean, a: Access): boolean => {
  const u = users.find((x) => x.id === a.user);
  return !!u && !u.disabled && u.epoch === a.epoch && !(a.session !== undefined && signedOut(a.session));
};

/** Inside change() (the file as it is under the lock): the access still holds, or nothing is saved. */
function stillIn(f: UsersFile, a: Access | undefined): void {
  if (a && !holdsIn(f.users, (s) => !!f.revoked?.some((r) => r.s === s), a)) throw new AccessEndedError();
}

/** Whether an access still holds now: for a handler with nothing left to wait for before what it changes. */
export function stillHolds(a: Access): boolean {
  const { file, revoked } = current();
  return holdsIn(file.users, (s) => revoked.has(s), a);
}

/**
 * What ending every session of an account (its epoch moved on) also ends: a change of address still waiting for its
 * link was asked for in one of them. Says the address it was waiting for, if any.
 */
function endSessions(u: User): string | undefined {
  u.epoch++;
  const waiting = u.pending_email;
  delete u.pending_email;
  return waiting;
}

// ---------------------------------------------------------------- access ended

/**
 * Access ended in this process: a token revoked, an app disconnected, a member removed, an account disabled, deleted,
 * signed out or given a new password. Whatever holds a response open for someone (server/routes/mcp.ts: waits and
 * listen streams) asks again at once instead of at its next turn. Changes made by another process (`lampo admin`) reach
 * it at that next turn.
 */
const accessListeners = new Set<() => void>();
export function onAccessEnded(fn: () => void): () => void {
  accessListeners.add(fn);
  return () => accessListeners.delete(fn);
}
export function accessEnded(): void {
  for (const fn of accessListeners) {
    try {
      fn();
    } catch (e) {
      console.error('access listener:', (e as Error).message);
    }
  }
}

/**
 * An account was removed (deleteUser, sweepUnconfirmed): what it kept outside users.json goes after it — its picture,
 * devices, drafts, unsent recordings, watching, app connections (lib/erasure.ts afterAccountGone registers here, from
 * lib/workspaces.ts, which every process that removes accounts loads). Each listener gets the removed record.
 */
const goneListeners = new Set<(u: User) => void>();
export function onAccountGone(fn: (u: User) => void): () => void {
  goneListeners.add(fn);
  return () => goneListeners.delete(fn);
}
function accountGone(u: User): void {
  for (const fn of goneListeners) {
    try {
      fn(u);
    } catch (e) {
      console.error('account-gone listener:', (e as Error).message);
    }
  }
}

/**
 * A sign-in happened (a new session, a `lampo login` token): when, for the operator's accounts page. Nothing else reads it,
 * and no answer but the operator's carries it (publicUser leaves it out).
 */
export function noteSignIn(id: string): void {
  if (!getUser(id)) return;
  change((f) => {
    const u = f.users.find((x) => x.id === id);
    if (u) u.signed_in = isoLocal();
  });
}

/** How often an account's `seen` is written at most (tests lower it). */
export const SEEN_EVERY = { ms: 3_600_000 };
// When this process last wrote (or found) each account's `seen`: one entry per account in use, so as many as there are
// accounts at most, and bounded all the same.
const seenWritten = new Recent<number>(50_000);

/**
 * A person used the app through their session (server/auth.ts noteActive, from the guard): when, for the operator's
 * accounts page — written at most once an hour per account, since every request reads this file and every write makes
 * it parsed again. A `seen` written within the hour by another process, or before a restart, counts as written. Says
 * whether it wrote.
 */
export function noteSeen(id: string, now = Date.now()): boolean {
  const last = seenWritten.get(id);
  if (last !== undefined && now - last >= 0 && now - last < SEEN_EVERY.ms) return false;
  const u = getUser(id);
  if (!u) return false;
  const stored = u.seen ? Date.parse(u.seen) : Number.NaN;
  if (now - stored >= 0 && now - stored < SEEN_EVERY.ms) {
    seenWritten.set(id, stored);
    return false;
  }
  seenWritten.set(id, now);
  const at = isoLocal(new Date(now));
  change((f) => {
    const x = f.users.find((y) => y.id === id);
    if (!x) return;
    x.seen = at;
    f.seen_since ??= at;
  });
  return true;
}

/** When the server began to keep `seen` (null: not yet). */
export const seenSince = (): string | null => read().seen_since ?? null;

/** When the account was last active: the later of its `seen` and its `signed_in` (null: neither recorded). */
export function lastActive(u: Pick<User, 'seen' | 'signed_in'>): string | null {
  if (!u.seen || !u.signed_in) return u.seen || u.signed_in || null;
  return compareTime(u.seen, u.signed_in) >= 0 ? u.seen : u.signed_in;
}

/** Every account (read-only: shared and frozen, see current()). */
export const listUsers = (): User[] => [...read().users];
export const hasUsers = (): boolean => read().users.length > 0;
export const getUser = (id: string): User | null => read().users.find((u) => u.id === id) || null;

/** An address as accounts made before A12 INV-REV-9 kept it (what they may still be stored as, and sign in with). */
const typedEmail = (e: string) => e.trim().toLowerCase();
/**
 * Whether a stored address (an account's, an invite's) is the one `e` (checkEmail's spelling) names: the same, or one
 * kept before the rule that spells it otherwise — a second account must not be made beside it.
 */
const holdsEmail = (stored: string | null | undefined, e: string): boolean => !!stored && (stored === e || accountAddress(stored) === e);
/** Whether what someone typed names a stored address: as typed before the rule (an older account), or its spelling now. */
export const sameEmail = (stored: string | null | undefined, typed: string): boolean =>
  !!stored && (stored === typedEmail(typed) || stored === accountAddress(typed));
/** Whether an address may be an account's: one by the rule now, or as accounts made before it kept theirs. */
export function mayBeAccountEmail(typed: string): boolean {
  const before = typedEmail(typed);
  return !!accountAddress(typed) || (/^[^\s@]+@[^\s@]+$/.test(before) && before.length <= 254);
}
/** What per-address limits count by: one key for every way of typing an address. */
export const emailKey = (typed: string): string => accountAddress(typed) ?? typedEmail(typed);
/** The account an address belongs to: as it was typed when the account was made, else its one spelling now. */
export const findUserByEmail = (email: string): User | null => {
  const { users } = read();
  const typed = typedEmail(email);
  const now = accountAddress(email);
  return users.find((u) => u.email === typed) || (now ? users.find((u) => u.email === now) : undefined) || null;
};

/**
 * The machine's owner: the account marked `local`, else the oldest active owner (a store that started on a server).
 * Null until one exists.
 */
export function localOwner(): User | null {
  const users = read().users.filter((u) => !u.disabled);
  return (
    users.find((u) => u.local && u.role === 'owner') || users.filter((u) => u.role === 'owner').sort((a, b) => compareTime(a.created, b.created))[0] || null
  );
}

/**
 * The name the machine's owner account starts with (see ensureLocalOwner): config.json "user", LAMPO_USER or the OS
 * login name. Nobody chose it for others to read, so review links don't show it (lib/shares.ts sharerName).
 */
export function startingName(name: string): string {
  try {
    return checkName(name);
  } catch {
    return 'owner';
  }
}

// New accounts start with the first run (lib/onboarding.ts) unless the instance turned it off (config `onboarding`,
// LAMPO_ONBOARDING): the server and `lampo admin` set this from the config before they make accounts. Every way an account
// is made goes through insertUser or ensureLocalOwner — signup too (SEAM(signup): a new account made with createUser
// gets its first run; the first run shows after its first successful sign-in, nothing else to do).
let firstRuns = false;
export function setOnboarding(on: boolean): void {
  firstRuns = on;
}
const firstRun = (): Pick<User, 'prefs'> => (firstRuns ? { prefs: { onboarding: startOnboarding(isoLocal()) } } : {});

/**
 * First start on a person's own machine: their owner account, named like the notes they already wrote (config.json
 * "user" / the OS account), with no password — the server signs them in when the request comes from this machine,
 * and they can add an email and a password in Settings to sign in from other devices. Does nothing when any account
 * exists (a store that was hosted before keeps its owners). `fresh`: the store has no videos yet, so this is the
 * machine's very first start and the owner gets the first run (a store from before accounts existed doesn't).
 */
export function ensureLocalOwner(name: string, { fresh = false }: { fresh?: boolean } = {}): User {
  const existing = localOwner();
  if (existing) return existing;
  return change((f) => {
    const again = f.users.find((u) => u.role === 'owner' && !u.disabled);
    if (again) return again;
    const n = startingName(name);
    const handle =
      n
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '.')
        .replace(/^\.+|\.+$/g, '') || 'owner';
    const u: User = {
      id: `u_${crypto.randomBytes(6).toString('hex')}`,
      email: `${handle}@localhost`,
      name: n,
      role: 'owner',
      password: '',
      created: isoLocal(),
      epoch: 0,
      local: true,
      ...(fresh ? firstRun() : {}),
    };
    f.users.push(u);
    return u;
  });
}

// ---------------------------------------------------------------- passwords

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  // An account without a password (the machine's owner, until they set one) never signs in with one.
  if (!stored) return false;
  const [kind, n, r, p, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64url');
  const got = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64url'), want.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(got, want);
}

// A hash to compare against when the account does not exist, so a wrong email takes as long as a wrong password.
let dummy: Promise<string> | null = null;
export const dummyHash = (): Promise<string> => {
  dummy ||= hashPassword(crypto.randomBytes(12).toString('hex'));
  return dummy;
};

export function checkPassword(password: string): void {
  if (password.length < 10) throw new Error('password must be at least 10 characters');
  if (password.length > 1024) throw new Error('password is too long');
}

export function checkName(name: string): string {
  // Normalised and without invisible characters: what others read is what is stored.
  const n = cleanDisplayName(name);
  if (!n || n.length > 80) throw new Error('name must be 1–80 characters');
  // Authors starting with agent:/guest: mean something else throughout the store (look-alike letters included).
  if (looksReserved(n)) throw new Error('name cannot start with "agent:" or "guest:"');
  // "·" separates an agent's name from whose it is (`claude-code · Sam`): a name with one could pass for another's.
  if (/[·•∙⋅‧・]/.test(n)) throw new Error('name cannot contain "·"');
  return n;
}

/** Two accounts may not read the same: same letters in another case, or letters from another script that look alike. */
const sameName = (a: string, b: string) => nameSkeleton(a) === nameSkeleton(b);

/** The address an account or invite is made out to, in its one spelling (`accountAddress`), or an error. */
export function checkEmail(email: string): string {
  const e = accountAddress(email);
  if (!e) throw new Error('that is not an email address');
  return e;
}

// ---------------------------------------------------------------- users

/** A new account. `nameFree` (a store with workspaces): its name must differ only from the people it works with. */
export async function createUser({
  email,
  name,
  password,
  role,
  nameFree,
}: {
  email: string;
  name: string;
  password: string;
  role: Role;
  nameFree?: (name: string) => boolean;
}): Promise<User> {
  const e = checkEmail(email);
  const n = checkName(name);
  checkPassword(password);
  if (nameFree && !nameFree(n)) throw new Error(`the name "${n}" is taken`);
  const hash = await hashPassword(password);
  return change((f) => insertUser(f, { email: e, name: n, role, hash, skipNames: !!nameFree }));
}

/** Whether two names read the same (case, look-alike letters): names people see must tell them apart. */
export const namesClash = (a: string, b: string): boolean => sameName(a, b);

function insertUser(
  f: UsersFile,
  { email, name, role, hash, skipNames = false }: { email: string; name: string; role: Role; hash: string; skipNames?: boolean },
): User {
  if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);
  if (f.users.some((u) => holdsEmail(u.email, email))) throw new Error(`a user with ${email} already exists`);
  // On a store with workspaces names are unique inside each workspace (lib/workspaces.ts checks), not across teams.
  if (!skipNames && f.users.some((u) => sameName(u.name, name))) throw new Error(`the name "${name}" is taken`);
  const u: User = { id: `u_${crypto.randomBytes(6).toString('hex')}`, email, name, role, password: hash, created: isoLocal(), epoch: 0, ...firstRun() };
  f.users.push(u);
  return u;
}

export interface UserPatch {
  name?: string;
  email?: string;
  role?: Role;
  disabled?: boolean;
  password?: string;
  /**
   * A new address that waits for its link (setPendingEmail's rules), saved with the rest at once; null calls one off. With
   * a new password in the same patch it waits under the new one.
   */
  pendingEmail?: string | null;
  /** Merged into the stored prefs; a key set to undefined stays as it is. */
  prefs?: UserPrefsPatch;
}

/** Records (or clears) the account's profile picture; says which file it replaced so the caller can remove it. */
export function setAvatar(id: string, file: string | null): { user: User; previous: string | null } {
  return change((f) => {
    const u = f.users.find((x) => x.id === id);
    if (!u) throw new Error('no such user');
    const previous = u.avatar ?? null;
    if (file) u.avatar = file;
    else delete u.avatar;
    return { user: { ...u }, previous };
  });
}

/**
 * Changes an account. `memberships`: roles live in workspaces (lib/workspaces.ts decides about owners and invites), so
 * the store-wide owner rules of a store without workspaces are left out and `role` must not be given. `access`: who asked
 * (Access) — the change is saved only while that still holds, after the new password is hashed; otherwise it throws
 * AccessEndedError and nothing changed.
 */
export async function updateUser(
  id: string,
  patch: UserPatch,
  { memberships = false, access }: { memberships?: boolean; access?: Access } = {},
): Promise<User> {
  if (patch.password !== undefined) checkPassword(patch.password);
  if (memberships && patch.role !== undefined) throw new Error('roles belong to workspaces');
  const hash = patch.password !== undefined ? await hashPassword(patch.password) : null;
  const before = getUser(id);
  const user = changeUser(id, patch, hash, memberships, access);
  // A new address: every link sent before stops working (the inbox the account moved away from has no say any more).
  // A new password: the confirmations sent before (asked for under the password it replaces). A reset link stays until
  // it is used or its hour is up: it proves the inbox, which may ask for another at any time, so ending it protects
  // nothing — and whoever holds a session and the password could keep the person's recovery dead by changing the
  // password again and again. A reset spends it (server/routes/account.ts).
  if (before && before.email !== user.email) voidLinks(id);
  else if (hash) voidLinks(id, 'verify');
  if (memberships ? !!user.disabled : user.disabled || !can(user.role, 'admin')) revokeInvitesBy(id);
  if (hash || (user.disabled && !before?.disabled)) accessEnded();
  return user;
}

/**
 * Workspace #1's role written onto the account too (`User.role`, what a store without workspaces reads), or `null` for
 * an account that isn't a member of #1: then the least role and `outside_w1`, so nothing it once had there (an admin
 * who left) or was given for another workspace can come back as a role in #1. No rules: lib/workspaces.ts checked them.
 */
export function mirrorRole(id: string, role: Role | null): void {
  const u = getUser(id);
  if (!u || (role ? u.role === role && !u.outside_w1 : u.role === 'reviewer' && u.outside_w1)) return;
  change((f) => {
    const x = f.users.find((y) => y.id === id);
    if (!x) return;
    x.role = role ?? 'reviewer';
    if (role) delete x.outside_w1;
    else x.outside_w1 = true;
  });
}

function changeUser(id: string, patch: UserPatch, hash: string | null, memberships = false, access?: Access): User {
  return change((f) => {
    stillIn(f, access);
    const u = f.users.find((x) => x.id === id);
    if (!u) throw new Error('no such user');
    if (patch.name !== undefined) {
      const n = checkName(patch.name);
      if (!memberships && f.users.some((x) => x !== u && sameName(x.name, n))) throw new Error(`the name "${n}" is taken`);
      u.name = n;
    }
    if (patch.email !== undefined) {
      const e = checkEmail(patch.email);
      if (f.users.some((x) => x !== u && holdsEmail(x.email, e))) throw new Error(`a user with ${e} already exists`);
      // Set directly (an admin, or a server that can't send mail): whoever set it vouches for it.
      if (e !== u.email) {
        u.email = e;
        delete u.unverified;
        delete u.pending_email;
      }
    }
    const owners = () => (memberships ? Number.POSITIVE_INFINITY : f.users.filter((x) => x.role === 'owner' && !x.disabled).length);
    if (patch.role !== undefined && patch.role !== u.role) {
      if (u.role === 'owner' && owners() === 1) throw new Error('the last owner cannot be demoted');
      u.role = patch.role;
    }
    if (patch.disabled !== undefined) {
      if (patch.disabled && u.role === 'owner' && owners() === 1) throw new Error('the last owner cannot be disabled');
      if (patch.disabled) {
        u.disabled = isoLocal();
        endSessions(u);
      } else delete u.disabled;
    }
    if (patch.prefs?.theme !== undefined) u.prefs = { ...u.prefs, theme: patch.prefs.theme };
    if (patch.prefs?.lang !== undefined) u.prefs = { ...u.prefs, lang: patch.prefs.lang };
    if (patch.prefs?.wake !== undefined) u.prefs = { ...u.prefs, wake: patch.prefs.wake };
    if (patch.prefs?.signin_alerts !== undefined) u.prefs = { ...u.prefs, signin_alerts: patch.prefs.signin_alerts };
    if (patch.prefs?.voice_languages !== undefined) {
      const { voice_languages: _, ...rest } = u.prefs ?? {};
      const langs = patch.prefs.voice_languages;
      // null: back to the server's list; [] is a choice of its own (Automatic).
      u.prefs = langs === null ? rest : { ...rest, voice_languages: [...new Set(langs.map((l) => l.toLowerCase()))] };
    }
    if (hash) {
      u.password = hash;
      endSessions(u);
    }
    // after the password: an address asked for with a new one waits under it
    if (patch.pendingEmail !== undefined) waitFor(u, patch.pendingEmail === null ? null : checkEmail(patch.pendingEmail));
    return u;
  });
}

/**
 * Changes an account's first run (`fn` gets it and returns the next one, or the same object for no change): the
 * server records steps seen done, hiding and bringing it back. Accounts without one (from before it) stay without.
 * Writes only when something changed.
 */
export function updateOnboarding(id: string, fn: (o: OnboardingPrefs) => OnboardingPrefs): User | null {
  const now = getUser(id);
  const o = now?.prefs?.onboarding;
  if (!now || !o || fn(o) === o) return now;
  return change((f) => {
    const u = f.users.find((x) => x.id === id);
    const cur = u?.prefs?.onboarding;
    if (!u || !cur) return u ?? null;
    const next = fn(cur);
    if (next !== cur) u.prefs = { ...u.prefs, onboarding: next };
    return u;
  });
}

/**
 * Puts a conversion moment away for this account in a workspace until `until` (ISO), or brings it back (null): what
 * "Not now" and its Undo send (PUT /api/moments/:id). The account's other moments in that workspace whose time is up go
 * at the same time, so the field stays as small as what is put away now.
 */
export function setMomentHidden(id: string, workspace: string, moment: MomentId, until: string | null, now = Date.now()): User | null {
  return change((f) => {
    const u = f.users.find((x) => x.id === id);
    if (!u) return null;
    const all = { ...(u.prefs?.moments ?? {}) };
    const here = Object.fromEntries(Object.entries(all[workspace] ?? {}).filter(([k, t]) => k !== moment && !!t && Date.parse(t) > now));
    if (until) here[moment] = until;
    if (Object.keys(here).length) all[workspace] = here;
    else delete all[workspace];
    const { moments: _old, ...rest } = u.prefs ?? {};
    u.prefs = Object.keys(all).length ? { ...rest, moments: all } : rest;
    return u;
  });
}

/** Removes the account and its tokens. `memberships`: the workspaces decided who may go (lib/workspaces.ts), so the
 * store-wide "last owner" rule of a store without workspaces is left out. */
export function deleteUser(id: string, { memberships = false }: { memberships?: boolean } = {}): void {
  const gone = change((f) => {
    const u = f.users.find((x) => x.id === id);
    if (!u) throw new Error('no such user');
    if (!memberships && u.role === 'owner' && f.users.filter((x) => x.role === 'owner').length === 1) throw new Error('the last owner cannot be removed');
    f.users = f.users.filter((x) => x !== u);
    f.tokens = f.tokens.filter((t) => t.user !== id);
    return { ...u };
  });
  revokeInvitesBy(id);
  forgetInvitee(id);
  voidLinks(id);
  accessEnded();
  accountGone(gone);
}

/**
 * A removed account's traces in invites.json: claims it held (a held sign-up waiting on an invite), and the name an
 * invite it took recorded — the invite stays as the inviter's record (who invited whom into which workspace, when).
 */
function forgetInvitee(id: string): void {
  withLock(LOCK_DIR, () => {
    const all = loadInvites();
    let changed = false;
    for (const i of all) {
      if (i.claims?.includes(id)) {
        i.claims = i.claims.filter((c) => c !== id);
        if (!i.claims.length) delete i.claims;
        changed = true;
      }
      if (i.accepted?.user === id) {
        i.accepted = { at: i.accepted.at, user: '', name: '' };
        i.email = null;
        i.name = null;
        changed = true;
      }
    }
    if (changed) saveInvites(all);
  });
}

// ---------------------------------------------------------------- addresses and sign-up (email: lib/mail/, server/routes/account.ts)

export { isGated };

export type SignUpResult =
  /** A new account, waiting for its address to be confirmed. */
  | { made: User }
  /**
   * The address has an account already: the caller tells that account's owner, and the asker nothing. A held one
   * (isGated) is someone's sign-up or taken invite, with a password someone chose: `fits` says whether the password
   * given now is that one (open sign-up), `invited` the pending invites made out to the address (invite mode).
   */
  | { exists: User; fits?: boolean; invited?: string[] }
  /**
   * LAMPO_SIGNUP=invite and pending invites are made out to the address (their ids): nothing is made. The caller sends
   * them there again, and only an invite's own link makes the account, with its role — knowing an invited address
   * gets nobody anything, and the invite stays the invitee's.
   */
  | { invited: string[] }
  /** LAMPO_SIGNUP=invite and no pending invite is made out to the address. */
  | { refused: 'no-invite' };

/**
 * Someone signs up on their own (LAMPO_SIGNUP). `open`: anyone, as a reviewer until the onSignup seam gives them their own
 * workspace (server/signup.ts); the account starts unconfirmed and held (isGated), and the password is hashed before
 * anything is looked up, so every answer takes as long (the route answers all of them alike). `invite`: no account at
 * all — an address a pending invite is made out to gets that invite again (`invited`), whose link is the way in.
 */
export async function signUp({
  email,
  name = '',
  password = '',
  mode,
  anyName = false,
  browser,
  plan,
}: {
  email: string;
  /** open only (an invite's link asks for them). */
  name?: string;
  password?: string;
  mode: 'invite' | 'open';
  /** The person gets a workspace of their own (open sign-up with workspaces): no name elsewhere can clash with theirs. */
  anyName?: boolean;
  /** sha256 of the signing-up browser's cookie (User.signup_browser): its confirm link signs in that browser only. */
  browser?: string;
  /** The plan picked on the website (`?plan=`, a known id): a new account's first run keeps it for Get started. */
  plan?: SignupPlan;
}): Promise<SignUpResult> {
  const e = checkEmail(email);
  if (mode === 'invite') {
    const existing = findUserByEmail(e);
    const pending = pendingInvitesFor(e);
    // A held account at the address (someone's taken invite) never stands in for the invites the address waits for.
    if (existing) return { exists: existing, ...(isGated(existing) ? { invited: pending } : {}) };
    return pending.length ? { invited: pending } : { refused: 'no-invite' as const };
  }
  const n = checkName(name);
  checkPassword(password);
  // Whether the password given is the one an account at the address already holds (a held sign-up made again by the
  // same person, or someone else's): two hashes for every address, so the answer takes as long either way.
  const before = findUserByEmail(e);
  const fits = await verifyPassword(password, before?.password || (await dummyHash()));
  const hash = await hashPassword(password);
  return withLock(LOCK_DIR, () => {
    const f = load();
    // The name first, whatever the address: a "name taken" that depended on the address would tell which ones are known.
    if (!anyName && f.users.some((u) => sameName(u.name, n))) throw new Error(`the name "${n}" is taken here: add a last name or an initial`);
    const existing = f.users.find((u) => holdsEmail(u.email, e));
    if (existing) return { exists: existing, fits: fits && existing.id === before?.id && existing.password === before.password };
    const user = insertUser(f, { email: e, name: n, role: 'reviewer', hash, skipNames: anyName });
    user.unverified = isoLocal();
    user.signup = user.unverified;
    if (browser) user.signup_browser = browser;
    // the website's plan rides with the held account through its confirm link (only where a first run exists)
    const o = user.prefs?.onboarding;
    if (plan && isSignupPlan(plan) && o) user.prefs = { ...user.prefs, onboarding: { ...o, plan } };
    save(f);
    return { made: { ...user } };
  });
}

/**
 * A held account's confirm link signs in this browser from now on (`vr_signup`'s sha256): set only for a browser that
 * proved it holds the account's password (the same person signing up or taking an invite again, A12-D14) — never for
 * one that merely asked with the address.
 */
export function markSignupBrowser(userId: string, browser: string): void {
  change((f) => {
    const u = f.users.find((x) => x.id === userId);
    if (u && isGated(u)) u.signup_browser = browser;
  });
}

/** The pending invites made out to an address (ids), for sending them there again. */
export const pendingInvitesFor = (email: string): string[] =>
  readInvites()
    .filter((i) => sameEmail(i.email, email) && inviteStatus(i) === 'pending')
    .map((i) => i.id);

export interface Confirmed {
  user: User;
  /** confirmed: the account's own address; changed: a pending new address took over (`previous` is the old one). */
  kind: 'confirmed' | 'changed';
  previous?: string;
  /** The address the account had before was a confirmed one (only those get notices). */
  previousConfirmed?: boolean;
  /** A sign-up that was held until now: the moment for onSignup and the welcome. */
  released: boolean;
}

/**
 * Whether an address is kept by an account: any but a sign-up nobody confirmed, which gives it up to an account whose
 * owner confirms it from that inbox (A12 INV-REV-11).
 */
export const addressKept = (email: string): boolean => {
  const e = accountAddress(email);
  return read().users.some((u) => !isGated(u) && (sameEmail(u.email, email) || (!!e && holdsEmail(u.email, e))));
};

/** An emailed link was used: the address it went to is the account's (or, for a pending change, becomes it). */
export function confirmAddress(userId: string, email: string): Confirmed {
  const squats: string[] = [];
  const done = change((f) => {
    const u = f.users.find((x) => x.id === userId);
    if (!u || u.disabled) throw new Error('this link is for an account that no longer exists');
    if (u.pending_email && u.pending_email === email) {
      const others = f.users.filter((x) => x !== u && holdsEmail(x.email, email));
      if (others.some((x) => !isGated(x))) throw new Error('that address belongs to another account by now');
      // A sign-up nobody confirmed held it: this inbox just said whose it is (A12 INV-REV-11). It goes, as the sweep
      // would have taken it.
      for (const x of others) squats.push(x.id);
      f.users = f.users.filter((x) => !squats.includes(x.id));
      f.tokens = f.tokens.filter((t) => !squats.includes(t.user));
      const previous = u.email;
      const previousConfirmed = !u.unverified;
      u.email = email;
      delete u.pending_email;
      const released = isGated(u);
      delete u.signup_browser;
      delete u.unverified;
      u.proven = isoLocal();
      return { user: { ...u }, kind: 'changed' as const, previous, previousConfirmed, released };
    }
    if (u.email !== email) throw new Error('this link is for an address the account no longer uses');
    const released = isGated(u);
    delete u.signup_browser;
    delete u.unverified;
    u.proven = isoLocal();
    return { user: { ...u }, kind: 'confirmed' as const, released };
  });
  if (squats.length) {
    for (const id of squats) voidLinks(id);
    accessEnded();
  }
  return done;
}

/** A held sign-up keeps the address it signed up with: its confirmation goes there, nowhere else. */
export const HELD_ADDRESS = 'a sign-up keeps its address until that address is confirmed: sign up again with the right one';

/**
 * A new address waits for its link (or, with null, the wait is called off); the account keeps its address meanwhile.
 * `access`: who asked — saved only while that still holds (updateUser). It waits only as long as the sessions it was
 * asked in: ending them all (a new password, a reset, "sign out everywhere", disabling) calls it off.
 */
export function setPendingEmail(userId: string, email: string | null, { access }: { access?: Access } = {}): User {
  const e = email === null ? null : checkEmail(email);
  return change((f) => {
    stillIn(f, access);
    const u = f.users.find((x) => x.id === userId);
    if (!u) throw new Error('no such user');
    waitFor(u, e);
    return { ...u };
  });
}

function waitFor(u: User, e: string | null): void {
  if (e === null || e === u.email) delete u.pending_email;
  else {
    if (isGated(u)) throw new Error(HELD_ADDRESS);
    // An address another account uses waits like any other (its link never comes, and confirmAddress would refuse
    // it): a refusal here would tell anyone who asks which addresses have accounts on this server.
    u.pending_email = e;
  }
}

/**
 * A held account keeps the address it was made with (setPendingEmail refuses a change since AUTH-1). One from before
 * that fix may still wait for a change of address — an invite sign-up whose confirmation an outsider moved to their own
 * inbox, with the invite's role on the account (A12-D7) —: the change and the links sent for it go, so only the
 * address's own inbox can confirm it (and, from anywhere but the browser that signed up, with that password or a new
 * one: server/routes/account.ts). Runs at every start; returns how many it changed.
 */
export function forgetHeldChanges(): number {
  if (!read().users.some((u) => isGated(u) && u.pending_email)) return 0;
  const changed = change((f) => {
    const out: { id: string; to: string }[] = [];
    for (const u of f.users)
      if (isGated(u) && u.pending_email) {
        out.push({ id: u.id, to: u.pending_email });
        delete u.pending_email;
      }
    return out;
  });
  for (const c of changed) voidLinks(c.id, 'verify', c.to);
  return changed.length;
}

/**
 * Sign-ups nobody confirmed within `days` are removed: they could do nothing, and their address is free again. The
 * days count from the sign-up or the newest link sent to its address, whichever came later (A12 INV-REV-10): a link
 * asked for on the sixth day must not lead to an account removed the next morning.
 */
export function sweepUnconfirmed(days = 7, now = Date.now()): number {
  if (!read().users.some(isGated)) return 0;
  const sent = newestLinks();
  const stale = (u: User) => isGated(u) && now - Math.max(Date.parse(u.signup as string), sent.get(`${u.id} ${u.email}`) ?? 0) > days * 86400000;
  if (!read().users.some(stale)) return 0;
  const gone = change((f) => {
    const out = f.users.filter(stale);
    f.users = f.users.filter((u) => !stale(u));
    f.tokens = f.tokens.filter((t) => !out.some((u) => u.id === t.user));
    return out.map((u) => ({ ...u }));
  });
  for (const u of gone) {
    voidLinks(u.id);
    forgetInvitee(u.id);
  }
  if (gone.length) accessEnded();
  for (const u of gone) accountGone(u);
  return gone.length;
}

/**
 * Signs out every session of the user (cookies carry the epoch they were issued for), and calls off a change of address
 * still waiting for its link (endSessions).
 */
export function signOutEverywhere(id: string): void {
  if (!read().users.some((u) => u.id === id)) return;
  const done = change((f) => {
    const u = f.users.find((x) => x.id === id);
    return u ? { waiting: endSessions(u) } : null;
  });
  if (!done) return;
  if (done.waiting) voidLinks(id, 'verify', done.waiting);
  accessEnded();
}

// ---------------------------------------------------------------- API tokens (CLI, MCP, agents)

/** A token without `expires` works until it is revoked (tokens from before expiry existed, and the default). */
export const tokenExpired = (t: Pick<ApiToken, 'expires'>, now = Date.now()): boolean => !!t.expires && Date.parse(t.expires) <= now;

/**
 * A new API token for `userId`, acting in `workspace` (absent: workspace #1, as tokens always did). `access`: the session
 * that asked for it — made only while that still holds (a reset ends the tokens there are; one made after it from a
 * session it ended would outlast it).
 */
export function createToken(
  userId: string,
  name: string,
  { days, workspace, access }: { days?: number | null; workspace?: string; access?: Access } = {},
): { token: string; info: ApiToken } {
  if (days != null && !(Number.isInteger(days) && days >= 1 && days <= 3650)) throw new Error('a token lasts 1 to 3650 days');
  const token = `vr_${crypto.randomBytes(24).toString('base64url')}`;
  const info = change((f) => {
    stillIn(f, access);
    if (!f.users.some((u) => u.id === userId)) throw new Error('no such user');
    const t: ApiToken = {
      id: `t_${crypto.randomBytes(6).toString('hex')}`,
      user: userId,
      name: cutChars(name.trim(), 80) || 'token',
      hash: sha256(token),
      prefix: token.slice(0, 9),
      created: isoLocal(),
      last_used: null,
      ...(days ? { expires: isoLocal(new Date(Date.now() + days * 86400000)) } : {}),
      ...(workspace ? { workspace } : {}),
    };
    f.tokens.push(t);
    return t;
  });
  return { token, info };
}

export const listTokens = (userId?: string): ApiToken[] => read().tokens.filter((t) => !userId || t.user === userId);

/** The workspace a token acts in (absent: workspace #1, tokens from before workspaces). */
export const tokenWorkspace = (t: Pick<ApiToken, 'workspace'>): string => t.workspace || 'w1';

/**
 * The move to workspaces (lib/workspaces.ts migrateWorkspaces): tokens and invites from before name workspace #1
 * outright. Idempotent; says how many it stamped.
 */
export function stampWorkspace(ws = 'w1'): { tokens: number; invites: number } {
  const tokens = read().tokens.some((t) => !t.workspace)
    ? change((f) => {
        let n = 0;
        for (const t of f.tokens)
          if (!t.workspace) {
            t.workspace = ws;
            n++;
          }
        return n;
      })
    : 0;
  const invites = withLock(LOCK_DIR, () => {
    const all = loadInvites();
    let n = 0;
    for (const i of all)
      if (!i.workspace) {
        i.workspace = ws;
        n++;
      }
    if (n) saveInvites(all);
    return n;
  });
  return { tokens, invites };
}

/**
 * Whether a token or an invite names a workspace: only the move to workspaces (above) or a workspace other than #1
 * writes one. lib/workspaces.ts reads it as a sign that the store moved, so a lost workspaces.json is never re-implied.
 */
export const workspaceStamped = (): boolean => read().tokens.some((t) => !!t.workspace) || readInvites().some((i) => !!i.workspace);

/** Revokes a token: one of `userId`'s when given, and only one acting in `workspace` when given (an admin of one
 * workspace never reaches another's tokens). */
export function revokeToken(id: string, userId?: string, workspace?: string): boolean {
  const gone = change((f) => {
    const before = f.tokens.length;
    f.tokens = f.tokens.filter((t) => !(t.id === id && (!userId || t.user === userId) && (workspace === undefined || tokenWorkspace(t) === workspace)));
    return f.tokens.length < before;
  });
  if (gone) accessEnded();
  return gone;
}

/** Someone left a workspace: their tokens for it stop working, the ones for their other workspaces don't. */
/** Every API token of an account, in every workspace (a password reset: whoever had the old password may have made one). */
export function revokeTokensOf(userId: string): number {
  const n = change((f) => {
    const before = f.tokens.length;
    f.tokens = f.tokens.filter((t) => t.user !== userId);
    return before - f.tokens.length;
  });
  if (n) accessEnded();
  return n;
}

export function revokeTokensIn(userId: string, workspace: string): number {
  const n = change((f) => {
    const before = f.tokens.length;
    f.tokens = f.tokens.filter((t) => !(t.user === userId && tokenWorkspace(t) === workspace));
    return before - f.tokens.length;
  });
  if (n) accessEnded();
  return n;
}

/** A workspace was deleted: every token acting in it stops (whoever made it). */
export function revokeTokensInWorkspace(workspace: string): number {
  const n = change((f) => {
    const before = f.tokens.length;
    f.tokens = f.tokens.filter((t) => tokenWorkspace(t) !== workspace);
    return before - f.tokens.length;
  });
  if (n) accessEnded();
  return n;
}

// last_used is written at most once a minute per token, not on every request.
const lastWrite = new Map<string, number>();
/** How often a token's `last_used` is written at most (tests lower it). */
export const TOKEN_TOUCH = { everyMs: 60_000 };

/**
 * The account an API token stands for (null: unknown, revoked, expired, its account disabled). `touch: false` (an open
 * stream asking again whether its caller still gets in) leaves `last_used` alone: it says when the token was last used,
 * not that something is connected with it — and writing users.json makes every reader parse it again (A12-D13).
 */
export function verifyToken(token: string, { touch = true }: { touch?: boolean } = {}): { user: User; token: ApiToken } | null {
  if (!token.startsWith('vr_')) return null;
  const hash = sha256(token);
  const f = read();
  const t = f.tokens.find((x) => crypto.timingSafeEqual(Buffer.from(x.hash), Buffer.from(hash)));
  const user = t && f.users.find((u) => u.id === t.user && !u.disabled);
  if (!t || !user || tokenExpired(t)) return null;
  if (touch && Date.now() - (lastWrite.get(t.id) || 0) >= TOKEN_TOUCH.everyMs) {
    lastWrite.set(t.id, Date.now());
    change((g) => {
      const x = g.tokens.find((y) => y.id === t.id);
      if (x) x.last_used = isoLocal();
    });
  }
  return { user, token: t };
}

// ---------------------------------------------------------------- invites

interface Invite {
  id: string;
  /** sha256 of the token, hex: how an accept finds the invite. */
  hash: string;
  /** The token sealed with a key derived from secret.key, so admins can copy the link again later. */
  sealed: string;
  role: Role;
  name: string | null;
  email: string | null;
  created: string;
  /** Id and name of the admin who invited. */
  by: string;
  by_name: string;
  expires: string;
  accepted?: { at: string; user: string; name: string };
  revoked?: string;
  /** The workspace it joins (absent: workspace #1). */
  workspace?: string;
  /** Emailed to `email`: when last, and how often. */
  sent?: string;
  sent_count?: number;
  /**
   * A server with workspaces: held accounts that accepted the invite and wait for their address to be confirmed (ids).
   * The invite stays pending meanwhile; the first of them whose address is confirmed takes it (takeClaims).
   */
  claims?: string[];
}

/** Held accounts one invite keeps waiting at most (a leaked link that names no address can't grow the file). */
const MAX_CLAIMS = 20;

export const INVITE_DAYS = 7;
const INVITE_MAX_DAYS = 90;

/**
 * The most invites one workspace may have waiting, or ended unused (revoked, expired) within INVITES_KEPT_MS — as long
 * as invites.json keeps them (A13 AUTH-1: one file for the whole server). Counting only the waiting ones, an admin who
 * revoked each invite at once made 60 an hour for ever: 43,000 kept per account (A13 VERIFY-3).
 */
export const INVITES_WAITING_PER_WORKSPACE = 200;

/** The workspace has INVITES_WAITING_PER_WORKSPACE invites waiting or ended unused lately: 429 until some are used or age out. */
export class TooManyInvitesError extends Error {
  status = 429;
  constructor() {
    super(
      `this workspace has ${INVITES_WAITING_PER_WORKSPACE} invites waiting or not used in the last 30 days (the most it may): new ones can be made as they are used, or 30 days after they were revoked or expired`,
    );
  }
}
/** A revoked or expired invite stays this long after it ended (what Settings lists), then leaves the file. */
const INVITES_KEPT_MS = 30 * 86400000;

/** Every invite, parsed now: for a change made under the lock (the objects may be changed and saved). */
function loadInvites(): Invite[] {
  try {
    return (JSON.parse(fs.readFileSync(INVITES_FILE, 'utf8')) as { invites?: Invite[] }).invites || [];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

let invitesRead: { stamp: string; invites: readonly Invite[] } | null = null;
/**
 * Every invite as the file holds them now, parsed once until it changes (its inode, size and time; every save writes a
 * new file): read-only. Every /api/auth/status asks who invited the account (invitedInto), so the whole server's file
 * was parsed per request (A13 AUTH-1).
 */
function readInvites(): readonly Invite[] {
  let st: fs.Stats;
  try {
    st = fs.statSync(INVITES_FILE);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const stamp = `${st.ino}:${st.size}:${st.mtimeMs}`;
  if (invitesRead?.stamp !== stamp) invitesRead = { stamp, invites: Object.freeze(loadInvites().map((i) => Object.freeze(i))) };
  return invitesRead.invites;
}

/** A revoked or expired invite that ended more than INVITES_KEPT_MS ago: nobody lists or takes it any more. */
const longGone = (i: Invite, now = Date.now()): boolean => {
  const status = inviteStatus(i, now);
  if (status !== 'revoked' && status !== 'expired') return false;
  return Date.parse(status === 'revoked' ? (i.revoked as string) : i.expires) <= now - INVITES_KEPT_MS;
};

function saveInvites(invites: Invite[]): void {
  fs.mkdirSync(DATA, { recursive: true });
  // what ended long ago leaves the file; accepted invites stay (who invited whom: invitedInto, acceptedInviteOf)
  const kept = invites.filter((i) => !longGone(i));
  writeAtomic(INVITES_FILE, `${JSON.stringify({ invites: kept }, null, 2)}\n`);
  fs.chmodSync(INVITES_FILE, 0o600);
}

const inviteStatus = (i: Invite, now = Date.now()): PublicInvite['status'] =>
  i.accepted ? 'accepted' : i.revoked ? 'revoked' : Date.parse(i.expires) <= now ? 'expired' : 'pending';

function publicInvite(i: Invite): PublicInvite {
  return {
    ...(i.workspace && i.workspace !== 'w1' ? { workspace: i.workspace } : {}),
    id: i.id,
    role: i.role,
    name: i.name,
    email: i.email,
    created: i.created,
    by: i.by_name,
    expires: i.expires,
    status: inviteStatus(i),
    ...(i.accepted ? { accepted_by: i.accepted.name } : {}),
    ...(i.sent ? { sent: i.sent, sent_count: i.sent_count ?? 1 } : {}),
  };
}

/** An invite was handed to the mailer for its address. */
export function markInviteSent(id: string): PublicInvite | null {
  return withLock(LOCK_DIR, () => {
    const all = loadInvites();
    const i = all.find((x) => x.id === id);
    if (!i) return null;
    i.sent = isoLocal();
    i.sent_count = (i.sent_count ?? 0) + 1;
    saveInvites(all);
    return publicInvite(i);
  });
}

/** A pending invite as admins see it (null when it was used, revoked or has expired). */
export function pendingInvite(id: string): PublicInvite | null {
  const i = readInvites().find((x) => x.id === id);
  return i && inviteStatus(i) === 'pending' ? publicInvite(i) : null;
}

// AES-256-GCM with its own key, derived from the cookie secret: invites.json alone doesn't give the links away.
const sealKey = () => crypto.createHmac('sha256', secret()).update('video-review invites').digest();
function seal(token: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', sealKey(), iv);
  const body = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map(b64).join('.');
}
function unseal(sealed: string): string | null {
  try {
    const [iv, tag, body] = sealed.split('.').map((x) => Buffer.from(x, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', sealKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function createInvite({
  role,
  name,
  email,
  days = INVITE_DAYS,
  by,
  workspace,
  isMember,
  access,
}: {
  role: Role;
  name?: string | null;
  email?: string | null;
  days?: number;
  by: { id: string; name: string };
  /** The workspace it joins (absent: workspace #1). */
  workspace?: string;
  /** Whether an account is in that workspace already. Without it, any account with the address is (no workspaces). */
  isMember?: (user: User) => boolean;
  /**
   * The session of whoever invites: made only while that still holds — disabling an account revokes the invites it
   * made, and one made after it from a session it ended would outlast it (Access).
   */
  access?: Access;
}): { token: string; invite: PublicInvite } {
  if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);
  if (!Number.isFinite(days) || days < 1 || days > INVITE_MAX_DAYS) throw new Error(`an invite lasts 1–${INVITE_MAX_DAYS} days`);
  const n = name?.trim() ? checkName(name) : null;
  const e = email?.trim() ? checkEmail(email) : null;
  // A sign-up held for the address (never confirmed) is no one's account yet: it doesn't keep its owner from an invite.
  const holder = e ? findUserByEmail(e) : null;
  if (e && holder && !isGated(holder) && (isMember ? isMember(holder) : true)) throw new Error(`a user with ${e} already exists`);
  const token = `inv_${crypto.randomBytes(24).toString('base64url')}`;
  const invite: Invite = {
    id: `i_${crypto.randomBytes(6).toString('hex')}`,
    hash: sha256(token),
    sealed: seal(token),
    role,
    name: n,
    email: e,
    created: isoLocal(),
    by: by.id,
    by_name: by.name,
    expires: isoLocal(new Date(Date.now() + days * 86400000)),
    ...(workspace ? { workspace } : {}),
  };
  withLock(LOCK_DIR, () => {
    // invites.json and users.json share this lock: the inviter's access as it is now
    stillIn(load(), access);
    const all = loadInvites();
    const ws = workspace || 'w1';
    // waiting, or ended unused and still in the file: what the workspace's invites hold of it (accepted ones say who
    // invited whom, and each took an account)
    const held = all.filter((i) => inviteWorkspace(i) === ws && !i.accepted && !longGone(i)).length;
    if (held >= INVITES_WAITING_PER_WORKSPACE) throw new TooManyInvitesError();
    saveInvites([...all, invite]);
  });
  return { token, invite: publicInvite(invite) };
}

/** The workspace an invite joins (absent: workspace #1). */
export const inviteWorkspace = (i: Pick<Invite, 'workspace'>): string => i.workspace || 'w1';

/**
 * Whether this account ever made an invite (accepted, pending, revoked or expired: the first run's "Invite" step); in
 * one workspace when given.
 */
export const hasInvited = (userId: string, workspace?: string): boolean =>
  readInvites().some((i) => i.by === userId && (workspace === undefined || inviteWorkspace(i) === workspace));

/** The invite an account was made from or joined with (the newest accepted one), if any. */
export function acceptedInviteOf(userId: string): Pick<Invite, 'role' | 'workspace'> | null {
  const mine = readInvites().filter((i) => i.accepted?.user === userId);
  const last = mine.sort((a, b) => compareTime(b.accepted?.at ?? '', a.accepted?.at ?? ''))[0];
  return last ? { role: last.role, ...(last.workspace ? { workspace: last.workspace } : {}) } : null;
}

/** Who invited an account into a workspace: the newest invite into it that the account accepted (the inviter's id and
 * name then), or null. */
export function invitedInto(userId: string, ws: string): { by: string; byName: string } | null {
  const mine = readInvites().filter((i) => i.accepted?.user === userId && inviteWorkspace(i) === ws);
  const last = mine.sort((a, b) => compareTime(b.accepted?.at ?? '', a.accepted?.at ?? ''))[0];
  return last ? { by: last.by, byName: last.by_name } : null;
}

/** Pending invites, plus what happened to the others in the last 30 days (newest first); one workspace's when given. */
export function listInvites(workspace?: string): PublicInvite[] {
  const recent = Date.now() - 30 * 86400000;
  return readInvites()
    .filter((i) => workspace === undefined || inviteWorkspace(i) === workspace)
    .filter((i) => inviteStatus(i) === 'pending' || Date.parse(i.accepted?.at || i.revoked || i.expires) > recent)
    .sort((a, b) => compareTime(b.created, a.created))
    .map(publicInvite);
}

export function revokeInvite(id: string, workspace?: string): boolean {
  // no such pending invite: nothing to write, and the file isn't parsed again under the lock
  const known = readInvites().find((x) => x.id === id && (workspace === undefined || inviteWorkspace(x) === workspace));
  if (!known || inviteStatus(known) !== 'pending') return false;
  return withLock(LOCK_DIR, () => {
    const all = loadInvites();
    const i = all.find((x) => x.id === id && (workspace === undefined || inviteWorkspace(x) === workspace));
    if (!i || inviteStatus(i) !== 'pending') return false;
    i.revoked = isoLocal();
    saveInvites(all);
    return true;
  });
}

/**
 * A workspace was deleted: its invites go from invites.json, whatever their state (they name invitees' addresses and
 * the workspace). Returns how many.
 */
export function removeInvitesIn(workspace: string): number {
  if (!fs.existsSync(INVITES_FILE)) return 0;
  return withLock(LOCK_DIR, () => {
    const all = loadInvites();
    const keep = all.filter((i) => inviteWorkspace(i) !== workspace);
    if (keep.length !== all.length) saveInvites(keep);
    return all.length - keep.length;
  });
}

/** The link's token of a pending invite, for admins who want to copy it again. */
/** The pending invites someone made stop working once they can't invite any more (removed, disabled, no longer an admin):
 * a link kept from before would bring them back. */
export function revokeInvitesBy(userId: string, workspace?: string): number {
  return withLock(LOCK_DIR, () => {
    const all = loadInvites();
    const mine = all.filter((i) => i.by === userId && inviteStatus(i) === 'pending' && (workspace === undefined || inviteWorkspace(i) === workspace));
    for (const i of mine) i.revoked = isoLocal();
    if (mine.length) saveInvites(all);
    return mine.length;
  });
}

export function inviteToken(id: string, workspace?: string): string | null {
  const i = readInvites().find((x) => x.id === id && (workspace === undefined || inviteWorkspace(x) === workspace));
  return i && inviteStatus(i) === 'pending' ? unseal(i.sealed) : null;
}

function findPending(invites: readonly Invite[], token: string): Invite | null {
  if (!/^inv_[A-Za-z0-9_-]{32}$/.test(token)) return null;
  const want = Buffer.from(sha256(token));
  const i = invites.find((x) => crypto.timingSafeEqual(Buffer.from(x.hash), want));
  return i && inviteStatus(i) === 'pending' ? i : null;
}

export function peekInvite(token: string): InvitePeek | null {
  const i = findPending(readInvites(), token);
  // The address an invite is made out to stays with the admins: a leaked link must not tell its reader what to type.
  return i ? { role: i.role, name: i.name, email: null, by: i.by_name, expires: i.expires } : null;
}

/** Whether a pending invite may be taken by this address (one made out to nobody may be taken by anyone). */
export function inviteFits(token: string, email: string): boolean {
  const i = findPending(readInvites(), token);
  return !!i && (!i.email || sameEmail(i.email, email));
}

/** The workspace a pending invite joins (null when the link isn't valid). */
export function pendingInviteWorkspace(token: string): string | null {
  const i = findPending(readInvites(), token);
  return i ? inviteWorkspace(i) : null;
}

/**
 * What taking an invite came to. `in`: signed in now (a new account its admins vouched for, or an existing account that
 * proved itself with its password). `held`: a held account waits for its address to be confirmed, with the invite
 * kept for it (made now, or one that was there and proved itself with its password). `taken`: the address is another
 * account's (or the password was wrong) and nothing changed — the route answers it exactly like `held`, and the
 * address's inbox decides.
 */
export type Accepted = { kind: 'in'; user: User } | { kind: 'held'; user: User; made: boolean } | { kind: 'taken'; user: User };

/**
 * An invite link used. Without `hold` (a store without workspaces, where its admins vouch for whom they invite): the
 * account is made and the invite used up, atomically — a link works exactly once; an address that has an account,
 * held or not, is refused (a held sign-up is never taken away by someone else's link). `confirm`: the server can
 * email, so a new account whose address nobody vouched for (the invite named none) starts unconfirmed and gets a link.
 *
 * With `hold` (a store with workspaces: whoever runs one may be anyone, and holds the invite's link as much as the
 * person it was sent to, so the link proves nothing about an inbox): an account with the address that gives its own
 * password joins now (`join` adds the membership). Anything else makes nothing confirmed and uses nothing up: a free
 * address gets a held account (the least role, in no workspace) that waits for its address with the invite kept for it
 * (`claims`); the invite's role and workspace are taken when that address is confirmed (takeClaims) — the first account
 * confirmed takes it. An address that has an account and a wrong password changes nothing, held sign-ups included.
 * Everything that doesn't depend on the address (the invite, the name, the password's length, the room left) is
 * checked first, and every address costs the same two hashes, so `held` and `taken` can be answered alike.
 */
export async function acceptInvite(
  token: string,
  { name, email, password }: { name: string; email: string; password: string },
  {
    join,
    nameFree,
    confirm = false,
    hold = false,
    browser,
  }: {
    join?: (user: User, role: Role, workspace: string) => void;
    nameFree?: (name: string, workspace: string) => boolean;
    confirm?: boolean;
    hold?: boolean;
    /** sha256 of the accepting browser's `vr_signup` cookie: a held account's confirm link signs in that browser only. */
    browser?: string;
  } = {},
): Promise<Accepted> {
  const peeked = findPending(readInvites(), token);
  if (!peeked) throw new Error('this invite is not valid anymore');
  const e = checkEmail(email);
  // An invite made out to an e-mail is for that person: a forwarded or leaked link can't be taken by someone else.
  if (peeked.email && !holdsEmail(peeked.email, e)) throw new Error('this invite is for another e-mail address');
  if (!hold) return acceptNow(token, e, name, password, { join, nameFree, confirm });
  const ws = inviteWorkspace(peeked);
  const n = checkName(name);
  checkPassword(password);
  if (nameFree && !nameFree(n, ws)) throw new Error(`the name "${n}" is taken`);
  const holder = findUserByEmail(e);
  const fits = await verifyPassword(password, holder?.password || (await dummyHash()));
  const hash = await hashPassword(password);
  /**
   * The password was checked against `holder` as it was read before the (awaited) check: it proves only the account
   * that is still there now, the same one with the same password (checkLogin's rule). One deleted, disabled or given a
   * new password meanwhile proves nothing, and takes the path of an address that doesn't join now.
   */
  const proven = (now: User | undefined): now is User => !!now && !!holder && fits && now.id === holder.id && now.password === holder.password && !now.disabled;
  if (holder && !holder.disabled && fits && !isGated(holder)) {
    // Its own password proves the account is theirs: it joins now, under its own name.
    if (nameFree && !nameFree(holder.name, ws)) throw new Error(`the name "${holder.name}" is taken`);
    const joined = withLock(LOCK_DIR, () => {
      const now = load().users.find((u) => holdsEmail(u.email, e));
      if (!proven(now) || isGated(now)) return null;
      const all = loadInvites();
      const i = findPending(all, token);
      if (!i) throw new Error('this invite is not valid anymore');
      i.accepted = { at: isoLocal(), user: now.id, name: now.name };
      saveInvites(all);
      return { invite: i, user: { ...now } };
    });
    if (joined) {
      join?.(joined.user, joined.invite.role, inviteWorkspace(joined.invite));
      return { kind: 'in', user: joined.user };
    }
  }
  return withLock(LOCK_DIR, (): Accepted => {
    const invites = loadInvites();
    const invite = findPending(invites, token);
    if (!invite) throw new Error('this invite is not valid anymore');
    const f = load();
    const live = liveClaims(invite, f.users);
    if (live.length >= MAX_CLAIMS) throw new Error('too many people are confirming their address for this invite: ask for a new one');
    const there = f.users.find((u) => holdsEmail(u.email, e));
    if (there && !(isGated(there) && proven(there))) return { kind: 'taken', user: there };
    let user = there;
    if (!user) {
      // The least role and no workspace until the address is confirmed (the invite's role is taken then).
      user = insertUser(f, { email: e, name: n, role: 'reviewer', hash, skipNames: !!nameFree });
      user.unverified = isoLocal();
      user.signup = user.unverified;
      if (browser) user.signup_browser = browser;
      save(f);
    } else if (browser) {
      // Its own held account, taken again with its password: this browser is the one its confirm link signs in.
      user.signup_browser = browser;
      save(f);
    }
    invite.claims = [...live.filter((id) => id !== user.id), user.id];
    saveInvites(invites);
    return { kind: 'held', user: { ...user }, made: !there };
  });
}

/** A store without workspaces: the account is made and the invite used up at once (see acceptInvite). */
async function acceptNow(
  token: string,
  e: string,
  name: string,
  password: string,
  {
    join,
    nameFree,
    confirm,
  }: { join?: (user: User, role: Role, workspace: string) => void; nameFree?: (name: string, workspace: string) => boolean; confirm: boolean },
): Promise<Accepted> {
  const n = checkName(name);
  checkPassword(password);
  const hash = await hashPassword(password);
  const done = withLock(LOCK_DIR, () => {
    const invites = loadInvites();
    const invite = findPending(invites, token);
    if (!invite) throw new Error('this invite is not valid anymore');
    const ws = inviteWorkspace(invite);
    if (nameFree && !nameFree(n, ws)) throw new Error(`the name "${n}" is taken`);
    const f = load();
    // An address that has an account is refused, a held sign-up's too: it is never taken away by someone else's link
    // (its owner confirms it, or takes it over with a reset from its inbox).
    const made = insertUser(f, { email: e, name: n, role: join && ws !== 'w1' ? 'reviewer' : invite.role, hash, skipNames: !!nameFree });
    if (confirm && !invite.email) made.unverified = isoLocal();
    save(f);
    invite.accepted = { at: isoLocal(), user: made.id, name: made.name };
    saveInvites(invites);
    return { user: { ...made }, invite };
  });
  join?.(done.user, done.invite.role, inviteWorkspace(done.invite));
  return { kind: 'in', user: done.user };
}

/** The held accounts an invite still keeps waiting (accounts gone or confirmed meanwhile drop out). */
function liveClaims(invite: Invite, users: readonly User[]): string[] {
  return (invite.claims ?? []).filter((id) => users.some((u) => u.id === id && isGated(u)));
}

/**
 * A held account's address was confirmed from its inbox: the pending invites it accepted are taken now — used up, by
 * this account — and their workspaces and roles returned for the memberships. Invites used by someone else meanwhile,
 * revoked or expired are left as they are. `had`: whether the account had accepted any invite at all.
 */
export function takeClaims(userId: string): { taken: { role: Role; workspace: string }[]; had: boolean } {
  return withLock(LOCK_DIR, () => {
    const all = loadInvites();
    const user = load().users.find((u) => u.id === userId);
    const mine = all.filter((i) => i.claims?.includes(userId));
    const taken: { role: Role; workspace: string }[] = [];
    for (const i of mine) {
      // Only an invite taken lets its claim go: one used by someone else, revoked or expired keeps it, so the account's
      // link is refused again however often it is opened (A12 INV-REV-3) — never let in to no workspace on a second try.
      if (!user || inviteStatus(i) !== 'pending') continue;
      i.claims = i.claims?.filter((id) => id !== userId);
      if (!i.claims?.length) delete i.claims;
      i.accepted = { at: isoLocal(), user: userId, name: user.name };
      taken.push({ role: i.role, workspace: inviteWorkspace(i) });
    }
    if (taken.length) saveInvites(all);
    return { taken, had: mine.length > 0 };
  });
}

/**
 * What confirming a held account would join: the pending invites it took (their workspace, role and who made them).
 * The confirm page shows it to whoever opens the link, so they know whose invite the password belongs to.
 */
export function heldInvitesOf(userId: string): { workspace: string; role: Role; by: string }[] {
  return readInvites()
    .filter((i) => i.claims?.includes(userId) && inviteStatus(i) === 'pending')
    .map((i) => ({ workspace: inviteWorkspace(i), role: i.role, by: i.by_name }));
}

/** The invites a held account accepted stop waiting for it (a reset replaced the password they were accepted with). */
export function dropClaims(userId: string): number {
  return withLock(LOCK_DIR, () => {
    const all = loadInvites();
    const mine = all.filter((i) => i.claims?.includes(userId));
    for (const i of mine) {
      i.claims = i.claims?.filter((id) => id !== userId);
      if (!i.claims?.length) delete i.claims;
    }
    if (mine.length) saveInvites(all);
    return mine.length;
  });
}

// ---------------------------------------------------------------- session cookies

/**
 * A key file that exists but is short (cut off by a full disk, a bad restore) would sign cookies with a key anyone can
 * guess: refuse it instead of using it. `what` says what is lost if the file is deleted to make a new one.
 */
export function checkKey(key: Buffer, file: string, what: string): Buffer {
  if (key.length >= 32) return key;
  throw new Error(`${file} is damaged (${key.length} bytes, a key needs 32): restore it from your backup, or delete it to make a new one (${what}).`);
}

let secretCache: Buffer | null = null;
export function secret(): Buffer {
  if (secretCache) return secretCache;
  // publishing's keys and unfinished uploads are sealed under a key derived from this one (lib/publish/seal.ts: A12 PUB-16)
  const lost =
    'everyone signs in again; pending invite links keep working but can’t be copied again; every publishing connection is added again, and an unfinished upload starts over';
  try {
    secretCache = checkKey(fs.readFileSync(SECRET_FILE), SECRET_FILE, lost);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    fs.mkdirSync(DATA, { recursive: true });
    const key = crypto.randomBytes(32);
    // wx: two processes starting at once must not overwrite each other's key.
    try {
      fs.writeFileSync(SECRET_FILE, key, { mode: 0o600, flag: 'wx' });
      secretCache = key;
    } catch {
      secretCache = checkKey(fs.readFileSync(SECRET_FILE), SECRET_FILE, lost);
    }
  }
  return secretCache;
}

const mac = (payload: string) => crypto.createHmac('sha256', secret()).update(payload).digest('base64url');

/** How long a sign-in lasts at most (LAMPO_SESSION_DAYS), and how long it survives without use (LAMPO_SESSION_IDLE_DAYS). */
export const SESSION_DAYS = Number(settings.LAMPO_SESSION_DAYS) || 30;
export const SESSION_IDLE_DAYS = Number(settings.LAMPO_SESSION_IDLE_DAYS) || 14;
// A session in use gets a fresh "last active" at most this often (one Set-Cookie per half day, not per request).
const REFRESH_MS = 12 * 3600000;

export const DEVICE_DAYS = 365;
// Its own MAC domain, so a device cookie can never pass for a session and back.
const deviceMac = (payload: string) => crypto.createHmac('sha256', secret()).update(`device\n${payload}`).digest('base64url');

/**
 * A browser that signed in to the account before (base64url(JSON {d, x}) + "." + MAC). It grants nothing by itself: it
 * only exempts that browser from the account-wide sign-in limit, so guessing from many addresses can't lock the
 * person out of their own account.
 */
export function signDevice(user: User): string {
  const payload = b64(Buffer.from(JSON.stringify({ d: user.id, x: Date.now() + DEVICE_DAYS * 86400000 })));
  return `${payload}.${deviceMac(payload)}`;
}

/** The account a device cookie was issued for, or null. */
export function deviceAccount(value: string | null | undefined): string | null {
  const [payload, sig] = (value || '').split('.');
  if (!payload || !sig) return null;
  const want = Buffer.from(deviceMac(payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const { d, x } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { d?: string; x?: number };
    return typeof d === 'string' && typeof x === 'number' && x > Date.now() ? d : null;
  } catch {
    return null;
  }
}

/**
 * Signed-out sessions are remembered until they would have expired anyway: dropping one earlier would bring a copy of
 * its cookie back. Successful sign-ins are rate-limited (server/auth.ts), so the list stays small; this cap is only a
 * guard for memory, far above what those limits allow, and says so in the log when it is ever reached.
 */
const MAX_REVOKED = 250_000;

/**
 * Cookie value: base64url(JSON {u, e, x, s, a, w}) + "." + HMAC. `s` names the session, so one can be signed out alone;
 * `x` is its hard end, `a` when it was last in use (it ends after SESSION_IDLE_DAYS without use), `w` the workspace it
 * works in (lib/workspaces.ts; absent: the account's first).
 */
export function signSession(user: User, days = SESSION_DAYS, workspace?: string): string {
  const now = Date.now();
  return sealClaims({
    u: user.id,
    e: user.epoch,
    x: now + days * 86400000,
    s: b64(crypto.randomBytes(12)),
    a: now,
    i: now,
    ...(workspace ? { w: workspace } : {}),
  });
}

/** A sign-in this recent confirms what a password would (deleting your account without typing it again). */
export const RECENT_SIGN_IN_MS = 10 * 60_000;

/**
 * The same session in another workspace (the switcher): same id, same end, a fresh "last active". Null when the cookie
 * isn't a valid session. Whether the account may work there is the caller's business (lib/workspaces.ts).
 */
export function switchSession(value: string, workspace: string, now = Date.now()): { value: string; maxAge: number } | null {
  const claims = claimsOf(value);
  if (!claims || !checkSession(value, now) || typeof claims.x !== 'number') return null;
  return { value: sealClaims({ ...claims, a: now, w: workspace }), maxAge: Math.floor((claims.x - now) / 1000) };
}

function sealClaims(claims: SessionClaims): string {
  const payload = b64(Buffer.from(JSON.stringify(claims)));
  return `${payload}.${mac(payload)}`;
}

interface SessionClaims {
  u?: string;
  e?: number;
  x?: number;
  s?: string;
  /** Last in use (ms); cookies from before idle timeouts have none and simply run until `x`. */
  a?: number;
  /** The workspace the session works in; cookies from before workspaces have none. */
  w?: string;
  /** When the person signed in (ms): kept by refreshes and switches. Cookies from before have none (never recent). */
  i?: number;
}

/** The claims of a cookie we signed, or null (a forged or mangled cookie). Expiry is the caller's business. */
function claimsOf(value: string): SessionClaims | null {
  const [payload, sig] = value.split('.');
  if (!payload || !sig) return null;
  const want = Buffer.from(mac(payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionClaims;
  } catch {
    return null;
  }
}

export interface SessionCheck {
  user: User;
  /** The same session with a fresh "last active", when the cookie's is getting old: send it back. */
  refresh: { value: string; maxAge: number } | null;
  /** The workspace the session works in (null: cookies from before workspaces, or never switched). */
  workspace: string | null;
  /** When the session ends by itself, unless used again (its hard end, or idle): ms since the epoch. */
  until: number;
  /** When the person signed in with it (ms), or null for a cookie from before that was kept. */
  signedIn: number | null;
  /** The session's id (null: a cookie from before session ids, which ends only with its epoch). */
  session: string | null;
}

/** The account a session cookie stands for (null when forged, expired, idle too long, signed out or outdated). */
export function checkSession(value: string, now = Date.now()): SessionCheck | null {
  const claims = claimsOf(value);
  if (!claims?.u || typeof claims.x !== 'number' || claims.x < now) return null;
  if (typeof claims.a === 'number' && now - claims.a > SESSION_IDLE_DAYS * 86400000) return null;
  const { file: f, revoked } = current();
  if (claims.s && revoked.has(claims.s)) return null;
  const user = f.users.find((u) => u.id === claims.u);
  if (!user || user.disabled || user.epoch !== claims.e) return null;
  const stale = typeof claims.a === 'number' && now - claims.a > REFRESH_MS;
  return {
    user,
    refresh: stale ? { value: sealClaims({ ...claims, a: now }), maxAge: Math.floor((claims.x - now) / 1000) } : null,
    workspace: typeof claims.w === 'string' ? claims.w : null,
    until: typeof claims.a === 'number' ? Math.min(claims.x, claims.a + SESSION_IDLE_DAYS * 86400000) : claims.x,
    signedIn: typeof claims.i === 'number' ? claims.i : null,
    session: typeof claims.s === 'string' ? claims.s : null,
  };
}

export const verifySession = (value: string): User | null => checkSession(value)?.user ?? null;

/**
 * Signs out this one session: its id is remembered until the cookie would have expired, so a copy stops working too.
 * Cookies from before session ids can't be told apart; they end with "sign out everywhere" or their expiry.
 */
export function revokeSession(value: string): void {
  const claims = claimsOf(value);
  const s = claims?.s;
  const until = claims?.x;
  if (!s || typeof until !== 'number' || until < Date.now()) return;
  change((f) => {
    const now = Date.now();
    const keep = (f.revoked || []).filter((r) => r.until > now && r.s !== s);
    keep.push({ s, until });
    if (keep.length > MAX_REVOKED) {
      console.warn(`sessions: more than ${MAX_REVOKED} signed-out sessions to remember; forgetting the ones closest to expiring`);
      keep.sort((a, b) => b.until - a.until).length = MAX_REVOKED;
    }
    f.revoked = keep;
  });
  accessEnded();
}
