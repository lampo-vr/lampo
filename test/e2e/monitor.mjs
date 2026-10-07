#!/usr/bin/env node
// covers: web/src/sessions/ web/src/player/ClaudeMenu.tsx server/routes/sessions.ts server/routes/mcp.ts
// covers: server/activity.ts server/agentRuns.ts server/sessionCache.ts server/watch.ts lib/runStream.ts
// covers: lib/activity.ts lib/activityText.ts lib/agentStatus.ts lib/runs.ts server/runs.ts server/routes/runs.ts
// Browser end-to-end test of the live agent monitor: what an agent does shows while it does it, built only from what
// Lampo sees anyway — the agent spends no tokens on it. A run Lampo started (the harness's stand-in prints Claude
// Code's stream-json a line at a time) shows its step, a timeline and its tokens in the agent menu's Live section and
// its step in the agent button; an MCP client reading a note and marking it fixed moves another video's timeline
// without a reload; a `vr` command on this machine arrives through the rolling file; the sidebar's Agents rows say
// what each agent is doing; a phone shows the same in its sheet. Nothing real runs. Screenshots land in VR_SHOTS.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { age, makeVideo, ROOT, sleep, until } from '../lib/helpers.ts';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'monitor e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-monitor-e2e-', user: 'Sam' });
const { dir, base: BASE } = srv;
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const bin = path.join(dir, 'bin');
const hold = (on) => (on ? fs.writeFileSync(path.join(bin, 'hold'), '') : fs.rmSync(path.join(bin, 'hold'), { force: true }));

const api = jsonApi(BASE);

