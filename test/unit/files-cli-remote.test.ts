// covers: lib/backend/remoteFiles.ts lib/filesSync.ts lib/cliFiles.ts server/routes/files.ts server/routes/uploads.ts
// `lampo files` against a hosted server (in-process, server mode) with an API token: a push goes up as one-time tickets
// over tus and is committed as one change, attributed to the account and its agent; the line Copy for an agent hands out
// pulls through the server's own download route; a pull, a change and a push back make the next version; a file
// someone changed meanwhile is refused with who did it. A push that broke off goes on where its upload stopped. A
// reviewer's token sees no files at all (404).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, tmpdir, VR } from '../lib/helpers.ts';

const { env } = isolatedEnv({ vars: { VR_MODE: 'server', VR_FOOTAGE: 'off', VR_OCR: 'off' } });
const auth = await import('../../lib/auth.ts');
const folders = await import('../../lib/folders.ts');
const files = await import('../../lib/files.ts');
const { inWorkspace } = await import('../../lib/scope.ts');
const { pullCommand } = await import('../../web/src/files/model.ts');
const { createRemoteBackend } = await import('../../lib/backend/remote.ts');
const { TUS } = await import('../../lib/backend/remoteFiles.ts');
const { push } = await import('../../lib/filesSync.ts');
const { hashCache } = await import('../../lib/filesLocal.ts');

const { base } = await startApp();
const PASSWORD = 'a long password';
const olivia = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: PASSWORD, role: 'owner' });
const max = await auth.createUser({ email: 'max@example.com', name: 'Max', password: PASSWORD, role: 'member' });
const rita = await auth.createUser({ email: 'rita@example.com', name: 'Rita', password: PASSWORD, role: 'reviewer' });
const tokenOf = (u: { id: string }) => auth.createToken(u.id, 'agent').token;
const asMax = { ...env, VR_SERVER: base, VR_TOKEN: tokenOf(max), VR_BY: 'agent:promo-edit' };
const asOlivia = { ...env, VR_SERVER: base, VR_TOKEN: tokenOf(olivia), VR_BY: 'agent:mix-edit' };
const asRita = { ...env, VR_SERVER: base, VR_TOKEN: tokenOf(rita) };
inWorkspace('w1', () => folders.createFolder('Acme/Spring sale'));
const own = () => inWorkspace('w1', () => files.listFiles('Acme/Spring sale', { deep: true, own: true }).files);

/** `lampo` against the app, which answers from this process: run without blocking it. */
const lampo = (args: string[], e: NodeJS.ProcessEnv, cwd?: string): Promise<{ code: number; out: string; err: string }> =>
  new Promise((resolve) =>
    execFile(process.execPath, [VR, ...args], { env: e, cwd, encoding: 'utf8', timeout: 120_000 }, (error, out, err) =>
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) || 1 : 0, out, err }),
    ),
  );

