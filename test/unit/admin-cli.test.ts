// `vr admin` on the server's own store (a throwaway one here): list-users, create-user, reset-password, invite, invites
// and revoke-invite, pinned as they are — including what they do without saying so.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { User } from '../../lib/auth.ts';
import { isolatedEnv, vr } from '../lib/helpers.ts';

const { env } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: 'https://review.test' } });
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const { DATA } = await import('../../lib/paths.ts');

const PASSWORD = 'a long password';
const ok = (args: string[], e = env) => {
  const r = vr(['admin', ...args], e);
  assert.equal(r.code, 0, r.err);
  return r.out;
};
/** A refused command: exit 1 and its one line on stderr. */
const refused = (args: string[]) => {
  const r = vr(['admin', ...args], env);
  assert.equal(r.code, 1, r.out);
  return r.err.trim();
};
const row = (role: string, email: string, name: string) => `${role.padEnd(8)} ${email.padEnd(32)} ${name}`;
const inviteRow = (status: string, role: string, who: string) => `${status.padEnd(9)} ${role.padEnd(8)} ${who.padEnd(32)} by tester, until `;
const user = (email: string) => auth.findUserByEmail(email) as User;

test('create-user: the first account owns the store, the next ones are members; refusals name the rule', () => {
  assert.equal(ok(['list-users']), `no accounts yet (store: ${DATA}).\n`);
  assert.equal(
    ok(['create-user', '--email', 'olivia@example.com', '--name', 'Olivia', '--password', PASSWORD]),
    `created owner olivia@example.com (Olivia) in ${DATA}\n`,
  );
  // The password from VR_PASSWORD (scripts), the address as typed is stored lower-case.
  assert.equal(
    ok(['create-user', '--email', 'Mia@Example.com', '--name', 'Mia'], { ...env, VR_PASSWORD: PASSWORD }),
    `created member mia@example.com (Mia) in ${DATA}\n`,
  );
  assert.equal(ok(['create-user', '--email', 'rita@example.com', '--name', 'Rita', '--role', 'reviewer', '--password', PASSWORD]).split(' ')[1], 'reviewer');
  assert.equal(
    refused(['create-user', '--email', 'x@example.com']),
    'lampo: lampo admin create-user --email you@example.com --name "Your Name" [--role owner|admin|member|reviewer] [--workspace <id>]',
  );
  assert.equal(
    refused(['create-user', '--email', 'x@example.com', '--name', 'X', '--role', 'boss']),
    'lampo: --role must be one of owner, admin, member, reviewer',
  );
  assert.equal(
    refused(['create-user', '--email', 'x@example.com', '--name', 'X', '--workspace', 'w_nope']),
    'lampo: no workspace w_nope (lampo admin workspaces lists them)',
  );
  assert.equal(
    refused(['create-user', '--email', 'mia@example.com', '--name', 'Mia Two', '--password', PASSWORD]),
    'lampo: a user with mia@example.com already exists',
  );
  // Nothing on stdin and no --password: an empty password, refused by the rule (no prompt waits).
  assert.equal(refused(['create-user', '--email', 'x@example.com', '--name', 'X']), 'lampo: password must be at least 10 characters');
  assert.equal(auth.listUsers().length, 3);
});

test('list-users: role, address and name per account, disabled ones marked; --json never carries a password hash', async () => {
  await auth.updateUser(user('rita@example.com').id, { disabled: true });
  assert.equal(
    ok(['list-users']),
    `${[row('owner', 'olivia@example.com', 'Olivia'), row('member', 'mia@example.com', 'Mia'), `${row('reviewer', 'rita@example.com', 'Rita')}  (disabled)`].join('\n')}\n`,
  );
  const listed = JSON.parse(ok(['list-users', '--json']));
  assert.deepEqual(
    listed.map((u: { email: string }) => u.email),
    ['olivia@example.com', 'mia@example.com', 'rita@example.com'],
  );
  for (const u of listed) {
    assert.equal(u.password, undefined);
    assert.equal(u.epoch, undefined);
    assert.equal(u.has_password, true);
  }
});

test('reset-password: a new password that signs every session out — and a disabled account enabled again', async () => {
  const before = user('rita@example.com');
  assert.ok(before.disabled);
  assert.equal(
    ok(['reset-password', '--email', 'Rita@example.com', '--password', 'ritas new password']),
    'password of rita@example.com changed; their sessions are signed out.\n',
  );
  const after = user('rita@example.com');
  assert.ok(await auth.verifyPassword('ritas new password', after.password));
  assert.ok(after.epoch > before.epoch, 'sessions signed out');
  // Pinned as found: reset-password also re-enables a disabled account (lib/cliAccount.ts passes `disabled: false`);
  // neither the command's message nor docs/go-live.md mentions it.
  assert.equal(after.disabled, undefined);
  assert.equal(refused(['reset-password', '--email', 'nobody@example.com']), 'lampo: lampo admin reset-password --email you@example.com (an existing account)');
  assert.equal(refused(['reset-password']), 'lampo: lampo admin reset-password --email you@example.com (an existing account)');
  assert.equal(refused(['reset-password', '--email', 'mia@example.com', '--password', 'short']), 'lampo: password must be at least 10 characters');
});

