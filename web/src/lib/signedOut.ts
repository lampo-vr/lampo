// What signing out leaves in the browser's storage (A12 WEB-7): only what belongs to the device or to a review link's
// visitor. Everything else under `vr.`, and tus's resume entries (`tus::`), is the account's — folder paths, project
// names, slugs (disk paths on the machine), the last folder on the machine, what Insights remembered, the uploads it left
// unfinished — and goes, in localStorage and sessionStorage alike. A new key is the account's unless it is listed here.
import { LANG_KEY, THEME_KEY } from '../../../lib/themeBoot.ts';

/** The device's choices (theme, language) and a review link visitor's own (guest/watch.ts, guest/guest.ts). */
export const DEVICE_KEYS: ReadonlySet<string> = new Set([THEME_KEY, LANG_KEY, 'vr.g.visitor', 'vr.guestName']);
/** Whose kept data IndexedDB holds (api/persist.ts WHO): forgetPersisted (api/persistWrite.ts) reads it to delete that
 * data, then removes it itself. Named here, not imported: this module stays free of the browser-only persist code. */
export const LEFT_TO_FORGET_PERSISTED = 'vr.cache.who';

/** The part of Web Storage used here. */
interface Store {
  readonly length: number;
  key(i: number): string | null;
  removeItem(key: string): void;
}

/** tus-js-client's resume entries (`tus::<fingerprint>::<n>`): a file's area, path and name, and its upload's URL. */
export const TUS_PREFIX = 'tus::';

export function forgetAccountStorage(store: Store): void {
  try {
    const gone: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k?.startsWith('vr.') && !DEVICE_KEYS.has(k) && k !== LEFT_TO_FORGET_PERSISTED) gone.push(k);
      // the uploads this account left unfinished: where they went and what they were named
      else if (k?.startsWith(TUS_PREFIX)) gone.push(k);
    }
    for (const k of gone) store.removeItem(k);
  } catch {
    // storage blocked (private mode, site data off): nothing was kept there either
  }
}

// What lives in memory for the account (the upload stores: their batches, files and the Try again that would send them):
// each store says how it forgets, and signing out runs them all (api/auth.ts afterSignOut). A store whose code never
// loaded has nothing to forget.
const resets = new Set<() => void>();
export function onSignOut(reset: () => void): void {
  resets.add(reset);
}
export function forgetInMemory(): void {
  for (const reset of resets)
    try {
      reset();
    } catch {
      // one store's trouble keeps none of the others from forgetting
    }
}
