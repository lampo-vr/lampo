// covers: lib/render/job.ts lib/store.ts lib/backend/local.ts lib/cliRender.ts lib/render/detach.ts
// A stop that comes once the render's tool has ended, while this machine's store takes the file in, puts nothing up —
// or, when the store had already registered it, says so instead of claiming success. The take-in is made long enough
// to stop in with an ffprobe that is slow once (as a big render's probe and hash are); the real ffprobe answers after.
// And a linked video rendered in place: the file a stopped render left there is not its next version, for any later
// sync either (`lampo sync`, the app's watcher, `lampo`'s own lookups), until it is rendered again; the file stays.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { age, FFMPEG, isolatedEnv, makeVideo, until, vr, vrAsync } from '../lib/helpers.ts';

const FFPROBE = path.join(path.dirname(FFMPEG), 'ffprobe');
const { dir, env } = isolatedEnv({ vars: { VR_REMOTE: '0' } });
const work = path.join(dir, 'work');
fs.mkdirSync(work, { recursive: true });
let k = 0;
/** Bytes of their own each time: each would be a version. */
const clipOf = (name: string) =>
  makeVideo(path.join(dir, `${name}.mp4`), { w: 160, h: 90, fps: 25, dur: 1, freq: 300 + 40 * ++k, pattern: k % 2 ? 'smptebars' : 'testsrc2' });
const clip = makeVideo(path.join(work, 'clip.mp4'), { w: 160, h: 90, fps: 25, dur: 1 });
age(clip);

// ffprobe, slow once while <SLOW> exists; <SLOW>.hit says the store has begun taking a file in
const SLOW = path.join(dir, 'slow');
const slowProbe = path.join(dir, 'ffprobe-slow.sh');
fs.writeFileSync(slowProbe, `#!/bin/sh\nif [ -f "${SLOW}" ]; then rm -f "${SLOW}"; touch "${SLOW}.hit"; sleep 4; fi\nexec "${FFPROBE}" "$@"\n`, {
  mode: 0o755,
});
const agentEnv = { ...env, VR_BY: 'agent:reel-cut', VR_FFPROBE: slowProbe };
const slowOnce = () => {
  fs.rmSync(`${SLOW}.hit`, { force: true });
  fs.writeFileSync(SLOW, '');
};
const takingIn = () => until(() => fs.existsSync(`${SLOW}.hit`), 'the store taking the file in', 60_000);

// the render: copies a clip to its output and exits 0
const quick = path.join(dir, 'quick.cjs');
fs.writeFileSync(quick, `require('node:fs').copyFileSync(process.argv[2], process.argv[3]);`);
// a render stopped while it writes the tracked file: on SIGINT it writes what it has (other bytes) and exits 0
const runsOn = path.join(dir, 'runs-on.cjs');
fs.writeFileSync(
  runsOn,
  `const fs = require('node:fs');
fs.writeFileSync(process.argv[4], String(process.pid));
process.on('SIGINT', () => { fs.copyFileSync(process.argv[2], process.argv[3]); process.exit(0); });
setInterval(() => {}, 1000);`,
);

const versions = (name: string): number => {
  const ls = JSON.parse(vr(['ls', '--json'], env, { cwd: work }).out) as { video: string; v: number }[];
  return ls.find((r) => r.video === name || r.video.endsWith(`/${name}`))?.v ?? 0;
};
function render(args: string[]) {
  const p = vrAsync(['render', ...args], agentEnv);
  let out = '';
  p.stdout.on('data', (d) => {
    out += d;
  });
  p.stderr.on('data', (d) => {
    out += d;
  });
  const done = new Promise<{ code: number | null; out: string }>((r) => p.on('close', (code) => r({ code, out })));
  return { p, done };
}

test('setup: an uploaded copy and a linked video, each at V1', () => {
  assert.equal(vr(['push', clip, '--name', 'pushed.mp4'], env, { cwd: work }).code, 0);
  assert.equal(vr(['track', clip], env, { cwd: work }).code, 0);
  assert.equal(versions('pushed.mp4'), 1);
  assert.equal(versions(clip), 1);
});

test('a Ctrl-C while the store takes the render in puts nothing up, and says it stopped', async () => {
  const before = versions('pushed.mp4');
  const out = path.join(work, 'take-in.mp4');
  slowOnce();
  const r = render(['--to', 'pushed.mp4', '--out', out, '--', process.execPath, quick, clipOf('a'), out]);
  await takingIn();
  r.p.kill('SIGINT');
  const { code, out: said } = await r.done;
  assert.equal(code, 130, said);
  assert.match(said, /^Render failed \(exit 130\): stopped\. The person sees it in Lampo\./m);
  assert.equal(versions('pushed.mp4'), before, 'nothing put up');
});

