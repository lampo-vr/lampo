#!/usr/bin/env node
// covers: web/src/player/VersionPicker.tsx web/src/player/PlayerTopbar.tsx web/src/player/ClaudeMenu.tsx web/src/status/StageControl.tsx
// covers: web/src/styles/player.css web/src/styles/status.css web/src/styles/loop.css
// The player's top bar, its right side and the Versions menu, with real-shaped data: four versions (V1 and V3 uploaded
// by a person, V2 an agent's part, V4 the agent's and the newest), V3 on screen, a long agent name. The Versions menu says
// one short line a version ("V4 · 8 min ago · 3 fixed") with its marks, no Steps (the Agent tab has the runs), the rest
// in the row's tooltip on a desk and under the row's ⌄ on a phone. The agent button hugs its words; while the stage is
// "In progress" it says it alone (no status of its own), Decide stays; at 1024, 1440 and 1920, in the longest states
// (fixing 12 of 12, needs you, not listening), nothing overlaps or is cut, and the bar keeps room for one more button.
import path from 'node:path';
import { runFixtures } from '../../web/src/styleguide/runStates.ts';
import { age, makeVideo, until } from '../lib/helpers.ts';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'top bar e2e';
requireChrome(LABEL);
const enc = encodeURIComponent;
const NAME = 'claude-code · Valentina Hoffmann-Rossi';

