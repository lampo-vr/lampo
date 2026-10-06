// The entry: the page's language first (German is its own chunk), then the app, so its first render is in that language
// with no flash; a switch later changes the words in place (i18n/index.ts). Meanwhile the data the last session showed
// comes out of IndexedDB (api/persist.ts).
import { readPersisted } from './api/persist.ts';
import { detectLang, loadLang } from './i18n/index.ts';

void readPersisted();
void loadLang(detectLang())
  .catch(() => loadLang('en'))
  .then(() => import('./boot.tsx'));
