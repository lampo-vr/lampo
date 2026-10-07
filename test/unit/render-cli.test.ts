// `vr render -- <cmd>` on the store on this machine: a real ffmpeg encode of a generated clip put up as the next
// version (re-rendered to the tracked path, and from another file), its progress in the activity file the app tails,
// a failure's exit code and its redacted words; Remotion, aerender and Blender as stand-in scripts that print their
// lines (the real tools never run here); the growing-file reading for any other tool; a person's own render recording
// nothing; LAMPO_RUN on every line; Ctrl-C reaching the whole render; --detach and `vr render wait`, also a failure and
// a wait that ends at its bound.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { WATCH_NOW_LINE } from '../../lib/handoff.ts';
import type { AgentActivity } from '../../lib/types.ts';
import { FFMPEG, isolatedEnv, makeVideo, tmpdir, until, type VrResult, vr, vrAsync } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv({ vars: { VR_REMOTE: '0' } });
const work = path.join(dir, 'work');
fs.mkdirSync(work, { recursive: true });
const src = makeVideo(path.join(work, 'src.mp4'), { w: 320, h: 180, fps: 25, dur: 2 });
// the clip every stand-in "renders": a real video, so it can become a version
const standinClip = makeVideo(path.join(dir, 'standin.mp4'), { w: 320, h: 180, fps: 25, dur: 1, pattern: 'testsrc2' });
// what the held renders write: other bytes, so each is a version of its own
const heldClip = makeVideo(path.join(dir, 'held.mp4'), { w: 320, h: 180, fps: 25, dur: 1, pattern: 'smptebars' });
const clip = path.join(work, 'clip.mp4');
fs.copyFileSync(src, clip);
const old = new Date(Date.now() - 60_000);
fs.utimesSync(clip, old, old);

const ACTIVITY = path.join(env.VR_CACHE as string, 'agent-activity.jsonl');
const agentEnv = { ...env, VR_BY: 'agent:reel-cut', STANDIN_CLIP: standinClip, HELD_CLIP: heldClip };
const run = (args: string[], e: NodeJS.ProcessEnv = agentEnv): VrResult => vr(args, e, { cwd: work });
type Line = AgentActivity & { video?: string | null };
/** The activity lines written since `from` (a count of lines). */
const activity = (from = 0): Line[] =>
  fs.existsSync(ACTIVITY)
    ? fs
        .readFileSync(ACTIVITY, 'utf8')
        .split('\n')
        .filter(Boolean)
        .slice(from)
        .map((l) => JSON.parse(l) as Line)
    : [];
const linesNow = () => activity().length;
/** The newest version of the video whose file is (or was uploaded as) `name`. */
const versions = (name = clip): number => {
  const ls = JSON.parse(run(['ls', '--json'], env).out) as { video: string; v: number }[];
  return ls.find((r) => r.video === name || r.video.endsWith(`/${name}`))?.v ?? 0;
};

