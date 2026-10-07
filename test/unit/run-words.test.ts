// What an agent's work on a video says (web/src/sessions/runState.ts, runWords.ts): the strip's words, glyph and
// actions in every state of the design's table, the cards' word or two, the plan's line under a note, who made a
// version — never an id, never a noun for the work itself — from the same real-shaped work the styleguide and the
// browser suite show (web/src/styleguide/runStates.ts).
import assert from 'node:assert/strict';
import test from 'node:test';
import type { RunPlanItem } from '../../lib/types.ts';
import { cardRun, edgeOf, fullWords, isOpen, mostUrgent, ownWords, phaseOf, shortLine, stateWords, tightOf } from '../../web/src/sessions/runState.ts';
import { clock, idleSaid, madeBy, planSaid, runSaid, workedNow } from '../../web/src/sessions/runWords.ts';
import { RUN_STATES, runFixtures } from '../../web/src/styleguide/runStates.ts';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const notes = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'];
const f = runFixtures('launch', notes, 3, NOW);
const say = (w: { text: string }) => w.text;
const said = (k: (typeof RUN_STATES)[number], toCheck = 0) => runSaid(f[k].run, { now: NOW, asOf: NOW, say, toCheck });

test('every state says what happens, with its glyph and only the actions it offers', () => {
  const want: Record<(typeof RUN_STATES)[number], [string, string, string[]]> = {
    queued: ['Sent to Claude Code · waiting for it to start', 'outline', ['cancel']],
    starting: ['Starting Claude Code on Studio Mac', 'ease', ['stop']],
    working: ['Claude Code · fixing 3 of 7 · Editing src/Logo.tsx', 'ease', ['stop']],
    thinking: ['Claude Code · fixing 3 of 7 · “the spring is too slow; moving the entry to frame 300”', 'ease', ['stop']],
    quiet: ['Claude Code · fixing 1 of 7 · last: Reading the open notes · 4 min ago', 'ease', ['stop']],
    rendering: ['Claude Code · rendering V4 · about 1 min left', 'ease', ['stop']],
    uploading: ['Claude Code · uploading V4', 'ease', []],
    needs_you: ['Claude Code · needs you · a question', 'diamond', ['answer']],
    permission: ['Claude Code · needs permission · to run npx remotion render', 'diamond', ['allow']],
    done: ['V4 is ready · 5 fixed · 1 asked · 12 min', 'half', ['check']],
    failed: ['Claude Code · stopped · the render failed at frame 312: the font “Inter Display” is missing', 'hold', ['log', 'retry']],
    stopped: ['Stopped after 4 min', 'hold', ['again']],
    lost: ['No word from Claude Code for 22 min', 'outline', ['nudge', 'stop']],
  };
  for (const k of RUN_STATES) {
    const s = said(k, 5);
    const line = [s.name, s.words].filter(Boolean).join(' · ');
    assert.equal(line, want[k][0], k);
    assert.equal(s.shape, want[k][1], `${k}: glyph`);
    assert.deepEqual(s.actions, want[k][2], `${k}: actions`);
    // no id and no noun for the work, ever
    assert.doesNotMatch(line, /run_|\b(a|the|this) run\b|session/i, k);
  }
  // done offers Check fixes only while there are fixes to check
  assert.deepEqual(said('done', 0).actions, []);
});

test('a render says how far it is, never cut, and its edge fills; the clock counts on while it works', () => {
  const r = said('rendering');
  assert.equal(r.figure, '42%');
  assert.equal(r.edge, 0.42);
  assert.equal(edgeOf(f.uploading.run), 0.8);
  assert.equal(edgeOf(f.working.run), null);
  assert.equal(said('working').figure, '6:12');
  // ten seconds after the answer, the clock says ten seconds more; waiting for you doesn't count
  assert.equal(runSaid(f.working.run, { now: NOW + 10_000, asOf: NOW, say }).figure, '6:22');
  assert.equal(workedNow(f.needs_you.run, NOW + 600_000, NOW), f.needs_you.run.worked_s);
  assert.equal(clock(3725), '1:02:05');
  // without the agent's own words loaded (a card before its code), the line is the state alone
  assert.equal(runSaid(f.working.run, { now: NOW }).words, 'fixing 3 of 7');
});

test('the cards: a word or two, the work that matters most for an agent, and which work a card speaks of', () => {
  assert.equal(shortLine(f.rendering.run), 'rendering 42%');
  assert.equal(shortLine(f.needs_you.run), 'needs you');
  assert.equal(shortLine(f.done.run), 'V4 is ready');
  assert.equal(shortLine(f.lost.run), 'no word');
  assert.equal(phaseOf(f.uploading.run), 'uploading');
  assert.equal(mostUrgent([f.working.run, f.rendering.run, f.needs_you.run, f.done.run])?.state, 'needs_you');
  assert.equal(mostUrgent([f.done.run, f.rendering.run])?.id, f.rendering.run.id);
  assert.equal(isOpen(f.lost.run), true);
  assert.equal(isOpen(f.stopped.run), false);
  const summary = (run: unknown, stage = 'in_progress') => ({ run, stage: { stage } }) as unknown as Parameters<typeof cardRun>[0];
  assert.equal(cardRun(summary(undefined)), null, 'an older server: no runs');
  assert.equal(cardRun(summary(f.failed.run))?.state, 'failed');
  assert.equal(cardRun(summary(f.done.run, 'check_fixes'))?.state, 'done', 'done while its fixes wait');
  assert.equal(cardRun(summary(f.done.run, 'team_approved')), null, 'done and checked: the card says the stage again');
});

