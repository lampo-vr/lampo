#!/usr/bin/env node
// covers: web/src/library/ web/src/palette/ web/src/uploads/ web/src/styles/library.css web/src/styles/cards.css
// covers: web/src/styles/palette.css server/routes/library.ts server/routes/uploads.ts lib/search.ts lib/folders.ts
// covers: lib/sprite.ts
// Browser end-to-end test of the library: a real server (local mode, temp store, free port) + headless Chrome.
// Four layouts (remembered), the board inside the library (#/status opens it; its lanes scroll, the page doesn't),
// filter chips with counts, list sorting,
// the honest review-link state, hover-scrub through the sprite, arrow keys between cards, folding a section, and the
// ⌘K palette (find a video by a word with an umlaut, open it; run an action). Screenshots land in VR_SHOTS if set.
import path from 'node:path';
import { age, makeVideo, sleep, until } from '../lib/helpers.ts';
import { fitsAt, settle } from './layout.mjs';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'library e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-library-e2e-', user: 'Sam' });
const { dir, base: BASE } = srv;

const api = jsonApi(BASE);

let browser;
try {
  // Four renders in two projects: one to review, one with a must note, one approved and shared, one final.
  const add = async (rel, folder, o = {}) => {
    const file = makeVideo(path.join(dir, rel), { w: 320, h: 180, fps: 25, dur: 2, ...o });
    age(file);
    const { video } = await api('/api/library', 'POST', { path: file, folder });
    return video.slug;
  };
  const spot = await add('Acme/export/spot.mp4', 'Acme/Reels', { pattern: 'testsrc2' });
  const teaser = await add('Acme/export/Überblendung teaser.mp4', 'Acme/Reels');
  const film = await add('Globex/export/brand-film.mp4', 'Globex');
  const cut = await add('Globex/export/cutdown.mp4', 'Globex', { freq: 660 });
  const enc = encodeURIComponent;
  await api(`/api/review/${enc(teaser)}/comments`, 'POST', { frame: 3, text: 'Logo zu früh', severity: 'must' });
  await api(`/api/review/${enc(film)}/approval`, 'PUT', { status: 'approved' });
  const link = await api(`/api/review/${enc(film)}/shares`, 'POST', { label: 'Globex marketing' });
  await api(`/api/review/${enc(cut)}/approval`, 'PUT', { status: 'approved' });
  await api(`/api/review/${enc(cut)}/final`, 'PUT', {});

  browser = await launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 });
  const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  const open = async (hash = '#/') => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=library-content]', { timeout: 20000 });
  };
  const layout = () => page.$eval('[data-testid=library-content]', (e) => e.getAttribute('data-layout'));
  const names = (sel) => page.$$eval(sel, (els) => els.map((e) => e.getAttribute('data-slug')));

  await check('four layouts from the toolbar and keys 1–4; the choice survives a reload', async () => {
    await open();
    assert((await layout()) === 'grid', `starts as ${await layout()}`);
    await until(async () => (await page.$$('.film')).length === 4, 'four cards');
    await shot('01-grid');
    await page.click('[aria-label="Layout"] [aria-label="List"]');
    await page.waitForSelector('[data-testid=library-list] .lrow');
    await page.keyboard.press('2');
    await until(async () => (await layout()) === 'compact', 'key 2: compact');
    assert(await page.$('.grid.compact .film.compact'), 'compact cards');
    await page.keyboard.press('3');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=library-list]', { timeout: 15000 });
    assert((await layout()) === 'list', 'list after a reload');
  });

  await check('typing in the search while the page still loads: the letters keep going into the real field', async () => {
    // a slow answer to "who are you": the library's loading page takes the first letters, then the real page replaces
    // it — the field there has the focus and the caret, so the next letters land too. A browser of its own that saw this
    // library before (lib/chromeHint.ts: its loading page knows the toolbar is coming; one that never saw it draws the
    // top bar alone) but keeps none of its data: once an earlier page here has kept it (IndexedDB, the account's status
    // with it, written a second or so after it loads), the library opens as the real page and there is no loading page
    // to type into (the earlier check's page leaves it on a busy machine's timing).
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    try {
      await p.setViewport({ width: 1440, height: 900 });
      await p.evaluateOnNewDocument(() => localStorage.setItem('vr.chrome', JSON.stringify({ role: 'owner', library: 'full' })));
      await p.setRequestInterception(true);
      let release;
      const held = new Promise((r) => {
        release = r;
      });
      p.on('request', async (r) => {
        if (r.url().includes('/api/auth/status')) await held;
        await r.continue();
      });
      await p.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
      const early = await p.waitForSelector('.lib-filter input', { visible: true });
      await early.click();
      await p.keyboard.type('spo');
      release();
      await p.waitForFunction((el) => !el.isConnected, { timeout: 20000 }, early);
      await p.waitForSelector('.film:not(.pending), .lrow:not(.pending)', { timeout: 20000 });
      await p.keyboard.type('t');
      const st = await p.evaluate(() => ({
        q: document.querySelector('.lib-filter input')?.value,
        focus: !!document.activeElement?.matches('.lib-filter input'),
      }));
      assert(st.q === 'spot' && st.focus, `the field kept the focus and every letter: ${JSON.stringify(st)}`);
    } finally {
      await ctx.close();
    }
  });

  await check('a folder row with a must to fix: its actions never land on the mark (it steps aside while they show)', async () => {
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.nav-item:has(> .nav-kg.must):has(> .nav-actions)');
    const row = await page.$('.nav-item:has(> .nav-kg.must):has(> .nav-actions)');
    await row.hover();
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector('.nav-item:has(> .nav-kg.must):has(> .nav-actions) .nav-actions')).opacity === '1',
    );
    await sleep(250);
    const seen = await row.evaluate((r) => {
      const box = (e) => e.getBoundingClientRect();
      const kg = r.querySelector(':scope > .nav-kg');
      const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const acts = [...r.querySelectorAll('.nav-act')].filter((b) => b.offsetWidth > 0);
      return { kgOpacity: getComputedStyle(kg).opacity, covered: acts.some((b) => overlap(box(b), box(kg))) };
    });
    assert(!seen.covered || seen.kgOpacity === '0', `a button lies over a visible mark: ${JSON.stringify(seen)}`);
    await page.mouse.move(5, 5);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.nav-item:has(> .nav-kg.must):has(> .nav-actions) > .nav-kg')).opacity === '1');
  });

  await check('list: columns sort by name, stage, open notes and date', async () => {
    await open();
    await page.click('[aria-label="Layout"] [aria-label="List"]');
    await page.evaluate(() => [...document.querySelectorAll('.lsort')].find((b) => b.textContent.startsWith('Name'))?.click());
    await until(async () => (await page.$('th[aria-sort="ascending"]')) !== null, 'name column sorted');
    // grouped by project: Acme (spot, Überblendung…), then Globex (brand-film, cutdown)
    assert(JSON.stringify(await names('.lrow')) === JSON.stringify([spot, teaser, film, cut]), `by name: ${await names('.lrow')}`);
    await page.evaluate(() => [...document.querySelectorAll('.lsort')].find((b) => b.textContent.startsWith('Open'))?.click());
    await until(async () => (await names('.lrow'))[0] === teaser, 'the must note first');
    await shot('02-list');
  });

  // On a wide screen the name column took every spare pixel: Stage, Open, Review link and Updated crammed into the last
  // few hundred, a gulf after every short name. The columns share the width instead.
  await check('list: on a wide screen the name column leaves the other columns their share (1920, 2560)', async () => {
    const out = [];
    for (const [width, height] of [
      [1920, 1080],
      [2560, 1440],
    ]) {
      await page.setViewport({ width, height });
      await settle(page);
      const m = await page.evaluate(() => {
        const table = document.querySelector('.ltable').getBoundingClientRect();
        const stage = document.querySelector('.ltable thead th.lc-stage').getBoundingClientRect();
        return { name: Math.round(((stage.left - table.left) / table.width) * 100), table: Math.round(table.width) };
      });
      if (m.name > 55) out.push(`@${width}: the name column takes ${m.name} % of ${m.table} px`);
    }
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 });
    assert(!out.length, out.join(' · '));
  });

  await check('list: a dragged row leaves a small chip under the pointer (poster and name), not the whole row', async () => {
    // the browser's drag picture can't be read back, so setDragImage is watched while a row starts a drag
    const picture = await page.evaluate(() => {
      let got = null;
      const own = DataTransfer.prototype.setDragImage;
      DataTransfer.prototype.setDragImage = (el) => {
        const b = el.getBoundingClientRect();
        const pic = el.querySelector('canvas');
        const px = (v) => Number.parseFloat(v) || 0;
        const box = getComputedStyle(el);
        // the corners nest: the box's radius is the picture's plus the padding between them
        const nest = pic && {
          outer: px(box.borderTopLeftRadius),
          inner: px(getComputedStyle(pic).borderTopLeftRadius),
          pad: px(box.paddingTop),
          left: px(box.paddingLeft),
        };
        got = { w: b.width, h: b.height, text: el.textContent, poster: !!pic, nest };
      };
      const row = document.querySelector('.lrow[draggable="true"]');
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
      DataTransfer.prototype.setDragImage = own;
      return { got, row: row.getBoundingClientRect().width, name: row.querySelector('.lname a').textContent };
    });

    await check('grid: a dragged card leaves the same small chip, not the whole card', async () => {
      const before = await page.evaluate(() => localStorage.getItem('vr.library'));
      try {
        await page.evaluate(() =>
          localStorage.setItem('vr.library', JSON.stringify({ ...JSON.parse(localStorage.getItem('vr.library') || '{}'), layout: 'grid' })),
        );
        await page.goto('about:blank');
        await open('#/');
        await page.waitForSelector('.film[draggable="true"]', { timeout: 20000 });
        const got = await page.evaluate(() => {
          let pic = null;
          const own = DataTransfer.prototype.setDragImage;
          DataTransfer.prototype.setDragImage = (el) => {
            const b = el.getBoundingClientRect();
            pic = { w: b.width, h: b.height, text: el.textContent };
          };
          const card = document.querySelector('.film[draggable="true"]');
          card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
          card.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
          DataTransfer.prototype.setDragImage = own;
          return { pic, card: card.getBoundingClientRect().width };
        });
        assert(got.pic && got.pic.w <= 320 && got.pic.h <= 56 && got.pic.text, `a chip, not the ${got.card} px card: ${JSON.stringify(got.pic)}`);
      } finally {
        await page.evaluate((v) => (v === null ? localStorage.removeItem('vr.library') : localStorage.setItem('vr.library', v)), before);
      }
    });
    const { got, row, name } = picture;
    assert(got && got.w <= 320 && got.h <= 56 && got.w < row / 3, `a chip, not the ${row} px row: ${JSON.stringify(got)}`);
    if (got.nest)
      assert(
        got.nest.outer === got.nest.inner + got.nest.pad && got.nest.pad === got.nest.left,
        `the chip's corners nest around its picture: ${JSON.stringify(got.nest)}`,
      );
    assert(got.text === name, `the chip names the video: ${got.text}`);
  });

  await check('the board lives in the library: #/status opens it, lanes count what stands where', async () => {
    await open('#/status');
    await page.waitForSelector('[data-testid=library-board]');
    assert((await page.evaluate(() => location.hash)) === '#/', `redirected to ${await page.evaluate(() => location.hash)}`);
    const lanes = await page.$$eval('.lane', (els) => els.map((e) => [e.getAttribute('data-lane'), e.querySelectorAll('.bcard').length]));
    assert(lanes.map((l) => l.join(':')).join(' ') === 'needs_you:1 fixing:1 approved:1 final:1', JSON.stringify(lanes));
    // one quiet status line: here the review link's state, the link's name in its tooltip
    const shared = await page.$eval(`.bcard[data-slug="${film}"] .bcard-line [data-testid=share-state]`, (e) => `${e.textContent} | ${e.title}`);
    assert(/^Link not opened \| Review link “Globex marketing”$/.test(shared), shared);
    await shot('03-board');
  });

  await check('an empty lane keeps a card’s place and says what lands there; every lane runs the board’s height', async () => {
    await open('#/status');
    await page.waitForSelector('[data-testid=library-board] .bcard');
    // only the final one shown: the other three lanes are empty
    await page.evaluate(() => [...document.querySelectorAll('.seg.chips button')].find((b) => b.textContent.startsWith('Final'))?.click());
    await until(async () => (await page.$$('[data-testid=lane-empty]')).length === 3, 'three empty lanes');
    const lanes = await page.$$eval('.lane', (els) =>
      els.map((l) => {
        const e = l.querySelector('[data-testid=lane-empty]');
        return {
          id: l.dataset.lane,
          h: Math.round(l.getBoundingClientRect().height),
          empty: e && {
            glyph: !!e.querySelector('.lane-empty-slot .kg'),
            title: e.querySelector('.lane-empty-title')?.textContent,
            body: e.querySelector('.lane-empty-body')?.textContent,
          },
        };
      }),
    );
    const say = { needs_you: 'Nothing to review', fixing: 'Nothing being fixed', approved: 'Nothing approved yet' };
    for (const l of lanes.filter((x) => x.empty)) assert(l.empty.glyph && l.empty.title === say[l.id] && l.empty.body, `${l.id}: ${JSON.stringify(l.empty)}`);
    assert(new Set(lanes.map((l) => l.h)).size === 1, `lanes of one height: ${JSON.stringify(lanes.map((l) => [l.id, l.h]))}`);
    const fit = await fitsAt(page, 'board with empty lanes');
    assert(!fit.length, fit.join('\n        '));
    await shot('03-board-empty-lanes');
    await page.evaluate(() => [...document.querySelectorAll('.seg.chips button')].find((b) => b.textContent.startsWith('All'))?.click());
  });

  await check('cards say what the review link says: shared and not opened, then opened by the client', async () => {
    await open();
    await page.click('[aria-label="Layout"] [aria-label="Grid"]');
    await page.waitForSelector(`.film[data-slug="${film}"] [data-testid=share-state]`);
    assert((await page.$eval(`.film[data-slug="${film}"] [data-testid=share-state]`, (e) => e.textContent)).includes('Link not opened'), 'not opened');
    const guest = { 'x-forwarded-for': '203.0.113.9', 'Content-Type': 'application/json' };
    await fetch(`${BASE}/api/g/${link.token}/visit`, { method: 'POST', headers: guest, body: JSON.stringify({ name: 'Mia' }) });
    await fetch(`${BASE}/api/g/${link.token}/review/${enc(film)}`, { headers: guest });
    await until(
      async () => /Opened by Mia/.test((await page.$eval(`.film[data-slug="${film}"] [data-testid=share-state]`, (e) => e.textContent).catch(() => '')) || ''),
      'opened by Mia (live)',
    );
    const stage = await page.$eval(`.film[data-slug="${film}"] [data-testid=status-pill]`, (e) => e.getAttribute('data-stage'));
    assert(stage === 'with_client', `client reviewing, not ${stage}`);
  });

  await check('filter chips count and filter; the filter field folds umlauts', async () => {
    await open();
    const chip = (label) => page.evaluateHandle((l) => [...document.querySelectorAll('.seg.chips button')].find((b) => b.textContent.startsWith(l)), label);
    assert((await (await chip('To review')).evaluate((b) => b.textContent)).includes('1'), 'needs you: 1');
    await (await chip('Final')).click();
    await until(async () => JSON.stringify(await names('.film')) === JSON.stringify([cut]), 'only the final one');
    await (await chip('All')).click();
    await page.keyboard.press('/');
    await page.keyboard.type('uberblendung');
    await until(async () => JSON.stringify(await names('.film')) === JSON.stringify([teaser]), 'found by a folded word');
    await page.keyboard.press('Escape');
    await until(async () => (await page.$$('.film')).length === 4, 'Escape clears the filter');
  });

  await check('Filter (F): pick a field, then values with counts; chips say it, change it and go away', async () => {
    await open();
    await until(async () => (await page.$$('.film')).length === 4, 'four cards');
    await page.keyboard.press('f');
    await page.waitForSelector('.fl-pop .fl-opt');
    const option = (label) => page.evaluateHandle((l) => [...document.querySelectorAll('.fl-pop .fl-opt')].find((b) => b.textContent.includes(l)), label);
    // typing narrows the fields
    await page.keyboard.type('proj');
    await until(async () => (await page.$$('.fl-pop .fl-opt')).length === 1, 'only Project is left');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.fl-pop [aria-multiselectable]');
    const counts = await page.$$eval('.fl-pop .fl-opt', (els) => els.map((e) => e.textContent.trim()));
    assert(counts.includes('Acme2') && counts.includes('Globex2'), `projects with their counts: ${counts}`);
    await (await option('Globex')).click();
    await until(async () => JSON.stringify((await names('.film')).sort()) === JSON.stringify([film, cut].sort()), 'Globex only');
    // Escape steps back to the list of filters first, and closes only from there
    await page.keyboard.press('Escape');
    await page.waitForSelector('.fl-pop .fl-search');
    assert(!(await page.$('.fl-pop [aria-multiselectable]')), 'the first Escape goes back to the filters, not out');
    await page.keyboard.press('Escape');
    await until(async () => !(await page.$('.fl-pop')), 'the second Escape closes');
    const chips = await page.$$eval('[data-testid=filter-chips] .fl-chip', (els) => els.map((e) => e.textContent.trim()));
    assert(JSON.stringify(chips) === JSON.stringify(['Project is Globex']), `the chip says it: ${chips}`);
    // with a filter set the button says so, with how many apply (it is the icon alone until then)
    const set = await page.$eval('[data-testid=filter-button]', (e) => e.textContent.replace(/\s+/g, ' ').trim());
    assert(set === 'Filter1', `the button with a filter: "${set}"`);
    await shot('04-filter-chip');
    // a flag field applies at once; both chips must hold
    await page.click('[data-testid=filter-button]');
    await (await option('Has open musts')).click();
    await until(async () => (await page.$$('.film')).length === 0, 'Globex has no open musts');
    // clicking a chip opens its values again; × removes one; Clear removes all
    await page.evaluate(() => [...document.querySelectorAll('.fl-chip-main')].find((b) => b.textContent.includes('Project'))?.click());
    await page.waitForSelector('.fl-pop [aria-multiselectable]');
    await (await option('Acme')).click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await until(async () => JSON.stringify(await names('.film')) === JSON.stringify([teaser]), 'Acme or Globex, with an open must');
    await page.evaluate(() =>
      [...document.querySelectorAll('.fl-chip')]
        .find((c) => c.textContent.includes('musts'))
        ?.querySelector('.fl-chip-x')
        ?.click(),
    );
    await until(async () => (await page.$$('.film')).length === 4, 'Acme + Globex is everything');
    await page.click('.lib-filters .fl-clear');
    await until(async () => !(await page.$('[data-testid=filter-chips]')), 'Clear filters');
  });

  await check('hover scrubs through the render once its sprite is made', async () => {
    await open();
    const frame = await page.$(`.film[data-slug="${spot}"] .poster-frame`);
    const box = await frame.boundingBox();
    const sweep = async (x) => page.mouse.move(box.x + box.width * x, box.y + box.height / 2, { steps: 2 });
    await sweep(0.2);
    await until(
      async () => {
        await sweep(0.3);
        await sweep(0.2);
        return !!(await page.$('[data-testid=scrub]'));
      },
      'the sprite arrives',
      30000,
    );
    await sweep(0.1);
    const a = await page.$eval('[data-testid=scrub]', (e) => e.style.backgroundPosition);
    await sweep(0.9);
    const b = await page.$eval('[data-testid=scrub]', (e) => e.style.backgroundPosition);
    assert(a && b && a !== b, `the tile changes with the pointer: ${a} → ${b}`);
    await page.mouse.move(0, 0);
    await until(async () => !(await page.$('[data-testid=scrub]')), 'the poster comes back');
  });

  await check('arrow keys move between cards; Enter opens one; a section folds away', async () => {
    await open();
    // Acme's two cards in the first row, Globex's two in the next section
    const order = await names('.film');
    const focused = () => page.evaluate(() => document.activeElement?.getAttribute('data-slug'));
    await page.focus(`.film[data-slug="${order[0]}"]`);
    await page.keyboard.press('ArrowRight');
    assert((await focused()) === order[1], 'right: the next card');
    await page.keyboard.press('ArrowLeft');
    assert((await focused()) === order[0], 'left: back');
    await page.keyboard.press('ArrowDown');
    assert((await focused()) === order[2], 'down: the card below');
    await page.click('.shead-toggle');
    await until(async () => (await page.$$('.film')).length === 2, 'Acme folded');
    await page.click('.shead-toggle');
    await until(async () => (await page.$$('.film')).length === 4, 'Acme back');
    await page.focus(`.film[data-slug="${order[0]}"]`);
    await page.keyboard.press('Enter');
    await until(async () => (await page.evaluate(() => location.hash)).startsWith('#/v/'), 'Enter opens the player');
  });

  await check('⌘K: find a video by a word with an umlaut and open it; actions too', async () => {
    await open();
    await page.keyboard.down('Meta');
    await page.keyboard.press('k');
    await page.keyboard.up('Meta');
    await page.waitForSelector('[data-testid=palette] [role=option]');
    await page.keyboard.type('uberblend');
    await until(async () => !!(await page.$('[data-testid=palette] [role=option] mark')), 'the video in the results, the match marked');
    const marked = await page.$eval('[data-testid=palette] [role=option] mark', (e) => e.textContent);
    assert(marked === 'Überblend', `marked "${marked}"`);
    await shot('04-palette');
    await page.keyboard.press('Enter');
    await until(async () => (await page.evaluate(() => location.hash)) === `#/v/${enc(teaser)}`, 'the player opens');
    // an action from the player: the library as a board
    await page.keyboard.down('Control');
    await page.keyboard.press('k');
    await page.keyboard.up('Control');
    await page.waitForSelector('[data-testid=palette] input');
    await page.keyboard.type('board');
    await until(async () => (await page.$$eval('[role=option]', (els) => els.map((e) => e.textContent))).includes('Show as board'), 'the action');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid=library-board]', { timeout: 15000 });
  });

  await check('"Add a video" from the palette opens the add dialog in the library', async () => {
    await open();
    await page.click('[data-testid=palette-button]');
    await page.waitForSelector('[data-testid=palette] input');
    await page.keyboard.type('add a video');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.modal', { timeout: 10000 });
    assert((await page.evaluate(() => location.hash)) === '#/', 'the hash is tidied up');
    await page.keyboard.press('Escape');
  });

  await check('Add video starts with dropping or choosing files; linking a file on this machine is one click away and remembered', async () => {
    await page.evaluate(() => localStorage.removeItem('vr.addMode'));
    await open();
    await page.click('.topbar .add-video');
    await page.waitForSelector('.modal [data-testid=add-choose-files]', { timeout: 10000 });
    assert(!(await page.$('.modal .browser')), 'no file browser before asking for one');
    await shot('05-add-upload');
    await page.click('[data-testid=add-link-instead]');
    await page.waitForSelector('.modal .browser .entries');
    assert((await page.$eval('.modal .modal-head h3', (e) => e.textContent)).includes('Link a file on this machine'), 'the link step');
    // the folder renders were linked from lately is where it starts, and one click away
    await until(async () => (await page.$$('.modal .browser-recent button')).length > 0, 'recent export folders');
    await shot('05b-add-link');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 5000 });
    await page.click('.topbar .add-video');
    await page.waitForSelector('.modal .browser', { timeout: 10000 });
    await page.click('[data-testid=add-upload-instead]');
    await page.waitForSelector('.modal [data-testid=add-choose-files]');
    await page.keyboard.press('Escape');
  });

  await check('the upload dialog picks a project in one control: find it, or make a New project in place (↑↓ ↵; Esc folds, the dialog stays)', async () => {
    await open();
    const file = makeVideo(path.join(dir, 'uploads/Launch teaser 15s.mp4'), { w: 1280, h: 720, fps: 30, dur: 2, pattern: 'testsrc2' });
    await (await page.$('input[data-testid=upload-input]')).uploadFile(file);
    await page.waitForSelector('.modal [data-testid=folder-field]', { timeout: 10000 });
    const field = () => page.$eval('.modal [data-testid=folder-field]', (e) => e.textContent.trim());
    assert((await field()).startsWith('No project'), `the dialog starts where the view is: ${await field()}`);
    await page.click('.modal [data-testid=folder-field]');
    await page.waitForSelector('.modal [data-testid=folder-picker] input:focus');
    // one control: the search is a line of the box (no border or ring of its own), the list no box inside it, the
    // current choice a check — and the last row makes a project
    const shape = await page.$eval('.modal [data-testid=folder-picker]', (fp) => {
      const input = fp.querySelector('.fp-search input');
      const list = fp.querySelector('.fp-list');
      const rows = [...list.querySelectorAll('.fp-row')];
      return {
        inputBorder: getComputedStyle(input).borderTopWidth,
        inputShadow: getComputedStyle(input).boxShadow,
        listBorder: getComputedStyle(list).borderTopWidth,
        listBg: getComputedStyle(list).backgroundColor,
        rows: rows.map((r) => r.textContent.trim()),
        sel: rows.findIndex((r) => r.getAttribute('aria-selected') === 'true' && r.querySelector('.fp-check')),
      };
    });
    assert(shape.inputBorder === '0px' && shape.inputShadow === 'none', `the search has no box of its own: ${JSON.stringify(shape)}`);
    assert(shape.listBorder === '0px' && shape.listBg === 'rgba(0, 0, 0, 0)', `no grey box around the list: ${JSON.stringify(shape)}`);
    assert(shape.rows[0] === 'No project' && shape.sel === 0 && shape.rows.at(-1) === 'New project', `the rows: ${JSON.stringify(shape)}`);
    // ↓ moves the highlight (the field keeps the keys), Esc folds the list back into its field and the dialog stays
    const active = () => page.$eval('.modal [data-testid=folder-picker] .fp-row.active .grow', (e) => e.textContent.trim());
    await page.keyboard.press('ArrowDown');
    assert((await active()) === 'Acme', `↓ goes to the next row: ${await active()}`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.modal [data-testid=folder-field]');
    assert(await page.$('.modal .up-files'), 'Esc folded the list, the dialog stayed');
    // typing a name that isn't there offers it
    await page.click('.modal [data-testid=folder-field]');
    await page.waitForSelector('.modal [data-testid=folder-picker] input:focus');
    await page.keyboard.type('Brand new');
    assert((await active()) === 'Create “Brand new”', `a new name is offered: ${await active()}`);
    await page.keyboard.press('Escape');
    assert((await page.$eval('.modal [data-testid=folder-picker] input', (e) => e.value)) === '', 'Esc first clears the search');
    // New project: the row becomes a name field (Esc goes back to the row), ↵ makes it the choice
    await page.click('.modal [data-testid=fp-new]');
    await page.waitForSelector('.modal [data-testid=fp-naming] input:focus');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.modal [data-testid=fp-new]');
    assert(await page.$('.modal .up-files'), 'Esc in the name field keeps the dialog');
    await page.click('.modal [data-testid=fp-new]');
    await page.waitForSelector('.modal [data-testid=fp-naming] input:focus');
    await page.keyboard.type('Client X/Spring');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.modal [data-testid=folder-field]');
    const chosen = await field();
    assert(chosen.startsWith('Client X › Spring') && chosen.includes('NEW'), `the new project is the choice: ${chosen}`);
    await shot('05c-upload-new-project');
  });

  await check(
    'the upload tray floats like the app’s floats: no ruler, progress as a ring and a line, figures in the UI’s face, no ring left by a click',
    async () => {
      // slow enough to look at it mid-way (the file from the check before is about a megabyte)
      const cdp = await page.createCDPSession();
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 200 * 1024 });
      try {
        // ⌘↵ sends the dialog from the keyboard, as people do
        await page.focus('.modal [data-testid=folder-field]');
        await page.keyboard.down('Meta');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Meta');
        await page.waitForSelector('[data-testid=upload-tray] .up-row.uploading .up-stats', { timeout: 20000 });
        const tray = await page.$eval('[data-testid=upload-tray]', (t) => {
          const cs = getComputedStyle(t);
          const stats = t.querySelector('.up-stats');
          return {
            ruler: getComputedStyle(t, '::before').content,
            radius: Number.parseFloat(cs.borderTopLeftRadius),
            shadow: cs.boxShadow,
            ring: !!t.querySelector('.up-head .up-ring'),
            bar: !!t.querySelector('.up-row .up-bar'),
            stats: stats.textContent,
            face: getComputedStyle(stats).fontFamily,
            focus: !!t.querySelector(':focus-visible'),
          };
        });
        assert(tray.ruler === 'none' && tray.radius >= 8 && tray.shadow !== 'none', `the float's material, no ruler strip: ${JSON.stringify(tray)}`);
        assert(tray.ring && tray.bar, `the whole upload as a ring, the video as a line: ${JSON.stringify(tray)}`);
        assert(/ of /.test(tray.stats) && !/Martian Mono/.test(tray.face), `“sent of size” in the UI's face: ${JSON.stringify(tray)}`);
        assert(!tray.focus, 'no ring on the tray after ⌘↵');
        // a click folds it and leaves no focus behind, so a key pressed later lights no ring on it
        await page.click('[data-testid=upload-tray-head]');
        await page.waitForSelector('[data-testid=upload-tray] .up-list', { hidden: true });
        await page.keyboard.press('Shift');
        const after = await page.$eval('[data-testid=upload-tray]', (t) => ({
          focused: t.contains(document.activeElement),
          visible: !!t.querySelector(':focus-visible'),
          pct: t.querySelector('.up-pct')?.textContent ?? '',
        }));
        assert(!after.focused && !after.visible, `no focus and no ring after a click: ${JSON.stringify(after)}`);
        assert(/^\d+%$/.test(after.pct), `folded, the head says how far: ${JSON.stringify(after)}`);
        await page.click('[data-testid=upload-tray-head]');
        await page.waitForSelector('[data-testid=upload-tray] .up-list');
        await shot('05d-upload-tray');
      } finally {
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
        await cdp.detach().catch(() => {});
      }
      const up = await until(
        async () => (await api('/api/library')).videos.find((v) => v.name === 'Launch teaser 15s.mp4' && v.folder === 'Client X/Spring'),
        'uploaded into the new project',
        60000,
      );
      // the checks after this one count the library as it was
      await page.waitForSelector('[data-testid=upload-tray] .up-row.done', { timeout: 30000 });
      await api(`/api/library/${encodeURIComponent(up.slug)}`, 'DELETE');
      await api(`/api/folders?path=${encodeURIComponent('Client X')}`, 'DELETE');
    },
  );

  await check('Recent: the videos opened last, newest first, in the sidebar and the empty palette; another browser starts without', async () => {
    await page.goto(`${BASE}/#/v/${enc(film)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.timeline canvas', { timeout: 20000 });
    await open();
    await page.waitForSelector('[data-testid=nav-recent-item]');
    const rows = await page.$$eval('[data-testid=nav-recent-item]', (els) => els.map((e) => e.querySelector('.nav-label').textContent));
    assert(rows[0].startsWith('brand-film.mp4'), `the last opened first: ${rows.join(' | ')}`);
    assert(
      rows.some((r) => r.startsWith('Überblendung teaser.mp4')),
      `the teaser opened before is there too: ${rows.join(' | ')}`,
    );
    assert(!rows.some((r) => r.startsWith('cutdown.mp4')), 'a video never opened is not');
    assert(await page.$eval('[data-testid=nav-recent-item] .nav-thumb img', (i) => i.getAttribute('src').startsWith('/api/poster/')), 'a poster thumbnail');
    // a long name shortens with an ellipsis and widens nothing: every row, count included, stays inside the sidebar
    const fits = await page.evaluate(() => {
      document.querySelector('[data-testid=nav-recent-item] .nav-label').textContent = 'a-very-long-render-name_without-spaces_final-final_v12_4x5_master.mp4';
      const aside = document.querySelector('aside.nav').getBoundingClientRect();
      return [...document.querySelectorAll('aside.nav .nav-item')]
        .map((el) => ({
          t: el.textContent.trim().slice(0, 24),
          row: el.getBoundingClientRect().right,
          count: el.querySelector('.nav-count')?.getBoundingClientRect().right ?? 0,
        }))
        .filter((x) => x.row > aside.right + 0.5 || x.count > aside.right + 0.5);
    });
    assert(!fits.length, `rows wider than the sidebar with a long name in Recent: ${JSON.stringify(fits)}`);
    await shot('07-recent');
    // the empty palette: the opened ones first, under Recent
    await page.keyboard.down('Meta');
    await page.keyboard.press('k');
    await page.keyboard.up('Meta');
    await page.waitForSelector('[data-testid=palette] [role=option]');
    const opts = await page.$$eval('[data-testid=palette] [role=option]', (els) => els.map((e) => e.textContent.trim()));
    const at = (name) => opts.findIndex((x) => x.startsWith(name));
    assert(at('brand-film.mp4') >= 0, `the palette lists it: ${opts.join(' | ')}`);
    assert(at('Inbox') < at('brand-film.mp4'), 'where to go comes first');
    assert(at('cutdown.mp4') < 0 || at('brand-film.mp4') < at('cutdown.mp4'), 'opened before merely changed');
    await page.keyboard.press('Escape');
    // a row opens its video
    const second = (await page.$$('[data-testid=nav-recent-item]'))[1];
    const name = await second.$eval('.nav-label', (e) => e.textContent);
    const want = name.startsWith('Überblendung') ? teaser : name.startsWith('spot') ? spot : null;
    assert(want, `the second row is a video opened earlier here: ${name}`);
    await second.click();
    await until(async () => (await page.evaluate(() => location.hash)) === `#/v/${enc(want)}`, `the row opens ${name}`);
    // another browser (a fresh profile): nothing opened there yet, no section
    const ctx = await browser.createBrowserContext();
    const other = await ctx.newPage();
    await other.setViewport({ width: 1440, height: 900 });
    await other.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await other.waitForSelector('[data-testid=library-content]', { timeout: 20000 });
    await other.waitForFunction(() => /\d/.test(document.querySelector('[data-testid=nav-all] .nav-count')?.textContent || ''), { timeout: 20000 });
    assert(!(await other.$('[data-testid=nav-recent]')), 'no Recent in a browser that opened nothing');
    await ctx.close();
  });

  await check('the empty palette starts with where to go; the view is searched in "Search this view"; Filter is an icon until one applies', async () => {
    await open();
    await page.keyboard.down('Meta');
    await page.keyboard.press('k');
    await page.keyboard.up('Meta');
    await page.waitForSelector('[data-testid=palette] [role=option]');
    const first = await page.$$eval('[data-testid=palette] [role=option]', (els) => els.slice(0, 6).map((e) => e.textContent.trim()));
    for (const want of ['Inbox', 'All videos', 'Insights', 'Settings', 'House playbook'])
      assert(
        first.some((x) => x.startsWith(want)),
        `${want} among the first: ${first.join(' | ')}`,
      );
    await page.keyboard.press('Escape');
    assert((await page.$eval('.lib-filter input', (e) => e.placeholder)) === 'Search this view', 'the field says what it does');
    const label = await page.$eval('[data-testid=filter-button]', (e) => e.textContent.trim());
    assert(label === '', `the Filter button is its icon: "${label}"`);
  });

  await check('a video without a project: one quiet line in its group, the sort named with an example from this library', async () => {
    const loose = await add('Initech/export/loose-cut.mp4', undefined, { freq: 520 });
    try {
      await open();
      // the cards grouped by project (an earlier check left the board on)
      await page.keyboard.press('1');
      await until(async () => (await layout()) === 'grid', 'the grid');
      await page.waitForSelector('[data-testid=unfiled]', { timeout: 10000 });
      assert(await page.$('.lib-section [data-testid=unfiled]'), 'inside the No-project group of the cards');
      assert(!(await page.$('[data-testid=unfiled] .btn.primary')), 'a secondary button, not the orange one');
      await until(async () => (await page.$eval('[data-testid=unfiled]', (e) => e.textContent)).includes('loose-cut.mp4'), "the example is this library's");
      await shot('06-unfiled');
      // on the board the line stands above the lanes instead
      await page.keyboard.press('4');
      await until(async () => (await layout()) === 'board', 'the board');
      assert(await page.$('.lib-controls [data-testid=unfiled]'), 'above the content on the board');
      await page.keyboard.press('1');
    } finally {
      await api(`/api/library/${enc(loose)}`, 'DELETE').catch(() => {});
    }
  });

  await check('board: lanes that don’t fit scroll sideways under a soft edge, with a quiet scrollbar; lanes that fit get no edge', async () => {
    const b = await browser.newPage();
    try {
      const edges = async (w) => {
        await b.setViewport({ width: w, height: 900 });
        await b.goto(`${BASE}/#/status`, { waitUntil: 'domcontentloaded' });
        await b.waitForSelector('[data-testid=library-board] .lane', { timeout: 20000 });
        await sleep(400);
        return b.$eval('[data-testid=library-board]', (e) => ({
          cls: e.className,
          over: e.scrollWidth > e.clientWidth + 1,
          bar: getComputedStyle(e).scrollbarColor,
        }));
      };
      const narrow = await edges(900);
      assert(narrow.over && /\bmore-r\b/.test(narrow.cls), `cut off at 900: a soft edge on the right (${JSON.stringify(narrow)})`);
      assert(/transparent|rgba\(0, 0, 0, 0\)/.test(narrow.bar), `the scrollbar waits for the pointer: ${narrow.bar}`);
      const wide = await edges(1920);
      assert(!wide.over && !/\bmore-[lr]\b/.test(wide.cls), `everything fits at 1920: no edge (${JSON.stringify(wide)})`);
    } finally {
      await b.close();
    }
  });

  await check('board: the page stays, each lane scrolls under its head; ↓ brings a card into view inside its lane', async () => {
    // six more renders to review: "Needs you" holds seven cards, more than a 900 px window shows. A browser of its own:
    // this is about the lanes, not about a tab catching up with renders added while it was open.
    for (let i = 1; i <= 6; i++) await add(`Acme/export/reel-${i}.mp4`, 'Acme/Reels', { dur: 1 });
    const ctx = await browser.createBrowserContext();
    const board = await ctx.newPage();
    board.on('pageerror', (e) => errors.push(e.message));
    await board.setViewport({ width: 1440, height: 900 });
    await board.goto(`${BASE}/#/status`, { waitUntil: 'domcontentloaded' });
    const lane = '.lane[data-lane=needs_you]';
    await until(async () => (await board.$$(`${lane} .bcard:not(.pending)`)).length === 7, 'seven cards to review');
    const state = () =>
      board.evaluate((lane) => {
        const main = document.querySelector('.lib-scroll');
        const box = document.querySelector(`${lane} .lane-scroll`) ?? document.querySelector(lane);
        return {
          page: main.scrollHeight - main.clientHeight,
          pageTop: main.scrollTop,
          more: box.scrollHeight - box.clientHeight,
          top: box.scrollTop,
          head: Math.round(document.querySelector(`${lane} .lane-head`).getBoundingClientRect().top),
          box: box.getBoundingClientRect().toJSON(),
        };
      }, lane);
    const before = await state();
    assert(before.page <= 1, `the page doesn't scroll in board layout: ${JSON.stringify(before)}`);
    assert(before.more > 200, `the lane scrolls its cards: ${JSON.stringify(before)}`);
    await board.$eval(`${lane} .lane-scroll`, (e) => {
      e.scrollTop = e.scrollHeight;
    });
    const scrolled = await state();
    assert(scrolled.top > 200 && scrolled.head === before.head && scrolled.pageTop === 0, `the head stays, the page too: ${JSON.stringify(scrolled)}`);
    await board.$eval(`${lane} .lane-scroll`, (e) => {
      e.scrollTop = 0;
    });
    // the keyboard walks down the lane; the card it lands on comes into view inside the lane, the page stays
    await board.focus(`${lane} .bcard`);
    for (let i = 0; i < 6; i++) await board.keyboard.press('ArrowDown');
    const focused = await board.evaluate((lane) => {
      const el = document.activeElement;
      const cards = [...document.querySelectorAll(`${lane} .bcard`)];
      return { index: cards.indexOf(el), rect: el.getBoundingClientRect().toJSON() };
    }, lane);
    const after = await state();
    assert(focused.index === 6, `↓ reached the last card of the lane: ${focused.index}`);
    assert(
      focused.rect.top >= after.box.top - 1 && focused.rect.bottom <= after.box.bottom + 1 && after.top > 0 && after.pageTop === 0,
      `the card is in view inside its lane: ${JSON.stringify({ card: focused.rect, lane: after.box, top: after.top, page: after.pageTop })}`,
    );
    if (SHOTS) await board.screenshot({ path: path.join(SHOTS, '03-board-lane-scrolled.png') });
    const fit = await fitsAt(board, 'board with a long lane');
    assert(!fit.length, fit.join('\n        '));
    // a phone stacks the lanes: there the page scrolls, not the lanes
    await board.setViewport({ width: 390, height: 844 });
    await sleep(300);
    const phone = await state();
    assert(phone.page > 200 && phone.more <= 1, `on a phone the page scrolls, the lanes don't: ${JSON.stringify(phone)}`);
    await ctx.close();
  });

  // ---------------------------------------------------------------- moving cards on the board (library/moves.ts)
  // Videos of their own in a project of their own: the checks above keep their four, these walk their own through the
  // lanes. A move shows at once and reaches the server once its Undo toast is gone (closing the toast sends it now).
  const kanban = {};
  for (const [name, freq] of [
    ['a', 300],
    ['b', 350],
    ['c', 400],
    ['d', 450],
    ['e', 500],
  ])
    kanban[name] = await add(`Kanban/export/${name}.mp4`, 'Kanban', { dur: 1, freq });
  await api(`/api/review/${enc(kanban.b)}/comments`, 'POST', { frame: 2, text: 'Logo too early', severity: 'must' });
  await api(`/api/review/${enc(kanban.b)}/comments`, 'POST', { frame: 9, text: 'Music too loud', severity: 'must' });
  const stageOn = async (slug) => (await api(`/api/review/${enc(slug)}`)).summary.stage;
  const kctx = await browser.createBrowserContext();
  const kb = await kctx.newPage();
  kb.on('pageerror', (e) => errors.push(e.message));
  await kb.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 });
  const kshot = async (name) => SHOTS && kb.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  const openBoard = async () => {
    await kb.goto(`${BASE}/#/folder/Kanban`, { waitUntil: 'domcontentloaded' });
    await kb.evaluate(() => localStorage.setItem('vr.library', JSON.stringify({ layout: 'board' })));
    await kb.reload({ waitUntil: 'domcontentloaded' });
    await kb.waitForSelector('[data-testid=library-board] .bcard:not(.pending)', { timeout: 20000 });
  };
  const laneOfCard = (slug) =>
    kb.evaluate((s) => document.querySelector(`.bcard[data-slug="${s}"]`)?.closest('.lane')?.getAttribute('data-lane') ?? null, slug);
  // the board can re-render its cards right after it opens (a slow runner caught a card between two renders): ask again
  const centre = async (sel) => {
    for (let i = 0; ; i++) {
      const b = await (await kb.waitForSelector(sel, { visible: true })).boundingBox();
      if (b) return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      if (i === 40) throw new Error(`${sel} has no box on screen`);
      await sleep(50);
    }
  };
  // Press on the card's picture and lift it (the drag's code arrives with the first press: nudge until it has), then
  // carry it into a lane's cards. `drop: false` leaves it held there.
  const drag = async (slug, lane, { drop = true } = {}) => {
    // in view inside its lane first (the lanes scroll their cards)
    await kb.$eval(`.bcard[data-slug="${slug}"]`, (e) => e.scrollIntoView({ block: 'nearest' }));
    const from = await centre(`.bcard[data-slug="${slug}"] .bthumb`);
    await kb.mouse.move(from.x, from.y);
    await kb.mouse.down();
    try {
      for (let i = 0; i < 60 && !(await kb.$('.bcard-ghost')); i++) {
        await kb.mouse.move(from.x + 8 + (i % 4), from.y + 4);
        await sleep(50);
      }
      assert(await kb.$('.bcard-ghost'), 'the card lifts once the pointer moves');
      const head = await centre(`.lane[data-lane="${lane}"] .lane-head`);
      await kb.mouse.move(head.x, head.y + 140, { steps: 14 });
    } catch (e) {
      await kb.mouse.up();
      throw e;
    }
    if (drop) await kb.mouse.up();
  };
  const toasts = () => kb.$$eval('[data-testid=toast]', (els) => els.map((e) => e.textContent.trim()));
  // closing a move's toast sends it now (waiting for it does the same, after a few seconds)
  const sendNow = async () => {
    await until(async () => (await kb.$$('[data-testid=toast] [aria-label="Dismiss"]')).length > 0, 'the move’s toast');
    for (const x of await kb.$$('[data-testid=toast] [aria-label="Dismiss"]')) await x.click().catch(() => {});
  };

  await check('board: drag a card To review → Approved — the lane lights, says what dropping does, the server has it once its toast goes', async () => {
    await openBoard();
    assert((await laneOfCard(kanban.a)) === 'needs_you', `a starts to review: ${await laneOfCard(kanban.a)}`);
    await drag(kanban.a, 'approved', { drop: false });
    await kb.waitForSelector('.lane[data-lane="approved"][data-drop="lit"] [data-testid=drop-slot]', { timeout: 5000 });
    const lit = await kb.evaluate(() => ({
      slot: !!document.querySelector('.lane[data-lane="approved"] [data-testid=drop-slot]'),
      hint: document.querySelector('.bcard-ghost .bcard-ghost-hint.on')?.textContent.trim(),
      lanes: Object.fromEntries([...document.querySelectorAll('.lane')].map((l) => [l.dataset.lane, l.dataset.drop])),
      faded: getComputedStyle(document.querySelector('.bcard.lifted')).opacity,
    }));
    assert(lit.slot && lit.hint === 'Drop to approve V1', `its place in the lane, and what dropping does under the card: ${JSON.stringify(lit)}`);
    assert(
      lit.lanes.needs_you === 'from' && lit.lanes.fixing === 'ok' && lit.lanes.approved === 'lit' && lit.lanes.final === 'no',
      `final only from Approved: ${JSON.stringify(lit.lanes)}`,
    );
    assert(Number(lit.faded) < 0.6, `the card waits faded in its place: ${lit.faded}`);
    await kshot('kanban-01-drag-lit');
    await kb.mouse.up();
    // at once, before the server has it
    await until(async () => (await laneOfCard(kanban.a)) === 'approved', 'in Approved at once', 3000);
    await until(async () => !(await kb.$('.bcard-ghost')), 'the lifted copy goes', 3000);
    assert((await stageOn(kanban.a)).stage === 'to_review', 'the write waits for the toast');
    await until(async () => (await toasts()).some((x) => x.includes('a.mp4 → Approved')), 'the toast says it');
    await kshot('kanban-02-dropped-toast');
    // left alone, the toast goes and the move with it
    await until(async () => (await stageOn(kanban.a)).stage === 'team_approved', 'team-approved on the server', 20000);
    assert((await laneOfCard(kanban.a)) === 'approved', 'and it stays there');
  });

  await check('board: Approved → Final asks first (the app’s Confirm, ⌘↵), then locks it', async () => {
    await openBoard();
    await drag(kanban.a, 'final');
    await kb.waitForSelector('[data-testid=confirm]', { timeout: 5000 });
    const ask = await kb.$eval('[data-testid=confirm]', (e) => ({ title: e.querySelector('h3').textContent, text: e.textContent }));
    assert(ask.title === 'Mark “a.mp4” V1 final?', `the question names the video: ${ask.title}`);
    assert(ask.text.includes('agents fix nothing more'), `one sentence says what follows: ${ask.text}`);
    await kshot('kanban-03-final-confirm');
    await kb.keyboard.down('Meta');
    await kb.keyboard.press('Enter');
    await kb.keyboard.up('Meta');
    await until(async () => !(await kb.$('[data-testid=confirm]')), 'the confirm closes');
    await until(async () => (await laneOfCard(kanban.a)) === 'final', 'in Final');
    await sendNow();
    await until(async () => (await stageOn(kanban.a)).stage === 'final', 'final on the server');
  });

  await check('board: Final → To review reopens it (behind the Confirm) and withdraws the approval', async () => {
    await openBoard();
    await drag(kanban.a, 'needs_you');
    await kb.waitForSelector('[data-testid=confirm]', { timeout: 5000 });
    const title = await kb.$eval('[data-testid=confirm] h3', (e) => e.textContent);
    assert(title === 'Reopen “a.mp4”?', title);
    await kb.click('[data-testid=confirm-action]');
    await until(async () => (await laneOfCard(kanban.a)) === 'needs_you', 'back in To review');
    await sendNow();
    await until(async () => {
      const s = await stageOn(kanban.a);
      return s.stage === 'to_review' && !s.final && !s.team;
    }, 'reopened, the approval withdrawn, on the server');
  });

  await check('board: a lane that can’t take the card stays dim, the cursor says no, and dropping there changes nothing', async () => {
    await openBoard();
    assert((await laneOfCard(kanban.b)) === 'fixing', 'b has must-fix notes open');
    // To review: withdrawing nothing can't take open notes off it
    await drag(kanban.b, 'needs_you', { drop: false });
    const there = await kb.evaluate(() => ({
      lane: document.querySelector('.lane[data-lane="needs_you"]').dataset.drop,
      dim: getComputedStyle(document.querySelector('.lane[data-lane="needs_you"]')).opacity,
      cursor: getComputedStyle(document.querySelector('.board-drag-layer')).cursor,
      slot: !!document.querySelector('[data-testid=drop-slot]'),
      hint: !!document.querySelector('.bcard-ghost-hint.on'),
    }));
    assert(there.lane === 'no' && there.cursor === 'not-allowed' && !there.slot && !there.hint, `no target: ${JSON.stringify(there)}`);
    await until(async () => Number(await kb.$eval('.lane[data-lane="needs_you"]', (e) => getComputedStyle(e).opacity)) < 0.6, 'the lane dims');
    await kshot('kanban-04-no-drop');
    await kb.mouse.up();
    await until(async () => !(await kb.$('.bcard-ghost')), 'the copy goes back');
    assert((await laneOfCard(kanban.b)) === 'fixing', 'still being fixed');
    await sleep(300);
    assert(!(await toasts()).some((x) => x.includes('b.mp4')), 'no move, no toast');
    // Escape calls a drag off where it would have been taken
    await drag(kanban.b, 'approved', { drop: false });
    await kb.waitForSelector('.lane[data-lane="approved"][data-drop="lit"]');
    await kb.keyboard.press('Escape');
    await until(async () => !(await kb.$('.bcard-ghost')) && !(await kb.$('.lane[data-drop]')), 'Escape calls it off');
    await kb.mouse.up();
    assert((await laneOfCard(kanban.b)) === 'fixing', 'still being fixed after Escape');
    assert((await stageOn(kanban.b)).stage === 'changes', 'nothing reached the server');
  });

  await check('board: approving over open must-fix notes asks in one sentence first; Cancel puts the card back', async () => {
    await openBoard();
    await drag(kanban.b, 'approved');
    await kb.waitForSelector('[data-testid=confirm]', { timeout: 5000 });
    const ask = await kb.$eval('[data-testid=confirm]', (e) => ({
      title: e.querySelector('h3').textContent,
      body: e.querySelector('.alert-text').textContent,
    }));
    assert(ask.title === 'Approve “b.mp4” anyway?' && ask.body === '2 must-fix notes are still open on V1.', JSON.stringify(ask));
    assert((await laneOfCard(kanban.b)) === 'approved', 'it shows where it would go while asked');
    await kshot('kanban-05-musts-confirm');
    await kb.keyboard.press('Escape');
    await until(async () => (await laneOfCard(kanban.b)) === 'fixing', 'back in Being fixed');
    assert((await stageOn(kanban.b)).stage === 'changes', 'nothing sent');
  });

  await check('board: Undo puts the card back and nothing reaches the server', async () => {
    await openBoard();
    await drag(kanban.c, 'approved');
    await until(async () => (await laneOfCard(kanban.c)) === 'approved', 'in Approved');
    await kb.waitForSelector('[data-testid=toast] .toast-act');
    await kb.click('[data-testid=toast] .toast-act');
    await until(async () => (await laneOfCard(kanban.c)) === 'needs_you', 'Undo: back in To review');
    await sleep(8000);
    const s = await stageOn(kanban.c);
    assert(s.stage === 'to_review' && !s.team, `the server never had it: ${s.stage}`);
    assert(!(await api(`/api/review/${enc(kanban.c)}`)).approvals.length, 'no verdict in the history either');
  });

  await check('board: "Move to" in the card’s menu; Being fixed with nothing open asks for a sentence on the card', async () => {
    await openBoard();
    await kb.hover(`.bcard[data-slug="${kanban.d}"]`);
    await kb.click(`.bcard[data-slug="${kanban.d}"] .bcard-menu button`);
    await kb.waitForSelector('.menu [role=menuitem]');
    const menu = await kb.$$eval('.menu .menu-label, .menu [role=menuitem]', (els) => els.map((e) => e.textContent.trim()));
    const at = menu.indexOf('Move to');
    assert(at >= 0, `a "Move to" group: ${menu.join(' | ')}`);
    assert(
      menu[at + 1] === 'Being fixed⌥→' && menu[at + 2] === 'Approved',
      `the lanes it may go to, the next one a key away: ${menu.slice(at, at + 4).join(' | ')}`,
    );
    assert(!menu.slice(at).some((x) => x.startsWith('Final') || x.startsWith('To review')), 'not Final (only from Approved), not its own lane');
    await kshot('kanban-06-menu');
    await kb.evaluate(() => [...document.querySelectorAll('.menu [role=menuitem]')].find((e) => e.textContent.startsWith('Being fixed'))?.click());
    await kb.waitForSelector(`.bcard[data-slug="${kanban.d}"] [data-testid=move-note] textarea`, { timeout: 5000 });
    assert((await laneOfCard(kanban.d)) === 'fixing', 'it asks where it landed');
    assert(await kb.$eval(`.bcard[data-slug="${kanban.d}"] [data-testid=move-note] button[type=submit]`, (b) => b.disabled), 'a sentence first');
    await kb.type(`.bcard[data-slug="${kanban.d}"] [data-testid=move-note] textarea`, 'The end card holds two seconds too long');
    await kshot('kanban-07-note-in-place');
    await kb.keyboard.press('Enter');
    await until(async () => !(await kb.$('[data-testid=move-note]')), 'the field goes');
    await sendNow();
    await until(async () => (await stageOn(kanban.d)).stage === 'changes', 'changes requested on the server');
    const s = await stageOn(kanban.d);
    assert(s.team?.status === 'changes' && s.team.note === 'The end card holds two seconds too long', `the agent gets the words: ${JSON.stringify(s.team)}`);
  });

  await check('board: ⌥→ moves the focused card one lane on; Escape in its sentence calls it off', async () => {
    await openBoard();
    await kb.focus(`.bcard[data-slug="${kanban.e}"]`);
    await kb.keyboard.down('Alt');
    await kb.keyboard.press('ArrowRight');
    await kb.keyboard.up('Alt');
    await kb.waitForSelector(`.bcard[data-slug="${kanban.e}"] [data-testid=move-note] textarea`, { timeout: 5000 });
    assert((await laneOfCard(kanban.e)) === 'fixing', '⌥→ from To review: Being fixed');
    await kb.keyboard.press('Escape');
    await until(async () => (await laneOfCard(kanban.e)) === 'needs_you', 'Escape: back in To review');
    await until(async () => (await kb.evaluate(() => document.activeElement?.getAttribute('data-slug'))) === kanban.e, 'the focus is on the card again');
    // the other way, from Approved: ⌥→ is Final (behind its confirm)
    await api(`/api/review/${enc(kanban.e)}/approval`, 'PUT', { status: 'approved' });
    await until(async () => (await laneOfCard(kanban.e)) === 'approved', 'approved (live)');
    await kb.focus(`.bcard[data-slug="${kanban.e}"]`);
    await kb.keyboard.down('Alt');
    await kb.keyboard.press('ArrowRight');
    await kb.keyboard.up('Alt');
    await kb.waitForSelector('[data-testid=confirm]', { timeout: 5000 });
    await kb.keyboard.press('Enter');
    await until(async () => (await laneOfCard(kanban.e)) === 'final', 'in Final');
    await until(async () => (await kb.evaluate(() => document.activeElement?.getAttribute('data-slug'))) === kanban.e, 'the focus follows the card');
    await sendNow();
    await until(async () => (await stageOn(kanban.e)).stage === 'final', 'final on the server');
  });

  await check('board: a move made just before a reload still reaches the server (sent as the page leaves)', async () => {
    await openBoard();
    await drag(kanban.c, 'approved');
    await until(async () => (await laneOfCard(kanban.c)) === 'approved', 'in Approved');
    assert((await stageOn(kanban.c)).stage === 'to_review', 'still waiting behind its toast');
    await kb.reload({ waitUntil: 'domcontentloaded' });
    await until(async () => (await stageOn(kanban.c)).stage === 'team_approved', 'approved on the server after the reload', 5000);
    await kb.waitForSelector('[data-testid=library-board] .bcard:not(.pending)', { timeout: 20000 });
    await until(async () => (await laneOfCard(kanban.c)) === 'approved', 'and the reloaded board shows it there');
    // back for the phone's check below
    await api(`/api/review/${enc(kanban.c)}/approval`, 'PUT', { v: 1 });
    await until(async () => (await stageOn(kanban.c)).stage === 'to_review', 'withdrawn again');
  });

  await check(
    'board: a card dropped on a folder in the sidebar moves the video there; lifted over the board it is the card, off it the small chip',
    async () => {
      await openBoard();
      const slug = kanban.d;
      await kb.$eval(`.bcard[data-slug="${slug}"]`, (e) => e.scrollIntoView({ block: 'nearest' }));
      const from = await centre(`.bcard[data-slug="${slug}"] .bthumb`);
      await kb.mouse.move(from.x, from.y);
      await kb.mouse.down();
      try {
        for (let i = 0; i < 60 && !(await kb.$('.bcard-ghost')); i++) {
          await kb.mouse.move(from.x + 8 + (i % 4), from.y + 4);
          await sleep(50);
        }
        // the one of the two copies on screen: the card itself or the chip
        const lifted = () =>
          kb.evaluate(() => {
            const g = [...document.querySelectorAll('.bcard-ghost')].find((e) => getComputedStyle(e).display !== 'none');
            const b = g?.getBoundingClientRect();
            return b && { w: b.width, h: b.height, chip: g.classList.contains('board-chip') };
          });
        const card = await kb.$eval(`.bcard[data-slug="${slug}"]`, (e) => e.getBoundingClientRect().width);
        const over = await lifted();
        assert(
          over && !over.chip && over.w > card - 1 && over.w < card * 1.05,
          `over the board, the card itself (${card} px, lifted a little): ${JSON.stringify(over)}`,
        );
        const row = await kb.evaluateHandle(() =>
          [...document.querySelectorAll('.nav-item')].find((n) => n.querySelector('.nav-label')?.textContent.trim() === 'Acme'),
        );
        const b = await row.asElement().boundingBox();
        await kb.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 14 });
        await kb.waitForFunction(() => document.querySelector('.nav-item.drop'), { timeout: 5000 });
        const off = await lifted();
        assert(off?.chip && off.w <= 320 && off.h <= 64, `over the sidebar, the list's small chip: ${JSON.stringify(off)}`);
        const hint = await kb.$eval('.bcard-ghost .bcard-ghost-hint.on', (e) => e.textContent.trim());
        assert(hint === 'Move to Acme', `what dropping does: ${hint}`);
        await kshot('kanban-07-to-folder');
      } finally {
        await kb.mouse.up();
      }
      await until(async () => ((await api('/api/library')).videos.find((v) => v.slug === slug)?.folder ?? '').startsWith('Acme'), 'the video is in Acme');
    },
  );

  await check('board moves on a phone: the menu’s "Move to", the lanes stacked', async () => {
    await kb.setViewport({ width: 390, height: 844, deviceScaleFactor: SHOTS ? 3 : 1, isMobile: true, hasTouch: true });
    await openBoard();
    await kb.waitForSelector(`.bcard[data-slug="${kanban.c}"] .bcard-menu button`);
    await kb.$eval(`.bcard[data-slug="${kanban.c}"]`, (e) => e.scrollIntoView({ block: 'center' }));
    await kb.tap(`.bcard[data-slug="${kanban.c}"] .bcard-menu button`);
    await kb.waitForSelector('.menu [role=menuitem]');
    // the sheet comes up under the finger: the tap that opened it picks nothing in it (its click lands on an item)
    await sleep(500);
    assert((await laneOfCard(kanban.c)) === 'needs_you' && (await kb.$('.menu [role=menuitem]')), 'the opening tap chose nothing; the sheet stays');
    const items = await kb.$$eval('.menu .menu-label, .menu [role=menuitem]', (els) => els.map((e) => e.textContent.trim()));
    assert(items.includes('Move to') && items.includes('Approved'), items.join(' | '));
    await kshot('kanban-08-phone-menu');
    await kb.evaluate(() => [...document.querySelectorAll('.menu [role=menuitem]')].find((e) => e.textContent.startsWith('Approved'))?.click());
    await until(async () => (await laneOfCard(kanban.c)) === 'approved', 'in Approved');
    await sendNow();
    await until(async () => (await stageOn(kanban.c)).stage === 'team_approved', 'approved on the server');
    await kshot('kanban-09-phone-moved');
    await kctx.close();
  });

  await check('no page errors along the way', async () => {
    assert(!errors.length, errors.join(' | '));
  });
} catch (e) {
  crashed(e, srv);
} finally {
  await finish(LABEL, { browser, servers: [srv] });
}
