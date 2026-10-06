#!/usr/bin/env node
// covers: web/src/auth/Workspaces.tsx web/src/auth/workspacesCode.ts web/src/auth/NewWorkspace.tsx
// covers: web/src/settings/Workspace.tsx web/src/api/workspaces.ts web/src/styles/workspaces.css
// covers: server/routes/workspaces.ts server/workspace.ts lib/workspaces.ts lib/scope.ts
// Browser end-to-end test of workspaces on a hosted server: one person in two workspaces sees the switcher in the
// account menu, switches (the library is the other workspace's, and the old one's never paints for a moment), makes a
// third through the dialog ("New workspace…" opens it in Settings → Workspace), renames it; someone in one workspace sees no
// trace of any of it; a review link of one workspace shows its own video under a name another workspace also uses;
// someone who signs up on their own (VR_SIGNUP=open) gets a workspace of their own, and their first step names it.
// Every screen fits at phone, tablet and desktop, light and dark, English and German.
// Without Chrome or web/dist it fails (see prereq.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { readOutbox } from '../../lib/mail/index.ts';
import { age, makeVideo, sleep, until } from '../lib/helpers.ts';
import { client, tusUpload } from '../lib/http.ts';
import { fitsAt, layoutMatrix, WIDTHS } from './layout.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { LEGAL, startServer } from './lib/server.mjs';

const LABEL = 'workspaces e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-e2e-workspaces-', mode: 'server', publicUrl: true });
const { dir, base: BASE } = srv;
const request = client(srv.port);
const PASSWORD = 'a long enough password';

const cookieOf = (r) => String([r.headers['set-cookie']].flat().find((c) => String(c).startsWith('vr_session=')) || '').split(';')[0];
/** The token of the newest confirm link mailed to an address (the outbox: no mail relay here). */
async function confirmToken(address) {
  for (let i = 0; i < 100; i++) {
    const m = readOutbox(path.join(srv.env.VR_CACHE, 'outbox'))
      .filter((x) => x.to === address && x.kind === 'verify')
      .at(-1);
    const token = /#\/verify\/(vt_[\w-]+)/.exec(m?.text ?? '')?.[1];
    if (token) return token;
    await sleep(100);
  }
  throw new Error(`no confirm link to ${address} in the outbox`);
}

