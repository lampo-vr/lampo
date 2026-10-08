#!/usr/bin/env node
// covers: web/src/player/Stage.tsx web/src/player/Timeline.tsx web/src/player/Transport.tsx
// covers: web/src/player/usePlayback.ts web/src/player/PhoneDock.tsx web/src/lib/seek.ts web/src/guest/GuestPlayer.tsx
// covers: web/src/styles/guest.css server/playback.ts
// Frame exactness in WebKit, Safari's engine, on an emulated iPhone: Playwright's WebKit build plays an H.264 clip in
// the phone player, and a finger on the timeline, a scrub across it, the step buttons and a ?f= link must each show
// the frame ffmpeg decodes, with the transport naming that frame and no "shown fN" drift. A client's review link opens
// as one app screen on a 390 and a 430 pt iPhone (one bar row, the tools under the picture, one transport row). A big
// version plays the phone's own copy (1280 px), frame-exact too.
// WebKit is a separate download (about 80 MB, into cache/playwright, gitignored): `npm run webkit:install`. Without it
// the suite fails (prereq.mjs); on a WebKit build that can't decode H.264 (Playwright's Linux WebKit) it says so and
// skips. VR_SHOTS=<dir> keeps screenshots (and one of the page for each failed check).
import fs from 'node:fs';
import path from 'node:path';
import { makeVideo, ROOT, sleep } from '../lib/helpers.ts';
import { checkouts, requireDist, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { closestFrame, ffFrame, SH, SW } from './lib/frames.mjs';
import { startServer } from './lib/server.mjs';
import { unavailable } from './prereq.mjs';

const LABEL = 'webkit e2e';
// A git worktree uses the main checkout's download, as it does for Chrome.
process.env.PLAYWRIGHT_BROWSERS_PATH ||=
  checkouts()
    .map((root) => path.join(root, 'cache/playwright'))
    .find((dir) => fs.existsSync(dir)) ?? path.join(ROOT, 'cache/playwright');
let pw;
try {
  pw = await import('playwright-core');
} catch {
  unavailable(LABEL, 'playwright-core is not installed (npm install)');
}
const { webkit, devices } = pw;
if (!fs.existsSync(webkit.executablePath())) unavailable(LABEL, 'WebKit is not downloaded yet, run `npm run webkit:install`');
requireDist(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-webkit-', user: 'tester' });
const { dir, base: BASE } = srv;

const api = async (p, init) => {
  const r = await fetch(BASE + p, init && { ...init, headers: { 'Content-Type': 'application/json' } });
  const body = await r.json();
  if (!r.ok) throw new Error(`${p}: ${body.error}`);
  return body;
};

let browser;
let skipped = null;
try {
  // testsrc2 changes every frame, so a neighbour frame is never mistaken for the right one.
  const W = 320;
  const H = 180;
  const N = 90;
  const video = makeVideo(path.join(dir, 'clip/spot.mp4'), { w: W, h: H, fps: 30, dur: 3, pattern: 'testsrc2' });
  const { video: summary } = await api('/api/library', { method: 'POST', body: JSON.stringify({ path: video }) });
  const slug = summary.slug;

  browser = await webkit.launch();
  const context = await browser.newContext({ ...devices['iPhone 13'], locale: 'en-US', reducedMotion: 'reduce' });
  const page = await context.newPage();
  screenshotFailures(() => page, 'webkit');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const settled = () =>
    page.waitForFunction(
      () => {
        const v = document.querySelector('.vbox video');
        return v && v.readyState >= 2 && !v.seeking;
      },
      null,
      { polling: 100, timeout: 30000 },
    );
  // The frame on screen, the frame the transport names, and whether the player saw a different frame presented.
  const shown = () =>
    page.evaluate(
      ({ SW, SH }) => {
        const v = document.querySelector('.vbox video');
        const c = document.createElement('canvas');
        c.width = SW;
        c.height = SH;
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(v, 0, 0, SW, SH);
        const d = g.getImageData(0, 0, SW, SH).data;
        const out = [];
        for (let i = 0; i < d.length; i += 4) out.push(Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]));
        return { out, frame: Number(document.querySelector('.ptc .sub b')?.textContent), drift: !!document.querySelector('.ptc .badge') };
      },
      { SW, SH },
    );
  const expectFrame = async (target, how, file = video, frames = N) => {
    await settled();
    // Long enough for the player's one-time recovery when WebKit presents a stale frame (usePlayback: ~400 ms). A loaded
    // machine can take longer: only then look again, up to 8 s, for the picture to be the frame asked for (grabbing it
    // over and over while all is well sets off WebKit's ResizeObserver loop warning, a page error here).
    await sleep(800);
    const right = (g) => g.frame === target && !g.drift && closestFrame(file, g.out, target, frames).k === target;
    let got = await shown();
    const t = Date.now();
    while (!right(got) && Date.now() - t < 8000) {
      await sleep(250);
      got = await shown();
    }
    if (Date.now() - t > 100) console.log(`      (${how}: the picture was looked at again for ${Date.now() - t} ms)`);
    assert(got.frame === target, `${how}: the transport says f${got.frame}, expected f${target}`);
    const mae = (ref) => ref.reduce((s, b, i) => s + Math.abs(b - got.out[i]), 0) / ref.length;
    const cands = [target - 1, target, target + 1].filter((k) => k >= 0 && k < frames).map((k) => ({ k, e: mae(ffFrame(file, k)) }));
    const best = cands.reduce((a, b) => (b.e < a.e ? b : a));
    if (best.k !== target) {
      const all = Array.from({ length: frames }, (_, k) => ({ k, e: mae(ffFrame(file, k)) })).reduce((a, b) => (b.e < a.e ? b : a));
      assert(
        false,
        `${how}: the picture is closest to ffmpeg's f${best.k} (${cands.map((c) => `${c.k}:${c.e.toFixed(2)}`).join(' ')}; over the clip f${all.k}:${all.e.toFixed(2)})`,
      );
    }
    assert(!got.drift, `${how}: the presented frame differs from the requested one`);
  };
  const box = async (sel) => {
    const b = await page.locator(sel).first().boundingBox();
    assert(b, `${sel} is on screen`);
    return b;
  };

  console.log(`webkit e2e against ${BASE} (WebKit ${browser.version()}, store ${dir})`);

  await page.goto(`${BASE}/#/v/${encodeURIComponent(slug)}`);
  await page.waitForSelector('.phone-player .ptransport');
  const playable = await page
    .waitForFunction(() => document.querySelector('.vbox video')?.readyState >= 2 || document.querySelector('.vbox video')?.error, null, { timeout: 20000 })
    .then(() => page.evaluate(() => !document.querySelector('.vbox video').error))
    .catch(() => false);
  if (!playable) {
    skipped = 'this WebKit build cannot decode the H.264 clip (Playwright’s Linux WebKit has no H.264)';
  } else {
    await check('WebKit reports presented frames (requestVideoFrameCallback)', async () => {
      const has = await page.evaluate(() => 'requestVideoFrameCallback' in HTMLVideoElement.prototype);
      assert(has, 'no requestVideoFrameCallback: the shown frame cannot be read from mediaTime');
    });

    await check('a finger on the timeline lands on the exact frame ffmpeg decodes', async () => {
      const tl = await box('.timeline canvas');
      const xOf = (f) => tl.x + ((f + 0.5) * tl.width) / N;
      for (const target of [17, 61, 88]) {
        await page.touchscreen.tap(xOf(target), tl.y + tl.height - 12);
        await expectFrame(target, `tap on f${target}`);
      }
    });

    await check('a scrub across the timeline ends on the frame it was released on', async () => {
      const tl = await box('.timeline canvas');
      const xOf = (f) => tl.x + ((f + 0.5) * tl.width) / N;
      const y = tl.y + tl.height - 12;
      await page.mouse.move(xOf(4), y);
      await page.mouse.down();
      for (let i = 1; i <= 16; i++) {
        await page.mouse.move(xOf(4) + ((xOf(43) - xOf(4)) * i) / 16, y);
        await sleep(16);
      }
      await page.mouse.up();
      await expectFrame(43, 'scrub to f43');
    });

    await check('the step buttons move exactly one and ten frames', async () => {
      await page.locator('.pbtns button[aria-label="Next frame"]').tap();
      await expectFrame(44, '+1');
      await page.locator('.pbtns button[aria-label="Forward 10 frames"]').tap();
      await expectFrame(54, '+10');
      await page.locator('.pbtns button[aria-label="Previous frame"]').tap();
      await expectFrame(53, '−1');
      await page.locator('.pbtns button[aria-label="Back 10 frames"]').tap();
      await expectFrame(43, '−10');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'webkit-player.png') });
    });

    await check('a link to a frame (?f=) opens on it', async () => {
      await page.goto('about:blank');
      await page.goto(`${BASE}/#/v/${encodeURIComponent(slug)}?f=29`);
      await page.waitForSelector('.phone-player .ptransport');
      await expectFrame(29, '?f=29');
    });

    // The client's review link in Safari's engine, on the phones its clients hold: one bar row, the picture across the
    // width with the drawing tools under it, one transport row, the notes, and the foot with "Powered by Lampo".
    await check('a review link on an iPhone is one app screen (390 and 430 pt)', async () => {
      const link = await api(`/api/review/${encodeURIComponent(slug)}/shares`, { method: 'POST', body: JSON.stringify({ label: 'First cut' }) });
      for (const device of ['iPhone 13', 'iPhone 14 Pro Max']) {
        const ctx = await browser.newContext({ ...devices[device], locale: 'en-US', reducedMotion: 'reduce' });
        const p = await ctx.newPage();
        p.on('pageerror', (e) => errors.push(e.message));
        try {
          await p.goto(`${BASE}/g/${link.token}`);
          await p.waitForFunction(() => document.querySelector('.vbox video')?.readyState >= 2, null, { timeout: 30000 });
          const m = await p.evaluate(() => {
            const shown = (e) => e.getClientRects().length > 0;
            const box = (e) => e.getBoundingClientRect();
            const spread = (els) => {
              const ys = els.map((e) => box(e).top + box(e).height / 2);
              return Math.round(Math.max(...ys) - Math.min(...ys));
            };
            const bar = document.querySelector('.g-top');
            const barKids = [...bar.querySelectorAll(':scope > *, .g-top-acts > *')].filter(shown).filter((e) => !e.matches('.g-top-acts'));
            const transport = [...document.querySelectorAll('.g-transport button, .g-transport .tc')].filter(shown);
            const edges = [...barKids, ...transport].filter((e) => box(e).right > innerWidth + 1 || box(e).left < -1).length;
            return {
              width: innerWidth,
              sideways: document.documentElement.scrollWidth - innerWidth,
              bar: spread(barKids),
              barHeight: Math.round(box(bar).height),
              transport: spread(transport),
              edges,
              tools: Math.round(box(document.querySelector('.draw-bar')).top - box(document.querySelector('.vbox')).bottom),
              picture: Math.round(box(document.querySelector('.vbox')).width),
              foot: document.querySelector('[data-testid=powered-by]')?.textContent.trim(),
            };
          });
          assert(m.sideways <= 1 && !m.edges, `${device}: nothing runs off the screen: ${JSON.stringify(m)}`);
          assert(m.bar <= 4 && m.barHeight <= 55, `${device}: one bar row: ${JSON.stringify(m)}`);
          assert(m.transport <= 4, `${device}: one transport row: ${JSON.stringify(m)}`);
          assert(m.tools >= 0 && m.picture >= m.width - 17, `${device}: the picture across the width, the tools under it: ${JSON.stringify(m)}`);
          assert(m.foot === 'Powered by Lampo', `${device}: the foot: ${JSON.stringify(m)}`);
          if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `webkit-guest-${devices[device].viewport.width}.png`) });
        } finally {
          await ctx.close();
        }
      }
    });

    // A phone plays a copy made for it (server/playback.ts: at most 1280 px, CRF 23; the scrub copy's full-size bytes
    // stalled a phone's play): made when the phone first asks, switched to while paused, and as frame-exact.
    await check('a big version plays its phone copy on an iPhone, frame-exact like the rest', async () => {
      const bigFile = makeVideo(path.join(dir, 'clip/big.mp4'), { w: 1600, h: 900, fps: 25, dur: 2, pattern: 'testsrc2', gop: 10 });
      const BN = 50;
      const { video: big } = await api('/api/library', { method: 'POST', body: JSON.stringify({ path: bigFile }) });
      await page.goto('about:blank');
      await page.goto(`${BASE}/#/v/${encodeURIComponent(big.slug)}`);
      await page.waitForSelector('.phone-player .ptransport');
      await page.waitForFunction(() => /[?&]p=1(&|$)/.test(document.querySelector('.vbox video')?.currentSrc || ''), null, { timeout: 60000 });
      const tl = await box('.timeline canvas');
      const xOf = (f) => tl.x + ((f + 0.5) * tl.width) / BN;
      for (const target of [13, 37]) {
        await page.touchscreen.tap(xOf(target), tl.y + tl.height - 12);
        await expectFrame(target, `phone copy, tap on f${target}`, bigFile, BN);
      }
      await page.locator('.pbtns button[aria-label="Next frame"]').tap();
      await expectFrame(38, 'phone copy, +1', bigFile, BN);
      const size = await page.evaluate(() => [document.querySelector('.vbox video').videoWidth, document.querySelector('.vbox video').videoHeight]);
      assert(size[0] === 1280 && size[1] === 720, `the phone's copy is 1280 × 720, not the version's 1600 × 900: ${size.join(' × ')}`);
    });

    await check('no page errors along the way', async () => {
      assert(!errors.length, errors.slice(0, 5).join('\n'));
    });
  }
} catch (e) {
  crashed(e, srv);
} finally {
  await finish(LABEL, { browser, servers: [srv], skipped });
}
