#!/usr/bin/env node
// covers: web/src/player/ web/src/styles/player.css web/src/styles/notes.css web/src/styles/dock.css
// covers: web/src/styles/drawbar.css web/src/styles/autocheck.css server/routes/review.ts server/routes/analysis.ts
// covers: server/routes/previews.ts server/routes/media.ts lib/diff.ts lib/qa.ts lib/previews.ts lib/range.ts
// Browser end-to-end test of the player's review tools: a real server (local mode, temp store, free port) + headless
// Chrome. The version picker; compare (B) side by side, wipe and overlay (difference / onion skin) with the approved
// version preselected, swap, Esc and the remembered mode; notes as rows that open into threads (activity lines,
// replies), editing in place (no resize handle, grows, ⌘↵ saves, Esc cancels); the composer (the text first, one
// toolbar: severity, tags and #, the paperclip, voice; the whole video in the head's menu; ⌘↵ saves, Esc cancels); the
// filters; an agent question answered on its card; Auto-check — its chip in the notes panel's head, the findings in its
// popover — findings turned into a note or dismissed — a freeze says what, where (its frame's picture, a click plays the
// stretch) and why, and "That's intended" keeps it away in the next version; a fix preview (a still made in the
// project) checked in verify mode against the render and verified on it; review mode (N) stepping through the open
// notes; the timeline's hover label and frame preview; nothing bends a coloured edge along a rounded box; the player
// and its composer fit in both themes.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { timecode } from '../../lib/time.ts';
import { age, FFMPEG, makeFreezeVideo, makeVideo, sleep, until } from '../lib/helpers.ts';
import { bentEdges, layoutMatrix } from './layout.mjs';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'player e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-player-e2e-', user: 'Sam' });
const { dir, base: BASE } = srv;

const api = jsonApi(BASE);
const enc = encodeURIComponent;

