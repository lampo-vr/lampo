// SVG markup drawn over the paused frame, in video pixels: drawings of the notes on this frame, the picked
// Auto-check finding, and the region that changed since the previous version.

import { drawingMarkup } from '../../../lib/drawing.ts';
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

const label = (x: number, y: number, sw: number, color: string, text: string) =>
  `<text x="${x}" y="${y}" fill="${color}" font-size="${sw * 9}" font-family="Martian Mono Variable, monospace" style="paint-order:stroke;stroke:rgba(0,0,0,.7);stroke-width:${sw * 2}px">${text}</text>`;

export function frameMarks({ placed, frame, selected, W, H, diff, qaPick }: MarksInput) {
  const onFrame = (c: PlacedComment) => c.frameHere === frame || (!!c.rangeHere && frame >= c.rangeHere.in && frame <= c.rangeHere.out);
  const hits = placed.filter((c) => c.drawing?.length && (c.status === 'open' || c.status === 'fixed' || c.id === selected) && onFrame(c));
  let out = hits.map((c) => drawingMarkup(c.drawing, W, H, c.id === selected ? '#ff2d55' : 'rgba(255,45,85,0.75)')).join('');
  const sw = Math.max(2, Math.round(Math.min(W, H) / 300));
  if (qaPick?.box && frame >= qaPick.frame && frame <= (qaPick.range?.out ?? qaPick.frame)) {
    const { x, y, w, h } = qaPick.box;
    out += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${sw * 2}" fill="rgba(255,192,67,0.12)" stroke="#ffc043" stroke-width="${sw}" stroke-dasharray="${sw * 4} ${sw * 3}"/>`;
    out += label(x, Math.max(y - sw * 3, sw * 10), sw, '#ffc043', t('AUTO-CHECK'));
  }
  const ch = diff?.ranges?.find((r) => r.kind === 'video' && r.box && !r.whole && frame >= r.in && frame <= r.out);
  if (ch?.box && diff) {
    const { x, y, w, h } = ch.box;
    out += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="rgba(238,235,228,0.9)" stroke-width="${sw}" stroke-dasharray="${sw * 5} ${sw * 3}"/>`;
    out += label(x + sw * 2, Math.max(y - sw * 3, sw * 10), sw, '#eeebe4', t('CHANGED SINCE V{v}', { v: diff.old.v }));
  }
  return out;
}
