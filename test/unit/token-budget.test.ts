// What talking to Lampo costs an agent stays small: the tool list a client sends on every turn, the open notes of a
// realistic review, a wait_for_feedback answer and the Agent Skill, counted the way bench/tokens counts them (its
// README.md has the numbers behind these budgets: the measured value + about 10 %). Raise a budget only on purpose,
// with the bench run that shows what the extra tokens buy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { approxTokens, imageSize, resultCost, toolListCost } from '../../bench/tokens/count.ts';
import { buildFixture, type Fixture } from '../../bench/tokens/fixture.ts';
import { FFMPEG, isolatedEnv, makeVideo, ROOT, vr } from '../lib/helpers.ts';

const BUDGET = {
  /** Every tool's name, description and input schema: on every turn of the agent's conversation (5250 until publishing's
   * draft_post and get_posts, 5550 until footage search's find_footage: bench/tokens/README.md). */
  toolList: 5850,
  /** The same for VR_MCP_TOOLS=lean (the review loop only). */
  leanToolList: 3200,
  /** get_open_notes on the 12-note review, text and pictures (the notes with a drawing, cropped). */
  openNotes: 3000,
  /** wait_for_feedback with one new note that has a drawing. */
  waitOne: 480,
  /** wait_for_feedback that ends with nothing new: its two lines and what is going on (paid on every wait while people review). */
  waitNone: 58,
  /** The line a hand-off ends with (track_video; mark_fixed and wont_fix once nothing is left open): lib/handoff.ts. */
  handOff: 45,
  /** The line an agent's next answer ends with when the person sent notes while it worked, once (lib/runs.ts). */
  newNotes: 48,
  /** skills/lampo/SKILL.md, read into context when the skill applies (1350 until the options bullet, 1450 until
   * `vr render`: bench/tokens/README.md). */
  skill: 1550,
  /** What `vr render` prints for a render put up as the next version: its line and the hand-off line (instead of the
   * render's own output, 2248 for a 6 s ffmpeg encode). */
  render: 50,
  /** One `vr render wait` while a detached render goes on. */
  renderWait: 36,
};

const { dir, env } = isolatedEnv({ vars: { VR_REMOTE: '0' } });
let fx: Fixture;
let client: Client;
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
  assert.ok(!res.isError, JSON.stringify(res.content));
  return res;
};
const textOf = (res: CallToolResult) =>
  res.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('\n');

before(async () => {
  fx = await buildFixture(dir);
  client = new Client({ name: 'token-budget', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'bin/vr-mcp')], env: env as Record<string, string>, stderr: 'ignore' }),
  );
});
after(async () => {
  await client?.close().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the tool list a client sends on every turn', async () => {
  const { tools } = await client.listTools();
  const model = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const list = toolListCost(model);
  assert.ok(list.total <= BUDGET.toolList, `tool list: ${list.total} tokens > ${BUDGET.toolList} (largest: ${JSON.stringify(list.per.slice(0, 3))})`);
  const { LEAN_TOOLS } = await import('../../mcp/lean.ts');
  const lean = toolListCost(model.filter((t) => LEAN_TOOLS.includes(t.name)));
  assert.ok(lean.total <= BUDGET.leanToolList, `lean tool list: ${lean.total} tokens > ${BUDGET.leanToolList}`);
  // What tells a model nothing stays out: the JSON Schema URI on every tool, the ±2^53 bounds on every integer.
  const json = JSON.stringify(model);
  assert.ok(!json.includes('$schema') && !json.includes('9007199254740991'), 'schemas carry no boilerplate');
});

