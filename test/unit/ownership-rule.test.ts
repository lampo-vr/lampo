// One rule for "is this mine", on the server and in the UI: the account when the record names one, else the name.
import assert from 'node:assert/strict';
import test from 'node:test';
import { isOwner } from '../../lib/ownership.ts';

test('the account decides when the record has one; the name only for older records', () => {
  const sam = { id: 'u_sam', name: 'Sam Renamed' };
  assert.equal(isOwner('Sam', 'u_sam', sam), true, 'renamed: still theirs');
  assert.equal(isOwner('Sam', 'u_sam', { id: 'u_new', name: 'Sam' }), false, 'a new account with the old name: not theirs');
  assert.equal(isOwner('Sam', undefined, { id: 'u_x', name: 'Sam' }), true, 'an older record: by name');
  assert.equal(isOwner('Sam', undefined, null), false);
  assert.equal(isOwner(undefined, undefined, sam), false);
});
