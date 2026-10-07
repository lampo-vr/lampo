// Real-shaped agent work on one video, in every state of the experience (design §5.2): what the server's runs API
// answers (lib/types.ts Run, RunStepLine). The styleguide shows each state with it, and the browser suite
// (test/e2e/agent-runs.mjs) answers the runs API with it, so every state can be looked at, at every width, without an
// agent. Types only: Node imports this file as it is.
import type { Run, RunPlanItem, RunStepLine } from '../../../lib/types.ts';

/** The states, in the order the table lists them (ready and unreachable have no run: the strip's idle words). */
export const RUN_STATES = [
  'queued',
  'starting',
  'working',
  'thinking',
  'quiet',
  'rendering',
  'uploading',
  'needs_you',
  'permission',
  'done',
  'failed',
  'stopped',
  'lost',
] as const;
export type RunStateName = (typeof RUN_STATES)[number];

export interface RunFixture {
  run: Run;
  steps: RunStepLine[];
}

const iso = (now: number, secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString();

/**
 * One run per state on the video `slug`, its plan the notes `notes` (the first six are sent; a seventh, when there is
 * one, was added while it worked). `v`: the video's newest version (the run makes the next one).
 */
export function runFixtures(slug: string, notes: string[], v: number, now = Date.now()): Record<RunStateName, RunFixture> {
  const sent = notes.slice(0, 6);
  const plan = (states: RunPlanItem['state'][]): RunPlanItem[] => [
    ...sent.map((id, i) => ({ id, state: states[i] ?? 'todo', at: iso(now, 60 * (6 - i)), ...(states[i] === 'fixed' ? { v: v + 1 } : {}) })),
    ...(notes[6] ? [{ id: notes[6], state: 'todo' as const, added: true }] : []),
  ];
  const base = (id: string, over: Partial<Run>): Run => ({
    id: `run_${id}`,
    slug,
    agent: { name: 'Claude Code', kind: 'claude-code', session_id: 'b6f1c2d0-3e4a-4f7b-9c1d-2a8e5f6b7c90' },
    opened_by: { who: 'Sam', how: 'send' },
    delivery: 'listening',
    state: 'working',
    started: iso(now, 372),
    ended: null,
    seen: iso(now, 20),
    worked_s: 372,
    plan: plan(['fixed', 'fixed', 'doing']),
    now: { text: 'Editing src/Logo.tsx', key: 'Editing {file}', vars: { file: 'src/Logo.tsx' }, type: 'action', at: iso(now, 20) },
    ...over,
  });
  // what a working agent's steps look like, newest first (Lampo's own calls and what it said)
  const steps = (extra: RunStepLine[] = []): RunStepLine[] => [
    ...extra,
    { text: 'Editing src/Logo.tsx', key: 'Editing {file}', vars: { file: 'src/Logo.tsx' }, type: 'action', at: iso(now, 20) },
    { text: 'the spring is too slow; moving the entry to frame 300', type: 'thought', at: iso(now, 64) },
    { text: 'Running npm test', key: 'Running {command}', vars: { command: 'npm test' }, type: 'action', at: iso(now, 130) },
    { text: 'Looking at frame 525', key: 'Looking at frame {frame}', vars: { frame: 525 }, type: 'action', at: iso(now, 170) },
    {
      text: 'Fixed a note',
      key: 'Fixed {id}',
      vars: { id: sent[1] ?? '' },
      quote: 'caption moved to y 1392',
      type: 'action',
      target: sent[1] ?? null,
      at: iso(now, 210),
    },
    {
      text: 'Fixed a note',
      key: 'Fixed {id}',
      vars: { id: sent[0] ?? '' },
      quote: 'typo in the title',
      type: 'action',
      target: sent[0] ?? null,
      at: iso(now, 250),
    },
    { text: 'Reading the playbook', key: 'Reading the playbook', type: 'action', at: iso(now, 300) },
    { text: 'Reading the open notes', key: 'Reading the open notes', type: 'action', at: iso(now, 340) },
    { text: 'I’ll go through your six notes, then render V4.', type: 'thought', at: iso(now, 360) },
    { text: 'Watching for feedback', key: 'Watching for feedback', type: 'action', at: iso(now, 372) },
  ];
  const progress = (what: 'render' | 'upload', pct: number) => ({
    what,
    stage: what === 'render' ? 'rendering' : 'uploading',
    pct,
    ...(what === 'render' ? { frames: [Math.round(9 * pct), 900] as [number, number], eta_s: 70, tool: 'remotion' } : {}),
    v: v + 1,
  });
  const renderStep: RunStepLine = { text: 'Rendering a new version', key: 'Rendering a new version', type: 'progress', at: iso(now, 8) };
  return {
    queued: {
      run: base('queued', { state: 'queued', started: iso(now, 12), seen: iso(now, 12), worked_s: 0, plan: plan([]), now: null }),
      steps: [],
    },
    starting: {
      run: base('starting', {
        state: 'starting',
        delivery: 'runner',
        agent: { name: 'Claude Code', kind: 'claude-code', runner: 'Studio Mac' },
        started: iso(now, 3),
        seen: iso(now, 3),
        worked_s: 0,
        plan: plan([]),
        now: null,
      }),
      steps: [],
    },
    working: { run: base('working', {}), steps: steps() },
    thinking: {
      run: base('thinking', {
        now: { text: 'the spring is too slow; moving the entry to frame 300', type: 'thought', at: iso(now, 6) },
      }),
      steps: steps([{ text: 'the spring is too slow; moving the entry to frame 300', type: 'thought', at: iso(now, 6) }]),
    },
    // an agent Lampo hears only through its calls, editing between them: the last thing known, and when
    quiet: {
      run: base('quiet', {
        delivery: 'listening',
        plan: plan(['doing']),
        worked_s: 270,
        now: { text: 'Reading the open notes', key: 'Reading the open notes', type: 'action', at: iso(now, 240) },
        seen: iso(now, 240),
      }),
      steps: steps().slice(-3),
    },
    rendering: {
      run: base('rendering', { plan: plan(['fixed', 'fixed', 'fixed', 'fixed', 'fixed', 'asked']), progress: progress('render', 42) }),
      steps: steps([renderStep]),
    },
    uploading: {
      run: base('uploading', { plan: plan(['fixed', 'fixed', 'fixed', 'fixed', 'fixed', 'asked']), progress: progress('upload', 80) }),
      steps: steps([{ ...renderStep, text: 'Uploading a new version', key: 'Uploading a new version' }]),
    },
    needs_you: {
      run: base('needs_you', {
        state: 'needs_you',
        plan: plan(['fixed', 'fixed', 'fixed', 'asked']),
        needs: { kind: 'question', note: sent[3] },
        now: { text: 'Asked a question', key: 'Asked a question', type: 'elicitation', at: iso(now, 40) },
      }),
      steps: steps([{ text: 'Asked a question', key: 'Asked a question', type: 'elicitation', target: sent[3] ?? null, at: iso(now, 40) }]),
    },
    permission: {
      run: base('permission', {
        state: 'needs_you',
        delivery: 'machine',
        plan: plan(['fixed', 'fixed', 'doing']),
        needs: { kind: 'permission', text: { text: 'to run npx remotion render' } },
        now: { text: 'Running npx remotion render', key: 'Running {command}', vars: { command: 'npx remotion render' }, type: 'elicitation', at: iso(now, 30) },
      }),
      steps: steps(),
    },
    done: {
      run: base('done', {
        state: 'done',
        ended: iso(now, 30),
        worked_s: 720,
        plan: plan(['fixed', 'fixed', 'fixed', 'fixed', 'fixed', 'asked']),
        now: { text: 'Put a new version up for review', key: 'Put a new version up for review', type: 'response', at: iso(now, 30) },
        result: {
          v: v + 1,
          fixed: 5,
          asked: 1,
          wontfix: 0,
          summary: 'V4: the logo’s entry is a spring now, captions sit at y 1392, the music dips under the voice.',
          tokens: { input: 48200, output: 6100, cache_read: 310000, cache_write: 12400 },
          cost_usd: 0.84,
        },
      }),
      steps: steps([{ text: 'Put a new version up for review', key: 'Put a new version up for review', type: 'response', at: iso(now, 30) }]),
    },
    failed: {
      run: base('failed', {
        state: 'failed',
        ended: iso(now, 95),
        worked_s: 410,
        plan: plan(['fixed', 'fixed', 'fixed']),
        error: { text: 'the render failed at frame 312: the font “Inter Display” is missing' },
        now: { text: 'the render failed at frame 312: the font “Inter Display” is missing', type: 'error', at: iso(now, 95) },
        log: true,
      }),
      steps: steps([{ text: 'the render failed at frame 312: the font “Inter Display” is missing', type: 'error', at: iso(now, 95) }]),
    },
    stopped: {
      run: base('stopped', { state: 'stopped', ended: iso(now, 50), worked_s: 240, plan: plan(['fixed', 'doing']) }),
      steps: steps().slice(-6),
    },
    lost: {
      run: base('lost', {
        state: 'lost',
        delivery: 'listening',
        worked_s: 300,
        plan: plan(['fixed', 'doing']),
        seen: iso(now, 22 * 60),
        now: { text: 'Reading the open notes', key: 'Reading the open notes', type: 'action', at: iso(now, 22 * 60) },
      }),
      steps: steps().slice(-4),
    },
  };
}
