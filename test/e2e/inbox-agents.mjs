#!/usr/bin/env node
// covers: web/src/inbox/ web/src/sessions/RunNeeds.tsx web/src/styles/runneeds.css web/src/foryou/ lib/foryou.ts lib/pushPrefs.ts
// covers: server/runs.ts server/routes/runs.ts server/routes/phone.ts
// Browser end-to-end test of an agent's work that needs the person, in the inbox: a permission it was refused (the
// exact settings rule, Copy), work that failed (its error, the tool's last lines, Try again takes it off the list), an
// agent gone quiet (Nudge) and work never picked up — beside today's questions and fixes, ahead of fixes to check, the
// quiet ones folded into Stalled. A reviewer of a hosted team sees none of it; Settings → Notifications has the agents
// and quiet switches. Every screen at 390–1920, both themes and German, with real-shaped work written as the server
// keeps it (data/<slug>/runs.jsonl). Screenshots land in VR_SHOTS.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { age, makeVideo, sleep, until, VR } from '../lib/helpers.ts';
import { client, cookieFrom, tusUpload } from '../lib/http.ts';
import { clippedText, cutLabels, settle, sideways } from './layout.mjs';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'inbox agents e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-inbox-agents-e2e-', user: 'Sam' });
const { dir, base: BASE } = srv;
const api = jsonApi(BASE);
const enc = encodeURIComponent;
const servers = [srv];

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace(/\.\d{3}Z$/, 'Z');
const MIN = 60_000;
let n = 0;
const runId = () => `run_${(0xa1b2c3d4e500 + ++n).toString(16)}`;

/** A run as the server keeps it (lib/runs.ts StoredRun): its head, its steps, its clock. */
function run(slug, o) {
  const started = o.started ?? iso(30 * MIN);
  return {
    id: o.id ?? runId(),
    slug,
    agent: { name: o.agent ?? 'Claude Code', kind: 'claude-code' },
    opened_by: { who: 'Sam', how: 'send' },
    delivery: o.delivery ?? 'listening',
    state: o.state,
    started,
    ended: o.ended ?? null,
    seen: o.seen ?? started,
    worked_s: o.worked_s ?? 540,
    plan: (o.plan ?? []).map((id, i) => ({ id, state: i < (o.answered ?? 0) ? 'fixed' : 'todo', at: started })),
    now: o.now ?? null,
    ...(o.error ? { error: o.error } : {}),
    ...(o.needs ? { needs: o.needs } : {}),
    ...(o.log ? { log: true } : {}),
    steps: o.steps ?? [],
    clock: { tick: o.seen ?? started, began: started },
  };
}
const write = (slug, runs) => fs.writeFileSync(path.join(dir, 'data', slug, 'runs.jsonl'), `${runs.map((r) => JSON.stringify(r)).join('\n')}\n`);

