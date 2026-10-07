#!/usr/bin/env node
// covers: web/src/onboarding/Row.tsx web/src/onboarding/Panel.tsx web/src/onboarding/state.ts web/src/onboarding/data.ts web/src/onboarding/GetStarted.tsx web/src/styles/startpanel.css web/src/styles/onboarding.css web/src/library/Sidebar.tsx web/src/auth/UserMenu.tsx web/src/lib/chromeHint.ts server/routes/onboarding.ts lib/onboarding.ts
// Get started at the sidebar's foot (onboarding/Row.tsx, Panel.tsx), for a hosted server's owner (five steps) and on
// someone's own machine (four): the row says "2 of 5" with a 2 px line of the steps inside its own edge, on every
// library page, never in the orange; a click opens the steps above it — one height from step to step, Esc and a click
// outside close it, the focus back on the row; a review link made in the panel ticks the row at once; the card's × leaves
// the row, "Hide for good" takes both (Undo brings them back and sends nothing, the account hears it once the toast is
// gone), the account menu reads the same count and opens the panel at a desk, or brings the card back from Settings;
// everything done says "You're set" and the row folds away with the card; on a phone the drawer's row opens a sheet
// with thumb-sized rows, and an empty library's account menu carries the count.
import fs from 'node:fs';
import path from 'node:path';
import { makeVideo, tmpdir, until } from '../lib/helpers.ts';
import { settle } from './layout.mjs';
import { launch, requireChrome, signedIn } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'getstarted-sidebar e2e';
requireChrome(LABEL);
const PW = 'a long enough password';

// The machine's home, made up: one export to link (the machine's video step).
const home = fs.realpathSync(tmpdir('vr-gss-home-'));
makeVideo(path.join(home, 'Movies/Exports/spot.mp4'), { w: 320, h: 180, dur: 1 });

