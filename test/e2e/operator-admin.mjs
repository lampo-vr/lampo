#!/usr/bin/env node
// covers: web/src/operator/ web/src/styles/operator.css server/routes/operator.ts lib/operator.ts web/src/auth/UserMenu.tsx
// covers: test/e2e/lib/operatorStore.ts test/e2e/lib/billingModule.ts web/src/settings/parts.tsx
// The operator's admin (#/operator/workspaces, #/operator/accounts) on a hosted server with a billing module (the
// stand-in, test/e2e/lib/billingModule.ts) and a dozen workspaces in every state a plan can be in, with long names
// (test/e2e/lib/operatorStore.ts). LAMPO_OPERATOR names Noor, an admin of the first workspace: the account menu offers
// her "Operator", and nobody else — not the first workspace's owner, not a member — is offered it or sees the pages'
// frame even for a moment; they read that there is no such page. The list searches by name or owner, filters by where a
// plan stands, orders by last activity or by when it was made; a workspace opened shows its facts and members, and its
// plan is set by hand (complimentary, the trial to a day, back to normal billing) with a reason that lands in its log.
// The accounts list shows workspaces and roles, last sign-ins, the disabled; an account is disabled (its session ends at
// once) and enabled again. Loading states hold the real layout. Every screen fits 390–1920 in both themes; German too.
// Screenshots go to VR_SHOTS.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, tmpdir } from '../lib/helpers.ts';
import { client } from '../lib/http.ts';
import { layoutMatrix, settle, WIDTHS } from './layout.mjs';
import { launch, requireChrome, shotsDir, signedIn } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'operator admin e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const fakeDir = tmpdir('vr-e2e-opadmin-fake-');
const FAKE = path.join(fakeDir, 'billing.json');
const srv = await startServer({
  prefix: 'vr-e2e-opadmin-',
  mode: 'server',
  publicUrl: true,
  env: { VR_CLOUD_MODULE: path.join(ROOT, 'test/e2e/lib/billingModule.ts'), FAKE_BILLING_FILE: FAKE, LAMPO_OPERATOR: 'noor@lampo.test' },
  seed: (env) => execFileSync(process.execPath, [path.join(ROOT, 'test/e2e/lib/operatorStore.ts')], { env, stdio: 'pipe' }),
});
const { base: BASE } = srv;
const request = client(srv.port);
const origin = { Origin: BASE };
const PASSWORD = 'a long enough password';
const cookieOf = (r, name = 'vr_session') => String([r.headers['set-cookie']].flat().find((c) => String(c).startsWith(`${name}=`)) || '').split(';')[0];
async function login(email) {
  const r = await request('POST', '/api/auth/login', { body: { email, password: PASSWORD }, headers: origin });
  assert(r.status === 200, `${email}: ${r.status} ${r.text}`);
  return cookieOf(r);
}