test('push, ls, the copied pull line, status and a push back: versions on the server, the account’s and its agent’s', async () => {
  const src = tmpdir('vr-rfiles-src-');
  fs.mkdirSync(path.join(src, 'Music'));
  fs.writeFileSync(path.join(src, 'Music', 'bed.wav'), crypto.randomBytes(200_000));
  fs.writeFileSync(path.join(src, 'logo.svg'), '<svg/>');
  fs.writeFileSync(path.join(src, '.env'), 'TOKEN=x');
  const pushed = await lampo(['files', 'push', `${src}/`, '--to', 'Acme/Spring sale'], asMax);
  assert.equal(pushed.code, 0, pushed.out + pushed.err);
  assert.match(pushed.out, /^pushed 2 files to 'Acme\/Spring sale' \(r1\): 2 added, 0 new versions · 200 KB sent/m);
  assert.match(pushed.out, /^left out: 1 hidden \(\.env: name one to send it\)$/m);
  const bed = own().find((f) => f.path === 'Music/bed.wav');
  assert.ok(bed);
  assert.deepEqual([bed.by, bed.agent, bed.agent_kind, bed.via], ['Max', 'promo-edit', 'cli', 'vr'], 'the account, its agent, by lampo');
  // again: the bytes are there, nothing moves
  assert.match(
    (await lampo(['files', 'push', `${src}/`, '--to', 'Acme/Spring sale'], asMax)).out,
    /^nothing to push to 'Acme\/Spring sale': 2 files unchanged/,
  );

  const ls = await lampo(['files', 'ls', 'Acme/Spring sale'], asMax);
  assert.match(ls.out, /^files for Acme\/Spring sale · Acme\/Spring sale r1 \(deepest wins\)\nAcme\/Spring sale {2}Music\/ {2}1 file {2}200 KB {2}audio\n/);

  const work = tmpdir('vr-rfiles-work-');
  const bin = tmpdir('vr-rfiles-bin-');
  fs.writeFileSync(path.join(bin, 'lampo'), `#!/bin/sh\nexec "${process.execPath}" "${VR}" "$@"\n`, { mode: 0o755 });
  const line = pullCommand('Acme/Spring sale', [], ['Music']);
  const pulled = await new Promise<string>((resolve, reject) =>
    execFile('/bin/sh', ['-c', line], { cwd: work, env: { ...asMax, PATH: `${bin}:${env.PATH}` }, encoding: 'utf8' }, (e, out, err) =>
      e ? reject(new Error(out + err)) : resolve(out),
    ),
  );
  assert.match(pulled, /^pulled 1 of 1 files from Acme\/Spring sale into public\//);
  assert.ok(fs.readFileSync(path.join(work, 'public/Music/bed.wav')).equals(fs.readFileSync(path.join(src, 'Music/bed.wav'))));

  fs.appendFileSync(path.join(work, 'public/Music/bed.wav'), 'louder');
  assert.match((await lampo(['files', 'status', '--to', 'public'], asMax, work)).out, /^changed here {2}Music\/bed\.wav$/m);
  const back = await lampo(['files', 'push', 'public/', '--to', 'Acme/Spring sale'], asMax, work);
  assert.equal(back.code, 0, back.out + back.err);
  assert.match(back.out, /^version {2}Music\/bed\.wav V2$/m);

  // someone else's version meanwhile: refused before any byte moves, with who; --copy keeps both
  const mix = tmpdir('vr-rfiles-mix-');
  fs.writeFileSync(path.join(mix, 'bed.wav'), 'their mix');
  const theirs = await lampo(['files', 'push', path.join(mix, 'bed.wav'), '--to', 'Acme/Spring sale', '--path', 'Music', '--replace'], asOlivia);
  assert.match(theirs.out, /^version {2}Music\/bed\.wav V3$/m, theirs.out + theirs.err);
  fs.appendFileSync(path.join(work, 'public/Music/bed.wav'), ' and more');
  const refused = await lampo(['files', 'push', 'public/', '--to', 'Acme/Spring sale'], asMax, work);
  assert.equal(refused.code, 1);
  assert.match(refused.out, /^conflict {2}Music\/bed\.wav V3 by agent:mix-edit \(Olivia\) · \S+ \(yours is based on V2\)$/m);
  const copy = await lampo(['files', 'push', 'public/', '--to', 'Acme/Spring sale', '--copy'], asMax, work);
  assert.equal(copy.code, 0, copy.out + copy.err);
  assert.match(copy.out, /^copy {5}Music\/bed \(promo-edit\)\.wav V1/m);
  assert.equal(own().find((f) => f.path === 'Music/bed.wav')?.v, 3, 'theirs stands');
});

test('a reviewer’s token sees no files: ls and pull answer as if there were none', async () => {
  const ls = await lampo(['files', 'ls', 'Acme/Spring sale'], asRita);
  assert.equal(ls.code, 1);
  assert.match(ls.err, /not found/);
  const pulled = await lampo(['files', 'pull', 'Acme/Spring sale', '--to', tmpdir('vr-rfiles-rita-')], asRita);
  assert.equal(pulled.code, 1);
  const pushed = await lampo(['files', 'push', tmpdir('vr-rfiles-rita-src-'), '--to', 'Acme/Spring sale'], asRita);
  assert.equal(pushed.code, 1);
});

test('a push that broke off goes on where its upload stopped (tus), and commits once', async () => {
  const old = TUS.chunk;
  TUS.chunk = 64 * 1024;
  try {
    const b = createRemoteBackend({ server: base, token: tokenOf(max) }, { cacheRoot: tmpdir('vr-rfiles-cache-') });
    const src = tmpdir('vr-rfiles-big-');
    const bytes = crypto.randomBytes(1024 * 1024);
    fs.writeFileSync(path.join(src, 'take.wav'), bytes);
    const ac = new AbortController();
    const hashes = hashCache(null);
    const first = await push(b, {
      area: 'Acme/Spring sale',
      sources: [path.join(src, 'take.wav')],
      into: 'Voice',
      by: 'agent:voice-edit',
      hashes,
      onProgress: (sent) => {
        if (sent >= 200 * 1024) ac.abort();
      },
      signal: ac.signal,
    });
    assert.equal(first.stopped, true);
    assert.ok(!own().some((f) => f.path === 'Voice/take.wav'), 'nothing committed');
    const sent: number[] = [];
    const again = await push(b, {
      area: 'Acme/Spring sale',
      sources: [path.join(src, 'take.wav')],
      into: 'Voice',
      by: 'agent:voice-edit',
      hashes,
      onProgress: (n) => sent.push(n),
    });
    assert.deepEqual(again.resumed, ['Voice/take.wav'], 'the upload it left went on');
    assert.deepEqual(
      again.done.map((d) => [d.path, d.state, d.v]),
      [['Voice/take.wav', 'added', 1]],
    );
    const f = own().find((x) => x.path === 'Voice/take.wav');
    assert.equal(f?.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  } finally {
    TUS.chunk = old;
  }
});
