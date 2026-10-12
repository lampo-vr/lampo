// What the stage's card says (web/src/status/stageFacts.ts): the version once (the head's), short facts one a line, the
// next step as words — built from the fields lib/stage.ts writes its one-line detail from, which itself stays as it was
// for the library card, the board and the inbox. In English and in German, never "client".
import assert from 'node:assert/strict';
import test from 'node:test';
import { stageOf } from '../../lib/stage.ts';
import type { ApprovalEntry, Review, ShareSignal } from '../../lib/types.ts';
import { de } from '../../web/src/i18n/de.ts';
import { setDictionary } from '../../web/src/i18n/index.ts';
import { nextWords, stageFacts, stageVersion } from '../../web/src/status/stageFacts.ts';
import { nextLabel } from '../../web/src/status/stageText.ts';

type R = Parameters<typeof stageOf>[0];
type Note = Review['comments'][number];
const T = '2026-09-28T10:00:00+02:00';
// "2 h ago" is said from the clock's now (web/src/lib/format.ts ago)
const NOW = Date.now();
const versions = (n = 4) => Array.from({ length: n }, (_, i) => ({ v: i + 1 }) as Review['versions'][number]);
let ids = 0;
const note = (status: Note['status'], extra: Partial<Note> = {}): Note => ({ id: `n${ids++}`, status, severity: 'must', kind: 'feedback', ...extra }) as Note;
const review = (o: Partial<R> = {}): R => ({ versions: versions(), comments: [], approvals: [], session: null, ...o });
const team = (status: ApprovalEntry['status'], v = 4, note: string | null = null): ApprovalEntry => ({ party: 'team', status, v, by: 'alex', at: T, note });
const viaLink = (status: ApprovalEntry['status'], note: string | null = null): ApprovalEntry => ({
  party: 'client',
  status,
  v: 4,
  by: 'guest:Mia',
  at: T,
  note,
});
const link = (o: Partial<ShareSignal> = {}): ShareSignal => ({
  label: 'Spring',
  kind: 'video',
  opened: false,
  opens: 0,
  last_opened: null,
  seen_v: null,
  by: null,
  reviewers: [],
  ...o,
});
const next = (s: ReturnType<typeof stageOf>) => nextWords(s.next, nextLabel(s.next));

// the maintainer's picture: a note still open and four fixes to check in V4, no agent assigned
const fixes = stageOf(review({ comments: [note('open'), note('fixed'), note('fixed'), note('fixed'), note('fixed')] }), { now: NOW });

test('the picture: the version once, one fact a line, "Next: Assign an agent" — the one-line detail unchanged', () => {
  setDictionary('en', null);
  assert.equal(fixes.detail, '1 note open on V4 · 4 fixes to check in V4', 'what agents and the other places read stays');
  assert.equal(stageVersion(fixes), 'V4');
  assert.deepEqual(stageFacts(fixes), ['4 fixes to check', '1 note open']);
  assert.equal(next(fixes), 'Next: Assign an agent');
});

