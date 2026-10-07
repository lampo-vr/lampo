// What a limit's sheet says, worked out from the plan's answer (facts.ts) and what was asked for (lib/toast.ts LimitAsk):
// why there is no room, the smallest step that fits (a plan, or one more terabyte), its price as the picker says it, what
// changes from now to then with the workspace's own numbers, and how it is paid. Pure (words through t()), so the unit
// tests read every state in both languages; LimitSheet.tsx only lays it out.
import type { BillingInfo, BillingOffer } from '../../../../lib/types.ts';
import { currentLang, locale, t } from '../../i18n/index.ts';
import { addonOf, bytesOf, currencyOf, type Feature, freeLimits, type LimitAsk, monthTotal, offerOf, periodTotal, smallestFit, unitsOf } from '../facts.ts';

/** Why the sheet opened. */
export type Reason = 'storage' | 'members' | 'videos' | 'feature';

/** The smallest step that fits: a plan, one more terabyte, or a contract (nothing on offer holds it: talk to us). */
export type Fit =
  | { kind: 'plan'; offer: BillingOffer }
  // one more terabyte: its price for the subscription's interval (the other one is null, never guessed)
  | { kind: 'addon'; tb: number; month: number | null; year: number | null; currency: string }
  | { kind: 'contract' };

/** Where "Talk to us" about a contract goes: the one address, for the limit sheet and Settings → Billing alike. */
export const CONTRACT_ADDRESS = 'hello@lampo.video';
/** "Talk to us" about Business as a link: a message to CONTRACT_ADDRESS. */
export const contractMail = (): string => `mailto:${CONTRACT_ADDRESS}?subject=${encodeURIComponent('Lampo Business')}`;

/** The plan that brings a feature when the provider doesn't say (the website: roles, Insights and webhooks come with Team). */
const FEATURE_PLAN: Record<Feature, string> = { insights: 'team', roles: 'team', webhooks: 'team' };

export function reasonOf(ask: LimitAsk): Reason | null {
  if (ask.feature) return 'feature';
  return ask.reason === 'storage' || ask.reason === 'members' || ask.reason === 'videos' ? ask.reason : null;
}

/** What the workspace would hold once what was asked for is in: its people, bytes and videos under review. */
export function needOf(b: BillingInfo, ask: LimitAsk, reason: Reason): { members: number; bytes: number; activeVideos: number } {
  return {
    members: b.usage.members + (reason === 'members' ? 1 : 0),
    bytes: b.usage.bytes + (reason === 'storage' && typeof ask.needed === 'number' ? ask.needed : 0),
    activeVideos: b.usage.activeVideos + (reason === 'videos' ? 1 : 0),
  };
}

/** The smallest step that makes room (the provider's `fits` first), or a contract when nothing on offer holds it. */
export function fitFor(b: BillingInfo, ask: LimitAsk, reason: Reason): Fit {
  const need = needOf(b, ask, reason);
  let id: string | null;
  if (reason === 'feature') id = ask.fits && offerOf(b, ask.fits) ? ask.fits : FEATURE_PLAN[ask.feature ?? 'insights'];
  else if (reason === 'storage') id = smallestFit(b, { bytes: need.bytes }, ask.fits);
  else if (reason === 'members') id = smallestFit(b, { members: need.members }, ask.fits);
  else {
    const cur = currencyOf(b);
    const fits = (b.offers ?? []).filter(
      (o) =>
        o.plan !== b.plan &&
        (o.activeVideos === null || o.activeVideos >= need.activeVideos) &&
        (o.members.max === null || o.members.max >= need.members) &&
        bytesOf(o, need.members) >= need.bytes &&
        o.prices[cur],
    );
    fits.sort((x, y) => (monthTotal(x, 'year', need.members, cur) ?? 0) - (monthTotal(y, 'year', need.members, cur) ?? 0));
    id = ask.fits && offerOf(b, ask.fits) ? ask.fits : (fits[0]?.plan ?? null);
  }
  if (id === 'addon:storage_tb') {
    const a = addonOf(b);
    if (a) return { kind: 'addon', tb: 1, month: a.month, year: a.year, currency: a.currency };
  }
  const offer = id ? offerOf(b, id) : null;
  return offer ? { kind: 'plan', offer } : { kind: 'contract' };
}

