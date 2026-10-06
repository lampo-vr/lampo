#!/usr/bin/env node
// The test footage: CC0 photos (sources.json, downloaded once) turned into clips a person might add to a footage
// library — edited B-roll reels (16:9 and one 9:16) and single-take camera files — with exact ground truth for every
// shot: which photo, which camera move, where it starts and ends, burned-in text, what a voice-over says.
//   node bench/footage/make.ts [--force]      → cache/footage/clips/*.mp4 + truth.json + <clip>.words.json
// Camera moves are Ken Burns moves (zoompan on a 4× upscale, so the crop moves in quarter pixels): static, push-in,
// pull-out, pan left/right, tilt up/down, handheld. Voice-overs need macOS `say`; elsewhere those clips stay silent
// and the queries about what is said are skipped.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CLIPS_DIR, fontFile, IMAGES_DIR, readJson, WORK_DIR, writeJson } from './common.ts';

export type Motion = 'static' | 'push-in' | 'push-in-fast' | 'pull-out' | 'pan-left' | 'pan-right' | 'tilt-up' | 'tilt-down' | 'handheld';
type Style = 'title' | 'lower' | 'badge';
/** [photo, move, seconds, burned-in text?, its style?] */
type ShotSpec = [string, Motion, number, string?, Style?];
interface ClipSpec {
  file: string;
  vertical?: boolean;
  shots: ShotSpec[];
  /** Voice-over: [seconds into the clip, sentence], one voice. */
  vo?: { voice: string; lang: string; lines: [number, string][] };
}

export interface Source {
  key: string;
  shows: string;
  text_in_picture?: boolean;
  /** A same-theme photo that answers no query unless queries.json names it (pooled judgements). */
  distractor?: boolean;
  url: string;
  landing: string;
  title: string;
  creator: string;
  licence: string;
  openverse: string;
}

export interface TruthShot {
  id: string;
  clip: string;
  key: string;
  motion: Motion;
  /** First frame and the frame after the last (exclusive). */
  in: number;
  out: number;
  text: string | null;
  said: string | null;
}
export interface TruthClip {
  file: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  shots: TruthShot[];
}

export const FPS = 25;

