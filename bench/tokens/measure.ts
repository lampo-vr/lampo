#!/usr/bin/env node
// What talking to Lampo costs an agent, in tokens: the MCP tool list (on every turn), every tool's typical answer
// (text and images), the `vr` CLI's outputs, and one full loop. On a throwaway store built by fixture.ts, through the
// real stdio server (bin/vr-mcp) and the real CLI (bin/vr). Counting: count.ts (a heuristic, ±15 %).
//   node bench/tokens/measure.ts [--json out.json]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { isolatedEnv, makeVideo, ROOT, VR } from '../../test/lib/helpers.ts';
import { approxTokens, type ResultCost, resultCost, toolListCost } from './count.ts';
import { buildFixture } from './fixture.ts';

const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;

// A stand-in speech engine (OpenAI-compatible, word timings), so get_transcript answers as it would with one.
const SAID = 'Every morning we start the day with coffee, then the plan. Spring starts here, at Acme.'.split(' ');
const stt = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({ text: SAID.join(' '), language: 'english', words: SAID.map((word, i) => ({ word, start: 0.2 + i * 0.32, end: 0.5 + i * 0.32 })) }),
    );
  });
});
await new Promise<void>((r) => stt.listen(0, '127.0.0.1', r));

const { dir, env } = isolatedEnv({
  vars: { VR_REMOTE: '0', VR_STT: 'http', VR_STT_URL: `http://127.0.0.1:${(stt.address() as AddressInfo).port}/v1` },
});
const fx = await buildFixture(dir);
// The reviewer is done before the agent reads (`since` stamps are whole seconds, inclusive: a note of the same second
// would come again in the next round's answer).
await new Promise((r) => setTimeout(r, 1100));
const store = await import('../../lib/store.ts');
const { eventLine } = await import('../../lib/eventLine.ts');

