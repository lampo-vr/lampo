#!/usr/bin/env node
// covers: lib/handover.ts web/src/player/NotesPanel.tsx web/src/player/CommentCard.tsx web/src/player/fixCheck.ts
// covers: web/src/sessions/runWords.ts
// Browser suite of what a person is asked to check once fixes belong to the version that carries them (local mode,
// temp store, headless Chrome). V2 is up with one note the agent fixed in it, two it didn't touch, its own question and
// a fix it marked before its next version: "1 fix to check" says the two still open beside it, check mode walks the one
// fix only, an untouched note stays plain Open with a quiet "V2 changed here" where the version's diff saw a change, the
// early fix reads "Fixed · waiting for V3", and a note an older store carried over still reads "Check again" and is
// still asked about. Every row fits 390–1920. Screenshots (VR_SHOTS).
import fs from 'node:fs';
import path from 'node:path';
import { age, makeVideo, until } from '../lib/helpers.ts';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';
import { writeJsonAtomic } from './lib/sharedJson.ts';

const LABEL = 'loop-fixes e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-loop-fixes-e2e-', user: 'Sam' });
const { dir, base: BASE } = srv;
const api = jsonApi(BASE);
const enc = encodeURIComponent;

let browser;
let page;
try {
  // spot.mp4: V1 with the notes, V2 the agent's re-render (another picture everywhere: its diff sees every note's spot)
  const file = makeVideo(path.join(dir, 'Acme/export/spot.mp4'), { w: 320, h: 180, fps: 25, dur: 4 });
  age(file);
  const { video } = await api('/api/library', 'POST', { path: file, folder: 'Acme' });
  const slug = video.slug;
  const add = (frame, text, more = {}) => api(`/api/review/${enc(slug)}/comments`, 'POST', { v: 1, frame, text, severity: 'should', ...more });
  const fixed = await add(10, 'Title too small');
  const untouched = await add(30, 'Logo a touch later');
  const other = await add(50, 'Music softer under the claim');
  const question = await add(70, 'Website or app badge on the end card?', { by: 'agent:promo-edit' });
  makeVideo(file, { w: 320, h: 180, fps: 25, dur: 4, pattern: 'testsrc2' });
  age(file);
  await api(`/api/review/${enc(slug)}/sync`, 'POST', {});
  await api(`/api/comments/${fixed.id}`, 'PATCH', { status: 'fixed', note: 'Title 20 % larger', by: 'agent:promo-edit' });
  // written on V2, marked fixed before the version that has it
  const early = await api(`/api/review/${enc(slug)}/comments`, 'POST', { v: 2, frame: 85, text: 'Hold the end card longer', severity: 'should' });
  await api(`/api/comments/${early.id}`, 'PATCH', { status: 'fixed', note: 'End card held 1 s longer', by: 'agent:promo-edit' });
  const review = async (s = slug) => (await api(`/api/review/${enc(s)}`)).review;
  const stored = (await review()).comments;
  assert(stored.find((c) => c.id === early.id)?.fix_pending === true, 'the early fix rides with V3');

  // cut.mp4: a store from before fixes were tied to versions — V2 carried its open note "to check again"
  const old = makeVideo(path.join(dir, 'Acme/export/cut.mp4'), { w: 320, h: 180, fps: 25, dur: 4 });
  age(old);
  const cut = (await api('/api/library', 'POST', { path: old, folder: 'Acme' })).video.slug;
  const carried = await api(`/api/review/${enc(cut)}/comments`, 'POST', { v: 1, frame: 20, text: 'Grade the sky warmer', severity: 'should' });
  makeVideo(old, { w: 320, h: 180, fps: 25, dur: 4, pattern: 'testsrc2' });
  age(old);
  await api(`/api/review/${enc(cut)}/sync`, 'POST', {});
  const oldFile = path.join(dir, 'data', cut, 'review.json');
  const json = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
  Object.assign(
    json.comments.find((c) => c.id === carried.id),
    { check_again: true, carried_to: 2 },
  );
  writeJsonAtomic(oldFile, json);
  await until(async () => (await review(cut)).comments.find((c) => c.id === carried.id)?.check_again === true, 'the store is read again');

  browser = await launch();
  page = await browser.newPage();
  screenshotFailures(() => page, 'loop-fixes');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `loop-fixes-${name}.png`) });
  const text = (sel) => page.$eval(sel, (e) => e.textContent.trim()).catch(() => null);
  const open = async (s = slug, hash = '') => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${enc(s)}${hash}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.side-scroll .note');
  };
  const row = (id) => `.side-scroll [data-note="${id}"]`;
  const state = (id) => text(`${row(id)} .nr-state`);

  await check('one fix to check: the note the agent marked fixed in V2, with the two it left open said beside it', async () => {
    await page.setViewport({ width: 1440, height: 900 });
    await open();
    await page.waitForSelector('[data-testid=verify-cta]');
    const cta = (await text('[data-testid=verify-cta]')) || '';
    assert(/1 fix to check/.test(cta), `one fix, not every open note: ${cta}`);
    assert(/before and after, on V2 · 2 notes still open/.test(cta), `the work still with the agent: ${cta}`);
    assert((await state(fixed.id)) === 'Fixed', `the fix: ${await state(fixed.id)}`);
    for (const id of [untouched.id, other.id]) assert((await state(id)) === null, `an untouched note is plain Open: ${await state(id)}`);
    assert((await state(question.id)) === 'Question', 'the question asks, it is no fix');
  });

  await check('a fix marked before its version reads "Fixed · waiting for V3" and is not asked about', async () => {
    assert((await state(early.id)) === 'Fixed · waiting for V3', `the early fix: ${await state(early.id)}`);
    await page.click('[data-testid=verify-cta] button');
    await page.waitForSelector('.verify');
    const head = (await text('[data-testid=verify-step]')) || '';
    assert(head === 'Check 1 of 1', `check mode walks the one fix: ${head}`);
    assert(/Title too small/.test((await text('.verify')) || ''), 'on the fix the agent marked');
    assert(/fixed in V2/.test((await text('[data-testid=verify-fix]')) || ''), 'in the version its note records');
    await page.keyboard.press('Escape');
    await until(async () => !(await page.$('.verify')), 'check mode closed');
  });

  await check('an untouched note where V2 changed says so, quietly', async () => {
    // the version's diff is worked out in the background: the page asks for it again as it opens
    await until(
      async () => {
        await open();
        return page
          .waitForSelector(`${row(untouched.id)} [data-testid=note-changed]`, { timeout: 5000 })
          .then(() => true)
          .catch(() => false);
      },
      'the diff arrived',
      120_000,
    );
    assert((await text(`${row(untouched.id)} [data-testid=note-changed]`)) === 'V2 changed here', 'the hint');
    assert(!(await page.$(`${row(fixed.id)} [data-testid=note-changed]`)), 'a fix says where it stands instead');
    await shot('1440-light');
  });

  await check('every row fits, 390 to 1920', async () => {
    for (const width of [390, 768, 1024, 1440, 1920]) {
      await page.setViewport({ width, height: 900 });
      await open();
      // a phone's notes are a sheet: opened halfway, as a thumb does
      if (await page.$('.nsheet-handle')) {
        await page.click('.nsheet-handle');
        await page.waitForSelector('.nsheet-half');
      }
      await page.waitForSelector(`${row(untouched.id)} [data-testid=note-changed]`, { visible: true, timeout: 30_000 });
      const over = await page.$$eval('.side-scroll .note-row .nr, [data-testid=verify-cta]', (els) =>
        els
          .filter((r) => r.getBoundingClientRect().width > 0)
          .filter((r) => r.scrollWidth > r.clientWidth + 1 || r.getBoundingClientRect().right > window.innerWidth + 1)
          .map((r) => r.textContent),
      );
      assert(!over.length, `${width}: rows overflow: ${over.join(' | ')}`);
      if (width === 390 || width === 768) await shot(`${width}-light`);
    }
  });

  await check('a note an older store carried over still reads "Check again" and is still asked about', async () => {
    await page.setViewport({ width: 1440, height: 900 });
    await open(cut);
    assert((await state(carried.id)) === 'Check again', `the carried note: ${await state(carried.id)}`);
    await page.waitForSelector('[data-testid=verify-cta]');
    assert(/1 fix to check/.test((await text('[data-testid=verify-cta]')) || ''), 'counted as before');
  });

  await check('no page errors along the way', async () => {
    assert(!errors.length, errors.join(' | '));
  });
} catch (e) {
  crashed(e, srv);
} finally {
  await finish(LABEL, { browser, servers: [srv] });
}
