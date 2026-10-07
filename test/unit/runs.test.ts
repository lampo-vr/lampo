// Agents' runs, the store and the rules (lib/runs.ts): a store without runs loads unchanged; runs.jsonl is written under
// the video's lock and compacted (≤ 200 steps, progress keeps its first and last line, none after 90 days, lines it
// can't read kept); every transition of §4.1 and the done rule (first match wins); lost after quiet, revived by any sign,
// closed as stopped after an hour; worked time without the time waiting for the person; the plan; a version names the
// run it came from; the new-notes line.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { approxTokens } from '../../bench/tokens/count.ts';
import { age, isolatedEnv, makeVideo } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const runs = await import('../../lib/runs.ts');
const { slugify, reviewDir } = await import('../../lib/paths.ts');
const { words } = await import('../../lib/activityText.ts');

const video = makeVideo(path.join(dir, 'proj/export/spot.mp4'), { dur: 1 });
store.createOrGetReview(video, { by: 'tester' });
const slug = slugify(path.resolve(video));
const T0 = Date.parse('2026-10-07T10:00:00Z');
const min = 60_000;
const agent = runs.runAgent('spot-edit', 'claude-code');
const fresh = (o: Partial<Parameters<typeof runs.newRun>[0]> = {}, now = T0) =>
  runs.newRun({ slug, agent, opened_by: { who: 'tester', how: 'send' }, notes: ['c_aaaa01', 'c_aaaa02'], ...o }, now);
const sign = (
  at: number,
  kind: Parameters<typeof runs.stepTypeOf>[0],
  w = words('Reading the open notes'),
  more: Partial<import('../../lib/runs.ts').Sign> = {},
) => ({ at, kind, words: w, ...more }) as import('../../lib/runs.ts').Sign;

test('a store without runs loads unchanged: no runs.jsonl is written by reading, and the video reads as before', () => {
  const before = fs.readFileSync(path.join(reviewDir(slug), 'review.json'), 'utf8');
  assert.deepEqual(runs.readRuns(slug), []);
  assert.equal(runs.briefFor(slug), null);
  assert.equal(runs.findRun('run_0123456789ab'), null);
  assert.equal(fs.existsSync(runs.runsFile(slug)), false, 'reading writes nothing');
  assert.equal(fs.readFileSync(path.join(reviewDir(slug), 'review.json'), 'utf8'), before);
  assert.equal(runs.versionRunOf(slug, 'agent:spot-edit'), undefined);
});

test('the file: written under the video’s lock, atomically, one line per run; lines it can’t read are kept as they are', () => {
  const r = fresh();
  runs.changeRuns(slug, (list) => list.push(r));
  assert.equal(runs.isDirty(slug), true);
  // a lock left by an earlier run of this process (its pid, another run id): taken over, then released
  const lock = path.join(reviewDir(slug), '.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}@${os.hostname()}`);
  fs.writeFileSync(path.join(lock, 'run'), 'someone-else');
  assert.equal(runs.flushRuns(slug), true);
  assert.equal(fs.existsSync(lock), false, 'the lock is released');
  const lines = fs.readFileSync(runs.runsFile(slug), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0] as string).id, r.id);
  assert.equal(runs.isDirty(slug), false);
  // a line from a later version (or damaged) survives the next write
  fs.appendFileSync(runs.runsFile(slug), '{"id":"later-kind","what":"unknown"}\nnot json\n');
  assert.equal(runs.readRuns(slug).length, 1, 'read again: the file changed');
  runs.changeRuns(slug, (list) => {
    (list[0] as import('../../lib/runs.ts').StoredRun).request = 'go';
  });
  runs.flushRuns(slug);
  const text = fs.readFileSync(runs.runsFile(slug), 'utf8');
  assert.match(text, /\{"id":"later-kind","what":"unknown"\}\nnot json\n/);
  assert.equal(runs.findRun(r.id)?.run.request, 'go');
  // clean up for the tests below
  fs.rmSync(runs.runsFile(slug));
  runs.changeRuns(slug, (list) => list.splice(0));
  runs.flushRuns(slug);
});

