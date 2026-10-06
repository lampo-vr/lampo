#!/usr/bin/env node
// covers: web/src/ui/ web/src/lib/toast.ts web/src/lib/transition.ts web/src/library/useVideoMenu.tsx
// covers: web/src/library/Sidebar.tsx web/src/styles/ui.css web/src/styles/primitives.css web/src/styles/system.css
// covers: web/src/styles/controls.css
// Browser end-to-end test of the UI building blocks (web/src/ui/): a real server (local mode, temp store, free port) +
// headless Chrome. Every icon-only button is named and has a tooltip (with its shortcut); a card's right-click menu
// has the ⋯ menu's items; archiving offers Undo and Undo restores; deleting a folder asks first (alert dialog, focus
// on Cancel); a deleted note leaves the screen at once and reaches the server only when its toast is gone; skeletons
// show while the library loads; the sidebar keeps its counts on hover; the stage badge is small; screens change with
// a View Transition, and not at all with reduced motion. Screenshots land in VR_SHOTS when it is set.
import path from 'node:path';
import { age, makeVideo, sleep, until } from '../lib/helpers.ts';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'ui e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-ui-e2e-', user: 'Sam' });
const { dir, base: BASE } = srv;

const api = jsonApi(BASE);

let browser;
try {
  const add = async (rel, folder) => {
    const file = makeVideo(path.join(dir, rel), { w: 320, h: 180, fps: 30, dur: 2, pattern: 'testsrc2' });
    age(file);
    const { video } = await api('/api/library', 'POST', { path: file, folder });
    return video;
  };
  const spot = await add('Acme/export/spot.mp4', 'Acme/Reels');
  const teaser = await add('Acme/export/teaser.mp4', 'Acme/Reels');
  const enc = encodeURIComponent;
  const note = await api(`/api/review/${enc(spot.slug)}/comments`, 'POST', { v: 1, frame: 12, text: 'Logo a touch later', severity: 'should' });
  await api(`/api/review/${enc(spot.slug)}/comments`, 'POST', { v: 1, frame: 30, text: 'Music softer', severity: 'nice' });
  await api('/api/folders', 'POST', { path: 'Scratch' });
  const library = async () => api('/api/library');
  const video = async (slug) => (await library()).videos.find((v) => v.slug === slug);
  const comments = async (slug) => (await api(`/api/review/${enc(slug)}`)).review.comments;

  browser = await launch({ reducedMotion: false });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `ui-${name}.png`) });
  const clickText = (sel, text) =>
    page.evaluate(
      (sel, text) => {
        const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().startsWith(text));
        el?.click();
        return !!el;
      },
      sel,
      text,
    );
  // Icon-only controls on screen: nothing but an icon inside (text may be a count badge, which still names nothing).
  const unnamed = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('button, [role=button], a.btn')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height || el.closest('[aria-hidden=true]') || el.matches('.nsheet-handle')) return false;
          const s = getComputedStyle(el);
          if (s.visibility === 'hidden' || s.opacity === '0') return false;
          return !el.textContent.replace(/\d+\+?/g, '').trim();
        })
        .filter((el) => !el.getAttribute('aria-label') || !el.hasAttribute('data-tip'))
        .map((el) => el.outerHTML.slice(0, 140)),
    );
  const hoverTip = async (selector) => {
    await page.mouse.move(0, 0);
    await sleep(350);
    await page.hover(selector);
    await page.waitForSelector('.tip', { timeout: 4000 });
    return page.$eval('.tip', (e) => e.textContent);
  };

  await check('library: every icon-only button is named and has a tooltip', async () => {
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.film:not(.pending)');
    await page.hover('.nav-item:nth-of-type(1)');
    const bad = await unnamed();
    assert(!bad.length, `without name or tooltip:\n${bad.join('\n')}`);
    const tip = await hoverTip('.inbox-bell');
    assert(/Inbox/.test(tip), `the bell's tooltip: ${tip}`);
  });

  await check('sidebar: counts stay visible on hover, the actions slide in beside them', async () => {
    const row = await page.evaluateHandle(() => [...document.querySelectorAll('.nav-item')].find((e) => e.textContent.includes('Acme')));
    await row.hover();
    await sleep(400);
    const st = await row.evaluate((el) => {
      const c = el.querySelector('.nav-count');
      const a = el.querySelector('.nav-actions');
      const cs = getComputedStyle(c);
      return {
        count: c.textContent,
        shown: cs.display !== 'none' && cs.visibility !== 'hidden' && c.getBoundingClientRect().width > 0,
        actions: getComputedStyle(a).opacity,
      };
    });
    assert(st.shown && st.count === '2', `count on hover: ${JSON.stringify(st)}`);
    assert(Number(st.actions) > 0.9, `actions shown on hover: ${JSON.stringify(st)}`);
    await shot('01-sidebar-hover');
  });

  await check('a new project’s name field sits where its name will be: the row keeps its height, the text its line', async () => {
    await page.click('button[aria-label="New project"]');
    await page.waitForSelector('.nav-input');
    const m = await page.evaluate(() => {
      const input = document.querySelector('.nav-input');
      const row = input.closest('.nav-item');
      // a project row beside it: its label is where the new name will stand
      const other = [...document.querySelectorAll('.nav-item')].find((e) => e !== row && e.textContent.includes('Acme'));
      const label = other.querySelector('.nav-label');
      const ir = input.getBoundingClientRect();
      const cs = getComputedStyle(input);
      return {
        text: ir.left + parseFloat(cs.paddingLeft),
        label: label.getBoundingClientRect().left,
        rowH: row.getBoundingClientRect().height,
        otherH: other.getBoundingClientRect().height,
        font: [cs.fontSize, getComputedStyle(label).fontSize],
      };
    });
    await page.keyboard.press('Escape');
    assert(Math.abs(m.text - m.label) <= 1, `the typed name starts on the labels' line: ${JSON.stringify(m)}`);
    assert(Math.abs(m.rowH - m.otherH) <= 0.5 && m.font[0] === m.font[1], `same row height and font: ${JSON.stringify(m)}`);
  });

  await check('the stage badge is a small badge, not a full-width bar', async () => {
    const r = await page.$eval('.film [data-testid=status-pill]', (e) => ({
      cls: e.className,
      w: e.getBoundingClientRect().width,
      card: e.closest('.film').getBoundingClientRect().width,
    }));
    assert(/sbadge/.test(r.cls) && r.w < r.card * 0.75, `badge ${r.w}px on a ${r.card}px card (${r.cls})`);
  });

  await check('a menu opens where it stays: its trigger keeps its size while pressed, the first frame is where it settles', async () => {
    // a fresh page, so the menu's code arrives with this press (the first open): it was placed from the pressed, 96 %
    // trigger and jumped 3 px when the button let go
    const p = await browser.newPage();
    try {
      await p.setViewport({ width: 1440, height: 900 });
      await p.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
      const sel = 'button[aria-label="Actions for teaser.mp4"]';
      await p.waitForSelector(sel, { visible: true, timeout: 20000 });
      await p.evaluate(() => {
        window.__menuX = [];
        const t0 = performance.now();
        const tick = () => {
          const w = document.querySelector('.menu')?.parentElement;
          // Radix keeps it off screen (-200 %) until it has a position
          if (w && !w.style.transform.includes('-200%')) window.__menuX.push(Math.round(w.getBoundingClientRect().x * 10) / 10);
          if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const b = await (await p.$(sel)).boundingBox();
      await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await p.mouse.down();
      await sleep(150);
      const pressed = await p.$eval(sel, (e) => e.getBoundingClientRect().width);
      await p.mouse.up();
      assert(Math.abs(pressed - b.width) < 0.5, `the trigger keeps its size while pressed: ${b.width} → ${pressed}`);
      await p.waitForSelector('.menu', { visible: true });
      await sleep(400);
      const xs = await p.evaluate(() => window.__menuX);
      assert(xs.length > 2 && Math.max(...xs) - Math.min(...xs) < 0.5, `the menu doesn't move once it's there: ${xs.join(', ')}`);
    } finally {
      await p.close();
    }
  });

  await check('right-click on a card opens its menu, with the same items as ⋯', async () => {
    const card = await page.evaluateHandle((name) => [...document.querySelectorAll('.film')].find((e) => e.textContent.includes(name)), 'spot.mp4');
    await card.hover();
    await (await card.$('.film-menu .btn')).click();
    await page.waitForSelector('.menu[data-state=open] [role=menuitem]');
    const dots = await page.$$eval('.menu[data-state=open] [role=menuitem]', (els) => els.map((e) => e.textContent.trim()));
    await page.keyboard.press('Escape');
    await until(async () => !(await page.$('.menu')), 'the ⋯ menu closed');
    const box = await card.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + 80, { button: 'right' });
    await page.waitForSelector('[data-testid=context-menu] [role=menuitem]');
    const ctx = await page.$$eval('[data-testid=context-menu] [role=menuitem]', (els) => els.map((e) => e.textContent.trim()));
    assert(JSON.stringify(ctx) === JSON.stringify(dots), `context ${JSON.stringify(ctx)} vs ⋯ ${JSON.stringify(dots)}`);
    assert(ctx.includes('Archive'), `a video with notes is archived: ${ctx}`);
    await shot('02-context-menu');
  });

  await check('archive from the context menu; Undo in the toast restores it', async () => {
    await clickText('[data-testid=context-menu] [role=menuitem]', 'Archive');
    await page.waitForSelector('[data-testid=toast] .toast-act');
    await until(async () => (await video(spot.slug))?.archived, 'archived on the server');
    // the dismiss × is a round button of our own: no browser padding pushing its icon off centre
    const x = await page.$eval('[data-testid=toast] .toast-x', (b) => getComputedStyle(b).padding);
    assert(x === '0px', `the toast's × keeps the browser's button padding: ${x}`);
    await shot('03-undo-toast');
    await page.click('[data-testid=toast] .toast-act');
    await until(async () => !(await video(spot.slug))?.archived, 'restored by Undo');
    await until(async () => (await page.$$eval('.film:not(.archived)', (els) => els.length)) === 2, 'both cards back');
  });

  await check('removing a video without notes asks first (alert dialog)', async () => {
    const card = await page.evaluateHandle((name) => [...document.querySelectorAll('.film')].find((e) => e.textContent.includes(name)), 'teaser.mp4');
    const box = await card.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + 80, { button: 'right' });
    await page.waitForSelector('[data-testid=context-menu] [role=menuitem]');
    await clickText('[data-testid=context-menu] [role=menuitem]', 'Remove from library');
    await page.waitForSelector('[role=alertdialog][data-testid=confirm]');
    const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
    assert(focused === 'Cancel', `focus starts on Cancel, not on the destructive button: ${focused}`);
    await page.keyboard.press('Escape');
    // at once, while the dialog and its backdrop fade out: what fades out is not in the way (the click used to be
    // swallowed by the backdrop still on its way out, and the menu never opened)
    await page.click('button[aria-label="Actions for teaser.mp4"]');
    await page.waitForSelector('.menu[data-state=open] [role=menuitem]', { timeout: 3000 });
    await page.keyboard.press('Escape');
    await until(async () => !(await page.$('[data-testid=confirm]')) && !(await page.$('.menu')), 'dialog and menu closed');
    assert(await video(teaser.slug), 'Escape keeps the video');
  });

  await check('a dialog’s primary answers to ⌘↵ from anywhere in it (Move to…, from its search field)', async () => {
    await page.click('button[aria-label="Actions for teaser.mp4"]');
    await page.waitForSelector('.menu[data-state=open] [role=menuitem]');
    await clickText('.menu[data-state=open] [role=menuitem]', 'Move to');
    await page.waitForSelector('.modal .fp-row');
    await clickText('.modal .fp-row', 'Scratch');
    await page.focus('.modal input');
    await page.keyboard.down('Meta');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Meta');
    await until(async () => (await video(teaser.slug)).folder === 'Scratch', 'moved by ⌘↵');
    await until(async () => !(await page.$('.modal')), 'the dialog closed');
  });

  await check('deleting a folder asks first, naming it and saying what moves where; ⌘↵ deletes it', async () => {
    const row = await page.evaluateHandle(() => [...document.querySelectorAll('.nav-item')].find((e) => e.textContent.includes('Scratch')));
    await row.hover();
    await sleep(300);
    await (await row.$('button[aria-label="Project actions"]')).click();
    await page.waitForSelector('.menu[data-state=open] [role=menuitem]');
    await clickText('.menu[data-state=open] [role=menuitem]', 'Delete project');
    await page.waitForSelector('[role=alertdialog][data-testid=confirm]');
    const said = await page.$eval('[data-testid=confirm]', (e) => [e.querySelector('h3').textContent, e.querySelector('.alert-text').textContent]);
    assert(said[0] === 'Delete the project “Scratch”?', `the question names the project: ${said[0]}`);
    assert(said[1] === 'Only the project goes: 1 video moves to No project.', `one sentence on what happens: ${said[1]}`);
    const buttons = await page.$$eval('[data-testid=confirm] button', (bs) => bs.map((b) => b.textContent.trim()));
    assert(buttons.join('|') === 'Cancel|Delete project', `the answers are their words, the keys are drawn beside them: ${buttons.join('|')}`);
    await shot('04-alert-dialog');
    await page.keyboard.down('Meta');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Meta');
    await until(async () => !(await library()).folders.includes('Scratch'), 'folder deleted');
    assert((await video(teaser.slug)).folder == null, 'its video moved up to the top level');
    // their toasts ("Moved …", "Deleted …") go, so the next check's Undo is the only one on screen. "Deleted …" can
    // arrive after the server already says the folder is gone (the app shows it once its request returns), so close
    // what is there until nothing is left.
    await until(async () => {
      await page.$$eval('[data-testid=toast] .toast-x', (bs) => {
        for (const b of bs) b.click();
      });
      return !(await page.$('[data-testid=toast]'));
    }, 'no toasts left');
  });

  await check('player: every icon-only button is named and has a tooltip, with its shortcut', async () => {
    await page.goto(`${BASE}/#/v/${enc(spot.slug)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.side-scroll .note:not(.pending)');
    const bad = await unnamed();
    assert(!bad.length, `without name or tooltip:\n${bad.join('\n')}`);
    const tip = await hoverTip('.transport .playbtn');
    assert(/Play/.test(tip) && /Space/.test(tip), `play's tooltip names the key: ${tip}`);
  });

  await check('a deleted note leaves at once; Undo brings it back; the server deletes it only when the toast is gone', async () => {
    // a note's actions are in its card (⋯) once it is open, and on its row's context menu
    const menuOf = async (id) => {
      await page.waitForFunction((id) => [...document.querySelectorAll('.side-scroll .note .c-id')].some((e) => e.textContent === id), {}, id);
      await page.evaluate((id) => {
        const n = [...document.querySelectorAll('.side-scroll .note')].find((e) => e.querySelector('.c-id')?.textContent === id);
        if (!n.classList.contains('active')) n.querySelector('.nr')?.click();
      }, id);
      await page.click(`button[aria-label="Actions for ${id}"]`);
      await page.waitForSelector('.menu[data-state=open] [role=menuitem]');
    };
    const shown = () => page.$$eval('.side-scroll .note .c-id', (els) => els.map((e) => e.textContent));
    await menuOf(note.id);
    await clickText('.menu[data-state=open] [role=menuitem]', 'Delete');
    await until(async () => !(await shown()).includes(note.id), 'the card leaves');
    assert(
      (await comments(spot.slug)).some((c) => c.id === note.id),
      'not deleted on the server while Undo is offered',
    );
    await page.click('[data-testid=toast] .toast-act');
    await until(async () => (await shown()).includes(note.id), 'Undo puts it back');
    await menuOf(note.id);
    await clickText('.menu[data-state=open] [role=menuitem]', 'Delete');
    await page.waitForSelector('[data-testid=toast] .toast-x');
    // (a click, not a pointer: the toast is still springing into place, and a resting pointer pauses its timer)
    await page.$eval('[data-testid=toast] .toast-x', (b) => b.click());
    await until(async () => !(await comments(spot.slug)).some((c) => c.id === note.id), 'deleted on the server once the toast is gone');
    assert(!(await shown()).includes(note.id), 'and stays off the screen');
  });

  await check('screens change with a View Transition', async () => {
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.film:not(.pending)');
    // From the player that is a transition back: wait until it has let go of the page before clicking.
    await until(() => page.evaluate(() => !document.documentElement.dataset.nav), 'no transition running', 3000);
    const supported = await page.evaluate(() => {
      if (typeof document.startViewTransition !== 'function') return false;
      const real = document.startViewTransition.bind(document);
      window.__vt = 0;
      document.startViewTransition = (cb) => {
        window.__vt++;
        return real(cb);
      };
      return true;
    });
    if (!supported) return console.log('    (no View Transitions in this browser: skipped)');
    await page.click('.film');
    await page.waitForSelector('.player');
    assert((await page.evaluate(() => window.__vt)) === 1, 'library → player went through startViewTransition');
    await until(() => page.evaluate(() => !document.documentElement.dataset.nav), 'the transition ends and lets go of the page', 3000);
  });

  await check('reduced motion: no transitions or animations, and screens switch at once', async () => {
    const p2 = await browser.newPage();
    await p2.setViewport({ width: 1440, height: 900 });
    await p2.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await p2.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await p2.waitForSelector('.film:not(.pending)');
    const d = await p2.evaluate(() => {
      window.__vt = 0;
      const real = document.startViewTransition?.bind(document);
      if (real)
        document.startViewTransition = (cb) => {
          window.__vt++;
          return real(cb);
        };
      const btn = getComputedStyle(document.querySelector('.btn'));
      const film = getComputedStyle(document.querySelector('.film'));
      return { transition: btn.transitionDuration, animation: film.animationDuration };
    });
    assert(
      d.transition.split(',').every((x) => Number.parseFloat(x) <= 0.001),
      `button transitions: ${d.transition}`,
    );
    assert(Number.parseFloat(d.animation) <= 0.001, `card animation: ${d.animation}`);
    await p2.click('.film');
    await p2.waitForSelector('.player');
    assert((await p2.evaluate(() => window.__vt)) === 0, 'no view transition with reduced motion');
    await p2.close();
  });

  await check('skeletons while the library loads, then the cards; a first visit draws the top bar alone', async () => {
    // This browser keeps nothing of the library yet (web/src/api/persist.ts): it loads with its loading state. (A later
    // visit paints the kept library at once.) One that saw the library before (lib/chromeHint.ts) knows its sidebar and
    // cards are coming; one that never saw it (a new account, a new device) can't know whether the library is empty —
    // an empty one has no sidebar — so it draws the top bar alone until the answer says.
    for (const seen of [true, false]) {
      const fresh = await browser.createBrowserContext();
      const p3 = await fresh.newPage();
      await p3.setViewport({ width: 1440, height: 900 });
      if (seen) await p3.evaluateOnNewDocument(() => localStorage.setItem('vr.chrome', JSON.stringify({ role: 'owner', library: 'full' })));
      await p3.setRequestInterception(true);
      let release;
      const held = new Promise((r) => (release = r));
      p3.on('request', (r) => (r.url().endsWith('/api/library') ? held.then(() => r.continue()) : r.continue()));
      await p3.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
      await p3.waitForSelector('[data-testid=skeleton][aria-busy=true]', { timeout: 10000 });
      assert(!(await p3.$('.spinner')), 'no lone spinner while the library loads');
      if (SHOTS) await p3.screenshot({ path: path.join(SHOTS, `ui-05-skeleton${seen ? '' : '-first'}.png`) });
      // The loading cards are the same cards (`.film.pending`): wait for the real ones.
      if (seen) assert((await p3.$('.film.pending')) && (await p3.$('.nav .nav-item')), 'the loading state shows the sidebar and the cards in their places');
      else assert(!(await p3.$('.film.pending')) && !(await p3.$('.nav .nav-item')), 'a first visit guesses neither a sidebar nor cards');
      assert(await p3.$('.topbar .brand'), 'the top bar stands from the first paint');
      release();
      await p3.waitForSelector('.film:not(.pending)');
      assert(!(await p3.$('[data-testid=skeleton]')), 'the skeleton is gone');
      await fresh.close();
    }
  });

  await check('icons sit in the middle of their icon-only buttons (sidebar row actions included)', async () => {
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.film:not(.pending)');
    // the row actions show on hover: hover each row that has them
    for (const row of await page.$$('.nav-item:has(.nav-actions)')) {
      await row.hover();
      await sleep(120);
    }
    const off = await page.evaluate(() =>
      [...document.querySelectorAll('button.icon-only, .nav-act, .btn.icon-only')]
        .map((b) => {
          const r = b.getBoundingClientRect();
          const svg = b.querySelector(':scope > svg');
          if (!svg || !r.width || getComputedStyle(b).visibility === 'hidden') return null;
          const s = svg.getBoundingClientRect();
          const dx = s.left + s.width / 2 - (r.left + r.width / 2);
          const dy = s.top + s.height / 2 - (r.top + r.height / 2);
          return Math.abs(dx) > 1 || Math.abs(dy) > 1 ? `${b.getAttribute('aria-label') || b.className}: ${dx.toFixed(1)}, ${dy.toFixed(1)} px` : null;
        })
        .filter(Boolean),
    );
    assert(!off.length, `icons off centre: ${off.join(' · ')}`);
  });

  // Chrome counts a native select focused by a click as :focus-visible: the keyboard's ring must stay the keyboard's.
  await check('a native select clicked with the mouse draws no ring; reached by Tab it does', async () => {
    await page.evaluate(() => {
      const sel = document.createElement('select');
      sel.id = 'e2e-select';
      sel.innerHTML = '<option>One</option><option>Two</option>';
      sel.style.cssText = 'position:fixed;left:24px;bottom:24px;z-index:999';
      const after = document.createElement('button');
      after.id = 'e2e-after';
      after.textContent = 'After';
      after.style.cssText = 'position:fixed;left:140px;bottom:24px;z-index:999';
      document.body.append(sel, after);
    });
    const ring = () => page.$eval('#e2e-select', (s) => (s === document.activeElement ? getComputedStyle(s).outlineStyle : 'not focused'));
    // The last check's way back to the library may still be a View Transition: while one runs, a click lands on its
    // snapshot (the <html>), not on what is under the pointer.
    await page.waitForFunction(
      () => !document.activeViewTransition && !document.getAnimations().some((a) => a.effect?.pseudoElement?.startsWith('::view-transition')),
      {
        timeout: 10_000,
      },
    );
    await page.click('#e2e-select');
    const mouse = await ring();
    await page.focus('#e2e-after');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Tab');
    await page.keyboard.up('Shift');
    const keys = await ring();
    await page.evaluate(() => {
      document.getElementById('e2e-select')?.remove();
      document.getElementById('e2e-after')?.remove();
    });
    assert(mouse === 'none' && keys === 'solid', `outline after a click: ${mouse}, after Shift+Tab: ${keys}`);
  });

  await check('the server out of reach: a centred page that says so, and it comes back by itself', async () => {
    const down = await browser.newPage();
    await down.setViewport({ width: 1440, height: 900 });
    let failing = true;
    await down.setRequestInterception(true);
    down.on('request', (req) => {
      if (failing && new URL(req.url()).pathname === '/api/auth/status') req.abort('connectionrefused').catch(() => {});
      else req.continue().catch(() => {});
    });
    await down.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await down.waitForSelector('main.app-down h1', { timeout: 20000 });
    const m = await down.$eval('main.app-down .empty-state', (e) => {
      const r = e.getBoundingClientRect();
      return { left: r.left, right: innerWidth - r.right, top: r.top, bottom: innerHeight - r.bottom, w: r.width, h1: document.querySelectorAll('h1').length };
    });
    assert(
      Math.abs(m.left - m.right) <= 1 && Math.abs(m.top - m.bottom) <= 1 && m.w <= 560 && m.h1 === 1,
      `centred, as wide as its words, one h1: ${JSON.stringify(m)}`,
    );
    failing = false;
    await down.waitForSelector('.film:not(.pending)', { timeout: 15000 });
    await down.close();
  });

  await check('no page errors along the way', async () => {
    assert(!errors.length, errors.join(' | '));
  });
} catch (e) {
  crashed(e, srv);
} finally {
  await finish(LABEL, { browser, servers: [srv] });
}
