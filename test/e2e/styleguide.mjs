#!/usr/bin/env node
// covers: web/src/styleguide/ web/src/styles/ test/e2e/baseline/ web/src/player/RunStrip.tsx web/src/sessions/RunLine.tsx
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
import { settings } from '../../lib/env.ts';
import { ROOT, sleep } from '../lib/helpers.ts';
import { cutLabels, fitsAt } from './layout.mjs';
import { BASELINE_DIR, baselineFiles, baselinePlan } from './lib/baseline.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, skip } from './lib/checks.mjs';
import { concentric, inventory, SCALE } from './lib/designInventory.mjs';
import { diffPng } from './lib/png.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'styleguide e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const UPDATE = settings.LAMPO_UPDATE_BASELINE === '1';
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

  await check(
    'the styleguide shows every family: colour, type, scales, buttons in every state, fields, choosing, chips, glyphs, keys, progress, surfaces, floating, rows, loading, agents, empty states',
    async () => {
      const page = await open('dark', { width: 1440, height: 900 });
      const blocks = await page.$$eval('.sg-block', (els) => els.map((e) => e.getAttribute('aria-label')));
      assert(
        JSON.stringify(blocks) ===
          JSON.stringify([
            'Brand',
            'Colour',
            'Type',
            'Scales',
            'The raised material',
            'Buttons',
            'Fields',
            'Choosing',
            'Chips, badges and labels',
            'Keyframe glyphs',
            'Keys, avatars and code',
            'Progress and steps',
            'Surfaces',
            'Floating',
            'Rows and headers',
            'Loading',
            'Agent marks',
            'Agent at work',
            'Empty states',
          ]),
        `blocks: ${blocks}`,
      );
      const counts = await page.evaluate(() => ({
        buttons: document.querySelectorAll('.sg-block .btn').length,
        // every kind × every state (default, hover, pressed, focus, disabled, busy)
        states: document.querySelectorAll('[data-testid=sg-button-states] .sg-cell').length,
        tokens: document.querySelectorAll('[data-testid=sg-colours] .sg-colour').length,
        glyphs: document.querySelectorAll('[data-testid=sg-glyphs] .kg').length,
        empties: document.querySelectorAll('.sg-empties .empty-state').length,
        stages: document.querySelectorAll('.sbadge[data-stage]').length,
        logo: document.querySelectorAll('[data-testid=sg-brand] svg.brand-logo[aria-label=Lampo]').length,
        marks: document.querySelectorAll('[data-testid=sg-marks] .agent-mark').length,
        // an agent's work in every state of the design's table (ready and unreachable say nothing: no line)
        strips: document.querySelectorAll('[data-testid=sg-strips] [data-testid=run-strip]').length,
        sections: document.querySelectorAll('.sg-toc button').length,
      }));
      // every scene in ui/emptyArt.tsx
      assert(
        counts.buttons >= 80 &&
          counts.states === 7 * 6 &&
          counts.tokens >= 120 &&
          counts.glyphs === 6 * 7 &&
          counts.empties === 17 &&
          counts.stages >= 8 &&
          counts.logo === 1 &&
          counts.marks >= 12 &&
          counts.strips === 14 &&
          counts.sections === blocks.length,
        JSON.stringify(counts),
      );
      // the orange tone is an agent's, not a product's: the glyph table's column and the tone badges say "agent"
      const tones = await page.evaluate(() => ({
        glyphs: [...document.querySelectorAll('[data-testid=sg-glyphs] > .sg-label')].map((e) => e.textContent.trim()),
        // (the note rows' state labels are samples of their own, in the Agent at work block)
        badges: [...document.querySelectorAll('.sbadge[data-tone]:not(.nr-state)')].map((e) => e.dataset.tone),
      }));
      const TONES = JSON.stringify(['neutral', 'must', 'should', 'nice', 'idea', 'ok', 'agent']);
      assert(JSON.stringify(tones.glyphs) === TONES && JSON.stringify(tones.badges) === TONES, JSON.stringify(tones));
      await page.close();
    },
  );

  await check('each colour token shows in both themes side by side (theme islands), whatever theme the page is in', async () => {
    for (const theme of ['dark', 'light']) {
      const page = await open(theme, { width: 1440, height: 900 });
      const cells = await page.$$eval('[data-testid=sg-colours] .sg-colour-row', (rows) =>
        rows.map((r) => {
          const lum = (el) => {
            const [rr, g, b] = getComputedStyle(el)
              .backgroundColor.match(/[\d.]+/g)
              .map(Number);
            return (0.2126 * rr + 0.7152 * g + 0.0722 * b) / 255;
          };
          const [dark, light] = r.querySelectorAll('.sg-colour');
          return { token: r.querySelector('.sg-token').textContent, dark: lum(dark), light: lum(light), value: dark.querySelector('.sg-val').textContent };
        }),
      );
      await page.close();
      // the page each cell sits on is its theme's (--ink-1: near black, warm paper), and every value is read
      const wrong = cells.filter((c) => !(c.dark < 0.1 && c.light > 0.85) || !/^#[0-9a-f]{6}/.test(c.value));
      assert(cells.length >= 60 && !wrong.length, `${theme}: ${JSON.stringify(wrong.slice(0, 3))}`);
    }
  });

  await check('the segmented control’s raised item is concentric with its track: 8 − 1 − 2 = 5 (“Last active · Newest”)', async () => {
    const page = await open('dark', { width: 1440, height: 900 });
    const m = await page.$eval('.sg-sort', (track) => {
      const item = track.querySelector('button.on');
      const t = track.getBoundingClientRect();
      const i = item.getBoundingClientRect();
      return { R: parseFloat(getComputedStyle(track).borderTopLeftRadius), r: parseFloat(getComputedStyle(item).borderTopLeftRadius), inset: i.top - t.top };
    });
    await page.close();
    assert(m.inset === 3 && m.r === m.R - m.inset, JSON.stringify(m));
  });

  await check('hover, pressed and focus samples show the app’s own rules (pseudo-classes copied onto the samples)', async () => {
    const page = await open('dark', { width: 1440, height: 900 });
    const looks = await page.$$eval('[data-testid=sg-button-states] .sg-matrix-row', (rows) =>
      rows.slice(0, 4).map((r) => {
        const [base, hover, pressed, focus] = [...r.querySelectorAll('.sg-cell > *')].map((el) => getComputedStyle(el));
        return {
          row: r.querySelector('.sg-label').textContent,
          hover: hover.backgroundColor !== base.backgroundColor || hover.boxShadow !== base.boxShadow,
          pressed: pressed.transform !== base.transform,
          focus: focus.outlineStyle === 'solid' && focus.outlineWidth === '2px',
        };
      }),
    );
    await page.close();
    const off = looks.filter((l) => !(l.hover && l.pressed && l.focus));
    assert(looks.length === 4 && !off.length, JSON.stringify(off));
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

  // The static samples of the floats sat above a live dialog (their z-index counted on grid items): a modal covers
  // everything, the samples included.
  await check('a live question covers the static floats: its centre and corners, and the samples under its dimmed page', async () => {
    const out = [];
    for (const theme of ['dark', 'light']) {
      const page = await open(theme, { width: 1440, height: 900 });
      await page.$eval('[data-testid=sg-confirm]', (el) => el.scrollIntoView({ block: 'center' }));
      await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid=sg-live] button')].find((b) => b.textContent.trim() === 'Ask before deleting').click(),
      );
      await page.waitForSelector('[role=alertdialog]');
      // once it holds still (CALM turns its entrance off)
      await page.waitForFunction(() => !document.querySelector('[role=alertdialog]').getAnimations().length);
      const hits = await page.evaluate(() => {
        // what is painted on top, not what takes the pointer: a modal dialog turns the page's pointer-events off, and
        // hit-testing would then skip whatever lies over the dialog's dimmed page
        const see = document.createElement('style');
        see.textContent = '*{pointer-events:auto!important}';
        document.head.append(see);
        const dialog = document.querySelector('[role=alertdialog]');
        const r = dialog.getBoundingClientRect();
        const at = (x, y) => document.elementFromPoint(x, y);
        const inset = 6;
        const points = {
          centre: [r.left + r.width / 2, r.top + r.height / 2],
          'top-left': [r.left + inset, r.top + inset],
          'top-right': [r.right - inset, r.top + inset],
          'bottom-left': [r.left + inset, r.bottom - inset],
          'bottom-right': [r.right - inset, r.bottom - inset],
        };
        const bad = Object.entries(points)
          .filter(([, [x, y]]) => !dialog.contains(at(x, y)))
          .map(([k, [x, y]]) => `${k}: ${at(x, y)?.className || at(x, y)?.tagName}`);
        // the static samples in view: what is at their middles is the dialog's dimmed page or the dialog, never them
        for (const s of document.querySelectorAll('.sg-floats .sg-float, .sg-float-col > *')) {
          const b = s.getBoundingClientRect();
          if (b.bottom < 0 || b.top > innerHeight) continue;
          const hit = at(b.left + b.width / 2, b.top + b.height / 2);
          if (hit && s.contains(hit)) bad.push(`the static ${String(s.className).split(' ').slice(0, 2).join('.')} is on top`);
        }
        see.remove();
        return bad;
      });
      for (const h of hits) out.push(`${theme}: ${h}`);
      await page.keyboard.press('Escape');
      await page.close();
    }
    assert(!out.length, out.join('\n        '));
  });

  // A hover, focus or press rule that out-specifies a chosen state (`.on`, pressed) and sets its colour put the
  // chosen chip's words in its own fill's colour (fg on fg): every sample, in every state, keeps its words readable.
  await check('hovered, focused and pressed, every control keeps its words readable on its own ground (3:1), in both themes and both islands', async () => {
    const out = [];
    for (const theme of ['dark', 'light']) {
      const page = await open(theme, { width: 1440, height: 900 });
      const found = await page.evaluate(() => {
        const rgba = (c) => {
          const m = c.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/);
          if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
          const s = c.match(/^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)$/);
          if (s) return [s[1] * 255, s[2] * 255, s[3] * 255, s[4] === undefined ? 1 : +s[4]];
          return [0, 0, 0, 0];
        };
        const over = (top, below) => [0, 1, 2].map((k) => top[k] * top[3] + below[k] * (1 - top[3])).concat(1);
        // what the words stand on: the backgrounds from the element up, until one is opaque
        const ground = (el) => {
          const layers = [];
          for (let n = el; n; n = n.parentElement) {
            const c = rgba(getComputedStyle(n).backgroundColor);
            if (c[3] > 0) layers.push(c);
            if (c[3] >= 1) break;
          }
          return layers.reverse().reduce((below, top) => over(top, below), [255, 255, 255, 1]);
        };
        const lum = ([r, g, b]) => {
          const lin = (v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
          return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
        };
        const ratio = (a, b) => {
          const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
          return (x + 0.05) / (y + 0.05);
        };
        const ownWords = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        const who = (el) =>
          `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).slice(0, 3).join('.')} "${el.textContent.trim().slice(0, 16)}"`;
        const controls = [...document.querySelectorAll('.sg-block :is(button, a[href], [role=radio], [role=tab])')].filter(
          (el) => !el.disabled && ownWords(el) && el.getBoundingClientRect().width > 0,
        );
        const bad = [];
        for (const el of controls)
          for (const state of ['', 'sg-hover', 'sg-active', 'sg-focus']) {
            if (state) el.classList.add(state);
            const s = getComputedStyle(el);
            const bg = ground(el);
            const r = ratio(over(rgba(s.color), bg), bg);
            if (state) el.classList.remove(state);
            if (r < 3)
              bad.push(
                `${who(el)}${state ? ` ${state.slice(3)}` : ''} ${r.toFixed(2)}:1${el.closest('.theme-dark') ? ' (dark island)' : el.closest('.theme-light') ? ' (light island)' : ''}`,
              );
          }
        return { n: controls.length, bad };
      });
      await page.close();
      assert(found.n > 100, `${theme}: only ${found.n} controls with words`);
      for (const b of found.bad) out.push(`${theme}: ${b}`);
    }
    assert(!out.length, out.join('\n        '));
  });

  await check('nothing on it is cut, clipped or off the scales, phone to 1920', async () => {
    const page = await open('dark', { width: 1440, height: 900 });
    const fit = await fitsAt(page, 'styleguide');
    const labels = await cutLabels(page);
    const scale = await page.evaluate(inventory, { scale: SCALE, allow: ['.avatar', '.sg-type'] });
    const off = Object.entries(scale).flatMap(([k, list]) => list.map((x) => `${k} ${x.value} (${x.who.join(', ')})`));
    // nested corners follow the corner around them, in every block (the segmented control's raised item in its track)
    for (const n of await page.evaluate(concentric, { allow: ['.sg-scales'] })) off.push(`corner of ${n.who} in ${n.in}: ${n.corners}`);
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
