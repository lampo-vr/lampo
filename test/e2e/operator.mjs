#!/usr/bin/env node
// covers: web/src/operator/ web/src/styles/operator.css server/routes/operator.ts lib/funnel.ts server/funnel.ts
// covers: web/src/lib/nav.ts web/src/settings/Settings.tsx web/src/settings/Speech.tsx
// The operator's funnel page (#/operator/funnel) on a hosted server with a billing module (the stand-in,
// test/e2e/lib/billingModule.ts): before anything was counted it says so and what will be counted, never an example
// number; a member of the first workspace and another workspace's owner read that there is no such page; with weeks of
// sign-ups counted it shows the four figures, the eight steps with the biggest drop before paying flagged (a step's
// detail on hover and on Tab), each sign-up week's share per step with the weeks still in their trial marked, and 4 / 8 /
// 12 weeks; a real sign-up is counted where it happened. It fits 390–2560 in both themes. Screenshots go to VR_SHOTS.
import fs from 'node:fs';
import path from 'node:path';
import { readOutbox } from '../../lib/mail/index.ts';
import { ROOT, sleep, tmpdir } from '../lib/helpers.ts';
import { client } from '../lib/http.ts';
import { layoutMatrix, settle } from './layout.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { LEGAL, startServer } from './lib/server.mjs';

const LABEL = 'operator e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const fakeDir = tmpdir('vr-e2e-operator-fake-');
const FAKE = path.join(fakeDir, 'billing.json');
const srv = await startServer({
  prefix: 'vr-e2e-operator-',
  mode: 'server',
  publicUrl: true,
  env: { ...LEGAL, VR_SIGNUP: 'open', VR_CLOUD_MODULE: path.join(ROOT, 'test/e2e/lib/billingModule.ts'), FAKE_BILLING_FILE: FAKE },
});
const { base: BASE } = srv;
const request = client(srv.port);
const origin = { Origin: BASE };
const PASSWORD = 'a long enough password';
const OUTBOX = path.join(srv.env.VR_CACHE, 'outbox');
const FUNNEL = path.join(srv.env.VR_DATA, 'funnel.json');
const WIDTHS = [390, 768, 1024, 1440, 1920, 2560];

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

