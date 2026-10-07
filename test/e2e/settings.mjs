#!/usr/bin/env node
// covers: web/src/settings/ web/src/styles/settings.css server/routes/system.ts server/routes/voice.ts
// covers: server/routes/webhooks.ts lib/mcpConfig.ts lib/webhooks.ts
// Browser end-to-end test of Settings on the machine the app runs on (its owner signed in automatically): a real
// server (local mode, temp store, free port) + headless Chrome. The sidebar and ⌘K lead there; the sections are the
// hosted ones (Profile first: set a first password here to sign in elsewhere); Appearance holds the theme and language;
// Voice notes says whether they are written down, keeps the languages you speak on your account and folds the engine away; Auto-check lists what it looks at and the
// store's dictionary file; Connect an agent is one page per agent (pick it, copy its snippet, tell it the one sentence,
// see it work); About has the version, the store's folders and the notices. English in a German browser until German is chosen,
// then German labels; every section fits at phone, tablet and desktop.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { age, FFMPEG, makeVideo, ROOT } from '../lib/helpers.ts';
import { bentEdges, clippedText, cutLabels, dataTheme, layoutMatrix, settle, sideways } from './layout.mjs';
import { launch, requireChrome, requireDist, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'settings e2e';
requireChrome(LABEL);
requireDist(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({
  prefix: 'vr-settings-e2e-',
  user: 'Sam',
  // A media host is a hosted server's: set here, the machine ignores it (Connect an agent names none).
  env: { VR_STT: 'http', VR_STT_URL: 'http://127.0.0.1:9/v1', VR_STT_LANGUAGES: 'de,en', VR_MEDIA_ORIGIN: 'https://media.example.com' },
});
const { base: BASE, dir } = srv;
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

let browser;
let german;
try {
  // One video, so the library shows its sidebar (an empty store shows only the first-run reel).
  const file = makeVideo(path.join(dir, 'Acme/export/spot.mp4'), { w: 320, h: 180, dur: 1 });
  age(file);
  const added = await fetch(`${BASE}/api/library`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: file }) });
  assert(added.ok, `adding a video: ${added.status}`);
  browser = await launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `settings-${name}.png`) });
  const open = async (hash, ready) => {
    await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(ready);
  };
  const text = (sel) => page.$eval(sel, (e) => e.textContent);
  const navLabels = () => page.$$eval('.set-nav > a', (as) => as.map((a) => a.textContent.trim()));
  const SECTIONS = [
    'Profile',
    'Appearance',
    'Connect an agent',
    'Connected agents',
    'API tokens',
    'Review links',
    'Publishing',
    'Users',
    'Notifications',
    'Playbook',
    'Voice notes',
    'Auto-check',
    'About',
  ];

  await check("the sidebar leads to Settings: the hosted sections, opening on the profile of the machine's owner", async () => {
    await open('#/', '[data-testid="settings-link"]');
    await page.click('[data-testid="settings-link"]');
    await page.waitForSelector('.set-nav');
    assert((await page.evaluate(() => location.hash)) === '#/settings', `hash ${await page.evaluate(() => location.hash)}`);
    assert(JSON.stringify(await navLabels()) === JSON.stringify(SECTIONS), `sections ${await navLabels()}`);
    assert((await text('.set-head h1')) === 'Profile', 'Profile first');
    assert((await text('.set-head p')).includes('Signed in at this machine as'), await text('.set-head p'));
    // No password yet: the first one needs no current one, and says what it is for.
    assert(!(await page.$('input[autocomplete="current-password"]')), 'no current-password field before there is a password');
    assert((await page.evaluate(() => document.body.textContent)).includes('to sign in from your phone or another computer'), 'what a password is for');
    assert(await page.$('.set-server'), 'the facts about this instance');
    await shot('01-profile');
  });

  await check('Appearance: the theme and the language (and only there: Profile has neither)', async () => {
    await open('#/settings/appearance', '.set-theme');
    assert(await page.$('.set-theme [role=radiogroup], .set-theme button'), 'the theme switch');
    assert(await page.$('.set-lang [role=radiogroup], .set-lang button'), 'the language switch');
    await open('#/settings', '.set-head h1');
    assert(!(await page.$('.set-theme, .set-lang')), 'no theme or language on Profile');
    assert((await text('.topbar .p-title')).trim() === 'Settings', `the title says only where you are: ${await text('.topbar .p-title')}`);
  });

  await check('the account menu leads with Settings, ⌘, opens it from anywhere, and the sidebar has no theme switch', async () => {
    await open('#/', '.user-chip:enabled');
    assert(!(await page.$('.nav .theme-switch')), 'no theme switch in the sidebar');
    await page.click('.user-chip');
    await page.waitForSelector('.menu[data-state=open] [role=menuitem]');
    const items = await page.$$eval('.menu[data-state=open] [role=menuitem]', (els) => els.map((e) => e.textContent.trim()));
    assert(items[0].startsWith('Settings'), `first item: ${items[0]}`);
    assert(await page.$('.menu[data-state=open] .menu-theme'), 'the quick theme row');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.menu[data-state=open]'), { timeout: 5000 });
    await page.keyboard.down('Meta');
    await page.keyboard.press(',');
    await page.keyboard.up('Meta');
    await page.waitForFunction(() => location.hash === '#/settings', { timeout: 5000 });
  });

  await check('Profile: a picture, cut to a square, shows in the account chip and can be removed again', async () => {
    const png = path.join(dir, 'me.png');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=orange:s=400x200', '-frames:v', '1', '-y', png]);
    await open('#/settings', '[data-testid="profile-picture"]');
    assert(!(await page.$('[data-testid="profile-picture"] img')), 'initials before a picture');
    await (await page.$('[data-testid="picture-input"]')).uploadFile(png);
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[data-testid="profile-picture"] img, .user-chip img')].filter((i) => i.complete && i.naturalWidth === 256).length === 2,
      { polling: 100, timeout: 15000 },
    );
    await shot('01b-picture');
    await page.evaluate(() => [...document.querySelectorAll('[data-testid="profile-picture"] button')].find((b) => b.textContent.trim() === 'Remove').click());
    await page.waitForFunction(() => !document.querySelector('[data-testid="profile-picture"] img, .user-chip img'), { polling: 100, timeout: 5000 });
  });

  await check('a section opens by its address: API tokens work on the machine too', async () => {
    await open('#/settings/tokens', '.set-head h1');
    assert((await text('.set-head h1')) === 'API tokens', `opened ${await text('.set-head h1')}`);
  });

  await check(
    'a fresh token: copy it, then connect an agent by its mark; the setup holds the token and the key lampo, never broken inside the token',
    async () => {
      const make = async (p, name) => {
        await p.goto(`${BASE}/#/settings/tokens`, { waitUntil: 'domcontentloaded' });
        await p.waitForSelector('.set-inline input');
        await p.type('.set-inline input', name);
        await p.click('.set-inline .btn.primary');
        await p.waitForSelector('[data-testid="token-fresh"] [data-testid="token-snippet"] pre', { timeout: 10000 });
        return p.$eval('[data-testid="token-value"] pre', (e) => e.textContent);
      };
      const snippetOf = (p) => p.$eval('[data-testid="token-snippet"] pre', (e) => e.textContent);
      const token = await make(page, 'Studio Mac · Claude Code');
      assert(/^vr_\S{20,}$/.test(token), `token ${token}`);
      // Two steps, in order: the token, then the agent.
      const steps = await page.$$eval('[data-testid="token-fresh"] .set-fresh-step > h3', (hs) => hs.map((h) => h.textContent));
      assert(JSON.stringify(steps) === JSON.stringify(['1Copy your token', '2Connect your agent']), `steps ${steps}`);
      // The agents that take a token, each wearing its mark; Claude Code first: its command, with the token filled in.
      const tiles = await page.$$eval('[data-testid="token-fresh"] .set-tile', (ts) =>
        ts.map((t) => [t.querySelector('b').textContent, !!t.querySelector('.agent-mark')]),
      );
      assert(
        JSON.stringify(tiles) ===
          JSON.stringify([
            ['Claude Code', true],
            ['Codex', true],
            ['Cursor', true],
            ['Other client', true],
          ]),
        `tiles ${JSON.stringify(tiles)}`,
      );
      assert((await snippetOf(page)) === `claude mcp add --transport http lampo ${BASE}/mcp --header "Authorization: Bearer ${token}"`, await snippetOf(page));
      assert(
        (await page.$eval('[data-testid="token-login"] pre', (e) => e.textContent)) === `lampo login ${BASE} --token -`,
        'lampo takes the token at its prompt',
      );
      // One Copy per block.
      for (const id of ['token-value', 'token-snippet', 'token-login'])
        assert((await page.$$(`[data-testid="${id}"] .set-copy`)).length === 1, `${id}: one Copy`);
      // Every other client: its own format, keyed lampo, with the token.
      const pickTile = (id) => page.click(`[data-testid="token-fresh"] [data-testid="agent-tiles"] input[value="${id}"]`);
      await pickTile('codex');
      await page.waitForFunction(() => document.querySelector('[data-testid="token-snippet"] pre')?.textContent.startsWith('[mcp_servers.lampo]'), {
        polling: 100,
        timeout: 5000,
      });
      assert((await snippetOf(page)).includes(`http_headers = { "Authorization" = "Bearer ${token}" }`), await snippetOf(page));
      await pickTile('cursor');
      await page.waitForFunction(() => document.querySelector('[data-testid="token-snippet"] pre')?.textContent.includes('"mcpServers"'), {
        polling: 100,
        timeout: 5000,
      });
      assert(JSON.parse(await snippetOf(page)).mcpServers.lampo.headers.Authorization === `Bearer ${token}`, await snippetOf(page));
      await pickTile('other');
      await page.waitForSelector('[data-testid="token-fresh"] [data-testid="agent-others"]');
      const chips = await page.$$eval('[data-testid="token-fresh"] .set-chip', (cs) => cs.map((c) => [c.textContent, !!c.querySelector('.agent-mark')]));
      assert(chips.length === 6 && chips.every(([, mark]) => mark), `the other clients, each with its mark: ${JSON.stringify(chips)}`);
      for (const [client, root] of [
        ['vscode', 'servers'],
        ['antigravity', 'mcpServers'],
        ['windsurf', 'mcpServers'],
        ['gemini', 'mcpServers'],
        ['zed', 'context_servers'],
        ['json', 'mcpServers'],
      ]) {
        await page.click(`[data-testid="token-fresh"] [data-testid="agent-others"] input[value="${client}"]`);
        await page.waitForFunction(
          (r) => document.querySelector('[data-testid="token-snippet"] pre')?.textContent.includes(`"${r}"`),
          { polling: 100, timeout: 5000 },
          root,
        );
        const text = await snippetOf(page);
        assert(JSON.parse(text)[root].lampo && text.includes(`Bearer ${token}`), `${client}: ${text}`);
      }
      await shot('02-token-fresh');
      // Phone to wide desktop: nothing sticks out, the token stands on one line in its block and in the command (a line
      // breaks before --header, never inside the token). A token is base64url, and the browser may break a line after a
      // `-`: these tokens are the worst a real one can be, its length with a `-` every few characters, so the check
      // doesn't depend on the luck of the draw.
      const WORST = `vr_${'k-Q_'.repeat(8)}`;
      assert(WORST.length === token.length, `a real token's length: ${token.length}`);
      const worstToken = async (p) => {
        await p.setRequestInterception(true);
        p.on('request', async (req) => {
          if (req.method() !== 'POST' || new URL(req.url()).pathname !== '/api/auth/tokens') return req.continue().catch(() => {});
          const res = await fetch(req.url(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: req.postData() });
          const made = await res.json();
          req.respond({ status: res.status, contentType: 'application/json', body: JSON.stringify({ ...made, token: WORST }) }).catch(() => {});
        });
      };
      const out = [];
      for (const vp of [
        { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
        { width: 768, height: 1024, deviceScaleFactor: 1 },
        { width: 1024, height: 768, deviceScaleFactor: 1 },
        { width: 1440, height: 900, deviceScaleFactor: 1 },
        { width: 1920, height: 1080, deviceScaleFactor: 1 },
      ])
        for (const theme of ['dark', 'light']) {
          const p = await browser.newPage();
          await p.setViewport(vp);
          await worstToken(p);
          const tok = await make(p, `fit ${vp.width} ${theme}`);
          if (tok !== WORST) out.push(`${theme} @${vp.width}: shows ${tok}, not the token it was given`);
          await p.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
          // Measured once the page holds still with its fonts in: in a fallback font the token can wrap for a moment.
          await settle(p);
          await p.evaluate(async (t) => {
            await document.fonts.ready;
            const pre = document.querySelector('[data-testid="token-snippet"] pre');
            for (const el of [pre, document.querySelector('[data-testid="token-value"] pre')])
              if (el) await document.fonts.load(`${getComputedStyle(el).fontSize} ${getComputedStyle(el).fontFamily}`, t);
          }, tok);
          await settle(p);
          const where = `${theme} @${vp.width}`;
          const bad = [...(vp.isMobile ? await sideways(p) : []), ...(await clippedText(p)), ...(await cutLabels(p)), ...(await bentEdges(p))];
          for (const b of bad) out.push(`${where}: ${b}`);
          const lines = await p.evaluate((t) => {
            const box = document.querySelector('[data-testid="token-value"] pre');
            const pre = document.querySelector('[data-testid="token-snippet"] pre');
            const span = pre.querySelector('.set-code-arg');
            // The text node that holds the whole token (none, if the token were cut into pieces).
            const walk =
              span &&
              document.createTreeWalker(span, NodeFilter.SHOW_TEXT, {
                acceptNode: (n) => (n.textContent.includes(t) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
              });
            const node = walk?.nextNode();
            const at = node?.textContent.indexOf(t) ?? -1;
            let inCommand = 0;
            if (at >= 0) {
              const r = document.createRange();
              r.setStart(node, at);
              r.setEnd(node, at + t.length);
              inCommand = new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size;
            }
            return {
              scrolls: box.scrollWidth > box.clientWidth + 1,
              inCommand,
              headerStartsLine: span ? span.getBoundingClientRect().left - pre.getBoundingClientRect().left < 20 : false,
            };
          }, tok);
          if (lines.scrolls) out.push(`${where}: the token doesn't fit its block`);
          if (lines.inCommand !== 1) out.push(`${where}: the token spans ${lines.inCommand} lines in the command`);
          if (vp.width < 1920 && !lines.headerStartsLine) out.push(`${where}: --header doesn't start its line`);
          await p.close();
        }
      assert(!out.length, out.join('\n'));
    },
  );

  await check('Voice notes: On, where it runs in one sentence, the languages you speak (yours), the engine folded away', async () => {
    await open('#/settings/speech', '[data-testid="voice-languages"]');
    assert((await text('.set-head h1')) === 'Voice notes', await text('.set-head h1'));
    const facts = await text('[data-testid="speech-facts"]');
    assert(facts.startsWith('On'), facts);
    const main = await page.$eval('.set-inner', (e) => e.innerText);
    assert(!/this machine/i.test(main), `no "this machine" where the server is meant: ${main}`);
    const chips = () => page.$$eval('[data-testid="voice-languages"] .set-lang-chip', (c) => c.map((e) => e.firstChild.textContent));
    const mine = async () => (await (await fetch(`${BASE}/api/auth/me`)).json()).user.prefs?.voice_languages;
    const until = (want) =>
      page
        .waitForFunction(
          (w) => JSON.stringify([...document.querySelectorAll('[data-testid="voice-languages"] .set-lang-chip')].map((e) => e.firstChild.textContent)) === w,
          { polling: 100, timeout: 5000 },
          JSON.stringify(want),
        )
        .catch(async () => assert(false, `languages ${await chips()}, wanted ${want}`));
    // The server's list (VR_STT_LANGUAGES=de,en) until you choose.
    assert(JSON.stringify(await chips()) === '["German","English"]', `${await chips()}`);
    assert(main.includes('The server’s choice until you change it.'), main);
    await page.click('[aria-label="Remove English"]');
    await until(['German']);
    assert(JSON.stringify(await mine()) === '["de"]', `saved on the account: ${await mine()}`);
    await page.click('[data-testid="voice-languages"] button[aria-label="Add a language"]');
    // The list is placed next to its field in a frame or two, and scrolls: pick the item once it stays put.
    const french = await page.waitForFunction(
      () => {
        const el = [...document.querySelectorAll('.select-item')].find((e) => e.textContent === 'French');
        el?.scrollIntoView({ block: 'nearest' });
        const box = el?.getBoundingClientRect();
        const key = box && `${box.x},${box.y}`;
        const settled = key && key === window.__lastBox;
        window.__lastBox = key;
        return settled ? el : null;
      },
      { polling: 50, timeout: 5000 },
    );
    const box = await french.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    await page.mouse.down();
    await page.mouse.up();
    await until(['German', 'French']);
    assert(JSON.stringify(await mine()) === '["de","fr"]', `${await mine()}`);
    await shot('02-voice');
    await page.evaluate(() => [...document.querySelectorAll('.set-inner button')].find((b) => b.textContent.startsWith('Use the server’s')).click());
    await until(['German', 'English']);
    assert((await mine()) === undefined, 'back to the server list');
    // Automatic: any language, as heard — the chips go, the choice is saved on the account as an empty list.
    const mode = (word) => page.evaluate((w) => [...document.querySelectorAll('.set-lang-mode button')].find((b) => b.textContent === w).click(), word);
    await mode('Automatic');
    await page
      .waitForFunction(() => !document.querySelector('[data-testid="voice-languages"]'), { polling: 100, timeout: 5000 })
      .catch(() => assert(false, 'the chips stay under Automatic'));
    assert(JSON.stringify(await mine()) === '[]', `Automatic saved: ${await mine()}`);
    assert((await page.$eval('.set-inner', (e) => e.innerText)).includes('Every note is heard in the language it is spoken in'), 'says what Automatic does');
    await shot('02b-voice-automatic');
    await mode('My languages');
    await until(['German', 'English']);
    assert((await mine()) === undefined, 'My languages again: the server list');
    // Engine, model and where to change them: folded, there for whoever wants them.
    assert(await page.$('[data-testid="speech-details"]:not([open])'), 'Details start folded');
    await page.click('[data-testid="speech-details"] summary');
    const details = await text('[data-testid="speech-details"]');
    assert(details.includes('An OpenAI-compatible endpoint'), details);
    const change = await page.$$eval('[data-testid="speech-details"] .set-code pre', (p) => p.map((e) => e.textContent).join('\n'));
    assert(change.includes('"stt"') && change.includes('LAMPO_STT_LANGUAGES'), change);
    await shot('02b-voice-details');
  });

  await check('Auto-check: every check it runs, and the dictionary file of this store', async () => {
    await open('#/settings/checks', '[data-testid="checks-list"]');
    const rows = await page.$$eval('[data-testid="checks-list"] .set-row b', (b) => b.map((e) => e.textContent));
    for (const want of ['Text in the picture', 'Safe zones', 'Flash frames', 'Black frames', 'Freezes', 'Loudness and clipping', 'Silence'])
      assert(rows.includes(want), `${want} in ${rows}`);
    const dictionary = await page.$$eval('.set-code pre', (p) => p.map((e) => e.textContent).find((x) => x.endsWith('qa-dictionary.txt')));
    assert(dictionary === path.join(dir, 'data', 'qa-dictionary.txt'), `dictionary ${dictionary}`);
  });

  await check('Connect an agent: pick the agent, copy its one snippet, tell it one sentence, see it work; no CLI recipe beside it', async () => {
    await open('#/settings/mcp', '[data-testid="agent-tiles"]');
    const tiles = await page.$$eval('[data-testid="agent-tiles"] .set-tile b', (b) => b.map((e) => e.textContent));
    assert(JSON.stringify(tiles) === JSON.stringify(['Claude Code', 'Codex', 'Cursor', 'ChatGPT', 'Claude', 'Other client']), `${tiles}`);
    const info = await (await fetch(`${BASE}/api/info`)).json();
    const snippet = () => page.$eval('[data-testid="agent-snippet"] pre', (e) => e.textContent).catch(() => null);
    const state = () => text('[data-testid="agent-state"]');
    const pick = (id) => page.click(`[data-testid="agent-tiles"] input[value="${id}"]`);
    const until = (fn, what) => page.waitForFunction(fn, { polling: 100, timeout: 8000 }).catch(() => assert(false, what));
    // Claude Code first, through the running app: it gets updates pushed and shows up in the last step.
    assert((await snippet()) === `claude mcp add --transport http lampo ${BASE}/mcp`, `http ${await snippet()}`);
    assert((await state()).includes('Waiting for it to connect'), await state());
    // then the one sentence that sets it to work — the whole loop — for a project of the library's (none yet: this one);
    // Claude Code's /lampo:watch is named as its shortcut
    const tell = () => page.$eval('[data-testid="agent-tell-it"] pre', (e) => e.textContent).catch(() => null);
    assert(/^Use Lampo for (".+"|this project)$/.test((await tell()) ?? ''), `the sentence: ${await tell()}`);
    assert((await text('[data-testid="agent-tell-it"]')).startsWith('Tell Claude Code'), await text('[data-testid="agent-tell-it"]'));
    assert((await text('[data-testid="agent-shortcut"]')).includes('/lampo:watch'), 'the shortcut named');
    const cards = await page.$$eval('.set-card h2', (h) => h.map((e) => e.textContent.replace(/^\d/, '')));
    assert(JSON.stringify(cards.slice(0, 4)) === JSON.stringify(['Pick your agent', 'Add Lampo to it', 'Now tell it', 'See it work']), `${cards}`);
    // Or the client starts its own server: works while the app is closed, but it can't show up here.
    await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="agent-snippet"] button')].find((b) => b.textContent.startsWith('Or let it')).click(),
    );
    await until(() => document.querySelector('[data-testid="agent-snippet"] pre')?.textContent.includes('bin/lampo-mcp'), 'the stdio command');
    assert((await snippet()) === `claude mcp add lampo -- ${info.root}/bin/lampo-mcp`, `stdio ${await snippet()}`);
    assert((await state()).includes('doesn’t show up here'), await state());
    await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="agent-snippet"] button')].find((b) => b.textContent.startsWith('Connect through')).click(),
    );
    // Codex: its config.toml, and the moment a Codex connects, step 3 says so.
    await pick('codex');
    await until(() => document.querySelector('[data-testid="agent-snippet"] pre')?.textContent.startsWith('[mcp_servers.lampo]'), 'the Codex config');
    assert((await snippet()).includes(`url = "${BASE}/mcp"`), await snippet());
    assert((await state()).includes('Waiting for it to connect'), await state());
    await shot('03-agents-waiting');
    const beat = await fetch(`${BASE}/api/agents/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'e2e-codex', name: 'codex-mcp-client', kind: 'codex' }),
    });
    assert(beat.ok, `heartbeat ${beat.status}`);
    await until(() => document.querySelector('[data-testid="agent-state"]')?.textContent.includes('Connected: Codex'), 'Connected: the Codex, by its name');
    // what it does now, in the sidebar's words: it follows the notes (vr watch), so it waits for them
    assert((await state()).includes('waiting for your notes'), await state());
    assert(!(await page.$('[data-testid="agent-shortcut"]')), 'the shortcut is Claude Code’s only');
    await shot('03-agents');
    // ChatGPT needs the app on the internet (https): the page says so instead of a snippet that can't work.
    await pick('chatgpt');
    await until(() => !document.querySelector('[data-testid="agent-snippet"] pre'), 'no snippet for ChatGPT without https');
    assert((await text('[data-testid="agent-snippet"]')).includes('https address'), await text('[data-testid="agent-snippet"]'));
    assert(!(await page.$('[data-testid="agent-state"]')), 'no waiting for something that cannot connect');
    assert(!(await page.$('[data-testid="agent-tell"]')), 'nothing to tell what cannot connect');
    // Claude at the machine: its desktop app starts the server itself. No domain to allow in Claude: a media host is a
    // hosted server's (set for this server, and ignored on the machine).
    await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="agent-tiles"] .set-tile')]
        .find((t) => t.querySelector('b')?.textContent === 'Claude')
        .querySelector('input')
        .click(),
    );
    await until(() => document.querySelector('[data-testid="agent-snippet"] pre')?.textContent.includes('bin/lampo-mcp'), 'the Claude desktop config');
    assert(!(await page.$('[data-testid="agent-allow"]')), 'no domain to allow on the machine');
    assert(info.media_origin === undefined, `the machine names no media host: ${info.media_origin}`);
    // Any other client: its format, one tab each.
    await pick('other');
    await until(() => document.querySelector('[data-testid="agent-snippet"] pre')?.textContent.includes('"servers"'), 'the VS Code config');
    // one path per agent: no vr recipe or "how updates arrive" beside it
    assert(!(await page.$('[data-testid="agent-updates"]')), 'no CLI recipe');
    assert(!(await text('main')).includes('vr watch'), 'no vr watch on the page');
  });

  // On a wide screen the section stood pinned beside the sidebar with the rest of the window empty (~1,550 px at 2560):
  // it keeps its reading measure in the middle of its room. And a tile says its line whole (wrapping, never "Gemi…").
  await check('a section stands in the middle of its room on a wide screen; the agent tiles say their lines whole', async () => {
    const out = [];
    for (const [width, height] of [
      [1440, 900],
      [2560, 1440],
    ]) {
      await page.setViewport({ width, height });
      await open('#/settings/mcp', '[data-testid="agent-tiles"]');
      await settle(page);
      const m = await page.evaluate(() => {
        const main = document.querySelector('.set-main').getBoundingClientRect();
        const inner = document.querySelector('.set-inner').getBoundingClientRect();
        const cut = [...document.querySelectorAll('[data-testid="agent-tiles"] .set-tile > span:last-child')]
          .filter((s) => s.scrollWidth > s.clientWidth + 1)
          .map((s) => s.textContent);
        return { left: Math.round(inner.left - main.left), right: Math.round(main.right - inner.right), width: Math.round(inner.width), cut };
      });
      if (Math.abs(m.left - m.right) > 16 || m.width > 780) out.push(`@${width}: ${m.left} px left of the section, ${m.right} px right, ${m.width} px wide`);
      if (m.cut.length) out.push(`@${width}: tile lines cut: ${m.cut.join(' · ')}`);
    }
    await page.setViewport({ width: 1440, height: 900 });
    assert(!out.length, out.join('\n'));
  });

  // "Other client"'s line wrapped and made its row taller than the first; the tiles stretched to it spread their name and
  // line apart (ChatGPT, Claude); on a tablet three across cut "Claude Co…". Every tile is one size, its name whole and
  // its line the same distance below, on one line where there is room.
  await check('the agent tiles are one size, each with its name and line together', async () => {
    const out = [];
    for (const [width, height] of [
      [390, 844],
      [768, 1024],
      [1024, 768],
      [1440, 900],
      [2560, 1440],
    ]) {
      await page.setViewport({ width, height });
      await open('#/settings/mcp', '[data-testid="agent-tiles"]');
      await settle(page);
      const tiles = await page.$$eval('[data-testid="agent-tiles"] .set-tile', (ts) =>
        ts.map((t) => {
          const name = t.querySelector('b');
          const line = t.querySelector(':scope > span:last-child');
          const [r, b, s] = [t, name, line].map((e) => e.getBoundingClientRect());
          return {
            name: name.textContent,
            cut: name.scrollWidth > name.clientWidth + 1,
            height: Math.round(r.height),
            gap: Math.round(s.top - b.bottom),
            lines: Math.round(s.height / Number.parseFloat(getComputedStyle(line).lineHeight)),
          };
        }),
      );
      if (SHOTS) await (await page.$('[data-testid="agent-tiles"]')).screenshot({ path: path.join(SHOTS, `settings-agent-tiles-${width}.png`) });
      const spread = (k) => Math.max(...tiles.map((x) => x[k])) - Math.min(...tiles.map((x) => x[k]));
      if (spread('height') > 1) out.push(`@${width}: heights ${tiles.map((x) => `${x.name} ${x.height}`).join(', ')}`);
      if (spread('gap') > 1) out.push(`@${width}: name to line ${tiles.map((x) => `${x.name} ${x.gap}`).join(', ')}`);
      const cut = tiles.filter((x) => x.cut);
      if (cut.length) out.push(`@${width}: names cut: ${cut.map((x) => x.name).join(', ')}`);
      const wrapped = tiles.filter((x) => x.lines > 1);
      if (width >= 1024 && wrapped.length) out.push(`@${width}: lines wrap in ${wrapped.map((x) => x.name).join(', ')}`);
    }
    await page.setViewport({ width: 1440, height: 900 });
    assert(!out.length, out.join('\n'));
  });

  await check('About: version, where notes and renders live, and the third-party notices', async () => {
    await open('#/settings/about', '[data-testid="about-facts"]');
    const facts = await text('[data-testid="about-facts"]');
    assert(facts.includes(VERSION) && facts.includes(path.join(dir, 'data')), facts);
    const notices = await page.$eval('[data-testid="notices-link"]', (a) => a.href);
    const res = await fetch(notices);
    assert(res.status === 200 && (await res.text()).length > 1000, `notices ${res.status}`);
    await shot('04-about');
  });

  await check('the info under the sections: values in one column, links that are only links', async () => {
    await open('#/settings/about', '.set-server a[href="/third-party-licenses.txt"]');
    const rows = await page.$$eval('.set-server > div', (divs) => divs.map((d) => [...d.children].map((c) => c.getBoundingClientRect().left)));
    const valueLefts = rows.map((r) => Math.round(r[1]));
    assert(new Set(valueLefts).size === 1, `every value starts in the same column: ${valueLefts}`);
    const link = await page.$('.set-server a[href="/third-party-licenses.txt"]');
    await link.hover();
    const look = await page.$eval('.set-server a[href="/third-party-licenses.txt"]', (a) => {
      const s = getComputedStyle(a);
      return { bg: s.backgroundColor, pad: s.paddingLeft, display: s.display };
    });
    assert(
      look.bg === 'rgba(0, 0, 0, 0)' && look.pad === '0px' && look.display === 'inline',
      `a plain text link, no nav-item box on hover: ${JSON.stringify(look)}`,
    );
  });

  await check('⌘K goes to Settings', async () => {
    await open('#/', '.film, .empty');
    await page.keyboard.down('Meta');
    await page.keyboard.press('k');
    await page.keyboard.up('Meta');
    await page.waitForSelector('[data-testid=palette] input');
    await page.type('[data-testid=palette] input', 'settings');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=palette] [role=option]')].some((o) => o.textContent.includes('Settings')), {
      polling: 100,
      timeout: 5000,
    });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => location.hash === '#/settings', { polling: 100, timeout: 5000 });
  });

  await check('every section fits at phone, tablet and desktop, dark and light', async () => {
    const sections = Object.fromEntries(
      [
        ['#/settings', '.set-form'],
        ['#/settings/appearance', '.set-theme'],
        ['#/settings/tokens', '.set-head h1'],
        ['#/settings/users', '.set-head h1'],
        ['#/settings/speech', '[data-testid="voice-languages"]'],
        ['#/settings/checks', '[data-testid="checks-list"]'],
        ['#/settings/mcp', '[data-testid="agent-tiles"]'],
        ['#/settings/about', '[data-testid="about-facts"]'],
      ].map(([hash, ready]) => [
        hash,
        async (theme) => {
          await open(hash, ready);
          await dataTheme(page, theme);
        },
      ]),
    );
    const out = await layoutMatrix(page, sections, { show: dataTheme });
    assert(!out.length, out.join('\n'));
  });

  await check('a German browser stays English; choosing German in Appearance turns the sections German', async () => {
    german = await launch({ locale: 'de-DE' });
    const de = await german.newPage();
    await de.setViewport({ width: 1440, height: 900 });
    await de.goto(`${BASE}/#/settings`, { waitUntil: 'domcontentloaded' });
    await de.waitForSelector('.set-nav a');
    const english = await de.$$eval('.set-nav > a', (as) => as.map((a) => a.textContent.trim()));
    assert(english[0] === 'Profile', `a German browser starts in English: ${english}`);
    await de.goto(`${BASE}/#/settings/appearance`, { waitUntil: 'domcontentloaded' });
    await de.waitForSelector('.lang-switch [lang=de]');
    await de.click('.lang-switch [lang=de]');
    await de.waitForFunction(() => document.documentElement.lang === 'de', { timeout: 10000 });
    await de.waitForFunction(() => document.querySelector('.set-nav > a')?.textContent.trim() === 'Profil', { timeout: 10000 });
    const labels = await de.$$eval('.set-nav > a', (as) => as.map((a) => a.textContent.trim()));
    const want = [
      'Profil',
      'Darstellung',
      'Agent verbinden',
      'Verbundene Agenten',
      'API-Tokens',
      'Review-Links',
      'Veröffentlichen',
      'Nutzer',
      'Benachrichtigungen',
      'Playbook',
      'Sprachnotizen',
      'Auto-Check',
      'Über',
    ];
    assert(JSON.stringify(labels) === JSON.stringify(want), `sections ${labels}`);
    if (SHOTS) await de.screenshot({ path: path.join(SHOTS, 'settings-05-de.png') });
  });

  await check('Notifications: a webhook’s last delivery speaks the chosen language, a failed one too', async () => {
    const de = (await german.pages()).at(-1);
    // a receiver that refuses (a 4xx is not retried): this server itself, at a path it takes no POST on
    const made = await fetch(`${BASE}/api/admin/webhooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `${BASE}/no-such-hook`, label: 'Studio hook', format: 'json', events: ['client'] }),
    });
    assert(made.ok, `making a webhook: ${made.status} ${await made.clone().text()}`);
    const hook = await made.json();
    const sent = await (await fetch(`${BASE}/api/admin/webhooks/${hook.id}/test`, { method: 'POST' })).json();
    assert(!sent.ok, `the test failed, as it should: ${JSON.stringify(sent)}`);
    await de.goto(`${BASE}/#/settings/notifications`, { waitUntil: 'domcontentloaded' });
    const last = await (await de.waitForSelector('.set-row .set-warn', { timeout: 10000 })).evaluate((e) => e.textContent);
    assert(/^fehlgeschlagen .+: HTTP 4\d\d/.test(last), `the failed delivery in German: ${last}`);
  });

  await check('no page errors along the way', async () => {
    assert(!errors.length, errors.join(' | '));
  });
} catch (e) {
  crashed(e, srv);
} finally {
  await german?.close();
  await finish(LABEL, { browser, servers: [srv] });
}
