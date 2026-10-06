#!/usr/bin/env node
// covers: web/src/player/Stage.tsx web/src/player/DrawBar.tsx web/src/player/usePlayback.ts web/src/lib/seek.ts
// covers: web/src/library/drag.ts web/src/library/moves.ts web/src/library/FolderPicker.tsx server/routes/media.ts
// covers: lib/drawing.ts lib/time.ts
// Browser end-to-end test: real server (temp store, free port) + headless Chrome via puppeteer-core.
// Checks the promises the UI makes: the presented frame is the ffmpeg frame, drawings are stored in video pixels,
// videos can be filed by drag & drop and via "Move to…". Without Chrome or web/dist it fails (prereq.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { age, makeVideo, sleep } from '../lib/helpers.ts';
import { launch, requireChrome } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { closestFrame, SH, SW } from './lib/frames.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'e2e';
requireChrome(LABEL);
const srv = await startServer({ prefix: 'vr-e2e-', user: 'tester' });
const { dir, env, base: BASE } = srv;

const api = async (p, init) => {
  const r = await fetch(BASE + p, init && { ...init, headers: { 'Content-Type': 'application/json' } });
  const body = await r.json();
  if (!r.ok) throw new Error(`${p}: ${body.error}`);
  return body;
};

let browser;
try {
  const W = 320;
  const H = 180;
  const video = makeVideo(path.join(dir, 'Proj/export/e2e.mp4'), { w: W, h: H, fps: 30, dur: 3 });
  age(video);
  const { video: summary } = await api('/api/library', { method: 'POST', body: JSON.stringify({ path: video }) });
  const slug = summary.slug;

  browser = await launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const openPlayer = async (frame) => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${encodeURIComponent(slug)}${frame !== undefined ? `?f=${frame}` : ''}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => {
        const v = document.querySelector('.vbox video');
        return v && v.readyState >= 2 && !v.seeking;
      },
      { polling: 100, timeout: 15000 },
    );
    await sleep(500);
  };

  console.log(`e2e against ${BASE} (store ${dir})`);

  await check('every suite’s browser is a desktop with a mouse, on a Linux server too: hover and a fine pointer, also after a resize', async () => {
    const missing = () => page.evaluate(() => ['(hover: hover)', '(pointer: fine)'].filter((q) => !matchMedia(q).matches));
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    assert(!(await missing()).length, `loaded: not matched ${await missing()} (MOUSE_ARGS in lib/browser.mjs)`);
    await page.setViewport({ width: 1000, height: 800 });
    assert(!(await missing()).length, `resized: not matched ${await missing()} (keepTheMouse in lib/browser.mjs)`);
    await page.setViewport({ width: 1440, height: 900 });
  });

  await check('the browser presents exactly the frame ffmpeg decodes (0, 1, 45, 60, 88, 89)', async () => {
    for (const n of [0, 1, 45, 60, 88, 89]) {
      await openPlayer(n);
      const shot = await page.evaluate(
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
          return { out, tc: document.querySelector('.tc .main')?.textContent, drift: !!document.querySelector('.tc .badge') };
        },
        { SW, SH },
      );
      const best = closestFrame(video, shot.out, n, 90);
      assert(best.k === n, `frame ${n}: closest ffmpeg frame is ${best.k} (${best.line})`);
      assert(!shot.drift, `frame ${n}: UI reports a presented/requested mismatch`);
      const want = `00:${String(Math.floor(n / 30)).padStart(2, '0')}:${String(n % 30).padStart(2, '0')}`;
      assert(shot.tc === want, `frame ${n}: timecode ${shot.tc} ≠ ${want}`);
    }
  });

  await check('a box drawn in the composer is stored in video pixels, with both screenshots', async () => {
    await openPlayer(30);
    await page.keyboard.press('c');
    await page.waitForSelector('.composer textarea');
    const box = await page.$eval('.vbox', (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    await page.mouse.move(box.x + box.w * 0.2, box.y + box.h * 0.3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.4, { steps: 4 });
    await page.mouse.move(box.x + box.w * 0.7, box.y + box.h * 0.45, { steps: 4 });
    await page.mouse.up();
    await page.type('.composer textarea', 'e2e note');
    await page.keyboard.down('Meta');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Meta');
    await page.waitForFunction(() => !document.querySelector('.composer'), { polling: 100, timeout: 20000 });
    const { review } = await api(`/api/review/${encodeURIComponent(slug)}`);
    const c = review.comments.find((x) => x.text === 'e2e note');
    assert(c, 'comment saved');
    assert(c.frame === 30 && c.timecode === '00:01:00', `frame ${c.frame} ${c.timecode}`);
    const [d] = c.drawing;
    const near = (a, b) => Math.abs(a - b) <= 2;
    assert(d.type === 'box' && near(d.x, 0.2 * W) && near(d.y, 0.3 * H) && near(d.w, 0.5 * W) && near(d.h, 0.15 * H), `box ${JSON.stringify(d)}`);
    for (const f of [c.shots.clean, c.shots.marked]) assert(fs.existsSync(path.join(env.VR_DATA, slug, f)), `${f} exists`);
  });

  await check('drag & drop onto a sidebar folder files the video', async () => {
    await api('/api/folders', { method: 'POST', body: JSON.stringify({ path: 'E2E' }) });
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.nav .nav-item');
    await page.waitForFunction(() => [...document.querySelectorAll('.nav .nav-item')].some((e) => e.textContent.startsWith('E2E')), {
      polling: 100,
      timeout: 10000,
    });
    await page.evaluate((slug) => {
      const target = [...document.querySelectorAll('.nav .nav-item')].find((e) => e.textContent.startsWith('E2E'));
      const dt = new DataTransfer();
      dt.setData('application/x-vr-video', slug);
      for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, slug);
    for (let i = 0; i < 30; i++) {
      if ((await api('/api/library')).videos[0].folder === 'E2E') return;
      await sleep(100);
    }
    throw new Error('folder did not change');
  });

  await check('"Move to…" creates a folder and moves the video', async () => {
    await page.goto(`${BASE}/#/folder/E2E`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.film .film-menu .btn');
    await page.hover('.film');
    await page.click('.film .film-menu .btn');
    await page.waitForSelector('.menu');
    await page.evaluate(() => [...document.querySelectorAll('.menu button')].find((b) => b.textContent.includes('Move to')).click());
    await page.waitForSelector('.fp input');
    await page.type('.fp input', 'Clients/Acme');
    await page.keyboard.press('Enter');
    await page.evaluate(() => [...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.includes('Move here')).click());
    for (let i = 0; i < 30; i++) {
      const lib = await api('/api/library');
      if (lib.videos[0].folder === 'Clients/Acme') {
        assert(lib.folders.includes('Clients'), 'parent folder created');
        assert(!page.url().includes('/v/'), 'clicking inside the modal did not open the player behind it');
        return;
      }
      await sleep(100);
    }
    throw new Error('folder did not change');
  });

  await check('no page errors along the way', async () => {
    assert(!errors.length, errors.join(' | '));
  });
} catch (e) {
  crashed(e, srv);
} finally {
  await finish(LABEL, { browser, servers: [srv] });
}
