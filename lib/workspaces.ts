// Workspaces: many teams on one hosted server, each seeing only its own videos, notes, links, playbooks, events and
// people. An account (data/users.json) belongs to no workspace; a membership gives it a role in one.
//
//   data/workspaces.json  {"workspaces": [{id, name, created, members: [{user, role, since}]}]}   (0600)
//
// Workspace #1 (`w1`) is the store as it always was: `data/`, its storage keys and caches stay where they are. Every
// other workspace lives in `data/w/<id>/` (lib/paths.ts workspaceRoot), its renders under the storage key prefix
// `w/<id>/` (lib/storage). Which workspace a piece of work is for travels with it (lib/scope.ts).
//
// Until a hosted store is migrated (migrateWorkspaces: a backup, then the file) it has no workspaces.json, and it is
// workspace #1 alone, its members every account with the account's own `role` — exactly how a store without
// workspaces always worked. The app on a person's own machine stays that way for good.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as auth from './auth.ts';
import { type Config, loadConfig, WORKSPACE_CREATE_LIMIT } from './config.ts';
import { afterMemberGone, eraseAccount } from './erasure.ts';
import { setJobOwner } from './jobs.ts';
import { cleanDisplayName } from './names.ts';
import { grantsElsewhere, revokeAppsIn, revokeAppsOf, stampGrants } from './oauth/store.ts';
import { isOperator, type OperatorConfig } from './operator.ts';
import { DATA, isoLocal, workspaceRoot } from './paths.ts';
import { DEFAULT_WORKSPACE, setStrictWorkspaces, WORKSPACE_ID } from './scope.ts';
import { deepFreeze, withLock, writeAtomic } from './store.ts';
import { compareTime } from './time.ts';
import type { MyWorkspace, Persona, Role, StoredWorkspace, WorkspaceInfo, WorkspaceMember, WorkspacesFile } from './types.ts';

export { workspaceRoot } from './paths.ts';
export { currentWorkspace, DEFAULT_WORKSPACE, inWorkspace, WORKSPACE_ID, wsKey } from './scope.ts';

export const WORKSPACES_FILE = path.join(DATA, 'workspaces.json');
const LOCK_DIR = path.join(DATA, '.workspaces');
const BACKUPS = path.join(DATA, 'backups');

/** A rule about memberships was broken (the last owner, someone who also works elsewhere): the caller's 4xx. */
export class WorkspaceError extends Error {
  status: number;
  /** What a page shows for it (`invite`: the invite is gone; `name`: another name is needed to join). */
  state?: string;
  constructor(message: string, status = 400, state?: string) {
    super(message);
    this.status = status;
    if (state) this.state = state;
  }
}

// ---------------------------------------------------------------- reading

/**
 * workspaces.json is missing or unreadable on a store that moved to workspaces. Nothing is implied then: without the
 * file every account would be a member of workspace #1 (every other team reading the first one's work), and the next
 * start would write that down for good. Everything that asks for a membership fails until the file is back: a running
 * server answers 503 with `publicText` (lib/publicError.ts) and logs the state once (server/feed.ts), a start refuses.
 */
export class WorkspacesLostError extends Error {
  status = 503;
  /** What anyone but the machine's owner is told: the server's state, not the request's (no path, no ref). */
  publicText = 'the server can’t read its list of workspaces right now: try again later';
}

const names = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

/** Whether anything but empty folders is in dir (a few levels down): what a workspace that was used leaves. */
function holdsFiles(dir: string, depth = 4): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((e) => !e.isDirectory() || (depth > 0 && holdsFiles(path.join(dir, e.name), depth - 1)));
}

/**
 * A hosted store, whatever the process was started with: accounts, and none of them the machine's own owner (the app on
 * a person's own machine makes `local` at its first start). What reads a store goes by what the store is, not by the
 * shell it is read from: an operator's `vr` without VR_MODE=server reads the server's store (A12 VE1r2-3).
 */
function hostedStore(): boolean {
  if (workspacesEnabled()) return true;
  const users = auth.listUsers();
  return users.length > 0 && !users.some((u) => u.local);
}

/** The workspace folders in data/w (empty ones too). */
const workspaceFolders = (): string[] => names(path.join(DATA, 'w')).filter((n) => WORKSPACE_ID.test(n));

/**
 * What says a store moved to workspaces once, file or no file, and what to do about it — or null for a store that never
 * moved (the app on a person's own machine, a hosted store before its first start). The backup the move makes first, a
 * token or invite that names a workspace, an app connection in another workspace: only the move or a moved store makes
 * these, and the move writes the file, so it was there and a backup of the store holds it. So does another
 * workspace's folder on a hosted store, empty or not: there a workspace's folders are made with it (createWorkspace),
 * and a workspace nobody has used yet still has members (A12 VE1-2) — but a folder alone can't tell a moved store from
 * one that never had workspaces and kept a folder a mistyped VR_WORKSPACE once left, so it names both ways out, and no
 * backup as certain. The app on a person's own machine never makes a workspace: there only a folder with something in
 * it counts. `every`: every folder counts, whatever the store (the move itself, which would write #1 alone over them).
 */
