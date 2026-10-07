// The screens quality.mjs (its rules) and quality-load.mjs (the start's size, layout shift, skeleton → content) check, on
// three throwaway servers: the team's (two renders in a project, notes, a reply, review links, an empty folder) and two
// first runs (onboarding/): someone new on its setup (Welcome), and back in the library with a video in it and the setup
// done (Get started above the videos). One place, so the two suites check the same screens.
import path from 'node:path';
import { age, makeVideo, sleep } from '../../lib/helpers.ts';
import { settle } from '../layout.mjs';
import { jsonApi } from './api.mjs';
import { launch } from './browser.mjs';
import { assert } from './checks.mjs';
import { push } from './filesStore.mjs';
import { startServer } from './server.mjs';

/** The three servers, started before a suite's try as any suite starts its own: `servers` for crashed/finish; `browser`
 * is set by qualityScreens (and follows a relaunch). */
export async function qualityServers(name) {
  const srv = await startServer({ prefix: `vr-${name}-e2e-`, user: 'Sam' });
  const [first, firstStrip] = await Promise.all([
    startServer({ prefix: `vr-${name}-first-e2e-`, user: 'Sam', onboarding: true }),
    startServer({ prefix: `vr-${name}-strip-e2e-`, user: 'Sam', onboarding: true }),
  ]);
  return { srv, first, firstStrip, servers: [srv, first, firstStrip], BASE: srv.base, browser: null };
}

