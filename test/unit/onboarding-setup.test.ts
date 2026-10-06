// The setup's rules (lib/onboarding.ts, pure): where a new account's setup runs and which steps it has, what the
// workspace's personas change (the Team step, Get started's order, the role an invite starts with), when the setup
// shows, and the website's plan ids.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onlyCreator, personaKinds, setupDue, setupVariant, startOnboarding, stepsFor } from '../../lib/onboarding.ts';
import { defaultInviteRole, isPersona, isSetupAgent, isSignupPlan, setupStepsFor } from '../../lib/setupFlow.ts';
import type { Persona } from '../../lib/types.ts';

const T0 = '2026-10-04T09:00:00.000+02:00';

test('where a setup runs: the machine, a sign-up’s own workspace, the server’s first workspace, anyone invited', () => {
  // the server's setup is whoever runs it (lib/operator.ts): `operator` unless a case says otherwise
  const v = (
    role: 'owner' | 'admin' | 'member' | 'reviewer',
    o: { machine?: boolean; signupWorkspace?: boolean; firstWorkspace?: boolean; operator?: boolean } = {},
  ) => setupVariant({ role, machine: !!o.machine, signupWorkspace: !!o.signupWorkspace, firstWorkspace: !!o.firstWorkspace, operator: o.operator ?? true });
  assert.equal(v('owner', { machine: true, firstWorkspace: true }), 'local');
  assert.equal(v('owner', { signupWorkspace: true }), 'cloud');
  assert.equal(v('admin', { signupWorkspace: true }), 'invited', 'an admin invited into a sign-up’s workspace answers nothing about it');
  assert.equal(v('owner', { firstWorkspace: true }), 'server');
  assert.equal(v('admin', { firstWorkspace: true }), 'server');
  assert.equal(v('member', { firstWorkspace: true }), 'invited');
  // an owner or admin of #1 who doesn't run the server (LAMPO_OPERATOR names someone else) gets a teammate's setup
  assert.equal(v('owner', { firstWorkspace: true, operator: false }), 'invited');
  assert.equal(v('admin', { firstWorkspace: true, operator: false }), 'invited');
  assert.equal(v('reviewer', { signupWorkspace: true }), 'invited');
  assert.equal(v('owner'), 'invited', 'the owner of another workspace (made from the app) was made owner by someone else');
  // invited into the server's first workspace, as admin or owner: still an invited teammate (the server's setup is its own
  // owner's: an invited admin was shown it on a live server)
  const inv = (role: 'owner' | 'admin') => setupVariant({ role, machine: false, signupWorkspace: false, firstWorkspace: true, invited: true });
  assert.equal(inv('admin'), 'invited');
  assert.equal(inv('owner'), 'invited');
});

test('the setup’s steps per variant; a channel alone has no team to invite', () => {
  assert.deepEqual(setupStepsFor('cloud'), ['workspace', 'persona', 'agent', 'team']);
  assert.deepEqual(setupStepsFor('cloud', ['creator']), ['workspace', 'persona', 'agent']);
  assert.deepEqual(setupStepsFor('cloud', ['creator', 'agency']), ['workspace', 'persona', 'agent', 'team']);
  assert.deepEqual(setupStepsFor('cloud', ['creator', 'other']), ['workspace', 'persona', 'agent', 'team'], 'something else may need a team');
  assert.deepEqual(setupStepsFor('local'), ['renders', 'agent', 'try']);
  assert.deepEqual(setupStepsFor('server'), ['workspace', 'health', 'team', 'agents']);
  assert.deepEqual(setupStepsFor('invited'), ['agent']);
});

test('personas: the kinds apart from “something else”, the channel alone, the role an invite starts with', () => {
  assert.deepEqual(personaKinds(['other', 'inhouse', 'agency']), ['inhouse', 'agency'], 'in the order picked');
  assert.deepEqual(personaKinds(undefined), []);
  assert.equal(onlyCreator(['creator']), true);
  assert.equal(onlyCreator([]), false, 'nothing picked: a team may come');
  assert.equal(onlyCreator(undefined), false);
  assert.equal(onlyCreator(['creator', 'inhouse']), false);
  assert.equal(defaultInviteRole(['inhouse']), 'reviewer', 'an in-house team’s approvers review');
  assert.equal(defaultInviteRole(['inhouse', 'agency']), 'member');
  assert.equal(defaultInviteRole(['agency']), 'member');
  assert.equal(defaultInviteRole(undefined), 'member');
  assert.ok(isPersona('agency') && isPersona('other') && !isPersona('studio') && !isPersona(1));
});

test('Get started’s order follows the personas in a sign-up’s workspace (Cloud) only', () => {
  const cloud = (personas?: Persona[]) => stepsFor('owner', { signupWorkspace: true, personas });
  assert.deepEqual(cloud(), ['sample', 'agent', 'video', 'share', 'invite']);
  assert.deepEqual(cloud(['agency']), ['sample', 'agent', 'video', 'share', 'invite']);
  assert.deepEqual(cloud(['inhouse']), ['sample', 'agent', 'invite', 'video', 'share'], 'in-house teams invite before they upload');
  assert.deepEqual(cloud(['agency', 'inhouse']), ['sample', 'agent', 'invite', 'video', 'share']);
  assert.deepEqual(cloud(['creator']), ['sample', 'agent', 'video', 'share'], 'a channel alone invites nobody');
  assert.deepEqual(stepsFor('owner', { personas: ['creator'] }), ['sample', 'video', 'agent', 'invite', 'share'], 'a self-hosted server ignores them');
  assert.deepEqual(stepsFor('member', { signupWorkspace: true, personas: ['inhouse'] }), ['sample', 'agent', 'video', 'share']);
});

test('the setup shows on a new account’s first visits until it is over; never on an account from before it', () => {
  const o = startOnboarding(T0);
  assert.equal(o.setup_due, true);
  assert.equal(setupDue(o), true);
  assert.equal(setupDue({ ...o, setup_done: T0 }), false);
  assert.equal(setupDue({ since: T0 }), false, 'a first run from before the setup');
  assert.equal(setupDue(null), false);
  assert.equal(setupDue(undefined), false);
});

test('known ids only: the website’s plans, the setup’s agents', () => {
  for (const p of ['cloud-solo', 'cloud-team', 'cloud-business']) assert.ok(isSignupPlan(p), p);
  for (const p of ['team', 'cloud-enterprise', '', null, undefined, 3]) assert.ok(!isSignupPlan(p), String(p));
  for (const a of ['claude-code', 'codex', 'cursor', 'chatgpt', 'claude', 'other', 'none']) assert.ok(isSetupAgent(a), a);
  assert.ok(!isSetupAgent('gemini') && !isSetupAgent(''));
});
