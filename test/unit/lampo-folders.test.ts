// `lampo login` keeps its login in $XDG_CONFIG_HOME/lampo/ and a hosted server's downloads in $XDG_CACHE_HOME/lampo/.
// A login an older `vr login` saved in video-review/ is read while the new folder has none, and never written: a new
// login goes to the new folder, a logout forgets both (or the old one would keep the machine signed in). An unfinished
// upload's resume list comes along into a new cache; the old folders stay as they were. A logout revokes both logins'
// tokens, each on its own server; a server and a token from the environment come as a pair from one spelling.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { isolatedEnv, ROOT } from '../lib/helpers.ts';

const { env } = isolatedEnv();
for (const k of ['REMOTE', 'SERVER', 'TOKEN']) {
  delete process.env[`VR_${k}`];
  delete process.env[`LAMPO_${k}`];
}
const config = env.XDG_CONFIG_HOME as string;
const cache = env.XDG_CACHE_HOME as string;
const { adoptOldCache, cacheRoot, clearCredentials, configDir, credentialsFile, oldCacheRoot, oldCredentialsFile, readCredentials, saveCredentials } =
  await import('../../lib/backend/credentials.ts');

const write = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};

test('the folders are named lampo, in the XDG places', () => {
  assert.equal(configDir(), path.join(config, 'lampo'));
  assert.equal(credentialsFile(), path.join(config, 'lampo', 'credentials.json'));
  assert.equal(oldCredentialsFile(), path.join(config, 'video-review', 'credentials.json'));
  assert.equal(cacheRoot(), path.join(cache, 'lampo'));
  assert.equal(oldCacheRoot(), path.join(cache, 'video-review'));
});

test('a login an older vr saved is read until a new one is; it is never written, and logout forgets both', () => {
  const old = { server: 'https://old.example.com', token: 'older-login' };
  write(oldCredentialsFile(), old);
  const before = fs.readFileSync(oldCredentialsFile(), 'utf8');
  assert.deepEqual(readCredentials(), old, 'still signed in after the rename');
  assert.ok(!fs.existsSync(configDir()), 'reading makes nothing');

  saveCredentials({ server: 'https://new.example.com', token: 'newer-login' });
  assert.equal(fs.statSync(credentialsFile()).mode & 0o777, 0o600);
  assert.equal(readCredentials()?.server, 'https://new.example.com', 'the new place wins');
  assert.equal(fs.readFileSync(oldCredentialsFile(), 'utf8'), before, 'the old file untouched');

  assert.equal(clearCredentials(), true);
  assert.ok(!fs.existsSync(credentialsFile()) && !fs.existsSync(oldCredentialsFile()));
  assert.equal(readCredentials(), null, 'signed out: no older login takes over');
  assert.equal(clearCredentials(), false, 'nothing left to forget');
});

test('a server from the environment, in either spelling; REMOTE=0 keeps the local store', () => {
  write(credentialsFile(), { server: 'https://saved.example.com', token: 'saved' });
  process.env.VR_SERVER = 'https://vr.example.com';
  process.env.VR_TOKEN = 'from-vr';
  assert.equal(readCredentials()?.server, 'https://vr.example.com');
  process.env.LAMPO_SERVER = 'https://lampo.example.com';
  process.env.LAMPO_TOKEN = 'from-lampo';
  assert.deepEqual(readCredentials(), { server: 'https://lampo.example.com', token: 'from-lampo' });
  for (const k of ['VR_SERVER', 'VR_TOKEN', 'LAMPO_SERVER', 'LAMPO_TOKEN']) delete process.env[k];
  assert.equal(readCredentials()?.server, 'https://saved.example.com');
  process.env.VR_REMOTE = '0';
  assert.equal(readCredentials(), null);
  delete process.env.VR_REMOTE;
  process.env.LAMPO_REMOTE = '0';
  assert.equal(readCredentials(), null);
  delete process.env.LAMPO_REMOTE;
  clearCredentials();
});

