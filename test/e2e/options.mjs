#!/usr/bin/env node
// covers: web/src/options/ web/src/styles/options.css server/routes/asks.ts lib/asks.ts lib/askOptions.ts
// covers: lib/options.ts lib/choices.ts web/src/library/AskLead.tsx
// Browser e2e of options before a render (web/src/options/; local mode, temp store, headless Chrome): an agent asks on
// a project before its first version — three narrator takes at three levels, three looks — and on a video. In the
// inbox the question opens the audition: each take plays levelled (its gain on the row), A swaps the last two played at
// the same position, Space stops, 1–9 / ↑↓ pick, a look opens large, the free text, Send → the agent's answer line.
// The question leads its project's page (library/AskLead.tsx), above the videos — on an empty project the one orange is
// its Compare and pick, the bell counts it —; the loading state has the loaded layout (nothing moves, as
// quality-load.mjs asks of every screen); a phone in German does the same; the note card in the player opens it too and
// shows the picks. Clips open large inside the dialog (a click or Expand): as large as its box allows at 16:9, ←/→ to the
// next at the same moment, A back to the one before, its pick under it, Esc or All options back to the grid in the same
// box; Play together still plays them all. A long German question with two 9:16 reels and a 16:9 clip reads as one set:
// one box per group with every picture inside it, the words (two lines, then cut, whole in the large view), key and
// pick under the picture and nothing on it but Larger, the pick a flat fill and never orange, sound rows alike; a short
// question's dialog is as tall as what it shows, its free text right under the last group. Synthetic media only: sines
// at three levels, ffmpeg test patterns.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { age, FFMPEG, makeVideo, sleep } from '../lib/helpers.ts';
import { clippedText, fitsAt, settle, sideways } from './layout.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'options e2e';
requireChrome(LABEL);
const srv = await startServer({ prefix: 'vr-options-e2e-', user: 'Sam' });
const { dir, base: BASE } = srv;
const SHOTS = shotsDir();
const api = async (p, method = 'GET', body) => {
  const r = await fetch(BASE + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
};
const media = path.join(dir, 'media');
fs.mkdirSync(media, { recursive: true });
const b64 = (f) => fs.readFileSync(f).toString('base64');
const tone = (name, amplitude, freq = 440) => {
  const f = path.join(media, `${name}.wav`);
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `aevalsrc=${amplitude}*sin(2*PI*${freq}*t):s=48000:d=4`, '-y', f]);
  return f;
};
const look = (name, src) => {
  const f = path.join(media, `${name}.png`);
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `${src}=size=640x360:rate=1`, '-frames:v', '1', '-y', f]);
  return f;
};
/** A 4-second test of an idea: a moving pattern with a tone (an option's clip); `size` 360x640 for a reel. */
const idea = (name, src, freq, size = '640x360') => {
  const f = path.join(media, `${name}.mp4`);
  execFileSync(FFMPEG, [
    ...['-v', 'error', '-f', 'lavfi', '-i', `${src}${src.includes('=') ? ':' : '='}size=${size}:rate=25`],
    ...['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=4`],
    ...['-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', f],
  ]);
  return f;
};
/** Whether a computed colour is the brand's orange family (hue 10–50°, saturated): a pick never wears it. Computed
 * colours come as rgb()/rgba() (0–255) or, from a color-mix(), as color(srgb r g b / a) (0–1). */
const orange = (css) =>
  [
    ...[...String(css).matchAll(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/g)].map(([, r, g, b, a]) => [r / 255, g / 255, b / 255, a]),
    ...[...String(css).matchAll(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/g)].map(([, r, g, b, a]) => [Number(r), Number(g), Number(b), a]),
  ].some(([R, G, B, a]) => {
    if (a !== undefined && Number(a) === 0) return false;
    const max = Math.max(R, G, B);
    const min = Math.min(R, G, B);
    const l = (max + min) / 2;
    const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
    if (s < 0.4 || l < 0.2 || l > 0.85) return false;
    const h = max === R ? (60 * ((G - B) / (max - min)) + 360) % 360 : max === G ? 60 * ((B - R) / (max - min)) + 120 : 60 * ((R - G) / (max - min)) + 240;
    return h >= 10 && h <= 50;
  });
/** A group's sound rows as laid out: each row's box, its words, progress track, play button, time and check. */
const soundRows = (page, group) =>
  page.$$eval(`${group} .aud-row`, (rows) =>
    rows.map((row) => {
      const box = (el) => {
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { t: b.top, b: b.bottom, l: b.left, r: b.right, c: (b.top + b.bottom) / 2, m: (b.left + b.right) / 2 };
      };
      const play = row.querySelector('[data-testid=audition-play]');
      const p = box(play);
      // the play button's reach: points round its middle land on it, well past what it draws
      const reach = p
        ? [-20, 20].every((dx) => document.elementFromPoint(p.m + dx, p.c)?.closest('[data-testid=audition-play]') === play) &&
          [-17, 17].every((dy) => document.elementFromPoint(p.m, p.c + dy)?.closest('[data-testid=audition-play]') === play)
        : false;
      const label = row.querySelector('.aud-label');
      return {
        row: box(row),
        label: box(label),
        lines: Math.round(label.getBoundingClientRect().height / parseFloat(getComputedStyle(label).lineHeight)),
        bar: box(row.querySelector('.aud-bar')),
        play: p,
        // what the play button draws (its glyph), and where the pick (key, words) starts
        glyph: box(play?.querySelector('svg')),
        pick: box(row.querySelector('.aud-pick')),
        reach,
        time: box(row.querySelector('.aud-time')),
        check: box(row.querySelector('.aud-check')),
      };
    }),
  );
/** What is off in narrow sound rows: the track on a line of its own under the words, the play button, time and check
 * beside the words, even room above and below. */
const narrowRowsOff = (rows) => {
  const off = [];
  for (const [i, r] of rows.entries()) {
    const at = `sound row ${i + 1}`;
    if (r.bar.t < r.label.b + 6) off.push(`${at}: the track ${Math.round(r.bar.t - r.label.b)}px under the words`);
    if (r.play.c < r.label.t || r.play.c > r.label.b)
      off.push(`${at}: the play button's middle (${Math.round(r.play.c)}) is beside no words (${Math.round(r.label.t)}–${Math.round(r.label.b)})`);
    for (const [name, b] of [
      ['time', r.time],
      ['check', r.check],
    ])
      if (Math.abs(b.c - r.label.c) > 2) off.push(`${at}: its ${name} is not level with the words (${Math.round(b.c - r.label.c)}px)`);
    const above = r.label.t - r.row.t;
    const below = r.row.b - r.bar.b;
    if (Math.abs(above - below) > 2 || above < 8) off.push(`${at}: room above ${Math.round(above)}px, below ${Math.round(below)}px`);
    if (r.glyph.l - r.row.l > 16) off.push(`${at}: the play glyph stands ${Math.round(r.glyph.l - r.row.l)}px in`);
    if (r.pick.l - r.glyph.r > 20) off.push(`${at}: ${Math.round(r.pick.l - r.glyph.r)}px between the play glyph and the words`);
    if (!r.reach) off.push(`${at}: the play button can't be reached round its middle (a finger's size)`);
  }
  return off;
};
const IPHONE = {
  viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
};
const options = () => [
  {
    id: 'voice',
    label: 'Narrator',
    items: [
      { id: 'v1', label: 'Calm', ref: { kind: 'file', data: b64(tone('v1', 0.5, 330)) } },
      { id: 'v2', label: 'Warm', ref: { kind: 'file', data: b64(tone('v2', 0.08, 440)) } },
      { id: 'v3', label: 'Bright', ref: { kind: 'file', data: b64(tone('v3', 0.9, 550)) } },
    ],
  },
  {
    id: 'look',
    label: 'Look',
    items: [
      { id: 'l1', label: 'Bars', ref: { kind: 'file', data: b64(look('l1', 'smptebars')) } },
      { id: 'l2', label: 'Pattern', ref: { kind: 'file', data: b64(look('l2', 'testsrc2')) } },
      { id: 'l3', label: 'Colours', ref: { kind: 'file', data: b64(look('l3', 'rgbtestsrc')) } },
    ],
  },
];

let browser;
let current = null;
screenshotFailures(() => current, 'options');
try {
  const film = makeVideo(path.join(dir, 'Acme/film/export/spot.mp4'), { dur: 2 });
  age(film);
  const slug = (await api('/api/library', 'POST', { path: film, folder: 'Acme' })).video.slug;
  await api('/api/folders', 'POST', { path: 'Acme/Launch' });
  const ask = (text, extra = {}) =>
    api('/api/asks', 'POST', { folder: 'Acme/Launch', text, options: options(), answer_prompt: 'Anything for the end card?', by: 'agent:sound', ...extra });
  const first = await ask('Before I render the launch film: which narrator, and which look?');

  browser = await launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const open = async (url, { vp = { width: 1440, height: 900 }, lang = null, theme = null, ctx = browser } = {}) => {
    const page = await ctx.newPage();
    current = page;
    if (vp.viewport) await page.emulate(vp);
    else await page.setViewport(vp);
    await page.evaluateOnNewDocument(
      (lang, theme) => {
        if (lang) {
          Object.defineProperty(navigator, 'languages', { get: () => [lang, 'en'] });
          localStorage.setItem('vr.lang', lang.slice(0, 2));
        }
        if (theme) localStorage.setItem('vr.theme', theme);
      },
      lang,
      theme,
    );
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
    return page;
  };
  const shot = async (page, name) => {
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `options-${name}.png`) });
  };
  const rows = (page) =>
    page.$$eval('[data-testid=audition-group]:first-of-type [data-testid=audition-item]', (els) =>
      els.map((el) => ({
        gain: el.dataset.gain === undefined ? null : Number(el.dataset.gain),
        playing: el.dataset.playing === 'true',
        progress: Number(/scaleX\(([\d.]+)\)/.exec(el.querySelector('.aud-bar > span')?.getAttribute('style') || '')?.[1] ?? 0),
      })),
    );
  const checked = (page) => page.$$eval('[data-testid=audition-pick][aria-checked=true]', (els) => els.map((el) => el.dataset.item));
  const playingRow = async (page) => (await rows(page)).findIndex((r) => r.playing);

  let page;
  await check('the inbox opens the question: the audition with every take levelled, the looks as tiles', async () => {
    page = await open('/#/inbox', { theme: 'dark' });
    await page.waitForSelector('[data-testid=inbox-preview] [data-testid=options-ask]', { timeout: 15000 });
    const head = await page.$eval('[data-testid=inbox-preview]', (el) => el.innerText);
    assert(/Launch/.test(head) && /Before the first version/.test(head), head.slice(0, 300));
    assert(/sound asks/.test(head), 'who asks');
    await shot(page, 'inbox-1440');
    await page.click('[data-testid=inbox-preview] [data-testid=options-open]');
    await page.waitForSelector('[data-testid=audition][data-loaded=true]', { timeout: 15000 });
    const r = await rows(page);
    assert(r.length === 3, `${r.length} takes`);
    assert(
      r.every((x) => x.gain !== null),
      `every take has its gain: ${JSON.stringify(r)}`,
    );
    // The quiet take is raised, the one at full scale is not: they meet at one loudness.
    assert(r[1].gain > 10 && r[2].gain <= 0.1, `gains ${r.map((x) => x.gain).join(', ')}`);
    const tiles = await page.$$eval('[data-testid=audition-group]:nth-of-type(2) .aud-tile img', (els) => els.length);
    assert(tiles === 3, `${tiles} looks as tiles`);
    assert((await page.$eval('.aud-note textarea', (t) => t.closest('label').innerText)).includes('Anything for the end card?'), 'the agent’s own prompt');
  });

  await check('a take plays, A swaps to the last other one at the same position, Space stops', async () => {
    await page.click('[data-testid=audition-group]:first-of-type [data-testid=audition-item]:nth-child(2) [data-testid=audition-play]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=audition-item][data-playing=true]').length === 1, { timeout: 5000 });
    assert((await playingRow(page)) === 1, 'Warm plays');
    await page.click('[data-testid=audition-group]:first-of-type [data-testid=audition-item]:nth-child(1) [data-testid=audition-play]');
    await page.waitForFunction(
      () => document.querySelector('[data-testid=audition-group] [data-testid=audition-item]:nth-child(1)')?.dataset.playing === 'true',
      { timeout: 5000 },
    );
    await sleep(1300);
    const before = (await rows(page))[0].progress;
    await page.keyboard.press('a');
    await page.waitForFunction(
      () => document.querySelector('[data-testid=audition-group] [data-testid=audition-item]:nth-child(2)')?.dataset.playing === 'true',
      { timeout: 5000 },
    );
    await sleep(300);
    const after = (await rows(page))[1].progress;
    assert(before > 0.15 && Math.abs(after - before) < 0.2, `the other take went on where this one was: ${before.toFixed(2)} → ${after.toFixed(2)}`);
    assert(await page.$('[data-testid=audition-ab]'), 'A/B is offered once two takes were played');
    await page.keyboard.press(' ');
    await page.waitForFunction(() => !document.querySelector('[data-testid=audition-item][data-playing=true]'), { timeout: 5000 });
  });

  await check('keys pick: 1–9 in the group in focus, ↑↓ between groups; a look opens large and is picked there', async () => {
    await page.keyboard.press('2');
    assert((await checked(page)).join() === 'v2', `picked: ${await checked(page)}`);
    await page.keyboard.press('3');
    assert((await checked(page)).join() === 'v3', 'one pick in a one-pick group');
    await page.keyboard.press('2');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('1');
    assert((await checked(page)).join() === 'v2,l1', `picked: ${await checked(page)}`);
    await page.click('[data-testid=audition-group]:nth-of-type(2) .aud-tile:nth-child(2) .aud-shot');
    await page.waitForSelector('[data-testid=audition-large][data-item=l2] img');
    await page.keyboard.press('ArrowRight');
    await page.waitForSelector('[data-testid=audition-large][data-item=l3] img');
    await shot(page, 'large-1440');
    await page.click('[data-testid=audition-large-pick]');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-testid=audition-large]'));
    assert(await page.$('[data-testid=audition]'), 'the audition stays open');
    assert((await checked(page)).join() === 'v2,l3', `picked: ${await checked(page)}`);
    const status = await page.$eval('[data-testid=audition-status]', (el) => el.textContent);
    assert(status === '2 of 2 picked', status);
  });

  await check('the free text and Send: the agent hears PICKED voice=v2 look=l3 · note: "…"', async () => {
    await page.type('[data-testid=audition-note]', 'lampo.app on the end card');
    await shot(page, 'audition-1440');
    await page.click('[data-testid=audition-send]');
    await page.waitForFunction(() => !document.querySelector('[data-testid=audition]'), { timeout: 10000 });
    const view = await api(`/api/asks/${first.id}`);
    assert(view.status === 'verified', view.status);
    const reply = view.replies.at(-1);
    assert(reply.text === 'PICKED voice=v2 look=l3 · note: "lampo.app on the end card"', reply.text);
    assert(reply.by === 'Sam', reply.by);
    await page.close();
  });

  await check('light theme: the same audition, the pictures on their dark stage', async () => {
    const second = await ask('Second round: which narrator, which look?');
    const p = await open('/#/inbox', { theme: 'light' });
    // its own row: this browser may paint the inbox it kept after the first answer (the other item alone), and the
    // preview it opened by itself stays put when the server's list comes in with the new question above it
    const row = `[data-key="q:${second.id}"]`;
    await p.waitForSelector(row, { timeout: 15000 });
    await p.click(row);
    await p.waitForFunction(
      () =>
        /Second round/.test(document.querySelector('[data-testid=inbox-preview]')?.textContent || '') &&
        !!document.querySelector('[data-testid=inbox-preview] [data-testid=options-open]'),
      { polling: 100, timeout: 15000 },
    );
    await p.click('[data-testid=inbox-preview] [data-testid=options-open]');
    await p.waitForSelector('[data-testid=audition][data-loaded=true]');
    await p.keyboard.press('1');
    await shot(p, 'audition-1440-light');
    const fit = await fitsAt(p, 'audition (light)');
    assert(!fit.length, fit.join('\n'));
    await p.keyboard.press('Escape');
    await api(`/api/asks/${second.id}`, 'DELETE');
    await p.close();
  });

  await check('the folder’s page leads with the question; the audition’s loading state is the loaded layout (nothing moves)', async () => {
    const third = await ask('Third round: which narrator, which look?');
    // a browser that has kept nothing: the answer is held back until its loading state was seen
    const fresh = await browser.createBrowserContext();
    const p = await open(`/#/folder/${encodeURIComponent('Acme/Launch')}`, { ctx: fresh });
    await p.waitForSelector('[data-testid=ask-lead] [data-testid=ask-lead-open]', { timeout: 15000 });
    const line = await p.$eval('[data-testid=ask-lead]', (el) => el.innerText);
    assert(/sound asks/.test(line) && /Third round/.test(line), line);
    assert(/Narrator: 3 sounds/.test(line) && /Look: 3 pictures/.test(line), `what there is to compare: ${line}`);
    await shot(p, 'folder-1440');
    await p.setRequestInterception(true);
    let release;
    const held = new Promise((r) => {
      release = r;
    });
    p.on('request', (req) => {
      if (req.method() === 'GET' && new URL(req.url()).pathname === `/api/asks/${third.id}`) held.then(() => req.continue().catch(() => {}));
      else req.continue().catch(() => {});
    });
    await p.evaluate(() => {
      window.__shift = 0;
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) if (!e.hadRecentInput) window.__shift += e.value;
      }).observe({ type: 'layout-shift', buffered: false });
    });
    await p.click('[data-testid=ask-lead-open]');
    await p.waitForSelector('[data-testid=audition][data-loaded=false] .aud-group.pending');
    const boxes = () =>
      p.evaluate(() => {
        const box = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return [r.left, r.top, r.width, r.height].map(Math.round);
        };
        const groups = [...document.querySelectorAll('.aud-list > .aud-group')];
        return {
          question: box(document.querySelector('.aud-q')),
          heads: groups.map((g) => box(g.querySelector('.aud-ghead h4'))),
          firsts: groups.map((g) => box(g.querySelector('.aud-item'))),
          lasts: groups.map((g) => box(g.querySelector('.aud-item:last-child'))),
          note: box(document.querySelector('.aud-note textarea')),
          send: box(document.querySelector('[data-testid=audition-send]')),
        };
      });
    await sleep(400);
    const loading = await boxes();
    await shot(p, 'loading-1440');
    release();
    await p.waitForSelector('[data-testid=audition][data-loaded=true]');
    await sleep(600);
    const loaded = await boxes();
    const off = [];
    const cmp = (name, a, b) => {
      if (!a || !b) off.push(`${name}: ${a ? 'gone' : 'missing'} while loading`);
      else if (a.some((v, i) => Math.abs(v - b[i]) > 2)) off.push(`${name}: ${a.join(',')} → ${b.join(',')}`);
    };
    cmp('question', loading.question, loaded.question);
    for (const [i, b] of loaded.heads.entries()) cmp(`group ${i + 1} head`, loading.heads[i], b);
    for (const [i, b] of loaded.firsts.entries()) cmp(`group ${i + 1} first item`, loading.firsts[i], b);
    for (const [i, b] of loaded.lasts.entries()) cmp(`group ${i + 1} last item`, loading.lasts[i], b);
    cmp('free text', loading.note, loaded.note);
    cmp('send', loading.send, loaded.send);
    const shift = await p.evaluate(() => window.__shift);
    assert(!off.length && shift < 0.01, `${off.join('\n')}${shift >= 0.01 ? `\nlayout shift ${shift.toFixed(3)}` : ''}`);
    await p.keyboard.press('Escape');
    await fresh.close();
  });

  await check('a phone in German: the folder’s question, the audition in German, a look large, picks by touch, sent', async () => {
    const ctx = await browser.createBrowserContext();
    const p = await open(`/#/folder/${encodeURIComponent('Acme/Launch')}`, { vp: IPHONE, lang: 'de-DE', ctx });
    await p.waitForSelector('[data-testid=ask-lead] [data-testid=ask-lead-open]', { timeout: 15000 });
    const line = await p.$eval('[data-testid=ask-lead]', (el) => el.innerText);
    assert(/sound fragt/.test(line) && /Narrator: 3 Hörproben/.test(line), line);
    const fits = await sideways(p);
    assert(!fits.length, `the folder page at 390 with the question leading it: ${fits.join('; ')}`);
    await shot(p, 'folder-390-de');
    await p.tap('[data-testid=ask-lead-open]');
    await p.waitForSelector('[data-testid=audition][data-loaded=true]', { timeout: 15000 });
    const words = await p.evaluate(() => document.querySelector('[role=dialog]').innerText);
    for (const w of ['Vergleichen und wählen', 'Eine wählen', 'Gleich laut', 'Wahl senden', '0 von 2 gewählt'])
      assert(words.includes(w), `“${w}” in ${words.slice(0, 400)}`);
    const wide = [...(await sideways(p)), ...(await clippedText(p))];
    assert(!wide.length, wide.join('\n'));
    // the takes by touch: the track on a line of its own under the words, the play button level with them, a finger's reach
    await p.waitForFunction(() => !document.querySelector('.modal')?.getAnimations().length, { polling: 'raf', timeout: 10000 });
    const takes = narrowRowsOff(await soundRows(p, '[data-testid=audition-group]:first-of-type'));
    assert(!takes.length, takes.join('\n'));
    // a look large on the phone: across the sheet, and back
    await p.tap('[data-testid=audition-group]:nth-of-type(2) [data-testid=audition-item]:nth-child(1) [data-testid=audition-expand]');
    await p.waitForSelector('[data-testid=audition-large][data-item=l1] img');
    const big = await p.$eval('.aud-big-tile', (el) => el.getBoundingClientRect().width);
    assert(big > 330, `the look large takes the sheet's width: ${big}px`);
    assert((await p.$eval('[data-testid=audition-back]', (b) => b.innerText)).includes('Alle Varianten'), 'Back in German');
    await shot(p, 'large-390-de');
    await p.tap('[data-testid=audition-back]');
    await p.waitForFunction(() => !document.querySelector('[data-testid=audition-large]'));
    await p.tap('[data-testid=audition-group]:first-of-type [data-testid=audition-item]:nth-child(3) [data-testid=audition-pick]');
    await p.tap('[data-testid=audition-group]:nth-of-type(2) [data-testid=audition-item]:nth-child(2) [data-testid=audition-pick]');
    await shot(p, 'audition-390-de');
    assert((await checked(p)).join() === 'v3,l2', `picked: ${await checked(p)}`);
    await p.tap('[data-testid=audition-send]');
    await p.waitForFunction(() => !document.querySelector('[data-testid=audition]'), { timeout: 10000 });
    const toast = await p.evaluate(() => document.body.innerText);
    assert(/Wahl gesendet/.test(toast), 'the German toast');
    await ctx.close();
  });

  let run;
  const IDEA =
    'Which idea should become the 15-second film? Each clip is a 4-second test of one idea: the same runner, the same light, three ways to open. Pick one and I render it in full tonight; what you would change in it, say below.';
  await check('a question leads its empty project: above the empty state, the one orange, counted by the bell; it opens the audition', async () => {
    // an empty project whose agent waits on one decision: three 4-second tests of an idea
    await api('/api/folders', 'POST', { path: 'Spring Promo' });
    const ideas = await api('/api/asks', 'POST', {
      folder: 'Spring Promo',
      text: IDEA,
      by: 'agent:Project overview',
      options: [
        {
          id: 'idea',
          label: 'Opening',
          items: [
            { id: 'a', label: 'Sunrise over the bridge', ref: { kind: 'file', data: b64(idea('a', 'testsrc2', 330)) } },
            { id: 'b', label: 'Shoes on wet asphalt', ref: { kind: 'file', data: b64(idea('b', 'smptehdbars', 440)) } },
            { id: 'c', label: 'The city waking up', ref: { kind: 'file', data: b64(idea('c', 'mandelbrot', 550)) } },
          ],
        },
      ],
    });
    const fresh = await browser.createBrowserContext();
    run = await open(`/#/folder/${encodeURIComponent('Spring Promo')}`, { ctx: fresh, theme: 'dark' });
    await run.evaluate(() => {
      window.__shift = 0;
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) if (!e.hadRecentInput) window.__shift += e.value;
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await run.waitForSelector('[data-testid=ask-lead]', { timeout: 15000 });
    await run.waitForSelector('[data-testid=library-content] .empty-state');
    const lead = await run.evaluate(() => {
      const block = document.querySelector('[data-testid=ask-lead]');
      const empty = document.querySelector('[data-testid=library-content] .empty-state');
      const q = document.querySelector('[data-testid=ask-lead-question]');
      const shown = (el) => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
      const oranges = [...document.querySelectorAll('.btn.primary')].filter(shown);
      return {
        text: block.innerText,
        first: block.parentElement.dataset.testid === 'library-content' && block === block.parentElement.firstElementChild,
        above: block.getBoundingClientRect().bottom <= empty.getBoundingClientRect().top,
        lines: Math.round(q.getBoundingClientRect().height / parseFloat(getComputedStyle(q).lineHeight)),
        cut: q.scrollHeight > q.clientHeight + 1,
        oranges: oranges.map((b) => b.dataset.testid || b.textContent.trim()),
        add: empty.querySelector('.btn')?.className ?? '',
      };
    });
    assert(/Project overview asks/.test(lead.text), `who asks: ${lead.text}`);
    assert(lead.text.includes('Which idea should become the 15-second film?'), `the question in its words: ${lead.text}`);
    assert(/3 clips/.test(lead.text), `what there is to compare: ${lead.text}`);
    assert(lead.first && lead.above, 'the block leads the content, above the empty state');
    assert(lead.lines === 2 && lead.cut, `the long question in two lines, cut: ${lead.lines} lines, cut ${lead.cut}`);
    assert(lead.oranges.length === 1 && lead.oranges[0] === 'ask-lead-open', `one orange, Compare and pick: ${lead.oranges.join(', ')}`);
    assert(
      !/\bprimary\b/.test(lead.add) && /Add a video to Spring Promo/.test(await run.$eval('[data-testid=library-content] .empty-state', (e) => e.innerText)),
      `the empty state's way to add steps back: ${lead.add}`,
    );
    // the bell counts it, as the inbox lists it
    const fy = await api('/api/for-you');
    assert(
      fy.items.some((i) => i.id === ideas.id && i.kind === 'question'),
      'the inbox lists the question',
    );
    const bell = await run.$eval('[data-testid=inbox-bell]', (b) => b.getAttribute('aria-label'));
    assert(bell === `Inbox, ${fy.counts.total} waiting` && fy.counts.total >= 1, `the bell: ${bell} (inbox ${fy.counts.total})`);
    await settle(run, { quiet: 500, max: 8000 });
    const shift = await run.evaluate(() => window.__shift);
    assert(shift < 0.02, `nothing moved when the question came: layout shift ${shift.toFixed(3)}`);
    await shot(run, 'lead-1440');
    await run.click('[data-testid=ask-lead-open]');
    await run.waitForSelector('[data-testid=audition][data-loaded=true]', { timeout: 15000 });
    const tiles = await run.$$eval('[data-testid=audition] .aud-tile [data-testid=audition-shot] video', (els) => els.length);
    assert(tiles === 3, `the three clips as tiles: ${tiles}`);
    assert((await run.$eval('.aud-q', (el) => el.textContent)) === IDEA, 'the question in full in the audition');
  });

  await check(
    'a clip opens large in the dialog: as large as its box allows at 16:9, ←/→ at the same moment, A back, picked, Esc and All options to the grid',
    async () => {
      const p = run;
      // The dialog's box once it holds still: no animation of its own left (it comes in scaled and lifted, and on a
      // loaded machine that frame can be the one measured) and the same box two frames in a row.
      const modal = () =>
        p.$eval(
          '.modal',
          (el) =>
            new Promise((resolve) => {
              const t0 = performance.now();
              let last = '';
              const tick = () => {
                const box = Object.values(el.getBoundingClientRect().toJSON()).map(Math.round).join(',');
                if ((box === last && !el.getAnimations().length) || performance.now() - t0 > 8000) resolve(box);
                else {
                  last = box;
                  requestAnimationFrame(tick);
                }
              };
              requestAnimationFrame(tick);
            }),
        );
      const grid = await modal();
      const sameBox = async (what) => {
        const now = await modal();
        assert(now === grid, `${what}: ${now}, was ${grid}`);
      };
      const width = await p.$eval('.modal', (el) => el.getBoundingClientRect().width);
      assert(width >= 1300, `the dialog takes the room at 1440: ${width}px`);
      // the tiles use it too: three across the row
      const tile = await p.$eval('[data-testid=audition-item]', (el) => el.getBoundingClientRect().width);
      assert(tile > 400, `a tile is ${Math.round(tile)}px wide`);
      await p.click('[data-testid=audition-item]:nth-child(1) [data-testid=audition-shot]');
      await p.waitForSelector('[data-testid=audition-large][data-item=a] [data-testid=audition-large-video]');
      // The dialog is as tall as its list (a short question: one row of clips): the large one takes all of that box —
      // its height or its width, whichever it meets first — well over a tile's size.
      const big = await p.evaluate(() => {
        const m = document.querySelector('.aud-big-tile .aud-media').getBoundingClientRect();
        const tile = document.querySelector('.aud-big-tile').getBoundingClientRect();
        const room = document.querySelector('.aud-big-room').getBoundingClientRect();
        const v = document.querySelector('[data-testid=audition-large-video]');
        return {
          width: Math.round(m.width),
          fills: Math.abs(tile.height - room.height) < 3 || Math.abs(tile.width - room.width) < 3,
          ratio: m.width / m.height,
          controls: v.controls,
          list: getComputedStyle(document.querySelector('.aud-list')).visibility,
        };
      });
      assert(big.fills && big.width > 1.6 * tile && Math.abs(big.ratio - 16 / 9) < 0.02 && big.controls, `large: ${JSON.stringify(big)}, a tile ${tile}px`);
      assert(big.list === 'hidden', 'the grid waits under it');
      await sameBox('grid and large view in one box: the dialog did not move');
      // it plays; → goes to the next one at the same moment
      await p.waitForFunction(() => document.querySelector('[data-testid=audition-large-video]').currentTime > 0.8, { timeout: 15000 });
      const at = await p.$eval('[data-testid=audition-large-video]', (v) => v.currentTime);
      await p.keyboard.press('ArrowRight');
      await p.waitForSelector('[data-testid=audition-large][data-item=b]');
      await p.waitForFunction((t) => document.querySelector('[data-testid=audition-large-video]').currentTime >= t - 0.1, { timeout: 15000 }, at);
      assert((await p.$eval('[data-testid=audition-large-n]', (el) => el.textContent)) === '2 of 3', 'where it is in its group');
      await shot(p, 'clip-large-1440');
      // A: back to the one before; ← from the first wraps to the last
      await p.keyboard.press('a');
      await p.waitForSelector('[data-testid=audition-large][data-item=a]');
      await p.keyboard.press('ArrowLeft');
      await p.waitForSelector('[data-testid=audition-large][data-item=c]');
      await p.click('[data-testid=audition-next]');
      await p.waitForSelector('[data-testid=audition-large][data-item=a]');
      // its pick under it
      await p.click('[data-testid=audition-large-pick]');
      assert((await p.$eval('[data-testid=audition-large-pick]', (b) => b.getAttribute('aria-checked'))) === 'true', 'picked in the large view');
      await sameBox('moving between them kept the box');
      await p.keyboard.press('Escape');
      await p.waitForFunction(() => !document.querySelector('[data-testid=audition-large]'));
      assert(await p.$('[data-testid=audition]'), 'Esc went back to the grid, the dialog stays');
      assert((await checked(p)).join() === 'a', `the pick shows in the grid: ${await checked(p)}`);
      await sameBox('back in the same box');
      // Expand on a tile, and All options back
      await p.click('[data-testid=audition-item]:nth-child(3) [data-testid=audition-expand]');
      await p.waitForSelector('[data-testid=audition-large][data-item=c]');
      await p.click('[data-testid=audition-back]');
      await p.waitForFunction(() => !document.querySelector('[data-testid=audition-large]'));
      // Play together still plays them all, and stops them; each tile says it plays, the one in focus (the third, its
      // Expand pressed last) is the one heard, and the sound follows the focus
      await p.click('[data-testid=audition-together]');
      await p.waitForFunction(() => [...document.querySelectorAll('.aud-list video')].every((v) => !v.paused && v.currentTime > 0), { timeout: 15000 });
      await p.waitForFunction(() => document.querySelectorAll('[data-testid=audition-item][data-playing]').length === 3, { timeout: 5000 }).catch(() => {});
      const marks = await p.evaluate(() => ({
        playing: document.querySelectorAll('[data-testid=audition-item][data-playing]').length,
        heard: [...document.querySelectorAll('[data-testid=audition-item][data-heard]')].map((el) => el.dataset.item),
        loud: [...document.querySelectorAll('.aud-list video')].map((v) => !v.muted),
      }));
      assert(marks.playing === 3 && marks.heard.join() === 'c' && marks.loud.join() === 'false,false,true', `while they play: ${JSON.stringify(marks)}`);
      await p.keyboard.press('ArrowLeft');
      await p.waitForFunction(() => [...document.querySelectorAll('.aud-list video')].map((v) => !v.muted).join() === 'false,true,false', { timeout: 5000 });
      // Pause (unless the 4-second clips ended meanwhile: then Play together would start them again)
      if (await p.$('[data-testid=audition-together][data-playing]')) await p.click('[data-testid=audition-together]');
      await p.waitForFunction(() => [...document.querySelectorAll('.aud-list video')].every((v) => v.paused));
      // stopped: no tile says it plays
      await p.waitForFunction(() => !document.querySelector('[data-testid=audition-item][data-playing]'), { timeout: 5000 });
      await p.keyboard.press('Escape');
      await p.browserContext().close();
    },
  );

  // A person's case, synthetic: an agent's long German question before the first version, three looks as clips — two
  // 9:16 reels and one 16:9 — with long German labels, three piano takes, the agent's own prompt.
  const REELS = [
    { id: 'calm', label: 'Ruhig & edel: Vollbild, langsame Pushes, weiche Überblendungen', src: 'gradients=c0=white:c1=0xe8dcc8', size: '360x640' },
    { id: 'beat', label: 'Rhythmus: Schnitt auf jeden Klavierschlag, das Rotlicht als harter Wechsel', src: 'testsrc2', size: '360x640' },
    { id: 'prints', label: 'Fotobuch: die Fotos als Abzüge, die auf den Tisch fallen, dann läuft das Video', src: 'mandelbrot', size: '640x360' },
  ];
  const REELS_Q =
    'Aftermovie Frühlingsfest: Bevor ich den ganzen Film baue, wähl bitte einen Look und einen Klavier-Track. Die Clips zeigen jeweils 4 s um den Schlüsselmoment: der leere Saal im warmen Licht, dann geht das Rotlicht an. Danach geht es chronologisch weiter, am Ende die Figur als Übergang.';
  let reels;
  await check(
    'reels and a 16:9 read as one set: one box per group, every picture inside it, words, key and pick under it, nothing on it but Larger; the loading state has the box',
    async () => {
      await api('/api/folders', 'POST', { path: 'Frühlingsfest/Reels' });
      const made = await api('/api/asks', 'POST', {
        folder: 'Frühlingsfest/Reels',
        text: REELS_Q,
        by: 'agent:claude-code',
        answer_prompt: 'Noch etwas zum Film? (z. B. Länge, Endkarten-Zeile, Momente, die unbedingt rein sollen)',
        options: [
          {
            id: 'look',
            label: 'Look',
            items: REELS.map((r, i) => ({ id: r.id, label: r.label, ref: { kind: 'file', data: b64(idea(`reel-${r.id}`, r.src, 330 + 110 * i, r.size)) } })),
          },
          {
            id: 'track',
            label: 'Klavier-Track (synthetisch, ~45 s)',
            items: [
              {
                id: 'a',
                label: 'A: neoklassisch, ruhiger Anfang, großer Aufbau mit Streichern ab ~21 s',
                ref: { kind: 'file', data: b64(tone('pa', 0.5, 262)) },
              },
              { id: 'b', label: 'B: nur Flügel, durchgehendes Ostinato, steigert sich in Wellen', ref: { kind: 'file', data: b64(tone('pb', 0.1, 330)) } },
              { id: 'c', label: 'C: Klavier mit weichem House-Groove, am meisten Energie', ref: { kind: 'file', data: b64(tone('pc', 0.9, 392)) } },
            ],
          },
        ],
      });
      const fresh = await browser.createBrowserContext();
      reels = await open(`/#/folder/${encodeURIComponent('Frühlingsfest/Reels')}`, { ctx: fresh, theme: 'light' });
      const p = reels;
      await p.waitForSelector('[data-testid=ask-lead] [data-testid=ask-lead-open]', { timeout: 15000 });
      // the folder's question names the agent as people read it, never by its client's id
      const lead = await p.$eval('[data-testid=ask-lead]', (el) => el.innerText);
      assert(lead.includes('Claude Code asks') && !lead.includes('claude-code'), `the question's line: ${lead.slice(0, 120)}`);
      // the question's own data held back: its loading state shows the group's box (the list names its shape)
      await p.setRequestInterception(true);
      let release;
      const held = new Promise((r) => {
        release = r;
      });
      p.on('request', (req) => {
        if (req.method() === 'GET' && new URL(req.url()).pathname === `/api/asks/${made.id}`) held.then(() => req.continue().catch(() => {}));
        else req.continue().catch(() => {});
      });
      await p.click('[data-testid=ask-lead-open]');
      await p.waitForSelector('[data-testid=audition][data-loaded=false] .aud-group.pending .aud-media');
      // measured once the dialog holds still: it comes in scaled
      await p.waitForFunction(() => !document.querySelector('.modal')?.getAnimations().length, { polling: 'raf', timeout: 10000 });
      const boxOf = (sel) => p.$eval(sel, (el) => [el.getBoundingClientRect().width, el.getBoundingClientRect().height].map(Math.round));
      const pending = await boxOf('.aud-group.pending .aud-media');
      release();
      await p.waitForSelector('[data-testid=audition][data-loaded=true]', { timeout: 15000 });
      await p.waitForFunction(() => [...document.querySelectorAll('.aud-list video')].every((v) => v.readyState >= 1 && v.videoWidth > 0), { timeout: 15000 });
      await p.mouse.move(1, 1);
      await settle(p);
      const loaded = await boxOf('[data-testid=audition-group] .aud-media');
      assert(
        pending.every((v, i) => Math.abs(v - loaded[i]) <= 2),
        `the loading state's box ${pending} is the loaded one's ${loaded}`,
      );
      const tiles = await p.evaluate(() => {
        const box = (el) => {
          const b = el.getBoundingClientRect();
          return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height };
        };
        const group = document.querySelector('[data-testid=audition-group]');
        return [...group.querySelectorAll('[data-testid=audition-item]')].map((tile) => {
          const t = box(tile);
          const m = box(tile.querySelector('.aud-media'));
          const pic = tile.querySelector('.aud-shot video, .aud-shot img');
          const v = box(pic);
          const label = tile.querySelector('.aud-label');
          const lb = box(label);
          // the picture as it is drawn: its element's box, as far as the tile (which clips) shows it
          const drawn = { l: Math.max(v.l, t.l), t: Math.max(v.t, t.t), r: Math.min(v.r, t.r), b: Math.min(v.b, t.b) };
          // what is on top of it, across a grid of points: the picture (its button) or the Larger chip, nothing else
          const over = new Set();
          for (let i = 1; i < 10; i++)
            for (let j = 1; j < 10; j++) {
              const el = document.elementFromPoint(drawn.l + ((drawn.r - drawn.l) * i) / 10, drawn.t + ((drawn.b - drawn.t) * j) / 10);
              if (!el || el === pic || el.closest('[data-testid=audition-shot], [data-testid=audition-expand]')) continue;
              over.add(`${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')}`);
            }
          return {
            media: [m.w, m.h].map(Math.round),
            inside: v.l >= m.l - 1 && v.t >= m.t - 1 && v.r <= m.r + 1 && v.b <= m.b + 1,
            below: lb.t >= drawn.b - 0.5 && lb.t >= m.b - 0.5,
            over: [...over],
            lines: Math.round(lb.h / parseFloat(getComputedStyle(label).lineHeight)),
            text: label.textContent,
            name: tile.querySelector('[data-testid=audition-pick]').textContent,
            titles: [...tile.querySelectorAll('[title]')].map((e) => e.getAttribute('title')),
            expand: !!tile.querySelector('.aud-media [data-testid=audition-expand]'),
          };
        });
      });
      await shot(p, 'reels-1440-light');
      assert(tiles.length === 3, `${tiles.length} tiles`);
      const off = [];
      for (const [i, x] of tiles.entries()) {
        const at = `tile ${i + 1}`;
        if (x.media.some((v, k) => Math.abs(v - tiles[0].media[k]) > 1)) off.push(`${at}: its box ${x.media} is not the group's ${tiles[0].media}`);
        if (!x.inside) off.push(`${at}: its picture reaches out of its box`);
        if (!x.below) off.push(`${at}: its words are on the picture`);
        if (x.over.length) off.push(`${at}: on the picture: ${x.over.join(', ')}`);
        if (!x.expand) off.push(`${at}: no Larger on the picture's corner`);
        if (x.lines > 2) off.push(`${at}: its words take ${x.lines} lines`);
        if (x.text !== REELS[i].label || !x.name.includes(REELS[i].label)) off.push(`${at}: its words aren't whole in the page: "${x.text}"`);
        if (x.titles.length) off.push(`${at}: a native title covers things: ${x.titles.join(', ')}`);
      }
      // a long label takes its two lines before it is cut, rather than one line cut short
      if (tiles[2].lines !== 2) off.push(`the longest words take ${tiles[2].lines} line(s), not two`);
      assert(!off.length, off.join('\n'));
      // the agent by the name people read, in the free text's hint too
      const meta = await p.$eval('.aud-meta b', (b) => b.textContent);
      const hint = await p.$eval('[data-testid=audition-note]', (t) => t.placeholder);
      assert(meta === 'Claude Code' && hint.includes('Claude Code') && !hint.includes('claude-code'), `the agent: ${meta} · ${hint}`);
    },
  );

  await check('a pick is the list’s selection: a flat fill and the filled check, never raised, never orange; sound rows alike; whole words large', async () => {
    const p = reels;
    // nothing hovered: the keys pick (1 in the looks, ↓ 2 in the takes)
    await p.mouse.move(1, 1);
    await p.keyboard.press('1');
    await p.keyboard.press('ArrowDown');
    await p.keyboard.press('2');
    await settle(p);
    const look = await p.evaluate(() => {
      const cs = (el) => getComputedStyle(el);
      const [tile, other] = document.querySelectorAll('[data-testid=audition-group]:first-of-type [data-testid=audition-item]');
      const rows = document.querySelectorAll('[data-testid=audition-group]:nth-of-type(2) [data-testid=audition-item]');
      const of = (el) => {
        const pick = el.querySelector('[data-testid=audition-pick]');
        const check = el.querySelector('.aud-check');
        return {
          on: pick.getAttribute('aria-checked'),
          edge: cs(el).boxShadow,
          fill: el.classList.contains('aud-row') ? cs(el).backgroundColor : cs(pick).backgroundColor,
          check: [cs(check).backgroundColor, cs(check).backgroundImage, cs(check).boxShadow, cs(check).borderColor],
        };
      };
      return { tile: of(tile), other: of(other), row: of(rows[1]), otherRow: of(rows[0]) };
    });
    const clear = 'rgba(0, 0, 0, 0)';
    const off = [];
    for (const [name, on, off_] of [
      ['tile', look.tile, look.other],
      ['sound row', look.row, look.otherRow],
    ]) {
      if (on.on !== 'true' || off_.on !== 'false') off.push(`${name}: picked ${on.on}, the other ${off_.on}`);
      if (on.fill === clear || on.fill === off_.fill) off.push(`${name}: no fill of its own when picked (${on.fill} / ${off_.fill})`);
      if (on.check[0] === clear || on.check[0] === off_.check[0]) off.push(`${name}: the check doesn't fill (${on.check[0]})`);
      if (on.check[1] !== 'none' || on.check[2] !== 'none') off.push(`${name}: the check is raised (${on.check[1]} · ${on.check[2]})`);
      for (const c of [on.edge, on.fill, ...on.check]) if (orange(c)) off.push(`${name}: orange in its picked look: ${c}`);
    }
    if (look.tile.edge === look.other.edge) off.push(`the picked tile's edge is the others' (${look.tile.edge})`);
    assert(!off.length, `${off.join('\n')}\n${JSON.stringify(look)}`);
    await shot(p, 'reels-picked-1440-light');
    // the 16:9 one large: in the group's box (the reels'), its words whole under it
    await p.click('[data-testid=audition-group]:first-of-type [data-testid=audition-item]:nth-child(1) [data-testid=audition-shot]');
    await p.waitForSelector('[data-testid=audition-large][data-item=calm]');
    const first = await p.$eval('.aud-big-tile .aud-media', (el) => [el.getBoundingClientRect().width, el.getBoundingClientRect().height].map(Math.round));
    await p.keyboard.press('ArrowLeft');
    await p.waitForSelector('[data-testid=audition-large][data-item=prints]');
    const large = await p.evaluate(() => {
      const m = document.querySelector('.aud-big-tile .aud-media').getBoundingClientRect();
      const v = document.querySelector('[data-testid=audition-large-video]').getBoundingClientRect();
      const label = document.querySelector('[data-testid=audition-large-pick] .aud-label');
      return {
        box: [m.width, m.height].map(Math.round),
        inside: v.left >= m.left - 1 && v.top >= m.top - 1 && v.right <= m.right + 1 && v.bottom <= m.bottom + 1,
        whole: label.scrollHeight <= label.clientHeight + 1 && label.scrollWidth <= label.clientWidth + 1,
        text: label.textContent,
      };
    });
    assert(
      large.box.every((v, i) => Math.abs(v - first[i]) <= 1) && large.inside,
      `the 16:9 one large in the reels' box: ${JSON.stringify(large)} vs ${first}`,
    );
    assert(large.whole && large.text === REELS[2].label, `its words whole in the large view: ${JSON.stringify(large)}`);
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => !document.querySelector('[data-testid=audition-large]'));
    // a laptop's width: a sound is one line — its words, then the track beside them, the time and the check
    const takes = '[data-testid=audition-group]:nth-of-type(2)';
    await p.setViewport({ width: 1024, height: 768 });
    await settle(p);
    await p.$eval(takes, (el) => el.scrollIntoView({ block: 'center' }));
    const wide = await soundRows(p, takes);
    assert(
      wide.every((r) => r.lines === 1 && r.bar.c >= r.label.t && r.bar.c <= r.label.b && r.bar.l > r.label.r),
      `the sounds at 1024, one line each: ${JSON.stringify(wide.map((r) => ({ lines: r.lines, bar: Math.round(r.bar.c), label: [r.label.t, r.label.b].map(Math.round) })))}`,
    );
    // two across a phone's width: the long words in two lines, cut, still whole in the page
    await p.setViewport({ width: 390, height: 844 });
    await settle(p);
    const narrow = await p.evaluate(() =>
      [...document.querySelectorAll('[data-testid=audition-group]:first-of-type .aud-label')].map((l) => ({
        lines: Math.round(l.getBoundingClientRect().height / parseFloat(getComputedStyle(l).lineHeight)),
        cut: l.scrollHeight > l.clientHeight + 1,
        text: l.textContent,
      })),
    );
    assert(
      narrow.every((l, i) => l.lines <= 2 && l.text === REELS[i].label) && narrow[2].lines === 2 && narrow[2].cut,
      `the words on a narrow tile: ${JSON.stringify(narrow)}`,
    );
    // …and the sounds there: their words in two lines, the track on a line of its own under them, the play button,
    // time and check level with the words
    await p.$eval(takes, (el) => el.scrollIntoView({ block: 'center' }));
    const tight = await soundRows(p, takes);
    const tightOff = narrowRowsOff(tight);
    if (!tight.some((r) => r.lines === 2)) tightOff.push(`no sound's words take two lines at 390: ${tight.map((r) => r.lines).join(', ')}`);
    assert(!tightOff.length, tightOff.join('\n'));
    await shot(p, 'reels-390-light');
    await p.keyboard.press('Escape');
    await p.browserContext().close();
  });

  await check('a short question’s dialog is as tall as what it shows: the free text right under the last group, Send at the foot', async () => {
    await api('/api/folders', 'POST', { path: 'Frühlingsfest/Teaser' });
    const teaser = await api('/api/asks', 'POST', {
      folder: 'Frühlingsfest/Teaser',
      text: 'Welcher Einstieg für den Teaser?',
      by: 'agent:claude-code',
      options: [
        {
          id: 'open',
          label: 'Einstieg',
          items: [
            { id: 'o1', label: 'Ruhig', ref: { kind: 'file', data: b64(idea('t1', 'testsrc2', 330)) } },
            { id: 'o2', label: 'Rhythmus', ref: { kind: 'file', data: b64(idea('t2', 'smptehdbars', 440)) } },
            { id: 'o3', label: 'Fotobuch', ref: { kind: 'file', data: b64(idea('t3', 'mandelbrot', 550)) } },
          ],
        },
      ],
    });
    const fresh = await browser.createBrowserContext();
    // the inbox names the agent as people read it too: its row and its preview
    const inbox = await open('/#/inbox', { ctx: fresh, theme: 'dark', lang: 'de-DE' });
    const row = `[data-key="q:${teaser.id}"]`;
    await inbox.waitForSelector(row, { timeout: 15000 });
    await inbox.click(row);
    await inbox.waitForFunction(() => /Welcher Einstieg/.test(document.querySelector('[data-testid=inbox-preview]')?.textContent || ''), {
      polling: 100,
      timeout: 15000,
    });
    const said = [await inbox.$eval(row, (el) => el.innerText), await inbox.$eval('[data-testid=inbox-preview]', (el) => el.innerText)];
    assert(
      said.every((s) => s.includes('Claude Code fragt') && !s.includes('claude-code')),
      `the inbox's row and preview: ${said.map((s) => s.slice(0, 120)).join(' | ')}`,
    );
    await inbox.close();
    const p = await open(`/#/folder/${encodeURIComponent('Frühlingsfest/Teaser')}`, { ctx: fresh, theme: 'dark', lang: 'de-DE' });
    await p.waitForSelector('[data-testid=ask-lead] [data-testid=ask-lead-open]', { timeout: 15000 });
    await p.click('[data-testid=ask-lead-open]');
    await p.waitForSelector('[data-testid=audition][data-loaded=true]', { timeout: 15000 });
    await settle(p);
    const room = await p.evaluate(() => {
      const r = (sel) => document.querySelector(sel).getBoundingClientRect();
      const last = [...document.querySelectorAll('.aud-list > .aud-group')].at(-1).getBoundingClientRect();
      const note = r('.aud-note');
      const list = r('.aud-list');
      const modal = r('.modal');
      return {
        gap: Math.round(note.top - last.bottom),
        under: Math.round(list.bottom - note.bottom),
        foot: Math.round(r('.modal-foot').top - list.bottom),
        modal: Math.round(modal.height),
        room: window.innerHeight - 64,
        space: parseFloat(getComputedStyle(document.querySelector('.aud-list')).rowGap),
        pad: parseFloat(getComputedStyle(document.querySelector('.aud-list')).paddingBottom),
      };
    });
    assert(room.gap <= room.space + 1, `the free text follows the last group: ${room.gap}px between them (the list's gap ${room.space})`);
    assert(room.under <= room.pad + 1 && room.foot <= 1, `nothing held under the free text: ${room.under}px, then the foot ${room.foot}px`);
    assert(room.modal < room.room - 40, `the dialog fits what it shows: ${room.modal}px of ${room.room}`);
    await shot(p, 'short-1440-dark-de');
    await p.keyboard.press('Escape');
    await fresh.close();
  });

  await check('the note card in the player: a question on the video opens the audition, and shows the picks once sent', async () => {
    const made = await api('/api/asks', 'POST', {
      video: slug,
      text: 'Which closing line for the spot?',
      options: [
        {
          id: 'close',
          label: 'Closing line',
          items: [
            { id: 'c1', label: 'See you there' },
            { id: 'c2', label: 'lampo.app' },
          ],
        },
      ],
      by: 'agent:sound',
    });
    const p = await open(`/#/v/${encodeURIComponent(slug)}?c=${made.id}`);
    await p.waitForSelector(`[data-testid=options-ask]`, { timeout: 15000 });
    // the player settles on the note first (it seeks to it and lays the card out): then the way in
    await sleep(600);
    for (let i = 0; i < 3 && !(await p.$('[data-testid=audition]')); i++) {
      await p.click('[data-testid=options-ask] [data-testid=options-open]');
      await p.waitForSelector('[data-testid=audition]', { timeout: 3000 }).catch(() => {});
    }
    await p.waitForSelector('[data-testid=audition][data-loaded=true]');
    await p.keyboard.press('2');
    await shot(p, 'player-1440');
    await p.click('[data-testid=audition-send]');
    await p.waitForFunction(() => !document.querySelector('[data-testid=audition]'), { timeout: 10000 });
    // answered: the question is closed — in Done, folded at the list's end, it shows what was picked, in words
    await p.waitForSelector('[data-testid=group-done]');
    await p.click('[data-testid=group-done]');
    await p.waitForSelector('[data-testid=options-picked]', { timeout: 10000 });
    const picked = await p.$eval('[data-testid=options-picked]', (el) => el.innerText);
    assert(/Closing line\s+lampo\.app/.test(picked), picked);
    const note = (await api(`/api/review/${encodeURIComponent(slug)}`)).review.comments.find((c) => c.id === made.id);
    assert(note.status === 'verified' && note.replies.at(-1).text === 'PICKED close=c2', JSON.stringify(note.replies));
    await p.close();
  });
} catch (e) {
  crashed(e, srv);
}
await finish(LABEL, { browser, servers: [srv] });
