// `lampo files` against the store on this machine (a throwaway one): push a folder of a project's material, see what
// applies where, pull it into another folder with the very line the app's Copy for an agent hands out, change it there
// and push it back as the next version, and never overwrite anyone: a file changed on either side is refused with who
// changed it and the two ways on (--copy, --replace), and a pull never writes over a file changed here (--force does).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { isolatedEnv, tmpdir, VR, vr } from '../lib/helpers.ts';

const { env } = isolatedEnv({ vars: { VR_REMOTE: '0', VR_BY: 'agent:spot-edit' } });
const folders = await import('../../lib/folders.ts');
const files = await import('../../lib/files.ts');
const { pullCommand, pushCommand } = await import('../../web/src/files/model.ts');
folders.createFolder('Acme/Spring sale');
folders.createFolder('House');

/** A project's material on this disk. */
function material(): string {
  const dir = tmpdir('vr-files-src-');
  const shoot = path.join(dir, 'Shoot');
  fs.mkdirSync(path.join(shoot, 'Day 1'), { recursive: true });
  fs.mkdirSync(path.join(shoot, 'Music'));
  fs.writeFileSync(path.join(shoot, 'Day 1', 'A001C003.mov'), 'clip one');
  fs.writeFileSync(path.join(shoot, 'Day 1', 'A001C004.mov'), 'clip two');
  fs.writeFileSync(path.join(shoot, 'Music', 'bed.wav'), 'music bed');
  fs.writeFileSync(path.join(shoot, '.env'), 'TOKEN=secret');
  fs.symlinkSync('/etc/hosts', path.join(shoot, 'hosts'));
  return dir;
}
const json = <T>(r: { out: string }): T => JSON.parse(r.out) as T;
const ownFiles = (folder: string) => files.listFiles(folder, { deep: true, own: true }).files;

test('push: a folder by its name (as the app’s drop), what is in it with a slash; hidden files and links stay here', () => {
  const src = material();
  const dry = vr(['files', 'push', path.join(src, 'Shoot'), '--to', 'Acme/Spring sale', '--path', 'Footage/', '--dry-run'], env);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /^would push 3 of 3 files to 'Acme\/Spring sale': 3 new, 0 new versions, 0 copies/);
  assert.equal(ownFiles('Acme/Spring sale').length, 0, 'a dry run sends nothing');
  const r = vr(['files', 'push', path.join(src, 'Shoot'), '--to', 'Acme/Spring sale', '--path', 'Footage/'], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^pushed 3 files to 'Acme\/Spring sale' \(r1\): 3 added, 0 new versions/m);
  assert.match(r.out, /^added {4}Footage\/Shoot\/Day 1\/A001C003\.mov V1$/m);
  assert.match(r.out, /^left out: 1 hidden \(Footage\/Shoot\/\.env: name one to send it\) · 1 link \(Footage\/Shoot\/hosts: never followed\)$/m);
  const listed = ownFiles('Acme/Spring sale');
  assert.deepEqual(listed.map((f) => f.path).sort(), ['Footage/Shoot/Day 1/A001C003.mov', 'Footage/Shoot/Day 1/A001C004.mov', 'Footage/Shoot/Music/bed.wav']);
  const f = listed[0] as (typeof listed)[number];
  assert.equal(f.agent, 'spot-edit', 'an agent’s version says so');
  assert.equal(f.via, 'vr');
  // the same again: nothing moves
  assert.match(
    vr(['files', 'push', path.join(src, 'Shoot'), '--to', 'Acme/Spring sale', '--path', 'Footage/'], env).out,
    /^nothing to push to 'Acme\/Spring sale': 3 files unchanged/,
  );
  // what is in it, into the House; a dotfile named on its own goes
  const house = vr(['files', 'push', `${path.join(src, 'Shoot', 'Music')}/`, path.join(src, 'Shoot', '.env'), '--to', 'House'], env);
  assert.equal(house.code, 0, house.err);
  assert.deepEqual(
    ownFiles('')
      .map((x) => x.path)
      .sort(),
    ['.env', 'bed.wav'],
  );
  // the line the check sheet shows for a big folder names the same place
  assert.equal(pushCommand('Acme/Spring sale', 'Footage', './Shoot'), "lampo files push ./Shoot --to 'Acme/Spring sale' --path Footage/");
});

