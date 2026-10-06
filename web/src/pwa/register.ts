// The app as an installable app: the service worker (instant start, offline screen, notifications), the update offer
// after a new build, routes opened from a tapped notification, and the app icon's badge.

import { t } from '../i18n/index.ts';
import { toast } from '../lib/toast.ts';

export function registerServiceWorker(): void {
  // Built app only (the dev server has no sw.js); client review links stay a plain web page.
  if (!import.meta.env.PROD || !('serviceWorker' in navigator) || location.pathname.startsWith('/g/')) return;
  const hadController = !!navigator.serviceWorker.controller;
  const offer = (worker: ServiceWorker) =>
    toast(t('A new version of the app is ready.'), 'info', { label: t('Reload'), onClick: () => worker.postMessage('skip-waiting') });
  navigator.serviceWorker
    .register('/sw.js')
    .then((reg) => {
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
        });
      });
      // Phones keep apps open for days: look for a new build whenever the app comes back to the front.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    })
    .catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // A new build took over: reload into it. A worker that went away (the server's Clear-Site-Data after signing out
    // everywhere or a reset, site data cleared) is no reason: the page goes on over the network, where it is — a reload
    // would open a reset link it just used.
    if (!hadController || reloading || !navigator.serviceWorker.controller) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent<{ type?: string; url?: string }>) => {
    if (e.data?.type === 'vr-open' && typeof e.data.url === 'string') location.hash = e.data.url.replace(/^#?/, '#');
  });
}

/** The number on the app icon (installed apps, where the platform supports it). */
export function setBadge(n: number): void {
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  if (!nav.setAppBadge) return;
  (n > 0 ? nav.setAppBadge(n) : (nav.clearAppBadge?.() ?? Promise.resolve())).catch(() => {});
}
