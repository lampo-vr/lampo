// The app on a person's own machine is its owner for every request from the machine itself — and another account on
// a shared machine reaches the same localhost port (A12 AGENT-9): it could act as the owner, read everything and start
// the owner's Claude Code sessions with its own words. Where the system says who is connecting (Linux: the connecting
// socket's row in /proc/net/tcp names its account), a loopback request from another account is nobody; elsewhere the
// limit is documented (SECURITY.md). A store other accounts can read is said at start, and a new one is made private.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Request } from 'express';
import { isolatedEnv, tmpdir } from '../lib/helpers.ts';

isolatedEnv();
const { createIdentify, peerUidFrom } = await import('../../server/auth.ts');
const auth = await import('../../lib/auth.ts');
const { openToOthers } = await import('../../lib/paths.ts');

auth.ensureLocalOwner('tester');

// A loopback connection from port 51234 to the app on 4747, as /proc/net/tcp lists it: the app's listening socket and
// its end of the connection (account 1000), and the connecting end (account 1001).
const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:128B 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41210 1 0000000000000000 100 0 0 10 0
   1: 0100007F:128B 0100007F:C822 01 00000000:00000000 00:00000000 00000000  1000        0 41377 1 0000000000000000 20 4 30 10 -1
   2: 0100007F:C822 0100007F:128B 01 00000000:00000000 00:00000000 00000000  1001        0 41376 1 0000000000000000 20 4 30 10 -1
`;
const TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:C823 00000000000000000000000001000000:128B 01 00000000:00000000 00:00000000 00000000  1002        0 41400 1 0000000000000000 20 4 30 10 -1
`;

test('AGENT-9: the account behind a loopback connection, read from the kernel’s table', () => {
  assert.equal(peerUidFrom([TCP, TCP6], 51234, 4747), 1001, 'the connecting end, not the app’s');
  assert.equal(peerUidFrom([TCP, TCP6], 51235, 4747), 1002, 'IPv6');
  assert.equal(peerUidFrom([TCP, TCP6], 40000, 4747), null, 'no such connection: can’t be told');
  assert.equal(peerUidFrom([], 51234, 4747), null, 'no table (macOS, Windows)');
  assert.equal(peerUidFrom(['garbage\n1: x y\n'], 51234, 4747), null);
});

function loopback(): Request {
  return { socket: { remoteAddress: '127.0.0.1', remotePort: 51234, localPort: 4747 }, headers: {}, query: {} } as unknown as Request;
}

test('AGENT-9: on the machine, a loopback request from another account is nobody; its own account, root or unknown is the owner', () => {
  const as = (peer: number | null) => createIdentify({ machine: true, peerUid: () => peer, uid: 1000 })(loopback());
  assert.equal(as(1001), null, 'another account');
  assert.equal(as(1000)?.via, 'local', 'the owner’s own account');
  assert.equal(as(0)?.via, 'local', 'root (it reads the store anyway)');
  assert.equal(as(null)?.via, 'local', 'where the system can’t tell: as before (documented)');
});

test('AGENT-9: a store other accounts can open is named; one only its owner can open is not', () => {
  const root = tmpdir();
  const store = path.join(root, 'home', '.video-review', 'data');
  fs.mkdirSync(store, { recursive: true });
  for (const d of [root, path.join(root, 'home'), path.join(root, 'home', '.video-review'), store]) fs.chmodSync(d, 0o755);
  // (the walk stops at the test's own folder: the system's temp folder above it is private already)
  assert.match(openToOthers(store, root) ?? '', /other accounts/);
  // a private folder anywhere on the way closes it
  fs.chmodSync(path.join(root, 'home'), 0o750);
  assert.equal(openToOthers(store, root), null);
  fs.chmodSync(path.join(root, 'home'), 0o755);
  fs.chmodSync(store, 0o700);
  assert.equal(openToOthers(store, root), null);
});