test('get_open_notes on a 12-note review: words for all, cropped pictures for the drawn ones', async () => {
  const res = await call('get_open_notes', { video: 'spring-launch' });
  const cost = resultCost(res.content as never);
  assert.ok(
    cost.total <= BUDGET.openNotes,
    `get_open_notes: ${cost.total} tokens (text ${cost.text}, ${cost.images} pictures ${cost.imageTokens}) > ${BUDGET.openNotes}`,
  );
  for (const id of fx.notes) assert.match(textOf(res), new RegExp(`${id} OPEN`), `${id} is listed`);
  // within the budget: what the drawn notes point at (the reel's elements map), their names once, a part's stretch
  assert.match(textOf(res), / · on #logo\n/);
  assert.match(textOf(res), /\nelements: #logo "Acme logo", /);
  assert.match(textOf(res), / · part f20–f44\n/);
  for (const c of res.content)
    if (c.type === 'image') {
      const s = imageSize(c.data);
      assert.ok(s && Math.max(s.w, s.h) <= 640, `a picture of at most 640 px: ${JSON.stringify(s)}`);
    }
});

test('wait_for_feedback with one new note', async () => {
  const cursor = (/cursor: (\S+)/.exec(textOf(await call('wait_for_feedback', { video: 'spring-launch', timeout_s: 0 }))) || [])[1];
  const { openBackend } = await import('../../lib/backend/index.ts');
  await openBackend().addNote(fx.slug, {
    v: 1,
    frame: 140,
    range: null,
    text: 'The second product shot cuts too early.',
    tags: ['timing'],
    severity: 'should',
    kind: 'feedback',
    drawing: [{ type: 'box', x: 200, y: 600, w: 400, h: 300 }],
    author: 'Mia Hartmann',
  });
  const res = await call('wait_for_feedback', { video: 'spring-launch', since: cursor, timeout_s: 10 });
  assert.match(textOf(res), /^1 new:/);
  const cost = resultCost(res.content as never);
  assert.equal(cost.images, 1, 'the drawn note comes with its picture');
  assert.ok(cost.total <= BUDGET.waitOne, `wait_for_feedback: ${cost.total} tokens > ${BUDGET.waitOne}`);
});

test('a wait that ends with nothing new, and the line a hand-off ends with', async () => {
  const none = await call('wait_for_feedback', { video: 'spring-launch', timeout_s: 0 });
  assert.match(textOf(none), /^No new feedback in 0 s\.\ncursor: \S+\n./);
  const cost = resultCost(none.content as never);
  assert.ok(cost.total <= BUDGET.waitNone, `wait_for_feedback with nothing new: ${cost.total} tokens > ${BUDGET.waitNone}`);
  const { waitNowLine } = await import('../../lib/handoff.ts');
  const line = approxTokens(waitNowLine((/cursor: (\S+)/.exec(textOf(none)) || [])[1] as string));
  assert.ok(line <= BUDGET.handOff, `the hand-off line: ${line} tokens > ${BUDGET.handOff}`);
});

test('the new-notes line, appended once when the person sent notes while the agent works', async () => {
  const { newNotesLine } = await import('../../lib/runs.ts');
  // one note names its moment (the dearest form); several are counted
  const one = approxTokens(newNotesLine({ video: 'spring-launch.mp4', timecodes: ['00:00:12:03'], since: '2026-10-07T10:00:00Z' }));
  const many = approxTokens(
    newNotesLine({ video: 'spring-launch.mp4', timecodes: ['00:00:12:03', '00:00:21:04', '00:00:30:00'], since: '2026-10-07T10:00:00Z' }),
  );
  assert.ok(Math.max(one, many) <= BUDGET.newNotes, `the new-notes line: ${one} / ${many} tokens > ${BUDGET.newNotes}`);
});

test('vr render: two lines for a render put up, one for a wait while it goes on', async () => {
  const clip = makeVideo(path.join(dir, 'Acme', 'export', 'cutdown.mp4'), { w: 320, h: 180, fps: 25, dur: 1 });
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(clip, old, old);
  assert.equal(vr(['track', clip], env).code, 0);
  const ff = [FFMPEG, '-y', '-i', fx.video, '-t', '1', '-vf', 'scale=320:180', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip];
  const r = vr(['render', '--to', clip, '--out', clip, '--', ...ff], { ...env, VR_BY: 'agent:spot-edit' });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim().split('\n').length, 2, r.out);
  const tokens = approxTokens(r.out);
  assert.ok(tokens <= BUDGET.render, `vr render: ${tokens} tokens > ${BUDGET.render}`);
  const { stillLine } = await import('../../lib/render/detach.ts');
  const at = new Date().toISOString();
  const progress = { what: 'render' as const, stage: 'encoding', pct: 62, eta_s: 230, tool: 'remotion', v: 14 };
  const still = approxTokens(stillLine({ id: 'r_0a1b2c3d4e', state: 'running', started: at, updated: at, label: 'V14', progress }));
  assert.ok(still <= BUDGET.renderWait, `vr render wait: ${still} tokens > ${BUDGET.renderWait}`);
});

test('the Agent Skill', () => {
  const tokens = approxTokens(fs.readFileSync(path.join(ROOT, 'skills/lampo/SKILL.md'), 'utf8'));
  assert.ok(tokens <= BUDGET.skill, `SKILL.md: ${tokens} tokens > ${BUDGET.skill}`);
});
