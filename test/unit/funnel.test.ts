// The conversion funnel's first-party counts (lib/funnel.ts): each step once per workspace, the first time, with the UTC
// day and the plan — never who; moments counted per week by moment and place, never who; nothing at all where the server
// doesn't count (self-hosted); step records kept 13 months, then their week's counts only; a file that can't be read is
// never written over; the operator's report reads sign-up weeks, the weeks still in their trial and the medians.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv({ vars: { VR_MODE: 'server' } });
const f = await import('../../lib/funnel.ts');

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-07T12:00:00Z'); // a Wednesday
const W = (n: number) => `w_${String(n).padStart(12, '0')}`;
const file = () => JSON.parse(fs.readFileSync(f.FUNNEL_FILE, 'utf8'));
let on = false;
f.countWhen(() => on);

test('a self-hosted server counts nothing: no file, no step, no moment', () => {
  assert.equal(f.recordStep(W(1), 'signup', { at: NOW }), false);
  assert.equal(f.recordMoment('shown', 'loop', 'player', NOW), false);
  assert.equal(fs.existsSync(f.FUNNEL_FILE), false);
});

test('a step counts once per workspace, the first time, with its UTC day and the plan', () => {
  on = true;
  assert.equal(f.recordStep(W(1), 'signup', { at: NOW, plan: 'team' }), true);
  assert.equal(f.recordStep(W(1), 'signup', { at: NOW + DAY }), false, 'the second time is no first time');
  assert.equal(f.recordStep(W(2), 'signup', { at: NOW }), true, 'another workspace counts on its own');
  assert.equal(f.recordStep('../w1', 'signup', { at: NOW }), false, 'only workspace ids');
  assert.equal(f.recordStep(W(1), 'nope' as never, { at: NOW }), false, 'only the eight steps');
  f.forgetKnown();
  assert.equal(f.recordStep(W(1), 'signup', { at: NOW + DAY }), false, 'read from the file too, not only remembered');
  assert.deepEqual(file().workspaces[W(1)].steps.signup, { day: '2026-10-07', plan: 'team' });
  f.notePlan(W(2), 'signup', 'solo');
  f.notePlan(W(2), 'signup', 'business');
  assert.equal(file().workspaces[W(2)].steps.signup.plan, 'solo', 'a plan learnt later is noted once');
  assert.equal(fs.statSync(f.FUNNEL_FILE).mode & 0o777, 0o600);
});

test('moments count per week, moment and place: no account, name or address anywhere in the file', () => {
  for (let i = 0; i < 3; i++) f.recordMoment('shown', 'loop', 'player', NOW);
  f.recordMoment('dismissed', 'loop', 'player', NOW);
  f.recordMoment('used', 'limit_sheet', 'upload', NOW);
  assert.equal(f.recordMoment('shown', 'loop', 'Mia Lang', NOW), false, 'a place is a short word of ours, never a name');
  assert.equal(f.recordMoment('clicked' as never, 'loop', undefined, NOW), false);
  const week = file().moments['2026-10-05'];
  assert.deepEqual(week, { 'loop|player|shown': 3, 'loop|player|dismissed': 1, 'limit_sheet|upload|used': 1 });
  const text = fs.readFileSync(f.FUNNEL_FILE, 'utf8');
  for (const who of ['@', 'Mia', 'u_', '127.0.0.1']) assert.ok(!text.includes(who), `nothing personal: ${who}`);
});

test('the report: sign-up weeks, steps only once a week’s trials have ended, medians from sign-up', () => {
  // the week of 7 Sep (trials ended) and this week (in its trial)
  const sep = Date.parse('2026-09-08T09:00:00Z');
  for (const [n, steps] of [
    [10, ['setup_done', 'video_first', 'link_first', 'trial_end', 'plan_paid']],
    [11, ['setup_done', 'video_first']],
    [12, ['setup_done']],
    [13, []],
  ] as const) {
    f.recordStep(W(n), 'signup', { at: sep });
    for (const [i, s] of steps.entries()) f.recordStep(W(n), s, { at: sep + (i + 1) * 2 * DAY });
  }
  const r = f.funnelReport(8, NOW);
  assert.equal(r.counting, true);
  assert.equal(r.cohorts.length, 8);
  assert.equal(r.from, '2026-08-17');
  assert.equal(r.to, '2026-10-07');
  const sepWeek = r.cohorts.find((c) => c.week === '2026-09-07');
  assert.ok(sepWeek);
  assert.equal(sepWeek.mature, true);
  assert.equal(sepWeek.signups, 4);
  assert.deepEqual([sepWeek.reached.setup_done, sepWeek.reached.video_first, sepWeek.reached.plan_paid], [3, 2, 1]);
  const now = r.cohorts.at(-1);
  assert.ok(now);
  assert.equal(now.week, '2026-10-05');
  assert.equal(now.mature, false);
  assert.equal(now.signups, 2);
  assert.equal(now.reached.plan_paid, null, 'not readable while the trials run');
  const setup = r.steps.find((s) => s.step === 'setup_done');
  assert.deepEqual(setup, { step: 'setup_done', count: 3, medianDays: 2 });
  assert.equal(r.steps.find((s) => s.step === 'signup')?.medianDays, null);
  assert.equal(r.steps.find((s) => s.step === 'signup')?.count, 4, 'the funnel reads the mature weeks only');
  assert.deepEqual(
    r.moments.find((m) => m.id === 'loop'),
    { id: 'loop', where: 'player', shown: 3, used: 0, dismissed: 1, made_room: 0 },
  );
});

test('after 13 months a workspace’s steps go, its sign-up week keeps the counts', () => {
  const old = NOW - (f.KEEP_DAYS + 10) * DAY;
  f.recordStep(W(20), 'signup', { at: old });
  f.recordStep(W(20), 'video_first', { at: old + DAY });
  assert.ok(file().workspaces[W(20)], 'kept while nothing newer is written');
  f.recordStep(W(21), 'signup', { at: NOW });
  const after = file();
  assert.equal(after.workspaces[W(20)], undefined, 'gone with the next write');
  const week = f.mondayOf(new Date(old).toISOString().slice(0, 10));
  assert.deepEqual(after.rolled[week], { signups: 1, reached: { video_first: 1 } });
});

test('a file that can’t be read is never written over, and the report says it can’t be read', () => {
  const before = fs.readFileSync(f.FUNNEL_FILE, 'utf8');
  fs.writeFileSync(f.FUNNEL_FILE, '{ half a file');
  f.forgetKnown();
  assert.equal(f.recordStep(W(30), 'signup', { at: NOW }), false);
  assert.equal(f.recordMoment('shown', 'banner', undefined, NOW), false);
  assert.equal(fs.readFileSync(f.FUNNEL_FILE, 'utf8'), '{ half a file', 'left as it was');
  assert.throws(() => f.funnelReport(4, NOW), f.FunnelUnreadableError);
  fs.writeFileSync(f.FUNNEL_FILE, before);
  assert.equal(f.recordStep(W(30), 'signup', { at: NOW }), true, 'counted again once it reads');
});
