// Shared test helpers. Every test file runs in its own process (node --test), so each can point the store at its own
// temp dir by setting env vars before importing lib/*.
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAMPO_NAMES, settings } from '../../lib/env.ts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VR_BIN = path.join(ROOT, 'bin/vr');
const LAMPO_BIN = path.join(ROOT, 'bin/lampo');
/** The command the tests run: bin/vr, as setups made before the rename call it; LAMPO_TEST_CLI=lampo runs them all
 * through bin/lampo instead (test/unit/cli-names.test.ts holds the two to the same output). */
export const VR = settings.LAMPO_TEST_CLI === 'lampo' ? LAMPO_BIN : VR_BIN;

// A setting in the shell's LAMPO_ spelling would win over the VR_ one a test sets (lib/env.ts reads LAMPO_ first) and
// point a test's store, server, mail or stand-in tools elsewhere: tests start without them.
for (const k of LAMPO_NAMES) delete process.env[k];

const bin = (name: string) => ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].map((d) => `${d}/${name}`).find((p) => fs.existsSync(p)) || name;
export const FFMPEG = settings.LAMPO_FFMPEG || bin('ffmpeg');

export function tmpdir(prefix = 'vr-test-'): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

// Isolated store: data, versions and cache all under one temp dir, plus a config.json. Call before importing lib/*.
export function isolatedEnv({ config = {}, vars = {} }: { config?: object; vars?: Record<string, string> } = {}): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = tmpdir();
  const env: Record<string, string> = {
    VR_DATA: path.join(dir, 'data'),
    VR_CACHE: path.join(dir, 'cache'),
    VR_USER: 'tester',
    VR_CONFIG: path.join(dir, 'config.json'),
    // Never the developer's own `vr login` credentials or download cache.
    XDG_CONFIG_HOME: path.join(dir, 'xdg-config'),
    XDG_CACHE_HOME: path.join(dir, 'xdg-cache'),
    // No speech engine (and never a model download) unless a test asks for one.
    VR_STT: 'off',
    // No footage index either (lib/footage/: on by default on a machine); a test that wants one asks for it, with the
    // stand-in model (VR_FOOTAGE: 'auto', VR_FOOTAGE_MODEL: 'fake'), never the real one.
    VR_FOOTAGE: 'off',
    // No sample made behind a test's back when it makes an account (server/firstSample.ts) unless it asks for one.
    VR_ONBOARDING_SAMPLE: 'off',
    // `vr login` opens the browser BROWSER names (lib/browserLogin.ts): `true` starts and opens nothing, so no test, nor
    // a `vr` it runs, ever reaches a real browser; a test that drives the browser sign-in names its own stand-in.
    BROWSER: 'true',
    ...vars,
  };
  fs.writeFileSync(env.VR_CONFIG, JSON.stringify(config));
  Object.assign(process.env, env);
  // Tests must not pick up the Claude Code session they happen to run in, or a server from the environment — and never
  // a real mail relay: every test sends through the log transport (<cache>/outbox/).
  for (const k of [
    'CLAUDE_PID',
    'CLAUDE_CODE_SESSION_ID',
    'VR_SERVER',
    'VR_TOKEN',
    'VR_MODE',
    'VR_STORAGE',
    'VR_PUBLIC_URL',
    'VR_SOURCE_URL',
    'VR_SIGNUP',
    'VR_TERMS_URL',
    'VR_PRIVACY_URL',
    'VR_IMPRINT_URL',
    'VR_WITHDRAWAL_URL',
    'VR_CANCEL_URL',
    // publishing goes to the fake platforms a test starts (test/lib/fakePlatforms.ts), never anywhere else
    'VR_PUBLISH_ENDPOINTS',
    'VR_WORKSPACE_CREATE',
    'VR_WORKSPACE_CREATE_LIMIT',
    // who runs the server (lib/operator.ts): a test names its operators itself
    'LAMPO_OPERATOR',
    // every mail setting, whatever new ones come (a shell's VR_MAIL_PER_WORKSPACE_HOUR changed the mail tests' limits)
    ...Object.keys(process.env).filter((k) => k.startsWith('VR_SMTP_') || k.startsWith('VR_MAIL_')),
  ])
    if (!(k in vars)) delete process.env[k];
  return { dir, env: { ...process.env } };
}

