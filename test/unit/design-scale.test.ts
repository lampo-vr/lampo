// Every size in the stylesheets is a step of the design system's scales (base.css): 7 type sizes, 3 weights, 3 line
// heights, 4-based spacing, 4 radii, the control heights, app-level layers and three shadows. A value off the scale
// fails with its file and line, so a new rule can't quietly add a 14th font size. Allowed besides the tokens: 0, 1px
// (hairlines), auto/inherit/normal, percentages and em for things that follow their text, and calc() of tokens.
// Colour literals are theme.test.ts's job.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parseCss, stylesheets } from '../lib/css.ts';

/** base.css defines the scales; every other sheet uses them — except phone.css, which draws other devices' interfaces
 * inside the phone view's frame (a status bar, an app's buttons) at those devices' own sizes, in their points, and
 * lighttable.css, the setup's pictures: drawings on a 640 × 520 sheet that one scale fits to the panel (their sizes are
 * the drawing's, never the UI's). */
const sheets = stylesheets().filter((f) => !['base.css', 'phone.css', 'lighttable.css'].includes(path.basename(f)));

const KEYWORD = /^(0|auto|inherit|initial|unset|normal|none|revert|1px|-1px|100%|50%)$/;
const tokenOnly = (prefixes: string[]) => (v: string) =>
  v
    .replace(/env\([^)]*\)/g, '')
    .replace(/var\(--([\w-]+)(?:,[^)]*)?\)/g, (m, name: string) => (prefixes.some((p) => name.startsWith(p)) ? '' : m))
    .replace(/calc\(|max\(|min\(|clamp\(|[(),]|[*/+-]|\b\d*\.?\d+\b(?!px|rem|%|em|vh|vw|dvh|ch)/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !KEYWORD.test(w) && !/^(max|min|clamp)\($/.test(w) && !WIDTH.test(w));
/** Widths in centring maths (`max(32px, (100% - 1180px) / 2)`) are measures of the page, not steps of spacing. */
const WIDTH = /^\(?\d{3,}px$/;

// What may stand in each property besides the tokens with these prefixes.
const RULES: { props: RegExp; tokens: string[]; also?: RegExp; name: string }[] = [
  { name: 'font size', props: /^font-size$/, tokens: ['fs-'], also: /^(\d*\.?\d+em|\d+%|smaller|larger)$/ },
  { name: 'font weight', props: /^font-weight$/, tokens: ['fw-'], also: /^(bold|bolder|lighter)$/ },
  { name: 'line height', props: /^line-height$/, tokens: ['lh-', 'h', 'h-'], also: /^(1|0)$/ },
  {
    name: 'spacing',
    props: /^(padding|margin|gap|row-gap|column-gap)(-(top|right|bottom|left|inline|block)(-(start|end))?)?$/,
    tokens: ['sp-', 'h', 'h-', 'gutter', 'pad', 'safe', 'track-pad'],
    also: /^(-?\d*\.?\d+(em|vh|dvh)|\d+%|,)$/,
  },
  { name: 'radius', props: /^border(-(top|bottom)-(left|right))?-radius$/, tokens: ['r-', 'r', 'radius'], also: /^(\d+%|-?1px|2px)$/ },
  { name: 'shadow', props: /^box-shadow$/, tokens: ['shadow', 'raise', 'press', 'focus-ring', 'sunk'] },
  { name: 'layer', props: /^z-index$/, tokens: ['z-'], also: /^-?\d$/ },
];

/** A shadow on the scale is a token, or a ring (a spread with no blur and no offset: a border that takes no room, a
 * halo, a mat around a picture) or a 1 px edge. */
const RING = /^(inset )?0 0 0 (0\.5|1|1\.5|2|3|4|5|6|7|8|9|10)px .+$|^(inset )?0 -?1px 0 .+$/;
const shadowOk = (v: string) =>
  v === 'none' || splitShadows(v).every((s) => RING.test(s.trim()) || /^var\(--(shadow|raise|press|focus-ring|sunk)[\w-]*\)$/.test(s.trim()));
function splitShadows(v: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of v) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** The `font` shorthand: its weight and size must be tokens too. */
const fontShorthandOk = (v: string) => !/(^|\s)\d{3}(\s|$)/.test(v) && !/\b\d*\.?\d+(px|rem)\b/.test(v);

test('every size, weight, space, radius, layer and shadow is on the design system’s scales', () => {
  const off: string[] = [];
  for (const f of sheets)
    for (const r of parseCss(f))
      for (const d of r.decls) {
        if (d.prop.startsWith('--')) continue;
        const where = `${path.basename(f)}:${d.line} ${r.selectors[0]} { ${d.prop}: ${d.value} }`;
        const value = d.value.replace(/\s*!important$/, '');
        if (d.prop === 'font') {
          if (!fontShorthandOk(value)) off.push(`${where} — font: use var(--fw-*) var(--fs-*)`);
          continue;
        }
        if (d.prop === 'box-shadow') {
          if (!shadowOk(value)) off.push(`${where} — shadow: a token (--shadow*, --raise*, --press, --sunk, --focus-ring) or a ring`);
          continue;
        }
        const rule = RULES.find((x) => x.props.test(d.prop));
        if (!rule) continue;
        // a concentric corner: an outer radius less the inset to it (spacing tokens, an edge's 1 px)
        const concentric = rule.name === 'radius' && /^calc\(var\(--(r|radius)[\w-]*\) - /.test(value);
        const left = tokenOnly(concentric ? [...rule.tokens, 'sp-', 'track-pad'] : rule.tokens)(value).filter((w) => !rule.also?.test(w));
        if (left.length) off.push(`${where} — ${rule.name}: ${left.join(' ')} is off the scale`);
      }
  assert.deepEqual(off, [], 'use the tokens in base.css (--fs-*, --fw-*, --lh-*, --sp-*, --r-*, --z-*, --shadow*/--raise)');
});

// ---------------------------------------------------------------- nested corners and focus rings

const STYLES_DIR = path.join(import.meta.dirname, '../../web/src/styles');
const rulesOf = (file: string) => parseCss(path.join(STYLES_DIR, file));
/** The tokens as base.css's :root declares them (the first declaration wins: the dark set and the scales). */
const TOKENS: Record<string, string> = {};
for (const r of rulesOf('base.css'))
  if (r.selectors.includes(':root') && !r.at.length) for (const d of r.decls) if (d.prop.startsWith('--') && !(d.prop in TOKENS)) TOKENS[d.prop] = d.value;
/** A length in px: tokens resolved, calc() worked out (px only; what isn't a length is NaN). */
function px(value: string): number {
  let v = value.trim();
  for (let i = 0; i < 20 && v.includes('var('); i++) v = v.replace(/var\((--[\w-]+)\)/g, (_, name: string) => TOKENS[name] ?? 'NaN');
  const maths = v.replace(/calc\(/g, '(').replace(/(\d*\.?\d+)px/g, '$1');
  if (!/^[\d\s.+\-*/()]+$/.test(maths)) return Number.NaN;
  return arithmetic(maths);
}
/** + − × ÷ and parentheses over plain numbers, as calc() works them out. */
function arithmetic(src: string): number {
  const tokens = src.match(/\d*\.\d+|\d+|[-+*/()]/g) ?? [];
  let i = 0;
  const atom = (): number => {
    const t = tokens[i++];
    if (t === '(') {
      const v = sum();
      i++; // ')'
      return v;
    }
    if (t === '-') return -atom();
    return Number(t);
  };
  const product = (): number => {
    let v = atom();
    while (tokens[i] === '*' || tokens[i] === '/') v = tokens[i++] === '*' ? v * atom() : v / atom();
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (tokens[i] === '+' || tokens[i] === '-') v = tokens[i++] === '+' ? v + product() : v - product();
    return v;
  };
  return sum();
}
/** A declaration of a rule (the selector exactly as written), outside media queries. */
function decl(file: string, selector: string, prop: string): string | undefined {
  for (const r of rulesOf(file)) if (!r.at.length && r.selectors.includes(selector)) for (const d of r.decls) if (d.prop === prop) return d.value;
  return undefined;
}
const edgeOf = (file: string, selector: string) => {
  const border = decl(file, selector, 'border');
  return border ? px(border.split(' ')[0]) : 0;
};
const firstOf = (v: string | undefined) => px(splitFirst(v ?? '0'));
function splitFirst(v: string): string {
  let depth = 0;
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '(') depth++;
    if (v[i] === ')') depth--;
    if (v[i] === ' ' && depth === 0) return v.slice(0, i);
  }
  return v;
}

/**
 * Raised and filled things inside rounded ones, where they sit within the outer curve's reach: [file, container,
 * item, the inset from the container's edge to the item]. The item's corner is the container's less that inset, so the
 * gap stays even along the curve (designInventory.mjs concentric() checks what screens render).
 */
const NESTED: { file: string; outer: string; inner: string; inset: () => number; outerFile?: string }[] = [
  { file: 'controls.css', outer: '.seg', inner: '.seg button', inset: () => edgeOf('controls.css', '.seg') + firstOf(decl('controls.css', '.seg', 'padding')) },
  {
    file: 'controls.css',
    outer: '.tabs',
    inner: '.tabs button',
    inset: () => edgeOf('controls.css', '.tabs') + firstOf(decl('controls.css', '.tabs', 'padding')),
  },
  {
    file: 'overlays.css',
    outer: '.menu',
    inner: '.menu button',
    inset: () => edgeOf('overlays.css', '.menu') + firstOf(decl('overlays.css', '.menu', 'padding')),
  },
  {
    file: 'primitives.css',
    outerFile: 'overlays.css',
    outer: '.menu',
    inner: '.select-item',
    inset: () => edgeOf('overlays.css', '.menu') + firstOf(decl('overlays.css', '.menu', 'padding')),
  },
  {
    file: 'drawbar.css',
    outer: '.draw-bar',
    inner: '.draw-bar .btn',
    inset: () => edgeOf('drawbar.css', '.draw-bar') + firstOf(decl('drawbar.css', '.draw-bar', 'padding')),
  },
  { file: 'code.css', outer: '.set-code', inner: '.set-copy', inset: () => firstOf(decl('code.css', '.set-copy', 'margin')) },
  { file: 'cards.css', outer: '.film-poster', inner: '.vchip', inset: () => px(decl('cards.css', '.film-over', 'left') ?? 'NaN') },
  { file: 'notes.css', outer: '.verify-cta', inner: '.verify-cta > .btn', inset: () => firstOf(decl('notes.css', '.verify-cta', 'padding')) },
  { file: 'library.css', outer: '.lane', inner: '.bcard', inset: () => firstOf(decl('library.css', '.lane', 'padding')) },
  // Get started's box at the sidebar's foot: the next step is its raised button, inset by the box's padding
  {
    file: 'onboarding.css',
    outer: '.ob-sn',
    inner: '.ob-sn-step',
    inset: () => edgeOf('onboarding.css', '.ob-sn') + firstOf(decl('onboarding.css', '.ob-sn', 'padding')),
  },
  // billing's switch: one raised thumb that slides in the segmented track
  {
    file: 'billing.css',
    outerFile: 'controls.css',
    outer: '.seg',
    inner: '.bill-thumb',
    inset: () => edgeOf('controls.css', '.seg') + px(decl('billing.css', '.bill-thumb', 'top') ?? 'NaN'),
  },
];

test('a raised or filled thing inside a rounded one has the outer corner less its inset (concentric corners)', () => {
  const off: string[] = [];
  for (const n of NESTED) {
    const R = px(decl(n.outerFile ?? n.file, n.outer, 'border-radius') ?? 'NaN');
    const r = px(decl(n.file, n.inner, 'border-radius') ?? 'NaN');
    const inset = n.inset();
    if (!(Number.isFinite(R) && Number.isFinite(r) && Number.isFinite(inset))) off.push(`${n.inner} in ${n.outer}: can't read R ${R}, r ${r}, inset ${inset}`);
    else if (Math.abs(r - (R - inset)) > 0.01) off.push(`${n.file} ${n.inner}: ${r} px in ${n.outer} (${R} px, inset ${inset} px) — wants ${R - inset}`);
  }
  assert.deepEqual(off, []);
  // the tokens say the same: an item in a track, a row in a menu
  assert.equal(px('var(--r-track-in)'), px('var(--r)') - 1 - px('var(--track-pad)'));
  assert.equal(px('var(--r-menu-in)'), px('var(--r)') - 1 - px('var(--sp-1)'));
});

test('every focus ring is the one ring: --focus-width in the text colour (the brand’s on the way in), on the focus offsets', () => {
  const off: string[] = [];
  for (const f of stylesheets())
    for (const r of parseCss(f)) {
      if (!r.selectors.some((s) => /:focus/.test(s))) continue;
      for (const d of r.decls) {
        const where = `${path.basename(f)}:${d.line} ${r.selectors[0]} { ${d.prop}: ${d.value} }`;
        if (d.prop === 'outline' && !/^(none|0)$/.test(d.value) && !/^var\(--focus-width\) solid var\((--fg|--brand|--focus, var\(--fg\))\)$/.test(d.value))
          off.push(`${where} — outline: var(--focus-width) solid var(--fg)`);
        if (d.prop === 'outline-width') off.push(`${where} — set the whole outline from the tokens`);
        if (d.prop === 'outline-offset' && !/^(0|var\(--focus-offset\)|var\(--focus-inset\))$/.test(d.value))
          off.push(`${where} — outline-offset: var(--focus-offset), var(--focus-inset) or 0 (in a track)`);
      }
    }
  assert.deepEqual(off, []);
});

test('a theme island (.theme-dark, .theme-light) takes its theme’s colours and works out what is made from them', () => {
  const base = fs.readFileSync(path.join(STYLES_DIR, 'base.css'), 'utf8');
  const selectorsOf = (needle: string) => {
    const i = base.indexOf(needle);
    return base.slice(base.lastIndexOf('}', i) + 1, base.indexOf('{', i)).replace(/\s+/g, ' ');
  };
  assert.match(selectorsOf('--ink-0: #070707'), /\.theme-dark/, 'the dark set applies to .theme-dark');
  assert.match(selectorsOf('--ink-0: #e9e5dc'), /\.theme-light/, 'the light set applies to .theme-light');
  assert.match(selectorsOf('--cast: #000'), /\.theme-dark, \.theme-light, :root/, 'the derived tokens are worked out again on an island');
});

test('the scale check catches what it should', () => {
  const check = (css: string) => {
    const rules = parseCss('x.css', css);
    return rules.flatMap((r) => r.decls);
  };
  const [size, space, radius] = check('.a { font-size: 14px; padding: 6px var(--sp-2); border-radius: 6px; }');
  assert.ok(tokenOnly(['fs-'])(size.value).length, 'a literal font size');
  assert.deepEqual(tokenOnly(['sp-'])(space.value), ['6px'], 'a literal padding next to a token');
  assert.ok(tokenOnly(['r-'])(radius.value).length);
  assert.deepEqual(tokenOnly(['sp-'])('calc(var(--sp-2) + 1px)'), []);
  assert.ok(shadowOk('0 0 0 1px var(--line)') && shadowOk('var(--raise)') && !shadowOk('0 4px 12px rgba(0,0,0,.3)'));
  assert.ok(fontShorthandOk('var(--fw-ui) var(--fs-sm) / var(--lh-ui) var(--ui)') && !fontShorthandOk('600 12px var(--ui)'));
});
