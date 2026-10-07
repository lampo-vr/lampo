// The first run's light half: whether it shows, read from the account the server sent at sign-in (no request of its
// own, so the library's first paint knows), and the way to the rest — Get started's own chunk (GetStarted.tsx) with
// its data (data.ts), and the setup a new account sees first (Setup.tsx: Welcome and a few skippable steps). Steps tick
// from what the server finds done (lib/onboarding.ts).
import type { CSSProperties } from 'react';
import { inSidebar, nextOf, type SetupVariant, type StepState, setupDue, setupVariant, showsOnboarding, stateOf, stepsFor } from '../../../lib/onboarding.ts';
import type { AuthStatus, OnboardingPrefs, Persona } from '../../../lib/types.ts';
import { useAuthStatus } from '../api/auth.ts';
import { chromeFirstRun, chromeStart } from '../lib/chromeHint.ts';
import { loader } from '../lib/lazy.ts';

/** Get started, its panes and their data: loaded when the first run shows (or is asked for). */
export const getStartedCode = loader(() => import('./GetStarted.tsx'));

/** Get started folded to one line, in this browser (GetStarted.tsx keeps it): the card and its room agree. */
export const FOLD = 'vr.gs.fold';
export const readFold = (): boolean => {
  try {
    return localStorage.getItem(FOLD) === '1';
  } catch {
    return false;
  }
};

/** An agent picked and not connected yet: Get started's agent step holds its connect form (a taller pane). */
export const connecting = (agent: OnboardingPrefs['agent'] | null | undefined, steps: readonly StepState[]): boolean =>
  !!agent && agent !== 'none' && steps.some((s) => s.id === 'agent' && !s.done);

/**
 * The room Get started keeps while its code arrives: the card's own height, by the same CSS (onboarding.css) — folded
 * or open, with the machine's foot, and on a phone with its number of steps.
 */
export const roomOf = (run: FirstRun, foot: boolean) => ({
  className: `ob-gs ob-pending${readFold() ? ' ob-fold' : ''}${foot ? ' ob-foot' : ''}${connecting(run.o?.agent, run.steps) ? ' ob-tall' : ''}`,
  style: { '--gs-n': run.steps.length || 5 } as CSSProperties,
});

export interface FirstRun {
  /** The account's first run as last heard (null: an account from before it, which never sees one). */
  o: OnboardingPrefs | null;
  /** It shows: there is one and it isn't put away. */
  shown: boolean;
  /**
   * The sidebar's row shows (lib/onboarding.ts inSidebar: steps open, not hidden for good, the setup over) — before the
   * server has answered: it showed in this browser last time (its room from the first paint, lib/chromeHint.ts).
   */
  side: boolean;
  steps: StepState[];
  next: StepState['id'] | null;
  /** The setup is due: a new account that hasn't finished or skipped it (it shows instead of the library). */
  setup: boolean;
  /** Where the setup runs (which steps it has), from the session's role, place and workspace. */
  variant: SetupVariant;
  /** Who the workspace's videos are for (its owner's picks in the setup). */
  personas: Persona[];
}

/** Where a session's setup runs: the machine, a workspace made at its owner's sign-up, a server's first workspace. */
export const variantOf = (status: AuthStatus | undefined): SetupVariant =>
  setupVariant({
    role: status?.user?.role ?? 'member',
    machine: status?.via === 'local',
    signupWorkspace: !!status?.workspace?.signup,
    firstWorkspace: !status?.workspace || status.workspace.id === 'w1',
    invited: !!status?.workspace?.invited,
    operator: !!status?.operator,
  });

/** Accounts whose setup ended in this tab (finished or skipped). Whatever is read before the server has taken the end
 * — a status, Get started's answer — still says it's due; it must not send the person back to Welcome. */
const setupEndedHere = new Set<string>();
export const endSetupHere = (userId: string | undefined): void => {
  if (userId) setupEndedHere.add(userId);
};

/** The signed-in account's first run, from what the server said about the account (before it has: whether it showed
 * in this browser last time, so Get started's room is there from the first paint). */
export function useFirstRun(): FirstRun {
  const status = useAuthStatus().data;
  const user = status?.user;
  const o = user?.prefs?.onboarding ?? null;
  const personas = status?.workspace?.personas ?? [];
  // the role in the workspace this session works in (/api/auth/status says it), and whether that one was made at sign-up
  const steps = user && o ? stateOf(o, stepsFor(user.role, { machine: status?.via === 'local', signupWorkspace: !!status?.workspace?.signup, personas })) : [];
  const setup = !!user && setupDue(o) && !setupEndedHere.has(user.id);
  return {
    o,
    shown: status ? showsOnboarding(o) : chromeFirstRun(),
    side: status ? !!user && inSidebar(o) && !setup && steps.length > 0 : chromeStart(),
    steps,
    next: nextOf(steps),
    setup,
    variant: variantOf(status),
    personas,
  };
}
