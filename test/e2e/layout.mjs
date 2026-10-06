// Layout checks shared by the browser suites, run inside the page.

// Text whose glyphs are cut off: headings, the display serif, anything with a tight line-height inside a box that
// clips (overflow hidden for an ellipsis, a fixed height). The glyph box is measured, not the line box: the serif's
// descenders reach well below a 0.95 line-height, and "g", "y", "p", "j" and "Q" lose their tails first.
// Returns one line per clipped element, empty when everything reads whole.
export const clippedText = (page) =>
  page.evaluate(() => {
    const out = [];
    const ctx = document.createElement('canvas').getContext('2d');
    const hidden = (el) => {
      for (let p = el; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return true;
      }
      return false;
    };
    const ownText = (el) =>
      [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent)
        .join('')
        .trim();
    const name = (el) =>
      `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}`;
    for (const el of document.querySelectorAll('body *')) {
      const text = ownText(el);
      if (!text) continue;
      const cs = getComputedStyle(el);
      const display = /Instrument Serif/.test(cs.fontFamily);
      if (!display && !/^H[1-4]$/.test(el.tagName)) continue;
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height || hidden(el)) continue;
      // The ink of this text relative to its baseline, and where the baseline sits in each line box.
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const m = ctx.measureText(text);
      const range = document.createRange();
      range.selectNodeContents(el);
      const lines = [...range.getClientRects()].filter((r) => r.width && r.height);
      if (!lines.length) continue;
      const ink = {
        top: Math.min(...lines.map((r) => r.top + m.fontBoundingBoxAscent - m.actualBoundingBoxAscent)),
        bottom: Math.max(...lines.map((r) => r.top + m.fontBoundingBoxAscent + m.actualBoundingBoxDescent)),
      };
      if (el.scrollHeight > el.clientHeight + 1 && cs.overflowY !== 'visible')
        out.push(`${name(el)} "${text.slice(0, 30)}" is cut: scrollHeight ${el.scrollHeight} > ${el.clientHeight}`);
      for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
        const pr = p.getBoundingClientRect();
        const top = pr.top + p.clientTop;
        const bottom = top + p.clientHeight;
        // A scroll container clips what is scrolled away on purpose; only text that sits in view but still loses
        // its tails there counts. A clipping box (hidden, clip) has no such excuse.
        const scroller = /(auto|scroll)/.test(s.overflowY);
        if (scroller && (box.top < top - 1 || box.bottom > bottom + 1)) break;
        if (ink.top < top - 0.5 || ink.bottom > bottom + 0.5) {
          out.push(
            `${name(el)} "${text.slice(0, 30)}" is clipped by ${p === el ? 'itself' : name(p)} (glyphs ${Math.round(ink.top)}–${Math.round(ink.bottom)}, box ${Math.round(top)}–${Math.round(bottom)})`,
          );
          break;
        }
      }
    }
    return out;
  });

// The grain overlay (.grain::after, inset 0) covers its element's box, and inside a scroller that box is the first
// screenful of the content: scroll further and the grain stops at a visible edge. So .grain never goes on a scroller.
export const grainOnScrollers = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.grain')]
      .filter((el) => {
        const s = getComputedStyle(el);
        return s.display !== 'none' && /(auto|scroll)/.test(`${s.overflowX} ${s.overflowY}`);
      })
      .map((el) => `${el.tagName.toLowerCase()}.${el.className.trim().split(/\s+/).join('.')} scrolls and carries .grain`),
  );

// A coloured edge on one side of a rounded box (a border-left or border-top stripe, or an inset shadow painting one edge)
// bends along the corner radius: it reads as a smudge, not a line. Accents go on a dot, a badge or the whole outline.
export const bentEdges = (page, scope = 'body') =>
  page.evaluate((scope) => {
    const out = [];
    for (const el of document.querySelectorAll(`${scope} *`)) {
      const s = getComputedStyle(el);
      if (s.display === 'none' || !(parseFloat(s.borderTopLeftRadius) > 0 || parseFloat(s.borderTopRightRadius) > 0)) continue;
      const sides = [s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor];
      const widths = [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].map(parseFloat);
      const stripe = widths.some((w, i) => w >= 2 && sides.some((c, j) => j !== i && c !== sides[i]));
      // Computed shadows read "<colour> <x> <y> <blur> <spread> [inset]": an offset of 2 px or more without blur is a
      // painted edge (1 px bevel highlights and soft inner shadows are fine).
      const edge = [...s.boxShadow.matchAll(/\)\s(-?[\d.]+)px (-?[\d.]+)px ([\d.]+)px(?: -?[\d.]+px)? inset/g)].some(
        (m) => Number(m[3]) === 0 && Math.max(Math.abs(Number(m[1])), Math.abs(Number(m[2]))) >= 2,
      );
      if (stripe || edge)
        out.push(`${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')} has a coloured edge that bends with its corners`);
    }
    return out;
  }, scope);

