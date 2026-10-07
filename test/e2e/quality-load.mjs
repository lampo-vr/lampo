#!/usr/bin/env node
// covers: web/src/api/ web/src/lib/ web/src/library/ web/src/player/ web/src/inbox/ web/src/settings/
// covers: web/src/sessions/ web/src/styleguide/ web/src/styles/
// How the main screens load (lib/qualityScreens.mjs, the screens quality.mjs's rules check): the start's JavaScript
// within its budget; no layout shift after the first paint on the library and the player; every loading state uses the
// real layout, so nothing moves from skeleton to content. Each rule says what broke it.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT, sleep } from '../lib/helpers.ts';
import { settle } from './layout.mjs';
import { requireChrome } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { qualityScreens, qualityServers } from './lib/qualityScreens.mjs';
import { startServer } from './lib/server.mjs';

// All JavaScript a page load runs before the app shows, gzipped (each file on its own, as it travels): the entry, the
// app chunk it imports first (boot) and everything those import statically, and the library's chunk with its static
// imports — boot.tsx waits for the route's screen before the first render, and the library is where the app opens.
// The German words (their own chunk, only for German) and the other screens don't count. Measured this way (without
// the library) the app was 145.2 KB before the German UI and 150.9 KB with it; the budget was that + 10 %. Raised to
// 169 KB for the local-first start (2026-09-29): reading the kept data and asking for the screen's data alongside who
// is signed in must run before the first paint (~2 KB; what writes the kept data and patches live events loads right
// after the start). Lowered to 126 KB when Radix left the start (2026-09-29: 166.1 → 123.5 KB; the Radix half of the
// primitives, ui/layers.tsx, loads after the first paint, the empty-state drawings with their first use). 183 KB since
// it counts the library too (2026-09-30): the start 125.1 KB + the library 56.7 KB, once the switch, avatar and scroll
// area it renders stopped pulling in Radix (ui/plain.tsx; the library was 72.8 KB with them). Raise it deliberately
// (and say why in the commit), never by accident.
const BUNDLE_BUDGET_KB = 183;

const LABEL = 'quality-load e2e';
requireChrome(LABEL);
const q = await qualityServers('quality-load');
// a library with nothing in it yet (its first visit draws neither a sidebar nor cards)
const empty = await startServer({ prefix: 'vr-quality-load-empty-e2e-', user: 'Sam' });
q.servers.push(empty);

