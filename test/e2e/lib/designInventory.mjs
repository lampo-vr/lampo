// The design audit's runtime collector, as a check: what a screen actually renders — every visible text's size and
// weight, every box's corners, every control's height — compared with the design system's scales (base.css). The CSS
// tests see the stylesheets; this sees the result (inline styles, em sizes, a library's defaults, calc()).

/** The scales, as computed values. */
export const SCALE = {
  // 11 · 12 · 13 · 15 · 18 · 24 · 36 · 56 (display: the invitation's title), and 16 for text fields on touch screens (iOS zooms into anything smaller)
  fontSize: [11, 12, 13, 15, 18, 24, 36, 56, 16],
  fontWeight: [400, 500, 650],
  // 4 · 8 · 12 and round (a pill or a circle), 2 for hairline marks, and the nested corners (base.css: a row in a menu
  // 3, an item in a track 5 — concentric() checks that they follow the corner around them)
  radius: [0, 2, 3, 4, 5, 8, 12],
  // 20 · 26 · 30 · 40, 44 on touch screens, 52 for the one way into a page (the invitation), and the items inside a segmented track (the track's height - 6)
  controlHeight: [20, 26, 30, 40, 44, 52, 24, 38],
  // icons in the control families (ui.css): 12 in chips and as a chevron, 14 beside 12 px type, 16, 20 alone in 40 px
  icon: [12, 14, 16, 20],
};

/**
 * Runs in the page: returns { fontSize, fontWeight, radius, controlHeight, icon } → [{ value, who }] for values off the
 * scale.
 * `allow` lists selectors whose sizes are drawn, not set (an avatar's initials scale with it, a phone mock); `root`, a
 * selector, looks only inside that element (one component: check mode's card).
 */
