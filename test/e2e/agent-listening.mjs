#!/usr/bin/env node
// covers: web/src/sessions/listening.tsx web/src/player/RunStrip.tsx web/src/player/CommentCard.tsx web/src/player/ClaudeMenu.tsx web/src/player/AgentMenuBody.tsx web/src/sessions/Live.tsx web/src/sessions/runWords.ts server/agents.ts mcp/toolkit.ts lib/handoff.ts
// When the agent stops listening while something waits on it, Lampo says so: a hosted server, a chat app's agent
// (an MCP client named claude-ai, "Claude") with the person's token puts up V1 itself, waits, gets the person's note,
// replies with a question — and, as a chat app asking in its chat would, never waits again. Its moment to start waiting
// passes (45 s: the suite waits that once), the person answers, and the agent's line and the agent menu say "Claude
// stopped listening", calmly, with Copy "go on" as their one action and the folded line saying where to tell it — once
// per view: the note it owes doesn't repeat it. Told "go on", it waits again: the line goes by itself, live. At 1440 in
// both themes and at 390. Screenshots land in VR_SHOTS.
import fs from 'node:fs';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { age, makeVideo, until } from '../lib/helpers.ts';
import { clippedText, settle, sideways } from './layout.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'agent-listening e2e';
requireChrome(LABEL);
const PW = ['a', 'long', 'enough', 'password'].join(' ');
const SHOTS = shotsDir();
const SAYS = 'Claude stopped listening';
const FOLD = 'Tell it “go on” in Claude: your notes are waiting for it.';

