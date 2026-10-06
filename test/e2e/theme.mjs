#!/usr/bin/env node
// covers: web/src/lib/theme.ts web/src/styles/theme.css web/src/share/PrintView.tsx web/src/player/Timeline.tsx
// covers: lib/themeBoot.ts web/src/auth/AuthGate.tsx web/src/settings/Appearance.tsx web/src/guest/GuestPlayer.tsx
// Browser end-to-end test of the colour themes (Light · Dark · System): two real servers (local mode and server mode,
// temp stores, free ports) + headless Chrome. The theme is on <html> before the body is parsed (no flash; under the
// hosted server's CSP too), the switch persists across reloads, System follows the device's setting live, the
// timeline canvas repaints, dark is the same pixels after a trip through light, the main screens are light when chosen
// (how they fit: mobile.mjs) and the print sheet fits, guest pages follow the device, and a signed-in account carries the choice to another device.
// Screenshots land in VR_SHOTS when it is set. Without Chrome or web/dist it fails (prereq.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { age, makeVideo, sleep } from '../lib/helpers.ts';
import { fitsAt, settle } from './layout.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'theme e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();

// The page background per theme (--ink-1) and the timeline's perforation strip (--tl-film).
const BG = { dark: 'rgb(13, 13, 14)', light: 'rgb(242, 239, 231)' };
const FILM = { dark: [4, 4, 4], light: [226, 221, 210] };
const CALM = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';

// Records the theme the moment <body> is parsed: set by then means the first paint already has it.
const WATCH = `(() => {
  window.__themeAtBody = null;
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + (e.blockedURI || 'inline')));
  new MutationObserver((_, obs) => {
    if (!document.body) return;
    window.__themeAtBody = document.documentElement.getAttribute('data-theme') || 'none';
    obs.disconnect();
  }).observe(document, { childList: true, subtree: true });
})();`;

