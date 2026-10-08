#!/usr/bin/env node
// covers: web/src/settings/Billing.tsx web/src/settings/BillingAccount.tsx web/src/billing/ web/src/styles/billing.css
// covers: web/src/lib/refusal.ts web/src/lib/toast.ts server/extension.ts server/guard.ts server/signup.ts
// covers: test/e2e/lib/billingModule.ts test/e2e/lib/fakeStripe.js web/src/settings/Links.tsx web/src/api/badge.ts
// Settings → Billing and the billing banner against a stand-in billing provider (test/e2e/lib/billingModule.ts, loaded
// through VR_CLOUD_MODULE as a real one is) and a stand-in Stripe.js (test/e2e/lib/fakeStripe.js, served for
// js.stripe.com): someone who signs up (VR_SIGNUP=open) is placed by the provider and starts a trial; in its last days
// the library says so. The page in its three parts: the plan panel (its tag, the trial's ruler, what Free would mean,
// what the workspace uses, dashed where there is no limit), the plans as tiles selected like radio buttons whose rows
// line up in German, one bar with the one orange action, monthly or yearly in EUR or USD, a plan picked on the website
// selected; one 1040 px column in the middle of its room like every section; nothing in --faint, nothing moving as it
// loads; nothing from Stripe until a payment form opens. Choosing a plan opens the checkout step at its own address and
// pays there (the step itself: test/e2e/checkout.mjs); the account panel shows the card and the invoice, takes a new
// card for renewals and a removal with Undo, the billing details edited in place with the VAT ID said wrong at its field
// and then checked; on a phone its badges never wrap; a switch shows what the next invoice will be; cancelling shows
// what Free would mean and keeping the plan is the one orange; a consumer's yearly plan after its first year may end
// with one month's notice, its refund said in the step, the contract, what was received and the plan (kept, nothing is
// owed); the plans' VAT line says a business abroad pays none only where the provider offers reverse charge; the Lampo badge stays on every plan and a paid
// workspace's admin hides it in Settings → Review links (its links then say so); a failed renewal shows its week of grace and is fixed in
// a sheet (declined at the field, then paid); a read-only workspace says so above the library, and a refused invite
// shows the provider's sentence (German too) with the way to the plans; the operator's own workspace reads its own
// words; a member reads the plan but sees no prices, no account, loads no Stripe.js, and can let the owners know. Every
// state fits phone to wide desktop, light and dark. Without Chrome or web/dist it fails (see prereq.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { readOutbox } from '../../lib/mail/index.ts';
import { makeVideo, ROOT, sleep, tmpdir } from '../lib/helpers.ts';
import { client, tusUpload } from '../lib/http.ts';
import { fitsAt, layoutMatrix, settle } from './layout.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { consentCookie } from './lib/consent.mjs';
import { LEGAL, startServer } from './lib/server.mjs';

const LABEL = 'billing e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const fakeDir = tmpdir('vr-e2e-billing-fake-');
const FAKE = path.join(fakeDir, 'billing.json');
const STRIPE_JS = 'https://js.stripe.com/dahlia/stripe.js';
const FAKE_STRIPE = fs.readFileSync(path.join(ROOT, 'test/e2e/lib/fakeStripe.js'), 'utf8');
const srv = await startServer({
  prefix: 'vr-e2e-billing-',
  mode: 'server',
  publicUrl: true,
  env: { ...LEGAL, VR_SIGNUP: 'open', VR_CLOUD_MODULE: path.join(ROOT, 'test/e2e/lib/billingModule.ts'), FAKE_BILLING_FILE: FAKE, FAKE_TRIAL_DAYS: '2' },
});
const { base: BASE } = srv;
const request = client(srv.port);
const origin = { Origin: BASE };
const PASSWORD = 'a long enough password';
const OUTBOX = path.join(srv.env.VR_CACHE, 'outbox');

const cookieOf = (r, name = 'vr_session') => String([r.headers['set-cookie']].flat().find((c) => String(c).startsWith(`${name}=`)) || '').split(';')[0];
async function confirmToken(address) {
  for (let i = 0; i < 100; i++) {
    const token = /#\/verify\/(vt_[\w-]+)/.exec(
      readOutbox(OUTBOX)
        .filter((x) => x.to === address && x.kind === 'verify')
        .at(-1)?.text ?? '',
    )?.[1];
    if (token) return token;
    await sleep(100);
  }
  throw new Error(`no confirm link to ${address} in the outbox`);
}
const DAY = 86_400_000;
const fake = () => JSON.parse(fs.readFileSync(FAKE, 'utf8'));
const setFake = (workspace, patch) => {
  const d = fake();
  d.workspaces[workspace] = { ...d.workspaces[workspace], ...patch };
  fs.writeFileSync(FAKE, JSON.stringify(d, null, 2));
};
const addInvoice = (workspace, invoice) => {
  const d = fake();
  d.accounts[workspace].invoices.unshift(invoice);
  fs.writeFileSync(FAKE, JSON.stringify(d, null, 2));
};

