// Where a screen's preferences are kept, without touching the DOM (lib/prefs.ts passes the browser's storages in; the
// unit test passes its own). View settings live per browser; the keys a screen names as per-tab (a filter someone
// typed) live per tab, so a new tab or a new day starts unfiltered and a stale filter never makes a screen look empty.

export type Prefs = Record<string, string | boolean | undefined>;

/** The part of the Web Storage API used here. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export interface PrefStores {
  /** Per browser: localStorage. */
  kept: KeyValueStore;
  /** Per tab: sessionStorage. */
  tab: KeyValueStore;
}

function read(store: KeyValueStore, key: string): Prefs {
  try {
    return JSON.parse(store.getItem(key) || 'null') || {};
  } catch {
    return {};
  }
}

export function loadPrefs(stores: PrefStores, key: string, perTab: readonly string[] = []): Prefs {
  const out: Prefs = {};
  // Per-tab keys an older version kept per browser are ignored: they are exactly the stale filters this avoids.
  for (const [k, v] of Object.entries(read(stores.kept, key))) if (!perTab.includes(k)) out[k] = v;
  const tab = read(stores.tab, key);
  for (const k of perTab) if (tab[k] !== undefined) out[k] = tab[k];
  return out;
}

export function savePref(stores: PrefStores, key: string, k: string, val: string | boolean | undefined, perTab: readonly string[] = []): Prefs {
  const store = perTab.includes(k) ? stores.tab : stores.kept;
  try {
    store.setItem(key, JSON.stringify({ ...read(store, key), [k]: val }));
  } catch {}
  return loadPrefs(stores, key, perTab);
}
