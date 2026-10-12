// SVG markup drawn over the paused frame, in video pixels: drawings of the notes on this frame, the picked
// Auto-check finding, and the region that changed since the previous version.
//
// The picture under the marks can be anything (a white ad, a black title card, a busy shot), so nothing is drawn in one
// colour straight onto it: a box is a light (or Auto-check's yellow) dash over a dark line, as the notes' drawings are
// (lib/drawing.ts), and a label is a dark chip with light words. The chip is the stage's material, dark in both themes
// like everything floating on the stage (ui-look.md); its colours are literals, not the theme's tokens, because they
// are painted in video pixels on the picture, which looks the same in both themes.

import { drawingMarkup } from '../../../lib/drawing.ts';
import type { Rect } from '../../../lib/types.ts';
import type { Diff, PlacedComment, QaItem } from '../api/types.ts';
import { t } from '../i18n/index.ts';

interface MarksInput {
  placed: PlacedComment[];
  frame: number;
  selected: string | null;
  W: number;
  H: number;
  diff: Diff | null;
  qaPick: QaItem | null;
}

const HALO = 'rgba(0,0,0,0.55)';
const LIGHT = '#eeebe4';
const AUTO_CHECK = '#ffc043';
// --ink-2 at 90 % and a ring of the light words at 16 %
const CHIP = 'rgba(19,19,20,0.9)';
const CHIP_RING = 'rgba(238,235,228,0.16)';
const FONT = 'Martian Mono Variable, monospace';
// Martian Mono, in em: every glyph is 0.7 wide and the capitals 0.8 tall (measured in Chrome). The words are held to
// that width (textLength), so the chip fits them in any language, and also in the fallback face before the font loads.
const ADVANCE = 0.7;
const CAP = 0.8;
// the chip's room around the words, in em: above and below the capitals (an umlaut's dots reach 0.25 above them), and
// to each side
const PAD_Y = 0.45;
const PAD_X = 0.5;

const r = (n: number) => Math.round(n * 10) / 10;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A box that reads on any picture: its line over a dark one a little wider, both inside the frame (a box along its
 * edge would draw half of them past it, on the stage). `fill` tints the inside. */
const box = (b: Rect, sw: number, W: number, H: number, stroke: string, dash: string, rx = 0, fill = 'none') => {
  const halo = sw * 2.2;
  const x = Math.max(b.x, halo / 2);
  const y = Math.max(b.y, halo / 2);
  const w = Math.min(b.x + b.w, W - halo / 2) - x;
  const h = Math.min(b.y + b.h, H - halo / 2) - y;
  const at = `x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" rx="${rx}"`;
  return `<rect ${at} fill="${fill}" stroke="${HALO}" stroke-width="${r(halo)}"/><rect ${at} fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-dasharray="${dash}"/>`;
};

/**
 * The label of a box: its words on a dark chip by the box's left edge, above the box where there is room, else below
 * it, so it never covers what the box points at (a finding's words); only a box with no room on either side (nearly the
 * frame's height) has it inside its top-left corner. The chip stays inside the frame: moved left at the right edge, and
 * smaller on a frame too narrow for it.
 */
export function boxLabel(b: Rect, sw: number, W: number, H: number, text: string, color = LIGHT): string {
  const n = [...text].length;
  const gap = sw * 2;
  const fs = Math.min(sw * 9, (W - gap * 2) / (n * ADVANCE + PAD_X * 2));
  const tw = n * ADVANCE * fs;
  const cw = tw + PAD_X * 2 * fs;
  const ch = (CAP + PAD_Y * 2) * fs;
  const above = b.y - gap - ch;
  const below = b.y + b.h + gap;
  const at = above >= gap ? above : below + ch <= H - gap ? below : null;
  const x = clamp(at === null ? b.x + gap : b.x, gap, W - gap - cw);
  const y = clamp(at ?? b.y + gap, gap, H - gap - ch);
  return (
    `<g data-mark-label=""><rect x="${r(x)}" y="${r(y)}" width="${r(cw)}" height="${r(ch)}" rx="${r(fs * 0.3)}" fill="${CHIP}" stroke="${CHIP_RING}" stroke-width="${r(Math.max(1, sw / 2))}"/>` +
    `<text x="${r(x + PAD_X * fs)}" y="${r(y + (PAD_Y + CAP) * fs)}" fill="${color}" font-size="${r(fs)}" font-weight="500" font-family="${FONT}" textLength="${r(tw)}" lengthAdjust="spacingAndGlyphs">${esc(text)}</text></g>`
  );
}

export function frameMarks({ placed, frame, selected, W, H, diff, qaPick }: MarksInput) {
  const onFrame = (c: PlacedComment) => c.frameHere === frame || (!!c.rangeHere && frame >= c.rangeHere.in && frame <= c.rangeHere.out);
  const hits = placed.filter((c) => c.drawing?.length && (c.status === 'open' || c.status === 'fixed' || c.id === selected) && onFrame(c));
  let out = hits.map((c) => drawingMarkup(c.drawing, W, H, c.id === selected ? '#ff2d55' : 'rgba(255,45,85,0.75)')).join('');
  const sw = Math.max(2, Math.round(Math.min(W, H) / 300));
  if (qaPick?.box && frame >= qaPick.frame && frame <= (qaPick.range?.out ?? qaPick.frame)) {
    const b = qaPick.box;
    out += `<g data-mark="auto-check">${box(b, sw, W, H, AUTO_CHECK, `${sw * 4} ${sw * 3}`, sw * 2, 'rgba(255,192,67,0.12)')}${boxLabel(b, sw, W, H, t('AUTO-CHECK'), AUTO_CHECK)}</g>`;
  }
  const ch = diff?.ranges?.find((x) => x.kind === 'video' && x.box && !x.whole && frame >= x.in && frame <= x.out);
  if (ch?.box && diff) {
    out += `<g data-mark="changed">${box(ch.box, sw, W, H, LIGHT, `${sw * 5} ${sw * 3}`)}${boxLabel(ch.box, sw, W, H, t('CHANGED SINCE V{v}', { v: diff.old.v }))}</g>`;
  }
  return out;
}
