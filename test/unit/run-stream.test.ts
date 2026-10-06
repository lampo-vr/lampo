// A run Lampo started prints Claude Code's stream-json; lib/runStream.ts reads it as it grows into the step the run is
// on, its tokens and — only when the run states it — its cost. Fixtures only: the real CLI is never run.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRunReader, shownPath, toolStep } from '../../lib/runStream.ts';

const CWD = '/work/spot';
const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const init = { type: 'system', subtype: 'init', session_id: 's1', cwd: CWD, tools: ['Edit', 'Bash'] };
const assistant = (id: string, content: unknown[], usage: Record<string, number>) => ({
  type: 'assistant',
  message: { id, role: 'assistant', content, usage },
});
const toolUse = (name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id: `t_${name}`, name, input });
const toolResult = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'secret file contents' }] } };
const result = (extra: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 3,
  total_cost_usd: 0.0421,
  usage: { input_tokens: 40, output_tokens: 900, cache_read_input_tokens: 12000, cache_creation_input_tokens: 3000 },
  ...extra,
});

test('steps: tools in plain words, paths relative to the session folder, never file contents or whole commands', () => {
  const r = createRunReader(CWD);
  const steps = r.feed(
    line(init) +
      line(assistant('m1', [toolUse('Read', { file_path: `${CWD}/src/Logo.tsx` })], { input_tokens: 10, output_tokens: 5 })) +
      line(toolResult) +
      line(
        assistant('m2', [toolUse('Edit', { file_path: `${CWD}/src/Logo.tsx`, old_string: 'a', new_string: 'b' })], { input_tokens: 12, output_tokens: 30 }),
      ) +
      line(assistant('m3', [toolUse('Bash', { command: `npm run render -- --out ${'x'.repeat(200)}` })], { input_tokens: 4, output_tokens: 9 })),
  );
  assert.deepEqual(
    steps.map((s) => s.text),
    ['Reading src/Logo.tsx', 'Editing src/Logo.tsx', `Running npm run render -- --out ${'x'.repeat(35)}…`],
  );
  assert.equal(steps[1].key, 'Editing {file}');
  assert.deepEqual(steps[1].vars, { file: 'src/Logo.tsx' });
  assert.ok(!JSON.stringify(steps).includes('secret file contents'));
  assert.equal(r.state().step?.text, steps[2].text);
  // Outside the session's folder only the file's name shows.
  assert.equal(shownPath('/elsewhere/private/notes.txt', CWD), 'notes.txt');
  assert.equal(toolStep('Grep', { pattern: 'logo' }, CWD).text, 'Searching for logo');
  assert.equal(toolStep('mcp__lampo__get_note', { id: 'c_7f3a01' }, CWD).text, 'Reading note c_7f3a01');
  assert.equal(toolStep('mcp__lampo__mark_fixed', { id: 'c_7f3a01', note: 'logo moved' }, CWD).quote, 'logo moved');
  // A session set up under the earlier key reads the same.
  assert.equal(toolStep('mcp__video-review__get_note', { id: 'c_7f3a01' }, CWD).text, 'Reading note c_7f3a01');
  assert.equal(toolStep('mcp__video-review__mark_fixed', { id: 'c_7f3a01', note: 'logo moved' }, CWD).quote, 'logo moved');
  assert.equal(toolStep('mcp__other__do_thing', {}, CWD).text, 'Using do thing');
  assert.equal(toolStep('SomeNewTool', {}, CWD).text, 'Using SomeNewTool');
});

test('partial lines wait for the rest; junk and non-JSON lines are skipped', () => {
  const r = createRunReader(CWD);
  const whole = line(assistant('m1', [toolUse('Write', { file_path: `${CWD}/out/cut.txt` })], { input_tokens: 1, output_tokens: 1 }));
  const cut = Math.floor(whole.length / 2);
  assert.deepEqual(r.feed(whole.slice(0, cut)), []);
  assert.equal(r.state().step, null);
  const steps = r.feed(`${whole.slice(cut)}not json at all\n{"broken":\n`);
  assert.deepEqual(
    steps.map((s) => s.text),
    ['Writing out/cut.txt'],
  );
  assert.equal(r.state().tokens.output, 1);
});

test('tokens: usage repeated per message counts once, messages add up, the result’s totals win; cost only when stated', () => {
  const r = createRunReader(CWD);
  // One message, two blocks: the stream repeats the message's usage with each.
  r.feed(line(assistant('m1', [{ type: 'thinking', thinking: '…' }], { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 5000 })));
  r.feed(
    line(
      assistant('m1', [{ type: 'text', text: 'Moving the logo now. Then I render.' }], { input_tokens: 100, output_tokens: 25, cache_read_input_tokens: 5000 }),
    ),
  );
  assert.deepEqual(r.state().tokens, { input: 100, output: 25, cache_read: 5000, cache_write: 0 });
  assert.equal(r.state().step?.text, 'Moving the logo now.');
  // A second turn adds up.
  r.feed(line(assistant('m2', [toolUse('Edit', { file_path: `${CWD}/a.ts` })], { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 200 })));
  assert.deepEqual(r.state().tokens, { input: 107, output: 28, cache_read: 5000, cache_write: 200 });
  assert.equal(r.state().cost_usd, null, 'no cost before the run states one');
  assert.equal(r.state().done, false);
  const steps = r.feed(line(result()));
  assert.deepEqual(r.state().tokens, { input: 40, output: 900, cache_read: 12000, cache_write: 3000 });
  assert.equal(r.state().cost_usd, 0.0421);
  assert.equal(r.state().turns, 3);
  assert.equal(r.state().done, true);
  assert.deepEqual(
    steps.map((s) => [s.kind, s.text]),
    [['run', 'Finished']],
  );
});

test('several turns: the same step twice in a row is one step; an error result says so; no cost field, no cost', () => {
  const r = createRunReader(CWD);
  const a = r.feed(
    line(assistant('m1', [toolUse('Read', { file_path: `${CWD}/a.ts` })], { output_tokens: 1 })) +
      line(assistant('m2', [toolUse('Read', { file_path: `${CWD}/a.ts` })], { output_tokens: 1 })) +
      line(assistant('m3', [toolUse('Read', { file_path: `${CWD}/b.ts` })], { output_tokens: 1 })),
  );
  assert.deepEqual(
    a.map((s) => s.text),
    ['Reading a.ts', 'Reading b.ts'],
  );
  const { total_cost_usd: _, ...noCost } = result({ subtype: 'error_max_turns', is_error: true });
  const b = r.feed(line(noCost));
  assert.deepEqual(
    b.map((s) => s.text),
    ['Stopped with an error'],
  );
  assert.equal(r.state().error, true);
  assert.equal(r.state().cost_usd, null);
});

test('a runaway line without an end is dropped instead of kept growing', () => {
  const r = createRunReader(CWD);
  r.feed(`{"type":"assistant","message":{"content":"${'x'.repeat(1_100_000)}`);
  const steps = r.feed(`\n${line(assistant('m1', [toolUse('Read', { file_path: `${CWD}/ok.ts` })], { output_tokens: 1 }))}`);
  assert.deepEqual(
    steps.map((s) => s.text),
    ['Reading ok.ts'],
  );
});
