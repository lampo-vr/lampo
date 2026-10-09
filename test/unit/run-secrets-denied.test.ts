// A run this machine starts is refused a command that holds a secret (a headless run has nobody to ask): what the team
// reads of that refusal — the permission it needs, the rule that would allow it, its steps, the runs list, the runs
// journal on disk, the push that asks for the OK — names the program and never the secret, and the rule still allows
// what it ran. Whatever reaches a run as a refusal is cleaned like every other step. The secrets are synthetic and put
// together at run time, so no line of this file looks like one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, until } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const glue = (...parts: string[]) => parts.join('');
const MARK = 'Q9Z';
const TOKEN = glue('gh', 'p_', MARK, 'abcdefghijklmnopqrstuvwxyz0123456');
const command = `echo ${TOKEN} | gh auth login --with-token`;
const lines = [
  { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't_denied', name: 'Bash', input: { command } }] } },
  {
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 't_denied', is_error: true, content: 'Claude requested permissions to use Bash, but you haven’t granted it yet.' },
      ],
    },
  },
];
// the stand-in `claude`: prints its stream-json, then stays until the test lets it go
const bin = path.join(dir, 'bin');
const hold = path.join(bin, 'hold');
fs.mkdirSync(bin, { recursive: true });
fs.writeFileSync(path.join(bin, 'out.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nd="$(dirname "$0")"\ncat "$d/out.jsonl"\nwhile [ -f "$d/hold" ]; do sleep 0.05; done\nexit 0\n`, {
  mode: 0o755,
});
process.env.VR_CLAUDE_BIN = path.join(bin, 'claude');

const store = await import('../../lib/store.ts');
const auth = await import('../../lib/auth.ts');
const { slugify, reviewDir } = await import('../../lib/paths.ts');
const { commandPrefix, permissionFor } = await import('../../lib/runStream.ts');
const { runMessage } = await import('../../lib/push/index.ts');
type Notice = Parameters<typeof runMessage>[0][number];

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const project = path.join(dir, 'proj');
const video = makeVideo(path.join(project, 'export/spot.mp4'), { dur: 1 });
age(video);
store.createOrGetReview(video, { by: 'tester' });
const slug = slugify(path.resolve(video));
store.assignSession(slug, { name: 'spot-edit', sessionId: ID, cwd: project, agent: 'claude-code' }, 'tester');
const { ctx, base } = await startApp({ loadSessions: async () => [] });
// the pushes runs ask for (lib/push: a permission it waits for), caught before they would go out
const notices: Notice[] = [];
ctx.push.run = (n) => void notices.push(n);
after(() => {
  fs.rmSync(hold, { force: true });
  ctx.agentRuns.stopAll();
});

const get = async (p: string, token: string) => {
  const r = await fetch(base + p, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.text() };
};
const leaks = (text: string) => text.includes(MARK);

test('the prefix a permission names stops before a word that holds a secret; the rule still allows the program', () => {
  assert.equal(commandPrefix(command), 'echo');
  assert.equal(commandPrefix('npx remotion render src/index.ts Main out.mp4'), 'npx remotion render', 'a plain command as before');
  assert.equal(commandPrefix(`curl Bearer ${glue('abcdef', 'ghijkl')} https://x.test`), 'curl Bearer', 'a secret over two words: up to it');
  assert.equal(commandPrefix(`${TOKEN} --version`), '', 'the program itself');
  assert.deepEqual(permissionFor('Bash', { command }), {
    words: { text: 'Needs permission to run echo', key: 'Needs permission to run {command}', vars: { command: 'echo' } },
    allow: 'Bash(echo:*)',
  });
  assert.equal(permissionFor('Bash', { command: `${TOKEN} --version` }).allow, 'Bash', 'nothing of it left: the tool');
});

test('a command refused for a permission: the team reads what it needs without the secret, everywhere', async () => {
  fs.writeFileSync(hold, '');
  const start = await fetch(`${base}/api/review/${encodeURIComponent(slug)}/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Sign in to GitHub', start: true }),
  });
  assert.equal(start.status, 200, await start.clone().text());
  const id = ((await start.json()) as { run: { id: string } }).run.id;
  await until(() => ctx.runs.find(id)?.run.needs?.kind === 'permission', 'the refusal');

  auth.localOwner();
  const member = await auth.createUser({ email: 'member@example.test', name: 'Second Member', password: 'a long password', role: 'member' });
  const token = auth.createToken(member.id, 'scripts').token;
  const detail = await get(`/api/runs/${id}`, token);
  const list = await get(`/api/runs?slug=${encodeURIComponent(slug)}`, token);
  assert.equal(detail.status, 200);
  const run = JSON.parse(detail.body) as { run: { needs?: { text: { text: string }; allow?: string } }; steps: { text: string }[] };
  assert.equal(run.run.needs?.text.text, 'Needs permission to run echo');
  assert.equal(run.run.needs?.allow, 'Bash(echo:*)');
  assert.ok(
    run.steps.some((s) => s.text === 'Needs permission to run echo'),
    run.steps.map((s) => s.text).join(' | '),
  );
  assert.ok(!leaks(detail.body), `run detail: ${detail.body}`);
  assert.ok(!leaks(list.body), `runs list: ${list.body}`);
  ctx.runs.flushAll();
  assert.ok(!leaks(fs.readFileSync(path.join(reviewDir(slug), 'runs.jsonl'), 'utf8')), 'the runs journal');

  // the push asking for the OK: what it says and the rule it names
  const asked = notices.filter((n) => n.kind === 'permission');
  assert.equal(asked.length, 1);
  assert.ok(!leaks(JSON.stringify(asked)), JSON.stringify(asked));
  const push = runMessage(asked);
  assert.equal(push.title, 'spot-edit is waiting for your OK to run echo on spot.mp4');
  assert.equal(push.body, 'Allow Bash(echo:*) in its settings, then send it again.');

  // whatever reaches a run as a refusal is cleaned like any other step (here, words made elsewhere with the secret in)
  const info = ctx.agentRuns.get(id);
  assert.ok(info);
  ctx.runs.machineBlocked(info, id, {
    words: { text: `Needs permission to run ${command}`, key: 'Needs permission to run {command}', vars: { command } },
    allow: `Bash(echo ${TOKEN}:*)`,
  });
  const again = await get(`/api/runs/${id}`, token);
  assert.ok(!leaks(again.body), `run detail: ${again.body}`);
  assert.match(again.body, /Needs permission to run echo \[redacted\] \| gh auth login/);
  ctx.runs.flushAll();
  assert.ok(!leaks(fs.readFileSync(path.join(reviewDir(slug), 'runs.jsonl'), 'utf8')), 'the runs journal');
  fs.rmSync(hold, { force: true });
  await until(() => ctx.agentRuns.get(id)?.state !== 'running', 'the stand-in to end');
});