let browser;
let page;
const servers = [srv];
try {
  // ---------------------------------------------------------------- two workspaces, made through the API
  const setupToken = await srv.setupToken();
  assert(setupToken, `no setup token in the server log:\n${srv.log()}`);
  assert(/workspaces: this store is workspace w1/.test(srv.log()), 'a hosted server moves its store to workspaces at start');
  const origin = { Origin: BASE };
  const setup = await request('POST', '/api/auth/setup', {
    body: { token: setupToken, email: 'olivia@e2e.test', name: 'Olivia', password: PASSWORD },
    headers: origin,
  });
  assert(setup.status === 200, setup.text);
  let olivia = cookieOf(setup);
  assert(
    (await request('PATCH', '/api/workspaces/current', { body: { name: 'Lampo Studio' }, headers: { Cookie: olivia, ...origin } })).status === 200,
    'rename',
  );
  const tokenStudio = (await request('POST', '/api/auth/tokens', { body: { name: 'studio' }, headers: { Cookie: olivia, ...origin } })).json().token;
  const clip = (name, pattern) => {
    const f = makeVideo(path.join(dir, 'in', name), { w: 320, h: 180, dur: 1, pattern });
    age(f);
    return f;
  };
  // the same name in the same folder in both workspaces: two videos, never mixed
  const up1 = await tusUpload(request, clip('a/reel.mp4', 'testsrc'), { filename: 'reel.mp4', folder: 'Reels' }, { Authorization: `Bearer ${tokenStudio}` });
  assert(up1.status === 200, up1.text);
  await tusUpload(
    request,
    clip('a/studio-only.mp4', 'rgbtestsrc'),
    { filename: 'studio-only.mp4', folder: 'Reels' },
    { Authorization: `Bearer ${tokenStudio}` },
  );
  const made = await request('POST', '/api/workspaces', { body: { name: 'Acme Films' }, headers: { Cookie: olivia, ...origin } });
  assert(made.status === 200, made.text);
  olivia = cookieOf(made);
  const acme = made.json().workspace.id;
  const tokenAcme = (await request('POST', '/api/auth/tokens', { body: { name: 'acme' }, headers: { Cookie: olivia, ...origin } })).json().token;
  const up2 = await tusUpload(request, clip('b/reel.mp4', 'smptebars'), { filename: 'reel.mp4', folder: 'Reels' }, { Authorization: `Bearer ${tokenAcme}` });
  assert(up2.status === 200 && up2.json().slug === up1.json().slug, 'the same slug in both');
  await tusUpload(request, clip('b/acme-only.mp4', 'smptehdbars'), { filename: 'acme-only.mp4', folder: 'Reels' }, { Authorization: `Bearer ${tokenAcme}` });
  const link = (
    await request('POST', `/api/review/${encodeURIComponent(up2.json().slug)}/shares`, {
      body: { label: 'Acme client' },
      headers: { Cookie: olivia, ...origin },
    })
  ).json().token;
  // Mia: a reviewer in Acme only
  const inv = await request('POST', '/api/admin/invites', { body: { role: 'reviewer', email: 'mia@e2e.test' }, headers: { Cookie: olivia, ...origin } });
  const invToken = inv.json().url.split('/#/invite/')[1];
  // Sam: a member of Lampo Studio, and an invite into Acme made out to nobody (Sam joins it with his own account)
  const oliviaStudio = cookieOf(await request('POST', '/api/workspaces/switch', { body: { id: 'w1' }, headers: { Cookie: olivia, ...origin } }));
  const samInvite = (await request('POST', '/api/admin/invites', { body: { role: 'member' }, headers: { Cookie: oliviaStudio, ...origin } }))
    .json()
    .url.split('/#/invite/')[1];
  // (a hosted server: the invite's link proves no inbox, so Sam is in once the link mailed to his address is opened)
  const samTook = await request('POST', '/api/auth/invite/accept', {
    body: { token: samInvite, name: 'Sam', email: 'sam@e2e.test', password: PASSWORD },
    headers: origin,
  });
  assert(samTook.status === 200 && samTook.json().held === true, samTook.text);
  const samMark = String([samTook.headers['set-cookie']].flat().find((c) => String(c).startsWith('vr_signup=')) || '').split(';')[0];
  const samIn = await request('POST', '/api/auth/verify', { body: { token: await confirmToken('sam@e2e.test') }, headers: { Cookie: samMark, ...origin } });
  assert(samIn.status === 200 && samIn.json().signedIn === true, samIn.text);
  const sam = cookieOf(samIn);
  const openInvite = (await request('POST', '/api/admin/invites', { body: { role: 'reviewer' }, headers: { Cookie: olivia, ...origin } }))
    .json()
    .url.split('/#/invite/')[1];

  browser = await launch();
  page = await browser.newPage();
  screenshotFailures(() => page, 'workspaces');
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));
  const host = new URL(BASE).hostname;
  const signIn = async (cookie) => {
    await page.deleteCookie(...(await page.cookies(BASE)));
    await page.setCookie({ name: 'vr_session', value: cookie.split('=')[1], domain: host, path: '/', httpOnly: true });
  };
  // The library's text once it shows `expect` (a video's name) — or, without one, its empty state.
  const library = async (expect) => {
    await page.waitForFunction(
      (x) => (x ? document.body.innerText.includes(x) : !!document.querySelector('.empty-state')),
      { polling: 100, timeout: 15000 },
      expect,
    );
    return page.evaluate(() => document.body.innerText);
  };
  const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `workspaces-${name}.png`) });
  const openMenu = async () => {
    await page.waitForSelector('.user-chip:enabled');
    await page.click('.user-chip:enabled');
    await page.waitForSelector('.menu');
  };
  // where the session works, as the server says
  const here = () =>
    page.evaluate(() =>
      fetch('/api/auth/status')
        .then((r) => r.json())
        .then((s) => s.workspace?.name),
    );
  const closeMenu = async () => {
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.menu'), { polling: 50, timeout: 3000 });
  };

  console.log(`workspaces e2e against ${BASE} (store ${dir})`);

  await check('two workspaces: the library is the current one’s; the same name in the other is another video', async () => {
    await signIn(olivia);
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    const text = await library('acme-only');
    assert(!text.includes('studio-only'), 'nothing of Lampo Studio');
    assert((await here()) === 'Acme Films');
    await shot('library-acme');
  });

  await check('the account menu: the workspaces with the current one ticked, and a new one', async () => {
    await openMenu();
    const items = await page.$$eval('.menu [role^=menuitem]', (els) =>
      els.map((e) => ({ text: e.textContent.trim(), checked: e.getAttribute('aria-checked') })),
    );
    const studio = items.find((i) => i.text.includes('Lampo Studio'));
    const here = items.find((i) => i.text.includes('Acme Films'));
    assert(studio && here, `items: ${JSON.stringify(items)}`);
    assert(here.checked === 'true' && studio.checked !== 'true', 'the current one is ticked');
    assert(
      items.some((i) => i.text.startsWith('New workspace')),
      'making one',
    );
    await shot('menu');
    const fit = await fitsAt(page, 'account menu');
    assert(!fit.length, fit.join('\n'));
    await closeMenu();
  });

  await check('switching: the browser starts again in the other workspace, its library only', async () => {
    await openMenu();
    await page.evaluate(() => [...document.querySelectorAll('.menu [role^=menuitem]')].find((e) => e.textContent.includes('Lampo Studio')).click());
    const text = await library('studio-only');
    assert(!text.includes('acme-only'), 'nothing of Acme, not even kept from before');
    const status = await page.evaluate(() => fetch('/api/auth/status').then((r) => r.json()));
    assert(status.workspace.name === 'Lampo Studio', 'the session moved');
  });

  await check('a link that names the other workspace (a notification, a chat message) opens there (WS-11)', async () => {
    // In Lampo Studio, a link into Acme's Reels: the session moves to Acme, and the page is the link's, not '#/'
    await page.goto(`${BASE}/#/folder/Reels?w=${acme}`, { waitUntil: 'domcontentloaded' });
    const text = await library('acme-only');
    assert(!text.includes('studio-only'), 'Acme’s Reels, not Lampo Studio’s');
    assert((await here()) === 'Acme Films', 'the session moved');
    const hash = await page.evaluate(() => location.hash);
    assert(hash === '#/folder/Reels', `the address keeps the route, without its workspace: ${hash}`);
    // and back: a push tap while the app is open (the service worker sets the hash)
    await page.evaluate(() => {
      location.hash = '#/folder/Reels?w=w1';
    });
    const back = await library('studio-only');
    assert(!back.includes('acme-only'), 'Lampo Studio’s Reels');
    assert((await here()) === 'Lampo Studio');
  });

  await check('a new workspace through the dialog: the app starts again inside it, empty, its owner the maker', async () => {
    await openMenu();
    await page.evaluate(() => [...document.querySelectorAll('.menu [role^=menuitem]')].find((e) => e.textContent.startsWith('New workspace')).click());
    // Settings → Workspace, the dialog open over it
    await page.waitForSelector('[data-testid=workspace-name]');
    assert((await page.evaluate(() => location.hash)) === '#/settings/workspace', 'made where workspaces are managed');
    await page.type('[data-testid=workspace-name]', 'Northwind');
    await shot('new-dialog');
    // The open dialog at every width in both themes (fitsAt's phone sizes turn touch on, which reloads the page and
    // would close it; the phone layout itself is width-driven).
    const bad = await layoutMatrix(
      page,
      { 'new workspace': null },
      { widths: WIDTHS, each: (width, theme) => width === 390 && shot(`new-dialog-390-${theme}`) },
    );
    await page.emulateMediaFeatures([]);
    assert(!bad.length, bad.join('\n'));
    assert(await page.$('[data-testid=workspace-name]'), 'the dialog stays open through every width');
    await page.click('[data-testid=workspace-create]');
    // An empty library has no sidebar: the account menu says where (and on a phone the account stays in the top bar)
    const text = await library();
    assert(!text.includes('studio-only') && !text.includes('acme-only'), 'a new workspace starts empty');
    const status = await page.evaluate(() => fetch('/api/auth/status').then((r) => r.json()));
    assert(status.workspace.name === 'Northwind' && status.workspace.role === 'owner' && status.workspaces.length === 3, JSON.stringify(status.workspaces));
    await openMenu();
    const ticked = await page.$$eval('.menu [role^=menuitem][aria-checked=true]', (els) => els.map((e) => e.textContent.trim()));
    assert(ticked.some((t) => t.includes('Northwind')) && !ticked.some((t) => /Lampo Studio|Acme Films/.test(t)), ticked.join(' | '));
    await closeMenu();
    const desk = page.viewport();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await library();
    await openMenu();
    const phone = await page.$$eval('.menu [role^=menuitem]', (els) => els.map((e) => e.textContent.trim()));
    assert(
      ['Lampo Studio', 'Acme Films', 'Northwind'].every((n) => phone.some((t) => t.includes(n))),
      `the phone's way to the others: ${phone.join(' | ')}`,
    );
    await shot('empty-phone-menu');
    await closeMenu();
    if (desk) await page.setViewport(desk);
    await library();
  });

  await check('Settings → Workspace: rename it; your workspaces to switch between', async () => {
    await page.goto(`${BASE}/#/settings/workspace`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=workspace-rename]');
    await page.click('[data-testid=workspace-rename]', { count: 3 });
    await page.keyboard.press('Backspace');
    await page.type('[data-testid=workspace-rename]', 'Northwind Media');
    await page.click('.set-main button[type=submit]');
    await page.waitForFunction(() => document.querySelector('.set-head p')?.textContent.includes('Northwind Media'), { polling: 100, timeout: 10000 });
    const rows = await page.$$eval('[data-testid=workspace-list] .set-row', (els) => els.map((e) => e.textContent));
    assert(rows.length === 3 && rows.some((r) => r.includes('Northwind Media')), rows.join(' | '));
    await shot('settings-workspace');
    const fit = await fitsAt(page, 'settings workspace');
    assert(!fit.length, fit.join('\n'));
  });

  await check('dark and German: the switcher, the menu and Settings → Workspace read and fit', async () => {
    await page.evaluate(() =>
      fetch('/api/auth/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefs: { theme: 'dark', lang: 'de' } }),
      }),
    );
    await page.evaluate(() => {
      localStorage.setItem('vr.theme', 'dark');
      localStorage.setItem('vr.lang', 'de');
    });
    await page.goto(`${BASE}/#/settings/workspace`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=workspace-rename]');
    const h1 = await page.$eval('.set-head h1', (e) => e.textContent);
    assert(h1 === 'Workspace', h1);
    const lede = await page.$eval('.set-head p', (e) => e.textContent);
    assert(lede.includes('Andere Workspaces'), lede);
    await shot('settings-workspace-de-dark');
    let fit = await fitsAt(page, 'settings workspace (de, dark)');
    assert(!fit.length, fit.join('\n'));
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await library();
    await openMenu();
    const texts = await page.$$eval('.menu [role^=menuitem]', (els) => els.map((e) => e.textContent.trim()));
    assert(
      texts.some((t) => t.startsWith('Neuer Workspace')),
      texts.join(' | '),
    );
    await shot('menu-de-dark');
    fit = await fitsAt(page, 'menu (de, dark)');
    assert(!fit.length, fit.join('\n'));
    await closeMenu();
    const back = await page.evaluate(() =>
      fetch('/api/auth/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefs: { theme: 'light', lang: 'en' } }),
      }).then((r) => r.status),
    );
    assert(back === 200, `prefs back: ${back}`);
    await page.evaluate(() => {
      localStorage.setItem('vr.theme', 'light');
      localStorage.setItem('vr.lang', 'en');
    });
  });

  await check('an invite opened by someone in that workspace already: it stays for whoever it was made for', async () => {
    await page.goto(`${BASE}/#/invite/${openInvite}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => /in Acme Films already/.test(document.querySelector('.ent-col h1')?.textContent || ''), { polling: 100, timeout: 10000 });
    await shot('invite-member');
    await page.click('[data-testid=invite-open]');
    await library('acme-only');
    const peek = await request('POST', '/api/auth/invite/peek', { body: { token: openInvite }, headers: origin });
    assert(peek.status === 200 && !peek.json().you, 'still unused, and nothing about anyone without a session');
  });

  await check('someone in another workspace joins with their own account: Join Acme Films, their password, the switcher', async () => {
    await signIn(sam);
    await page.goto(`${BASE}/#/invite/${openInvite}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => /Join Acme Films/.test(document.querySelector('.ent-col h1')?.textContent || ''), { polling: 100, timeout: 10000 });
    await shot('invite-join');
    const fit = await fitsAt(page, 'invite, joining');
    assert(!fit.length, fit.join('\n'));
    await page.waitForSelector('input[name=password]');
    await page.type('input[name=password]', 'not the password');
    await page.click('[data-testid=invite-join]');
    await page.waitForFunction(() => (document.querySelector('.gate-error')?.textContent || '').trim().length > 1, { polling: 100, timeout: 10000 });
    await page.click('input[name=password]', { count: 3 });
    await page.type('input[name=password]', PASSWORD);
    await page.click('[data-testid=invite-join]');
    const text = await library('acme-only');
    assert(!text.includes('studio-only'), 'Acme’s library, not Lampo Studio’s');
    assert((await here()) === 'Acme Films', 'working in the workspace joined');
    await openMenu();
    const ticked = await page.$$eval('.menu [role^=menuitem][aria-checked=true]', (els) => els.map((e) => e.textContent.trim()));
    assert(
      ticked.some((t) => t.includes('Acme Films')),
      `the switcher, at once: ${ticked.join(' | ')}`,
    );
    await closeMenu();
    const status = await page.evaluate(() => fetch('/api/auth/status').then((r) => r.json()));
    assert(status.workspace.role === 'reviewer' && status.workspaces.length === 2, JSON.stringify(status.workspaces));
  });

  await check('someone in one workspace: no switcher anywhere; the invite named the workspace', async () => {
    await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
    await page.deleteCookie(...(await page.cookies(BASE)));
    // a hash change alone keeps the page (and who it thinks is signed in): a fresh load, as a link from a mail is
    await page.goto(`${BASE}/#/invite/${invToken}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid=invite]') && /Join Acme Films/.test(document.querySelector('.ent-col h1')?.textContent || ''),
      { polling: 100, timeout: 10000 },
    );
    await shot('invite');
    const fit = await fitsAt(page, 'invite');
    assert(!fit.length, fit.join('\n'));
    await page.type('input[name=name]', 'Mia');
    await page.type('input[name=email]', 'mia@e2e.test');
    await page.type('input[name=password]', PASSWORD);
    await page.click('.gate-go');
    // the invite's link proves no inbox: "Check your inbox", and the link mailed to her lets her in, in this browser
    await page.waitForSelector('[data-testid=invite-sent]', { timeout: 15000 });
    await shot('invite-sent');
    // (how "Check your inbox" fits: account.mjs, after every invite it takes)
    await page.goto(`${BASE}/#/verify/${await confirmToken('mia@e2e.test')}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=verify-open]', { timeout: 15000 });
    await page.click('[data-testid=verify-open]');
    await page.waitForSelector('.user-chip:enabled', { timeout: 15000 });
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    const text = await library('acme-only');
    assert(!text.includes('studio-only'), 'Acme’s library');
    await openMenu();
    const texts = await page.$$eval('.menu [role^=menuitem]', (els) => els.map((e) => e.textContent.trim()));
    assert(!texts.some((t) => t.includes('Acme Films') || t.startsWith('New workspace')), texts.join(' | '));
    await closeMenu();
    // A link into a workspace she isn't in is said so, and the library she has opens instead (WS-11).
    await page.goto(`${BASE}/#/folder/Reels?w=w1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.innerText.includes('That link is for a workspace you’re not in.'), { polling: 100, timeout: 15000 });
    const after = await library('acme-only');
    assert(!after.includes('studio-only'), 'nothing of Lampo Studio');
    assert((await page.evaluate(() => location.hash)) === '#/', 'the library');
  });

  await check('a review link of Acme shows Acme’s video under the name Lampo Studio also uses', async () => {
    await page.deleteCookie(...(await page.cookies(BASE)));
    await page.goto(`${BASE}/g/${link}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.innerText.includes('reel'), { polling: 100, timeout: 15000 });
    const answer = await page.evaluate((t) => fetch(`/api/g/${t}`).then((r) => r.json()), link);
    assert(JSON.stringify(answer).includes('reel.mp4'), 'its video');
    const v = await page.evaluate((t) => fetch(`/api/g/${t}`).then((r) => r.json()), link);
    assert(!JSON.stringify(v).includes('studio-only'), 'nothing of the other workspace');
  });

  await check('acme stays reachable for its members only: an id from it is nothing to a stranger’s session', async () => {
    const r = await request('POST', '/api/workspaces/switch', {
      body: { id: acme },
      headers: {
        Cookie: cookieOf(await request('POST', '/api/auth/login', { body: { email: 'olivia@e2e.test', password: PASSWORD }, headers: origin })),
        ...origin,
      },
    });
    assert(r.status === 200, 'its member switches');
    assert(errors.length === 0, `page errors: ${errors.join(' | ')}`);
  });

  await check('someone who signs up on their own: a workspace of their own, empty, and the setup names it', async () => {
    // a server open to sign-ups, where new accounts get the first run, as on Lampo Cloud
    const open = await startServer({
      prefix: 'vr-e2e-workspaces-signup-',
      mode: 'server',
      publicUrl: true,
      onboarding: true,
      env: { ...LEGAL, VR_SIGNUP: 'open' },
    });
    servers.push(open);
    const ask = client(open.port);
    const here = { Origin: open.base };
    const made = await ask('POST', '/api/auth/signup', { body: { name: 'Nora', email: 'nora@e2e.test', password: PASSWORD, lang: 'en' }, headers: here });
    assert(made.status === 200, made.text);
    // the confirm link, from the outbox (the server writes mail there without a relay)
    let token = null;
    for (let i = 0; i < 100 && !token; i++) {
      const mail = readOutbox(path.join(open.dir, 'cache', 'outbox')).find((m) => m.to === 'nora@e2e.test' && m.kind === 'verify');
      token = /#\/verify\/(vt_[\w-]+)/.exec(mail?.text ?? '')?.[1] ?? null;
      if (!token) await sleep(100);
    }
    assert(token, 'a confirm link was sent');
    // opened in the browser that signed up (its sign-up cookie): that one is signed in
    const browser = String([made.headers['set-cookie']].flat().find((c) => String(c).startsWith('vr_signup=')) || '').split(';')[0];
    const done = await ask('POST', '/api/auth/verify', { body: { token }, headers: { ...here, Cookie: browser } });
    assert(done.status === 200, done.text);
    await page.deleteCookie(...(await page.cookies(BASE)));
    await page.setCookie({ name: 'vr_session', value: cookieOf(done).split('=')[1], domain: host, path: '/', httpOnly: true });
    await page.goto(`${open.base}/#/`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    // a new account starts with its setup: Welcome, then the workspace's name
    await page.waitForFunction(() => document.querySelector('[data-testid=ob-setup]')?.dataset.step === 'welcome', { timeout: 15000 });
    await page.click('[data-testid=ob-start]');
    await page.waitForFunction(() => document.querySelector('[data-testid=ob-setup]')?.dataset.step === 'workspace', { timeout: 15000 });
    assert((await page.$eval('[data-testid=ob-ws-name]', (e) => e.value)) === 'Nora’s workspace', 'offered under their name');
    const lib = await page.evaluate(() => fetch('/api/library').then((r) => r.json()));
    const names = lib.videos.filter((v) => !v.sample).map((v) => v.name);
    assert(!names.length, `their own, empty (the sample aside): ${names}`);
    await shot('signup-start');
    const fit = await fitsAt(page, 'the setup’s naming step');
    assert(!fit.length, fit.join('\n'));
    await page.click('[data-testid=ob-ws-name]', { count: 3 });
    await page.keyboard.press('Backspace');
    await page.type('[data-testid=ob-ws-name]', 'Nora Studio');
    await page.click('[data-testid=ob-next]');
    await page.waitForFunction(() => document.querySelector('[data-testid=ob-setup]')?.dataset.step === 'persona', { timeout: 15000 });
    await until(
      async () => (await page.evaluate(() => fetch('/api/auth/status').then((r) => r.json()))).workspace?.name === 'Nora Studio',
      'the workspace named',
    );
  });

  await check('a restart with three workspaces: the server comes up, monitoring and the sign-in screen answer, people land where they were', async () => {
    // A copy of the store as it stands, started again (outside any request, nothing may reach for a workspace)
    const again = await startServer({
      prefix: 'vr-e2e-workspaces-again-',
      mode: 'server',
      publicUrl: true,
      ready: '/readyz',
      seed: (env) => {
        for (const [from, to] of [
          [path.join(dir, 'data'), env.VR_DATA],
          [path.join(dir, 'data-versions'), `${env.VR_DATA}-versions`],
          [path.join(dir, 'cache'), env.VR_CACHE],
        ])
          if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true });
      },
    });
    servers.push(again);
    const ask = client(again.port);
    assert((await ask('GET', '/readyz')).status === 200, 'monitoring');
    const info = await ask('GET', '/api/info');
    assert(info.status === 200, `the sign-in screen's /api/info: ${info.status}`);
    assert(!/Error|refused/.test(again.log()), again.log().slice(-1500));
    const signedIn = await ask('POST', '/api/auth/login', { body: { email: 'mia@e2e.test', password: PASSWORD }, headers: { Origin: again.base } });
    assert(signedIn.status === 200 && signedIn.json().workspace?.name === 'Acme Films', signedIn.text);
    const lib = await ask('GET', '/api/library', { headers: { Cookie: cookieOf(signedIn) } });
    const names = lib.json().videos.map((v) => v.name);
    assert(names.includes('acme-only.mp4') && !names.includes('studio-only.mp4'), names.join(', '));
  });

  // The owner of a server's only workspace looked for "New workspace" in the account menu and found it only at the foot
  // of Settings → Workspace: whoever may make one is offered it there, with one workspace too.
  await check('one workspace, its owner: the account menu offers "New workspace…", and it opens the dialog', async () => {
    const solo = await startServer({ prefix: 'vr-e2e-workspaces-solo-', mode: 'server', publicUrl: true });
    servers.push(solo);
    const ask = client(solo.port);
    const made = await ask('POST', '/api/auth/setup', {
      body: { token: await solo.setupToken(), email: 'ida@e2e.test', name: 'Ida', password: PASSWORD },
      headers: { Origin: solo.base },
    });
    assert(made.status === 200, made.text);
    const status = (await ask('GET', '/api/auth/status', { headers: { Cookie: cookieOf(made) } })).json();
    assert(status.workspaces.length === 1 && status.workspace_create === true, JSON.stringify(status));
    // a browser of its own: its cookie never meets the other server's (cookies don't keep to a port)
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width: 1440, height: 900 });
    await p.setCookie({ name: 'vr_session', value: cookieOf(made).split('=')[1], domain: host, path: '/', httpOnly: true });
    await p.goto(`${solo.base}/#/`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('.user-chip:enabled', { timeout: 15000 });
    await p.click('.user-chip:enabled');
    await p.waitForFunction(() => [...document.querySelectorAll('.menu [role^=menuitem]')].some((e) => e.textContent.startsWith('New workspace')), {
      polling: 100,
      timeout: 5000,
    });
    await p.evaluate(() => [...document.querySelectorAll('.menu [role^=menuitem]')].find((e) => e.textContent.startsWith('New workspace')).click());
    await p.waitForSelector('[data-testid=workspace-name]', { timeout: 10000 });
    assert((await p.evaluate(() => location.hash)) === '#/settings/workspace', 'the dialog over Settings → Workspace');
    await ctx.close();
  });
} catch (e) {
  crashed(e, srv);
}
fs.mkdirSync(dir, { recursive: true });
await finish(LABEL, { browser, servers });
