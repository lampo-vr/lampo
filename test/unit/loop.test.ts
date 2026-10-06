// The fast loop: version diff, auto-tagging, share links, approvals/requests, agent status, insights.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { DiffReport, DiffResult, Version } from '../../lib/types.ts';
import { age, FFMPEG, isolatedEnv, makeVideo, must, tmpdir } from '../lib/helpers.ts';

isolatedEnv();
const store = await import('../../lib/store.ts');
const { diffVersions } = await import('../../lib/diff.ts');
const { autoTags, autoSeverity } = await import('../../lib/autotag.ts');
const shares = await import('../../lib/shares.ts');
const { setAgentStatus } = await import('../../lib/agentStatus.ts');
const { insights } = await import('../../lib/insights.ts');
const { probeSync, quickHash } = await import('../../lib/probe.ts');

const dir = tmpdir('vr-loop-');
const ver = (f: string, v: number): Version => ({ v, hash: quickHash(f), mtime: '', size: fs.statSync(f).size, registered: '', ...probeSync(f) });
const report = (d: DiffResult): DiffReport => {
  assert.equal(d.incomparable, undefined, 'comparable versions');
  return d as DiffReport;
};
const enc = ['-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'aac'];

// 320×180, 3 s, a tone that changes pitch so audio differences are real
const base = makeVideo(path.join(dir, 'base.mp4'), { w: 320, h: 180, dur: 3, pattern: 'testsrc2' });

test('diff: an identical re-encode is identical', async () => {
  const same = path.join(dir, 'same.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-i', base, ...enc, '-y', same]);
  const d = report(await diffVersions(base, ver(base, 1), same, ver(same, 2)));
  assert.equal(d.summary.identical, true, JSON.stringify(d.summary));
});

test('diff: a box drawn on frames 20–29 is one change there, with its region', async () => {
  const boxed = path.join(dir, 'boxed.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-i', base, '-vf', "drawbox=x=200:y=100:w=80:h=50:color=white:t=fill:enable='between(n,20,29)'", ...enc, '-y', boxed]);
  const d = report(await diffVersions(base, ver(base, 1), boxed, ver(boxed, 2)));
  const video = d.ranges.filter((r) => r.kind === 'video');
  assert.equal(video.length, 1, JSON.stringify(d.ranges));
  assert.ok(video[0].in >= 19 && video[0].in <= 21 && video[0].out >= 28 && video[0].out <= 30, JSON.stringify(video[0]));
  const b = must(video[0].box, 'changed region');
  assert.ok(b.x <= 200 && b.x + b.w >= 280 && b.y <= 100 && b.y + b.h >= 150, `region covers the box: ${JSON.stringify(b)}`);
  assert.equal(d.retimes.length, 0);
});

test('diff: cutting 10 frames (picture and sound) is one retime, not a changed tail', async () => {
  const cut = path.join(dir, 'cut.mp4');
  execFileSync(FFMPEG, [
    ...['-v', 'error', '-i', base, '-filter_complex'],
    '[0:v]trim=end_frame=40,setpts=PTS-STARTPTS[v0];[0:v]trim=start_frame=50,setpts=PTS-STARTPTS[v1];[0:a]atrim=end=1.3333333,asetpts=PTS-STARTPTS[a0];[0:a]atrim=start=1.6666667,asetpts=PTS-STARTPTS[a1];[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]',
    ...['-map', '[v]', '-map', '[a]', ...enc, '-y', cut],
  ]);
  const d = report(await diffVersions(base, ver(base, 1), cut, ver(cut, 2)));
  assert.equal(d.retimes.length, 1, JSON.stringify(d.retimes));
  assert.equal(d.retimes[0].shift_frames, 10);
  assert.ok(Math.abs(d.retimes[0].frame - 40) <= 1);
  assert.equal(d.ranges.filter((r) => r.kind === 'video').length, 0, JSON.stringify(d.ranges));
});

test('autotag: German and English notes get sensible tags and severity', () => {
  assert.deepEqual(autoTags('Der Schnitt kommt zu früh'), ['timing', 'cut']);
  assert.ok(autoTags('Musik ist hier zu laut').includes('audio/music'));
  assert.ok(autoTags('Caption liegt auf dem Gesicht').includes('layout/overlap'));
  assert.ok(autoTags('Tippfehler im Titel').includes('text/typo'));
  assert.ok(autoTags('Das ist mega, genau so lassen').includes('love-it'));
  assert.equal(autoSeverity('Das muss unbedingt raus'), 'must');
  assert.equal(autoSeverity('Vielleicht etwas kürzer'), 'nice');
  assert.equal(autoSeverity('Etwas heller bitte'), 'should');
});

