// The brand film of the entrance (web/src/ui/Entrance.tsx): 60 consecutive frames of Lampo's own demo footage, the
// website's brand film (site/assets/footage/film.mp4, an AI-generated clip, see web/src/assets/brand-film/README.md),
// numbered as site/footage.ts numbers them: the clip's first frame is film frame 260, so film frames 266–325 at 24 fps
// are the clip's frames 6–65, around the website's note on F 0295 (00:12:07). Written to web/src/assets/brand-film/:
//   poster.webp     F 0295 alone, 720 × 306 — the still, on every screen at once
//   strip.webp      the 60 frames as the strip’s thumbnails, 208 × 88 each, ten across, six down
//   frames-0…3.webp the 60 frames at 720 × 306, fifteen to a sheet (3 across, 5 down), read in order
//   poster-lq.webp, strip-lq.webp  the still and the strip a few pixels across (32 × 14, 80 × 24): the entrance's
//                   stylesheet inlines them, so the film's own tones are there at its first paint (entrance.css)
// The sizes are the picture's at twice its drawn size (the frame 536 × 228, a thumbnail 104 × 44), cut to its shape.
// usage: node scripts/brand-film.ts [path/to/film.mp4]   (default: the website's checkout next to this one, site/)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'web/src/assets/brand-film');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
/** The film's frame number of the clip's first frame (site/footage.ts OFFSET), the first frame shown and how many. */
export const FILM = { offset: 260, first: 266, count: 60, rest: 295, fps: 24 } as const;
const film = process.argv[2] ?? path.join(ROOT, 'site/assets/footage/film.mp4');
if (!fs.existsSync(film)) {
  console.error(`${film} is missing: pass the website's brand film (site/assets/footage/film.mp4)`);
  process.exit(1);
}
const from = FILM.first - FILM.offset;
const to = from + FILM.count - 1;
const pick = `select='between(n\\,${from}\\,${to})'`;
const big = 'scale=720:308:flags=lanczos,crop=720:306';
const small = 'scale=208:89:flags=lanczos,crop=208:88';
const webp = (quality: number) => ['-c:v', 'libwebp', '-quality', String(quality), '-compression_level', '6'];
const ff = (args: string[]) => execFileSync(FFMPEG, ['-v', 'error', '-i', film, ...args, '-y'], { stdio: ['ignore', 'inherit', 'inherit'] });
fs.mkdirSync(OUT, { recursive: true });
ff(['-vf', `select='eq(n\\,${FILM.rest - FILM.offset})',${big}`, '-frames:v', '1', ...webp(82), path.join(OUT, 'poster.webp')]);
ff(['-vf', `${pick},${small},tile=10x6`, '-frames:v', '1', ...webp(72), path.join(OUT, 'strip.webp')]);
ff(['-vf', `${pick},${big},tile=3x5`, '-frames:v', String(FILM.count / 15), '-start_number', '0', ...webp(70), path.join(OUT, 'frames-%d.webp')]);
ff(['-vf', `select='eq(n\\,${FILM.rest - FILM.offset})',${big},scale=32:14:flags=area`, '-frames:v', '1', ...webp(60), path.join(OUT, 'poster-lq.webp')]);
ff(['-vf', `${pick},${small},tile=10x6,scale=80:24:flags=area`, '-frames:v', '1', ...webp(60), path.join(OUT, 'strip-lq.webp')]);
for (const f of fs
  .readdirSync(OUT)
  .filter((f) => f.endsWith('.webp'))
  .sort())
  console.log(`${f.padEnd(16)} ${(fs.statSync(path.join(OUT, f)).size / 1024).toFixed(1)} KB`);
