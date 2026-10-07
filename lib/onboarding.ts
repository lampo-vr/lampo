// The first run: what a new account learns by doing, as steps that tick themselves off from real state — a video in
// the library, a note on a frame, an agent that talked to Lampo, a review link, an invite — never from a click on the
// list. The server finds the facts (server/routes/onboarding.ts) and records each step the first time it sees it done
// (UserPrefs.onboarding), so deleting a video later doesn't take a tick back. Accounts made before the first run
// existed have no `onboarding` and count as done: someone who already uses Lampo never sees it. A new account also
// gets the setup (Welcome and a few skippable steps, `setupStepsFor`) on its first visit: `setup_due` until it is over.
// Browser-safe: the account menu counts with it, the server records with it.
import type { OnboardingPrefs, OnboardingStep, Persona, Review, Role } from './types.ts';

/** The picks that are one of the three kinds, in the order they were picked ("Something else" kept apart). */
export const personaKinds = (personas: readonly Persona[] | undefined): Persona[] => (personas ?? []).filter((k) => k !== 'other');

/** Videos for a channel and nothing else: no team to invite (the Team step and Get started's invite drop out). */
export const onlyCreator = (personas: readonly Persona[] | undefined): boolean => {
  const kinds = personaKinds(personas);
  return kinds.length > 0 && kinds.every((k) => k === 'creator') && !(personas ?? []).includes('other');
};

/**
 * Where a new account's setup runs, and so which steps it has:
 * - `cloud`: the owner of a workspace made at their own sign-up (Lampo Cloud, any server open to sign-ups);
 * - `server`: whoever runs a hosted server (lib/operator.ts), as an owner or admin of its first workspace (a
 *   self-hosted server, its setup page);
 * - `local`: the app on the person's own machine (signed in as its owner, no account steps);
 * - `invited`: anyone who joined someone else's workspace (the owner answered the workspace's questions) — also an
 *   admin or owner invited into a server's first workspace: the server's setup is its own owner's, never theirs.
 */
export type SetupVariant = 'cloud' | 'server' | 'local' | 'invited';

export function setupVariant({
  role,
  machine,
  signupWorkspace,
  firstWorkspace,
  invited = false,
  operator = false,
}: {
  role: Role;
  machine: boolean;
  signupWorkspace: boolean;
  /** The request's workspace is the server's first (`w1`, the one its setup page made). */
  firstWorkspace: boolean;
  /** The account joined that workspace through an invite (MyWorkspace.invited). */
  invited?: boolean;
  /** The account runs the server (/api/auth/status `operator`): the server's setup is theirs alone. */
  operator?: boolean;
}): SetupVariant {
  if (machine) return 'local';
  if (invited) return 'invited';
  if (role === 'owner' && signupWorkspace) return 'cloud';
  if (operator && (role === 'owner' || role === 'admin') && firstWorkspace && !signupWorkspace) return 'server';
  return 'invited';
}

/** Whether the setup shows on this visit: due since the account was made, not yet finished or skipped. */
export const setupDue = (o: OnboardingPrefs | null | undefined): boolean => !!o?.setup_due && !o.setup_done;

/**
 * Get started's steps for an account in the workspace it works in, in order:
 * - reviewers: the sample (a fix to check, a question to answer), a note of their own, an approval;
 * - members: the sample, their agent, a first video, a review link;
 * - owners and admins add the invite — at the machine there is nobody to invite (and its renders are linked, so the
 *   video comes before the agent); in a workspace made at sign-up (`signupWorkspace`, Cloud) the personas order it:
 *   in-house teams invite before they upload, a channel alone invites nobody; on a self-hosted server the team's
 *   first video comes before the agents and the invites.
 */
export function stepsFor(
  role: Role,
  { machine = false, signupWorkspace = false, personas }: { machine?: boolean; signupWorkspace?: boolean; personas?: readonly Persona[] } = {},
): OnboardingStep[] {
  if (role === 'reviewer') return ['sample', 'note', 'approve'];
  if (role === 'member') return ['sample', 'agent', 'video', 'share'];
  if (machine) return ['sample', 'video', 'agent', 'share'];
  if (signupWorkspace) {
    if (onlyCreator(personas)) return ['sample', 'agent', 'video', 'share'];
    if ((personas ?? []).includes('inhouse')) return ['sample', 'agent', 'invite', 'video', 'share'];
    return ['sample', 'agent', 'video', 'share', 'invite'];
  }
  return ['sample', 'video', 'agent', 'invite', 'share'];
}

/** What the server found done right now (each true fact ticks its step). */
export type OnboardingFacts = Partial<Record<OnboardingStep, boolean>>;

/** A new account's first run: Get started, and the setup on its first visit. */
export const startOnboarding = (now: string): OnboardingPrefs => ({ since: now, setup_due: true });

/**
 * The first run with every step found done recorded (the first time is kept) and, once every step of `steps` is,
 * `complete`. The same object when nothing changed, so the caller writes only when something did.
 */
export function recordFacts(o: OnboardingPrefs, steps: readonly OnboardingStep[], facts: OnboardingFacts, now: string): OnboardingPrefs {
  const done = { ...o.done };
  let changed = false;
  for (const s of steps)
    if (facts[s] && !done[s]) {
      done[s] = now;
      changed = true;
    }
  const finished = !o.complete && steps.length > 0 && steps.every((s) => done[s]);
  if (!changed && !finished) return o;
  return { ...o, ...(changed ? { done } : {}), ...(finished ? { complete: now } : {}) };
}

export interface StepState {
  id: OnboardingStep;
  done: boolean;
}

/** The steps as recorded, in order. */
export const stateOf = (o: OnboardingPrefs | null | undefined, steps: readonly OnboardingStep[]): StepState[] =>
  steps.map((id) => ({ id, done: !!o?.done?.[id] }));

/** The first step not done yet (null when all are). */
export const nextOf = (steps: readonly StepState[]): OnboardingStep | null => steps.find((s) => !s.done)?.id ?? null;

/** How far along: done of all. */
export const progressOf = (steps: readonly StepState[]): { done: number; of: number } => ({
  done: steps.filter((s) => s.done).length,
  of: steps.length,
});

/** Shown: an account with a first run it hasn't put away. A finished one shows once more, to say so, until closed. */
export const showsOnboarding = (o: OnboardingPrefs | null | undefined): o is OnboardingPrefs => !!o && !o.hidden && !o.dismissed;

/**
 * The sidebar's row ("Get started · 2 of 5"): while a step is open, unless hidden for good. The card's × leaves it (the
 * row is how the card comes back to mind without the card).
 */
export const inSidebar = (o: OnboardingPrefs | null | undefined): o is OnboardingPrefs => !!o && !o.complete && !o.dismissed;

/** The account menu offers it (again) while a step is open, even hidden for good: the one quiet way back. */
export const resumable = (o: OnboardingPrefs | null | undefined): o is OnboardingPrefs => !!o && !o.complete;

/** The first run's sample video (Review.onboarding_sample): never a real video for the steps, billing or limits. */
export const isSample = (r: Pick<Review, 'onboarding_sample'>): boolean => !!r.onboarding_sample;

/** What an agent may work on: never the sample, a demo for the person (sweep 3 ONB-5). For agents' listings. */
export const forAgents = <T extends Pick<Review, 'onboarding_sample'>>(reviews: T[]): T[] => reviews.filter((r) => !r.onboarding_sample);

/** The line an agent reads first when it asks for the sample by name or id. */
export const SAMPLE_FOR_AGENTS = 'SAMPLE: the onboarding sample, a demo for the person in the app; not work: fix nothing, render nothing, answer nothing.';
