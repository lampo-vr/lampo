#!/usr/bin/env node
// covers: web/src/files/ web/src/settings/Files.tsx web/src/ui/kindIcons.tsx web/src/styles/files.css web/src/uploads/UploadTray.tsx
// covers: web/src/billing/Plan.tsx web/src/conversion/limits/LimitSheet.tsx server/routes/files.ts lib/files.ts
// Browser end-to-end test of a project's files (the Files tab) on a real server with a real-shaped project in it
// (test/e2e/lib/filesStore.mjs: footage by day, music, an After Effects and a Cinema 4D project, Photoshop files, fonts,
// LUTs, a brief; an agent's files and versions; the project's and the House's files above it; a file in the trash).
// The sizes the page shows are a real project's (the answers are scaled, nothing else changes). Checks: the tab beside
// Videos and Playbook for the team and never for reviewers; a folder added through the picker and loose files dropped
// on the tab are checked before a byte moves (what is new, what replaces what, junk left out), then upload into the
// tray and land as rows; a replace whose file changed meanwhile says who changed it, and Keep both / Replace; a file
// opened beside the list with its versions, one restored; trash with Undo, then for real, then back from the trash; a
// new folder; inherited files folded and open; the plan's line, its sheet on a refusal and Settings → Billing; the
// phone's bottom sheet; the keys; no layout shift and the loading state in the real layout; every state at 390–1920 in
// both themes and German. Screenshots land in VR_SHOTS.
import fs from 'node:fs';
import path from 'node:path';
import { until } from '../lib/helpers.ts';
import { dataTheme, layoutMatrix, settle } from './layout.mjs';
import { launch, requireChrome, requireDist, shotsDir, signedIn } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { CAMPAIGN, PROJECT, pdfShown, push, SHOWN, seedProject } from './lib/filesStore.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'files e2e';
requireChrome(LABEL);
requireDist(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-files-e2e-', user: 'Sam' });
const { base: BASE, dir } = srv;
const e = encodeURIComponent;
const TB = 1e12;

const api = async (url, method = 'GET', body) => {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  assert(res.ok, `${method} ${url}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
};
const listing = (area, p = '', deep = true) => api(`/api/files?folder=${e(area)}&own=1&path=${e(p)}${deep ? '&deep=1' : ''}&limit=1000`);

// ---------------------------------------------------------------- what the page is told

/** A real project's size for a file (SHOWN), else what it is. */
const shownSize = (area, p, size) => SHOWN[area]?.[p] ?? size;
function scaleListing(j) {
  const area = j.folder;
  for (const f of j.files ?? []) f.size = shownSize(f.area ?? area, f.path, f.size);
  for (const d of j.dirs ?? []) {
    const own = Object.entries(SHOWN[d.area ?? area] ?? {}).filter(([p]) => p.startsWith(`${d.path}/`));
    if (own.length && d.files) d.bytes = own.reduce((s, [, b]) => s + b, 0) + Math.max(0, d.files - own.length) * 4000;
  }
  for (const a of j.areas ?? []) scaleArea(a);
  return j;
}
function scaleArea(a) {
  const all = Object.values(SHOWN[a.area] ?? {});
  if (all.length && a.files) a.bytes = all.reduce((s, b) => s + b, 0);
  if (a.trash) a.trash_bytes = 3.1e9;
  for (const t of a.tops ?? []) {
    const own = Object.entries(SHOWN[a.area] ?? {}).filter(([p]) => (t.dir ? p.startsWith(t.path) : p === t.path));
    if (own.length) t.bytes = own.reduce((s, [, b]) => s + b, 0);
  }
  return a;
}
// a plan near its end (where a billing provider runs: the page reads /api/info and /api/billing)
let plan = null;
const billingOf = (used, limit, files) => ({
  plan: 'team',
  planName: 'Team',
  state: 'active',
  usage: { members: 3, bytes: used, activeVideos: 4, files },
  limits: { members: null, bytes: limit, activeVideos: null },
  manage: true,
  available: true,
  currency: 'eur',
  renewsAt: new Date(Date.now() + 20 * 86400e3).toISOString(),
  interval: 'month',
  // what the plan's sheet offers (a plan that holds more)
  offers: [
    {
      plan: 'team',
      name: 'Team',
      perMember: true,
      members: { min: 2, max: 50 },
      bytes: { base: 1e12, perMember: 5e11 },
      activeVideos: null,
      prices: { eur: { month: 2400, year: 24000 } },
      fits: true,
    },
    {
      plan: 'business',
      name: 'Business',
      perMember: true,
      members: { min: 1, max: null },
      bytes: { base: 2e12, perMember: 1e12 },
      activeVideos: null,
      prices: { eur: { month: 4200, year: 42000 } },
      fits: true,
    },
  ],
});
// the role the page is told (a reviewer's: the tab must not be there)
let role = null;
// told it is a hosted server in a browser (Settings → Billing is a hosted server's section)
let hosted = false;
// the next upload request is refused for room (the plan's sheet)
let refuseNext = false;
/** The brand fonts held back (the system's sans then, wider on Linux and Windows than the Mac's). */
let blockFonts = false;
/** A file id no store has (an address that outlived its file). */
const NO_SUCH_FILE = 'fl_000000000000';
let dayFull = false;
/** The `conflict` of every POST /api/files/uploads, in order. */
const asked = [];

async function intercept(p) {
  await p.setRequestInterception(true);
  p.on('request', async (req) => {
    const url = new URL(req.url());
    const at = url.pathname;
    // Linux-like metrics on any machine: the brand fonts never arrive
    if (blockFonts && /\.woff2?$/.test(at)) return req.abort().catch(() => {});
    try {
      if (!at.startsWith('/api/') || req.method() !== 'GET') {
        if (at === '/api/files/uploads' && req.method() === 'POST') asked.push(JSON.parse(req.postData() || '{}').conflict ?? 'refuse');
        // the account's day of versions full: the server's own 429 (a copy is never refused for it)
        if (dayFull && at === '/api/files/uploads' && req.method() === 'POST' && JSON.parse(req.postData() || '{}').conflict !== 'copy') {
          return req.respond({
            status: 429,
            headers: { 'Retry-After': '7200' },
            contentType: 'application/json',
            body: JSON.stringify({ error: 'you made 24 versions of Graphics/Spring_Teal.cube today', retry_after: 7200, reason: 'versions' }),
          });
        }
        if (refuseNext && at === '/api/files/uploads' && req.method() === 'POST') {
          refuseNext = false;
          return req.respond({
            status: 402,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'This workspace’s plan has no storage left for this.', reason: 'storage', needed: 4.2e9, fits: 'addon:storage_tb' }),
          });
        }
        return req.continue();
      }
      const scaled = /^\/api\/files(\/summary|\/trash)?$/.test(at) || /^\/api\/files\/f[ld]_[0-9a-f]{12}(\/history)?$/.test(at);
      const tweak = scaled || at === '/api/auth/status' || (plan && (at === '/api/info' || at === '/api/billing'));
      if (!tweak) return req.continue();
      if (plan && at === '/api/billing') return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(plan) });
      const r = await fetch(req.url(), { headers: { accept: 'application/json' } });
      if (!r.ok) return req.respond({ status: r.status, contentType: r.headers.get('content-type') ?? 'application/json', body: await r.text() });
      const j = await r.json();
      if (at === '/api/info' && plan) j.billing = true;
      if (at === '/api/auth/status' && role && j.user) j.user.role = role;
      if (at === '/api/auth/status' && hosted) Object.assign(j, { mode: 'server', via: 'cookie' });
      if (at === '/api/files' || at === '/api/files/summary') scaleListing(j);
      if (at === '/api/files/trash') for (const f of j.files ?? []) f.size = 3.1e9;
      if (/\/history$/.test(at)) {
        const area = j.file.area;
        j.file.size = shownSize(area, j.file.path, j.file.size);
        for (const v of j.versions) v.size = v.current ? j.file.size : Math.round(j.file.size * 0.93);
      } else if (/^\/api\/files\/f[ld]_/.test(at) && j.path) j.size = shownSize(j.area, j.path, j.size);
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(j) });
    } catch {
      return req.continue().catch(() => {});
    }
  });
}

let browser;
let page;
const errors = [];
const open = async (hash, { wait = '[data-testid=files][aria-busy=false]' } = {}) => {
  // a page of its own each time: nothing picked, open or typed from the check before
  await page.goto('about:blank');
  await page.goto(`${BASE}/${hash}`);
  await signedIn(page);
  if (wait) await page.waitForSelector(wait, { timeout: 20_000 });
  await page.waitForFunction(() => !document.activeViewTransition);
  await settle(page, { quiet: 300 });
};
const campaign = (q = '') => `#/files/${e(CAMPAIGN)}${q}`;
/** The folder `p` on screen, loaded. Until the address's change is drawn (a view transition holds the page before it),
 * keys still reach the folder before it. */
const shown = async (p, row = 'dir-row') => {
  await page.waitForSelector(`[data-testid=files][data-path="${p}"][aria-busy=false] [data-testid=${row}]`, { timeout: 20_000 });
  await page.waitForFunction(() => !document.activeViewTransition);
};
const rowNames = () =>
  page.$$eval('[data-testid=files-list] [data-testid=file-row] .pf-name, [data-testid=files-list] [data-testid=dir-row] .pf-name', (els) =>
    els.map((x) => x.textContent),
  );
const shot = async (name) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
const toastGone = () => page.waitForFunction(() => !document.querySelector('[data-testid=toast]'), { timeout: 20_000 });

try {
  const ids = await seedProject(BASE, dir);
  browser = await launch();
  page = await browser.newPage();
  page.on('pageerror', (x) => errors.push(x.message));
  // the files' API answering an error the page didn't mean to cause (a 409, 402 or 429 is a check's own, and so is
  // the 404 for a file no one has)
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.pathname.includes(NO_SUCH_FILE)) return;
    if (u.pathname.startsWith('/api/files') && r.status() >= 400 && ![402, 409, 429].includes(r.status()))
      errors.push(`${r.request().method()} ${u.pathname}${u.search}: ${r.status()}`);
  });
  screenshotFailures(() => page, 'files');
  await intercept(page);
  await page.setViewport({ width: 1440, height: 900 });

  await check('the Files tab stands beside Videos and Playbook on a project and a folder, and opens the folder’s files', async () => {
    await open(`#/folder/${e(PROJECT)}`, { wait: '[data-testid=folder-tab-files]' });
    const tabs = await page.$$eval('.hero-tabs [role=tab]', (els) => els.map((x) => x.textContent?.trim()));
    assert(tabs.join(' · ') === 'Videos · Files · Playbook', `tabs: ${tabs.join(' · ')}`);
    await page.click('[data-testid=folder-tab-files]');
    await page.waitForSelector(`[data-testid=files][data-area="${PROJECT}"][aria-busy=false]`);
    assert(page.url().endsWith(`#/files/${PROJECT}`), page.url());
    assert(await page.$eval('[data-testid=folder-tab-files]', (b) => b.getAttribute('aria-selected') === 'true'), 'the tab is the current one');
    await open(campaign());
    const names = await rowNames();
    for (const n of ['Brief', 'Footage', 'Graphics', 'Music', 'Project', 'Renders for review', 'subtitles_de.srt'])
      assert(names.includes(n), `a row for ${n}: ${names.join(', ')}`);
    assert(names.indexOf('Footage') < names.indexOf('subtitles_de.srt'), 'folders first');
    const count = await page.$eval('[data-testid=files-count]', (x) => x.textContent);
    assert(/18 files · [\d.]+ GB/.test(count ?? '') && /Acme 4/.test(count ?? '') && /House 3/.test(count ?? ''), `the numbers line: ${count}`);
    await shot('files-campaign-1440');
  });

  await check('a reviewer has no Files tab, and a link to one opens the folder’s videos', async () => {
    role = 'reviewer';
    try {
      await open(`#/folder/${e(PROJECT)}`, { wait: '[data-testid=folder-tab-videos]' });
      // (the role this browser kept may draw the tab for a moment: the server's answer takes it away)
      await page
        .waitForFunction(() => !document.querySelector('[data-testid=folder-tab-files]'), { timeout: 10_000 })
        .catch(() => {
          throw new Error('a reviewer sees the Files tab');
        });
      await page.goto(`${BASE}/${campaign()}`);
      await page.waitForFunction((p) => location.hash === `#/folder/${p}`, { timeout: 10_000 }, e(CAMPAIGN));
      assert(!(await page.$('[data-testid=files]')), 'no files page');
      // and the server agrees: a reviewer's own request is answered as if there were nothing (the core's tests)
    } finally {
      role = null;
    }
  });

  await check('rows: one height whatever they are; an agent’s file wears its mark; the kinds narrow the list in place', async () => {
    await open(campaign(`?path=${e('Music')}`));
    const heights = await page.$$eval('[data-testid=files-list] .pf-row:not(.pf-cols)', (els) => [
      ...new Set(els.map((x) => Math.round(x.getBoundingClientRect().height))),
    ]);
    assert(heights.length === 1 && heights[0] === 40, `row heights: ${heights}`);
    const who = await page.$eval('[data-testid=file-row] .pf-who', (x) => ({
      agent: x.classList.contains('agent'),
      name: x.textContent,
      mark: !!x.querySelector('.agent-mark'),
    }));
    assert(who.agent && who.mark && who.name === 'promo-edit', `the agent's mark: ${JSON.stringify(who)}`);
    await open(campaign());
    await page.$$eval('.pf-kind-chips button', (bs) => bs.find((b) => b.textContent === 'Project files')?.click());
    await until(
      async () => (await rowNames()).join() === 'endcard.c4d,spot.aep,Spring sale key visual.psd',
      async () => (await rowNames()).join(),
    );
    assert(await page.$eval('[data-testid=file-row] .pf-dir', (x) => x.textContent === 'Project'), 'a match says where it is');
    await page.$$eval('.pf-kind-chips button', (bs) => bs.find((b) => b.textContent === 'All')?.click());
    await page.type('[data-testid=files-search]', 'A001');
    // every folder inside is searched: Day 1's three takes (the old one is in the trash)
    await until(
      async () => (await rowNames()).join() === 'A001C003.mov,A001C004.mov,A001C005.mov',
      async () => (await rowNames()).join(),
    );
    await page.click('[data-testid=files-search]', { count: 3 });
    await page.keyboard.press('Escape');
  });

  await check('a folder through the picker: the check says what comes before any byte moves, then the tray and the rows', async () => {
    const shoot = path.join(dir, 'pick', 'Day 3');
    fs.mkdirSync(path.join(shoot, 'Cards'), { recursive: true });
    fs.writeFileSync(path.join(shoot, 'C001C001.mov'), Buffer.alloc(220_000, 1));
    fs.writeFileSync(path.join(shoot, 'C001C002.mov'), Buffer.alloc(180_000, 2));
    fs.writeFileSync(path.join(shoot, 'Cards', 'notes.txt'), 'card 1\n');
    fs.writeFileSync(path.join(shoot, '.DS_Store'), Buffer.alloc(10, 0));
    fs.writeFileSync(path.join(shoot, '._C001C001.mov'), Buffer.alloc(10, 0));
    await open(campaign(`?path=${e('Footage')}`));
    let requests = 0;
    const count = (r) => r.url().includes('/api/files/uploads') && requests++;
    page.on('request', count);
    const input = await page.$('[data-testid=files-input-folder]');
    await input.uploadFile(shoot);
    await page.waitForSelector('[data-testid=files-check]');
    // (once hashed: "Checking what’s already in Lampo · 40%" is the line before)
    await page.waitForFunction(
      () => /^(Nothing to skip|\d+ (is|are) already in Lampo)/.test(document.querySelector('[data-testid=files-check-known]')?.textContent ?? ''),
      {
        timeout: 20_000,
      },
    );
    // new bytes are said as what is sent, never as "new files": some of them may become new versions
    const known = await page.$eval('[data-testid=files-check-known]', (x) => x.textContent);
    assert(known === 'Nothing to skip: all of it needs uploading', `what is in Lampo already: ${known}`);
    const text = await page.$eval('[data-testid=files-check]', (x) => x.textContent);
    assert(/Day 3/.test(text ?? ''), `the top folder: ${text}`);
    // what is left out, each said once (in the language's order: a disk lists them in its own)
    const left = await page.$eval('[data-testid=files-check-junk]', (x) => x.textContent);
    const junk = /^2 left out: (.+)$/.exec(left ?? '')?.[1]?.split(', ') ?? [];
    assert(junk.sort().join() === '.DS_Store,._C001C001.mov', `junk said once: ${left}`);
    assert(requests === 0, 'nothing asked for before Add');
    const title = await page.$eval('.modal-head h3', (x) => x.textContent);
    assert(title === 'Add 3 files to Spring sale · Footage', `title: ${title}`);
    await shot('files-check-1440');
    await page.click('[data-testid=files-check-add]');
    await page.waitForSelector('[data-testid=upload-tray] [data-testid=file-batch]');
    await until(
      async () => (await rowNames()).includes('Day 3'),
      async () => (await rowNames()).join(),
    );
    await until(async () => (await listing(CAMPAIGN, 'Footage/Day 3')).files.length === 3, 'three files committed');
    page.off('request', count);
    const paths = (await listing(CAMPAIGN, 'Footage/Day 3')).files.map((f) => f.path).sort();
    assert(paths.join() === 'Footage/Day 3/C001C001.mov,Footage/Day 3/C001C002.mov,Footage/Day 3/Cards/notes.txt', paths.join());
  });

  await check('files dropped anywhere on the tab: the outline over the list, the check, Add', async () => {
    await open(campaign(`?path=${e('Graphics')}`));
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(3000).fill(7)], 'Logo lockup.svg', { type: 'image/svg+xml' }));
      dt.items.add(new File([new Uint8Array(900).fill(9)], 'Spring_Gold.cube'));
      dt.items.add(new File([new Uint8Array(4)], '.DS_Store'));
      const target = document.querySelector('[data-testid=files-list]');
      target?.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
      window.__dt = dt;
    });
    await page.waitForSelector('[data-testid=files-drop]');
    const line = await page.$eval('.pf-drop-line', (x) => x.textContent);
    assert(line === 'Drop to add to Spring sale · Graphics', line ?? '');
    await shot('files-drop-1440');
    await page.evaluate(() =>
      document.querySelector('[data-testid=files-list]')?.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: window.__dt })),
    );
    await page.waitForSelector('[data-testid=files-check-versions]');
    const v = await page.$eval('[data-testid=files-check-versions]', (x) => x.textContent);
    assert(/1 becomes a new version: Logo lockup\.svg \(V2\)/.test(v ?? ''), v ?? '');
    await page.click('[data-testid=files-check-add]');
    await until(async () => (await listing(CAMPAIGN, 'Graphics')).files.find((f) => f.path === 'Graphics/Logo lockup.svg')?.v === 2, 'Logo lockup.svg V2');
    await until(
      async () => (await rowNames()).includes('Spring_Gold.cube'),
      async () => (await rowNames()).join(),
    );
  });

  await check('a new version past the day’s versions: the tray says when the next can come, and Save as a copy lands it', async () => {
    await open(campaign(`?path=${e('Graphics')}`));
    const before = (await listing(CAMPAIGN, 'Graphics')).files.length;
    dayFull = true;
    try {
      await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array(1300).fill(5)], 'Spring_Teal.cube'));
        document.querySelector('[data-testid=files-list]')?.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
      });
      await page.waitForSelector('[data-testid=files-check-versions]');
      await page.click('[data-testid=files-check-add]');
      await page.waitForSelector('[data-testid=upload-tray] [data-testid=file-later]');
      const said = await page.$eval('[data-testid=file-later]', (x) => x.textContent);
      // with the time the server named (2 h from now), in the person's clock
      assert(/1 file can’t take another version from you today/.test(said ?? '') && /a new version (at|tomorrow at) \d/.test(said ?? ''), said ?? '');
      assert(!(await page.$('[data-testid=file-later-again]')), 'no Try again before the time');
      await shot('files-later-1440');
      await page.click('[data-testid=file-save-copy]');
      await page.waitForFunction(() => !document.querySelector('[data-testid=file-later]'));
      assert(asked.at(-1) === 'copy', `asked as: ${asked.slice(-3)}`);
      await until(async () => (await listing(CAMPAIGN, 'Graphics')).files.length >= before, 'saved');
      await until(async () => (await page.$$eval('[data-testid=file-batch]', (bs) => bs.at(-1)?.textContent ?? '')).includes('added'), 'the batch done');
    } finally {
      dayFull = false;
    }
  });

  await check('a replace whose file changed meanwhile: who changed it, then Keep both lands beside it', async () => {
    await open(campaign(`?path=${e('Project')}`));
    const before = (await listing(CAMPAIGN, 'Project')).files.find((f) => f.path === 'Project/spot.aep');
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(5000).fill(3)], 'spot.aep'));
      document.querySelector('[data-testid=files-list]')?.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    });
    await page.waitForSelector('[data-testid=files-check-versions]');
    // someone else's agent puts up the next version while the check is open
    await push(
      BASE,
      CAMPAIGN,
      { 'Project/spot.aep': Buffer.from(`v by codex ${'z'.repeat(5000)}`) },
      { agent: 'cut-down', agent_kind: 'codex', base: { 'Project/spot.aep': before.v } },
    );
    await page.click('[data-testid=files-check-add]');
    await page.waitForSelector('[data-testid=file-conflict]');
    const said = await page.$eval('[data-testid=file-conflict]', (x) => x.textContent);
    assert(new RegExp(`V${before.v + 1} by cut-down`).test(said ?? ''), `who changed it: ${said}`);
    await shot('files-conflict-1440');
    await page.click('[data-testid=file-keep-both]');
    await until(async () => (await listing(CAMPAIGN, 'Project')).files.some((f) => /^Project\/spot \(.+\)\.aep$/.test(f.path)), 'a copy beside it');
    const now = (await listing(CAMPAIGN, 'Project')).files.find((f) => f.path === 'Project/spot.aep');
    assert(now.v === before.v + 1, `theirs stays the newest: V${now.v}`);
  });

  await check('a replace whose file changed meanwhile: Replace makes it the next version after theirs', async () => {
    const before = (await listing(CAMPAIGN, 'Project')).files.find((f) => f.path === 'Project/endcard.c4d');
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(7000).fill(5)], 'endcard.c4d'));
      document.querySelector('[data-testid=files-list]')?.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    });
    await page.waitForSelector('[data-testid=files-check-versions]');
    await push(BASE, CAMPAIGN, { 'Project/endcard.c4d': Buffer.from(`by Mia ${'q'.repeat(6000)}`) }, { base: { 'Project/endcard.c4d': before.v } });
    await page.click('[data-testid=files-check-add]');
    await page.waitForSelector('[data-testid=file-conflict]');
    await page.click('[data-testid=file-replace]');
    await until(async () => (await listing(CAMPAIGN, 'Project')).files.find((f) => f.path === 'Project/endcard.c4d')?.v === before.v + 2, 'mine after theirs');
  });

  await check('an address naming a file that isn’t here: the sheet says so, and leads back to the files', async () => {
    await open(campaign(`?open=${NO_SUCH_FILE}`), { wait: '[data-testid=file-sheet-missing]' });
    const said = await page.$eval('[data-testid=file-sheet-missing]', (x) => x.textContent);
    assert(/This file isn’t here/.test(said ?? ''), said ?? '');
    await page.click('[data-testid=file-sheet-back]');
    await page.waitForFunction(() => !document.querySelector('[data-testid=file-sheet]') && !location.hash.includes('open='));
  });

  await check('a file opened beside the list: a look at it, its versions with who and an agent’s marked; one restored', async () => {
    await open(campaign(`?path=${e('Project')}`));
    await page.$$eval('[data-testid=file-row]', (rows) => rows.find((r) => r.querySelector('.pf-name')?.textContent === 'spot.aep')?.click());
    await page.waitForSelector('[data-testid=file-sheet] [data-testid=file-version]');
    const vers = await page.$$eval('[data-testid=file-version]', (els) => els.map((x) => ({ v: Number(x.dataset.v), text: x.textContent })));
    assert(vers.length >= 3 && vers[0].v > vers[1].v, `newest first: ${vers.map((x) => x.v)}`);
    assert(
      vers.some((x) => /via agent/.test(x.text)),
      'an agent’s version says so',
    );
    assert(new URL(page.url()).hash.includes('open=fl_'), 'the address names the open file');
    await shot('files-sheet-1440');
    const top = vers[0].v;
    await page.$$eval('[data-testid=file-version]', (els) => els.at(-1)?.querySelector('[data-testid=file-restore-version]')?.click());
    await until(async () => (await listing(CAMPAIGN, 'Project')).files.find((f) => f.path === 'Project/spot.aep')?.v === top + 1, 'V1 back as the newest');
    // the sheet says it: the newest version is the restored one
    await page.waitForFunction((v) => document.querySelector('[data-testid=file-version]')?.getAttribute('data-v') === String(v), { timeout: 10_000 }, top + 1);
    // Esc closes it from anywhere on the page (the button pressed is gone: the focus is on the page)
    await page.keyboard.press('Escape');
    await page
      .waitForFunction(() => !document.querySelector('[data-testid=file-sheet]'), { timeout: 10_000 })
      .catch(() => {
        throw new Error('Esc left the sheet open');
      });
  });

  await check(
    'a picture and a text file are shown in the sheet, a PDF opens in a tab of its own (Chrome shows it); a project file has no preview',
    async () => {
      for (const [p, look] of [
        ['Graphics', 'image'],
        ['Brief', 'pdf'],
        ['Brief', 'text'],
        ['Project', 'none'],
      ]) {
        await open(campaign(`?path=${e(p)}`));
        const name = { image: 'still_hero.png', pdf: 'Brief v3.pdf', text: 'voiceover script.txt', none: 'Spring sale key visual.psd' }[look];
        await page.$$eval('[data-testid=file-row]', (rows, n) => rows.find((r) => r.querySelector('.pf-name')?.textContent === n)?.click(), name);
        await page.waitForSelector(`[data-testid=file-preview][data-look=${look}]`);
        if (look === 'image')
          await page.waitForFunction(() => document.querySelector('[data-testid=file-preview] img')?.naturalWidth === 640, { timeout: 10_000 });
        if (look === 'pdf') {
          // never framed (no answer of this server may be): Open in a tab of its own, on the app's route — a sealed URL
          // never sits in the page — and Download
          const pdf = await page.$eval('[data-testid=file-preview]', (x) => {
            const a = x.querySelector('[data-testid=file-pdf-open]');
            return {
              frame: !!x.querySelector('iframe, embed, object'),
              href: a?.getAttribute('href'),
              target: a?.getAttribute('target'),
              rel: a?.getAttribute('rel'),
              download: !!x.querySelector('[data-testid=file-pdf-download]'),
            };
          });
          assert(!pdf.frame && pdf.download, JSON.stringify(pdf));
          assert(/^\/api\/files\/fl_[0-9a-f]{12}\/download\?v=\d+&inline=1$/.test(pdf.href ?? ''), `Open: ${pdf.href}`);
          assert(pdf.target === '_blank' && pdf.rel === 'noopener noreferrer', JSON.stringify(pdf));
          // and Chrome's viewer shows it there, under the bytes' own policy (sandbox)
          const shown = await pdfShown(`${BASE}${pdf.href}`);
          assert(shown.viewer && shown.contentType === 'application/pdf', `the PDF in its tab: ${JSON.stringify(shown)}`);
          await shot('files-sheet-pdf-1440');
        }
        if (look === 'text')
          await page.waitForFunction(() => /Spring is here/.test(document.querySelector('[data-testid=file-preview-text]')?.textContent ?? ''), {
            timeout: 10_000,
          });
        if (look === 'image') await shot('files-sheet-image-1440');
      }
      await page.keyboard.press('Escape');
    },
  );

  await check('the keys: ↓ moves, ↵ opens a folder, ⌘↑ goes back up, Space looks, ⌫ trashes with Undo', async () => {
    await open(campaign());
    await page.focus('[data-testid=files-list]');
    const active = () => page.$eval('[data-testid=files-list] .pf-row.active .pf-name', (x) => x.textContent).catch(() => null);
    assert((await active()) === 'Brief', `the first row: ${await active()}`);
    await page.keyboard.press('ArrowDown');
    assert((await active()) === 'Footage', `↓: ${await active()}`);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1]).get('path') === 'Footage');
    await shown('Footage');
    await page.focus('[data-testid=files-list]');
    await page.keyboard.down('Meta');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.up('Meta');
    await page.waitForFunction(() => !location.hash.includes('path='));
    await shown('', 'file-row');
    await page.focus('[data-testid=files-list]');
    await page.keyboard.press('End');
    assert((await active()) === 'subtitles_de.srt', `End: ${await active()}`);
    await page.keyboard.press('Space');
    await page.waitForSelector('[data-testid=file-sheet]');
    await page.keyboard.press('Space');
    await page.waitForFunction(() => !document.querySelector('[data-testid=file-sheet]'));
    // ⌫, then Undo: back, and nothing reached the server
    await page.keyboard.press('Backspace');
    await until(async () => !(await rowNames()).includes('subtitles_de.srt'), 'gone from the list');
    await page.waitForSelector('[data-testid=toast] .toast-act');
    await page.$$eval('[data-testid=toast] .toast-act', (bs) => bs.at(-1)?.click());
    await until(async () => (await rowNames()).includes('subtitles_de.srt'), 'back after Undo');
    assert(
      (await listing(CAMPAIGN)).files.some((f) => f.path === 'subtitles_de.srt'),
      'still there on the server',
    );
  });

  await check('trash: picked rows go with Undo, for real once the toast goes, and come back from the trash', async () => {
    await open(campaign());
    await page.$$eval('[data-testid=file-row]', (rows) =>
      rows
        .find((r) => r.querySelector('.pf-name')?.textContent === 'subtitles_de.srt')
        ?.querySelector('.pf-tick')
        ?.click(),
    );
    await page.waitForSelector('[data-testid=files-selbar]');
    await shot('files-picked-1440');
    await page.click('[data-testid=files-selbar-trash]');
    await toastGone();
    await until(async () => !(await listing(CAMPAIGN)).files.some((f) => f.path === 'subtitles_de.srt'), 'trashed on the server');
    await page.waitForSelector('[data-testid=files-trash-link]');
    await page.click('[data-testid=files-trash-link]');
    await page.waitForSelector('[data-testid=files-trash] [data-testid=trash-row]');
    await shot('files-trash-1440');
    const names = await page.$$eval('[data-testid=trash-row] .pf-name', (els) => els.map((x) => x.textContent));
    assert(names.includes('subtitles_de.srt') && names.includes('A001C003_old.mov'), names.join());
    // when each goes is the server's word (`purge_at`: up to 30 days, earlier past the safety net's cap), never a guess
    const goes = await page.evaluate(async (area) => {
      const trash = await (await fetch(`/api/files/trash?folder=${encodeURIComponent(area)}`)).json();
      return [...document.querySelectorAll('[data-testid=trash-row]')].map((r) => {
        const f = trash.files.find((x) => x.id === r.dataset.id);
        return { id: r.dataset.id, shown: r.querySelector('.pf-v')?.getAttribute('title'), server: f ? new Date(f.purge_at).toLocaleString() : null };
      });
    }, CAMPAIGN);
    assert(goes.length && goes.every((x) => x.server && x.shown === x.server), `when each goes: ${JSON.stringify(goes)}`);
    await page.$$eval('[data-testid=trash-row]', (rows) =>
      rows
        .find((r) => r.querySelector('.pf-name')?.textContent === 'subtitles_de.srt')
        ?.querySelector('[data-testid=trash-restore]')
        ?.click(),
    );
    await until(async () => (await listing(CAMPAIGN)).files.some((f) => f.path === 'subtitles_de.srt'), 'restored on the server');
  });

  await check('a new folder: made in place, empty, and its empty state', async () => {
    await open(campaign());
    await page.click('.pf-add-more');
    await page.waitForSelector('[role=menu]');
    await page.$$eval('[role=menuitem]', (els) => els.find((x) => x.textContent?.includes('New folder'))?.click());
    await page.waitForSelector('[data-testid=files-name]');
    await page.type('[data-testid=files-name]', 'Selects');
    await page.keyboard.press('Enter');
    await until(
      async () => (await rowNames()).includes('Selects'),
      async () => (await rowNames()).join(),
    );
    await until(async () => (await listing(CAMPAIGN, '', false)).dirs.some((d) => d.path === 'Selects'), 'kept on the server');
    await page.$$eval('[data-testid=dir-row]', (rows) => rows.find((r) => r.querySelector('.pf-name')?.textContent === 'Selects')?.click());
    await page.waitForSelector('[data-testid=files-empty]');
  });

  await check('what a folder inherits: folded under its own, open to the files above', async () => {
    await open(campaign());
    const from = await page.$$eval('[data-testid=files-inherited] .pf-inh-from', (els) => els.map((x) => x.textContent));
    assert(from.join() === 'From Acme,From House', from.join());
    await page.click(`[data-testid=files-inherited][data-area="${PROJECT}"] .pf-inh-head`);
    await page.waitForSelector(`[data-testid=files-inherited][data-area="${PROJECT}"] [data-testid=inherited-dir-row]`);
    await shot('files-inherited-1440');
  });

  await check('the plan: a quiet line of what files use, the head’s pill near the end, the sheet on a refusal, Settings → Billing', async () => {
    plan = billingOf(2.18 * TB, 2.5 * TB, { bytes: 1.31 * TB, kept: 18e9 });
    try {
      await open(campaign());
      const usage = await page.$eval('[data-testid=files-usage]', (x) => x.textContent);
      assert(/Files 1\.31 TB · videos 870 GB · 2\.18 TB of 2\.5 TB in use/.test(usage ?? ''), `usage: ${usage}`);
      assert(/trash and older versions 18 GB, not counted/.test(usage ?? ''), usage ?? '');
      const pill = await page.$eval('[data-testid=files-quota-near]', (x) => x.textContent);
      assert(pill === '87% of storage used', `the pill near the end: ${pill}`);
      await shot('files-quota-1440');
      // a refusal for room: the plan's own sheet, with what fills it
      refuseNext = true;
      await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array(1000).fill(1)], 'B001C009.mov'));
        document.querySelector('[data-testid=files-list]')?.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
      });
      await page.waitForSelector('[data-testid=files-check-add]');
      await page.click('[data-testid=files-check-add]');
      await page.waitForSelector('[data-testid=limit-sheet] [data-testid=limit-files]');
      const split = await page.$eval('[data-testid=limit-files]', (x) => x.textContent);
      assert(/Videos 870 GB · files 1\.31 TB/.test(split ?? ''), split ?? '');
      await page.click('[data-testid=limit-later]');
      await page.waitForSelector('[data-testid=file-upload-room]');
      hosted = true;
      await open('#/settings/billing', { wait: '[data-testid=billing-files]' });
      const meter = await page.$eval('[data-testid=billing-storage]', (x) => x.textContent);
      assert(/Videos 870 GB · files 1\.31 TB/.test(meter ?? '') && /Trash and older versions 18 GB/.test(meter ?? ''), meter ?? '');
      assert(await page.$('[data-testid=billing-storage-near]'), 'near the end, in words');
      await shot('billing-files-1440');
    } finally {
      plan = null;
      hosted = false;
    }
  });

  await check('a phone: two lines a row, the actions behind ⋯, a file opens in the bottom sheet', async () => {
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await open(campaign(`?path=${e('Footage/Day 1')}`));
    const h = await page.$eval('[data-testid=file-row]', (x) => Math.round(x.getBoundingClientRect().height));
    assert(h === 56, `a phone row: ${h}`);
    await shot('files-phone-390');
    await page.tap('[data-testid=file-row] .pf-name');
    await page.waitForSelector('.modal [data-testid=file-sheet] [data-testid=file-version]');
    const sheet = await page.$eval('.modal', (x) => {
      const r = x.getBoundingClientRect();
      return { bottom: Math.round(r.bottom), width: Math.round(r.width) };
    });
    assert(sheet.bottom === 844 && sheet.width === 390, `a bottom sheet: ${JSON.stringify(sheet)}`);
    await shot('files-phone-sheet-390');
    await page.keyboard.press('Escape');
    await page.setViewport({ width: 1440, height: 900 });
  });

  await check('picking with a finger: Select in a row’s ⋯, then a box on every row, ticked ones kept; the bar’s actions fit side by side', async () => {
    // the bar's actions, each whole and none over the next, inside the bar and the page
    const barFits = () =>
      page.$eval('[data-testid=files-selbar]', (bar) => {
        const out = [];
        const b = bar.getBoundingClientRect();
        if (b.left < 0 || b.right > innerWidth) out.push(`the bar runs off the page (${Math.round(b.left)}–${Math.round(b.right)})`);
        let edge = b.left;
        for (const el of bar.children) {
          const r = el.getBoundingClientRect();
          const what = el.getAttribute('aria-label') || el.textContent.trim();
          if (el.scrollWidth > el.clientWidth + 1) out.push(`“${what}” is cut (${el.scrollWidth} > ${el.clientWidth})`);
          if (r.left < edge - 1) out.push(`“${what}” runs into the one before`);
          if (r.right > b.right + 1) out.push(`“${what}” sticks out of the bar`);
          edge = r.right;
        }
        return out;
      });
    const boxes = () =>
      page.$$eval('[data-testid=files-list] [data-testid=file-row]', (rows) =>
        rows.map((r) => {
          const tick = r.querySelector('.pf-tick');
          return `${tick?.classList.contains('on') ? 'on' : 'off'}:${tick ? getComputedStyle(tick).opacity : 'none'}`;
        }),
      );
    const out = [];
    // Linux's and Windows' faces are wider than the Mac's: at 360 with the brand fonts blocked and a wide face forced,
    // the first row's ⋯ sits where its menu opens over it, as on CI (the tap's click then landed on the menu's frame)
    for (const { lang, w, wide } of [
      { lang: 'en', w: 390, wide: false },
      { lang: 'de', w: 390, wide: false },
      { lang: 'en', w: 360, wide: true },
    ]) {
      const p = await browser.newPage();
      const english = page;
      page = p;
      page.on('pageerror', (x) => errors.push(x.message));
      try {
        await intercept(page);
        blockFonts = wide;
        if (wide) {
          await page.evaluateOnNewDocument(() => {
            const face = document.createElement('style');
            face.textContent = '*, *::before, *::after { font-family: Verdana, "DejaVu Sans", sans-serif !important; }';
            document.addEventListener('DOMContentLoaded', () => document.head.append(face));
          });
        }
        await page.evaluateOnNewDocument((l) => {
          try {
            localStorage.setItem('vr.lang', l);
          } catch {}
        }, lang);
        await page.setViewport({ width: w, height: 844, isMobile: true, hasTouch: true });
        await open(campaign(`?path=${e('Footage/Day 1')}`));
        // a finger has no pointer to bring a box out with: none until picking starts
        assert(
          (await boxes()).every((x) => x === 'off:0'),
          `boxes before picking: ${await boxes()}`,
        );
        await page.tap('[data-testid=file-row] .pf-more');
        await page.waitForSelector('[role=menuitem]');
        // ⋯ opens its menu, never the file under it, wherever the menu opens
        assert(!(await page.$('[data-testid=file-sheet]')), `@${w}${wide ? ' (wide face)' : ''}: the tap on ⋯ opened the file too`);
        const picked = await page.evaluate(
          (word) => {
            const item = [...document.querySelectorAll('[role=menuitem]')].find((x) => x.textContent.trim() === word);
            item?.click();
            return !!item;
          },
          lang === 'de' ? 'Auswählen' : 'Select',
        );
        assert(picked, 'no Select in the row’s ⋯');
        await page.waitForSelector('[data-testid=files-selbar]');
        // the menu's sheet goes with an animation, its scrim over the list until then (on CI's slower compositor,
        // long enough to take the next taps): each box is tapped once nothing lies over it, and holds before the next
        const over = (i) =>
          page.evaluate((i) => {
            const t = document.querySelectorAll('[data-testid=file-row] .pf-tick')[i];
            const r = t.getBoundingClientRect();
            const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return !el || t.contains(el)
              ? null
              : `${el.tagName.toLowerCase()}.${String(el.className?.baseVal ?? el.className)
                  .trim()
                  .split(/\s+/)
                  .join('.')}`;
          }, i);
        await page.waitForFunction(() => !document.querySelector('[role=menu]'));
        for (const i of [1, 2]) {
          await until(
            async () => (await over(i)) === null,
            async () => `row ${i + 1}'s box is under ${await over(i)}`,
          );
          await (await page.$$('[data-testid=file-row] .pf-tick'))[i].tap();
          await until(
            async () => (await boxes())[i] === 'on:1',
            async () => `row ${i + 1}'s box after its tap: ${(await boxes()).join()}`,
          );
        }
        const ticked = (x) => x.slice(0, 3).every((y) => y === 'on:1') && x.slice(3).every((y) => y === 'off:1');
        await until(async () => ticked(await boxes()), 'three ticked, every box shown').catch(async () => {
          throw new Error(`ticked rows: ${await boxes()}`);
        });
        await settle(page, { quiet: 300 });
        for (const x of await barFits()) out.push(`${lang} @${w}: ${x}`);
        await shot(`files-picked-${w}-${lang}${wide ? '-wide' : ''}`);
        if (wide) continue;
        // a tablet and a small laptop, with a pointer (the phone's layout is another page: picked afresh)
        for (const w of [768, 1024]) {
          await page.setViewport({ width: w, height: 900 });
          await open(campaign(`?path=${e('Footage/Day 1')}`));
          for (const i of [0, 1, 2]) {
            const row = (await page.$$('[data-testid=file-row]'))[i];
            await row.hover();
            await (await row.$('.pf-tick')).click();
          }
          await page.waitForFunction(() => document.querySelectorAll('[data-testid=file-row] .pf-tick.on').length === 3);
          await settle(page, { quiet: 300 });
          for (const x of await barFits()) out.push(`${lang} @${w}: ${x}`);
        }
      } finally {
        blockFonts = false;
        page = english;
        await p.close();
      }
    }
    assert(!out.length, out.join('\n'));
  });

  await check('the House’s files in Settings → Files, the same page', async () => {
    await open('#/settings/files');
    const names = await rowNames();
    assert(names.join() === 'Fonts,LUTs', names.join());
    await shot('files-house-1440');
  });

  await check('loading: the real layout, and nothing moves when the files arrive', async () => {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width: 1440, height: 900 });
    await p.evaluateOnNewDocument(() => {
      window.__shift = 0;
      new PerformanceObserver((l) => {
        for (const x of l.getEntries()) if (!x.hadRecentInput) window.__shift += x.value;
      }).observe({ type: 'layout-shift', buffered: true });
    });
    let held = true;
    await p.setRequestInterception(true);
    p.on('request', async (req) => {
      if (held && /\/api\/files(\/summary)?\?/.test(req.url())) {
        await until(() => !held, 'released', 30_000).catch(() => {});
      }
      req.continue().catch(() => {});
    });
    // a visit before, so the library and the chrome are what this browser knows
    await p.goto(`${BASE}/#/folder/${e(CAMPAIGN)}`);
    await p.waitForSelector('[data-testid=folder-tab-files]');
    await p.goto(`${BASE}/${campaign()}`);
    await p.waitForSelector('[data-testid=files] .pf-row.pending');
    const where = () =>
      p.evaluate(() =>
        Object.fromEntries(
          ['.pf-head', '.pf-bar', '.pf-cols', '[data-testid=files-search]', '[data-testid=files-add]'].map((s) => [
            s,
            Math.round(document.querySelector(s)?.getBoundingClientRect().top ?? -1),
          ]),
        ),
      );
    const before = await where();
    held = false;
    await p.waitForSelector('[data-testid=files][aria-busy=false] [data-testid=dir-row]');
    await settle(p, { quiet: 1000 });
    const after = await where();
    for (const [s, y] of Object.entries(before)) assert(Math.abs(y - after[s]) <= 2 && y >= 0, `${s} moved ${y} → ${after[s]}`);
    const shift = await p.evaluate(() => window.__shift);
    assert(shift < 0.02, `layout shift ${shift.toFixed(3)}`);
    await ctx.close();
  });

  await check('every state at 390–1920 in both themes fits, and German fits too', async () => {
    const out = [];
    const states = {
      'campaign files': () => open(campaign()),
      'a folder of footage': () => open(campaign(`?path=${e('Footage/Day 1')}`)),
      'a file opened': async () => {
        await open(campaign(`?path=${e('Project')}`));
        await page.$$eval('[data-testid=file-row]', (rows) => rows.find((r) => r.querySelector('.pf-name')?.textContent === 'spot.aep')?.click());
        await page.waitForSelector('[data-testid=file-sheet] [data-testid=file-version]');
      },
      trash: () => open(campaign('?trash=1'), { wait: '[data-testid=files-trash]' }),
      'an empty folder': () => open(campaign(`?path=${e('Renders for review')}`)),
    };
    const run = async (lang) => {
      out.push(
        ...(
          await layoutMatrix(page, states, {
            show: dataTheme,
            widths: [390, 768, 1024, 1280, 1440, 1920],
            each: async (w, theme) => {
              if (SHOTS && (w === 390 || w === 1440 || w === 768))
                await page.screenshot({ path: path.join(SHOTS, `files-matrix-${lang}-${theme}-${w}-${Date.now()}.png`) });
            },
          })
        ).map((x) => `${lang}: ${x}`),
      );
    };
    await run('en');
    // German: a page that starts in it (the language is picked before the first paint)
    const english = page;
    page = await browser.newPage();
    page.on('pageerror', (x) => errors.push(x.message));
    await intercept(page);
    await page.evaluateOnNewDocument(() => {
      try {
        localStorage.setItem('vr.lang', 'de');
      } catch {}
    });
    try {
      await run('de');
    } finally {
      await page.close();
      page = english;
    }
    assert(!out.length, out.join('\n'));
  });

  await check('no page errors along the way', async () => {
    assert(!errors.length, errors.join(' | '));
  });
  void ids;
} catch (err) {
  crashed(err, srv);
} finally {
  await finish(LABEL, { browser, servers: [srv] });
}