const servers = [];
let browser;
let page = null;
screenshotFailures(() => page, 'topbar');
try {
  const srv = await startServer({ prefix: 'vr-topbar-e2e-', user: 'Valentina' });
  servers.push(srv);
  const api = jsonApi(srv.base);
  // four versions: 20 s, 20 s, 28 s, 41 s
  const file = path.join(srv.dir, 'Acme/Launch/launch.mp4');
  let slug = null;
  for (const [i, dur] of [20, 20, 28, 41].entries()) {
    makeVideo(file, { w: 160, h: 90, fps: 25, dur, pattern: ['testsrc2', 'smptebars', 'testsrc', 'rgbtestsrc'][i] });
    age(file);
    if (!slug) slug = (await api('/api/library', 'POST', { path: file, folder: 'Acme/Launch' })).video.slug;
    else await api(`/api/review/${enc(slug)}/sync`, 'POST', {});
  }
  await api(`/api/review/${enc(slug)}/session`, 'PUT', { name: NAME, sessionId: `mcp-${slug}`, agent: 'claude-code' });
  const ids = [];
  for (const frame of [40, 120, 210, 291, 350])
    ids.push((await api(`/api/review/${enc(slug)}/comments`, 'POST', { v: 3, frame, text: `Note at ${frame}`, severity: 'should' })).id);

  // the agent's work, as the runs API answers it (web/src/styleguide/runStates.ts)
  const now = Date.now();
  const iso = (s) => new Date(now - s * 1000).toISOString();
  const fx = runFixtures(slug, ids.slice(2), 4, now);
  const agent = { name: NAME, kind: 'claude-code', session_id: `mcp-${slug}` };
  const done = (id, over) => ({ ...fx.done.run, id, agent, state: 'done', ...over });
  const runV4 = done('run_v4', {
    started: iso(9 * 60),
    ended: iso(7 * 60),
    worked_s: 132,
    plan: ids.map((id, i) => ({ id, state: i < 3 ? 'fixed' : i === 3 ? 'asked' : 'wontfix', at: iso(8 * 60), ...(i < 3 ? { v: 4 } : {}) })),
    result: { fixed: 3, asked: 1, wontfix: 1, v: 4 },
  });
  const runV2 = done('run_v2', {
    started: iso(26 * 3600 + 64),
    ended: iso(26 * 3600),
    worked_s: 64,
    plan: [{ id: ids[3], state: 'fixed', at: iso(26 * 3600), v: 2 }],
    result: { fixed: 1, v: 2 },
  });
  const plan = (n, doing) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, state: i < doing ? 'fixed' : i === doing ? 'doing' : 'todo', at: iso(100) }));
  const working = (over) => ({ ...fx.working.run, agent, started: iso(107), worked_s: 107, plan: plan(3, 0), ...over });
  const MODES = {
    working: () => working({}),
    fix12: () => working({ id: 'run_12', plan: plan(12, 11) }),
    needs: () => ({ ...fx.needs_you.run, id: 'run_needs', agent, needs: { kind: 'question', note: ids[3], text: 'Should the logo land on the downbeat?' } }),
    stalled: () => null,
  };
  let mode = 'working';
  const briefOf = (r) =>
    r && {
      id: r.id,
      agent: r.agent,
      state: r.state,
      started: r.started,
      ended: r.ended,
      worked_s: r.worked_s,
      now: r.now,
      progress: r.progress,
      result: r.result,
      error: r.error,
      needs: r.needs,
      planned: r.plan.length,
      answered: r.plan.filter((p) => p.state !== 'todo' && p.state !== 'doing').length,
    };
  const json = (req, body) => req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  const intercept = async (p) => {
    await p.setRequestInterception(true);
    p.on('request', async (req) => {
      const at = new URL(req.url()).pathname;
      try {
        if (!at.startsWith('/api/')) return req.continue();
        const current = MODES[mode]();
        if (at === '/api/runs' && req.method() === 'GET') return json(req, { runs: [...(current ? [current] : []), runV4, runV2] });
        if (at === '/api/agents')
          return json(req, {
            agents: [
              {
                session_id: `mcp-${slug}`,
                name: NAME,
                cwd: null,
                host: null,
                user: null,
                last_seen: iso(5),
                kind: 'claude-code',
                state: mode === 'stalled' ? 'idle' : 'working',
              },
            ],
          });
        if (/^\/api\/review\/[^/]+$/.test(at) && req.method() === 'GET') {
          const r = await (await fetch(req.url())).json();
          r.summary.run = briefOf(current);
          // what the server says while an agent works on it (lib/stage.ts)
          if (current?.state === 'working')
            r.summary.stage = { ...r.summary.stage, stage: 'in_progress', next: { kind: 'wait_agent', label: 'An agent is on it' } };
          const ago = [2 * 86400, 26 * 3600, 3 * 3600, 7 * 60];
          r.review.versions = r.review.versions.map((x, i) => ({
            ...x,
            registered: iso(ago[i] ?? 60),
            ...(i === 0 || i === 2 ? { by: 'Valentina', run: undefined } : { by: undefined }),
            ...(i === 1 ? { run: 'run_v2', part: { of: 1, at: 275, frames: 56, handles: 10, seam: 'clean' } } : {}),
            ...(i === 3 ? { run: 'run_v4' } : {}),
          }));
          return json(req, r);
        }
        return req.continue();
      } catch (e) {
        if (!String(e).includes('already handled')) console.log(`      interception: ${e}`);
      }
    });
  };
  const errors = [];
  browser = await launch();
  const open = async ({ width = 1440, height = 900, phone = false } = {}) => {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await intercept(p);
    await p.setViewport({ width, height, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
    await p.goto(`${srv.base}/#/v/${enc(slug)}?v=3`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('[data-testid=version-picker]', { timeout: 30000 });
    await p.waitForSelector('[data-testid=agent-button]', { timeout: 30000 });
    page = p;
    return p;
  };
  const rows = (p) =>
    p.$$eval('.vpick-list li:not(.vpick-ghost)', (ls) =>
      ls.map((l) => ({
        text: l.querySelector('.vpick-row')?.textContent ?? '',
        current: l.classList.contains('on'),
        compare: !!l.querySelector('.vpick-acts [aria-label^="Compare"]'),
        lines: Math.round(l.querySelector('.vpick-row').getBoundingClientRect().height),
      })),
    );

  await check('the Versions menu: one short line a version, newest first, its marks, compare, and no Steps', async () => {
    const p = await open();
    await p.click('[data-testid=version-picker]');
    await p.waitForSelector('.vpick-list');
    const r = await rows(p);
    assert(r.length === 4, `four versions: ${JSON.stringify(r)}`);
    assert(/^V4/.test(r[0].text) && /3 fixed/.test(r[0].text) && /newest/.test(r[0].text), `V4: ${r[0].text}`);
    assert(/^V3/.test(r[1].text) && /by Valentina/.test(r[1].text) && /current/.test(r[1].text) && r[1].current, `V3: ${r[1].text}`);
    assert(/^V2/.test(r[2].text) && /part \(00:11–00:13\)/.test(r[2].text), `V2: ${r[2].text}`);
    assert(/^V1/.test(r[3].text) && /by Valentina/.test(r[3].text), `V1: ${r[3].text}`);
    // one line each: the raw id and a timecode-like length never stand there
    assert(
      r.every((x) => !/claude-code|00:40:24|00:19:24/.test(x.text)),
      `nothing raw: ${r.map((x) => x.text)}`,
    );
    const one = r[0].lines;
    assert(
      r.every((x) => Math.abs(x.lines - one) <= 1),
      `one height a row: ${r.map((x) => x.lines)}`,
    );
    assert(r.filter((x) => x.compare).length === 3 && !r[1].compare, 'compare on every row but the current one');
    assert(!(await p.$('[data-testid=version-steps]')), 'no Steps in the menu');
  });

  await check('a desk: the row’s tooltip says who made it, from which notes, and its length beside the one before', async () => {
    const p = page;
    const row = (await p.$$('.vpick-list li:not(.vpick-ghost) .vpick-row'))[0];
    const b = await row.boundingBox();
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 3 });
    await p.waitForSelector('.tip [data-testid=version-details]', { timeout: 5000 });
    const tip = await p.$eval('.tip [data-testid=version-details]', (e) => e.textContent);
    assert(/Claude Code · Valentina Hoffmann-Rossi · 2 min · 3 fixed · 1 asked · 1 left as is/.test(tip), `who: ${tip}`);
    assert(/from your 5 notes of/.test(tip) && /0:41, was 0:28/.test(tip), `notes and length: ${tip}`);
    assert(!(await p.$eval('.vpick-more', (e) => e.getClientRects().length)), 'no ⌄ where there is hover');
    await p.keyboard.press('Escape');
    await p.browserContext().close();
  });

  await check('a phone: the row’s ⌄ opens its details under it, the row itself picks the version', async () => {
    const p = await open({ width: 390, height: 844, phone: true });
    await p.click('[data-testid=version-picker]');
    await p.waitForSelector('.vpick-list');
    const more = (await p.$$('.vpick-more'))[0];
    assert(more && (await more.evaluate((e) => e.getBoundingClientRect().width > 0)), 'the ⌄ shows on a touch screen');
    await more.tap();
    await p.waitForSelector('.vpick-open [data-testid=version-details]');
    const said = await p.$eval('.vpick-open [data-testid=version-details]', (e) => e.textContent);
    assert(/Claude Code · Valentina Hoffmann-Rossi/.test(said) && /0:41, was 0:28/.test(said), `details: ${said}`);
    const v4 = (await p.$$('.vpick-list li:not(.vpick-ghost) .vpick-row'))[0];
    await v4.tap();
    await until(async () => (await p.$eval('[data-testid=version-picker] .vpick-v', (e) => e.textContent)) === 'V4', 'V4 picked');
    await p.browserContext().close();
  });

  /** The bar's parts and how they sit: overlaps, the agent button's empty room, its cut words, the room left over. */
  const bar = (p) =>
    p.evaluate(() => {
      const top = document.querySelector('.p-top');
      const tr = top.getBoundingClientRect();
      const parts = [...top.children]
        .filter((e) => !e.classList.contains('grow'))
        .map((e) => ({ who: e.className || e.tagName, r: e.getBoundingClientRect() }))
        .filter((x) => x.r.width > 0);
      const overlaps = [];
      for (let i = 1; i < parts.length; i++) if (parts[i].r.left < parts[i - 1].r.right - 0.5) overlaps.push(`${parts[i - 1].who} / ${parts[i].who}`);
      const outside = parts.filter((x) => x.r.right > tr.right + 0.5 || x.r.left < tr.left - 0.5).map((x) => x.who);
      const btn = document.querySelector('[data-testid=agent-button]');
      const hug = btn.querySelector('.agent-hug');
      const inner = btn.querySelector('.agent-hug-in');
      const step = btn.querySelector('[data-testid=agent-step]');
      return {
        overlaps,
        outside,
        grow: Math.round(top.querySelector(':scope > .grow')?.getBoundingClientRect().width ?? 0),
        title: Math.round(top.querySelector('.p-title')?.getBoundingClientRect().width ?? 0),
        hug: hug && inner ? Math.abs(hug.getBoundingClientRect().width - inner.getBoundingClientRect().width) : null,
        cut: step ? step.scrollWidth > step.clientWidth + 1 : false,
        words: step?.textContent ?? btn.querySelector('.agent-name')?.textContent ?? '',
        status: !!document.querySelector('[data-testid=stage-control]'),
        decide: !!document.querySelector('[data-testid=stage-more]'),
      };
    });

  await check('in progress: the agent button says it and hugs its words; no status beside it; Decide stays', async () => {
    mode = 'working';
    const p = await open();
    await until(async () => /fixing 1 of 3/.test((await bar(p)).words), 'the agent button says where it stands');
    await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await until(async () => (await bar(p)).hug < 1, 'the button as wide as its words');
    const b = await bar(p);
    assert(!b.status && b.decide, `no status of its own, Decide stays: ${JSON.stringify(b)}`);
    await p.browserContext().close();
  });

  await check('another stage: the status is a quiet pill, what it waits for in its card (and for screen readers)', async () => {
    mode = 'needs';
    const p = await open();
    await p.waitForSelector('[data-testid=stage-control]');
    const pill = await p.$eval('[data-testid=stage-control]', (e) => {
      // what the eye reads: the pill without its words for screen readers
      const seen = e.cloneNode(true);
      for (const x of seen.querySelectorAll('.sr-only')) x.remove();
      return { seen: seen.textContent, sr: e.querySelector('.so-wait')?.textContent ?? '', width: Math.round(e.getBoundingClientRect().width) };
    });
    assert(!/Waiting for/.test(pill.seen) && /Waiting for fixes/.test(pill.sr), `no long words in sight: ${JSON.stringify(pill)}`);
    // its card says what it waits for
    const b = await (await p.$('[data-testid=stage-control]')).boundingBox();
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 3 });
    await p.waitForSelector('[data-testid=stage-card-next]', { timeout: 5000 });
    const next = await p.$eval('[data-testid=stage-card-next]', (e) => e.textContent);
    assert(/^Waiting for fixes from /.test(next), `the card says what it waits for: ${next}`);
    await p.browserContext().close();
  });

  for (const width of [1024, 1440, 1920])
    await check(`${width}: the longest states fit — nothing overlaps or is cut, and room is left for one more button`, async () => {
      for (const m of ['fix12', 'needs', 'stalled']) {
        mode = m;
        const p = await open({ width, height: 800 });
        await until(async () => (await bar(p)).words.length > 0, 'the agent button’s words');
        await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        const b = await bar(p);
        assert(!b.overlaps.length && !b.outside.length, `${m}: ${JSON.stringify(b)}`);
        assert(!b.cut, `${m}: the agent button’s words whole: "${b.words}"`);
        assert(b.title >= 60, `${m}: the title keeps room (${b.title} px)`);
        // a "Check 3 fixes" button may come to this bar
        assert(b.grow >= 110, `${m}: ${b.grow} px left on the bar`);
        await p.browserContext().close();
      }
    });

  await check('no errors in the page', async () => {
    assert(!errors.length, errors.join('\n'));
  });
} catch (e) {
  crashed(e, ...servers);
}
await finish(LABEL, { browser, servers });
