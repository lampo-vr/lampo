// The design audit's runtime collector, as a check: what a screen actually renders — every visible text's size and
// weight, every box's corners, every control's height — compared with the design system's scales (base.css). The CSS
// tests see the stylesheets; this sees the result (inline styles, em sizes, a library's defaults, calc()).

/** The scales, as computed values. */
export const SCALE = {
  // 11 · 12 · 13 · 15 · 18 · 24 · 36 · 56 (display: the invitation's title), and 16 for text fields on touch screens (iOS zooms into anything smaller)
  fontSize: [11, 12, 13, 15, 18, 24, 36, 56, 16],
  fontWeight: [400, 500, 650],
  // 4 · 8 · 12 and round (a pill or a circle), 2 for hairline marks
  radius: [0, 2, 4, 8, 12],
  // 20 · 26 · 30 · 40, 44 on touch screens, 52 for the one way into a page (the invitation), and the items inside a segmented track (the track's height - 6)
  controlHeight: [20, 26, 30, 40, 44, 52, 24, 38],
};

/**
 * Runs in the page: returns { fontSize, fontWeight, radius, controlHeight } → [{ value, who }] for values off the scale.
 * `allow` lists selectors whose sizes are drawn, not set (an avatar's initials scale with it, a phone mock).
 */
export function inventory({ scale, allow }) {
  const CONTROLS = '.btn, .input, .select, .seg > button, .tabs > button, .chip, .vpick, .session-chip, .lib-display';
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity === 0) return false;
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };
  const who = (el) => {
    const c = typeof el.className === 'string' ? el.className : el.className?.baseVal || '';
    return `${el.tagName.toLowerCase()}${c.trim() ? `.${c.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}`;
  };
  const allowed = (el) => allow.some((sel) => el.closest(sel));
  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  const near = (v, list) => list.some((x) => Math.abs(v - x) < 0.5);
  const off = { fontSize: new Map(), fontWeight: new Map(), radius: new Map(), controlHeight: new Map() };
  const note = (kind, value, el) => {
    const m = off[kind];
    if (!m.has(value)) m.set(value, new Set());
    m.get(value).add(who(el));
  };
  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el) || allowed(el) || el.closest('svg')) continue;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (ownText(el)) {
      const fs = parseFloat(s.fontSize);
      if (!near(fs, scale.fontSize)) note('fontSize', `${+fs.toFixed(2)}px`, el);
      const fw = +s.fontWeight;
      if (!scale.fontWeight.includes(fw)) note('fontWeight', String(fw), el);
    }
    for (const c of [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius]) {
      if (c.endsWith('%')) continue;
      const v = parseFloat(c);
      // round: a pill or a circle (the radius reaches half the short side)
      if (!near(v, scale.radius) && v < Math.min(r.width, r.height) / 2 - 0.5) note('radius', `${+v.toFixed(2)}px`, el);
    }
    // the control families: buttons, fields, segmented items, tabs, chips, the version picker (not text links, rows or
    // cards that happen to be buttons)
    if (el.matches(CONTROLS)) {
      const h = Math.round(r.height);
      if (!near(h, scale.controlHeight)) note('controlHeight', `${h}px`, el);
    }
  }
  const out = {};
  for (const [k, m] of Object.entries(off)) out[k] = [...m].map(([value, set]) => ({ value, who: [...set].slice(0, 4) }));
  return out;
}
