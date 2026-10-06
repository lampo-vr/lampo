#!/usr/bin/env node
// covers: web/src/auth/AuthScreens.tsx web/src/settings/Tokens.tsx server/routes/oauth.ts server/routes/mcp.ts
// covers: lib/oauth/ lib/scopes.ts lib/browserLogin.ts lib/cliAccount.ts
// Browser end-to-end test of the OAuth sign-in for MCP clients (server mode): an app registers and sends the person to
// /oauth/authorize while signed out → the app's sign-in screen → the consent screen (who asks, where the answer goes,
// what it may do) → Allow → the browser lands on the app's callback with code, state and iss → the app redeems the code
// (PKCE) and calls /mcp → the app shows up under Settings → API tokens → Connected apps. Then `vr login` (the real vr,
// its browser a stand-in that hands the address to this page): the same consent screen naming the machine and the
// token, Allow, and the page stays on "Back to the terminal" while vr signs in. Screenshots of the consent screens
// (desktop and phone, vr's in both themes) go to VR_SHOTS when set. Without Chrome or web/dist it fails (prereq.mjs).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { freePort, sleep, tmpdir, until, VR } from '../lib/helpers.ts';
import { fitsAt } from './layout.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'oauth e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-e2e-oauth-', mode: 'server', publicUrl: true });
const { base: BASE } = srv;

const OWNER = { name: 'E2E Owner', email: 'owner@e2e.test', password: 'a long enough password' };

// The app's side: a callback that records what the browser brings back.
const callbackPort = await freePort();
const REDIRECT = `http://127.0.0.1:${callbackPort}/callback`;
let landed = null;
const callback = http.createServer((req, res) => {
  const u = new URL(req.url, REDIRECT);
  // The browser also asks for /favicon.ico: only the callback counts.
  if (u.pathname === '/callback') landed = u;
  res.setHeader('content-type', 'text/html');
  // The app's own page, for an app that signs in in a popup: it waits for the word its callback sends to window.opener.
  if (u.pathname === '/app')
    return res.end('<!doctype html><title>app</title><script>addEventListener("message", (e) => { window.__answer = e.data; });</script>');
  res.end('<h1>The app got the answer.</h1><script>if (window.opener) window.opener.postMessage(location.search, "*");</script>');
});
await new Promise((r) => callback.listen(callbackPort, '127.0.0.1', r));