test('steps: the same line again moves to its time; a stretch of progress keeps its first and last; at most 200, the first and questions kept', () => {
  const r = fresh();
  runs.keepStep(r, { text: 'Reading the open notes', at: 'a', type: 'action' });
  runs.keepStep(r, { text: 'Reading the open notes', at: 'b', type: 'action' });
  assert.deepEqual(
    r.steps.map((s) => s.at),
    ['b'],
  );
  for (let i = 0; i < 5; i++) runs.keepStep(r, { text: `Rendering ${i * 20} %`, at: `p${i}`, type: 'progress' });
  assert.deepEqual(
    r.steps.map((s) => s.text),
    ['Reading the open notes', 'Rendering 0 %', 'Rendering 80 %'],
  );
  runs.keepStep(r, { text: 'Asked a question', at: 'q', type: 'elicitation' });
  for (let i = 0; i < 300; i++) runs.keepStep(r, { text: `Editing file${i}.tsx`, at: `e${i}`, type: 'action' });
  assert.equal(r.steps.length, runs.RUN_LIMITS.steps);
  assert.equal(r.steps[0]?.text, 'Reading the open notes', 'the first step stays');
  assert.ok(
    r.steps.some((s) => s.type === 'elicitation'),
    'a question stays',
  );
  assert.equal(r.steps.at(-1)?.text, 'Editing file299.tsx');
  // 90 days after it ended a run keeps its head only
  runs.endRun(r, 'done', T0);
  runs.compact(r, T0 + 89 * 86_400_000);
  assert.equal(r.steps.length, 200);
  runs.compact(r, T0 + 91 * 86_400_000);
  assert.deepEqual(r.steps, []);
  assert.equal(r.state, 'done');
});

test('queued → working at the first sign (a bare wait leaves it queued; a wait that hands it over begins it)', () => {
  const r = fresh();
  assert.equal(r.state, 'queued');
  assert.deepEqual(runs.applySign(r, sign(T0 + 1000, 'wait', words('Waiting for your answer'))), []);
  assert.equal(r.state, 'queued', 'listening is not working');
  assert.deepEqual(runs.applySign(r, sign(T0 + 2000, 'wait', words('Waiting for your answer'), { handed: true, quiet: true })), ['started']);
  assert.equal(r.state, 'working');
  assert.equal(Date.parse(r.now?.at as string), T0 + 1000, 'a hand-over says nothing new: its wait is still what it said last');
  const q = fresh();
  assert.deepEqual(runs.applySign(q, sign(T0 + 5000, 'read')), ['started']);
  assert.equal(q.now?.text, 'Reading the open notes');
  assert.equal(q.now?.type, 'action');
  assert.equal(q.worked_s, 0, 'queued time is not worked time');
  assert.equal(runs.workedAt(q, T0 + 65_000), 60);
});

