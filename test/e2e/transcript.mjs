#!/usr/bin/env node
// covers: web/src/player/Transcript.tsx web/src/styles/transcript.css server/routes/transcripts.ts lib/transcript.ts
// covers: lib/transcripts.ts lib/stt/
// Browser end-to-end test of the transcript tab: a real server (local mode, temp store, free port) whose speech engine
// is a stand-in OpenAI-compatible server in this process (synthetic words with timings — never real audio of anyone),
// and headless Chrome. What is said shows line by line; a click on a word goes to the frame it starts on; the word
// heard lights up while the playhead is in it; search keeps the lines that say it; the foot says what heard it in which
// language and downloads captions from one menu; words dragged over show in the pick bar (label, range, Play, ×) and
// become a "Change the words" note with their range and a text_edit; the card shows the change; a new version's
// transcript is compared with the one before; Listen again in a picked language sends language= through to the engine;
// every width from 390 to 1920 fits, dark and light. Screenshots land in VR_SHOTS.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { formatRange } from '../../lib/range.ts';
import { age, freePort, makeVideo, sleep, until } from '../lib/helpers.ts';
import { layoutMatrix } from './layout.mjs';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'transcript e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();

// The stand-in speech server: V1 (4 s) and V2 (5 s) are told apart by the length of the audio sent (16 kHz, 16-bit WAV).
const words = (list) => list.map(([word, start, end]) => ({ word, start, end }));
const SAID = {
  v1: words([
    ['Every', 0.2, 0.44],
    ['morning', 0.44, 0.84],
    ['we', 0.84, 1.0],
    ['start', 1.0, 1.24],
    ['the', 1.24, 1.36],
    ['day.', 1.36, 1.72],
    ['Coffee', 2.4, 2.8],
    ['first,', 2.8, 3.12],
    ['then', 3.12, 3.32],
    ['the', 3.32, 3.44],
    ['plan.', 3.44, 3.84],
  ]),
  v2: words([
    ['Every', 0.2, 0.44],
    ['evening', 0.44, 0.84],
    ['we', 0.84, 1.0],
    ['start', 1.0, 1.24],
    ['the', 1.24, 1.36],
    ['day.', 1.36, 1.72],
    ['Tea', 2.4, 2.8],
    ['first,', 2.8, 3.12],
    ['then', 3.12, 3.32],
    ['the', 3.32, 3.44],
    ['plan.', 3.44, 3.84],
  ]),
};
let heard = 0;
// the language each request asked for ('' = detect): a language picked in the transcript's foot must reach the engine
const asked = [];
const NAMED = { sv: 'swedish', de: 'german' };
const stt = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (d) => {
    chunks.push(d);
  });
  req.on('end', () => {
    if (req.method !== 'POST') return res.writeHead(404).end();
    heard++;
    const body = Buffer.concat(chunks);
    const field = /name="language"\r\n\r\n([a-z]{2,3})\r\n/.exec(body.toString('latin1'));
    asked.push(field?.[1] ?? '');
    const said = body.length > 145_000 ? SAID.v2 : SAID.v1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ text: said.map((w) => w.word).join(' '), language: NAMED[field?.[1]] ?? 'english', words: said, segments: [] }));
  });
});
const sttPort = await freePort();
await new Promise((r) => stt.listen(sttPort, '127.0.0.1', r));
const srv = await startServer({
  prefix: 'vr-transcript-e2e-',
  user: 'Sam',
  env: { VR_STT: 'http', VR_STT_URL: `http://127.0.0.1:${sttPort}/v1` },
});
const { dir, base: BASE } = srv;
process.on('exit', () => stt.close());

const api = jsonApi(BASE);

