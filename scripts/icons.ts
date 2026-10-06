// App icons for the home screen, the install prompt, the browser tab and notifications, drawn from the Lampo brand
// (web/src/ui/brandMark.ts, docs/brand/) and written to web/public/icons/. The tiles follow the kit's app icon masters
// (docs/brand/lampo-icon-light-1024.svg: the paper gradient, the ink frame o, the orange window, flat layers). Run after
// changing the brand:
//   node scripts/icons.ts
import fs from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { ROOT } from '../lib/paths.ts';
import { ICON_TILE, MARK_VIEWBOX, markPaths } from '../web/src/ui/brandMark.ts';

const OUT = path.join(ROOT, 'web/public/icons');
const BRAND = path.join(ROOT, 'docs/brand');

const [mx, my, side] = MARK_VIEWBOX.split(' ').map(Number);
/** The frame o's own width in its square (the rest is the optical margin; measured from the paths). */
const GLYPH_OF_BOX = 102.73 / side;

/**
 * One icon on a 100-unit canvas. `box`: the share of the width the mark's square takes, centred by its optical centre
 * as the kit does (0.744 in the masters); `round`: corner radius as a share of the width (0 = full bleed, the
 * platform rounds); `tile: null` leaves the background out and draws the mark in one colour (`ink`, hollow window).
 */
function icon(size: number, { box, round = 0, tile = 'light', ink }: { box: number; round?: number; tile?: 'light' | null; ink?: string }): Buffer {
  const k = (100 * box) / side;
  const tx = 50 - (mx + side / 2) * k;
  const ty = 50 - (my + side / 2) * k;
  const t = tile ? ICON_TILE[tile] : null;
  const bg = t
    ? `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.from}"/><stop offset="1" stop-color="${t.to}"/></linearGradient></defs><rect width="100" height="100" rx="${round * 100}" fill="url(#bg)"/>`
    : '';
  const mark = t ? markPaths(t.ink) : markPaths(ink ?? '#fff', null);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">${bg}<g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${k.toFixed(5)})">${mark}</g></svg>`;
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng());
}

// The masters' composition: the mark's square at 0.744 of the width, so the frame o is ~62 % wide.
const MASTER = 0.744;
// Maskable icons: the frame o at 48 % of the width, inside the 80 % circle Android may crop to (the kit: ≤ 50 %).
const MASKABLE = 0.48 / GLYPH_OF_BOX;

const files: [string, Buffer][] = [
  // "any": the master on a rounded tile (browsers and desktops show it as is).
  ['icon-192.png', icon(192, { box: MASTER, round: 0.22 })],
  ['icon-512.png', icon(512, { box: MASTER, round: 0.22 })],
  // "maskable": full bleed, the frame o small enough for any mask shape.
  ['maskable-192.png', icon(192, { box: MASKABLE })],
  ['maskable-512.png', icon(512, { box: MASKABLE })],
  // iOS rounds the corners itself and wants no transparency: the master, full bleed.
  ['apple-touch-icon.png', icon(180, { box: MASTER })],
  // A browser tab is small: the frame o larger on its tile.
  ['favicon-32.png', icon(32, { box: 0.76, round: 0.22 })],
  // Android paints the notification badge in one colour from its alpha: the frame o with a hollow window.
  ['badge-96.png', icon(96, { box: 0.96, tile: null, ink: '#fff' })],
];

fs.mkdirSync(OUT, { recursive: true });
for (const [name, png] of files) fs.writeFileSync(path.join(OUT, name), png);
// Browsers that take an SVG favicon get the kit's: the frame follows the tab's colour scheme, the window stays orange.
fs.copyFileSync(path.join(BRAND, 'favicon.svg'), path.join(OUT, 'favicon.svg'));
console.log(`wrote ${files.length + 1} icons to ${path.relative(ROOT, OUT)}`);
// Emails carry the app icon inline (lib/mail/index.ts, cid:lampo-icon): the tile reads on light and dark mail alike,
// shown at 32 px, drawn at 96 for sharp screens.
fs.writeFileSync(path.join(ROOT, 'lib/mail/icon.png'), icon(96, { box: MASTER, round: 0.22 }));
console.log('wrote lib/mail/icon.png');
