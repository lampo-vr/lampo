// Synthetic demo footage, rendered with ffmpeg alone: animated gradients, film grain, a letterbox and burned-in text.
// Nothing here comes from a real project, so the demo and the README screenshots can be published as they are.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FFMPEG } from '../../lib/probe.ts';

const firstExisting = (...files: string[]) => files.find((f) => fs.existsSync(f)) || null;

// drawtext needs real font files; macOS and Debian/Ubuntu locations, else ffmpeg's fontconfig default.
const SERIF = firstExisting('/System/Library/Fonts/NewYork.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf');
const SANS = firstExisting(
  '/System/Library/Fonts/Avenir Next.ttc',
  '/System/Library/Fonts/HelveticaNeue.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
);

export interface Caption {
  text: string;
  from: number;
  to: number;
  size: number;
  y: string;
  font?: 'serif' | 'sans';
  color?: string;
  /** Seconds of fade in and out. */
  fade?: number;
}

// Text goes through textfile= so nothing in it needs filtergraph escaping.
function drawtext(c: Caption, dir: string, i: number): string {
  const file = path.join(dir, `caption-${i}.txt`);
  fs.writeFileSync(file, c.text);
  const font = c.font === 'sans' ? SANS : SERIF;
  const f = c.fade ?? 0.6;
  const alpha = `if(lt(t,${c.from + f}),(t-${c.from})/${f},if(gt(t,${c.to - f}),(${c.to}-t)/${f},1))`;
  return [
    `drawtext=textfile='${file}'`,
    font ? `fontfile='${font}'` : null,
    `fontsize=${c.size}`,
    `fontcolor=${c.color || '0xEEEBE4'}`,
    'x=(w-text_w)/2',
    `y=${c.y}`,
    `alpha='${alpha}'`,
    `enable='between(t,${c.from},${c.to})'`,
  ]
    .filter(Boolean)
    .join(':');
}

export interface Render {
  file: string;
  w: number;
  h: number;
  fps: number;
  dur: number;
  /** ffmpeg gradients source options (colours, type, speed). */
  gradient: string;
  captions: Caption[];
  letterbox?: number;
  /** aevalsrc expression for a simple, visible waveform. */
  audio: string;
}

