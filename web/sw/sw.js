// video-review's service worker: the app's code from a local cache for an instant start, an offline screen when the
// server is out of reach, and push notifications. It never stores data — /api, /media, /data, /mcp, /oauth always go
// to the network. (The app itself keeps the screens it last showed in IndexedDB for the signed-in account, and deletes
// them on sign-out: web/src/api/persist.ts.)
// Built by web/vite.config.ts, which fills in the version and the files to precache.
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const SHELL = `vr-shell-${VERSION}`;
// Per version too: a new version starts its own and deletes the rest, so the chunks of builds gone by don't pile up.
// The chunks that didn't change come from the HTTP cache again (they are served immutable).
const ASSETS = `vr-assets-${VERSION}`;
const NEVER = /^\/(api|media|data|mcp|oauth|\.well-known)(\/|$)/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith('vr-') && key !== SHELL && key !== ASSETS) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

// The page asks for it after the person tapped "Reload" on "a new version is ready".
self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || NEVER.test(url.pathname)) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(async () => (await caches.match('/offline.html', { cacheName: SHELL })) || Response.error()));
    return;
  }
  // Hashed build files never change: cache first, fill the cache as the app loads its screens. Icons keep their names
  // when they change (a new mark): the cached one answers at once and a fresh copy replaces it for next time.
  const hashed = url.pathname.startsWith('/assets/');
  if (hashed || url.pathname.startsWith('/icons/')) {
    // The copy goes into the cache behind the answer, never in front of it: a cache that can't take it (storage full or
    // busy, a private window) must not turn a file that arrived into a failed load ("Failed to fetch dynamically imported
    // module": a blank page).
    const refresh = async () => {
      const res = await fetch(req);
      if (res.ok) {
        const copy = res.clone();
        e.waitUntil(
          caches
            .open(ASSETS)
            .then((c) => c.put(req, copy))
            .catch(() => {}),
        );
      }
      return res;
    };
    e.respondWith(
      (async () => {
        // what this version fetched since, else what its install kept for the start (the entry script, an icon); a cache
        // that can't be read is a miss
        const hit = await caches
          .match(req, { cacheName: ASSETS })
          .then((r) => r || caches.match(req, { cacheName: SHELL }))
          .catch(() => undefined);
        if (!hit) return refresh();
        if (!hashed) e.waitUntil(refresh().catch(() => {}));
        return hit;
      })(),
    );
  }
});

self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {}
  const badge =
    typeof d.count === 'number' && self.navigator.setAppBadge ? (d.count ? self.navigator.setAppBadge(d.count) : self.navigator.clearAppBadge()) : null;
  e.waitUntil(
    Promise.all([
      self.registration.showNotification(d.title || 'Lampo', {
        body: d.body || '',
        tag: d.tag,
        renotify: !!d.tag,
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        data: { url: d.url || '#/inbox' },
      }),
      badge,
    ]),
  );
});

// Tapping a notification opens the app at the note or render it is about: an open window follows along (the page
// changes its route), otherwise a new one opens there.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const route = e.notification.data?.url || '#/inbox';
  e.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        open.postMessage({ type: 'vr-open', url: route });
        return open.focus();
      }
      return self.clients.openWindow(`/${route}`);
    })(),
  );
});
