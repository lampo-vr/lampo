#!/usr/bin/env node
// covers: web/src/auth/ web/src/settings/Users.tsx web/src/settings/Profile.tsx web/src/settings/Notifications.tsx
// covers: web/src/styles/account.css web/src/styles/auth.css server/routes/account.ts server/accountMail.ts
// covers: server/signup.ts server/auth.ts lib/auth.ts lib/accountLinks.ts lib/newPassword.ts lib/mail/
// Accounts and email in the browser (server mode, VR_SIGNUP=invite, no mail relay: every message lands in the server's
// outbox and is read back from there — nothing is sent anywhere):
//   invite by email → the emailed link → "Check your inbox" → the outbox's confirm link → in;
//   sign up with an invite → the address only → the invite again → its link → the confirm link → in;
//   open sign-up (a second server, VR_SIGNUP=open) → "Check your inbox" (held: nothing else reachable) → the outbox's
//   confirm link → in;
//   Forgot password? → the outbox's reset link → a new password → the old session is gone;
//   used, expired and cut-off links say so; a phone fits every screen.
// Screenshots of every screen (light and dark, English and German, phone to wide desktop) go to VR_SHOTS when set.
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from '../lib/helpers.ts';
import { faintText, fitsAt, settle } from './layout.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { LEGAL, startServer } from './lib/server.mjs';

const LABEL = 'account e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const { readOutbox } = await import('../../lib/mail/index.ts');

const srv = await startServer({
  prefix: 'vr-e2e-account-',
  mode: 'server',
  publicUrl: true,
  env: { VR_SIGNUP: 'invite', VR_IMPRINT_URL: LEGAL.VR_IMPRINT_URL, VR_TERMS_URL: LEGAL.VR_TERMS_URL, VR_PRIVACY_URL: LEGAL.VR_PRIVACY_URL },
});
const { base: BASE } = srv;
const OUTBOX = path.join(srv.env.VR_CACHE, 'outbox');
const OWNER = { name: 'Olivia Hart', email: 'olivia@e2e.test', password: 'olivias long password' };

/** A server open to sign-ups (held accounts come from there), started by the check that needs it. */
let open = null;
const openOutbox = () => path.join(open.env.VR_CACHE, 'outbox');

/** The newest message of `kind` to `to` written after `since` (ms), waited for. */
async function mail(to, kind, since, outbox = OUTBOX) {
  for (let i = 0; i < 100; i++) {
    const m = readOutbox(outbox)
      .filter((x) => x.to === to && x.kind === kind && Date.parse(x.at) >= since)
      .at(-1);
    if (m) return m;
    await sleep(100);
  }
  throw new Error(`no ${kind} email to ${to} in the outbox`);
}
const linkIn = (m, base = BASE) => {
  const url = /https?:\/\/\S+#\/(?:verify|reset|invite)\/[\w-]+/.exec(m.text)?.[0];
  assert(url, `no link in: ${m.text}`);
  assert(url.startsWith(`${base}/#/`), `the link is built from the public URL: ${url}`);
  return url;
};
const text = (page) => page.evaluate(() => document.body.innerText);
const waitText = (page, s, timeout = 15000) => page.waitForFunction((s) => document.body.innerText.includes(s), { timeout, polling: 100 }, s);
async function type(page, selector, value) {
  await page.waitForSelector(selector, { timeout: 15000 });
  await page.click(selector, { count: 3 });
  await page.type(selector, value);
}
const clickText = async (page, selector, label) => {
  const els = await page.$$(selector);
  for (const el of els) if ((await el.evaluate((e) => e.textContent || '')).includes(label)) return el.click();
  throw new Error(`no ${selector} saying “${label}”`);
};
async function fits(page, where) {
  const bad = await fitsAt(page, where);
  assert(!bad.length, bad.join('\n'));
}
/**
 * After taking an invite on a hosted server (its link proves no inbox: whoever made it holds it too): "Check your
 * inbox", and the link mailed to the address lets the person in, in this browser.
 */
async function inFromInbox(page, address, since, name) {
  await page.waitForSelector('[data-testid=invite-sent]', { timeout: 15000 });
  assert((await text(page)).includes(address), 'it says where the link went');
  if (name) {
    await fits(page, 'invite, check your inbox');
    await shoot(page, name);
  }
  const m = await mail(address, 'verify', since);
  await page.goto(linkIn(m), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid=verify-open]', { timeout: 15000 });
  await page.click('[data-testid=verify-open]');
}

/**
 * Every look of the screen that is open: phone to wide desktop, light and dark (and German when asked). Plain viewports:
 * Puppeteer reloads the page when `isMobile` changes, which would empty a form being filled in.
 */
const SIZES = [
  [390, 844],
  [768, 1024],
  [1024, 768],
  [1440, 900],
  [1920, 1080],
];
async function shoot(page, name, { german = false } = {}) {
  if (!SHOTS) return;
  const own = page.viewport();
  for (const theme of ['light', 'dark']) {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
    for (const [width, height] of SIZES) {
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      await sleep(250);
      await page.screenshot({ path: path.join(SHOTS, `account-${name}${german ? '-de' : ''}-${theme}-${width}.png`) });
    }
  }
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  if (own) await page.setViewport(own);
}

