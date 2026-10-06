// What the conversion moments read from a billing provider's answer (web/src/conversion/facts.ts) and what the first
// paint asks before their code is there (web/src/billing/due.ts): the trial and grace as rulers by calendar days, the
// banner's stage, the line's and the banner's room agreeing with what arrives (no layout shift), what a plan includes,
// the smallest step that fits (Team bills at least two; the add-on before a bigger plan), and a 402's extra fields.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { BillingInfo, BillingOffer } from '../../lib/types.ts';
import { bannerDue, trialLineDue } from '../../web/src/billing/due.ts';
import {
  addonOf,
  daysLeft,
  freeLimits,
  graceOf,
  includes,
  inUse,
  monthTotal,
  periodTotal,
  refusalOf,
  smallestFit,
  stageOf,
  trialOf,
  unitsOf,
} from '../../web/src/conversion/facts.ts';

const DAY = 86_400_000;
// local noon on a fixed day: the calendar arithmetic is the browser's own time zone, as it is here
const NOW = new Date(2026, 9, 5, 12, 0, 0).getTime();
const on = (days: number, h = 10, m = 12) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() + days);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};
const offer = (
  plan: string,
  name: string,
  month: number,
  year: number,
  perMember: boolean,
  min: number,
  max: number | null,
  base: number,
  each: number,
): BillingOffer => ({
  plan,
  name,
  perMember,
  members: { min, max },
  bytes: { base, perMember: each },
  activeVideos: null,
  prices: { eur: { month, year } },
  fits: true,
});
const OFFERS = [
  offer('solo', 'Solo', 1500, 14400, false, 1, 1, 5e11, 0),
  offer('team', 'Team', 2400, 24000, true, 2, 50, 1e12, 5e11),
  offer('business', 'Business', 4200, 42000, true, 1, null, 2e12, 1e12),
];
const trial: BillingInfo = {
  plan: 'team',
  planName: 'Team',
  state: 'trial',
  trialStartsAt: on(-4),
  trialEndsAt: on(10),
  usage: { members: 4, bytes: 230e9, activeVideos: 11 },
  limits: { members: 50, bytes: 3e12, activeVideos: null },
  manage: true,
  currency: 'eur',
  offers: OFFERS,
};
const b = (x: Partial<BillingInfo>): BillingInfo => ({ ...trial, ...x });

test('the trial as a ruler: day 5 of 14, 10 days left, by calendar days in the browser’s time zone', () => {
  assert.deepEqual(trialOf(trial, NOW), { day: 5, of: 14, left: 10, last: false, startsAt: on(-4), endsAt: on(10) });
  // without a start the trial is the usual 14 days before its end
  assert.equal(trialOf(b({ trialStartsAt: undefined }), NOW)?.of, 14);
  // the last three days are calm words and an amber keyframe, never hours
  assert.equal(trialOf(b({ trialEndsAt: on(3) }), NOW)?.last, true);
  assert.equal(trialOf(b({ trialEndsAt: on(4) }), NOW)?.last, false);
  // ends tomorrow / today: dates, not 24-hour spans (in 5 hours is today, at 01:00 tomorrow is tomorrow)
  assert.equal(daysLeft(on(0, 17, 0), NOW), 0);
  assert.equal(daysLeft(on(1, 1, 0), NOW), 1);
  assert.equal(daysLeft(on(-1), NOW), 0);
  // never past its own end on the ruler
  assert.equal(trialOf(b({ trialStartsAt: on(-20), trialEndsAt: on(0) }), NOW)?.day, 20);
  assert.equal(trialOf(b({ trialStartsAt: on(-14), trialEndsAt: on(0) }), NOW)?.day, 14);
  assert.equal(trialOf(b({ state: 'paid' }), NOW), null);
  assert.equal(trialOf(b({ complimentary: true }), NOW), null);
  assert.equal(trialOf(b({ trialEndsAt: 'not a date' }), NOW), null);
});

test('the grace week as a ruler of seven days, never a payment’s on the sidebar', () => {
  const g = b({ state: 'grace', reason: 'trial-ended', plan: 'free', planName: 'Free', graceUntil: on(6) });
  assert.deepEqual(graceOf(g, NOW), { day: 2, of: 7, until: on(6) });
  assert.equal(trialLineDue(g), true);
  assert.equal(trialLineDue(b({ state: 'grace', reason: 'payment', graceUntil: on(6) })), false);
  assert.equal(trialLineDue(b({ state: 'paid' })), false);
  assert.equal(trialLineDue(b({ complimentary: true })), false);
  assert.equal(trialLineDue(trial), true);
  assert.equal(trialLineDue(null), false);
});

