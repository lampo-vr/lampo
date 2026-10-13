#!/usr/bin/env node
// covers: web/src/player/NotesPanel.tsx web/src/player/noteRows.ts web/src/player/noteGroups.ts web/src/player/AutoCheck.tsx
// covers: web/src/player/findingWords.ts web/src/player/hashtags.ts web/src/styles/notes.css
// covers: web/src/styles/autocheck.css server/routes/analysis.ts lib/qa.ts lib/findings.ts lib/text/
// Browser suite of the notes panel with many notes (local mode, temp store, headless Chrome): 30 notes are 30 rows —
// timecode, the severity's keyframe glyph and the first line with nothing after it, no pill and no coloured outline —
// in the groups of where each stands (all open here: one "Open" header), each naming its author on a second line under
// the words since two people wrote them, no avatar and no tooltip; that second line says who · V1 · 2 replies and, at
// its end, where it stands as a label (the labels one column), and hovering a row shows Reply and ⋯ inside the end of
// its first line on its flat fill (no ground or shadow of their own, clear of the label), the words fading out under
// them, as the keyboard's focus does; the
// selected note (a click, ↑ / ↓) opens in place into its card while every other stays a row; the filter menu holds the
// lists and the notes' tags with their counts, a tag picked narrows the list and shows as a chip that takes it off, the
// done ones fold into "Done" at the end; while playing the note at the playhead is marked and the list follows it, until
// the person scrolls it. Auto-check is one chip in the head once it found something — minor findings only, problems,
// and while a Run again it started runs — whose popover lists the problems first, folds the minor ones, runs again,
// turns a finding into a note or puts it away, and names the spelling language only when it was checked in it. A phone
// has the same rows at a finger's height and the chip on the line under its head; it shows what needs you and what is
// open, the fixes to check and the done ones behind a selector at the start of that line (its door to checking stays
// on the line), and a note picked from the list, a link or going through the notes comes to the sheet's top, whole.
import fs from 'node:fs';
import path from 'node:path';
import { tagCounts } from '../../web/src/player/noteRows.ts';
import { age, makeVideo, sleep, until } from '../lib/helpers.ts';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';
import { writeJsonAtomic } from './lib/sharedJson.ts';

const LABEL = 'notes e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-notes-e2e-', user: 'Sam' });
const { dir, base: BASE } = srv;
const api = jsonApi(BASE);
const enc = encodeURIComponent;
const FPS = 25;

