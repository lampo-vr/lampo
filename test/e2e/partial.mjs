#!/usr/bin/env node
// covers: web/src/player/VersionPicker.tsx web/src/player/partWords.ts web/src/player/Timeline.tsx
// covers: web/src/player/Composer.tsx lib/part.ts lib/parts.ts lib/splice.ts lib/cuts.ts
// Browser end-to-end test of partial renders (lib/part.ts): a real server (local mode, temp store, free port) +
// headless Chrome. The person allows a part in the composer's where-menu (the stretch snapped to the render's shots);
// the agent pushes only that stretch with `vr push --part-at`. A part whose seam jumps says so in the version picker
// and lights its frame on the timeline; a clean one plays as the whole video — every frame at and around both seams is
// ffmpeg's frame of the base or the part, stepping and playing; check mode works on it; it can't be final; the full
// render that follows is compared with what was approved. Screenshots land in VR_SHOTS when it is set.
import fs from 'node:fs';
import path from 'node:path';
import { age, cutFrames, fixBox, makeShotsVideo, sleep, until, vr } from '../lib/helpers.ts';
import { bentEdges, clippedText, sideways } from './layout.mjs';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { closestFrame, playedThrough, recordedFrames, recordFrames, shownPicture } from './lib/frames.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'partial e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-partial-e2e-', user: 'Sam' });
const { dir, base: BASE } = srv;
// the agent's `vr`, on the same store (never a `vr login` of this machine)
const agentEnv = { ...srv.env, VR_REMOTE: '0', VR_BY: 'agent:promo-edit', XDG_CONFIG_HOME: path.join(dir, 'xdg'), XDG_CACHE_HOME: path.join(dir, 'xdg-cache') };
const agent = (...args) => {
  const r = vr(args, agentEnv);
  if (r.code !== 0) throw new Error(`vr ${args.join(' ')}: ${r.err || r.out}`);
  return r.out;
};

const api = jsonApi(BASE);

const N = 120;
// Three shots (0–39, 40–79, 80–119); the fix is a white square in the second one.
const video = makeShotsVideo(path.join(dir, 'Spot/export/shots.mp4'));
age(video);
const fixed = makeShotsVideo(path.join(dir, 'renders/fixed.mp4'), { extra: fixBox(40, 79) });
const spill = makeShotsVideo(path.join(dir, 'renders/spill.mp4'), { extra: fixBox(30, 79) });
const parts = path.join(dir, 'renders/parts');

