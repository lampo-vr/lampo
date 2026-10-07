// Who this browser was signed in as last time, for the first paint before the server has answered: the chrome that
// depends on the role (Add video in the top bar, the list of settings sections) is there from the start instead of
// popping in a moment later and pushing things aside — and whether the first run's strip showed, so its room above
// the library's toolbar is there too, and the sidebar's Get started row with its count. Per browser; wrong at worst
// once, for someone whose role changed.
import type { Role } from '../api/types.ts';

const KEY = 'vr.chrome';

interface Hint {
  role?: Role;
  firstRun?: boolean;
  /** What the library held last time: an empty one has no sidebar, so its loading state has none either. */
  library?: 'empty' | 'full';
  /** The sidebar's Get started row showed (onboarding/Row.tsx). */
  start?: boolean;
}
const read = (): Hint => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') as Hint;
  } catch {
    return {};
  }
};

export const chromeRole = (): Role => read().role ?? 'owner';

/** The first run showed here last time (onboarding/state.ts). */
export const chromeFirstRun = (): boolean => !!read().firstRun;

/** Someone was signed in in this browser before (so the app's data calls will most likely be answered). */
export function hasChromeHint(): boolean {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

/** What the library held when this browser saw it last, or null: never seen here (a new account's first visit). */
export const chromeLibrary = (): 'empty' | 'full' | null => read().library ?? null;

function remember(hint: Hint) {
  try {
    const next = JSON.stringify(hint);
    if (next !== localStorage.getItem(KEY)) localStorage.setItem(KEY, next);
  } catch {}
}

export function rememberRole(role: Role, firstRun = false) {
  const { library, start } = read();
  remember({ role, ...(firstRun ? { firstRun } : {}), ...(library ? { library } : {}), ...(start ? { start } : {}) });
}

/** The sidebar's Get started row showed here last time (onboarding/Row.tsx). */
export const chromeStart = (): boolean => read().start === true;

export function rememberStart(start: boolean) {
  const { start: _, ...rest } = read();
  remember(start ? { ...rest, start } : rest);
}

export function rememberLibrary(empty: boolean) {
  remember({ ...read(), library: empty ? 'empty' : 'full' });
}