let browser;
try {
  const setupToken = await srv.setupToken();
  assert(setupToken, `no setup token in the server log:\n${srv.log()}`);
  assert(/mail: LAMPO_SMTP_URL is not set/.test(srv.log()), 'the server warns that nothing is sent');
  const setup = await fetch(`${BASE}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ token: setupToken, ...OWNER }),
  });
  assert(setup.ok, `setup failed: ${setup.status}`);
  const ownerCookie = String(setup.headers.get('set-cookie')).split(';')[0];
  const asOwner = (url, body) =>
    fetch(`${BASE}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie: ownerCookie }, body: JSON.stringify(body) });

  browser = await launch();
  /** A fresh browser profile: its own cookies and storage (another person, another device). */
  const fresh = async () => {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    return page;
  };
  const owner = await fresh();
  screenshotFailures(() => owner, 'account');
  await owner.setCookie({ name: 'vr_session', value: ownerCookie.split('=')[1], url: BASE });

  // The way in loads as itself: the column is drawn at once where it stays (its loading state is the screen, the words
  // still on their way held in place), so nothing moves when /api/info, an invite or the film's still arrive; the film
  // has its own tones from the first paint.
  await check('a first paint is the screen itself: nothing moves as /api/info, the invite and the film’s still arrive', async () => {
    const invite = (await (await asOwner('/api/admin/invites', { role: 'member' })).json()).url.split('/#/invite/')[1];
    const out = [];
    for (const [where, url] of [
      ['sign-in', `${BASE}/#/`],
      ['invite', `${BASE}/#/invite/${invite}`],
    ]) {
      const page = await fresh();
      await page.evaluateOnNewDocument(() => {
        window.__shift = 0;
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) window.__shift += e.value;
        }).observe({ type: 'layout-shift', buffered: true });
      });
      await page.setRequestInterception(true);
      let release;
      const held = new Promise((r) => {
        release = r;
      });
      page.on('request', async (r) => {
        const u = r.url();
        if (/\/api\/(info|auth\/invite\/peek)\b/.test(u) || /\/assets\/(poster|strip)-[\w-]+\.webp$/.test(u)) await held;
        await r.continue().catch(() => {});
      });
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.ent-col .gate-go');
      await sleep(300);
      const at = () =>
        page.evaluate(() => {
          const top = (sel) => Math.round(document.querySelector(sel)?.getBoundingClientRect().top ?? -1);
          return {
            h1: top('.ent-col h1'),
            go: top('.ent-col .gate-go'),
            words: document.querySelector('.ent-col')?.innerText ?? '',
            // the still is held back: the film's own tones stand in for it (entrance.css .ent-view::before)
            tones: getComputedStyle(document.querySelector('.ent-view'), '::before').backgroundImage.startsWith('url("data:image/webp'),
          };
        });
      const before = await at();
      release();
      await page.waitForSelector(where === 'sign-in' ? '[data-testid=forgot-link]' : '[data-testid=invite]', { timeout: 15000 });
      await page.waitForSelector('.ent-film[data-still]', { timeout: 15000 });
      await sleep(500);
      const after = await at();
      const shift = await page.evaluate(() => window.__shift);
      if (Math.abs(before.h1 - after.h1) > 1 || Math.abs(before.go - after.go) > 1) out.push(`${where}: the column moved ${JSON.stringify([before, after])}`);
      if (shift > 0.001) out.push(`${where}: layout shift ${shift.toFixed(4)} while it loaded`);
      if (!before.tones) out.push(`${where}: a black box where the still comes`);
      // a server with sign-up by invite never says "Ask whoever runs this server" first
      if (/Ask whoever runs this server/.test(before.words)) out.push(`${where}: the sign-up-off sentence before /api/info answered`);
      await page.browserContext().close();
    }
    assert(!out.length, out.join('\n'));
  });

  // A tablet's column stays a reading width in the middle of the room (it stretched to 720 px); a wide screen draws the
  // film at most 1.2× (at 1.5× its 10 px labels stood larger than the form's words); the fine print people read (the
  // password's rule, the terms, the foot) is never set in --faint, under AA.
  await check('the entrance at a tablet and a wide screen; its fine print in AA contrast', async () => {
    const page = await fresh();
    const out = [];
    for (const [width, height] of [
      [768, 1024],
      [2560, 1440],
    ]) {
      await page.setViewport({ width, height });
      await page.goto(`${BASE}/#/signup`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.ent-col .gate-go');
      await settle(page);
      const m = await page.evaluate(() => {
        const c = document.querySelector('.ent-col').getBoundingClientRect();
        const scale = Number(getComputedStyle(document.querySelector('.ent-film')).getPropertyValue('--s'));
        return { width: Math.round(c.width), mid: Math.round(c.left + c.width / 2), page: innerWidth / 2, scale };
      });
      if (width === 768 && (m.width > 440 || Math.abs(m.mid - m.page) > 2)) out.push(`@768: the column is ${m.width} px wide, its middle at ${m.mid}`);
      if (width === 2560 && m.scale > 1.2) out.push(`@2560: the film is drawn at ${m.scale}×`);
    }
    await page.setViewport({ width: 1440, height: 900 });
    for (const hash of ['#/', '#/signup']) {
      await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.ent-col .gate-go');
      await settle(page);
      for (const f of await faintText(page)) out.push(`${hash}: ${f}`);
    }
    await page.browserContext().close();
    assert(!out.length, out.join('\n'));
  });

  await check('invite by email: Settings → Users sends it, its link and then the address’s confirm link let the person in', async () => {
    await owner.goto(`${BASE}/#/settings/users`, { waitUntil: 'domcontentloaded' });
    await waitText(owner, 'Invite someone');
    assert((await text(owner)).includes('This server has no mail relay'), 'admins are told emails wait in the outbox');
    await type(owner, 'input[type=email]', 'mia@e2e.test');
    await waitText(owner, 'It goes to mia@e2e.test');
    const since = Date.now();
    await clickText(owner, 'button[type=submit]', 'Send invite');
    await owner.waitForSelector('[data-testid=invite-emailed]', { timeout: 15000 });
    await shoot(owner, 'invite-sent');
    await owner.keyboard.press('Escape');
    const m = await mail('mia@e2e.test', 'invite', since);
    assert(m.subject === `An invite to Lampo on ${new URL(BASE).host}`, m.subject);
    assert(m.text.includes('From an account named “Olivia Hart”.'), m.text);
    await waitText(owner, 'emailed');
    await fits(owner, 'users');
    await shoot(owner, 'users');
    const mia = await fresh();
    await mia.goto(linkIn(m), { waitUntil: 'domcontentloaded' });
    await waitText(mia, 'You’re invited');
    await type(mia, 'input[name=name]', 'Mia Keller');
    await type(mia, 'input[name=email]', 'mia@e2e.test');
    await type(mia, 'input[name=password]', 'mias first password');
    const took = Date.now();
    await mia.keyboard.press('Enter');
    await inFromInbox(mia, 'mia@e2e.test', took, 'invite-check-inbox');
    await mia.waitForSelector('.lib-scroll, [data-testid=library]', { timeout: 15000 });
    await mia.browserContext().close();
  });

  await check('a resend from the list sends the invite again', async () => {
    const r = await asOwner('/api/admin/invites', { role: 'reviewer', email: 'noa@e2e.test', send: true, lang: 'de' });
    assert(r.ok, `invite: ${r.status}`);
    await owner.reload({ waitUntil: 'domcontentloaded' });
    await waitText(owner, 'noa@e2e.test');
    const since = Date.now();
    const send = await owner.$('button[aria-label="Email the invite to noa@e2e.test again"]');
    assert(send, 'a Send again button on the row');
    await send.click();
    const m = await mail('noa@e2e.test', 'invite', since);
    assert(m.lang === 'en', 'sent again in the language of the page that sent it');
  });

  await check(
    'the sign-in is the review link’s entrance: the film beside it, boxed fields, an eye, a kept error line, an orange way in that says what is missing, the operator’s legal pages at the foot',
    async () => {
      const page = await fresh();
      await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.ent-col .gate-go');
      // what the server offers is said once /api/info answers ("Forgot password?" held in its place until then)
      await page.waitForSelector('[data-testid=forgot-link]');
      const look = await page.evaluate(() => {
        const go = document.querySelector('.ent-col .gate-go');
        const film = document.querySelector('.entrance > .ent-film');
        const col = document.querySelector('.ent-col');
        return {
          inputs: [...document.querySelectorAll('.ent-col input:not([hidden])')].map((i) => [i.name, i.className, !!i.closest('.inv-field')]),
          eyes: [...document.querySelectorAll('.ent-col input[type=password]')].map((i) => !!i.closest('.inv-field')?.querySelector('.inv-eye')),
          error: document.querySelector('.ent-col .gate-error')?.textContent.trim(),
          disabled: go.disabled,
          plain: !go.querySelector('svg'),
          // the film on the left, decoration only; the form on the right
          split: film?.getAttribute('aria-hidden') === 'true' && film.getBoundingClientRect().right <= col.getBoundingClientRect().left,
          themes: document.querySelectorAll('.ent-top .theme-button').length,
          switches: document.querySelectorAll('.ent-top .theme-switch').length,
          foot: document.querySelector('.ent-foot .ent-foot-line')?.textContent,
          legal: [...document.querySelectorAll('.ent-foot [data-testid=ent-legal] a')].map((a) => [a.textContent, a.getAttribute('href'), a.rel]),
          code: document.querySelector('.ent-fine .ent-cmd code')?.textContent,
          closed: document.querySelector('.ent-disc')?.getAttribute('aria-expanded') === 'false',
          unreachable: getComputedStyle(document.querySelector('.ent-disc-body > div')).visibility === 'hidden',
        };
      });
      assert(
        look.inputs.every(([, cls, boxed]) => cls.includes('gate-input') && boxed),
        `every field is the gate's boxed field: ${JSON.stringify(look.inputs)}`,
      );
      assert(look.eyes.length === 1 && look.eyes.every(Boolean), `an eye on every password: ${JSON.stringify(look.eyes)}`);
      assert(look.error === '', 'the error line is there, empty');
      assert(!look.disabled && look.plain, 'the way in: enabled while the form is empty, its words alone');
      assert(look.split, 'the brand film on the left (aria-hidden), the form on the right');
      assert(look.themes === 1 && look.switches === 0, `one theme button at the top, like the gate (${look.themes}, ${look.switches})`);
      assert(look.foot?.includes(new URL(BASE).host), `the server at the foot: ${look.foot}`);
      // under it the operator's own pages (A13 CLOUD-1), each opening without a referrer
      assert(
        JSON.stringify(look.legal) ===
          JSON.stringify([
            ['Imprint', LEGAL.VR_IMPRINT_URL, 'noreferrer'],
            ['Privacy', LEGAL.VR_PRIVACY_URL, 'noreferrer'],
            ['Terms', LEGAL.VR_TERMS_URL, 'noreferrer'],
          ]),
        `the legal line at the foot: ${JSON.stringify(look.legal)}`,
      );
      assert(look.code?.includes(`lampo login ${BASE}`), `the agents' command to copy: ${look.code}`);
      assert(look.closed && look.unreachable, 'the agents’ command waits behind “Sign in an agent”, out of reach while closed');
      await page.click('.ent-disc');
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.ent-disc-body > div')).visibility === 'visible', { timeout: 5000 });
      // Tab goes down the form: the password, its eye, "Forgot password?" (beside the label, after the field), the way in.
      await page.focus('input[name=email]');
      const order = [];
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press('Tab');
        order.push(
          await page.evaluate(
            () => document.activeElement?.getAttribute('name') || document.activeElement?.dataset.testid || document.activeElement?.className.trim(),
          ),
        );
      }
      assert(JSON.stringify(order) === JSON.stringify(['password', 'inv-eye', 'forgot-link', 'gate-go']), `the order Tab takes: ${JSON.stringify(order)}`);
      // An empty press says what is missing, shakes that field and moves the cursor there.
      await page.click('.ent-col .gate-go');
      await waitText(page, 'Type your email first.');
      const miss = await page.evaluate(() => ({
        shook: document.querySelector('input[name=email]')?.closest('.inv-field')?.dataset.shake,
        focused: document.activeElement?.getAttribute('name'),
      }));
      assert(miss.shook && miss.focused === 'email', `the miss: ${JSON.stringify(miss)}`);
      // The eye shows what was typed.
      await type(page, 'input[name=password]', 'secret words');
      await page.click('.inv-eye');
      assert((await page.$eval('input[name=password]', (i) => i.type)) === 'text', 'the eye shows the password');
      await page.browserContext().close();
    },
  );

  await check('sign up with an invite: the address only, the invite comes again, and its link lets the person in', async () => {
    const r = await asOwner('/api/admin/invites', { role: 'member', email: 'ida@e2e.test' });
    assert(r.ok, `invite: ${r.status}`);
    const ida = await fresh();
    await ida.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await waitText(ida, 'Create your account');
    await shoot(ida, 'sign-in');
    await clickText(ida, '.ent-fine a', 'Create your account');
    await ida.waitForSelector('[data-testid=signup]', { timeout: 15000 });
    const t = await text(ida);
    assert(t.includes('terms') && t.includes('privacy policy'), 'the terms and privacy links, from the config');
    assert(!(await ida.$('input[name=password]')), 'no password here: the invite’s link asks for one');
    await fits(ida, 'sign-up');
    await type(ida, 'input[name=email]', 'ida@e2e.test');
    await shoot(ida, 'sign-up');
    const since = Date.now();
    await ida.keyboard.press('Enter');
    await ida.waitForSelector('[data-testid=signup-sent]', { timeout: 15000 });
    assert((await text(ida)).includes('If an invite is waiting for ida@e2e.test'), 'the same answer for every address');
    await shoot(ida, 'sign-up-sent');
    const m = await mail('ida@e2e.test', 'invite', since);
    await ida.goto(linkIn(m), { waitUntil: 'domcontentloaded' });
    await waitText(ida, 'You’re invited');
    await type(ida, 'input[name=name]', 'Ida Berg');
    await type(ida, 'input[name=email]', 'ida@e2e.test');
    await type(ida, 'input[name=password]', 'idas long password');
    const took = Date.now();
    await ida.keyboard.press('Enter');
    await inFromInbox(ida, 'ida@e2e.test', took);
    await ida.waitForSelector('.lib-scroll, [data-testid=library]', { timeout: 15000 });
    await ida.browserContext().close();
  });

  let held;
  let ottoCookie = '';
  await check('open sign-up: "Check your inbox", held until the address is confirmed, the address kept', async () => {
    open = await startServer({ prefix: 'vr-e2e-account-open-', mode: 'server', publicUrl: true, env: { ...LEGAL, VR_SIGNUP: 'open' } });
    // Its operator set it up first (a server without an account shows the setup screen, not the sign-in).
    const token = await open.setupToken();
    const made = await fetch(`${open.base}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: open.base },
      body: JSON.stringify({ token, name: 'Otto Open', email: 'otto@e2e.test', password: 'ottos long password' }),
    });
    assert(made.ok, `setup of the open server: ${made.status}`);
    ottoCookie = String(made.headers.get('set-cookie')).split(';')[0];
    held = await fresh();
    await held.goto(`${open.base}/#/signup`, { waitUntil: 'domcontentloaded' });
    await held.waitForSelector('[data-testid=signup]', { timeout: 15000 });
    await type(held, 'input[name=name]', 'Nora Lind');
    await type(held, 'input[name=email]', 'nora@e2e.test');
    await type(held, 'input[name=password]', 'noras long password');
    await shoot(held, 'sign-up-open');
    const since = Date.now();
    await held.keyboard.press('Enter');
    await held.waitForSelector('[data-testid=signup-sent]', { timeout: 15000 });
    await mail('nora@e2e.test', 'verify', since, openOutbox());
    // Signed in before confirming: only "Check your inbox".
    await held.goto(`${open.base}/#/`, { waitUntil: 'domcontentloaded' });
    await type(held, 'input[name=email]', 'nora@e2e.test');
    await type(held, 'input[name=password]', 'noras long password');
    await held.keyboard.press('Enter');
    await held.waitForSelector('[data-testid=held]', { timeout: 15000 });
    assert((await text(held)).includes('We sent a link to nora@e2e.test'), (await text(held)).slice(0, 300));
    assert((await text(held)).includes('Sign up again'), 'a mistyped address is a new sign-up');
    assert(!(await held.$('input[name=email]')), 'no other address can be given while held');
    const lib = await held.evaluate(() => fetch('/api/library').then((r) => r.status));
    assert(lib === 403, `a held sign-up reaches nothing (${lib})`);
    await fits(held, 'held');
    await shoot(held, 'held');
  });

  await check('someone signed in who opens another account’s confirm link stays who they are (login CSRF)', async () => {
    const m = await mail('nora@e2e.test', 'verify', 0, openOutbox());
    const otto = await fresh();
    await otto.setCookie({ name: 'vr_session', value: ottoCookie.split('=')[1], url: open.base });
    await otto.goto(linkIn(m, open.base), { waitUntil: 'domcontentloaded' });
    await otto.waitForSelector('[data-testid=link-other]', { timeout: 15000 });
    assert((await text(otto)).includes('This link is for another account'), (await text(otto)).slice(0, 300));
    await fits(otto, 'link for another account');
    await shoot(otto, 'verify-other');
    const me = await otto.evaluate(() => fetch('/api/auth/me').then((r) => r.json()));
    assert(me.user?.email === 'otto@e2e.test', `still Otto: ${JSON.stringify(me.user?.email)}`);
    await otto.browserContext().close();
  });

  // lampo.video's Start free links to #/signup?plan=cloud-free (utm tags may ride along): it showed the sign-in screen.
  await check('the website’s sign-up link (#/signup?plan=…) opens the sign-up, its plan sent along and kept; signed in, the app', async () => {
    const page = await fresh();
    await page.goto(`${open.base}/#/signup?plan=cloud-free&utm_source=site`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=signup], [data-testid=signin]', { timeout: 15000 });
    assert(await page.$('[data-testid=signup]'), `Start free opens the sign-up, not: ${(await text(page)).slice(0, 200)}`);
    await page.browserContext().close();

    const solo = await fresh();
    const posted = [];
    solo.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/auth/signup') posted.push(JSON.parse(r.postData() || '{}'));
    });
    await solo.goto(`${open.base}/#/signup/?plan=cloud-solo&utm_source=site`, { waitUntil: 'domcontentloaded' });
    await solo.waitForSelector('[data-testid=signup]', { timeout: 15000 });
    const signIn = await solo.$$eval('[data-testid=signup] a[href^="#/"]', (els) => els.map((e) => e.getAttribute('href')));
    assert(signIn.includes('#/?plan=cloud-solo'), `“Sign in” keeps the plan: ${signIn}`);
    await type(solo, 'input[name=name]', 'Sol Reyes');
    await type(solo, 'input[name=email]', 'sol@e2e.test');
    await type(solo, 'input[name=password]', 'sols long password');
    await solo.keyboard.press('Enter');
    await solo.waitForSelector('[data-testid=signup-sent]', { timeout: 15000 });
    assert(posted.length === 1 && posted[0].plan === 'cloud-solo', `the plan rode with the sign-up: ${JSON.stringify(posted)}`);
    // someone who did land on sign-in: "Create an account" keeps the plan
    await solo.goto(`${open.base}/?r=1#/?plan=cloud-solo`, { waitUntil: 'domcontentloaded' });
    await solo.waitForSelector('[data-testid=signin] a[href^="#/signup"]', { timeout: 15000 });
    const create = await solo.$eval('[data-testid=signin] a[href^="#/signup"]', (e) => e.getAttribute('href'));
    assert(create === '#/signup?plan=cloud-solo', `“Create an account” keeps the plan: ${create}`);
    await solo.browserContext().close();

    // signed in already: Start free goes into the app (no billing here, so a paid plan goes there too)
    const otto = await fresh();
    await otto.setCookie({ name: 'vr_session', value: ottoCookie.split('=')[1], url: open.base });
    for (const plan of ['cloud-free', 'cloud-team']) {
      await otto.goto(`${open.base}/?r=${plan}#/signup?plan=${plan}&utm_source=site`, { waitUntil: 'domcontentloaded' });
      await otto.waitForFunction(() => !location.hash.startsWith('#/signup'), { timeout: 15000, polling: 100 });
      await otto.waitForSelector('.lib-scroll, [data-testid=library], [data-testid=ob-setup]', { timeout: 15000 });
      assert(!(await otto.$('[data-testid=signup], [data-testid=signin]')), `${plan}: in the app, no sign-up or sign-in`);
      const hash = await otto.evaluate(() => location.hash);
      assert(hash === '#/' || hash.startsWith('#/welcome'), `${plan}: the library (or a new account's setup): ${hash}`);
    }
    await otto.browserContext().close();
  });

  await check('a held account’s link opened in another browser asks for its password, or a new one (INV-REV-1)', async () => {
    const since = Date.now();
    const made = await fetch(`${open.base}/api/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: open.base },
      body: JSON.stringify({ name: 'Pia Field', email: 'pia@e2e.test', password: 'pias long password' }),
    });
    assert(made.ok, `sign-up: ${made.status}`);
    const m = await mail('pia@e2e.test', 'verify', since, openOutbox());
    const phone = await fresh();
    await phone.goto(linkIn(m, open.base), { waitUntil: 'domcontentloaded' });
    await phone.waitForSelector('[data-testid=verify-password]', { timeout: 15000 });
    assert((await text(phone)).includes('p•••@e2e.test'), (await text(phone)).slice(0, 300));
    await fits(phone, 'confirm: the password chosen');
    await shoot(phone, 'verify-password');
    await type(phone, 'input[name=password]', 'not the password at all');
    await phone.keyboard.press('Enter');
    await waitText(phone, 'That isn’t the password this account was made with.');
    await phone.click('[data-testid=verify-choose]');
    await phone.waitForSelector('[data-testid=verify-new]', { timeout: 15000 });
    await fits(phone, 'confirm: a new password');
    // (a phone-sized viewport reloads the page in Puppeteer: the link asks again, from its first form)
    if (!(await phone.$('[data-testid=verify-new]'))) {
      await phone.waitForSelector('[data-testid=verify-choose]', { timeout: 15000 });
      await phone.click('[data-testid=verify-choose]');
      await phone.waitForSelector('[data-testid=verify-new]', { timeout: 15000 });
    }
    await shoot(phone, 'verify-new');
    await type(phone, 'input[name=new-password]', 'pias other password');
    await phone.keyboard.press('Enter');
    await waitText(phone, 'You’re in');
    const me = await phone.evaluate(() => fetch('/api/auth/me').then((r) => r.json()));
    assert(me.user?.email === 'pia@e2e.test', `signed in as Pia: ${JSON.stringify(me.user?.email)}`);
    await phone.browserContext().close();
  });

  await check('a held invite’s link opened elsewhere: its password joins the workspace, a new password names no join, only what it leaves behind', async () => {
    // Otto's invite as admin, taken with Vera's address and a password chosen in some other browser.
    const made = await fetch(`${open.base}/api/admin/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: open.base, cookie: ottoCookie },
      body: JSON.stringify({ role: 'admin' }),
    });
    assert(made.ok, `invite: ${made.status}`);
    const token = (await made.json()).url.split('/#/invite/')[1];
    const since = Date.now();
    const took = await fetch(`${open.base}/api/auth/invite/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: open.base },
      body: JSON.stringify({ token, name: 'Vera Held', email: 'vera@e2e.test', password: 'the first long password' }),
    });
    assert(took.ok, `take: ${took.status}`);
    const link = linkIn(await mail('vera@e2e.test', 'verify', since, openOutbox()), open.base);
    const vera = await fresh();
    await vera.goto(link, { waitUntil: 'domcontentloaded' });
    await vera.waitForSelector('[data-testid=verify-password]', { timeout: 15000 });
    // The password it was made with joins Otto's workspace: said so.
    const joins = await vera.$$eval('[data-testid=verify-joins] li', (ls) => ls.map((l) => l.textContent));
    assert(joins.length === 1 && /^Joins .+ as admin, invited by Otto Open\.$/.test(joins[0]), `joins ${JSON.stringify(joins)}`);
    // A new password drops the invite: the screen names no join, and says what is left behind instead.
    await vera.click('[data-testid=verify-choose]');
    await vera.waitForSelector('[data-testid=verify-new]', { timeout: 15000 });
    const screen = await text(vera);
    assert(!(await vera.$('[data-testid=verify-joins]')) && !/\bJoins\b/.test(screen), `a new password joins nothing: ${screen}`);
    const left = await vera.$$eval('[data-testid=verify-left] li', (ls) => ls.map((l) => l.textContent));
    assert(left.length === 1 && / as admin, invited by Otto Open\.$/.test(left[0]), `left behind ${JSON.stringify(left)}`);
    assert(screen.includes('A new password leaves these invites behind'), screen);
    await fits(vera, 'confirm: a new password leaves the invite behind');
    // (a phone-sized viewport reloads the page in Puppeteer: the link asks again, from its first form)
    if (!(await vera.$('[data-testid=verify-new]'))) {
      await vera.waitForSelector('[data-testid=verify-choose]', { timeout: 15000 });
      await vera.click('[data-testid=verify-choose]');
      await vera.waitForSelector('[data-testid=verify-new]', { timeout: 15000 });
    }
    await shoot(vera, 'verify-new-left');
    // And so it is: in with the new password, and not a member of Otto's workspace.
    await type(vera, 'input[name=new-password]', 'veras own long password');
    await vera.keyboard.press('Enter');
    await waitText(vera, 'You’re in');
    const members = await fetch(`${open.base}/api/admin/users`, { headers: { cookie: ottoCookie } }).then((r) => r.json());
    assert(!members.users.some((u) => u.email === 'vera@e2e.test'), `Vera joined Otto's workspace: ${JSON.stringify(members.users.map((u) => u.email))}`);
    await vera.browserContext().close();
  });

  await check('a name taken in the workspace it joins: the confirm page asks for another (INV-REV-4)', async () => {
    // Two of Otto's invites, made out to nobody, each taken under one name; the first confirms and joins as it.
    const take = async (email) => {
      const made = await fetch(`${open.base}/api/admin/invites`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: open.base, cookie: ottoCookie },
        body: JSON.stringify({ role: 'member' }),
      });
      const token = (await made.json()).url.split('/#/invite/')[1];
      const since = Date.now();
      const r = await fetch(`${open.base}/api/auth/invite/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: open.base },
        body: JSON.stringify({ token, name: 'Kim Same', email, password: 'kims long password' }),
      });
      assert(r.ok, `take: ${r.status}`);
      const mark = r.headers
        .getSetCookie()
        .find((c) => c.startsWith('vr_signup='))
        .split(';')[0];
      return { mark, link: linkIn(await mail(email, 'verify', since, openOutbox()), open.base) };
    };
    const one = await take('kim.one@e2e.test');
    const two = await take('kim.two@e2e.test');
    const first = await fetch(`${open.base}/api/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: open.base, cookie: one.mark },
      body: JSON.stringify({ token: one.link.split('/#/verify/')[1] }),
    });
    assert(first.ok, `first: ${first.status}`);
    // The second, in the browser that took the invite: asked for another name, then in.
    const kim = await fresh();
    await kim.setCookie({ name: 'vr_signup', value: two.mark.split('=')[1], url: `${open.base}/api/auth` });
    await kim.goto(two.link, { waitUntil: 'domcontentloaded' });
    await kim.waitForSelector('[data-testid=verify-name]', { timeout: 15000 });
    assert((await text(kim)).includes('Kim Same'), (await text(kim)).slice(0, 300));
    await fits(kim, 'confirm: another name');
    await shoot(kim, 'verify-name');
    if (!(await kim.$('[data-testid=verify-name]'))) await kim.waitForSelector('[data-testid=verify-name]', { timeout: 15000 });
    await type(kim, 'input[name=name]', 'Kim Other');
    await kim.keyboard.press('Enter');
    await waitText(kim, 'You’re in');
    const me = await kim.evaluate(() => fetch('/api/auth/me').then((r) => r.json()));
    assert(me.user?.name === 'Kim Other', `joined as Kim Other: ${JSON.stringify(me.user?.name)}`);
    await kim.browserContext().close();
  });

  await check('the confirm link from the outbox lets the sign-up in', async () => {
    const m = await mail('nora@e2e.test', 'verify', 0, openOutbox());
    await held.goto(linkIn(m, open.base), { waitUntil: 'domcontentloaded' });
    await waitText(held, 'You’re in');
    await shoot(held, 'verify-done');
    await held.click('[data-testid=verify-open]');
    await held.waitForSelector('.lib-scroll, [data-testid=library], .empty-state', { timeout: 15000 });
    const welcome = await mail('nora@e2e.test', 'welcome', 0, openOutbox());
    assert(/Welcome, Nora/.test(welcome.text), welcome.text);
  });

  await check('the same confirm link again: already confirmed', async () => {
    const m = await mail('nora@e2e.test', 'verify', 0, openOutbox());
    await held.goto(`${open.base}/#/`, { waitUntil: 'domcontentloaded' });
    await held.goto(linkIn(m, open.base), { waitUntil: 'domcontentloaded' });
    await waitText(held, 'Already confirmed');
    await shoot(held, 'verify-used');
  });

  let laptop;
  await check('forgot password → the outbox’s link → a new password; the other session is gone', async () => {
    // Mia's laptop is signed in; she forgets her password on another device.
    laptop = await fresh();
    await laptop.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await type(laptop, 'input[name=email]', 'mia@e2e.test');
    await type(laptop, 'input[name=password]', 'mias first password');
    await laptop.keyboard.press('Enter');
    await laptop.waitForSelector('.lib-scroll, [data-testid=library]', { timeout: 15000 });
    // What the laptop keeps of the account between visits (api/persistWrite.ts): written soon after the screen loads.
    const kept = () =>
      laptop.evaluate(
        () =>
          new Promise((resolve) => {
            const req = indexedDB.open('vr-cache');
            req.onerror = () => resolve(-1);
            req.onsuccess = () => {
              const db = req.result;
              if (!db.objectStoreNames.contains('queries')) return resolve(0);
              const count = db.transaction('queries').objectStore('queries').count();
              count.onsuccess = () => resolve(count.result);
              count.onerror = () => resolve(-1);
            };
          }),
      );
    const until = async (ok, what) => {
      for (const end = Date.now() + 8000; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) if (ok(await kept())) return;
      throw new Error(`${what} (${await kept()} entries kept)`);
    };
    await until((n) => n > 0, 'the laptop keeps the library between visits');

    const phone = await fresh();
    await phone.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await phone.waitForSelector('[data-testid=forgot-link]', { timeout: 15000 });
    await phone.click('[data-testid=forgot-link]');
    await phone.waitForSelector('[data-testid=forgot]', { timeout: 15000 });
    await fits(phone, 'forgot');
    await shoot(phone, 'forgot');
    await type(phone, 'input[name=email]', 'mia@e2e.test');
    const since = Date.now();
    await phone.keyboard.press('Enter');
    await phone.waitForSelector('[data-testid=forgot-sent]', { timeout: 15000 });
    assert((await text(phone)).includes('If mia@e2e.test has an account here'), 'the same answer for every address');
    await shoot(phone, 'forgot-sent');
    const m = await mail('mia@e2e.test', 'reset', since);
    await phone.goto(linkIn(m), { waitUntil: 'domcontentloaded' });
    // the title is there from the first paint (the screen is its own loading state): the address says the link was read
    await waitText(phone, 'Choose a new password');
    await waitText(phone, 'm•••@e2e.test');
    assert((await text(phone)).includes('m•••@e2e.test'), 'which account, masked');
    await fits(phone, 'reset');
    await shoot(phone, 'reset');
    await type(phone, 'input[name=password]', 'mias second password');
    await phone.keyboard.press('Enter');
    await phone.waitForSelector('.lib-scroll, [data-testid=library]', { timeout: 15000 });
    await mail('mia@e2e.test', 'password-changed', since);
    // The laptop's session ended with the new password.
    const me = await laptop.evaluate(() => fetch('/api/auth/me').then((r) => r.status));
    assert(me === 401, `the old session is signed out (${me})`);
    await laptop.reload({ waitUntil: 'domcontentloaded' });
    await laptop.waitForSelector('input[name=password]', { timeout: 15000 });
    // …and the laptop keeps nothing of the account once the server says nobody is signed in there.
    await until((n) => n === 0, 'the laptop forgets what it kept of the account');
    assert((await laptop.evaluate(() => localStorage.getItem('vr.cache.who'))) === null, 'whose data it was is gone too');

    // The same link again: used.
    await phone.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await phone.goto(linkIn(m), { waitUntil: 'domcontentloaded' });
    await phone.waitForSelector('[data-testid=link-used]', { timeout: 15000 });
    await shoot(phone, 'reset-used');
    await phone.browserContext().close();
  });

  await check('an expired reset link and a cut-off one say so, with the way on', async () => {
    const page = await fresh();
    const since = Date.now();
    await fetch(`${BASE}/api/auth/forgot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ email: 'olivia@e2e.test' }),
    });
    const m = await mail('olivia@e2e.test', 'reset', since);
    // Its hour is over (the store's record, aged by hand: nothing a browser could do).
    const file = path.join(srv.env.VR_DATA, 'account-links.json');
    const links = JSON.parse(fs.readFileSync(file, 'utf8'));
    const last = links.links.filter((l) => l.kind === 'reset' && !l.used && !l.void).at(-1);
    last.expires = Date.now() - 1000;
    fs.writeFileSync(file, JSON.stringify(links));
    await page.goto(linkIn(m), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=link-expired]', { timeout: 15000 });
    assert((await page.$eval('.ent-col h1', (e) => e.textContent)).includes('expired'), 'the link says it expired');
    await fits(page, 'reset-expired');
    await shoot(page, 'reset-expired');
    await page.goto(`${BASE}/#/reset/rt_${'x'.repeat(43)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=link-invalid]', { timeout: 15000 });
    await shoot(page, 'reset-invalid');
    await page.goto(`${BASE}/#/verify/vt_${'x'.repeat(43)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=link-invalid]', { timeout: 15000 });
    await page.browserContext().close();
  });

  await check('German: the sign-up and its answer, the reset form', async () => {
    const page = await fresh();
    await page.goto(`${BASE}/#/signup`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.setItem('vr.lang', 'de'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitText(page, 'Leg dein Konto an');
    await fits(page, 'sign-up (de)');
    await shoot(page, 'sign-up', { german: true });
    await page.goto(`${BASE}/#/forgot`, { waitUntil: 'domcontentloaded' });
    await waitText(page, 'Passwort vergessen?');
    await shoot(page, 'forgot', { german: true });
    const since = Date.now();
    await type(page, 'input[name=email]', 'olivia@e2e.test');
    await page.keyboard.press('Enter');
    await waitText(page, 'Schau in deinen Posteingang');
    const m = await mail('olivia@e2e.test', 'reset', since);
    assert(m.lang === 'de' && m.subject === 'Setze dein Passwort für Lampo zurück', 'asked in German, answered in German');
    await page.goto(linkIn(m), { waitUntil: 'domcontentloaded' });
    await waitText(page, 'Wähle ein neues Passwort');
    await shoot(page, 'reset', { german: true });
    // A sign-up in German: "Schau in deinen Posteingang", and the invite again, in German.
    const r = await asOwner('/api/admin/invites', { role: 'reviewer', email: 'jo@e2e.test' });
    assert(r.ok, `invite: ${r.status}`);
    await page.goto(`${BASE}/#/signup`, { waitUntil: 'domcontentloaded' });
    await type(page, 'input[name=email]', 'jo@e2e.test');
    const asked = Date.now();
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid=signup-sent]', { timeout: 15000 });
    await waitText(page, 'Schau in deinen Posteingang');
    await shoot(page, 'sign-up-sent', { german: true });
    const v = await mail('jo@e2e.test', 'invite', asked);
    assert(v.lang === 'de', 'the invite speaks German');
    // Held, in German (an open sign-up on the second server).
    await page.goto(`${open.base}/#/signup`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.setItem('vr.lang', 'de'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await type(page, 'input[name=name]', 'Jürgen Müller-Lüdenscheidt');
    await type(page, 'input[name=email]', 'jo@e2e.test');
    await type(page, 'input[name=password]', 'jürgens langes passwort');
    const held = Date.now();
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid=signup-sent]', { timeout: 15000 });
    const c = await mail('jo@e2e.test', 'verify', held, openOutbox());
    assert(c.lang === 'de' && /^Hallo Jürgen,/m.test(c.text), 'the confirm link speaks German');
    await page.goto(`${open.base}/#/`, { waitUntil: 'domcontentloaded' });
    await type(page, 'input[name=email]', 'jo@e2e.test');
    await type(page, 'input[name=password]', 'jürgens langes passwort');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid=held]', { timeout: 15000 });
    await fits(page, 'held (de)');
    await shoot(page, 'held', { german: true });
    // Settings in German, as the owner: the invite form, the profile.
    await page.setCookie({ name: 'vr_session', value: ownerCookie.split('=')[1], url: BASE });
    await page.goto(`${BASE}/#/settings/users`, { waitUntil: 'domcontentloaded' });
    await waitText(page, 'Einladung per E-Mail senden');
    await fits(page, 'users (de)');
    await shoot(page, 'users', { german: true });
    await page.browserContext().close();
  });

  await check('Profile: a new address waits for its link; Notifications: sign-in alerts', async () => {
    await owner.goto(`${BASE}/#/settings/profile`, { waitUntil: 'domcontentloaded' });
    await owner.waitForSelector('input[type=email]', { timeout: 15000 });
    await type(owner, 'input[type=email]', 'olivia@studio.e2e.test');
    await type(owner, 'input[autocomplete=current-password]', OWNER.password);
    const since = Date.now();
    await clickText(owner, 'button[type=submit]', 'Save');
    await owner.waitForSelector('[data-testid=address-state]', { timeout: 15000 });
    assert((await text(owner)).includes('A link went to olivia@studio.e2e.test'), 'where the link went');
    await shoot(owner, 'profile-pending');
    const m = await mail('olivia@studio.e2e.test', 'verify-change', since);
    await owner.goto(linkIn(m), { waitUntil: 'domcontentloaded' });
    await waitText(owner, 'Your address is changed');
    await mail('olivia@e2e.test', 'email-changed', since);
    await owner.goto(`${BASE}/#/settings/notifications`, { waitUntil: 'domcontentloaded' });
    await owner.waitForSelector('#signin-alerts', { timeout: 15000 });
    await owner.click('#signin-alerts');
    await owner.waitForFunction(() => document.querySelector('#signin-alerts')?.getAttribute('aria-checked') === 'true', { timeout: 5000 });
    await shoot(owner, 'notifications');
  });

  await check('sign out everywhere: this browser drops what it cached and kept (Clear-Site-Data), and signs in again as before', async () => {
    const page = await fresh();
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await type(page, 'input[name=email]', 'mia@e2e.test');
    await type(page, 'input[name=password]', 'mias second password');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.lib-scroll, [data-testid=library]', { timeout: 15000 });
    const kept = () => page.evaluate(() => indexedDB.databases().then((dbs) => dbs.length));
    for (let i = 0; i < 40 && !(await kept()); i++) await sleep(200);
    assert((await kept()) > 0, 'the library is kept between visits');
    await page.goto(`${BASE}/#/settings/profile`, { waitUntil: 'domcontentloaded' });
    await waitText(page, 'Sign out everywhere');
    await clickText(page, 'button', 'Sign out everywhere');
    await page.waitForSelector('[role=alertdialog]', { timeout: 15000 });
    const answer = page.waitForResponse((r) => r.url().endsWith('/api/auth/logout-everywhere'));
    await clickText(page, '[role=alertdialog] button', 'Sign out everywhere');
    assert((await answer).headers()['clear-site-data'] === '"cache", "storage"', 'the answer tells the browser to drop its data');
    await page.waitForSelector('input[name=password]', { timeout: 15000 });
    for (let i = 0; i < 40 && (await kept()); i++) await sleep(200);
    assert((await kept()) === 0, 'nothing of the account is kept');
    assert((await page.evaluate(() => localStorage.getItem('vr.cache.who'))) === null, 'nor whose it was');
    // The page that asked still works: sign in again (it is back on Profile), the library is there, and it is kept again
    // (the page let go of the database the header closed).
    await type(page, 'input[name=email]', 'mia@e2e.test');
    await type(page, 'input[name=password]', 'mias second password');
    await page.keyboard.press('Enter');
    await waitText(page, 'Sign out everywhere');
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.lib-scroll, [data-testid=library]', { timeout: 15000 });
    for (let i = 0; i < 40 && !(await kept()); i++) await sleep(200);
    assert((await kept()) > 0, 'kept between visits again');
    await page.browserContext().close();
  });
} catch (e) {
  crashed(e, srv);
}
await finish(LABEL, { browser, servers: [srv, open].filter(Boolean) });