const local = await startServer({ prefix: 'vr-theme-e2e-', user: 'Sam' });
// No public URL on purpose: the helper starts it with VR_ALLOW_NO_PUBLIC_URL=1 (a real server refuses to).
const hosted = await startServer({ prefix: 'vr-theme-e2e-server-', mode: 'server', user: 'Sam', config: (dir) => ({ browse_root: dir }) });
const { dir: localDir, base: L } = local;
const H = hosted.base;
const OWNER = { name: 'Theme Owner', email: 'owner@theme.test', password: 'a long enough password' };
let browser;
try {
  const setupToken = await hosted.setupToken();
  assert(setupToken, `no setup token in the server log:\n${hosted.log()}`);

  const api = async (p, method = 'GET', body) => {
    const r = await fetch(L + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const out = await r.json();
    if (!r.ok) throw new Error(`${p}: ${out.error}`);
    return out;
  };
  const file = makeVideo(path.join(localDir, 'Acme/export/spot.mp4'), { w: 320, h: 180, fps: 30, dur: 3, pattern: 'testsrc2' });
  age(file);
  const { video } = await api('/api/library', 'POST', { path: file });
  const slug = encodeURIComponent(video.slug);
  await api(`/api/review/${slug}/folder`, 'PUT', { folder: 'Acme/Reels' });
  await api(`/api/review/${slug}/comments`, 'POST', { frame: 30, text: 'Logo a touch earlier', severity: 'must' });
  await api(`/api/review/${slug}/comments`, 'POST', { frame: 60, text: 'Warmer grade here?', severity: 'idea' });
  const { token } = await api(`/api/review/${slug}/shares`, 'POST', { label: 'Acme marketing' });

  browser = await launch();
  const errors = [];
  // A fresh browser profile (another device): its own localStorage and cookies.
  const device = async (scheme = 'dark', vp = { width: 1440, height: 900 }) => {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewport(vp);
    await page.emulateMediaFeatures([
      { name: 'prefers-color-scheme', value: scheme },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ]);
    await page.evaluateOnNewDocument(WATCH);
    return page;
  };
  // A real page load every time: going from one #/ route to another would only change the hash and keep the app.
  const open = async (page, url) => {
    await page.goto('about:blank');
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  };
  const theme = (page) => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const bg = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const stored = (page) => page.evaluate(() => localStorage.getItem('vr.theme'));
  // The attribute, then the page itself (reduced motion still runs a 0.01 ms transition to the new colours).
  const waitTheme = (page, t) =>
    page.waitForFunction(
      (t, want) => document.documentElement.getAttribute('data-theme') === t && getComputedStyle(document.body).backgroundColor === want,
      { timeout: 5000 },
      t,
      BG[t],
    );
  const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  // The quick theme row of the account menu (the sidebar has no switch; Settings → Appearance is the full one).
  const menuTheme = async (page) => {
    // Pressed where the chip is once the top bar holds still: a bar that re-lays itself out under a loaded machine (the
    // add-video, bell and workspace bits arrive with /api/info) moved the chip between measuring it and pressing.
    await settle(page);
    await page.click('.user-chip');
    try {
      await page.waitForSelector('.menu[data-state=open] .menu-theme button');
    } catch (e) {
      // Seen twice at load average ~12 and never reproduced (delayed layers chunk, slow API, CPU 4–6×): say what the
      // page looked like, so the next miss explains itself.
      const state = await page.evaluate(() => ({
        href: location.href,
        ready: document.readyState,
        chips: [...document.querySelectorAll('.user-chip')].map((b) => ({ disabled: b.disabled, expanded: b.getAttribute('aria-expanded') })),
        menus: document.querySelectorAll('.menu').length,
        controlled: !!navigator.serviceWorker?.controller,
        theme: document.documentElement.getAttribute('data-theme'),
      }));
      throw new Error(`${e.message}\n      the page then: ${JSON.stringify(state)}`);
    }
  };
  const closeMenu = async (page) => {
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.menu[data-state=open]'), { timeout: 5000 });
  };
  const pick = async (page, label) => {
    await menuTheme(page);
    await page.evaluate(
      (label) => [...document.querySelectorAll('.menu[data-state=open] .menu-theme button')].find((b) => b.textContent.trim() === label).click(),
      label,
    );
    await closeMenu(page);
    await waitTheme(
      page,
      label === 'System' ? await page.evaluate(() => (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')) : label.toLowerCase(),
    );
  };
  const library = async (page) => {
    await open(page, `${L}/#/`);
    await page.waitForSelector('.user-chip:enabled');
  };
  const openPlayer = async (page) => {
    await open(page, `${L}/#/v/${slug}`);
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2 && document.querySelector('.timeline canvas'), { timeout: 20000 });
  };
  // The stage, transport and timeline once two shots in a row agree (the notes column shows live job progress).
  const still = async (page) => {
    const clip = { x: 0, y: 0, width: 1040, height: 900 };
    let prev = await page.screenshot({ clip });
    for (let i = 0; i < 30; i++) {
      await sleep(400);
      const cur = await page.screenshot({ clip });
      if (!Buffer.compare(prev, cur)) return cur;
      prev = cur;
    }
    throw new Error('the player never settled');
  };
  // One pixel of the timeline's perforation strip, above the holes.
  const filmPixel = (page) =>
    page.evaluate(() => {
      const c = document.querySelector('.timeline canvas');
      return [
        ...c
          .getContext('2d')
          .getImageData(Math.round(c.width / 2), 1, 1, 1)
          .data.slice(0, 3),
      ];
    });

  console.log(`theme e2e against ${L} (local) and ${H} (server mode)`);

  const page = await device('dark');
  // The machine's owner is an account: its theme follows it to every device (and wins over the device's), so a check
  // that starts from a theme sets it on this device and on the account.
  const themeEverywhere = (page, t) =>
    page.evaluate(async (t) => {
      localStorage.setItem('vr.theme', t);
      await fetch('/api/auth/me', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefs: { theme: t } }) });
    }, t);

  await check('no flash: a stored choice is on <html> before the body is parsed, and System is the default', async () => {
    await library(page);
    assert((await page.evaluate(() => window.__themeAtBody)) === 'dark', 'System on a dark device starts dark');
    assert((await stored(page)) === null, 'nothing stored until a choice is made');
    await page.evaluate(() => localStorage.setItem('vr.theme', 'light'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert((await page.evaluate(() => window.__themeAtBody)) === 'light', 'light was applied before the body');
    const meta = await page.evaluate(() => [
      document.querySelector('meta[name=color-scheme]').content,
      document.querySelector('meta[name=theme-color]').content,
    ]);
    assert(meta.join() === 'light,#f2efe7', `meta ${meta}`);
    await page.evaluate(() => localStorage.removeItem('vr.theme'));
    await page.reload({ waitUntil: 'domcontentloaded' });
  });

  await check("the account menu's theme row sets Light, Dark and System; the choice survives a reload", async () => {
    await library(page);
    await pick(page, 'Light');
    assert((await bg(page)) === BG.light && (await stored(page)) === 'light', `light: ${await bg(page)} ${await stored(page)}`);
    await shot(page, 'theme-library-light');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.user-chip:enabled');
    assert((await theme(page)) === 'light' && (await page.evaluate(() => window.__themeAtBody)) === 'light', 'light after reload');
    await menuTheme(page);
    const on = await page.$eval('.menu[data-state=open] .menu-theme button.on', (b) => b.textContent.trim());
    await closeMenu(page);
    assert(on === 'Light', `the menu shows ${on}`);
    await pick(page, 'Dark');
    assert((await bg(page)) === BG.dark && (await stored(page)) === 'dark', 'dark');
    await pick(page, 'System');
    assert((await stored(page)) === null && (await theme(page)) === 'dark', 'System on a dark device');
  });

  await check('System follows the device setting live, without a reload', async () => {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await waitTheme(page, 'light');
    assert((await bg(page)) === BG.light, 'light background');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await waitTheme(page, 'dark');
    // An explicit choice ignores the device.
    await pick(page, 'Light');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await sleep(200);
    assert((await theme(page)) === 'light', 'Light stays light on a dark device');
  });

  await check('Settings switches the theme in place (no reload, no shift), and a status kept from before never switches it back', async () => {
    await open(page, `${L}/#/settings/appearance`);
    await themeEverywhere(page, 'dark');
    await open(page, `${L}/#/settings/appearance`);
    await page.waitForSelector('.set-theme .theme-switch button');
    await waitTheme(page, 'dark');
    await settle(page, { quiet: 500 });
    // Marks only a page that was never reloaded still has; every theme it shows and every layout shift from now on.
    await page.evaluate(() => {
      window.__kept = true;
      window.__themes = [];
      new MutationObserver(() => window.__themes.push(document.documentElement.getAttribute('data-theme'))).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      });
      window.__shift = 0;
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__shift += e.value;
      }).observe({ type: 'layout-shift' });
    });
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/auth/me') && r.request().method() === 'PATCH', { timeout: 15000 });
    await page.evaluate(() => [...document.querySelectorAll('.set-theme button')].find((b) => b.textContent.trim() === 'Light').click());
    await waitTheme(page, 'light');
    await saved;
    await settle(page, { quiet: 500 });
    const m = await page.evaluate(() => ({ kept: window.__kept === true, themes: window.__themes, shift: window.__shift }));
    assert(m.kept, 'the page reloaded');
    assert(m.themes.join() === 'light', `one theme change: ${JSON.stringify(m.themes)}`);
    assert(m.shift < 0.01, `layout shift ${m.shift.toFixed(4)} during the switch`);
    // The status this browser keeps for the next start (api/persistWrite.ts), as a write that didn't land before a
    // reload leaves it: still dark. Followed, the page would turn dark, then light again when the server answers.
    const keptTheme = (set) =>
      page.evaluate(
        (set) =>
          new Promise((resolve) => {
            const req = indexedDB.open('vr-cache');
            req.onerror = () => resolve(null);
            req.onsuccess = () => {
              const store = req.result.transaction('queries', 'readwrite').objectStore('queries');
              const all = store.getAll();
              all.onsuccess = () => {
                const e = all.result.find((x) => x.key[0] === 'auth' && x.key[1] === 'status');
                if (!e?.data?.user) return resolve(null);
                if (set) store.put({ ...e, data: { ...e.data, user: { ...e.data.user, prefs: { ...e.data.user.prefs, theme: set } } } });
                resolve(e.data.user.prefs?.theme ?? null);
              };
              all.onerror = () => resolve(null);
            };
          }),
        set,
      );
    await page.waitForFunction(
      () =>
        new Promise((resolve) => {
          const req = indexedDB.open('vr-cache');
          req.onerror = () => resolve(false);
          req.onsuccess = () => {
            const all = req.result.transaction('queries').objectStore('queries').getAll();
            all.onsuccess = () => resolve(all.result.some((x) => x.key[0] === 'auth' && x.key[1] === 'status' && x.data?.user?.prefs?.theme === 'light'));
            all.onerror = () => resolve(false);
          };
        }),
      { polling: 200, timeout: 15000 },
    );
    await settle(page, { quiet: 1500 });
    assert((await keptTheme('dark')) === 'light', 'the kept status said light');
    await page.evaluateOnNewDocument(() => {
      window.__themes = [];
      new MutationObserver(() => window.__themes.push(document.documentElement?.getAttribute('data-theme'))).observe(document, {
        attributes: true,
        attributeFilter: ['data-theme'],
        subtree: true,
      });
    });
    const fresh = page.waitForResponse((r) => r.url().endsWith('/api/auth/status'), { timeout: 15000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.set-theme .theme-switch button');
    await fresh;
    await settle(page, { quiet: 1000 });
    const themes = await page.evaluate(() => window.__themes);
    assert(!themes.includes('dark'), `the page turned dark on the kept status: ${JSON.stringify(themes)}`);
    assert((await theme(page)) === 'light', 'light after the reload');
    await themeEverywhere(page, 'dark');
  });

  await check('the timeline canvas repaints in the theme, and dark is the same pixels after a trip through light', async () => {
    const setTheme = async (t) => {
      // the way another tab would switch it (the storage event)
      await page.evaluate((t) => {
        localStorage.setItem('vr.theme', t);
        window.dispatchEvent(new StorageEvent('storage', { key: 'vr.theme', newValue: t }));
      }, t);
      await waitTheme(page, t);
    };
    const fresh = async () => {
      await openPlayer(page);
      await page.addStyleTag({ content: CALM });
      await page.evaluate(() => document.fonts.ready);
      return still(page);
    };
    await themeEverywhere(page, 'dark');
    // Dark after a trip through light against a fresh dark load of the same page. Background analysis can land during
    // a trip and change the picture for real, so a mismatch is retried; a colour left behind by light never matches.
    let same = false;
    for (let attempt = 0; attempt < 3 && !same; attempt++) {
      await fresh();
      assert((await filmPixel(page)).join() === FILM.dark.join(), `dark film ${await filmPixel(page)}`);
      await setTheme('light');
      await sleep(300);
      assert((await filmPixel(page)).join() === FILM.light.join(), `light film ${await filmPixel(page)}`);
      if (!attempt) await shot(page, 'theme-player-light');
      await setTheme('dark');
      assert((await filmPixel(page)).join() === FILM.dark.join(), 'dark film again');
      const after = await still(page);
      const reloaded = await fresh();
      same = Buffer.compare(after, reloaded) === 0;
      if (!same && SHOTS) {
        fs.writeFileSync(path.join(SHOTS, `theme-roundtrip-${attempt}-after.png`), after);
        fs.writeFileSync(path.join(SHOTS, `theme-roundtrip-${attempt}-fresh.png`), reloaded);
      }
    }
    assert(same, 'the dark player after light and back is not pixel-identical to a fresh dark load');
  });

  await check('in light, text inside a dark island is light: nothing inherits the page ink (verify panel, stage, compare)', async () => {
    await openPlayer(page);
    // the way another tab switches it (the storage event), as in the timeline check above
    await page.evaluate(() => {
      localStorage.setItem('vr.theme', 'light');
      window.dispatchEvent(new StorageEvent('storage', { key: 'vr.theme', newValue: 'light' }));
    });
    await waitTheme(page, 'light');
    // Plain text with no colour of its own, the way the verify panel's note text is, inside each island.
    const bad = await page.evaluate(() => {
      const lum = (c) => {
        const [r, g, b] = (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      };
      const out = [];
      for (const cls of ['verify', 'compare-bar', 'review-hud', 'lightbox']) {
        const island = document.createElement('div');
        island.className = cls;
        island.style.cssText = 'position:fixed;left:-9999px;top:0';
        const text = document.createElement('div');
        text.textContent = 'text';
        island.append(text);
        document.body.append(island);
        const l = lum(getComputedStyle(text).color);
        if (l < 0.5) out.push(`${cls}: text luminance ${l.toFixed(2)}`);
        island.remove();
      }
      const stage = document.querySelector('.stage');
      if (stage) {
        const text = document.createElement('div');
        text.textContent = 'text';
        stage.append(text);
        const l = lum(getComputedStyle(text).color);
        if (l < 0.5) out.push(`stage: text luminance ${l.toFixed(2)}`);
        text.remove();
      }
      return out;
    });
    assert(!bad.length, bad.join(' · '));
  });

  // How they fit is mobile.mjs's sweep (360 to 1920, light being headless Chrome's default, bent edges in dark too);
  // here: each main screen is light when light is chosen, and the print sheet, which no other suite sweeps, fits.
  await check('main screens are light when chosen, and the print sheet fits in light from phone to desktop', async () => {
    await themeEverywhere(page, 'light');
    const problems = [];
    for (const [where, url, ready] of [
      ['library', `${L}/#/`, '.film'],
      ['player', `${L}/#/v/${slug}`, '.timeline canvas'],
      ['board', `${L}/#/status`, '[data-testid=library-board]'],
      ['insights', `${L}/#/insights`, 'main'],
      ['inbox', `${L}/#/inbox`, '[data-testid=inbox-view] :is(.inbox-row:not(.pending), .fy-item:not(.pending), .empty-state)'],
      ['print', `${L}/#/print/${slug}`, '.sheet'],
      ['guest', `${L}/g/${token}`, '.g-top'],
    ]) {
      await open(page, url);
      await page.waitForSelector(ready, { timeout: 20000 });
      assert((await theme(page)) === 'light', `${where} is light`);
      if (where === 'print') problems.push(...(await fitsAt(page, where)));
      await shot(page, `theme-${where.replace(' ', '-')}-light`);
    }
    assert(!problems.length, problems.join('\n'));
  });

  await check('the print sheet is paper in both themes', async () => {
    for (const t of ['dark', 'light']) {
      await page.evaluate((t) => localStorage.setItem('vr.theme', t), t);
      await open(page, `${L}/#/print/${slug}`);
      await page.waitForSelector('.sheet');
      const look = await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.querySelector('.sheet')).color]);
      assert(look.join() === 'rgb(255, 255, 255),rgb(17, 17, 17)', `${t}: ${look}`);
    }
  });

  await check('a client link follows the device, and its own switch changes it', async () => {
    const guest = await device('light', { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await guest.goto(`${L}/g/${token}`, { waitUntil: 'domcontentloaded' });
    // on a phone the theme is in the bar's ⋯ menu (the bar holds the title and Approve)
    await guest.waitForSelector('.g-top [data-testid=g-more]');
    assert(!(await guest.$('.g-top .theme-button')), 'no theme button of its own in a phone’s bar');
    assert((await guest.evaluate(() => window.__themeAtBody)) === 'light' && (await bg(guest)) === BG.light, 'light like the device');
    await shot(guest, 'theme-guest-phone-light');
    await guest.click('.g-top [data-testid=g-more]');
    await guest.waitForSelector('.menu-theme');
    await guest.evaluate(() => [...document.querySelectorAll('.menu-theme button')].find((b) => b.textContent.trim() === 'Dark').click());
    await waitTheme(guest, 'dark');
    assert((await stored(guest)) === 'dark', 'stored on this device');
    await guest.browserContext().close();
  });

  await check('server mode: the pre-paint script runs under the CSP, sign-in fits in light', async () => {
    const owner = await device('light');
    await owner.goto(`${H}/`, { waitUntil: 'domcontentloaded' });
    await owner.waitForSelector('.auth .theme-button');
    assert((await owner.evaluate(() => window.__themeAtBody)) === 'light', 'set before the body under the CSP');
    const csp = await owner.evaluate(() => window.__csp);
    assert(!csp.length, `CSP violations: ${csp.join('; ')}`);
    // (how the setup screen fits: server.mjs, which walks the setup)
    await shot(owner, 'theme-setup-light');
    await owner.browserContext().close();
  });

  await check('server mode: the choice is saved on the account and follows it to another device', async () => {
    const a = await device('dark');
    await a.goto(`${H}/healthz`);
    const setup = await a.evaluate(
      async (b) => (await fetch('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).status,
      { token: setupToken, ...OWNER },
    );
    assert(setup === 200, `setup ${setup}`);
    await open(a, `${H}/#/`);
    await a.waitForSelector('.user-chip:enabled');
    assert((await theme(a)) === 'dark', 'no account choice yet: the device decides');
    await a.click('.user-chip:enabled');
    await a.waitForSelector('.menu-theme');
    await shot(a, 'theme-user-menu-dark');
    await a.evaluate(() => [...document.querySelectorAll('.menu-theme button')].find((b) => b.textContent.trim() === 'Light').click());
    await waitTheme(a, 'light');
    await a.waitForFunction(async () => (await (await fetch('/api/auth/me')).json()).user?.prefs?.theme === 'light', { polling: 200, timeout: 5000 });
    await a.keyboard.press('Escape');

    // Another device, dark by default and nothing stored: signing in brings the account's choice.
    const b = await device('dark');
    await b.goto(`${H}/`, { waitUntil: 'domcontentloaded' });
    await b.waitForSelector('input[name=email]');
    assert((await theme(b)) === 'dark', 'signed out: the device decides');
    // The entrance's film is drawn in the theme: dark film over a lamp here, a white mat on paper in the light theme.
    const mat = (page) => page.$eval('.ent-frame', (e) => getComputedStyle(e).backgroundColor);
    assert((await mat(b)) === 'rgb(14, 14, 16)', `the film's mat in the dark: ${await mat(b)}`);
    const paper = await device('light');
    await paper.goto(`${H}/`, { waitUntil: 'domcontentloaded' });
    await paper.waitForSelector('.ent-frame');
    assert((await mat(paper)) === 'rgb(255, 255, 255)', `the film's mat on paper: ${await mat(paper)}`);
    await paper.browserContext().close();
    await b.type('input[name=email]', OWNER.email);
    await b.type('input[name=password]', OWNER.password);
    await b.click('.gate-go');
    await b.waitForSelector('.user-chip:enabled');
    await waitTheme(b, 'light');
    assert((await stored(b)) === 'light', 'kept on the new device too');
    // Settings → Appearance shows it and changes it for both.
    await open(b, `${H}/#/settings/appearance`);
    await b.waitForSelector('.set-theme .theme-switch');
    await b.waitForFunction(() => document.querySelectorAll('.set-theme button').length === 3, { timeout: 5000 });
    const on = await b.$eval('.set-theme [data-state=on]', (el) => el.textContent.trim());
    assert(on === 'Light', `appearance shows ${on}`);
    // (how Settings → Appearance fits: settings.mjs, every section in both themes)
    await shot(b, 'theme-settings-light');
    await b.waitForFunction(() => document.querySelectorAll('.set-theme button').length === 3, { timeout: 5000 });
    const labels = await b.$$eval('.set-theme button', (els) => els.map((x) => x.textContent.trim()));
    assert(labels.includes('Dark'), `appearance switch: ${labels.join(' | ')} — ${await b.evaluate(() => location.hash)}`);
    await b.evaluate(() => [...document.querySelectorAll('.set-theme button')].find((x) => x.textContent.trim() === 'Dark').click());
    await waitTheme(b, 'dark');
    await b.waitForFunction(async () => (await (await fetch('/api/auth/me')).json()).user?.prefs?.theme === 'dark', { polling: 200, timeout: 5000 });
    await a.reload({ waitUntil: 'domcontentloaded' });
    await waitTheme(a, 'dark');
  });

  assert(!errors.length, `page errors: ${errors.join('; ')}`);
} catch (e) {
  crashed(e, local, hosted);
} finally {
  await finish(LABEL, { browser, servers: [local, hosted] });
}
