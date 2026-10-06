#!/usr/bin/env node
// covers: web/src/inbox/ web/src/foryou/ web/src/styles/inbox.css web/src/styles/foryou.css server/routes/phone.ts
// covers: lib/foryou.ts web/src/api/events.ts web/src/api/live.ts
// Browser end-to-end test of the inbox: the bell in the top bar, its popover (desktop) and sheet (phone), the preview
// beside the list, and the inbox view of the library (#/inbox: "Inbox" in the sidebar, list + preview on wide screens,
// cards on phones, an empty state); by video (the default) and by kind, and clearing it where it is — Done with Undo,
// Looks right / Still wrong in the row, Later and its coming back, several at once, the keys, inbox zero. The preview must present exactly the frame ffmpeg decodes (also when a fix sits in
// a newer version with another frame rate), the actions must land on the server, and the page underneath must stay as
// it was.
// A real server (local mode, temp store, free port) + headless Chrome. Screenshots land in VR_SHOTS when it is set.
import fs from 'node:fs';
import path from 'node:path';
import { timecode, timeToFrame } from '../../lib/time.ts';
import { age, makeVideo, sleep, until } from '../lib/helpers.ts';
import { clippedText, fitsAt, grainOnScrollers, settle, sideways } from './layout.mjs';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir, signedIn } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { closestFrame, shownPicture } from './lib/frames.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'inbox e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-inbox-e2e-', user: 'Sam' });
const { dir, base: BASE } = srv;

const api = jsonApi(BASE);
const review = async (slug) => api(`/api/review/${encodeURIComponent(slug)}`);
const comment = async (slug, id) => (await review(slug)).review.comments.find((c) => c.id === id);

const IPHONE = {
  viewport: { width: 390, height: 844, deviceScaleFactor: SHOTS ? 3 : 1, isMobile: true, hasTouch: true },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
};

// The preview's picture against ffmpeg's decode of that file: the closest of n − 1, n, n + 1 must be n.
// Parked: the frame asked for is the frame presented, nothing moving.
const parked = (page, frame) =>
  page.waitForFunction(
    (f) => {
      const v = document.querySelector('[data-testid="inbox-video"]');
      return v && v.readyState >= 2 && !v.seeking && v.paused && v.dataset.frame === String(f) && v.dataset.shown === String(f);
    },
    { polling: 100, timeout: 20000 },
    frame,
  );
async function presents(page, file, n, frames) {
  await parked(page, n);
  await sleep(150);
  const best = closestFrame(file, await shownPicture(page, '[data-testid="inbox-video"]'), n, frames);
  assert(best.k === n, `frame ${n}: closest ffmpeg frame is ${best.k} (${best.line})`);
}

