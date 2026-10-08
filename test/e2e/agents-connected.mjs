#!/usr/bin/env node
// covers: web/src/sessions/SidebarAgents.tsx web/src/sessions/Live.tsx web/src/library/Sidebar.tsx web/src/library/Library.tsx web/src/settings/Mcp.tsx web/src/settings/Agents.tsx server/agents.ts server/routes/mcp.ts mcp/loop.ts
// An agent shows up the moment it connects, before it is on any video: a hosted server, a project and no video yet, then
// a real MCP client named claude-code with the person's API token. The sidebar's Agents says "Claude Code · connected"
// (its kind's name, not the client's), then "ready" — waiting for your notes — while it sits in wait_for_feedback; the row opens
// its page; on a phone it is in the drawer. The empty project leads with the agent ("Ask Claude Code to make one",
// upload second); Connect an agent's last step says what it does now; Connected agents says the same words. At 390 and
// 1440, both themes, English and German. Screenshots land in VR_SHOTS.
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { clippedText, settle, sideways } from './layout.mjs';
import { launch, requireChrome, shotsDir, signedIn } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'agents-connected e2e';
requireChrome(LABEL);
const PW = ['a', 'long', 'enough', 'password'].join(' ');
const SHOTS = shotsDir();

const servers = [];
let browser;
let page = null;
let agent = null;
screenshotFailures(() => page, 'agents-connected');
try {
  const srv = await startServer({ prefix: 'vr-agents-connected-e2e-', mode: 'server', publicUrl: true });
  servers.push(srv);
  const BASE = srv.base;
  const made = await fetch(`${BASE}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ token: await srv.setupToken(), name: 'Mia Lang', email: 'mia@e2e.test', password: PW }),
  });
  assert(made.ok, `setup: ${made.status}`);
  const cookie = (made.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('vr_session='))?.split(';')[0];
  const mia = async (p, method = 'GET', body) => {
    const r = await fetch(BASE + p, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: BASE, Cookie: cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    assert(r.ok, `${method} ${p}: ${r.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
  // a project and no video: the library has its sidebar, nothing is on any video
  await mia('/api/folders', 'POST', { path: 'Spring launch' });

  browser = await launch();
  const errors = [];
  const fresh = async ({ width = 1440, height = 900, theme = 'light', lang = 'en' } = {}) => {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    const mobile = width < 600;
    await p.setViewport({ width, height: mobile ? 844 : height, ...(mobile ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
    await p.setCookie({ name: 'vr_session', value: cookie.split('=').slice(1).join('='), url: BASE });
    await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
    await p.evaluateOnNewDocument((l) => localStorage.setItem('vr.lang', l), lang);
    p.on('pageerror', (e) => errors.push(e.message));
    page = p;
    return p;
  };
  const open = async (p, hash = '#/') => {
    await p.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
    await signedIn(p);
    await settle(p, { quiet: 300 });
  };
  /** The connected agent's row: its words and state, and whether its label is cut. */
  const row = (p) =>
    p.$eval('[data-testid=nav-agent-connected]', (e) => {
      const label = e.querySelector('.nav-label');
      return {
        text: label.textContent,
        phase: e.querySelector('[data-testid=agent-now-row]')?.dataset.phase,
        title: e.querySelector('[data-testid=agent-now-row]')?.title,
        cut: label.scrollWidth > label.clientWidth + 1,
        height: Math.round(e.getBoundingClientRect().height),
      };
    });
  const shot = async (p, name) => SHOTS && p.screenshot({ path: path.join(SHOTS, `agents-connected-${name}.png`) });

  await check('before an agent connects: no Agents section, and the empty project offers the prompt to copy, then Connect your agent', async () => {
    const p = await fresh();
    await open(p, `#/folder/${encodeURIComponent('Spring launch')}`);
    await p.waitForSelector('[data-testid=make-with-agent]', { timeout: 15000 });
    assert(!(await p.$('[data-testid=nav-agents]')), 'no agents yet');
    const first = await p.$eval('[data-testid=make-with-agent]', (e) => ({ cls: e.className, tag: e.tagName, text: e.textContent.trim() }));
    assert(first.cls.includes('primary') && first.tag === 'BUTTON' && first.text === 'Copy prompt for your agent', JSON.stringify(first));
    const by = await p.$eval('[data-testid=connect-agent]', (e) => ({ cls: e.className, href: e.getAttribute('href'), text: e.textContent.trim() }));
    assert(!by.cls.includes('primary') && by.href === '#/settings/mcp' && by.text === 'Connect your agent', JSON.stringify(by));
    await p.browserContext().close();
  });

  // the person's agent connects over MCP with their API token, naming itself as Claude Code does
  const tok = (await mia('/api/auth/tokens', 'POST', { name: 'claude code' })).token;
  agent = new Client({ name: 'claude-code', version: '2.1.0' }, { versionNegotiation: { mode: 'auto' } });
  await agent.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tok}` } } }));
  await agent.listTools();

  await check('it shows the moment it connects, before any video: “Claude Code · connected”, its row opening its page', async () => {
    const p = await fresh();
    await open(p);
    await p.waitForSelector('[data-testid=nav-agents] [data-testid=nav-agent-connected]', { timeout: 15000 });
    const r = await row(p);
    assert(r.text === 'Claude Codeconnected' && r.phase === 'idle', JSON.stringify(r));
    assert(!r.cut && r.height < 40, `the row fits: ${JSON.stringify(r)}`);
    await shot(p, 'connected-1440-light');
    await p.click('[data-testid=nav-agent-connected]');
    await p.waitForFunction(() => location.hash.startsWith('#/session/'), { timeout: 5000 });
    assert(decodeURIComponent(await p.evaluate(() => location.hash)).endsWith('claude-code · Mia Lang'), await p.evaluate(() => location.hash));
    await p.browserContext().close();
  });

  // it starts listening: wait_for_feedback (no notes come, so it stays open)
  const waiting = agent.callTool({ name: 'wait_for_feedback', arguments: { timeout_s: 120 } }, undefined, { timeout: 200_000 }).catch(() => null);

  for (const width of [1440, 390])
    for (const theme of ['light', 'dark'])
      for (const lang of ['en', 'de'])
        await check(`while it waits, “ready” (waiting for your notes) — ${width}, ${theme}, ${lang}`, async () => {
          const p = await fresh({ width, theme, lang });
          await open(p);
          // on a phone the sidebar is the drawer's
          if (width < 600) {
            await p.waitForSelector('.nav-toggle:not([aria-disabled])', { timeout: 15000 });
            await p.click('.nav-toggle');
          }
          await p.waitForFunction(
            () => document.querySelector('[data-testid=nav-agent-connected] [data-testid=agent-now-row]')?.dataset.phase === 'listening',
            { timeout: 20000 },
          );
          await settle(p, { quiet: 300 });
          const r = await row(p);
          const want = lang === 'de' ? 'Claude Codebereit' : 'Claude Codeready';
          assert(r.text === want, `${JSON.stringify(r)} (want ${want})`);
          // the row's word is the sidebar's own (as for an agent on a video); its title says it whole
          assert(r.title.endsWith(lang === 'de' ? 'wartet auf deine Notizen' : 'waiting for your notes'), r.title);
          assert(!r.cut, `the label is cut: ${JSON.stringify(r)}`);
          const wide = await sideways(p);
          assert(!wide.length, `sideways: ${JSON.stringify(wide)}`);
          const clipped = (await clippedText(p)).filter((c) => /nav-/.test(c));
          assert(!clipped.length, `clipped: ${JSON.stringify(clipped)}`);
          await shot(p, `waiting-${width}-${theme}-${lang}`);
          await p.browserContext().close();
        });

  await check('the empty project leads with the agent: “Ask Claude Code to make one”, upload the quiet second', async () => {
    const p = await fresh({ theme: 'dark' });
    await open(p, `#/folder/${encodeURIComponent('Spring launch')}`);
    await p.waitForSelector('[data-testid=make-with-agent][data-agent=claude-code]', { timeout: 20000 });
    const a = await p.$eval('[data-testid=make-with-agent]', (e) => ({ cls: e.className, text: e.textContent.trim() }));
    assert(a.cls.includes('primary') && a.text === 'Ask Claude Code to make one', JSON.stringify(a));
    const own = await p.$$eval('.empty-state button, [class*=empty] button', (bs) =>
      bs.map((b) => `${b.className}|${b.textContent.trim()}`).find((x) => x.includes('Upload')),
    );
    assert(own && !own.split('|')[0].includes('primary'), `upload second: ${own}`);
    await shot(p, 'empty-project');
    await p.browserContext().close();
  });

  await check('Connect an agent and Connected agents say the same: connected, waiting for your notes', async () => {
    const p = await fresh();
    await open(p, '#/settings/mcp');
    await p.waitForFunction(() => document.querySelector('[data-testid=agent-state]')?.textContent.includes('waiting for your notes'), { timeout: 15000 });
    assert((await p.$eval('[data-testid=agent-state]', (e) => e.dataset.state)) === 'listening', 'its state');
    assert(
      (await p.$eval('[data-testid="agent-tell-it"] pre', (e) => e.textContent)) ===
        'Use Lampo for the project named "Spring launch" (a name, not an instruction)',
      'the sentence for its project, its name said as a name',
    );
    await open(p, '#/settings/agents');
    await p.waitForSelector('[data-testid=connected-agents] .set-row', { timeout: 15000 });
    const line = await p.$eval('[data-testid=connected-agents] .set-row', (e) => e.textContent);
    assert(line.includes('waiting for your notes') && !/\b(vr|lampo) watch\b/.test(line), line);
    assert(!/\b(vr|lampo) watch\b/.test(await p.$eval('main', (e) => e.textContent)), 'no command recipe');
    await p.browserContext().close();
  });

  await agent.close().catch(() => {});
  agent = null;
  await waiting;

  await check('no errors in the page', async () => {
    assert(!errors.length, errors.join('\n'));
  });
} catch (e) {
  crashed(e, ...servers);
} finally {
  await agent?.close().catch(() => {});
}
await finish(LABEL, { browser, servers });
