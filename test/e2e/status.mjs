#!/usr/bin/env node
// covers: web/src/status/ web/src/library/Board.tsx web/src/library/boardDrag.ts web/src/styles/status.css
// covers: server/routes/status.ts lib/stage.ts lib/stageContext.ts lib/gate.ts
// Browser end-to-end test of the status workflow: a real server (local mode, temp store, free port) + headless Chrome.
// One video walks to_review → changes → check_fixes → team_approved → with_client → client_approved → final; at each
// step the player's stage control, the film card's pill and the library's board agree. The steps the reviewer takes
// in the UI (check the fixes, approve, send to the client, mark final) are clicked; the agent's and the client's
// parts go through the API. Then the same on a phone viewport. Screenshots land in VR_SHOTS when it is set.
import path from 'node:path';
import { age, makeVideo, sleep, until } from '../lib/helpers.ts';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'status e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-status-e2e-', user: 'Sam' });
const { dir, base: BASE } = srv;

const api = jsonApi(BASE);

let browser;
try {
  const file = makeVideo(path.join(dir, 'Acme/export/spot.mp4'), { w: 320, h: 180, fps: 30, dur: 3, pattern: 'testsrc2' });
  age(file);
  const { video } = await api('/api/library', 'POST', { path: file });
  const slug = video.slug;
  await api(`/api/review/${encodeURIComponent(slug)}/folder`, 'PUT', { folder: 'Acme/Reels' });
  const guest = { 'x-forwarded-for': '203.0.113.9' };

  browser = await launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 });
  const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  const player = `${BASE}/#/v/${encodeURIComponent(slug)}`;

  // where the player says the stage: the status beside the sign-off, on a phone the line under the video's name
  const STAGE = '[data-testid=stage-control], [data-testid=stage-line]';
  const openPlayer = async () => {
    await page.goto('about:blank');
    await page.goto(player, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(STAGE, { timeout: 20000 });
  };
  const playerStage = () => page.$eval(STAGE, (e) => e.getAttribute('data-stage'));
  // Every place tells the same story: the player, the film card and the board (#/status opens it).
  const expectStage = async (stage, text) => {
    await openPlayer();
    await until(async () => (await playerStage()) === stage, `player shows ${stage}`);
    if (text) assert((await page.$eval('[data-testid=stage-control]', (e) => e.textContent)).includes(text), `player pill says "${text}"`);
    // the grid (opening #/status below leaves the library on its board layout)
    await page.evaluate(() => localStorage.setItem('vr.library', JSON.stringify({ layout: 'grid' })));
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    // The library first shows what this browser kept from its last visit, then the server's answer (api/persist.ts):
    // a busy server answers after the first read, which then saw the stage before (CI: "with_client, not final").
    const stageOf = (sel) => page.$eval(sel, (e) => e.getAttribute('data-stage')).catch(() => null);
    const CARD = '.film [data-testid=status-pill]';
    await until(
      async () => (await stageOf(CARD)) === stage,
      async () => `film card says ${await stageOf(CARD)}, not ${stage}`,
    );
    await page.goto(`${BASE}/#/status`, { waitUntil: 'domcontentloaded' });
    const BCARD = '[data-testid=library-board] .bcard';
    await until(
      async () => (await stageOf(BCARD)) === stage,
      async () => `board says ${await stageOf(BCARD)}, not ${stage}`,
    );
  };
  // The next step is one button in the top bar; everything else sits behind its chevron.
  const clickNext = async (label) => {
    await page.waitForSelector('[data-testid=stage-next]');
    const text = await page.$eval('[data-testid=stage-next]', (e) => e.textContent);
    assert(text.includes(label), `next step "${text}" is not "${label}"`);
    await page.click('[data-testid=stage-next]');
  };
  const menuItems = async () => {
    await page.click('[data-testid=stage-more]');
    await page.waitForSelector('.menu[data-state=open] [role=menuitem]');
    await sleep(150);
    return page.$$eval('.menu[data-state=open] [role=menuitem]', (els) => els.map((e) => e.textContent.trim()));
  };
  const chooseInMenu = async (label) => {
    const items = await menuItems();
    const i = items.findIndex((x) => x.startsWith(label));
    assert(i >= 0, `"${label}" is in the sign-off menu: ${items.join(' · ')}`);
    const els = await page.$$('.menu[data-state=open] [role=menuitem]');
    await els[i].click();
  };

  let noteId = '';
  await check('a fresh render: to review, everywhere', async () => {
    await expectStage('to_review', 'To review');
    await shot('01-overview-to-review');
  });

  await check('a note: changes requested', async () => {
    noteId = (await api(`/api/review/${encodeURIComponent(slug)}/comments`, 'POST', { frame: 10, text: 'Logo später', severity: 'must' })).id;
    await expectStage('changes', 'Changes requested');
  });

  await check('the agent fixes it: "Check 1 fix" opens verify mode', async () => {
    // (one version only: the seeded fix names it, or it would ride with the next version)
    await api(`/api/comments/${noteId}`, 'PATCH', { status: 'fixed', note: 'moved to 1:10', by: 'agent:promo-edit', fixed_in_v: 1 });
    await expectStage('check_fixes', '1 fix waiting');
    await openPlayer();
    await clickNext('Check 1 fix');
    await page.waitForSelector('.verify', { timeout: 10000 });
    await shot('02-verify-from-stage');
    await api(`/api/comments/${noteId}`, 'PATCH', { status: 'verified' });
  });

  await check('approving in the player: approved, and the next step is sending it to the client', async () => {
    await expectStage('to_review');
    await openPlayer();
    await clickNext('Approve V1');
    await until(async () => (await playerStage()) === 'team_approved', 'approved in the player');
    await until(async () => /Share V1/.test((await page.$eval('[data-testid=stage-next]', (e) => e.textContent).catch(() => '')) || ''), 'next: share it');
    const items = await menuItems();
    assert(
      items.some((x) => x.startsWith('Withdraw your decision')) && !items.some((x) => x.startsWith('Approve V1')),
      `the menu holds the rest: ${items.join(' · ')}`,
    );
    await shot('03-player-approved-menu');
    await page.keyboard.press('Escape');
    await page.click('[data-testid=stage-next]');
    await page.waitForSelector('.modal');
    await page.keyboard.press('Escape');
    await expectStage('team_approved', 'Approved V1');
  });

  let token = '';
  await check('a review link: shared is not seen; a visitor opens it: out for review; approves: approved via link', async () => {
    token = (await api(`/api/review/${encodeURIComponent(slug)}/shares`, 'POST', { label: 'Acme marketing' })).token;
    await expectStage('team_approved', 'Approved V1');
    await api(`/api/g/${token}/visit`, 'POST', { name: 'Mia' }, guest);
    await api(`/api/g/${token}/review/${encodeURIComponent(slug)}`, 'GET', undefined, guest);
    await expectStage('with_client', 'Out for review');
    {
      // the status line says it without "client": the stage, how far they watched, what it waits for
      await openPlayer();
      await page.waitForSelector('[data-testid=stage-control][data-stage=with_client]');
      const line = await page.$eval('[data-testid=stage-control]', (e) => e.textContent);
      assert(/Out for review/.test(line) && /Waiting for their decision/.test(line) && !/client/i.test(line), `status line: ${line}`);
    }
    await api(`/api/g/${token}/approval`, 'POST', { name: 'Mia', status: 'approved', slug, v: 1 }, guest);
    await expectStage('client_approved', 'Approved V1 via link');
    await openPlayer();
    await chooseInMenu('History');
    await page.waitForSelector('[data-testid=stage-history]');
    const history = await page.$eval('[data-testid=stage-history]', (e) => e.textContent);
    assert(
      history.includes('Link') && history.includes('Mia') && history.includes('Team') && !/client/i.test(history),
      `history names both parties: ${history}`,
    );
    await shot('04-player-client-approved-history');
  });

  await check('marking final in the player: final everywhere, in the Final lane', async () => {
    await openPlayer();
    await clickNext('Mark V1 final');
    await until(async () => (await playerStage()) === 'final', 'final in the player');
    await expectStage('final', 'Final V1');
    const lane = await page.$eval('[data-testid=library-board] .bcard', (e) => e.closest('.lane')?.getAttribute('data-lane'));
    assert(lane === 'final', `lane ${lane}`);
    await shot('05-overview-final');
  });

  await check('the player bar: one agent control, one Share, one orange next step, "Decide" when nothing is next', async () => {
    // a final video ships: no agent control until it's reopened
    await openPlayer();
    assert((await playerStage()) === 'final', 'the first video is final by now');
    assert(!(await page.$('[data-testid=agent-button]')), 'final: no agent control');
    // a second video, with an agent assigned that isn't running
    const file2 = makeVideo(path.join(dir, 'Acme/export/second.mp4'), { w: 320, h: 180, fps: 30, dur: 2, pattern: 'rgbtestsrc' });
    age(file2);
    const { video: second } = await api('/api/library', 'POST', { path: file2 });
    await api(`/api/review/${encodeURIComponent(second.slug)}/session`, 'PUT', { name: 'launch-edit', agent: 'claude-code' });
    const open2 = async () => {
      await page.goto('about:blank');
      await page.goto(`${BASE}/#/v/${encodeURIComponent(second.slug)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid=agent-button]', { timeout: 20000 });
    };
    await open2();
    const bar = await page.evaluate(() => ({
      agents: document.querySelectorAll('.p-top [data-testid=agent-button]').length,
      chips: document.querySelectorAll('.p-top .session-chip').length,
      shares: document.querySelectorAll('.p-top [data-testid=share-button]').length,
      next: document.querySelector('[data-testid=stage-next]')?.className ?? null,
      label: document.querySelector('[data-testid=stage-control] .so-label')?.className ?? null,
      agent: document.querySelector('[data-testid=agent-button]')?.getAttribute('aria-label'),
    }));
    assert(bar.agents === 1 && bar.chips === 0 && bar.shares === 1, `one agent control and one Share: ${JSON.stringify(bar)}`);
    assert(/\bprimary\b/.test(bar.next || '') && !/\bok\b/.test(bar.next || ''), `approve is the orange primary: ${bar.next}`);
    assert(/sr-only/.test(bar.label || ''), `the status words don't repeat the button: ${bar.label}`);
    assert(/launch-edit, not running/.test(bar.agent || ''), `the button says who and whether it runs: ${bar.agent}`);
    await page.click('.p-top [aria-label="More"]');
    await page.waitForSelector('.menu[data-state=open] [role=menuitem]');
    const more = await page.$$eval('.menu[data-state=open] [role=menuitem]', (els) => els.map((e) => e.textContent.trim()));
    assert(!more.some((x) => x.startsWith('Share')), `Share isn't repeated in ⋯: ${more.join(' · ')}`);
    await page.keyboard.press('Escape');
    // the assigned agent that isn't running is the picker's first row and chosen; Assign does nothing until it changes
    await page.click('[data-testid=agent-button]');
    await page.waitForSelector('[data-testid=agent-menu]');
    const status = await page.$eval('[data-testid=agent-sentence]', (e) => e.textContent);
    assert(status === 'launch-edit isn’t running', `the popover says where the agent stands: ${status}`);
    // Assign agent… is in its ⋯
    await page.click('[data-testid=agent-more]');
    await page.waitForSelector('.menu[data-state=open] [role=menuitem]');
    await page.evaluate(() =>
      [...document.querySelectorAll('.menu[data-state=open] [role=menuitem]')].find((e) => e.textContent.trim() === 'Assign agent…')?.click(),
    );
    await page.waitForSelector('[data-testid=agent-picker] .session');
    await until(async () => (await page.$eval('[data-testid=agent-picker] .session', (e) => e.className)).includes('sel'), 'the current agent is chosen');
    const first = await page.$eval('[data-testid=agent-picker] .session', (e) => e.textContent);
    assert(/launch-edit/.test(first) && /not running/.test(first), `first row: ${first}`);
    assert(await page.$eval('[data-testid=assign-agent]', (e) => e.disabled), 'Assign waits for another choice');
    await shot('08-agent-picker');
    await page.keyboard.press('Escape');
    const kept = (await api(`/api/review/${encodeURIComponent(second.slug)}`)).review.session;
    assert(kept?.name === 'launch-edit', `still assigned: ${JSON.stringify(kept)}`);
    // an open must: the agent's turn, nothing next for the person — the chevron says "Decide"
    await api(`/api/review/${encodeURIComponent(second.slug)}/comments`, 'POST', { frame: 5, text: 'Logo later', severity: 'must' });
    await open2();
    await until(async () => !(await page.$('[data-testid=stage-next]')), 'no next step while the agent works');
    const decide = await page.$eval('[data-testid=stage-more]', (e) => e.textContent.trim());
    assert(decide === 'Decide', `the chevron reads "${decide}"`);
    const items = await menuItems();
    assert(
      items[0]?.startsWith('Approve V1') &&
        items.some((x) => x === 'Request changes') &&
        items.some((x) => x.startsWith('Decide with a note')) &&
        items.includes('History…'),
      `the decisions: ${items.join(' · ')}`,
    );
    await page.keyboard.press('Escape');
  });

  // The stage's card (status/StageCard.tsx): a video like the one in the maintainer's picture — a note still open and four
  // fixes to check, no agent assigned — so the card says "Changes requested · V1", "4 fixes to check", "1 note open" and
  // "Next: Assign an agent".
  const file3 = makeVideo(path.join(dir, 'Acme/export/third.mp4'), { w: 320, h: 180, fps: 30, dur: 2, pattern: 'smptebars' });
  age(file3);
  const third = (await api('/api/library', 'POST', { path: file3 })).video.slug;
  for (const frame of [3, 9, 15, 21, 27]) {
    const id = (await api(`/api/review/${encodeURIComponent(third)}/comments`, 'POST', { frame, text: `Note at ${frame}`, severity: 'must' })).id;
    if (frame > 3) await api(`/api/comments/${id}`, 'PATCH', { status: 'fixed', note: 'done', by: 'agent:promo-edit', fixed_in_v: 1 });
  }
  const STATUS = '[data-testid=stage-control]';
  const CARD = '[data-testid=stage-card]';
  const openThird = async ({ theme = null, lang = null } = {}) => {
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(
      (theme, lang) => {
        for (const [k, v] of [
          ['vr.theme', theme],
          ['vr.lang', lang],
        ])
          v ? localStorage.setItem(k, v) : localStorage.removeItem(k);
      },
      theme,
      lang,
    );
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${encodeURIComponent(third)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(`${STATUS}[data-stage=changes]`, { timeout: 20000 });
  };
  // the card once it is there and holds still (no animation of its own)
  const cardShown = async () => {
    await page.waitForSelector(CARD, { timeout: 5000 });
    await page.waitForFunction((sel) => !document.querySelector(sel)?.closest('.hovercard')?.getAnimations().length, {}, CARD);
  };
  const hoverStatus = async () => {
    await page.mouse.move(4, 600);
    const b = await (await page.$(STATUS)).boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 3 });
    await cardShown();
  };
  const cardGone = () => page.waitForFunction((sel) => !document.querySelector(sel), { timeout: 5000 }, CARD);

  await check('the stage’s card: it opens on keyboard focus and on hover, Esc and leaving close it, on the float layer’s material', async () => {
    await openThird();
    // a fresh page: the focus that comes before the card's code is played on to it
    await page.focus(STATUS);
    await cardShown();
    const look = await page.$eval(CARD, (card) => {
      const hc = card.closest('.hovercard');
      const probe = document.createElement('div');
      probe.style.background = 'var(--float-bg)';
      document.body.append(probe);
      const float = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { hovercard: !!hc, tooltip: !!card.closest('.tip'), bg: hc && getComputedStyle(hc).backgroundColor, float };
    });
    assert(look.hovercard && !look.tooltip && look.bg === look.float, `a hover card on --float-bg, not a tooltip: ${JSON.stringify(look)}`);
    await page.keyboard.press('Escape');
    await cardGone();
    assert(await page.$eval(STATUS, (e) => document.activeElement === e), 'Esc leaves the focus on the status');
    await page.$eval(STATUS, (e) => e.blur());
    await hoverStatus();
    await page.mouse.move(4, 600, { steps: 3 });
    await cardGone();
  });

  await check('the stage’s card: the stage and its version once, one fact a line, the next step as quiet words (no link, no button)', async () => {
    await hoverStatus();
    const said = await page.$eval(CARD, (card) => {
      const facts = [...card.querySelectorAll('[data-testid=stage-facts] li')].map((li) => {
        const r = li.getBoundingClientRect();
        return { text: li.textContent, top: r.top, bottom: r.bottom };
      });
      const next = card.querySelector('[data-testid=stage-card-next]');
      const s = next && getComputedStyle(next);
      const probe = document.createElement('span');
      probe.style.color = 'var(--muted)';
      card.append(probe);
      const muted = getComputedStyle(probe).color;
      probe.remove();
      return {
        head: card.querySelector('[data-testid=stage-head]')?.textContent,
        versions: (card.innerText.match(/\bV1\b/g) || []).length,
        facts,
        next: next && {
          text: next.textContent,
          tag: next.tagName,
          interactive: !!next.closest('a, button, [role=link], [role=button], [tabindex]') || !!next.querySelector('a, button, [tabindex]'),
          cursor: s.cursor,
          underline: s.textDecorationLine,
          quiet: s.color === muted,
        },
      };
    });
    assert(said.head === 'Changes requested · V1', `the head: "${said.head}"`);
    assert(said.versions === 1, `the version is said once, in the head: ${said.versions}×`);
    assert(
      JSON.stringify(said.facts.map((f) => f.text)) === JSON.stringify(['4 fixes to check', '1 note open']),
      `the facts: ${said.facts.map((f) => f.text).join(' | ')}`,
    );
    assert(
      said.facts.every((f, i) => i === 0 || f.top >= said.facts[i - 1].bottom - 0.5),
      `one fact a line: ${JSON.stringify(said.facts)}`,
    );
    const n = said.next;
    assert(n?.text === 'Next: Assign an agent', `the next step: "${n?.text}"`);
    assert(n.tag === 'P' && !n.interactive && n.cursor !== 'pointer' && n.underline === 'none' && n.quiet, `quiet words, not a link: ${JSON.stringify(n)}`);
    await page.mouse.move(4, 600, { steps: 3 });
    await cardGone();
    // a hover card isn't read out: the facts describe the status, card or not (the words "waiting" are in its name)
    const described = await page.$eval(STATUS, (e) => document.getElementById(e.getAttribute('aria-describedby') ?? '')?.textContent ?? null);
    assert(described === '4 fixes to check · 1 note open', `a screen reader hears the facts: ${described}`);
  });

  // How a stepper sits (StageStepper.tsx), measured: its dots and labels, the track's pieces (each step's ::before and
  // ::after), every dot's and label's contrast on what is under it. What's wrong comes back as sentences.
  const stepsProblems = (sel) =>
    page.$eval(sel, (ol) => {
      const rgba = (c) => {
        const m = c.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/);
        if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
        const s = c.match(/^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)$/);
        if (s) return [s[1] * 255, s[2] * 255, s[3] * 255, s[4] === undefined ? 1 : +s[4]];
        return [0, 0, 0, 0];
      };
      const over = (top, below) => [0, 1, 2].map((k) => top[k] * top[3] + below[k] * (1 - top[3])).concat(1);
      const layers = [];
      for (let n = ol; n; n = n.parentElement) {
        const c = rgba(getComputedStyle(n).backgroundColor);
        if (c[3] > 0) layers.push(c);
        if (c[3] >= 1) break;
      }
      const bg = layers.reverse().reduce((below, top) => over(top, below), [255, 255, 255, 1]);
      const lum = ([r, g, b]) => {
        const lin = (v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      };
      const ratio = (c) => {
        const [x, y] = [lum(over(rgba(c), bg)), lum(bg)].sort((p, q) => q - p);
        return (x + 0.05) / (y + 0.05);
      };
      const lis = [...ol.children];
      const steps = lis.map((li) => {
        const kg = li.querySelector('.kg');
        const lbl = li.querySelector('.lbl');
        const range = document.createRange();
        range.selectNodeContents(lbl);
        const d = kg.getBoundingClientRect();
        const t = range.getBoundingClientRect();
        return {
          label: lbl.textContent,
          state: li.classList.contains('now') ? 'now' : li.classList.contains('done') ? 'settled' : 'ahead',
          settled: li.classList.contains('done'),
          shape: kg.dataset.shape,
          dot: { left: d.left, right: d.right, cx: d.left + d.width / 2, size: d.width, color: getComputedStyle(kg).backgroundColor },
          text: { left: t.left, right: t.right, cx: t.left + t.width / 2 },
          dotRatio: ratio(getComputedStyle(kg).backgroundColor),
          labelRatio: ratio(getComputedStyle(li).color),
        };
      });
      const track = lis.flatMap((li) =>
        ['::before', '::after'].flatMap((pe) => {
          const s = getComputedStyle(li, pe);
          if (s.content === 'none' || s.display === 'none') return [];
          const left = li.getBoundingClientRect().left + parseFloat(s.left);
          return [{ left, right: left + parseFloat(s.width) }];
        }),
      );
      const out = [];
      const cx = steps.map((s) => s.dot.cx);
      const gaps = cx.slice(1).map((x, i) => x - cx[i]);
      if (Math.max(...gaps) - Math.min(...gaps) > 1) out.push(`uneven steps: ${gaps.map((g) => g.toFixed(1)).join(', ')} px apart`);
      for (const s of steps) {
        if (Math.abs(s.text.cx - s.dot.cx) > 1) out.push(`"${s.label}" is ${(s.text.cx - s.dot.cx).toFixed(1)} px off its dot`);
        if (s.dotRatio < 3) out.push(`"${s.label}"'s dot (${s.state}) ${s.dotRatio.toFixed(2)}:1`);
        if (s.labelRatio < 3) out.push(`"${s.label}" (${s.state}) ${s.labelRatio.toFixed(2)}:1`);
      }
      for (let i = 1; i < steps.length; i++)
        if (steps[i].text.left - steps[i - 1].text.right < 4)
          out.push(`"${steps[i - 1].label}" and "${steps[i].label}" ${(steps[i].text.left - steps[i - 1].text.right).toFixed(1)} px apart`);
      // the track: only between two dots, and between every two
      for (const p of track) {
        const j = steps.findIndex((s, i) => i < steps.length - 1 && p.left >= s.dot.right - 0.5 && p.right <= steps[i + 1].dot.left + 0.5);
        if (j < 0) out.push(`a piece of track (${p.left.toFixed(1)}–${p.right.toFixed(1)}) runs into or beyond a dot`);
      }
      for (let i = 0; i < steps.length - 1; i++)
        if (!track.some((p) => p.left >= steps[i].dot.right - 0.5 && p.right <= steps[i + 1].dot.left + 0.5))
          out.push(`no track between "${steps[i].label}" and "${steps[i + 1].label}"`);
      // settled solid, the current one hollow (unless settled: final) and larger, the ones ahead hollow and quieter
      const now = steps.find((s) => s.state === 'now');
      for (const s of steps) {
        if (s.settled && s.shape !== 'diamond') out.push(`settled "${s.label}" is ${s.shape}`);
        if (!s.settled && s.shape !== 'outline') out.push(`"${s.label}" (${s.state}) is ${s.shape}`);
        if (s !== now && s.dot.size >= now.dot.size) out.push(`"${s.label}"'s dot is as large as the current one's`);
        if (s.state === 'ahead' && s.labelRatio >= now.labelRatio) out.push(`"${s.label}" ahead is as strong as the current step`);
        if (s.state === 'ahead' && s.dot.color === now.dot.color) out.push(`"${s.label}" ahead wears the stage's tone`);
      }
      return { steps: steps.map((s) => `${s.label}:${s.state}`).join(' '), out };
    });

  await check('the stage’s card: its steps evenly apart, labels under their dots, the track only between dots, 3:1 — light, dark, German', async () => {
    const out = [];
    for (const theme of ['light', 'dark'])
      for (const lang of ['en', 'de']) {
        await openThird({ theme, lang });
        await hoverStatus();
        const head = 'Changes requested · V1';
        if (lang === 'de') await until(async () => (await page.$eval(`${CARD} [data-testid=stage-head]`, (e) => e.textContent)) !== head, 'the card in German');
        const r = await stepsProblems(`${CARD} .st-steps`);
        for (const p of r.out) out.push(`${theme} ${lang} (${r.steps}): ${p}`);
        await shot(`09-stage-card-${theme}-${lang}`);
      }
    await openThird();
    assert(!out.length, out.join('\n        '));
  });

  await check('the History dialog’s steps: evenly apart, the track only between dots, 3:1 — light and dark', async () => {
    const out = [];
    for (const theme of ['light', 'dark']) {
      await openThird({ theme });
      await chooseInMenu('History');
      await page.waitForSelector('[data-testid=stage-history] .st-steps');
      await page.waitForFunction(() => !document.querySelector('.modal')?.getAnimations().length);
      const r = await stepsProblems('[data-testid=stage-history] .st-steps');
      for (const p of r.out) out.push(`${theme} (${r.steps}): ${p}`);
      await shot(`10-history-steps-${theme}`);
      await page.keyboard.press('Escape');
    }
    await openThird();
    assert(!out.length, out.join('\n        '));
  });

  // The dialog said the server's one line (stageDetail), which German left in English when it had no words for all of
  // it ("1 note open on V1 · 4 fixes to check in V1"): now it says the card's lines.
  await check('the History dialog in German: where the video stands in the card’s words, no English left', async () => {
    await openThird({ lang: 'de' });
    await until(async () => (await page.$eval(STATUS, (e) => e.textContent)).includes('Änderungen gewünscht'), 'the player in German');
    await chooseInMenu('Verlauf');
    await page.waitForSelector('[data-testid=stage-history]');
    const said = await page.$eval('[data-testid=stage-history]', (e) => ({
      head: e.querySelector('[data-testid=stage-head]')?.textContent ?? null,
      facts: [...e.querySelectorAll('[data-testid=stage-facts] li')].map((li) => li.textContent),
      text: e.innerText,
    }));
    await shot('11-history-de');
    await page.keyboard.press('Escape');
    await openThird();
    assert(said.head === 'Änderungen gewünscht · V1', `the head: "${said.head}"`);
    assert(JSON.stringify(said.facts) === JSON.stringify(['4 Korrekturen zu prüfen', '1 Notiz offen']), `the facts: ${said.facts.join(' | ')}`);
    const english = said.text.match(/\b(notes?|open|fix(es)?|check|requested|nobody|decided|approved)\b/gi);
    assert(!english, `English in the German dialog (${english}): ${said.text}`);
  });

  await check('on a phone: the board fits, the sign-off fits, the stage reads the same', async () => {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: SHOTS ? 3 : 1, isMobile: true, hasTouch: true });
    await page.goto(`${BASE}/#/status`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=library-board] .bcard');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert(overflow <= 0, `board scrolls sideways by ${overflow}px`);
    await shot('06-phone-overview');
    await openPlayer();
    assert((await playerStage()) === 'final', 'final on the phone');
    // Final: the next step is publishing it (docs/publishing.md) — reopening sits behind the chevron.
    const next = await page.$eval('[data-testid=stage-next]', (e) => e.textContent.trim()).catch(() => null);
    assert(next === 'Publish', `final: the next step publishes it (${next})`);
    const items = await menuItems();
    assert(
      items.some((x) => x.startsWith('Reopen')),
      `reopening is in the menu: ${items.join(' · ')}`,
    );
    const box = await page.$eval('.menu', (e) => {
      const r = e.getBoundingClientRect();
      return { left: r.left, right: r.right, width: innerWidth };
    });
    assert(box.left >= 0 && box.right <= box.width, `menu inside the screen: ${JSON.stringify(box)}`);
    const bar = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert(bar <= 0, `the player's top bar fits: ${bar}px sideways`);
    await shot('07-phone-signoff');
  });

  await check('no page errors along the way', async () => {
    assert(!errors.length, errors.join(' | '));
  });
} catch (e) {
  crashed(e, srv);
} finally {
  await finish(LABEL, { browser, servers: [srv] });
}
