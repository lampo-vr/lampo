// What the conversion moments say about dates, plans and prices, in the page's language (English, German "du"): the
// words the trial line, its popover, the banner and the value moments share. Loaded with them, after the first paint.

import type { BillingInfo } from '../../../lib/types.ts';
import { money, size } from '../billing/words.ts';
import { locale, t } from '../i18n/index.ts';
import { currencyOf, freeLimits, monthTotal, offerOf, smallestFit, type TrialFacts } from './facts.ts';

export { money, size };

/** "Thursday 15 October" · "Donnerstag, 15. Oktober". */
export const weekdayDate = (iso: string): string => new Date(iso).toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' });
/** "15 October" · "15. Oktober". */
export const dayMonth = (iso: string): string => new Date(iso).toLocaleDateString(locale(), { day: 'numeric', month: 'long' });
/** "15 Oct" · "15. Okt.". */
export const shortDate = (iso: string): string => new Date(iso).toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
/** "10:12". */
export const clock = (iso: string): string => new Date(iso).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });

/** "Team trial" · "Team-Testphase". */
export const trialName = (b: BillingInfo): string => t('{plan} trial', { plan: b.planName });

/** "10 days left", "Ends tomorrow", "Ends today": calm words, never hours. */
export const leftWords = (f: TrialFacts): string =>
  f.left <= 0 ? t('Ends today') : f.left === 1 ? t('Ends tomorrow') : t('{n} day left|{n} days left', { n: f.left });

/** The plan to keep: the one in force, or once a trial ended (Free), the smallest one that holds the workspace. */
export const keepPlan = (b: BillingInfo): string => (b.plan !== 'free' && offerOf(b, b.plan) ? b.plan : (smallestFit(b, {}) ?? b.plan));
/** Its name as the provider calls it. */
export const keepName = (b: BillingInfo): string => offerOf(b, keepPlan(b))?.name ?? b.planName;

/** The trial's plan as the picker would bill it for this workspace: "Team for 4: €80 a month, billed yearly". */
export function keepLine(b: BillingInfo, monthly = false, plan = keepPlan(b)): string | null {
  const o = offerOf(b, plan);
  if (!o) return null;
  const cur = currencyOf(b, o);
  const n = b.usage.members;
  const year = monthTotal(o, 'year', n, cur);
  const month = monthTotal(o, 'month', n, cur);
  if (year === null) return null;
  const units = o.perMember ? Math.max(o.members.min, n) : null;
  if (monthly && month !== null)
    return units
      ? t('{plan} for {n}: {price} a month, billed yearly, or {monthly} monthly.', {
          plan: o.name,
          n: units,
          price: money(year, cur),
          monthly: money(month, cur),
        })
      : t('{plan}: {price} a month, billed yearly, or {monthly} monthly.', { plan: o.name, price: money(year, cur), monthly: money(month, cur) });
  return units
    ? t('{plan} for {n}: {price} a month, billed yearly', { plan: o.name, n: units, price: money(year, cur) })
    : t('{plan}: {price} a month, billed yearly', { plan: o.name, price: money(year, cur) });
}

/** "After that, Team is €80 a month for the 4 of you, billed yearly." (null when the plan's price isn't known here) */
export function afterLine(b: BillingInfo): string | null {
  const o = offerOf(b, keepPlan(b));
  if (!o) return null;
  const cur = currencyOf(b, o);
  const n = b.usage.members;
  const price = monthTotal(o, 'year', n, cur);
  if (price === null) return null;
  const units = o.perMember ? Math.max(o.members.min, n) : 1;
  return units > 1 && units === n
    ? t('After that, {plan} is {price} a month for the {n} of you, billed yearly.', { plan: o.name, price: money(price, cur), n })
    : units > 1
      ? t('After that, {plan} is {price} a month, billed yearly for {n}.', { plan: o.name, price: money(price, cur), n: units })
      : t('After that, {plan} is {price} a month, billed yearly.', { plan: o.name, price: money(price, cur) });
}

/** Settings → Billing. */
export const BILLING = '#/settings/billing';

/** The checkout for the plan to keep, billed yearly, for the workspace's people (Settings → Billing's checkout step,
 * billing/Checkout.tsx checkoutHash: the same address, without its chunk). */
export const checkoutHref = (b: BillingInfo, plan = keepPlan(b)): string =>
  `#/settings/billing/checkout?plan=${encodeURIComponent(plan)}&interval=year&currency=${currencyOf(b, offerOf(b, plan))}`;

/** What Free holds against what the workspace has, per resource (null: it fits). */
export function overFree(b: BillingInfo) {
  const free = freeLimits(b);
  return {
    free,
    members: Math.max(0, b.usage.members - free.members),
    videos: Math.max(0, b.usage.activeVideos - free.activeVideos),
    bytes: Math.max(0, b.usage.bytes - free.bytes),
  };
}
