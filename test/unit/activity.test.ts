// The live agent monitor's server half: an agent's calls in plain words (lib/activityText.ts), what a process records
// (lib/activity.ts: the rolling file here, batches to a hosted server), and the store the UI reads
// (server/activity.ts): one line per action, a wait that keeps being asked for is one wait, progress moves one line,
// memory stays bounded, the rolling file is followed across rotations. No agent is asked for anything.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { ActivityRecord } from '../../lib/activity.ts';
import { isolatedEnv, sleep } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const { ACTIVITY_KEYS, cliActivity, toolActivity, words } = await import('../../lib/activityText.ts');
const { fileSink, remoteSink, processAgent, ACTIVITY_MAX_BYTES } = await import('../../lib/activity.ts');
const { cleanActivity, createActivityStore } = await import('../../server/activity.ts');

const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 10, 0, s)).toISOString();
const quietStore = () => {
  const sent: unknown[] = [];
  return { store: createActivityStore(((type: string, data: unknown) => sent.push([type, data])) as never), sent };
};
const rec = (o: Partial<ActivityRecord> & { s: number }): ActivityRecord => {
  const { s, ...rest } = o;
  return { agent: 'reel-cut', kind: 'read', text: 'Reading the open notes', slug: 'spot', ...rest, at: at(s) };
};