test('ls: what applies in a project — its own, then the House’s (deepest wins) — and one folder’s files', () => {
  const r = vr(['files', 'ls', 'Acme/Spring sale'], env);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split('\n');
  assert.match(lines[0] as string, /^files for Acme\/Spring sale · Acme\/Spring sale r\d+ · House r\d+ \(deepest wins\)$/);
  assert.ok(lines.includes('Acme/Spring sale  Footage/  3 files  25 B  audio, footage'), r.out);
  assert.ok(lines.includes('House  bed.wav  9 B  audio'), r.out);
  assert.match(lines.at(-1) as string, /^pull: lampo files pull 'Acme\/Spring sale' --to <dir>/);
  const dir = vr(['files', 'ls', 'Acme/Spring sale', 'Footage/Shoot/Music'], env);
  assert.match(
    dir.out,
    /^Acme\/Spring sale Footage\/Shoot\/Music\/ · 1 file\nfl_[0-9a-f]{12} Footage\/Shoot\/Music\/bed\.wav 9 B audio V1 by agent:spot-edit \(tester\) · \S+\n$/,
  );
  // House is the workspace's own; a project called so is House/
  assert.match(vr(['files', 'ls', 'House'], env).out, /^files for House · House r\d+/);
  const proj = vr(['files', 'ls', 'House/'], env).out;
  assert.match(proj, /^files for House\/ · House\/ r0 · House r\d+ \(deepest wins\)\nHouse {2}\.env {2}/, 'the project called House inherits the House’s');
  assert.equal(json<{ folder: string }>(vr(['files', 'ls', 'House/', '--json'], env)).folder, 'House');
  assert.match(vr(['files', 'ls', 'Nowhere'], env).err, /there is no folder "Nowhere"/);
});

test('the line Copy for an agent hands out runs as it is: exactly those files, into public/', () => {
  const work = tmpdir('vr-files-pull-');
  // `lampo` on the PATH, as an agent's shell has it
  const bin = tmpdir('vr-files-bin-');
  fs.writeFileSync(path.join(bin, 'lampo'), `#!/bin/sh\nexec "${process.execPath}" "${VR}" "$@"\n`, { mode: 0o755 });
  const line = pullCommand('Acme/Spring sale', ['Footage/Shoot/Day 1/A001C003.mov'], ['Footage/Shoot/Music']);
  assert.equal(line, "lampo files pull 'Acme/Spring sale' --to public/ --only 'Footage/Shoot/Music/**' --only 'Footage/Shoot/Day 1/A001C003.mov'");
  const out = execFileSync('/bin/sh', ['-c', line], { cwd: work, env: { ...env, PATH: `${bin}:${env.PATH}` }, encoding: 'utf8' });
  assert.match(out, /^pulled 2 of 2 files from Acme\/Spring sale into public\/ · 17 B · 0 already here · \d+ s$/m);
  assert.equal(fs.readFileSync(path.join(work, 'public', 'Footage/Shoot/Day 1/A001C003.mov'), 'utf8'), 'clip one');
  assert.equal(fs.readFileSync(path.join(work, 'public', 'Footage/Shoot/Music/bed.wav'), 'utf8'), 'music bed');
  assert.ok(!fs.existsSync(path.join(work, 'public', 'Footage/Shoot/Day 1/A001C004.mov')), 'only what was picked');
  // the House's line, and an inherited file through the project's
  const house = pullCommand('', ['bed.wav']);
  assert.equal(house, 'lampo files pull House --to public/ --only bed.wav');
  execFileSync('/bin/sh', ['-c', house], { cwd: work, env: { ...env, PATH: `${bin}:${env.PATH}` } });
  assert.equal(fs.readFileSync(path.join(work, 'public', 'bed.wav'), 'utf8'), 'music bed');
  // a project called House is its own place in the line, never the House's
  assert.equal(pullCommand('House', ['x.wav']), 'lampo files pull House/ --to public/ --only x.wav');
});

