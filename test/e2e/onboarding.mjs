#!/usr/bin/env node
// covers: web/src/onboarding/ web/src/styles/onboarding.css web/src/styles/loopdone.css server/routes/onboarding.ts lib/onboarding.ts
// covers: lib/sample.ts lib/sampleLoop.ts lib/sample-film/ lib/renderFolders.ts lib/agentsFound.ts web/src/library/Library.tsx
// Browser end-to-end test of the first run on someone's own machine (web/src/onboarding/, lib/onboarding.ts): real
// servers with the first run on (temp stores, a temp home, free ports) + headless Chrome. A fresh machine opens on
// Welcome, finds the folder its exports land in and links it, finds the agent installed and turns live when it calls,
// and ends at the sample — already in the library, frame-exact against ffmpeg in both versions, its agent named after
// the pick; checking its fix and answering its question closes the loop ("That's the loop"). Back in the library, Get
// started ticks what happened (never from a click on it), folds, goes away with Undo, comes back from the account menu,
// shares a review link and says "You're set". A store from before the first run never shows any of it; German; the
// sample goes in one click and comes back in German; every width from a phone to 1920.
import fs from 'node:fs';
import path from 'node:path';
import { makeVideo, ROOT, sleep, tmpdir, until } from '../lib/helpers.ts';
import { fitsAt, settle } from './layout.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { inventory, SCALE } from './lib/designInventory.mjs';
import { closestFrame, shownPicture } from './lib/frames.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'onboarding e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const FILM = path.join(ROOT, 'lib/sample-film');

// A store from before the first run: its owner exists already (no `onboarding` on the account).
const before = (env) => {
  fs.mkdirSync(env.VR_DATA, { recursive: true });
  const owner = {
    id: 'u_000000000001',
    email: 'kim@localhost',
    name: 'Kim',
    role: 'owner',
    password: '',
    created: '2026-09-01T10:00:00.000+02:00',
    epoch: 0,
    local: true,
  };
  fs.writeFileSync(path.join(env.VR_DATA, 'users.json'), JSON.stringify({ users: [owner], tokens: [] }));
};

// The machine's home, made up: two exports in ~/Movies/Exports (the setup looks there, and nowhere outside it).
const home = fs.realpathSync(tmpdir('vr-ob-home-'));
makeVideo(path.join(home, 'Movies/Exports/spot.mp4'), { w: 320, h: 180, dur: 1 });
makeVideo(path.join(home, 'Movies/Exports/teaser.mp4'), { w: 320, h: 180, dur: 1 });
const atHome = { config: { browse_root: home }, env: { HOME: home } };

