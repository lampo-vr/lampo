// The Lampo identity is wired from one source (web/src/ui/brandMark.ts, docs/brand/): the name everywhere people read
// it, the logo and mark in the app, the PWA manifest and the icons at the sizes they are declared at, and a mark for
// every kind of agent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { AGENT_KIND_LABELS, AGENT_KINDS, agentKindOf, agentKindOfRef } from '../../lib/agentKind.ts';
import { BRAND_NAME as LIB_NAME } from '../../lib/brand.ts';
import { MCP_NAME } from '../../lib/mcpConfig.ts';
import { AGENT_LOGOS } from '../../web/src/ui/agentLogos.ts';
import { AGENT_MARKS } from '../../web/src/ui/agentMarks.ts';
import {
  BRAND_NAME,
  BRAND_ORANGE,
  FRAME_EXIT,
  FRAME_RING,
  FRAME_WINDOW,
  ICON_TILE,
  LOGO_LETTERS,
  LOGO_VIEWBOX,
  logoPaths,
  MARK_VIEWBOX,
  markPaths,
} from '../../web/src/ui/brandMark.ts';
import { readPng } from '../e2e/lib/png.mjs';

const ROOT = path.join(import.meta.dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const ICONS = path.join(ROOT, 'web/public/icons');

test('the name is Lampo, from one place', () => {
  assert.equal(BRAND_NAME, 'Lampo');
  assert.equal(LIB_NAME, BRAND_NAME);
  const html = read('web/index.html');
  assert.match(html, /<title>Lampo<\/title>/);
  assert.match(html, /apple-mobile-web-app-title" content="Lampo"/);
  assert.match(read('web/public/offline.html'), /<title>Lampo · offline<\/title>/);
});

test('agents know it as lampo: the MCP name and the Agent Skill; the skill’s old path still leads to it', () => {
  assert.equal(MCP_NAME, 'lampo');
  const skill = read('skills/lampo/SKILL.md');
  assert.match(skill, /^---\nname: lampo\n/, 'the frontmatter names the folder');
  // Anything that loads the skill from skills/video-review (a link made before the rename) gets the same file.
  assert.equal(read('skills/video-review/SKILL.md'), skill);
  // What stays: the package's name and its commands (installs and agents depend on them).
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, 'video-review');
  assert.deepEqual(Object.keys(pkg.bin).sort(), ['vr', 'vr-mcp']);
});

test('the app draws the kit’s geometry: the logo in Wordmark, the frame o in BrandMark, the window in --brand', () => {
  const src = read('web/src/ui/icons.tsx');
  const wordmark = src.slice(src.indexOf('export function Wordmark'), src.indexOf('\n}\n', src.indexOf('export function Wordmark')));
  const mark = src.slice(src.indexOf('export function BrandMark'), src.indexOf('\n}\n', src.indexOf('export function BrandMark')));
  for (const d of ['LOGO_LETTERS', 'FRAME_RING', 'FRAME_WINDOW', 'FRAME_EXIT']) assert.match(wordmark, new RegExp(`d=\\{${d}\\}`), `Wordmark draws ${d}`);
  assert.match(wordmark, /viewBox=\{LOGO_VIEWBOX\}/);
  assert.match(wordmark, /aria-label=\{BRAND_NAME\}/, 'the logo names its link');
  assert.match(mark, /viewBox=\{MARK_VIEWBOX\}/);
  assert.doesNotMatch(mark, /LOGO_LETTERS/, 'the mark is the frame o alone');
  assert.match(read('web/src/styles/layout.css'), /\.brand-window \{\s*fill: var\(--brand\);/);
  assert.match(read('web/src/styles/base.css'), new RegExp(`--brand: ${BRAND_ORANGE};`));
  // the markup helpers the icons script uses: one colour leaves the window out
  assert.ok(logoPaths('#000').includes(LOGO_LETTERS) && logoPaths('#000').includes(FRAME_WINDOW));
  assert.ok(!markPaths('#000', null).includes(FRAME_WINDOW) && markPaths('#000', null).includes(FRAME_RING));
  assert.deepEqual(MARK_VIEWBOX.split(' ').map(Number).slice(2), [124, 124], 'the mark sits in a square');
  assert.equal(LOGO_VIEWBOX.split(' ').length, 4);
});

test('docs/brand ships the kit: the same geometry, the icon masters’ palette, the favicon, the Norican licence', () => {
  assert.ok(read('docs/brand/lampo-logo-on-light.svg').includes(LOGO_LETTERS));
  const mark = read('docs/brand/lampo-mark-one-colour.svg');
  for (const d of [FRAME_RING, FRAME_EXIT]) assert.ok(mark.includes(d));
  for (const [name, t] of Object.entries(ICON_TILE)) {
    const master = read(`docs/brand/lampo-icon-${name}-1024.svg`);
    for (const c of [t.from, t.to, t.ink, BRAND_ORANGE]) assert.ok(master.includes(c), `${name} master has ${c}`);
  }
  assert.equal(read('web/public/icons/favicon.svg'), read('docs/brand/favicon.svg'), 'the SVG favicon is the kit’s');
  assert.match(read('docs/brand/OFL-Norican.txt'), /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(read('NOTICE.md'), /Norican/);
});

test('the manifest names Lampo, takes the icon tile’s colour, and every icon it lists exists at its size', () => {
  const m = JSON.parse(read('web/public/manifest.webmanifest'));
  assert.equal(m.name, BRAND_NAME);
  assert.equal(m.short_name, BRAND_NAME);
  assert.equal(m.background_color, ICON_TILE.light.from, 'the splash screen is the icon’s tile');
  assert.equal(m.theme_color, ICON_TILE.light.from);
  const listed = [...m.icons, ...m.shortcuts.flatMap((s: { icons: unknown[] }) => s.icons)] as { src: string; sizes: string }[];
  for (const i of listed) {
    const png = readPng(fs.readFileSync(path.join(ROOT, 'web/public', i.src)));
    assert.equal(`${png.width}x${png.height}`, i.sizes, i.src);
  }
  assert.deepEqual(m.icons.map((i: { purpose: string }) => i.purpose).sort(), ['any', 'any', 'maskable', 'maskable']);
});

/** Columns and rows of pixels that aren't the tile (the frame o, the window), as shares of the width. */
function glyphBox(file: string) {
  const png = readPng(fs.readFileSync(path.join(ICONS, file)));
  const { width, height, channels, data } = png;
  let [x0, x1, y0, y1] = [width, -1, height, -1];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * channels;
      const lum = (data[p] * 0.3 + data[p + 1] * 0.59 + data[p + 2] * 0.11) / 255;
      if (lum < 0.7) [x0, x1, y0, y1] = [Math.min(x0, x), Math.max(x1, x), Math.min(y0, y), Math.max(y1, y)];
    }
  return { w: (x1 - x0 + 1) / width, h: (y1 - y0 + 1) / height, cx: (x0 + x1 + 1) / 2 / width };
}

test('the icons: sizes, a maskable frame o within half the width, a full-bleed apple icon, a one-colour badge', () => {
  const sizes: Record<string, number> = {
    'icon-192.png': 192,
    'icon-512.png': 512,
    'maskable-192.png': 192,
    'maskable-512.png': 512,
    'apple-touch-icon.png': 180,
    'favicon-32.png': 32,
    'badge-96.png': 96,
  };
  for (const [f, n] of Object.entries(sizes)) {
    const png = readPng(fs.readFileSync(path.join(ICONS, f)));
    assert.deepEqual([png.width, png.height], [n, n], f);
  }
  for (const f of ['maskable-192.png', 'maskable-512.png']) {
    const g = glyphBox(f);
    assert.ok(g.w <= 0.5 && g.w > 0.4, `${f}: the frame o is ${(g.w * 100).toFixed(1)} % wide`);
  }
  // iOS wants no transparency: every corner is the tile
  const apple = readPng(fs.readFileSync(path.join(ICONS, 'apple-touch-icon.png')));
  assert.equal(apple.channels === 3 || apple.data[3] === 255, true, 'the apple icon is opaque in its corner');
  // the badge is one colour: every visible pixel is white, Android paints it from the alpha
  const badge = readPng(fs.readFileSync(path.join(ICONS, 'badge-96.png')));
  assert.equal(badge.channels, 4);
  let visible = 0;
  for (let i = 0; i < badge.data.length; i += 4)
    if (badge.data[i + 3] > 0) {
      visible++;
      assert.ok(badge.data[i] > 240 && badge.data[i + 1] > 240 && badge.data[i + 2] > 240, 'the badge has one colour');
    }
  assert.ok(visible > 500, 'the badge draws something');
});

test('every agent kind has a label and a mark; logos are single paths, fallbacks are monograms or glyphs', () => {
  assert.deepEqual(Object.keys(AGENT_MARKS).sort(), [...AGENT_KINDS].sort());
  assert.deepEqual(Object.keys(AGENT_KIND_LABELS).sort(), [...AGENT_KINDS].sort());
  for (const k of AGENT_KINDS) {
    const m = AGENT_MARKS[k];
    if (m.type === 'logo') assert.match(AGENT_LOGOS[m.logo], /^[Mm][\d.]/, `${k}: a path`);
    if (m.type === 'monogram') assert.ok(m.letters.length >= 1 && m.letters.length <= 3, `${k}: 1–3 letters`);
  }
  assert.equal(AGENT_MARKS.claude.type, 'logo');
  assert.equal(AGENT_MARKS['claude-code'].type, 'logo');
  for (const k of ['chatgpt', 'codex'] as const) assert.deepEqual([AGENT_MARKS[k].type, (AGENT_MARKS[k] as { owner?: string }).owner], ['logo', 'OpenAI'], k);
  assert.deepEqual(
    [AGENT_MARKS.mcp, AGENT_MARKS.api, AGENT_MARKS.cli],
    [
      { type: 'glyph', icon: 'plug' },
      { type: 'glyph', icon: 'key' },
      { type: 'glyph', icon: 'terminal' },
    ],
  );
  // the licence and the trademark note travel with the marks
  assert.match(read('NOTICE.md'), /Simple Icons/);
});

test('NOTICE says once where each mark comes from; TRADEMARKS claims Lampo and its logo only (A12 OSS-14)', () => {
  const notice = read('NOTICE.md');
  const current = /Simple Icons\*\* 16\.33\.0[\s\S]*?—\s+https:\/\/simpleicons\.org\s+—\s+for ([^;]+);/.exec(notice)?.[1] ?? '';
  assert.ok(current.includes('Claude'), `the 16.33.0 list: ${current}`);
  assert.doesNotMatch(current, /OpenAI/, 'OpenAI’s mark is from 15.22.0, the last release with it — not 16.33.0');
  assert.match(notice, /OpenAI['’]s mark[^.]*Simple Icons 15\.22\.0/);
  const tm = read('TRADEMARKS.md');
  assert.doesNotMatch(tm, /this policy covers that name too/, 'video-review is a plain description, not a mark');
  assert.match(tm, /`video-review`[^.]*not claimed/);
});

test('MCP clients are recognised by their own names; older assignments get a kind too', () => {
  const names: [string, string][] = [
    ['claude-code', 'claude-code'],
    ['Claude Code', 'claude-code'],
    ['codex-mcp-client', 'codex'],
    ['Cursor', 'cursor'],
    ['claude-ai', 'claude'],
    ['ChatGPT · Sam', 'chatgpt'],
    ['openai-mcp', 'chatgpt'],
    ['gemini-cli-mcp-client', 'gemini'],
    ['Visual Studio Code', 'vscode'],
    ['GitHub Copilot', 'vscode'],
    ['Antigravity', 'antigravity'],
    ['windsurf-client', 'windsurf'],
    ['Zed', 'zed'],
    ['authorized-tool', 'mcp'],
    ['', 'mcp'],
  ];
  for (const [name, kind] of names) assert.equal(agentKindOf(name), kind, name);
  assert.equal(agentKindOfRef({ name: 'x', id: 'abc', agent: 'api' }), 'api', 'a stored kind wins');
  assert.equal(agentKindOfRef({ name: 'Cursor · Sam', id: 'mcp-0123456789ab' }), 'cursor', 'an MCP client by its name');
  assert.equal(agentKindOfRef({ name: 'edit-session', id: '5b0c…' }), 'claude-code', 'before kinds: a Claude Code session');
  assert.equal(agentKindOfRef({ name: 'edit-session', id: null }), 'claude-code');
});
