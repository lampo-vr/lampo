// Every size in the stylesheets is a step of the design system's scales (base.css): 7 type sizes, 3 weights, 3 line
// heights, 4-based spacing, 4 radii, the control heights, app-level layers and three shadows. A value off the scale
// fails with its file and line, so a new rule can't quietly add a 14th font size. Allowed besides the tokens: 0, 1px
// (hairlines), auto/inherit/normal, percentages and em for things that follow their text, and calc() of tokens.
// Colour literals are theme.test.ts's job.
import assert from 'node:assert/strict';
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
    tokens: ['sp-', 'h', 'h-', 'gutter', 'pad', 'safe'],
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
        const left = tokenOnly(rule.tokens)(value).filter((w) => !rule.also?.test(w));
        if (left.length) off.push(`${where} — ${rule.name}: ${left.join(' ')} is off the scale`);
      }
  assert.deepEqual(off, [], 'use the tokens in base.css (--fs-*, --fw-*, --lh-*, --sp-*, --r-*, --z-*, --shadow*/--raise)');
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
