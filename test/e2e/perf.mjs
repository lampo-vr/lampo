#!/usr/bin/env node
// covers: web/src/api/ web/src/lib/ web/src/library/ web/src/player/ bench/perf/
// Budgets for what a person feels, on the production build with Chrome's CPU slowed down 4× (DevTools protocol) and a
// synthetic store of 300 videos and 3,000 notes (bench/perf/synth.ts): the library paints from what the browser kept
// without waiting for the server; the first paint asks the API at most one round trip deep (two on a first visit);
// typing in the filter and switching the layout answer within their input budgets, with a bounded number of React
// commits; a hovered video opens with its notes and its first frame within budget; playing a render doesn't render the
// player per frame; a note added elsewhere costs an open library a few small requests, not the library again; a video
// with hundreds of notes renders the ones near the view.
// Timings take the best of three tries: a busy machine slows one try, not three. bench/perf/ has the full picture.
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { ROOT, sleep, tmpdir } from '../lib/helpers.ts';
import { launch, requireChrome } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { apiWaterfall, commits, instrument, isApi, now, recordNetwork, seen, slowest, throttle, watchFor, watchFrame, watchFromStart } from './lib/perf.mjs';
import { startServer } from './lib/server.mjs';

// A time budget holds on a quiet machine. With the 1-minute load above BUSY the numbers measure the machine, not the
// app (measured: warm paint 398 ms at load < 9, 455–544 ms at load 40–75 on the same build) — a miss is reported, not
// failed. Counts (commits, requests) stay strict. VR_PERF_STRICT=1 fails on any miss (a quiet run before a merge).
// VR_PERF_TIMES=report: the budgets were measured on the maintainer's Mac, so on a machine they weren't (CI's runners)
// a miss is reported as a warning on the run, never failed and never silent, until budgets are set for that machine.
const BUSY = 10;
const REPORT_TIMES = process.env.VR_PERF_TIMES === 'report' && process.env.VR_PERF_STRICT !== '1';
const within = (ms, budget, what) => {
  if (ms <= budget) return;
  if (REPORT_TIMES) {
    console.log(`      over budget (VR_PERF_TIMES=report, not failing): ${what}`);
    if (process.env.GITHUB_ACTIONS === 'true') console.log(`::warning title=perf budget::${what}`);
    return;
  }
  const load = os.loadavg()[0];
  if (load > BUSY && process.env.VR_PERF_STRICT !== '1') {
    console.log(`      over budget while the machine is busy (load ${load.toFixed(0)}), not failing: ${what}`);
    return;
  }
  assert(false, what);
};

const LABEL = 'perf e2e';
const CPU = 4;
// The budgets (ms at CPU 4×, on the store below; bench/perf/ and the PR notes have the measurements behind them). Raise
// one only on purpose, and say why in the commit.
// 2026-09-30: warmPaint 900 → 450 and layout 250 → 100 (the first render waits for the screen's code instead of
// suspending, Radix loads after the first paint, cards mount no menus or tooltips of their own, windows render the rows
// in view in the first pass). The warm paint's goal is 300 ms; on chrome-headless-shell, which the suites run on now
// and which compiles the start's modules afresh on every load (~80 ms at CPU 4×), the best of three measures 380–420 ms
// (main before this: ~790 ms on the same shell). bench/perf/README.md has the numbers.
const BUDGET = {
  /** Navigation → the first real card, with the library kept in the browser and every API answer held back. */
  warmPaint: 450,
  /** The slowest input of typing a word into the filter / of switching the layout (Event Timing, like INP). */
  typing: 100,
  layout: 100,
  /** A hovered card clicked → its notes on screen / its first frame. */
  openNotes: 400,
  openFrame: 300,
  /** React commits: per key typed, per layout switch. */
  commitsPerKey: 3,
  commitsLayout: 10,
  /** Main-thread script time while a render plays for two seconds. */
  playScript: 300,
};