test('invite, invites, revoke-invite: a link that works once, the list, and revoking it', () => {
  assert.equal(ok(['invites']), 'no invites.\n');
  const [url, line] = ok(['invite', '--email', 'noa@example.com', '--role', 'reviewer']).trim().split('\n');
  assert.match(url as string, /^https:\/\/review\.test\/#\/invite\/inv_[\w-]{32}$/);
  assert.match(line as string, /^invites a reviewer \(noa@example\.com\); works once, until \d{4}-\d{2}-\d{2} \d{2}:\d{2}\.$/);
  const made = JSON.parse(ok(['invite', '--json']));
  assert.deepEqual([made.invite.role, made.invite.by, made.invite.status], ['member', 'tester', 'pending'], 'a member by default, made by VR_USER');
  assert.match(made.url, /^https:\/\/review\.test\/#\/invite\/inv_/);
  const id: string = made.invite.id;
  const listed = ok(['invites']).trim().split('\n');
  assert.equal(listed.length, 2);
  const mine = listed.find((l) => l.endsWith(id)) as string;
  assert.ok(mine.startsWith(inviteRow('pending', 'member', '–')), mine);
  assert.match(mine, /until \d{4}-\d{2}-\d{2} {2}i_[0-9a-f]{12}$/);
  assert.ok(listed.some((l) => l.startsWith(inviteRow('pending', 'reviewer', 'noa@example.com'))));
  assert.equal(ok(['revoke-invite', id]), `revoked ${id}\n`);
  assert.equal(refused(['revoke-invite', id]), `lampo: no pending invite ${id}`);
  assert.ok(
    ok(['invites'])
      .split('\n')
      .some((l) => l.startsWith(inviteRow('revoked', 'member', '–')) && l.endsWith(id)),
  );
  assert.equal(refused(['revoke-invite']), 'lampo: lampo admin revoke-invite <invite id>  (ids: lampo admin invites)');
  assert.equal(refused(['invite', '--role', 'boss']), 'lampo: --role must be one of owner, admin, member, reviewer');
  assert.equal(refused(['invite', '--days', '0']), 'lampo: an invite lasts 1–90 days');
  assert.equal(refused(['invite', '--email', 'olivia@example.com']), 'lampo: a user with olivia@example.com already exists');
  assert.match(refused(['frobnicate']), /^lampo: lampo admin create-user \| reset-password \| list-users \| invite \| invites \| revoke-invite \| workspaces/);
});

test('with workspaces, list-users prints each account’s role in the workspace it works in, and its others', async () => {
  const acme = /^created workspace (w_[a-z0-9]{12}) "Acme Films", owned by olivia@example\.com$/.exec(
    ok(['workspaces', 'create', '--name', 'Acme Films', '--owner', 'olivia@example.com']).trim(),
  )?.[1] as string;
  assert.ok(acme);
  assert.equal(
    ok(['create-user', '--email', 'ben@example.com', '--name', 'Ben', '--role', 'admin', '--workspace', acme, '--password', PASSWORD]),
    `created admin ben@example.com (Ben) in workspace ${acme}\n`,
  );
  await ws.setMemberRole('w1', user('mia@example.com').id, 'admin');
  const rows = ok(['list-users']).trim().split('\n');
  assert.match(rows[0] as string, /^roles in w1 \(.*\); another: --workspace <id>$/);
  assert.equal(
    rows.find((l) => l.includes('mia@')),
    row('admin', 'mia@example.com', 'Mia'),
    'her role in #1',
  );
  // Ben is an admin of Acme and not in #1 at all: '–' here, and where he is.
  assert.equal(ws.roleIn(acme, user('ben@example.com').id), 'admin');
  assert.equal(ws.roleIn('w1', user('ben@example.com').id), null);
  assert.equal(
    rows.find((l) => l.includes('ben@')),
    `${row('–', 'ben@example.com', 'Ben')}  (also admin in ${acme})`,
  );
  assert.equal(
    ok(['list-users', '--workspace', acme])
      .split('\n')
      .find((l) => l.includes('ben@')),
    row('admin', 'ben@example.com', 'Ben'),
  );
  // An invite into Acme is listed where it leads: with Acme's invites, not with #1's.
  const into = JSON.parse(ok(['invite', '--workspace', acme, '--json']));
  assert.equal(into.invite.workspace, acme);
  assert.ok(!ok(['invites']).includes(into.invite.id), "not among #1's invites");
  assert.ok(
    ok(['invites', '--workspace', acme])
      .split('\n')
      .some((l) => l.startsWith(inviteRow('pending', 'member', '–')) && l.endsWith(into.invite.id)),
  );
});
