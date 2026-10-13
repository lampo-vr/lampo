#!/usr/bin/env node
// covers: web/src/library/select.ts web/src/library/SelectBar.tsx web/src/library/PickBox.tsx web/src/styles/library-select.css
// covers: web/src/library/Library.tsx web/src/library/FilmList.tsx web/src/library/Film.tsx web/src/library/Toolbar.tsx
// covers: web/src/library/useVideoMenu.tsx web/src/library/FolderPicker.tsx web/src/styles/library.css web/src/styles/cards.css
// covers: web/src/share/ShareModal.tsx web/src/share/LinkCard.tsx web/src/settings/Links.tsx web/src/guest/Guest.tsx
// covers: web/src/guest/Room.tsx server/routes/shares/ lib/shares.ts lib/shareSet.ts
// Browser end-to-end test of picking several videos in the library (List and Grid, the Files tab's way): the box at a
// row's start under the pointer and on every row once one is ticked, ⌘-click, ⇧-click's run, ⌘A in the list (never in
// a field), Esc; the bar at the window's foot ("3 selected", announced) that keeps its room at the list's end; Move to…
// for all of them with one Undo; Archive with one Undo for all, where what may not be archived stays ticked and the bar
// says why (a video without notes; a member's videos someone else added, on a hosted server); Share as one link: one
// review link for exactly the ticked videos, whose visitor sees those and nothing else, listed in Settings → Review
// links with its videos; a view, filter or the board starting with none; a phone's "Select videos" at 390. A synthetic library (generated clips, made-up names) in
// both themes; screenshots land in LAMPO_SHOTS if set.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { age, makeVideo, ROOT, until } from '../lib/helpers.ts';
import { client, tusUpload } from '../lib/http.ts';
import { settle } from './layout.mjs';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'library-select e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-library-select-e2e-', user: 'Sam' });
const { dir, base: BASE } = srv;
const api = jsonApi(BASE);
const enc = encodeURIComponent;
const servers = [srv];

