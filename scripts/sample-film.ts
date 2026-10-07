// The first run's sample (lib/sample.ts) as a real two-version cut of Lampo's brand film: the same five seconds twice,
// frame for frame, with the title "EVERY MILE, ON THE RECORD." over the car in V1 and on the hill in V2. The title is
// set by headless Chrome exactly as the onboarding's pictures set it (Instrument Sans 600, 87.5 % wide, spaced capitals,
// 3.1 % of the frame's width, a soft shadow), written to a transparent PNG and laid over the film by ffmpeg; the only
// difference between the two versions is that PNG. The results are committed in lib/sample-film/ (the app never needs
// a browser or a font to make the sample) and this prints the title boxes lib/sample.ts keeps (SAMPLE_TITLE).
//
// usage (repo root): node scripts/sample-film.ts [film.mp4]
//   the film: the argument, else LAMPO_SAMPLE_FILM (the film itself is not in the repository, only the two cuts)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { settings } from '../lib/env.ts';
import { ROOT } from '../lib/paths.ts';
import { FFMPEG, FFPROBE } from '../lib/probe.ts';
import { launch } from './shots/camera.ts';

const OUT = path.join(ROOT, 'lib/sample-film');
/** The sample's picture: 960 wide, the film's aspect (1280 × 548) on an even height. */
const W = 960;
const TITLE = 'Every mile, on the record.';
/** A soft chord under a slow pulse (the earlier synthetic sample's): enough shape for the waveform lane. */
const CHORD = '0.32*sin(2*PI*55*t)*exp(-7*mod(t,0.652))+0.08*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*0.25*t))+0.05*sin(2*PI*330*t)+0.035*sin(2*PI*440*t)';

function findFilm(): string {
  const wanted = process.argv[2] || settings.LAMPO_SAMPLE_FILM;
  if (!wanted) throw new Error('which film? The brand film is not in the repository: pass its path, or set LAMPO_SAMPLE_FILM');
  const film = path.resolve(wanted);
  if (!fs.existsSync(film)) throw new Error(`no film at ${film}`);
  return film;
}

const probe = (file: string) => {
  const ask = ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,r_frame_rate,nb_read_frames'];
  const out = execFileSync(FFPROBE, [...ask, '-of', 'json', file], { encoding: 'utf8' });
  const s = JSON.parse(out).streams[0] as { width: number; height: number; r_frame_rate: string; nb_read_frames: string };
  const [n, d] = s.r_frame_rate.split('/').map(Number) as [number, number];
  return { width: s.width, height: s.height, fps: n / d, frames: Number(s.nb_read_frames) };
};

/** The title as the onboarding's pictures set it (web/src/onboarding: `.ttl.t1` / `.ttl.t2`), in a page the frame's size. */
function titlePage(v: 1 | 2, h: number): string {
  const font = path.join(ROOT, 'node_modules/@fontsource-variable/instrument-sans/files/instrument-sans-latin-standard-normal.woff2');
  const place = v === 1 ? 'left: 17%; top: 60%; line-height: 1.1;' : 'right: 6%; bottom: 10%; text-align: right; line-height: 1.18;';
  const text = v === 1 ? TITLE : 'Every mile,<br>on the record.';
  return `<!doctype html><html><head><style>
@font-face { font-family: 'Instrument Sans Variable'; font-weight: 400 700; font-stretch: 75% 100%; src: url('file://${font}') format('woff2-variations'); }
html, body { margin: 0; width: ${W}px; height: ${h}px; background: transparent; overflow: hidden; }
.ttl { position: absolute; ${place} color: #fff; font: 600 ${(W * 0.031).toFixed(2)}px 'Instrument Sans Variable'; font-stretch: 87.5%;
  letter-spacing: 0.14em; text-transform: uppercase; text-shadow: 0 1px 12px rgba(0, 0, 0, 0.45); white-space: nowrap; }
</style></head><body><span class="ttl">${text}</span></body></html>`;
}

/** Where a title PNG has ink: its letters (alpha over half) and everything it touches (its shadow too). */
function boxesOf(png: string, h: number) {
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', png, '-vf', 'alphaextract', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: W * h * 2 });
  const box = (min: number) => {
    let [x0, y0, x1, y1] = [W, h, -1, -1];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < W; x++)
        if ((raw[y * W + x] as number) >= min) {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  };
  return { letters: box(128), touched: box(2) };
}

async function main() {
  const film = findFilm();
  const src = probe(film);
  const h = Math.round((W * src.height) / src.width / 2) * 2;
  const dur = src.frames / src.fps;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-sample-film-'));
  const browser = await launch([]);
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const boxes: Record<number, ReturnType<typeof boxesOf>> = {};
    for (const v of [1, 2] as const) {
      const page = await browser.newPage();
      await page.setViewport({ width: W, height: h, deviceScaleFactor: 1 });
      const html = path.join(work, `title-${v}.html`);
      fs.writeFileSync(html, titlePage(v, h));
      await page.goto(`file://${html}`);
      const ok = await page.evaluate('document.fonts.ready.then(() => document.fonts.check("600 30px \'Instrument Sans Variable\'"))');
      if (!ok) throw new Error('Instrument Sans did not load: run npm install');
      const png = path.join(work, `title-${v}.png`);
      await page.screenshot({ path: png as `${string}.png`, omitBackground: true, clip: { x: 0, y: 0, width: W, height: h } });
      await page.close();
      boxes[v] = boxesOf(png, h);
      const out = path.join(OUT, `v${v}.mp4`);
      execFileSync(FFMPEG, [
        ...['-v', 'error', '-y'],
        ...['-i', film],
        ...['-loop', '1', '-i', png],
        ...['-f', 'lavfi', '-i', `aevalsrc='${CHORD}':s=48000:d=${dur.toFixed(4)}`],
        ...[
          '-filter_complex',
          `[0:v]scale=${W}:${h}:flags=lanczos,setsar=1[f];[f][1:v]overlay=0:0:shortest=1:format=auto,format=yuv420p[v];[2:a]afade=t=in:d=0.4,afade=t=out:st=${(dur - 0.6).toFixed(2)}:d=0.6[a]`,
        ],
        ...['-map', '[v]', '-map', '[a]', '-frames:v', String(src.frames), '-r', String(src.fps)],
        ...['-c:v', 'libx264', '-preset', 'slow', '-crf', '29', '-pix_fmt', 'yuv420p'],
        ...['-g', String(src.fps), '-keyint_min', String(src.fps), '-sc_threshold', '0'],
        ...['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'],
        ...['-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-t', dur.toFixed(4)],
        ...['-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact', '-movflags', '+faststart', out],
      ]);
      const made = probe(out);
      if (made.frames !== src.frames || made.width !== W || made.height !== h)
        throw new Error(`V${v} came out ${made.width}×${made.height}, ${made.frames} frames`);
      console.log(`${path.relative(ROOT, out)} · ${W}×${h} · ${made.frames} frames · ${fs.statSync(out).size} bytes`);
    }
    console.log('SAMPLE_TITLE (letters / touched, frame pixels):');
    console.log(JSON.stringify(boxes, null, 2));
  } finally {
    await browser.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

await main();
