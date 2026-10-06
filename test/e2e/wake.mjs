#!/usr/bin/env node
// covers: web/src/sessions/Wake.tsx web/src/player/ClaudeMenu.tsx web/src/settings/Mcp.tsx server/wake.ts
// covers: server/agents.ts server/agentRuns.ts lib/agentRun.ts lib/sessions.ts
// Browser end-to-end test of starting an agent that isn't running, on the machine: the assigned Claude Code session
// is started for a request from the agent menu ("Send and start", asked each time by default), the stand-in the harness
// puts in place of the CLI writes down how it was called (resume that session, in its folder), the menu shows it
// working with Stop, Stop ends it, with "Start it" chosen in Settings a request starts it without asking and its end
// arrives, and answering its question in the inbox can start it to read the answer. Nothing real runs. Screenshots land
// in VR_SHOTS when it is set.
import fs from 'node:fs';
import path from 'node:path';
import { age, makeVideo, sleep, until } from '../lib/helpers.ts';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'wake e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-wake-e2e-', user: 'Sam' });
const { dir, base: BASE } = srv;
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const bin = path.join(dir, 'bin');
const runsLog = path.join(bin, 'runs.log');
const hold = (on) => (on ? fs.writeFileSync(path.join(bin, 'hold'), '') : fs.rmSync(path.join(bin, 'hold'), { force: true }));
const runs = () => (fs.existsSync(runsLog) ? fs.readFileSync(runsLog, 'utf8').split(/^--- /m).filter(Boolean) : []);

const api = jsonApi(BASE);

