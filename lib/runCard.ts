// Which of a video's runs its places speak of — the library's card (the server's brief), the player's run strip and
// agent button — and the card's brief of it, made one way on the server (lib/runs.ts) and in the player
// (web/src/api/runs.ts, sessions/runWords.ts). Counted with lib/runPlan.ts. Shared with the browser: no Node imports.
import { planTally } from './runPlan.ts';
import { compareTime } from './time.ts';
import type { Run, RunBrief } from './types.ts';

/** What the cards, the sidebar and the board need of a run (RunBrief): the server's library entry and, from the whole
 * run it has, the player's copy of the same card (web/src/api/runs.ts) — one shape from one place. */
export function runBrief(r: Run): RunBrief {
  return {
    id: r.id,
    agent: r.agent,
    state: r.state,
    started: r.started,
    ended: r.ended,
    worked_s: r.worked_s,
    now: r.now,
    ...(r.progress !== undefined ? { progress: r.progress } : {}),
    ...(r.result ? { result: r.result } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(r.needs ? { needs: r.needs } : {}),
    ...(r.stop_pending ? { stop_pending: true } : {}),
    ...planTally(r.plan),
  };
}

/**
 * The run a video's places speak of (its card, the player's strip and agent button): the open one (the newest), else
 * the last that ended within `within` ms. `runs` in the order they were kept (oldest first): of two started in the same
 * second the later one counts, as the server picks it (lib/runs.ts cardRun).
 */
export function runToShow<T extends Pick<Run, 'started' | 'ended'>>(runs: readonly T[], now: number, within: number): T | null {
  let best: T | null = null;
  for (const r of runs) {
    if (r.ended === null) {
      if (!best || best.ended !== null || compareTime(r.started, best.started) >= 0) best = r;
    } else if (now - (Date.parse(r.ended) || 0) <= within && (!best || (best.ended !== null && compareTime(r.ended, best.ended) >= 0))) best = r;
  }
  return best;
}
