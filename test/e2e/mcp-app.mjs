#!/usr/bin/env node
// covers: web/mcp-app/ server/routes/mcp.ts mcp/
// The review card (MCP App) end to end: a real server (temp store, free port), the SDK v2 client over /mcp, and the
// card rendered in headless Chrome by a minimal MCP Apps host (test/e2e/mcp-host) that forwards its tool calls to
// /mcp. Checks: the marked frame shows, stepping gives the exact next frame, reply and "mark fixed" reach the review,
// the card takes the host's theme.
// Without Chrome or web/dist-mcp it fails (see prereq.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { build } from 'vite';
import { settings } from '../../lib/env.ts';
import { age, makeVideo, ROOT } from '../lib/helpers.ts';
import { launch, requireChrome } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';
import { unavailable } from './prereq.mjs';

const LABEL = 'mcp-app e2e';
requireChrome(LABEL);
if (!fs.existsSync(path.join(ROOT, 'web/dist-mcp/review.html'))) unavailable(LABEL, 'web/dist-mcp is missing, run `npm run build` first');
const srv = await startServer({ prefix: 'vr-mcp-app-', user: 'tester' });
const { dir, base: BASE } = srv;

const api = async (p, init) => {
  const r = await fetch(BASE + p, init && { ...init, headers: { 'Content-Type': 'application/json' } });
  const body = await r.json();
  if (!r.ok) throw new Error(`${p}: ${body.error}`);
  return body;
};

// The host page's script: AppBridge from the MCP Apps SDK, bundled for the browser.
const hostOut = path.join(dir, 'host');
await build({
  configFile: false,
  logLevel: 'silent',
  build: { outDir: hostOut, emptyOutDir: true, minify: false, lib: { entry: path.join(ROOT, 'test/e2e/mcp-host/host.ts'), formats: ['es'], fileName: 'host' } },
});
const hostJs = fs.readFileSync(
  path.join(
    hostOut,
    fs.readdirSync(hostOut).find((f) => f.endsWith('.js')),
  ),
  'utf8',
);

let browser;
let client;
try {
  const video = makeVideo(path.join(dir, 'proj/export/card.mp4'), { w: 640, h: 360, dur: 2, pattern: 'testsrc2' });
  age(video);
  const { video: added } = await api('/api/library', { method: 'POST', body: JSON.stringify({ path: video }) });
  const note = await api(`/api/review/${encodeURIComponent(added.slug)}/comments`, {
    method: 'POST',
    body: JSON.stringify({ frame: 20, text: 'Logo zu früh', severity: 'must', drawing: [{ type: 'box', x: 400, y: 40, w: 180, h: 90 }] }),
  });

  client = new Client({ name: 'mcp-app-e2e', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  const args = { video: 'card.mp4' };
  const result = await client.callTool({ name: 'show_review', arguments: args });
  const html = (await client.readResource({ uri: 'ui://video-review/review.html' })).contents[0].text;

  browser = await launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 1250, deviceScaleFactor: 2 });
  const calls = [];
  await page.exposeFunction('hostCall', async (name, a) => {
    calls.push(name);
    return client.callTool({ name, arguments: a });
  });
  await page.setContent('<!doctype html><html><body style="margin:0;background:#1a1a1a"></body></html>');
  await page.addScriptTag({ content: hostJs, type: 'module' });
  await page.waitForFunction(() => typeof window.startHost === 'function');
  await page.evaluate((h, a, r) => window.startHost(h, a, r), html, args, result);
  const frameEl = await page.waitForSelector('iframe');
  const card = await frameEl.contentFrame();
  const caption = () => card.$eval('figcaption', (el) => el.textContent);

  await check('the card renders the marked frame of the first open note', async () => {
    await card.waitForFunction(() => document.querySelector('.frame img')?.naturalWidth > 0, { timeout: 10000 });
    const cap = await caption();
    assert(/00:00:20 f20 · v1 · marked/.test(cap), cap);
    assert((await card.$$eval('.note', (els) => els.length)) === 1, 'one open note');
  });

  await check("the card takes the host's theme (the frame stays dark) and follows when the host switches", async () => {
    const look = () =>
      card.evaluate(() => [
        document.documentElement.dataset.theme,
        getComputedStyle(document.body).backgroundColor,
        getComputedStyle(document.querySelector('.frame')).backgroundColor,
        getComputedStyle(document.querySelector('figcaption')).color,
      ]);
    const light = await look();
    assert(light.join() === 'light,rgb(242, 239, 231),rgb(0, 0, 0),rgb(143, 139, 131)', light.join(' | '));
    if (settings.LAMPO_SHOTS) await page.screenshot({ path: path.join(settings.LAMPO_SHOTS, 'mcp-app-card-light.png'), fullPage: true });
    await page.evaluate(() => window.hostTheme('dark'));
    await card.waitForFunction(() => document.documentElement.dataset.theme === 'dark', { timeout: 5000 });
    const dark = await look();
    assert(dark.join() === 'dark,rgb(11, 11, 12),rgb(0, 0, 0),rgb(143, 139, 131)', dark.join(' | '));
  });

  await check('+1 shows the exact next frame (grabbed through review_frame)', async () => {
    await card.$$eval('.transport .btn', (btns) => btns.find((b) => b.textContent === '+1').click());
    await card.waitForFunction(() => document.querySelector('figcaption')?.textContent.includes('f21'), { timeout: 10000 });
    assert(!(await caption()).includes('marked'), 'a clean frame now');
    assert(calls.includes('review_frame'), calls.join());
  });

  await check('reply and "mark fixed" from the card reach the review', async () => {
    await card.click('.note-head');
    await card.waitForSelector('.note-body textarea');
    await card.type('.note-body textarea', 'Schaue ich mir an');
    await card.$$eval('.actions .btn', (btns) => btns.find((b) => b.textContent === 'Reply').click());
    await card.waitForFunction(() => [...document.querySelectorAll('.reply')].some((p) => p.textContent.includes('Schaue ich mir an')), { timeout: 10000 });
    await card.type('.note-body textarea', 'Logo 12 Frames später');
    await card.$$eval('.actions .btn', (btns) => btns.find((b) => b.textContent === 'Mark fixed').click());
    await card.waitForFunction(() => document.querySelector('.note')?.classList.contains('fixed'), { timeout: 10000 });
    const { review } = await api(`/api/review/${encodeURIComponent(added.slug)}`);
    const c = review.comments.find((x) => x.id === note.id);
    assert(c.status === 'fixed', c.status);
    assert(
      c.replies.some((r) => r.text === 'Schaue ich mir an' && r.by === 'agent:mcp-app-e2e'),
      JSON.stringify(c.replies),
    );
  });

  await check('"Open in the player" asks the host to open the player at the frame', async () => {
    await card.$$eval('.transport .btn', (btns) => btns.find((b) => b.textContent === 'Open in the player').click());
    await page.waitForFunction(() => window.hostOpened.length > 0, { timeout: 5000 });
    const url = await page.evaluate(() => window.hostOpened[0]);
    assert(url.startsWith(`${BASE}/#/v/`) && /[?&]f=\d+/.test(url), url);
  });

  if (settings.LAMPO_SHOTS) await page.screenshot({ path: path.join(settings.LAMPO_SHOTS, 'mcp-app-card.png'), fullPage: true });
} catch (e) {
  crashed(e, srv);
} finally {
  await client?.close().catch(() => {});
  await finish(LABEL, { browser, servers: [srv] });
}
