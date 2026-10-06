#!/usr/bin/env node
// covers: web/src/guest/DownloadAll.tsx web/src/guest/Room.tsx web/src/library/downloadFolder.ts
// covers: web/src/styles/downloads.css server/routes/downloads.ts server/routes/shares/ lib/zip.ts
// covers: web/src/library/downloadVersion.ts web/src/library/useVideoMenu.tsx web/src/player/PlayerTopbar.tsx
// Browser end-to-end test of "Download all": a real server (local mode, temp store, free port) + headless Chrome.
// A client on a phone opens a folder link's room, sees "Download all" with the size, taps it and gets one zip with the
// folder's videos (checked by Python's zipfile: every CRC, the original bytes); the link counts the download under
// the client's name; the owner downloads a folder from the library's folder menu. Then one version as its own file:
// "Download V3" in the player's ⋯ and the library card's, the other versions a step further in (a submenu; on a phone
// in the sheet's place), each arriving as rendered under "<video> V<n>.<ext>". Screenshots land in VR_SHOTS.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { age, makeVideo, until } from '../lib/helpers.ts';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir, signedIn } from './lib/browser.mjs';
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
  // Straight from the page's surface: page.screenshot() brings the window to the front first, and the blur that comes
  // with it closes an open submenu (as any focus leaving it does).
  const pageCdp = await page.createCDPSession();
  const shot = async (name) => {
    if (!SHOTS) return;
    const { data } = await pageCdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
  };
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

  // ---------------------------------------------------------------- one version as its own file

  // A linked render with three versions, as an editor's export folder has them.
  const enc = encodeURIComponent;
  const heroFile = path.join(dir, 'Launch/export/Spring launch hero cut 16x9.mp4');
  const heroSha = [];
  let hero = '';
  for (const [i, pattern] of ['testsrc', 'testsrc2', 'smptebars'].entries()) {
    makeVideo(heroFile, { w: 320, h: 180, fps: 30, dur: 2, pattern, freq: 440 + 110 * i });
    age(heroFile, 600 - 120 * i);
    heroSha.push(sha(heroFile));
    if (!hero) {
      hero = (await api('/api/library', 'POST', { path: heroFile })).video.slug;
      await api(`/api/review/${enc(hero)}/folder`, 'PUT', { folder: 'Launch' });
    } else await api(`/api/review/${enc(hero)}/sync`, 'POST');
  }
  const heroName = (v) => `Spring launch hero cut 16x9 V${v}.mp4`;
  // Chrome says what it is about to save (Browser.downloadWillBegin) before a byte arrives.
  const begun = [];
  cdp.on('Browser.downloadWillBegin', (e) => begun.push(e));
  const willSave = (name, after) =>
    until(
      () => begun.slice(after).find((e) => e.suggestedFilename === name),
      async () =>
        `a download named “${name}” (began: ${JSON.stringify(begun.slice(after).map((e) => e.suggestedFilename))}; toasts: ${JSON.stringify(await page.$$eval('[data-testid=toast]', (els) => els.map((e) => e.textContent)))})`,
    );
  const saved = (name) => until(() => (fs.readdirSync(downloads).includes(name) ? path.join(downloads, name) : null), `${name} saved`);
  const MAIN = '.menu:not(.menu-subs)[data-state=open]';
  const SUB = '.menu-subs[data-state=open]';
  const placed = () =>
    page.waitForFunction(() => [...document.querySelectorAll('[data-radix-popper-content-wrapper]')].every((w) => !w.style.transform.includes('-200%')));
  const rows = (menu) => page.$$eval(`${menu} :is([role^=menuitem], .menu-label)`, (els) => els.map((e) => e.textContent.trim()));
  const item = async (menu, label) => {
    for (const h of await page.$$(`${menu} [role^=menuitem]`)) if ((await h.evaluate((e) => e.textContent.trim())) === label) return h;
    throw new Error(`no item “${label}” in ${JSON.stringify(await rows(menu))}`);
  };
  // The player has no account chip: its agent button is there once who is signed in is known (it is role-gated, like
  // the downloads), and a click after a navigation waits for the View Transition to end.
  const playerReady = async () => {
    await page.waitForSelector('[data-testid=agent-button]', { timeout: 20_000 });
    await page.waitForFunction(() => !document.activeViewTransition);
  };
  // A hand moves the pointer across the screen; a submenu stays open while the pointer heads its way, which a pointer
  // that jumps there in one step doesn't show (Radix reads the direction from the moves).
  const moveTo = async (handle) => {
    const b = await handle.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  };
  const moveAndClick = async (handle) => {
    await moveTo(handle);
    await page.mouse.down();
    await page.mouse.up();
  };
  const heroCard = () =>
    until(async () => {
      const h = await page.evaluateHandle(() => [...document.querySelectorAll('.film')].find((e) => e.textContent.includes('Spring launch hero cut')));
      return h.asElement();
    }, 'the video’s card');
  const closeMenus = async () => {
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.menu'));
  };

  await check('the player’s ⋯: Download V3, and the other versions a step further in; each arrives as it was rendered', async () => {
    const { review } = await api(`/api/review/${enc(hero)}`);
    assert(review.versions.length === 3, `three versions: ${review.versions.map((v) => v.v)}`);
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 });
    await page.goto(`${BASE}/#/v/${enc(hero)}`, { waitUntil: 'domcontentloaded' });
    await playerReady();
    await page.click('.p-top [aria-label="More"]');
    await page.waitForSelector(MAIN);
    await placed();
    const main = await rows(MAIN);
    assert(main.includes('Download V3') && main.includes('Download another version'), JSON.stringify(main));
    assert(main.indexOf('Download V3') < main.indexOf('Export notes (PDF)'), `the video before its notes: ${JSON.stringify(main)}`);
    await moveTo(await item(MAIN, 'Download another version'));
    await page.waitForSelector(SUB);
    await placed();
    assert(JSON.stringify(await rows(SUB)) === '["V2","V1"]', `the others, newest first: ${JSON.stringify(await rows(SUB))}`);
    const n = begun.length;
    await moveAndClick(await item(SUB, 'V1'));
    await willSave(heroName(1), n);
    assert(sha(await saved(heroName(1))) === heroSha[0], 'V1 arrives byte for byte');
    await page.waitForFunction(() => !document.querySelector('.menu'));

    await page.click('.p-top [aria-label="More"]');
    await page.waitForSelector(MAIN);
    await placed();
    const toast = page.waitForFunction(
      (name) => [...document.querySelectorAll('[data-testid=toast]')].find((e) => e.textContent.includes(`Downloading ${name} · `))?.textContent,
      {},
      heroName(3),
    );
    await (await item(MAIN, 'Download V3')).click();
    await willSave(heroName(3), n);
    assert(sha(await saved(heroName(3))) === heroSha[2], 'V3 arrives byte for byte');
    await toast;
  });

  await check('on an older version the ⋯ downloads that one, and names the newest among the others', async () => {
    await page.goto(`${BASE}/#/v/${enc(hero)}?v=1`, { waitUntil: 'domcontentloaded' });
    await playerReady();
    await page.waitForSelector('[data-testid=version-picker].older');
    await page.click('.p-top [aria-label="More"]');
    await page.waitForSelector(MAIN);
    assert((await rows(MAIN)).includes('Download V1'), JSON.stringify(await rows(MAIN)));
    await moveTo(await item(MAIN, 'Download another version'));
    await page.waitForSelector(SUB);
    assert(JSON.stringify(await rows(SUB)) === '["V3 · newest","V2"]', JSON.stringify(await rows(SUB)));
    await closeMenus();
  });

  await check('the library card’s ⋯ and right-click: Download V3 and the others a step in; the file is the newest', async () => {
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await signedIn(page);
    const card = await heroCard();
    await card.hover();
    await (await card.$('.film-menu .btn')).click();
    await page.waitForSelector(MAIN);
    await placed();
    const dots = await rows(MAIN);
    assert(dots.includes('Download V3') && dots.includes('Download another version'), JSON.stringify(dots));
    await moveTo(await item(MAIN, 'Download another version'));
    await page.waitForSelector(SUB);
    await placed();
    assert(JSON.stringify(await rows(SUB)) === '["V2","V1"]', JSON.stringify(await rows(SUB)));
    const n = begun.length;
    await moveAndClick(await item(SUB, 'V2'));
    await willSave(heroName(2), n);
    assert(sha(await saved(heroName(2))) === heroSha[1], 'V2 arrives byte for byte');
    await page.waitForFunction(() => !document.querySelector('.menu'));
    // the right-click menu is the same list
    const box = await card.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + 60, { button: 'right' });
    await page.waitForSelector('[data-testid=context-menu] [role^=menuitem]');
    assert(JSON.stringify(await rows('[data-testid=context-menu]')) === JSON.stringify(dots), JSON.stringify(await rows('[data-testid=context-menu]')));
    await closeMenus();
  });

  await check('on a phone the other versions take the sheet’s place, their label leading back; a tap downloads one', async () => {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: SHOTS ? 3 : 1, isMobile: true, hasTouch: true });
    await page.goto(`${BASE}/#/v/${enc(hero)}`, { waitUntil: 'domcontentloaded' });
    await playerReady();
    await page.tap('.p-bar [aria-label="More"]');
    await page.waitForSelector(MAIN);
    const sheet = await rows(MAIN);
    const at = sheet.indexOf('Download V3');
    assert(JSON.stringify(sheet.slice(at, at + 3)) === '["Download V3","Download another version","Export notes (PDF)"]', JSON.stringify(sheet));
    assert(!(await page.$(SUB)), 'no second menu over the sheet');
    // the other versions take the sheet's place; their label leads back
    await (await item(MAIN, 'Download another version')).tap();
    await until(
      async () => JSON.stringify(await rows(MAIN)) === '["Download another version","V2","V1"]',
      async () => `the versions in the sheet: ${JSON.stringify(await rows(MAIN))}`,
    );
    const heights = await page.$$eval(`${MAIN} [role^=menuitem]`, (els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().height)))]);
    assert(heights.length === 1, `the versions are rows like the others: ${heights}`);
    await (await item(MAIN, 'Download another version')).tap();
    await until(async () => (await rows(MAIN)).includes('Download V3'), 'back to the whole sheet');
    await (await item(MAIN, 'Download another version')).tap();
    await until(async () => (await rows(MAIN)).includes('V2'), 'the versions again');
    const n = begun.length;
    await (await item(MAIN, 'V2')).tap();
    await willSave(heroName(2), n);
    await page.waitForFunction(() => !document.querySelector('.menu'));

    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await signedIn(page);
    const card = await heroCard();
    await (await card.$('.film-menu .btn')).tap();
    await page.waitForSelector(MAIN);
    const cardSheet = await rows(MAIN);
    assert(cardSheet.includes('Download V3') && cardSheet.includes('Download another version') && !cardSheet.includes('V1'), JSON.stringify(cardSheet));
    await (await item(MAIN, 'Download another version')).tap();
    await until(
      async () => JSON.stringify(await rows(MAIN)) === '["Download another version","V2","V1"]',
      async () => JSON.stringify(await rows(MAIN)),
    );
    await closeMenus();
    // opened again, the sheet starts at its top
    await (await card.$('.film-menu .btn')).tap();
    await page.waitForSelector(MAIN);
    assert((await rows(MAIN)).includes('Download V3'), JSON.stringify(await rows(MAIN)));
    await closeMenus();
  });

  await check('the menus at 1440 and 390, both themes: the submenu beside its row and on screen; the sheet across the phone', async () => {
    const box = (sel) => page.$eval(sel, (e) => e.getBoundingClientRect().toJSON());
    // The theme as this device keeps it, the page loaded anew (the timeline's canvas is drawn in it too).
    const open = async (url, theme) => {
      await page.evaluate((t) => localStorage.setItem('vr.theme', t), theme);
      await page.goto('about:blank');
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    };
    const card = heroCard;
    for (const theme of ['dark', 'light']) {
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 });
      for (const where of ['player', 'card']) {
        if (where === 'player') {
          await open(`${BASE}/#/v/${enc(hero)}`, theme);
          await playerReady();
          await page.click('.p-top [aria-label="More"]');
        } else {
          await open(`${BASE}/#/`, theme);
          await signedIn(page);
          const c = await card();
          await c.hover();
          await (await c.$('.film-menu .btn')).click();
        }
        await page.waitForSelector(MAIN);
        await placed();
        await moveTo(await item(MAIN, 'Download another version'));
        await page.waitForSelector(SUB);
        await placed();
        // the submenu follows its row while the menu settles (Radix places it again on the next frame)
        await page
          .waitForFunction(
            (main, sub) => {
              const t = document.querySelector(`${main} .menu-sub`)?.getBoundingClientRect();
              const f = document.querySelector(`${sub} [role^=menuitem]`)?.getBoundingClientRect();
              return !!t && !!f && Math.abs(t.top - f.top) <= 1.5;
            },
            { timeout: 5000 },
            MAIN,
            SUB,
          )
          .catch(() => {});
        const [main, sub, trigger, first] = [await box(MAIN), await box(SUB), await box(`${MAIN} .menu-sub`), await box(`${SUB} [role^=menuitem]`)];
        assert(sub.left >= 0 && sub.right <= 1440 && sub.bottom <= 900, `${where}: the submenu is on screen: ${JSON.stringify(sub)}`);
        assert(sub.right <= main.left + 1 || sub.left >= main.right - 1, `${where}: beside the menu, not over it: ${JSON.stringify({ main, sub })}`);
        assert(Math.abs(first.top - trigger.top) <= 1.5, `${where}: its first row level with the row that opened it: ${first.top} vs ${trigger.top}`);
        await shot(`03-${where}-menu-1440-${theme}`);
        await closeMenus();
      }
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: SHOTS ? 3 : 1, isMobile: true, hasTouch: true });
      for (const where of ['player', 'card']) {
        if (where === 'player') {
          await open(`${BASE}/#/v/${enc(hero)}`, theme);
          await playerReady();
          await page.tap('.p-bar [aria-label="More"]');
        } else {
          await open(`${BASE}/#/`, theme);
          await signedIn(page);
          await (await (await card()).$('.film-menu .btn')).tap();
        }
        await page.waitForSelector(MAIN);
        // risen: its entrance played to the end
        await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
        const sheet = await box(MAIN);
        assert(Math.round(sheet.width) === 390 && Math.round(sheet.bottom) === 844, `${where}: a sheet across the phone: ${JSON.stringify(sheet)}`);
        assert(sheet.top >= 0, `${where}: the whole sheet on screen (it scrolls inside when it can't): ${sheet.top}`);
        await shot(`04-${where}-sheet-390-${theme}`);
        await (await item(MAIN, 'Download another version')).tap();
        await until(async () => (await rows(MAIN)).includes('V2'), 'the versions in the sheet');
        await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
        const versions = await box(MAIN);
        assert(
          Math.round(versions.bottom) === 844 && versions.height < sheet.height,
          `${where}: the versions’ sheet is as short as its list: ${versions.height} vs ${sheet.height}`,
        );
        await shot(`05-${where}-versions-390-${theme}`);
        await closeMenus();
      }
    }
    await page.evaluate(() => localStorage.removeItem('vr.theme'));
  });

  await check('no page errors along the way', async () => {
    assert(!errors.length, errors.join(' | '));
  });
} catch (e) {
  crashed(e, srv);
} finally {
  await finish(LABEL, { browser, servers: [srv] });
}