test('round trip: pull, change here, status, push back as the next version; nobody overwritten', () => {
  const work = tmpdir('vr-files-trip-');
  const pull = vr(['files', 'pull', 'Acme/Spring sale', '--to', 'public'], env, { cwd: work });
  assert.equal(pull.code, 0, pull.err);
  assert.match(pull.out, /^pulled 4 of 4 files from Acme\/Spring sale into public/, 'its own and the House’s');
  assert.match(pull.out, /^left out: 1 hidden \(\.env\): name one exactly to pull it/m, 'a hidden file only when named');
  assert.match(vr(['files', 'pull', 'Acme/Spring sale', '--to', 'public'], env, { cwd: work }).out, /^pulled 0 of 4 files .* 4 already here/);
  const bed = path.join(work, 'public', 'Footage/Shoot/Music/bed.wav');
  fs.writeFileSync(bed, 'music bed, louder');
  fs.writeFileSync(path.join(work, 'public', 'Footage/new.txt'), 'new');
  // a pull never writes over a file changed here
  const kept = vr(['files', 'pull', 'Acme/Spring sale', '--to', 'public'], env, { cwd: work });
  assert.equal(kept.code, 1);
  assert.match(kept.out, /left out: Footage\/Shoot\/Music\/bed\.wav — changed here since it was pulled/);
  assert.equal(fs.readFileSync(bed, 'utf8'), 'music bed, louder');
  const st = vr(['files', 'status', '--to', 'public'], env, { cwd: work });
  assert.equal(st.code, 0, st.err);
  assert.match(st.out, /^public · pulled from 'Acme\/Spring sale' · /);
  assert.match(st.out, /^changed here {2}Footage\/Shoot\/Music\/bed\.wav$/m);
  assert.match(st.out, /^new here {6}Footage\/new\.txt$/m);
  assert.match(st.out, /^push: lampo files push public\/ --to 'Acme\/Spring sale'$/m);
  // pushed back: the changed file its next version (based on V1, as pulled), the new one added, the rest unchanged —
  // the House's file, pulled through the project, is not copied into it
  const back = vr(['files', 'push', 'public/', '--to', 'Acme/Spring sale'], env, { cwd: work });
  assert.equal(back.code, 0, back.err);
  assert.match(back.out, /^pushed 2 files to 'Acme\/Spring sale' \(r\d+\): 1 added, 1 new version · .* 3 unchanged$/m);
  assert.match(back.out, /^version {2}Footage\/Shoot\/Music\/bed\.wav V2$/m);
  assert.ok(!ownFiles('Acme/Spring sale').some((f) => f.path === 'bed.wav'), 'nothing of the House copied down');
  assert.match(vr(['files', 'status', '--to', 'public'], env, { cwd: work }).out, /^public · pulled from 'Acme\/Spring sale' · 5 unchanged$/m);

  // someone else makes V3 meanwhile (the app): the next push from here is refused before any byte moves
  const other = tmpdir('vr-files-other-');
  fs.writeFileSync(path.join(other, 'bed.wav'), 'their mix');
  const theirs = vr(['files', 'push', path.join(other, 'bed.wav'), '--to', 'Acme/Spring sale', '--path', 'Footage/Shoot/Music', '--replace'], {
    ...env,
    VR_BY: 'agent:mix-edit',
  });
  assert.match(theirs.out, /^version {2}Footage\/Shoot\/Music\/bed\.wav V3$/m, theirs.out + theirs.err);
  assert.match(
    vr(['files', 'status', '--to', 'public'], env, { cwd: work }).out,
    /^changed there Footage\/Shoot\/Music\/bed\.wav V2 → V3 by agent:mix-edit \(tester\)$/m,
  );
  fs.writeFileSync(bed, 'my mix');
  const refused = vr(['files', 'push', 'public/', '--to', 'Acme/Spring sale'], env, { cwd: work });
  assert.equal(refused.code, 1);
  assert.match(refused.out, /^refused: 1 file is in the way, nothing was sent$/m);
  assert.match(refused.out, /^conflict {2}Footage\/Shoot\/Music\/bed\.wav V3 by agent:mix-edit \(tester\) · \S+ \(yours is based on V2\)$/m);
  assert.match(refused.out, /^then: --replace makes yours its next version .* or --copy keeps both$/m);
  assert.equal(ownFiles('Acme/Spring sale').find((f) => f.path === 'Footage/Shoot/Music/bed.wav')?.v, 3);
  // keep both: mine beside theirs
  const copy = vr(['files', 'push', 'public/', '--to', 'Acme/Spring sale', '--copy'], env, { cwd: work });
  assert.equal(copy.code, 0, copy.err);
  assert.match(copy.out, /^copy {5}Footage\/Shoot\/Music\/bed \(spot-edit\)\.wav V1 \(Footage\/Shoot\/Music\/bed\.wav changed: kept beside it\)$/m);
  // a pull with --force takes theirs, over the change here
  const forced = vr(['files', 'pull', 'Acme/Spring sale', '--to', 'public', '--only', 'Footage/Shoot/Music/bed.wav', '--force'], env, { cwd: work });
  assert.equal(forced.code, 0, forced.err);
  assert.equal(fs.readFileSync(bed, 'utf8'), 'their mix');
  // older versions are kept: nothing was overwritten
  const id = ownFiles('Acme/Spring sale').find((f) => f.path === 'Footage/Shoot/Music/bed.wav')?.id as string;
  assert.deepEqual(
    files.historyOf(id).versions.map((v) => v.v),
    [3, 2, 1],
  );
});

test('usage: what is missing is said, with the command’s lines', () => {
  assert.match(vr(['files'], env).err, /say what to do:\nlampo files ls/);
  assert.match(vr(['files', 'pull', 'Acme/Spring sale'], env).err, /say where they go: --to <dir>/);
  assert.match(vr(['files', 'push', '.'], env).err, /say where it goes: --to/);
  assert.match(vr(['files', 'status', '--to', tmpdir('vr-files-none-')], env).err, /nothing was pulled into .* yet/);
  assert.match(vr(['files', '--help'], env).out, /lampo files pull <area> \[<glob>…\] \[--only <glob>\]… --to <dir>/);
});
