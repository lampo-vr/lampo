#!/usr/bin/env node
// covers: web/src/auth/ web/src/uploads/ web/src/settings/Tokens.tsx web/src/settings/Users.tsx web/src/pwa/push.ts
// covers: server/routes/uploads.ts server/routes/account.ts server/auth.ts server/uploadTickets.ts
// covers: server/permissions.ts lib/auth.ts lib/rateLimit.ts lib/storage/
// Browser end-to-end test of server mode: a real server (VR_MODE=server, temp store, free port) + headless Chrome.
// The path a self-hoster takes: setup with the token from the log → sign out → sign in → upload a render through the
// UI → it plays frame-exact → a note → an API token that works for the API → an invite link that signs up a reviewer
// (who can comment but not upload) → sign out, plus throttled sign-in.
// Without Chrome or web/dist it fails (see prereq.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { settings } from '../../lib/env.ts';
import { readOutbox } from '../../lib/mail/index.ts';
import { makeVideo, sleep } from '../lib/helpers.ts';
import { fitsAt } from './layout.mjs';
import { launch, requireChrome } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { closestFrame, shownPicture } from './lib/frames.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'server e2e';
// How long a state may take to show: generous, since every wait here is for a state and a loaded machine is slow, not wrong.
const WAIT = 30_000;
requireChrome(LABEL);
// A public URL like a real server's: invites on a hosted server are confirmed from the inbox (the outbox, here).
const srv = await startServer({ prefix: 'vr-e2e-server-', mode: 'server', publicUrl: true });
const { dir, env, base: BASE } = srv;

const OWNER = { name: 'E2E Owner', email: 'owner@e2e.test', password: 'a long enough password' };

