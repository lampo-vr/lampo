// Whether "I'm buying for my business, not as a private person" is ticked for a workspace (billing/Business.tsx): the
// provider's answer once someone confirmed it (BillingInfo.business), else unticked — and what was ticked or unticked in
// this visit, wherever the box was (the plans, the checkout step, a limit sheet), so the plans' tick carries into the
// checkout. Kept in memory per workspace, gone with a sign-out. No React here: the unit test reads it as it is.
import type { BillingInfo } from '../../../lib/types.ts';
import { onSignOut } from '../lib/signedOut.ts';

const said = new Map<string, boolean>();
const listeners = new Set<() => void>();
const changed = () => {
  for (const l of listeners) l();
};

/** Hears every change (React's useSyncExternalStore). */
export function subscribeBusiness(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** What this visit said for the workspace: ticked, unticked, or nothing yet (undefined). */
export const businessSaid = (workspace: string): boolean | undefined => said.get(workspace);

/** Ticked or unticked for the workspace, for the rest of the visit. */
export function sayBusiness(workspace: string, on: boolean): void {
  said.set(workspace, on);
  changed();
}

/** Whether the box is ticked: this visit's word, else the provider's (someone of the workspace confirmed it before). */
export const businessTicked = (b: Pick<BillingInfo, 'business'>, workspace: string): boolean => businessSaid(workspace) ?? !!b.business;

onSignOut(() => {
  said.clear();
  changed();
});
