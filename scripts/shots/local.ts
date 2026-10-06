// The pictures of the app on a person's own machine, from one demo store whose story moves on between them (made-up
// names, synthetic footage): the README's library, player, check mode and review link; then a recording, a transcript,
// settings, a playbook and the MCP review card; then an agent at work (a fix preview, a question with choices, the board,
// the inbox, the live monitor); then V3 approved (the player's next step); then the review links' activity and room.
// Every state is made the way people and agents make it: the HTTP API the app uses, the guest API a client's browser
// uses, `vr` run as the agent (VR_BY=agent:…), an MCP client over /mcp, and the app's own UI.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Browser, KeyInput, Page } from 'puppeteer-core';
import { build } from 'vite';
import { ROOT } from '../../lib/paths.ts';
import { FFMPEG } from '../../lib/probe.ts';
import type { Comment, Review } from '../../lib/types.ts';
import { encodeParts, PARTS } from '../../lib/watch.ts';
import type { DemoMedia } from '../demo/media.ts';
import { render, score } from '../demo/media.ts';
import type { DemoServer } from '../demo/server.ts';
import type { DemoStore } from '../demo/store.ts';
import { type Camera, DAY_ZONE, noPrivate, scheme, sleep, tipsSeen } from './camera.ts';

/** What the browser calls the app on this machine: Chrome maps it to the demo server (--host-resolver-rules). */
export const LOCAL_HOST = 'localhost:4747';

export interface LocalScene {
  browser: Browser;
  camera: Camera;
  server: DemoServer;
  /** The store's folder (data/, cache/, config.json, home/ inside), as startServer laid it out. */
  dir: string;
  media: DemoMedia;
  demo: DemoStore;
  work: string;
}

const enc = encodeURIComponent;
type Json = Record<string, unknown>;