test('shares: tokens resolve to one video, revoke works, names are sanitised', () => {
  const s = shares.createShare('slug-a', { label: 'Acme team', by: 'tester' });
  assert.match(s.token, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(shares.resolveShare(s.token)?.slug, 'slug-a');
  assert.equal(shares.resolveShare('nope'), null);
  assert.equal(shares.resolveShare('../../etc/passwd'), null);
  assert.equal(shares.listShares('slug-a').length, 1);
  assert.equal(shares.revokeShare(s.token), true);
  assert.equal(shares.resolveShare(s.token), null);
  assert.equal(shares.listShares('slug-a').length, 0);
  assert.equal(shares.guestName('Mia <script>'), 'Mia script');
  assert.equal(shares.guestName(''), 'client');
});

test('approvals and requests reach events.jsonl and INBOX.md; a new render clears the agent status', () => {
  const file = path.join(dir, 'proj/export/film.mp4');
  makeVideo(file, { w: 160, h: 90, dur: 1 });
  age(file);
  const { review } = store.createOrGetReview(file, { by: 'tester' });
  const slug = path.resolve(file).split('/').join('__');
  store.setApproval(slug, { status: 'approved', note: 'passt' }, 'tester');
  store.addRequest(slug, 'Pre-review v1 please', 'tester');
  assert.equal(store.loadReview(slug)?.approval?.status, 'approved');
  const evs = store.readEvents();
  assert.ok(evs.some((e) => e.type === 'approval' && e.text?.startsWith('APPROVED v1')));
  assert.ok(evs.some((e) => e.type === 'request' && e.text === 'Pre-review v1 please'));
  const inbox = fs.readFileSync(store.INBOX_FILE, 'utf8');
  assert.ok(inbox.includes('APPROVAL') || inbox.includes('APPROVED'));
  assert.ok(inbox.includes('REQUEST'));
  setAgentStatus(slug, { text: 'rendering v2' }, 'agent:test');
  assert.equal(store.loadReview(slug)?.agent_status?.text, 'rendering v2');
  makeVideo(file, { w: 160, h: 90, dur: 1, freq: 880 });
  age(file);
  const r = must(store.sync(slug));
  assert.equal(r.review.versions.length, 2);
  assert.equal(store.loadReview(slug)?.agent_status, undefined, 'status cleared by the new render');
  assert.ok(review);
});

test('insights: counts, tags and convergence per render', () => {
  const file = path.join(dir, 'proj2/export/ins.mp4');
  makeVideo(file, { w: 160, h: 90, dur: 1 });
  age(file);
  store.createOrGetReview(file, { by: 'tester' });
  const slug = path.resolve(file).split('/').join('__');
  store.addComment(slug, { frame: 3, text: 'zu früh', tags: ['timing'], author: 'tester' });
  store.addComment(slug, { frame: 5, text: 'Musik', tags: ['audio/music', 'timing'], severity: 'must', author: 'tester' });
  store.addComment(slug, { frame: 7, text: 'Frage', tags: [], author: 'agent:x' });
  const d = insights(store.listReviews().filter((r) => r.video === path.resolve(file)));
  assert.equal(d.totals.notes, 2, 'agent questions are not the reviewer’s notes');
  assert.deepEqual(d.tags.slice(0, 2), [
    { tag: 'timing', n: 2 },
    { tag: 'audio/music', n: 1 },
  ]);
  assert.equal(d.severity.must, 1);
  assert.equal(d.perRender[0].avg, 2);
  // An agent's question that was answered and one marked fixed are not feedback: statuses and turnaround ignore them.
  const agentNote = must(must(store.loadReview(slug)).comments.find((c) => c.author === 'agent:x'));
  store.updateComment(agentNote.id, { status: 'fixed', note: 'answered', by: 'agent:x' });
  const after = insights(store.listReviews().filter((r) => r.video === path.resolve(file)));
  const statuses = Object.values(after.status).reduce((a, b) => a + b, 0);
  assert.equal(statuses, after.totals.notes, 'every note is counted once in the statuses, and only notes');
  assert.equal(after.turnaround.fixed, 0, "an agent's note marked fixed is no fix of feedback");
});