// Stand-ins for the tools that are never installed or run here: executables named like them that print their lines.
const bin = tmpdir('vr-render-bin-');
function standIn(name: string, body: string): string {
  const file = path.join(bin, name);
  fs.writeFileSync(
    file,
    `#!${process.execPath}\nconst fs = require('node:fs');\nconst sleep = (ms) => new Promise((r) => setTimeout(r, ms));\n(async () => {\n${body}\n})();\n`,
    {
      mode: 0o755,
    },
  );
  return file;
}
const remotion = standIn(
  'remotion',
  `fs.writeFileSync(process.env.STANDIN_SAW, JSON.stringify({ tty: !!process.stdout.isTTY, args: process.argv.slice(2) }));
  for (const p of [8, 61, 100]) { console.log('Bundling ' + p + '%'); await sleep(60); }
  console.log('Getting composition');
  for (let f = 0; f <= 90; f += 9) { console.log('Rendered ' + f + '/90' + (f ? ', time remaining: ' + (90 - f) / 10 + 's' : '')); await sleep(60); }
  for (const f of [30, 90]) { console.log('Encoded ' + f + '/90'); await sleep(60); }
  fs.copyFileSync(process.env.STANDIN_CLIP, process.argv.at(-1));
  console.log('\\x1b[34m+ ' + process.argv.at(-1) + '\\x1b[39m 0.1 MB');`,
);
const aerender = standIn(
  'aerender',
  `const lines = ['Start: 0:00:00:00', 'End: 0:00:09:29', 'Duration: 0:00:10:00', 'Frame Rate: 30.00 (comp)'];
  for (const l of lines) console.log('PROGRESS:  ' + l);
  for (const [tc, n] of [['0:00:00:00', 1], ['0:00:04:29', 150], ['0:00:09:29', 300]]) { console.log('PROGRESS:  ' + tc + ' (' + n + '): 1 Seconds'); await sleep(80); }
  fs.writeFileSync(process.argv[process.argv.indexOf('-output') + 1], 'mov');`,
);
const blender = standIn(
  'blender',
  `for (let f = 1; f <= 4; f++) { console.log('00:00.1  render           | Rendering frame ' + f); console.log('00:00.2  render           | Fra: ' + f + ' | Mem:31M'); await sleep(80); }`,
);
// any other tool: a script that writes its output in pieces
const grow = path.join(bin, 'grow.cjs');
fs.writeFileSync(
  grow,
  `const fs = require('node:fs');
const out = process.argv[2];
let n = 0;
const t = setInterval(() => {
  fs.appendFileSync(out, Buffer.alloc(700_000, n));
  if (++n === 6) { clearInterval(t); }
}, 450);`,
);
// a render that waits for a go (a file), then writes the clip and exits with the code it was given
const hold = path.join(bin, 'hold.cjs');
fs.writeFileSync(
  hold,
  `const fs = require('node:fs');
const [go, out, code] = process.argv.slice(2);
fs.writeFileSync(go + '.pid', String(process.pid));
const t = setInterval(() => {
  if (!fs.existsSync(go)) return;
  clearInterval(t);
  if (code === '0') fs.copyFileSync(process.env.HELD_CLIP, out);
  else console.error('Error: the font Inter Display is missing (api_key=supersecret12345)');
  process.exit(Number(code));
}, 30);`,
);
const sawFile = path.join(dir, 'remotion-saw.json');

const HAND_OFF = /^Now listen with vr watch/;

test('ffmpeg, re-rendered to the tracked path: the next version, its progress in Lampo, two lines for the model', () => {
  assert.equal(run(['track', clip], env).code, 0);
  assert.equal(versions(), 1);
  const from = linesNow();
  const r = run([
    'render',
    '--to',
    clip,
    '--out',
    clip,
    '--',
    FFMPEG,
    '-y',
    '-i',
    'src.mp4',
    '-vf',
    'hue=s=0',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    'clip.mp4',
  ]);
  assert.equal(r.code, 0, r.err);
  const out = r.out.trim().split('\n');
  assert.equal(out.length, 2, r.out);
  assert.match(out[0], /^V2 rendered in \d+s and put up for review \(50 frames\)\.$/);
  assert.match(out[1], HAND_OFF);
  assert.equal(r.err, '', 'quiet: nothing of the tool’s output');
  assert.equal(versions(), 2);
  const lines = activity(from);
  assert.ok(
    lines.every((l) => l.agent === 'reel-cut' && l.video === clip.split('/').join('__')),
    JSON.stringify(lines),
  );
  const progress = lines.filter((l) => l.progress);
  assert.ok(
    progress.some((l) => l.kind === 'render' && l.progress?.tool === 'ffmpeg' && l.progress.v === 2),
    JSON.stringify(progress),
  );
  const done = progress.findLast((l) => l.kind === 'render');
  assert.deepEqual(done?.progress && { pct: done.progress.pct, frames: done.progress.frames }, { pct: 100, frames: [50, 50] });
  assert.equal(done?.pct, 100, 'pct too, for older readers');
  assert.ok(progress.some((l) => l.progress?.stage === 'checking' && l.progress.what === 'check'));
  const last = lines.at(-1);
  assert.equal(last?.text, 'Put a new version up for review');
  assert.equal(last?.target, 'v2');
  assert.equal(last?.progress, undefined, 'the last line carries no progress: it ended');
});