test('an older cache: its unfinished uploads come along once, nothing else, and it stays as it was', () => {
  const root = path.join(cache, 'adopt', 'lampo');
  const old = path.join(cache, 'adopt', 'video-review');
  write(path.join(old, 'uploads.json'), { 'tus::fingerprint': [{ uploadUrl: 'https://media.example.com/u/1' }] });
  write(path.join(old, 'host', 'slug', 'shot.png'), 'png');
  const before = fs.readFileSync(path.join(old, 'uploads.json'), 'utf8');
  adoptOldCache(root, old);
  assert.equal(fs.readFileSync(path.join(root, 'uploads.json'), 'utf8'), before);
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(root, 'uploads.json')).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(path.join(root, 'host')), 'screenshots are fetched again when asked for');
  assert.equal(fs.readFileSync(path.join(old, 'uploads.json'), 'utf8'), before, 'the old cache untouched');
  // once the new cache is there, it is this one's
  fs.writeFileSync(path.join(root, 'uploads.json'), '{}');
  adoptOldCache(root, old);
  assert.equal(fs.readFileSync(path.join(root, 'uploads.json'), 'utf8'), '{}');
  // no older cache: nothing made
  const fresh = path.join(cache, 'fresh', 'lampo');
  adoptOldCache(fresh, path.join(cache, 'fresh', 'video-review'));
  assert.ok(!fs.existsSync(fresh));
});

test('a server and its token from the environment are one pair from one spelling, never VR_TOKEN sent to LAMPO_SERVER', () => {
  const keep = { ...process.env };
  const set = (vars: Record<string, string>) => {
    for (const k of ['SERVER', 'TOKEN']) {
      delete process.env[`VR_${k}`];
      delete process.env[`LAMPO_${k}`];
    }
    Object.assign(process.env, vars);
  };
  try {
    set({ LAMPO_SERVER: 'https://b.example.com', VR_SERVER: 'https://a.example.com', VR_TOKEN: 'a-token' });
    assert.equal(readCredentials(), null, "A's token never goes to B: LAMPO_SERVER without LAMPO_TOKEN is no login");
    set({ LAMPO_TOKEN: 'b-token', VR_SERVER: 'https://a.example.com', VR_TOKEN: 'a-token' });
    assert.equal(readCredentials(), null, "and B's token never goes to A");
    set({ VR_SERVER: 'https://a.example.com', VR_TOKEN: 'a-token' });
    assert.deepEqual(readCredentials(), { server: 'https://a.example.com', token: 'a-token' }, 'the older pair alone still works');
    set({ LAMPO_SERVER: 'https://b.example.com', LAMPO_TOKEN: 'b-token', VR_SERVER: 'https://a.example.com', VR_TOKEN: 'a-token' });
    assert.deepEqual(readCredentials(), { server: 'https://b.example.com', token: 'b-token' });
  } finally {
    for (const k of ['SERVER', 'TOKEN']) {
      delete process.env[`VR_${k}`];
      delete process.env[`LAMPO_${k}`];
    }
    Object.assign(process.env, keep);
  }
});