export const CLIPS: ClipSpec[] = [
  {
    file: 'reel_coffee.mp4',
    shots: [
      ['coffee_white', 'static', 3],
      ['latte_pour', 'push-in', 3],
      ['coffee_hand', 'static', 2.5],
      ['pour_milk', 'push-in', 2.5],
      ['latte_laptop', 'pan-right', 3],
      ['latte_croissant', 'static', 2.5],
      ['espresso', 'push-in', 3],
      ['pour_kettle', 'static', 2],
      ['latte_white', 'push-in', 3, 'Coffee, done right.', 'title'],
      ['coffee_wood', 'static', 2],
      ['latte_glass', 'pull-out', 3],
      ['pour_white_kettle', 'static', 2.5],
      ['latte_hand', 'static', 2],
    ],
  },
  {
    file: 'reel_sneakers.mp4',
    shots: [
      ['sneaker_flatlay', 'push-in', 3, 'NEW DROP', 'badge'],
      ['sneaker_feet_top', 'static', 2.5],
      ['lace_bench', 'static', 2],
      ['runner_road', 'push-in', 3],
      ['sprinter', 'static', 2.5],
      ['runners_bridge', 'pan-left', 3],
      ['steps', 'static', 2],
      ['sneaker_tracks', 'handheld', 2.5],
      ['lace_city', 'static', 2.5],
      ['sneaker_red_walk', 'pan-right', 3],
      ['runner_snow', 'static', 3],
      ['sneaker_flatlay', 'static', 3, 'FREE SHIPPING', 'title'],
      ['runner_road', 'static', 2.5],
    ],
  },
  {
    file: 'reel_office.mp4',
    shots: [
      ['laptop_charts', 'push-in', 3],
      ['typing_close', 'static', 2.5],
      ['meeting_window', 'static', 3, 'Anna Berg · Designer', 'lower'],
      ['meeting_room', 'pan-right', 3.5],
      ['brainstorm', 'static', 2],
      ['typing_dim', 'push-in', 2.5],
      ['loft_work', 'static', 3],
      ['phone_hands', 'static', 2],
      ['devices_wood', 'pull-out', 3],
      ['laptop_flatlay', 'static', 2.5],
      ['headphones_laptop', 'static', 2],
      ['phone_laptop_white', 'push-in', 2.5],
    ],
  },
  {
    file: 'reel_kitchen_vo.mp4',
    shots: [
      ['market', 'pan-right', 4],
      ['radishes', 'static', 2.5],
      ['kitchen_ingredients', 'push-in', 3],
      ['dough', 'static', 2.5],
      ['pan_tomatoes', 'push-in', 3],
      ['peppers', 'static', 2],
      ['peppers_splash', 'static', 2.5],
      ['chef_plating', 'pan-left', 3],
      ['salad_top', 'static', 2.5],
      ['pasta_salad', 'push-in', 2.5],
      ['salad_white', 'static', 2.5],
      ['grill', 'static', 2.5],
      ['burger_dark', 'push-in', 3],
      ['burger_dark2', 'static', 2.5],
      ['burger_close', 'static', 2],
    ],
    vo: {
      voice: 'Anna',
      lang: 'de',
      lines: [
        [0.5, 'Frisches Gemüse, direkt vom Markt.'],
        [7, 'Alles, was du brauchst, auf einen Blick.'],
        [12.3, 'In zehn Minuten fertig.'],
        [19.6, 'Guten Appetit!'],
      ],
    },
  },
  {
    file: 'reel_city.mp4',
    shots: [
      ['skyline_night', 'pan-right', 4],
      ['crossing_night', 'static', 3],
      ['highway_dusk', 'push-in', 3],
      ['windows_night', 'tilt-up', 3],
      ['light_trails', 'static', 2],
      ['street_day', 'push-in', 3],
      ['street_closed', 'static', 2.5],
      ['sunset_street', 'push-in', 3],
      ['traffic', 'static', 2.5],
      ['police_car', 'static', 2],
      ['skyline_day', 'pan-left', 4],
      ['city_above', 'static', 3],
      ['paris_dusk', 'pull-out', 3.5],
      ['fireworks', 'static', 2.5],
      ['desert_road', 'push-in', 3],
    ],
  },
  {
    file: 'reel_nature.mp4',
    shots: [
      ['lake_reflection', 'pan-right', 4],
      ['alpine_lake', 'static', 3],
      ['paraglider', 'static', 3],
      ['misty_hills', 'pan-left', 4],
      ['boardwalk_forest', 'push-in', 3.5],
      ['misty_forest', 'static', 3],
      ['snow_trees', 'tilt-up', 3],
      ['aerial_forest', 'static', 3],
      ['aerial_road', 'push-in', 3],
      ['wave_break', 'static', 2.5],
      ['sea_calm', 'static', 3],
      ['rocks_sea', 'pan-right', 3],
      ['aerial_surf', 'static', 3],
      ['beach_wave', 'static', 2.5],
      ['beach_crowd', 'push-in', 3],
      ['beach_empty', 'static', 3],
      ['sunset_sea_pink', 'pull-out', 3.5],
      ['sunset_beach_people', 'static', 3],
    ],
  },
  {
    file: 'reel_products_white.mp4',
    shots: [
      ['phone_black_white', 'push-in', 3.5],
      ['succulent_white', 'static', 4],
      ['daisy_white', 'push-in', 3],
      ['pencils_white', 'static', 2.5],
      ['flatlay_white', 'push-in', 3],
      ['perfume_pink', 'static', 3],
      ['dog_white', 'static', 2.5],
      ['perfume_pink', 'push-in', 3, 'NEW SCENT', 'badge'],
      ['salad_white', 'push-in', 3],
      ['coffee_white', 'push-in', 3.5],
      ['phone_white', 'static', 2.5],
      ['succulent_white', 'push-in', 1.5],
      ['hearts', 'static', 2.5],
      ['peonies', 'push-in', 3],
      ['watch_dark', 'static', 3],
      ['headphones_dark', 'push-in', 3],
    ],
  },
  {
    file: 'reel_lifestyle.mp4',
    shots: [
      ['headphones_woman', 'static', 3],
      ['backpack_sit', 'push-in', 3],
      ['hikers', 'pan-right', 3.5],
      ['bike_basket', 'static', 2.5],
      ['bike_wall', 'push-in', 3],
      ['bike_gears', 'static', 2],
      ['camera_flatlay', 'static', 2.5],
      ['photographer', 'push-in', 3],
      ['videographer', 'static', 2.5],
      ['phone_photo_sunset', 'static', 3],
      ['map_hands', 'static', 2.5],
      ['sparkler', 'push-in', 3],
      ['books_open', 'static', 2.5],
      ['reading_sea', 'static', 3],
      ['bookshelf', 'pan-left', 3],
      ['wine_open', 'static', 2],
      ['pizza_wine', 'push-in', 3],
      ['wine_bar', 'static', 2.5],
      ['pug_blanket', 'static', 3],
      ['pug_floor', 'push-in', 3],
      ['vintage_car', 'static', 3],
      ['yoga_beach', 'static', 3],
      ['yoga_class', 'pan-right', 3],
      ['yoga_silhouette', 'static', 2.5],
      ['sunset_field', 'push-in', 3],
      ['dahlia', 'static', 2.5],
      ['tulips', 'pull-out', 3],
      ['plant_table', 'static', 2.5],
      ['succulent_room', 'static', 2.5],
    ],
  },
  {
    file: 'reel_watch_vo.mp4',
    shots: [
      ['watch_wrist', 'static', 3],
      ['smartwatch', 'push-in', 4],
      ['watch_rings', 'static', 3],
      ['smartwatch', 'static', 3],
      ['watch_dark', 'pan-right', 3.5],
      ['flatlay_white', 'static', 3, 'SALE -30%', 'title'],
    ],
    vo: {
      voice: 'Samantha',
      lang: 'en',
      lines: [
        [0.4, 'Meet the new smartwatch.'],
        [3.4, 'The battery lasts all week.'],
        [10.3, 'Water resistant to fifty metres.'],
        [13.4, 'Available in three colours.'],
      ],
    },
  },
  {
    file: 'reel_vertical.mp4',
    vertical: true,
    shots: [
      ['phone_street', 'static', 3, 'Link in bio', 'lower'],
      ['coffee_hand', 'push-in', 3],
      ['backpack_yellow', 'static', 3],
      ['perfume_purple', 'push-in', 3.5],
      ['sunglasses_split', 'static', 2.5],
      ['yoga_beach', 'push-in', 3],
      ['phone_hands', 'static', 2.5],
      ['phone_black_white', 'push-in', 3],
      ['serum', 'static', 3],
      ['latte_white', 'static', 2.5, 'Coffee, done right.', 'title'],
      ['succulent_white', 'push-in', 3],
      ['sneaker_feet_top', 'static', 2.5],
      ['dog_white', 'static', 2.5],
    ],
  },
  {
    file: 'reel_beauty.mp4',
    shots: [
      ['serum', 'push-in', 3],
      ['cosmetics_table', 'static', 3],
      ['perfume_bokeh', 'static', 3],
      ['perfume_purple', 'pull-out', 3],
      ['aviators', 'static', 2.5],
      ['sunglasses_split', 'push-in', 3],
    ],
  },
  // single takes, as a camera writes them: one file, one shot, longer
  { file: 'take_001.mp4', shots: [['lake_reflection', 'pan-right', 12]] },
  { file: 'take_002.mp4', shots: [['wave_break', 'handheld', 10]] },
  { file: 'take_003.mp4', shots: [['coffee_white', 'push-in', 10]] },
  { file: 'take_004.mp4', shots: [['city_above', 'handheld', 8]] },
  { file: 'take_005.mp4', shots: [['typing_close', 'static', 9]] },
  { file: 'take_006.mp4', shots: [['misty_forest', 'tilt-up', 10]] },
  { file: 'take_007.mp4', shots: [['phone_black_white', 'static', 8]] },
  { file: 'take_008.mp4', vertical: true, shots: [['runners_bridge', 'static', 8]] },
  { file: 'take_009.mp4', shots: [['highway_dusk', 'pull-out', 12]] },
  { file: 'take_010.mp4', shots: [['market', 'handheld', 10]] },
];