const FPS = 25;
let browser;
let page;
screenshotFailures(() => page, 'transcript');
try {
  const file = makeVideo(path.join(dir, 'Spot/export/morning.mp4'), { w: 320, h: 180, fps: FPS, dur: 4, pattern: 'testsrc2' });
  age(file);
  const { video } = await api('/api/library', 'POST', { path: file });
  const slug = video.slug;
  const enc = encodeURIComponent;
  const review = async () => (await api(`/api/review/${enc(slug)}`)).review;
  const transcript = async (v) => {
    const a = await api(`/api/review/${enc(slug)}/transcript?v=${v}`);
    return a.state === 'ready' ? a.transcript : null;
  };

  browser = await launch();
  // captions are downloads: into the throwaway store, never a real Downloads folder
  const downloads = path.join(dir, 'downloads');
  fs.mkdirSync(downloads, { recursive: true });
  const cdp = await browser.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
  page = await browser.newPage();
  // what the page asks the server to hear again
  const reruns = [];
  page.on('request', (r) => r.method() === 'POST' && r.url().includes('/transcript/rerun') && reruns.push(new URL(r.url()).searchParams));
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));
  const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  const videoReady = () =>
    page.waitForFunction(
      () => {
        const v = document.querySelector('.vbox video');
        return v && v.readyState >= 2 && !v.seeking;
      },
      { polling: 100, timeout: 20000 },
    );
  const openPlayer = async () => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${enc(slug)}`, { waitUntil: 'domcontentloaded' });
    await videoReady();
    await sleep(300);
  };
  const shownFrame = () => page.$eval('.tc .sub b', (e) => Number(e.textContent));
  const lines = () => page.$$eval('[data-testid=transcript] .tr-line', (ls) => ls.map((l) => l.querySelector('.tr-words')?.textContent));
  const word = (i) => `[data-testid=transcript] [data-w="${i}"]`;

  console.log(`transcript e2e against ${BASE} (store ${dir})`);

  await check('the Transcript tab hears the render once and shows what is said, line by line', async () => {
    await openPlayer();
    await page.click('[data-testid=panel-transcript]');
    await page.waitForSelector('[data-testid=transcript] .tr-line [data-w]', { timeout: 60000 });
    assert(JSON.stringify(await lines()) === JSON.stringify(['Every morning we start the day.', 'Coffee first, then the plan.']), `lines: ${await lines()}`);
    const meta = await page.$eval('.side-count', (e) => e.textContent);
    assert(meta === 'English · 11 words', `the head names the language and the words: ${meta}`);
    assert(heard === 1, `heard once: ${heard}`);
    const selected = await page.$eval('[data-testid=panel-transcript]', (e) => e.getAttribute('aria-selected'));
    assert(selected === 'true', 'the tab is chosen');
    await shot('transcript-dark-1440-tab');
  });

  await check('the foot says what heard the words and in which language; captions are one download menu', async () => {
    const said = await page.$eval('[data-testid=transcript-heard]', (e) => e.textContent);
    assert(said === 'Heard in English · Whisper', `the foot's line: ${said}`);
    // the stand-in times every word: nothing estimated to warn about
    assert(!(await page.$('.tr-heard-info')), 'no timing caveat for an engine that times words');
    await page.click('[data-testid=transcript-captions]');
    await page.waitForSelector('.menu [role=menuitem]');
    const items = await page.$$eval('.menu [role=menuitem]', (els) => els.map((e) => e.textContent.trim()));
    assert(JSON.stringify(items) === JSON.stringify(['SRT (most editors)', 'WebVTT (web players)']), `the captions menu: ${items}`);
    await shot('transcript-dark-1440-captions');
    await (await page.$$('.menu [role=menuitem]'))[0].click();
    await until(() => fs.readdirSync(downloads).includes('transcript-v1.srt'), 'the SRT downloaded');
    const srt = fs.readFileSync(path.join(downloads, 'transcript-v1.srt'), 'utf8');
    assert(/^1\r?\n00:00:00,\d{3} --> /.test(srt) && srt.includes('Every morning we start the day.'), srt);
    await page.waitForFunction(() => !document.querySelector('.menu'), { polling: 100, timeout: 5000 });
  });

  const t1 = await transcript(1);
  await check('a click on a word goes to the frame it starts on; hover says its timecode', async () => {
    const morning = t1.words[1];
    await page.click(word(1));
    await until(async () => (await shownFrame()) === morning.f0, `the playhead on f${morning.f0}`);
    const title = await page.$eval(word(1), (e) => e.title);
    assert(title.includes(`f${morning.f0}`) && /^\d\d:\d\d:\d\d/.test(title), `the word's tooltip: ${title}`);
    await until(() => page.$eval(word(1), (e) => e.hasAttribute('data-now')), 'the word heard is lit');
    const here = await page.$eval('[data-testid=transcript] .tr-line[data-l="0"]', (e) => e.hasAttribute('data-here'));
    assert(here, 'its line is the one heard');
    // the line's timecode goes to the line
    await page.click('[data-testid=transcript] .tr-line[data-l="1"] .tr-tc');
    await until(async () => (await shownFrame()) === t1.lines[1].f0, 'the playhead on the second line');
    await until(() => page.$eval(word(6), (e) => e.hasAttribute('data-now')), 'its first word lit');
  });

  await check('the word heard follows playback', async () => {
    await page.click(word(0));
    await until(async () => (await shownFrame()) === t1.words[0].f0, 'back at the first word');
    const lit = () => page.$eval('[data-testid=transcript]', (e) => Number(e.querySelector('[data-w][data-now]')?.getAttribute('data-w') ?? -1));
    await page.keyboard.press('Space');
    await until(async () => (await lit()) >= 2, 'a later word lit while it plays', 8000);
    await page.keyboard.press('Space');
  });

  await check('search keeps the lines that say it and lights the words', async () => {
    await page.type('.tr-search input', 'coffee');
    await until(async () => (await lines()).length === 1, 'one line left');
    const hits = await page.$$eval('[data-testid=transcript] .tr-hit', (ws) => ws.map((w) => w.textContent));
    assert(JSON.stringify(hits) === '["Coffee"]', `hits: ${hits}`);
    await page.click('.tr-search input', { count: 3 });
    await page.keyboard.press('Backspace');
    await until(async () => (await lines()).length === 2, 'every line back');
  });

  // what the pick bar holds: its label, the words, their range, and its buttons by name
  const bar = () =>
    page
      .$eval('[data-testid=transcript-pick]', (e) => ({
        label: e.querySelector('.tr-pick-label')?.textContent,
        words: e.querySelector('.tr-pick-words')?.textContent,
        at: e.querySelector('.tr-pick-at')?.textContent,
        play: e.querySelector('[data-testid=transcript-pick-play]')?.textContent.trim(),
        clear: e.querySelector('[data-testid=transcript-pick-clear]')?.getAttribute('aria-label') ?? null,
        change: e.querySelector('[data-testid=change-words-button]')?.textContent.trim(),
      }))
      .catch(() => ({})); // no bar without a selection

  await check('words dragged over become a "Change the words" note with their range', async () => {
    // nothing picked: the line under the playhead carries Play and Change the words itself — where the eye is
    const idle = await page.$eval('[data-testid=transcript] .tr-line[data-here]', (l) => ({
      play: l.querySelector('[data-testid=line-play]')?.getAttribute('aria-label'),
      change: l.querySelector('[data-testid=line-change]')?.getAttribute('aria-label'),
      shown: getComputedStyle(l.querySelector('.tr-line-acts')).visibility,
    }));
    assert(idle.play === 'Play this line' && idle.change === 'Change the words' && idle.shown === 'visible', JSON.stringify(idle));
    assert(!(await page.$('[data-testid=transcript-pick]')), 'no bar without a selection');
    const box = async (i) => page.$eval(word(i), (e) => JSON.parse(JSON.stringify(e.getBoundingClientRect())));
    const a = await box(1);
    const b = await box(2);
    await page.mouse.move(a.x + 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 5 });
    await page.mouse.move(b.x + b.width - 1, b.y + b.height / 2, { steps: 3 });
    await page.mouse.up();
    await until(
      () => page.$eval('[data-testid=transcript-pick] .tr-pick-words', (e) => e.textContent === 'morning we').catch(() => false),
      'the pick bar names the words',
    );
    const picked = await bar();
    const range = formatRange({ in: t1.words[1].f0, out: t1.words[2].f1 }, FPS);
    assert(picked.label === 'Selected' && picked.at === range, `the bar says what and where: ${JSON.stringify(picked)} (range ${range})`);
    assert(picked.clear === 'Clear the selection' && picked.change === 'Change the words', JSON.stringify(picked));
    // the bar floats at the words, not at the panel's foot
    const near = await page.evaluate(() => {
      const bar = document.querySelector('[data-testid=transcript-pick]').getBoundingClientRect();
      const w = document.querySelector('[data-testid=transcript] .tr-sel').getBoundingClientRect();
      return Math.min(Math.abs(w.top - bar.bottom), Math.abs(bar.top - w.bottom));
    });
    assert(near <= 12, `the bar sits right at the picked words: ${near}px away`);
    await shot('transcript-dark-1440-picked');
    await page.click('[data-testid=change-words-button]');
    await page.waitForSelector('.composer [data-testid=change-words]');
    const from = await page.$eval('.composer .cw-from', (e) => e.textContent);
    assert(from === 'morning we', `heard: ${from}`);
    const focus = await page.evaluate(() => {
      const el = document.activeElement;
      return { cls: el?.className, all: el?.selectionStart === 0 && el?.selectionEnd === el?.value.length, value: el?.value };
    });
    assert(String(focus.cls).includes('cw-to') && focus.all && focus.value === 'morning we', `the words field, all selected: ${JSON.stringify(focus)}`);
    const ctl = await page.$eval('.composer [data-testid=range-ctl]', (e) => e.textContent);
    assert(ctl.includes('→'), `the composer is about the words' range: ${ctl}`);
    // the same toolbar as every note (severity, tags, the paperclip), but no "whole video": words are said in their range
    for (const sel of ['.sev-pick', 'button[aria-label="Tags"]', '[data-testid=ref-attach]'])
      assert(await page.$(`.composer .composer-foot ${sel}`), `the composer's toolbar has ${sel}`);
    assert(!(await page.$('.composer [data-testid=composer-where]')), 'no whole-video menu for words');
    await page.keyboard.type('evening we');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Warmer, it airs at night');
    await shot('transcript-dark-1440-composer');
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');
    await page.waitForFunction(() => !document.querySelector('.composer'), { polling: 100, timeout: 20000 });
    const note = (await review()).comments.find((c) => c.text_edit);
    assert(note, 'a note with a text edit');
    assert(JSON.stringify(note.text_edit) === JSON.stringify({ from: 'morning we', to: 'evening we' }), JSON.stringify(note.text_edit));
    assert(note.range?.in === t1.words[1].f0 && note.range?.out === t1.words[2].f1, `range ${JSON.stringify(note.range)}`);
    assert(note.frame === t1.words[1].f0 && note.text === 'Warmer, it airs at night', `${note.frame} ${note.text}`);
    // the words it asks to change are marked in the transcript
    await until(() => page.$$eval('[data-testid=transcript] .tr-ed', (ws) => ws.map((w) => w.textContent).join(' ') === 'morning we'), 'the words marked');
  });

  await check('the pick bar: × lets go of the words; it never covers the last line or the foot', async () => {
    await page.evaluate(() => {
      const at = (i) => document.querySelector(`[data-testid=transcript] [data-w="${i}"]`).firstChild;
      const r = document.createRange();
      r.setStart(at(6), 0);
      r.setEnd(at(7), at(7).length);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    });
    await until(async () => (await bar()).label === 'Selected', 'the words picked');
    assert((await bar()).words === 'Coffee first,', JSON.stringify(await bar()));
    await page.click('[data-testid=transcript-pick-clear]');
    await until(async () => !(await page.$('[data-testid=transcript-pick]')), 'the bar goes with the selection');
    assert(await page.evaluate(() => getSelection().isCollapsed), 'the selection is gone');
    // a short panel scrolls: a fade at its foot while more lines follow, none at the end
    await page.setViewport({ width: 1440, height: 480 });
    await sleep(200);
    await page.$eval('[data-testid=transcript]', (sc) => {
      sc.scrollTop = 0;
    });
    await until(
      () => page.$eval('[data-testid=transcript]', (sc) => sc.scrollHeight <= sc.clientHeight + 1 || sc.classList.contains('more-b')),
      'a fade while more lines follow',
    );
    await page.$eval('[data-testid=transcript]', (sc) => {
      sc.scrollTop = sc.scrollHeight;
    });
    await until(() => page.$eval('[data-testid=transcript]', (sc) => !sc.classList.contains('more-b')), 'no fade at the end');
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 });
  });

  await check('the note shows the change as a small diff', async () => {
    await page.click('[data-testid=panel-notes]');
    await page.waitForSelector('.note [data-testid=text-edit]');
    const diff = await page.$eval('.note [data-testid=text-edit]', (e) => ({
      del: e.querySelector('del')?.textContent,
      ins: e.querySelector('ins')?.textContent,
    }));
    assert(diff.del === 'morning we' && diff.ins === 'evening we', JSON.stringify(diff));
    await shot('transcript-dark-1440-note');
    await page.click('[data-testid=panel-transcript]');
  });

  await check('a new version is compared with the one before, word by word', async () => {
    makeVideo(file, { w: 320, h: 180, fps: FPS, dur: 5, pattern: 'testsrc', freq: 660 });
    age(file);
    await api(`/api/review/${enc(slug)}/sync`, 'POST', {});
    await openPlayer();
    // the "Change the words" note above is open, so the player opens on Notes (the Transcript tab isn't restored
    // over open notes): pick the tab, the way a person would
    if ((await page.$eval('[data-testid=panel-transcript]', (e) => e.getAttribute('aria-selected'))) !== 'true')
      await page.click('[data-testid=panel-transcript]');
    await page.waitForSelector('[data-testid=transcript] .tr-line [data-w]', { timeout: 60000 });
    await until(async () => (await lines())[0] === 'Every evening we start the day.', 'V2’s words');
    await page.click('[data-testid=transcript-diff-toggle]');
    await page.waitForSelector('[data-testid=transcript-diff]');
    const d = await page.$eval('[data-testid=transcript-diff]', (e) => ({
      del: [...e.querySelectorAll('del')].map((x) => x.textContent),
      ins: [...e.querySelectorAll('ins')].map((x) => x.textContent),
      lines: e.querySelectorAll('.tr-line').length,
    }));
    assert(JSON.stringify(d) === JSON.stringify({ del: ['morning', 'Coffee'], ins: ['evening', 'Tea'], lines: 2 }), JSON.stringify(d));
    assert(heard === 2, `each version heard once: ${heard}`);
    await shot('transcript-dark-1440-diff');
    await page.click('[data-testid=transcript-diff-toggle]');
  });

  await check('Listen again in another language sends language= and the words come back heard in it', async () => {
    const heardAs = (text) => page.$eval('[data-testid=transcript-heard]', (e, x) => e.textContent === x, text).catch(() => false);
    await until(() => heardAs('Heard in English · Whisper'), 'the foot under V2');
    await page.$eval('[data-testid=transcript-rerun-language]', (e) => e.scrollIntoView({ block: 'center' }));
    await page.click('[data-testid=transcript-rerun-language]');
    await page.waitForSelector('.menu [role=menuitem]');
    const items = await page.$$eval('.menu [role=menuitem]', (els) => els.map((e) => e.textContent.trim()));
    assert(items[0] === 'English (heard)' && items.includes('Swedish') && items.includes('German'), `the languages: ${items.slice(0, 6)} …`);
    assert(new Set(items).size === items.length, `each language once: ${items}`);
    await shot('transcript-dark-1440-languages');
    const n = asked.length;
    await (await page.$$('.menu [role=menuitem]'))[items.indexOf('Swedish')].click();
    await until(() => reruns.some((q) => q.get('language') === 'sv' && q.get('v') === '2'), 'the page asks for V2 in Swedish');
    await until(() => asked.length > n && asked.at(-1) === 'sv', 'the engine is asked for Swedish');
    await until(() => heardAs('Heard in Swedish · Whisper'), 'the foot says Swedish', 30000);
    const meta = await page.$eval('.side-count', (e) => e.textContent);
    assert(meta === 'Swedish · 11 words', `the head too: ${meta}`);
    // Listen again by itself detects: no language= on the request, none for the engine
    const r = reruns.length;
    const m = asked.length;
    await page.click('[data-testid=transcript-rerun]');
    await until(() => reruns.length > r && asked.length > m, 'heard again');
    assert(!reruns.at(-1).has('language') && asked.at(-1) === '', `detected: ${reruns.at(-1)} / ${asked.at(-1)}`);
    await until(() => heardAs('Heard in English · Whisper'), 'English again', 30000);
  });

  await check('every width fits, dark and light', async () => {
    const bad = await layoutMatrix(page, { transcript: null });
    await page.emulateMediaFeatures([]);
    assert(!bad.length, bad.join('\n'));
  });

  if (SHOTS)
    await check(
      'screenshots: the tab, its foot and languages, a pick, the composer, the note and the comparison at 1440, 1024 and 390, dark and light',
      async () => {
        for (const theme of ['dark', 'light'])
          for (const [w, h, mobile] of [
            [1440, 900, false],
            [1024, 768, false],
            [390, 844, true],
          ]) {
            await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
            await page.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile });
            await openPlayer();
            const at = `${theme}-${w}`;
            // on a phone the tab opens the notes sheet (it peeks after a load)
            await page.$eval('[data-testid=panel-transcript]', (e) => e.click());
            await page.waitForSelector('[data-testid=transcript] .tr-line [data-w]');
            const reveal = () => mobile && page.$eval('.side', (e) => e.scrollIntoView({ block: 'start' }));
            await reveal();
            await sleep(300);
            await shot(`transcript-${at}-tab`);
            await page.$eval('[data-testid=transcript-diff-toggle]', (e) => e.click());
            await page.waitForSelector('[data-testid=transcript-diff]');
            await sleep(200);
            await reveal();
            await shot(`transcript-${at}-diff`);
            await page.$eval('[data-testid=transcript-diff-toggle]', (e) => e.click());
            await page.waitForSelector('[data-testid=transcript] .tr-line [data-w]');
            // the foot, then its languages
            await page.$eval('[data-testid=transcript]', (e) => {
              e.scrollTop = e.scrollHeight;
            });
            await reveal();
            await sleep(200);
            await shot(`transcript-${at}-foot`);
            await page.click('[data-testid=transcript-rerun-language]');
            await page.waitForSelector('.menu [role=menuitem]');
            await sleep(300);
            await shot(`transcript-${at}-languages`);
            await page.keyboard.press('Escape');
            await page.waitForFunction(() => !document.querySelector('.menu'), { polling: 100, timeout: 5000 });
            // words picked
            await page.evaluate(() => {
              const at = (i) => document.querySelector(`[data-testid=transcript] [data-w="${i}"]`).firstChild;
              const r = document.createRange();
              r.setStart(at(6), 0);
              r.setEnd(at(10), at(10).length);
              getSelection().removeAllRanges();
              getSelection().addRange(r);
            });
            await page.waitForSelector('[data-testid=transcript-pick-clear]');
            await sleep(200);
            await shot(`transcript-${at}-picked`);
            await page.$eval('[data-testid=transcript-pick-clear]', (e) => e.click());
            await page.$eval('[data-testid=transcript] .tr-line[data-l="1"] .tr-tc', (e) => e.click());
            await page.waitForSelector('[data-testid=transcript] .tr-line[data-l="1"] [data-testid=line-change]');
            await page.$eval('[data-testid=transcript] .tr-line[data-l="1"] [data-testid=line-change]', (e) => e.click());
            await page.waitForSelector('.composer [data-testid=change-words]');
            await sleep(300);
            await reveal();
            await shot(`transcript-${at}-composer`);
            await page.keyboard.press('Escape');
            await page.keyboard.press('Escape');
            await page.$eval('[data-testid=panel-notes]', (e) => e.click());
            await page.waitForSelector('.note [data-testid=text-edit]');
            await page.$eval('.note [data-testid=text-edit]', (e) => e.scrollIntoView({ block: 'center' }));
            await sleep(300);
            await shot(`transcript-${at}-note`);
            await page.$eval('[data-testid=panel-transcript]', (e) => e.click());
          }
        await page.emulateMediaFeatures([]);
      },
    );

  await check('in German the foot and the pick bar speak German and still fit the narrow panel', async () => {
    await page.setViewport({ width: 1024, height: 768, deviceScaleFactor: SHOTS ? 2 : 1 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.setItem('vr.lang', 'de'));
    await openPlayer();
    assert((await page.evaluate(() => document.documentElement.lang)) === 'de', 'the page is German');
    if ((await page.$eval('[data-testid=panel-transcript]', (e) => e.getAttribute('aria-selected'))) !== 'true')
      await page.click('[data-testid=panel-transcript]');
    await page.waitForSelector('[data-testid=transcript-heard]');
    const said = await page.$eval('[data-testid=transcript-heard]', (e) => e.textContent);
    assert(said === 'Auf Englisch angehört · Whisper', `the foot: ${said}`);
    await page.$eval('[data-testid=transcript] .tr-line[data-l="1"] .tr-tc', (e) => e.click());
    await page.waitForSelector('[data-testid=transcript] .tr-line[data-l="1"][data-here]');
    const idle = await page.$eval('[data-testid=transcript] .tr-line[data-here]', (l) => ({
      play: l.querySelector('[data-testid=line-play]')?.getAttribute('aria-label'),
      change: l.querySelector('[data-testid=line-change]')?.getAttribute('aria-label'),
    }));
    assert(idle.play === 'Diese Zeile abspielen' && idle.change === 'Wortlaut ändern', JSON.stringify(idle));
    const out = await page.$eval('[data-testid=transcript]', (sc) => {
      const box = sc.getBoundingClientRect();
      return [...sc.querySelectorAll('.tr-foot button, .tr-line[data-here] .tr-line-acts button')]
        .filter((b) => b.getBoundingClientRect().right > box.right + 0.5 || b.scrollWidth > b.clientWidth + 1)
        .map((b) => b.textContent.trim() || b.getAttribute('aria-label'));
    });
    assert(!out.length, `cut or outside the panel: ${out}`);
    await page.$eval('[data-testid=transcript]', (e) => {
      e.scrollTop = e.scrollHeight;
    });
    await sleep(200);
    await shot('transcript-dark-1024-de-foot');
    await page.evaluate(() => localStorage.removeItem('vr.lang'));
    await page.emulateMediaFeatures([]);
  });

  await check('no page errors', async () => {
    assert(!errors.length, errors.join('\n'));
  });
} catch (e) {
  crashed(e, srv);
}
await finish(LABEL, { browser, servers: [srv] });
