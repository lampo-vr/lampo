// The app itself, imported by main.tsx once the page's language is loaded.
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Weight and width axes: titles use a semi-condensed cut of the same face.
import '@fontsource-variable/instrument-sans/standard.css';
import '@fontsource-variable/martian-mono/standard.css';
import './styles/index.css';
import './lib/theme.ts';
import App, { preloadScreen } from './App.tsx';
import { authKeys, authStatusQuery } from './api/auth.ts';
import { readPersisted, restore } from './api/persist.ts';
import { createQueryClient, prefetchScreen } from './api/queries.ts';
import { useLang } from './i18n/T.tsx';
import { hasChromeHint } from './lib/chromeHint.ts';
import { parseRoute } from './lib/nav.ts';
import { registerServiceWorker } from './pwa/register.ts';

performance.mark('vr:boot');
// The screen's code downloads while the kept data comes out of IndexedDB.
const screenCode = preloadScreen(parseRoute(location.hash, location.pathname));
const queryClient = createQueryClient();
// Server events → the cache (api/live.ts): its own small chunk, bound as soon as it is here.
void import('./api/live.ts').then((m) => m.bindQueryClient(queryClient));
registerServiceWorker();

// The last session's screens (IndexedDB, read since the page started): painted at once, refreshed as they're used. A
// browser that takes longer than a moment to answer starts without them. The first render also waits (as long) for
// the screen's code: rendered before it is here, the screen would suspend, and React holds content that replaces a
// fallback back for up to 300 ms. (No top-level await: it makes the bundler split the app's shared modules into many
// small chunks.)
const moment = <T,>(p: Promise<T>, otherwise: T) => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(otherwise), 250))]);
const kept = moment(readPersisted(), []).then((k) => {
  restore(queryClient, k);
  performance.mark('vr:restored');
  // Keeping it for next time is its own chunk: nothing of it is needed to paint.
  void import('./api/persistWrite.ts').then((m) => m.persistQueries(queryClient));
  // Who is signed in is asked for now, while the screen's code is still on its way, not when the first render asks;
  // and when someone was signed in here before (kept data, or at least the chrome hint), the screen's data alongside it
  // (one round trip to the first paint instead of two). Never on a client link: it has its own data, and its visitor may
  // not be the person signed in here.
  if (!location.pathname.startsWith('/g/')) {
    void queryClient.prefetchQuery(authStatusQuery);
    if (queryClient.getQueryData(authKeys.status) || hasChromeHint()) prefetchScreen(queryClient, location.hash);
  }
});
// A language switch (Settings) renders the whole app again, in place and in one pass: <App /> is made here, so every
// component below renders with the new words (i18n/index.ts). Nothing remounts — state, focus and scroll stay.
function Root() {
  useLang();
  return (
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  );
}

void Promise.all([kept, moment(screenCode, undefined)]).then(() => {
  const root = document.getElementById('root');
  if (!root) throw new Error('#root missing');
  createRoot(root).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
});
