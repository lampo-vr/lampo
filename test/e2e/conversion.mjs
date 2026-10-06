#!/usr/bin/env node
// covers: web/src/conversion/ web/src/billing/Banner.tsx web/src/billing/due.ts web/src/billing/code.ts web/src/styles/conversion.css
// covers: web/src/library/Sidebar.tsx web/src/library/LibraryTopbar.tsx web/src/library/Library.tsx web/src/auth/UserMenu.tsx
// covers: web/src/ui/layers.tsx web/src/styles/theme.css web/src/styles/library.css test/e2e/lib/billingModule.ts
// The in-app conversion moments of the app's shell, against the stand-in billing provider (test/e2e/lib/billingModule.ts):
// a workspace in its Team trial (four people, videos in four projects) shows the trial all along — a line at the
// sidebar's foot over a ruler of its days, its card with the workspace's own numbers and one way on (Choose a plan,
// for owners and admins only), the same line in the account menu — and nothing of it once paid; in its last three days
// and after it the library's banner says the date, the hour, the week of grace and the three ways on (opened only on a
// click), read-only locks Add video (a neutral button that explains, never the orange that fails later: audit B-M8).
// The line and the banner hold their room from the first paint (no layout shift), and every state fits 390–2560 in both
// themes and German. With CONVERSION_SHOTS=<dir> it also writes the QA sheet: every state at six widths × two themes.
import fs from 'node:fs';
import path from 'node:path';
import { readOutbox } from '../../lib/mail/index.ts';
import { makeVideo, ROOT, sleep, tmpdir, until } from '../lib/helpers.ts';
import { client, tusUpload } from '../lib/http.ts';
import { fitsAt, layoutMatrix, settle } from './layout.mjs';
import { launch, requireChrome } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { LEGAL, startServer } from './lib/server.mjs';

const LABEL = 'conversion e2e';
requireChrome(LABEL);
const SHOTS = process.env.CONVERSION_SHOTS || null;
const QA_WIDTHS = [390, 768, 1024, 1440, 1920, 2560];
const DAY = 86_400_000;
const fakeDir = tmpdir('vr-e2e-conversion-fake-');
const FAKE = path.join(fakeDir, 'billing.json');
const srv = await startServer({
  prefix: 'vr-e2e-conversion-',
  mode: 'server',
  publicUrl: true,
  env: { ...LEGAL, VR_SIGNUP: 'open', VR_CLOUD_MODULE: path.join(ROOT, 'test/e2e/lib/billingModule.ts'), FAKE_BILLING_FILE: FAKE },
});
const { base: BASE } = srv;
const request = client(srv.port);
const origin = { Origin: BASE };
const PASSWORD = 'a long enough password';
const OUTBOX = path.join(srv.env.VR_CACHE, 'outbox');
const media = tmpdir('vr-e2e-conversion-media-');

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
/** The workspace's billing state, as the provider would answer it (replacing what a state set before). */
const setState = (workspace, state) => {
  const d = fake();
  const { customer } = d.workspaces[workspace] ?? {};
  d.workspaces[workspace] = { ...(customer ? { customer } : {}), ...state };
  fs.writeFileSync(FAKE, JSON.stringify(d, null, 2));
};
const at = (ms) => new Date(ms).toISOString();
/** Today at hh:mm, or later today when that has passed (the trial's last day must still be today). */
const todayAt = () => {
  const d = new Date();
  const end = new Date(d);
  end.setHours(23, 30, 0, 0);
  return at(Math.min(end.getTime(), d.getTime() + 3 * 3_600_000));
};
const TEAM = { plan: 'team', planName: 'Team', limits: { members: 50, bytes: 3e12, activeVideos: null } };
const FREE = { plan: 'free', planName: 'Free', limits: { members: 1, bytes: 1e10, activeVideos: 3 } };
const STATES = {
  trial: () => ({ ...TEAM, state: 'trial', trialStartsAt: at(Date.now() - 4 * DAY), trialEndsAt: at(Date.now() + 10 * DAY) }),
  soon: () => ({ ...TEAM, state: 'trial', trialStartsAt: at(Date.now() - 11 * DAY), trialEndsAt: at(Date.now() + 3 * DAY) }),
  today: () => ({ ...TEAM, state: 'trial', trialStartsAt: at(Date.now() - 14 * DAY), trialEndsAt: todayAt() }),
  grace: () => ({ ...FREE, state: 'grace', reason: 'trial-ended', graceUntil: at(Date.now() + 6 * DAY) }),
  ro: () => ({ ...FREE, state: 'read-only', reason: 'trial-ended' }),
  paid: () => ({ ...TEAM, state: 'paid', interval: 'year', renewsAt: at(Date.now() + 360 * DAY) }),
};