const client = new Client({ name: 'token-bench', version: '1.0.0' });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'bin/vr-mcp')], env: env as Record<string, string>, stderr: 'ignore' }),
);
const call = async (name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> => {
  const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
  if (res.isError) throw new Error(`${name}: ${JSON.stringify(res.content)}`);
  return res;
};
const textOf = (res: CallToolResult) =>
  res.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('\n');
const costOf = (res: CallToolResult): ResultCost => resultCost(res.content as never);

const rows: { item: string; cost: ResultCost }[] = [];
const measure = async (item: string, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> => {
  const res = await call(name, args);
  rows.push({ item, cost: costOf(res) });
  return res;
};

try {
  // ---------------------------------------------------------------- what every turn carries
  const { tools } = await client.listTools();
  // What a client hands the model: the name, the description and the input schema (titles and annotations stay out).
  const modelTools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const list = toolListCost(modelTools);
  // The lean set (VR_MCP_TOOLS=lean): the same definitions, fewer of them. Older servers have no lean set.
  const lean = await import('../../mcp/lean.ts').then((m) => toolListCost(modelTools.filter((t) => m.LEAN_TOOLS.includes(t.name)))).catch(() => null);
  const instructions = approxTokens(client.getInstructions() || '');
  const has = (name: string, param: string) => !!(tools.find((t) => t.name === name)?.inputSchema.properties as Record<string, unknown> | undefined)?.[param];
  const textOfStamp = (res: CallToolResult, re: RegExp) => (re.exec(textOf(res)) || [])[1];

  // ---------------------------------------------------------------- reading
  const video = 'spring-launch';
  await measure('list_videos', 'list_videos');
  await measure('list_folders', 'list_folders');
  const open = await measure('get_open_notes (12 notes, default images)', 'get_open_notes', { video });
  if (has('get_open_notes', 'images')) await measure('get_open_notes (images: all)', 'get_open_notes', { video, images: 'all' });
  await measure('get_open_notes (no images)', 'get_open_notes', { video, include_images: false });
  await measure('get_note (logo, with a reply)', 'get_note', { id: fx.notes[0] });
  await measure('get_note (with a frame reference)', 'get_note', { id: fx.notes[4] });
  const playbook = await measure('get_playbook', 'get_playbook', { video });
  await measure('get_skill', 'get_skill', { video, name: 'export-reels' });
  const taste = await measure('get_taste', 'get_taste', { video });
  await measure('get_transcript (lines)', 'get_transcript', { video });
  // Read again by an agent that hands back what it was told (the stamps), and the same without them.
  const revisions = textOfStamp(playbook, /Revisions in force: (.*?) \(/);
  if (has('get_playbook', 'known')) await measure('get_playbook again (known revisions)', 'get_playbook', { video, known: revisions });
  const tasteStamp = textOfStamp(taste, /\n(taste [0-9a-f]{8})/);
  if (has('get_taste', 'known')) await measure('get_taste again (known stamp)', 'get_taste', { video, known: tasteStamp });

  // ---------------------------------------------------------------- waiting
  const cursorOf = (res: CallToolResult) => (/cursor: (\S+)/.exec(textOf(res)) || [])[1];
  let cursor = cursorOf(await call('wait_for_feedback', { video, timeout_s: 0 }));
  const { openBackend } = await import('../../lib/backend/index.ts');
  const b = openBackend();
  const addOne = (frame: number, text: string) =>
    b.addNote(fx.slug, {
      v: 1,
      frame,
      range: null,
      text,
      tags: ['timing'],
      severity: 'should',
      kind: 'feedback',
      drawing: [{ type: 'box', x: 200, y: 600, w: 400, h: 300 }],
      author: 'Mia Hartmann',
    });
  await addOne(140, 'The second product shot cuts too early.');
  let res = await measure('wait_for_feedback (1 new note)', 'wait_for_feedback', { video, since: cursor, timeout_s: 10 });
  cursor = cursorOf(res);
  await addOne(142, 'Logo flickers here.');
  await addOne(144, 'Hold this frame longer.');
  await addOne(146, 'Too dark.');
  res = await measure('wait_for_feedback (3 new notes)', 'wait_for_feedback', { video, since: cursor, timeout_s: 10 });
  // The next round: the agent saw the 12 notes; since then 4 notes came in and it fixed one. Without `since` (older
  // servers) the whole list comes again.
  const asOf = (/\nas of (\S+)/.exec(textOf(open)) || [])[1];
  await call('mark_fixed', { id: fx.notes[6], note: 'Swapped in the sharp take (B-cam).' });
  if (asOf) await measure('get_open_notes again (since: 4 new, 1 fixed)', 'get_open_notes', { video, since: asOf });
  else await measure('get_open_notes again (since: 4 new, 1 fixed)', 'get_open_notes', { video });

  // ---------------------------------------------------------------- writing
  await measure('add_note (a question)', 'add_note', { video, frame: 50, text: 'Should the CTA stay on screen until the end?', kind: 'question' });
  await measure('mark_fixed', 'mark_fixed', { id: fx.notes[1], note: 'Kerning opened to +40 between SPRING and LAUNCH.' });
  await measure('reply', 'reply', { id: fx.notes[2], note: 'Ducked the music −8 dB under the voice-over.' });
  const fresh = makeVideo(path.join(dir, 'Acme', 'export', 'teaser_cutdown.mp4'), { w: 1080, h: 1920, fps: 30, dur: 2 });
  await measure('track_video (a new render)', 'track_video', { path: fresh, folder: 'Acme/Reels' });
  await measure('set_status', 'set_status', { video, text: 'rendering v2' });

  // ---------------------------------------------------------------- the CLI
  const vr = (args: string[]) => execFileSync(process.execPath, [VR, ...args], { env, encoding: 'utf8' });
  const cli: { item: string; tokens: number }[] = [];
  cli.push({ item: 'vr prompt (12 notes)', tokens: approxTokens(vr(['prompt', video])) });
  cli.push({ item: 'vr show <note>', tokens: approxTokens(vr(['show', fx.notes[0]])) });
  cli.push({ item: 'vr open <video>', tokens: approxTokens(vr(['open', video])) });
  const help = vr(['help']);
  if (help.includes('--brief')) cli.push({ item: 'vr open <video> --brief', tokens: approxTokens(vr(['open', video, '--brief'])) });
  const events = store.readEvents({ limit: 400 }).filter((e) => e.type === 'comment' && e.slug === fx.slug);
  const avg = (l: string[]) => Math.round(l.reduce((s, x) => s + approxTokens(x), 0) / Math.max(1, l.length));
  cli.push({ item: `vr watch, one NEW line (avg of ${events.length})`, tokens: avg(events.map(eventLine)) });
  const lines = await import('../../lib/eventLine.ts');
  if ('shortEventLine' in lines) cli.push({ item: 'vr watch --brief, one NEW line (= wait_for_feedback)', tokens: avg(events.map(lines.shortEventLine)) });
  const inbox = fs.readFileSync(path.join(env.VR_DATA as string, 'INBOX.md'), 'utf8');
  const inboxNotes = (inbox.match(/^### /gm) || []).length || events.length;
  cli.push({ item: `INBOX.md per note (avg of ${inboxNotes})`, tokens: Math.round(approxTokens(inbox) / Math.max(1, inboxNotes)) });
  const skill = fs.readFileSync(path.join(ROOT, 'skills/lampo/SKILL.md'), 'utf8');
  cli.push({ item: 'skills/lampo/SKILL.md (read into context)', tokens: approxTokens(skill) });

  // ---------------------------------------------------------------- one loop
  // connect → read the playbook and the new notes → look at one closely → fix 3 → (re-render) → wait → answer once.
  const by = (k: string) => rows.find((r) => r.item.startsWith(k))?.cost.total ?? 0;
  const results = by('get_playbook') + by('get_open_notes (12') + by('get_note (logo') + 3 * by('mark_fixed') + by('wait_for_feedback (1') + by('reply');
  const TURNS = 8;
  const perTurn = list.total;
  const loop = { turns: TURNS, toolList: perTurn, instructions, results, context: perTurn * TURNS + instructions + results };
  // The next round, in the same conversation: woken by new feedback → what changed → the playbook again → one note
  // closely → fix it → wait. An agent that hands back its stamps reads only the changes.
  const results2 =
    by('wait_for_feedback (1') +
    by('get_open_notes again') +
    (by('get_playbook again') || by('get_playbook')) +
    (by('get_taste again') || by('get_taste')) +
    by('get_note (logo') +
    by('mark_fixed');
  const TURNS2 = 6;
  const round2 = { turns: TURNS2, toolList: perTurn, results: results2, context: perTurn * TURNS2 + results2 };

  // ---------------------------------------------------------------- report
  const out: string[] = [];
  out.push('| What | Text | Images | Image tokens | Total |', '|---|---:|---:|---:|---:|');
  out.push(`| **Tool list** (${tools.length} tools, every turn) | ${list.total} | | | **${list.total}** |`);
  if (lean) out.push(`| Tool list, lean set (${lean.per.length} tools, VR_MCP_TOOLS=lean) | ${lean.total} | | | ${lean.total} |`);
  out.push(`| Server instructions (once) | ${instructions} | | | ${instructions} |`);
  for (const r of rows)
    out.push(
      `| ${r.item} | ${r.cost.text} | ${r.cost.images}${r.cost.sizes.length ? ` (${[...new Set(r.cost.sizes)].join(', ')})` : ''} | ${r.cost.imageTokens} | ${r.cost.total} |`,
    );
  out.push('', '| CLI / files | Tokens |', '|---|---:|');
  for (const c of cli) out.push(`| ${c.item} | ${c.tokens} |`);
  out.push('', 'Largest tools in the list:', '');
  for (const t of list.per.slice(0, 8)) out.push(`- ${t.name}: ${t.tokens}`);
  out.push(
    '',
    `**One loop** (${TURNS} turns): tool list ${perTurn} × ${TURNS} + instructions ${instructions} + results ${results} = **${loop.context}** tokens of context (the tool list is usually cached, at a tenth of the price, but it fills the window all the same).`,
    `**The next round** (${TURNS2} turns): tool list ${perTurn} × ${TURNS2} + results ${results2} = **${round2.context}** tokens.`,
  );
  console.log(out.join('\n'));
  if (jsonOut)
    fs.writeFileSync(jsonOut, `${JSON.stringify({ toolList: list, lean, instructions, rows, cli, loop, round2, openNotesText: textOf(open) }, null, 2)}\n`);
} finally {
  await client.close().catch(() => {});
  stt.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