export function render(r: Render): string {
  fs.mkdirSync(path.dirname(r.file), { recursive: true });
  const work = fs.mkdtempSync(path.join(path.dirname(r.file), '.captions-'));
  const video = [
    `gradients=s=${r.w}x${r.h}:r=${r.fps}:d=${r.dur}:${r.gradient}`,
    'format=yuv420p',
    'eq=saturation=1.35:contrast=1.08',
    // Fine luma grain only: chroma noise turns every gradient to mud.
    'noise=c0s=5:c0f=t',
    'vignette=PI/4.5',
    r.letterbox ? `drawbox=x=0:y=0:w=iw:h=${r.letterbox}:color=black:t=fill` : null,
    r.letterbox ? `drawbox=x=0:y=ih-${r.letterbox}:w=iw:h=${r.letterbox}:color=black:t=fill` : null,
    ...r.captions.map((c, i) => drawtext(c, work, i)),
    'format=yuv420p',
  ]
    .filter(Boolean)
    .join(',');
  try {
    execFileSync(FFMPEG, [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      video,
      '-f',
      'lavfi',
      '-i',
      `aevalsrc='${r.audio}':s=48000:d=${r.dur}`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '18',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-shortest',
      '-movflags',
      '+faststart',
      '-y',
      r.file,
    ]);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  return r.file;
}

// A slow pulse under a soft chord: enough shape for the waveform lane.
export const score = (bpm: number, root: number) =>
  `0.42*sin(2*PI*55*t)*exp(-7*mod(t,${60 / bpm}))` +
  `+0.07*sin(2*PI*${root}*t)*(0.6+0.4*sin(2*PI*0.2*t))` +
  `+0.05*sin(2*PI*${root * 1.5}*t)+0.035*sin(2*PI*${root * 2}*t)*(0.5+0.5*sin(2*PI*0.37*t))`;

export interface DemoMedia {
  root: string;
  film: string;
  social: string;
  teaser: string;
  cutdown: string;
  /** Puts v2 of the film over v1, at the same path (as an agent re-rendering would). */
  renderFilmV2: () => string;
  /** Renders v3 of the film (the glow pulled back, the end card held a second longer) beside it, not yet in place: the
   * file, for a frame of it before it is rendered "for real" (the docs pictures' fix preview). Made on first call. */
  prepareFilmV3: () => string;
  /** Puts v3 of the film over v2, at the same path. */
  renderFilmV3: () => string;
}

export function renderDemoMedia(root: string): DemoMedia {
  const film = path.join(root, 'Northwind/launch-film/export/northwind-launch.mp4');
  // v2 is rendered up front and swapped in later, so the swap is instant; v3 only when someone asks for it.
  const filmV2 = path.join(root, '.staging/northwind-launch.v2.mp4');
  const filmV3 = path.join(root, '.staging/northwind-launch.v3.mp4');
  const filmRender = (v: 1 | 2 | 3) => {
    // v3: the glow (the gradient's warm stop) pulled back, and the end card held one second longer
    const dur = v === 3 ? 17 : 16;
    return render({
      file: v === 1 ? film : v === 2 ? filmV2 : filmV3,
      w: 1920,
      h: 1080,
      fps: 24,
      dur,
      letterbox: 132,
      gradient: `c0=0x0b1626:c1=0x1d3a57:c2=${v === 3 ? '0x8f5a40' : '0xb86f48'}:c3=0x0b1626:n=4:type=radial:speed=0.04:seed=11`,
      audio: score(92, 146.83),
      captions: [
        { text: 'N O R T H W I N D', from: v === 1 ? 0.4 : 1.0, to: 5, size: 34, y: '(h/2)-120', font: 'sans' },
        { text: 'The long way home', from: v === 1 ? 0.6 : 1.2, to: 5, size: 112, y: '(h/2)-40' },
        { text: v === 1 ? 'Every mile, accounted for.' : 'Every mile, on the record.', from: 5.5, to: 10.5, size: 96, y: '(h-text_h)/2' },
        { text: 'N O R T H W I N D', from: 11, to: dur, size: 58, y: '(h/2)-90', font: 'sans', fade: 0.5 },
        { text: v === 1 ? 'Availble spring 2027' : 'Available spring 2027', from: 11.4, to: dur, size: 44, y: v === 1 ? '(h/2)+170' : '(h/2)+130' },
      ],
    });
  };
  filmRender(1);
  filmRender(2);

  const social = render({
    file: path.join(root, 'Northwind/social/export/northwind-reel.mp4'),
    w: 1080,
    h: 1920,
    fps: 30,
    dur: 12,
    gradient: 'c0=0xf0b27a:c1=0xd9614c:c2=0x5b2a6e:c3=0xf0b27a:n=4:type=linear:speed=0.05:seed=3',
    audio: score(104, 196),
    captions: [
      { text: 'Morning light.', from: 0.3, to: 4, size: 132, y: '(h-text_h)/2' },
      { text: 'Slow coffee.', from: 4.2, to: 8, size: 132, y: '(h-text_h)/2' },
      { text: 'Longer walks.', from: 8.2, to: 12, size: 132, y: '(h-text_h)/2' },
      // Deliberately inside the Reels caption zone: the pre-review flags it.
      { text: 'Northwind, out this spring', from: 0.3, to: 12, size: 50, y: '1690', font: 'sans', fade: 0.3 },
    ],
  });

  const teaser = render({
    file: path.join(root, 'Field Notes/teaser/export/field-notes-teaser.mp4'),
    w: 1920,
    h: 1080,
    fps: 25,
    dur: 8,
    gradient: 'c0=0x0f2a24:c1=0x2e6b58:c2=0xd9c38c:c3=0x0f2a24:n=4:type=spiral:speed=0.04:seed=5',
    audio: score(120, 220),
    captions: [
      { text: 'Field Notes', from: 0.3, to: 5, size: 150, y: '(h-text_h)/2' },
      { text: 'A  S E R I E S  I N  S I X  P A R T S', from: 1.2, to: 5, size: 30, y: '(h/2)+120', font: 'sans' },
      { text: 'Soon.', from: 5.4, to: 8, size: 120, y: '(h-text_h)/2' },
    ],
  });

  const cutdown = render({
    file: path.join(root, 'Northwind/launch-film/export/northwind-6s.mp4'),
    w: 1920,
    h: 1080,
    fps: 24,
    dur: 6,
    letterbox: 132,
    gradient: 'c0=0x10202f:c1=0x274866:c2=0xc98a5a:c3=0x10202f:n=4:type=radial:speed=0.05:seed=19',
    audio: score(92, 146.83),
    captions: [
      { text: 'N O R T H W I N D', from: 0.3, to: 6, size: 58, y: '(h/2)-60', font: 'sans' },
      { text: 'Available spring 2027', from: 0.8, to: 6, size: 44, y: '(h/2)+40' },
    ],
  });

  const renderFilmV2 = () => {
    fs.copyFileSync(filmV2, film);
    return film;
  };
  const prepareFilmV3 = () => (fs.existsSync(filmV3) ? filmV3 : filmRender(3));
  const renderFilmV3 = () => {
    fs.copyFileSync(prepareFilmV3(), film);
    return film;
  };
  return { root, film, social, teaser, cutdown, renderFilmV2, prepareFilmV3, renderFilmV3 };
}