test('the plan: “on it” only from its own calls about a note; fixed, left, replied and asked from what it did', () => {
  const r = fresh({ notes: ['c_aaaa01', 'c_aaaa02', 'c_aaaa03', 'c_aaaa04'] });
  runs.applySign(r, sign(T0 + 1000, 'read', words('Reading note {id}', { id: 'c_aaaa01' }), { target: 'c_aaaa01' }));
  assert.equal(r.plan[0]?.state, 'doing');
  runs.applySign(r, sign(T0 + 2000, 'read', words('Looking at frame {frame}', { frame: 12 }), { atFrame: ['c_aaaa02'] }));
  assert.equal(r.plan[1]?.state, 'doing');
  runs.applySign(r, sign(T0 + 3000, 'fix', words('Fixed {id}', { id: 'c_aaaa01' }), { target: 'c_aaaa01' }));
  runs.applySign(r, sign(T0 + 4000, 'reply', words('Left {id} as it is', { id: 'c_aaaa03' }), { target: 'c_aaaa03' }));
  runs.applySign(r, sign(T0 + 5000, 'reply', words('Replied to {id}', { id: 'c_aaaa04' }), { target: 'c_aaaa04' }));
  assert.deepEqual(
    r.plan.map((p) => p.state),
    ['fixed', 'doing', 'wontfix', 'replied'],
  );
  // reading a note again never takes back what was done
  runs.applySign(r, sign(T0 + 6000, 'read', words('Reading note {id}', { id: 'c_aaaa01' }), { target: 'c_aaaa01' }));
  assert.equal(r.plan[0]?.state, 'fixed');
  // nothing moves by time: an hour on, the note in hand is still the one it named
  runs.settle(r, T0 + 6000 + 10 * min);
  assert.equal(r.plan[1]?.state, 'doing');
  // a question while a note is in hand: that note is asked about, the run needs the person
  assert.deepEqual(runs.applySign(r, sign(T0 + 7000, 'ask', words('Asked a question'), { needs: { kind: 'question', note: 'c_bbbb01' } })), ['needs_you']);
  assert.equal(r.plan[1]?.state, 'asked');
  assert.equal(r.state, 'needs_you');
  assert.deepEqual(r.needs, { kind: 'question', note: 'c_bbbb01' });
  // the same question again (its event after its call): counted once
  runs.askedPerson(r, T0 + 7500, { kind: 'question', note: 'c_bbbb01' });
  assert.deepEqual(r.result && { fixed: r.result.fixed, asked: r.result.asked, wontfix: r.result.wontfix }, { fixed: 1, asked: 1, wontfix: 1 });
  // a person reopens a note (still wrong): back to do
  runs.noteMoved(r, 'c_aaaa01', 'todo', T0 + 8000);
  assert.equal(r.plan[0]?.state, 'todo');
  // notes sent while it works join its plan, marked
  assert.deepEqual(runs.addNotes(r, ['c_aaaa04', 'c_cccc01'], T0 + 9000), ['c_cccc01']);
  assert.equal(r.plan.at(-1)?.added, true);
  const queued = fresh();
  runs.addNotes(queued, ['c_cccc02']);
  assert.equal(queued.plan.at(-1)?.added, undefined, 'before it began, a note is simply part of it');
});

test('needs you ⇄ working: an answer sends it on; time waiting for the person is not worked time, nor goes it lost', () => {
  const r = fresh();
  runs.applySign(r, sign(T0, 'read'));
  runs.applySign(r, sign(T0 + 60_000, 'ask', words('Asked a question'), { needs: { kind: 'options', note: 'c_bbbb01' } }));
  assert.equal(r.state, 'needs_you');
  assert.equal(r.worked_s, 60);
  assert.equal(runs.workedAt(r, T0 + 3 * 3600_000), 60, 'the person took three hours: not counted');
  assert.equal(runs.settle(r, T0 + 3 * 3600_000), null, 'waiting for the person never goes lost');
  // another of its questions still open keeps it needing the person
  assert.equal(runs.answered(r, T0 + 3 * 3600_000, 'c_bbbb02'), false);
  assert.equal(r.needs?.note, 'c_bbbb02');
  assert.equal(runs.answered(r, T0 + 3 * 3600_000 + 1000), true);
  assert.equal(r.state, 'working');
  assert.equal(r.needs, undefined);
  assert.equal(runs.workedAt(r, T0 + 3 * 3600_000 + 31_000), 90);
});

