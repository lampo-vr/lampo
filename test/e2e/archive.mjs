#!/usr/bin/env node
// covers: web/src/library/Archived.tsx web/src/library/ArchivedBanner.tsx web/src/library/archiving.ts web/src/library/Sidebar.tsx
// covers: web/src/library/Library.tsx web/src/library/model.ts web/src/player/Player.tsx web/src/player/PlayerTopbar.tsx
// covers: web/src/palette/CommandPalette.tsx web/src/api/auth.ts lib/archived.ts lib/folderIds.ts lib/folders.ts
// Browser end-to-end test of archived projects (lib/archived.ts) at the machine (its owner): archived from the
// sidebar's ⋯ with Undo, the project leaves the sidebar, the library and the Inbox, the Archived row and page show it,
// its page and its videos' player say "Archived · Restore" where the main action stands and take nothing new, ⌘K keeps
// it in a group of its own, Restore brings everything back, and the pages fit a phone. Several projects, one archived,
// in both themes at 390, 1024 and 1440: screenshots land in VR_SHOTS if set.
import path from 'node:path';
import { age, makeVideo, until } from '../lib/helpers.ts';
import { layoutMatrix, settle } from './layout.mjs';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'archive e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-archive-e2e-', user: 'Sam' });
const { dir, base: BASE } = srv;
const api = jsonApi(BASE);
const enc = encodeURIComponent;