test('the banner’s stage, and its room in the first paint agrees with it at every hour (nothing moves)', () => {
  assert.equal(stageOf(trial, NOW), null);
  assert.equal(stageOf(b({ trialEndsAt: on(3) }), NOW), 'soon');
  assert.equal(stageOf(b({ trialEndsAt: on(0, 23, 0) }), NOW), 'today');
  assert.equal(stageOf(b({ state: 'grace', reason: 'trial-ended', graceUntil: on(6) }), NOW), 'grace');
  assert.equal(stageOf(b({ state: 'read-only', reason: 'over-limit' }), NOW), 'ro');
  assert.equal(stageOf(b({ state: 'grace', reason: 'payment', graceUntil: on(6) }), NOW), 'pay');
  assert.equal(stageOf(b({ state: 'read-only', reason: 'payment' }), NOW), 'pay');
  assert.equal(stageOf(b({ state: 'paid' }), NOW), null);
  assert.equal(stageOf(b({ complimentary: true, trialEndsAt: on(1) }), NOW), null);
  // the room (billing/due.ts, in the first paint) and the banner (its chunk) say the same for every end and every hour:
  // before the fix the room went by 24-hour spans and the banner by dates, and 3.1 days before the end at 09:00 the room
  // was missing while the banner showed (the library dropped)
  for (let days = -1; days <= 6; days++)
    for (const h of [0, 1, 9, 10, 11, 12, 13, 22, 23]) {
      const x = b({ trialEndsAt: on(days, h, 30) });
      for (const hourNow of [0, 8, 12, 23]) {
        const now = new Date(NOW).setHours(hourNow, 5, 0, 0);
        assert.equal(bannerDue(x, now), stageOf(x, now) !== null, `ends in ${days} days at ${h}:30, now ${hourNow}:05`);
      }
    }
});

test('what a plan includes: never locked by guesswork', () => {
  assert.equal(includes(trial, 'insights'), true);
  assert.equal(includes(b({ features: { insights: false } }), 'insights'), false);
  assert.equal(includes(null, 'roles'), true);
  assert.equal(inUse(b({ features: { inUse: { webhooks: true } } }), 'webhooks'), true);
  assert.equal(inUse(trial, 'roles'), null);
});

test('prices as the picker says them: Team bills at least two, yearly per month is the year ÷ 12', () => {
  const team = OFFERS[1] as BillingOffer;
  assert.equal(unitsOf(team, 1), 2);
  assert.equal(unitsOf(team, 4), 4);
  assert.equal(monthTotal(team, 'year', 4, 'eur'), 8000);
  assert.equal(monthTotal(team, 'month', 4, 'eur'), 9600);
  assert.equal(monthTotal(team, 'year', 1, 'eur'), 4000);
  assert.equal(periodTotal(team, 'year', 2, 'eur'), 48000);
  assert.equal(monthTotal(team, 'year', 4, 'usd'), null);
});

test('the smallest step that fits: a plan for the people and bytes, the add-on before a bigger plan, the provider’s word first', () => {
  const free = b({ state: 'free', plan: 'free', planName: 'Free', usage: { members: 1, bytes: 9.4e9, activeVideos: 3 } });
  assert.equal(smallestFit(free, { bytes: 9.4e9 + 1.8e9 }), 'solo');
  assert.equal(smallestFit(free, { members: 2 }), 'team');
  assert.equal(smallestFit(b({ ...free, usage: { members: 4, bytes: 230e9, activeVideos: 11 } }), {}), 'team');
  const paid = b({ state: 'paid', subscribed: true, usage: { members: 4, bytes: 2.97e12, activeVideos: 11 } });
  // no add-on on sale: a bigger plan
  assert.equal(addonOf(paid), null);
  assert.equal(smallestFit(paid, { bytes: 2.97e12 + 64e9 }), 'business');
  // the provider sells it: one terabyte's price per the subscription's interval (8e's BillingInfo.addons)
  assert.equal(addonOf(b({ ...paid, interval: 'year', addons: { storageTB: 0, price: 0 } })), null);
  const sells = b({ ...paid, interval: 'year', addons: { storageTB: 0, price: 10000 } });
  assert.deepEqual(addonOf(sells), { tb: 0, month: null, year: 10000, currency: 'eur' });
  assert.deepEqual(addonOf(b({ ...paid, interval: 'month', addons: { storageTB: 1, price: 1000 } })), { tb: 1, month: 1000, year: null, currency: 'eur' });
  assert.equal(smallestFit(sells, { bytes: 2.97e12 + 64e9 }), 'addon:storage_tb');
  // what the provider said fits wins, when it is on offer here
  assert.equal(smallestFit(free, { bytes: 1 }, 'team'), 'team');
  assert.equal(smallestFit(free, { bytes: 1 }, 'addon:storage_tb'), 'solo');
  assert.equal(smallestFit(null, {}, 'team'), 'team');
});

test('Free’s limits: the provider’s when it is on Free, else the website’s', () => {
  assert.deepEqual(freeLimits(trial), { members: 1, bytes: 10e9, activeVideos: 3 });
  const onFree: BillingInfo = { ...trial, state: 'free', plan: 'free', limits: { members: 1, bytes: 5e9, activeVideos: 2 } };
  assert.deepEqual(freeLimits(onFree), { members: 1, bytes: 5e9, activeVideos: 2 });
});

test('a 402’s fields besides its sentence: what was asked for, the room, what fits; nothing else taken', () => {
  assert.deepEqual(refusalOf({ reason: 'storage', needed: 1.8e9, room: { videos: 3, bytes: 4.2e9 }, fits: 'solo', extra: 'x' }), {
    reason: 'storage',
    upgrade: undefined,
    messages: undefined,
    needed: 1.8e9,
    room: { videos: 3, bytes: 4.2e9 },
    fits: 'solo',
  });
  assert.equal(refusalOf({ room: { videos: 'three' } }).room, undefined);
  assert.deepEqual(refusalOf(undefined), { reason: undefined, upgrade: undefined, messages: undefined, needed: undefined, room: undefined, fits: undefined });
  assert.equal(DAY, 86_400_000);
});
