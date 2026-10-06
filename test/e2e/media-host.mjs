#!/usr/bin/env node
// covers: lib/storage/mediaHost.ts server/routes/media.ts web/src/player/recover.ts web/src/settings/Mcp.tsx
// Browser end-to-end test of the app's own media host (VR_MEDIA_ORIGIN): a hosted server whose app answers on one host
// name (127.0.0.1) and its video on another (localhost), as the app host behind a CDN proxy and the media host beside
// it would. The team's player and a review link's visitor play from the media host (the page's CSP lets them, the
// host's answers may be loaded cross-origin), seek frame-exact there, and nothing on the way is refused. Connect an
// agent names the host for Claude, whose sandbox must be allowed to reach it.
// Without Chrome or web/dist it fails (see prereq.mjs).
import path from 'node:path';
import { makeVideo } from '../lib/helpers.ts';
import { client, tusUpload } from '../lib/http.ts';
import { clippedText, cutLabels, dataTheme, settle, sideways } from './layout.mjs';
import { launch, requireChrome, shotsDir, signedIn } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { closestFrame } from './lib/frames.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'media host e2e';
const WAIT = 30_000;
requireChrome(LABEL);
let media = '';
const srv = await startServer({
  prefix: 'vr-e2e-media-host-',
  mode: 'server',
  publicUrl: true,
  env: ({ port }) => {
    media = `http://localhost:${port}`;
    return { VR_MEDIA_ORIGIN: media };
  },
});
const { dir, base: BASE } = srv;
const request = client(srv.port);
const cookieOf = (r) => String([r.headers['set-cookie']].flat().find((c) => String(c).startsWith('vr_session=')) || '').split(';')[0];

