#!/usr/bin/env node
// covers: web/src/onboarding/GetStarted.tsx web/src/onboarding/state.ts web/src/onboarding/pictures.tsx web/src/onboarding/connect.tsx web/src/styles/onboarding.css web/src/styles/getstarted.css web/src/styles/lighttable.css web/src/library/Library.tsx
// Get started's card as it looks and holds still, for a hosted server's owner (all five steps, the invite among them),
// reached the way an account that never went through the setup's screens reaches it (the setup's end set by PUT: the
// setup's code and styles never load). Its controls are the app's own; one rhythm in every step, no browser margins;
// clicking through every step at 1440 and 1920 leaves the card's height and the library's toolbar where they were, to
// the pixel; finishing a step, × and Undo too; the room the first paint keeps is the card's height (open and folded,
// desk and phone); a step picked with the pointer wears its fill, never a ring; wide windows keep a measure for the
// words and the step's picture beside them.
import { sleep } from '../lib/helpers.ts';
import { settle } from './layout.mjs';
import { launch, requireChrome, signedIn } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'getstarted e2e';
requireChrome(LABEL);
const PW = 'a long enough password';
const STEPS = ['sample', 'video', 'agent', 'invite', 'share'];

const servers = [];
let browser;
let page = null;
screenshotFailures(() => page, 'getstarted');
try {
  const srv = await startServer({ prefix: 'vr-gs-e2e-', mode: 'server', publicUrl: true, onboarding: true });
  servers.push(srv);
  const BASE = srv.base;
  const call = (p, method, body, cookie) =>
    fetch(BASE + p, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: BASE, ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  // the owner, made with the setup token; the setup's screens are skipped by the API, never opened
  const made = await call('/api/auth/setup', 'POST', { token: await srv.setupToken(), name: 'Mia Lang', email: 'mia@e2e.test', password: PW });
  assert(made.ok, `setup: ${made.status}`);
  const cookie = (made.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('vr_session='))?.split(';')[0];
  assert((await call('/api/onboarding', 'PUT', { setup: 'done' }, cookie)).ok, 'the setup done by PUT');
  browser = await launch();
  const errors = [];

  const fresh = async ({ width = 1440, height = 900, mobile = false, before } = {}) => {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width, height, ...(mobile ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
    await p.setCookie({ name: 'vr_session', value: cookie.split('=').slice(1).join('='), url: BASE });
    if (before) await p.evaluateOnNewDocument(before);
    p.on('pageerror', (e) => errors.push(e.message));
    page = p;
    return p;
  };
  const open = async (p) => {
    await p.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('[data-testid=ob-gs] [data-testid=ob-step]', { timeout: 15000 });
    await signedIn(p);
    await settle(p, { quiet: 300 });
  };
  /** Clicks a step's row with the pointer and waits until its pane stands (the slide-in played). */
  const pick = async (p, id, mobile = false) => {
    await p.click(`.ob-gs-list [data-testid=ob-step][data-step=${id}]`);
    await p.waitForFunction(
      (id, mobile) =>
        mobile
          ? document.querySelector(`.ob-gs-list [data-step=${id}]`)?.parentElement?.querySelector('.ob-gs-acc')
          : document.querySelector('[data-testid=ob-pane]')?.dataset.pane === id,
      { timeout: 5000 },
      id,
      mobile,
    );
    await p.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime))
          .map((a) => a.finished.catch(() => {})),
      ),
    );
  };
  /** The card's height and the toolbar's top (in the page, not the window: the library scrolls). */
  const where = (p) =>
    p.evaluate(() => {
      const scroller = document.querySelector('.lib-scroll');
      const card = document.querySelector('[data-testid=ob-gs]').getBoundingClientRect();
      const bar = document.querySelector('.lib-toolbar').getBoundingClientRect();
      return { card: Math.round(card.height * 10) / 10, toolbar: Math.round((bar.top + scroller.scrollTop) * 10) / 10 };
    });
  const same = (a, b) => Math.abs(a - b) < 0.5;

  // ---------------------------------------------------------------- styles of its own
  const p = await fresh();
  await check('Get started without the setup’s code: all five steps, and nothing of the setup loaded', async () => {
    await open(p);
    const steps = await p.$$eval('.ob-gs-list [data-testid=ob-step]', (els) => els.map((e) => e.dataset.step));
    assert(JSON.stringify(steps) === JSON.stringify(STEPS), `a server's owner: ${steps}`);
    const setup = await p.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .filter((n) => /\/assets\/Setup-[\w-]+\.(js|css)$/.test(n)),
    );
    assert(!setup.length, `the setup's code arrived: ${setup}`);
  });

  await check('the invite’s field, role and button are the app’s own controls (not the browser’s)', async () => {
    await pick(p, 'invite');
    const found = await p.evaluate(() => {
      const pane = document.querySelector('[data-testid=ob-pane]');
      const visible = (e) => e && e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility === 'visible';
      const email = [...pane.querySelectorAll('input[name=email]')].find(visible);
      const role = [...pane.querySelectorAll('select, [aria-label=Role]')].find(visible);
      const send = [...pane.querySelectorAll('[data-testid=ob-invite-send]')].find(visible);
      // the app's field, drawn here for comparison
      const ref = document.createElement('input');
      ref.className = 'input';
      pane.append(ref);
      const look = (e) => {
        if (!e) return null;
        const s = getComputedStyle(e);
        return {
          tag: e.tagName.toLowerCase(),
          height: Math.round(e.getBoundingClientRect().height),
          border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
          radius: s.borderTopLeftRadius,
          font: `${s.fontSize} ${s.fontFamily.split(',')[0]}`,
          background: s.backgroundColor,
          appearance: s.appearance,
        };
      };
      const out = { email: look(email), role: look(role), send: look(send), ref: look(ref) };
      ref.remove();
      return out;
    });
    const { email, role, send, ref } = found;
    assert(email && role && send, `the form's controls: ${JSON.stringify(found)}`);
    for (const k of ['height', 'border', 'radius', 'font', 'background'])
      assert(email[k] === ref[k], `the email field's ${k} is ${email[k]}, the app's field has ${ref[k]}`);
    assert(role.tag !== 'select', 'the role is a native <select>');
    for (const k of ['height', 'border', 'radius', 'font']) assert(role[k] === ref[k], `the role's ${k} is ${role[k]}, the app's field has ${ref[k]}`);
    assert(send.height === ref.height && send.radius === ref.radius, `the Invite button: ${JSON.stringify(send)} beside ${JSON.stringify(ref)}`);
  });

  await check('one rhythm in every step: 12 px from the headline to the line under it, no browser margins', async () => {
    const off = [];
    for (const id of STEPS) {
      await pick(p, id);
      const m = await p.evaluate(() => {
        const on = document.querySelector('[data-testid=ob-pane] .ob-gs-slot.ob-on') ?? document.querySelector('[data-testid=ob-pane]');
        const h3 = on.querySelector('h3');
        const below = h3?.nextElementSibling;
        const token = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sp-3'));
        const margins = [...document.querySelectorAll('[data-testid=ob-gs] :is(h2, h3, p, ul, ol, fieldset)')]
          .filter((e) => e.getBoundingClientRect().height > 0)
          .filter((e) => {
            const s = getComputedStyle(e);
            return Number.parseFloat(s.marginTop) || Number.parseFloat(s.marginBottom);
          })
          .map((e) => `${e.tagName.toLowerCase()}.${e.className}`);
        return {
          gap: h3 && below ? Math.round((below.getBoundingClientRect().top - h3.getBoundingClientRect().bottom) * 10) / 10 : null,
          token,
          margins,
        };
      });
      if (m.gap !== m.token) off.push(`${id}: ${m.gap} px from the headline to what follows (the rhythm is ${m.token})`);
      if (m.margins.length) off.push(`${id}: browser margins on ${m.margins.join(', ')}`);
    }
    assert(!off.length, off.join('\n        '));
  });

  await check('a step picked with the pointer wears its fill, never a ring — not even after a key like Shift (⌘⇧4)', async () => {
    await pick(p, 'share');
    await p.keyboard.down('Shift');
    await p.keyboard.up('Shift');
    const row = await p.$eval('.ob-gs-list [data-step=share]', (e) => {
      const s = getComputedStyle(e);
      return { outline: s.outlineStyle, ring: s.boxShadow, fill: s.backgroundColor, current: e.getAttribute('aria-current') };
    });
    assert(row.current === 'step', 'the picked step is the current one');
    assert(row.outline === 'none' && row.ring === 'none', `a ring on the picked row: outline ${row.outline}, box-shadow ${row.ring}`);
    assert(row.fill !== 'rgba(0, 0, 0, 0)', 'the picked row has its fill');
  });

  await check('moving through the steps by keys rings the focused one (the app’s soft ring)', async () => {
    await p.focus('.ob-gs-list [data-step=invite]');
    await p.keyboard.press('Tab');
    const ring = await p.evaluate(() => {
      const e = document.activeElement;
      return { step: e?.dataset.step, ring: getComputedStyle(e).boxShadow, outline: getComputedStyle(e).outlineStyle };
    });
    assert(ring.step === 'share', `Tab moved to ${ring.step}`);
    assert(ring.ring !== 'none' && ring.outline === 'none', `the keyboard's ring: ${JSON.stringify(ring)}`);
  });

  // ---------------------------------------------------------------- nothing moves
  for (const width of [1440, 1920]) {
    await check(`every step at ${width}: the card’s height and the toolbar under it don’t move`, async () => {
      await p.setViewport({ width, height: 900 });
      await settle(p);
      const seen = [];
      for (const id of [...STEPS, 'sample']) {
        await pick(p, id);
        seen.push({ id, ...(await where(p)) });
      }
      const moved = seen.filter((s) => !same(s.card, seen[0].card) || !same(s.toolbar, seen[0].toolbar));
      assert(!moved.length, `card height · toolbar top per step: ${seen.map((s) => `${s.id} ${s.card} · ${s.toolbar}`).join(', ')}`);
    });
  }

  await check('wide windows: the words keep a measure (≤ 600 px) and every step has its picture beside them', async () => {
    const off = [];
    for (const width of [1920, 2560]) {
      await p.setViewport({ width, height: 1080 });
      await settle(p);
      for (const id of STEPS) {
        await pick(p, id);
        const m = await p.evaluate(() => {
          const pane = document.querySelector('[data-testid=ob-pane]');
          const on = pane.querySelector('.ob-gs-slot.ob-on');
          const text = on?.querySelector('.ob-gs-text')?.getBoundingClientRect();
          const pic = on?.querySelector('.ob-gs-pic')?.getBoundingClientRect();
          const box = pane.getBoundingClientRect();
          const pad = Number.parseFloat(getComputedStyle(pane).paddingRight);
          return { text: text?.width ?? null, pic: pic?.width ?? 0, gapRight: pic ? Math.round(box.right - pad - pic.right) : null };
        });
        if (!m.text || m.text > 600.5) off.push(`${id} @${width}: the words are ${m.text} px wide`);
        if (!m.pic) off.push(`${id} @${width}: no picture beside the words`);
        else if (Math.abs(m.gapRight) > 1) off.push(`${id} @${width}: the picture stops ${m.gapRight} px short of the pane's edge`);
      }
    }
    await p.setViewport({ width: 1440, height: 900 });
    assert(!off.length, off.join('\n        '));
  });

  /** Opens the library with Get started's code held back: the room it keeps, then the card once the code is let in. */
  const roomThenCard = async ({ mobile = false, width = 1440, folded = false } = {}) => {
    const q = await fresh({
      width,
      height: mobile ? 844 : 900,
      mobile,
      before: folded ? () => localStorage.setItem('vr.gs.fold', '1') : () => localStorage.removeItem('vr.gs.fold'),
    });
    await q.setBypassServiceWorker(true);
    await q.setRequestInterception(true);
    let held = null;
    q.on('request', (r) => {
      if (/\/assets\/GetStarted-[\w-]+\.js$/.test(r.url())) held = r;
      else r.continue().catch(() => {});
    });
    await q.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await q.waitForSelector('.ob-gs.ob-pending', { timeout: 15000 });
    await signedIn(q);
    await settle(q, { quiet: 300 });
    const room = await q.evaluate(() => {
      const scroller = document.querySelector('.lib-scroll');
      const r = document.querySelector('.ob-gs.ob-pending').getBoundingClientRect();
      const bar = document.querySelector('.lib-toolbar').getBoundingClientRect();
      return { card: Math.round(r.height * 10) / 10, toolbar: Math.round((bar.top + scroller.scrollTop) * 10) / 10 };
    });
    for (const t = Date.now(); !held && Date.now() - t < 10000; ) await sleep(50);
    assert(held, 'Get started’s code was asked for');
    held.continue();
    await q.waitForSelector('[data-testid=ob-gs] [data-testid=ob-step]', { timeout: 15000 });
    await settle(q, { quiet: 300 });
    const card = await where(q);
    await q.browserContext().close();
    return { room, card };
  };
  for (const c of [
    { name: 'open, 1440', o: {} },
    { name: 'open, 1920', o: { width: 1920 } },
    { name: 'folded, 1440', o: { folded: true } },
    { name: 'open, a phone', o: { mobile: true, width: 390 } },
  ])
    await check(`while its code arrives, the first paint keeps the card’s own room (${c.name})`, async () => {
      const { room, card } = await roomThenCard(c.o);
      assert(
        same(room.card, card.card) && same(room.toolbar, card.toolbar),
        `room ${room.card} (toolbar at ${room.toolbar}) → card ${card.card} (toolbar at ${card.toolbar})`,
      );
    });

  await check('finishing a step (a review link made) moves nothing: the card and the toolbar stay', async () => {
    await p.setViewport({ width: 1440, height: 900 });
    await settle(p);
    await pick(p, 'share');
    const before = await where(p);
    await p.click('[data-testid=ob-pane] [data-testid=ob-make-link]');
    await p.waitForSelector('[data-testid=ob-pane] [data-testid=ob-share-link]', { timeout: 10000 });
    // the server finds the link: the step ticks, and a moment later the selection moves on
    await p.waitForFunction(() => document.querySelector('.ob-gs-list [data-step=share]')?.hasAttribute('data-done'), { timeout: 15000 });
    await p.waitForFunction(() => document.querySelector('[data-testid=ob-pane]')?.dataset.pane !== 'share', { timeout: 10000 });
    await settle(p, { quiet: 300 });
    const after = await where(p);
    assert(same(before.card, after.card) && same(before.toolbar, after.toolbar), `before ${JSON.stringify(before)} → after ${JSON.stringify(after)}`);
  });

  await check('× and Undo: the card comes back at the height it had, in one step', async () => {
    const before = await where(p);
    await p.click('[data-testid=ob-hide]');
    await p.waitForFunction(() => !document.querySelector('[data-testid=ob-gs]'), { timeout: 5000 });
    await p.waitForFunction(() => [...document.querySelectorAll('[data-testid=toast] button')].some((b) => b.textContent.includes('Undo')), { timeout: 5000 });
    // every height the card has from the moment it is back
    await p.evaluate(() => {
      window.__gsHeights = [];
      new MutationObserver(() => {
        const c = document.querySelector('[data-testid=ob-gs]');
        if (c) window.__gsHeights.push(Math.round(c.getBoundingClientRect().height));
      }).observe(document.body, { childList: true, subtree: true, attributes: true });
    });
    await p.evaluate(() => [...document.querySelectorAll('[data-testid=toast] button')].find((b) => b.textContent.includes('Undo'))?.click());
    await p.waitForSelector('[data-testid=ob-gs] [data-testid=ob-step]', { timeout: 10000 });
    await settle(p, { quiet: 300 });
    const after = await where(p);
    const heights = [...new Set(await p.evaluate(() => window.__gsHeights))];
    assert(same(before.card, after.card) && same(before.toolbar, after.toolbar), `before ${JSON.stringify(before)} → after ${JSON.stringify(after)}`);
    assert(
      heights.every((h) => Math.abs(h - before.card) <= 1),
      `the card passed through ${heights.join(', ')} px on its way back`,
    );
  });

  await check('no errors in the page', async () => {
    assert(!errors.length, errors.join('\n'));
  });
} catch (e) {
  crashed(e, ...servers);
}
await finish(LABEL, { browser, servers });