let browser;
let page;
screenshotFailures(() => page, 'partial');
try {
  const { video: summary } = await api('/api/library', 'POST', { path: video });
  const slug = summary.slug;
  const enc = encodeURIComponent;
  const review = async () => (await api(`/api/review/${enc(slug)}`)).review;

  browser = await launch();
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: SHOTS ? 2 : 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));
  const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => null);
  const videoReady = () =>
    page.waitForFunction(
      () => {
        const v = document.querySelector('.vbox video');
        return v && v.readyState >= 2 && !v.seeking;
      },
      { polling: 100, timeout: 30000 },
    );
  const openPlayer = async (frame, extra = '') => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${enc(slug)}${frame !== undefined ? `?f=${frame}${extra}` : ''}`, { waitUntil: 'domcontentloaded' });
    await videoReady();
    await page.waitForSelector('.timeline canvas');
    await sleep(300);
  };
  const shownFrame = () => page.$eval('.tc .sub b', (e) => Number(e.textContent));
  const menuItem = (label) =>
    page.evaluateHandle(
      (label) => [...document.querySelectorAll('.menu[data-state=open] [role^=menuitem]')].find((e) => e.textContent.trim().startsWith(label)) || null,
      label,
    );

  // Frame f of the whole video: the base outside the stretch, the part's file (f − 40 + 12 handles) inside it. The
  // picture must be that frame — closer to it than to the frames around it in the same file.
  let partFile = '';
  const sourceOf = (f) => (f >= 40 && f < 80 ? [partFile, f - 40 + 12, 64] : [video, f, N]);
  const assertFrame = async (f, why) => {
    const [file, n, len] = sourceOf(f);
    // The picture on screen, small and grey, against ffmpeg's decode of the frames around it in that file. A busy machine
    // can present the frame a moment after the seek has ended (and the player heals a stale one by itself): only a wrong
    // picture is looked at again, for up to 5 s.
    const right = (b) => b.k === n && b.e < 6;
    let best = closestFrame(file, await shownPicture(page), n, len);
    for (const t = Date.now(); !right(best) && Date.now() - t < 5000; best = closestFrame(file, await shownPicture(page), n, len)) await sleep(200);
    assert(right(best), `${why}: frame ${f} should be f${n} of ${path.basename(file)} (${best.line})`);
  };

  console.log(`partial e2e against ${BASE} (store ${dir})`);
  let noteId = '';

  await check('the where-menu offers a quick check of only this shot; the note carries it to agents', async () => {
    await openPlayer(50);
    await page.keyboard.press('c');
    await page.waitForSelector('.composer textarea');
    await page.type('.composer textarea', 'The logo is missing in this shot');
    await page.click('.composer [data-testid=composer-where]');
    await page.waitForSelector('.menu[data-state=open] [role^=menuitem]');
    // the shots are found once the menu asks; meanwhile the item says so and can't be picked
    await until(async () => (await menuItem('Quick check: render only this part (00:01–00:03)')).asElement(), 'the suggested stretch: shot 2, 00:01–00:03');
    await shot('partial-01-where-menu');
    await (await menuItem('Quick check: render only this part (00:01–00:03)')).asElement().click();
    await page.waitForFunction(() => !document.querySelector('.menu[data-state=open]'), { polling: 50, timeout: 3000 });
    await page.waitForSelector('.composer [data-testid=composer-part]');
    await shot('partial-02-composer');
    // the menu hands the focus back to the text as it closes; ⌘↵ from there
    await page.focus('.composer textarea');
    await page.keyboard.down('Meta');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Meta');
    await page.waitForFunction(() => !document.querySelector('.composer'), { polling: 100, timeout: 20000 });
    const c = (await review()).comments.find((x) => x.text === 'The logo is missing in this shot');
    assert(c, 'the note reached the store');
    assert(JSON.stringify(c.part) === JSON.stringify({ in: 40, out: 79, shot: 2, to_shot: 2, handles: 12 }), `part ${JSON.stringify(c.part)}`);
    noteId = c.id;
    assert(agent('open', 'shots.mp4').includes('PART RENDER OK: frames 40–79 (shot 2), handles 12'), 'vr open says a part is fine');
  });

  await check('the agent menu asks for a quick check of the shot on screen: one request with its PART RENDER OK line', async () => {
    await api(`/api/review/${enc(slug)}/session`, 'PUT', { name: 'promo-edit' });
    await openPlayer(100);
    await page.click('[data-testid=agent-button]');
    await page.waitForSelector('[data-testid=quick-part]');
    await until(async () => !(await page.$eval('[data-testid=quick-part]', (e) => e.disabled)), 'the stretch is known');
    const row = await text('[data-testid=quick-part]');
    const sub = await text('[data-testid=quick-part] .grow > span');
    assert(row.startsWith('Quick check: render only this part'), `the row: ${row}`);
    assert(sub === '00:03–00:04 · the shot around 00:04:00, the rest stays as V1', `what it would render: ${sub}`);
    await shot('partial-01b-agent-menu');
    await page.click('[data-testid=quick-part]');
    // the agent isn't running: send without starting it
    await page
      .waitForFunction(() => [...document.querySelectorAll('.am button')].some((b) => b.textContent.includes('Only send')), { timeout: 2000 })
      .then(() => page.$$eval('.am button', (bs) => bs.find((b) => b.textContent.includes('Only send'))?.click()))
      .catch(() => {});
    const events = path.join(dir, 'data', 'events.jsonl');
    const request = async () =>
      fs
        .readFileSync(events, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
        .findLast((e) => e.type === 'request');
    await until(async () => !!(await request()), 'the request was sent');
    const e = await request();
    assert(e.text.endsWith(' · PART RENDER OK: frames 80–119 (shot 3), handles 12'), `request: ${e.text}`);
    await api(`/api/review/${enc(slug)}/session`, 'PUT', {});
  });

  await check('a part whose seam jumps: the picker says so plainly, the timeline lights the frame', async () => {
    const out = agent('push', cutFrames(spill, 28, 92, path.join(parts, 'spill.mp4')), '--to', 'shots.mp4', '--part-at', '40');
    assert(/v2, a part: frames 40–79 of v1\) · the motion doesn't match at 00:01:15 \(f40\)/.test(out), out);
    await until(async () => (await api(`/api/review/${enc(slug)}`)).media[2]?.ready, 'V2 plays as the whole video');
    await openPlayer(45);
    const picker = `${await text('.vpick-v')} ${await text('[data-testid=version-part]')}`;
    assert(picker === 'V2 · part (00:01–00:03)', `the picker: "${picker}"`);
    assert(await page.$('[data-testid=version-part].jumps'), 'the picker word reads as needing attention');
    const tl = await page.$eval('.timeline', (e) => ({ part: e.dataset.part, seam: e.dataset.seam }));
    assert(tl.part === '40-79' && tl.seam === 'jump:40', `timeline ${JSON.stringify(tl)}`);
    await page.click('[data-testid=version-picker]');
    await page.waitForSelector('.vpick-list');
    const said = await page.$$eval('[data-testid=version-said]', (els) => els.map((e) => e.textContent));
    assert(said.includes('The motion doesn’t match at 00:01:15 — render the next shot too, or the whole video'), `said: ${said.join(' | ')}`);
    await shot('partial-03-seam-jumps');
    await page.keyboard.press('Escape');
  });

  await check('a clean part plays as the whole video: frame-exact at and around both seams, stepping and playing', async () => {
    partFile = cutFrames(fixed, 28, 92, path.join(parts, 'fixed.mp4'));
    const out = agent('push', partFile, '--to', 'shots.mp4', '--part-at', '40', '--handles', '12');
    assert(/v3, a part: frames 40–79 of v2\) · seams clean/.test(out), out);
    await until(async () => (await api(`/api/review/${enc(slug)}`)).media[3]?.ready, 'V3 plays as the whole video');
    await openPlayer(37);
    assert((await text('.vpick-v')) === 'V3' && (await text('[data-testid=version-part]')) === '· part (00:01–00:03)', 'V3 is the part on screen');
    assert((await page.$eval('.timeline', (e) => e.dataset.seam)) === 'clean', 'clean seams: nothing lit');
    await shot('partial-04-clean-part');
    // step across the first seam and on, then across the second
    for (const target of [37, 38, 39, 40, 41]) {
      await until(async () => (await shownFrame()) === target, `on f${target}`);
      await videoReady();
      await assertFrame(target, 'stepping');
      if (target < 41) await page.keyboard.press('ArrowRight');
    }
    await openPlayer(77);
    for (const target of [77, 78, 79, 80, 81, 82]) {
      await until(async () => (await shownFrame()) === target, `on f${target}`);
      await videoReady();
      await assertFrame(target, 'stepping');
      if (target < 82) await page.keyboard.press('ArrowRight');
    }
    // playing through both seams: every frame is presented once, in order, and where it pauses is ffmpeg's frame. Counted
    // by presentedFrames, not by the frames the callback reported: a busy main thread reports only the newest frame of
    // each of its rendering steps, so a seam frame can be shown and never reported.
    await openPlayer(30);
    await recordFrames(page, 25);
    await page.keyboard.press(' ');
    await until(async () => (await recordedFrames(page)).some((x) => x.f >= 86), 'played past the second seam', 15000);
    await page.keyboard.press(' ');
    await page.waitForFunction(() => document.querySelector('.vbox video').paused, { timeout: 5000 });
    await videoReady();
    await sleep(300);
    const played = playedThrough(await recordedFrames(page), 38, 81);
    assert(!played.length, `playing across both seams (f39–f40, f79–f80): ${played.join('; ')}`);
    await assertFrame(await shownFrame(), 'paused after playing');
  });

  await check('a part on every width: the picker, the timeline mark and the layout rules at 1920, 1024, 768 and 390', async () => {
    for (const [w, h, touch] of [
      [1920, 1080, false],
      [1024, 768, false],
      [768, 1024, true],
      [390, 844, true],
    ]) {
      await page.setViewport({ width: w, height: h, deviceScaleFactor: SHOTS ? 2 : 1, isMobile: touch, hasTouch: touch });
      await openPlayer(50);
      assert((await text('.vpick-v')) === 'V3', `${w}: V3 on screen`);
      assert((await text('[data-testid=version-part]'))?.startsWith('· part'), `${w}: the picker says part`);
      assert((await page.$eval('.timeline', (e) => e.dataset.part)) === '40-79', `${w}: the timeline marks the stretch`);
      const bad = [...(await sideways(page)), ...(await clippedText(page)), ...(await bentEdges(page))];
      assert(!bad.length, `${w}: ${bad.join('\n')}`);
      if (w === 390 || w === 1024) await shot(`partial-04b-part-${w}`);
    }
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: SHOTS ? 2 : 1 });
  });

  await check('check mode works on a part: the fix is checked on it', async () => {
    agent('fix', noteId, '--v', '3', '--note', 'Logo in, rendered as a part');
    await openPlayer(50, `&verify=${noteId}`);
    await page.waitForSelector('.verify');
    await shot('partial-05-check-mode');
    await page.$$eval('.verify button', (bs) => bs.find((b) => b.textContent.includes('Looks right'))?.click());
    await until(async () => (await review()).comments.find((c) => c.id === noteId)?.status === 'verified', 'the fix is checked');
  });

  await check('a part can’t be final: the server refuses it, the menu says why', async () => {
    await api(`/api/review/${enc(slug)}/approval`, 'PUT', { status: 'approved' });
    let refused = null;
    await api(`/api/review/${enc(slug)}/final`, 'PUT', { confirm: true }).catch((e) => (refused = e));
    assert(refused?.status === 409 && /V3 is a part .*only a full render can be final/.test(refused.message), `final: ${refused?.message}`);
    await openPlayer(50);
    // the sign-off's chevron: everything besides the next step
    await page.click('[data-testid=stage-more]');
    await page.waitForSelector('.menu[data-state=open]');
    const item = (await menuItem('Final needs a full version: V3 is a part')).asElement();
    assert(item, 'the menu says a part needs a full render');
    assert((await item.evaluate((e) => e.getAttribute('aria-disabled') ?? e.getAttribute('data-disabled'))) !== null, 'and it can’t be picked');
    await shot('partial-06-final-refused');
    await page.keyboard.press('Escape');
  });

  await check('the full render that follows is compared with the approved part: it matches', async () => {
    // the agent renders the whole video to its path; the app registers it as V4
    fs.copyFileSync(fixed, video);
    age(video);
    await api(`/api/review/${enc(slug)}/sync`, 'POST');
    await until(async () => (await review()).versions.find((v) => v.v === 3)?.part?.confirmed?.v === 4, 'V3 confirmed by V4', 60000);
    await openPlayer(50);
    assert((await text('[data-testid=version-picker]')) === 'V4', 'V4 is a full render');
    await page.click('[data-testid=version-picker]');
    await page.waitForSelector('.vpick-list');
    const said = await page.$$eval('[data-testid=version-said]', (els) => els.map((e) => e.textContent));
    assert(said.includes('The full version matches what you approved in V3'), `said: ${said.join(' | ')}`);
    assert(said.includes('V4 matches what you approved here'), 'and on the part');
    // V2's seam jumped and nobody approved it: nothing to answer for, and the checked note stays checked
    assert(!said.some((x) => x.includes('differs')), `nothing differs: ${said.join(' | ')}`);
    assert((await review()).comments.find((c) => c.id === noteId)?.status === 'verified', 'the note stays checked');
    await shot('partial-07-full-matches');
    await page.keyboard.press('Escape');
    assert(!errors.length, `page errors: ${errors.join(' | ')}`);
  });

  await check('in German: the picker says Teil and what the full render found', async () => {
    const de = await browser.newPage();
    await de.evaluateOnNewDocument(() => localStorage.setItem('vr.lang', 'de'));
    await de.setViewport({ width: 1280, height: 800, deviceScaleFactor: SHOTS ? 2 : 1 });
    await de.goto(`${BASE}/#/v/${enc(slug)}?f=50`, { waitUntil: 'domcontentloaded' });
    await de.waitForSelector('[data-testid=version-picker]');
    await de.click('[data-testid=version-picker]');
    await de.waitForSelector('.vpick-list');
    const said = await de.$$eval('[data-testid=version-said], [data-testid=version-part-tag]', (els) => els.map((e) => e.textContent));
    for (const want of [
      'Die komplette Version stimmt mit dem überein, was du in V3 freigegeben hast',
      'Teil (00:01–00:03)',
      'Die Übergänge passen zur Version davor',
      'Bei 00:01:15 passt die Bewegung nicht — rendere die nächste Einstellung mit oder das ganze Video',
    ])
      assert(said.includes(want), `"${want}" in ${said.join(' | ')}`);
    if (SHOTS) await de.screenshot({ path: path.join(SHOTS, 'partial-08-german.png') });
    await de.close();
  });
} catch (e) {
  crashed(e, srv);
}
await finish(LABEL, { browser, servers: [srv] });
