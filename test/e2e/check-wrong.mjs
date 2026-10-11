#!/usr/bin/env node
// covers: web/src/player/VerifyPanel.tsx web/src/player/CheckDecision.tsx web/src/player/useVerify.ts
// covers: web/src/player/fixCheck.ts web/src/player/Player.tsx web/src/styles/check.css server/routes/review.ts
// Browser suite of Still wrong with a picture (local mode, temp store, headless Chrome). In check mode, Still wrong opens
// the reason and the version being checked takes a drawing meanwhile: the drawing tools on the stage, a box to start
// with, "Draw on V2 to show where (optional)", then "1 mark on V2 goes with it". Reopen sends the words, the version and
// the drawing (PATCH `on: {v, frame, drawing}`), kept on the note's reply. The agent fixes it again in V3: the next
// check compares the version it was turned down on with the new one — "V2 → V3", the before picture V2 with the box
// drawn there on its frame — and the card says what was said ("Still wrong in V2 · drawn on it · “…”"). The card from
// the design system alone in both themes, at 1440 and 1024. Screenshots (VR_SHOTS).
import path from 'node:path';
import { age, makeVideo, until } from '../lib/helpers.ts';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { concentric, inventory, offTokens, SCALE } from './lib/designInventory.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'check-wrong e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-check-wrong-e2e-', user: 'Sam' });
const { dir, base: BASE } = srv;
const api = jsonApi(BASE);
const enc = encodeURIComponent;
const WHY = 'Still too small, and now it touches the logo';