let browser;
try {
  const setupToken = await srv.setupToken();
  assert(setupToken, `no setup token in the server log:\n${srv.log()}`);

  const W = 320;
  const H = 180;
  const video = makeVideo(path.join(dir, 'renders/e2e-upload.mp4'), { w: W, h: H, fps: 30, dur: 3 });

  browser = await launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  // Refused requests are part of this test (signed out, wrong setup token, wrong passwords, throttling); every other
  // failed request is an error. The browser's own "Failed to load resource" lines are checked this way, by URL.
  const expected = (p, status) => status === 401 || (p === '/api/auth/setup' && status === 403) || (p === '/api/auth/login' && status === 429);
  page.on('response', (r) => r.status() >= 400 && !expected(new URL(r.url()).pathname, r.status()) && errors.push(`${r.status()} ${r.url()}`));
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));
  const inPage = (p) =>
    page.evaluate(async (u) => {
      const r = await fetch(u);
      return { status: r.status, body: await r.json().catch(() => null) };
    }, p);
  const signOutViaMenu = async () => {
    await page.waitForSelector('.user-chip:enabled');
    await page.click('.user-chip:enabled');
    await page.waitForSelector('.menu button');
    await page.evaluate(() => [...document.querySelectorAll('.menu button')].find((b) => b.textContent.trim() === 'Sign out').click());
    await page.waitForFunction(() => document.querySelector('.ent-col h1')?.textContent === 'Sign in', { polling: 100, timeout: WAIT });
  };
  // Select-all + type replaces the text the way a person would, so React's controlled inputs stay in sync.
  const retype = async (sel, text) => {
    await page.click(sel, { count: 3 });
    await page.keyboard.press('Backspace');
    await page.type(sel, text);
  };
  const fillSignIn = async (email, password) => {
    await retype('input[name=email]', email);
    await page.type('input[name=password]', password);
    await page.click('.gate-go');
  };
  let slug = null;

  console.log(`server e2e against ${BASE} (store ${dir})`);

  await check('first start: the setup screen takes the token from the log and creates the owner', async () => {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('.ent-col h1')?.textContent === 'Set up this server', { polling: 100, timeout: WAIT });
    const fit = await fitsAt(page, 'setup');
    assert(!fit.length, fit.join('\n'));
    assert((await inPage('/api/library')).status === 401, 'the API is closed before setup');
    await page.type('input[name=token]', 'wrong-token-123');
    await page.type('input[name=name]', OWNER.name);
    await page.type('input[name=email]', OWNER.email);
    await page.type('input[name=password]', OWNER.password);
    await page.click('.gate-go');
    // the line kept for a miss is always there: wait for its words
    await page.waitForFunction(() => (document.querySelector('.gate-error')?.textContent || '').trim().length > 1, { polling: 100, timeout: WAIT });
    // The reader's words, not the server's: where the token is, and that it was the token that was wrong.
    const said = await page.$eval('.gate-error', (e) => e.textContent.trim());
    assert(/^That isn’t the setup token\. Copy it again from the server log/.test(said), `a wrong setup token says: ${said}`);
    await retype('input[name=token]', setupToken);
    await page.click('.gate-go');
    await page.waitForSelector('.user-chip:enabled', { timeout: WAIT });
    const me = await inPage('/api/auth/me');
    assert(me.status === 200 && me.body.role === 'owner' && me.body.user.email === OWNER.email, `me: ${JSON.stringify(me)}`);
  });

  await check('sign out, then sign in again and land on the library', async () => {
    // This device gets the account's notifications (a stand-in subscription: the headless browser has no push
    // service). Signing out must end them, or the next person on this computer reads the account's notes in them.
    await page.evaluate(() => {
      window.__unsubscribed = 0;
      const sub = { endpoint: 'https://push.example.test/e2e-device', unsubscribe: async () => ++window.__unsubscribed };
      const reg = { pushManager: { getSubscription: async () => sub } };
      const real = navigator.serviceWorker;
      const stand = new Proxy(real, {
        get: (t, k) => (k === 'getRegistration' ? async () => reg : typeof t[k] === 'function' ? t[k].bind(t) : t[k]),
      });
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: stand });
    });
    const asked = [];
    const onRequest = (r) => asked.push(new URL(r.url()).pathname);
    page.on('request', onRequest);
    await signOutViaMenu();
    page.off('request', onRequest);
    assert((await page.evaluate(() => window.__unsubscribed)) === 1, 'this device’s push subscription ended');
    const told = asked.indexOf('/api/push/unsubscribe');
    assert(told >= 0 && told < asked.indexOf('/api/auth/logout'), `the server forgot the device while still signed in: ${asked.join(' ')}`);
    assert((await inPage('/api/library')).status === 401, 'signed out: the API refuses');
    await page.waitForSelector('input[name=email]');
    const fit = await fitsAt(page, 'sign in');
    assert(!fit.length, fit.join('\n'));
    await fillSignIn(OWNER.email, OWNER.password);
    await page.waitForSelector('.user-chip:enabled', { timeout: WAIT });
    assert((await inPage('/api/library')).status === 200, 'signed in: the API answers');
  });

  await check('a session that ends elsewhere ends this device’s notifications too', async () => {
    await page.evaluate(() => {
      window.__unsubscribed = 0;
      const sub = { endpoint: 'https://push.example.test/e2e-device-2', unsubscribe: async () => ++window.__unsubscribed };
      const reg = { pushManager: { getSubscription: async () => sub } };
      const real = navigator.serviceWorker;
      const stand = new Proxy(real, {
        get: (t, k) => (k === 'getRegistration' ? async () => reg : typeof t[k] === 'function' ? t[k].bind(t) : t[k]),
      });
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: stand });
    });
    try {
      // the session ends on the server (here: its own sign-out, sent past the app), and the app's next call hears a 401
      assert((await page.evaluate(async () => (await fetch('/api/auth/logout', { method: 'POST' })).status)) === 200);
      await page.evaluate(() => {
        location.hash = '#/settings/links';
      });
      await page.waitForSelector('input[name=email]', { timeout: WAIT });
      await page.waitForFunction(() => window.__unsubscribed === 1, { timeout: WAIT });
    } finally {
      // signed in again for what follows, whatever happened above
      if (!(await page.$('.user-chip:enabled'))) {
        await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('input[name=email], .user-chip:enabled', { timeout: WAIT });
        if (await page.$('input[name=email]')) await fillSignIn(OWNER.email, OWNER.password);
        await page.waitForSelector('.user-chip:enabled', { timeout: WAIT });
      }
    }
  });

  await check('upload a render through the UI (tus): it becomes a review, the tray says so', async () => {
    const input = await page.$('input[data-testid=upload-input]');
    await input.uploadFile(video);
    await page.waitForSelector('.up-files', { timeout: WAIT });
    await page.evaluate(() => [...document.querySelectorAll('.modal-foot .btn.primary')].at(-1).click());
    await page.waitForSelector('.up-row.done', { timeout: 30000 });
    const lib = await inPage('/api/library');
    const v = lib.body.videos.find((x) => x.name === 'e2e-upload.mp4');
    assert(v, `the upload is in the library: ${JSON.stringify(lib.body.videos.map((x) => x.name))}`);
    assert(v.video.startsWith('/@uploads/') && v.frames === 90, `upload review ${JSON.stringify(v)}`);
    slug = v.slug;
    await page.waitForFunction(
      (name) => [...document.querySelectorAll('.film')].some((e) => e.textContent.includes(name)),
      { polling: 100, timeout: WAIT },
      'e2e-upload.mp4',
    );
  });

  await check('an upload that loses the connection says it waits, and finishes by itself when it is back', async () => {
    // testsrc2 at 1280×720 hardly compresses: about 1 MB, sent at 150 KB/s so the drop lands in the middle.
    const big = makeVideo(path.join(dir, 'renders/e2e-offline.mp4'), { w: 1280, h: 720, fps: 30, dur: 2, pattern: 'testsrc2' });
    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 150 * 1024 });
    try {
      const input = await page.$('input[data-testid=upload-input]');
      await input.uploadFile(big);
      await page.waitForSelector('.up-files', { timeout: WAIT });
      await page.evaluate(() => [...document.querySelectorAll('.modal-foot .btn.primary')].at(-1).click());
      // The drop lands in the middle: once some of it is sent (the row's percentage), not after a guessed time.
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('.up-row.uploading')].some((r) => {
            const pct = Number.parseInt(r.querySelector('.up-num')?.textContent ?? '', 10);
            return r.textContent.includes('e2e-offline.mp4') && pct >= 5 && pct < 90;
          }),
        { polling: 50, timeout: WAIT },
      );
      await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await page.waitForSelector('[data-testid=upload-waiting]', { timeout: WAIT });
      const said = await page.$eval('[data-testid=upload-waiting]', (e) => e.textContent.trim());
      assert(said === 'No connection: it goes on by itself when you’re back online', `while offline the row says: ${said}`);
      await sleep(3000);
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await page.waitForFunction(() => [...document.querySelectorAll('.up-row.done')].some((r) => r.textContent.includes('e2e-offline.mp4')), {
        polling: 200,
        timeout: 60000,
      });
      const lib = await inPage('/api/library');
      assert(
        lib.body.videos.some((x) => x.name === 'e2e-offline.mp4' && x.frames === 60),
        `registered whole: ${JSON.stringify(lib.body.videos.map((x) => [x.name, x.frames]))}`,
      );
    } finally {
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
      await cdp.detach().catch(() => {});
    }
  });

  const openPlayer = async (frame) => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${encodeURIComponent(slug)}?f=${frame}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => {
        const v = document.querySelector('.vbox video');
        return v && v.readyState >= 2 && !v.seeking;
      },
      { polling: 100, timeout: 20000 },
    );
    await sleep(500);
  };

  await check('the uploaded render plays frame-exact (0, 45, 89)', async () => {
    for (const n of [0, 45, 89]) {
      await openPlayer(n);
      const shot = await shownPicture(page);
      const best = closestFrame(video, shot, n, 90);
      assert(best.k === n, `frame ${n}: closest ffmpeg frame is ${best.k} (${best.line})`);
    }
  });

  await check('a note from the player is stored for the signed-in user, with its screenshots', async () => {
    await openPlayer(30);
    await page.keyboard.press('c');
    await page.waitForSelector('.composer textarea');
    await page.type('.composer textarea', 'server e2e note');
    await page.keyboard.down('Meta');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Meta');
    await page.waitForFunction(() => !document.querySelector('.composer'), { polling: 100, timeout: 20000 });
    const r = await inPage(`/api/review/${encodeURIComponent(slug)}`);
    const c = r.body.review.comments.find((x) => x.text === 'server e2e note');
    assert(c && c.frame === 30 && c.author === OWNER.name, `comment ${JSON.stringify(c)}`);
    for (const f of [c.shots.clean, c.shots.marked]) assert(fs.existsSync(path.join(env.VR_DATA, slug, f)), `${f} exists`);
  });

  await check('an API token created in Settings works as a Bearer token (and only once shown)', async () => {
    await page.goto(`${BASE}/#/settings/tokens`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.set-inline input');
    await page.type('.set-inline input', 'e2e agent');
    await page.click('.set-inline .btn.primary');
    await page.waitForSelector('[data-testid="token-fresh"] [data-testid="token-value"] pre', { timeout: WAIT });
    const token = await page.$eval('[data-testid="token-value"] pre', (e) => e.textContent);
    const login = await page.$eval('[data-testid="token-login"] pre', (e) => e.textContent);
    assert(/^vr_\S{20,}$/.test(token), `token ${token}`);
    assert(login === `lampo login ${BASE} --token -`, `login command ${login} (the token is pasted at the prompt, never on the command line)`);
    const r = await fetch(`${BASE}/api/library`, { headers: { Authorization: `Bearer ${token}` } });
    assert(r.status === 200 && (await r.json()).videos.some((v) => v.slug === slug), `bearer: ${r.status}`);
    const listed = await inPage('/api/auth/tokens');
    assert(!JSON.stringify(listed.body).includes(token), 'the token list never contains the secret');
    // Connect an agent with it: Claude Code's command first, then any client's config, for this server's /mcp with the
    // key lampo and this token.
    const snippet = () => page.$eval('[data-testid="token-snippet"] pre', (e) => e.textContent);
    assert((await snippet()) === `claude mcp add --transport http lampo ${BASE}/mcp --header "Authorization: Bearer ${token}"`, await snippet());
    await page.click('[data-testid="token-fresh"] [data-testid="agent-tiles"] input[value="codex"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="token-snippet"] pre')?.textContent.startsWith('[mcp_servers.lampo]'), {
      polling: 100,
      timeout: 5000,
    });
    const codex = await snippet();
    assert(codex.includes(`url = "${BASE}/mcp"`) && codex.includes(`Bearer ${token}`), `codex config ${codex}`);
    if (settings.LAMPO_SHOTS)
      await (await page.$('[data-testid="token-fresh"]')).screenshot({ path: path.join(settings.LAMPO_SHOTS, 'settings-mcp-tabs.png') });
  });

  await check('a token can be made to expire, and the list says when', async () => {
    await page.goto(`${BASE}/#/settings/tokens`, { waitUntil: 'domcontentloaded' });
    // The page is still showing the token made before: put it away first.
    const done = await page.$('.set-fresh .set-fresh-head .btn');
    if (done) await done.click();
    await page.waitForSelector('.set-inline input');
    await page.type('.set-inline input', 'e2e contractor');
    await page.click('.set-inline button[aria-label="How long it works"]');
    // The list is placed next to its field in a frame or two: pick the item once it stays put.
    const item = await page.waitForFunction(
      () => {
        const el = [...document.querySelectorAll('.select-item')].find((e) => e.textContent === '90 days');
        const box = el?.getBoundingClientRect();
        const key = box && `${box.x},${box.y}`;
        const settled = key && key === window.__lastBox;
        window.__lastBox = key;
        return settled ? el : null;
      },
      { polling: 50, timeout: 5000 },
    );
    const box = await item.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    await page.mouse.down();
    await page.mouse.up();
    // What the field shows (the other labels in it only size it and are hidden).
    const chosen = () => page.$eval('.set-inline button[aria-label="How long it works"] .select-sizer > span:not([aria-hidden])', (e) => e.textContent);
    await page
      .waitForFunction(
        () => document.querySelector('.set-inline button[aria-label="How long it works"] .select-sizer > span:not([aria-hidden])')?.textContent === '90 days',
        { polling: 100, timeout: 5000 },
      )
      .catch(async () => assert(false, `the lifetime field shows ${await chosen()}`));
    // Enter in the name field (a click right after the list closes can land while Radix still blocks the page).
    await page.focus('.set-inline input');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.set-fresh-head b')?.textContent.includes('e2e contractor'), { polling: 100, timeout: WAIT });
    const listed = (await inPage('/api/auth/tokens')).body.tokens;
    const made = listed.find((x) => x.name === 'e2e contractor');
    const days = (Date.parse(made?.expires) - Date.now()) / 86400000;
    assert(days > 89.9 && days <= 90, `expires in ${days} days`);
    assert(!listed.find((x) => x.name === 'e2e agent')?.expires, 'a token made without a lifetime works until revoked');
    const expiryOf = (name) =>
      page.$$eval(
        '[data-testid="token-row"]',
        (rows, n) => rows.find((r) => r.textContent.includes(n))?.querySelector('[data-testid="token-expiry"]')?.textContent,
        name,
      );
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="token-row"]').length >= 2, { polling: 100, timeout: 5000 });
    assert((await expiryOf('e2e contractor')) === 'expires in 90 days', `row says ${await expiryOf('e2e contractor')}`);
    assert((await expiryOf('e2e agent')) === 'no expiry', `row says ${await expiryOf('e2e agent')}`);
  });

  await check('an invite from Settings signs up a reviewer, who comments but cannot upload', async () => {
    await page.goto(`${BASE}/#/settings/users`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.set-form input[type=email]');
    const fitSettings = await fitsAt(page, 'settings');
    assert(!fitSettings.length, fitSettings.join('\n'));
    // The fit check resized the page through phone and tablet sizes; the form re-renders on the way back.
    await page.waitForSelector('.set-form input[maxlength="80"]');
    await page.type('.set-form input[maxlength="80"]', 'Rita Reviewer');
    await page.type('.set-form input[type=email]', 'rita@e2e.test');
    // The link to copy, not an email (the server could send one: it has a public URL).
    await page.click('#invite-send');
    await page.evaluate(() => [...document.querySelectorAll('.set-form button[type=submit]')].find((b) => b.textContent.includes('invite link')).click());
    await page.waitForSelector('.modal .set-code pre', { timeout: WAIT });
    const url = await page.$eval('.modal .set-code pre', (e) => e.textContent);
    assert(new RegExp(`^${BASE}/#/invite/inv_[\\w-]{32}$`).test(url), `invite link ${url}`);

    // A different person: a fresh browser profile without the owner's cookie.
    const other = await browser.createBrowserContext();
    const guest = await other.newPage();
    const seen = [];
    guest.on('response', (r) => r.status() >= 400 && seen.push(`${r.status()} ${new URL(r.url()).pathname}`));
    guest.on('pageerror', (e) => seen.push(e.message));
    await guest.setViewport({ width: 1440, height: 900 });
    await guest.goto(url, { waitUntil: 'domcontentloaded' });
    await guest.waitForFunction(() => document.querySelector('.ent-col h1')?.textContent === 'You’re invited', { polling: 100, timeout: WAIT });
    // Who invites, as what (the line above the title), what that lets you do (one sentence), and until when the link
    // works (the fine print).
    const from = await guest.$eval('.ent-from-t', (e) => [...e.children].map((c) => c.textContent.trim()).join(' '));
    assert(from === 'E2E Owner invites you as a reviewer', `who invites: ${from}`);
    const lede = await guest.$eval('.ent-lede', (e) => e.textContent.trim());
    assert(lede === 'As a reviewer you watch, leave notes, check fixes and approve.', `invite sentence: ${lede}`);
    const fine = await guest.$eval('.ent-fine', (e) => e.textContent.replace(/\s+/g, ' ').trim());
    const day = String(new Date(Date.now() + 7 * 86400e3).getDate());
    assert(fine.startsWith('The link works once, until') && new RegExp(`\\b${day}\\b`).test(fine), `until when the link works (day ${day}): ${fine}`);
    const fitInvite = await fitsAt(guest, 'invite');
    assert(!fitInvite.length, fitInvite.join('\n'));
    // The address an invite is made out to isn't shown to whoever holds the link: Rita types her own.
    const pre = await guest.$eval('input[name=email]', (e) => e.value);
    assert(pre === '', `the invite's address is not given away: ${pre}`);
    await guest.type('input[name=email]', 'rita@e2e.test');
    await guest.type('input[name=password]', 'ritas own password');
    const asked = Date.now();
    await guest.click('.gate-go');
    // The invite's link proves no inbox (whoever made it holds it too): the link mailed to her address lets her in.
    await guest.waitForSelector('[data-testid=invite-sent]', { timeout: 15000 });
    // (how "Check your inbox" fits: account.mjs, after every invite it takes)
    let confirm = null;
    for (let i = 0; i < 100 && !confirm; i++) {
      confirm = readOutbox(path.join(env.VR_CACHE, 'outbox')).find((m) => m.to === 'rita@e2e.test' && m.kind === 'verify' && Date.parse(m.at) >= asked);
      if (!confirm) await sleep(100);
    }
    const link = /https?:\/\/\S+#\/verify\/[\w-]+/.exec(confirm?.text ?? '')?.[0];
    assert(link, 'a confirm link went to her address');
    await guest.goto(link, { waitUntil: 'domcontentloaded' });
    await guest.waitForSelector('[data-testid=verify-open]', { timeout: 15000 });
    await guest.click('[data-testid=verify-open]');
    await guest.waitForSelector('.lib .film', { timeout: 15000 });
    const status = await guest.evaluate(async () => (await fetch('/api/auth/status')).json());
    assert(status.user?.role === 'reviewer' && status.user.name === 'Rita Reviewer', `signed in as ${JSON.stringify(status.user)}`);
    const buttons = await guest.$$eval('button', (els) => els.map((b) => b.textContent.trim()));
    assert(!buttons.some((t) => /^Upload/.test(t)), `no upload for reviewers: ${buttons.join(' | ')}`);

    await guest.goto(`${BASE}/#/v/${encodeURIComponent(slug)}?f=12`, { waitUntil: 'domcontentloaded' });
    await guest.waitForFunction(() => document.querySelector('.vbox video')?.readyState >= 2, { polling: 100, timeout: 20000 });
    await sleep(400);
    await guest.keyboard.press('c');
    await guest.waitForSelector('.composer textarea');
    await guest.type('.composer textarea', 'reviewer e2e note');
    await guest.keyboard.down('Meta');
    await guest.keyboard.press('Enter');
    await guest.keyboard.up('Meta');
    await guest.waitForFunction(() => !document.querySelector('.composer'), { polling: 100, timeout: 20000 });
    const r = await guest.evaluate(async (s) => (await fetch(`/api/review/${encodeURIComponent(s)}`)).json(), slug);
    const c = r.review.comments.find((x) => x.text === 'reviewer e2e note');
    assert(c && c.author === 'Rita Reviewer', `reviewer's note ${JSON.stringify(c)}`);
    const menu = await guest.$$eval('.topbar button', (els) => els.map((b) => b.textContent.trim()));
    assert(!menu.some((t) => /^Claude/.test(t)), `no agent menu for reviewers: ${menu.join(' | ')}`);
    assert(!seen.length, `the reviewer's UI asked for nothing it may not have: ${seen.join(', ')}`);
    await other.close();

    const again = await fetch(`${BASE}/api/auth/invite/peek`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: BASE },
      body: JSON.stringify({ token: url.split('/').pop() }),
    });
    assert(again.status === 404, `the link works once: ${again.status}`);
  });

  await check('signing out ends the browser session and leaves nothing of the account in storage (A12 WEB-7)', async () => {
    // what the screens remember: the player's panel and zoom per video, the sidebar's open folders, a tab's last view
    await page.goto(`${BASE}/#/v/${encodeURIComponent(slug)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('.vbox video')?.readyState >= 2, { polling: 100, timeout: 20000 });
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.lib .film');
    await page.evaluate((s) => {
      localStorage.setItem('vr.player', JSON.stringify({ panel: s }));
      localStorage.setItem('vr.expanded', JSON.stringify(['Acme', 'Acme/Launch']));
      sessionStorage.setItem('vr.lastLibrary', '#/folder/Acme');
      localStorage.setItem('vr.theme', 'dark');
    }, slug);
    const before = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('vr.')));
    assert(
      ['vr.player', 'vr.expanded', 'vr.recent', 'vr.chrome'].every((k) => before.includes(k)),
      `account state to forget: ${before.join(' ')}`,
    );
    await signOutViaMenu();
    assert((await inPage('/api/library')).status === 401, 'the API refuses after sign-out');
    const KEPT = ['vr.theme', 'vr.lang', 'vr.g.visitor', 'vr.guestName'];
    let left = [];
    for (let t = Date.now(); Date.now() - t < 3000; await sleep(100)) {
      left = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((k) => k.startsWith('vr.')));
      if (left.every((k) => KEPT.includes(k))) break;
    }
    assert(
      left.every((k) => KEPT.includes(k)),
      `only the device's own keys stay: ${left.join(' ')}`,
    );
    assert(left.includes('vr.theme'), 'the theme chosen on this device stays');
  });

  await check('repeated wrong passwords are throttled, and the screen says how long to wait', async () => {
    for (let i = 0; i < 9; i++) {
      // typing takes the last miss back; each try is answered on the error line once the button is free again
      await fillSignIn('nobody@e2e.test', 'wrong password');
      await page.waitForFunction(
        () => (document.querySelector('.gate-error')?.textContent || '').trim().length > 1 && !document.querySelector('.gate-go[aria-busy]'),
        { polling: 50, timeout: WAIT },
      );
    }
    const text = await page.$eval('.gate-error', (e) => e.textContent);
    assert(/Too many sign-in attempts/.test(text) && /Try again in \d\d:\d\d/.test(text), `error: ${text}`);
    assert(await page.$eval('.gate-go', (b) => b.disabled), 'the button waits for the cooldown');
  });

  await check('no page errors along the way', async () => {
    assert(!errors.length, errors.join(' | '));
  });
} catch (e) {
  crashed(e, srv);
} finally {
  await finish(LABEL, { browser, servers: [srv] });
}