// Ten sign-up weeks up to this one, real-shaped: a few hundred workspaces each, fewer at every step, the steps after
// the trial only for the weeks whose trials have ended (what the server would have written, lib/funnel.ts).
const DAY = 86_400_000;
const utc = (t) => new Date(t).toISOString().slice(0, 10);
function seed() {
  const today = Date.now();
  const d = new Date(today);
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * DAY;
  const steps = ['setup_done', 'video_first', 'link_first', 'link_opened_first', 'fix_checked_first', 'trial_end', 'plan_paid'];
  // of the step before, and how many days after sign-up
  const keep = [0.76, 0.78, 0.68, 0.71, 0.68, 0.85, 0.56];
  const after = [0, 1, 2, 3, 4, 14, 13];
  const workspaces = {};
  let n = 0;
  for (let w = 9; w >= 0; w--) {
    const start = monday - w * 7 * DAY;
    const signups = 140 + ((w * 37) % 70);
    for (let i = 0; i < signups; i++) {
      const at = start + (i % 7) * DAY;
      if (at > today) continue;
      const rec = { signup: { day: utc(at), plan: 'team' } };
      // deterministic: workspace i reaches step k when its share stays under the step's rate
      let share = 1;
      for (let k = 0; k < steps.length; k++) {
        share *= keep[k];
        const when = at + after[k] * DAY + (i % 3) * DAY;
        if (i / signups >= share || when > today) break;
        rec[steps[k]] = { day: utc(when), plan: 'team' };
      }
      workspaces[`w_seed${String(++n).padStart(8, '0')}`] = { steps: rec };
    }
  }
  fs.writeFileSync(FUNNEL, JSON.stringify({ v: 1, workspaces, moments: {}, rolled: {} }));
  return n;
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
  const olivia = cookieOf(setup);
  // Max: a member of the first workspace (invited, confirmed through his link)
  const inv = await request('POST', '/api/admin/invites', { body: { role: 'member' }, headers: { Cookie: olivia, ...origin } });
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
  screenshotFailures(() => page, 'operator');
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));
  const host = new URL(BASE).hostname;
  const signIn = async (cookie) => {
    await page.deleteCookie(...(await page.cookies(BASE)));
    await page.setCookie({ name: 'vr_session', value: cookie.split('=')[1], domain: host, path: '/', httpOnly: true });
  };
  const text = (sel) => page.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim());
  const fresh = async (hash) => {
    await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
  };
  /** Every width in both themes, a screenshot of each (the whole page) when VR_SHOTS is set. */
  const sweep = (name) =>
    layoutMatrix(
      page,
      { [name]: null },
      {
        widths: WIDTHS,
        show: (p, theme) => p.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme),
        each: async (width, theme) => {
          if (!SHOTS) return;
          // the page scrolls in its column: its top, then its end
          await page.evaluate(() => document.querySelector('.set-main')?.scrollTo(0, 0));
          await page.screenshot({ path: path.join(SHOTS, `operator-${name}-${theme}-${width}.png`) });
          await page.evaluate(() => document.querySelector('.set-main')?.scrollTo(0, 1e6));
          await page.screenshot({ path: path.join(SHOTS, `operator-${name}-${theme}-${width}-end.png`) });
          await page.evaluate(() => document.querySelector('.set-main')?.scrollTo(0, 0));
        },
      },
    );

  await check('nothing counted yet: the page says so and what will be counted, never an example number', async () => {
    await signIn(olivia);
    await fresh('#/operator/funnel');
    await page.waitForSelector('[data-testid=op-empty]', { timeout: 15000 });
    assert(/Nothing counted yet/.test(await text('[data-testid=op-empty]')), await text('[data-testid=op-empty]'));
    assert(/What is counted, and what never is/.test(await text('[data-testid=op-privacy]')));
    assert(!(await page.$('[data-testid=op-figures]')), 'no figures');
    assert(!/Example numbers/.test(await page.evaluate(() => document.body.textContent)), 'no example numbers');
    assert((await text('.op-who')).includes('Only you see this'));
    const problems = await sweep('empty');
    assert(!problems.length, problems.join('\n'));
  });

  await check('a member of the first workspace reads that there is no such page', async () => {
    await signIn(max);
    await fresh('#/operator/funnel');
    await page.waitForSelector('[data-testid=op-missing]', { timeout: 15000 });
    assert(/There’s no page here/.test(await text('[data-testid=op-missing]')));
    assert(!(await page.$('[data-testid=op-privacy]')), 'nothing of the page');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'operator-member-refused.png') });
  });

  await check('Voice notes on a hosted server: a member reads where it runs, never the engine or the server’s settings; the operator does', async () => {
    await signIn(max);
    await fresh('#/settings/speech');
    await page.waitForSelector('[data-testid=speech-facts]', { timeout: 15000 });
    const said = await page.$eval('.set-inner', (e) => e.innerText);
    assert(said.includes('Switched off on this server.'), said);
    assert(!/Mac|Apple silicon|graphics chip|computer Lampo runs on/.test(said), `the machine's words on a hosted server: ${said}`);
    assert(!(await page.$('[data-testid=speech-details]')), 'a member sees no engine, model or config.json');
    await signIn(olivia);
    await fresh('#/settings/speech');
    await page.waitForSelector('[data-testid=speech-details]', { timeout: 15000 });
    const theirs = await page.$eval('.set-inner', (e) => e.innerText);
    assert(theirs.includes('Switched off on this server.'), theirs);
  });

  let seeded = 0;
  await check('weeks of sign-ups: four figures, eight steps, the biggest drop flagged, each week’s share', async () => {
    seeded = seed();
    await signIn(olivia);
    await fresh('#/operator/funnel');
    await page.waitForSelector('[data-testid=op-funnel] .op-fn-item', { timeout: 15000 });
    const figures = await page.$$eval('.op-figure', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    assert(figures.length === 4, figures.join(' | '));
    assert(/^Sign-ups, 8 weeks/.test(figures[0]), figures[0]);
    assert(/Paid, of finished trials\s?\d/.test(figures[1]), figures[1]);
    const rows = await page.$$eval('.op-fn-item', (els) => els.map((e) => e.dataset.step));
    assert(rows.join() === 'signup,setup_done,video_first,link_first,link_opened_first,fix_checked_first,trial_end,plan_paid', rows.join());
    const flagged = await page.$$eval('.op-fn-row.worst', (els) => els.map((e) => e.closest('li').dataset.step));
    assert(flagged.length === 1 && flagged[0] !== 'trial_end' && flagged[0] !== 'plan_paid', `one drop before paying: ${flagged}`);
    assert(/Biggest drop before paying/.test(await text('.op-fn-row.worst')));
    // a step's detail: on hover, and on Tab for the keyboard
    await page.hover('[data-step=video_first] .op-fn-row');
    await page.waitForSelector('[data-step=video_first] .op-fn-tip');
    assert(/of the step before; \d+ stopped here/.test(await text('[data-step=video_first] .op-fn-tip')), await text('[data-step=video_first] .op-fn-tip'));
    await page.mouse.move(0, 0);
    await page.focus('[data-step=signup] .op-fn-row');
    await page.keyboard.press('Tab');
    await page.waitForSelector('[data-step=setup_done] .op-fn-tip');
    assert(await page.$eval('[data-step=setup_done] .op-fn-row', (b) => b === document.activeElement), 'Tab moved to the next step');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.op-fn-tip'));
    // by sign-up week: eight weeks, the youngest still in their trial
    const weeks = await page.$$eval('.op-cohort tbody tr', (rs) => rs.length);
    assert(weeks === 8, `${weeks} weeks`);
    assert((await page.$$('.op-ch-run')).length >= 2, 'the weeks still in their trial are marked');
    assert(/running/.test(await text('.op-cohort tbody tr:last-child th')));
    // 4 and 12 weeks
    await page.evaluate(() => [...document.querySelectorAll('.op-controls .seg button')].find((b) => b.textContent === '4 weeks').click());
    await page.waitForFunction(() => document.querySelectorAll('.op-cohort tbody tr').length === 4);
    await page.evaluate(() => [...document.querySelectorAll('.op-controls .seg button')].find((b) => b.textContent === '12 weeks').click());
    await page.waitForFunction(() => document.querySelectorAll('.op-cohort tbody tr').length === 12);
    await page.evaluate(() => [...document.querySelectorAll('.op-controls .seg button')].find((b) => b.textContent === '8 weeks').click());
    await page.waitForFunction(() => document.querySelectorAll('.op-cohort tbody tr').length === 8);
    await settle(page);
    const problems = await sweep('weeks');
    assert(!problems.length, problems.join('\n'));
  });

  await check('a real sign-up is counted in this week', async () => {
    const before = (await request('GET', '/api/operator/funnel?weeks=4', { headers: { Cookie: olivia } })).json();
    const signup = await request('POST', '/api/auth/signup', {
      body: { name: 'Pia Brandt', email: 'pia@e2e.test', password: PASSWORD, lang: 'en' },
      headers: origin,
    });
    assert(signup.status === 200, signup.text);
    const verified = await request('POST', '/api/auth/verify', {
      body: { token: await confirmToken('pia@e2e.test') },
      headers: { Cookie: cookieOf(signup, 'vr_signup'), ...origin },
    });
    assert(verified.status === 200, verified.text);
    const pia = cookieOf(verified);
    const after = (await request('GET', '/api/operator/funnel?weeks=4', { headers: { Cookie: olivia } })).json();
    assert(after.cohorts.at(-1).signups === before.cohorts.at(-1).signups + 1, `${before.cohorts.at(-1).signups} → ${after.cohorts.at(-1).signups}`);
    const stored = Object.values(JSON.parse(fs.readFileSync(FUNNEL, 'utf8')).workspaces).length;
    assert(stored === seeded + 1, `${stored} workspaces counted`);
    // Pia owns a workspace of her own: a customer, not the operator
    const r = await request('GET', '/api/operator/funnel', { headers: { Cookie: pia } });
    assert(r.status === 404, r.text);
  });

  await check('German', async () => {
    await page.evaluate(() => localStorage.setItem('vr.lang', 'de'));
    await fresh('#/operator/funnel');
    await page.waitForSelector('[data-testid=op-funnel] .op-fn-item', { timeout: 15000 });
    assert(/Wohin die Leute gehen/.test(await text('[data-testid=op-funnel]')), await text('[data-testid=op-funnel] header'));
    assert(/Registrierungen, 8 Wochen/.test(await text('.op-figure')));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'operator-weeks-de-1440.png'), fullPage: true });
    await page.evaluate(() => localStorage.removeItem('vr.lang'));
  });

  await check('no console errors', async () => {
    assert(!errors.length, errors.join('\n'));
  });
} catch (e) {
  crashed(e, srv);
}
await finish(LABEL, { browser, servers: [srv], dirs: [fakeDir] });
