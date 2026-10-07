// What Settings → Billing and the billing banner say about a billing provider's answer (web/src/billing/words.ts), and
// the 402 sentence a plan's refusal shows (web/src/lib/refusal.ts): every state in English and German, the banner only
// where it matters (a trial's last three days, a grace period, read-only), prices as people read them.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { BillingInfo, BillingOffer } from '../../lib/types.ts';
import { bannerOf, billingSaid, day, daysUntil, gross, money, monthly, ofLimit, size, stateLabel, stateLine, vatRate } from '../../web/src/billing/words.ts';
import { de } from '../../web/src/i18n/de.ts';
import { setDictionary } from '../../web/src/i18n/index.ts';
import { refusalText } from '../../web/src/lib/refusal.ts';

const NOW = Date.parse('2026-10-03T10:00:00Z');
const DAY = 86_400_000;
const iso = (days: number) => new Date(NOW + days * DAY).toISOString();
const base: BillingInfo = {
  plan: 'team',
  planName: 'Team',
  state: 'trial',
  trialEndsAt: iso(14),
  usage: { members: 3, bytes: 4e11, activeVideos: 5 },
  limits: { members: 50, bytes: 2.5e12, activeVideos: null },
  manage: true,
};
const info = (x: Partial<BillingInfo>): BillingInfo => ({ ...base, ...x });

test('each state in one sentence and two words, in English', () => {
  setDictionary('en', null);
  assert.equal(stateLabel(base), 'Trial');
  // dates in the browser's own English (en-GB or en-US): built the same way here
  assert.equal(stateLine(base, NOW), `Everything in Team until ${day(iso(14))}, 14 days left. No card needed until you choose a plan.`);
  assert.match(stateLine(info({ trialEndsAt: iso(0.5) }), NOW), /, 1 day left\./);
  assert.equal(stateLine(info({ state: 'free', plan: 'free', planName: 'Free' }), NOW).startsWith('The free plan.'), true);
  assert.equal(stateLine(info({ state: 'paid', renewsAt: iso(30), interval: 'year' }), NOW), `Billed yearly, renews on ${day(iso(30))}.`);
  assert.equal(stateLine(info({ state: 'paid', renewsAt: iso(30), interval: 'month' }), NOW), `Billed monthly, renews on ${day(iso(30))}.`);
  assert.ok(stateLine(info({ state: 'paid', endsAt: iso(9) }), NOW).startsWith(`Cancelled: it ends on ${day(iso(9))}, then`));
  assert.equal(stateLabel(info({ state: 'paid', endsAt: iso(9) })), 'Ends soon');
  assert.equal(stateLine(info({ state: 'paid', planName: 'Complimentary' }), NOW), 'Nothing to pay for this workspace.');
  assert.ok(
    stateLine(info({ state: 'grace', reason: 'payment', graceUntil: iso(5) }), NOW).includes(`payment failed. Everything keeps working until ${day(iso(5))};`),
  );
  assert.match(stateLine(info({ state: 'grace', reason: 'trial-ended', graceUntil: iso(5) }), NOW), /^The trial has ended/);
  assert.match(stateLine(info({ state: 'read-only', reason: 'payment' }), NOW), /^Read-only until the last invoice is paid/);
  assert.match(stateLine(info({ state: 'read-only', reason: 'over-limit' }), NOW), /^Read-only: this workspace holds more than its plan allows/);
});

test('the banner: only a trial’s last three days, a grace period and read-only', () => {
  setDictionary('en', null);
  assert.equal(bannerOf(base, NOW), null, 'a trial with days to go says nothing');
  assert.equal(bannerOf(info({ state: 'free' }), NOW), null);
  assert.equal(bannerOf(info({ state: 'paid' }), NOW), null);
  assert.equal(bannerOf(null, NOW), null);
  assert.deepEqual(bannerOf(info({ trialEndsAt: iso(2.2) }), NOW), {
    tone: 'warn',
    text: 'The trial ends in 3 days. Choose a plan to keep everything as it is.',
  });
  assert.equal(bannerOf(info({ trialEndsAt: iso(0.4) }), NOW)?.text, 'The trial ends in 1 day. Choose a plan to keep everything as it is.');
  assert.equal(bannerOf(info({ trialEndsAt: iso(-0.1) }), NOW)?.text, 'The trial ends today. Choose a plan to keep everything as it is.');
  assert.equal(bannerOf(info({ state: 'grace', reason: 'payment', graceUntil: iso(5) }), NOW)?.tone, 'warn');
  assert.equal(bannerOf(info({ state: 'read-only', reason: 'over-limit' }), NOW)?.tone, 'bad');
  assert.equal(daysUntil(iso(-3), NOW), 0);
});

