// What goes with an account or a workspace once it is deleted (A13 PEOPLE-1, PEOPLE-2, CLOUD-5): never more than it
// owns, found by its id — the account's own drafts file, recordings it made, its picture, its devices, its links and
// app connections; a workspace's own folders and its storage prefix. Nothing here walks a store looking for words.
//
// - afterAccountGone: lib/auth.ts tells it (onAccountGone) whenever an account is removed — deleted by a person or the
//   operator, removed from its last workspace, a sign-up nobody confirmed. Its picture, push devices, drafts and unsent
//   recordings (raw microphone audio) in every workspace, its watching (kept in the team's numbers under no name), what
//   it put away in For you, conversion moments waiting for it, app connections, account links, and the copies the move
//   to workspaces made of users.json and friends (data/backups/workspaces-*). Notes and replies it wrote stay with their
//   workspace, signed with its name: they are the team's record of the review (docs/server-mode.md "Deleting").
// - afterMemberGone: someone left one workspace (removed, or they left) and the account goes on elsewhere: their drafts
//   and unsent recordings there go (nobody can send them any more); their watching stays the team's.
// - eraseWorkspaceFiles: a deleted workspace's storage prefix (renders, previews, references, playbooks' files: the
//   adapter's `remove('w/<id>/')`) and its data and cache folders. Never workspace #1 (its folders are the store's own).
// - the erasure log (data/erasures.jsonl): one line per deleted account or workspace — ids only —, so that whoever
//   restores a backup taken before can delete them again (`vr admin erasures --apply`, lib/deletion.ts).
import fs from 'node:fs';
import path from 'node:path';
import { forgetLinksOf } from './accountLinks.ts';
import type { User } from './auth.ts';
import { avatarKey } from './avatars.ts';
import { discardDraftsOf } from './drafts.ts';
import { forgetViewer } from './foryou.ts';
import { forgetMomentsOf } from './moments.ts';
import { forgetGrants } from './oauth/store.ts';
import { DATA, DEFAULT_WORKSPACE, isoLocal, slugify, workspaceRoot } from './paths.ts';
import { forgetDevicesOf } from './push/index.ts';
import { listRecordings, removeRecording } from './recordings.ts';
import { inWorkspace } from './scope.ts';
import { rootStorage } from './storage/index.ts';
import { listReviews, withLock, writeAtomic } from './store.ts';
import { forgetTeamViewer } from './views.ts';

/** What an erasure took (counts only: a report says what went, never whose words). */
export interface ErasureReport {
  avatar: boolean;
  devices: number;
  apps: number;
  drafts: number;
  recordings: number;
  watching: number;
  backups: number;
}

const OTHER_WORKSPACE = /^w_[a-z0-9]{12}$/;

/** A person's things on the videos of the workspace running now: drafts, recordings, and (account gone) watching. */
function eraseInWorkspace(userId: string, { watching }: { watching: boolean }): Pick<ErasureReport, 'drafts' | 'recordings' | 'watching'> {
  const out = { drafts: 0, recordings: 0, watching: 0 };
  for (const r of listReviews()) {
    const slug = slugify(r.video);
    out.drafts += discardDraftsOf(slug, userId);
    for (const rec of listRecordings(slug))
      if (rec.by_id === userId) {
        removeRecording(slug, rec.id);
        out.recordings++;
      }
    if (watching && forgetTeamViewer(slug, userId)) out.watching++;
  }
  forgetViewer(userId);
  if (watching) forgetMomentsOf(userId);
  return out;
}

// What is still being erased (the picture's removal waits on the storage): a deletion's answer waits for it.
const pending = new Set<Promise<unknown>>();
/** Resolves once every erasure started so far has ended. */
export async function erasuresSettled(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}
/**
 * Starts `afterAccountGone` for a removed account and keeps it until it ends (erasuresSettled), and writes the account
 * down in the erasure log: however it went (deleted by its person or the operator, removed from its last workspace, a
 * sign-up nobody confirmed), a restored backup must not bring it back.
 */
export function eraseAccount(u: Pick<User, 'id' | 'avatar'>): void {
  recordErasure('account', u.id, 'removed');
  const p = afterAccountGone(u, storeWorkspaces()).finally(() => pending.delete(p));
  pending.add(p);
}

/**
 * Every workspace this store holds files for: #1 and each folder under data/w/ — what is on the disk, not the registry
 * (an account's drafts are wherever it once worked; a registry that can't be read must not hide them).
 */
export function storeWorkspaces(): string[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(path.join(DATA, 'w')).filter((n) => OTHER_WORKSPACE.test(n));
  } catch {}
  return [DEFAULT_WORKSPACE, ...names];
}

/** Someone left workspace `ws` (and works on elsewhere): what only they could send from there goes. */
export function afterMemberGone(ws: string, userId: string): Pick<ErasureReport, 'drafts' | 'recordings'> {
  try {
    const { drafts, recordings } = inWorkspace(ws, () => eraseInWorkspace(userId, { watching: false }));
    return { drafts, recordings };
  } catch (e) {
    console.error(`erasure: ${userId} leaving ${ws}: ${(e as Error).message}`);
    return { drafts: 0, recordings: 0 };
  }
}

/**
 * The copies the move to workspaces made (data/backups/workspaces-<time>/: users.json, invites.json, oauth/grants.json,
 * shares.json) keep a removed account's address and password hash for good: the account goes from them too, by id.
 * Returns how many files changed.
 */
