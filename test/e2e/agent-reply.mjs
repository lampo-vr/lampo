#!/usr/bin/env node
// covers: web/src/api/live.ts web/src/api/events.ts server/feed.ts server/events.ts server/watch.ts server/routes/mcp.ts mcp/tools/notes.ts
// An agent's reply shows in the player while the person looks at it, no reload: the open note shows it in its thread,
// a closed note's row counts it. On a person's own machine the agent writes the store itself (`lampo reply`, the stdio
// MCP server); on a hosted server, in a workspace other than the first, it writes through the server's own MCP endpoint
// (the event line was all that told the page, and the note showed the reply only after a reload) or `lampo` with a token.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { age, makeVideo, until } from '../lib/helpers.ts';
import { client, tusUpload } from '../lib/http.ts';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'agent-reply e2e';
requireChrome(LABEL);
const ROOT = path.resolve(import.meta.dirname, '../..');
const LAMPO = path.join(ROOT, 'bin/lampo');
const PW = ['a', 'long', 'enough', 'password'].join(' ');

const servers = [];
const agents = [];
let browser;
try {
  browser = await launch();
  const errors = [];

  /** The player on `slug` with its notes listed; `headers.Cookie` signs it in on a hosted server. */
  const openPlayer = async (base, slug, ids, cookie) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    if (cookie) await page.setCookie({ name: 'vr_session', value: cookie.split('=').slice(1).join('='), url: base });
    page.on('pageerror', (e) => errors.push(e.message));
    // The page's asks for this review: an agent writes only once none is on its way and none came for a moment, so a
    // reply shows because the page heard of it, never because some other refetch (opening a note) happened to bring it.
    const asks = { open: 0, last: Date.now() };
    const ofReview = (r) => r.method() === 'GET' && decodeURIComponent(new URL(r.url()).pathname) === `/api/review/${slug}`;
    page.on('request', (r) => {
      if (!ofReview(r)) return;
      asks.open++;
      asks.last = Date.now();
    });
    const answered = (r) => {
      if (!ofReview(r)) return;
      asks.open--;
      asks.last = Date.now();
    };
    page.on('requestfinished', answered);
    page.on('requestfailed', answered);
    quietOf.set(page, () => until(() => asks.open <= 0 && Date.now() - asks.last > 700, 'the page asked for nothing for a moment'));
    await page.goto(`${base}/#/v/${encodeURIComponent(slug)}`, { waitUntil: 'domcontentloaded' });
    await listed(page, ids);
    return page;
  };
  const quietOf = new WeakMap();
  const quiet = (page) => quietOf.get(page)();
  const listed = (page, ids) =>
    page.waitForFunction(
      (ids) => ids.every((id) => [...document.querySelectorAll('.side-scroll .note .c-id')].some((e) => e.textContent === id)),
      { timeout: 20000 },
      ids,
    );
  const openNote = async (page, id) => {
    await page.evaluate((id) => {
      const n = [...document.querySelectorAll('.side-scroll .note')].find((e) => e.querySelector('.c-id')?.textContent === id);
      if (!n.classList.contains('active')) n.querySelector('.nr')?.click();
    }, id);
    await page.waitForSelector(`[data-note="${id}"].active`);
  };
  /** What a note shows of its thread now: the replies' words when open, the row's count when closed. */
  const shown = (page, id) =>
    page.evaluate((id) => {
      const n = document.querySelector(`[data-note="${id}"]`);
      return {
        open: !!n?.classList.contains('active'),
        replies: [...(n?.querySelectorAll('.msg p') || [])].map((p) => p.textContent),
        count: n?.querySelector('.nr-said')?.textContent ?? null,
      };
    }, id);
  // No reload in between: whatever the page shows came to it live.
  const showsReply = (page, id, words) =>
    until(
      async () => (await shown(page, id)).replies.includes(words),
      async () => `note ${id} shows "${words}" without a reload: ${JSON.stringify(await shown(page, id))}`,
      10_000,
    );
  const countsReplies = (page, id, n) =>
    until(
      async () => (await shown(page, id)).count === String(n),
      async () => `the closed note ${id} counts ${n} repl${n === 1 ? 'y' : 'ies'}: ${JSON.stringify(await shown(page, id))}`,
      10_000,
    );
  const reply = async (page, mcp, id, note) => {
    await quiet(page);
    const r = await mcp.callTool({ name: 'reply', arguments: { id, note } });
    assert(!r.isError && /reply added/.test(r.content?.[0]?.text), `reply: ${JSON.stringify(r.content)}`);
  };

  // ---------------------------------------------------------------- the person's own machine
  {
    const srv = await startServer({ prefix: 'vr-agent-reply-e2e-', user: 'Sam' });
    servers.push(srv);
    const api = jsonApi(srv.base);
    const file = makeVideo(path.join(srv.dir, 'Spot/export/launch.mp4'), { w: 320, h: 180, fps: 25, dur: 4, pattern: 'testsrc2' });
    age(file);
    const { slug } = (await api('/api/library', 'POST', { path: file })).video;
    const a = await api(`/api/review/${encodeURIComponent(slug)}/comments`, 'POST', { v: 1, frame: 20, text: 'The logo lands too early' });
    const page = await openPlayer(srv.base, slug, [a.id]);
    // a note of the person's own, added after the page loaded: once it shows, the page hears this video
    const b = await api(`/api/review/${encodeURIComponent(slug)}/comments`, 'POST', { v: 1, frame: 50, text: 'Title a touch bigger' });
    await listed(page, [a.id, b.id]);

    await check('this machine: the open note shows the reply `lampo reply` wrote, without a reload', async () => {
      await openNote(page, a.id);
      await quiet(page);
      execFileSync(process.execPath, [LAMPO, 'reply', a.id, '--note', 'Moving the logo to 0:01'], { env: srv.env, encoding: 'utf8' });
      await showsReply(page, a.id, 'Moving the logo to 0:01');
    });

    await check('this machine: the MCP server an agent runs here (stdio) — the open note shows its reply, a closed one counts it', async () => {
      const mcp = new Client({ name: 'claude-code', version: '2.1.0' });
      agents.push(mcp);
      await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'bin/lampo-mcp')], env: srv.env, stderr: 'ignore' }));
      await reply(page, mcp, a.id, 'Done: it lands on the beat now');
      await showsReply(page, a.id, 'Done: it lands on the beat now');
      assert((await shown(page, b.id)).count === null, 'the other note has no reply yet');
      await reply(page, mcp, b.id, 'Bigger by 10 %');
      await countsReplies(page, b.id, 1);
    });

    // One tab holds the live stream for all of them (web/src/api/events.ts). Chrome freezes a tab in the background
    // to save energy, and a frozen tab runs nothing: the tab in front heard nothing either.
    await check('this machine, two tabs: with the stream’s tab frozen the other still shows the agent’s reply; awake again, the first catches up', async () => {
      // `page` came first and holds the stream; a second tab joins it
      const other = await openPlayer(srv.base, slug, [a.id, b.id]);
      await openNote(other, a.id);
      const say = async (p, words) => {
        await quiet(p);
        execFileSync(process.execPath, [LAMPO, 'reply', a.id, '--note', words], { env: srv.env, encoding: 'utf8' });
      };
      const cdp = await page.createCDPSession();
      await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
      try {
        await say(other, 'Graded the sky cooler');
        await showsReply(other, a.id, 'Graded the sky cooler');
      } finally {
        await cdp.send('Page.setWebLifecycleState', { state: 'active' });
      }
      await showsReply(page, a.id, 'Graded the sky cooler');
      // and the stream goes on for both
      await say(other, 'And the logo a frame later');
      await showsReply(other, a.id, 'And the logo a frame later');
      await showsReply(page, a.id, 'And the logo a frame later');
      await cdp.detach();
      await other.close();
    });
    await page.close();
  }

  // ---------------------------------------------------------------- a hosted server, in a workspace other than the first
  {
    const srv = await startServer({ prefix: 'vr-agent-reply-hosted-e2e-', mode: 'server', publicUrl: true });
    servers.push(srv);
    const request = client(srv.port);
    const origin = { Origin: srv.base };
    const cookieOf = (r) => String([r.headers['set-cookie']].flat().find((c) => String(c).startsWith('vr_session=')) || '').split(';')[0];
    const setup = await request('POST', '/api/auth/setup', {
      body: { token: await srv.setupToken(), email: 'sam@e2e.test', name: 'Sam', password: PW },
      headers: origin,
    });
    assert(setup.status === 200, setup.text);
    // a second workspace: the session moves into it, and everything below happens there
    const made = await request('POST', '/api/workspaces', { body: { name: 'Acme Films' }, headers: { Cookie: cookieOf(setup), ...origin } });
    assert(made.status === 200, made.text);
    assert(made.json().workspace.id !== 'w1', `not the first workspace: ${made.text}`);
    const cookie = cookieOf(made);
    const headers = { Cookie: cookie, ...origin };
    const api = (p, method, body) => jsonApi(srv.base)(p, method, body, headers);
    const file = makeVideo(path.join(srv.dir, 'renders/spot.mp4'), { w: 320, h: 180, fps: 25, dur: 4, pattern: 'testsrc2' });
    const up = await tusUpload(request, file, { filename: 'spot.mp4', folder: 'Acme' }, headers);
    assert(up.status === 200, up.text);
    const slug = up.json().slug;
    const token = (await api('/api/auth/tokens', 'POST', { name: 'claude code' })).token;
    const a = await api(`/api/review/${encodeURIComponent(slug)}/comments`, 'POST', { v: 1, frame: 20, text: 'The logo lands too early' });
    const page = await openPlayer(srv.base, slug, [a.id], cookie);
    const b = await api(`/api/review/${encodeURIComponent(slug)}/comments`, 'POST', { v: 1, frame: 50, text: 'Title a touch bigger' });
    await listed(page, [a.id, b.id]);
    const mcp = new Client({ name: 'claude-code', version: '2.1.0' });
    agents.push(mcp);
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));

    await check('hosted, a second workspace: the open note shows the reply an agent wrote through the server’s MCP endpoint, without a reload', async () => {
      await openNote(page, a.id);
      await reply(page, mcp, a.id, 'Moving the logo to 0:01');
      await showsReply(page, a.id, 'Moving the logo to 0:01');
    });

    await check('hosted, a second workspace: a closed note counts the agent’s reply; `lampo reply` with a token shows in the open note', async () => {
      await reply(page, mcp, b.id, 'Bigger by 10 %');
      await countsReplies(page, b.id, 1);
      const env = { ...srv.env, LAMPO_REMOTE: '1', LAMPO_SERVER: srv.base, LAMPO_TOKEN: token };
      await quiet(page);
      execFileSync(process.execPath, [LAMPO, 'reply', a.id, '--note', 'Done: it lands on the beat now'], { env, encoding: 'utf8' });
      await showsReply(page, a.id, 'Done: it lands on the beat now');
    });
  }

  await check('no page errors', async () => {
    assert(!errors.length, errors.join('\n'));
  });
} catch (e) {
  crashed(e, ...servers);
}
for (const mcp of agents) await mcp.close().catch(() => {});
await finish(LABEL, { browser, servers });