function signsOfMove({ every = false }: { every?: boolean } = {}): { why: string; until: string } | null {
  const signs: string[] = [];
  if (names(BACKUPS).some((n) => n.startsWith('workspaces-'))) signs.push(`a backup from the move in ${BACKUPS}`);
  if (auth.workspaceStamped()) signs.push('API tokens or invites that name a workspace');
  if (grantsElsewhere()) signs.push('app connections in another workspace');
  const W = path.join(DATA, 'w');
  const all = every || hostedStore();
  const used = workspaceFolders().filter((n) => all || holdsFiles(path.join(W, n)));
  const folders = `workspace folders${all ? '' : ' with files'} in ${W} (${used.slice(0, 3).join(', ')}${used.length > 3 ? ', …' : ''})`;
  if (signs.length) {
    if (used.length) signs.push(folders);
    return { why: `is missing, but this store moved to workspaces (${signs.join('; ')})`, until: `it is back: restore it from your backup of ${DATA}` };
  }
  if (!used.length) return null;
  return {
    why: `is missing, but this store has ${folders}`,
    until: all
      ? `it is back: if this store had workspaces, restore it from your backup of ${DATA}; if it never had (a folder a mistyped VR_WORKSPACE once left), move those folders out of ${W}`
      : `it is back: if this store never had workspaces, those folders are left over (made with a mistyped VR_WORKSPACE) — move them out of ${W}; if it had, put workspaces.json back`,
  };
}

const lost = (why: string, until: string): WorkspacesLostError =>
  new WorkspacesLostError(
    `${WORKSPACES_FILE} ${why}. Without it every account would become a member of workspace #1, so nothing that needs a workspace runs until ${until}.`,
  );
const unreadable = (e: unknown): WorkspacesLostError =>
  lost(
    `can't be read (${(e as NodeJS.ErrnoException).code || (e as Error).message})`,
    `it can be read again (if it is damaged: restore it from your backup of ${DATA})`,
  );

// Every request asks for a role, so the file is parsed again only when it changed (inode, size, mtime), like
// users.json; what reads return is shared and frozen. Only an answer is kept — the file as parsed, or "no file, and
// this store never moved" —, never a failure: a read that fails (EACCES, EMFILE, EIO on a busy disk, a damaged file)
// and a missing file on a store that moved are looked into again on the next call, so a moment's failure never
// outlasts itself and the file put back counts at once.
let parsed: { key: string; file: WorkspacesFile | null } | null = null;
function stored(): WorkspacesFile | null {
  try {
    const { file } = readRegistry();
    many = { at: Date.now(), value: (file?.workspaces.length ?? 0) > 1 };
    return file;
  } catch (e) {
    // Lost or unreadable: nothing may run outside a workspace either (lib/scope.ts), as on a server with several.
    many = { at: Date.now(), value: true };
    throw e;
  }
}

