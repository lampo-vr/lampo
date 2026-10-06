#!/usr/bin/env node
// covers: web/src/onboarding/ web/src/styles/setup.css web/src/styles/lighttable.css web/src/styles/ob-parts.css server/routes/onboarding.ts server/routes/serverHealth.ts lib/onboarding.ts lib/setupFlow.ts web/src/api/account.ts
// Browser end-to-end test of a new account's setup on a hosted server (web/src/onboarding/Setup.tsx): Lampo Cloud — an
// open sign-up from the website's ?plan= link, confirmed by its mailed link, lands on Welcome (the Team trial, from a
// stand-in billing provider), names the workspace, says who the videos are for (saved on the workspace and applied to
// the invite role and Get started's order), connects an agent whose live status turns on a real MCP connection, and
// invites the team row by row (a pasted list splits, each row checks itself, Send sends); an invited teammate gets
// Welcome and the agent only; a self-hosted server's owner gets the health check with mail off (its fix, invites as
// links) and on (a stand-in relay: Email works, the test mail arrives). Phones and the dark theme fit.
import path from 'node:path';
import { readOutbox } from '../../lib/mail/index.ts';
import { ROOT, sleep, tmpdir, until } from '../lib/helpers.ts';
import { fitsAt } from './layout.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { inventory, SCALE } from './lib/designInventory.mjs';
import { LEGAL, startServer } from './lib/server.mjs';
import { startSmtp } from './lib/smtp.mjs';

const LABEL = 'onboarding setup e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const PW = 'a long enough password';

