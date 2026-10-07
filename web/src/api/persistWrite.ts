// Writing what persist.ts restores: loaded right after the start (nothing of it is needed for the first paint), it
// keeps the screens' data in IndexedDB as it changes, and deletes an account's copy on sign-out or when another
// account signs in here.
import type { Query, QueryClient } from '@tanstack/react-query';
import { keptData } from './keptData.ts';
import { CORE, done, type Entry, guestPage, MAX_BYTES, open, openedDb, ownerOf, persistable, STORE, sizes, WHO, who } from './persist.ts';

/**
 * Keeps the cache's screen data in IndexedDB from now on: what changed is written soon after (when the browser is idle,
 * within a second or so), and at once when the page is hidden or closed.
 */
export function persistQueries(qc: QueryClient): void {
  if (guestPage() || typeof indexedDB === 'undefined') return;
  void open();
  const dirty = new Map<string, Query | null>();
  // What loaded before this module did.
  for (const q of qc.getQueryCache().getAll()) if (persistable(q.queryKey) && q.state.status === 'success') dirty.set(q.queryHash, q);
  const status = qc.getQueryData<{ user?: { id?: string } | null; workspace?: { id: string } | null }>(['auth', 'status']);
  const owner = ownerOf(status);
  if (owner) void setPersistAccount(owner);
  // The server answered before this module arrived: nobody is signed in here any more.
  else if (status && !status.user && who()) void forgetPersisted();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    if (!dirty.size || !who()) return;
    // Synchronously when the database is open: pagehide doesn't wait for promises.
    const opened = openedDb();
    if (opened) write(opened);
    else void open().then((db) => db && write(db));
  };
  const write = (db: IDBDatabase) => {
    const account = who();
    if (!account || !dirty.size) return;
    const batch = [...dirty];
    dirty.clear();
    const puts: Entry[] = [];
    const dels: string[] = [];
    for (const [hash, q] of batch) {
      const data = q ? keptData(q.queryKey, q.state.data) : undefined;
      if (!q || data === undefined || q.state.status !== 'success') {
        dels.push(hash);
        continue;
      }
      let size = 0;
      try {
        size = JSON.stringify(data).length;
      } catch {
        continue;
      }
      puts.push({ who: account, hash, key: q.queryKey, data, at: q.state.dataUpdatedAt, size });
      sizes.set(hash, { size, at: q.state.dataUpdatedAt, core: CORE.has(String(q.queryKey[0])) });
    }
    for (const h of dels) sizes.delete(h);
    // Over the cap: the oldest reviews and waveforms go (the library and For you always stay).
    let total = [...sizes.values()].reduce((s, e) => s + e.size, 0);
    for (const [h, e] of [...sizes].filter(([, e]) => !e.core).sort((a, b) => a[1].at - b[1].at)) {
      if (total <= MAX_BYTES) break;
      total -= e.size;
      sizes.delete(h);
      dels.push(h);
    }
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const e of puts) if (sizes.has(e.hash)) store.put(e);
      for (const h of dels) store.delete([account, h]);
    } catch {}
  };
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      if ('requestIdleCallback' in window) requestIdleCallback(flush, { timeout: 1000 });
      else flush();
    }, 500);
  };
  qc.getQueryCache().subscribe((event) => {
    const q = event.query;
    if (!persistable(q.queryKey)) return;
    // Whoever the server says is signed in is whose data this is. Nobody signed in any more (signed out everywhere, a new
    // password, a session that ran out): the account's copy goes, so the device keeps nothing of it.
    if (q.queryKey[1] === 'status' && event.type === 'updated' && event.action.type === 'success') {
      const status = q.state.data as { user?: { id?: string } | null; workspace?: { id: string } | null } | undefined;
      const id = ownerOf(status);
      if (id) void setPersistAccount(id);
      else if (status && !status.user && who()) void forgetPersisted();
    }
    if (event.type === 'removed') dirty.set(q.queryHash, null);
    else if (event.type === 'updated' && event.action.type === 'success') dirty.set(q.queryHash, q);
    else return;
    schedule();
  });
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
}

/**
 * The account the app runs as now (from /api/auth/status). Another account than last time: the other one's entries
 * are deleted, so a shared browser never shows one person's library to the next.
 */
export async function setPersistAccount(account: string | null): Promise<void> {
  const before = who();
  if (before === account) return;
  try {
    if (account) localStorage.setItem(WHO, account);
    else localStorage.removeItem(WHO);
  } catch {}
  if (before) await forget(before);
}

/** Signing out: nothing of this account stays in the browser. */
export async function forgetPersisted(): Promise<void> {
  const account = who();
  try {
    localStorage.removeItem(WHO);
  } catch {}
  sizes.clear();
  if (account) await forget(account);
}

async function forget(account: string): Promise<void> {
  try {
    const db = await open();
    if (!db) return;
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    const keys = await done(store.index('who').getAllKeys(account));
    for (const k of keys) store.delete(k);
  } catch {}
}