const sources = readJson<Source[]>(path.join(path.dirname(new URL(import.meta.url).pathname), 'sources.json'));
const byKey = new Map(sources.map((s) => [s.key, s]));

// The distractors: six more reels (one of them 9:16) of the other candidates of the same themes, in a fixed shuffled
// order, with the moves and lengths cycling — a library where most shots look like some other shot.
const MOVES: Motion[] = ['static', 'push-in', 'static', 'pan-right', 'static', 'pull-out', 'push-in', 'pan-left', 'static', 'tilt-up', 'handheld'];
const LENGTHS = [2.5, 3, 3.5, 2, 4, 3];
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const extra = sources
  .filter((s) => s.distractor)
  .map((s) => s.key)
  .sort((a, b) => hash(a) - hash(b));
for (let r = 0; r * 30 < extra.length; r++)
  CLIPS.push({
    file: `reel_more_${r + 1}.mp4`,
    vertical: r === 2,
    shots: extra
      .slice(r * 30, r * 30 + 30)
      .map((k, i): ShotSpec => [k, MOVES[(r * 7 + i) % MOVES.length] as Motion, LENGTHS[(r * 5 + i) % LENGTHS.length] as number]),
  });
const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });

async function fetchPhotos(keys: Set<string>): Promise<void> {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  for (const k of keys) {
    const s = byKey.get(k);
    if (!s) throw new Error(`unknown photo ${k}`);
    const f = path.join(IMAGES_DIR, `${k}.jpg`);
    if (fs.existsSync(f)) continue;
    const res = await fetch(s.url);
    if (!res.ok) throw new Error(`${s.url}: HTTP ${res.status}`);
    fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()));
  }
}

