#!/usr/bin/env node
// covers: web/src/player/CommentCard.tsx web/src/player/CheckDecision.tsx web/src/player/VerifyPanel.tsx
// covers: web/src/player/useVerify.ts web/src/player/fixCheck.ts web/src/lib/hidden.ts server/routes/review.ts
// covers: web/src/styles/notes.css
// Browser suite of a note's thread and checking fixes (local mode, temp store, headless Chrome). Check mode and the
// notes panel read the same notes: a fix reopened on its card in the panel leaves check mode's queue at once (the card
// keeps the fix it is on, and the reopened one never comes up), and a fix checked or reopened in check mode shows on
// its card in the panel at once. On a fix waiting to be checked the card has one decision row — Looks right · Still
// wrong, the reason and its microphone opening in place, check mode's own component — and the reply field below it,
// full width, saying it leaves the status: ⌘↵ sends a plain reply (still waiting to be checked), "Send and reopen"
// sends the same words as the reason. Your own replies have a ⋯ to edit them in place (⌘↵ saves, Esc cancels, then
// "edited") or delete them (Undo, sent once the toast is gone); someone else's have none. The card fits 390–1920 in
// both themes, and keeps the room of its marked frame before the picture arrives. Screenshots (VR_SHOTS).
import fs from 'node:fs';
import path from 'node:path';
import { age, makeVideo, until } from '../lib/helpers.ts';
import { layoutMatrix, settle, WIDTHS } from './layout.mjs';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'thread e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-thread-e2e-', user: 'Sam' });
const { dir, base: BASE } = srv;
const api = jsonApi(BASE);
const enc = encodeURIComponent;