const servers = [];
let browser;
let page = null;
screenshotFailures(() => page, 'getstarted-sidebar');
try {
  const [srv, machine] = await Promise.all([
    startServer({ prefix: 'vr-gss-e2e-', mode: 'server', publicUrl: true, onboarding: true }),
    startServer({ prefix: 'vr-gss-local-e2e-', user: 'Kai Ito', onboarding: true, config: { browse_root: home }, env: { HOME: home } }),
  ]);
  servers.push(srv, machine);
  const BASE = srv.base;
  const call = async (base, p, method = 'GET', body, cookie) => {
    const r = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    assert(r.ok, `${method} ${p}: ${r.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
  // the hosted server's owner, made with its setup token; the setup's screens are skipped by the API
  const made = await fetch(`${BASE}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ token: await srv.setupToken(), name: 'Mia Lang', email: 'mia@e2e.test', password: PW }),
  });
  assert(made.ok, `setup: ${made.status}`);
  const cookie = (made.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('vr_session='))?.split(';')[0];
  const mia = (p, method, body) => call(BASE, p, method, body, cookie);
  await mia('/api/onboarding', 'PUT', { setup: 'done' });
  // 2 of 5: the sample's fix checked, a teammate invited
  const sample = await until(async () => {
    const s = (await mia('/api/onboarding')).sample;
    return s?.check ? s : null;
  }, 'the sample, its fix waiting for a check');
  await mia(`/api/comments/${sample.check}`, 'PATCH', { status: 'verified' });
  await mia('/api/admin/invites', 'POST', { role: 'member', email: 'jonas@e2e.test' });
  const steps0 = (await mia('/api/onboarding')).steps;
  assert(steps0.filter((s) => s.done).length === 2 && steps0.length === 5, `2 of 5: ${JSON.stringify(steps0)}`);

  browser = await launch();
  const errors = [];
  const fresh = async ({ width = 1440, height = 900, mobile = false, base = BASE, lang = null } = {}) => {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width, height, ...(mobile ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
    if (base === BASE) await p.setCookie({ name: 'vr_session', value: cookie.split('=').slice(1).join('='), url: BASE });
    if (lang) await p.evaluateOnNewDocument((l) => localStorage.setItem('vr.lang', l), lang);
    p.on('pageerror', (e) => errors.push(e.message));
    page = p;
    return p;
  };
  const open = async (p, hash = '#/', base = BASE) => {
    await p.goto(`${base}/${hash}`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('[data-testid=ob-row]', { timeout: 15000 });
    await signedIn(p);
    await settle(p, { quiet: 300 });
  };
  const still = (p) =>
    p.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime))
          .map((a) => a.finished.catch(() => {})),
      ),
    );
  const countOf = (p) => p.$eval('[data-testid=ob-row-count]', (e) => e.textContent.trim());
  const openPanel = async (p) => {
    await p.click('[data-testid=ob-row]');
    await p.waitForSelector('[data-testid=ob-sp]', { timeout: 10000 });
    await settle(p, { quiet: 200 });
    await still(p);
  };
  const clickText = (p, sel, words) =>
    p.evaluate((s, w) => [...document.querySelectorAll(s)].find((e) => e.textContent.includes(w))?.click() ?? null, sel, words);
  const menuItems = async (p) => {
    await p.click('.user-chip');
    await p.waitForSelector('.menu[data-state=open] [role=menuitem]');
    return p.$$eval('.menu[data-state=open] [role=menuitem]', (els) => els.map((e) => e.textContent.trim()));
  };

  // ---------------------------------------------------------------- the row
  const p = await fresh();
  await check('the row at the sidebar’s foot: “Get started 2 of 5”, a 2 px line of five frames, two lit, inside its edge, no orange', async () => {
    await open(p);
    assert((await countOf(p)) === '2 of 5', await countOf(p));
    const row = await p.$eval('[data-testid=ob-row]', (b) => {
      const r = b.getBoundingClientRect();
      const line = b.querySelector('.ob-side-line').getBoundingClientRect();
      const cells = [...b.querySelectorAll('.ob-side-line i')];
      const probe = document.createElement('span');
      probe.style.color = 'var(--brand)';
      document.body.append(probe);
      const brand = getComputedStyle(probe).color;
      probe.remove();
      const colours = [b, ...b.querySelectorAll('*')].flatMap((e) => {
        const s = getComputedStyle(e);
        return [s.color, s.backgroundColor, s.backgroundImage];
      });
      return {
        label: b.querySelector('.ob-side-label').textContent,
        cells: cells.length,
        lit: cells.filter((c) => c.classList.contains('ob-on')).length,
        lineH: Math.round(line.height),
        inside: line.left >= r.left && line.right <= r.right && line.top >= r.top && line.bottom <= r.bottom,
        orange: colours.some((c) => c.includes(brand)),
        aboveSettings: r.bottom <= document.querySelector('.nav .nav-settings').getBoundingClientRect().top,
        inFoot: !b.closest('.nav-sa'),
      };
    });
    assert(row.label === 'Get started', row.label);
    assert(row.cells === 5 && row.lit === 2, `the line: ${row.lit} of ${row.cells} lit`);
    assert(row.lineH === 2, `the line is ${row.lineH} px tall`);
    assert(row.inside, 'the line sits inside the row’s own box');
    assert(!row.orange, 'the row never wears the orange');
    assert(row.aboveSettings && row.inFoot, 'at the foot, above Settings, out of the scrolling list');
  });

  await check('the row shows on every library page with a sidebar (the inbox, Insights, a folder)', async () => {
    for (const hash of ['#/inbox', '#/insights', '#/session/nobody']) {
      await p.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
      await p.waitForSelector('[data-testid=ob-row]', { timeout: 15000 });
      assert((await countOf(p)) === '2 of 5', `${hash}: ${await countOf(p)}`);
    }
    await open(p);
  });

  // ---------------------------------------------------------------- the panel
  await check('a click opens the steps above the row (focus inside); one height from step to step; Esc closes it, focus back on the row', async () => {
    await openPanel(p);
    const box = await p.evaluate(() => {
      const pop = document.querySelector('.ob-sp-pop').getBoundingClientRect();
      const row = document.querySelector('[data-testid=ob-row]').getBoundingClientRect();
      return { above: pop.bottom <= row.top + 1, left: Math.round(pop.left - row.left), name: document.querySelector('.ob-sp-pop').getAttribute('aria-label') };
    });
    assert(box.above, 'the panel opens upward, above the row');
    assert(Math.abs(box.left) <= 1, `anchored at the row’s start (${box.left} px off)`);
    assert(box.name === 'Get started', `the dialog's name: ${box.name}`);
    assert(await p.evaluate(() => document.activeElement?.dataset.testid === 'ob-sp'), 'the panel takes the focus');
    assert((await p.$eval('[data-testid=ob-sp-count]', (e) => e.textContent)) === '2 of 5', 'its head counts the same');
    const next = steps0.find((s) => !s.done).id;
    assert((await p.$eval('[data-testid=ob-sp-pane]', (e) => e.dataset.pane)) === next, `the next step open (${next})`);
    const ids = await p.$$eval('[data-testid=ob-sp-step]', (els) => els.map((e) => e.dataset.step));
    const heights = new Set();
    for (const id of ids) {
      await p.click(`[data-testid=ob-sp-step][data-step=${id}]`);
      await p.waitForFunction((id) => document.querySelector('[data-testid=ob-sp-pane]')?.dataset.pane === id, { timeout: 5000 }, id);
      await still(p);
      heights.add(await p.$eval('.ob-sp-pop', (e) => Math.round(e.getBoundingClientRect().height)));
    }
    assert(heights.size === 1, `the panel's height changes with the step: ${[...heights]}`);
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => !document.querySelector('[data-testid=ob-sp]'), { timeout: 5000 });
    // (Radix hands the focus back a task after the panel unmounts)
    await p
      .waitForFunction(() => document.activeElement?.dataset.testid === 'ob-row', { timeout: 3000 })
      .catch(async () => assert(false, `the focus is back on the row, not on ${await p.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))}`));
    // a click outside closes it too
    await openPanel(p);
    await p.click('.hero h1');
    await p.waitForFunction(() => !document.querySelector('[data-testid=ob-sp]'), { timeout: 5000 });
  });

  await check('a review link made in the panel ticks the row at once: 3 of 5, the link stays in view', async () => {
    await openPanel(p);
    await p.click('[data-testid=ob-sp-step][data-step=share]');
    await p.waitForSelector('.ob-sp-pane [data-slot=share] [data-testid=ob-make-link]');
    await p.click('.ob-sp-pane [data-slot=share] [data-testid=ob-make-link]');
    await p.waitForSelector('.ob-sp-pane [data-testid=ob-share-link]', { timeout: 10000 });
    await p.waitForFunction(() => document.querySelector('[data-testid=ob-row-count]')?.textContent.trim() === '3 of 5', { timeout: 5000 });
    assert((await p.$$('.ob-side-line i.ob-on')).length === 3, 'three frames lit');
    assert((await p.$eval('[data-testid=ob-sp-count]', (e) => e.textContent)) === '3 of 5', 'the panel counts it too');
    // once its tick has popped, the step is still the one open: the link it made stays in view
    await p.waitForFunction(() => !document.querySelector('.ob-sp-row.ob-ticked'), { timeout: 5000 });
    assert(await p.$('[data-testid=ob-sp-step][data-step=share][data-done][aria-current=step]'), 'the step is done in the list and stays open');
    assert((await p.$eval('[data-testid=ob-sp-pane]', (e) => e.dataset.pane)) === 'share', 'the pane still shows the link it made');
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => !document.querySelector('[data-testid=ob-sp]'), { timeout: 5000 });
  });

  // ---------------------------------------------------------------- putting it away
  await check('the card’s × puts away only the card: the row stays, and the toast says where', async () => {
    await p.waitForSelector('[data-testid=ob-gs] [data-testid=ob-hide]');
    await p.click('[data-testid=ob-hide]');
    await p.waitForFunction(() => !document.querySelector('[data-testid=ob-gs]'), { timeout: 5000 });
    await p.waitForFunction(() => document.querySelector('[data-testid=toast]')?.textContent.includes('foot of the sidebar'), { timeout: 5000 });
    assert((await countOf(p)) === '3 of 5', 'the row stays');
    await until(async () => (await mia('/api/onboarding')).onboarding.hidden, 'the card put away on the account');
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForSelector('[data-testid=ob-row]', { timeout: 15000 });
    await settle(p, { quiet: 300 });
    assert(!(await p.$('[data-testid=ob-gs]')), 'no card after a reload');
  });

  await check('the account menu reads “Get started 3 of 5” and opens the steps at the sidebar’s foot, where you are', async () => {
    await p.goto(`${BASE}/#/inbox`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('[data-testid=ob-row]');
    await signedIn(p);
    const items = await menuItems(p);
    assert(
      items.some((i) => i.startsWith('Get started') && i.includes('3 of 5')),
      `account menu: ${items}`,
    );
    await clickText(p, '.menu[data-state=open] [role=menuitem]', 'Get started');
    await p.waitForSelector('[data-testid=ob-sp]', { timeout: 5000 });
    assert((await p.evaluate(() => location.hash)) === '#/inbox', 'you stay where you are');
    assert(!(await p.$('[data-testid=ob-gs]')), 'the card stays put away');
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => !document.querySelector('[data-testid=ob-sp]'), { timeout: 5000 });
  });

  await check('Settings has no sidebar: the account menu brings the card back above All videos', async () => {
    await p.goto(`${BASE}/#/settings`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('.set-nav a');
    await signedIn(p);
    await menuItems(p);
    await clickText(p, '.menu[data-state=open] [role=menuitem]', 'Get started');
    await p.waitForSelector('[data-testid=ob-gs] [data-testid=ob-step]', { timeout: 15000 });
    assert((await p.evaluate(() => location.hash)) === '#/', 'back in the library');
    await until(async () => !(await mia('/api/onboarding')).onboarding.hidden, 'the card back on the account');
  });

  await check('“Hide for good” takes the card and the row at once; Undo brings both back and sends nothing', async () => {
    await p.waitForSelector('[data-testid=ob-row]');
    await settle(p, { quiet: 300 });
    await openPanel(p);
    await p.click('[data-testid=ob-sp-hide]');
    await p.waitForFunction(() => !document.querySelector('[data-testid=ob-row]') && !document.querySelector('[data-testid=ob-gs]'), { timeout: 5000 });
    await p.waitForFunction(() => document.querySelector('[data-testid=toast]')?.textContent.includes('account menu still has it'), { timeout: 5000 });
    assert(!(await mia('/api/onboarding')).onboarding.dismissed, 'nothing sent while Undo is offered');
    await clickText(p, '[data-testid=toast] button', 'Undo');
    await p.waitForSelector('[data-testid=ob-row]', { timeout: 5000 });
    await p.waitForSelector('[data-testid=ob-gs]', { timeout: 5000 });
    assert(!(await mia('/api/onboarding')).onboarding.dismissed, 'still nothing on the account');
  });

  await check('hidden for good once the toast is gone: both stay away after a reload, the menu still has it and brings both back', async () => {
    await openPanel(p);
    await p.click('[data-testid=ob-sp-hide]');
    await p.waitForFunction(() => !document.querySelector('[data-testid=ob-row]'), { timeout: 5000 });
    await until(async () => (await mia('/api/onboarding')).onboarding.dismissed, 'hidden for good on the account');
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForSelector('.lib-content .film', { timeout: 15000 });
    await signedIn(p);
    await settle(p, { quiet: 500 });
    assert(!(await p.$('[data-testid=ob-row]')) && !(await p.$('[data-testid=ob-gs]')), 'neither after a reload');
    const items = await menuItems(p);
    assert(
      items.some((i) => i.startsWith('Get started') && i.includes('3 of 5')),
      `the account menu still has it: ${items}`,
    );
    await clickText(p, '.menu[data-state=open] [role=menuitem]', 'Get started');
    await p.waitForSelector('[data-testid=ob-sp]', { timeout: 10000 });
    await until(async () => !(await mia('/api/onboarding')).onboarding.dismissed, 'brought back on the account');
    assert(await p.$('[data-testid=ob-row]'), 'the row is back');
    await p.keyboard.press('Escape');
  });

  await check('German: “Erste Schritte 3 von 5”, the panel and its foot in German', async () => {
    const de = await fresh({ lang: 'de' });
    await open(de);
    assert((await de.$eval('.ob-side-label', (e) => e.textContent)) === 'Erste Schritte', 'the label');
    assert((await countOf(de)) === '3 von 5', await countOf(de));
    await openPanel(de);
    assert((await de.$eval('[data-testid=ob-sp-hide]', (e) => e.textContent)) === 'Endgültig ausblenden', 'Hide for good');
    await de.browserContext().close();
  });

  // ---------------------------------------------------------------- phones and tablets
  await check('a tablet and a phone: the drawer’s row opens a sheet (above the drawer), its rows a thumb tall', async () => {
    for (const [width, height] of [
      [768, 1024],
      [390, 844],
    ]) {
      const m = await fresh({ width, height, mobile: true });
      await m.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
      await m.waitForSelector('.nav-toggle:not(.idle)', { timeout: 15000 });
      await settle(m, { quiet: 300 });
      await m.click('.nav-toggle');
      await m.waitForSelector('.drawer [data-testid=ob-row]', { timeout: 10000 });
      await settle(m, { quiet: 300 });
      const rowH = await m.$eval('.drawer [data-testid=ob-row]', (e) => e.getBoundingClientRect().height);
      assert(rowH >= 44, `@${width}: the drawer's row is ${rowH} px tall`);
      await m.click('.drawer [data-testid=ob-row]');
      await m.waitForSelector('.modal [data-testid=ob-sp]', { timeout: 10000 });
      await settle(m, { quiet: 300 });
      const sheet = await m.evaluate(() => {
        const modal = document.querySelector('.modal');
        const z = (e) => Number(getComputedStyle(e.closest('.backdrop') ?? e).zIndex) || 0;
        return {
          head: modal.querySelector('.modal-head').textContent,
          above: z(modal) > z(document.querySelector('.drawer')),
          inside: (() => {
            const a = modal.getBoundingClientRect();
            const b = modal.querySelector('[data-testid=ob-sp]').getBoundingClientRect();
            return b.left >= a.left - 1 && b.right <= a.right + 1 && b.top >= a.top - 1;
          })(),
          small: [...modal.querySelectorAll('.ob-sp-row')].map((e) => e.getBoundingClientRect().height).filter((h) => h < 44).length,
        };
      });
      assert(sheet.head.includes('Get started') && sheet.head.includes('3 of 5'), `@${width}: ${sheet.head}`);
      assert(sheet.above, `@${width}: the sheet is above the drawer`);
      assert(sheet.inside, `@${width}: the panel stays inside its sheet`);
      assert(!sheet.small, `@${width}: ${sheet.small} rows under 44 px`);
      await m.browserContext().close();
    }
  });

  await check('a phone with an empty library (no sidebar): the card stays, the account menu carries the count', async () => {
    await mia('/api/onboarding/sample', 'DELETE');
    const m = await fresh({ width: 390, height: 844, mobile: true });
    await m.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await m.waitForSelector('.empty-library', { timeout: 15000 });
    await signedIn(m);
    await m.waitForSelector('[data-testid=ob-gs]', { timeout: 15000 });
    assert(!(await m.$('[data-testid=ob-row]')), 'no sidebar, no row');
    const items = await menuItems(m);
    assert(
      items.some((i) => i.startsWith('Get started') && / of 5/.test(i)),
      `the phone's account menu: ${items}`,
    );
    await m.browserContext().close();
  });

  // ---------------------------------------------------------------- the machine: everything done
  await check('the machine: the last step made in the panel says “You’re set” on the row and the panel, then the row folds away for good', async () => {
    const local = (pth, method, body) => call(machine.base, pth, method, body);
    await local('/api/onboarding', 'PUT', { setup: 'done' });
    const s = await until(async () => {
      const x = (await local('/api/onboarding')).sample;
      return x?.check ? x : null;
    }, 'the machine’s sample');
    await local(`/api/comments/${s.check}`, 'PATCH', { status: 'verified' });
    await local('/api/library', 'POST', { path: path.join(home, 'Movies/Exports/spot.mp4') });
    await local('/api/agents/heartbeat', 'POST', { session_id: 'gss-agent', name: 'spot-edit', kind: 'claude-code' });
    const k = await fresh({ base: machine.base });
    await open(k, '#/', machine.base);
    await k.waitForFunction(() => document.querySelector('[data-testid=ob-row-count]')?.textContent.trim() === '3 of 4', { timeout: 15000 });
    await openPanel(k);
    assert((await k.$eval('[data-testid=ob-sp-pane]', (e) => e.dataset.pane)) === 'share', 'the review link is left');
    await k.click('.ob-sp-pane [data-slot=share] [data-testid=ob-make-link]');
    await k.waitForFunction(
      () =>
        document.querySelector('[data-testid=ob-row-count]')?.textContent.trim() === '4 of 4' &&
        document.querySelector('.ob-side-label')?.textContent === 'You’re set',
      { timeout: 10000 },
    );
    assert((await k.$eval('.ob-sp-title', (e) => e.firstChild.textContent)) === 'You’re set', 'the panel says it too');
    assert(await k.$('[data-testid=ob-gs].ob-all'), 'and the card');
    await k.waitForFunction(() => !document.querySelector('[data-testid=ob-row]') && !document.querySelector('[data-testid=ob-gs]'), { timeout: 15000 });
    const o = (await local('/api/onboarding')).onboarding;
    assert(o.complete, JSON.stringify(o));
    await k.reload({ waitUntil: 'domcontentloaded' });
    await k.waitForSelector('.lib-content .film', { timeout: 15000 });
    await signedIn(k);
    await settle(k, { quiet: 500 });
    assert(!(await k.$('[data-testid=ob-row]')), 'gone for good after a reload');
    const items = await menuItems(k);
    assert(!items.some((i) => i.startsWith('Get started')), `nothing left in the account menu: ${items}`);
    await k.browserContext().close();
  });

  await check('no errors in the page', async () => {
    assert(!errors.length, errors.join('\n'));
  });
} catch (e) {
  crashed(e, ...servers);
}
await finish(LABEL, { browser, servers });