// Badges and chips say something short in full: an ellipsis inside one ("Client revi…") hides the very word it is for.
// Titles on cards and rows stay on one line (the full name is in their tooltip): a card whose name wraps to two or
// three lines is taller than its neighbours and reads as a paragraph. Returns one line per problem.
export const cutLabels = (page) =>
  page.evaluate(() => {
    const out = [];
    const hidden = (el) => {
      for (let p = el; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.display === 'none' || s.visibility === 'hidden') return true;
      }
      return false;
    };
    const name = (el) => `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).slice(0, 2).join('.')}`;
    for (const el of document.querySelectorAll('.sbadge, .sb-label, .ch, .chip, .badge, .vchip, .seg-count, .kbd, kbd')) {
      const r = el.getBoundingClientRect();
      if (!r.width || hidden(el)) continue;
      if (el.scrollWidth > el.clientWidth + 1)
        out.push(`${name(el)} "${el.textContent.trim().slice(0, 24)}" is cut short (${el.scrollWidth} > ${el.clientWidth})`);
    }
    // a list row's title is its name's link: the cell holds the name over where the video is (two lines by design)
    for (const el of document.querySelectorAll('.film-title, .bcard-name, .lname > a, .list-row-title, .fy-title, .inbox-title')) {
      const r = el.getBoundingClientRect();
      if (!r.width || hidden(el)) continue;
      const lh = parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.3;
      if (r.height > lh * 1.6) out.push(`${name(el)} "${el.textContent.trim().slice(0, 24)}" wraps to ${Math.round(r.height / lh)} lines`);
    }
    return out;
  });

