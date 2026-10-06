#!/usr/bin/env node
// covers: web/src/styles/mobile.css web/src/styles/phone.css web/src/player/phone/ web/src/player/PhoneDock.tsx
// covers: web/src/player/Transport.tsx web/src/styles/dock.css
// covers: web/src/player/DrawBar.tsx web/src/player/Timeline.tsx web/src/player/VerifyPanel.tsx web/src/share/
// covers: web/src/library/Sidebar.tsx
// Browser end-to-end test of the phone layout: a real server (temp store, free port) + headless Chrome emulating an
// iPhone (touch, 390×844). A finger opens the folder drawer, shares a folder through the system share sheet (with an
// expiry from its switch and the calendar sheet; on a desktop its quick choices and the calendar by keyboard), scrubs
// the timeline to an exact frame (checked against ffmpeg's decode), draws an arrow, saves a note, moves the notes
// sheet, and verifies a fix by swiping between before and after. The play button's glyph stands in its middle on the
// phone and on the desk. Then no main screen may scroll sideways, hide a control off-screen, clip a glyph or put grain
// on a scroller, at three phone and tablet sizes and on a desktop.
// VR_SHOTS=<dir> keeps screenshots (and one of the page for each failed check).
import path from 'node:path';
import { age, makeVideo, sleep, until } from '../lib/helpers.ts';
import { bentEdges, clippedText, cutLabels, dataTheme, grainOnScrollers, settle, sideways } from './layout.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { closestFrame, SH, SW } from './lib/frames.mjs';
import { glyphCentre, glyphProblems } from './lib/glyph.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'mobile e2e';
requireChrome(LABEL);
const srv = await startServer({ prefix: 'vr-mobile-', user: 'tester' });
const { dir, base: BASE } = srv;
const SHOTS = shotsDir();

// A link that expires after the chosen day: the end of the day n days from today, local time.
const assertEndOfDay = (iso, n) => {
  const e = new Date(iso);
  const want = new Date();
  want.setDate(want.getDate() + n);
  assert(e.toDateString() === want.toDateString() && e.getHours() === 23 && e.getMinutes() === 59, `expires ${iso}, want the end of ${want.toDateString()}`);
};
const api = async (p, init) => {
  const r = await fetch(BASE + p, init && { ...init, headers: { 'Content-Type': 'application/json' } });
  const body = await r.json();
  if (!r.ok) throw new Error(`${p}: ${body.error}`);
  return body;
};

const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const IPHONE = {
  viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
};

