// Whether the workspace's billing banner and the sidebar's trial line show (billing/Banner.tsx): a trial in its last
// three days, a grace period, read-only; the trial line all through a trial and its grace week. Its own small module,
// without words: the library asks it at first paint, from the billing answer this browser kept, to hold their room
// before their code arrives (nothing moves when it does). The code itself comes after the first paint (billing/code.ts).
import type { BillingInfo } from '../../../lib/types.ts';

/** A day number of an instant's calendar date in this browser (the trial ends on a date, not after 72 hours). */
const dayOf = (ms: number) => {
  const d = new Date(ms);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
};

/** The banner shows (conversion/Ending.tsx stageOf says the same): the trial's last three days, grace, read-only. */
export function bannerDue(b: BillingInfo | null | undefined, now = Date.now()): boolean {
  if (!b || b.complimentary) return false;
  if (b.state === 'grace' || b.state === 'read-only') return true;
  return b.state === 'trial' && !!b.trialEndsAt && dayOf(Date.parse(b.trialEndsAt)) - dayOf(now) <= 3;
}

/** The sidebar's trial line: while a trial runs, and in the grace week after a trial (never a payment's). */
export const trialLineDue = (b: BillingInfo | null | undefined): boolean =>
  !!b && !b.complimentary && ((b.state === 'trial' && !!b.trialEndsAt) || (b.state === 'grace' && b.reason !== 'payment' && !!b.graceUntil));