const servers = [];
let relay = null;
let browser;
let page = null;
screenshotFailures(() => page, 'onboarding-setup');
try {
  relay = await startSmtp();
  const FAKE = path.join(ROOT, 'test/e2e/lib/billingModule.ts');
  const [cloud, server, mailed] = await Promise.all([
    startServer({
      prefix: 'vr-ob-cloud-e2e-',
      mode: 'server',
      publicUrl: true,
      onboarding: true,
      env: {
        ...LEGAL,
        VR_SIGNUP: 'open',
        VR_CLOUD_MODULE: FAKE,
        FAKE_BILLING_FILE: path.join(tmpdir('vr-ob-billing-'), 'billing.json'),
        FAKE_TRIAL_DAYS: '14',
      },
    }),
    startServer({ prefix: 'vr-ob-server-e2e-', mode: 'server', publicUrl: true, onboarding: true }),
    startServer({
      prefix: 'vr-ob-relay-e2e-',
      mode: 'server',
      publicUrl: true,
      onboarding: true,
      env: { VR_SMTP_URL: relay.url, VR_MAIL_FROM: 'Lampo <lampo@relay.test>' },
    }),
  ]);
  servers.push(cloud, server, mailed);
  browser = await launch();
  const errors = [];
  const fresh = async ({ width = 1440, height = 900, mobile = false, theme = null } = {}) => {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width, height, ...(mobile ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
    if (theme) await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
    p.on('pageerror', (e) => errors.push(e.message));
    page = p;
    return p;
  };
  const shot = async (p, name) => SHOTS && p.screenshot({ path: path.join(SHOTS, `onboarding-setup-${name}.png`) });
  const post = async (base, p, body, cookie) => {
    const r = await fetch(base + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
    return r;
  };
  const cookieOf = (r, name) => (r.headers.getSetCookie?.() ?? []).find((c) => c.startsWith(`${name}=`))?.split(';')[0] ?? null;
  const outbox = (srv) => readOutbox(path.join(srv.dir, 'cache', 'outbox'));
  const mailTo = (srv, to, kind) => until(() => outbox(srv).find((m) => m.to === to && (!kind || m.kind === kind)), `a ${kind ?? ''} mail to ${to}`);
  const inPage = (p, url, init) =>
    p.evaluate((u, i) => fetch(u, i).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) })), url, init ?? {});
  const atStep = (p, s) => p.waitForFunction((s) => document.querySelector('[data-testid=ob-setup]')?.dataset.step === s, { timeout: 15000 }, s);
  const textOf = (p) => p.evaluate(() => document.body.innerText);
  const fits = async (p, where) => {
    const bad = await fitsAt(p, where);
    assert(!bad.length, bad.join('\n'));
  };
  // quality.mjs's rules for every screen, here for each of the setup's steps: the design system's scales (the light
  // table's pictures and the phone's miniature of the workspace scale with their room: drawn, not set), and a finger's
  // 44 px on a phone
  const offScale = async (p, where) => {
    const found = await p.evaluate(inventory, { scale: SCALE, allow: ['.avatar', '.ob-pic', '.ob-smp-thumb', '.ob-mini-preview'] });
    return Object.entries(found).flatMap(([kind, list]) => list.map(({ value, who }) => `${where}: ${kind} ${value} (${who.join(', ')})`));
  };
  // The column's left edge, read off each step's heading at a width: it never moves sideways on Continue or Back.
  const movesAt = async (base, steps, cookie = null) => {
    const p = await fresh();
    if (cookie) await p.setCookie({ name: cookie.name, value: cookie.value, url: base });
    const out = [];
    for (const width of [1024, 1440, 1920]) {
      await p.setViewport({ width, height: 900 });
      const xs = {};
      for (const s of steps) {
        await p.goto(`${base}/#/welcome${s === 'welcome' ? '' : `/${s}`}`, { waitUntil: 'domcontentloaded' });
        await p.waitForFunction((s) => document.querySelector('[data-testid=ob-setup]')?.dataset.step === s, { timeout: 15000 }, s);
        await p.waitForSelector('[data-testid=ob-setup] h1');
        // the column slides in: measured once it stands (finite animations only; a live status pulses for ever)
        await p.evaluate(() =>
          Promise.all(
            document
              .getAnimations()
              .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime))
              .map((a) => a.finished.catch(() => {})),
          ),
        );
        xs[s] = await p.$eval('[data-testid=ob-setup] h1', (e) => Math.round(e.getBoundingClientRect().left));
      }
      const v = Object.values(xs);
      if (Math.max(...v) - Math.min(...v) > 1) out.push(`@${width}: ${JSON.stringify(xs)}`);
    }
    await p.browserContext().close();
    return out;
  };
  const smallTaps = (p, where) =>
    p.$$eval(
      '[data-testid=ob-setup] button, [data-testid=ob-setup] a[href], [data-testid=ob-setup] select, [data-testid=ob-setup] input:not([type=radio]):not([type=checkbox])',
      (els, where) =>
        els
          .filter((e) => {
            const r = e.getBoundingClientRect();
            const s = getComputedStyle(e);
            return r.width && r.height && s.visibility !== 'hidden' && +s.opacity !== 0;
          })
          .map((e) => {
            const r = e.getBoundingClientRect();
            const after = getComputedStyle(e, '::after');
            const h = Math.max(r.height, after.position === 'absolute' ? Number.parseFloat(after.height) || 0 : 0);
            return { name: (e.textContent.trim() || e.getAttribute('aria-label') || e.name || '').slice(0, 30), h: Math.round(h) };
          })
          .filter((x) => x.h < 43)
          .map((x) => `${where}: “${x.name}” ${x.h}px`),
      where,
    );

  // ---------------------------------------------------------------- Lampo Cloud
  const ana = await fresh();
  await check('Cloud: a sign-up from the website’s ?plan= link confirms and lands on Welcome, on the Team trial, the plan carried', async () => {
    await ana.goto(`${cloud.base}/?plan=cloud-team#/signup`, { waitUntil: 'domcontentloaded' });
    await ana.waitForSelector('[data-testid=signup]', { timeout: 15000 });
    await ana.type('input[name=name]', 'Ana Costa');
    await ana.type('input[name=email]', 'ana@e2e.test');
    await ana.type('input[name=password]', PW);
    await ana.keyboard.press('Enter');
    await ana.waitForSelector('[data-testid=signup-sent]', { timeout: 15000 });
    const mail = await mailTo(cloud, 'ana@e2e.test', 'verify');
    const link = /https?:\/\/\S+#\/verify\/[\w-]+/.exec(mail.text)?.[0];
    assert(link, 'a confirm link');
    await ana.goto(link.replace(/^https?:\/\/[^/]+/, cloud.base), { waitUntil: 'domcontentloaded' });
    await ana.waitForSelector('[data-testid=verify-open]', { timeout: 15000 });
    await ana.click('[data-testid=verify-open]');
    await atStep(ana, 'welcome');
    assert(ana.url().endsWith('#/welcome'), `the library sent a new account to its setup: ${ana.url()}`);
    const t = await textOf(ana);
    assert(t.includes('Welcome to Lampo, Ana'), t.slice(0, 300));
    await ana.waitForSelector('[data-testid=ob-trial]', { timeout: 10000 });
    const badge = await ana.$eval('[data-testid=ob-trial]', (e) => e.textContent.replace(/\s+/g, ' '));
    assert(badge.includes('Team trial') && badge.includes('14 days') && badge.includes('no card'), badge);
    assert((await ana.$$('.ob-hello-steps li')).length === 4, 'four steps ahead');
    const o = await inPage(ana, '/api/onboarding');
    assert(o.json?.plan === 'cloud-team', `the plan rode along: ${JSON.stringify(o.json?.plan)}`);
    assert((await ana.$$('h1')).length === 1, 'one h1');
    await shot(ana, '01-welcome');
  });

  await check('Workspace: offered as “Ana’s workspace”, the pictures show the name as it is typed, Continue names it', async () => {
    await ana.keyboard.press('Enter');
    await atStep(ana, 'workspace');
    const v = await ana.$eval('[data-testid=ob-ws-name]', (e) => e.value);
    assert(v === 'Ana’s workspace', v);
    await ana.click('[data-testid=ob-ws-name]', { count: 3 });
    await ana.keyboard.press('Backspace');
    await ana.click('[data-testid=ob-next]');
    assert((await textOf(ana)).includes('Type a name first.'), 'an empty name says so');
    await ana.type('[data-testid=ob-ws-name]', 'Northwind Studio');
    const bound = await ana.$$eval('[data-testid=ob-panel] [data-bind=ws]', (els) => els.map((e) => e.textContent));
    assert(bound.length >= 3 && bound.every((x) => x === 'Northwind Studio'), `live: ${bound}`);
    await shot(ana, '02-workspace');
    await ana.click('[data-testid=ob-next]');
    await atStep(ana, 'persona');
    await until(async () => (await inPage(ana, '/api/auth/status')).json?.workspace?.name === 'Northwind Studio', 'the workspace named');
  });

  await check('Who are the videos for: several picks, “Something else” opens a field; saved on the workspace', async () => {
    await ana.click('[data-persona=inhouse] input');
    await ana.click('[data-persona=other] input');
    await ana.waitForFunction(() => document.activeElement?.id === 'ob-persona-other', { timeout: 5000 });
    await ana.type('#ob-persona-other', 'Trade fair loops');
    const lead = await ana.$eval('.ob-said', (e) => e.textContent);
    assert(/Approvals lead/.test(lead), lead);
    // a review link's chip in the picture wears the link's mark, never a made-up visitor's initials ("CL")
    const avatars = await ana.$$eval('[data-testid=ob-panel] .ob-av', (els) => els.map((e) => e.textContent.trim()));
    assert(!avatars.includes('CL'), `initials in the picture: ${avatars}`);
    await shot(ana, '03-persona');
    await ana.click('[data-testid=ob-next]');
    await atStep(ana, 'agent');
    const ws = await until(async () => {
      const w = (await inPage(ana, '/api/auth/status')).json?.workspace;
      return w?.personas?.length ? w : null;
    }, 'the personas saved');
    assert(JSON.stringify(ws.personas) === '["inhouse","other"]' && ws.personaOther === 'Trade fair loops', JSON.stringify(ws));
  });

  await check('Agent: the connect block in place, its status live — a real MCP connection named claude-code turns it on', async () => {
    await ana.click('[data-agent=claude-code] input');
    await ana.waitForSelector('[data-testid=ob-connect][data-connect-id=claude-code] [data-testid=ob-live][data-state=waiting]');
    const snippet = await ana.$eval('[data-testid=ob-snippet]', (e) => e.textContent);
    assert(snippet.includes(`claude mcp add --transport http lampo ${cloud.base}/mcp`), snippet);
    assert((await ana.$eval('[data-testid=ob-next]', (e) => e.innerText)).includes('connect later'), 'Continue — connect later while waiting');
    const widthWaiting = await ana.$eval('[data-testid=ob-next]', (e) => e.getBoundingClientRect().width);
    assert((await ana.$eval('[data-testid=ob-loop]', (e) => e.dataset.mode)) === 'v1', 'the loop waits at V1');
    const o = await until(async () => (await inPage(ana, '/api/onboarding')).json?.onboarding?.agent, 'the pick kept');
    assert(o === 'claude-code', o);
    // an API token made in the page (the person's own), then an MCP client that names itself claude-code
    const tok = await inPage(ana, '/api/auth/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'e2e agent' }),
    });
    assert(tok.status === 200, `token: ${tok.status}`);
    const r = await fetch(`${cloud.base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tok.json.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.4' } },
      }),
    });
    assert(r.status === 200, `MCP initialize: ${r.status}`);
    await ana.waitForSelector('[data-testid=ob-live][data-state=connected]', { timeout: 15000 });
    const live = await ana.$eval('[data-testid=ob-live]', (e) => e.textContent);
    assert(live.includes('Connected · Claude Code'), live);
    await ana.waitForFunction(() => ['once', 'v2'].includes(document.querySelector('[data-testid=ob-loop]')?.dataset.mode), { timeout: 5000 });
    assert(!(await ana.$eval('[data-testid=ob-next]', (e) => e.innerText)).includes('connect later'), 'Continue, once connected');
    const widthConnected = await ana.$eval('[data-testid=ob-next]', (e) => e.getBoundingClientRect().width);
    assert(
      Math.abs(widthConnected - widthWaiting) < 1,
      `Continue was ${widthWaiting} px wide while waiting, ${widthConnected} px once connected (its edge jumps)`,
    );
    await shot(ana, '04-agent-connected');
  });

  await check('Agent: “Use an API token instead” makes a token, shown once, and the snippet reads $VR_TOKEN', async () => {
    await ana.click('[data-testid=ob-token-toggle]');
    await ana.waitForSelector('[data-testid=ob-token]');
    const tok = await ana.$eval('[data-testid=ob-token]', (e) => e.textContent);
    assert(/vr_[A-Za-z0-9_-]{8,}/.test(tok), tok);
    const snippet = await ana.$eval('[data-testid=ob-snippet]', (e) => e.textContent);
    assert(snippet.includes('Authorization: Bearer $VR_TOKEN'), snippet);
    // the step is taller than the window now: the toggle is scrolled clear of the sticky action bar first
    await ana.$eval('[data-testid=ob-token-toggle]', (e) => e.scrollIntoView({ block: 'center' }));
    await ana.click('[data-testid=ob-token-toggle]');
    await ana.waitForFunction(() => !document.querySelector('[data-testid=ob-token]'));
  });

  await check('Team: rows — the role starts as Reviewer (in-house), a pasted list splits, each row checks itself, Send sends the good ones', async () => {
    await ana.click('[data-testid=ob-next]');
    await atStep(ana, 'team');
    assert((await ana.$$('[data-testid=ob-invite-row]')).length === 2, 'two empty rows');
    const role = await ana.$eval('#ob-ir-0 ~ select', (e) => e.value);
    assert(role === 'reviewer', `in-house without an agency: ${role}`);
    // a pasted list: one row each
    await ana.focus('#ob-ir-0');
    await ana.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'lea.berg@e2e.test, tom@e2e.test; kai@e2e');
      document.querySelector('#ob-ir-0').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await ana.waitForFunction(() => document.querySelectorAll('[data-testid=ob-invite-row]').length === 4, { timeout: 5000 });
    // your own address and a duplicate
    await ana.type('#ob-ir-3', 'ana@e2e.test');
    await ana.type('#ob-ir-4', 'tom@e2e.test');
    await ana.click('[data-testid=ob-send-invites]');
    await ana.waitForFunction(() => document.querySelector('#ob-err-team')?.textContent.includes('need a look'), { timeout: 5000 });
    const errs = await ana.$$eval('.ob-ir-err', (els) => els.map((e) => e.textContent).filter(Boolean));
    assert(errs.includes('That doesn’t look like an email address.'), JSON.stringify(errs));
    assert(errs.includes('That’s your own address: you’re in already.'), JSON.stringify(errs));
    assert(errs.includes('Already in the list.'), JSON.stringify(errs));
    const card = await ana.$eval('[data-testid=ob-team-card]', (e) => e.textContent);
    assert(card.includes('Lea Berg') && card.includes('2 invites ready to send'), card);
    await shot(ana, '05-team-errors');
    // take the three bad rows out (× on each), from the bottom
    for (const i of [4, 3, 2]) await ana.click(`[data-row="${i}"] .ob-ir-x`);
    // while the invites go out the button is disabled: its label stays readable on its orange (not muted grey)
    const sending = await ana.evaluate(() => {
      const b = document.querySelector('[data-testid=ob-send-invites]');
      const probe = document.createElement('span');
      probe.style.color = 'var(--on-brand)';
      b.append(probe);
      const want = getComputedStyle(probe).color;
      probe.remove();
      b.disabled = true;
      const got = getComputedStyle(b).color;
      b.disabled = false;
      return { got, want };
    });
    assert(sending.got === sending.want, `Send while sending: its label is ${sending.got}, on-brand is ${sending.want}`);
    const label = await ana.$eval('[data-testid=ob-send-invites]', (e) => e.textContent);
    assert(label.includes('Send 2 invites'), label);
    await ana.click('[data-testid=ob-send-invites]');
    await ana.waitForFunction(() => location.hash === '#/', { timeout: 15000 });
    await mailTo(cloud, 'lea.berg@e2e.test', 'invite');
    await mailTo(cloud, 'tom@e2e.test', 'invite');
    const inv = await inPage(ana, '/api/admin/invites');
    const mine = inv.json.invites.filter((i) => i.status === 'pending').map((i) => `${i.email}:${i.role}`);
    assert(mine.includes('lea.berg@e2e.test:reviewer') && mine.includes('tom@e2e.test:reviewer'), JSON.stringify(mine));
  });

  await check('the library: Get started in the persona’s order, the plan picked offered, the sample there from sign-up', async () => {
    await ana.waitForSelector('[data-testid=ob-gs] [data-testid=ob-step]', { timeout: 15000 });
    const o = await inPage(ana, '/api/onboarding');
    assert(o.json.onboarding.setup_done, 'the setup is over');
    const steps = await ana.$$eval('[data-testid=ob-step]', (els) => els.map((e) => e.dataset.step));
    assert(JSON.stringify(steps) === '["sample","agent","invite","video","share"]', `in-house invites before it uploads: ${steps}`);
    await ana.waitForSelector('[data-testid=ob-step][data-step=invite][data-done]', { timeout: 15000 });
    await ana.waitForSelector('[data-testid=ob-step][data-step=agent][data-done]', { timeout: 15000 });
    const plan = await ana.$eval('[data-testid=ob-plan]', (e) => [e.textContent, e.getAttribute('href')]);
    assert(plan[0].includes('You picked Team') && plan[1] === '#/settings/billing?plan=cloud-team', JSON.stringify(plan));
    const lib = await inPage(ana, '/api/library');
    assert(
      lib.json.videos.some((v) => v.sample),
      'the sample is in the library',
    );
    await fits(ana, 'Get started (Cloud)');
    await shot(ana, '06-library');
  });

  await check('an invited teammate: Welcome names the workspace and who invited, one step (the agent), then the library', async () => {
    const owner = (await ana.cookies(cloud.base)).find((c) => c.name.startsWith('vr_session') || c.name.startsWith('__Host-vr_session'));
    const ownerCookie = `${owner.name}=${owner.value}`;
    const made = await post(cloud.base, '/api/admin/invites', { role: 'member', email: 'jonas@e2e.test' }, ownerCookie);
    assert(made.ok, `invite: ${made.status}`);
    const token = (await made.json()).url.split('/#/invite/')[1];
    const took = await post(cloud.base, '/api/auth/invite/accept', { token, name: 'Jonas Weber', email: 'jonas@e2e.test', password: PW, lang: 'en' });
    assert(took.ok, `accept: ${took.status}`);
    const held = cookieOf(took, 'vr_signup');
    const mail = await mailTo(cloud, 'jonas@e2e.test', 'verify');
    const vt = /#\/verify\/([\w-]+)/.exec(mail.text)?.[1];
    const done = await post(cloud.base, '/api/auth/verify', { token: vt, lang: 'en' }, held);
    assert(done.ok, `verify: ${done.status}`);
    const session = cookieOf(done, 'vr_session');
    const jonas = await fresh();
    await jonas.setCookie({ name: 'vr_session', value: session.split('=').slice(1).join('='), url: cloud.base });
    await jonas.goto(`${cloud.base}/#/`, { waitUntil: 'domcontentloaded' });
    await atStep(jonas, 'welcome');
    const t = await textOf(jonas);
    assert(t.includes('Welcome to Northwind Studio, Jonas'), t.slice(0, 400));
    await jonas.waitForFunction(() => document.body.innerText.includes('invited by Ana Costa'), { timeout: 10000 });
    assert((await jonas.$eval('[data-testid=ob-panel]', (e) => e.dataset.picture)) === 'join', 'the workspace card');
    await shot(jonas, '07-invited-welcome');
    await jonas.click('[data-testid=ob-start]');
    await atStep(jonas, 'agent');
    assert((await jonas.$$('.ob-su-top .ob-track-i')).length === 1, 'one step');
    await jonas.click('[data-agent=none] input');
    assert((await jonas.$eval('[data-testid=ob-next]', (e) => e.textContent)).includes('Go to the library'), 'its last step');
    await jonas.click('[data-testid=ob-next]');
    await jonas.waitForSelector('[data-testid=ob-gs] [data-testid=ob-step]', { timeout: 15000 });
    const steps = await jonas.$$eval('[data-testid=ob-step]', (els) => els.map((e) => e.dataset.step));
    assert(JSON.stringify(steps) === '["sample","agent","video","share"]', `a member's steps: ${steps}`);
    await jonas.browserContext().close();
  });

  await check('a phone: the light table is a band on top, the actions a solid bar at the bottom, everything fits (both themes)', async () => {
    const bad = [];
    for (const theme of ['light', 'dark']) {
      const p = await fresh({ width: 390, height: 844, mobile: true, theme });
      const c = (await ana.cookies(cloud.base)).find((x) => x.name.includes('vr_session'));
      await p.setCookie({ name: c.name, value: c.value, url: cloud.base });
      for (const s of ['workspace', 'persona', 'agent', 'team']) {
        await p.goto(`${cloud.base}/#/welcome/${s}`, { waitUntil: 'domcontentloaded' });
        await atStep(p, s);
        const band = await p.$eval('[data-testid=ob-panel]', (e) => e.getBoundingClientRect().height);
        assert(band >= 190 && band <= 220, `${s}: the band is ${band}px`);
        const sticky = await p.$eval('.ob-su-acts.ob-sticky', (e) => getComputedStyle(e).position);
        assert(sticky === 'sticky', `${s}: the actions stick (${sticky})`);
        await fits(p, `${s} on a phone (${theme})`);
        if (s === 'workspace') {
          // the band can't show the name at work: its sheet sits in the column, under the field, over nothing
          const at = await p.evaluate(() => {
            const box = (q) => document.querySelector(q).getBoundingClientRect();
            return { field: box('[data-testid=ob-ws-name]').bottom, sheet: box('.ob-mini-preview').top, h1: box('.ob-su-col h1').bottom };
          });
          assert(at.sheet >= at.field && at.sheet > at.h1, `the workspace's sheet under its field: ${JSON.stringify(at)}`);
        }
        if (theme === 'light') bad.push(...(await smallTaps(p, `${s} @390`)), ...(await offScale(p, `${s} @390`)));
        if (s === 'team') await shot(p, `08-phone-team-${theme}`);
      }
      await p.browserContext().close();
    }
    assert(!bad.length, `under 44 px or off the design system's scales:\n        ${bad.join('\n        ')}`);
  });

  await check('a desk: every step on the design system’s scales (type sizes, weights, corners, control heights)', async () => {
    const p = await fresh();
    const c = (await ana.cookies(cloud.base)).find((x) => x.name.includes('vr_session'));
    await p.setCookie({ name: c.name, value: c.value, url: cloud.base });
    const bad = [];
    for (const s of ['welcome', 'workspace', 'persona', 'agent', 'team']) {
      await p.goto(`${cloud.base}/#/welcome${s === 'welcome' ? '' : `/${s}`}`, { waitUntil: 'domcontentloaded' });
      await atStep(p, s);
      if (s === 'agent') {
        await p.click('[data-agent=codex] input');
        await p.waitForSelector('[data-testid=ob-snippet]');
      }
      await p.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
      bad.push(...(await offScale(p, `${s} @1440`)));
    }
    assert(!bad.length, `off the scales in base.css:\n        ${bad.join('\n        ')}`);
    await p.browserContext().close();
  });

  await check('a desk at 1024, 1440 and 1920: every step’s heading starts at the same left edge (Cloud)', async () => {
    const c = (await ana.cookies(cloud.base)).find((x) => x.name.includes('vr_session'));
    const moved = await movesAt(cloud.base, ['welcome', 'workspace', 'persona', 'agent', 'team'], c);
    assert(!moved.length, `the heading moves sideways between steps:\n        ${moved.join('\n        ')}`);
  });

  // ---------------------------------------------------------------- a self-hosted server
  const mia = await fresh();
  await check('Server: the setup page’s owner gets Welcome (the host, Owner), the workspace empty, then the health check', async () => {
    const token = await server.setupToken();
    const r = await post(server.base, '/api/auth/setup', { token, name: 'Mia Lang', email: 'mia@e2e.test', password: PW });
    assert(r.ok, `setup: ${r.status}`);
    const c = cookieOf(r, 'vr_session');
    await mia.setCookie({ name: 'vr_session', value: c.split('=').slice(1).join('='), url: server.base });
    await mia.goto(`${server.base}/#/`, { waitUntil: 'domcontentloaded' });
    await atStep(mia, 'welcome');
    const t = await textOf(mia);
    assert(t.includes('Your server is up, Mia') && t.includes('Owner') && t.includes(new URL(server.base).host), t.slice(0, 400));
    await mia.click('[data-testid=ob-start]');
    await atStep(mia, 'workspace');
    assert((await mia.$eval('[data-testid=ob-ws-name]', (e) => e.value)) === '', 'empty on a server');
    await mia.type('[data-testid=ob-ws-name]', 'Northwind Studio');
    await mia.click('[data-testid=ob-next]');
    await atStep(mia, 'health');
  });

  await check('the health check with mail off: four calm checks, the email to fix with its fix, nothing blocks', async () => {
    await mia.waitForFunction(
      () => ['url', 'storage', 'mail', 'speech'].every((k) => ['ok', 'warn'].includes(document.querySelector(`[data-check=${k}]`)?.dataset.s)),
      { timeout: 20000 },
    );
    const s = await mia.$$eval('[data-check]', (els) => Object.fromEntries(els.map((e) => [e.dataset.check, e.dataset.s])));
    assert(s.url === 'ok' && s.storage === 'ok' && s.mail === 'warn', JSON.stringify(s));
    const mailRow = await mia.$eval('[data-check=mail]', (e) => e.textContent);
    assert(mailRow.includes('No mail relay yet'), mailRow);
    await mia.click('[data-testid=ob-mail-show-fix]');
    const fix = await mia.$eval('[data-testid=ob-mail-fix]', (e) => e.textContent);
    assert(fix.includes('VR_SMTP_URL') && fix.includes('VR_MAIL_FROM') && fix.includes('docker compose up -d'), fix);
    await shot(mia, '09-health-mail-off');
    await mia.click('[data-testid=ob-health-rerun]');
    await mia.waitForFunction(() => document.querySelector('[data-check=mail]')?.dataset.s === 'warn', { timeout: 20000 });
    await mia.click('[data-testid=ob-next]');
    await atStep(mia, 'team');
  });

  await check('the health check holds still: each row has its room from the first answer, and “Check again” keeps it', async () => {
    const p = await fresh();
    const c = (await mia.cookies(server.base)).find((x) => x.name.includes('vr_session'));
    await p.setCookie({ name: c.name, value: c.value, url: server.base });
    await p.evaluateOnNewDocument(() => {
      window.__rows = [];
      const tick = () => {
        const list = document.querySelector('[data-testid=ob-checks]');
        if (list && !list.classList.contains('ob-asking')) window.__rows.push(Math.round(list.getBoundingClientRect().height));
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await p.bringToFront();
    await p.goto(`${server.base}/#/welcome/health`, { waitUntil: 'domcontentloaded' });
    await atStep(p, 'health');
    const settled = () =>
      p.waitForFunction(
        () => ['url', 'storage', 'mail', 'speech'].every((k) => ['ok', 'warn'].includes(document.querySelector(`[data-check=${k}]`)?.dataset.s)),
        {
          timeout: 20000,
        },
      );
    await settled();
    const onLoad = [...new Set(await p.evaluate(() => window.__rows))];
    await p.evaluate(() => {
      window.__rows = [];
    });
    const pills = await p.$$eval('[data-check] .ob-check-s', (els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    await p.click('[data-testid=ob-health-rerun]');
    const during = await p.$$eval('[data-check] .ob-check-s', (els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    await p.waitForFunction(() => document.querySelector('[data-check=url]')?.dataset.s !== 'ok', { timeout: 5000 }).catch(() => {});
    await settled();
    const again = [...new Set(await p.evaluate(() => window.__rows))];
    await p.browserContext().close();
    assert(onLoad.length === 1, `the checks' list grew as the answers landed: ${onLoad.join(' → ')} px`);
    assert(again.length === 1 && again[0] === onLoad[0], `“Check again” moved the list: ${again.join(' → ')} px`);
    assert(JSON.stringify(pills) === JSON.stringify(during), `the status pills change width: ${pills} → ${during}`);
  });

  await check('without a relay the team’s invites become links to send yourself', async () => {
    assert((await textOf(mia)).includes('No mail relay yet.'), 'the note says so');
    await mia.type('#ob-ir-0', 'lea@e2e.test');
    const label = await mia.$eval('[data-testid=ob-send-invites]', (e) => e.textContent);
    assert(label.includes('Create 1 invite'), label);
    await mia.click('[data-testid=ob-send-invites]');
    await mia.waitForSelector('[data-testid=ob-invite-link]', { timeout: 15000 });
    const link = await mia.$eval('[data-testid=ob-invite-link]', (e) => e.textContent);
    assert(link.includes('lea@e2e.test') && /#\/invite\/inv_/.test(link), link);
    assert(await mia.$('[data-testid=ob-setup] .ob-su-eyebrow'), 'the links keep the step’s eyebrow (the heading stays where it was)');
    const lines = await mia.$eval('[data-testid=ob-invite-link] .ob-cmd :is(pre, code)', (e) => Math.round(e.getBoundingClientRect().height));
    assert(lines < 40, `an invite link breaks over lines (${lines} px tall: one line is 30)`);
    assert(!outbox(server).some((m) => m.to === 'lea@e2e.test' && m.kind === 'invite'), 'nothing mailed');
    await mia.click('[data-testid=ob-next]');
    await atStep(mia, 'agents');
    assert((await textOf(mia)).includes('Connect your team’s agents'), 'the server’s words');
    await mia.click('[data-agent=codex] input');
    const snippet = await mia.$eval('[data-testid=ob-snippet]', (e) => e.textContent);
    assert(snippet.includes('[mcp_servers.lampo]') && snippet.includes(`${server.base}/mcp`), snippet);
    await mia.click('[data-testid=ob-next]');
    await mia.waitForSelector('[data-testid=ob-gs] [data-testid=ob-step]', { timeout: 15000 });
    const steps = await mia.$$eval('[data-testid=ob-step]', (els) => els.map((e) => e.dataset.step));
    assert(JSON.stringify(steps) === '["sample","video","agent","invite","share"]', `a server's order: ${steps}`);
  });

  await check('a wide screen (1920, 2560): the column stands in the pane’s middle, Back · track · Skip line up with it', async () => {
    const p = await fresh();
    const c = (await mia.cookies(server.base)).find((x) => x.name.includes('vr_session'));
    await p.setCookie({ name: c.name, value: c.value, url: server.base });
    const off = [];
    for (const [width, height] of [
      [1920, 1080],
      [2560, 1440],
    ]) {
      await p.setViewport({ width, height });
      for (const s of ['workspace', 'team', 'agents']) {
        await p.goto(`${server.base}/#/welcome/${s}`, { waitUntil: 'domcontentloaded' });
        await atStep(p, s);
        await p.evaluate(() =>
          Promise.all(
            document
              .getAnimations()
              .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime))
              .map((a) => a.finished.catch(() => {})),
          ),
        );
        const m = await p.evaluate(() => {
          const pane = document.querySelector('.ob-su-form').getBoundingClientRect();
          const col = document.querySelector('.ob-su-col').getBoundingClientRect();
          const back = document.querySelector('[data-testid=ob-back]').getBoundingClientRect();
          const skip = document.querySelector('[data-testid=ob-skip] .ob-hide-s').getBoundingClientRect();
          return {
            off: (col.top + col.height / 2 - (pane.top + pane.height / 2)) / pane.height,
            back: Math.round(back.left - col.left),
            skip: Math.round(col.right - skip.right),
          };
        });
        if (Math.abs(m.off) > 0.2) off.push(`${s} @${width}: the column's centre is ${Math.round(m.off * 100)}% of the pane away from its middle`);
        if (Math.abs(m.back) > 2 || Math.abs(m.skip) > 2) off.push(`${s} @${width}: Back is ${m.back} px and Skip ${m.skip} px off the column's edges`);
      }
    }
    await p.browserContext().close();
    assert(!off.length, off.join('\n        '));
  });

  await check('a tablet (768): an agent tile’s name sits on its icon’s centre line', async () => {
    const p = await fresh({ width: 768, height: 1024 });
    const c = (await mia.cookies(server.base)).find((x) => x.name.includes('vr_session'));
    await p.setCookie({ name: c.name, value: c.value, url: server.base });
    await p.goto(`${server.base}/#/welcome/agents`, { waitUntil: 'domcontentloaded' });
    await atStep(p, 'agents');
    const off = await p.$$eval('.ob-tiles.ob-agents .ob-tile', (els) =>
      els
        .map((t) => {
          const i = t.querySelector('.ob-tile-ico').getBoundingClientRect();
          const b = t.querySelector('b').getBoundingClientRect();
          return { name: t.dataset.agent, d: Math.round(b.top + b.height / 2 - (i.top + i.height / 2)) };
        })
        .filter((x) => Math.abs(x.d) > 1),
    );
    await p.browserContext().close();
    assert(!off.length, `names off their icons' centre: ${JSON.stringify(off)}`);
  });

  await check('Back moves the focus to the step it opens (its headline), not to the page', async () => {
    const p = await fresh();
    const c = (await mia.cookies(server.base)).find((x) => x.name.includes('vr_session'));
    await p.setCookie({ name: c.name, value: c.value, url: server.base });
    await p.goto(`${server.base}/#/welcome/team`, { waitUntil: 'domcontentloaded' });
    await atStep(p, 'team');
    await p.click('[data-testid=ob-back]');
    await atStep(p, 'health');
    await p.waitForFunction(() => document.activeElement !== document.body, { timeout: 5000 }).catch(() => {});
    const focus = await p.evaluate(() => `${document.activeElement?.tagName.toLowerCase()} ${document.activeElement?.textContent.slice(0, 40)}`);
    await p.browserContext().close();
    assert(focus.startsWith('h1 A quick check'), `focus after Back: ${focus}`);
  });

  await check('a desk at 1024, 1440 and 1920: every step’s heading starts at the same left edge (a server)', async () => {
    const c = (await mia.cookies(server.base)).find((x) => x.name.includes('vr_session'));
    const moved = await movesAt(server.base, ['welcome', 'workspace', 'health', 'team', 'agents'], c);
    assert(!moved.length, `the heading moves sideways between steps:\n        ${moved.join('\n        ')}`);
  });

  await check('the health check with a relay (a stand-in SMTP server): Email works, and its test mail arrives', async () => {
    const token = await mailed.setupToken();
    const r = await post(mailed.base, '/api/auth/setup', { token, name: 'Ola Berg', email: 'ola@e2e.test', password: PW });
    assert(r.ok, `setup: ${r.status}`);
    const p = await fresh();
    await p.setCookie({ name: 'vr_session', value: cookieOf(r, 'vr_session').split('=').slice(1).join('='), url: mailed.base });
    await p.goto(`${mailed.base}/#/welcome/health`, { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => document.querySelector('[data-check=mail]')?.dataset.s === 'ok', { timeout: 20000 });
    const row = await p.$eval('[data-check=mail]', (e) => e.textContent);
    assert(row.includes(`127.0.0.1:${relay.port}`), row);
    await p.click('[data-testid=ob-mail-test]');
    await until(() => relay.messages.find((m) => m.to.includes('ola@e2e.test')), 'the test mail at the relay');
    await p.waitForFunction(() => document.querySelector('[data-check=mail]')?.textContent.includes('a test mail went to ola@e2e.test'), { timeout: 10000 });
    await shot(p, '10-health-mail-on');
    const off = await offScale(p, 'health @1440');
    assert(!off.length, `off the scales in base.css:\n        ${off.join('\n        ')}`);
    // the team step says email works and sends
    await p.goto(`${mailed.base}/#/welcome/team`, { waitUntil: 'domcontentloaded' });
    await atStep(p, 'team');
    assert((await textOf(p)).includes('Email works.'), 'email works');
    await p.browserContext().close();
  });

  await check('no errors in the page', async () => {
    await sleep(0);
    assert(!errors.length, errors.join('\n'));
  });
} catch (e) {
  crashed(e, ...servers);
}
await relay?.close();
await finish(LABEL, { browser, servers });
