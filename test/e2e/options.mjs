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
// shows the picks. Clips open large inside the dialog (a click or Expand): most of its width at 16:9, ←/→ to the next at
// the same moment, A back to the one before, its pick under it, Esc or All options back to the grid in the same box;
// Play together still plays them all. Synthetic media only: sines at three levels, ffmpeg test patterns.
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
/** A 4-second test of an idea: a moving pattern with a tone (an option's clip). */
const idea = (name, src, freq) => {
  const f = path.join(media, `${name}.mp4`);
  execFileSync(FFMPEG, [
    ...['-v', 'error', '-f', 'lavfi', '-i', `${src}=size=640x360:rate=25`, '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=4`],
    ...['-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', f],
  ]);
  return f;
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
    'a clip opens large in the dialog: most of its width at 16:9, ←/→ at the same moment, A back, picked, Esc and All options to the grid',
    async () => {
      const p = run;
      const modal = () => p.$eval('.modal', (el) => [...Object.values(el.getBoundingClientRect().toJSON())].map(Math.round).join(','));
      const grid = await modal();
      const width = await p.$eval('.modal', (el) => el.getBoundingClientRect().width);
      assert(width >= 1300, `the dialog takes the room at 1440: ${width}px`);
      // the tiles use it too: three across the row
      const tile = await p.$eval('[data-testid=audition-item]', (el) => el.getBoundingClientRect().width);
      assert(tile > 400, `a tile is ${Math.round(tile)}px wide`);
      await p.click('[data-testid=audition-item]:nth-child(1) [data-testid=audition-shot]');
      await p.waitForSelector('[data-testid=audition-large][data-item=a] [data-testid=audition-large-video]');
      const big = await p.evaluate(() => {
        const m = document.querySelector('.aud-big-tile .aud-media').getBoundingClientRect();
        const d = document.querySelector('.modal').getBoundingClientRect();
        const v = document.querySelector('[data-testid=audition-large-video]');
        return {
          share: m.width / d.width,
          ratio: m.width / m.height,
          controls: v.controls,
          list: getComputedStyle(document.querySelector('.aud-list')).visibility,
        };
      });
      assert(big.share > 0.7 && Math.abs(big.ratio - 16 / 9) < 0.02 && big.controls, `large: ${JSON.stringify(big)}`);
      assert(big.list === 'hidden', 'the grid waits under it');
      assert((await modal()) === grid, 'grid and large view in one box: the dialog did not move');
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
      assert((await modal()) === grid, 'moving between them kept the box');
      await p.keyboard.press('Escape');
      await p.waitForFunction(() => !document.querySelector('[data-testid=audition-large]'));
      assert(await p.$('[data-testid=audition]'), 'Esc went back to the grid, the dialog stays');
      assert((await checked(p)).join() === 'a', `the pick shows in the grid: ${await checked(p)}`);
      assert((await modal()) === grid, 'back in the same box');
      // Expand on a tile, and All options back
      await p.click('[data-testid=audition-item]:nth-child(3) [data-testid=audition-expand]');
      await p.waitForSelector('[data-testid=audition-large][data-item=c]');
      await p.click('[data-testid=audition-back]');
      await p.waitForFunction(() => !document.querySelector('[data-testid=audition-large]'));
      // Play together still plays them all, and stops them
      await p.click('[data-testid=audition-together]');
      await p.waitForFunction(() => [...document.querySelectorAll('.aud-list video')].every((v) => !v.paused && v.currentTime > 0), { timeout: 15000 });
      await p.click('[data-testid=audition-together]');
      await p.waitForFunction(() => [...document.querySelectorAll('.aud-list video')].every((v) => v.paused));
      await p.keyboard.press('Escape');
      await p.browserContext().close();
    },
  );

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
    // answered: the question is closed — under All it shows what was picked, in words
    for (const tab of await p.$$('.note-filters [role=tab]')) if (/^All/.test(await tab.evaluate((b) => b.textContent))) await tab.click();
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
