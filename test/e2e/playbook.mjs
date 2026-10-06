#!/usr/bin/env node
// covers: web/src/playbook/ web/src/settings/Playbook.tsx web/src/styles/playbook.css server/routes/playbooks.ts
// covers: lib/playbook*.ts web/src/inbox/PlaybookPreview.tsx
// Browser end-to-end test of playbooks on a local store: a real server (temp store, free port) + headless Chrome. The
// playbook is one document (brief, rules, skills, references, each written in place) beside what agents read, live:
// a first run gets useful in a click (starter rules saved one at a time or all at once, the brief written where it
// will be read, what agents read changing as it's typed); a folder inherits the House (shown as a line of playbooks
// and folded under its own) and writes its own rules one line at a time, from what the notes keep asking for; a rule
// comes out with Undo; a skill is written as SKILL.md in a dialog to write in (twelve lines at least, growing until the
// dialog is full, then scrolling; Write and Preview one box); an agent's suggestion waits inside the section it changes
// (and in the inbox, accepted there), another is rejected with a reason the history keeps; one a person overtook says
// so before anyone clicks and is accepted only on purpose; a project's page points to the suggestions waiting in its
// folders, and the link lands on Accept; several suggestions for one skill stand together, the newest first, and
// accepting one makes the others say what they would replace (the inbox too); the inbox lists every playbook's; two
// people saving the same section see both versions; the history keeps every change; a render that arrives afterwards
// is stamped with the revisions in force. Phones get what agents read and the history as dialogs, a skill on the whole
// screen. Fits every width in both themes.
import path from 'node:path';
import { age, makeVideo } from '../lib/helpers.ts';
import { dataTheme, layoutMatrix } from './layout.mjs';
import { launch, requireChrome, requireDist, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'playbook e2e';
requireChrome(LABEL);
requireDist(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-playbook-e2e-', user: 'Sam' });
const { base: BASE, dir } = srv;
const FOLDER = 'Acme/Reels';
const e = encodeURIComponent;

const api = async (url, method = 'GET', body) => {
  const res = await fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  assert(res.ok, `${method} ${url}: ${res.status} ${await res.clone().text()}`);
  return res.json();
};
const book = async (folder) => (await api(`/api/playbook?folder=${e(folder)}`)).playbook;

let browser;
try {
  // A reel in Acme/Reels with three notes asking for quieter music (a recurring ask no rule names yet, not even a starter rule).
  const file = makeVideo(path.join(dir, 'Acme/export/reel.mp4'), { w: 320, h: 180, fps: 30, dur: 2 });
  age(file);
  const slug = (await api('/api/library', 'POST', { path: file, folder: FOLDER })).video.slug;
  for (const text of ['Music too loud under the voice', 'Lower the music in the intro', 'The music fights the voice-over'])
    await api(`/api/review/${e(slug)}/comments`, 'POST', { v: 1, frame: 20, text, tags: ['music'], severity: 'should' });

  browser = await launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `playbook-${name}.png`) });
  const text = (sel) => page.$eval(sel, (el) => el.innerText.replace(/\s+/g, ' ').trim());
  const value = (sel) => page.$eval(sel, (el) => el.value);
  const until = async (fn, what, ms = 8000) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await fn().catch(() => false)) return;
      if (Date.now() > end) throw new Error(`timed out: ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const loaded = () => page.waitForSelector('[data-testid=playbook][aria-busy=false]');
  // A fresh page each time: a hash change alone keeps the document, and the playbook on screen before would answer
  // for the one asked for.
  const open = async (hash) => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
    await loaded();
  };
  const agents = () => text('[data-testid=pb-agent-pane] [data-testid=pb-agent-md]');
  /** Types a rule into the section's line and keeps it with ↵; waits until it is saved. */
  const addRule = async (rule, folder) => {
    const before = (await book(folder)).rev;
    await page.click('[data-testid=pb-add-rule]');
    await page.keyboard.type(rule);
    await page.keyboard.press('Enter');
    await until(async () => (await book(folder)).rev === before + 1, `the rule "${rule}" saved`);
  };

  await check('first run: one document — four sections, no tabs, nothing pressing; what agents read beside it', async () => {
    await open('#/settings/playbook');
    const titles = await page.$$eval('.pb-sheet .pb-sec-title', (els) => els.map((el) => el.textContent));
    assert(JSON.stringify(titles) === JSON.stringify(['Brief', 'Rules', 'Skills', 'References']), `sections ${titles}`);
    assert(!(await page.$('[role=tablist] [data-testid^=pb-tab]')), 'no tabs');
    assert(!(await page.$('[data-testid=pb-history-link]')) && !(await page.$('[data-testid=pb-suggestions-link]')), 'no empty links');
    assert(!(await page.$('[data-testid=playbook] .btn.primary')), 'no primary action at rest');
    assert((await text('[data-testid=pb-lineage]')).includes('Every project inherits it'), 'the House says who inherits it');
    assert((await agents()).includes('No playbook applies to the House yet'), 'what agents read now, beside it');
    assert(await page.$('[data-testid=pb-brief] [data-testid=pb-text-brief]'), 'the brief is written in place');
    await shot('first-run');
  });

  await check('starter rules: one click adds one, saved, and agents read it at once; the rest in one click more', async () => {
    const starters = await page.$$('[data-testid=pb-starter]');
    assert(starters.length === 7, `seven starter rules: ${starters.length}`);
    const first = await page.$eval('[data-testid=pb-starter]', (el) => el.textContent.trim());
    await starters[0].click();
    await until(async () => (await book('')).rev === 1, 'saved as revision 1');
    assert((await book('')).rules === `- ${first}`, 'the rule, as a list item');
    await until(async () => (await text('[data-testid=pb-rules] .pb-rules')).includes(first), 'it reads as a rule');
    await until(async () => (await agents()).includes(first), 'what agents read says it');
    assert((await page.$$('[data-testid=pb-starter]')).length === 6, 'and it is no longer offered');
    await page.click('[data-testid=pb-starters-all]');
    await until(async () => (await book('')).rev === 2, 'the other six in one revision');
    await until(async () => (await page.$$('[data-testid=pb-rule]')).length === 7, 'seven rules');
    await until(async () => !(await page.$('[data-testid=pb-starters]')), 'no starter rules left to offer');
    assert((await text('[data-testid=pb-history-link]')).startsWith('History'), 'the history is there once something was written');
  });

  await check('the brief in place: an outline to start from; what agents read changes as it is typed; ⌘↵ saves it', async () => {
    await page.click('[data-testid=pb-brief-outline]');
    const outline = (await value('[data-testid=pb-text-brief]')).split('\n');
    assert(outline.length === 4 && outline[0].startsWith('**Who it’s for:**'), `the outline ${outline}`);
    await page.click('[data-testid=pb-editor-brief] .btn.ghost');
    await until(async () => (await value('[data-testid=pb-text-brief]')) === '', 'cancelled: empty again');
    await page.click('[data-testid=pb-text-brief]');
    await page.keyboard.type('We make short motion pieces that feel **human**.');
    const drafted = () => page.$$eval('[data-testid=pb-agent-pane] .pb-al.draft', (els) => els.map((el) => el.textContent.trim()));
    await until(async () => (await drafted()).includes('We make short motion pieces that feel **human**.'), 'the draft, where it will go');
    assert((await drafted()).includes('### From House (revision 3)'), `under the revision saving makes: ${await drafted()}`);
    assert((await text('[data-testid=pb-agent-pane]')).includes('once you save it'), 'the pane says it isn’t saved yet');
    assert((await page.$$('[data-testid=playbook] .btn.primary')).length === 1, 'one primary: Save');
    await shot('brief-typing');
    await page.keyboard.down('Meta');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Meta');
    await until(async () => (await book('')).brief.includes('feel **human**'), 'saved');
    await page.waitForSelector('[data-testid=pb-brief] .pb-md');
    assert((await text('[data-testid=pb-brief] .pb-md')).includes('feel human'), 'it reads as markdown');
    assert(!(await page.$('[data-testid=pb-agent-pane] .pb-al.draft')), 'nothing left unsaved');
  });

  await check('a folder inherits: the line of playbooks, the House folded under its own, rules from the notes', async () => {
    await page.goto(`${BASE}/#/folder/${e(FOLDER)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=folder-tab-playbook]');
    await page.click('[data-testid=folder-tab-playbook]');
    await loaded();
    assert((await page.evaluate(() => location.hash)) === `#/playbook/${e(FOLDER)}`, 'the tab is a route');
    const line = await text('[data-testid=pb-lineage]');
    assert(/House r3 · brief · 7 rules/.test(line) && /Reels · nothing yet/.test(line), `the line ${line}`);
    assert((await text('[data-testid=pb-rules] [data-testid=pb-inherited]')).startsWith('7 rules from House'), 'the House’s rules, folded');
    assert((await text('[data-testid=pb-brief] [data-testid=pb-inherited]')).startsWith('Brief from House'), 'the House’s brief, folded');
    assert(!(await page.$('[data-testid=pb-starters]')), 'no starter rules where the House has rules');
    // the notes keep asking for quieter music: a click starts the line, the person writes the rule
    assert((await text('[data-testid=pb-make-rule]')).startsWith('music'), 'the music ask');
    await page.click('[data-testid=pb-make-rule]');
    assert((await value('[data-testid=pb-add-rule]')).startsWith('Music: '), 'the line started');
    assert((await book(FOLDER)).rev === 0, 'nothing saved until the person keeps it');
    // The line puts its caret at the end on its next frame (focusLine): a select() before that frame is undone, and the
    // Backspace then takes one letter instead of the line (a slow runner). Two frames, then select.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.$eval('[data-testid=pb-add-rule]', (el) => el.select());
    await page.keyboard.press('Backspace');
    // the started line is gone before the next words go in (a slow runner typed after "Music: ")
    await page.waitForFunction(() => document.querySelector('[data-testid=pb-add-rule]')?.value === '');
    await addRule('9:16, first cut within 1.5 s', FOLDER);
    await addRule('Subtitles burned in, two lines at most', FOLDER);
    const rules = (await book(FOLDER)).rules;
    assert(rules === '- 9:16, first cut within 1.5 s\n- Subtitles burned in, two lines at most', `two rules, a line each: ${JSON.stringify(rules)}`);
    await until(async () => /Reels r2 · 2 rules/.test(await text('[data-testid=pb-lineage]')), 'the line says what it holds');
    assert((await text('[data-testid=pb-lineage]')).includes('Reels wins where they disagree'), 'and that it wins');
    const md = await agents();
    const rulesAt = md.indexOf('## Rules');
    assert(rulesAt > 0 && md.indexOf('From Acme/Reels', rulesAt) < md.indexOf('From House', rulesAt), 'agents read the folder’s rules first');
  });

  await check('a folder overrides: its own brief comes first; a rule taken out comes back with Undo', async () => {
    await page.click('[data-testid=pb-text-brief]');
    await page.keyboard.type('Acme reels: short, warm, never salesy.');
    await page.click('[data-testid=pb-save-brief]');
    await until(async () => (await book(FOLDER)).brief === 'Acme reels: short, warm, never salesy.', 'saved');
    await until(async () => {
      const md = await agents();
      return md.indexOf('Acme reels: short') > 0 && md.indexOf('Acme reels: short') < md.indexOf('We make short motion pieces');
    }, 'the folder’s brief before the House’s');
    const rev = (await book(FOLDER)).rev;
    // the rules list redraws after the brief is saved: take the rule once it is back on screen
    const rule = '[data-testid=pb-rule]:last-child';
    await until(async () => /Subtitles/.test(await text(rule).catch(() => '')), 'the rule on screen again');
    await page.hover(rule);
    await page.click(`${rule} .pb-rule-x`);
    await until(async () => (await book(FOLDER)).rev === rev + 1 && !(await book(FOLDER)).rules.includes('Subtitles'), 'taken out, saved');
    await page.waitForSelector('[data-testid=toast] .toast-act');
    await page.$$eval('[data-testid=toast] .toast-act', (bs) => bs.at(-1).click());
    await until(async () => (await book(FOLDER)).rules.includes('Subtitles burned in'), 'back after Undo');
    await shot('folder');
  });

  /** The instructions' field and the dialog around it: heights in lines, whether the dialog's body or the field scrolls. */
  const skillBox = () =>
    page.evaluate(() => {
      const ta = document.querySelector('[data-testid=pb-skill-body]');
      const pane = document.querySelector('.pb-skill-pane');
      const body = document.querySelector('[role=dialog] .modal-body');
      const files = document.querySelector('.pb-skill-files');
      const lh = parseFloat(getComputedStyle(ta).lineHeight);
      return {
        lines: ta.getBoundingClientRect().height / lh,
        pane: Math.round(pane.getBoundingClientRect().height),
        filesTop: Math.round(files.getBoundingClientRect().top),
        bodyScrolls: body.scrollHeight > body.clientHeight + 1,
        fieldScrolls: ta.scrollHeight > ta.clientHeight + 1,
        dialog: document.querySelector('[role=dialog]').getBoundingClientRect().height,
      };
    });

  await check('a skill: written in the dialog, stored as SKILL.md for agents', async () => {
    await page.click('[data-testid=pb-new-skill]');
    await page.waitForSelector('[data-testid=pb-skill-dialog]');
    await page.type('[data-testid=pb-skill-name]', 'reels export');
    await page.type('[data-testid=pb-skill-desc]', 'Export a reel for Instagram and TikTok');
    // a place to write: at least twelve lines before anything is typed
    const empty = await skillBox();
    assert(empty.lines >= 12, `the empty field is ${empty.lines.toFixed(1)} lines high`);
    await page.type('[data-testid=pb-skill-body]', '1. Render the Reel_Master comp\n2. -14 LUFS');
    await page.click('[data-testid=pb-skill-save]');
    await page.waitForSelector('[data-testid=pb-skill-dialog]', { hidden: true });
    await until(async () => (await text('[data-testid=pb-skills]')).includes('reels-export'), 'the skill is listed');
    const skill = await api(`/api/playbook/skill?folder=${e(FOLDER)}&name=reels-export`);
    assert(skill.markdown.startsWith('---\nname: reels-export\n') && skill.markdown.includes('Export a reel for Instagram'), `SKILL.md ${skill.markdown}`);
    await until(async () => (await agents()).includes('reels-export'), 'agents read it');
  });

  await check('the skill’s instructions grow with the text until the dialog is full, then scroll inside; Write and Preview are one box', async () => {
    await page.click('[data-testid=pb-skill-row]');
    await page.waitForSelector('[data-testid=pb-skill-dialog]');
    await page.click('.pb-skill > .seg button:first-child');
    await page.waitForFunction(() => document.activeElement?.matches('[data-testid=pb-skill-body]'));
    const before = await skillBox();
    await page.keyboard.press('End');
    await page.keyboard.down('Meta');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.up('Meta');
    await page.keyboard.type(Array.from({ length: 16 }, (_, i) => `\n${i + 3}. Check step ${i + 3}`).join(''));
    const grown = await skillBox();
    assert(grown.pane > before.pane && !grown.bodyScrolls, `it grew (${before.pane} → ${grown.pane} px), the dialog's body still: ${JSON.stringify(grown)}`);
    await page.keyboard.type(Array.from({ length: 40 }, (_, i) => `\n${i + 19}. Check step ${i + 19}`).join(''));
    const full = await skillBox();
    assert(full.fieldScrolls && !full.bodyScrolls, `full: the field scrolls, not the dialog: ${JSON.stringify(full)}`);
    assert(full.dialog <= 900 - 64 + 1, `the dialog stays inside the window: ${full.dialog}`);
    await shot('skill-dialog-full');
    await page.click('.pb-skill > .seg button:last-child');
    await page.waitForSelector('[data-testid=pb-skill-preview]');
    const preview = await skillBox();
    assert(preview.pane === full.pane && preview.filesTop === full.filesTop, `Preview keeps the box: ${JSON.stringify({ full, preview })}`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid=pb-skill-dialog]', { hidden: true });
  });

  const suggest = (content, reason) => api('/api/playbook/proposals', 'POST', { folder: FOLDER, section: 'rules', content, reason, by: 'agent:promo-edit' });

  await check('an agent suggests: it waits inside the rules, the line counts it, the inbox shows its diff, Accept applies it', async () => {
    const before = (await book(FOLDER)).rev;
    const rules = (await book(FOLDER)).rules;
    const proposal = await suggest(`${rules}\n- Logo at most 8 % of the height`, 'Three notes asked for a smaller logo.');
    await until(async () => (await text('[data-testid=folder-tab-playbook]')).endsWith('1'), 'the tab counts the suggestion');
    await until(async () => (await text('[data-testid=pb-suggestions-link]')) === '1 suggestion', 'the line counts it');
    assert(await page.$('[data-testid=pb-rules] [data-testid=pb-suggestion] [data-testid=pb-proposal]'), 'inside the section it changes');
    await shot('suggestion');
    await page.goto(`${BASE}/#/inbox`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=inbox-row-playbook]');
    await page.click('[data-testid=inbox-row-playbook]');
    await page.waitForSelector('[data-testid=inbox-playbook-preview] .pb-diff');
    const diff = await text('[data-testid=inbox-playbook-preview] .pb-diff');
    assert(diff.includes('at most 8 % of the height'), `diff ${diff}`);
    assert((await text('[data-testid=inbox-playbook-preview]')).includes('promo-edit suggests a change to the rules'), 'who and what');
    await shot('inbox');
    await page.click('[data-testid=inbox-playbook-preview] [data-testid=pb-accept]');
    await until(async () => (await api(`/api/playbook/proposals/${proposal.id}`)).status === 'accepted', 'accepted');
    const after = await book(FOLDER);
    assert(
      after.rev === before + 1 && after.rules.includes('at most 8 %') && after.history.at(-1).accepted_by === 'Sam',
      `after ${JSON.stringify(after.history.at(-1))}`,
    );
    await until(async () => !(await page.$('[data-testid=inbox-row-playbook]')), 'the inbox moves on');
  });

  await check('reject with a reason in place (the inbox’s link lands on it): the agent reads why, the history keeps it', async () => {
    const proposal = await suggest('- Everything in 16:9', 'The client asked for wide once.');
    await open(`#/playbook/${e(FOLDER)}?tab=suggestions`);
    await page.waitForSelector('[data-testid=pb-suggestion] [data-testid=pb-reject]');
    // the link lands on the decision with Accept in focus: Enter accepts, it never opens the reject form
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'pb-accept', { timeout: 8000 });
    await page.click('[data-testid=pb-suggestion] [data-testid=pb-reject]');
    await page.type('[data-testid=pb-suggestion] .pb-prop-reject textarea', 'Reels stay vertical');
    await page.click('[data-testid=pb-reject-send]');
    await until(async () => (await api(`/api/playbook/proposals/${proposal.id}`)).status === 'rejected', 'rejected');
    assert((await api(`/api/playbook/proposals/${proposal.id}`)).reject_reason === 'Reels stay vertical', 'the reason is kept');
    await until(async () => !(await page.$('[data-testid=pb-suggestion]')), 'it leaves the document');
    await until(async () => !(await page.$('[data-testid=pb-suggestions-link]')), 'and the line');
  });

  await check('history: in the pane beside the document — every change, who made it, the diff on demand, what was turned down', async () => {
    await page.click('[data-testid=pb-history-link]');
    await page.waitForSelector('[data-testid=pb-history-pane] [data-testid=pb-history]');
    const rows = await page.$$eval('[data-testid=pb-history] .pb-h-row', (els) => els.map((el) => el.innerText.replace(/\s+/g, ' ').trim()));
    const rev = (await book(FOLDER)).rev;
    assert(rows.length === rev + 1, `every revision and the rejected suggestion: ${rows.length} for r${rev}`);
    assert(
      rows.some((r) => r.startsWith('Turned down: promo-edit on the rules') && r.includes('“Reels stay vertical”')),
      `the rejected one, with why: ${rows}`,
    );
    assert(
      rows.some((r) => r.includes('accepted by Sam')),
      `the accepted suggestion: ${rows}`,
    );
    assert(rows.find((r) => /^r\d/.test(r))?.startsWith(`r${rev}`), `the newest revision first: ${rows}`);
    await page.click('[data-testid=pb-history] button.pb-h-row');
    await page.waitForSelector('[data-testid=pb-history] .pb-diff');
    await shot('history');
    await page.click('[data-testid=pb-history-pane] .pb-pane-head button');
    await page.waitForSelector('[data-testid=pb-agent-pane]');
  });

  await check(
    'a suggestion someone overtook says so before anyone clicks: who changed the rules since, the diff shows what it would replace, Accept anyway',
    async () => {
      const proposal = await suggest('- Everything at most 30 s', 'Shorter reels do better.');
      await open(`#/playbook/${e(FOLDER)}?tab=suggestions`);
      await page.waitForSelector('[data-testid=pb-suggestion] [data-testid=pb-accept]');
      // Someone changes the rules while the suggestion is on screen.
      const mine = `${(await book(FOLDER)).rules}\n- Music licensed for social only`;
      await api('/api/playbook/text', 'PUT', { folder: FOLDER, section: 'rules', content: mine });
      const rev = (await book(FOLDER)).rev;
      await page.waitForSelector('[data-testid=pb-suggestion] [data-testid=pb-overtaken]');
      const why = await text('[data-testid=pb-overtaken]');
      assert(why.startsWith(`Sam changed the rules in r${rev}, after this suggestion was made`), `why ${why}`);
      assert(!(await page.$('[data-testid=pb-suggestion] [data-testid=pb-accept]')), 'no plain Accept: replacing is a choice');
      assert(await page.$('[data-testid=pb-suggestion] [data-testid=pb-accept-anyway]'), 'Accept anyway');
      await until(async () => (await text('[data-testid=pb-suggestion] .pb-diff')).includes('Music licensed'), 'the diff against the rules now');
      assert((await api(`/api/playbook/proposals/${proposal.id}`)).status === 'pending', 'still waiting');
      assert((await book(FOLDER)).rules === mine, 'the person’s rules stand');
      await shot('overtaken');
      await page.click('[data-testid=pb-suggestion] [data-testid=pb-reject]');
      await page.click('[data-testid=pb-reject-send]');
      await until(async () => (await api(`/api/playbook/proposals/${proposal.id}`)).status === 'rejected', 'rejected');
    },
  );

  await check('suggestions waiting inside a project: its page names the folder, the tab counts them, one click opens them', async () => {
    const proposal = await suggest(`${(await book(FOLDER)).rules}\n- End card at least 2 s`, 'Two notes asked for a longer end card.');
    await open(`#/playbook/${e('Acme')}`);
    await page.waitForSelector('[data-testid=pb-below]');
    assert((await text('[data-testid=pb-below]')) === 'Reels · 1 suggestion waiting', `the line: ${await text('[data-testid=pb-below]')}`);
    await until(async () => (await text('[data-testid=folder-tab-playbook]')).endsWith('1'), 'the project’s tab counts it');
    await shot('waiting-inside');
    await page.click('[data-testid=pb-below]');
    await page.waitForSelector(`[data-testid=playbook][data-scope="${FOLDER}"][aria-busy=false]`);
    assert(/^#\/playbook\/Acme%2FReels\?tab=suggestions$/.test(await page.evaluate(() => location.hash)), 'that playbook, on its suggestions');
    // the decision has the focus: Accept, not Reject (a key press must not open the reject form)
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'pb-accept', { timeout: 8000 });
    await open('#/settings/playbook');
    assert((await text('[data-testid=pb-below]')) === 'Acme/Reels · 1 suggestion waiting', 'the House names the path');
    await api(`/api/playbook/proposals/${proposal.id}/reject`, 'POST', {});
  });

  await check(
    'several suggestions for one skill: together, the newest first and marked; accepting it makes the others say what they would replace',
    async () => {
      const md = (steps) => `---\nname: reels-export\ndescription: Export a reel for Instagram and TikTok\n---\n\n1. Render the Reel_Master comp\n${steps}`;
      const skill = (content, reason, by) => api('/api/playbook/proposals', 'POST', { folder: FOLDER, section: 'skill', content, reason, by });
      const a = await skill(md('2. -14 LUFS\n3. H.264, 16 Mbit/s'), 'The bitrate.', 'agent:promo-edit');
      const b = await skill(md('2. -14 LUFS\n3. H.264, 16 Mbit/s\n4. acme_<cut>_v<n>.mp4'), 'And the file name.', 'agent:promo-edit');
      const c = await skill(md('2. -14 LUFS\n3. H.265, 12 Mbit/s\n4. acme_<cut>_v<n>.mp4'), 'Smaller files.', 'agent:Anthropic-ClaudeAI');
      await open(`#/playbook/${e(FOLDER)}`);
      const set = '[data-testid=pb-skills] [data-testid=pb-suggest-set]';
      await page.waitForSelector(set);
      assert((await text(`${set} .pb-suggest-say`)).startsWith('3 suggestions for the skill reels-export, the newest first'), 'one line for the three');
      assert(
        JSON.stringify(await page.$$eval(`${set} [data-testid=pb-proposal]`, (els) => els.map((el) => el.dataset.id))) === JSON.stringify([c.id, b.id, a.id]),
        'the newest first',
      );
      assert((await text(`${set} [data-testid=pb-proposal][data-id=${c.id}] [data-testid=pb-newest]`)) === 'Newest of 3', 'marked');
      assert((await page.$$(`${set} [data-testid=pb-newest]`)).length === 1, 'only the newest');
      await shot('same-skill');
      const rev = (await book(FOLDER)).rev;
      await page.click(`${set} [data-testid=pb-proposal][data-id=${c.id}] [data-testid=pb-accept]`);
      await until(async () => (await book(FOLDER)).skills.find((s) => s.name === 'reels-export')?.body.includes('H.265'), 'the newest accepted');
      const said = `Sam accepted another suggestion for the skill reels-export in r${rev + 1}`;
      await until(async () => (await page.$$(`${set} [data-testid=pb-overtaken]`)).length === 2, 'both others say it');
      for (const id of [a.id, b.id]) {
        const card = `${set} [data-testid=pb-proposal][data-id=${id}]`;
        assert((await text(`${card} [data-testid=pb-overtaken]`)).startsWith(said), 'who and when');
        assert((await text(`${card} .pb-diff`)).includes('H.265'), 'the diff against the accepted one: what it would replace');
        assert(!(await page.$(`${card} [data-testid=pb-accept]`)) && (await page.$(`${card} [data-testid=pb-accept-anyway]`)), 'Accept anyway only');
      }
      await shot('same-skill-after');
      // the inbox's preview says the same of the older one, and it is decided there on purpose
      await page.goto(`${BASE}/#/inbox`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid=inbox-row-playbook]');
      const rows = await page.$$('[data-testid=inbox-row-playbook]');
      for (const r of rows) if ((await r.evaluate((el) => el.innerText)).includes('And the file name.')) await r.click();
      const pv = '[data-testid=inbox-playbook-preview]';
      await page.waitForSelector(`${pv} [data-testid=pb-proposal][data-id=${b.id}] [data-testid=pb-overtaken]`);
      assert(
        (await text(`${pv} [data-testid=pb-same-section]`)).startsWith('2 suggestions for the skill reels-export are waiting, this one the newest'),
        'and how it relates',
      );
      await page.click(`${pv} [data-testid=pb-accept-anyway]`);
      await until(async () => (await api(`/api/playbook/proposals/${b.id}`)).status === 'accepted', 'accepted on purpose');
      assert((await book(FOLDER)).skills.find((s) => s.name === 'reels-export')?.body.includes('H.264, 16 Mbit/s\n4. acme_'), 'its text replaced the other');
      await api(`/api/playbook/proposals/${a.id}/reject`, 'POST', { reason: 'Covered' });
    },
  );

  await check('the inbox lists every playbook’s suggestions: the House’s, a project’s, a folder’s', async () => {
    const made = [
      await api('/api/playbook/proposals', 'POST', { section: 'rules', content: '- Grain at 3 %', reason: 'House', by: 'agent:promo-edit' }),
      await api('/api/playbook/proposals', 'POST', {
        folder: 'Acme',
        section: 'brief',
        content: 'Acme makes kitchens.',
        reason: 'Project',
        by: 'agent:promo-edit',
      }),
      await suggest(`${(await book(FOLDER)).rules}\n- Hook in the first second`, 'Folder'),
    ];
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/inbox`, { waitUntil: 'domcontentloaded' });
    await until(async () => (await page.$$('[data-testid=inbox-row-playbook]')).length === 3, 'three rows');
    // grouped by playbook, like videos
    const groups = await page.$$eval('[data-testid=inbox-vgroup]:has([data-testid=inbox-row-playbook])', (els) =>
      els.map((el) => el.getAttribute('aria-label')).sort(),
    );
    assert(JSON.stringify(groups) === JSON.stringify(['Acme', 'Acme/Reels', 'House']), `one group per playbook: ${groups}`);
    for (const p of made) await api(`/api/playbook/proposals/${p.id}/reject`, 'POST', {});
  });

  await check('two people save the same section: both versions side by side — keep theirs, or save yours over it', async () => {
    await open(`#/playbook/${e(FOLDER)}`);
    await page.click('[data-testid=pb-edit-rules]');
    await page.waitForSelector('[data-testid=pb-text-rules]');
    await page.$eval('[data-testid=pb-text-rules]', (el) => el.select());
    await page.keyboard.type('- Only vertical\n- Hook in the first second');
    // someone else saves the rules meanwhile
    await api('/api/playbook/text', 'PUT', { folder: FOLDER, section: 'rules', content: '- Theirs: 45–60 s' });
    await page.click('[data-testid=pb-save-rules]');
    await page.waitForSelector('[data-testid=pb-conflict]');
    await until(async () => (await text('[data-testid=pb-conflict]')).startsWith('Sam changed the rules while you were writing'), 'who changed what');
    await until(async () => (await text('[data-testid=pb-conflict] .pb-diff')).includes('Theirs: 45–60 s'), 'theirs, against mine');
    assert((await book(FOLDER)).rules === '- Theirs: 45–60 s', 'nothing overwritten yet');
    await shot('conflict');
    await page.click('[data-testid=pb-conflict-mine]');
    await until(async () => (await book(FOLDER)).rules === '- Only vertical\n- Hook in the first second', 'mine, saved over theirs on purpose');
    await page.waitForSelector('[data-testid=pb-conflict]', { hidden: true });
  });

  await check('a render arriving now is stamped with the revisions in force; the version picker names it', async () => {
    makeVideo(file, { w: 320, h: 180, fps: 30, dur: 2, pattern: 'testsrc2', freq: 660 });
    age(file);
    await api(`/api/review/${e(slug)}/sync`, 'POST', {});
    const versions = (await api(`/api/review/${e(slug)}`)).review.versions;
    const rev = (await book(FOLDER)).rev;
    const house = (await book('')).rev;
    assert(
      !versions[0].playbook &&
        JSON.stringify(versions[1].playbook) ===
          JSON.stringify([
            { scope: '', rev: house },
            { scope: FOLDER, rev },
          ]),
      `stamps ${JSON.stringify(versions)}`,
    );
    await page.goto(`${BASE}/#/v/${e(slug)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=version-picker]');
    await page.click('[data-testid=version-picker]');
    await page.waitForSelector('[data-testid=version-playbook]');
    assert((await text('[data-testid=version-playbook]')) === `Reels r${rev}`, 'the folder’s own revision');
    await page.keyboard.press('Escape');
  });

  await check('phone: one column; what agents read and the history open as dialogs', async () => {
    await page.setViewport({ width: 390, height: 844, isMobile: false });
    await open(`#/playbook/${e(FOLDER)}`);
    assert(!(await page.$eval('.pb-pane', (el) => !!el.offsetParent)), 'no pane beside the document');
    await page.click('[data-testid=pb-agent-view]');
    await page.waitForSelector('[role=dialog] [data-testid=pb-agent-md]');
    assert((await text('[role=dialog] [data-testid=pb-agent-md]')).includes('# Playbook: Acme/Reels'), 'what agents read');
    await shot('phone-agents');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[role=dialog]', { hidden: true });
    await page.click('[data-testid=pb-history-link]');
    await page.waitForSelector('[role=dialog] [data-testid=pb-history]');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[role=dialog]', { hidden: true });
    await shot('phone');
    // a skill is written on the whole screen: the sheet at its tallest, the instructions taking what it leaves
    await page.click('[data-testid=pb-new-skill]');
    await page.waitForSelector('[data-testid=pb-skill-dialog]');
    await page.waitForFunction(() => {
      const d = document.querySelector('[role=dialog]')?.getBoundingClientRect();
      return d && Math.abs(d.bottom - innerHeight) < 1 && d.height >= innerHeight - 25;
    });
    const sheet = await skillBox();
    assert(sheet.lines >= 12 && !sheet.bodyScrolls, `the field fills the sheet: ${JSON.stringify(sheet)}`);
    const foot = await page.$$eval('[role=dialog] .modal-foot .btn', (bs) => new Set(bs.map((b) => Math.round(b.getBoundingClientRect().top))).size);
    assert(foot === 1, `the actions keep one row: ${foot}`);
    await shot('phone-skill');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[role=dialog]', { hidden: true });
    await page.setViewport({ width: 1440, height: 900 });
  });

  await check('fits at phone, tablet and desktop, in both themes', async () => {
    const out = [];
    for (const [where, hash] of [
      ['folder playbook', `#/playbook/${e(FOLDER)}`],
      ['House', '#/settings/playbook'],
    ]) {
      await open(hash);
      out.push(...(await layoutMatrix(page, { [where]: null }, { show: dataTheme })));
    }
    assert(!out.length, out.join('\n'));
  });

  await check('no page errors along the way', async () => {
    assert(!errors.length, errors.join(' | '));
  });
} catch (err) {
  crashed(err, srv);
} finally {
  await finish(LABEL, { browser, servers: [srv] });
}
