#!/usr/bin/env node
// covers: web/src/library/Library.tsx web/src/library/Toolbar.tsx web/src/files/FilesPage.tsx web/src/files/api.ts
// covers: web/src/playbook/PlaybookShell.tsx web/src/playbook/PlaybookPage.tsx web/src/api/playbooks.ts
// covers: web/src/styles/library.css web/src/styles/files.css web/src/styles/playbook.css web/src/styles/mobile.css
// A folder's tabs — Videos · Files · Playbook — are one page with three bodies (browser end to end): switching between
// them moves nothing. In a browser that kept nothing, with the Files and Playbook answers held back until each tab's
// loading state has been drawn, every frame of a round trip is measured: the tabs stay put, every tab's first row (the
// Videos toolbar, the Files toolbar, the playbook's line) stands at the same place and is as tall, every tab's content
// starts at the same edge (the first section of videos, the list's heading or the empty state, the document), no frame
// lacks the first row or draws it faded, and no layout shift is recorded. A project with videos, files and a playbook,
// and one with videos only (empty Files and Playbook), at 1440, 1024, a tablet (768, touch) and a phone (390).
import path from 'node:path';
import { age, makeVideo } from '../lib/helpers.ts';
import { settle } from './layout.mjs';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, requireDist, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { push } from './lib/filesStore.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'folder tabs e2e';
requireChrome(LABEL);
requireDist(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-folder-tabs-e2e-', user: 'Sam' });
const { dir, base: BASE } = srv;
const api = jsonApi(BASE);
const enc = encodeURIComponent;

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1 };
const LAPTOP = { width: 1024, height: 768, deviceScaleFactor: 1 };
const TABLET = { width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

// Every frame while it is on: where the tabs are, the shown tab's first row (top, height) and its content's top edge,
// and how opaque the first row is drawn; and every layout shift (those right after a click too).
function sampler() {
  const T = { on: false, frames: [], shifts: [] };
  window.__tabs = T;
  new PerformanceObserver((l) => {
    if (!T.on) return;
    for (const e of l.getEntries())
      T.shifts.push({
        value: e.value,
        what: (e.sources || []).map(
          (s) =>
            `${s.node?.tagName?.toLowerCase() ?? '?'}.${String(s.node?.className ?? '').split(' ')[0]} y ${Math.round(s.previousRect.y)}→${Math.round(s.currentRect.y)}`,
        ),
      });
  }).observe({ type: 'layout-shift', buffered: false });
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    for (let p = el; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
    }
    return true;
  };
  const opacity = (el) => {
    let o = 1;
    for (let p = el; p; p = p.parentElement) o *= Number(getComputedStyle(p).opacity);
    return o;
  };
  // A tab marks its first row and its content (data-tab-row, data-tab-body); a page without the marks is measured by
  // its own parts: the Videos toolbar and content, the playbook's line and document, the Files page's first row and its
  // list or empty state (the first of them on screen, in the page's order, is the top one)
  const ROW = 'main [data-tab-row], main .lib-toolbar, main .pb-meta, main [data-testid=files] .pf-main > :first-child';
  const BODY = 'main [data-tab-body], main .lib-content, main .pb-layout, main [data-testid=files] :is(.pf-shead, .pf-list, [data-testid=files-empty])';
  const tick = () => {
    if (T.on) {
      const tabs = document.querySelector('.hero .hero-tabs');
      const row = [...document.querySelectorAll(ROW)].find(shown);
      const body = [...document.querySelectorAll(BODY)].find(shown);
      const box = (el) => el?.getBoundingClientRect();
      T.frames.push({
        tab: location.hash.split('/')[1],
        tabs: tabs ? Math.round(box(tabs).top) : null,
        row: row ? Math.round(box(row).top) : null,
        rowH: row ? Math.round(box(row).height) : null,
        body: body ? Math.round(box(body).top) : null,
        opacity: row ? Math.round(opacity(row) * 100) / 100 : null,
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** One round trip through a folder's tabs at one size; returns what moved (empty when nothing did). */
async function roundTrip(browser, folder, vp) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  try {
    if (vp.isMobile) await page.emulate({ viewport: vp, userAgent: IPHONE });
    else await page.setViewport(vp);
    await page.evaluateOnNewDocument(sampler);
    // The tabs' answers wait until the test lets them through: each tab is first drawn loading, as on a slow connection
    // or before the page asked for them (it asks once it has painted)
    const held = { files: true, playbook: true };
    const waiting = { files: [], playbook: [] };
    await page.setBypassServiceWorker(true);
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const p = new URL(req.url()).pathname;
      const k = req.method() !== 'GET' ? null : /^\/api\/files\b/.test(p) ? 'files' : /^\/api\/playbook\b/.test(p) ? 'playbook' : null;
      if (k && held[k]) waiting[k].push(req);
      else req.continue().catch(() => {});
    });
    const release = (k) => {
      held[k] = false;
      for (const r of waiting[k].splice(0)) r.continue().catch(() => {});
    };
    const frames = (n) =>
      page.evaluate(
        (n) =>
          new Promise((r) =>
            (function f(i) {
              i ? requestAnimationFrame(() => f(i - 1)) : r();
            })(n),
          ),
        n,
      );
    const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `folder-tabs-${folder.toLowerCase()}-${vp.width}-${name}.png`) });
    const to = async (tab, ready) => {
      await page.click(`[data-testid=folder-tab-${tab}]`);
      await page.waitForSelector(ready, { timeout: 20_000 });
    };

    await page.goto(`${BASE}/#/folder/${enc(folder)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.film', { timeout: 20_000 });
    await settle(page, { quiet: 500 });
    await page.evaluate(() => {
      window.__tabs.on = true;
    });
    await frames(4);
    await shot('videos');
    // Files: drawn loading, then its answer
    await to('files', '[data-testid=files] .pf-row.pending');
    await frames(8);
    await shot('files-loading');
    release('files');
    await page.waitForSelector('[data-testid=files][aria-busy=false]', { timeout: 20_000 });
    await settle(page, { quiet: 400 });
    await shot('files');
    // Playbook: the same
    await to('playbook', '[data-testid=playbook][aria-busy=true]');
    await frames(8);
    await shot('playbook-loading');
    release('playbook');
    await page.waitForSelector('[data-testid=playbook][aria-busy=false]', { timeout: 20_000 });
    await settle(page, { quiet: 400 });
    await shot('playbook');
    // and round again, everything here now
    for (const [tab, ready] of [
      ['videos', '.film'],
      ['files', '[data-testid=files][aria-busy=false]'],
      ['playbook', '[data-testid=playbook][aria-busy=false]'],
      ['videos', '.film'],
    ]) {
      await to(tab, ready);
      await settle(page, { quiet: 300 });
    }
    const { frames: seen, shifts } = await page.evaluate(() => window.__tabs);

    const out = [];
    const where = (k) => {
      const by = new Map();
      for (const f of seen) if (f[k] !== null) by.set(f.tab, [...new Set([...(by.get(f.tab) ?? []), f[k]])]);
      return [...by].map(([t, v]) => `${t} ${v.join('→')}`).join(', ');
    };
    for (const [k, what] of [
      ['tabs', 'the tabs'],
      ['row', 'the first row’s top'],
      ['rowH', 'the first row’s height'],
      ['body', 'the content’s top edge'],
    ]) {
      const all = seen.map((f) => f[k]).filter((v) => v !== null);
      if (Math.max(...all) - Math.min(...all) > 1) out.push(`${what} moves (${where(k)})`);
    }
    const blank = seen.filter((f) => f.row === null);
    if (blank.length) out.push(`${blank.length} of ${seen.length} frames have no first row (${[...new Set(blank.map((f) => f.tab))].join(', ')})`);
    const faded = seen.filter((f) => f.opacity !== null && f.opacity < 0.99);
    if (faded.length)
      out.push(`${faded.length} frames draw the first row faded (${[...new Set(faded.map((f) => `${f.tab} ${f.opacity}`))].slice(0, 4).join(', ')})`);
    const shift = shifts.reduce((s, x) => s + x.value, 0);
    if (shift >= 0.01)
      out.push(
        `layout shift ${shift.toFixed(3)} (${shifts
          .flatMap((x) => x.what)
          .slice(0, 3)
          .join('; ')})`,
      );
    console.log(`      ${folder} @${vp.width}: ${seen.length} frames · first row ${where('row')} · content ${where('body')} · shift ${shift.toFixed(4)}`);
    return out;
  } finally {
    await ctx.close();
  }
}

let browser;
try {
  // Acme: videos, files (a folder of brand files, a brief) and a playbook with a brief and rules; Launch: videos only
  let i = 0;
  for (const [folder, name] of [
    ['Acme', 'spot'],
    ['Acme', 'reel'],
    ['Launch', 'film'],
    ['Launch', 'cutdown'],
  ]) {
    const file = makeVideo(path.join(dir, `${folder}/${name}/export/${name}.mp4`), { dur: 1, pattern: i++ % 2 ? 'smptebars' : 'testsrc2' });
    age(file);
    await api('/api/library', 'POST', { path: file, folder });
  }
  await push(BASE, 'Acme', {
    'Brand/Logo primary.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    'Brand/Acme Sans.otf': Buffer.alloc(4096, 7),
    'Brief v3.txt': Buffer.from('Spring sale, 30 s and 15 s cuts.\n'),
  });
  await api('/api/playbook/text', 'PUT', { folder: 'Acme', section: 'brief', content: 'Calm, warm product films. No whooshes.' });
  await api('/api/playbook/text', 'PUT', { folder: 'Acme', section: 'rules', content: '- Logo at most 12 % of the frame width\n- End card holds 2 s' });

  browser = await launch();
  for (const [folder, sizes] of [
    ['Acme', [DESKTOP, LAPTOP, TABLET, PHONE]],
    ['Launch', [DESKTOP, PHONE]],
  ]) {
    for (const vp of sizes) {
      await check(`${folder} @${vp.width}: switching Videos · Files · Playbook moves neither the first row nor the content, loading or loaded`, async () => {
        const moved = await roundTrip(browser, folder, vp);
        assert(!moved.length, moved.join('\n        '));
      });
    }
  }
} catch (e) {
  crashed(e, srv);
} finally {
  await finish(LABEL, { browser, servers: [srv] });
}
