#!/usr/bin/env node
// covers: web/src/embed/ web/embed.html web/src/styles/embed.css web/src/share/ShareModal.tsx web/src/share/LinkCard.tsx web/src/share/LinkSettings.tsx web/src/share/embedCode.ts server/routes/shares/embed.ts server/guard.ts web/src/player/usePlayback.ts web/src/lib/seek.ts
// Browser end-to-end test of an Embed link: a real server (local mode, temp store, free port), headless Chrome, and a
// page on another origin (another host and port) that pastes the code the share dialog copies. Share → Embed on a
// video: the settings an embed doesn't take are off and fixed, Create copies the code, and the link's line opens with
// it. In the other site's page the frame keeps the video's shape, plays, and steps frame by frame — each picture
// ffmpeg's decode of that frame, the timecode the app's —; J K L, Space, M and F (full screen) work; chapters stand on
// the timeline as keyframe glyphs (a press on one goes to its first frame, pointing names it); captions show what is
// said; the Lampo mark is there. The embed sets no cookie and keeps nothing in the browser. Revoking ends it where it
// is open. At 390, 768 and 1440 in both colour schemes of the page around it, the player looks the same: dark, like a
// player. Screenshots land in VR_SHOTS when it is set.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { render, score } from '../../scripts/demo/media.ts';
import { age, FFMPEG, freePort, makeShotsVideo, until } from '../lib/helpers.ts';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { closestFrame, SH, SW } from './lib/frames.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'embed e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-embed-e2e-', user: 'Sam' });
const { dir, env, base: BASE } = srv;
const api = jsonApi(BASE);
const N = 120; // makeShotsVideo: 25 fps, 4.8 s; testsrc2 moves on every frame, so a picture names its frame
const tc = (f, fps) => {
  const sec = Math.floor((f + 1e-6) / fps);
  const ff = f - Math.ceil(sec * fps - 1e-6);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(sec / 60) % 60)}:${p(sec % 60)}:${p(ff)}`;
};

/** `file` with chapter markers at these seconds (as an editor exports them), beside it. */
function chaptered(file, marks, out) {
  const meta = `${file}.chapters.txt`;
  const ends = [...marks.slice(1).map((m) => m[0]), marks.at(-1)[0] + 2];
  fs.writeFileSync(
    meta,
    `;FFMETADATA1\n${marks.map(([at, title], i) => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(at * 1000)}\nEND=${Math.round(ends[i] * 1000)}\ntitle=${title}\n`).join('')}`,
  );
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-i', meta, '-map', '0', '-map_metadata', '1', '-map_chapters', '1', '-c', 'copy', '-y', out]);
  return out;
}

