// What a person feels, on a store made by synth.ts, in the production build with Chrome's CPU slowed down 4×:
// requests and bytes of a cold and a warm load of the library and the player, when their content shows, how many
// React commits each interaction costs and how long its slowest input took to paint, and what one note added by
// someone else costs a tab that has the library open (the event stream's refetches).
//
//   npm run build && node bench/perf/browser.mjs <synth dir> [cpu=4]
//
// The server uses the synth store in place (it adds a few notes: run it on a copy), on a free port.
import path from 'node:path';
import { launch, requireChrome } from '../../test/e2e/lib/browser.mjs';
import {
  apiWaterfall,
  commits,
  instrument,
  now,
  recordNetwork,
  seen,
  slowest,
  summarize,
  throttle,
  watchFor,
  watchFrame,
  watchFrameFromStart,
  watchFromStart,
} from '../../test/e2e/lib/perf.mjs';
import { startServer } from '../../test/e2e/lib/server.mjs';
import { sleep } from '../../test/lib/helpers.ts';

const [dirArg, cpuArg = '4'] = process.argv.slice(2);
if (!dirArg) {
  console.error('usage: node bench/perf/browser.mjs <synth dir> [cpu slowdown]');
  process.exit(2);
}
const dir = path.resolve(dirArg);
const CPU = Number(cpuArg);
requireChrome('perf bench');
const srv = await startServer({
  prefix: 'vr-perf-bench-',
  user: 'Sam',
  config: { browse_root: dir },
  env: { LAMPO_DATA: path.join(dir, 'data'), LAMPO_CACHE: path.join(dir, 'cache'), LAMPO_CONFIG: path.join(dir, 'config.json') },
});
const BASE = srv.base;
const lib = await (await fetch(`${BASE}/api/library`)).json();
// A video with fixed notes (so "verify" has something to press), from the middle of the list.
const slug = lib.videos[Math.floor(lib.videos.length / 2)].slug;
const other = lib.videos[3].slug;
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const line = (s) =>
  `${s.n} requests, ${kb(s.bytes)} · ${Object.entries(s.kinds)
    .map(([k, v]) => `${k} ${v.n}${v.cached ? ` (${v.cached} cached)` : ''} ${kb(v.bytes)}`)
    .join(', ')}`;
const out = [];
const log = (s) => {
  out.push(s);
  console.log(s);
};