// zoom z(p) and centre offsets ox/oy(p) in [-1, 1] of the margin the zoom leaves, p = 0..1 over the shot
function move(m: Motion): { z: [number, number]; ox: [number, number]; oy: [number, number]; jitter: number } {
  switch (m) {
    case 'static':
      return { z: [1, 1], ox: [0, 0], oy: [0, 0], jitter: 0 };
    case 'push-in':
      return { z: [1, 1.15], ox: [0, 0], oy: [0, 0], jitter: 0 };
    case 'push-in-fast':
      return { z: [1, 1.4], ox: [0, 0], oy: [0, 0], jitter: 0 };
    case 'pull-out':
      return { z: [1.15, 1], ox: [0, 0], oy: [0, 0], jitter: 0 };
    case 'pan-right':
      return { z: [1.25, 1.25], ox: [-1, 1], oy: [0, 0], jitter: 0 };
    case 'pan-left':
      return { z: [1.25, 1.25], ox: [1, -1], oy: [0, 0], jitter: 0 };
    case 'tilt-up':
      return { z: [1.25, 1.25], ox: [0, 0], oy: [1, -1], jitter: 0 };
    case 'tilt-down':
      return { z: [1.25, 1.25], ox: [0, 0], oy: [-1, 1], jitter: 0 };
    case 'handheld':
      return { z: [1.12, 1.12], ox: [0, 0], oy: [0, 0], jitter: 0.35 };
  }
}

