// Paid plans are for businesses: whether "I'm buying for my business, not as a private person" is ticked
// (web/src/billing/buyer.ts) — the provider's answer once someone of the workspace confirmed it, else unticked; what this
// visit ticked or unticked wins, per workspace, wherever the box was (the plans' tick carries into the checkout); every
// box hears a change; a sign-out forgets it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { businessSaid, businessTicked, sayBusiness, subscribeBusiness } from '../../web/src/billing/buyer.ts';
import { forgetInMemory } from '../../web/src/lib/signedOut.ts';

test('the provider’s answer first: unticked until someone of the workspace confirmed it', () => {
  forgetInMemory();
  assert.equal(businessTicked({}, 'w2'), false, 'nothing confirmed: unticked');
  assert.equal(businessTicked({ business: { at: '2026-10-11T10:00:00.000Z' } }, 'w2'), true, 'confirmed before: ticked');
  assert.equal(businessSaid('w2'), undefined, 'this visit said nothing yet');
});

test('this visit’s word wins, per workspace, and every box hears it', () => {
  forgetInMemory();
  const heard: string[] = [];
  const stop = subscribeBusiness(() => heard.push(String(businessSaid('w2'))));
  try {
    // ticked on the plans: the checkout reads it ticked before the provider has anything
    sayBusiness('w2', true);
    assert.equal(businessTicked({}, 'w2'), true);
    // unticked on a workspace the provider remembers: unticked for the rest of the visit
    sayBusiness('w2', false);
    assert.equal(businessTicked({ business: { at: '2026-10-11T10:00:00.000Z' } }, 'w2'), false);
    // another workspace is its own
    assert.equal(businessTicked({}, 'w3'), false);
    assert.deepEqual(heard, ['true', 'false']);
  } finally {
    stop();
  }
  sayBusiness('w2', true);
  assert.deepEqual(heard, ['true', 'false'], 'a box that went hears nothing more');
});

test('a sign-out forgets what this visit said', () => {
  sayBusiness('w2', true);
  forgetInMemory();
  assert.equal(businessSaid('w2'), undefined);
  assert.equal(businessTicked({}, 'w2'), false);
});
