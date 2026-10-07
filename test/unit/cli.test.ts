// bin/vr as agents use it: plain text by default, --json on read commands.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { age, isolatedEnv, makeVideo, must, sleep, vr, vrAsync } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv();
const video = makeVideo(path.join(dir, 'proj/export/cli.mp4'), { dur: 1 });
age(video);
let id = '';

test('vr help and unknown commands', () => {
  const help = vr(['help'], env).out;
  assert.match(help, /frame-exact video feedback for agents/);
  // Every command and option that exists, in the app's words; agents read it, so it stays compact.
  for (const s of ['vr verify <id>', 'vr reopen <id>', '--limit N', '--t 12.1', '--token-env NAME', '--url <server>', '"Copy for an agent"', 'Lampo server'])
    assert.ok(help.includes(s), `help names ${s}`);
  assert.doesNotMatch(help, /Claude Code sessions|video-review server|Copy for Claude/);
  // 7200 until `vr ask` (options before a render) took its two lines, 7450 until `vr post` (publishing) took two more,
  // 7700 until `vr export` / `vr admin import` (moving to a server) took one, 7820 until `vr footage` took two, 8050
  // until elements maps took two (`vr push … --elements`, `vr elements`) and `vr admin`'s deletion and export (A13
  // PEOPLE-1) one, 8360 until `vr render` and `vr render wait` took three
  // measured with the data folder's path as a placeholder: the temp folder's length differs by machine
  const sized = help.replace(/\(data: [^)\n]*\)/, '(data: <data>)').length;
  assert.ok(sized < 8660, `help is ${sized} characters`);
  assert.ok(help.includes('vr footage find "<request>"'), 'help names vr footage');
  assert.ok(help.includes('vr post draft <video> --platform yt|ig|fb'), 'help names vr post');
  const bad = vr(['frobnicate'], env);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /unknown command/);
  assert.equal(vr(['toString'], env).code, 2, 'Object.prototype names are not commands');
});

test('vr track files and assigns a new video', () => {
  const r = vr(['track', video, '--session', 'test-session', '--folder', 'Proj/Cuts'], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /added: .*cli\.mp4 \(v1\)/);
  assert.match(r.out, /session: test-session · folder: Proj\/Cuts/);
});

test('vr add pins a note with drawing and writes both PNGs', () => {
  const r = vr(
    ['add', 'cli.mp4', '--at', '00:00:12', '--text', 'Logo zu früh', '--tags', 'timing,graphic', '--severity', 'must', '--box', '10,10,50,30', '--by', 'alex'],
    env,
  );
  assert.equal(r.code, 0, r.err);
  id = must(/(c_[0-9a-f]{6}) pinned at 00:00:12 \(f12, v1\) by alex/.exec(r.out)?.[1], r.out);
  const marked = must(/marked: (.+\.png)/.exec(r.out), 'marked path')[1];
  assert.ok(fs.existsSync(marked));
  assert.equal(vr(['add', 'cli.mp4', '--frame', '999', '--text', 'x'], env).code, 1, 'frame outside the video');
  assert.equal(vr(['add', 'cli.mp4', '--frame', '3'], env).code, 1, '--text is required');
});

test('vr ls / open / show / prompt', () => {
  const ls = vr(['ls'], env).out;
  assert.match(ls, /1 open\s+1 must/);
  assert.match(ls, /\[Proj\/Cuts\]/);
  const json = JSON.parse(vr(['ls', '--json'], env).out);
  assert.equal(json[0].folder, 'Proj/Cuts');
  assert.equal(json[0].counts.open, 1);
  const open = vr(['open', 'cli.mp4'], env).out;
  assert.match(open, new RegExp(`${id}\\s+OPEN\\s+MUST\\s+00:00:12\\s+f12`));
  assert.match(open, /drawing: box x10 y10 w50 h30/);
  assert.match(open, new RegExp(`marked: /.*/${id}_marked\\.png`));
  // --brief: the same notes, the screenshots' folder once in the header instead of on every note.
  const brief = vr(['open', 'cli.mp4', '--brief'], env).out;
  assert.match(brief, new RegExp(`${id}\\s+OPEN\\s+MUST\\s+00:00:12\\s+f12`));
  assert.match(brief, /drawing: box x10 y10 w50 h30/);
  assert.match(brief, /\n {2}shots: \/.+\/<id>_marked\.png · <id>_clean\.png · <id>_range\.jpg/);
  assert.doesNotMatch(brief, /marked: |clean: /);
  assert.ok(brief.length < open.length);
  const oj = JSON.parse(vr(['open', 'cli.mp4', '--json'], env).out);
  assert.ok(path.isAbsolute(oj.comments[0].shots.marked), 'absolute screenshot paths in JSON');
  assert.match(vr(['show', id], env).out, /Logo zu früh/);
  assert.match(vr(['prompt', 'cli.mp4'], env).out, /Open \(1, 1 must\)/);
});