test('calls in plain words: every MCP tool and vr command an agent uses, with a template the UI can translate', () => {
  assert.equal(toolActivity('get_note', { id: 'c_7f3a01' })?.text, 'Reading note c_7f3a01');
  assert.equal(toolActivity('get_open_notes', { video: 'spot.mp4' })?.video, 'spot.mp4');
  assert.equal(toolActivity('wait_for_feedback', {})?.kind, 'wait');
  const fixed = toolActivity('mark_fixed', { id: 'c_7f3a01', note: `moved the logo ${'very '.repeat(30)}far` });
  assert.equal(fixed?.kind, 'fix');
  assert.equal(fixed?.key, 'Fixed {id}');
  assert.ok((fixed?.quote ?? '').length <= 48 && fixed?.quote?.endsWith('…'), 'what was written is only an excerpt');
  assert.equal(toolActivity('add_note', { text: 'Which logo?' })?.kind, 'ask');
  assert.equal(toolActivity('add_note', { text: 'Too fast', severity: 'should' })?.kind, 'note');
  assert.equal(toolActivity('get_frame', { frame: 120 })?.text, 'Looking at frame 120');
  assert.equal(toolActivity('set_status', { text: 'Rendering v3' })?.text, 'Rendering v3');
  assert.equal(toolActivity('set_status', {}), null);
  assert.equal(toolActivity('some_future_tool', {}), null);
  // One line per text: no newline from what someone wrote reaches it.
  assert.ok(!toolActivity('reply', { id: 'c_1234', text: 'two\nlines' })?.text.includes('\n'));

  assert.equal(cliActivity('fix', ['c_7f3a01'], { note: 'done' })?.text, 'Fixed c_7f3a01 “done”');
  assert.equal(cliActivity('watch')?.kind, 'wait');
  assert.equal(cliActivity('push', [], { to: 'spot' })?.video, 'spot');
  assert.equal(cliActivity('fix', ['not-a-note']), null);
  assert.equal(cliActivity('login'), null, 'commands that aren’t work on a video say nothing');

  // Every template's placeholders are filled from its vars.
  for (const key of ACTIVITY_KEYS) {
    const names = [...key.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const w = words(key, Object.fromEntries(names.map((n) => [n, 'X'])));
    assert.ok(!/\{\w+\}/.test(w.text), key);
  }
});

test('what a caller sends is cleaned: known kinds and templates only, one line, short fill-ins', () => {
  assert.equal(cleanActivity({ ...rec({ s: 0 }), kind: 'nonsense' as never }), null);
  assert.equal(cleanActivity({ ...rec({ s: 0 }), agent: '' }), null);
  assert.equal(cleanActivity({ ...rec({ s: 0 }), text: '   ' }), null);
  const c = cleanActivity({
    ...rec({ s: 0 }),
    agent: 'agent:reel-cut',
    text: `line one\nline two ${'x'.repeat(400)}`,
    key: 'Not a template {x}',
    vars: { x: 'y' },
    pct: 340,
    at: 'yesterday-ish',
  });
  assert.ok(c);
  assert.equal(c.agent, 'reel-cut');
  assert.ok(!c.text.includes('\n') && c.text.length <= 160);
  assert.equal(c.key, undefined, 'an unknown template is dropped (the UI shows the text)');
  assert.equal(c.vars, undefined);
  assert.equal(c.pct, 100);
  assert.ok(!Number.isNaN(Date.parse(c.at)));
  const v = cleanActivity({ ...rec({ s: 0 }), ...words('Editing {file}', { file: 'a.ts' }), vars: { file: `a\nb${'c'.repeat(200)}`, 'bad key': 'x', n: 4 } });
  assert.deepEqual(Object.keys(v?.vars ?? {}), ['file', 'n']);
  assert.ok(String(v?.vars?.file).length <= 80 && !String(v?.vars?.file).includes('\n'));
});

test('the store: one line per action, newest first; the same action again soon is the same line', () => {
  const { store } = quietStore();
  store.record(rec({ s: 0, text: 'Reading the open notes' }));
  store.record(rec({ s: 1, text: 'Reading the open notes' }));
  store.record(rec({ s: 2, kind: 'fix', text: 'Fixed c_1234' }));
  store.record(rec({ s: 30, kind: 'read', text: 'Reading the open notes' }));
  const [live] = store.live('spot');
  assert.equal(live.agent, 'reel-cut');
  assert.deepEqual(
    live.recent.map((a) => a.text),
    ['Reading the open notes', 'Fixed c_1234', 'Reading the open notes'],
  );
  assert.equal(live.recent[2].at, at(1), 'the repeat within a few seconds updated the line');
  assert.equal(live.current?.text, 'Reading the open notes');
});

test('a wait asked for again and again is one wait, “since” its start; a render or an upload moves one line', () => {
  const { store } = quietStore();
  for (const s of [0, 60, 120, 180]) store.record(rec({ s, kind: 'wait', text: 'Waiting for your answer' }));
  let [live] = store.live('spot');
  assert.equal(live.recent.length, 1);
  assert.equal(live.recent[0].since, at(0));
  assert.equal(live.recent[0].at, at(180));
  for (const [s, mb] of [
    [200, 10],
    [202, 120],
    [204, 340],
  ])
    store.record(rec({ s, kind: 'render', ...words('Rendering… {mb} MB, still growing', { mb }) }));
  for (const [s, pct] of [
    [210, 10],
    [211, 55],
    [212, 100],
  ])
    store.record(rec({ s, kind: 'upload', ...words('Uploading {name}', { name: 'spot_v3.mp4' }), pct }));
  [live] = store.live('spot');
  assert.deepEqual(
    live.recent.map((a) => [a.kind, a.text, a.pct ?? null, a.since ?? null]),
    [
      ['upload', 'Uploading spot_v3.mp4', 100, null],
      ['render', 'Rendering… 340 MB, still growing', null, null],
      ['wait', 'Waiting for your answer', null, at(0)],
    ],
  );
});

test('a run’s step and the call it made are one line, with the call’s kind', () => {
  const { store } = quietStore();
  store.record(rec({ s: 0, kind: 'tool', ...words('Reading note {id}', { id: 'c_1234' }) }));
  store.record(rec({ s: 1, kind: 'read', ...words('Reading note {id}', { id: 'c_1234' }) }));
  const [live] = store.live('spot');
  assert.equal(live.recent.length, 1);
  assert.equal(live.recent[0].kind, 'read');
  assert.equal(live.recent[0].key, 'Reading note {id}');
});

test('a video’s view tells the agent’s whole story there (its waits elsewhere too); without a video, one line per agent', () => {
  const { store } = quietStore();
  store.record(rec({ s: 0, slug: 'spot', text: 'Reading the open notes' }));
  store.record(rec({ s: 5, slug: null, kind: 'wait', text: 'Waiting for your answer' }));
  store.record(rec({ s: 6, slug: 'other', agent: 'promo', kind: 'fix', text: 'Fixed c_9999' }));
  const spot = store.live('spot');
  assert.deepEqual(
    spot.map((a) => a.agent),
    ['reel-cut'],
  );
  assert.deepEqual(
    spot[0].recent.map((a) => a.text),
    ['Waiting for your answer', 'Reading the open notes'],
  );
  // An agent named by the caller shows before it touched the video, from what it did elsewhere.
  assert.deepEqual(
    store.live('fresh', ['reel-cut']).map((a) => a.current?.text),
    ['Waiting for your answer'],
  );
  assert.deepEqual(store.live('fresh', ['nobody']), []);
  const all = store.live();
  assert.deepEqual(
    all.map((a) => [a.agent, a.current?.text, a.recent.length]),
    [
      ['promo', 'Fixed c_9999', 1],
      ['reel-cut', 'Waiting for your answer', 1],
    ],
  );
});

test('memory is bounded: a dozen lines per agent and video, a few hundred agent × video pairs', () => {
  const { store } = quietStore();
  for (let i = 0; i < 40; i++) store.record(rec({ s: i * 10, kind: 'fix', text: `Fixed c_${String(i).padStart(4, '0')}` }));
  assert.equal(store.live('spot')[0].recent.length, 12);
  for (let i = 0; i < 400; i++) store.record(rec({ s: 500 + i, slug: `v${i}`, agent: `a${i}` }));
  assert.ok(store.live().length <= 300);
  assert.deepEqual(store.live('spot'), [], 'the least recently active pair went first');
});

test('the UI is told at most once per agent and video in a burst, with no more than who and where', async () => {
  const { store, sent } = quietStore();
  for (let i = 0; i < 20; i++) store.record(rec({ s: i, kind: 'fix', text: `Fixed c_${1000 + i}` }));
  await sleep(450);
  assert.deepEqual(sent, [['agent-activity', { agent: 'reel-cut', slug: 'spot' }]]);
});

test('a process on this machine appends to the rolling file; the app follows it, also across a rotation', async () => {
  const file = path.join(dir, 'cache', 'live-test.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(rec({ s: 0, text: 'Before the app started' }))}\n`);
  const { store } = quietStore();
  const stop = store.tail(file);
  const sink = fileSink(file);
  try {
    sink.record(rec({ s: 1, kind: 'fix', text: 'Fixed c_1111' }));
    const until = async (fn: () => boolean, what: string) => {
      for (let i = 0; i < 60 && !fn(); i++) await sleep(100);
      assert.ok(fn(), what);
    };
    const texts = () => store.live('spot')[0]?.recent.map((a) => a.text) ?? [];
    await until(() => texts().includes('Fixed c_1111'), 'the appended line is read');
    assert.ok(!texts().includes('Before the app started'), 'what was there before the app started is history');
    // Past its size the file is rotated to .1; what was added just before and after both arrive.
    fs.appendFileSync(file, `${JSON.stringify(rec({ s: 2, kind: 'fix', text: 'Fixed c_2222' }))}\n`);
    fs.appendFileSync(file, 'x'.repeat(ACTIVITY_MAX_BYTES + 10));
    fs.appendFileSync(file, '\n');
    sink.record(rec({ s: 3, kind: 'fix', text: 'Fixed c_3333' }));
    assert.ok(fs.existsSync(`${file}.1`), 'rotated');
    assert.ok(fs.statSync(file).size < 1000);
    await until(() => texts().includes('Fixed c_3333') && texts().includes('Fixed c_2222'), 'both sides of the rotation are read');
  } finally {
    stop();
  }
});

test('against a hosted server a process sends batches: at most 20 lines, flushed before a command exits', async () => {
  const posts: ActivityRecord[][] = [];
  const sink = remoteSink(async (entries) => {
    posts.push(entries);
  });
  for (let i = 0; i < 30; i++) sink.record(rec({ s: i, kind: 'fix', text: `Fixed c_${2000 + i}` }));
  assert.equal(posts.length, 0, 'nothing is sent per call');
  await sink.flush();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].length, 20);
  assert.equal(posts[0].at(-1)?.text, 'Fixed c_2029', 'the newest are kept');
  // A server that doesn't answer doesn't hold a command up for long.
  const slow = remoteSink(() => new Promise(() => {}));
  slow.record(rec({ s: 0 }));
  const t0 = Date.now();
  await slow.flush();
  // Returning at all is the 0.8 s give-up (the post never settles); a generous bound, so a loaded machine can't fail it.
  assert.ok(Date.now() - t0 < 5000);
});

test('who records: an agent by its session or VR_BY name; a person running vr by hand records nothing', () => {
  assert.equal(processAgent({}), null);
  assert.equal(processAgent({ VR_BY: 'sam' }), null);
  assert.equal(processAgent({ VR_BY: 'agent:reel-cut' }), 'reel-cut');
});
