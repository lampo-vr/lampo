// What `lampo files pull` writes onto an agent's disk is named by a server that may not be honest, and what a push
// reads is only what it was named (lib/filesLocal.ts, lib/fileGlob.ts). Every hostile path is refused before anything
// is written: `..`, absolute, a backslash, a drive letter or a share, a NUL, a control character, the record's own
// folder, and on Windows its device names, its characters and names ending in a dot or a space. Nothing is ever written
// into or through a symbolic link, nor onto a folder. A push takes a folder's plain files only: its hidden names, links,
// pipes and junk stay where they are, said by name; a name given on the command line (a dotfile too) goes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { globMatcher, isExactPattern } from '../../lib/fileGlob.ts';
import {
  contentsOf,
  gatherPush,
  LandingError,
  landingFor,
  landingProblem,
  landingRoot,
  openPart,
  placeFile,
  readRecord,
  writeRecord,
} from '../../lib/filesLocal.ts';
import { tmpdir } from '../lib/helpers.ts';

test('a path a server names: only a path Lampo keeps, inside the folder', () => {
  for (const ok of ['Music/bed.wav', 'Footage/Day 1/A001C003.mov', 'logo.svg', 'Fonts/Brand Sans.otf', 'aux.wav', 'C/x.mov'])
    assert.equal(landingProblem(ok, { win: false }), null, ok);
  const evil: Record<string, RegExp> = {
    '../escape.txt': /\.\./,
    'Music/../../escape.txt': /\.\./,
    '..': /\.\./,
    './x': /"\."/,
    '/etc/passwd': /starts with a name/,
    'C:/Windows/x.dll': /drive/,
    'c:x': /drive/,
    '\\\\server\\share\\x': /drive or a share/,
    'Music\\..\\x': /separated by/,
    'a\0b': /NUL/,
    'a\nb.txt': /control|line breaks/,
    'a\u202eb.txt': /direction/,
    '': /no path/,
    'a//b': /empty names/,
    'Music/': /empty names/,
    '.lampo/files.json': /left out|\.lampo/,
    '.lampo': /record of pulls/,
    '.git/config': /left out/,
  };
  for (const [p, why] of Object.entries(evil)) assert.match(String(landingProblem(p, { win: false })), why, JSON.stringify(p));
  assert.match(String(landingProblem(42)), /no path/);
  // a path the server should have kept in NFC: not one of Lampo's
  assert.match(String(landingProblem('Cafe\u0301/x.wav', { win: false })), /not a path as Lampo keeps/);
});

test('on Windows: its device names, its characters and names Windows would cut are refused too', () => {
  for (const p of ['CON', 'con.txt', 'Footage/NUL', 'aux.wav', 'COM1.log', 'lpt9', 'COM¹', 'conin$', 'a/b:c.mov', 'x?.wav', 'x<y', 'name.', 'Music/end ./x'])
    assert.ok(landingProblem(p, { win: true }), `${p} on Windows`);
  for (const p of ['console.txt', 'Footage/A001.mov', 'auxiliary.wav', 'com10.log']) assert.equal(landingProblem(p, { win: true }), null, p);
});

