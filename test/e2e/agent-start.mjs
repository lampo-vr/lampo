#!/usr/bin/env node
// covers: web/src/sessions/agentStart.tsx web/src/library/Library.tsx web/src/settings/Mcp.tsx web/src/onboarding/GetStarted.tsx web/src/styles/agentstart.css lib/mcpConfig.ts
// One prompt starts the agent's work wherever it is offered. An empty library leads with it: the one raised button
// copies it, the line right under it follows the agent (the agents it is for → waiting for one → the agent connected,
// what it does), then Connect your agent (the setup by hand), then adding a video yourself, quieter. On the machine the
// prompt points at this app with nothing to sign in; on a hosted server at its /mcp, signing in being the person's, and
// never a token. A heartbeat or a real MCP client moves the line from waiting to connected; the agent's V1 ends the
// empty page. The layout at 390/768/1024/1440/1920 in both themes, German too; Connect an agent and Get started's
// agent step lead with the same copy. Screenshots land in VR_SHOTS.
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { makeVideo } from '../lib/helpers.ts';
import { clippedText, cutLabels, settle, sideways } from './layout.mjs';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir, signedIn } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'agent-start e2e';
requireChrome(LABEL);
const PW = ['a', 'long', 'enough', 'password'].join(' ');
const SHOTS = shotsDir();
const WIDTHS = [390, 768, 1024, 1440, 1920];

