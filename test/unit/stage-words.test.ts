// How the UI says a stage (web/src/status/stageText.ts): lib/stage.ts writes "client" for agents, the UI never does —
// in English and in German, the stage, its count, its one line and what it waits for.
import assert from 'node:assert/strict';
import test from 'node:test';
import { stageOf } from '../../lib/stage.ts';
import type { ApprovalEntry, Review, ShareSignal } from '../../lib/types.ts';
import { de } from '../../web/src/i18n/de.ts';
import { setDictionary } from '../../web/src/i18n/index.ts';
import { nextLabel, stageDetail, stageLabel, stepLabels, summaryLine } from '../../web/src/status/stageText.ts';
import { pillLabel } from '../../web/src/status/stageUi.ts';

const T = '2026-09-28T10:00:00+02:00';
type R = Parameters<typeof stageOf>[0];
const review = (approvals: ApprovalEntry[], comments: Review['comments'] = []): R => ({
  versions: [{ v: 1 } as Review['versions'][number]],
  comments,
  approvals,
  session: null,
});
const verdict = (party: ApprovalEntry['party'], status: ApprovalEntry['status'], note: string | null = null): ApprovalEntry => ({
  party,
  status,
  v: 1,
  by: party === 'client' ? 'guest:Mia' : 'alex',
  at: T,
  note,
});
const link = (o: Partial<ShareSignal> = {}): ShareSignal => ({
  label: 'For Mia',
  kind: 'video',
  opened: false,
  opens: 0,
  last_opened: null,
  seen_v: null,
  by: null,
  reviewers: [],
  ...o,
});

const approvedByLink = stageOf(review([verdict('team', 'approved'), verdict('client', 'approved')]));
const changesByLink = stageOf(review([verdict('client', 'changes', 'Logo bigger')]));
const outForReview = stageOf(review([verdict('team', 'approved')]), { share: link({ opened: true, opens: 1, by: 'Mia' }) });
const notOpened = stageOf(review([verdict('team', 'approved')]), { linked: true, share: link() });
const toShare = stageOf(review([verdict('team', 'approved')]));

test('agents keep their words: lib/stage.ts still says "client"', () => {
  assert.equal(approvedByLink.detail, 'Client approved V1 (Mia)');
  assert.equal(changesByLink.detail, 'Changes requested on V1 (client: Mia): Logo bigger');
  assert.equal(outForReview.next.label, "Waiting for the client's verdict");
});

test('English: no "client" in what people read', () => {
  setDictionary('en', null);
  assert.equal(stageLabel('with_client'), 'Out for review');
  assert.equal(stageLabel('client_approved'), 'Approved via link');
  assert.equal(pillLabel(approvedByLink), 'Approved V1 via link');
  assert.equal(stageDetail(approvedByLink), 'Mia approved V1 via review link');
  assert.equal(stageDetail(changesByLink), 'Changes requested on V1 (Mia via review link): Logo bigger');
  assert.equal(nextLabel(outForReview.next), 'Waiting for their decision');
  assert.equal(nextLabel(notOpened.next), 'Waiting for the link to be opened');
  assert.equal(nextLabel(toShare.next), 'Send out for review');
  assert.equal(summaryLine(['with_client', 'with_client', 'client_approved']), '1 approved via link · 2 out for review');
  assert.deepEqual(stepLabels(), ['Review', 'Fixes', 'Approved', 'Shared', 'Final']);
  // the rest is the server's English, as it was
  assert.equal(stageDetail(outForReview), outForReview.detail);
  assert.equal(stageDetail(notOpened), 'Approved V1 · shared via "For Mia" · not opened yet');
  for (const s of [approvedByLink, changesByLink, outForReview, notOpened, toShare])
    assert.doesNotMatch(`${stageLabel(s.stage)} ${pillLabel(s)} ${stageDetail(s)} ${nextLabel(s.next)}`, /client/i);
});

test('German: no "Kunde" either', () => {
  setDictionary('de', de);
  try {
    assert.equal(stageLabel('with_client'), 'In Abstimmung');
    assert.equal(stageDetail(approvedByLink), 'Mia hat V1 über den Review-Link freigegeben');
    assert.equal(nextLabel(outForReview.next), 'Wartet auf eine Entscheidung');
    for (const s of [approvedByLink, changesByLink, outForReview, notOpened, toShare])
      assert.doesNotMatch(`${stageLabel(s.stage)} ${pillLabel(s)} ${stageDetail(s)} ${nextLabel(s.next)}`, /kunde|client/i);
  } finally {
    setDictionary('en', null);
  }
});

// Whoever reviews through a link is never a "client" in UI text — not the stage only, any string (AGENTS.md's
// vocabulary): the link's name, "via review link", "people you share with", "visitors". "Client" stays where it is
// the software: an MCP, OAuth or API client, its id and secret.
const TECHNICAL = /\b(?:MCP|OAuth|API|HTTP)[ -]clients?\b|\bOther client\b/gi;
const TECHNICAL_KEYS = new Set<string>([
  'Client ID', // an OAuth client's (Settings → Publishing)
  'Client secret',
  '2 · Its client here',
  'Lampo forgets its client and its Google sign-in, and asks Google to end that sign-in. Posts that went out through it stay where they are.',
  'Set LAMPO_TOKEN to your API token (Settings → API tokens) before starting the client.', // the MCP client
  '<0>Push over HTTP</0>: clients that listen (<1>subscriptions/listen</1>) hear the moment a video’s notes change.',
]);

test('no UI string calls the people on a review link "client" (English) or "Kunde" (German)', async () => {
  const { EN } = await import('../../web/src/i18n/en.ts');
  const said = (EN as readonly string[])
    .filter((k) => !TECHNICAL_KEYS.has(k.replace(/^client::/, '')))
    // `client::` is the namespace of the review-link pages' strings, not a word in them
    .filter((k) => /\bclients?\b/i.test(k.replace(/^client::/, '').replace(TECHNICAL, '')));
  assert.deepEqual(said, [], 'say the link’s name, “via review link”, “people you share with” or “visitors” instead');
  const german = Object.entries(de as Record<string, string>).filter(([, v]) => /\bkund(?:e|en|in|innen)\b/i.test(v));
  assert.deepEqual(german, [], '„über den Review-Link“, „Besucher“ oder der Name statt „Kunde“');
});
