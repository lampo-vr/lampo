#!/usr/bin/env node
// covers: web/src/guest/GuestCompare.tsx web/src/guest/GuestPlayer.tsx web/src/guest/Guest.tsx web/src/player/CompareBar.tsx web/src/player/Stage.tsx web/src/player/usePlayback.ts web/src/lib/seek.ts web/src/styles/guest.css server/routes/shares/guest.ts
// Browser end-to-end test of compare on a review link: a real server (local mode, temp store, free port) + headless
// Chrome as the visitor. Compare is there only where the link shows every version and the video has two; side by side
// shows the version on screen (A) and the other one (B, "reference") on the same frame after a step, a play and a pause
// and a click on the timeline — each picture ffmpeg's decode of its own version's frame —; the wipe's handle moves the
// cut (each side's name cut with it); swap puts B on screen at the same frame; Esc and B leave; entering and leaving
// moves nothing outside the stage. A newest-only link has no Compare and requests no other version's media, and the link
// that has it asks for B's only once Compare is opened. On a phone the two landscape pictures stand one above the other,
// the compare row fits with 44 px tap areas (fitsAt), and in German. Screenshots land in VR_SHOTS when it is set.
import fs from 'node:fs';
import path from 'node:path';
import { age, makeShotsVideo, makeVideo, sleep, until } from '../lib/helpers.ts';
import { fitsAt, settle } from './layout.mjs';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { closestFrame, ffFrame, mae, SH, SW } from './lib/frames.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'guest-compare e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-guest-compare-e2e-', user: 'Sam' });
const { dir, base: BASE } = srv;
const api = jsonApi(BASE);

const N = 120; // makeShotsVideo: 25 fps, 4.8 s; testsrc2 moves on every frame, so a picture names its frame
const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