test('a video put up before: the render goes up as its next version (as vr push --to), and a note open says so', () => {
  assert.equal(run(['push', 'src.mp4', '--name', 'pushed.mp4'], env).code, 0);
  assert.equal(run(['add', 'pushed.mp4', '--frame', '10', '--text', 'Logo too late', '--kind', 'feedback'], env).code, 0);
  const r = run([
    'render',
    '--to',
    'pushed.mp4',
    '--out',
    'v2.mp4',
    '--',
    FFMPEG,
    '-y',
    '-i',
    'src.mp4',
    '-vf',
    'negate',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    'v2.mp4',
  ]);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split('\n');
  assert.match(lines[0], /^V2 rendered in \d+s and put up for review \(50 frames\)\. Now mark each note fixed\.$/);
  assert.equal(lines[1], '1 note still open on this video.');
  assert.equal(versions('pushed.mp4'), 2);
  // a video linked to its file here takes its versions from that file: another --out is refused before rendering
  const linked = run(['render', '--to', clip, '--out', 'elsewhere.mp4', '--', FFMPEG, '-y', '-i', 'src.mp4', 'elsewhere.mp4']);
  assert.equal(linked.code, 1);
  assert.match(linked.err, /clip\.mp4 is linked to its file on this machine: render to it \(--out .*clip\.mp4\)/);
  assert.ok(!fs.existsSync(path.join(work, 'elsewhere.mp4')), 'nothing was rendered');
});

