// `vr playbook` against the local store: read the merged playbook (House without an argument, a folder, a video),
// load one skill with its files, export everything as SKILL.md folders, suggest a change and follow it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { age, isolatedEnv, makeVideo, must, tmpdir, vr } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv();
const playbooks = await import('../../lib/playbooks.ts');
const video = makeVideo(path.join(dir, 'acme/export/reel.mp4'), { dur: 1 });
age(video);

test('setup: a filed video and the playbooks above it', async () => {
  assert.equal(vr(['track', video, '--folder', 'Acme/Reels'], env).code, 0);
  playbooks.writeText('', 'rules', '- Always end on the logo', { by: 'Sam' });
  playbooks.writeText('Acme', 'brief', 'A running-shoe brand; warm and honest.', { by: 'Sam' });
  playbooks.putSkill('Acme/Reels', { name: 'reels-export', description: 'Export an Acme reel', body: 'Use the preset.' }, { by: 'Sam' });
  const preset = path.join(dir, 'reels.epr');
  fs.writeFileSync(preset, '<preset/>');
  await playbooks.addSkillFile('Acme/Reels', 'reels-export', 'reels.epr', preset, 'Sam');
});

test('vr playbook: the House without an argument, a folder by name, a video by its name', () => {
  const house = vr(['playbook'], env);
  assert.equal(house.code, 0, house.err);
  assert.match(house.out, /^# Playbook: House/);
  assert.match(house.out, /revisions in force: House r1$/m);
  const folder = vr(['playbook', 'Acme'], env);
  assert.match(folder.out, /^# Playbook: Acme\n/, 'a folder of that exact name wins');
  const byVideo = vr(['playbook', 'reel.mp4'], env);
  assert.match(byVideo.out, /^# Playbook: Acme\/Reels/);
  assert.match(byVideo.out, /\*\*reels-export\*\* \(from Acme\/Reels\): Export an Acme reel — files: reels\.epr/);
  assert.match(byVideo.out, /revisions in force: House r1 · Acme r1 · Acme\/Reels r2/);
  assert.equal(JSON.parse(vr(['playbook', 'reel.mp4', '--json'], env).out).label, 'Acme/Reels');
});

test('vr playbook skill: its SKILL.md; --files downloads the files into this folder', () => {
  const work = tmpdir('vr-skill-');
  const r = vr(['playbook', 'skill', 'reels-export', 'reel.mp4', '--files'], env, { cwd: work });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^---\nname: reels-export\ndescription: Export an Acme reel\n---\n\nUse the preset\./);
  assert.equal(fs.readFileSync(path.join(work, 'reels.epr'), 'utf8'), '<preset/>');
});

test('vr playbook export: PLAYBOOK.md and every skill as <dir>/<name>/SKILL.md with its files', () => {
  const to = path.join(tmpdir('vr-export-'), 'skills');
  const r = vr(['playbook', 'export', 'reel.mp4', '--to', to], env);
  assert.equal(r.code, 0, r.err);
  assert.match(fs.readFileSync(path.join(to, 'PLAYBOOK.md'), 'utf8'), /^# Playbook: Acme\/Reels/);
  assert.match(fs.readFileSync(path.join(to, 'reels-export', 'SKILL.md'), 'utf8'), /^---\nname: reels-export\n/);
  assert.equal(fs.readFileSync(path.join(to, 'reels-export', 'reels.epr'), 'utf8'), '<preset/>');
});

test('vr playbook propose, then status: pending, then what the person decided', () => {
  const r = vr(['playbook', 'propose', 'Acme', '--section', 'rules', '--text', '- Grain at 3 %', '--reason', 'Every approved render had grain'], env);
  assert.equal(r.code, 0, r.err);
  const id = must(/: (pp_[0-9a-f]{12}) \(pending/.exec(r.out)?.[1], r.out);
  assert.match(vr(['playbook', 'status', id], env).out, /rules of Acme · pending/);
  playbooks.rejectProposal(id, { by: 'Sam', reason: 'Grain is per film' });
  const s = vr(['playbook', 'status', id], env);
  assert.match(s.out, /rejected by Sam/);
  assert.match(s.out, /why: Grain is per film/);
  assert.equal(vr(['playbook', 'propose', 'Acme', '--section', 'rules', '--text', 'x'], env).code, 1, 'no reason, no suggestion');
});