export function inventory({ scale, allow, root = null }) {
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
  const off = { fontSize: new Map(), fontWeight: new Map(), radius: new Map(), controlHeight: new Map(), icon: new Map() };
  const note = (kind, value, el) => {
    const m = off[kind];
    if (!m.has(value)) m.set(value, new Set());
    m.get(value).add(who(el));
  };
  const scope = root ? document.querySelector(root) : document.body;
  for (const el of scope ? scope.querySelectorAll('*') : []) {
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
  // an icon in a control family takes its size step (the family's own, whatever a screen asked for)
  const ICONS = ':is(.btn, .seg > button, .tabs > button, .menu button, .ch, .badge, .toast, .toast-act) > svg.icon';
  for (const ic of scope ? scope.querySelectorAll(ICONS) : []) {
    if (!vis(ic) || allowed(ic)) continue;
    // its box as set, not as drawn this moment (a toast scales in from 94 %)
    const w = parseFloat(getComputedStyle(ic).width);
    if (scale.icon && !near(w, scale.icon)) note('icon', `${+w.toFixed(2)}px`, ic.parentElement);
  }
  const out = {};
  for (const [k, m] of Object.entries(off)) out[k] = [...m].map(([value, set]) => ({ value, who: [...set].slice(0, 4) }));
  return out;
}

/**
 * Runs in the page: the colours the elements inside `root` paint themselves (text, fill, edge; not what they inherit
 * unchanged, not a picture's) that are no token's — every custom property of the page resolved where `root` stands
 * (an island has its own) — and no token's mix with transparency (`color-mix(…, transparent)` keeps a token's hue).
 * Returns [{ who, prop, value }].
 */
export function offTokens({ root }) {
  const box = document.querySelector(root);
  if (!box) return [{ who: root, prop: 'root', value: 'missing' }];
  // every token, resolved as a colour at the component (a probe takes its colour from it)
  const names = new Set();
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    const walk = (list) => {
      for (const r of list) {
        if (r.style) for (const p of r.style) if (p.startsWith('--')) names.add(p);
        if (r.cssRules) walk(r.cssRules);
      }
    };
    walk(rules);
  }
  const probe = document.createElement('i');
  box.append(probe);
  const rgb = (c) => {
    const m = /\d*\.?\d+/g;
    const v = c.match(m)?.map(Number) ?? [];
    return c.startsWith('color(srgb') ? v.slice(0, 3).map((x) => Math.round(x * 255)) : v.slice(0, 3);
  };
  const ok = [];
  for (const n of names) {
    probe.style.color = '';
    probe.style.color = `var(${n})`;
    const c = getComputedStyle(probe).color;
    if (c) ok.push(rgb(c));
  }
  probe.remove();
  const near = (a, b) => a.length === 3 && b.length === 3 && a.every((x, i) => Math.abs(x - b[i]) <= 1);
  const known = (c) => ok.some((k) => near(k, rgb(c)));
  const clear = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c) || /\/\s*0\)$/.test(c);
  const who = (el) => {
    const c = typeof el.className === 'string' ? el.className : el.className?.baseVal || '';
    return `${el.tagName.toLowerCase()}${c.trim() ? `.${c.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}`;
  };
  const out = [];
  for (const el of [box, ...box.querySelectorAll('*')]) {
    if (el.closest('svg') || el.matches('img, video, canvas')) continue;
    const s = getComputedStyle(el);
    const parent = el.parentElement ? getComputedStyle(el.parentElement) : null;
    const seen = [
      ['color', s.color, parent && s.color === parent.color],
      ['background-color', s.backgroundColor, false],
      ['border-color', +parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none' ? s.borderTopColor : '', false],
    ];
    for (const [prop, value, inherited] of seen) if (!inherited && !clear(value) && !known(value)) out.push({ who: who(el), prop, value });
  }
  return out;
}

/**
 * Runs in the page: corners that don't follow the curve around them. A rounded surface inset p inside a rounded
 * surface of radius R, within reach of its corner (p < R), gets the radius R − p (concentric: the gap stays even all
 * the way round — the segmented control's raised item in its track, a row in a menu, a chip on a poster's corner).
 * Further in, a corner is free. Controls whose fill shows on hover (buttons, segments, tabs, menu rows, chips) count as
 * surfaces at rest too. A container that clips (overflow) and holds its content flush needs nothing. Returns
 * [{ who, in, corners }]; `allow` lists selectors left out (drawings at their own scale); `root`, a selector, looks only
 * inside that element (and measures against the surfaces up to it).
 */
export function concentric({ allow = [], tolerance = 0.75, root = null } = {}) {
  const HOVER_FILL =
    '.btn, .seg > button, .tabs > button, .menu button, .menu [role=menuitem], .menu [role=menuitemcheckbox], .select-item, .chip, button.list-row';
  const px = parseFloat;
  const clear = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c) || /\/\s*0\)$/.test(c);
  const surface = (el, s) =>
    !s.maskImage?.startsWith('url') &&
    !s.webkitMaskImage?.startsWith('url') &&
    (el.matches(HOVER_FILL) ||
      !clear(s.backgroundColor) ||
      s.backgroundImage !== 'none' ||
      s.boxShadow !== 'none' ||
      ['Top', 'Right', 'Bottom', 'Left'].some((k) => px(s[`border${k}Width`]) > 0 && s[`border${k}Style`] !== 'none' && !clear(s[`border${k}Color`])));
  // a corner's radius as drawn: a pill's is half its short side
  const radii = (s, r) => {
    const cap = Math.min(r.width, r.height) / 2;
    return [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius].map((v) =>
      Math.min(v.endsWith('%') ? (px(v) / 100) * Math.min(r.width, r.height) : px(v), cap),
    );
  };
  const vis = (s, r) =>
    r.width >= 1 && r.height >= 1 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity !== 0 && r.bottom > 0 && r.top < innerHeight;
  const who = (el) => {
    const c = typeof el.className === 'string' ? el.className : el.className?.baseVal || '';
    return `${el.tagName.toLowerCase()}${c.trim() ? `.${c.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}`;
  };
  const out = new Map();
  const scope = root ? document.querySelector(root) : document.body;
  for (const el of scope ? scope.querySelectorAll('*') : []) {
    if (el.closest('svg') || allow.some((sel) => el.closest(sel))) continue;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (!vis(s, r) || !surface(el, s)) continue;
    // the nearest rounded surface around it
    let a = el.parentElement;
    let as = null;
    for (; a && a !== document.body; a = a.parentElement) {
      as = getComputedStyle(a);
      if (surface(a, as) && radii(as, a.getBoundingClientRect()).some((x) => x > 0.5)) break;
    }
    if (!a || a === document.body) continue;
    const ar = a.getBoundingClientRect();
    const R = radii(as, ar);
    const own = radii(s, r);
    const insets = [
      [r.left - ar.left, r.top - ar.top],
      [ar.right - r.right, r.top - ar.top],
      [ar.right - r.right, ar.bottom - r.bottom],
      [r.left - ar.left, ar.bottom - r.bottom],
    ];
    const bad = [];
    insets.forEach(([ix, iy], i) => {
      if (ix < -0.5 || iy < -0.5) return; // not inside it
      const inset = Math.max(ix, iy);
      if (inset >= R[i] - 0.5) return; // beyond the curve's reach: free
      if (inset < 0.5 && as.overflow !== 'visible') return; // flush in a box that clips it
      const want = R[i] - inset;
      if (Math.abs(own[i] - want) > tolerance)
        bad.push(
          `${['top-left', 'top-right', 'bottom-right', 'bottom-left'][i]} ${+own[i].toFixed(1)} px, wants ${+want.toFixed(1)} (${+R[i].toFixed(1)} − ${+inset.toFixed(1)})`,
        );
    });
    if (!bad.length) continue;
    const key = `${who(el)} in ${who(a)}: ${bad.join(', ')}`;
    out.set(key, { who: who(el), in: who(a), corners: bad.join(', ') });
  }
  return [...out.values()];
}
