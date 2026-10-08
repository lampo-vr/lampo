#!/usr/bin/env node
// covers: web/src/player/drafts/ web/src/player/Composer.tsx web/src/library/unsent.tsx web/src/api/drafts.ts
// covers: server/routes/drafts.ts server/routes/mcp.ts lib/drafts.ts
// Browser end-to-end test of notes not sent yet (player/drafts/): a real server (local mode, temp store, free port) and
// an agent connected over MCP (/mcp) while a person reviews in headless Chrome. Two notes saved as drafts (⌘S, and the
// composer's Save) reach the agent not at all — get_open_notes sees neither — until Send all, when one
// wait_for_feedback answer brings both. Then: the composer's Send says how many it sends and takes the drafts along
// (one batch again), a draft is changed in place and kept, the library card says "1 not sent" and the player says so
// when the video opens again. With 18 drafts: Send all is the composer's Send (class and computed style, its key cap;
// it steps down while a note is written), the head stays pinned while they scroll (768–1920 and the phone’s sheet),
// a draft's own Send — click, or ⌘↵ in it — sends exactly that one as one batch (asked first like Send all when the
// agent could be started), and Send all (⇧⌘↵) sends the rest in one, every card keeping its place while the list
// without them comes before the send's answer (held back), then leaving. Screenshots (VR_SHOTS) at 1440 and 390, dark
// and light. On a video with an agent the composer keeps notes by default (⌘↵ saves, Send is the quiet way to send
// now): three stay drafts the waiting agent never hears, "Send 3 to <agent>" brings them in one answer, the line under
// it says the agent is waiting, the toast that it got them; a reply still reaches it at once. The raised one of Save
// and Send is always the last: Save · Send without an agent, Send · Save with one; an agent assigned, waiting or
// unassigned while a note is written swaps them in the same room, each as wide as before (1440, and 390 with a note
// long enough to pin the foot).
import fs from 'node:fs';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { age, makeVideo, sleep, until } from '../lib/helpers.ts';
import { fitsAt } from './layout.mjs';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'drafts e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-drafts-e2e-', user: 'Sam' });
const { dir, base: BASE } = srv;
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const api = jsonApi(BASE);
const textOf = (r) =>
  r.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