/** The screens seeded and Chrome open: what the checks use (inside the suite's try, so a failure here is reported). */
export async function qualityScreens(q) {
  const { srv, first, firstStrip, BASE } = q;
  const { dir } = srv;
  const api = jsonApi(BASE);
  // Two renders in a project folder, one with notes and a reply, and a review link.
  const film = makeVideo(path.join(dir, 'Acme/film/export/spot.mp4'), { dur: 2 });
  const reel = makeVideo(path.join(dir, 'Acme/social/export/reel.mp4'), { dur: 2, w: 180, h: 320 });
  age(film);
  age(reel);
  const a = (await api('/api/library', 'POST', { path: film, folder: 'Acme' })).video.slug;
  await api('/api/library', 'POST', { path: reel, folder: 'Acme' });
  const note = await api(`/api/review/${encodeURIComponent(a)}/comments`, 'POST', { frame: 12, text: 'Logo a touch smaller', severity: 'must' });
  await api(`/api/review/${encodeURIComponent(a)}/comments`, 'POST', { frame: 30, text: 'Warmer grade here', severity: 'should' });
  // an agent's reply, so the thread (and its layout) is part of the checks
  await api(`/api/comments/${note.comment?.id ?? note.id}`, 'PATCH', { note: 'On it', by: 'agent:spot-edit' });
  const link = await api(`/api/review/${encodeURIComponent(a)}/shares`, 'POST', { label: 'Acme marketing' });
  // and one with a password: the invitation in front of a review is a screen of its own
  const locked = await api(`/api/review/${encodeURIComponent(a)}/shares`, 'POST', { label: 'Board cut', password: 'letmein' });
  // an empty folder inside the project: a folder page's crumb, its Videos · Playbook tabs and Share, and an empty state
  await api('/api/folders', 'POST', { path: 'Acme/Archive' });
  // a project's files: a folder of brand files and a brief (the Files tab's rows)
  await push(BASE, 'Acme', {
    'Brand/Logo primary.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    'Brand/Acme Sans.otf': Buffer.alloc(4096, 7),
    'Brief v3.txt': Buffer.from('Spring sale, 30 s and 15 s cuts.\n'),
  });
  const stripFilm = makeVideo(path.join(firstStrip.dir, 'Acme/export/spot.mp4'), { dur: 1 });
  age(stripFilm);
  const added = await fetch(`${firstStrip.base}/api/library`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: stripFilm, folder: 'Acme' }),
  });
  assert(added.ok, `a video for Get started: ${added.status}`);
  const setupDone = await fetch(`${firstStrip.base}/api/onboarding`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setup: 'done' }),
  });
  assert(setupDone.ok, `the setup done: ${setupDone.status}`);

  const SCREENS = {
    library: '/#/',
    player: `/#/v/${encodeURIComponent(a)}`,
    inbox: '/#/inbox',
    insights: '/#/insights',
    'client link': `/g/${link.token}`,
    'client gate': `/g/${locked.token}`,
    // an empty state standing in for a view's content (an agent with no videos here)
    'empty view': '/#/session/nobody',
    'empty folder': `/#/folder/${encodeURIComponent('Acme/Archive')}`,
    // a folder's playbook: the document beside what agents read
    'folder playbook': `/#/playbook/${encodeURIComponent('Acme')}`,
    // a project's files: the numbers line, the place and kinds, the rows
    'folder files': `/#/files/${encodeURIComponent('Acme')}`,
    // on their own servers (whole addresses)
    'first run': `${first.base}/#/welcome`,
    'get started': `${firstStrip.base}/#/`,
  };
  const urlOf = (screen) => (SCREENS[screen].startsWith('http') ? SCREENS[screen] : BASE + SCREENS[screen]);
  const ready = {
    library: '.film, .lrow',
    player: '.side-scroll .note:not(.pending)',
    inbox: '[data-testid=inbox-view] :is(.inbox-row:not(.pending), .fy-item:not(.pending), .empty-state)',
    insights: '[data-testid=insights]',
    'client link': 'video',
    'client gate': '.invite h1',
    'empty view': '.lib-scroll .empty-state',
    'empty folder': '.lib-scroll .empty-state',
    'folder playbook': '[data-testid=playbook][aria-busy=false] .pb-sheet',
    'folder files': '[data-testid=files][aria-busy=false] [data-testid=dir-row]',
    'first run': '[data-testid=ob-setup] h1',
    'get started': '[data-testid=ob-gs] [data-testid=ob-step]',
  };

  q.browser = await launch();
  const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1 };
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const open = async (screen, vp = DESKTOP, before) => {
    // Chrome now and then refuses a new tab right after one closed ("Session with given id not found"): ask again.
    const page = await q.browser.newPage().catch(async () => {
      await sleep(500);
      return q.browser.newPage();
    });
    if (vp.isMobile) await page.emulate({ viewport: vp, userAgent: IPHONE });
    else await page.setViewport(vp);
    if (before) await page.evaluateOnNewDocument(before);
    await page.goto(urlOf(screen), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(ready[screen], { timeout: 15000 });
    // Done when it holds still (images in view and fonts loaded), however long a loaded machine takes to get there.
    await settle(page, { quiet: 500, max: 10_000 });
    return page;
  };
  // A busy machine sometimes loses Chrome under a suite ("Target closed", a detached frame, the browser gone). That says
  // nothing about the page, so the screen gets one more try in a fresh browser; a real failure fails both times.
  const LOST = /Target closed|detached Frame|Session closed|Connection closed|browser has disconnected/;
  const relaunch = async () => {
    await q.browser?.close().catch(() => {});
    q.browser = await launch();
  };
  const again = async (fn) => {
    if (!q.browser?.connected) await relaunch();
    try {
      return await fn();
    } catch (e) {
      if (!LOST.test(String(e?.message))) throw e;
      console.log(`      (Chrome was lost: ${String(e.message).split('\n')[0]}; once more in a fresh browser)`);
      await relaunch();
      return fn();
    }
  };

  // The player with the composer open (C at a desk, "+ Note" in the phone's sheet): a screen of its own for the rules
  // about controls (tap areas, one height per row, hover).
  const openComposer = async (vp) => {
    const page = await open('player', vp);
    if (vp.isMobile) await page.evaluate(() => [...document.querySelectorAll('.nsheet button.primary')].find((b) => b.textContent.includes('Note'))?.click());
    else await page.keyboard.press('c');
    await page.waitForSelector('.composer textarea', { timeout: 10000 });
    await page.evaluate(() =>
      Promise.all(
        document
          .querySelector('.composer')
          .getAnimations({ subtree: true })
          .map((a) => a.finished.catch(() => {})),
      ),
    );
    return page;
  };

  return { api, a, SCREENS, urlOf, ready, PHONE, DESKTOP, IPHONE, open, relaunch, again, openComposer };
}
