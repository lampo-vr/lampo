#!/usr/bin/env node
// covers: web/src/player/RangeControl.tsx web/src/player/rangeAction.ts web/src/player/rangeHint.ts
// covers: web/src/player/Timeline.tsx web/src/player/TimelineControls.tsx web/src/player/timelineView.ts
// covers: web/src/guest/GuestPlayer.tsx web/src/styles/range.css lib/range.ts
// covers: web/src/player/usePlayback.ts web/src/lib/seek.ts
// Browser end-to-end test of range notes ("from 0:12 to 0:14 the music is too loud"): a real server (local mode, temp
// store, free port) + headless Chrome. Hovering the timeline says that dragging marks a section (the hint, the cursor,
// ⇧ on the scrubber); dragging across the notes lane marks one and opens the composer on it, lit and ready to type; the
// composer's head is one chip — "→ …" makes a section, its menu moves the ends (I / O) naming the frames it uses —; I and
// O mark a section while playing without opening anything (the note gets exactly the frames shown, ffmpeg's frames), ↵
// writes a note on it, Esc clears it; the section's chip on the timeline and its menu; zoomed in, every frame is a cell to
// pick (ffmpeg's frame), its handles move by a cell, the overview pans, the zoom is remembered; the note draws as a bar
// with its range on hover; its card plays exactly the range (from its first frame, also with seeks still waiting in line;
// stopping on the out frame — the picture is ffmpeg's frame) or loops it without leaving it; a client marks a range the
// same way through a review link; a phone presses, holds and drags. Screenshots land in VR_SHOTS when it is set.
import path from 'node:path';
import { age, makeVideo, sleep, until } from '../lib/helpers.ts';
import { bentEdges, clippedText, sideways } from './layout.mjs';
import { jsonApi } from './lib/api.mjs';
import { launch, requireChrome, shotsDir } from './lib/browser.mjs';
import { assert, check, crashed, finish, screenshotFailures } from './lib/checks.mjs';
import { closestFrame, playedThrough, recordedFrames, recordFrames, shownPicture } from './lib/frames.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'range e2e';
requireChrome(LABEL);
const SHOTS = shotsDir();
const srv = await startServer({ prefix: 'vr-range-e2e-', user: 'Sam' });
const { dir, base: BASE } = srv;

const api = jsonApi(BASE);

// The timeline's rows (Timeline.tsx): the perforation strip, the ruler, then the notes lane — ranges are drawn from
// its upper part (the bars sit in the lower part, on one or two rows).
const LANE_Y = 10 + 16 + 5;
const BAR_Y = 10 + 16 + 18;
const FPS = 30;
const N = 120;

// The composer's head (the moment and its action): whatever it holds is whole and inside it — never "F…", never an
// action running out of the box. Squeezed to nothing counts as cut; only what isn't rendered at all is left out.
const cutInHead = (page, composer) =>
  page.$$eval(`${composer} .composer-head`, (rows) =>
    rows.flatMap((head) => {
      const box = head.getBoundingClientRect();
      return [...head.querySelectorAll('*')]
        .filter((e) => {
          if (!e.getClientRects().length) return false;
          const r = e.getBoundingClientRect();
          const cut = e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible';
          return cut || r.right > box.right + 1 || r.left < box.left - 1;
        })
        .map((e) => `${e.className?.baseVal ?? e.className ?? e.tagName} "${e.textContent}"`);
    }),
  );

