#!/usr/bin/env node
// covers: web/src/foryou/ web/src/pwa/ web/sw/ web/public/ web/src/player/VerifyPanel.tsx web/src/player/useVerify.ts
// covers: server/routes/phone.ts lib/push/ lib/pushPrefs.ts
// Browser end-to-end test of the phone workflow: a real server (local mode, temp store, free port) + headless
// Chrome. "For you" on a phone viewport (answer an agent's question, check a fix in verify mode, wave one through),
// the installable app (manifest, service worker, what it caches, a push rendered as a notification, the offline
// screen). Screenshots land in VR_SHOTS when it is set.
import path from 'node:path';
import { age, makeVideo, sleep, until } from '../lib/helpers.ts';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'phone e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-phone-e2e-', user: 'Sam' });
const { dir, base: BASE } = srv;

const api = jsonApi(BASE);
const comment = async (slug, id) => (await api(`/api/review/${encodeURIComponent(slug)}`)).review.comments.find((c) => c.id === id);

const IPHONE = {
  viewport: { width: 390, height: 844, deviceScaleFactor: SHOTS ? 3 : 1, isMobile: true, hasTouch: true },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
};

let browser;
try {
  const add = async (rel, opts = {}) => {
    const file = makeVideo(path.join(dir, rel), { w: 320, h: 568, fps: 25, dur: 3, ...opts });
    age(file);
    const { video } = await api('/api/library', 'POST', { path: file });
    return video.slug;
  };
  const spot = await add('Acme/export/spot.mp4', { pattern: 'testsrc2' });
  const film = await add('Globex/out/film.mp4', { pattern: 'smptebars' });
  const note = (slug, body) => api(`/api/review/${encodeURIComponent(slug)}/comments`, 'POST', body);
  const question = await note(spot, { frame: 30, text: 'Logo before or after the claim?', by: 'agent:promo-edit' });
  const fixes = [];
  for (const [frame, text, change] of [
    [40, 'Caption sits on her face', 'Moved the caption below the chin'],
    [60, 'Music too loud under the voice', 'Ducked the music by 6 dB'],
  ]) {
    const c = await note(film, { frame, text, severity: 'must' });
    await api(`/api/comments/${c.id}`, 'PATCH', { status: 'fixed', note: change, by: 'agent:brand-film' });
    fixes.push(c);
  }

  // a push must show as a notification: chrome-headless-shell has no notification system
  browser = await launch({ notifications: true });
  const errors = [];
  const watch = (page) => {
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));
    return page;
  };
  const shotOf = (page) => async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  console.log(`phone e2e against ${BASE} (store ${dir})`);

  await check('manifest, icons and the service worker are served, and never stale', async () => {
    const m = await fetch(`${BASE}/manifest.webmanifest`);
    assert(m.headers.get('content-type')?.startsWith('application/manifest+json'), m.headers.get('content-type'));
    assert(m.headers.get('cache-control') === 'no-cache', `manifest cache-control ${m.headers.get('cache-control')}`);
    const manifest = await m.json();
    assert(manifest.display === 'standalone' && manifest.start_url, 'standalone app with a start_url');
    assert(manifest.name === 'Lampo' && manifest.short_name === 'Lampo', `installs as Lampo: ${manifest.name} / ${manifest.short_name}`);
    const purposes = new Set(manifest.icons.map((i) => i.purpose || 'any'));
    assert(purposes.has('any') && purposes.has('maskable'), `icon purposes ${[...purposes]}`);
    for (const icon of [...manifest.icons, { src: '/icons/apple-touch-icon.png' }, { src: '/icons/badge-96.png' }]) {
      const r = await fetch(new URL(icon.src, BASE));
      assert(r.ok && r.headers.get('content-type') === 'image/png', `${icon.src}: ${r.status}`);
    }
    const sw = await fetch(`${BASE}/sw.js`);
    const src = await sw.text();
    assert(sw.headers.get('cache-control') === 'no-cache', `sw.js cache-control ${sw.headers.get('cache-control')}`);
    assert(!src.includes('__VERSION__') && !src.includes('__PRECACHE__'), 'sw.js has its version and file list filled in');
    assert((await fetch(`${BASE}/offline.html`)).ok, 'offline page');
  });

  const phone = watch(await browser.newPage());
  await phone.emulate(IPHONE);
  const phoneShot = shotOf(phone);

  await check('the library shows how much waits, and the inbox view lists it by kind on a phone', async () => {
    await phone.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    // the question, two fixes, and spot.mp4 itself: nobody has reviewed v1 yet (status workflow: to_review)
    await phone.waitForSelector('[data-testid="inbox-bell"][aria-label="Inbox, 4 waiting"]', { timeout: 20000 });
    // the bell's sheet leads on to the full view, which lists the items as cards with their actions on a phone
    await phone.tap('[data-testid="inbox-bell"]');
    await phone.waitForSelector('[data-testid="inbox-full"]');
    await phone.tap('[data-testid="inbox-full"]');
    await phone.waitForFunction(() => location.hash === '#/inbox', { timeout: 5000 });
    await phone.waitForSelector('[data-testid="inbox-view"] [data-testid="fy-question"]');
    assert((await phone.$$('[data-testid="fy-verify"]')).length === 2, 'two fixes to check');
    assert((await phone.$$('[data-testid="fy-review"]')).length === 1, 'one render to review');
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert(overflow <= 0, `no sideways scrolling (${overflow}px)`);
    const ios = await phone.$eval('[data-testid="notify-card"]', (e) => e.textContent);
    assert(ios.includes('Home Screen'), `iOS in the browser is told to install first: ${ios}`);
    await sleep(500);
    await phoneShot('01-inbox-view-phone');
    // a step to take, not a nag: "Not now" puts it away on this device
    await phone.tap('[data-testid="notify-later"]');
    await phone.waitForSelector('[data-testid="notify-card"]', { hidden: true });
    await phone.evaluate(() => localStorage.removeItem('vr.notify.later'));
  });

  await check('an agent’s question is answered from the phone and leaves the list', async () => {
    await phone.tap('[data-testid="fy-question"] textarea');
    await phone.type('[data-testid="fy-question"] textarea', 'After the claim, please');
    await phone.tap('[data-testid="fy-question"] button[type="submit"]');
    await phone.waitForSelector('[data-testid="fy-question"]', { hidden: true });
    const c = await comment(spot, question.id);
    assert(c.status === 'verified', `status ${c.status}`);
    assert(c.replies.at(-1).text === 'After the claim, please' && c.replies.at(-1).by === 'Sam', JSON.stringify(c.replies.at(-1)));
    // Still gone after a fresh load (the server agrees, not just the optimistic list).
    await phone.reload({ waitUntil: 'domcontentloaded' });
    await phone.waitForSelector('[data-testid="fy-verify"]');
    assert(!(await phone.$('[data-testid="fy-question"]')), 'answered question stays gone');
  });

  // Newest first: two fixes made within the same second keep the store's order, so find them by their text.
  const fixItem = async (fix) => {
    for (const el of await phone.$$('[data-testid="fy-verify"]')) if ((await el.$eval('.fy-text', (e) => e.textContent)) === fix.text) return el;
    throw new Error(`no item for "${fix.text}"`);
  };

  await check('"Check" opens verify mode at that very fix', async () => {
    const link = await (await fixItem(fixes[1])).$('a.btn.primary');
    assert((await link.evaluate((a) => a.getAttribute('href'))).endsWith(`?verify=${fixes[1].id}`), 'link carries the note');
    await link.tap();
    await phone.waitForSelector('.verify .c-text', { timeout: 20000 });
    const text = await phone.$eval('.verify .c-text', (e) => e.textContent);
    assert(text === fixes[1].text, `verify opened at "${text}"`);
    // The queue runs in timeline order: the later frame is the second of two.
    assert((await phone.$eval('.verify-head .eyebrow', (e) => e.textContent)).includes('2 / 2'), 'second in the queue');
    await sleep(400);
    await phoneShot('02-verify-from-for-you');
  });

  await check('"Looks right" checks a fix straight from the list (reached by the old #/for-you address)', async () => {
    await phone.goto(`${BASE}/#/for-you`, { waitUntil: 'domcontentloaded' });
    await phone.waitForSelector('[data-testid="fy-verify"]');
    assert((await phone.evaluate(() => location.hash)) === '#/inbox', 'the old address shows as #/inbox');
    await (await (await fixItem(fixes[0])).$('[data-testid="fy-right"]')).tap();
    await until(async () => (await comment(film, fixes[0].id)).status === 'verified', 'fix verified');
    await until(async () => (await phone.$$('[data-testid="fy-verify"]')).length === 1, 'one fix left');
  });

  const page = watch(await browser.newPage());
  await page.setViewport({ width: 1280, height: 800 });
  const shot = shotOf(page);
  let registrationId = null;
  const cdp = await page.createCDPSession();
  cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
    const reg = registrations.find((r) => r.scopeURL === `${BASE}/` && !r.isDeleted);
    if (reg) registrationId = reg.registrationId;
  });
  await cdp.send('ServiceWorker.enable');

  await check('the service worker takes over and caches the app shell, never data or media', async () => {
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => navigator.serviceWorker?.controller, { timeout: 20000 });
    // A player loads review data, frames and the video itself: none of it may end up in a cache.
    await page.goto(`${BASE}/#/v/${encodeURIComponent(film)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('.vbox video')?.readyState >= 2, { timeout: 20000 });
    await sleep(800);
    const cached = await page.evaluate(async () => {
      const out = [];
      for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(`${k} ${new URL(r.url).pathname}`);
      return out;
    });
    assert(
      cached.some((c) => /^vr-shell-\S+ \/offline\.html$/.test(c)),
      `offline page precached: ${cached.join(', ')}`,
    );
    assert(
      cached.some((c) => / \/assets\/index-[\w-]+\.js$/.test(c)),
      'entry chunk precached',
    );
    const leaked = cached.filter((c) => / \/(api|media|data|mcp|oauth)\//.test(c));
    assert(!leaked.length, `never cached: ${leaked.join(', ')}`);
  });

  await check('a push arrives as a notification that points at the note', async () => {
    await browser.defaultBrowserContext().overridePermissions(BASE, ['notifications']);
    await until(() => registrationId, 'service worker registration id');
    // Delivered once the page has the permission and the worker is active (a push to a worker still activating, or
    // before the grant reached the page, never shows: the check then failed now and then under load).
    await page.waitForFunction(async () => Notification.permission === 'granted' && (await navigator.serviceWorker.ready).active?.state === 'activated', {
      polling: 100,
      timeout: 20000,
    });
    const payload = { title: 'promo-edit asks about spot.mp4', body: '“Logo before or after the claim?”', url: `#/v/spot?c=c_1`, tag: 'q:spot', count: 2 };
    await cdp.send('ServiceWorker.deliverPushMessage', { origin: BASE, registrationId, data: JSON.stringify(payload) });
    let shown = [];
    await until(async () => {
      shown = await page.evaluate(async () =>
        (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, data: n.data, icon: n.icon })),
      );
      return shown.length;
    }, 'notification shown');
    const n = shown[0];
    assert(n.title === payload.title && n.body === payload.body && n.tag === payload.tag, JSON.stringify(n));
    assert(n.data?.url === payload.url, `tap opens ${n.data?.url}`);
    assert(n.icon.endsWith('/icons/icon-192.png'), n.icon);
  });

  await check('with the server out of reach, the app shows its offline screen', async () => {
    await srv.stop();
    await until(async () => {
      try {
        await fetch(`${BASE}/api/library`);
        return false;
      } catch {
        return true;
      }
    }, 'server stopped');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body?.textContent.includes('Out of reach'), { timeout: 10000 });
    await shot('04-offline');
  });

  await check('no page errors along the way', async () => {
    assert(!errors.length, errors.join(' | '));
  });
} catch (e) {
  crashed(e, srv);
} finally {
  await finish(LABEL, { browser, servers: [srv] });
}
