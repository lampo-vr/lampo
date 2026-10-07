// The entry: the page's language first (German is its own chunk), then the app, so its first render is in that language
// with no flash; a switch later changes the words in place (i18n/index.ts). Meanwhile the data the last session showed
// comes out of IndexedDB (api/persist.ts).
import { readPersisted } from './api/persist.ts';
import { detectLang, loadLang } from './i18n/index.ts';

// The consent page (/?consent, server/guard.ts CONSENT_PAGE) comes with an opener policy that lets an app's popup keep
// its window, for the consent screen alone; a page keeps the policy it was loaded with for the tab's life, wherever its
// hash leads later. Anywhere else this address loads again without it, at once or when the hash moves on.
if (new URLSearchParams(location.search).has('consent')) {
  const leave = () => {
    if (!location.hash.startsWith('#/oauth/')) location.replace(`${location.pathname}${location.hash}`);
  };
  leave();
  window.addEventListener('hashchange', leave);
}

void readPersisted();
void loadLang(detectLang())
  .catch(() => loadLang('en'))
  .then(() => import('./boot.tsx'));
