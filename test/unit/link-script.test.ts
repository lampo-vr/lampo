// `npm run link` is the quick start's second step (README, docs/agents.md). Run here the way npm runs it — the script
// line through sh, from the checkout — with HOME a fresh folder, like a stock Mac without ~/.local/bin (A12 OSS-10).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT } from '../lib/helpers.ts';

const script = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.link as string;
const run = (home: string, PATH: string) =>
  execFileSync('sh', ['-c', script], { cwd: ROOT, env: { HOME: home, PATH, PWD: ROOT }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const NODE_PATH = path.dirname(process.execPath);

test('npm run link puts lampo (and vr, its older name) in ~/.local/bin on a machine without the folder, and says when the shell won’t look there', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-link-'));
  try {
    const out = run(home, `${NODE_PATH}:/usr/bin:/bin`);
    const link = path.join(home, '.local/bin/lampo');
    assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(ROOT, 'bin/lampo')), 'a link to this checkout’s lampo');
    const old = path.join(home, '.local/bin/vr');
    assert.equal(fs.realpathSync(old), fs.realpathSync(path.join(ROOT, 'bin/vr')), 'what setups made before call');
    assert.match(out, /linked lampo → .*\.local\/bin\/lampo/);
    assert.match(out, /not on your PATH[\s\S]*export PATH="\$HOME\/\.local\/bin:\$PATH"/, 'how to make the shell find it');
    // Again, with the folder on the PATH: the links are replaced in place, and nothing more to do.
    const again = run(home, `${path.join(home, '.local/bin')}:${NODE_PATH}:/usr/bin:/bin`);
    assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(ROOT, 'bin/lampo')));
    assert.equal(fs.realpathSync(old), fs.realpathSync(path.join(ROOT, 'bin/vr')));
    assert.doesNotMatch(again, /not on your PATH/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

const runAll = (home: string) =>
  spawnSync('sh', ['-c', script], { cwd: ROOT, env: { HOME: home, PATH: `${NODE_PATH}:/usr/bin:/bin`, PWD: ROOT }, encoding: 'utf8' });

test('another program’s lampo or vr in ~/.local/bin is never replaced: the person is told, a folder of that name too', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-link-'));
  const bin = path.join(home, '.local/bin');
  try {
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'vr'), '#!/bin/sh\necho "their own vr"\n', { mode: 0o755 });
    // their vr stays, byte for byte; lampo is linked
    let r = runAll(home);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(bin, 'vr'), 'utf8'), '#!/bin/sh\necho "their own vr"\n');
    assert.equal(fs.lstatSync(path.join(bin, 'vr')).isSymbolicLink(), false);
    assert.equal(fs.realpathSync(path.join(bin, 'lampo')), fs.realpathSync(path.join(ROOT, 'bin/lampo')));
    assert.match(r.stdout, /vr is another program’s: left as it is/);
    // their lampo: refused with the path, nothing replaced
    fs.rmSync(path.join(bin, 'lampo'));
    fs.writeFileSync(path.join(bin, 'lampo'), 'their lampo', { mode: 0o755 });
    r = runAll(home);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /\.local\/bin\/lampo is there already and isn’t Lampo’s/);
    assert.equal(fs.readFileSync(path.join(bin, 'lampo'), 'utf8'), 'their lampo');
    // a folder of that name: said, no stack trace
    fs.rmSync(path.join(bin, 'lampo'));
    fs.mkdirSync(path.join(bin, 'lampo'));
    r = runAll(home);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stderr, /at .*link\.mjs|EISDIR/, 'no stack trace');
    assert.ok(fs.statSync(path.join(bin, 'lampo')).isDirectory());
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/** A folder shaped like a Lampo checkout (before the rename: named video-review, bin/vr only). */
function checkoutAt(folder: string, name = 'video-review') {
  for (const f of ['bin/vr', 'lib/store.ts', 'lib/cli.ts', 'server/index.ts']) {
    fs.mkdirSync(path.dirname(path.join(folder, f)), { recursive: true });
    fs.writeFileSync(path.join(folder, f), '');
  }
  fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name }));
}

test('someone’s own link stays: one to a script that is gone, one into another project called video-review', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-link-'));
  const bin = path.join(home, '.local/bin');
  try {
    fs.mkdirSync(bin, { recursive: true });
    // their vr: a link to a script of theirs that is gone
    const gone = path.join(home, 'tools/vr-helper.sh');
    fs.symlinkSync(gone, path.join(bin, 'vr'));
    // their lampo: a link into a project of theirs that happens to be named video-review (not a Lampo checkout)
    const other = path.join(home, 'their-project');
    fs.mkdirSync(path.join(other, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'video-review' }));
    fs.writeFileSync(path.join(other, 'bin/lampo'), '#!/bin/sh\n', { mode: 0o755 });
    fs.symlinkSync(path.join(other, 'bin/lampo'), path.join(bin, 'lampo'));
    const r = runAll(home);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /\.local\/bin\/lampo is there already and isn’t Lampo’s/);
    assert.equal(fs.readlinkSync(path.join(bin, 'lampo')), path.join(other, 'bin/lampo'), 'their link to their project stays');
    assert.equal(fs.readlinkSync(path.join(bin, 'vr')), gone, 'their link to nothing stays');
    assert.match(r.stdout, /vr is another program’s: left as it is/);
    // a link to nothing inside a folder that is still there but isn't a checkout: theirs too
    fs.rmSync(path.join(bin, 'lampo'));
    fs.rmSync(path.join(other, 'bin/lampo'));
    fs.symlinkSync(path.join(other, 'bin/lampo'), path.join(bin, 'lampo'));
    assert.equal(runAll(home).status, 1);
    assert.equal(fs.readlinkSync(path.join(bin, 'lampo')), path.join(other, 'bin/lampo'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a link from another Lampo checkout, or one to nothing, is replaced', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-link-'));
  const bin = path.join(home, '.local/bin');
  try {
    // an older checkout (before the rename) the links pointed into
    const old = path.join(home, 'old-checkout');
    checkoutAt(old);
    fs.mkdirSync(bin, { recursive: true });
    fs.symlinkSync(path.join(old, 'bin/vr'), path.join(bin, 'vr'));
    fs.symlinkSync(path.join(home, 'moved-away/bin/lampo'), path.join(bin, 'lampo'));
    const r = runAll(home);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.realpathSync(path.join(bin, 'lampo')), fs.realpathSync(path.join(ROOT, 'bin/lampo')));
    assert.equal(fs.realpathSync(path.join(bin, 'vr')), fs.realpathSync(path.join(ROOT, 'bin/vr')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
