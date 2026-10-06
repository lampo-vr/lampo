// The server's hourly mail budget is everyone's: resets and confirmations of every team wait behind it. Each workspace
// sends its invites out of its own share of the hour (a quarter by default), so one team inviting hundreds can't hold
// back the others; over its share, inviting by email answers 429 with when to try again, before anything is made
// (audit A12 verification: the mail budget per workspace). Every message goes to the log transport's outbox.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';
import { client, type Request } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
// A developer's shell may carry mail settings of its own: the test's limits are the test's (A12 VE2b-6).
process.env.VR_MAIL_PER_WORKSPACE_HOUR = '1';
// 8 an hour for the server: 2 for each workspace's invites.
isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_MAIL_PER_HOUR: '8' } });
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const auth = await import('../../lib/auth.ts');
const workspaces = await import('../../lib/workspaces.ts');
const { createMailer, readOutbox } = await import('../../lib/mail/index.ts');
const { mailConfig, workspaceShare } = await import('../../lib/mail/config.ts');

const PASSWORD = 'a long password';
const origin = { Origin: PUBLIC };
const ctx = createContext({ cfg: loadConfig(), token: 'unused' });
let server: http.Server;
let request: Request;
const as: Record<string, Record<string, string>> = {};
let B = '';
let bobId = '';

async function signIn(email: string, workspace?: string): Promise<Record<string, string>> {
  const r = await request('POST', '/api/auth/login', { body: { email, password: PASSWORD }, headers: origin });
  assert.equal(r.status, 200, r.text);
  let cookie = String([r.headers['set-cookie']].flat()[0]).split(';')[0];
  if (workspace) {
    const s = await request('POST', '/api/workspaces/switch', { body: { id: workspace }, headers: { Cookie: cookie, ...origin } });
    assert.equal(s.status, 200, s.text);
    cookie = String([s.headers['set-cookie']].flat()[0]).split(';')[0];
  }
  return { Cookie: cookie, ...origin };
}

before(async () => {
  server = http.createServer(createApp(ctx));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  request = client((server.address() as AddressInfo).port, { Host: 'review.test' });
  await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: PASSWORD, role: 'owner' });
  const bob = await auth.createUser({ email: 'bob@example.com', name: 'Bob', password: PASSWORD, role: 'reviewer' });
  await auth.createUser({ email: 'max@example.com', name: 'Max', password: PASSWORD, role: 'member' });
  bobId = bob.id;
  B = workspaces.createWorkspace({ name: 'Bravo Pictures', ownerId: bob.id }).id;
  as.olivia = await signIn('olivia@example.com');
  as.bob = await signIn('bob@example.com', B);
});
after(() => {
  ctx.mail.stop();
  server.closeAllConnections();
  server.close();
});

const invite = (who: Record<string, string>, email: string) =>
  request('POST', '/api/admin/invites', { body: { role: 'member', name: 'New', email, send: true }, headers: who });

test('the share: a quarter of the server’s hour unless set, never more than all of it', () => {
  assert.equal(workspaceShare({ per_hour: 200 }), 50);
  assert.equal(workspaceShare({ per_hour: 8 }), 2);
  assert.equal(workspaceShare({ per_hour: 2 }), 1, 'at least one');
  assert.equal(workspaceShare({ per_hour: 200, per_workspace_hour: 500 }), 200, 'never more than the server’s');
  assert.equal(mailConfig({}, { VR_MAIL_PER_HOUR: '100', VR_MAIL_PER_WORKSPACE_HOUR: '10' }).per_workspace_hour, 10);
});

