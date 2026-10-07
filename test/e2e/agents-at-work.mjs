#!/usr/bin/env node
// covers: web/src/player/RunStrip.tsx web/src/player/AgentView.tsx web/src/sessions/runState.ts web/src/sessions/runWords.ts web/src/sessions/RunLine.tsx
// covers: web/src/api/runs.ts web/src/styles/runs.css web/src/styles/agentview.css web/src/styleguide/runStates.ts
// Browser end-to-end test of what a person sees while an agent works on a video (an agent's "run": never a word in
// the UI). The runs API answers with real-shaped work in every state (web/src/styleguide/runStates.ts) and the review,
// library and agents answers carry it, so every state can be shown without an agent; SSE `run` reaches the page the
// way another tab relays it. Checks: the strip's fixed slot (nothing moves from ready to working, rendering, needs you
// and done), its words per state, the Agent view's plan and steps, Stop at once and back when refused, a reviewer
// seeing the work without its controls, the board card's hairline and action slot, the cards without a spinner, the
// version picker's ghost and who made a version, the phone's strip and sheet, and every state at 390–1920 in both
// themes and German. Screenshots land in VR_SHOTS.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { RUN_STATES, runFixtures } from '../../web/src/styleguide/runStates.ts';
import { age, makeVideo, ROOT, sleep, until } from '../lib/helpers.ts';
import { clippedText, cutLabels, settle, sideways } from './layout.mjs';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'agents at work e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-agents-at-work-e2e-', user: 'Sam' });
const { dir, base: BASE } = srv;
const api = jsonApi(BASE);
const enc = encodeURIComponent;

// the cards' brief of a run (lib/types.ts RunBrief)
const briefOf = (r) => ({
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
});