function readRegistry(): NonNullable<typeof parsed> {
  let key = 'none';
  try {
    const st = fs.statSync(WORKSPACES_FILE);
    key = `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch (e) {
    // not ENOENT (EACCES, EIO …): whether the file is there can't be told, so nothing is implied
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw unreadable(e);
  }
  if (parsed?.key === key) return parsed;
  if (key === 'none') {
    const moved = signsOfMove();
    if (moved) throw lost(moved.why, moved.until);
    parsed = { key, file: null };
    return parsed;
  }
  let raw: Partial<WorkspacesFile>;
  try {
    raw = JSON.parse(fs.readFileSync(WORKSPACES_FILE, 'utf8')) as Partial<WorkspacesFile>;
    if (!Array.isArray(raw?.workspaces)) throw new Error('no list of workspaces in it');
  } catch (e) {
    throw unreadable(e);
  }
  parsed = { key, file: deepFreeze({ workspaces: raw.workspaces.filter((w) => WORKSPACE_ID.test(w?.id)) }) };
  return parsed;
}

/** Throws WorkspacesLostError when the store moved to workspaces and its workspaces.json is missing or unreadable. */
export function checkWorkspaces(): void {
  stored();
}

/** Workspace #1's name until someone names it: the team's (org_name / VR_ORG_NAME), else a plain word. */
const defaultName = (): string => loadConfig().org_name || 'Workspace';

/**
 * A store without workspaces.json: workspace #1, every account a member with its own role — except someone who signed
 * up on their own (VR_SIGNUP=open) without an invite: they get a workspace of their own (placeSignup), never this one.
 */
function implied(): WorkspacesFile {
  const all = auth.listUsers().filter((u) => !u.outside_w1);
  const users = all.some((u) => u.signup) ? all.filter((u) => !u.signup || auth.acceptedInviteOf(u.id)) : all;
  const created = users.map((u) => u.created).sort(compareTime)[0] || '';
  return {
    workspaces: [{ id: DEFAULT_WORKSPACE, name: defaultName(), created, members: users.map((u) => ({ user: u.id, role: u.role, since: u.created })) }],
  };
}

const registry = (): WorkspacesFile => stored() ?? implied();

/** Whether this store has workspaces.json (a hosted store after migrateWorkspaces); else it is workspace #1 alone. */
export const isMigrated = (): boolean => stored() !== null;

// Work outside a request or job is refused once there is more than one workspace (lib/scope.ts). Asked often (every
// path a background task resolves), so the answer is kept for a second; changes made here update it at once.
let many = { at: 0, value: false };
const hasMany = (): boolean => {
  if (Date.now() - many.at > 1000) {
    try {
      stored();
    } catch {}
    many.at = Date.now();
  }
  return many.value;
};
setStrictWorkspaces(hasMany);

// An account removed anywhere (deleted, removed from its last workspace, a sign-up nobody confirmed): what it kept
// outside users.json goes after it (lib/erasure.ts). Registered here: every process that removes accounts loads this.
auth.onAccountGone(eraseAccount);

// The background queue takes turns by who runs a workspace (lib/jobs.ts): its first owner. One account's many workspaces
// share that account's turn; a registry that can't be read makes each workspace its own (the queue catches it).
setJobOwner((ws) => getWorkspace(ws)?.members.find((m) => m.role === 'owner')?.user ?? null);

/** Every workspace (shared and frozen). */
export const listWorkspaces = (): readonly StoredWorkspace[] => registry().workspaces;
export const workspaceIds = (): string[] => listWorkspaces().map((w) => w.id);
export const getWorkspace = (id: string): StoredWorkspace | null => listWorkspaces().find((w) => w.id === id) ?? null;
export const workspaceInfo = (w: StoredWorkspace): WorkspaceInfo => ({ id: w.id, name: w.name, created: w.created });
/** The workspace made for an account's own sign-up (VR_SIGNUP=open), or null (server/extension.ts placeSignupOf). */
export const signupWorkspaceOf = (userId: string): string | null => listWorkspaces().find((w) => w.signup && w.by === userId)?.id ?? null;

/**
 * A process working on this store directly (`vr`, the stdio MCP server) in workspace `id` (VR_WORKSPACE): it must be
 * one the store has. An unknown id would work in an empty store of its own under `w/<id>/`, named nowhere — notes and
 * renders no one in the app ever sees (audit A12-D1).
 */
export function checkProcessWorkspace(id: string): void {
  if (id === DEFAULT_WORKSPACE || getWorkspace(id)) return;
  throw new WorkspaceError(`VR_WORKSPACE=${id} is not a workspace of this store (vr admin workspaces lists them)`);
}

/** Whether this instance hosts workspaces at all: a hosted server (never the app on a person's own machine). */
export const workspacesEnabled = (): boolean => loadConfig().mode === 'server';

/** The members of a workspace (none when it doesn't exist). */
export function membersOf(ws: string): readonly WorkspaceMember[] {
  if (ws === DEFAULT_WORKSPACE && !isMigrated()) return implied().workspaces[0]?.members ?? [];
  return getWorkspace(ws)?.members ?? [];
}

/**
 * Whether an account is a member of a workspace at all — a suspended one too (an invite or a claim taken later never
 * makes it a second member, nor lets it in again: that is the workspace's admins' to do).
 */
const isMember = (ws: string, userId: string): boolean => membersOf(ws).some((m) => m.user === userId) || !!roleIn(ws, userId);

/** The role an account has in a workspace, or null when it isn't a member (or the account is disabled). */
export function roleIn(ws: string, userId: string): Role | null {
  const user = auth.getUser(userId);
  if (!user || user.disabled) return null;
  // A store without workspaces.json: everyone is in #1 — but someone who signed up on their own (implied(), above)
  if (ws === DEFAULT_WORKSPACE && !isMigrated()) return user.outside_w1 || (user.signup && !auth.acceptedInviteOf(user.id)) ? null : user.role;
  const m = getWorkspace(ws)?.members.find((x) => x.user === userId);
  return m && !m.suspended ? m.role : null;
}

/**
 * The workspaces an account works in, with its role in each (oldest membership first). `suspended`: also those where an
 * admin disabled it — it is still a member there (what decides whose account it is, and whether it may go).
 */
export function workspacesOf(userId: string, { suspended = false }: { suspended?: boolean } = {}): { workspace: StoredWorkspace; role: Role }[] {
  const out: { workspace: StoredWorkspace; role: Role; since: string }[] = [];
  for (const w of listWorkspaces()) {
    const m = w.members.find((x) => x.user === userId);
    if (m && (suspended || !m.suspended)) out.push({ workspace: w, role: m.role, since: m.since });
  }
  return out.sort((a, b) => (a.workspace.id === DEFAULT_WORKSPACE ? -1 : b.workspace.id === DEFAULT_WORKSPACE ? 1 : compareTime(a.since, b.since)));
}

/** Where an account works when nothing says otherwise: workspace #1 if it is a member there, else its first one. */
export function homeWorkspace(userId: string): string | null {
  return workspacesOf(userId)[0]?.workspace.id ?? null;
}

/** The workspace a session works in: the one it names while the account is a member there, else its home. */
export function sessionWorkspace(userId: string, named: string | null | undefined): string | null {
  if (named && roleIn(named, userId)) return named;
  return homeWorkspace(userId);
}

/** The workspaces an account belongs to, as the switcher shows them. */
export function myWorkspaces(userId: string, current: string): MyWorkspace[] {
  return workspacesOf(userId).map(({ workspace, role }) => ({
    ...workspaceInfo(workspace),
    role,
    members: workspace.members.length,
    current: workspace.id === current,
    ...(workspace.signup ? { signup: true as const } : {}),
    ...(workspace.id === current && auth.invitedInto(userId, workspace.id) ? { invited: true as const } : {}),
    // who its videos are for: the one this session works in (its words and Get started follow them), not the others
    ...(workspace.id === current && workspace.personas?.length ? { personas: [...workspace.personas] } : {}),
    ...(workspace.id === current && workspace.personaOther ? { personaOther: workspace.personaOther } : {}),
    // read-only for now (the operator's takedown): the people there see a banner, never the operator's reason
    ...(workspace.suspended ? { suspended: workspace.suspended.at } : {}),
  }));
}

/** Whether a person chose the workspace's name (its owner's first run asks for one when it was made at sign-up). */
export const workspaceNamed = (ws: string): boolean => {
  const w = getWorkspace(ws);
  return !!w && (!w.signup || !!w.named);
};

/** Whether `name` reads like a name someone in workspace `ws` has already (names on notes must tell people apart). */
export function nameTaken(ws: string, name: string, exceptUser?: string): boolean {
  return membersOf(ws).some((m) => {
    if (m.user === exceptUser) return false;
    const u = auth.getUser(m.user);
    return !!u && auth.namesClash(u.name, name);
  });
}

// ---------------------------------------------------------------- what billing hears (server/extension.ts)

export type WorkspaceChange =
  | { type: 'created'; workspace: string; members: number; email?: string }
  | { type: 'members'; workspace: string; members: number }
  | { type: 'deleted'; workspace: string };

const listeners = new Set<(e: WorkspaceChange) => void>();
/** Hears every workspace created and every change of a workspace's member count; returns the unsubscribe. */
export function onWorkspaceChange(fn: (e: WorkspaceChange) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(e: WorkspaceChange): void {
  for (const fn of listeners) {
    try {
      fn(e);
    } catch (err) {
      console.error('workspace listener:', (err as Error).message);
    }
  }
}

// ---------------------------------------------------------------- writing

function save(f: WorkspacesFile): void {
  fs.mkdirSync(DATA, { recursive: true });
  writeAtomic(WORKSPACES_FILE, `${JSON.stringify(f, null, 2)}\n`);
  fs.chmodSync(WORKSPACES_FILE, 0o600);
  many = { at: Date.now(), value: f.workspaces.length > 1 };
}

/** Changes the file under its lock; the store must be migrated (see migrateWorkspaces). */
function change<T>(fn: (f: WorkspacesFile) => T): T {
  return withLock(LOCK_DIR, () => {
    const raw = JSON.parse(fs.readFileSync(WORKSPACES_FILE, 'utf8')) as WorkspacesFile;
    const f: WorkspacesFile = { workspaces: (raw.workspaces || []).map((w) => ({ ...w, members: [...w.members] })) };
    const out = fn(f);
    save(f);
    return out;
  });
}

function owned(f: WorkspacesFile, ws: string): StoredWorkspace {
  const w = f.workspaces.find((x) => x.id === ws);
  if (!w) throw new WorkspaceError('no such workspace', 404);
  return w;
}

const activeOwners = (w: StoredWorkspace) => w.members.filter((m) => m.role === 'owner' && !m.suspended && !auth.getUser(m.user)?.disabled).length;

/** A workspace's name as people typed it: cleaned (no invisible characters), 1–80 characters. */
export function checkWorkspaceName(raw: string): string {
  const n = cleanDisplayName(String(raw ?? ''));
  if (!n || n.length > 80) throw new WorkspaceError('a workspace name is 1–80 characters');
  return n;
}

function backupFiles(): string {
  const stamp = isoLocal().replace(/[:+]/g, '').replace(/\..*$/, '');
  const dir = path.join(BACKUPS, `workspaces-${stamp}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const rel of ['users.json', 'invites.json', path.join('oauth', 'grants.json'), 'shares.json']) {
    const from = path.join(DATA, rel);
    if (!fs.existsSync(from)) continue;
    const to = path.join(dir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.copyFileSync(from, to);
    fs.chmodSync(to, 0o600);
  }
  return dir;
}

/**
 * Moves a hosted store to workspaces, once: a backup of the files it touches first (data/backups/workspaces-…/), then
 * API tokens, invites and app connections from before name workspace #1 outright, then data/workspaces.json with
 * workspace #1 and every account as a member with its role. Nothing on disk moves: workspace #1 is `data/` as it was.
 * Idempotent: a migrated store is left alone.
 */
export function migrateWorkspaces(): { migrated: boolean; backup: string | null } {
  if (isMigrated()) return { migrated: false, backup: null };
  // Never #1 alone over another workspace's folder, whatever the store looks like and whoever runs it (A12 VE1r2-3).
  const left = signsOfMove({ every: true });
  if (left) throw lost(left.why, left.until);
  const backup = backupFiles();
  auth.stampWorkspace(DEFAULT_WORKSPACE);
  stampGrants(DEFAULT_WORKSPACE);
  const migrated = withLock(LOCK_DIR, () => {
    if (fs.existsSync(WORKSPACES_FILE)) return false;
    save(implied());
    return true;
  });
  return { migrated, backup };
}

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** `w_` + 12 random characters (62 bits): nobody finds another team's workspace by counting. */
function newWorkspaceId(f: WorkspacesFile): string {
  for (;;) {
    const id = `w_${[...crypto.randomBytes(12)].map((b) => ID_CHARS[b % ID_CHARS.length]).join('')}`;
    if (!f.workspaces.some((w) => w.id === id)) return id;
  }
}

/**
 * The workspaces an account made (`by`; one made before that was kept counts for its first member, who made it). What
 * VR_WORKSPACE_CREATE_LIMIT counts (A12-D9).
 */
const madeBy = (f: WorkspacesFile, userId: string): number =>
  f.workspaces.filter((w) => w.id !== DEFAULT_WORKSPACE && (w.by ?? w.members[0]?.user) === userId).length;

/** How many workspaces an account has made on this server (createWorkspace's `limit` counts them). */
export const workspacesMadeBy = (userId: string): number => madeBy(registry(), userId);

/**
 * The most workspaces this account may have made (VR_WORKSPACE_CREATE_LIMIT where anyone may make them, A12-D9), or
 * none: whoever runs the server (lib/operator.ts) has no limit — never a role in workspace #1 as such.
 */
export const createLimitOf = (userId: string, cfg: Pick<Config, 'workspace_create_limit'> & OperatorConfig): number | undefined =>
  isOperator(cfg, userId) ? undefined : (cfg.workspace_create_limit ?? WORKSPACE_CREATE_LIMIT);

/**
 * Whether this account may make a workspace here (VR_WORKSPACE_CREATE: `owners`, the default, is whoever runs the
 * server; `anyone` adds everyone signed in, a few each): what POST /api/workspaces allows, and what the account menu
 * offers (/api/auth/status `workspace_create`).
 */
export function mayCreateWorkspace(userId: string, cfg: Pick<Config, 'workspace_create' | 'workspace_create_limit'> & OperatorConfig): boolean {
  if (!workspacesEnabled()) return false;
  if (isOperator(cfg, userId)) return true;
  if (cfg.workspace_create !== 'anyone') return false;
  return workspacesMadeBy(userId) < (createLimitOf(userId, cfg) ?? Number.POSITIVE_INFINITY);
}

/**
 * A new workspace with one member, its owner — what a sign-up on a hosted server makes (a fresh Free workspace; the
 * plan is the billing module's business, server/extension.ts hears `created`). Its folders are made at once; the store
 * is migrated first when it hasn't been (with its backup). Only on a hosted server. `limit`: the most workspaces the
 * owner may have made, this one included (counted under the lock, so two requests at once can't both pass it).
 */
export function createWorkspace({ name, ownerId, signup = false, limit }: { name: string; ownerId: string; signup?: boolean; limit?: number }): WorkspaceInfo {
  if (!workspacesEnabled()) throw new WorkspaceError('workspaces are for a hosted server (VR_MODE=server)', 409);
  const owner = auth.getUser(ownerId);
  if (!owner || owner.disabled) throw new WorkspaceError('no such account', 404);
  const n = checkWorkspaceName(name);
  migrateWorkspaces();
  const info = change((f) => {
    // A sign-up gets one workspace: two clicks on its link at once find the one the first made (checked under the lock).
    const placed = signup ? f.workspaces.find((w) => w.members.some((m) => m.user === owner.id)) : undefined;
    if (placed) return { ...workspaceInfo(placed), existed: true };
    if (limit !== undefined && madeBy(f, owner.id) >= limit)
      throw new WorkspaceError(`one account makes at most ${limit} workspace${limit === 1 ? '' : 's'} on this server`, 403);
    const id = newWorkspaceId(f);
    const created = isoLocal();
    const members: WorkspaceMember[] = [{ user: owner.id, role: 'owner', since: created }];
    // A sign-up's workspace starts with a placeholder name; one made in the app or with `vr admin` was named by a person.
    f.workspaces.push({ id, name: n, created, members, by: owner.id, ...(signup ? { signup: true as const } : { named: created }) });
    return { id, name: n, created, existed: false };
  });
  const { existed, ...made } = info;
  if (existed) return made;
  for (const dir of Object.values(workspaceRoot(made.id))) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  mirrorW1(owner.id);
  emit({ type: 'created', workspace: made.id, members: 1, email: owner.email });
  return made;
}

// ---------------------------------------------------------------- the operator's takedown (A13 CLOUD-5)

/**
 * The server's operator suspended the workspace: a request may read but not write there (server/permissions.ts
 * authorize, MCP's tools, upload URLs, the publish queue), and its review links answer 410 (server/workspace.ts). 423:
 * the request itself was fine. The words are the same for everyone; the operator's reason is never in them.
 */
export class WorkspaceSuspendedError extends Error {
  status = 423;
  publicText = 'this workspace is suspended by whoever runs this server: everything in it is read-only for now';
  constructor() {
    super('this workspace is suspended by whoever runs this server: everything in it is read-only for now');
  }
}

/** The workspace's suspension, or null (not suspended, or no such workspace). A registry that can't be read throws. */
export function suspensionOf(ws: string): StoredWorkspace['suspended'] | null {
  if (ws === DEFAULT_WORKSPACE && !isMigrated()) return null;
  return getWorkspace(ws)?.suspended ?? null;
}

/** Throws WorkspaceSuspendedError when nothing may be written in the workspace now. */
export function checkWritable(ws: string): void {
  if (suspensionOf(ws)) throw new WorkspaceSuspendedError();
}

/**
 * Suspends a workspace (`reason`: the operator's one line, kept for the operator's page) or lifts it (null). Never the
 * server's own workspace: its operator works there. Returns whether anything changed; access ends either way for
 * whatever holds a stream open (accessEnded), so a stopped link's open page and a write in flight ask again.
 */
export function suspendWorkspace(ws: string, on: { by: string; reason: string } | null): boolean {
  if (ws === DEFAULT_WORKSPACE) throw new WorkspaceError('the server’s own workspace can’t be suspended', 409);
  const changed = change((f) => {
    const w = owned(f, ws);
    if (!on) {
      if (!w.suspended) return false;
      delete w.suspended;
      return true;
    }
    if (w.suspended) return false;
    w.suspended = { at: isoLocal(), by: on.by, reason: on.reason };
    return true;
  });
  if (changed) auth.accessEnded();
  return changed;
}

/**
 * Takes a deleted workspace out of the registry, with its memberships (lib/deletion.ts deleteWorkspace removes what it
 * held and the accounts left in none). Never the server's own workspace. Returns the workspace as it was.
 */
export function dropWorkspace(ws: string): StoredWorkspace {
  if (ws === DEFAULT_WORKSPACE) throw new WorkspaceError('the server’s own workspace can’t be deleted', 409);
  return change((f) => {
    const w = owned(f, ws);
    f.workspaces = f.workspaces.filter((x) => x !== w);
    return { ...w, members: [...w.members] };
  });
}

/** A workspace was deleted: whoever listens (the billing module: it stops billing it) hears it. */
export function workspaceDeleted(ws: string): void {
  emit({ type: 'deleted', workspace: ws });
}

/** Renames a workspace (Settings → Workspace). Workspace #1 of a store without workspaces.json migrates it first. */
export function renameWorkspace(ws: string, name: string): WorkspaceInfo {
  const n = checkWorkspaceName(name);
  if (!isMigrated()) {
    if (ws !== DEFAULT_WORKSPACE) throw new WorkspaceError('no such workspace', 404);
    migrateWorkspaces();
  }
  return change((f) => {
    const w = owned(f, ws);
    w.name = n;
    w.named = isoLocal();
    return workspaceInfo(w);
  });
}

/** The most "Something else" keeps: a few words, not a brief. */
export const PERSONA_OTHER_MAX = 120;

/**
 * Who a workspace's videos are for, as its owner picked them in the setup (several; an empty list clears them).
 * "Something else" in a few words is kept only with `other` among the picks, cleaned to one line. Workspace #1 of a
 * store without workspaces.json migrates it first (like a rename).
 */
export function setPersonas(ws: string, personas: readonly Persona[], other?: string): StoredWorkspace {
  const picks = [...new Set(personas)];
  const words = picks.includes('other') ? [...cleanDisplayName((other ?? '').replace(/\s+/g, ' '))].slice(0, PERSONA_OTHER_MAX).join('').trim() : '';
  if (!isMigrated()) {
    if (ws !== DEFAULT_WORKSPACE) throw new WorkspaceError('no such workspace', 404);
    migrateWorkspaces();
  }
  return change((f) => {
    const w = owned(f, ws);
    if (picks.length) w.personas = picks;
    else delete w.personas;
    if (words) w.personaOther = words;
    else delete w.personaOther;
    return { ...w, members: [...w.members] };
  });
}

/** Its admins hid "Powered by Lampo" on its review links (whether its plan lets them is the billing provider's to say). */
export const badgeHidden = (ws: string): boolean => getWorkspace(ws)?.badge === 'hidden';

/**
 * Hides "Powered by Lampo" on the workspace's review links, or shows it again (A13 CLOUD-7). The route asks the billing
 * provider first; workspace #1 of a store without workspaces.json migrates it first (like a rename).
 */
export function setBadgeHidden(ws: string, hidden: boolean): StoredWorkspace {
  if (!isMigrated()) {
    if (ws !== DEFAULT_WORKSPACE) throw new WorkspaceError('no such workspace', 404);
    migrateWorkspaces();
  }
  return change((f) => {
    const w = owned(f, ws);
    if (hidden) w.badge = 'hidden';
    else delete w.badge;
    return { ...w, members: [...w.members] };
  });
}

/**
 * Where a person whose held account was just confirmed works (server/signup.ts, the onSignup seam):
 * - the invites the account accepted while held (lib/auth.ts takeClaims): their workspaces, with their roles — the
 *   first account confirmed takes an invite; one that someone else took meanwhile, or that was revoked, is gone, and
 *   then the link is refused unused (`409`) unless the server is open to sign-ups;
 * - `reset`: the address was proven with a reset link, which replaced the password the invites were accepted with —
 *   whoever accepted them may not have been the address's owner, so they are dropped (the invites stay pending: their
 *   person takes them with the new password);
 * - anyone else on a server open to sign-ups (VR_SIGNUP=open) gets a workspace of their own, empty, as its owner —
 *   never the existing team's; on any other server nobody gets one here (null).
 * An invite taken at accept time by a held sign-up of an earlier release still places it as before. Runs again
 * harmlessly (a second click on the same link): nothing changes for someone who is placed already.
 */
export function placeSignup(userId: string, { reset = false }: { reset?: boolean } = {}): { workspace: string | null; created: boolean } {
  const user = auth.getUser(userId);
  if (!user) throw new WorkspaceError('no such account', 404);
  const invite = auth.acceptedInviteOf(userId);
  if (invite) {
    const ws = invite.workspace || DEFAULT_WORKSPACE;
    if (isMigrated() && !roleIn(ws, userId)) addMember(ws, userId, invite.role);
    return { workspace: ws, created: false };
  }
  const open = loadConfig().signup === 'open';
  if (reset) auth.dropClaims(userId);
  else {
    // Names tell people apart inside a workspace (notes are signed with them): one that reads like a member's there waits
    // for another name, before any invite is taken (A12 INV-REV-4). It was checked when the invite was taken; someone
    // may have joined under it since.
    for (const c of auth.heldInvitesOf(userId))
      if (nameTaken(c.workspace, user.name, userId))
        throw new WorkspaceError(`someone in that workspace already goes by "${user.name}": choose another name to join it`, 409, 'name');
    const { taken, had } = auth.takeClaims(userId);
    for (const t of taken) if (!isMember(t.workspace, userId)) addMember(t.workspace, userId, t.role);
    if (taken[0]) return { workspace: taken[0].workspace, created: false };
    if (had && !open) throw new WorkspaceError('the invite you accepted was taken by someone else or withdrawn meanwhile: ask for a new one', 409);
  }
  const home = homeWorkspace(userId);
  if (home) return { workspace: home, created: false };
  if (!open) return { workspace: null, created: false };
  const made = createWorkspace({ name: cleanDisplayName(user.name) || user.name, ownerId: userId, signup: true });
  return { workspace: made.id, created: true };
}

/**
 * Workspace #1's role written onto the account (`User.role`, what a store read without workspaces.json goes by) after
 * its memberships changed: its role there, or none (`outside_w1`) for an account that isn't a member of #1 — someone
 * who left keeps nothing there to come back with, someone made for another team never had anything (A12 VE1-2).
 */
function mirrorW1(userId: string): void {
  if (!isMigrated()) return;
  auth.mirrorRole(userId, getWorkspace(DEFAULT_WORKSPACE)?.members.find((m) => m.user === userId && !m.suspended)?.role ?? null);
}

/** Every account's #1 mirror as the registry has it (at a hosted start: accounts from before the mirror was kept). */
export function syncRoleMirrors(): void {
  if (!isMigrated()) return;
  for (const u of auth.listUsers()) mirrorW1(u.id);
}

/** Adds an account to a workspace with a role (an invite accepted, an admin adding someone, a sign-up). */
export function addMember(ws: string, userId: string, role: Role): void {
  if (!auth.ROLES.includes(role)) throw new WorkspaceError(`role must be one of ${auth.ROLES.join(', ')}`);
  if (!isMigrated()) {
    // A store without workspaces has every account in workspace #1 already, with the account's role.
    if (ws !== DEFAULT_WORKSPACE) throw new WorkspaceError('no such workspace', 404);
    return;
  }
  const members = change((f) => {
    const w = owned(f, ws);
    if (w.members.some((m) => m.user === userId)) throw new WorkspaceError('already a member of this workspace', 409);
    w.members.push({ user: userId, role, since: isoLocal() });
    return w.members.length;
  });
  mirrorW1(userId);
  emit({ type: 'members', workspace: ws, members });
}

/** Changes a member's role; a workspace always keeps an active owner. */
export async function setMemberRole(ws: string, userId: string, role: Role): Promise<void> {
  if (!auth.ROLES.includes(role)) throw new WorkspaceError(`role must be one of ${auth.ROLES.join(', ')}`);
  if (!isMigrated()) {
    if (ws !== DEFAULT_WORKSPACE) throw new WorkspaceError('no such workspace', 404);
    try {
      await auth.updateUser(userId, { role });
    } catch (e) {
      throw new WorkspaceError((e as Error).message);
    }
    return;
  }
  const was = change((f) => {
    const w = owned(f, ws);
    const m = w.members.find((x) => x.user === userId);
    if (!m) throw new WorkspaceError('not a member of this workspace', 404);
    if (m.role === 'owner' && role !== 'owner' && activeOwners(w) <= 1) throw new WorkspaceError('the last owner cannot be demoted');
    const before = m.role;
    m.role = role;
    return before;
  });
  mirrorW1(userId);
  // Invites someone sent stop working once they may no longer invite (as on a store without workspaces).
  if ((was === 'owner' || was === 'admin') && role !== 'owner' && role !== 'admin') auth.revokeInvitesBy(userId, ws);
}

/**
 * Takes someone out of a workspace: their API tokens, app connections and pending invites for it stop working. An
 * account left in no workspace at all goes too (as removing someone always did on a store without workspaces).
 * `account`: whether the account itself was removed.
 */
export function removeMember(ws: string, userId: string): { account: boolean } {
  if (!isMigrated()) {
    if (ws !== DEFAULT_WORKSPACE) throw new WorkspaceError('no such workspace', 404);
    try {
      auth.deleteUser(userId);
    } catch (e) {
      throw new WorkspaceError((e as Error).message);
    }
    revokeAppsOf(userId);
    return { account: true };
  }
  const members = change((f) => {
    const w = owned(f, ws);
    const m = w.members.find((x) => x.user === userId);
    if (!m) throw new WorkspaceError('not a member of this workspace', 404);
    if (m.role === 'owner' && activeOwners(w) <= 1 && !auth.getUser(userId)?.disabled) throw new WorkspaceError('the last owner cannot be removed');
    w.members = w.members.filter((x) => x !== m);
    return w.members.length;
  });
  auth.revokeTokensIn(userId, ws);
  revokeAppsIn(userId, ws);
  auth.revokeInvitesBy(userId, ws);
  let account = false;
  if (!workspacesOf(userId, { suspended: true }).length) {
    auth.deleteUser(userId, { memberships: true });
    revokeAppsOf(userId);
    account = true;
  } else {
    mirrorW1(userId);
    // their drafts and unsent recordings here: nobody can send them any more (the account's own go with it, above)
    afterMemberGone(ws, userId);
  }
  emit({ type: 'members', workspace: ws, members });
  // (a session works in the workspace too, not only its tokens and apps: whatever it holds open asks again at once)
  auth.accessEnded();
  return { account };
}

/**
 * Whether an admin of `ws` may change the account itself (its name, email, password): only when the account works
 * nowhere else — a workspace that disabled it counts. Otherwise one team could take over a person another team relies on.
 */
export function accountIsOnlyIn(ws: string, userId: string): boolean {
  return workspacesOf(userId, { suspended: true }).every((x) => x.workspace.id === ws);
}

/** Whether disabling the account would leave a workspace without an active owner. */
export function lastOwnerAnywhere(userId: string): boolean {
  return workspacesOf(userId).some(({ workspace, role }) => role === 'owner' && activeOwners(workspace) <= 1);
}

/**
 * An admin of `ws` disables someone there, or lets them in again (A12 INV-REV-2). Whoever runs a workspace may be
 * anyone, so this never reaches the account (a disabled account is shut out everywhere, and no reset, sign-up or other
 * invite brings its address back): the membership is suspended — no role here, this workspace's tokens, apps and the
 * invites they sent end, open streams ask again — and the account goes on elsewhere. A workspace keeps an active owner.
 */
export function suspendMember(ws: string, userId: string, on: boolean): void {
  change((f) => {
    const w = owned(f, ws);
    const m = w.members.find((x) => x.user === userId);
    if (!m) throw new WorkspaceError('not a member of this workspace', 404);
    if (!on) {
      delete m.suspended;
      return;
    }
    if (m.suspended) return;
    if (m.role === 'owner' && activeOwners(w) <= 1) throw new WorkspaceError('the last owner cannot be disabled');
    m.suspended = isoLocal();
  });
  mirrorW1(userId);
  if (!on) return;
  auth.revokeTokensIn(userId, ws);
  revokeAppsIn(userId, ws);
  auth.revokeInvitesBy(userId, ws);
  auth.accessEnded();
}

/** When an admin of `ws` disabled the account there (null: not suspended, or not a member). */
export const suspendedIn = (ws: string, userId: string): string | null => membersOf(ws).find((m) => m.user === userId)?.suspended ?? null;

// ---------------------------------------------------------------- accounts that join a workspace

/**
 * A new account in workspace `ws` with `role` (setup's first owner, an admin's "Add user", `vr admin create-user`). On a
 * store without workspaces.json: an account with that role, as always. Otherwise its name only has to differ from the
 * workspace's people, and the role is its membership's.
 */
export async function createAccountIn(ws: string, input: { email: string; name: string; password: string; role: Role }): Promise<auth.User> {
  if (!isMigrated()) {
    if (ws !== DEFAULT_WORKSPACE) throw new WorkspaceError('no such workspace', 404);
    return auth.createUser(input);
  }
  if (!getWorkspace(ws)) throw new WorkspaceError('no such workspace', 404);
  const user = await auth.createUser({ ...input, role: ws === DEFAULT_WORKSPACE ? input.role : 'reviewer', nameFree: (n) => !nameTaken(ws, n) });
  addMember(ws, user.id, input.role);
  return user;
}

/**
 * An invite link used (lib/auth.ts acceptInvite). A store without workspaces: a new account with the invite's role,
 * as always. A store with workspaces: an account that gives its own password joins the invite's workspace now; any
 * other answer is a held account (or nothing), and the invite's workspace and role wait for the address to be
 * confirmed (placeSignup) — whoever made the invite holds its link too, so it vouches for no inbox.
 */
export function acceptInviteIn(
  token: string,
  input: { name: string; email: string; password: string },
  { confirm = false, browser }: { confirm?: boolean; browser?: string } = {},
): Promise<auth.Accepted> {
  if (!isMigrated()) return auth.acceptInvite(token, input, { confirm });
  return auth.acceptInvite(token, input, {
    confirm,
    hold: true,
    ...(browser ? { browser } : {}),
    join: (user, role, ws) => {
      if (!isMember(ws, user.id)) addMember(ws, user.id, role);
    },
    nameFree: (n, ws) => !nameTaken(ws, n),
  });
}