test('the mailer: a workspace’s invites stop at its share; other workspaces and account mail go on', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-share-'));
  const lines: string[] = [];
  const mailer = createMailer({
    config: { transport: 'log', smtp_url: null, from: null, reply_to: null, per_hour: 8 },
    dir: path.join(dir, 'mail'),
    outbox: path.join(dir, 'outbox'),
    from: { name: 'Lampo', address: 'lampo@review.test' },
    host: 'review.test',
    secret: () => Buffer.alloc(32, 7),
    log: (l) => lines.push(l),
  });
  try {
    const msg = (to: string, workspace?: string) => ({
      kind: 'invite' as const,
      to,
      lang: 'en',
      subject: 'You are invited',
      text: 'x',
      html: '<p>x</p>',
      ...(workspace ? { workspace } : {}),
    });
    assert.equal(mailer.workspaceShare, 2);
    assert.deepEqual(
      ['a1', 'a2', 'a3'].map((n) => mailer.send(msg(`${n}@example.com`, 'w_a'))),
      [true, true, false],
    );
    assert.ok(mailer.workspaceWait('w_a') > 0, 'and says when it may again');
    assert.equal(mailer.workspaceWait('w_b'), 0);
    assert.equal(mailer.send(msg('b1@example.com', 'w_b')), true, 'another workspace has its own share');
    assert.equal(mailer.send({ ...msg('c1@example.com'), kind: 'reset' as const }), true, 'account mail isn’t a workspace’s');
    assert.ok(lines.some((l) => /its workspace has sent its 2 for this hour/.test(l)));
  } finally {
    mailer.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('over its share, emailing an invite answers 429 with when to try again, and makes nothing; another team still invites', async () => {
  for (const n of [1, 2]) {
    const r = await invite(as.olivia as Record<string, string>, `new${n}@example.com`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json().sent, true);
  }
  const before = auth.listInvites('w1').length;
  const over = await invite(as.olivia as Record<string, string>, 'new3@example.com');
  assert.equal(over.status, 429, over.text);
  assert.match(over.json().error, /this workspace has emailed all the invites it may for this hour.*try again in \d+ min/);
  assert.ok(Number(over.headers['retry-after']) > 0, 'Retry-After');
  assert.equal(auth.listInvites('w1').length, before, 'no invite was made');

  // sending one again is held the same way
  const pending = auth.listInvites('w1')[0];
  assert.ok(pending);
  const again = await request('POST', `/api/admin/invites/${pending.id}/send`, { body: {}, headers: as.olivia });
  assert.equal(again.status, 429, again.text);
  assert.match(again.json().error, /this workspace has emailed all the invites/);

  // the link can still be made and copied
  const link = await request('POST', '/api/admin/invites', { body: { role: 'member', name: 'Copy', email: 'copy@example.com' }, headers: as.olivia });
  assert.equal(link.status, 200, link.text);
  assert.equal(link.json().sent, false);

  // another workspace has its own share
  const bravo = await invite(as.bob as Record<string, string>, 'bravo1@example.com');
  assert.equal(bravo.status, 200, bravo.text);
  assert.equal(bravo.json().sent, true);
});

// One account, many workspaces of its own (10 a day are allowed): its invites still take one share of the hour, not one
// per workspace; and its address changes come out of the same share, a few an hour (A12 verification: VE2b-5).
test('one account’s workspaces add up to one share; its address changes are capped and count against it', async () => {
  // Bob sent one invite from B above; a second workspace of his takes the rest of his share, a third one nothing
  const more = [workspaces.createWorkspace({ name: 'Bravo Two', ownerId: bobId }).id, workspaces.createWorkspace({ name: 'Bravo Three', ownerId: bobId }).id];
  const inSecond = await invite(await signIn('bob@example.com', more[0]), 'bravo2@example.com');
  assert.equal(inSecond.status, 200, inSecond.text);
  assert.equal(inSecond.json().sent, true);
  const inThird = await invite(await signIn('bob@example.com', more[1]), 'bravo3@example.com');
  assert.equal(inThird.status, 429, inThird.text);
  assert.match(inThird.json().error, /you have emailed all the invites you may for this hour/);

  // Max changes his address: his share of the hour (2 here), then 429 — nothing more is queued
  const max = await signIn('max@example.com');
  const codes: number[] = [];
  for (let i = 0; i < 6; i++)
    codes.push((await request('PATCH', '/api/auth/me', { body: { email: `max${i}@example.com`, current_password: PASSWORD }, headers: max })).status);
  assert.deepEqual(codes, [200, 200, 429, 429, 429, 429]);
});

test('a password reset is never held back by the hour’s other mail: it goes first, with a part of the hour kept for it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-lane-'));
  const mailer = createMailer({
    config: { transport: 'log', smtp_url: null, from: null, reply_to: null, per_hour: 8 },
    dir: path.join(dir, 'mail'),
    outbox: path.join(dir, 'outbox'),
    from: { name: 'Lampo', address: 'lampo@review.test' },
    host: 'review.test',
    secret: () => Buffer.alloc(32, 7),
    log: () => {},
  });
  try {
    const msg = (kind: 'verify-change' | 'reset', to: string) => ({ kind, to, lang: 'en', subject: 's', text: 'x', html: '<p>x</p>' });
    // twenty address-change confirmations waiting (from as many accounts), then one reset
    for (let i = 0; i < 20; i++) assert.equal(mailer.send(msg('verify-change', `new${i}@example.com`)), true);
    await mailer.flush();
    assert.equal(mailer.send(msg('reset', 'vera@example.com')), true);
    await mailer.flush();
    const sent = readOutbox(path.join(dir, 'outbox'));
    assert.ok(
      sent.some((m) => m.kind === 'reset'),
      'the reset went out this hour',
    );
    assert.equal(sent.filter((m) => m.kind === 'verify-change').length, 6, 'the rest of the mail took three quarters of the hour');
    assert.equal(mailer.waiting(), 14);
  } finally {
    mailer.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A13 CLOUD-6: resets and sign-up confirmations shared the first lane, first come first served, so with a relay that
// takes 20 an hour (per_hour below), 80 confirmations to throwaway addresses held a real person's reset back four hours,
// past its link's life.
test('a flood of sign-up confirmations never holds a reset back: resets have a lane, and a part of the hour, of their own', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-lane-'));
  let clock = Date.parse('2026-10-06T10:00:00Z');
  const mailer = createMailer({
    config: { transport: 'log', smtp_url: null, from: null, reply_to: null, per_hour: 20 },
    dir: path.join(dir, 'mail'),
    outbox: path.join(dir, 'outbox'),
    from: { name: 'Lampo', address: 'lampo@review.test' },
    host: 'review.test',
    secret: () => Buffer.alloc(32, 7),
    log: () => {},
    now: () => clock,
  });
  try {
    const msg = (kind: 'verify' | 'reset', to: string) => ({ kind, to, lang: 'en', subject: 's', text: 'x', html: '<p>x</p>', expires: clock + 3600e3 });
    const sent = () => readOutbox(path.join(dir, 'outbox'));
    // the flood comes first and is sent as far as the hour allows
    for (let i = 0; i < 80; i++) assert.equal(mailer.send(msg('verify', `junk${i}@example.org`)), true);
    await mailer.flush();
    clock += 60e3;
    // a minute later a customer asks for a new password: it goes out now, not in four hours
    assert.equal(mailer.send(msg('reset', 'customer@example.com')), true);
    await mailer.flush();
    assert.ok(
      sent().some((m) => m.kind === 'reset'),
      `the reset went out this hour (${sent().length} sent)`,
    );
    assert.equal(sent().filter((m) => m.kind === 'verify').length, 15, 'confirmations took three quarters of the hour');
    // and queued behind the flood, a second reset goes first once there is room
    assert.equal(mailer.send(msg('reset', 'second@example.com')), true);
    await mailer.flush();
    assert.ok(sent().some((m) => m.to === 'second@example.com'));
  } finally {
    mailer.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A13 VERIFY-4: within the resets' lane it was first come, first served: one address asking 80 resets an hour (for
// sign-ups of its own) kept a real person's reset waiting past its link's hour. One asked from an address waits at a
// time now; more from it are dropped (the asker hears the same either way).
test('a reset flood from one address holds one place in the resets’ lane: a real reset goes out within minutes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-lane-'));
  const t0 = Date.parse('2026-10-06T10:00:00Z');
  let clock = t0;
  const mailer = createMailer({
    config: { transport: 'log', smtp_url: null, from: null, reply_to: null, per_hour: 20 },
    dir: path.join(dir, 'mail'),
    outbox: path.join(dir, 'outbox'),
    from: { name: 'Lampo', address: 'lampo@review.test' },
    host: 'review.test',
    secret: () => Buffer.alloc(32, 7),
    log: () => {},
    now: () => clock,
  });
  try {
    const reset = (to: string, asker: string) => ({
      kind: 'reset' as const,
      to,
      asker,
      lang: 'en',
      subject: 's',
      text: 'x',
      html: '<p>x</p>',
      expires: clock + 3600e3,
    });
    const sentTo = (to: string) => readOutbox(path.join(dir, 'outbox')).some((m) => m.to === to);
    let n = 0;
    let asked = 0;
    let answered = 0;
    // two hours of one reset every 45 s (80 an hour) from one /64, round robin over 16 addresses of its own
    for (let s = 0; s < 2 * 3600; s += 45) {
      clock = t0 + s * 1000;
      mailer.send(reset(`held${n++ % 16}@example.org`, '2001:db8:77::/64'));
      // after an hour of it, a customer asks from elsewhere
      if (!asked && s >= 3600) {
        asked = clock;
        assert.equal(mailer.send(reset('customer@example.com', '198.51.100.7')), true);
      }
      await mailer.flush();
      if (asked && !answered && sentTo('customer@example.com')) answered = clock;
    }
    assert.ok(answered, 'the customer’s reset went out');
    assert.ok(answered - asked <= 5 * 60e3, `sent ${(answered - asked) / 60e3} min after asking`);
  } finally {
    mailer.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mail dropped because its link expired counts nothing toward the hour', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-lane-'));
  const t0 = Date.parse('2026-10-06T10:00:00Z');
  let clock = t0;
  const mailer = createMailer({
    config: { transport: 'log', smtp_url: null, from: null, reply_to: null, per_hour: 4 },
    dir: path.join(dir, 'mail'),
    outbox: path.join(dir, 'outbox'),
    from: { name: 'Lampo', address: 'lampo@review.test' },
    host: 'review.test',
    secret: () => Buffer.alloc(32, 7),
    log: () => {},
    now: () => clock,
  });
  try {
    const reset = (to: string, minutes: number) => ({
      kind: 'reset' as const,
      to,
      lang: 'en',
      subject: 's',
      text: 'x',
      html: '<p>x</p>',
      expires: clock + minutes * 60e3,
    });
    // ten resets whose links live a minute: four go out, six wait for the hour and expire meanwhile
    for (let i = 0; i < 10; i++) assert.equal(mailer.send(reset(`p${i}@example.com`, 1)), true);
    await mailer.flush();
    assert.equal(readOutbox(path.join(dir, 'outbox')).length, 4);
    // an hour on, someone asks: the six expired ones are dropped, and the hour is all there for the new one
    clock = t0 + 61 * 60e3;
    assert.equal(mailer.send(reset('customer@example.com', 60)), true);
    await mailer.flush();
    assert.ok(
      readOutbox(path.join(dir, 'outbox')).some((m) => m.to === 'customer@example.com'),
      'the new reset went out',
    );
    assert.equal(mailer.waiting(), 0, 'the expired ones are gone');
  } finally {
    mailer.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a shell’s mail settings never reach a test: isolatedEnv clears every VR_MAIL_ and VR_SMTP_ variable', () => {
  assert.equal(process.env.VR_MAIL_PER_WORKSPACE_HOUR, undefined);
});
