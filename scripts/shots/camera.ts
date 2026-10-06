// The browser and the camera for the docs pictures: chrome-headless-shell (or CHROME_PATH), English, muted, reduced
// motion, a fake microphone; every picture is taken twice from the same moment, in the dark theme (docs/assets/x.webp)
// and in the light one (x-light.webp), by switching the device's colour scheme the app follows (System, the default).
// Page code is passed as strings: this file is typed for Node (no DOM lib), like scripts/screenshots.ts always was.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { ROOT } from '../../lib/paths.ts';
import { FFMPEG, FFPROBE } from '../../lib/probe.ts';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** CHROME_PATH, else the chrome-headless-shell `npm run chrome:install` left (here or in the main checkout), else Chrome. */
export function findChrome(): string {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const roots = [ROOT];
  try {
    roots.push(path.dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim()));
  } catch {}
  for (const root of roots) {
    const dir = path.join(root, 'cache/chrome/chrome-headless-shell');
    if (!fs.existsSync(dir)) continue;
    const builds = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
    for (const build of builds) {
      const sub = fs.readdirSync(path.join(dir, build)).find((d) => d.startsWith('chrome-headless-shell-'));
      const bin = sub && path.join(dir, build, sub, 'chrome-headless-shell');
      if (bin && fs.existsSync(bin)) return bin;
    }
  }
  const installed = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((p) => fs.existsSync(p));
  if (installed) return installed;
  throw new Error('no Chrome found: run `npm run chrome:install` (chrome-headless-shell), or set CHROME_PATH');
}

export async function launch(args: string[]): Promise<Browser> {
  const chrome = findChrome();
  return puppeteer.launch({
    executablePath: chrome,
    headless: path.basename(chrome) === 'chrome-headless-shell' ? 'shell' : true,
    args: [
      '--no-sandbox',
      '--no-first-run',
      '--mute-audio',
      '--hide-scrollbars',
      '--force-prefers-reduced-motion',
      '--lang=en-US',
      ...(process.platform === 'darwin' ? ['-AppleLanguages', '(en-US)'] : []),
      ...args,
    ],
    env: { ...process.env, LANG: 'en_US.UTF-8', LANGUAGE: 'en_US' },
  });
}

/**
 * A time zone where it is the middle of the working day now, so clock times in the pictures (an agent's last actions,
 * a link's visits) read like a day's work whenever the pictures are made. Etc/GMT-N is N hours east of UTC.
 */
export function daytimeZone(now = new Date()): string {
  const h = now.getUTCHours() + now.getUTCMinutes() / 60;
  let best = 0;
  for (let o = -12; o <= 14; o++) {
    const local = (((h + o) % 24) + 24) % 24;
    if (local >= 10.5 && local < 15.5 && (Math.abs(o) < Math.abs(best) || !inDay(h + best))) best = o;
  }
  return best === 0 ? 'Etc/UTC' : `Etc/GMT${best > 0 ? '-' : '+'}${Math.abs(best)}`;
}
const inDay = (t: number) => {
  const local = ((t % 24) + 24) % 24;
  return local >= 10.5 && local < 15.5;
};
export const DAY_ZONE = daytimeZone();

export type Theme = 'dark' | 'light';
/** The pictures show the app as it is used, not a first visit's one-time tips: those a browser keeps as seen are marked
 *  seen before the page opens (the timeline's zoom tip, web/src/player/Timeline.tsx HINT_KEY). */
export const tipsSeen = (page: Page) =>
  page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('vr.zoomhint', JSON.stringify({ seen: true }));
    } catch {}
  });