const servers = [];
let browser;
let page = null;
screenshotFailures(() => page, 'onboarding');
try {
  const [srv, old, german] = await Promise.all([
    startServer({ prefix: 'vr-ob-e2e-', user: 'Sam Rivera', onboarding: true, ...atHome }),
    startServer({ prefix: 'vr-ob-old-e2e-', user: 'Kim', onboarding: true, seed: before }),
    startServer({ prefix: 'vr-ob-de-e2e-', user: 'Sam', onboarding: true, ...atHome }),
  ]);
  servers.push(srv, old, german);
  const BASE = srv.base;
  const api = async (p, method = 'GET', body, base = BASE) => {
    const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${t}`);
    return t ? JSON.parse(t) : null;
  };
  browser = await launch();
  const errors = [];
  const fresh = async ({ width = 1440, height = 900, mobile = false, lang = null } = {}) => {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width, height, ...(mobile ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
    if (lang) await p.evaluateOnNewDocument((l) => localStorage.setItem('vr.lang', l), lang);
    p.on('pageerror', (e) => errors.push(e.message));
    page = p;
    return p;
  };
  const shot = async (p, name) => SHOTS && p.screenshot({ path: path.join(SHOTS, `onboarding-${name}.png`) });
  const open = async (p, hash, ready, base = BASE) => {
    await p.goto(`${base}/${hash}`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector(ready, { timeout: 15000 });
  };
  const atStep = (p, s) => p.waitForFunction((s) => document.querySelector('[data-testid=ob-setup]')?.dataset.step === s, { timeout: 15000 }, s);
  const textOf = (p, sel = 'body') => p.$eval(sel, (e) => e.innerText);
  const titlesOf = (p) => p.$$eval('[data-testid=ob-gs] [data-testid=ob-step] > span:not(.ob-when)', (els) => els.map((e) => e.textContent).filter(Boolean));
  const steps = (p) => p.$$eval('[data-testid=ob-gs] [data-testid=ob-step]', (els) => els.map((e) => [e.dataset.step, e.hasAttribute('data-done')]));
  const fits = async (p, where) => {
    const bad = await fitsAt(p, where);
    assert(!bad.length, bad.join('\n'));
  };
  // quality.mjs's design-system scales, for the screens it doesn't open (the pictures scale with their room: drawn)
  const onScale = async (p, where) => {
    const found = await p.evaluate(inventory, { scale: SCALE, allow: ['.avatar', '.ob-pic', '.ob-smp-thumb', '.ob-mini-preview'] });
    const off = Object.entries(found).flatMap(([kind, list]) => list.map(({ value, who }) => `${where}: ${kind} ${value} (${who.join(', ')})`));
    assert(!off.length, `off the scales in base.css:\n        ${off.join('\n        ')}`);
  };
  const menuItems = async (p) => {
    await p.click('.user-chip');
    await p.waitForSelector('.menu[data-state=open] [role=menuitem]');
    return p.$$eval('.menu[data-state=open] [role=menuitem]', (els) => els.map((e) => e.textContent.trim()));
  };
  const closeMenu = async (p) => {
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => !document.querySelector('.menu[data-state=open]'), { timeout: 5000 });
  };
  /** Opens the note whose row says `words` into its card (notes rest as one-line rows). */
  const openNote = async (p, words) => {
    await p.waitForFunction((w) => [...document.querySelectorAll('.note-row .nr')].some((b) => b.textContent.includes(w)), { timeout: 15000 }, words);
    await p.evaluate((w) => [...document.querySelectorAll('.note-row .nr')].find((b) => b.textContent.includes(w))?.click(), words);
    await p.waitForFunction((w) => document.querySelector('.comment.note.active')?.textContent.includes(w), { timeout: 10000 }, words);
  };
  // The column's left edge, read off each step's heading at a width: it never moves sideways on Continue or Back.
  const movesAt = async (base, steps, cookie = null) => {
    const p = await fresh();
    if (cookie) await p.setCookie({ name: cookie.name, value: cookie.value, url: base });
    const out = [];
    for (const width of [1024, 1440, 1920]) {
      await p.setViewport({ width, height: 900 });
      const xs = {};
      for (const s of steps) {
        await p.goto(`${base}/#/welcome${s === 'welcome' ? '' : `/${s}`}`, { waitUntil: 'domcontentloaded' });
        await p.waitForFunction((s) => document.querySelector('[data-testid=ob-setup]')?.dataset.step === s, { timeout: 15000 }, s);
        await p.waitForSelector('[data-testid=ob-setup] h1');
        // the column slides in: measured once it stands (finite animations only; a live status pulses for ever)
        await p.evaluate(() =>
          Promise.all(
            document
              .getAnimations()
              .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime))
              .map((a) => a.finished.catch(() => {})),
          ),
        );
        xs[s] = await p.$eval('[data-testid=ob-setup] h1', (e) => Math.round(e.getBoundingClientRect().left));
      }
      const v = Object.values(xs);
      if (Math.max(...v) - Math.min(...v) > 1) out.push(`@${width}: ${JSON.stringify(xs)}`);
    }
    await p.browserContext().close();
    return out;
  };
  const clickText = (p, sel, words) =>
    p.evaluate((s, w) => [...document.querySelectorAll(s)].find((e) => e.textContent.includes(w))?.click() ?? null, sel, words);

  // ---------------------------------------------------------------- the setup, on the machine
  const a = await fresh();
  await check('a fresh machine opens on Welcome: the library sends it there; three short steps, nothing to sign in', async () => {
    await a.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await atStep(a, 'welcome');
    assert(a.url().endsWith('#/welcome'), `the library sent the new machine to its setup: ${a.url()}`);
    const t = await textOf(a);
    assert(t.includes('Welcome to Lampo') && t.includes('On this machine') && t.includes('Signed in as you'), t.slice(0, 400));
    assert((await a.$$('.ob-hello-steps li')).length === 3, 'three steps ahead');
    assert(t.includes('3 short steps, all skippable.'), 'all skippable');
    assert((await a.$$('h1')).length === 1, 'one h1');
    assert(!(await a.$('[data-testid=ob-gs]')), 'no Get started on the way');
    await shot(a, '01-welcome');
    await fits(a, 'Welcome (machine)');
  });

  await check('where the exports land: the folder in the home is offered with its count; Link 2 videos links them where they are', async () => {
    await a.click('[data-testid=ob-start]');
    await atStep(a, 'renders');
    await a.waitForSelector('[data-testid=ob-folders] input[value$="Movies/Exports"]', { timeout: 15000 });
    const rows = await a.$$eval('[data-testid=ob-folders] .ob-rowc', (els) => els.map((e) => e.textContent));
    assert(
      rows.some((r) => r.includes('~/Movies/Exports') && r.includes('2 videos')),
      `the folder, said from home: ${JSON.stringify(rows)}`,
    );
    assert(await a.$eval('[data-testid=ob-link]', (e) => e.disabled), 'nothing to link before a pick');
    await a.click('[data-testid=ob-folders] input[value$="Movies/Exports"]');
    const label = await a.$eval('[data-testid=ob-link]', (e) => e.textContent);
    assert(label.includes('Link 2 videos'), label);
    await a.waitForFunction(() => document.querySelector('[data-testid=ob-panel]')?.innerText.includes('spot.mp4'), { timeout: 5000 });
    await shot(a, '02-renders');
    await onScale(a, 'renders');
    await a.click('[data-testid=ob-link]');
    await atStep(a, 'agent');
    const lib = await api('/api/library');
    const linked = lib.videos.filter((v) => !v.sample).map((v) => v.video);
    assert(linked.length === 2 && linked.every((v) => v.startsWith(path.join(home, 'Movies/Exports'))), `linked where they are: ${linked}`);
  });

  await check('the agent: the one installed says Found; its connect block in place, live — a `vr watch` heartbeat turns it on', async () => {
    await a.waitForFunction(() => document.querySelector('[data-agent=claude-code]')?.textContent.includes('Found'), { timeout: 15000 });
    await a.click('[data-agent=claude-code] input');
    await a.waitForSelector('[data-testid=ob-connect][data-connect-id=claude-code] [data-testid=ob-live][data-state=waiting]', { timeout: 10000 });
    const snippet = await a.$eval('[data-testid=ob-snippet]', (e) => e.textContent);
    assert(snippet.includes(`claude mcp add --transport http lampo ${BASE}/mcp`), snippet);
    assert(!(await a.$('[data-testid=ob-token-toggle]')), 'no token at the machine');
    assert((await textOf(a, '[data-testid=ob-connect]')).includes('No sign-in'), 'nothing to sign in');
    // what `vr watch` says every 30 s (at the machine every agent is its owner's)
    await api('/api/agents/heartbeat', 'POST', { session_id: 'e2e-agent', name: 'spot-edit', kind: 'claude-code' });
    await a.waitForSelector('[data-testid=ob-live][data-state=connected]', { timeout: 15000 });
    const live = await a.$eval('[data-testid=ob-live]', (e) => e.textContent);
    assert(live.includes('Connected · Claude Code'), live);
    assert((await api('/api/onboarding')).onboarding.agent === 'claude-code', 'the pick kept on the account');
    await shot(a, '03-agent-connected');
    await onScale(a, 'agent');
  });

  let sample = null;
  await check('the last step opens the sample — in the library from the start — in check mode, its agent named after the pick', async () => {
    await a.click('[data-testid=ob-next]');
    await atStep(a, 'try');
    assert((await textOf(a)).includes('See the whole loop in a minute'), 'the sample step');
    await fits(a, 'the sample step (machine)');
    await onScale(a, 'try');
    sample = (await api('/api/onboarding')).sample;
    assert(sample?.check && sample.question, `the sample, its fix and its question: ${JSON.stringify(sample)}`);
    await a.click('[data-testid=ob-open-sample]');
    await a.waitForFunction(() => location.hash.startsWith('#/v/') && location.hash.includes('verify='), { timeout: 15000 });
    await until(async () => (await api('/api/onboarding')).onboarding.setup_done, 'the setup is over');
    await a.waitForSelector('[data-testid=check-decision]', { timeout: 15000 });
    const t = await textOf(a);
    assert(t.includes('The title covers the car') && t.includes('Claude Code · fixed in V2'), t.slice(0, 1200));
    assert(!t.includes('Sample agent'), 'the stored name never shows');
    await shot(a, '04-sample-check');
  });

  await check('the sample is frame-exact: V1 frame 35 (the title on the car) and V2 frame 96 (on the hill) against ffmpeg', async () => {
    for (const [v, n] of [
      [1, 35],
      [2, 96],
    ]) {
      const file = path.join(FILM, `v${v}.mp4`);
      await a.goto('about:blank');
      await a.goto(`${BASE}/#/v/${encodeURIComponent(sample.slug)}?v=${v}&f=${n}`, { waitUntil: 'domcontentloaded' });
      await a.waitForFunction(
        (n) => {
          const el = document.querySelector('.vbox video');
          return el && el.readyState >= 2 && !el.seeking && Number(document.querySelector('.tc .sub b')?.textContent) === n;
        },
        { polling: 100, timeout: 30000 },
        n,
      );
      // a busy machine can present the frame a moment after the seek ends: only a wrong picture is looked at again
      const right = (b) => b.k === n && b.e < 6;
      let best = closestFrame(file, await shownPicture(a), n, 121, 2);
      for (const t = Date.now(); !right(best) && Date.now() - t < 5000; best = closestFrame(file, await shownPicture(a), n, 121, 2)) await sleep(200);
      assert(right(best), `V${v} frame ${n}: the closest ffmpeg frame is ${best.k} (${best.line})`);
    }
  });

  await check('Looks right, then an answer to the agent’s question: “That’s the loop”, naming the agent picked', async () => {
    await a.goto(`${BASE}/#/v/${encodeURIComponent(sample.slug)}?verify=${encodeURIComponent(sample.check)}`, { waitUntil: 'domcontentloaded' });
    await a.waitForSelector('[data-testid=check-decision] button', { timeout: 15000 });
    await clickText(a, '[data-testid=check-decision] button', 'Looks right');
    await openNote(a, 'Should the title fade out');
    await a.waitForSelector('.comment.note.active [data-testid=choices] button', { timeout: 10000 });
    await clickText(a, '.comment.note.active [data-testid=choices] button', 'Hold it');
    await a.waitForSelector('[data-testid=ob-loop-done]', { timeout: 15000 });
    const card = await textOf(a, '[data-testid=ob-loop-done]');
    assert(card.includes('That’s the loop') && card.includes('Claude Code’s fix in V2'), card);
    const focused = await a.evaluate(() => document.activeElement?.className);
    assert(focused === 'ob-loop-card', `the card takes the focus, not one of its buttons: ${focused}`);
    // a phone: the loop's four steps on one line, no dash left dangling at a line's end
    await a.setViewport({ width: 390, height: 844 });
    await settle(a);
    const tops = await a.$$eval('.ob-loop-steps > *', (els) => [
      ...new Set(els.map((e) => Math.round(e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2))),
    ]);
    await a.setViewport({ width: 1440, height: 900 });
    await settle(a);
    assert(tops.length === 1, `the loop's steps on a phone wrap onto ${tops.length} lines`);
    await shot(a, '05-loop-done');
    await onScale(a, 'That’s the loop');
    await a.click('[data-testid=ob-loop-library]');
    await a.waitForSelector('[data-testid=ob-gs] [data-testid=ob-step]', { timeout: 15000 });
  });

  await check('a desk at 1024, 1440 and 1920: every step’s heading starts at the same left edge (the machine)', async () => {
    const moved = await movesAt(BASE, ['welcome', 'renders', 'agent', 'try']);
    assert(!moved.length, `the heading moves sideways between steps:\n        ${moved.join('\n        ')}`);
  });

  // ---------------------------------------------------------------- Get started
  await check('Get started ticks what happened (the sample, the videos linked, the agent): 3 of 4, the review link next', async () => {
    await a.waitForFunction(() => document.querySelector('[data-testid=ob-count]')?.textContent.trim() === '3 of 4', { timeout: 15000 });
    const s = await steps(a);
    assert(
      JSON.stringify(s) ===
        JSON.stringify([
          ['sample', true],
          ['video', true],
          ['agent', true],
          ['share', false],
        ]),
      `steps ${JSON.stringify(s)}`,
    );
    const titles = await titlesOf(a);
    assert(titles.includes('Link your first video') && titles.includes('Connect Claude Code'), `named after the machine and the pick: ${titles}`);
    assert((await a.$eval('[data-testid=ob-pane]', (e) => e.dataset.pane)) === 'share', 'the next step at work');
    assert((await textOf(a, '.ob-gs-later')).includes('vr export'), 'later: vr export');
    assert(!(await a.$('[data-testid=ob-plan]')), 'no plan on a machine');
    assert((await a.$eval('.film .vchip.sample-chip', (e) => e.textContent)) === 'Sample', 'the card says Sample');
    assert((await a.$$('h1')).length === 1, 'one h1');
    await shot(a, '06-get-started');
  });

  await check('every width, phone to 1920: Get started fits (no sideways scroll, nothing clipped or cut)', async () => {
    await fits(a, 'Get started (machine)');
  });

  await check('a step opens its pane on a click (nothing ticks from one); fold keeps one line in this browser', async () => {
    await a.click('[data-testid=ob-step][data-step=agent]');
    await a.waitForFunction(() => document.querySelector('[data-testid=ob-pane]')?.dataset.pane === 'agent', { timeout: 5000 });
    await a
      .waitForFunction(() => document.querySelector('[data-testid=ob-pane]')?.innerText.includes('Claude Code is connected'), { timeout: 10000 })
      .catch(async () => assert(false, `the agent pane says so: ${await textOf(a, '[data-testid=ob-pane]')}`));
    await a.click('[data-testid=ob-fold]');
    await a.waitForSelector('.ob-gs.ob-fold .ob-gs-next');
    assert((await textOf(a, '.ob-gs-next')).replace(/\s+/g, ' ') === 'Next: Share a review link', await textOf(a, '.ob-gs-next'));
    await a.reload({ waitUntil: 'domcontentloaded' });
    await a.waitForSelector('[data-testid=ob-gs].ob-fold', { timeout: 15000 });
    await a.click('[data-testid=ob-fold]');
    await a.waitForFunction(() => !document.querySelector('.ob-gs.ob-fold'), { timeout: 5000 });
  });

  await check('× puts it away with Undo; away again it stays after a reload, and the account menu brings it back', async () => {
    await a.click('[data-testid=ob-hide]');
    await a.waitForFunction(() => !document.querySelector('[data-testid=ob-gs]'), { timeout: 5000 });
    await a.waitForFunction(() => [...document.querySelectorAll('[data-testid=toast] button')].some((b) => b.textContent.includes('Undo')), { timeout: 5000 });
    await clickText(a, '[data-testid=toast] button', 'Undo');
    await a.waitForSelector('[data-testid=ob-gs] [data-testid=ob-step]', { timeout: 10000 });
    await until(async () => !(await api('/api/onboarding')).onboarding.hidden, 'back on the account');
    await a.click('[data-testid=ob-hide]');
    await until(async () => (await api('/api/onboarding')).onboarding.hidden, 'put away on the account');
    await a.reload({ waitUntil: 'domcontentloaded' });
    await a.waitForSelector('.lib-content .film', { timeout: 15000 });
    await sleep(500);
    assert(!(await a.$('[data-testid=ob-gs]')), 'still away after a reload');
    // the sidebar's row stays (getstarted-sidebar.mjs has the rest of it)
    assert((await a.$eval('[data-testid=ob-row-count]', (e) => e.textContent)) === '3 of 4', 'the sidebar’s row stays');
    const items = await menuItems(a);
    assert(items.find((i) => i.startsWith('Get started'))?.includes('3 of 4'), `account menu: ${items}`);
    // at a desk the sidebar is on screen: the menu opens the steps at its foot, the card stays put away
    await clickText(a, '.menu[data-state=open] [role=menuitem]', 'Get started');
    await a.waitForSelector('[data-testid=ob-sp]', { timeout: 10000 });
    assert(!(await a.$('[data-testid=ob-gs]')), 'the card stays put away');
    await a.keyboard.press('Escape');
    // Settings has no sidebar: there the menu brings the card back above All videos
    await a.goto(`${BASE}/#/settings`, { waitUntil: 'domcontentloaded' });
    await a.waitForSelector('.set-nav a', { timeout: 15000 });
    await menuItems(a);
    await clickText(a, '.menu[data-state=open] [role=menuitem]', 'Get started');
    await a.waitForSelector('[data-testid=ob-gs] [data-testid=ob-step]', { timeout: 10000 });
    await until(async () => !(await api('/api/onboarding')).onboarding.hidden, 'back on the account');
  });

  await check('the last step makes a review link right there; then “You’re set”, and it folds away for good', async () => {
    await a.waitForSelector('.ob-gs-pane [data-testid=ob-make-link]', { timeout: 10000 });
    await a.click('.ob-gs-pane [data-testid=ob-make-link]');
    await a.waitForSelector('.ob-gs-pane [data-testid=ob-share-link]', { timeout: 10000 });
    const link = await a.$eval('.ob-gs-pane [data-testid=ob-share-link]', (e) => e.textContent);
    assert(/\/g\/[\w-]+/.test(link), link);
    await a.waitForFunction(() => document.querySelector('.ob-gs.ob-all .ob-gs-title')?.textContent.startsWith('You’re set'), { timeout: 15000 });
    await shot(a, '07-done');
    await a.waitForFunction(() => !document.querySelector('[data-testid=ob-gs]'), { timeout: 15000 });
    const o = (await api('/api/onboarding')).onboarding;
    assert(o.complete && o.hidden, JSON.stringify(o));
    const items = await menuItems(a);
    assert(!items.some((i) => i.startsWith('Get started')), 'nothing to bring back once finished');
    await closeMenu(a);
  });

  // ---------------------------------------------------------------- a store from before the first run
  await check('a store from before the first run never shows it: no setup, no Get started, no sample', async () => {
    const p = await fresh();
    await open(p, '#/', '.empty-library', old.base);
    await sleep(500);
    assert(p.url().endsWith('#/'), `stays in the library: ${p.url()}`);
    assert(!(await p.$('[data-testid=ob-gs], [data-testid=ob-setup]')), 'no first run');
    const items = await menuItems(p);
    assert(!items.some((i) => i.startsWith('Get started')), `account menu: ${items}`);
    assert((await api('/api/onboarding', 'GET', undefined, old.base)).onboarding === null, 'none on the account');
    assert(!(await api('/api/library', 'GET', undefined, old.base)).videos.length, 'no sample');
    await p.browserContext().close();
  });

  // A new account with no video yet was offered only Upload: making one with their agent is the other way in
  await check('an empty library offers making a video with an agent: its prompt is copied, the line under it says so', async () => {
    const p = await fresh();
    await p.browserContext().overridePermissions(old.base, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
    await open(p, '#/', '.empty-library', old.base);
    const text = await p.$eval('.empty-library', (e) => e.textContent);
    assert(text.includes('No video yet? Your agent can make one and put it here for review.'), text);
    await p.click('[data-testid=make-with-agent]');
    await p.waitForFunction(() => document.body.textContent.includes('Prompt copied'), { timeout: 5000 });
    const copied = await p.evaluate(() => navigator.clipboard.readText());
    // whoever uploads puts it up with vr push; at the machine itself a render is linked (vr track): either way, and then
    // the notes with vr open
    const put = copied.includes('vr push <file> --folder') || copied.includes('vr track <file> --me');
    assert(copied.startsWith('Make a short video:') && put && copied.includes('vr open <video>'), copied);
    await shot(p, '00-empty-library');
    await p.browserContext().close();
  });

  // ---------------------------------------------------------------- German
  await check('German: Welcome, skipped to the library; Get started speaks German', async () => {
    const p = await fresh({ lang: 'de' });
    // "Skip setup" in the header: one phrase in German word order, not two English-ordered words
    await p.goto(`${german.base}/#/welcome/renders`, { waitUntil: 'domcontentloaded' });
    await atStep(p, 'renders');
    const skip = await p.$eval('[data-testid=ob-skip]', (e) => e.innerText.trim());
    assert(skip === 'Einrichtung überspringen', `the skip button reads “${skip}”`);
    await p.goto(`${german.base}/#/`, { waitUntil: 'domcontentloaded' });
    await atStep(p, 'welcome');
    assert((await p.$eval('h1', (e) => e.textContent)) === 'Willkommen bei Lampo', await p.$eval('h1', (e) => e.textContent));
    // A busy server (CI) takes the setup's end late: here it is held while Get started asks again (the person comes back
    // to the tab, the sample being made says the library changed). What that answer says — the setup still due — must
    // not send the person back to Welcome.
    await p.setRequestInterception(true);
    let held = null;
    let answered = 0;
    p.on('request', (r) => {
      if (r.method() === 'PUT' && r.url().endsWith('/api/onboarding')) held = r;
      else r.continue();
    });
    p.on('response', (r) => {
      if (held && r.request().method() === 'GET' && r.url().endsWith('/api/onboarding')) answered++;
    });
    const bounced = async () => (await p.evaluate(() => location.hash)) === '#/welcome';
    await p.click('[data-testid=ob-skip-all]');
    await p.waitForSelector('[data-testid=ob-gs]', { timeout: 15000 });
    await until(() => held, 'the setup’s end on its way');
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await until(async () => answered > 0 || (await bounced()), 'Get started asked again while the end was on its way');
    await settle(p);
    const back = await bounced();
    held.continue();
    held = null;
    assert(!back, 'what Get started read before the server took the setup’s end sent the person back to Welcome');
    await until(async () => (await api('/api/onboarding', 'GET', undefined, german.base)).onboarding.setup_done, 'skipping ends the setup');
    await p.waitForSelector('[data-testid=ob-gs] [data-testid=ob-step]', { timeout: 15000 });
    assert(p.url().endsWith('#/'), `still in the library: ${p.url()}`);
    assert((await p.$eval('.ob-gs-title', (e) => e.firstChild.textContent)) === 'Erste Schritte', 'the title');
    const titles = await titlesOf(p);
    assert(titles[0] === 'Beispiel ausprobieren' && titles.includes('Erstes Video verknüpfen'), `the steps in German: ${titles}`);
    await p.browserContext().close();
  });

  await check('one click removes the sample (the card’s menu); “Try it with a sample” makes it again, in German', async () => {
    const p = await fresh({ lang: 'de' });
    await until(async () => (await api('/api/library', 'GET', undefined, german.base)).videos.find((v) => v.sample), 'the sample made at the start');
    await open(p, '#/', '.film .vchip.sample-chip', german.base);
    assert((await p.$eval('.film .vchip.sample-chip', (e) => e.textContent)) === 'Beispiel', 'the card says Beispiel');
    // the card's ⋯ (a menu that opens on a real press)
    const more = await p.evaluateHandle(() =>
      [...document.querySelectorAll('.film')].find((f) => f.querySelector('.sample-chip'))?.querySelector('.film-menu button'),
    );
    await more.asElement().focus();
    await p.keyboard.press('Enter');
    await p.waitForSelector('.menu[data-state=open] [role=menuitem]');
    await clickText(p, '.menu[data-state=open] [role=menuitem]', 'Beispiel entfernen');
    await p.waitForFunction(() => !document.querySelector('.film .sample-chip'), { timeout: 10000 });
    const gone = await api('/api/library', 'GET', undefined, german.base);
    assert(!gone.videos.some((v) => v.sample), 'gone from the library');
    await p.waitForSelector('.ob-gs-pane [data-testid=ob-sample-make]', { timeout: 10000 });
    assert((await p.$eval('[data-testid=ob-sample-make]', (e) => e.textContent)).includes('Mit einem Beispiel ausprobieren'), 'offered again');
    await p.click('.ob-gs-pane [data-testid=ob-sample-make]');
    await p.waitForFunction(() => location.hash.startsWith('#/v/'), { timeout: 30000 });
    await openNote(p, 'Soll der Titel');
    await p.waitForFunction(
      () =>
        document.body.textContent.includes('Lampo-Beispiel.mp4') &&
        document.querySelector('.comment.note.active [data-testid=choices]')?.textContent.includes('Stehen lassen'),
      { timeout: 15000 },
    );
    await shot(p, '08-german-sample');
    await p.browserContext().close();
  });

  await check('a phone: Get started is an accordion that fits, with thumb-sized controls', async () => {
    const p = await fresh({ width: 390, height: 844, mobile: true, lang: 'de' });
    await open(p, '#/', '[data-testid=ob-gs] [data-testid=ob-step]', german.base);
    // the selected step's pane opens under its row
    assert(await p.$('[data-testid=ob-gs] .ob-gs-acc'), 'the pane under its row');
    const small = await p.$$eval('[data-testid=ob-gs] button, [data-testid=ob-gs] a[href]', (els) =>
      els
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width && r.height && getComputedStyle(e).visibility !== 'hidden';
        })
        .map((e) => {
          const r = e.getBoundingClientRect();
          const after = getComputedStyle(e, '::after');
          const h = Math.max(r.height, Number.parseFloat(after.height) || 0);
          return { name: e.textContent.trim() || e.getAttribute('aria-label'), h: Math.round(h) };
        })
        .filter((x) => x.h < 43),
    );
    assert(!small.length, `under 44 px: ${JSON.stringify(small)}`);
    await fits(p, 'Get started (phone)');
    await shot(p, '09-phone');
    await p.browserContext().close();
  });

  await check('no errors in the page', async () => {
    assert(!errors.length, errors.join('\n'));
  });
} catch (e) {
  crashed(e, ...servers);
}
await finish(LABEL, { browser, servers });
