#!/usr/bin/env node
// covers: web/src/player/ web/src/styles/player.css web/src/styles/notes.css web/src/styles/dock.css web/src/styles/check.css
// covers: web/src/styles/drawbar.css web/src/styles/autocheck.css server/routes/review.ts server/routes/analysis.ts
// covers: server/routes/previews.ts server/routes/media.ts lib/diff.ts lib/qa.ts lib/previews.ts lib/range.ts
// Browser end-to-end test of the player's review tools: a real server (local mode, temp store, free port) + headless
// Chrome. The version picker; compare (B) side by side, wipe and overlay (difference / onion skin) with the approved
// version preselected, swap, Esc and the remembered mode; notes as rows that open into threads (activity lines,
// replies), editing in place (no resize handle, grows, ⌘↵ saves, Esc cancels); the composer (the text first, one
// toolbar: severity, tags and #, the paperclip, voice; the whole video in the head's menu; ⌘↵ saves, Esc cancels); the
// panel's head and its groups (Needs you, To check, Open), its filter menu and ⋯; an agent question answered on its card; Auto-check — its chip in the notes panel's head, the findings in its
// popover — findings turned into a note or dismissed — a freeze says what, where (its frame's picture, a click plays the
// stretch) and why, and "That's intended" keeps it away in the next version; a fix preview (a still made in the
// project) checked in verify mode against the render and verified on it; review mode (N) stepping through the open
// notes; the marks on a paused frame (what changed since the last version, Auto-check's pick) on a white and a black
// picture; the timeline's hover label and frame preview; nothing bends a coloured edge along a rounded box; the player
// and its composer fit in both themes.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { timecode } from '../../lib/time.ts';
import { age, encodeOnce, FFMPEG, makeFreezeVideo, makeVideo, sleep, until } from '../lib/helpers.ts';
import { bentEdges, layoutMatrix } from './layout.mjs';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { concentric, inventory, offTokens, SCALE } from './lib/designInventory.mjs';
import { closestFrame, shownPicture } from './lib/frames.mjs';
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
  // white.mp4 and black.mp4: a plain picture whose V2 adds a panel, for the changed region's box and label on a light
  // and a dark picture (on the white one by the top right corner: no room above it, none to its right, so the label
  // goes below it and moves left).
  const plain = async (name, panel) => {
    const file = path.join(dir, `Acme/export/${name}.mp4`);
    const encode = (vf) =>
      encodeOnce(file, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${name}:s=320x180:r=25:d=1`, ...vf, '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
    age(encode([]));
    const { video } = await api('/api/library', 'POST', { path: file, folder: 'Acme/Reels' });
    age(encode(['-vf', `drawbox=x=${panel.x}:y=${panel.y}:w=${panel.w}:h=${panel.h}:color=${panel.color}:t=fill`]));
    await api(`/api/review/${enc(video.slug)}/sync`, 'POST', {});
    return video.slug;
  };
  const onWhite = await plain('white', { x: 200, y: 6, w: 110, h: 80, color: '0x2f6bff' });
  const onBlack = await plain('black', { x: 40, y: 80, w: 110, h: 70, color: '0xff8a3d' });
  // long.mp4: V1 of 90 frames, V2 of 300 — a jump from V1 to V2's frame 250 (a link, a frame reference) lands on 250.
  const lfile = makeVideo(path.join(dir, 'Acme/export/long.mp4'), { w: 320, h: 180, fps: 30, dur: 3, pattern: 'testsrc2' });
  age(lfile);
  const long = (await api('/api/library', 'POST', { path: lfile, folder: 'Acme/Reels' })).video;
  makeVideo(lfile, { w: 320, h: 180, fps: 30, dur: 10, pattern: 'testsrc2', freq: 660 });
  age(lfile);
  await api(`/api/review/${enc(long.slug)}/sync`, 'POST', {});
  const longV2 = path.join(dir, 'long-v2.mp4');
  fs.copyFileSync(lfile, longV2);
  // mixed.mp4: V1 at 30 fps (90 frames), V2 at 24 fps (288) — a timecode in a note is on its own version's grid
  const mfile = makeVideo(path.join(dir, 'Acme/export/mixed.mp4'), { w: 320, h: 180, fps: 30, dur: 3, pattern: 'testsrc2' });
  age(mfile);
  const mixed = (await api('/api/library', 'POST', { path: mfile, folder: 'Acme/Reels' })).video;
  const mixedV1 = path.join(dir, 'mixed-v1.mp4');
  fs.copyFileSync(mfile, mixedV1);
  makeVideo(mfile, { w: 320, h: 180, fps: 24, dur: 12, pattern: 'testsrc2', freq: 770 });
  age(mfile);
  await api(`/api/review/${enc(mixed.slug)}/sync`, 'POST', {});
  const mixedV2 = path.join(dir, 'mixed-v2.mp4');
  fs.copyFileSync(mfile, mixedV2);
  const mixedNote = (body) => api(`/api/review/${enc(mixed.slug)}/comments`, 'POST', { severity: 'should', ...body });
  // 00:02:10 on V1 (30 fps) is frame 70 (at 24 fps it would be 58); 00:08:10 on V2 (24 fps) is frame 202 (at 30: 250)
  const early = await mixedNote({ v: 1, frame: 5, text: 'Early: 00:02:10 here' });
  const late = await mixedNote({ v: 2, frame: 5, text: 'Late: 00:08:10 here' });
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

  await check('a jump from V1 to a frame only V2 has (a link, a frame reference) shows that frame, as ffmpeg decodes it', async () => {
    const vs = (await review(long.slug)).versions;
    assert(vs.length === 2 && vs[0].frames === 90 && vs[1].frames === 300, `V1 90 frames, V2 300: ${vs.map((x) => x.frames)}`);
    // the player settled on V2: the timecode, and which of ffmpeg's V2 frames around 250 and around 89 the picture is
    const settled = async () => {
      await until(async () => (await text('[data-testid=version-picker]'))?.startsWith('V2'), 'V2 on screen');
      const shownNow = () =>
        page.evaluate(() => ({
          tc: document.querySelector('.tc .main')?.textContent,
          t: document.querySelector('.vbox video')?.currentTime,
          hash: location.hash,
        }));
      await until(
        async () => (await shownNow()).tc === '00:08:10',
        async () => `the timecode says frame 250: ${JSON.stringify(await shownNow())}`,
      );
      await page.waitForFunction(
        () => {
          const v = document.querySelector('.vbox video');
          return v && v.readyState >= 2 && !v.seeking && Math.abs(v.currentTime - 250.5 / 30) < 1e-3;
        },
        { polling: 100, timeout: 20000 },
      );
      // the picture on screen is ffmpeg's V2 f250 (not f89, where V1's last frame would have held it)
      let seen = '';
      await until(
        async () => {
          const px = await shownPicture(page);
          const near250 = closestFrame(longV2, px, 250, 300);
          const near89 = closestFrame(longV2, px, 89, 300);
          seen = `around 250: ${near250.line}; around 89: ${near89.line}`;
          return near250.k === 250 && near250.e < near89.e;
        },
        () => `V2 f250 on screen (${seen})`,
      );
    };
    const onV1 = async () => {
      await page.goto('about:blank');
      await page.goto(`${BASE}/#/v/${enc(long.slug)}?v=1`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.querySelector('.vbox video')?.readyState >= 2, { timeout: 20000 });
      await until(async () => (await text('[data-testid=version-picker]'))?.startsWith('V1'), 'V1 on screen');
    };
    // ⌘K, the inbox's "Open in player", a notification: the address changes while the player is open
    await onV1();
    await page.evaluate((s) => {
      location.hash = `#/v/${encodeURIComponent(s)}?v=2&f=250`;
    }, long.slug);
    await settled();
    assert((await page.evaluate(() => decodeURIComponent(location.hash))).endsWith('?v=2&f=250'), 'the address still says frame 250');
    // a frame reference's "Open in player", a note's timecode: the event for the video already open
    await onV1();
    await page.evaluate((s) => window.dispatchEvent(new CustomEvent('vr-goto-frame', { detail: { slug: s, v: 2, frame: 250 } })), long.slug);
    await settled();
  });

  await check('a timecode in a note is read at its own version’s frame rate (V1 30 fps, V2 24 fps): the frame ffmpeg decodes', async () => {
    const vs = (await review(mixed.slug)).versions;
    assert(
      vs.length === 2 && vs[0].fps === 30 && vs[1].fps === 24 && vs[1].frames === 288,
      `V1 30 fps, V2 24 fps: ${JSON.stringify(vs.map((x) => [x.fps, x.frames]))}`,
    );
    // the note's card, opened on the other version; its timecode's link and a click on it
    const follow = async (onV, id, v, f, file, frames, wrong) => {
      await page.goto('about:blank');
      await page.goto(`${BASE}/#/v/${enc(mixed.slug)}?v=${onV}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.note, .side-empty');
      await page.waitForFunction(() => document.querySelector('.vbox video')?.readyState >= 2, { timeout: 20000 });
      const card = await openCard(id);
      const link = await card.$('.c-text a.tc-link');
      assert(link, 'the timecode is a link');
      const said = await link.evaluate((a) => ({ frame: Number(a.dataset.frame), href: decodeURIComponent(a.getAttribute('href')) }));
      assert(said.frame === f && said.href.endsWith(`?v=${v}&f=${f}`), `V${v}'s frame ${f}: ${JSON.stringify(said)}`);
      await link.click();
      await until(async () => (await text('[data-testid=version-picker]'))?.startsWith(`V${v}`), `V${v} on screen`);
      let seen = '';
      await until(
        async () => {
          const px = await shownPicture(page);
          const right = closestFrame(file, px, f, frames);
          const off = closestFrame(file, px, wrong, frames);
          seen = `around ${f}: ${right.line}; around ${wrong}: ${off.line}`;
          return right.k === f && right.e < off.e;
        },
        () => `V${v} f${f} on screen (${seen})`,
      );
    };
    // a V1 note's 00:02:10 while V2 (24 fps) is on screen: V1's frame 70, not 58
    await follow(2, early.id, 1, 70, mixedV1, 90, 58);
    // a V2 note's 00:08:10 while V1 (30 fps) is on screen: V2's frame 202, not 250
    await follow(1, late.id, 2, 202, mixedV2, 288, 250);
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
    assert(!(await row.$('.act-line')) && /Fixed in V2/.test(await row.$eval('[data-testid=note-state]', (e) => e.textContent)), 'a row says it is fixed');
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

  // the filter menu's items as they read, and one picked
  const filterMenu = async () => {
    // a menu still closing is in the page for a few ms: the filter opens once it has gone
    await page.waitForFunction(() => !document.querySelector('.menu'), { timeout: 5000 });
    await page.click('[data-testid=notes-filter]');
    await page.waitForSelector('.menu[data-state=open] [role=menuitemcheckbox]');
    return page.$$eval('.menu[data-state=open] [role=menuitemcheckbox]', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  };
  const pickFilter = async (label) => {
    await filterMenu();
    await page.evaluate(
      (l) => [...document.querySelectorAll('.menu[data-state=open] [role=menuitemcheckbox]')].find((e) => e.textContent.trim().startsWith(l))?.click(),
      label,
    );
    await page.waitForFunction(() => !document.querySelector('.menu[data-state=open]'), { timeout: 5000 });
  };

  await check('the head is one calm row; the notes in their groups: Needs you, To check, Open — each row with its state on its end', async () => {
    // the panel's head: Notes and its count (no speech here, so no Transcript tab beside it), then the filter, ⋯,
    // Record (its round dot) and + Note (its word; the key in its tooltip), all on one line
    const head = await page.$eval('.side-title', (e) => {
      const mids = [...e.querySelectorAll('button')].map((b) => b.getBoundingClientRect()).map((r) => r.top + r.height / 2);
      const rec = e.querySelector('[data-testid=record]');
      return {
        title: [...(e.querySelector('[data-testid=panel-notes]')?.childNodes ?? [])]
          .filter((x) => x.nodeType === 3)
          .map((x) => x.textContent)
          .join('')
          .trim(),
        tabs: e.querySelectorAll('[role=tab]').length,
        count: e.querySelector('.np-count')?.textContent.trim(),
        order: [...e.querySelectorAll('[data-testid]')]
          .map((b) => b.dataset.testid)
          .filter((x) => ['notes-filter', 'notes-more', 'record', 'new-note'].includes(x)),
        note: e.querySelector('[data-testid=new-note]')?.textContent.trim(),
        kbd: !!e.querySelector('[data-testid=new-note] kbd'),
        rec: rec?.textContent.trim(),
        round: rec ? getComputedStyle(rec).borderTopLeftRadius : null,
        split: !!e.querySelector('.split, .so-split'),
        spread: Math.max(...mids) - Math.min(...mids),
      };
    });
    assert(head.title === 'Notes' && head.count === '3' && head.tabs === 0, `Notes and its count, alone: ${JSON.stringify(head)}`);
    assert(head.order.join(' ') === 'notes-filter notes-more record new-note', `filter, ⋯, Record, + Note: ${JSON.stringify(head)}`);
    assert(head.note === 'Note' && !head.kbd && head.rec === '' && !head.split && parseFloat(head.round) >= 13 && head.spread < 3, JSON.stringify(head));
    // the groups, in their order; each header goes with its group's first note
    const groups = await page.$$eval('.side-scroll .note-sect', (els) => els.map((e) => [e.dataset.group, e.querySelector('.n')?.textContent]));
    assert(
      JSON.stringify(groups) ===
        JSON.stringify([
          ['needs', '1'],
          ['check', '1'],
          ['open', '1'],
        ]),
      `Needs you, To check, Open: ${JSON.stringify(groups)}`,
    );
    const order = await page.$$eval('.side-scroll .note', (els) => els.map((e) => e.dataset.note));
    assert(JSON.stringify(order) === JSON.stringify([question.id, fixed.id, open.id]), `the question, the fix, the open note: ${JSON.stringify(order)}`);
    // each row's state, a small label on its end: the fix's green is its mark alone, never its words or its surface
    const states = await page.$$eval('.side-scroll [data-testid=note-state]', (els) =>
      els.map((e) => {
        const probe = document.createElement('i');
        probe.style.color = 'var(--ok)';
        document.body.append(probe);
        const ok = getComputedStyle(probe).color;
        probe.remove();
        const s = getComputedStyle(e);
        return {
          note: e.closest('.note')?.dataset.note,
          words: e.textContent.trim(),
          tone: e.dataset.tone,
          green: [getComputedStyle(e.querySelector('.sb-label')).color, s.backgroundColor, s.boxShadow].some((c) =>
            c.replace(/\s/g, '').includes(ok.replace(/\s/g, '').slice(4, -1)),
          ),
          mark: getComputedStyle(e.querySelector('.kg')).color === ok,
        };
      }),
    );
    const q = states.find((x) => x.note === question.id);
    const f = states.find((x) => x.note === fixed.id);
    assert(q?.words === 'Question' && f?.words === 'Fixed in V2', `the rows say where they stand: ${JSON.stringify(states)}`);
    assert(f.mark && !f.green, `Fixed in V2: a green mark, no green words or surface: ${JSON.stringify(f)}`);
    // one person wrote them (the agent's question aside): no author on the rows
    assert(!(await page.$('.side-scroll .nr > .avatar')), 'no author on the rows');
    // the To check header is the panel's door to check mode: quiet while + Note is the view's raised one
    const doors = await page.evaluate(() => ({
      check: document.querySelector('[data-testid=group-check] [data-testid=check-group]')?.className ?? null,
      kbd: document.querySelector('[data-testid=check-group] kbd')?.textContent ?? null,
      note: document.querySelector('[data-testid=new-note]')?.className ?? null,
    }));
    assert(
      /\bghost\b/.test(doors.check ?? '') && doors.kbd === '⇧V' && /\bprimary\b/.test(doors.note ?? ''),
      `Check ⇧V quiet, + Note raised: ${JSON.stringify(doors)}`,
    );
  });

  await check('⋯ holds review mode (N), and the Agent view where an agent works on the video (not here)', async () => {
    await page.click('[data-testid=notes-more]');
    await page.waitForSelector('.menu[data-state=open] [role^=menuitem]');
    const items = await page.$$eval('.menu[data-state=open] [role^=menuitem]', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    assert(items.length === 1 && /^Go through the open notes ?N$/.test(items[0]), `⋯: ${JSON.stringify(items)}`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.menu'), { timeout: 5000 });
  });

  await check(
    'the filter menu: Questions (only while there are some), Mine, Closed, All; a list picked is a chip; a question is answered on its card',
    async () => {
      const items = await filterMenu();
      assert(items.slice(0, 4).join('|') === 'Questions · 1|Mine · 2|Closed · 0|All · 3', `the lists: ${items.join('|')}`);
      await page.keyboard.press('Escape');
      await pickFilter('Questions');
      await until(async () => (await page.$$('.note')).length === 1, 'one question');
      await page.waitForSelector('[data-testid=notes-filters-on] .np-chip[data-filter=questions]');
      assert(
        (await (await cardOf(question.id)).$eval('[data-testid=note-state]', (e) => e.textContent.trim())) === 'Question',
        'its row says it is a question',
      );
      const q = await openCard(question.id);
      assert(/Question/.test(await q.$eval('.note-meta', (e) => e.textContent)), 'labelled a question');
      await q.$eval('.note-answer textarea', (e) => e.focus());
      await page.keyboard.type('Yes, keep it');
      await ctrlEnter();
      await until(async () => (await note(question.id)).status === 'verified', 'answered');
      // no questions left: the list and its chip go, and the menu no longer offers it
      await until(async () => !(await page.$('[data-testid=notes-filters-on]')), 'the chip goes');
      assert(!(await filterMenu()).some((x) => x.startsWith('Questions')), 'no Questions in the menu');
      await page.keyboard.press('Escape');
    },
  );

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
        // a phone: the chip on the line under the head, its findings come up as a sheet
        await page.waitForSelector('.np-chips [data-testid=ac-chip]', { timeout: 90000 });
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
      // a phone: the chip on the line under the head, the words in the sheet, inside the screen
      await page.setViewport({ width: 390, height: 800, isMobile: true, hasTouch: true });
      await openPlayer(reel.slug);
      for (let i = 0; i < 3 && !(await page.$('.nsheet-half, .nsheet-full')); i++) {
        await page.click('.nsheet-handle');
        await sleep(400);
      }
      await page.waitForSelector('.np-chips [data-testid=ac-chip][data-state=failed]');
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

  // The marks on a paused frame lie on the picture, which may be white or black: a label is a dark chip that holds its
  // words (never an outline round the letters) above or below its box, a box a light (or yellow) line over a dark one.
  const stageMark = (mark, words) =>
    page.evaluate(
      (mark, words) => {
        const svg = document.querySelector('.vbox svg.layer');
        const text = [...(svg?.querySelectorAll('text') ?? [])].find((e) => e.textContent === words);
        if (!text) return null;
        const paint = (c) => {
          const [r, g, b, a = 1] = (c.match(/[\d.]+/g) || []).map(Number);
          return { c, l: (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255, a };
        };
        const at = (e) => ((b) => ({ left: b.left, top: b.top, right: b.right, bottom: b.bottom }))(e.getBoundingClientRect());
        const chip = text.closest('[data-mark-label]')?.querySelector('rect');
        // the box's lines: its group's (a mark drawn loose on the picture is this one's when nothing else is)
        const lines = [...svg.querySelectorAll('rect')].filter(
          (e) => !e.closest('[data-mark-label]') && (e.closest('[data-mark]')?.dataset.mark ?? mark) === mark,
        );
        return {
          frame: at(svg),
          text: at(text),
          fill: paint(getComputedStyle(text).fill),
          outline: getComputedStyle(text).stroke,
          chip: chip ? { ...at(chip), fill: paint(getComputedStyle(chip).fill) } : null,
          lines: lines.map((e) => paint(getComputedStyle(e).stroke)),
          box: lines[0] ? at(lines[0]) : null,
        };
      },
      mark,
      words,
    );
  const readsOnAnyPicture = (m, what) => {
    assert(m, `${what}: the label is drawn`);
    assert(m.chip, `${what}: the label sits on a chip`);
    assert(m.chip.fill.l < 0.15 && m.chip.fill.a >= 0.8, `${what}: the chip is dark: ${m.chip.fill.c}`);
    const inside = (a, b) => a.left >= b.left - 0.5 && a.top >= b.top - 0.5 && a.right <= b.right + 0.5 && a.bottom <= b.bottom + 0.5;
    assert(inside(m.text, m.chip), `${what}: the chip holds its words: ${JSON.stringify({ text: m.text, chip: m.chip })}`);
    const [left, right] = [m.text.left - m.chip.left, m.chip.right - m.text.right];
    assert(left > 2 && Math.abs(left - right) <= 1, `${what}: as much room left of the words as right: ${left} | ${right}`);
    assert(inside(m.chip, m.frame), `${what}: the chip stays inside the frame: ${JSON.stringify({ chip: m.chip, frame: m.frame })}`);
    assert(m.outline === 'none', `${what}: no outline round the letters: ${m.outline}`);
    // above the box or below it, never over what it points at (each of these boxes has room on one side)
    assert(
      m.box && (m.chip.bottom <= m.box.top || m.chip.top >= m.box.bottom),
      `${what}: the chip leaves the box uncovered: ${JSON.stringify({ chip: m.chip, box: m.box })}`,
    );
    assert(
      m.lines.some((s) => s.l < 0.15 && s.a >= 0.5),
      `${what}: the box has a dark line: ${m.lines.map((s) => s.c)}`,
    );
  };
  const openAt = async (s, f) => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${enc(s)}?f=${f}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.note, .side-empty');
    await page.waitForFunction(() => document.querySelector('.vbox video')?.readyState >= 2, { timeout: 20000 });
  };
  const markDrawn = (words) =>
    page.waitForFunction((words) => [...document.querySelectorAll('.vbox svg.layer text')].some((e) => e.textContent === words), { timeout: 20000 }, words);

  await check(
    'what changed since V1 reads on a white and a black picture: its label a dark chip inside the frame, its box a dark and a light line',
    async () => {
      for (const [name, s] of [
        ['white', onWhite],
        ['black', onBlack],
      ]) {
        // the diff is worked out in the background: asked for until it is there, the page then gets it whole
        await until(
          async () => (await api(`/api/diff/${enc(s)}/2`)).ranges?.some((r) => r.kind === 'video' && r.box && !r.whole),
          `${name}: V2's panel is a changed region`,
          120_000,
        );
        await openAt(s, 12);
        await markDrawn('CHANGED SINCE V1');
        await page.evaluate(() => document.fonts.ready);
        const m = await stageMark('changed', 'CHANGED SINCE V1');
        readsOnAnyPicture(m, `on ${name}`);
        assert(m.fill.l > 0.8, `on ${name}: light words: ${m.fill.c}`);
        assert(
          m.lines.some((s) => s.l > 0.8 && s.a > 0.8),
          `on ${name}: the box has a light line: ${m.lines.map((s) => s.c)}`,
        );
        await shot(`changed-${name}`);
      }
    },
  );

  await check(
    'Auto-check’s picked finding reads on a white picture: its label a dark chip with its yellow words, its box a dark and a yellow line',
    async () => {
      const qaUrl = `/api/qa/${enc(onWhite)}/2`;
      const finding = {
        key: 'typo:recieve',
        kind: 'typo',
        severity: 'should',
        tags: [],
        frame: 12,
        text: 'Possible typo',
        box: { x: 12, y: 120, w: 120, h: 40 },
      };
      const result = { qa_version: 1, hash: 'stand-in', at: new Date().toISOString(), duration_ms: 1, samples: 1, text_language: 'en', items: [finding] };
      const answer = (r) =>
        r.method() === 'GET' && r.url().endsWith(qaUrl)
          ? r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(result) })
          : r.continue();
      await page.setRequestInterception(true);
      page.on('request', answer);
      try {
        await openAt(onWhite, 12);
        await openChecks();
        await page.click('.ac-row .ac-thumb');
        await markDrawn('AUTO-CHECK');
        await page.keyboard.press('Escape');
        await page.evaluate(() => document.fonts.ready);
        const m = await stageMark('auto-check', 'AUTO-CHECK');
        readsOnAnyPicture(m, 'Auto-check');
        assert(m.fill.c === 'rgb(255, 192, 67)', `its words in its yellow: ${m.fill.c}`);
        assert(
          m.lines.some((s) => s.c === 'rgb(255, 192, 67)'),
          `the box has a yellow line: ${m.lines.map((s) => s.c)}`,
        );
        await shot('autocheck-white');
      } finally {
        page.off('request', answer);
        await page.setRequestInterception(false);
      }
    },
  );

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
    // checked: it is in Done, folded at the end
    await page.click('[data-testid=group-done]');
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
      // (written on V2, the newest: a fix marked now names V2, or it would ride with the next version)
      await api(`/api/comments/${c.id}`, 'PATCH', { status: 'fixed', note: 'done', by: 'agent:promo-edit', fixed_in_v: 2 });
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

  // ---------------------------------------------------------------- check mode's card and the doors to it
  // A video an agent fixed: two notes, V2, both marked fixed by an agent's client ("claude-code", shown "Claude Code"),
  // one with a long answer, and the agent's work as the server keeps it (done, 2 fixed).
  const LONG_FIX =
    'I lifted the shadows on the opening shot with a soft curve rather than raising exposure, so the night mood stays and the highlights on the bottle do not clip. The bottle now separates from the background from the first frame, and the logo reads clearly at full size and on a phone. I also matched the second shot to the new level, because the jump between them became visible once the first one was brighter. If you still find it too dark, I can lift the midtones a little more, but anything beyond that starts to flatten the image and loses the contrast you asked to keep.';
  const cfile = makeVideo(path.join(dir, 'Acme/export/card.mp4'), { w: 320, h: 180, fps: 25, dur: 3, pattern: 'smptebars' });
  age(cfile);
  const card = (await api('/api/library', 'POST', { path: cfile, folder: 'Acme/Reels' })).video.slug;
  await api(`/api/review/${enc(card)}/session`, 'PUT', { name: 'Claude Code', sessionId: 'mcp-card-agent', agent: 'claude-code' });
  const cnote = async (frame, text, severity) => (await api(`/api/review/${enc(card)}/comments`, 'POST', { v: 1, frame, text, severity })).id;
  const longFix = await cnote(12, 'The first second is far too dark: the product disappears into the background.', 'should');
  const shortFix = await cnote(50, 'The logo comes in before the beat.', 'must');
  makeVideo(cfile, { w: 320, h: 180, fps: 25, dur: 3, pattern: 'testsrc2' });
  age(cfile);
  await api(`/api/review/${enc(card)}/sync`, 'POST', {});
  await until(async () => (await review(card)).versions.length === 2, 'card.mp4 V2');
  await api(`/api/comments/${longFix}`, 'PATCH', { status: 'fixed', note: LONG_FIX, by: 'agent:claude-code', fixed_in_v: 2 });
  await api(`/api/comments/${shortFix}`, 'PATCH', { status: 'fixed', note: 'Moved the logo 6 frames later.', by: 'agent:claude-code', fixed_in_v: 2 });
  const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
  const done = {
    id: 'run_c4ec4c000001',
    slug: card,
    agent: { name: 'Claude Code', kind: 'claude-code', session_id: 'mcp-card-agent' },
    opened_by: { who: 'Sam', how: 'send' },
    delivery: 'listening',
    state: 'done',
    started: ago(700),
    ended: ago(90),
    seen: ago(90),
    worked_s: 600,
    plan: [
      { id: longFix, state: 'fixed', at: ago(120), v: 2 },
      { id: shortFix, state: 'fixed', at: ago(100), v: 2 },
    ],
    now: null,
    result: { v: 2, fixed: 2, asked: 0, wontfix: 0 },
    steps: [],
    clock: { tick: ago(90), began: ago(700) },
  };
  fs.writeFileSync(path.join(dir, 'data', card, 'runs.jsonl'), `${JSON.stringify(done)}\n`);
  /** The raised buttons in view: one per view (a split button's chevron is the same door). */
  const raised = () =>
    page.$$eval('.btn.primary', (bs) =>
      bs
        .filter((b) => !(b.closest('.so-split') && !b.textContent.trim()))
        .filter((b) => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(b).visibility !== 'hidden';
        })
        .map((b) => b.textContent.trim()),
    );

  await check(
    'fixes waiting after an agent’s work: one raised door to checking them — the top bar’s; the To check header’s is quiet, + Note steps down',
    async () => {
      await page.setViewport({ width: 1440, height: 900 });
      await openPlayer(card);
      await page.waitForSelector('[data-testid=run-strip][data-phase=done]', { timeout: 20000 });
      await page.waitForSelector('[data-testid=stage-next][data-kind=verify]', { timeout: 20000 });
      await page.waitForSelector('[data-testid=group-check] [data-testid=check-group]');
      const doors = await page.evaluate(() => ({
        top: document.querySelector('[data-testid=stage-next]')?.className ?? null,
        group: document.querySelector('[data-testid=check-group]')?.className ?? null,
        line: [...document.querySelectorAll('[data-testid=run-strip] button')].map((b) => b.dataset.testid),
        note: document.querySelector('[data-testid=new-note]')?.className ?? null,
      }));
      assert(/\bprimary\b/.test(doors.top ?? '') && /\bghost\b/.test(doors.group ?? '') && !/\bprimary\b/.test(doors.group ?? ''), JSON.stringify(doors));
      assert(
        !doors.line.some((x) => /check/.test(x ?? '')) && !/\bprimary\b/.test(doors.note ?? ''),
        `the agent's line offers no Check, + Note steps down: ${JSON.stringify(doors)}`,
      );
      const up = await raised();
      assert(up.length === 1 && /Check 2 fixes/.test(up[0]), `one raised door: ${JSON.stringify(up)}`);
      await shot('check-doors');
    },
  );

  await check(
    'the keys the panel names: ⇧V opens check mode (the To check header’s Check), Esc leaves it; Esc closes the filter menu and N then goes through the notes',
    async () => {
      await page.setViewport({ width: 1440, height: 900 });
      await openPlayer(card);
      assert((await text('[data-testid=group-check] [data-testid=check-group] kbd')) === '⇧V', 'the header says its key');
      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      await page.keyboard.down('Shift');
      await page.keyboard.press('V');
      await page.keyboard.up('Shift');
      await page.waitForSelector('.verify', { timeout: 5000 });
      assert(!(await page.$('[data-testid=check-group]')), 'in check mode the header offers no Check: the card decides');
      // (an Esc in a field first leaves the field)
      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      await page.keyboard.press('Escape');
      await until(async () => !(await page.$('.verify')), 'Esc leaves check mode', 5000);
      // a menu's Esc is the menu's; the keys are the player's again once it closed
      await openPlayer();
      await page.click('[data-testid=notes-filter]');
      await page.waitForSelector('.menu[data-state=open]');
      await page.keyboard.press('Escape');
      await until(async () => !(await page.$('.menu[data-state=open]')), 'Esc closes the filter menu', 5000);
      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      await page.keyboard.press('n');
      await page.waitForSelector('[data-testid=review-hud]', { timeout: 5000 });
      // (Esc leaving review mode is the review mode check's)
    },
  );

  for (const theme of ['dark', 'light'])
    await check(
      `check mode's card (${theme}): the note first, the agent's answer second and quieter, folded; colour only in marks, tokens only; the pictures uncovered`,
      async () => {
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
        await page.setViewport({ width: 1440, height: 900 });
        await page.goto('about:blank');
        await page.goto(`${BASE}/#/v/${enc(card)}?verify=${longFix}`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-testid=verify-card] [data-testid=verify-fix]', { timeout: 20000 });
        await page.waitForFunction(() => !document.querySelector('.verify')?.getAnimations().length);
        await sleep(300);
        const c = await page.evaluate(() => {
          const q = (s) => document.querySelector(`.verify ${s}`);
          const st = (s) => (q(s) ? getComputedStyle(q(s)) : null);
          const lh = (s) => parseFloat(st(s)?.lineHeight ?? '0');
          const right = q('[data-testid=check-right]');
          const pictures = [...document.querySelectorAll('.stage .vbox')].map((v) => v.getBoundingClientRect().bottom);
          return {
            step: q('[data-testid=verify-step]')?.textContent.trim(),
            dots: [...document.querySelectorAll('.verify-dots i')].map((i) => i.className),
            noteSize: parseFloat(st('.verify-note-text')?.fontSize ?? '0'),
            fixSize: parseFloat(st('.verify-fix-text')?.fontSize ?? '0'),
            noteColor: st('.verify-note-text')?.color,
            fixColor: st('.verify-fix-text')?.color,
            by: q('[data-testid=verify-fix-by]')?.textContent.trim(),
            fixLines: Math.round(q('.verify-fix-text').getBoundingClientRect().height / lh('.verify-fix-text')),
            more: !!q('[data-testid=verify-more]'),
            right: right?.className,
            wrong: q('[data-testid=check-wrong]')?.className,
            skip: q('[data-testid=verify-skip]')?.className,
            rightAt: right ? Math.round(right.getBoundingClientRect().top) : null,
            cardTop: document.querySelector('.verify').getBoundingClientRect().top,
            pictures,
            ok: getComputedStyle(document.querySelector('.verify')).getPropertyValue('--ok').trim(),
          };
        });
        assert(c.step === 'Check 1 of 2' && c.dots.length === 2 && c.dots.filter((d) => d === 'on').length === 1, `where you are: ${JSON.stringify(c)}`);
        assert(c.noteSize > c.fixSize && c.noteColor !== c.fixColor, `the note reads first, the answer quieter: ${JSON.stringify(c)}`);
        assert(c.by === 'Claude Code', `the agent by its shown name: ${c.by}`);
        assert(c.fixLines <= 3 && c.more, `the long answer folds to three lines with More: ${JSON.stringify(c)}`);
        assert(
          /\bprimary\b/.test(c.right) && !/\b(primary|ghost)\b/.test(c.wrong) && /\bghost\b/.test(c.skip),
          `Looks right raised, Still wrong plain, Skip quiet: ${JSON.stringify(c)}`,
        );
        const up = await raised();
        assert(up.length === 1 && /Looks right/.test(up[0]), `in check mode the card's Looks right is the one raised button: ${JSON.stringify(up)}`);
        assert(c.pictures.length === 2 && c.pictures.every((b) => b <= c.cardTop + 1), `the card covers neither picture: ${JSON.stringify(c)}`);
        // colour marks a state only: nothing in the card wears the green as a fill or an edge, only the fix's small ✓
        const green = await page.evaluate(() => {
          const probe = document.createElement('i');
          probe.style.color = 'var(--ok)';
          document.querySelector('.verify').append(probe);
          const ok = getComputedStyle(probe).color;
          probe.remove();
          const same = (c) => c.replace(/\s/g, '').startsWith(ok.replace(/\s/g, '').replace(/\)$/, ''));
          return [...document.querySelectorAll('.verify, .verify *')]
            .filter((e) => {
              const s = getComputedStyle(e);
              return (
                same(s.backgroundColor) ||
                (parseFloat(s.borderTopWidth) > 0 && same(s.borderTopColor)) ||
                (/rgb|color/.test(s.boxShadow) && s.boxShadow.includes(ok))
              );
            })
            .map((e) => e.className?.baseVal ?? e.className);
        });
        assert(!green.length, `no green box or edge: ${JSON.stringify(green)}`);
        // the card from the design system alone: its colours tokens', its sizes and corners on the scales, concentric
        const colours = await page.evaluate(offTokens, { root: '.verify' });
        assert(!colours.length, `colours no token gives: ${JSON.stringify(colours)}`);
        const inv = await page.evaluate(inventory, { scale: SCALE, allow: [], root: '.verify' });
        const offScale = Object.entries(inv).filter(([, v]) => v.length);
        assert(!offScale.length, `off the scales: ${JSON.stringify(offScale)}`);
        const nested = await page.evaluate(concentric, { root: '.verify' });
        assert(!nested.length, `corners that don't follow the curve around them: ${JSON.stringify(nested)}`);
        await shot(`check-card-${theme}`);
        // More unfolds in place: the card grows upwards, the decision stays where it was and in the window
        await page.click('[data-testid=verify-more]');
        await page.waitForFunction(() => document.querySelector('.verify-fix-text')?.classList.contains('open'));
        const open = await page.evaluate(() => {
          const r = document.querySelector('[data-testid=check-right]').getBoundingClientRect();
          return { top: Math.round(r.top), bottom: r.bottom, h: innerHeight, more: document.querySelector('[data-testid=verify-more]')?.textContent };
        });
        assert(
          Math.abs(open.top - c.rightAt) <= 1 && open.bottom <= open.h && open.more === 'Less',
          `the decision stays put and in view: ${JSON.stringify({ open, before: c.rightAt })}`,
        );
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('.verify'), { timeout: 5000 });
      },
    );
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);

  await check(
    'on a phone too one raised door to checking (the row under the bar’s Check); in check mode the card is the notes sheet’s content, its decision within reach',
    async () => {
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await page.goto('about:blank');
      // the phone's row under its bar says "Check" (the stage's next step); the notes' To check header says it quietly
      await page.goto(`${BASE}/#/v/${enc(card)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid=run-strip][data-phase=done]', { timeout: 20000 });
      await page.waitForSelector('[data-testid=stage-next][data-kind=verify]', { timeout: 20000 });
      const door = await page.$eval('[data-testid=check-group]', (b) => b.className);
      assert(!/\bprimary\b/.test(door), `the To check header's Check is quiet beside the bar's Check: ${door}`);
      const up = await raised();
      assert(up.length === 1 && /^Check$/.test(up[0]), `one raised door on a phone: ${JSON.stringify(up)}`);
      await page.goto('about:blank');
      await page.goto(`${BASE}/#/v/${enc(card)}?verify=${longFix}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.nsheet .verify [data-testid=check-right]', { timeout: 20000 });
      await sleep(600);
      const s = await page.evaluate(() => {
        const sheet = document.querySelector('.nsheet');
        const r = document.querySelector('.nsheet [data-testid=check-right]').getBoundingClientRect();
        return {
          rows: sheet.querySelectorAll('[data-testid=note-row]').length,
          filters: !!sheet.querySelector('.np-chips, .note-sect'),
          right: { top: r.top, bottom: r.bottom, h: innerHeight },
        };
      });
      assert(s.rows === 0 && !s.filters, `only the card in the sheet: ${JSON.stringify(s)}`);
      assert(s.right.top >= 0 && s.right.bottom <= s.right.h, `Looks right in view: ${JSON.stringify(s.right)}`);
      await shot('check-card-phone');
      await page.keyboard.press('Escape');
      await page.setViewport({ width: 1440, height: 900 });
    },
  );

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
