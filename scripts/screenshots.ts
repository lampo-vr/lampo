// `npm run screenshots`: every picture of the app in docs/assets — the README's and the docs' — made again from a fresh
// demo (synthetic footage, made-up names), each in the dark theme (x.webp) and the light one (x-light.webp).
//   node scripts/screenshots.ts [--only player,board,…] [--out <dir>]
// --only writes just those pictures (the demo's story still runs in full, so they show what they always show); --out
// writes somewhere else than docs/assets. Needs `npm run build` (the app's UI and the MCP review card), ffmpeg with
// libwebp, openssl, and a Chrome: chrome-headless-shell (`npm run chrome:install`) or CHROME_PATH. Takes a few minutes.
//
// What runs: a local demo store (scripts/shots/local.ts) with a stand-in speech engine (scripts/shots/speech.ts), a
// stand-in render tool for agents' `lampo render` (scripts/shots/render.ts) and one agent's run written as gone quiet
// (scripts/shots/runs.ts), and a hosted server behind an https front (scripts/shots/hosted.ts, scripts/shots/https.ts);
// Chrome reaches them as localhost:4747 and https://review.northwind.example. Everything lives in one temp folder,
// removed at the end.
//
// A screen that changed under the script (a selector gone, a state that never comes) stops the run with exit code 1:
// it says the last picture made and what it waited for, and leaves each open page in test-output/screenshots-failed/.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Browser } from 'puppeteer-core';
import { ROOT } from '../lib/paths.ts';
import { FFMPEG } from '../lib/probe.ts';
import { tmpdir } from '../test/lib/tmp.ts';
import { renderDemoMedia } from './demo/media.ts';
import { freePort, startServer } from './demo/server.ts';
import { populate } from './demo/store.ts';
import { Camera, launch, sleep } from './shots/camera.ts';
import { hostedPictures, PUBLIC_HOST } from './shots/hosted.ts';
import { httpsFront } from './shots/https.ts';
import { LOCAL_HOST, localPictures } from './shots/local.ts';
import { startSpeech } from './shots/speech.ts';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const only = arg('only') ? new Set((arg('only') as string).split(',').map((x) => x.trim().replace(/-light$/, ''))) : null;
const out = path.resolve(arg('out') || path.join(ROOT, 'docs/assets'));
for (const f of ['web/dist/index.html', 'web/dist-mcp/review.html'])
  if (!fs.existsSync(path.join(ROOT, f))) throw new Error(`${f} is missing: run \`npm run build\` first`);

// in this process's run root: gone when it ends, Ctrl-C included (test/lib/tmp.ts)
const dir = tmpdir('vr-shots-');
const stops: (() => unknown)[] = [];
// what a failure reports: the last picture made, and the pages as they were (test-output/, never the docs)
let browser: Browser | null = null;
let camera: Camera | null = null;
try {
  console.log('rendering the demo footage…');
  const media = renderDemoMedia(path.join(dir, 'media'));
  const speech = await startSpeech();
  stops.push(speech.close);
  const localPort = await freePort();
  const store = path.join(dir, 'local');
  const local = await startServer(store, {
    mediaRoot: media.root,
    port: localPort,
    // the machine's reviewer as the OS names them; the name they chose in the app (below) is the one clients see
    user: 'alex',
    vars: { LAMPO_STT: 'http', LAMPO_STT_URL: speech.url, LAMPO_STT_HTTP_MODEL: 'whisper-large-v3-turbo' },
  });
  stops.push(local.stop);
  const me = await fetch(`${local.url}/api/auth/me`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"name":"Alex"}' });
  if (!me.ok) throw new Error(`naming the owner: ${me.status} ${await me.text()}`);
  console.log('building the demo review history…');
  const demo = await populate(local.url, media);

  const hostedPort = await freePort();
  const front = await httpsFront(PUBLIC_HOST, `http://127.0.0.1:${hostedPort}`, path.join(dir, 'tls'));
  stops.push(front.close);
  // the fake microphone for recorded feedback: a tone (the stand-in speech engine says what was "said")
  const mic = path.join(dir, 'mic.wav');
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=20', '-ar', '48000', '-ac', '1', '-y', mic]);
  const chrome = await launch([
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${mic}`,
    `--host-resolver-rules=MAP ${LOCAL_HOST} 127.0.0.1:${localPort},MAP ${PUBLIC_HOST}:443 127.0.0.1:${front.port}`,
    '--ignore-certificate-errors',
  ]);
  browser = chrome;
  stops.push(() => chrome.close());
  await chrome.defaultBrowserContext().overridePermissions(`http://${LOCAL_HOST}`, ['microphone']);
  const cam = new Camera(out, path.join(dir, 'png'), only);
  camera = cam;
  const work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });

  console.log('pictures on this machine…');
  await localPictures({ browser: chrome, camera: cam, server: local, dir: store, media, demo, work });
  console.log('pictures of a hosted server…');
  await hostedPictures({ browser: chrome, camera: cam, dir: path.join(dir, 'hosted'), port: hostedPort, mediaRoot: media.root });

  const total = cam.made.reduce((n, x) => n + x.bytes, 0);
  console.log(`\n${cam.made.length} pictures, ${Math.round(total / 1000)} kB, in ${path.relative(process.cwd(), out) || out}`);
} catch (e) {
  // Say where it stopped and what it waited for, and keep what the pages showed: a screen the app changed fails the run
  // here, loudly, instead of leaving it waiting.
  const last = camera?.made.at(-1)?.name;
  console.error(`\nThe pictures stopped${last ? ` after ${last}` : ' before the first one'}:`);
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  if (browser) await failedPages(browser);
  process.exitCode = 1;
} finally {
  // each stop gets a moment, never for good: a server or browser that won't end doesn't keep the run waiting
  for (const stop of stops.reverse()) await Promise.race([Promise.resolve(stop()).catch(() => {}), sleep(10_000)]);
  fs.rmSync(dir, { recursive: true, force: true });
}
// What the story started and still holds (a render paused at 42 %, an agent's watch) ends with this process: it never
// keeps the run from ending (they are killed on exit, local.ts).
process.exit();

/** Every open page as it was when the run stopped, in test-output/screenshots-failed/ (ignored by git). */
async function failedPages(b: Browser): Promise<void> {
  const into = path.join(ROOT, 'test-output/screenshots-failed');
  fs.rmSync(into, { recursive: true, force: true });
  fs.mkdirSync(into, { recursive: true });
  let n = 0;
  for (const ctx of b.browserContexts())
    for (const p of await ctx.pages().catch(() => [])) {
      const file = path.join(into, `page-${++n}.png`);
      const shot = await Promise.race([p.screenshot({ path: file as `${string}.png` }).then(() => true), sleep(5000).then(() => false)]).catch(() => false);
      if (shot) console.error(`  ${path.relative(process.cwd(), file)}: ${p.url()}`);
    }
}