test('--folder: a new video’s V1 into a project, tracked where it is; then wait for the person', () => {
  const r = run([
    'render',
    '--folder',
    'Acme/Launch',
    '--out',
    'launch.mp4',
    '--',
    FFMPEG,
    '-y',
    '-i',
    'src.mp4',
    '-vf',
    'hflip',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    'launch.mp4',
  ]);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split('\n');
  assert.match(lines[0], /^V1 rendered in \d+s and put up for review in Acme\/Launch \(50 frames\)\.$/);
  assert.equal(lines[1], WATCH_NOW_LINE);
  const ls = JSON.parse(run(['ls', '--json'], env).out) as { video: string; v: number; folder: string | null }[];
  const v1 = ls.find((x) => x.video === path.join(work, 'launch.mp4'));
  assert.deepEqual([v1?.v, v1?.folder], [1, 'Acme/Launch'], 'linked where it lies, in the project');
  // the next version is a re-render to that path
  assert.equal(versions(path.join(work, 'launch.mp4')), 1);
  // refused before anything runs: --folder with --to, without --out, without a name
  const marker = path.join(work, 'ran-folder');
  const touch = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`];
  assert.match(run(['render', '--folder', 'Acme', '--to', clip, '--out', clip, '--', ...touch]).err, /--to puts up a next version, --folder a new video's V1/);
  assert.match(run(['render', '--folder', 'Acme', '--', ...touch]).err, /--folder needs --out/);
  assert.match(run(['render', '--folder', ' / ', '--out', 'x.mp4', '--', ...touch]).err, /--folder names the project/);
  assert.ok(!fs.existsSync(marker), 'nothing ran');
});

test('a failed render: the tool’s exit code, one line, the error in Lampo with its redacted words', () => {
  const from = linesNow();
  const r = run(['render', '--to', 'pushed.mp4', '--out', 'v3.mp4', '--', FFMPEG, '-y', '-i', 'missing.mp4', 'v3.mp4']);
  assert.notEqual(r.code, 0);
  assert.match(r.out.trim(), new RegExp(`^Render failed \\(exit ${r.code}\\): .*No such file or directory\\. The person sees it in Lampo\\.$`));
  const err = activity(from).at(-1);
  assert.equal(err?.kind, 'error');
  assert.equal(err?.key, 'The render failed (exit {code})');
  assert.deepEqual(err?.vars, { code: r.code });
  assert.match(err?.quote ?? '', /missing\.mp4/);
  assert.equal(err?.progress?.v, 3, 'which version failed');
  assert.equal(versions('pushed.mp4'), 2);
  // a tool that prints a secret as it fails: gone from the line and from what Lampo gets
  const from2 = linesNow();
  const leak = run([
    'render',
    '--',
    process.execPath,
    '-e',
    "console.error('upload to https://render:hunter2@cdn.example.com failed, token=abc123secret'); process.exit(3)",
  ]);
  assert.equal(leak.code, 3);
  assert.ok(!/hunter2|abc123secret/.test(leak.out), leak.out);
  const words = activity(from2).at(-1);
  assert.ok(words?.quote && !/hunter2|abc123secret/.test(words.quote) && words.quote.includes('[redacted]'), JSON.stringify(words));
  assert.ok(!/hunter2|abc123secret/.test(words?.text ?? ''));
  // a command that isn't there
  const none = run(['render', '--', 'no-such-render-tool-x', '--go']);
  assert.equal(none.code, 127);
  assert.match(none.out, /^Render failed \(exit 127\): command not found: no-such-render-tool-x\./);
  // a command that exits 0 without writing --out: nothing to put up, said by the file's name
  const empty = run(['render', '--to', 'pushed.mp4', '--out', 'out/nothing.mp4', '--', process.execPath, '-e', '']);
  assert.equal(empty.code, 1);
  assert.equal(empty.out, "Render failed (exit 1): it finished, but nothing.mp4 isn't there: check --out. The person sees it in Lampo.\n");
  assert.equal(versions('pushed.mp4'), 2);
});

test('Remotion (a stand-in): run without a terminal; bundling, rendering, encoding, each stage from 0', () => {
  const from = linesNow();
  const r = run(['render', '--to', 'pushed.mp4', '--out', 'remotion.mp4', '--', remotion, 'render', 'src/index.ts', 'Main', 'remotion.mp4'], {
    ...agentEnv,
    STANDIN_SAW: sawFile,
  });
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /^V3 rendered in \d+s and put up for review \(25 frames\)\./);
  assert.deepEqual(JSON.parse(fs.readFileSync(sawFile, 'utf8')), { tty: false, args: ['render', 'src/index.ts', 'Main', 'remotion.mp4'] });
  const stages = activity(from)
    .filter((l) => l.progress && l.kind === 'render')
    .map((l) => ({ stage: l.progress?.stage, pct: l.progress?.pct ?? null, tool: l.progress?.tool }));
  // before the tool says anything it renders; then its own stages, in order
  const order = stages.map((s) => s.stage).filter((s, i, a) => i === 0 || a[i - 1] !== s);
  assert.deepEqual(order, ['rendering', 'bundling', 'rendering', 'encoding'], JSON.stringify(stages));
  // each stage from 0 again: rendering doesn't go on from bundling's 100
  const bundled = stages.findLastIndex((s) => s.stage === 'bundling');
  assert.equal(stages[bundled].pct, 100);
  assert.ok((stages[bundled + 1].pct ?? 100) < 50, JSON.stringify(stages));
  assert.ok(stages.slice(1).every((s) => s.tool === 'remotion'));
  assert.ok(stages.some((s) => s.stage === 'encoding' && s.pct === 100));
});

test('aerender and Blender (stand-ins), without --to: they only report and render', () => {
  const from = linesNow();
  const ae = run(['render', '--out', 'spot.mov', '--', aerender, '-project', 'spot.aep', '-comp', 'Main', '-output', 'spot.mov']);
  assert.equal(ae.code, 0, ae.err);
  assert.match(ae.out.trim(), /^Rendered spot\.mov in \d+s \(300 frames\)\.$/);
  const aeLines = activity(from).filter((l) => l.progress?.tool === 'aerender');
  assert.ok(aeLines.length >= 2, JSON.stringify(activity(from)));
  assert.deepEqual(aeLines.at(-1)?.progress?.frames, [300, 300]);
  assert.equal(activity(from).at(-1)?.key, 'Rendered in {time}');
  assert.equal(versions('pushed.mp4'), 3, 'nothing was put up');
  const from2 = linesNow();
  const bl = run(['render', '--', blender, '-b', 'scene.blend', '-o', '//f_', '-s', '1', '-e', '4', '-a']);
  assert.equal(bl.code, 0, bl.err);
  assert.match(bl.out.trim(), /^Rendered in \d+s \(4 frames\)\.$/);
  assert.ok(activity(from2).some((l) => l.progress?.tool === 'blender' && l.progress.frames?.[0] === 3));
});

test('any other tool: the output growing, in MB, with no percentage', () => {
  const from = linesNow();
  const r = run(['render', '--out', 'grown.bin', '--', process.execPath, grow, 'grown.bin']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out.trim(), /^Rendered grown\.bin in \d+s\.$/);
  const growing = activity(from).filter((l) => l.key === 'Rendering… {mb} MB, still growing');
  assert.ok(growing.length >= 1, JSON.stringify(activity(from)));
  assert.ok(growing.every((l) => l.progress?.pct === null && l.progress.tool === undefined && l.pct === undefined));
  assert.ok(Number(growing.at(-1)?.vars?.mb) >= 1);
});

test('a person’s own vr render records nothing; LAMPO_RUN names the run on every line, of every vr command', () => {
  const before = linesNow();
  const own = vr(['render', '--', FFMPEG, '-y', '-i', 'src.mp4', '-frames:v', '5', 'own.mp4'], env, { cwd: work });
  assert.equal(own.code, 0, own.err);
  assert.match(own.out.trim(), /^Rendered in \d+s \(5 frames\)\.$/);
  assert.equal(linesNow(), before, 'a person’s render is not agent activity');
  const failed = vr(['render', '--', FFMPEG, '-i', 'missing.mp4', 'x.mp4'], env, { cwd: work });
  assert.match(failed.out, /^Render failed \(exit \d+\): .*\.\n$/, 'no "sees it in Lampo": nobody was told');
  // a run Lampo started: its id on each line; no name of its own makes it "agent"
  const runEnv = { ...env, LAMPO_RUN: 'run_0123456789ab' };
  assert.equal(vr(['render', '--', FFMPEG, '-y', '-i', 'src.mp4', '-frames:v', '5', 'run.mp4'], runEnv, { cwd: work }).code, 0);
  assert.equal(vr(['open', clip], { ...runEnv, VR_BY: 'agent:reel-cut' }, { cwd: work }).code, 0);
  const tagged = activity(before);
  assert.ok(tagged.length >= 3);
  assert.ok(
    tagged.every((l) => l.run === 'run_0123456789ab'),
    JSON.stringify(tagged),
  );
  assert.equal(tagged[0].agent, 'agent');
  assert.equal(tagged.at(-1)?.agent, 'reel-cut');
  // not a run id: no tag, and not an agent
  const n = linesNow();
  vr(['render', '--', FFMPEG, '-y', '-i', 'src.mp4', '-frames:v', '5', 'x2.mp4'], { ...env, LAMPO_RUN: '../etc' }, { cwd: work });
  assert.equal(linesNow(), n);
});

test('usage: the command after --, --to with --out, and a video that isn’t there refused before anything runs', () => {
  const marker = path.join(work, 'ran');
  const touch = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`];
  assert.equal(run(['render', ...touch]).code, 1, 'no --');
  assert.equal(run(['render', '--']).code, 1, 'no command');
  assert.match(run(['render', '--to', clip, '--', ...touch]).err, /--to needs --out/);
  assert.equal(run(['render', '--to', 'nothing-like-it.mp4', '--out', 'n.mp4', '--', ...touch]).code, 1);
  assert.ok(!fs.existsSync(marker), 'nothing ran');
  const help = run(['render', '--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /^ {2}vr render \[--to <video> --out <file>\] \[--detach\] -- <command>/m);
  assert.match(help.out, /^ {2}vr render wait <id>/m);
  // what follows -- is the tool's: vr reads no option of it
  assert.equal(run(['render', '--', FFMPEG, '-hide_banner', '-version']).code, 0);
});

test('Ctrl-C reaches the whole render: it stops, vr says so and exits with its code', async () => {
  const go = path.join(dir, 'never-go');
  const p = vrAsync(['render', '--', process.execPath, hold, go, path.join(work, 'held.mp4'), '0'], agentEnv);
  let out = '';
  p.stdout.on('data', (d) => {
    out += d;
  });
  const pid = Number(await until(() => fs.existsSync(`${go}.pid`) && fs.readFileSync(`${go}.pid`, 'utf8'), 'the render started'));
  p.kill('SIGINT');
  const code = await new Promise<number | null>((r) => p.on('close', (c) => r(c)));
  assert.equal(code, 130);
  assert.match(out, /^Render failed \(exit 130\): stopped\. The person sees it in Lampo\./);
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 'the tool itself is gone');
});

