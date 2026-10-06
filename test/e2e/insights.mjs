#!/usr/bin/env node
// covers: test/e2e/lib/insightsStore.ts web/src/library/Insights*.tsx web/src/library/insightsWords.ts
// covers: web/src/player/Viewers.tsx web/src/player/useTeamWatch.ts web/src/styles/insights.css
// covers: server/routes/insights.ts server/playback.ts lib/insights*.ts lib/watch.ts lib/taste.ts
// Browser end-to-end test of Insights on a local store: a real server (temp store, free port) + headless Chrome.
// The page answers one question — why does a video take so many versions to approval, and what would cut that? — in a
// sentence, four stat tiles, then cards that answer first in a sentence: what causes the rounds (a click away from a
// rule in the playbook, drafted from the notes), versions to approval by project against the target, what came back
// as still wrong, the agents right the first time, what is stuck now (with the one thing to do about each), and the
// clients who watched through review links (only when some did). A fresh store says what will show and after how many
// approvals; the period decides the numbers; the owner's player reports what it plays and the player shows who
// watched. Then two stores with two months of history (lib/insightsStore.ts): one person with four projects and four
// agents — 7.8 versions to approval, SFX the top topic — and a team with clients deciding. On the library's grid, one
// type scale, the loading state in the answer's shape, fits 390–1920 in both themes.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { age, makeVideo, ROOT } from '../lib/helpers.ts';
import { dataTheme, layoutMatrix } from './layout.mjs';
import { launch, requireChrome, requireDist, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'insights e2e';
requireChrome(LABEL);
requireDist(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-insights-e2e-', user: 'Sam' });
const { base: BASE, dir } = srv;
/** A store with two months of history (test/e2e/lib/insightsStore.ts), written before its server starts. */
const seeded = (shape) =>
  startServer({
    prefix: `vr-insights-${shape}-`,
    user: 'Sam',
    seed: (env) => execFileSync(process.execPath, [path.join(ROOT, 'test/e2e/lib/insightsStore.ts'), shape], { env, stdio: 'ignore' }),
  });
const servers = [srv];

const api = async (url, method = 'GET', body, headers = {}) => {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert(res.ok, `${method} ${url}: ${res.status} ${await res.clone().text()}`);
  return res.status === 204 ? null : res.json();
};
const addVideo = async (rel, dur = 1) => {
  const file = makeVideo(path.join(dir, rel), { w: 320, h: 180, dur });
  age(file);
  return (await api('/api/library', 'POST', { path: file })).video.slug;
};
const e = encodeURIComponent;
/** Moves a note's times back by `days`, the way a store from back then would have them. */
const backdate = (slug, id, days) => {
  const file = path.join(dir, 'data', slug, 'review.json');
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  const back = (iso) => new Date(Date.parse(iso) - days * 86_400_000).toISOString();
  for (const c of r.comments.filter((x) => x.id === id)) {
    c.created = back(c.created);
    for (const x of c.replies || []) x.at = back(x.at);
  }
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(r, null, 2));
  fs.renameSync(`${file}.tmp`, file);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
try {
  browser = await launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  // the whole page: the library scrolls inside its main element, so the window grows to its height for the picture
  const shot = async (name) => {
    if (!SHOTS) return;
    const vp = page.viewport();
    const tall = await page.evaluate(() => {
      const s = document.querySelector('.lib-scroll');
      return s ? Math.ceil(s.scrollHeight + s.getBoundingClientRect().top) : innerHeight;
    });
    if (tall > vp.height) await page.setViewport({ ...vp, height: tall });
    await page.screenshot({ path: path.join(SHOTS, `insights-${name}.png`) });
    await page.setViewport(vp);
  };
  const openAt = async (base = BASE, width = 1440) => {
    if (page.viewport().width !== width) await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
    await page.goto('about:blank');
    await page.goto(`${base}/#/insights`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=insights][aria-busy=false]', { timeout: 20000 });
  };
  const open = () => openAt(BASE);
  const text = (sel) => page.$eval(sel, (el) => el.innerText.replace(/\s+/g, ' ').trim());
  const texts = (sel) => page.$$eval(sel, (els) => els.map((el) => el.innerText.replace(/\s+/g, ' ').trim()));
  const until = async (fn, what, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return;
      await sleep(150);
    }
    throw new Error(`timed out: ${what}`);
  };
  const CARDS = ['What causes the rounds', 'What came back', 'Agents: right the first time', 'Where it’s stuck now'];

  const spot = await addVideo('Acme/export/spot.mp4', 3);
  await api(`/api/review/${e(spot)}/folder`, 'PUT', { folder: 'Acme' });

  await check('a fresh store: the headline says what will show, four tiles, every card says what will show in it', async () => {
    await open();
    // one project (no card of projects), nobody watched through a link (no card of clients)
    assert(JSON.stringify(await texts('.insights h2')) === JSON.stringify(CARDS), `sections ${await texts('.insights h2')}`);
    assert(
      (await text('[data-testid=ins-headline]')) === 'Nothing approved in this period yet: 1 open video is on V1.',
      await text('[data-testid=ins-headline]'),
    );
    const tiles = await texts('[data-testid=ins-kpis] > li');
    assert(tiles.length === 4, `tiles: ${tiles}`);
    assert(/^Versions to approval – Target ≤ 3$/.test(tiles[0] ?? ''), `tiles: ${tiles}`);
    assert(/^Rounds by topic – After 3 rounds with notes$/.test(tiles[1] ?? ''), `tiles: ${tiles}`);
    assert(
      /^Right the first time – No fix checked yet$/.test(tiles[2] ?? '') && /^Turnaround per round – No new versions yet$/.test(tiles[3] ?? ''),
      `tiles: ${tiles}`,
    );
    assert((await text('[data-testid=ins-causes-answer]')) === 'No new versions in this period.', await text('[data-testid=ins-causes-answer]'));
    // an empty list is one plain sentence in a row's room: the card's answer says nothing came, the sentence what will
    for (const id of ['ins-causes-empty', 'ins-back-empty', 'ins-agents-empty']) {
      const [h, tag, kids] = await page.$eval(`[data-testid=${id}]`, (el) => [el.getBoundingClientRect().height, el.tagName, el.children.length]);
      assert(h > 30 && h < 100 && tag === 'P' && kids === 0, `${id} is a sentence in a row's room: ${h} ${tag} ${kids}`);
    }
    // the one video waits on you: its row opens it
    assert(/^spot\.mp4 Review V1 On you .+ Open video$/.test(await text('[data-testid=st-row]')), await text('[data-testid=st-row]'));
    assert((await page.$eval('[data-testid=st-open]', (a) => a.getAttribute('href'))) === `#/v/${e(spot)}`, 'Open video opens it');
    assert(await page.$('[data-testid=ins-agents] [data-testid=insights-taste-open]'), 'See what agents read, in the agents card');
    await shot('00-empty');
  });

  await check("the owner's player reports what it plays: hundredths and how often, beside the review", async () => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${e(spot)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('.vbox video')?.readyState >= 2, { timeout: 20000 });
    await page.keyboard.press(' ');
    // A good part of the first half played (the clip is 3 s): by the video's own clock, not the wall's.
    await page.waitForFunction(() => document.querySelector('.vbox video')?.currentTime >= 1.2, { polling: 50, timeout: 20000 });
    await page.keyboard.press(' ');
    const file = path.join(dir, 'data', spot, 'views.json');
    await until(() => fs.existsSync(file), 'views.json written on pause');
    const views = JSON.parse(fs.readFileSync(file, 'utf8'));
    const [me] = Object.values(views.viewers);
    assert(me?.name === 'Sam', `the account watching: ${JSON.stringify(me)}`);
    assert(me.v === 1 && me.secs > 0.5 && me.secs < 5, `seconds: ${me.secs}`);
    assert(me.plays[0] >= 1 && me.plays.filter((x) => x > 0).length >= 20, `the first ~half played: ${me.plays.join('')}`);
    assert(me.plays[99] === 0, 'the end did not play');
  });

  // a client watches through a review link, over the whole film and again over its middle; a folder link nobody opens
  const link = await api(`/api/review/${e(spot)}/shares`, 'POST', { label: 'For Mia' });
  const room = await api(`/api/g/${link.token}`, 'GET', undefined, { 'x-forwarded-for': '203.0.113.9' });
  const gid = room.videos?.[0]?.slug ?? room.video?.slug ?? room.slug;
  const guest = (url, body) => api(url, 'POST', body, { 'x-forwarded-for': '203.0.113.9' });
  await guest(`/api/g/${link.token}/visit`, { name: 'Mia', visitor: 'browser-mia-0001' });
  const plays = Array.from({ length: 100 }, (_, i) => (i >= 40 && i < 55 ? 4 : 1));
  await guest(`/api/g/${link.token}/progress`, { visitor: 'browser-mia-0001', slug: gid, v: 1, seen: 'f'.repeat(25), plays, secs: 9, name: 'Mia' });
  await api('/api/folder-shares', 'POST', { folder: 'Acme', label: 'Nobody yet' });

  await check('clients: who watched through which link, the version, how far, what they watched again; the links nobody opened', async () => {
    await open();
    await page.waitForSelector('[data-testid=cl-row]');
    assert(JSON.stringify(await texts('.insights h2')) === JSON.stringify([...CARDS, 'Review links']), `sections ${await texts('.insights h2')}`);
    assert(
      /^Mia went back to 0:01–0:02 of spot\.mp4 again and again\.$/.test(await text('[data-testid=ins-clients-answer]')),
      await text('[data-testid=ins-clients-answer]'),
    );
    const row = await text('[data-testid=cl-row]');
    // (the avatar's initials lead the row's text)
    assert(/^MI Mia via For Mia · just now spot\.mp4 V1 again at 0:01–0:02 100% 9 s · 1×$/.test(row), `row: ${row}`);
    // the lane: the version from start to end, the stretch watched again lit on it
    const lane = await page.$$eval('[data-testid=cl-row] [data-testid=wv-lane] > i', (els) => els.map((el) => [el.className, Number(el.style.flexGrow)]));
    assert(lane.some(([c, n]) => c === 'again' && n === 15) && lane.reduce((s, [, n]) => s + n, 0) === 100, `lane: ${JSON.stringify(lane)}`);
    // the team's own watching isn't on the page: the owner's sitting shows nowhere
    assert(!/\bSam\b|\bYou\b/.test(await text('[data-testid=ins-clients]')), 'only clients in the clients card');
    assert(/Nobody yet/.test(await text('[data-testid=ins-unopened]')) && !/For Mia/.test(await text('[data-testid=ins-unopened]')), 'the link nobody opened');
    // the chart of the client's hundredths opens from the row: one viewer, so a column is as tall as the times it played
    assert(!(await page.$('[data-testid=wv-curve]')), 'no chart until asked');
    await page.click('[data-testid=cl-row] [data-testid=wv-toggle]');
    await page.waitForSelector('[data-testid=wv-curve]');
    assert((await page.$eval('[data-testid=wv-chart]', (el) => el.dataset.mode)) === 'plays', 'one client: a chart of plays');
    const cols = await page.$$eval('[data-testid=wv-curve] .wc-col', (els) => els.map((el) => Number(el.style.getPropertyValue('--v'))));
    assert(cols.length === 100 && cols[0] === 0.25 && cols[45] === 1, `heights are the times played: ${cols.join(' ')}`);
    assert((await page.$$('[data-testid=wv-curve] .wc-col.again')).length === 15, 'the stretch watched again is lit on its own columns');
    assert((await text('[data-testid=wv-read]')) === 'Mia watched 100% of it', await text('[data-testid=wv-read]'));
    if (SHOTS) await (await page.$('[data-testid=cl-row].open'))?.screenshot({ path: path.join(SHOTS, 'insights-01-client-chart.png') });
    await page.click('[data-testid=cl-row] [data-testid=wv-toggle]');
    await page.waitForFunction(() => !document.querySelector('[data-testid=wv-curve]'));
  });

  await check('the player shows who watched: a chip, the band on the timeline, the list', async () => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${e(spot)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=viewers-chip]', { timeout: 15000 });
    assert(/2 viewers/.test(await text('[data-testid=viewers-chip]')), await text('[data-testid=viewers-chip]'));
    await page.click('[data-testid=viewers-chip]');
    await page.waitForSelector('[data-testid=viewers-rows]');
    const rows = await texts('.viewer-row');
    assert(rows.length === 2 && rows.some((r) => /Mia via For Mia/.test(r)), `rows: ${rows}`);
    await page.click('.viewers-band [role=switch]');
    await page.waitForSelector('.timeline[data-views]');
    assert((await page.$eval('.timeline', (t) => t.dataset.rewatched)) === '40-54', await page.$eval('.timeline', (t) => t.dataset.rewatched));
    await page.click('.viewers-band [role=switch]');
    await page.waitForFunction(() => !document.querySelector('.timeline[data-views]'));
    await page.keyboard.press('Escape');
  });

  // the loop: an agent's fixes (one came back, one three weeks ago), then the video is approved
  const teaser = await addVideo('Acme/export/teaser.mp4');
  await api(`/api/review/${e(teaser)}/folder`, 'PUT', { folder: 'Acme' });
  await api(`/api/review/${e(teaser)}/session`, 'PUT', { name: 'promo-edit' });
  const note = async (slug, frame, text, tags = []) => (await api(`/api/review/${e(slug)}/comments`, 'POST', { frame, text, tags, severity: 'must' })).id;
  const good = await note(teaser, 5, 'Hold the end card longer', ['timing']);
  await api(`/api/comments/${good}`, 'PATCH', { status: 'fixed', note: 'held', by: 'agent:promo-edit' });
  await api(`/api/comments/${good}`, 'PATCH', { status: 'verified' });
  const back = await note(teaser, 9, 'The cut lands a beat early', ['timing']);
  await api(`/api/comments/${back}`, 'PATCH', { status: 'fixed', note: 'moved', by: 'agent:promo-edit' });
  await api(`/api/comments/${back}`, 'PATCH', { status: 'open', note: 'still early' });
  const old = await note(spot, 20, 'Cut to the pack shot on the beat');
  await api(`/api/comments/${old}`, 'PATCH', { status: 'fixed', note: 'on the beat', by: 'agent:promo-edit' });
  await api(`/api/comments/${old}`, 'PATCH', { status: 'verified' });
  backdate(spot, old, 21);
  await api(`/api/review/${e(spot)}/approval`, 'PUT', { status: 'approved' });

  await check('one approval: the headline says what it was and after how many the figure settles', async () => {
    await open();
    assert(
      (await text('[data-testid=ins-headline]')) === '1 video approved so far, at V1. The figure settles after 3 approvals.',
      await text('[data-testid=ins-headline]'),
    );
    assert(/^Versions to approval 1 median 1 · target ≤ 3$/.test(await text('[data-testid=ins-kpi-versions]')), await text('[data-testid=ins-kpi-versions]'));
  });

  await check('what came back and the agents: by topic and agent, right the first time — the period decides', async () => {
    await open();
    await page.waitForSelector('[data-testid=ag-row]');
    assert(
      /^1 fix came back as still wrong, most often on timing\.$/.test(await text('[data-testid=ins-back-answer]')),
      await text('[data-testid=ins-back-answer]'),
    );
    const row = await text('[data-testid=bk-row]');
    assert(/^Timing 1 came back The cut lands a beat early “still early” · teaser\.mp4 promo-edit$/.test(row), `came back: ${row}`);
    assert((await page.$eval('[data-testid=bk-row] .bk-example', (a) => a.getAttribute('href'))) === `#/v/${e(teaser)}?c=${back}`, 'the note opens');
    // 30 days: three fixes (the one three weeks ago too); its kind with its mark; one bar and its fraction
    const ag = await text('[data-testid=ag-row]');
    assert(/^promo-edit Claude Code · 3 fixes (67|50)% (2 of 3|1 of 2) right the first time /.test(ag), `agent: ${ag}`);
    assert(/ to fix, typically Came back: timing$/i.test(ag), `what came back: ${ag}`);
    assert(await page.$('[data-testid=ag-row] .ag-mark svg[data-agent=claude-code]'), "the agent's mark");
    await page.click('.ins-period [role=radio]:first-child');
    await page.waitForFunction(() => document.querySelector('[data-testid=insights]')?.getAttribute('aria-busy') === 'false');
    await until(async () => /^promo-edit Claude Code · 2 fixes /.test(await text('[data-testid=ag-row]')), 'the fix three weeks ago is outside 7 days');
    await page.click('.ins-period [role=radio]:nth-child(2)');
    await until(async () => /^promo-edit Claude Code · 3 fixes /.test(await text('[data-testid=ag-row]')), 'back to 30 days');
  });

  await check("on the library's grid: the title where All videos has its own, the content from that edge to the period's", async () => {
    const head = () =>
      page.evaluate(() => {
        const h = document.querySelector('.hero h1');
        const r = h.getBoundingClientRect();
        // where the page's content ends: the scroller's inner edge, less its gutter
        const s = document.querySelector('.lib-scroll');
        const right = s.getBoundingClientRect().left + s.clientLeft + s.clientWidth - parseFloat(getComputedStyle(s).paddingRight);
        return { left: r.left, top: r.top, size: getComputedStyle(h).fontSize, right };
      });
    for (const width of [1440, 1920]) {
      await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
      await page.goto('about:blank');
      await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.film, .lrow');
      const all = await head();
      await openAt(BASE, width);
      const ins = await head();
      const box = (sel) => page.$eval(sel, (el) => el.getBoundingClientRect().toJSON());
      const [lead, tiles, period, last] = [
        await box('[data-testid=ins-headline]'),
        await box('[data-testid=ins-kpis]'),
        await box('.hero .ins-period'),
        await box('[data-testid=ins-stuck]'),
      ];
      console.log(`      @${width}: title left ${ins.left} (All videos ${all.left}), top ${ins.top} (${all.top}), ${ins.size} (${all.size})`);
      assert(Math.abs(ins.left - all.left) <= 1, `@${width}: the title starts at ${ins.left}, All videos' at ${all.left}`);
      assert(Math.abs(ins.top - all.top) <= 1 && ins.size === all.size, `@${width}: the title stands as All videos' does: ${JSON.stringify([ins, all])}`);
      // the content takes the page's width: from the title's edge to the period's, which ends at the page's gutter
      assert(
        [lead, tiles, last].every((b) => Math.abs(b.left - ins.left) <= 1),
        `@${width}: the headline, tiles and cards start at the title's edge`,
      );
      assert(Math.abs(tiles.right - period.right) <= 1 && Math.abs(last.right - period.right) <= 1, `@${width}: they end where the period does`);
      assert(Math.abs(period.right - ins.right) <= 1, `@${width}: the period ends at the page's gutter (${period.right}, ${ins.right})`);
      await shot(`02-grid-${width}`);
    }
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  });

  // A studio of one: four projects, four agents of different kinds, 7.8 versions to approval, SFX behind the most rounds.
  const solo = await seeded('solo');
  servers.push(solo);

  await check('one person, four projects: the headline answers why — 7.8 versions to approval, up from 5.1, SFX the top topic', async () => {
    await openAt(solo.base);
    assert(
      JSON.stringify(await texts('.insights h2')) === JSON.stringify(['What causes the rounds', 'Versions to approval by project', ...CARDS.slice(1)]),
      `sections ${await texts('.insights h2')}`,
    );
    assert(
      (await text('[data-testid=ins-headline]')) === '7.8 versions to approval, up from 5.1. SFX notes cause most of the rounds.',
      await text('[data-testid=ins-headline]'),
    );
    assert(
      (await page.$$eval('[data-testid=ins-headline] b', (bs) => bs.map((b) => b.textContent))).join('|') === '7.8 versions to approval|SFX notes',
      'the figure and the topic stand out',
    );
    const tiles = await texts('[data-testid=ins-kpis] > li');
    assert(tiles[0] === 'Versions to approval 7.8 median 7.5 · target ≤ 3', `tiles: ${tiles}`);
    assert(/^Rounds from SFX \d+% \d+ of \d+ rounds$/.test(tiles[1] ?? ''), `tiles: ${tiles}`);
    assert(/^Right the first time \d+% \d+% the period before$/.test(tiles[2] ?? ''), `tiles: ${tiles}`);
    assert(/^Turnaround per round [\d.]+ h [\d.]+ (h|min) of it on you$/.test(tiles[3] ?? ''), `tiles: ${tiles}`);
    // the team's own watching and its people are gone from the page
    assert(!(await page.$('[data-testid=ins-clients]')) && !(await page.$('[data-testid=ins-watching]')), 'no clients watched: no card of clients');
  });

  await check('what causes the rounds: SFX first in the orange with its rule a click away; timing says its rule exists and it still comes up', async () => {
    assert(
      (await text('[data-testid=ins-causes-answer]')) === 'A rule for SFX would cut the most rounds. Timing has one and still comes up.',
      await text('[data-testid=ins-causes-answer]'),
    );
    const rows = await page.$$eval('[data-testid=rc-row]', (els) =>
      els.map((el) => ({
        text: el.innerText.replace(/\s+/g, ' ').trim(),
        top: el.classList.contains('top'),
        fill: getComputedStyle(el.querySelector('.rc-bar > span')).backgroundColor,
        rule: el.querySelector('[data-testid=rc-rule]')?.getAttribute('href') ?? null,
        primary: !!el.querySelector('.rc-act .btn.primary'),
      })),
    );
    const brand = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--brand)';
      document.body.append(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    });
    assert(rows.length >= 4 && rows.length <= 6, `rows: ${rows.map((r) => r.text)}`);
    const [sfx] = rows;
    assert(/^SFX \d+ rounds · \d+ must-fix · \d+ came back \d+% Make it a rule$/.test(sfx?.text ?? ''), sfx?.text);
    assert(
      sfx?.top && sfx.fill === brand && sfx.primary && sfx.rule === '#/settings/playbook?rule=sfx',
      `the top topic wears the orange: ${JSON.stringify(sfx)}`,
    );
    assert(
      rows.slice(1).every((r) => r.fill !== brand && !r.primary),
      'the rest stay quiet',
    );
    const timing = rows.find((r) => r.text.startsWith('Timing'));
    assert(/^Timing Rule exists — still \d+ rounds · /.test(timing?.text ?? '') && /Open the rule$/.test(timing?.text ?? ''), timing?.text);
    // shares are of the rounds that followed notes: the bars stand on one scale (0–100 %), the most first
    const shares = rows.map((r) => Number(/(\d+)%/.exec(r.text)?.[1]));
    assert(
      shares.every((x, i) => i === 0 || x <= (shares[i - 1] ?? 100)),
      `the most first: ${shares}`,
    );
    assert(/rounds followed only nice-to-haves and ideas/.test(await text('.ins-foot')), await text('.ins-foot'));
  });

  await check('Make it a rule opens the House playbook with the rule drafted from the notes, focused, never saved by itself', async () => {
    await page.click('[data-testid=rc-row].top [data-testid=rc-rule]');
    await page.waitForSelector('[data-testid=pb-add-rule]', { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('[data-testid=pb-add-rule]')?.value, { timeout: 5000 });
    const draft = await page.$eval('[data-testid=pb-add-rule]', (t) => t.value);
    assert(/^Sfx: (The whoosh|Swoosh|Click sound|The riser|Sound effect|Impact hit)/.test(draft), `the rule drafted from the newest ask: ${draft}`);
    assert(await page.$eval('[data-testid=pb-add-rule]', (t) => t === document.activeElement), 'and focused');
    assert(!/rule=/.test(await page.evaluate(() => location.hash)), 'the address lets go of it');
    const house = await (await fetch(`${solo.base}/api/playbook`)).json();
    assert(/Timing/.test(house.rules ?? house.playbook?.rules ?? JSON.stringify(house)) && !/Sfx:/.test(JSON.stringify(house)), 'nothing saved by itself');
    await page.keyboard.press('Escape');
  });

  await check('versions to approval by project: the most first, every bar on one scale with the target across them', async () => {
    await openAt(solo.base);
    assert(
      (await text('[data-testid=ins-projects-answer]')) === 'All 4 projects are over the target; Acme takes the most versions.',
      await text('[data-testid=ins-projects-answer]'),
    );
    const rows = await texts('[data-testid=pj-row]');
    assert(rows.length === 4 && /^Acme 4 approved · 1 open at V12 9\.3 median 9\.5$/.test(rows[0] ?? ''), `rows: ${rows}`);
    assert((await text('.pj-target-label')) === 'Target ≤ 3', 'the target named over its line');
    const lines = await page.$$eval('[data-testid=pj-row] .pj-bar', (els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().left + parseFloat(getComputedStyle(el, '::after').left))),
    );
    const label = await page.$eval('.pj-target-label', (el) => {
      const r = el.getBoundingClientRect();
      return Math.round(r.left + r.width / 2);
    });
    assert(new Set(lines).size === 1 && Math.abs((lines[0] ?? 0) - label) <= 1, `the target at one place on every bar, its label over it: ${lines} ${label}`);
  });

  await check('what came back: by topic, the agents whose fixes they were, the newest note and why', async () => {
    assert(
      /^\d+ fixes came back as still wrong, most often on SFX\.$/.test(await text('[data-testid=ins-back-answer]')),
      await text('[data-testid=ins-back-answer]'),
    );
    const rows = await texts('[data-testid=bk-row]');
    assert(rows.length === 5 && /^SFX \d+ came back .+ “.+” · [\w-]+\.mp4 codex-cuts ×\d+ launch-edit ×\d+/.test(rows[0] ?? ''), `rows: ${rows}`);
    assert((await page.$$('[data-testid=bk-row]:first-child .bk-mark svg')).length >= 2, "each agent's mark");
  });

  await check('agents: each with its mark; one bar of what was right the first time; what came back only where something did', async () => {
    const rows = await page.$$eval('[data-testid=ag-row]', (els) =>
      els.map((el) => ({
        text: el.innerText.replace(/\s+/g, ' ').trim(),
        mark: el.querySelector('.ag-mark svg')?.getAttribute('data-agent') ?? (el.querySelector('.ag-mark .i-plug') ? 'plug' : null),
        bar: !!el.querySelector('.ag-bar'),
        back: [...el.querySelectorAll('[data-testid=ag-back]')].map((c) => c.textContent),
      })),
    );
    const by = Object.fromEntries(rows.map((r) => [r.text.split(' ')[0], r]));
    assert(rows.length === 4, `four agents: ${rows.map((r) => r.text)}`);
    assert(
      by['launch-edit']?.mark === 'claude-code' &&
        by['codex-cuts']?.mark === 'codex' &&
        by['grade-pass']?.mark === 'cursor' &&
        by['render-bot']?.mark === 'plug',
      JSON.stringify(rows),
    );
    assert(/^launch-edit Claude Code · \d+ fixes \d+% \d+ of \d+ right the first time /.test(by['launch-edit']?.text ?? ''), by['launch-edit']?.text);
    assert(by['launch-edit']?.back.length === 2 && by['codex-cuts']?.back.length === 2, 'the topics that came back, two chips');
    assert(/^render-bot MCP client · \d+ questions No fixes/.test(by['render-bot']?.text ?? '') && !by['render-bot']?.bar, by['render-bot']?.text);
    assert(
      /^launch-edit gets \d+% right the first time, codex-cuts \d+%\.$/.test(await text('[data-testid=ins-agents-answer]')),
      await text('[data-testid=ins-agents-answer]'),
    );
  });

  await check('where it’s stuck now: on whom and how long, and the one thing to do — send a reminder, nudge the agent, open it', async () => {
    assert(
      /^spot-proof\.mp4 has waited longest: 2 d out for review\.$/.test(await text('[data-testid=ins-stuck-answer]')),
      await text('[data-testid=ins-stuck-answer]'),
    );
    const rows = await texts('[data-testid=st-row]');
    assert(rows.length === 5, `rows: ${rows}`);
    assert(/^spot-proof\.mp4 Hasn’t opened the link Out for review 2 d Send a reminder$/.test(rows[0] ?? ''), rows[0]);
    const loop = rows.find((r) => r.startsWith('product-loop.mp4')) ?? '';
    assert(/^product-loop\.mp4 The fixes On codex-cuts 20 h Nudge agent$/.test(loop), loop);
    assert(rows.filter((r) => /On you .+ Open video$/.test(r)).length === 3, 'what waits on you opens');
    // the nudge goes to the agent as a request it reads (its inbox), and the button says it went
    const sent = [];
    const listen = (req) => req.method() === 'POST' && /\/request$/.test(req.url()) && sent.push(req.postData());
    page.on('request', listen);
    await page.click('[data-testid=st-nudge]');
    await until(async () => /Nudged/.test(await text('[data-testid=st-nudge]')), 'the button says Nudged');
    page.off('request', listen);
    assert(sent.length === 1 && /A nudge from Insights: product-loop\.mp4 has waited \d+ h for your fixes/.test(sent[0] ?? ''), `the request: ${sent}`);
    assert(await page.$eval('[data-testid=st-nudge]', (b) => b.disabled), 'once');
    // reminding the client: the video's review links, to send one again
    await page.click('[data-testid=st-remind]');
    await page.waitForSelector('[role=dialog]', { timeout: 10000 });
    assert(/Final check/.test(await text('[role=dialog]')), 'the review link it waits on');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[role=dialog]'));
  });

  await check('one type scale: every card names, answers, labels and lists in the same sizes and weights', async () => {
    const fonts = await page.evaluate(() => {
      const of = (sel) => [...new Set([...document.querySelectorAll(sel)].map((el) => `${getComputedStyle(el).fontSize}/${getComputedStyle(el).fontWeight}`))];
      return {
        lead: of('.ins-lead'),
        title: of('.ins-head h2'),
        answer: of('.ins-lede'),
        label: of('.ins-label'),
        row: of('.rc-topic b, .pj-name b, .bk-topic b, .st-name b, .ag-name b'),
        row2: of('.rc-topic > span, .pj-name > span, .bk-topic > span, .st-name > span, .st-who, .ag-name > span, .pj-num > span, .bk-why'),
        num: of('.rc-num, .pj-num b, .st-for, .ag-rate b, .ag-time b'),
      };
    });
    const want = {
      lead: ['18px/400'],
      title: ['15px/650'],
      answer: ['13px/400'],
      label: ['12px/500'],
      row: ['13px/500'],
      row2: ['12px/400'],
      num: ['13px/500'],
    };
    assert(JSON.stringify(fonts) === JSON.stringify(want), JSON.stringify(fonts));
    await shot('03-solo');
  });

  // A later visit knows how many rows each card had (its prefs) but has no answer yet: the rows wait in their loading
  // anatomy, and every one of them is where the answer's row lands. (quality-load.mjs checks the first visit.)
  await check('a later visit loads in the shape it will have: every row stands where its answer lands', async () => {
    await openAt(solo.base);
    const prefs = await page.evaluate(() => localStorage.getItem('vr.insights'));
    assert(prefs && /"shape"/.test(prefs), `the shape is remembered: ${prefs}`);
    const MARKS = [
      ['headline', '[data-testid=ins-headline]'],
      ['tiles', '[data-testid=ins-kpis]'],
      ...['causes', 'projects', 'back', 'agents', 'stuck'].map((id) => [`${id} head`, `[data-testid=ins-${id}] .ins-head`]),
      ['cause row', '.rc-row'],
      ['last cause row', '.rc-row:last-child'],
      ['project heads', '.pj-heads'],
      ['project row', '.pj-row'],
      ['causes line', '[data-testid=ins-causes] .ins-foot'],
      ['came-back row', '.bk-row'],
      ['agent heads', '.ag-heads'],
      ['agent row', '.ag-row'],
      ['last agent row', '.ag-row:last-child'],
      ['stuck row', '.st-row'],
      ['stuck card', '[data-testid=ins-stuck]'],
    ];
    for (const vp of [
      { width: 1440, height: 900, deviceScaleFactor: 1 },
      { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    ]) {
      const ctx = await browser.createBrowserContext();
      try {
        const p = await ctx.newPage();
        await p.setViewport(vp);
        await p.evaluateOnNewDocument((v) => {
          try {
            localStorage.setItem('vr.insights', v);
          } catch {}
        }, prefs);
        let release;
        const held = new Promise((r) => {
          release = r;
        });
        await p.setRequestInterception(true);
        p.on('request', async (req) => {
          if (req.url().includes('/api/insights')) await held;
          req.continue().catch(() => {});
        });
        await p.goto(`${solo.base}/#/insights`, { waitUntil: 'domcontentloaded' });
        await p.waitForSelector('[data-testid=insights][aria-busy=true] .rc-row', { timeout: 15000 });
        // the page's code is here too (only the answer is held): what replaces the stand-in is the page itself
        await p.waitForFunction(() => performance.getEntriesByType('resource').some((r) => /\/Insights-[\w-]+\.js$/.test(r.name)), { timeout: 15000 });
        const boxes = () =>
          p.evaluate((marks) => {
            const out = {};
            for (const [name, sel] of marks) {
              const el = document.querySelector(sel);
              if (el) out[name] = ['left', 'top', 'width', 'height'].map((k) => Math.round(el.getBoundingClientRect()[k]));
            }
            return out;
          }, MARKS);
        const before = await boxes();
        release();
        await p.waitForSelector('[data-testid=insights][aria-busy=false]', { timeout: 15000 });
        await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        const after = await boxes();
        const moved = MARKS.map(([name]) => name).filter((n) => !before[n] || !after[n] || before[n].some((v, i) => Math.abs(v - (after[n][i] ?? 0)) > 2));
        assert(!moved.length, `@${vp.width}: ${moved.map((n) => `${n} ${before[n]} → ${after[n]}`).join('; ')}`);
      } finally {
        await ctx.close().catch(() => {});
      }
    }
  });

  await check('one person, from a phone to the widest screen: rows fit, nothing sideways, in both themes', async () => {
    for (const width of [390, 1024, 1920]) {
      await openAt(solo.base, width);
      const over = await page.evaluate(
        () =>
          [...document.querySelectorAll('.rc-row, .pj-row, .bk-row, .ag-row, .st-row, .ins-kpi')].filter((el) => el.scrollWidth > el.clientWidth + 1).length,
      );
      assert(!over, `@${width}: ${over} rows spill`);
    }
    await openAt(solo.base);
    const out = await layoutMatrix(page, { insights: null }, { show: dataTheme });
    assert(!out.length, out.join('\n'));
    if (SHOTS) {
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await sleep(400);
      await shot('04-solo-phone');
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    }
  });

  // A team with clients: timing still the top topic though a rule says it, two clients deciding.
  const team = await seeded('team');
  servers.push(team);

  await check('a team: timing causes the most rounds even with its rule; the rule a click away instead of a new one', async () => {
    await openAt(team.base);
    assert(
      (await text('[data-testid=ins-headline]')) === '6.2 versions to approval, down from 7. Timing notes cause the most rounds, even with a rule.',
      await text('[data-testid=ins-headline]'),
    );
    assert(
      /^Timing has a rule and still comes up most: sharpen it\./.test(await text('[data-testid=ins-causes-answer]')),
      await text('[data-testid=ins-causes-answer]'),
    );
    const top = await text('[data-testid=rc-row].top');
    assert(/^Timing Rule exists — still \d+ rounds/.test(top) && /Open the rule$/.test(top), top);
    assert(
      (await page.$eval('[data-testid=rc-row].top [data-testid=rc-open-rule]', (a) => [a.className, a.getAttribute('href')].join('|'))).endsWith(
        'primary|#/settings/playbook',
      ),
      'its rule, the one action',
    );
  });

  await check('a team: the clients who watched, through which link, how far; the one nobody opened; both deciding wait in the stuck list', async () => {
    const rows = await texts('[data-testid=cl-row]');
    assert(rows.length === 2, `clients: ${rows}`);
    assert(
      rows.some((r) => /^JO Jon via Northwind review · \d+ h ago feature-tour\.mp4 V6 50% /.test(r)),
      `Jon: ${rows}`,
    );
    assert(
      rows.some((r) => /^MI Mia via Client review · \d+ (h|d) ago promo-cut\.mp4 V8 again at \d:\d\d–\d:\d\d 100% /.test(r)),
      `Mia: ${rows}`,
    );
    assert(
      /^Mia went back to \d:\d\d–\d:\d\d of promo-cut\.mp4 again and again\.$/.test(await text('[data-testid=ins-clients-answer]')),
      await text('[data-testid=ins-clients-answer]'),
    );
    assert(/Final check spot-proof\.mp4/.test(await text('[data-testid=ins-unopened]')), 'the link nobody opened');
    assert((await page.$$('[data-testid=st-remind]')).length === 3, 'three videos wait on clients, each with its reminder');
    await shot('05-team');
  });

  await check('a team, from a phone to the widest screen: nothing sideways, in both themes', async () => {
    for (const width of [390, 1920]) {
      await openAt(team.base, width);
      const over = await page.evaluate(() => [...document.querySelectorAll('.ins-row, .ins-kpi')].filter((el) => el.scrollWidth > el.clientWidth + 1).length);
      assert(!over, `@${width}: ${over} rows spill`);
    }
    await openAt(team.base);
    const out = await layoutMatrix(page, { insights: null }, { show: dataTheme });
    assert(!out.length, out.join('\n'));
  });

  await check('no page errors along the way', async () => {
    assert(!errors.length, errors.join(' | '));
  });
} catch (err) {
  crashed(err, ...servers);
} finally {
  await finish(LABEL, { browser, servers });
}