let browser;
let page;
try {
  // ---------------------------------------------------------------- the team that was here first, and a newcomer
  const setupToken = await srv.setupToken();
  assert(setupToken, `no setup token in the server log:\n${srv.log()}`);
  assert(/extension: fake-billing \(answers sign-ups\) \(billing\)/.test(srv.log()), `the module answers sign-ups:\n${srv.log()}`);
  const setup = await request('POST', '/api/auth/setup', {
    body: { token: setupToken, email: 'olivia@e2e.test', name: 'Olivia', password: PASSWORD },
    headers: origin,
  });
  assert(setup.status === 200, setup.text);
  const olivia = cookieOf(setup);
  // Pia signs up on her own: the provider places her (a workspace of her own) and starts a two-day trial
  const made = await request('POST', '/api/auth/signup', {
    body: { name: 'Pia Brandt', email: 'pia@e2e.test', password: PASSWORD, lang: 'en' },
    headers: origin,
  });
  assert(made.status === 200, made.text);
  const verified = await request('POST', '/api/auth/verify', {
    body: { token: await confirmToken('pia@e2e.test') },
    headers: { Cookie: cookieOf(made, 'vr_signup'), ...origin },
  });
  assert(verified.status === 200 && verified.json().signedIn === true, verified.text);
  const pia = cookieOf(verified);
  const status = (await request('GET', '/api/auth/status', { headers: { Cookie: pia } })).json();
  const piaWs = status.workspace.id;
  assert(piaWs !== 'w1' && status.workspace.role === 'owner', JSON.stringify(status.workspace));
  assert(fake().workspaces[piaWs]?.state === 'trial', `the provider started a trial: ${JSON.stringify(fake())}`);
  // Max: a member of Pia's workspace (invited, held until his address is confirmed)
  const inv = await request('POST', '/api/admin/invites', { body: { role: 'member' }, headers: { Cookie: pia, ...origin } });
  assert(inv.status === 200, inv.text);
  const took = await request('POST', '/api/auth/invite/accept', {
    body: { token: inv.json().url.split('/#/invite/')[1], name: 'Max Weber', email: 'max@e2e.test', password: PASSWORD },
    headers: origin,
  });
  assert(took.status === 200, took.text);
  const maxIn = await request('POST', '/api/auth/verify', {
    body: { token: await confirmToken('max@e2e.test') },
    headers: { Cookie: cookieOf(took, 'vr_signup'), ...origin },
  });
  assert(maxIn.status === 200, maxIn.text);
  const max = cookieOf(maxIn);

  browser = await launch();
  page = await browser.newPage();
  screenshotFailures(() => page, 'billing');
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  // Stripe.js and its frames come from the stand-in; every request to a Stripe host is written down
  const stripeRequests = [];
  const leftTheApp = [];
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const u = r.url();
    if (!/^https:\/\/([\w-]+\.)*stripe\.com\//.test(u)) return r.continue();
    stripeRequests.push(u);
    if (u === STRIPE_JS) return r.respond({ status: 200, contentType: 'application/javascript', body: FAKE_STRIPE });
    if (u.startsWith('https://js.stripe.com/fake-frame.html')) {
      return r.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><p>a card field</p>' });
    }
    return r.respond({ status: 404, body: '' });
  });
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame() && !f.url().startsWith(BASE)) leftTheApp.push(f.url());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));
  const host = new URL(BASE).hostname;
  const signIn = async (cookie) => {
    await page.deleteCookie(...(await page.cookies(BASE)));
    await page.setCookie({ name: 'vr_session', value: cookie.split('=')[1], domain: host, path: '/', httpOnly: true });
    // the payment form allowed in the cookie settings, as someone who chose before (checkout.mjs asks itself)
    await page.setCookie(consentCookie(BASE));
  };
  const text = (sel) => page.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim());
  const waitText = (sel, re, timeout = 15000) =>
    page.waitForFunction(
      (s, src) => new RegExp(src).test((document.querySelector(s)?.textContent ?? '').replace(/\s+/g, ' ')),
      { polling: 100, timeout },
      sel,
      re.source,
    );
  const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `billing-${name}.png`), fullPage: true });
  // a fresh document each time: a goto that changes only the hash keeps the page, its language and whose data it shows
  const fresh = async (hash) => {
    await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
  };
  // a segment by its first words (Yearly carries what it saves after them)
  const pick = (label) =>
    page.evaluate((l) => [...document.querySelectorAll('[data-testid=billing-plans] .seg button')].find((b) => b.textContent.startsWith(l)).click(), label);
  const openBilling = async () => {
    await fresh('#/settings/billing');
    await page.waitForSelector('[data-testid=billing-plan][data-kind]');
    await settle(page);
  };

  console.log(`billing e2e against ${BASE} (store ${srv.dir})`);

  await check('the trial’s last days: the library says so, with the way to the plans', async () => {
    await signIn(pia);
    await fresh('#/');
    await page.waitForSelector('[data-testid=billing-banner]', { timeout: 15000 });
    const banner = await text('[data-testid=billing-banner]');
    assert(/The trial ends on .+\. Choose a plan to keep everything as it is\./.test(banner), banner);
    assert(banner.includes('Choose a plan'), banner);
    // the next load paints the banner's room from the plan this browser kept: the library doesn't drop when it arrives
    await page.waitForFunction(
      () =>
        new Promise((done) => {
          const open = indexedDB.open('vr-cache');
          open.onerror = () => done(false);
          open.onsuccess = () => {
            try {
              const all = open.result.transaction('queries').objectStore('queries').getAll();
              all.onsuccess = () => done(all.result.some((e) => Array.isArray(e.key) && e.key[0] === 'billing' && e.key.length === 1));
              all.onerror = () => done(false);
            } catch {
              done(false);
            }
          };
        }),
      { polling: 200, timeout: 15000 },
    );
    const watch = await page.evaluateOnNewDocument(() => {
      window.__bannerShift = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries())
          if (!e.hadRecentInput && e.sources?.some((x) => x.node?.closest?.('main.lib-scroll'))) window.__bannerShift += e.value;
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=billing-banner]', { timeout: 15000 });
    await settle(page);
    const shift = await page.evaluate(() => window.__bannerShift);
    await page.removeScriptToEvaluateOnNewDocument(watch.identifier);
    assert(shift < 0.005, `the library didn't move for the banner (layout shift ${shift.toFixed(4)})`);
    await shot('banner-trial');
    const fit = await fitsAt(page, 'library with the trial banner');
    assert(!fit.length, fit.join('\n'));
    await page.click('[data-testid=billing-banner] a.btn');
    await page.waitForSelector('[data-testid=billing-plan][data-kind]');
    assert((await page.evaluate(() => location.hash)) === '#/settings/billing');
  });

  await check('Settings → Billing: the plan panel — name, tag, the trial’s ruler, what the workspace uses — and the plans to choose', async () => {
    setFake(piaWs, { trialStartsAt: new Date(Date.now() - 12 * DAY).toISOString() });
    await openBilling();
    const plan = await text('[data-testid=billing-plan]');
    assert((await text('[data-testid=billing-plan] h2')) === 'Team', plan);
    assert(/Trial · 2 days left/.test(plan) && /Nothing to pay yet/.test(plan) && /No card until you choose/.test(plan), plan);
    assert(/Everything in Team until .+\. Choose a plan below to keep it; without one, .+ moves to Free\./.test(plan), plan);
    // the trial's fourteen days as frames: today the thirteenth, the end a half keyframe in its last three days
    const ruler = await page.$eval('[data-testid=billing-ruler]', (r) => ({
      cells: r.querySelectorAll('.bill-ruler-cells i').length,
      past: r.querySelectorAll('.bill-ruler-cells i.past').length,
      today: [...r.querySelectorAll('.bill-ruler-cells i')].findIndex((i) => i.classList.contains('today')),
      end: r.querySelector('.bill-ruler-end')?.dataset.shape,
    }));
    assert(ruler.cells === 14 && ruler.past === 12 && ruler.today === 12 && ruler.end === 'half', JSON.stringify(ruler));
    // in its last three days: what Free would mean, resource by resource
    assert(/What Free would mean for/.test(plan) && /Free holds 1/.test(plan) && /Free holds 10 GB/.test(plan), plan);
    const usage = await text('[data-testid=billing-usage]');
    assert(/Members\s*2 of 50/.test(usage), usage);
    assert(/Storage\s*0 MB of 1 TB/.test(usage), usage);
    assert(/Videos under review\s*0 · no limit/.test(usage), usage);
    // no limit is a dashed track, never a missing bar (audit m2)
    assert(await page.$('[data-testid=billing-videos] .bill-bar.none'), 'a dashed track for no limit');
    assert((await page.$$eval('.set-nav a', (as) => as.map((a) => a.textContent.trim()))).includes('Billing'), 'Billing in the nav');
    // the plans: tiles selected like radio buttons, yearly first, per month — as consumers pay them, with 19 % VAT (PAngV,
    // A13 CLOUD-2: the provider names the rate); the foot says the checkout works it out for the billing address
    const solo = () => text('[data-testid=billing-offer-solo]');
    assert(/€14\.28\s*a month/.test(await solo()) && /€171\.36 billed yearly · save 20%/.test(await solo()), await solo());
    assert(/€23\.80\s*per member\s*a month/.test(await text('[data-testid=billing-offer-team]')), await text('[data-testid=billing-offer-team]'));
    assert(
      /€285\.60 per member billed yearly · 2 months free/.test(await text('[data-testid=billing-offer-team]')),
      await text('[data-testid=billing-offer-team]'),
    );
    // no reverse charge here (the provider's seller has no VAT ID yet): a business abroad pays VAT like everyone
    assert(
      (await text('[data-testid=billing-vat]')) === 'Prices include 19% VAT. At the checkout it follows your billing address.',
      await text('[data-testid=billing-vat]'),
    );
    assert(/1 TB for €11\.90 a month/.test(await text('[data-testid=billing-plans] .bill-pk-foot')), await text('[data-testid=billing-plans] .bill-pk-foot'));
    assert((await text('[data-testid=billing-offer-team]')).includes('Your trial'), 'the trial’s plan is marked');
    assert(!(await page.$('[data-testid=billing-plans] .bill-tile button')), 'no button inside a tile');
    assert(await page.$eval('[data-testid=billing-offer-team] input', (i) => i.checked), 'the trial’s plan is selected');
    // Solo is for one person and the workspace has two: readable, not selectable, and it says why
    assert(await page.$eval('[data-testid=billing-offer-solo] input', (i) => i.disabled), 'Solo can’t be chosen with two members');
    assert(/Fits one member; .+ has 2\./.test(await solo()), await solo());
    // one bar: what the selection costs this workspace, and the one orange action
    const bar = () => text('[data-testid=billing-pick-bar]');
    assert(/Team for 2 members/.test(await bar()) && /€47\.60 a month · €571\.20 billed yearly, incl\. VAT/.test(await bar()), await bar());
    // two days left: paying ends the trial, and the bar says so before anyone clicks
    assert(/Team is billed from today: the trial ends when it starts\./.test(await bar()), await bar());
    assert(/Continue with Team/.test(await bar()), await bar());
    const orange = await page.$$eval('.bill-page .btn.primary', (bs) => bs.filter((b) => b.offsetParent).map((b) => b.textContent.trim()));
    assert(orange.length === 1, `one orange per view: ${orange.join(' | ')}`);
    await pick('Monthly');
    await waitText('[data-testid=billing-offer-solo]', /€17\.85\s*a month/);
    assert(/Billed monthly · €14\.28 if yearly/.test(await solo()), await solo());
    await pick('USD');
    await waitText('[data-testid=billing-offer-solo]', /\$17\.85/);
    // the member stepper tries another team size: the bar follows, nothing is asked of the provider
    const calls = fake().calls.length;
    await page.click('[data-testid=billing-stepper] button[aria-label="One member more"]');
    await waitText('[data-testid=billing-pick-bar]', /Team for 3 members/);
    assert(fake().calls.length === calls, 'trying a size changes no bill');
    await page.click('[data-testid=billing-stepper] button[aria-label="One member fewer"]');
    await shot('trial');
    if (SHOTS)
      for (const width of [390, 768, 1024]) {
        await page.setViewport({ width, height: 900 });
        await settle(page);
        await shot(`trial-${width}`);
      }
    await page.setViewport({ width: 1440, height: 900 });
    const problems = await layoutMatrix(page, { 'billing (trial)': null });
    assert(!problems.length, problems.join('\n'));
    assert(!stripeRequests.length, `nothing from Stripe before a payment form opens: ${stripeRequests.join(', ')}`);
  });

  await check('the plans’ VAT line: a business abroad pays none only where the provider offers reverse charge', async () => {
    setFake(piaWs, { reverseCharge: true });
    try {
      await openBilling();
      assert(
        (await text('[data-testid=billing-vat]')) ===
          'Prices include 19% VAT. At the checkout it follows your billing address: a business with a VAT ID from another EU country pays none.',
        await text('[data-testid=billing-vat]'),
      );
    } finally {
      setFake(piaWs, { reverseCharge: undefined });
    }
    await openBilling();
    assert(!/reverse|pays none/i.test(await text('.bill-page')), 'nothing about it without');
  });

  await check('Billing is one 1040 px column in the middle of its room, like every section; the plans’ rows line up in German', async () => {
    // the settings rule (audit X1): the column stands in the middle of the room beside the sections, at every width;
    // Billing's is only wider (1040 px, for three plans side by side), never pinned beside the nav
    const off = [];
    for (const [width, height, isMobile] of [
      [390, 844, true],
      [1024, 768, false],
      [1440, 900, false],
      [1920, 1080, false],
      [2560, 1440, false],
    ]) {
      await page.setViewport({ width, height, isMobile });
      await openBilling();
      const col = await page.$eval('.set-inner', (el) => {
        const r = el.getBoundingClientRect();
        const m = el.parentElement.getBoundingClientRect();
        return { width: Math.round(r.width), left: Math.round(r.left - m.left), right: Math.round(m.right - r.right), room: Math.round(m.width) };
      });
      if (Math.abs(col.left - col.right) > 1) off.push(`@${width}: not centred (${col.left} px left, ${col.right} px right)`);
      if (col.width !== Math.min(1040, col.room)) off.push(`@${width}: ${col.width} px wide in ${col.room} px of room (1040 px at most)`);
    }
    assert(!off.length, off.join('\n'));
    await page.setViewport({ width: 1440, height: 900 });
    // German: Team's line takes two lines, and still every tile's price, billing and facts sit level (subgrid)
    await page.evaluate(() => localStorage.setItem('vr.lang', 'de'));
    await openBilling();
    const rows = await page.$$eval('[data-testid=billing-plans] .bill-tile', (tiles) =>
      tiles.map((t) => ({
        line: t.querySelector('.bill-t-line').getBoundingClientRect().height,
        price: Math.round(t.querySelector('.bill-t-price').getBoundingClientRect().top),
        billed: Math.round(t.querySelector('.bill-t-billed').getBoundingClientRect().top),
        facts: Math.round(t.querySelector('.bill-t-facts').getBoundingClientRect().top),
        note: Math.round(t.querySelector('.bill-t-note').getBoundingClientRect().top),
      })),
    );
    assert(new Set(rows.map((r) => Math.round(r.line))).size > 1 || rows.some((r) => r.line > 20), `a line wraps in German: ${JSON.stringify(rows)}`);
    for (const k of ['price', 'billed', 'facts', 'note'])
      assert(new Set(rows.map((r) => r[k])).size === 1, `the tiles' ${k} rows line up: ${rows.map((r) => r[k]).join(', ')}`);
    await shot('trial-de');
    await page.evaluate(() => localStorage.removeItem('vr.lang'));
  });

  await check('information is never faint, and the page doesn’t move while it loads', async () => {
    await openBilling();
    const faint = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--faint)';
      document.body.append(probe);
      const f = getComputedStyle(probe).color;
      probe.remove();
      const out = [];
      for (const el of document.querySelectorAll('.bill-page *')) {
        const own = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
        if (own && el.offsetParent && getComputedStyle(el).color === f) out.push(`${el.className || el.tagName}: ${el.textContent.trim().slice(0, 40)}`);
      }
      return out;
    });
    assert(!faint.length, `--faint is for placeholders, not information (audit X2):\n${faint.join('\n')}`);
    // a load with the plan this browser kept: nothing on the page moves when the answers arrive
    const watch = await page.evaluateOnNewDocument(() => {
      window.__billShift = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (!e.hadRecentInput && e.sources?.some((x) => x.node?.closest?.('.set-inner'))) window.__billShift += e.value;
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=billing-pick-bar]', { timeout: 15000 });
    await settle(page);
    const shift = await page.evaluate(() => window.__billShift);
    await page.removeScriptToEvaluateOnNewDocument(watch.identifier);
    assert(shift < 0.01, `Billing didn't move while it loaded (layout shift ${shift.toFixed(4)})`);
  });

  await check('the app’s own pages may load Stripe.js and its frames; a review link’s never', async () => {
    const app = await request('GET', '/');
    const csp = String(app.headers['content-security-policy']);
    assert(/script-src 'self' 'sha256-[^']+' https:\/\/js\.stripe\.com https:\/\/\*\.js\.stripe\.com;/.test(csp), csp);
    assert(/frame-src 'self'[^;]* https:\/\/hooks\.stripe\.com;/.test(csp), csp);
    assert(/connect-src 'self'[^;]* https:\/\/api\.stripe\.com;/.test(csp), csp);
    const link = String((await request('GET', '/g/not-a-real-link')).headers['content-security-policy']);
    assert(!link.includes('stripe') && !link.includes('frame-src'), link);
  });

  await check('a plan picked on the website is selected and said once, with its interval and currency; anything else is ignored', async () => {
    await fresh('#/settings/billing?plan=cloud-business&interval=month&currency=usd');
    await waitText('[data-testid=billing-offer-business]', /Your pick/);
    assert(await page.$eval('[data-testid=billing-offer-business] input', (i) => i.checked), 'the pick is selected');
    assert(/You picked Business on lampo\.video, so it’s selected\. Nothing is charged until you confirm\./.test(await text('[data-testid=billing-picked]')));
    assert(/\$49\.98\s*per member/.test(await text('[data-testid=billing-offer-business]')), 'monthly, in dollars, as the website showed');
    assert((await page.evaluate(() => location.hash)) === '#/settings/billing', 'the pick leaves nothing in the address');
    assert(!(await text('[data-testid=billing-offer-team]')).includes('Your pick'), 'only the one picked');
    // Business doesn't carry a trial's days: billed from today, said in the bar
    assert(/Business is billed from today/.test(await text('[data-testid=billing-pick-bar]')), await text('[data-testid=billing-pick-bar]'));
    await fresh('#/settings/billing?plan=cloud-enterprise%3Cscript%3E');
    await page.waitForSelector('[data-testid=billing-offer-business]');
    assert(!(await text('[data-testid=billing-plans]')).includes('Your pick'), 'an unknown plan is ignored');
    assert(!stripeRequests.length, 'still nothing from Stripe');
  });

  await check('back from paying: Billing says so only in the tab that paid, never from an address alone', async () => {
    for (const q of ['paid=done', 'method=done', 'checkout=done']) {
      await fresh(`#/settings/billing?${q}`);
      await page.waitForSelector('[data-testid=billing-plan][data-kind]');
      assert(!(await page.$('[data-testid=billing-return]')), `${q}: said from the address alone`);
      assert((await page.evaluate(() => location.hash)) === '#/settings/billing', `${q}: the address is cleaned`);
    }
    // this tab started a payment (as the payment sheet and the checkout mark it right before they confirm)
    // and a bank's page that answers within the tab comes back through the address
    await page.evaluate(() => {
      sessionStorage.setItem('vr.billing.paying', String(Date.now()));
      location.hash = '#/settings/billing?paid=done';
    });
    await page.waitForSelector('[data-testid=billing-return]');
    assert(/the invoice is paid/.test(await text('[data-testid=billing-return]')));
    // said once: the same address again is a link's
    await fresh('#/settings/billing?paid=done');
    await page.waitForSelector('[data-testid=billing-plan][data-kind]');
    assert(!(await page.$('[data-testid=billing-return]')), 'said once');
  });

  await check('choosing a plan opens the checkout step at its own address; paid there, and Billing shows the plan', async () => {
    // the sweep above reloaded the page at phone sizes: monthly in USD again (the checkout itself: test/e2e/checkout.mjs)
    await openBilling();
    await pick('Monthly');
    await pick('USD');
    await waitText('[data-testid=billing-offer-team]', /\$28\.56/);
    await page.click('[data-testid=billing-go]');
    await page.waitForFunction(() => location.hash === '#/settings/billing/checkout?plan=team&interval=month&currency=usd', { polling: 100, timeout: 5000 });
    await page.waitForSelector('[data-testid=billing-checkout] [data-testid=billing-payment-element] iframe', { timeout: 15000 });
    await page.waitForFunction(() => !document.querySelector('[data-testid=billing-pay]')?.disabled, { polling: 100, timeout: 15000 });
    assert(stripeRequests.includes(STRIPE_JS), `Stripe.js from js.stripe.com: ${stripeRequests.join(', ')}`);
    const call = fake().calls.find((c) => c.kind === 'checkout');
    assert(call && call.plan === 'team' && call.interval === 'month' && call.currency === 'usd' && call.form === 'full', JSON.stringify(call));
    // back to the plans: the choice is still selected there
    await page.evaluate(() => {
      location.hash = '#/settings/billing';
    });
    await page.waitForSelector('[data-testid=billing-plans]');
    assert(await page.$eval('[data-testid=billing-offer-team] input', (i) => i.checked), 'Team still selected');
    assert(
      /Team for 2 members/.test(await text('[data-testid=billing-pick-bar]')) &&
        /\$57\.12 a month, billed monthly, incl\. VAT/.test(await text('[data-testid=billing-pick-bar]')),
      await text('[data-testid=billing-pick-bar]'),
    );
    await page.click('[data-testid=billing-go]');
    await page.waitForSelector('[data-testid=billing-checkout] [data-testid=billing-payment-element] iframe', { timeout: 15000 });
    await page.waitForFunction(() => !document.querySelector('[data-testid=billing-pay]')?.disabled, { polling: 100, timeout: 15000 });
    // two days of trial left are too few to carry: paying ends the trial, and the step says so (BILL-4)
    assert(
      (await text('[data-testid=billing-trial-ends]')) === 'The trial ends when you pay: Team is billed from today.',
      await text('[data-testid=billing-checkout]'),
    );
    // the order button says it costs money (§ 312j(3) BGB); a consumer asks for the start first (A13 CLOUD-2)
    await waitText('[data-testid=billing-pay]', /^Buy now$/);
    await page.click('[data-testid=billing-start] input');
    await page.click('[data-testid=billing-pay]');
    await page.waitForSelector('[data-testid=billing-checkout-done]', { timeout: 15000 });
    assert(
      fake().calls.some((c) => c.kind === 'confirm-checkout'),
      JSON.stringify(fake().calls),
    );
    await page.click('[data-testid=billing-see-billing]');
    await waitText('[data-testid=billing-plan]', /Active/);
    assert(
      /Billed monthly for 2 members, renews on .+ someone new adds \$24 a month, prorated\./.test(await text('[data-testid=billing-plan]')),
      await text('[data-testid=billing-plan]'),
    );
    assert(/\$48\s*a month/.test(await text('[data-testid=billing-price]')), await text('[data-testid=billing-price]'));
    assert((await page.evaluate(() => location.hash)) === '#/settings/billing', 'back on Billing');
    assert(!leftTheApp.length, `the page never left the app: ${leftTheApp.join(', ')}`);
    // a running plan: the plans wait behind Change plan; the current one says so and closes
    assert(!(await page.$('[data-testid=billing-plans]')), 'the plans are folded away once paid');
    await page.click('[data-testid=billing-change]');
    await page.waitForSelector('[data-testid=billing-offer-team]');
    assert(/Current/.test(await text('[data-testid=billing-offer-team]')), await text('[data-testid=billing-offer-team]'));
    assert(/This is your plan\./.test(await text('[data-testid=billing-pick-bar]')) && !(await page.$('[data-testid=billing-go]')), 'the current plan closes');
    await page.click('[data-testid=billing-offer-business]');
    await waitText('[data-testid=billing-pick-bar]', /Switch to Business/);
    await shot('paid');
  });

  await check('the account panel: the card and the invoice; a new card for renewals; the old one removed, Undo until then', async () => {
    await waitText('[data-testid=billing-methods]', /Visa •••• 4242\s*Expires 12\/2031\s*Default/);
    await waitText('[data-testid=billing-invoices]', /\$48\.00.*Paid/);
    const pdf = await page.$eval('[data-testid=billing-invoice-pdf]', (a) => a.getAttribute('href'));
    assert(/fake-invoice-\d+\.pdf$/.test(pdf), pdf);
    await page.click('[data-testid=billing-method-add]');
    await page.waitForSelector('[data-testid=billing-setup] [data-testid=billing-payment-element] iframe');
    await page.waitForSelector('[data-testid=billing-setup] .co-el.settled');
    assert((await page.evaluate(() => window.__fakeStripe.options?.init?.developerTools?.assistant?.enabled)) === false, 'no assistant on the card form');
    // the card alone: no wallets, no Link, the country only where a card needs it, Stripe's terms line
    const intent = await page.evaluate(() => window.__fakeStripe.options?.intent);
    assert(
      intent?.wallets?.link === 'never' &&
        intent.wallets.applePay === 'never' &&
        intent.fields?.billingDetails?.address === 'if_required' &&
        intent.terms?.card === 'auto',
      JSON.stringify(intent),
    );
    assert(await page.$eval('[data-testid=billing-method-renewals]', (c) => c.checked), 'a new card is for renewals unless said otherwise');
    assert((await text('[data-testid=billing-intent-submit]')) === 'Save card', await text('[data-testid=billing-intent-submit]'));
    await shot('new-card');
    await page.click('[data-testid=billing-intent-submit]');
    await waitText('[data-testid=billing-methods]', /Mastercard •••• 4444\s*Expires 12\/2031\s*Default/);
    assert(
      fake().calls.some((c) => c.kind === 'default'),
      'the new card is the one renewals use',
    );
    assert((await page.evaluate(() => window.__fakeStripe.calls)).some((c) => c[0] === 'confirmSetup' && c[1] === 'if_required'));
    // the Visa is no longer the default: Remove says so in its row, Undo puts it back, nothing is sent until the toast goes
    const removeVisa = () =>
      page.evaluate(() => {
        const row = [...document.querySelectorAll('[data-testid=billing-method]')].find((r) => r.textContent.includes('4242'));
        row.querySelector('[data-testid=billing-method-remove]').click();
      });
    await removeVisa();
    await waitText('[data-testid=billing-methods]', /Visa •••• 4242 removed\./);
    await page.click('[data-testid=billing-method-undo]');
    await waitText('[data-testid=billing-methods]', /Visa •••• 4242\s*Expires/);
    assert(!fake().calls.some((c) => c.kind === 'remove'), 'Undo: nothing was removed');
    await removeVisa();
    await page.waitForFunction(() => ![...document.querySelectorAll('[data-testid=billing-methods]')].some((r) => r.textContent.includes('4242')), {
      polling: 200,
      timeout: 20000,
    });
    assert(
      fake().calls.some((c) => c.kind === 'remove'),
      JSON.stringify(fake().calls),
    );
    assert(!leftTheApp.length, leftTheApp.join(', '));
  });

  await check('billing details: edited in their row, the VAT ID said wrong at its field, then checked by the provider', async () => {
    await waitText('[data-testid=billing-address]', /Hafenstraße 1 · 20457 Hamburg · Germany/);
    await page.click('[data-testid=billing-details-edit]');
    await page.waitForSelector('[data-testid=billing-details-form]');
    // focus goes to the first field (audit m8); every field is labelled and the one control height
    assert(await page.evaluate(() => document.activeElement?.closest('.entry-field')?.textContent.startsWith('Company or name')), 'focus on the first field');
    const heights = await page.$$eval('[data-testid=billing-details-form] :is(.gate-input, .input.select)', (els) =>
      els.map((e) => e.getBoundingClientRect().height),
    );
    assert(heights.length >= 6 && heights.every((h) => h === 40), `40 px fields: ${heights.join(', ')}`);
    const field = (label) =>
      page.evaluateHandle(
        (l) =>
          [...document.querySelectorAll('[data-testid=billing-details-form] .entry-field')]
            .find((f) => f.querySelector('.inv-label')?.textContent === l)
            ?.querySelector('input'),
        label,
      );
    const name = await field('Company or name');
    await name.evaluate((i) => i.select());
    await name.type('Brandt Film GmbH');
    // a German VAT ID that can't be one: said at the field, in the error colour, and nothing is saved
    await page.type('[data-testid=billing-vat-input]', 'DE12');
    await page.click('[data-testid=billing-details-save]');
    await waitText('[data-testid=billing-vat-error]', /German VAT IDs are DE and 9 digits\./);
    const err = await page.$eval('[data-testid=billing-vat-error]', (e) => ({
      color: getComputedStyle(e).color,
      must: (() => {
        const p = document.createElement('span');
        p.style.color = 'var(--must)';
        document.body.append(p);
        const c = getComputedStyle(p).color;
        p.remove();
        return c;
      })(),
    }));
    assert(err.color === err.must, `in --must, not a warning's amber: ${JSON.stringify(err)}`);
    assert(!fake().calls.some((c) => c.kind === 'details'), 'nothing saved with a wrong VAT ID');
    await shot('details-vat');
    const vat = await page.$('[data-testid=billing-vat-input]');
    await vat.evaluate((i) => i.select());
    await vat.type('de 123 456 789');
    await page.click('[data-testid=billing-details-save]');
    await waitText('[data-testid=billing-address]', /Brandt Film GmbH/);
    const saved = fake().calls.find((c) => c.kind === 'details');
    assert(saved?.name === 'Brandt Film GmbH' && saved.address.country === 'DE' && saved.address.postalCode === '20457', JSON.stringify(saved));
    assert(
      fake().calls.some((c) => c.kind === 'tax-id' && c.type === 'eu_vat' && c.value === 'DE123456789'),
      JSON.stringify(fake().calls),
    );
    await waitText('[data-testid=billing-taxids]', /DE123456789\s*checked: Brandt Film GmbH, Hamburg/);
    await shot('account');
    const problems = await layoutMatrix(page, { 'billing (paid, the account)': null });
    assert(!problems.length, problems.join('\n'));
  });

  await check('on a phone the account’s rows keep their badges whole: a card’s actions under its name, each invoice in two lines', async () => {
    const d = fake();
    d.accounts[piaWs].methods.push({ id: 'pm_long', type: 'card', brand: 'cartes_bancaires', last4: '1881', expMonth: 3, expYear: 2029, default: false });
    for (let i = 0; i < 3; i++)
      d.accounts[piaWs].invoices.push({
        id: `in_old${i}`,
        number: `LAMPO-01${i}`,
        date: new Date(Date.now() - (i + 2) * 30 * DAY).toISOString(),
        total: 4800,
        currency: 'usd',
        status: 'paid',
        pdf: `${BASE}/old-${i}.pdf`,
        description: 'Team · monthly · 2 members',
      });
    fs.writeFileSync(FAKE, JSON.stringify(d, null, 2));
    await page.setViewport({ width: 390, height: 844 });
    await openBilling();
    await page.waitForSelector('[data-testid=billing-invoice]');
    const rows = await page.evaluate(() => {
      const one = (el) => el.getClientRects().length === 1 && el.scrollWidth <= el.clientWidth + 1;
      return {
        tags: [...document.querySelectorAll('.bill-acct .bill-tag')].filter((t) => !one(t) || t.getBoundingClientRect().height > 20).map((t) => t.textContent),
        names: [...document.querySelectorAll('.bill-pm-t b')].filter((b) => b.getBoundingClientRect().height > 24).map((b) => b.textContent),
        // the lines a row's cells sit on: centres closer than half a line are one line
        invoices: [...document.querySelectorAll('[data-testid=billing-invoice]')].map((r) => {
          const mids = [...r.children]
            .filter((c) => c.offsetParent && c.textContent.trim())
            .map((c) => c.getBoundingClientRect())
            .map((b) => b.top + b.height / 2)
            .sort((a, b) => a - b);
          return mids.filter((m, i) => i === 0 || m - mids[i - 1] > 8).length;
        }),
      };
    });
    assert(!rows.tags.length, `badges wrap: ${rows.tags.join(', ')}`);
    assert(!rows.names.length, `card names break: ${rows.names.join(', ')}`);
    assert(
      rows.invoices.every((n) => n === 2),
      `each invoice in two lines: ${rows.invoices.join(', ')}`,
    );
    await shot('account-390');
    await page.setViewport({ width: 1440, height: 900 });
  });

  await check('a switch says what the next invoice will be; cancelling (what Free would mean) and keeping the plan', async () => {
    await openBilling();
    await page.click('[data-testid=billing-change]');
    await page.click('[data-testid=billing-offer-business]');
    await page.click('[data-testid=billing-go]');
    await page.waitForSelector('[data-testid=confirm-action]');
    const dialog = await text('[data-testid=confirm]');
    assert(/Switch to Business\?/.test(dialog) && /The next invoice, on .+, will be \$84/.test(dialog), dialog);
    await page.click('[data-testid=confirm-action]');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=toast]')].some((t) => t.textContent.includes('Business it is')), {
      polling: 100,
      timeout: 10000,
    });
    assert(
      fake().calls.some((c) => c.kind === 'plan' && c.plan === 'business'),
      JSON.stringify(fake().calls),
    );
    await waitText('[data-testid=billing-plan] h2', /Business/);
    // § 312k BGB (A13 CLOUD-2): "Cancel contracts here" leads straight to its confirmation step, at its own address
    assert((await text('[data-testid=billing-cancel]')) === 'Cancel contracts here', await text('[data-testid=billing-cancel]'));
    await page.click('[data-testid=billing-cancel]');
    await page.waitForSelector('[data-testid=billing-cancel-step] .co-title');
    assert((await page.evaluate(() => location.hash)) === '#/settings/billing/cancel', await page.evaluate(() => location.hash));
    assert(/^Cancel Business for /.test(await text('.co-title')), await text('.co-title'));
    assert(await page.$eval('.co-title', (h) => document.activeElement === h), 'the title has the focus');
    // how (at the period's end, or for an important reason), who, which plan, until when, where the confirmation goes
    const contract = await text('[data-testid=billing-cancel-contract]');
    for (const w of ['Business', 'Cancelled by', 'Pia Brandt · pia@e2e.test', 'Ends', 'Confirmation to', 'Cancel now'])
      assert(contract.includes(w), `“${w}” in: ${contract}`);
    assert(await page.$('[data-testid=billing-cancel-step] [data-testid=billing-fit]'), 'what Free would mean, before cancelling');
    // an important reason needs its words
    await page.click('[data-testid=billing-cancel-extraordinary] input');
    await page.click('[data-testid=billing-cancel-now]');
    await waitText('[data-testid=billing-cancel-step]', /Say the reason in a few words\./);
    assert(!fake().calls.some((c) => c.kind === 'cancel'), 'nothing sent without the reason');
    await shot('cancel-step');
    const fit = await layoutMatrix(page, { 'the cancellation step': null }, { widths: [390, 1440], themes: ['light', 'dark'] });
    assert(!fit.length, fit.join('\n'));
    // at the period's end: received, when, until when, the confirmation on its way
    await page.click('[data-testid=billing-cancel-ordinary] input');
    await page.click('[data-testid=billing-cancel-now]');
    await page.waitForSelector('[data-testid=billing-cancel-done]');
    const done = await text('[data-testid=billing-cancel-done]');
    assert(
      /Your cancellation is received/.test(done) &&
        /Received\s*\w+ \d+, 20\d\d/.test(done) &&
        /Ends\s*\w+ \d+, 20\d\d/.test(done) &&
        /pia@e2e\.test/.test(done),
      done,
    );
    assert(
      fake().calls.some((c) => c.kind === 'cancel' && c.how === 'ordinary'),
      JSON.stringify(fake().calls),
    );
    await shot('cancel-done');
    await page.click('[data-testid=billing-cancel-see-billing]');
    await waitText('[data-testid=billing-plan]', /Ends /);
    assert(
      /Cancelled: Business runs until .+, then .+ moves to Free\./.test(await text('[data-testid=billing-plan]')),
      await text('[data-testid=billing-plan]'),
    );
    // cancelled: Keep is the view's one orange
    const orange = await page.$$eval('.bill-page .btn.primary', (bs) => bs.filter((b) => b.offsetParent).map((b) => b.textContent.trim()));
    assert(orange.length === 1 && orange[0] === 'Keep Business', orange.join(' | '));
    await page.click('[data-testid=billing-resume]');
    await waitText('[data-testid=billing-plan]', /Active/);
    assert(
      ['cancel', 'resume'].every((k) => fake().calls.some((c) => c.kind === k)),
      JSON.stringify(fake().calls),
    );
  });

  await check(
    'a consumer’s yearly plan after its first year: one month’s notice and its refund, in the step, the contract, the receipt and the plan; kept, nothing owed',
    async () => {
      // real-shaped: Team for two, billed yearly in euros (€571.20 with VAT), renewed in December and renewing again in
      // ten months; the provider answers for today: the end one month on, the time paid for after it refunded
      const ends = new Date(Date.now() + 31 * DAY);
      ends.setUTCHours(21, 59, 59, 0);
      const date = ends.toLocaleDateString('en', { day: 'numeric', month: 'long', year: 'numeric' });
      const before = fake().workspaces[piaWs];
      setFake(piaWs, {
        plan: 'team',
        planName: 'Team',
        interval: 'year',
        currency: 'eur',
        currencies: ['eur'],
        renewsAt: new Date(Date.now() + 300 * DAY).toISOString(),
        cancelWays: { notice: { endsAt: ends.toISOString(), refund: { amount: 45415, currency: 'eur', days: 291, of: 366 } } },
      });
      try {
        await fresh('#/settings/billing/cancel');
        await page.waitForSelector('[data-testid=billing-cancel-step] .co-title');
        // the way is there with the step's first paint (asked before it shows): nothing comes in later and moves
        const ways = await page.$$eval('.co-radios .co-chk', (ls) => ls.map((l) => l.dataset.testid));
        assert(
          JSON.stringify(ways) === JSON.stringify(['billing-cancel-ordinary', 'billing-cancel-notice', 'billing-cancel-extraordinary']),
          JSON.stringify(ways),
        );
        assert(await page.$eval('[data-testid=billing-cancel-ordinary] input', (i) => i.checked), 'the period’s end stays the first choice');
        assert((await text('[data-testid=billing-cancel-notice] .co-chk-t')).startsWith('With one month’s notice'), 'its name');
        const way = await text('[data-testid=billing-cancel-notice] small');
        assert(way === `Team ends on ${date}; the time paid for after that, €454.15, goes back to your card once it has ended. Nothing is deleted.`, way);
        // the contract has a Refund row for every way, so choosing one doesn't move the button
        // (measured once the page has settled: the step arrives with a View Transition)
        const buttonTop = () => page.$eval('[data-testid=billing-cancel-now]', (b) => Math.round(b.getBoundingClientRect().top));
        await settle(page);
        const top = await buttonTop();
        assert(/Refund\s*None/.test(await text('[data-testid=billing-cancel-contract]')), await text('[data-testid=billing-cancel-contract]'));
        await page.click('[data-testid=billing-cancel-notice] input');
        await waitText('[data-testid=billing-cancel-contract]', /Refund\s*€454\.15 for 291 of 366 days/);
        await settle(page);
        assert(new RegExp(`Ends\\s*${date}`).test(await text('[data-testid=billing-cancel-contract]')), await text('[data-testid=billing-cancel-contract]'));
        const moved = await buttonTop();
        assert(moved === top, `the button stays where it was: ${top} → ${moved}`);
        assert(await page.$('[data-testid=billing-cancel-step] [data-testid=billing-fit]'), 'what Free would mean, as at the period’s end');
        await shot('cancel-notice');
        const fit = await layoutMatrix(
          page,
          { 'the cancellation step with notice': null },
          { widths: [390, 1440], themes: ['light', 'dark'], each: (w, theme) => shot(`cancel-notice-${w}-${theme}`) },
        );
        assert(!fit.length, fit.join('\n'));
        // German: the way in its own words (du)
        await page.evaluate(() => localStorage.setItem('vr.lang', 'de'));
        await fresh('#/settings/billing/cancel');
        await page.waitForSelector('[data-testid=billing-cancel-notice]');
        await page.click('[data-testid=billing-cancel-notice] input');
        assert((await text('[data-testid=billing-cancel-notice] .co-chk-t')).startsWith('Mit einer Frist von einem Monat'), 'its name in German');
        assert(
          /^Team endet am .+; die bezahlte Zeit danach, 454,15\s€, geht auf deine Karte zurück, sobald er geendet hat\./.test(
            await text('[data-testid=billing-cancel-notice] small'),
          ),
          await text('[data-testid=billing-cancel-notice] small'),
        );
        assert(
          /Erstattung\s*454,15\s€ für 291 von 366 Tagen/.test(await text('[data-testid=billing-cancel-contract]')),
          await text('[data-testid=billing-cancel-contract]'),
        );
        assert((await text('[data-testid=billing-cancel-now]')) === 'Jetzt kündigen', 'the published words stay');
        const de = await layoutMatrix(page, { 'the cancellation step with notice (German)': null }, { widths: [390, 1440], themes: ['light'] });
        assert(!de.length, de.join('\n'));
        await shot('cancel-notice-de');
        await page.evaluate(() => localStorage.removeItem('vr.lang'));
        await fresh('#/settings/billing/cancel');
        await page.waitForSelector('[data-testid=billing-cancel-notice]');
        await page.click('[data-testid=billing-cancel-notice] input');
        // received: when it ends, the refund, how it goes back, the confirmation
        await page.click('[data-testid=billing-cancel-now]');
        await page.waitForSelector('[data-testid=billing-cancel-done]');
        const done = await text('[data-testid=billing-cancel-done]');
        assert(
          new RegExp(`With one month’s notice, Team for .+ ends on ${date}; then .+ moves to Free\\. Nothing is deleted\\.`).test(done) &&
            /Refund\s*€454\.15/.test(done) &&
            /Received\s*\w+ \d+, 20\d\d/.test(done),
          done,
        );
        assert(
          (await text('[data-testid=billing-cancel-refund]')) ===
            '€454.15 for 291 of the 366 days paid for goes back to the card the plan was paid with once it has ended, with a credit note.',
          await text('[data-testid=billing-cancel-refund]'),
        );
        assert(
          fake().calls.some((c) => c.kind === 'cancel' && c.how === 'notice'),
          JSON.stringify(fake().calls),
        );
        await shot('cancel-notice-done');
        // Billing: cancelled, with the refund it owes; Keep is the one orange, and keeping owes nothing
        await page.click('[data-testid=billing-cancel-see-billing]');
        await waitText('[data-testid=billing-plan]', /Cancelled with one month’s notice/);
        const plan = await text('[data-testid=billing-plan]');
        assert(
          new RegExp(`Team runs until ${date}, then .+ moves to Free, and the time paid for after that, €454\\.15, goes back to your card\\.`).test(plan) &&
            /Then nothing is refunded: it simply renews again\./.test(plan),
          plan,
        );
        const orange = await page.$$eval('.bill-page .btn.primary', (bs) => bs.filter((b) => b.offsetParent).map((b) => b.textContent.trim()));
        assert(orange.length === 1 && orange[0] === 'Keep Team', orange.join(' | '));
        await shot('plan-notice');
        const planFit = await layoutMatrix(
          page,
          { 'the plan cancelled with notice': null },
          { widths: [390, 1440], each: (w, theme) => shot(`plan-notice-${w}-${theme}`) },
        );
        assert(!planFit.length, planFit.join('\n'));
        await page.click('[data-testid=billing-resume]');
        await waitText('[data-testid=billing-plan]', /Active/);
        assert(!/refund/i.test(await text('[data-testid=billing-plan]')), await text('[data-testid=billing-plan]'));
      } finally {
        // the workspace as the checks before left it (Business, monthly, in dollars)
        const d = fake();
        d.workspaces[piaWs] = before;
        fs.writeFileSync(FAKE, JSON.stringify(d, null, 2));
      }
    },
  );

  await check('the Lampo badge: on every plan; a paid workspace’s admin hides it in Settings → Review links, and its links say so', async () => {
    // a review link of Pia's workspace, opened by a visitor
    const clip = makeVideo(path.join(fakeDir, 'harbor-spot.mp4'), { dur: 0.5 });
    const up = await tusUpload(request, clip, { filename: 'harbor-spot.mp4' }, { Cookie: pia, ...origin });
    assert(up.status === 200, up.text);
    const made = await request('POST', `/api/review/${encodeURIComponent(up.json().slug)}/shares`, {
      body: { label: 'Harbor' },
      headers: { Cookie: pia, ...origin },
    });
    assert(made.status === 200, made.text);
    const link = made.json().token;
    const badgeOnLink = async () => (await request('GET', `/api/g/${link}`)).json().badge;
    assert((await badgeOnLink()) === true, 'on by default, paid or not');
    // not paid (Free, a trial): the switch is there, off and closed, with the way to the plans
    const paidState = fake().workspaces[piaWs];
    setFake(piaWs, { state: 'free' });
    await fresh('#/settings/links');
    await page.waitForSelector('[data-testid=set-badge] [role=switch]');
    await waitText('[data-testid=set-badge]', /With a paid plan\./);
    const off = await page.$eval('[data-testid=set-badge]', (c) => ({
      text: c.textContent,
      disabled: c.querySelector('[role=switch]').disabled,
      checked: c.querySelector('[role=switch]').getAttribute('aria-checked'),
      plans: c.querySelector('[data-testid=badge-plans]')?.getAttribute('href'),
    }));
    assert(off.disabled && off.checked === 'false' && off.plans === '#/settings/billing', JSON.stringify(off));
    assert(/Hide the Lampo badge/.test(off.text) && !/no badge/i.test(off.text), off.text);
    const d = fake();
    d.workspaces[piaWs] = paidState;
    fs.writeFileSync(FAKE, JSON.stringify(d, null, 2));
    // paid: the admin hides it; the link's answer and its page say so, the source offer stays
    await fresh('#/settings/links');
    await page.waitForFunction(() => document.querySelector('[data-testid=set-badge] [role=switch]')?.disabled === false, { polling: 100, timeout: 10000 });
    await shot('badge-switch');
    await page.click('[data-testid=set-badge] [role=switch]');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=toast]')].some((t) => t.textContent.includes('Lampo badge is hidden')), {
      polling: 100,
      timeout: 10000,
    });
    assert((await badgeOnLink()) === false, 'the link says badge: false');
    await page.goto(`${BASE}/g/${link}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=g-foot]');
    const foot = await page.$eval('[data-testid=g-foot]', (f) => ({
      powered: !!f.querySelector('[data-testid=powered-by]'),
      source: !!f.querySelector('[data-testid=source-link]'),
      legal: f.querySelector('[data-testid=g-legal]')?.textContent.replace(/\s+/g, ' ').trim(),
    }));
    // one line without the badge, the source offer first (the dots are the foot's own, between the links)
    assert(!foot.powered && foot.source && foot.legal === 'Source·Imprint·Privacy', JSON.stringify(foot));
    // shown again
    await fresh('#/settings/links');
    await page.waitForFunction(() => document.querySelector('[data-testid=set-badge] [role=switch]')?.getAttribute('aria-checked') === 'true', {
      polling: 100,
      timeout: 10000,
    });
    await page.click('[data-testid=set-badge] [role=switch]');
    await page.waitForFunction(() => document.querySelector('[data-testid=set-badge] [role=switch]')?.getAttribute('aria-checked') === 'false', {
      polling: 100,
      timeout: 10000,
    });
    // the switch turns at once (optimistic, rolled back on a failure); the link answers once the server has it: the toast
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=toast]')].some((t) => t.textContent.includes('The Lampo badge shows again')), {
      polling: 100,
      timeout: 10000,
    });
    assert((await badgeOnLink()) === true, 'shown again');
  });

  await check('a failed renewal: the plan says so with its week of grace; the fix in a sheet — declined at the field, then paid', async () => {
    addInvoice(piaWs, {
      id: 'in_open',
      number: 'LAMPO-0099',
      date: new Date().toISOString(),
      total: 8400,
      currency: 'usd',
      status: 'open',
      pdf: `${BASE}/open.pdf`,
      description: 'Business · monthly · 2 members',
    });
    const d = fake();
    d.accounts[piaWs].methods = d.accounts[piaWs].methods.map((m) => (m.default ? { ...m, expMonth: 1, expYear: 2025, expired: true } : m));
    fs.writeFileSync(FAKE, JSON.stringify(d, null, 2));
    setFake(piaWs, {
      state: 'grace',
      reason: 'payment',
      graceUntil: new Date(Date.now() + 5 * DAY).toISOString(),
      failure: {
        invoice: 'LAMPO-0099',
        amount: 8400,
        currency: 'usd',
        method: 'Mastercard •••• 4444',
        code: 'expired_card',
        retryAt: [new Date(Date.now() + 2 * DAY).toISOString()],
      },
    });
    await openBilling();
    const plan = await text('[data-testid=billing-plan]');
    assert(/Payment due/.test(plan) && /didn’t go through: Mastercard •••• 4444 has expired\. Everything keeps working until/.test(plan), plan);
    const grace = await page.$eval('[data-testid=billing-ruler]', (r) => ({
      cells: r.querySelectorAll('i').length,
      end: r.querySelector('.bill-ruler-end')?.dataset.shape,
    }));
    assert(grace.cells === 7 && grace.end === 'diamond', JSON.stringify(grace));
    await waitText('[data-testid=billing-invoices]', /\$84\.00.*Open/);
    assert(/Expired 01\/2025/.test(await text('[data-testid=billing-methods]')), await text('[data-testid=billing-methods]'));
    const orange = await page.$$eval('.bill-page .btn.primary', (bs) => bs.filter((b) => b.offsetParent).map((b) => b.textContent.trim()));
    assert(orange.length === 1 && orange[0] === 'Pay $84.00', orange.join(' | '));
    await page.click('[data-testid=billing-pay-now]');
    await page.waitForSelector('[data-testid=billing-fix] [data-testid=billing-payment-element] iframe');
    await page.waitForSelector('[data-testid=billing-fix] .co-el.settled');
    const sheet = await text('[data-testid=billing-fix]');
    assert(/Stripe tries the old card again on .+; a new card settles it now\./.test(sheet), sheet);
    assert(/What still works/.test(sheet) && /Nothing is deleted, ever, because of a payment\./.test(sheet), sheet);
    assert(/LAMPO-0099.*\$84\.00.*Open/.test(await text('[data-testid=billing-fix-invoice]')), await text('[data-testid=billing-fix-invoice]'));
    await waitText('[data-testid=billing-fix] [data-testid=billing-intent-submit]', /Pay \$84\.00$/);
    await shot('fix-payment');
    // declined: at the field, in the error colour; nothing paid
    await page.evaluate(() => {
      window.__fakeStripe.decline = true;
    });
    await page.click('[data-testid=billing-fix] [data-testid=billing-intent-submit]');
    await waitText('[data-testid=billing-fix] [data-testid=billing-pay-error]', /Your bank declined this card\. Nothing was charged\./);
    assert(!fake().calls.some((c) => c.kind === 'confirm-payment'), 'nothing was paid');
    await page.click('[data-testid=billing-fix] [data-testid=billing-intent-submit]');
    await page.waitForSelector('[data-testid=billing-fix-done]', { timeout: 15000 });
    assert(/Paid\. Business goes on\./.test(await text('.modal-head')), await text('.modal-head'));
    assert(/\$84\.00 for Business is paid\. Renewals use/.test(await text('[data-testid=billing-fix-done]')), await text('[data-testid=billing-fix-done]'));
    assert(
      fake().calls.some((c) => c.kind === 'confirm-payment'),
      JSON.stringify(fake().calls),
    );
    await page.keyboard.press('Escape');
    await waitText('[data-testid=billing-plan]', /Active/);
    await waitText('[data-testid=billing-methods]', /American Express •••• 0005\s*Expires 12\/2031\s*Default/);
    assert(!leftTheApp.length, leftTheApp.join(', '));
  });

  await check('read-only: the library says so; a refused invite shows the provider’s sentence and the way to the plans', async () => {
    setFake(piaWs, { state: 'read-only', reason: 'over-limit', failure: undefined });
    await fresh('#/');
    await waitText('[data-testid=billing-banner]', /is read-only for now\. Nothing is deleted, and the review links you sent keep working\./);
    assert(await page.$('[data-testid=billing-banner].bad'), 'the read-only banner is the stronger one');
    await shot('banner-read-only');
    await fresh('#/settings/users');
    await page.waitForSelector('form.set-form');
    await page.$eval('form.set-form', (f) => f.requestSubmit());
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[data-testid=toast]')].some((t) =>
          t.textContent.includes('This workspace is over its plan, so it is read-only for now'),
        ),
      { polling: 100, timeout: 10000 },
    );
    await page.evaluate(() => [...document.querySelectorAll('[data-testid=toast] button')].find((b) => b.textContent === 'See plans').click());
    await page.waitForSelector('[data-testid=billing-plan][data-kind]');
    assert(/Read-only/.test(await text('[data-testid=billing-plan]')), await text('[data-testid=billing-plan]'));
  });

  await check('German: the page in German, the refusal in the provider’s German', async () => {
    await page.evaluate(() => localStorage.setItem('vr.lang', 'de'));
    await openBilling();
    assert((await text('.set-head h1')) === 'Abrechnung', await text('.set-head h1'));
    assert(/Nur lesen/.test(await text('[data-testid=billing-plan]')), await text('[data-testid=billing-plan]'));
    assert(/pro Mitglied\s*im Monat/.test(await text('[data-testid=billing-offer-team]')), await text('[data-testid=billing-offer-team]'));
    await shot('read-only-de');
    const fit = await fitsAt(page, 'billing (German, read-only)');
    assert(!fit.length, fit.join('\n'));
    await fresh('#/settings/users');
    await page.waitForSelector('form.set-form');
    await page.$eval('form.set-form', (f) => f.requestSubmit());
    await page.waitForFunction(
      () => [...document.querySelectorAll('[data-testid=toast]')].some((t) => t.textContent.includes('Dieser Workspace ist über seinem Plan')),
      { polling: 100, timeout: 10000 },
    );
    assert(
      await page.evaluate(() => [...document.querySelectorAll('[data-testid=toast] button')].some((b) => b.textContent === 'Pläne ansehen')),
      'the way to the plans, in German',
    );
    await page.evaluate(() => localStorage.removeItem('vr.lang'));
  });

  await check('the operator’s own workspace: complimentary, in its own words — nothing to set up, no limits', async () => {
    await signIn(olivia);
    await openBilling();
    const plan = await text('[data-testid=billing-plan]');
    assert(/Complimentary/.test(plan) && /On the house/.test(plan) && /is complimentary: everything Lampo has, no limits/.test(plan), plan);
    assert((await page.$$('[data-testid=billing-usage] .bill-bar.none')).length === 3, 'no limits: three dashed tracks');
    const who = await text('[data-testid=billing-who]');
    assert(/Nothing to set up here: no payment method, no invoices\./.test(who), who);
    assert(!/choose the plan/.test(await text('.bill-page')), 'not the members’ sentence to the owner');
    assert(!(await page.$('[data-testid=billing-plans]')), 'no plans to choose');
    await shot('complimentary');
  });

  await check('a member reads the plan and the grace period, never the prices — and can let the owners know', async () => {
    setFake(piaWs, {
      state: 'grace',
      reason: 'payment',
      graceUntil: new Date(Date.now() + 5 * DAY).toISOString(),
      failure: { invoice: 'LAMPO-0100', amount: 8400, currency: 'usd', method: 'American Express •••• 0005', code: 'card_declined' },
    });
    await signIn(max);
    await fresh('#/');
    await waitText('[data-testid=billing-banner]', /The last payment failed\. Everything keeps working until/);
    assert((await text('[data-testid=billing-banner]')).includes('Details'), 'a member gets the details, not the plans');
    await openBilling();
    assert(
      /The owner and the admins of .+ choose the plan and how it’s paid\./.test(await text('[data-testid=billing-who]')),
      await text('[data-testid=billing-who]'),
    );
    assert(!(await page.$('[data-testid=billing-plans]')), 'no prices for a member');
    assert(!(await page.$('[data-testid=billing-price]')), 'no price beside the plan');
    assert(!(await page.$('[data-testid=billing-methods]')), 'no payment methods for a member');
    assert(!(await page.$('[data-testid=billing-invoices]')), 'no invoices for a member');
    assert(!(await page.evaluate(() => 'Stripe' in window)), 'no Stripe.js for a member');
    const plan = await text('[data-testid=billing-plan]');
    assert(
      /Payment due/.test(plan) &&
        /The last payment for .+ didn’t go through\. Everything keeps working until .+; the owner and the admins can update the card\./.test(plan),
      plan,
    );
    assert(!/American Express/.test(plan), 'a member isn’t told whose card');
    await page.click('[data-testid=billing-nudge]');
    await waitText('[data-testid=billing-nudged]', /The owner and the admins have an email about it/);
    assert(fake().calls.filter((c) => c.kind === 'nudge').length === 1, JSON.stringify(fake().calls));
    await shot('member-grace');
    const problems = await layoutMatrix(page, { 'billing (member, grace)': null });
    assert(!problems.length, problems.join('\n'));
  });

  await check('no console errors', async () => {
    assert(!errors.length, errors.join('\n'));
  });
} catch (e) {
  crashed(e, srv);
}
await finish(LABEL, { browser, servers: [srv], dirs: [fakeDir] });
