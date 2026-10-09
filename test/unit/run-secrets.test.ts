// What a run Lampo started shows the team never holds what looks like a secret: a command's credentials (curl -u, a
// Bearer header, a key in an assignment), what the agent said and its hand-back come out redacted — in the run's steps
// and its summary (run detail and the runs list), the agents' activity and the runs journal on disk — while the raw log
// stays the machine's (403 for a token). Every kind of activity is scrubbed the same way, its words and its fill-ins.
// The secrets are synthetic and put together at run time, so no line of this file looks like one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, until } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const glue = (...parts: string[]) => parts.join('');
const S = {
  basic: glue('Synth', 'Passw0rd9'),
  bearer: glue('Synth', 'Bearer', '0123456789abcdef'),
  envKey: glue('Synth', 'EnvKey', 'Value77'),
  say: glue('Synth', 'Say', 'Token42'),
  summary: glue('Synth', 'Summary', 'Secret55'),
};
const lines = [
  {
    type: 'assistant',
    message: {
      id: 'm1',
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: `curl -u SynthUser:${S.basic} https://api.example.test/upload` } }],
    },
  },
  {
    type: 'assistant',
    message: {
      id: 'm2',
      content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: `curl -H "Authorization: Bearer ${S.bearer}" https://x.test` } }],
    },
  },
  {
    type: 'assistant',
    message: { id: 'm3', content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: `UPLOAD_KEY=${S.envKey} npm run render` } }] },
  },
  { type: 'assistant', message: { id: 'm4', content: [{ type: 'text', text: `I signed in with password=${S.say} and uploaded it.` }] } },
  { type: 'result', subtype: 'success', is_error: false, result: `Done: uploaded with token=${S.summary} to the bucket.` },
];
// the stand-in `claude`: prints the run's stream-json and exits 0
const stub = path.join(dir, 'bin', 'claude');
fs.mkdirSync(path.dirname(stub), { recursive: true });
fs.writeFileSync(stub, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(`${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)});\n`, {
  mode: 0o755,
});
process.env.VR_CLAUDE_BIN = stub;

const store = await import('../../lib/store.ts');
const auth = await import('../../lib/auth.ts');
const { slugify, reviewDir } = await import('../../lib/paths.ts');
const { cleanActivity } = await import('../../server/activity.ts');
const { createRunReader } = await import('../../lib/runStream.ts');

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const project = path.join(dir, 'proj');
const video = makeVideo(path.join(project, 'export/spot.mp4'), { dur: 1 });
age(video);
store.createOrGetReview(video, { by: 'tester' });
const slug = slugify(path.resolve(video));
store.assignSession(slug, { name: 'spot-edit', sessionId: ID, cwd: project, agent: 'claude-code' }, 'tester');
const { ctx, base } = await startApp({ loadSessions: async () => [] });
after(() => ctx.agentRuns.stopAll());

const get = async (p: string, token?: string) => {
  const r = await fetch(base + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: r.status, body: await r.text() };
};
/** The secrets a text still holds, by name. */
const leaked = (text: string) => Object.entries(S).flatMap(([k, v]) => (text.includes(v) ? [k] : []));

test('a run’s steps, words and hand-back reach the team with its secrets taken out; what it did still reads', async () => {
  const start = await fetch(`${base}/api/review/${encodeURIComponent(slug)}/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Upload it', start: true }),
  });
  assert.equal(start.status, 200, await start.clone().text());
  const id = ((await start.json()) as { run: { id: string } }).run.id;
  await until(() => ctx.runs.find(id)?.run.ended != null && ctx.agentRuns.get(id)?.state !== 'running', 'the stand-in to finish');
  await until(() => !!ctx.runs.detail(id)?.detail.run.result?.summary, 'its summary');

  auth.localOwner();
  const member = await auth.createUser({ email: 'member@example.test', name: 'Second Member', password: 'a long password', role: 'member' });
  const token = auth.createToken(member.id, 'scripts').token;

  const detail = await get(`/api/runs/${id}`, token);
  const list = await get(`/api/runs?slug=${encodeURIComponent(slug)}`, token);
  const activity = await get(`/api/agent-activity?slug=${encodeURIComponent(slug)}`, token);
  assert.equal(detail.status, 200);
  assert.equal(list.status, 200);
  assert.equal(activity.status, 200);
  assert.deepEqual(leaked(detail.body), [], 'run detail');
  assert.deepEqual(leaked(list.body), [], 'runs list');
  assert.deepEqual(leaked(activity.body), [], 'agent activity');
  ctx.runs.flushAll();
  assert.deepEqual(leaked(fs.readFileSync(path.join(reviewDir(slug), 'runs.jsonl'), 'utf8')), [], 'the runs journal');
  // the raw log stays the machine's
  assert.equal((await get(`/api/runs/${id}/log`, token)).status, 403);

  // what it did still reads: the command, what it said, its hand-back
  const run = JSON.parse(detail.body) as { steps: { text: string }[]; run: { result?: { summary?: string } } };
  const said = run.steps.map((s) => s.text).join('\n');
  assert.match(said, /Running curl -u SynthUser:\[redacted\] https:\/\/api\.example/);
  assert.match(said, /Authorization: \[redacted\]/);
  assert.match(said, /Running UPLOAD_KEY=\[redacted\] npm run render/);
  assert.match(said, /I signed in with password=\[redacted\] and uploaded it\./);
  assert.match(run.run.result?.summary ?? '', /^Done: uploaded with token=\[redacted\] to the bucket\.$/);
});

test('every kind of activity is scrubbed, its words, quote and fill-ins, not only a failure', () => {
  const kinds = ['read', 'note', 'fix', 'reply', 'ask', 'upload', 'render', 'wait', 'playbook', 'status', 'tool', 'say', 'run', 'error'] as const;
  for (const kind of kinds) {
    const a = cleanActivity({
      at: new Date().toISOString(),
      agent: 'spot-edit',
      slug,
      kind,
      text: `Running curl -u SynthUser:${S.basic} and password=${S.say}`,
      key: 'Running {command}',
      vars: { command: `UPLOAD_KEY=${S.envKey} npm run render` },
      quote: `token=${S.summary}`,
    });
    assert.ok(a, kind);
    assert.deepEqual(leaked(JSON.stringify(a)), [], `${kind}: ${JSON.stringify(a)}`);
    assert.match(a.text, /^Running curl -u SynthUser:\[redacted\]/, `${kind}: what it did still reads`);
    assert.equal(a.vars?.command, 'UPLOAD_KEY=[redacted] npm run render', kind);
  }
});

test('a command megabytes long (a heredoc) is read only as far as is ever shown, its secret still taken out', () => {
  const reader = createRunReader(project);
  const command = `curl -u SynthUser:${S.basic} https://api.example.test/upload --data @- <<'END'\n${'frame data '.repeat(200_000)}\nEND`;
  const steps = reader.feed(
    `${JSON.stringify({ type: 'assistant', message: { id: 'm9', content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: { command } }] } })}\n`,
  );
  assert.equal(steps.length, 1);
  assert.deepEqual(leaked(JSON.stringify(steps)), []);
  assert.match(steps[0]?.text ?? '', /^Running curl -u SynthUser:\[redacted\] https:\/\/api\.example\.test\/uploa…$/);
});

test('a secret the window cuts through leaves no part of itself, however much before it redaction collapses', () => {
  // 4 KB of something redaction takes as one secret, then a token across the window's end: shown, the 4 KB collapse
  // to "[redacted]" and the step would reach the token's first characters, too few for its pattern to know it
  const blob = (n: number) => Array.from({ length: n }, (_, i) => 'aB3xY7kP9mQ2'[i % 12]).join('');
  const commands = [
    `echo "${blob(4072)}" ${glue('gh', 'p_', 'Q1Z', 'abcdefghijklmnopqrstuvwxyz0123456')}`,
    `echo "${blob(4058)}" | tool ${glue('Q2Z', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ01234567')}`,
  ];
  const reader = createRunReader(project);
  for (const [i, command] of commands.entries()) {
    const use = { type: 'tool_use', id: `tw${i}`, name: 'Bash', input: { command } };
    const steps = reader.feed(`${JSON.stringify({ type: 'assistant', message: { id: `w${i}`, content: [use] } })}\n`);
    assert.equal(steps.length, 1);
    assert.ok(!/Q\dZ/.test(JSON.stringify(steps)), JSON.stringify(steps));
    assert.match(steps[0]?.text ?? '', /^Running echo "\[redacted\]"/);
  }
});