requireChrome(LABEL);
const store = tmpdir('vr-perf-e2e-store-');
const made = spawnSync(process.execPath, [path.join(ROOT, 'bench/perf/synth.ts'), store, '300', '3000'], { encoding: 'utf8' });
if (made.status !== 0) throw new Error(`synth.ts failed: ${made.stderr}`);
const srv = await startServer({
  prefix: 'vr-perf-e2e-',
  user: 'Sam',
  config: { browse_root: store },
  env: { VR_DATA: path.join(store, 'data'), VR_CACHE: path.join(store, 'cache'), VR_CONFIG: path.join(store, 'config.json') },
});
const BASE = srv.base;
const CARD = '[data-testid=library-content] .film[data-slug]';

let browser;
try {
  const lib = await (await fetch(`${BASE}/api/library`)).json();
  const other = lib.videos[1].slug;
  browser = await launch();
  const fresh = async () => {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluateOnNewDocument(instrument);
    await watchFromStart(page, 'library', CARD);
    const net = await recordNetwork(page);
    await throttle(page, CPU);
    return { ctx, page, net };
  };
  const best = async (tries, fn) => {
    let min = Number.POSITIVE_INFINITY;
    for (let i = 0; i < tries; i++) min = Math.min(min, await fn(i));
    return min;
  };
  // `shown`: called as soon as the cards are on screen (before the network is idle).
  const load = async ({ page, net }, shown) => {
    await page.goto('about:blank');
    net.take();
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__perf?.seen.library, { timeout: 60000 });
    shown?.();
    await net.idle(600);
    return { shown: await seen(page, 'library'), reqs: net.take() };
  };
  // Answers of the server held back for a while: what the page shows meanwhile didn't wait for them.
  const hold = async (page, pattern, ms) => {
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      const held = pattern.test(new URL(r.url()).pathname);
      setTimeout(() => r.continue().catch(() => {}), held ? ms : 0);
    });
  };

  // Answers held back until `release()` (or for `ms` at most once the first is asked for): until a state, not for a
  // time. `by()` says which let them go: the state ('release') or the time ('time').
  const holdUntil = async (page, pattern, ms) => {
    const held = [];
    let by = null;
    let timer = null;
    const free = (why) => {
      by ??= why;
      clearTimeout(timer);
      for (const r of held.splice(0)) r.continue().catch(() => {});
    };
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      if (by || !pattern.test(new URL(r.url()).pathname)) return void r.continue().catch(() => {});
      held.push(r);
      timer ??= setTimeout(() => free('time'), ms);
    });
    return { release: () => free('release'), by: () => by };
  };

  await check('the first paint asks the API one round trip deep (two on a first visit)', async () => {
    const f = await fresh();
    const first = await load(f);
    const doc = first.reqs.find((r) => r.type === 'Document');
    const cold = apiWaterfall(first.reqs, doc ? doc.start + first.shown : undefined);
    console.log(`      first visit: ${cold.calls.join(' ')}`);
    assert(cold.depth <= 2, `first visit: ${cold.depth} round trips before the cards (${cold.calls.join(' ')})`);
    // Next visit: who is signed in is held back until the cards are on screen (10 s at most); neither the library's data
    // nor the cards may wait for that answer. Held until the cards show, not for a fixed time: a busy runner paints late,
    // and a hold shorter than its first paint failed it (CI: cards at 6.2 s behind 1.5 s); cards that need the answer
    // still come only after it.
    await sleep(1000);
    const whoHeld = await holdUntil(f.page, /^\/api\/auth\/status$/, 10_000);
    const again = await load(f, whoHeld.release);
    const auth = again.reqs.find((r) => /\/api\/auth\/status$/.test(r.url));
    const library = again.reqs.find((r) => isApi(r) && /\/api\/library$/.test(new URL(r.url).pathname));
    assert(auth && library, 'both asked for');
    const doc2 = again.reqs.find((r) => r.type === 'Document');
    console.log(
      `      next visit: library asked at ${(library.start - doc2.start).toFixed(0)} ms, auth answered at ${(auth.end - doc2.start).toFixed(0)} ms, cards at ${again.shown.toFixed(0)} ms`,
    );
    assert(library.start < auth.end, 'the library waited for /api/auth/status');
    assert(whoHeld.by() === 'release', 'the cards waited for /api/auth/status');
    await f.ctx.close();
  });

  await check(`the library paints what the browser kept before the server answers (≤ ${BUDGET.warmPaint} ms)`, async () => {
    const f = await fresh();
    await load(f);
    await sleep(1500);
    // Every API answer held back 2.5 s: the cards can only come from what the browser kept.
    await hold(f.page, /^\/api\//, 2500);
    const ms = await best(3, async () => (await load(f)).shown);
    console.log(`      cards at ${ms.toFixed(0)} ms (CPU ${CPU}×), the server's answers held back 2.5 s`);
    within(ms, BUDGET.warmPaint, `cards at ${ms.toFixed(0)} ms, budget ${BUDGET.warmPaint} ms`);
    await f.ctx.close();
  });

  const f = await fresh();
  const { page, net } = f;
  await load(f);

  await check(`typing in the filter answers within ${BUDGET.typing} ms, ≤ ${BUDGET.commitsPerKey} commits a key`, async () => {
    let perKey = 0;
    const ms = await best(3, async () => {
      await page.keyboard.press('Escape');
      await sleep(400);
      const t0 = await now(page);
      const c0 = await commits(page);
      await page.keyboard.press('/');
      for (const k of 'logo') {
        await page.keyboard.type(k);
        await sleep(150);
      }
      await sleep(600);
      perKey = Math.max(perKey, ((await commits(page)) - c0) / 4);
      return slowest(page, t0);
    });
    await page.keyboard.press('Escape');
    console.log(`      slowest key ${ms.toFixed(0)} ms, ${perKey.toFixed(1)} commits a key`);
    within(ms, BUDGET.typing, `slowest key ${ms.toFixed(0)} ms, budget ${BUDGET.typing} ms`);
    assert(perKey <= BUDGET.commitsPerKey, `${perKey} commits a key, budget ${BUDGET.commitsPerKey}`);
  });

  await check(`switching the layout answers within ${BUDGET.layout} ms, ≤ ${BUDGET.commitsLayout} commits`, async () => {
    let most = 0;
    const ms = await best(3, async () => {
      let worst = 0;
      for (const [to, ready] of [
        ['List', '[data-testid=library-list] .lrow[data-slug]'],
        ['Grid', CARD],
      ]) {
        await sleep(400);
        const t0 = await now(page);
        const c0 = await commits(page);
        await page.click(`[aria-label="Layout"] [aria-label="${to}"]`);
        await page.waitForSelector(ready);
        await sleep(600);
        most = Math.max(most, (await commits(page)) - c0);
        worst = Math.max(worst, await slowest(page, t0));
      }
      return worst;
    });
    console.log(`      slowest switch ${ms.toFixed(0)} ms, at most ${most} commits`);
    within(ms, BUDGET.layout, `slowest switch ${ms.toFixed(0)} ms, budget ${BUDGET.layout} ms`);
    assert(most <= BUDGET.commitsLayout, `${most} commits, budget ${BUDGET.commitsLayout}`);
  });

  await check('a note added elsewhere costs an open library a few small requests', async () => {
    await sleep(800);
    net.take();
    await fetch(`${BASE}/api/review/${encodeURIComponent(other)}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frame: 5, text: 'A note from elsewhere', severity: 'should' }),
    });
    await sleep(2500);
    const api = net.take().filter(isApi);
    const bytes = api.reduce((s, r) => s + (r.bytes || 0), 0);
    console.log(
      `      ${api.length} requests, ${(bytes / 1024).toFixed(1)} KB: ${api.map((r) => new URL(r.url).pathname.split('/').slice(0, 3).join('/')).join(' ')}`,
    );
    assert(!api.some((r) => /\/api\/library$/.test(new URL(r.url).pathname) && !new URL(r.url).search), 'the whole library was fetched again');
    assert(api.length <= 6 && bytes < 64 * 1024, `${api.length} requests, ${bytes} bytes`);
  });

  await check(`a hovered video opens with its notes within ${BUDGET.openNotes} ms and its first frame within ${BUDGET.openFrame} ms`, async () => {
    const times = [];
    for (const i of [2, 3, 4]) {
      const card = (await page.$$(CARD))[i];
      const slug = await card.evaluate((e) => e.dataset.slug);
      await card.hover();
      await sleep(1200); // the review, then (after a moment on the card) the render's first bytes
      await watchFor(page, `notes-${slug}`, '.note');
      await watchFrame(page, `frame-${slug}`);
      const t0 = await now(page);
      await card.click();
      await page.waitForFunction((s) => window.__perf.seen[`frame-${s}`] && window.__perf.seen[`notes-${s}`], { timeout: 20000 }, slug);
      times.push([(await seen(page, `notes-${slug}`)) - t0, (await seen(page, `frame-${slug}`)) - t0]);
      await page.goBack();
      await page.waitForSelector(CARD);
      await sleep(800);
    }
    const notes = Math.min(...times.map((x) => x[0]));
    const frame = Math.min(...times.map((x) => x[1]));
    console.log(`      notes at ${notes.toFixed(0)} ms, first frame at ${frame.toFixed(0)} ms`);
    within(notes, BUDGET.openNotes, `notes at ${notes.toFixed(0)} ms, budget ${BUDGET.openNotes} ms`);
    within(frame, BUDGET.openFrame, `first frame at ${frame.toFixed(0)} ms, budget ${BUDGET.openFrame} ms`);
  });

  await check(`playing a render costs ≤ ${BUDGET.playScript} ms of script in two seconds (the player doesn't render per frame)`, async () => {
    const cdp = await page.createCDPSession();
    await cdp.send('Performance.enable');
    const script = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'ScriptDuration').value * 1000;
    await page.goto(`${BASE}/#/v/${encodeURIComponent(other)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.note');
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2, { timeout: 20000 });
    await sleep(1000);
    const ms = await best(3, async () => {
      await page.evaluate(() => document.activeElement?.blur());
      const s0 = await script();
      await page.keyboard.press(' ');
      await sleep(2000);
      await page.keyboard.press(' ');
      const used = (await script()) - s0;
      await page.keyboard.press('Home');
      await sleep(500);
      return used;
    });
    console.log(`      ${ms.toFixed(0)} ms of script in 2 s of playback (CPU ${CPU}×)`);
    within(ms, BUDGET.playScript, `${ms.toFixed(0)} ms, budget ${BUDGET.playScript} ms`);
  });

  await check('a video with hundreds of notes renders the ones near the view, the others as the list scrolls', async () => {
    const many = lib.videos[5].slug;
    for (let i = 0; i < 300; i++)
      await fetch(`${BASE}/api/review/${encodeURIComponent(many)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frame: 1 + (i % 20), text: `Long list ${i}`, severity: 'should' }),
      });
    await page.goto(`${BASE}/#/v/${encodeURIComponent(many)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.note-rows .note', { timeout: 20000 });
    await sleep(1500);
    const rendered = () => page.$$eval('.side-scroll .note', (els) => els.map((e) => e.getAttribute('aria-label')));
    const first = await rendered();
    await page.$eval('.side-scroll', (el) => el.scrollTo(0, el.scrollHeight));
    await sleep(800);
    const last = await rendered();
    const height = await page.$eval('.side-scroll', (el) => el.scrollHeight);
    console.log(`      ${first.length} of 300+ notes rendered at the top, ${last.length} at the end of a ${height} px list`);
    assert(first.length < 100 && last.length < 100, `${first.length} / ${last.length} notes rendered`);
    // a row each (~30 px): the spacers stand for the rows not rendered
    assert(height > 300 * 28, `the list keeps its height: ${height} px`);
    assert(JSON.stringify(first) !== JSON.stringify(last), 'scrolling to the end renders other notes');
  });
} catch (e) {
  crashed(e, srv);
} finally {
  await finish(LABEL, { browser, servers: [srv], dirs: [store] });
}
