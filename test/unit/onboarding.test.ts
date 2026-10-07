// The first run's rules (lib/onboarding.ts, pure): which steps a role gets, how a fact found once is kept, when the
// first run is finished, shown or offered again (the sample itself: sample.test.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv();
const { inSidebar, isSample, nextOf, progressOf, recordFacts, resumable, showsOnboarding, startOnboarding, stateOf, stepsFor } = await import(
  '../../lib/onboarding.ts'
);

const T0 = '2026-10-02T09:00:00.000+02:00';
const T1 = '2026-10-02T09:05:00.000+02:00';

test('each role gets its own steps; at the machine there is nobody to invite', () => {
  assert.deepEqual(stepsFor('owner'), ['sample', 'video', 'agent', 'invite', 'share'], 'a self-hosted server: the first video before agents and invites');
  assert.deepEqual(stepsFor('admin'), ['sample', 'video', 'agent', 'invite', 'share']);
  assert.deepEqual(stepsFor('member'), ['sample', 'agent', 'video', 'share'], 'members don’t invite');
  assert.deepEqual(stepsFor('reviewer'), ['sample', 'note', 'approve'], 'reviewers don’t add videos, hand work to agents or share');
  assert.deepEqual(stepsFor('owner', { machine: true }), ['sample', 'video', 'agent', 'share']);
  assert.deepEqual(stepsFor('reviewer', { machine: true }), ['sample', 'note', 'approve']);
  assert.deepEqual(stepsFor('owner', { signupWorkspace: true }), ['sample', 'agent', 'video', 'share', 'invite'], 'Cloud: the agent first, the invite last');
});

test('a fact ticks its step once and keeps the first time; nothing new is the same object (no write)', () => {
  const o = startOnboarding(T0);
  const steps = stepsFor('member');
  assert.equal(recordFacts(o, steps, {}, T1), o, 'nothing found: unchanged');
  const a = recordFacts(o, steps, { video: true, invite: true }, T0);
  assert.deepEqual(a.done, { video: T0 }, 'a step the role doesn’t have is not recorded');
  const b = recordFacts(a, steps, { video: true, sample: true }, T1);
  assert.deepEqual(b.done, { video: T0, sample: T1 }, 'the first time is kept');
  assert.equal(recordFacts(b, steps, { video: true, sample: true }, T1), b);
  // a fact gone later (the video deleted) never takes the tick back
  assert.deepEqual(recordFacts(b, steps, { video: false }, T1).done, b.done);
  assert.equal(o.done, undefined, 'never changed in place');
});

test('finished once every step of the role is done, and only then', () => {
  const steps = stepsFor('reviewer');
  const half = recordFacts(startOnboarding(T0), steps, { sample: true, note: true }, T0);
  assert.equal(half.complete, undefined);
  const all = recordFacts(half, steps, { approve: true }, T1);
  assert.equal(all.complete, T1);
  assert.equal(recordFacts(all, steps, { approve: true }, '2027-01-01T00:00:00.000Z'), all, 'finished stays as it was');
  assert.equal(recordFacts(startOnboarding(T0), [], { video: true }, T0).complete, undefined, 'no steps: never finished');
});

test('state, next step and progress from what was recorded', () => {
  const o = { since: T0, done: { sample: T0, agent: T1 } };
  const s = stateOf(o, stepsFor('owner'));
  assert.deepEqual(
    s.map((x) => [x.id, x.done]),
    [
      ['sample', true],
      ['video', false],
      ['agent', true],
      ['invite', false],
      ['share', false],
    ],
  );
  assert.equal(nextOf(s), 'video', 'the first one not done, in order');
  assert.deepEqual(progressOf(s), { done: 2, of: 5 });
  assert.equal(nextOf(stateOf({ since: T0, done: { sample: T0, note: T0, approve: T0 } }, stepsFor('reviewer'))), null);
  assert.deepEqual(
    stateOf(null, stepsFor('member')).map((x) => x.done),
    [false, false, false, false],
  );
});

test('shown unless put away (a finished one too, to say so); offered again while a step is open', () => {
  assert.equal(showsOnboarding(undefined), false, 'an account from before the first run never sees it');
  assert.equal(showsOnboarding(null), false);
  assert.equal(showsOnboarding({ since: T0 }), true);
  assert.equal(showsOnboarding({ since: T0, hidden: T1 }), false);
  assert.equal(showsOnboarding({ since: T0, complete: T1 }), true);
  assert.equal(resumable({ since: T0, hidden: T1 }), true, 'the account menu brings a put-away one back');
  assert.equal(resumable({ since: T0, complete: T1 }), false);
  assert.equal(resumable(undefined), false);
});

test('the sidebar’s row: while a step is open, through the card’s ×, never hidden for good; the menu still offers it', () => {
  assert.equal(inSidebar(undefined), false, 'an account from before the first run never sees it');
  assert.equal(inSidebar({ since: T0 }), true);
  assert.equal(inSidebar({ since: T0, hidden: T1 }), true, 'the card put away: the row stays');
  assert.equal(inSidebar({ since: T0, dismissed: T1 }), false, 'hidden for good');
  assert.equal(inSidebar({ since: T0, complete: T1 }), false, 'nothing left to do');
  assert.equal(showsOnboarding({ since: T0, dismissed: T1 }), false, 'hidden for good: the card too');
  assert.equal(resumable({ since: T0, dismissed: T1 }), true, 'the account menu still brings it back');
});

test('a sample is a video marked as one (the flag billing and limits skip)', () => {
  assert.equal(isSample({ onboarding_sample: { made: T0, by: 'Sam' } }), true);
  assert.equal(isSample({}), false);
});
