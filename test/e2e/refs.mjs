#!/usr/bin/env node
// covers: web/src/refs/ web/src/guest/GuestNotes.tsx web/src/styles/refs.css server/routes/refs.ts lib/refs.ts lib/refLine.ts
// Browser end-to-end test of references on notes: a real server (local mode, temp store, free port) + headless Chrome.
// The owner's composer takes an image through the paperclip, a clip dropped on it, an image pasted into it and a
// moment picked in the frame picker (an older version of the same video); anything else dropped is refused. The note
// shows them as a row of tiles; the viewer shows an image, plays a clip, and opens a frame reference in the player at
// exactly its frame (compared with ffmpeg's decoded frame), in place for this video and through the address for
// another one. In edit mode a link is added, a caption set and a reference removed. A client attaches an image on a
// review link and sees neither the agent's references nor moments of videos the link doesn't cover. Everything fits
// at phone, tablet and desktop in both themes.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { age, FFMPEG, makeVideo, sleep, until } from '../lib/helpers.ts';
import { layoutMatrix } from './layout.mjs';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { closestFrame, shownPicture } from './lib/frames.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'refs e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-refs-e2e-', user: 'Sam' });
const { dir, base: BASE } = srv;

const api = jsonApi(BASE);
const enc = encodeURIComponent;
const ffmpeg = (...args) => execFileSync(FFMPEG, ['-v', 'error', ...args, '-y']);

