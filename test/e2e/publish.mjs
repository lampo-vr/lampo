#!/usr/bin/env node
// covers: web/src/publish/ web/src/settings/Publishing.tsx web/src/styles/publish.css server/routes/publish.ts
// covers: lib/publish/
// Browser end-to-end test of publishing: Settings → Publishing (a YouTube connection through Google's sign-in with the
// person's own client, Instagram and Facebook through a Zernio key), then a final video's "Publish…": the composer per
// platform, the questions nobody answers for you, the confirmation naming platform and account, the post's way out
// (posted with its link; kept private by an unaudited Google project, with YouTube Studio to make it public; refused by
// Instagram, in the inbox with the reason and Try again), the publish kit, a phone's sheet and German.
// A real server (local mode, temp store, free port) against the fake platforms (test/lib/fakePlatforms.ts): nothing
// reaches Google, YouTube or Zernio. Screenshots of the composer and Settings → Publishing land in VR_SHOTS when set.
import path from 'node:path';
import { startFakePlatforms } from '../lib/fakePlatforms.ts';
import { age, makeVideo, sleep } from '../lib/helpers.ts';
import { bentEdges, clippedText, cutLabels, grainOnScrollers, sideways } from './layout.mjs';
import { launch, requireChrome, shotsDir, signedIn } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'publish e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const fakes = await startFakePlatforms();
const srv = await startServer({ prefix: 'vr-publish-e2e-', user: 'Sam', env: fakes.env });
const { dir, base: BASE } = srv;

const api = async (p, method = 'GET', body) => {
  const r = await fetch(BASE + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const out = await r.json();
  if (!r.ok) throw new Error(`${p}: ${out.error}`);
  return out;
};
const until = async (fn, what, ms = 20000) => {
  for (let t = Date.now(); Date.now() - t < ms; await sleep(100)) if (await fn()) return;
  throw new Error(`timed out: ${what}`);
};
const enc = encodeURIComponent;

// Tap areas under 44 × 44 px within `scope` (as test/e2e/quality.mjs measures them: the box plus an invisible
// ::before/::after laid over it, the way mobile.css widens compact controls). Runs in the page.
function tapAreas(scope) {
  const area = (el) => {
    const r = el.getBoundingClientRect();
    let [l, t, rt, b] = [r.left, r.top, r.right, r.bottom];
    for (const p of ['::before', '::after']) {
      const s = getComputedStyle(el, p);
      if (s.content === 'none' || s.position !== 'absolute' || s.pointerEvents === 'none') continue;
      const px = (v, size) => (v.endsWith('px') ? parseFloat(v) : v.endsWith('%') ? (parseFloat(v) / 100) * size : 0);
      l = Math.min(l, r.left + px(s.left, r.width));
      t = Math.min(t, r.top + px(s.top, r.height));
      rt = Math.max(rt, r.right - px(s.right, r.width));
      b = Math.max(b, r.bottom - px(s.bottom, r.height));
    }
    return { w: rt - l, h: b - t };
  };
  const hidden = (el) => {
    for (let p = el; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return true;
    }
    return false;
  };
  const out = [];
  const root = document.querySelector(scope) ?? document.body;
  for (const el of root.querySelectorAll(
    'button, a[href], [role=button], [role=tab], [role=radio], [role=switch], select, input:not([type=hidden]), textarea, summary',
  )) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || hidden(el)) continue;
    if (getComputedStyle(el).display === 'inline') continue;
    const a = area(el);
    if (Math.round(a.w) < 44 || Math.round(a.h) < 44)
      out.push(
        `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30)}" ${Math.round(a.w)}×${Math.round(a.h)}`,
      );
  }
  return out;
}

/** A vertical clip, linked, approved and final: what a post goes out from. */
async function finalVideo(name, pattern) {
  const file = makeVideo(path.join(dir, `Studio/export/${name}.mp4`), { w: 180, h: 320, fps: 30, dur: 4, pattern });
  age(file);
  const { video } = await api('/api/library', 'POST', { path: file });
  await api(`/api/review/${enc(video.slug)}/approval`, 'PUT', { status: 'approved', v: 1 });
  await api(`/api/review/${enc(video.slug)}/final`, 'PUT', { v: 1 });
  return video.slug;
}

