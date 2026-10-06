#!/usr/bin/env node
// covers: web/src/guest/GuestNotes.tsx web/src/guest/GuestPlayer.tsx web/src/guest/Room.tsx web/src/styles/guest.css web/src/styles/notes.css web/src/player/CommentCard.tsx web/src/i18n/de.client.ts
// Browser end-to-end test of how a review link looks next to the app: a real server (local mode, temp store, free
// port) + headless Chrome. A note on the link is the app's note — a row at rest, the card opened (same padding, type,
// timecode chip, a person's name in the UI face, the marked frame's size) —; a fix waiting for the visitor's check
// asks on one line and answers with both buttons together, also on a phone and in German; the replies reach the card's
// edge; opening Still wrong moves nothing above it; the states are words with a capital ("Fixed · V2", green), an agent
// is "Editor" ("Schnitt" in German) and German never says "on V1". The list under a fresh composer says how, not
// "No notes yet". After Approve the thank-you lies centred on the picture, clear of the drawing tools. A delivery shows
// its Download on a phone, and a link without notes ends with its foot at the bottom of the screen. The folder room
// grows with a wide screen, and a phone's room cards have no dead band. Screenshots land in VR_SHOTS when it is set.
import path from 'node:path';
import { age, makeVideo } from '../lib/helpers.ts';
import { settle } from './layout.mjs';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'guest-look e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-guest-look-e2e-', user: 'Sam' });
const { dir, base: BASE } = srv;
const api = jsonApi(BASE);

const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: SHOTS ? 2 : 1 };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