test('vr fix / reply / wontfix and the inbox', () => {
  assert.match(vr(['fix', id, '--note', 'Logo 4 Frames später', '--by', 'agent:test'], env).out, new RegExp(`${id}: fixed in v1`));
  assert.match(vr(['reply', id, '--note', 'siehe v1', '--by', 'agent:test'], env).out, /reply added/);
  assert.equal(vr(['wontfix', id], env).code, 1, 'wontfix needs a reason');
  assert.match(vr(['inbox'], env).out, /NEW MUST \[timing,graphic\]/);
  assert.equal(vr(['ls', '--open'], env).out.trim(), 'no videos under review.');
});

test('vr move / folders / ls --folder', () => {
  assert.match(vr(['move', 'cli.mp4', 'Proj/Final'], env).out, /→ Proj\/Final/);
  const tree = vr(['folders'], env).out;
  assert.match(tree, /^Proj\s+\(1 video, 0 open\)/m);
  assert.match(tree, /^\s+Final\s+\(1 video/m);
  assert.match(vr(['ls', '--folder', 'Proj'], env).out, /cli\.mp4/);
  assert.match(vr(['move', 'cli.mp4', '--none'], env).out, /→ Unsorted/);
  assert.equal(vr(['move', 'cli.mp4'], env).code, 1);
});

test('vr sync reports an unchanged file', () => {
  assert.match(vr(['sync', 'cli.mp4'], env).out, /unchanged, v1/);
});

test('vr watch prints one line per new human note', async () => {
  const w = vrAsync(['watch', '--everyone'], env);
  let out = '';
  w.stdout.on('data', (d) => {
    out += d;
  });
  await sleep(1200);
  vr(['add', 'cli.mp4', '--frame', '20', '--text', 'watch me', '--by', 'alex'], env);
  vr(['add', 'cli.mp4', '--frame', '21', '--text', 'agent noise', '--by', 'agent:test'], env);
  for (let i = 0; i < 40 && !out.includes('watch me'); i++) await sleep(100);
  w.kill();
  const lines = out.trim().split('\n');
  assert.equal(lines.length, 1, out);
  assert.match(lines[0], /NEW SHOULD \[-\] c_[0-9a-f]{6} 00:00:20 f20 v1 cli\.mp4 →test-session — "watch me" · marked: \/.+_marked\.png · video: \//);
});

test('note kinds: an agent asks by default, info reports, ideas stay optional, and the prompt keeps them apart', async () => {
  const q = vr(['add', 'cli.mp4', '--frame', '5', '--text', 'Soll der Titel so lange stehen?', '--by', 'agent:test'], env);
  assert.match(q.out, /pinned at \S+ \(f5, v1\) by agent:test · question/);
  const qid = must(/(c_[0-9a-f]{6}) pinned/.exec(q.out)?.[1], q.out);
  assert.match(vr(['add', 'cli.mp4', '--frame', '6', '--text', 'Farbkorrektur angepasst', '--kind', 'info', '--by', 'agent:test'], env).out, / · info/);
  assert.equal(vr(['add', 'cli.mp4', '--frame', '7', '--text', 'Was wäre, wenn der Titel reinfliegt?', '--severity', 'idea', '--by', 'alex'], env).code, 0);
  assert.equal(vr(['add', 'cli.mp4', '--frame', '8', '--text', 'x', '--kind', 'riddle'], env).code, 1, 'unknown kind');

  const counts = JSON.parse(vr(['ls', '--json'], env).out)[0].counts;
  assert.ok(counts.ideas >= 1 && counts.questions >= 1, JSON.stringify(counts));
  const open = vr(['open', 'cli.mp4'], env).out;
  assert.ok(open.indexOf(' IDEA ') > open.indexOf(' SHOULD '), 'ideas after feedback');
  assert.ok(open.indexOf(' QUESTION ') > open.indexOf(' IDEA ') && open.indexOf(' INFO ') > open.indexOf(' QUESTION '), open);

  const prompt = vr(['prompt', 'cli.mp4'], env).out;
  const ideas = prompt.indexOf('Ideas (optional — your call)');
  const questions = prompt.indexOf('Questions to the reviewer, not answered yet');
  assert.ok(ideas > prompt.indexOf('Open (') && questions > ideas, prompt);
  assert.match(prompt.slice(ideas, questions), /IDEA · – · 00:00:07/);
  assert.match(prompt.slice(questions), /QUESTION · – · 00:00:05 f5 · asked by agent:test/);
  assert.ok(!prompt.includes('Farbkorrektur angepasst'), "info notes aren't work for anyone");

  // The reviewer answers: agents following `vr watch --all` see ANSWERED with the answer and the question.
  const w = vrAsync(['watch', '--everyone', '--all'], env);
  let out = '';
  w.stdout.on('data', (d) => {
    out += d;
  });
  await sleep(1200);
  vr(['verify', qid, '--note', 'Ja, drei Sekunden passen.', '--by', 'alex'], env);
  for (let i = 0; i < 40 && !out.includes('ANSWERED'); i++) await sleep(100);
  w.kill();
  assert.match(out, new RegExp(`ANSWERED ${qid} 00:00:05 cli\\.mp4 .*by alex — "Ja, drei Sekunden passen\\." · on: "Soll der Titel so lange stehen\\?"`));
});

test('vr add --to: a range note, echoed with both ends and a strip of frames; past the end is refused', () => {
  const clip = makeVideo(path.join(dir, 'proj/export/stretch.mp4'), { dur: 2 });
  age(clip);
  assert.equal(vr(['track', clip], env).code, 0);
  const r = vr(['add', 'stretch.mp4', '--at', '00:00:12', '--to', '00:01:20', '--text', 'Musik zu laut', '--by', 'alex'], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /pinned at 00:00:12 \(f12, v1\), range 00:00:12 → 00:01:20 \(f12–f50, 1\.3 s\) by alex/);
  const rid = must(/(c_[0-9a-f]{6})/.exec(r.out)?.[1], r.out);
  const show = vr(['show', rid], env).out;
  assert.match(show, /range 12-50/, 'the old token stays for agents that parse it');
  assert.match(show, /range: 00:00:12 → 00:01:20 \(f12–f50, 1\.3 s\)/);
  assert.ok(fs.existsSync(must(/range frames \(first … last\): (.+_range\.jpg)/.exec(show), 'strip path')[1]));
  const past = vr(['add', 'stretch.mp4', '--at', '00:00:12', '--to', '00:03:00', '--text', 'x'], env);
  assert.equal(past.code, 1);
  assert.match(past.err, /ends after the last frame/);
});

test('vr add --choice: a question offers its likely answers, shown with the note; one alone or a note that asks nothing is refused', () => {
  const r = vr(['add', 'cli.mp4', '--frame', '6', '--text', 'Name richtig?', '--choice', 'Ja', '--choice', 'Nein, es ist …', '--by', 'agent:cli-test'], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /· question/);
  assert.match(r.out, /choices: Ja \| Nein, es ist …/);
  const qid = must(/(c_[0-9a-f]{6})/.exec(r.out)?.[1], r.out);
  assert.match(vr(['show', qid], env).out, /choices offered: Ja \| Nein, es ist …/);
  const one = vr(['add', 'cli.mp4', '--frame', '6', '--text', 'x', '--choice', 'Ja', '--by', 'agent:cli-test'], env);
  assert.equal(one.code, 1);
  assert.match(one.err, /--choice: give 2–4 different answers/);
  const feedback = vr(['add', 'cli.mp4', '--frame', '6', '--text', 'x', '--choice', 'a', '--choice', 'b', '--by', 'alex'], env);
  assert.equal(feedback.code, 1, 'a person’s feedback has nothing to choose from');
  assert.match(feedback.err, /--choice goes with a question/);
});
