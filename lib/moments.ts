// The one-time conversion moments a workspace has (web/src/conversion/): `loop`, the first fix someone checked on a video
// of the workspace's own (not the sample), waiting for whoever checked it; `link_open`, the first time one of its review
// links was opened, waiting for whoever made the link. Each happens once per workspace, waits a day at most, and once
// shown never waits again. Kept in the workspace's own folder (dataDir()/moments.json, 0600): who it waits for is an
// account of that workspace, the link by the name its maker gave it, never a visitor. What a person put away (until when)
// lives with their account instead (lib/auth.ts setMomentHidden): it follows them to every device.
import fs from 'node:fs';
import path from 'node:path';
import { counting } from './funnel.ts';
import { dataDir } from './paths.ts';
import { withLock, writeAtomic } from './store.ts';
import type { PendingMoment } from './types.ts';

/** A one-time moment waits this long for its person. */
export const PENDING_MS = 24 * 3600_000;

interface Stored extends PendingMoment {
  /** The account it waits for. */
  for: string;
  /** When it was shown (it never waits again). */
  seen?: string;
}
type MomentsFile = Partial<Record<PendingMoment['id'], Stored>>;

const file = () => path.join(dataDir(), 'moments.json');

function read(): MomentsFile | null {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8')) as MomentsFile;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? {} : null;
  }
}

/** Changes the workspace's file under its lock; nothing when it can't be read (never written over). */
function change(fn: (f: MomentsFile) => boolean): boolean {
  const dir = dataDir();
  try {
    return withLock(path.join(dir, '.moments'), () => {
      const f = read();
      if (!f || !fn(f)) return false;
      fs.mkdirSync(dir, { recursive: true });
      writeAtomic(file(), `${JSON.stringify(f)}\n`);
      fs.chmodSync(file(), 0o600);
      return true;
    });
  } catch (e) {
    console.error(`moments: ${(e as Error).message}`);
    return false;
  }
}

// The workspaces whose moment was set already (by folder and moment): the visits and checks after it read no file.
const had = new Set<string>();

/**
 * The workspace's first `id` happened now, for `account`: it waits for them unless the workspace had it before. True
 * when it was set (the caller tells their open pages). Only where conversion is counted (a hosted server with billing).
 */
export function notice(id: PendingMoment['id'], account: string | null | undefined, o: { slug?: string; link?: string } = {}, now = Date.now()): boolean {
  if (!counting() || !account) return false;
  const key = `${dataDir()}|${id}`;
  if (had.has(key)) return false;
  let existed = false;
  const set = change((f) => {
    existed = !!f[id];
    if (existed) return false;
    f[id] = {
      id,
      for: account,
      at: new Date(now).toISOString(),
      ...(o.slug ? { slug: o.slug } : {}),
      ...(o.link ? { link: o.link.slice(0, 120) } : {}),
    };
    return true;
  });
  if (set || existed) had.add(key);
  return set;
}

/** What waits for `account` in the session's workspace: not shown yet, within its day. */
export function pendingFor(account: string, now = Date.now()): PendingMoment[] {
  const f = read() ?? {};
  return Object.values(f)
    .filter((m): m is Stored => !!m && m.for === account && !m.seen && now - Date.parse(m.at) < PENDING_MS)
    .map(({ for: _for, seen: _seen, ...m }) => m);
}

/**
 * The account went (lib/erasure.ts): a moment that waited for it waits for nobody now. It stays as the workspace's
 * "happened once" (never again for anyone else), without the account's id.
 */
export function forgetMomentsOf(account: string, now = Date.now()): boolean {
  return change((f) => {
    let changed = false;
    for (const m of Object.values(f))
      if (m && m.for === account) {
        m.for = '';
        m.seen ??= new Date(now).toISOString();
        changed = true;
      }
    return changed;
  });
}

/** It was shown: it never waits again, for anyone. Only its own person marks it. */
export function markSeen(id: PendingMoment['id'], account: string, now = Date.now()): boolean {
  return change((f) => {
    const m = f[id];
    if (!m || m.for !== account || m.seen) return false;
    m.seen = new Date(now).toISOString();
    return true;
  });
}
