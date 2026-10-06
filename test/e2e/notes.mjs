#!/usr/bin/env node
// covers: web/src/player/NotesPanel.tsx web/src/player/noteRows.ts web/src/player/AutoCheck.tsx
// covers: web/src/player/findingWords.ts web/src/player/hashtags.ts web/src/styles/notes.css
// covers: web/src/styles/autocheck.css server/routes/analysis.ts lib/qa.ts lib/findings.ts lib/text/
// Browser suite of the notes panel with many notes (local mode, temp store, headless Chrome): 30 notes are 30 rows —
// timecode, the severity's keyframe glyph, the first line, no pill and no coloured outline — under a group header only
// where the author or the sitting changes; the selected note (a click, ↑ / ↓) opens in place into its card while every
// other stays a row; the notes' tags are chips with counts that narrow the list with the filter above; while playing
// the note at the playhead is marked and the list follows it, until the person scrolls it. Auto-check is one chip in
// the head — running, minor findings only, problems — whose popover lists the problems first, folds the minor ones,
// runs again, turns a finding into a note or puts it away, and names the spelling language only when it was checked in
// it. A phone has the same rows at a finger's height and the chip in the tags' line.
import fs from 'node:fs';
import path from 'node:path';
import { tagCounts } from '../../web/src/player/noteRows.ts';
import { age, makeVideo, sleep, until } from '../lib/helpers.ts';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

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
  fs.writeFileSync(reviewFile, JSON.stringify(stored, null, 2));
  const review = async () => (await api(`/api/review/${enc(slug)}`)).review;
  await until(async () => (await review()).comments.some((c) => c.author === 'Mia Lang'), 'the store is read again');

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

  await check('30 notes are 30 rows: timecode, the severity’s glyph and the first line; no pill, no outline', async () => {
    await openPlayer();
    const all = await rows();
    assert(all.length === 30 && all.every((r) => r.row && !r.open), `30 rows, none open: ${JSON.stringify(all.slice(0, 3))}…`);
    const look = await page.$$eval('.side-scroll .note-row', (els) =>
      els.map((e) => {
        const nr = e.querySelector('.nr');
        const s = getComputedStyle(nr);
        return {
          h: nr.getBoundingClientRect().height,
          tc: e.querySelector('.nr-tc')?.textContent,
          glyph: !!e.querySelector('.nr-kg .kg'),
          text: e.querySelector('.nr-text')?.textContent,
          oneLine: e.querySelector('.nr-text').scrollHeight <= e.querySelector('.nr-text').clientHeight + 1,
          pills: e.querySelectorAll('.badge').length,
          border: parseFloat(s.borderTopWidth) + parseFloat(getComputedStyle(e).borderTopWidth),
        };
      }),
    );
    const odd = look.filter((l) => l.h < 28 || l.h > 40 || !l.glyph || !l.oneLine || l.pills || l.border || !/^\d\d:\d\d:\d\d$/.test(l.tc));
    assert(!odd.length, `rows: ${JSON.stringify(odd.slice(0, 3))}`);
    assert(look[1].text === 'Hold the hero shot longer', `the first line only: ${look[1].text}`);
    // the timecodes stand in one column: the words start together
    const lefts = await page.$$eval('.side-scroll .note-row .nr-text', (els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().left)))]);
    assert(lefts.length === 1, `the words start at one x: ${lefts}`);
    await shot('rows-1440');
  });

  await check('a group header only where the author or the sitting changes', async () => {
    const heads = await page.$$eval('.side-scroll .note-group', (els) =>
      els.map((e) => ({ who: e.querySelector('b')?.textContent, note: e.closest('.note')?.dataset.note })),
    );
    const ids = made.map((c) => c.id);
    assert(
      JSON.stringify(heads.map((h) => [h.who, h.note])) ===
        JSON.stringify([
          ['Sam', ids[0]],
          ['Mia Lang', ids[10]],
          ['Sam', ids[15]],
        ]),
      `three groups: ${JSON.stringify(heads)}`,
    );
    assert(/ago/.test(await page.$eval('.side-scroll .note-group .when', (e) => e.textContent)), 'the group says when');
  });

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

  await check('tag chips: the notes’ tags with their counts; one picked narrows the list, with the filter above', async () => {
    await openPlayer();
    const open = (await review()).comments.filter((c) => c.status === 'open' || c.status === 'fixed');
    const want = tagCounts(open).map(([tag, n]) => `${tag} ${n}`);
    const chips = await page.$$eval('.note-tagf .tagf', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    assert(JSON.stringify(chips) === JSON.stringify(want), `chips ${JSON.stringify(chips)}, want ${JSON.stringify(want)}`);
    assert(chips[0] === 'sfx 10' && chips.includes('story 10') && chips.includes('motion 5'), `counts: ${chips}`);
    await page.click('.tagf[data-tag="motion"]');
    await until(async () => (await rows()).length === 5, 'five motion notes');
    assert(await page.$eval('.tagf[data-tag="motion"]', (b) => b.getAttribute('aria-pressed') === 'true'), 'the chip says it is picked');
    const texts = await page.$$eval('.side-scroll .note-row .nr-text', (els) => els.map((e) => e.textContent));
    assert(
      texts.every((x) => x.startsWith('Text eases in too fast')),
      `only motion: ${texts}`,
    );
    await shot('tag-motion');
    // with the filter above: two motion notes closed leave three open; All has all five
    for (const c of made.filter((_, i) => i % WORDS.length === 2).slice(0, 2)) await api(`/api/comments/${c.id}`, 'PATCH', { status: 'verified' });
    await until(async () => (await rows()).length === 3, 'three motion notes still open');
    assert((await page.$eval('.tagf[data-tag="motion"]', (b) => b.textContent.replace(/\s+/g, ' ').trim())) === 'motion 3', 'the count follows the filter');
    for (const h of await page.$$('.note-filters [role=tab]')) if ((await h.evaluate((e) => e.textContent.trim())).startsWith('All')) await h.click();
    await until(async () => (await rows()).length === 5, 'All: five');
    await page.click('.tagf[data-tag="motion"]');
    await until(async () => (await rows()).length === 30, 'the tag put down: all 30');
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
    page.$eval('.side-title [data-testid=ac-chip]', (e) => ({
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

  await check('the Auto-check chip: running, minor findings only, problems in the problem colour', async () => {
    mode = 'running';
    await openPlayer();
    await page.waitForSelector('.side-title [data-testid=ac-chip][data-state=running] .spinner');
    assert(!(await page.$('.side-scroll .autocheck')), 'no Auto-check card in the notes list');
    assert(/Checking/.test((await chip()).text), JSON.stringify(await chip()));
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
    // the head stays one row: + Note on it, beside the chip
    const head = await page.$eval('.side-title', (t) => t.scrollWidth <= t.clientWidth + 1);
    assert(head, 'the head row fits');
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
    await page.waitForSelector('.side-title [data-testid=ac-chip][data-state=running]');
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

  await check('a phone: rows at a finger’s height, the chip in the tags’ line, its findings a sheet', async () => {
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
    assert(await page.$('.nsheet .note-tagf [data-testid=ac-chip]'), 'the chip opens the tags’ line');
    await page.$eval('.nsheet [data-testid=ac-chip]', (b) => b.click());
    await page.waitForSelector('.ac-pop .ac-row');
    const sheet = await page.$eval('.ac-pop', (e) => e.getBoundingClientRect().toJSON());
    assert(sheet.left <= 1 && sheet.right >= 389 && sheet.bottom >= 843, `a sheet from the bottom edge: ${JSON.stringify(sheet)}`);
    await shot('phone-autocheck');
  });

  await check('no page errors along the way', async () => {
    assert(!errors.length, errors.join(' | '));
  });
} catch (e) {
  crashed(e, srv);
} finally {
  await finish(LABEL, { browser, servers: [srv] });
}
