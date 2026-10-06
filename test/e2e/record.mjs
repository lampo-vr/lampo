#!/usr/bin/env node
// covers: web/src/player/record/ web/src/player/MicButton.tsx web/src/player/VoiceClip.tsx
// covers: web/src/player/WalkieHud.tsx web/src/player/useWalkie.ts web/src/player/SttProgress.tsx
// covers: web/src/styles/record.css server/routes/recordings.ts server/routes/voice.ts lib/recording.ts
// covers: lib/recordings.ts lib/voice.ts lib/stt/
// Browser end-to-end test of recorded feedback: a real server (local mode, temp store, free port) whose speech engine
// is a stand-in OpenAI-compatible server in this process (synthetic words with timings — never real audio of anyone),
// and headless Chrome with a fake microphone (a generated tone). ⇧R starts recording; the test pauses on a frame and
// says something, jumps to another frame and rests the pointer on the picture, then plays across a stretch; Done. The
// drafts come back on the frames the player showed (compared with its own frame readout), the spot where the pointer
// rested, a range for what was said while it played; one is edited; Send all makes ordinary notes with their own clips,
// which `vr show` names; a second take's draft goes on its own through its card's Send. Then "Still wrong" in check
// mode with its reason said into the microphone: the words land in the field, are edited, and reach the agent
// (`vr inbox`); on a small phone the check card holds it all. Screenshots land in VR_SHOTS.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { FFMPEG } from '../../lib/probe.ts';
import { formatRange } from '../../lib/range.ts';
import { timecode } from '../../lib/time.ts';
import { age, freePort, makeVideo, sleep, until } from '../lib/helpers.ts';
import { fitsAt } from './layout.mjs';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'record e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const ROOT = path.resolve(import.meta.dirname, '../..');

// What the stand-in engine "heard": three things said, timed on the recording's clock (the test acts in between).
const words = (list) => list.map(([word, start, end]) => ({ word, start, end }));
const SAID = words([
  ['The', 0.6, 0.8],
  ['logo', 0.8, 1.1],
  ['lands', 1.1, 1.35],
  ['too', 1.35, 1.5],
  ['early.', 1.5, 1.8],
  ['Make', 3.6, 3.8],
  ['this', 3.8, 4.0],
  ['title', 4.0, 4.3],
  ['bigger.', 4.3, 4.8],
  ['This', 6.6, 6.8],
  ['whole', 6.8, 7.1],
  ['stretch', 7.1, 7.5],
  ['is', 7.5, 7.6],
  ['too', 7.6, 7.8],
  ['dark.', 7.8, 8.1],
]);
// the second, short take (1.8 s, paused on one frame)
const SHORT = words([
  ['Warmer', 0.4, 0.8],
  ['colours', 0.8, 1.2],
  ['here.', 1.2, 1.5],
]);
let heard = 0;
const stt = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    if (req.method !== 'POST') return res.writeHead(404).end();
    heard++;
    const said = heard === 1 ? SAID : SHORT;
    res.setHeader('content-type', 'application/json');
    // a moment, like a real engine: the drafts' "hearing" state shows meanwhile
    setTimeout(() => res.end(JSON.stringify({ text: said.map((w) => w.word).join(' '), language: 'english', words: said, segments: [] })), 1500);
  });
});
const sttPort = await freePort();
await new Promise((r) => stt.listen(sttPort, '127.0.0.1', r));
const srv = await startServer({
  prefix: 'vr-record-e2e-',
  user: 'Sam',
  env: { VR_STT: 'http', VR_STT_URL: `http://127.0.0.1:${sttPort}/v1` },
});
const { dir, base: BASE } = srv;
process.on('exit', () => stt.close());

// the fake microphone: twelve seconds of tone (loud enough for the silence gate; the stand-in says the words)
const mic = path.join(dir, 'mic.wav');
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=12', '-ar', '48000', '-ac', '1', '-y', mic]);

const api = jsonApi(BASE);

