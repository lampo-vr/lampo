#!/usr/bin/env node
// covers: web/src/ui/layers.tsx web/src/styles/toasts.css web/src/lib/toast.ts
// The toasts are one stack (ui/layers.tsx Toaster, styles/toasts.css): three toasts collapse to one toast's height,
// the newest in front and readable, the two before it tucked behind with their words faded. Hovered, the stack opens
// into a list with even gaps, every toast readable, and every timer waits (a toast past its time is still there while
// the pointer is on the stack, and goes once it leaves); leaving closes it. Dismissing one closes the gap. With
// reduced motion a toast only fades. On a phone the stack hangs under the top bar, full width but for the gutters,
// and a swipe up dismisses a toast.
import { sleep, until } from '../lib/helpers.ts';
import { launch, requireChrome } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'toasts e2e';
requireChrome(LABEL);

const servers = [];
let browser;
let still;
let page = null;
screenshotFailures(() => page, 'toasts');
try {
  const srv = await startServer({ prefix: 'vr-toasts-e2e-', user: 'Sam' });
  servers.push(srv);
  // motion on: the stack's own moves and fades are what this suite is about
  browser = await launch({ reducedMotion: false });
  const errors = [];
  const open = async (b, { width = 1440, height = 900, mobile = false } = {}) => {
    const ctx = await b.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width, height, ...(mobile ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${srv.base}/#/styleguide`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('[data-testid=styleguide] .empty-state', { timeout: 20000 });
    // the toaster (the Radix layer) arrives after the first paint
    await p.waitForSelector('.toasts', { timeout: 20000 });
    page = p;
    return p;
  };
  /** Shows toasts one after another, a beat apart, as the app's toast() does (its event). */
  const fire = (p, items) =>
    p.evaluate(async (items) => {
      for (const [n, it] of items.entries()) {
        if (n) await new Promise((r) => setTimeout(r, 150));
        const detail = { id: Math.random(), kind: 'ok', ...it };
        if (it.undo) detail.action = { label: 'Undo', undo: true, onClick: () => {} };
        window.dispatchEvent(new CustomEvent('vr-toast', { detail }));
      }
    }, items);
  /** Each toast as it stands: words, place in the stack, box, and how much of it and its words show. */
  const stack = (p) =>
    p.evaluate(() => {
      const list = document.querySelector('.toasts');
      const lr = list.getBoundingClientRect();
      return {
        open: list.hasAttribute('data-expanded'),
        height: lr.height,
        toasts: [...list.querySelectorAll('[data-testid=toast]')]
          .filter((t) => t.dataset.state === 'open')
          .map((t) => {
            const r = t.getBoundingClientRect();
            const body = t.querySelector('.toast-body');
            return {
              text: t.querySelector('.toast-title')?.textContent,
              depth: t.dataset.depth,
              top: r.top,
              bottom: r.bottom,
              left: r.left,
              right: r.right,
              height: r.height,
              shown: Number(getComputedStyle(t).opacity) * Number(getComputedStyle(body).opacity),
            };
          }),
      };
    });
  /** The stack once nothing in it moves any more (finite animations and transitions ended). */
  const calm = async (p) => {
    await p.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.target?.closest?.('.toasts') && Number.isFinite(a.effect.getComputedTiming().endTime))
          .map((a) => a.finished.catch(() => {})),
      ),
    );
    await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  };
  const centre = (p) =>
    p.$eval('.toasts', (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });

  await check('three toasts collapse to one toast’s height: the newest in front and readable, the two before it tucked behind, words faded', async () => {
    const p = await open(browser);
    await p.mouse.move(20, 20);
    await fire(p, [
      { message: 'One', duration: 30000 },
      { message: 'Two', duration: 30000, undo: true },
      { message: 'Three', duration: 30000 },
    ]);
    await until(async () => (await stack(p)).toasts.length === 3, 'three toasts');
    await calm(p);
    const s = await stack(p);
    const [one, two, three] = s.toasts;
    assert(!s.open, 'collapsed while the pointer is elsewhere');
    assert(three.depth === 'front' && three.shown === 1, `the newest in front, readable: ${JSON.stringify(three)}`);
    assert(
      [one, two].every((t) => t.depth === 'behind' && t.shown === 0),
      `the two before it behind, their words faded: ${JSON.stringify(s.toasts)}`,
    );
    assert(Math.abs(s.height - three.height) <= 1, `the stack is one toast tall: ${s.height} vs ${three.height}`);
    // tucked in: each a step smaller and a little higher, peeking out above the one in front of it
    assert(two.top < three.top && one.top < two.top && three.top - one.top < 30, `peeking above, a few px each: ${JSON.stringify(s.toasts)}`);
    assert(two.right - two.left < three.right - three.left && one.right - one.left < two.right - two.left, 'each a step smaller');
  });

  await check('hovered, the stack opens into a readable list with even gaps; leaving closes it', async () => {
    const p = page;
    const c = await centre(p);
    await p.mouse.move(c.x, c.y, { steps: 4 });
    await until(async () => (await stack(p)).open, 'the stack opens');
    await calm(p);
    const s = await stack(p);
    assert(
      s.toasts.every((t) => t.shown === 1),
      `all readable: ${JSON.stringify(s.toasts)}`,
    );
    const [one, two, three] = s.toasts;
    const gaps = [three.top - two.bottom, two.top - one.bottom].map(Math.round);
    assert(gaps.every((g) => g >= 8) && Math.abs(gaps[0] - gaps[1]) <= 1, `even gaps, none overlapping: ${gaps}`);
    await p.mouse.move(c.x, 120, { steps: 4 });
    await until(async () => !(await stack(p)).open, 'the stack closes');
    await calm(p);
    assert((await stack(p)).toasts.filter((t) => t.shown === 1).length === 1, 'collapsed again: one readable');
  });

  await check('dismissing one closes the gap: the others move up to their places', async () => {
    const p = page;
    const c = await centre(p);
    await p.mouse.move(c.x, c.y, { steps: 4 });
    await until(async () => (await stack(p)).open, 'the stack opens');
    await calm(p);
    const x = await p.evaluateHandle(() =>
      [...document.querySelectorAll('[data-testid=toast]')].find((t) => t.textContent.includes('Two'))?.querySelector('.toast-x'),
    );
    await x.asElement().click();
    await until(async () => (await stack(p)).toasts.length === 2, 'two left');
    await until(async () => !(await p.$$eval('[data-testid=toast]', (ts) => ts.some((t) => t.textContent.includes('Two')))), 'the dismissed one gone');
    await calm(p);
    const [one, three] = (await stack(p)).toasts;
    const gap = Math.round(three.top - one.bottom);
    assert(gap >= 8 && gap <= 16, `the gap closed to one step: ${gap} px`);
    await p.mouse.move(20, 20);
    await p.browserContext().close();
  });

  await check('while the stack is hovered every timer waits: a toast past its time stays, and goes once the pointer leaves', async () => {
    const p = await open(browser);
    await p.mouse.move(20, 20);
    // the one with little time is the oldest, tucked behind: every timer waits, not only the front one's
    await fire(p, [
      { message: 'Brief', duration: 3000 },
      { message: 'Long', duration: 60000 },
    ]);
    await until(async () => (await stack(p)).toasts.length === 2, 'the toasts');
    await calm(p);
    const c = await centre(p);
    await p.mouse.move(c.x, c.y, { steps: 3 });
    await until(async () => (await stack(p)).open, 'hovered');
    const texts = async () => (await stack(p)).toasts.map((x) => x.text).join();
    assert((await texts()) === 'Brief,Long', `both there when hovered: ${await texts()}`);
    // its 3 s run out while the pointer is on the stack
    await sleep(4000);
    assert((await texts()) === 'Brief,Long', `still there after its time while hovered: ${await texts()}`);
    await p.mouse.move(c.x, 120, { steps: 3 });
    await until(async () => (await texts()) === 'Long', 'the brief one gone once the pointer left, the other still there', 8000);
    await p.browserContext().close();
  });

  await check('the keyboard: F8 opens the stack, its buttons take the focus, and Tab leads out again, closing it', async () => {
    const p = await open(browser);
    await p.mouse.move(20, 20);
    await fire(p, [
      { message: 'First', duration: 60000, undo: true },
      { message: 'Second', duration: 60000 },
    ]);
    await until(async () => (await stack(p)).toasts.length === 2, 'the toasts');
    await p.keyboard.press('F8');
    await until(async () => (await stack(p)).open, 'opened by the keyboard');
    const inside = () => p.evaluate(() => !!document.activeElement?.closest('.toasts'));
    assert(await inside(), 'the focus in the stack');
    let out = false;
    for (let n = 0; n < 10 && !out; n++) {
      await p.keyboard.press('Tab');
      out = !(await inside());
    }
    assert(out, 'Tab leads out of the stack (the focus is never held there)');
    await until(async () => !(await stack(p)).open, 'closed once the focus left');
    await p.browserContext().close();
  });

  await check('with reduced motion a toast only fades: no slide, no spring', async () => {
    still = await launch({ reducedMotion: true });
    const p = await open(still);
    await fire(p, [{ message: 'Quiet', duration: 30000 }]);
    await p.waitForSelector('[data-testid=toast][data-state=open]');
    const m = await p.$eval('[data-testid=toast]', (t) => {
      const cs = getComputedStyle(t);
      return { animation: cs.animationName, transition: cs.transitionProperty };
    });
    assert(m.animation === 'toast-fade-in' && m.transition === 'opacity', `a fade only: ${JSON.stringify(m)}`);
    await p.browserContext().close();
  });

  await check('a phone: under the top bar, full width but the gutters, 44 px to tap; a tap opens the stack, a swipe up dismisses', async () => {
    const p = await open(browser, { width: 390, height: 844, mobile: true });
    await fire(p, [
      { message: 'Older', duration: 30000 },
      { message: 'Saved on the phone', duration: 30000, undo: true },
    ]);
    await until(async () => (await stack(p)).toasts.length === 2, 'the toasts');
    await calm(p);
    const t = (await stack(p)).toasts.find((x) => x.depth === 'front');
    assert(t.top >= 60 && Math.round(t.left) === 16 && Math.round(t.right) === 374, `placed: ${JSON.stringify(t)}`);
    const taps = await p.$$eval('[data-testid=toast][data-depth=front] :is(.toast-act, .toast-x)', (bs) =>
      bs.map((b) => {
        const r = b.getBoundingClientRect();
        const a = getComputedStyle(b, '::after');
        return Math.max(r.height, a.position === 'absolute' ? Number.parseFloat(a.height) || 0 : 0);
      }),
    );
    assert(taps.length === 2 && taps.every((h) => h >= 44), `44 px tap areas: ${taps}`);
    // touches one at a time through CDP, each with its own timestamp
    const s = await p.target().createCDPSession();
    let ts = Date.now() / 1000;
    const touch = (type, x, y) => {
      ts += 0.016;
      return s.send('Input.dispatchTouchEvent', { type, timestamp: ts, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    };
    const x = t.left + 60;
    const y0 = (t.top + t.bottom) / 2;
    // a tap on the words opens the list; a tap anywhere else closes it
    await touch('touchStart', x, y0);
    await touch('touchEnd', x, y0);
    await until(async () => (await stack(p)).open, 'a tap opens it');
    await touch('touchStart', 195, 640);
    await touch('touchEnd', 195, 640);
    await until(async () => !(await stack(p)).open, 'a tap elsewhere closes it');
    await calm(p);
    // the swipe takes the front one away and leaves the stack closed
    await touch('touchStart', x, y0);
    for (let n = 1; n <= 8; n++) await touch('touchMove', x, y0 - n * 12);
    await touch('touchEnd', x, y0 - 96);
    await until(async () => (await stack(p)).toasts.map((x) => x.text).join() === 'Older', 'swiped away');
    assert(!(await stack(p)).open, 'a swipe never opens the stack');
    await p.browserContext().close();
  });

  await check('no errors in the page', async () => {
    assert(!errors.length, errors.join('\n'));
  });
} catch (e) {
  crashed(e, ...servers);
}
await still?.close().catch(() => {});
await finish(LABEL, { browser, servers });