test('lost: no sign for 20 min (an agent heard through its calls; 5 min for a run Lampo reads; +10 while rendering); any sign revives it; an hour lost closes it as stopped', () => {
  const r = fresh();
  runs.applySign(r, sign(T0, 'read'));
  assert.equal(runs.due(r, T0 + 19 * min), false);
  assert.equal(runs.settle(r, T0 + 19 * min), null);
  assert.equal(runs.settle(r, T0 + 21 * min), 'lost');
  assert.equal(r.state, 'lost');
  assert.equal(runs.workedAt(r, T0 + 50 * min), 0, 'it worked up to its last sign');
  assert.deepEqual(runs.applySign(r, sign(T0 + 30 * min, 'fix', words('Fixed {id}', { id: 'c_aaaa01' }), { target: 'c_aaaa01' })), []);
  assert.equal(r.state, 'working', 'revived');
  assert.equal(runs.settle(r, T0 + 51 * min), 'lost');
  assert.equal(runs.settle(r, T0 + 50 * min + 59 * min), null);
  assert.equal(runs.settle(r, T0 + 50 * min + 61 * min), 'ended');
  assert.equal(r.state, 'stopped');
  assert.equal(Date.parse(r.ended as string), T0 + 50 * min + 60 * min, 'an hour after it went lost');
  assert.equal(r.error, undefined, 'without blame');
  // a run this machine started and reads: 5 min; a render reporting: 10 more
  const m = fresh({ delivery: 'machine', state: 'starting' });
  runs.applySign(m, sign(T0, 'tool', words('Running {command}', { command: 'npm test' })));
  assert.equal(runs.settle(m, T0 + 6 * min), 'lost');
  const rendering = fresh();
  runs.applySign(rendering, sign(T0, 'render', words('Rendering a new version'), { progress: { what: 'render', stage: 'rendering', pct: 10 } }));
  assert.equal(runs.settle(rendering, T0 + 25 * min), null);
  assert.equal(runs.settle(rendering, T0 + 31 * min), 'lost');
  // a sign that names no video revives it too
  assert.equal(runs.alive(rendering, T0 + 32 * min), true);
  assert.equal(rendering.state, 'working');
  // the card shows it lost as of now, before the clock writes it
  const q = fresh();
  runs.applySign(q, sign(Date.now() - 25 * min, 'read'));
  runs.changeRuns(slug, (list) => list.push(q));
  assert.equal(runs.briefFor(slug)?.state, 'lost');
  assert.equal(runs.readRuns(slug).find((x) => x.id === q.id)?.state, 'working', 'reading moved nothing');
  runs.changeRuns(slug, (list) => list.splice(0));
});