const FPS = 25;
let browser;
let page;
screenshotFailures(() => page, 'record');
try {
  const file = makeVideo(path.join(dir, 'Spot/export/launch.mp4'), { w: 320, h: 180, fps: FPS, dur: 12, pattern: 'testsrc2' });
  age(file);
  const { video } = await api('/api/library', 'POST', { path: file });
  const slug = video.slug;
  const enc = encodeURIComponent;

  browser = await launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${mic}`],
  });
  const ctx = browser.defaultBrowserContext();
  await ctx.overridePermissions(BASE, ['microphone']);
  page = await browser.newPage();
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
  const shownFrame = () => page.$eval('.tc .sub b', (e) => Number(e.textContent));
  const goto = async (frame) => {
    await page.evaluate((f, s) => window.dispatchEvent(new CustomEvent('vr-goto-frame', { detail: { slug: s, v: 1, frame: f } })), frame, slug);
    await until(async () => (await shownFrame()) === frame, `the player shows F${frame}`);
  };
  const at = async (secs, t0) => {
    const wait = secs * 1000 - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
  };

  console.log(`record e2e against ${BASE} (store ${dir})`);

  const frames = {};
  await check('⇧R records: paused on a frame, a jump and a resting pointer, then playing across a stretch; Done', async () => {
    await page.goto(`${BASE}/#/v/${enc(slug)}`, { waitUntil: 'domcontentloaded' });
    await videoReady();
    await page.waitForSelector('[data-testid=record]:not([disabled])');
    await goto(30);
    frames.a = await shownFrame();
    await page.keyboard.down('Shift');
    await page.keyboard.press('R');
    await page.keyboard.up('Shift');
    await page.waitForSelector('[data-testid=rec-bar]', { timeout: 15000 });
    const t0 = Date.now();
    await shot('record-dark-1440-recording');
    // 0–2.6 s: paused on F30 (the first thing is said at 0.6–1.8)
    await at(2.6, t0);
    await goto(60);
    frames.b = await shownFrame();
    // 2.9 s on: the pointer rests on the left third of the picture while the second thing is said (3.6–4.8)
    const box = await page.$eval('.vbox', (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    await page.mouse.move(box.x + box.w * 0.25, box.y + box.h * 0.5, { steps: 4 });
    await at(5.8, t0);
    // 5.8 s: play across a stretch while the third thing is said (6.6–8.1), pause at 8.6
    await page.keyboard.press('Space');
    await at(8.6, t0);
    await page.keyboard.press('Space');
    await sleep(300);
    frames.c = await shownFrame();
    await page.click('[data-testid=rec-done]');
    await page.waitForSelector('[data-testid=rec-bar]', { hidden: true, timeout: 15000 });
    await page.waitForSelector('[data-testid=drafts][aria-busy=true]', { timeout: 15000 });
    await shot('record-dark-1440-hearing');
  });

  await check('heard into drafts on the frames the player showed, a spot where the pointer rested, a range for the stretch', async () => {
    await page.waitForSelector('[data-testid=drafts][data-state=ready]', { timeout: 60000 });
    assert(heard === 1, `heard once: ${heard}`);
    const drafts = await page.$$eval('[data-testid=draft]', (ds) =>
      ds.map((d) => ({
        frame: Number(d.dataset.frame),
        where: d.querySelector('.draft-where')?.textContent,
        spot: !!d.querySelector('.draft-mark'),
        text: d.querySelector('textarea')?.value,
      })),
    );
    assert(drafts.length === 3, `three drafts: ${JSON.stringify(drafts)}`);
    const [a, b, c] = drafts;
    assert(a.frame === frames.a && a.text === 'The logo lands too early.', `first: ${JSON.stringify(a)} (shown F${frames.a})`);
    assert(!a.where.includes('→'), 'a frame, not a range');
    assert(b.frame === frames.b && b.spot, `second on F${frames.b} with a spot: ${JSON.stringify(b)}`);
    assert(c.where.includes('→'), `third is a range: ${c.where}`);
    assert(c.frame >= frames.b && c.frame < frames.c, `the range starts after F${frames.b} and before F${frames.c}: ${c.frame}`);
    const [rec] = (await api(`/api/review/${enc(slug)}/recordings`)).recordings;
    // what the chips say: the frame the player showed, in the format notes use, and the stretch as a range
    assert(a.where === timecode(frames.a, FPS), `first chip "${a.where}" for F${frames.a} (${timecode(frames.a, FPS)})`);
    assert(b.where === timecode(frames.b, FPS), `second chip "${b.where}" for F${frames.b} (${timecode(frames.b, FPS)})`);
    const stretch = rec.drafts[2].range;
    assert(stretch && c.where === formatRange(stretch, FPS), `third chip "${c.where}" for ${JSON.stringify(stretch)}`);
    assert(stretch.out <= frames.c && stretch.out > stretch.in, `the stretch ends by F${frames.c}: ${JSON.stringify(stretch)}`);
    const spot = rec.drafts[1].spot;
    assert(Math.abs(spot[0] - 0.25) < 0.03 && Math.abs(spot[1] - 0.5) < 0.03, `the spot where the pointer rested: ${spot}`);
    // looking at a draft shows its stretch on the timeline
    await page.hover('[data-testid=draft]:nth-of-type(3)');
    await until(() => page.$('.timeline[data-ghost]'), 'the timeline shows the draft');
    await shot('record-dark-1440-drafts');
    const fit = await fitsAt(page, 'drafts');
    assert(!fit.length, fit.join('\n'));
  });

  let sent = [];
  await check('an edit is kept; Send all makes ordinary notes with their own clips, and vr show names them', async () => {
    const first = '[data-testid=draft]:first-of-type textarea';
    await page.click(first, { count: 3 });
    await page.keyboard.type('The logo lands a beat too early.');
    await page.click('[data-testid=drafts-send]');
    await page.waitForSelector('[data-testid=drafts]', { hidden: true, timeout: 20000 });
    const review = (await api(`/api/review/${enc(slug)}`)).review;
    sent = review.comments.filter((c) => c.source === 'recording');
    assert(sent.length === 3, `three notes: ${sent.length}`);
    const edited = sent.find((c) => c.frame === frames.a);
    assert(edited?.text === 'The logo lands a beat too early.', `edited text: ${edited?.text}`);
    assert(edited.voice?.transcript === 'The logo lands too early.', 'the words as heard stay with it');
    for (const c of sent) assert(c.voice?.file && fs.existsSync(path.join(dir, 'data', slug, c.voice.file)), `${c.id} has its clip`);
    assert(
      sent.some((c) => c.range),
      'the stretch is a range note',
    );
    const out = execFileSync(process.execPath, [path.join(ROOT, 'bin/vr'), 'show', edited.id], { env: srv.env, encoding: 'utf8' });
    assert(/recorded: said while watching · voice clip: .+\.m4a/.test(out), `vr show: ${out}`);
    // each note opens into its card (a row until then), its clip there with its length
    const lengths = [];
    for (const c of sent) {
      await page.waitForFunction(
        (id) => [...document.querySelectorAll('.side-scroll .note .c-id')].some((e) => e.textContent === id),
        { timeout: 10000 },
        c.id,
      );
      await page.evaluate((id) => {
        const n = [...document.querySelectorAll('.side-scroll .note')].find((e) => e.querySelector('.c-id')?.textContent === id);
        if (!n.classList.contains('active')) n.querySelector('.nr')?.click();
      }, c.id);
      const at = `[data-note="${c.id}"].active [data-testid=voice-clip] .voice-time`;
      await page.waitForSelector(at, { timeout: 10000 });
      lengths.push(await page.$eval(at, (x) => x.textContent));
    }
    assert(lengths.length === 3 && lengths.every((x) => /^0:0[1-3]$/.test(x)), `each clip shows its length before it plays: ${JSON.stringify(lengths)}`);
    await shot('record-dark-1440-sent');
  });

  await check('a second take on another frame: its chip says that frame; light theme and a phone fit', async () => {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await goto(100);
    await page.keyboard.down('Shift');
    await page.keyboard.press('R');
    await page.keyboard.up('Shift');
    await page.waitForSelector('[data-testid=rec-bar]', { timeout: 15000 });
    await sleep(1800);
    await shot('record-light-1440-recording');
    await page.click('[data-testid=rec-done]');
    await page.waitForSelector('[data-testid=drafts][data-state=ready]', { timeout: 60000 });
    const chips = await page.$$eval('[data-testid=draft] .draft-where', (cs) => cs.map((c) => c.textContent));
    assert(JSON.stringify(chips) === JSON.stringify([timecode(100, FPS)]), `one draft on F100: ${JSON.stringify(chips)}`);
    const text = await page.$eval('[data-testid=draft] textarea', (t) => t.value);
    assert(text === 'Warmer colours here.', `what was said: ${text}`);
    await shot('record-light-1440-drafts');
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: SHOTS ? 3 : 1, isMobile: true, hasTouch: true });
    await sleep(600);
    await shot('record-light-390-drafts');
  });

  await check('a recording’s draft has its own Send: just that one becomes a note (its clip with it), and the recording goes', async () => {
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 });
    await page.waitForSelector('[data-testid=drafts][data-state=ready] [data-testid=draft] [data-testid=draft-send]', { timeout: 20000 });
    const before = (await api(`/api/review/${enc(slug)}`)).review.comments.length;
    await page.click('[data-testid=draft] [data-testid=draft-send]');
    await page.waitForSelector('[data-testid=drafts]', { hidden: true, timeout: 20000 });
    const comments = (await api(`/api/review/${enc(slug)}`)).review.comments;
    assert(comments.length === before + 1, `one more note: ${before} → ${comments.length}`);
    const note = comments.at(-1);
    assert(note.text === 'Warmer colours here.' && note.source === 'recording' && note.voice?.file, `the said note: ${JSON.stringify(note)}`);
    assert((await api(`/api/review/${enc(slug)}/recordings`)).recordings.length === 0, 'the recording, sent whole, is gone');
  });

  await check('"Still wrong" with its reason said: the words land in the field, an edit is kept, and the agent reads them', async () => {
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1, isMobile: false, hasTouch: false });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    const fix = await api(`/api/review/${enc(slug)}/comments`, 'POST', { v: 1, frame: 50, text: 'The title is too small', severity: 'should' });
    await api(`/api/comments/${fix.id}`, 'PATCH', { status: 'fixed', note: 'Title at 120 pt now', by: 'agent:launch-edit' });
    // a fresh load: a hash change alone keeps the player as it was
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${enc(slug)}?verify=${fix.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.verify .c-text', { timeout: 20000 });
    await page.keyboard.press('n');
    await page.waitForSelector('[data-testid=verify-reason] input');
    const asked = heard;
    await page.click('[data-testid=verify-reason] [data-testid=voice]');
    await page.waitForSelector('[data-testid=verify-reason] [data-testid=voice][aria-pressed=true]');
    await sleep(1500);
    await shot('still-wrong-dark-1440-recording');
    // Y while the reason is being said (the microphone has the focus) checks nothing
    await page.keyboard.press('y');
    await page.click('[data-testid=verify-reason] [data-testid=voice]');
    // the words as heard, in the field to edit; Reopen waits for them
    await page.waitForFunction(() => document.querySelector('[data-testid=verify-reason] input')?.value === 'Warmer colours here.', { timeout: 20000 });
    assert(heard === asked + 1, `the speech engine heard the clip once: ${heard - asked}`);
    await shot('still-wrong-dark-1440-said');
    await page.focus('[data-testid=verify-reason] input');
    await page.keyboard.press('End');
    await page.keyboard.type(' And bigger.');
    await page.keyboard.press('Enter');
    await until(async () => (await api(`/api/review/${enc(slug)}`)).review.comments.find((c) => c.id === fix.id)?.status === 'open', 'reopened');
    const note = (await api(`/api/review/${enc(slug)}`)).review.comments.find((c) => c.id === fix.id);
    const reason = note.replies.at(-1);
    assert(reason.text === 'Warmer colours here. And bigger.', `the reason as sent: ${JSON.stringify(reason)}`);
    // what the agent reads: the reopened note with the words
    const inbox = execFileSync(process.execPath, [path.join(ROOT, 'bin/vr'), 'inbox'], { env: srv.env, encoding: 'utf8' });
    assert(inbox.includes('Warmer colours here. And bigger.'), `vr inbox: ${inbox}`);
    // on a small phone the field, its microphone and Reopen fit the check card
    const next = await api(`/api/review/${enc(slug)}/comments`, 'POST', { v: 1, frame: 80, text: 'Too dark here', severity: 'should' });
    await api(`/api/comments/${next.id}`, 'PATCH', { status: 'fixed', note: 'Brighter now', by: 'agent:launch-edit' });
    await page.setViewport({ width: 360, height: 780, deviceScaleFactor: SHOTS ? 3 : 1, isMobile: true, hasTouch: true });
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${enc(slug)}?verify=${next.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.verify .c-text', { timeout: 20000 });
    await page.keyboard.press('n');
    await page.waitForSelector('[data-testid=verify-reason] [data-testid=voice]');
    const inside = await page.$eval('.verify', (v) => {
      const right = Math.min(v.getBoundingClientRect().right, window.innerWidth);
      return [...v.querySelectorAll('button, input')]
        .filter((e) => e.getBoundingClientRect().right > right + 0.5)
        .map((e) => `${e.className} "${e.textContent || e.getAttribute('aria-label')}" ${Math.round(e.getBoundingClientRect().right)} > ${Math.round(right)}`);
    });
    assert(!inside.length, `everything on the check card stays inside it: ${inside.join('; ')}`);
    const fit = await fitsAt(page, 'still wrong on a phone');
    assert(!fit.length, fit.join('\n'));
    await shot('still-wrong-dark-360');
  });

  await check('no page errors', async () => {
    assert(!errors.length, errors.join('\n'));
  });
} catch (e) {
  crashed(e, srv);
}
await finish(LABEL, { browser, servers: [srv] });
