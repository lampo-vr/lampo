// What a limit's sheet says (web/src/conversion/limits/model.ts) for each state of the build spec, from the plan's answer
// and what was asked for: the smallest step that fits (Solo for room on Free, one more terabyte on a paid Team, Team for
// a second person or Insights — billed for at least two), its price as the picker says it, what changes now → then, the
// head's sentence and the button's words, in English and German; and what a 402 carries beside its sentence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { BillingInfo, BillingOffer } from '../../lib/types.ts';
import { refusalOf } from '../../web/src/conversion/facts.ts';
import {
  changeRows,
  contractMail,
  fitFor,
  keepOf,
  ledeOf,
  nameFromAddress,
  needOf,
  payLabel,
  priceOf,
  reasonOf,
  saving,
  titleOf,
} from '../../web/src/conversion/limits/model.ts';
import { de } from '../../web/src/i18n/de.ts';
import { setDictionary } from '../../web/src/i18n/index.ts';

const offer = (plan: string, name: string, o: Partial<BillingOffer>): BillingOffer => ({
  plan,
  name,
  perMember: false,
  members: { min: 1, max: 1 },
  bytes: { base: 5e11, perMember: 0 },
  activeVideos: null,
  prices: {},
  fits: true,
  ...o,
});
// the website's prices, in cents: Solo €15/€144, Team €24/€240 per member, Business €42/€420 per member
const OFFERS: BillingOffer[] = [
  offer('solo', 'Solo', { prices: { eur: { month: 1500, year: 14400 } } }),
  offer('team', 'Team', {
    perMember: true,
    members: { min: 2, max: 50 },
    bytes: { base: 1e12, perMember: 5e11 },
    prices: { eur: { month: 2400, year: 24000 } },
  }),
  offer('business', 'Business', {
    perMember: true,
    members: { min: 1, max: null },
    bytes: { base: 2e12, perMember: 1e12 },
    prices: { eur: { month: 4200, year: 42000 } },
  }),
];
const free: BillingInfo = {
  plan: 'free',
  planName: 'Free',
  state: 'free',
  usage: { members: 1, bytes: 9.4e9, activeVideos: 3 },
  limits: { members: 1, bytes: 10e9, activeVideos: 3 },
  manage: true,
  currency: 'eur',
  offers: OFFERS,
  features: { insights: false, roles: false, webhooks: false },
};
const team: BillingInfo = {
  plan: 'team',
  planName: 'Team',
  state: 'paid',
  subscribed: true,
  interval: 'year',
  seats: 4,
  usage: { members: 4, bytes: 2.969e12, activeVideos: 11 },
  limits: { members: 50, bytes: 3e12, activeVideos: null },
  manage: true,
  currency: 'eur',
  offers: OFFERS,
  addons: { storageTB: 0, price: 10000 },
};

test('3a: an upload on Free that needs room: Solo fits, priced as the picker says, the upload waits', () => {
  setDictionary('en', null);
  const ask = { reason: 'storage', needed: 1.8e9, name: 'fjord-hotel-rooms-v3.mov', upload: 'u1', room: { videos: 3, bytes: 4.2e9 } };
  const reason = reasonOf(ask);
  assert.equal(reason, 'storage');
  if (!reason) return;
  const fit = fitFor(free, ask, reason);
  assert.equal(fit.kind === 'plan' && fit.offer.plan, 'solo');
  if (fit.kind !== 'plan') return;
  assert.equal(titleOf(reason, ask, 'Costa Cuts', fit), 'fjord-hotel-rooms-v3.mov needs more room');
  assert.match(ledeOf(reason, ask, free, 'Costa Cuts', fit), /^It’s 1\.8 GB, and Costa Cuts has 600 MB of Free’s 10 GB left\. The upload waits;/);
  assert.deepEqual(priceOf(fit.offer, 'year', 1, 'eur'), { big: '€12', per: 'a month', sub: '€144 billed yearly' });
  assert.equal(priceOf(fit.offer, 'month', 1, 'eur')?.sub, 'Billed monthly · €12 if yearly');
  assert.equal(saving(fit.offer, 'eur'), 'save 20%');
  const rows = changeRows(free, fit, reason, needOf(free, ask, reason));
  assert.deepEqual(
    rows.map((r) => [r.k, r.now, r.next, !!r.same]),
    [
      ['Storage', '10 GB', '500 GB', false],
      ['Videos under review', '3 at a time', 'No limit', false],
      ['Review links', 'Lampo badge', 'Hide the Lampo badge', false],
      ['Members', '1', '1', true],
    ],
  );
  assert.equal(keepOf(reason, fit), 'Your videos, notes and review links stay as they are.');
  assert.equal(payLabel(reason, fit, ask, '€171.36', false), 'Pay €171.36 and upload');
});