let browser;
const errors = [];
try {
  // ---------------------------------------------------------------- the store: five videos, an agent at each
  const video = async (name, folder, pattern) => {
    const file = makeVideo(path.join(dir, `Acme/${folder}/${name}`), { w: 320, h: 180, fps: 25, dur: 3, pattern });
    age(file);
    return (await api('/api/library', 'POST', { path: file, folder: `Acme/${folder}` })).video.slug;
  };
  const launchV = await video('launch.mp4', 'Launch', 'testsrc2');
  const promo = await video('promo.mp4', 'Promo', 'smptebars');
  const teaser = await video('teaser.mp4', 'Teaser', 'testsrc');
  const spring = await video('spring.mp4', 'Spring', 'rgbtestsrc');
  const reel = await video('reel.mp4', 'Reels', 'testsrc2');
  for (const s of [launchV, promo, teaser, spring, reel])
    await api(`/api/review/${enc(s)}/session`, 'PUT', { name: 'Claude Code', sessionId: `mcp-${s.slice(-12)}`, agent: 'claude-code' });
  const note = (s, frame, text) => api(`/api/review/${enc(s)}/comments`, 'POST', { v: 1, frame, text, severity: 'must' });
  // today's: a question from the agent and a fix to check on launch.mp4
  await api(`/api/review/${enc(launchV)}/comments`, 'POST', {
    v: 1,
    frame: 30,
    text: 'Cut the last shot? It runs past the music.',
    kind: 'question',
    by: 'agent:Claude Code',
    choices: ['Yes, cut it', 'No, keep it'],
  });
  const fix = await note(launchV, 12, 'Logo enters a beat late');
  await api(`/api/comments/${fix.id}`, 'PATCH', { status: 'fixed', note: 'Moved the entry to frame 300', by: 'agent:Claude Code' });
  const promoNotes = [(await note(promo, 20, 'Wrong font in the title')).id, (await note(promo, 50, 'Music too loud')).id];
  const teaserNotes = [(await note(teaser, 15, 'Render at 1080×1920')).id];
  const springNotes = [
    (await note(spring, 10, 'Warmer grade')).id,
    (await note(spring, 40, 'Hold the end card')).id,
    (await note(spring, 60, 'Tighter cut')).id,
  ];
  const reelNotes = [(await note(reel, 25, 'Swap the music')).id];

  const failed = run(promo, {
    state: 'failed',
    started: iso(21 * MIN),
    ended: iso(9 * MIN),
    seen: iso(9 * MIN),
    plan: promoNotes,
    answered: 1,
    error: {
      text: 'The render failed (exit 1)',
      key: 'The render failed (exit {code})',
      vars: { code: 1 },
      quote: 'Rendered 312/900, time remaining: 1m 2s ↵ Error: Font "Inter Display" could not be loaded ↵ at loadFont (src/fonts.ts:14:11)',
    },
    steps: [
      { text: 'Reading the open notes', key: 'Reading the open notes', at: iso(20 * MIN), type: 'action' },
      { text: 'Editing src/Title.tsx', key: 'Editing {file}', vars: { file: 'src/Title.tsx' }, at: iso(16 * MIN), type: 'action' },
      { text: 'Rendering a new version', key: 'Rendering a new version', at: iso(12 * MIN), type: 'progress' },
      { text: 'The render failed (exit 1)', key: 'The render failed (exit {code})', vars: { code: 1 }, at: iso(9 * MIN), type: 'error' },
    ],
  });
  const ALLOW = 'Bash(npx remotion render:*)';
  const blocked = run(teaser, {
    state: 'needs_you',
    delivery: 'machine',
    log: true,
    started: iso(8 * MIN),
    ended: iso(5 * MIN),
    seen: iso(5 * MIN),
    plan: teaserNotes,
    needs: {
      kind: 'permission',
      text: { text: 'Needs permission to run npx remotion render', key: 'Needs permission to run {command}', vars: { command: 'npx remotion render' } },
      allow: ALLOW,
    },
  });
  const lost = run(spring, {
    state: 'working',
    started: iso(70 * MIN),
    seen: iso(40 * MIN),
    plan: springNotes,
    answered: 1,
    now: { text: 'Editing src/Grade.tsx', key: 'Editing {file}', vars: { file: 'src/Grade.tsx' }, type: 'action', at: iso(40 * MIN) },
    steps: [{ text: 'Editing src/Grade.tsx', key: 'Editing {file}', vars: { file: 'src/Grade.tsx' }, at: iso(40 * MIN), type: 'action' }],
  });
  const queued = run(reel, { state: 'queued', started: iso(14 * MIN), plan: reelNotes });
  write(promo, [failed]);
  write(teaser, [blocked]);
  write(spring, [lost]);
  write(reel, [queued]);

  browser = await launch();
  await browser.defaultBrowserContext().overridePermissions(BASE, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  const page = await browser.newPage();
  screenshotFailures(() => page, 'inbox-agents');
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1440, height: 900 });
  const shot = async (p, name) => SHOTS && p.screenshot({ path: path.join(SHOTS, `inbox-agents-${name}.png`) });
  const VIEW = '[data-testid="inbox-view"]';
  const READY = `${VIEW} :is(.inbox-row:not(.pending), .fy-item:not(.pending))`;
  const openInbox = async (p, mode) => {
    await p.evaluateOnNewDocument((m) => {
      try {
        localStorage.setItem('vr.inbox', JSON.stringify({ mode: m }));
      } catch {}
    }, mode ?? 'video');
    await p.goto(`${BASE}/#/inbox`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector(READY, { timeout: 20000 });
  };
  const row = (kind) => `${VIEW} [data-testid="inbox-row-${kind}"]`;

  await check('the server lists them: blocked and failed ahead of fixes to check, quiet ones stalled, each with its run', async () => {
    const fy = await api('/api/for-you');
    const kinds = fy.items.map((i) => i.kind);
    const at = (k) => kinds.indexOf(k);
    assert(at('question') < at('blocked') && at('blocked') < at('failed') && at('failed') < at('verify'), `the order: ${kinds.join(', ')}`);
    const lostItem = fy.items.find((i) => i.key === `lost:${lost.id}`);
    assert(lostItem?.kind === 'stalled' && lostItem.reason === 'lost' && lostItem.run?.state === 'lost', `lost: ${JSON.stringify(lostItem)}`);
    assert(
      fy.items.some((i) => i.key === `queued:${queued.id}` && i.reason === 'queued'),
      'sent and never picked up: stalled',
    );
    assert(fy.items.find((i) => i.kind === 'blocked')?.run?.needs?.allow === ALLOW, 'the rule');
    assert(fy.counts.blocked === 1 && fy.counts.failed === 1, `counts: ${JSON.stringify(fy.counts)}`);
  });

  await check('by kind: “Waiting for your OK” and “Agents that stopped” lead after questions; Stalled says who went quiet', async () => {
    await openInbox(page, 'kind');
    const heads = await page.$$eval(`${VIEW} .inbox-group-h`, (els) => els.map((e) => e.textContent.replace(/\s*\d+$/, '').trim()));
    const i = (t) => heads.findIndex((h) => h.startsWith(t));
    assert(i('Questions from agents') === 0 && i('Waiting for your OK') === 1 && i('Agents that stopped') === 2, `groups: ${heads.join(' | ')}`);
    assert(i('Fixes to check') > i('Agents that stopped') && i('Stalled') === heads.length - 1, `groups: ${heads.join(' | ')}`);
    const stalled = await page.$$eval(`${VIEW} [data-testid="inbox-row-stalled"]`, (els) => els.map((e) => e.textContent));
    assert(
      stalled.some((t) => /No word from Claude Code/.test(t) && /40 min/.test(t) && /1 of 3 notes done/.test(t)),
      `quiet: ${stalled.join(' | ')}`,
    );
    assert(
      stalled.some((t) => /Claude Code hasn’t started/.test(t) && /Sent 14 min ago/.test(t)),
      `queued: ${stalled.join(' | ')}`,
    );
    // a failure says the line that names the error, not the stack's last frame
    const failedRow = await page.$eval(row('failed'), (e) => e.textContent);
    assert(/Rendering failed \(exit 1\): Error: Font "Inter Display" could not be loaded/.test(failedRow), failedRow);
    await shot(page, '01-by-kind-1440');
  });

  await check('a permission it lacks: the preview shows the exact rule in a code box, Copy puts it on the clipboard; no “Got it”', async () => {
    await openInbox(page);
    await page.click(row('blocked'));
    await page.waitForSelector('[data-testid="inbox-preview"] [data-testid="run-permission"]', { timeout: 20000 });
    const text = await page.$eval('[data-testid="run-permission"]', (e) => e.textContent);
    assert(text.includes('Needs permission to run npx remotion render') && text.includes('.claude/settings.json'), text);
    const rule = await page.$eval('[data-testid="run-allow"] pre', (e) => e.textContent);
    assert(rule === ALLOW, `the rule: ${rule}`);
    assert(!(await page.$('[data-testid="inbox-preview"] .inbox-pv-act button[data-testid="inbox-row-done"]')), 'no Got it');
    // ended waiting: Send again, not Stop
    assert(await page.$('[data-testid="inbox-run-again"]'), 'Send again once it ended');
    await page.click('[data-testid="run-allow-copy"]');
    await until(async () => (await page.$eval('[data-testid="run-allow-copy"]', (e) => e.textContent)).includes('Copied'), 'Copied');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert(copied === ALLOW, `on the clipboard: ${copied}`);
    await shot(page, '02-permission-1440');
  });

  await check('a failure: the error in words, the last lines the tool printed and its steps; Try again takes it off the list', async () => {
    await page.click(row('failed'));
    await page.waitForSelector('[data-testid="inbox-preview"] [data-testid="run-failure"]', { timeout: 20000 });
    const said = await page.$eval('[data-testid="run-failure"]', (e) => e.textContent);
    assert(said.includes('Rendering failed (exit 1)'), said);
    const lines = await page.$eval('[data-testid="run-log-lines"]', (e) => e.textContent.split('\n'));
    assert(lines.at(-1)?.includes('at loadFont') && lines.some((l) => l.includes('Inter Display')), `lines: ${lines.join(' | ')}`);
    await page.waitForSelector('[data-testid="run-steps"] li', { timeout: 10000 });
    await shot(page, '03-failed-1440');
    await page.click('[data-testid="inbox-run-retry"]');
    await until(async () => !(await page.$(row('failed'))), 'the failure leaves the list');
    const runs = (await api(`/api/runs?slug=${enc(promo)}`)).runs;
    assert(runs[0]?.follows === failed.id && runs[0]?.opened_by.how === 'retry', `a follow-up: ${JSON.stringify(runs[0])}`);
  });

  await check('an agent gone quiet: Nudge reaches it on the same work, and it stays listed until it is heard from', async () => {
    const quiet = await page.$(`${VIEW} [data-testid="inbox-row-stalled"][data-key="lost:${lost.id}"]`);
    assert(quiet, 'its row');
    await quiet.click();
    await page.waitForSelector('[data-testid="inbox-run-nudge"]', { timeout: 20000 });
    await shot(page, '04-lost-1440');
    await page.click('[data-testid="inbox-run-nudge"]');
    await page.waitForFunction(
      () => [...document.querySelectorAll('[role=status], .toast, [data-sonner-toast]')].some((e) => /Nudged Claude Code/.test(e.textContent)),
      {
        timeout: 10000,
      },
    );
    const after = (await api(`/api/runs?slug=${enc(spring)}`)).runs;
    assert(after.length === 1 && after[0].id === lost.id, 'the same work, no other opened');
    assert(after[0].state === 'lost', 'quiet until it is heard from');
  });

  await check('in the player: the strip says what it needs, “How to allow it” opens the Agent view with the rule and Send again', async () => {
    const p = await browser.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.setViewport({ width: 1440, height: 900 });
    await p.goto(`${BASE}/#/v/${enc(teaser)}`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('[data-testid=run-strip]:not(.pending)', { timeout: 20000 });
    const words = await p.$eval('[data-testid=run-words]', (e) => e.textContent);
    assert(words === 'Claude Code · needs permission to run npx remotion render', `the strip: ${words}`);
    await p.click('[data-testid=run-allow]');
    await p.waitForSelector('[data-testid=agent-view] [data-testid=run-permission] [data-testid=run-allow]', { timeout: 20000 });
    const rule = await p.$eval('[data-testid=agent-view] [data-testid=run-allow] pre', (e) => e.textContent);
    assert(rule === ALLOW, `the rule: ${rule}`);
    assert(await p.$('[data-testid=agent-view] [data-testid=agent-retry]'), 'Send again');
    await settle(p);
    await shot(p, '09-agent-view-permission-1440');
    await p.close();
  });

  await check('a reviewer of a hosted team sees none of an agent’s work; the owner does', async () => {
    const hosted = await startServer({ prefix: 'vr-inbox-agents-hosted-e2e-', mode: 'server', publicUrl: true });
    servers.push(hosted);
    const request = client(hosted.port);
    const token = await hosted.setupToken();
    assert(token, 'a setup token');
    const setup = await request('POST', '/api/auth/setup', {
      body: { token, email: 'owner@e2e.test', name: 'Olivia', password: 'a long enough password' },
      headers: { Origin: hosted.base },
    });
    assert(setup.status === 200, setup.text);
    const owner = { Cookie: cookieFrom(setup), Origin: hosted.base };
    execFileSync(
      process.execPath,
      [VR, 'admin', 'create-user', '--email', 'rafa@e2e.test', '--name', 'Rafa', '--role', 'reviewer', '--password', 'rafas long password'],
      {
        env: hosted.env,
        stdio: 'pipe',
      },
    );
    const file = makeVideo(path.join(hosted.dir, 'in/spot.mp4'), { w: 320, h: 180, fps: 25, dur: 2 });
    const up = await tusUpload(request, file, { filename: 'spot.mp4', folder: 'Acme' }, owner);
    assert(up.status === 200, up.text);
    const lib = (await request('GET', '/api/library', { headers: owner })).json();
    const slug = lib.videos[0].slug;
    const folder = path.dirname(
      fs
        .readdirSync(path.join(hosted.dir, 'data'), { recursive: true })
        .map(String)
        .find((f) => f.endsWith('review.json')) ?? '',
    );
    fs.writeFileSync(
      path.join(hosted.dir, 'data', folder, 'runs.jsonl'),
      `${JSON.stringify(run(slug, { state: 'failed', started: iso(9 * MIN), ended: iso(5 * MIN), seen: iso(5 * MIN), error: failed.error }))}\n`,
    );
    const ownerFy = (await request('GET', '/api/for-you', { headers: owner })).json();
    assert(
      ownerFy.items.some((i) => i.kind === 'failed'),
      `the owner sees it: ${ownerFy.items.map((i) => i.kind)}`,
    );
    const login = await request('POST', '/api/auth/login', {
      body: { email: 'rafa@e2e.test', password: 'rafas long password' },
      headers: { Origin: hosted.base },
    });
    assert(login.status === 200, login.text);
    const rafa = cookieFrom(login);
    const theirs = (await request('GET', '/api/for-you', { headers: { Cookie: rafa } })).json();
    assert(!theirs.items.some((i) => i.run || i.kind === 'failed' || i.kind === 'blocked'), `a reviewer: ${theirs.items.map((i) => i.kind)}`);
    const p = await browser.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    const [name, value] = rafa.split('=');
    await p.setCookie({ name, value, url: hosted.base });
    await p.setViewport({ width: 1440, height: 900 });
    await p.goto(`${hosted.base}/#/inbox`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector(`${VIEW} :is(.inbox-row:not(.pending), .empty-state)`, { timeout: 20000 });
    await sleep(500);
    assert(!(await p.$(`${VIEW} :is([data-testid="inbox-row-failed"], [data-testid="inbox-row-blocked"])`)), 'no agent item in their inbox');
    await p.close();
  });

  await check('Settings → Notifications: an agents switch (on) and a quiet one (off) for this device, saved on the server', async () => {
    const EP = 'https://fcm.googleapis.com/fcm/send/inbox-agents-e2e-device';
    const KEYS = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
    const p = await browser.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.setViewport({ width: 1440, height: 900 });
    // a headless browser has no push service: the page's permission and subscription are stand-ins (inbox.mjs)
    await p.evaluateOnNewDocument((ep) => {
      if (typeof ServiceWorkerContainer === 'undefined' || typeof Notification === 'undefined') return;
      localStorage.setItem('test.push.endpoint', ep);
      Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
      const own = ServiceWorkerContainer.prototype.getRegistration;
      ServiceWorkerContainer.prototype.getRegistration = function (...a) {
        const e = localStorage.getItem('test.push.endpoint');
        if (!e) return own.apply(this, a);
        const sub = { endpoint: e, toJSON: () => ({ endpoint: e, keys: {} }), unsubscribe: async () => true };
        return Promise.resolve({ pushManager: { getSubscription: async () => sub } });
      };
    }, EP);
    await api('/api/push/subscribe', 'POST', { subscription: { endpoint: EP, keys: KEYS }, name: 'Test Mac' });
    try {
      await p.goto(`${BASE}/#/settings/notifications`, { waitUntil: 'domcontentloaded' });
      await p.waitForSelector('[data-testid="push-settings"][data-state="on"]:not([aria-busy])', { timeout: 20000 });
      const on = (id) => p.$eval(`#fy-pref-${id}`, (e) => e.getAttribute('aria-checked') === 'true' || e.getAttribute('data-state') === 'checked');
      assert((await on('agents')) && !(await on('quiet')), 'agents on, quiet off by default');
      const text = await p.$eval('[data-testid="push-settings"]', (e) => e.textContent);
      assert(text.includes('Agents that stop or wait') && text.includes('Agents gone quiet'), text);
      await p.click('#fy-pref-quiet');
      await until(async () => (await api(`/api/push?endpoint=${enc(EP)}`)).subscription?.prefs.quiet === true, 'quiet saved');
      await p.click('#fy-pref-agents');
      await until(async () => (await api(`/api/push?endpoint=${enc(EP)}`)).subscription?.prefs.agents === false, 'agents saved');
      await shot(p, '05-settings-notifications');
    } finally {
      await api('/api/push/unsubscribe', 'POST', { endpoint: EP }).catch(() => {});
      await p.close();
    }
  });

  await check('every screen fits at 390, 768, 1024, 1280, 1440 and 1920, in both themes and in German', async () => {
    // the failure was tried again above: a new one, as before, for the matrix
    write(promo, [{ ...failed, id: runId() }]);
    const out = [];
    for (const lang of ['en', 'de']) {
      const p = await browser.newPage();
      p.on('pageerror', (e) => errors.push(e.message));
      await p.evaluateOnNewDocument((l) => {
        try {
          localStorage.setItem('vr.lang', l);
        } catch {}
      }, lang);
      for (const width of [390, 768, 1024, 1280, 1440, 1920]) {
        const phone = width < 640;
        await p.setViewport({ width, height: phone ? 844 : width < 1100 ? 1024 : 900, isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 2 : 1 });
        for (const theme of ['dark', 'light']) {
          await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
          await openInbox(p);
          await settle(p);
          const tag = `${width} ${theme} ${lang}`;
          for (const b of [...(await sideways(p)), ...(await clippedText(p)), ...(await cutLabels(p))]) out.push(`list @${tag}: ${b}`);
          if (SHOTS && [390, 768, 1440, 1920].includes(width)) await shot(p, `06-list-${width}-${theme}-${lang}`);
          // the preview of each (wide: beside the list; narrower: the cards have it)
          if (width >= 1100)
            for (const kind of ['blocked', 'failed']) {
              await p.click(row(kind));
              await p.waitForSelector(`[data-testid="inbox-preview"] [data-testid="${kind === 'blocked' ? 'run-permission' : 'run-failure'}"]`, {
                timeout: 20000,
              });
              await settle(p);
              for (const b of [...(await clippedText(p)), ...(await cutLabels(p))]) out.push(`${kind} @${tag}: ${b}`);
              if (SHOTS && [1440, 1920].includes(width)) await shot(p, `07-${kind}-${width}-${theme}-${lang}`);
            }
          else if (SHOTS && (width === 390 || width === 768)) {
            // the cards: the rule to copy and the last lines, on the card itself
            const card = await p.$('[data-testid="fy-blocked"]');
            if (card) await card.evaluate((e) => e.scrollIntoView({ block: 'start' }));
            await sleep(300);
            await shot(p, `08-cards-${width}-${theme}-${lang}`);
          }
        }
      }
      await p.close();
    }
    assert(!out.length, out.join('\n        '));
  });

  await check('no page errors', () => assert(!errors.length, errors.join('\n')));
} catch (e) {
  crashed(e, ...servers);
}
await finish(LABEL, { browser, servers });
