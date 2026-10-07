// What Settings → Billing and the workspace's banner say about a billing provider's answer (lib/types.ts BillingInfo):
// one sentence per state, the numbers as people read them. The provider names its plans and prices; every other word is
// ours, in English and German. Pure, so the page and the banner say the same and the unit test reads both languages.
import type { BillingInfo, BillingOffer } from '../../../lib/types.ts';
import { currentLang, locale, t } from '../i18n/index.ts';
import { bannerDue } from './due.ts';

const DAY = 86_400_000;

/** Whole days from now until `iso` (at least 0): "3 days left" on the day the trial ends in 2.4 days. */
export const daysUntil = (iso: string, now = Date.now()): number => Math.max(0, Math.ceil((Date.parse(iso) - now) / DAY));

/** "17 October 2026" / "17. Oktober 2026". */
export const day = (iso: string): string => new Date(iso).toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' });

/** Storage as plans sell it: decimal GB and TB ("2.5 TB", "10 GB"). */
export function size(n: number): string {
  const f = (x: number, digits = 1) => x.toLocaleString(locale(), { maximumFractionDigits: digits });
  // terabytes to two places: 1.22 TB of 4 TB reads differently from 1.2
  if (n >= 1e12) return `${f(n / 1e12, 2)} TB`;
  if (n >= 1e9) return `${f(n / 1e9)} GB`;
  return `${Math.max(0, Math.round(n / 1e6)).toLocaleString(locale())} MB`;
}