let browser;
let page;
try {
  const noor = await login('noor@lampo.test');
  const olivia = await login('olivia@lampo.test');
  const max = await login('max@lampo.test');

  browser = await launch();
  page = await browser.newPage();
  screenshotFailures(() => page, 'opadmin');
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
  const texts = (sel) => page.$$eval(sel, (els) => els.map((el) => el.textContent.replace(/\s+/g, ' ').trim()));
  const fresh = async (hash) => {
    await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
  };
  const go = async (hash) => {
    await page.evaluate((h) => {
      location.hash = h;
    }, hash);
  };
  const rows = (kind = 'ws') => page.$$eval(`[data-testid=op-${kind}-row]`, (els) => els.map((e) => e.querySelector('.op-c-main b').textContent.trim()));
  const clickText = (sel, words) =>
    page.evaluate(
      (sel, words) => {
        const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.replace(/\s+/g, ' ').trim().startsWith(words));
        if (!el) throw new Error(`no ${sel} reading “${words}”`);
        el.click();
      },
      sel,
      words,
    );
  /** Types into a field in place of what it holds, and waits until the field holds it. */
  const type = async (sel, words) => {
    await page.click(sel, { count: 3 });
    await page.keyboard.press('Backspace');
    await page.type(sel, words);
    await page.waitForFunction((sel, words) => document.querySelector(sel)?.value === words, {}, sel, words);
  };
  /** Opens the account menu and says what it offers. */
  const menu = async () => {
    await signedIn(page);
    await page.click('.topbar .user-chip');
    await page.waitForSelector('.menu [role^=menuitem]');
    const items = await texts('.menu [role^=menuitem]');
    return items;
  };
  // Whether the operator pages' frame (its tabs) or a menu item named Operator ever showed in this page, from its start
  await page.evaluateOnNewDocument(() => {
    window.__opSeen = [];
    new MutationObserver(() => {
      if (document.querySelector('[data-testid^=op-tab-]')) window.__opSeen.push('frame');
      for (const m of document.querySelectorAll('.menu [role^=menuitem]')) if (/^(Operator|Betrieb)$/.test(m.textContent.trim())) window.__opSeen.push('menu');
    }).observe(document, { subtree: true, childList: true });
  });

  await check('the account menu offers “Operator” to the operator, and leads to the workspaces', async () => {
    await signIn(noor);
    await fresh('#/');
    const items = await menu();
    assert(items.includes('Operator'), items.join(' | '));
    await clickText('.menu [role^=menuitem]', 'Operator');
    await page.waitForSelector('[data-testid=op-workspaces] [data-testid=op-ws-row]', { timeout: 15000 });
    assert((await page.evaluate(() => location.hash)) === '#/operator/workspaces');
    assert((await texts('[data-testid^=op-tab-]')).join() === 'Funnel,Workspaces,Accounts', 'the tab line');
    assert((await text('.op-who')).includes('Only you see this'));
  });

  await check('the first workspace’s owner not on LAMPO_OPERATOR, and a member: no item, never the frame, no page', async () => {
    for (const [who, cookie] of [
      ['owner of #1', olivia],
      ['member', max],
    ]) {
      await signIn(cookie);
      await fresh('#/');
      const items = await menu();
      assert(!items.some((i) => i.startsWith('Operator')), `${who}: ${items.join(' | ')}`);
      assert(
        items.some((i) => i.startsWith('Settings')),
        `${who}: the menu is there (${items.join(' | ')})`,
      );
      await page.keyboard.press('Escape');
      assert(!(await page.evaluate(() => window.__opSeen)).length, `${who}: the menu showed Operator`);
      for (const hash of ['#/operator/workspaces', '#/operator/accounts', '#/operator/funnel', `#/operator/workspaces/w1`]) {
        await fresh(hash);
        await page.waitForSelector('[data-testid=op-missing]', { timeout: 15000 });
        assert(/There’s no page here/.test(await text('[data-testid=op-missing]')), `${who} ${hash}`);
        const seen = await page.evaluate(() => window.__opSeen);
        assert(!seen.length, `${who} ${hash}: saw ${seen.join(', ')}`);
      }
      if (SHOTS && who === 'owner of #1') await page.screenshot({ path: path.join(SHOTS, 'opadmin-refused-owner.png') });
    }
    // and the server says the same to them
    for (const c of [olivia, max]) assert((await request('GET', '/api/operator/workspaces', { headers: { Cookie: c } })).status === 404);
  });

  await signIn(noor);
  await check('the list: every workspace, its owner, plan and state, members, storage, videos, last activity', async () => {
    await fresh('#/operator/workspaces');
    await page.waitForSelector('[data-testid=op-ws-row]', { timeout: 15000 });
    const names = await rows();
    assert(names.length === 13, `${names.length} rows: ${names.join(' | ')}`);
    // last active first: Ferngrove (12 min), Brightwater (1 h), Kestrel (2 h); nothing yet last
    assert(names[0]?.startsWith('Ferngrove') && names[1]?.startsWith('Brightwater') && names[2] === 'Kestrel Motion', names.slice(0, 3).join(' | '));
    const plan = (name) =>
      page.$$eval(
        '[data-testid=op-ws-row]',
        (els, name) =>
          els
            .find((e) => e.querySelector('.op-c-main b').textContent.trim() === name)
            ?.querySelector('.op-c-plan')
            ?.textContent.replace(/\s+/g, ' ')
            .trim(),
        name,
      );
    // (the dot between a plan and its state is the badge's own drawing, not its text)
    assert(/^Team ?trial to /.test(await plan('Kestrel Motion')), await plan('Kestrel Motion'));
    assert(/^Team ?grace to /.test(await plan('Tidewater Films')), await plan('Tidewater Films'));
    assert(/^Free ?read-only$/.test(await plan('Pinecone Animation')), await plan('Pinecone Animation'));
    assert(/^Team ?complimentary$/.test(await plan('Mosaic Edit House')), await plan('Mosaic Edit House'));
    assert((await plan('Atlas Reels')) === 'Solo', await plan('Atlas Reels'));
    assert(/^Business ?complimentary$/.test(await plan('Lampo')), await plan('Lampo'));
    const ferngrove = await page.$eval('[data-testid=op-ws-row]', (e) => e.textContent.replace(/\s+/g, ' '));
    assert(/2[.,]4 TB of 8 TB/.test(ferngrove), ferngrove);
    assert(/ana\.beatriz\.ribeiro-vasconcelos@/.test(ferngrove), 'the owner’s address');
    const chips = await texts('.op-chips .seg button');
    assert(chips.join(' | ') === 'All13 | Trial3 | Paid3 | Free2 | Grace or read-only3 | Complimentary2', chips.join(' | '));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'opadmin-workspaces-dark-1440-loaded.png') });
  });

  await check('searched by name or owner, filtered by where the plan stands, ordered by when it was made', async () => {
    await fresh('#/operator/workspaces');
    await page.waitForSelector('[data-testid=op-ws-row]', { timeout: 15000 });
    await type('.op-search input', 'ferngrove');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=op-ws-row]').length === 1);
    await type('.op-search input', 'samuel@tidewater');
    await page.waitForFunction(() => document.querySelector('[data-testid=op-ws-row] b')?.textContent === 'Tidewater Films');
    await type('.op-search input', 'nothing like this');
    await page.waitForSelector('[data-testid=op-ws-none]');
    assert(/No workspace matches/.test(await text('[data-testid=op-ws-none]')));
    await clickText('[data-testid=op-ws-none] button', 'Clear the search');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=op-ws-row]').length === 13);
    assert((await page.evaluate(() => document.activeElement?.closest('.op-search') !== null)) === true, 'the search has the focus again');
    await clickText('.op-chips .seg button', 'Trial');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=op-ws-row]').length === 3);
    const trials = (await rows()).sort().join(' | ');
    assert(trials === 'Harbor & Pine | Kestrel Motion | Solstice Documentary Unit', trials);
    await clickText('.op-chips .seg button', 'All');
    await clickText('.op-sort button', 'Newest');
    await page.waitForFunction(() => document.querySelector('[data-testid=op-ws-row] b')?.textContent === 'Quietfield');
    assert((await rows()).at(-1) === 'Lampo', 'the oldest last');
    await clickText('.op-sort button', 'Last active');
    // "/" focuses the search from anywhere on the page
    await page.click('.set-head h1');
    await page.keyboard.press('/');
    assert(await page.evaluate(() => document.activeElement?.closest('.op-search') !== null), '/ focuses the search');
  });

  await check('a workspace opened: its facts and members; complimentary by hand with a reason, logged; a trial to a day; normal again', async () => {
    await go('#/operator/workspaces');
    await page.waitForSelector('[data-testid=op-ws-row]');
    await page.evaluate(() => [...document.querySelectorAll('[data-testid=op-ws-row]')].find((e) => e.textContent.includes('Larkspur Studio')).click());
    await page.waitForSelector('[data-testid=op-workspace]');
    await page.waitForSelector('[data-testid=op-member]');
    assert((await text('[data-testid=op-workspace] h1')).endsWith('Larkspur Studio'));
    assert(/Owned by Elif Demir · created /.test(await text('[data-testid=op-workspace] p')), await text('[data-testid=op-workspace] p'));
    const facts = await text('[data-testid=op-facts]');
    assert(
      /Owner\s*Elif Demir · elif@larkspur\.test/.test(facts) && /Members\s*1/.test(facts) && /Videos\s*2/.test(facts) && /4[.,]2 GB of 10 GB/.test(facts),
      facts,
    );
    assert((await texts('[data-testid=op-member]')).length === 1);
    assert(/Free/.test(await text('[data-testid=op-plan-card] [data-testid=op-plan]')));
    assert(!(await page.$('[data-testid=op-log]')), 'no log before anything was set by hand');
    // complimentary on Team, with why
    await page.waitForSelector('[data-testid=op-plan-submit]');
    assert(await page.$eval('[data-testid=op-plan-submit]', (b) => b.disabled), 'no reason, no change');
    await type('[data-testid=op-reason]', 'Pilot for a partner agency, agreed on the phone');
    await page.click('[data-testid=op-plan-submit]');
    await page.waitForSelector('[data-testid=op-override]');
    assert(/Set by hand by Noor Haddad on .*: “Pilot for a partner agency, agreed on the phone”/.test(await text('[data-testid=op-override]')));
    assert(/Team ?complimentary/.test(await text('[data-testid=op-plan-card] [data-testid=op-plan]')));
    let log = await texts('[data-testid=op-log-row]');
    assert(log.length === 1 && /^Complimentary on Team/.test(log[0]) && /Noor Haddad · noor@lampo\.test/.test(log[0]), log.join(' | '));
    // the trial to a day: a fortnight on
    await clickText('[data-testid=op-plan-card] .seg button', 'Trial to a day');
    await clickText('.op-day-presets button', '+14 days');
    assert(/Runs through .* \(in 14 days\)/.test(await text('.op-day-readout')), await text('.op-day-readout'));
    await type('[data-testid=op-reason]', 'Two more weeks for their festival cut');
    await page.click('[data-testid=op-plan-submit]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=op-log-row]').length === 2);
    assert(/Team ?trial to /.test(await text('[data-testid=op-plan-card] [data-testid=op-plan]')));
    // back to normal billing
    await clickText('[data-testid=op-plan-card] .seg button', 'Normal billing');
    await type('[data-testid=op-reason]', 'Agency signed for Solo themselves');
    await page.click('[data-testid=op-plan-submit]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=op-log-row]').length === 3);
    log = await texts('[data-testid=op-log-row]');
    assert(/^Back to normal billing/.test(log[0]) && /^Trial to /.test(log[1]) && /^Complimentary on Team/.test(log[2]), log.join(' | '));
    assert(!(await page.$('[data-testid=op-override]')), 'nothing set by hand any more');
    const kept = JSON.parse(fs.readFileSync(FAKE, 'utf8'));
    const larkspur = Object.entries(kept.oplog).find(([, l]) => l.some((e) => e.reason.startsWith('Pilot for a partner')))?.[1];
    assert(larkspur?.length === 3 && larkspur[0].by.name === 'Noor Haddad', JSON.stringify(larkspur));
    // the list follows
    await page.click('.op-crumb a');
    await page.waitForSelector('[data-testid=op-ws-row]');
    const row = await page.$$eval('[data-testid=op-ws-row]', (els) =>
      els
        .find((e) => e.textContent.includes('Larkspur Studio'))
        ?.querySelector('.op-c-plan')
        .textContent.trim(),
    );
    assert(row === 'Free', row);
  });

  await check('what the page can’t change says why: the server’s own workspace, one that pays', async () => {
    await go('#/operator/workspaces/w1');
    await page.waitForSelector('[data-testid=op-plan-fixed]');
    assert(/server’s own workspace/.test(await text('[data-testid=op-plan-fixed]')));
    const atlas = (await request('GET', '/api/operator/workspaces', { headers: { Cookie: noor } })).json().workspaces.find((w) => w.name === 'Atlas Reels');
    await go(`#/operator/workspaces/${atlas.id}`);
    await page.waitForSelector('[data-testid=op-plan-paying]');
    assert(/It pays for Solo/.test(await text('[data-testid=op-plan-paying]')));
    await go('#/operator/workspaces/w_000000000000');
    await page.waitForSelector('[data-testid=op-ws-missing]');
  });

  let mia = '';
  await check('accounts: workspaces and roles, last sign-in, disabled, waiting, in none — searched; one opened', async () => {
    await go('#/operator/accounts');
    await page.waitForSelector('[data-testid=op-acc-row]', { timeout: 15000 });
    // each row as its name and what follows it (the avatar's initials left out)
    const all = await page.$$eval('[data-testid=op-acc-row]', (els) =>
      els.map((e) => [
        e.querySelector('.op-c-main b').textContent.trim(),
        [...e.querySelectorAll('.op-c-main, .op-c-spaces')]
          .map((c) => c.textContent)
          .join(' ')
          .replace(/\s+/g, ' '),
      ]),
    );
    const row = (name) => all.find(([n]) => n === name)?.[1] ?? '';
    assert(all.length >= 40, `${all.length} accounts`);
    assert(/YOU/.test(row('Noor Haddad')) && /OPERATOR/.test(row('Noor Haddad')), row('Noor Haddad'));
    assert(!/OPERATOR/.test(row('Olivia Hart')), 'the owner of #1 runs nothing here');
    assert(/DISABLED/.test(row('Clara Novak')), row('Clara Novak'));
    assert(/UNCONFIRMED/.test(row('Wren Calloway')), row('Wren Calloway'));
    assert(/in no workspace/.test(row('Orla Byrne')), row('Orla Byrne'));
    assert(/Kestrel Motion ?· Member ?\+ 1 more/.test(row('Mia Stone')), row('Mia Stone'));
    await clickText('.op-chips .seg button', 'Disabled');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=op-acc-row]').length === 1);
    await clickText('.op-chips .seg button', 'All');
    await type('.op-search input', 'mia@kestrel');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=op-acc-row]').length === 1);
    await page.click('[data-testid=op-acc-row]');
    await page.waitForSelector('[data-testid=op-account]');
    await page.waitForSelector('[data-testid=op-acc-ws]');
    assert((await text('[data-testid=op-account] h1')).endsWith('Mia Stone'));
    const spaces = await texts('[data-testid=op-acc-ws]');
    assert(spaces.length === 2 && spaces.some((s) => /Ferngrove.*REVIEWER/.test(s)), spaces.join(' | '));
    mia = await page.evaluate(() => location.hash.split('/').pop());
    await type('.op-search input', '').catch(() => {});
  });

  await check('disable signs the account out at once; enable lets it in again — never one’s own', async () => {
    const miaSession = await login('mia@kestrel.test');
    assert((await request('GET', '/api/auth/me', { headers: { Cookie: miaSession } })).status === 200);
    await go(`#/operator/accounts/${mia}`);
    await page.waitForSelector('[data-testid=op-disable]');
    await page.click('[data-testid=op-disable]');
    await page.waitForSelector('[data-testid=confirm-action]');
    await page.click('[data-testid=confirm-action]');
    await page.waitForSelector('[data-testid=op-enable]');
    assert(/DISABLED/.test(await text('[data-testid=op-account] p')));
    assert((await request('GET', '/api/auth/me', { headers: { Cookie: miaSession } })).status === 401, 'her session ended');
    assert((await request('POST', '/api/auth/login', { body: { email: 'mia@kestrel.test', password: PASSWORD }, headers: origin })).status === 401);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'opadmin-account-disabled-dark-1440.png') });
    await page.click('[data-testid=op-enable]');
    await page.waitForSelector('[data-testid=op-disable]');
    await login('mia@kestrel.test');
    const me = (await request('GET', '/api/operator/accounts', { headers: { Cookie: noor } })).json().accounts.find((a) => a.you);
    await go(`#/operator/accounts/${me.id}`);
    await page.waitForSelector('[data-testid=op-access]');
    assert(!(await page.$('[data-testid=op-disable]')), 'no Disable on one’s own account');
    assert(/your own account/.test(await text('[data-testid=op-access]')));
  });

  await check('loading states hold the real layout: the toolbar, the columns and rows in place before the list arrives', async () => {
    let release;
    const held = new Promise((r) => {
      release = r;
    });
    await page.setRequestInterception(true);
    const hold = async (req) => {
      if (req.url().endsWith('/api/operator/workspaces')) await held;
      req.continue().catch(() => {});
    };
    page.on('request', hold);
    try {
      await fresh('#/operator/workspaces');
      await page.waitForSelector('.sk-region .op-row.op-head');
      // where the columns stand in the page's column (its entrance moves the whole column, not the rows within it)
      const at = () => page.$eval('.op-head', (e) => e.getBoundingClientRect().top - e.closest('.set-inner').getBoundingClientRect().top);
      const before = await at();
      const pending = await page.$$eval('.sk-region .op-row', (els) => els.length);
      assert(pending >= 8, `${pending} rows waiting`);
      release();
      await page.waitForSelector('[data-testid=op-ws-row]');
      const after = await at();
      assert(before === after, `the columns moved ${before} → ${after}`);
    } finally {
      page.off('request', hold);
      await page.setRequestInterception(false);
    }
  });

  // Every screen at 390–1920 in both themes, a screenshot of each when VR_SHOTS is set (the page's own column scrolls).
  const SCREENS = {
    workspaces: '#/operator/workspaces',
    workspace: null,
    accounts: '#/operator/accounts',
    account: null,
  };
  await check('every screen fits 390–1920 in both themes', async () => {
    const list = (await request('GET', '/api/operator/workspaces', { headers: { Cookie: noor } })).json().workspaces;
    SCREENS.workspace = `#/operator/workspaces/${list.find((w) => w.name.startsWith('Ferngrove')).id}`;
    SCREENS.account = `#/operator/accounts/${mia}`;
    const problems = [];
    for (const [name, hash] of Object.entries(SCREENS)) {
      await fresh(hash);
      await page.waitForSelector(name.endsWith('s') ? '[data-testid$=-row]' : '[data-testid=op-facts]', { timeout: 15000 });
      await settle(page);
      problems.push(
        ...(await layoutMatrix(
          page,
          { [name]: null },
          {
            widths: WIDTHS,
            show: (p, theme) => p.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme),
            each: async (width, theme) => {
              if (!SHOTS) return;
              await page.evaluate(() => document.querySelector('.set-main')?.scrollTo(0, 0));
              await page.screenshot({ path: path.join(SHOTS, `opadmin-${name}-${theme}-${width}.png`) });
            },
          },
        )),
      );
    }
    assert(!problems.length, problems.join('\n'));
  });

  await check('German', async () => {
    await page.evaluate(() => localStorage.setItem('vr.lang', 'de'));
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    for (const [name, hash] of Object.entries(SCREENS)) {
      await fresh(hash);
      await page.waitForSelector(name.endsWith('s') ? '[data-testid$=-row]' : '[data-testid=op-facts]', { timeout: 15000 });
      await settle(page);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `opadmin-${name}-de-dark-1440.png`) });
    }
    await fresh('#/operator/workspaces');
    await page.waitForSelector('[data-testid=op-ws-row]');
    assert(/Jeder Workspace auf diesem Server/.test(await text('.set-head p')), await text('.set-head p'));
    assert((await texts('[data-testid^=op-tab-]')).join() === 'Funnel,Workspaces,Konten');
    assert((await texts('.op-chips .seg button')).some((c) => c.startsWith('Kostenlos gestellt')));
    await page.evaluate(() => localStorage.removeItem('vr.lang'));
  });

  await check('no console errors', async () => {
    assert(!errors.length, errors.join('\n'));
  });
} catch (e) {
  crashed(e, srv);
}
await finish(LABEL, { browser, servers: [srv], dirs: [fakeDir] });