let browser;
let page;
let mcp;
screenshotFailures(() => page, 'drafts');
try {
  const file = makeVideo(path.join(dir, 'Spot/export/launch.mp4'), { w: 320, h: 180, fps: 25, dur: 8, pattern: 'testsrc2' });
  age(file);
  const { video } = await api('/api/library', 'POST', { path: file });
  const slug = video.slug;
  const enc = encodeURIComponent;

  mcp = new Client({ name: 'drafts-agent', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  const tool = async (name, args) => textOf(await mcp.callTool({ name, arguments: args }));
  // A cursor taken before a send: the wait can't miss what comes after it, however slow the machine is.
  const cursorNow = async () => /cursor: (\S+)/.exec(await tool('wait_for_feedback', { video: slug, timeout_s: 0 }))?.[1];

  browser = await launch();
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));
  const shot = async (name, sel) => {
    if (!SHOTS) return;
    const el = sel && (await page.$(sel));
    await (el || page).screenshot({ path: path.join(SHOTS, `${name}.png`) });
  };
  const videoReady = () =>
    page.waitForFunction(
      () => {
        const v = document.querySelector('.vbox video');
        return v && v.readyState >= 2 && !v.seeking;
      },
      { polling: 100, timeout: 20000 },
    );
  const shownFrame = () => page.$eval('.tc .sub b', (e) => Number(e.textContent));
  const goto = async (frame, on = slug) => {
    await page.evaluate((f, s) => window.dispatchEvent(new CustomEvent('vr-goto-frame', { detail: { slug: s, v: 1, frame: f } })), frame, on);
    await until(async () => (await shownFrame()) === frame, `the player shows F${frame}`);
  };
  const openPlayer = async () => {
    await page.goto(`${BASE}/#/v/${enc(slug)}`, { waitUntil: 'domcontentloaded' });
    await videoReady();
  };
  const write = async (frame, text, on = slug) => {
    await goto(frame, on);
    await page.click('[data-testid=new-note]');
    await page.waitForSelector('.composer textarea');
    await page.type('.composer .composer-text', text);
  };
  const composerGone = () => page.waitForFunction(() => !document.querySelector('.composer'), { polling: 100, timeout: 20000 });
  const draftCount = () => page.$$eval('[data-testid=note-draft]', (els) => els.length);
  const reviewNotes = async () => (await api(`/api/review/${enc(slug)}`)).review.comments;

  console.log(`drafts e2e against ${BASE} (store ${dir})`);

  await check('Save keeps two notes as drafts (⌘S, and the Save button): "Not sent yet · 2", nothing in the review', async () => {
    await openPlayer();
    await write(20, 'Logo lands too early');
    await page.keyboard.down(MOD);
    await page.keyboard.press('s');
    await page.keyboard.up(MOD);
    await composerGone();
    await write(80, 'Title a touch bigger');
    await shot('drafts-dark-1440-composer', '.side');
    const send = await page.$eval('[data-testid=composer-send]', (b) => b.textContent.trim());
    assert(send === 'Send 2', `Send says what it sends: "${send}"`);
    await page.click('[data-testid=composer-save]');
    await composerGone();
    await until(async () => (await draftCount()) === 2, 'two drafts in the panel');
    const head = await page.$eval('[data-testid=unsent] .unsent-title', (e) => e.textContent.replace(/\s+/g, ' ').trim());
    assert(head === 'Not sent yet · 2', `the head: "${head}"`);
    const glyphs = await page.$$eval('[data-testid=note-draft] .draft-kg', (els) => els.map((e) => e.dataset.shape));
    assert(glyphs.length === 2 && glyphs.every((s) => s === 'outline'), `hollow keyframes: ${glyphs}`);
    assert((await reviewNotes()).length === 0, 'the review has no note yet');
    await shot('drafts-dark-1440-panel', '.side');
  });

  await check('the agent sees neither draft: get_open_notes and list_videos say nothing of them', async () => {
    const open = await tool('get_open_notes', { video: slug });
    assert(!/Logo lands|Title a touch/.test(open), `get_open_notes: ${open}`);
    const listed = await tool('list_videos', {});
    assert(/open 0/.test(listed), `no open notes in list_videos: ${listed}`);
  });

  await check('Send all: both notes reach the waiting agent in one wait_for_feedback answer', async () => {
    const waiting = tool('wait_for_feedback', { video: slug, since: await cursorNow(), timeout_s: 60 });
    await page.click('[data-testid=drafts-send]');
    const got = await waiting;
    assert(/^2 new:\n/.test(got), `one answer with both: ${got}`);
    assert(got.includes('Logo lands too early') && got.includes('Title a touch bigger'), got);
    await page.waitForSelector('[data-testid=unsent]', { hidden: true, timeout: 20000 });
    await until(async () => (await reviewNotes()).length === 2, 'two notes in the review');
    await until(async () => (await page.$$('.side-scroll .note')).length === 2, 'two notes in the panel');
  });

  await check('Send in the composer takes the drafts along: "Send 2", ⌘↵, one batch again', async () => {
    await write(40, 'Cut the pause');
    await page.click('[data-testid=composer-save]');
    await composerGone();
    await until(async () => (await draftCount()) === 1, 'one draft');
    await write(120, 'Music down under the voice');
    const send = await page.$eval('[data-testid=composer-send]', (b) => b.textContent.trim());
    assert(send === 'Send 2', `"${send}"`);
    const waiting = tool('wait_for_feedback', { video: slug, since: await cursorNow(), timeout_s: 60 });
    await page.keyboard.down(MOD);
    await page.keyboard.press('Enter');
    await page.keyboard.up(MOD);
    const got = await waiting;
    assert(/^2 new:\n/.test(got) && got.includes('Cut the pause') && got.includes('Music down'), got);
    await until(async () => (await reviewNotes()).length === 4, 'four notes');
    await page.waitForSelector('[data-testid=unsent]', { hidden: true, timeout: 20000 });
  });

  await check('a draft is changed in place and kept; deleting it takes it off at once', async () => {
    await write(60, 'Warmer');
    await page.click('[data-testid=composer-save]');
    await composerGone();
    await page.waitForSelector('[data-testid=note-draft] textarea');
    await page.click('[data-testid=note-draft] textarea');
    await page.keyboard.press('End');
    await page.keyboard.type(' colours here');
    await until(async () => (await api(`/api/review/${enc(slug)}/drafts`)).drafts[0]?.text === 'Warmer colours here', 'the edit, kept');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await videoReady();
    await page.waitForSelector('[data-testid=note-draft] textarea');
    const kept = await page.$eval('[data-testid=note-draft] textarea', (t) => t.value);
    assert(kept === 'Warmer colours here', `after a reload: "${kept}"`);
    await write(100, 'Delete me');
    await page.click('[data-testid=composer-save]');
    await composerGone();
    await until(async () => (await draftCount()) === 2, 'two drafts');
    await page.click('[data-testid=note-draft]:last-of-type button[aria-label="Delete this draft"]');
    await until(async () => (await draftCount()) === 1, 'the deleted one off the list at once');
    await until(async () => (await page.evaluate(() => document.body.innerText)).includes('Deleted the draft'), 'its Undo toast');
    // the toast going away (without Undo) is when the server hears of it
    await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid=toast]')]
        .find((t) => t.textContent.includes('Deleted the draft'))
        ?.querySelector('.toast-x')
        ?.click(),
    );
    await until(async () => (await api(`/api/review/${enc(slug)}/drafts`)).drafts.length === 1, 'the delete, on the server');
  });

  await check('the library card says "1 not sent"; opening the video again says so too', async () => {
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=unsent-mark]', { timeout: 20000 });
    const mark = await page.$eval('[data-testid=unsent-mark]', (e) => e.textContent.trim());
    assert(mark === '1 not sent', `"${mark}"`);
    await shot('drafts-dark-1440-library');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await shot('drafts-light-1440-library');
    await page.click(`.film[data-slug="${slug}"]`);
    await videoReady();
    await until(
      async () => (await page.evaluate(() => document.body.innerText)).includes('1 note on this video is not sent yet'),
      'the reminder when the video opens',
    );
    await shot('drafts-light-1440-reminder');
  });

  await check(
    'the video’s agent isn’t running: Send all asks first (asked each time by default); "Only send" sends, "Send and start" starts it once',
    async () => {
      const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
      await api(`/api/review/${enc(slug)}/session`, 'PUT', { name: 'spot-edit', sessionId: SESSION, cwd: dir, agent: 'claude-code' });
      const runsLog = path.join(dir, 'bin', 'runs.log');
      const runs = () => (fs.existsSync(runsLog) ? fs.readFileSync(runsLog, 'utf8').split(/^--- /m).filter(Boolean) : []);
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
      // a fresh page that knows the agent (the assignment just made)
      await page.reload({ waitUntil: 'domcontentloaded' });
      await videoReady();
      await page.waitForFunction(() => /spot-edit/.test(document.querySelector('[data-testid=agent-button]')?.getAttribute('aria-label') || ''), {
        polling: 100,
        timeout: 20000,
      });
      await page.waitForSelector('[data-testid=unsent]');
      await page.click('[data-testid=drafts-send]');
      await page.waitForSelector('[data-testid=unsent] [data-testid=wake-ask]');
      await shot('drafts-dark-1440-ask', '.side');
      await page.click('[data-testid=wake-send]');
      await page.waitForSelector('[data-testid=unsent]', { hidden: true, timeout: 20000 });
      assert(runs().length === 0, 'only sent: nothing started');
      // on a video with an agent ⌘↵ keeps the note (below): Send is the person's explicit choice
      await write(90, 'Start on this one');
      await page.click('[data-testid=composer-send]');
      await composerGone();
      await page.waitForSelector('[data-testid=unsent] [data-testid=wake-ask]', { timeout: 20000 });
      await page.click('[data-testid=wake-start]');
      await until(
        () => runs().length === 1,
        () => `one run: ${JSON.stringify(runs())}`,
      );
      assert(/1 new note: c_[0-9a-f]{6}/.test(runs()[0]), `started for the batch: ${runs()[0]}`);
      await until(async () => (await reviewNotes()).some((c) => c.text === 'Start on this one'), 'the note sent');
      await sleep(500);
      assert(runs().length === 1, 'started once');
      await api(`/api/review/${enc(slug)}/session`, 'PUT', {});
      // unassigned: the page hears it (the live stream) before the next note is written. Save is raised (⌘↵ saves) until
      // then, and the next check's notes are about a video without an agent.
      await page.waitForFunction(() => document.querySelector('[data-testid=agent-button]')?.getAttribute('aria-label') === 'Agent', {
        polling: 100,
        timeout: 20000,
      });
    },
  );

  await check('the drafts fit: 1440 and 390, light and dark; no sideways scroll, nothing cut', async () => {
    for (const [frame, text] of [
      [60, 'Warmer colours here'],
      [150, 'One more for the record'],
    ]) {
      await write(frame, text);
      await page.click('[data-testid=composer-save]');
      await composerGone();
    }
    // kept on the server too: cards on their way out (a Send) are still on screen for a moment
    await until(
      async () => (await draftCount()) === 2 && (await api(`/api/review/${enc(slug)}/drafts`)).drafts.length === 2,
      async () => `two drafts: ${await draftCount()} on screen, ${(await api(`/api/review/${enc(slug)}/drafts`)).drafts.length} kept`,
    );
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await shot('drafts-light-1440-panel', '.side');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    const fit = await fitsAt(page, 'drafts');
    assert(!fit.length, fit.join('\n'));
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: SHOTS ? 3 : 1, isMobile: true, hasTouch: true });
    await page.reload({ waitUntil: 'domcontentloaded' });
    // the reminder's Show opens the notes sheet on the drafts. It shows for 8 s as soon as the drafts are in, which can be
    // before the video is ready on a busy runner: watched from the reload on, not after the video
    const reminder = page
      .waitForFunction(
        () => [...document.querySelectorAll('[data-testid=toast]')].find((t) => t.textContent.includes('not sent yet'))?.querySelector('.toast-act'),
        { polling: 100, timeout: 20000 },
      )
      .catch(async (e) => {
        // what was there instead: the toasts, the drafts' block, the sheet (its classes: nsheet-<state>), the drafts kept
        const seen = await page.evaluate(() => ({
          toasts: [...document.querySelectorAll('[data-testid=toast]')].map((t) => t.textContent),
          unsent: document.querySelector('[data-testid=unsent]')?.textContent?.slice(0, 120) ?? null,
          sheet: document.querySelector('.nsheet')?.className ?? null,
          url: location.hash,
        }));
        const kept = (await api(`/api/review/${enc(slug)}/drafts`)).drafts.length;
        throw new Error(`no "not sent yet" reminder in 20 s: ${JSON.stringify({ ...seen, kept })} (${e.message})`);
      });
    await videoReady();
    const show = await reminder;
    await show.click();
    await until(
      () =>
        page.evaluate(() => {
          const r = document.querySelector('[data-testid=unsent]')?.getBoundingClientRect();
          return !!r && r.top >= 0 && r.top < innerHeight - 100;
        }),
      'the drafts on screen in the sheet',
    );
    await sleep(400);
    await shot('drafts-dark-390-panel');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await sleep(200);
    await shot('drafts-light-390-panel');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await page.click('[data-testid=new-note]');
    await page.waitForSelector('.composer textarea');
    const rows = await page.$$eval('.nsheet .composer-foot button', (els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().top)))]);
    assert(rows.length === 1, `the composer's toolbar is one row on a phone, Save and Send in it: ${rows.join(', ')}`);
    await shot('drafts-dark-390-composer');
  });

  // ---------------------------------------------------------------- 18 drafts: the pinned head, a single Send, Send all
  const long = makeVideo(path.join(dir, 'Spot/export/long.mp4'), { w: 320, h: 180, fps: 25, dur: 8, pattern: 'testsrc2' });
  age(long);
  const slug2 = (await api('/api/library', 'POST', { path: long })).video.slug;
  const TEXTS = Array.from({ length: 18 }, (_, i) => `Draft ${String(i + 1).padStart(2, '0')}: ${i % 3 ? 'tighten the cut here' : 'logo a touch later'}`);
  for (const [i, text] of TEXTS.entries()) await api(`/api/review/${enc(slug2)}/drafts`, 'POST', { v: 1, frame: 5 + i * 10, text });
  const drafts2 = async () => (await api(`/api/review/${enc(slug2)}/drafts`)).drafts;
  const notes2 = async () => (await api(`/api/review/${enc(slug2)}`)).review.comments;
  const cursor2 = async () => /cursor: (\S+)/.exec(await tool('wait_for_feedback', { video: slug2, timeout_s: 0 }))?.[1];
  const open2 = async () => {
    await page.goto(`${BASE}/#/v/${enc(slug2)}`, { waitUntil: 'domcontentloaded' });
    await videoReady();
    await page.waitForSelector('[data-testid=unsent]', { timeout: 20000 });
  };
  const headText = () => page.$eval('[data-testid=unsent] .unsent-title', (e) => e.textContent.replace(/\s+/g, ' ').trim());
  const sendAllText = () => page.$eval('[data-testid=drafts-send]', (b) => b.textContent.trim());
  // Every value of data-going a card takes on its way out, kept on the card's id (cards leave the DOM afterwards).
  const watchGoing = () =>
    page.evaluate(() => {
      window.__going = {};
      new MutationObserver((ms) => {
        for (const m of ms) {
          const id = m.target.dataset?.id || m.target.dataset?.frame;
          const v = m.target.getAttribute?.('data-going');
          if (!id || !v) continue;
          const seen = window.__going[id] ?? [];
          if (!seen.includes(v)) window.__going[id] = [...seen, v];
        }
      }).observe(document.querySelector('[data-testid=unsent]'), { attributes: true, attributeFilter: ['data-going'], subtree: true });
    });
  const wentBy = () => page.evaluate(() => window.__going);
  // The order a busy machine can give: the server tells the drafts event before it answers a send, so the list fetched
  // for the event (the sent ones gone) can be on screen before the send's answer. The page's answer to the next send is
  // held (`__held`: 'held' once it is here) until `__letSend()`; `__listIn` once a list without `ids` has been read by
  // the app and shown (the query cache tells the screen on a zero timer of its own, set after the read: two timers on).
  const holdSend = (ids) =>
    page.evaluate(
      (route, ids) => {
        const real = window.fetch;
        let go;
        const gate = new Promise((r) => {
          go = r;
        });
        window.__letSend = () => {
          window.fetch = real;
          go();
        };
        window.__held = null;
        window.__listIn = false;
        window.fetch = async (input, init) => {
          const res = await real(input, init);
          const at = new URL(String(input), location.href).pathname;
          const method = init?.method ?? 'GET';
          if (method === 'POST' && at === `${route}/send`) {
            window.__held = 'held';
            await gate;
          } else if (method === 'GET' && at === route && !(await res.clone().json()).drafts.some((d) => ids.includes(d.id))) {
            const read = res.json.bind(res);
            res.json = async () => {
              const data = await read();
              setTimeout(() =>
                setTimeout(() => {
                  window.__listIn = true;
                }),
              );
              return data;
            };
          }
          return res;
        };
      },
      `/api/review/${enc(slug2)}/drafts`,
      ids,
    );
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);

  await check('Send all is the composer’s Send: the brand’s raised primary, "Send 18" and its key cap; while a note is written it steps down', async () => {
    await open2();
    await until(async () => (await draftCount()) === 18, '18 drafts');
    assert((await headText()) === 'Not sent yet · 18', `the head: ${await headText()}`);
    assert((await sendAllText()) === 'Send 18', `Send all says what it sends: "${await sendAllText()}"`);
    const STYLE = ['backgroundImage', 'backgroundColor', 'borderColor', 'color', 'fontWeight', 'fontSize', 'height', 'borderRadius', 'boxShadow'];
    const look = (sel) =>
      page.$eval(
        sel,
        (b, keys) => {
          const s = getComputedStyle(b);
          return {
            classes: [...b.classList],
            keys: b.dataset.keys ?? null,
            cap: getComputedStyle(b, '::after').content,
            style: Object.fromEntries(keys.map((k) => [k, s[k]])),
          };
        },
        STYLE,
      );
    const all = await look('[data-testid=drafts-send]');
    assert(
      ['btn', 'sm', 'primary'].every((c) => all.classes.includes(c)),
      `Send all is a .btn.sm.primary: ${all.classes}`,
    );
    assert(all.keys === '⇧⌘↵' && all.cap !== 'none', `its key cap: ${all.keys} ${all.cap}`);
    await page.click('[data-testid=new-note]');
    await page.waitForSelector('.composer textarea');
    await page.type('.composer .composer-text', 'One more while 18 wait');
    const send = await look('[data-testid=composer-send]');
    assert(
      ['btn', 'sm', 'primary'].every((c) => send.classes.includes(c)),
      `the composer's Send: ${send.classes}`,
    );
    for (const k of STYLE) assert(all.style[k] === send.style[k], `${k}: Send all ${all.style[k]} vs the composer's Send ${send.style[k]}`);
    assert(send.cap !== 'none', 'the composer’s Send has its key cap too');
    // one primary at a time: the composer's Send ("Send 19") takes these along; Send all steps down, keeps its words
    const quiet = await look('[data-testid=drafts-send]');
    assert(!quiet.classes.includes('primary') && quiet.keys === null && quiet.cap === 'none', `Send all while writing: ${JSON.stringify(quiet)}`);
    assert(quiet.style.backgroundColor !== send.style.backgroundColor, 'not in the brand’s colour while the composer is open');
    assert(
      (await sendAllText()) === 'Send 18' && (await page.$eval('[data-testid=composer-send]', (b) => b.textContent.trim())) === 'Send 19',
      'Send 18 · Send 19',
    );
    await shot('drafts-dark-1440-composing-18', '.side');
    await page.click('.composer-close');
    await composerGone();
    assert((await look('[data-testid=drafts-send]')).classes.includes('primary'), 'the primary again once the composer closes');
  });

  // Where the pinned head stands, against what scrolls — the notes list, or the page where the notes sit under the
  // picture (≤ 820 px) — and the filters above the list.
  const pinned = () =>
    page.evaluate(() => {
      const box = (s) => document.querySelector(s)?.getBoundingClientRect();
      const list = document.querySelector('.side-scroll');
      const own = getComputedStyle(list).overflowY !== 'visible';
      const top = document.querySelector('[data-testid=unsent] .unsent-top');
      const head = top.getBoundingClientRect();
      const filters = box('.note-filters');
      const btn = document.querySelector('[data-testid=drafts-send]');
      const b = btn.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return {
        gap: Math.round(head.top - (own ? list.getBoundingClientRect().top : 0)),
        over: filters ? Math.round(filters.bottom - head.top) : 0,
        stuck: top.hasAttribute('data-stuck'),
        onTop: !!hit && btn.contains(hit),
        scrolled: own ? list.scrollTop : scrollY,
      };
    });
  const scrollNotes = (y) =>
    page.evaluate((to) => {
      const list = document.querySelector('.side-scroll');
      if (getComputedStyle(list).overflowY !== 'visible') list.scrollTop = to;
      else window.scrollTo(0, to && document.querySelector('[data-testid=unsent]').getBoundingClientRect().top + scrollY + to);
    }, y);

  await check('the head stays pinned while 18 drafts scroll under it, flush under the filters (768, 1024, 1440, 1920)', async () => {
    for (const [w, h] of [
      [768, 1024],
      [1024, 768],
      [1440, 900],
      [1920, 1080],
    ]) {
      await page.setViewport({ width: w, height: h, deviceScaleFactor: SHOTS ? 2 : 1 });
      await scrollNotes(0);
      await sleep(150);
      const rest = await pinned();
      assert(!rest.stuck, `${w}: at rest the head is in its place, not pinned: ${JSON.stringify(rest)}`);
      await scrollNotes(900);
      await until(async () => (await pinned()).stuck, `${w}: pinned once the drafts scroll`);
      const p = await pinned();
      assert(p.scrolled > 600, `${w}: the list scrolled: ${p.scrolled}`);
      assert(Math.abs(p.gap) <= 1, `${w}: the head sits at the top of the notes list: ${JSON.stringify(p)}`);
      assert(p.over <= 0, `${w}: it never covers the filters: ${JSON.stringify(p)}`);
      assert(p.onTop, `${w}: Send all is on top, nothing over it: ${JSON.stringify(p)}`);
      if (w === 1440) {
        await shot('drafts-dark-1440-pinned', '.side');
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
        await shot('drafts-light-1440-pinned', '.side');
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
      }
    }
    await scrollNotes(0);
  });

  await check('on a phone the head stays pinned in the notes sheet too', async () => {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: SHOTS ? 3 : 1, isMobile: true, hasTouch: true });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await videoReady();
    const show = await page.waitForFunction(
      () => [...document.querySelectorAll('[data-testid=toast]')].find((t) => t.textContent.includes('not sent yet'))?.querySelector('.toast-act'),
      { polling: 100, timeout: 20000 },
    );
    await show.click();
    await page.waitForSelector('.nsheet-half [data-testid=unsent]', { timeout: 20000 });
    await sleep(400);
    await scrollNotes(900);
    await until(async () => (await pinned()).stuck, 'pinned in the sheet');
    const p = await pinned();
    assert(Math.abs(p.gap) <= 1 && p.over <= 0 && p.onTop, `in the sheet: ${JSON.stringify(p)}`);
    await shot('drafts-dark-390-pinned');
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await videoReady();
    await page.waitForSelector('[data-testid=unsent]', { timeout: 20000 });
  });

  await check('a single Send asks first like Send all when the agent could be started ("Only send": that one, nothing started)', async () => {
    const SESSION = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    await api(`/api/review/${enc(slug2)}/session`, 'PUT', { name: 'long-edit', sessionId: SESSION, cwd: dir, agent: 'claude-code' });
    const runsLog = path.join(dir, 'bin', 'runs.log');
    const runsBefore = fs.existsSync(runsLog) ? fs.readFileSync(runsLog, 'utf8') : '';
    await open2();
    await page.waitForFunction(() => /long-edit/.test(document.querySelector('[data-testid=agent-button]')?.getAttribute('aria-label') || ''), {
      polling: 100,
      timeout: 20000,
    });
    await until(async () => (await draftCount()) === 18, '18 drafts');
    // the question comes where the head is (pinned, so it is in sight wherever the card was), quoting the draft
    await scrollNotes(900);
    const card = await page.$('[data-testid=note-draft]:nth-of-type(12)');
    const text = await card.$eval('textarea', (t) => t.value);
    await card.$eval('[data-testid=draft-send]', (b) => b.scrollIntoView({ block: 'center' }));
    await (await card.$('[data-testid=draft-send]')).click();
    await page.waitForSelector('[data-testid=unsent] .unsent-top [data-testid=wake-ask]');
    const quote = await page.$eval('[data-testid=wake-ask] .wake-ask-quote', (q) => q.textContent);
    assert(quote === text, `the question quotes the draft: "${quote}" / "${text}"`);
    const ask = await page.$eval('[data-testid=wake-ask]', (e) => {
      const r = e.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight;
    });
    assert(ask, 'the question is in sight');
    await shot('drafts-dark-1440-single-ask', '.side');
    await page.click('[data-testid=wake-send]');
    await until(async () => (await notes2()).length === 1, 'one note sent');
    assert((await notes2())[0].text === text, 'that one');
    assert((await drafts2()).length === 17, 'the other 17 stay');
    await sleep(400);
    const runsAfter = fs.existsSync(runsLog) ? fs.readFileSync(runsLog, 'utf8') : '';
    assert(runsAfter === runsBefore, 'only sent: nothing started');
    await api(`/api/review/${enc(slug2)}/session`, 'PUT', {});
    // unassigned: nothing to ask any more (the page hears it through the live stream)
    await page.waitForFunction(() => document.querySelector('[data-testid=agent-button]')?.getAttribute('aria-label') === 'Agent', {
      polling: 100,
      timeout: 20000,
    });
  });

  await check('a single Send sends exactly that one: one note, one batch to the waiting agent; the rest, the head and Send all stay', async () => {
    await until(async () => (await draftCount()) === 17, '17 drafts');
    await watchGoing();
    const card = await page.$('[data-testid=note-draft]:nth-of-type(5)');
    const { id, text } = await card.evaluate((c) => ({ id: c.dataset.id, text: c.querySelector('textarea').value }));
    const waiting = tool('wait_for_feedback', { video: slug2, since: await cursor2(), timeout_s: 60 });
    await card.$eval('[data-testid=draft-send]', (b) => b.scrollIntoView({ block: 'center' }));
    await (await card.$('[data-testid=draft-send]')).click();
    const got = await waiting;
    assert(/^1 new:\n/.test(got) && got.includes(text), `the agent gets that one, alone: ${got}`);
    await until(async () => (await notes2()).length === 2, 'two notes in the review');
    assert((await drafts2()).length === 16, 'the other 16 drafts stay');
    await until(async () => (await draftCount()) === 16, 'the card leaves the holding area');
    assert(!(await page.$(`[data-testid=note-draft][data-id="${id}"]`)), 'that card is gone');
    const went = (await wentBy())[id] || [];
    assert(went.includes('sending') && went.includes('leaving'), `it went: ${went}`);
    assert((await headText()) === 'Not sent yet · 16' && (await sendAllText()) === 'Send 16', `the count: ${await headText()} · ${await sendAllText()}`);
    assert(await page.$eval('[data-testid=drafts-send]', (b) => b.classList.contains('primary') && !b.disabled), 'Send all stays, ready');
  });

  await check('⌘↵ on a focused draft sends just that one, and the keyboard goes on to the next draft', async () => {
    const card = await page.$('[data-testid=note-draft]:nth-of-type(3)');
    const { id, text, next } = await card.evaluate((c) => ({
      id: c.dataset.id,
      text: c.querySelector('textarea').value,
      next: c.nextElementSibling?.dataset.id,
    }));
    const waiting = tool('wait_for_feedback', { video: slug2, since: await cursor2(), timeout_s: 60 });
    await card.$eval('textarea', (t) => t.focus());
    await page.keyboard.down(MOD);
    await page.keyboard.press('Enter');
    await page.keyboard.up(MOD);
    const got = await waiting;
    assert(/^1 new:\n/.test(got) && got.includes(text), `that one: ${got}`);
    await until(async () => (await drafts2()).length === 15, '15 drafts left');
    await until(async () => (await draftCount()) === 15, 'its card gone');
    const focus = await page.evaluate(() => document.activeElement?.closest('[data-testid=note-draft]')?.dataset.id);
    assert(focus === next, `the focus went on to the next draft: ${focus} (expected ${next}, sent ${id})`);
  });

  await check('Send all still sends the rest in one batch, every card leaving the same way, and the area with them', async () => {
    await watchGoing();
    // the holding area leaves once: never taken off with its cards a moment before they are put back leaving
    await page.evaluate(() => {
      window.__areaGone = 0;
      new MutationObserver((ms) => {
        for (const m of ms)
          for (const n of m.removedNodes)
            if (n.nodeType === 1 && (n.matches('[data-testid=unsent]') || n.querySelector('[data-testid=unsent]'))) window.__areaGone++;
      }).observe(document.body, { childList: true, subtree: true });
    });
    const ids = await page.$$eval('[data-testid=note-draft]', (cs) => cs.map((c) => c.dataset.id));
    assert(ids.length === 15, `15 cards: ${ids.length}`);
    // the drafts event's list, none of them in it, is on screen before the send's answer comes
    await holdSend(ids);
    let meanwhile;
    try {
      const waiting = tool('wait_for_feedback', { video: slug2, since: await cursor2(), timeout_s: 60 });
      await page.keyboard.down('Shift');
      await page.keyboard.down(MOD);
      await page.keyboard.press('Enter');
      await page.keyboard.up(MOD);
      await page.keyboard.up('Shift');
      const got = await waiting;
      assert(/^15 new:\n/.test(got), `one answer with all 15 (⇧⌘↵): ${got.split('\n')[0]}`);
      await page.waitForFunction(() => window.__held === 'held' && window.__listIn, { polling: 100, timeout: 20000 });
      meanwhile = {
        going: await page.$$eval('[data-testid=note-draft]', (cs) => cs.map((c) => c.dataset.going ?? '')),
        head: await headText().catch(() => null),
        send: await sendAllText().catch(() => null),
      };
    } finally {
      await page.evaluate(() => window.__letSend?.());
    }
    // gone from the page, not only closed to nothing by its motion (a box of no height reads as hidden already)
    await page.waitForFunction(() => !document.querySelector('[data-testid=unsent]'), { polling: 100, timeout: 20000 });
    assert((await notes2()).length === 18 && (await drafts2()).length === 0, 'all 18 sent, none left');
    const went = await wentBy();
    assert(
      ids.every((id) => went[id]?.includes('leaving')),
      `every card left with the motion: ${JSON.stringify(went)}`,
    );
    assert((await page.evaluate(() => window.__areaGone)) === 1, `the area left once: ${await page.evaluate(() => window.__areaGone)}`);
    assert(
      meanwhile.going.length === 15 && meanwhile.going.every((g) => g === 'sending') && meanwhile.head === 'Not sent yet · 15' && meanwhile.send === 'Send 15',
      `until the answer every card kept its place, sending, and the head its count: ${JSON.stringify(meanwhile)}`,
    );
  });

  // ---------------------------------------------------------------- an agent's video: notes go to it together
  const agentFile = makeVideo(path.join(dir, 'Spot/export/agent.mp4'), { w: 320, h: 180, fps: 25, dur: 8, pattern: 'testsrc2' });
  age(agentFile);
  const slug3 = (await api('/api/library', 'POST', { path: agentFile })).video.slug;
  const notes3 = async () => (await api(`/api/review/${enc(slug3)}`)).review.comments;
  const drafts3 = async () => (await api(`/api/review/${enc(slug3)}/drafts`)).drafts;
  const cursor3 = async () => /cursor: (\S+)/.exec(await tool('wait_for_feedback', { video: slug3, timeout_s: 0 }))?.[1];
  const waitLine = () => page.$eval('[data-testid=agent-waiting]', (e) => e.textContent.trim()).catch(() => null);
  const toastSaid = (what) => page.evaluate((w) => [...document.querySelectorAll('[data-testid=toast]')].some((t) => t.textContent.includes(w)), what);
  const keep = async (frame, text, how) => {
    await write(frame, text, slug3);
    if (how === 'key') {
      await page.keyboard.down(MOD);
      await page.keyboard.press('Enter');
      await page.keyboard.up(MOD);
    } else await page.click('[data-testid=composer-save]');
    await composerGone();
  };
  const shots3 = async (name, sel = '.side') => {
    if (!SHOTS) return;
    await sleep(300);
    await shot(`agent-wait-dark-${name}`, sel);
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await sleep(200);
    await shot(`agent-wait-light-${name}`, sel);
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  };
  // a fresh load every time (a new viewport, a language picked in storage), never just a hash change
  const open3 = async () => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${enc(slug3)}`, { waitUntil: 'domcontentloaded' });
    await videoReady();
  };

  // Save and Send as they stand in the composer: each one's box (from the composer's corner: an agent assigned to the
  // video brings its line under the panel's head, which moves the whole panel, not the buttons in it), in the order
  // they come, and which is raised.
  const footButtons = () =>
    page.$$eval('.composer-send .btn', (bs) =>
      bs.map((b) => {
        const r = b.getBoundingClientRect();
        const c = b.closest('.composer')?.getBoundingClientRect() ?? { x: 0, y: 0 };
        return { id: b.dataset.testid, x: r.x - c.x, y: r.y - c.y, w: r.width, h: r.height, raised: b.classList.contains('primary') };
      }),
    );
  const raisedIs = (id) =>
    page.waitForFunction((t) => document.querySelector(`[data-testid=${t}]`)?.classList.contains('primary'), { polling: 100, timeout: 20000 }, id);
  const where = (bs) => bs.map((b) => `${b.id}${b.raised ? '*' : ''}@${b.x.toFixed(1)},${b.y.toFixed(1)} ${b.w.toFixed(1)}×${b.h.toFixed(1)}`).join(' ');
  const near = (a, b) => Math.abs(a - b) < 0.5;
  const samePlaces = (a, b, what) =>
    assert(
      a.length === 2 && b.length === 2 && a.every((x, i) => x.id === b[i].id && ['x', 'y', 'w', 'h'].every((k) => near(x[k], b[i][k]))),
      `${what}: ${where(a)} → ${where(b)}`,
    );
  // the raised one is the rightmost, the order on screen is the order of the focus, and the two read as `order`
  const raisedLast = (bs, order, what) => {
    const seen = [...bs].sort((a, b) => a.x - b.x);
    assert(
      bs.length === 2 && seen.every((b, i) => b === bs[i]) && seen[1].raised && !seen[0].raised && seen.map((b) => b.id).join(' ') === order,
      `${what}: ${order}, the raised one last: ${where(bs)}`,
    );
  };
  // swapped in the same room: each button as wide and tall as before, the pair where it was and as wide
  const sameRoom = (a, b, what) => {
    const pair = (bs) => ({ x: Math.min(...bs.map((p) => p.x)), r: Math.max(...bs.map((p) => p.x + p.w)), y: bs[0].y });
    const [pa, pb] = [pair(a), pair(b)];
    assert(
      a.length === 2 &&
        b.length === 2 &&
        a.every((x) => b.some((y) => y.id === x.id && near(y.w, x.w) && near(y.h, x.h) && near(y.y, x.y))) &&
        ['x', 'r', 'y'].every((k) => near(pa[k], pb[k])),
      `${what}: ${where(a)} → ${where(b)}`,
    );
  };

  await check(
    'the raised one of Save and Send is the rightmost, with or without an agent; one coming, waiting and going while a note is written swaps them in the same room (1440; 390 with the foot pinned)',
    async () => {
      const LONG = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}: the cut to the product shot feels rushed.`).join(' ');
      for (const [w, h, phone] of [
        [1440, 900, false],
        [390, 844, true],
      ]) {
        await page.setViewport({ width: w, height: h, deviceScaleFactor: SHOTS ? 2 : 1, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
        await open3();
        if (phone) {
          // a note this long pins the foot to the sheet's bottom, where a line coming in it would lift the buttons: flush
          // with the bottom edge, the line being written just above it
          await page.click('[data-testid=new-note]');
          await page.waitForSelector('.composer textarea');
          await page.type('.composer .composer-text', LONG);
          const pin = await page.evaluate(() => {
            const list = document.querySelector('.nsheet .side-scroll');
            const foot = document.querySelector('.composer-foot').getBoundingClientRect();
            const text = document.querySelector('.composer-text');
            const end = text.getBoundingClientRect().bottom - Number.parseFloat(getComputedStyle(text).paddingBottom);
            return { scrolls: list.scrollHeight > list.clientHeight + 1, below: list.getBoundingClientRect().bottom - foot.bottom, under: end - foot.top };
          });
          assert(pin.scrolls && Math.abs(pin.below) < 1 && pin.under <= 1, `the foot pinned flush, the note's end above it: ${JSON.stringify(pin)}`);
        } else await write(30, 'Hold the title until the beat', slug3);
        const alone = await footButtons();
        raisedLast(alone, 'composer-save composer-send', `${w}, no agent: Save, then Send raised`);
        // the agent is assigned (Save is raised, and last), then waits (an open wait_for_feedback: the line under them)
        await api(`/api/review/${enc(slug3)}/session`, 'PUT', { name: 'drafts-agent', sessionId: 'mcp-drafts-agent', agent: 'mcp' });
        await raisedIs('composer-save');
        const assigned = await footButtons();
        raisedLast(assigned, 'composer-send composer-save', `${w}, the agent assigned: Send, then Save raised`);
        sameRoom(alone, assigned, `${w}: the agent assigned swaps them in the same room`);
        const stop = new AbortController();
        mcp
          .callTool({ name: 'wait_for_feedback', arguments: { video: slug3, since: await cursor3(), timeout_s: 120 } }, { signal: stop.signal })
          .catch(() => {});
        await page.waitForSelector('.composer [data-testid=agent-waiting]', { timeout: 40_000 });
        samePlaces(assigned, await footButtons(), `${w}: the agent waiting moves neither`);
        await shot(`composer-agent-${w}`, phone ? null : '.side');
        // unassigned while the note is still being written: back as they were
        await api(`/api/review/${enc(slug3)}/session`, 'PUT', {});
        await raisedIs('composer-send');
        await page.waitForSelector('.composer [data-testid=agent-waiting]', { hidden: true, timeout: 20000 });
        samePlaces(alone, await footButtons(), `${w}: the agent gone puts them back`);
        stop.abort();
        await page.click('.composer-close');
        await composerGone();
      }
      assert((await drafts3()).length === 0 && (await notes3()).length === 0, 'nothing kept, nothing sent');
    },
  );

  await check(
    'an agent’s video keeps notes: ⌘↵ and the main button save three as drafts the waiting agent never hears, "Send 3 to drafts-agent" brings all three in one answer; a reply still goes at once',
    async () => {
      // the MCP client above is drafts-agent: assigned, and waiting (an open wait_for_feedback)
      await api(`/api/review/${enc(slug3)}/session`, 'PUT', { name: 'drafts-agent', sessionId: 'mcp-drafts-agent', agent: 'mcp' });
      let answered = null;
      const waiting = tool('wait_for_feedback', { video: slug3, since: await cursor3(), timeout_s: 300 }).then((t) => {
        answered = t;
        return t;
      });
      waiting.catch(() => {}); // a check that fails early leaves it open until the client closes
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
      await open3();
      // writing the first: Save is the raised main action with ⌘↵, last; Send the quiet one before it; the line says who waits
      await write(20, 'Logo lands too early', slug3);
      await page.waitForSelector('.composer [data-testid=agent-waiting]', { timeout: 40_000 });
      assert((await waitLine()) === 'drafts-agent is waiting · gets your notes when you send', `the line: ${await waitLine()}`);
      const buttons = await page.$$eval('.composer-send .btn', (bs) =>
        bs.map((b) => `${b.dataset.testid}:${b.classList.contains('primary') ? 'primary' : 'quiet'}:${b.dataset.keys ?? ''}`),
      );
      assert(buttons.join(' ') === 'composer-send:quiet: composer-save:primary:⌘↵', `Send quiet, then Save raised with ⌘↵: ${buttons}`);
      await shots3('1440-composer');
      await page.keyboard.down(MOD);
      await page.keyboard.press('Enter');
      await page.keyboard.up(MOD);
      await composerGone();
      await keep(60, 'Title a touch bigger', 'button');
      await keep(100, 'Music down under the voice', 'key');
      await until(async () => (await draftCount()) === 3, 'three drafts');
      assert((await drafts3()).length === 3 && (await notes3()).length === 0, 'kept, none sent');
      assert(answered === null, `the waiting agent heard nothing: ${answered}`);
      // the release: one action that names the agent, and the line with it
      const release = await page.$eval('[data-testid=drafts-send]', (b) => ({ text: b.textContent.trim(), primary: b.classList.contains('primary') }));
      assert(release.text === 'Send 3 to drafts-agent' && release.primary, `the release: ${JSON.stringify(release)}`);
      assert((await waitLine()) === 'drafts-agent is waiting · gets your notes when you send', `the line in the block: ${await waitLine()}`);
      assert((await page.$$('[data-testid=agent-waiting]')).length === 1, 'one line, not two');
      await shots3('1440');
      if (SHOTS) {
        for (const [w, h, tag, phone] of [
          [1024, 768, '1024', false],
          [390, 844, '390', true],
        ]) {
          await page.setViewport({ width: w, height: h, deviceScaleFactor: 2, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
          await open3();
          if (phone) {
            const show = await page.waitForFunction(
              () => [...document.querySelectorAll('[data-testid=toast]')].find((t) => t.textContent.includes('not sent yet'))?.querySelector('.toast-act'),
              { polling: 100, timeout: 20000 },
            );
            await show.click();
          }
          await page.waitForSelector('[data-testid=unsent] [data-testid=agent-waiting]', { timeout: 40_000 });
          await shots3(tag, phone ? null : '.side');
          await page.click('[data-testid=new-note]');
          await page.waitForSelector('.composer [data-testid=agent-waiting]');
          await shots3(`${tag}-composer`, phone ? null : '.side');
        }
        // German at 1440
        await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
        await page.evaluate(() => localStorage.setItem('vr.lang', 'de'));
        await open3();
        await page.waitForSelector('[data-testid=unsent] [data-testid=agent-waiting]', { timeout: 40_000 });
        assert((await waitLine()) === 'drafts-agent wartet · bekommt deine Notizen, wenn du sendest', `German: ${await waitLine()}`);
        await shot('agent-wait-dark-1440-de', '.side');
        await page.click('[data-testid=new-note]');
        await page.waitForSelector('.composer [data-testid=agent-waiting]');
        await shot('agent-wait-dark-1440-de-composer', '.side');
        await page.evaluate(() => localStorage.removeItem('vr.lang'));
        await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
        await open3();
        await page.waitForSelector('[data-testid=unsent] [data-testid=agent-waiting]', { timeout: 40_000 });
      }
      assert(answered === null, 'still nothing heard');
      await page.click('[data-testid=drafts-send]');
      const got = await waiting;
      assert(/^3 new:\n/.test(got), `one answer with all three: ${got}`);
      for (const text of ['Logo lands too early', 'Title a touch bigger', 'Music down under the voice']) assert(got.includes(text), `${text}: ${got}`);
      await until(() => toastSaid('drafts-agent got your 3 notes'), 'the toast says it got them');
      await until(async () => (await notes3()).length === 3, 'three notes in the review');
      // a reply is the agent's to hear at once: it isn't kept (a guard: replies were never kept)
      const first = (await notes3()).find((c) => c.text === 'Logo lands too early');
      const hearing = tool('wait_for_feedback', { video: slug3, since: await cursor3(), timeout_s: 60 });
      hearing.catch(() => {});
      const card3 = `.side-scroll [data-note="${first.id}"]`;
      await page.waitForSelector(card3);
      if (!(await page.$(`${card3}.active`))) await page.click(`${card3} .nr`);
      await page.waitForSelector(`${card3}.active .reply-stub`);
      await page.click(`${card3} .reply-stub`);
      await page.type(`${card3} .note-editor textarea`, 'And keep the logo where it is');
      await page.keyboard.down(MOD);
      await page.keyboard.press('Enter');
      await page.keyboard.up(MOD);
      const reply = await hearing;
      assert(/^1 new:\n.*REPLY/.test(reply) && reply.includes('And keep the logo where it is'), `the reply, at once: ${reply}`);
      assert((await drafts3()).length === 0, 'nothing kept');
    },
  );

  await check('no page errors', async () => {
    assert(!errors.length, errors.join('\n'));
  });
} catch (e) {
  crashed(e, srv);
}
await mcp?.close().catch(() => {});
await finish(LABEL, { browser, servers: [srv] });