let browser;
try {
  // Three projects: Acme (two videos, a must note on one: the one archived), Globex (two), Initech (one).
  const add = async (rel, folder, o = {}) => {
    const file = makeVideo(path.join(dir, rel), { w: 320, h: 180, fps: 25, dur: 2, ...o });
    age(file);
    const { video } = await api('/api/library', 'POST', { path: file, folder });
    return video.slug;
  };
  const spot = await add('acme/export/spot.mp4', 'Acme/Reels', { pattern: 'testsrc2' });
  const teaser = await add('acme/export/teaser.mp4', 'Acme');
  const film = await add('globex/export/brand-film.mp4', 'Globex');
  const cut = await add('globex/export/cutdown.mp4', 'Globex', { freq: 660 });
  await add('initech/export/promo.mp4', 'Initech', { freq: 330 });
  await api(`/api/review/${enc(spot)}/comments`, 'POST', { frame: 3, text: 'Logo too early', severity: 'must' });
  await api(`/api/review/${enc(film)}/comments`, 'POST', { frame: 5, text: 'Warmer grade', severity: 'should' });
  await api(`/api/review/${enc(cut)}/approval`, 'PUT', { status: 'approved' });

  browser = await launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 });
  const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `archive-${name}.png`) });
  const open = async (hash = '#/', ready = '[data-testid=library-content]') => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(ready, { timeout: 20000 });
    await page.waitForFunction(() => !document.activeViewTransition);
  };
  const projectsInSidebar = () => page.$$eval('.nav .nav-item[title]', (els) => els.map((e) => e.getAttribute('title')).filter((x) => x && !x.includes(' › ')));
  const cards = () => page.$$eval('.film', (els) => els.map((e) => e.getAttribute('data-slug')));
  const archivedNow = async () => (await api('/api/library')).archived_projects ?? {};
  const toastGone = () => until(async () => !(await page.$('[data-testid=toast]')), 'the toast gone');
  const menuItem = (label) =>
    until(
      () =>
        page.$$('[role="menuitem"]').then(async (items) => {
          for (const it of items) if ((await it.evaluate((e) => e.textContent.trim())) === label) return it;
          return null;
        }),
      `the menu item ${label}`,
    );
  const projectMenu = async (name) => {
    const row = await page.waitForSelector(`.nav .nav-item[title="${name}"]`, { timeout: 15000 });
    await row.hover();
    const trigger = await row.waitForSelector('button[aria-label="Project actions"]', { visible: true });
    await trigger.click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-radix-popper-content-wrapper]')].every((w) => !w.style.transform.includes('-200%')));
  };

  await check('archive a project from the sidebar’s ⋯: it goes at once, Undo brings it back, and nothing reaches the server', async () => {
    await open();
    await until(async () => (await cards()).length === 5, 'five cards');
    assert((await projectsInSidebar()).join() === 'Acme,Globex,Initech', (await projectsInSidebar()).join());
    assert(!(await page.$('[data-testid=nav-archived]')), 'no Archived row while nothing is');
    await projectMenu('Acme');
    await shot('01-project-menu');
    await (await menuItem('Archive project')).click();
    await until(async () => (await projectsInSidebar()).join() === 'Globex,Initech', 'Acme out of the sidebar at once');
    await until(async () => (await cards()).length === 3, 'its videos out of the library');
    await page.waitForSelector('[data-testid=nav-archived]');
    const counted = await page.$eval('[data-testid=nav-archived] .nav-count', (e) => e.firstChild?.textContent?.trim());
    assert(counted === '1', `the Archived row counts one project: ${counted}`);
    await page.waitForSelector('[data-testid=toast] .toast-act');
    assert((await page.$eval('[data-testid=toast]', (e) => e.textContent)).includes('Archived Acme'), 'the toast names it');
    await shot('02-archived-toast');
    await page.click('[data-testid=toast] .toast-act');
    await until(async () => (await projectsInSidebar()).join() === 'Acme,Globex,Initech', 'Undo: Acme back');
    await until(async () => (await cards()).length === 5, 'its videos back');
    assert(!(await page.$('[data-testid=nav-archived]')), 'no Archived row');
    await toastGone();
    assert(!Object.keys(await archivedNow()).length, 'the server never had it');
  });

  await check('a project’s own ⋯ on its page archives it too: the banner takes Share’s place at once, Undo puts it back', async () => {
    await open('#/folder/Globex');
    await page.waitForSelector('.hero-share');
    await page.click('.hero-more');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-radix-popper-content-wrapper]')].every((w) => !w.style.transform.includes('-200%')));
    await shot('01b-project-page-menu');
    await (await menuItem('Archive project')).click();
    await page.waitForSelector('[data-testid=archived-banner]');
    assert(!(await page.$('.hero-share')), 'Share gives way to the banner');
    await page.click('[data-testid=toast] .toast-act');
    await page.waitForSelector('.hero-share');
    assert(!(await page.$('[data-testid=archived-banner]')), 'Undo: as it was');
    await toastGone();
    assert(!(await archivedNow()).Globex, 'the server never had it');
  });

  await check('archived: out of the sidebar, the library, the board and the Inbox; the Archived row counts it', async () => {
    const before = await api('/api/for-you');
    assert(
      before.items.some((i) => i.slug === spot || i.slug === teaser),
      `the inbox lists Acme’s videos while it is open: ${before.items.map((i) => i.slug)}`,
    );
    await projectMenu('Acme');
    await (await menuItem('Archive project')).click();
    // closing the toast sends it now (waiting for it does the same, after a few seconds)
    await page.click('[data-testid=toast] [aria-label="Dismiss"]');
    await until(async () => (await archivedNow()).Acme, 'the server has it');
    await open();
    assert((await projectsInSidebar()).join() === 'Globex,Initech', 'not in the tree');
    await until(async () => (await cards()).length === 3, 'All videos: the other projects’ three');
    assert(!(await cards()).includes(spot) && !(await cards()).includes(teaser), 'none of its cards');
    const all = await page.$eval('[data-testid=nav-all] .nav-count', (e) => e.textContent.trim());
    assert(all === '3', `All videos counts 3: ${all}`);
    await page.keyboard.press('4');
    await page.waitForSelector('.board');
    assert(!(await page.$(`.bcard[data-slug="${enc(spot)}"], .bcard[data-slug="${spot}"]`)), 'not on the board');
    await page.keyboard.press('1');
    await shot('03-library-archived');
    const after = await api('/api/for-you');
    assert(!after.items.some((i) => i.slug === spot || i.slug === teaser), 'the inbox dropped its work');
    await open('#/inbox', '[data-testid=inbox-view]');
    const waiting = after.items.length;
    assert(waiting > 0, 'the other projects still have work waiting');
    await until(async () => (await page.$$('[data-testid^="inbox-row-"]')).length > 0, `the inbox shows the others’ work (${waiting})`);
    const inbox = await page.$eval('[data-testid=inbox-view]', (e) => e.textContent);
    assert(!inbox.includes('spot.mp4') && !inbox.includes('teaser.mp4'), 'nothing of Acme in the Inbox');
    await shot('03b-inbox');
  });

  await check('the Archived page lists it — what it holds, when — and opens it: its page says “Archived · Restore”, no Share', async () => {
    await open();
    await page.click('[data-testid=nav-archived]');
    await page.waitForSelector('[data-testid=archived-row]');
    assert(page.url().endsWith('#/archived'), page.url());
    const text = await page.$eval('[data-testid=archived-row]', (e) => e.textContent.replace(/\s+/g, ' '));
    assert(/Acme/.test(text) && /2 videos/.test(text) && /Archived just now/.test(text), text);
    assert((await page.$eval('.hero .tally', (e) => e.textContent.replace(/\s+/g, ' ').trim())) === '1 project', 'the tally counts projects');
    const active = await page.$eval('[data-testid=nav-archived]', (e) => e.classList.contains('active'));
    assert(active, 'the Archived row is where you are');
    await shot('04-archived-page');
    await page.click('[data-testid=archived-row] .arch-open');
    await page.waitForSelector('[data-testid=archived-banner]');
    assert(page.url().endsWith(`#/folder/Acme`), page.url());
    assert(!(await page.$('.hero-share')), 'no Share: no new link goes into it');
    assert(await page.$('[data-testid=archived-restore]'), 'Restore for its owner');
    assert(await page.$eval('[data-testid=nav-archived]', (e) => e.classList.contains('active')), 'still in Archived');
    await until(async () => (await cards()).length === 2, 'its two videos');
    // the banner stands in the title's row, where Share stood: the toolbar under it sits where it does on other projects
    const top = async () => page.$eval('.lib-toolbar', (e) => Math.round(e.getBoundingClientRect().top));
    const here = await top();
    await open('#/folder/Globex');
    assert((await top()) === here, `the toolbar at ${await top()} on Globex, ${here} on Acme`);
    await open('#/folder/Acme');
    await shot('05-archived-project');
  });

  await check('a video of it opens read only: the banner where the next step stands, no note, no sign-off, no agent', async () => {
    await open(`#/v/${enc(spot)}`, '[data-testid=archived-banner]');
    assert(!(await page.$('[data-testid=stage-control]')), 'no stage control');
    assert(!(await page.$('[data-testid=new-note]')), 'no + Note');
    assert(!(await page.$('[data-testid=share-button]')), 'no Share');
    // the notes are there to read, without their answers
    await page.waitForSelector('.note-row');
    await page.click('.note-row .nr');
    await page.waitForSelector('article.note:not(.note-row)');
    assert(!(await page.$('.reply-stub')), 'no Reply…');
    // C writes a note elsewhere: nothing opens here
    await page.keyboard.press('c');
    await settle(page);
    assert(!(await page.$('.composer')), 'C opens no composer');
    const inBar = await page.$eval('[data-testid=archived-banner]', (e) => {
      const b = e.getBoundingClientRect();
      const bar = e.closest('.p-top')?.getBoundingClientRect();
      return !!bar && b.top >= bar.top && b.bottom <= bar.bottom;
    });
    assert(inBar, 'the banner sits in the top bar');
    await shot('06-player-archived');
  });

  await check('⌘K: what matches in it comes apart, under Archived; Go to → Archived', async () => {
    await open();
    await page.keyboard.down('Meta');
    await page.keyboard.press('k');
    await page.keyboard.up('Meta');
    await page.waitForSelector('[data-testid=palette] input');
    await page.type('[data-testid=palette] input', 'spot');
    await until(
      async () => (await page.$$eval('.palette-group-name', (els) => els.map((e) => e.textContent.trim()))).includes('Archived'),
      'an Archived group',
    );
    const groups = await page.$$eval('.palette-group-name', (els) => els.map((e) => e.textContent.trim()));
    assert(!groups.includes('Videos'), `spot.mp4 only under Archived: ${groups}`);
    await shot('07-palette');
    await page.$eval('[data-testid=palette] input', (e) => {
      e.value = '';
    });
    await page.keyboard.press('Escape');
    await page.keyboard.down('Meta');
    await page.keyboard.press('k');
    await page.keyboard.up('Meta');
    await page.waitForSelector('[data-testid=palette] input');
    await page.type('[data-testid=palette] input', 'archived');
    const go = await until(
      () =>
        page.$$('.palette-item').then(async (items) => {
          for (const it of items) if ((await it.evaluate((e) => e.textContent.trim())) === 'Archived') return it;
          return null;
        }),
      'Go to → Archived',
    );
    await go.click();
    await page.waitForSelector('[data-testid=archived-row]');
  });

  await check('the pages fit 390, 1024 and 1440 in both themes, several projects and one archived', async () => {
    const states = {
      library: () => open(),
      'archived page': () => open('#/archived', '[data-testid=archived-row]'),
      'archived project': () => open('#/folder/Acme', '[data-testid=archived-banner]'),
      'archived player': () => open(`#/v/${enc(spot)}`, '[data-testid=archived-banner]'),
    };
    const problems = [];
    for (const [where, go] of Object.entries(states))
      problems.push(
        ...(await layoutMatrix(
          page,
          { [where]: go },
          {
            widths: [390, 1024, 1440],
            each: (width, theme) => shot(`matrix-${where.replace(/ /g, '-')}-${width}-${theme}`),
          },
        )),
      );
    assert(!problems.length, problems.join('\n'));
  });

  await check('phone: the Archived row in the menu, its page and the player’s banner fit, Restore within reach', async () => {
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: SHOTS ? 3 : 1 });
    try {
      await open();
      await page.click('[aria-label="Folders and views"]');
      const row = await page.waitForSelector('[role=dialog] [data-testid=nav-archived]');
      await shot('08-phone-menu');
      await row.click();
      await page.waitForSelector('[data-testid=archived-row]');
      const restore = await page.$eval('.arch-restore', (e) => {
        const r = e.getBoundingClientRect();
        return { right: r.right, height: r.height };
      });
      assert(restore.right <= 390 && restore.height >= 40, `Restore within reach: ${JSON.stringify(restore)}`);
      await shot('09-phone-archived');
      await open(`#/v/${enc(spot)}`, '[data-testid=archived-banner]');
      const b = await page.$eval('[data-testid=archived-banner]', (e) => {
        const r = e.getBoundingClientRect();
        return { left: r.left, right: r.right };
      });
      assert(b.right <= 390 && b.left >= 0, `the banner fits: ${b.left}–${b.right}`);
      await shot('10-phone-player');
    } finally {
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 });
    }
  });

  await check('Restore from the banner brings it all back: the sidebar, the library, the Inbox; the player takes notes again', async () => {
    await open(`#/v/${enc(spot)}`, '[data-testid=archived-banner]');
    await page.click('[data-testid=archived-restore]');
    await page.waitForSelector('[data-testid=new-note]');
    assert(!(await page.$('[data-testid=archived-banner]')), 'the banner goes at once');
    await page.waitForSelector('[data-testid=toast] [aria-label="Dismiss"]');
    assert((await page.$eval('[data-testid=toast]', (e) => e.textContent)).includes('Restored Acme'), 'the toast says it');
    await page.click('[data-testid=toast] [aria-label="Dismiss"]');
    await until(async () => !(await archivedNow()).Acme, 'the server has it restored');
    await page.waitForSelector('[data-testid=stage-control]');
    await open();
    await until(async () => (await projectsInSidebar()).join() === 'Acme,Globex,Initech', 'Acme back in the sidebar');
    await until(async () => (await cards()).length === 5, 'its videos back');
    assert(!(await page.$('[data-testid=nav-archived]')), 'no Archived row');
    const inbox = await api('/api/for-you');
    assert(
      inbox.items.some((i) => i.slug === spot || i.slug === teaser),
      'back in the inbox',
    );
    const note = await api(`/api/review/${enc(spot)}/comments`, 'POST', { frame: 2, text: 'One more' });
    assert(note.id, 'it takes notes again');
  });

  await check('no page errors', async () => {
    assert(!errors.length, `page errors: ${errors.join('\n')}`);
  });
} catch (e) {
  crashed(e, srv);
}
await finish(LABEL, { browser, servers: [srv] });
