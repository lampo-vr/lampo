// The setup's own rules (shared with the browser: the setup screens and the server's routes, never the first paint):
// who a workspace's videos can be for, the role an invite starts with, the website's plan ids, the agents to pick, and
// each setup's steps after Welcome. Where a setup runs and whether it is due stay in lib/onboarding.ts.
import { onlyCreator, type SetupVariant } from './onboarding.ts';
import type { Persona, Role, SetupAgent, SignupPlan } from './types.ts';

/** The kinds a workspace's videos can be for (Persona), in the setup's order; `other` = "Something else". */
export const PERSONAS: readonly Persona[] = ['agency', 'inhouse', 'creator', 'other'];
export const isPersona = (x: unknown): x is Persona => (PERSONAS as readonly unknown[]).includes(x);

/** The role an invite starts with: approvers in an in-house team (without an agency's clients) review; else members. */
export const defaultInviteRole = (personas: readonly Persona[] | undefined): Role =>
  (personas ?? []).includes('inhouse') && !(personas ?? []).includes('agency') ? 'reviewer' : 'member';

/** The plans the website's sign-up links name (`?plan=`); anything else is ignored. */
export const SIGNUP_PLANS: readonly SignupPlan[] = ['cloud-solo', 'cloud-team', 'cloud-business'];
export const isSignupPlan = (x: unknown): x is SignupPlan => (SIGNUP_PLANS as readonly unknown[]).includes(x);

export const SETUP_AGENTS: readonly SetupAgent[] = ['claude-code', 'codex', 'cursor', 'chatgpt', 'claude', 'other', 'none'];
export const isSetupAgent = (x: unknown): x is SetupAgent => (SETUP_AGENTS as readonly unknown[]).includes(x);

/** A setup step after Welcome (web/src/onboarding/Setup.tsx). */
export type SetupStep = 'workspace' | 'persona' | 'project' | 'agent' | 'team' | 'renders' | 'try' | 'health' | 'agents';

/**
 * The setup's steps after Welcome, in order. Every one can be skipped; Back moves within them. Where the work starts
 * from a project, the project comes before the agent: the agent is told to use Lampo for it, and puts up V1 there.
 */
export function setupStepsFor(variant: SetupVariant, personas?: readonly Persona[]): SetupStep[] {
  switch (variant) {
    case 'cloud':
      return ['workspace', 'persona', 'project', 'agent', ...(onlyCreator(personas) ? [] : (['team'] as const))];
    case 'local':
      return ['renders', 'agent', 'try'];
    case 'server':
      return ['workspace', 'health', 'team', 'project', 'agents'];
    case 'invited':
      return ['agent'];
  }
}