let browser;
let page;
try {
  // ---------------------------------------------------------------- Northwind Studio: Mia, Jonas, Lea and Tom, 6 videos in 4 projects
  const setupToken = await srv.setupToken();
  assert(setupToken, `no setup token in the server log:\n${srv.log()}`);
  const setup = await request('POST', '/api/auth/setup', {
    body: { token: setupToken, email: 'olivia@e2e.test', name: 'Olivia', password: PASSWORD },
    headers: origin,
  });
  assert(setup.status === 200, setup.text);
  const made = await request('POST', '/api/auth/signup', {
    body: { name: 'Mia Lang', email: 'mia@e2e.test', password: PASSWORD, lang: 'en' },
    headers: origin,
  });
  assert(made.status === 200, made.text);
  const verified = await request('POST', '/api/auth/verify', {
    body: { token: await confirmToken('mia@e2e.test') },
    headers: { Cookie: cookieOf(made, 'vr_signup'), ...origin },
  });
  assert(verified.status === 200, verified.text);
  const mia = cookieOf(verified);
  const ws = (await request('GET', '/api/auth/status', { headers: { Cookie: mia } })).json().workspace.id;
  const renamed = await request('PATCH', '/api/workspaces/current', { body: { name: 'Northwind Studio' }, headers: { Cookie: mia, ...origin } });
  assert(renamed.status === 200, renamed.text);
  const join = async (name, email, role) => {
    const inv = await request('POST', '/api/admin/invites', { body: { role }, headers: { Cookie: mia, ...origin } });
    assert(inv.status === 200, inv.text);
    const took = await request('POST', '/api/auth/invite/accept', {
      body: { token: inv.json().url.split('/#/invite/')[1], name, email, password: PASSWORD },
      headers: origin,
    });
    assert(took.status === 200, took.text);
    const ok = await request('POST', '/api/auth/verify', {
      body: { token: await confirmToken(email) },
      headers: { Cookie: cookieOf(took, 'vr_signup'), ...origin },
    });
    assert(ok.status === 200, ok.text);
    return cookieOf(ok);
  };
  const jonas = await join('Jonas Weber', 'jonas@e2e.test', 'member');
  await join('Lea Berg', 'lea@e2e.test', 'reviewer');
  await join('Tom Brandt', 'tom@e2e.test', 'member');
  const clips = [
    ['coast-film-60s.mp4', 'Coast Campaign', 'testsrc2'],
    ['coast-cutdown-15s.mp4', 'Coast Campaign', 'smptehdbars'],
    ['pour-over-reel.mp4', 'Harbor Coffee', 'smptebars'],
    ['morning-ritual-15s.mp4', 'Harbor Coffee', 'rgbtestsrc'],
    ['pinewood-trail-30s.mp4', 'Pinewood Outdoor', 'testsrc'],
    ['surf-report-ep13.mp4', 'Atlantic Surf Co.', 'yuvtestsrc'],
  ];
  for (const [name, folder, pattern] of clips) {
    const file = makeVideo(path.join(media, name), { w: 640, h: 360, fps: 25, dur: 2, pattern });
    const up = await tusUpload(request, file, { filename: name, folder }, { Cookie: mia, ...origin });
    assert(up.status === 204 || up.status === 200, `${name}: ${up.status} ${up.text}`);
  }

  browser = await launch();
  page = await browser.newPage();
  screenshotFailures(() => page, 'conversion');
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
  const waitText = (sel, re, timeout = 15000) =>
    page.waitForFunction((s, src) => new RegExp(src).test(document.querySelector(s)?.textContent ?? ''), { polling: 100, timeout }, sel, re.source);
  const fresh = async (hash) => {
    await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
  };
  const library = async (state) => {
    if (state) setState(ws, STATES[state]());
    await fresh('#/');
    await page.waitForSelector('.film');
    await settle(page);
  };
  /** The plan this browser keeps for the first paint (api/persist.ts): written once the billing answer came. */
  const kept = () =>
    page.waitForFunction(
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
  /** The layout shift of a reload inside `within` (a selector), until the page holds still. */
  const shiftOnReload = async (within, ready) => {
    const watch = await page.evaluateOnNewDocument((sel) => {
      window.__shift = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (!e.hadRecentInput && e.sources?.some((x) => x.node?.closest?.(sel))) window.__shift += e.value;
      }).observe({ type: 'layout-shift', buffered: true });
    }, within);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector(ready, { timeout: 15000 });
    await settle(page, { quiet: 600 });
    const shift = await page.evaluate(() => window.__shift);
    await page.removeScriptToEvaluateOnNewDocument(watch.identifier);
    return shift;
  };
  /**
   * The QA sheet (CONVERSION_SHOTS only): the library in `state` at six widths and both themes, a fresh load each time
   * (nothing one width opened stays for the next), `prepare(width)` opening what the shot is of.
   */
  const sheet = async (name, state, prepare, { widths = QA_WIDTHS, themes = ['light', 'dark'], hash = '#/', ready = '.film' } = {}) => {
    fs.mkdirSync(SHOTS, { recursive: true });
    setState(ws, STATES[state]());
    for (const theme of themes) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
      for (const width of widths) {
        await page.setViewport({ width, height: width <= 390 ? 844 : width >= 2560 ? 1440 : 900 });
        await fresh(hash);
        await page.waitForSelector(ready);
        await settle(page, { quiet: 400 });
        await prepare?.(width);
        await settle(page, { quiet: 400 });
        await page.screenshot({ path: path.join(SHOTS, `${name}-${theme}-${width}.png`) });
      }
    }
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await page.setViewport({ width: 1440, height: 900 });
  };
  /** Below 820 px the sidebar is the drawer's: open it, and the trial's line is at its foot. */
  const openDrawer = async (width) => {
    if (width >= 820) return;
    if (!(await page.$('.drawer [data-testid=trial-line]'))) await page.click('.topbar .nav-toggle:not(.idle)');
    await page.waitForSelector('.drawer [data-testid=trial-line]', { visible: true });
  };
  const line = (width) => (width >= 820 ? 'aside.nav [data-testid=trial-line]' : '.drawer [data-testid=trial-line]');

  console.log(`conversion e2e against ${BASE} (store ${srv.dir})`);
  await signIn(mia);

  await check('the trial all along: the sidebar’s line over its ruler, its card with the workspace’s numbers, one way on', async () => {
    await library('trial');
    await page.waitForSelector('[data-testid=trial-line]');
    const line = await text('[data-testid=trial-line]');
    assert(/Team trial\s*10 days left/.test(line), line);
    // a ruler of the trial's 14 days: the 4 elapsed filled, today the playhead, the end a hollow keyframe
    const ruler = await page.$eval('[data-testid=trial-line] .cv-ruler', (r) => ({
      cells: r.querySelectorAll('.cv-ruler-cells i').length,
      past: r.querySelectorAll('.cv-ruler-cells i.p').length,
      today: r.querySelectorAll('.cv-ruler-cells i.t').length,
      end: r.querySelector('.cv-end')?.dataset.shape,
    }));
    assert(ruler.cells === 14 && ruler.past === 4 && ruler.today === 1 && ruler.end === 'outline', JSON.stringify(ruler));
    await page.click('[data-testid=trial-line]');
    await page.waitForSelector('[data-testid=trial-pop]');
    await settle(page);
    const card = await text('[data-testid=trial-pop]');
    for (const w of [
      'Day 5 of 14',
      'Ends ',
      '10 days left. No card until you choose a plan.',
      'Everything in Team, for Northwind Studio',
      'Members4 of 50',
      'Review linksin your name',
      'moves to Free unless you choose a plan. Nothing is deleted.',
      'Choose a plan',
      'Team for 4: €80 a month, billed yearly',
    ])
      assert(card.includes(w), `“${w}” in: ${card}`);
    // beside the sidebar, bottom-aligned with the line
    const box = await page.evaluate(() => {
      const pop = document.querySelector('[data-testid=trial-pop]').getBoundingClientRect();
      const line = document.querySelector('[data-testid=trial-line]').getBoundingClientRect();
      return { left: pop.left, lineRight: line.right, bottom: pop.bottom, lineBottom: line.bottom };
    });
    assert(box.left >= box.lineRight && Math.abs(box.bottom - box.lineBottom) < 2, JSON.stringify(box));
    // one orange: Choose a plan is the card's own action
    assert(await page.$('[data-testid=trial-pop] a.btn.primary[data-testid=trial-choose]'), 'Choose a plan is the card’s action');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-testid=trial-pop]'));
    // the focus goes back to the line it came from (keyboard and focus right)
    await page.waitForFunction(() => document.activeElement?.dataset.testid === 'trial-line', { timeout: 5000 });
    // and the keyboard opens it again
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid=trial-pop]');
    const fit = await fitsAt(page, 'the trial’s card');
    assert(!fit.length, fit.join('\n'));
    await page.keyboard.press('Escape');
  });

  await check('the account menu: the trial’s line opens the same card, Billing carries a quiet “Trial”', async () => {
    await page.click('.topbar .user-chip');
    await page.waitForSelector('[role=menu]');
    const menu = await text('[role=menu]');
    assert(menu.includes('Team trial · 10 days left') && /Billing\s*Trial/.test(menu), menu);
    await page.evaluate(() => [...document.querySelectorAll('[role=menuitem]')].find((x) => x.textContent.includes('Team trial ·')).click());
    await page.waitForSelector('[data-testid=trial-pop]');
    const chip = await page.$eval('.topbar .user-chip', (c) => c.getBoundingClientRect().bottom);
    const top = await page.$eval('[data-testid=trial-pop]', (c) => c.getBoundingClientRect().top);
    assert(top >= chip, `under the account chip (${top} vs ${chip})`);
    await page.keyboard.press('Escape');
  });

  await check('the line holds its room from the first paint: a reload moves nothing in the sidebar', async () => {
    await library('trial');
    await kept();
    const shift = await shiftOnReload('aside.nav', '[data-testid=trial-line]');
    assert(shift < 0.005, `the sidebar didn't move for the trial's line (layout shift ${shift.toFixed(4)})`);
    // the room and the line are one box: the placeholder painted first is exactly the line's height
    const heights = await page.evaluate(() => {
      const ph = document.createElement('span');
      ph.className = 'nav-trial';
      document.querySelector('.nav-trial-wrap')?.append(ph);
      const h = [ph.getBoundingClientRect().height, document.querySelector('[data-testid=trial-line]').getBoundingClientRect().height];
      ph.remove();
      return h;
    });
    assert(Math.abs(heights[0] - heights[1]) < 0.5, `room ${heights[0]} vs line ${heights[1]}`);
    await page.click('[data-testid=trial-line]');
    await page.waitForSelector('[data-testid=trial-pop]');
    await page.keyboard.press('Escape');
  });

  await check('a member reads the trial but not the prices: no Choose a plan, who chooses it said instead', async () => {
    await signIn(jonas);
    await library();
    await page.click('[data-testid=trial-line]');
    await page.waitForSelector('[data-testid=trial-pop]');
    const card = await text('[data-testid=trial-pop]');
    assert(!card.includes('Choose a plan') && !card.includes('€'), card);
    assert(card.includes('The workspace’s owners and admins choose its plan.'), card);
    await page.keyboard.press('Escape');
  });
  await signIn(mia);

  await check('the trial’s last three days: one line closed, the date, opened on a click only (what Free means, if nobody chooses)', async () => {
    await library('soon');
    await page.waitForSelector('[data-testid=billing-banner][data-stage=soon]');
    const row = await page.$eval('[data-testid=billing-banner] .cv-te-row', (r) => r.getBoundingClientRect().height);
    assert(Math.abs(row - 48) < 0.5, `closed it is one line of 48 px (${row})`);
    assert(
      /The trial ends on .+\. Choose a plan to keep everything as it is\./.test(await text('[data-testid=billing-banner]')),
      await text('[data-testid=billing-banner]'),
    );
    // one orange per view: Add video keeps it, the banner's button is the neutral one
    assert(await page.$('.topbar .add-video.primary'), 'Add video is the view’s orange');
    assert(!(await page.$('[data-testid=billing-banner] .btn.primary')), 'no orange in the banner');
    // the line at the sidebar's foot: the end keyframe turns half and amber, the words stay calm
    assert(/3 days left/.test(await text('[data-testid=trial-line]')), await text('[data-testid=trial-line]'));
    assert(await page.$('[data-testid=trial-line] .cv-end.last[data-shape=half]'), 'the end keyframe is half in the last three days');
    await kept();
    const shift = await shiftOnReload('main.lib-scroll', '[data-testid=billing-banner]');
    assert(shift < 0.005, `the library didn't move for the banner (layout shift ${shift.toFixed(4)})`);
    await page.click('[data-testid=banner-more]');
    await page.waitForSelector('.cv-te-body .cv-fit-grid');
    const open = await text('[data-testid=billing-banner]');
    for (const w of [
      'What Free means for Northwind Studio',
      'Members',
      'Free holds 1',
      'If no plan is chosen',
      'a week of grace',
      'Keep Team',
      'Team for 4: €80 a month, billed yearly, or €96 monthly.',
    ])
      assert(open.includes(w), `“${w}” in: ${open}`);
    const fit = await fitsAt(page, 'the banner opened');
    assert(!fit.length, fit.join('\n'));
    // × puts it away for this visit
    await page.click('[data-testid=billing-banner] .cv-te-x');
    await page.waitForFunction(() => !document.querySelector('[data-testid=billing-banner]'));
  });

  await check('the last day: the hour it ends', async () => {
    await library('today');
    await waitText('[data-testid=billing-banner]', /The trial ends today, at \d{1,2}:\d{2}( [AP]M)?\./);
    assert(/Ends today/.test(await text('[data-testid=trial-line]')), await text('[data-testid=trial-line]'));
  });

  await check('the week of grace: three honest ways on, with exactly what fitting into Free takes', async () => {
    await library('grace');
    await waitText('[data-testid=billing-banner]', /The trial has ended\. Northwind Studio keeps working as it is until/);
    assert(/Free · grace\s*until/.test(await text('[data-testid=trial-line]')), await text('[data-testid=trial-line]'));
    await page.click('[data-testid=banner-more]');
    await page.waitForSelector('.cv-te-ways');
    // who would have to leave, by name (the workspace's people, asked for when the options open)
    await waitText('.cv-te-ways', /3 members to remove: Jonas Weber, Lea Berg, Tom Brandt/);
    const ways = await text('.cv-te-ways');
    for (const w of [
      'Keep Team',
      'Choose Team',
      'Fit into Free',
      '3 members to remove: Jonas Weber, Lea Berg, Tom Brandt',
      'Or do nothing: on',
      'The review links you sent',
      'Nothing is deleted, ever, because of a plan.',
    ])
      assert(ways.includes(w), `“${w}” in: ${ways}`);
    assert(!(await page.$('.cv-te-ways .btn.primary')), 'in grace the banner keeps to the neutral button');
  });

  await check('read-only: Add video is locked and explains itself; Keep Team becomes the orange (audit B-M8)', async () => {
    await library('ro');
    await page.waitForSelector('[data-testid=billing-banner][data-stage=ro].bad');
    assert(!(await page.$('.topbar .add-video.primary')), 'Add video is not the orange primary when nothing can be added');
    assert(await page.$('.topbar .add-video.locked'), 'Add video carries a lock');
    await page.click('.topbar .add-video');
    await page.waitForSelector('[data-testid=readonly-pop]');
    const pop = await text('[data-testid=readonly-pop]');
    assert(pop.includes('New videos wait for now') && pop.includes('Reviewing and the links you sent keep working.'), pop);
    assert(!(await page.$('input[type=file]:focus')), 'no file picker opened');
    await page.keyboard.press('Escape');
    // A, the key, explains too
    await page.keyboard.press('a');
    await page.waitForSelector('[data-testid=readonly-pop]');
    await page.keyboard.press('Escape');
    await page.click('[data-testid=banner-more]');
    await page.waitForSelector('.cv-te-ways');
    assert(await page.$('.cv-te-ways .cv-way.lead a.btn.primary'), 'Keep Team is the one orange when read-only');
  });

  await check('paid: nothing in the sidebar, no banner, Add video the orange again', async () => {
    await library('paid');
    assert(!(await page.$('[data-testid=trial-line]')) && !(await page.$('.nav-trial')), 'no trial line once paid');
    assert(!(await page.$('[data-testid=billing-banner]')), 'no banner once paid');
    assert(await page.$('.topbar .add-video.primary'), 'Add video is the orange again');
  });

  await check('German: the line, the card and the banner in German (du)', async () => {
    setState(ws, STATES.soon());
    await page.evaluate(() => localStorage.setItem('vr.lang', 'de'));
    await fresh('#/');
    await page.waitForSelector('[data-testid=billing-banner]');
    await waitText('[data-testid=billing-banner]', /Die Testphase endet am .+\. Wähl einen Plan, dann bleibt alles, wie es ist\./);
    await waitText('[data-testid=trial-line]', /Team-Testphase\s*noch 3 Tage/);
    await page.click('[data-testid=trial-line]');
    await page.waitForSelector('[data-testid=trial-pop]');
    const card = await text('[data-testid=trial-pop]');
    assert(card.includes('Plan wählen') && card.includes('Alles aus Team, für Northwind Studio'), card);
    const fit = await fitsAt(page, 'German: the trial’s card');
    assert(!fit.length, fit.join('\n'));
    await page.keyboard.press('Escape');
    await page.evaluate(() => localStorage.setItem('vr.lang', 'en'));
  });

  const slugOf = async (name) => {
    const lib = (await request('GET', '/api/library', { headers: { Cookie: mia } })).json();
    return lib.videos.find((v) => v.name === name).slug;
  };
  /** Another session of Mia's: another device. */
  const elsewhere = async () => {
    const r = await request('POST', '/api/auth/login', { body: { email: 'mia@e2e.test', password: PASSWORD }, headers: origin });
    assert(r.status === 200, r.text);
    return cookieOf(r);
  };

  await check('the first loop on a video of its own: a line under the stage while the trial runs; Not now holds on every device', async () => {
    setState(ws, STATES.trial());
    const slug = await slugOf('coast-film-60s.mp4');
    const made = await request('POST', `/api/review/${encodeURIComponent(slug)}/comments`, {
      body: { v: 1, frame: 10, text: 'The road reads too warm here.', severity: 'must' },
      headers: { Cookie: mia, ...origin },
    });
    assert(made.status === 200, made.text);
    const id = made.json().id;
    const fixed = await request('PATCH', `/api/comments/${id}`, {
      body: { status: 'fixed', note: 'Cooled the grade.' },
      headers: { Cookie: jonas, ...origin },
    });
    assert(fixed.status === 200, fixed.text);
    await fresh(`#/v/${encodeURIComponent(slug)}`);
    await page.waitForSelector('.stage-overlay');
    await settle(page);
    // checked "Looks right" by Mia, a person in the app: the server tells her own streams, and the line rides in live
    const checked = await request('PATCH', `/api/comments/${id}`, { body: { status: 'verified' }, headers: { Cookie: mia, ...origin } });
    assert(checked.status === 200, checked.text);
    await page.waitForSelector('[data-testid=loop-moment]', { timeout: 15000 });
    const line = await text('[data-testid=loop-moment]');
    for (const w of [
      'Checked: looks right',
      'That’s the loop, on your own video.',
      'for all 4 of you until',
      'After that, Team is €80 a month for the 4 of you, billed yearly.',
      'Nothing is charged before',
    ])
      assert(line.includes(w), `“${w}” in: ${line}`);
    assert(!(await page.$('[data-testid=loop-moment] .btn.primary')), 'the line keeps to the neutral button (the view’s orange is its own)');
    const keep = await page.$eval('[data-testid=loop-keep]', (a) => a.getAttribute('href'));
    assert(keep === '#/settings/billing/checkout?plan=team&interval=year&currency=eur', keep);
    // plain widths (an emulated phone reloads the page, and the line shows once)
    const fit = await layoutMatrix(page, { 'the loop’s line under the stage': null }, { widths: QA_WIDTHS, themes: ['dark'], show: async () => {} });
    assert(!fit.length, fit.join('\n'));
    await page.click('[data-testid=loop-not-now]');
    await page.waitForFunction(() => !document.querySelector('[data-testid=loop-moment]'));
    // put away once the toast's Undo has gone by (a reload sends it at once)
    await page.reload({ waitUntil: 'domcontentloaded' });
    const other = await elsewhere();
    const away = await until(async () => {
      const m = (await request('GET', '/api/moments', { headers: { Cookie: other } })).json();
      return m.hidden.loop ? m : null;
    }, 'the loop put away on the server');
    assert(Date.parse(away.hidden.loop) > Date.now() + 13 * DAY, JSON.stringify(away));
    // and shown once: it doesn't wait for anyone any more
    assert(!away.pending.some((m) => m.id === 'loop'), JSON.stringify(away));
  });

  await check('the first review link opened: its maker gets the card in the library’s corner, the video’s chip says it', async () => {
    const slug = await slugOf('pour-over-reel.mp4');
    const link = await request('POST', `/api/review/${encodeURIComponent(slug)}/shares`, {
      body: { label: 'Harbor Coffee · Hannah' },
      headers: { Cookie: mia, ...origin },
    });
    assert(link.status === 200, link.text);
    await library('trial');
    assert(!(await page.$('[data-testid=link-open-moment]')), 'nothing before the link is opened');
    // a visitor opens it (never named: the link's name says who it was for)
    const visit = await request('POST', `/api/g/${link.json().token}/visit`, { body: { visitor: 'a-visitor-of-the-link' }, headers: origin });
    assert(visit.status === 200, visit.text);
    await page.waitForSelector('[data-testid=link-open-moment]', { timeout: 15000 });
    const card = await text('[data-testid=link-open-moment]');
    for (const w of [
      'Your review link was opened',
      '“Harbor Coffee · Hannah”',
      'What people on the link see',
      'Mia Lang',
      'Northwind Studio',
      // the badge shows on every plan; a trial can't hide it (A13 CLOUD-7)
      'with a small Lampo badge',
      'A paid plan can hide it.',
      'See plans',
      'Shown once, for the first link',
    ])
      assert(card.includes(w), `“${w}” in: ${card}`);
    // the video's own link chip (when its card shows one) turns inverted while the card is up
    const chip = await page.evaluate((s) => {
      const el = document.querySelector(`.film[data-slug="${CSS.escape(s)}"] .share-state`);
      return el ? [getComputedStyle(el).backgroundColor, getComputedStyle(document.body).color] : null;
    }, slug);
    assert(!chip || chip[0] === chip[1], `the chip in the ink (${chip})`);
    const fit = await layoutMatrix(page, { 'the link’s card': null }, { widths: QA_WIDTHS, themes: ['dark'], show: async () => {} });
    assert(!fit.length, fit.join('\n'));
    await page.click('[data-testid=link-open-moment] .cv-float-f .btn.ghost');
    await page.waitForFunction(() => !document.querySelector('[data-testid=link-open-moment]'));
    await library();
    assert(!(await page.$('[data-testid=link-open-moment]')), 'shown once');
  });

  if (SHOTS)
    await check('the QA sheet: every state at six widths, both themes', async () => {
      await page.evaluate(() => localStorage.setItem('vr.lang', 'en'));
      const card = async (width) => {
        await openDrawer(width);
        await page.click(line(width));
        await page.waitForSelector('[data-testid=trial-pop]');
      };
      const menu = async () => {
        if (!(await page.$('.topbar .user-chip:not([disabled])'))) return;
        if (!(await page.$eval('.topbar .user-chip', (c) => c.getBoundingClientRect().width > 0))) return;
        await page.click('.topbar .user-chip');
        await page.waitForSelector('[role=menu]');
      };
      const menuCard = async (width) => {
        await menu();
        if (!(await page.$('[role=menu]'))) return card(width);
        await page.evaluate(() => [...document.querySelectorAll('[role=menuitem]')].find((x) => x.textContent.includes(' · ')).click());
        await page.waitForSelector('[data-testid=trial-pop]');
      };
      const banner = async () => {
        await page.waitForSelector('[data-testid=billing-banner]');
        await page.click('[data-testid=banner-more]');
        await page.waitForSelector('.cv-te-body');
      };
      const locked = async () => {
        await page.click('.topbar .add-video');
        await page.waitForSelector('[data-testid=readonly-pop]');
      };
      await sheet('1a-trial-line', 'trial', openDrawer);
      await sheet('1b-trial-card', 'trial', card);
      await sheet('1c-account-menu', 'trial', menu);
      await sheet('1c-menu-card', 'trial', menuCard);
      await sheet('6a-closed', 'soon');
      await sheet('6a-open', 'soon', banner);
      await sheet('6c-closed', 'today');
      await sheet('6c-open', 'today', banner);
      await sheet('6d-closed', 'grace', openDrawer);
      await sheet('6d-open', 'grace', banner);
      await sheet('6e-closed', 'ro');
      await sheet('6e-open', 'ro', banner);
      await sheet('6e-add-locked', 'ro', locked);
      // the one-time moments were shown above: for their shots the moments' answer is played back as it was then
      const playBack = async (pending) => {
        await page.setRequestInterception(true);
        const answer = (r) => {
          const u = new URL(r.url());
          if (u.pathname === '/api/moments' && r.method() === 'GET')
            return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ hidden: {}, pending }) });
          if (u.pathname.startsWith('/api/moments/')) return r.respond({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
          return r.continue();
        };
        page.on('request', answer);
        return async () => {
          page.off('request', answer);
          await page.setRequestInterception(false);
        };
      };
      const loopSlug = await slugOf('coast-film-60s.mp4');
      let stop = await playBack([{ id: 'loop', at: new Date().toISOString(), slug: loopSlug }]);
      await sheet('2a-loop', 'trial', () => page.waitForSelector('[data-testid=loop-moment]'), {
        hash: `#/v/${encodeURIComponent(loopSlug)}`,
        ready: '.stage-overlay',
      });
      await stop();
      stop = await playBack([{ id: 'link_open', at: new Date().toISOString(), slug: await slugOf('pour-over-reel.mp4'), link: 'Harbor Coffee · Hannah' }]);
      await sheet('2b-link-opened', 'trial', () => page.waitForSelector('[data-testid=link-open-moment]'));
      await stop();
      await page.evaluate(() => localStorage.setItem('vr.lang', 'de'));
      for (const [name, state, prepare] of [
        ['1b-trial-card-de', 'trial', card],
        ['6a-open-de', 'soon', banner],
        ['6d-open-de', 'grace', banner],
        ['6e-add-locked-de', 'ro', locked],
      ])
        await sheet(name, state, prepare, { widths: [390, 1440], themes: ['light'] });
      await page.evaluate(() => localStorage.setItem('vr.lang', 'en'));
    });

  await check('no errors on the page', async () => {
    assert(!errors.length, errors.join('\n'));
  });
} catch (e) {
  crashed(e, srv);
}
await finish(LABEL, { browser, servers: [srv], dirs: [fakeDir, media] });