let browser;
let page;
screenshotFailures(() => page, 'range');
try {
  const W = 320;
  const H = 180;
  // testsrc2 moves every frame, so neighbouring frames differ and a picture names its frame.
  const video = makeVideo(path.join(dir, 'Spot/export/stretch.mp4'), { w: W, h: H, fps: FPS, dur: N / FPS, pattern: 'testsrc2' });
  age(video);
  const { video: summary } = await api('/api/library', 'POST', { path: video });
  const slug = summary.slug;

  browser = await launch();
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: SHOTS ? 2 : 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));
  const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  const videoReady = () =>
    page.waitForFunction(
      () => {
        const v = document.querySelector('.vbox video');
        return v && v.readyState >= 2 && !v.seeking;
      },
      { polling: 100, timeout: 20000 },
    );
  const openPlayer = async (frame) => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/v/${encodeURIComponent(slug)}${frame !== undefined ? `?f=${frame}` : ''}`, { waitUntil: 'domcontentloaded' });
    await videoReady();
    await page.waitForSelector('.timeline canvas');
    await sleep(400);
  };
  const shownFrame = () => page.$eval('.tc .sub b', (e) => Number(e.textContent));
  // A note is a row until it is selected: its card (the range's chip, play and loop) opens in place on a click.
  const openNote = async (words) => {
    await page.waitForFunction((w) => [...document.querySelectorAll('.side-scroll .note')].some((n) => n.textContent.includes(w)), { timeout: 10000 }, words);
    await page.evaluate((w) => {
      const n = [...document.querySelectorAll('.side-scroll .note')].find((e) => e.textContent.includes(w));
      if (!n.classList.contains('active')) n.querySelector('.nr')?.click();
    }, words);
    await page.waitForFunction(
      (w) => [...document.querySelectorAll('.side-scroll .note.active')].some((n) => n.textContent.includes(w)),
      { timeout: 5000 },
      words,
    );
  };
  const timeline = () =>
    page.$eval('.timeline canvas', (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
  // The middle of frame f on an unzoomed timeline.
  const xOf = (tl, f) => tl.x + ((f + 0.5) * tl.w) / N;

  // The picture on screen, small and grey, against ffmpeg's frames around the one the player claims to show.
  const grabPicture = () => shownPicture(page);
  const closest = (pixels, n) => {
    const best = closestFrame(video, pixels, n, N, 2);
    return { k: best.k, why: best.line };
  };
  // The frame a range started on, from a recording made while the playhead was past it: the first frame reported inside
  // the range, less the frames presented before it that no callback reported. A busy main thread can run its next
  // rendering step only after the start frame has been replaced, although it was on screen: Chrome puts it up as the
  // seek lands, before the clock starts (40–75 ms in a trace at 6× CPU throttling, the main thread's first step after
  // the seek at 54–77 ms). A frame dropped on the way doesn't count as shown.
  const startOf = (frames, range) => {
    const i = frames.findIndex((x) => x.f <= range.out);
    if (i < 1) return { f: null, why: `no frame before the range to start from (${JSON.stringify(frames.slice(0, 3))})` };
    const [before, first] = [frames[i - 1], frames[i]];
    const unseen = first.pf - before.pf - 1;
    const dropped = first.dropped - before.dropped;
    return {
      f: dropped ? null : first.f - unseen,
      at: i,
      why: `from f${before.f}, the first frame reported f${first.f}, ${unseen} presented unreported before it, ${dropped} dropped`,
    };
  };
  const saveComposer = async () => {
    await page.keyboard.down('Meta');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Meta');
    await page.waitForFunction(() => !document.querySelector('.composer'), { polling: 100, timeout: 20000 });
  };
  const review = async () => (await api(`/api/review/${encodeURIComponent(slug)}`)).review;
  // A menu's items as shown: their words, their key and whether they can be picked.
  const menuItems = () =>
    page.$$eval('.menu[data-state=open] [role^=menuitem]', (els) =>
      els.map((e) => ({
        label: e.querySelector('.grow')?.textContent.trim() ?? '',
        key: e.querySelector('.menu-kbd')?.textContent ?? null,
        disabled: e.hasAttribute('data-disabled'),
      })),
    );
  // (a phone's menu is a sheet that slides up: its items take a tap once it is in place)
  const settled = () =>
    page.$eval('.menu[data-state=open]', (e) => Promise.all(e.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {})))).catch(() => {});
  const openMenu = async (trigger) => {
    await page.click(trigger);
    await page.waitForSelector('.menu[data-state=open] [role^=menuitem]');
    await settled();
    return menuItems();
  };
  const closeMenu = async () => {
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.menu'), { polling: 50, timeout: 3000 });
  };
  const pickItem = async (label) => {
    const item = await page.evaluateHandle(
      (label) => [...document.querySelectorAll('.menu[data-state=open] [role^=menuitem]')].find((e) => e.querySelector('.grow')?.textContent.trim() === label),
      label,
    );
    assert(item.asElement(), `the menu offers "${label}": ${JSON.stringify(await menuItems())}`);
    await item.asElement().click();
    await page.waitForFunction(() => !document.querySelector('.menu'), { polling: 50, timeout: 3000 });
  };
  // The playhead to frame f by a click on the waveform (the whole video on the timeline): no lane, no handle, no chip.
  const seekTo = async (f) => {
    const tl = await timeline();
    await page.mouse.click(xOf(tl, f), tl.y + 66);
    await until(async () => (await shownFrame()) === f, `playhead on f${f}`);
  };
  // The player's where-menu: "Only the first frame, …" takes a range's end off (the head's × is Cancel).
  const firstFrameOnly = async () => {
    await page.click('.composer [data-testid=composer-where]');
    await page.waitForSelector('.menu[data-state=open] [role^=menuitem]');
    const item = await page.evaluateHandle(() =>
      [...document.querySelectorAll('.menu[data-state=open] [role^=menuitem]')].find((e) => e.textContent.trim().startsWith('Only the first frame')),
    );
    assert(item.asElement(), 'the where-menu offers "Only the first frame"');
    await item.asElement().click();
    await page.waitForFunction(() => !document.querySelector('.menu[data-state=open]'), { polling: 50, timeout: 3000 });
  };

  console.log(`range e2e against ${BASE} (store ${dir})`);
  let drawn = null;
  let clientToken = '';

  await check('hovering the timeline says that dragging marks a section: the hint and the cursor, ⇧ on the scrubber', async () => {
    await openPlayer(0);
    const tl = await timeline();
    const said = () =>
      page.evaluate(() => ({
        tip: document.querySelector('[data-testid=tl-tip]')?.textContent ?? null,
        cursor: document.querySelector('.timeline canvas').style.cursor,
      }));
    await page.mouse.move(xOf(tl, 30), tl.y + LANE_Y);
    await until(async () => (await said()).tip === 'Drag to mark a section', 'the hint over the notes lane');
    assert((await said()).cursor === 'crosshair', `a crosshair over the lane: ${(await said()).cursor}`);
    // on the scrubber (the waveform) a plain drag scrubs: the hint names ⇧, and ⇧ held turns the cursor too
    await page.mouse.move(xOf(tl, 30), tl.y + 70);
    await until(async () => (await said()).tip === '⇧ drag to mark a section', 'the ⇧ hint over the scrubber');
    assert((await said()).cursor === 'col-resize', `scrubbing cursor: ${(await said()).cursor}`);
    await page.keyboard.down('Shift');
    await until(
      async () => (await said()).cursor === 'crosshair' && (await said()).tip === 'Drag to mark a section',
      '⇧ held: the crosshair and the plain hint',
    );
    await page.keyboard.up('Shift');
    await until(async () => (await said()).cursor === 'col-resize', '⇧ let go: scrubbing again');
    const label = await page.$eval('[data-testid=tl-hover]', (e) => e.textContent);
    assert(/^00:01:00 · f30$/.test(label), `what is under the pointer stays the frame: ${label}`);
    await shot('range-00-hint');
  });

  await check('dragging across the notes lane marks a range and opens the composer for it, lit and ready to type', async () => {
    await openPlayer(0);
    const tl = await timeline();
    const hover = () => page.$eval('[data-testid=tl-hover]', (e) => e.textContent);
    await page.mouse.move(xOf(tl, 30), tl.y + LANE_Y);
    await page.mouse.down();
    // let go whatever happens: a button still down fails the next check's first press
    try {
      await page.mouse.move(xOf(tl, 45), tl.y + LANE_Y, { steps: 6 });
      await page.mouse.move(xOf(tl, 60), tl.y + LANE_Y, { steps: 6 });
      // a move's hover is drawn by the render after it, which a busy machine runs after the move has been sent
      await until(
        async () => /00:01:00 → 00:02:00 · 1\.0 s/.test(await hover()),
        async () => `the drag names its range: ${await hover()}`,
      );
      await shot('range-01-drag');
    } finally {
      await page.mouse.up();
    }
    await page.waitForSelector('.composer textarea');
    const ctl = await page.$eval('.composer [data-testid=range-ctl]', (e) => e.textContent);
    assert(ctl.includes('00:01:00 → 00:02:00'), `the composer shows the range: ${ctl}`);
    const cut = await cutInHead(page, '.composer');
    assert(!cut.length, `nothing in the composer's head is cut: ${cut.join(', ')}`);
    const ph = await page.$eval('.composer textarea', (e) => e.placeholder);
    assert(ph.startsWith('What should change in this section?'), ph);
    await until(async () => (await shownFrame()) === 30, 'the playhead at the range’s first frame');
    // the section is lit on the timeline while its note is written, its chip names it, and the text has the focus
    assert(await page.$('.timeline[data-writing]'), 'the section lit on the timeline');
    const mark = await page.$eval('[data-testid=tl-mark]', (e) => e.textContent);
    assert(mark.includes('00:01:00 → 00:02:00') && mark.includes('1.0 s'), `the timeline's chip: ${mark}`);
    assert(await page.evaluate(() => document.activeElement?.matches('.composer textarea')), 'ready to type: no click, no C');
    await page.keyboard.type('Musik zu laut');
    await sleep(200);
    await shot('range-02-composer');
    await saveComposer();
    const c = (await review()).comments.find((x) => x.text === 'Musik zu laut');
    assert(c, 'the note reached the store');
    assert(c.range && c.range.in === 30 && c.range.out === 60, `range ${JSON.stringify(c.range)}`);
    assert(c.frame === 30, `the note sits on the range’s first frame (f${c.frame})`);
    assert(c.shots?.range, 'a strip of frames across the range for agents');
    drawn = c.range;
    // Saved, the range is the note's: the timeline's in/out are free again.
    assert(!(await page.$('.composer')), 'composer closed');
  });

  await check('a quick drag whose release comes before its moves have drawn still ends the section where it was let go', async () => {
    await openPlayer(0);
    const tl = await timeline();
    // A busy machine draws a fast drag late: here the moves and the release reach the timeline in one task, before any
    // of the moves has rendered (CI's runner ended sections a frame or two short of the release).
    await page.evaluate(
      ({ xs, y }) => {
        const canvas = document.querySelector('.timeline canvas');
        const send = (type, x, buttons) =>
          canvas.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              composed: true,
              pointerId: 1,
              pointerType: 'mouse',
              isPrimary: true,
              button: 0,
              buttons,
              clientX: x,
              clientY: y,
            }),
          );
        send('pointerdown', xs[0], 1);
        for (const x of xs.slice(1)) send('pointermove', x, 1);
        send('pointerup', xs.at(-1), 0);
      },
      { xs: [70, 75, 80, 85, 90].map((f) => xOf(tl, f)), y: tl.y + LANE_Y },
    );
    await page.waitForSelector('.composer [data-testid=range-ctl]', { timeout: 5000 });
    const ctl = await page.$eval('.composer [data-testid=range-ctl]', (e) => e.textContent);
    assert(ctl.includes('00:02:10 → 00:03:00'), `the section ends on the frame it was let go on (f90): ${ctl}`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.composer'), { polling: 100, timeout: 5000 });
  });

  await check('dragging an end of the range shows that frame on the stage; letting go shows the range’s start again', async () => {
    await openPlayer(0);
    const tl = await timeline();
    // a stretch with no note on it yet (the first check's note sits on 30–60)
    await page.mouse.move(xOf(tl, 70), tl.y + LANE_Y);
    await page.mouse.down();
    await page.mouse.move(xOf(tl, 90), tl.y + LANE_Y, { steps: 8 });
    await page.mouse.up();
    await page.waitForSelector('.composer textarea');
    await until(async () => (await shownFrame()) === 70, 'at the range’s start');
    // the end's grip sits on the boundary after its last frame, in the perforation strip
    await page.mouse.move(tl.x + (91 * tl.w) / N, tl.y + 4);
    await page.mouse.down();
    // let go whatever happens: a button still down fails the next check's first click
    try {
      await page.mouse.move(xOf(tl, 105), tl.y + 4, { steps: 10 });
      await until(async () => Math.abs((await shownFrame()) - 105) <= 1, 'the stage shows the end being dragged (F105)');
      // while an end moves, the hover names the section as it is now (its chip steps aside)
      const moving = await page.$eval('[data-testid=tl-hover]', (e) => e.textContent);
      assert(/^00:02:10 → 00:03:1[4-6] · /.test(moving), `the hover names the section while its end moves: ${moving}`);
      assert(!(await page.$('[data-testid=tl-mark]')), 'the chip steps aside while an end is dragged');
    } finally {
      await page.mouse.up();
    }
    await until(async () => (await shownFrame()) === 70, 'let go: the range’s start again (F70)');
    const ctl = await page.$eval('.composer [data-testid=range-ctl]', (e) => e.textContent);
    assert(/00:02:10 → 00:03:1[4-6]/.test(ctl), `the range kept its new end: ${ctl}`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.composer'), { polling: 100, timeout: 5000 });
  });

  await check('the note draws as a bar; hover names both ends, the length and the note', async () => {
    const tl = await timeline();
    await page.mouse.move(xOf(tl, 45), tl.y + BAR_Y);
    await page.waitForFunction(() => document.querySelector('[data-testid=tl-hover]')?.textContent.includes('Musik'), { timeout: 5000 });
    const hover = await page.$eval('[data-testid=tl-hover]', (e) => e.textContent);
    assert(hover.startsWith('00:01:00 → 00:02:00 · 1.0 s · Musik zu laut'), hover);
    // its row: where it starts and, at the end, how long it is
    const row = await page.evaluate(() => {
      const n = [...document.querySelectorAll('.side-scroll .note-row')].find((e) => e.textContent.includes('Musik zu laut'));
      return n ? { tc: n.querySelector('.nr-tc')?.textContent, len: n.querySelector('.nr-len')?.textContent } : null;
    });
    assert(row?.tc === '00:01:00' && row.len === '1.0 s', `the row: ${JSON.stringify(row)}`);
    await openNote('Musik zu laut');
    const chip = await page.$eval('.note.active [data-testid=note-range]', (e) => e.textContent);
    assert(chip.includes('00:01:00 → 00:02:00') && chip.includes('1.0 s'), `the card’s chip: ${chip}`);
    await shot('range-03-bar-and-card');
  });

  await check('the composer’s head is one chip: "→ end" makes a section, its menu moves the ends (I / O) by the frames it names', async () => {
    await openPlayer(75);
    await page.keyboard.press('c');
    await page.waitForSelector('.composer [data-testid=range-add]');
    // the drawing tools (on the picture) and the toolbar under the text stay where they are when a section comes,
    // changes or goes: the head keeps one line; measured once the composer has finished popping in
    const toolsAt = async () => {
      await page.$eval('.composer', (e) => Promise.all(e.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {}))));
      return page.evaluate(() => ({
        tools: document.querySelector('[data-testid=draw-bar]').getBoundingClientRect().toJSON(),
        foot: document.querySelector('.composer .composer-foot').getBoundingClientRect().toJSON(),
      }));
    };
    const stayed = (a, b, when) => {
      for (const k of ['tools', 'foot'])
        assert(
          Math.abs(a[k].x - b[k].x) < 1 && Math.abs(a[k].y - b[k].y) < 1,
          `${when}: the ${k === 'foot' ? 'toolbar under the text' : 'drawing tools'} didn't move: ${JSON.stringify({ before: a[k], after: b[k] })}`,
        );
    };
    const ghost = () => page.$eval('.timeline', (e) => e.dataset.ghost ?? null);
    const ctl = () => page.$eval('.composer [data-testid=range-ctl]', (e) => e.textContent);
    const before = await toolsAt();
    // One frame: the quiet "→ 00:03:15" beside the chip names the frame a second later — drawn on the timeline first.
    const add = await page.$eval('.composer [data-testid=range-add]', (e) => ({
      label: e.getAttribute('aria-label'),
      text: e.textContent.replace(/\s+/g, ''),
    }));
    assert(add.label === 'Until 00:03:15' && add.text === '→00:03:15', `the affordance names its frame: ${JSON.stringify(add)}`);
    const head = await page.$eval('.composer .composer-head', (e) => e.getBoundingClientRect().height);
    await page.hover('.composer [data-testid=range-add]');
    await until(async () => (await ghost()) === '75-105', 'the timeline shows the section it would make');
    await page.click('.composer [data-testid=range-add]');
    await page.waitForSelector('.composer [data-testid=range-ctl]');
    assert((await ctl()).includes('00:02:15 → 00:03:15'), `a second from the playhead: ${await ctl()}`);
    assert(!(await page.$('.composer [data-testid=range-add]')), 'a section: the chip says it all, no second button');
    const cut = await cutInHead(page, '.composer');
    assert(!cut.length, `nothing in the composer's head is cut: ${cut.join(', ')}`);
    assert(Math.abs((await page.$eval('.composer .composer-head', (e) => e.getBoundingClientRect().height)) - head) < 1, 'the head keeps one line');
    stayed(before, await toolsAt(), 'a section came');
    // On its first frame its menu has nothing to move: it says what to do.
    let items = await openMenu('.composer [data-testid=composer-where]');
    const hint = items.find((x) => x.label === 'Step to a new end');
    assert(hint?.disabled, `on the first frame: a line saying what to do: ${JSON.stringify(items)}`);
    await closeMenu();
    // Pointing at the chip lights the note's section on the timeline.
    await page.hover('.composer [data-testid=composer-where]');
    await until(async () => (await page.$eval('.timeline', (e) => e.dataset.lit)) === 'true', 'the note’s section lit on the timeline');
    // The playhead moves on: the menu's "End at" names that frame (O), and sets that frame.
    await seekTo(95);
    items = await openMenu('.composer [data-testid=composer-where]');
    const end = items.find((x) => x.label.startsWith('End at'));
    assert(end?.label === 'End at 00:03:05' && end.key === 'O', `names the playhead’s frame and its key: ${JSON.stringify(items)}`);
    assert(
      items.some((x) => x.label === 'Only the first frame, 00:02:15') && items.some((x) => x.label === 'About the whole video'),
      `and the rest of "about what": ${JSON.stringify(items)}`,
    );
    await pickItem('End at 00:03:05');
    await until(async () => (await ctl()).includes('00:02:15 → 00:03:05'), 'the end moved to f95');
    // On its last frame: nothing to move, said so.
    items = await openMenu('.composer [data-testid=composer-where]');
    assert(items.find((x) => x.label === 'Ends on this frame')?.disabled, `on the last frame: ${JSON.stringify(items)}`);
    await closeMenu();
    // Before the start: "Start at" that frame (I) — and I / O do the same from the keyboard, the composer following.
    await seekTo(70);
    items = await openMenu('.composer [data-testid=composer-where]');
    const start = items.find((x) => x.label.startsWith('Start at'));
    assert(start?.label === 'Start at 00:02:10' && start.key === 'I', JSON.stringify(items));
    await closeMenu();
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('i');
    await until(async () => (await ctl()).includes('00:02:10 → 00:03:05'), 'I starts it here');
    await seekTo(98);
    await page.keyboard.press('o');
    await until(async () => (await ctl()).includes('00:02:10 → 00:03:08'), 'O ends it here');
    await until(async () => (await page.$eval('[data-testid=tl-mark]', (e) => e.textContent)).includes('00:02:10 → 00:03:08'), 'the timeline’s chip follows');
    await page.type('.composer textarea', 'Schnitt zu hart');
    await saveComposer();
    const c = (await review()).comments.find((x) => x.text === 'Schnitt zu hart');
    assert(c?.range?.in === 70 && c.range.out === 98, `range ${JSON.stringify(c?.range)}`);
    assert(c.frame === 70, `without a drawing the note sits on its range’s first frame (f${c.frame})`);
    // "Only the first frame" (the chip's menu: the head's × is Cancel) takes the end off and goes to that frame.
    await openPlayer(40);
    await page.keyboard.press('c');
    await page.waitForSelector('.composer [data-testid=range-add]');
    await page.click('.composer [data-testid=range-add]');
    await page.waitForSelector('.composer [data-testid=range-ctl]');
    await seekTo(60);
    await firstFrameOnly();
    await page.waitForSelector('.composer [data-testid=range-add]');
    assert(!(await page.$('.composer [data-testid=range-ctl]')), 'one frame again');
    await until(async () => (await shownFrame()) === 40, 'the player went to the note’s first frame');
    assert(!(await ghost()), 'no ghost left behind');
    await page.keyboard.press('Escape');
  });

  await check('I and O mark a section while playing, nothing opens; its chip names it; C writes a note on exactly those frames', async () => {
    await openPlayer(0);
    // what the transport's frame counter said at the moment each key went down (the app's frame on screen)
    await page.evaluate(() => {
      window.__marks = {};
      window.addEventListener(
        'keydown',
        (e) => {
          if (e.key === 'i' || e.key === 'o') window.__marks[e.key] = Number(document.querySelector('.tc .sub b').textContent);
        },
        { capture: true },
      );
    });
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press(' ');
    await page.waitForFunction(() => !document.querySelector('.vbox video').paused, { timeout: 5000 });
    await sleep(700);
    await page.keyboard.press('i');
    await sleep(900);
    await page.keyboard.press('o');
    await sleep(200);
    assert(!(await page.$('.composer')), 'marking opens nothing');
    await page.keyboard.press(' ');
    await page.waitForFunction(() => document.querySelector('.vbox video').paused, { timeout: 5000 });
    const marks = await page.evaluate(() => window.__marks);
    assert(marks.i > 5 && marks.o > marks.i + 10, `marked while playing: ${JSON.stringify(marks)}`);
    const tc = (f) => `00:${String(Math.floor(f / FPS)).padStart(2, '0')}:${String(f % FPS).padStart(2, '0')}`;
    // the section on the timeline with its chip; the transport's I and O are on, and the row stays one row
    await until(
      async () => (await page.$eval('[data-testid=tl-mark]', (e) => e.textContent).catch(() => '')).includes(`${tc(marks.i)} → ${tc(marks.o)}`),
      'the chip names the section',
    );
    const io = await page.$$eval('[data-testid=mark-in], [data-testid=mark-out]', (els) => els.map((e) => e.getAttribute('aria-pressed')));
    assert(io.join() === 'true,true', `I and O show they are set: ${io}`);
    await shot('range-03a-marked');
    await page.keyboard.press('c');
    await page.waitForSelector('.composer [data-testid=range-ctl]');
    const ctl = await page.$eval('.composer [data-testid=range-ctl]', (e) => e.textContent);
    assert(ctl.includes(`${tc(marks.i)} → ${tc(marks.o)}`), `C: the note is about the marked section (${ctl})`);
    await page.keyboard.type('Zu früh ausgeblendet');
    await saveComposer();
    const c = (await review()).comments.find((x) => x.text === 'Zu früh ausgeblendet');
    assert(
      c?.range?.in === marks.i && c.range.out === marks.o,
      `the note's frames are the ones shown at I and O: ${JSON.stringify(c?.range)} vs ${JSON.stringify(marks)}`,
    );
    // and those frames are ffmpeg's: the picture at each end of the section
    for (const f of [c.range.in, c.range.out]) {
      await openPlayer(f);
      const best = closest(await grabPicture(), f);
      assert(best.k === f, `at f${f} the picture is ffmpeg frame ${best.k} (${best.why})`);
    }
  });

  await check('↵ writes a note on a marked section; Esc clears the section', async () => {
    await openPlayer(20);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('i');
    await seekTo(50);
    await page.keyboard.press('o');
    await page.waitForSelector('[data-testid=tl-mark]');
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Enter');
    await page.waitForSelector('.composer [data-testid=range-ctl]');
    assert((await page.$eval('.composer [data-testid=range-ctl]', (e) => e.textContent)).includes('00:00:20 → 00:01:20'), '↵: a note on it');
    // Esc with nothing written closes the composer: a section marked with I and O stays for looping or another note
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.composer'), { polling: 100, timeout: 5000 });
    assert(await page.$('[data-testid=tl-mark]'), 'the section stays when its note is cancelled');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-testid=tl-mark]'), { polling: 100, timeout: 5000 });
    const io = await page.$$eval('[data-testid=mark-in], [data-testid=mark-out]', (els) => els.map((e) => e.getAttribute('aria-pressed')));
    assert(io.join() === 'false,false', `Esc cleared it: ${io}`);
  });

  await check('the section’s chip on the timeline: write a note (C), move an end (I / O), zoom to it (Z), clear it (Esc)', async () => {
    await openPlayer(30);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('i');
    await seekTo(45);
    await page.keyboard.press('o');
    await seekTo(60);
    const items = await openMenu('[data-testid=tl-mark]');
    const keyOf = (label) => items.find((x) => x.label === label)?.key;
    assert(keyOf('Write a note on it') === 'C', JSON.stringify(items));
    assert(keyOf('End at 00:02:00') === 'O', `the end moves to the frame on screen, named: ${JSON.stringify(items)}`);
    assert(keyOf('Zoom to it') === 'Z' && keyOf('Clear the section') === 'Esc', JSON.stringify(items));
    await pickItem('End at 00:02:00');
    await until(async () => (await page.$eval('[data-testid=tl-mark]', (e) => e.textContent)).includes('00:01:00 → 00:02:00'), 'the end moved');
    await openMenu('[data-testid=tl-mark]');
    await pickItem('Zoom to it');
    await until(async () => !!(await page.$eval('.timeline', (e) => e.dataset.view ?? '')), 'zoomed');
    const [a, b] = (await page.$eval('.timeline', (e) => e.dataset.view)).split('-').map(Number);
    assert(a < 30 && b > 61 && b - a < 50, `the window shows the section and a little around it: ${a}–${b}`);
    await openMenu('[data-testid=tl-mark]');
    await pickItem('Write a note on it');
    await page.waitForSelector('.composer [data-testid=range-ctl]');
    assert(await page.evaluate(() => document.activeElement?.matches('.composer textarea')), 'ready to type');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.composer'), { polling: 100, timeout: 5000 });
    await openMenu('[data-testid=tl-mark]');
    await pickItem('Clear the section');
    await page.waitForFunction(() => !document.querySelector('[data-testid=tl-mark]'), { polling: 100, timeout: 5000 });
    await page.keyboard.press('0');
    await until(async () => !(await page.$eval('.timeline', (e) => e.dataset.view ?? '')), 'fit again');
  });

  await check('zoomed in, every frame is a cell: pick one, O ends the section there (ffmpeg’s frame), a handle moves by one cell', async () => {
    await openPlayer(20);
    const level = () => page.$eval('[data-testid=tl-zoom-level]', (e) => e.textContent);
    assert((await level()) === 'Fit', `the control says the whole video: ${await level()}`);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('i');
    await seekTo(30);
    // Z with no end yet: about a second around the playhead, every frame a cell with its number
    await page.keyboard.press('z');
    await until(async () => !!(await page.$('.timeline[data-cells]')), 'frame cells');
    assert((await level()) === '30 frames', `the level says how many frames are across: ${await level()}`);
    const view = async () => (await page.$eval('.timeline', (e) => e.dataset.view)).split('-').map(Number);
    let [v0, v1] = await view();
    assert(30 >= v0 && 30 < v1, `around the playhead: ${v0}–${v1}`);
    const tl = await timeline();
    const cellX = (f) => tl.x + ((f + 0.5 - v0) * tl.w) / (v1 - v0);
    await shot('range-09-cells');
    // a cell is a frame: clicking the ruler's cell of f37 shows f37
    await page.mouse.click(cellX(37), tl.y + 18);
    await until(async () => (await shownFrame()) === 37, 'the picked cell’s frame');
    await videoReady();
    await sleep(300);
    const best = closest(await grabPicture(), 37);
    assert(best.k === 37, `the picked frame is ffmpeg frame ${best.k}, not 37 (${best.why})`);
    await page.keyboard.press('o');
    await until(
      async () => (await page.$eval('[data-testid=tl-mark]', (e) => e.textContent).catch(() => '')).includes('00:00:20 → 00:01:07'),
      'O ends the section on f37',
    );
    // the end's handle, taken at this zoom, moves one cell
    [v0, v1] = await view();
    const edge = tl.x + ((38 - v0) * tl.w) / (v1 - v0);
    await page.mouse.move(edge, tl.y + 4);
    await page.mouse.down();
    await page.mouse.move(cellX(38), tl.y + 4, { steps: 4 });
    await page.mouse.up();
    await until(async () => (await page.$eval('[data-testid=tl-mark]', (e) => e.textContent)).includes('00:00:20 → 00:01:08'), 'the end one frame later');
    // the overview: the whole video, the window a box to drag along it
    const over = { y: tl.y + tl.h - 4 };
    const box0 = await view();
    await page.mouse.move(tl.x + ((box0[0] + box0[1]) / 2 / N) * tl.w, over.y);
    await page.mouse.down();
    await page.mouse.move(tl.x + tl.w * 0.8, over.y, { steps: 5 });
    await page.mouse.up();
    const moved = await view();
    assert(
      moved[0] > box0[0] + 30 && Math.abs(moved[1] - moved[0] - (box0[1] - box0[0])) < 0.01,
      `dragging the overview's box moves the window: ${box0} → ${moved}`,
    );
    // the window is remembered for this video
    await sleep(800);
    await openPlayer(Math.round(moved[0]) + 2);
    await until(async () => (await page.$eval('.timeline', (e) => e.dataset.view ?? '')) !== '', 'the zoom comes back on this video');
    // ⇧Z: the whole video again
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.down('Shift');
    await page.keyboard.press('Z');
    await page.keyboard.up('Shift');
    await until(async () => (await level()) === 'Fit', '⇧Z fits');
    await page.keyboard.press('Escape');
  });

  await check('play range: starts on in, stops exactly on out, and the picture is ffmpeg’s out frame', async () => {
    await openPlayer(100);
    // opening its card puts the playhead on its first frame: away again, so playing the range starts with a seek
    await openNote('Musik zu laut');
    await page.evaluate(() => document.activeElement?.blur());
    await recordFrames(page, FPS);
    await page.keyboard.press('End');
    await until(async () => (await shownFrame()) > drawn.out, 'the playhead past the range');
    await until(async () => (await recordedFrames(page)).at(-1)?.f > drawn.out, 'the picture past the range');
    const from = (await recordedFrames(page)).length - 1;
    const card = `article.note:has([data-testid=note-range])`;
    await page.waitForSelector(`${card} [data-testid=range-play]`);
    const buttons = await page.$$('[data-testid=range-play]');
    const which = await Promise.all(buttons.map((b) => b.evaluate((e) => e.closest('article')?.textContent.includes('Musik zu laut'))));
    await buttons[which.indexOf(true)].click();
    await page.waitForFunction(() => !document.querySelector('.vbox video').paused, { timeout: 5000 });
    await page.waitForFunction(() => document.querySelector('.vbox video').paused, { timeout: 10000 });
    await videoReady();
    await sleep(300);
    const at = await shownFrame();
    assert(at === drawn.out, `stopped on f${at}, the range ends on f${drawn.out}`);
    const frames = (await recordedFrames(page)).slice(from);
    const start = startOf(frames, drawn);
    const played = frames.slice(start.at ?? 1).map((x) => x.f);
    assert(played.length > 10, `it played (${frames.length} frames: ${played.slice(0, 8).join(',')}…)`);
    assert(start.f === drawn.in, `started on f${start.f}, the range starts on f${drawn.in} (${start.why})`);
    const outside = played.filter((f) => f < drawn.in || f > drawn.out + 1);
    assert(!outside.length, `frames outside f${drawn.in}–f${drawn.out}: ${outside.join(',')}`);
    const best = closest(await grabPicture(), drawn.out);
    assert(best.k === drawn.out, `the picture is ffmpeg frame ${best.k}, not ${drawn.out} (${best.why})`);
  });

  await check('play range while seeks still wait in line: it starts on in all the same, not where the playhead was sent', async () => {
    await page.evaluate(() => document.activeElement?.blur());
    await recordFrames(page, FPS);
    await page.keyboard.press('ArrowRight');
    await until(async () => (await recordedFrames(page)).at(-1)?.f === drawn.out + 1, 'the picture one past the range');
    const from = (await recordedFrames(page)).length - 1;
    // Seeks that come while one is on its way wait in line (lib/seek.ts): End's seek starts, Home's waits behind it, and
    // the range is played before either has landed — in one task, so it doesn't depend on the machine's speed. A seek
    // still waiting landed after the range's own and played it from f0.
    await page.evaluate(() => {
      const key = (k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      key('End');
      key('Home');
      [...document.querySelectorAll('[data-testid=range-play]')].find((b) => b.closest('article')?.textContent.includes('Musik zu laut')).click();
    });
    await page.waitForFunction(() => document.querySelector('.vbox video').paused, { timeout: 10000 });
    await until(
      async () => (await shownFrame()) === drawn.out,
      async () => `stopped on the range's last frame (f${drawn.out}), not f${await shownFrame()}`,
    );
    const still = (out) => {
      const v = document.querySelector('.vbox video');
      return v.paused && !v.seeking && v.readyState >= 2 && window.__frames.at(-1)?.f === out;
    };
    await until(() => page.evaluate(still, drawn.out), 'the picture on the range’s last frame');
    const frames = (await recordedFrames(page)).slice(from);
    const start = startOf(frames, drawn);
    const played = frames.slice(start.at ?? 1).map((x) => x.f);
    const outside = played.filter((f) => f < drawn.in || f > drawn.out + 1);
    assert(!outside.length, `frames outside f${drawn.in}–f${drawn.out}: ${outside.join(',')}`);
    // Where it started can't be counted from presentedFrames here, as "play range" does: End's seek is on its way when
    // the range's goes out, and Chrome may put End's frame up for a moment, replaced before the page's next rendering
    // step — one more presentation, not the range's (CI 37261427659: "1 presented unreported" after f61, read as f29;
    // traced here, the range's seek always lands on f30 first). What it can tell: not late (the first frame reported is
    // no further on than the presentations since allow), and from there every frame once to the end. Its first frame
    // is "play range"'s check, on the same path without a seek in flight.
    const first = frames[start.at];
    const late = first && first.f - (first.pf - frames[start.at - 1].pf - 1) > drawn.in;
    assert(first && !late, `the range started late: ${start.why}`);
    const through = playedThrough(frames.slice(start.at), first.f, drawn.out);
    assert(!through.length, `from f${first.f} to the range's end: ${through.join('; ')}`);
    const best = closest(await grabPicture(), drawn.out);
    assert(best.k === drawn.out, `the picture is ffmpeg frame ${best.k}, not ${drawn.out} (${best.why})`);
  });

  await check('a frame a superseded seek puts up after the range began is not where playback is: the range plays all the same', async () => {
    await page.evaluate(() => document.activeElement?.blur());
    // CI's Chrome put End's frame (f119) up after the range's play() and reported it (run 37328461312): the player took
    // it for where playback was, past out, and ended the range before it played. Here that frame is delivered by hand,
    // to the frame callbacks the player holds right then, while the range's own seek is still on its way. The hook
    // holds what is asked for from now on.
    await page.evaluate(() => {
      const proto = HTMLVideoElement.prototype;
      const orig = proto.requestVideoFrameCallback;
      const held = [];
      window.__hook = { orig, held };
      proto.requestVideoFrameCallback = function (cb) {
        held.push([this, cb]);
        return orig.call(this, (now, meta) => held.some(([v, c]) => v === this && c === cb) && cb(now, meta));
      };
    });
    // (the check before stops on out: a step on presents a frame, and the player asks again through the hook)
    await page.keyboard.press('ArrowRight');
    await until(async () => (await shownFrame()) === drawn.out + 1, 'the picture one past the range');
    await page.waitForFunction(() => window.__hook.held.some(([v]) => v === document.querySelector('.vbox video')), { timeout: 10000 });
    const at = await page.evaluate(
      ({ fps }) => {
        const { orig, held } = window.__hook;
        const key = (k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
        key('End');
        key('Home');
        [...document.querySelectorAll('[data-testid=range-play]')].find((b) => b.closest('article')?.textContent.includes('Musik zu laut')).click();
        const v = document.querySelector('.vbox video');
        const seeking = v.seeking;
        const mine = held.filter(([el]) => el === v).map(([, cb]) => cb);
        held.length = 0;
        HTMLVideoElement.prototype.requestVideoFrameCallback = orig;
        for (const cb of mine)
          cb(performance.now(), { mediaTime: (119 + 0.5) / fps, presentedFrames: 0, expectedDisplayTime: 0, width: 0, height: 0, presentationTime: 0 });
        // what playback presents from here, by the video's own callback
        const rec = [];
        window.__after = rec;
        const cb = (_n, m) => {
          rec.push({ f: Math.round(m.mediaTime * fps), pf: m.presentedFrames, dropped: v.getVideoPlaybackQuality().droppedVideoFrames });
          if (!v.paused || rec.length < 3) orig.call(v, cb);
        };
        orig.call(v, cb);
        return { seeking, delivered: mine.length };
      },
      { fps: FPS },
    );
    assert(at.seeking && at.delivered > 0, `the stale frame came while the range's seek was on its way: ${JSON.stringify(at)}`);
    await page.waitForFunction(() => document.querySelector('.vbox video').paused, { timeout: 10000 });
    await until(
      async () => (await shownFrame()) === drawn.out,
      async () => `stopped on the range's last frame (f${drawn.out}), not f${await shownFrame()}`,
    );
    const frames = await page.evaluate(() => window.__after);
    const through = playedThrough(frames, drawn.in + 1, drawn.out);
    assert(!through.length, `the range played (f${drawn.in}–f${drawn.out}): ${through.join('; ')} — reported ${frames.map((x) => x.f).join(',')}`);
  });

  await check('play range on repeat: it loops inside in/out; the frame shown at the loop end is ffmpeg’s out frame', async () => {
    await page.evaluate(
      ({ out }) => {
        const v = document.querySelector('.vbox video');
        window.__seen = [];
        window.__atOut = null;
        const cb = (_n, m) => {
          const f = Math.round(m.mediaTime * 30);
          window.__seen.push(f);
          if (f === out && !window.__atOut) {
            const c = document.createElement('canvas');
            c.width = 96;
            c.height = 54;
            const g = c.getContext('2d');
            g.imageSmoothingQuality = 'high';
            g.drawImage(v, 0, 0, 96, 54);
            const d = g.getImageData(0, 0, 96, 54).data;
            const px = [];
            for (let i = 0; i < d.length; i += 4) px.push(Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]));
            window.__atOut = px;
          }
          v.requestVideoFrameCallback(cb);
        };
        v.requestVideoFrameCallback(cb);
      },
      { out: drawn.out },
    );
    const buttons = await page.$$('[data-testid=range-loop]');
    const which = await Promise.all(buttons.map((b) => b.evaluate((e) => e.closest('article')?.textContent.includes('Musik zu laut'))));
    const loop = buttons[which.indexOf(true)];
    await loop.click();
    await page.waitForFunction((e) => e.getAttribute('aria-pressed') === 'true', { timeout: 5000 }, loop);
    // The range is a second long: three and a half seconds make three loops at least.
    await sleep(3500);
    const shownWhileLooping = await shownFrame();
    const seen = await page.evaluate(() => window.__seen);
    const wraps = seen.filter((f, i) => i > 0 && f < seen[i - 1]).length;
    assert(wraps >= 2, `looped ${wraps}× (${seen.join(',')})`);
    const outside = seen.filter((f) => f < drawn.in || f > drawn.out + 1);
    assert(!outside.length, `frames outside f${drawn.in}–f${drawn.out}: ${outside.join(',')}`);
    assert(shownWhileLooping >= drawn.in && shownWhileLooping <= drawn.out, `the timecode stays in the range: f${shownWhileLooping}`);
    const atOut = await page.evaluate(() => window.__atOut);
    assert(atOut, 'the out frame was shown');
    const best = closest(atOut, drawn.out);
    assert(best.k === drawn.out, `at the loop end the picture is ffmpeg frame ${best.k}, not ${drawn.out} (${best.why})`);
    await shot('range-04-looping');
    await loop.click();
    await page.waitForFunction(() => document.querySelector('.vbox video').paused, { timeout: 5000 });
    await page.waitForFunction((e) => e.getAttribute('aria-pressed') === 'false', { timeout: 5000 }, loop);
    await videoReady();
    await sleep(300);
    const stopped = await shownFrame();
    assert(stopped >= drawn.in && stopped <= drawn.out, `stopped inside the range: f${stopped}`);
    const still = closest(await grabPicture(), stopped);
    assert(still.k === stopped, `stopped: the picture is ffmpeg frame ${still.k}, not ${stopped} (${still.why})`);
  });

  await check('a click on the range bar plays the range', async () => {
    await openPlayer(110);
    const tl = await timeline();
    await page.mouse.click(xOf(tl, 50), tl.y + BAR_Y);
    await page.waitForFunction(() => !document.querySelector('.vbox video').paused, { timeout: 5000 });
    await page.waitForFunction(() => document.querySelector('.vbox video').paused, { timeout: 10000 });
    await sleep(300);
    const at = await shownFrame();
    assert(at === drawn.out, `stopped on f${at}`);
  });

  await check('a client marks a range on a review link; it arrives as a range note', async () => {
    const link = await api(`/api/review/${encodeURIComponent(slug)}/shares`, 'POST', { label: 'Client' });
    clientToken = link.token;
    await page.goto(`${BASE}/g/${link.token}`, { waitUntil: 'domcontentloaded' });
    await videoReady();
    // no name asked up front: the composer asks for it when the first note is sent (below)
    assert(!(await page.$('.g-name')), 'no name prompt before the first note');
    await page.waitForSelector('.timeline canvas');
    await sleep(300);
    const tl = await timeline();
    await page.mouse.move(xOf(tl, 12), tl.y + LANE_Y);
    await page.mouse.down();
    await page.mouse.move(xOf(tl, 30), tl.y + LANE_Y, { steps: 8 });
    await page.mouse.move(xOf(tl, 42), tl.y + LANE_Y, { steps: 8 });
    await page.mouse.up();
    await page.waitForSelector('.g-composer [data-testid=range-ctl]');
    const ctl = await page.$eval('.g-composer [data-testid=range-ctl]', (e) => e.textContent);
    // at 1024 the client's notes column is narrow: a range beside the tools didn't fit and the tools ran out of the box
    const wide = page.viewport();
    for (const width of [1024, wide.width]) {
      await page.setViewport({ ...wide, width });
      await sleep(200);
      const cutG = await cutInHead(page, '.g-composer');
      assert(!cutG.length, `@${width}: nothing in the client composer's head is cut or sticks out: ${cutG.join(', ')}`);
    }
    assert(ctl.includes('00:00:12 → 00:01:12'), ctl);
    // the same chip as the team's: on the timeline (with its menu) and in the composer's head, whose menu says what
    // stays when the end comes off and what moves an end (or how)
    const mark = await page.$eval('[data-testid=tl-mark]', (e) => e.textContent);
    assert(mark.includes('00:00:12 → 00:01:12'), `the timeline's chip on the review link: ${mark}`);
    const items = await openMenu('.g-composer [data-testid=composer-where]');
    assert(
      items.some((x) => x.label === 'Just 00:00:12'),
      `the end comes off: ${JSON.stringify(items)}`,
    );
    assert(
      items.some((x) => /^(End at|Start at) /.test(x.label) || x.label === 'Step to a new end'),
      `what moves an end, or how: ${JSON.stringify(items)}`,
    );
    await closeMenu();
    const ph = await page.$eval('.g-composer textarea', (e) => e.placeholder);
    assert(ph === 'What should change in this section?', ph);
    await page.type('.g-composer textarea', 'Hier ist die Musik zu laut');
    // the kind of note is the toolbar's small menu (Change · Idea), like the team's severity
    await page.click('.g-composer .composer-foot .sev-pick');
    await page.waitForSelector('.menu[data-state=open]');
    for (const h of await page.$$('.menu[data-state=open] [role^=menuitem]')) if ((await h.evaluate((e) => e.textContent.trim())) === 'Idea') await h.click();
    await until(async () => (await page.$eval('.g-composer .sev-pick', (e) => e.getAttribute('aria-label'))) === 'Kind of note: Idea', 'Idea picked');
    await sleep(200);
    await shot('range-05-client-composer');
    await page.evaluate(() => [...document.querySelectorAll('.g-composer button')].find((b) => b.textContent.includes('Add note'))?.click());
    // the first note asks for the name right there; ↵ sends the note with the section and the kind as they were
    await page.waitForSelector('.g-composer .g-name input');
    await page.type('.g-composer .g-name input', 'Mia');
    await page.keyboard.press('Enter');
    await until(async () => (await review()).comments.some((x) => x.text === 'Hier ist die Musik zu laut'), 'the client’s note reached the store');
    const c = (await review()).comments.find((x) => x.text === 'Hier ist die Musik zu laut');
    assert(c.author === 'guest:Mia', c.author);
    assert(c.range?.in === 12 && c.range.out === 42, `range ${JSON.stringify(c.range)}`);
    assert(c.severity === 'idea', `sent as an idea (${c.severity})`);
    await page.waitForFunction(() => [...document.querySelectorAll('.g-note [data-testid=note-range]')].length >= 1, { timeout: 10000 });
    const chip = await page.$$eval('.g-note [data-testid=note-range]', (els) => els.map((e) => e.textContent).join(' | '));
    assert(chip.includes('00:00:12 → 00:01:12'), chip);
    assert(!(await page.$('.g-composer [data-testid=range-ctl]')), 'sent, the composer is back to one frame');
    await shot('range-06-client-note');
  });

  await check('on a phone: a long press then a drag on the timeline marks a range; its action works in the sheet', async () => {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: SHOTS ? 3 : 1, isMobile: true, hasTouch: true });
    await openPlayer(0);
    const tl = await timeline();
    // Held still first (a plain drag scrubs), then drawn across.
    await page.touchscreen.touchStart(xOf(tl, 90), tl.y + LANE_Y);
    await sleep(700);
    for (let i = 1; i <= 8; i++) await page.touchscreen.touchMove(xOf(tl, 90 + (15 * i) / 8), tl.y + LANE_Y);
    await page.touchscreen.touchEnd();
    await page.waitForSelector('.composer [data-testid=range-ctl]', { timeout: 5000 });
    let ctl = await page.$eval('.composer [data-testid=range-ctl]', (e) => e.textContent);
    assert(ctl.includes('00:03:00 → 00:03:15'), `a finger's range: ${ctl}`);
    // The layout rules at this size (fitsAt would resize through the desktop sizes and close the phone's composer).
    const bad = [...(await sideways(page)), ...(await clippedText(page)), ...(await bentEdges(page))];
    assert(!bad.length, `phone composer with a range: ${bad.join('\n')}`);
    await sleep(300);
    await shot('range-07-phone-composer');
    // the timeline's chip only says what is marked on a phone (its menu is the composer's)
    assert(await page.$eval('[data-testid=tl-mark]', (e) => e.tagName === 'SPAN'), 'a quiet chip on the phone’s timeline');
    // On its first frame the chip's menu (a sheet here) says what to do — a finger plays to the end — and takes the end
    // off: back to one frame, then "From" in the last second (f90).
    const items = await openMenu('.composer [data-testid=composer-where]');
    assert(items.find((x) => x.label === 'Play to a new end')?.disabled, `what to do: ${JSON.stringify(items)}`);
    await pickItem('Only the first frame, 00:03:00');
    await page.waitForSelector('.composer [data-testid=range-add]');
    await page.$eval('.composer [data-testid=range-add]', (e) => e.click());
    await page.waitForSelector('.composer [data-testid=range-ctl]');
    ctl = await page.$eval('.composer [data-testid=range-ctl]', (e) => e.textContent);
    assert(ctl.includes('00:02:00 → 00:03:00'), `"From" in the last second: the second before the playhead (${ctl})`);
    await page.type('.composer textarea', 'Am Ende zu leise');
    await page.evaluate(() => [...document.querySelectorAll('.composer button')].find((b) => b.textContent.trim().startsWith('Send'))?.click());
    await page.waitForFunction(() => !document.querySelector('.composer'), { polling: 100, timeout: 20000 });
    const c = (await review()).comments.find((x) => x.text === 'Am Ende zu leise');
    assert(c?.range?.in === 60 && c.range.out === 90, `range ${JSON.stringify(c?.range)}`);
    await shot('range-08-phone-notes');
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: SHOTS ? 2 : 1 });
  });

  // The same screens in the light theme, at both sizes (only for the screenshots).
  if (SHOTS)
    await check('screenshots in both themes at 1280, 1024 and 390: bars, cards, composer, client', async () => {
      for (const theme of ['dark', 'light'])
        for (const [w, h, phone] of [
          [1280, 800, false],
          [1024, 768, false],
          [390, 844, true],
        ]) {
          // A fresh page per theme and size: one page through all eighteen video loads is what a loaded machine's
          // renderer gives up on ("Session closed").
          const used = page;
          page = await browser.newPage();
          page.on('pageerror', (e) => errors.push(e.message));
          await used.close();
          await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
          await page.setViewport({ width: w, height: h, deviceScaleFactor: phone ? 3 : 2, isMobile: phone, hasTouch: phone });
          await openPlayer(40);
          await shot(`range-${theme}-${w}-bars-cards`);
          await page.keyboard.press('c');
          await page.waitForSelector('.composer [data-testid=range-add]');
          await page.$eval('.composer [data-testid=range-add]', (e) => e.click());
          await page.waitForSelector('.composer [data-testid=range-ctl]');
          await sleep(300);
          await shot(`range-${theme}-${w}-composer`);
          await page.keyboard.press('Escape');
          await page.goto(`${BASE}/g/${clientToken}`, { waitUntil: 'domcontentloaded' });
          await videoReady();
          await sleep(600);
          await shot(`range-${theme}-${w}-client`);
        }
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
      await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
    });

  await check('no page errors', async () => {
    assert(!errors.length, errors.join('\n'));
  });
} catch (e) {
  crashed(e, srv);
}
await finish(LABEL, { browser, servers: [srv] });