let browser;
let page;
screenshotFailures(() => page, 'guest-look');
try {
  const add = async (rel, folder, opts = {}) => {
    const file = makeVideo(path.join(dir, rel), { w: 320, h: 180, fps: 25, dur: 3, pattern: 'testsrc2', ...opts });
    age(file);
    const { video } = await api('/api/library', 'POST', { path: file });
    if (folder) await api(`/api/review/${encodeURIComponent(video.slug)}/folder`, 'PUT', { folder });
    return { file, slug: video.slug };
  };
  const film = await add('Spot/export/film.mp4', 'Spot');
  const enc = encodeURIComponent(film.slug);
  const review = await api(`/api/review/${enc}/shares`, 'POST', { label: 'Spring launch', versions: 'all' });
  const gid = (await api(`/api/g/${review.token}`)).videos[0].slug;
  // Mia's notes on V1: one with a marked frame (fixed by an agent in V2, waiting for her check), one the team answers
  const post = (body) => api(`/api/g/${review.token}/comments`, 'POST', { name: 'Mia', slug: gid, drawing: [], ...body });
  const logo = await post({
    frame: 30,
    text: 'The logo comes in a beat too early — please only after the cut to the wide shot.',
    drawing: [{ type: 'box', x: 40, y: 30, w: 120, h: 60 }],
  });
  const music = await post({ frame: 60, text: 'The music is too abrupt; a softer fade-in, please.' });
  await api(`/api/comments/${music.id}`, 'PATCH', { note: 'Sure, I will soften it in the next version.' });
  makeVideo(film.file, { w: 320, h: 180, fps: 25, dur: 3, pattern: 'testsrc2', freq: 880 });
  age(film.file);
  await api(`/api/review/${enc}/sync`, 'POST');
  await api(`/api/comments/${logo.id}`, 'PATCH', { status: 'fixed', note: 'The logo now comes in 8 frames later.', by: 'agent:edit' });
  const delivery = await api(`/api/review/${enc}/shares`, 'POST', { label: 'Delivery', comment: false, approve: false, download: 'original' });
  const fresh = await add('Fresh/export/fresh.mp4', null);
  const first = await api(`/api/review/${encodeURIComponent(fresh.slug)}/shares`, 'POST', { label: 'First look' });
  for (const n of [1, 2, 3, 4]) await add(`Room/export/cut-${n}.mp4`, 'Room', { pattern: n % 2 ? 'smptebars' : 'testsrc2' });
  const room = await api('/api/folder-shares', 'POST', { folder: 'Room', label: 'All the cuts' });

  browser = await launch();
  const errors = [];
  const open = async (url, viewport = DESKTOP, lang = null) => {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));
    await p.setViewport(viewport);
    await p.evaluateOnNewDocument((lang) => {
      try {
        localStorage.setItem('vr.zoomhint', '{"seen":true}');
        localStorage.setItem('vr.guestName', 'Mia');
        if (lang) localStorage.setItem('vr.lang', lang);
      } catch {}
    }, lang);
    await p.goto(BASE + url, { waitUntil: 'domcontentloaded' });
    page = p;
    return p;
  };
  const ready = (p) => p.waitForFunction(() => [...document.querySelectorAll('.stage video')].some((v) => v.readyState >= 2), { timeout: 20000 });
  const shot = async (p, name) => SHOTS && p.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  const close = (p) => p.browserContext().close();

  /** The measurements of an opened note card and of a row, the same way on both pages. */
  const measure = (p, card, row) =>
    p.evaluate(
      (card, row) => {
        const st = (el, ...props) => {
          if (!el) return null;
          const s = getComputedStyle(el);
          return Object.fromEntries(props.map((x) => [x, s[x]]));
        };
        const c = document.querySelector(card);
        const r = document.querySelector(row);
        const thumb = c?.querySelector('.c-thumb')?.getBoundingClientRect();
        return {
          card: st(c, 'paddingTop', 'paddingLeft', 'borderRadius', 'rowGap'),
          who: st(c?.querySelector('.note-who b'), 'fontFamily', 'fontSize', 'fontWeight'),
          tc: st(c?.querySelector('.note-meta .c-tc'), 'fontFamily', 'fontSize', 'fontWeight', 'paddingLeft'),
          text: st(c?.querySelector('.c-text'), 'fontSize', 'lineHeight'),
          thumbW: thumb ? Math.round(thumb.width) : null,
          stub: st(c?.querySelector('.reply-stub'), 'height', 'fontSize'),
          row: r ? Math.round(r.getBoundingClientRect().height) : null,
          rowTc: st(r?.querySelector('.nr-tc'), 'fontFamily', 'fontSize'),
          rowText: st(r?.querySelector('.nr-text'), 'fontSize'),
        };
      },
      card,
      row,
    );

  console.log(`guest-look e2e against ${BASE} (store ${dir})`);

  await check('a note on the link is the app’s note: a row at rest, the opened card with the same padding, type, chip and picture size', async () => {
    const app = await open(`/#/v/${enc}?c=${logo.id}`);
    await app.waitForSelector(`.comment.note.active[data-note="${logo.id}"]`, { timeout: 20000 });
    await app.waitForFunction(() => document.querySelector('.comment.note.active .c-thumb')?.complete, { timeout: 10000 });
    await settle(app);
    const own = await measure(app, '.comment.note.active', '.note-row');
    await close(app);
    const link = await open(`/g/${review.token}`);
    await ready(link);
    // the visitor's own note waiting for their check is open; the other one is a row
    await link.waitForSelector(`.g-note.comment[data-note="${logo.id}"]`);
    await link.click(`.g-note.comment[data-note="${logo.id}"] .c-text`);
    await link.waitForSelector(`.g-note.comment.active[data-note="${logo.id}"] .reply-stub`);
    await settle(link);
    const theirs = await measure(link, '.g-note.comment.active', '.g-note.note-row');
    await shot(link, 'look-01-notes');
    const diff = Object.keys(own).filter((k) => JSON.stringify(own[k]) !== JSON.stringify(theirs[k]));
    assert(
      !diff.length,
      `the link's card measures as the app's: ${diff.map((k) => `${k}: app ${JSON.stringify(own[k])} · link ${JSON.stringify(theirs[k])}`).join(' | ')}`,
    );
    assert(!/mono/i.test(theirs.who.fontFamily), `a person's name in the UI face, not the ids' mono: ${theirs.who.fontFamily}`);
    assert(theirs.thumbW >= 90, `the marked frame large enough to read: ${theirs.thumbW}`);
    // the replies reach the card's edge, as its words and picture do
    const edges = await link.$eval(`.g-note.comment.active`, (c) => {
      const body = c.querySelector('.note-body').getBoundingClientRect().right;
      return { body, replies: [...c.querySelectorAll('[data-testid=reply]')].map((r) => r.getBoundingClientRect().right) };
    });
    assert(edges.replies.length && edges.replies.every((r) => Math.abs(r - edges.body) <= 1), `the replies end at the card's edge: ${JSON.stringify(edges)}`);
    await close(link);
  });

  await check('a fix waiting for the visitor: the question on its line, Looks right and Still wrong together; states in words', async () => {
    for (const [viewport, lang, where] of [
      [PHONE, null, 'iPhone 390'],
      [PHONE, 'de', 'iPhone 390 German'],
      [DESKTOP, 'de', '1440 German'],
      [DESKTOP, null, '1440'],
    ]) {
      const p = await open(`/g/${review.token}`, viewport, lang);
      await ready(p);
      await p.waitForSelector('.g-check .check-decision .btn.ok');
      const m = await p.evaluate(() => {
        const q = document.querySelector('.g-check-q').getBoundingClientRect();
        const [a, b] = [...document.querySelectorAll('.g-check .check-decision .btn')].map((x) => x.getBoundingClientRect());
        const card = document.querySelector('.g-check').closest('.g-note');
        return {
          together: Math.abs(a.top - b.top) < 1,
          below: a.top >= q.bottom - 1,
          inside: b.right <= card.getBoundingClientRect().right,
          state: card.querySelector('.note-state')?.textContent,
          tone: card.querySelector('.note-state')?.getAttribute('data-tone'),
          editor: card.querySelector('.act-line b')?.textContent,
          text: document.querySelector('.side').innerText,
        };
      });
      assert(m.together && m.below && m.inside, `${where}: both answers on one line under the question: ${JSON.stringify({ ...m, text: undefined })}`);
      const de = lang === 'de';
      assert(
        m.state === (de ? 'Korrigiert · V2' : 'Fixed · V2') && m.tone === 'ok',
        `${where}: the state a word with a capital, in green: ${m.state} ${m.tone}`,
      );
      assert(m.editor === (de ? 'Schnitt' : 'Editor'), `${where}: the agent as the editor, in the page's words: ${m.editor}`);
      if (de)
        assert(!/\bon V\d|\beditor\b/.test(m.text), `${where}: no English on a German page: ${m.text.match(/.{20}\bon V\d.{0,10}|.{20}\beditor\b/)?.[0]}`);
      await shot(p, `look-02-check-${where.replace(/\W+/g, '-')}`);
      // Still wrong: the reason opens below; nothing above it moves
      if (viewport === DESKTOP && !de) {
        const before = await p.$eval('.g-check', (e) => {
          const c = e.closest('.g-note');
          return JSON.stringify(
            [c.querySelector('.note-head'), c.querySelector('.note-meta'), c.querySelector('.note-body')].map((x) => x.getBoundingClientRect().toJSON()),
          );
        });
        await p.evaluate(() => [...document.querySelectorAll('.g-check .check-decision .btn')][1].click());
        await p.waitForSelector('.g-note .note-editor textarea');
        const after = await p.$eval('.g-note .note-editor', (e) => {
          const c = e.closest('.g-note');
          return JSON.stringify(
            [c.querySelector('.note-head'), c.querySelector('.note-meta'), c.querySelector('.note-body')].map((x) => x.getBoundingClientRect().toJSON()),
          );
        });
        assert(before === after, `opening Still wrong moves nothing above it: ${before} → ${after}`);
      }
      await close(p);
    }
  });

  await check('a fresh link: the composer is the invitation, the list says how — not “No notes yet” under it', async () => {
    const p = await open(`/g/${first.token}`);
    await ready(p);
    await p.waitForSelector('.g-composer');
    const m = await p.evaluate(() => ({
      empty: !!document.querySelector('.side .empty, .side .empty-title, .side .empty-art'),
      how: document.querySelector('[data-testid=g-notes-empty]')?.textContent ?? '',
    }));
    assert(!m.empty && /Pause where something should change/.test(m.how), `the how-to without an empty state: ${JSON.stringify(m)}`);
    await close(p);
  });

  await check('after Approve the thank-you lies on the picture, centred on it, clear of the drawing tools', async () => {
    const p = await open(`/g/${first.token}`);
    await ready(p);
    await p.click('[data-testid=g-approve]');
    await p.waitForSelector('.g-thanks');
    await settle(p);
    const m = await p.evaluate(() => {
      const r = (s) => document.querySelector(s)?.getBoundingClientRect();
      const thanks = r('.g-thanks');
      const stage = r('.stage');
      const tools = r('.draw-bar');
      const meets = (a, b) => !!a && !!b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      return {
        offCentre: Math.abs(thanks.left + thanks.width / 2 - (stage.left + stage.width / 2)),
        onStage: thanks.top >= stage.top && thanks.bottom <= stage.bottom,
        overTools: meets(thanks, tools),
      };
    });
    assert(m.offCentre < 2 && m.onStage && !m.overTools, `the thank-you: ${JSON.stringify(m)}`);
    await shot(p, 'look-03-thanks');
    await close(p);
  });

  await check('a delivery on a phone shows its Download; a link without notes ends with its foot at the bottom', async () => {
    const p = await open(`/g/${delivery.token}`, PHONE);
    await ready(p);
    await settle(p);
    const m = await p.evaluate(() => {
      const b = document.querySelector('.g-top [data-testid=g-download]')?.getBoundingClientRect();
      const foot = document.querySelector('.g-player > .g-foot').getBoundingClientRect();
      return {
        download: !!b && b.width > 0 && b.right <= innerWidth && document.querySelector('[data-testid=g-download]').textContent.includes('Download'),
        footBottom: Math.round(foot.bottom + scrollY),
        page: document.documentElement.scrollHeight,
        screen: innerHeight,
      };
    });
    assert(m.download, `the Download in the bar: ${JSON.stringify(m)}`);
    assert(m.page >= m.screen && Math.abs(m.footBottom - m.page) <= 1, `the foot is the page's end, at least the screen's: ${JSON.stringify(m)}`);
    await shot(p, 'look-04-delivery-phone');
    await close(p);
  });

  await check('the folder room grows with a wide screen; on a phone its cards have no dead band', async () => {
    const wide = await open(`/g/${room.token}`, { width: 2560, height: 1440 });
    await wide.waitForSelector('.room .film');
    await settle(wide);
    const w = await wide.evaluate(() => {
      const cards = [...document.querySelectorAll('.room .film')].map((e) => e.getBoundingClientRect());
      const foot = document.querySelector('.room-scroll > .g-foot').getBoundingClientRect();
      return {
        row: Math.round(Math.max(...cards.map((c) => c.right)) - Math.min(...cards.map((c) => c.left))),
        foot: Math.round(foot.bottom),
        screen: innerHeight,
      };
    });
    assert(w.row >= 2560 * 0.6, `four videos fill a row across the room: ${JSON.stringify(w)}`);
    assert(w.foot >= w.screen - 70, `the foot at the bottom: ${JSON.stringify(w)}`);
    await shot(wide, 'look-05-room-2560');
    await close(wide);
    const phone = await open(`/g/${room.token}`, PHONE);
    await phone.waitForSelector('.room .film');
    await settle(phone);
    const feet = await phone.$$eval('.room .film-foot', (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    assert(
      feet.every((h) => h <= 24),
      `one line under each card: ${feet}`,
    );
    await shot(phone, 'look-06-room-phone');
    await close(phone);
  });

  await check('no page errors', async () => {
    assert(!errors.length, errors.join('\n'));
  });
} catch (e) {
  crashed(e, srv);
}
await finish(LABEL, { browser, servers: [srv] });
