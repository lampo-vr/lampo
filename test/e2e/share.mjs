#!/usr/bin/env node
// covers: web/src/share/ web/src/guest/ web/src/settings/Links.tsx web/src/styles/share.css
// covers: web/src/styles/share-links.css web/src/styles/guest.css server/routes/shares.ts server/routes/shares/
// covers: server/tunnel.ts lib/shares.ts lib/shareActivity.ts lib/brand.ts web/src/player/ZoomControl.tsx
// Browser end-to-end test of review links: a real server (local mode, temp store, free port) + headless Chrome as the
// client. A folder link opens a room; the client opens a video, draws an arrow and writes a note (the name is asked in
// the composer then); the owner replies; the client sees the reply; a new render comes in with the note marked fixed
// and the client confirms it. Then a password-protected, watch-only link, and the page on a phone: one bar row that
// stays clear of the status bar, the tools under the picture, one transport row, the name asked in a sheet by Approve.
// Both pages end in "Powered by Lampo" and the source offer. Every kind of link at four widths: a notes panel only
// where the link takes notes or has some to show, the timeline's zoom (and its first-time tip, in the tooltips' neutral
// material) never on the film strip, the ruler or the timeline. The words are for anyone a link is sent to, never
// "client"; the play button's glyph stands in its middle; the share dialog's password is a labelled field with an eye,
// checked in place. A note's card keeps the room of its marked frame before the picture arrives, so the fix check's
// buttons under it stay where a tap aims. Screenshots land in VR_SHOTS when it is set.
import fs from 'node:fs';
import path from 'node:path';
import { age, makeVideo, sleep, until } from '../lib/helpers.ts';
import { fitsAt, layoutMatrix, settle, WIDTHS } from './layout.mjs';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { glyphCentre, glyphProblems } from './lib/glyph.mjs';
import { LEGAL, startServer } from './lib/server.mjs';

const LABEL = 'share e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
// The owner's account starts out named after the OS login (here "samlogin"); they choose "Sam" in Profile below.
const srv = await startServer({
  prefix: 'vr-share-e2e-',
  user: 'samlogin',
  env: { VR_IMPRINT_URL: LEGAL.VR_IMPRINT_URL, VR_PRIVACY_URL: LEGAL.VR_PRIVACY_URL },
});
const { dir, env, base: BASE } = srv;

const api = jsonApi(BASE);

