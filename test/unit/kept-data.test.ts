// What this browser keeps of a screen's data between visits (web/src/api/persistWrite.ts → keptData): the plan, for
// the banner's room at first paint, but nothing of a card — the label of the card a failed renewal tried stays out.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keptData } from '../../web/src/api/keptData.ts';

test('the plan is kept without the card a failed renewal tried; everything else as it is', () => {
  const plan = {
    plan: 'team',
    state: 'grace',
    failure: { invoice: 'in_1', amount: 4800, currency: 'eur', method: 'Visa •••• 4242', code: 'card_declined' },
  };
  const kept = keptData(['billing'], plan) as typeof plan;
  assert.equal(kept.failure.method, undefined);
  assert.deepEqual(kept.failure, { invoice: 'in_1', amount: 4800, currency: 'eur', code: 'card_declined' });
  assert.equal(kept.state, 'grace');
  assert.ok(!JSON.stringify(kept).includes('4242'));
  assert.equal(plan.failure.method, 'Visa •••• 4242', 'the screen’s own data is left alone');
  const library = { videos: [{ method: 'not a card' }] };
  assert.equal(keptData(['library'], library), library);
});
