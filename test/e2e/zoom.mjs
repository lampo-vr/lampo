#!/usr/bin/env node
// covers: web/src/player/Timeline.tsx web/src/player/ZoomControl.tsx web/src/player/Transport.tsx web/src/guest/GuestPlayer.tsx web/src/player/timelineView.ts web/src/styles/dock.css web/src/lib/prefs.ts
// Browser end-to-end test of the timeline's zoom, in the player and on a review link: a real server (local mode, temp
// store, free port) + headless Chrome. The control has a place of its own, never on the timeline: in the transport row
// beside the speed and the sound, in the row's own buttons (on a phone in a row above the ruler); it is labelled, its
// buttons are named and carry their keys in the tooltip, the level reads Fit → 2× → frames (the buttons beside it never
// move) and a click on it fits again; ⌘/ctrl + wheel zooms the timeline (never the page), and so do Safari's pinch
// gestures; the first time, a tip in the tooltips' neutral material points at the control (its key a key cap) — it
// covers no part of the timeline, moves nothing, goes with × or with the first zoom, stays gone after a reload, and
// waits while check mode's card floats over the picture's foot. Nothing of it touches the film strip, the ruler or the
// timeline at 390–1920 in either theme. On a phone the control is zoom in alone until it is zoomed, the tip says pinch,
// its buttons are hit across 44 px and two fingers zoom. Screenshots land in VR_SHOTS when it is set.
import path from 'node:path';
import { age, makeVideo, sleep, until } from '../lib/helpers.ts';
import { settle } from './layout.mjs';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'zoom e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-zoom-e2e-', user: 'Sam' });
const { dir, base: BASE } = srv;
const api = jsonApi(BASE);

const FPS = 30;
const N = 300; // 10 s: one step in shows half of it ("2×"), two more steps show a few dozen frames
const DESKTOP = { width: 1280, height: 800, deviceScaleFactor: SHOTS ? 2 : 1 };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