test('--detach + vr render wait: returns at once, waits at most its bound, then the finished line', async () => {
  const go = path.join(dir, 'go-1');
  const d = run(['render', '--detach', '--to', 'pushed.mp4', '--out', 'detached.mp4', '--', process.execPath, hold, go, 'detached.mp4', '0']);
  assert.equal(d.code, 0, d.err);
  const m = /^Rendering V4 \(render (r_[0-9a-f]{10})\): run vr render wait \1 now\.\n$/.exec(d.out);
  assert.ok(m, d.out);
  const id = m[1];
  // its state lives in the cache, readable by its owner only; never in data/
  const state = path.join(env.VR_CACHE as string, 'renders', id, 'state.json');
  assert.ok(fs.existsSync(state));
  assert.equal(fs.statSync(state).mode & 0o077, 0);
  // a wait that ends at its bound (a tiny one only tests set): one line, call again
  const still = run(['render', 'wait', id], { ...agentEnv, VR_RENDER_WAIT_MS: '300' });
  assert.equal(still.code, 0);
  assert.match(still.out, new RegExp(`^Still rendering V4: .*\\. Run vr render wait ${id} again now\\.\\n$`));
  fs.writeFileSync(go, '');
  const done = run(['render', 'wait', id]);
  assert.equal(done.code, 0, done.out + done.err);
  const lines = done.out.trim().split('\n');
  assert.match(lines[0], /^V4 rendered in \d+s and put up for review \(25 frames\)\. Now mark each note fixed\.$/);
  assert.equal(lines[1], '1 note still open on this video.');
  assert.equal(versions('pushed.mp4'), 4);
  // asked again later: the same answer
  assert.equal(run(['render', 'wait', id]).out, done.out);
  assert.ok(!fs.readdirSync(path.join(env.VR_DATA as string)).includes('renders'));
});

test('--detach: a failure comes back through wait with the tool’s code; a command that isn’t there fails at once', async () => {
  const go = path.join(dir, 'go-2');
  const d = run(['render', '--detach', '--to', 'pushed.mp4', '--out', 'f.mp4', '--', process.execPath, hold, go, 'f.mp4', '5']);
  const id = (/(r_[0-9a-f]{10})/.exec(d.out) ?? [])[1] as string;
  assert.ok(id, d.out);
  fs.writeFileSync(go, '');
  const w = run(['render', 'wait', id]);
  assert.equal(w.code, 5);
  assert.match(w.out, /^Render failed \(exit 5\): Error: the font Inter Display is missing \(api_key=\[redacted\]\)\. The person sees it in Lampo\.\n$/);
  const none = run(['render', '--detach', '--', 'no-such-render-tool-y']);
  assert.equal(none.code, 127);
  assert.match(none.out, /^Render failed \(exit 127\): command not found/);
  // unknown and malformed ids
  assert.equal(run(['render', 'wait', 'r_0000000000']).code, 2);
  assert.equal(run(['render', 'wait', '../../etc']).code, 1);
});