let browser;
try {
  const setupToken = await srv.setupToken();
  assert(setupToken, `no setup token in the server log:\n${srv.log()}`);
  const setup = await fetch(`${BASE}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ token: setupToken, ...OWNER }),
  });
  assert(setup.ok, `setup failed: ${setup.status}`);

  const reg = await (
    await fetch(`${BASE}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'E2E Agent', redirect_uris: [REDIRECT] }),
    })
  ).json();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorize = `${BASE}/oauth/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: reg.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'e2e-state',
    scope: 'review:read review:comment review:act',
    resource: `${BASE}/mcp`,
  })}`;

  browser = await launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 });
  const errors = [];
  // Signed out, the app shell hears 401s before the sign-in; the callback server is the app's, not ours.
  page.on('response', (r) => r.status() >= 400 && r.status() !== 401 && errors.push(`${r.status()} ${r.url()}`));
  page.on('pageerror', (e) => errors.push(e.message));
  const text = () => page.evaluate(() => document.body.innerText);

  await check('an app sends you to sign in first, then to its consent screen', async () => {
    // The request's lookup answers late here, as on a loaded machine: the screen waits in its own layout, its title
    // already standing ("Let it in?" with skeleton lines and a disabled Allow), and what is read is the screen once the
    // request is in — never the one that waits for it.
    let held = 0;
    await page.setRequestInterception(true);
    const late = (req) => {
      if (req.isInterceptResolutionHandled()) return;
      if (req.method() === 'GET' && /\/api\/oauth\/requests\//.test(req.url())) {
        held++;
        setTimeout(() => req.continue().catch(() => {}), 1500);
      } else req.continue().catch(() => {});
    };
    page.on('request', late);
    await page.goto(authorize, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[name=email]', { timeout: 15000 });
    assert(/#\/oauth\/[A-Za-z0-9_-]+$/.test(page.url()), `consent route, got ${page.url()}`);
    await page.type('input[name=email]', OWNER.email);
    await page.type('input[name=password]', OWNER.password);
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid=consent]', { timeout: 15000 });
    page.off('request', late);
    await page.setRequestInterception(false);
    assert(held > 0, 'the lookup was held back');
    const t = await text();
    assert(t.includes('E2E Agent'), 'shows who asks');
    assert(/named itself/.test(t), 'a self-registered name is marked as unverified');
    assert(t.includes(`127.0.0.1:${callbackPort}`) && /on this computer/.test(t), 'shows where the answer goes, with the local warning');
    for (const s of ['Read reviews', 'Write notes', 'Act on feedback']) assert(t.includes(s), `lists ${s}`);
    const fit = await fitsAt(page, 'consent');
    assert(!fit.length, fit.join('\n'));
    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      await sleep(1200); // the film's still fading in
      await page.screenshot({ path: path.join(SHOTS, 'consent-desktop.png') });
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3 });
      await sleep(200);
      await page.screenshot({ path: path.join(SHOTS, 'consent-phone.png'), fullPage: true });
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
    }
  });

  await check('Allow hands the browser to the app with code, state and iss', async () => {
    const buttons = await page.$$('button');
    let allow = null;
    for (const b of buttons) if ((await b.evaluate((e) => e.textContent || '')).includes('Allow')) allow = b;
    assert(allow, 'Allow button');
    await allow.click();
    for (let i = 0; i < 100 && !landed; i++) await sleep(50);
    assert(landed, 'the browser reached the callback');
    assert(landed.searchParams.get('state') === 'e2e-state', 'state round-trips');
    assert(landed.searchParams.get('iss') === BASE, 'iss names this server (RFC 9207)');
    assert(/^vra_/.test(landed.searchParams.get('code') || ''), 'an authorization code');
  });

  await check('the app redeems the code with PKCE and works with /mcp', async () => {
    const t = await fetch(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: landed.searchParams.get('code'),
        code_verifier: verifier,
        client_id: reg.client_id,
        redirect_uri: REDIRECT,
        resource: `${BASE}/mcp`,
      }).toString(),
    });
    assert(t.ok, `token: ${t.status} ${await t.clone().text()}`);
    const tokens = await t.json();
    const r = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert(r.status === 200, `/mcp answered ${r.status}`);
  });

  await check('the app is listed under Connected apps and can be disconnected', async () => {
    await page.goto(`${BASE}/#/settings/tokens`, { waitUntil: 'domcontentloaded' });
    await page
      // innerText follows the CSS: card titles are upper-cased.
      .waitForFunction(() => /connected apps/i.test(document.body.innerText) && document.body.innerText.includes('E2E Agent'), {
        timeout: 15000,
        polling: 100,
      })
      .catch(async (e) => {
        throw new Error(`${e.message} --- page: ${page.url()} :: ${(await text()).replace(/\s+/g, ' ').slice(0, 900)}`);
      });
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'connected-apps.png'), fullPage: true });
    const apps = () => page.evaluate(async () => (await (await fetch('/api/auth/apps')).json()).apps);
    const listed = await apps();
    assert(listed.length === 1 && listed[0].client_name === 'E2E Agent', JSON.stringify(listed));
    const clickText = async (scope, label) => {
      for (const b of await page.$$(`${scope} button`)) if ((await b.evaluate((e) => e.textContent || '')).trim() === label) return b.click();
      throw new Error(`no ${label} button in ${scope}`);
    };
    await clickText('.set-row', 'Disconnect');
    await page.waitForSelector('[role=alertdialog]', { timeout: 5000 });
    await clickText('[role=alertdialog]', 'Disconnect');
    for (let i = 0; i < 50 && (await apps()).length; i++) await sleep(100);
    assert((await apps()).length === 0, 'disconnected');
  });

  // `vr login <url>`: the real vr on this machine, its browser a stand-in script that writes the address down; this page
  // is the person's browser (signed in above).
  await check('vr login: the consent screen names the machine and the token; Allow leaves the page on Back to the terminal', async () => {
    const home = tmpdir('vr-e2e-vr-login-');
    const opened = path.join(home, 'opened.txt');
    const stand = path.join(home, 'browser.sh');
    fs.writeFileSync(stand, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${opened}'\n`, { mode: 0o755 });
    const env = {
      ...process.env,
      BROWSER: stand,
      XDG_CONFIG_HOME: path.join(home, 'config'),
      XDG_CACHE_HOME: path.join(home, 'cache'),
      VR_DATA: path.join(home, 'no-store'),
      VR_CACHE: path.join(home, 'no-cache'),
    };
    for (const k of ['VR_MODE', 'VR_TOKEN', 'VR_SERVER', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'CLAUDE_PID', 'CLAUDE_CODE_SESSION_ID']) delete env[k];
    const vr = spawn(process.execPath, [VR, 'login', BASE, '--expires', '90d'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    vr.stdout.on('data', (d) => {
      out += d;
    });
    vr.stderr.on('data', (d) => {
      err += d;
    });
    const exited = new Promise((resolve) => vr.on('close', resolve));
    try {
      const asked = new URL(
        await until(
          () => fs.existsSync(opened) && fs.readFileSync(opened, 'utf8').trim(),
          () => `vr opened nothing: ${err}`,
        ),
      );
      // the machine's own name would land in the pictures: the address goes on as a computer called studio-mac
      asked.searchParams.set('machine', 'studio-mac');
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 });
      await page.goto(String(asked), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid=consent]', { timeout: 15000 });
      const t = await text();
      assert(/vr on studio-mac wants to work with your reviews/.test(t.replace(/\s+/g, ' ')), `names vr and the machine: ${t}`);
      assert(t.includes('vr on studio-mac') && /valid for 90 days/.test(t), 'names the token as Settings → API tokens will, and how long it works');
      assert(/Works as you/.test(t) && /Stays with you/.test(t), 'what the token may do, and what stays a person’s');
      assert(!/Read reviews|Act on feedback/.test(t), 'no app scopes for vr');
      assert(/127\.0\.0\.1:\d+/.test(t) && /on this computer/.test(t), 'where the answer goes, with the local warning');
      assert(/or with vr logout/.test(t), 'how to revoke it');
      const fit = await fitsAt(page, 'consent');
      assert(!fit.length, fit.join('\n'));
      if (SHOTS) {
        await sleep(1200); // the film's still fading in
        for (const theme of ['light', 'dark']) {
          await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
          await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
          await sleep(250);
          await page.screenshot({ path: path.join(SHOTS, `vr-consent-1440-${theme}.png`) });
          await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3 });
          await sleep(250);
          await page.screenshot({ path: path.join(SHOTS, `vr-consent-390-${theme}.png`), fullPage: true });
        }
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
        await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
      }
      const here = page.url();
      let allow = null;
      for (const b of await page.$$('button')) if ((await b.evaluate((e) => e.textContent || '')).includes('Allow')) allow = b;
      assert(allow, 'Allow button');
      await allow.click();
      await page.waitForSelector('[data-testid=consent-done]', { timeout: 15000 });
      // vr's port answers 204: the browser stays on this page, which says where to go on
      assert((await exited) === 0, `vr signed in: ${err}`);
      assert(/^signed in to .* as E2E Owner <owner@e2e\.test> \(owner\) in workspace /.test(out), `vr says who and where: ${out}`);
      assert(page.url() === here, `the page stayed: ${page.url()}`);
      const done = (await text()).replace(/\s+/g, ' ');
      assert(/Back to the terminal/.test(done) && /vr on studio-mac takes it from here\. You can close this tab\./.test(done), done);
      if (SHOTS)
        for (const theme of ['light', 'dark']) {
          await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
          for (const [width, height, scale] of [
            [1440, 900, 2],
            [390, 844, 3],
          ]) {
            await page.setViewport({ width, height, deviceScaleFactor: scale });
            await sleep(250);
            await page.screenshot({ path: path.join(SHOTS, `vr-consent-done-${width}-${theme}.png`), fullPage: width === 390 });
          }
        }
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 });
      // the token is listed under its name, like one made in Settings
      const tokens = await page.evaluate(async () => (await (await fetch('/api/auth/tokens')).json()).tokens);
      assert(
        tokens.some((x) => x.name === 'vr on studio-mac' && x.expires),
        JSON.stringify(tokens),
      );
    } finally {
      vr.kill();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // An app on another origin that runs the sign-in in a popup and hears the answer through window.opener (as browser
  // and desktop MCP clients do). The consent page answers with its own opener policy (A12 WEB-10): same-origin there
  // would cut the popup from its opener for good, and the app would wait forever after Allow.
  await check('an app that signs in in a popup hears the answer through window.opener', async () => {
    const app = await browser.newPage();
    try {
      await app.goto(`http://127.0.0.1:${callbackPort}/app`, { waitUntil: 'domcontentloaded' });
      const popupUrl = authorize.replace('state=e2e-state', 'state=popup-state');
      const opened = browser.waitForTarget((t) => t.opener() === app.target(), { timeout: 10000 });
      await app.evaluate((u) => void window.open(u, 'signin', 'width=600,height=760'), popupUrl);
      const popup = await (await opened).page();
      // the screen once the request is in (its loading state has the same title and a disabled Allow)
      await popup.waitForSelector('[data-testid=consent]', { timeout: 15000 });
      let allow = null;
      for (const b of await popup.$$('button')) if ((await b.evaluate((e) => e.textContent || '')).includes('Allow')) allow = b;
      assert(allow, 'Allow button in the popup');
      await allow.click();
      await app.waitForFunction(() => typeof window.__answer === 'string', { timeout: 15000, polling: 100 }).catch(() => {});
      const answer = new URLSearchParams((await app.evaluate(() => window.__answer)) || '');
      assert(answer.get('state') === 'popup-state', `the app heard its answer through window.opener: ${answer}`);
      assert(/^vra_/.test(answer.get('code') || ''), 'with a code');
    } finally {
      await app.close();
    }
  });

  await check('no page errors along the way', async () => {
    assert(!errors.length, errors.join('\n'));
  });
} catch (e) {
  crashed(e, srv);
} finally {
  callback.close();
  await finish(LABEL, { browser, servers: [srv] });
}