let browser;
let page;
let host;
screenshotFailures(() => page, 'embed');
try {
  // A frame-exact clip (every frame its own picture) with three chapters, and a film made like a real one (1920×1080,
  // 24 fps, gradients, grain, a letterbox, titles) with four chapters and what is said in it.
  const steps = chaptered(
    makeShotsVideo(path.join(dir, 'renders/steps.mp4')),
    [
      [0, 'Cold open'],
      [1.6, 'Red'],
      [3.2, 'Blue'],
    ],
    path.join(dir, 'Promo/export/steps.mp4'),
  );
  age(steps);
  const raw = render({
    file: path.join(dir, 'renders/film.mp4'),
    w: 1920,
    h: 1080,
    fps: 24,
    dur: 8,
    letterbox: 120,
    gradient: 'c0=0x0b1626:c1=0x1d3a57:c2=0xb86f48:c3=0x0b1626:n=4:type=radial:speed=0.05:seed=7',
    audio: score(92, 146.83),
    captions: [
      { text: 'The long way home', from: 0.3, to: 3.6, size: 112, y: '(h/2)-60' },
      { text: 'Every mile, on the record.', from: 4, to: 7.6, size: 84, y: '(h-text_h)/2' },
    ],
  });
  const film = chaptered(
    raw,
    [
      [0, 'Opening'],
      [2, 'The long way home'],
      [4, 'On the record'],
      [6.5, 'End card'],
    ],
    path.join(dir, 'Promo/export/launch-film.mp4'),
  );
  age(film);
  const { video: stepsVideo } = await api('/api/library', 'POST', { path: steps });
  const { video: filmVideo } = await api('/api/library', 'POST', { path: film });
  // what is said in the film, heard before (the server keeps a version's transcript by its render key)
  const review = await api(`/api/review/${encodeURIComponent(filmVideo.slug)}`);
  const ver = review.review.versions[0];
  const key = ver.sample || ver.hash;
  fs.mkdirSync(path.join(env.VR_CACHE, 'transcripts'), { recursive: true });
  fs.writeFileSync(
    path.join(env.VR_CACHE, 'transcripts', `${key}.json`),
    JSON.stringify({
      transcript_version: 2,
      hash: ver.hash,
      language: 'en',
      engine: 'local:test',
      timing: 'line',
      fps: 24,
      frames: ver.frames,
      words: [],
      lines: [
        { text: 'Some roads take longer.', t0: 0.4, t1: 3.4, f0: 10, f1: 81, w0: 0, n: 4 },
        { text: 'This one was worth every mile.', t0: 4.1, t1: 7.4, f0: 98, f1: 177, w0: 4, n: 6 },
      ],
      created: '2026-10-06T10:00:00+02:00',
    }),
  );
  const stepsLink = await api(`/api/review/${encodeURIComponent(stepsVideo.slug)}/shares`, 'POST', { label: 'Steps', embed: true });
  const filmLink = await api(`/api/review/${encodeURIComponent(filmVideo.slug)}/shares`, 'POST', { label: 'Homepage', embed: true });

  // The other site: its own host and port, a page as a site makes them, the code pasted into it as copied.
  const hostPort = await freePort();
  const pages = new Map();
  host = http.createServer((req, res) => {
    const html = pages.get(new URL(req.url, 'http://x').pathname);
    if (!html) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
  });
  await new Promise((r) => host.listen(hostPort, '127.0.0.1', r));
  const HOST = `http://localhost:${hostPort}`;
  const site = (name, code, intro = 'Our new film, start to finish.') => {
    pages.set(
      `/${name}`,
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>A site</title><style>:root{color-scheme:light dark}body{margin:0;padding:16px;font:16px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}main{max-width:960px;margin:0 auto}h1{font-size:28px;margin:8px 0 4px}p{margin:0 0 16px;opacity:.7}</style></head><body><main><h1>The long way home</h1><p>${intro}</p>${code}<p style="margin-top:16px">More words under the film.</p></main></body></html>`,
    );
    return `${HOST}/${name}`;
  };
  const embedSnippet = (token, title, ratio = '16/9', query = '') =>
    `<iframe src="${BASE}/e/${token}${query}" title="${title}" style="display:block;width:100%;aspect-ratio:${ratio};border:0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe>`;

  browser = await launch();
  const errors = [];
  const fresh = async (viewport = { width: 1440, height: 900 }) => {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    // pictures at twice the pixels when they are kept (VR_SHOTS)
    await p.setViewport({ deviceScaleFactor: SHOTS ? 2 : 1, ...viewport });
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));
    page = p;
    return p;
  };
  const shot = async (p, name) => SHOTS && p.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  /** The player's frame in the page around it, once its video can show a frame. */
  const player = async (p) => {
    await p.waitForSelector('iframe');
    const frame = await until(() => p.frames().find((f) => f.url().includes('/e/')), 'the player’s frame');
    await frame.waitForSelector('[data-testid=em-player]', { timeout: 20_000 });
    await frame.waitForFunction(
      () => {
        const v = document.querySelector('.em-video');
        return v && v.readyState >= 2 && !v.seeking;
      },
      { polling: 100, timeout: 30_000 },
    );
    return frame;
  };
  const shownFrame = (frame) => frame.$eval('[data-testid=em-tc]', (e) => e.textContent);
  /** What the player's video shows now, small and grey (frames.mjs, inside the frame). */
  const picture = (frame) =>
    frame.evaluate(
      ({ SW, SH }) => {
        const v = document.querySelector('.em-video');
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
      { SW, SH },
    );
  /** The picture is ffmpeg's frame `n` of the render (closer than the frames around it); a busy machine presents a frame a
   * moment after its seek, so a wrong one is looked at again for up to 5 s. */
  const isFrame = async (frame, n, why) => {
    const right = (x) => x.k === n && x.e < 6;
    let got = closestFrame(steps, await picture(frame), n, N);
    for (const t = Date.now(); !right(got) && Date.now() - t < 5000; got = closestFrame(steps, await picture(frame), n, N))
      await new Promise((r) => setTimeout(r, 200));
    assert(right(got), `${why}: should show f${n} (${got.line})`);
    assert((await shownFrame(frame)) === tc(n, 25), `${why}: the timecode says ${await shownFrame(frame)}, not ${tc(n, 25)}`);
  };

  console.log(`embed e2e against ${BASE} (store ${dir}), the other site at ${HOST}`);

  await check('Share → Embed: what an embed doesn’t take is off and fixed, Create copies the code, its line opens with it', async () => {
    const p = await fresh();
    await p.browserContext().overridePermissions(BASE, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
    await p.goto(`${BASE}/#/v/${encodeURIComponent(filmVideo.slug)}`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('[data-testid=share-button]', { timeout: 20_000 });
    await p.click('[data-testid=share-button]');
    await p.waitForSelector('[data-testid=link-name]');
    const kinds = await p.$$eval('.link-new .seg [role=radio], .link-new .seg button', (bs) => bs.map((b) => b.textContent.trim()));
    assert(kinds.join(',') === 'Review,Watch only,Delivery,Embed', `a video’s kinds: ${kinds}`);
    const box = () => p.$eval('.link-new [data-testid=link-details]', (e) => Math.round(e.getBoundingClientRect().height));
    // the dialog grows in from a smaller scale: measure once its entrance has run, or the first height is the scaled one
    await p.waitForFunction(
      () => {
        const d = document.querySelector('[role=dialog]');
        return !!d && d.getAnimations().every((a) => a.playState !== 'running') && d.getBoundingClientRect().width === d.offsetWidth;
      },
      { polling: 50, timeout: 5000 },
    );
    const tall = await box();
    await p.evaluate(() =>
      [...document.querySelectorAll('.link-new .seg [role=radio], .link-new .seg button')].find((b) => b.textContent.trim() === 'Embed').click(),
    );
    await until(
      async () =>
        (await p.$$eval('.link-new .link-set-row', (rs) => rs.map((r) => r.hasAttribute('data-disabled')))).join(',') === 'true,true,true,true,true,false,true',
      'every row but the expiry is fixed',
    );
    assert((await box()) === tall, 'the settings keep their height');
    const pass = await p.$eval('.link-new [data-testid=link-password]', (e) => e.textContent);
    assert(pass.includes('Plays for anyone who sees it'), `the password row says why: ${pass}`);
    await shot(p, 'embed-01-dialog-kind');
    await p.click('[data-testid=link-name]');
    await p.keyboard.type('Website hero');
    await p.click('[data-testid=link-create]');
    await p.waitForSelector('[data-testid=link-embed-code]', { timeout: 10_000 });
    const copied = await until(async () => {
      const t = await p.evaluate(() => navigator.clipboard.readText());
      return t.startsWith('<iframe') ? t : null;
    }, 'the code on the clipboard');
    const token = /\/e\/([A-Za-z0-9_-]+)"/.exec(copied)?.[1];
    assert(token, `the player’s address in the code: ${copied}`);
    assert(
      copied ===
        `<iframe src="${BASE}/e/${token}" title="launch-film.mp4" style="display:block;width:100%;aspect-ratio:16/9;border:0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe>`,
      `the code: ${copied}`,
    );
    const shown = await p.$eval('[data-testid=link-embed-code] pre', (e) => e.textContent);
    assert(shown.replace(/\s+/g, ' ') === copied.replace(/\s+/g, ' '), `the line shows the same code: ${shown}`);
    const line = await p.$eval('.link-row.open .link-sub', (e) => e.textContent);
    assert(line.startsWith('Embed'), `the line names the kind: ${line}`);
    await shot(p, 'embed-02-dialog-code');
    // Copy on the line copies the code again; the menu has the player's address for sites that embed from a URL
    await p.evaluate(() => navigator.clipboard.writeText(''));
    await p.click('.link-row.open [data-testid=link-copy]');
    await until(async () => (await p.evaluate(() => navigator.clipboard.readText())) === copied, 'Copy copies the code');
    const made = (await api(`/api/review/${encodeURIComponent(filmVideo.slug)}/shares`)).shares.find((s) => s.token === token);
    assert(made?.embed && !made.comment && !made.password && made.download === 'off', `an embed: ${JSON.stringify(made)}`);
    // on a phone the dialog is a sheet: the four kinds fit its width, and so does the code (it scrolls inside its box)
    await p.setViewport({ width: 390, height: 844, deviceScaleFactor: SHOTS ? 2 : 1 });
    await until(
      async () =>
        await p.evaluate(() => {
          const seg = document.querySelector('.link-new .seg');
          const sheet = document.querySelector('[role=dialog]');
          if (!seg || !sheet) return false;
          const s = seg.getBoundingClientRect();
          const d = sheet.getBoundingClientRect();
          return seg.scrollWidth <= seg.clientWidth + 0.5 && s.right <= d.right + 0.5 && document.documentElement.scrollWidth <= 390;
        }),
      'the kinds fit a phone',
    );
    await shot(p, 'embed-02-dialog-390');
    await p.close();
  });

  await check('in German the four kinds fit a phone’s sheet too, and an embed says what it doesn’t take', async () => {
    const p = await fresh();
    await p.evaluateOnNewDocument(() => localStorage.setItem('vr.lang', 'de'));
    await p.goto(`${BASE}/#/v/${encodeURIComponent(filmVideo.slug)}`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('[data-testid=share-button]', { timeout: 20_000 });
    await p.click('[data-testid=share-button]');
    await p.waitForSelector('[data-testid=link-name]');
    await p.evaluate(() =>
      [...document.querySelectorAll('.link-new .seg [role=radio], .link-new .seg button')].find((b) => b.textContent.trim() === 'Einbettung').click(),
    );
    await p.waitForFunction(() => document.querySelector('.link-new [data-testid=link-password]')?.textContent.includes('Läuft für alle, die es sehen'));
    await p.setViewport({ width: 390, height: 844, deviceScaleFactor: SHOTS ? 2 : 1 });
    const fit = await until(
      async () =>
        await p.evaluate(() => {
          const seg = document.querySelector('.link-new .seg');
          const sheet = document.querySelector('[role=dialog]');
          if (!seg || !sheet) return null;
          const s = seg.getBoundingClientRect();
          const d = sheet.getBoundingClientRect();
          return { fits: seg.scrollWidth <= seg.clientWidth + 0.5 && s.right <= d.right - 8, right: Math.round(s.right), sheet: Math.round(d.right) };
        }),
      'the dialog in German',
    );
    await shot(p, 'embed-02-dialog-390-de');
    assert(fit.fits, `the kinds fit: ${JSON.stringify(fit)}`);
    await p.close();
  });

  await check('pasted into a page of another site, it keeps the video’s shape, plays, and steps frame by frame: ffmpeg’s frames', async () => {
    const p = await fresh();
    await p.goto(site('steps', embedSnippet(stepsLink.token, 'Steps')), { waitUntil: 'domcontentloaded' });
    const frame = await player(p);
    const size = await p.$eval('iframe', (e) => [e.getBoundingClientRect().width, e.getBoundingClientRect().height]);
    assert(Math.abs(size[1] - (size[0] * 9) / 16) <= 1, `the frame has the video’s shape: ${size}`);
    assert(new URL(frame.url()).origin === BASE && new URL(p.url()).origin === HOST, 'another site frames it');
    // it rests on the poster's frame (a picture, not the black first frame), with one play button
    assert(await frame.$('[data-testid=em-big-play]'), 'the play button');
    await shot(p, 'embed-03-rest-1440');
    await frame.click('[data-testid=em-big-play]');
    await frame.waitForFunction(() => !document.querySelector('.em-video').paused, { timeout: 10_000 });
    await frame.waitForFunction(() => document.querySelector('.em-video').currentTime > 0.5, { timeout: 10_000 });
    await p.keyboard.press('Space');
    await frame.waitForFunction(() => document.querySelector('.em-video').paused && !document.querySelector('.em-video').seeking);
    // where it stopped: the timecode's frame and the picture are one
    const at = await shownFrame(frame);
    const f0 = (() => {
      const [m, s, ff] = at.split(':').map(Number);
      return (m * 60 + s) * 25 + ff;
    })();
    await isFrame(frame, f0, 'paused');
    // the keyboard steps a frame (⇧: ten), the bar's buttons too
    for (const [keys, to] of [
      [['ArrowRight'], f0 + 1],
      [['ArrowRight', 'ArrowRight'], f0 + 3],
      [['ArrowLeft'], f0 + 2],
    ]) {
      for (const k of keys) await p.keyboard.press(k);
      await isFrame(frame, to, keys.join(' '));
    }
    await p.keyboard.down('Shift');
    await p.keyboard.press('ArrowLeft');
    await p.keyboard.up('Shift');
    await isFrame(frame, f0 - 8, '⇧←');
    // a press on the timeline goes to that frame
    const track = await frame.$eval('.em-scrub', (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.left, y: r.top + r.height / 2, w: r.width };
    });
    const target = 100;
    // (the frame's own coordinates are the page's, less the iframe's place in it)
    const off = await p.$eval('iframe', (e) => ({ x: e.getBoundingClientRect().left, y: e.getBoundingClientRect().top }));
    await p.mouse.click(off.x + track.x + (target / (N - 1)) * track.w, off.y + track.y);
    await until(async () => (await shownFrame(frame)) === tc(target, 25), `the timeline to f${target}`);
    await isFrame(frame, target, 'a press on the timeline');
    await shot(p, 'embed-04-paused-1440');
  });

  await check('J K L, Space, M and F as in the player; chapters as keyframe glyphs that name and start their part', async () => {
    const p = await fresh();
    await p.goto(site('keys', embedSnippet(stepsLink.token, 'Steps')), { waitUntil: 'domcontentloaded' });
    const frame = await player(p);
    await frame.click('[data-testid=em-big-play]');
    await frame.waitForFunction(() => !document.querySelector('.em-video').paused, { timeout: 10_000 });
    await p.keyboard.press('k');
    await frame.waitForFunction(() => document.querySelector('.em-video').paused);
    await p.keyboard.press('l');
    await frame.waitForFunction(() => !document.querySelector('.em-video').paused);
    await p.keyboard.press('l');
    await frame.waitForFunction(() => document.querySelector('.em-video').playbackRate === 1.5);
    assert((await frame.$eval('.em-rate', (e) => e.textContent)) === '1.5×', 'the speed is said');
    await p.keyboard.press('k');
    await frame.waitForFunction(() => document.querySelector('.em-video').paused);
    // from a frame with room behind it: J plays backwards, and says so
    await p.keyboard.press('End');
    await until(async () => (await shownFrame(frame)) === tc(N - 1, 25), 'End');
    await p.keyboard.press('j');
    await until(async () => (await shownFrame(frame)) < tc(N - 3, 25), 'J plays backwards');
    assert((await frame.$eval('.em-rate', (e) => e.textContent)) === '◀ 1×', 'backwards is said');
    await p.keyboard.press('k');
    await p.keyboard.press('m');
    await frame.waitForFunction(() => document.querySelector('.em-video').muted);
    await p.keyboard.press('m');
    await frame.waitForFunction(() => !document.querySelector('.em-video').muted);
    // full screen: the page around it allowed it (allowfullscreen)
    await p.keyboard.press('f');
    await frame.waitForFunction(() => !!document.fullscreenElement, { timeout: 5000 });
    await until(
      async () => (await frame.$eval('[data-testid=em-full]', (e) => e.getAttribute('aria-label'))) === 'Exit full screen',
      'the button says how to leave',
    );
    await shot(p, 'embed-05-fullscreen-1440');
    await p.keyboard.press('f');
    await frame.waitForFunction(() => !document.fullscreenElement, { timeout: 5000 });
    // three chapters, two marked on the timeline (the first starts where it does); pointing at the second names it; a
    // press on its glyph starts it (frame 40)
    const glyphs = await frame.$$eval('.em-ch', (gs) => gs.map((g) => g.getBoundingClientRect().left + g.getBoundingClientRect().width / 2));
    assert(glyphs.length === 2, `two glyphs: ${glyphs.length}`);
    const off = await p.$eval('iframe', (e) => ({ x: e.getBoundingClientRect().left, y: e.getBoundingClientRect().top }));
    const y = await frame.$eval('.em-scrub', (e) => e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2);
    await p.mouse.move(off.x + glyphs[0] + 3, off.y + y);
    await frame.waitForSelector('.em-peek-ch');
    assert((await frame.$eval('.em-peek-ch', (e) => e.textContent)) === 'Red', 'pointing names the chapter');
    await shot(p, 'embed-05-chapter-peek-1440');
    await p.mouse.down();
    await p.mouse.up();
    await isFrame(frame, 40, 'a press on a chapter’s glyph');
    assert((await frame.$eval('.em-chapter', (e) => e.textContent)) === 'Red', 'the bar says the chapter');
  });

  await check('captions show what is said, over the bar; the mark leads to Lampo; the player sets no cookie and keeps nothing', async () => {
    const token = filmLink.token;
    const p = await fresh();
    await p.goto(site('film', embedSnippet(token, 'launch-film.mp4')), { waitUntil: 'domcontentloaded' });
    const frame = await player(p);
    await frame.click('[data-testid=em-big-play]');
    await frame.waitForFunction(() => document.querySelector('.em-video').currentTime > 1, { timeout: 10_000 });
    await p.keyboard.press('k');
    await frame.waitForFunction(() => document.querySelector('.em-video').paused);
    // paused inside the first line (0.4–3.4 s): it shows once captions are on, and the line after it further on
    await p.keyboard.press('c');
    await frame.waitForSelector('[data-testid=em-cue]', { timeout: 10_000 });
    const cue = await frame.$eval('[data-testid=em-cue]', (e) => e.textContent);
    assert(cue === 'Some roads take longer.', `the line said there: ${cue}`);
    await p.keyboard.press('End');
    await until(async () => (await frame.$('[data-testid=em-cue]')) === null, 'after the last line, none');
    for (let i = 0; i < 20; i++) await p.keyboard.press('ArrowLeft');
    await until(
      async () => (await frame.$eval('[data-testid=em-cue]', (e) => e.textContent).catch(() => '')) === 'This one was worth every mile.',
      'the second line',
    );
    assert((await frame.$eval('[data-testid=em-captions]', (e) => e.getAttribute('aria-pressed'))) === 'true');
    const mark = await frame.$eval('[data-testid=em-mark]', (e) => ({ href: e.href, rel: e.rel, target: e.target, label: e.getAttribute('aria-label') }));
    assert(
      mark.href.startsWith('https://lampo.video') && mark.rel.includes('noreferrer') && mark.target === '_blank' && mark.label === 'Lampo',
      JSON.stringify(mark),
    );
    const kept = await frame.evaluate(() => ({ cookie: document.cookie, local: localStorage.length, session: sessionStorage.length }));
    assert(kept.cookie === '' && kept.local === 0 && kept.session === 0, `nothing kept in the browser: ${JSON.stringify(kept)}`);
    const cookies = await p.browserContext().cookies();
    assert(cookies.length === 0, `no cookie: ${JSON.stringify(cookies)}`);
  });

  await check('at 390, 768 and 1440, in both colour schemes of the page around it, the player is the same dark player and fits', async () => {
    const token = filmLink.token;
    const url = site('look', embedSnippet(token, 'launch-film.mp4'));
    const looks = {};
    for (const width of [390, 768, 1440]) {
      for (const theme of ['dark', 'light']) {
        const p = await fresh({ width, height: width === 390 ? 844 : 900, ...(width === 390 ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
        await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
        await p.goto(url, { waitUntil: 'domcontentloaded' });
        const frame = await player(p);
        const at = `${width} ${theme}`;
        // nothing of the page around it reaches it: the same ground and ink in both
        const look = await frame.$eval('.em', (e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e).color].join(' '));
        looks[width] ??= look;
        assert(looks[width] === look, `${at}: the player looks the same in both schemes (${look} vs ${looks[width]})`);
        const sideways = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        assert(!sideways, `${at}: the page doesn't scroll sideways`);
        await shot(p, `embed-06-rest-${width}-${theme}`);
        // playing with the bar up (a touch shows it with a tap), then paused on a frame with captions on
        await frame.click('[data-testid=em-big-play]');
        await frame.waitForFunction(() => document.querySelector('.em-video').currentTime > 0.6, { timeout: 10_000 });
        if (width === 390) await frame.tap('.em-surface');
        else await frame.hover('.em-surface');
        await frame.waitForSelector('.em[data-bar=shown]');
        await p.keyboard.press('k');
        await frame.waitForFunction(() => document.querySelector('.em-video').paused);
        await p.keyboard.press('c');
        // every control inside the frame, none over another; on a finger every one 44 px to hit
        const bad = await frame.evaluate((touch) => {
          const out = [];
          const room = document.querySelector('.em').getBoundingClientRect();
          const shown = [...document.querySelectorAll('.em-row > *')].filter((e) => getComputedStyle(e).display !== 'none');
          for (const e of shown) {
            const r = e.getBoundingClientRect();
            if (r.left < room.left - 0.5 || r.right > room.right + 0.5) out.push(`${e.className} outside the frame`);
          }
          for (let i = 1; i < shown.length; i++)
            if (shown[i].getBoundingClientRect().left < shown[i - 1].getBoundingClientRect().right - 0.5) out.push(`${shown[i].className} over the one before`);
          if (touch)
            for (const e of [...document.querySelectorAll('.em-row button, .em-row a')].filter((x) => x.getClientRects().length)) {
              const after = getComputedStyle(e, '::after');
              const h = e.getBoundingClientRect().height + (after.content !== 'none' ? Math.max(0, -2 * Number.parseFloat(after.top || '0')) : 0);
              if (h < 43.5) out.push(`${e.getAttribute('aria-label')} is ${h} px to hit`);
            }
          return out;
        }, width === 390);
        assert(!bad.length, `${at}: ${bad.join('; ')}`);
        await shot(p, `embed-07-paused-${width}-${theme}`);
        await p.close();
      }
    }
  });

  await check('a small frame (a wall of films) keeps the bar on one row; autoplay plays muted on a loop', async () => {
    const token = filmLink.token;
    const wall = Array.from({ length: 4 }, (_, i) => `<div>${embedSnippet(token, `Film ${i + 1}`, '16/9', i === 0 ? '?autoplay=1&loop=1' : '')}</div>`).join(
      '',
    );
    const p = await fresh({ width: 1024, height: 900 });
    await p.goto(site('wall', `<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px">${wall}</div>`), {
      waitUntil: 'domcontentloaded',
    });
    const frames = await until(() => {
      const fs = p.frames().filter((f) => f.url().includes('/e/'));
      return fs.length === 4 ? fs : null;
    }, 'four players');
    const first = frames[0];
    await first.waitForSelector('[data-testid=em-player]');
    await first.waitForFunction(() => !document.querySelector('.em-video').paused && document.querySelector('.em-video').muted, { timeout: 15_000 });
    assert(await first.$eval('.em-video', (v) => v.loop), 'on a loop');
    const second = frames[1];
    await second.waitForSelector('[data-testid=em-big-play]');
    await second.click('[data-testid=em-big-play]');
    await second.waitForFunction(() => !document.querySelector('.em-video').paused);
    await second.hover('.em-surface');
    await second.waitForSelector('.em[data-bar=shown]');
    const rows = await second.$eval('.em-row', (e) => [e.scrollWidth <= e.clientWidth + 0.5, Math.round(e.getBoundingClientRect().height)]);
    assert(rows[0] && rows[1] <= 30, `one row in a small frame: ${rows}`);
    await shot(p, 'embed-08-wall-1024');
  });

  await check('revoked, it stops where it is open: the frame says the video isn’t available', async () => {
    const link = await api(`/api/review/${encodeURIComponent(stepsVideo.slug)}/shares`, 'POST', { label: 'Short-lived', embed: true });
    const p = await fresh({ width: 768, height: 900 });
    await p.goto(site('revoke', embedSnippet(link.token, 'Steps')), { waitUntil: 'domcontentloaded' });
    const frame = await player(p);
    await api(`/api/shares/${link.token}`, 'DELETE');
    await frame.goto(frame.url(), { waitUntil: 'domcontentloaded' }).catch(() => {});
    const again = await until(() => p.frames().find((f) => f.url().includes('/e/')), 'the frame again');
    await again.waitForSelector('[data-testid=em-gone]', { timeout: 10_000 });
    assert((await again.$eval('[data-testid=em-gone]', (e) => e.textContent)) === 'This video isn’t available', 'it says so, nothing more');
    await shot(p, 'embed-09-gone-768');
  });

  await check('no script errors on the way', async () => {
    assert(!errors.length, errors.join('\n'));
  });
} catch (e) {
  crashed(e, srv);
}
host?.close();
await finish(LABEL, { browser, servers: [srv] });