let browser;
let page;
screenshotFailures(() => page, 'refs');
try {
  // spot.mp4: V1 (kept aside for ffmpeg), then a re-render; other.mp4 for a moment of another video.
  const file = makeVideo(path.join(dir, 'Acme/export/spot.mp4'), { w: 320, h: 180, fps: 30, dur: 3, pattern: 'testsrc2' });
  age(file);
  const v1 = path.join(dir, 'spot-v1.mp4');
  fs.copyFileSync(file, v1);
  const { video } = await api('/api/library', 'POST', { path: file, folder: 'Acme/Reels' });
  const slug = video.slug;
  makeVideo(file, { w: 320, h: 180, fps: 30, dur: 3, pattern: 'testsrc', freq: 660 });
  age(file);
  await api(`/api/review/${enc(slug)}/sync`, 'POST', {});
  const ofile = makeVideo(path.join(dir, 'Acme/export/other.mp4'), { w: 320, h: 180, fps: 30, dur: 3, pattern: 'testsrc2' });
  age(ofile);
  const other = (await api('/api/library', 'POST', { path: ofile, folder: 'Acme/Reels' })).video.slug;

  // What gets attached: two pictures, a short clip, and a text file that isn't one.
  const media = path.join(dir, 'media');
  fs.mkdirSync(media);
  const shot = (n) => path.join(media, n);
  ffmpeg('-f', 'lavfi', '-i', 'color=c=0xd9822b:s=400x300', '-frames:v', '1', shot('grade.png'));
  ffmpeg('-f', 'lavfi', '-i', 'smptebars=s=480x270', '-frames:v', '1', shot('bars.png'));
  ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', shot('motion.mp4'));
  ffmpeg('-f', 'lavfi', '-i', 'color=c=0x2b6cd9:s=360x240', '-frames:v', '1', shot('client.jpg'));
  fs.writeFileSync(shot('notes.txt'), 'not a picture');
  const b64 = (n) => fs.readFileSync(shot(n)).toString('base64');
  const review = async (s = slug) => (await api(`/api/review/${enc(s)}`)).review;

  browser = await launch();
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const snap = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `refs-${name}.png`) });
  const clickText = (sel, text) =>
    page.evaluate(
      (sel, text) => {
        const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === text);
        if (!el) throw new Error(`no ${sel} with "${text}"`);
        el.click();
      },
      sel,
      text,
    );
  const videoReady = () =>
    page.waitForFunction(
      () => {
        const v = document.querySelector('.vbox video');
        return v && v.readyState >= 2 && !v.seeking;
      },
      { polling: 100, timeout: 20000 },
    );
  // The composer's paperclip is one menu: image or clip, link, frame from a video. A press lands where the paperclip is
  // when it is sent: it waits until the paperclip holds still (the composer coming in, the link field going, a card's
  // pictures arriving above it) and is what a press at its middle reaches; if its menu still doesn't open, the failure
  // says where the press went.
  const attach = async (item, scope = '.composer') => {
    const clip = `${scope} [data-testid=ref-attach]`;
    const ready = await page.evaluate(
      (sel) =>
        new Promise((resolve) => {
          const t0 = performance.now();
          document.querySelector(sel)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          let last = '';
          const tick = () => {
            const el = document.querySelector(sel);
            const r = el?.getBoundingClientRect();
            const box = r ? [r.x, r.y, r.width, r.height].map(Math.round).join() : '';
            const hit = r && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            if (box && box === last && !el.disabled && el.contains(hit)) resolve('');
            else if (performance.now() - t0 > 10000) resolve(`box ${box}, disabled ${el?.disabled}, at its middle ${hit?.outerHTML.slice(0, 120)}`);
            else {
              last = box;
              requestAnimationFrame(tick);
            }
          };
          requestAnimationFrame(tick);
        }),
      clip,
    );
    assert(!ready, `the paperclip never held still under a press: ${ready}`);
    await page.click(clip);
    await page.waitForSelector('.menu[data-state=open]', { timeout: 10000 }).catch(async (e) => {
      const at = await page.$eval(clip, (el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        const menus = [...document.querySelectorAll('.menu')].map((m) => m.dataset.state).join() || 'none';
        return `paperclip ${el.getAttribute('aria-expanded')}, menus ${menus}, at its middle ${hit?.outerHTML.slice(0, 120)}, focus ${document.activeElement?.outerHTML.slice(0, 80)}`;
      });
      throw new Error(`${e.message} (${at})`);
    });
    for (const h of await page.$$('.menu[data-state=open] [role^=menuitem]'))
      if ((await h.evaluate((e) => e.textContent.trim())).startsWith(item)) return h.click();
    throw new Error(`no "${item}" in the paperclip's menu`);
  };
  const openPlayer = async (s = slug, query = '') => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${enc(s)}${query}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.note, .side-empty');
    await videoReady();
  };
  // A file handed to the page the way a drop or a paste carries it.
  const carry = (sel, type, name, mime, data) =>
    page.evaluate(
      (sel, type, name, mime, data) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], name, { type: mime }));
        const el = document.querySelector(sel);
        if (type === 'paste') el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
        else {
          el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
          el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        }
      },
      sel,
      type,
      name,
      mime,
      data,
    );
  const cardOf = async (id) => {
    for (const h of await page.$$('.note')) if ((await h.$eval('.c-id', (e) => e.textContent).catch(() => '')) === id) return h;
    throw new Error(`no card for ${id}`);
  };
  const pendingCount = () => page.$$eval('.composer [data-testid=ref-pending]', (els) => els.length);
  // The player shows exactly ffmpeg's frame n of `src` (closest of n-1, n, n+1 on a small grey copy).
  const showsFrame = async (src, n) => {
    await videoReady();
    await sleep(300);
    const best = closestFrame(src, await shownPicture(page), n, Number.POSITIVE_INFINITY);
    assert(best.k === n, `shows f${best.k}, not f${n} (${best.line})`);
  };

  console.log(`refs e2e against ${BASE} (store ${dir})`);
  let noteId = '';

  await check('the composer takes an image (paperclip), a clip (drop) and an image (paste); other files are refused', async () => {
    await openPlayer();
    await page.keyboard.press('c');
    await page.waitForSelector('.composer textarea');
    const input = await page.$('.composer [data-testid=ref-file]');
    await input.uploadFile(shot('grade.png'));
    await until(async () => (await pendingCount()) === 1, 'paperclip image pending');
    await carry('.composer', 'drop', 'motion.mp4', 'video/mp4', b64('motion.mp4'));
    await until(async () => (await pendingCount()) === 2, 'dropped clip pending');
    await carry('.composer textarea', 'paste', 'bars.png', 'image/png', b64('bars.png'));
    await until(async () => (await pendingCount()) === 3, 'pasted image pending');
    await carry('.composer', 'drop', 'notes.txt', 'text/plain', b64('notes.txt'));
    await sleep(300);
    assert((await pendingCount()) === 3, 'a text file is not a reference');
    // The pending tiles show what was picked: the pictures themselves.
    const previews = await page.$$eval('.composer [data-testid=ref-pending] img', (els) => els.length);
    assert(previews === 2, `${previews} picture previews`);
  });

  await check('the frame picker adds a moment of an older version, at the frame ffmpeg grabs', async () => {
    await attach('Frame from a video…');
    await page.waitForSelector('[data-testid=frame-picker]');
    await page.click('[data-testid=frame-picker] [aria-label="Version"]');
    await page.waitForSelector('[role=option]');
    await clickText('[role=option]', 'V1');
    await page.waitForFunction(() => !document.querySelector('[data-radix-select-viewport]'));
    await page.focus('[data-testid=frame-picker] [role=slider][aria-label="Frame"]');
    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowRight');
    await page.type('[data-testid=frame-picker] input[aria-label="Caption"]', 'This move, like V1');
    await page.waitForFunction(
      () => {
        const img = document.querySelector('.fpick-stage img');
        return img?.complete && img.naturalWidth > 0 && /[?&]frame=12\b/.test(img.src) && /[?&]v=1\b/.test(img.src);
      },
      { timeout: 15000 },
    );
    await sleep(200);
    await snap('02-frame-picker');
    await page.click('[data-testid=fpick-add]');
    await until(async () => (await pendingCount()) === 4, 'moment pending');
    await page.type('.composer textarea', 'Timing like the reference');
    await sleep(200);
    await snap('01-composer');
  });

  await check('saving sends everything: the note carries the four references', async () => {
    await page.keyboard.down('Meta');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Meta');
    await page.waitForFunction(() => !document.querySelector('.composer'), { polling: 100, timeout: 30000 });
    let c;
    await until(
      async () => {
        c = (await review()).comments.find((x) => x.text === 'Timing like the reference');
        return c?.refs?.length === 4;
      },
      'four references stored',
      60000,
    );
    noteId = c.id;
    const kinds = c.refs.map((r) => r.kind).sort();
    assert(kinds.join(',') === 'clip,frame,image,image', kinds.join(','));
    const frame = c.refs.find((r) => r.kind === 'frame');
    assert(frame.video === slug && frame.v === 1 && frame.frame === 12, JSON.stringify(frame));
    assert(frame.caption === 'This move, like V1', frame.caption);
    const clip = c.refs.find((r) => r.kind === 'clip');
    assert(clip.duration > 1.5 && clip.strip, JSON.stringify(clip));
    assert(
      c.refs.every((r) => r.by === 'Sam'),
      c.refs.map((r) => r.by).join(','),
    );
    await until(async () => (await page.$$('.note [data-testid=refs] > li')).length === 4, 'four tiles on the card');
  });

  await check('a link typed under the text (the paperclip’s Link…): Esc puts the field away, ↵ adds it, it goes with the note', async () => {
    await page.keyboard.press('c');
    await page.waitForSelector('.composer textarea');
    await page.type('.composer textarea', 'The pace of this site');
    await attach('Link…');
    await page.waitForSelector('.composer .ref-link-row input');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.ref-link-row'));
    assert(await page.$('.composer'), 'Esc in the link field keeps the composer');
    await attach('Link…');
    await page.waitForSelector('.composer .ref-link-row input');
    await page.type('.composer .ref-link-row input', 'https://example.com/pace');
    await page.keyboard.press('Enter');
    await until(async () => (await pendingCount()) === 1, 'the link pending');
    assert(!(await page.$('.ref-link-row')), 'the field goes once the link is in');
    await page.click('.composer textarea');
    await page.keyboard.down('Meta');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Meta');
    let c;
    await until(async () => {
      c = (await review()).comments.find((x) => x.text === 'The pace of this site');
      return c?.refs?.length === 1;
    }, 'the note with its link');
    assert(c.refs[0].kind === 'link' && c.refs[0].url === 'https://example.com/pace', JSON.stringify(c.refs[0]));
  });

  // Three references for the screenshots of a note with some (and the client's view later): an agent's image, a
  // link, and a moment of another video.
  const three = await api(`/api/review/${enc(slug)}/comments`, 'POST', { v: 2, frame: 40, severity: 'should', text: 'Colour and pace like these' });
  await api(`/api/comments/${three.id}/refs`, 'POST', { kind: 'file', data: b64('grade.png'), caption: 'This warmth', by: 'agent:grade' });
  await api(`/api/comments/${three.id}/refs`, 'POST', { kind: 'link', url: 'https://example.com/moodboard', caption: 'Moodboard' });
  await api(`/api/comments/${three.id}/refs`, 'POST', { kind: 'frame', video: other, v: 1, frame: 20, caption: 'Cut on the beat' });

  await check('the viewer shows an image and plays a clip', async () => {
    await openPlayer(slug, `?c=${noteId}`);
    const card = `.note [data-testid=refs]`;
    await page.waitForSelector(card);
    await page.click(`${card} [data-testid=ref-image] .ref-box`);
    await page.waitForSelector('[data-testid=ref-viewer][data-kind=image] img');
    await page.waitForFunction(() => document.querySelector('[data-testid=ref-viewer] img')?.naturalWidth > 0);
    await sleep(200);
    await snap('03-viewer-image');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-testid=ref-viewer]'));
    await page.click(`${card} [data-testid=ref-clip] .ref-box`);
    await page.waitForFunction(() => document.querySelector('[data-testid=ref-viewer] video')?.readyState >= 2, { timeout: 15000 });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-testid=ref-viewer]'));
  });

  await check('a moment of this video opens in place: V1, exactly frame 12', async () => {
    await page.click('.note [data-testid=ref-frame] .ref-box');
    await page.waitForSelector('[data-testid=ref-viewer][data-kind=frame] img');
    await sleep(200);
    await snap('04-viewer-frame');
    await page.click('[data-testid=ref-open]');
    await until(async () => (await page.$eval('[data-testid=version-picker] .vpick-v', (e) => e.textContent)) === 'V1', 'V1 shown');
    await until(async () => (await page.$eval('.tc .main', (e) => e.textContent).catch(() => '')) === '00:00:12', 'on frame 12');
    await showsFrame(v1, 12);
  });

  await check('a moment of another video opens it through the address, at exactly its frame', async () => {
    await openPlayer(slug, `?c=${three.id}`);
    const card = await cardOf(three.id);
    await card.waitForSelector('[data-testid=ref-link]');
    await card.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await sleep(200);
    await snap('05-note-with-three');
    await (await card.$('[data-testid=ref-frame] .ref-box')).click();
    await page.waitForSelector('[data-testid=ref-open]');
    await page.click('[data-testid=ref-open]');
    await until(async () => decodeURIComponent(await page.evaluate(() => location.hash)).includes(`/v/${other}?v=1&f=20`), 'the address of the other video');
    await page.waitForSelector('.vbox video');
    await until(async () => (await page.$eval('.tc .main', (e) => e.textContent).catch(() => '')) === '00:00:20', 'on frame 20');
    await showsFrame(ofile, 20);
  });

  await check('edit mode: a link is added, a caption set, a reference removed', async () => {
    await openPlayer(slug, `?c=${noteId}`);
    const card = await cardOf(noteId);
    await (await card.$('.c-text')).click();
    await (await card.$('button[aria-label^="Actions"]')).click();
    await page.waitForSelector('[role=menuitem]');
    await clickText('[role=menuitem]', 'Edit text');
    await page.waitForSelector('.note.active .note-edit textarea');
    await page.click('.note.active [data-testid=ref-link]');
    await page.waitForSelector('.ref-link-form input');
    await page.type('.ref-link-form input', 'https://example.com/look');
    await page.keyboard.press('Enter');
    await until(async () => (await page.$$('.note.active [data-testid=ref-pending]')).length === 1, 'link pending');
    // Caption the pasted image (the second image), remove the clip.
    const caps = await page.$$('.note.active [data-testid=refs] .ref-cap-edit');
    assert(caps.length === 4, `${caps.length} caption fields`);
    const images = await page.$$('.note.active [data-testid=ref-image] .ref-cap-edit');
    await images[1].type('Bars as a guide');
    await page.keyboard.press('Enter');
    await until(async () => (await review()).comments.find((x) => x.id === noteId).refs.some((r) => r.caption === 'Bars as a guide'), 'caption saved');
    await page.click('.note.active [data-testid=ref-clip] .ref-remove');
    await until(async () => !(await review()).comments.find((x) => x.id === noteId).refs.some((r) => r.kind === 'clip'), 'clip removed');
    await page.focus('.note.active .note-edit textarea');
    await page.keyboard.down('Meta');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Meta');
    await until(
      async () => (await review()).comments.find((x) => x.id === noteId).refs.some((r) => r.kind === 'link' && r.url === 'https://example.com/look'),
      'link saved',
    );
    const c = (await review()).comments.find((x) => x.id === noteId);
    assert(
      c.refs
        .map((r) => r.kind)
        .sort()
        .join(',') === 'frame,image,image,link',
      c.refs.map((r) => r.kind).join(','),
    );
    const gone = path.join(srv.env.VR_DATA, slug, 'refs');
    assert(
      fs.readdirSync(gone).every((f) => !f.endsWith('.mp4')),
      'the clip file is gone',
    );
  });

  const link = await api(`/api/review/${enc(slug)}/shares`, 'POST', { label: 'Client' });

  await check('a client attaches an image on a review link; agents’ references and other videos stay hidden', async () => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/g/${link.token}`, { waitUntil: 'domcontentloaded' });
    await videoReady();
    await page.waitForSelector('.g-composer textarea');
    await page.type('.g-composer textarea', 'Warmer, like this');
    const input = await page.$('.g-composer [data-testid=ref-file]');
    await input.uploadFile(shot('client.jpg'));
    await until(async () => (await page.$$('.g-composer [data-testid=ref-pending]')).length === 1, 'client image pending');
    await clickText('.g-composer button', 'Add note');
    // the first note asks for the name in the composer; ↵ there sends the note with its image
    await page.waitForSelector('.g-composer .g-name input');
    await page.type('.g-composer .g-name input', 'Mia');
    await page.keyboard.press('Enter');
    let c;
    await until(
      async () => {
        c = (await review()).comments.find((x) => x.text === 'Warmer, like this');
        return c?.refs?.length === 1;
      },
      'the client’s image stored',
      30000,
    );
    assert(c.author === 'guest:Mia' && c.refs[0].by === 'guest:Mia', `${c.author} ${c.refs[0].by}`);
    assert(c.refs[0].share === link.id && c.refs[0].kind === 'image', JSON.stringify(c.refs[0]));
    await until(async () => (await page.$$('.g-note [data-testid=ref-image]')).length >= 1, 'the client sees the image');
    // The agent's image and the other video's moment are not for clients; files come through the link only.
    const html = await page.content();
    assert(!html.includes('This warmth') && !html.includes('Cut on the beat'), 'agent and other-video references hidden');
    const srcs = await page.$$eval('[data-testid=refs] img', (els) => els.map((e) => e.getAttribute('src')));
    assert(srcs.length && srcs.every((x) => x.startsWith(`/api/g/`)), srcs.join(' '));
    await sleep(300);
    await snap('06-client');
  });

  await check('everything fits at phone, tablet and desktop, dark and light', async () => {
    const out = await layoutMatrix(page, {
      player: () => openPlayer(slug, `?c=${three.id}`),
      client: async () => {
        await page.goto('about:blank');
        await page.goto(`${BASE}/g/${link.token}`, { waitUntil: 'domcontentloaded' });
        await videoReady();
      },
    });
    assert(!out.length, out.join('\n'));
  });

  if (SHOTS)
    await check('screenshots: dark and light at 1440 and 390', async () => {
      for (const theme of ['dark', 'light'])
        for (const width of [1440, 390]) {
          const tag = `${theme}-${width}`;
          await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
          await page.setViewport(width === 390 ? { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { width, height: 900 });
          await openPlayer(slug, `?c=${noteId}`);
          if (width === 390) {
            await page.click('.nsheet-handle');
            await page.waitForSelector('.nsheet-half');
          }
          await sleep(500);
          await snap(`note-${tag}`);
          // Phones keep the notes in a sheet: a step that can't be reached there is skipped, and said so.
          const step = async (name, fn) => fn().catch((e) => console.log(`    (no ${name} shot at ${tag}: ${e.message.split('\n')[0]})`));
          await step('viewer', async () => {
            await page.click('.note [data-testid=ref-image] .ref-box');
            await page.waitForSelector('[data-testid=ref-viewer] img');
            await sleep(400);
            await snap(`viewer-${tag}`);
            await page.keyboard.press('Escape');
            await page.waitForFunction(() => !document.querySelector('[data-testid=ref-viewer]'));
          });
          await step('composer', async () => {
            await page.keyboard.press('c');
            await page.waitForSelector('.composer [data-testid=ref-attach]', { timeout: 3000 });
            await (await page.$('.composer [data-testid=ref-file]')).uploadFile(shot('grade.png'));
            await carry('.composer', 'drop', 'motion.mp4', 'video/mp4', b64('motion.mp4'));
            await page.type('.composer textarea', 'Timing like the reference');
            await page.$eval('.composer .ref-pending', (e) => e.scrollIntoView({ block: 'center' }));
            await sleep(400);
            await snap(`composer-${tag}`);
            await attach('Frame from a video…');
            await page.waitForSelector('.fpick-stage img');
            await sleep(600);
            await snap(`picker-${tag}`);
          });
          await page.goto('about:blank');
          await page.goto(`${BASE}/g/${link.token}`, { waitUntil: 'domcontentloaded' });
          await videoReady();
          await sleep(500);
          await snap(`client-${tag}`);
        }
      await page.setViewport({ width: 1440, height: 900 });
    });

  await check('no page errors along the way', async () => {
    assert(!errors.length, errors.join(' | '));
  });
} catch (e) {
  crashed(e, srv);
} finally {
  await finish(LABEL, { browser, servers: [srv] });
}