try {
  const { SCREENS, ready, PHONE, DESKTOP, IPHONE, open, relaunch, again } = await qualityScreens(q);
  const { BASE } = q;

  await check('startup JavaScript (the start and the library) stays within its budget', async () => {
    const html = fs.readFileSync(path.join(ROOT, 'web/dist/index.html'), 'utf8');
    const entry = /<script[^>]+type="module"[^>]+src="\/?(assets\/[^"]+\.js)"/.exec(html)?.[1];
    assert(entry, 'no entry script in web/dist/index.html');
    const read = (file) => fs.readFileSync(path.join(ROOT, 'web/dist', file), 'utf8');
    const startup = new Set();
    const follow = (file) => {
      if (startup.has(file)) return;
      startup.add(file);
      for (const m of read(file).matchAll(/(?:from|import)\s*["`]\.\/([\w.-]+\.js)["`]/g)) follow(`assets/${m[1]}`);
    };
    follow(entry);
    // The entry loads the language, then the app: its dynamic imports other than the German words run at every start.
    const dynamic = (file) => [...read(file).matchAll(/import\(\s*["`]\.\/([\w.-]+\.js)["`]\s*\)/g)].map((m) => m[1]);
    for (const f of dynamic(entry)) if (!f.startsWith('de-')) follow(`assets/${f}`);
    const gz = (files) => files.reduce((sum, f) => sum + zlib.gzipSync(fs.readFileSync(path.join(ROOT, 'web/dist', f)), { level: 9 }).length / 1024, 0);
    const start = [...startup];
    // The screen the first render waits for (boot.tsx preloadScreen): the library, where the app opens.
    const screen = [...new Set(start.flatMap(dynamic))].find((f) => /^Library-[\w-]+\.js$/.test(f));
    assert(screen, 'no Library chunk imported by the start');
    follow(`assets/${screen}`);
    const library = [...startup].filter((f) => !start.includes(f));
    const kb = gz(start) + gz(library);
    console.log(`      start ${start.join(' + ')}: ${gz(start).toFixed(1)} KB`);
    console.log(`      library ${library.join(' + ')}: ${gz(library).toFixed(1)} KB`);
    console.log(`      ${kb.toFixed(1)} KB gzipped (budget ${BUNDLE_BUDGET_KB} KB)`);
    assert(
      kb <= BUNDLE_BUDGET_KB,
      `the start and the library's first paint load ${kb.toFixed(1)} KB of JavaScript gzipped (start ${gz(start).toFixed(1)} + library ${gz(library).toFixed(1)}), over the ${BUNDLE_BUDGET_KB} KB budget: lazy-load the new code (see the palette; never import radix-ui where the first paint needs it: web/README.md "UI primitives") or raise the budget on purpose`,
    );
  });

  await check('no layout shift after the first paint: library and player', async () => {
    const watch = () => {
      window.__shift = 0;
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) if (!e.hadRecentInput) window.__shift += e.value;
      }).observe({ type: 'layout-shift', buffered: true });
    };
    for (const screen of ['library', 'player', 'get started']) {
      for (const vp of [DESKTOP, PHONE]) {
        const shift = await again(async () => {
          // Before /api/auth/status answers, Get started's room comes from what this browser saw last time
          // (lib/chromeHint.ts: "wrong at worst once"). A browser's very first visit paints without it whenever the
          // status is slower than the first paint, which only the machine's load decides: measured from the visit after.
          if (screen === 'get started') await (await open(screen, vp)).close();
          const page = await open(screen, vp, watch);
          // Every shift until the page has been still for 1.5 s: what arrives late on a busy machine counts too.
          await settle(page, { quiet: 1500, max: 20_000 });
          const shift = await page.evaluate(() => window.__shift);
          await page.close();
          return shift;
        });
        assert(shift < 0.02, `${screen} @${vp.width}: layout shift ${shift.toFixed(3)} (skeletons must match what replaces them)`);
      }
    }
  });

  // Shifts that follow a click are left out of the score above (they "had recent input"), yet Get started's steps are
  // clicked through while the library waits under the card: nothing outside the card may move when a step opens.
  await check('no layout shift while Get started is used: opening each of its steps moves nothing under it', async () => {
    const out = [];
    for (const vp of [DESKTOP, PHONE]) {
      const moved = await again(async () => {
        const page = await open('get started', vp, () => {
          window.__moved = [];
          new PerformanceObserver((l) => {
            for (const e of l.getEntries())
              for (const s of e.sources || []) {
                const n = s.node;
                if (!n || n.closest?.('[data-testid=ob-gs]') || document.querySelector('[data-testid=ob-gs]')?.contains(n)) continue;
                window.__moved.push(
                  `${n.tagName?.toLowerCase() ?? '?'}.${String(n.className || '').split(' ')[0]} y ${Math.round(s.previousRect.y)}→${Math.round(s.currentRect.y)}`,
                );
              }
          }).observe({ type: 'layout-shift', buffered: false });
        });
        await page.evaluate(() => (window.__moved = []));
        const ids = await page.$$eval('.ob-gs-list [data-testid=ob-step]', (els) => els.map((e) => e.dataset.step));
        for (const id of [...ids.slice(1), ids[0]]) {
          await page.click(`.ob-gs-list [data-testid=ob-step][data-step=${id}]`);
          await settle(page, { quiet: 300 });
        }
        const m = await page.evaluate(() => window.__moved);
        await page.close();
        return m;
      });
      if (moved.length) out.push(`@${vp.width}: ${moved.slice(0, 4).join('; ')}`);
    }
    assert(!out.length, `under Get started, moved by a step's click:\n        ${out.join('\n        ')}`);
  });

  // A skeleton that is replaced wholesale never counts as a layout shift, yet the eye sees everything jump when its
  // shapes don't match what arrives. So: hold back every API answer, sample the page while it loads, and compare the
  // boxes of its landmarks (top bar, sidebar, title, toolbar, the first card, the player's stage and dock, …) with the
  // loaded page. `every`: the landmark must already be there in every loading sample (the chrome, and whatever the
  // route alone decides); the others are compared whenever a sample has them. `pos`: its height follows the data, so
  // only where it starts and how wide it is are compared. `wide`: compared on the desktop only.
  await check('loading states use the real layout: nothing moves from skeleton to content', async () => {
    const HOLD = 700;
    const top = [
      { name: 'brand', sel: '.topbar .brand', every: true },
      { name: 'search', sel: '.topbar [data-testid=palette-button]', every: true },
      { name: 'bell', sel: '.topbar [data-testid=inbox-bell]', every: true },
      { name: 'add video', sel: '.topbar .add-video', every: true },
      { name: 'account', sel: '.topbar .user-chip', every: true },
      { name: 'menu', sel: '.topbar .nav-toggle', every: true },
    ];
    const nav = [
      { name: 'sidebar head', sel: '.nav .nav-head', every: true },
      ...[0, 1, 2].map((i) => ({ name: `sidebar item ${i + 1}`, sel: '.nav .nav-section:first-child .nav-item', i, every: true })),
      { name: 'projects head', sel: '.nav .nav-section:nth-child(2) .nav-head', every: true },
    ];
    const hero = [
      { name: 'crumb', sel: '.hero .crumb', every: true },
      { name: 'title', sel: '.hero h1', every: true },
    ];
    const toolbar = [
      { name: 'filter', sel: '.lib-toolbar .lib-filter', every: true },
      { name: 'chips', sel: '.lib-toolbar .lib-lanes', every: true, pos: true },
      { name: 'layout switch', sel: '.lib-toolbar .seg.icons', every: true },
      { name: 'display', sel: '.lib-toolbar .lib-display', every: true },
    ];
    const lib = [...top, ...nav, ...hero, ...toolbar];
    // A library this browser never saw (a new account's first visit, a new device): whether it has a sidebar at all is
    // the answer's to say (an empty library has none), so the top bar stands alone until then — and nothing moves when
    // the library, or the empty state, arrives.
    const loose = (marks, names) => marks.map((m) => (names.includes(m.name) ? { ...m, every: false } : m));
    const firstTop = loose(top, ['menu', 'account']);
    const firstVisit = [
      ...firstTop,
      ...loose(
        nav,
        nav.map((m) => m.name),
      ),
      ...loose(
        hero,
        hero.map((m) => m.name),
      ),
    ];
    const CASES = [
      {
        name: 'library, first visit',
        url: '/#/',
        layout: 'grid',
        hint: false,
        ready: '.film',
        marks: [...firstVisit, { name: 'first card', sel: '.film', pos: true }],
      },
      {
        name: 'empty library, first visit',
        base: empty.base,
        url: '/#/',
        layout: 'grid',
        hint: false,
        ready: '.lib-scroll .empty-state',
        marks: [...firstTop, { name: 'empty state', sel: '.lib-scroll .empty-state', pos: true }],
      },
      {
        name: 'library grid',
        url: '/#/',
        layout: 'grid',
        ready: '.film',
        marks: [
          ...lib,
          { name: 'section head', sel: '.lib-section .shead' },
          { name: 'first card', sel: '.film', pos: true },
          { name: 'first poster', sel: '.film :is(.film-poster, .film-sk-poster)' },
          { name: 'second poster', sel: '.film :is(.film-poster, .film-sk-poster)', i: 1 },
        ],
      },
      {
        name: 'library list',
        url: '/#/',
        layout: 'list',
        ready: '.lrow',
        marks: [...lib, { name: 'table head', sel: '.ltable thead' }, { name: 'first row', sel: '.lrow' }, { name: 'first thumb', sel: '.lrow .lthumb' }],
      },
      {
        name: 'library board',
        url: '/#/',
        layout: 'board',
        ready: '.bcard',
        marks: [
          ...lib,
          // Phones stack the lanes: where the second one starts depends on how many cards the first holds.
          ...[0, 1, 2, 3].map((i) => ({ name: `lane ${i + 1} head`, sel: '.board .lane-head', i, wide: i > 0 })),
          { name: 'first board card', sel: '.bcard', pos: true },
          { name: 'first board poster', sel: '.bcard .bthumb' },
        ],
      },
      {
        // The data says "empty": the empty state takes the place of the cards, and nothing above it moves.
        name: 'library, empty view',
        url: '/#/session/nobody',
        layout: 'grid',
        ready: '.lib-scroll .empty-state',
        marks: [...lib, { name: 'empty state', sel: '.lib-scroll .empty-state', pos: true }],
      },
      {
        // A folder page: the crumb, the Videos · Playbook tabs and Share stand from the first paint (Share doesn't wait
        // for the videos), and the empty state takes the cards' place.
        name: 'empty folder',
        url: SCREENS['empty folder'],
        layout: 'grid',
        ready: '.lib-scroll .empty-state',
        marks: [
          ...lib,
          { name: 'folder tabs', sel: '.hero .hero-tabs', every: true },
          { name: 'share', sel: '.hero .hero-share', every: true },
          { name: 'empty state', sel: '.lib-scroll .empty-state', pos: true },
        ],
      },
      {
        // A folder's playbook: the line of playbooks it reads, the document and its first section, and what agents
        // read beside it (wide) stand where they will while the playbook and its code arrive.
        name: 'folder playbook',
        url: SCREENS['folder playbook'],
        ready: ready['folder playbook'],
        marks: [
          ...top,
          ...nav,
          ...hero,
          { name: 'folder tabs', sel: '.hero .hero-tabs', every: true },
          { name: 'playbook line', sel: '[data-testid=playbook] .pb-meta', every: true },
          { name: 'document', sel: '.pb-sheet', every: true, pos: true },
          { name: 'first section head', sel: '.pb-sheet .pb-sec-head', every: true },
          { name: 'what agents read', sel: '.pb-pane', every: true, pos: true, wide: true },
        ],
      },
      {
        // A project's files: the numbers line with search and Add files, the place and the kinds, the columns and the
        // first row stand where they will while the files and the page's code arrive.
        name: 'folder files',
        url: SCREENS['folder files'],
        ready: ready['folder files'],
        marks: [
          ...top,
          ...nav,
          ...hero,
          { name: 'folder tabs', sel: '.hero .hero-tabs', every: true },
          { name: 'files head', sel: '[data-testid=files] .pf-head', every: true },
          { name: 'files search', sel: '[data-testid=files-search]', every: true },
          { name: 'add files', sel: '[data-testid=files-add]', every: true },
          { name: 'files place', sel: '[data-testid=files] .pf-bar', every: true },
          { name: 'columns', sel: '[data-testid=files] .pf-cols', every: true, wide: true },
          { name: 'first row', sel: '[data-testid=files-list] .pf-row:not(.pf-cols)', every: true },
        ],
      },
      {
        name: 'insights',
        url: '/#/insights',
        ready: '[data-testid=insights]',
        // The headline (its lines' room), the stat tiles (their values wait in line boxes), the first card's head and
        // its answer stand where they will, while the page's code and its answer arrive; the first visit waits with
        // the cards below the first one unseen (it can't know how many rows each has).
        marks: [
          ...top,
          ...nav,
          ...hero,
          { name: 'period', sel: '.hero .ins-period', every: true },
          { name: 'headline', sel: '[data-testid=ins-headline]', every: true, pos: true },
          { name: 'stat tiles', sel: '[data-testid=ins-kpis]', every: true, pos: true },
          { name: 'stat value', sel: '[data-testid=ins-kpi-versions] .ins-kpi-value', every: true },
          { name: 'causes head', sel: '[data-testid=ins-causes] .ins-head', every: true },
          { name: 'causes answer', sel: '[data-testid=ins-causes-answer]', every: true },
        ],
      },
      {
        // Wide: the list beside the preview (the first item open); phones: the cards. The preview's own content
        // arrives after the list, so only where its pane starts and how wide it is are compared.
        name: 'inbox',
        url: '/#/inbox',
        ready: ready.inbox,
        marks: [
          ...top,
          ...nav,
          ...hero,
          { name: 'view', sel: '[data-testid=inbox-view]', every: true, pos: true },
          { name: 'first list group head', sel: '.inbox-view .inbox-group-h' },
          { name: 'first row thumb', sel: '.inbox-view .inbox-row .inbox-thumb' },
          { name: 'preview pane', sel: '.inbox-view-preview', pos: true, wide: true },
          { name: 'preview head', sel: '.inbox-view-preview .inbox-pv-head', pos: true, wide: true },
          { name: 'first card group', sel: '.inbox-view .fy-group', pos: true },
          { name: 'first card group head', sel: '.inbox-view .fy-group .fy-h' },
          { name: 'first card thumb', sel: '.inbox-view .fy-item .fy-thumb' },
        ],
      },
      {
        // Get started at the sidebar's foot (onboarding/Row.tsx): its room stands from the first paint where the row ends
        // up, by what this browser saw last; the inbox has no card above it to move it.
        name: 'get started row',
        base: q.firstStrip.base,
        url: '/#/inbox',
        chrome: { start: true },
        ready: ready.inbox,
        marks: [
          ...top,
          ...nav,
          { name: 'get started row', sel: '.nav [data-testid=ob-row-wrap]', every: true },
          { name: 'settings link', sel: '.nav .nav-settings', every: true },
        ],
      },
      {
        name: 'settings',
        url: '/#/settings',
        ready: '.set-nav a',
        marks: [
          { name: 'back', sel: '.topbar > button', every: true },
          { name: 'section list', sel: '.set-nav', pos: true, every: true },
          { name: 'first section', sel: '.set-nav > a', every: true },
          { name: 'section title', sel: '.set-head h1', every: true },
        ],
      },
      {
        name: 'player',
        url: SCREENS.player,
        ready: '.side-scroll .note:not(.pending)',
        marks: [
          { name: 'player top bar', sel: '.player > .topbar', every: true },
          { name: 'back', sel: '.player > .topbar > button', every: true },
          { name: 'player bell', sel: '.player .topbar [data-testid=inbox-bell]', every: true },
          { name: 'stage', sel: '.player .stage', every: true },
          { name: 'dock', sel: '.player .dock', every: true },
          { name: 'timeline', sel: '.player .timeline', every: true },
          { name: 'notes head', sel: '.player .side-head', every: true },
          { name: 'notes tabs', sel: '.player .note-filters', every: true },
          // the tags' line is there before the notes; the first row (its group header with it) where the rows start
          { name: 'notes tags', sel: '.player .note-tagf', every: true },
          { name: 'first note row', sel: '.player .side-scroll .note-row', pos: true },
        ],
      },
      {
        name: 'client link',
        url: SCREENS['client link'],
        ready: 'video',
        // What a link holds (a room or one video, the actions it allows) decides its shape: it loads with nothing drawn.
        marks: [
          { name: 'client top bar', sel: '.topbar' },
          { name: 'client stage', sel: '.stage' },
          { name: 'client dock', sel: '.dock' },
          { name: 'client notes', sel: '.side, .g-side', pos: true },
        ],
      },
    ];
    const sample = (marks) => {
      const out = {};
      for (const m of marks) {
        const el = document.querySelectorAll(m.sel)[m.i ?? 0];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        let shown = r.width > 0 && r.height > 0;
        for (let p = el; shown && p; p = p.parentElement) {
          const s = getComputedStyle(p);
          if (s.display === 'none' || s.visibility === 'hidden') shown = false;
        }
        // Layout position: a screen rising into place (an entrance animation's transform) is motion, not a shift, and the
        // browser's own layout-shift metric ignores transforms too — take them out of the box.
        let dx = 0;
        let dy = 0;
        for (let p = el; p; p = p.parentElement) {
          const t = getComputedStyle(p).transform;
          if (t && t !== 'none') {
            const mx = new DOMMatrixReadOnly(t);
            dx += mx.m41;
            dy += mx.m42;
          }
        }
        if (shown) out[m.name] = [r.left - dx, r.top - dy, r.width, r.height].map((v) => Math.round(v * 10) / 10);
      }
      return { busy: !!document.querySelector('[aria-busy="true"]'), boxes: out };
    };
    // The shift, and what moved most (so a failure names the element, not just a number).
    const watchMoves = () => {
      window.__shift = 0;
      window.__moved = [];
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          if (e.hadRecentInput) continue;
          window.__shift += e.value;
          for (const s of e.sources || []) {
            const n = s.node;
            const name = n?.tagName
              ? `${n.tagName.toLowerCase()}.${String(n.className || '')
                  .trim()
                  .split(/\s+/)
                  .slice(0, 2)
                  .join('.')}`
              : '?';
            window.__moved.push(
              `${name} y ${Math.round(s.previousRect.y)}→${Math.round(s.currentRect.y)} h ${Math.round(s.previousRect.height)}→${Math.round(s.currentRect.height)}`,
            );
          }
        }
      }).observe({ type: 'layout-shift', buffered: true });
    };
    // One screen at one width: what moved between the loading samples and the loaded page.
    const shifts = new Map();
    const measure = async (c, vp) => {
      const out = [];
      // A browser that has kept nothing yet (web/src/api/persist.ts): a later visit paints the kept data at once and
      // has no loading state to compare.
      const fresh = await q.browser.createBrowserContext().catch(async () => {
        await sleep(500);
        return q.browser.createBrowserContext();
      });
      const page = await fresh.newPage();
      if (vp.isMobile) await page.emulate({ viewport: vp, userAgent: IPHONE });
      else await page.setViewport(vp);
      await page.evaluateOnNewDocument(watchMoves);
      // …but one that saw the library before (lib/chromeHint.ts): its loading state knows a sidebar is coming
      await page.evaluateOnNewDocument(
        (layout, hint, more) => {
          try {
            localStorage.setItem('vr.library', JSON.stringify(layout ? { layout } : {}));
            if (hint) localStorage.setItem('vr.chrome', JSON.stringify({ role: 'owner', library: 'full', ...more }));
          } catch {}
        },
        c.layout || null,
        c.hint !== false,
        c.chrome ?? {},
      );
      // The app's service worker (installed by an earlier page) would fetch past the interception below.
      await page.setBypassServiceWorker(true);
      await page.setRequestInterception(true);
      // The screen's answers wait until its loading state has been seen (then HOLD more), at most 20 s: a fixed hold
      // raced a busy machine's start, whose first paint could come after the answers ("no loading state seen"); a
      // screen that never shows one still fails, only later.
      let release;
      const seen = new Promise((r) => {
        release = r;
      });
      const gate = Promise.race([seen.then(() => sleep(HOLD)), sleep(20000)]);
      // Nothing can be loaded while its answers are held back: before that, a match of the ready selector is the page's
      // static shell (the app waits for its screen's code before its first render), not the screen.
      let released = false;
      gate.then(() => {
        released = true;
      });
      page.on('request', (req) => {
        const u = new URL(req.url());
        const hold = req.method() === 'GET' && u.pathname.startsWith('/api/') && !/^\/api\/(events|poster|sprite|waveform)/.test(u.pathname);
        if (hold) gate.then(() => req.continue().catch(() => {}));
        else req.continue().catch(() => {});
      });
      const marks = c.marks;
      await page.goto((c.base ?? BASE) + c.url, { waitUntil: 'domcontentloaded' });
      const samples = [];
      const t0 = Date.now();
      // Sample for as long as anything says it is loading: the pending cards match the ready selectors too.
      while (Date.now() - t0 < 25000) {
        const s = await page.evaluate(sample, marks).catch(() => null);
        if (s?.busy) {
          samples.push(s);
          if (samples.length >= 2) release();
        } else if (s && released && (await page.$(c.ready))) break;
        await sleep(90);
      }
      await sleep(HOLD * 2 + 600);
      const fin = await page.evaluate(sample, marks);
      const { shift, moved } = await page.evaluate(() => ({ shift: window.__shift, moved: window.__moved }));
      await fresh.close();
      const where = `${c.name} @${vp.width}`;
      shifts.set(where, shift);
      if (!samples.length) return [`${where}: no loading state seen (answers held back ${HOLD} ms)`];
      const bad = new Map();
      for (const m of marks) {
        if (m.wide && vp === PHONE) continue;
        const f = fin.boxes[m.name];
        if (!f) continue;
        for (const s of samples) {
          const b = s.boxes[m.name];
          if (!b) {
            if (m.every) bad.set(m.name, `${m.name}: missing while loading (loaded at ${f.join(',')})`);
            continue;
          }
          const d = [0, 1, 2, 3].map((k) => Math.abs(b[k] - f[k]));
          if (d[0] > 2 || d[1] > 2 || d[2] > 2 || (!m.pos && d[3] > 2)) bad.set(m.name, `${m.name}: ${b.join(',')} while loading → ${f.join(',')}`);
        }
      }
      for (const b of bad.values()) out.push(`${where}: ${b}`);
      if (shift >= 0.01) out.push(`${where}: layout shift ${shift.toFixed(3)} while loading (${moved.slice(0, 3).join('; ')})`);
      return out;
    };
    const out = [];
    for (const c of CASES) {
      // A fresh browser per screen: no service worker or cache from the screen before, and short-lived Chromes.
      await relaunch();
      for (const vp of [DESKTOP, PHONE]) {
        if (c.name === 'settings' && vp === PHONE) continue;
        let found = await again(() => measure(c, vp));
        // A machine too busy to sample within the hold sees no loading state at all: that screen once more.
        if (found.some((l) => l.includes('no loading state seen'))) found = await again(() => measure(c, vp));
        out.push(...found);
      }
    }
    console.log(`      layout shift while loading: ${[...shifts].map(([w, s]) => `${w} ${s.toFixed(3)}`).join(', ')}`);
    assert(!out.length, `loading → loaded (x,y,w,h):\n        ${out.join('\n        ')}`);
  });
} catch (e) {
  crashed(e, ...q.servers);
} finally {
  await finish(LABEL, { browser: q.browser, servers: q.servers });
}
