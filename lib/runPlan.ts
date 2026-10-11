// How far an agent's work on a video is, counted one way wherever it is shown — the cards' brief and the inbox's
// (lib/runs.ts, lib/foryou.ts), the player's run strip, agent button and Agent view, the library's cards and the
// sidebar (web/src/sessions/runState.ts). A card and the player read different answers (the brief's counts, the whole
// run's plan); counted here, the same moment says the same words in both. Which run they speak of, and the card's
// brief of it: lib/runCard.ts (apart, so the library's first paint carries only the count). Shared with the browser.
import type { RunPlanItem, RunPlanState } from './types.ts';

/** A plan note the agent answered: fixed, asked the person about, left as it is, or replied to. */
const ANSWERED: ReadonlySet<RunPlanState> = new Set<RunPlanState>(['fixed', 'asked', 'wontfix', 'replied']);
export const isAnswered = (p: Pick<RunPlanItem, 'state'>): boolean => ANSWERED.has(p.state);

/** A plan in counts, as the brief carries it (RunBrief `planned`, `answered`). */
export interface PlanTally {
  planned: number;
  answered: number;
}
export const planTally = (plan: readonly Pick<RunPlanItem, 'state'>[]): PlanTally => ({ planned: plan.length, answered: plan.filter(isAnswered).length });

/**
 * The note the agent is on while it works ("fixing 3 of 6"): the one after those it answered. Never one more per note
 * in hand (`doing`): an agent reads every note before it fixes one, and each stays in hand until answered — counted
 * so, the player said "fixing 5 of 5" while nothing was done and the card, which has no `doing`, said "fixing 1 of 5".
 */
export const noteOn = (t: PlanTally): number => Math.min(t.planned, t.answered + 1);
