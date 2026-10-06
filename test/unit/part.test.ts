// lib/part.ts: partial renders' rules without ffmpeg — the stretch snapped to shots, the one line agents read, which
// frames of which file make a version (also a part of a part), where a part may end, and the stage saying "part".
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fullAtOrBefore,
  isWhole,
  onGrid,
  PART_HANDLES,
  partBounds,
  partEnd,
  partLine,
  partOk,
  partOkWords,
  partsBefore,
  partWhere,
  shotAt,
  snapToShots,
  sourceFrame,
  spliceSegments,
} from '../../lib/part.ts';
import { stageOf } from '../../lib/stage.ts';
import type { ApprovalEntry, Version, VersionPart } from '../../lib/types.ts';

// Five shots: 0–29, 30–59, 60–95, 96–188, 189–299.
const CUTS = [30, 60, 96, 189];
const FRAMES = 300;

test('a frame or a range snaps to the shots around it', () => {
  assert.deepEqual(snapToShots(CUTS, FRAMES, { in: 120, out: 120 }), { in: 96, out: 188, shot: 4, to_shot: 4, handles: PART_HANDLES });
  // a cut frame starts its shot; the frame before it ends the one before
  assert.deepEqual(snapToShots(CUTS, FRAMES, { in: 96, out: 96 }), { in: 96, out: 188, shot: 4, to_shot: 4, handles: 12 });
  assert.deepEqual(snapToShots(CUTS, FRAMES, { in: 95, out: 95 }), { in: 60, out: 95, shot: 3, to_shot: 3, handles: 12 });
  // a range across a cut takes both shots
  assert.deepEqual(snapToShots(CUTS, FRAMES, { in: 150, out: 200 }), { in: 96, out: 299, shot: 4, to_shot: 5, handles: 12 });
  // the first and the last shot reach the video's ends; cuts out of order, doubled or out of range don't matter
  assert.deepEqual(snapToShots([189, 30, 30, 0, 400, 96, 60], FRAMES, { in: 3, out: 10 }, 6), { in: 0, out: 29, shot: 1, to_shot: 1, handles: 6 });
  assert.equal(shotAt(CUTS, 299), 5);
  // one shot: the whole video
  const whole = snapToShots([], FRAMES, { in: 120, out: 120 });
  assert.ok(isWhole(whole, FRAMES));
  assert.ok(!isWhole(snapToShots(CUTS, FRAMES, { in: 120, out: 120 }), FRAMES));
});

test('agents read one short line', () => {
  assert.equal(partLine({ in: 96, out: 188, shot: 4, to_shot: 4, handles: 12 }), 'PART RENDER OK: frames 96–188 (shot 4), handles 12');
  assert.equal(partLine({ in: 96, out: 299, shot: 4, to_shot: 5, handles: 6 }), 'PART RENDER OK: frames 96–299 (shots 4–5), handles 6');
  assert.equal(partLine({ in: 96, out: 188 }), 'PART RENDER OK: frames 96–188, handles 12');
});

const ver = (v: number, part?: VersionPart): Version =>
  ({ v, frames: FRAMES, fps: 25, width: 320, height: 180, duration: 12, hash: `h${v}`, ...(part ? { part } : {}) }) as Version;

test('which frames of which file make a version: a part, and a part of a part', () => {
  const v1 = ver(1);
  const v2 = ver(2, { of: 1, at: 96, frames: 93, handles: 12 });
  assert.deepEqual(spliceSegments([v1, v2], 1), [{ v: 1, from: 0, to: 300 }]);
  assert.deepEqual(spliceSegments([v1, v2], 2), [
    { v: 1, from: 0, to: 96 },
    { v: 2, from: 12, to: 105 },
    { v: 1, from: 189, to: 300 },
  ]);
  // the part's file holds its handles too: frame 96 of the video is frame 12 of the file
  assert.deepEqual(sourceFrame([v1, v2], 2, 95), { v: 1, frame: 95 });
  assert.deepEqual(sourceFrame([v1, v2], 2, 96), { v: 2, frame: 12 });
  assert.deepEqual(sourceFrame([v1, v2], 2, 188), { v: 2, frame: 104 });
  assert.deepEqual(sourceFrame([v1, v2], 2, 189), { v: 1, frame: 189 });
  assert.equal(sourceFrame([v1, v2], 2, 300), null);

  // a part of a part never goes through a splice: every frame comes from a file as uploaded
  const v3 = ver(3, { of: 2, at: 100, frames: 20, handles: 12 });
  assert.deepEqual(spliceSegments([v1, v2, v3], 3), [
    { v: 1, from: 0, to: 96 },
    { v: 2, from: 12, to: 16 },
    { v: 3, from: 12, to: 32 },
    { v: 2, from: 36, to: 105 },
    { v: 1, from: 189, to: 300 },
  ]);
  assert.deepEqual(sourceFrame([v1, v2, v3], 3, 110), { v: 3, frame: 22 });
  assert.deepEqual(sourceFrame([v1, v2, v3], 3, 125), { v: 2, frame: 41 });
  // the segments always add up to the whole video
  const total = (segs: { from: number; to: number }[]) => segs.reduce((s, x) => s + x.to - x.from, 0);
  assert.equal(total(spliceSegments([v1, v2, v3], 3)), FRAMES);
  // a broken chain (the patched version is missing, or points forward) makes nothing
  assert.deepEqual(spliceSegments([v2], 2), []);
  assert.deepEqual(spliceSegments([v1, ver(2, { of: 2, at: 0, frames: 10, handles: 0 })], 2), []);

  // the parts a full render answers for, and the full render a part patches
  const v4 = ver(4);
  assert.deepEqual(
    partsBefore([v1, v2, v3, v4], 4).map((x) => x.v),
    [2, 3],
  );
  assert.deepEqual(partsBefore([v1, v2, v3, v4], 2), []);
  assert.equal(fullAtOrBefore([v1, v2, v3, v4], 3)?.v, 1);
  assert.equal(fullAtOrBefore([v1, v2, v3, v4], 4)?.v, 4);
});