test('landing: folders made one by one, never through a link, never onto a folder; written from a part, moved in place', () => {
  const dir = tmpdir('vr-landing-');
  const outside = tmpdir('vr-outside-');
  const root = landingRoot(path.join(dir, 'public'));
  const target = landingFor(root, 'Music/Day 1/bed.wav');
  assert.equal(target, path.join(root, 'Music', 'Day 1', 'bed.wav'));
  assert.ok(fs.statSync(path.join(root, 'Music', 'Day 1')).isDirectory());
  // a link where a folder is: never followed, whether it points out or in
  fs.symlinkSync(outside, path.join(root, 'Fonts'));
  assert.throws(
    () => landingFor(root, 'Fonts/Brand.otf'),
    (e: Error) => e instanceof LandingError && /symbolic link/.test(e.message),
  );
  fs.symlinkSync(path.join(root, 'Music'), path.join(root, 'Inside'));
  assert.throws(() => landingFor(root, 'Inside/x.wav'), /symbolic link/);
  // a link where the file lands: not written through (it would change what it points at)
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'keep');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'notes.txt'));
  assert.throws(() => landingFor(root, 'notes.txt'), /symbolic link/);
  // a dangling link too: writing would make the file it names
  fs.symlinkSync(path.join(outside, 'made.txt'), path.join(root, 'made.txt'));
  assert.throws(() => landingFor(root, 'made.txt'), /symbolic link/);
  // a folder where the file lands, a file where a folder must be
  fs.mkdirSync(path.join(root, 'Clips'));
  assert.throws(() => landingFor(root, 'Clips'), /folder/);
  fs.writeFileSync(path.join(root, 'Notes'), 'a file');
  assert.throws(() => landingFor(root, 'Notes/x.txt'), /is a file here/);
  // the bytes go to a new part beside it (never through a link there), then in place
  const part = path.join(path.dirname(target), '.lampo-0123456789abcdef.part');
  fs.symlinkSync(path.join(outside, 'part-target'), part);
  assert.throws(() => openPart(part), /something else than a file/);
  fs.rmSync(part);
  const { fd } = openPart(part);
  fs.writeSync(fd, 'bytes');
  fs.closeSync(fd);
  // a part a pull left is gone on with; one that is a link never
  const again = openPart(part, { resume: true });
  assert.equal(again.have, 5);
  fs.closeSync(again.fd);
  placeFile(root, part, target);
  assert.equal(fs.readFileSync(target, 'utf8'), 'bytes');
  assert.deepEqual(fs.readdirSync(outside).sort(), ['secret.txt'], 'nothing landed outside');
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'keep');
});

test('the record of pulls: never read or written through a link, another store’s never taken', () => {
  const root = tmpdir('vr-record-');
  const outside = tmpdir('vr-record-out-');
  const rec = {
    v: 1 as const,
    store: 'server: https://a.example',
    files: { 'x.wav': { area: '', from: '', id: 'fl_000000000001', v: 1, sha256: 'a'.repeat(64), size: 1, mtime: 1, at: 'now' } },
  };
  assert.equal(writeRecord(root, rec), true);
  assert.deepEqual(readRecord(root, 'server: https://a.example').files, rec.files);
  assert.deepEqual(readRecord(root, 'data: /other').files, {}, 'another store’s record is none of this one’s');
  const linked = tmpdir('vr-record-link-');
  fs.symlinkSync(outside, path.join(linked, '.lampo'));
  assert.equal(writeRecord(linked, rec), false, 'a .lampo that is a link is left alone');
  assert.deepEqual(fs.readdirSync(outside), []);
  // a record naming a path that can't land is read without it
  fs.writeFileSync(path.join(root, '.lampo', 'files.json'), JSON.stringify({ ...rec, files: { ...rec.files, '../x': rec.files['x.wav'] } }));
  assert.deepEqual(Object.keys(readRecord(root, 'server: https://a.example').files), ['x.wav']);
});

test('globs: * and ? inside a name, ** across names, a plain path is the file or the folder with everything in it', () => {
  const m = globMatcher(['Music/**', 'Footage/Day 1/A001C003.mov', '*.otf', 'Brand', 'Shots/??.png', 'Project/**/*.aep']);
  assert.equal(m.match('Music/bed.wav'), 0);
  assert.equal(m.match('Music/Takes/v2.wav'), 0);
  assert.equal(m.match('music/BED.wav'), 0, 'a path that differs only in case is the same place');
  assert.equal(m.match('Footage/Day 1/A001C003.mov'), 1);
  assert.equal(m.match('Footage/Day 1/A001C004.mov'), -1);
  assert.equal(m.match('Inter.otf'), 2);
  assert.equal(m.match('Fonts/Inter.otf'), -1, '* stays inside a name');
  assert.equal(m.match('Brand/logo.svg'), 3, 'a plain folder name takes what is in it');
  assert.equal(m.match('Brandbook.pdf'), -1);
  assert.equal(m.match('Shots/01.png'), 4);
  assert.equal(m.match('Shots/001.png'), -1);
  assert.equal(m.match('Project/spot.aep'), 5, '** may be no names');
  assert.equal(m.match('Project/a/b/spot.aep'), 5);
  assert.equal(globMatcher(['./Music/']).match('Music/x.wav'), 0, './ and a slash at the end say nothing more');
  assert.equal(globMatcher(['a.b']).match('aXb'), -1, 'a dot is a dot');
  assert.equal(globMatcher(['(x)[1]+']).match('(x)[1]+'), 0, 'other characters are themselves');
  assert.ok(isExactPattern('Footage/Day 1') && !isExactPattern('Footage/*'));
});

