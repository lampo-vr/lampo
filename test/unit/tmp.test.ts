// covers: test/lib/tmp.ts test/lib/withParent.ts test/e2e/lib/server.mjs test/e2e/lib/browser.mjs scripts/shots/camera.ts
// The tests clean up after themselves (test/lib/tmp.ts): a process's temp dirs go when it exits, however it exits, and
// the servers and browsers it started go with them; what a SIGKILL leaves, the next start sweeps, and only that. Each
// case runs in a child process whose TMPDIR is a scratch dir of this test's: no sweep here ever reads the machine's own
// temp dir, where other test runs are going on.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { must, ROOT, tmpdir, until } from '../lib/helpers.ts';
import { APP_PREFIXES } from '../lib/tmp.ts';

const url = (file: string) => JSON.stringify(pathToFileURL(path.join(ROOT, file)).href);
const DAY = 24 * 3600_000;

/** `code` in a child process (an ES module, tmp.ts loaded as `t`) whose temp dir is `scratch`. */
function child(scratch: string, code: string, env: Record<string, string> = {}): ChildProcess & { lines: string[] } {
  const src = `import fs from 'node:fs';\nconst t = await import(${url('test/lib/tmp.ts')});\n${code}`;
  const p = spawn(process.execPath, ['--input-type=module', '-e', src], {
    env: { ...process.env, TMPDIR: scratch, LAMPO_KEEP_TMP: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcess & { lines: string[] };
  p.lines = [];
  let err = '';
  p.stdout?.on('data', (d) => p.lines.push(...String(d).split('\n').filter(Boolean)));
  p.stderr?.on('data', (d) => (err += d));
  p.once('exit', () => err && p.lines.push(`stderr: ${err.trim()}`));
  return p;
}
const ended = (p: ChildProcess) =>
  new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => {
    if (p.exitCode !== null || p.signalCode !== null) r({ code: p.exitCode, signal: p.signalCode });
    else p.once('exit', (code, signal) => r({ code, signal }));
  });
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH';
  }
};
/** A scratch temp dir as tmp.ts sees it (its real path). */
const scratch = () => fs.realpathSync(tmpdir('vr-scratch-'));
const runsIn = (dir: string) => (fs.existsSync(path.join(dir, 'vr-runs')) ? fs.readdirSync(path.join(dir, 'vr-runs')).filter((n) => !n.startsWith('.')) : []);
const deadPid = () => spawnSync('true').pid as number;

test('a process’s temp dirs are gone when it exits, however it exits; LAMPO_KEEP_TMP keeps them', async () => {
  const made = `const d = t.tmpdir(); fs.writeFileSync(d + '/f', 'x'); console.log(d);`;
  const cases: [string, string, (p: ChildProcess) => void][] = [
    ['passes', `${made}`, () => {}],
    ['throws', `${made}\nthrow new Error('boom');`, () => {}],
    ['process.exit', `${made}\nprocess.exit(3);`, () => {}],
    // an exit hook of the code under test writes into its store as the process ends (lib/shares.ts flushes a link's
    // stats then): the root goes after it, or that file stays behind in a root nothing removes until the next start
    [
      'writes from a later exit hook',
      `${made}\nprocess.on('exit', () => { fs.mkdirSync(d + '/data', { recursive: true }); fs.writeFileSync(d + '/data/shares.json', '{}'); });`,
      () => {},
    ],
    ['SIGINT', `${made}\nsetInterval(() => {}, 1000);`, (p) => p.kill('SIGINT')],
    ['SIGTERM', `${made}\nsetInterval(() => {}, 1000);`, (p) => p.kill('SIGTERM')],
    ['SIGHUP', `${made}\nsetInterval(() => {}, 1000);`, (p) => p.kill('SIGHUP')],
  ];
  for (const [how, code, stop] of cases) {
    const tmp = scratch();
    const p = child(tmp, code);
    const dir = await until(
      () => p.lines[0],
      () => `${how}: ${p.lines.join(' | ')}`,
    );
    assert.ok(dir.startsWith(path.join(tmp, 'vr-runs', `${p.pid}-`)), `${how}: in the run root (${dir})`);
    stop(p);
    const end = await ended(p);
    if (how.startsWith('SIG')) assert.equal(end.signal, how, `${how}: it still ends by the signal`);
    assert.equal(fs.existsSync(dir), false, `${how}: the dir is gone`);
    assert.deepEqual(runsIn(tmp), [], `${how}: the run root is gone`);
  }

  const tmp = scratch();
  const p = child(tmp, made, { LAMPO_KEEP_TMP: '1' });
  await ended(p);
  const dir = must(p.lines[0], 'the dir');
  assert.ok(fs.existsSync(path.join(dir, 'f')), 'kept with LAMPO_KEEP_TMP');
  assert.ok(fs.existsSync(path.join(path.dirname(dir), '.kept')), 'and marked kept');
  // the next start leaves a kept root alone (for a day: below)
  await ended(child(tmp, ''));
  assert.ok(fs.existsSync(dir));
});