const servers = [];
let browser;
let page = null;
let agent = null;
screenshotFailures(() => page, 'agent-listening');
try {
  const srv = await startServer({ prefix: 'vr-agent-listening-e2e-', mode: 'server', publicUrl: true });
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
  await mia('/api/folders', 'POST', { path: 'Spring launch' });

  // A chat app's agent connects with Mia's token, as Claude names itself
  const tok = (await mia('/api/auth/tokens', 'POST', { name: 'chat app' })).token;
  agent = new Client({ name: 'claude-ai', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await agent.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tok}` } } }));
  await agent.listTools();
  const call = async (name, args) => {
    const r = await agent.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
    const text = r.content.map((c) => c.text ?? '').join('\n');
    assert(!r.isError, `${name}: ${text}`);
    return text;
  };

  // …puts up V1 itself: an upload URL, one PUT (the new video is its own)
  const film = makeVideo(path.join(srv.dir, 'render/teaser.mp4'), { w: 320, h: 180, fps: 25, dur: 2, pattern: 'testsrc2' });
  age(film);
  const url = /https?:\/\/\S+\/api\/uploads\/direct\/\S+/.exec(await call('request_upload', { filename: 'teaser.mp4', folder: 'Spring launch' }))?.[0];
  assert(url, 'an upload URL');
  const put = await fetch(url, { method: 'PUT', body: fs.readFileSync(film) });
  const up = await put.json();
  assert(put.ok && up.slug, `PUT: ${put.status} ${JSON.stringify(up)}`);
  const slug = up.slug;

  // …waits; Mia's note comes; it replies with a question, and (as a chat app asking in its chat) stops
  const waiting = call('wait_for_feedback', { since: up.cursor, timeout_s: 60 });
  const note = await mia(`/api/review/${encodeURIComponent(slug)}/comments`, 'POST', { frame: 10, text: 'Too dark in the first second', severity: 'must' });
  const noteId = note.comment?.id ?? note.id;
  assert((await waiting).includes(noteId), 'the wait hands the note over');
  const asked = await call('reply', { id: noteId, note: 'Leave it as it is, or brighten it?' });
  const cursor = /since "(\S+)"/.exec(asked)?.[1];
  assert(cursor && /\nNow call wait_for_feedback with since /.test(asked), `the reply says to wait now: ${asked}`);
  // Mia answers in Lampo; its moment to start waiting passes (server/agents.ts LISTEN_TIMES.graceMs, 45 s), and the
  // app's word for it turns: not listening
  await mia(`/api/comments/${noteId}`, 'PATCH', { note: 'Brighten it a little' });
  const stateOf = async () => (await mia('/api/agents')).agents.find((a) => a.name.startsWith('claude-ai'))?.state;
  assert((await stateOf()) === 'working', 'a moment to start waiting first');
  await until(async () => (await stateOf()) === 'idle', 'not listening once its moment passed', 75_000);

  browser = await launch();
  const errors = [];
  const fresh = async ({ width = 1440, theme = 'light' } = {}) => {
    const ctx = await browser.createBrowserContext();
    await ctx.overridePermissions(BASE, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
    const p = await ctx.newPage();
    const mobile = width < 600;
    await p.setViewport({ width, height: mobile ? 844 : 900, ...(mobile ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
    await p.setCookie({ name: 'vr_session', value: cookie.split('=').slice(1).join('='), url: BASE });
    await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
    p.on('pageerror', (e) => errors.push(e.message));
    page = p;
    await p.goto(`${BASE}/#/v/${encodeURIComponent(slug)}`, { waitUntil: 'domcontentloaded' });
    // who is looking is known (the controls follow the role): the agent's line, and the team's agent button
    await p.waitForSelector('[data-testid=run-strip]:not(.pending)', { timeout: 20000 });
    await p.waitForSelector('[data-testid=agent-button]', { timeout: 20000 });
    return p;
  };
  const strip = (p) =>
    p.$eval('[data-testid=run-strip]', (e) => ({
      phase: e.dataset.phase,
      words: e.querySelector('[data-testid=run-words]')?.textContent,
      fold: e.querySelector('[data-testid=run-fold]')?.textContent,
      quiet: !!e.querySelector('.al-mark.quiet'),
      live: !!e.querySelector('.run-kg'),
      acts: [...e.querySelectorAll('.run-act')].map((b) => b.dataset.testid),
      raised: e.querySelectorAll('.btn.primary').length,
      copy: e.querySelector('[data-testid=run-go_on]')?.textContent.trim() ?? null,
    }));
  const shot = async (p, name) => SHOTS && p.screenshot({ path: path.join(SHOTS, `agent-listening-${name}.png`) });

  for (const [width, theme] of [
    [1440, 'light'],
    [1440, 'dark'],
    [390, 'light'],
  ])
    await check(
      `it asked and stopped, the person answered: the line says it stopped listening, calmly, once, Copy “go on” its action — ${width}, ${theme}`,
      async () => {
        const p = await fresh({ width, theme });
        await p.waitForSelector('[data-testid=run-strip][data-phase=not_listening]', { timeout: 20000 });
        await settle(p, { quiet: 300 });
        const s = await strip(p);
        assert(s.words === SAYS && s.fold === FOLD, JSON.stringify(s));
        // calm: the agent's mark a step quieter, no turning keyframe, one action and nothing raised
        assert(s.quiet && !s.live && s.acts.join() === 'run-go_on' && s.raised === 0 && s.copy === 'Copy “go on”', JSON.stringify(s));
        // said once in the view: the line is in view wherever the notes are, so the note it owes doesn't repeat it
        const said = await p.$$eval('[data-testid=run-words], .note', (es) => es.filter((e) => /stopped listening|isn’t listening/.test(e.textContent)).length);
        assert(said === 1 && !/listening/.test(await p.$eval(`[data-note="${noteId}"]`, (e) => e.textContent)), `said ${said} times`);
        const wide = await sideways(p);
        assert(!wide.length, `sideways: ${JSON.stringify(wide)}`);
        const clipped = (await clippedText(p)).filter((c) => /run-|al-/.test(c));
        assert(!clipped.length, `clipped: ${JSON.stringify(clipped)}`);
        await shot(p, `${width}-${theme}`);
        // "go on" to copy, from the line
        await p.click('[data-testid=run-go_on]');
        await p.waitForFunction(() => navigator.clipboard.readText().then((x) => x === 'go on'), { timeout: 5000 });
        await p.browserContext().close();
      },
    );

  await check('the agent button and menu say the same, and its last “Waiting for your answer” is no longer said as going on', async () => {
    const p = await fresh();
    await p.waitForSelector('[data-testid=run-strip][data-phase=not_listening]', { timeout: 20000 });
    // the button in the top bar: its word, no turning keyframe (whatever its work said last is not going on)
    const button = await p.$eval('[data-testid=agent-button]', (e) => ({
      step: e.querySelector('[data-testid=agent-step]')?.textContent,
      live: !!e.querySelector('.kg.live, .run-kg.live'),
    }));
    assert(button.step === 'not listening' && !button.live, JSON.stringify(button));
    await p.click('[data-testid=agent-button]');
    await p.waitForSelector('[data-testid=agent-menu][data-now=stalled]', { timeout: 5000 });
    // what it did comes after the menu opens (asked for only then): the sub line and its steps
    await until(
      async () => /^last heard/.test(await p.$eval('[data-testid=agent-now]', (e) => e.textContent).catch(() => '')),
      'the sub line says when it was last heard',
    );
    const m = await p.$eval('[data-testid=agent-menu]', (e) => ({
      line: e.querySelector('[data-testid=agent-sentence]')?.textContent.trim(),
      act: [...e.querySelectorAll('.amc-act .btn')].map((b) => `${b.dataset.testid}:${/\bprimary\b/.test(b.className)}`),
      start: !!e.querySelector('[data-testid=listen-how], [data-testid=agent-start]'),
      now: e.querySelector('[data-testid=agent-now]')?.textContent ?? '',
      first: e.querySelector('[data-testid=agent-timeline] li')?.textContent ?? '',
    }));
    assert(m.line === SAYS && m.act.join() === 'agent-go-on:true' && !m.start, JSON.stringify(m));
    assert(/^last heard/.test(m.now) && !/\bsince\b/.test(`${m.now} ${m.first}`), `not said as going on: ${JSON.stringify(m)}`);
    await shot(p, 'menu-1440-light');
    await p.browserContext().close();
  });

  await check('told “go on”, it waits again: the line goes by itself, live (no reload)', async () => {
    const p = await fresh();
    await p.waitForSelector('[data-testid=run-strip][data-phase=not_listening]', { timeout: 20000 });
    // it waits with the cursor its reply gave: Mia's answer comes at once, and it is on it
    const again = await call('wait_for_feedback', { since: cursor, timeout_s: 30 });
    assert(again.includes(noteId), `the answer reaches it: ${again}`);
    await p.waitForFunction(() => document.querySelector('[data-testid=run-strip]')?.dataset.phase !== 'not_listening', { timeout: 15000 });
    await shot(p, 'listening-again-1440-light');
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
