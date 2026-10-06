// One labelled contact sheet of shots: each shot's best keyframe, three to a row, its id and in point on it — what an
// agent looks at once instead of a grid per clip (≈ 480 tokens for six, bench/footage/RESULTS.md). The labels are drawn
// as pixels of a tiny built-in font (an SVG of squares rendered by resvg): no font file on the server, nothing for
// ffmpeg's drawtext to need.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { FFMPEG, run } from '../probe.ts';
import { grabFrame } from '../shots.ts';
import * as store from '../store.ts';
import { timecode } from '../time.ts';
import { thumbFile } from './db.ts';
import type { FootageShot } from './types.ts';

// 5 × 7 glyphs, rows top to bottom: what a label needs ("s412 00:20:14").
const GLYPHS: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  s: ['00000', '00000', '01111', '10000', '01110', '00001', '11110'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

/** An SVG of the labels (white pixels on a dark box) at the sheet's size, transparent elsewhere. */
export function labelsSvg(width: number, height: number, labels: { x: number; y: number; text: string }[], px = 2): string {
  const parts: string[] = [];
  for (const l of labels) {
    const chars = [...l.text].filter((c) => GLYPHS[c]);
    const w = chars.length * 6 * px - px;
    parts.push(`<rect x="${l.x}" y="${l.y}" width="${w + 8}" height="${7 * px + 8}" fill="#000" fill-opacity="0.72"/>`);
    chars.forEach((c, i) => {
      (GLYPHS[c] as string[]).forEach((row, y) => {
        for (let x = 0; x < 5; x++)
          if (row[x] === '1') parts.push(`<rect x="${l.x + 4 + (i * 6 + x) * px}" y="${l.y + 4 + y * px}" width="${px}" height="${px}" fill="#fff"/>`);
      });
    });
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join('')}</svg>`;
}

/** A shot's picture for the sheet: its keyframe's thumbnail, or (not indexed that far yet) the frame grabbed now. */
async function tile(shot: FootageShot, render: string, work: string, i: number): Promise<string> {
  const thumb = thumbFile(render, shot.frame);
  if (fs.existsSync(thumb)) return thumb;
  const review = store.loadReview(shot.video);
  if (!review) throw new Error(`no video ${shot.video}`);
  const file = await store.ensureVersionFile(review, shot.v);
  if (!file) throw new Error(`the bytes of ${shot.name} v${shot.v} are gone`);
  const ver = review.versions.find((v) => v.v === shot.v);
  const out = path.join(work, `grab_${i}.jpg`);
  return grabFrame(file, shot.frame, { ...(review.meta || {}), ...(ver ?? {}), fps: shot.fps, width: shot.width, height: shot.height }, out, { side: 360 });
}

/** The contact sheet of these shots (in this order) as a JPEG at `out`: its size in px. */
export async function contactSheet(items: { shot: FootageShot; render: string }[], out: string): Promise<{ width: number; height: number }> {
  if (!items.length) throw new Error('no shots for a contact sheet');
  const tall = items.every((x) => x.shot.height > x.shot.width);
  const [cw, ch] = tall ? [180, 320] : [320, 180];
  const n = items.length;
  const cols = Math.min(3, n);
  const rows = Math.ceil(n / cols);
  const gap = 4;
  const width = cols * (cw + gap) - gap;
  const height = rows * (ch + gap) - gap;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-footage-sheet-'));
  try {
    const tiles: string[] = [];
    for (const [i, x] of items.entries()) tiles.push(await tile(x.shot, x.render, work, i));
    const at = (i: number) => ({ x: (i % cols) * (cw + gap), y: Math.floor(i / cols) * (ch + gap) });
    const labels = items.map((x, i) => ({ ...at(i), x: at(i).x + 4, y: at(i).y + 4, text: `${x.shot.id} ${timecode(x.shot.in, x.shot.fps)}` }));
    const png = path.join(work, 'labels.png');
    fs.writeFileSync(png, new Resvg(labelsSvg(width, height, labels), { background: 'rgba(0,0,0,0)' }).render().asPng());
    const cells = tiles.map(
      (_, i) => `[${i}:v]scale=${cw}:${ch}:force_original_aspect_ratio=decrease,pad=${cw}:${ch}:(ow-iw)/2:(oh-ih)/2:0x202020,setsar=1[c${i}]`,
    );
    const layout = tiles.map((_, i) => `${at(i).x}_${at(i).y}`).join('|');
    const stack = n === 1 ? '[c0]copy[s]' : `${tiles.map((_, i) => `[c${i}]`).join('')}xstack=inputs=${n}:layout=${layout}:fill=black[s]`;
    const graph = `${cells.join(';')};${stack};[s]pad=${width}:${height}:0:0:black[b];[b][${n}:v]overlay=0:0:format=auto[o]`;
    const tmp = `${out}.${process.pid}.tmp.jpg`;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    // an agent waits for it: an on-demand place (lib/probe.ts ON_DEMAND), like its frames
    await run(
      FFMPEG,
      ['-v', 'error', ...tiles.flatMap((t) => ['-i', t]), '-i', png, '-filter_complex', graph, '-map', '[o]', '-frames:v', '1', '-q:v', '5', '-y', tmp],
      { onDemand: true, timeout: 120_000 },
    );
    fs.renameSync(tmp, out);
    return { width, height };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
