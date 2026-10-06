// `vr ask` on this machine: a JSON file of groups whose paths are read from where the file is, on a video or on a
// project before any render; `vr show` of a folder's question; `vr open` listing a question's picks until a render
// arrives after them; INBOX.md naming the folder.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { age, FFMPEG, isolatedEnv, makeVideo, must, vr } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv({ vars: { VR_REMOTE: '0', VR_BY: 'agent:sound' } });
const store = await import('../../lib/store.ts');
const asks = await import('../../lib/asks.ts');
const { slugify } = await import('../../lib/paths.ts');

const video = makeVideo(path.join(dir, 'proj/export/launch.mp4'), { w: 160, h: 90, dur: 1 });
age(video);
const takes = path.join(dir, 'takes');
fs.mkdirSync(takes, { recursive: true });
for (const [name, a] of [
  ['calm', 0.4],
  ['warm', 0.1],
] as const)
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `aevalsrc=${a}*sin(2*PI*440*t):s=48000:d=1`, '-y', path.join(takes, `${name}.wav`)]);
const file = path.join(takes, 'options.json');
fs.writeFileSync(
  file,
  JSON.stringify({
    groups: [
      {
        id: 'voice',
        label: 'Narrator',
        items: [
          { id: 'v1', label: 'Calm', path: 'calm.wav' },
          { id: 'v2', label: 'Warm', path: 'warm.wav' },
        ],
      },
      {
        id: 'close',
        label: 'Closing line',
        items: [
          { id: 'c1', label: 'See you' },
          { id: 'c2', label: 'lampo.app' },
        ],
      },
    ],
    prompt: 'Anything else?',
  }),
);

test('vr ask on a video, the paths read from where the file is; vr open keeps the picks until the next render', () => {
  assert.equal(vr(['track', video], env).code, 0);
  // From another folder: the paths in the file are the file's.
  const asked = vr(['ask', 'launch.mp4', '--text', 'Which narrator?', '--options', file], env, { cwd: dir });
  assert.equal(asked.code, 0, asked.err);
  const id = must(/^(c_[0-9a-f]{6}) asked on launch\.mp4: voice \(one of 2\), close \(one of 2\)$/m.exec(asked.out)?.[1], asked.out);
  const note = must(store.findComment(id)).comment;
  assert.equal(note.author, 'agent:sound');
  assert.equal(note.answer_prompt, 'Anything else?');
  assert.ok(note.options?.[0].items.every((it) => it.ref?.kind === 'audio' && it.ref.loudness));
  const open = vr(['open', 'launch.mp4'], env).out;
  assert.match(open, /options voice "Narrator" \(pick one\): v1 Calm \(audio 1\.0 s\) · v2 Warm \(audio 1\.0 s\)/);
  // The person picks: the question is answered, and still listed with its picks — they are what the next render is.
  store.updateComment(id, { answer: { picks: { voice: ['v2'], close: ['c2'] }, note: 'slower' }, by: 'Sam' });
  const picked = vr(['open', 'launch.mp4'], env).out;
  assert.match(picked, new RegExp(`${id}  VERIFIED .*PICKED: render with these`));
  assert.match(picked, /↳ Sam \[verified\]: PICKED voice=v2 close=c2 · note: "slower"/);
  // A render after the picks: done with them.
  const slug = slugify(video);
  makeVideo(video, { w: 160, h: 90, dur: 1, pattern: 'smptebars' });
  age(video);
  store.sync(slug);
  assert.doesNotMatch(vr(['open', 'launch.mp4'], env).out, new RegExp(id));
});

test('vr ask --folder before any render: a new project made, vr show tells it, INBOX.md names the folder', () => {
  const asked = vr(['ask', '--folder', 'Launch film', '--text', 'Which closing line?', '--options', file], env);
  assert.equal(asked.code, 0, asked.err);
  const id = must(/^(c_[0-9a-f]{6}) asked on folder Launch film \(no video yet\)/m.exec(asked.out)?.[1], asked.out);
  assert.equal(must(asks.findAsk(id)).folder, 'Launch film');
  asks.answerAsk(id, { picks: { close: ['c1'] } }, 'Sam');
  const shown = vr(['show', id], env);
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, new RegExp(`${id}  VERIFIED .*QUESTION  folder Launch film \\(no video yet\\)  by agent:sound`));
  assert.match(shown.out, /↳ Sam \[verified\]: PICKED voice=- close=c1/);
  const inbox = fs.readFileSync(path.join(env.VR_DATA as string, 'INBOX.md'), 'utf8');
  assert.match(
    inbox,
    new RegExp(`ANSWERED · ${id}\\n- folder: Launch film \\(no video yet\\)\\n- comment: Which closing line\\?\\n- note: PICKED voice=- close=c1`),
  );
  const usage = vr(['ask', 'launch.mp4', '--folder', 'X', '--text', 'x', '--options', file], env);
  assert.equal(usage.code, 1);
  assert.match(usage.err, /usage: vr ask/);
});