test('every stage, said in facts', () => {
  setDictionary('en', null);
  const opened = new Date(NOW - 2 * 3600_000).toISOString();
  const out = stageOf(review({ approvals: [team('approved')] }), {
    now: NOW,
    share: link({ opened: true, opens: 3, last_opened: opened, seen_v: 4, by: 'Mia', watched: 0.8, watched_by: 'Mia' }),
  });
  assert.deepEqual(stageFacts(out).slice(0, 2), ['Approved by alex', 'Opened by Mia · 2 h ago']);
  // the line of who watched it stays as it is, and names the link (no "Review link" line beside it)
  assert.match(stageFacts(out)[2] ?? '', /^Mia watched 80\s?% of V4 through “Spring”$/);
  assert.equal(stageFacts(out).length, 3);
  assert.equal(next(out), 'Waiting for their decision', 'a wait reads as it is, no "Next:"');

  const notOpened = stageOf(review({ approvals: [team('approved')] }), { now: NOW, linked: true, share: link() });
  assert.deepEqual(stageFacts(notOpened), ['Approved by alex', 'Review link “Spring”', 'Link not opened']);
  const seenBefore = stageOf(review({ approvals: [team('approved')] }), { now: NOW, share: link({ opens: 2, seen_v: 3 }) });
  assert.deepEqual(stageFacts(seenBefore), ['Approved by alex', 'Review link “Spring”', 'Opened before this version']);

  const byLink = stageOf(review({ approvals: [team('approved'), viaLink('approved')], comments: [note('open')] }), { now: NOW });
  assert.deepEqual(stageFacts(byLink), ['Approved by Mia via review link', '1 note still open']);
  assert.equal(next(byLink), 'Next: Mark final');

  const changes = stageOf(review({ approvals: [viaLink('changes', 'Logo bigger')] }), { now: NOW });
  assert.deepEqual(stageFacts(changes), ['Changes requested by Mia via review link', '“Logo bigger”']);
  const teamChanges = stageOf(review({ approvals: [team('changes')] }), { now: NOW });
  assert.deepEqual(stageFacts(teamChanges), ['Changes requested by alex']);

  const riding = stageOf(review({ comments: [note('open', { fix_pending: true }), note('fixed')] }), { now: NOW });
  assert.deepEqual(stageFacts(riding), ['1 fix to check', '1 fix coming in V5'], 'another version is said: the one the fix comes with');

  const preview = stageOf(review({ comments: [note('verified', { verified_on: { preview: 'p1', v: 4 } })] }), { now: NOW });
  assert.deepEqual(stageFacts(preview), ['1 fix checked on a preview, not rendered yet']);
  assert.equal(next(preview), 'Next: Assign an agent', 'an agent renders them');

  const stale = stageOf(review({ approvals: [team('approved', 3)] }), { now: NOW });
  assert.deepEqual(stageFacts(stale), ['V3 approved']);
  const identical = stageOf(review({ approvals: [team('approved', 3)] }), { now: NOW, identical: true });
  assert.deepEqual(stageFacts(identical), ['Identical to approved V3']);

  const final = stageOf(review({ approvals: [team('approved')], final: { v: 4, by: 'alex', at: T, note: null } }), { now: NOW });
  assert.equal(stageVersion(final), 'V4');
  assert.deepEqual(stageFacts(final), ['Marked final by alex']);
  const superseded = stageOf(review({ versions: versions(5), final: { v: 4, by: 'alex', at: T, note: null } }), { now: NOW });
  assert.equal(stageVersion(superseded), 'V4', 'the head says the final version');
  assert.deepEqual(stageFacts(superseded), ['V5 arrived since']);

  const part = stageOf(review({ versions: [...versions(3), { v: 4, part: { of: 3, at: 10, frames: 20 } } as Review['versions'][number]] }), { now: NOW });
  assert.equal(stageVersion(part), 'V4 (part)');

  for (const s of [fixes, out, notOpened, seenBefore, byLink, changes, teamChanges, riding, preview, stale, final])
    assert.doesNotMatch(`${stageFacts(s).join(' ')} ${next(s)}`, /client/i);
});

test('an agent at work: its own words are a fact, the counts the rest', () => {
  setDictionary('en', null);
  const until = new Date(NOW + 600_000).toISOString();
  const words = stageOf(review({ comments: [note('open')], agent_status: { text: 'rendering V5', by: 'agent:cutter', at: T, until } }), { now: NOW });
  assert.equal(words.stage, 'in_progress');
  assert.deepEqual(stageFacts(words), ['rendering V5 (cutter)', '1 note open']);
  assert.equal(next(words), 'An agent is on it');
  const counted = stageOf(review({ comments: [note('open'), note('fixed')], session: { name: 'cutter', id: 's1' } as R['session'] }), {
    now: NOW,
    sessionActive: true,
  });
  assert.equal(counted.stage, 'in_progress');
  assert.deepEqual(stageFacts(counted), ['1 fix to check', '1 note open'], 'no run-on line beside the counts');
});

test('German: the same facts, never "Kunde"', () => {
  setDictionary('de', de);
  try {
    assert.deepEqual(stageFacts(fixes), ['4 Korrekturen zu prüfen', '1 Notiz offen']);
    assert.equal(next(fixes), 'Als Nächstes: Einen Agenten zuweisen');
    const byLink = stageOf(review({ approvals: [team('approved'), viaLink('approved')] }), { now: NOW });
    assert.deepEqual(stageFacts(byLink), ['Von Mia über den Review-Link freigegeben']);
    assert.doesNotMatch(stageFacts(byLink).join(' '), /kunde|client/i);
  } finally {
    setDictionary('en', null);
  }
});