test('what a process started goes with it, its whole process group: on exit and on a signal', async () => {
  for (const how of ['exit', 'SIGINT', 'SIGTERM']) {
    const tmp = scratch();
    // a group with a member the leader started: a server's ffmpeg, a Chrome's renderers
    const code = `import { spawn } from 'node:child_process';
const p = spawn('sh', ['-c', 'sleep 600 & wait'], { detached: true, stdio: 'ignore' });
t.ownChild(p);
console.log(p.pid);
${how === 'exit' ? 'setTimeout(() => process.exit(0), 300);' : 'setInterval(() => {}, 1000);'}`;
    const p = child(tmp, code);
    const pgid = Number(
      await until(
        () => p.lines[0],
        () => p.lines.join(' | '),
      ),
    );
    assert.ok(pgid > 0);
    if (how !== 'exit') p.kill(how as NodeJS.Signals);
    await ended(p);
    await until(() => gone(-pgid), `${how}: the group is gone`, 5000);
  }
});

test('a server whose test process was SIGKILLed stops by itself (withParent.ts)', async () => {
  const tmp = scratch();
  // a stand-in for the server: Ctrl-C ends it, as it ends server/index.ts
  const server = `process.on('SIGINT', () => process.exit(0)); setInterval(() => {}, 1000);`;
  const code = `import { spawn } from 'node:child_process';
const s = spawn(process.execPath, [...t.WITH_PARENT, '-e', ${JSON.stringify(server)}], { stdio: 'ignore' });
console.log(s.pid);
setInterval(() => {}, 1000);`;
  const p = child(tmp, code);
  const pid = Number(
    await until(
      () => p.lines[0],
      () => p.lines.join(' | '),
    ),
  );
  p.kill('SIGKILL');
  await ended(p);
  await until(() => gone(pid), 'the orphaned server stopped', 15_000);
});

test('the e2e harness: a SIGKILLed suite’s server stops by itself, and the next start removes the suite’s run root', async () => {
  const tmp = scratch();
  const code = `const { startServer } = await import(${url('test/e2e/lib/server.mjs')});
const srv = await startServer({ prefix: 'vr-orphan-' });
console.log(srv.proc.pid);
console.log(srv.dir);
setInterval(() => {}, 1000);`;
  const p = child(tmp, code);
  const pid = Number(
    await until(
      () => p.lines[0],
      () => p.lines.join(' | '),
      60_000,
    ),
  );
  const dir = must(p.lines[1], 'the store');
  assert.ok(fs.existsSync(dir));
  p.kill('SIGKILL');
  await ended(p);
  await until(() => gone(pid), 'the server stopped after its suite was SIGKILLed', 20_000);
  assert.ok(fs.existsSync(dir), 'a SIGKILL runs no exit hook');
  await ended(child(tmp, ''));
  assert.equal(fs.existsSync(dir), false, 'the next start removed it');
  assert.deepEqual(runsIn(tmp), []);
});

