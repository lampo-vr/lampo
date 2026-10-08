// The website's sign-up link (lampo.video's Start free and pricing buttons: `#/signup?plan=…`, utm tags beside it):
// which plan it named, the links between sign-in and sign-up that keep it, and where it takes someone signed in
// already. The sign-up and sign-in screens' code only, never the first paint.
import { isSignupPlan } from '../../../lib/setupFlow.ts';
import type { SignupPlan } from '../../../lib/types.ts';

const hashQuery = (hash: string) => (hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '');
const param = (hash: string, search: string, key: string) => new URLSearchParams(search).get(key) ?? new URLSearchParams(hashQuery(hash)).get(key);

/** The plan the link named, in the address's query or the hash's: known ids only (Start free's `cloud-free` is what
 * every sign-up gets: no id). */
export function planIn(hash: string, search: string): SignupPlan | undefined {
  const plan = param(hash, search, 'plan');
  return isSignupPlan(plan) ? plan : undefined;
}

/** Sign-up or sign-in, keeping the plan the address names: whoever lands on the other screen still signs up on it. */
export const withPlan = (to: '#/signup' | '#/', hash: string, search: string): string => {
  const plan = planIn(hash, search);
  return plan ? `${to}?plan=${plan}` : to;
};

/**
 * Where the sign-up link takes someone signed in already: the app, in the workspace this session works in (the one
 * they last used); a paid plan to Settings → Billing's picker with it, where billing runs (`billing`, /api/info), with
 * the interval and currency the site showed (Billing.tsx reads them).
 */
export function signedInTo(hash: string, search: string, billing: boolean): string {
  const plan = planIn(hash, search);
  if (!plan || !billing) return '#/';
  const q = new URLSearchParams({ plan });
  const interval = param(hash, search, 'interval');
  const currency = param(hash, search, 'currency');
  if (interval === 'month' || interval === 'year') q.set('interval', interval);
  if (currency === 'eur' || currency === 'usd') q.set('currency', currency);
  return `#/settings/billing?${q}`;
}