let browser;
try {
  const project = path.join(dir, 'Acme');
  const file = makeVideo(path.join(project, 'export/spot.mp4'), { w: 320, h: 180, fps: 30, dur: 2, pattern: 'testsrc2' });
  age(file);
  const { video } = await api('/api/library', 'POST', { path: file });
  const slug = video.slug;
  await api(`/api/review/${encodeURIComponent(slug)}/session`, 'PUT', { name: 'spot-edit', sessionId: SESSION, cwd: project, agent: 'claude-code' });
  const events = async () => (await api('/api/inbox?all=1&limit=200')).events.filter((e) => e.type === 'agent_run');

  browser = await launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 });
  const shot = async (name) => {
    if (!SHOTS) return;
    for (const scheme of ['light', 'dark']) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      await sleep(150);
      await page.screenshot({ path: path.join(SHOTS, `${name}-${scheme}.png`) });
    }
    await page.emulateMediaFeatures([]);
  };
  const openMenu = async () => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${encodeURIComponent(slug)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=agent-button]', { timeout: 20000 });
    await page.click('[data-testid=agent-button]');
    await page.waitForSelector('[data-testid=agent-menu]');
  };
  const request = async (label) => {
    const rows = await page.$$('[data-testid=agent-menu] [data-testid=agent-ask]');
    for (const r of rows) if ((await r.evaluate((e) => e.textContent)).includes(label)) return r.click();
    throw new Error(`no request "${label}" in the menu`);
  };

  await check('not running: a request asks first — "Send and start" says where it starts and with whose settings', async () => {
    hold(true);
    await openMenu();
    const label = await page.$eval('[data-testid=agent-button]', (e) => e.getAttribute('aria-label'));
    assert(/not running/.test(label), label);
    await request('Fix all open notes');
    await page.waitForSelector('[data-testid=wake-ask]');
    const ask = await page.$eval('[data-testid=wake-ask]', (e) => e.textContent);
    assert(/spot-edit isn’t running/.test(ask) && /Acme/.test(ask) && /Claude Code settings/.test(ask), ask);
    assert((await page.$eval('[data-testid=wake-start]', (e) => e.textContent)).includes('Send and start spot-edit'), 'the button names the agent');
    assert(!runs().length, 'nothing started before the choice');
    await shot('wake-ask');
  });

  await check('Send and start: the stand-in resumes that session in its folder; the menu shows it working with Stop', async () => {
    await page.click('[data-testid=wake-start]');
    await until(() => runs().length === 1, 'the stand-in to be called');
    const [folder, ...args] = runs()[0].trim().split('\n');
    assert(folder === fs.realpathSync(project), `ran in ${folder}`);
    assert(args[0] === '--resume' && args[1] === SESSION && args.includes('--print'), args.join(' '));
    assert(!args.some((a) => /dangerously|permission/.test(a)), 'no permission flags');
    assert(/^Lampo: Sam asks about spot\.mp4/.test(args.at(-1)), args.at(-1));
    await until(async () => (await events()).some((e) => e.phase === 'started'), 'the started event');
    await openMenu();
    await page.waitForSelector('[data-testid=agent-run][data-state=running]');
    const label = await page.$eval('[data-testid=agent-button]', (e) => e.getAttribute('aria-label'));
    assert(/running/.test(label) && !/not running/.test(label), `running at once: ${label}`);
    assert((await page.$eval('[data-testid=agent-run]', (e) => e.textContent)).includes('Working · started by Lampo'), 'says it works');
    await shot('wake-working');
  });

  await check('Stop ends it (the whole group), the menu says so, and a "stopped" event arrives', async () => {
    await page.click('[data-testid=agent-run-stop]');
    await page.waitForSelector('[data-testid=agent-run][data-state=stopped]', { timeout: 10000 });
    await until(async () => (await events()).some((e) => e.phase === 'stopped' && e.by === 'Sam'), 'the stopped event');
    hold(false);
  });

  await check('with "Start it" chosen in Settings, a request starts it without asking; its end arrives', async () => {
    await page.goto(`${BASE}/#/settings/mcp`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=wake-setting]');
    const options = await page.$$('[data-testid=wake-setting] .seg button');
    for (const o of options) if ((await o.evaluate((e) => e.textContent)) === 'Start it') await o.click();
    await until(async () => (await api('/api/auth/status')).user?.prefs?.wake === 'start', 'the choice saved on the account');
    await shot('wake-setting');
    hold(true);
    await openMenu();
    await request('Look it over before I watch');
    await until(() => runs().length === 2, 'the second run');
    assert(!(await page.$('[data-testid=wake-ask]')), 'no question this time');
    hold(false);
    await until(async () => (await events()).some((e) => e.phase === 'finished' && e.exit === 0), 'the finished event');
    await openMenu();
    await page.waitForSelector('[data-testid=agent-run][data-state=finished]');
    await shot('wake-finished');
  });

  await check('answering its question in the inbox asks first, then answers and starts it to read the answer', async () => {
    await api('/api/auth/me', 'PATCH', { prefs: { wake: 'ask' } });
    const q = await api(`/api/review/${encodeURIComponent(slug)}/comments`, 'POST', { frame: 10, text: 'Logo before the claim?', by: 'agent:spot-edit' });
    hold(true);
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/inbox`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=inbox-view] [data-testid=inbox-row-question]', { timeout: 20000 });
    for (const el of await page.$$('[data-testid=inbox-view] [data-testid=inbox-row-question]'))
      if ((await el.evaluate((e) => e.textContent)).includes('Logo before the claim')) await el.click();
    await page.waitForSelector('[data-testid=inbox-view] .inbox-answer');
    await page.type('[data-testid=inbox-view] .inbox-answer', 'Before the claim');
    await page.click('[data-testid=inbox-view] .inbox-act button[type=submit]');
    await page.waitForSelector('[data-testid=inbox-view] [data-testid=wake-ask]');
    const quote = await page.$eval('[data-testid=inbox-view] .wake-ask-quote', (e) => e.textContent);
    assert(quote === 'Before the claim', `the answer is shown while it waits: ${quote}`);
    await shot('wake-inbox-ask');
    await page.click('[data-testid=inbox-view] [data-testid=wake-start]');
    await until(() => runs().length === 3, 'the run for the answer');
    assert(
      /^Lampo: Sam asks about spot\.mp4 .*Your question on spot\.mp4 was answered: "Before the claim"/.test(runs()[2].trim().split('\n').at(-1)),
      runs()[2],
    );
    const answered = (await api(`/api/review/${encodeURIComponent(slug)}`)).review.comments.find((c) => c.id === q.id);
    assert(answered?.status === 'verified' && answered.replies.at(-1)?.text === 'Before the claim', 'the answer is there');
    hold(false);
    await until(async () => (await events()).filter((e) => e.phase === 'finished').length === 2, 'that run finishing');
  });

  await check('the runs are listed for the machine only, and the log is there', async () => {
    const { runs: list } = await api(`/api/agent-runs?slug=${encodeURIComponent(slug)}`);
    assert(
      list.length === 3 && list.filter((r) => r.state === 'finished').length === 2 && list[2].state === 'stopped',
      JSON.stringify(list.map((r) => r.state)),
    );
    const r = await fetch(`${BASE}/api/agent-runs?slug=x`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    assert(r.status === 401 || r.status === 403, `from elsewhere: ${r.status}`);
    assert((await fetch(`${BASE}/api/agent-runs/${list[0].id}/log`)).ok, 'the log');
  });

  await check('no page errors along the way', async () => {
    assert(!errors.length, errors.join(' | '));
  });
} catch (e) {
  crashed(e, srv);
} finally {
  hold(false);
  await finish(LABEL, { browser, servers: [srv] });
}
