// Screen changes as a View Transition: the old screen steps aside and fades, the new one comes in from the side you
// are heading (deeper: from the right; back: from the left). Only between screens (library → player → …), not within
// one (a folder of the library, a note of the player). Browsers without the API, reduced motion and hidden tabs
// switch at once. The animation itself is CSS (styles/ui.css, ::view-transition-*).
import type { Route } from './nav.ts';

const DEPTH: Record<Route['name'], number> = {
  library: 0,
  status: 1,
  settings: 1,
  player: 2,
  print: 3,
  guest: 0,
  invite: 0,
  signup: 0,
  forgot: 0,
  reset: 0,
  verify: 0,
  oauth: 0,
  'oauth-error': 0,
  welcome: 0,
  styleguide: 1,
};

/** The identity of what fills the window: the same screen with other parameters is not a screen change. */
export const screenOf = (r: Route) => (r.name === 'player' ? `player:${r.slug}` : r.name === 'guest' ? `guest:${r.token}` : r.name);

type WithTransition = Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } };

export function transitionTo(from: Route, to: Route, update: () => void): void {
  const doc = document as WithTransition;
  if (
    screenOf(from) === screenOf(to) ||
    typeof doc.startViewTransition !== 'function' ||
    document.visibilityState !== 'visible' ||
    matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    update();
    return;
  }
  const root = document.documentElement;
  root.dataset.nav = DEPTH[to.name] < DEPTH[from.name] ? 'back' : 'forward';
  try {
    doc
      .startViewTransition(update)
      .finished.catch(() => {})
      .finally(() => delete root.dataset.nav);
  } catch {
    delete root.dataset.nav;
    update();
  }
}
