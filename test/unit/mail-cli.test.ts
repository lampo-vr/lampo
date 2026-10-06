// The processes, not just the functions: the server refuses to start with VR_SIGNUP=open off a hosted server (only one
// hosted with workspaces gives each sign-up a workspace of its own) or with
// SMTP but no sender, each with its sentence; `vr admin mail-test` writes its message to the outbox when no relay is
// set (and says so). Every child gets a throwaway store and no mail setting from the shell.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT, tmpdir } from '../lib/helpers.ts';

const DROP = /^(VR_|CLAUDE_)/;
function env(extra: Record<string, string>): NodeJS.ProcessEnv {
  const dir = tmpdir('vr-mail-cli-');
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !DROP.test(k)));
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  return {
    ...base,
    VR_DATA: path.join(dir, 'data'),
    VR_CACHE: path.join(dir, 'cache'),
    VR_CONFIG: path.join(dir, 'config.json'),
    VR_HOST: '127.0.0.1',
    VR_PORT: '0',
    VR_STT: 'off',
    XDG_CONFIG_HOME: path.join(dir, 'xdg'),
    ...extra,
  };
}
const server = (extra: Record<string, string>) =>
  spawnSync(process.execPath, [path.join(ROOT, 'server/index.ts')], { env: env(extra), encoding: 'utf8', timeout: 20_000 });

test('the app on a person’s own machine refuses to start with VR_SIGNUP=open (a hosted server gives each sign-up a workspace)', () => {
  const r = server({ VR_PUBLIC_URL: 'https://review.example.com', VR_SIGNUP: 'open' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /VR_SIGNUP=open is for a hosted server with workspaces/);
});

test('the server refuses SMTP without a sender, and a sign-up mode it doesn’t know', () => {
  const r = server({ VR_MODE: 'server', VR_PUBLIC_URL: 'https://review.example.com', VR_SMTP_URL: 'smtp://u:p@relay.example.com', VR_SIGNUP: 'sometimes' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /VR_SMTP_URL needs VR_MAIL_FROM/);
  assert.match(r.stderr, /VR_SIGNUP must be off, invite or open/);
  assert.ok(!r.stderr.includes('u:p@'), 'the credentials are never printed');
});

test('vr admin mail-test writes to the outbox without a relay, and says it was not sent', () => {
  const e = env({ VR_PUBLIC_URL: 'https://review.example.com' });
  const r = spawnSync(path.join(ROOT, 'bin/vr'), ['admin', 'mail-test', 'mia@example.com', '--lang', 'de'], { env: e, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no VR_SMTP_URL: the test was written to .*outbox/);
  const box = path.join(e.VR_CACHE as string, 'outbox');
  const json = fs.readdirSync(box).find((f) => f.endsWith('.json')) as string;
  const m = JSON.parse(fs.readFileSync(path.join(box, json), 'utf8'));
  assert.deepEqual([m.to, m.kind, m.lang, m.subject], ['mia@example.com', 'test', 'de', 'Test-E-Mail von Lampo']);
  const bad = spawnSync(path.join(ROOT, 'bin/vr'), ['admin', 'mail-test', 'not-an-address'], { env: e, encoding: 'utf8', timeout: 30_000 });
  assert.notEqual(bad.status, 0);
});
