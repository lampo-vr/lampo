// A render tool that ended but left a background job in its process group: once that job has ended too, the group's id
// is never signalled again (lib/render/run.ts) — a later Ctrl-C or stop, during the upload say, sends nothing, as the id
// may be another group's by then. The tool here is a stand-in sh line; whatever it starts is killed in `after`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { isolatedEnv, until } from '../lib/helpers.ts';

const { dir } = isolatedEnv({ vars: { VR_REMOTE: '0' } });
const { runTool } = await import('../../lib/render/run.ts');
const project = path.join(dir, 'project');
fs.mkdirSync(project, { recursive: true });

const started = new Set<number>();
after(() => {
  for (const p of started)
    try {
      process.kill(-p, 'SIGKILL');
    } catch {}
});
const groupAlive = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a tool that left a job behind: once the job ends, a later signal sends nothing to the emptied group', {
  skip: process.platform === 'win32',
}, async () => {
  const run = runTool({
    argv: ['/bin/sh', '-c', 'sleep 2 </dev/null >/dev/null 2>&1 & exit 0'],
    cwd: project,
    env: process.env,
    out: null,
    onReading: () => {},
    stopGraceMs: 300,
  });
  const pid = run.pid as number;
  started.add(pid);
  await run.done;
  assert.equal(groupAlive(pid), true, 'its job still runs when the render has ended');
  await until(() => !groupAlive(pid), 'the job to end (the group empty)', 30_000);
  const since = Date.now();
  await until(() => run.gone === true || Date.now() - since > 3000, 'the render to see its group gone');
  const real = process.kill;
  const sent: string[] = [];
  process.kill = ((p: number, sig?: string | number) => {
    sent.push(`${p}:${String(sig)}`);
    return real(p, sig as NodeJS.Signals);
  }) as typeof process.kill;
  try {
    run.signal('SIGINT');
    run.signal('SIGKILL');
  } finally {
    process.kill = real;
  }
  assert.deepEqual(sent, [], 'nothing sent to an id that may be another group’s');
  assert.equal(run.gone, true);
});
