#!/usr/bin/env node
// covers: web/src/guest/DownloadAll.tsx web/src/guest/Room.tsx web/src/library/downloadFolder.ts
// covers: web/src/styles/downloads.css server/routes/downloads.ts server/routes/shares/ lib/zip.ts
// Browser end-to-end test of "Download all": a real server (local mode, temp store, free port) + headless Chrome.
// A client on a phone opens a folder link's room, sees "Download all" with the size, taps it and gets one zip with the
// folder's videos (checked by Python's zipfile: every CRC, the original bytes); the link counts the download under
// the client's name; the owner downloads a folder from the library's folder menu. Screenshots land in VR_SHOTS.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { age, makeVideo, until } from '../lib/helpers.ts';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'download e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-download-e2e-', user: 'Sam' });
const { dir, base: BASE } = srv;

const downloads = path.join(dir, 'downloads');
fs.mkdirSync(downloads, { recursive: true });
const api = jsonApi(BASE);
// A finished download (Chrome writes .crdownload until it is complete).
const zipIn = (pattern) => until(() => fs.readdirSync(downloads).find((f) => pattern.test(f) && !f.endsWith('.crdownload')), `a zip matching ${pattern}`);
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function readZip(file) {
  const script = `
import hashlib, json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
print(json.dumps([{"name": i.filename, "sha": hashlib.sha256(z.read(i)).hexdigest()} for i in z.infolist()]))
`;
  return JSON.parse(execFileSync('python3', ['-c', script, file], { encoding: 'utf8' }));
}

let browser;
try {
  const add = async (rel, folder) => {
    const file = makeVideo(path.join(dir, rel), { w: 320, h: 180, fps: 30, dur: 2 });
    age(file);
    const { video } = await api('/api/library', 'POST', { path: file });
    await api(`/api/review/${encodeURIComponent(video.slug)}/folder`, 'PUT', { folder });
    return { file, slug: video.slug };
  };
  const spot = await add('Acme/export/spot.mp4', 'Acme/Reels');
  await add('Acme/export/teaser.mp4', 'Acme/Reels');
  await add('Acme/export/cut.mp4', 'Acme/Reels/Cutdowns');
  await add('Other/export/secret.mp4', 'Other');

  browser = await launch();
  const cdp = await browser.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));
  const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  console.log(`download e2e against ${BASE} (store ${dir})`);

  const room = await api('/api/folder-shares', 'POST', { folder: 'Acme/Reels', label: 'Acme marketing', download: 'original' });

  await check('the room offers "Download all" with the number of videos and the size, full width on a phone', async () => {
    await page.evaluateOnNewDocument(() => {
      try {
        localStorage.setItem('vr.guestName', 'Mia');
      } catch {}
    });
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: SHOTS ? 3 : 1, isMobile: true, hasTouch: true });
    await page.goto(`${BASE}/g/${room.token}`, { waitUntil: 'domcontentloaded' });
    const text = await until(() => page.$eval('.g-download', (e) => e.textContent).catch(() => ''), 'the Download all button');
    assert(/Download all/.test(text) && /3 videos/.test(text), text);
    const width = await page.$eval('.g-download .btn', (e) => e.getBoundingClientRect().width);
    assert(width > 300, `button is ${width}px wide on a phone`);
    await shot('01-room-download-phone');
  });

  await check('tapping it downloads one zip: the folder’s videos, original bytes, subfolders kept', async () => {
    await page.click('.g-download a');
    const file = path.join(downloads, await zipIn(/^Reels – \d{4}-\d{2}-\d{2}\.zip$/));
    const entries = readZip(file);
    assert(entries.map((e) => e.name).join(',') === 'Reels/spot_v1.mp4,Reels/teaser_v1.mp4,Reels/Cutdowns/cut_v1.mp4', entries.map((e) => e.name).join(','));
    const { review } = await api(`/api/review/${encodeURIComponent(spot.slug)}`);
    assert(review.versions.length === 1, 'one version');
    assert(entries[0].sha === sha(spot.file), 'spot.mp4 arrives byte for byte');
  });

  await check('the link counts the download under the client’s name', async () => {
    const got = await until(async () => {
      const { shares } = await api(`/api/folder-shares?folder=${encodeURIComponent('Acme/Reels')}`);
      const s = shares.find((x) => x.token === room.token);
      return s?.stats.downloads ? s : null;
    }, 'a counted download');
    assert(got.stats.downloads === 1, `downloads ${got.stats.downloads}`);
    assert(got.stats.recent_downloads.at(-1).name === 'Mia', JSON.stringify(got.stats.recent_downloads));
  });

  await check('the owner downloads a folder from the library’s folder menu', async () => {
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 });
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    // Folder actions show when the row is hovered, as with a mouse.
    // the projects list renders after the top items (and Recent): wait for the row itself
    await page.waitForFunction(() => [...document.querySelectorAll('.nav-item')].some((el) => el.textContent.trim().startsWith('Other')), { timeout: 15000 });
    const row = await page.evaluateHandle(() => [...document.querySelectorAll('.nav-item')].find((el) => el.textContent.trim().startsWith('Other')));
    assert(row.asElement(), 'the Other folder is in the sidebar');
    await row.asElement().hover();
    const trigger = await row.asElement().waitForSelector('button[aria-label="Project actions"]', { visible: true });
    await trigger.click();
    const item = await until(
      () =>
        page.$$('[role="menuitem"]').then(async (items) => {
          for (const it of items) if ((await it.evaluate((e) => e.textContent)).includes('Download project')) return it;
          return null;
        }),
      'the Download project item (Other is a project: the menu names what it acts on)',
    );
    // Radix places the menu a frame after it opens (until then it waits off-screen): click once it is in place.
    await page.waitForFunction(() => [...document.querySelectorAll('[data-radix-popper-content-wrapper]')].every((w) => !w.style.transform.includes('-200%')));
    await shot('02-folder-menu');
    await item.click();
    const file = path.join(downloads, await zipIn(/^Other – \d{4}-\d{2}-\d{2}\.zip$/));
    const names = readZip(file).map((e) => e.name);
    assert(names.join(',') === 'Other/secret_v1.mp4', names.join(','));
  });

  await check('no page errors along the way', async () => {
    assert(!errors.length, errors.join(' | '));
  });
} catch (e) {
  crashed(e, srv);
} finally {
  await finish(LABEL, { browser, servers: [srv] });
}