// ---------------------------------------------------------------- numbers as people read them

/** "€80", "€171.36" · "80 €", "171,36 €"; `cents` always shows them (a total, a receipt). */
export function money(minor: number, currency: string, cents = false): string {
  const whole = minor % 100 === 0 && !cents;
  return new Intl.NumberFormat(locale(), {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

/** "17 October 2026" / "17. Oktober 2026". */
export const day = (iso: string): string => new Date(iso).toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' });

/** Storage as plans sell it: "1.8 GB", "3 TB", "2.97 TB" · "1,8 GB". */
export function size(bytes: number): string {
  const f = (x: number, d: number) => x.toLocaleString(locale(), { maximumFractionDigits: d });
  if (bytes >= 1e12) return `${f(bytes / 1e12, 2)} TB`;
  if (bytes >= 1e9) return `${f(bytes / 1e9, 1)} GB`;
  return `${Math.max(0, Math.round(bytes / 1e6)).toLocaleString(locale())} MB`;
}

/** What billing yearly saves, said exactly: "2 months free" only where it is two months to the cent. */
export function saving(o: BillingOffer, currency: string): string | null {
  const p = o.prices[currency];
  if (!p || p.month * 12 <= p.year) return null;
  if (p.month * 10 === p.year) return t('2 months free');
  return t('save {p}%', { p: Math.round((1 - p.year / (12 * p.month)) * 100) });
}

/** A plan in a few words (the website's lines), else the provider's first highlight. */
export function planLine(o: BillingOffer): string {
  if (o.plan === 'solo') return t('One person and their agents');
  if (o.plan === 'team') return t('A studio, its agents and everyone it shares with');
  if (o.plan === 'business') return t('Larger teams, with more room per member');
  return o.highlights?.[currentLang()]?.[0] ?? o.highlights?.en?.[0] ?? '';
}

/** The price as the picker says it: the big figure, what it is per, and the line under it. */
export function priceOf(o: BillingOffer, interval: 'month' | 'year', members: number, currency: string): { big: string; per: string; sub: string } | null {
  const unit = o.prices[currency];
  const total = monthTotal(o, interval, members, currency);
  const period = periodTotal(o, interval, members, currency);
  if (!unit || total === null || period === null) return null;
  const n = unitsOf(o, members);
  const each = money(interval === 'year' ? Math.round(unit.year / 12) : unit.month, currency);
  const yearly = monthTotal(o, 'year', members, currency) ?? 0;
  const several = o.perMember && n > 1;
  return {
    big: several ? money(total, currency) : each,
    per: several ? t('a month for {n}', { n }) : t('a month'),
    sub:
      interval === 'year'
        ? o.perMember
          ? t('{amount} billed yearly · {each} per member', { amount: money(period, currency), each })
          : t('{amount} billed yearly', { amount: money(period, currency) })
        : o.perMember
          ? t('Billed monthly · {each} per member · {yearly} if yearly', { each, yearly: money(yearly, currency) })
          : t('Billed monthly · {yearly} if yearly', { yearly: money(yearly, currency) }),
  };
}

// ---------------------------------------------------------------- what changes, now → then

export interface Row {
  k: string;
  now: string;
  next: string;
  /** It stays as it is ("stays"). */
  same?: boolean;
}

/** The feature a plan lacks first (a feature's sheet opened without naming one). */
const featureOf = (b: BillingInfo): Feature =>
  b.features?.insights === false ? 'insights' : b.features?.roles === false ? 'roles' : b.features?.webhooks === false ? 'webhooks' : 'insights';

/** The rows of "What changes", in the order they matter for what was asked: the workspace's numbers now and then. */
export function changeRows(b: BillingInfo, fit: Fit, reason: Reason, need: { members: number }, feature?: Feature): Row[] {
  const free = b.state === 'free' || b.plan === 'free';
  const limits = free ? freeLimits(b) : b.limits;
  const nowBytes = limits.bytes === null ? t('No limit') : size(limits.bytes);
  const atATime = (n: number | null) => (n === null ? t('No limit') : t('{n} at a time', { n }));
  if (fit.kind === 'addon')
    return [
      { k: t('Storage'), now: nowBytes, next: size((b.limits.bytes ?? 0) + fit.tb * 1e12) },
      { k: t('Plan'), now: b.planName, next: b.planName, same: true },
    ];
  if (fit.kind === 'contract') return [];
  const o = fit.offer;
  const bytes = size(bytesOf(o, need.members));
  const upTo = o.members.max === null ? t('No limit') : t('up to {n}', { n: o.members.max });
  const solo = o.members.max !== null && o.members.max <= 1;
  const membersRow: Row = solo
    ? { k: t('Members'), now: String(b.usage.members), next: String(b.usage.members), same: true }
    : {
        k: t('Members'),
        now: String(limits.members ?? b.usage.members),
        next: reason === 'members' && o.members.max !== null ? t('{n} · up to {max}', { n: need.members, max: o.members.max }) : upTo,
      };
  const storage: Row = { k: t('Storage'), now: nowBytes, next: bytes };
  const videos: Row = { k: t('Videos under review'), now: atATime(limits.activeVideos), next: atATime(o.activeVideos) };
  const lacking = b.features?.insights === false || b.features?.roles === false || b.features?.webhooks === false;
  const extras: Row = { k: t('Roles, Insights, webhooks'), now: '—', next: t('Included') };
  const badge: Row = { k: t('Review links'), now: t('Lampo badge'), next: t('Hide the Lampo badge') };
  if (reason === 'feature') {
    const f = feature ?? featureOf(b);
    const name = f === 'roles' ? t('Roles') : f === 'webhooks' ? t('Webhooks') : 'Insights';
    return [
      { k: name, now: '—', next: t('From today’s data on') },
      ...(f === 'insights' ? [{ k: t('Roles and webhooks'), now: '—', next: t('Included') }] : []),
      membersRow,
      storage,
      videos,
    ];
  }
  if (reason === 'members') return [membersRow, storage, videos, ...(lacking ? [extras] : []), ...(free ? [badge] : [])];
  if (reason === 'videos') return [videos, storage, ...(free ? [badge] : []), membersRow];
  return [storage, videos, ...(free ? [badge] : []), membersRow];
}

// ---------------------------------------------------------------- the head: what was asked for, and why there's no room

/** The title: it names what was asked for. */
export function titleOf(reason: Reason, ask: LimitAsk, workspace: string, fit: Fit): string {
  if (reason === 'storage') return ask.name ? t('{name} needs more room', { name: ask.name }) : t('This needs more room');
  if (reason === 'members')
    return ask.name ? t('Bring {name} into {workspace}', { name: ask.name, workspace }) : t('Room for one more in {workspace}', { workspace });
  if (reason === 'videos')
    return ask.name ? t('{name} needs room for one more video under review', { name: ask.name }) : t('Room for another video under review');
  const plan = fit.kind === 'plan' ? fit.offer.name : 'Business';
  const f = ask.feature ?? 'insights';
  return f === 'roles'
    ? t('Roles come with {plan}', { plan })
    : f === 'webhooks'
      ? t('Webhooks come with {plan}', { plan })
      : t('Insights come with {plan}', { plan });
}

/** One sentence with the workspace's own numbers (and, where it matters, that a plan bills at least two). */
export function ledeOf(reason: Reason, ask: LimitAsk, b: BillingInfo, workspace: string, fit: Fit): string {
  const free = b.state === 'free' || b.plan === 'free';
  const limits = free ? freeLimits(b) : b.limits;
  if (reason === 'storage') {
    const needed = typeof ask.needed === 'number' ? ask.needed : 0;
    const first = t('It’s {size}, and {workspace} has {left} of {plan}’s {limit} left.', {
      size: size(needed),
      workspace,
      left: size(Math.max(0, (limits.bytes ?? 0) - b.usage.bytes)),
      plan: b.planName,
      limit: size(limits.bytes ?? 0),
    });
    if (fit.kind === 'addon') return `${first} ${t('One more terabyte is the smallest step; the plan stays {plan}.', { plan: b.planName })}`;
    return `${first} ${ask.upload ? t('The upload waits; reviewing and everything else go on.') : t('Reviewing and everything else go on.')}`;
  }
  if (reason === 'videos')
    return t('{plan} holds {n} videos under review at a time, and {workspace} has {n}. Reviewing and everything else go on.', {
      plan: b.planName,
      n: limits.activeVideos ?? b.usage.activeVideos,
      workspace,
    });
  if (fit.kind !== 'plan') return t('Nothing on offer holds that yet: a contract can.');
  const o = fit.offer;
  if (reason === 'members') {
    const now =
      limits.members === 1
        ? t('{plan} is for one person.', { plan: b.planName })
        : t('{plan} holds {n} members.', { plan: b.planName, n: limits.members ?? 0 });
    const room =
      o.members.max === null
        ? t('{plan} has room for everyone', { plan: o.name })
        : t('{plan} has room for {min} to {max}', { plan: o.name, min: o.members.min, max: o.members.max });
    return `${now} ${room}${ask.name ? t(': {name} gets an account of their own.', { name: ask.name }) : '.'}`;
  }
  // a feature: the plan that brings it, honestly priced for the people there are (Team bills at least two)
  if (o.perMember && b.usage.members < o.members.min)
    return t(
      '{plan} is for {min} to {max} members, so it is billed for {min} while you work alone. Invite someone and the second seat is theirs; there is nothing extra to pay.',
      { plan: o.name, min: o.members.min, max: o.members.max ?? '∞' },
    );
  return t('{plan} brings it for the {n} of you.', { plan: o.name, n: b.usage.members });
}

/** The line under the table: what stays as it is. */
export function keepOf(reason: Reason, fit: Fit): string {
  if (fit.kind === 'addon') return t('Remove it any time; it ends with the period.');
  if (reason === 'members') return t('People on review links and agents never count. Each new member adds a seat; the bill follows the people.');
  if (reason === 'feature') return t('Insights reads what is already there: the history since your first note counts.');
  return t('Your videos, notes and review links stay as they are.');
}

/** The orange button's words: what paying does, and what goes on after it. */
export function payLabel(reason: Reason, fit: Fit, ask: LimitAsk, amount: string | null, switching: boolean): string {
  const name = reason === 'members' && ask.name ? ask.name : null;
  if (fit.kind === 'addon') return ask.upload ? t('Add 1 TB and upload') : t('Add 1 TB');
  if (switching && fit.kind === 'plan') {
    if (name) return t('Switch to {plan} and invite {name}', { plan: fit.offer.name, name });
    return ask.upload ? t('Switch to {plan} and upload', { plan: fit.offer.name }) : t('Switch to {plan}', { plan: fit.offer.name });
  }
  if (!amount) return t('Pay');
  if (name) return t('Pay {amount} and invite {name}', { amount, name });
  if (ask.upload) return t('Pay {amount} and upload', { amount });
  return t('Pay {amount}', { amount });
}

/** A first name for a person invited by address alone ("ben.kruse@…" → "Ben"), or null when it can't be read off. */
export function nameFromAddress(email: string): string | null {
  const local = email.split('@')[0]?.split(/[._+-]/)[0] ?? '';
  return /^[a-zA-ZÀ-ÿ]{2,}$/.test(local) ? local[0].toUpperCase() + local.slice(1).toLowerCase() : null;
}
