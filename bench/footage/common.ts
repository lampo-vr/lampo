// Where the footage bench keeps what it downloads and makes: <repo>/cache/footage/ (gitignored), or
// VR_FOOTAGE_CACHE. Nothing here is client media: CC0 photos (sources.json) turned into clips by make.ts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BENCH = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(BENCH, '../..');
export const FOOTAGE_CACHE = process.env.VR_FOOTAGE_CACHE || path.join(ROOT, 'cache', 'footage');
export const MODELS_DIR = path.join(FOOTAGE_CACHE, 'models');
export const IMAGES_DIR = path.join(FOOTAGE_CACHE, 'images');
export const CLIPS_DIR = path.join(FOOTAGE_CACHE, 'clips');
export const WORK_DIR = path.join(FOOTAGE_CACHE, 'work');
export const RESULTS_DIR = path.join(FOOTAGE_CACHE, 'results');

export const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;
export const writeJson = (file: string, v: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(v, null, 1)}\n`);
};

/** A TrueType font for burned-in test captions and contact-sheet labels (macOS, Debian/Ubuntu, Alpine). */
export function fontFile(): string {
  const candidates = [
    process.env.VR_FONT,
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/Library/Fonts/Arial Unicode.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  throw new Error('no TrueType font found: set VR_FONT to a .ttf file');
}

/** Seconds → "m:ss.ff" at the clip's fps (frames, not hundredths: what an editor types). */
export function tc(frame: number, fps: number): string {
  const s = Math.floor(frame / fps);
  const f = Math.round(frame - s * fps);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.${String(f).padStart(2, '0')}`;
}

export const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? (s[(s.length - 1) / 2] as number) : ((s[s.length / 2 - 1] as number) + (s[s.length / 2] as number)) / 2) : 0;
};
export const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] as number) : 0;
};