test('3b: an upload on a paid Team that needs room: one more terabyte, paid with the card on file', () => {
  setDictionary('en', null);
  const ask = { reason: 'storage', needed: 64e9, name: 'pinewood-brand-film-90s_V7.mov', upload: 'u2' };
  const fit = fitFor(team, ask, 'storage');
  assert.deepEqual(fit, { kind: 'addon', tb: 1, month: null, year: 10000, currency: 'eur' });
  assert.match(
    ledeOf('storage', ask, team, 'Northwind', fit),
    /Northwind has 31 GB of Team’s 3 TB left\. One more terabyte is the smallest step; the plan stays Team\.$/,
  );
  assert.deepEqual(
    changeRows(team, fit, 'storage', needOf(team, ask, 'storage')).map((r) => [r.k, r.now, r.next, !!r.same]),
    [
      ['Storage', '3 TB', '4 TB', false],
      ['Plan', 'Team', 'Team', true],
    ],
  );
  assert.equal(payLabel('storage', fit, ask, null, false), 'Add 1 TB and upload');
  // without an add-on on sale, a bigger plan is the answer (never an invented price)
  const plain = fitFor({ ...team, addons: undefined }, ask, 'storage');
  assert.equal(plain.kind === 'plan' && plain.offer.plan, 'business');
});

test('3c: a second person on Free: Team for two, the button invites them', () => {
  setDictionary('en', null);
  const ask = { reason: 'members', needed: 'ben.kruse@example.com', name: 'Ben' };
  const fit = fitFor(free, ask, 'members');
  assert.equal(fit.kind === 'plan' && fit.offer.plan, 'team');
  if (fit.kind !== 'plan') return;
  assert.equal(titleOf('members', ask, 'Costa Cuts', fit), 'Bring Ben into Costa Cuts');
  assert.equal(ledeOf('members', ask, free, 'Costa Cuts', fit), 'Free is for one person. Team has room for 2 to 50: Ben gets an account of their own.');
  assert.deepEqual(priceOf(fit.offer, 'year', 2, 'eur'), { big: '€40', per: 'a month for 2', sub: '€480 billed yearly · €20 per member' });
  assert.equal(saving(fit.offer, 'eur'), '2 months free');
  const rows = changeRows(free, fit, 'members', needOf(free, ask, 'members'));
  assert.deepEqual(rows[0], { k: 'Members', now: '1', next: '2 · up to 50' });
  assert.ok(rows.some((r) => r.k === 'Roles, Insights, webhooks' && r.next === 'Included'));
  assert.equal(payLabel('members', fit, ask, '€571.20', false), 'Pay €571.20 and invite Ben');
  assert.equal(payLabel('members', fit, ask, null, true), 'Switch to Team and invite Ben');
});

test('3e: Insights on Free: Team, billed for two while someone works alone, said in the first sentence', () => {
  setDictionary('en', null);
  const ask = { feature: 'insights' as const };
  const fit = fitFor(free, ask, 'feature');
  assert.equal(fit.kind === 'plan' && fit.offer.plan, 'team');
  if (fit.kind !== 'plan') return;
  assert.equal(titleOf('feature', ask, 'Costa Cuts', fit), 'Insights come with Team');
  assert.match(ledeOf('feature', ask, free, 'Costa Cuts', fit), /^Team is for 2 to 50 members, so it is billed for 2 while you work alone\./);
  // the price is for the two it bills, not the one person there is
  assert.equal(priceOf(fit.offer, 'year', 1, 'eur')?.big, '€40');
  assert.equal(changeRows(free, fit, 'feature', needOf(free, ask, 'feature'))[0].next, 'From today’s data on');
});

test('in German, du', () => {
  setDictionary('de', de);
  try {
    const ask = { reason: 'storage', needed: 1.8e9, name: 'fjord.mov', upload: 'u1' };
    const fit = fitFor(free, ask, 'storage');
    assert.equal(titleOf('storage', ask, 'Costa Cuts', fit), 'fjord.mov braucht mehr Platz');
    assert.match(
      ledeOf('storage', ask, free, 'Costa Cuts', fit),
      /^Die Datei hat 1,8 GB, und Costa Cuts hat von den 10 GB auf Free noch 600 MB frei\. Der Upload wartet;/,
    );
    assert.equal(payLabel('storage', fit, ask, '171,36 €', false), '171,36 € bezahlen und hochladen');
    // German puts a no-break space between the amount and the euro sign
    if (fit.kind === 'plan') assert.match(priceOf(fit.offer, 'year', 1, 'eur')?.sub ?? '', /^144\s€ jährlich abgerechnet$/);
  } finally {
    setDictionary('en', null);
  }
});

test('a 402’s body: its numbers and plan id, nothing else; a first name read off an address', () => {
  assert.deepEqual(refusalOf({ reason: 'storage', needed: 5, room: { videos: 1, bytes: 2 }, fits: 'solo', extra: 'x' }), {
    reason: 'storage',
    upgrade: undefined,
    messages: undefined,
    needed: 5,
    room: { videos: 1, bytes: 2 },
    fits: 'solo',
  });
  assert.equal(refusalOf({ room: { videos: 'a' } }).room, undefined);
  assert.equal(nameFromAddress('ben.kruse@example.com'), 'Ben');
  assert.equal(nameFromAddress('x1@example.com'), null);
});

test('"Talk to us" names its address wherever it shows: one address, never a bare mailto:', () => {
  assert.match(contractMail(), /^mailto:[^@?\s]+@[^?\s]+\?subject=/);
  const root = path.join(import.meta.dirname, '../../web/src');
  const files = (fs.readdirSync(root, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f));
  const bare = files.filter((f) => /['"`]mailto:['"`?]/.test(fs.readFileSync(path.join(root, f), 'utf8')));
  assert.deepEqual(bare, [], 'a mailto: link without an address');
});