let browser;
let page;
screenshotFailures(() => page, 'zoom');
try {
  const video = makeVideo(path.join(dir, 'Spot/export/long.mp4'), { w: 320, h: 180, fps: FPS, dur: N / FPS, pattern: 'testsrc2' });
  age(video);
  const { video: summary } = await api('/api/library', 'POST', { path: video });
  const slug = summary.slug;
  const link = await api(`/api/review/${encodeURIComponent(slug)}/shares`, 'POST', { label: 'Mia' });
  const PLAYER = `${BASE}/#/v/${encodeURIComponent(slug)}`;
  const GUEST = `${BASE}/g/${link.token}`;

  browser = await launch();
  const errors = [];
  /** A page in a browser context of its own: nothing kept from another check (the tip comes back in each). */
  const fresh = async (viewport = DESKTOP) => {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport(viewport);
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));
    page = p;
    return p;
  };
  // The real player, not its loading state: that one draws the timeline and the zoom control too (PlayerLoading.tsx,
  // one frame long, so no tip), and on a busy machine it stays a while (CI 37256187938: "the tip: null"). The video
  // element comes only with the review.
  const open = async (p, url) => {
    await p.goto(url, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('.vbox video');
    await p.waitForSelector('.timeline canvas');
    await p.waitForSelector('[data-testid=tl-zoom]');
    await sleep(200);
  };
  const shot = async (p, name) => SHOTS && p.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  const level = (p) => p.$eval('[data-testid=tl-zoom-level]', (e) => e.textContent).catch(() => null);
  const view = (p) => p.$eval('.timeline', (e) => e.dataset.view ?? '');
  const span = async (p) => {
    const v = await view(p);
    if (!v) return N;
    const [a, b] = v.split('-').map(Number);
    return b - a;
  };
  const hint = (p) => p.$eval('[data-testid=tl-zoom-hint]', (e) => e.textContent).catch(() => null);
  const box = (p, sel) => p.$eval(sel, (e) => JSON.stringify(e.getBoundingClientRect()));
  /** Where the zoom and its tip are against the timeline (its film strip and ruler are its top 30 px: Timeline.tsx PERF,
   * RULER) and the transport row; `hit`: the buttons' tap areas (a ::after laid over a box). */
  const placement = (p) =>
    p.evaluate(() => {
      const r = (e) => {
        if (!e) return null;
        const b = e.getBoundingClientRect();
        return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
      };
      const ctl = document.querySelector('[data-testid=tl-zoom]');
      const t = r(document.querySelector('.timeline'));
      const hit = [...(ctl?.querySelectorAll('button') ?? [])].map((b) => {
        const x = r(b);
        const s = getComputedStyle(b, '::after');
        const px = (v) => (v.endsWith('px') ? parseFloat(v) : 0);
        return s.content === 'none' || s.position !== 'absolute'
          ? x
          : { left: x.left + px(s.left), right: x.right - px(s.right), top: x.top + px(s.top), bottom: x.bottom - px(s.bottom) };
      });
      return {
        ctl: r(ctl),
        tip: r(document.querySelector('[data-testid=tl-zoom-hint]')),
        timeline: t,
        strip: t && { ...t, bottom: t.top + 30 },
        hit,
        inTransport: !!ctl?.closest('.transport'),
        inHead: !!ctl?.closest('.tl-head'),
        onTimeline: !!ctl?.closest('.timeline'),
        mute: r(document.querySelector('.transport button[aria-label=Mute], .transport button[aria-label=Unmute]')),
        sideways: document.documentElement.scrollWidth > innerWidth + 1,
      };
    });
  const meets = (a, b) => !!a && !!b && a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
  /** Whatever of the zoom overlaps the timeline (its film strip and ruler first), as words; [] when nothing does. */
  const overlaps = (m) => [
    ...(meets(m.ctl, m.strip) ? ['the control is on the film strip or the ruler'] : []),
    ...(meets(m.ctl, m.timeline) ? ['the control is on the timeline'] : []),
    ...(m.onTimeline ? ['the control is inside the timeline'] : []),
    ...(meets(m.tip, m.timeline) ? ['the tip covers the timeline'] : []),
    ...(m.hit.some((h) => meets(h, m.timeline)) ? ['a tap area reaches into the timeline'] : []),
  ];
  /** The tip's look: the tooltips' material (a probe .tip's colours), neutral ink (no hue: the purple was an idea's
   * colour), its key a key cap. */
  const tipLook = (p) =>
    p.evaluate(() => {
      const tip = document.querySelector('[data-testid=tl-zoom-hint]');
      const probe = document.createElement('div');
      probe.className = 'tip';
      probe.style.cssText = 'position:fixed;left:-999px;top:0;animation:none';
      document.body.append(probe);
      const want = getComputedStyle(probe);
      const got = getComputedStyle(tip);
      const words = getComputedStyle(tip.querySelector('.zoomtip-words'));
      const hue = (c) => {
        const [r, g, b] = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        return Math.max(r, g, b) - Math.min(r, g, b);
      };
      const out = {
        bg: got.backgroundColor,
        fg: got.color,
        wantBg: want.backgroundColor,
        wantFg: want.color,
        hue: Math.max(hue(got.backgroundColor), hue(got.color), hue(words.color)),
        key: tip.querySelector('kbd')?.textContent ?? null,
      };
      probe.remove();
      return out;
    });
  const blur = (p) => p.evaluate(() => document.activeElement?.blur());
  /** The tooltip of `sel` once it says `what` (the one before may still be fading); else what it says by then. */
  const hoverTip = async (p, sel, what) => {
    await p.mouse.move(0, 0);
    await p.hover(sel);
    await p
      .waitForFunction((src) => new RegExp(src).test(document.querySelector('.tip')?.textContent ?? ''), { polling: 50, timeout: 4000 }, what.source)
      .catch(() => {});
    return p.$eval('.tip', (e) => e.textContent).catch(() => '');
  };
  /** ⌘/ctrl + wheel over the timeline's middle; says whether the page let the app take it (nothing zoomed the page). */
  const ctrlWheel = async (p, deltaY) => {
    await p.evaluate(() => {
      window.__wheel = [];
      window.addEventListener('wheel', (e) => window.__wheel.push(e.defaultPrevented), { once: true });
    });
    const tl = JSON.parse(await box(p, '.timeline'));
    await p.mouse.move(tl.x + tl.width / 2, tl.y + tl.height / 2);
    await p.keyboard.down('Control');
    await p.mouse.wheel({ deltaY });
    await p.keyboard.up('Control');
    return p.evaluate(() => ({ prevented: window.__wheel[0], scale: window.visualViewport?.scale ?? 1 }));
  };
  /** A tap area: the box and an invisible ::after laid over it. */
  const tapArea = (p, sel) =>
    p.$eval(sel, (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el, '::after');
      const px = (v) => (v.endsWith('px') ? parseFloat(v) : 0);
      if (s.content === 'none' || s.position !== 'absolute') return { w: r.width, h: r.height };
      return { w: r.width - px(s.left) - px(s.right), h: r.height - px(s.top) - px(s.bottom) };
    });

  await check('the player’s zoom control: labelled, named buttons with their keys, Fit → 2× → frames, a click on the level fits', async () => {
    const p = await fresh();
    await p.evaluateOnNewDocument(() => localStorage.setItem('vr.zoomhint', '{"seen":true}'));
    await open(p, PLAYER);
    assert((await p.$eval('[data-testid=tl-zoom]', (e) => e.getAttribute('aria-label'))) === 'Timeline zoom', 'the group is named');
    const names = await p.$$eval('[data-testid=tl-zoom] button', (els) => els.map((e) => e.getAttribute('aria-label')));
    assert(names.includes('Zoom out') && names.includes('Zoom in'), `its buttons: ${names}`);
    assert(!(await hint(p)), 'no tip once it was seen');
    assert((await level(p)) === 'Fit', `the whole video: ${await level(p)}`);
    assert(await p.$eval('[data-testid=tl-zoom-out]', (e) => e.disabled), 'nothing to zoom out of at Fit');
    const inTip = await hoverTip(p, '[data-testid=tl-zoom-in]', /Zoom in/);
    assert(/Zoom in/.test(inTip) && inTip.includes('='), `zoom in's tooltip names its key: ${inTip}`);
    const levelTip = await hoverTip(p, '[data-testid=tl-zoom-level]', /around the playhead/);
    assert(/around the playhead/.test(levelTip) && levelTip.includes('Z'), `the level's tooltip: ${levelTip}`);
    // in the transport row beside the speed and the sound, in its buttons: their height, their line, after the sound
    const m = await placement(p);
    assert(m.inTransport && !overlaps(m).length, `in the transport, off the timeline: ${JSON.stringify({ m, bad: overlaps(m) })}`);
    const btn = JSON.parse(await box(p, '[data-testid=tl-zoom-in]'));
    const mid = (r) => (r.top + r.bottom) / 2;
    assert(
      Math.abs(btn.height - (m.mute.bottom - m.mute.top)) < 1 && Math.abs(mid(btn) - mid(m.mute)) < 1.5 && m.ctl.left > m.mute.right,
      `beside the sound, in its row and height: ${JSON.stringify({ btn, mute: m.mute })}`,
    );
    // the buttons keep their places while the level's words change
    const inAt = JSON.parse(await box(p, '[data-testid=tl-zoom-in]')).left;
    await p.click('[data-testid=tl-zoom-in]');
    await until(async () => (await level(p)) === '2×', 'one step in: half the video');
    assert(JSON.parse(await box(p, '[data-testid=tl-zoom-in]')).left === inAt, 'zoom in stayed where it was');
    await p.click('[data-testid=tl-zoom-in]');
    await until(async () => /^\d+ frames$/.test((await level(p)) ?? ''), 'further in: the frames across');
    await blur(p);
    await p.keyboard.press('=');
    await until(async () => !!(await p.$('.timeline[data-cells]')), 'every frame a cell');
    assert(JSON.parse(await box(p, '[data-testid=tl-zoom-in]')).left === inAt, `zoom in stayed where it was at ${await level(p)}`);
    await shot(p, 'zoom-01-player-cells');
    await p.click('[data-testid=tl-zoom-level]');
    await until(async () => (await level(p)) === 'Fit' && !(await view(p)), 'a click on the level fits');
    await p.browserContext().close();
  });

  await check('⌘/ctrl + wheel and Safari’s pinch zoom the timeline, never the page', async () => {
    const p = await fresh();
    await p.evaluateOnNewDocument(() => localStorage.setItem('vr.zoomhint', '{"seen":true}'));
    await open(p, PLAYER);
    const w = await ctrlWheel(p, -300);
    await until(async () => (await span(p)) < N - 1, 'ctrl + wheel zoomed in');
    assert(w.prevented === true && w.scale === 1, `the page didn't zoom: ${JSON.stringify(w)}`);
    const s1 = await span(p);
    await ctrlWheel(p, 300);
    await until(async () => (await span(p)) > s1, 'ctrl + wheel the other way zooms out');
    await blur(p);
    await p.keyboard.press('0');
    await until(async () => !(await view(p)), 'fit');
    // Safari: a trackpad pinch arrives as gesture events (scale 2 = twice as close), which would zoom its page
    const g = await p.evaluate(() => {
      const tl = document.querySelector('.timeline');
      const r = tl.getBoundingClientRect();
      const fire = (type, scale) => {
        const e = new Event(type, { bubbles: true, cancelable: true });
        Object.assign(e, { scale, clientX: r.left + r.width / 2 });
        tl.dispatchEvent(e);
        return e.defaultPrevented;
      };
      return [fire('gesturestart', 1), fire('gesturechange', 2), fire('gestureend', 2)];
    });
    assert(g.every(Boolean), `every gesture event taken: ${g}`);
    await until(async () => Math.abs((await span(p)) - N / 2) < 2, 'a pinch to twice as close shows half the video');
    await p.browserContext().close();
  });

  await check('the first time, a neutral tip points at the control; it covers no timeline, moves nothing, × hides it for good', async () => {
    const p = await fresh();
    await open(p, PLAYER);
    const words = await hint(p);
    assert(/^(⌘|Ctrl) \+ scroll or pinch to zoom the timeline/.test(words ?? ''), `the tip: ${words}`);
    const look = await tipLook(p);
    assert(look.bg === look.wantBg && look.fg === look.wantFg && look.hue <= 24, `the tooltips' neutral material: ${JSON.stringify(look)}`);
    assert(look.key === '⌘' || look.key === 'Ctrl', `the key as a key cap: ${look.key}`);
    const tl = await box(p, '.timeline');
    const row = await box(p, '.transport');
    const m = await placement(p);
    // above the control, pointing at it: over the picture's foot, never over the timeline
    const centre = (m.ctl.left + m.ctl.right) / 2;
    assert(
      !overlaps(m).length && m.tip.bottom <= m.ctl.top && m.tip.left < centre && m.tip.right > centre,
      `the tip: ${JSON.stringify({ m, bad: overlaps(m) })}`,
    );
    await shot(p, 'zoom-02-tip');
    assert(/Hide this tip/.test(await p.$eval('[data-testid=tl-zoom-hint-x]', (e) => e.getAttribute('aria-label'))), 'its × is named');
    await p.click('[data-testid=tl-zoom-hint-x]');
    await until(async () => !(await hint(p)), 'gone with ×');
    assert((await box(p, '.timeline')) === tl && (await box(p, '.transport')) === row, 'the timeline and the transport stayed where they were');
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForSelector('.vbox video');
    await p.waitForSelector('[data-testid=tl-zoom]');
    await sleep(400);
    assert(!(await hint(p)), 'and stays gone after a reload');
    await p.browserContext().close();
  });

  await check('the tip goes with the first zoom too, and doesn’t come back', async () => {
    const p = await fresh();
    await open(p, PLAYER);
    assert(await hint(p), 'the tip is there');
    await blur(p);
    await p.keyboard.press('=');
    await until(async () => !(await hint(p)), 'gone once zoomed');
    await p.keyboard.press('0');
    await until(async () => !(await view(p)), 'fit again');
    await sleep(300);
    assert(!(await hint(p)), 'not back at Fit');
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForSelector('.vbox video');
    await p.waitForSelector('[data-testid=tl-zoom]');
    await sleep(400);
    assert(!(await hint(p)), 'nor after a reload');
    await p.browserContext().close();
  });

  await check('a review link: the same control in its words, the tip once, ⌘/ctrl + wheel', async () => {
    const p = await fresh();
    await open(p, GUEST);
    assert((await p.$eval('[data-testid=tl-zoom]', (e) => e.getAttribute('aria-label'))) === 'Timeline zoom', 'the group is named');
    assert(/scroll or pinch to zoom/.test((await hint(p)) ?? ''), `the tip: ${await hint(p)}`);
    assert((await level(p)) === 'Fit', 'the whole video');
    const m = await placement(p);
    assert(m.inTransport && m.ctl.left > m.mute.right && !overlaps(m).length, `beside the sound, off the timeline: ${JSON.stringify({ m, bad: overlaps(m) })}`);
    const look = await tipLook(p);
    assert(look.bg === look.wantBg && look.hue <= 24, `the tip in the tooltips' material: ${JSON.stringify(look)}`);
    const tip = await hoverTip(p, '[data-testid=tl-zoom-out]', /Zoom out/);
    assert(/Zoom out/.test(tip) && tip.includes('−'), `zoom out's tooltip: ${tip}`);
    await shot(p, 'zoom-03-link');
    const w = await ctrlWheel(p, -300);
    await until(async () => (await span(p)) < N - 1, 'ctrl + wheel zoomed in');
    assert(w.prevented === true, `the page didn't zoom: ${JSON.stringify(w)}`);
    await until(async () => !(await hint(p)), 'the tip went with the zoom');
    assert((await level(p)) !== 'Fit', `the level follows: ${await level(p)}`);
    await p.click('[data-testid=tl-zoom-level]');
    await until(async () => (await level(p)) === 'Fit', 'a click on the level fits');
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForSelector('.vbox video');
    await p.waitForSelector('[data-testid=tl-zoom]');
    await sleep(400);
    assert(!(await hint(p)), 'no tip after a reload');
    await p.browserContext().close();
  });

  await check('on a phone: zoom in alone until zoomed, the tip says pinch, 44 px tap areas, two fingers zoom', async () => {
    const p = await fresh(PHONE);
    await open(p, GUEST);
    assert((await hint(p)) === 'Pinch to zoom the timeline', `the tip for fingers: ${await hint(p)}`);
    assert(!(await p.$('[data-testid=tl-zoom-out]')) && !(await p.$('[data-testid=tl-zoom-level]')), 'only zoom in while the whole video shows');
    for (const sel of ['[data-testid=tl-zoom-in]', '[data-testid=tl-zoom-hint-x]']) {
      const a = await tapArea(p, sel);
      assert(Math.round(a.w) >= 44 && Math.round(a.h) >= 44, `${sel} is hit across 44 px: ${JSON.stringify(a)}`);
    }
    const tl = JSON.parse(await box(p, '.timeline'));
    const ph = await placement(p);
    // a row of its own above the ruler, the tip beside the control in it: on the screen, off the timeline
    assert(
      ph.inHead && !overlaps(ph).length && ph.ctl.bottom <= tl.top && ph.tip.right <= ph.ctl.left && ph.tip.left >= 0 && !ph.sideways,
      `above the ruler, nothing on the timeline: ${JSON.stringify({ ph, bad: overlaps(ph) })}`,
    );
    await shot(p, 'zoom-04-phone');
    await p.tap('[data-testid=tl-zoom-in]');
    await until(async () => (await level(p)) === '2×', 'a tap zooms in, and the level shows');
    assert(!(await hint(p)), 'the tip went with the zoom');
    for (const sel of ['[data-testid=tl-zoom-out]', '[data-testid=tl-zoom-level]']) {
      const a = await tapArea(p, sel);
      assert(Math.round(a.w) >= 44 && Math.round(a.h) >= 44, `${sel} is hit across 44 px: ${JSON.stringify(a)}`);
    }
    const zoomedAt = await placement(p);
    assert(!overlaps(zoomedAt).length, `zoomed, still off the timeline: ${overlaps(zoomedAt)}`);
    await shot(p, 'zoom-05-phone-zoomed');
    await p.tap('[data-testid=tl-zoom-level]');
    await until(async () => !(await view(p)) && !(await p.$('[data-testid=tl-zoom-level]')), 'a tap on the level fits, zoom in alone again');
    // two fingers spread over the timeline: closer
    const s = await p.target().createCDPSession();
    const y = tl.y + tl.height / 2;
    const cx = tl.x + tl.width / 2;
    const touch = (type, d) =>
      s.send('Input.dispatchTouchEvent', {
        type,
        touchPoints:
          type === 'touchEnd'
            ? []
            : [
                { x: cx - d, y, id: 1 },
                { x: cx + d, y, id: 2 },
              ],
      });
    await touch('touchStart', 30);
    for (const d of [45, 60, 75, 90]) await touch('touchMove', d);
    await touch('touchEnd', 0);
    await until(async () => (await span(p)) < N / 2, 'a pinch spread three times wider shows a third of the video or less');
    await p.browserContext().close();
  });

  // The notes sheet pulled up to full takes the dock, and the zoom in it, away: its tip goes with it — placed against
  // nothing it stood half off the top of the screen, over the title — and comes back with it.
  await check('on a phone the tip goes with its control: the notes sheet pulled up hides it, and it never leaves the screen', async () => {
    const p = await fresh(PHONE);
    await open(p, PLAYER);
    await p.waitForSelector('[data-testid=tl-zoom-hint]');
    const tipNow = () =>
      p.$eval('[data-testid=tl-zoom-hint]', (e) => {
        const r = e.getBoundingClientRect();
        const shown = getComputedStyle(e).visibility !== 'hidden';
        return { shown, inside: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth, top: Math.round(r.top) };
      });
    const before = await tipNow();
    assert(before.shown && before.inside, `the tip beside its control: ${JSON.stringify(before)}`);
    // a finger drags the sheet's handle up to full
    const h = await p.$eval('.nsheet-handle', (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await p.touchscreen.touchStart(h.x, h.y);
    for (let i = 1; i <= 16; i++) {
      await p.touchscreen.touchMove(h.x, h.y + ((120 - h.y) * i) / 16);
      await sleep(16);
    }
    await sleep(120); // hold still before lifting: a placement, not a flick
    await p.touchscreen.touchEnd();
    await p.waitForSelector('.nsheet-full');
    await until(async () => !(await tipNow()).shown, 'the tip hides with its control');
    const full = await tipNow();
    assert(!full.shown, `with the sheet up, no tip over the title: ${JSON.stringify(full)}`);
    await p.tap('.nsheet-handle');
    await p.waitForSelector('.nsheet-peek');
    await until(async () => (await tipNow()).shown, 'the tip back with its control');
    const back = await tipNow();
    assert(back.inside, `back on the screen: ${JSON.stringify(back)}`);
    await p.browserContext().close();
  });

  await check('at 390, 768, 1440 and 1920, both themes: the zoom and its tip never touch the film strip, the ruler or the timeline', async () => {
    const problems = [];
    for (const [where, url] of [
      ['player', PLAYER],
      ['review link', GUEST],
    ]) {
      const p = await fresh();
      await open(p, url);
      for (const theme of ['dark', 'light']) {
        await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
        for (const width of [390, 768, 1440, 1920]) {
          await p.setViewport({ width, height: 900 });
          await settle(p);
          await p.waitForSelector('[data-testid=tl-zoom]');
          const m = await placement(p);
          const at = `${where} @${width} ${theme}`;
          for (const bad of overlaps(m)) problems.push(`${at}: ${bad}`);
          if (m.sideways) problems.push(`${at}: the page scrolls sideways`);
          if (width < 640 ? !m.inHead : !m.inTransport) problems.push(`${at}: not in its place`);
          if (m.tip) {
            const look = await tipLook(p);
            if (look.bg !== look.wantBg || look.hue > 24) problems.push(`${at}: the tip's look ${JSON.stringify(look)}`);
          }
          if (theme === 'dark' && where === 'player') await shot(p, `zoom-06-${width}`);
        }
      }
      await p.browserContext().close();
    }
    assert(!problems.length, problems.join('\n'));
  });

  await check('check mode: the control stays in the transport, off the timeline; the tip waits until check mode is done', async () => {
    // a note fixed in a second version: check mode has a card over the picture's foot
    const note = await api(`/api/review/${encodeURIComponent(slug)}/comments`, 'POST', { v: 1, frame: 40, text: 'Title a beat later', severity: 'should' });
    makeVideo(video, { w: 320, h: 180, fps: FPS, dur: N / FPS, pattern: 'testsrc' });
    age(video);
    await api(`/api/review/${encodeURIComponent(slug)}/sync`, 'POST', {});
    await api(`/api/comments/${note.id}`, 'PATCH', { status: 'fixed', note: 'moved', by: 'agent:promo-edit' });
    const p = await fresh();
    await p.goto(`${PLAYER}?verify=${note.id}`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('.verify');
    await p.waitForSelector('[data-testid=tl-zoom]');
    await sleep(300);
    const m = await placement(p);
    assert(m.inTransport && !overlaps(m).length, `in the transport, off the timeline: ${JSON.stringify({ m, bad: overlaps(m) })}`);
    assert(!(await hint(p)), 'no tip while check mode’s card is over the picture’s foot');
    await shot(p, 'zoom-07-check');
    await p.keyboard.press('Escape');
    await until(async () => !(await p.$('.verify')), 'check mode closed');
    await until(async () => !!(await hint(p)), 'the tip comes once check mode is done');
    const after = await placement(p);
    assert(!overlaps(after).length, `the tip off the timeline: ${overlaps(after)}`);
    await p.browserContext().close();
  });

  await check('no page errors', async () => {
    assert(!errors.length, errors.join('\n'));
  });
} catch (e) {
  crashed(e, srv);
}
await finish(LABEL, { browser, servers: [srv] });
