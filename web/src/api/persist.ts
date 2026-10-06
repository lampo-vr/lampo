// What this browser last showed, kept in IndexedDB so the next start paints it at once and only asks the server what
// changed (stale-while-revalidate: every restored query is stale, so the screen that uses it refetches right away —
// with an ETag, mostly a 304). Kept per account (IndexedDB itself is per server origin), versioned (a new VERSION
// ignores older entries), capped in size (the oldest reviews go first), never for client links, and deleted on
// sign-out. Only screens' data is kept: no tokens, review links, search results or anything a guest sees.
// This file reads (it runs at every start); persistWrite.ts writes and forgets (loaded right after the start).
import type { QueryClient, QueryKey } from '@tanstack/react-query';

/** Bump when a cached response shape changes in a way old code or new code can't read. */
const VERSION = 1;
const DB = 'vr-cache';
export const STORE = 'queries';
/** Older than this, a cache isn't worth showing: the start waits for the server. */
const MAX_AGE = 14 * 24 * 3600_000;
/** Everything kept for one account (JSON length, a fair stand-in for what IndexedDB stores). */
export const MAX_BYTES = 12 * 1024 * 1024;
/** Who was signed in here last (the account id): the next start restores that account's entries. */
export const WHO = 'vr.cache.who';

export interface Entry {
  who: string;
  hash: string;
  key: QueryKey;
  data: unknown;
  at: number;
  size: number;
}

// Reviews and waveforms are many; the rest is one per kind. Core kinds are never evicted.
export const CORE = new Set(['library', 'info', 'for-you', 'auth', 'sessions', 'insights', 'push', 'billing']);
const MANY = new Set(['review', 'waveform', 'tracks']);
export function persistable(key: QueryKey): boolean {
  const [kind, second] = key as [unknown, unknown];
  if (kind === 'auth') return second === 'status' || second === 'people';
  if (kind === 'sessions') return key.length === 1;
  // the plan (a banner's room at first paint), never the account: no addresses, VAT IDs or cards in this browser
  if (kind === 'billing') return key.length === 1;
  return typeof kind === 'string' && (CORE.has(kind) || MANY.has(kind));
}

/**
 * Whose kept data it is: the account, and on a hosted server with workspaces the workspace it works in (workspace #1
 * keeps the bare account id, as before workspaces) — another workspace's library must never paint for a moment.
 */
export const ownerKey = (userId: string, workspace?: string | null): string => (workspace && workspace !== 'w1' ? `${userId}@${workspace}` : userId);
/** The owner key of what /api/auth/status says. */
export const ownerOf = (status: { user?: { id?: string } | null; workspace?: { id: string } | null } | undefined): string | null =>
  status?.user?.id ? ownerKey(status.user.id, status.workspace?.id) : null;

export const guestPage = () => location.pathname.startsWith('/g/');
export const who = (): string | null => {
  try {
    return localStorage.getItem(WHO);
  } catch {
    return null;
  }
};

let dbPromise: Promise<IDBDatabase | null> | null = null;
/** The open database once it is: a page being closed can still write, but only without waiting for anything. */
let opened: IDBDatabase | null = null;
export const openedDb = (): IDBDatabase | null => opened;
export function open(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, VERSION);
      // A new VERSION starts empty: entries of another shape are never read.
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name);
        db.createObjectStore(STORE, { keyPath: ['who', 'hash'] }).createIndex('who', 'who');
      };
      req.onsuccess = () => {
        const db = req.result;
        // Closed from outside (the server's Clear-Site-Data after signing out everywhere or a reset, the person clearing
        // the site's data): the next use opens it again instead of holding on to a dead connection.
        db.onclose = () => {
          if (opened !== db) return;
          opened = null;
          dbPromise = null;
        };
        opened = db;
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

export const done = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

let reading: Promise<Entry[]> | null = null;
/** The entries of whoever was signed in here last; first called as early as possible (main.tsx) to overlap loading. */
export const readPersisted = (): Promise<Entry[]> => {
  reading ??= read();
  return reading;
};

async function read(): Promise<Entry[]> {
  const account = who();
  if (!account || guestPage()) return [];
  try {
    const db = await open();
    if (!db) return [];
    const all = await done(db.transaction(STORE).objectStore(STORE).index('who').getAll(account) as IDBRequest<Entry[]>);
    return all.filter((e) => Date.now() - e.at < MAX_AGE);
  } catch {
    return [];
  }
}

/** What is kept, by query hash (the writer's size accounting). */
export const sizes = new Map<string, { size: number; at: number; core: boolean }>();

// This page's start: what is kept was fetched before it, what the server answers now after it.
const started = Date.now();
/** Whether data last updated at `updatedAt` is still what an earlier visit kept (restore), not yet answered anew. */
export const keptFromBefore = (updatedAt: number): boolean => updatedAt < started;

/** Puts restored entries into the cache as they were (with their age: they are stale, and refetch when used). */
export function restore(qc: QueryClient, entries: Entry[]): void {
  for (const e of entries) {
    if (!persistable(e.key) || qc.getQueryData(e.key) !== undefined) continue;
    qc.setQueryData(e.key, e.data, { updatedAt: e.at });
    // However young it is, kept data may miss what happened since it was written (the last write of a closing tab
    // doesn't always land): every restored query asks again as soon as a screen uses it.
    void qc.invalidateQueries({ queryKey: e.key, exact: true, refetchType: 'none' });
    sizes.set(e.hash, { size: e.size, at: e.at, core: CORE.has(String(e.key[0])) });
  }
}
