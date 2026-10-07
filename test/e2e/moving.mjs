#!/usr/bin/env node
// covers: lib/bundle.ts lib/bundleExport.ts lib/bundleImport.ts lib/tar.ts test/lib/bundleSource.ts
// Browser suite of a move to a server (docs/moving.md): a machine's store (test/lib/bundleSource.ts: tracked renders,
// an upload, notes with drawings and ranges, replies, sign-off, references, watching, a playbook) goes through
// `vr export`, then `vr admin import` into a hosted server while it runs. The library shows every folder and video,
// a player opens and its notes land on their frames, their screenshots load, and Insights loads.
// With VR_MOVING_BASE, VR_MOVING_EMAIL and VR_MOVING_PASSWORD it checks a server someone imported into already (the
// rehearsal against a copy of a real store) instead of making one.
// Without Chrome or web/dist it fails (see prereq.mjs).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { settings } from '../../lib/env.ts';
import { ROOT, tmpdir, until, VR } from '../lib/helpers.ts';
import { client } from '../lib/http.ts';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'moving e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const enc = encodeURIComponent;
const given = settings.LAMPO_MOVING_BASE || null;

let browser;
let page;
let srv = null;
const dirs = [];
try {
  let base;
  let cookie;
  if (given) {
    base = given.replace(/\/+$/, '');
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ email: settings.LAMPO_MOVING_EMAIL, password: settings.LAMPO_MOVING_PASSWORD }),
    });
    assert(r.ok, `sign-in at ${base}: ${r.status}`);
    cookie = r.headers
      .getSetCookie()
      .find((c) => c.startsWith('vr_session='))
      ?.split(';')[0];
  } else {
    // ---------------------------------------------------------------- the machine: a store, then `vr export`
    const src = tmpdir('vr-e2e-moving-src-');
    dirs.push(src);
    fs.writeFileSync(path.join(src, 'config.json'), '{}');
    const keep = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(VR_|CLAUDE)/.test(k)));
    const machine = {
      ...keep,
      VR_DATA: path.join(src, 'data'),
      VR_CACHE: path.join(src, 'cache'),
      VR_CONFIG: path.join(src, 'config.json'),
      VR_USER: 'tester',
      VR_STT: 'off',
      XDG_CONFIG_HOME: path.join(src, 'xdg-config'),
      XDG_CACHE_HOME: path.join(src, 'xdg-cache'),
    };
    execFileSync(process.execPath, [path.join(ROOT, 'test/lib/bundleSource.ts'), path.join(src, 'facts.json')], { env: machine, stdio: 'pipe' });
    const bundle = path.join(src, 'bundle.tar');
    execFileSync(process.execPath, [VR, 'export', bundle], { env: machine, stdio: 'pipe' });

    // ---------------------------------------------------------------- the server: an owner, then the import while it runs
    srv = await startServer({ prefix: 'vr-e2e-moving-', mode: 'server', publicUrl: true });
    base = srv.base;
    const request = client(srv.port);
    const token = await srv.setupToken();
    assert(token, 'a setup token');
    const setup = await request('POST', '/api/auth/setup', {
      body: { token, email: 'owner@e2e.test', name: 'Owner', password: 'a long enough password' },
      headers: { Origin: base },
    });
    assert(setup.status === 200, setup.text);
    cookie = String([setup.headers['set-cookie']].flat()[0]).split(';')[0];
    const out = execFileSync(process.execPath, [VR, 'admin', 'import', bundle, '--workspace', 'w1', '--owner', 'owner@e2e.test'], {
      env: srv.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert(/videos: 4 imported, 0 skipped/.test(out), out);
  }

  const api = async (p) => {
    const r = await fetch(base + p, { headers: { Cookie: cookie } });
    assert(r.ok, `GET ${p}: ${r.status}`);
    return r.json();
  };
  const library = await api('/api/library');
  const videos = library.videos.filter((v) => !v.archived);
  const tops = [...new Set(library.folders.map((f) => f.split('/')[0]))];

  browser = await launch();
  page = await browser.newPage();
  screenshotFailures(() => page, 'moving');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const [name, value] = cookie.split('=');
  await page.setCookie({ name, value, url: base });
  await page.setViewport({ width: 1440, height: 900 });
  const shot = async (n) => SHOTS && page.screenshot({ path: path.join(SHOTS, `moving-${n}.png`) });

  await check('the library shows every folder and video the import brought, each an upload of the server', async () => {
    assert(videos.length > 0, 'videos came over');
    assert(
      videos.every((v) => v.slug.startsWith('__@uploads__')),
      `every video is an upload here: ${videos.map((v) => v.slug).filter((s) => !s.startsWith('__@uploads__'))}`,
    );
    if (!given) assert(videos.some((v) => v.slug.includes('__~2__')) && videos.length === 4, 'two renders of one name in one folder stay two videos');
    await page.goto(`${base}/#/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=library-content]', { timeout: 20000 });
    await until(
      async () => (await page.$$('.film')).length === videos.length,
      async () => `${(await page.$$('.film')).length} cards of ${videos.length}`,
    );
    const shown = await page.$$eval('.film', (els) => els.map((e) => e.getAttribute('data-slug')));
    assert(
      videos.every((v) => shown.includes(v.slug)),
      'every video has its card',
    );
    const labels = await page.$$eval('.nav .nav-label', (els) => els.map((e) => e.textContent.trim()));
    assert(
      tops.every((t) => labels.includes(t)),
      `every project in the sidebar (${tops.length})`,
    );
    // posters made by the import's own jobs
    await until(
      () => page.$$eval('.film img', (imgs) => imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0)),
      'every card shows its poster',
    );
    await shot('library');
  });

  await check('a player opens and its notes land on their frames, with their screenshots', async () => {
    // the video with the most notes still to do on its newest version
    let best = null;
    for (const v of videos) {
      const { review } = await api(`/api/review/${enc(v.slug)}`);
      const latest = review.versions.at(-1).v;
      const on = review.comments.filter((c) => c.v === latest && c.scope !== 'video' && (c.status === 'open' || c.status === 'fixed'));
      if (!best || on.length > best.notes.length) best = { slug: v.slug, review, notes: on };
    }
    assert(best?.notes.length, 'a video with notes on its newest version');
    await page.goto(`${base}/#/v/${enc(best.slug)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.side-scroll .note-row:not(.pending)', { timeout: 20000 });
    await page.waitForFunction(() => document.querySelector('.vbox video')?.readyState >= 2, { timeout: 30000 });
    const tc = () => page.$eval('.transport .tc .main', (e) => e.textContent.trim());
    const frame = () => page.$eval('.tc .sub b', (e) => Number(e.textContent));
    // the panel lists the notes still to do; done ones are a filter away
    const listed = await page.$$eval('.side-scroll .note', (els) => els.map((e) => e.dataset.note));
    const some = best.notes.filter((c) => listed.includes(c.id));
    assert(some.length, `the panel lists notes of the newest version (${listed.length} listed)`);
    for (const c of some.slice(0, 3)) {
      await page.evaluate(() => document.activeElement?.blur());
      await page.click(`.side-scroll [data-note="${c.id}"] .nr`);
      await until(
        async () => (await tc()) === c.timecode && (await frame()) === c.frame,
        async () => `note ${c.id} at ${c.timecode} f${c.frame}, shown ${await tc()} f${await frame()}`,
      );
      if (c.shots?.marked) {
        const r = await fetch(`${base}/data/${enc(best.slug)}/${c.shots.marked}`, { headers: { Cookie: cookie } });
        assert(r.ok && (r.headers.get('content-type') || '').startsWith('image/'), `${c.id}'s screenshot: ${r.status}`);
      }
    }
    await shot('player');
  });

  await check('Insights loads with what came over', async () => {
    await page.goto(`${base}/#/insights`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=insights][aria-busy=false]', { timeout: 30000 });
    assert(await page.$('[data-testid=ins-kpis]'), 'the figures');
    const insights = await api('/api/insights?period=all');
    assert(insights && typeof insights === 'object', 'the API answers');
    await shot('insights');
  });

  await check('no page error on the way', async () => {
    assert(!errors.length, errors.join('\n'));
  });
} catch (e) {
  crashed(e, srv);
}
await finish(LABEL, { browser, servers: [srv], dirs });
