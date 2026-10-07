// What an agent did stays its owner's on a shared machine (A12 AGENT-13): a run's log is the agent's whole transcript
// (files it read, commands' output), the activity file says what it did on which video, and `vr`'s download cache
// holds a hosted server's screenshots. They were made with the default umask (0644 in a 0755 folder): readable by
// every other account on the machine. The real `claude` is never run: the stand-in below only prints.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { isolatedEnv, sleep, tmpdir } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const stub = path.join(dir, 'bin', 'claude');
fs.mkdirSync(path.dirname(stub), { recursive: true });
fs.writeFileSync(stub, '#!/bin/sh\necho \'{"type":"system"}\'\nexit 0\n', { mode: 0o755 });
process.env.VR_CLAUDE_BIN = stub;
// The umask most machines have: what the process makes is readable by others unless it says otherwise.
process.umask(0o022);

const { createAgentRuns } = await import('../../server/agentRuns.ts');
const { fileSink } = await import('../../lib/activity.ts');
const { createRemoteBackend } = await import('../../lib/backend/remote.ts');

const mode = (p: string) => fs.statSync(p).mode & 0o777;

test('AGENT-13: a run’s log is its owner’s alone, in a folder only they can open', async () => {
  const runsDir = path.join(dir, 'cache', 'agent-runs');
  // a folder an older version made with the umask's mode
  fs.mkdirSync(runsDir, { recursive: true, mode: 0o755 });
  const runs = createAgentRuns({ broadcast: () => {}, dir: runsDir });
  const project = path.join(dir, 'proj');
  fs.mkdirSync(project, { recursive: true });
  const run = runs.start({ slug: 'none', name: 'spot-edit', sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e', cwd: project, by: 't', prompt: 'Lampo: x' });
  for (let i = 0; i < 200 && runs.get(run.id)?.state === 'running'; i++) await sleep(25);
  const log = runs.logFile(run.id) as string;
  assert.equal(mode(log), 0o600, 'the log');
  assert.equal(mode(runsDir), 0o700, 'its folder');
});

test('AGENT-13: the activity file is its owner’s alone, also one made before and its rotation', () => {
  const file = path.join(tmpdir(), 'agent-activity.jsonl');
  const sink = fileSink(file);
  sink.record({ at: '2026-10-03T10:00:00', agent: 'spot-edit', kind: 'read', text: 'Read the open notes' });
  assert.equal(mode(file), 0o600);
  const older = path.join(tmpdir(), 'agent-activity.jsonl');
  fs.writeFileSync(older, '', { mode: 0o644 });
  fs.chmodSync(older, 0o644);
  fileSink(older).record({ at: '2026-10-03T10:00:00', agent: 'spot-edit', kind: 'read', text: 'Read the open notes' });
  assert.equal(mode(older), 0o600, 'a file from before is closed on the next line');
});

test('AGENT-13: vr’s download cache for a hosted server is its owner’s alone', () => {
  const root = path.join(tmpdir(), 'xdg-cache', 'lampo');
  createRemoteBackend({ server: 'http://127.0.0.1:9', token: 'vr_x' }, { cacheRoot: root });
  assert.equal(mode(root), 0o700);
  // one made by an older version
  const old = path.join(tmpdir(), 'video-review');
  fs.mkdirSync(old, { mode: 0o755 });
  fs.chmodSync(old, 0o755);
  createRemoteBackend({ server: 'http://127.0.0.1:9', token: 'vr_x' }, { cacheRoot: old });
  assert.equal(mode(old), 0o700);
});
