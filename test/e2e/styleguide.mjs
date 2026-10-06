#!/usr/bin/env node
// covers: web/src/styleguide/ web/src/styles/ test/e2e/baseline/
// The design system's page (#/styleguide, in dev and test builds): every building block renders in both themes, every
// selected or pressed state wears the raised material, nothing on it is cut or off the scales at a phone and a
// desktop, and it looks the way it looked last time — a screenshot per theme compared with the baseline in
// test/e2e/baseline/ (per platform: fonts render differently elsewhere, so another platform records its own on the
// first run — except on CI, where a missing one fails, or is reported as skipped while the workflow says
// VR_BASELINE_MISSING=skip; lib/baseline.mjs). VR_UPDATE_BASELINE=1 records new ones after a deliberate change.
// Screenshots land in VR_SHOTS when set.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, sleep } from '../lib/helpers.ts';
import { cutLabels, fitsAt } from './layout.mjs';
import { BASELINE_DIR, baselineFiles, baselinePlan } from './lib/baseline.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, skip } from './lib/checks.mjs';
import { inventory, SCALE } from './lib/designInventory.mjs';
import { diffPng } from './lib/png.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'styleguide e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const UPDATE = process.env.VR_UPDATE_BASELINE === '1';
// Nothing moves while the picture is taken: no transitions, no indeterminate sweeps, no caret.
const CALM = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
// Pixels whose channels differ by more than this count as changed; more than this share of them fails.
const PIXEL = 24;
const SHARE = 0.002;