let browser;
try {
  const token = await srv.setupToken();
  assert(token, `no setup token in the server log:\n${srv.log()}`);
  const origin = { Origin: BASE };
  const setup = await request('POST', '/api/auth/setup', {
    body: { token, email: 'olivia@e2e.test', name: 'Olivia', password: 'a long enough password' },
    headers: origin,
  });
  assert(setup.status === 200, setup.text);
  const cookie = cookieOf(setup);
  const video = makeVideo(path.join(dir, 'renders/spot.mp4'), { w: 320, h: 180, fps: 30, dur: 3, pattern: 'testsrc2', gop: 10 });
  const up = await tusUpload(request, video, { filename: 'spot.mp4', folder: 'Acme' }, { Cookie: cookie, ...origin });
  assert(up.status === 200, up.text);
  const slug = up.json().slug;

  browser = await launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setCookie({ name: 'vr_session', value: cookie.split('=').slice(1).join('='), url: BASE });
  const errors = [];
  const fromMedia = [];
  let lastMediaUrl = '';
  page.on('pageerror', (e) => errors.push(e.message));
  // A CSP refusal ("Refused to load media …") or a blocked cross-origin answer is a console error.
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('response', (r) => {
    if (r.url().startsWith(`${media}/media/s/`)) {
      fromMedia.push(r.status());
      lastMediaUrl = r.url();
    } else if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
  });
  const videoAt = async (frame) =>
    page.waitForFunction(
      (n) => {
        const v = document.querySelector('.vbox video');
        return v && v.readyState >= 2 && !v.seeking && Math.abs(v.currentTime - (n + 0.5) / 30) < 0.01;
      },
      { polling: 100, timeout: WAIT },
      frame,
    );
  // The player's own element plays another origin's bytes without CORS (a canvas can't read it): the same URL, loaded
  // again with CORS — which the media host allows the app — and seeked the same way, shows what the player shows.
  const pictureAt = (frame) =>
    page.evaluate(
      async ({ frame, SW, SH, url }) => {
        const v = document.createElement('video');
        v.crossOrigin = 'anonymous';
        v.muted = true;
        v.src = url;
        await new Promise((ok, no) => {
          v.onloadeddata = ok;
          v.onerror = () => no(new Error(`the media host's URL didn't load with CORS: ${url}`));
        });
        v.currentTime = (frame + 0.5) / 30;
        await new Promise((ok) => (v.onseeked = ok));
        const c = document.createElement('canvas');
        c.width = SW;
        c.height = SH;
        const g = c.getContext('2d');
        g.drawImage(v, 0, 0, SW, SH);
        const d = g.getImageData(0, 0, SW, SH).data;
        const out = [];
        for (let i = 0; i < d.length; i += 4) out.push(Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]));
        return out;
      },
      { frame, SW: 96, SH: 54, url: lastMediaUrl },
    );

  await check('the team’s player plays from the media host, frame-exact, and the page refuses nothing', async () => {
    for (const n of [0, 45, 89]) {
      await page.goto('about:blank');
      await page.goto(`${BASE}/#/v/${encodeURIComponent(slug)}?f=${n}`, { waitUntil: 'domcontentloaded' });
      await videoAt(n);
      const best = closestFrame(video, await pictureAt(n), n, 90);
      assert(best.k === n, `frame ${n}: closest ffmpeg frame is ${best.k} (${best.line})`);
    }
    assert(fromMedia.length && fromMedia.every((s) => s === 200 || s === 206), `the bytes came from ${media}: ${fromMedia.join(' ')}`);
    assert(!errors.length, errors.join(' | '));
  });

  await check('a review link’s visitor plays from the media host too, signed out', async () => {
    const link = await request('POST', `/api/review/${encodeURIComponent(slug)}/shares`, { body: { label: 'Client' }, headers: { Cookie: cookie, ...origin } });
    assert(link.status === 200, link.text);
    const ctx = await browser.createBrowserContext();
    const guest = await ctx.newPage();
    const seen = [];
    guest.on('response', (r) => r.url().startsWith(`${media}/media/s/`) && seen.push(r.status()));
    guest.on('console', (m) => m.type() === 'error' && errors.push(`guest: ${m.text()}`));
    await guest.goto(`${BASE}/g/${link.json().token}`, { waitUntil: 'domcontentloaded' });
    await guest.waitForFunction(
      () => {
        const v = document.querySelector('.vbox video');
        return v && v.readyState >= 2;
      },
      { polling: 100, timeout: WAIT },
    );
    assert(seen.length && seen.every((s) => s === 200 || s === 206), `the visitor's bytes came from ${media}: ${seen.join(' ')}`);
    assert(!errors.length, errors.join(' | '));
    await ctx.close();
  });

  // Claude's sandbox uploads with one PUT to the media host (request_upload), and its proxy lets it reach only the
  // domains Claude allows: the Claude pick names that host, to copy into Claude's settings. A chat app connects only to
  // an https address, which this test server isn't: the page is told its public URL is one.
  await check('Connect an agent: the Claude pick names the media host to allow in Claude, with its Copy; no other pick does', async () => {
    const real = (await request('GET', '/api/info', { headers: { Cookie: cookie } })).json();
    assert(real.media_origin === media, `the server names its media host to someone signed in: ${real.media_origin}`);
    const host = new URL(media).hostname;
    const settingsAt = async (vp, info = {}) => {
      const p = await browser.newPage();
      await p.setViewport(vp);
      p.on('pageerror', (e) => errors.push(`settings: ${e.message}`));
      await p.setRequestInterception(true);
      p.on('request', async (r) => {
        if (r.method() !== 'GET' || new URL(r.url()).pathname !== '/api/info') return r.continue().catch(() => {});
        const got = (await request('GET', '/api/info', { headers: { Cookie: cookie } })).json();
        r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...got, ...info }) }).catch(() => {});
      });
      await p.goto(`${BASE}/#/settings/mcp`, { waitUntil: 'domcontentloaded' });
      await p.waitForSelector('[data-testid="agent-tiles"]');
      // the phone has no top bar to say it (its account sits in the drawer)
      if (!vp.isMobile) await signedIn(p);
      await p.waitForFunction(() => !document.activeViewTransition, { polling: 50, timeout: WAIT });
      return p;
    };
    // The tile a person reads (its name), by its own radio: visually hidden behind the label, clicked where it is.
    const pick = async (p, name) => {
      const input = await p.evaluateHandle(
        (name) =>
          [...document.querySelectorAll('[data-testid="agent-tiles"] .set-tile')]
            .find((t) => t.querySelector('b')?.textContent === name)
            ?.querySelector('input'),
        name,
      );
      await input.evaluate((e) => e.click());
      await p.waitForFunction((e) => e.checked, { polling: 100, timeout: WAIT }, input);
    };
    const allow = (p) => p.$eval('[data-testid="agent-allow"] pre', (e) => e.textContent).catch(() => null);

    const p = await settingsAt({ width: 1440, height: 900 }, { public_url: 'https://review.example.com' });
    assert((await allow(p)) === null, 'Claude Code: no domain to allow');
    await pick(p, 'Claude');
    await p.waitForSelector('[data-testid="agent-allow"] pre', { timeout: WAIT });
    assert((await allow(p)) === host, `the media host's domain, as Claude's allowed domains take it: ${await allow(p)}`);
    assert(await p.$('[data-testid="agent-allow"] .set-copy[aria-label="Copy Allowed domain"]'), 'with its Copy, as every value on the screen');
    const step = await p.$eval('[data-testid="agent-snippet"]', (e) => e.innerText);
    assert(step.includes('Settings → Capabilities') && step.includes('organization’s owner'), step);
    await pick(p, 'ChatGPT');
    await p.waitForSelector('[data-testid="agent-snippet"] pre');
    assert((await allow(p)) === null, 'ChatGPT: no domain to allow');
    await p.close();

    // Without an https address Claude can't connect at all: the step says so, and names no domain.
    const http = await settingsAt({ width: 1440, height: 900 });
    await pick(http, 'Claude');
    await http.waitForFunction(() => document.querySelector('[data-testid="agent-snippet"]')?.textContent.includes('https address'), { timeout: WAIT });
    assert((await allow(http)) === null, 'no domain where Claude cannot connect');
    await http.close();

    // As a real server's: the phone, a small laptop and the desktop, both themes; nothing clipped or sideways.
    const shots = shotsDir();
    const looks = [];
    for (const vp of [
      { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
      { width: 1024, height: 768, deviceScaleFactor: 1 },
      { width: 1440, height: 900, deviceScaleFactor: 1 },
    ]) {
      const q = await settingsAt(vp, { public_url: 'https://review.example.com', media_origin: 'https://media.example.com' });
      await pick(q, 'Claude');
      await q.waitForSelector('[data-testid="agent-allow"] pre', { timeout: WAIT });
      for (const theme of ['dark', 'light']) {
        await dataTheme(q, theme);
        await settle(q);
        for (const b of [...(vp.isMobile ? await sideways(q) : []), ...(await clippedText(q)), ...(await cutLabels(q))])
          looks.push(`${theme} @${vp.width}: ${b}`);
        if (shots) {
          await q.$eval('[data-testid="agent-snippet"]', (e) => e.scrollIntoView({ block: 'center' }));
          await settle(q);
          await q.screenshot({ path: path.join(shots, `media-host-connect-claude-${vp.width}-${theme}.png`) });
        }
      }
      await q.close();
    }
    assert(!looks.length, looks.join('\n'));
    assert(!errors.length, errors.join(' | '));
  });
} catch (e) {
  crashed(e, srv);
} finally {
  await finish(LABEL, { browser, servers: [srv] });
}