test('a push reads only what it was named: a folder’s plain files, never its links, hidden names, pipes or junk', () => {
  const dir = tmpdir('vr-gather-');
  const shoot = path.join(dir, 'Shoot');
  fs.mkdirSync(path.join(shoot, 'Day 1'), { recursive: true });
  fs.writeFileSync(path.join(shoot, 'Day 1', 'A001.mov'), 'clip');
  fs.writeFileSync(path.join(shoot, '.env'), 'SECRET=1');
  fs.mkdirSync(path.join(shoot, '.git'));
  fs.writeFileSync(path.join(shoot, '.git', 'config'), 'x');
  fs.mkdirSync(path.join(shoot, '.cache'));
  fs.writeFileSync(path.join(shoot, '.cache', 'y'), 'y');
  fs.mkdirSync(path.join(shoot, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(shoot, 'node_modules', 'x', 'index.js'), 'x');
  fs.writeFileSync(path.join(shoot, '.DS_Store'), 'x');
  fs.writeFileSync(path.join(shoot, '._A001.mov'), 'x');
  const outside = tmpdir('vr-gather-out-');
  fs.writeFileSync(path.join(outside, 'id_rsa'), 'key');
  fs.symlinkSync(path.join(outside, 'id_rsa'), path.join(shoot, 'key-link'));
  fs.symlinkSync(outside, path.join(shoot, 'outside-dir'));
  execFileSync('mkfifo', [path.join(shoot, 'pipe')]);

  const named = gatherPush([shoot], { into: 'Footage' });
  assert.deepEqual(
    named.files.map((f) => f.path),
    ['Footage/Shoot/Day 1/A001.mov'],
    'a folder by its name, under --path',
  );
  assert.deepEqual(named.left.links.sort(), ['Footage/Shoot/key-link', 'Footage/Shoot/outside-dir']);
  assert.deepEqual(named.left.hidden.sort(), ['Footage/Shoot/.cache/', 'Footage/Shoot/.env']);
  assert.deepEqual(named.left.special, ['Footage/Shoot/pipe'], 'a pipe is never read (it would wait for ever)');
  assert.deepEqual(named.left.junk.sort(), ['Footage/Shoot/.DS_Store', 'Footage/Shoot/._A001.mov', 'Footage/Shoot/.git/', 'Footage/Shoot/node_modules/']);

  // a slash at its end: what is in it
  assert.ok(contentsOf(`${shoot}/`) && contentsOf('.') && contentsOf('./') && !contentsOf(shoot));
  assert.deepEqual(
    gatherPush([`${shoot}/`]).files.map((f) => f.path),
    ['Day 1/A001.mov'],
  );
  // a hidden file named on its own goes; the folder that is a link, named, is followed (the person named it)
  assert.deepEqual(
    gatherPush([path.join(shoot, '.env')]).files.map((f) => f.path),
    ['.env'],
  );
  assert.deepEqual(
    gatherPush([path.join(shoot, 'outside-dir')]).files.map((f) => f.path),
    ['outside-dir/id_rsa'],
  );
  assert.throws(() => gatherPush([path.join(dir, 'nothing')]), /no such file or folder/);
  // names Lampo can't keep are said with why
  const bad = tmpdir('vr-gather-bad-');
  fs.writeFileSync(path.join(bad, 'line\nbreak.txt'), 'x');
  fs.writeFileSync(path.join(bad, ' lead.txt'), 'x');
  const g = gatherPush([`${bad}/`]);
  assert.deepEqual(g.files, []);
  assert.equal(g.left.bad.length, 2);
});
