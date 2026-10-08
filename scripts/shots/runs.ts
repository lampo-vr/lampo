// Synthetic agent work for the pictures, where a real agent would need the clock to pass: an agent that was sent notes,
// began on them and then went quiet half an hour ago, so the Inbox lists it under Stalled ("No word from …") and its
// card and sidebar row say so. Everything else an agent does in the pictures is done for real (`lampo` as the agent,
// MCP clients, `lampo render` with the stand-in render tool); this one run is written as the server keeps runs
// (lib/runs.ts: one JSON line per run in data/<slug>/runs.jsonl, its head, steps and clock), in the shape and by the
// rules it has there: lost 20 minutes after its last sign, closed an hour after that. The server reads the file the
// next time it looks at the video's runs (a file that changed is read again), so it is written while nothing else
// writes them: a video no agent has touched yet. Made-up names, no real agent behind it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isoLocal } from '../../lib/paths.ts';
import type { AgentKind, Run, RunStepLine } from '../../lib/types.ts';

export interface QuietRun {
  /** The store's data folder and the video's slug. */
  data: string;
  slug: string;
  agent: { name: string; kind: AgentKind; session_id?: string };
  /** Who sent the notes. */
  by: string;
  /** The notes sent (the first is the one it was reading when it went quiet), with their frames. */
  notes: { id: string; frame: number }[];
  /** Minutes since the notes were sent, and since the agent was last heard from. */
  sentMin: number;
  quietMin: number;
}

/** Writes the run; its id. */
export function writeQuietRun(o: QuietRun, now = Date.now()): string {
  const at = (min: number) => isoLocal(new Date(now - min * 60_000));
  const began = o.sentMin - 2;
  const [first, ...rest] = o.notes;
  const steps: RunStepLine[] = [
    { text: 'Reading the open notes', key: 'Reading the open notes', type: 'action', at: at(began) },
    { text: `Looking at frame ${first.frame}`, key: 'Looking at frame {frame}', vars: { frame: first.frame }, type: 'action', at: at(began - 3) },
    { text: 'Reading a note', key: 'Reading note {id}', vars: { id: first.id }, type: 'action', target: first.id, at: at(o.quietMin) },
  ];
  const run: Run & { steps: RunStepLine[]; clock: Record<string, unknown> } = {
    id: `run_${crypto.randomBytes(6).toString('hex')}`,
    slug: o.slug,
    agent: o.agent,
    opened_by: { who: o.by, how: 'send' },
    delivery: 'listening',
    state: 'lost',
    started: at(o.sentMin),
    ended: null,
    seen: at(o.quietMin),
    worked_s: Math.round((began - o.quietMin) * 60),
    plan: [{ id: first.id, state: 'doing', at: at(o.quietMin) }, ...rest.map((n) => ({ id: n.id, state: 'todo' as const, at: at(o.sentMin) }))],
    now: { ...(steps.at(-1) as RunStepLine) },
    steps,
    // lost 20 minutes after its last sign (RUN_TIMES.lostCalls), the time it worked counted up to that sign
    clock: { tick: at(o.quietMin), lost: at(o.quietMin - 20), began: at(began), told: o.notes.length, owner: '' },
  };
  const dir = path.join(o.data, o.slug);
  const file = path.join(dir, 'runs.jsonl');
  const tmp = path.join(dir, `.runs.jsonl.${process.pid}`);
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.writeFileSync(tmp, `${before}${JSON.stringify(run)}\n`);
  fs.renameSync(tmp, file);
  return run.id;
}