let browser;
try {
  // spot.mp4: V1 approved, V2 re-rendered; one note the agent fixed in V2, one open, one agent question.
  const file = makeVideo(path.join(dir, 'Acme/export/spot.mp4'), { w: 320, h: 180, fps: 30, dur: 3 });
  age(file);
  const { video } = await api('/api/library', 'POST', { path: file, folder: 'Acme/Reels' });
  const slug = video.slug;
  const add = (body) => api(`/api/review/${enc(slug)}/comments`, 'POST', { v: 1, severity: 'should', ...body });
  const fixed = await add({ frame: 12, text: 'Logo a touch later' });
  const open = await add({ frame: 45, text: 'Music softer', severity: 'must' });
  await api(`/api/review/${enc(slug)}/approval`, 'PUT', { status: 'approved' });
  makeVideo(file, { w: 320, h: 180, fps: 30, dur: 3, pattern: 'testsrc2', freq: 660 });
  age(file);
  await api(`/api/review/${enc(slug)}/sync`, 'POST', {});
  await api(`/api/comments/${fixed.id}`, 'PATCH', { status: 'fixed', note: 'Logo now lands at 0:01', by: 'agent:promo-edit' });
  const question = await add({ v: 2, frame: 60, text: 'Keep the end card?', kind: 'question', by: 'agent:promo-edit' });
  // teaser.mp4: one version, only for dismissing an Auto-check finding.
  const tfile = makeVideo(path.join(dir, 'Acme/export/teaser.mp4'), { w: 320, h: 180, fps: 30, dur: 3 });
  age(tfile);
  const teaser = (await api('/api/library', 'POST', { path: tfile, folder: 'Acme/Reels' })).video;
  // holds.mp4: a hold of every kind Auto-check tells apart (test/lib/helpers.ts makeFreezeVideo).
  const hfile = makeFreezeVideo(path.join(dir, 'Acme/export/holds.mp4'));
  age(hfile);
  const holds = (await api('/api/library', 'POST', { path: hfile, folder: 'Acme/Reels' })).video;
  // reel.mp4: a vertical video, for the phone view's apps.
  const rfile = makeVideo(path.join(dir, 'Acme/export/reel.mp4'), { w: 180, h: 320, fps: 25, dur: 2, pattern: 'testsrc2' });
  age(rfile);
  const reel = (await api('/api/library', 'POST', { path: rfile, folder: 'Acme/Reels' })).video;
  const review = async (s = slug) => (await api(`/api/review/${enc(s)}`)).review;
  const note = async (id) => (await review()).comments.find((c) => c.id === id);

  browser = await launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `player-${name}.png`) });
  const clickText = (sel, text) =>
    page.evaluate(
      (sel, text) => {
        const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().startsWith(text));
        el?.click();
        return !!el;
      },
      sel,
      text,
    );
  // Radix tabs switch on mousedown: a real click, not element.click().
  const pressText = async (sel, text) => {
    for (const h of await page.$$(sel)) if ((await h.evaluate((e) => e.textContent.trim())).startsWith(text)) return h.click();
    throw new Error(`no ${sel} starting with ${text}`);
  };
  const text = (sel) => page.$eval(sel, (e) => e.textContent.trim()).catch(() => null);
  // A fresh page load every time: a hash change alone would keep whatever the last check left open or focused.
  const openPlayer = async (s = slug) => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${enc(s)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.note, .side-empty');
    await page.waitForFunction(() => document.querySelector('.vbox video')?.readyState >= 2, { timeout: 20000 });
  };
  const cardOf = async (id) => {
    for (const h of await page.$$('.note')) if ((await h.$eval('.c-id', (e) => e.textContent).catch(() => '')) === id) return h;
    return null;
  };
  // A note is a row until it is selected: a click opens it in place into its card (the same element).
  const openCard = async (id) => {
    const c = await cardOf(id);
    assert(c, `note ${id} is listed`);
    if (!(await c.evaluate((e) => e.classList.contains('active')))) await c.click();
    await page.waitForFunction((id) => [...document.querySelectorAll('.note.active')].some((n) => n.querySelector('.c-id')?.textContent === id), {}, id);
    return c;
  };
  // Auto-check is a chip in the notes panel's head (a phone's sheet: the tags' line); its findings are in its popover.
  const openChecks = async (timeout = 90000) => {
    await page.waitForSelector('[data-testid=ac-chip]', { timeout });
    if (!(await page.$('.ac-pop .autocheck'))) await page.click('[data-testid=ac-chip]');
    await page.waitForSelector('.ac-pop .autocheck');
  };
  const ctrlEnter = async () => {
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');
  };

  await check('the version picker lists the renders newest first and switches between them', async () => {
    await openPlayer();
    assert((await text('[data-testid=version-picker]'))?.startsWith('V2'), 'shows V2');
    await page.click('[data-testid=version-picker]');
    await page.waitForSelector('.vpick-list');
    const rows = await page.$$eval('.vpick-row', (els) => els.map((e) => e.textContent));
    assert(rows.length === 2 && rows[0].includes('V2') && /newest/i.test(rows[0]) && /approved/i.test(rows[1]), `rows: ${rows}`);
    await clickText('.vpick-row', 'V1');
    await until(async () => /not the newest/.test((await text('[data-testid=version-picker]')) || ''), 'V1 is marked as not the newest');
    await page.click('[data-testid=version-picker]');
    await page.waitForSelector('.vpick-list');
    await clickText('.vpick-row', 'V2');
    await until(async () => (await text('[data-testid=version-picker]')) === 'V2', 'back on V2');
  });

  await check('compare: B opens side by side against the approved version; wipe, overlay, onion skin, swap, Esc', async () => {
    await openPlayer();
    await page.keyboard.press('b');
    await page.waitForSelector('[data-testid=compare-bar]');
    await until(async () => (await page.$$('.stage .pane')).length === 2, 'two panes side by side');
    const bar = await text('[data-testid=compare-bar]');
    assert(/V2 · newest/.test(bar) && /V1 · approved/.test(bar), `bar names both sides: ${bar}`);
    await shot('compare-side');
    await clickText('[data-testid=compare-bar] button', 'Wipe');
    await until(async () => (await page.$$('.stage .pane')).length === 1 && !!(await page.$('.wipe-handle')), 'one pane with a wipe handle');
    await clickText('[data-testid=compare-bar] button', 'Overlay');
    await until(
      async () => (await page.$eval('.wipe.overlay video', (v) => getComputedStyle(v).mixBlendMode).catch(() => '')) === 'difference',
      'B in difference',
    );
    assert(!(await page.$('.wipe-handle')), 'no handle over an overlay');
    await clickText('[data-testid=compare-bar] button', 'Onion skin');
    await page.waitForSelector('[data-testid=compare-bar] [role=slider]');
    const opacity = await page.$eval('.wipe.overlay video', (v) => Number(getComputedStyle(v).opacity));
    assert(opacity > 0 && opacity < 1, `onion skin fades B: ${opacity}`);
    await shot('compare-onion');
    // A ⇄ B: now V1 is on screen, V2 is B.
    await page.click('[data-testid=compare-bar] button[aria-label="Swap A and B"]');
    await until(async () => (await text('[data-testid=version-picker]'))?.startsWith('V1'), 'swapped: V1 on screen');
    await page.keyboard.press('Escape');
    await until(async () => !(await page.$('[data-testid=compare-bar]')), 'Esc closes compare');
    await page.keyboard.press('b');
    await page.waitForSelector('[data-testid=compare-bar]');
    await until(async () => !!(await page.$('.wipe.overlay')), 'the last mode (overlay) comes back');
    await page.keyboard.press('b');
    await until(async () => !(await page.$('[data-testid=compare-bar]')), 'B closes it again');
  });

  await check('notes are threads: the agent’s fix is an activity line, a reply is a message', async () => {
    await openPlayer();
    // at rest a row: its timecode, its words, and that it is fixed — no thread until it is opened
    const row = await cardOf(fixed.id);
    assert(row, 'the fixed note is listed');
    assert(!(await row.$('.act-line')) && /Fixed/.test(await row.$eval('.nr-meta', (e) => e.textContent)), 'a row says it is fixed');
    const c = await openCard(fixed.id);
    const act = await c.$eval('.act-line', (e) => e.textContent);
    assert(/promo-edit/.test(act) && /fixed it in V2/.test(act), `activity line: ${act}`);
    assert(/Logo now lands at 0:01/.test(await c.$eval('.act-text', (e) => e.textContent)), 'what the agent said sits under it');
    await page.waitForSelector('.note.active .reply-stub');
    await page.click('.note.active .reply-stub');
    await page.waitForSelector('.note.active .note-editor textarea');
    await page.keyboard.type('Looks right on my screen');
    await ctrlEnter();
    await until(async () => (await note(fixed.id)).replies.some((r) => r.text === 'Looks right on my screen'), 'reply saved');
    await until(
      async () => ((await (await cardOf(fixed.id))?.$$eval('.msg p', (els) => els.map((e) => e.textContent))) || []).includes('Looks right on my screen'),
      'reply shown as a message',
    );
  });

  await check('editing in place: no resize handle, grows with the text, Esc cancels, ⌘↵ saves', async () => {
    const c = await openCard(open.id);
    await (await c.$('button[aria-label^="Actions"]')).click();
    await page.waitForSelector('[role=menuitem]');
    await clickText('[role=menuitem]', 'Edit text');
    const ta = '.note.active .note-edit textarea';
    await page.waitForSelector(ta);
    assert((await page.$eval(ta, (e) => getComputedStyle(e).resize)) === 'none', 'no resize handle');
    const h0 = await page.$eval(ta, (e) => e.getBoundingClientRect().height);
    await page.keyboard.press('End');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');
    await page.keyboard.type('and a second line');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');
    await page.keyboard.type('and a third');
    const h1 = await page.$eval(ta, (e) => e.getBoundingClientRect().height);
    assert(h1 > h0 + 20, `grows: ${h0} → ${h1}`);
    assert((await page.$eval(ta, (e) => e.scrollHeight - e.clientHeight)) <= 1, 'no inner scrollbar');
    await shot('edit');
    await page.keyboard.press('Escape');
    await until(async () => !(await page.$(ta)), 'Esc closes the editor');
    assert((await note(open.id)).text === 'Music softer', 'Esc keeps the old text');
    await (await (await cardOf(open.id)).$('button[aria-label^="Actions"]')).click();
    await page.waitForSelector('[role=menuitem]');
    await clickText('[role=menuitem]', 'Edit text');
    await page.waitForSelector(ta);
    await page.keyboard.press('End');
    await page.keyboard.type(' in the intro');
    await ctrlEnter();
    await until(async () => (await note(open.id)).text === 'Music softer in the intro', '⌘↵ saves');
  });

  await check('filters: Open, Questions (only while there are some), Mine, Closed, All; a question is answered on the card', async () => {
    const tabs = await page.$$eval('.note-filters [role=tab]', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    // an empty list is just its word (the row fits the panel in every language)
    assert(tabs.join('|') === 'Open 3|Questions 1|Mine 2|Closed|All 3', `tabs: ${tabs.join('|')}`);
    // the panel's head is one calm row: + Note says its word (the key lives in its tooltip), Record is its dot
    const head = await page.$eval('.side-title', (e) => {
      const mids = [...e.querySelectorAll('button')].map((b) => b.getBoundingClientRect()).map((r) => r.top + r.height / 2);
      return {
        note: e.querySelector('[data-testid=new-note]')?.textContent.trim(),
        kbd: !!e.querySelector('[data-testid=new-note] kbd'),
        rec: e.querySelector('[data-testid=record]')?.textContent.trim(),
        spread: Math.max(...mids) - Math.min(...mids),
      };
    });
    assert(head.note === 'Note' && !head.kbd && head.rec === '' && head.spread < 3, JSON.stringify(head));
    await pressText('.note-filters [role=tab]', 'Questions');
    await until(async () => (await page.$$('.note')).length === 1, 'one question');
    assert(/Question/.test(await (await cardOf(question.id)).$eval('.nr-meta', (e) => e.textContent)), 'its row says it is a question');
    const q = await openCard(question.id);
    assert(/Question/.test(await q.$eval('.note-meta', (e) => e.textContent)), 'labelled a question');
    await q.$eval('.note-answer textarea', (e) => e.focus());
    await page.keyboard.type('Yes, keep it');
    await ctrlEnter();
    await until(async () => (await note(question.id)).status === 'verified', 'answered');
    await until(
      async () => !(await page.$$eval('.note-filters [role=tab]', (els) => els.some((e) => e.textContent.startsWith('Questions')))),
      'no questions left: the tab goes',
    );
  });

  await check('review mode: N steps through the open notes on their frames, Esc leaves', async () => {
    await openPlayer();
    const waiting = (await review()).comments.filter((c) => c.status === 'open' || c.status === 'fixed').length;
    await page.keyboard.press('n');
    await page.waitForSelector('[data-testid=review-hud]');
    assert((await text('.rh-count')) === `1 / ${waiting}`, `first of ${waiting}: ${await text('.rh-count')}`);
    assert((await text('.review-hud .c-tc')) === (await note(fixed.id)).timecode, 'on the first note');
    await page.keyboard.press('n');
    await until(async () => (await text('.rh-count')) === `2 / ${waiting}`, 'second note');
    await until(async () => (await text('.transport .tc .main')) === (await text('.review-hud .c-tc')), 'the playhead is on its frame');
    await shot('review');
    await page.keyboard.press('Escape');
    await until(async () => !(await page.$('[data-testid=review-hud]')), 'Esc leaves review mode');
  });

  await check('Auto-check: explains itself, a finding becomes a note, another is dismissed', async () => {
    await openPlayer();
    // no card above the notes any more: one chip in the panel's head
    assert(!(await page.$('.side-scroll .autocheck')), 'Auto-check is not in the notes list');
    await openChecks();
    await until(async () => /finding|No issues/.test((await text('.ac-summary')) || ''), 'the check finished', 90000);
    assert(/on-screen text/.test(await text('.ac-about')), 'says what it checks');
    if ((await page.$('.ac-more')) && !(await page.$('.ac-more[aria-expanded=true]'))) await page.click('.ac-more');
    await page.waitForSelector('.ac-row');
    const before = (await review()).comments.length;
    await page.click('.ac-row .ac-thumb');
    await clickText('.ac-row button', 'Ask the agent');
    await until(async () => (await review()).comments.length === before + 1, 'the finding is a note now');
    await openPlayer(teaser.slug);
    await openChecks();
    await until(async () => /finding/.test((await text('.ac-summary')) || ''), 'the teaser has a finding', 90000);
    if ((await page.$('.ac-more')) && !(await page.$('.ac-more[aria-expanded=true]'))) await page.click('.ac-more');
    await page.waitForSelector('.ac-row');
    await page.click('.ac-row .ac-thumb');
    await page.waitForSelector('.ac-row [data-testid=ac-intended]');
    await page.click('.ac-row [data-testid=ac-intended]');
    await until(async () => ((await review(teaser.slug)).qa_dismissed || []).length === 1, 'dismissed for good', 20000);
  });

  await check('Auto-check: a freeze says what, where and why, and a click plays its stretch', async () => {
    await openPlayer(holds.slug);
    const row = '.ac-row[data-key="freeze:40"]';
    // something looks like a problem: the chip says how many, in the problem colour
    await until(
      async () => (await page.$eval('[data-testid=ac-chip]', (e) => e.dataset.state).catch(() => '')) === 'problems',
      'the chip says problems',
      90000,
    );
    assert(/to check/.test(await text('[data-testid=ac-chip]')), `the chip: ${await text('[data-testid=ac-chip]')}`);
    await openChecks();
    await page.waitForSelector(row, { timeout: 90000 });
    assert((await page.$eval(row, (e) => e.dataset.likely)) === 'problem', 'looks like a problem');
    assert((await text(`${row} .ac-what`)) === 'The picture stops for 0.64 s while the sound goes on', `what: ${await text(`${row} .ac-what`)}`);
    const where = `${timecode(40, 25)} → ${timecode(55, 25)} · 0.64 s`;
    assert((await text(`${row} .ac-where`)) === where, `where: ${await text(`${row} .ac-where`)} (${where})`);
    assert((await text(`${row} [data-testid=ac-verdict]`)) === 'Looks like a problem', 'the guess, closed');
    // its picture: the frame itself, small
    await page.waitForFunction((r) => document.querySelector(`${r} .ac-thumb img`)?.naturalWidth > 0, { timeout: 20000 }, row);
    assert(/frame=40&size=thumb/.test(await page.$eval(`${row} .ac-thumb img`, (i) => i.getAttribute('src'))), 'the picture of frame 40');
    // the minor ones, folded under the problems: the pause looks intended
    assert(!(await page.$('.ac-row[data-key="freeze:128"]')), 'the minor ones are folded');
    await page.click('.ac-more');
    await page.waitForSelector('.ac-row[data-key="freeze:128"]');
    assert((await page.$eval('.ac-row[data-key="freeze:128"]', (e) => e.dataset.likely)) === 'intended', 'a hold in a pause looks intended');
    assert(!(await page.$('.ac-row[data-key^="freeze:170"]')), 'the end card is not listed');
    // the foot says the same as Auto-check
    await until(async () => (await text('[data-testid=freeze-chip]')) === '4 freezes · 2 to check', 'the freeze chip agrees');
    // a click on the picture plays from a moment before the freeze to a moment after it, and opens the why
    const seen = [];
    await page.click(`${row} .ac-thumb`);
    await page.waitForFunction(() => !document.querySelector('.vbox video').paused, { timeout: 5000 });
    for (let t = Date.now(); Date.now() - t < 8000; await sleep(40)) {
      seen.push(Number(await page.$eval('.tc .sub b', (e) => e.textContent)));
      if (await page.$eval('.vbox video', (v) => v.paused)) break;
    }
    const last = seen.at(-1);
    assert(Math.min(...seen) <= 30 && seen.some((f) => f >= 40 && f <= 55), `played through the freeze: ${seen.join(',')}`);
    assert(last >= 60 && last <= 70, `stopped a moment after it: F${last}`);
    const why = await text(`${row} [data-testid=ac-why]`);
    assert(why === 'Nothing moved for 16 frames (0.64 s). Auto-check flags still stretches from 6 frames (0.24 s) inside the video.', `why: ${why}`);
    assert(
      /^Looks like a problem: the motion stops dead or jumps ahead after it while the sound carries on/.test(await text(`${row} [data-testid=ac-verdict]`)),
      'the guess and what it rests on',
    );
    await shot('autocheck-freeze');
  });

  await check('Auto-check: "That’s intended" puts a freeze away, and it stays away in the next version', async () => {
    await page.click('.ac-row[data-key="freeze:40"] [data-testid=ac-intended]');
    await page.waitForSelector('.ac-row[data-key="freeze:40"]', { hidden: true, timeout: 5000 });
    // held back with Undo, then sent: kept with where it was
    await until(async () => (await review(holds.slug)).qa_stretches?.['freeze:40']?.out === 55, 'the dismissal and its stretch', 20000);
    await until(async () => (await text('[data-testid=freeze-chip]')) === '4 freezes · 1 to check', 'the chip follows');
    // V2: the same freeze, two frames later
    makeFreezeVideo(hfile, { shift: 2, freq: 550 });
    age(hfile);
    await api(`/api/review/${enc(holds.slug)}/sync`, 'POST', {});
    await openPlayer(holds.slug);
    assert((await text('[data-testid=version-picker]'))?.startsWith('V2'), 'on V2');
    await openChecks();
    await page.waitForSelector('.ac-row[data-key="freeze:short"]', { timeout: 90000 });
    const v2 = await api(`/api/qa/${enc(holds.slug)}/2`);
    assert(
      v2.items.some((x) => x.key === 'freeze:42'),
      `V2 has the freeze at 42: ${v2.items.map((x) => x.key)}`,
    );
    if ((await page.$('.ac-more')) && !(await page.$('.ac-more[aria-expanded=true]'))) await page.click('.ac-more');
    assert(!(await page.$('.ac-row[data-key="freeze:42"]')), 'it stays away on V2');
    assert(await page.$('.ac-row[data-key="freeze:128"]'), 'the others are still there');
  });

  await check('Auto-check on a phone (360, 390): a finding’s head wraps inside its card, never into its gutter', async () => {
    try {
      for (const width of [360, 390]) {
        await page.setViewport({ width, height: 800, isMobile: true, hasTouch: true });
        await openPlayer(holds.slug);
        for (let i = 0; i < 3 && !(await page.$('.nsheet-half, .nsheet-full')); i++) {
          await page.click('.nsheet-handle');
          await sleep(400);
        }
        // a phone: the chip opens the tags' line, its findings come up as a sheet
        await page.waitForSelector('.note-tagf [data-testid=ac-chip]', { timeout: 90000 });
        await page.$eval('[data-testid=ac-chip]', (b) => b.click());
        await page.waitForSelector('.ac-pop .ac-row', { timeout: 90000 });
        const sheet = await page.$eval('.ac-pop', (e) => ((r) => ({ left: r.left, right: r.right, bottom: r.bottom }))(e.getBoundingClientRect()));
        assert(sheet.left <= 1 && sheet.right >= width - 1 && sheet.bottom >= 799, `the findings are a sheet from the bottom edge: ${JSON.stringify(sheet)}`);
        if ((await page.$('.ac-more')) && !(await page.$('.ac-more[aria-expanded=true]'))) await page.$eval('.ac-more', (b) => b.click());
        // opened: the head, the guess, why and the two ways out all have to fit
        await page.$eval('.ac-row[data-key="freeze:128"] .ac-thumb', (b) => b.click());
        await page.waitForSelector('.ac-row[data-key="freeze:128"] [data-testid=ac-why]');
        const out = await page.$$eval('.ac-row', (rows) =>
          rows.flatMap((row) => {
            const box = row.getBoundingClientRect();
            const cs = getComputedStyle(row);
            const [l, r] = [box.left + parseFloat(cs.paddingLeft), box.right - parseFloat(cs.paddingRight)];
            const bad = [];
            // the card's gutter is the same as the gap between its picture and its words, at least 8 px
            if (parseFloat(cs.paddingRight) < 8 || parseFloat(cs.paddingLeft) < 8) bad.push(`${row.dataset.key}: gutter ${cs.paddingLeft}/${cs.paddingRight}`);
            for (const e of row.querySelectorAll('.ac-line, .ac-line *, .ac-what, .ac-verdict, .ac-why, .ac-acts, .ac-acts .btn')) {
              const b = e.getBoundingClientRect();
              if (b.right > r + 0.5 || b.left < l - 0.5)
                bad.push(
                  `${row.dataset.key} .${e.className.toString().split(' ')[0] || e.tagName}: ${Math.round(b.left)}–${Math.round(b.right)} outside ${Math.round(l)}–${Math.round(r)}`,
                );
            }
            return bad;
          }),
        );
        assert(!out.length, `at ${width}: ${out.join('; ')}`);
        // the range still reads as one: timecodes together, then the length
        const where = await text('.ac-row[data-key="freeze:128"] .ac-where');
        assert(where === `${timecode(128, 25)} → ${timecode(148, 25)} · 0.84 s`, `where: ${where}`);
        await shot(`autocheck-phone-${width}`);
      }
    } finally {
      // the checks after this one are on a desktop
      await page.setViewport({ width: 1440, height: 900, isMobile: false, hasTouch: false });
    }
  });

  await check('Auto-check that couldn’t read a version says so (not "Checking…" for good), and Run again asks once more', async () => {
    // the server's answer for a check that failed (server/background.ts; background.test.ts makes a real one)
    const qaUrl = `/api/qa/${enc(reel.slug)}/1`;
    const reruns = [];
    const answer = (r) => {
      if (r.method() === 'GET' && r.url().endsWith(qaUrl))
        return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ none: true, failed: true, error: 'could not read' }) });
      if (r.method() === 'POST' && r.url().endsWith(`${qaUrl}/rerun`)) reruns.push(r.url());
      return r.continue();
    };
    await page.setRequestInterception(true);
    page.on('request', answer);
    try {
      await openPlayer(reel.slug);
      await until(async () => (await page.$eval('[data-testid=ac-chip]', (e) => e.dataset.state).catch(() => '')) === 'failed', 'the chip says it failed');
      assert(/Couldn’t read/.test(await text('[data-testid=ac-chip]')), `the chip: ${await text('[data-testid=ac-chip]')}`);
      assert(
        (await page.$eval('[data-testid=ac-chip]', (e) => e.getAttribute('aria-label'))) === 'Auto-check couldn’t read V1',
        'its label says which version',
      );
      await openChecks();
      assert((await text('.ac-summary')) === 'Couldn’t read V1', `the head: ${await text('.ac-summary')}`);
      assert(/couldn’t read this version’s file/.test((await text('[data-testid=ac-failed]')) || ''), 'what happened, in words');
      assert(!(await page.$('.ac-pop .ac-clear:not([data-testid=ac-failed])')), 'never "Nothing to fix"');
      await shot('autocheck-failed');
      await page.click('.ac-pop .ac-rerun');
      await until(() => reruns.length === 1, 'Run again asks the server once more');
      // a phone: the chip in the tags' line, the words in the sheet, inside the screen
      await page.setViewport({ width: 390, height: 800, isMobile: true, hasTouch: true });
      await openPlayer(reel.slug);
      for (let i = 0; i < 3 && !(await page.$('.nsheet-half, .nsheet-full')); i++) {
        await page.click('.nsheet-handle');
        await sleep(400);
      }
      await page.waitForSelector('.note-tagf [data-testid=ac-chip][data-state=failed]');
      await page.$eval('[data-testid=ac-chip]', (b) => b.click());
      await page.waitForSelector('.ac-pop [data-testid=ac-failed]');
      const box = await page.$eval('.ac-pop [data-testid=ac-failed]', (e) => ((r) => ({ left: r.left, right: r.right }))(e.getBoundingClientRect()));
      assert(box.left >= 0 && box.right <= 390, `the words fit the screen: ${JSON.stringify(box)}`);
      await shot('autocheck-failed-phone');
    } finally {
      page.off('request', answer);
      await page.setRequestInterception(false);
      await page.setViewport({ width: 1440, height: 900, isMobile: false, hasTouch: false });
    }
  });

  await check('the timeline: hover names the frame, the frame preview comes from the sprite', async () => {
    await openPlayer();
    const box = await (await page.$('.timeline canvas')).boundingBox();
    const hover = async () => {
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height - 4);
      await page.mouse.move(box.x + box.width * 0.52, box.y + box.height - 4);
    };
    await hover();
    await page.waitForSelector('[data-testid=tl-hover]');
    assert(/^\d\d:\d\d:\d\d · f\d+$/.test(await text('[data-testid=tl-hover]')), `timecode and frame on hover: ${await text('[data-testid=tl-hover]')}`);
    await until(
      async () => {
        await hover();
        return !!(await page.$('.tl-preview'));
      },
      'the sprite arrived',
      60000,
    );
    const bg = await page.$eval('.tl-preview', (e) => e.style.backgroundImage);
    assert(/\/api\/sprite\//.test(bg), `preview from the sprite: ${bg}`);
  });

  await check('a fix preview: check mode shows it beside the render at its frame, "Looks right" checks it on the preview', async () => {
    const title = await add({ v: 2, frame: 30, text: 'Title a touch smaller' });
    const png = path.join(dir, 'preview.png');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180', '-frames:v', '1', '-y', png]);
    const { preview } = await api(`/api/comments/${title.id}/previews`, 'POST', {
      kind: 'still',
      frame: 30,
      fixed: true,
      note: 'Title at 90 %',
      source: { app: 'After Effects', comp: 'Main' },
      data: fs.readFileSync(png).toString('base64'),
      by: 'agent:promo-edit',
    });
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${enc(slug)}?verify=${title.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=verify-preview]');
    assert(/After Effects · Main/.test(await text('[data-testid=verify-preview]')), 'says where it was made');
    await until(
      async () => /\/api\/previews\//.test((await page.$eval('.pane img.pane-still', (e) => e.src).catch(() => '')) || ''),
      'the preview beside the render',
    );
    await until(async () => (await text('.transport .tc .main')) === (await note(title.id)).timecode, 'the render is on the preview’s frame');
    await shot('verify-preview');
    await pressText('.verify-preview [role=radio], .verify-preview button', 'Wipe');
    await page.waitForSelector('.wipe img.wipe-still');
    await page.keyboard.press('y');
    await until(async () => (await note(title.id)).verified_on?.preview === preview.id, 'verified on the preview');
    await openPlayer();
    await pressText('.note-filters [role=tab]', 'All');
    await until(async () => !!(await cardOf(title.id)), 'the note is listed');
    const c = await openCard(title.id);
    assert(/Checked on the preview/.test(await c.$eval('.note-meta', (e) => e.textContent)), 'the card says it was checked on a preview');
    assert(/Waiting for the next version/.test(await c.$eval('[data-testid=fix-preview]', (e) => e.textContent)), 'the thread shows the preview and its state');
  });

  await check('Esc that closes a menu is the menu’s: the unsent note stays', async () => {
    await openPlayer();
    await page.keyboard.press('c');
    await page.waitForSelector('.composer textarea');
    await page.type('.composer textarea', 'Unsent thought');
    await page.click('.player button[aria-label="More"]');
    await page.waitForSelector('.menu[data-state=open]');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.menu[data-state=open]'));
    const kept = await page.$eval('.composer textarea', (e) => e.value).catch(() => null);
    assert(kept === 'Unsent thought', `the note was thrown away (${kept})`);
  });

  await check('the composer: the text first, one toolbar — severity (menu, 1–4), tags (menu, #), whole video, voice; ⌘↵ saves, Esc cancels', async () => {
    await openPlayer();
    const menuItem = async (label) => {
      await page.waitForSelector('.menu[data-state=open]');
      for (const h of await page.$$('.menu[data-state=open] [role^=menuitem]'))
        if ((await h.evaluate((e) => e.textContent.trim())).startsWith(label)) return h.click();
      throw new Error(`no menu item "${label}"`);
    };
    const severity = () => page.$eval('.composer-foot .sev-pick', (e) => e.getAttribute('aria-label'));
    await page.keyboard.press('c');
    await page.waitForSelector('.composer textarea');
    assert(await page.evaluate(() => document.activeElement?.matches('.composer textarea')), 'the text has the focus');
    // one quiet row: every control of the toolbar on one line, the voice note among them
    const rows = await page.$$eval('.composer-foot button', (els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().top)))]);
    assert(rows.length === 1, `the toolbar is one row: ${rows.join(', ')}`);
    assert(await page.$('.composer-foot [data-testid=voice]'), 'the voice note is an icon in the toolbar');
    assert((await severity()) === 'Severity: Should', await severity());
    // nothing written yet: Esc closes it at once
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.composer'), { timeout: 3000 });

    await page.keyboard.press('c');
    await page.waitForSelector('.composer textarea');
    await page.type('.composer textarea', 'Logo lands early #tim');
    await page.waitForSelector('[data-testid=tag-suggest] [role=option]');
    assert((await text('[data-testid=tag-suggest] [aria-selected=true]')) === 'timing', await text('[data-testid=tag-suggest]'));
    await page.keyboard.press('Enter');
    await page.waitForSelector('.composer [data-testid=tag-chip]');
    assert((await page.$eval('.composer textarea', (e) => e.value)) === 'Logo lands early ', 'the #word left the text');
    // the Tags menu stays open for another pick; its Esc is the menu's
    await page.click('.composer-foot button[aria-label="Tags"]');
    await menuItem('sfx');
    await sleep(150);
    assert(await page.$('.menu[data-state=open]'), 'the tags menu stays open');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.menu[data-state=open]'));
    const chips = await page.$$eval('.composer [data-testid=tag-chip]', (els) => els.map((e) => e.textContent.trim()));
    assert(chips.join(',') === 'timing,sfx', `the picked tags under the text: ${chips}`);
    await page.click('.composer-foot .sev-pick');
    await menuItem('Must');
    await until(async () => (await severity()) === 'Severity: Must', 'Must from the menu');
    // a menu on its way out still takes Escape (Radix): the next key waits until it has gone
    await page.waitForFunction(() => !document.querySelector('.menu'), { timeout: 5000 });
    // a pick with the pointer hands the focus back to the text: the typing goes on (and no ring on the menu's button)
    await until(async () => page.evaluate(() => document.activeElement?.matches('.composer textarea')), 'the text has the focus again after a pick');
    // the drawing tools are on the picture while the note is written, not in the composer
    assert(await page.$('.stage-overlay [data-testid=draw-bar]'), 'the drawing tools sit on the picture');
    assert(!(await page.$('.composer [role=toolbar]')), 'no drawing tray in the composer');
    // a written note: Esc leaves the field first; then 1–4 set the severity (not typing any more)
    await page.click('.composer textarea');
    await page.keyboard.press('Escape');
    assert(await page.$('.composer'), 'Esc with words written keeps the note');
    assert(!(await page.evaluate(() => document.activeElement?.matches('textarea'))), 'Esc left the field');
    await page.keyboard.press('3');
    await until(async () => (await severity()) === 'Severity: Nice', '3 is Nice');
    // the whole video is where the note is: the head's menu
    await page.click('.composer [data-testid=composer-where]');
    await menuItem('About the whole video');
    await until(async () => (await text('.composer-head .c-tc')) === 'Whole video', 'the head says Whole video');
    await until(async () => !(await page.$('[data-testid=draw-bar]')), 'no drawing tools for the whole video');
    await page.click('.composer textarea');
    await ctrlEnter();
    await page.waitForFunction(() => !document.querySelector('.composer'), { timeout: 20000 });
    let c;
    await until(async () => (c = (await review()).comments.find((x) => x.text === 'Logo lands early')), 'the note saved');
    assert(c.severity === 'nice', c.severity);
    assert(c.tags.includes('timing') && c.tags.includes('sfx'), c.tags.join(','));
    assert(c.scope === 'video', `scope ${c.scope}`);
  });

  await check('a link to the video that is open does what it says: the note opens, the playhead goes to the frame', async () => {
    await openPlayer();
    // ⌘K, the inbox's "Open in player" and a notification all change the hash of the page that is already open.
    await page.evaluate(
      (h) => {
        location.hash = h;
      },
      `#/v/${enc(slug)}?c=${open.id}`,
    );
    await until(async () => (await text('.note.active .c-id')) === open.id, 'the linked note is the active one');
    await until(async () => (await text('.transport .tc .main')) === (await note(open.id)).timecode, 'the playhead is on its frame');
    await page.evaluate(
      (h) => {
        location.hash = h;
      },
      `#/v/${enc(slug)}?f=10`,
    );
    await until(async () => (await text('.transport .tc .main')) === '00:00:10', 'the playhead is on frame 10');
  });

  await check('the loop button looks on when it is on, also under the pointer', async () => {
    await openPlayer();
    const loop = '.transport button[aria-label="Loop"]';
    const look = () =>
      page.$eval(loop, (b) => ({ pressed: b.getAttribute('aria-pressed'), bg: getComputedStyle(b).backgroundImage + getComputedStyle(b).backgroundColor }));
    await page.mouse.move(5, 5);
    const off = await look();
    await page.click(loop);
    await until(async () => (await look()).pressed === 'true', 'pressed');
    const onHovered = await look();
    await page.mouse.move(5, 5);
    const on = await look();
    assert(off.pressed === 'false' && on.bg !== off.bg, `on differs from off: ${JSON.stringify({ off, on })}`);
    assert(onHovered.bg === on.bg, `the pointer doesn't flatten it: ${JSON.stringify({ onHovered, on })}`);
    await page.click(loop);
    await until(async () => (await look()).pressed === 'false', 'off again');
  });

  await check('an out before the in starts a new section, as in an editor, and the loop plays on (never freezes)', async () => {
    await openPlayer();
    const goTo = async (f, tc) => {
      await page.evaluate(
        (h) => {
          location.hash = h;
        },
        `#/v/${enc(slug)}?f=${f}`,
      );
      await until(async () => (await text('.transport .tc .main')) === tc, `on frame ${f}`);
    };
    await goTo(60, '00:02:00');
    await page.keyboard.press('i');
    await goTo(20, '00:00:20');
    await page.keyboard.press('o');
    const io = await page.$$eval('[data-testid=mark-in], [data-testid=mark-out]', (els) => els.map((e) => e.getAttribute('aria-pressed')));
    assert(io.join() === 'false,true', `the in after the new out went: ${io}`);
    await page.keyboard.press('r');
    await page.keyboard.press(' ');
    await sleep(1200);
    const a = await text('.transport .tc .main');
    await sleep(400);
    const b = await text('.transport .tc .main');
    await page.keyboard.press(' ');
    assert(a !== b, `playback froze at ${a}`);
  });

  await check('verify: a second Y while the first is saved answers nothing, and no fix is skipped', async () => {
    const fixedNote = async (frame, text) => {
      const c = await add({ v: 2, frame, text });
      await api(`/api/comments/${c.id}`, 'PATCH', { status: 'fixed', note: 'done', by: 'agent:promo-edit' });
      return c;
    };
    const first = await fixedNote(88, 'Double press first');
    await fixedNote(89, 'Double press second');
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${enc(slug)}?verify=${first.id}`, { waitUntil: 'domcontentloaded' });
    await until(async () => /Double press first/.test((await text('.verify')) || ''), 'verify mode on the first fix');
    // The first verdict takes a moment to save: the second press lands while it is on its way.
    await page.setRequestInterception(true);
    const slow = (r) => (r.method() === 'PATCH' ? setTimeout(() => r.continue(), 400) : r.continue());
    page.on('request', slow);
    await page.keyboard.press('y');
    await page.keyboard.press('y');
    await until(async () => (await note(first.id)).status === 'verified', 'the first fix is verified');
    await sleep(800);
    page.off('request', slow);
    await page.setRequestInterception(false);
    assert(/Double press second/.test((await text('.verify')) || ''), `on to the second fix, not past it: ${await text('.verify')}`);
  });

  await check('no coloured edge bends along a rounded box in the player', async () => {
    await openPlayer();
    const bent = await bentEdges(page, '.player');
    assert(!bent.length, bent.join('; '));
  });

  await check('the transport stays one row with a section marked and looping, at 1024, 1440 and 1920 (and in phone view)', async () => {
    const oneRow = async (when) => {
      // both groups on one line (their middles level) and nothing inside either wrapped
      const row = await page.$eval('.transport', (t) => ({
        h: Math.round(t.getBoundingClientRect().height),
        mids: [...t.querySelectorAll(':scope > .group')].map((g) => {
          const r = g.getBoundingClientRect();
          return Math.round(r.top + r.height / 2);
        }),
        groups: [...t.querySelectorAll(':scope > .group')].map((g) => Math.round(g.getBoundingClientRect().height)),
      }));
      assert(
        Math.max(...row.mids) - Math.min(...row.mids) <= 1 && row.h <= 44 && row.groups.every((h) => h <= 44),
        `${when}: the transport is one row ${JSON.stringify(row)}`,
      );
    };
    for (const width of [1024, 1440, 1920]) {
      await page.setViewport({ width, height: 900 });
      await openPlayer();
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press('i');
      for (let i = 0; i < 2; i++) {
        await page.keyboard.down('Shift');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.up('Shift');
      }
      await page.keyboard.press('o');
      await page.keyboard.press('r');
      await page.waitForSelector('[data-testid=tl-mark]');
      // I and O say they are set: on (raised), not the ghost they are while unset
      const io = await page.$$eval('[data-testid=mark-in], [data-testid=mark-out]', (els) =>
        els.map((e) => `${e.getAttribute('aria-pressed')}:${e.classList.contains('on')}`),
      );
      assert(io.join() === 'true:true,true:true', `I and O are on: ${io}`);
      await oneRow(`${width}`);
      await shot(`transport-${width}`);
      if (width === 1024) {
        await page.keyboard.press('v');
        await page.waitForFunction(() => document.querySelector('.transport [data-testid=device]')?.classList.contains('on'));
        await oneRow(`${width}, phone view`);
        await page.keyboard.press('v');
        await page.waitForFunction(() => !document.querySelector('.transport [data-testid=device]')?.classList.contains('on'));
        // One button, one menu: a click lists Off and the phones; picking one turns the view on with it, nothing moves
        const before = await page.$eval('.transport [data-testid=device]', (b) => b.getBoundingClientRect().left);
        await page.click('.transport [data-testid=device]');
        await page.waitForSelector('.menu [role=menuitemcheckbox]');
        const items = await page.$$eval('.menu [role=menuitemcheckbox]', (els) => els.map((e) => e.textContent?.trim()));
        assert(items[0] === 'Off' && items.includes('Pixel 8') && items.length >= 3, `Off and the phones: ${items}`);
        await page.evaluate(() => [...document.querySelectorAll('.menu [role=menuitemcheckbox]')].find((e) => e.textContent?.trim() === 'Pixel 8')?.click());
        await page.waitForFunction(() => document.querySelector('.transport [data-testid=device]')?.classList.contains('on'));
        assert(
          (await page.$eval('.transport [data-testid=device]', (b) => b.getAttribute('aria-label'))) === 'Phone view: Full height · Pixel 8',
          'the button names the phone',
        );
        assert(Math.abs((await page.$eval('.transport [data-testid=device]', (b) => b.getBoundingClientRect().left)) - before) < 120, 'the button stays put');
        await page.keyboard.press('v');
      }
    }
    await page.setViewport({ width: 1440, height: 900 });
  });

  // The safe zones and the phone view are two choices, each drawing one thing (web/src/player/playerPrefs.ts): the
  // zones' menu (left) draws only the zones, the phone's (right) only the phone and an app's interface; both together
  // draw both, and each button names its own choice.
  const menuOf = async (testid) => {
    await page.waitForFunction(() => !document.querySelector('.menu'));
    await page.click(`.transport [data-testid=${testid}]`);
    await page.waitForSelector('.menu [role=menuitemcheckbox]');
    return page.$$eval('.menu [role=menuitemcheckbox], .menu .menu-label', (els) =>
      els.map((e) =>
        e.classList.contains('menu-label') ? `# ${e.textContent?.trim()}` : `${e.getAttribute('aria-checked') === 'true' ? '✓ ' : ''}${e.textContent?.trim()}`,
      ),
    );
  };
  const pickIn = async (testid, label) => {
    const items = await menuOf(testid);
    assert(
      items.some((i) => i.replace('✓ ', '') === label),
      `${label} in the ${testid} menu: ${items}`,
    );
    await page.evaluate(
      (label) => [...document.querySelectorAll('.menu [role=menuitemcheckbox]')].find((e) => e.textContent?.trim() === label)?.click(),
      label,
    );
    await page.waitForFunction(() => !document.querySelector('.menu'));
  };
  // what each button says: its name (aria-label, the tooltip's words) and the word its label shows where the row has room
  const buttons = () =>
    page.evaluate(() => {
      const of = (id) => {
        const b = document.querySelector(`.transport [data-testid=${id}]`);
        return { name: b?.getAttribute('aria-label'), word: b?.querySelector('.tr-stack > span:not(.ghost)')?.textContent?.trim() };
      };
      return { zones: of('safe-zones'), phone: of('device') };
    });
  // what the stage draws: the zones (which preset, where), the app's interface (which app), the phone (which view)
  const drawn = () =>
    page.evaluate(() => {
      const box = (el) => {
        const r = el?.getBoundingClientRect();
        return r && { l: r.left, t: r.top, w: r.width, h: r.height };
      };
      const zones = document.querySelector('.stage .ig-layer');
      return {
        zones: zones?.getAttribute('data-preset') ?? null,
        overApp: !!zones?.closest('.phone-zones'),
        // the zones' words ("icons", "caption"…): on the picture, never over an app's interface (it shows what is there)
        labels: zones ? zones.querySelectorAll('text').length : 0,
        ui: document.querySelector('.stage [data-app-ui]')?.getAttribute('data-app-ui') ?? null,
        view: document.querySelector('.stage .phone')?.getAttribute('data-app') ?? null,
        zonesBox: box(zones),
        picture: box(document.querySelector('.stage .vbox')),
      };
    });
  const same = (a, b) => !!a && !!b && ['l', 't', 'w', 'h'].every((k) => Math.abs(a[k] - b[k]) <= 1);

  await check('prefs kept while the safe zones and the phone were one choice: each person sees what they saw', async () => {
    await page.setViewport({ width: 1440, height: 900 });
    // the phone on with TikTok, its zones never shown: TikTok's interface without the stripes
    await page.evaluate(() => localStorage.setItem('vr.player', JSON.stringify({ phone: true, device: 'pixel', 'preset.vertical': 'tiktok' })));
    await openPlayer(reel.slug);
    await page.waitForSelector('.phone[data-device=pixel][data-art=ready] [data-app-ui=tiktok]');
    let d = await drawn();
    assert(d.ui === 'tiktok' && d.zones === null, `the app without its zones: ${JSON.stringify(d)}`);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('vr.player') || '{}').phoneApp === 'tiktok');
    const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('vr.player') || '{}'));
    assert(kept['preset.vertical'] === 'none' && !('zones' in kept), `written as the two choices: ${JSON.stringify(kept)}`);
    // the same with its zones shown over it: both
    await page.evaluate(() => localStorage.setItem('vr.player', JSON.stringify({ phone: true, 'preset.vertical': 'yt-shorts', zones: true })));
    await openPlayer(reel.slug);
    await page.waitForSelector('.phone[data-art=ready] [data-app-ui=shorts]');
    await page.waitForSelector('.phone-zones .ig-layer[data-preset=yt-shorts]');
    d = await drawn();
    assert(d.ui === 'shorts' && d.zones === 'yt-shorts' && d.overApp && d.labels === 0, `the app and its zones (no words): ${JSON.stringify(d)}`);
    // the phone off: the zones as they were, nothing else
    await page.evaluate(() => localStorage.setItem('vr.player', JSON.stringify({ phone: false, 'preset.vertical': 'stories' })));
    await openPlayer(reel.slug);
    await page.waitForSelector('.stage .ig-layer[data-preset=stories]');
    d = await drawn();
    assert(d.view === null && d.ui === null, `no phone, the zones: ${JSON.stringify(d)}`);
    await page.evaluate(() => localStorage.removeItem('vr.player'));
  });

  await check('safe zones and the phone view: two menus, each drawing one thing — the zones, or an app’s interface — both together, V and G', async () => {
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluate(() => localStorage.removeItem('vr.player'));
    await openPlayer(reel.slug);
    await page.evaluate(() => document.activeElement?.blur());
    // the menus: each headed by what it is, neither with the other's choice in it
    const phoneMenu = await menuOf('device');
    assert(
      phoneMenu.join(' | ') ===
        '# Phone view | ✓ Off | Full height | Instagram Reels | TikTok | YouTube Shorts | Stories (IG / FB) | # Phone | ✓ iPhone 15 / 16 | iPhone 16 Pro | iPhone 16 Pro Max | iPhone SE | Pixel 8',
      `the phone's menu: ${phoneMenu.join(' | ')}`,
    );
    await page.keyboard.press('Escape');
    const zonesMenu = await menuOf('safe-zones');
    assert(
      zonesMenu.join(' | ') === '# Safe zones | ✓ Off | Rule of thirds | Instagram Reels | TikTok | YouTube Shorts | Stories (IG / FB)',
      `the zones' menu: ${zonesMenu.join(' | ')}`,
    );
    await page.keyboard.press('Escape');
    // Full height: the picture on the whole screen, top to bottom, under the status bar and the home indicator only
    await page.evaluate(() => {
      const v = document.querySelector('.vbox video');
      if (v) v.dataset.kept = '1';
    });
    await pickIn('device', 'Full height');
    await page.waitForSelector('.phone[data-app=full][data-art=ready] .phone-status');
    const full = await page.evaluate(() => {
      const r = (s) => {
        const b = document.querySelector(s)?.getBoundingClientRect();
        return b && { top: b.top, bottom: b.bottom, height: b.height };
      };
      const [screen, area, vbox] = [r('.phone-screen'), r('.phone-area'), r('.phone-area .vbox')];
      return { screen, area, vbox, ui: !!document.querySelector('[data-app-ui]'), kept: document.querySelector('.vbox video')?.dataset.kept };
    });
    assert(!full.ui, 'Full height has no app around the picture');
    assert(
      Math.abs(full.area.top - full.screen.top) < 1 && Math.abs(full.area.height - full.screen.height) < 1,
      `the picture's area is the screen: ${JSON.stringify(full)}`,
    );
    assert(full.vbox.top <= full.screen.top + 1 && full.vbox.bottom >= full.screen.bottom - 1, `the picture fills it top to bottom: ${JSON.stringify(full)}`);
    assert(full.kept === '1', 'turning the phone view on keeps the same video element');
    // an app on the right: its interface, no stripes; the left still says off
    await pickIn('device', 'Instagram Reels');
    await page.waitForSelector('.phone[data-app=reels] [data-app-ui=reels]');
    let d = await drawn();
    assert(d.ui === 'reels' && d.zones === null, `the phone's app draws its interface and no zones: ${JSON.stringify(d)}`);
    let b = await buttons();
    assert(
      b.phone.name === 'Phone view: Instagram Reels · iPhone 15 / 16' &&
        b.phone.word === 'Instagram Reels' &&
        b.zones.name === 'Safe zones: off' &&
        b.zones.word === 'Safe zones: off',
      `each button names its own choice: ${JSON.stringify(b)}`,
    );
    // zones on the left, the phone off: the stripes on the picture, no interface
    await pickIn('device', 'Off');
    await page.waitForFunction(() => !document.querySelector('.pane .phone'));
    await pickIn('safe-zones', 'TikTok');
    await page.waitForSelector('.stage .ig-layer[data-preset=tiktok] [data-zone]');
    d = await drawn();
    assert(d.zones === 'tiktok' && d.ui === null && d.view === null, `the zones draw only the zones: ${JSON.stringify(d)}`);
    assert(d.labels >= 3, `the zones alone say what each is: ${JSON.stringify(d)}`);
    b = await buttons();
    assert(
      b.zones.name === 'Safe zones: TikTok' && b.zones.word === 'TikTok' && b.phone.name === 'Phone view' && b.phone.word === 'Phone',
      `each button names its own choice: ${JSON.stringify(b)}`,
    );
    // V: the phone back with its app, and the zones over it — both, each where it belongs
    await page.keyboard.press('v');
    await page.waitForSelector('.phone[data-app=reels] [data-app-ui=reels]');
    await page.waitForSelector('.phone-zones .ig-layer[data-preset=tiktok]');
    d = await drawn();
    assert(d.ui === 'reels' && d.zones === 'tiktok' && d.overApp, `both: ${JSON.stringify(d)}`);
    assert(d.labels === 0, `over the app's interface the zones are stripes only, no words on its buttons: ${JSON.stringify(d)}`);
    assert(same(d.zonesBox, d.picture), `the zones lie on the picture as the phone shows it: ${JSON.stringify(d)}`);
    b = await buttons();
    assert(b.zones.name === 'Safe zones: TikTok' && b.phone.name === 'Phone view: Instagram Reels · iPhone 15 / 16', `both named: ${JSON.stringify(b)}`);
    await shot('phone-reels-tiktok-zones');
    // each app with its own zones over it: its rail and caption — or Stories' header — inside them
    const inside = () =>
      page.evaluate(() => {
        const zones = [...document.querySelectorAll('.phone-zones [data-zone]')].map((z) => z.getBoundingClientRect());
        const pts = (r) => [
          [r.left + 1, r.top + 1],
          [r.right - 1, r.top + 1],
          [r.left + 1, r.bottom - 1],
          [r.right - 1, r.bottom - 1],
          [(r.left + r.right) / 2, (r.top + r.bottom) / 2],
        ];
        const hit = ([x, y]) => zones.some((z) => x >= z.left - 1.5 && x <= z.right + 1.5 && y >= z.top - 1.5 && y <= z.bottom + 1.5);
        const parts = '.pu-rail-item > *, .pu-row > *, .pu-top > *, .pu-story-head > *, .pu-progress';
        const out = [];
        let n = 0;
        for (const el of document.querySelectorAll(`.phone-ui :is(${parts})`)) {
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) continue;
          n++;
          if (!pts(r).every(hit))
            out.push(`${el.className?.baseVal ?? el.className} ${el.textContent?.trim().slice(0, 20)} @${Math.round(r.left)},${Math.round(r.top)}`);
        }
        return { zones: zones.length, n, out };
      });
    for (const [label, app, preset] of [
      ['Instagram Reels', 'reels', 'ig-reels'],
      ['TikTok', 'tiktok', 'tiktok'],
      ['YouTube Shorts', 'shorts', 'yt-shorts'],
      ['Stories (IG / FB)', 'stories', 'stories'],
    ]) {
      await pickIn('device', label);
      await pickIn('safe-zones', label);
      await page.waitForSelector(`.phone[data-app=${app}] [data-app-ui=${app}]`);
      await page.waitForSelector(`.phone-zones .ig-layer[data-preset=${preset}] [data-zone]`);
      const r = await inside();
      assert(r.zones >= 2 && r.n >= (app === 'stories' ? 4 : 12), `${app}: zones and parts measured ${JSON.stringify(r)}`);
      assert(!r.out.length, `${app}: outside its preset's zones: ${r.out.join('; ')}`);
      await shot(`phone-${app}`);
    }
    // Full height with zones: on the picture, which fills the screen (its sides cropped, as the phone shows it)
    await pickIn('device', 'Full height');
    await page.waitForSelector('.phone[data-app=full] .phone-area .canvas .ig-layer[data-preset=stories]');
    d = await drawn();
    assert(
      d.ui === null && d.zones === 'stories' && !d.overApp && same(d.zonesBox, d.picture) && d.labels >= 2,
      `full height, the zones on the picture, with their words: ${JSON.stringify(d)}`,
    );
    await pickIn('device', 'Stories (IG / FB)');
    await page.waitForSelector('.phone[data-app=stories] [data-app-ui=stories]');
    // V: off and back to the last choice, the same video element, nothing in the row moving (at 1024 the words fold to
    // icons; at 1920 both buttons keep the room of their longest word); G at 1920 moves nothing either
    const row = () => page.$$eval('.transport button', (bs) => bs.map((b) => Math.round(b.getBoundingClientRect().left * 2) / 2).join(','));
    for (const width of [1024, 1920]) {
      await page.setViewport({ width, height: 900 });
      await page.waitForFunction((w) => innerWidth === w, {}, width);
      await page.evaluate(() => document.activeElement?.blur());
      const before = await row();
      await page.keyboard.press('v');
      await page.waitForFunction(() => !document.querySelector('.pane .phone') && !!document.querySelector('.vbox video'));
      const off = await row();
      await page.keyboard.press('v');
      await page.waitForSelector('.phone[data-app=stories] [data-app-ui=stories]');
      const on = await row();
      assert(before === off && off === on, `@${width}: the row stays put: ${before} / ${off} / ${on}`);
      assert((await page.$eval('.vbox video', (v) => v.dataset.kept)) === '1', `@${width}: V keeps the same video element`);
    }
    // G cycles the zones alone: after Stories comes Off, the phone keeps its app; then the rule of thirds over it, on the
    // picture's own box (the row at 1920 not moving)
    const before = await row();
    await page.keyboard.press('g');
    await page.waitForFunction(() => !document.querySelector('.stage .ig-layer'));
    d = await drawn();
    assert(d.ui === 'stories' && d.view === 'stories', `G: the zones off, the app stays: ${JSON.stringify(d)}`);
    await page.keyboard.press('g');
    await page.waitForSelector('.phone-zones .ig-layer[data-preset=thirds]');
    d = await drawn();
    assert(d.ui === 'stories' && same(d.zonesBox, d.picture), `G: the rule of thirds over the app, on the picture: ${JSON.stringify(d)}`);
    assert((await row()) === before, 'G never moves the row');
    b = await buttons();
    assert(b.zones.word === 'Rule of thirds' && b.phone.word === 'Stories (IG / FB)', `the words at 1920: ${JSON.stringify(b)}`);
    await shot('transport-two-choices-1920');
    await page.keyboard.press('v');
    await page.evaluate(() => localStorage.removeItem('vr.player'));
    await page.setViewport({ width: 1440, height: 900 });
  });

  await check('the phone view on a phone: More has the same two choices, in the same words (Safe zones, Phone view, the phone)', async () => {
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    // back to the desktop and no phone view whatever happens: the layout check after this one starts from there (left
    // on the phone, it opened compare at 390 and failed on that instead, as on CI)
    try {
      await page.evaluate(() => localStorage.removeItem('vr.player'));
      await page.goto('about:blank');
      await page.goto(`${BASE}/#/v/${enc(reel.slug)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.ptools [data-testid=ptools-more]');
      await page.waitForFunction(() => document.querySelector('.vbox video')?.readyState >= 2, { timeout: 20000 });
      // a menu still up takes the next press: wait until the last one has gone
      const menuGone = () => page.waitForFunction(() => !document.querySelector('.select-menu'));
      const choose = async (label, option) => {
        await menuGone();
        if (!(await page.$('.ptools-pop'))) await page.click('[data-testid=ptools-more]');
        await page.waitForSelector(`.ptools-pop [aria-label="${label}"]`);
        await page.click(`.ptools-pop [aria-label="${label}"]`);
        await page.waitForSelector('.select-menu .select-item');
        const options = await page.$$eval('.select-menu .select-item', (els) => els.map((e) => e.textContent?.trim()));
        await page.evaluate((o) => [...document.querySelectorAll('.select-menu .select-item')].find((e) => e.textContent?.trim() === o)?.click(), option);
        return options;
      };
      const options = await choose('Phone view', 'TikTok');
      assert(options.join(' | ') === 'Off | Full height | Instagram Reels | TikTok | YouTube Shorts | Stories (IG / FB)', `the phone's Phone view: ${options}`);
      await page.waitForSelector('.phone[data-app=tiktok] [data-app-ui=tiktok]');
      assert((await drawn()).zones === null, 'the app, no zones');
      const phones = await choose('Phone', 'Pixel 8');
      assert(phones.length === 5, `the phones: ${phones}`);
      await page.waitForSelector('.phone[data-device=pixel][data-app=tiktok]');
      const zones = await choose('Safe zones', 'TikTok');
      assert(zones.join(' | ') === 'Off | Rule of thirds | Instagram Reels | TikTok | YouTube Shorts | Stories (IG / FB)', `the phone's Safe zones: ${zones}`);
      await page.waitForSelector('.phone-zones .ig-layer[data-preset=tiktok] [data-zone]');
      assert((await drawn()).labels === 0, 'over the app, the zones without their words');
      await menuGone();
      // the rows: the two choices and the phone, nothing else of theirs
      const rows = await page.$$eval('.ptools-pop .pt-row > span:first-child', (els) => els.map((e) => e.textContent?.trim()));
      assert(rows.join(' | ') === 'Timeline | Safe zones | Phone view | Phone', `More's rows: ${rows.join(' | ')}`);
      await shot('phone-dock-390');
      await page.keyboard.press('Escape');
    } finally {
      await page.evaluate(() => localStorage.removeItem('vr.player')).catch(() => {});
      await page.setViewport({ width: 1440, height: 900, isMobile: false, hasTouch: false });
    }
  });

  await check('layout: the player fits at phone, tablet and desktop, dark and light, compare open or not, in the phone view', async () => {
    const out = await layoutMatrix(page, {
      player: async () => {
        await page.evaluate(() => localStorage.removeItem('vr.player'));
        await openPlayer();
      },
      compare: async () => {
        await page.keyboard.press('b');
        await page.waitForSelector('[data-testid=compare-bar]');
      },
      // the composer with what a note picks up: a range, tags, the hint
      composer: async () => {
        await openPlayer();
        await page.keyboard.press('c');
        await page.waitForSelector('.composer [data-testid=range-add]');
        await page.click('.composer [data-testid=range-add]');
        await page.type('.composer textarea', 'Logo a touch later #tim');
        await page.keyboard.press('Enter');
        await page.waitForSelector('.composer [data-testid=tag-chip]');
      },
      // a vertical video on a phone, in an app, with its zones over it (prefs as kept before the two choices: upgraded)
      phone: async () => {
        await page.evaluate(() =>
          localStorage.setItem('vr.player', JSON.stringify({ phone: true, device: 'iphone-pro', 'preset.vertical': 'tiktok', zones: true })),
        );
        await openPlayer(reel.slug);
        await page.waitForSelector('.phone[data-art=ready] [data-app-ui=tiktok]');
      },
    });
    await page.evaluate(() => localStorage.removeItem('vr.player'));
    assert(!out.length, out.join('\n'));
  });

  await check('no page errors along the way', async () => {
    assert(!errors.length, errors.join(' | '));
  });
} catch (e) {
  crashed(e, srv);
} finally {
  await finish(LABEL, { browser, servers: [srv] });
}