const servers = [];
let browser;
let page = null;
let agent = null;
screenshotFailures(() => page, 'agent-start');
try {
  // the person's own machine: signed in by being there, an empty library
  const local = await startServer({ prefix: 'vr-agent-start-e2e-', user: 'Mia' });
  servers.push(local);
  const localApi = jsonApi(local.base);
  /** A hosted server's owner, made with the setup token; the setup's screens skipped by the API. */
  const owner = async (srv) => {
    const made = await fetch(`${srv.base}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: srv.base },
      body: JSON.stringify({ token: await srv.setupToken(), name: 'Mia Lang', email: 'mia@e2e.test', password: PW }),
    });
    assert(made.ok, `setup: ${made.status}`);
    srv.cookie = (made.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('vr_session='))?.split(';')[0];
    return async (p, method = 'GET', body) => {
      const r = await fetch(srv.base + p, {
        method,
        headers: { 'Content-Type': 'application/json', Origin: srv.base, Cookie: srv.cookie },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      assert(r.ok, `${method} ${p}: ${r.status} ${text}`);
      return text ? JSON.parse(text) : null;
    };
  };
  // a hosted server: an owner, an empty library, a real MCP client later
  const hosted = await startServer({ prefix: 'vr-agent-start-hosted-e2e-', mode: 'server', publicUrl: true });
  servers.push(hosted);
  const mia = await owner(hosted);
  // another, whose owner has Get started (its sample keeps the library from being empty)
  const gs = await startServer({ prefix: 'vr-agent-start-gs-e2e-', mode: 'server', publicUrl: true, onboarding: true });
  servers.push(gs);
  await (await owner(gs))('/api/onboarding', 'PUT', { setup: 'done' });

  browser = await launch();
  const errors = [];
  /** A fresh browser on one of the servers, clipboard allowed. */
  const fresh = async (srv, { width = 1440, height = 900, theme = 'light', lang = 'en', mobile = false } = {}) => {
    const ctx = await browser.createBrowserContext();
    await ctx.overridePermissions(srv.base, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
    const p = await ctx.newPage();
    await p.setViewport({ width, height, ...(mobile ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
    if (srv.cookie) await p.setCookie({ name: 'vr_session', value: srv.cookie.split('=').slice(1).join('='), url: srv.base });
    await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
    await p.evaluateOnNewDocument((l) => localStorage.setItem('vr.lang', l), lang);
    p.on('pageerror', (e) => errors.push(e.message));
    page = p;
    return p;
  };
  const open = async (p, srv, hash = '#/') => {
    await p.goto(`${srv.base}/${hash}`, { waitUntil: 'domcontentloaded' });
    await signedIn(p);
    await settle(p, { quiet: 300 });
  };
  const shot = async (p, name) => SHOTS && p.screenshot({ path: path.join(SHOTS, `agent-start-${name}.png`) });
  /** The empty state's way in, as laid out: each part's box and words, top to bottom. */
  const stack = (p, scope = '.empty-library') =>
    p.evaluate((scope) => {
      const box = (e) => {
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return {
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          left: Math.round(r.left),
          width: Math.round(r.width),
          mid: Math.round(r.left + r.width / 2),
        };
      };
      const root = document.querySelector(scope);
      const copy = root.querySelector('[data-testid=make-with-agent]');
      const line = root.querySelector('[data-testid=agent-line]');
      const connect = root.querySelector('[data-testid=connect-agent]');
      const own = [...root.querySelectorAll('.agent-start > button.btn')].find((b) => b !== copy);
      return {
        copy: { ...box(copy), text: copy?.textContent.trim(), cls: copy?.className },
        line: { ...box(line), text: line?.textContent.trim(), state: line?.dataset.state },
        connect: connect && { ...box(connect), text: connect.textContent.trim(), href: connect.getAttribute('href'), cls: connect.className },
        own: own && { ...box(own), text: own.textContent.trim(), cls: own.className },
        raised: root.querySelectorAll('.btn.primary').length,
        title: root.querySelector('.empty-title')?.textContent,
        tips: root.querySelector('.empty-tips')?.textContent ?? '',
        center: box(root).mid,
      };
    }, scope);
  const clip = (p) => p.evaluate(() => navigator.clipboard.readText());
  /** Buttons of the way in whose words don't fit them (they never wrap: nowrap). */
  const overflowing = (p) =>
    p.$$eval('.agent-start > .btn', (bs) =>
      bs.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => `${b.textContent.trim()} (${b.scrollWidth} > ${b.clientWidth})`),
    );

  await check('the machine’s empty library: the copy is the one raised button, the line under it, then Connect your agent, then Add video', async () => {
    const p = await fresh(local);
    await open(p, local);
    await p.waitForSelector('.empty-library [data-testid=agent-line][data-state=ready]', { timeout: 15000 });
    const s = await stack(p);
    assert(s.raised === 1 && s.copy.cls.includes('primary'), `one raised primary, the copy: ${JSON.stringify(s)}`);
    // the bar's Add video steps back too: the copy is the page's one raised button
    const bar = await p.$eval('.topbar .add-video', (e) => e.className);
    assert(!bar.includes('primary') && bar.includes('quiet'), `the bar's Add video: ${bar}`);
    assert(s.copy.text === 'Copy prompt for your agent', s.copy.text);
    assert(s.line.top >= s.copy.bottom && s.connect.top >= s.line.bottom && s.own.top >= s.connect.bottom, `top to bottom: ${JSON.stringify(s)}`);
    assert(s.connect.text === 'Connect your agent' && s.connect.href === '#/settings/mcp' && !s.connect.cls.includes('primary'), JSON.stringify(s.connect));
    assert(s.own.text.startsWith('Add video') && s.own.cls.includes('ghost'), `adding a video yourself, quieter: ${JSON.stringify(s.own)}`);
    assert(s.copy.width === s.connect.width, `the copy and Connect your agent as wide as each other: ${s.copy.width} / ${s.connect.width}`);
    for (const part of [s.copy, s.line, s.connect, s.own]) assert(Math.abs(part.mid - s.center) <= 1, `centred: ${JSON.stringify(part)} vs ${s.center}`);
    assert(s.line.text.includes('and other agents'), `the agents it is for: ${s.line.text}`);
    assert((await p.$$('.empty-library .agent-line-marks svg')).length === 3, 'the makers’ marks, each once');
    assert(s.tips.includes('Drop video files anywhere on this page'), 'the quietest line stays');
    await p.browserContext().close();
  });

  await check('every width and both themes: it fits, nothing cut, the same order (390, 768, 1024, 1440, 1920)', async () => {
    const out = [];
    for (const theme of ['light', 'dark'])
      for (const width of WIDTHS) {
        const mobile = width < 600;
        const p = await fresh(local, { width, height: mobile ? 844 : 900, theme, mobile });
        await open(p, local);
        await p.waitForSelector('.empty-library [data-testid=agent-line]', { timeout: 15000 });
        await settle(p, { quiet: 300 });
        const s = await stack(p);
        if (!(s.line.top >= s.copy.bottom && s.connect.top >= s.line.bottom && s.own.top >= s.connect.bottom))
          out.push(`${width} ${theme}: order ${JSON.stringify(s)}`);
        if (s.copy.bottom > (mobile ? 844 : 900)) out.push(`${width} ${theme}: the copy is below the fold (${s.copy.bottom})`);
        for (const b of [...(await sideways(p)), ...(await clippedText(p)), ...(await cutLabels(p))]) out.push(`${width} ${theme}: ${b}`);
        await shot(p, `empty-${width}-${theme}`);
        await p.browserContext().close();
      }
    assert(!out.length, out.join('\n        '));
  });

  await check('German, an empty library: the copy’s words fit its button at 390 and 1440, nothing cut', async () => {
    for (const [width, theme] of [
      [390, 'dark'],
      [1440, 'light'],
    ]) {
      const mobile = width < 600;
      const p = await fresh(hosted, { width, height: mobile ? 844 : 900, lang: 'de', mobile, theme });
      await open(p, hosted);
      await p.waitForSelector('.empty-library [data-testid=agent-line][data-state=ready]', { timeout: 15000 });
      const s = await stack(p);
      assert(s.copy.text === 'Prompt für deinen Agenten kopieren' && s.connect.text === 'Verbinde deinen Agenten', JSON.stringify(s));
      assert(s.copy.width === s.connect.width, `as wide as each other: ${s.copy.width} / ${s.connect.width}`);
      const bad = [...(await overflowing(p)), ...(await sideways(p)), ...(await clippedText(p)), ...(await cutLabels(p))];
      assert(!bad.length, `${width}: ${bad.join('\n')}`);
      await shot(p, `empty-${width}-${theme}-de`);
      await p.browserContext().close();
    }
  });

  let localPrompt = '';
  await check('Copy puts the prompt on the clipboard (the machine: this app, nothing to sign in, no token); the line waits for the agent', async () => {
    const p = await fresh(local);
    await open(p, local);
    await p.waitForSelector('.empty-library [data-testid=agent-line][data-state=ready]', { timeout: 15000 });
    const before = await stack(p);
    /** The buttons stand where they stood, as wide as they were, whatever the line says. */
    const still = (now, when) => {
      for (const k of ['copy', 'connect', 'own'])
        assert(
          now[k].top === before[k].top && now[k].left === before[k].left && now[k].width === before[k].width,
          `${when}: ${k} moved ${JSON.stringify([before[k], now[k]])}`,
        );
    };
    await p.click('[data-testid=make-with-agent]');
    await p.waitForSelector('[data-testid=agent-line][data-state=waiting]', { timeout: 5000 });
    localPrompt = await clip(p);
    assert(localPrompt.startsWith('Set up Lampo with me'), localPrompt);
    assert(localPrompt.includes(`claude mcp add --transport http --scope user lampo ${local.base}/mcp`), `Claude Code's command: ${localPrompt}`);
    assert(localPrompt.includes(`url = "${local.base}/mcp"`) && localPrompt.includes('tool_timeout_sec = 330'), 'Codex');
    assert(/bin\/lampo-mcp/.test(localPrompt), 'Claude’s desktop app starts the server on the machine');
    assert(!/Bearer|token|Authenticate|codex mcp login/i.test(localPrompt), `nothing to sign in, no token: ${localPrompt}`);
    const s = await stack(p);
    assert(s.line.text.startsWith('Waiting for your agent…') && s.line.text.includes('paste the prompt into it'), s.line.text);
    assert(s.copy.text === 'Copy prompt for your agent', 'its words stay');
    still(s, 'copied');
    assert((await p.$eval('[data-testid=make-with-agent]', (e) => e.hasAttribute('data-copied'))) === true, 'its glyph says Copied for a moment');
    await shot(p, 'copied-1440-light');

    // what `lampo watch` says every 30 s, or an MCP client connecting: the line names it, the button keeps its words
    await localApi('/api/agents/heartbeat', 'POST', { session_id: 'e2e-start', name: 'spot-edit', kind: 'claude-code' });
    await p.waitForFunction(() => document.querySelector('[data-testid=agent-line]')?.dataset.state === 'listening', { timeout: 15000 });
    const c = await stack(p);
    assert(c.line.text === 'Claude Code connected · waiting for your notes', c.line.text);
    assert(c.copy.text === 'Copy prompt for your agent' && c.connect, `nothing changes under the person: ${JSON.stringify(c)}`);
    still(c, 'connected');
    await shot(p, 'connected-1440-light');

    // its V1 arrives: the empty page gives way to the library
    const clipFile = makeVideo(path.join(local.dir, 'Spring launch/export/v1.mp4'), { w: 320, h: 180, fps: 25, dur: 1 });
    await localApi('/api/library', 'POST', { path: clipFile });
    await p.waitForFunction(() => !document.querySelector('.empty-library') && document.querySelector('[data-testid=library-content] .film'), {
      timeout: 20000,
    });
    await shot(p, 'v1-1440-light');
    await p.browserContext().close();
  });

  await check(
    'a hosted server: its /mcp, the person signs in, never a token; a real MCP client turns the line to connected, then waiting for notes',
    async () => {
      const p = await fresh(hosted, { theme: 'dark' });
      await open(p, hosted);
      await p.waitForSelector('.empty-library [data-testid=agent-line][data-state=ready]', { timeout: 15000 });
      const s = await stack(p);
      assert(s.own.text.startsWith('Upload video'), `uploads there: ${s.own.text}`);
      await p.click('[data-testid=make-with-agent]');
      await p.waitForSelector('[data-testid=agent-line][data-state=waiting]', { timeout: 5000 });
      const prompt = await clip(p);
      assert(prompt.includes(`claude mcp add --transport http --scope user lampo ${hosted.base}/mcp`), prompt);
      assert(prompt.includes('/mcp → lampo → Authenticate') && prompt.includes('codex mcp login lampo'), 'the person signs in');
      assert(prompt.includes('reach only https addresses'), 'plain http: the chat apps can’t reach it');
      assert(!/Bearer|LAMPO_TOKEN|vr_|lampo-mcp/.test(prompt), `no token, nothing of a machine: ${prompt}`);
      await shot(p, 'hosted-copied-1440-dark');

      const tok = (await mia('/api/auth/tokens', 'POST', { name: 'claude code' })).token;
      agent = new Client({ name: 'claude-code', version: '2.1.0' }, { versionNegotiation: { mode: 'auto' } });
      await agent.connect(new StreamableHTTPClientTransport(new URL(`${hosted.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tok}` } } }));
      await agent.listTools();
      await p.waitForFunction(() => document.querySelector('[data-testid=agent-line]')?.dataset.state === 'idle', { timeout: 20000 });
      assert((await stack(p)).line.text === 'Claude Code connected · it asks how you want to start', (await stack(p)).line.text);
      await shot(p, 'hosted-connected-1440-dark');
      const waiting = agent.callTool({ name: 'wait_for_feedback', arguments: { timeout_s: 60 } }, undefined, { timeout: 120_000 }).catch(() => null);
      await p.waitForFunction(() => document.querySelector('[data-testid=agent-line]')?.dataset.state === 'listening', { timeout: 20000 });
      assert((await stack(p)).line.text === 'Claude Code connected · waiting for your notes', (await stack(p)).line.text);
      await shot(p, 'hosted-listening-1440-dark');
      await agent.close().catch(() => {});
      agent = null;
      await waiting;
      await p.browserContext().close();
    },
  );

  await check('German at 390: the copy’s words fit, nothing cut', async () => {
    const p = await fresh(local, { width: 390, height: 844, lang: 'de', mobile: true, theme: 'dark' });
    // a store with a video now: a project of its own, empty, shows the same way in
    await localApi('/api/folders', 'POST', { path: 'Herbst' });
    await open(p, local, `#/folder/${encodeURIComponent('Herbst')}`);
    await p.waitForSelector('.empty-state [data-testid=agent-line]', { timeout: 15000 });
    const s = await stack(p, '.lib-content > .empty-state');
    // (the heartbeat's agent may still count as connected: then it is asked by name)
    assert(['Claude Code eins machen lassen', 'Prompt für deinen Agenten kopieren'].includes(s.copy.text), s.copy.text);
    const bad = [...(await sideways(p)), ...(await clippedText(p)), ...(await cutLabels(p))];
    assert(!bad.length, bad.join('\n'));
    await shot(p, 'project-390-dark-de');
    await p.browserContext().close();
  });

  await check('Connect an agent leads with the same copy: the prompt to read is the one copied, then the steps by hand', async () => {
    const p = await fresh(local);
    await open(p, local, '#/settings/mcp');
    await p.waitForSelector('[data-testid=agent-prompt] [data-testid=agent-prompt-copy]', { timeout: 15000 });
    const order = await p.evaluate(() => {
      const top = (s) => document.querySelector(s)?.getBoundingClientRect().top ?? -1;
      return { prompt: top('[data-testid=agent-prompt]'), or: top('.set-or'), step1: top('.set-card .set-step-n') };
    });
    assert(order.prompt > 0 && order.or > order.prompt && order.step1 > order.or, JSON.stringify(order));
    await p.click('[data-testid=agent-prompt-copy]');
    await p.waitForSelector('[data-testid=agent-prompt-line]', { timeout: 5000 });
    const copied = await clip(p);
    await p.click('[data-testid=agent-prompt-see]');
    const shown = await p.$eval('[data-testid=agent-prompt-text] pre', (e) => e.textContent);
    assert(shown === copied, 'what it shows is what it copies');
    assert(copied === localPrompt, 'the same prompt as the empty library’s');
    await shot(p, 'settings-1440-light');
    await p.browserContext().close();
  });

  await check('Get started’s agent step: the copy first, its line, then the agents to pick by hand', async () => {
    const p = await fresh(gs);
    await open(p, gs);
    await p.waitForSelector('[data-testid=ob-gs] [data-testid=ob-step][data-step=agent]', { timeout: 15000 });
    await p.click('.ob-gs-list [data-testid=ob-step][data-step=agent]');
    await p.waitForFunction(() => document.querySelector('[data-testid=ob-pane]')?.dataset.pane === 'agent', { timeout: 5000 });
    await settle(p, { quiet: 300 });
    const order = await p.evaluate(() => {
      const on = document.querySelector('[data-testid=ob-pane] .ob-gs-slot.ob-on');
      const top = (s) => on.querySelector(s)?.getBoundingClientRect().top ?? -1;
      return { copy: top('[data-testid=ob-copy-prompt]'), line: top('[data-testid=ob-agent-line]'), picks: top('.ob-picks') };
    });
    assert(order.copy > 0 && order.line > order.copy && order.picks > order.line, JSON.stringify(order));
    await shot(p, 'getstarted-agent-1440-light');
    await p.browserContext().close();
  });

  await check('no errors in the page', async () => {
    assert(!errors.length, errors.join('\n'));
  });
} catch (e) {
  crashed(e, ...servers);
} finally {
  await agent?.close().catch(() => {});
}
await finish(LABEL, { browser, servers });