let browser;
let mcp;
try {
  const project = path.join(dir, 'Acme');
  const spotFile = makeVideo(path.join(project, 'export/spot.mp4'), { w: 320, h: 180, fps: 30, dur: 2, pattern: 'testsrc2' });
  const promoFile = makeVideo(path.join(project, 'export/promo.mp4'), { w: 320, h: 180, fps: 30, dur: 2, pattern: 'smptebars' });
  age(spotFile);
  age(promoFile);
  const spot = (await api('/api/library', 'POST', { path: spotFile })).video.slug;
  const promo = (await api('/api/library', 'POST', { path: promoFile })).video.slug;
  await api(`/api/review/${encodeURIComponent(spot)}/session`, 'PUT', { name: 'spot-edit', sessionId: SESSION, cwd: project, agent: 'claude-code' });
  await api(`/api/review/${encodeURIComponent(promo)}/session`, 'PUT', { name: 'promo-cut', sessionId: 'mcp-promo-cut', agent: 'mcp' });
  const note = await api(`/api/review/${encodeURIComponent(promo)}/comments`, 'POST', { frame: 12, text: 'The bars flicker on the cut' });
  await api(`/api/review/${encodeURIComponent(promo)}/comments`, 'POST', { frame: 40, text: 'Hold the last frame longer' });
  // The run Lampo will start prints this, a line every 1.5 s: what a real `claude --output-format stream-json` prints.
  const usage = (input, output, cache) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cache });
  const stream = [
    { type: 'system', subtype: 'init', cwd: project, session_id: SESSION },
    {
      type: 'assistant',
      message: { id: 'm1', content: [{ type: 'text', text: 'I’ll read the open notes first. Then fix them.' }], usage: usage(1200, 30, 9000) },
    },
    {
      type: 'assistant',
      message: { id: 'm2', content: [{ type: 'tool_use', name: 'Read', input: { file_path: `${project}/src/Logo.tsx` } }], usage: usage(1400, 60, 9000) },
    },
    {
      type: 'assistant',
      message: { id: 'm3', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: `${project}/src/Logo.tsx` } }], usage: usage(1500, 420, 9000) },
    },
    {
      type: 'assistant',
      message: { id: 'm4', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm run render -- --comp Spot' } }], usage: usage(1600, 80, 9000) },
    },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 4, total_cost_usd: 0.0387, usage: usage(5700, 590, 36000) },
  ];
  fs.writeFileSync(path.join(bin, 'stream.jsonl'), `${stream.map((l) => JSON.stringify(l)).join('\n')}\n`);
  fs.writeFileSync(path.join(bin, 'stream.delay'), '1.5');
  // Start without asking (the person's choice in Settings).
  await api('/api/auth/me', 'PATCH', { prefs: { wake: 'start' } });

  browser = await launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 });
  const shot = async (name, el) => {
    if (!SHOTS) return;
    // No tooltip of whatever the pointer last touched in the picture.
    await page.mouse.move(2, 600);
    for (const scheme of ['light', 'dark']) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      await sleep(200);
      const target = el ? await page.$(el) : null;
      if (target) await target.screenshot({ path: path.join(SHOTS, `${name}-${scheme}.png`) });
      else await page.screenshot({ path: path.join(SHOTS, `${name}-${scheme}.png`) });
    }
    await page.emulateMediaFeatures([]);
  };
  const openPlayer = async (slug) => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${encodeURIComponent(slug)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=agent-button]', { timeout: 20000 });
  };
  // Opens the agent's menu, or keeps it open: a click on its button while it is open (a row that keeps it open, a run
  // just started) would close it.
  const openMenu = async () => {
    if (!(await page.$('[data-testid=agent-menu]'))) await page.click('[data-testid=agent-button]');
    await page.waitForSelector('[data-testid=agent-menu]');
  };
  const text = (sel) => page.$eval(sel, (e) => e.textContent || '').catch(() => '');
  const timeline = () => page.$$eval('[data-testid=agent-timeline] li', (li) => li.map((e) => e.textContent || '')).catch(() => []);

  await check('nothing about activity is asked for before the first paint', async () => {
    await openPlayer(spot);
    await until(
      () => page.evaluate(() => performance.getEntriesByType('resource').some((r) => r.name.includes('/api/agent-activity'))),
      'the activity asked for once the page is up',
    );
    const t = await page.evaluate(() => ({
      paint: performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint')?.startTime ?? 0,
      asked: performance.getEntriesByType('resource').find((r) => r.name.includes('/api/agent-activity'))?.startTime ?? 0,
    }));
    assert(t.paint > 0 && t.asked > t.paint, JSON.stringify(t));
  });

  await check('a run Lampo started: the Live section shows its step, a timeline with times and its tokens, live', async () => {
    hold(true);
    await openMenu();
    const rows = await page.$$('[data-testid=agent-menu] [data-testid=agent-ask]');
    for (const r of rows) if ((await r.evaluate((e) => e.textContent)).includes('Fix all open notes')) await r.click();
    // the menu closes once the request is answered, which can come after the run is already running
    await page.waitForFunction(() => !document.querySelector('[data-testid=agent-menu]'), { timeout: 10000 });
    await until(async () => (await api(`/api/agent-runs?slug=${encodeURIComponent(spot)}`)).runs[0]?.state === 'running', 'the run');
    // The same page, no reload: what follows arrives live.
    await openMenu();
    await page.waitForSelector('[data-testid=agent-live]');
    await until(async () => (await text('[data-testid=agent-now]')).includes('Editing src/Logo.tsx'), 'the edit step, live', 20000);
    assert(!(await text('[data-testid=agent-live]')).includes(project), 'no full paths on screen');
    // The timeline follows within a second (the run's own step is the newest thing known).
    await until(async () => (await timeline()).some((l) => /Reading src\/Logo\.tsx/.test(l)), 'the read step in the timeline');
    // Three lines in all (the step it is on and two before it), the rest on request.
    assert((await timeline()).length <= 2, `two lines under the step: ${(await timeline()).join(' | ')}`);
    await until(async () => /^Show all \d+$/.test(await text('[data-testid=agent-log-more]')), 'Show all');
    await page.click('[data-testid=agent-log-more]');
    await until(async () => (await timeline()).length > 2, 'the whole log');
    const lines = await timeline();
    assert(lines.some((l) => /Started by Lampo/.test(l)) && lines.some((l) => /I’ll read the open notes first\./.test(l)), lines.join(' | '));
    assert(
      lines.every((l) => /^\d{1,2}:\d{2}/.test(l)),
      `each line has its time: ${lines.join(' | ')}`,
    );
    assert(await page.$('[data-testid=agent-live][data-working] .am-now .kg.live'), 'the working glyph turns');
    await until(async () => /tokens/.test(await text('[data-testid=agent-run-use]')), 'the tokens so far');
    const use = await text('[data-testid=agent-run-use]');
    assert(!/\$/.test(use), `no cost before the run states one: ${use}`);
    assert(await page.$('[data-testid=agent-run-stop]'), 'Stop is there');
    await until(async () => (await text('[data-testid=agent-now]')).includes('Running npm run render'), 'the render step');
    await shot('monitor-popover', '.claude-pop');
  });

  await check('the agent button says where it stands in a word or two, in one line, with the live glyph; the step in its title', async () => {
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid=agent-menu]', { hidden: true });
    const label = () => page.$eval('[data-testid=agent-button]', (e) => e.getAttribute('aria-label') || '');
    // the step it is on is the strip's and the button's title (a tight place says the state, never the step)
    await until(
      async () => (await label()).includes('Running npm run render'),
      async () => `the step in the button's name: ${await label()}`,
    );
    const box = await page.$eval('[data-testid=agent-button]', (e) => {
      const r = e.getBoundingClientRect();
      const s = e.querySelector('[data-testid=agent-step]');
      return {
        h: r.height,
        w: r.width,
        words: s?.textContent ?? '',
        one: s ? s.scrollHeight <= s.clientHeight + 1 && s.scrollWidth <= s.clientWidth + 1 : false,
        live: !!e.querySelector('.kg.live'),
        title: e.title,
      };
    });
    assert(/^(working|fixing \d+ of \d+)$/.test(box.words) && box.one && box.live && box.w <= 201, JSON.stringify(box));
    assert(/^Agent spot-edit: (?:(?:working|fixing \d+ of \d+) · )?Running npm run render/.test(await label()), await label());
    assert(box.title === (await label()), `its title says it all: ${box.title}`);
    // The button as it sits in the bar (not the focus ring Escape hands back to it).
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await shot('monitor-chip', '.p-top');
  });

  await check('the run ends: “Finished”, the tokens it reported and the cost it stated', async () => {
    await until(async () => (await api(`/api/agent-runs?slug=${encodeURIComponent(spot)}`)).runs[0]?.live?.cost_usd != null, 'the result line', 20000);
    hold(false);
    await until(async () => (await api(`/api/agent-runs?slug=${encodeURIComponent(spot)}`)).runs[0]?.state === 'finished', 'the run to end');
    await openPlayer(spot);
    await openMenu();
    await page.waitForSelector('[data-testid=agent-run][data-state=finished]', { timeout: 10000 });
    const use = await text('[data-testid=agent-run-use]');
    assert(/6\.3K tokens/.test(use) && /36K from cache/.test(use) && /\$0\.039/.test(use), use);
    await until(async () => /Finished after/.test(await text('[data-testid=agent-now]')), 'how it ended');
    await page.keyboard.press('Escape');
  });

  await check('an agent connected over MCP that isn’t listening says so, with what starts it; a new note says it once', async () => {
    await openPlayer(promo);
    await openMenu();
    // Assigned, never connected: not connected, and new notes wait for it.
    await until(async () => /Not connected: new notes wait until you start it/.test(await text('[data-testid=agent-listen]')), 'not connected');
    mcp = new Client({ name: 'promo-cut', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
    await mcp.listTools();
    // Connected: still not listening — an MCP client acts only when prompted — and what to tell it, to copy.
    await until(async () => /Connected, not listening/.test(await text('[data-testid=agent-listen]')), 'connected, not listening', 40_000);
    const how = await text('[data-testid=listen-how]');
    assert(/To start it, tell it:/.test(how) && /Use Lampo: work my notes/.test(how), how);
    assert(!(await page.$('[data-testid=agent-button] .kg.live')), 'no turning keyframe for an agent that doesn’t listen');
    await shot('monitor-not-listening', '.claude-pop');
    await page.keyboard.press('Escape');
    // A note for it while it doesn't listen: one toast says how to start it (and only once on this page).
    const toasts = () => page.$$eval('[data-testid=toast]', (t) => t.map((e) => e.textContent || '').filter((s) => s.includes('isn’t listening')));
    await api(`/api/review/${encodeURIComponent(promo)}/comments`, 'POST', { frame: 50, text: 'And the end card' });
    await until(async () => (await toasts()).length === 1, 'the toast');
    assert(/promo-cut isn’t listening: it gets your notes once you tell it to work on them\./.test((await toasts())[0]), (await toasts())[0]);
    await api(`/api/review/${encodeURIComponent(promo)}/comments`, 'POST', { frame: 55, text: 'And the logo' });
    await sleep(1500);
    assert((await toasts()).length <= 1, 'once');
  });

  await check('an agent that waits for feedback shows as listening, live', async () => {
    await openMenu();
    // It read what waited for it, then waits for more.
    await mcp.callTool({ name: 'get_open_notes', arguments: { video: promo } });
    const waiting = mcp.callTool({ name: 'wait_for_feedback', arguments: { video: promo, timeout_s: 30 } });
    await until(async () => /Listening: new notes reach it right away/.test(await text('[data-testid=agent-listen]')), 'listening, without a reload');
    assert(!(await page.$('[data-testid=listen-how]')), 'nothing to start');
    assert(await page.$('[data-testid=agent-button] .kg.live'), 'the turning keyframe');
    // A note while it listens reaches it at once.
    const n = await api(`/api/review/${encodeURIComponent(promo)}/comments`, 'POST', { frame: 60, text: 'One more' });
    const got = await waiting;
    assert((got.content?.[0]?.text ?? '').includes(n.id), got.content?.[0]?.text);
    await page.keyboard.press('Escape');
  });

  await check('an MCP agent reading a note and marking it fixed moves its video’s timeline, without a reload', async () => {
    await openPlayer(promo);
    await openMenu();
    await mcp.callTool({ name: 'get_open_notes', arguments: { video: promo } });
    await until(async () => (await text('[data-testid=agent-now]')).includes('Reading the open notes'), 'the first call, live');
    await mcp.callTool({ name: 'get_note', arguments: { id: note.id } });
    await mcp.callTool({ name: 'mark_fixed', arguments: { id: note.id, note: 'Cut moved two frames' } });
    // A fix is told by what it changed, a note by its moment: never the agent's note ids.
    await until(async () => (await text('[data-testid=agent-now]')).includes('Fixed “Cut moved two frames”'), 'the fix, live');
    const lines = await timeline();
    assert(lines[0]?.includes(`Reading the note at ${note.timecode}`) && lines[1]?.includes('Reading the open notes'), lines.join(' | '));
    assert(!/\bc_[0-9a-f]{6}\b/.test(await text('[data-testid=agent-menu]')), `no note ids: ${await text('[data-testid=agent-menu]')}`);
    // Waiting again and again is one line, "since" when it began.
    await mcp.callTool({ name: 'wait_for_feedback', arguments: { video: promo, timeout_s: 1 } });
    await mcp.callTool({ name: 'wait_for_feedback', arguments: { video: promo, timeout_s: 1 } });
    await until(
      async () => /Waiting for your answer · since \d{1,2}:\d{2}/.test(await text('[data-testid=agent-now]')),
      async () => {
        const { agents } = await api(`/api/agent-activity?slug=${encodeURIComponent(promo)}`);
        return `one wait: “${await text('[data-testid=agent-now]')}” · ${JSON.stringify(agents.map((a) => [a.agent, a.recent.slice(0, 3).map((x) => [x.kind, x.text, x.since])]))}`;
      },
    );
    await shot('monitor-mcp', '.claude-pop');
    await page.keyboard.press('Escape');
  });

  await check('a `vr` command an agent runs on this machine arrives through the rolling file', async () => {
    // This store, never a `vr login` of the shell's.
    const vrEnv = { VR_REMOTE: '0', XDG_CONFIG_HOME: path.join(dir, 'xdg-config'), XDG_CACHE_HOME: path.join(dir, 'xdg-cache') };
    execFileSync(process.execPath, [path.join(ROOT, 'bin/vr'), 'show', note.id], { env: { ...srv.env, ...vrEnv, VR_BY: 'agent:promo-cut' }, encoding: 'utf8' });
    // the button's name and title say the step (its words say the state: a tight place)
    const said = () => page.$eval('[data-testid=agent-button]', (e) => `${e.getAttribute('aria-label')} | ${e.title}`);
    await until(async () => (await said()).split(' | ').every((s) => s.includes(`Reading the note at ${note.timecode}`)), 'the CLI call in the button');
    // …and a person running vr by hand is no agent activity.
    execFileSync(process.execPath, [path.join(ROOT, 'bin/vr'), 'ls'], { env: { ...srv.env, ...vrEnv, VR_BY: 'Sam' }, encoding: 'utf8' });
    await sleep(1500);
    assert((await said()).includes(`Reading the note at ${note.timecode}`), 'unchanged');
    assert(!(await text('[data-testid=agent-step]')).includes('Reading'), `the button's words: ${await text('[data-testid=agent-step]')}`);
  });

  await check('the sidebar’s Agents rows say what each agent is doing now (its step, or where its work on a video stands)', async () => {
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=agent-now-row]', { timeout: 20000 });
    const rows = await page.$$eval('[data-testid=agent-now-row]', (r) => r.map((e) => e.closest('.nav-item')?.textContent || ''));
    assert(
      // with the server's own work on the video (a write opened it): where it stands, in a word or two
      rows.some((r) => r.includes('promo-cut') && /Reading a note|fixing \d+ of \d+|working/.test(r) && !r.includes(note.id)),
      rows.join(' | '),
    );
    const one = await page.$$eval('[data-testid=agent-now-row]', (r) => r.every((e) => (e.closest('.nav-item')?.getBoundingClientRect().height ?? 99) < 40));
    assert(one, 'rows keep their height');
    await shot('monitor-sidebar', '.sidebar');
  });

  await check('a board card says which agent works on its video and what it is doing now', async () => {
    await page.goto(`${BASE}/#/status`, { waitUntil: 'domcontentloaded' });
    // the card's line: the agent's work on the video (RunLine), or before there is any, who works and its live step
    const card = `.bcard[data-slug="${promo}"] :is([data-testid=bcard-agent], [data-testid=run-line])`;
    await until(async () => /promo-cut/.test((await page.$(card)) ? await text(card) : ''), 'the agent on the card');
    await until(async () => /Reading a note|Waiting|Fixed/.test(await text(card)), 'what it is doing, live');
    const said = await text(card);
    assert(/promo-cut/.test(said), `the agent and its step: ${said}`);
    assert(await page.$(`${card} .kg`), 'with the turning keyframe');
    await shot('monitor-board-card', `.bcard[data-slug="${promo}"]`);
  });

  await check('on a phone the button is the mark and the glyph; its sheet has the Live section', async () => {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: SHOTS ? 3 : 1, isMobile: true, hasTouch: true });
    await openPlayer(promo);
    assert(!(await page.$('[data-testid=agent-step]')), 'no words in the compact button');
    await page.click('[data-testid=agent-button]');
    await page.waitForSelector('[data-testid=agent-live]');
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert(!sideways, 'nothing scrolls sideways');
    await shot('monitor-phone');
  });

  await check('no page errors along the way', async () => {
    assert(!errors.length, errors.join(' | '));
  });
} catch (e) {
  crashed(e, srv);
} finally {
  hold(false);
  await mcp?.close().catch(() => {});
  await finish(LABEL, { browser, servers: [srv] });
}
