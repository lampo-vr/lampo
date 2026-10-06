#!/usr/bin/env node
// covers: web/src/billing/Checkout.tsx web/src/billing/stripe.ts web/src/styles/checkout.css web/src/settings/Billing.tsx
// covers: test/e2e/lib/billingModule.ts test/e2e/lib/fakeStripe.js server/respond.ts web/src/consent/ web/src/vendor/
// covers: web/src/styles/consent.css test/e2e/lib/consent.mjs
// The checkout step (conversion SPEC §5) against the stand-in billing provider and Stripe.js (test/e2e/billing.mjs has
// the page around it): it opens at its own address (#/settings/billing/checkout?plan=…&interval=…&currency=…) with the
// title focused, keeps the exact room of Stripe's address, tax ID and card fields while they load (nothing moves when
// they arrive, desktop and phone), and sets Stripe up as the SPEC says (card only, no wallets or Link, the address
// searched with Stripe's autocomplete, the tax ID element behind its beta, our appearance and our Instrument Sans, served to Stripe's frames
// across origins). The order is the session's: the lines, VAT once the address is known, a promotion code above the
// total, what is due today while the trial carries over (Team) or that paying ends it (Business). Consumers may buy (A13
// CLOUD-2): "business" is off at first and, ticked, brings the business's name and VAT ID — Stripe's tax ID element only
// where the provider offers reverse charge (its seller has a VAT ID), else two fields of the page's own whose VAT ID goes
// with the consent, and nothing says reverse charge (unticked again, it is cleared); a consumer's
// express start and the terms line with the operator's pages sit above the button, which says "Buy now" ("Zahlungspflichtig
// bestellen"), and the consent is recorded before the order; a new receipts address is saved once paid; a declined card is said under the card; paid, a calm
// done panel with four facts, and See Billing goes back. The cookie settings ask first (A13 CLOUD-1): nothing from
// js.stripe.com or Google before a choice; "Necessary only" says so where the form would be, Allow loads it, the choice
// is kept, and Google's address suggestions only with their own service allowed. Phone to wide desktop in both themes (a sticky bar on phones),
// German, and nothing in --faint but placeholders. Without Chrome or web/dist it fails (see prereq.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { readOutbox } from '../../lib/mail/index.ts';
import { ROOT, sleep, tmpdir } from '../lib/helpers.ts';
import { client } from '../lib/http.ts';
import { layoutMatrix, settle } from './layout.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { consentCookie } from './lib/consent.mjs';
import { LEGAL, startServer } from './lib/server.mjs';

const LABEL = 'checkout e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const fakeDir = tmpdir('vr-e2e-checkout-fake-');
const FAKE = path.join(fakeDir, 'billing.json');
const STRIPE_JS = 'https://js.stripe.com/dahlia/stripe.js';
const FAKE_STRIPE = fs.readFileSync(path.join(ROOT, 'test/e2e/lib/fakeStripe.js'), 'utf8');
// ten days of trial: enough to carry into Team (the module's rule: at least 49 hours), never into Business
const srv = await startServer({
  prefix: 'vr-e2e-checkout-',
  mode: 'server',
  publicUrl: true,
  env: { ...LEGAL, VR_SIGNUP: 'open', VR_CLOUD_MODULE: path.join(ROOT, 'test/e2e/lib/billingModule.ts'), FAKE_BILLING_FILE: FAKE, FAKE_TRIAL_DAYS: '10' },
});
const { base: BASE } = srv;
const request = client(srv.port);
const origin = { Origin: BASE };
const PASSWORD = 'a long enough password';
const OUTBOX = path.join(srv.env.VR_CACHE, 'outbox');
const TEAM = '#/settings/billing/checkout?plan=team&interval=year&currency=eur';
const BUSINESS = '#/settings/billing/checkout?plan=business&interval=month&currency=eur';

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
const fake = () => JSON.parse(fs.readFileSync(FAKE, 'utf8'));
/** What the stand-in provider answers for a workspace, changed between requests (as the real module's state would be). */
const setFake = (workspace, patch) => {
  const d = fake();
  d.workspaces[workspace] = { ...d.workspaces[workspace], ...patch };
  fs.writeFileSync(FAKE, JSON.stringify(d, null, 2));
};

