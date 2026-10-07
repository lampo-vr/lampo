#!/usr/bin/env node
// covers: web/src/api/ web/src/lib/ web/src/library/ web/src/player/ web/src/inbox/ web/src/settings/
// covers: web/src/sessions/ web/src/styleguide/ web/src/styles/
// Browser quality rules over the main screens (lib/qualityScreens.mjs: local mode, temp stores, free ports, headless
// Chrome): tap areas of at least 44 × 44 px on a phone; every control named, one h1 and a main landmark per screen,
// dialogs labelled; controls side by side share one height; hovering moves nothing; no coloured edge that bends along a
// rounded corner; no text people read in --faint (under AA); what every screen renders stays on the design system's
// scales (lib/designInventory.mjs). The start's size, layout shift and skeleton → content are quality-load.mjs. Cheap
// to run; each rule says what broke it.
import { sleep } from '../lib/helpers.ts';
import { bentEdges, faintText, settle } from './layout.mjs';
import { requireChrome } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { inventory, SCALE } from './lib/designInventory.mjs';
import { qualityScreens, qualityServers } from './lib/qualityScreens.mjs';

const LABEL = 'quality e2e';
requireChrome(LABEL);
const q = await qualityServers('quality');

try {
  const { SCREENS, ready, PHONE, DESKTOP, IPHONE, open, again, openComposer } = await qualityScreens(q);
  const { BASE } = q;

  await check('tap areas are at least 44 × 44 px on a phone', async () => {
    // The tap area: the box plus an invisible ::before/::after laid over it (mobile.css widens compact controls so).
    const tapAreas = () => {
      const area = (el) => {
        const r = el.getBoundingClientRect();
        let [l, t, rt, b] = [r.left, r.top, r.right, r.bottom];
        for (const p of ['::before', '::after']) {
          const s = getComputedStyle(el, p);
          if (s.content === 'none' || s.position !== 'absolute' || s.pointerEvents === 'none') continue;
          const px = (v, size) => (v.endsWith('px') ? parseFloat(v) : v.endsWith('%') ? (parseFloat(v) / 100) * size : 0);
          l = Math.min(l, r.left + px(s.left, r.width));
          t = Math.min(t, r.top + px(s.top, r.height));
          rt = Math.max(rt, r.right - px(s.right, r.width));
          b = Math.max(b, r.bottom - px(s.bottom, r.height));
        }
        return { w: rt - l, h: b - t };
      };
      const hidden = (el) => {
        for (let p = el; p; p = p.parentElement) {
          const s = getComputedStyle(p);
          if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return true;
        }
        return false;
      };
      const out = [];
      for (const el of document.querySelectorAll('button, a[href], [role=button], [role=tab], [role=menuitem], select, input:not([type=hidden]), textarea')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || hidden(el) || r.top > innerHeight) continue;
        // Links inside running text are sized by their sentence (WCAG 2.5.8's inline exception).
        if (getComputedStyle(el).display === 'inline') continue;
        const a = area(el);
        if (Math.round(a.w) < 44 || Math.round(a.h) < 44)
          out.push(
            `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30)}" ${Math.round(a.w)}×${Math.round(a.h)}`,
          );
      }
      return out;
    };
    const out = [];
    for (const screen of [
      'library',
      'player',
      'inbox',
      'client link',
      'empty view',
      'empty folder',
      'folder playbook',
      'folder files',
      'first run',
      'get started',
      'composer',
    ]) {
      const small = await again(async () => {
        const page = screen === 'composer' ? await openComposer(PHONE) : await open(screen, PHONE);
        const small = await page.evaluate(tapAreas);
        await page.close();
        return small;
      });
      for (const s of small) out.push(`${screen}: ${s}`);
    }
    assert(!out.length, `under 44 × 44 px:\n        ${out.join('\n        ')}`);
  });

  await check('every control has a name; one h1 and a main landmark per screen; dialogs are labelled', async () => {
    const out = [];
    const audit = (page) =>
      page.evaluate(() => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) return false;
          for (let p = el; p; p = p.parentElement) {
            const s = getComputedStyle(p);
            if (s.display === 'none' || s.visibility === 'hidden') return false;
          }
          return true;
        };
        const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
        const byIds = (ids) =>
          ids
            .split(/\s+/)
            .map((id) => text(document.getElementById(id)))
            .join(' ')
            .trim();
        const name = (el) =>
          el.getAttribute('aria-label')?.trim() ||
          (el.getAttribute('aria-labelledby') && byIds(el.getAttribute('aria-labelledby'))) ||
          [...(el.labels || [])].map(text).join(' ').trim() ||
          (el.matches('input, textarea, select') ? '' : text(el)) ||
          el.getAttribute('title')?.trim() ||
          // pictures inside name it too: an <img alt> or an SVG with role=img (the logo in the brand link)
          [...el.querySelectorAll('img[alt], [role=img][aria-label]')]
            .map((i) => i.getAttribute('alt') ?? i.getAttribute('aria-label'))
            .join(' ')
            .trim();
        const out = [];
        for (const el of document.querySelectorAll(
          'button, a[href], [role=button], [role=tab], [role=menuitem], [role=switch], [role=checkbox], select, input:not([type=hidden]), textarea',
        )) {
          if (visible(el) && !name(el)) out.push(`unnamed ${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')}`);
        }
        const h1 = [...document.querySelectorAll('h1')].filter(visible);
        if (h1.length !== 1) out.push(`${h1.length} visible h1 (want 1): ${h1.map(text).join(' | ')}`);
        if (!document.querySelector('main, [role=main]')) out.push('no main landmark');
        for (const d of document.querySelectorAll('[role=dialog], [role=alertdialog]')) {
          if (visible(d) && !name(d)) out.push(`unlabelled ${d.getAttribute('role')}`);
        }
        return out;
      });
    for (const vp of [DESKTOP, PHONE]) {
      for (const screen of Object.keys(SCREENS)) {
        const found = await again(async () => {
          const found = [];
          const page = await open(screen, vp);
          for (const p of await audit(page)) found.push(`${screen} @${vp.width}: ${p}`);
          if (screen === 'library' && vp === DESKTOP) {
            // The dialogs people meet first: the palette and a share dialog.
            await page.keyboard.down('Meta');
            await page.keyboard.press('k');
            await page.keyboard.up('Meta');
            await page.waitForSelector('[role=dialog]', { timeout: 5000 });
            for (const p of await audit(page)) if (/dialog/.test(p)) found.push(`palette: ${p}`);
          }
          await page.close();
          return found;
        });
        out.push(...found);
      }
    }
    assert(!out.length, out.join('\n        '));
  });

  // Controls drawn as boxes (a border or a fill of their own) that sit side by side in a bar share one height: one step
  // of the scale in base.css (--h-sm, --h, --h-lg). Ghost buttons draw no box, so their size doesn't show.
  await check('controls side by side in a bar share one height', async () => {
    const barRows = () => {
      const CTL = ':is(.btn, .input, .seg, .lib-filter, .vpick, .session-chip, button.input)';
      const boxed = (e) => {
        const s = getComputedStyle(e);
        const border = parseFloat(s.borderTopWidth) > 0 && !/rgba\(.*, 0\)|transparent/.test(s.borderTopColor);
        const fill = !/rgba\(.*, 0\)|transparent/.test(s.backgroundColor);
        return border || fill || e.matches('.lib-filter');
      };
      const found = [];
      for (const bar of document.querySelectorAll('.lib-toolbar, .topbar, .draw-bar, .composer-foot, .set-inline, .link-new-row')) {
        const els = [...bar.querySelectorAll(CTL)].filter((e) => {
          const outer = e.parentElement?.closest(CTL);
          return !(outer && bar.contains(outer)) && boxed(e);
        });
        const boxes = els.map((e) => ({ e, r: e.getBoundingClientRect() })).filter((b) => b.r.width && b.r.height);
        for (const a of boxes)
          for (const b of boxes)
            if (a !== b && Math.abs(a.r.top + a.r.height / 2 - (b.r.top + b.r.height / 2)) < 3 && Math.abs(a.r.height - b.r.height) > 0.5)
              found.push(`${a.e.className} ${a.r.height}px beside ${b.e.className} ${b.r.height}px`);
      }
      return [...new Set(found)];
    };
    const out = [];
    // a desktop window as narrow as a phone, with a mouse: the phone layout, its fields as tall as its buttons
    const NARROW = { width: 390, height: 844, deviceScaleFactor: 1 };
    for (const vp of [DESKTOP, PHONE, NARROW]) {
      for (const screen of ['library', 'player', 'inbox', 'composer', 'tokens', 'share']) {
        const rows = await again(async () => {
          // Settings → API tokens: a field, a select and a button on one line (they wrap into two on a phone)
          const settings = async () => {
            const p = await q.browser.newPage();
            if (vp.isMobile) await p.emulate({ viewport: vp, userAgent: IPHONE });
            else await p.setViewport(vp);
            await p.goto(`${BASE}/#/settings/tokens`, { waitUntil: 'domcontentloaded' });
            await p.waitForSelector('.set-inline .btn.primary', { timeout: 15000 });
            await settle(p, { quiet: 400, max: 8000 });
            return p;
          };
          // a folder's Share: who the link is for and Create link, side by side
          const share = async () => {
            const p = await open('empty folder', vp);
            await p.click('.hero .hero-share');
            await p.waitForSelector('[data-testid=link-create]', { timeout: 15000 });
            await settle(p, { quiet: 400, max: 8000 });
            return p;
          };
          const page =
            screen === 'composer'
              ? await openComposer(vp)
              : screen === 'tokens'
                ? await settings()
                : screen === 'share'
                  ? await share()
                  : await open(screen, vp);
          const rows = await page.evaluate(barRows);
          await page.close();
          return rows;
        });
        for (const r of rows) out.push(`${screen} @${vp.width}${vp === NARROW ? ' (mouse)' : ''}: ${r}`);
      }
    }
    assert(!out.length, out.join('\n        '));
  });

  // Hover states change colour, never layout: a sidebar row that makes room for its actions pushes its label and count
  // around under the pointer. Boxes are compared by layout (offset*), so a transform (a lift) doesn't count.
  await check('hovering a row, a card or a toolbar button moves nothing', async () => {
    const out = [];
    // the library's grid and list, the inbox view's rows and preview, the composer's rows of controls, and the player's
    // note rows (their picture comes over the row's end) and the filter row's chips
    for (const layout of ['grid', 'list', 'inbox', 'composer', 'notes']) {
      await again(async () => {
        const inbox = layout === 'inbox';
        const composer = layout === 'composer';
        const notes = layout === 'notes';
        const page = composer ? await openComposer(DESKTOP) : await open(inbox ? 'inbox' : notes ? 'player' : 'library', DESKTOP);
        if (!inbox && !composer && !notes) {
          await page.evaluate((l) => localStorage.setItem('vr.library', JSON.stringify({ layout: l })), layout);
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.waitForSelector(layout === 'grid' ? '.film' : '.lrow', { timeout: 15000 });
        }
        await sleep(400);
        const targets = await page.$$(
          composer
            ? ':is(.composer :is(.composer-head, .composer-foot), [data-testid=draw-bar]) button'
            : notes
              ? '.side-scroll .note-row .nr, .note-filters .tagf, .side-title [data-testid=ac-chip]'
              : inbox
                ? '.nav .nav-item, .inbox-view .inbox-row, .inbox-view-preview .btn'
                : '.nav .nav-item, .lib-toolbar button, .film, .lrow',
        );
        for (const el of targets) {
          // Boxes of the elements around the target before the pointer arrives, compared with the same elements after:
          // what hover adds (a scrub playhead, row actions) may appear, but nothing that was there may move or resize.
          await el.evaluate((t) => {
            const scope = t.closest('.nav') || t.closest('.lib-toolbar') || t.closest('.composer') || t.closest('.side') || t.parentElement;
            const box = (e) => `${e.offsetLeft},${e.offsetTop},${e.offsetWidth}x${e.offsetHeight}`;
            window.__boxes = new Map([...scope.querySelectorAll('*')].map((e) => [e, box(e)]));
          });
          await el.hover();
          await sleep(260);
          const moved = await el.evaluate(() => {
            const box = (e) => `${e.offsetLeft},${e.offsetTop},${e.offsetWidth}x${e.offsetHeight}`;
            return [...window.__boxes].filter(([e, b]) => e.isConnected && box(e) !== b).map(([e, b]) => `${e.className || e.tagName} ${b} → ${box(e)}`);
          });
          if (moved.length)
            out.push(
              `${layout}: hovering ${await el.evaluate((t) => `${t.className} "${(t.textContent || '').trim().slice(0, 24)}"`)} moves ${moved.slice(0, 3).join('; ')}`,
            );
        }
        await page.close();
      });
    }
    assert(!out.length, [...new Set(out)].join('\n        '));
  });

  await check('no coloured edge bends along a rounded box, on any screen', async () => {
    const out = [];
    for (const vp of [DESKTOP, PHONE]) {
      for (const screen of Object.keys(SCREENS)) {
        const bent = await again(async () => {
          const page = await open(screen, vp);
          const bent = await bentEdges(page);
          await page.close();
          return bent;
        });
        for (const p of bent) out.push(`${screen} @${vp.width}: ${p}`);
      }
    }
    assert(!out.length, out.join('\n        '));
  });

  // --faint fails AA as text (3.4:1 on paper, 2.9:1 in the dark): words someone reads are --muted or stronger, and
  // --faint is left to decoration, placeholders and what is disabled. The review link's pages and the first run join
  // when their own redesigns land (guest.css, the setup's sheets).
  await check('text people read is never set in --faint (under AA): counts, dates, hints, labels', async () => {
    const pages = {
      library: '/#/',
      list: '/#/',
      board: '/#/',
      player: SCREENS.player,
      inbox: SCREENS.inbox,
      insights: SCREENS.insights,
      'empty view': SCREENS['empty view'],
      'empty folder': SCREENS['empty folder'],
      'folder playbook': SCREENS['folder playbook'],
      'folder files': SCREENS['folder files'],
      settings: '/#/settings',
      'settings: connect an agent': '/#/settings/mcp',
      'settings: review links': '/#/settings/links',
      'settings: API tokens': '/#/settings/tokens',
      'settings: about': '/#/settings/about',
    };
    const layouts = { library: 'grid', board: 'board', list: 'list' };
    const out = [];
    // the phone's own parts (the notes sheet, the drawer, the stacked cards) on the screens that have them
    const phone = ['library', 'player', 'inbox'];
    for (const vp of [DESKTOP, PHONE])
      for (const [screen, url] of Object.entries(pages)) {
        if (vp === PHONE && !phone.includes(screen)) continue;
        const found = await again(async () => {
          const page = await q.browser.newPage();
          if (vp.isMobile) await page.emulate({ viewport: vp, userAgent: IPHONE });
          else await page.setViewport(vp);
          await page.evaluateOnNewDocument((layout) => {
            try {
              if (layout) localStorage.setItem('vr.library', JSON.stringify({ layout }));
            } catch {}
          }, layouts[screen] ?? null);
          await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector(ready[screen] ?? ':is(.film, .lrow, .bcard):not(.pending), .set-main h1', { timeout: 15000 });
          await settle(page, { quiet: 500, max: 10_000 });
          // a reply field at rest is drawn like the field it opens into: its word is a placeholder
          const found = await faintText(page, ['.reply-stub']);
          await page.close();
          return found;
        });
        for (const f of found) out.push(`${screen} @${vp.width}: ${f}`);
      }
    assert(!out.length, `text under AA contrast (use --muted):\n        ${out.join('\n        ')}`);
  });

  // A count in a chip, a segment or a tab is a quiet second word: the UI's face, a step under its label, tabular. In the
  // mono face at 11 px the numbers stood as tall as the 12 px words beside them.
  await check('a chip’s count reads as a quiet second word: the UI face, smaller than its label, tabular', async () => {
    const out = [];
    for (const screen of ['library', 'player']) {
      const found = await again(async () => {
        const page = await open(screen, DESKTOP);
        const found = await page.evaluate(() =>
          [...document.querySelectorAll(':is(.seg-count, .tabs button .n, .tagf .n)')]
            .filter((n) => n.getClientRects().length && /\d/.test(n.textContent))
            .map((n) => {
              const s = getComputedStyle(n);
              const label = getComputedStyle(n.parentElement);
              const bad = [
                !/^"?Instrument Sans/.test(s.fontFamily) && `face ${s.fontFamily.split(',')[0]}`,
                !(parseFloat(s.fontSize) < parseFloat(label.fontSize)) && `${s.fontSize} beside a ${label.fontSize} label`,
                !/tabular-nums/.test(s.fontVariantNumeric) && 'proportional figures',
              ].filter(Boolean);
              return bad.length ? `${n.className} "${n.textContent}" in "${n.parentElement.textContent.trim()}": ${bad.join(', ')}` : null;
            })
            .filter(Boolean),
        );
        await page.close();
        return found;
      });
      for (const f of found) out.push(`${screen}: ${f}`);
    }
    assert(!out.length, out.join('\n        '));
  });

  // The design audit's runtime collector, kept as a rule: every visible text's size and weight, every corner, every
  // control's height, on each screen and layout at desktop and phone size. Sizes drawn rather than set (an avatar's
  // initials, the phone mock, the first run's pictures, which scale with their room, the styleguide's type ramp) are
  // left out.
  await check('every screen renders on the design system’s scales: type sizes, weights, corners, control heights', async () => {
    const pages = {
      ...SCREENS,
      board: '/#/',
      list: '/#/',
      settings: '/#/settings/appearance',
      styleguide: '/#/styleguide',
    };
    const layouts = { library: 'grid', board: 'board', list: 'list' };
    // (the entrance's brand film and the first run's pictures are drawings at their own scale: their labels and corners
    // scale with the picture)
    const ALLOW = ['.avatar', '.phone', '.rdp-root', '.sg-type', '.ent-film', '.ob-pic', '.ob-smp-thumb'];
    const out = [];
    for (const vp of [DESKTOP, PHONE])
      for (const [screen, url] of Object.entries(pages)) {
        const found = await again(async () => {
          const page = await q.browser.newPage();
          if (vp.isMobile) await page.emulate({ viewport: vp, userAgent: IPHONE });
          else await page.setViewport(vp);
          await page.evaluateOnNewDocument((layout) => {
            try {
              if (layout) localStorage.setItem('vr.library', JSON.stringify({ layout }));
            } catch {}
          }, layouts[screen] ?? null);
          await page.goto(url.startsWith('http') ? url : BASE + url, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector(ready[screen] ?? 'main, [data-testid=styleguide], .set-main', { timeout: 15000 });
          await sleep(900);
          const r = await page.evaluate(inventory, { scale: SCALE, allow: ALLOW });
          await page.close();
          return r;
        });
        for (const [kind, list] of Object.entries(found))
          for (const { value, who } of list) out.push(`${screen} @${vp.width}: ${kind} ${value} (${who.join(', ')})`);
      }
    assert(!out.length, `off the scales in base.css:\n        ${out.join('\n        ')}`);
  });
} catch (e) {
  crashed(e, ...q.servers);
} finally {
  await finish(LABEL, { browser: q.browser, servers: q.servers });
}