let browser;
let page;
try {
  // title.mp4: V1 with Sam's note (a box round the title), V2 the agent's first fix
  const file = makeVideo(path.join(dir, 'Acme/export/title.mp4'), { w: 320, h: 180, fps: 25, dur: 4 });
  age(file);
  const { video } = await api('/api/library', 'POST', { path: file, folder: 'Acme' });
  const slug = video.slug;
  const n = await api(`/api/review/${enc(slug)}/comments`, 'POST', {
    v: 1,
    frame: 30,
    text: 'The title is too small: make it read on a phone',
    severity: 'must',
    drawing: [{ type: 'box', x: 40, y: 30, w: 110, h: 50 }],
  });
  const render = async (pattern) => {
    makeVideo(file, { w: 320, h: 180, fps: 25, dur: 4, pattern });
    age(file);
    await api(`/api/review/${enc(slug)}/sync`, 'POST', {});
  };
  await render('testsrc2');
  await api(`/api/comments/${n.id}`, 'PATCH', { status: 'fixed', note: 'Title 20 % larger', by: 'agent:promo-edit' });
  const note = async () => (await api(`/api/review/${enc(slug)}`)).review.comments.find((c) => c.id === n.id);

  browser = await launch();
  page = await browser.newPage();
  screenshotFailures(() => page, 'check-wrong');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `check-wrong-${name}.png`) });
  const text = (sel) => page.$eval(sel, (e) => e.textContent.trim()).catch(() => null);
  const openCheck = async (theme, width = 1440) => {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
    await page.setViewport({ width, height: 900 });
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${enc(slug)}?verify=${n.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=verify-card] [data-testid=check-wrong]', { timeout: 20000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.stage video')].every((v) => v.readyState >= 2), { timeout: 20000 });
    await page.waitForFunction(() => !document.querySelector('.verify')?.getAnimations().length);
  };
  /** The card made from the design system alone: tokens' colours, sizes and corners on the scales, concentric. */
  const designed = async () => {
    const colours = await page.evaluate(offTokens, { root: '.verify' });
    assert(!colours.length, `colours no token gives: ${JSON.stringify(colours)}`);
    const offScale = Object.entries(await page.evaluate(inventory, { scale: SCALE, allow: [], root: '.verify' })).filter(([, v]) => v.length);
    assert(!offScale.length, `off the scales: ${JSON.stringify(offScale)}`);
    const nested = await page.evaluate(concentric, { root: '.verify' });
    assert(!nested.length, `corners that don't follow the curve around them: ${JSON.stringify(nested)}`);
  };
  /** Drawn shapes in each picture, left to right (each shape is its line and its halo). */
  const shapesPerPane = () =>
    page.$$eval('.stage .pane', (panes) => panes.map((p) => Math.round(p.querySelectorAll('svg.layer rect, svg.layer path, svg.layer polyline').length / 2)));

  for (const width of [768, 1024, 1440, 1920])
    await check(`check mode's Still wrong at ${width}: the version being checked takes a drawing while the reason is given`, async () => {
      await openCheck('dark', width);
      assert((await text('.verify-vs')) === 'V1 → V2', `V1 → V2: ${await text('.verify-vs')}`);
      assert(!(await page.$('[data-testid=draw-bar]')), 'no drawing tools before Still wrong');
      await page.click('[data-testid=check-wrong]');
      await page.waitForSelector('[data-testid=verify-reason] input');
      await page.waitForSelector('[data-testid=draw-bar]');
      assert((await text('[data-testid=check-draw-hint]')) === 'Draw on V2 to show where (optional)', await text('[data-testid=check-draw-hint]'));
      // the drawing goes on the picture being checked — the right one, the after — with a box in hand
      const layer = await page.$eval('svg.layer.draw', (s) => {
        const pane = s.closest('.pane');
        const r = s.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, last: pane === [...document.querySelectorAll('.stage .pane')].at(-1), label: pane.textContent };
      });
      assert(layer.last && /After · V2/.test(layer.label), `drawn on the after picture: ${JSON.stringify(layer)}`);
      const pressed = await page.$eval('[data-testid=draw-bar] [aria-pressed=true]', (b) => b.getAttribute('aria-label'));
      assert(pressed === 'Box', `a box in hand: ${pressed}`);
      // nothing covers the reason: the card, its hint and the buttons within the window, no sideways scroll
      const fit = await page.evaluate(() => {
        const card = document.querySelector('.verify').getBoundingClientRect();
        return { right: card.right, bottom: card.bottom, w: innerWidth, h: innerHeight, scroll: document.documentElement.scrollWidth };
      });
      assert(fit.right <= fit.w && fit.bottom <= fit.h && fit.scroll <= fit.w, `the card fits: ${JSON.stringify(fit)}`);
      // the tools sit over the after picture, covering neither picture's label
      const bar = await page.evaluate(() => {
        const r = (e) => e.getBoundingClientRect();
        const b = r(document.querySelector('[data-testid=draw-bar]'));
        const after = r([...document.querySelectorAll('.stage .pane')].at(-1));
        const hit = [...document.querySelectorAll('.stage .pane-label')].filter((l) => {
          const x = r(l);
          return x.left < b.right && x.right > b.left && x.top < b.bottom && x.bottom > b.top;
        });
        return { over: b.left >= after.left - 1 && b.right <= after.right + 1, covers: hit.map((l) => l.textContent) };
      });
      assert(bar.over && !bar.covers.length, `the tools over the after picture, no label covered: ${JSON.stringify(bar)}`);
      await shot(`reason-${width}`);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('[data-testid=verify-reason]'));
      const away = await page
        .waitForFunction(() => !document.querySelector('[data-testid=draw-bar]'), { timeout: 3000 })
        .then(() => true)
        .catch(() => false);
      assert(away, 'Esc puts the drawing tools away with the reason');
    });

  for (const theme of ['dark', 'light'])
    await check(`Still wrong with a box on V2 (${theme}): the hint counts it; the card stays the design system's`, async () => {
      await openCheck(theme);
      await page.click('[data-testid=check-wrong]');
      await page.waitForSelector('[data-testid=draw-bar]');
      await page.type('[data-testid=verify-reason] input', WHY);
      const r = await page.$eval('svg.layer.draw', (s) => {
        const b = s.getBoundingClientRect();
        return { x: b.x, y: b.y, w: b.width, h: b.height };
      });
      await page.mouse.move(r.x + r.w * 0.55, r.y + r.h * 0.45);
      await page.mouse.down();
      await page.mouse.move(r.x + r.w * 0.92, r.y + r.h * 0.88, { steps: 6 });
      await page.mouse.up();
      await page.waitForFunction(() => document.querySelector('[data-testid=check-draw-hint]')?.textContent.includes('1 mark on V2 goes with it'));
      const drawn = await shapesPerPane();
      assert(drawn.length === 2 && drawn[1] >= 1, `the box on the after picture: ${JSON.stringify(drawn)}`);
      await designed();
      await shot(`drawn-${theme}`);
      if (theme === 'dark') {
        await page.keyboard.press('Escape');
        return;
      }
      // Reopen: the words, the version and the drawing go together
      await page.$$eval('[data-testid=verify-reason] button', (bs) => bs.find((b) => b.textContent.trim() === 'Reopen')?.click());
      await until(async () => (await note()).status === 'open', 'reopened');
      const reply = (await note()).replies.at(-1);
      assert(reply.text === WHY && reply.status === 'open' && reply.on_v === 2, `the reason names V2: ${JSON.stringify(reply)}`);
      const box = reply.drawing?.[0];
      assert(
        reply.drawing?.length === 1 && box.type === 'box' && box.x > 160 && box.y > 60,
        `the box where it was drawn, in V2's pixels: ${JSON.stringify(reply)}`,
      );
      assert(reply.on_frame === 30, `on the frame it was checked at: ${reply.on_frame}`);
    });

  // V3: the agent fixes it again
  await render('smptebars');
  await api(`/api/comments/${n.id}`, 'PATCH', { status: 'fixed', note: 'Title larger again, clear of the logo', by: 'agent:promo-edit' });

  for (const theme of ['dark', 'light'])
    await check(`the next check (${theme}) compares V2, where it was still wrong, with V3, and says what was said`, async () => {
      await openCheck(theme);
      assert((await text('.verify-vs')) === 'V2 → V3', `V2 → V3: ${await text('.verify-vs')}`);
      const labels = await page.$$eval('.stage .pane-label', (ls) => ls.map((l) => l.textContent.trim()));
      assert(labels[0] === 'Before · V2' && labels[1] === 'After · V3', `the pictures: ${JSON.stringify(labels)}`);
      const was = await text('[data-testid=verify-was]');
      assert(was === `Still wrong in V2 · drawn on it · “${WHY}”`, `what was said: ${was}`);
      // V2's picture carries the box drawn on it, beside the note's own; V3's only the note's
      const drawn = await shapesPerPane();
      assert(drawn[0] === drawn[1] + 1, `the box drawn on V2 on the before picture: ${JSON.stringify(drawn)}`);
      // read in order: the note, what was said last time, the new answer
      const order = await page.evaluate(() =>
        ['[data-testid=verify-note]', '[data-testid=verify-was]', '[data-testid=verify-fix]'].map(
          (s) => document.querySelector(s)?.getBoundingClientRect().top ?? -1,
        ),
      );
      assert(order[0] < order[1] && order[1] < order[2], `note, then what was said, then the answer: ${JSON.stringify(order)}`);
      await designed();
      await shot(`compare-${theme}`);
    });

  await check('no page errors', async () => assert(!errors.length, errors.join('\n')));
} catch (e) {
  crashed(e, srv);
} finally {
  await finish(LABEL, { browser, servers: [srv] });
}