// fitsAt's checks (layout.mjs) with the inbox open on a preview, at a phone, a tablet and a desktop size. A viewport
// that turns touch on or off reloads the page in Chrome, so the inbox is opened afresh at each size.
const SIZES = [
  { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { width: 1440, height: 900, deviceScaleFactor: 1 },
];
async function inboxFits(page, base, kind) {
  const own = page.viewport();
  const out = [];
  for (const vp of SIZES) {
    await page.setViewport(vp);
    await page.goto('about:blank');
    await page.goto(`${base}/#/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="inbox-bell"][aria-label^="Inbox, "]', { timeout: 20000 });
    await page.click('[data-testid="inbox-bell"]');
    await page.waitForSelector(`[data-testid="inbox"] [data-testid="inbox-row-${kind}"]`);
    await page.click(`[data-testid="inbox"] [data-testid="inbox-row-${kind}"]`);
    await page.waitForFunction(() => document.querySelector('[data-testid="inbox-video"]')?.readyState >= 2, { timeout: 20000 });
    await sleep(400);
    const bad = [...(vp.isMobile ? await sideways(page) : []), ...(await clippedText(page)), ...(await grainOnScrollers(page))];
    for (const b of bad) out.push(`inbox @${vp.width}: ${b}`);
    await page.keyboard.press('Escape');
  }
  if (own) await page.setViewport(own);
  return out;
}

let browser;
try {
  const add = async (file) => {
    age(file);
    const { video } = await api('/api/library', 'POST', { path: file });
    return video.slug;
  };
  const note = (slug, body) => api(`/api/review/${encodeURIComponent(slug)}/comments`, 'POST', body);
  // spot: one version, 25 fps, a frame counter in every frame (testsrc)
  const spotFile = makeVideo(path.join(dir, 'Acme/export/spot.mp4'), { w: 320, h: 180, fps: 25, dur: 3 });
  const spot = await add(spotFile);
  // film: notes on v1 (25 fps bars), fixed in v2 (30 fps testsrc2) — a fix's frame is found in v2 by time
  const filmFile = path.join(dir, 'Globex/out/film.mp4');
  makeVideo(filmFile, { w: 320, h: 180, fps: 25, dur: 3, pattern: 'smptebars' });
  const film = await add(filmFile);
  const fixNote = await note(film, { frame: 40, text: 'Caption sits on her face', severity: 'must', drawing: [{ type: 'box', x: 40, y: 30, w: 120, h: 60 }] });
  const laterFix = await note(film, { frame: 60, text: 'Music too loud under the voice', severity: 'should' });
  makeVideo(filmFile, { w: 320, h: 180, fps: 30, dur: 3, pattern: 'testsrc2' });
  age(filmFile);
  const v2 = (await review(film)).review.versions.at(-1);
  assert(v2.v === 2 && v2.fps === 30, `film v2 at 30 fps: ${JSON.stringify(v2 && { v: v2.v, fps: v2.fps })}`);
  for (const c of [fixNote, laterFix])
    await api(`/api/comments/${c.id}`, 'PATCH', { status: 'fixed', note: `Fixed: ${c.text}`, by: 'agent:brand-film', fixed_in_v: 2 });
  const question = await note(spot, {
    frame: 45,
    text: 'Logo before or after the claim?',
    by: 'agent:promo-edit',
    drawing: [{ type: 'box', x: 180, y: 20, w: 110, h: 70 }],
  });
  const FIX_FRAME = timeToFrame(40 / 25, 30);

  browser = await launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  const watch = (page) => {
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));
    return page;
  };
  const shotOf = (page) => async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  console.log(`inbox e2e against ${BASE} (store ${dir})`);

  const page = watch(await browser.newPage());
  await page.setViewport({ width: 1440, height: 900 });
  const shot = shotOf(page);
  const row = (kind) => `[data-testid="inbox"] [data-testid="inbox-row-${kind}"]`;

  await check('the bell in the library says how much waits, and opens the inbox over the page', async () => {
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    // Up to the clean-up checks the inbox reads by kind (the groups of before); by video, the default, has its own below.
    await page.evaluate(() => localStorage.setItem('vr.inbox', JSON.stringify({ mode: 'kind' })));
    // The library itself, not its skeleton (signedIn): a slow runner typed into the skeleton and marked it, then found the
    // mark gone when the real page replaced it. Real cards don't tell them apart: with an earlier visit's hint the skeleton
    // shows the cards fetched alongside.
    await signedIn(page);
    await page.waitForSelector('.lib-filter input', { timeout: 20000 });
    await page.type('.lib-filter input', 'o');
    // The library's own state, to find it again after the inbox: a typed filter and this very DOM.
    await page.evaluate(() => {
      document.querySelector('.page').dataset.inboxMark = 'still here';
    });
    const n = (await api('/api/for-you')).counts.total;
    assert(n >= 3, `question, two fixes and more are waiting (${n})`);
    await page.waitForSelector(`[data-testid="inbox-bell"][aria-label="Inbox, ${n} waiting"]`, { timeout: 20000 });
    await page.click('[data-testid="inbox-bell"]');
    await page.waitForSelector(row('question'));
    assert((await page.$$(row('verify'))).length === 2, 'two fixes to check');
    const role = await page.$eval('[data-testid="inbox"]', (e) => [e.getAttribute('role'), e.getAttribute('aria-label')].join(' '));
    assert(role === 'dialog Inbox', `the popover is a labelled dialog: ${role}`);
  });

  await check('↑/↓ and j/k walk the list, Enter opens the preview; Tab stays inside', async () => {
    await until(() => page.evaluate(() => document.activeElement?.dataset.testid === 'inbox-list'), 'the list has focus');
    const active = () => page.$eval('[data-testid="inbox-list"]', (l) => document.getElementById(l.getAttribute('aria-activedescendant'))?.dataset.testid);
    assert((await active()) === 'inbox-row-question', `first row active: ${await active()}`);
    await page.keyboard.press('j');
    assert((await active()) === 'inbox-row-verify', `j moves down: ${await active()}`);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('k');
    assert((await active()) === 'inbox-row-question', `back up: ${await active()}`);
    for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
    assert(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="inbox"]')), 'focus is trapped in the inbox');
    await page.focus('[data-testid="inbox-list"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="inbox-video"]');
  });

  await check('the preview presents the question’s exact frame (ffmpeg), steps ±1 and plays around it', async () => {
    await presents(page, spotFile, 45, 75);
    const tc = await page.$eval('[data-testid="inbox-tc"]', (e) => e.textContent);
    assert(tc.includes('F0045') && tc.includes('V1'), `timecode ${tc}`);
    assert(await page.$('.inbox-panel.split.with-preview'), 'list and preview side by side on a wide screen');
    // the note's marks over its own frame, and a toggle for them
    assert(await page.$('.inbox-marks rect, .inbox-marks path'), 'marks drawn');
    await page.click('.inbox-transport [aria-pressed="true"]');
    assert(!(await page.$('.inbox-marks')), 'marks hidden');
    await page.click('.inbox-transport [aria-pressed="false"]');
    await page.waitForSelector('.inbox-marks');
    await page.click('[aria-label="Next frame"]');
    await presents(page, spotFile, 46, 75);
    await page.click('[aria-label="Previous frame"]');
    await page.click('[aria-label="Previous frame"]');
    await presents(page, spotFile, 44, 75);
    await page.click('[aria-label="Next frame"]');
    await parked(page, 45);
    await page.$$eval('.inbox-transport button', (bs) => bs.find((b) => b.textContent.includes('Play around it'))?.click());
    await page.waitForFunction(() => !document.querySelector('[data-testid="inbox-video"]').paused, { timeout: 5000 });
    // 1.5 s before to 1.5 s after, once, then back on the frame
    await presents(page, spotFile, 45, 75);
    await sleep(300);
    await shot('01-inbox-desktop-preview');
  });

  await check(
    'the small player: the render’s shape, its moment on the timeline; play/pause, scrubbing and keys land on exact frames; typing moves nothing',
    async () => {
      const pv = '[data-testid="inbox"]';
      const rect = (sel) => page.$eval(`${pv} ${sel}`, (e) => e.getBoundingClientRect().toJSON());
      const frameNow = () => page.$eval('[data-testid="inbox-video"]', (v) => ({ f: Number(v.dataset.frame), paused: v.paused }));
      // the stage is the picture (16:9 here), no bars around it
      const stage = await rect('.inbox-stage');
      assert(Math.abs(stage.width / stage.height - 320 / 180) < 0.03, `the stage has the render's shape: ${stage.width}×${stage.height}`);
      // the question's moment sits on the timeline where its frame is
      const scrub = await rect('[data-testid="inbox-scrub"]');
      const mark = await rect('[data-testid="inbox-scrub-mark"]');
      const markAt = (mark.x + mark.width / 2 - scrub.x) / scrub.width;
      assert(Math.abs(markAt - 45 / 74) < 0.02, `the moment on the timeline at ${markAt.toFixed(3)}`);
      // play, then pause: it rests on the frame it stopped on — ffmpeg's frame
      await page.click(`${pv} [data-testid="inbox-play"]`);
      await page.waitForFunction(() => !document.querySelector('[data-testid="inbox-video"]').paused, { timeout: 5000 });
      await sleep(500);
      await page.click(`${pv} [data-testid="inbox-play"]`);
      await page.waitForFunction(() => document.querySelector('[data-testid="inbox-video"]').paused, { timeout: 5000 });
      const stopped = (await frameNow()).f;
      assert(stopped > 45, `it played on from 45: ${stopped}`);
      await presents(page, spotFile, stopped, 75);
      // a click on the timeline, then a drag: the frame let go of is the one on screen
      const y = scrub.y + scrub.height / 2;
      const xOf = (f) => scrub.x + (f / 74) * scrub.width;
      await page.mouse.click(xOf(20), y);
      await presents(page, spotFile, 20, 75);
      await page.mouse.move(xOf(10), y);
      await page.mouse.down();
      await page.mouse.move(xOf(30), y, { steps: 8 });
      await page.mouse.up();
      await presents(page, spotFile, 30, 75);
      // the frame under the pointer, with its timecode
      await page.mouse.move(xOf(50), y);
      await page.waitForSelector(`${pv} .inbox-scrub-tip`);
      const tip = await page.$eval(`${pv} .inbox-scrub-tip .mono`, (e) => e.textContent);
      assert(tip === timecode(50, 25), `hover names frame 50: ${tip}`);
      // keys, with the list focused: ←/→ a frame, ⇧ a second, Space plays and pauses
      await page.focus(`${pv} [data-testid="inbox-list"]`);
      await page.keyboard.press('ArrowRight');
      await presents(page, spotFile, 31, 75);
      await page.keyboard.down('Shift');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.up('Shift');
      await presents(page, spotFile, 6, 75);
      await page.keyboard.press(' ');
      await page.waitForFunction(() => !document.querySelector('[data-testid="inbox-video"]').paused, { timeout: 5000 });
      await page.keyboard.press(' ');
      await page.waitForFunction(() => document.querySelector('[data-testid="inbox-video"]').paused, { timeout: 5000 });
      await presents(page, spotFile, (await frameNow()).f, 75);
      // the timeline is a slider: its own keys step once (the page's ← → don't add a second step)
      await page.focus(`${pv} [data-testid="inbox-scrub"]`);
      await page.keyboard.press('Home');
      await presents(page, spotFile, 0, 75);
      await page.keyboard.press('ArrowRight');
      await presents(page, spotFile, 1, 75);
      // typing an answer: no key reaches the player, and O types an o
      await page.click(`${pv} .inbox-act textarea`);
      await page.keyboard.type('o ok');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowRight');
      const typed = await page.$eval(`${pv} .inbox-act textarea`, (e) => e.value);
      assert(typed === 'o ok', `the answer box got the keys: ${JSON.stringify(typed)}`);
      const still = await frameNow();
      assert(still.paused && still.f === 1, `the player didn't move: ${JSON.stringify(still)}`);
      assert((await page.evaluate(() => location.hash)) === '#/', 'O in the answer box opened nothing');
      for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');
      // sound: on by default, muted with one click (and remembered)
      assert(!(await page.$eval('[data-testid="inbox-video"]', (v) => v.muted)), 'sound on');
      await page.click(`${pv} [data-testid="inbox-mute"]`);
      assert(await page.$eval('[data-testid="inbox-video"]', (v) => v.muted), 'muted');
      await page.click(`${pv} [data-testid="inbox-mute"]`);
      await page.evaluate(() => localStorage.removeItem('vr.inbox.muted'));
    },
  );

  await check('answering from the preview sends it, takes the item off the list and moves on to the next', async () => {
    await page.type('[data-testid="inbox"] .inbox-act textarea', 'After the claim, please');
    await page.click('[data-testid="inbox"] .inbox-act button[type="submit"]');
    await page.waitForSelector(row('question'), { hidden: true });
    const c = await comment(spot, question.id);
    assert(c.status === 'verified', `status ${c.status}`);
    assert(c.replies.at(-1).text === 'After the claim, please' && c.replies.at(-1).by === 'Sam', JSON.stringify(c.replies.at(-1)));
    // the next item (a fix) is in the preview now
    await page.waitForSelector(`${row('verify')}.picked`);
  });

  await check('a fix is shown in its new version at the same moment, marks toggle, "Looks right" verifies it', async () => {
    const picked = await page.$eval(`${row('verify')}.picked .inbox-row-text`, (e) => e.textContent);
    if (picked !== fixNote.text) {
      for (const el of await page.$$(row('verify'))) if ((await el.$eval('.inbox-row-text', (e) => e.textContent)) === fixNote.text) await el.click();
    }
    await presents(page, filmFile, FIX_FRAME, 90);
    const tc = await page.$eval('[data-testid="inbox-tc"]', (e) => e.textContent);
    assert(tc.includes(`F${String(FIX_FRAME).padStart(4, '0')}`) && tc.includes('V2'), `timecode ${tc}`);
    // v1's marks aren't drawn over v2's picture (they're in v1's pixels)
    assert(!(await page.$('.inbox-marks')), 'no v1 marks over v2');
    const text = await page.$eval('.inbox-pv-body', (e) => e.textContent);
    assert(text.includes('Fixed: Caption sits on her face'), `the agent's change is there: ${text}`);
    await page.$$eval('.inbox-act-row button', (bs) => bs.find((b) => b.textContent.includes('Looks right'))?.click());
    await until(async () => (await comment(film, fixNote.id)).status === 'verified', 'fix verified');
    await until(async () => (await page.$$(row('verify'))).length === 1, 'one fix left');
  });

  await check('"Still wrong" keeps a fix open with what is wrong', async () => {
    await page.waitForSelector(`${row('verify')}.picked`);
    await page.$$eval('.inbox-act-row button', (bs) => bs.find((b) => b.textContent.includes('Still wrong'))?.click());
    await page.type('.inbox-act textarea', 'Still too loud at the end');
    await page.$$eval('.inbox-act-row button', (bs) => bs.find((b) => b.textContent.includes('Keep it open'))?.click());
    await until(async () => (await comment(film, laterFix.id)).status === 'open', 'fix reopened');
    const c = await comment(film, laterFix.id);
    assert(c.replies.at(-1).text === 'Still too loud at the end', JSON.stringify(c.replies.at(-1)));
    await page.waitForSelector(row('verify'), { hidden: true });
  });

  await check('a new render is approved from the preview (status workflow)', async () => {
    await page.click(row('review'));
    await page.waitForSelector('[data-testid="inbox-video"]');
    const slug = await page.$eval('[data-testid="inbox-open-player"]', (a) => decodeURIComponent(a.getAttribute('href').split('/v/')[1].split('?')[0]));
    await page.$$eval('.inbox-act-row button', (bs) => bs.find((b) => b.textContent.includes('Approve V'))?.click());
    await until(async () => (await review(slug)).approvals.some((a) => a.status === 'approved'), 'approved');
  });

  await check('closing returns focus to the bell, and the library underneath is as it was', async () => {
    await shot('02-inbox-desktop-list');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="inbox"]', { hidden: true });
    await until(() => page.evaluate(() => document.activeElement?.dataset.testid === 'inbox-bell'), 'focus back on the bell', 3000);
    const state = await page.evaluate(() => ({
      hash: location.hash,
      mark: document.querySelector('.page')?.dataset.inboxMark,
      q: document.querySelector('.lib-filter input')?.value,
    }));
    assert(state.hash === '#/' && state.mark === 'still here' && state.q === 'o', `library state ${JSON.stringify(state)}`);
  });

  let fitQuestion = null;
  await check('a resized window keeps the inbox and its preview, from two panes to one to the sheet', async () => {
    fitQuestion = (await note(spot, { frame: 20, text: 'Which end card?', by: 'agent:promo-edit' })).id;
    await until(async () => page.$eval('[data-testid="inbox-bell"]', (b) => b.getAttribute('aria-label') !== 'Inbox'), 'the bell counts it');
    await page.click('[data-testid="inbox-bell"]');
    // The bell may have counted other items already: the question is there once the inbox heard of it.
    await (await page.waitForSelector(row('question'), { timeout: 5000 })).click();
    await parked(page, 20);
    await page.setViewport({ width: 1000, height: 800 });
    await page.waitForSelector('.inbox-pop .inbox-panel.stack [data-testid="inbox-video"]');
    assert(!(await page.$('[data-testid="inbox-list"]')), 'one pane: the preview alone');
    // below the phone breakpoint the bar mounts another bell: the inbox moves into the sheet as it was
    await page.setViewport({ width: 600, height: 800 });
    await page.waitForSelector('.inbox-sheet [data-testid="inbox-video"]');
    await parked(page, 20);
    await page.keyboard.press('Escape');
    await page.setViewport({ width: 1440, height: 900 });
  });

  await check('the popover with its preview fits a phone, a tablet and a desktop', async () => {
    const bad = await inboxFits(page, BASE, 'question');
    assert(!bad.length, bad.join('\n'));
    await api(`/api/comments/${fitQuestion}`, 'PATCH', { status: 'verified', note: 'The short one' });
  });

  // ---------------------------------------------------------------- the inbox view (#/inbox)
  const VIEW_READY = '[data-testid="inbox-view"] :is(.inbox-row:not(.pending), .fy-item:not(.pending), .empty-state)';
  const view = (sel = '') => `[data-testid="inbox-view"] ${sel}`;
  const pickedRow = () => page.$eval(view('.inbox-row.picked'), (r) => ({ kind: r.dataset.testid, index: r.dataset.index, text: r.textContent }));
  const viewQuestion = await note(spot, { frame: 33, text: 'Cut on the beat here?', by: 'agent:promo-edit' });
  const viewFix = await note(film, { frame: 20, text: 'Title a touch lower', severity: 'should' });
  await api(`/api/comments/${viewFix.id}`, 'PATCH', { status: 'fixed', note: 'Lowered the title', by: 'agent:brand-film', fixed_in_v: 2 });
  // an agent's answer to one of your notes: a row with "Got it"
  const viewAsked = await note(spot, { frame: 60, text: 'Is the end card final?' });
  await api(`/api/comments/${viewAsked.id}`, 'PATCH', { note: 'Not yet, the legal line is still missing', by: 'agent:promo-edit' });

  await check('the sidebar’s Inbox item carries the bell’s count and opens the view: the list and the preview side by side', async () => {
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    const n = (await api('/api/for-you')).counts.total;
    await page.waitForSelector(`[data-testid="inbox-bell"][aria-label="Inbox, ${n} waiting"]`, { timeout: 20000 });
    await until(async () => (await page.$eval('[data-testid="nav-inbox"] .nav-count', (e) => e.textContent)) === String(n), `the sidebar counts ${n}`);
    // your turn first: the sidebar's Library section is Inbox · All videos · Insights (no note-based views), and the
    // keys walk it like the other rows
    const items = await page.$$eval('.nav .nav-section:first-child .nav-item', (rows) => rows.map((r) => r.querySelector('.nav-label')?.textContent));
    assert(JSON.stringify(items) === JSON.stringify(['Inbox', 'All videos', 'Insights']), `the sidebar's first section: ${items}`);
    await page.focus('.nav .nav-section:first-child .nav-item');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    const focused = await page.evaluate(() => document.activeElement?.dataset.testid);
    assert(focused === 'nav-inbox', `↓/↑ walk the sidebar back to the inbox: ${focused}`);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => location.hash === '#/inbox', { timeout: 5000 });
    await page.waitForSelector(view('.inbox-row:not(.pending)'), { timeout: 15000 });
    assert(await page.$('[data-testid="inbox-view"].split'), 'list + preview on a wide screen');
    assert((await page.$eval('[data-testid="nav-inbox"]', (e) => e.getAttribute('aria-current'))) === 'page', 'the item is the current place');
    const head = await page.$eval('.hero', (e) => e.textContent);
    assert(/Inbox/.test(head) && /\d+\s*waiting/.test(head) && !/Library/i.test(head), `the header names the view and one quiet total, no crumb: ${head}`);
    // like a mail client: the first item is open, the preview right of the list, no way "back" from it
    const first = await pickedRow();
    assert(
      first.index === '0' && first.kind === 'inbox-row-question' && first.text.includes(viewQuestion.text),
      `the first item is open: ${JSON.stringify(first)}`,
    );
    const [list, preview] = await Promise.all(
      [view('[data-testid="inbox-list"]'), view('[data-testid="inbox-view-preview"]')].map((sel) => page.$eval(sel, (e) => e.getBoundingClientRect().toJSON())),
    );
    assert(list.right <= preview.left && Math.abs(list.top - preview.top) < 40, `list left, preview right: ${JSON.stringify({ list, preview })}`);
    assert(!(await page.$(view('.inbox-pv-head [aria-label="Close the preview"]'))), 'no close button on the view’s preview');
    // one row anatomy: the video and when, what happened, what was said; the times end in one column, also on rows
    // with actions (they take the time's place on hover, they have no column of their own)
    const times = await page.$$eval(view('.inbox-row:not(.pending)'), (rows) =>
      rows.map((r) => ({
        right: Math.round(r.querySelector('.inbox-when').getBoundingClientRect().right),
        acts: !!r.querySelector('.inbox-row-acts'),
        parts: ['.inbox-row-name', '.inbox-row-what'].every((s) => !!r.querySelector(s)),
      })),
    );
    const rights = times.map((x) => x.right);
    assert(times.every((x) => x.acts) && Math.max(...rights) - Math.min(...rights) <= 1, `times line up: ${JSON.stringify(times)}`);
    assert(
      times.every((x) => x.parts),
      'every row has a name and a what-happened line',
    );
    // "Got it" (and Later) on a row that only informs: hidden until the pointer is on the row, then in the time's place
    const answerRow = view('[data-testid="inbox-row-answer"]');
    const gotShown = () => page.$eval(`${answerRow} .inbox-row-acts`, (b) => getComputedStyle(b).opacity === '1');
    assert(!(await gotShown()), '"Got it" waits for the pointer');
    assert(await page.$(`${answerRow} [data-testid="inbox-row-done"][aria-label^="Got it"]`), 'what informs has "Got it"');
    await page.hover(answerRow);
    await until(gotShown, '"Got it" on hover');
    // the preview fills the pane to the window's bottom, and the page itself doesn't scroll (the list does); one layout
    // for every item: the picture on top, the words under it, the action (a question's answer) at the pane's bottom
    const fill = await page.evaluate(() => {
      const $ = (s) => document.querySelector(`[data-testid="inbox-view-preview"] ${s}`)?.getBoundingClientRect();
      const pane = document.querySelector('[data-testid="inbox-view-preview"]').getBoundingClientRect();
      const scroller = document.querySelector('.lib-scroll');
      const [text, act, stage] = [$('.inbox-pv-text'), $('.inbox-pv-act'), $('.inbox-stage')];
      return {
        bottom: pane.bottom,
        vh: innerHeight,
        pageScrolls: scroller.scrollHeight > scroller.clientHeight + 1,
        act: act ? Math.round(pane.bottom - act.bottom) : -1,
        above: !!(text && stage && stage.bottom <= text.top),
        chip: !!document.querySelector('[data-testid="inbox-view-preview"] .inbox-pv-head [data-testid="status-pill"]'),
      };
    });
    assert(fill.bottom >= fill.vh - 24 && fill.bottom <= fill.vh, `the preview reaches the window's bottom: ${JSON.stringify(fill)}`);
    assert(fill.act >= 0 && fill.act <= 24, `the answer is the action, at the pane's bottom like every action: ${JSON.stringify(fill)}`);
    assert(fill.above, `the picture on top, the words under it — as for every item: ${JSON.stringify(fill)}`);
    assert(!fill.chip, 'no stage chip over a conversation: it would describe the video, not the question');
    assert(!fill.pageScrolls, 'the page stays put, the list scrolls in its column');
    await presents(page, spotFile, 33, 75);
    await sleep(300);
    await shot('05-inbox-view-desktop');
  });

  // The full player's frame counter (the frame on screen) and a fresh inbox view with its first item open.
  const playerFrame = () => page.$eval('.tc .sub b', (e) => Number(e.textContent)).catch(() => -1);
  const inboxView = async () => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/inbox`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(view('[data-testid="inbox-video"]'), { timeout: 20000 });
  };
  const landsAt = async (want) => {
    await page.waitForFunction(() => location.hash.startsWith('#/v/'), { timeout: 5000 });
    await page.waitForSelector('.vbox video', { timeout: 20000 });
    await until(async () => (await playerFrame()) === want, `the full player on frame ${want} (${await playerFrame()})`);
  };

  await check(
    '"Open in player" — the button, O, a double-click, ↵ on the open item — lands on the frame on screen; a fix opens verify mode there',
    async () => {
      // O, after stepping in the preview: the note open, the frame the preview showed
      await page.focus(view('[data-testid="inbox-list"]'));
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await presents(page, spotFile, 35, 75);
      const href = await page.$eval(view('[data-testid="inbox-open-player"]'), (a) => a.getAttribute('href'));
      assert(href.includes(`c=${viewQuestion.id}`) && href.includes('v=1') && href.includes('f=35'), `the link names the note, version and frame: ${href}`);
      await page.keyboard.press('o');
      await landsAt(35);
      const open = await page.$eval('.comment.note.active', (e) => e.textContent);
      assert(open.includes(viewQuestion.text), `the question is the open note: ${open}`);
      // the button, resting on the item's frame
      await inboxView();
      await parked(page, 33);
      await page.click(view('[data-testid="inbox-open-player"]'));
      await landsAt(33);
      // a double-click on the picture (its clicks play and pause on the way: the frame that was on screen goes along)
      await inboxView();
      await parked(page, 33);
      await page.click(view('[data-testid="inbox-stage"]'), { count: 2 });
      await page.waitForFunction(() => location.hash.startsWith('#/v/'), { timeout: 5000 });
      const f = Number(new URLSearchParams(await page.evaluate(() => location.hash.split('?')[1])).get('f'));
      assert(f >= 33 && f <= 36, `the double-click took the frame on screen: ${f}`);
      await landsAt(f);
      // ↵ on the fix, stepped to its next frames: verify mode, at that frame of the new render
      await inboxView();
      await page.focus(view('[data-testid="inbox-list"]'));
      await page.keyboard.press('j');
      await until(async () => (await pickedRow()).kind === 'inbox-row-verify', 'the fix is open');
      // the fix's note sits on v2 (the newest render) itself
      const fixAt = viewFix.frame;
      await presents(page, filmFile, fixAt, 90);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await presents(page, filmFile, fixAt + 2, 90);
      await page.keyboard.press('Enter');
      await page.waitForFunction((id) => location.hash.includes(`verify=${id}`), { timeout: 5000 }, viewFix.id);
      await page.waitForSelector('.verify .c-text', { timeout: 20000 });
      await landsAt(fixAt + 2);
      await inboxView();
    },
  );

  await check('↑/↓ (j/k) in the view’s list move the preview with them; answering and checking move on', async () => {
    await page.focus(view('[data-testid="inbox-list"]'));
    await page.keyboard.press('j');
    await until(async () => (await pickedRow()).kind === 'inbox-row-verify', 'j opens the next item');
    await until(async () => (await page.$eval(view('.inbox-pv-body'), (e) => e.textContent)).includes('Lowered the title'), 'the preview follows');
    await page.keyboard.press('ArrowUp');
    await until(async () => (await pickedRow()).kind === 'inbox-row-question', '↑ goes back');
    await page.waitForSelector(view('.inbox-act textarea'));
    await page.type(view('.inbox-act textarea'), 'On the beat, yes');
    await page.click(view('.inbox-act button[type="submit"]'));
    await until(async () => (await comment(spot, viewQuestion.id)).status === 'verified', 'answered from the view');
    await until(async () => (await pickedRow()).kind === 'inbox-row-verify', 'the fix takes the question’s place');
    await page.waitForSelector(view('.inbox-act-row button'));
    await page.$$eval(view('.inbox-act-row button'), (bs) => bs.find((b) => b.textContent.includes('Looks right'))?.click());
    await until(async () => (await comment(film, viewFix.id)).status === 'verified', 'fix verified from the view');
  });

  await check('the old #/for-you address opens the inbox view, and shows as #/inbox', async () => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/for-you`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(VIEW_READY, { timeout: 20000 });
    assert((await page.evaluate(() => location.hash)) === '#/inbox', `hash ${await page.evaluate(() => location.hash)}`);
    assert((await page.$eval('[data-testid="nav-inbox"]', (e) => e.getAttribute('aria-current'))) === 'page', 'the sidebar marks the inbox');
  });

  await check('"Open full inbox" in the bell’s popover goes to the view', async () => {
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.film', { timeout: 20000 });
    await page.click('[data-testid="inbox-bell"]');
    await page.waitForSelector('[data-testid="inbox-full"]');
    assert((await page.$eval('[data-testid="inbox-full"]', (a) => a.getAttribute('href'))) === '#/inbox', 'the link names the view');
    await page.click('[data-testid="inbox-full"]');
    await page.waitForFunction(() => location.hash === '#/inbox', { timeout: 5000 });
    await page.waitForSelector('[data-testid="inbox"]', { hidden: true });
    await page.waitForSelector(VIEW_READY, { timeout: 15000 });
  });

  await check('stalled videos come last and quieter, not in the bell’s number; "Nudge agent" sends the agent a request', async () => {
    // promo: handed to an agent, and both its fixes came back — stalled, waiting on the agent
    const promoFile = makeVideo(path.join(dir, 'Globex/out/promo.mp4'), { w: 320, h: 180, fps: 25, dur: 2 });
    const promo = await add(promoFile);
    await api(`/api/review/${encodeURIComponent(promo)}/session`, 'PUT', { name: 'promo-edit' });
    for (const frame of [3, 7]) {
      const c = await note(promo, { frame, text: 'Hold the end card longer', severity: 'must' });
      await api(`/api/comments/${c.id}`, 'PATCH', { status: 'fixed', note: 'held', by: 'agent:promo-edit' });
      await api(`/api/comments/${c.id}`, 'PATCH', { status: 'open', note: 'still short' });
    }
    await api(`/api/review/${encodeURIComponent(promo)}/agent-status`, 'PUT', { text: 'rendering v2', by: 'agent:promo-edit' });
    const fy = await api('/api/for-you');
    const item = fy.items.find((i) => i.kind === 'stalled' && i.slug === promo);
    assert(item && item.waitingOn === 'agents' && item.reason === 'reopened' && item.count === 2, `stalled: ${JSON.stringify(item)}`);
    assert(fy.counts.total === fy.items.filter((i) => i.kind !== 'stalled').length, 'the bell doesn’t count what stalled');

    await page.goto('about:blank');
    await page.goto(`${BASE}/#/inbox`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(view('[data-testid="inbox-row-stalled"]'), { timeout: 20000 });
    const groups = await page.$$eval(view('.inbox-group'), (gs) => gs.map((g) => g.getAttribute('aria-label')));
    assert(groups.at(-1) === 'Stalled', `the last group: ${groups}`);
    const rowText = await page.$eval(view('[data-testid="inbox-row-stalled"]'), (r) => r.textContent);
    assert(/promo\.mp4/.test(rowText) && /Waiting on promo-edit/.test(rowText) && /2 fixes came back/.test(rowText), `the row: ${rowText}`);
    assert(/1\s*stalled/.test(await page.$eval('[data-testid="inbox-tally"]', (e) => e.textContent)), 'the tally names it, apart from what waits');
    await until(
      async () => (await page.$eval('[data-testid="nav-inbox"] .nav-count', (e) => e.textContent)) === String(fy.counts.total),
      'the sidebar counts what waits for you only',
    );
    await page.click(view('[data-testid="inbox-row-stalled"]'));
    await page.waitForSelector(view('[data-testid="inbox-nudge"]'), { timeout: 10000 });
    await shot('07-inbox-view-stalled');
    await page.click(view('[data-testid="inbox-nudge"]'));
    await page.waitForSelector(view('[data-testid="inbox-row-stalled"]'), { hidden: true, timeout: 10000 });
    const events = fs
      .readFileSync(path.join(dir, 'data', 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const nudge = events.filter((x) => x.type === 'request').at(-1);
    assert(nudge && /nudge from the inbox: promo\.mp4 has 2 fixes that came back/i.test(nudge.text), `the agent's request: ${JSON.stringify(nudge)}`);
    // the row goes at once; the server's list follows the request it just wrote (a slow runner read it a moment early)
    await until(async () => !(await api('/api/for-you')).items.some((i) => i.kind === 'stalled' && i.slug === promo), 'off the list until it moves again');
  });

  await check('a new video is your turn at once: in the bell’s number and the inbox as “New video”, gone with a verdict', async () => {
    const before = (await api('/api/for-you')).counts.total;
    const freshFile = makeVideo(path.join(dir, 'Initech/renders/opener.mp4'), { w: 320, h: 180, fps: 25, dur: 2 });
    const fresh = await add(freshFile);
    const fy = await api('/api/for-you');
    const item = fy.items.find((i) => i.slug === fresh);
    assert(item?.kind === 'review' && item.v === 1 && !item.dismissible, `a render to review, not something to wave away: ${JSON.stringify(item)}`);
    assert(fy.counts.total === before + 1, `the bell counts it: ${before} → ${fy.counts.total}`);
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/inbox`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(`[data-testid="inbox-bell"][aria-label="Inbox, ${before + 1} waiting"]`, { timeout: 20000 });
    await until(async () => (await page.$eval('[data-testid="nav-inbox"] .nav-count', (e) => e.textContent)) === String(before + 1), 'the sidebar counts it');
    const row = await page.waitForFunction(
      () => [...document.querySelectorAll('[data-testid="inbox-view"] [data-testid="inbox-row-review"]')].find((r) => r.textContent.includes('opener.mp4')),
      { timeout: 15000 },
    );
    const text = await row.evaluate((r) => r.textContent);
    assert(text.includes('New video') && !/waiting for your review/.test(text), `says what it is, once: ${text}`);
    assert(!(await row.evaluate((r) => !!r.querySelector('[data-testid="inbox-row-done"]'))), 'no “Got it”: it leaves with a verdict (or Later)');
    await row.evaluate((r) => r.click());
    await page.waitForSelector(view('[data-testid="inbox-pv-render"]'), { timeout: 15000 });
    const facts = await page.$eval(view('[data-testid="inbox-pv-body"]'), (e) => e.textContent);
    assert(
      /^New video/.test(facts) && /320×180/.test(facts) && !/new video to review|put up a new video/i.test(facts),
      `the preview says what it is once, then what it brings: ${facts}`,
    );
    await sleep(300);
    await shot('07-inbox-view-new-video');
    // approve it right there: off the list, off the bell
    await page.$$eval(view('.inbox-pv-act button'), (bs) => bs.find((b) => b.textContent.includes('Approve'))?.click());
    await until(async () => !(await api('/api/for-you')).items.some((i) => i.slug === fresh), 'approved: nothing waits');
    await page.waitForFunction(
      () => ![...document.querySelectorAll('[data-testid="inbox-view"] [data-testid="inbox-row-review"]')].some((r) => r.textContent.includes('opener.mp4')),
      { timeout: 15000 },
    );
  });

  await check('the inbox view fits every width in both themes (390 to 1920)', async () => {
    const bad = [];
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => localStorage.setItem('vr.theme', t), theme);
      await page.goto('about:blank');
      await page.goto(`${BASE}/#/inbox`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(VIEW_READY, { timeout: 20000 });
      await sleep(400);
      assert((await page.evaluate(() => document.documentElement.dataset.theme)) === theme, `${theme} theme on`);
      bad.push(...(await fitsAt(page, `inbox view (${theme})`)));
    }
    await page.evaluate(() => localStorage.removeItem('vr.theme'));
    assert(!bad.length, bad.join('\n'));
  });

  // German says "hat es in V2 korrigiert" where English says "fixed it in V2": the words give way, never the timecode.
  await check('German rows keep their timecode whole: what happened is cut short, the moment never (1440, 1024, 390)', async () => {
    const cut = [];
    await page.evaluate(() => localStorage.setItem('vr.lang', 'de'));
    for (const [width, height] of [
      [1440, 900],
      [1024, 768],
      [390, 844],
    ]) {
      await page.setViewport({ width, height });
      await page.goto('about:blank');
      await page.goto(`${BASE}/#/inbox`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(VIEW_READY, { timeout: 20000 });
      await settle(page);
      const found = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid=inbox-view] :is(.inbox-row-top, .fy-meta) .mono')]
          .filter((m) => /^\d\d:\d\d/.test(m.textContent.trim()))
          .map((m) => {
            let clip = m.parentElement;
            while (clip && getComputedStyle(clip).overflowX === 'visible') clip = clip.parentElement;
            const r = m.getBoundingClientRect();
            return clip && r.right > clip.getBoundingClientRect().right + 0.5
              ? `"${m.closest('.inbox-row-top, .fy-meta').textContent.trim().slice(0, 60)}"`
              : null;
          })
          .filter(Boolean),
      );
      for (const f of found) cut.push(`@${width}: ${f}`);
    }
    await page.evaluate(() => localStorage.removeItem('vr.lang'));
    await page.setViewport({ width: 1440, height: 900 });
    assert(!cut.length, `timecodes cut off:\n${cut.join('\n')}`);
  });

  await check('a vertical render sits in the same band as a wide one: its own shape in the middle, what was said under it', async () => {
    const reelFile = makeVideo(path.join(dir, 'Acme/export/reel.mp4'), { w: 180, h: 320, fps: 25, dur: 2 });
    const reel = await add(reelFile);
    const q = await note(reel, { frame: 12, text: 'Is the logo clear of the buttons?', by: 'agent:promo-edit' });
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/inbox`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(view('.inbox-row:not(.pending)'), { timeout: 20000 });
    for (const el of await page.$$(view('[data-testid="inbox-row-question"]')))
      if ((await el.evaluate((e) => e.textContent)).includes(q.text)) await el.click();
    await presents(page, reelFile, 12, 50);
    const rects = () =>
      Promise.all(
        ['.inbox-stage', '.inbox-stage-box', '[data-testid="inbox-pv-body"]'].map((s) => page.$eval(view(s), (e) => e.getBoundingClientRect().toJSON())),
      );
    const [stage, band, body] = await rects();
    assert(Math.abs(stage.width / stage.height - 180 / 320) < 0.03, `the picture keeps its shape: ${stage.width}×${stage.height}`);
    assert(Math.abs(stage.left + stage.width / 2 - (band.left + band.width / 2)) <= 1, 'in the middle of the band');
    assert(body.top >= band.bottom, `what was said is under the picture: body at ${body.top}, band ends at ${band.bottom}`);
    // a wide render's question: the same band, in the same place — the video never jumps between items
    // a row of a wide video (not the reel's own rows; by video the group names it, by kind the row does)
    for (const el of await page.$$(view('.inbox-row:not(.pending)')))
      if (!(await el.evaluate((e) => `${e.closest('[data-testid="inbox-vgroup"]')?.getAttribute('aria-label') ?? ''} ${e.textContent}`.includes('reel')))) {
        await el.click();
        break;
      }
    await until(async () => !(await page.$eval(view('[data-testid="inbox-pv-body"]'), (e) => e.textContent)).includes(q.text), 'another item open');
    await sleep(300);
    const [wide, band2] = await rects();
    assert(Math.abs(band2.top - band.top) <= 1 && Math.abs(band2.height - band.height) <= 1, `one band: ${JSON.stringify({ band, band2 })}`);
    assert(wide.width > wide.height, `the wide render fills it across: ${wide.width}×${wide.height}`);
    await sleep(300);
    await shot('07-inbox-view-vertical');
    await api(`/api/comments/${q.id}`, 'PATCH', { status: 'verified', note: 'Yes' });
  });

  await check('a question is a conversation: it opens on the moment its words name, their timecodes seek, a choice answers it in one click', async () => {
    const teaserFile = makeVideo(path.join(dir, 'Acme/export/teaser.mp4'), { w: 320, h: 180, fps: 25, dur: 4 });
    const teaser = await add(teaserFile);
    await api(`/api/review/${encodeURIComponent(teaser)}/session`, 'PUT', { name: 'promo-edit' });
    const q = await note(teaser, {
      frame: 0,
      scope: 'video',
      text: 'Keep the music, or the calmer cut from 00:02:10 on — or only after 00:03:05?',
      choices: ['Keep this music', 'Try the calmer cut'],
      by: 'agent:promo-edit',
    });
    // the player's card: the choices under the question, a timecode in its words seeks the player
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${encodeURIComponent(teaser)}`, { waitUntil: 'domcontentloaded' });
    // a row until it is opened: its card holds the choices and the words with their timecodes
    await page.waitForFunction(() => [...document.querySelectorAll('.side-scroll .note-row')].some((n) => n.textContent.includes('calmer cut')), {
      timeout: 20000,
    });
    await page.evaluate(() =>
      [...document.querySelectorAll('.side-scroll .note-row')]
        .find((n) => n.textContent.includes('calmer cut'))
        ?.querySelector('.nr')
        ?.click(),
    );
    await page.waitForSelector('.c-text .tc-link[data-frame="80"]', { timeout: 20000 });
    const cardChoices = await page.$$eval('[data-testid="choices"] button', (bs) => bs.map((b) => b.textContent));
    assert(JSON.stringify(cardChoices) === JSON.stringify(['Keep this music', 'Try the calmer cut']), `the card offers the choices: ${cardChoices}`);
    await page.click('.c-text .tc-link[data-frame="80"]');
    await until(async () => (await playerFrame()) === 80, `the player on the link's frame 80 (${await playerFrame()})`);
    // the inbox: a note about the whole video opens on the first moment it names (00:02:10 = frame 60), not frame 0
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/inbox`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(view('.inbox-row:not(.pending)'), { timeout: 20000 });
    for (const el of await page.$$(view('[data-testid="inbox-row-question"]')))
      if ((await el.evaluate((e) => e.textContent)).includes('calmer cut')) await el.click();
    await presents(page, teaserFile, 60, 100);
    const state = await page.$eval(view('[data-testid="inbox-agent-state"]'), (e) => e.textContent.trim());
    assert(state === 'Not running · gets it when it starts', `whether the asking agent gets it now: ${state}`);
    await page.click(view('.inbox-pv-text .tc-link[data-frame="80"]'));
    await presents(page, teaserFile, 80, 100);
    await shot('07b-inbox-view-choices');
    // one click on a choice sends its words as the answer, and the question leaves the list
    await page.$$eval(view('[data-testid="choices"] button'), (bs) => bs.find((b) => b.textContent === 'Try the calmer cut')?.click());
    await until(async () => (await comment(teaser, q.id))?.status === 'verified', 'the question is answered');
    const answered = await comment(teaser, q.id);
    assert(answered.replies.at(-1)?.text === 'Try the calmer cut', `the choice is the answer: ${JSON.stringify(answered.replies.at(-1))}`);
    await until(
      async () => !(await page.$$eval(view('[data-testid="inbox-row-question"]'), (rs) => rs.some((r) => r.textContent.includes('calmer cut')))),
      'the answered question leaves the list',
    );
  });

  await check('notifications: the inbox asks while this device hasn’t decided (“Not now” puts it away); once on, they live in Settings', async () => {
    const EP = 'https://fcm.googleapis.com/fcm/send/inbox-e2e-device';
    const KEYS = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
    // A headless browser has no push service and no notification system: the page's permission and subscription are
    // stand-ins (what the inbox shows for each is what's checked here), the endpoint is registered with the server below.
    await page.evaluateOnNewDocument(() => {
      if (typeof ServiceWorkerContainer === 'undefined' || typeof Notification === 'undefined') return;
      const permission = Object.getOwnPropertyDescriptor(Notification, 'permission');
      Object.defineProperty(Notification, 'permission', { get: () => localStorage.getItem('test.push.permission') || permission.get.call(Notification) });
      const own = ServiceWorkerContainer.prototype.getRegistration;
      ServiceWorkerContainer.prototype.getRegistration = function (...a) {
        const ep = localStorage.getItem('test.push.endpoint');
        if (!ep) return own.apply(this, a);
        const sub = { endpoint: ep, toJSON: () => ({ endpoint: ep, keys: {} }), unsubscribe: async () => true };
        return Promise.resolve({ pushManager: { getSubscription: async () => sub } });
      };
    });
    const card = () => page.$(view('[data-testid="notify-card"]'));
    try {
      // undecided: a quiet invitation under the list, put away with "Not now" (and it stays away on this device)
      await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => localStorage.setItem('test.push.permission', 'default'));
      await page.goto('about:blank');
      await page.goto(`${BASE}/#/inbox`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(view('[data-testid="notify-card"]'), { timeout: 20000 });
      assert((await (await card()).evaluate((e) => e.textContent)).includes('Get a ping'), 'the invitation');
      await page.click(view('[data-testid="notify-later"]'));
      await page.waitForSelector(view('[data-testid="notify-card"]'), { hidden: true });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector(VIEW_READY, { timeout: 20000 });
      await sleep(800);
      assert(!(await card()), 'still away after a reload');
      await page.evaluate(() => localStorage.removeItem('vr.notify.later'));
      // on: nothing about them in the inbox
      await api('/api/push/subscribe', 'POST', { subscription: { endpoint: EP, keys: KEYS }, name: 'Test Mac' });
      await page.evaluate((ep) => {
        localStorage.setItem('test.push.endpoint', ep);
        localStorage.setItem('test.push.permission', 'granted');
      }, EP);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector(VIEW_READY, { timeout: 20000 });
      await sleep(800);
      assert(!(await card()), 'no notifications card once they are on');
      // Settings → Notifications has what the card had: the device, what pings, a test, off
      await page.goto(`${BASE}/#/settings/notifications`, { waitUntil: 'domcontentloaded' });
      const ON = '[data-testid="push-settings"][data-state="on"]:not([aria-busy])';
      await page.waitForSelector(ON, { timeout: 20000 });
      const text = await page.$eval('[data-testid="push-settings"]', (e) => e.textContent);
      assert(text.includes('Notifications are on') && text.includes('Test Mac'), `the device: ${text}`);
      assert((await page.$$('[data-testid="push-settings"] [role="switch"]')).length === 6, 'a switch for each kind');
      assert(text.includes('Send a test') && text.includes('Turn off here'), 'test and turn off');
      await page.click('#fy-pref-versions');
      await until(async () => (await api(`/api/push?endpoint=${encodeURIComponent(EP)}`)).subscription?.prefs.versions === true, 'the choice is saved');
      await shot('08-settings-notifications');
      // A reload shows the kept state at once: the card has its final height and words from its first frame.
      await sleep(700);
      await page.reload({ waitUntil: 'domcontentloaded' });
      const first = await (
        await page.waitForFunction(
          () => {
            const el = document.querySelector('[data-testid="push-settings"]');
            return el && { h: el.getBoundingClientRect().height, text: el.textContent };
          },
          { polling: 'raf', timeout: 20000 },
        )
      ).jsonValue();
      await page.waitForSelector(ON, { timeout: 20000 });
      await sleep(1500);
      const last = await page.$eval('[data-testid="push-settings"]', (e) => e.getBoundingClientRect().height);
      assert(Math.abs(first.h - last) < 1, `the card moved from ${first.h} to ${last} px after a reload`);
      assert(first.text.includes('Test Mac'), `the kept state at once: ${first.text}`);
    } finally {
      await api('/api/push/unsubscribe', 'POST', { endpoint: EP }).catch(() => {});
      await page
        .evaluate(() => {
          localStorage.removeItem('test.push.endpoint');
          localStorage.removeItem('test.push.permission');
        })
        .catch(() => {});
    }
  });

  await check('the bell sits in the player, status and settings top bars too', async () => {
    for (const [hash, sel] of [
      [`#/v/${encodeURIComponent(spot)}`, '.vbox video'],
      ['#/status', '[data-testid=library-board]'],
      ['#/inbox', VIEW_READY],
    ]) {
      await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(sel, { timeout: 20000 });
      assert(await page.$('.topbar [data-testid="inbox-bell"]'), `bell on ${hash}`);
    }
  });

  await check('keys in the inbox stay in the inbox: Y over verify mode does not verify the fix underneath', async () => {
    // The page comes from the inbox view, whose preview cached film's review before this fix exists: the verify link
    // must still open verify mode at it (the player tries again on the refetched review).
    const c = await note(film, { frame: 30, text: 'Logo too small', severity: 'should' });
    await api(`/api/comments/${c.id}`, 'PATCH', { status: 'fixed', note: 'Bigger logo', by: 'agent:brand-film' });
    await page.goto(`${BASE}/#/v/${encodeURIComponent(film)}?verify=${c.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.verify .c-text', { timeout: 20000 });
    await page.click('[data-testid="inbox-bell"]');
    await page.waitForSelector(row('verify'));
    await page.focus('[data-testid="inbox-list"]');
    await page.keyboard.press('y');
    await sleep(600);
    assert((await comment(film, c.id)).status === 'fixed', 'still waiting for a check');
    await page.keyboard.press('Escape');
    await api(`/api/comments/${c.id}`, 'PATCH', { status: 'verified' });
  });

  // ---------------------------------------------------------------- clearing the inbox where it is (by video)
  // A video with two questions, three fixes and an agent's reply to a note: everything it needs, under one head.
  const promoFile = makeVideo(path.join(dir, 'Acme/export/promo.mp4'), { w: 320, h: 180, fps: 25, dur: 2 });
  const promo = await add(promoFile);
  const pq1 = await note(promo, { frame: 10, text: 'Hold the logo longer?', by: 'agent:promo-cut' });
  const pq2 = await note(promo, { frame: 20, text: 'Brighter grade on the product?', by: 'agent:promo-cut' });
  const pf1 = await note(promo, { frame: 30, text: 'Price card too small', severity: 'must' });
  const pf2 = await note(promo, { frame: 40, text: 'Jump cut at the end', severity: 'should' });
  const pf3 = await note(promo, { frame: 15, text: 'Logo off centre', severity: 'should' });
  for (const c of [pf1, pf2, pf3]) await api(`/api/comments/${c.id}`, 'PATCH', { status: 'fixed', note: `Fixed: ${c.text}`, by: 'agent:promo-cut' });
  const pmine = await note(promo, { frame: 5, text: 'Music under the voice?' });
  await api(`/api/comments/${pmine.id}`, 'PATCH', { note: 'Ducked it by 6 dB', by: 'agent:promo-cut' });
  const pg = (sel = '') => view(`[data-testid="inbox-vgroup"][aria-label="promo.mp4"] ${sel}`);
  const rowOf = (key) => pg(`[data-key="${key}"]`);
  const clearToasts = () =>
    until(async () => {
      await page.$$eval('[data-testid=toast] .toast-x', (bs) => {
        for (const b of bs) b.click();
      });
      return !(await page.$('[data-testid=toast]'));
    }, 'no toasts left');
  const undo = async () => {
    await page.waitForSelector('[data-testid=toast] .toast-act');
    await page.$$eval('[data-testid=toast] .toast-act', (bs) => bs.at(-1).click());
  };
  const hoverAct = async (key, act) => {
    await page.hover(rowOf(key));
    await page.waitForFunction((s) => getComputedStyle(document.querySelector(s)).opacity === '1', {}, `${rowOf(key)} .inbox-row-acts`);
    await page.click(`${rowOf(key)} [data-testid="${act}"]`);
  };
  // A row's checkbox shows (and takes clicks) while the pointer is on its row: bring the row to the list's middle, point
  // at it, and click once the checkbox is what the pointer would hit (a busy machine lags behind a synthetic click).
  const check_ = async (key) => {
    const sel = `${rowOf(key)} [data-testid="inbox-check"]`;
    await page.$eval(rowOf(key), (r) => r.scrollIntoView({ block: 'center' }));
    await page.hover(rowOf(key));
    await page.waitForFunction(
      (s) => {
        const el = document.querySelector(s);
        const r = el?.getBoundingClientRect();
        const hit = r && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return !!hit && (hit === el || el.contains(hit));
      },
      { timeout: 5000 },
      sel,
    );
    await page.click(sel);
  };
  const bellN = async () => Number((await page.$eval('[data-testid="inbox-bell"]', (b) => b.getAttribute('aria-label'))).match(/(\d+) waiting/)?.[1] ?? 0);
  const segment = (label) => page.$$eval('.inbox-mode [role=radio]', (bs, l) => bs.find((b) => b.textContent.trim() === l)?.click(), label);

  await check(
    'by video is the default: one head per video saying what it holds, its items most urgent first; the header switches to by kind and remembers it',
    async () => {
      await page.evaluate(() => localStorage.removeItem('vr.inbox'));
      await page.goto('about:blank');
      await page.goto(`${BASE}/#/inbox`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(pg('.inbox-row'), { timeout: 20000 });
      const sum = await page.$eval(pg('[data-testid="inbox-video-sum"]'), (e) => e.textContent);
      assert(sum.includes('2 questions · 3 fixes · 1 reply'), `the head says what the video holds: ${sum}`);
      const kinds = await page.$$eval(pg('.inbox-row'), (rs) => rs.map((r) => r.dataset.testid.replace('inbox-row-', '')));
      assert(
        JSON.stringify(kinds) === JSON.stringify(['question', 'question', 'verify', 'verify', 'verify', 'answer']),
        `questions → fixes → what informs: ${kinds}`,
      );
      const top = await page.$eval(pg('.inbox-row .inbox-row-name'), (e) => e.textContent);
      assert(/promo-cut asks/.test(top) && !top.includes('promo.mp4'), `under the video's head a row starts with what happened: ${top}`);
      // the most urgent video first: every video holding a question before any without one
      const firsts = await page.$$eval(view('[data-testid="inbox-vgroup"]'), (gs) => gs.map((g) => g.querySelector('.inbox-row')?.dataset.testid));
      const lastQ = firsts.lastIndexOf('inbox-row-question');
      const firstOther = firsts.findIndex((k) => k !== 'inbox-row-question');
      assert(firstOther === -1 || lastQ < firstOther, `videos with a question first: ${firsts}`);
      await sleep(300);
      await shot('08-inbox-by-video');
      await segment('By kind');
      await page.waitForSelector(view('.inbox-group.g-question'));
      assert(!(await page.$(view('[data-testid="inbox-vgroup"]'))), 'by kind: no video heads');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector(view('.inbox-group.g-question'), { timeout: 20000 });
      await segment('By video');
      await page.waitForSelector(pg('.inbox-row'));
      assert(JSON.parse(await page.evaluate(() => localStorage.getItem('vr.inbox'))).mode === 'video', 'remembered on this device');
    },
  );

  await check('the view fits every width by video too (390 to 1920)', async () => {
    const bad = await fitsAt(page, 'inbox view by video');
    assert(!bad.length, bad.join('\n'));
    await page.goto(`${BASE}/#/inbox`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(pg('.inbox-row'), { timeout: 20000 });
  });

  await check('Done on a question: off the list at once with Undo, nothing sent until the toast is gone; E does it from the keys', async () => {
    await clearToasts();
    const key = `q:${pq1.id}`;
    await hoverAct(key, 'inbox-row-done');
    await page.waitForSelector(rowOf(key), { hidden: true });
    assert((await comment(promo, pq1.id)).status === 'open', 'nothing sent while Undo is offered');
    await undo();
    await page.waitForSelector(rowOf(key));
    await page.click(rowOf(key));
    await page.keyboard.press('e');
    await page.waitForSelector(rowOf(key), { hidden: true });
    await clearToasts();
    await until(async () => (await comment(promo, pq1.id)).status === 'verified', 'closed on the server once the toast is gone');
    const last = (await comment(promo, pq1.id)).replies.at(-1);
    assert(last.status === 'verified' && !last.text, `closed without an answer: ${JSON.stringify(last)}`);
  });

  await check('a fix is checked in its row: Still wrong asks why right there (keys stay out of the field); Looks right with Undo', async () => {
    await clearToasts();
    const wrong = `fix:${pf1.id}`;
    await hoverAct(wrong, 'inbox-row-wrong');
    const field = `${rowOf(wrong)} [data-testid="inbox-row-ask"] input`;
    await page.waitForSelector(field);
    assert(await page.evaluate((s) => document.activeElement === document.querySelector(s), field), 'the field has the focus');
    await page.type(field, 'Still tiny on phones, hex');
    await sleep(200);
    assert(await page.$(rowOf(wrong)), 'E and H typed in the field do nothing to the list');
    await shot('09-inbox-still-wrong-in-row');
    await page.keyboard.press('Enter');
    await until(async () => (await comment(promo, pf1.id)).status === 'open', 'back to the agent');
    const said = (await comment(promo, pf1.id)).replies.at(-1);
    assert(said.text === 'Still tiny on phones, hex', `with what is wrong: ${JSON.stringify(said)}`);
    await page.waitForSelector(rowOf(wrong), { hidden: true });
    const right = `fix:${pf3.id}`;
    await hoverAct(right, 'inbox-row-right');
    await page.waitForSelector(rowOf(right), { hidden: true });
    assert((await comment(promo, pf3.id)).status === 'fixed', 'not sent while Undo is offered');
    await undo();
    await page.waitForSelector(rowOf(right));
    await hoverAct(right, 'inbox-row-right');
    await page.waitForSelector(rowOf(right), { hidden: true });
    await clearToasts();
    await until(async () => (await comment(promo, pf3.id)).status === 'verified', 'Looks right reached the server');
  });

  await check(
    'Later: off the list and the bell’s number, “1 later” shows it with Bring back; it comes back by itself when its time is up, or once its video moves',
    async () => {
      await clearToasts();
      const key = `fix:${pf2.id}`;
      const before = await bellN();
      await hoverAct(key, 'inbox-row-later');
      await page.waitForSelector(rowOf(key), { hidden: true });
      await until(async () => (await bellN()) === before - 1, 'the bell counts one less');
      const fy = await api('/api/for-you');
      assert(fy.later?.some((i) => i.key === key) && !fy.items.some((i) => i.key === key) && fy.counts.later === 1, 'put aside on the server, not counted');
      assert((await comment(promo, pf2.id)).status === 'fixed', 'the note is as it was');
      // "1 later" shows at once (optimistic), not after the server's round trip
      await page.waitForSelector(view('[data-testid="inbox-later-toggle"]'), { timeout: 3000 });
      await page.click(view('[data-testid="inbox-later-toggle"]'));
      await page.waitForSelector(view('[data-testid="inbox-later-row"]'));
      const said = await page.$eval(view('[data-testid="inbox-later"]'), (e) => e.textContent);
      assert(/1 later/.test(said) && /tomorrow at/.test(said), `says when it comes back: ${said}`);
      // Later's own toast (with Undo) can sit over the list's foot: out of the way first
      await clearToasts();
      await page.click(view('[data-testid="inbox-later-row"] [data-testid="inbox-bring-back"]'));
      await page.waitForSelector(rowOf(key), { timeout: 10000 });
      await until(async () => (await bellN()) === before, 'counted again');
      // a short Later (the API takes any time in the next 30 days): it comes back on its own, without a reload
      await api('/api/for-you/snooze', 'POST', { keys: [key], until: new Date(Date.now() + 4000).toISOString() });
      await page.waitForSelector(rowOf(key), { hidden: true, timeout: 10000 });
      await page.waitForSelector(rowOf(key), { timeout: 15000 });
      // until its video moves: a new note on it brings it back at once
      await hoverAct(key, 'inbox-row-later');
      await page.waitForSelector(rowOf(key), { hidden: true });
      await note(promo, { frame: 44, text: 'One more thing', severity: 'should' });
      await page.waitForSelector(rowOf(key), { timeout: 15000 });
      assert(!(await api('/api/for-you')).later?.length, 'nothing aside any more');
    },
  );

  await check('an update read in the preview leaves when you move on — no "Got it" needed; skimming past keeps it', async () => {
    await clearToasts();
    const asked = await note(promo, { frame: 30, text: 'Is the voice-over final?' });
    await api(`/api/comments/${asked.id}`, 'PATCH', { note: 'Yes, recorded yesterday', by: 'agent:promo-cut' });
    let A = null;
    await until(async () => {
      A = (await api('/api/for-you')).items.find((i) => i.kind === 'answer' && i.text?.includes('recorded yesterday'))?.key ?? null;
      return !!A;
    }, 'the reply is in the inbox');
    await page.waitForSelector(rowOf(A), { timeout: 15000 });
    const other = async () => page.$$eval(pg('.inbox-row'), (rs, a) => rs.map((r) => r.dataset.key).find((k) => k !== a), A);
    // skimming: open it and move on at once — still there
    await page.$eval(rowOf(A), (r) => r.scrollIntoView({ block: 'center' }));
    await page.click(`${rowOf(A)} .inbox-row-body`);
    await page.click(`${rowOf(await other())} .inbox-row-body`);
    await sleep(800);
    assert(await page.$(rowOf(A)), 'a glance is not a read');
    // read: open for a moment, then on to another item — it leaves, here and on the server
    await page.click(`${rowOf(A)} .inbox-row-body`);
    await sleep(2000);
    assert(await page.$(rowOf(A)), 'it stays while it is open');
    await page.click(`${rowOf(await other())} .inbox-row-body`);
    await page.waitForSelector(rowOf(A), { hidden: true, timeout: 10000 });
    await until(async () => !(await api('/api/for-you')).items.some((i) => i.key === A), 'seen on the server too');
  });

  await check('several at once: the checkbox, ⇧-click for a run, ⌘A for all; the bar clears them with one Undo', async () => {
    await clearToasts();
    const pq3 = await note(promo, { frame: 22, text: 'Shorter end card?', by: 'agent:promo-cut' });
    const [a, b] = [`q:${pq3.id}`, `q:${pq2.id}`];
    await page.waitForSelector(rowOf(a), { timeout: 15000 });
    await page.hover(rowOf(a));
    await check_(a);
    await page.waitForSelector(view('[data-testid="inbox-selbar"]'));
    await page.keyboard.down('Shift');
    await check_(b);
    await page.keyboard.up('Shift');
    const n = await page.$eval(view('.inbox-selbar-n'), (e) => e.textContent);
    assert(n === '2 selected', n);
    assert(!(await page.$(view('[data-testid="inbox-sel-right"]'))), 'Looks right only when every one is a fix');
    // One calm system: the bar floats over the list's foot (a float's material, its own width, centred), and no row is
    // a lifted card — the picked ones share one flat fill; the item in the preview, not picked, steps back to the
    // pointer's fainter one (with the same fill it read as a third picked row under "2 selected"); nothing wears the
    // orange.
    await page.mouse.move(5, 5);
    const look = await page.evaluate(
      (barSel, listSel) => {
        const bar = document.querySelector(barSel);
        const list = document.querySelector(listSel);
        const cs = getComputedStyle(bar);
        const b = bar.getBoundingClientRect();
        const l = list.getBoundingClientRect();
        const rows = [...list.querySelectorAll('.inbox-row:not(.pending)')];
        const style = (r) => r && { bg: getComputedStyle(r).backgroundColor, shadow: getComputedStyle(r).boxShadow };
        return {
          position: cs.position,
          radius: Number.parseFloat(cs.borderTopLeftRadius),
          shadow: cs.boxShadow,
          narrower: b.width < l.width - 40,
          centred: Math.abs(b.left + b.width / 2 - (l.left + l.width / 2)) < 12,
          picked: style(rows.find((r) => r.classList.contains('picked'))),
          preview: style(rows.find((r) => r.classList.contains('picked') && !r.classList.contains('checked'))),
          checked: rows.filter((r) => r.classList.contains('checked')).map(style),
          rest: style(rows.find((r) => !r.matches('.picked, .checked, .active, :hover, :focus-within'))),
        };
      },
      view('[data-testid="inbox-selbar"]'),
      view('.inbox-view-list'),
    );
    assert(
      look.position === 'sticky' && look.radius >= 8 && look.shadow !== 'none' && look.narrower && look.centred,
      `the bar floats over the list, centred: ${JSON.stringify(look)}`,
    );
    for (const s of [look.picked, ...look.checked].filter(Boolean))
      assert(s.shadow === 'none' && !/linear-gradient/.test(s.bg), `picked rows are a flat fill, not a lifted card: ${JSON.stringify(look)}`);
    assert(look.checked.length === 2 && look.checked.every((s) => s.bg === look.checked[0].bg), `one fill for every picked row: ${JSON.stringify(look)}`);
    assert(look.rest && look.rest.bg !== look.checked[0].bg, `a row at rest has no fill: ${JSON.stringify(look)}`);
    assert(!look.preview || look.preview.bg !== look.checked[0].bg, `the item in the preview doesn't look picked: ${JSON.stringify(look)}`);
    await sleep(200);
    await shot('10-inbox-multi-select');
    await page.click(view('[data-testid="inbox-sel-done"]'));
    await page.waitForSelector(rowOf(a), { hidden: true });
    await page.waitForSelector(rowOf(b), { hidden: true });
    assert(!(await page.$(view('[data-testid="inbox-selbar"]'))), 'the bar goes with them');
    await undo();
    await page.waitForSelector(rowOf(a));
    await page.waitForSelector(rowOf(b));
    assert((await comment(promo, pq2.id)).status === 'open' && (await comment(promo, pq3.id)).status === 'open', 'nothing was sent');
    await page.focus(view('[data-testid="inbox-list"]'));
    await page.keyboard.down('Meta');
    await page.keyboard.press('a');
    await page.keyboard.up('Meta');
    const all = await page.$$eval(view('.inbox-row:not(.pending)'), (rs) => rs.length);
    await until(async () => (await page.$eval(view('.inbox-selbar-n'), (e) => e.textContent)) === `${all} selected`, '⌘A selects every row');
    await page.keyboard.press('Escape');
    await page.waitForSelector(view('[data-testid="inbox-selbar"]'), { hidden: true });
    // only fixes: Looks right for all of them
    const fixes = (await api('/api/for-you')).items.filter((i) => i.kind === 'verify' && i.slug === promo);
    await page.hover(rowOf(fixes[0].key));
    for (const f of fixes) await check_(f.key);
    await page.waitForSelector(view('[data-testid="inbox-sel-right"]'));
    await page.keyboard.press('Escape');
  });

  await check(
    'the selection’s bar never sits on the end of the list: the last row and the push prompt scroll clear of it (1440, 1024, 390; both themes)',
    async () => {
      const covered = [];
      // what is at a target's centre once the list is scrolled to its end: the target itself, or what covers it
      const clear = (p, targets) =>
        p.evaluate(
          (targets) =>
            targets.flatMap((sel) => {
              const el = [...document.querySelectorAll(sel)].at(-1);
              if (!el) return [`${sel}: not there`];
              const r = el.getBoundingClientRect();
              const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
              return el.contains(hit) ? [] : [`${sel} is under ${hit?.closest('[data-testid]')?.dataset.testid ?? hit?.className ?? 'nothing'}`];
            }),
          targets,
        );
      for (const theme of ['dark', 'light'])
        for (const width of [1440, 1024, 390]) {
          const ctx = await browser.createBrowserContext();
          const p = watch(await ctx.newPage());
          try {
            await p.evaluateOnNewDocument((theme) => {
              // (the first, blank document has no storage: not the page's error)
              try {
                localStorage.setItem('vr.theme', theme);
              } catch {}
              // a device that hasn't decided about notifications: the inbox view asks under its list
              if (typeof Notification !== 'undefined') Object.defineProperty(Notification, 'permission', { get: () => 'default' });
            }, theme);
            if (width === 390) await p.emulate(IPHONE);
            else await p.setViewport({ width, height: width === 1024 ? 768 : 900 });
            // the list's end in view first, then its last row picked: the bar comes while the end is on screen
            const toEnd = (sel) =>
              p.$eval(sel, (s) => {
                s.scrollTop = s.scrollHeight;
              });
            const frames = () => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
            let scroller;
            let targets;
            if (width === 1440) {
              // the inbox view: the list's column, its last row and the prompt's button under it
              await p.goto(`${BASE}/#/inbox`, { waitUntil: 'domcontentloaded' });
              await p.waitForSelector(view('.inbox-row:not(.pending)'), { timeout: 20000 });
              await p.waitForSelector(view('[data-testid="notify-card"] .btn:not(.icon-only)'), { timeout: 20000 });
              scroller = view('.inbox-view-list');
              targets = [view('.inbox-row:not(.pending)'), view('[data-testid="notify-card"] .btn:not(.icon-only)')];
              await toEnd(scroller);
              await frames();
              const last = (await p.$$(view('.inbox-row:not(.pending)'))).at(-1);
              await last.hover();
              await (await last.$('[data-testid="inbox-check"]')).click();
            } else {
              // the bell's popover (a tablet with a mouse) or sheet (a phone: Select is in a row's ⋯)
              await p.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
              await p.waitForSelector('[data-testid="inbox-bell"][aria-label^="Inbox, "]', { timeout: 20000 });
              if (width === 390) await p.tap('[data-testid="inbox-bell"]');
              else await p.click('[data-testid="inbox-bell"]');
              const rowSel = '[data-testid="inbox"] .inbox-row:not(.pending)';
              await p.waitForSelector(rowSel, { timeout: 15000 });
              scroller = '[data-testid="inbox"] .sa-viewport';
              targets = [rowSel];
              await toEnd(scroller);
              await frames();
              const last = (await p.$$(rowSel)).at(-1);
              if (width === 390) {
                await (await last.$('[data-testid="inbox-row-menu"]')).tap();
                await p.waitForSelector('.menu [role=menuitem]');
                await p.evaluate(() => [...document.querySelectorAll('.menu [role=menuitem]')].find((e) => e.textContent.trim() === 'Select')?.click());
              } else {
                await last.hover();
                await (await last.$('[data-testid="inbox-check"]')).click();
              }
            }
            await p.waitForSelector('[data-testid="inbox-selbar"]', { timeout: 10000 });
            await p.mouse.move(1, 1);
            await frames();
            // as the bar came, with the end in view: nothing that was in view went under it
            for (const c of await clear(p, targets)) covered.push(`${width} ${theme}, as the bar came: ${c}`);
            // scrolled to the end again: the room the bar keeps clears the last row and the prompt
            await toEnd(scroller);
            await frames();
            for (const c of await clear(p, targets)) covered.push(`${width} ${theme}, at the end: ${c}`);
            if (SHOTS && theme === 'light') await p.screenshot({ path: path.join(SHOTS, `10b-inbox-selbar-end-${width}.png`) });
          } finally {
            await ctx.close();
          }
        }
      assert(!covered.length, `covered by the bar at the list's end:\n${covered.join('\n')}`);
    },
  );

  await check('keys: X selects the keyboard’s row, H puts it aside, ⇧E clears the whole video, ? lists them', async () => {
    await clearToasts();
    const pq3 = (await api('/api/for-you')).items.find((i) => i.slug === promo && i.kind === 'question' && i.text === 'Shorter end card?');
    const key = pq3.key;
    await page.click(rowOf(key));
    await page.keyboard.press('x');
    await page.waitForFunction((s) => document.querySelector(s)?.classList.contains('checked'), {}, rowOf(key));
    await page.keyboard.press('x');
    await page.waitForFunction((s) => !document.querySelector(s)?.classList.contains('checked'), {}, rowOf(key));
    await page.click(rowOf(key));
    await page.keyboard.press('h');
    await page.waitForSelector(rowOf(key), { hidden: true });
    await until(async () => (await api('/api/for-you')).later?.some((i) => i.key === key), 'put aside');
    await api('/api/for-you/unsnooze', 'POST', { keys: [key] });
    await page.waitForSelector(rowOf(key), { timeout: 15000 });
    await page.keyboard.press('?');
    await page.waitForSelector('[data-testid="inbox-help"]');
    const help = await page.$eval('[data-testid="inbox-help"]', (e) => e.textContent);
    assert(
      ['E', '⇧E', 'H', 'X', '⌘A', 'Esc'].every((k) => help.includes(k)),
      `the keys are listed: ${help}`,
    );
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="inbox-help"]', { hidden: true });
    // the keys' list has its place in the header, beside By video · By kind (not floating under the list)
    const hint = await page.$eval('.hero-row [data-testid="inbox-keys"]', (b) => {
      const mode = document.querySelector('.hero-row .inbox-mode').getBoundingClientRect();
      const r = b.getBoundingClientRect();
      return { right: r.right, modeLeft: mode.left, mid: r.top + r.height / 2, modeMid: mode.top + mode.height / 2 };
    });
    assert(hint.right <= hint.modeLeft && Math.abs(hint.mid - hint.modeMid) < 2, `the keys sit beside the grouping switch: ${JSON.stringify(hint)}`);
    assert(!(await page.$(view('.inbox-foot [data-testid="inbox-keys"]'))), 'nothing about the keys under the list');
    await page.click('.hero-row [data-testid="inbox-keys"]');
    await page.waitForSelector('[data-testid="inbox-help"]');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="inbox-help"]', { hidden: true });
    const tip = await page.$eval(`${rowOf(key)} [data-testid="inbox-row-later"]`, (b) => b.getAttribute('aria-label'));
    assert(/Later/.test(tip), tip);
    // ⇧E: questions close, the reply is waved through; the fixes stay (they leave with a check)
    await page.click(rowOf(key));
    await page.keyboard.down('Shift');
    await page.keyboard.press('E');
    await page.keyboard.up('Shift');
    await page.waitForSelector(rowOf(`q:${pq2.id}`), { hidden: true });
    await clearToasts();
    await until(async () => (await comment(promo, pq2.id)).status === 'verified', 'both questions closed');
    const left = (await api('/api/for-you')).items.filter((i) => i.slug === promo).map((i) => i.kind);
    assert(left.every((k) => k === 'verify') && left.length, `only the fixes stay: ${left}`);
  });

  await check('the bell’s popover follows the grouping: a long video folds to its most urgent item and opens on a click', async () => {
    await clearToasts();
    const extra = [];
    for (const text of ['Swap the music?', 'Keep the outro?', 'Faster cut?']) extra.push(await note(promo, { frame: 12, text, by: 'agent:promo-cut' }));
    await page.click('[data-testid="inbox-bell"]');
    const grp = '[data-testid="inbox"] [data-testid="inbox-vgroup"][aria-label="promo.mp4"]';
    await page.waitForSelector(`${grp} [data-testid="inbox-vmore"]`, { timeout: 15000 });
    const rows = await page.$$eval(`${grp} .inbox-row`, (rs) => rs.map((r) => r.dataset.testid));
    assert(JSON.stringify(rows) === JSON.stringify(['inbox-row-question']), `folded to its most urgent item: ${rows}`);
    await sleep(300);
    await shot('11-inbox-popover-by-video');
    // One height for every row, words or none (a new version has none): the list doesn't step.
    const heights = await page.$$eval('[data-testid="inbox"] .inbox-row', (rs) =>
      rs.map((r) => ({ h: Math.round(r.getBoundingClientRect().height), words: !!r.querySelector('.inbox-row-text')?.textContent })),
    );
    assert(heights.some((r) => r.words) && heights.some((r) => !r.words), `rows with and without words: ${JSON.stringify(heights)}`);
    assert(new Set(heights.map((r) => r.h)).size === 1, `rows of one height: ${JSON.stringify(heights)}`);
    // Picking rows here: a ring on each picture, and the bar floats over the list's foot — in view however far the
    // list scrolls, a float's gap above its bottom edge, narrower than the list.
    await page.click('[data-testid="inbox"] .inbox-row [data-testid="inbox-check"]');
    await page.waitForSelector('[data-testid="inbox"] [data-testid="inbox-selbar"]');
    const foot = await page.$eval('[data-testid="inbox"] [data-testid="inbox-selbar"]', (bar) => {
      let s = bar.parentElement;
      while (s && !/(auto|scroll)/.test(getComputedStyle(s).overflowY)) s = s.parentElement;
      const b = bar.getBoundingClientRect();
      const narrower = !!s && b.width < s.clientWidth - 24;
      if (!s || s.scrollHeight <= s.clientHeight) return { gap: null, narrower };
      const r = s.getBoundingClientRect();
      return { gap: Math.round(r.top + s.clientTop + s.clientHeight - b.bottom), narrower };
    });
    assert(foot.narrower && (foot.gap === null || (foot.gap >= 0 && foot.gap <= 16)), `the bar floats in view over the list's foot: ${JSON.stringify(foot)}`);
    await sleep(200);
    await shot('11b-inbox-popover-picked');
    await page.click('[data-testid="inbox"] [aria-label="Clear the selection"]');
    await page.waitForSelector('[data-testid="inbox"] [data-testid="inbox-selbar"]', { hidden: true });
    await page.click(`${grp} [data-testid="inbox-vmore"]`);
    await until(async () => (await page.$$eval(`${grp} .inbox-row`, (rs) => rs.length)) >= 4, 'opened');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="inbox"]', { hidden: true });
    for (const c of extra) await api(`/api/comments/${c.id}`, 'PATCH', { status: 'verified', note: 'ok' });
  });

  await check('a long inbox by video renders the videos near the view only; the keys reach the last row', async () => {
    const bulk = [];
    for (let v = 0; v < 10; v++) {
      const slug = await add(makeVideo(path.join(dir, `Bulk/clip-${v}.mp4`), { w: 160, h: 90, fps: 25, dur: 1 }));
      bulk.push(slug);
      for (let k = 0; k < 13; k++) await note(slug, { frame: k, text: `Question ${v}.${k}?`, by: 'agent:bulk' });
    }
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/inbox`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(view('.inbox-groups[data-windowed] .inbox-row'), { timeout: 20000 });
    const total = (await api('/api/for-you')).items.length;
    const shown = await page.$$eval(view('.inbox-row'), (rs) => rs.length);
    assert(total > 120 && shown < total, `only the rows near the view: ${shown} of ${total}`);
    await page.focus(view('[data-testid="inbox-list"]'));
    for (let k = 1; k < total; k++) await page.keyboard.press('j');
    await page.waitForFunction(
      (n) => {
        const l = document.querySelector('[data-testid="inbox-view"] [data-testid="inbox-list"]');
        const r = document.getElementById(l.getAttribute('aria-activedescendant'));
        const b = r?.getBoundingClientRect();
        return r && Number(r.dataset.index) === n - 1 && b.top >= 0 && b.bottom <= innerHeight;
      },
      { timeout: 10000 },
      total,
    );
    for (const slug of bulk) await api(`/api/library/${encodeURIComponent(slug)}`, 'DELETE');
  });

  await check('inbox zero: “All caught up”, and when what was put aside comes back', async () => {
    const all = (await api('/api/for-you')).items.map((i) => i.key);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    await api('/api/for-you/snooze', 'POST', { keys: all, until: tomorrow.toISOString() });
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/inbox`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(view('[data-testid="inbox-empty"]'), { timeout: 20000 });
    const body = await page.$eval(view('[data-testid="inbox-empty"]'), (e) => e.textContent);
    assert(/All caught up/.test(body) && /put aside for later/.test(body) && /tomorrow at/.test(body), body);
    await page.waitForSelector('[data-testid="inbox-bell"][aria-label="Inbox"]');
    const tally = await page.$eval('[data-testid="inbox-tally"]', (e) => e.textContent);
    assert(/all caught up/.test(tally) && /\d+ later/.test(tally), `the tally: ${tally}`);
    await page.click(view('[data-testid="inbox-later-toggle"]'));
    await page.waitForSelector(view('[data-testid="inbox-later-row"]'));
    await sleep(300);
    await shot('12-inbox-zero-later');
    await api('/api/for-you/unsnooze', 'POST', { keys: all });
    // the promo video's last fix is checked, so the phone's checks below find their own items first
    await api(`/api/comments/${pf2.id}`, 'PATCH', { status: 'verified' });
    // the checks after these read the inbox by kind again
    await page.evaluate(() => localStorage.setItem('vr.inbox', JSON.stringify({ mode: 'kind' })));
  });

  // ---------------------------------------------------------------- phone
  const q2 = await note(film, { frame: 50, text: 'Keep the grade warmer?', by: 'agent:brand-film' });
  const phone = watch(await browser.newPage());
  await phone.emulate(IPHONE);
  const phoneShot = shotOf(phone);
  const prow = (kind) => `[data-testid="inbox"] [data-testid="inbox-row-${kind}"]`;

  await check('phone: the bell fits the bar and opens a sheet, with no scrolling behind it', async () => {
    await phone.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await phone.waitForSelector('[data-testid="inbox-bell"][aria-label^="Inbox, "]', { timeout: 20000 });
    const bar = await sideways(phone);
    assert(!bar.length, bar.join('\n'));
    // the count sits on the bell's shoulder, as on a desk, not on the corner of the finger's 44 px box (said at the end)
    const shoulder = await phone.$eval('[data-testid="inbox-bell"]', (b) => {
      const g = b.querySelector('svg').getBoundingClientRect();
      const c = b.querySelector('.inbox-count').getBoundingClientRect();
      return { dx: Math.round(c.left + c.width / 2 - g.right), dy: Math.round(c.top + c.height / 2 - g.top) };
    });
    await phone.tap('[data-testid="inbox-bell"]');
    await phone.waitForSelector('.inbox-sheet[role="dialog"]');
    await phone.waitForSelector(prow('question'));
    const locked = await phone.evaluate(() => getComputedStyle(document.body).overflow === 'hidden' || document.body.hasAttribute('data-scroll-locked'));
    assert(locked, 'the page behind the sheet does not scroll');
    await sleep(400);
    await phoneShot('03-inbox-phone-sheet');
    assert(Math.hypot(shoulder.dx, shoulder.dy) <= 8, `the count is ${JSON.stringify(shoulder)} px from the bell's top right corner`);
  });

  await check('phone: an item opens its preview in the sheet at the exact frame, the back arrow returns', async () => {
    await phone.tap(prow('question'));
    // asked on v2 itself: its own frame
    await presents(phone, filmFile, 50, 90);
    assert(!(await phone.$('[data-testid="inbox-list"]')), 'the preview takes the sheet');
    // thumb-sized: the transport's buttons and the timeline are 44 px tall; a tap on the timeline goes to that frame
    const small = await phone.$$eval('.inbox-sheet :is(.inbox-transport .btn, [data-testid="inbox-scrub"])', (els) =>
      els.filter((e) => e.getClientRects().length && e.getBoundingClientRect().height < 43.5).map((e) => e.getAttribute('aria-label') || e.className),
    );
    assert(!small.length, `44 px targets: ${small.join(', ')}`);
    const scrub = await phone.$eval('.inbox-sheet [data-testid="inbox-scrub"]', (e) => e.getBoundingClientRect().toJSON());
    await phone.touchscreen.tap(scrub.x + (20 / 89) * scrub.width, scrub.y + scrub.height / 2);
    await presents(phone, filmFile, 20, 90);
    await sleep(300);
    await phoneShot('04-inbox-phone-preview');
    await phone.tap('[aria-label="Back to the inbox"]');
    await phone.waitForSelector(prow('question'));
  });

  await check('phone: answering in the sheet sends it and goes back to the list without it', async () => {
    await phone.tap(prow('question'));
    await phone.waitForSelector('.inbox-act textarea');
    await phone.tap('.inbox-act textarea');
    await phone.type('.inbox-act textarea', 'Yes, warmer');
    await phone.tap('.inbox-act button[type="submit"]');
    await until(async () => (await comment(film, q2.id)).status === 'verified', 'answered');
    await phone.waitForSelector('[data-testid="inbox-list"], .inbox-empty');
    assert(!(await phone.$(prow('question'))), 'the question left the list');
  });

  await check('phone: a fix is checked in the sheet ("Looks right")', async () => {
    await api(`/api/comments/${laterFix.id}`, 'PATCH', { status: 'fixed', note: 'Ducked the end too', by: 'agent:brand-film', fixed_in_v: 2 });
    await phone.waitForSelector(prow('verify'), { timeout: 15000 });
    await phone.tap(prow('verify'));
    await presents(phone, filmFile, timeToFrame(60 / 25, 30), 90);
    await phone.waitForSelector('.inbox-act-row button');
    await phone.$$eval('.inbox-act-row button', (bs) => bs.find((b) => b.textContent.includes('Looks right'))?.click());
    await until(async () => (await comment(film, laterFix.id)).status === 'verified', 'fix verified');
    await phone.tap('[aria-label="Close the inbox"]');
    await phone.waitForSelector('.inbox-sheet', { hidden: true });
    assert((await phone.evaluate(() => location.hash)) === '#/', 'still on the library');
  });

  await check('phone: the drawer has the Inbox item; the view shows the cards, tapping one opens it', async () => {
    const q5 = await note(spot, { frame: 10, text: 'Keep the first shot?', by: 'agent:promo-edit' });
    await phone.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await phone.waitForSelector('.topbar .nav-toggle', { timeout: 20000 });
    await phone.tap('.topbar .nav-toggle');
    await phone.waitForSelector('[role="dialog"] [data-testid="nav-inbox"]');
    // The drawer slides in from the edge (tapped right after the page painted, it opens a moment later, once the
    // dialogs' code is here): tap its item once it is in place, as a finger would.
    await phone.waitForFunction(() => {
      const d = document.querySelector('.drawer');
      return !!d && d.getBoundingClientRect().left >= 0 && d.getAnimations().every((a) => !a.pending && a.playState !== 'running');
    });
    await phone.tap('[role="dialog"] [data-testid="nav-inbox"]');
    await phone.waitForFunction(() => location.hash === '#/inbox', { timeout: 5000 });
    await phone.waitForSelector('[data-testid="inbox-view"].cards [data-testid="fy-question"]', { timeout: 15000 });
    assert(!(await phone.$('[data-testid="inbox-view-preview"]')), 'no preview pane on a phone');
    const bar = await sideways(phone);
    assert(!bar.length, bar.join('\n'));
    await sleep(400);
    await phoneShot('05-inbox-view-phone');
    await phone.tap('[data-testid="fy-question"] .fy-thumb');
    await phone.waitForFunction((id) => location.hash.includes(`c=${id}`), { timeout: 5000 }, q5.id);
    await api(`/api/comments/${q5.id}`, 'PATCH', { status: 'verified', note: 'Yes' });
  });

  await check('nothing waiting: the view says so with its empty state, the sidebar and the bell count nothing', async () => {
    // work leaves only when it's done (answered, checked, a verdict given); what informs is waved through with "Got it"
    for (let round = 0; round < 4; round++) {
      const { items } = await api('/api/for-you');
      if (!items.length) break;
      for (const i of items)
        if (i.kind === 'question' || i.kind === 'verify') await api(`/api/comments/${i.id}`, 'PATCH', { status: 'verified', note: 'Done' });
        else if (i.kind === 'review') await api(`/api/review/${encodeURIComponent(i.slug)}/approval`, 'PUT', { status: 'approved', v: i.v });
      const rest = (await api('/api/for-you')).items.filter((i) => i.dismissible);
      if (rest.length) await api('/api/for-you/dismiss', 'POST', { keys: rest.map((i) => i.key) });
    }
    assert(!(await api('/api/for-you')).items.length, `nothing waits: ${JSON.stringify((await api('/api/for-you')).items.map((i) => i.kind))}`);
    for (const [p, ss, name] of [
      [page, shot, '06-inbox-view-empty-desktop'],
      [phone, phoneShot, '06-inbox-view-empty-phone'],
    ]) {
      await p.goto('about:blank');
      await p.goto(`${BASE}/#/inbox`, { waitUntil: 'domcontentloaded' });
      await p.waitForSelector('[data-testid="inbox-view"] [data-testid="inbox-empty"]', { timeout: 20000 });
      const title = await p.$eval('[data-testid="inbox-empty"] .empty-title', (e) => [e.tagName, e.textContent]);
      assert(title[0] === 'H2' && title[1] === 'All caught up', `empty state ${title}`);
      assert(!(await p.$('[data-testid="inbox-view"] :is(.inbox-row, .fy-item)')), 'no rows or cards');
      await p.waitForSelector('[data-testid="inbox-tally"]');
      assert((await p.$eval('[data-testid="inbox-tally"]', (e) => e.textContent)) === 'all caught up', 'the tally says so');
      await p.waitForSelector('[data-testid="inbox-bell"][aria-label="Inbox"]');
      await sleep(300);
      await ss(name);
    }
    await page.waitForSelector('[data-testid="nav-inbox"] .nav-count');
    assert((await page.$eval('[data-testid="nav-inbox"] .nav-count', (e) => e.textContent)) === '0', 'the sidebar counts 0');
  });

  // A deploy restarts the server behind its proxy: the open tab's stream is refused (an error status), and a browser
  // never tries a refused stream again. The tab went deaf: a fix checked meanwhile — in another tab, here over the API —
  // stayed in its inbox until a reload. (Its own browser, so the refusals it provokes stay out of the console check.)
  await check('a live stream refused (a deploy) opens again by itself, and what changed meanwhile shows', async () => {
    // a browser of its own: in this one the suite's page holds the one stream every tab shares
    const own = await browser.createBrowserContext();
    const p = await own.newPage();
    await p.setViewport({ width: 1440, height: 900 });
    // the page's streams, to end one as the browser does after a refusal
    await p.evaluateOnNewDocument(() => {
      const Real = window.EventSource;
      window.__streams = [];
      window.EventSource = class extends Real {
        constructor(...args) {
          super(...args);
          window.__streams.push(this);
        }
      };
    });
    const c = await note(spot, { frame: 12, text: 'Grade the sky a touch cooler', severity: 'should' });
    await api(`/api/comments/${c.id}`, 'PATCH', { status: 'fixed', note: 'cooler', by: 'agent:spot-edit' });
    await p.goto(`${BASE}/#/inbox`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector(VIEW_READY, { timeout: 20000 });
    const listed = () => p.evaluate((text) => !!document.querySelector('[data-testid="inbox-view"]')?.textContent.includes(text), c.text);
    await until(listed, 'the fix to check is listed');
    await p.waitForFunction(() => window.__streams.at(-1)?.readyState === 1, { timeout: 10000 });
    let refused = 0;
    const refuse = (req) => {
      if (!req.url().includes('/api/events')) return req.continue().catch(() => {});
      refused++;
      req.respond({ status: 502, contentType: 'text/plain', body: 'restarting' }).catch(() => {});
    };
    await p.setRequestInterception(true);
    p.on('request', refuse);
    try {
      // the server goes away: the stream ends for good, as after a refusal; its next try is refused too
      await p.evaluate(() => {
        const s = window.__streams.at(-1);
        s.close();
        s.onerror?.(new Event('error'));
      });
      await until(() => refused > 0, 'the stream tries again (and is refused: the server is still starting)');
    } finally {
      p.off('request', refuse);
      await p.setRequestInterception(false);
    }
    // meanwhile the fix is checked elsewhere: no event reaches this tab
    await api(`/api/comments/${c.id}`, 'PATCH', { status: 'verified' });
    await until(async () => !(await listed()), 'the inbox catches up without a reload', 20000);
    await own.close();
  });

  await check('no errors in the browser console', async () => {
    assert(!errors.length, errors.join('\n'));
  });
} catch (e) {
  crashed(e, srv);
} finally {
  await finish(LABEL, { browser, servers: [srv] });
}
