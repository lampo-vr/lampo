// Per-browser UI preferences (sort order, overlays, phone view…), and per-tab ones a screen names (its filters): see
// lib/prefStore.ts. Never data anyone else needs.
import { useCallback, useEffect, useState } from 'react';
import { type KeyValueStore, loadPrefs, type PrefStores, type Prefs, savePref } from './prefStore.ts';

export type { Prefs };

const CHANGED = 'vr-prefs';
// A storage the browser won't hand out (site data blocked, some private windows) keeps nothing instead of throwing: a
// review link's visitor may browse like that, and a preference is never worth a page that doesn't open.
const nowhere: KeyValueStore = { getItem: () => null, setItem: () => {} };
const reach = (get: () => KeyValueStore): KeyValueStore => {
  try {
    return get();
  } catch {
    return nowhere;
  }
};
const stores = (): PrefStores => ({ kept: reach(() => localStorage), tab: reach(() => sessionStorage) });

/** A screen's preferences as they are kept now, outside React (what a screen's code asks for before it renders). */
export const readPrefs = (key: string, perTab: readonly string[] = []): Prefs => loadPrefs(stores(), key, perTab);

/** Sets one preference from outside the screen that owns it (the command palette, a redirect); a mounted screen follows. */
export function storePref(key: string, k: string, val: string | boolean | undefined, perTab: readonly string[] = []) {
  const next = savePref(stores(), key, k, val, perTab);
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: key }));
  return next;
}

export function usePrefs(key: string, perTab: readonly string[] = []) {
  const [prefs, setPrefs] = useState<Prefs>(() => readPrefs(key, perTab));
  useEffect(() => {
    const f = (e: Event) => (e as CustomEvent<string>).detail === key && setPrefs(readPrefs(key, perTab));
    window.addEventListener(CHANGED, f);
    return () => window.removeEventListener(CHANGED, f);
  }, [key, perTab]);
  const setPref = useCallback((k: string, val: string | boolean | undefined) => setPrefs(storePref(key, k, val, perTab)), [key, perTab]);
  return [prefs, setPref] as const;
}