/** An amount in a currency's minor unit: "€20", "€12.50", "$24"; `cents` always (a total, an invoice): "€1,261.40". */
export function money(minor: number, currency: string, o: { cents?: boolean } = {}): string {
  const whole = minor % 100 === 0 && !o.cents;
  return new Intl.NumberFormat(locale(), {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

/**
 * A price as a consumer pays it (PAngV, A13 CLOUD-2): with the VAT the provider names (`BillingInfo.vat`), to the cent;
 * as it is where it names none.
 */
export const gross = (minor: number, b: Pick<BillingInfo, 'vat'>): number => (b.vat?.rate ? Math.round((minor * (100 + b.vat.rate)) / 100) : minor);

/** "19%", "19 %": a VAT rate in the page's language. */
export const vatRate = (rate: number): string => new Intl.NumberFormat(locale(), { style: 'percent', maximumFractionDigits: 2 }).format(rate / 100);

/** What a plan costs per month and unit, billed `interval` (yearly is shown per month: the year's price ÷ 12). */
export function monthly(o: BillingOffer, interval: 'month' | 'year', currency: string): number | null {
  const p = o.prices[currency];
  if (!p) return null;
  return interval === 'year' ? Math.round(p.year / 12) : p.month;
}

/** The workspace's state in two words, for the badge beside the plan's name. */
export function stateLabel(b: BillingInfo): string {
  switch (b.state) {
    case 'trial':
      return t('Trial');
    case 'free':
      return t('Free plan');
    case 'paid':
      return b.endsAt ? t('Ends soon') : t('Active');
    case 'grace':
      return t('Grace period');
    case 'read-only':
      return t('Read-only');
  }
}

/** One sentence on where the workspace stands (the Plan card's lede, and the banner's text). */
export function stateLine(b: BillingInfo, now = Date.now()): string {
  switch (b.state) {
    case 'trial': {
      const n = b.trialEndsAt ? daysUntil(b.trialEndsAt, now) : 0;
      return t(
        'Everything in {plan} until {date}, {n} day left. No card needed until you choose a plan.|Everything in {plan} until {date}, {n} days left. No card needed until you choose a plan.',
        {
          plan: b.planName,
          date: b.trialEndsAt ? day(b.trialEndsAt) : '',
          n,
        },
      );
    }
    case 'free':
      return t('The free plan. Choose a plan when you need room for more people, storage or videos.');
    case 'paid':
      if (b.endsAt) return t('Cancelled: it ends on {date}, then the workspace moves to the free plan. Nothing is deleted.', { date: day(b.endsAt) });
      if (b.renewsAt)
        return b.interval === 'year'
          ? t('Billed yearly, renews on {date}.', { date: day(b.renewsAt) })
          : t('Billed monthly, renews on {date}.', { date: day(b.renewsAt) });
      return t('Nothing to pay for this workspace.');
    case 'grace':
      if (b.reason === 'payment')
        return b.manage
          ? t('The last payment failed. Everything keeps working until {date}; update the payment method before then.', { date: day(b.graceUntil ?? '') })
          : t('The last payment failed. Everything keeps working until {date}; an owner or admin updates the payment method.', {
              date: day(b.graceUntil ?? ''),
            });
      return t('The trial has ended and this workspace holds more than the free plan allows. Everything keeps working until {date}.', {
        date: day(b.graceUntil ?? ''),
      });
    case 'read-only':
      if (b.reason === 'payment') return t('Read-only until the last invoice is paid: reviewing and existing review links keep working, nothing new is added.');
      return t('Read-only: this workspace holds more than its plan allows. Reviewing and existing review links keep working; nothing is deleted.');
  }
}

/** The banner a workspace shows everywhere it matters: a trial in its last three days, a grace period, read-only. */
export function bannerOf(b: BillingInfo | null | undefined, now = Date.now()): { tone: 'warn' | 'bad'; text: string } | null {
  if (!b || !bannerDue(b, now)) return null;
  if (b.state === 'trial' && b.trialEndsAt && daysUntil(b.trialEndsAt, now) <= 3) {
    const n = daysUntil(b.trialEndsAt, now);
    return {
      tone: 'warn',
      text:
        n === 0
          ? t('The trial ends today. Choose a plan to keep everything as it is.')
          : t('The trial ends in {n} day. Choose a plan to keep everything as it is.|The trial ends in {n} days. Choose a plan to keep everything as it is.', {
              n,
            }),
    };
  }
  if (b.state === 'grace' || b.state === 'read-only') return { tone: b.state === 'grace' ? 'warn' : 'bad', text: stateLine(b, now) };
  return null;
}

/** "3 of 50", "3" (no limit): what is used of what the plan holds. */
export const ofLimit = (used: string, limit: string | null): string => (limit === null ? used : t('{used} of {limit}', { used, limit }));

/** "Thursday 15 October", "15 Oct", "15 October 2027": the forms the page writes a date in. */
export function dayOf(iso: string, o: { weekday?: boolean; short?: boolean; year?: boolean } = {}): string {
  return new Date(iso).toLocaleDateString(locale(), {
    day: 'numeric',
    month: o.short ? 'short' : 'long',
    ...(o.year ? { year: 'numeric' } : {}),
    ...(o.weekday ? { weekday: 'long' } : {}),
  });
}

/** Whole days from `from` to `to`, at least 0 (the rulers count days, not hours). */
export const daysBetween = (from: string | number, to: string | number): number =>
  Math.max(0, Math.round(((typeof to === 'number' ? to : Date.parse(to)) - (typeof from === 'number' ? from : Date.parse(from))) / DAY));

/** Free as the provider sells it (cloud plans.ts): what "What Free would mean" measures the workspace against. The answer
 * carries the current plan's limits only, so Free's are here; they change with the plans, not per workspace. */
export const FREE_LIMITS = { members: 1, bytes: 10e9, activeVideos: 3 } as const;

/** Units a plan is billed for with `n` people: per member (at least its minimum), or one. */
export const unitsFor = (o: BillingOffer, n: number): number => (o.perMember ? Math.max(n, o.members.min) : 1);

/** What billing yearly saves, said exactly: "2 months free" only where the year is ten months to the cent. */
export function saving(o: BillingOffer, currency: string): string {
  const p = o.prices[currency];
  if (!p) return '';
  if (p.year === p.month * 10) return t('2 months free');
  const share = new Intl.NumberFormat(locale(), { style: 'percent', maximumFractionDigits: 0 }).format(1 - p.year / 12 / p.month);
  return t('save {share}', { share });
}

/** A plan in a line, for the plans the provider sells today; another plan's tile goes without one. */
export function planLine(plan: string): string {
  if (plan === 'solo') return t('One person and their agents');
  if (plan === 'team') return t('A studio, its agents and everyone it shares with');
  if (plan === 'business') return t('Companies with their own rules');
  return '';
}

/** Why a renewal didn't go through, from the provider's decline code: our words, never the provider's text. */
export function whyFailed(code: string | undefined, label: string): string {
  // a card's dots and digits stay on one line
  const method = label.replace(/•••• /g, '••••\u00a0');
  switch (code) {
    case 'expired_card':
      return t('{method} has expired', { method });
    case 'insufficient_funds':
      return t('{method} didn’t have enough funds', { method });
    case 'authentication_required':
      return t('the bank wanted the payment confirmed', { method });
    case 'card_declined':
    case 'do_not_honor':
    case 'generic_decline':
      return t('the bank declined {method}', { method });
    default:
      return t('{method} didn’t go through', { method });
  }
}

/**
 * What a billing provider's refusal says (its routes answer `{error, code}` in English), in the page's language: in
 * English its own sentence, which may name numbers; in another, ours for a code we know, else its sentence as it is.
 */
export function billingSaid(e: unknown): string {
  const said = e instanceof Error ? e.message : String(e);
  if (currentLang() === 'en') return said;
  const code = (e as { details?: { code?: unknown } } | null)?.details?.code;
  switch (code) {
    case 'signed-out':
      return t('Sign in first.');
    case 'not-allowed':
      return t('Only the workspace’s owners and admins manage billing.');
    case 'slow-down':
      return t('Too many attempts: wait a minute, then try again.');
    case 'unavailable':
      return t('Paying isn’t set up on this server yet.');
    case 'complimentary':
      return t('This workspace is complimentary: there is nothing to pay.');
    case 'tax-id-invalid':
      return t('That VAT ID doesn’t look right. Look at it again, or leave it out.');
    case 'no-billing-account':
      return t('This workspace has no billing account yet: choose a plan first.');
    case 'already-subscribed':
      return t('This workspace already has a plan: change it in Billing instead.');
    case 'addon-too-large':
    case 'addon-range':
      return t('More extra storage than that is a Business contract: talk to us.');
    case 'no-subscription':
      return t('This workspace has no running plan.');
    case 'method-in-use':
      return t('Renewals are charged to this payment method. Make another one the default first.');
    case 'nothing-to-pay':
      return t('There is no open invoice to pay.');
    case 'nothing-to-tell':
      return t('No payment is waiting.');
    case 'solo-one-person':
      return t('Solo is for one person. Choose Team to keep everyone in this workspace.');
    case 'too-many-members':
      return t('This workspace has more members than that plan has room for. Choose a bigger one.');
    case 'storage-in-use':
      return t('This workspace holds more than that would leave room for: archive or delete videos first, then reduce the extra storage.');
    case 'no-notice':
      return t('This plan ends at the end of its period: one month’s notice is for a consumer’s yearly plan after its first year.');
    default:
      return said;
  }
}