let browser;
let page;
try {
  // launch.mp4: V1 with seven notes, V2 an agent's earlier work; four more videos for the board, each with an agent
  const video = async (name, folder, pattern) => {
    const file = makeVideo(path.join(dir, `Acme/${folder}/${name}`), { w: 320, h: 180, fps: 25, dur: 4, pattern });
    age(file);
    return (await api('/api/library', 'POST', { path: file, folder: `Acme/${folder}` })).video.slug;
  };
  const launchFile = path.join(dir, 'Acme/Launch/launch.mp4');
  const slug = await video('launch.mp4', 'Launch', 'testsrc2');
  const notes = [];
  for (const [frame, text] of [
    [8, 'Typo in the title'],
    [22, 'Caption too low'],
    [38, 'Logo enters late'],
    [50, 'Music too loud here'],
    [64, 'Cut the last shot?'],
    [78, 'Warmer grade'],
    [92, 'Hold the end card longer'],
  ])
    notes.push((await api(`/api/review/${enc(slug)}/comments`, 'POST', { v: 1, frame, text, severity: 'should' })).id);
  makeVideo(launchFile, { w: 320, h: 180, fps: 25, dur: 4, pattern: 'smptebars' });
  age(launchFile);
  await api(`/api/review/${enc(slug)}/sync`, 'POST', {});
  // the agent fixed the first two in the project: they wait to be checked (done offers Check fixes then)
  for (const id of notes.slice(0, 2)) await api(`/api/comments/${id}`, 'PATCH', { status: 'fixed', note: 'done', by: 'agent:Claude Code' });
  const others = {
    promo: await video('promo.mp4', 'Promo', 'smptebars'),
    teaser: await video('teaser.mp4', 'Teaser', 'testsrc'),
    spring: await video('spring.mp4', 'Spring', 'rgbtestsrc'),
  };
  for (const s of [slug, ...Object.values(others)]) {
    await api(`/api/review/${enc(s)}/session`, 'PUT', { name: 'Claude Code', sessionId: `mcp-${s}`, agent: 'claude-code' });
    if (s !== slug) await api(`/api/review/${enc(s)}/comments`, 'POST', { v: 1, frame: 20, text: 'Tighter cut here', severity: 'must' });
  }

  // What the server says, with the agent's work in it. `state[slug]`: the state its work is in (null: none going on).
  const now = Date.now();
  const fixtures = runFixtures(slug, notes, 2, now);
  // the earlier work that made V2
  const made = {
    ...fixtures.done.run,
    id: 'run_v2',
    started: new Date(now - 26 * 3600e3).toISOString(),
    ended: new Date(now - 25.8 * 3600e3).toISOString(),
    result: { ...fixtures.done.run.result, v: 2 },
  };
  const otherRuns = Object.fromEntries(
    Object.entries({ promo: 'rendering', teaser: 'needs_you', spring: 'failed' }).map(([k, st]) => {
      const f = runFixtures(others[k], [`${k}1`, `${k}2`, `${k}3`, `${k}4`], 1, now)[st].run;
      return [others[k], { ...f, id: `${f.id}_${k}`, slug: others[k], plan: f.plan.map((p, i) => ({ ...p, id: `${k}${i}` })) }];
    }),
  );
  const state = { [slug]: null };
  let role = null;
  const listening = true;
  let stopAnswer = 'ok';
  const stops = [];
  const runOf = (s) => (s === slug ? (state[slug] ? fixtures[state[slug]].run : null) : (otherRuns[s] ?? null));
  // an older server: no runs at all (the cards keep their line, its status in the keyframe language)
  let older = false;
  const real = async (url) => {
    const r = await fetch(url);
    return r.json();
  };
  const json = (req, body, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const intercept = async (p) => {
    await p.setRequestInterception(true);
    p.on('request', async (req) => {
      const url = new URL(req.url());
      const at = url.pathname;
      try {
        if (!at.startsWith('/api/')) return req.continue();
        if (at === '/api/runs' && req.method() === 'GET') {
          const s = url.searchParams.get('slug');
          const r = runOf(s);
          return json(req, { runs: [...(r ? [r] : []), ...(s === slug ? [made] : [])] });
        }
        const one = /^\/api\/runs\/([^/]+)$/.exec(at);
        if (one && req.method() === 'GET') {
          const id = decodeURIComponent(one[1]);
          const f = Object.values(fixtures).find((x) => x.run.id === id);
          const run = f?.run ?? (id === made.id ? made : Object.values(otherRuns).find((x) => x.id === id));
          return run ? json(req, { run, steps: f?.steps ?? fixtures.done.steps }) : json(req, { error: 'not found' }, 404);
        }
        const write = /^\/api\/runs\/([^/]+)\/(stop|retry|nudge)$/.exec(at);
        if (write && req.method() === 'POST') {
          const run = runOf(slug);
          stops.push(write[2]);
          if (stopAnswer === 'hold') await until(() => stopAnswer !== 'hold', 'the held answer', 30_000);
          if (stopAnswer === 'fail') return json(req, { error: 'The agent could not be reached' }, 409);
          return json(req, { run: { ...run, state: 'stopped', ended: new Date().toISOString(), progress: null } });
        }
        if (at === '/api/agents' && req.method() === 'GET') {
          const live = listening
            ? [
                {
                  session_id: `mcp-${slug}`,
                  name: 'Claude Code',
                  cwd: null,
                  host: null,
                  user: null,
                  last_seen: new Date().toISOString(),
                  kind: 'claude-code',
                  state: 'listening',
                },
              ]
            : [];
          return json(req, { agents: live });
        }
        if (at === '/api/auth/status' && role) {
          const s = await real(req.url());
          if (s.user) s.user.role = role;
          return json(req, s);
        }
        const review = /^\/api\/review\/([^/]+)$/.exec(at);
        if (review && req.method() === 'GET') {
          const s = decodeURIComponent(review[1]);
          const r = await real(req.url());
          if (older) delete r.summary.run;
          if (!older) {
            r.summary.run = runOf(s) ? briefOf(runOf(s)) : null;
            if (s === slug) r.review.versions = r.review.versions.map((x) => (x.v === 2 ? { ...x, run: made.id } : x));
          } else r.review.agent_status = { text: 'rendering v3', by: 'agent:Claude Code', at: new Date().toISOString() };
          return json(req, r);
        }
        if (at === '/api/library' && req.method() === 'GET') {
          const r = await real(req.url());
          for (const v of r.videos) {
            if (older) {
              v.agent_status = v.slug === others.promo ? { text: 'rendering v2', by: 'agent:Claude Code', at: new Date().toISOString() } : null;
              delete v.run;
            } else v.run = runOf(v.slug) ? briefOf(runOf(v.slug)) : null;
          }
          return json(req, r);
        }
        return req.continue();
      } catch (e) {
        if (!String(e).includes('already handled')) console.log(`      interception: ${e}`);
      }
    });
  };
  /** The agent's work moved (what another tab relays from the server's `run` event). */
  const moved = (p, s = slug) =>
    p.evaluate((data) => new BroadcastChannel('vr-events').postMessage({ type: 'run', data }), { slug: s, id: runOf(s)?.id ?? 'none' });
  const go = async (p, st) => {
    state[slug] = st;
    await moved(p);
    const phase = st === 'thinking' || st === 'quiet' ? 'working' : st === 'permission' ? 'needs_you' : st;
    // the strip says the state, of this very work (two states can share a phase)
    await p.waitForFunction(
      (ph, id) => {
        const el = document.querySelector('[data-testid=run-strip]');
        return el?.getAttribute('data-phase') === ph && (el.getAttribute('data-run') ?? '') === id;
      },
      { timeout: 15000 },
      st ? phase : listening ? 'ready' : 'unreachable',
      st ? fixtures[st].run.id : '',
    );
  };

  browser = await launch();
  page = await browser.newPage();
  screenshotFailures(() => page, 'agents-at-work');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await intercept(page);
  await page.setViewport({ width: 1440, height: 900 });
  const shot = async (p, name) => SHOTS && p.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  const openPlayer = async (p, s = slug) => {
    await p.goto('about:blank');
    await p.goto(`${BASE}/#/v/${enc(s)}`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('[data-testid=run-strip]:not(.pending)', { timeout: 20000 });
    // who is looking is known (the controls follow the role): the team's agent button, a reviewer's quiet chip
    await p.waitForSelector(role === 'reviewer' ? '.p-top .session-chip, .p-strip .session-chip' : '[data-testid=agent-button]', { timeout: 20000 });
  };
  /** The library in one of its layouts (remembered per browser). */
  const layoutTo = async (p, layout) => {
    if (!p.url().startsWith(BASE)) await p.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await p.evaluate(
      (l) => localStorage.setItem('vr.library', JSON.stringify({ ...JSON.parse(localStorage.getItem('vr.library') || '{}'), layout: l })),
      layout,
    );
    await p.goto('about:blank');
    await p.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector(`[data-testid=library-content][data-layout=${layout}]`, { timeout: 20000 });
  };
  /** What sticks out of the window's sides in the panel's head and the strip (sideways() lets a page that scrolls pass). */
  const outside = (p) =>
    p.$$eval('.side-title > *, .side-title button, [data-testid=run-strip] button', (els) =>
      els.flatMap((e) => {
        const r = e.getBoundingClientRect();
        return r.width && (r.right > innerWidth + 1 || r.left < -1) ? [`${e.className || e.tagName} at ${Math.round(r.left)}–${Math.round(r.right)}`] : [];
      }),
    );
  const text = (p, sel) => p.$eval(sel, (e) => e.textContent || '').catch(() => '');
  const rects = (p) =>
    p.evaluate(() => {
      const r = (sel) => {
        const b = document.querySelector(sel)?.getBoundingClientRect();
        return b ? [b.top, b.left, b.width, b.height].map((x) => Math.round(x * 2) / 2).join(',') : 'none';
      };
      return {
        strip: r('[data-testid=run-strip]'),
        head: r('.side-head'),
        first: r('[data-testid=note-row]'),
        stage: r('.stage'),
        dock: r('.dock'),
        rows: [...document.querySelectorAll('[data-testid=note-row]')].map((e) => Math.round(e.getBoundingClientRect().top * 2) / 2).join(','),
      };
    });

  await check('the strip has its slot from the first paint, and nothing moves from ready to working, rendering, needs you and done', async () => {
    await openPlayer(page);
    await go(page, null);
    await settle(page);
    const ready = await rects(page);
    assert(/Claude Code · ready · gets your notes when you send/.test(await text(page, '[data-testid=run-words]')), 'ready: its words');
    await shot(page, '01-ready');
    const seen = {};
    for (const st of ['working', 'rendering', 'needs_you', 'done']) {
      await go(page, st);
      await settle(page);
      seen[st] = await rects(page);
      await shot(page, `01-${st}`);
    }
    const fixed = ['strip', 'head', 'stage', 'dock'];
    const moving = Object.entries(seen).flatMap(([st, r]) => fixed.filter((k) => r[k] !== ready[k]).map((k) => `${k} ${ready[k]} → ${r[k]} (${st})`));
    assert(!moving.length, moving.join('; '));
    // the first row stays where it was (the plan's line slot under each row is reserved once the work starts, then
    // nothing in the list moves while it goes on and when it ends)
    assert(seen.working.first.split(',')[0] === ready.first.split(',')[0], `the list's top: ${ready.first} → ${seen.working.first}`);
    const rowsMoved = ['rendering', 'needs_you'].filter((st) => seen[st].rows !== seen.working.rows);
    assert(!rowsMoved.length, `note rows moved in: ${rowsMoved.join(', ')} (${seen.working.rows} → ${rowsMoved.map((s) => seen[s].rows).join(' | ')})`);
    // done: the version is there (the player shows it), and Check fixes is the strip's: the list's own call to check
    // gives way to it (one place to press)
    assert(!!(await page.$('[data-testid=run-check]')) && !(await page.$('.verify-cta')), 'done: Check fixes on the strip, not twice');
  });

  await check('the strip says what happens in each state, with one raised button only where the person is needed', async () => {
    const want = {
      queued: [/^Sent to Claude Code · waiting for it to start/, ['cancel']],
      starting: [/^Starting Claude Code on Studio Mac/, ['stop']],
      working: [/^Claude Code · fixing 3 of 7 · Editing src\/Logo\.tsx/, ['stop']],
      thinking: [/^Claude Code · fixing 3 of 7 · “the spring is too slow; moving the entry to frame 300”/, ['stop']],
      quiet: [/^Claude Code · fixing 1 of 7 · last: Reading the open notes · 4 min ago/, ['stop']],
      rendering: [/^Claude Code · rendering V3 · about 1 min left$/, ['stop']],
      uploading: [/^Claude Code · uploading V3$/, []],
      needs_you: [/^Claude Code · needs you · a question$/, ['answer']],
      permission: [/^Claude Code · needs permission · to run npx remotion render$/, ['allow']],
      done: [/^V3 is ready · 5 fixed · 1 asked · 12 min$/, ['check']],
      failed: [/^Claude Code · stopped · the render failed at frame 312: the font “Inter Display” is missing$/, ['log', 'retry']],
      stopped: [/^Stopped after 4 min$/, ['again']],
      lost: [/^No word from Claude Code for 22 min$/, ['nudge', 'stop']],
    };
    const out = [];
    for (const st of RUN_STATES) {
      await go(page, st);
      const words = await text(page, '[data-testid=run-words]');
      const acts = await page.$$eval('[data-testid=run-strip] .run-act', (bs) => bs.map((b) => b.dataset.testid.replace('run-', '')));
      const primary = await page.$$eval('[data-testid=run-strip] .run-act.primary', (bs) => bs.map((b) => b.dataset.testid.replace('run-', '')));
      const [re, acts0] = want[st];
      if (!re.test(words)) out.push(`${st}: "${words}"`);
      if (acts.join() !== acts0.join()) out.push(`${st}: actions ${acts.join() || 'none'}, not ${acts0.join() || 'none'}`);
      const raised = acts0.filter((a) => a === 'answer' || a === 'check');
      if (primary.join() !== raised.join()) out.push(`${st}: raised ${primary.join() || 'none'}`);
    }
    // the percentage stands at the line's end, never cut
    await go(page, 'rendering');
    assert((await text(page, '[data-testid=run-fig]')) === '42%', `rendering's figure: ${await text(page, '[data-testid=run-fig]')}`);
    const edge = await page.$eval(
      '[data-testid=run-strip] [data-testid=run-edge]',
      (e) => e.getBoundingClientRect().width / e.parentElement.getBoundingClientRect().width,
    );
    assert(Math.abs(edge - 0.42) < 0.02, `the edge fills 42 %: ${edge}`);
    // the note in hand wears the hourglass on the timeline
    await go(page, 'working');
    assert((await page.$eval('.timeline', (e) => e.dataset.inHand)) === notes[2], 'the timeline knows the note in hand');
    assert(!out.length, out.join('\n        '));
  });

  await check('the Agent view: the plan is your notes, now quotes the agent, five steps then all in the same box, Tell it…', async () => {
    await go(page, 'thinking');
    await page.click('[data-testid=run-open]');
    await page.waitForSelector('[data-testid=agent-plan]', { timeout: 15000 });
    assert(await page.$eval('[data-testid=panel-agent]', (e) => e.getAttribute('aria-selected') === 'true'), 'the Agent tab is on');
    const plan = await page.$$eval('[data-testid=agent-plan-row]', (rs) => rs.map((r) => r.textContent));
    assert(plan.length === 7, `seven notes in the plan: ${plan.length}`);
    assert(/Typo in the title.*fixed/.test(plan[0]) && /Logo enters late.*on it/.test(plan[2]) && /Music too loud here.*next/.test(plan[3]), plan.join(' | '));
    assert(/Hold the end card longer.*added/.test(plan[6]), `the note added while it works: ${plan[6]}`);
    assert((await text(page, '.av-count')).trim() === '3 of 7', `the count, as the strip says it: ${await text(page, '.av-count')}`);
    assert(/the spring is too slow/.test(await text(page, '[data-testid=agent-thought]')), 'what it said, quoted');
    const steps = await page.$$eval('[data-testid=agent-steps] li', (ls) => ls.length);
    const box = await page.$eval('[data-testid=agent-steps]', (e) => e.getBoundingClientRect().height);
    assert(steps === 5, `five steps: ${steps}`);
    await page.click('[data-testid=agent-steps-more]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=agent-steps] li').length > 5);
    const after = await page.$eval('[data-testid=agent-steps]', (e) => e.getBoundingClientRect().height);
    assert(Math.abs(after - box) <= 1, `Show all keeps the box's height: ${box} → ${after}`);
    assert(!!(await page.$('[data-testid=agent-tell]')) && !!(await page.$('[data-testid=run-stop]')), 'Tell it… and Stop for the team');
    await shot(page, '02-agent-view');
    // done: what it made, in its own words, and Check fixes stays the strip's
    await go(page, 'done');
    await page.waitForSelector('[data-testid=agent-ended]');
    assert(/V3 · Claude Code · 12 min · 5 fixed · 1 asked/.test(await text(page, '[data-testid=agent-ended]')), await text(page, '[data-testid=agent-ended]'));
    assert(/Claude Code · 1 d|V2/.test(await text(page, '[data-testid=agent-history]')), `earlier work: ${await text(page, '[data-testid=agent-history]')}`);
    await shot(page, '02-agent-view-done');
    // back to the notes
    await page.click('[data-testid=panel-notes]');
    await page.waitForSelector('[data-testid=note-row]');
  });

  await check('plan lines on the note rows; Answer opens the question on its frame', async () => {
    await go(page, 'needs_you');
    const lines = await page.$$eval('[data-testid=note-plan]', (ps) => ps.map((p) => `${p.dataset.state}:${p.textContent}`));
    assert(lines.includes('fixed:fixed · in V3') && lines.includes('asked:asked you'), lines.join(' | '));
    assert(lines.filter((l) => l === 'todo:').length === 2, `notes not reached keep an empty line: ${lines.join(' | ')}`);
    await page.click('[data-testid=run-answer]');
    await until(async () => (await page.$eval('.note.active', (e) => e.dataset.note).catch(() => null)) === notes[3], 'the question opens');
  });

  await check('Stop says stopped at once, and puts the work back when the server says no', async () => {
    await go(page, 'working');
    stopAnswer = 'hold';
    await page.click('[data-testid=run-stop]');
    await page.waitForFunction(() => document.querySelector('[data-testid=run-strip]')?.dataset.phase === 'stopped', { timeout: 5000 });
    stopAnswer = 'fail';
    await page.waitForFunction(() => document.querySelector('[data-testid=run-strip]')?.dataset.phase === 'working', { timeout: 10000 });
    assert(stops.at(-1) === 'stop', `the server was asked: ${stops}`);
    stopAnswer = 'ok';
  });

  await check('the version picker: a ghost of the version on its way, and who made each one', async () => {
    await go(page, 'rendering');
    await page.click('[data-testid=version-picker]');
    await page.waitForSelector('[data-testid=version-ghost]');
    assert(/V3.*rendering 42%.*Claude Code/.test(await text(page, '[data-testid=version-ghost]')), await text(page, '[data-testid=version-ghost]'));
    assert(/Claude Code · 12 min · 5 fixed · 1 asked/.test(await text(page, '[data-testid=version-by]')), await text(page, '[data-testid=version-by]'));
    await shot(page, '03-version-picker');
    await page.click('[data-testid=version-steps]');
    await page.waitForSelector('[data-testid=agent-view]');
    await page.click('[data-testid=panel-notes]');
  });

  await check('a reviewer sees the work, never Stop, Try again or Tell it…', async () => {
    role = 'reviewer';
    const p = await browser.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await intercept(p);
    await p.setViewport({ width: 1440, height: 900 });
    for (const st of ['working', 'failed', 'lost']) {
      state[slug] = st;
      await openPlayer(p);
      await p.waitForFunction((ph) => document.querySelector('[data-testid=run-strip]')?.dataset.phase === ph, {}, st);
      const acts = await p.$$eval('[data-testid=run-strip] .run-act', (bs) => bs.map((b) => b.dataset.testid));
      assert(!acts.some((a) => /stop|retry|nudge|again|cancel/.test(a)), `${st}: ${acts}`);
    }
    await p.click('[data-testid=run-open]');
    await p.waitForSelector('[data-testid=agent-view]');
    assert(
      !(await p.$('[data-testid=agent-tell]')) && !(await p.$('[data-testid=agent-retry]')) && !(await p.$('[data-testid=agent-stop]')),
      'no steering in the view',
    );
    await p.close();
    role = null;
  });

  await check('the board: the card says the work, a hairline on the poster while rendering, Answer in the action slot, no spinner', async () => {
    state[slug] = 'working';
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/status`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=library-board] [data-testid=run-line]', { timeout: 20000 });
    await settle(page);
    const card = (s) => `.bcard[data-slug="${s}"]`;
    const line = (s) => text(page, `${card(s)} [data-testid=run-line]`);
    assert(/Claude Code · rendering\s*42%/.test(await line(others.promo)), `rendering: ${await line(others.promo)}`);
    const edge = await page.$eval(
      `${card(others.promo)} .bthumb [data-testid=run-edge]`,
      (e) => e.getBoundingClientRect().width / e.parentElement.getBoundingClientRect().width,
    );
    assert(Math.abs(edge - 0.42) < 0.02, `the poster's hairline: ${edge}`);
    assert(!(await page.$(`${card(others.teaser)} [data-testid=run-edge]`)), 'no hairline where nothing renders');
    assert(!!(await page.$(`${card(others.teaser)} [data-testid=bcard-answer]`)), 'Answer in the action slot');
    assert(/Claude Code · failed/.test(await line(others.spring)), `failed: ${await line(others.spring)}`);
    assert(/Claude Code · fixing 3 of 7/.test(await line(slug)), `working: ${await line(slug)}`);
    assert(
      /1 agent working|2 agents working|agent working/.test(await text(page, '[data-testid=lane-note]')),
      `the lane's count: ${await text(page, '[data-testid=lane-note]')}`,
    );
    // the Agents section comes right after the first paint
    await page.waitForSelector('.nav-section [data-testid=agent-now-row]', { timeout: 20000 });
    const rows = await page.$$eval('.nav-section [data-testid=agent-now-row]', (rs) => rs.map((r) => r.textContent));
    assert(rows.length === 1 && /needs you/.test(rows[0]), `the sidebar's Agents row says what matters most: ${rows}`);
    assert(!(await page.$('.bcard .spinner, .film-over .spinner, .lwhere .spinner')), 'no spinner on a card');
    await shot(page, '04-board');
    // grid and list say it with the same line
    await layoutTo(page, 'grid');
    await page.waitForSelector('.film [data-testid=run-line]', { timeout: 20000 });
    assert(!(await page.$('.film .spinner')), 'no spinner in the grid');
    await shot(page, '04-grid');
    await layoutTo(page, 'list');
    await page.waitForSelector('.lrow [data-testid=run-line]', { timeout: 20000 });
    await shot(page, '04-list');
  });

  await check('an older server without runs: the free-text status in the keyframe language, no spinner', async () => {
    older = true;
    await layoutTo(page, 'grid');
    await page.waitForSelector('.film .vchip.agent', { timeout: 20000 });
    assert(!!(await page.$('.film .vchip.agent .kg[data-shape=ease]')) && !(await page.$('.film .spinner')), 'a keyframe, not a spinner');
    older = false;
  });

  await check('a phone: the strip above the dock, a tap opens the Agent view in the sheet, Answer a thumb’s size', async () => {
    const p = await browser.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await intercept(p);
    await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    state[slug] = 'needs_you';
    await openPlayer(p);
    const order = await p.evaluate(() => {
      const top = (s) => document.querySelector(s)?.getBoundingClientRect();
      const stage = top('.stage');
      const strip = top('.run-slot');
      const dock = top('.dock');
      return { stage: stage.bottom, strip: [strip.top, strip.bottom, strip.height], dock: dock.top };
    });
    assert(order.strip[0] >= order.stage - 1 && order.strip[1] <= order.dock + 1, `between the stage and the dock: ${JSON.stringify(order)}`);
    assert(order.strip[2] >= 44, `a thumb's height: ${order.strip[2]}`);
    const answer = await p.$eval('[data-testid=run-answer]', (b) => {
      const r = b.getBoundingClientRect();
      const a = getComputedStyle(b, '::after');
      const inset = Number.parseFloat(a.top) || 0;
      return Math.max(r.height, r.height - 2 * inset);
    });
    assert(answer >= 44, `Answer's tap area: ${answer}`);
    assert((await sideways(p)).length === 0, (await sideways(p)).join('; '));
    await shot(p, '05-phone-needs-you');
    state[slug] = 'rendering';
    await moved(p);
    await p.waitForFunction(() => document.querySelector('[data-testid=run-strip]')?.dataset.phase === 'rendering');
    await shot(p, '05-phone-rendering');
    await p.tap('[data-testid=run-open]');
    await p.waitForSelector('.nsheet [data-testid=agent-view]', { timeout: 15000 });
    assert(!(await outside(p)).length, `the sheet's head fits with the Agent view open: ${await outside(p)}`);
    const z = await p.$eval('.nsheet', (e) => getComputedStyle(e).zIndex);
    assert(!(await p.$('.nsheet-peek')), 'the sheet opened');
    await settle(p);
    await shot(p, '05-phone-agent-view');
    await p.close();
    void z;
  });

  await check('every state fits at 390, 768, 1024, 1280, 1440 and 1920, in both themes and in German', async () => {
    const out = [];
    // every state in English and the dark theme; the longest words (rendering, needs you, failed) in light and German
    const runs = [
      ['en', 'dark', ['working', 'rendering', 'needs_you', 'done', 'failed', 'lost']],
      ['en', 'light', ['rendering', 'needs_you', 'failed']],
      ['de', 'dark', ['rendering', 'needs_you', 'failed']],
      ['de', 'light', ['rendering', 'needs_you', 'failed']],
    ];
    for (const lang of ['en', 'de']) {
      const p = await browser.newPage();
      p.on('pageerror', (e) => errors.push(e.message));
      await intercept(p);
      await p.evaluateOnNewDocument((l) => {
        try {
          localStorage.setItem('vr.lang', l);
        } catch {}
      }, lang);
      // a phone first (a touch screen loads the page as one), then the desks by resizing
      for (const width of [390, 768, 1024, 1280, 1440, 1920]) {
        const phone = width < 640;
        await p.setViewport({ width, height: phone ? 844 : width < 1100 ? 1024 : 900, isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 2 : 1 });
        if (width === 390 || width === 768) {
          state[slug] = 'working';
          await openPlayer(p);
        }
        for (const [l, theme, states] of runs) {
          if (l !== lang) continue;
          await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
          for (const st of states) {
            await go(p, st);
            await settle(p);
            for (const b of [...(await sideways(p)), ...(await outside(p)), ...(await clippedText(p)), ...(await cutLabels(p))])
              out.push(`${st} @${width} ${theme} ${lang}: ${b}`);
            // the percentage is never cut, the words are cut with an ellipsis
            const fig = await p.$eval('[data-testid=run-fig]', (e) => e.scrollWidth <= e.clientWidth + 1).catch(() => true);
            if (!fig) out.push(`${st} @${width} ${theme} ${lang}: the figure is cut`);
            if (SHOTS && (st === 'rendering' || st === 'needs_you') && [390, 768, 1440].includes(width)) await shot(p, `06-${st}-${width}-${theme}-${lang}`);
          }
        }
      }
      await p.close();
    }
    assert(!out.length, out.join('\n        '));
  });

  await check('with the server’s own work: Send opens it, the agent’s first call starts it, Stop ends it', async () => {
    // a video the fixtures leave alone, and a page that hears the server as it is
    const real = await video('real.mp4', 'Real', 'testsrc2');
    await api(`/api/review/${enc(real)}/session`, 'PUT', { name: 'Claude Code', sessionId: 'mcp-real', agent: 'claude-code' });
    for (const [frame, text] of [
      [10, 'Swoosh on the first title'],
      [40, 'Logo a touch later'],
    ])
      await api(`/api/review/${enc(real)}/drafts`, 'POST', { frame, text, severity: 'should' });
    const sent = await api(`/api/review/${enc(real)}/drafts/send`, 'POST', {});
    const p = await browser.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    // in English again (the matrix above left German in this browser's storage)
    await p.evaluateOnNewDocument(() => {
      try {
        localStorage.setItem('vr.lang', 'en');
      } catch {}
    });
    await p.setViewport({ width: 1440, height: 900 });
    await openPlayer(p, real);
    const phase = () => p.$eval('[data-testid=run-strip]', (e) => e.dataset.phase).catch(() => null);
    await until(
      async () => (await phase()) === 'queued',
      async () => `the strip says ${await phase()} after Send`,
    );
    assert(/^Sent to Claude Code · waiting for it to start/.test(await text(p, '[data-testid=run-words]')), await text(p, '[data-testid=run-words]'));
    // the agent's first call (here `vr` on this machine, as the agent): the work begins, and the page hears it
    const vrEnv = { ...srv.env, VR_BY: 'agent:Claude Code' };
    execFileSync(process.execPath, [path.join(ROOT, 'bin/vr'), 'show', sent.notes[0].id], { env: vrEnv, encoding: 'utf8' });
    await until(
      async () => !['queued', null].includes(await phase()),
      async () => `the strip still says ${await phase()} after the agent's call`,
    );
    await shot(p, '07-real-working');
    if ((await phase()) === 'working' || (await phase()) === 'starting') {
      await p.click('[data-testid=run-stop]');
      await until(async () => (await phase()) === 'stopped', 'stopped on the strip');
      await until(async () => (await api(`/api/runs?slug=${enc(real)}`)).runs[0]?.state === 'stopped', 'stopped on the server');
    }
    await p.close();
  });

  await check('no page errors', async () => {
    assert(!errors.length, errors.join(' | '));
  });
  await sleep(0);
} catch (e) {
  crashed(e, srv);
} finally {
  await finish(LABEL, { browser, servers: [srv] });
}
