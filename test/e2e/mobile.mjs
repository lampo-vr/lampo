#!/usr/bin/env node
// covers: web/src/styles/mobile.css web/src/styles/phone.css web/src/player/phone/ web/src/player/PhoneDock.tsx
// covers: web/src/player/Transport.tsx web/src/styles/dock.css
// covers: web/src/player/DrawBar.tsx web/src/player/Timeline.tsx web/src/player/VerifyPanel.tsx web/src/share/
// covers: web/src/library/Sidebar.tsx web/src/player/phoneSheet.ts web/src/player/NotesPanel.tsx web/src/player/DockFoot.tsx
// covers: web/src/guest/GuestPlayer.tsx
// Browser end-to-end test of the phone layout: a real server (temp store, free port) + headless Chrome emulating an
// iPhone (touch, 390×844). A finger opens the folder drawer, shares a folder through the system share sheet (with an
// expiry from its switch and the calendar sheet; on a desktop its quick choices and the calendar by keyboard), scrubs
// the timeline to an exact frame (checked against ffmpeg's decode), draws an arrow, saves a note, moves the notes
// sheet, and verifies a fix by swiping between before and after. The play button's glyph stands in its middle on the
// phone and on the desk. Then no main screen may scroll sideways, hide a control off-screen, clip a glyph or put grain
// on a scroller, at three phone and tablet sizes and on a desktop. The phone player keeps its picture with the notes
// open, a note written and the keyboard up; its notes are one tap away and say how many are open; while a video plays
// on a phone neither player nor review link renders more than what shows the frame. A tap on the picture plays and
// pauses (a double tap is one tap, a drawing tool in hand draws instead), and held sideways the picture fills the
// screen under a bar that comes with a tap, steps frame-exactly, fades while it plays and leads to the notes.
// VR_SHOTS=<dir> keeps screenshots (and one of the page for each failed check).
import path from 'node:path';
import { timecode } from '../../lib/time.ts';
import { age, makeVideo, sleep, until } from '../lib/helpers.ts';
import { bentEdges, clippedText, cutLabels, dataTheme, grainOnScrollers, settle, sideways } from './layout.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { closestFrame, SH, SW, shownPicture } from './lib/frames.mjs';
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

  // The phone player's one screen, shared by the picture, the dock and the notes sheet — on a tall iPhone and in the
  // room Safari leaves under its bars (390 × 664), with an agent (its line above the dock), with motion on. Before: the
  // half-open sheet left the picture 62 px (8 px in Safari), the drawing tools covered all of it, the keyboard covered
  // the note's text and Send, opening the sheet made the picture jump up and then shrink, and a drag shrank it to 1 px.
  await check(
    'a phone keeps its picture: the notes half open, a note being written (its tools under the picture, never on it), the keyboard up; the sheet moves, the picture only one way (844, Safari’s 664)',
    async () => {
      const vbox = () => page.$eval('.vbox', (e) => Math.round(e.getBoundingClientRect().height));
      // the picture's height every frame while `act` plays out, until the sheet's motion is over and the picture holds still
      const film = async (act) => {
        await page.evaluate(() => {
          window.__film = [];
          window.__filming = true;
          const step = () => {
            const h = (q) => Math.round(document.querySelector(q)?.getBoundingClientRect().height ?? 0);
            window.__film.push([h('.vbox'), h('.stage')]);
            if (window.__filming) requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        });
        await act();
        await page.waitForFunction(
          () => {
            const f = window.__film.map(String);
            return !document.querySelector('.nsheet')?.getAnimations().length && f.length > 12 && f.slice(-8).every((x) => x === f.at(-1));
          },
          { polling: 'raf', timeout: 10000 },
        );
        return page.evaluate(() => {
          window.__filming = false;
          return window.__film;
        });
      };
      // a picture (or the stage around it) that grows and then shrinks, or the other way, in one move: a flash
      const turns = (film, keys = [0, 1]) => {
        let n = 0;
        for (const k of keys) {
          const hs = film.map((x) => x[k]);
          let dir = 0;
          for (let i = 1; i < hs.length; i++) {
            const d = Math.sign(hs[i] - hs[i - 1]);
            if (d && dir && d !== dir) n++;
            if (d) dir = d;
          }
        }
        return n;
      };
      const shown = (film) => film.map((x) => x.join('/')).join(' ');
      const visible = (sel, top, bottom) =>
        page.$eval(
          sel,
          (e, top, bottom) => {
            const r = e.getBoundingClientRect();
            return r.height > 0 && r.top >= top - 1 && r.bottom <= bottom + 1 ? true : `${Math.round(r.top)}–${Math.round(r.bottom)} outside ${top}–${bottom}`;
          },
          top,
          bottom,
        );
      // Save and Send, side by side at the composer's foot
      const sendButton = '.nsheet .composer-send';
      await api(`/api/review/${encodeURIComponent(slug)}/session`, {
        method: 'PUT',
        body: JSON.stringify({ name: 'launch-edit-agent', agent: 'claude-code' }),
      });
      // a stand-in for the visual viewport: a keyboard shrinks it (and the browser pans it to the field) while the page's
      // layout stays, as in Safari and Chrome on a phone; until one is "up" it answers as the real one
      await page.evaluateOnNewDocument(() => {
        const real = window.visualViewport;
        if (!real) return;
        const fake = new EventTarget();
        let h = null;
        let top = 0;
        for (const k of ['width', 'pageLeft', 'pageTop', 'offsetLeft', 'scale']) Object.defineProperty(fake, k, { get: () => real[k] });
        Object.defineProperty(fake, 'height', { get: () => h ?? real.height });
        Object.defineProperty(fake, 'offsetTop', { get: () => (h === null ? real.offsetTop : top) });
        for (const ev of ['resize', 'scroll']) real.addEventListener(ev, () => fake.dispatchEvent(new Event(ev)));
        Object.defineProperty(window, 'visualViewport', { value: fake, configurable: true });
        window.__keyboard = (height, offset = 0) => {
          h = height;
          top = offset;
          fake.dispatchEvent(new Event('resize'));
        };
      });
      const problems = [];
      try {
        for (const height of [844, 664]) {
          const at = `@390×${height}`;
          await page.emulate({ viewport: { width: 390, height, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, userAgent: IPHONE.userAgent });
          await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
          await page.goto('about:blank');
          await page.goto(`${BASE}/#/v/${encodeURIComponent(slug)}`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('.run-slot .run-strip');
          await page.waitForSelector('.nsheet-handle');
          await settled();
          await settle(page);
          const rest = await vbox();
          // at rest the picture has the room the bars leave (Safari's 664: the zoom's own row steps aside, 105 px before)
          if (rest < height * 0.22) problems.push(`${at} the picture at rest is ${rest} px`);
          // the sheet half open: the picture shrinks once, smoothly, and keeps about a fifth of the screen
          let hs = await film(() => tap('.nsheet-handle'));
          await page.waitForSelector('.nsheet-half');
          if (turns(hs)) problems.push(`${at} opening the sheet moved the picture both ways: ${shown(hs)}`);
          const half = await vbox();
          if (half < height * 0.18) problems.push(`${at} the picture with the notes half open is ${half} px`);
          const list = await page.$eval('.nsheet .side-scroll', (e) => e.clientHeight);
          if (list < 88) problems.push(`${at} the notes' list is ${list} px tall`);
          const tabs = await page.$$eval('.nsheet .note-tabs [role=tab]', (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
          if (tabs.some((x) => x < 40)) problems.push(`${at} the filters are ${tabs.join('/')} px tall`);
          await shot(`09-half-${height}`);
          // a note: the drawing tools in their own strip under the picture, the text and Send on the screen
          hs = await film(() => tap('[data-testid=new-note]'));
          await page.waitForSelector('.nsheet .composer textarea');
          // the tools' strip comes under the picture at once: the stage may grow by it first, the picture never moves back
          if (turns(hs, [0])) problems.push(`${at} opening the composer moved the picture both ways: ${shown(hs)}`);
          const tools = await page.evaluate(() => {
            const bar = document.querySelector('[data-testid=draw-bar]')?.getBoundingClientRect();
            const pic = document.querySelector('.vbox').getBoundingClientRect();
            const stage = document.querySelector('.stage').getBoundingClientRect();
            return bar && { gap: Math.round(bar.top - pic.bottom), inStage: bar.bottom <= stage.bottom + 1, pic: Math.round(pic.height) };
          });
          if (!tools || tools.gap < 0 || !tools.inStage) problems.push(`${at} the drawing tools sit on the picture: ${JSON.stringify(tools)}`);
          if (tools && tools.pic < height * 0.14) problems.push(`${at} the picture while a note is written is ${tools.pic} px`);
          for (const sel of ['.nsheet .composer textarea', sendButton]) {
            const ok = await visible(sel, 0, height);
            if (ok !== true) problems.push(`${at} ${sel}: ${ok}`);
          }
          const covered = await page.evaluate(() => {
            const text = document.querySelector('.nsheet .composer textarea').getBoundingClientRect();
            const foot = document.querySelector('.nsheet .composer-foot').getBoundingClientRect();
            return text.top + 20 > foot.top;
          });
          if (covered) problems.push(`${at} the composer's foot covers its text`);
          await shot(`09-compose-${height}`);
          // the keyboard up (40 %, the page panned 120 px to the field): the note's text and Send are above it
          await tap('.nsheet .composer textarea');
          const kb = Math.round(height * 0.6);
          // (the room changes once the keyboard is up: a state to wait for, given a few seconds before it counts as missing)
          const fits = (top, bottom) =>
            page
              .waitForFunction(
                (top, bottom) => {
                  const r = document.querySelector('.nsheet .composer-send')?.getBoundingClientRect();
                  return r && r.top >= top && r.bottom <= bottom;
                },
                { polling: 'raf', timeout: 5000 },
                top,
                bottom,
              )
              .catch(() => {});
          await page.evaluate((kb) => window.__keyboard(kb, 120), kb);
          await fits(120, 120 + kb);
          await settle(page);
          for (const sel of ['.nsheet .composer textarea', sendButton]) {
            const ok = await visible(sel, 120, 120 + kb);
            if (ok !== true) problems.push(`${at} keyboard up: ${sel}: ${ok}`);
          }
          const kbPic = await vbox();
          if (kbPic < kb * 0.2) problems.push(`${at} keyboard up: the picture is ${kbPic} px`);
          await shot(`09-keyboard-${height}`);
          await page.evaluate(() => window.__keyboard(null));
          await settle(page);
          // where the browser shrinks the page instead (Firefox on Android): the same room
          await page.setViewport({ width: 390, height: kb, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
          await fits(0, kb);
          await settle(page);
          for (const sel of ['.nsheet .composer textarea', sendButton]) {
            const ok = await visible(sel, 0, kb);
            if (ok !== true) problems.push(`${at} a shorter page: ${sel}: ${ok}`);
          }
          await page.setViewport({ width: 390, height, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
          await settle(page);
          await page.evaluate(() => document.activeElement?.blur());
          await tap('.nsheet .composer-close');
          await page.waitForFunction(() => !document.querySelector('.composer'));
          await settle(page);
          // dragged up to full: the picture never shrinks below where it ends
          const h = await center('.nsheet-handle');
          hs = await film(() => drag({ x: h.x, y: h.y }, { x: h.x, y: 60 }, 16));
          await page.waitForSelector('.nsheet-full');
          const least = Math.min(...hs.map((x) => x[0]));
          const full = await vbox();
          if (least < full - 1) problems.push(`${at} dragging the sheet shrank the picture to ${least} px (it ends at ${full})`);
          hs = await film(() => tap('.nsheet-handle'));
          await page.waitForSelector('.nsheet-peek');
          if (turns(hs)) problems.push(`${at} closing the sheet moved the picture both ways: ${shown(hs)}`);
        }
      } catch (e) {
        // what was found before the walk stopped is reported with it
        problems.push(`stopped: ${e.message}`);
      } finally {
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
        await api(`/api/review/${encodeURIComponent(slug)}/session`, { method: 'PUT', body: '{}' });
        await page.emulate(IPHONE);
      }
      assert(!problems.length, problems.join('\n'));
    },
  );

  await check(
    'a phone held sideways: the player takes the width with an agent’s line too, the notes clear the notch; a finger’s taps never zoom or pull the page',
    async () => {
      await api(`/api/review/${encodeURIComponent(slug)}/session`, {
        method: 'PUT',
        body: JSON.stringify({ name: 'launch-edit-agent', agent: 'claude-code' }),
      });
      try {
        await page.emulate({
          viewport: { width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true },
          userAgent: IPHONE.userAgent,
        });
        const cdp = await page.createCDPSession();
        await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 21, left: 47, right: 47 } });
        await page.goto('about:blank');
        await page.goto(`${BASE}/#/v/${encodeURIComponent(slug)}`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.run-slot .run-strip');
        await page.waitForSelector('.nr');
        await settle(page);
        const m = await page.evaluate(() => {
          const r = (q) => document.querySelector(q).getBoundingClientRect();
          return {
            vw: innerWidth,
            stage: Math.round(r('.stage').width),
            order: ['.p-strip', '.run-slot', '.dock'].map((q) => Math.round(r(q).top)),
            row: Math.round(r('.nsheet .nr').left),
            rowEnd: Math.round(r('.nsheet .nr').right),
          };
        });
        // before: the agent's line had no area in the sideways layout, got a column of its own, and the player took 511 of 844 px
        assert(m.stage >= m.vw - 1, `the picture spans the screen: ${JSON.stringify(m)}`);
        assert(m.order[0] < m.order[1] && m.order[1] < m.order[2], `the agent's line between the strip and the dock: ${JSON.stringify(m)}`);
        assert(m.row >= 47 && m.rowEnd <= m.vw - 47, `the notes clear the notch and the rounded corners: ${JSON.stringify(m)}`);
        await shot('10-sideways-agent');
        await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
        await page.emulate(IPHONE);
        await page.goto('about:blank');
        await page.goto(`${BASE}/#/v/${encodeURIComponent(slug)}`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.pbtns button');
        const touch = await page.evaluate(() => ({
          step: getComputedStyle(document.querySelector('.pbtns button[aria-label="Next frame"]')).touchAction,
          stage: getComputedStyle(document.querySelector('.stage')).touchAction,
          handle: getComputedStyle(document.querySelector('.nsheet-handle')).touchAction,
          timeline: getComputedStyle(document.querySelector('.timeline canvas')).touchAction,
          root: getComputedStyle(document.documentElement).overscrollBehaviorY,
          list: getComputedStyle(document.querySelector('.nsheet .side-scroll')).overscrollBehaviorY,
        }));
        // two quick taps on a step are two steps, not a zoom; the drags keep theirs; a pull past the top never reloads the page
        assert(touch.step === 'manipulation' && touch.stage === 'manipulation', `no double-tap zoom: ${JSON.stringify(touch)}`);
        assert(touch.handle === 'none' && touch.timeline === 'none', `the drags keep their own: ${JSON.stringify(touch)}`);
        assert(touch.root === 'none' && touch.list === 'contain', `no pull to refresh, no bounce of the whole app: ${JSON.stringify(touch)}`);
      } finally {
        await api(`/api/review/${encodeURIComponent(slug)}/session`, { method: 'PUT', body: '{}' });
        await page.emulate(IPHONE);
      }
    },
  );

  // Valentino: "I can't go to the comments, it's unclear, small". The sheet at rest was the handle (22 px) and a row of
  // tabs and icons without a count; now the row is the way in: what it holds, how many are open, a tap anywhere on it.
  await check('a phone’s notes are one tap away: the row at rest says how many are open and opens them; + Note beside it, nothing else', async () => {
    await page.emulate(IPHONE);
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${encodeURIComponent(slug)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.nsheet-peek [data-testid=notes-open]');
    await settle(page);
    const { review } = await api(`/api/review/${encodeURIComponent(slug)}`);
    const open = review.comments.filter((c) => c.status === 'open' || c.status === 'fixed').length;
    const row = await page.evaluate(() => {
      const b = document.querySelector('[data-testid=notes-open]');
      const r = b.getBoundingClientRect();
      const shown = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
      return {
        text: b.textContent.trim(),
        w: Math.round(r.width),
        h: Math.round(r.height),
        others: [...document.querySelectorAll('.nsheet .side-title button')].filter(shown).map((e) => e.getAttribute('aria-label') || e.textContent.trim()),
        size: parseFloat(getComputedStyle(b.querySelector('.nsheet-open-word')).fontSize),
      };
    });
    assert(row.h >= 44 && row.w >= 200, `the row is a big target: ${JSON.stringify(row)}`);
    assert(row.text.includes(`${open} open`), `it says how many notes are open (${open}): ${JSON.stringify(row)}`);
    assert(row.size >= 15, `"Notes" reads as the sheet's title: ${row.size} px`);
    assert(
      row.others.length === 2 && row.others.includes('Note'),
      `at rest only the way in and + Note (no tools nobody can read): ${JSON.stringify(row.others)}`,
    );
    await tap('[data-testid=notes-open]');
    await page.waitForSelector('.nsheet-half .nr');
    assert(await page.$('.nsheet-half [data-testid=panel-notes]'), 'open, the views are back');
    await shot('11-notes-open');
    await tap('.nsheet-handle');
    await page.waitForSelector('.nsheet-peek');
  });

  // Valentino: "the play in itself is laggy". While a video plays only what shows the frame may render per frame: the
  // timecode, the playhead, a note's "here" mark, a section chip's "→". Before: the review link rendered the whole page
  // 25 times a second (usePlayback without `quiet`), and the phone's tools row and transport rendered with the timecode.
  await check('while a video plays on a phone, the player and the review link render only what shows the frame', async () => {
    const share = await api(`/api/review/${encodeURIComponent(slug)}/shares`, { method: 'POST', body: JSON.stringify({ label: 'Playback', comment: true }) });
    const problems = [];
    for (const [where, url, play] of [
      ['player', `${BASE}/#/v/${encodeURIComponent(slug)}`, '.pbtns .playbtn'],
      ['review link', `${BASE}/g/${share.token}`, '.g-transport .playbtn'],
    ]) {
      await page.goto('about:blank');
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(`${play}:not([disabled])`);
      await settled();
      await settle(page);
      await page.evaluate(() => {
        const v = document.querySelector('.vbox video');
        v.loop = true;
        window.__changed = new Map();
        const what = (n) => {
          const e = n.nodeType === 1 ? n : n.parentElement;
          return e?.closest('.tc, .ptc, .tl-playhead, .nr, .note, .range-more, [data-testid=range-add]')
            ? null
            : `${e?.tagName.toLowerCase()}.${String(e?.className).split(' ')[0]}`;
        };
        window.__watch = new MutationObserver((list) => {
          for (const m of list) {
            const k = what(m.target);
            if (k) window.__changed.set(k, (window.__changed.get(k) || 0) + 1);
          }
        });
      });
      await page.$eval(play, (b) => b.click());
      await page.waitForSelector(`${play}.playing`);
      // from a frame into playback: what changes over the next 30 frames played
      const from = await page.evaluate(() => {
        window.__watch.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
        return document.querySelector('.vbox video').currentTime;
      });
      await page.waitForFunction((t0) => Math.abs(document.querySelector('.vbox video').currentTime - t0) >= 1, { polling: 50, timeout: 15000 }, from);
      const changed = await page.evaluate(() => {
        window.__watch.disconnect();
        return [...window.__changed].filter(([, n]) => n >= 10);
      });
      await page.$eval(play, (b) => b.click());
      if (changed.length) problems.push(`${where}: renders per frame beyond the frame's own display: ${JSON.stringify(changed)}`);
    }
    assert(!problems.length, problems.join('\n'));
  });

  // Valentino: "a tap on the video: play/pause on a phone, unless a drawing tool is active; don't break drawing,
  // double-tap or the sheet's drag". Before: a tap on the picture did nothing.
  await check(
    'a tap on a phone’s picture plays and pauses, a double tap is one tap, a drawing tool in hand draws instead (player and review link)',
    async () => {
      const share = await api(`/api/review/${encodeURIComponent(slug)}/shares`, { method: 'POST', body: JSON.stringify({ label: 'Taps', comment: true }) });
      await page.emulate(IPHONE);
      const paused = () => page.$eval('.vbox video', (v) => v.paused);
      const tapPicture = async () => {
        const c = await center('.vbox');
        await page.touchscreen.tap(c.x, c.y);
      };
      // a tap whose click has been handled (a click on the stage acts at once: play() or pause() turns `paused` then)
      const tapHandled = async () => {
        await page.evaluate(() => {
          window.__clicks = 0;
          document.addEventListener('click', () => window.__clicks++, { capture: true, once: true });
        });
        await tapPicture();
        await page.waitForFunction(() => window.__clicks > 0, { polling: 'raf', timeout: 5000 });
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
      };
      for (const [where, url, play] of [
        ['player', `${BASE}/#/v/${encodeURIComponent(slug)}`, '.pbtns .playbtn'],
        ['review link', `${BASE}/g/${share.token}`, '.g-transport .playbtn'],
      ]) {
        await page.goto('about:blank');
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector(`${play}:not([disabled])`);
        await settled();
        await settle(page);
        await page.$eval('.vbox video', (v) => {
          v.loop = true;
        });
        await tapPicture();
        await until(async () => !(await paused()), `${where}: a tap on the picture plays`);
        await page.waitForSelector(`${play}.playing`);
        assert(await page.$('[data-testid=tap-flash][data-playing]'), `${where}: the picture says it plays, for a moment`);
        // the next tap a moment later, as a person's (two taps closer than a double tap's are one)
        const t1 = await page.$eval('.vbox video', (v) => v.currentTime);
        await page.waitForFunction((t1) => document.querySelector('.vbox video').currentTime > t1 + 0.4, { polling: 50, timeout: 15000 }, t1);
        await tapPicture();
        await until(paused, `${where}: the next tap pauses`);
        assert(await page.$('[data-testid=tap-flash]:not([data-playing])'), `${where}: … and says so`);
        // a double tap: one play, not a play and a pause at once (after the time a double tap takes: that time is what
        // tells it from two taps, SidewaysBar.tsx DOUBLE_MS)
        await page.$eval('.vbox video', (v) => {
          window.__pauses = 0;
          v.addEventListener('pause', () => window.__pauses++);
        });
        await sleep(400);
        const c = await center('.vbox');
        // counted from here: the last tap's own pause event comes a task after `paused` turns
        await page.evaluate(() => {
          window.__pauses = 0;
        });
        // two taps made 60 ms apart (the touches carry when they were made: a loaded machine delivers them later)
        const cdp = await page.createCDPSession();
        const made = Date.now() / 1000;
        const touch = (type, at) =>
          cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: c.x, y: c.y }], timestamp: made + at });
        await touch('touchStart', 0);
        await touch('touchEnd', 0.02);
        await touch('touchStart', 0.06);
        await touch('touchEnd', 0.08);
        await cdp.detach();
        const t0 = await page.$eval('.vbox video', (v) => v.currentTime);
        await page.waitForFunction((t0) => document.querySelector('.vbox video').currentTime > t0 + 0.3, { polling: 50, timeout: 15000 }, t0);
        const after = await page.$eval('.vbox video', (v) => ({ pauses: window.__pauses, paused: v.paused, at: v.currentTime }));
        assert(after.pauses === 0 && !after.paused, `${where}: a double tap plays and keeps playing: ${JSON.stringify({ t0, ...after })}`);
        await page.$eval(play, (b) => b.click());
        await until(paused, `${where}: paused by its button`);
        // a drawing tool in hand: a tap draws (or starts to), it never plays
        if (where === 'player') {
          await tapText('.nsheet button.primary', 'Note');
          await page.waitForSelector('.composer textarea');
          await page.waitForSelector('[data-testid=draw-bar] .btn.on');
        } else {
          await tap('[data-testid=draw-bar] button[aria-label="Box"]');
          await page.waitForSelector('[data-testid=draw-bar] button[aria-label="Box"].on');
        }
        await settle(page);
        await tapHandled();
        assert(await paused(), `${where}: with a drawing tool in hand a tap on the picture doesn't play`);
        if (where === 'player') {
          await page.$eval('.composer-close', (b) => b.click());
          await page.waitForFunction(() => !document.querySelector('.composer'));
        } else await tap('[data-testid=draw-bar] button[aria-label="Box"]');
      }
    },
  );

  // Valentino: "sideways: the video fills the screen, with a slim play/frame-step bar that shows on a tap and fades out
  // (prefers-reduced-motion respected); it stays frame-exact (our player, not the native fullscreen); the notes stay
  // reachable". Before: the title bar over a picture 332 px tall, the transport and the notes under the fold.
  await check(
    'held sideways the picture fills the screen; a tap brings its slim bar — frame steps ffmpeg agrees with, play — which fades while it plays; Notes scrolls to the notes',
    async () => {
      const share = await api(`/api/review/${encodeURIComponent(slug)}/shares`, { method: 'POST', body: JSON.stringify({ label: 'Sideways', comment: true }) });
      const INSET = { top: 0, bottom: 21, left: 47, right: 47 };
      const cdp = await page.createCDPSession();
      try {
        await page.emulate({
          viewport: { width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true },
          userAgent: IPHONE.userAgent,
        });
        await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: INSET });
        const shownBar = () => page.$eval('[data-testid=sideways-bar]', (e) => e.dataset.bar === 'shown');
        const paused = () => page.$eval('.vbox video', (v) => v.paused);
        for (const [where, url, notes] of [
          ['player', `${BASE}/#/v/${encodeURIComponent(slug)}`, '.player > .side'],
          ['review link', `${BASE}/g/${share.token}`, '.g-player > .side'],
        ]) {
          await page.goto('about:blank');
          await page.goto(url, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('[data-testid=sideways-bar]');
          await settled();
          await settle(page);
          const m = await page.evaluate(() => {
            const r = (e) => {
              const b = e.getBoundingClientRect();
              return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) };
            };
            const bar = document.querySelector('[data-testid=sideways-bar]');
            return {
              vw: innerWidth,
              vh: innerHeight,
              stage: r(document.querySelector('.stage')),
              picture: r(document.querySelector('.vbox')),
              buttons: [...bar.querySelectorAll('button')].map((b) => ({ name: b.getAttribute('aria-label'), ...r(b) })),
              tools: !!bar.querySelector('[data-testid=draw-bar]'),
              stray: [...document.querySelectorAll('[data-testid=draw-bar]')].filter((e) => !bar.contains(e)).length,
            };
          });
          assert(
            m.stage.l === 0 && m.stage.t === 0 && m.stage.r === m.vw && m.stage.b === m.vh && m.picture.t === 0 && m.picture.b === m.vh,
            `${where}: the picture fills the screen's height: ${JSON.stringify({ stage: m.stage, picture: m.picture })}`,
          );
          assert(await shownBar(), `${where}: paused, its bar is up`);
          const bad = m.buttons.filter((b) => b.r - b.l < 44 || b.b - b.t < 44 || b.l < INSET.left || b.r > m.vw - INSET.right || b.b > m.vh - INSET.bottom);
          assert(!bad.length, `${where}: the bar's controls are a finger's size and clear the notch and the home indicator: ${JSON.stringify(bad)}`);
          if (where === 'review link') assert(m.tools && !m.stray, `the review link's drawing tools are in the bar: ${JSON.stringify(m)}`);
          // frame steps: our player's, checked against ffmpeg's decode (the video is V2, from frame 0)
          for (let i = 0; i < 3; i++) await tap('[data-testid=sideways-next]');
          await tap('[data-testid=sideways-prev]');
          await settled();
          await until(
            async () => (await page.$eval('.sideways-tc', (e) => e.textContent)) === timecode(2, 30),
            `${where}: the bar's timecode follows the steps`,
          );
          const best = closestFrame(video, await shownPicture(page), 2, N);
          assert(best.k === 2, `${where}: three steps on, one back: frame 2 shows (closest ffmpeg frame ${best.k}: ${best.line})`);
          await shot(`12-sideways-bar-${where.replace(' ', '-')}`);
          // a tap plays: the bar stays a moment, then fades while it plays
          await page.$eval('.vbox video', (v) => {
            v.loop = true;
          });
          const c = await center('.vbox');
          await page.touchscreen.tap(c.x, c.y);
          await until(async () => !(await paused()), `${where}: a tap on the picture plays`);
          assert(await shownBar(), `${where}: the tap brings the bar`);
          await until(async () => !(await shownBar()), `${where}: playing, the bar fades`, 10000);
          assert(!(await paused()), `${where}: … while the video plays on`);
          // hidden, the bar takes no tap: where its Notes button stood, a tap is the picture's
          const notesAt = m.buttons.find((b) => b.name?.startsWith('Notes') || b.name?.startsWith('Show notes'));
          assert(notesAt, `${where}: the bar has its Notes button: ${JSON.stringify(m.buttons)}`);
          await page.touchscreen.tap((notesAt.l + notesAt.r) / 2, (notesAt.t + notesAt.b) / 2);
          await until(paused, `${where}: a tap where the hidden bar stood pauses the picture`);
          assert((await page.evaluate(() => scrollY)) === 0 && (await shownBar()), `${where}: nothing scrolled; paused, the bar is back`);
          // the notes: one tap on the bar
          await tap('[data-testid=sideways-notes]');
          await until(async () => (await page.$eval(notes, (e) => e.getBoundingClientRect().top)) < 390 / 3, `${where}: Notes scrolls the page to the notes`);
          // reduced motion: the bar comes and goes at once (the app's reduced motion: no transitions)
          const fade = await page.$eval('[data-testid=sideways-bar]', (e) => getComputedStyle(e).transitionDuration);
          assert(fade === '0s', `${where}: with reduced motion the bar doesn't fade: ${fade}`);
        }
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
        const fade = await page.$eval('[data-testid=sideways-bar]', (e) => parseFloat(getComputedStyle(e).transitionDuration));
        assert(fade > 0, `without reduced motion the bar fades: ${fade}s`);
      } finally {
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
        await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
        await page.emulate(IPHONE);
      }
    },
  );

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
