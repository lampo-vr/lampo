// What an agent reads when a workspace's plan refuses something (a billing module's 402: server/extension.ts refusal).
// People in the app read the module's own sentence, with the plan that would fit and the way to it; an agent — an MCP
// tool's answer, a request with an API token, an upload URL handed to one — reads a plain sentence by the refusal's
// reason: what can't be done, and that a person decides. Never a plan's name, a price, a link or a step up: what an
// agent reads it passes on to the person in its own chat, and the chat apps' directories refuse tool answers that sell
// (subscriptions, upgrades, checkout links) or promote. Decided by who reads it (lib/publicError.ts), never by mode.
import { BRAND_NAME } from './brand.ts';
import type { PlanRefusal } from './types.ts';

export type PlanReason = PlanRefusal['reason'];

/** The sentence an agent reads for each reason a plan refuses. */
export const AGENT_PLAN_WORDS: Readonly<Record<PlanReason, string>> = {
  storage: `This workspace has no room for this upload: a person can make room or change the plan in ${BRAND_NAME}.`,
  videos: `This workspace has no room for another video: a person can make room or change the plan in ${BRAND_NAME}.`,
  members: `This workspace has no room for another member: a person can change the plan in ${BRAND_NAME}.`,
  'read-only': `This workspace is read-only for now: a person needs to sort out its plan in ${BRAND_NAME} before this can be done.`,
  payment: `This can't be done now: a person needs to sort out the workspace's billing in ${BRAND_NAME}.`,
};

/** A reason a module may add later: still a plain sentence, never its own words. */
const ANY_REASON = `The workspace's plan doesn't allow this now: a person can change the plan in ${BRAND_NAME}.`;

/** The sentence an agent reads for a refusal's reason. */
export const agentPlanWords = (reason: string): string => (Object.hasOwn(AGENT_PLAN_WORDS, reason) ? AGENT_PLAN_WORDS[reason as PlanReason] : ANY_REASON);

/**
 * The plan's refusal an error is, or carries on (a 402 with a `reason`: server/extension.ts refusal, kept as the cause
 * by `restated` and `failFrom`), with its fields; null for anything else.
 */
export function planRefusalOf(e: unknown): { reason: string; details: Record<string, unknown> } | null {
  let x: unknown = e;
  for (let depth = 0; x && typeof x === 'object' && depth < 5; depth++) {
    const o = x as { status?: unknown; details?: unknown; cause?: unknown };
    const details = o.details && typeof o.details === 'object' ? (o.details as Record<string, unknown>) : null;
    if (o.status === 402 && typeof details?.reason === 'string') return { reason: details.reason, details };
    x = o.cause;
  }
  return null;
}

/**
 * What of a refusal's fields an agent gets beside the sentence: what it was refused for and the numbers (what was
 * asked for, the room the workspace could make) — never the module's sentences in other languages, the next plan up or
 * the step that would fit (`messages`, `upgrade`, `fits`: the limit sheet a person reads in the app).
 */
export function agentPlanDetails(details: Record<string, unknown>): Record<string, unknown> {
  const { reason, needed, room } = details;
  return { reason, ...(needed !== undefined ? { needed } : {}), ...(room !== undefined ? { room } : {}) };
}

/** An error's text as an agent reads it: a plan's refusal in plain words, anything else as `otherwise` says it. */
export const agentText = (e: unknown, otherwise: string): string => {
  const refusal = planRefusalOf(e);
  return refusal ? agentPlanWords(refusal.reason) : otherwise;
};
