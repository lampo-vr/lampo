#!/usr/bin/env node
// covers: web/src/sessions/runState.ts web/src/sessions/RunLine.tsx web/src/sessions/runWords.ts web/src/player/ClaudeMenu.tsx web/src/player/RunStrip.tsx web/src/player/AgentView.tsx web/src/player/Player.tsx web/src/api/runs.ts web/src/api/live.ts lib/runPlan.ts lib/runCard.ts lib/runs.ts server/runs.ts
// How far an agent is reads the same everywhere, and moves live: on a hosted server, in a workspace other than the
// first, the person sends five notes to their chat app's agent (an MCP client named claude-ai, with their token). It
// reads every note before it fixes any (Claude does: each one is "in hand" then) and marks them fixed one by one.
// The library's board card in one tab, the player's agent button, run strip and Agent view in another, all say the
// same "fixing n of 5" at every step without a reload — and so does one tab that goes from the library to the player
// and back between two steps. The count is the note it is on: one more than the notes answered, never one per note
// it holds.
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { age, makeVideo, until } from '../lib/helpers.ts';
import { client, tusUpload } from '../lib/http.ts';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, signedIn } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'run-progress e2e';
requireChrome(LABEL);
const PW = ['a', 'long', 'enough', 'password'].join(' ');
const enc = encodeURIComponent;