let browser;
let page;
try {
  const setupToken = await srv.setupToken();
  assert(setupToken, `no setup token in the server log:\n${srv.log()}`);
  const setup = await request('POST', '/api/auth/setup', {
    body: { token: setupToken, email: 'olivia@e2e.test', name: 'Olivia', password: PASSWORD },
    headers: origin,
  });
  assert(setup.status === 200, setup.text);
  // Pia signs up: the provider places her in a workspace of her own, in its trial
  const made = await request('POST', '/api/auth/signup', {
    body: { name: 'Pia Brandt', email: 'pia@e2e.test', password: PASSWORD, lang: 'en' },
    headers: origin,
  });
  assert(made.status === 200, made.text);
  const verified = await request('POST', '/api/auth/verify', {
    body: { token: await confirmToken('pia@e2e.test') },
    headers: { Cookie: cookieOf(made, 'vr_signup'), ...origin },
  });
  assert(verified.status === 200, verified.text);
  const pia = cookieOf(verified);
  const status = (await request('GET', '/api/auth/status', { headers: { Cookie: pia } })).json();
  const ws = status.workspace;
  assert(fake().workspaces[ws.id]?.state === 'trial', JSON.stringify(fake()));
  const trialEnd = new Date(fake().workspaces[ws.id].trialEndsAt).toLocaleDateString('en', { day: 'numeric', month: 'long', year: 'numeric' });

  browser = await launch();
  page = await browser.newPage();
  screenshotFailures(() => page, 'checkout');
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  /** While set, Stripe's frames wait here (each an answer to send) instead of loading. */
  let held = null;
  const leftTheApp = [];
  /** Every request to Stripe's or Google's hosts, in order: none may go before the cookie settings allow them. */
  const thirdParty = [];
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const u = r.url();
    if (/^https:\/\/([\w-]+\.)*(google|googleapis|gstatic)\.com\//.test(u)) {
      thirdParty.push(u);
      return r.respond({ status: 404, body: '' });
    }
    if (!/^https:\/\/([\w-]+\.)*stripe\.com\//.test(u)) return r.continue();
    thirdParty.push(u);
    if (u === STRIPE_JS) return r.respond({ status: 200, contentType: 'application/javascript', body: FAKE_STRIPE });
    if (u.startsWith('https://js.stripe.com/fake-frame.html')) {
      const answer = () => r.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><p>a Stripe field</p>' });
      return held ? held.push(answer) : answer();
    }
    return r.respond({ status: 404, body: '' });
  });
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame() && !f.url().startsWith(BASE)) leftTheApp.push(f.url());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));
  await page.setCookie({ name: 'vr_session', value: pia.split('=')[1], domain: new URL(BASE).hostname, path: '/', httpOnly: true });
  const host = new URL(BASE).hostname;

  const text = (sel) => page.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim());
  const waitText = (sel, re, timeout = 15000) =>
    page.waitForFunction(
      (s, src) => new RegExp(src).test(document.querySelector(s)?.textContent.replace(/\s+/g, ' ') ?? ''),
      { polling: 100, timeout },
      sel,
      re.source,
    );
  const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `checkout-${name}.png`), fullPage: true });
  const fresh = async (hash) => {
    await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
  };
  const elementsReady = (n) =>
    page.waitForFunction((k) => document.querySelectorAll('[data-testid=billing-checkout] .co-el.settled').length === k, { polling: 100, timeout: 15000 }, n);
  /** The step with its fields loaded and its pay button live. */
  const open = async (hash = TEAM, vp = { width: 1440, height: 900 }) => {
    // each check starts at its own size (a failed one may have left a phone behind)
    await page.setViewport(vp);
    await fresh(hash);
    await elementsReady(2);
    await page.waitForFunction(() => !document.querySelector('[data-testid=billing-pay]')?.disabled, { polling: 100, timeout: 15000 });
    await settle(page);
  };
  /** Where the things under Stripe's fields are: they must not move when the fields arrive. */
  const marks = () =>
    page.evaluate(() =>
      Object.fromEntries(
        ['.co-chk', '#co-card-h', '[data-testid=billing-total]', '[data-testid=billing-due]', '.co-safe', '.co-bar'].map((s) => {
          const r = document.querySelector(s)?.getBoundingClientRect();
          return [s, r?.height ? Math.round(r.top * 10) / 10 : null];
        }),
      ),
    );

  console.log(`checkout e2e against ${BASE} (store ${srv.dir})`);

  await check('the cookie settings ask first: nothing from Stripe or Google before a choice; refused, said and allowed in place; kept', async () => {
    await page.deleteCookie({ name: 'cc_cookie', domain: host });
    thirdParty.length = 0;
    await page.setViewport({ width: 1440, height: 900 });
    await fresh(TEAM);
    // the box: the website's words; both answers in the primary orange, Settings plain
    await page.waitForSelector('#cc-main .cm', { visible: true, timeout: 15000 });
    const box = await page.evaluate(() => {
      const cm = document.querySelector('#cc-main .cm');
      const buttons = [...cm.querySelectorAll('.cm__btn')];
      return {
        title: cm.querySelector('.cm__title')?.textContent,
        buttons: buttons.map((b) => b.textContent.trim()),
        look: Object.fromEntries(buttons.map((b) => [b.dataset.role, getComputedStyle(b).backgroundImage + getComputedStyle(b).backgroundColor])),
        heights: [...new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().height)))].length,
        // the brand's deep tone, as the primary button wears it
        brand: (() => {
          const probe = document.createElement('i');
          probe.style.background = 'var(--brand-deep)';
          document.body.append(probe);
          const brand = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return Object.fromEntries(buttons.map((b) => [b.dataset.role, getComputedStyle(b).backgroundColor === brand]));
        })(),
      };
    });
    assert(box.title === 'Cookies on this site', JSON.stringify(box));
    for (const b of ['Allow all', 'Necessary only', 'Settings']) assert(box.buttons.includes(b), `“${b}”: ${JSON.stringify(box)}`);
    // both answers in the primary orange, one look (an accept that stands out beside a plain refusal steers the
    // choice); Settings plain; all three one height
    assert(box.brand.all && box.brand.necessary && !box.brand.show, `both answers orange, Settings plain: ${JSON.stringify(box)}`);
    assert(box.look.all === box.look.necessary && box.heights === 1, `the two answers look the same, one height: ${JSON.stringify(box)}`);
    await shot('consent-box');
    await settle(page);
    // nothing of Stripe or Google yet: no script, no frame, no address search; the form keeps its room and waits
    assert(!thirdParty.length, `nothing before a choice: ${thirdParty.join(', ')}`);
    assert(!(await page.$('[data-testid=billing-checkout] iframe')), 'no Stripe frame');
    assert(await page.$eval('[data-testid=billing-pay]', (b) => b.disabled), 'nothing to pay with yet');
    // "Necessary only": the form says why it isn't there, in its place, with the ways on; still nothing from Stripe
    await page.evaluate(() => [...document.querySelectorAll('#cc-main .cm__btn')].find((b) => b.textContent.trim() === 'Necessary only').click());
    await page.waitForSelector('[data-testid=billing-consent]', { timeout: 10000 });
    assert(
      /^The payment form is Stripe’s: it sets Stripe’s cookies against fraud, and its address search sends what you type to Google\. It loads once you allow it in the cookie settings\./.test(
        await text('[data-testid=billing-consent]'),
      ),
      await text('[data-testid=billing-consent]'),
    );
    assert(!thirdParty.length, `refused: still nothing: ${thirdParty.join(', ')}`);
    const orange = await page.$$eval('[data-testid=billing-checkout] .btn.primary', (bs) =>
      bs.filter((b) => b.offsetParent).map((b) => [b.textContent.trim(), b.disabled]),
    );
    assert(JSON.stringify(orange) === JSON.stringify([['Buy now', true]]), `one orange, waiting: ${JSON.stringify(orange)}`);
    await shot('consent-refused');
    // kept: a reload asks nothing and loads nothing
    await fresh(TEAM);
    await page.waitForSelector('[data-testid=billing-consent]', { timeout: 15000 });
    assert(!(await page.evaluate(() => document.documentElement.classList.contains('show--consent'))), 'the box asks once');
    assert(!thirdParty.length, `remembered: ${thirdParty.join(', ')}`);
    // Allow, in place: Stripe.js and its frames load; the address is typed (Google's suggestions are their own service)
    await page.click('[data-testid=billing-consent-allow]');
    await elementsReady(2);
    assert(
      thirdParty.some((u) => u.startsWith('https://js.stripe.com/')),
      `Stripe.js after Allow: ${thirdParty.join(', ')}`,
    );
    assert(!thirdParty.some((u) => /google|gstatic/.test(u)), `nothing from Google: ${thirdParty.join(', ')}`);
    const cookie = (await page.cookies(BASE)).find((c) => c.name === 'cc_cookie');
    const kept = JSON.parse(decodeURIComponent(cookie?.value ?? '{}'));
    assert(kept.categories?.includes('payments') && kept.revision === 1, JSON.stringify(kept));
    assert(cookie && Math.abs(cookie.expires * 1000 - Date.now() - 182 * 86_400_000) < 2 * 86_400_000, `182 days: ${cookie?.expires}`);
    // with Google's suggestions too (the settings' own service), the address is searched
    await page.setCookie(consentCookie(BASE));
    await open();
    assert((await page.evaluate(() => window.__fakeStripe.options.address?.autocomplete?.mode)) === 'automatic', 'searched with Google’s suggestions allowed');
    await page.setCookie(consentCookie(BASE, { address: false }));
    await open();
    assert((await page.evaluate(() => window.__fakeStripe.options.address?.autocomplete?.mode)) === 'disabled', 'typed without them');
    await page.setCookie(consentCookie(BASE));
  });

  await check('loading: Stripe’s fields keep their exact room, and nothing moves when they arrive (desktop and phone)', async () => {
    for (const vp of [
      { width: 1440, height: 900 },
      { width: 390, height: 844, isMobile: true, hasTouch: false },
    ]) {
      await page.setViewport(vp);
      held = [];
      await fresh(TEAM);
      await page.waitForFunction(() => document.querySelectorAll('[data-testid=billing-checkout] .co-el-frame iframe').length === 2, {
        polling: 100,
        timeout: 15000,
      });
      await settle(page);
      // the room, each field with its label; the button says what it waits for and can't be pressed
      assert((await page.$$('[data-testid=billing-checkout] .co-slots')).length === 2, 'the address and the card hold their room');
      const button = await page.$eval('[data-testid=billing-pay]', (b) => ({ text: b.textContent, disabled: b.disabled }));
      assert(button.disabled && /Loading the payment form/.test(button.text), JSON.stringify(button));
      const before = await marks();
      await shot(`loading-${vp.width}`);
      const waiting = held;
      held = null;
      for (const answer of waiting) await answer();
      await elementsReady(2);
      await settle(page);
      const after = await marks();
      for (const [sel, top] of Object.entries(before))
        if (top !== null) assert(Math.abs(after[sel] - top) < 1, `${sel} moved when Stripe's fields arrived @${vp.width}: ${top} → ${after[sel]}`);
      assert(!(await page.$('[data-testid=billing-checkout] .co-slots')), 'the slots are gone');
    }
    await page.setViewport({ width: 1440, height: 900 });
  });

  await check('the step: its own address, the title focused, Stripe set up as the SPEC says, our look and our font', async () => {
    await open();
    assert((await text('.co-title')) === `Team for ${ws.name}`, await text('.co-title'));
    assert(await page.$eval('.co-title', (h) => document.activeElement === h), 'the title has the focus');
    assert(/Billing\s*\/\s*Checkout/.test(await text('.co-crumb')), await text('.co-crumb'));
    // Pia alone: Team bills two (its minimum); the trial's ten days carry over
    assert((await text('.co-head p')) === `Billed yearly for 2 members. The trial runs on until ${trialEnd}.`, await text('.co-head p'));
    const call = fake().calls.find((c) => c.kind === 'checkout');
    assert(call && call.plan === 'team' && call.interval === 'year' && call.currency === 'eur' && call.form === 'full', JSON.stringify(call));
    const opts = await page.evaluate(() => window.__fakeStripe.options);
    assert(opts.init.developerTools?.assistant?.enabled === false, JSON.stringify(opts.init));
    assert(opts.init.betas?.includes('custom_checkout_tax_id_1'), 'the tax ID element’s beta');
    // the address is searched: Stripe's autocomplete fills street, postal code and city from one pick
    assert(opts.address?.autocomplete?.mode === 'automatic', JSON.stringify(opts.address));
    const p = opts.payment;
    assert(
      p?.wallets?.applePay === 'never' && p.wallets.googlePay === 'never' && p.wallets.link === 'never' && p.fields?.billingDetails?.address === 'never',
      JSON.stringify(p),
    );
    assert(p.terms?.card === 'auto', 'Stripe’s terms line stays');
    assert(!opts.taxId, 'no tax ID element until “business” is ticked');
    // the appearance: one control scale, ink focus, the theme's own colours
    const a = opts.checkout.appearance;
    assert(
      a.theme === 'flat' && a.labels === 'above' && a.variables.fontSizeBase === '13px' && a.variables.borderRadius === '8px',
      JSON.stringify(a.variables),
    );
    assert(a.rules['.Input'].padding === '11px 12px' && a.rules['.Label'].fontSize === '12px', JSON.stringify(a.rules));
    assert(/Instrument Sans Variable/.test(a.variables.fontFamily), a.variables.fontFamily);
    // our Instrument Sans, by its built name, and the frames may read it from js.stripe.com
    const fonts = opts.checkout.fonts ?? [];
    assert(fonts.length >= 1 && fonts.every((f) => f.family === 'Instrument Sans Variable'), JSON.stringify(fonts));
    const src = /url\((.+)\)/.exec(fonts[0].src)?.[1];
    assert(src?.startsWith(`${BASE}/assets/`) && src.endsWith('.woff2'), fonts[0].src);
    const font = await fetch(src, { headers: { Origin: 'https://js.stripe.com' } });
    assert(font.ok && font.headers.get('access-control-allow-origin') === '*', `${font.status} ${font.headers.get('access-control-allow-origin')}`);
    const js = await fetch(`${BASE}/`, { headers: { Origin: 'https://js.stripe.com' } });
    assert(!js.headers.get('access-control-allow-origin'), 'only fonts are shared across origins');
    await shot('team');
  });

  await check('the order: the lines, VAT once the address is known, the code above the total, due today and the trial', async () => {
    await open();
    // the line is the first payment's, never today's €0.00 in a trial (real Stripe's line total is today's)
    await waitText('[data-testid=billing-summary]', /Team · 2 × €240(\.00)?\s*per member, billed yearly\s*€480\.00/);
    assert(/From the billing address/.test(await text('[data-testid=billing-tax]')), await text('[data-testid=billing-tax]'));
    assert((await text('[data-testid=billing-total]')) === '€480.00', await text('[data-testid=billing-total]'));
    const due = await text('[data-testid=billing-due]');
    assert(/^Due today\s*€0\.00/.test(due), due);
    assert(due.includes(`The trial runs on until ${trialEnd}; the first payment, €480.00, is taken then.`), due);
    assert((await text('[data-testid=billing-pay]')) === 'Buy now', 'a trial’s order costs money too: the first payment at its end');
    // an address in Germany: 19 % VAT, in the total and in the first payment
    const before = await page.$eval('[data-testid=billing-total]', (e) => e.getBoundingClientRect().top);
    await page.evaluate(() => window.__fakeStripe.address('DE'));
    await waitText('[data-testid=billing-tax]', /VAT 19%\s*From the billing address\s*€91\.20/);
    // the tax's row keeps its height when the tax arrives: the total doesn't move
    const after = await page.$eval('[data-testid=billing-total]', (e) => e.getBoundingClientRect().top);
    assert(Math.abs(after - before) < 1, `the total moved when the tax arrived: ${before} → ${after}`);
    await waitText('[data-testid=billing-total]', /€571\.20/);
    assert(/the first payment, €571\.20, is taken then/.test(await text('[data-testid=billing-due]')), await text('[data-testid=billing-due]'));
    // a code that doesn't work says so; one that does shows above the total, and can be taken off
    await page.click('[data-testid=billing-promo-open]');
    await page.type('.co-promo-f input', 'NOPE');
    await page.$eval('.co-promo-f', (f) => f.requestSubmit());
    await waitText('[data-testid=billing-summary]', /This code is invalid\./);
    await page.$eval('.co-promo-f input', (i) => i.select());
    await page.type('.co-promo-f input', 'WELCOME');
    await page.$eval('.co-promo-f', (f) => f.requestSubmit());
    await waitText('[data-testid=billing-promo-applied]', /WELCOME/);
    await waitText('[data-testid=billing-total]', /€514\.08/);
    const order = await page.evaluate(() => {
      const y = (s) => document.querySelector(s).getBoundingClientRect().top;
      return { code: y('[data-testid=billing-promo-applied]'), total: y('[data-testid=billing-total]'), tax: y('[data-testid=billing-tax]') };
    });
    assert(order.tax < order.code && order.code < order.total, `the code sits above the total it changes: ${JSON.stringify(order)}`);
    await shot('order');
    await page.click('[data-testid=billing-promo-remove]');
    await waitText('[data-testid=billing-total]', /€571\.20/);
    assert(!(await page.$('[data-testid=billing-promo-applied]')), 'the code is off');
  });

  await check('consumers may buy: the business box is off; the express start and the terms line sit right above “Buy now”', async () => {
    await open();
    const look = await page.evaluate(() => {
      const y = (s) => document.querySelector(s)?.getBoundingClientRect().top ?? null;
      return {
        business: document.querySelector('.co-biz input')?.checked,
        businessNote: document.querySelector('.co-biz small')?.textContent,
        taxId: !!document.querySelector('[data-testid=billing-taxid-element]'),
        start: document.querySelector('[data-testid=billing-start]')?.textContent.trim(),
        terms: [...document.querySelectorAll('[data-testid=billing-terms] a')].map((a) => [a.textContent, a.getAttribute('href'), a.rel, a.target]),
        line: document.querySelector('[data-testid=billing-terms]')?.textContent,
        order: [y('[data-testid=billing-start]'), y('[data-testid=billing-terms]'), y('[data-testid=billing-pay]')],
        button: document.querySelector('[data-testid=billing-pay]')?.textContent,
      };
    });
    assert(look.business === false && !look.taxId, `a person by default: ${JSON.stringify(look)}`);
    // no reverse charge here (the provider's seller has no VAT ID): the box says what a VAT ID is for, and nothing more
    assert(look.businessNote === 'Optional: its name and VAT ID on the invoice.', look.businessNote);
    assert(
      /^I expressly ask for Team to start now, before the 14-day withdrawal period ends\. If I withdraw, I pay for the time until then/.test(look.start ?? ''),
      look.start,
    );
    assert(
      JSON.stringify(look.terms) ===
        JSON.stringify([
          ['Terms', LEGAL.VR_TERMS_URL, 'noreferrer', '_blank'],
          ['Privacy policy', LEGAL.VR_PRIVACY_URL, 'noreferrer', '_blank'],
          ['withdrawal information', LEGAL.VR_WITHDRAWAL_URL, 'noreferrer', '_blank'],
        ]),
      JSON.stringify(look.terms),
    );
    assert(look.line === 'By ordering you accept the Terms and have read the Privacy policy and the withdrawal information.', look.line);
    assert(look.order[0] < look.order[1] && look.order[1] < look.order[2], `the box, the terms line, the button: ${look.order}`);
    assert(look.button === 'Buy now', look.button);
    // pressed without the box: said at the box (the focus there), nothing recorded, nothing ordered
    await page.click('[data-testid=billing-pay]');
    await waitText('[data-testid=billing-start-miss]', /^Tick the box to start Team now, or buy as a business\.$/);
    assert(await page.$eval('[data-testid=billing-start] input', (i) => document.activeElement === i), 'the focus is on the box');
    assert(!fake().calls.some((c) => c.kind === 'consent' || c.kind === 'confirm-checkout'), JSON.stringify(fake().calls));
    assert(!(await page.evaluate(() => window.__fakeStripe.calls)).some((c) => c[0] === 'confirm'), 'Stripe was not asked');
    await shot('consumer');
    // a business: no right of withdrawal, so no box, and the terms line without the withdrawal information
    await page.click('.co-biz input');
    await page.waitForSelector('[data-testid=billing-business-fields]');
    assert(!(await page.$('[data-testid=billing-start]')), 'no express start for a business');
    assert(
      (await text('[data-testid=billing-terms]')) === 'By ordering you accept the Terms and have read the Privacy policy.',
      await text('[data-testid=billing-terms]'),
    );
    await page.click('.co-biz input');
    await page.waitForSelector('[data-testid=billing-start]');
  });

  await check('without the seller’s VAT ID: the business’s name and VAT ID in our own fields, the VAT ID with the order, never “reverse charge”', async () => {
    await open();
    await page.evaluate(() => {
      window.__fakeStripe.calls.length = 0;
    });
    await page.click('.co-biz input');
    await page.waitForSelector('[data-testid=billing-business-fields]');
    const calls = await page.evaluate(() => window.__fakeStripe.calls);
    assert(!calls.some((c) => c[0] === 'createTaxIdElement'), `no Stripe tax ID element: ${JSON.stringify(calls)}`);
    assert(!(await page.$('[data-testid=billing-taxid-element]')), 'no tax ID element');
    // the fields: labelled, side by side on a desktop, nothing faint but the placeholder
    const fields = await page.$$eval('[data-testid=billing-business-fields] .co-f', (fs) =>
      fs.map((f) => ({ label: f.querySelector('.co-l')?.textContent, top: Math.round(f.getBoundingClientRect().top) })),
    );
    assert(
      JSON.stringify(fields.map((f) => f.label)) === JSON.stringify(['Business name', 'VAT ID (optional)']) && fields[0].top === fields[1].top,
      JSON.stringify(fields),
    );
    // an Austrian business: German VAT like everyone's, said as VAT, never as reverse charge
    await page.evaluate(() => window.__fakeStripe.address('AT'));
    await page.type('[data-testid=billing-business-name]', 'Studio Nord GmbH');
    await page.type('[data-testid=billing-business-vat]', 'AT12');
    // a VAT ID that can't be one: said at its field when pressed, nothing recorded, nothing ordered
    await page.click('[data-testid=billing-pay]');
    await waitText('[data-testid=billing-business-vat-error]', /^An EU VAT ID starts with its country’s letters \(AT\), then 8 to 12 digits or letters\.$/);
    assert(await page.$eval('[data-testid=billing-business-vat]', (i) => document.activeElement === i), 'the focus is on the VAT ID');
    assert(!fake().calls.some((c) => c.kind === 'consent'), JSON.stringify(fake().calls));
    await shot('business-fields-error');
    await page.$eval('[data-testid=billing-business-vat]', (i) => i.select());
    await page.type('[data-testid=billing-business-vat]', 'atu 1234 5678');
    // Stripe declines the card: the name went to Stripe and the VAT ID with the consent before it was asked
    await page.evaluate(() => {
      window.__fakeStripe.decline = true;
    });
    await page.click('[data-testid=billing-pay]');
    await page.waitForSelector('[data-testid=billing-pay-error]');
    const consent = fake().calls.findLast((c) => c.kind === 'consent');
    assert(consent?.buyer === 'business' && consent.start === false && consent.vatId === 'ATU12345678', JSON.stringify(consent));
    const named = (await page.evaluate(() => window.__fakeStripe.calls)).filter((c) => c[0] === 'updateBusinessName');
    assert(
      named.some((c) => c[1] === 'Studio Nord GmbH'),
      JSON.stringify(named),
    );
    const words = await text('[data-testid=billing-checkout]');
    assert(!/reverse/i.test(words), `nothing says reverse charge: ${words}`);
    await shot('business-fields');
    const problems = await layoutMatrix(
      page,
      { 'the business’s own fields': null },
      { widths: [390, 1440], each: (w, theme) => shot(`business-fields-${w}-${theme}`) },
    );
    assert(!problems.length, problems.join('\n'));
    // unticked: the fields go, and what they held with them
    await page.click('.co-biz input');
    await page.waitForFunction(() => !document.querySelector('[data-testid=billing-business-fields]'), { polling: 100, timeout: 5000 });
    await page.click('.co-biz input');
    await page.waitForSelector('[data-testid=billing-business-fields]');
    assert((await page.$eval('[data-testid=billing-business-vat]', (i) => i.value)) === '', 'the VAT ID is gone');
  });

  await check(
    'with the seller’s VAT ID: the tax ID element while ticked; unticked, what it held is cleared; a VAT ID abroad reads reverse charge',
    async () => {
      setFake(ws.id, { reverseCharge: true });
      try {
        await open();
        assert(
          (await text('.co-biz small')) === 'Optional: its name and VAT ID on the invoice. A VAT ID is needed only for reverse charge.',
          await text('.co-biz small'),
        );
        assert(!(await page.$('[data-testid=billing-taxid-element]')), 'off from the start: no tax ID element');
        await page.click('.co-biz input');
        await page.waitForSelector('[data-testid=billing-taxid-element][data-mounted=taxid]');
        await elementsReady(3);
        await page.click('.co-biz input');
        await page.waitForFunction(() => !document.querySelector('[data-testid=billing-taxid-element]'), { polling: 100, timeout: 5000 });
        await page.waitForFunction(() => window.__fakeStripe.calls.some((c) => c[0] === 'updateBusinessName'), { polling: 100, timeout: 5000 });
        const calls = await page.evaluate(() => window.__fakeStripe.calls);
        assert(
          calls.some((c) => c[0] === 'updateTaxIdInfo' && c[1] === null),
          JSON.stringify(calls),
        );
        await page.click('.co-biz input');
        await page.waitForSelector('[data-testid=billing-taxid-element][data-mounted=taxid]');
        await elementsReady(3);
        await page.evaluate(() => {
          window.__fakeStripe.address('AT');
          window.__fakeStripe.taxId('ATU12345678');
        });
        await waitText('[data-testid=billing-tax]', /Reverse charge/);
        assert(!(await page.$('[data-testid=billing-business-fields]')), 'Stripe’s element, not our fields');
      } finally {
        setFake(ws.id, { reverseCharge: undefined });
      }
    },
  );

  await check('Business in the trial: billed from today, said in the head and above Pay', async () => {
    await open(BUSINESS);
    assert((await text('.co-title')) === `Business for ${ws.name}`, await text('.co-title'));
    assert((await text('.co-head p')) === 'Billed monthly for 1 member. The trial ends when you pay.', await text('.co-head p'));
    assert(
      (await text('[data-testid=billing-trial-ends]')) === 'The trial ends when you pay: Business is billed from today.',
      await text('[data-testid=billing-trial-ends]'),
    );
    assert(!(await page.$('[data-testid=billing-due]')), 'nothing carries over: no "due today" box');
    assert((await text('[data-testid=billing-pay]')) === 'Buy now', await text('[data-testid=billing-pay]'));
  });

  await check('every width, both themes; phones keep what is due and the one action in a bar at the bottom', async () => {
    await open();
    const problems = await layoutMatrix(page, { checkout: null }, { widths: [390, 1024, 1440, 1920, 2560] });
    assert(!problems.length, problems.join('\n'));
    // a phone (puppeteer reloads the page for isMobile): the step again, loaded
    await open(TEAM, { width: 390, height: 844, isMobile: true });
    const bar = await page.evaluate(() => {
      const b = document.querySelector('.co-bar');
      const r = b.getBoundingClientRect();
      const own = document.querySelector('[data-testid=billing-pay]');
      return {
        shown: getComputedStyle(b).display !== 'none',
        bottom: Math.round(r.bottom),
        text: b.textContent,
        ownShown: !!own.offsetParent,
        vh: innerHeight,
      };
    });
    assert(bar.shown && !bar.ownShown, JSON.stringify(bar));
    assert(bar.bottom <= bar.vh && bar.bottom >= bar.vh - 2, `the bar sits at the bottom: ${JSON.stringify(bar)}`);
    assert(/Due today €0\.00/.test(bar.text) && /then €480\.00 on/.test(bar.text) && /Buy now/.test(bar.text), bar.text);
    const h = await page.$eval('[data-testid=billing-pay-bar]', (b) => b.getBoundingClientRect().height);
    assert(h >= 44, `the bar's button is touch height: ${h}`);
    // the bar's button is far from the box: pressed without it, the box comes into view, said
    await page.click('[data-testid=billing-pay-bar]');
    await waitText('[data-testid=billing-start-miss]', /Tick the box/);
    await page.waitForFunction(
      () => {
        const r = document.querySelector('[data-testid=billing-start]').getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight - document.querySelector('.co-bar').offsetHeight;
      },
      { polling: 100, timeout: 5000 },
    );
    await shot('phone');
    await page.setViewport({ width: 1440, height: 900 });
  });

  await check('information is never --faint (placeholders only), in both themes', async () => {
    await open();
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await settle(page);
      const faint = await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--faint)';
        document.body.append(probe);
        const f = getComputedStyle(probe).color;
        probe.remove();
        const out = [];
        for (const el of document.querySelectorAll('[data-testid=billing-checkout] *')) {
          const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
          if (own && getComputedStyle(el).color === f) out.push(`${el.className || el.tagName}: ${el.textContent.trim().slice(0, 40)}`);
        }
        return out;
      });
      assert(!faint.length, `${theme}: ${faint.join(' | ')}`);
    }
    await page.evaluate(() => delete document.documentElement.dataset.theme);
  });

  await check('German: the step in German (du), Stripe in German', async () => {
    await page.evaluate(() => localStorage.setItem('vr.lang', 'de'));
    await open();
    assert((await text('.co-title')) === `Team für ${ws.name}`, await text('.co-title'));
    assert(/Rechnungsadresse/.test(await text('[data-testid=billing-checkout]')), 'Rechnungsadresse');
    assert(/Heute fällig/.test(await text('[data-testid=billing-due]')), await text('[data-testid=billing-due]'));
    assert(/Kündigst du vorher/.test(await text('[data-testid=billing-due]')), 'du, not Sie');
    assert((await text('[data-testid=billing-pay]')) === 'Zahlungspflichtig bestellen', await text('[data-testid=billing-pay]'));
    assert(
      /^Ich verlange ausdrücklich, dass Team jetzt beginnt, vor Ablauf der 14-tägigen Widerrufsfrist\./.test(await text('[data-testid=billing-start]')),
      await text('[data-testid=billing-start]'),
    );
    assert(
      (await text('[data-testid=billing-terms]')) ===
        'Mit deiner Bestellung akzeptierst du die AGB und hast die Datenschutzerklärung und die Widerrufsbelehrung gelesen.',
      await text('[data-testid=billing-terms]'),
    );
    const calls = await page.evaluate(() => window.__fakeStripe.calls);
    assert(
      calls.some((c) => c[0] === 'Stripe' && c[2] === 'de'),
      'Stripe’s own words in German',
    );
    const problems = await layoutMatrix(page, { 'checkout (German)': null }, { widths: [390, 1440], themes: ['light'] });
    assert(!problems.length, problems.join('\n'));
    await shot('team-de');
    await page.evaluate(() => localStorage.removeItem('vr.lang'));
  });

  await check('paying: a declined card is said under the card; paid, the done panel, a new receipts address saved, back to Billing', async () => {
    await open();
    await page.evaluate(() => window.__fakeStripe.address('DE'));
    await waitText('[data-testid=billing-total]', /€571\.20/);
    // a new address for receipts, saved with the billing details once the payment is through
    await page.evaluate(() => [...document.querySelectorAll('[data-testid=billing-receipts] button')].find((b) => b.textContent === 'Change').click());
    await page.waitForSelector('.co-mail-f input');
    await page.$eval('.co-mail-f input', (i) => i.select());
    await page.type('.co-mail-f input', 'invoices@e2e.test');
    await page.$eval('.co-mail-f', (f) => f.requestSubmit());
    await waitText('[data-testid=billing-receipts]', /invoices@e2e\.test.*saved when you pay/);
    // a consumer asks for the start (the box above the button)
    await page.click('[data-testid=billing-start] input');
    // declined: Stripe's sentence in the error colour right under the card, and nothing paid
    await page.evaluate(() => {
      window.__fakeStripe.decline = true;
    });
    await page.click('[data-testid=billing-pay]');
    // in our words (SPEC §7c), never Stripe's: what happened, that nothing was charged, the way out
    await waitText(
      '[data-testid=billing-pay-error]',
      /^Your bank declined this card\. Nothing was charged\. Try another card, or ask the bank to allow the payment\.$/,
    );
    const where = await page.evaluate(() => {
      const err = document.querySelector('[data-testid=billing-pay-error]');
      const card = document.querySelector('[data-testid=billing-payment-element]');
      return { cls: err.className, gap: err.getBoundingClientRect().top - card.getBoundingClientRect().bottom };
    });
    assert(where.cls.includes('bill-error') && where.gap >= 0 && where.gap <= 16, JSON.stringify(where));
    assert(!fake().calls.some((c) => c.kind === 'confirm-checkout'), 'nothing was paid');
    await page.click('[data-testid=billing-pay]');
    await page.waitForSelector('[data-testid=billing-checkout-done]', { timeout: 15000 });
    assert(
      (await page.evaluate(() => window.__fakeStripe.calls)).some((c) => c[0] === 'confirm' && c[1] === 'if_required'),
      'cards confirm in place',
    );
    // what was agreed went to the provider right before the order: a consumer, the express start (an earlier check's
    // declined business order recorded its own)
    const kinds = fake().calls.map((c) => c.kind);
    const paidAt = kinds.indexOf('confirm-checkout');
    const consent = fake()
      .calls.slice(0, paidAt)
      .findLast((c) => c.kind === 'consent');
    assert(consent?.buyer === 'consumer' && consent.start === true && !consent.vatId, JSON.stringify(consent));
    assert(paidAt > 0 && kinds.lastIndexOf('consent', paidAt) === paidAt - 1, kinds.join(' '));
    assert((await text('#co-paid-h')) === `${ws.name} is on Team`, await text('#co-paid-h'));
    // the trial's ruler, swept full: every day after today fills, the end is the solid keyframe
    const ruler = await page.$eval('.co-paid-ruler .bill-ruler.sweep', (r) => ({
      cells: r.querySelectorAll('.bill-ruler-cells i').length,
      end: !!r.querySelector('.bill-ruler-end'),
    }));
    assert(ruler.cells === 10 && ruler.end, JSON.stringify(ruler));
    assert(await page.$eval('#co-paid-h', (h) => document.activeElement === h), 'the focus moves to what happened');
    await waitText('.co-facts', /Card\s*Visa •••• 4242/);
    const facts = await text('.co-facts');
    assert(/Plan\s*Team · yearly/.test(facts), facts);
    assert(facts.includes(`€571.20 · ${trialEnd}`) && /First payment\s*€571\.20/.test(facts), facts);
    assert(/Invoices to\s*invoices@e2e\.test/.test(facts), facts);
    const saved = fake().calls.find((c) => c.kind === 'details');
    assert(saved?.email === 'invoices@e2e.test' && saved.address?.city === 'Hamburg' && saved.address?.postalCode === '20457', JSON.stringify(saved));
    await shot('done');
    const problems = await layoutMatrix(page, { 'checkout (done)': null }, { widths: [390, 1440], themes: ['light', 'dark'] });
    assert(!problems.length, problems.join('\n'));
    await page.click('[data-testid=billing-see-billing]');
    await page.waitForFunction(() => location.hash === '#/settings/billing', { polling: 100, timeout: 5000 });
    await waitText('[data-testid=billing-plan]', /Active/);
    assert(!leftTheApp.length, `the page never left the app: ${leftTheApp.join(', ')}`);
  });

  await check('no console errors', async () => {
    assert(!errors.length, errors.join('\n'));
  });
} catch (e) {
  crashed(e, srv);
}
await finish(LABEL, { browser, servers: [srv], dirs: [fakeDir] });