export async function localPictures(s: LocalScene): Promise<void> {
  const { browser, camera, server, media, demo } = s;
  const BASE = `http://${LOCAL_HOST}`;

  // ---------------------------------------------------------------- talking to the app
  const call = async <T = Json>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> => {
    const go = () =>
      fetch(server.url + p, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    // a pooled keep-alive socket the server has closed in the meantime fails once; a fresh one works
    const res = await go().catch(() => go());
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  };
  const review = async (slug: string) => (await call<{ review: Review }>('GET', `/api/review/${enc(slug)}`)).review;
  const noteBy = async (slug: string, text: string) => {
    const c = (await review(slug)).comments.find((x) => x.text?.includes(text));
    if (!c) throw new Error(`no note "${text}" on ${slug}`);
    return c;
  };
  const settle = async (p: string) => {
    for (let i = 0; i < 600; i++) {
      const r = await call<{ pending?: boolean }>('GET', p).catch(() => ({ pending: true }));
      if (!r?.pending) return;
      await sleep(500);
    }
    throw new Error(`still pending: ${p}`);
  };
  const waitFor = async (what: string, fn: () => Promise<boolean>, ms = 60_000) => {
    for (const t = Date.now(); Date.now() - t < ms; await sleep(250)) if (await fn().catch(() => false)) return;
    throw new Error(`timed out: ${what}`);
  };

  // `vr` as the agent would run it: the store's own environment, and the agent's name in VR_BY (that is what makes its
  // commands show in the live monitor). Nothing of this machine's own session or account goes in.
  const vrEnv = (agent: string): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH,
    HOME: path.join(s.dir, 'home'),
    XDG_CONFIG_HOME: path.join(s.dir, 'home/.config'),
    XDG_CACHE_HOME: path.join(s.dir, 'home/.cache'),
    VR_DATA: path.join(s.dir, 'data'),
    VR_CACHE: path.join(s.dir, 'cache'),
    VR_CONFIG: path.join(s.dir, 'config.json'),
    VR_STT: 'off',
    VR_FOOTAGE: 'off',
    VR_BY: `agent:${agent}`,
  });
  const vr = (agent: string, ...args: string[]) =>
    execFileSync(process.execPath, [path.join(ROOT, 'bin/vr'), ...args], { env: vrEnv(agent), encoding: 'utf8', cwd: s.work });
  const vrWatching: ChildProcess[] = [];
  const vrWatch = (agent: string) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'bin/vr'), 'watch', '--mine'], { env: vrEnv(agent), stdio: 'ignore', cwd: s.work });
    vrWatching.push(p);
    // a watch waits for good: it ends with this script, however the script ends
    process.on('exit', () => p.kill());
  };

  // A client's browser, as the guest API sees it: from another address than this machine (the machine's own loopback
  // is the team checking its own link, which is never counted), with its page's random visitor id.
  const guest = (who: { ip: string; visitor: string; name: string }) => ({
    get: <T = Json>(p: string) => call<T>('GET', p, undefined, { 'x-forwarded-for': who.ip }),
    post: <T = Json>(p: string, body: Json) => call<T>('POST', p, { ...body }, { 'x-forwarded-for': who.ip }),
  });

  // ---------------------------------------------------------------- the browser
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.emulateTimezone(DAY_ZONE);
  await scheme(page, 'dark');
  await tipsSeen(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const until = (fn: string, timeout = 30_000, p: Page = page) => p.waitForFunction(fn, { polling: 100, timeout });
  const open = async (hash: string, p: Page = page) => {
    await p.goto('about:blank');
    await p.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
  };
  const videoReady = (p: Page = page, sel = '.vbox video') =>
    until(
      `[...document.querySelectorAll(${JSON.stringify(sel)})].length > 0 && [...document.querySelectorAll(${JSON.stringify(sel)})].every((v) => v.readyState >= 2 && !v.seeking)`,
      30_000,
      p,
    );
  const shift = async (key: KeyInput, p: Page = page) => {
    await p.keyboard.down('Shift');
    await p.keyboard.press(key);
    await p.keyboard.up('Shift');
  };
  const goto = async (slug: string, v: number, frame: number) => {
    await page.evaluate(`window.dispatchEvent(new CustomEvent('vr-goto-frame', { detail: { slug: ${JSON.stringify(slug)}, v: ${v}, frame: ${frame} } }))`);
    await until(`Number(document.querySelector('.tc .sub b')?.textContent) === ${frame}`);
  };
  const rest = () => page.mouse.move(2, 600);
  const imagesLoaded = (sel: string) => until(`[...document.querySelectorAll(${JSON.stringify(sel)})].every((i) => i.complete && i.naturalWidth > 0)`);

  const glow = demo.filmNote;
  const typo = (await noteBy(demo.film, 'Availble')).id;
  const titleNote = (await noteBy(demo.film, 'title lands too early')).id;
  const lineNote = (await noteBy(demo.film, 'reads a little flat')).id;
  const endCard = (await noteBy(demo.film, 'Hold the end card')).id;

  // ================================================================ A. the demo as it is: the README's pictures
  console.log('the README…');
  await open('#/');
  await until("document.querySelectorAll('.film').length === 4");
  await imagesLoaded('.film img');
  await sleep(800);
  await camera.shoot(page, 'library', { full: true }, { ready: () => imagesLoaded('.film img') });

  await open(`#/v/${enc(demo.film)}?c=${glow}`);
  await videoReady();
  await sleep(1500);
  await rest();
  await camera.shoot(page, 'player', { full: true }, { ready: () => videoReady() });

  await shift('KeyV');
  await page.waitForSelector('.verify', { timeout: 10_000 });
  await videoReady();
  await sleep(1500);
  await rest();
  await camera.shoot(page, 'verify', { full: true }, { ready: () => videoReady() });

  await page.goto(`${BASE}/g/${demo.shareToken}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.guest', { timeout: 15_000 });
  await videoReady();
  // the client says who they are, as the link asks the first time
  const asked = await page.$('.g-player input[placeholder="Your name"]');
  if (asked) {
    await asked.type('Mia');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.g-player input[placeholder="Your name"]', { hidden: true, timeout: 10_000 });
  }
  for (let i = 0; i < 6; i++) await shift('ArrowRight');
  await sleep(1200);
  await rest();
  await camera.shoot(page, 'guest', { full: true }, { ready: () => videoReady() });

  // ================================================================ the transcript: what the film's voice-over says
  console.log('the transcript…');
  await open(`#/v/${enc(demo.film)}`);
  await videoReady();
  await page.click('[data-testid=panel-transcript]');
  await page.waitForSelector('[data-testid=transcript] .tr-line [data-w]', { timeout: 60_000 });
  await sleep(600);
  {
    // drag over "on the record." the way a person picks words
    const words = (await page.evaluate(`[...document.querySelectorAll('[data-testid=transcript] [data-w]')].map((e) => {
      const r = e.getBoundingClientRect();
      return { text: e.textContent.trim(), x: r.left, y: r.top, w: r.width, h: r.height };
    })`)) as { text: string; x: number; y: number; w: number; h: number }[];
    const from = words.findIndex((w, i) => w.text === 'on' && words[i - 1]?.text === 'mile,');
    const to = words.findIndex((w) => w.text === 'record.');
    if (from < 0 || to < 0) throw new Error(`transcript words: ${words.map((w) => w.text).join(' ')}`);
    const a = words[from];
    const b = words[to];
    await page.mouse.move(a.x + 2, a.y + a.h / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.w / 2, b.y + b.h / 2, { steps: 6 });
    await page.mouse.move(b.x + b.w - 1, b.y + b.h / 2, { steps: 3 });
    await page.mouse.up();
    await page.waitForSelector('[data-testid=transcript-pick]', { visible: true });
    await page.waitForSelector('[data-testid=transcript-heard]');
    await sleep(500);
    await page.mouse.move(1000, 880);
    await camera.shoot(page, 'transcript', { around: ['.side .side-head', '[data-testid=transcript-foot]'], pad: [0, 0, 20, 0] });
  }

  // ================================================================ recorded feedback: talking while watching
  console.log('a recording…');
  await open(`#/v/${enc(demo.film)}`);
  await videoReady();
  await page.waitForSelector('[data-testid=record]:not([disabled])', { timeout: 30_000 });
  // the panel opens on the transcript again (remembered per video): back to the notes, as a person would
  if (await page.evaluate("document.querySelector('[data-testid=panel-transcript]')?.getAttribute('aria-selected') === 'true'"))
    await page.click('[data-testid=panel-notes]').catch(() => {});
  await sleep(500);
  await goto(demo.film, 2, 30);
  await shift('KeyR');
  await page.waitForSelector('[data-testid=rec-bar]', { timeout: 15_000 });
  {
    const t0 = Date.now();
    const at = async (sec: number) => {
      const w = sec * 1000 - (Date.now() - t0);
      if (w > 0) await sleep(w);
    };
    // 0–2.6 s paused on the title ("Let the title breathe…"), then the line, the pointer resting on it ("This line could
    // sit a little higher"), then the end card played in ("The end card comes in too fast")
    await at(2.6);
    await goto(demo.film, 2, 168);
    const box = (await page.evaluate(
      "(() => { const r = document.querySelector('.vbox').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()",
    )) as { x: number; y: number; w: number; h: number };
    await page.mouse.move(box.x + box.w * 0.52, box.y + box.h * 0.5, { steps: 6 });
    await at(5.8);
    await goto(demo.film, 2, 252);
    await page.keyboard.press('Space');
    await at(8.8);
    await page.keyboard.press('Space');
    await at(9.3);
    await page.click('[data-testid=rec-done]');
  }
  await page.waitForSelector('[data-testid=drafts][data-state=ready]', { timeout: 90_000 });
  await rest();
  await sleep(400);
  // the draft with the ring (where the pointer rested), looked at on its frame: its ring on the stage
  const drafts = (await page.evaluate(`[...document.querySelectorAll('[data-testid=draft]')].map((d) => ({
    frame: Number(d.dataset.frame), ring: !!d.querySelector('.draft-mark'), range: (d.textContent || '').includes('→'),
  }))`)) as { frame: number; ring: boolean; range: boolean }[];
  const ringed = Math.max(
    0,
    drafts.findIndex((d) => d.ring && !d.range),
  );
  await goto(demo.film, 2, drafts[ringed].frame);
  await page.hover(`[data-testid=draft]:nth-of-type(${ringed + 1})`);
  await sleep(1200);
  await camera.shoot(page, 'recorded-feedback', { full: true }, { ready: () => videoReady() });
  for (const r of (await call<{ recordings: { id: string }[] }>('GET', `/api/review/${enc(demo.film)}/recordings`)).recordings)
    await call('DELETE', `/api/review/${enc(demo.film)}/recordings/${r.id}`);

  // ================================================================ the review card an MCP host shows
  console.log('the MCP review card…');
  await mcpCard(s, camera);

  // ================================================================ settings: connect an agent, voice notes
  console.log('settings…');
  {
    // Claude Code connects over HTTP the way `claude mcp add --transport http` sets it up: it names itself in initialize
    const claude = new Client({ name: 'claude-code', version: '2.1.0' }, { versionNegotiation: { mode: 'auto' } });
    await claude.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
    await claude.listTools();
    await open('#/settings/mcp');
    await until("document.querySelector('[data-testid=agent-state]')?.textContent.includes('Connected')");
    await sleep(500);
    await camera.shoot(page, 'settings-connect-agent', { around: ['.set-head', '.set-card:has([data-testid=agent-state])'], pad: [24, 24, 8, 24] });
    await claude.close();
  }
  await call('PATCH', '/api/auth/me', { prefs: { voice_languages: ['en', 'de'] } });
  await open('#/settings/speech');
  await page.waitForSelector('[data-testid=speech-facts]');
  await page.waitForSelector('[data-testid=voice-languages]');
  await sleep(500);
  await camera.shoot(page, 'voice-notes-settings', { around: ['.set-head', '[data-testid=speech-details]'], pad: [24, 24, 20, 24] });

  // ================================================================ notifications on this computer
  console.log('notifications…');
  await notifications(s, call, BASE);

  // ================================================================ the playbook: the House's, and a project's own
  console.log('a playbook…');
  await writePlaybooks(call, demo, s.work);
  await open(`#/playbook/${enc('Northwind')}`);
  await page.waitForSelector('.pb-page, [data-testid=playbook]', { timeout: 20_000 }).catch(() => {});
  await sleep(2500);
  await camera.shoot(page, 'playbook-folder', { full: true });

  // ================================================================ B. an agent at work
  console.log('an agent at work…');
  // A new episode arrives to be reviewed.
  const episode = renderEpisode(media.root);
  const ep = (await call<{ video: { slug: string } }>('POST', '/api/library', { path: episode, folder: 'Studio/Field Notes', session: null })).video.slug;
  // On the teaser, a note with a box and an arrow: its clean and marked screenshots are the data format's picture.
  const subtitle = await call<Comment>('POST', `/api/review/${enc(demo.teaser)}/comments`, {
    frame: 75,
    text: 'Move the subtitle up under the title, about here.',
    tags: ['layout/overlap'],
    severity: 'should',
    drawing: [
      { type: 'box', x: 690, y: 640, w: 540, h: 70 },
      { type: 'arrow', x1: 1300, y1: 690, x2: 1150, y2: 610 },
    ],
  });
  cleanAndMarked(s, camera, demo.teaser, subtitle);
  // The person checked the three fixes in V2.
  for (const id of [titleNote, lineNote, typo]) await call('PATCH', `/api/comments/${id}`, { status: 'verified' });
  // The film's agent reads the notes, fixes the glow and the end card in its project and shows them from what the project
  // renders now (the coming V3): a still of the glow, and the end card from its first frame to V2's last (a preview
  // covers frames of the version it fixes). Then it asks one thing, and waits.
  const still = path.join(s.work, 'glow-fix.png');
  execFileSync(FFMPEG, ['-v', 'error', '-i', media.prepareFilmV3(), '-vf', 'select=eq(n\\,168)', '-frames:v', '1', '-y', still]);
  const clip = path.join(s.work, 'end-card-fix.mp4');
  execFileSync(FFMPEG, [
    '-v',
    'error',
    '-i',
    media.prepareFilmV3(),
    '-vf',
    'trim=start_frame=264:end_frame=384,setpts=PTS-STARTPTS',
    '-an',
    '-c:v',
    'libx264',
    '-crf',
    '16',
    '-pix_fmt',
    'yuv420p',
    '-y',
    clip,
  ]);
  vr('launch-edit', 'open', 'northwind-launch.mp4');
  vr('launch-edit', 'show', glow);
  vr(
    'launch-edit',
    'preview',
    glow,
    still,
    '--frame',
    '168',
    '--fixed',
    '--note',
    'Pulled the glow back by a third, so the line stays the hero. In the project for now: V3 renders it.',
    '--app',
    'After Effects',
    '--project',
    'northwind-launch.aep',
    '--comp',
    'Main',
    '--time',
    '7.0',
  );
  vr(
    'launch-edit',
    'preview',
    endCard,
    clip,
    '--clip',
    '--frame',
    '264',
    '--fixed',
    '--note',
    'The end card holds one more second before the cut to black. In the project for now: V3 renders it.',
    '--app',
    'After Effects',
    '--project',
    'northwind-launch.aep',
    '--comp',
    'Main',
    '--time',
    '11.0',
  );
  vr(
    'launch-edit',
    'add',
    'northwind-launch.mp4',
    '--frame',
    '240',
    '--text',
    'Should “Every mile, on the record.” stay on screen until the end card comes in?',
    '--choice',
    'Yes',
    '--choice',
    'No, cut it',
  );
  // then it waits for the answer (a second later, so the wait is what it is doing now)
  await sleep(1200);
  vrWatch('launch-edit');
  const question = (await noteBy(demo.film, 'stay on screen until the end card')).id;
  // A client watched the social cut through its review link: Mia most of it, Jonas the start.
  const mia = { ip: '203.0.113.24', visitor: 'mia-k2Hc81QwPzLx', name: 'Mia' };
  const jonas = { ip: '198.51.100.7', visitor: 'jonas-Vb7Rr0tYq2Mn', name: 'Jonas' };
  await watchLink(guest, demo.shareToken, mia, 85, 1.4);
  await watchLink(guest, demo.shareToken, jonas, 40, 1);
  // The cut-down shipped: approved and final.
  await call('PUT', `/api/review/${enc(demo.cutdown)}/approval`, { status: 'approved', note: 'Good to go.' });
  await call('PUT', `/api/review/${enc(demo.cutdown)}/final`, {});
  await settle(`/api/analysis/${enc(ep)}/1`);
  await settle(`/api/qa/${enc(ep)}/1`);

  // The teaser's agent says what it is rendering (its card shows it while it works).
  vr('teaser-edit', 'open', 'field-notes-teaser.mp4');
  vr('teaser-edit', 'status', 'field-notes-teaser.mp4', 'Rendering V2 with a short dissolve', '--eta', '300');
  await open('#/status');
  await until("document.querySelectorAll('.bcard').length >= 5");
  await imagesLoaded('.bcard img');
  await until("[...document.querySelectorAll('[data-testid=bcard-agent]')].some((e) => e.textContent.includes('·'))", 20_000).catch(() => {});
  await sleep(1200);
  await rest();
  await camera.shoot(page, 'board', { full: true }, { ready: () => imagesLoaded('.bcard img') });

  // the inbox, by video: a fix to check picked
  await open('#/inbox');
  await page.waitForSelector('[data-testid=inbox-view].split', { timeout: 20_000 });
  await page.waitForSelector('[data-testid=inbox-row-verify]');
  // this headless browser can't do notifications; the inbox says so once, and "Not now" puts that away on the device
  const notify = await page.waitForSelector('[data-testid=notify-later]', { timeout: 4000 }).catch(() => null);
  if (notify) {
    await notify.click();
    await page.waitForSelector('[data-testid=notify-card]', { hidden: true });
  }
  await clickRow(page, 'inbox-row-verify', 'glow');
  await videoReady(page, '[data-testid=inbox-video]');
  await sleep(1200);
  await rest();
  await camera.shoot(page, 'inbox', { full: true }, { ready: () => videoReady(page, '[data-testid=inbox-video]') });

  // the agent's question, picked
  await clickRow(page, 'inbox-row-question', 'stay on screen');
  await page.waitForSelector('[data-testid=choices]');
  await videoReady(page, '[data-testid=inbox-video]');
  await sleep(1200);
  await rest();
  await camera.shoot(page, 'inbox-agent-question', { full: true }, { ready: () => videoReady(page, '[data-testid=inbox-video]') });

  // the agent's menu while it works: what it is doing now, and what it did
  await open(`#/v/${enc(demo.film)}`);
  await videoReady();
  await page.waitForSelector('[data-testid=agent-button]');
  await sleep(800);
  await page.click('[data-testid=agent-button]');
  await page.waitForSelector('[data-testid=agent-live]', { timeout: 15_000 });
  await sleep(800);
  await camera.shoot(page, 'agent-menu-live', { around: ['[data-testid=agent-menu]'], pad: [0, 8, 12, 8], fromTop: true });
  await page.keyboard.press('Escape');

  // check mode on the glow: the fix exists as a still from the project so far
  await open(`#/v/${enc(demo.film)}?verify=${glow}`);
  await page.waitForSelector('.verify', { timeout: 15_000 });
  await videoReady();
  await sleep(1800);
  await rest();
  await camera.shoot(page, 'fix-preview-check', { full: true }, { ready: () => videoReady() });

  // ================================================================ C. V3, approved
  console.log('V3…');
  // both fixes looked right on their previews; the question answered
  for (const id of [glow, endCard]) {
    const preview = (await review(demo.film)).comments.find((c) => c.id === id)?.previews?.at(-1)?.id;
    await call('PATCH', `/api/comments/${id}`, { status: 'verified', ...(preview ? { preview } : {}) });
  }
  await call('PATCH', `/api/comments/${question}`, { status: 'verified', note: 'Yes' });
  for (const p of vrWatching.splice(0)) p.kill();
  media.renderFilmV3();
  const settled = new Date(Date.now() - 60_000);
  fs.utimesSync(media.film, settled, settled);
  vr('launch-edit', 'sync', 'northwind-launch.mp4');
  await waitFor('V3 registered', async () => (await review(demo.film)).versions.length === 3);
  await settle(`/api/diff/${enc(demo.film)}/3`);
  await settle(`/api/analysis/${enc(demo.film)}/3`);
  await settle(`/api/qa/${enc(demo.film)}/3`);
  // the next render is compared with the still in the background: confirmed (or, if it differs, back to "check fixes")
  await waitFor(
    'the preview compared',
    async () =>
      (await review(demo.film)).comments.filter((c) => c.id === glow || c.id === endCard).every((c) => c.previews?.some((p) => p.confirmed || p.mismatch)),
    90_000,
  ).catch(() => console.log('  (the fix preview was not compared with V3 in time)'));
  for (const c of (await review(demo.film)).comments) if (c.status === 'fixed') await call('PATCH', `/api/comments/${c.id}`, { status: 'verified' });
  await call('PUT', `/api/review/${enc(demo.film)}/approval`, { status: 'approved', note: 'Lovely. Ready for the client.' });
  await open(`#/v/${enc(demo.film)}`);
  await videoReady();
  await page.waitForSelector('[data-testid=stage-next][data-kind=send]', { timeout: 20_000 });
  await sleep(800);
  await page.click('[data-testid=stage-more]');
  await page.waitForSelector('[role=menu]', { visible: true });
  await sleep(600);
  await camera.shoot(page, 'player-next-step', {
    around: ['[data-testid=share-button]', '[data-testid=inbox-bell]', '[role=menu]'],
    pad: [0, 16, 20, 12],
    fromTop: true,
  });
  await page.keyboard.press('Escape');

  // ================================================================ D. review links: what came of one, and a room
  console.log('review links…');
  // Mia approves the social cut through her link.
  {
    const g = guest(mia);
    const link = await g.get<{ videos: { slug: string; v: number }[] }>(`/api/g/${demo.shareToken}`);
    await g.post(`/api/g/${demo.shareToken}/approval`, { name: mia.name, v: link.videos[0].v, status: 'approved', note: 'Lovely, approved from our side.' });
  }
  // the dialog in a window tall enough for all of it
  await page.setViewport({ width: 1440, height: 1240, deviceScaleFactor: 2 });
  await open(`#/v/${enc(demo.social)}`);
  await videoReady();
  await page.click('[data-testid=share-button]');
  await page.waitForSelector('[data-testid=link-name]');
  await page.waitForSelector('.link-row');
  await sleep(900);
  await camera.shoot(page, 'share-dialog', { around: ['[role=dialog]'], pad: 0 });
  await page.click('[data-testid=link-sum]');
  await page.waitForSelector('[data-testid=link-activity] [data-testid=link-watch]', { timeout: 15_000 });
  await sleep(900);
  await camera.shoot(page, 'link-activity', { around: ['[role=dialog]'], pad: 0 });
  await page.keyboard.press('Escape');
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

  // a link to the whole project, with downloads: Mia opens it
  const room = await call<{ token: string }>('POST', '/api/folder-shares', {
    folder: 'Northwind',
    label: 'Northwind launch',
    comment: true,
    approve: true,
    download: 'original',
  });
  await reviewRoom(s, room.token, BASE);

  if (errors.length) console.log(`  (page errors: ${errors.join(' | ')})`);
  await page.close();
}

// ---------------------------------------------------------------------------------------------------------------- parts

/** The inbox list's row of a kind whose words include `text`, clicked. */
async function clickRow(page: Page, testid: string, text: string) {
  const ok = await page.evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-testid=${testid}]')].find((e) => (e.textContent || '').includes(${JSON.stringify(text)}));
    if (row) row.click();
    return !!row;
  })()`);
  if (!ok) throw new Error(`no ${testid} row with "${text}"`);
}

/** A client of the link watches its video: opens the link and the video, then reports the parts played up to `pct`. */
async function watchLink(
  guest: (who: { ip: string; visitor: string; name: string }) => { get: <T>(p: string) => Promise<T>; post: <T>(p: string, b: Json) => Promise<T> },
  token: string,
  who: { ip: string; visitor: string; name: string },
  pct: number,
  again: number,
) {
  const g = guest(who);
  await g.post(`/api/g/${token}/visit`, { name: who.name, visitor: who.visitor });
  const link = await g.get<{ videos: { slug: string; v: number; duration: number }[] }>(`/api/g/${token}`);
  const video = link.videos[0];
  await g.get(`/api/g/${token}/review/${enc(video.slug)}`);
  const parts = Array.from({ length: Math.round((pct / 100) * PARTS) }, (_, i) => i);
  // the opening line again: the first fifth played twice as often
  const plays = Array.from({ length: PARTS }, (_, i) => (i < parts.length ? (i < 20 ? Math.round(1 + again) : 1) : 0));
  await g.post(`/api/g/${token}/progress`, {
    visitor: who.visitor,
    slug: video.slug,
    v: video.v,
    seen: encodeParts(parts),
    plays,
    secs: Math.round(((pct / 100) * video.duration + 0.2 * video.duration * again) * 10) / 10,
    name: who.name,
  });
}

/** Field Notes, part one: a new episode to review (synthetic, like the rest of the demo). */
function renderEpisode(root: string): string {
  return render({
    file: path.join(root, 'Field Notes/episode-1/export/field-notes-01.mp4'),
    w: 1920,
    h: 1080,
    fps: 25,
    dur: 7,
    gradient: 'c0=0x13261f:c1=0x3d7a63:c2=0xe0c98e:c3=0x13261f:n=4:type=spiral:speed=0.05:seed=8',
    audio: score(120, 220),
    captions: [
      { text: 'Field Notes', from: 0.3, to: 3.4, size: 120, y: '(h-text_h)/2-30' },
      { text: 'P A R T   O N E', from: 0.8, to: 3.4, size: 30, y: '(h/2)+90', font: 'sans' },
      { text: 'The coast road', from: 3.8, to: 7, size: 104, y: '(h-text_h)/2' },
    ],
  });
}

/** One note's clean and marked screenshots side by side (what the store writes for agents), transparent between them. */
function cleanAndMarked(s: LocalScene, camera: Camera, slug: string, c: Comment) {
  if (!camera.wants('clean-and-marked')) return;
  const dir = path.join(s.dir, 'data', slug);
  const clean = path.join(dir, c.shots?.clean ?? '');
  const marked = path.join(dir, c.shots?.marked ?? '');
  if (!fs.existsSync(clean) || !fs.existsSync(marked)) throw new Error(`no screenshots for ${c.id}: ${JSON.stringify(c.shots)}`);
  const png = path.join(s.work, 'clean-and-marked.png');
  execFileSync(FFMPEG, [
    '-v',
    'error',
    '-i',
    clean,
    '-i',
    marked,
    '-filter_complex',
    '[0:v]format=rgba,pad=iw+48:ih:0:0:color=black@0[a];[a][1:v]hstack=inputs=2,format=rgba',
    '-frames:v',
    '1',
    '-y',
    png,
  ]);
  camera.save(png, 'clean-and-marked');
}

/** House r1–r3 (brief, rules, the brief again) and Northwind's own rules and references. */
async function writePlaybooks(call: <T = Json>(m: string, p: string, b?: unknown) => Promise<T>, demo: DemoStore, work: string) {
  await call('PUT', '/api/playbook/text', {
    section: 'brief',
    content: 'We make short brand films and their social cut-downs. Clients see a version only after the team approved it.',
    message: 'The studio in two sentences',
  });
  await call('PUT', '/api/playbook/text', {
    section: 'rules',
    content: [
      '- Titles hold at least one second before the first cut.',
      '- Burned-in text stays inside title safe; captions on social stay above the platform’s buttons.',
      '- Loudness: −14 LUFS integrated, true peak −1 dBTP for social; −23 LUFS for broadcast.',
      '- Every version is rendered from the project, never re-encoded from an earlier render.',
    ].join('\n'),
    message: 'House rules',
  });
  await call('PUT', '/api/playbook/text', {
    section: 'brief',
    content:
      'We make short brand films and their social cut-downs for clients who sign off on every version. A client sees a version only after the team approved it, and nothing ships without a final.',
    message: 'Say who signs off',
  });
  await call('PUT', '/api/playbook/text', {
    folder: 'Northwind',
    section: 'rules',
    content: [
      '- The wordmark is spaced: N O R T H W I N D, always in capitals.',
      '- Warm light, never a glow over the lines: the line is the hero.',
      '- The claim is “Every mile, on the record.” — word for word.',
      '- End cards hold two seconds before the cut to black.',
    ].join('\n'),
    message: 'Northwind’s rules',
  });
  const ref = (b: Json) => call('POST', '/api/playbook/refs', { folder: 'Northwind', ...b });
  await ref({ kind: 'frame', video: demo.film, v: 2, frame: 72, caption: 'The title card, as approved' });
  await ref({ kind: 'frame', video: demo.film, v: 2, frame: 300, caption: 'The end card' });
  await ref({ kind: 'frame', video: demo.social, v: 1, frame: 150, caption: 'Caption height on Reels' });
  // the brand's colours, as an image a person would drop in
  const swatch = path.join(work, 'northwind-colours.png');
  execFileSync(FFMPEG, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=0x0b1626:s=320x360,format=rgb24',
    '-f',
    'lavfi',
    '-i',
    'color=c=0x1d3a57:s=320x360,format=rgb24',
    '-f',
    'lavfi',
    '-i',
    'color=c=0xb86f48:s=320x360,format=rgb24',
    '-f',
    'lavfi',
    '-i',
    'color=c=0xeeebe4:s=320x360,format=rgb24',
    '-filter_complex',
    '[0][1][2][3]hstack=inputs=4',
    '-frames:v',
    '1',
    '-y',
    swatch,
  ]);
  await ref({ kind: 'image', data: fs.readFileSync(swatch).toString('base64'), caption: 'Northwind colours' });
  await ref({ kind: 'link', url: 'https://northwind.example/brand', caption: 'Brand guidelines' });
}

/** Settings → Notifications with notifications on for this computer. A headless browser has no push service: the
 * device's permission and subscription are stand-ins (as in the inbox suite); the subscription is registered with the
 * server through its API, the way the app's own "Turn on" does. */
async function notifications(s: LocalScene, call: <T = Json>(m: string, p: string, b?: unknown) => Promise<T>, base: string) {
  if (!s.camera.wants('notifications-settings')) return;
  const EP = 'https://fcm.googleapis.com/fcm/send/docs-picture-device';
  const KEYS = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
  await call('POST', '/api/push/subscribe', {
    subscription: { endpoint: EP, keys: KEYS },
    name: 'Mac',
    prefs: { questions: true, fixes: true, clients: true, answers: true, versions: false },
  });
  const ctx = await s.browser.createBrowserContext();
  const page = await ctx.newPage();
  await desktop(page, 1000);
  await page.evaluateOnNewDocument(`(() => {
    if (typeof ServiceWorkerContainer === 'undefined' || typeof Notification === 'undefined') return;
    Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
    const sub = { endpoint: ${JSON.stringify(EP)}, toJSON: () => ({ endpoint: ${JSON.stringify(EP)}, keys: {} }), unsubscribe: async () => true };
    ServiceWorkerContainer.prototype.getRegistration = function () { return Promise.resolve({ pushManager: { getSubscription: async () => sub } }); };
  })()`);
  await page.goto(`${base}/#/settings/notifications`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="push-settings"][data-state="on"]:not([aria-busy])', { timeout: 20_000 });
  await page.mouse.move(2, 2);
  await sleep(1200);
  // the page's head and this device's card: what pings it, Send a test, Turn off here
  await s.camera.shoot(page, 'notifications-settings', { around: ['.set-head', '.set-card:has([data-testid=push-settings])'], pad: [24, 24, 10, 24] });
  await ctx.close();
}