test('the done rule, first match wins: an exit, a wait after handing back, the final response, and a version with every note answered', () => {
  // 1. a run this machine started exits 0 with nothing open → done; with a question open → it ends needing you
  const a = fresh({ delivery: 'machine', state: 'starting' });
  runs.applySign(a, sign(T0, 'read'));
  assert.deepEqual(runs.processEnded(a, { phase: 'finished', code: 0, summary: 'V2: 2 fixed.\nThe logo is a spring now.' }, T0 + 9 * min), ['ended']);
  assert.equal(a.state, 'done');
  assert.equal(a.result?.summary, 'V2: 2 fixed. ↵ The logo is a spring now.');
  assert.equal(a.now?.type, 'response', 'its last words are the hand-back');
  assert.equal(a.worked_s, 9 * 60);
  const b = fresh({ delivery: 'machine', state: 'starting' });
  runs.applySign(b, sign(T0, 'ask', words('Asked a question')));
  runs.processEnded(b, { phase: 'finished', code: 0 }, T0 + min);
  assert.equal(b.state, 'needs_you');
  assert.ok(b.ended);
  const c = fresh({ delivery: 'machine', state: 'starting' });
  runs.processEnded(c, { phase: 'finished', code: 2 }, T0 + min);
  assert.equal(c.state, 'failed');
  assert.equal(c.error?.key, 'Stopped with an error');
  const d = fresh({ delivery: 'machine', state: 'starting' });
  runs.processEnded(d, { phase: 'timeout', code: null }, T0 + min);
  assert.equal(d.state, 'failed');
  assert.equal(d.error?.key, 'Stopped at the time limit');
  // a run Lampo sees end by its process never ends by the other rules
  const e = fresh({ delivery: 'machine', state: 'starting' });
  runs.applySign(e, sign(T0, 'fix', words('Fixed {id}', { id: 'c_aaaa01' }), { target: 'c_aaaa01' }));
  runs.applySign(e, sign(T0, 'fix', words('Fixed {id}', { id: 'c_aaaa02' }), { target: 'c_aaaa02' }));
  runs.versionLanded(e, 2, T0);
  runs.applySign(e, sign(T0, 'wait', words('Waiting for your answer')));
  assert.equal(e.ended, null);

  // 2. it waits again after handing back (a version, or every note answered)
  const f = fresh();
  runs.applySign(f, sign(T0, 'read'));
  runs.applySign(f, sign(T0 + 1000, 'wait', words('Waiting for your answer')));
  assert.equal(f.ended, null, 'a wait before handing anything back is listening');
  runs.applySign(f, sign(T0 + 2000, 'reply', words('Replied to {id}', { id: 'c_aaaa01' }), { target: 'c_aaaa01' }));
  runs.applySign(f, sign(T0 + 3000, 'reply', words('Left {id} as it is', { id: 'c_aaaa02' }), { target: 'c_aaaa02' }));
  assert.deepEqual(runs.applySign(f, sign(T0 + 4000, 'wait', words('Waiting for your answer'))), ['ended']);
  assert.equal(f.state, 'done');
  const g = fresh();
  runs.applySign(g, sign(T0, 'upload', words('Uploading a new version'), { progress: { what: 'upload', stage: 'uploading', pct: 40 } }));
  assert.equal(g.progress?.pct, 40);
  runs.versionLanded(g, 3, T0 + 1000);
  assert.equal(g.progress, null, 'the version landed: no progress');
  assert.equal(g.result?.v, 3);
  assert.equal(g.ended, null, 'notes still open: not yet');
  assert.deepEqual(runs.applySign(g, sign(T0 + 2000, 'wait', words('Waiting for your answer'))), ['ended']);
  assert.equal(g.state, 'done');

  // 4. every plan note answered and a version arrived since it opened (whatever comes first)
  const h = fresh();
  runs.applySign(h, sign(T0, 'fix', words('Fixed {id}', { id: 'c_aaaa01' }), { target: 'c_aaaa01' }));
  assert.deepEqual(runs.versionLanded(h, 4, T0 + 1000), []);
  assert.equal(h.plan[0]?.v, 4, 'its fix landed in V4');
  assert.deepEqual(runs.applySign(h, sign(T0 + 2000, 'fix', words('Fixed {id}', { id: 'c_aaaa02' }), { target: 'c_aaaa02' })), ['ended']);
  assert.equal(h.state, 'done');
  assert.deepEqual(h.result && [h.result.v, h.result.fixed, h.result.asked, h.result.wontfix], [4, 2, 0, 0]);
  // … with a question still open, it ends needing the person
  const i = fresh();
  runs.applySign(i, sign(T0, 'fix', words('Fixed {id}', { id: 'c_aaaa01' }), { target: 'c_aaaa01' }));
  runs.applySign(i, sign(T0, 'read', words('Reading note {id}', { id: 'c_aaaa02' }), { target: 'c_aaaa02' }));
  runs.applySign(i, sign(T0, 'ask', words('Asked a question'), { needs: { kind: 'question', note: 'c_dddd01' } }));
  runs.versionLanded(i, 5, T0 + 1000);
  assert.equal(i.state, 'needs_you');
  assert.ok(i.ended);
  assert.equal(i.needs?.note, 'c_dddd01');
});

test('failed from an error; stopped by the person; nothing moves a run that ended', () => {
  const r = fresh();
  runs.applySign(r, sign(T0, 'render', words('Rendering a new version'), { progress: { what: 'render', stage: 'rendering', pct: 50 } }));
  const err = { text: 'The render failed', quote: 'font missing' };
  assert.deepEqual(runs.applySign(r, sign(T0 + 1000, 'error', err)), ['ended']);
  assert.equal(r.state, 'failed');
  assert.deepEqual(r.error, err);
  assert.equal(r.progress, null);
  assert.equal(r.now?.type, 'error');
  assert.deepEqual(runs.applySign(r, sign(T0 + 2000, 'read')), []);
  assert.equal(r.state, 'failed');
  const s = fresh();
  runs.endRun(s, 'stopped', T0);
  assert.equal(s.state, 'stopped');
  runs.endRun(s, 'done', T0 + 1000);
  assert.equal(s.state, 'stopped', 'the first end stays');
});

