// `npm run screenshots`: every picture of the app in docs/assets — the README's and the docs' — made again from a fresh
// demo (synthetic footage, made-up names), each in the dark theme (x.webp) and the light one (x-light.webp).
//   node scripts/screenshots.ts [--only player,board,…] [--out <dir>]
// --only writes just those pictures (the demo's story still runs in full, so they show what they always show); --out
// writes somewhere else than docs/assets. Needs `npm run build` (the app's UI and the MCP review card), ffmpeg with
// libwebp, openssl, and a Chrome: chrome-headless-shell (`npm run chrome:install`) or CHROME_PATH. Takes a few minutes.
//
// What runs: a local demo store (scripts/shots/local.ts) with a stand-in speech engine (scripts/shots/speech.ts), and a
// hosted server behind an https front (scripts/shots/hosted.ts, scripts/shots/https.ts); Chrome reaches them as
// localhost:4747 and https://review.northwind.example. Everything lives in one temp folder, removed at the end.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../lib/paths.ts';
import { FFMPEG } from '../lib/probe.ts';
import { renderDemoMedia } from './demo/media.ts';
import { freePort, startServer } from './demo/server.ts';
import { populate } from './demo/store.ts';
import { Camera, launch } from './shots/camera.ts';
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

const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'vr-shots-'));
const stops: (() => unknown)[] = [];
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
    vars: { VR_STT: 'http', VR_STT_URL: speech.url, VR_STT_HTTP_MODEL: 'whisper-large-v3-turbo' },
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
  const browser = await launch([
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${mic}`,
    `--host-resolver-rules=MAP ${LOCAL_HOST} 127.0.0.1:${localPort},MAP ${PUBLIC_HOST}:443 127.0.0.1:${front.port}`,
    '--ignore-certificate-errors',
  ]);
  stops.push(() => browser.close());
  await browser.defaultBrowserContext().overridePermissions(`http://${LOCAL_HOST}`, ['microphone']);
  const camera = new Camera(out, path.join(dir, 'png'), only);
  const work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });

  console.log('pictures on this machine…');
  await localPictures({ browser, camera, server: local, dir: store, media, demo, work });
  console.log('pictures of a hosted server…');
  await hostedPictures({ browser, camera, dir: path.join(dir, 'hosted'), port: hostedPort, mediaRoot: media.root });

  const total = camera.made.reduce((n, x) => n + x.bytes, 0);
  console.log(`\n${camera.made.length} pictures, ${Math.round(total / 1000)} kB, in ${path.relative(process.cwd(), out) || out}`);
} finally {
  for (const stop of stops.reverse()) await Promise.resolve(stop()).catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
}