let browser;
let page;
screenshotFailures(() => page, 'guest-compare');
try {
  // Two versions of one video that differ on every frame (V2 is V1's negative), each kept as its own file for ffmpeg.
  const v1 = makeShotsVideo(path.join(dir, 'renders/v1.mp4'));
  const v2 = makeShotsVideo(path.join(dir, 'renders/v2.mp4'), { extra: 'negate' });
  const film = path.join(dir, 'Spot/export/film.mp4');
  fs.mkdirSync(path.dirname(film), { recursive: true });
  fs.copyFileSync(v1, film);
  age(film);
  const { video } = await api('/api/library', 'POST', { path: film });
  const slug = encodeURIComponent(video.slug);
  fs.copyFileSync(v2, film);
  age(film);
  await api(`/api/review/${slug}/sync`, 'POST');
  // and a video with one version
  const single = makeVideo(path.join(dir, 'Spot/export/single.mp4'), { w: 320, h: 180, fps: 25, dur: 2, pattern: 'testsrc2' });
  age(single);
  const { video: one } = await api('/api/library', 'POST', { path: single });

  const all = await api(`/api/review/${slug}/shares`, 'POST', { label: 'Every version', versions: 'all' });
  const newest = await api(`/api/review/${slug}/shares`, 'POST', { label: 'Newest only' });
  const lonely = await api(`/api/review/${encodeURIComponent(one.slug)}/shares`, 'POST', { label: 'One version', versions: 'all' });

  browser = await launch();
  const errors = [];
  /** A page in a context of its own (no kept compare, mode or name), with every request it makes written down; `lang`:
   * the page's language as chosen on this device. */
  const fresh = async (viewport = DESKTOP, b = browser, lang = null) => {
    const ctx = await b.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport(viewport);
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));
    p.requests = [];
    p.on('request', (r) => p.requests.push(r.url()));
    await p.evaluateOnNewDocument((lang) => {
      try {
        localStorage.setItem('vr.zoomhint', '{"seen":true}');
        if (lang) localStorage.setItem('vr.lang', lang);
      } catch {}
    }, lang);
    page = p;
    return p;
  };
  const shot = async (p, name) => SHOTS && p.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  const videosReady = (p, n) =>
    p.waitForFunction(
      (n) => {
        const vs = [...document.querySelectorAll('.stage video')];
        return vs.length === n && vs.every((v) => v.readyState >= 2 && !v.seeking);
      },
      { polling: 100, timeout: 30000 },
      n,
    );
  const open = async (p, token, n = 1) => {
    await p.goto(`${BASE}/g/${token}`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('[data-testid=g-player]');
    await videosReady(p, n);
  };
  const shownFrame = (p) => p.$eval('.g-transport .tc .sub b', (e) => Number(e.textContent));
  /** The picture of the stage's `i`th video (A first; in a wipe B is the second), small and grey. */
  const picture = (p, i) =>
    p.evaluate(
      ({ SW, SH, i }) => {
        const v = document.querySelectorAll('.stage video')[i];
        const c = document.createElement('canvas');
        c.width = SW;
        c.height = SH;
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(v, 0, 0, SW, SH);
        const d = g.getImageData(0, 0, SW, SH).data;
        const out = [];
        for (let k = 0; k < d.length; k += 4) out.push(Math.round(0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2]));
        return out;
      },
      { SW, SH, i },
    );
  /** Both sides on frame `n`: A's picture is ffmpeg's frame n of `a`, B's of `b` (closer than the frames around it, and
   * not the other version's). A busy machine presents a frame a moment after its seek: a wrong one is looked at again
   * for up to 5 s. */
  const sameFrame = async (p, n, a, b, why) => {
    for (const [i, file, otherFile, side] of [
      [0, a, b, 'A'],
      [1, b, a, 'B'],
    ]) {
      const right = (x) => x.best.k === n && x.best.e < 6 && x.other > 20;
      const look = async () => {
        const px = await picture(p, i);
        return { best: closestFrame(file, px, n, N), other: mae(ffFrame(otherFile, n), px) };
      };
      let got = await look();
      for (const t = Date.now(); !right(got) && Date.now() - t < 5000; got = await look()) await sleep(200);
      assert(right(got), `${why}: ${side} should show f${n} of ${path.basename(file)} (${got.best.line}; the other version ${got.other.toFixed(1)} away)`);
    }
  };
  /** Steps with the keyboard to frame `n` from where it stands. */
  const stepTo = async (p, n) => {
    const at = await shownFrame(p);
    const key = n > at ? 'ArrowRight' : 'ArrowLeft';
    for (let k = 0; k < Math.abs(n - at); k++) await p.keyboard.press(key);
    await until(async () => (await shownFrame(p)) === n, `the transport on frame ${n}`);
  };
  const rect = (p, sel) =>
    p.$eval(sel, (e) => {
      const r = e.getBoundingClientRect();
      return [r.left, r.top, r.width, r.height].map((x) => Math.round(x)).join(',');
    });
  const compareBar = (p) => p.$('[data-testid=compare-bar]');
  const media = (p, v) => p.requests.filter((u) => new RegExp(`/media/g/[^/]+/[^/]+/v${v}(\\?|$)`).test(u));

  console.log(`guest-compare e2e against ${BASE} (store ${dir})`);

  await check('Compare is there only where the link shows every version of a video with two; B opens it, alone too', async () => {
    const p = await fresh();
    await open(p, all.token);
    assert(await p.$('[data-testid=g-compare]'), 'Compare beside the version on a link that shows every version');
    assert(!media(p, 1).length, `no other version's media before Compare is opened: ${media(p, 1)}`);
    for (const [token, why] of [
      [newest.token, 'a newest-only link'],
      [lonely.token, 'a video with one version'],
    ]) {
      await open(p, token);
      assert(!(await p.$('[data-testid=g-compare]')), `no Compare on ${why}`);
      await p.keyboard.press('b');
      await sleep(300);
      assert(!(await compareBar(p)), `B opens nothing on ${why}`);
    }
    await p.browserContext().close();
  });

  await check('a newest-only link requests no other version’s media and no compare', async () => {
    const p = await fresh();
    await open(p, newest.token);
    await p.keyboard.press('b');
    await p.keyboard.press('ArrowRight');
    await settle(p);
    const asked = p.requests.filter((u) => /\/compare\b/.test(u) || /\/media\/g\/[^/]+\/[^/]+\/v1\b/.test(u) || /[?&]v=1\b/.test(u));
    assert(!asked.length, `nothing of V1: ${asked.join(', ')}`);
    await p.browserContext().close();
  });

  let p;
  await check('side by side: V2 and V1 on the same frame after a step, a play and a pause, and a click on the timeline', async () => {
    p = await fresh();
    await open(p, all.token);
    const before = {
      dock: await rect(p, '.dock'),
      side: await rect(p, '.side'),
      top: await rect(p, '.g-top'),
      button: await rect(p, '[data-testid=g-compare]'),
    };
    await stepTo(p, 7);
    await p.click('[data-testid=g-compare]');
    await p.waitForSelector('[data-testid=compare-bar]');
    await p.waitForFunction(() => document.querySelectorAll('.stage .pane').length === 2);
    // B's picture holds its place before its video plays: nothing moves when it arrives
    const early = await rect(p, '.stage .pane:last-child .vbox');
    await videosReady(p, 2);
    assert(early === (await rect(p, '.stage .pane:last-child .vbox')), 'B’s picture stood where it stands before its video came');
    const after = {
      dock: await rect(p, '.dock'),
      side: await rect(p, '.side'),
      top: await rect(p, '.g-top'),
      button: await rect(p, '[data-testid=g-compare]'),
    };
    assert(JSON.stringify(before) === JSON.stringify(after), `nothing outside the stage moves: ${JSON.stringify({ before, after })}`);
    assert((await p.$eval('[data-testid=g-compare]', (e) => e.getAttribute('aria-pressed'))) === 'true', 'Compare is pressed');
    assert(media(p, 1).length > 0, 'V1’s media is asked for once Compare is open');
    const tags = await p.$$eval('.stage .pane-tag', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    assert(JSON.stringify(tags) === JSON.stringify(['AV2', 'BV1reference']), `the pictures say A V2 and B V1 · reference: ${tags}`);
    await sameFrame(p, 7, v2, v1, 'opened on frame 7');
    await stepTo(p, 57);
    await sameFrame(p, 57, v2, v1, 'stepped to 57');
    await shot(p, 'compare-01-side');
    // play, then pause, three times: both stop on the frame the transport shows (B plays a frame or so behind A, which
    // the pause has to make up for)
    for (const past of [66, 78, 92]) {
      await p.keyboard.press(' ');
      await until(async () => (await p.$eval('.stage video', (v) => v.currentTime)) * 25 > past, `playing past f${past}`);
      await p.keyboard.press(' ');
      await until(() => p.$eval('.stage video', (v) => v.paused), 'paused');
      await videosReady(p, 2);
      const paused = await shownFrame(p);
      assert(paused > past - 2 && paused < N, `paused on a frame it played to (${paused})`);
      await sameFrame(p, paused, v2, v1, `paused on ${paused}`);
    }
    // a click on the timeline: both go there
    const tl = await p.$eval('.timeline canvas', (c) => {
      const r = c.getBoundingClientRect();
      // on the waveform, under the notes' lane (a drag there marks a section)
      return { x: r.left + r.width * 0.3, y: r.bottom - 12 };
    });
    await p.mouse.click(tl.x, tl.y);
    await until(async () => Math.abs((await shownFrame(p)) - 36) < 8, 'the click on the timeline moved the playhead');
    await videosReady(p, 2);
    const clicked = await shownFrame(p);
    await sameFrame(p, clicked, v2, v1, `clicked to ${clicked}`);
  });

  await check('wipe: one picture, the handle moves the cut and each side’s name with it, both on the frame', async () => {
    // switched while playing: B comes back in the wipe and plays along, and both stop on the frame
    await stepTo(p, 10);
    await p.keyboard.press(' ');
    await until(() => p.$eval('.stage video', (v) => !v.paused), 'playing');
    await p.click('[data-testid=compare-bar] [data-value=wipe]');
    await p.waitForSelector('.wipe-handle');
    const t0 = await until(() => p.$eval('.wipe video', (v) => v.readyState >= 2 && v.currentTime), 'B in the wipe');
    await until(async () => (await p.$eval('.wipe video', (v) => !v.paused && v.currentTime)) > t0 + 0.2, 'B plays along in the wipe');
    await p.keyboard.press(' ');
    await until(() => p.$eval('.stage video', (v) => v.paused), 'paused');
    await videosReady(p, 2);
    const stopped = await shownFrame(p);
    await sameFrame(p, stopped, v2, v1, `the wipe, paused on ${stopped}`);
    assert((await p.$$('.stage .pane')).length === 1, 'one picture');
    const handle = await p.$eval('.wipe-handle', (e) => {
      const r = e.getBoundingClientRect();
      const w = e.parentElement.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: w.left, width: w.width };
    });
    await p.mouse.move(handle.x, handle.y);
    await p.mouse.down();
    await p.mouse.move(handle.left + handle.width * 0.25, handle.y, { steps: 6 });
    await p.mouse.up();
    const cut = await p.evaluate(() => ({
      now: Number(document.querySelector('.wipe-handle').getAttribute('aria-valuenow')),
      b: document.querySelector('.wipe video').style.clipPath,
      bTag: document.querySelector('.pane-tag-layer.b').style.clipPath,
      aTag: document.querySelector('.pane-tag-layer:not(.b)').style.clipPath,
    }));
    assert(Math.abs(cut.now - 25) <= 2, `the handle went to a quarter: ${JSON.stringify(cut)}`);
    assert(/inset\(0(px)? 0(px)? 0(px)? 2[4-6]/.test(cut.b) && cut.bTag === cut.b, `B and its name cut at the handle: ${JSON.stringify(cut)}`);
    assert(/inset\(0(px)? 7[4-6]/.test(cut.aTag), `A's name cut at the handle too: ${JSON.stringify(cut)}`);
    await p.focus('.wipe-handle');
    await p.keyboard.press('ArrowRight');
    await until(async () => Number(await p.$eval('.wipe-handle', (e) => e.getAttribute('aria-valuenow'))) > cut.now, 'the arrow keys move it');
    const at = await shownFrame(p);
    await sameFrame(p, at, v2, v1, `the wipe on ${at}`);
    await shot(p, 'compare-02-wipe');
  });

  await check('swap: V1 on screen and V2 beside it, on the same frame; the compare and the frame stay', async () => {
    const at = await shownFrame(p);
    await p.click('[data-testid=compare-bar] .cmp-swap');
    await until(async () => (await p.$eval('[data-testid=g-subtitle]', (e) => e.textContent)).includes('V1'), 'V1 on screen');
    await p.waitForSelector('[data-testid=compare-bar]');
    await videosReady(p, 2);
    assert((await shownFrame(p)) === at, `the frame stayed (${await shownFrame(p)} vs ${at})`);
    assert(await p.$('.wipe-handle'), 'the wipe stayed');
    const tags = await p.$$eval('.stage .pane-tag', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    assert(JSON.stringify(tags) === JSON.stringify(['AV1', 'BV2reference']), `A V1, B V2: ${tags}`);
    await sameFrame(p, at, v1, v2, `swapped on ${at}`);
  });

  await check('Esc leaves the compare (and B opens and closes it); a reload keeps an open one', async () => {
    const pane = await rect(p, '.stage');
    await p.keyboard.press('Escape');
    await until(async () => !(await compareBar(p)), 'Esc closed it');
    await videosReady(p, 1);
    assert((await rect(p, '.stage')) === pane, 'the stage keeps its box');
    assert((await p.$eval('[data-testid=g-compare]', (e) => e.getAttribute('aria-pressed'))) === 'false', 'Compare is up again');
    await p.keyboard.press('b');
    await p.waitForSelector('[data-testid=compare-bar]');
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForSelector('[data-testid=compare-bar]');
    await videosReady(p, 2);
    await p.keyboard.press('b');
    await until(async () => !(await compareBar(p)), 'B closed it');
    await p.browserContext().close();
  });

  /** Every control of the compare bar, by the box a finger hits: its own plus an absolute ::before/::after. */
  const tapAreas = (q) =>
    q.$$eval('[data-testid=compare-bar] :is(button, .input.select)', (els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        let [l, t, rt, b] = [r.left, r.top, r.right, r.bottom];
        for (const ps of ['::before', '::after']) {
          const s = getComputedStyle(el, ps);
          if (s.content === 'none' || s.position !== 'absolute' || s.pointerEvents === 'none') continue;
          const px = (v, size) => (v.endsWith('px') ? parseFloat(v) : v.endsWith('%') ? (parseFloat(v) / 100) * size : 0);
          l = Math.min(l, r.left + px(s.left, r.width));
          t = Math.min(t, r.top + px(s.top, r.height));
          rt = Math.max(rt, r.right - px(s.right, r.width));
          b = Math.max(b, r.bottom - px(s.bottom, r.height));
        }
        return { name: el.getAttribute('aria-label') || el.textContent.trim(), w: Math.round(rt - l), h: Math.round(b - t), right: r.right };
      }),
    );
  const phoneCompare = async (q, words) => {
    await q.click('[data-testid=g-more]');
    await q.waitForSelector('.menu [role^=menuitem]');
    await q.evaluate((w) => [...document.querySelectorAll('.menu [role^=menuitem]')].find((e) => e.textContent.includes(w)).click(), words);
    await q.waitForSelector('[data-testid=compare-bar]');
    await videosReady(q, 2);
  };

  await check('a phone: compare from ⋯, two landscape pictures one above the other, the row fits with 44 px tap areas', async () => {
    const q = await fresh(PHONE);
    await open(q, all.token);
    await phoneCompare(q, 'Compare versions');
    const panes = await q.$$eval('.stage .pane .vbox', (els) => els.map((e) => e.getBoundingClientRect().toJSON()));
    assert(panes.length === 2 && panes[1].top >= panes[0].bottom - 0.5, `one above the other: ${JSON.stringify(panes)}`);
    for (const r of panes) assert(r.width > 350, `each picture across the width: ${JSON.stringify(r)}`);
    // a phone compares to look: no drawing strip under both pictures (× brings it back), the stage ends with B
    assert(!(await q.$('.draw-bar')), 'no drawing tools while comparing on a phone');
    const stage = await q.$eval('.stage', (e) => e.getBoundingClientRect().toJSON());
    assert(stage.bottom - panes[1].bottom < 20, `the stage ends with the pictures: ${JSON.stringify({ stage, b: panes[1] })}`);
    const small = (await tapAreas(q)).filter((x) => x.w < 44 || x.h < 44 || x.right > 390);
    assert(!small.length, `tap areas under 44 px or off the screen: ${JSON.stringify(small)}`);
    assert(
      (await q.$eval('[data-testid=compare-bar] [data-value=side]', (e) => e.getAttribute('aria-label'))) === 'One above the other',
      'the mode says what it does here',
    );
    await shot(q, 'compare-03-phone');
    // every width, the compare kept across the reloads a change to touch makes
    const fit = await fitsAt(q, 'compare on a phone');
    assert(!fit.length, fit.join('\n'));
    await q.waitForSelector('[data-testid=compare-bar]');
    await q.click('[data-testid=compare-bar] .cmp-close');
    await q.waitForSelector('.draw-bar');
    await q.browserContext().close();
  });

  await check('German at 390: the row and the pictures’ names in the visitors’ words, nothing cut', async () => {
    const de = await launch({ locale: 'de-DE' });
    try {
      const q = await fresh(PHONE, de, 'de');
      await open(q, all.token);
      await phoneCompare(q, 'Versionen vergleichen');
      const words = await q.evaluate(() => ({
        side: document.querySelector('[data-testid=compare-bar] [data-value=side]').getAttribute('aria-label'),
        wipe: document.querySelector('[data-testid=compare-bar] [data-value=wipe]').getAttribute('aria-label'),
        tags: [...document.querySelectorAll('.stage .pane-tag')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
        wide: document.documentElement.scrollWidth,
      }));
      assert(words.side === 'Übereinander' && words.wipe === 'Wischblende', `German modes: ${JSON.stringify(words)}`);
      assert(JSON.stringify(words.tags) === JSON.stringify(['AV2', 'BV1zum Vergleich']), `German names: ${words.tags}`);
      assert(words.wide <= 390, `nothing sideways (${words.wide})`);
      const small = (await tapAreas(q)).filter((x) => x.w < 44 || x.h < 44 || x.right > 390);
      assert(!small.length, `tap areas: ${JSON.stringify(small)}`);
      await shot(q, 'compare-04-phone-de');
    } finally {
      await de.close();
    }
  });

  await check('no page errors', async () => {
    assert(!errors.length, errors.join('\n'));
  });
} catch (e) {
  crashed(e, srv);
}
await finish(LABEL, { browser, servers: [srv] });
