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
    await api(`/api/comments/${noteId}`, 'PATCH', { status: 'fixed', note: 'moved to 1:10', by: 'agent:promo-edit' });
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
    const status = await page.$eval('[data-testid=agent-menu] .am-status', (e) => e.textContent);
    assert(/launch-edit/.test(status) && /Not running/.test(status), `the popover says where the agent stands: ${status}`);
    await page.click('[data-testid=assign-agent-open]');
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