test('the next start sweeps what earlier test processes left, and nothing else', async () => {
  const tmp = scratch();
  const runs = path.join(tmp, 'vr-runs');
  const old = Date.now() - 2 * DAY;
  const at = (rel: string, { age = 0, file = false } = {}) => {
    const p = path.join(tmp, rel);
    if (file) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '');
    } else fs.mkdirSync(path.join(p, 'inside'), { recursive: true });
    if (age) fs.utimesSync(p, new Date(Date.now() - age), new Date(Date.now() - age));
    return p;
  };
  // a root kept with LAMPO_KEEP_TMP a day ago, and one kept just now
  const keptLongAgo = `vr-runs/${deadPid()}-Kept02`;
  const keptNow = `vr-runs/${deadPid()}-Kept01`;
  const swept = [
    at(`vr-runs/${deadPid()}-AbC123`),
    at(keptLongAgo),
    at('vr-test-Ab12Cd', { age: 2 * DAY }),
    at('vr-e2e-files-Xy9Zw1', { age: 2 * DAY }),
    at('vr-mcp-q1W2e3', { age: 2 * DAY }),
    at('puppeteer_dev_chrome_profile-Ab12Cd', { age: 2 * DAY }),
  ];
  at(`${keptLongAgo}/.kept`, { age: 2 * DAY, file: true });
  at(`${keptNow}/.kept`, { file: true });
  const left = [
    // this process's own, alive
    at(`vr-runs/${process.pid}-L1ve00`),
    path.join(tmp, keptNow),
    at('vr-test-Fr3shX'),
    at('vr-test-media', { age: 2 * DAY }),
    at('vr-qa-Ab12Cd', { age: 2 * DAY }),
    at('vr-footage-models', { age: 2 * DAY }),
    at('other-tool-Ab12Cd', { age: 2 * DAY }),
    at('puppeteer_dev_chrome_profile-Fr3sh1'),
    at('puppeteer_dev_chrome_profile-InUse1', { age: 2 * DAY }),
  ];
  // a running browser names its profile on its command line
  const browser = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'puppeteer_dev_chrome_profile-InUse1'], { stdio: 'ignore' });
  try {
    await ended(child(tmp, ''));
  } finally {
    browser.kill('SIGKILL');
  }
  for (const p of swept) assert.equal(fs.existsSync(p), false, `swept: ${path.relative(tmp, p)}`);
  for (const p of left) assert.ok(fs.existsSync(p), `left alone: ${path.relative(tmp, p)}`);

  // <tmp> itself at most hourly: a pass just went through it
  const later = at('vr-test-L4ter0', { age: 2 * DAY });
  await ended(child(tmp, ''));
  assert.ok(fs.existsSync(later), 'not again within the hour');
  fs.utimesSync(path.join(runs, '.swept'), new Date(old), new Date(old));
  await ended(child(tmp, ''));
  assert.equal(fs.existsSync(later), false, 'an hour on');
});

test('a sweep is bounded, and the next one goes on where it stopped', async () => {
  const tmp = scratch();
  const leftovers = scratch();
  const old = new Date(Date.now() - 2 * DAY);
  for (let i = 0; i < 5; i++) {
    const p = path.join(leftovers, `vr-test-B0und${i}`);
    fs.mkdirSync(p);
    fs.utimesSync(p, old, old);
  }
  const code = `for (let i = 0; i < 4; i++) console.log(t.sweep({ tmp: ${JSON.stringify(leftovers)}, max: 2 }).length);`;
  const p = child(tmp, code);
  await ended(p);
  assert.deepEqual(p.lines, ['2', '2', '1', '0']);
});

const files = (dir: string): string[] =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'fixtures' || e.name === 'node_modules' ? [] : files(rel);
    return /\.(ts|mjs)$/.test(e.name) ? [rel] : [];
  });

test('no test makes its temp dirs beside the run root, and the sweep knows the app’s own work dirs', () => {
  const beside = /mkdtemp(Sync)?\(\s*path\.join\(\s*(fs\.realpathSync\(\s*)?os\.tmpdir\(\)/;
  const found = files('test').filter((f) => f !== 'test/lib/tmp.ts' && beside.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  assert.deepEqual(found, [], 'tmpdir() (test/lib/helpers.ts) instead');

  const app = new Set<string>();
  for (const dir of ['lib', 'server', 'mcp'])
    for (const f of files(dir))
      for (const m of fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/mkdtempSync\(path\.join\(os\.tmpdir\(\), '(vr-[a-z-]+-)'\)/g)) app.add(m[1]);
  assert.deepEqual([...app].sort(), [...APP_PREFIXES].sort(), 'APP_PREFIXES in test/lib/tmp.ts');
});

test('browsers end with the process that launched them: a profile in its run root, over a pipe, its group owned', () => {
  // over a socket, a Chrome whose suite was SIGKILLed ran on for good, and its profile with it
  for (const f of ['test/e2e/lib/browser.mjs', 'scripts/shots/camera.ts']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const needed of ["tmpdir('chrome-')", 'userDataDir:', 'pipe: true', 'handleSIGINT: false', 'handleSIGTERM: false', 'handleSIGHUP: false', 'ownChild('])
      assert.ok(src.includes(needed), `${f}: ${needed}`);
  }
});

test('a server a test starts is stopped before its run root goes: WITH_PARENT, spawned detached, its group owned', () => {
  // Watched only by WITH_PARENT, a server stops a second after its test is gone: a Ctrl-C'd test removed its root while
  // the server was still writing its store there, and the store stayed until the next start (recordings-restart.test.ts).
  const starts = files('test').filter(
    (f) => !['test/unit/tmp.test.ts', 'test/lib/tmp.ts'].includes(f) && /\.\.\.WITH_PARENT\b/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')),
  );
  assert.ok(starts.includes('test/e2e/lib/server.mjs'), starts.join(', '));
  for (const f of starts) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const needed of ['detached: true', 'ownChild(']) assert.ok(src.includes(needed), `${f}: ${needed}`);
  }
});
