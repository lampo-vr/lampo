// The library's rules (web/src/library/model.ts): which videos a view covers, filters, order and sections.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Stage, StageInfo } from '../../lib/types.ts';
import type { VideoSummary } from '../../web/src/api/types.ts';
import {
  activity,
  applyFilters,
  clientState,
  decodeRules,
  encodeRules,
  fieldOptions,
  groupVideos,
  laneCounts,
  lanes,
  scope,
  sortVideos,
  summaryLine,
  toggleRule,
} from '../../web/src/library/model.ts';

let n = 0;
interface Fixture {
  name: string;
  folder?: string | null;
  stage?: Stage;
  open?: number;
  must?: number;
  fixed?: number;
  at?: string;
  session?: string;
  archived?: boolean;
}
function video(o: Fixture): VideoSummary {
  n++;
  return {
    slug: `s${n}`,
    video: `/x/${o.name}`,
    name: o.name,
    folder: o.folder ?? null,
    stage: { stage: o.stage ?? 'to_review' } as StageInfo,
    counts: { open: o.open ?? 0, must: o.must ?? 0, fixed: o.fixed ?? 0 },
    session: o.session ? { name: o.session } : null,
    archived: o.archived ?? null,
    added: '2026-09-01T10:00:00+02:00',
    mtime: o.at ?? '2026-09-01T10:00:00+02:00',
    lastComment: '',
  } as unknown as VideoSummary;
}

const spot = video({ name: 'spot.mp4', folder: 'Acme/Reels', stage: 'changes', open: 2, must: 1, at: '2026-09-28T09:00:00Z' });
const teaser = video({ name: 'Teaser Überblendung.mp4', folder: 'Acme', stage: 'final', at: '2026-09-28T10:30:00+02:00', session: 'edit' });
const reel = video({ name: 'reel.mp4', folder: 'Globex/Social', stage: 'check_fixes', fixed: 1, at: '2026-09-27T10:00:00Z' });
const loose = video({ name: 'loose.mp4', stage: 'with_client', at: '2026-09-26T10:00:00Z' });
const old = video({ name: 'old.mp4', folder: 'Acme', stage: 'team_approved', archived: true });
const all = [spot, teaser, reel, loose, old];
const names = (l: VideoSummary[]) => l.map((v) => v.name);
const none = { q: '', session: '', lane: 'all' as const, archived: false };

test('scope: a folder view covers its subfolders; the other views filter by what they are about', () => {
  assert.deepEqual(names(scope(all, { kind: 'folder', id: 'Acme' })), ['spot.mp4', 'Teaser Überblendung.mp4', 'old.mp4']);
  assert.deepEqual(names(scope(all, { kind: 'unsorted' })), ['loose.mp4']);
  assert.deepEqual(names(scope(all, { kind: 'session', id: 'edit' })), ['Teaser Überblendung.mp4']);
});

test('filters: archived hidden by default, every word must match, umlauts folded, lanes, sessions', () => {
  assert.ok(!applyFilters(all, none).includes(old));
  assert.ok(applyFilters(all, { ...none, archived: true }).includes(old));
  assert.deepEqual(names(applyFilters(all, { ...none, q: 'uberblendung acme' })), ['Teaser Überblendung.mp4']);
  assert.deepEqual(names(applyFilters(all, { ...none, q: 'ÜBER' })), ['Teaser Überblendung.mp4']);
  assert.deepEqual(names(applyFilters(all, { ...none, q: 'reels' })), ['spot.mp4'], 'folder names match too');
  assert.deepEqual(names(applyFilters(all, { ...none, lane: 'needs_you' })), ['reel.mp4']);
  assert.deepEqual(names(applyFilters(all, { ...none, lane: 'approved' })), ['loose.mp4']);
  assert.deepEqual(names(applyFilters(all, { ...none, session: '-' })), ['spot.mp4', 'reel.mp4', 'loose.mp4']);
});

test('sort: recent compares instants (mixed offsets), stage puts the work first, open puts musts first', () => {
  // 10:30+02:00 is 08:30Z, before spot's 09:00Z, although it sorts after it as a string.
  assert.deepEqual(names(sortVideos([spot, teaser, reel], 'recent')), ['spot.mp4', 'Teaser Überblendung.mp4', 'reel.mp4']);
  assert.equal(activity(teaser), '2026-09-28T10:30:00+02:00');
  assert.deepEqual(names(sortVideos([teaser, loose, spot, reel], 'stage')), ['spot.mp4', 'reel.mp4', 'loose.mp4', 'Teaser Überblendung.mp4']);
  assert.deepEqual(names(sortVideos([reel, spot], 'open')), ['spot.mp4', 'reel.mp4']);
  assert.deepEqual(names(sortVideos([video({ name: 'ep10.mp4' }), video({ name: 'ep2.mp4' })], 'name')), ['ep2.mp4', 'ep10.mp4']);
});

