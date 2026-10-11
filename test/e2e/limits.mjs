#!/usr/bin/env node
// covers: web/src/conversion/ web/src/lib/toast.ts web/src/ui/layers.tsx web/src/uploads/ web/src/settings/Users.tsx
// covers: web/src/library/Insights.tsx web/src/styles/limits.css web/src/styles/pay.css server/extension.ts server/routes/uploads.ts
// covers: test/e2e/lib/billingModule.ts
// A limit reached is a sheet, not a toast (the build spec's moments 2c and 3), against the stand-in billing provider
// (test/e2e/lib/billingModule.ts) and the stand-in Stripe.js: an upload a Free plan has no room for opens the sheet with
// what fits (Solo) and waits in the tray; paying on the sheet lets it go on by itself. A second person on Free: the
// invite's refusal opens Team's sheet, and the invite goes out once it's paid. On Solo with a card on file the invite
// form itself says what brings them in, and its button switches the plan, then invites. On a paid Team, one more
// terabyte is the answer, paid with the card on file. A paid trial on a full Team: the invite and the sheet say the trial
// ends today and Business is billed now, with the amount, and say nothing while the provider's preview is on its way; a
// declined payment changes nothing and says so; out of room while trialing, Business fits (no terabyte is sold until the
// trial ends), and a terabyte paid after the trial began is refused in the module's words.
// Insights on Free explains itself, and See Team opens the
// feature's sheet, billed for two. Whoever doesn't choose the plan reads the sentence as a toast. Every sheet fits from a
// phone to 2560 px, light and dark, with 44 px targets on a phone, and nothing moves while Stripe's fields load.
import fs from 'node:fs';
import path from 'node:path';
import { readOutbox } from '../../lib/mail/index.ts';
import { makeVideo, ROOT, sleep, tmpdir } from '../lib/helpers.ts';
import { client } from '../lib/http.ts';
import { dataTheme, layoutMatrix, settle } from './layout.mjs';
import { launch, requireChrome } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { consentCookie } from './lib/consent.mjs';
import { LEGAL, startServer } from './lib/server.mjs';

