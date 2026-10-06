// The videos opened last, newest first: the sidebar's Recent and the palette's first group. Kept in this browser for
// the account the kept data belongs to (api/persist.ts WHO), so a shared browser never shows one person's list to the
// next, and forgotten on sign-out. Only the owner app's player adds to it — never a client's review link.
// Per browser for now: across devices it can come from the viewing records the server keeps for Insights.
import { useMemo, useSyncExternalStore } from 'react';
import { WHO } from '../api/persist.ts';

const KEY = 'vr.recent';
const CHANGED = 'vr-recent';

import { EMPTY, type KeptRecent, opened, parseKept, RECENT_KEEP, RECENT_SHOWN, recentFor, without } from './recentList.ts';

export { EMPTY, type KeptRecent, opened, parseKept, RECENT_KEEP, RECENT_SHOWN, recentFor, without };

const raw = (): string | null => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
const account = (): string | null => {
  try {
    return localStorage.getItem(WHO);
  } catch {
    return null;
  }
};
function write(next: KeptRecent | null) {
  try {
    if (next) localStorage.setItem(KEY, JSON.stringify(next));
    else localStorage.removeItem(KEY);
  } catch {}
  window.dispatchEvent(new Event(CHANGED));
}

/** The player opened `slug`. */
export function rememberOpened(slug: string): void {
  const kept = parseKept(raw());
  const next = opened(kept, account(), slug);
  if (next !== kept) write(next);
}

/** Drops videos that are gone from the list (the library knows which). */
export function forgetGone(gone: (slug: string) => boolean): void {
  const kept = parseKept(raw());
  const next = without(kept, gone);
  if (next !== kept) write(next);
}

/** Signing out: nothing of the account stays in the browser. */
export function forgetRecent(): void {
  write(null);
}

const subscribe = (fn: () => void) => {
  const storage = (e: StorageEvent) => (e.key === KEY || e.key === WHO) && fn();
  window.addEventListener(CHANGED, fn);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(CHANGED, fn);
    window.removeEventListener('storage', storage);
  };
};
// One string for the snapshot, so it only changes when the list or the account does.
const snapshot = () => `${account() ?? ''}\n${raw() ?? ''}`;

/** The slugs opened last by the account using the app here, newest first (other tabs included). */
export function useRecent(): string[] {
  const snap = useSyncExternalStore(subscribe, snapshot, () => '');
  return useMemo(() => {
    const at = snap.indexOf('\n');
    return recentFor(parseKept(snap.slice(at + 1)), snap.slice(0, at) || null);
  }, [snap]);
}