let browser;
let page;
try {
  // 12 s at 25 fps, 30 notes 0.4 s apart: Sam's first sitting (10), Mia (5), Sam again two hours later (15)
  const file = makeVideo(path.join(dir, 'Acme/export/spot.mp4'), { w: 320, h: 180, fps: FPS, dur: 12, pattern: 'testsrc2' });
  age(file);
  const { video } = await api('/api/library', 'POST', { path: file, folder: 'Acme' });
  const slug = video.slug;
  const WORDS = [
    ['Whoosh too loud on the logo', ['sfx']],
    ['Hold the hero shot longer\nIt needs a moment before the claim', ['story']],
    ['Text eases in too fast', ['motion']],
    ['Door slam sfx is too sharp', ['sfx']],
    ['Swap this shot for the wider take', ['story']],
    ['Typo in the lower third', []],
  ];
  const made = [];
  for (let i = 0; i < 30; i++) {
    const [text, tags] = WORDS[i % WORDS.length];
    const r = await api(`/api/review/${enc(slug)}/comments`, 'POST', {
      v: 1,
      frame: 5 + i * 10,
      text: `${text} (${i + 1})`,
      tags,
      severity: i % 4 ? 'should' : 'must',
    });
    made.push(r.comment ?? r);
  }
  // who wrote what, and when: no API backdates a note, so the store says it (a running server reads a changed file)
  const reviewFile = path.join(dir, 'data', slug, 'review.json');
  const stored = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
  const now = Date.now();
  stored.comments.forEach((c, i) => {
    const block = i < 10 ? 0 : i < 15 ? 1 : 2;
    c.created = new Date(now - [3 * 3600e3, 2.5 * 3600e3, 30 * 60e3][block] + i * 60e3).toISOString();
    if (block === 1) {
      c.author = 'Mia Lang';
      delete c.author_id;
    }
  });
  writeJsonAtomic(reviewFile, stored);
  const review = async () => (await api(`/api/review/${enc(slug)}`)).review;
  await until(async () => (await review()).comments.some((c) => c.author === 'Mia Lang'), 'the store is read again');

  // teaser.mp4: V1 and V2, notes with more to say — Mia's on V1, fixed in V2 (to check); Sam's on V2 with two replies;
  // Sam's on V2 with nothing more to say than who wrote it; the agent's question
  const tfile = makeVideo(path.join(dir, 'Acme/export/teaser.mp4'), { w: 320, h: 180, fps: FPS, dur: 4, pattern: 'testsrc2' });
  age(tfile);
  const teaser = (await api('/api/library', 'POST', { path: tfile, folder: 'Acme' })).video.slug;
  const tnote = (v, frame, text) => api(`/api/review/${enc(teaser)}/comments`, 'POST', { v, frame, text, severity: 'should' });
  const carried = await tnote(1, 10, 'The title card needs more air above the logo, it feels cramped against the top edge');
  makeVideo(tfile, { w: 320, h: 180, fps: FPS, dur: 4, pattern: 'smptebars' });
  age(tfile);
  await api(`/api/review/${enc(teaser)}/sync`, 'POST', {});
  await api(`/api/comments/${carried.id}`, 'PATCH', { status: 'fixed', fixed_in_v: 2, note: 'More air above the logo', by: 'agent:promo-edit' });
  const talked = await tnote(2, 40, 'Music too loud under the voice-over');
  await api(`/api/comments/${talked.id}`, 'PATCH', { note: 'Duck it by 3 dB' });
  await api(`/api/comments/${talked.id}`, 'PATCH', { note: 'Or 4' });
  const plain = await tnote(2, 70, 'Logo a touch smaller');
  const asked = await api(`/api/review/${enc(teaser)}/comments`, 'POST', {
    v: 2,
    frame: 90,
    kind: 'question',
    text: 'Website or app badge on the end card?',
    by: 'agent:promo-edit',
  });
  const settled = await tnote(2, 100, 'Typo in the end card');
  await api(`/api/comments/${settled.id}`, 'PATCH', { status: 'verified' });
  const teaserFile = path.join(dir, 'data', teaser, 'review.json');
  const tstored = JSON.parse(fs.readFileSync(teaserFile, 'utf8'));
  const mias = tstored.comments.find((c) => c.id === carried.id);
  mias.author = 'Mia Lang';
  delete mias.author_id;
  writeJsonAtomic(teaserFile, tstored);
  await until(async () => (await api(`/api/review/${enc(teaser)}`)).review.comments.some((c) => c.author === 'Mia Lang'), 'the teaser’s store is read again');

  // picks.mp4: an agent's questions that offer answers to pick (one for the desk's keys, one for a click, one for the
  // phone), and an open note
  const pfile = makeVideo(path.join(dir, 'Acme/export/picks.mp4'), { w: 320, h: 180, fps: FPS, dur: 4, pattern: 'testsrc2' });
  age(pfile);
  const picks = (await api('/api/library', 'POST', { path: pfile, folder: 'Acme' })).video.slug;
  const ask = (frame, text, choices) =>
    api(`/api/review/${enc(picks)}/comments`, 'POST', { v: 1, frame, kind: 'question', text, choices, by: 'agent:claude-ai' });
  const byClick = await ask(20, 'End card: the website or the app badge?', ['The website', 'The app badge']);
  const byKey = await ask(40, 'Music under the title: keep it, cut it or lower it?', ['Keep it', 'Cut it', 'Lower it']);
  const onPhone = await ask(60, 'Hold the last shot a beat longer?', ['Yes, a beat longer', 'No, as it is']);
  await api(`/api/review/${enc(picks)}/comments`, 'POST', { v: 1, frame: 80, text: 'Logo a touch smaller', severity: 'should' });
  const pickNote = async (id) => (await api(`/api/review/${enc(picks)}`)).review.comments.find((c) => c.id === id);
  // opts.mp4: the agent's question with options to audition, and an open note
  const ofile = makeVideo(path.join(dir, 'Acme/export/opts.mp4'), { w: 320, h: 180, fps: FPS, dur: 4, pattern: 'smptebars' });
  age(ofile);
  const opts = (await api('/api/library', 'POST', { path: ofile, folder: 'Acme' })).video.slug;
  await api('/api/asks', 'POST', {
    video: opts,
    text: 'Which voice and which closing line?',
    options: [
      {
        id: 'voice',
        label: 'Voice',
        items: [
          { id: 'v1', label: 'Warm' },
          { id: 'v2', label: 'Bright' },
        ],
      },
      {
        id: 'close',
        label: 'Closing line',
        items: [
          { id: 'c1', label: 'See you there' },
          { id: 'c2', label: 'Made for the weekend' },
        ],
      },
    ],
    by: 'agent:claude-ai',
  });
  await api(`/api/review/${enc(opts)}/comments`, 'POST', { v: 1, frame: 30, text: 'Logo a touch later', severity: 'should' });

  browser = await launch();
  page = await browser.newPage();
  screenshotFailures(() => page, 'notes');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `notes-${name}.png`) });
  const openPlayer = async ({ width = 1440, height = 900 } = {}) => {
    await page.setViewport({ width, height });
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${enc(slug)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.side-scroll .note-row:not(.pending)');
    await page.waitForFunction(() => document.querySelector('.vbox video')?.readyState >= 2, { timeout: 20000 });
  };
  const rows = () =>
    page.$$eval('.side-scroll .note', (els) =>
      els.map((e) => ({ id: e.dataset.note, row: e.classList.contains('note-row'), open: e.classList.contains('active') })),
    );
  const tcShown = () => page.$eval('.transport .tc .main', (e) => e.textContent.trim());

  await check('30 notes are 30 rows: timecode, the severity’s glyph and the first line with nothing after it; no pill, no outline', async () => {
    await openPlayer();
    const all = await rows();
    assert(all.length === 30 && all.every((r) => r.row && !r.open), `30 rows, none open: ${JSON.stringify(all.slice(0, 3))}…`);
    const look = await page.$$eval('.side-scroll .note-row', (els) =>
      els.map((e) => {
        const nr = e.querySelector('.nr');
        const s = getComputedStyle(nr);
        const words = e.querySelector('.nr-text');
        const w = words.getBoundingClientRect();
        // what else stands on the words' line, after them (the row's content ends at its padding)
        const after = [...nr.children].filter((c) => {
          if (c === words || !c.getClientRects().length) return false;
          const r = c.getBoundingClientRect();
          return r.left >= w.left && r.top < w.bottom - 1 && r.bottom > w.top + 1;
        });
        return {
          h: nr.getBoundingClientRect().height,
          tc: e.querySelector('.nr-tc')?.textContent,
          glyph: !!e.querySelector('.nr-kg .kg'),
          text: words.textContent,
          oneLine: words.scrollHeight <= words.clientHeight + 1,
          toEnd: Math.abs(w.right - (nr.getBoundingClientRect().right - parseFloat(s.paddingRight))) <= 1,
          after: after.map((c) => c.className),
          pills: e.querySelectorAll('.badge, .sbadge, .avatar').length,
          border: parseFloat(s.borderTopWidth) + parseFloat(getComputedStyle(e).borderTopWidth),
        };
      }),
    );
    const odd = look.filter(
      (l) => l.h < 28 || l.h > 60 || !l.glyph || !l.oneLine || !l.toEnd || l.after.length || l.pills || l.border || !/^\d\d:\d\d:\d\d$/.test(l.tc),
    );
    assert(!odd.length, `rows: ${JSON.stringify(odd.slice(0, 3))}`);
    assert(look[1].text === 'Hold the hero shot longer', `the first line only: ${look[1].text}`);
    // the timecodes stand in one column: the words start together
    const lefts = await page.$$eval('.side-scroll .note-row .nr-text', (els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().left)))]);
    assert(lefts.length === 1, `the words start at one x: ${lefts}`);
    await shot('rows-1440');
  });

  await check('grouped where each note stands: one Open header over the 30; two people wrote them, so each row names its author under its words', async () => {
    const heads = await page.$$eval('.side-scroll .note-sect', (els) => els.map((e) => [e.dataset.group, e.querySelector('.n')?.textContent]));
    assert(JSON.stringify(heads) === JSON.stringify([['open', '30']]), `one group, its count: ${JSON.stringify(heads)}`);
    // the header goes with its group's first note (the windowed list measures one element a note)
    const first = await page.$eval('.side-scroll .note-sect-wrap', (e) => ({
      head: !!e.querySelector(':scope > .note-sect'),
      note: e.querySelector('.note')?.dataset.note,
    }));
    assert(first.head && first.note === made[0].id, `the header with its first note: ${JSON.stringify(first)}`);
    const who = await page.$$eval('.side-scroll .note-row', (els) =>
      els.map((e) => ({
        sub: e.querySelector('.nr-sub')?.textContent ?? null,
        // the second line starts where the words do
        under:
          Math.round(e.querySelector('.nr-sub')?.getBoundingClientRect().left ?? -1) === Math.round(e.querySelector('.nr-text').getBoundingClientRect().left),
        avatar: !!e.querySelector('.avatar'),
        titles: [...e.querySelectorAll('[title]')].length + (e.hasAttribute('title') ? 1 : 0),
      })),
    );
    assert(
      who.every((w) => w.under && !w.avatar && !w.titles),
      `each row's second line under its words, no avatar, no tooltip: ${JSON.stringify(who.filter((w) => !w.under || w.avatar || w.titles).slice(0, 2))}`,
    );
    assert(who[0].sub === 'Sam' && who[10].sub === 'Mia Lang', `who wrote it, in words: ${who[0].sub} · ${who[10].sub}`);
  });

  await check(
    'a row says the rest under its words — who · V1 · replies, then where it stands as a label —; hovered, Reply and ⋯ come inside its end, flat',
    async () => {
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto('about:blank');
      await page.goto(`${BASE}/#/v/${enc(teaser)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(`.side-scroll [data-note="${plain.id}"].note-row`);
      await page.evaluate(() => document.activeElement?.blur());
      await page.mouse.move(5, 5);
      const about = (id) => page.$eval(`.side-scroll [data-note="${id}"] .nr-about`, (e) => e.textContent).catch(() => null);
      const label = (id) => page.$eval(`.side-scroll [data-note="${id}"] [data-testid=note-state]`, (e) => e.textContent.trim()).catch(() => null);
      // Mia's note, written on V1 and fixed in V2 (on screen); Sam's with two replies; Sam's with only who wrote it; the
      // agent's question (an agent is named by its kind's name where it gave none of the client ids)
      await until(
        async () => (await about(carried.id)) === 'Mia Lang · V1',
        async () => `Mia's row: ${await about(carried.id)}`,
      );
      const said = {
        carried: [await about(carried.id), await label(carried.id)],
        talked: [await about(talked.id), await label(talked.id)],
        plain: [await about(plain.id), await label(plain.id)],
        asked: [await about(asked.id), await label(asked.id)],
      };
      assert(
        JSON.stringify(said) ===
          JSON.stringify({
            carried: ['Mia Lang · V1', 'Fixed in V2'],
            talked: ['Sam · 2 replies', null],
            plain: ['Sam', null],
            asked: ['promo-edit', 'Question'],
          }),
        `who · version · replies on the left, where it stands as a label: ${JSON.stringify(said)}`,
      );
      // the labels: the system's Badge (its glyph, no green surface) at the end of the second line, one column down the list
      const labels = await page.$$eval('.side-scroll [data-testid=note-state]', (els) =>
        els.map((e) => {
          const nr = e.closest('.nr');
          const end = nr.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(nr).paddingRight);
          const r = e.getBoundingClientRect();
          return {
            badge: e.classList.contains('sbadge') && !!e.querySelector(':scope > .kg'),
            right: Math.round(r.right),
            atEnd: Math.abs(r.right - end) <= 1,
            line2: r.top >= nr.querySelector('.nr-text').getBoundingClientRect().bottom,
          };
        }),
      );
      assert(
        labels.length === 2 && labels.every((l) => l.badge && l.atEnd && l.line2) && labels[0].right === labels[1].right,
        `labels at line 2's end, in one column: ${JSON.stringify(labels)}`,
      );

      /** The row of `id` as it is now: its box, its words, its actions and what floats over it. */
      const measure = (id) =>
        page.$eval(`.side-scroll [data-note="${id}"]`, (note) => {
          const line = note.querySelector('.nr-line');
          const nr = note.querySelector('.nr');
          const words = note.querySelector('.nr-text');
          const box = nr.getBoundingClientRect();
          const w = words.getBoundingClientRect();
          const acts = note.querySelector('.nr-acts');
          const tag = note.querySelector('[data-testid=note-state]')?.getBoundingClientRect();
          const buttons = [...acts.querySelectorAll('button')].map((b) => {
            const r = b.getBoundingClientRect();
            const icon = b.querySelector('svg')?.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return {
              // its icon clear of the label, its box at most a hairline over it
              clear: !tag || (!!icon && (icon.bottom <= tag.top || icon.left >= tag.right || icon.right <= tag.left) && r.bottom - tag.top <= 1),
              label: b.getAttribute('aria-label'),
              inside: r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5,
              onLine1: Math.abs(r.top + r.height / 2 - (w.top + w.height / 2)) <= 1.5,
              reachable: !!hit && b.contains(hit),
            };
          });
          // anything with a shadow over the row's box: its own parts, or something floating over it
          const shadows = [...document.querySelectorAll('body *')]
            .filter((e) => (e === nr || !e.contains(nr)) && !e.closest('.nr-state') && getComputedStyle(e).boxShadow !== 'none')
            .filter((e) => {
              const r = e.getBoundingClientRect();
              return r.width && r.height && r.left < box.right - 1 && r.right > box.left + 1 && r.top < box.bottom - 1 && r.bottom > box.top + 1;
            })
            .map((e) => e.className || e.tagName);
          return {
            shown: getComputedStyle(acts).opacity === '1',
            // the actions lie on the row's own fill: no ground of their own
            ground: `${getComputedStyle(acts).backgroundColor} ${getComputedStyle(acts).backgroundImage}`,
            fill: getComputedStyle(nr).backgroundColor,
            fade: getComputedStyle(words).maskImage,
            buttons,
            shadows,
            titles: [line, nr, note].filter((e) => e.hasAttribute('title')).length,
          };
        });
      const rest = await measure(carried.id);
      assert(
        !rest.shown && rest.fade === 'none' && rest.fill === 'rgba(0, 0, 0, 0)' && !rest.titles,
        `at rest: words alone, no actions, no tooltip: ${JSON.stringify(rest)}`,
      );
      await shot('teaser-rows');
      // the pointer on the row's words: the flat fill, Reply and ⋯ inside its end on line 1, the words fading under them
      const words = await (await page.$(`.side-scroll [data-note="${carried.id}"] .nr-text`)).boundingBox();
      await page.mouse.move(words.x + 40, words.y + words.height / 2);
      await until(async () => (await measure(carried.id)).shown, 'the actions show on hover');
      const hovered = await measure(carried.id);
      assert(
        hovered.buttons.length === 2 && hovered.buttons.every((b) => b.inside && b.onLine1 && b.reachable && b.clear),
        `Reply and ⋯ inside the row's box, on its first line, clear of its label: ${JSON.stringify(hovered.buttons)}`,
      );
      assert(
        !hovered.shadows.length && hovered.ground === 'rgba(0, 0, 0, 0) none',
        `no ground, no shadow over the row: ${hovered.ground} ${hovered.shadows.join(', ')}`,
      );
      assert(hovered.fill !== 'rgba(0, 0, 0, 0)' && hovered.fade !== 'none', `the row's flat fill, the words fading out: ${JSON.stringify(hovered)}`);
      await shot('teaser-hover');
      // on Reply itself the row keeps its fill and its actions
      const reply = await (await page.$(`.side-scroll [data-note="${carried.id}"] .nr-acts button`)).boundingBox();
      await page.mouse.move(reply.x + reply.width / 2, reply.y + reply.height / 2);
      await sleep(150);
      const onReply = await measure(carried.id);
      assert(onReply.shown && onReply.fill === hovered.fill, `on Reply the row stays lit: ${JSON.stringify(onReply)}`);
      // the keyboard's focus shows them too
      await page.mouse.move(5, 5);
      await until(async () => !(await measure(carried.id)).shown, 'the actions go with the pointer');
      await page.$eval(`.side-scroll [data-note="${carried.id}"] .nr`, (b) => b.focus());
      await until(async () => (await measure(carried.id)).shown, 'the actions show on focus');
      await page.evaluate(() => document.activeElement?.blur());
      await openPlayer();
    },
  );

  await check('the selected note opens in place into its card, every other stays a row; ↑ ↓ move it, Esc closes it', async () => {
    const id = made[9].id;
    const row = await page.$(`.side-scroll [data-note="${id}"]`);
    await (await row.$('.nr')).click();
    await page.waitForSelector(`.side-scroll [data-note="${id}"].comment.active`);
    const all = await rows();
    assert(all.filter((r) => r.open).length === 1 && all.filter((r) => r.row).length === 29, `one open, 29 rows: ${JSON.stringify(all.filter((r) => r.open))}`);
    const card = await page.$eval(`[data-note="${id}"]`, (e) => ({
      same: true,
      head: !!e.querySelector('.note-head'),
      text: e.querySelector('.c-text')?.textContent,
      reply: !!e.querySelector('.reply-stub'),
      actions: !!e.querySelector('button[aria-label^="Actions"]'),
    }));
    assert(card.head && card.reply && card.actions && card.text === 'Door slam sfx is too sharp (10)', `the card: ${JSON.stringify(card)}`);
    assert(await row.evaluate((e) => e.isConnected && e.classList.contains('active')), 'the same element opened (what held the row holds the card)');
    assert((await tcShown()) === (await review()).comments.find((c) => c.id === id).timecode, 'the playhead is on its frame');
    // ↓: the next note opens, this one is a row again, the playhead follows
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('ArrowDown');
    await page.waitForSelector(`.side-scroll [data-note="${made[10].id}"].active`);
    assert(await page.$(`.side-scroll [data-note="${id}"].note-row`), 'the one before is a row again');
    await until(async () => (await tcShown()) === made[10].timecode, 'the playhead on the next note');
    await page.keyboard.press('ArrowUp');
    await page.waitForSelector(`.side-scroll [data-note="${id}"].active`);
    await shot('selected-1440');
    await page.keyboard.press('Escape');
    await until(async () => !(await rows()).some((r) => r.open), 'Esc closes it');
  });

  await check('the playhead stopping on a note opens it; stepping off and back again too', async () => {
    const target = made[20];
    const frameShown = () => page.$eval('.tc .sub b', (e) => Number(e.textContent));
    await page.evaluate(
      (h) => {
        location.hash = h;
      },
      `#/v/${enc(slug)}?f=${target.frame - 1}`,
    );
    await until(async () => (await frameShown()) === target.frame - 1, 'the frame before the note');
    assert(!(await rows()).some((r) => r.open), 'nothing open off a note');
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('ArrowRight');
    await page.waitForSelector(`.side-scroll [data-note="${target.id}"].active`);
  });

  /** The raised buttons in view: one door per view. */
  const raisedNow = () =>
    page.$$eval('.btn.primary', (bs) =>
      bs.filter((b) => b.getClientRects().length && getComputedStyle(b).visibility !== 'hidden').map((b) => b.textContent.trim()),
    );

  await check(
    'an agent’s question with answers to pick stands open in Needs you — who asks, the question, the picks —; a click or its number answers, and it folds',
    async () => {
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto('about:blank');
      await page.goto(`${BASE}/#/v/${enc(picks)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(`.side-scroll [data-testid=ask-card][data-note="${byClick.id}"] [data-testid=ask-pick]`, { timeout: 20000 });
      await page.evaluate(() => document.activeElement?.blur());
      const card = await page.$eval(`.side-scroll [data-testid=ask-card][data-note="${byClick.id}"]`, (e) => {
        const q = e.querySelector('.ask-q');
        const group = e.querySelector('[data-testid=choices]');
        return {
          who: e.querySelector('.ask-who')?.textContent,
          q: q?.textContent,
          size: getComputedStyle(q).fontSize,
          picks: [...e.querySelectorAll('[data-testid=ask-pick] .ask-pick-words')].map((b) => b.textContent),
          // screen readers hear the picks as one group named by the question
          named: group?.getAttribute('aria-labelledby') === q?.id,
          raisedInside: e.querySelectorAll('.btn.primary').length,
          row: !!document.querySelector(`.note-row[data-note="${e.dataset.note}"]`),
        };
      });
      assert(
        card.who === 'Claude asks' &&
          card.q === 'End card: the website or the app badge?' &&
          card.size === '15px' &&
          JSON.stringify(card.picks) === JSON.stringify(['The website', 'The app badge']) &&
          card.named &&
          !card.raisedInside &&
          !card.row,
        `the question open, its picks there: ${JSON.stringify(card)}`,
      );
      const heads = await page.$$eval('.side-scroll .note-sect', (els) => els.map((e) => e.dataset.group));
      assert(heads[0] === 'needs', `Needs you first: ${heads}`);
      // the card is the view's one door, nothing in it orange: + Note steps down while it waits (an agent at work or not)
      const raised = await raisedNow();
      assert(!raised.length && (await page.$('[data-testid=new-note]:not(.primary)')), `nothing raised beside the card: ${JSON.stringify(raised)}`);
      await shot('picks');
      // the keys: Tab reaches the picks, 3 answers with the third while the card has the focus
      await page.$eval(`[data-testid=ask-card][data-note="${byKey.id}"] [data-testid=ask-pick]`, (b) => b.focus());
      await page.keyboard.press('3');
      await until(async () => (await pickNote(byKey.id)).status === 'verified', 'the third answer sent by its key');
      assert((await pickNote(byKey.id)).replies.at(-1)?.text === 'Lower it', `the answer: ${JSON.stringify((await pickNote(byKey.id)).replies.at(-1))}`);
      // a click: the answer as typing it would send, and the card folds
      await page.$$eval(`[data-testid=ask-card][data-note="${byClick.id}"] [data-testid=ask-pick]`, (bs) =>
        bs.find((b) => b.textContent.includes('The app badge'))?.click(),
      );
      await until(async () => (await pickNote(byClick.id)).status === 'verified', 'the clicked answer sent');
      assert((await pickNote(byClick.id)).replies.at(-1)?.text === 'The app badge', 'the picked words are the answer');
      await page.waitForFunction((id) => !document.querySelector(`[data-testid=ask-card][data-note="${id}"]`), { timeout: 10000 }, byClick.id);
      // answered, a row again: in Done, saying so
      await page.click('[data-testid=group-done]');
      await page.waitForSelector(`.side-scroll .note-row[data-note="${byClick.id}"] [data-testid=note-state]`);
      const label = await page.$eval(`.side-scroll .note-row[data-note="${byClick.id}"] [data-testid=note-state]`, (e) => e.textContent.trim());
      assert(label === 'Answered', `the row says it was answered: ${label}`);
      await shot('picks-answered');
    },
  );

  await check(
    'a question with options to audition stands open the same way: the groups and the way into the audition; the card is the door, + Note steps down',
    async () => {
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto('about:blank');
      await page.goto(`${BASE}/#/v/${enc(opts)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.side-scroll [data-testid=ask-card] [data-testid=options-ask] [data-testid=options-open]', { timeout: 20000 });
      await page.evaluate(() => document.activeElement?.blur());
      const card = await page.$eval('.side-scroll [data-testid=ask-card]', (e) => ({
        who: e.querySelector('.ask-who')?.textContent,
        groups: [...e.querySelectorAll('.opt-group-chip')].map((g) => g.textContent.replace(/\s+/g, ' ').trim()),
        raisedInside: e.querySelectorAll('.btn.primary').length,
      }));
      assert(card.who === 'Claude asks' && card.groups.length === 2 && !card.raisedInside, `the options open on the card: ${JSON.stringify(card)}`);
      const raised = await raisedNow();
      assert(!raised.length && (await page.$('[data-testid=new-note]:not(.primary)')), `nothing raised beside the card: ${JSON.stringify(raised)}`);
      await shot('picks-options');
    },
  );

  // the filter menu's items, as they read
  const filterMenu = async () => {
    // a menu still closing is in the page for a few ms: the filter opens once it has gone
    await page.waitForFunction(() => !document.querySelector('.menu'), { timeout: 5000 });
    await page.click('[data-testid=notes-filter]');
    await page.waitForSelector('.menu[data-state=open] [role=menuitemcheckbox]');
    return page.$$eval('.menu[data-state=open] [role=menuitemcheckbox]', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  };
  const pick = async (label) => {
    await filterMenu();
    await page.evaluate(
      (l) =>
        [...document.querySelectorAll('.menu[data-state=open] [role=menuitemcheckbox]')].find((e) => e.textContent.replace(/\s+/g, ' ').trim() === l)?.click(),
      label,
    );
    await page.waitForFunction(() => !document.querySelector('.menu[data-state=open]'), { timeout: 5000 });
  };

  await check('the filter menu: the lists and the notes’ tags with their counts; a tag picked narrows the list and is a chip that takes it off', async () => {
    await openPlayer();
    const want = tagCounts((await review()).comments).map(([tag, n]) => `${tag} · ${n}`);
    const items = await filterMenu();
    // (Mia's five are hers: Sam's are 25)
    assert(items.includes('Mine · 25') && items.includes('All · 30') && !items.some((x) => x.startsWith('Questions')), `the lists: ${JSON.stringify(items)}`);
    assert(JSON.stringify(items.slice(-want.length)) === JSON.stringify(want), `the tags ${JSON.stringify(items)}, want ${JSON.stringify(want)}`);
    assert(want[0] === 'sfx · 10' && want.includes('story · 10') && want.includes('motion · 5'), `counts: ${want}`);
    await page.keyboard.press('Escape');
    assert(!(await page.$('[data-testid=notes-filters-on]')), 'no filter on: no chip line');
    await pick('motion · 5');
    await until(async () => (await rows()).length === 5, 'five motion notes');
    await page.waitForSelector('[data-testid=notes-filters-on] .np-chip[data-tag="motion"]');
    assert(await page.$eval('[data-testid=notes-filter]', (b) => b.classList.contains('on')), 'the filter button says a filter is on');
    const texts = await page.$$eval('.side-scroll .note-row .nr-text', (els) => els.map((e) => e.textContent));
    assert(
      texts.every((x) => x.startsWith('Text eases in too fast')),
      `only motion: ${texts}`,
    );
    await shot('tag-motion');
    // two motion notes done: three stay open, the two fold into Done at the end; All shows all five
    for (const c of made.filter((_, i) => i % WORDS.length === 2).slice(0, 2)) await api(`/api/comments/${c.id}`, 'PATCH', { status: 'verified' });
    await until(async () => (await rows()).length === 3, 'three motion notes still open');
    const done = () =>
      page.$eval('[data-testid=group-done]', (e) => `${e.querySelector('.note-sect-name')?.textContent} ${e.querySelector('.n')?.textContent}`).catch(() => '');
    await until(
      async () => (await done()) === 'Done 2',
      async () => `Done 2, folded: ${await done()}`,
    );
    await page.click('[data-testid=group-done]');
    await until(async () => (await rows()).length === 5, 'Done unfolded: five');
    await page.click('[data-testid=group-done]');
    await until(async () => (await rows()).length === 3, 'folded again');
    await pick('All · 30');
    await until(async () => (await rows()).length === 5, 'All: five');
    await page.waitForSelector('[data-testid=notes-filters-on] .np-chip[data-filter="all"]');
    // each chip takes its filter off: the tag, then the list
    await page.click('[data-testid=notes-filters-on] .np-chip[data-tag="motion"]');
    await until(async () => (await rows()).length === 30, 'the tag put down: all 30');
    await page.click('[data-testid=notes-filters-on] .np-chip[data-filter="all"]');
    await until(async () => (await rows()).length === 28, 'back to the groups: 28, the done two folded');
    assert(
      !(await page.$('[data-testid=notes-filters-on]')) && !(await page.$eval('[data-testid=notes-filter]', (b) => b.classList.contains('on'))),
      'no filter on',
    );
  });

  await check('while playing, the note at the playhead is marked and the list follows it, until the person scrolls it', async () => {
    await openPlayer({ width: 1440, height: 620 });
    const scroller = () => page.$eval('.side-scroll', (e) => ({ top: e.scrollTop, h: e.clientHeight, sh: e.scrollHeight }));
    assert((await scroller()).sh > (await scroller()).h + 200, 'the list is longer than its box');
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press(' ');
    await page.waitForFunction(() => !document.querySelector('.vbox video').paused, { timeout: 5000 });
    // past the first screenful of rows: the marked row is in view, the list scrolled to it
    await until(
      async () => {
        const here = await page
          .$eval(
            '.side-scroll .note-row.here',
            (e) => Number(e.querySelector('.nr-tc').textContent.slice(-2)) + Number(e.querySelector('.nr-tc').textContent.slice(3, 5)) * 25,
          )
          .catch(() => -1);
        return here >= 200 ? here : null;
      },
      'the playhead reached the notes below the fold',
      15000,
    );
    const inView = await page.evaluate(() => {
      const s = document.querySelector('.side-scroll').getBoundingClientRect();
      const r = document.querySelector('.side-scroll .note-row.here')?.getBoundingClientRect();
      return !!r && r.top >= s.top - 1 && r.bottom <= s.bottom + 1;
    });
    const followed = (await scroller()).top;
    assert(inView && followed > 100, `the marked row is in view (${inView}), the list followed it (scrollTop ${followed})`);
    await page.keyboard.press(' ');
    await page.waitForFunction(() => document.querySelector('.vbox video').paused, { timeout: 5000 });
    // from the start again, the person scrolls: the list stays where they put it while it plays on
    await page.keyboard.press('Home');
    await page.$eval('.side-scroll', (e) => e.scrollTo(0, 0));
    await page.keyboard.press(' ');
    await page.waitForFunction(() => !document.querySelector('.vbox video').paused, { timeout: 5000 });
    const box = await (await page.$('.side-scroll')).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 40);
    await page.mouse.wheel({ deltaY: 120 });
    await sleep(300);
    const put = (await scroller()).top;
    await sleep(2000);
    const after = (await scroller()).top;
    await page.keyboard.press(' ');
    assert(Math.abs(after - put) < 2, `the list stays where it was scrolled while the note at the playhead moves on: ${put} → ${after}`);
  });

  // Auto-check's answers, held here: running, minor findings only, problems, and a result whose language was a guess
  const minor = [
    { key: 'loudness', kind: 'loudness', severity: 'nice', frame: 0, text: 'Integrated loudness -16.4 LUFS' },
    { key: 'freeze:250', kind: 'freeze', severity: 'nice', frame: 250, range: { in: 250, out: 299 }, text: 'Freeze 2 s', likely: 'intended' },
    { key: 'silence:120', kind: 'silence', severity: 'nice', frame: 120, range: { in: 120, out: 130 }, text: 'Silence 0.4 s' },
  ];
  const problems = [
    { key: 'freeze:40', kind: 'freeze', severity: 'should', frame: 40, range: { in: 40, out: 55 }, text: 'Freeze 0.6 s', likely: 'problem' },
    { key: 'black-frames:150', kind: 'black-frames', severity: 'should', frame: 150, range: { in: 150, out: 152 }, text: 'Black frames', likely: 'problem' },
  ];
  const result = (items, spelling = { state: 'checked', words: 47, languages: ['de', 'en'] }, lang = 'de') => ({
    hash: 'x',
    items,
    text_language: lang,
    spelling,
  });
  const ANSWERS = {
    running: { pending: true },
    minor: result(minor),
    problems: result([...problems, ...minor]),
    guessed: result(minor, { state: 'checked', words: 47 }, 'nb'),
  };
  let mode = 'running';
  const sent = { rerun: 0, accept: [], dismiss: [] };
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname;
    const json = (body) => r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === `/api/qa/${enc(slug)}/1` && r.method() === 'GET') return json(ANSWERS[mode]);
    if (p === `/api/qa/${enc(slug)}/1/rerun`) {
      sent.rerun++;
      mode = 'running';
      return json({ pending: true });
    }
    if (p === `/api/qa/${enc(slug)}/accept`) {
      sent.accept.push(JSON.parse(r.postData() || '{}'));
      return json({ id: 'c_fromqa', timecode: '00:01:15', frame: 40 });
    }
    if (p === `/api/qa/${enc(slug)}/dismiss`) {
      sent.dismiss.push(JSON.parse(r.postData() || '{}'));
      return json({ ok: true });
    }
    return r.continue();
  });
  const chip = () =>
    page.$eval('.side-head [data-testid=ac-chip]', (e) => ({
      state: e.dataset.state,
      text: e.innerText.replace(/\s+/g, ' ').trim(),
      label: e.getAttribute('aria-label'),
    }));
  const colourOf = (token) =>
    page.evaluate((t) => {
      const s = document.createElement('span');
      s.style.color = `var(${t})`;
      document.body.append(s);
      const c = getComputedStyle(s).color;
      s.remove();
      return c;
    }, token);
  const openChecks = async () => {
    await page.click('[data-testid=ac-chip]');
    await page.waitForSelector('.ac-pop .autocheck');
  };

  await check('the Auto-check chip only once it found something: minor findings only, problems in the problem colour', async () => {
    mode = 'running';
    await openPlayer();
    // a first run says nothing in the head: the chip comes once it found something
    await until(async () => !!(await page.$('[data-testid=new-note]')), 'the head');
    assert(!(await page.$('[data-testid=ac-chip]')), 'no chip while the first check runs');
    assert(!(await page.$('.side-scroll .autocheck')), 'no Auto-check card in the notes list');
    mode = 'minor';
    await openPlayer();
    await page.waitForSelector('.side-title [data-testid=ac-chip][data-state=minor]');
    let c = await chip();
    assert(/3 minor/.test(c.text) && /Auto-check: 3 minor findings/.test(c.label), JSON.stringify(c));
    const ok = await page.$eval('[data-testid=ac-chip] .ac-chip-ok', (e) => getComputedStyle(e).color);
    assert(ok === (await colourOf('--ok')), `minor findings only: the quiet green tick (${ok})`);
    mode = 'problems';
    await openPlayer();
    await page.waitForSelector('.side-title [data-testid=ac-chip][data-state=problems]');
    c = await chip();
    assert(c.text === '2 to check' && /2 findings to check/.test(c.label), JSON.stringify(c));
    const look = await page.$eval('[data-testid=ac-chip]', (e) => getComputedStyle(e).color);
    assert(look === (await colourOf('--should')), `the problem colour: ${look}`);
    // the head stays one row with the chip in it, every item inside its padding (it says less where it must)
    const head = await page.$eval('.side-title', (t) => {
      const end = t.getBoundingClientRect().right - parseFloat(getComputedStyle(t).paddingRight);
      return [...t.children].every((c) => c.getBoundingClientRect().right <= end + 1) && !!t.querySelector('[data-testid=ac-chip]');
    });
    assert(head, 'the head row fits with the chip in it');
    await shot('autocheck-chip');
  });

  await check('its popover: problems first, the minor ones folded, Run again; a finding becomes a note or is put away', async () => {
    await openChecks();
    const keys = () => page.$$eval('.ac-pop .ac-row', (els) => els.map((e) => e.dataset.key));
    assert(JSON.stringify(await keys()) === JSON.stringify(['freeze:40', 'black-frames:150']), `problems first, minor folded: ${await keys()}`);
    assert((await page.$eval('.ac-more', (b) => b.textContent.trim())) === '3 minor findings', 'the fold says how many');
    await page.click('.ac-more');
    await until(async () => (await keys()).length === 5, 'the minor ones unfold');
    assert(/German: 47 words/.test(await page.$eval('.ac-about', (e) => e.textContent)), 'the spelling line in the foot names German');
    await shot('autocheck-popover');
    // a finding: its picture opens it, then Ask the agent
    await page.click('.ac-row[data-key="black-frames:150"] .ac-thumb');
    await page.waitForSelector('.ac-row[data-key="black-frames:150"] .ac-acts');
    await page.evaluate(() =>
      [...document.querySelectorAll('.ac-row[data-key="black-frames:150"] .ac-acts button')].find((b) => b.textContent.includes('Ask the agent'))?.click(),
    );
    await until(() => sent.accept.length === 1, 'Ask the agent sends the finding');
    assert(sent.accept[0].key === 'black-frames:150' && sent.accept[0].v === 1, JSON.stringify(sent.accept));
    // another: That's intended takes it away at once (sent once its Undo is gone)
    await page.click('.ac-row[data-key="freeze:40"] .ac-thumb');
    await page.waitForSelector('.ac-row[data-key="freeze:40"] [data-testid=ac-intended]');
    await page.click('.ac-row[data-key="freeze:40"] [data-testid=ac-intended]');
    await page.waitForSelector('.ac-row[data-key="freeze:40"]', { hidden: true, timeout: 5000 });
    await page.waitForSelector('[data-testid=toast]');
    // Run again: asked of the server, the chip running
    await page.click('.ac-pop .ac-rerun');
    await until(() => sent.rerun === 1, 'Run again asks the server');
    await page.waitForSelector('.side-head [data-testid=ac-chip][data-state=running]');
    await page.keyboard.press('Escape');
  });

  await check('the spelling line names a language only when the words were checked in it', async () => {
    mode = 'guessed';
    await openPlayer();
    await page.waitForSelector('[data-testid=ac-chip][data-state=minor]');
    await openChecks();
    // minor findings alone are the list: no fold
    assert((await page.$$('.ac-pop .ac-row')).length === 3 && !(await page.$('.ac-pop .ac-more')), 'the three minor findings, unfolded');
    const line = await page.$eval('.ac-about', (e) => e.textContent);
    assert(/Spelling checked: 47 words/.test(line) && !/Norwegian|Bokmål/.test(line), `an older result's guess isn't named: ${line}`);
    await page.keyboard.press('Escape');
    mode = 'minor';
  });

  await check('a timeline diamond opens the popover on its finding', async () => {
    mode = 'problems';
    await openPlayer();
    await page.waitForSelector('[data-testid=ac-chip][data-state=problems]');
    // the freeze's hollow diamond: frame 40 across the whole video, in the top of the marks lane (Timeline.tsx: under
    // the perforations and the ruler)
    const box = await (await page.$('.timeline canvas')).boundingBox();
    const at = [box.x + (40 / 300) * box.width, box.y + 10 + 16 + 5];
    // the popover's layer is loaded already (the chip opened it before): a diamond then opens it too
    await page.mouse.click(...at);
    await page.waitForSelector('.ac-pop .ac-row.active', { timeout: 5000 });
    const active = await page.$eval('.ac-pop .ac-row.active', (e) => e.dataset.key).catch(() => null);
    assert(active === 'freeze:40', `the popover opened on the freeze: ${active}`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.ac-pop[data-state=open]'), { timeout: 5000 });
    // the same diamond again opens it again
    await page.mouse.click(...at);
    await page.waitForSelector('.ac-pop[data-state=open] .ac-row.active', { timeout: 5000 });
    await page.keyboard.press('Escape');
  });

  await check('a phone: rows at a finger’s height, the chip on the line under the head, its findings a sheet', async () => {
    await page.emulate({
      viewport: { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    });
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${enc(slug)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.nsheet .note-row:not(.pending)');
    await page.tap('.nsheet-handle');
    await page.waitForSelector('.nsheet-half');
    await sleep(400);
    const heights = await page.$$eval('.nsheet .note-row .nr', (els) => [...new Set(els.slice(0, 6).map((e) => Math.round(e.getBoundingClientRect().height)))]);
    assert(
      heights.every((h) => h >= 44),
      `44 px rows: ${heights}`,
    );
    const head = await page.$$eval('.nsheet .side-title button', (bs) => bs.every((b) => b.getBoundingClientRect().right <= innerWidth + 1));
    assert(head, 'every button of the head row on the screen');
    assert(await page.$('.nsheet .np-chips [data-testid=ac-chip]'), 'the chip on the line under the head (the head has no room)');
    await page.$eval('.nsheet [data-testid=ac-chip]', (b) => b.click());
    await page.waitForSelector('.ac-pop .ac-row');
    const sheet = await page.$eval('.ac-pop', (e) => e.getBoundingClientRect().toJSON());
    assert(sheet.left <= 1 && sheet.right >= 389 && sheet.bottom >= 843, `a sheet from the bottom edge: ${JSON.stringify(sheet)}`);
    await shot('phone-autocheck');
  });

  // ---------------------------------------------------------------- a phone's notes (still the phone emulated above)
  /** What a phone's sheet shows: its groups, its notes, and what its selector says (its words without the hidden ones). */
  const sheetShows = () =>
    page.evaluate(() => {
      const pick = document.querySelector('[data-testid=notes-view]');
      return {
        groups: [...document.querySelectorAll('.nsheet .side-scroll .note-sect')].map((e) => e.dataset.group),
        notes: [...document.querySelectorAll('.nsheet .side-scroll .note')].map((e) => e.dataset.note),
        pick: pick
          ? [...pick.childNodes]
              .filter((n) => !n.classList?.contains('sr-only'))
              .map((n) => n.textContent)
              .join(' ')
              .replace(/\s+/g, ' ')
              .trim()
          : null,
        door: document.querySelector('.nsheet [data-testid=check-sheet]')?.textContent.trim() ?? null,
        header: !!document.querySelector('.nsheet [data-testid=check-group]'),
      };
    });
  const openSheet = async (hash = '') => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${enc(teaser)}${hash}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.nsheet .note-row:not(.pending)');
    if (!(await page.$('.nsheet-half, .nsheet-full'))) {
      await page.tap('.nsheet-handle');
      await page.waitForSelector('.nsheet-half');
    }
  };
  /** Taps `sel` once it holds still (the sheet moves to its height first: a tap aimed while it moves lands elsewhere). */
  const tapStill = async (sel) => {
    await page.waitForFunction(
      (sel) =>
        new Promise((done) => {
          const at = () => JSON.stringify(document.querySelector(sel)?.getBoundingClientRect() ?? null);
          const a = at();
          requestAnimationFrame(() => requestAnimationFrame(() => done(a !== 'null' && a === at())));
        }),
      { timeout: 10000 },
      sel,
    );
    await page.tap(sel);
  };
  const pickView = async (words) => {
    await tapStill('[data-testid=notes-view]');
    await page.waitForSelector('.menu[data-state=open] [role=menuitemcheckbox]');
    await page.evaluate(
      (w) =>
        [...document.querySelectorAll('.menu[data-state=open] [role=menuitemcheckbox]')]
          .find((e) => e.textContent.replace(/\s+/g, ' ').trim().startsWith(w))
          ?.click(),
      words,
    );
    await page.waitForFunction(() => !document.querySelector('.menu[data-state=open]'), { timeout: 5000 });
  };

  await check(
    'a phone shows what needs you and what is open; the selector on the left brings the fixes to check, the done ones or all, and a door to checking stays',
    async () => {
      await openSheet();
      let now = await sheetShows();
      assert(
        JSON.stringify(now.groups) === JSON.stringify(['needs', 'open']) &&
          JSON.stringify(now.notes) === JSON.stringify([asked.id, talked.id, plain.id]) &&
          now.pick === 'Open 3' &&
          !now.header,
        `what is open and what needs you, no fixes and no done ones: ${JSON.stringify(now)}`,
      );
      assert(now.door === 'Check 1 fix', `the door to checking the fix the list leaves out: ${JSON.stringify(now)}`);
      // the selector at the line's start, ⋯ at its end, both a finger's size
      const line = await page.$eval('.nsheet .np-chips', (l) => {
        const box = l.getBoundingClientRect();
        const start = box.left + Number.parseFloat(getComputedStyle(l).paddingLeft);
        const end = box.right - Number.parseFloat(getComputedStyle(l).paddingRight);
        const pick = l.querySelector('[data-testid=notes-view]').getBoundingClientRect();
        const more = l.querySelector('[data-testid=notes-more]').getBoundingClientRect();
        const reaches = (r, sel) =>
          [r.top + r.height / 2 - 21, r.top + r.height / 2 + 21].every((y) => document.elementFromPoint(r.left + r.width / 2, y)?.closest(sel));
        return {
          atStart: Math.abs(pick.left - start) <= 1,
          atEnd: Math.abs(more.right - end) <= 1,
          pickTap: reaches(pick, '[data-testid=notes-view]'),
          moreTap: reaches(more, '[data-testid=notes-more]'),
          noFilterButton: !l.querySelector('[data-testid=notes-filter]'),
        };
      });
      assert(Object.values(line).every(Boolean), `the selector on the left, ⋯ on the right, 44 px to a finger: ${JSON.stringify(line)}`);
      await shot('phone-default');
      // To check: the fix in its group, the header's Check its door (the line's steps aside)
      await pickView('To check');
      now = await sheetShows();
      assert(
        JSON.stringify(now.groups) === JSON.stringify(['check']) &&
          JSON.stringify(now.notes) === JSON.stringify([carried.id]) &&
          now.pick === 'To check 1' &&
          now.header &&
          now.door === null,
        `the fix to check, its header's Check: ${JSON.stringify(now)}`,
      );
      await pickView('Done');
      now = await sheetShows();
      assert(JSON.stringify(now.notes) === JSON.stringify([settled.id]) && now.pick === 'Done 1', `the done note: ${JSON.stringify(now)}`);
      await pickView('All');
      now = await sheetShows();
      assert(
        JSON.stringify(now.groups) === JSON.stringify(['needs', 'check', 'open', 'done']) && now.notes.length === 5 && now.pick === 'All 5',
        `all: ${JSON.stringify(now)}`,
      );
      await pickView('Open');
      assert((await sheetShows()).pick === 'Open 3', 'back to what is open');
    },
  );

  await check(
    'a phone: an agent’s question with answers to pick opens the sheet by itself, its question and first answer in view; again when the sheet is raised',
    async () => {
      /** The question's card against the sheet's list: its top, whether its words and first answer are in view. */
      const askAt = () =>
        page.evaluate((id) => {
          const e = document.querySelector(`.nsheet [data-testid=ask-card][data-note="${id}"]`);
          if (!e) return null;
          const box = e.closest('.side-scroll').getBoundingClientRect();
          const first = e.querySelector('[data-testid=ask-pick]').getBoundingClientRect();
          const pick = document.querySelector('[data-testid=notes-view]');
          const picture = document.querySelector('.phone-player .vbox video')?.getBoundingClientRect();
          return {
            top: Math.round(e.getBoundingClientRect().top - box.top),
            inView: e.getBoundingClientRect().top >= box.top - 1 && first.bottom <= box.bottom + 1 && first.bottom <= innerHeight,
            sheet: document.querySelector('.nsheet').className.match(/nsheet-(peek|half|full)/)?.[1],
            picture: picture ? Math.round(picture.height) : 0,
            view: [...pick.childNodes]
              .filter((n) => !n.classList?.contains('sr-only'))
              .map((n) => n.textContent)
              .join(' ')
              .replace(/\s+/g, ' ')
              .trim(),
          };
        }, onPhone.id);
      const ok = (at) => !!at && at.sheet !== 'peek' && at.inView && at.top >= 0 && at.top <= 60 && at.picture > 40 && at.view.startsWith('Open');
      await page.goto('about:blank');
      await page.goto(`${BASE}/#/v/${enc(picks)}`, { waitUntil: 'domcontentloaded' });
      // the notes arrive: the sheet opens to the question by itself, the picture still above it
      await until(
        async () => ok(await askAt()),
        async () => `the question in view on load: ${JSON.stringify(await askAt())}`,
      );
      await shot('phone-picks');
      // put away, then raised again: the question comes up again
      await tapStill('.nsheet-handle');
      await page.waitForSelector('.nsheet-peek');
      await page.$eval('.nsheet .side-scroll', (e) => e.scrollTo(0, e.scrollHeight));
      await tapStill('.nsheet-handle');
      await until(
        async () => ok(await askAt()),
        async () => `the question in view once raised: ${JSON.stringify(await askAt())}`,
      );
    },
  );

  /** Where the opened card stands in the sheet's list: its top and its reply's bottom against the list's box. */
  const placeOf = (id) =>
    page.evaluate((id) => {
      const sc = document.querySelector('.nsheet .side-scroll');
      const card = document.querySelector(`.nsheet [data-note="${id}"].active`);
      if (!sc || !card) return null;
      const box = sc.getBoundingClientRect();
      const r = card.getBoundingClientRect();
      const last = [...card.querySelectorAll('.reply-stub, .c-actions, .check-decision, .note-answer')].at(-1)?.getBoundingClientRect() ?? r;
      return {
        top: Math.round(r.top - box.top),
        bottom: Math.round(last.bottom - box.top),
        room: Math.round(box.height),
        atEnd: sc.scrollTop >= sc.scrollHeight - sc.clientHeight - 1,
        sheet: document.querySelector('.nsheet').className.match(/nsheet-(peek|half|full)/)?.[1],
      };
    }, id);
  const whole = (at) => !!at && at.top >= 0 && at.bottom <= at.room && (at.top <= 24 || at.atEnd);

  await check('a phone: a note picked comes to the sheet’s top, whole — from the list, by a link, going through the notes', async () => {
    // the long list: a note well down it, picked with a finger
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${enc(slug)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.nsheet .note-row:not(.pending)');
    await page.tap('.nsheet-handle');
    await page.waitForSelector('.nsheet-half');
    const id = made[13].id;
    await page.$eval(`.nsheet [data-note="${id}"] .nr`, (e) => e.scrollIntoView({ block: 'end' }));
    await tapStill(`.nsheet [data-note="${id}"] .nr`);
    await until(
      async () => whole(await placeOf(id)),
      async () => `the picked card at the top, its reply in view: ${JSON.stringify(await placeOf(id))}`,
    );
    await shot('phone-opened');
    // by a link: the sheet at rest opens to it
    const linked = made[22].id;
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${enc(slug)}?c=${linked}`, { waitUntil: 'domcontentloaded' });
    await until(
      async () => whole(await placeOf(linked)),
      async () => `the linked card: ${JSON.stringify(await placeOf(linked))}`,
    );
    assert((await placeOf(linked)).sheet !== 'peek', 'the sheet opened to it');
    // going through the open notes (⋯): each one comes up whole
    await tapStill('[data-testid=notes-more]');
    await page.waitForSelector('.menu[data-state=open] [role=menuitemcheckbox], .menu[data-state=open] [role=menuitem]');
    await page.evaluate(() =>
      [...document.querySelectorAll('.menu[data-state=open] [role^=menuitem]')].find((e) => e.textContent.includes('Go through the open notes'))?.click(),
    );
    const first = await until(() => page.$eval('.nsheet .comment.active', (e) => e.dataset.note).catch(() => null), 'review mode opens a note');
    await until(
      async () => whole(await placeOf(first)),
      async () => `the note review mode opened: ${JSON.stringify(await placeOf(first))}`,
    );
  });

  await check('no page errors along the way', async () => {
    assert(!errors.length, errors.join(' | '));
  });
} catch (e) {
  crashed(e, srv);
} finally {
  await finish(LABEL, { browser, servers: [srv] });
}