/** A client opens the folder link in a browser of their own: the room, cropped to its head and its videos. */
async function reviewRoom(s: LocalScene, token: string, base: string) {
  if (!s.camera.wants('review-room')) return;
  const ctx = await s.browser.createBrowserContext();
  const page = await ctx.newPage();
  await desktop(page, 900);
  await page.goto(`${base}/g/${token}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.room .film', { timeout: 20_000 });
  // she opens the reel she approved, says who she is (the link asks once), and goes back to the room
  await page.evaluate(
    `[...document.querySelectorAll('.room .film')].find((f) => f.textContent.includes('northwind-reel'))?.querySelector('.film-title, a, button')?.click()`,
  );
  const asked = await page.waitForSelector('input[placeholder="Your name"]', { timeout: 20_000 }).catch(() => null);
  if (asked) {
    await asked.type('Mia');
    await page.keyboard.press('Enter');
    await page.waitForSelector('input[placeholder="Your name"]', { hidden: true, timeout: 10_000 });
  }
  await page.goto(`${base}/g/${token}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.room .film', { timeout: 20_000 });
  await page.waitForFunction("[...document.querySelectorAll('.room .film img')].every((i) => i.complete && i.naturalWidth > 0)", { timeout: 20_000 });
  await page.waitForSelector('.g-download-size', { timeout: 20_000 }).catch(() => {});
  await page.mouse.move(2, 2);
  await sleep(1200);
  // the room's content: from under its bar to the last card, as wide as the cards (the head's blocks and the grid span
  // the whole window, most of it empty)
  const r = (await page.evaluate(`(() => {
    const rects = (sel) => [...document.querySelectorAll(sel)].map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height);
    const cards = rects('.room .film');
    const head = rects('.room-head > *');
    const bar = document.querySelector('.room-top')?.getBoundingClientRect();
    return {
      left: Math.min(...cards.map((r) => r.left), ...head.map((r) => r.left)),
      top: bar ? bar.bottom + 1 : 0,
      right: Math.max(...cards.map((r) => r.right)),
      bottom: Math.max(...cards.map((r) => r.bottom)),
    };
  })()`)) as { left: number; top: number; right: number; bottom: number };
  const x = Math.max(0, Math.floor(r.left - 40));
  const y = Math.ceil(r.top);
  await s.camera.shoot(page, 'review-room', { box: { x, y, width: Math.ceil(r.right + 40) - x, height: Math.ceil(r.bottom + 36) - y } });
  await ctx.close();
}

/** A browser window of the size the other pictures have, in its own context (a visitor, or another device). */
async function desktop(page: Page, height: number) {
  await page.emulateTimezone(DAY_ZONE);
  await page.setViewport({ width: 1440, height, deviceScaleFactor: 2 });
  await scheme(page, 'dark');
  await tipsSeen(page);
}

/** The review card (`show_review`) in a minimal MCP Apps host, the one the browser suite uses (test/e2e/mcp-host). */
async function mcpCard(s: LocalScene, camera: Camera) {
  if (!camera.wants('mcp-review-card')) return;
  const out = path.join(s.work, 'mcp-host');
  await build({
    configFile: false,
    logLevel: 'silent',
    build: { outDir: out, emptyOutDir: true, minify: false, lib: { entry: path.join(ROOT, 'test/e2e/mcp-host/host.ts'), formats: ['es'], fileName: 'host' } },
  });
  const hostJs = fs.readFileSync(path.join(out, fs.readdirSync(out).find((f) => f.endsWith('.js')) as string), 'utf8');
  const client = new Client({ name: 'Claude', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${s.server.url}/mcp`)));
  try {
    const args = { video: 'northwind-launch.mp4' };
    const result = await client.callTool({ name: 'show_review', arguments: args });
    const html = ((await client.readResource({ uri: 'ui://video-review/review.html' })).contents[0] as { text: string }).text;
    const page = await s.browser.newPage();
    await page.setViewport({ width: 900, height: 1250, deviceScaleFactor: 2 });
    await page.emulateTimezone(DAY_ZONE);
    await page.exposeFunction('hostCall', async (name: string, a: Record<string, unknown>) => client.callTool({ name, arguments: a }));
    await page.setContent('<!doctype html><html><body style="margin:0;background:#0b0b0c"></body></html>');
    await page.addScriptTag({ content: hostJs, type: 'module' });
    await page.waitForFunction('typeof window.startHost === "function"');
    await page.evaluate(`window.startHost(${JSON.stringify(html)}, ${JSON.stringify(args)}, ${JSON.stringify(result)})`);
    const frameEl = await page.waitForSelector('iframe');
    const card = await frameEl?.contentFrame();
    if (!card) throw new Error('no card');
    await card.waitForFunction("document.querySelector('.frame img')?.naturalWidth > 0", { timeout: 20_000 });
    // an open note with a drawing, opened: its marked frame, its reply box and "Mark fixed"
    await card.evaluate(`[...document.querySelectorAll('.note')].find((n) => n.textContent.includes('glow'))?.querySelector('.note-head')?.click()`);
    await card.waitForSelector('.note-body textarea');
    await card.waitForFunction(`document.querySelector('figcaption')?.textContent.includes('f168')`, { timeout: 10_000 }).catch(() => {});
    await card.waitForFunction("document.querySelector('.frame img')?.complete", { timeout: 10_000 });
    await sleep(800);
    const height = (await card.evaluate(
      'Math.ceil(Math.max(...[...document.body.querySelectorAll("*")].map((e) => e.getBoundingClientRect().bottom)))',
    )) as number;
    const box = { x: 0, y: 0, width: 880, height: Math.min(1200, height + 16) };
    for (const theme of ['dark', 'light'] as const) {
      await page.evaluate(
        `(() => { window.hostTheme(${JSON.stringify(theme)}); document.body.style.background = ${JSON.stringify(theme === 'dark' ? '#0b0b0c' : '#f2efe7')}; })()`,
      );
      await card.waitForFunction(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`, { timeout: 5000 });
      await sleep(500);
      await noPrivate(page, 'mcp-review-card');
      const png = path.join(camera.work, `mcp-review-card-${theme}.png`);
      await page.screenshot({ path: png as `${string}.png`, clip: box, captureBeyondViewport: false });
      camera.save(png, theme === 'dark' ? 'mcp-review-card' : 'mcp-review-card-light');
    }
    await page.close();
  } finally {
    await client.close().catch(() => {});
  }
}
