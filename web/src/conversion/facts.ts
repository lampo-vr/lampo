// What the conversion moments (web/src/conversion/) read from the billing provider's answer, in one place: BillingInfo
// (lib/types.ts: `trialStartsAt`, `addons`, `features`; a 402's PlanRefusal: `needed`, `room`, `fits`), each optional,
// so an older module that sends less still works: nothing here invents a number it doesn't have — an add-on the module
// doesn't sell is never offered, a feature it doesn't name is never locked, a use it doesn't report is never said.
// Pure, so the unit tests read every state.
import type { BillingInfo, BillingOffer } from '../../../lib/types.ts';

export const DAY = 86_400_000;
/** A trial lasts this long when the provider doesn't say when it started. */
export const TRIAL_DAYS = 14;
/** The grace period after a trial or a failed payment. */
export const GRACE_DAYS = 7;
/** What Free holds when the provider names no free plan's limits (the website's Free). */
export const FREE = { members: 1, bytes: 10e9, activeVideos: 3 };

/** A feature a higher plan brings (Insights, roles, webhooks). */
export type Feature = 'insights' | 'roles' | 'webhooks';

/** What a 402 refusal (server/extension.ts) carries besides its sentence, as the spec adds it. */
export interface RefusalDetails {
  reason?: 'storage' | 'members' | 'videos' | 'read-only' | 'payment' | string;
  upgrade?: string;
  messages?: Record<string, string>;
  /** What was asked for: the file's bytes, or the invitee's address. */
  needed?: number | string;
  /** What the open app counts as room to make: final or archivable videos and their bytes. */
  room?: { videos: number; bytes: number };
  /** The smallest step that fits: a plan id, or `addon:storage_tb`. */
  fits?: string;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
/** The calendar day of an instant, in this browser's time zone, as a day number (dates, not 24-hour spans). */
const calendarDay = (ms: number): number => {
  const d = new Date(ms);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
};
/** Calendar days from today until `iso`'s day (at least 0): 0 on the last day, 1 the day before ("Ends tomorrow"). */
export const daysLeft = (iso: string, now = Date.now()): number => Math.max(0, calendarDay(Date.parse(iso)) - calendarDay(now));

/** The trial as a ruler: today is day `day` of `of`, `left` days to go; the last three days are `last`. */
export interface TrialFacts {
  day: number;
  of: number;
  left: number;
  last: boolean;
  startsAt: string;
  endsAt: string;
}

export function trialOf(b: BillingInfo | null | undefined, now = Date.now()): TrialFacts | null {
  if (b?.state !== 'trial' || !b.trialEndsAt || b.complimentary) return null;
  const end = Date.parse(b.trialEndsAt);
  if (!Number.isFinite(end)) return null;
  const start = b.trialStartsAt && Number.isFinite(Date.parse(b.trialStartsAt)) ? Date.parse(b.trialStartsAt) : end - TRIAL_DAYS * DAY;
  const of = Math.max(1, Math.round((end - start) / DAY));
  const left = daysLeft(b.trialEndsAt, now);
  return {
    day: clamp(calendarDay(now) - calendarDay(start) + 1, 1, of),
    of,
    left,
    last: left <= 3,
    startsAt: new Date(start).toISOString(),
    endsAt: b.trialEndsAt,
  };
}

/** The grace week as a ruler (state `grace`): today is day `day` of 7, until `until`. */
export function graceOf(b: BillingInfo | null | undefined, now = Date.now()): { day: number; of: number; until: string } | null {
  if (b?.state !== 'grace' || !b.graceUntil) return null;
  const end = Date.parse(b.graceUntil);
  if (!Number.isFinite(end)) return null;
  return { day: clamp(calendarDay(now) - calendarDay(end - GRACE_DAYS * DAY) + 1, 1, GRACE_DAYS), of: GRACE_DAYS, until: b.graceUntil };
}

/** Which of the library's banners a workspace's plan asks for (conversion/Ending.tsx; billing/due.ts bannerDue holds
 * its room from the first paint and agrees with it): the trial's last three days and its last day, grace, read-only, a
 * failed payment's; null otherwise. */
export type Stage = 'soon' | 'today' | 'grace' | 'ro' | 'pay';
export function stageOf(b: BillingInfo | null | undefined, now = Date.now()): Stage | null {
  if (!b || b.complimentary) return null;
  if (b.state === 'trial') {
    const f = trialOf(b, now);
    return f && f.left <= 3 ? (f.left === 0 ? 'today' : 'soon') : null;
  }
  if ((b.state === 'grace' || b.state === 'read-only') && b.reason === 'payment') return 'pay';
  if (b.state === 'grace') return 'grace';
  if (b.state === 'read-only') return 'ro';
  return null;
}

/** The plan includes it (a feature the provider doesn't name is included: never locked by guesswork). */
export const includes = (b: BillingInfo | null | undefined, f: Feature): boolean => b?.features?.[f] !== false;
/** The workspace uses it now (unknown: not said). */
export const inUse = (b: BillingInfo | null | undefined, f: Feature): boolean | null => b?.features?.inUse?.[f] ?? null;

export const offerOf = (b: BillingInfo | null | undefined, plan: string): BillingOffer | null => b?.offers?.find((o) => o.plan === plan) ?? null;
export const currencyOf = (b: BillingInfo | null | undefined, o?: BillingOffer | null): string =>
  b?.currency ?? (o ? Object.keys(o.prices)[0] : undefined) ?? 'eur';
/** Units a plan bills for `members` people: at least its minimum (Team bills at least 2). */
export const unitsOf = (o: BillingOffer, members: number): number => (o.perMember ? Math.max(o.members.min, members) : 1);
/** The plan's storage for `members` people. */
export const bytesOf = (o: BillingOffer, members: number): number => o.bytes.base + (o.perMember ? o.bytes.perMember * unitsOf(o, members) : 0);
/** A month's price, billed `interval` (yearly is shown per month: the year ÷ 12), for `members` people. */
export function monthTotal(o: BillingOffer, interval: 'month' | 'year', members: number, currency: string): number | null {
  const p = o.prices[currency];
  if (!p) return null;
  return Math.round((interval === 'year' ? p.year / 12 : p.month) * unitsOf(o, members));
}
/** The period's price (a year, or a month) for `members` people. */
export function periodTotal(o: BillingOffer, interval: 'month' | 'year', members: number, currency: string): number | null {
  const p = o.prices[currency];
  if (!p) return null;
  return (interval === 'year' ? p.year : p.month) * unitsOf(o, members);
}

/**
 * One more terabyte, when the provider sells it to this subscription (`addons`: the terabytes on it and one terabyte's
 * price per the subscription's interval), else null: then a bigger plan is the answer. The other interval's price isn't
 * known, so it is null, never guessed.
 */
export function addonOf(b: BillingInfo | null | undefined): { tb: number; month: number | null; year: number | null; currency: string } | null {
  const a = b?.addons;
  if (!a || !(a.price > 0)) return null;
  const year = b?.interval === 'year';
  return { tb: a.storageTB, month: year ? null : a.price, year: year ? a.price : null, currency: currencyOf(b) };
}

/**
 * The smallest step that makes room for what was asked: for storage on a paid plan the add-on when one is sold (one
 * more terabyte beats a bigger plan), else the cheapest plan that holds the workspace's people and bytes; null when
 * nothing on offer fits. `fits` from the refusal wins when the provider said it.
 */
export function smallestFit(b: BillingInfo | null | undefined, need: { bytes?: number; members?: number }, said?: string): string | null {
  if (!b) return said ?? null;
  if (said && (said === 'addon:storage_tb' ? !!addonOf(b) : !!offerOf(b, said))) return said;
  const members = need.members ?? b.usage.members;
  const bytes = need.bytes ?? b.usage.bytes;
  const paid = b.state === 'paid' || b.subscribed;
  if (need.bytes && paid && addonOf(b) && need.members === undefined) return 'addon:storage_tb';
  const cur = currencyOf(b);
  const fits = (b.offers ?? []).filter(
    (o) => o.plan !== b.plan && (o.members.max === null || o.members.max >= members) && bytesOf(o, members) >= bytes && o.prices[cur],
  );
  fits.sort((x, y) => (monthTotal(x, 'year', members, cur) ?? 0) - (monthTotal(y, 'year', members, cur) ?? 0));
  return fits[0]?.plan ?? null;
}

/** What a 402's body says beyond its sentence (unknown fields ignored). */
export function refusalOf(details: Record<string, unknown> | undefined): RefusalDetails {
  const d = details ?? {};
  const room = d.room as RefusalDetails['room'] | undefined;
  return {
    reason: typeof d.reason === 'string' ? d.reason : undefined,
    upgrade: typeof d.upgrade === 'string' ? d.upgrade : undefined,
    messages: d.messages && typeof d.messages === 'object' ? (d.messages as Record<string, string>) : undefined,
    needed: typeof d.needed === 'number' || typeof d.needed === 'string' ? d.needed : undefined,
    room: room && Number.isFinite(room.videos) && Number.isFinite(room.bytes) ? room : undefined,
    fits: typeof d.fits === 'string' ? d.fits : undefined,
  };
}

/** What Free holds: the provider's free limits when it names them (state `free`), else the website's. */
export const freeLimits = (b: BillingInfo | null | undefined) =>
  b?.state === 'free' || b?.plan === 'free'
    ? { members: b.limits.members ?? FREE.members, bytes: b.limits.bytes ?? FREE.bytes, activeVideos: b.limits.activeVideos ?? FREE.activeVideos }
    : FREE;

/**
 * A limit reached (a 402, or a feature of a higher plan): the limit's sheet opens instead of a toast
 * (conversion/limits/, loaded by the toaster, which also says it as a toast where no sheet can show). The refusal's
 * fields as the server sent them, and what the page knows about what was asked for.
 */
export interface LimitAsk {
  reason?: string;
  /** The refusal's sentence (`error`), and the same in other languages (`messages`). */
  message?: string;
  messages?: Record<string, string>;
  needed?: number | string;
  room?: { videos: number; bytes: number };
  fits?: string;
  upgrade?: string;
  /** What was asked for, by name: the file, or the person invited. */
  name?: string;
  /** A feature of a higher plan (reason `feature`). */
  feature?: 'insights' | 'roles' | 'webhooks';
  /** An upload waiting for room (uploads/uploads.ts): the tray shows it waiting. */
  upload?: string;
  /** Asks again for what was refused, once there is room (the upload, the invite). */
  retry?: () => unknown;
}