// The hash, not the probe: `lampo` itself is held in its synchronous read of the rendered file (a preload blocks the first
// read for 3 s), so the Ctrl-C lands while nothing can handle it. The probe before it closes its output before it exits:
// its answer then comes with the exit, in a poll phase, and the hash runs there, where one `setImmediate` comes before the
// next poll and so before the signal is heard (an answer that comes with the closed output runs after the poll already).
const lateExit = path.join(dir, 'ffprobe-late-exit.sh');
fs.writeFileSync(lateExit, `#!/bin/sh\n"${FFPROBE}" "$@"\ncode=$?\nexec >&- 2>&-\nsleep 0.3\nexit $code\n`, { mode: 0o755 });
const hashSlow = path.join(dir, 'hash-slow.mjs');
fs.writeFileSync(
  hashSlow,
  `import fs from 'node:fs';
const target = process.env.HASH_SLOW_FILE;
const fds = new Set();
const open = fs.openSync;
fs.openSync = function (p, ...rest) { const fd = open.call(this, p, ...rest); if (target && String(p) === target) fds.add(fd); return fd; };
const read = fs.readSync;
let done = false;
fs.readSync = function (fd, ...rest) {
  if (!done && fds.has(fd) && fs.existsSync(process.env.HASH_SLOW_ARM)) {
    done = true;
    fs.writeFileSync(process.env.HASH_SLOW_ARM + '.hit', '');
    const t = Date.now();
    while (Date.now() - t < 3000) {}
  }
  return read.call(this, fd, ...rest);
};
`,
);
test('a Ctrl-C while the store hashes the render (synchronous work) puts nothing up, every time', async () => {
  const ARM = path.join(dir, 'hash-arm');
  for (let i = 0; i < 3; i++) {
    const before = versions('pushed.mp4');
    const out = path.join(work, `hashed-${i}.mp4`);
    fs.rmSync(`${ARM}.hit`, { force: true });
    fs.writeFileSync(ARM, '');
    const p = vrAsync(['render', '--to', 'pushed.mp4', '--out', out, '--', process.execPath, quick, clipOf(`h${i}`), out], {
      ...agentEnv,
      VR_FFPROBE: lateExit,
      NODE_OPTIONS: `--import=${pathToFileURL(hashSlow).href}`,
      HASH_SLOW_FILE: out,
      HASH_SLOW_ARM: ARM,
    });
    let said = '';
    p.stdout.on('data', (d) => {
      said += d;
    });
    const done = new Promise<number | null>((r) => p.on('close', (code) => r(code)));
    await until(() => fs.existsSync(`${ARM}.hit`), 'lampo hashing the render', 60_000);
    p.kill('SIGINT');
    const code = await done;
    fs.rmSync(ARM, { force: true });
    assert.equal(code, 130, said);
    assert.match(said, /^Render failed \(exit 130\): stopped\. The person sees it in Lampo\./m, `run ${i + 1}`);
    assert.equal(versions('pushed.mp4'), before, `run ${i + 1}: nothing put up`);
  }
});

// The copy into the store, after the last look at the stop before it: a preload holds `lampo`'s copy of the rendered
// file 3 s (a big render's copy), blocking if it is made synchronously, so the Ctrl-C lands while it runs.
const copySlow = path.join(dir, 'copy-slow.mjs');
fs.writeFileSync(
  copySlow,
  `import fs from 'node:fs';
const target = process.env.COPY_SLOW_FILE;
const arm = process.env.COPY_SLOW_ARM;
const armed = (src) => target && String(src) === target && fs.existsSync(arm) && (fs.rmSync(arm), fs.writeFileSync(arm + '.hit', ''), true);
const copySync = fs.copyFileSync;
fs.copyFileSync = function (src, ...rest) {
  if (armed(src)) { const t = Date.now(); while (Date.now() - t < 3000) {} }
  return copySync.call(this, src, ...rest);
};
const copy = fs.promises.copyFile;
fs.promises.copyFile = async function (src, ...rest) {
  if (armed(src)) await new Promise((r) => setTimeout(r, 3000));
  return copy.call(this, src, ...rest);
};
`,
);
test('a Ctrl-C while the store copies the render in puts nothing up, every time', async () => {
  const ARM = path.join(dir, 'copy-arm');
  for (let i = 0; i < 2; i++) {
    const before = versions('pushed.mp4');
    const out = path.join(work, `copied-${i}.mp4`);
    fs.rmSync(`${ARM}.hit`, { force: true });
    fs.writeFileSync(ARM, '');
    const p = vrAsync(['render', '--to', 'pushed.mp4', '--out', out, '--', process.execPath, quick, clipOf(`k${i}`), out], {
      ...agentEnv,
      NODE_OPTIONS: `--import=${pathToFileURL(copySlow).href}`,
      COPY_SLOW_FILE: out,
      COPY_SLOW_ARM: ARM,
    });
    let said = '';
    p.stdout.on('data', (d) => {
      said += d;
    });
    const done = new Promise<number | null>((r) => p.on('close', (code) => r(code)));
    await until(() => fs.existsSync(`${ARM}.hit`), 'lampo copying the render in', 60_000);
    p.kill('SIGINT');
    const code = await done;
    assert.equal(code, 130, said);
    assert.match(said, /^Render failed \(exit 130\): stopped\. The person sees it in Lampo\./m, `run ${i + 1}`);
    assert.equal(versions('pushed.mp4'), before, `run ${i + 1}: nothing put up`);
    const left = (fs.readdirSync(env.VR_DATA as string, { recursive: true }) as string[]).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(left, [], 'no half copy left behind');
  }
});