let browser;
try {
  const add = async (rel, folder, opts = {}) => {
    const file = makeVideo(path.join(dir, rel), { w: 320, h: 180, fps: 30, dur: 3, ...opts });
    age(file);
    const { video } = await api('/api/library', 'POST', { path: file });
    await api(`/api/review/${encodeURIComponent(video.slug)}/folder`, 'PUT', { folder });
    return { file, slug: video.slug };
  };
  const spot = await add('Acme/export/spot.mp4', 'Acme/Reels', { pattern: 'testsrc2' });
  const teaser = await add('Acme/export/teaser.mp4', 'Acme/Reels', { pattern: 'smptebars' });
  await add('Other/export/secret.mp4', 'Other');

  browser = await launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Expected 4xx answers (a wrong password) show up as resource errors; real script errors are page errors.
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));
  const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  const videoReady = () =>
    page.waitForFunction(
      () => {
        const v = document.querySelector('.vbox video');
        return v && v.readyState >= 2 && !v.seeking;
      },
      { polling: 100, timeout: 20000 },
    );
  const clickText = (sel, text) =>
    page.evaluate(
      (sel, text) => {
        const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(text));
        if (!el) throw new Error(`no ${sel} with "${text}"`);
        el.click();
      },
      sel,
      text,
    );
  /**
   * A real click, once `sel` is what lies under its middle. A menu or popover that was just answered can still be over
   * it for a frame or more on a busy machine (its choice already shows on the page), and a press aimed at the switch
   * under it lands on the menu.
   */
  const press = async (sel) => {
    await page.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        el.scrollIntoView({ block: 'nearest' });
        const r = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
      },
      { polling: 50, timeout: 10000 },
      sel,
    );
    await page.click(sel);
  };
  console.log(`share e2e against ${BASE} (store ${dir})`);

  const room = await api('/api/folder-shares', 'POST', { folder: 'Acme/Reels', label: 'Acme marketing' });
  let noteId = '';

  await check('a link doesn’t name its sharer by the OS login; once they choose a name in Profile it does', async () => {
    const locked = await api(`/api/review/${encodeURIComponent(spot.slug)}/shares`, 'POST', { label: 'First look', password: 'letmein' });
    await page.goto(`${BASE}/g/${locked.token}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.invite h1');
    assert(!(await page.$('.invite .ent-from')), 'no “… shared a review with you” without a chosen name');
    const text = await page.$eval('body', (e) => e.textContent);
    assert(!text.includes('samlogin'), `the login name never shows: ${text}`);
    assert(text.includes('Enter the password'), 'the gate reads without a name');
    // the owner is told the same: nobody named, until a name is chosen
    const before = await api(`/api/review/${encodeURIComponent(spot.slug)}/shares`);
    assert(before.sharer === null && before.shares.every((x) => x.sharer === null), `no sharer yet: ${JSON.stringify(before.sharer)}`);
    await api('/api/auth/me', 'PATCH', { name: 'Sam' });
    const after = await api(`/api/review/${encodeURIComponent(spot.slug)}/shares`);
    assert(after.sharer === 'Sam' && after.shares.some((x) => x.sharer === 'Sam'), `the chosen name: ${JSON.stringify(after.sharer)}`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.invite .ent-from');
    assert((await page.$eval('.invite .ent-from', (e) => e.textContent)).includes('Sam'), 'the chosen name, on a link made before too');
  });

  await check('a folder link opens a room with the folder’s videos and nothing else', async () => {
    await page.goto(`${BASE}/g/${room.token}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.room .film');
    await until(async () => (await page.$$('.room .film')).length === 2, 'two videos in the room');
    const names = await page.$$eval('.room .film-title', (els) => els.map((e) => e.textContent).sort());
    assert(names.join(',') === 'spot.mp4,teaser.mp4', names.join(','));
    const fit = await fitsAt(page, 'room');
    assert(!fit.length, fit.join('\n'));
    await sleep(600);
    await shot('01-room');
  });

  await check('the client opens a video, marks the frame with an arrow and writes a note', async () => {
    await clickText('.room .film-title', 'spot.mp4');
    await videoReady();
    // under the video's name: the link's own name, the version and how far the visitor got
    const sub = await page.$eval('[data-testid=g-subtitle]', (e) => e.textContent);
    assert(sub === 'Acme marketing · V1 · 0 of 2 reviewed', `the line under the name: ${sub}`);
    // no notes yet: the composer is the invitation, and under it how a note is written — no "No notes yet" under an
    // open composer (guest-look.mjs)
    await page.waitForSelector('[data-testid=g-notes-empty]', { timeout: 10000 });
    assert(!(await page.$('.side .empty-art')), 'no empty state under the composer');
    // what to do is said once, under the composer (with its key), not again above it
    const how = await page.$eval('[data-testid=g-notes-empty]', (e) => e.textContent);
    assert(how.includes('press C') && how.includes('goes straight to Sam'), how);
    assert(!(await page.$eval('.g-side-head', (e) => e.textContent)).includes('Pause where'), 'the notes’ head doesn’t repeat it');
    // nothing asked before there is something to send: the name comes with the first note
    assert(!(await page.$('.g-name')), 'no name prompt up front');
    // 30 frames in: three Shift+→ jumps of ten.
    await page.keyboard.down('Shift');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.up('Shift');
    await until(async () => (await page.$eval('.tc .main', (e) => e.textContent)) !== '00:00:00', 'seeked');
    const frame = await page.$eval('.tc .sub b', (e) => Number(e.textContent));
    await page.click('[aria-label="Arrow"]');
    const box = await page.$eval('.vbox', (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    await page.mouse.move(box.x + box.w * 0.25, box.y + box.h * 0.7);
    await page.mouse.down();
    await page.mouse.move(box.x + box.w * 0.45, box.y + box.h * 0.5, { steps: 5 });
    await page.mouse.move(box.x + box.w * 0.6, box.y + box.h * 0.35, { steps: 5 });
    await page.mouse.up();
    await page.type('.g-composer textarea', 'Logo bitte später einblenden');
    // what is picked shows under the text; the kind is one small menu in the toolbar, ⌘↵ sends
    assert((await page.$eval('.g-composer .composer-picked', (e) => e.textContent)) === '1 mark', 'the mark counted under the text');
    assert((await page.$eval('.g-composer .sev-pick', (e) => e.getAttribute('aria-label'))) === 'Kind of note: Change', 'a change by default');
    assert(!(await page.$('.g-composer .seg')), 'no segmented row in the client composer');
    await sleep(200);
    await shot('02-player-composing');
    await page.focus('.g-composer textarea');
    await page.keyboard.down('Meta');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Meta');
    // No name yet: the composer asks for it there, kindly — who it is for and who sees the notes, truly: another link
    // that shows the notes from all links does too (A12-D4) — and the note, its mark and its frame wait for it.
    await page.waitForSelector('.g-composer .g-name input');
    const ask = await page.$eval('.g-composer .g-name', (e) => e.textContent);
    assert(ask.includes('What’s your name?') && ask.includes('Sam'), ask);
    assert(ask.includes('notes from all links') && !ask.includes('Only people with this link') && !/client/i.test(ask), ask);
    assert((await page.evaluate(() => document.activeElement?.closest('.g-name') != null)) === true, 'the field has the focus');
    assert(!(await page.$$('.g-note')).length, 'nothing sent without a name');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.g-composer .g-name-hint');
    await page.type('.g-composer .g-name input', 'Mia');
    await page.keyboard.press('Enter');
    await until(async () => (await page.$$('.g-note')).length === 1, 'note listed');
    // named now: the notes' head says who is writing (a tap changes it), and nothing asks again
    await page.waitForFunction(() => document.querySelector('[data-testid=g-who]')?.textContent.includes('Mia'), { timeout: 5000 });
    assert(!(await page.$('.g-composer .g-name')), 'the name ask is gone once given');
    const { review } = await api(`/api/review/${encodeURIComponent(spot.slug)}`);
    const c = review.comments.find((x) => x.text === 'Logo bitte später einblenden');
    assert(c, 'the note reached the store');
    assert(c.author === 'guest:Mia', c.author);
    assert(c.frame === frame, `note on f${c.frame}, the player showed f${frame}`);
    assert(c.drawing[0]?.type === 'arrow', JSON.stringify(c.drawing));
    assert(c.share === room.id, `note tied to the link (${c.share})`);
    assert(fs.existsSync(path.join(env.VR_DATA, spot.slug, c.shots.marked)), 'marked screenshot');
    noteId = c.id;
  });

  await check('the owner’s reply shows up for the client', async () => {
    await api(`/api/comments/${noteId}`, 'PATCH', { note: 'Klar, schiebe ich auf 1:10' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await videoReady();
    // a row at rest says it has a reply; opened, the card shows it as a message, as the app's does
    await page.waitForFunction(() => document.querySelector('.g-note.note-row .nr-said')?.textContent === '1', { timeout: 10000 });
    await page.click('.g-note.note-row .nr');
    await page.waitForFunction(() => [...document.querySelectorAll('.g-note [data-testid=reply]')].some((e) => e.textContent.includes('schiebe ich')), {
      timeout: 10000,
    });
    const by = await page.$eval('.g-note [data-testid=reply] .msg-who b', (e) => e.textContent);
    assert(by.startsWith('Sam'), by);
  });

  await check('the team’s reply field on a client’s note says the client sees it; on a team note it doesn’t (A12 GUEST-7)', async () => {
    const team = await api(`/api/review/${encodeURIComponent(spot.slug)}/comments`, 'POST', { frame: 5, text: 'Team only: grade warmer' });
    const owner = await browser.newPage();
    await owner.setViewport({ width: 1440, height: 900 });
    try {
      await owner.goto(`${BASE}/#/v/${encodeURIComponent(spot.slug)}`, { waitUntil: 'domcontentloaded' });
      await owner.waitForSelector('.note');
      const openReply = async (id) => {
        const card = await owner.waitForFunction(
          (id) => [...document.querySelectorAll('.note')].find((n) => n.querySelector('.c-id')?.textContent === id),
          { timeout: 10000 },
          id,
        );
        await card.click();
        await owner.waitForSelector('.note.active .reply-stub');
        await owner.click('.note.active .reply-stub');
        await owner.waitForSelector('.note.active .note-editor textarea');
        return owner.$eval('.note.active .note-editor', (e) => e.querySelector('[data-testid=client-reads]')?.textContent ?? null);
      };
      const cue = await openReply(noteId);
      assert(cue?.includes('Mia can see this on the review link'), `the cue on the client’s note: ${cue}`);
      await owner.keyboard.press('Escape');
      const none = await openReply(team.comment?.id ?? team.id);
      assert(none === null, `no cue on a team note: ${none}`);
    } finally {
      await owner.close();
    }
  });

  await check('a new render with the note marked fixed: the client confirms it', async () => {
    makeVideo(spot.file, { w: 320, h: 180, fps: 30, dur: 3, pattern: 'testsrc2', freq: 880 });
    age(spot.file);
    const s = await api(`/api/review/${encodeURIComponent(spot.slug)}/sync`, 'POST');
    assert(s.review.versions.length === 2, `versions: ${s.review.versions.length}`);
    await api(`/api/comments/${noteId}`, 'PATCH', { status: 'fixed', note: 'Logo kommt jetzt bei 1:10', by: 'agent:edit' });
    // A link plays a preview copy of each version, which the server makes in its job queue: until then the page says
    // "Getting the video ready…" and asks again every few seconds. Next to other suites that took longer than the
    // player's 20 s (the link still said `preparing` then): wait for the link to say it's made, then load the page.
    const gid = (await api(`/api/g/${room.token}`)).videos.find((v) => v.name === 'spot.mp4').slug;
    await until(
      async () => {
        const g = await api(`/api/g/${room.token}/review/${gid}`);
        return !g.preparing && !!g.media;
      },
      'V2’s preview made for the link',
      120_000,
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await videoReady();
    await page.waitForSelector('.g-check');
    const head = await page.$eval('.g-top .p-title span', (e) => e.textContent);
    assert(head.includes('V2'), head);
    await sleep(300);
    await shot('03-player-fixed-check');
    await clickText('.g-check button', 'Looks right');
    await until(async () => (await api(`/api/comments/${noteId}`)).comment.status === 'verified', 'verified');
    await page.waitForFunction(() => !document.querySelector('.g-check'), { timeout: 10000 });
  });

  await check('the room shows where each video stands; back from a video lands in the room', async () => {
    await page.goto(`${BASE}/g/${room.token}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.room .film');
    const text = await page.$eval('.room', (e) => e.textContent);
    assert(text.includes('1 note'), 'note count on the card');
    const from = await page.$eval('.room .inv-from', (e) => e.textContent);
    assert(from.includes('Sam') && from.includes('shared 2 videos with you'), `who shared the room: ${from}`);
    assert((await page.$eval('.room-progress', (e) => e.textContent)).includes('0 of 2 reviewed'), 'progress before any verdict');
  });

  await check(
    'the room and the video page end in "Powered by Lampo", say where the app’s source is (AGPL-3.0 §13, A12-D5) and link the operator’s imprint and privacy policy',
    async () => {
      const info = await api('/api/info');
      assert(/^https:\/\//.test(info.source_url || ''), `the instance has a source URL: ${info.source_url}`);
      for (const [url, ready, where] of [
        [`/g/${room.token}`, '.room .film', '.room'],
        [`/g/${room.token}#${encodeURIComponent(spot.slug)}`, '.g-top h1', '.g-player'],
      ]) {
        await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector(ready);
        const foot = await page.$eval(`${where} [data-testid=g-foot]`, (f) => {
          const a = (sel) => {
            const e = f.querySelector(sel);
            return e && { href: e.getAttribute('href'), rel: e.rel, text: e.textContent.trim(), label: e.getAttribute('aria-label') };
          };
          const r = f.getBoundingClientRect();
          const box = f.parentElement.getBoundingClientRect();
          return {
            powered: a('[data-testid=powered-by]'),
            source: a('[data-testid=source-link]'),
            imprint: a('[data-testid=imprint-link]'),
            privacy: a('[data-testid=privacy-link]'),
            // the legal pages on a line of their own, under the badge
            below: (() => {
              const legal = f.querySelector('[data-testid=g-legal]')?.getBoundingClientRect();
              return !!legal && legal.top >= f.querySelector('[data-testid=powered-by]').getBoundingClientRect().bottom - 1;
            })(),
            mid: r.left + r.width / 2 - (box.left + box.width / 2),
          };
        });
        assert(foot.powered?.text === 'Powered by Lampo' && foot.powered.href === 'https://lampo.video', `${url}: the badge: ${JSON.stringify(foot)}`);
        assert(foot.source?.href === info.source_url && foot.source.text === 'Source', `${url}: the source offer: ${JSON.stringify(foot)}`);
        // neither link tells the other site the review link (its token is in the path)
        assert(foot.powered.rel.includes('noreferrer') && foot.source.rel.includes('noreferrer'), JSON.stringify(foot));
        assert(/free software, AGPL-3\.0/.test(foot.source.label || ''), `the offer says what it is: ${JSON.stringify(foot)}`);
        // who runs the server and what it keeps of a visitor (A13 CLOUD-1): the operator's own pages, no referrer either
        assert(foot.imprint?.href === LEGAL.VR_IMPRINT_URL && foot.imprint.text === 'Imprint', `${url}: the imprint: ${JSON.stringify(foot)}`);
        assert(foot.privacy?.href === LEGAL.VR_PRIVACY_URL && foot.privacy.text === 'Privacy', `${url}: the privacy policy: ${JSON.stringify(foot)}`);
        assert(foot.imprint.rel.includes('noreferrer') && foot.privacy.rel.includes('noreferrer') && foot.below, JSON.stringify(foot));
        assert(Math.abs(foot.mid) <= 2, `${url}: the foot sits in the middle (${foot.mid}px off)`);
      }
      await page.goto(`${BASE}/g/${room.token}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.room .film');
    },
  );

  await check('the client approves: a thank-you names who hears about it, counts it, and offers the next video', async () => {
    await clickText('.room .film-title', 'spot.mp4');
    await videoReady();
    await page.click('[data-testid=g-approve]');
    await page.waitForSelector('.g-thanks');
    const thanks = await page.$eval('.g-thanks', (e) => e.textContent);
    assert(thanks.includes('Thanks, Mia') && thanks.includes('Sam has been told') && thanks.includes('1 of 2 reviewed'), thanks);
    assert((await page.$eval('.g-verdict', (e) => e.textContent)).includes('You approved V2'), 'the verdict shows');
    await sleep(300);
    await shot('03b-player-thanks');
    await clickText('.g-thanks button', 'Next: teaser.mp4');
    await videoReady();
    assert((await page.$eval('.g-top h1', (e) => e.textContent)) === 'teaser.mp4', 'the next video opened');
    await page.goto(`${BASE}/g/${room.token}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.room .film');
    assert((await page.$eval('.room-progress', (e) => e.textContent)).includes('1 of 2 reviewed'), 'the room counts it');
  });

  await check('a password link asks first; a watch-only link has no composer', async () => {
    const locked = await api(`/api/review/${encodeURIComponent(spot.slug)}/shares`, 'POST', {
      label: 'Board',
      password: 'letmein',
      comment: false,
      approve: false,
    });
    await page.goto(`${BASE}/g/${locked.token}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.invite h1');
    // An invitation from a person: who shared what, not "Protected."
    assert((await page.$eval('.invite h1', (e) => e.textContent)) === 'Board', 'the title is the link’s name');
    assert((await page.$eval('.invite .ent-from', (e) => e.textContent)).includes('Sam'), 'who shared it');
    const fit = await fitsAt(page, 'password gate');
    assert(!fit.length, fit.join('\n'));
    await sleep(900);
    await shot('04-gate-password');
    await page.type('.gate-input', 'nope');
    // With something typed, the way in is a real primary: enabled, opaque, readable.
    const go = await page.$eval('.gate-go', (b) => {
      const s = getComputedStyle(b);
      const rgb = (c) => (c.match(/[\d.]+/g) || []).map(Number);
      let bg = rgb(s.backgroundColor);
      if (bg.length === 4 && bg[3] === 0) bg = rgb((s.backgroundImage.match(/rgba?\([^)]*\)/) || ['rgb(0,0,0)'])[0]);
      const lum = ([r, g, b2]) => {
        const f = (v) => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b2);
      };
      const [a, c] = [lum(bg), lum(rgb(s.color))].sort((x, y) => y - x);
      return { disabled: b.disabled, opacity: Number(s.opacity), contrast: (a + 0.05) / (c + 0.05) };
    });
    assert(!go.disabled && go.opacity === 1, `the button looks and is enabled: ${JSON.stringify(go)}`);
    assert(go.contrast >= 4.5, `the button's words are readable (${go.contrast.toFixed(2)}:1)`);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (document.querySelector('.gate-error')?.textContent || '').trim().length > 2, { timeout: 10000 });
    assert(await page.$('.inv-field.bad[data-shake]'), 'a wrong password shakes the field and marks it');
    await page.$eval('.gate-input', (e) => {
      e.value = '';
    });
    await page.click('.gate-input', { count: 3 });
    await page.keyboard.press('Backspace');
    await page.type('.gate-input', 'letmein');
    await page.keyboard.press('Enter');
    await videoReady();
    assert(!(await page.$('.g-composer')), 'no composer on a watch-only link');
    assert(!(await page.$('[data-testid=g-approve]')), 'no approve button');
    // nothing to show and nothing to take: no notes panel at all, the video gets the room, the foot goes under the dock
    const open = await page.evaluate(() => ({
      side: !!document.querySelector('.g-player .side'),
      width: innerWidth,
      dock: document.querySelector('.g-player .dock').getBoundingClientRect().width,
      foot: !!document.querySelector('.g-player > .g-foot [data-testid=powered-by]'),
      text: document.body.textContent,
    }));
    assert(
      !open.side && open.foot && open.dock >= open.width - 1,
      `no notes panel; the dock spans the page; the foot under it: ${JSON.stringify({ ...open, text: undefined })}`,
    );
    assert(!open.text.includes('Notes are switched off') && !open.text.includes('Nothing noted'), 'no panel saying there are no notes');
  });

  await check(
    'in front of a password: the brand film beside the form, decoration only; nothing of the review; its pictures after the first paint; still on phones and for reduced motion',
    async () => {
      const locked = await api(`/api/review/${encodeURIComponent(spot.slug)}/shares`, 'POST', { label: 'Film', password: 'letmein' });
      const url = `${BASE}/g/${locked.token}`;
      /** A fresh visitor (no cache, no unlock cookie) at a size, motion welcome or not, with everything the page asks for. */
      const visit = async (vp, motion) => {
        const ctx = await browser.createBrowserContext();
        const p = await ctx.newPage();
        await p.setViewport(vp);
        await p.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: motion ? 'no-preference' : 'reduce' }]);
        const asked = [];
        p.on('request', (r) => asked.push(new URL(r.url()).pathname));
        await p.goto(url, { waitUntil: 'domcontentloaded' });
        await p.waitForSelector('#gate-pw');
        // the still is decoded and shown once the form has painted
        await p.waitForSelector('.ent-film[data-still]', { timeout: 15000 });
        return { p, ctx, asked };
      };
      const look = (p) =>
        p.evaluate(() => {
          const el = document.querySelector('.ent-film');
          const box = el.getBoundingClientRect();
          const col = document.querySelector('.ent-col').getBoundingClientRect();
          const fcp = performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint')?.startTime;
          const pictures = performance
            .getEntriesByType('resource')
            .map((e) => ({ file: new URL(e.name).pathname.split('/').pop(), start: e.startTime }))
            .filter((e) => /^(poster|strip|frames-\d)-[\w-]+\.webp$/.test(e.file))
            .map((e) => ({ kind: e.file.replace(/-[\w-]+\.webp$/, '').replace(/^frames-\d$/, 'frames'), early: e.start < fcp }));
          const backgrounds = [...document.querySelectorAll('*')].map((e) => getComputedStyle(e).backgroundImage).filter((b) => b.includes('url('));
          return {
            hidden: el.getAttribute('aria-hidden') === 'true',
            reachable: el.querySelectorAll('a, button, input, [tabindex]').length,
            film: { left: box.left, right: box.right, top: box.top, bottom: box.bottom, height: box.height },
            col: { left: col.left, top: col.top },
            width: innerWidth,
            fcp,
            pictures,
            anims: [...document.querySelector('.ent-reel').getAnimations()].map((a) => a.playState),
            frame: document.querySelector('.ent-readout [data-f]').textContent,
            media: [...document.querySelectorAll('img, video')].map((m) => m.currentSrc || m.src).filter((s) => !s.startsWith('data:')),
            theirs: backgrounds.filter((b) => /\/(api|media|data)\//.test(b)),
          };
        });
      // a desk, reduced motion: the film beside the form, its still only, nothing of the review even after a wrong try
      const desk = await visit({ width: 1440, height: 900 }, false);
      await desk.p.type('#gate-pw', 'nope');
      await desk.p.keyboard.press('Enter');
      await desk.p.waitForFunction(() => (document.querySelector('.gate-error')?.textContent || '').trim().length > 2, { timeout: 10000 });
      const a = await look(desk.p);
      await desk.ctx.close();
      assert(a.hidden && a.reachable === 0, `the film is decoration: aria-hidden, nothing in it to reach (${a.reachable})`);
      assert(
        a.film.left < 40 && a.film.right <= a.col.left && a.col.left > a.width / 2 - 1,
        `split: the film on the left, the form on the right ${JSON.stringify(a)}`,
      );
      assert(
        a.fcp > 0 && a.pictures.length && a.pictures.every((x) => !x.early),
        `the film's pictures come after the first paint: ${JSON.stringify(a.pictures)}`,
      );
      assert(
        ['poster', 'strip'].every((k) => a.pictures.some((x) => x.kind === k)),
        `the still (poster and strip): ${JSON.stringify(a.pictures)}`,
      );
      assert(
        !a.pictures.some((x) => x.kind === 'frames') && !a.anims.length && a.frame === '0295',
        `reduced motion: one still frame, F 0295 ${JSON.stringify(a)}`,
      );
      const leaked = desk.asked
        .filter((u) => u.startsWith(`/api/g/${locked.token}/`) && !u.endsWith('/unlock'))
        .concat(desk.asked.filter((u) => /^\/(media|data)\//.test(u)));
      assert(
        !leaked.length && !a.media.length && !a.theirs.length,
        `nothing of the review before the password: ${JSON.stringify({ leaked, media: a.media, theirs: a.theirs })}`,
      );
      // a phone, motion welcome: stacked, a slim still band above the form, no frames loaded
      const phone = await visit({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, true);
      const b = await look(phone.p);
      const phoneFit = await fitsAt(phone.p, 'password gate, phone');
      await phone.ctx.close();
      assert(
        b.film.top === 0 && b.film.height > 150 && b.film.height < 260 && b.film.bottom <= b.col.top,
        `phone: a band of the picture above the form ${JSON.stringify(b.film)}`,
      );
      assert(!b.pictures.some((x) => x.kind === 'frames') && !b.anims.length, `phone: still, no frames loaded ${JSON.stringify(b)}`);
      assert(!phoneFit.length, phoneFit.join('\n'));
      // a desk, motion welcome: the four sheets after the first paint, decoded, then the film plays and the readout follows;
      // a tab nobody looks at pauses it
      const moving = await visit({ width: 1440, height: 900 }, true);
      await moving.p.waitForFunction(
        () =>
          document
            .querySelector('.ent-reel')
            .getAnimations()
            .some((x) => x.playState === 'running'),
        { timeout: 20000 },
      );
      await moving.p.waitForFunction(() => document.querySelector('.ent-readout [data-f]').textContent !== '0295', { timeout: 10000 });
      const c = await look(moving.p);
      assert(c.pictures.filter((x) => x.kind === 'frames').length === 4 && c.pictures.every((x) => !x.early), `the frames: ${JSON.stringify(c.pictures)}`);
      // typing touches nothing of it
      const before = await moving.p.evaluate(() => document.querySelector('.ent-reel').getAnimations()[0].playbackRate);
      await moving.p.type('#gate-pw', 'typing away');
      const after = await moving.p.evaluate(() =>
        document
          .querySelector('.ent-reel')
          .getAnimations()
          .map((x) => [x.playState, x.playbackRate]),
      );
      assert(after.length === 1 && after[0][0] === 'running' && after[0][1] === before, `typing doesn't touch the film: ${JSON.stringify(after)}`);
      await moving.p.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await moving.p.waitForFunction(
        () =>
          document
            .querySelector('.ent-reel')
            .getAnimations()
            .every((x) => x.playState === 'paused'),
        { timeout: 5000 },
      );
      await moving.ctx.close();
    },
  );

  await check('every kind of link at 390–1920: a notes panel only where the link takes notes or has some to show; the zoom off the timeline', async () => {
    const make = (body) => api(`/api/review/${encodeURIComponent(teaser.slug)}/shares`, 'POST', body);
    const kinds = {
      review: await make({}),
      'watch only': await make({ comment: false, approve: false }),
      delivery: await make({ label: 'Mia at Northwind', comment: false, approve: false, download: 'original' }),
      // a review link with a note, switched to watch only: its notes stay, to read, without a composer
      'read only': await make({ label: 'Board review' }),
    };
    const ro = kinds['read only'].token;
    const gid = (await api(`/api/g/${ro}`)).videos[0].slug;
    await api(`/api/g/${ro}/comments`, 'POST', { name: 'Noor', slug: gid, v: 1, frame: 12, text: 'The title could come in a beat later.' });
    await api(`/api/shares/${ro}`, 'PATCH', { comment: false, approve: false });
    const want = {
      review: { side: true, composer: true, sub: 'Shared by Sam · V1' },
      'watch only': { side: false, composer: false, sub: 'Shared by Sam · V1' },
      delivery: { side: false, composer: false, sub: 'Mia at Northwind · V1' },
      'read only': { side: true, composer: false, sub: 'Board review · V1' },
    };
    const problems = [];
    for (const [kind, link] of Object.entries(kinds)) {
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(`${BASE}/g/${link.token}`, { waitUntil: 'domcontentloaded' });
      await videoReady();
      const bad = await layoutMatrix(
        page,
        { [kind]: null },
        {
          widths: [390, 768, 1440, 1920],
          each: async (width, theme) => {
            const m = await page.evaluate(() => {
              const box = (sel) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
              const dock = box('.g-player .dock');
              const foot = box('[data-testid=powered-by]');
              // the timeline's zoom and its tip against the timeline (its film strip and ruler: the top 30 px)
              const tl = box('.timeline');
              const zoom = box('[data-testid=tl-zoom]');
              const tipEl = document.querySelector('[data-testid=tl-zoom-hint]');
              const tip = tipEl?.getBoundingClientRect() ?? null;
              const meets = (a, b) => !!a && !!b && a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
              const strip = tl && { left: tl.left, right: tl.right, top: tl.top, bottom: tl.top + 30 };
              let tipLook = null;
              if (tipEl) {
                const probe = document.createElement('div');
                probe.className = 'tip';
                probe.style.cssText = 'position:fixed;left:-999px;top:0;animation:none';
                document.body.append(probe);
                const hue = (c) => {
                  const [r, g, b] = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
                  return Math.max(r, g, b) - Math.min(r, g, b);
                };
                const got = getComputedStyle(tipEl);
                tipLook = {
                  material: got.backgroundColor === getComputedStyle(probe).backgroundColor,
                  hue: Math.max(hue(got.backgroundColor), hue(got.color)),
                };
                probe.remove();
              }
              return {
                zoom: !!zoom,
                zoomOnStrip: meets(zoom, strip),
                zoomOnTimeline: meets(zoom, tl) || !!document.querySelector('.timeline [data-testid=tl-zoom]'),
                tipOnTimeline: meets(tip, tl),
                tipLook,
                side: !!document.querySelector('.g-player .side'),
                composer: !!document.querySelector('.g-composer'),
                readOnly: document.querySelector('.g-side-note')?.textContent ?? null,
                notes: document.querySelectorAll('.g-note').length,
                sub: document.querySelector('[data-testid=g-subtitle]')?.textContent,
                dockW: dock && Math.round(dock.width),
                footBelowDock: !!dock && !!foot && foot.top >= dock.bottom - 1,
                footInSide: !!document.querySelector('.side [data-testid=powered-by]'),
                width: innerWidth,
                client: /client/i.test(document.querySelector('.g-top').textContent),
              };
            });
            const w = want[kind];
            const at = `${kind} @${width} ${theme}`;
            if (m.side !== w.side || m.composer !== w.composer) problems.push(`${at}: notes panel ${m.side}, composer ${m.composer}`);
            if (m.sub !== w.sub || m.client) problems.push(`${at}: the line under the name: ${m.sub}`);
            if (!w.side && (m.dockW < m.width - 1 || !m.footBelowDock))
              problems.push(`${at}: the video should get the width and the foot sit under the dock: ${JSON.stringify(m)}`);
            if (w.side && !m.footInSide) problems.push(`${at}: the foot belongs to the notes column`);
            if (!m.zoom || m.zoomOnStrip || m.zoomOnTimeline || m.tipOnTimeline)
              problems.push(`${at}: the zoom on the timeline (film strip or ruler ${m.zoomOnStrip}, timeline ${m.zoomOnTimeline}, tip ${m.tipOnTimeline})`);
            if (m.tipLook && (!m.tipLook.material || m.tipLook.hue > 24))
              problems.push(`${at}: the zoom's tip isn't the tooltips' neutral material: ${JSON.stringify(m.tipLook)}`);
            if (kind === 'read only' && (m.notes !== 1 || !m.readOnly?.includes('Read only')))
              problems.push(`${at}: the shared note, read only: ${JSON.stringify(m)}`);
            if (SHOTS && theme === 'dark') await page.screenshot({ path: path.join(SHOTS, `15-kind-${kind.replace(' ', '-')}-${width}.png`) });
          },
        },
      );
      problems.push(...bad);
    }
    await page.emulateMediaFeatures([]);
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 });
    assert(!problems.length, problems.join('\n'));
  });

  await check('an expired link says so', async () => {
    const old = await api(`/api/review/${encodeURIComponent(spot.slug)}/shares`, 'POST', { label: 'Old', expires: '2020-01-01T00:00:00Z' });
    await page.goto(`${BASE}/g/${old.token}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.invite h1');
    assert((await page.$eval('.invite h1', (e) => e.textContent)).includes('expired'), 'expired gate');
    assert((await page.$eval('.ent-lede', (e) => e.textContent)).includes('Ask Sam for a new one'), 'whom to ask');
    await sleep(900);
    await shot('05-gate-expired');
  });

  await check('a folder link the server can’t check right now asks the client to come back, never says it is gone, and opens by itself (VE1r2-4)', async () => {
    // folders.json damaged: the link answers 503 "try again later" (lib/folderIds.ts) until it is repaired
    const file = path.join(dir, 'data', 'folders.json');
    const whole = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, whole.slice(0, Math.floor(whole.length / 2)));
    try {
      await page.goto(`${BASE}/g/${room.token}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.invite h1');
      const title = await page.$eval('.invite h1', (e) => e.textContent);
      const lede = await page.$eval('.ent-lede', (e) => e.textContent);
      assert(!/isn’t available|expired/.test(title) && !/switched off|new one/.test(lede), `told the link is gone: ${title} — ${lede}`);
      assert(/later|moment/.test(`${title} ${lede}`), `asked to come back: ${title} — ${lede}`);
      const fit = await fitsAt(page, 'gate-later');
      assert(!fit.length, fit.join('\n'));
      await shot('05b-gate-later');
    } finally {
      fs.writeFileSync(file, whole);
    }
    // repaired: the page tries again by itself and the room opens, without a reload
    await page.waitForSelector('.room .film', { timeout: 30000 });
  });

  await check('client pages never show the server’s address (no host or port)', async () => {
    const locked = await api(`/api/review/${encodeURIComponent(spot.slug)}/shares`, 'POST', { label: 'Host check', password: 'check' });
    const old = await api(`/api/review/${encodeURIComponent(spot.slug)}/shares`, 'POST', { label: 'Old too', expires: '2020-01-01T00:00:00Z' });
    const host = new URL(BASE).host;
    for (const [url, ready] of [
      [`/g/${locked.token}`, '.invite h1'],
      [`/g/${old.token}`, '.invite h1'],
      ['/g/notARealToken000000000000', '.invite h1'],
      [`/g/${room.token}`, '.room .film'],
      [`/g/${room.token}#${encodeURIComponent(spot.slug)}`, '.g-top h1'],
    ]) {
      await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(ready);
      const text = await page.evaluate(() => document.body.innerText);
      assert(!text.includes(host) && !/(localhost|127\.0\.0\.1):\d+/.test(text), `${url} shows an address`);
    }
  });

  await check('on a phone the player, the transport and the notes stack and stay usable', async () => {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: SHOTS ? 3 : 1, isMobile: true, hasTouch: true });
    await page.goto(`${BASE}/g/${room.token}#${encodeURIComponent(spot.slug)}`, { waitUntil: 'domcontentloaded' });
    await videoReady();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 1, `no sideways scrolling on a phone (${overflow}px)`);
    const stage = await page.$eval('.vbox', (e) => e.getBoundingClientRect().width);
    assert(stage >= 390 - 2 * 8 - 1, `the video uses the width (${stage}px)`);
    // no keyboard, no shortcuts: "Add note" without its ⌘↵; a note opened by a tap has its Reply in its head, as the
    // app's card does
    await page.waitForSelector('.g-note.note-row .nr', { timeout: 10000 });
    await page.tap('.g-note.note-row .nr');
    await page.waitForSelector('.g-note.comment.active .note-head [data-testid=g-reply]', { timeout: 10000 });
    const touch = await page.evaluate(() => {
      const add = [...document.querySelectorAll('.g-composer .btn')].find((b) => b.textContent.includes('Add note'));
      const note = document.querySelector('.g-note.comment.active');
      const head = note.querySelector('.note-head').getBoundingClientRect();
      const reply = note.querySelector('[data-testid=g-reply]').getBoundingClientRect();
      return {
        keys: add ? getComputedStyle(add, '::after').display : 'no button',
        inHead: reply.top >= head.top - 6 && reply.bottom <= head.bottom + 6,
        shown: getComputedStyle(note.querySelector('.note-tools')).opacity === '1',
      };
    });
    assert(touch.keys === 'none', `no ⌘↵ on a touch screen: ${JSON.stringify(touch)}`);
    assert(touch.inHead && touch.shown, `Reply in the note's head, there to tap: ${JSON.stringify(touch)}`);
    await sleep(400);
    await shot('06-phone-player');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(300);
    await shot('07-phone-notes');
    await page.goto(`${BASE}/g/${room.token}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.room .film');
    await sleep(500);
    await shot('08-phone-room');
    await page.setViewport({ width: 768, height: 1024, deviceScaleFactor: SHOTS ? 2 : 1 });
    await page.goto(`${BASE}/g/${room.token}#${encodeURIComponent(spot.slug)}`, { waitUntil: 'domcontentloaded' });
    await videoReady();
    await sleep(300);
    await shot('09-tablet-player');
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 });
  });

  // What a phone's page is made of, measured: the bar, the transport, the drawing tools against the picture.
  const phoneLayout = (p) =>
    p.evaluate(() => {
      const shown = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
      const box = (e) => e.getBoundingClientRect();
      const mid = (r) => r.top + r.height / 2;
      const spread = (els) => {
        const ys = els.map((e) => mid(box(e)));
        return Math.max(...ys) - Math.min(...ys);
      };
      const out = (els) => els.filter((e) => box(e).left < -1 || box(e).right > innerWidth + 1).map((e) => e.getAttribute('aria-label') || e.className);
      const bar = document.querySelector('.g-top');
      const barKids = [...bar.querySelectorAll(':scope > *, .g-top-acts > *')].filter(shown).filter((e) => !e.matches('.g-top-acts'));
      const transport = [...document.querySelectorAll('.g-transport button, .g-transport .tc')].filter(shown);
      const tools = document.querySelector('.draw-bar');
      const picture = box(document.querySelector('.vbox'));
      const dim = document.querySelector('.crop .dim');
      return {
        barHeight: Math.round(box(bar).height),
        barPad: parseFloat(getComputedStyle(bar).paddingTop),
        barSpread: Math.round(spread(barKids)),
        barOut: out(barKids),
        barNames: barKids.map((e) => e.getAttribute('aria-label') || e.dataset.testid || e.className),
        transportSpread: Math.round(spread(transport)),
        transportOut: out(transport),
        transportCount: transport.length,
        toolsTop: tools ? Math.round(box(tools).top) : null,
        pictureBottom: Math.round(picture.bottom),
        dimShown: !!dim && shown(dim) && getComputedStyle(dim).display !== 'none',
      };
    });

  await check('a phone’s review page is one app screen: one bar row, the tools under the picture, one transport row (390, 430)', async () => {
    for (const width of [390, 430]) {
      await page.setViewport({ width, height: width === 430 ? 932 : 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await page.goto(`${BASE}/g/${room.token}#${encodeURIComponent(teaser.slug)}`, { waitUntil: 'domcontentloaded' });
      await videoReady();
      const m = await phoneLayout(page);
      // the bar: the mark, the title, Approve and ⋯ on one row; the theme and the other answer aren't in it
      assert(m.barSpread <= 4 && !m.barOut.length && m.barHeight <= 55, `@${width}: one bar row: ${JSON.stringify(m)}`);
      assert(!(await page.$('.g-top .theme-button')) && !(await page.$('.g-top [data-testid=g-changes]')), `@${width}: the bar holds the title and Approve`);
      assert(await page.$('.g-top [data-testid=g-approve]'), `@${width}: Approve stays in the bar`);
      assert(m.transportCount >= 5 && m.transportSpread <= 4 && !m.transportOut.length, `@${width}: one transport row: ${JSON.stringify(m)}`);
      assert(m.toolsTop !== null && m.toolsTop >= m.pictureBottom, `@${width}: the drawing tools sit under the picture, not on it: ${JSON.stringify(m)}`);
      assert(!m.dimShown, `@${width}: no pixel size under the picture`);
      // the play button's glyph in its middle (the triangle with its nudge), playing or not
      const play = glyphProblems(await glyphCentre(page, '.g-transport .playbtn'), `@${width} play`);
      await page.$eval('.vbox video', (v) => {
        v.loop = true;
      });
      await page.click('.g-transport .playbtn');
      await page.waitForSelector('.g-transport .playbtn.playing');
      const pause = glyphProblems(await glyphCentre(page, '.g-transport .playbtn'), `@${width} pause`);
      await page.click('.g-transport .playbtn');
      await page.waitForSelector('.g-transport .playbtn:not(.playing)');
      assert(!play.length && !pause.length, [...play, ...pause].join('\n'));
    }
    // ⋯ holds what the bar gave up: the other answer and the theme
    await page.click('[data-testid=g-more]');
    await page.waitForSelector('.menu[data-state=open] .menu-theme');
    const items = await page.$$eval('.menu[data-state=open] [role^=menuitem]', (els) => els.map((e) => e.textContent.trim()));
    assert(items.includes('Request changes'), `the menu: ${items.join(' · ')}`);
    await page.keyboard.press('Escape');
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 });
  });

  await check('a phone’s bar stays at the top, clear of the status bar and the notch; the foot clears the home indicator', async () => {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    try {
      await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      // an iPhone with a Dynamic Island: env(safe-area-inset-*) as Safari reports it with viewport-fit=cover
      const cdp = await p.createCDPSession();
      await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47, bottom: 34, left: 0, right: 0 } });
      await p.goto(`${BASE}/g/${room.token}#${encodeURIComponent(teaser.slug)}`, { waitUntil: 'domcontentloaded' });
      await p.waitForFunction(() => document.querySelector('.vbox video')?.readyState >= 2, { polling: 100, timeout: 20000 });
      assert((await phoneLayout(p)).barPad >= 47, 'the bar makes room for the status bar');
      // scrolled to the notes, as in the screenshot from Safari that showed "Notes" under the clock
      await p.evaluate(() => window.scrollTo(0, document.querySelector('.g-side-head').getBoundingClientRect().top + scrollY - 10));
      await p.waitForFunction(() => scrollY > 100);
      const top = await p.evaluate(() => {
        const bar = document.querySelector('.g-top').getBoundingClientRect();
        const under = document.elementFromPoint(innerWidth / 2, 20);
        return {
          bar: bar.top,
          bottom: bar.bottom,
          title: document.querySelector('.g-top h1').getBoundingClientRect().top,
          clock: !!under?.closest('.g-top'),
          head: document.querySelector('.g-side-head').getBoundingClientRect().top,
        };
      });
      assert(Math.abs(top.bar) < 1 && top.clock, `the bar is pinned and nothing else sits under the clock: ${JSON.stringify(top)}`);
      assert(top.title >= 47, `the title starts below the status bar: ${JSON.stringify(top)}`);
      await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await p.waitForFunction(() => Math.abs(innerHeight + scrollY - document.documentElement.scrollHeight) < 2);
      const foot = await p.$eval('[data-testid=powered-by]', (e) => innerHeight - e.getBoundingClientRect().bottom);
      assert(foot >= 34, `the foot clears the home indicator (${foot}px from the bottom)`);
      await sleep(300);
      if (SHOTS) await p.screenshot({ path: path.join(SHOTS, '07b-phone-inset-end.png') });
    } finally {
      await ctx.close();
    }
  });

  await check('a visitor without a name who taps Approve is asked in a sheet, then approved under that name', async () => {
    const link = await api(`/api/review/${encodeURIComponent(teaser.slug)}/shares`, 'POST', { label: 'Phone review' });
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    try {
      await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await p.goto(`${BASE}/g/${link.token}`, { waitUntil: 'domcontentloaded' });
      await p.waitForSelector('[data-testid=g-approve]', { visible: true });
      await p.click('[data-testid=g-approve]');
      await p.waitForSelector('.modal .g-name input', { visible: true });
      const ask = await p.$eval('.modal', (e) => e.textContent);
      assert(ask.includes('What’s your name?') && ask.includes('notes from all links'), ask);
      await p.type('.modal .g-name input', 'Noor');
      // The sheet rises from below the screen. With reduced motion that takes 1 ms, but it starts on the next frame, which
      // a busy machine draws late: until then the button lies below the screen, where a click can't land.
      await p.waitForFunction(() =>
        document
          .querySelector('.modal')
          ?.getAnimations({ subtree: true })
          .every((a) => a.playState !== 'running'),
      );
      await p.click('[data-testid=g-name-save]');
      await p.waitForSelector('.g-top .g-verdict[data-status=approved]');
      await until(async () => {
        const { review } = await api(`/api/review/${encodeURIComponent(teaser.slug)}`);
        return JSON.stringify(review).includes('Noor');
      }, 'approved under the name given');
      // closing the sheet without a name decides nothing
      const other = await api(`/api/review/${encodeURIComponent(teaser.slug)}/shares`, 'POST', { label: 'Phone review 2' });
      await p.evaluate(() => localStorage.removeItem('vr.guestName'));
      await p.goto(`${BASE}/g/${other.token}`, { waitUntil: 'domcontentloaded' });
      await p.waitForSelector('[data-testid=g-approve]', { visible: true });
      await p.click('[data-testid=g-approve]');
      await p.waitForSelector('.modal .g-name input', { visible: true });
      await p.keyboard.press('Escape');
      await p.waitForFunction(() => !document.querySelector('.modal'));
      assert(await p.$('[data-testid=g-approve]'), 'still to be decided');
    } finally {
      await ctx.close();
    }
  });

  await check('a client who watches: the owner sees how far on the card and in the activity’s strip; a GPC browser counts like any other', async () => {
    const watchLink = await api('/api/folder-shares', 'POST', { folder: 'Acme/Reels', label: 'Watch party' });
    const gid = (await api(`/api/g/${watchLink.token}`)).videos.find((v) => v.name === 'spot.mp4').slug;
    const infoOf = async () => (await api(`/api/review/${encodeURIComponent(spot.slug)}/shares`)).shares.find((s) => s.token === watchLink.token);
    // A visitor from elsewhere (the machine's own loopback is the owner previewing, which isn't counted), in a browser
    // of their own; plays a second and a half of the 3 s clip, then stops: the stop sends the report.
    const visit = async (headers, init) => {
      const ctx = await browser.createBrowserContext();
      const p = await ctx.newPage();
      await p.setViewport({ width: 1280, height: 800 });
      await p.setExtraHTTPHeaders(headers);
      if (init) await p.evaluateOnNewDocument(init);
      await p.goto(`${BASE}/g/${watchLink.token}#${gid}`, { waitUntil: 'domcontentloaded' });
      await p.waitForFunction(() => document.querySelector('.vbox video')?.readyState >= 2, { polling: 100, timeout: 20000 });
      await p.click('.playbtn');
      await sleep(1500);
      await p.click('.playbtn');
      return { p, ctx };
    };
    const one = await visit({ 'x-forwarded-for': '203.0.113.30' });
    await until(async () => (await infoOf())?.activity.videos.some((v) => v.name === 'spot.mp4' && v.watched >= 0.2), 'the report arrived');
    await one.ctx.close();
    const seen = await infoOf();
    assert(seen.activity.visitors.length === 1, JSON.stringify(seen.activity.visitors));

    // Global Privacy Control changes nothing (decided 2026-10-03): this browser is a visitor like any other.
    const gpc = await visit({ 'x-forwarded-for': '203.0.113.31', 'Sec-GPC': '1' }, () =>
      Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true }),
    );
    await sleep(1500);
    await gpc.ctx.close();
    await until(async () => (await infoOf())?.activity.visitors.length === 2, 'the GPC browser is told apart like any other');

    // the owner: the card's summary says how far, its activity shows the strip
    await page.goto(`${BASE}/#/folder/${encodeURIComponent('Acme/Reels')}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.hero-share');
    await clickText('.hero-share', 'Share folder');
    await page.waitForSelector('.link-row');
    const sum = await page.$$eval(
      '.link-row',
      (rows) => rows.find((r) => r.textContent.includes('Watch party'))?.querySelector('[data-testid=link-sum]')?.textContent,
    );
    assert(sum && /\d+% watched/.test(sum), `the summary says how far: ${sum}`);
    await page.$$eval('.link-row', (rows) =>
      rows
        .find((r) => r.textContent.includes('Watch party'))
        ?.querySelector('[data-testid=link-sum]')
        ?.click(),
    );
    await page.waitForSelector('[data-testid=link-activity] [data-testid=link-watch]');
    const strip = await page.$eval('[data-testid=link-watch]', (e) => ({ text: e.textContent, runs: e.querySelectorAll('.link-heat rect').length }));
    assert(strip.text.includes('spot.mp4') && strip.runs >= 2, `the strip shows what played: ${JSON.stringify(strip)}`);
    await shot('11-link-activity');
    // The open dialog at every width in both themes (fitsAt's phone sizes turn touch on, which reloads the page and would
    // close the dialog; the phone layout itself is width-driven).
    const bad = await layoutMatrix(page, { 'share dialog': null }, { widths: WIDTHS });
    await page.emulateMediaFeatures([]);
    assert(!bad.length, bad.join('\n'));
    await page.keyboard.press('Escape');
  });

  await check('the owner’s share dialog lists the link with its activity', async () => {
    await page.goto(`${BASE}/#/folder/${encodeURIComponent('Acme/Reels')}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.hero-share');
    await clickText('.hero-share', 'Share folder');
    await page.waitForSelector('.link-row');
    // newest first: "Watch party" (the check above) sits over it
    const row = await page.$$eval('.link-row', (rows) => rows.map((e) => e.textContent).find((x) => x.includes('Acme marketing')));
    assert(row?.includes('Mia'), row);
    // who visitors are told the link is from
    const sharer = await page.$eval('[data-testid=link-sharer]', (e) => e.textContent);
    assert(sharer.includes('Visitors see it’s from Sam.'), `the sharer line: ${sharer}`);
    await page.waitForSelector('[data-testid=link-details]');
    await sleep(300);
    await shot('10-share-modal');
    await page.keyboard.press('Escape');
  });

  await check('making a link: one line, three kinds, every setting a row with its name and its switch (↵ and ⌘↵ create)', async () => {
    const folderShares = async () => (await api(`/api/folder-shares?folder=${encodeURIComponent('Acme/Reels')}`)).shares;
    // each row: its name, and what its control says (a switch on or off, the downloads menu's value)
    const rows = () =>
      page.$$eval('.link-new [data-testid=link-details] .link-set-row', (rs) =>
        rs.map((r) => [
          r.querySelector('.link-set-label').childNodes[0].textContent,
          r.querySelector('[role=switch]')?.getAttribute('aria-checked') ?? r.querySelector('.link-set-menu')?.textContent.trim(),
          r.hasAttribute('data-disabled'),
        ]),
      );
    const DEFAULTS = [
      ['Leave notes', 'true', false],
      ['Approve or request changes', 'true', false],
      ['See notes from other links', 'false', false],
      ['All versions, to switch and compare', 'false', false],
      ['Downloads', 'Off', false],
      ['Expiry date', 'false', false],
      ['Password', 'false', false],
    ];
    const box = () => page.$eval('.link-new [data-testid=link-details]', (e) => Math.round(e.getBoundingClientRect().height));
    await page.goto(`${BASE}/#/folder/${encodeURIComponent('Acme/Reels')}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.hero-share');
    await clickText('.hero-share', 'Share folder');
    await page.waitForSelector('[data-testid=link-name]');
    // every setting in view, as a row with its name (no Customise, no sentence to decode); one segmented row, the kind
    assert(JSON.stringify(await rows()) === JSON.stringify(DEFAULTS), `the defaults: ${JSON.stringify(await rows())}`);
    assert(!(await page.$('.link-customise, [data-testid=link-summary]')), 'no Customise');
    assert((await page.$$('.link-new .seg')).length === 1, 'one row of kinds');
    const where = await page.$eval('[data-testid=link-where]', (e) => e.textContent);
    assert(/Links open on (this computer only|your network)/.test(where), `where links open, said plainly: ${where}`);
    // a kind sets the switches: watch only turns notes off, and what depends on them is shown off and can't be changed
    await clickText('.link-kind .seg button, .link-kind .seg [role=radio]', 'Watch only');
    await until(async () => {
      const r = await rows();
      return r[0][1] === 'false' && r[1][1] === 'false' && r[1][2] && r[2][2];
    }, 'the switches follow the kind');
    await page.click('[data-testid=link-name]');
    await page.keyboard.type('Screening room');
    await page.keyboard.press('Enter');
    await until(async () => (await folderShares()).some((s) => s.label === 'Screening room'), 'created by ↵');
    const watch = (await folderShares()).find((s) => s.label === 'Screening room');
    assert(!watch.comment && !watch.approve && watch.download === 'off' && !watch.password && !watch.expires, `watch only: ${JSON.stringify(watch)}`);
    // the settings, each in its row; nothing moves while they change (the block keeps its height)
    await until(async () => JSON.stringify(await rows()) === JSON.stringify(DEFAULTS), 'a new form after the link');
    const tall = await box();
    await page.click('[data-testid=link-name]');
    await page.keyboard.type('Hand-off test');
    await page.click('.link-new [aria-label^="Downloads:"]');
    await page.waitForSelector('.menu[data-state=open] [role=menuitem]');
    await clickText('.menu[data-state=open] [role=menuitem]', 'Preview');
    await until(async () => (await rows())[4][1] === 'Preview', 'the downloads menu shows the choice');
    // the expiry: on, a week out, its button says the day; its choices open over the page (1, 7, 30 days, the calendar)
    await press('.link-new [data-testid=link-expiry] [role=switch]');
    await page.waitForSelector('.link-new [data-testid=link-date]');
    const date = await page.$eval('.link-new [data-testid=link-date]', (e) => e.textContent);
    assert(/in 7 days/.test(date), `an expiry starts a week out: ${date}`);
    await page.click('.link-new [data-testid=link-date]');
    await page.waitForSelector('[data-testid=link-date-choices] .rdp-root', { timeout: 10000 });
    const quick = await page.$$eval('[data-testid=link-date-choices] .link-date-quick button', (bs) => bs.map((b) => b.textContent.trim()));
    assert(quick.join(',') === '1 day,7 days,30 days', `the quick choices: ${quick}`);
    await clickText('[data-testid=link-date-choices] .link-date-quick button', '7 days');
    await page.waitForSelector('[data-testid=link-date-choices]', { hidden: true });
    // the password: on, one is made up at once, readable (it is sent to people); Generate makes another
    await press('.link-new [data-testid=link-password] [role=switch]');
    await page.waitForSelector('.link-new [data-testid=link-password] input');
    const made = await page.$eval('.link-new [data-testid=link-password] input', (e) => e.value);
    assert(/^[a-z]+-[a-z]+-[a-z]+-\d{2}$/.test(made), `a password made up: ${made}`);
    await page.click('.link-new [data-testid=link-password] [aria-label="Generate a password"]');
    await until(async () => (await page.$eval('.link-new [data-testid=link-password] input', (e) => e.value)) !== made, 'Generate makes another');
    assert((await box()) === tall, `the settings kept their height: ${tall} → ${await box()}`);
    // too short: ⌘↵ makes no link, and its row says why
    await page.$eval('.link-new [data-testid=link-password] input', (e) => e.select());
    await page.keyboard.type('abc');
    const before = (await folderShares()).length;
    await page.keyboard.down('Meta');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Meta');
    await page.waitForSelector('.link-new [data-testid=link-password] .link-pass.bad input[aria-invalid=true]');
    const say = await page.$eval('.link-new [data-testid=link-password] .link-set-say', (e) => e.textContent);
    assert(say === 'At least 4 characters', `said on its row: ${say}`);
    assert((await folderShares()).length === before, 'no link with a password too short to keep');
    await page.type('.link-new [data-testid=link-password] input', 'secret1');
    await page.waitForSelector('.link-new [data-testid=link-password] .link-pass:not(.bad)');
    await page.$eval('.link-new [data-testid=link-password] input', (e) => e.focus());
    await page.keyboard.down('Meta');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Meta');
    await until(async () => (await folderShares()).some((s) => s.label === 'Hand-off test'), 'created by ⌘↵');
    const handoff = (await folderShares()).find((s) => s.label === 'Hand-off test');
    const ends = new Date(handoff.expires);
    const week = new Date();
    week.setDate(week.getDate() + 7);
    assert(
      handoff.comment &&
        handoff.approve &&
        handoff.download === 'preview' &&
        handoff.password &&
        ends.toDateString() === week.toDateString() &&
        ends.getHours() === 23,
      `as set: ${JSON.stringify(handoff)}`,
    );
    // made: the form is back to its defaults, nothing it had on left on (an expiry stayed open, "Never expires")
    await until(async () => JSON.stringify(await rows()) === JSON.stringify(DEFAULTS), 'back to the defaults');
    await shot('12-share-created');
    await page.keyboard.press('Escape');
  });

  await check('Change link opens the link as its own page in the dialog: the same rows, Save, and back to the list', async () => {
    const folderShares = async () => (await api(`/api/folder-shares?folder=${encodeURIComponent('Acme/Reels')}`)).shares;
    await page.goto(`${BASE}/#/folder/${encodeURIComponent('Acme/Reels')}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.hero-share');
    await clickText('.hero-share', 'Share folder');
    await page.waitForSelector('.link-row');
    const height = () => page.$eval('.modal', (e) => Math.round(e.getBoundingClientRect().height));
    await settle(page);
    const listed = await height();
    const more = await page.evaluateHandle(() =>
      [...document.querySelectorAll('.link-row')].find((r) => r.textContent.includes('Hand-off test')).querySelector('[aria-haspopup=menu]'),
    );
    await more.click();
    await page.waitForSelector('.menu[data-state=open] [role=menuitem]');
    await clickText('.menu[data-state=open] [role=menuitem]', 'Change link');
    await page.waitForSelector('[data-testid=link-change]');
    // the list is still there under it, hidden: the dialog didn't change its height
    await settle(page);
    assert((await height()) === listed, `the dialog kept its height: ${listed} → ${await height()}`);
    assert((await page.$eval('[data-testid=link-change-name]', (e) => e.value)) === 'Hand-off test', 'its name');
    const pw = await page.$eval('[data-testid=link-change] [data-testid=link-password]', (e) => e.textContent);
    assert(pw.includes('Set') && pw.includes('Change'), `a password that can't be shown again says it is set: ${pw}`);
    await page.click('[data-testid=link-change] [data-testid=link-password] [role=switch]');
    await page.$eval('[data-testid=link-change-name]', (e) => e.select());
    await page.keyboard.type('Hand-off, no password');
    await page.click('[data-testid=link-save]');
    await page.waitForSelector('[data-testid=link-change]', { hidden: true });
    const changed = (await folderShares()).find((s) => s.label === 'Hand-off, no password');
    assert(changed && !changed.password, `saved: ${JSON.stringify(changed)}`);
    await page.keyboard.press('Escape');
  });

  await check('the next link started while the last one is still coming back keeps what was typed', async () => {
    const folderShares = async () => (await api(`/api/folder-shares?folder=${encodeURIComponent('Acme/Reels')}`)).shares;
    // A create resolves only once the links list has been asked again; hold that answer, as a busy server would.
    let hold = false;
    const slow = async (req) => {
      if (hold && req.method() === 'GET' && req.url().includes('/api/folder-shares')) await sleep(1500);
      req.continue().catch(() => {});
    };
    await page.setRequestInterception(true);
    page.on('request', slow);
    try {
      await page.goto('about:blank');
      await page.goto(`${BASE}/#/folder/${encodeURIComponent('Acme/Reels')}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.hero-share');
      await clickText('.hero-share', 'Share folder');
      await page.waitForSelector('[data-testid=link-name]');
      await page.click('[data-testid=link-name]');
      await page.keyboard.type('Race one');
      hold = true;
      await page.keyboard.press('Enter');
      await until(async () => (await folderShares()).some((s) => s.label === 'Race one'), 'the first link on the server');
      assert((await page.$eval('[data-testid=link-name]', (e) => e.value)) === '', 'the form clears as the link is sent');
      await page.click('[data-testid=link-name]');
      await page.keyboard.type('Race two');
      await page.click('.link-new [data-testid=link-expiry] [role=switch]');
      await page.waitForSelector('.link-new [data-testid=link-date]');
      await sleep(2500); // the held list comes back, and the first create resolves
      const after = await page.evaluate(() => ({
        name: document.querySelector('[data-testid=link-name]')?.value,
        details: !!document.querySelector('.link-new [data-testid=link-date]'),
      }));
      assert(after.name === 'Race two' && after.details, `the next link survives the last one's answer: ${JSON.stringify(after)}`);
      assert((await folderShares()).filter((s) => s.label === 'Race one').length === 1, 'one link made, not two');
      await page.keyboard.press('Escape');
    } finally {
      hold = false;
      page.off('request', slow);
      await page.setRequestInterception(false);
    }
  });

  await check('Settings → Review links lists every link still out there — one whose video went outside the app too — and revokes it', async () => {
    // a video whose review was removed by hand (an older app, a hand-edited store): its link opens nothing now
    const gone = await add('Gone/export/promo.mp4', 'Gone');
    const orphan = await api(`/api/review/${encodeURIComponent(gone.slug)}/shares`, 'POST', { label: 'Old promo' });
    fs.rmSync(path.join(env.VR_DATA, gone.slug), { recursive: true });
    await page.goto(`${BASE}/#/settings/links`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=links-list]');
    const rows = () => page.$$eval('[data-testid=link-row]', (r) => r.map((e) => ({ text: e.textContent, gone: e.hasAttribute('data-gone') })));
    const before = await rows();
    assert(
      before.some((r) => r.text.includes('Acme marketing') && r.text.includes('Folder Acme/Reels') && !r.gone),
      JSON.stringify(before),
    );
    const old = before.find((r) => r.text.includes('Old promo'));
    assert(old?.gone && old.text.includes('Its video was deleted: it opens nothing'), `the gone link is listed as such: ${JSON.stringify(old)}`);
    const fit = await fitsAt(page, 'review links');
    assert(!fit.length, fit.join('\n'));
    await shot('11-settings-review-links');
    // Revoke is in the line's menu
    const more = await page.evaluateHandle(() =>
      [...document.querySelectorAll('[data-testid=link-row]')].find((e) => e.textContent.includes('Old promo')).querySelector('[aria-haspopup=menu]'),
    );
    await more.click();
    await page.waitForSelector('.menu[data-state=open] [role=menuitem]');
    const items = await page.$$eval('.menu[data-state=open] [role=menuitem]', (els) => els.map((e) => e.textContent.trim()));
    assert(JSON.stringify(items) === JSON.stringify(['Revoke']), `a gone link can only be revoked: ${items}`);
    await clickText('.menu[data-state=open] [role=menuitem]', 'Revoke');
    await page.waitForSelector('[data-testid=confirm]', { timeout: 5000 });
    const ask = await page.$eval('[data-testid=confirm] h3', (e) => e.textContent);
    assert(ask === 'Revoke “Old promo”?', ask);
    await clickText('[data-testid=confirm] button', 'Revoke link');
    await until(async () => !(await rows()).some((r) => r.text.includes('Old promo')), 'the revoked link leaves the list');
    const r = await fetch(`${BASE}/api/g/${orphan.token}`, { headers: { 'x-forwarded-for': '203.0.113.5' } });
    assert(r.status === 404, `revoked: ${r.status}`);
  });

  await check('a fixed note keeps the room of its marked frame before the picture arrives: “Looks right” under it stays put', async () => {
    // An upright reel: its marked frame stands taller than the note's words and status line beside it, so a card that
    // made room only once the picture landed moved the buttons under a visitor's tap.
    const reel = await add('Upright/export/reel.mp4', 'Upright', { w: 180, h: 320, pattern: 'smptebars' });
    const share = (body) => api(`/api/review/${encodeURIComponent(reel.slug)}/shares`, 'POST', { notes: 'all', ...body });
    // the note's own version is listed where the link shows every version; a newest-only link lists V2 alone
    const links = [
      { label: 'Reel', versions: 'all', viewport: { width: 1440, height: 900 } },
      { label: 'Reel newest', viewport: { width: 390, height: 844, isMobile: true, hasTouch: true } },
    ];
    for (const l of links) l.token = (await share({ label: l.label, ...(l.versions ? { versions: l.versions } : {}) })).token;
    const gid = (await api(`/api/g/${links[0].token}`)).videos[0].slug;
    const note = await api(`/api/g/${links[0].token}/comments`, 'POST', { name: 'Mia', slug: gid, v: 1, frame: 12, text: 'Kürzer' });
    makeVideo(reel.file, { w: 180, h: 320, fps: 30, dur: 3, pattern: 'smptebars', freq: 880 });
    age(reel.file);
    assert((await api(`/api/review/${encodeURIComponent(reel.slug)}/sync`, 'POST')).review.versions.length === 2, 'a second version');
    await api(`/api/comments/${note.id}`, 'PATCH', { status: 'fixed', by: 'agent:edit' });
    const problems = [];
    for (const l of links) {
      const p = await browser.newPage();
      p.on('pageerror', (e) => errors.push(e.message));
      try {
        await p.setViewport(l.viewport);
        await p.setCacheEnabled(false);
        // the picture comes late (a busy server, a slow line): held back until the card is drawn and measured
        const held = [];
        let holding = true;
        await p.setRequestInterception(true);
        p.on('request', (r) => {
          if (holding && r.resourceType() === 'image' && r.url().includes('/data/g/')) held.push(r);
          else r.continue().catch(() => {});
        });
        await p.goto(`${BASE}/g/${l.token}`, { waitUntil: 'domcontentloaded' });
        await p.waitForSelector('.g-note .g-check .btn.ok');
        await p.evaluate(() => document.fonts.ready);
        const where = () =>
          p.$eval('.g-note', (card) => {
            const img = card.querySelector('.c-thumb');
            return {
              button: card.querySelector('.g-check .btn.ok').getBoundingClientRect().top,
              thumb: img.getBoundingClientRect().height,
              thumbW: img.getBoundingClientRect().width,
              loaded: img.complete,
            };
          });
        const before = await where();
        assert(!before.loaded, `${l.label}: the picture is still on its way`);
        holding = false;
        for (const r of held.splice(0)) r.continue().catch(() => {});
        await p.waitForFunction(() => document.querySelector('.g-note .c-thumb')?.naturalWidth > 0, { timeout: 10000 });
        const after = await where();
        // as wide as the app's card's picture, in the reel's shape
        if (before.thumbW < 90 || Math.abs(before.thumb - (before.thumbW * 320) / 180) > 1 || Math.abs(after.button - before.button) > 0.5)
          problems.push(`${l.label} at ${l.viewport.width}: ${JSON.stringify({ before, after })}`);
      } finally {
        await p.close();
      }
    }
    assert(!problems.length, `the card keeps its picture's room, and nothing moves when it arrives: ${problems.join(' | ')}`);
  });

  await check('no page errors along the way', async () => {
    assert(!errors.length, errors.join(' | '));
  });
} catch (e) {
  crashed(e, srv);
} finally {
  await finish(LABEL, { browser, servers: [srv] });
}