let browser;
let page;
try {
  // spot.mp4: V1 with the notes, V2 the agent's re-render with its fixes
  const file = makeVideo(path.join(dir, 'Acme/export/spot.mp4'), { w: 320, h: 180, fps: 25, dur: 4 });
  age(file);
  const { video } = await api('/api/library', 'POST', { path: file, folder: 'Acme' });
  const slug = video.slug;
  const add = async (frame, text) => api(`/api/review/${enc(slug)}/comments`, 'POST', { v: 1, frame, text, severity: 'should' });
  const notes = {};
  for (const [name, frame, text] of [
    ['one', 10, 'Swoosh on the first title'],
    ['two', 30, 'Logo a touch later'],
    ['three', 50, 'A subtle sound on each change'],
    ['four', 70, 'Music softer under the claim'],
    ['five', 85, 'Hold the end card longer'],
  ])
    notes[name] = await add(frame, text);
  makeVideo(file, { w: 320, h: 180, fps: 25, dur: 4, pattern: 'testsrc2' });
  age(file);
  await api(`/api/review/${enc(slug)}/sync`, 'POST', {});
  for (const name of ['one', 'two', 'three', 'four', 'five'])
    await api(`/api/comments/${notes[name].id}`, 'PATCH', { status: 'fixed', note: 'done in V2', by: 'agent:promo-edit' });
  // on V2 (an open note on V1 would be carried over, to check again): a thread with Sam's reply and Mia's (no API writes as another person on this machine: the store says it)
  notes.talk = await api(`/api/review/${enc(slug)}/comments`, 'POST', { v: 2, frame: 95, text: 'Grade the sky warmer', severity: 'should' });
  await api(`/api/comments/${notes.talk.id}`, 'PATCH', { note: 'warmer, like the morning shots' });
  const reviewFile = path.join(dir, 'data', slug, 'review.json');
  const stored = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
  stored.comments
    .find((c) => c.id === notes.talk.id)
    .replies.push({ by: 'Mia Lang', text: 'Not too orange please', at: new Date(Date.now() - 60e3).toISOString() });
  fs.writeFileSync(reviewFile, JSON.stringify(stored, null, 2));
  const review = async () => (await api(`/api/review/${enc(slug)}`)).review;
  const note = async (id) => (await review()).comments.find((c) => c.id === id);
  await until(async () => (await note(notes.talk.id)).replies.length === 2, 'the store is read again');

  browser = await launch();
  page = await browser.newPage();
  screenshotFailures(() => page, 'thread');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `thread-${name}.png`) });
  const text = (sel) => page.$eval(sel, (e) => e.textContent.trim()).catch(() => null);
  const open = async (hash = '') => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${enc(slug)}${hash}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.side-scroll .note');
    await page.waitForFunction(() => document.querySelector('.vbox video')?.readyState >= 2, { timeout: 20000 });
  };
  const card = (id) => `.side-scroll [data-note="${id}"]`;
  const openCard = async (id) => {
    if (!(await page.$(`${card(id)}.active`))) await page.click(`${card(id)} .nr`);
    await page.waitForSelector(`${card(id)}.active`);
  };
  const ctrlEnter = async () => {
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');
  };
  const checkCard = () => text('.verify');
  const counter = () => text('.verify-head .eyebrow');

  await check('a fix reopened on its card in the panel leaves check mode at once; the card keeps the fix it is on', async () => {
    await page.setViewport({ width: 1440, height: 900 });
    await open(`?verify=${notes.one.id}`);
    await until(async () => /Swoosh on the first title/.test((await checkCard()) || ''), 'check mode on the first fix');
    assert((await counter()) === 'Check 1 / 5', `starts at 1 of 5: ${await counter()}`);
    // the third fix opened in the panel: while check mode runs, its card over the picture asks Looks right · Still
    // wrong, and this one says where the note stands without asking again (one decision on screen, not two)
    await openCard(notes.three.id);
    assert(!(await page.$(`${card(notes.three.id)} [data-testid=check-decision]`)), 'no second decision row in the panel while check mode runs');
    assert((await page.$$('[data-testid=check-decision]')).length === 1, 'one decision on screen: the check card’s');
    // reopened from the panel all the same, with a reply that reopens it
    await page.click(`${card(notes.three.id)} .reply-stub`);
    await page.waitForSelector(`${card(notes.three.id)} [data-testid=send-reopen]`);
    await page.type(`${card(notes.three.id)} .note-editor textarea`, 'the sfx can be louder');
    await shot('panel-still-wrong-1440');
    await page.click(`${card(notes.three.id)} [data-testid=send-reopen]`);
    await until(async () => (await note(notes.three.id)).status === 'open', 'reopened on the server');
    // at once on the check card: still the first fix, and the reopened one counted as done
    await until(
      async () => (await counter()) === 'Check 2 / 5',
      async () => `the queue moved on: ${await counter()}`,
    );
    assert(/Swoosh on the first title/.test((await checkCard()) || ''), 'the card keeps the fix it is on');
    // check the rest: the reopened one never comes up
    const seen = [];
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => document.activeElement?.blur());
      const before = await checkCard();
      seen.push(before);
      await page.keyboard.press('y');
      await until(async () => (await checkCard()) !== before, 'on to the next fix');
    }
    assert(!seen.some((s) => /A subtle sound/.test(s || '')), `the reopened fix never came up: ${seen.join(' / ')}`);
    assert(/Hold the end card longer/.test((await checkCard()) || '') && (await counter()) === 'Check 5 / 5', `the last one: ${await counter()}`);
  });

  await check('a fix reopened in check mode shows on its card in the panel at once', async () => {
    // check mode is on the fifth fix, whose card is open in the panel: the decision is the check card's alone
    await page.waitForSelector(`${card(notes.five.id)}.active`);
    assert(!(await page.$(`${card(notes.five.id)} [data-testid=check-decision]`)), 'the panel’s card asks nothing while check mode runs');
    await page.keyboard.press('n');
    await page.waitForSelector('.verify [data-testid=verify-reason] input');
    await page.type('.verify [data-testid=verify-reason] input', 'still too short');
    await page.keyboard.press('Enter');
    await until(async () => !(await page.$('.verify')), 'every fix answered: check mode closes');
    // no reload: the panel's card says it was reopened, with the reason, and asks for no decision any more
    await until(
      async () => /reopened it/.test((await text(`${card(notes.five.id)} .thread`)) || ''),
      async () => `the card's thread: ${await text(`${card(notes.five.id)} .thread`)}`,
    );
    assert(/still too short/.test((await text(`${card(notes.five.id)} .thread`)) || ''), 'with its reason');
    assert(!(await page.$(`${card(notes.five.id)} [data-testid=check-decision]`)), 'no decision row on an open note');
    assert((await note(notes.five.id)).status === 'open', 'reopened on the server');
    assert((await note(notes.one.id)).status === 'verified' && (await note(notes.three.id)).status === 'open', 'the others as they were answered');
  });

  // a fresh fixed note for the reply checks (the ones above are answered)
  const fresh = await add(60, 'Whoosh a bit louder');
  const layoutFix = await add(65, 'Cut the second beat');
  await api(`/api/comments/${layoutFix.id}`, 'PATCH', { status: 'fixed', note: 'cut', by: 'agent:promo-edit' });
  await api(`/api/comments/${fresh.id}`, 'PATCH', { status: 'fixed', note: 'raised 3 dB', by: 'agent:promo-edit' });

  await check('a fix to check: one decision row, the reply field below it; a reply leaves it waiting, "Send and reopen" reopens', async () => {
    await page.setViewport({ width: 1440, height: 900 });
    await open();
    await openCard(fresh.id);
    const c = card(fresh.id);
    const box = await page.$eval(c, (el) => {
      const r = (s) => el.querySelector(s)?.getBoundingClientRect().toJSON() ?? null;
      return { card: r('.note-body'), row: r('[data-testid=check-decision]'), stub: r('.reply-stub'), stubText: el.querySelector('.reply-stub')?.textContent };
    });
    assert(box.row && box.stub, `a decision row and a reply field: ${JSON.stringify(box)}`);
    assert(box.stub.top >= box.row.bottom, 'the reply field is below the decision row');
    assert(Math.abs(box.stub.width - box.card.width) <= 2, `the reply field is full width: ${box.stub.width} of ${box.card.width}`);
    assert(box.stubText === 'Reply without changing the status…', `it says what it does: ${box.stubText}`);
    // a plain reply (⌘↵): the fix still waits to be checked
    await page.click(`${c} .reply-stub`);
    await page.waitForSelector(`${c} .note-editor textarea`);
    const editor = await page.$eval(`${c} .note-editor`, (e) => ({
      placeholder: e.querySelector('textarea').placeholder,
      reply: e.querySelector('[data-testid=send-reply]')?.textContent.trim(),
      keys: e.querySelector('[data-testid=send-reply]')?.dataset.keys,
      reopen: e.querySelector('[data-testid=send-reopen]')?.textContent.trim(),
    }));
    assert(
      editor.placeholder === 'Reply without changing the status' &&
        editor.reply === 'Send as reply' &&
        editor.keys === '⌘↵' &&
        editor.reopen === 'Send and reopen',
      `both ways to send, named: ${JSON.stringify(editor)}`,
    );
    await page.keyboard.type('a touch louder still?');
    await shot('reply-choice-1440');
    await ctrlEnter();
    await until(async () => (await note(fresh.id)).replies.some((r) => r.text === 'a touch louder still?'), 'the reply saved');
    const after = await note(fresh.id);
    assert(after.status === 'fixed' && !after.replies.at(-1).status, `a reply changes no status: ${after.status}`);
    // The server has it; the page closes the editor (the stub comes back) once its own answer arrives, which on a busy
    // machine is after the server's copy was read above. Then the card still asks for a decision.
    await page.waitForSelector(`${c} .reply-stub`, { visible: true });
    assert(await page.$(`${c} [data-testid=check-decision]`), 'the decision row stays: the fix still waits to be checked');
    // the same field, "Send and reopen": the words go as the reason
    await page.click(`${c} .reply-stub`);
    await page.waitForSelector(`${c} .note-editor textarea`);
    await page.keyboard.type('the sfx can be louder');
    await page.click(`${c} [data-testid=send-reopen]`);
    await until(async () => (await note(fresh.id)).status === 'open', 'reopened');
    const last = (await note(fresh.id)).replies.at(-1);
    assert(last.status === 'open' && last.text === 'the sfx can be louder', `the reason as agents read it: ${JSON.stringify(last)}`);
  });

  await check('the decision row, the reply field and the reason fit 390–1920 in both themes', async () => {
    const c = card(layoutFix.id);
    const out = await layoutMatrix(
      page,
      {
        'fix to check': async () => {
          await page.setViewport({ width: 1440, height: 900 });
          await open();
          await openCard(layoutFix.id);
          await page.waitForSelector(`${c} [data-testid=check-decision]`);
        },
        'reply on it': async () => {
          await page.click(`${c} .reply-stub`);
          await page.waitForSelector(`${c} [data-testid=send-reopen]`);
          await page.type(`${c} .note-editor textarea`, 'a reply that might be a reopen');
        },
        'still wrong': async () => {
          await page.keyboard.press('Escape');
          await page.$$eval(`${c} [data-testid=check-decision] button`, (bs) => bs.find((b) => b.textContent.includes('Still wrong'))?.click());
          await page.waitForSelector(`${c} [data-testid=verify-reason] input`);
        },
      },
      {
        widths: WIDTHS,
        each: async (width, theme) => {
          // nothing of the card sticks out of it
          const out = await page.$eval(c, (el) => {
            const r = el.getBoundingClientRect();
            return [...el.querySelectorAll('button, input, textarea')]
              .filter((x) => x.getClientRects().length && x.getBoundingClientRect().right > r.right + 0.5)
              .map((x) => `${x.className} "${x.textContent || x.getAttribute('placeholder')}"`);
          });
          assert(!out.length, `@${width} ${theme}: inside the card: ${out.join('; ')}`);
          if (width === 390 || width === 1440)
            await shot(
              `card-${theme}-${width}-${await page.$eval(c, (el) => (el.querySelector('[data-testid=verify-reason]') ? 'reason' : el.querySelector('[data-testid=send-reopen]') ? 'reply' : 'row'))}`,
            );
        },
      },
    );
    assert(!out.length, out.join('\n'));
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  });

  await check('on a phone, in the notes sheet: the decision row, the reply’s two sends and the reason fit the card', async () => {
    const c = card(layoutFix.id);
    const inside = (where) =>
      page.$eval(
        c,
        (el, where) => {
          const r = el.getBoundingClientRect();
          const right = Math.min(r.right, innerWidth);
          return [...el.querySelectorAll('button, input, textarea')]
            .filter((x) => x.getClientRects().length && x.getBoundingClientRect().right > right + 0.5)
            .map((x) => `${where}: ${x.className} "${x.textContent || x.getAttribute('placeholder')}"`);
        },
        where,
      );
    const problems = [];
    for (const theme of ['dark', 'light']) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
      await page.setViewport({ width: 390, height: 844 });
      await open();
      // the sheet opened (a tap: half), then flicked up all the way
      await page.click('.nsheet-handle');
      await page.waitForSelector('.nsheet-half');
      const h = await page.$eval('.nsheet-handle', (b) => {
        const r = b.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await page.mouse.move(h.x, h.y);
      await page.mouse.down();
      await page.mouse.move(h.x, h.y - 120, { steps: 4 });
      await page.mouse.up();
      await page.waitForSelector('.nsheet-full');
      await openCard(layoutFix.id);
      await page.$eval(c, (el) => el.scrollIntoView({ block: 'start' }));
      await settle(page);
      problems.push(...(await inside(`row ${theme}`)));
      await shot(`phone-${theme}-row`);
      await page.click(`${c} .reply-stub`);
      await page.waitForSelector(`${c} [data-testid=send-reopen]`);
      await page.type(`${c} .note-editor textarea`, 'a reply that might be a reopen');
      await page.$eval(c, (el) => el.scrollIntoView({ block: 'start' }));
      await settle(page);
      problems.push(...(await inside(`reply ${theme}`)));
      await shot(`phone-${theme}-reply`);
      await page.keyboard.press('Escape');
      await page.$$eval(`${c} [data-testid=check-decision] button`, (bs) => bs.find((b) => b.textContent.includes('Still wrong'))?.click());
      await page.waitForSelector(`${c} [data-testid=verify-reason] input`);
      await settle(page);
      problems.push(...(await inside(`reason ${theme}`)));
      await shot(`phone-${theme}-reason`);
    }
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    assert(!problems.length, problems.join('\n'));
  });

  await check('your own reply: edit it in place (⌘↵ saves, Esc cancels, then "edited"), delete it with Undo; not someone else’s', async () => {
    await page.setViewport({ width: 1440, height: 900 });
    await open();
    await openCard(notes.talk.id);
    const c = card(notes.talk.id);
    const msgs = await page.$$eval(`${c} [data-testid=reply]`, (els) =>
      els.map((e) => ({ who: e.querySelector('.msg-who b')?.textContent, own: e.classList.contains('own'), tools: !!e.querySelector('.msg-tools') })),
    );
    assert(msgs.length === 2, `two replies: ${JSON.stringify(msgs)}`);
    assert(msgs[0].who === 'Sam' && msgs[0].own && msgs[0].tools, `Sam's has a ⋯: ${JSON.stringify(msgs[0])}`);
    assert(msgs[1].who === 'Mia Lang' && !msgs[1].own && !msgs[1].tools, `Mia's has none: ${JSON.stringify(msgs[1])}`);
    const own = `${c} [data-testid=reply].own`;
    const editIt = async () => {
      await page.hover(own);
      await page.click(`${own} .msg-tools`);
      await page.waitForSelector('[role=menuitem]');
      const items = await page.$$eval('[role=menuitem]', (els) => els.map((e) => e.textContent.trim()));
      assert(items.join(' | ') === 'Edit reply | Delete reply', `its menu: ${items}`);
      await page.evaluate(() => [...document.querySelectorAll('[role=menuitem]')].find((e) => e.textContent.trim() === 'Edit reply')?.click());
      await page.waitForSelector(`${own} .reply-edit textarea`);
    };
    await editIt();
    assert((await page.$eval(`${own} .reply-edit textarea`, (t) => t.value)) === 'warmer, like the morning shots', 'its words, to change');
    await page.keyboard.type(' (not the dusk ones)');
    await page.keyboard.press('Escape');
    await until(async () => !(await page.$(`${own} .reply-edit`)), 'Esc cancels');
    assert((await text(`${own} p`)) === 'warmer, like the morning shots', 'nothing changed');
    await editIt();
    await page.$eval(`${own} .reply-edit textarea`, (t) => t.select());
    await page.keyboard.type('warmer, like the morning shots on the beach');
    await shot('reply-edit-1440');
    await ctrlEnter();
    await until(async () => (await note(notes.talk.id)).replies[0].text === 'warmer, like the morning shots on the beach', 'saved');
    await until(async () => (await text(`${own} .msg-edited`)) === 'edited', 'marked edited');
    assert((await text(`${own} p`)) === 'warmer, like the morning shots on the beach', 'the new words on the card');
    assert((await note(notes.talk.id)).replies[1].text === 'Not too orange please', 'Mia’s untouched');
    // delete: gone at once, back with Undo; again, and sent when the toast is closed
    const remove = async () => {
      await page.hover(own);
      await page.click(`${own} .msg-tools`);
      await page.waitForSelector('[role=menuitem]');
      await page.evaluate(() => [...document.querySelectorAll('[role=menuitem]')].find((e) => e.textContent.trim() === 'Delete reply')?.click());
      await until(async () => (await page.$$(`${c} [data-testid=reply]`)).length === 1, 'off the card at once');
    };
    await remove();
    await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid=toast]')]
        .find((t) => t.textContent.includes('Reply deleted'))
        ?.querySelectorAll('button')
        .forEach((b) => {
          if (b.textContent.trim() === 'Undo') b.click();
        }),
    );
    await until(async () => (await page.$$(`${c} [data-testid=reply]`)).length === 2, 'Undo brings it back');
    assert((await note(notes.talk.id)).replies.length === 2, 'nothing was sent');
    await remove();
    await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid=toast]')]
        .find((t) => t.textContent.includes('Reply deleted'))
        ?.querySelector('.toast-x')
        ?.click(),
    );
    await until(async () => (await note(notes.talk.id)).replies.length === 1, 'the delete, on the server');
    const left = (await note(notes.talk.id)).replies;
    assert(left[0].by === 'Mia Lang', `Mia's reply stays: ${JSON.stringify(left)}`);
    await settle(page);
    assert((await page.$$(`${c} [data-testid=reply]`)).length === 1, 'one reply on the card');
  });

  await check('a card keeps the room of its marked frame before the picture arrives: "Reply…" under it stays where it is', async () => {
    // the picture comes late (a busy server, a slow line): held back until the card is open and measured
    const p = await browser.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    try {
      await p.setViewport({ width: 1440, height: 900 });
      const held = [];
      let holding = true;
      await p.setRequestInterception(true);
      p.on('request', (r) => {
        if (holding && r.resourceType() === 'image' && r.url().includes('/data/')) held.push(r);
        else r.continue();
      });
      await p.goto(`${BASE}/#/v/${enc(slug)}`, { waitUntil: 'domcontentloaded' });
      const c = card(notes.talk.id);
      await p.waitForSelector(`${c} .nr`);
      await p.click(`${c} .nr`);
      await p.waitForSelector(`${c}.active .reply-stub`);
      const where = () =>
        p.$eval(c, (el) => {
          const img = el.querySelector('.c-thumb');
          return { stub: el.querySelector('.reply-stub').getBoundingClientRect().top, thumb: img.getBoundingClientRect().height, loaded: img.complete };
        });
      const before = await where();
      assert(!before.loaded, 'the picture is still on its way');
      holding = false;
      for (const r of held.splice(0)) r.continue();
      await p.waitForFunction((c) => document.querySelector(`${c} .c-thumb`)?.naturalWidth > 0, {}, c);
      const after = await where();
      assert(before.thumb > 0 && Math.abs(after.stub - before.stub) < 0.5, `nothing moves when it arrives: ${JSON.stringify({ before, after })}`);
    } finally {
      await p.close();
    }
  });

  await check('no page errors along the way', async () => {
    assert(!errors.length, errors.join(' | '));
  });
} catch (e) {
  crashed(e, srv);
} finally {
  await finish(LABEL, { browser, servers: [srv] });
}