test('the same for a detached render stopped with SIGTERM while it is taken in', async () => {
  const before = versions('pushed.mp4');
  const out = path.join(work, 'take-in-detached.mp4');
  slowOnce();
  const d = vr(['render', '--detach', '--to', 'pushed.mp4', '--out', out, '--', process.execPath, quick, clipOf('b'), out], agentEnv, { cwd: work });
  const id = /(r_[0-9a-f]{10})/.exec(d.out)?.[1];
  assert.ok(id, d.out + d.err);
  await takingIn();
  process.kill(Number(fs.readFileSync(path.join(env.VR_CACHE as string, 'renders', id, 'supervisor.pid'), 'utf8')), 'SIGTERM');
  const w = vr(['render', 'wait', id], agentEnv, { cwd: work });
  assert.equal(w.code, 130, w.out + w.err);
  assert.match(w.out, /^Render failed \(exit 130\): stopped/m);
  assert.equal(versions('pushed.mp4'), before, 'nothing put up');
});

test('a stop that lands while a linked render is being registered says the version went up, with a non-zero exit', async () => {
  const before = versions(clip);
  slowOnce();
  // the render writes the tracked file itself; it is registered where it is (the probe of that is the slow one)
  const r = render(['--to', clip, '--out', clip, '--', process.execPath, quick, clipOf('c'), clip]);
  await takingIn();
  r.p.kill('SIGINT');
  const { code, out: said } = await r.done;
  assert.equal(code, 130, said);
  assert.match(said, new RegExp(`^Stopped, but V${before + 1} was already put up for review\\.$`, 'm'));
  assert.doesNotMatch(said, /rendered in .* and put up for review/);
  assert.equal(versions(clip), before + 1, 'the store had it: it says so');
});

test('the file a stopped linked render left in place is no version for later syncs, until it is rendered again', async () => {
  const before = versions(clip);
  const ran = path.join(dir, 'runs-on.pid');
  fs.rmSync(ran, { force: true });
  const r = render(['--to', clip, '--out', clip, '--', process.execPath, runsOn, clipOf('d'), clip, ran]);
  await until(() => fs.existsSync(ran), 'the render runs');
  r.p.kill('SIGINT');
  const { code, out: said } = await r.done;
  assert.equal(code, 130, said);
  const left = fs.readFileSync(clip);
  // once the file looks settled (a file younger than 3 s counts as still being written), a sync would have taken it in
  await until(() => Date.now() - fs.statSync(clip).mtimeMs > 3500, 'the left file settled', 10_000);
  const sync = vr(['sync', clip], env, { cwd: work });
  assert.equal(sync.code, 0, sync.err);
  assert.match(sync.out, /what a stopped lampo render left/);
  assert.equal(versions(clip), before, 'not taken in by lampo sync or ls');
  assert.deepEqual(fs.readFileSync(clip), left, 'the file stays as the render left it');
  // a touch (an editor, a sync tool) changes the time, not the content: still set aside
  age(clip, 30);
  assert.match(vr(['sync', clip], env, { cwd: work }).out, /what a stopped lampo render left/);
  assert.equal(versions(clip), before, 'a touch takes nothing in');
  // rendered again: the next version comes in as always
  fs.copyFileSync(clipOf('e'), clip);
  age(clip);
  assert.match(vr(['sync', clip], env, { cwd: work }).out, /^registered v\d+/);
  assert.equal(versions(clip), before + 1);
});
