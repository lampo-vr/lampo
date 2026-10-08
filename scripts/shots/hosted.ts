// The pictures of a hosted server (LAMPO_MODE=server) at a believable public address, https://review.northwind.example
// (an https front in this process; Chrome resolves the name to it): its first start's setup screen, the empty library
// with Claude Code connected, a fresh API token, the consent screen an app's sign-in opens, and the sign-in screen.
// Nothing but the app's own screens and API (and an MCP client, as Claude Code connects).
import crypto from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Browser } from 'puppeteer-core';
import { type DemoServer, startServer } from '../demo/server.ts';
import { type Camera, DAY_ZONE, scheme, sleep, tipsSeen } from './camera.ts';

export const PUBLIC_HOST = 'review.northwind.example';

export interface HostedScene {
  browser: Browser;
  camera: Camera;
  /** Where the hosted store goes. */
  dir: string;
  /** The port the server listens on: the https front passes requests there. */
  port: number;
  mediaRoot: string;
}

const OWNER = { name: 'Alex', email: 'alex@northwind.example', password: 'a demo password, not a real one' };

export async function hostedPictures(h: HostedScene): Promise<void> {
  const { browser, camera } = h;
  const server: DemoServer = await startServer(h.dir, {
    mediaRoot: h.mediaRoot,
    port: h.port,
    // an https URL means a TLS proxy in front, which a hosted server must be told about (lib/config.ts)
    vars: { LAMPO_MODE: 'server', LAMPO_PUBLIC_URL: `https://${PUBLIC_HOST}`, LAMPO_TRUST_PROXY: 'loopback', LAMPO_STT: 'off' },
  });
  const ctx = await browser.createBrowserContext();
  try {
    const page = await ctx.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
    await page.emulateTimezone(DAY_ZONE);
    await scheme(page, 'dark');
    await tipsSeen(page);
    const BASE = `https://${PUBLIC_HOST}`;
    const until = (fn: string, timeout = 20_000) => page.waitForFunction(fn, { polling: 100, timeout });

    // ---------------------------------------------------------------- first start: the setup screen
    let token: string | null = null;
    for (let i = 0; i < 150 && !token; i++) {
      token = /setup token:\s*\n\s*(\S+)/.exec(server.log())?.[1] ?? null;
      if (!token) await sleep(100);
    }
    if (!token) throw new Error(`no setup token in the hosted server's log:\n${server.log()}`);
    await page.goto(`${BASE}/?setup`, { waitUntil: 'domcontentloaded' });
    await until("document.querySelector('.ent-col h1')?.textContent === 'Set up this server'");
    await page.type('input[name=token]', token);
    await page.type('input[name=name]', OWNER.name);
    await page.type('input[name=email]', OWNER.email);
    await page.type('input[name=password]', OWNER.password);
    await page.mouse.move(2, 2);
    await sleep(800);
    await camera.shoot(page, 'hosted-setup', { around: ['.ent-col'], pad: [56, 72, 56, 72] });
    await page.click('.gate-go');
    await page.waitForSelector('.user-chip:enabled', { timeout: 15_000 });

    // ---------------------------------------------------------------- the empty library, Claude Code connected
    // Claude Code connects with an API token of the owner's, as `lampo mcp config claude` sets it up, and is on no video
    // yet: the empty library asks it by name to make the first one. The token goes again afterwards.
    if (camera.wants('library-empty')) {
      const made = (await page.evaluate(`fetch('/api/auth/tokens', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Studio Mac · Claude Code' }),
      }).then((r) => r.json())`)) as { token: string; info: { id: string } };
      const claude = new Client({ name: 'claude-code', version: '2.1.0' }, { versionNegotiation: { mode: 'auto' } });
      await claude.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${h.port}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${made.token}`, Host: PUBLIC_HOST } },
        }),
      );
      await claude.listTools();
      await page.goto('about:blank');
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid=make-with-agent][data-agent=claude-code]', { timeout: 30_000 });
      await page.mouse.move(2, 2);
      await sleep(800);
      await camera.shoot(page, 'library-empty', { full: true });
      await claude.close().catch(() => {});
      await page.evaluate(`fetch('/api/auth/tokens/${made.info.id}', { method: 'DELETE' })`);
    }

    // ---------------------------------------------------------------- Settings → API tokens, a token just made
    await page.goto(`${BASE}/#/settings/tokens`, { waitUntil: 'domcontentloaded' });
    const name = await page.waitForSelector('.set-card .set-inline input', { timeout: 15_000 });
    await name?.type('Studio Mac · Codex');
    await page.click('.set-card .set-inline button[type=submit]');
    await page.waitForSelector('.set-fresh', { timeout: 15_000 });
    // the agent is one of the tiles (web/src/settings/AgentChoice.tsx): a label round a hidden radio
    await page.click('.set-fresh .set-tile:has(input[value=codex])');
    await sleep(600);
    await page.mouse.move(2, 2);
    await camera.shoot(page, 'settings-api-token-fresh', { around: ['.set-card:has(.set-fresh)'], pad: [8, 24, 8, 24] });

    // ---------------------------------------------------------------- an app's sign-in: the consent screen
    // Claude Code registers itself (dynamic client registration) with a callback on its own computer, then sends the
    // person here; they are signed in already, so the consent screen comes first.
    const redirect = 'http://localhost:53682/callback';
    const reg = (await page.evaluate(`fetch('/oauth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: [${JSON.stringify(redirect)}] }),
    }).then((r) => r.json())`)) as { client_id: string };
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const authorize = `${BASE}/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: reg.client_id,
      redirect_uri: redirect,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: crypto.randomBytes(8).toString('hex'),
      scope: 'review:read review:comment review:act',
      resource: `${BASE}/mcp`,
    })}`;
    await page.goto(authorize, { waitUntil: 'domcontentloaded' });
    // the screen once the request is in: its loading state has the same title
    await until("!!document.querySelector('[data-testid=consent]')");
    await page.mouse.move(2, 2);
    await sleep(800);
    await camera.shoot(page, 'oauth-consent', { around: ['.ent-col'], pad: [56, 72, 56, 72] });

    // ---------------------------------------------------------------- signed out: the sign-in screen
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.user-chip:enabled', { timeout: 15_000 });
    await page.evaluate("fetch('/api/auth/logout', { method: 'POST' })");
    await page.goto('about:blank');
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.auth input[name="email"]', { timeout: 15_000 });
    await page.type('.auth input[name="email"]', OWNER.email);
    await page.mouse.move(2, 2);
    await sleep(1200);
    await camera.shoot(page, 'signin', { full: true });
  } finally {
    await ctx.close();
    await server.stop();
  }
}