const browser = await launch();
try {
  const fresh = async () => {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluateOnNewDocument(instrument);
    await watchFromStart(page, 'library', '[data-testid=library-content] .film[data-slug], [data-testid=library-content] .lrow[data-slug]');
    await watchFromStart(page, 'player', '.note');
    await watchFrameFromStart(page, 'frame');
    const net = await recordNetwork(page);
    await throttle(page, CPU);
    return { ctx, page, net };
  };
  // A new document every time (a hash change alone would stay in the same one).
  const load = async ({ page, net }, label, url, landmark) => {
    await page.goto('about:blank');
    net.take();
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((n) => window.__perf?.seen[n], { timeout: 60000 }, landmark);
    await net.idle(800);
    const reqs = net.take();
    const shown = await seen(page, landmark);
    const doc = reqs.find((r) => r.type === 'Document');
    const w = apiWaterfall(reqs, doc ? doc.start + shown : undefined);
    const frame = landmark === 'player' ? await seen(page, 'frame') : null;
    const marks = await page.evaluate(() =>
      performance
        .getEntriesByType('mark')
        .filter((m) => m.name.startsWith('vr:'))
        .map((m) => `${m.name.slice(3)} ${m.startTime.toFixed(0)}`)
        .join(', '),
    );
    log(
      `${label}: content at ${shown.toFixed(0)} ms${frame ? ` · first frame at ${frame.toFixed(0)} ms` : ''}${marks ? ` (${marks})` : ''} · ${line(summarize(reqs))} · API calls before content: ${w.calls.join(' ')} (${w.depth} deep)`,
    );
  };

  log(`\n## loads (CPU ${CPU}×)`);
  for (const [name, url, landmark] of [
    ['library', '/#/', 'library'],
    ['player', `/#/v/${encodeURIComponent(slug)}`, 'player'],
  ]) {
    const f = await fresh();
    await load(f, `${name} cold`, url, landmark);
    await load(f, `${name} warm`, url, landmark);
    await f.ctx.close();
  }

  const { page, net } = await fresh();
  // Interactions: commits and the slowest input each costs.
  log(`\n## interactions (CPU ${CPU}×)`);
  const cdp = await page.createCDPSession();
  await cdp.send('Performance.enable');
  const cpu = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const get = (n) => metrics.find((m) => m.name === n)?.value ?? 0;
    return { script: get('ScriptDuration') * 1000, task: get('TaskDuration') * 1000 };
  };
  const measure = async (label, fn, settle = 1200) => {
    const m0 = await cpu();
    const c0 = await commits(page);
    const t0 = await now(page);
    net.take();
    await fn();
    await sleep(settle);
    const c1 = await commits(page);
    const m1 = await cpu();
    const worst = await slowest(page, t0);
    const reqs = net.take();
    const paths = reqs.map((r) => `${r.method === 'GET' ? '' : `${r.method} `}${new URL(r.url).pathname.split('/').slice(0, 3).join('/')}`);
    log(
      `${label}: ${c1 - c0} commits · script ${(m1.script - m0.script).toFixed(0)} ms, main thread ${(m1.task - m0.task).toFixed(0)} ms · slowest input ${worst.toFixed(0)} ms · ${reqs.length} requests${paths.length ? ` (${paths.join(' ')})` : ''}`,
    );
  };
  await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid=library-content] .film[data-slug]', { timeout: 60000 });
  await net.idle(800);
  await measure('switch layout to list', async () => {
    await page.click('[aria-label="Layout"] [aria-label="List"]');
    await page.waitForSelector('[data-testid=library-list] .lrow');
  });
  await measure('switch layout to grid', async () => {
    await page.click('[aria-label="Layout"] [aria-label="Grid"]');
    await page.waitForSelector('[data-testid=library-content] .film');
  });
  await measure('filter by a lane chip', async () => {
    await page.evaluate(() => [...document.querySelectorAll('.seg.chips button')].find((b) => b.textContent.startsWith('Needs you'))?.click());
  });
  await measure('back to all', async () => {
    await page.evaluate(() => [...document.querySelectorAll('.seg.chips button')].find((b) => b.textContent.startsWith('All'))?.click());
  });
  await measure('type "logo" in the filter (4 keys)', async () => {
    await page.keyboard.press('/');
    for (const k of 'logo') {
      await page.keyboard.type(k);
      await sleep(120);
    }
  });
  await measure('clear the filter', () => page.keyboard.press('Escape'));
  await measure(
    'hover a card (prefetch)',
    async () => {
      const card = await page.$('.film');
      if (card) await card.hover();
    },
    800,
  );

  // Someone else adds a note to another video: what does this tab do?
  net.take();
  await fetch(`${BASE}/api/review/${encodeURIComponent(other)}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ frame: 5, text: 'A note from elsewhere', severity: 'should' }),
  });
  await sleep(2500);
  log(`a note added elsewhere, library open: ${line(summarize(net.take().filter((r) => /\/api\//.test(r.url))))}`);

  const c0 = await commits(page);
  await watchFor(page, 'opened', '.note');
  await watchFrame(page, 'openedFrame');
  const t0 = await now(page);
  await page.evaluate((s) => {
    location.hash = `#/v/${encodeURIComponent(s)}`;
  }, slug);
  await page.waitForFunction(() => window.__perf.seen.opened, { timeout: 60000 });
  const opened = (await seen(page, 'opened')) - t0;
  await sleep(1200);
  const framed = await seen(page, 'openedFrame');
  log(
    `open a video from the library: notes at ${opened.toFixed(0)} ms${framed ? ` · first frame at ${(framed - t0).toFixed(0)} ms` : ''} · ${(await commits(page)) - c0} commits`,
  );

  await measure('select a note', async () => {
    const notes = await page.$$('.note');
    await notes[Math.min(3, notes.length - 1)].click();
  });
  await measure(
    'verify a fixed note',
    async () => {
      const ok = await page.$('.note .btn.ok');
      if (ok) await ok.click();
    },
    2000,
  );
  await measure('step 10 frames (→ ×10)', async () => {
    await page.evaluate(() => document.activeElement?.blur());
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('ArrowRight');
      await sleep(60);
    }
  });
  await measure('scrub the timeline (20 moves)', async () => {
    const box = await (await page.$('.timeline canvas')).boundingBox();
    const y = box.y + Math.min(box.height - 4, 10);
    await page.mouse.move(box.x + box.width * 0.1, y);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) await page.mouse.move(box.x + box.width * (0.1 + (0.8 * i) / 20), y);
    await page.mouse.up();
  });
  await measure('play 2 s', async () => {
    await page.keyboard.press(' ');
    await sleep(2000);
    await page.keyboard.press(' ');
  });

  net.take();
  await fetch(`${BASE}/api/review/${encodeURIComponent(other)}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ frame: 6, text: 'Another note from elsewhere', severity: 'should' }),
  });
  await sleep(2500);
  log(`a note added to another video, player open: ${line(summarize(net.take().filter((r) => /\/api\//.test(r.url))))}`);
} finally {
  await browser.close().catch(() => {});
  await srv.stop();
}