test('logout revokes the token of every saved login, an older vr login too, each on its own server', async () => {
  const asked: string[] = [];
  const serve = (name: string) =>
    new Promise<http.Server>((resolve) => {
      const s = http.createServer((req, res) => {
        asked.push(`${name} ${req.method} ${req.url} ${req.headers.authorization}`);
        res.writeHead(204).end();
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
  const [a, b] = await Promise.all([serve('A'), serve('B')]);
  const url = (s: http.Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  try {
    write(oldCredentialsFile(), { server: url(a), token: 'old-token', token_id: 't_old' });
    write(credentialsFile(), { server: url(b), token: 'new-token', token_id: 't_new' });
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/lampo'), 'logout'], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    const code = await new Promise((r) => child.on('close', r));
    assert.equal(code, 0, out);
    assert.deepEqual(asked.sort(), ['A DELETE /api/auth/tokens/t_old Bearer old-token', 'B DELETE /api/auth/tokens/t_new Bearer new-token']);
    assert.match(out, /signed out of http:\/\/127\.0\.0\.1:\d+ \(token revoked\), and an older login's token revoked too/);
    assert.ok(!fs.existsSync(credentialsFile()) && !fs.existsSync(oldCredentialsFile()), 'both forgotten');
  } finally {
    a.close();
    b.close();
  }
});

/** `lampo logout` in its own process: its exit code and what it said where. */
async function runLogout(): Promise<{ code: unknown; out: string; err: string; ms: number }> {
  const started = Date.now();
  const child = spawn(process.execPath, [path.join(ROOT, 'bin/lampo'), 'logout'], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  child.stderr.on('data', (d) => {
    err += d;
  });
  const code = await new Promise((r) => child.on('close', r));
  return { code, out, err, ms: Date.now() - started };
}

/** A stand-in server that answers every request with `status`, or never answers at all. */
function standIn(status: number | 'never', onAsk: () => void = () => {}): Promise<http.Server> {
  return new Promise((resolve) => {
    const s = http.createServer((_req, res) => {
      onAsk();
      if (status === 204) res.writeHead(204).end();
      else if (status !== 'never') res.writeHead(status, { 'content-type': 'application/json' }).end('{"error":"no"}');
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const urlOf = (s: http.Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

test('logout forgets both logins before any revoke, and a silent server holds it up 5 s at most', async () => {
  let goneWhenAsked: boolean | null = null;
  const silent = await standIn('never', () => {
    goneWhenAsked = !fs.existsSync(credentialsFile()) && !fs.existsSync(oldCredentialsFile());
  });
  const ok = await standIn(204);
  try {
    write(oldCredentialsFile(), { server: urlOf(silent), token: 'old-token', token_id: 't_old' });
    write(credentialsFile(), { server: urlOf(ok), token: 'new-token', token_id: 't_new' });
    const r = await runLogout();
    assert.equal(r.code, 0, r.err);
    assert.equal(goneWhenAsked, true, 'nothing left on this machine while a server is waited for (a Ctrl-C there keeps nothing)');
    assert.ok(r.ms < 20_000, `${r.ms} ms`);
    assert.equal(r.out, `signed out of ${urlOf(ok)} (token revoked); lampo uses the local store again.\n`, 'the older one is not called revoked');
    assert.equal(
      r.err,
      `lampo: warning: the token of an older login on ${urlOf(silent)} was not revoked (no answer within 5 s): revoke it there in Settings → API tokens\n`,
    );
  } finally {
    silent.closeAllConnections();
    silent.close();
    ok.close();
  }
});

test('logout says what each server answered: not reached, refused, already invalid', async () => {
  const gone = await standIn(204);
  const unreachable = urlOf(gone);
  gone.close();
  const invalid = await standIn(401);
  const failing = await standIn(500);
  try {
    write(credentialsFile(), { server: unreachable, token: 'new-token', token_id: 't_new' });
    write(oldCredentialsFile(), { server: urlOf(invalid), token: 'old-token', token_id: 't_old' });
    let r = await runLogout();
    assert.equal(r.code, 0, r.err);
    assert.equal(
      r.out,
      `signed out of ${unreachable} (token not revoked), and an older login's token was no longer valid; lampo uses the local store again.\n`,
    );
    assert.match(r.err, /^lampo: warning: the token on http:\/\/127\.0\.0\.1:\d+ was not revoked \(the server could not be reached\): revoke it there/);
    assert.ok(!fs.existsSync(credentialsFile()) && !fs.existsSync(oldCredentialsFile()));
    write(credentialsFile(), { server: urlOf(failing), token: 'new-token', token_id: 't_new' });
    r = await runLogout();
    assert.equal(r.out, `signed out of ${urlOf(failing)} (token not revoked); lampo uses the local store again.\n`);
    assert.match(r.err, /was not revoked \(the server answered 500\)/);
  } finally {
    invalid.close();
    failing.close();
  }
});