// --faint (base.css) is under AA contrast: it is for decoration, placeholders and what is disabled, never for words
// someone reads to use the page (a password's rule, a count, a date, a hint). Returns one line per text drawn in it
// below 24 px (the size from which 3:1 is enough), on screen and not hidden from assistive tech. `allow`: selectors of
// stand-ins drawn like a placeholder (a reply field at rest). Punctuation alone (a "·" between words) is decoration.
export const faintText = (page, allow = []) =>
  page.evaluate((allow) => {
    const out = [];
    const rgb = (v) => {
      const h = v.trim().replace('#', '');
      return h.length === 6 ? `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})` : null;
    };
    const hidden = (el) => {
      for (let p = el; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0' || p.getAttribute('aria-hidden') === 'true') return true;
      }
      return false;
    };
    for (const el of document.querySelectorAll('body *')) {
      const own = [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent)
        .join('')
        .trim();
      if (!own || /^[\s·•|—–\-/,:×+()…]+$/.test(own)) continue;
      const s = getComputedStyle(el);
      const faint = rgb(s.getPropertyValue('--faint'));
      if (!faint || s.color !== faint || parseFloat(s.fontSize) >= 24) continue;
      if (el.closest(':disabled, [aria-disabled=true], .sk, .sk-line') || allow.some((a) => el.closest(a)) || hidden(el)) continue;
      const r = el.getBoundingClientRect();
      // words for screen readers only (.sr-only: a 1 px box) are never seen
      if (r.width < 2 || r.height < 2) continue;
      const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}` : '';
      out.push(`${el.tagName.toLowerCase()}${cls} ${s.fontSize} "${own.slice(0, 40)}" is set in --faint`);
    }
    return [...new Set(out)];
  }, allow);

// The screen that is open, checked at a phone, a tablet and the desktop widths people use — 1024 (a small laptop, an
// iPad in landscape), 1180, 1280, 1440 and 1920 (then back to the page's own viewport): sideways overflow on the small
// ones, clipped glyphs, cut badges and wrapping card titles, grain on scrollers and bent coloured edges everywhere.
// Returns the problems.
const SIZES = [
  { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { width: 1024, height: 768, deviceScaleFactor: 1 },
  { width: 1180, height: 820, deviceScaleFactor: 1 },
  { width: 1280, height: 800, deviceScaleFactor: 1 },
  { width: 1440, height: 900, deviceScaleFactor: 1 },
  { width: 1920, height: 1080, deviceScaleFactor: 1 },
];
export async function fitsAt(page, where) {
  const own = page.viewport();
  const out = [];
  for (const vp of SIZES) {
    await page.setViewport(vp);
    await settle(page);
    const bad = [
      ...(vp.isMobile ? await sideways(page) : []),
      ...(await clippedText(page)),
      ...(await cutLabels(page)),
      ...(await grainOnScrollers(page)),
      ...(await bentEdges(page)),
    ];
    for (const b of bad) out.push(`${where} @${vp.width}: ${b}`);
  }
  if (own) await page.setViewport(own);
  // Back at the page's own size the layout re-renders (breakpoints swap components): let it settle before the caller
  // goes on typing and clicking, or it races the re-render under load.
  await settle(page);
  return out;
}

/**
 * The page once a resize, a theme switch or a load has played out: two frames, then until it holds still for `quiet`
 * ms running — the same number of elements and scroll size, no finite animation running, the images in view and the
 * fonts loaded — at most `max` ms. A state, not a time: a quiet machine is done at once, a loaded one waits as long
 * as its re-render takes.
 */
export const settle = (page, { quiet = 200, max = 4000 } = {}) =>
  page.evaluate(
    (quiet, max) =>
      new Promise((resolve) => {
        const t0 = performance.now();
        const shape = () => {
          const d = document.documentElement;
          return `${document.getElementsByTagName('*').length} ${d.scrollWidth}x${d.scrollHeight} ${document.body?.scrollHeight}`;
        };
        const inView = (el) => {
          const r = el.getBoundingClientRect();
          return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
        };
        const busy = () =>
          document.fonts.status !== 'loaded' ||
          [...document.images].some((img) => !img.complete && inView(img)) ||
          document.getAnimations().some((a) => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming().endTime));
        let last = '';
        let since = 0;
        const tick = () => {
          const now = performance.now();
          const s = shape();
          if (s !== last || busy()) {
            last = s;
            since = now;
          }
          if (now - since >= quiet || now - t0 > max) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(() => requestAnimationFrame(tick));
      }),
    quiet,
    max,
  );

const colourScheme = (page, theme) => page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
/** A theme by the page's own attribute, as the app sets it (for layoutMatrix's `show`). */
export const dataTheme = (page, theme) => page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
/** The widths of a plain-viewport sweep (layoutMatrix's `widths`): a phone, a tablet, a laptop, the desktops. */
export const WIDTHS = [390, 768, 1024, 1440, 1920];

/**
 * The layout checks over a matrix: each theme × each state of `states` (`{ where: open(theme) }`, `open` puts the page
 * in that state, or null for the page as it is). `show(page, theme)` switches the theme (default: the colour-scheme
 * media feature). Without `widths` each state gets fitsAt's whole sweep; with `widths`, plain viewports of those widths
 * (`height` tall) and sideways / clipped / cut checks at each: for a state fitsAt's touch sizes would end (an open
 * dialog; emulating a phone reloads the page). `each(width, theme)` runs after every width (a screenshot). Returns the
 * problems, each named with where, width and theme; with `widths` the page ends at its own size again.
 */
export async function layoutMatrix(page, states, { themes = ['dark', 'light'], show = colourScheme, widths = null, height = 900, each } = {}) {
  const out = [];
  const own = page.viewport();
  for (const theme of themes) {
    await show(page, theme);
    for (const [where, open] of Object.entries(states)) {
      await open?.(theme);
      if (!widths) {
        out.push(...(await fitsAt(page, `${where} (${theme})`)));
        continue;
      }
      for (const width of widths) {
        await page.setViewport({ width, height });
        await settle(page);
        for (const b of [...(await sideways(page)), ...(await clippedText(page)), ...(await cutLabels(page))]) out.push(`${where} @${width} ${theme}: ${b}`);
        await each?.(width, theme);
      }
      if (own) await page.setViewport(own);
    }
  }
  return out;
}

// Sideways scrolling is only meant for the strips built for it (a settings snippet is one: its long lines scroll with a
// soft edge rather than break inside a token); anything else that scrolls sideways overflows, and a
// control that sticks out of the viewport outside a scroller can't be reached. Returns one line per problem. The
// player's strip and tools row are not scrollers any more: they fit a phone (a strip that scrolled cut "Safe zones"
// off at the screen's edge). The notes' tags are a line of chips built to scroll, with soft edges (.note-tagf), and so
// are the operator's table of sign-up weeks and its lists' filter chips on a narrow screen (.op-table-wrap, .op-chips).
export const sideways = (
  page,
  strips = '.dock-foot, .tabs, .reels, .tl-scroll, .set-nav, .lib-lanes, .board, .set-code pre, .note-tagf, .op-table-wrap, .op-chips',
) =>
  page.evaluate((strips) => {
    const vw = innerWidth;
    const out = [];
    if (document.documentElement.scrollWidth > vw + 1) out.push(`page is ${document.documentElement.scrollWidth}px wide`);
    const scrolls = (el) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (/(auto|scroll)/.test(getComputedStyle(p).overflowX)) return true;
      return false;
    };
    const hidden = (el) => {
      for (let p = el; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.display === 'none' || s.visibility === 'hidden') return true;
      }
      return false;
    };
    for (const el of document.querySelectorAll('*')) {
      if (!/(auto|scroll)/.test(getComputedStyle(el).overflowX) || el.matches(strips) || hidden(el)) continue;
      if (el.scrollWidth > el.clientWidth + 1 && el !== document.documentElement && el !== document.body)
        out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} scrolls sideways (${el.scrollWidth} > ${el.clientWidth})`);
    }
    for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role=tab], video, .ptc .main, .tc .main')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || hidden(el)) continue;
      if ((r.right > vw + 1 || r.left < -1) && !scrolls(el))
        out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} at ${Math.round(r.left)}–${Math.round(r.right)}`);
    }
    return out;
  }, strips);