function drawText(text: string, style: Style, W: number, H: number): string {
  const esc = text.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const font = fontFile().replace(/:/g, '\\:');
  const base = `drawtext=fontfile='${font}':expansion=none:text='${esc}':fontcolor=white`;
  const s = Math.min(W, H) / 720;
  if (style === 'title')
    return `${base}:fontsize=${Math.round(64 * s)}:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.45:boxborderw=${Math.round(24 * s)}`;
  if (style === 'lower')
    return `${base}:fontsize=${Math.round(36 * s)}:x=${Math.round(60 * s)}:y=h-text_h-${Math.round(80 * s)}:box=1:boxcolor=black@0.6:boxborderw=${Math.round(16 * s)}`;
  return `${base}:fontsize=${Math.round(44 * s)}:x=w-text_w-${Math.round(50 * s)}:y=${Math.round(50 * s)}:box=1:boxcolor=0xE8452C@0.95:boxborderw=${Math.round(14 * s)}`;
}

function makeShot(spec: ShotSpec, W: number, H: number, out: string): number {
  const [key, motion, secs, text, style] = spec;
  const N = Math.round(secs * FPS);
  const m = move(motion);
  const K = 4; // supersampling for the crop's integer steps
  const P = `(on/${Math.max(1, N - 1)})`;
  const lerp = (a: number, b: number) => (a === b ? `${a}` : `(${a}+(${b - a})*${P})`);
  const z = lerp(m.z[0], m.z[1]);
  // jitter: two sines per axis, in fractions of the margin (handheld)
  const jx = m.jitter ? `+${m.jitter}*(sin(on*0.19)+0.6*sin(on*0.47+1.3))` : '';
  const jy = m.jitter ? `+${m.jitter}*(sin(on*0.23+0.7)+0.6*sin(on*0.53+2.1))` : '';
  const x = `(iw-iw/zoom)/2*(1+${lerp(m.ox[0], m.ox[1])}${jx})`;
  const y = `(ih-ih/zoom)/2*(1+${lerp(m.oy[0], m.oy[1])}${jy})`;
  const vf = [
    `scale=${W * K}:${H * K}:force_original_aspect_ratio=increase:flags=bicubic`,
    `crop=${W * K}:${H * K}`,
    `zoompan=z='${z}':x='${x}':y='${y}':d=${N}:s=${W}x${H}:fps=${FPS}`,
    ...(text && style ? [drawText(text, style, W, H)] : []),
    'format=yuv420p',
  ].join(',');
  ff([
    '-i',
    path.join(IMAGES_DIR, `${key}.jpg`),
    '-vf',
    vf,
    '-frames:v',
    String(N),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-g',
    '50',
    '-r',
    String(FPS),
    out,
  ]);
  return N;
}