function scrubMoveBackups(userId: string): number {
  const root = path.join(DATA, 'backups');
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(root).filter((n) => n.startsWith('workspaces-'));
  } catch {
    return 0;
  }
  let changed = 0;
  const rewrite = (file: string, fn: (data: Record<string, unknown>) => boolean) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!fn(data)) return;
    writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
    fs.chmodSync(file, 0o600);
    changed++;
  };
  const without = <T>(list: unknown, gone: (x: T) => boolean): T[] | null => {
    if (!Array.isArray(list)) return null;
    const keep = (list as T[]).filter((x) => !gone(x));
    return keep.length === list.length ? null : keep;
  };
  for (const d of dirs) {
    const dir = path.join(root, d);
    rewrite(path.join(dir, 'users.json'), (data) => {
      const users = without<{ id?: string }>(data.users, (u) => u?.id === userId);
      const tokens = without<{ user?: string }>(data.tokens, (t) => t?.user === userId);
      if (users) data.users = users;
      if (tokens) data.tokens = tokens;
      return !!(users || tokens);
    });
    rewrite(path.join(dir, 'oauth', 'grants.json'), (data) => {
      const grants = without<{ user?: string }>(data.grants, (g) => g?.user === userId);
      if (grants) data.grants = grants;
      return !!grants;
    });
    rewrite(path.join(dir, 'invites.json'), (data) => {
      let hit = false;
      for (const i of Array.isArray(data.invites)
        ? (data.invites as { accepted?: { user?: string }; claims?: string[]; email?: unknown; name?: unknown }[])
        : []) {
        if (i?.claims?.includes(userId)) {
          i.claims = i.claims.filter((c) => c !== userId);
          hit = true;
        }
        if (i?.accepted?.user === userId) {
          i.accepted = { ...i.accepted, user: '', ...('name' in i.accepted ? { name: '' } : {}) };
          i.email = null;
          i.name = null;
          hit = true;
        }
      }
      return hit;
    });
  }
  return changed;
}

/**
 * Everything a removed account kept outside users.json (see the top): run once the account record is gone. `workspaces`:
 * every workspace of the store (an account's drafts may be anywhere it once worked). Never throws: a part that fails is
 * logged and the rest still goes.
 */
export async function afterAccountGone(u: Pick<User, 'id' | 'avatar'>, workspaces: readonly string[]): Promise<ErasureReport> {
  const out: ErasureReport = { avatar: false, devices: 0, apps: 0, drafts: 0, recordings: 0, watching: 0, backups: 0 };
  const step = <T>(what: string, fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (e) {
      console.error(`erasure: ${u.id}: ${what}: ${(e as Error).message}`);
      return undefined;
    }
  };
  out.devices = step('push devices', () => forgetDevicesOf(u.id)) ?? 0;
  out.apps = step('app connections', () => forgetGrants({ user: u.id })) ?? 0;
  step('account links', () => forgetLinksOf(u.id));
  for (const ws of workspaces) {
    const got = step(`workspace ${ws}`, () => inWorkspace(ws, () => eraseInWorkspace(u.id, { watching: true })));
    if (!got) continue;
    out.drafts += got.drafts;
    out.recordings += got.recordings;
    out.watching += got.watching;
  }
  out.backups = step('backups of the move', () => scrubMoveBackups(u.id)) ?? 0;
  // the picture: the one the account names, through the storage adapter (Bunny, S3 or this disk)
  if (u.avatar)
    try {
      await rootStorage().remove(avatarKey(u.avatar));
      out.avatar = true;
    } catch (e) {
      console.error(`erasure: ${u.id}: picture: ${(e as Error).message}`);
    }
  return out;
}

/**
 * A deleted workspace's files: its storage prefix through the adapter (every render, preview, reference and playbook
 * file under `w/<id>/`; on this disk the workspace's versions, data and cache folders), then its data and cache folders
 * (reviews, events, links, playbooks, the inbox: the app's own files). Only a workspace other than #1, by its id.
 */
export async function eraseWorkspaceFiles(ws: string): Promise<void> {
  if (ws === DEFAULT_WORKSPACE || !OTHER_WORKSPACE.test(ws)) throw new Error(`refusing to erase the files of ${JSON.stringify(ws).slice(0, 40)}`);
  await rootStorage().remove(`w/${ws}/`);
  const root = workspaceRoot(ws);
  for (const dir of [root.data, root.cache, root.versions]) fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- the erasure log

export const ERASURES_FILE = path.join(DATA, 'erasures.jsonl');
const LOCK = path.join(DATA, '.erasures');

/** One deleted account or workspace: its id, when, and who asked (`owner`, `operator`, `cli`, `restore`; an account: `removed`). */
export interface Erasure {
  at: string;
  kind: 'account' | 'workspace';
  id: string;
  by: string;
}

/** Writes down that an account or a workspace was deleted (ids only): a restored backup is held to it. */
export function recordErasure(kind: Erasure['kind'], id: string, by: string): void {
  try {
    withLock(LOCK, () => {
      fs.mkdirSync(DATA, { recursive: true });
      fs.appendFileSync(ERASURES_FILE, `${JSON.stringify({ at: isoLocal(), kind, id, by } satisfies Erasure)}\n`, { mode: 0o600 });
    });
  } catch (e) {
    console.error(`erasure log: ${(e as Error).message}`);
  }
}

/** Every deletion written down, oldest first (lines that don't parse are skipped). */
export function listErasures(): Erasure[] {
  let text = '';
  try {
    text = fs.readFileSync(ERASURES_FILE, 'utf8');
  } catch {
    return [];
  }
  const out: Erasure[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Erasure;
      if ((e.kind === 'account' || e.kind === 'workspace') && typeof e.id === 'string' && typeof e.at === 'string') out.push(e);
    } catch {}
  }
  return out;
}