test('handles stop at the video’s ends; the version picker names the stretch', () => {
  assert.deepEqual(partBounds({ at: 96, frames: 93, handles: 12 }, FRAMES), { pre: 12, post: 12 });
  assert.deepEqual(partBounds({ at: 5, frames: 25, handles: 12 }, FRAMES), { pre: 5, post: 12 });
  assert.deepEqual(partBounds({ at: 189, frames: 111, handles: 12 }, FRAMES), { pre: 12, post: 0 });
  assert.equal(partWhere({ at: 100, frames: 75 }, 25), '00:04–00:07');
});

test('a part ends on a shot boundary or its length changed', () => {
  const base = { at: 96, handles: 12, baseFrames: FRAMES };
  // the stretch the person asked for, with 12 frames either side
  assert.equal(partEnd({ ...base, length: 12 + 93 + 12, ends: [189] }), 189);
  // the shot got longer: refused (a part never moves what follows)
  assert.equal(partEnd({ ...base, length: 12 + 98 + 12, ends: [189] }), null);
  assert.equal(partEnd({ ...base, length: 12 + 90 + 12, ends: [189] }), null);
  // the next shot too (after a seam that jumped): it ends on the next cut, or at the video's end
  assert.equal(partEnd({ ...base, length: 12 + 204 + 0, ends: [189] }), 300);
  assert.equal(partEnd({ ...base, length: 12 + 134 + 12, ends: [189, 230] }), 230);
  // without handles
  assert.equal(partEnd({ ...base, handles: 0, length: 93, ends: [189] }), 189);
  // at the very start: no frames before it to render
  assert.equal(partEnd({ at: 0, handles: 12, baseFrames: FRAMES, length: 30 + 12, ends: [30] }), 30);
});

test('a stretch on another frame grid keeps its seconds', () => {
  assert.deepEqual(onGrid({ in: 50, out: 99 }, 25, 25), { in: 50, out: 99 });
  assert.deepEqual(onGrid({ in: 50, out: 99 }, 25, 50), { in: 100, out: 199 });
});

test('a part is a version to review that says so, and never final', () => {
  const v1 = ver(1);
  const v2 = ver(2, { of: 1, at: 96, frames: 93, handles: 12 });
  const r = { versions: [v1, v2], comments: [], session: null };
  const s = stageOf(r);
  assert.equal(s.stage, 'to_review');
  assert.equal(s.detail, 'V2 (part) to review');
  assert.deepEqual(s.part, { of: 1, at: 96, frames: 93 });
  assert.equal(s.next.label, 'Review V2');
  const approved = (party: ApprovalEntry['party']): ApprovalEntry => ({
    party,
    status: 'approved',
    v: 2,
    by: party === 'client' ? 'guest:Mia' : 'alex',
    at: '2026-10-01T10:00:00Z',
    note: null,
  });
  assert.equal(stageOf({ ...r, approvals: [approved('team')] }).detail, 'Approved V2 (part) by the team');
  // where "Mark final" would come next, a full render does
  const client = stageOf({ ...r, approvals: [approved('client')] });
  assert.equal(client.stage, 'client_approved');
  assert.deepEqual(client.next, { kind: 'fix', label: 'Render it in full for final' });
  // a full render after it: an ordinary version again
  const full = stageOf({ ...r, versions: [v1, v2, ver(3)], approvals: [approved('client')] });
  assert.equal(full.detail, 'V2 approved · V3 new');
  assert.equal(full.part, undefined);
});

test('part_ok: the stretch a part render for a note may cover, on the newest version’s frames (what --part-at checks)', () => {
  const part = { in: 40, out: 79, shot: 2, to_shot: 2, handles: 12 };
  const v1 = ver(1);
  assert.deepEqual(partOk([v1], { part, status: 'open', v: 1 }), { from: 40, to: 79 });
  assert.deepEqual(partOk([v1], { part, status: 'fixed', v: 1 }), { from: 40, to: 79 }, 'vr push --part-at accepts it too');
  assert.equal(partOk([v1], { part, status: 'wontfix', v: 1 }), null);
  assert.equal(partOk([v1], { status: 'open', v: 1 }), null);
  assert.equal(partOk([], { part, status: 'open', v: 1 }), null);
  // asked on a 25 fps version, the newest is 50 fps: the same seconds, as allowedParts sees them
  assert.deepEqual(partOk([v1, { ...ver(2), fps: 50 }], { part, status: 'open', v: 1 }), { from: 80, to: 159 });
  assert.equal(partOkWords({ from: 40, to: 79 }), ' · part f40–f79');
  assert.equal(partOkWords(null), '');
});