export interface VideoOptions {
  w?: number;
  h?: number;
  /** Frames per second, or an ffmpeg rational such as "24000/1001". */
  fps?: number | string;
  dur?: number;
  pattern?: string;
  audio?: boolean;
  freq?: number;
  /** Frames between keyframes. */
  gop?: number;
}

// Generated clips are made once per machine: ffmpeg's output for the same arguments is the same bytes, so the first
// encode is kept in <tmp>/vr-test-media/ under a hash of the arguments and the ffmpeg build, and every later call copies
// it (a fresh file each time, as before: tests write, age and upload their own copy). Most of the unit suite's time was
// encoding the same small clips again. VR_TEST_MEDIA_CACHE=off encodes every time.
const MEDIA_CACHE = path.join(fs.realpathSync(os.tmpdir()), 'vr-test-media');
let ffmpegBuild: string | null = null;
/** An ffmpeg encode (its arguments without the output) made once per machine and copied to `file`. */
export function encodeOnce(file: string, args: string[]): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (settings.LAMPO_TEST_MEDIA_CACHE === 'off') {
    execFileSync(FFMPEG, [...args, '-y', file]);
    return file;
  }
  ffmpegBuild ??= execFileSync(FFMPEG, ['-version'], { encoding: 'utf8' });
  const key = crypto
    .createHash('sha256')
    .update(JSON.stringify([ffmpegBuild, args, path.extname(file)]))
    .digest('hex')
    .slice(0, 32);
  const cached = path.join(MEDIA_CACHE, `${key}${path.extname(file)}`);
  if (!fs.existsSync(cached)) {
    fs.mkdirSync(MEDIA_CACHE, { recursive: true });
    // Test files run side by side: encode beside it and rename, so nobody copies half a clip.
    const part = `${cached}.${process.pid}.${crypto.randomBytes(4).toString('hex')}${path.extname(file)}`;
    execFileSync(FFMPEG, [...args, '-y', part]);
    fs.renameSync(part, cached);
  }
  fs.copyFileSync(cached, file);
  return file;
}

// A small H.264 clip with B-frames; testsrc draws a changing timestamp so every frame differs.
export function makeVideo(
  file: string,
  { w = 160, h = 90, fps = 30, dur = 1, pattern = 'testsrc', audio = true, freq = 440, gop = 48 }: VideoOptions = {},
): string {
  const args = ['-v', 'error', '-f', 'lavfi', '-i', `${pattern}=size=${w}x${h}:rate=${fps}:duration=${dur}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${dur}`);
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', String(gop));
  if (audio) args.push('-c:a', 'aac', '-shortest');
  return encodeOnce(file, args);
}

/**
 * A render in three shots for partial renders (lib/part.ts): 0–39, 40–79, 80–119 at 25 fps, told apart by half the
 * picture turning red, then blue; testsrc2 moves every frame, so a picture names its frame. `extra`: more filters (a
 * fix), `volume`: its sound's level.
 */
export function makeShotsVideo(
  file: string,
  { extra = '', volume = 1, w = 320, h = 180 }: { extra?: string; volume?: number; w?: number; h?: number } = {},
): string {
  const shots = `drawbox=x=0:y=0:w=${w / 2}:h=${h}:color=red:t=fill:enable='between(n,40,79)',drawbox=x=0:y=0:w=${w / 2}:h=${h}:color=blue:t=fill:enable='gte(n,80)'`;
  return encodeOnce(file, [
    ...['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=25:duration=4.8`, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4.8'],
    ...['-vf', [shots, extra].filter(Boolean).join(','), '-af', `volume=${volume}`],
    ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '48', '-c:a', 'aac', '-shortest'],
  ]);
}

/**
 * A render with a hold of every kind Auto-check tells apart (25 fps, 8 s; testsrc2 moves on every frame, a tone plays
 * except 5.0–6.2 s): frames 40–55 frozen while the tone goes on (looks like a problem), 75–78 one frame repeated (a
 * hitch), 128–148 frozen inside the silence (a pause), 170–199 the last picture held (an end card). `shift` moves the
 * first hold by that many frames (a re-render where it moved a little); `freq` changes the tone (other bytes).
 */
