#!/usr/bin/env node
// covers: web/src/operator/Workspaces.tsx web/src/operator/api.ts web/src/settings/Profile.tsx web/src/settings/Workspace.tsx
// covers: web/src/api/account.ts web/src/library/Library.tsx web/src/ui/layers.tsx web/src/styles/operator.css web/src/styles/settings.css
// covers: server/routes/operator.ts server/routes/yourData.ts lib/deletion.ts lib/accountExport.ts
// A13 CLOUD-5 and PEOPLE-1 in the browser, on the operator's store (test/e2e/lib/operatorStore.ts): the operator suspends
// a workspace from its page (a reason first), its owner meets the banner in the library, the operator lifts it, and
// deletes another once its name is typed. In Settings an owner who works nowhere else deletes their workspace (its
// name typed; the account goes with it), a person exports their data and deletes their account (their password), and
// the last owner of a workspace others work in is told to hand it over first. Every screen and dialog at 390 and 1440
// in both themes, German too; screenshots go to VR_SHOTS.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, tmpdir } from '../lib/helpers.ts';
import { client } from '../lib/http.ts';
import { clippedText, settle, sideways } from './layout.mjs';
import { launch, requireChrome, shotsDir, signedIn } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'takedown e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const fakeDir = tmpdir('vr-e2e-takedown-fake-');
const srv = await startServer({
  prefix: 'vr-e2e-takedown-',
  mode: 'server',
  publicUrl: true,
  env: {
    VR_CLOUD_MODULE: path.join(ROOT, 'test/e2e/lib/billingModule.ts'),
    FAKE_BILLING_FILE: path.join(fakeDir, 'billing.json'),
    LAMPO_OPERATOR: 'noor@lampo.test',
  },
  seed: (env) => execFileSync(process.execPath, [path.join(ROOT, 'test/e2e/lib/operatorStore.ts')], { env, stdio: 'pipe' }),
});
const { base: BASE } = srv;
const request = client(srv.port);
const origin = { Origin: BASE };
const PASSWORD = 'a long enough password';
const cookieOf = (r) => String([r.headers['set-cookie']].flat().find((c) => String(c).startsWith('vr_session=')) || '').split(';')[0];
async function login(email) {
  const r = await request('POST', '/api/auth/login', { body: { email, password: PASSWORD }, headers: origin });
  assert(r.status === 200, `${email}: ${r.status} ${r.text}`);
  return cookieOf(r);
}