let browser;
try {
  // A 16:9 clip in Acme/Reels with a fixed note on v2, so there is something to verify.
  const W = 320;
  const H = 180;
  const N = 90;
  const video = makeVideo(path.join(dir, 'Acme/export/spot.mp4'), { w: W, h: H, fps: 30, dur: 3 });
  age(video);
  const { video: summary } = await api('/api/library', { method: 'POST', body: JSON.stringify({ path: video, folder: 'Acme/Reels' }) });
  const slug = summary.slug;
  const early = await api(`/api/review/${encodeURIComponent(slug)}/comments`, {
    method: 'POST',
    body: JSON.stringify({ frame: 12, text: 'Logo too early', severity: 'must', drawing: [{ type: 'box', x: 20, y: 20, w: 80, h: 40 }] }),
  });
  makeVideo(video, { w: W, h: H, fps: 30, dur: 3, pattern: 'testsrc2' });
  age(video);
  await api(`/api/review/${encodeURIComponent(slug)}/sync`, { method: 'POST', body: '{}' });
  await api(`/api/comments/${early.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'fixed', note: 'Moved the logo to 1.0 s', by: 'agent:e2e' }) });

  browser = await launch();
  const page = await browser.newPage();
  screenshotFailures(() => page);
  await page.emulate(IPHONE);
  // No sheet or dialog animations: every measurement sees the final layout (the app honours reduced motion).
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  // No system share sheet in headless Chrome: record what would have been shared.
  await page.evaluateOnNewDocument(() => {
    navigator.share = async (data) => {
      window.__shared = data;
    };
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  // Where an element is once it has stopped moving: popovers are placed a frame after they open, and the picture
  // re-fits a frame after the notes sheet changes height. Measuring earlier aims at a stale spot.
  const center = async (sel) =>
    page.evaluate(async (sel) => {
      let last = '';
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        const e = document.querySelector(sel);
        if (!e) continue;
        const r = e.getBoundingClientRect();
        const key = [r.x, r.y, r.width, r.height].map(Math.round).join();
        if (key === last) return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, left: r.x, top: r.y };
        last = key;
      }
      throw new Error(`${sel} never settled`);
    }, sel);
  const tap = async (sel) => {
    await page.$eval(sel, (e) => e.scrollIntoView({ block: 'nearest' }));
    const c = await center(sel);
    await page.touchscreen.tap(c.x, c.y);
  };
  const tapText = async (sel, text) => {
    const c = await page.evaluate(
      async (sel, text) => {
        const find = () => [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().startsWith(text));
        let last = '';
        for (let i = 0; i < 90; i++) {
          await new Promise((r) => requestAnimationFrame(r));
          const e = find();
          if (!e) continue;
          const r = e.getBoundingClientRect();
          const key = [r.x, r.y].map(Math.round).join();
          if (key === last) break;
          last = key;
        }
        const el = find();
        if (!el) return null;
        el.scrollIntoView({ block: 'nearest' });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      },
      sel,
      text,
    );
    assert(c, `no ${sel} starting with "${text}"`);
    await page.touchscreen.tap(c.x, c.y);
  };
  const drag = async (from, to, steps = 12) => {
    await page.touchscreen.touchStart(from.x, from.y);
    for (let i = 1; i <= steps; i++) {
      await page.touchscreen.touchMove(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
      await sleep(16);
    }
    await sleep(120); // hold still before lifting: a placement, not a flick
    await page.touchscreen.touchEnd();
  };
  const settled = () =>
    page.waitForFunction(
      () => {
        const v =
          [...document.querySelectorAll('.vbox video')].find((x) => x.closest('.pane')?.style.visibility !== 'hidden') || document.querySelector('.vbox video');
        return v && v.readyState >= 2 && !v.seeking;
      },
      { polling: 100, timeout: 15000 },
    );

  console.log(`mobile e2e against ${BASE} (store ${dir})`);

  await check('the folder drawer opens by touch and shares a folder through the system share sheet', async () => {
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.film:not(.pending)');
    await tap('.nav-toggle');
    await page.waitForSelector('.drawer .nav-item');
    await shot('01-drawer');
    // the folder's actions are reachable without hover (measured once the drawer has slid in)
    const acts = await page.evaluate(async () => {
      let last = '';
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        const item = [...document.querySelectorAll('.drawer .nav-item')].find((e) => e.textContent.trim().startsWith('Acme'));
        const btn = item?.querySelector('.nav-actions [aria-label="Project actions"]');
        if (!btn) continue;
        const r = btn.getBoundingClientRect();
        const key = [r.x, r.y].map(Math.round).join();
        if (key === last)
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, visible: getComputedStyle(item.querySelector('.nav-actions')).display !== 'none' };
        last = key;
      }
      return null;
    });
    assert(acts?.visible, 'folder actions visible on touch');
    await page.touchscreen.tap(acts.x, acts.y);
    await page.waitForSelector('.menu');
    await tapText('.menu button', 'Share project');
    await page.waitForSelector('.modal');
    const modal = await center('.modal');
    assert(Math.round(modal.w) === 390 && modal.top + modal.h >= 843, `the dialog is a bottom sheet (${JSON.stringify(modal)})`);
    // Expiry by touch: its switch (a week out), then its button opens the choices as a sheet over the share sheet
    await page.waitForSelector('.modal [data-testid=link-details]');
    await tap('.modal .link-new [data-testid=link-expiry] [role=switch]');
    await page.waitForSelector('.modal [data-testid=link-date]');
    await tap('.modal [data-testid=link-date]');
    await page.waitForSelector('.modal .rdp-root', { timeout: 10000 });
    assert((await page.$$('.modal')).length === 2, 'the choices open as a sheet over the share sheet');
    await shot('02-expiry-calendar');
    await page.evaluate(() => {
      const days = [...document.querySelectorAll('.rdp-day')];
      const next = days.slice(days.findIndex((d) => d.classList.contains('rdp-selected')) + 1).find((d) => !d.classList.contains('rdp-disabled'));
      next.querySelector('button').setAttribute('data-e2e', 'pick');
    });
    await tap('button[data-e2e=pick]');
    await page.waitForFunction(() => !document.querySelector('.rdp-root') && document.querySelectorAll('.modal').length === 1, { polling: 100, timeout: 5000 });
    const readout = await page.$eval('.modal [data-testid=link-date]', (e) => e.textContent);
    assert(/in 8 days/.test(readout), `the picked day is the one after the week: ${readout}`);
    await tapText('.modal button', 'Create link');
    await page.waitForSelector('.link-row');
    await shot('02-share-folder');
    await tapText('.link-row button', 'Share');
    await page.waitForFunction(() => !!window.__shared, { polling: 100, timeout: 5000 });
    const shared = await page.evaluate(() => window.__shared);
    assert(/\/g\/[A-Za-z0-9_-]{20,}$/.test(shared.url), `shared ${shared.url}`);
    const link = await fetch(shared.url.replace(/^https?:\/\/[^/]+/, BASE).replace('/g/', '/api/g/')).then((r) => r.json());
    assert(link.kind === 'folder' && link.videos.length === 1, `a folder link to Acme: ${JSON.stringify(link).slice(0, 200)}`);
    const { shares } = await api(`/api/folder-shares?folder=${encodeURIComponent('Acme')}`);
    assertEndOfDay(shares[0]?.expires, 8);
  });

  await check('what floats on a phone: a question from the drawer comes above it, menus are sheets, popovers stay on screen', async () => {
    // Which of two portalled layers paints on top: their z-index (both hang off <body>). Hit-testing can't tell — a
    // modal dialog makes everything else ignore the pointer, so elementFromPoint looks straight through the drawer.
    const above = (upper, lower) =>
      page.evaluate(
        (u, l) => {
          const z = (s) => Number(getComputedStyle(document.querySelector(s)).zIndex) || 0;
          return z(u) > z(l) || `${u} ${z(u)} is not above ${l} ${z(l)}`;
        },
        upper,
        lower,
      );
    // a fresh page: the share sheet of the check before is still open on this one
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.film:not(.pending)');
    // a confirm asked from inside the drawer: the drawer stays open underneath, the question is on top of it
    await tap('.nav-toggle');
    await page.waitForSelector('.drawer .nav-item');
    const acts = await page.evaluate(async () => {
      let last = '';
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        const item = [...document.querySelectorAll('.drawer .nav-item')].find((e) => e.textContent.trim().startsWith('Acme'));
        const r = item?.querySelector('[aria-label="Project actions"]')?.getBoundingClientRect();
        if (!r) continue;
        const key = [r.x, r.y].map(Math.round).join();
        if (key === last) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        last = key;
      }
      return null;
    });
    await page.touchscreen.tap(acts.x, acts.y);
    await page.waitForSelector('.menu[data-state=open] [role=menuitem]');
    await tapText('.menu[data-state=open] [role=menuitem]', 'Delete project');
    await page.waitForSelector('[data-testid=confirm] h3');
    assert(await page.$('.drawer'), 'the drawer is still open underneath');
    const title = await page.$eval('[data-testid=confirm] h3', (e) => e.textContent);
    assert(title === 'Delete the project “Acme”?', `the question names the project: ${title}`);
    await center('[data-testid=confirm] h3');
    const onTop = await above('.backdrop:has([data-testid=confirm])', '.drawer');
    assert(onTop === true, `the question is above the drawer, not under it: ${onTop}`);
    await tapText('[data-testid=confirm] button', 'Cancel');
    await page.waitForFunction(() => !document.querySelector('[data-testid=confirm]'), { polling: 100, timeout: 5000 });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.drawer'), { polling: 100, timeout: 5000 });
    // a card's ⋯ menu: a sheet along the bottom edge, every row on the screen
    await tap('[aria-label="Actions for spot.mp4"]');
    await page.waitForSelector('.menu[data-state=open] [role=menuitem]');
    const sheet = await center('.menu');
    assert(
      Math.round(sheet.left) === 0 && Math.round(sheet.w) === 390 && Math.round(sheet.top + sheet.h) === 844,
      `the menu is a bottom sheet: ${JSON.stringify(sheet)}`,
    );
    const firstRow = await center('.menu[data-state=open] [role=menuitem]');
    assert(firstRow.top >= 0 && firstRow.h >= 44, `its first row is whole and thumb-high: ${JSON.stringify(firstRow)}`);
    await shot('02-menu-sheet');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.menu'), { polling: 100, timeout: 5000 });
    // the filter popover fits the screen
    await tap('.lib-filter-btn');
    await page.waitForSelector('.popover');
    const pop = await center('.popover');
    assert(pop.left >= 0 && pop.left + pop.w <= 390, `the popover is on the screen: ${JSON.stringify(pop)}`);
    await page.keyboard.press('Escape');
  });

  await check('a finger on the timeline lands on the exact frame ffmpeg decodes', async () => {
    await page.goto(`${BASE}/#/v/${encodeURIComponent(slug)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.phone-player .ptransport');
    await settled();
    const tl = await center('.timeline canvas');
    for (const target of [17, 61]) {
      // scrub: put the finger down elsewhere, drag across, lift on the target frame's column
      const xOf = (f) => tl.left + ((f + 0.5) * tl.w) / N;
      await drag({ x: xOf(5), y: tl.top + tl.h - 12 }, { x: xOf(target), y: tl.top + tl.h - 12 });
      await settled();
      await sleep(300);
      const got = await page.evaluate(
        ({ SW, SH }) => {
          const v = document.querySelector('.vbox video');
          const c = document.createElement('canvas');
          c.width = SW;
          c.height = SH;
          const g = c.getContext('2d');
          g.imageSmoothingQuality = 'high';
          g.drawImage(v, 0, 0, SW, SH);
          const d = g.getImageData(0, 0, SW, SH).data;
          const out = [];
          for (let i = 0; i < d.length; i += 4) out.push(Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]));
          return { out, frame: Number(document.querySelector('.ptc .sub b')?.textContent), drift: !!document.querySelector('.ptc .badge') };
        },
        { SW, SH },
      );
      assert(got.frame === target, `the transport says f${got.frame}, the finger lifted on f${target}`);
      const best = closestFrame(video, got.out, target, N);
      assert(best.k === target, `frame ${target}: closest ffmpeg frame is ${best.k} (${best.line})`);
      assert(!got.drift, `frame ${target}: presented ≠ requested`);
    }
    // the big step buttons are frame-exact too
    await tap('.pbtns button[aria-label="Next frame"]');
    await settled();
    assert(Number(await page.$eval('.ptc .sub b', (e) => e.textContent)) === 62, 'one step forward');
    await tap('.pbtns button[aria-label="Back 10 frames"]');
    await settled();
    assert(Number(await page.$eval('.ptc .sub b', (e) => e.textContent)) === 52, 'ten frames back');
    await shot('03-player');
  });

  await check('an arrow drawn with a finger is stored in video pixels; the note opens the sheet', async () => {
    await tapText('.nsheet button.primary', 'Note');
    await page.waitForSelector('.nsheet-half .composer textarea');
    // the drawing tools are on the picture, at a thumb's size
    const arrow = await page.$eval('[data-testid=draw-bar] button[aria-label="Arrow"]', (e) => {
      const r = e.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    assert(arrow.w >= 44 && arrow.h >= 44, `the Arrow tool is a thumb's size: ${JSON.stringify(arrow)}`);
    await tap('[data-testid=draw-bar] button[aria-label="Arrow"]');
    const box = await center('.vbox');
    await drag({ x: box.left + box.w * 0.25, y: box.top + box.h * 0.75 }, { x: box.left + box.w * 0.6, y: box.top + box.h * 0.35 });
    await page.type('.composer textarea', 'finger arrow');
    await shot('04-composer');
    await tapText('.composer button', 'Send');
    await page.waitForFunction(() => !document.querySelector('.composer'), { polling: 100, timeout: 20000 });
    const { review } = await api(`/api/review/${encodeURIComponent(slug)}`);
    const c = review.comments.find((x) => x.text === 'finger arrow');
    assert(c && c.frame === 52, `saved on f52: ${c?.frame}`);
    const [d] = c.drawing;
    const near = (a, b) => Math.abs(a - b) <= 3;
    assert(
      d.type === 'arrow' && near(d.x1, 0.25 * W) && near(d.y1, 0.75 * H) && near(d.x2, 0.6 * W) && near(d.y2, 0.35 * H),
      `arrow in video px: ${JSON.stringify(d)}`,
    );
  });

  await check('writing a note in the sheet: one toolbar of thumb-sized controls, Send on screen however long the note, × cancels', async () => {
    await tapText('.nsheet button.primary', 'Note');
    await page.waitForSelector('.nsheet .composer textarea');
    // measured once the composer has popped in (its entrance scales everything in it)
    await page.$eval('.composer', (e) => Promise.all(e.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {}))));
    const small = await page.$$eval('.nsheet .composer :is(.composer-foot, .composer-head) button', (els) =>
      els
        .map((e) => ({ name: e.getAttribute('aria-label') || e.textContent.trim(), r: e.getBoundingClientRect() }))
        .filter((b) => b.r.width && (Math.round(b.r.width) < 44 || Math.round(b.r.height) < 44))
        .map((b) => `${b.name} ${Math.round(b.r.width)}×${Math.round(b.r.height)}`),
    );
    assert(!small.length, `under 44 px: ${small.join(', ')}`);
    const rows = await page.$$eval('.nsheet .composer-foot button', (els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().top)))]);
    assert(rows.length === 1, `the toolbar is one row on a phone: ${rows.join(', ')}`);
    await tap('.nsheet .composer textarea');
    for (let i = 0; i < 14; i++) await page.keyboard.type(`Line ${i + 1} of a long note\n`);
    await page.evaluate(() => document.activeElement?.blur());
    const save = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.nsheet .composer-foot button')].find((e) => e.textContent.trim() === 'Send');
      const r = b?.getBoundingClientRect();
      return r && { top: r.top, bottom: r.bottom, vh: innerHeight };
    });
    assert(save && save.top >= 0 && save.bottom <= save.vh, `Send is on screen: ${JSON.stringify(save)}`);
    await shot('04b-composer-long');
    await tap('.nsheet .composer-close');
    await page.waitForFunction(() => !document.querySelector('.composer'), { timeout: 5000 });
  });

  await check('the notes sheet follows the finger: drag up to full, tap the handle to tuck it away', async () => {
    const h = await center('.nsheet-handle');
    await drag({ x: h.x, y: h.y }, { x: h.x, y: 120 }, 16);
    await page.waitForSelector('.nsheet-full');
    await shot('05-sheet-full');
    await tap('.nsheet-handle');
    await page.waitForSelector('.nsheet-peek');
  });

  await check('verify on a phone: before and after stacked, a swipe switches, "Looks right" closes the fix', async () => {
    await tap('.nsheet-handle');
    await page.waitForSelector('.nsheet-half');
    await tapText('.nsheet button', 'Check now');
    await page.waitForSelector('.nsheet .verify');
    await page.waitForSelector('.stage.stacked');
    await settled();
    const shown = () =>
      page.evaluate(() => [...document.querySelectorAll('.stage .pane')].findIndex((p) => p.style.visibility !== 'hidden' && p.querySelector('video')));
    const before = await page.evaluate(() => [...document.querySelectorAll('.stage .pane .pane-label')].map((l) => l.textContent));
    const first = await shown();
    const st = await center('.stage');
    await drag({ x: st.left + st.w * 0.8, y: st.top + st.h / 2 }, { x: st.left + st.w * 0.15, y: st.top + st.h / 2 }, 8);
    await sleep(200);
    const second = await shown();
    assert(first !== second, `the swipe switched panes (${first} → ${second}; labels ${before.join(', ')})`);
    const label = await page.$eval('.verify-side [data-state="on"]', (e) => e.textContent);
    assert(/Before/.test(label), `the toggle follows the swipe: ${label}`);
    await shot('06-verify-before');
    await tapText('.nsheet .verify button', 'Looks right');
    await page.waitForFunction(() => !document.querySelector('.nsheet .verify'), { polling: 100, timeout: 15000 });
    const { review } = await api(`/api/review/${encodeURIComponent(slug)}`);
    assert(review.comments.find((c) => c.id === early.id)?.status === 'verified', 'the fix is verified');
  });

  await check('link expiry on a desktop: a quick choice, then the calendar by keyboard, both from the date’s button', async () => {
    await page.emulate({ viewport: { width: 1440, height: 900, deviceScaleFactor: 1 }, userAgent: DESKTOP_UA });
    await page.goto(`${BASE}/#/folder/${encodeURIComponent('Acme/Reels')}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.film:not(.pending)');
    const click = (sel, text) =>
      page.evaluate((sel, text) => [...document.querySelectorAll(sel)].find((b) => b.textContent.trim().startsWith(text)).click(), sel, text);
    await click('.hero button', 'Share folder');
    await page.waitForSelector('.modal');
    await page.waitForSelector('.modal [data-testid=link-details]');
    await page.click('.modal .link-new [data-testid=link-expiry] [role=switch]');
    await page.waitForSelector('.modal [data-testid=link-date]');
    await page.click('.modal [data-testid=link-date]');
    await page.waitForSelector('.popover [data-testid=link-date-choices]', { timeout: 10000 });
    await click('.popover .link-date-quick button', '30 days');
    await until(
      () => page.evaluate(() => !document.querySelector('[data-testid=link-date-choices]')),
      () => 'the choices close after a quick one',
      5000,
    );
    await page.click('.modal [data-testid=link-date]');
    await page.waitForSelector('.popover .rdp-root', { timeout: 10000 });
    // the selected day has the focus; the arrow keys move it, Enter picks and closes
    await until(
      () => page.evaluate(() => !!document.activeElement?.closest('.rdp-selected')),
      () => page.evaluate(() => `the chosen day has the focus, not ${document.activeElement?.outerHTML.slice(0, 120)}`),
      5000,
    );
    await shot('07-expiry-popover');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.rdp-root'), { polling: 100, timeout: 3000 });
    const readout = await page.$eval('.modal [data-testid=link-date]', (e) => e.textContent);
    assert(/in 31 days/.test(readout), `picked the day after the 30-day choice: ${readout}`);
    await click('.modal button', 'Create link');
    await page.waitForSelector('.link-row');
    const { shares } = await api(`/api/folder-shares?folder=${encodeURIComponent('Acme/Reels')}`);
    assertEndOfDay(shares.find((x) => x.folder === 'Acme/Reels')?.expires, 31);
  });

  // A card's foot on a phone: where it stands, then the review link's line and the agent only where there are those —
  // no row held empty between the stage and the agent, or under a card without one (a finger, and a narrow window).
  await check('a phone card’s foot has the lines it holds and no empty ones', async () => {
    const foot = () =>
      page.$eval('.film:not(.pending) .film-foot', (f) => {
        const kids = [...f.children].filter((k) => k.getClientRects().length && getComputedStyle(k).display !== 'none').map((k) => k.getBoundingClientRect());
        const r = f.getBoundingClientRect();
        const gaps = kids.slice(1).map((k, i) => Math.round(k.top - kids[i].bottom));
        return { n: kids.length, gaps, tail: Math.round(r.bottom - Math.max(...kids.map((k) => k.bottom))) };
      });
    const problems = [];
    for (const [agent, label] of [
      [true, 'with an agent'],
      [false, 'without one'],
    ]) {
      await api(`/api/review/${encodeURIComponent(slug)}/session`, {
        method: 'PUT',
        body: JSON.stringify(agent ? { name: 'launch-edit-agent', agent: 'claude-code' } : {}),
      });
      for (const [vp, how] of [
        [IPHONE, 'touch'],
        [{ viewport: { width: 390, height: 844, deviceScaleFactor: 1 }, userAgent: DESKTOP_UA }, 'mouse'],
      ]) {
        await page.emulate(vp);
        await page.goto('about:blank');
        await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.film:not(.pending) .film-foot');
        await settle(page);
        const f = await foot();
        if (f.gaps.some((g) => g > 5) || f.tail > 1) problems.push(`${label}, ${how}: ${JSON.stringify(f)}`);
        if (agent && f.n < 2) problems.push(`${label}, ${how}: the agent's chip is missing (${JSON.stringify(f)})`);
      }
    }
    await api(`/api/review/${encodeURIComponent(slug)}/session`, { method: 'PUT', body: '{}' });
    await page.emulate(IPHONE);
    assert(!problems.length, problems.join(' · '));
  });

  await check('phone bars: one height per row, nothing cut or scrolling off the edge, the rest behind Display and More (360, 390)', async () => {
    // What a bar holds, measured: heights of the controls side by side, and anything sticking out of the bar or the screen.
    const bar = (sel, items) =>
      page.$eval(
        sel,
        (el, items) => {
          const r = el.getBoundingClientRect();
          const kids = [...el.querySelectorAll(items)].filter((k) => k.getClientRects().length);
          return {
            scrolls: el.scrollWidth > el.clientWidth + 1,
            heights: [...new Set(kids.map((k) => Math.round(k.getBoundingClientRect().height)))],
            out: kids
              .filter((k) => {
                const b = k.getBoundingClientRect();
                return b.left < Math.max(0, r.left) - 1 || b.right > Math.min(innerWidth, r.right) + 1;
              })
              .map((k) => k.getAttribute('aria-label') || k.textContent.trim().slice(0, 20)),
          };
        },
        items,
      );
    const inside = (sel) => page.$eval(sel, (e) => ((r) => r.left >= -1 && r.right <= innerWidth + 1)(e.getBoundingClientRect()));
    // The fullest strip: an agent assigned (its button beside compare) and the next step with its word. Before, the
    // agent's name chip and a menu of its own pushed "Check ▾" off the screen.
    await api(`/api/review/${encodeURIComponent(slug)}/session`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'launch-edit-agent', agent: 'claude-code' }),
    });
    for (const w of [360, 390]) {
      await page.emulate({ viewport: { width: w, height: 800, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, userAgent: IPHONE.userAgent });
      // the library: the field and its two buttons on one 44 px step; the layout switch lives in Display
      await page.goto('about:blank');
      await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.lib-toolbar .lib-display');
      const lib = await bar('.lib-toolbar', '.lib-filter .input, .lib-filter-btn, .lib-display');
      assert(lib.heights.length === 1 && lib.heights[0] === 44 && !lib.out.length, `library toolbar @${w}: ${JSON.stringify(lib)}`);
      assert(!(await page.$('.lib-toolbar [aria-label="Layout"]')), `@${w}: the layout switch is not in the phone's toolbar`);
      await page.click('.lib-display');
      await page.waitForSelector('.display-pop .dp-layout [aria-label="Layout"]', { timeout: 5000 });
      assert(await inside('.display-pop'), `@${w}: Display fits the screen`);
      await page.keyboard.press('Escape');
      // the player: the bar and the strip fit without scrolling, the strip's controls share one step, the tools row fits
      await page.goto('about:blank');
      await page.goto(`${BASE}/#/v/${encodeURIComponent(slug)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.p-strip [data-testid=stage-more], .p-strip [data-testid=stage-next]', { timeout: 15000 });
      await page.waitForSelector('.ptools [data-testid=ptools-more]');
      await sleep(300);
      const stage = await page.$eval('.p-bar [data-testid=stage-line]', (e) => e.textContent.trim());
      assert(stage.length > 2, `@${w}: the bar says where the video stands under its name: "${stage}"`);
      const top = await bar('.p-bar', 'button, .p-title');
      const strip = await bar('.p-strip', '.vpick, .btn, .session-chip');
      const tools = await bar('.ptools', 'button');
      // the strip under the timeline scrolls sideways: where it goes on, a soft edge, never a chip cut at the screen's edge
      const foot = await page.$eval('.dock-foot', (e) => ({ more: e.scrollWidth > e.clientWidth + 1, edge: e.classList.contains('more-r') }));
      assert(!foot.more || foot.edge, `@${w}: the dock's foot goes on past the edge without its soft edge: ${JSON.stringify(foot)}`);
      assert(!top.scrolls && !top.out.length, `player bar @${w}: ${JSON.stringify(top)}`);
      assert(!strip.scrolls && !strip.out.length && strip.heights.length === 1, `player strip @${w}: ${JSON.stringify(strip)}`);
      assert(!tools.scrolls && !tools.out.length && tools.heights.length === 1, `tools row @${w}: ${JSON.stringify(tools)}`);
      assert(await page.$('.p-strip [data-testid=agent-button]'), `@${w}: the assigned agent is one button in the strip`);
      // the notes sheet's head: + Note stays on the screen (its count is on the tabs, not in the head)
      const head = await bar('.nsheet .side-title', 'button');
      assert(!head.out.length, `notes sheet head @${w}: ${JSON.stringify(head)}`);
      await page.click('[data-testid=ptools-more]');
      await page.waitForSelector('.ptools-pop .pt-row', { timeout: 5000 });
      await sleep(200);
      assert(await inside('.ptools-pop'), `@${w}: More fits the screen`);
      await shot(`08-player-bars-${w}`);
      await page.keyboard.press('Escape');
    }
    await api(`/api/review/${encodeURIComponent(slug)}/session`, { method: 'PUT', body: '{}' });
    await page.emulate(IPHONE);
  });

  await check('the play button’s glyph stands in its middle, the triangle with its nudge: the phone’s transport and the desk’s', async () => {
    const problems = [];
    for (const [where, emulate, sel] of [
      ['phone', IPHONE, '.pbtns .playbtn'],
      ['desk', { viewport: { width: 1440, height: 900, deviceScaleFactor: 2 }, userAgent: DESKTOP_UA }, '.transport .playbtn'],
    ]) {
      await page.emulate(emulate);
      await page.goto('about:blank');
      await page.goto(`${BASE}/#/v/${encodeURIComponent(slug)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(`${sel}:not([disabled])`, { visible: true, timeout: 15000 });
      await settled();
      problems.push(...glyphProblems(await glyphCentre(page, sel), `${where} play`));
      await page.$eval('.vbox video', (v) => {
        v.loop = true;
      });
      await page.$eval(sel, (b) => b.click());
      await page.waitForSelector(`${sel}.playing`);
      problems.push(...glyphProblems(await glyphCentre(page, sel), `${where} pause`));
      await page.$eval(sel, (b) => b.click());
      await page.waitForSelector(`${sel}:not(.playing)`);
    }
    await page.emulate(IPHONE);
    assert(!problems.length, problems.join('\n'));
  });

  // The one English sweep of the main screens (quality's rules run at a phone and a desktop size; German and the dialogs
  // have their own suites). Each screen loads once as a phone and once as a desktop: within a kind a resize keeps the
  // page (a touch↔mouse change reloads it), so a state opened on it (the drawer, a dialog, the composer) is checked at
  // every width of that kind, opened again if a width closes it. Light is the default here (headless prefers it); the one
  // colour-dependent rule, bent edges, also runs in dark at 390 and 1440.
  await check(
    'every screen fits from 360 to 1920: nothing scrolls sideways, no glyph clipped, no label cut, no grain on a scroller, no bent edge (in dark too)',
    async () => {
      const share = await api(`/api/review/${encodeURIComponent(slug)}/shares`, { method: 'POST', body: JSON.stringify({ label: 'Client' }) });
      const card = '.film:not(.pending)';
      // after the board, the library's own pages keep that layout (it is remembered): any real card or row
      const content = ':is(.film, .lrow, .bcard):not(.pending)';
      const folder = `${BASE}/#/folder/${encodeURIComponent('Acme/Reels')}`;
      const player = `${BASE}/#/v/${encodeURIComponent(slug)}`;
      // [name, address, what shows the screen itself (not its loading state), what to open on it]
      const screens = [
        ['library', `${BASE}/#/`, card, 'layout:grid'],
        ['compact', `${BASE}/#/`, card, 'layout:compact'],
        ['list', `${BASE}/#/`, '.lrow:not(.pending)', 'layout:list'],
        ['board', `${BASE}/#/`, '.bcard:not(.pending)', 'layout:board'],
        ['folder', folder, content],
        ['drawer', `${BASE}/#/`, content, 'drawer'],
        ['player', player, '.timeline canvas'],
        ['composer', player, '.timeline canvas', 'compose'],
        ['share', folder, content, 'share'],
        ['insights', `${BASE}/#/insights`, '[data-testid=insights]'],
        ['inbox', `${BASE}/#/inbox`, '[data-testid=inbox-view] :is(.inbox-row:not(.pending), .fy-item:not(.pending), .empty-state)'],
        ['status', `${BASE}/#/status`, '.bcard:not(.pending)'],
        ['settings', `${BASE}/#/settings`, '.set-main'],
        ['guest', `${BASE}/g/${share.token}`, 'video'],
      ];
      const PHONES = [
        [360, 780],
        [390, 844],
        [430, 932],
        [768, 1024],
      ];
      const DESKTOPS = [
        [1024, 768],
        [1180, 820],
        [1280, 800],
        [1440, 900],
        [1920, 1080],
      ];
      const viewport = ([width, height], phone) =>
        phone ? { width, height, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { width, height, deviceScaleFactor: 1 };
      // what each state is, and how to open it
      const states = {
        drawer: ['.drawer .nav-item', () => page.click('.nav-toggle')],
        share: ['.modal', () => page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Share folder'))?.click())],
        compose: [
          '.composer',
          () => page.evaluate(() => [...document.querySelectorAll('.side button.primary')].find((b) => b.textContent.includes('Note'))?.click()),
        ],
      };
      const keep = async (action) => {
        const state = states[action];
        if (!state || (await page.$(state[0]))) return;
        await state[1]();
        await page.waitForSelector(state[0], { timeout: 5000 });
        await settle(page);
      };
      const open = async ([, url, ready, action], phone) => {
        // the device first, on a blank page (a touch↔mouse change reloads what is open)
        await page.goto('about:blank');
        await page.emulate({ viewport: viewport(phone ? PHONES[0] : DESKTOPS[0], phone), userAgent: phone ? IPHONE.userAgent : DESKTOP_UA });
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        if (action?.startsWith('layout:')) {
          await page.evaluate((layout) => localStorage.setItem('vr.library', JSON.stringify({ layout })), action.slice(7));
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.waitForSelector(`[data-layout=${action.slice(7)}]`, { timeout: 15000 });
        }
        await page.waitForSelector(ready, { timeout: 15000 });
        await settle(page);
        await keep(action);
      };
      const problems = [];
      const say = (where, bad) => bad.length && problems.push(`${where}: ${bad.slice(0, 4).join('; ')}`);
      const look = async (name, w, phone) => {
        const bad = [
          ...(phone ? await sideways(page) : []),
          ...(await clippedText(page)),
          ...(await cutLabels(page)),
          ...(await grainOnScrollers(page)),
          ...(await bentEdges(page)),
        ];
        if (name === 'insights' && (await page.$('.lib-toolbar'))) bad.push('the list toolbar shows on Insights, which has no list');
        say(`${name} @${w}`, bad);
        if (SHOTS) {
          await page.screenshot({ path: path.join(SHOTS, `fit-${name}-${w}.png`) });
          // the bottom of every scroller, where a grain overlay would end in a visible edge
          await page.evaluate(() => {
            for (const el of document.querySelectorAll('*'))
              if (el.scrollHeight > el.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) el.scrollTop = el.scrollHeight;
          });
          await page.screenshot({ path: path.join(SHOTS, `fit-${name}-${w}-bottom.png`) });
          await page.evaluate(() => {
            for (const el of document.querySelectorAll('*')) if (el.scrollTop) el.scrollTop = 0;
          });
        }
      };
      const inDark = async (name, w) => {
        await dataTheme(page, 'dark');
        await settle(page);
        say(`${name} @${w} dark`, await bentEdges(page));
        await dataTheme(page, 'light');
        await settle(page);
      };
      for (const screen of screens) {
        const [name, , , action] = screen;
        for (const phone of [true, false]) {
          // the drawer is the phone's way to the sidebar
          if (action === 'drawer' && !phone) continue;
          await open(screen, phone);
          for (const size of phone ? PHONES : DESKTOPS) {
            await page.setViewport(viewport(size, phone));
            await settle(page);
            await keep(action);
            await look(name, size[0], phone);
            if (size[0] === 390 || size[0] === 1440) await inDark(name, size[0]);
          }
        }
      }
      assert(!problems.length, problems.join('\n'));
    },
  );

  await check('no page errors along the way', async () => {
    assert(!errors.length, errors.slice(0, 5).join('\n'));
  });
} catch (e) {
  crashed(e, srv);
} finally {
  await finish(LABEL, { browser, servers: [srv] });
}