export function makeFreezeVideo(
  file: string,
  { shift = 0, freq = 440, w = 320, h = 180 }: { shift?: number; freq?: number; w?: number; h?: number } = {},
): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const holds = [
    [41 + shift, 55 + shift, 40 + shift],
    [76, 78, 75],
    [129, 148, 128],
    [171, 199, 170],
  ];
  const graph = holds
    .map(([a, b, r], i) => `[${i ? `v${i}` : '0:v'}]split[a${i}][r${i}];[a${i}][r${i}]freezeframes=first=${a}:last=${b}:replace=${r}[v${i + 1}]`)
    .join(';');
  execFileSync(FFMPEG, [
    ...['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=25:duration=8`],
    ...['-f', 'lavfi', '-i', `aevalsrc=if(between(t\\,5\\,6.2)\\,0\\,0.2*sin(2*PI*${freq}*t)):s=48000:c=stereo:d=8`],
    ...['-filter_complex', graph, '-map', `[v${holds.length}]`, '-map', '1:a'],
    ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-c:a', 'aac', '-shortest', '-y', file],
  ]);
  return file;
}

/** A white square on frames from–to: a fix in a shot of makeShotsVideo. */
export const fixBox = (from: number, to: number): string => `drawbox=x=200:y=40:w=60:h=60:color=white:t=fill:enable='between(n,${from},${to})'`;

/** Frames [a, b) of a render (25 fps) as a file of their own: how an agent renders a stretch with its handles. */
export function cutFrames(src: string, a: number, b: number, file: string, fps = 25): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(FFMPEG, [
    ...['-v', 'error', '-i', src, '-vf', `trim=start_frame=${a}:end_frame=${b},setpts=PTS-STARTPTS`],
    ...['-af', `atrim=start=${a / fps}:end=${b / fps},asetpts=PTS-STARTPTS`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '48', '-c:a', 'aac', '-y', file],
  ]);
  return file;
}

export const md5 = (buf: Buffer): string => crypto.createHash('md5').update(buf).digest('hex');

/** The slug of a linked render on the machine: its absolute path with "/" as "__". */
export const slugOf = (file: string): string => path.resolve(file).split('/').join('__');

export function rawRgb(inputArgs: string[]): Buffer {
  return execFileSync(FFMPEG, ['-v', 'error', ...inputArgs, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
}

export interface VrResult {
  code: number;
  out: string;
  err: string;
}

// Run bin/vr synchronously in the given env.
export function vr(args: string[], env: NodeJS.ProcessEnv, { cwd }: { cwd?: string } = {}): VrResult {
  try {
    const out = execFileSync(process.execPath, [VR, ...args], { env, cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out, err: '' };
  } catch (e) {
    const x = e as { status: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return { code: x.status, out: x.stdout?.toString() || '', err: x.stderr?.toString() || '' };
  }
}

export function vrAsync(args: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [VR, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
}

// Make a file look settled (renders younger than 3 s are treated as still being written).
export function age(file: string, seconds = 60): void {
  const t = new Date(Date.now() - seconds * 1000);
  fs.utimesSync(file, t, t);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

/**
 * Waits for a state instead of a time: polls `fn` every 100 ms until it gives something truthy (which it returns),
 * else fails naming `what` (a function is asked only then: the state as it ended up). The default is long on purpose —
 * a loaded machine is slow, not wrong; a state that never comes fails all the same.
 */
export async function until<T>(fn: () => T | Promise<T>, what: string | (() => unknown), ms = 20_000): Promise<NonNullable<T>> {
  for (const t = Date.now(); Date.now() - t < ms; await sleep(100)) {
    const got = await fn();
    if (got) return got as NonNullable<T>;
  }
  throw new Error(`timed out after ${ms / 1000} s: ${typeof what === 'function' ? await what() : what}`);
}

/** The value, or a failed assertion when it is missing (keeps strict null checks honest in tests). */
export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}
