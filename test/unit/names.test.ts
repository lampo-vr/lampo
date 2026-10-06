// Account names others read: normalised, no invisible characters, and none that only looks like another account's
// name or like an agent ("аgent:" with a Cyrillic а would pass for an agent's note in every list).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv();
const auth = await import('../../lib/auth.ts');
const { cleanDisplayName, nameSkeleton } = await import('../../lib/names.ts');

test('names are stored normalised, without bidi overrides or zero-width characters', async () => {
  const u = await auth.createUser({ email: 'olivia@example.com', name: 'Oli​via‮ ', password: 'a long password', role: 'owner' });
  assert.equal(u.name, 'Olivia');
  assert.equal(cleanDisplayName('Ｍｉａ'), 'Mia', 'fullwidth letters fold to plain ones');
});

test('a name that looks like an agent or a guest is refused, in any script', () => {
  for (const n of ['agent:reels', 'аgent:reels', 'agent∶reels', 'guеst:Mia', 'AGENT : x']) assert.throws(() => auth.checkName(n), /cannot start with/, n);
  assert.equal(auth.checkName('Agentur Nord'), 'Agentur Nord', 'a word that merely starts like it is fine');
});

test('a second account whose name only looks like the first one is refused', async () => {
  await assert.rejects(
    auth.createUser({ email: 'mallory@example.com', name: 'Olіvia', password: 'a long password', role: 'member' }),
    /is taken/,
    'Ukrainian і',
  );
  const m = await auth.createUser({ email: 'mia@example.com', name: 'Mia', password: 'a long password', role: 'member' });
  await assert.rejects(auth.updateUser(m.id, { name: 'ОLIVIA' }), /is taken/, 'Cyrillic О, other case');
  assert.equal(nameSkeleton('Ｏlіvіа'), nameSkeleton('olivia'));
});
