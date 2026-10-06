// An elements map as a renderer writes one (from a renderer's own test record): a 4 s scene at 30 fps on a 1920×1080
// stage — the background, a title, a price card that slides in over f0–f15, a badge from f31, a logo, a caption from
// f61, a button.
import fs from 'node:fs';
import path from 'node:path';
import type { ElementKey, ElementMap, MapElement } from '../../lib/types.ts';

const el = (id: string, name: string, keys: ElementKey[], runs: [number, number][]): MapElement => ({ id, name, kind: 'text', keys, runs });

export const SCENE_MAP: ElementMap = {
  v: 1,
  fps: 30,
  size: [1920, 1080],
  elements: [
    el(
      'bg',
      'bg',
      [
        [0, 0, 0, 1920, 1080],
        [119, 0, 0, 1920, 1080],
      ],
      [[0, 119]],
    ),
    el(
      'title',
      'Launch day',
      [
        [6, 120, 110, 520, 90],
        [18, 120, 80, 520, 90],
        [119, 120, 80, 520, 90],
      ],
      [[6, 119]],
    ),
    el(
      'card',
      'Price card',
      [
        [0, 120, 400, 220, 130],
        [8, 600, 400, 220, 130],
        [15, 720, 400, 220, 130],
        [119, 720, 400, 220, 130],
      ],
      [[0, 119]],
    ),
    el(
      'badge',
      'New',
      [
        [31, 1500, 860, 90, 50],
        [119, 1500, 860, 90, 50],
      ],
      [[31, 119]],
    ),
    el(
      'logo',
      'logo',
      [
        [0, 1600, 60, 200, 120],
        [119, 1600, 60, 200, 120],
      ],
      [[0, 119]],
    ),
    el(
      'caption',
      'Every morning we start',
      [
        [61, 400, 900, 700, 60],
        [119, 400, 900, 700, 60],
      ],
      [[61, 119]],
    ),
    el(
      'cta',
      'Try it',
      [
        [0, 900, 920, 240, 80],
        [119, 900, 920, 240, 80],
      ],
      [[0, 119]],
    ),
  ],
};

/** The map (or anything) as a JSON file. */
export function writeJson(file: string, value: unknown): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}