const LABEL = 'limits e2e';
requireChrome(LABEL);
// pictures of every sheet at every width, both themes, when asked for (QA)
const SHOTS = process.env.LIMITS_SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const WIDTHS = [390, 768, 1024, 1440, 1920, 2560];
const fakeDir = tmpdir('vr-e2e-limits-fake-');
const FAKE = path.join(fakeDir, 'billing.json');
const STRIPE_JS = 'https://js.stripe.com/dahlia/stripe.js';
const FAKE_STRIPE = fs.readFileSync(path.join(ROOT, 'test/e2e/lib/fakeStripe.js'), 'utf8');
const srv = await startServer({
  prefix: 'vr-e2e-limits-',
  mode: 'server',
  publicUrl: true,
  env: { ...LEGAL, VR_SIGNUP: 'open', VR_CLOUD_MODULE: path.join(ROOT, 'test/e2e/lib/billingModule.ts'), FAKE_BILLING_FILE: FAKE },
});
const { base: BASE } = srv;
const request = client(srv.port);
const origin = { Origin: BASE };
const PASSWORD = 'a long enough password';
const OUTBOX = path.join(srv.env.VR_CACHE, 'outbox');
const DAY = 86_400_000;

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
/** The workspace's whole state at the stand-in (what isn't named is gone: no trial left over from the sign-up). */
const setFake = (workspace, state) => {
  const d = fake();
  d.workspaces[workspace] = state;
  fs.writeFileSync(FAKE, JSON.stringify(d, null, 2));
};
const patchFake = (workspace, patch) => {
  const d = fake();
  d.workspaces[workspace] = { ...d.workspaces[workspace], ...patch };
  fs.writeFileSync(FAKE, JSON.stringify(d, null, 2));
};
const FREE = { plan: 'free', planName: 'Free', state: 'free' };
async function signUp(name, email) {
  const made = await request('POST', '/api/auth/signup', { body: { name, email, password: PASSWORD, lang: 'en' }, headers: origin });
  assert(made.status === 200, made.text);
  const verified = await request('POST', '/api/auth/verify', {
    body: { token: await confirmToken(email) },
    headers: { Cookie: cookieOf(made, 'vr_signup'), ...origin },
  });
  assert(verified.status === 200, verified.text);
  const cookie = cookieOf(verified);
  const status = (await request('GET', '/api/auth/status', { headers: { Cookie: cookie } })).json();
  return { cookie, ws: status.workspace.id };
}

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
  // Ana works alone in "Costa Cuts"; Pia's workspace has Max, a member who doesn't choose the plan
  const ana = await signUp('Ana Costa', 'ana@e2e.test');
  const named = await request('PATCH', '/api/workspaces/current', { body: { name: 'Costa Cuts' }, headers: { Cookie: ana.cookie, ...origin } });
  assert(named.status === 200, named.text);
  const pia = await signUp('Pia Brandt', 'pia@e2e.test');
  const inv = await request('POST', '/api/admin/invites', { body: { role: 'member' }, headers: { Cookie: pia.cookie, ...origin } });
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
  const clip = makeVideo(path.join(fakeDir, 'fjord-hotel-rooms-v3.mp4'), { dur: 0.5 });

  browser = await launch();
  page = await browser.newPage();
  screenshotFailures(() => page, 'limits');
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  /** While set, Stripe's frames wait here (each an answer to send) instead of loading. */
  let held = null;
  /** While set, the provider's switch previews wait here (each a request to let go) instead of being answered. */
  let heldPreviews = null;
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const u = r.url();
    if (heldPreviews && u.endsWith('/api/billing/plan/preview')) return heldPreviews.push(() => r.continue());
    if (!/^https:\/\/([\w-]+\.)*stripe\.com\//.test(u)) return r.continue();
    if (u === STRIPE_JS) return r.respond({ status: 200, contentType: 'application/javascript', body: FAKE_STRIPE });
    if (u.startsWith('https://js.stripe.com/fake-frame.html')) {
      const answer = () => r.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><p>a card field</p>' });
      return held ? held.push(answer) : answer();
    }
    return r.respond({ status: 404, body: '' });
  });
  page.on('pageerror', (e) => errors.push(e.message));
  const host = new URL(BASE).hostname;
  const signIn = async (cookie) => {
    await page.deleteCookie(...(await page.cookies(BASE)));
    await page.setCookie({ name: 'vr_session', value: cookie.split('=')[1], domain: host, path: '/', httpOnly: true });
    // the payment form allowed in the cookie settings, as someone who chose before (checkout.mjs asks itself)
    await page.setCookie(consentCookie(BASE));
  };
  const text = (sel) => page.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim());
  const waitText = (sel, re, timeout = 15000) =>
    page.waitForFunction((s, src) => new RegExp(src).test(document.querySelector(s)?.textContent ?? ''), { polling: 100, timeout }, sel, re.source);
  const fresh = async (hash) => {
    await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
  };
  const errorToasts = () => page.$$eval('[data-testid=toast].error', (ts) => ts.map((t) => t.textContent));
  const upload = async (file) => {
    await page.waitForSelector('input[data-testid=upload-input]');
    await (await page.$('input[data-testid=upload-input]')).uploadFile(file);
    await page.waitForSelector('.up-files', { timeout: 15000 });
    await page.evaluate(() => [...document.querySelectorAll('.modal-foot .btn.primary')].at(-1).click());
  };
  const sheet = (reason) => page.waitForSelector(`[data-testid=limit-sheet][data-reason=${reason}]`, { timeout: 15000 });
  const sheetGone = () => page.waitForFunction(() => !document.querySelector('[data-testid=limit-sheet]'), { polling: 100, timeout: 10000 });
  /** Pays on the sheet's checkout (the stand-in Stripe's fields, the express start a consumer asks for, then Buy now). */
  const payCheckout = async () => {
    await page.waitForSelector('[data-testid=limit-sheet] [data-testid=billing-pay]:enabled', { timeout: 15000 });
    // the checkout's own button and terms line in a sheet too (A13 CLOUD-2): never the moment's "Pay … and upload"
    assert(
      (await text('[data-testid=limit-sheet] [data-testid=billing-pay]')) === 'Buy now',
      await text('[data-testid=limit-sheet] [data-testid=billing-pay]'),
    );
    assert(/^By ordering you accept the Terms/.test(await text('[data-testid=limit-sheet] [data-testid=billing-terms]')), 'the terms line above it');
    await page.click('[data-testid=limit-sheet] [data-testid=billing-start] input');
    await page.click('[data-testid=limit-sheet] [data-testid=billing-pay]');
  };
  /** Opens a sheet as a refusal would (the toaster's event), with real-shaped numbers for the pictures. */
  const ask = async (limit) => {
    await page.waitForSelector('.toasts', { timeout: 15000 });
    await page.evaluate(
      (l) => window.dispatchEvent(new CustomEvent('vr-toast', { detail: { id: Math.random(), message: '', kind: 'error', limit: l } })),
      limit,
    );
  };
  const shots = async (name, open, { sel = '[data-testid=limit-sheet]' } = {}) => {
    const problems = await layoutMatrix(
      page,
      { [name]: open },
      {
        show: dataTheme,
        widths: WIDTHS,
        each: async (width, theme) => {
          if (sel) await page.waitForSelector(sel, { timeout: 10000 });
          if (width === 390 && sel === '[data-testid=limit-sheet]') {
            // a phone: a finger reaches every button of the sheet (44 px)
            // (a link inside a sentence counts its tap area; the checkout step's own controls are its suite's, checkout.mjs)
            const small = await page.$$eval('[data-testid=limit-sheet] button:not([disabled]), [data-testid=limit-sheet] a.btn', (els) =>
              els
                .filter((e) => e.offsetParent && !e.closest('.co'))
                .map((e) => [
                  e.textContent.trim() || e.getAttribute('aria-label'),
                  Math.round(Math.max(e.getBoundingClientRect().height, Number.parseFloat(getComputedStyle(e, '::after').height) || 0)),
                ])
                .filter(([, h]) => h < 44),
            );
            assert(!small.length, `${name}: targets under 44 px on a phone: ${JSON.stringify(small)}`);
          }
          if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}-${theme}-${width}.png`) });
        },
      },
    );
    assert(!problems.length, problems.join('\n'));
  };

  console.log(`limits e2e against ${BASE} (store ${srv.dir})`);

  await check('402 → sheet: an upload Free has no room for opens what fits (Solo), and waits in the tray', async () => {
    setFake(ana.ws, { ...FREE, limits: { members: 1, bytes: 1000, activeVideos: 3 } });
    await signIn(ana.cookie);
    await fresh('#/');
    await upload(clip);
    await sheet('storage');
    assert((await page.$eval('[data-testid=limit-sheet]', (e) => e.dataset.fit)) === 'solo', 'Solo is the smallest step');
    const head = await text('[data-testid=limit-sheet] .lim-head');
    assert(/fjord-hotel-rooms-v3\.mp4 needs more room/.test(head), head);
    assert(/Costa Cuts has .* of Free’s .* left\. The upload waits; reviewing and everything else go on\./.test(head), head);
    assert(!(await errorToasts()).length, `a sheet, not a toast: ${await errorToasts()}`);
    // the upload waits in the tray, calmly (it didn't fail)
    await waitText('[data-testid=upload-room]', /Waiting for room/);
    assert(!(await page.$('.up-row.failed')), 'nothing failed');
    // Not now: the sheet goes, the upload keeps waiting, and the tray brings the sheet back
    await page.click('[data-testid=limit-later]');
    await sheetGone();
    await waitText('[data-testid=upload-room]', /Waiting for room/);
    await page.click('[data-testid=upload-room-plans]');
    await sheet('storage');
  });

  await check('paying on the sheet: Solo, and the upload goes on by itself', async () => {
    await payCheckout();
    await page.waitForSelector('[data-testid=limit-done]', { timeout: 20000 });
    const done = await text('[data-testid=limit-done]');
    assert(/Costa Cuts is on Solo/.test(done), done);
    assert(/fjord-hotel-rooms-v3\.mp4 is uploading\./.test(done), done);
    const call = fake().calls.find((c) => c.kind === 'checkout');
    assert(call?.plan === 'solo' && call.interval === 'year', JSON.stringify(call));
    await page.waitForFunction(() => [...document.querySelectorAll('.up-row.done')].some((r) => r.textContent.includes('fjord-hotel-rooms-v3.mp4')), {
      polling: 200,
      timeout: 30000,
    });
    await page.click('[data-testid=limit-done-close]');
    await sheetGone();
  });

  await check('an invite beyond Solo, with a card on file: the form says what brings them in, then switches and invites', async () => {
    // Solo, paid with the Visa the checkout left
    assert(fake().workspaces[ana.ws].plan === 'solo', JSON.stringify(fake().workspaces[ana.ws]));
    patchFake(ana.ws, { interval: 'month', currency: 'eur', renewsAt: new Date(Date.now() + 16 * DAY).toISOString() });
    await fresh('#/settings/users');
    await page.waitForSelector('form.set-form');
    assert(!(await page.$('[data-testid=invite-beyond]')), 'nothing before an address is typed');
    await page.type('form.set-form input[type=email]', 'ben.kruse@example.com');
    await page.waitForSelector('[data-testid=invite-beyond]', { timeout: 10000 });
    // the card and the prorated amount are two answers (the account, the provider's preview), in either order: wait for
    // the sentence that has both, not for the card alone
    await waitText('[data-testid=invite-beyond]', /€[\d.,]+ excl\. VAT, is on the invoice of .+, paid with Visa •••• 4242/);
    const line = await text('[data-testid=invite-beyond]');
    assert(/^Solo is for one person\./.test(line), line);
    assert(/Team brings Ben in: €48 a month for the 2 of you, excl\. VAT\./.test(line), line);
    assert(/Today\s*Nothing\. The difference for the rest of this period, €[\d.,]+ excl\. VAT, is on the invoice of/.test(line), line);
    assert((await text('[data-testid=invite-submit]')) === 'Switch to Team and invite Ben', await text('[data-testid=invite-submit]'));
    assert(await page.$eval('[data-testid=invite-submit]', (b) => b.classList.contains('primary')), 'the form’s purpose: the orange one');
    await shots('2c', null, { sel: '[data-testid=invite-beyond]' });
    await page.click('[data-testid=invite-submit]');
    await page.waitForFunction(
      () => [...document.querySelectorAll('[data-testid=toast]')].some((t) => t.textContent.includes('Costa Cuts is on Team. Ben’s invite is on its way.')),
      { polling: 100, timeout: 20000 },
    );
    assert(
      fake().calls.some((c) => c.kind === 'plan' && c.plan === 'team' && c.interval === 'month'),
      JSON.stringify(fake().calls),
    );
    const invites = (await request('GET', '/api/admin/invites', { headers: { Cookie: ana.cookie } })).json().invites;
    assert(
      invites.some((i) => i.email === 'ben.kruse@example.com' && i.status === 'pending'),
      JSON.stringify(invites.map((i) => i.email)),
    );
  });

  await check('a second person on Free: the invite’s refusal opens Team’s sheet, and the invite goes out once paid', async () => {
    setFake(ana.ws, { ...FREE, limits: { members: 1, bytes: 10e9, activeVideos: 3 } });
    await fresh('#/settings/users');
    await page.waitForSelector('form.set-form');
    await page.type('form.set-form input[type=email]', 'lea.berg@example.com');
    await page.$eval('form.set-form', (f) => f.requestSubmit());
    await sheet('members');
    assert((await page.$eval('[data-testid=limit-sheet]', (e) => e.dataset.fit)) === 'team', 'Team brings Lea in');
    const head = await text('[data-testid=limit-sheet] .lim-head');
    assert(/Bring Lea into Costa Cuts/.test(head), head);
    assert(/Free is for one person\. Team has room for 2 to 50: Lea gets an account of their own\./.test(head), head);
    // Team bills at least two
    assert(/€40\s*a month for 2/.test(await text('[data-testid=limit-sheet] .lim-price')), await text('[data-testid=limit-sheet] .lim-price'));
    assert(!(await errorToasts()).length, `a sheet, not a toast: ${await errorToasts()}`);
    await payCheckout();
    await page.waitForSelector('[data-testid=limit-done]', { timeout: 20000 });
    assert(/Costa Cuts is on Team/.test(await text('[data-testid=limit-done]')), await text('[data-testid=limit-done]'));
    // the invite went out once Team showed (asked from the page, signed in as Ana)
    await page.waitForFunction(
      async () => {
        const r = await fetch('/api/admin/invites');
        const j = await r.json();
        return j.invites.some((i) => i.email === 'lea.berg@example.com');
      },
      { polling: 300, timeout: 20000 },
    );
    await page.click('[data-testid=limit-done-close]');
  });

  await check('a paid Team out of room: one more terabyte, paid with the card on file, and the upload goes on', async () => {
    // a terabyte bought before, and full again: the second one is asked for as the total, 2 (the module's `tb`)
    patchFake(ana.ws, {
      plan: 'team',
      planName: 'Team',
      state: 'paid',
      customer: true,
      interval: 'year',
      limits: { members: 50, bytes: 1000, activeVideos: null },
      addons: { storageTB: 1 },
      usage: { members: 2, bytes: 1e12 + 900, activeVideos: 1 },
    });
    await fresh('#/');
    const other = makeVideo(path.join(fakeDir, 'pinewood-brand-film-90s_V7.mp4'), { dur: 0.5, pattern: 'smptebars' });
    await upload(other);
    await sheet('storage');
    assert((await page.$eval('[data-testid=limit-sheet]', (e) => e.dataset.fit)) === 'addon', 'one more terabyte, not a bigger plan');
    await waitText('[data-testid=limit-sheet] [data-testid=pay-saved-card]', /Visa •••• 4242/);
    const pay = await text('[data-testid=limit-sheet] .lim-pay');
    assert(/Today\s*€0\.00/.test(pay), pay);
    assert((await text('[data-testid=pay-go]')) === 'Add 1 TB and upload', await text('[data-testid=pay-go]'));
    await page.click('[data-testid=pay-go]');
    await page.waitForSelector('[data-testid=limit-done]', { timeout: 20000 });
    assert(
      fake().calls.some((c) => c.kind === 'storage' && c.tb === 2),
      `the terabytes in all, not the step: ${JSON.stringify(fake().calls.filter((c) => c.kind === 'storage'))}`,
    );
    await page.waitForFunction(() => [...document.querySelectorAll('.up-row.done')].some((r) => r.textContent.includes('pinewood-brand-film-90s_V7.mp4')), {
      polling: 200,
      timeout: 30000,
    });
    await page.click('[data-testid=limit-done-close]');
  });

  await check('a paid trial on a full Team: the invite and the sheet say the trial ends today and Business is billed now', async () => {
    // what is open (a toast, a sheet's refusal) at a phone's width and a desktop's, both themes: plain viewports, so
    // nothing reloads
    const fitsOpen = async (name) => {
      const problems = await layoutMatrix(
        page,
        { [name]: null },
        {
          show: dataTheme,
          widths: [390, 1440],
          each: async (width, theme) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}-${theme}-${width}.png`) }),
        },
      );
      assert(!problems.length, problems.join('\n'));
    };
    // Team paid during its trial (the Visa on file, the subscription trialing: Billing says paid, as the real module does)
    const trialing = {
      plan: 'team',
      planName: 'Team',
      state: 'paid',
      trialing: true,
      customer: true,
      interval: 'month',
      currency: 'eur',
      renewsAt: new Date(Date.now() + 10 * DAY).toISOString(),
      limits: { members: 2, bytes: 1e12, activeVideos: null },
      usage: { members: 2, bytes: 4e11, activeVideos: 3 },
    };
    setFake(ana.ws, trialing);
    await fresh('#/settings/users');
    await page.waitForSelector('form.set-form');
    // what the invite's Today line says, each time it changes (the box is read out: it says one thing, once)
    await page.evaluate(() => {
      window.__todaySaid = [];
      new MutationObserver(() => {
        const said = document.querySelector('[data-testid=invite-beyond] .lim-beyond-today > span:last-child')?.textContent.replace(/\s+/g, ' ').trim();
        if (said && window.__todaySaid.at(-1) !== said) window.__todaySaid.push(said);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    heldPreviews = [];
    await page.type('form.set-form input[type=email]', 'tom.weber@example.com');
    await page.waitForSelector('[data-testid=invite-beyond]', { timeout: 10000 });
    for (let i = 0; i < 100 && !heldPreviews.length; i++) await sleep(50);
    assert(heldPreviews.length, 'the provider was asked what the switch costs');
    // while it answers, the Today line holds its place: no sentence about an amount nobody knows yet
    await page.waitForSelector('[data-testid=invite-beyond] .lim-beyond-today .sk-line', { timeout: 10000 });
    const asking = await text('[data-testid=invite-beyond] .lim-beyond-today');
    assert(/^Today$/.test(asking), `nothing said while the preview is on its way: ${asking}`);
    const answers = heldPreviews;
    heldPreviews = null;
    for (const go of answers) await go();
    await waitText('[data-testid=invite-beyond]', /your trial ends today/);
    const line = await text('[data-testid=invite-beyond]');
    assert(/^Team holds 2 members\./.test(line), line);
    assert(/Business brings Tom in: €126 a month for the 3 of you, excl\. VAT\./.test(line), line);
    assert(/Today\s*€84\.00 excl\. VAT \(€99\.96 incl\. VAT\): your trial ends today, and Business is billed now, paid with Visa •••• 4242\./.test(line), line);
    const said = await page.evaluate(() => window.__todaySaid);
    assert(said.length === 1, `the Today line said one thing: ${JSON.stringify(said)}`);
    await shots('2c-trial', null, { sel: '[data-testid=invite-beyond]' });
    if (SHOTS)
      for (const width of [1440, 390]) {
        await page.setViewport({ width, height: width === 390 ? 844 : 900 });
        await settle(page);
        await page.$eval('[data-testid=invite-beyond]', (el) => el.scrollIntoView({ block: 'center' }));
        await page.screenshot({ path: path.join(SHOTS, `2c-trial-line-${width}.png`) });
      }
    await page.setViewport({ width: 1440, height: 900 });
    assert((await text('[data-testid=invite-submit]')) === 'Switch to Business and invite Tom', await text('[data-testid=invite-submit]'));
    // the payment that ends the trial is declined first: the module's sentence, nobody invited, nothing changed
    patchFake(ana.ws, { trialDeclines: true });
    await page.click('[data-testid=invite-submit]');
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[data-testid=toast]')].some((t) =>
          t.textContent.includes('The payment for Business didn’t go through, so the plan is unchanged and the trial goes on.'),
        ),
      { polling: 100, timeout: 20000 },
    );
    await fitsOpen('2c-trial-declined');
    assert(fake().workspaces[ana.ws].plan === 'team' && fake().workspaces[ana.ws].trialing === true, JSON.stringify(fake().workspaces[ana.ws]));
    const none = (await request('GET', '/api/admin/invites', { headers: { Cookie: ana.cookie } })).json().invites;
    assert(!none.some((i) => i.email === 'tom.weber@example.com' && i.status === 'pending'), 'nobody invited');
    patchFake(ana.ws, { trialDeclines: undefined });
    await page.waitForFunction(() => !document.querySelector('[data-testid=invite-submit]')?.disabled, { polling: 100, timeout: 10000 });
    await page.click('[data-testid=invite-submit]');
    await page.waitForFunction(
      () => [...document.querySelectorAll('[data-testid=toast]')].some((t) => t.textContent.includes('Costa Cuts is on Business. Tom’s invite is on its way.')),
      { polling: 100, timeout: 20000 },
    );
    assert(
      fake().calls.some((c) => c.kind === 'plan' && c.plan === 'business' && c.endsTrial),
      JSON.stringify(fake().calls.filter((c) => c.kind === 'plan')),
    );

    // the same moment as a limit's sheet (a refused invite): the order, Today, and the sentence under it
    setFake(ana.ws, trialing);
    await fresh('#/settings/users');
    await page.waitForSelector('form.set-form');
    heldPreviews = [];
    await ask({ reason: 'members', needed: 'lea.berg@example.com', name: 'Lea', fits: 'business' });
    await sheet('members');
    assert((await page.$eval('[data-testid=limit-sheet]', (e) => e.dataset.fit)) === 'business', 'Business brings Lea in');
    for (let i = 0; i < 100 && !heldPreviews.length; i++) await sleep(50);
    assert(heldPreviews.length, 'the sheet asked what the switch costs');
    await page.waitForSelector('[data-testid=limit-sheet] .pay-total .sk-line', { timeout: 10000 });
    const pending = await text('[data-testid=limit-sheet] [data-testid=pay-order]');
    assert(!/€0\.00|next invoice|invoice of/.test(pending), `nothing said while the preview is on its way: ${pending}`);
    const sheetAnswers = heldPreviews;
    heldPreviews = null;
    for (const go of sheetAnswers) await go();
    await waitText('[data-testid=limit-sheet] [data-testid=pay-order]', /Your trial ends today/);
    const order = await text('[data-testid=limit-sheet] [data-testid=pay-order]');
    assert(/Today\s*€84\.00 excl\. VAT \(€99\.96 incl\. VAT\)/.test(order), order);
    assert(/Your trial ends today, and Business is billed now: €84\.00 excl\. VAT \(€99\.96 incl\. VAT\)\./.test(order), order);
    assert(!/€0\.00|next invoice/.test(order), order);
    await shots('3f-trial', null);
    await page.click('[data-testid=pay-go]');
    await page.waitForSelector('[data-testid=limit-done]', { timeout: 20000 });
    const done = await text('[data-testid=limit-done]');
    assert(/Costa Cuts is on Business/.test(done), done);
    assert(/Business is billed from today; every invoice is in Settings → Billing\./.test(done), done);
    await page.click('[data-testid=limit-done-close]');
    await sheetGone();

    // out of room while trialing: no terabyte is sold until the trial ends (no `addons`), so Business is what fits — no
    // gap where the terabyte would be, and a payment that is declined says so in the sheet and changes nothing
    setFake(ana.ws, { ...trialing, trialDeclines: true, usage: { members: 2, bytes: 1e12 - 1e9, activeVideos: 3 } });
    await fresh('#/');
    await page.waitForSelector('.lib-scroll');
    await ask({ reason: 'storage', needed: 64e9, name: 'pinewood-brand-film-90s_V7.mov', upload: 'posed', room: { videos: 0, bytes: 0 } });
    await sheet('storage');
    assert((await page.$eval('[data-testid=limit-sheet]', (e) => e.dataset.fit)) === 'business', 'Business, not a terabyte');
    assert(!/\+1 TB/.test(await text('[data-testid=limit-sheet]')), await text('[data-testid=limit-sheet]'));
    await waitText(
      '[data-testid=limit-sheet] [data-testid=pay-order]',
      /Your trial ends today, and Business is billed now: €84\.00 excl\. VAT \(€99\.96 incl\. VAT\)\./,
    );
    await page.waitForSelector('[data-testid=pay-go]:enabled');
    await page.click('[data-testid=pay-go]');
    await waitText(
      '[data-testid=pay-error]',
      /^The payment for Business didn’t go through, so the plan is unchanged and the trial goes on\. Check the card in Billing and try again\.$/,
    );
    assert(!(await page.$('[data-testid=limit-done]')), 'still the offer');
    assert(fake().workspaces[ana.ws].plan === 'team', JSON.stringify(fake().workspaces[ana.ws]));
    await shots('3g-trial-declined', null);
    // on a phone the button floats over the sheet's end: the refusal comes into view above it, never under it
    await page.setViewport({ width: 390, height: 844 });
    await settle(page);
    await page.click('[data-testid=pay-go]');
    await page.waitForSelector('[data-testid=pay-go]:enabled', { timeout: 10000 });
    await waitText('[data-testid=pay-error]', /didn’t go through/);
    await settle(page);
    const clear = await page.evaluate(() => {
      const e = document.querySelector('[data-testid=pay-error]').getBoundingClientRect();
      const b = document.querySelector('[data-testid=pay-go]').getBoundingClientRect();
      return { top: Math.round(e.top), bottom: Math.round(e.bottom), button: Math.round(b.top) };
    });
    assert(clear.top >= 0 && clear.bottom <= clear.button, `the refusal in view, above the button: ${JSON.stringify(clear)}`);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '3g-trial-declined-phone.png') });
    await page.setViewport({ width: 1440, height: 900 });
    await page.click('[data-testid=limit-later]');
    await sheetGone();

    // a sheet opened before the trial began (one terabyte, the plan's answer then) and paid now: the module's refusal
    setFake(ana.ws, {
      plan: 'team',
      planName: 'Team',
      state: 'paid',
      customer: true,
      interval: 'year',
      currency: 'eur',
      renewsAt: new Date(Date.now() + 300 * DAY).toISOString(),
      limits: { members: 50, bytes: 1000, activeVideos: null },
      addons: { storageTB: 0 },
      usage: { members: 2, bytes: 1e12 + 900, activeVideos: 1 },
    });
    await fresh('#/');
    await page.waitForSelector('.lib-scroll');
    await ask({ reason: 'storage', needed: 64e9, name: 'pinewood-brand-film-90s_V7.mov', upload: 'posed', room: { videos: 0, bytes: 0 } });
    await sheet('storage');
    assert((await page.$eval('[data-testid=limit-sheet]', (e) => e.dataset.fit)) === 'addon', 'one more terabyte, as the plan said then');
    await waitText('[data-testid=limit-sheet] [data-testid=pay-saved-card]', /Visa •••• 4242/);
    patchFake(ana.ws, { trialing: true });
    await page.click('[data-testid=pay-go]');
    await waitText('[data-testid=pay-error]', /^Extra storage can be added once the trial has ended: until then the plan’s own storage applies\.$/);
    assert(!fake().calls.some((c) => c.kind === 'storage' && c.tb === 1), 'nothing bought');
    await fitsOpen('3h-trial-storage');
    await page.setViewport({ width: 390, height: 844 });
    await settle(page);
    await page.click('[data-testid=pay-go]');
    await page.waitForSelector('[data-testid=pay-go]:enabled', { timeout: 10000 });
    await settle(page);
    const shown = await page.evaluate(() => {
      const e = document.querySelector('[data-testid=pay-error]').getBoundingClientRect();
      const b = document.querySelector('[data-testid=pay-go]').getBoundingClientRect();
      return { top: Math.round(e.top), bottom: Math.round(e.bottom), button: Math.round(b.top) };
    });
    assert(shown.top >= 0 && shown.bottom <= shown.button, `the refusal in view, above the button: ${JSON.stringify(shown)}`);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '3h-trial-storage-phone.png') });
    await page.setViewport({ width: 1440, height: 900 });
    await page.click('[data-testid=limit-later]');
    await sheetGone();
  });

  await check('Insights on Free explain themselves; See Team opens the feature’s sheet, billed for two', async () => {
    setFake(ana.ws, { ...FREE });
    await fresh('#/insights');
    await page.waitForSelector('[data-testid=insights-explained]', { timeout: 15000 });
    const page3d = await text('[data-testid=insights-explained]');
    assert(/Insights come with Team/.test(page3d) && /See where review time goes/.test(page3d), page3d);
    assert(/From Costa Cuts’ own work — 2 videos, 0 notes, 0 checked fixes — Insights shows:/.test(page3d), page3d);
    assert(/Illustration · not your data/.test(page3d), page3d);
    assert(/Team: €40 a month for 2, billed yearly, excl\. VAT/.test(page3d), page3d);
    // the sidebar's row says which plan brings them, while the page explains
    const tag = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.nav-item')].find((r) => r.querySelector('.i-chart'));
      return row && getComputedStyle(row, '::after').content;
    });
    assert(tag === '"Team"', `the Insights row's tag: ${tag}`);
    await shots('3d', null, { sel: '[data-testid=insights-explained]' });
    await page.click('[data-testid=insights-see-team]');
    await sheet('feature');
    const head = await text('[data-testid=limit-sheet] .lim-head');
    assert(/Insights come with Team/.test(head), head);
    assert(/^.*Team is for 2 to 50 members, so it is billed for 2 while you work alone\./.test(head), head);
    await page.click('[data-testid=limit-later]');
    await sheetGone();
  });

  await check('who doesn’t choose the plan reads the sentence as a toast, never a sheet', async () => {
    setFake(pia.ws, { ...FREE, limits: { members: 2, bytes: 1000, activeVideos: 3 } });
    await signIn(max);
    await fresh('#/');
    await upload(clip);
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[data-testid=toast]')].some((t) => /no room for this file\. Owners and admins choose the plan\./.test(t.textContent)),
      { polling: 100, timeout: 15000 },
    );
    assert(!(await page.$('[data-testid=limit-sheet]')), 'no sheet for a member');
    assert(
      !(await page.evaluate(() => [...document.querySelectorAll('[data-testid=toast] button')].some((b) => b.textContent === 'See plans'))),
      'no way to the plans for who can’t choose one',
    );
  });

  await check('nothing moves while Stripe’s fields load: the sheet keeps their room', async () => {
    await signIn(ana.cookie);
    setFake(ana.ws, { ...FREE, usage: { members: 1, bytes: 9.4e9, activeVideos: 2 }, limits: { members: 1, bytes: 10e9, activeVideos: 3 } });
    await fresh('#/');
    await page.waitForSelector('.lib-scroll');
    held = [];
    await ask({ reason: 'storage', needed: 1.8e9, name: 'fjord-hotel-rooms-v3.mov', upload: 'posed', room: { videos: 3, bytes: 4.2e9 } });
    await sheet('storage');
    await page.waitForSelector('[data-testid=limit-sheet] [data-testid=billing-checkout]', { timeout: 15000 });
    await settle(page);
    // the sheet's top, its head and what fits hold still; the payment column only grows downwards as its fields arrive
    const box = () =>
      page.evaluate(() =>
        JSON.stringify(
          ['[data-testid=limit-sheet]', '.lim-head', '.lim-fit', '.lim-pay [data-testid=billing-checkout]'].map((s) => {
            const r = document.querySelector(s).getBoundingClientRect();
            return s === '.lim-head' || s === '.lim-fit' ? [r.top, r.left, r.width, r.height] : [r.top, r.left, r.width];
          }),
        ),
      );
    const before = await box();
    for (let i = 0; i < 50 && !held.length; i++) await sleep(100);
    const waiting = held;
    held = null;
    for (const answer of waiting) await answer();
    await page.waitForSelector('[data-testid=limit-sheet] [data-testid=billing-pay]:enabled', { timeout: 15000 });
    await settle(page);
    const after = await box();
    // still to the pixel (a frame's sub-pixel rounding is not a move)
    const moved = JSON.parse(before).some((r, i) => r.some((v, j) => Math.abs(v - JSON.parse(after)[i][j]) >= 0.5));
    assert(!moved, `the sheet held still: ${before} → ${after}`);
    await page.click('[data-testid=limit-later]');
    await sheetGone();
  });

  await check('every sheet fits a phone to 2560 px, light and dark, with 44 px targets on a phone', async () => {
    const posed = {
      '3a': {
        state: { ...FREE, usage: { members: 1, bytes: 9.4e9, activeVideos: 2 }, limits: { members: 1, bytes: 10e9, activeVideos: 3 } },
        ask: { reason: 'storage', needed: 1.8e9, name: 'fjord-hotel-rooms-v3.mov', upload: 'posed', room: { videos: 3, bytes: 4.2e9 } },
      },
      '3b': {
        state: {
          plan: 'team',
          planName: 'Team',
          state: 'paid',
          customer: true,
          interval: 'year',
          seats: 4,
          renewsAt: new Date(Date.now() + 300 * DAY).toISOString(),
          usage: { members: 4, bytes: 2.969e12, activeVideos: 11 },
          limits: { members: 50, bytes: 3e12, activeVideos: null },
          addons: { storageTB: 0 },
        },
        ask: { reason: 'storage', needed: 64e9, name: 'pinewood-brand-film-90s_V7.mov', upload: 'posed', room: { videos: 6, bytes: 412e9 } },
      },
      '3c': { state: { ...FREE }, ask: { reason: 'members', needed: 'ben.kruse@example.com', name: 'Ben' } },
      '3e': { state: { ...FREE }, ask: { feature: 'insights', fits: 'team' } },
    };
    for (const [name, { state, ask: limit }] of Object.entries(posed)) {
      setFake(ana.ws, state);
      await fresh(name === '3e' ? '#/insights' : name === '3c' ? '#/settings/users' : '#/');
      await page.waitForSelector(name === '3e' ? '[data-testid=insights-explained]' : name === '3c' ? 'form.set-form' : '.lib-scroll', { timeout: 15000 });
      await ask(limit);
      await page.waitForSelector('[data-testid=limit-sheet]', { timeout: 15000 });
      if (state.state === 'free') await page.waitForSelector('[data-testid=limit-sheet] [data-testid=billing-pay]:enabled', { timeout: 15000 });
      await shots(name, null);
      await page.click('[data-testid=limit-later]');
      await sheetGone();
    }
  });

  await check('German: the sheet in German, du', async () => {
    setFake(ana.ws, { ...FREE, usage: { members: 1, bytes: 9.4e9, activeVideos: 2 }, limits: { members: 1, bytes: 10e9, activeVideos: 3 } });
    await page.evaluate(() => localStorage.setItem('vr.lang', 'de'));
    await fresh('#/');
    await page.waitForSelector('.lib-scroll');
    await ask({ reason: 'storage', needed: 1.8e9, name: 'fjord-hotel-rooms-v3.mov', upload: 'posed', room: { videos: 3, bytes: 4.2e9 } });
    await sheet('storage');
    const head = await text('[data-testid=limit-sheet] .lim-head');
    assert(/fjord-hotel-rooms-v3\.mov braucht mehr Platz/.test(head), head);
    assert(/Die Datei hat 1,8 GB, und Costa Cuts hat von den 10 GB auf Free noch 600 MB frei\. Der Upload wartet;/.test(head), head);
    assert((await text('[data-testid=limit-later]')) === 'Nicht jetzt · der Upload wartet', await text('[data-testid=limit-later]'));
    assert(/Oder schaff Platz: 3 finale Videos belegen 4,2 GB\./.test(await text('[data-testid=limit-room]')), await text('[data-testid=limit-room]'));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '3a-de-1440.png') });
    await page.click('[data-testid=limit-later]');
    await page.evaluate(() => localStorage.removeItem('vr.lang'));
  });

  assert(!errors.length, `no page errors: ${errors.join('\n')}`);
} catch (e) {
  crashed(e);
} finally {
  await browser?.close();
  await srv.stop();
  fs.rmSync(fakeDir, { recursive: true, force: true });
}
finish(LABEL);