test('a progress object as callers send it is bounded', () => {
  assert.deepEqual(runs.cleanProgress({ what: 'render', stage: 'rendering', pct: 42.345, frames: [377, 900], eta_s: 61.4, tool: 'remotion', v: 4 }), {
    what: 'render',
    stage: 'rendering',
    pct: 42.3,
    frames: [377, 900],
    eta_s: 61,
    tool: 'remotion',
    v: 4,
  });
  assert.deepEqual(runs.cleanProgress({ what: 'upload', stage: 'a\nvery long stage word indeed, longer', pct: 900, frames: [9, 3], tool: 'rm -rf /' }), {
    what: 'upload',
    stage: 'a ↵ very long stage word',
    pct: null,
  });
  assert.equal(runs.cleanProgress({ what: 'mine', stage: 'x' }), undefined);
  assert.equal(runs.cleanProgress('render'), undefined);
});

test('a version registered while an agent is at the video names its run (and none when nobody began one)', () => {
  const q = fresh({}, Date.now());
  runs.changeRuns(slug, (list) => list.push(q));
  assert.equal(runs.versionRunOf(slug, 'agent:spot-edit'), undefined, 'a queued run makes no version');
  runs.changeRuns(slug, (list) => {
    runs.applySign(list[0] as import('../../lib/runs.ts').StoredRun, sign(Date.now(), 'read'));
  });
  runs.flushRuns(slug);
  assert.equal(runs.versionRunOf(slug, 'agent:spot-edit'), q.id);
  assert.equal(runs.versionRunOf(slug, 'agent:spot-edit · Sam'), q.id, 'by its name, whoever it is listed under');
  // a re-render on disk: the store's own registerVersion stamps it
  fs.copyFileSync(makeVideo(path.join(dir, 'proj/export/spot-v2.mp4'), { dur: 1, pattern: 'rgbtestsrc' }), video);
  age(video);
  const s = store.sync(slug);
  assert.equal(s?.version?.run, q.id);
  assert.equal(store.loadReview(slug)?.versions.at(-1)?.run, q.id);
  runs.changeRuns(slug, (list) => list.splice(0));
  runs.flushRuns(slug);
});

test('the new-notes line: one line, the file’s name as one line, a cursor to read only them; small', () => {
  const line = runs.newNotesLine({ video: 'launch.mp4', timecodes: ['00:00:12', '00:00:21'], since: '2026-10-07T10:00:00Z' });
  assert.equal(line, '2 new notes on launch.mp4 since you started (00:00:12, 00:00:21): get_open_notes since "2026-10-07T10:00:00Z".');
  assert.match(
    runs.newNotesLine({ video: 'Acme\nlaunch.mp4', timecodes: ['00:00:12'], since: 'x' }),
    /^1 new note on Acme ↵ launch\.mp4 since you started \(00:00:12\): get_open_notes/,
  );
  assert.match(runs.newNotesLine({ video: 'launch.mp4', timecodes: ['a', 'b', 'c', 'd', 'e'], since: 'x' }), /\(a, b, c, …\)/);
  assert.ok(approxTokens(line) <= 45, `${approxTokens(line)} tokens`);
  // told once: what it was told of isn't untold again
  const r = fresh();
  runs.applySign(r, sign(T0, 'read'));
  runs.addNotes(r, ['c_eeee01'], T0 + 1500);
  assert.deepEqual(runs.untold(r), { ids: ['c_eeee01'], since: new Date(T0 + 1000).toISOString().replace('.000Z', 'Z') });
  r.clock.told = r.plan.length;
  assert.equal(runs.untold(r), null);
});
