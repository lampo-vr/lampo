// Hover-scrub sprites: one JPEG per render with evenly spaced frames in a fixed grid (lib/media.ts sprite()). Shared
// with the browser (no Node imports), so a card computes which tile to show from the video's size alone, without
// asking the server for the layout.

export const SPRITE_COLS = 6;
export const SPRITE_ROWS = 4;
export const SPRITE_COUNT = SPRITE_COLS * SPRITE_ROWS;
/**
 * A tile fits this box: the library card's 16:10 poster frame at about twice its CSS size, so a scrubbed frame is as
 * sharp as the poster on a retina screen (a 16:9 render: 480×270; a reel: 168×300). Bigger would cost bytes for no
 * visible gain.
 */
const TILE_BOX = { w: 480, h: 300 };
/** Part of the cache key and the URLs: a new layout makes new sprites, and browsers fetch them instead of old ones. */
export const SPRITE_VERSION = 2;

export interface SpriteLayout {
  cols: number;
  rows: number;
  count: number;
  /** One tile in sprite pixels (even numbers: what the JPEG encoder likes). */
  tileW: number;
  tileH: number;
  /** The whole sprite. */
  width: number;
  height: number;
}

const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));

export function spriteLayout(width: number, height: number): SpriteLayout {
  const aspect = width > 0 && height > 0 ? width / height : 16 / 9;
  // Taller than the box: the height is the limit (a reel: 168×300); otherwise the width (16:9: 480×270).
  const tall = TILE_BOX.h * aspect < TILE_BOX.w;
  const tileW = tall ? even(TILE_BOX.h * aspect) : TILE_BOX.w;
  const tileH = tall ? TILE_BOX.h : even(TILE_BOX.w / aspect);
  return { cols: SPRITE_COLS, rows: SPRITE_ROWS, count: SPRITE_COUNT, tileW, tileH, width: tileW * SPRITE_COLS, height: tileH * SPRITE_ROWS };
}

/** Where the newest render's sprite is served (the owner app; review links get theirs from the server). */
export const spriteUrl = (slug: string, hash: string): string => `/api/sprite/${encodeURIComponent(slug)}.jpg?h=${hash.slice(0, 10)}&s=${SPRITE_VERSION}`;

/** The frame tile `i` shows: the middle of its slice of the video. */
export const spriteFrame = (i: number, frames: number, count = SPRITE_COUNT): number =>
  Math.max(0, Math.min(frames - 1, Math.floor(((i + 0.5) * frames) / count)));

/** The tile for a pointer at `fraction` (0–1) across the card. */
export const spriteTile = (fraction: number, count = SPRITE_COUNT): number => Math.max(0, Math.min(count - 1, Math.floor(fraction * count)));

/**
 * CSS for showing tile `i` as a background that fills its box (the box has the video's aspect):
 * `background-size` and `background-position` in percentages, independent of the box's pixel size.
 */
export function spriteBackground(
  i: number,
  layout: Pick<SpriteLayout, 'cols' | 'rows'> = { cols: SPRITE_COLS, rows: SPRITE_ROWS },
): { size: string; position: string } {
  const col = i % layout.cols;
  const row = Math.floor(i / layout.cols);
  const pct = (n: number, of: number) => (of > 1 ? (n / (of - 1)) * 100 : 0);
  return { size: `${layout.cols * 100}% ${layout.rows * 100}%`, position: `${pct(col, layout.cols)}% ${pct(row, layout.rows)}%` };
}