let browser;
try {
  // ---------------------------------------------------------------- a studio's library: three projects and No project
  const PATTERNS = ['testsrc2', 'smptebars', 'rgbtestsrc', 'colorspectrum', 'pal75bars', 'yuvtestsrc', 'testsrc', 'smptehdbars'];
  let n = 0;
  const add = async (name, folder, { versions = 1, notes = [], w = 320, h = 180 } = {}) => {
    const file = path.join(dir, 'renders', (folder || 'loose').replace(/\W+/g, '-'), name);
    const clip = (v) => {
      makeVideo(file, { w, h, fps: 25, dur: 2, pattern: PATTERNS[(n + v) % PATTERNS.length], freq: 220 + 40 * ((n + v) % 9) });
      age(file, 600 - v * 60);
    };
    n++;
    clip(1);
    const { video } = await api('/api/library', 'POST', { path: file, folder });
    for (let v = 2; v <= versions; v++) {
      clip(v);
      await until(async () => (await api(`/api/review/${enc(video.slug)}/sync`, 'POST')).version, `${name} V${v}`);
    }
    for (const [text, severity = 'should'] of notes) await api(`/api/review/${enc(video.slug)}/comments`, 'POST', { frame: 10, text, severity });
    return video.slug;
  };
  const v = {
    titles: await add('opening-titles.mp4', 'Saltmarsh', { versions: 3, notes: [['Title card holds two frames too long', 'must'], ['Softer fade in']] }),
    drone: await add('drone-sequence.mp4', 'Saltmarsh', { versions: 2, notes: [['Horizon tilts at the cut']] }),
    interview: await add('interview-cut.mp4', 'Saltmarsh/Interviews', { notes: [['Lower third overlaps the face']] }),
    teaser: await add('teaser-15s.mp4', 'Copperline', { versions: 3, notes: [['Logo too early', 'must'], ['Music ends abruptly']] }),
    loop: await add('product-loop.mp4', 'Copperline', { versions: 2 }),
    social: await add('social-9x16.mp4', 'Copperline', { w: 180, h: 320, notes: [['Safe area: caption cut off']] }),
    recap: await add('event-recap.mp4', 'Field Notes', { versions: 2, notes: [['Warmer grade']] }),
    bts: await add('behind-the-scenes.mp4', 'Field Notes'),
    card: await add('end-card.mp4', null, { versions: 3, notes: [['Wrong URL on the card', 'must']] }),
    sting: await add('logo-sting.mp4', null),
  };
  await api(`/api/review/${enc(v.drone)}/approval`, 'PUT', { status: 'approved' });
  await api(`/api/review/${enc(v.recap)}/approval`, 'PUT', { status: 'approved' });
  await api(`/api/review/${enc(v.recap)}/final`, 'PUT', { confirm: true });
  const folderOf = async (slug) => (await api('/api/library')).videos.find((x) => x.slug === slug)?.folder ?? null;
  const archivedOf = async (slug) => !!(await api('/api/library')).videos.find((x) => x.slug === slug)?.archived;

  browser = await launch();
  const page = await browser.newPage();
  screenshotFailures(() => page, 'library-select');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 });
  const shot = async (name, p = page) => SHOTS && p.screenshot({ path: path.join(SHOTS, `library-select-${name}.png`) });
  const theme = (p, t) => p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: t }]);
  await theme(page, 'dark');
  const open = async (hash = '#/', layout = '3') => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=library-content]', { timeout: 20000 });
    await page.waitForFunction(() => !document.activeViewTransition);
    await page.keyboard.press(layout);
    await page.waitForSelector(layout === '3' ? '[data-testid=library-list] tr.lrow' : layout === '4' ? '.board' : '.film[data-slug]', { timeout: 20000 });
  };
  const row = (slug) => `tr.lrow[data-slug="${slug}"]`;
  const card = (slug) => `.film[data-slug="${slug}"]`;
  const ticked = () => page.$$eval('[data-slug].checked', (els) => els.map((e) => e.getAttribute('data-slug')));
  const barText = () => page.$eval('[data-testid=library-selbar] .lsel-n', (e) => e.textContent.trim()).catch(() => null);
  const noBar = () => until(async () => !(await page.$('[data-testid=library-selbar]')), 'the bar gone');
  const boxShown = (sel) => page.$eval(`${sel} [data-testid=pick]`, (b) => Number(getComputedStyle(b).opacity) > 0.9);
  const clickRow = async (slug, mods = []) => {
    // on the row's date cell: the name is a link, the menu a button
    for (const m of mods) await page.keyboard.down(m);
    await page.click(`${row(slug)} .lc-date`);
    for (const m of mods.reverse()) await page.keyboard.up(m);
  };
  const toastGone = () => until(async () => !(await page.$('[data-testid=toast]')), 'the toast gone');

  await check('List: a box at a row’s start under the pointer, none at rest; the list says it takes several', async () => {
    await open();
    const table = await page.$eval('[data-testid=library-list]', (t) => ({ role: t.getAttribute('role'), multi: t.getAttribute('aria-multiselectable') }));
    assert(table.role === 'grid' && table.multi === 'true', `the list is a multi-selectable grid: ${JSON.stringify(table)}`);
    assert(!(await boxShown(row(v.teaser))), 'no box at rest');
    await page.hover(`${row(v.teaser)} .lc-date`);
    await until(() => boxShown(row(v.teaser)), 'the box under the pointer');
    assert(!(await boxShown(row(v.titles))), 'only the row under the pointer shows one');
    const label = await page.$eval(`${row(v.teaser)} [data-testid=pick]`, (b) => ({
      role: b.getAttribute('role'),
      name: b.getAttribute('aria-label'),
      checked: b.getAttribute('aria-checked'),
    }));
    assert(
      label.role === 'checkbox' && label.name === 'Select teaser-15s.mp4' && label.checked === 'false',
      `a checkbox named after the video: ${JSON.stringify(label)}`,
    );
    await settle(page);
    await shot('01-list-hover-1440');
  });

  await check('⌘-click ticks a row, ⇧-click the run from it, the box one more; the bar counts them and says so', async () => {
    await open();
    const order = await page.$$eval('tr.lrow', (rs) => rs.map((r) => r.getAttribute('data-slug')));
    await clickRow(order[1], ['Meta']);
    await page.waitForSelector('[data-testid=library-selbar]');
    assert((await ticked()).join() === order[1], `⌘-click ticks one: ${await ticked()}`);
    assert(!(await page.evaluate(() => location.hash)).startsWith('#/v/'), '⌘-click never opens the video');
    await clickRow(order[3], ['Shift']);
    await until(
      async () => (await ticked()).length === 3,
      async () => `the run: ${await ticked()}`,
    );
    assert((await ticked()).join() === order.slice(1, 4).join(), `⇧ ticks the run in view order: ${await ticked()}`);
    await page.click(`${row(order[6])} [data-testid=pick]`);
    await until(
      async () => (await barText()) === '4 selected',
      async () => `the count: ${await barText()}`,
    );
    const status = await page.$eval('[data-testid=library-selbar] .lsel-n', (e) => e.getAttribute('role'));
    assert(status === 'status', 'the count is announced');
    const sel = await page.$$eval('tr.lrow[aria-selected=true]', (rs) => rs.length);
    assert(sel === 4, `rows say they are selected: ${sel}`);
    // every row shows its box while picking
    assert(await boxShown(row(order[8])), 'every row shows its box once one is ticked');
    // a ticked row is one flat fill, never raised, never the orange
    const look = await page.$eval(`${row(order[1])} td`, (td) => ({ bg: getComputedStyle(td).backgroundColor, shadow: getComputedStyle(td).boxShadow }));
    const rest = await page.$eval(`${row(order[9])} td`, (td) => getComputedStyle(td).backgroundColor);
    assert(look.bg !== rest && look.shadow === 'none', `a ticked row is a flat fill: ${JSON.stringify(look)} vs ${rest}`);
    await page.click(`${row(order[1])} [data-testid=pick]`);
    await until(async () => (await barText()) === '3 selected', 'the box unticks');
    await page.mouse.move(5, 5);
    await settle(page);
    await shot('02-three-selected-bar-dark');
    await theme(page, 'light');
    await settle(page);
    await shot('02-three-selected-bar-light');
    await theme(page, 'dark');
  });

  await check('Esc lets go of all; ⌘A ticks every video in view from the list, never from a field', async () => {
    await page.keyboard.press('Escape');
    await noBar();
    assert(!(await ticked()).length, 'none ticked');
    await page.focus(`${row(v.teaser)} .lname a`);
    await page.keyboard.down('Meta');
    await page.keyboard.press('a');
    await page.keyboard.up('Meta');
    await until(
      async () => (await barText()) === '10 selected',
      async () => `⌘A: ${await barText()}`,
    );
    await page.keyboard.press('Escape');
    await noBar();
    await page.focus('.lib-filter input');
    await page.keyboard.down('Meta');
    await page.keyboard.press('a');
    await page.keyboard.up('Meta');
    await new Promise((r) => setTimeout(r, 300));
    assert(!(await page.$('[data-testid=library-selbar]')), '⌘A in the filter selects its text, not the videos');
    // X ticks the row the keys are on
    await page.focus(`${row(v.loop)} .lname a`);
    await page.keyboard.press('x');
    await until(async () => (await ticked()).join() === v.loop, 'X ticks the focused row');
    await page.keyboard.press('Escape');
    await noBar();
  });

  await check('the bar floats at the window’s foot and keeps its room: the last row is never under it', async () => {
    await page.setViewport({ width: 1440, height: 560 });
    try {
      await open();
      const last = await page.$$eval('tr.lrow', (rs) => rs.at(-1).getAttribute('data-slug'));
      // the end in view as the bar comes: the page moves on by its room
      await page.$eval('.lib-scroll', (s) => {
        s.scrollTop = s.scrollHeight;
      });
      await clickRow(last, ['Meta']);
      await page.waitForSelector('[data-testid=library-selbar]');
      await settle(page);
      const covered = (slug) =>
        page.evaluate((sel) => {
          const r = document.querySelector(sel).getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return !hit?.closest('tr.lrow');
        }, row(slug));
      assert(!(await covered(last)), 'the last row stays clear of the bar as it comes');
      // scrolled up, it floats over the rows at the window's foot
      await page.$eval('.lib-scroll', (s) => {
        s.scrollTop = 0;
      });
      await settle(page);
      const geo = await page.evaluate(() => {
        const bar = document.querySelector('[data-testid=library-selbar]').getBoundingClientRect().toJSON();
        const scroller = document.querySelector('.lib-scroll').getBoundingClientRect().toJSON();
        const list = document.querySelector('[data-testid=library-list]').getBoundingClientRect().toJSON();
        const cs = getComputedStyle(document.querySelector('[data-testid=library-selbar]'));
        return { bar, scroller, list, position: cs.position, shadow: cs.boxShadow, radius: cs.borderTopLeftRadius };
      });
      assert(geo.position === 'sticky' && geo.shadow !== 'none', `one float: ${geo.position} ${geo.shadow}`);
      assert(
        geo.bar.bottom <= geo.scroller.bottom && geo.scroller.bottom - geo.bar.bottom < 40,
        `at the window's foot: ${geo.bar.bottom} / ${geo.scroller.bottom}`,
      );
      assert(geo.bar.width < geo.list.width, 'narrower than the list');
      await page.$eval('.lib-scroll', (s) => {
        s.scrollTop = 200;
      });
      await settle(page);
      const floating = await page.$eval('[data-testid=library-selbar]', (b) => b.getBoundingClientRect().bottom);
      assert(Math.abs(floating - geo.bar.bottom) < 2, 'it stays at the foot while the list scrolls');
      // at the end, again none under it
      await page.$eval('.lib-scroll', (s) => {
        s.scrollTop = s.scrollHeight;
      });
      await settle(page);
      assert(!(await covered(last)), 'at the end the last row is clear of the bar');
      await page.keyboard.press('Escape');
    } finally {
      await page.setViewport({ width: 1440, height: 900 });
    }
  });

  await check('ticked videos belong to the view: a filter, another project or the board start with none; Grid keeps them', async () => {
    await open();
    await clickRow(v.teaser, ['Meta']);
    await clickRow(v.loop, ['Meta']);
    await until(async () => (await barText()) === '2 selected', 'two');
    await page.keyboard.press('1');
    await page.waitForSelector(`${card(v.teaser)}.checked`);
    assert((await ticked()).sort().join() === [v.teaser, v.loop].sort().join(), 'the grid shows the same two');
    assert(await boxShown(card(v.titles)), 'every card shows its box while picking');
    await page.keyboard.press('4');
    await noBar();
    await page.keyboard.press('3');
    await page.waitForSelector('tr.lrow');
    assert(!(await ticked()).length, 'back from the board, none');
    await clickRow(v.teaser, ['Meta']);
    await page.waitForSelector('[data-testid=library-selbar]');
    await page.type('.lib-filter input', 'loop');
    await noBar();
    await page.click('.lib-filter-clear');
    await clickRow(v.teaser, ['Meta']);
    await page.waitForSelector('[data-testid=library-selbar]');
    await page.evaluate(() => {
      location.hash = '#/folder/Copperline';
    });
    await noBar();
  });

  await check('Grid: a card’s box under the pointer, ⌘-click ticks it, a plain click still opens it', async () => {
    await open('#/', '1');
    assert(!(await boxShown(card(v.drone))), 'no box at rest');
    await page.hover(card(v.drone));
    await until(() => boxShown(card(v.drone)), 'the box under the pointer');
    await page.keyboard.down('Meta');
    await page.click(`${card(v.drone)} .film-title`);
    await page.keyboard.up('Meta');
    await until(async () => (await ticked()).join() === v.drone, 'ticked');
    await page.click(`${card(v.card)} [data-testid=pick]`);
    await until(async () => (await barText()) === '2 selected', 'the box ticks');
    await page.mouse.move(5, 5);
    await settle(page);
    await shot('03-grid-two-selected');
    await page.keyboard.press('Escape');
    await noBar();
    await page.click(`${card(v.drone)} .film-title`);
    await page.waitForFunction(() => location.hash.startsWith('#/v/'));
  });

  await check('Move to… moves every ticked video with one dialog, one toast and one Undo that puts each back', async () => {
    await open();
    for (const s of [v.titles, v.teaser, v.sting]) await clickRow(s, ['Meta']);
    await until(async () => (await barText()) === '3 selected', 'three');
    await page.click('[data-testid=library-sel-move]');
    await page.waitForSelector('.modal [data-testid=folder-picker]');
    const title = await page.$eval('.modal .modal-head h3', (e) => e.textContent.trim());
    assert(title.includes('Move 3 videos'), `the dialog says how many: ${title}`);
    await settle(page);
    await shot('04-move-dialog');
    await page.type('.modal .fp-input', 'Field Notes');
    await page.keyboard.press('Enter');
    await page.click('[data-testid=library-move-many]');
    await page.waitForSelector('[data-testid=toast]');
    const toast = await page.$eval('[data-testid=toast]', (e) => e.textContent);
    assert(toast.includes('Moved 3 videos to Field Notes'), `one toast: ${toast}`);
    await until(
      async () => (await folderOf(v.titles)) === 'Field Notes' && (await folderOf(v.teaser)) === 'Field Notes' && (await folderOf(v.sting)) === 'Field Notes',
      'all three moved',
    );
    await noBar();
    await page.click('[data-testid=toast] .toast-act');
    await until(
      async () => (await folderOf(v.titles)) === 'Saltmarsh' && (await folderOf(v.teaser)) === 'Copperline' && (await folderOf(v.sting)) === null,
      'Undo puts each back where it was',
    );
    await toastGone();
  });

  await check('Archive archives the ticked videos with one Undo for all; one without notes stays ticked, and the bar says why', async () => {
    await open();
    for (const s of [v.interview, v.social, v.bts]) await clickRow(s, ['Meta']);
    await until(async () => (await barText()) === '3 selected', 'three');
    await page.click('[data-testid=library-sel-archive]');
    await page.waitForSelector('[data-testid=toast]');
    assert((await page.$eval('[data-testid=toast]', (e) => e.textContent)).includes('Archived 2 videos'), 'one toast for both');
    await until(async () => (await archivedOf(v.interview)) && (await archivedOf(v.social)), 'both archived');
    assert(!(await archivedOf(v.bts)), 'the one without notes is not');
    await until(
      async () => (await ticked()).join() === v.bts,
      async () => `it stays ticked: ${await ticked()}`,
    );
    const why = await page.$eval('[data-testid=library-selbar-why]', (e) => e.textContent);
    assert(why.includes('“behind-the-scenes.mp4” has no notes to keep'), `the bar says why: ${why}`);
    await settle(page);
    // the toasts' stack stands above the bar at the window's foot (--toast-lift), never over its reason or its buttons
    const over = await page.evaluate(() => {
      const bar = document.querySelector('[data-testid=library-selbar]').getBoundingClientRect();
      const toast = document.querySelector('[data-testid=toast][data-state=open]').getBoundingClientRect();
      return { bar: Math.round(bar.top), toast: Math.round(toast.bottom) };
    });
    assert(over.toast <= over.bar, `the toast stands above the bar: ${JSON.stringify(over)}`);
    await shot('05-archive-why');
    await page.click('[data-testid=toast] .toast-act');
    await until(async () => !(await archivedOf(v.interview)) && !(await archivedOf(v.social)), 'Undo restores both');
    await toastGone();
    await page.keyboard.press('Escape');
    await noBar();
  });

  await check('under a short list the bar stands above the foot: the toasts stand above it, or keep the foot when there is room under it', async () => {
    // a window taller than the list: the bar stands under its last row, not at the window's foot
    await page.setViewport({ width: 1440, height: 2400, deviceScaleFactor: SHOTS ? 2 : 1 });
    await open();
    for (const s of [v.interview, v.social]) await clickRow(s, ['Meta']);
    await until(async () => (await barText()) === '2 selected', 'two');
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent('vr-toast', { detail: { id: Math.random(), kind: 'error', message: 'Couldn’t send: the server didn’t answer.' } })),
    );
    await page.waitForSelector('[data-testid=toast][data-state=open]');
    const where = async () => {
      await settle(page);
      return page.evaluate(() => {
        const b = document.querySelector('[data-testid=library-selbar]').getBoundingClientRect();
        const t = document.querySelector('[data-testid=toast][data-state=open]').getBoundingClientRect();
        return { h: innerHeight, bar: [Math.round(b.top), Math.round(b.bottom)], toast: [Math.round(t.top), Math.round(t.bottom)] };
      });
    };
    const clear = (at) => at.toast[1] <= at.bar[0] || at.toast[0] >= at.bar[1];
    // plenty of room under the bar: the toast keeps the window's foot
    const far = await where();
    assert(far.h - far.bar[1] > 200, `the bar stands well above the foot: ${JSON.stringify(far)}`);
    assert(clear(far) && Math.abs(far.h - 20 - far.toast[1]) <= 1, `the toast at the foot, under the bar: ${JSON.stringify(far)}`);
    // a window a little taller than the list (its margin and the page's 64 px end still fit): the bar stands a step
    // above the foot, where the toasts lifted by its height alone covered it
    await page.setViewport({ width: 1440, height: far.bar[1] + 84, deviceScaleFactor: SHOTS ? 2 : 1 });
    await until(async () => (await where()).bar[1] === far.bar[1], 'the bar where it stood');
    const near = await where();
    assert(near.h - near.bar[1] > 12 && near.h - near.bar[1] < 120, `the bar a step above the foot: ${JSON.stringify(near)}`);
    assert(clear(near) && near.toast[1] <= near.bar[0], `the toast stands above the bar: ${JSON.stringify(near)}`);
    await shot('05b-toast-over-short-list');
    await page.$eval('[data-testid=toast] .toast-x', (b) => b.click());
    await toastGone();
    await page.keyboard.press('Escape');
    await noBar();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 });
  });

  await check('Share as one link: one review link for exactly the ticked videos; its visitor sees those and nothing else', async () => {
    await open();
    const NAMES = { [v.titles]: 'opening-titles.mp4', [v.teaser]: 'teaser-15s.mp4', [v.card]: 'end-card.mp4' };
    // in the view's order (by project), as the bar hands them on
    const picked = (await page.$$eval('tr.lrow', (rs) => rs.map((r) => r.getAttribute('data-slug')))).filter((s) => s in NAMES);
    const names = picked.map((s) => NAMES[s]);
    for (const s of picked) await clickRow(s, ['Meta']);
    await until(async () => (await barText()) === '3 selected', 'three');
    await page.click('[data-testid=library-sel-share]');
    await page.waitForSelector('.modal [data-testid=link-create]');
    const dialog = await page.$eval('.modal', (m) => ({
      title: m.querySelector('.modal-head h3').textContent.trim(),
      set: m.querySelector('[data-testid=link-videos]')?.textContent.trim(),
      kinds: m.querySelector('.link-kind').textContent,
    }));
    assert(dialog.title === 'Share 3 videos', `the dialog says how many: ${dialog.title}`);
    assert(dialog.set === `${names[0]}, ${names[1]}, +1`, `it names them: ${dialog.set}`);
    assert(dialog.kinds.includes('Watch only') && !dialog.kinds.includes('Embed'), `a room's kinds, never an embed: ${dialog.kinds}`);
    await page.type('[data-testid=link-name]', 'Robin at the agency');
    await settle(page);
    await shot('07-share-dialog-3-videos-dark');
    await theme(page, 'light');
    await settle(page);
    await shot('07-share-dialog-3-videos-light');
    await theme(page, 'dark');
    await page.click('[data-testid=link-create]');
    await page.waitForSelector('.modal .link-row');
    const link = (await api('/api/shares')).shares.find((s) => s.kind === 'set' && s.label === 'Robin at the agency');
    assert(link, 'the link is made');
    assert(link.videos.map((x) => x.slug).join() === picked.join(), `for exactly those, in their order: ${JSON.stringify(link.videos)}`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.modal'));
    await page.keyboard.press('Escape');
    await noBar();

    // its visitor: a room with exactly those three, no project named; each opens; another video answers as an unknown one
    const guest = await browser.newPage();
    await guest.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 });
    await theme(guest, 'dark');
    guest.on('pageerror', (e) => errors.push(e.message));
    await guest.goto(`${BASE}/g/${link.token}`, { waitUntil: 'domcontentloaded' });
    await guest.waitForSelector('.room .film');
    const room = await guest.$eval('.room', (r) => ({ names: [...r.querySelectorAll('.film-title')].map((e) => e.textContent.trim()), text: r.textContent }));
    assert(room.names.join() === names.join(), `exactly the three: ${room.names}`);
    for (const word of ['Saltmarsh', 'Copperline', 'Field Notes', 'product-loop', 'drone-sequence'])
      assert(!room.text.includes(word), `no ${word} in the room`);
    await settle(guest);
    await shot('08-guest-room', guest);
    const g = await (await fetch(`${BASE}/api/g/${link.token}`)).json();
    assert(g.kind === 'set' && g.folder === null && g.videos.every((x) => x.folder === null), 'no folder named to the visitor');
    const unknown = await fetch(`${BASE}/api/g/${link.token}/review/v_AAAAAAAAAAAAAAAA`);
    for (const other of [v.loop, v.drone]) {
      const r = await fetch(`${BASE}/api/g/${link.token}/review/${enc(other)}`);
      assert(r.status === 404 && r.status === unknown.status, `${other}: ${r.status}`);
      assert((await r.text()) === (await unknown.clone().text()), 'answered as an unknown video');
    }
    await guest.click('.room .film');
    await guest.waitForSelector('[data-testid=g-subtitle]', { timeout: 20000 });
    await guest.close();

    // Settings → Review links: the link with its videos
    await page.goto(`${BASE}/#/settings/links`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=links-list]');
    const line = await page.$$eval('[data-testid=link-row]', (rows) => rows.map((r) => r.textContent).find((t) => t.includes('Robin at the agency')));
    assert(line?.includes(`3 videos: ${names[0]}, ${names[1]}, +1`), `listed with its videos: ${line}`);
    await settle(page);
    await shot('09-settings-links');
  });

  await check('a phone: no boxes at rest; "Select videos" in Display shows them, a tap ticks, the bar fits at 390', async () => {
    const phone = await browser.newPage();
    await phone.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true }, userAgent: await browser.userAgent() });
    await theme(phone, 'dark');
    phone.on('pageerror', (e) => errors.push(e.message));
    await phone.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await phone.waitForSelector('[data-testid=library-content]');
    await phone.waitForSelector('.film[data-slug], tr.lrow');
    const shown = (p) => p.$$eval('[data-testid=pick]', (bs) => bs.filter((b) => Number(getComputedStyle(b).opacity) > 0.9).length);
    assert((await shown(phone)) === 0, 'no boxes at rest on a touch screen');
    await phone.tap('.lib-display');
    await phone.waitForSelector('[data-testid=lib-pick]');
    await phone.tap('[data-testid=lib-pick]');
    await phone.waitForSelector('[data-testid=library-selbar]');
    await until(async () => (await shown(phone)) > 3, 'every box shows');
    // the list or the cards, whichever this browser shows: a tap on the item ticks it
    const first = await phone.$$eval('[data-testid=library-content] [data-slug]', (cs) => cs.map((c) => c.getAttribute('data-slug')));
    await phone.tap(`[data-testid=library-content] [data-slug="${first[0]}"]`);
    await phone.tap(`[data-testid=library-content] [data-slug="${first[1]}"]`);
    await until(async () => (await phone.$eval('[data-testid=library-selbar] .lsel-n', (e) => e.textContent)) === '2 selected', 'a tap ticks');
    assert(!(await phone.evaluate(() => location.hash)).startsWith('#/v/'), 'a tap while picking never opens');
    const fit = await phone.evaluate(() => {
      const bar = document.querySelector('[data-testid=library-selbar]').getBoundingClientRect();
      const small = [...document.querySelectorAll('[data-testid=library-selbar] .btn')]
        .map((b) => b.getBoundingClientRect())
        .filter((r) => r.width < 44 || r.height < 44);
      return { left: bar.left, right: bar.right, width: innerWidth, small: small.length, scroll: document.documentElement.scrollWidth };
    });
    assert(fit.left >= 0 && fit.right <= fit.width && fit.scroll <= fit.width, `the bar fits at 390: ${JSON.stringify(fit)}`);
    assert(fit.small === 0, `every action a finger's size: ${fit.small} smaller`);
    await settle(phone);
    await shot('06-phone-390-dark', phone);
    await theme(phone, 'light');
    await settle(phone);
    await shot('06-phone-390-light', phone);
    await phone.close();
  });

  // ---------------------------------------------------------------- a hosted server: a member archives only what they added
  const hosted = await startServer({
    prefix: 'vr-library-select-hosted-',
    mode: 'server',
    publicUrl: true,
    seed: (env) =>
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const auth = await import(${JSON.stringify(path.join(ROOT, 'lib/auth.ts'))});
           const ws = await import(${JSON.stringify(path.join(ROOT, 'lib/workspaces.ts'))});
           await auth.createUser({ email: 'olivia@e2e.test', name: 'Olivia Hart', password: 'a long enough password', role: 'owner' });
           await auth.createUser({ email: 'jonas@e2e.test', name: 'Jonas Weber', password: 'a long enough password', role: 'member' });
           ws.migrateWorkspaces();`,
        ],
        { env, stdio: 'pipe' },
      ),
  });
  servers.push(hosted);

  await check('a hosted member: what someone else added stays ticked and the bar says why, their own is archived', async () => {
    const request = client(hosted.port);
    const origin = { Origin: hosted.base };
    const tokenOf = async (email) =>
      (await request('POST', '/api/auth/token', { body: { email, password: 'a long enough password' }, headers: origin })).json().token;
    const as = (token) => ({ Authorization: `Bearer ${token}` });
    const olivia = as(await tokenOf('olivia@e2e.test'));
    const jonas = as(await tokenOf('jonas@e2e.test'));
    const upload = async (who, name) => {
      const file = makeVideo(path.join(hosted.dir, 'in', name), { w: 320, h: 180, fps: 25, dur: 2, pattern: PATTERNS[n++ % PATTERNS.length] });
      const r = await tusUpload(request, file, { filename: name, folder: 'Saltmarsh' }, who);
      assert(r.status === 200, r.text);
      const slug = r.json().slug;
      const c = await request('POST', `/api/review/${enc(slug)}/comments`, { body: { frame: 5, text: 'Tighter cut here' }, headers: who });
      assert(c.status === 200, c.text);
      return slug;
    };
    const theirs = [await upload(olivia, 'opening-titles.mp4'), await upload(olivia, 'drone-sequence.mp4')];
    const own = await upload(jonas, 'interview-cut.mp4');
    const login = await request('POST', '/api/auth/login', { body: { email: 'jonas@e2e.test', password: 'a long enough password' }, headers: origin });
    const cookie = String([login.headers['set-cookie']].flat().find((c) => String(c).startsWith('vr_session=')) || '').split(';')[0];
    assert(cookie, login.text);
    const p = await browser.newPage();
    await p.setViewport({ width: 1440, height: 900 });
    await p.setCookie({ name: 'vr_session', value: cookie.split('=')[1], domain: new URL(hosted.base).hostname, path: '/', httpOnly: true });
    await p.goto(`${hosted.base}/#/`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('[data-testid=library-content]');
    await p.waitForFunction(() => !document.activeViewTransition);
    await p.keyboard.press('3');
    await p.waitForSelector('tr.lrow');
    await p.focus('tr.lrow .lname a');
    await p.keyboard.down('Meta');
    await p.keyboard.press('a');
    await p.keyboard.up('Meta');
    await p.waitForSelector('[data-testid=library-selbar]');
    await p.click('[data-testid=library-sel-archive]');
    await p.waitForSelector('[data-testid=library-selbar-why]');
    const left = await p.$$eval('[data-slug].checked', (els) => els.map((e) => e.getAttribute('data-slug')).sort());
    assert(left.join() === [...theirs].sort().join(), `what someone else added stays ticked: ${left}`);
    const why = await p.$eval('[data-testid=library-selbar-why]', (e) => e.textContent);
    assert(why.includes('not yours to change'), `the bar says why: ${why}`);
    const lib = (await request('GET', '/api/library', { headers: olivia })).json().videos;
    assert(lib.find((x) => x.slug === own)?.archived, 'their own is archived');
    assert(
      theirs.every((s) => !lib.find((x) => x.slug === s)?.archived),
      'the others are not',
    );
    await p.close();
  });

  await check('no errors on the pages', async () => {
    assert(!errors.length, errors.join('\n'));
  });
} catch (e) {
  crashed(e, ...servers);
}
await finish(LABEL, { browser, servers });