export const scheme = (page: Page, theme: Theme) =>
  page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: theme },
    { name: 'prefers-reduced-motion', value: 'reduce' },
  ]);

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What a picture shows: the whole viewport, the page at full length, a box, or the elements (selectors) with room
 * around them (`fromTop`: from the viewport's top down). */
export type Frame =
  | { full: true }
  | { page: true }
  | { box: Box }
  | { around: string[]; pad?: number | [number, number, number, number]; min?: Partial<Box>; fromTop?: boolean };

const MAX_WIDTH = 1600;
const GOAL_BYTES = 150_000;

/** What must never be in a picture: this machine's paths and its account's name (the demo's are made up). */
const PRIVATE = [os.homedir(), os.userInfo().username, fs.realpathSync(os.tmpdir()), os.tmpdir(), '/private/', '/var/folders/'].filter(
  (x) => x && x.length > 2,
);

/** Throws when the page shows any of PRIVATE: its visible text, the fields' values, the frames' text. */
export async function noPrivate(page: Page, name: string): Promise<void> {
  const texts = [];
  for (const frame of page.frames())
    texts.push(
      (await frame
        .evaluate(`[document.body?.innerText || '', ...[...document.querySelectorAll('input, textarea')].map((e) => e.value)].join('\\n')`)
        .catch(() => '')) as string,
    );
  const text = texts.join('\n');
  const hit = PRIVATE.find((p) => text.includes(p));
  if (hit) throw new Error(`the picture "${name}" would show "${hit}": ${text.slice(Math.max(0, text.indexOf(hit) - 80), text.indexOf(hit) + 80)}`);
}

/**
 * Takes pictures into `out`: `<name>.webp` dark, `<name>-light.webp` light, at most 1600 px wide, WebP quality 80 (less,
 * down to 66, only while a picture stays over 150 KB). `only` limits which names are written (the rest still runs, so the
 * story the pictures share stays the same).
 */
export class Camera {
  readonly made: { name: string; bytes: number; width: number; height: number }[] = [];
  readonly out: string;
  readonly work: string;
  readonly only: Set<string> | null;
  constructor(out: string, work: string, only: Set<string> | null) {
    this.out = out;
    this.work = work;
    this.only = only;
    fs.mkdirSync(out, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
  }

  wants(name: string): boolean {
    return !this.only || this.only.has(name);
  }

  /** The box for a frame, in CSS pixels, clamped to the viewport (or the page). */
  async box(page: Page, frame: Frame): Promise<Box | null> {
    if ('full' in frame || 'page' in frame) return null;
    if ('box' in frame) return frame.box;
    const pad = typeof frame.pad === 'number' || frame.pad === undefined ? Array(4).fill(frame.pad ?? 16) : frame.pad;
    const r = (await page.evaluate(`(() => {
      const rects = ${JSON.stringify(frame.around)}.flatMap((s) => [...document.querySelectorAll(s)]).map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height);
      if (!rects.length) return null;
      return {
        x: Math.min(...rects.map((r) => r.left)), y: Math.min(...rects.map((r) => r.top)),
        r: Math.max(...rects.map((r) => r.right)), b: Math.max(...rects.map((r) => r.bottom)),
        vw: innerWidth, vh: innerHeight,
      };
    })()`)) as { x: number; y: number; r: number; b: number; vw: number; vh: number } | null;
    if (!r) throw new Error(`nothing to frame: ${frame.around.join(', ')}`);
    let x = Math.max(0, Math.floor(r.x - pad[3]));
    let y = frame.fromTop ? 0 : Math.max(0, Math.floor(r.y - pad[0]));
    let right = Math.min(r.vw, Math.ceil(r.r + pad[1]));
    let bottom = Math.min(r.vh, Math.ceil(r.b + pad[2]));
    if (frame.min?.width && right - x < frame.min.width) {
      const grow = frame.min.width - (right - x);
      x = Math.max(0, x - Math.floor(grow / 2));
      right = Math.min(r.vw, x + frame.min.width);
    }
    if (frame.min?.height && bottom - y < frame.min.height) bottom = Math.min(r.vh, y + frame.min.height);
    if (frame.min?.x !== undefined) x = frame.min.x;
    if (frame.min?.y !== undefined) y = frame.min.y;
    return { x, y, width: right - x, height: bottom - y };
  }

  /** One picture in both themes. `ready` runs after each switch of theme (what must have repainted). */
  async shoot(page: Page, name: string, frame: Frame, o: { ready?: () => Promise<unknown>; settle?: number; themes?: Theme[] } = {}): Promise<void> {
    if (!this.wants(name)) return;
    const themes = o.themes ?? ['dark', 'light'];
    for (const theme of themes) {
      await scheme(page, theme);
      await sleep(o.settle ?? 500);
      if (o.ready) await o.ready();
      await noPrivate(page, name);
      const png = path.join(this.work, `${name}-${theme}.png`);
      const box = await this.box(page, frame);
      // Not beyond the viewport: at device scale 2 that resizes the page for the shot, and open menus close on it.
      if (box) await page.screenshot({ path: png as `${string}.png`, clip: box, captureBeyondViewport: false });
      else if ('page' in frame) await page.screenshot({ path: png as `${string}.png`, fullPage: true });
      else await page.screenshot({ path: png as `${string}.png`, captureBeyondViewport: false });
      this.save(png, theme === 'dark' ? name : `${name}-light`);
    }
    await scheme(page, 'dark');
  }

  /** A PNG made elsewhere (a composition of frames), saved under `name` as it is. */
  save(png: string, name: string): void {
    const out = path.join(this.out, `${name}.webp`);
    for (const quality of [80, 74, 68]) {
      execFileSync(FFMPEG, [
        '-v',
        'error',
        '-i',
        png,
        '-vf',
        `scale='min(${MAX_WIDTH},iw)':-2:flags=lanczos`,
        '-c:v',
        'libwebp',
        '-quality',
        String(quality),
        '-compression_level',
        '6',
        '-y',
        out,
      ]);
      if (fs.statSync(out).size <= GOAL_BYTES) break;
    }
    const probe = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim();
    const [width, height] = probe.split(',').map(Number);
    const bytes = fs.statSync(out).size;
    this.made.push({ name, bytes, width, height });
    console.log(`  ${path.relative(ROOT, out)}  ${width}×${height}  ${Math.round(bytes / 1000)} kB`);
  }
}
