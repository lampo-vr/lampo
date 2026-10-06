// Signing in or out in a tab drops what the previous account's screens cached, the account-only lists included.
import assert from 'node:assert/strict';
import test from 'node:test';
import { isAccountData } from '../../web/src/api/accountData.ts';

test('everything a screen cached is the account’s, except who is signed in', () => {
  for (const key of [
    ['auth', 'tokens'],
    ['auth', 'apps'],
    ['auth', 'admin-apps'],
    ['auth', 'users'],
    ['auth', 'invites'],
    ['auth', 'people'],
    ['library'],
    ['review', 'x'],
  ])
    assert.equal(isAccountData(key), true, key.join('/'));
  assert.equal(isAccountData(['auth', 'status']), false);
});
