// covers: lib/render/job.ts lib/render/run.ts lib/cliRender.ts lib/render/detach.ts lib/backend/remote.ts
// A stopped `lampo render` never puts anything up. The tool may exit 0 when it is stopped (a wrapper script without
// `set -e` runs on after ffmpeg wrote its trailer to a file cut short): the stop decides, not the exit code. And a stop
// that comes once the tool has ended, while the render goes up to a server, ends the upload: nothing is registered, the
// command says it stopped. Real `lampo` against a hosted app in this process, through a stand-in proxy that can hold an
// upload's bytes on their way (a slow connection).
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, makeVideo, tmpdir, until, VR } from '../lib/helpers.ts';
import { tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');
const owner = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
const token = auth.createToken(owner.id, 'render').token;
const work = path.join(dir, 'work');
fs.mkdirSync(work, { recursive: true });
const v1 = makeVideo(path.join(dir, 'renders/spot.mp4'), { w: 320, h: 180, fps: 25, dur: 1 });
// what the tool "renders": other bytes, so it would be a version of its own
const rendered = makeVideo(path.join(dir, 'renders/next.mp4'), { w: 320, h: 180, fps: 25, dur: 1, pattern: 'smptebars' });

// The proxy `lampo` talks to: everything goes through, except an upload's bytes (PATCH) while `holding` — those are not
// read until released (a slow link: the sender can't get them all out) and go nowhere once their sender has gone
// (`drop`: a paused request never reads its sender's close, so `gone` can't tell) — and the server's answer to the bytes
// of an upload sent while `holdingAnswers` (they went in; the answer waits here). Only bytes that came in while answers
// are held count: an earlier render's, let go late, would be answered while the next test listens, as if it were its
// own render's. `pendingSeen`: the server answered an upload "pending" (it registers in the background).
let holding = false;
let holdingAnswers = false;
let pendingSeen = false;
const held: { go: () => void; drop: () => void; gone: boolean }[] = [];
const answers: { go: () => void }[] = [];
const proxy = http.createServer((req, res) => {
  const holdAnswer = holdingAnswers && req.method === 'PATCH';
  const forward = () => {
    const up = http.request({ host: '127.0.0.1', port: app.port, method: req.method, path: req.url, headers: req.headers }, (r) => {
      const pass = () => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      };
      if (req.method === 'PATCH' && r.statusCode === 202) pendingSeen = true;
      if (holdAnswer) answers.push({ go: pass });
      else pass();
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  };
  if (!(holding && req.method === 'PATCH' && req.url?.startsWith('/api/uploads/'))) return forward();
  req.pause();
  const h = { gone: false, go: () => (h.gone ? undefined : forward()), drop: () => req.destroy() };
  res.on('close', () => {
    h.gone = true;
  });
  held.push(h);
});
await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
const viaProxy = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
// the last top-level await: the hooks come after it (test/unit/test-files.test.ts)
const app = await startApp({ headers: { Connection: 'close' } });
const { request } = app;
after(() => proxy.close());

let slug = '';
before(async () => {
  const up = await tusUpload(request, v1, { filename: 'spot.mp4', folder: 'Acme' }, { Authorization: `Bearer ${token}` });
  assert.equal(up.status, 200, up.text);
  slug = up.json().slug as string;
});
const versions = async () =>
  (await request('GET', `/api/review/${encodeURIComponent(slug)}`, { headers: { Authorization: `Bearer ${token}` } })).json().review.versions.length;

/** `lampo render --to <the video> --out out.mp4 -- node <script> …` against the server, through the proxy. */
function render(script: string, ...args: string[]): { p: ChildProcess; done: Promise<{ code: number | null; out: string }> } {
  const home = tmpdir('vr-render-stop-');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VR_SERVER: viaProxy,
    VR_TOKEN: token,
    VR_BY: 'agent:reel-cut',
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
    VR_DATA: path.join(home, 'none'),
    VR_CACHE: path.join(home, 'none-cache'),
  };
  delete env.VR_MODE;
  delete env.VR_REMOTE;
  const p = spawn(process.execPath, [VR, 'render', '--to', slug, '--out', 'out.mp4', '--', process.execPath, script, ...args], {
    cwd: work,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  p.stdout?.on('data', (d) => {
    out += d;
  });
  p.stderr?.on('data', (d) => {
    out += d;
  });
  const done = new Promise<{ code: number | null; out: string }>((r) => p.on('close', (code) => r({ code, out })));
  after(() => {
    if (p.exitCode === null) p.kill('SIGKILL');
  });
  return { p, done };
}

test('a render stopped with Ctrl-C whose tool exits 0 (a wrapper script runs on) puts nothing up', async () => {
  // the tool: says it runs, and on SIGINT writes what it has to its output and exits 0, as `sh render.sh` around ffmpeg does
  const tool = path.join(dir, 'runs-on.cjs');
  fs.writeFileSync(
    tool,
    `const fs = require('node:fs');
fs.writeFileSync(process.argv[3], String(process.pid));
process.on('SIGINT', () => { fs.copyFileSync(process.argv[2], 'out.mp4'); process.exit(0); });
setInterval(() => {}, 1000);`,
  );
  const ran = path.join(dir, 'runs-on.pid');
  const before = await versions();
  const r = render(tool, rendered, ran);
  await until(() => fs.existsSync(ran), 'the tool runs');
  r.p.kill('SIGINT');
  const { code, out } = await r.done;
  assert.equal(code, 130, out);
  assert.match(out, /^Render failed \(exit 130\): stopped\. The person sees it in Lampo\./m);
  assert.ok(fs.existsSync(path.join(work, 'out.mp4')), 'the tool did write its file');
  assert.equal(await versions(), before, 'nothing put up');
});

test('a tool that ended and left a job running: once the job has gone too, a stop sends nothing to its old group id', {
  skip: process.platform === 'win32',
}, async () => {
  const { runTool } = await import('../../lib/render/run.ts');
  const { groupAlive } = await import('../../lib/processGroup.ts');
  const job = path.join(dir, 'job.pid');
  // the tool starts a background job in its group (its output elsewhere) and ends at once
  const r = runTool({
    argv: ['/bin/sh', '-c', `sleep 1 >/dev/null 2>&1 & echo $! > ${JSON.stringify(job)}; exit 0`],
    cwd: work,
    env: process.env,
    out: null,
    onReading: () => {},
    stopGraceMs: 200,
  });
  const result = await r.done;
  assert.equal(result.code, 0);
  const pgid = r.pid as number;
  assert.ok(groupAlive(pgid), 'its job still runs in its group');
  // the job ends by itself: from then on the group's id may be another's, and is never signalled
  await until(() => !groupAlive(pgid), 'the job ended', 10_000);
  const sent: [number, string | number | undefined][] = [];
  const kill = process.kill;
  process.kill = ((pid: number, sig?: string | number) => {
    sent.push([pid, sig]);
    return kill.call(process, pid, sig as NodeJS.Signals);
  }) as typeof process.kill;
  try {
    r.signal('SIGINT');
    r.signal('SIGKILL');
  } finally {
    process.kill = kill;
  }
  const signalled = sent.filter(([pid, sig]) => pid === -pgid && sig !== 0);
  assert.deepEqual(signalled, [], `no signal to its old group id: ${JSON.stringify(sent)}`);
});

test('a stop while the render goes up ends the upload: nothing is registered, and lampo says it stopped', async () => {
  const tool = path.join(dir, 'quick.cjs');
  fs.writeFileSync(tool, `require('node:fs').copyFileSync(process.argv[2], 'out.mp4');`);
  // big enough that a link nobody reads from can't take it all: the bytes are still on their way when it stops
  const big = path.join(dir, 'renders/big.mp4');
  fs.writeFileSync(big, crypto.randomBytes(32 * 2 ** 20));
  const before = await versions();
  holding = true;
  let code: number | null;
  let out: string;
  let exited = false;
  try {
    const r = render(tool, big);
    // the tool has ended and the bytes are on their way
    await until(() => held.length > 0, 'the upload under way');
    r.p.kill('SIGINT');
    void r.done.then(() => {
      exited = true;
    });
    await until(() => exited || held.every((h) => h.gone), 'the stop reached the upload', 15_000);
    ({ code, out } = await r.done);
  } finally {
    holding = false;
    // lampo has ended: its upload goes nowhere (let go, the server's late answer to it lands in the next test); a render
    // still running gets its bytes through
    for (const h of held.splice(0)) {
      if (exited) h.drop();
      else h.go();
    }
  }
  assert.equal(code, 130, out);
  assert.match(out, /^Render failed \(exit 130\): stopped\. The person sees it in Lampo\./m);
  assert.equal(await versions(), before, 'nothing registered');
});

test('a stop once the server took the last byte says the version went up: the server registered it', async () => {
  const tool = path.join(dir, 'quick-answer.cjs');
  fs.writeFileSync(tool, `require('node:fs').copyFileSync(process.argv[2], 'out.mp4');`);
  const other = makeVideo(path.join(dir, 'renders/answer.mp4'), { w: 320, h: 180, fps: 25, dur: 1, pattern: 'testsrc2', freq: 550 });
  const before = await versions();
  holdingAnswers = true;
  let code: number | null;
  let out: string;
  try {
    const r = render(tool, other);
    // every byte went in and the server answered; the answer waits here
    await until(() => answers.length > 0, 'the server answered the last bytes');
    r.p.kill('SIGINT');
    holdingAnswers = false;
    for (const a of answers.splice(0)) a.go();
    ({ code, out } = await r.done);
  } finally {
    holdingAnswers = false;
    for (const a of answers.splice(0)) a.go();
  }
  assert.equal(code, 130, out);
  assert.match(out, new RegExp(`^Stopped, but V${before + 1} was already put up for review\\.$`, 'm'));
  assert.equal(await versions(), before + 1, 'as the server says');
});

test('a stop while the server still registers a big render says it goes up, instead of waiting it out as a success', async () => {
  const tool = path.join(dir, 'quick-pending.cjs');
  fs.writeFileSync(tool, `require('node:fs').copyFileSync(process.argv[2], 'out.mp4');`);
  const other = makeVideo(path.join(dir, 'renders/pending.mp4'), { w: 320, h: 180, fps: 25, dur: 1, pattern: 'testsrc', freq: 650 });
  const before = await versions();
  // the server answers at once that it goes on in the background, as it does for a render into remote storage
  const wait = app.ctx.uploadWaitMs;
  app.ctx.uploadWaitMs = 0;
  pendingSeen = false;
  try {
    const r = render(tool, other);
    await until(() => pendingSeen, 'the server answered "pending"');
    r.p.kill('SIGINT');
    const { code, out } = await r.done;
    assert.equal(code, 130, out);
    assert.match(out, new RegExp(`^Stopped, but the server already had the whole file: it puts it up as V${before + 1}\\.$`, 'm'));
    await until(async () => (await versions()) === before + 1, 'the server put it up');
  } finally {
    app.ctx.uploadWaitMs = wait;
  }
});
