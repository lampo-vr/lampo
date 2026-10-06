// What signing out leaves in the browser's storage (A12 WEB-7): only what belongs to the device or to a review link's
// visitor. Everything else under `vr.` is the account's — folder paths, project names, slugs (disk paths on the
// machine), the last folder on the machine, what Insights remembered — and goes, in localStorage and sessionStorage
// alike. A new key is the account's unless it is listed here.
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

export function forgetAccountStorage(store: Store): void {
  try {
    const gone: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k?.startsWith('vr.') && !DEVICE_KEYS.has(k) && k !== LEFT_TO_FORGET_PERSISTED) gone.push(k);
    }
    for (const k of gone) store.removeItem(k);
  } catch {
    // storage blocked (private mode, site data off): nothing was kept there either
  }
}