test('German, du', () => {
  setDictionary('de', de);
  try {
    assert.equal(stateLabel(base), 'Testphase');
    assert.match(stateLine(base, NOW), /^Alles aus Team bis zum 17\. Oktober 2026, noch 14 Tage\./);
    assert.equal(bannerOf(info({ trialEndsAt: iso(0.4) }), NOW)?.text, 'Die Testphase endet in 1 Tag. Wähle einen Plan, dann bleibt alles, wie es ist.');
    assert.match(
      stateLine(info({ state: 'grace', reason: 'payment', graceUntil: iso(5) }), NOW),
      /^Die letzte Zahlung ist fehlgeschlagen\. Bis zum 8\. Oktober 2026/,
    );
    assert.equal(ofLimit('3', '50'), '3 von 50');
    assert.equal(size(2.5e12), '2,5 TB');
    assert.equal(money(2400, 'eur').replace(/\s/g, ' '), '24 €');
  } finally {
    setDictionary('en', null);
  }
});

test('prices and sizes as people read them: yearly shown per month, minor units, decimal storage', () => {
  setDictionary('en', null);
  const team: BillingOffer = {
    plan: 'team',
    name: 'Team',
    perMember: true,
    members: { min: 2, max: 50 },
    bytes: { base: 1e12, perMember: 5e11 },
    activeVideos: null,
    prices: { eur: { month: 2400, year: 24000 }, usd: { month: 2400, year: 24000 } },
    fits: true,
  };
  assert.equal(monthly(team, 'year', 'eur'), 2000);
  assert.equal(monthly(team, 'month', 'usd'), 2400);
  assert.equal(monthly(team, 'month', 'chf'), null);
  assert.match(money(2000, 'eur'), /€20$|^€20/);
  assert.match(money(1250, 'usd'), /\$12\.50/);
  assert.equal(size(1e10), '10 GB');
  assert.equal(size(4e11), '400 GB');
  assert.equal(size(2.5e12), '2.5 TB');
  assert.equal(size(5e8), '500 MB');
  assert.equal(ofLimit('3', null), '3', 'no limit: just the number');
  assert.equal(ofLimit('3', '50'), '3 of 50');
});

test('consumers see prices with the VAT the provider names, to the cent (PAngV, A13 CLOUD-2); none named: as they are', () => {
  setDictionary('en', null);
  const vat = { vat: { rate: 19 } };
  // Solo €12 a month billed yearly, €144 a year; Team €20 per member, €240 a year; one more terabyte €10; Business €42
  assert.deepEqual(
    [1200, 14400, 2000, 24000, 1000, 4200].map((m) => gross(m, vat)),
    [1428, 17136, 2380, 28560, 1190, 4998],
  );
  assert.equal(money(gross(1200, vat), 'eur'), '€14.28');
  assert.equal(gross(1200, {}), 1200, 'a provider that names no rate: the price as it is');
  assert.equal(vatRate(19), '19%');
  setDictionary('de', de);
  assert.match(vatRate(19), /^19\s%$/, 'German keeps its no-break space');
  setDictionary('en', null);
});

test('a plan’s refusal: the provider’s sentence in the page’s language, else ours for its reason', () => {
  setDictionary('en', null);
  assert.equal(refusalText('Free is for one person.', { reason: 'members' }), 'Free is for one person.', 'English: the provider’s own');
  setDictionary('de', de);
  try {
    assert.equal(refusalText('Free is for one person.', { reason: 'members', messages: { de: 'Free ist für eine Person.' } }), 'Free ist für eine Person.');
    assert.equal(refusalText('Free is for one person.', { reason: 'members' }), 'Der Plan dieses Workspace hat keinen Platz für ein weiteres Mitglied.');
    assert.match(refusalText('x', { reason: 'storage' }), /keinen Speicher mehr/);
    assert.match(refusalText('x', { reason: 'payment' }), /Zahlung ist fehlgeschlagen/);
    assert.match(refusalText('x', { reason: 'read-only' }), /nur lesbar/);
    assert.match(refusalText('x', {}), /nur lesbar/, 'an unknown reason: read-only');
  } finally {
    setDictionary('en', null);
  }
});

test('a billing provider’s refusal: its own sentence in English, ours in German for a code we know', () => {
  // what the web's api() throws for a module's `{error, code}` (an ApiError: its message, status and details)
  const refused = (code: string, error: string) => Object.assign(new Error(error), { status: 409, details: { code } });
  const already = refused('already-subscribed', 'This workspace already has a subscription: change the plan in Billing instead.');
  const team = refused('too-many-members', 'Team has room for 50 members; this workspace has 51. Choose Business.');
  const odd = refused('something-new', 'A sentence only the provider has.');
  setDictionary('en', null);
  assert.equal(billingSaid(already), already.message, 'English: the provider’s words, numbers and all');
  assert.equal(billingSaid(team), team.message);
  setDictionary('de', de);
  try {
    assert.equal(billingSaid(already), 'Dieser Workspace hat schon einen Plan: Ändere ihn stattdessen unter Abrechnung.');
    assert.match(billingSaid(team), /mehr Mitglieder/);
    assert.equal(
      billingSaid(refused('slow-down', 'Too many attempts: wait a minute.')),
      'Zu viele Versuche: Warte eine Minute und versuch es dann noch einmal.',
    );
    assert.equal(billingSaid(odd), odd.message, 'a code we don’t know: the provider’s sentence as it is');
    assert.equal(billingSaid(new Error('offline')), 'offline', 'no code at all');
  } finally {
    setDictionary('en', null);
  }
});