test('the agent with no work going on: ready, or not running with a way to start it', () => {
  assert.equal(idleSaid('Codex', true, true).words, 'ready · gets your notes when you send');
  const away = idleSaid('Codex', false, true);
  assert.equal(away.words, 'Codex isn’t running · start it');
  assert.deepEqual(away.actions, ['copy']);
  assert.deepEqual(idleSaid('Codex', false, false).actions, []);
});

test('a note’s plan line: nothing before the agent reaches it, then on it, fixed in a version, asked, left', () => {
  const line = (p: Partial<RunPlanItem>) => planSaid({ id: 'n', state: 'todo', ...p }, 'Claude Code', 3)?.words ?? null;
  assert.equal(line({}), null);
  assert.equal(line({ added: true }), 'added while it works');
  assert.equal(line({ state: 'doing' }), 'Claude Code is on it');
  assert.equal(line({ state: 'fixed' }), 'fixed · the version is coming');
  assert.equal(line({ state: 'fixed', v: 4 }), 'fixed · in V4');
  assert.equal(line({ state: 'fixed', v: 3 }), 'fixed in V3 · check it');
  assert.equal(line({ state: 'asked' }), 'asked you');
  assert.equal(line({ state: 'wontfix' }), 'left as it is');
});

test('who made a version: the agent, in how long, what it fixed', () => {
  assert.equal(madeBy(f.done.run), 'Claude Code · 12 min · 5 fixed · 1 asked');
});

test('a permission as the server says it: what it needs to run, once; a stopped agent that listens notices at its next step', () => {
  const needs = {
    kind: 'permission' as const,
    text: { text: 'Needs permission to run npx remotion render', key: 'Needs permission to run {command}', vars: { command: 'npx remotion render' } },
    allow: 'Bash(npx remotion render:*)',
  };
  const p = runSaid({ ...f.permission.run, needs }, { now: NOW, asOf: NOW, say });
  assert.equal(
    [p.name, p.words].join(' · '),
    'Claude Code · needs permission to run npx remotion render',
    'said once, never “needs permission · Needs permission”',
  );
  assert.deepEqual(p.actions, ['allow']);
  const s = runSaid({ ...f.stopped.run, stop_pending: true }, { now: NOW, asOf: NOW, say });
  assert.equal(s.words, 'Stopped · it will notice at its next step');
  assert.equal(runSaid(f.stopped.run, { now: NOW, asOf: NOW, say }).words, 'Stopped after 4 min', 'heard, or one Lampo ran: as before');
});

test('tight places say the state in a word or two and the figure, never the agent’s own sentence; the title says it whole', () => {
  // what an agent says with set_status / `vr status`: a version and a stage in its own words, longer than a tight place
  const long = 'rendering v2 (notes and b-roll from the content folder, then the end card)';
  const thought = { ...f.thinking.run, now: { text: long, type: 'thought' as const, at: new Date(NOW - 6000).toISOString() } };
  assert.deepEqual(tightOf(thought), { words: 'fixing 3 of 7', figure: null }, 'the state, never “rendering v2 (…”');
  // a render that says how far: its version in Lampo’s words, the figure beside the words (never inside, never cut)
  assert.deepEqual(tightOf(f.rendering.run), { words: 'rendering V4', figure: '42%' });
  assert.deepEqual(tightOf(f.uploading.run), { words: 'uploading V4', figure: '80%' });
  const unknown = { ...f.rendering.run, progress: { what: 'render' as const, stage: 'rendering', pct: 42 } };
  assert.equal(stateWords(unknown), 'rendering', 'no version known: none said');
  assert.equal(tightOf(f.needs_you.run).words, 'needs you');
  // the agent's own words, for the lines that have room and for titles: what it said quoted, as it wrote it ("v2")
  assert.equal(ownWords(thought), `“${long}”`, 'a thought needs none of the UI’s words');
  assert.equal(ownWords(f.working.run), null, 'a step needs them: left out until they are here');
  assert.equal(ownWords(f.working.run, say), 'Editing src/Logo.tsx');
  assert.equal(ownWords(f.failed.run), 'the render failed at frame 312: the font “Inter Display” is missing');
  assert.equal(ownWords(f.rendering.run, say), null, 'a render says how far it is, not the step before it');
  assert.equal(fullWords(thought), `fixing 3 of 7 · “${long}”`);
  assert.equal(fullWords(f.rendering.run, say), 'rendering V4 · 42%');
});
