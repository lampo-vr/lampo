// Who runs a hosted server: its operator, the one person (or few) for whom the server is more than a workspace — the
// funnel, every workspace with its plan, every account (server/routes/operator.ts, web/src/operator/), the server's own
// health check and test mail (server/routes/serverHealth.ts), the speech engine's model path and last error
// (/api/info), new workspaces without a limit (lib/workspaces.ts), the server's setup (lib/onboarding.ts). LAMPO_OPERATOR
// names them by address or account id; without it, the owners of the server's first workspace (the one its setup page
// made) run it, so a self-hosted server is never locked out. Never anyone on a person's own machine.
//
// This is the only place that decides it. A role in workspace #1 is a role in a workspace like any other: someone
// invited there as an owner or admin works there, and runs nothing (else an invited owner would be walked through the
// server's setup).
import { getUser, sameEmail, type User } from './auth.ts';
import type { Config } from './config.ts';
import { DEFAULT_WORKSPACE } from './scope.ts';
import { roleIn } from './workspaces.ts';

/** Whether an account matches an entry of LAMPO_OPERATOR: its id, or its confirmed address. */
const named = (u: Pick<User, 'id' | 'email' | 'unverified'>, entry: string): boolean =>
  // An address counts only once proven or vouched for (a sign-up waiting for its link is anyone who typed it).
  u.id === entry || (!u.unverified && sameEmail(u.email, entry));

/** What the operator rule reads of the settings. */
export type OperatorConfig = Pick<Config, 'mode' | 'operators'>;

/**
 * Whether this account runs the server (an active account; a hosted server only). Never throws: a registry that can't
 * be read makes nobody the operator by their role.
 */
export function isOperator(cfg: OperatorConfig, userId: string | null | undefined): boolean {
  if (cfg.mode !== 'server' || !userId) return false;
  const u = getUser(userId);
  if (!u || u.disabled) return false;
  if (cfg.operators.length) return cfg.operators.some((e) => named(u, e));
  try {
    return roleIn(DEFAULT_WORKSPACE, u.id) === 'owner';
  } catch {
    return false;
  }
}

/** The entries of LAMPO_OPERATOR that name no account here (a typo, or an account not made yet): said once at start. */
export function unknownOperators(cfg: Pick<Config, 'operators'>, users: readonly Pick<User, 'id' | 'email' | 'unverified'>[]): string[] {
  return cfg.operators.filter((e) => !users.some((u) => named(u, e)));
}