test('groups: projects library-wide (unsorted last), the folder then its subfolders in a folder view, lanes by stage', () => {
  const live = [spot, teaser, reel, loose];
  assert.deepEqual(
    groupVideos(live, 'folder', { kind: 'all' }).map((s) => [s.title, s.folder, names(s.videos)]),
    [
      ['Acme', 'Acme', ['spot.mp4', 'Teaser Überblendung.mp4']],
      ['Globex', 'Globex', ['reel.mp4']],
      ['No project', undefined, ['loose.mp4']],
    ],
  );
  assert.deepEqual(
    groupVideos([spot, teaser], 'folder', { kind: 'folder', id: 'Acme' }).map((s) => [s.title, s.folder]),
    [
      // the page is called Acme already: its own videos are "In this project", not "Acme" again
      ['In this project', 'Acme'],
      ['Reels', 'Acme/Reels'],
    ],
  );
  assert.deepEqual(
    groupVideos(live, 'stage', { kind: 'all' }).map((s) => s.key),
    ['needs_you', 'fixing', 'approved', 'final'],
  );
  assert.equal(groupVideos(live, 'none', { kind: 'all' }).length, 1);
  assert.deepEqual(groupVideos([], 'folder', { kind: 'all' }), []);
});

test('lanes, counts and the summary line', () => {
  const live = [spot, teaser, reel, loose];
  assert.deepEqual(
    lanes(live).map((l) => [l.id, names(l.videos)]),
    [
      ['needs_you', ['reel.mp4']],
      ['fixing', ['spot.mp4']],
      ['approved', ['loose.mp4']],
      ['final', ['Teaser Überblendung.mp4']],
    ],
  );
  assert.deepEqual(laneCounts(live), { all: 4, needs_you: 1, fixing: 1, approved: 1, final: 1 });
  assert.equal(summaryLine(live), '1 final · 1 out for review · 1 to check · 1 needs changes');
});

test('filter chips: AND across fields, OR within one; counts leave the field itself out', () => {
  const now = Date.parse('2026-09-28T12:00:00+02:00');
  const live = all.filter((v) => !v.archived);
  const f = (rules: Parameters<typeof applyFilters>[1]['rules']) => names(applyFilters(all, { ...none, rules, now }));
  assert.deepEqual(f([{ field: 'stage', values: ['changes', 'final'] }]), ['spot.mp4', 'Teaser Überblendung.mp4'], 'any of the stages');
  assert.deepEqual(
    f([
      { field: 'stage', values: ['changes', 'check_fixes'] },
      { field: 'folder', values: ['Acme'] },
    ]),
    ['spot.mp4'],
    'every chip must hold (the project is the top folder)',
  );
  assert.deepEqual(f([{ field: 'agent', values: ['edit'] }]), ['Teaser Überblendung.mp4']);
  assert.deepEqual(f([{ field: 'agent', values: ['-'] }]), ['spot.mp4', 'reel.mp4', 'loose.mp4'], '- is "no agent"');
  assert.deepEqual(f([{ field: 'folder', values: ['-'] }]), ['loose.mp4'], '- is "no project"');
  assert.deepEqual(f([{ field: 'musts', values: [] }]), ['spot.mp4'], 'a flag field needs no value');
  assert.deepEqual(f([{ field: 'updated', values: ['today'] }]), ['spot.mp4', 'Teaser Überblendung.mp4']);
  assert.deepEqual(f([{ field: 'updated', values: ['7d'] }]), ['spot.mp4', 'Teaser Überblendung.mp4', 'reel.mp4', 'loose.mp4']);
  // Counts per value answer "how many if I pick this", with every other rule applied.
  const stages = Object.fromEntries(fieldOptions(live, 'stage', [{ field: 'folder', values: ['Acme'] }], now).map((o) => [o.value, o.count]));
  assert.equal(stages.changes, 1);
  assert.equal(stages.final, 1);
  assert.equal(stages.check_fixes, 0, 'reel is in Globex');
  const agents = fieldOptions(live, 'agent', [], now).map((o) => `${o.value}:${o.count}`);
  assert.deepEqual(agents, ['edit:1', '-:3'], 'agents by name, "none" last');
});

test('filter chips: the client state, toggling values, and the per-tab string', () => {
  const shared = { ...loose, stage: { ...loose.stage, linked: true, share: { opened: false } } } as unknown as VideoSummary;
  const opened = { ...loose, stage: { ...loose.stage, linked: true, share: { opened: true } } } as unknown as VideoSummary;
  const approved = { ...loose, stage: { ...loose.stage, client: { status: 'approved' } } } as unknown as VideoSummary;
  assert.deepEqual([clientState(spot), clientState(shared), clientState(opened), clientState(approved)], ['none', 'shared', 'opened', 'approved']);
  let rules = toggleRule([], 'stage', 'changes');
  rules = toggleRule(rules, 'stage', 'final');
  assert.deepEqual(rules, [{ field: 'stage', values: ['changes', 'final'] }]);
  rules = toggleRule(rules, 'stage', 'changes');
  assert.deepEqual(rules, [{ field: 'stage', values: ['final'] }]);
  assert.deepEqual(toggleRule(rules, 'stage', 'final'), [], 'the last value takes the chip with it');
  assert.deepEqual(toggleRule(toggleRule([], 'updated', 'today'), 'updated', '7d'), [{ field: 'updated', values: ['7d'] }], 'one time window at a time');
  assert.deepEqual(toggleRule(toggleRule([], 'musts'), 'musts'), [], 'a flag toggles');
  assert.deepEqual(decodeRules(encodeRules(rules)), rules);
  assert.deepEqual(decodeRules('[["stage",["final"]],["evil",["x"]],"junk"]'), [{ field: 'stage', values: ['final'] }], 'unknown fields dropped');
  assert.deepEqual(decodeRules('{not json'), []);
});