const servers = [];
let browser;
let agent = null;
let library = null;
screenshotFailures(() => library, 'run-progress');
try {
  const srv = await startServer({ prefix: 'vr-run-progress-e2e-', mode: 'server', publicUrl: true });
  servers.push(srv);
  const BASE = srv.base;
  const request = client(srv.port);
  const origin = { Origin: BASE };
  const cookieOf = (r) => String([r.headers['set-cookie']].flat().find((c) => String(c).startsWith('vr_session=')) || '').split(';')[0];
  const setup = await request('POST', '/api/auth/setup', {
    body: { token: await srv.setupToken(), email: 'mia@e2e.test', name: 'Mia Lang', password: PW },
    headers: origin,
  });
  assert(setup.status === 200, setup.text);
  // a second workspace: an agent's writes through /mcp reach the page by the event feed alone there
  const made = await request('POST', '/api/workspaces', { body: { name: 'Studio' }, headers: { Cookie: cookieOf(setup), ...origin } });
  assert(made.status === 200 && made.json().workspace.id !== 'w1', made.text);
  const cookie = cookieOf(made);
  const headers = { Cookie: cookie, ...origin };
  const api = (p, method, body) => jsonApi(BASE)(p, method, body, headers);

  const file = makeVideo(path.join(srv.dir, 'renders/teaser.mp4'), { w: 320, h: 180, fps: 25, dur: 4, pattern: 'testsrc2' });
  age(file);
  const up = await tusUpload(request, file, { filename: 'teaser.mp4', folder: 'Spring' }, headers);
  assert(up.status === 200, up.text);
  const slug = up.json().slug;

  // The chat app's agent connects with Mia's token, as Claude names itself, and is assigned to the video
  const token = (await api('/api/auth/tokens', 'POST', { name: 'chat app' })).token;
  agent = new Client({ name: 'claude-ai', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await agent.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const call = async (name, args) => {
    const r = await agent.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
    const text = r.content.map((c) => c.text ?? '').join('\n');
    assert(!r.isError, `${name}: ${text}`);
    return text;
  };
  await call('list_videos', {});
  const me = await until(async () => (await api('/api/agents')).agents.find((a) => a.name.startsWith('claude-ai')), 'the agent is listed');
  await api(`/api/review/${enc(slug)}/session`, 'PUT', { name: me.name, sessionId: me.session_id, agent: me.kind });

  // Five notes, sent together: the agent's work on the video opens with them as its plan
  const notes = [];
  for (const [frame, text] of [
    [8, 'Typo in the title'],
    [22, 'Caption too low'],
    [38, 'Logo enters late'],
    [50, 'Music too loud here'],
    [78, 'Warmer grade'],
  ])
    notes.push((await api(`/api/review/${enc(slug)}/drafts`, 'POST', { v: 1, frame, text, severity: 'must' })).id);
  const sent = (await api(`/api/review/${enc(slug)}/drafts/send`, 'POST', {})).notes.map((c) => c.id);
  assert(sent.length === 5, `five notes sent: ${sent}`);
  const runOf = async () => (await api(`/api/runs?slug=${enc(slug)}`)).runs[0];
  const run = await until(runOf, 'the send opened the agent’s work');
  const planIds = run.plan.map((p) => p.id);
  assert(planIds.length === 5 && sent.every((id) => planIds.includes(id)), `the five sent notes are its plan: ${JSON.stringify(run.plan)}`);

  browser = await launch();
  const errors = [];
  const tab = async (hash) => {
    const p = await browser.newPage();
    await p.setViewport({ width: 1440, height: 900 });
    await p.setCookie({ name: 'vr_session', value: cookie.split('=').slice(1).join('='), url: BASE });
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
    return p;
  };
  // the library's board (where the card's line says who and how far) in one tab, the player with its Agent view open
  // in another, as a person keeps them side by side
  library = await tab('#/status');
  await signedIn(library);
  await library.waitForSelector(`.bcard[data-slug="${slug}"]`, { timeout: 20000 });
  const player = await tab(`#/v/${enc(slug)}?agent=1`);
  // who is looking is known: the team's agent button (role-gated)
  await player.waitForSelector('[data-testid=agent-button]', { timeout: 20000 });
  await player.waitForSelector('[data-testid=run-strip]:not(.pending)', { timeout: 20000 });

  /** "fixing 3 of 5" (or "wrapping up · 5 of 5 done") out of a line, or what the line says when it has no count. */
  const countIn = (s) => (s == null ? null : (/(fixing \d+ of \d+|wrapping up · \d+ of \d+ done)/.exec(s)?.[1] ?? `“${s}”`));
  const cardSays = (p) => p.$eval(`.bcard[data-slug="${slug}"] [data-testid=run-line]`, (e) => e.textContent).catch(() => null);
  const playerSays = (p) =>
    p.evaluate(() => ({
      button: document.querySelector('[data-testid=agent-step]')?.textContent ?? null,
      strip: document.querySelector('[data-testid=run-strip] [data-testid=run-words]')?.textContent ?? null,
      view: document.querySelector('[data-testid=agent-view] .av-count')?.textContent ?? null,
      plan: [...document.querySelectorAll('[data-testid=agent-plan] li')].map((li) => li.dataset.state).join(' '),
    }));
  /**
   * Every place says `want` once the player has the plan as it is (`fixed` notes fixed, the rest in hand) — what it
   * says then is its answer, never a line from before the step — live, without a reload. The Agent view says the
   * count alone ("3 of 5").
   */
  const allSay = async (want, fixed, { card = library, play = player } = {}) => {
    const n = /(\d+ of \d+)/.exec(want)?.[1];
    const plan = planIds.map((_, i) => (i < fixed ? 'fixed' : 'doing')).join(' ');
    let last = null;
    await until(
      async () => {
        const [c, p] = await Promise.all([card ? cardSays(card) : null, play ? playerSays(play) : null]);
        last = play ? { card: card ? countIn(c) : '-', button: countIn(p.button), strip: countIn(p.strip), view: p.view, plan: p.plan } : { card: countIn(c) };
        return (!card || last.card === want) && (!play || (last.plan === plan && last.button === want && last.strip === want && last.view === n));
      },
      () => `every place says “${want}”, without a reload: ${JSON.stringify(last)}`,
      15_000,
    );
  };

  await check('it reads all five notes before fixing any: the card, the agent button, the strip and the Agent view say “fixing 1 of 5”', async () => {
    await call('get_open_notes', { video: slug });
    for (const id of planIds) await call('get_note', { id });
    await until(async () => (await runOf()).plan.every((p) => p.state === 'doing'), 'all five in hand');
    await allSay('fixing 1 of 5', 0);
  });

  await check('each note marked fixed moves every place to the same next count, live', async () => {
    for (const [i, id] of planIds.slice(0, 2).entries()) {
      await call('mark_fixed', { id, note: `fixed ${i + 1}` });
      await allSay(`fixing ${i + 2} of 5`, i + 1);
    }
  });

  await check('one tab from the library to the player and back says the same count as the other tab at every step', async () => {
    // the card's line opens the video at the Agent view
    await library.click(`.bcard[data-slug="${slug}"] .bcard-line [data-testid=run-line]`);
    await library.waitForSelector('[data-testid=agent-view] .av-count', { timeout: 20000 });
    await allSay('fixing 3 of 5', 2, { card: null, play: library });
    await call('mark_fixed', { id: planIds[2], note: 'fixed 3' });
    // the player in both tabs, then this one back to the library
    await allSay('fixing 4 of 5', 3, { card: null, play: library });
    await allSay('fixing 4 of 5', 3, { card: null });
    await library.goBack();
    await library.waitForSelector(`.bcard[data-slug="${slug}"] [data-testid=run-line]`, { timeout: 20000 });
    await allSay('fixing 4 of 5', 3);
    await call('mark_fixed', { id: planIds[3], note: 'fixed 4' });
    await allSay('fixing 5 of 5', 4);
  });

  await check('the last one fixed: every place says it is wrapping up, 5 of 5 done', async () => {
    await call('mark_fixed', { id: planIds[4], note: 'fixed 5' });
    await allSay('wrapping up · 5 of 5 done', 5);
  });

  await check('no page errors', async () => {
    assert(!errors.length, errors.join('\n'));
  });
} catch (e) {
  crashed(e, ...servers);
}
await agent?.close().catch(() => {});
await finish(LABEL, { browser, servers });
