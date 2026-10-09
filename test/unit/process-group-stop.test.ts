// covers: lib/processGroup.ts server/agentRuns.ts lib/render/run.ts server/index.ts
// A stop ends the whole process group, whatever its leader does. The "agent" and the "render" here are stand-in sh
// scripts (never the real claude): each starts an ordinary background job (`… &`, which a non-interactive shell starts
// with SIGINT ignored) that beats into a file, and its leader either ends on SIGINT or ignores it. Stop of a run Lampo
// started (server/agentRuns.ts) and a stop of `lampo render`'s tool (lib/render/run.ts) go on to SIGTERM and SIGKILL
// as long as anything of the group is left — also after the leader has gone — and the app stopping (stopAll, or an
// exit that can't wait: endNow) ends every group before it goes. Every process started here is killed in `after`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { isolatedEnv, until } from '../lib/helpers.ts';

const { dir } = isolatedEnv({ vars: { VR_REMOTE: '0' } });
const { createAgentRuns } = await import('../../server/agentRuns.ts');
const { runTool } = await import('../../lib/render/run.ts');
const project = path.join(dir, 'project');
fs.mkdirSync(project, { recursive: true });

const started = new Set<number>();
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
after(() => {
  for (const p of started) {
    for (const target of [-p, p])
      try {
        process.kill(target, 'SIGKILL');
      } catch {}
  }
});

/**
 * A stand-in: a background job beating into `hb` (its pid in `<hb>.pid`, the leader's in `<hb>.leader`). The leader ends
 * on SIGINT (`exit`) or ignores it (`ignore`); the job ignores SIGINT as every background job does, and SIGTERM too
 * with `stubborn`.
 */
function standIn(name: string, leader: 'exit' | 'ignore', { stubborn = false } = {}): { bin: string; hb: string } {
  const hb = path.join(dir, `${name}.hb`);
  const bin = path.join(dir, `${name}.sh`);
  fs.writeFileSync(
    bin,
    `#!/bin/sh
echo $$ > "${hb}.leader"
( ${stubborn ? "trap '' TERM; " : ''}while :; do echo x >> "${hb}"; sleep 0.05; done ) &
echo $! > "${hb}.pid"
${leader === 'exit' ? "trap 'exit 0' INT" : "trap '' INT"}
while :; do sleep 0.05; done
`,
    { mode: 0o755 },
  );
  return { bin, hb };
}
const num = (f: string) => Number(fs.readFileSync(f, 'utf8').trim());
/** The stand-in's leader and job, once both run (and are noted for `after`). */
async function running(hb: string): Promise<{ leader: number; child: number }> {
  await until(() => fs.existsSync(`${hb}.pid`) && fs.existsSync(`${hb}.leader`) && fs.existsSync(hb), 'the stand-in and its job to run', 60_000);
  const leader = num(`${hb}.leader`);
  const child = num(`${hb}.pid`);
  started.add(leader);
  started.add(child);
  return { leader, child };
}

let n = 0;
function startRun(bin: string, graceMs: number) {
  const runs = createAgentRuns({ broadcast: () => {}, bin: () => bin, dir: path.join(dir, `runs-${++n}`), graceMs });
  const sessionId = `0f8fad5b-d9cb-469f-a165-7086772895${String(10 + n).padStart(2, '0')}`;
  const r = runs.start({ slug: 'synthetic', name: `stand-in-${n}`, sessionId, cwd: project, by: 'tester', prompt: 'Lampo: synthetic' });
  return { runs, r };
}

test('Stop of a run whose leader ends on SIGINT ends what it left running too', async () => {
  const { bin, hb } = standIn('run-exit', 'exit');
  const { runs, r } = startRun(bin, 300);
  const { leader, child } = await running(hb);
  runs.stop(r.id, 'tester');
  await until(() => runs.get(r.id)?.state === 'stopped', 'the run to be stopped', 30_000);
  await until(
    () => !alive(leader) && !alive(child),
    () => `the job ${alive(child) ? 'still runs' : 'is gone'} after the leader ended`,
    30_000,
  );
});

test('Stop goes on to SIGKILL for what ignores SIGINT and SIGTERM, after the leader has gone', async () => {
  const { bin, hb } = standIn('run-stubborn', 'exit', { stubborn: true });
  const { runs, r } = startRun(bin, 300);
  const { child } = await running(hb);
  runs.stop(r.id, 'tester');
  await until(() => runs.get(r.id)?.state === 'stopped', 'the run to be stopped', 30_000);
  await until(() => !alive(child), 'SIGKILL to reach the job', 30_000);
});

/** A process that starts a run with `bin`, waits until it runs, then does `then` (stopping the app) and exits. */
async function appThatStops(bin: string, hb: string, then: string): Promise<number | null> {
  const driver = path.join(dir, `driver-${++n}.mjs`);
  const agentRuns = new URL('../../server/agentRuns.ts', import.meta.url).href;
  fs.writeFileSync(
    driver,
    `import fs from 'node:fs';
import { createAgentRuns } from ${JSON.stringify(agentRuns)};
const runs = createAgentRuns({ broadcast: () => {}, bin: () => ${JSON.stringify(bin)}, dir: ${JSON.stringify(path.join(dir, `runs-driver-${n}`))} });
runs.start({ slug: 'synthetic', name: 'stand-in', sessionId: '0f8fad5b-d9cb-469f-a165-7086772895${String(50 + n).padStart(2, '0')}', cwd: ${JSON.stringify(project)}, by: 'tester', prompt: 'Lampo: synthetic' });
const t = setInterval(async () => {
  if (!fs.existsSync(${JSON.stringify(`${hb}.pid`)}) || !fs.existsSync(${JSON.stringify(hb)})) return;
  clearInterval(t);
  ${then}
  process.exit(0);
}, 20);
`,
  );
  const p = spawn(process.execPath, [driver], { env: process.env, stdio: 'inherit' });
  return new Promise<number | null>((r) => p.on('close', (c) => r(c)));
}

test('the app stopping ends every run’s group before it exits, also a leader that ignores SIGINT', async () => {
  const { bin, hb } = standIn('app-stop', 'ignore');
  const code = await appThatStops(bin, hb, 'await runs.stopAll();');
  const { leader, child } = await running(hb);
  assert.equal(code, 0);
  await until(() => !alive(leader) && !alive(child), 'leader and job gone with the app', 5000);
});

test('an exit that can’t wait (no stop first) still ends every run’s group', async () => {
  const { bin, hb } = standIn('app-exit', 'ignore');
  const code = await appThatStops(bin, hb, 'runs.endNow();');
  const { leader, child } = await running(hb);
  assert.equal(code, 0);
  await until(() => !alive(leader) && !alive(child), 'leader and job gone with the app', 5000);
});

test('a render stopped: its tool and whatever it started have ended once the render says so', async () => {
  for (const [name, stubborn] of [
    ['render-exit', false],
    ['render-stubborn', true],
  ] as const) {
    const { bin, hb } = standIn(name, 'exit', { stubborn });
    const run = runTool({ argv: ['/bin/sh', bin], cwd: project, env: process.env, out: null, onReading: () => {}, stopGraceMs: 300 });
    const { leader, child } = await running(hb);
    run.signal('SIGINT');
    const result = await run.done;
    assert.equal(result.code, 0, 'the tool itself ended on SIGINT');
    assert.equal(alive(leader), false);
    assert.equal(alive(child), false, `${name}: its job ended before the render did`);
  }
});
