// Drawings live in video pixel coordinates (e.g. 1080×1920). The same markup is used for the on-screen overlay
// and for the burned-in _marked.png, so what the reviewer sees is exactly what the agent gets.
//   {type:"box", x, y, w, h}  {type:"arrow", x1, y1, x2, y2}  {type:"freehand", points:[[x,y],…]}
// Optional per shape: color (css color). Shared with the browser, so no Node imports here.
import type { Point, Shape } from './types.ts';

export const MARK_COLOR = '#ff2d55';

export const strokeFor = (w: number, h: number): number => Math.max(3, Math.round(Math.min(w, h) / 150));

const r = (n: number) => Math.round(n * 10) / 10;

function arrowHead(x1: number, y1: number, x2: number, y2: number, sw: number) {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const size = Math.min(sw * 5.5, len * 0.6);
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const bx = x2 - ux * size;
  const by = y2 - uy * size;
  const px = -uy * size * 0.55;
  const py = ux * size * 0.55;
  return { tip: [x2, y2] as Point, left: [bx + px, by + py] as Point, right: [bx - px, by - py] as Point, base: [bx, by] as Point };
}

// A colour goes into SVG markup as an attribute: only plain CSS colour syntax gets through (a review.json edited by
// hand could carry anything).
const CSS_COLOR = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d\s.,%/+-]+\)|[a-z]{3,20})$/i;
const safeColor = (c: unknown, fallback: string) => (typeof c === 'string' && CSS_COLOR.test(c) ? c : fallback);

export function shapeMarkup(shape: Shape, sw: number, color = MARK_COLOR): string {
  const c = safeColor(shape.color, safeColor(color, MARK_COLOR));
  const common = `fill="none" stroke="${c}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"`;
  const halo = `fill="none" stroke="rgba(0,0,0,0.55)" stroke-width="${sw * 2.2}" stroke-linecap="round" stroke-linejoin="round"`;
  switch (shape.type) {
    case 'box': {
      const a = `x="${r(shape.x)}" y="${r(shape.y)}" width="${r(shape.w)}" height="${r(shape.h)}" rx="${sw}"`;
      return `<rect ${a} ${halo}/><rect ${a} ${common}/>`;
    }
    case 'arrow': {
      const { x1, y1, x2, y2 } = shape;
      const h = arrowHead(x1, y1, x2, y2, sw);
      const line = `x1="${r(x1)}" y1="${r(y1)}" x2="${r(h.base[0])}" y2="${r(h.base[1])}"`;
      const pts = [h.tip, h.left, h.right].map((p) => p.map(r).join(',')).join(' ');
      return (
        `<line ${line} ${halo}/><polygon points="${pts}" fill="rgba(0,0,0,0.55)" stroke="rgba(0,0,0,0.55)" stroke-width="${sw * 1.2}" stroke-linejoin="round"/>` +
        `<line ${line} ${common}/><polygon points="${pts}" fill="${c}" stroke="${c}" stroke-width="${sw * 0.5}" stroke-linejoin="round"/>`
      );
    }
    case 'freehand': {
      const pts = (shape.points || []).map((p) => p.map(r).join(',')).join(' ');
      return `<polyline points="${pts}" ${halo}/><polyline points="${pts}" ${common}/>`;
    }
    default:
      return '';
  }
}

export function drawingMarkup(drawing: Shape[] | null | undefined, w: number, h: number, color?: string): string {
  const sw = strokeFor(w, h);
  return (drawing || []).map((s) => shapeMarkup(s, sw, color)).join('');
}

export function drawingSvg(drawing: Shape[] | null | undefined, w: number, h: number, color?: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${drawingMarkup(drawing, w, h, color)}</svg>`;
}

export function describeShape(s: Shape): string {
  const n = (v: number) => Math.round(v);
  if (s.type === 'box') return `box x${n(s.x)} y${n(s.y)} w${n(s.w)} h${n(s.h)}`;
  if (s.type === 'arrow') return `arrow ${n(s.x1)},${n(s.y1)} → ${n(s.x2)},${n(s.y2)}`;
  if (s.type === 'freehand') {
    const xs = s.points.map((p) => p[0]);
    const ys = s.points.map((p) => p[1]);
    return `freehand around x${n(Math.min(...xs))}–${n(Math.max(...xs))} y${n(Math.min(...ys))}–${n(Math.max(...ys))}`;
  }
  return (s as { type: string }).type;
}

// Keeps freehand strokes small in review.json: drop points closer than `min` px to the previous one.
export function simplifyPoints(points: readonly (readonly number[])[], min = 4): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= min) out.push([Math.round(p[0]), Math.round(p[1])]);
  }
  const end = points[points.length - 1];
  if (end && out.length && (out[out.length - 1][0] !== Math.round(end[0]) || out[out.length - 1][1] !== Math.round(end[1])))
    out.push([Math.round(end[0]), Math.round(end[1])]);
  return out;
}