let browser;
let page;
try {
  const spot = await finalVideo('spot', 'testsrc2');
  const teaser = await finalVideo('teaser', 'rgbtestsrc');
  const promo = await finalVideo('promo', 'smptebars');

  browser = await launch();
  page = await browser.newPage();
  screenshotFailures(() => page, 'publish');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1440, height: 900 });

  const text = (sel) => page.$eval(sel, (e) => e.textContent.trim());
  const openComposer = async (slug, focus = '1') => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${enc(slug)}?publish=${enc(focus)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=publish]', { timeout: 20000 });
    // the posts are read: the panel shows a post, or the way to start one
    await page.waitForSelector('[data-testid=publish] :is([data-testid=pub-start], [data-testid^=pub-form-], [data-testid=pub-status])', { timeout: 20000 });
    // and in place: on a phone the sheet comes up from below the screen, and before its first frame (reduced motion
    // ends it at once, but on that frame) a tap on it lands under the screen's edge ("not clickable")
    await settled();
  };
  /** Picks option `i` (0-based) of a segmented choice in the composer. */
  const choose = async (testid, i) => {
    await page.waitForSelector(`[data-testid=${testid}] [role=radio]`);
    await page.$$eval(`[data-testid=${testid}] [role=radio]`, (els, i) => els[i].click(), i);
    await page.waitForFunction(
      (testid, i) => document.querySelectorAll(`[data-testid=${testid}] [role=radio]`)[i]?.getAttribute('data-state') === 'on',
      {},
      testid,
      i,
    );
  };
  const chosen = (testid) => page.$$eval(`[data-testid=${testid}] [role=radio]`, (els) => els.filter((e) => e.getAttribute('data-state') === 'on').length);
  const publishable = () =>
    page.waitForFunction(() => document.querySelector('[data-testid=pub-publish]') && !document.querySelector('[data-testid=pub-publish]').disabled, {
      timeout: 15000,
    });
  /** Publish → the confirmation (its words returned) → Publish. */
  const confirmPublish = async () => {
    await publishable();
    await page.click('[data-testid=pub-publish]');
    await page.waitForSelector('[data-testid=confirm] [data-testid=pub-confirm]');
    const said = await text('[data-testid=confirm]');
    await page.click('[data-testid=confirm-action]');
    await page.waitForSelector('[data-testid=confirm]', { hidden: true });
    return said;
  };
  /** Replaces what a text field holds (a draft may start with words in it: the title is the video's name). */
  const retype = async (sel, value) => {
    await page.click(sel, { count: 3 });
    await page.keyboard.press('Backspace');
    await page.type(sel, value);
  };
  /** Waits until the page is still: fonts in, every animation (the sheet coming up, a dialog opening) finished. */
  const settled = () =>
    page.evaluate(async () => {
      await document.fonts.ready;
      // (a loader's endless spin never finishes: only the ones that end)
      const ending = document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity);
      await Promise.all(ending.map((a) => a.finished.catch(() => {})));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
  const statusOf = () => page.$eval('[data-testid=pub-status]', (e) => e.getAttribute('data-state')).catch(() => null);

  await check('Settings → Publishing: a YouTube client, the Google sign-in, back with a word and the channel; the secret never comes back', async () => {
    await page.goto(`${BASE}/#/settings/publishing`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=pubset-add-youtube]', { timeout: 20000 });
    await page.click('[data-testid=pubset-add-youtube]');
    await page.waitForSelector('[data-testid=pubset-youtube-form]');
    const redirect = await text('[data-testid=pubset-redirect]');
    assert(redirect.includes(`${BASE}/api/publish/oauth/callback`), `the redirect URI to give Google: ${redirect}`);
    await page.type('[data-testid=pubset-youtube-form] input:not([data-testid])', 'Studio channel');
    await page.type('[data-testid=pubset-client-id]', fakes.clientId);
    await page.type('[data-testid=pubset-client-secret]', fakes.clientSecret);
    // to Google and back: the fake signs in at once and sends the browser to Lampo's callback
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }), page.click('[data-testid=pubset-youtube-add]')]);
    await page.waitForSelector('[data-testid=pubset-return]', { timeout: 20000 });
    assert((await text('[data-testid=pubset-return]')).includes('Connected: Studio channel'), `the return said: ${await text('[data-testid=pubset-return]')}`);
    await page.waitForSelector('[data-testid=pubset-row][data-kind=youtube][data-state=ready]');
    const row = await text('[data-testid=pubset-row][data-kind=youtube]');
    assert(row.includes('Studio Channel'), `the row names the channel: ${row}`);
    assert(await page.$('[data-testid=pubset-row][data-kind=youtube] [data-testid=pubset-locked]'), 'an unaudited project says uploads stay private');
    assert((await page.evaluate(() => location.hash)) === '#/settings/publishing', 'the address keeps nothing of the return');
    const html = await page.content();
    const listed = JSON.stringify(await api('/api/publish/connections'));
    assert(!html.includes(fakes.clientSecret) && !listed.includes(fakes.clientSecret), 'the client secret never comes back');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'flow-settings-youtube.png'), fullPage: true });
  });

  await check('Instagram and Facebook through a Zernio key: its accounts arrive; this machine must be awake for them', async () => {
    await page.click('[data-testid=pubset-add-zernio]');
    await page.waitForSelector('[data-testid=pubset-api-key]');
    await page.type('[data-testid=pubset-api-key]', fakes.apiKey);
    await page.click('[data-testid=pubset-zernio-add]');
    await page.waitForSelector('[data-testid=pubset-row][data-kind=zernio][data-state=ready]', { timeout: 15000 });
    const row = await text('[data-testid=pubset-row][data-kind=zernio]');
    assert(row.includes('Studio Reels') && row.includes('Studio Page'), `the row names the accounts: ${row}`);
    assert(!row.includes(fakes.apiKey), 'the key never comes back');
    const body = await text('body');
    assert(body.includes('this machine must be awake'), 'on a machine, Instagram and Facebook need it awake at their time');
  });

  let ytPost = '';
  await check('Final → Publish… → YouTube: nothing preselected, the confirmation names the channel, posted with its link', async () => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${enc(spot)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=stage-next]', { timeout: 20000 });
    assert((await text('[data-testid=stage-next]')).includes('Publish'), `the next step after Final: ${await text('[data-testid=stage-next]')}`);
    await page.click('[data-testid=stage-next]');
    await page.waitForSelector('[data-testid=pub-start-button]', { timeout: 20000 });
    await page.click('[data-testid=pub-start-button]');
    await page.waitForSelector('[data-testid=pub-form-youtube]');
    ytPost = await page.$eval('[data-testid=pub-form-youtube]', (e) => e.getAttribute('data-post'));
    assert((await chosen('pub-ai')) === 0 && (await chosen('pub-kids')) === 0, 'the AI and made-for-kids answers start unanswered');
    assert(await page.$eval('[data-testid=pub-publish]', (e) => e.disabled), 'Publish waits for the answers and a title');
    assert(await page.$('[data-testid=pub-needs]'), 'what is missing is counted');
    await retype('[data-testid=pub-title]', 'Spring launch');
    await retype('[data-testid=pub-description]', 'The new spot.');
    await choose('pub-ai', 1);
    await choose('pub-kids', 1);
    const said = await confirmPublish();
    assert(said.includes('YouTube') && said.includes('Studio Channel'), `the confirmation names platform and channel: ${said}`);
    assert(said.includes('private until your Google project passes'), `an unaudited project's upload is said to stay private: ${said}`);
    await until(async () => (await statusOf()) === 'posted', 'the YouTube post is out', 45000);
    const href = await page.$eval('[data-testid=pub-url]', (e) => e.href);
    const [video] = [...fakes.videos.values()];
    assert(video && href.includes(video.id), `the link goes to the video (${href})`);
    assert(video.meta.snippet?.title === 'Spring launch', `the title went: ${JSON.stringify(video.meta.snippet)}`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid=publish]', { hidden: true });
    await page.waitForFunction(() => document.querySelector('[data-testid=stage-published]')?.textContent.includes('YouTube'), { timeout: 15000 });
  });

  await check('the publish kit: made on demand, its files listed, the ZIP downloads', async () => {
    await openComposer(spot, ytPost);
    await page.waitForSelector('[data-testid=pub-kit-make]');
    await page.click('[data-testid=pub-kit-make]');
    await page.waitForSelector('[data-testid=pub-kit][data-state=ready]', { timeout: 120000 });
    const kinds = await page.$$eval('[data-testid=pub-kit] a[data-testid^=pub-kit-]', (els) => els.map((e) => e.dataset.testid.replace('pub-kit-', '')));
    for (const k of ['video', 'cover', 'copy', 'zip']) assert(kinds.includes(k), `the kit has its ${k}: ${kinds}`);
    const href = await page.$eval('[data-testid=pub-kit-zip]', (e) => e.getAttribute('href'));
    const r = await fetch(BASE + href);
    const zip = Buffer.from(await r.arrayBuffer());
    assert(r.ok && zip.length > 1000 && zip.subarray(0, 2).toString() === 'PK', `kit.zip: ${r.status}, ${zip.length} bytes`);
    console.log(`      kit.zip ${zip.length} bytes`);
    // closing forgets the address's ?publish=, so the same link opens the composer again (no reload)
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid=publish]', { hidden: true });
    assert(!page.url().includes('publish='), `closed, the address no longer asks for it: ${page.url()}`);
    await page.evaluate(
      (h) => {
        location.hash = h;
      },
      `#/v/${enc(spot)}?publish=${enc(ytPost)}`,
    );
    await page.waitForSelector('[data-testid=publish]', { timeout: 10000 });
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid=publish]', { hidden: true });
  });

  await check('an unaudited Google project: YouTube keeps the upload private, the post says so and links to YouTube Studio', async () => {
    fakes.knobs.lockPrivate = true;
    await openComposer(teaser);
    await page.waitForSelector('[data-testid=pub-start-button]');
    await page.click('[data-testid=pub-start-button]');
    await page.waitForSelector('[data-testid=pub-form-youtube]');
    await retype('[data-testid=pub-title]', 'Teaser');
    await choose('pub-visibility', 0);
    await choose('pub-ai', 1);
    await choose('pub-kids', 1);
    await confirmPublish();
    await until(async () => (await statusOf()) === 'posted', 'the YouTube post is out', 45000);
    await page.waitForSelector('[data-testid=pub-locked]', { timeout: 15000 });
    const studio = await page.$eval('[data-testid=pub-studio]', (e) => e.href);
    assert(studio.startsWith('https://studio.youtube.com/'), `YouTube Studio is linked: ${studio}`);
    assert((await text('[data-testid=pub-locked]')).includes('private'), 'it says why it is private');
    fakes.knobs.lockPrivate = false;
  });

  await check(
    'Instagram refuses a post it holds: the reason in the composer and the inbox, Check again asks, Post again (asked first) sends it once more',
    async () => {
      fakes.knobs.postFails = 'Instagram says: the video is too short';
      await openComposer(spot);
      await page.click('[data-testid=pub-tab-instagram]');
      await page.waitForSelector('[data-testid=pub-form-instagram]', { timeout: 15000 });
      const igPost = await page.$eval('[data-testid=pub-form-instagram]', (e) => e.getAttribute('data-post'));
      assert(!(await page.$('[data-testid=pub-form-instagram] [data-testid=pub-title]')), 'Instagram has no title');
      await retype('[data-testid=pub-description]', 'Out now #launch');
      await choose('pub-ai', 1);
      const said = await confirmPublish();
      assert(said.includes('Instagram') && said.includes('Studio Reels'), `the confirmation names Instagram and the account: ${said}`);
      assert(!said.includes('again'), `a first publish isn't asked as a second one: ${said}`);
      // a failed post opens as its form again (change it and publish, or ask the platform again as it is)
      await page.waitForSelector('[data-testid=pub-form-instagram] [data-testid=pub-state][data-state=failed]', { timeout: 45000 });
      assert((await text('[data-testid=pub-state]')).includes('the video is too short'), 'the composer says why');
      // the platform holds the post it refused (it has its id): Retry asks it again, it never sends it a second time (A12 PUB-1)
      const way = await page.$eval('[data-testid=pub-state] [data-testid=pub-retry]', (e) => [e.dataset.way, e.textContent.trim()]);
      assert(way[0] === 'check' && way[1] === 'Check again', `a post the platform holds is checked again, not sent: ${way}`);
      assert(!(await page.$('[data-testid=pub-delete]')), 'and is never deleted (A12 PUB-6)');
      assert(!(await page.$eval('[data-testid=pub-publish]', (e) => e.disabled)), 'publishing it again stays possible');
      await page.keyboard.press('Escape');

      await page.goto('about:blank');
      await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
      await signedIn(page);
      await page.waitForSelector('[data-testid="inbox-bell"][aria-label^="Inbox, "]', { timeout: 20000 });
      await page.click('[data-testid="inbox-bell"]');
      await page.waitForSelector('[data-testid=inbox] [data-testid=inbox-row-post]', { timeout: 15000 });
      const row = await text('[data-testid=inbox] [data-testid=inbox-row-post]');
      assert(row.includes('the video is too short'), `the inbox row says why: ${row}`);
      const tip = await page.$eval('[data-testid=inbox] [data-testid=inbox-row-post] [data-testid=inbox-row-retry]', (e) => e.getAttribute('aria-label'));
      assert(tip.startsWith('Check again'), `the row asks the platform, it doesn't send: ${tip}`);
      const before = fakes.posts.size;
      const ig = async () => (await api(`/api/review/${enc(spot)}/posts`)).posts.find((p) => p.id === igPost);
      const steps = (await ig()).history.length;
      await page.$eval('[data-testid=inbox] [data-testid=inbox-row-post] [data-testid=inbox-row-retry]', (e) => e.click());
      await until(async () => {
        const p = await ig();
        return p.state === 'failed' && p.history.length > steps;
      }, 'asked again, still refused');
      assert(fakes.posts.size === before, 'nothing was sent a second time');
      await page.keyboard.press('Escape');

      // posting it again is the person's choice, behind its own question
      await openComposer(spot, igPost);
      await page.waitForSelector('[data-testid=pub-form-instagram] [data-testid=pub-state][data-state=failed]', { timeout: 15000 });
      await publishable();
      await page.click('[data-testid=pub-publish]');
      await page.waitForSelector('[data-testid=confirm] [data-testid=pub-again]');
      const asked = await text('[data-testid=confirm]');
      assert(asked.includes('Post it on Instagram again?') && asked.includes('only if it isn’t'), `asked as a second post: ${asked}`);
      await page.click('[data-testid=confirm-action]');
      await until(() => [...fakes.posts.values()].some((p) => p.status === 'published'), 'posted again, once', 45000);
      assert(fakes.posts.size === before + 1, `one more post on the platform: ${fakes.posts.size - before}`);
      await page.keyboard.press('Escape');
      await page.goto('about:blank');
      await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
      // (at domcontentloaded nothing is drawn yet, and a click pressed on the skeleton's bell and released on the real one is lost)
      await signedIn(page);
      await page.click('[data-testid="inbox-bell"]');
      await page.waitForSelector('[data-testid=inbox]');
      await until(async () => !(await page.$('[data-testid=inbox] [data-testid=inbox-row-post]')), 'it leaves the inbox once it is out', 15000);
      await page.keyboard.press('Escape');
    },
  );

  await check('a change made while the confirmation is open is not published under the person’s name: 409, and the post as it is now', async () => {
    await openComposer(spot);
    await page.click('[data-testid=pub-tab-facebook]');
    await page.waitForSelector('[data-testid=pub-form-facebook]', { timeout: 15000 });
    const fbPost = await page.$eval('[data-testid=pub-form-facebook]', (e) => e.getAttribute('data-post'));
    await retype('[data-testid=pub-description]', 'The spring spot is out.');
    await choose('pub-ai', 1);
    await publishable();
    await page.click('[data-testid=pub-publish]');
    await page.waitForSelector('[data-testid=confirm] [data-testid=pub-confirm]');
    // meanwhile an agent's last edit lands (A12 PUB-3)
    const r = await fetch(`${BASE}/api/posts/${enc(fbPost)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Buy now!!! link in bio', by: 'agent:promo-edit' }),
    });
    assert(r.ok, `the agent's edit: ${r.status}`);
    const sent = [...fakes.posts.values()].length;
    await page.click('[data-testid=confirm-action]');
    await page.waitForFunction(() => document.querySelector('[data-testid=pub-description]')?.value === 'Buy now!!! link in bio', { timeout: 15000 });
    const fb = (await api(`/api/review/${enc(spot)}/posts`)).posts.find((p) => p.id === fbPost);
    assert(fb.state === 'draft', `not published: ${fb.state}`);
    assert([...fakes.posts.values()].length === sent, 'nothing went to the platform');
    const edits = fb.history.filter((h) => h.state === 'draft' && h.note?.startsWith('changed'));
    assert(
      edits.some((h) => h.by === 'agent:promo-edit'),
      `the agent's edit is in the history: ${JSON.stringify(fb.history)}`,
    );
    await page.keyboard.press('Escape');
  });

  await check('reopening a final whose YouTube upload waits on YouTube’s own schedule says it stays live; otherwise it asks nothing', async () => {
    await openComposer(promo);
    await page.waitForSelector('[data-testid=pub-start-button]');
    await page.click('[data-testid=pub-start-button]');
    await page.waitForSelector('[data-testid=pub-form-youtube]');
    await retype('[data-testid=pub-title]', 'Promo');
    await choose('pub-when', 1);
    await choose('pub-ai', 1);
    await choose('pub-kids', 1);
    await confirmPublish();
    await until(async () => (await statusOf()) === 'scheduled', 'YouTube holds the scheduled upload', 45000);
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid=publish]', { hidden: true });
    const reopenFromMenu = async () => {
      await page.click('[data-testid=stage-more]');
      await page.waitForSelector('.menu[data-state=open] [role=menuitem]');
      await page.$$eval('.menu[data-state=open] [role=menuitem]', (els) => els.find((e) => e.textContent.trim().startsWith('Reopen'))?.click());
    };
    // the player: Reopen asks first, and says the schedule stays on YouTube
    await page.waitForFunction(() => document.querySelector('[data-testid=stage-published]')?.textContent.includes('YouTube'), { timeout: 15000 });
    await reopenFromMenu();
    await page.waitForSelector('[data-testid=reopen-held]', { timeout: 10000 });
    const held = await text('[data-testid=reopen-held]');
    assert(held.includes('YouTube Studio') && held.includes('goes public'), `the schedule stays live, and where to take it back: ${held}`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid=reopen-held]', { hidden: true });
    assert((await api(`/api/review/${enc(promo)}`)).summary.stage.stage === 'final', 'Not yet: still final');
    // the board: moving it out of Final asks the same
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/status`, { waitUntil: 'domcontentloaded' });
    const card = `.bcard[data-slug="${promo}"]`;
    await page.waitForSelector(card, { timeout: 20000 });
    await page.hover(card);
    await page.click(`${card} .bcard-menu button`);
    await page.waitForSelector('.menu [role=menuitem]');
    await page.$$eval('.menu [role=menuitem]', (els) => els.find((e) => ['To review', 'Approved'].includes(e.textContent.trim()))?.click());
    await page.waitForSelector('[data-testid=confirm]', { timeout: 10000 });
    const asked = await text('[data-testid=confirm]');
    assert(asked.includes('Reopen') && asked.includes('YouTube Studio'), `the board's confirm says it too: ${asked}`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid=confirm]', { hidden: true });
    // a final whose YouTube upload is out (not waiting on a schedule) reopens without being asked
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${enc(teaser)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=stage-more]', { timeout: 20000 });
    await reopenFromMenu();
    await until(async () => (await api(`/api/review/${enc(teaser)}`)).summary.stage.stage !== 'final', 'reopened at once');
    assert(!(await page.$('[data-testid=reopen-held]')), 'nothing to warn about');
  });

  await check('on a phone the composer is a sheet from the bottom edge, and it fits from 390 to 1920', async () => {
    const sizes = [
      { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
      { width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
      { width: 1440, height: 900, deviceScaleFactor: 1 },
      { width: 1920, height: 1080, deviceScaleFactor: 1 },
    ];
    const bad = [];
    for (const vp of sizes) {
      await page.setViewport(vp);
      // the Facebook draft: the whole form
      await openComposer(spot);
      await page.click('[data-testid=pub-tab-facebook]');
      await page.waitForSelector('[data-testid=pub-form-facebook]', { timeout: 15000 });
      await settled();
      const box = await page.$eval('.modal', (e) => {
        const r = e.getBoundingClientRect();
        return { left: r.left, right: r.right, bottom: r.bottom };
      });
      if (vp.width === 390) {
        assert(box.left === 0 && box.right === 390 && Math.abs(box.bottom - 844) <= 1, `a sheet across the bottom: ${JSON.stringify(box)}`);
        const small = await page.evaluate(tapAreas, '.modal');
        for (const b of small) bad.push(`composer @390: tap area ${b}`);
      } else if (box.left < 16 || Math.abs(box.left - (vp.width - box.right)) > 1)
        bad.push(`composer @${vp.width}: not centred with its gutters ${JSON.stringify(box)}`);
      const found = [
        ...(vp.isMobile ? await sideways(page) : []),
        ...(await clippedText(page)),
        ...(await cutLabels(page)),
        ...(await grainOnScrollers(page)),
        ...(await bentEdges(page)),
      ];
      for (const b of found) bad.push(`composer @${vp.width}: ${b}`);
      await page.goto('about:blank');
      await page.goto(`${BASE}/#/settings/publishing`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid=pubset-list]', { timeout: 20000 });
      await settled();
      const set = [
        ...(vp.isMobile ? await sideways(page) : []),
        ...(await clippedText(page)),
        ...(await cutLabels(page)),
        ...(await grainOnScrollers(page)),
        ...(await bentEdges(page)),
      ];
      for (const b of set) bad.push(`settings @${vp.width}: ${b}`);
      if (vp.width === 390) for (const b of await page.evaluate(tapAreas, '.set-main, main')) bad.push(`settings @390: tap area ${b}`);
    }
    await page.setViewport({ width: 1440, height: 900 });
    assert(!bad.length, bad.join('\n      '));
  });

  await check('German: the composer and Settings → Publishing say it in German, the platforms keep their names', async () => {
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.setItem('vr.lang', 'de'));
    await openComposer(spot, ytPost);
    await page.waitForFunction(() => document.documentElement.lang === 'de', { timeout: 10000 });
    const head = await text('.modal-head h3');
    assert(head.endsWith('veröffentlichen'), `the composer's title: ${head}`);
    assert((await text('[data-testid=pub-tab-youtube]')).startsWith('YouTube'), 'YouTube stays YouTube');
    assert((await text('[data-testid=pub-status-word]')) === 'Auf YouTube veröffentlicht', `the post's state: ${await text('[data-testid=pub-status-word]')}`);
    await page.goto(`${BASE}/#/settings/publishing`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=pubset-list]', { timeout: 20000 });
    const body = await text('body');
    for (const w of ['Verbindungen', 'Verbindung hinzufügen', 'Erneut prüfen']) assert(body.includes(w), `"${w}" in Settings → Publishing`);
    await page.evaluate(() => localStorage.removeItem('vr.lang'));
  });

  if (SHOTS)
    await check('screenshots: the composer and Settings → Publishing at 390, 768, 1440 and 1920, light and dark, English and German', async () => {
      const fb = (await api(`/api/review/${enc(spot)}/posts`)).posts.find((p) => p.platform === 'facebook' && p.v === 1);
      if (fb)
        await api(`/api/posts/${fb.id}`, 'PATCH', {
          description: 'The spring spot is out: three days of shooting in four seconds. Thanks to everyone who made it.',
          tags: ['launch', 'spring', 'behindthescenes'],
          cover_frame: 30,
        });
      const sizes = [
        { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
        { width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
        { width: 1440, height: 900, deviceScaleFactor: 1 },
        { width: 1920, height: 1080, deviceScaleFactor: 1 },
      ];
      for (const lang of ['en', 'de'])
        for (const theme of ['light', 'dark'])
          for (const vp of sizes) {
            await page.setViewport(vp);
            await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
            await page.evaluate(
              (lang, theme) => {
                if (lang === 'en') localStorage.removeItem('vr.lang');
                else localStorage.setItem('vr.lang', lang);
                localStorage.setItem('vr.theme', theme);
              },
              lang,
              theme,
            );
            const name = `${vp.width}-${theme}-${lang}`;
            await openComposer(spot, fb?.id ?? '1');
            if (fb) await page.waitForSelector('[data-testid=pub-form-facebook]', { timeout: 15000 });
            await settled();
            await page.screenshot({ path: path.join(SHOTS, `composer-${name}.png`) });
            await page.goto(`${BASE}/#/settings/publishing`, { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid=pubset-list]', { timeout: 20000 });
            await settled();
            await page.screenshot({ path: path.join(SHOTS, `settings-${name}.png`), fullPage: true });
          }
      await page.setViewport({ width: 1440, height: 900 });
    });

  await check('no page errors', async () => {
    assert(!errors.length, errors.join('\n'));
  });
} catch (e) {
  crashed(e, srv);
}
await fakes.close();
await finish(LABEL, { browser, servers: [srv] });
