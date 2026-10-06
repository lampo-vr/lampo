// One address, one spelling (A12 INV-REV-9): what is typed is NFKC-normalised and lower-cased, its domain written in its
// ASCII (IDNA) form without a trailing dot, its local part plain ASCII (the mailer has no SMTPUTF8), and it follows the
// mailer's own rule — so look-alikes, invisible characters and addresses no email can reach make no account. An
// address stored before the rule still finds its account and signs in.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';
import { client, type Request } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');
const links = await import('../../lib/accountLinks.ts');
const { checkAddress } = await import('../../lib/mail/mime.ts');
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
type User = import('../../lib/auth.ts').User;

const PW = 'a long password';
const ctx = createContext({ cfg: loadConfig(), token: 'unused' });
let server: http.Server;
let request: Request;
before(async () => {
  server = http.createServer(createApp(ctx));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  request = client((server.address() as AddressInfo).port, { Connection: 'close', Host: 'review.test' });
});
after(() => {
  ctx.mail.stop();
  server.close();
});

test('INV-REV-9: one spelling per address: full-width, the Kelvin sign, case, an IDN domain, a trailing dot', () => {
  assert.equal(auth.checkEmail('  Kate@Example.COM '), 'kate@example.com');
  assert.equal(auth.checkEmail('ｋａｔｅ@example.com'), 'kate@example.com', 'full-width letters are the same letters');
  assert.equal(auth.checkEmail('\u212aate@example.com'), 'kate@example.com', 'the Kelvin sign is a k');
  assert.equal(auth.checkEmail('kate@exämple.com'), 'kate@xn--exmple-cua.com', 'a domain in its ASCII form');
  assert.equal(auth.checkEmail('kate@xn--exmple-cua.com'), 'kate@xn--exmple-cua.com');
  assert.equal(auth.checkEmail('kate@example.com.'), 'kate@example.com', 'no trailing dot');
  assert.equal(auth.checkEmail('kate+lampo@example.com'), 'kate+lampo@example.com', '+tags stay their own addresses');
});

test('INV-REV-9: look-alikes, invisible characters and what the mailer can’t send to are no address', () => {
  for (const bad of [
    'josé@example.com',
    'jose\u0301@example.com',
    'k\u0430te@example.com',
    'ka\u200bte@example.com',
    'kate\u2060@example.com',
    '\u0130nes@example.com',
    'a,b@example.com',
    '"q"@example.com',
    'kate(x)@example.com',
    'a:b@example.com',
    '<k>@example.com',
    'kate@exa mple.com',
    'kate@-example.com',
    'kate@',
  ])
    assert.throws(() => auth.checkEmail(bad), /not an email address/, JSON.stringify(bad));
  // whatever checkEmail takes, the mailer sends to
  for (const ok of ['kate@example.com', 'k.ate+x@sub.example.co.uk', 'kate@xn--exmple-cua.com']) assert.doesNotThrow(() => checkAddress(auth.checkEmail(ok)));
});

test('INV-REV-9: full-width Kate signing up is Kate (one account); an address stored before the rule still signs in', async () => {
  const kate = await auth.createUser({ email: 'kate@example.com', name: 'Kate', password: PW, role: 'owner' });
  assert.equal(auth.findUserByEmail('ＫＡＴＥ@example.com')?.id, kate.id);
  // An account from before, stored as typed then (NFD, a combining accent): found and signed in as it was.
  const f = JSON.parse(fs.readFileSync(auth.USERS_FILE, 'utf8')) as { users: User[] };
  const old = { ...(f.users[0] as User), id: 'u_0123456789ab', email: 'jose\u0301@example.com', name: 'José' };
  f.users.push(old);
  fs.writeFileSync(auth.USERS_FILE, JSON.stringify(f));
  assert.equal(auth.findUserByEmail('jose\u0301@example.com')?.id, old.id);
  const r = await request('POST', '/api/auth/login', { body: { email: 'jose\u0301@example.com', password: PW }, headers: { Origin: PUBLIC } });
  assert.equal(r.status, 200, r.text);
  // … and can ask for a new password at it.
  const forgot = await request('POST', '/api/auth/forgot', { body: { email: 'jose\u0301@example.com' }, headers: { Origin: PUBLIC } });
  assert.equal(forgot.status, 200, forgot.text);
  await ctx.mail.flush();
  const made = JSON.parse(fs.readFileSync(links.LINKS_FILE, 'utf8')) as { links: { user: string; kind: string }[] };
  assert.ok(
    made.links.some((l) => l.user === old.id && l.kind === 'reset'),
    'a reset link for the older account',
  );
});

test('INV-REV-9: an address kept in another spelling before the rule gets no second account; limits count one address', async () => {
  const f = JSON.parse(fs.readFileSync(auth.USERS_FILE, 'utf8')) as { users: User[] };
  f.users.push({ ...(f.users[0] as User), id: 'u_0123456789ac', email: 'ｍｉａ@example.com', name: 'Mia' });
  fs.writeFileSync(auth.USERS_FILE, JSON.stringify(f));
  await assert.rejects(auth.createUser({ email: 'mia@example.com', name: 'Mia Two', password: PW, role: 'member' }), /already exists/);
  assert.equal(auth.findUserByEmail('ｍｉａ@example.com')?.id, 'u_0123456789ac', 'found as typed');
  assert.equal(auth.emailKey('ＫＡＴＥ@Example.com.'), auth.emailKey('kate@example.com'));
  assert.ok(auth.sameEmail('kate@xn--exmple-cua.com', 'Kate@exämple.com'));
});