function hasSay(): boolean {
  try {
    execFileSync('say', ['-v', '?'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const duration = (f: string): number =>
  Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim());

/** The voice-over as one track, and its words spread over each sentence's audio by length (an ideal transcript). */
function makeVoice(clip: ClipSpec, total: number, work: string): { wav: string; words: { text: string; t0: number; t1: number }[] } | null {
  if (!clip.vo || !hasSay()) return null;
  const parts: { file: string; at: number; len: number; text: string }[] = [];
  clip.vo.lines.forEach(([at, text], i) => {
    const aiff = path.join(work, `vo${i}.aiff`);
    execFileSync('say', ['-v', clip.vo?.voice as string, '-o', aiff, text]);
    const wav = path.join(work, `vo${i}.wav`);
    ff([
      '-i',
      aiff,
      '-ac',
      '1',
      '-ar',
      '48000',
      '-af',
      'silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse',
      wav,
    ]);
    parts.push({ file: wav, at, len: duration(wav), text });
  });
  const wav = path.join(work, 'vo.wav');
  const inputs = parts.flatMap((p) => ['-i', p.file]);
  const delays = parts.map((p, i) => `[${i}:a]adelay=${Math.round(p.at * 1000)}:all=1[a${i}]`).join(';');
  ff([
    ...inputs,
    '-filter_complex',
    `${delays};${parts.map((_, i) => `[a${i}]`).join('')}amix=inputs=${parts.length}:normalize=0,apad=whole_dur=${total}[o]`,
    '-map',
    '[o]',
    '-t',
    String(total),
    wav,
  ]);
  const words: { text: string; t0: number; t1: number }[] = [];
  for (const p of parts) {
    const ws = p.text.split(/\s+/);
    const letters = ws.reduce((s, w) => s + w.length + 1, 0);
    let t = p.at;
    for (const w of ws) {
      const d = (p.len * (w.length + 1)) / letters;
      words.push({ text: w, t0: Math.round(t * 1000) / 1000, t1: Math.round((t + d) * 1000) / 1000 });
      t += d;
    }
  }
  return { wav, words };
}

async function main() {
  const force = process.argv.includes('--force');
  await fetchPhotos(new Set(CLIPS.flatMap((c) => c.shots.map((s) => s[0]))));
  fs.mkdirSync(CLIPS_DIR, { recursive: true });
  const truth: TruthClip[] = [];
  for (const clip of CLIPS) {
    const [W, H] = clip.vertical ? [720, 1280] : [1280, 720];
    const out = path.join(CLIPS_DIR, clip.file);
    const work = path.join(WORK_DIR, 'make', path.basename(clip.file, '.mp4'));
    fs.mkdirSync(work, { recursive: true });
    const shots: TruthShot[] = [];
    let at = 0;
    const list: string[] = [];
    clip.shots.forEach((s, i) => {
      const seg = path.join(work, `s${String(i).padStart(2, '0')}.mp4`);
      const n = !force && fs.existsSync(out) ? Math.round(s[2] * FPS) : makeShot(s, W, H, seg);
      list.push(`file '${seg}'`);
      shots.push({
        id: `${path.basename(clip.file, '.mp4')}#${i}`,
        clip: clip.file,
        key: s[0],
        motion: s[1],
        in: at,
        out: at + n,
        text: s[3] ?? null,
        said: null,
      });
      at += n;
    });
    if (force || !fs.existsSync(out)) {
      fs.writeFileSync(path.join(work, 'list.txt'), `${list.join('\n')}\n`);
      const joined = path.join(work, 'joined.mp4');
      ff(['-f', 'concat', '-safe', '0', '-i', path.join(work, 'list.txt'), '-c', 'copy', joined]);
      const voice = makeVoice(clip, at / FPS, work);
      if (voice) {
        ff(['-i', joined, '-i', voice.wav, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest', out]);
        writeJson(out.replace(/\.mp4$/, '.words.json'), { language: clip.vo?.lang, words: voice.words });
      } else fs.renameSync(joined, out);
      for (const f of fs.readdirSync(work)) if (/^s\d+\.mp4$/.test(f)) fs.rmSync(path.join(work, f));
    }
    // what is said over each shot (the sentences that start in it)
    if (clip.vo && fs.existsSync(out.replace(/\.mp4$/, '.words.json')))
      for (const [t, text] of clip.vo.lines) {
        const f = Math.round(t * FPS);
        const shot = shots.find((s) => f >= s.in && f < s.out);
        if (shot) shot.said = shot.said ? `${shot.said} ${text}` : text;
      }
    truth.push({ file: clip.file, width: W, height: H, fps: FPS, frames: at, shots });
    console.log(clip.file.padEnd(26), `${shots.length} shots`.padStart(9), `${(at / FPS).toFixed(1)} s`.padStart(8));
  }
  writeJson(path.join(CLIPS_DIR, 'truth.json'), truth);
  const n = truth.reduce((s, c) => s + c.shots.length, 0);
  const secs = truth.reduce((s, c) => s + c.frames / FPS, 0);
  console.log(`${truth.length} clips, ${n} shots, ${(secs / 60).toFixed(1)} min`);
}

if (import.meta.main) await main();