let browser;
let page;
try {
  const noor = await login('noor@lampo.test');
  const list = (await request('GET', '/api/operator/workspaces', { headers: { Cookie: noor } })).json().workspaces;
  const idOf = (name) => list.find((w) => w.name === name)?.id;
  const HARBOR = idOf('Harbor & Pine');
  const QUIET = idOf('Quietfield');
  assert(HARBOR && QUIET, 'the store has its workspaces');

  browser = await launch();
  page = await browser.newPage();
  screenshotFailures(() => page, 'takedown');
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
  const type = async (sel, words) => {
    await page.click(sel, { count: 3 });
    await page.keyboard.press('Backspace');
    await page.type(sel, words);
    await page.waitForFunction((sel, words) => document.querySelector(sel)?.value === words, {}, sel, words);
  };
  const enabled = (sel) => page.$eval(sel, (b) => !b.disabled);
  /**
   * Signed out for real: the dialog gone and the sign-in screen up. Not "a password field in a form": Settings → Profile
   * has its own (address and password), so that matched before the deletion had even been asked for.
   */
  const signedOut = () =>
    page.waitForFunction(() => !document.querySelector('[data-testid=confirm]') && !!document.querySelector('.entrance [data-testid=signin]'), {
      polling: 100,
      timeout: 15000,
    });
  const theme = (t) => page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), t);
  /**
   * The state on screen at 390 and 1440 in both themes: nothing sideways, no clipped words; a screenshot of each, with
   * `focus` (a card) scrolled into the middle. `dialog`: the alert dialog is the screen (its own box is checked too).
   */
  const problems = [];
  const look = async (name, { focus, widths = [390, 1440], themes = ['dark', 'light'] } = {}) => {
    for (const th of themes) {
      await theme(th);
      for (const width of widths) {
        await page.setViewport({ width, height: width < 600 ? 844 : 900 });
        await settle(page);
        if (focus) await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }), focus);
        await settle(page);
        for (const b of [...(await sideways(page)), ...(await clippedText(page))]) problems.push(`${name} @${width} ${th}: ${b}`);
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `takedown-${name}-${th}-${width}.png`) });
      }
    }
    await page.setViewport({ width: 1440, height: 900 });
    await theme('dark');
  };

  await check('the operator suspends a workspace: a reason first, then read-only, a banner, its people told', async () => {
    await signIn(noor);
    await fresh(`#/operator/workspaces/${HARBOR}`);
    await page.waitForSelector('[data-testid=op-takedown]', { timeout: 15000 });
    await look('op-workspace', { focus: '[data-testid=op-takedown]' });
    await page.click('[data-testid=op-suspend]');
    await page.waitForSelector('[data-testid=confirm] [data-testid=op-takedown-reason]');
    assert(await page.evaluate(() => document.activeElement?.dataset.testid === 'op-takedown-reason'), 'the reason has the focus');
    assert(!(await enabled('[data-testid=confirm-action]')), 'no reason, no suspension');
    await type('[data-testid=op-takedown-reason]', 'Abuse report 12: films that aren’t theirs');
    assert(await enabled('[data-testid=confirm-action]'));
    await look('op-suspend-dialog');
    await page.click('[data-testid=confirm-action]');
    await page.waitForSelector('[data-testid=op-suspended]', { timeout: 15000 });
    assert((await text('[data-testid=op-suspended]')).includes('Abuse report 12'), await text('[data-testid=op-suspended]'));
    assert(await page.$('[data-testid=op-suspended-badge]'), 'the page says SUSPENDED');
    await look('op-workspace-suspended', { focus: '[data-testid=op-takedown]' });
    await fresh('#/operator/workspaces');
    await page.waitForSelector(`[data-testid=op-ws-row][data-id="${HARBOR}"] .badge.danger`, { timeout: 15000 });
    await look('op-workspaces-list');
  });

  await check('its owner meets the banner in the library, and can’t write', async () => {
    const chloe = await login('chloe@harborpine.test');
    await signIn(chloe);
    await fresh('#/');
    await signedIn(page);
    await page.waitForSelector('[data-testid=suspended-banner]', { timeout: 15000 });
    assert((await text('[data-testid=suspended-banner]')).startsWith('Harbor & Pine is suspended.'), await text('[data-testid=suspended-banner]'));
    assert(!(await page.$('.cv-te')), 'no plan to choose while it is suspended');
    await look('library-suspended');
    const r = await request('PATCH', '/api/workspaces/current', { body: { name: 'Renamed' }, headers: { Cookie: chloe, ...origin } });
    assert(r.status === 423, `${r.status} ${r.text}`);
  });

  await check('the operator lifts it, then deletes another once its name is typed', async () => {
    await signIn(noor);
    await fresh(`#/operator/workspaces/${HARBOR}`);
    await page.waitForSelector('[data-testid=op-unsuspend]', { timeout: 15000 });
    await page.click('[data-testid=op-unsuspend]');
    await page.waitForSelector('[data-testid=op-suspend]', { timeout: 15000 });
    await fresh(`#/operator/workspaces/${QUIET}`);
    await page.waitForSelector('[data-testid=op-delete]', { timeout: 15000 });
    await page.click('[data-testid=op-delete]');
    await page.waitForSelector('[data-testid=confirm] [data-testid=op-delete-plan] dd');
    await page.waitForFunction(() => !document.querySelector('[data-testid=op-delete-plan] .sk'), { timeout: 15000 });
    assert(await page.evaluate(() => document.activeElement?.dataset.testid === 'op-delete-name'), 'the name has the focus');
    await type('[data-testid=op-takedown-reason]', 'Asked by its owner by email');
    await type('[data-testid=op-delete-name]', 'Quiet');
    assert(!(await enabled('[data-testid=confirm-action]')), 'half a name deletes nothing');
    await look('op-delete-dialog-typing');
    await type('[data-testid=op-delete-name]', 'Quietfield');
    assert(await enabled('[data-testid=confirm-action]'));
    await look('op-delete-dialog');
    await page.click('[data-testid=confirm-action]');
    await page.waitForFunction(() => location.hash === '#/operator/workspaces', { timeout: 15000 });
    await page.waitForSelector('[data-testid=op-ws-row]');
    assert(!(await page.$(`[data-testid=op-ws-row][data-id="${QUIET}"]`)), 'it left the list');
    const r = await request('GET', `/api/operator/workspaces/${QUIET}`, { headers: { Cookie: noor } });
    assert(r.status === 404, `${r.status}`);
  });

  await check('Settings → Profile: export my data; the last owner of a team is told to hand it over first', async () => {
    const lee = await login('lee@kestrel.test');
    await signIn(lee);
    await fresh('#/settings/profile');
    await page.waitForSelector('[data-testid=delete-blocked-list]', { timeout: 15000 });
    assert((await text('[data-testid=delete-blocked-list]')).includes('Kestrel Motion'));
    assert(!(await enabled('[data-testid=delete-account-open]')), 'blocked');
    await look('profile-blocked', { focus: '[data-testid=your-data]' });
    const downloads = [];
    page.on('response', (r) => r.url().endsWith('/api/auth/me/export') && downloads.push(r.status()));
    await page.click('[data-testid=export-data]');
    await page.waitForFunction(() => !document.querySelector('[data-testid=export-data]')?.disabled, { timeout: 15000 });
    assert(downloads[0] === 200, `the export answered ${downloads.join()}`);
  });

  await check('Settings → Profile: delete my account — what goes with it, my password, then signed out', async () => {
    const rafael = await login('rafael@atlasreels.test');
    await signIn(rafael);
    await fresh('#/settings/profile');
    await page.waitForSelector('[data-testid=delete-gowith-list]', { timeout: 15000 });
    assert((await text('[data-testid=delete-gowith-list]')).includes('Atlas Reels'));
    await look('profile-delete', { focus: '[data-testid=delete-account]' });
    const answers = [];
    page.on('response', (r) => r.url().endsWith('/api/auth/me/delete') && answers.push(r.status()));
    await page.click('[data-testid=delete-account-open]');
    await page.waitForSelector('[data-testid=confirm] [data-testid=delete-account-password]');
    assert(!(await enabled('[data-testid=confirm-action]')), 'no password, no deletion');
    await type('[data-testid=delete-account-password]', 'not my password at all');
    await page.click('[data-testid=confirm-action]');
    await page.waitForSelector('[data-testid=confirm] .set-warn', { timeout: 15000 });
    await look('profile-delete-dialog-wrong');
    await type('[data-testid=delete-account-password]', PASSWORD);
    await page.click('[data-testid=confirm-action]');
    await signedOut();
    assert(answers.join() === '403,200', `the wrong password, then the deletion: ${answers.join()}`);
    // The page signs out only once the server has answered, and the server answers once the account is gone: a sign-in
    // the moment the page says so is refused already (no waiting for it).
    const r = await request('POST', '/api/auth/login', { body: { email: 'rafael@atlasreels.test', password: PASSWORD }, headers: origin });
    assert(r.status === 401, `the account is gone: ${r.status} ${r.text}`);
  });

  await check('Settings → Workspace: its owner deletes it, its name typed; the account goes with it', async () => {
    const elif = await login('elif@larkspur.test');
    await signIn(elif);
    await fresh('#/settings/workspace');
    await page.waitForSelector('[data-testid=delete-workspace] [data-testid=delete-workspace-plan] dd', { timeout: 15000 });
    await page.waitForFunction(() => !document.querySelector('[data-testid=delete-workspace-plan] .sk'), { timeout: 15000 });
    await look('workspace-delete', { focus: '[data-testid=delete-workspace]' });
    await page.click('[data-testid=delete-workspace-open]');
    await page.waitForSelector('[data-testid=confirm] [data-testid=delete-workspace-name]');
    await type('[data-testid=delete-workspace-name]', 'Larkspur');
    assert(!(await enabled('[data-testid=confirm-action]')));
    await type('[data-testid=delete-workspace-name]', 'Larkspur Studio');
    await look('workspace-delete-dialog');
    await page.click('[data-testid=confirm-action]');
    await signedOut();
    const r = await request('GET', '/api/operator/workspaces', { headers: { Cookie: noor } });
    assert(!r.json().workspaces.some((w) => w.name === 'Larkspur Studio'), 'gone from the server');
  });

  await check('German: the takedown, the banner, the deletion cards', async () => {
    await page.evaluate(() => localStorage.setItem('vr.lang', 'de'));
    await signIn(noor);
    await fresh(`#/operator/workspaces/${HARBOR}`);
    await page.waitForSelector('[data-testid=op-takedown]', { timeout: 15000 });
    await page.click('[data-testid=op-suspend]');
    await page.waitForSelector('[data-testid=confirm] [data-testid=op-takedown-reason]');
    await type('[data-testid=op-takedown-reason]', 'Missbrauchsmeldung 12');
    await look('de-op-suspend-dialog', { themes: ['dark'] });
    await page.click('[data-testid=confirm-action]');
    await page.waitForSelector('[data-testid=op-suspended]', { timeout: 15000 });
    assert((await text('[data-testid=op-takedown] h2')) === 'Sperren oder löschen', await text('[data-testid=op-takedown] h2'));
    await look('de-op-workspace-suspended', { focus: '[data-testid=op-takedown]', themes: ['dark'] });
    const chloe = await login('chloe@harborpine.test');
    await signIn(chloe);
    await fresh('#/');
    await page.waitForSelector('[data-testid=suspended-banner]', { timeout: 15000 });
    assert((await text('[data-testid=suspended-banner]')).startsWith('Harbor & Pine ist gesperrt.'), await text('[data-testid=suspended-banner]'));
    await look('de-library-suspended', { themes: ['dark'] });
    const lee = await login('lee@kestrel.test');
    await signIn(lee);
    await fresh('#/settings/profile');
    await page.waitForSelector('[data-testid=delete-blocked-list]', { timeout: 15000 });
    await look('de-profile-blocked', { focus: '[data-testid=delete-account]', themes: ['dark'] });
    const yuki = await login('yuki@pinecone.test');
    await signIn(yuki);
    await fresh('#/settings/workspace');
    await page.waitForSelector('[data-testid=delete-workspace-plan] dd', { timeout: 15000 });
    await page.click('[data-testid=delete-workspace-open]');
    await page.waitForSelector('[data-testid=confirm] [data-testid=delete-workspace-name]');
    await type('[data-testid=delete-workspace-name]', 'Pinecone');
    await look('de-workspace-delete-dialog', { themes: ['dark'] });
    await page.keyboard.press('Escape');
  });

  await check('every screen fits (nothing sideways, no clipped words)', () => {
    assert(!problems.length, problems.join('\n'));
  });
  await check('no page errors', () => assert(!errors.length, errors.join('\n')));
} catch (e) {
  crashed(e, srv);
}
await finish(LABEL, { browser, servers: [srv], dirs: [fakeDir] });
