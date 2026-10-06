#!/usr/bin/env node
// covers: web/src/i18n/ web/src/guest/ web/src/settings/Appearance.tsx web/src/ui/LangSwitch.tsx web/src/auth/AuthGate.tsx
// covers: web/src/boot.tsx web/src/api/persist.ts
// Browser e2e in German (local mode, temp store, free port, headless Chrome): a German browser gets the German UI
// before the first paint; the library, the player and a client link say their key words in German (the client in
// "Sie"); every screen still fits at phone, tablet, laptop and desktop width with German's longer words (the layout
// sweep: no sideways scroll, no clipped glyphs, no bent edges); the language switch in Settings changes every word in
// place — no reload, nothing remounted, no layout shift, another tab following with its dates — and once: the account's
// copy, a status answered later or one kept from before (IndexedDB) never switches it back.
import path from 'node:path';
import { age, makeVideo, sleep } from '../lib/helpers.ts';
import { fitsAt, settle, sideways } from './layout.mjs';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'german e2e';
requireChrome(LABEL);
const srv = await startServer({ prefix: 'vr-german-e2e-', user: 'Sam' });
const { dir, base: BASE } = srv;
const api = jsonApi(BASE);

let browser;
const errors = [];
try {
  const film = makeVideo(path.join(dir, 'Acme/film/export/spot.mp4'), { dur: 2 });
  const reel = makeVideo(path.join(dir, 'Acme/social/export/reel.mp4'), { dur: 2, w: 180, h: 320 });
  // older than a week: its card shows a date (lib/format.ts ago), in the UI language's format
  const old = makeVideo(path.join(dir, 'Acme/archive/export/teaser.mp4'), { dur: 1 });
  age(film);
  age(reel);
  age(old, 40 * 86400);
  const a = (await api('/api/library', 'POST', { path: film, folder: 'Acme' })).video.slug;
  await api('/api/library', 'POST', { path: reel, folder: 'Acme' });
  const oldSlug = (await api('/api/library', 'POST', { path: old, folder: 'Acme' })).video.slug;
  await api(`/api/review/${encodeURIComponent(a)}/comments`, 'POST', { frame: 12, text: 'Logo etwas kleiner', severity: 'must' });
  await api(`/api/review/${encodeURIComponent(a)}/comments`, 'POST', { frame: 30, text: 'Hier wärmer graden', severity: 'should' });
  const link = await api(`/api/review/${encodeURIComponent(a)}/shares`, 'POST', { label: 'Acme Marketing' });

  browser = await launch({ locale: 'de-DE' });
  /** A page in a German browser; `chosen` is the language picked in Settings on this device (null: never picked). */
  const open = async (url, chosen = 'de') => {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.evaluateOnNewDocument((c) => {
      Object.defineProperty(navigator, 'languages', { get: () => ['de-DE', 'de', 'en'] });
      Object.defineProperty(navigator, 'language', { get: () => 'de-DE' });
      if (c && !sessionStorage.getItem('vr.test.lang')) {
        localStorage.setItem('vr.lang', c);
        sessionStorage.setItem('vr.test.lang', '1');
      }
    }, chosen);
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
    return page;
  };
  const text = (page) => page.evaluate(() => document.body.innerText);

  await check('German chosen in Settings: the German library, set before the first paint', async () => {
    const page = await open('/#/');
    await page.waitForSelector('.film, .lrow, [data-testid=library-board]');
    const lang = await page.evaluate(() => document.documentElement.lang);
    assert(lang === 'de', `<html lang> is ${lang}`);
    const words = await text(page);
    for (const w of ['Posteingang', 'Alle Videos', 'Video hinzufügen', 'Zu prüfen']) assert(words.includes(w), `"${w}" on the library`);
    assert(!/\bAll videos\b|\bAdd video\b/.test(words), 'no English left on the library');
    await page.close();
  });

  await check('the player in German: notes, severities, the stage', async () => {
    const page = await open(`/#/v/${encodeURIComponent(a)}`);
    await page.waitForSelector('.side-scroll .note:not(.pending)');
    const words = await text(page);
    for (const w of ['Notizen', 'Muss', 'Sollte', 'Vergleich']) assert(words.includes(w), `"${w}" in the player`);
    await page.close();
  });

  await check('the client link in German, addressed as "Sie"', async () => {
    const page = await open(`/g/${link.token}`);
    await page.waitForSelector('video');
    await sleep(500);
    const words = await text(page);
    for (const w of ['Notizen', 'Freigeben', 'Änderungen anfordern']) assert(words.includes(w), `"${w}" on the client link`);
    assert(/\bSie\b/.test(words), 'the client is addressed as "Sie"');
    await page.close();
  });

  await check('every screen fits in German: phone, tablet, laptop, desktop', async () => {
    const out = [];
    for (const [name, url, ready] of [
      ['library', '/#/', '.film, .lrow'],
      ['board', '/#/status', '[data-testid=library-board]'],
      ['player', `/#/v/${encodeURIComponent(a)}`, '.side-scroll .note:not(.pending)'],
      ['client link', `/g/${link.token}`, 'video'],
      ['inbox', '/#/inbox', '[data-testid=inbox-view] :is(.inbox-row:not(.pending), .fy-item:not(.pending), .empty-state)'],
      ['insights', '/#/insights', '[data-testid=insights]'],
    ]) {
      const page = await open(url);
      await page.waitForSelector(ready, { timeout: 15000 });
      await settle(page);
      // fitsAt's sweep (390 to 1920), then the phone once more after the wide sizes.
      out.push(...(await fitsAt(page, `${name} (de)`)));
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await settle(page);
      for (const b of await sideways(page)) out.push(`${name} (de) @390 again: ${b}`);
      await page.close();
    }
    assert(!out.length, out.join('\n'));
  });

  await check('English by default, also in a German browser; no switch outside Settings', async () => {
    const en = await open('/#/', null);
    await en.evaluate(() => localStorage.removeItem('vr.lang'));
    await en.reload({ waitUntil: 'domcontentloaded' });
    await en.waitForSelector('.film, .lrow, [data-testid=library-board]');
    assert((await text(en)).includes('All videos'), 'a German browser gets English until German is chosen');
    assert(!(await en.$('.lang-switch')), 'no language switch outside Settings');
    await en.close();
  });

  // Marks only a page that was never reloaded still has; every change of <html lang> and every layout shift from now on
  // (shifts right after the click count too: hadRecentInput isn't excused here).
  const watch = (page) =>
    page.evaluate(() => {
      window.__kept = true;
      window.__langs = [];
      new MutationObserver(() => window.__langs.push(document.documentElement.lang)).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['lang'],
      });
      window.__shift = 0;
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__shift += e.value;
      }).observe({ type: 'layout-shift' });
    });
  const marks = (page) => page.evaluate(() => ({ kept: window.__kept === true, langs: window.__langs, shift: window.__shift }));
  // The card's date: 09/03/26 in English (the browser's English), 03.09.26 in German.
  const dateOn = (page) => page.$eval(`.film[data-slug="${oldSlug}"] .film-sub`, (el) => el.textContent);
  const EN_DATE = /\d{2}\/\d{2}\/\d{2}/;
  const DE_DATE = /\d{2}\.\d{2}\.\d{2}/;
  /** The account's language as the server has it. */
  const accountLang = async () => (await api('/api/auth/status')).user?.prefs?.lang;

  await check('Settings switches the language in place: no reload, nothing remounted, no shift, another tab follows', async () => {
    // A library in another tab of this browser: the choice is this device's, so it follows, also in place.
    const lib = await open('/#/', 'en');
    await lib.waitForSelector('.film, .lrow, [data-testid=library-board]');
    // the grid (the board check before left the board on)
    await lib.keyboard.press('1');
    await lib.waitForSelector(`.film[data-slug="${oldSlug}"] .film-sub`);
    assert(EN_DATE.test(await dateOn(lib)), `an English date first: ${await dateOn(lib)}`);
    const page = await open('/#/settings/appearance', 'en');
    await page.waitForSelector('.lang-switch [lang=de]');
    await settle(page, { quiet: 500 });
    await settle(lib, { quiet: 500 });
    await watch(page);
    await watch(lib);
    // What is on screen now stays the same elements: a remount would make new ones.
    const before = await page.evaluateHandle(() => [
      document.querySelector('.set-head h1'),
      document.querySelector('.set-nav'),
      document.querySelector('.lang-switch'),
    ]);
    const switchTo = async (lang, word, gone) => {
      const saved = page.waitForResponse((r) => r.url().endsWith('/api/auth/me') && r.request().method() === 'PATCH', { timeout: 30000 });
      await page.hover(`.lang-switch [lang=${lang}]`);
      await page.click(`.lang-switch [lang=${lang}]`);
      // The words come from their own chunk: on a loaded machine that takes a while, so the limit is for a state
      // that never comes, not a measure of speed.
      await page.waitForFunction((l, w) => document.documentElement.lang === l && document.body.innerText.includes(w), { timeout: 30000 }, lang, word);
      await (await saved).finished?.();
      await settle(page, { quiet: 500 });
      const m = await marks(page);
      assert(m.kept, `to ${lang}: the page reloaded`);
      assert(m.langs.length === 1 && m.langs[0] === lang, `to ${lang}: one language change, saw ${JSON.stringify(m.langs)}`);
      assert(m.shift < 0.01, `to ${lang}: layout shift ${m.shift.toFixed(4)} during the switch`);
      const words = await text(page);
      assert(!words.includes(gone), `to ${lang}: "${gone}" still on screen`);
      const state = await before.evaluate((els) => ({
        connected: els.every((e) => e?.isConnected),
        hash: location.hash,
        focus: !!document.activeElement?.closest('.lang-switch'),
        on: document.querySelector('.lang-switch [data-state=on]')?.getAttribute('lang'),
      }));
      assert(state.connected, `to ${lang}: the page was rendered anew (its elements were replaced)`);
      assert(state.hash === '#/settings/appearance', `to ${lang}: the section changed: ${state.hash}`);
      assert(state.focus, `to ${lang}: the focus left the switch`);
      assert(state.on === lang, `to ${lang}: the switch shows ${state.on}`);
      assert((await accountLang()) === lang, `to ${lang}: the account keeps ${await accountLang()}`);
      // The other tab: the same words, its date in the new format, without a reload either.
      await lib.waitForFunction((l) => document.documentElement.lang === l, { timeout: 30000 }, lang);
      await settle(lib, { quiet: 500 });
      const o = await marks(lib);
      assert(o.kept && o.langs.length === 1, `the other tab: kept ${o.kept}, changes ${JSON.stringify(o.langs)}`);
      assert(o.shift < 0.01, `the other tab: layout shift ${o.shift.toFixed(4)}`);
      const date = await dateOn(lib);
      assert((lang === 'de' ? DE_DATE : EN_DATE).test(date), `the other tab's date in ${lang}: ${date}`);
      for (const p of [page, lib])
        await p.evaluate(() => {
          window.__langs = [];
          window.__shift = 0;
        });
    };
    await switchTo('de', 'Darstellung', 'Appearance').catch((e) => {
      throw new Error(`to German: ${e.message}`);
    });
    const libWords = await text(lib);
    assert(libWords.includes('Alle Videos') && !/\bAll videos\b/.test(libWords), 'the other tab in German');
    await switchTo('en', 'Appearance', 'Darstellung').catch((e) => {
      throw new Error(`back to English: ${e.message}`);
    });
    await switchTo('de', 'Darstellung', 'Appearance').catch((e) => {
      throw new Error(`German again: ${e.message}`);
    });
    // A status answered later (here: another tab signs in, every tab asks the server) says what was saved: no second change.
    const asked = page.waitForResponse((r) => r.url().endsWith('/api/auth/status'), { timeout: 30000 });
    await lib.evaluate(() => new BroadcastChannel('vr-auth').postMessage('signed-in'));
    await asked;
    await settle(page, { quiet: 800 });
    const after = await marks(page);
    assert(
      after.kept && after.langs.length === 0 && (await page.evaluate(() => document.documentElement.lang)) === 'de',
      `after the status came again: ${JSON.stringify(after)}`,
    );
    await lib.close();
    await page.close();
  });

  await check('a status kept from before the switch (IndexedDB) never switches back after a reload', async () => {
    // German on this device and on the account (as the check before leaves it, here on its own too)
    await api('/api/auth/me', 'PATCH', { prefs: { lang: 'de' } });
    const page = await open('/#/settings/appearance', 'de');
    await page.waitForSelector('.lang-switch [lang=de][data-state=on]');
    /** Rewrites the kept status (api/persistWrite.ts) to say `lang` — what a write that didn't land before a reload
     * leaves; resolves with what it said before. */
    const keptStatus = (lang) =>
      page.evaluate(
        (lang) =>
          new Promise((resolve, reject) => {
            const req = indexedDB.open('vr-cache');
            req.onerror = () => reject(req.error);
            req.onsuccess = () => {
              const store = req.result.transaction('queries', 'readwrite').objectStore('queries');
              const all = store.getAll();
              all.onsuccess = () => {
                const e = all.result.find((x) => x.key[0] === 'auth' && x.key[1] === 'status');
                if (!e?.data?.user) return resolve(null);
                const was = e.data.user.prefs?.lang ?? null;
                if (lang) store.put({ ...e, data: { ...e.data, user: { ...e.data.user, prefs: { ...e.data.user.prefs, lang } } } });
                resolve(was);
              };
              all.onerror = () => reject(all.error);
            };
          }),
        lang,
      );
    // What this tab kept after the switch says German (the cache's copy is patched at once and written soon after).
    await page.waitForFunction(
      () =>
        new Promise((resolve) => {
          const req = indexedDB.open('vr-cache');
          req.onsuccess = () => {
            const all = req.result.transaction('queries').objectStore('queries').getAll();
            all.onsuccess = () => resolve(all.result.some((x) => x.key[0] === 'auth' && x.key[1] === 'status' && x.data?.user?.prefs?.lang === 'de'));
            all.onerror = () => resolve(false);
          };
          req.onerror = () => resolve(false);
        }),
      { polling: 200, timeout: 15000 },
    );
    await settle(page, { quiet: 1500 });
    assert((await keptStatus('en')) === 'de', 'the kept status said German');
    // Every <html lang> from the very start of the next load.
    await page.evaluateOnNewDocument(() => {
      window.__langs = [];
      new MutationObserver(() => window.__langs.push(document.documentElement?.lang)).observe(document, {
        attributes: true,
        attributeFilter: ['lang'],
        subtree: true,
      });
    });
    const fresh = page.waitForResponse((r) => r.url().endsWith('/api/auth/status'), { timeout: 30000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.lang-switch [data-state=on]');
    await fresh;
    await settle(page, { quiet: 1000 });
    const langs = await page.evaluate(() => window.__langs);
    assert(!langs.includes('en'), `the page went back to English on the kept status: ${JSON.stringify(langs)}`);
    assert((await page.evaluate(() => document.documentElement.lang)) === 'de' && (await text(page)).includes('Darstellung'), 'German after the reload');
    assert((await accountLang()) === 'de', 'the account still says German');
    await page.close();
  });

  await check('no page errors along the way', async () => {
    assert(!errors.length, errors.join(' | '));
  });
} catch (e) {
  crashed(e, srv);
} finally {
  await finish(LABEL, { browser, servers: [srv] });
}
