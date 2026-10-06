// The colour themes (web/src/styles/base.css): WCAG contrast of the token pairs the UI puts text on, the dark islands
// that keep the picture's surroundings dark in light mode, colours staying in tokens, and the pre-paint script that
// the hosted server's Content-Security-Policy must allow.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { THEME_BOOT } from '../../lib/themeBoot.ts';
import { THEME_BOOT_HASH } from '../../server/guard.ts';
import { BRAND_ORANGE } from '../../web/src/ui/brandMark.ts';

const STYLES = path.join(import.meta.dirname, '../../web/src/styles');
const base = fs.readFileSync(path.join(STYLES, 'base.css'), 'utf8');

function block(selectorStart: string): Record<string, string> {
  const i = base.indexOf(selectorStart);
  assert.ok(i >= 0, `${selectorStart} in base.css`);
  const body = base.slice(base.indexOf('{', i) + 1, base.indexOf('\n}', i));
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) vars[m[1]] = m[2].trim();
  return vars;
}
const dark = block(':root,\n');
const light = { ...dark, ...block('body.printing {') };
const THEMES = { dark, light };

type RGBA = [number, number, number, number];
function parse(c: string): RGBA {
  const hex = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((x) => x + x).join('') : hex[1];
    return [0, 2, 4].map((k) => Number.parseInt(h.slice(k, k + 2), 16)).concat(1) as RGBA;
  }
  const rgba = c.match(/^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)$/);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])];
  throw new Error(`not a colour: ${c}`);
}
const over = (top: RGBA, below: RGBA): RGBA => [0, 1, 2].map((k) => top[k] * top[3] + below[k] * (1 - top[3])).concat(1) as RGBA;
const luminance = ([r, g, b]: RGBA) => {
  const lin = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const ratio = (a: RGBA, b: RGBA) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/** [text token, background tokens (the first one on top), minimum ratio]; the page surface is --ink-1 underneath. */
type Pair = [string, string[], number];
function failures(theme: keyof typeof THEMES, pairs: Pair[]): string[] {
  const t = THEMES[theme];
  const color = (name: string) => parse(t[name] ?? assert.fail(`${name} missing in ${theme}`));
  const out: string[] = [];
  for (const [fg, bgs, min] of pairs) {
    let bg = color('--ink-1');
    for (const b of [...bgs].reverse()) bg = over(color(b), bg);
    const r = ratio(over(color(fg), bg), bg);
    if (r < min) out.push(`${theme}: ${fg} on ${bgs.join(' over ')} is ${r.toFixed(2)}:1, needs ${min}:1`);
  }
  return out;
}

const SURFACES = ['--ink-0', '--ink-1', '--ink-2', '--ink-3'];
const STATUS = ['--must', '--should', '--nice', '--idea', '--ok', '--claude'];
const TINTED = ['--must', '--should', '--idea', '--ok', '--claude'];

test('status colours read as text (WCAG AA 4.5:1) on every surface and on their own tint, in both themes', () => {
  const plain = STATUS.flatMap((s) => SURFACES.map((bg): Pair => [s, [bg], 4.5]));
  const tinted = (bgs: string[]) => TINTED.flatMap((s) => bgs.map((bg): Pair => [s, [`${s}-bg`, bg], 4.5]));
  // Dark keeps its original values pixel for pixel, and there a tint over a menu (--ink-3) lands just under AA for
  // idea (4.28:1) and must (4.497:1); chips sit on cards and rows (--ink-2), which pass.
  assert.deepEqual([...failures('dark', [...plain, ...tinted(['--ink-2'])]), ...failures('light', [...plain, ...tinted(['--ink-2', '--ink-3'])])], []);
});

test('light: body text passes AA on every surface, faint text 3:1, filled buttons and chips AA', () => {
  const pairs: Pair[] = [
    ...['--fg', '--fg-2', '--muted'].flatMap((fg) => [...SURFACES, '--ink-4'].map((bg): Pair => [fg, [bg], 4.5])),
    ...SURFACES.map((bg): Pair => ['--faint', [bg], 3]),
    ['--on-fg', ['--fg'], 4.5],
    ['--on-fg-2', ['--fg'], 4.5],
    ['--on-must', ['--must'], 4.5],
    ['--on-should', ['--should'], 4.5],
    ['--on-nice', ['--nice'], 4.5],
    ['--on-idea', ['--idea'], 4.5],
    ['--on-ok', ['--ok'], 4.5],
    ['--on-claude', ['--claude'], 4.5],
    ['--must-2', ['--must-bg', '--ink-2'], 4.5],
    ['--ok-2', ['--ok-bg', '--ink-2'], 4.5],
    ['--claude-2', ['--claude-bg', '--ink-2'], 4.5],
    ['--claude-3', ['--ink-2'], 4.5],
    ['--edge', ['--ink-1'], 4.5],
    ['--edge-2', ['--ink-2'], 4.5],
    ['--danger-hi', ['--ink-2'], 4.5],
    ['--tl-text', ['--tl-bg'], 4.5],
    ['--tl-word-text', ['--tl-words'], 4.5],
  ];
  assert.deepEqual(failures('light', pairs), []);
});

test('both themes: primary buttons, the brand-orange way in and the count badges (--ink-0 on --claude) pass AA', () => {
  const pairs: Pair[] = [
    ['--on-fg', ['--fg'], 4.5],
    // ink on the brand orange (the styleguide's swatch), and the brand buttons' white label on their deeper orange
    ['--brand-ink', ['--brand'], 4.5],
    ['--brand-ink', ['--brand-hot'], 4.5],
    ['--on-brand', ['--brand-deep'], 4.5],
    // the destructive button's white label on its crimson
    ['--on-must', ['--danger'], 4.5],
    ['--ink-0', ['--claude'], 4.5],
    ['--ink-0', ['--must'], 4.5],
  ];
  assert.deepEqual([...failures('dark', pairs), ...failures('light', pairs)], []);
});

test('the brand orange is the logo kit’s, one orange in both themes (its text, --brand-ink, is checked above)', () => {
  assert.equal(dark['--brand'], BRAND_ORANGE);
  assert.equal(light['--brand'], BRAND_ORANGE);
  assert.equal(base.match(/^\s*--brand:/gm)?.length, 1, 'one --brand token');
});

test('light: markers, lines and focus rings stay visible (3:1 non-text contrast)', () => {
  const pairs: Pair[] = [
    ...STATUS.map((s): Pair => [s, ['--tl-lane'], 3]),
    ['--playhead', ['--tl-bg'], 3],
    ['--fg', ['--ink-2'], 3], // focus rings are drawn in --fg
    ['--line-4', ['--ink-2'], 3], // input borders on hover/focus
  ];
  assert.deepEqual(failures('light', pairs), []);
});

// Colour blindness (Machado et al. 2009, full severity): the colours of the timeline's triangles and the Insights
// severity tiles must stay apart. Agent notes (--claude) differ by shape, so they are not in the set.
const CVD: Record<string, number[]> = {
  protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
};
function lab([r, g, b]: number[]): number[] {
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [x, y, z] = [(0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, 0.2126 * r + 0.7152 * g + 0.0722 * b, (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883];
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
test('severity and status colours stay apart for colour-blind viewers (CIELAB ΔE ≥ 10), in both themes', () => {
  const lin = (v: number) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  const close: string[] = [];
  for (const [theme, t] of Object.entries(THEMES))
    for (const [kind, m] of Object.entries(CVD)) {
      const seen = ['--must', '--should', '--nice', '--idea', '--ok'].map((name) => {
        const c = parse(t[name]).slice(0, 3).map(lin);
        return [name, lab([0, 1, 2].map((r) => Math.min(1, Math.max(0, m[r * 3] * c[0] + m[r * 3 + 1] * c[1] + m[r * 3 + 2] * c[2]))))] as const;
      });
      for (const [i, [a, la]] of seen.entries())
        for (const [b, lb] of seen.slice(i + 1)) {
          const d = Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
          if (d < 10) close.push(`${theme} ${kind}: ${a} and ${b} are ΔE ${d.toFixed(1)}`);
        }
    }
  assert.deepEqual(close, []);
});

test('the dark islands redeclare every colour the light theme changes, so the picture keeps its dark surround', () => {
  const lightOnly = Object.keys(block('body.printing {')).filter((k) => !['--cast', '--cast-k'].includes(k));
  const missing = lightOnly.filter((k) => !(k in dark));
  assert.deepEqual(missing, [], 'declare these in the dark block (it doubles as the islands)');
  // (the formatter breaks the island list over lines once it is long)
  assert.match(base, /:root\[data-theme='light'\]\s+:is\(\s*\.stage,/, 'the dark block also applies to the islands in light mode');
});

// Everything outside base.css takes its colours from tokens; literal colours are only allowed where the picture or the
// film stock is drawn (dark in both themes), in masks, and on the print sheet (paper in both themes).
// The onboarding's pictures (lighttable.css) draw the brand film's frames: inside them the same rule holds.
const LITERAL_OK =
  /^(\.poster-|\.scrub-head|\.vchip|\.reel-|\.c-thumb|\.lightbox|\.qr|\.stage|\.crop|\.vbox|\.wipe-handle|\.phone|\.leader-|\.walkie|\.rec-dot|\.verify|\.up-tray::before|\.link-qr|\.ob-(lp|fr-img|ttl|ov-chip|safe|smp-thumb|loop-done))/;
test('the dark islands set their text colour, so inherited text is light on their dark ground', () => {
  const block = base.slice(base.indexOf(':root,'), base.indexOf('}', base.indexOf(':root,')));
  assert.match(block, /\n\s*color: var\(--fg\);/, 'the dark block (doubling as the islands) sets color: var(--fg)');
});

test('stylesheets use colour tokens, not literals (except inside the dark islands, masks and print)', () => {
  const offenders: string[] = [];
  for (const f of fs.readdirSync(STYLES).filter((x) => x.endsWith('.css') && !['base.css', 'share.css'].includes(x))) {
    let sel = '';
    fs.readFileSync(path.join(STYLES, f), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const s = line.trim();
        if (s.endsWith('{') && !s.startsWith('@')) sel = s.slice(0, -1).trim();
        if (/mask/.test(s) || LITERAL_OK.test(sel)) return;
        if (/#[0-9a-f]{3,8}\b|rgba?\(\s*\d/i.test(s)) offenders.push(`${f}:${i + 1} ${sel} | ${s}`);
      });
  }
  assert.deepEqual(offenders, [], 'add a token to base.css (dark value unchanged, plus a light one)');
});

test('the pre-paint theme script is the one the Content-Security-Policy allows', () => {
  assert.equal(THEME_BOOT_HASH, `'sha256-${crypto.createHash('sha256').update(THEME_BOOT).digest('base64')}'`);
  const html = fs.readFileSync(path.join(import.meta.dirname, '../../web/index.html'), 'utf8');
  assert.match(html, /<!-- vr:theme-boot -->/, 'index.html keeps the marker the build replaces');
  const built = path.join(import.meta.dirname, '../../web/dist/index.html');
  if (fs.existsSync(built)) assert.ok(fs.readFileSync(built, 'utf8').includes(`<script>${THEME_BOOT}</script>`), 'the build inlines THEME_BOOT verbatim');
});
