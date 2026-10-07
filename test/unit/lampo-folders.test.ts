// `lampo login` keeps its login in $XDG_CONFIG_HOME/lampo/ and a hosted server's downloads in $XDG_CACHE_HOME/lampo/.
// A login an older `vr login` saved in video-review/ is read while the new folder has none, and never written: a new
// login goes to the new folder, a logout forgets both (or the old one would keep the machine signed in). An unfinished
// upload's resume list comes along into a new cache; the old folders stay as they were.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';

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