const srv = await startServer({ prefix: 'vr-styleguide-e2e-', user: 'Sam' });
let browser;
try {
  browser = await launch();
  const errors = [];
  const open = async (theme, vp) => {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewport(vp);
    await page.evaluateOnNewDocument((theme) => {
      try {
        localStorage.setItem('vr.theme', theme);
      } catch {}
    }, theme);
    await page.goto(`${srv.base}/#/styleguide`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=styleguide] .empty-state');
    await page.addStyleTag({ content: CALM });
    await page.evaluate(() => document.fonts.ready);
    await sleep(300);
    return page;
  };

  await check('the styleguide shows every family: buttons, chips, badges, choosing, surfaces, floating, rows, empty states, scales', async () => {
    const page = await open('dark', { width: 1440, height: 900 });
    const blocks = await page.$$eval('.sg-block', (els) => els.map((e) => e.getAttribute('aria-label')));
    assert(
      JSON.stringify(blocks) ===
        JSON.stringify([
          'Brand',
          'Agent marks',
          'The raised material',
          'Buttons',
          'Chips and badges',
          'Choosing',
          'Surfaces',
          'Floating',
          'Rows',
          'Empty states',
          'Scales',
        ]),
      `blocks: ${blocks}`,
    );
    const counts = await page.evaluate(() => ({
      buttons: document.querySelectorAll('.sg-block .btn').length,
      empties: document.querySelectorAll('.sg-empties .empty-state').length,
      stages: document.querySelectorAll('.sbadge[data-stage]').length,
      logo: document.querySelectorAll('[data-testid=sg-brand] svg.brand-logo[aria-label=Lampo]').length,
      marks: document.querySelectorAll('[data-testid=sg-marks] .agent-mark').length,
    }));
    // every scene in ui/emptyArt.tsx
    assert(counts.buttons >= 30 && counts.empties === 17 && counts.stages >= 8 && counts.logo === 1 && counts.marks >= 12, JSON.stringify(counts));
    await page.close();
  });

  await check('empty-state scenes: one lit element at most; every one moves, rests under reduced motion and pauses in a hidden tab', async () => {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewport({ width: 1280, height: 900 });
    // per scene, the play states of the animations on its elements
    const states = () =>
      page.evaluate(() => {
        const out = {};
        for (const a of document.getAnimations()) {
          const art = a.effect?.target instanceof Element && a.effect.target.closest('.sg-empties .empty-art');
          if (!art) continue;
          out[art.dataset.art] ??= [];
          out[art.dataset.art].push(a.playState);
        }
        return out;
      });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.goto(`${srv.base}/#/styleguide`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sg-empties .empty-art');
    const scenes = await page.$$eval('.sg-empties .empty-art', (arts) => arts.map((a) => a.dataset.art));
    await sleep(300);
    const reduced = Object.values(await states()).flat();
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
    // the timelines load as their own chunk when motion is allowed
    await page.waitForFunction(
      (n) =>
        new Set(
          document
            .getAnimations()
            .map((a) => a.effect?.target?.closest?.('.sg-empties .empty-art')?.dataset.art)
            .filter(Boolean),
        ).size === n,
      { timeout: 5000 },
      new Set(scenes).size,
    );
    const moving = await states();
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await sleep(300);
    const hidden = Object.values(await states()).flat();
    const lit = await page.$$eval('.sg-empties .empty-art', (arts) => arts.map((a) => `${a.dataset.art} ${a.querySelectorAll('.ea-lit').length}`));
    await page.close();
    assert(!reduced.length, `reduced motion: ${reduced.length} animations run`);
    const still = scenes.filter((n) => !moving[n]?.length);
    assert(!still.length, `scenes that don't move: ${still.join(', ')}`);
    const all = Object.values(moving).flat();
    assert(
      all.every((s) => s === 'running'),
      `with motion: ${[...new Set(all)]}`,
    );
    assert(hidden.length === all.length && hidden.every((s) => s === 'paused'), `hidden tab: ${[...new Set(hidden)]}`);
    const many = lit.filter((x) => Number(x.split(' ')[1]) > 1);
    assert(!many.length, `more than one lit element: ${many.join(', ')}`);
  });

  await check('empty-state scenes: keyframes sit centred on their lanes, and the key’s keyframe in its bow all through its loop', async () => {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.goto(`${srv.base}/#/styleguide`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sg-empties .empty-art');
    // at rest (the drawing): a keyframe inside a lane's box is on the lane's middle line, to a quarter of a unit
    const off = await page.$$eval('.sg-empties .empty-art', (arts) =>
      arts.flatMap((art) => {
        const lanes = [...art.querySelectorAll('.ea-lane')].map((l) => l.getBBox());
        return [...art.querySelectorAll('.ea-key, .ea-lit')].flatMap((k) => {
          const b = k.getBBox();
          const cx = b.x + b.width / 2;
          const cy = b.y + b.height / 2;
          const lane = lanes.find((l) => cx > l.x && cx < l.x + l.width && cy > l.y && cy < l.y + l.height);
          const miss = lane && Math.abs(cy - (lane.y + lane.height / 2));
          return miss > 0.25 ? [`${art.dataset.art}: keyframe at ${cx},${cy} is ${miss.toFixed(2)} off its lane's middle`] : [];
        });
      }),
    );
    assert(!off.length, off.join('; '));
    // moving: the token's keyframe and the hole of the bow share a centre at every point of the loop (they are one piece)
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
    const token = '.sg-empties .empty-art[data-art=token]';
    await page.waitForFunction((sel) => document.getAnimations().some((a) => a.effect?.target?.closest?.(sel)), { timeout: 5000 }, token);
    const drift = await page.evaluate((sel) => {
      const anims = document.getAnimations().filter((a) => a.effect?.target?.closest?.(sel));
      const T = anims[0].effect.getComputedTiming().duration;
      const centre = (el) => {
        const r = el.getBoundingClientRect();
        return [r.x + r.width / 2, r.y + r.height / 2];
      };
      let worst = 0;
      for (let t = 0; t < T; t += T / 40) {
        for (const a of anims) {
          a.pause();
          a.currentTime = t;
        }
        const [kx, ky] = centre(document.querySelector(`${sel} .ea-lit`));
        const [hx, hy] = centre(document.querySelector(`${sel} .ea-hole-ring`));
        worst = Math.max(worst, Math.hypot(kx - hx, ky - hy));
      }
      return worst;
    }, token);
    await page.close();
    assert(drift <= 0.5, `the key's keyframe leaves the middle of the bow by ${drift.toFixed(2)} px`);
  });

  await check('every selected or pressed state wears the raised material, in both themes', async () => {
    const out = [];
    for (const theme of ['dark', 'light']) {
      const page = await open(theme, { width: 1440, height: 900 });
      const looks = await page.evaluate(() =>
        [
          ...document.querySelectorAll(
            '.btn.primary:not(:disabled), .btn.on, .btn.danger-fill:not(:disabled), .seg button.on, .tabs button.on, .chip.on, .switch[data-state=checked] .switch-thumb',
          ),
        ].map((el) => {
          const s = getComputedStyle(el);
          return { who: `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')}`, img: s.backgroundImage, shadow: s.boxShadow };
        }),
      );
      assert(looks.length >= 20, `${theme}: only ${looks.length} raised elements found`);
      // the material: a sheen (a gradient) and an inset light edge plus a drop
      for (const l of looks)
        if (!/gradient/.test(l.img) || !/inset/.test(l.shadow)) out.push(`${theme}: ${l.who} is flat (${l.img.slice(0, 40)} | ${l.shadow.slice(0, 60)})`);
      await page.close();
    }
    assert(!out.length, out.join('\n        '));
  });

  await check('nothing on it is cut, clipped or off the scales, phone to 1920', async () => {
    const page = await open('dark', { width: 1440, height: 900 });
    const fit = await fitsAt(page, 'styleguide');
    const labels = await cutLabels(page);
    const scale = await page.evaluate(inventory, { scale: SCALE, allow: ['.avatar', '.sg-type'] });
    const off = Object.entries(scale).flatMap(([k, list]) => list.map((x) => `${k} ${x.value} (${x.who.join(', ')})`));
    await page.close();
    const all = [...fit, ...labels, ...off];
    assert(!all.length, all.join('\n        '));
  });

  await check('it looks the way it looked: a screenshot per theme against the baseline', async () => {
    fs.mkdirSync(BASELINE_DIR, { recursive: true });
    const out = [];
    const kept = [];
    for (const theme of ['dark', 'light']) {
      const page = await open(theme, { width: 1280, height: 900 });
      // the page is its own scroller: a window as tall as its content takes it in one picture
      const height = await page.$eval('.sg-page', (e) => Math.ceil(e.scrollHeight));
      await page.setViewport({ width: 1280, height });
      await sleep(300);
      const shot = await page.screenshot({ type: 'png' });
      if (SHOTS) fs.writeFileSync(path.join(SHOTS, `styleguide-${theme}.png`), shot);
      const { baseline: file, fresh } = baselineFiles(`styleguide-${theme}`);
      const plan = baselinePlan({ exists: fs.existsSync(file), update: UPDATE });
      if (plan === 'record') {
        fs.writeFileSync(file, shot);
        console.log(`      recorded ${path.relative(ROOT, file)}`);
      } else if (plan === 'missing' || plan === 'skip') {
        fs.mkdirSync(path.dirname(fresh), { recursive: true });
        fs.writeFileSync(fresh, shot);
        const missing = `${theme}: no baseline ${path.relative(ROOT, file)} to compare with on CI (this run's screenshot: ${path.relative(ROOT, fresh)}; commit it once it looks right)`;
        (plan === 'skip' ? kept : out).push(missing);
      } else {
        const r = diffPng(fs.readFileSync(file), Buffer.from(shot), PIXEL);
        if (r.size || r.changed / r.total > SHARE) {
          const now = path.join(SHOTS || os.tmpdir(), `styleguide-${theme}-now.png`);
          fs.writeFileSync(now, shot);
          out.push(
            `${theme}: ${r.size ? `size ${r.size}` : `${((100 * r.changed) / r.total).toFixed(2)} % of pixels changed`} (now: ${now}; VR_UPDATE_BASELINE=1 if meant)`,
          );
        }
      }
      await page.close();
    }
    assert(!out.length, out.join('\n        '));
    if (kept.length) skip(`nothing to compare with yet (VR_BASELINE_MISSING=skip):\n        ${kept.join('\n        ')}`);
  });

  await check('no page errors', async () => {
    assert(!errors.length, errors.join(' | '));
  });
} catch (e) {
  crashed(e, srv);
} finally {
  await finish(LABEL, { browser, servers: [srv] });
}
