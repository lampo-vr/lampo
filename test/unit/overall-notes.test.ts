// A note about the whole video is stored at frame 0, but it is not about frame 0: every format an agent reads says it is
// about the whole video (`vr prompt`, INBOX.md, review.md, `vr open`), and none names screenshots it doesn't have.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { age, isolatedEnv, makeVideo, slugOf, vr } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv({ vars: { VR_STT: 'off' } });
const store = await import('../../lib/store.ts');
const { reviewDir } = await import('../../lib/paths.ts');

const film = makeVideo(path.join(dir, 'Acme/export/whole.mp4'), { w: 160, h: 90, dur: 1 });
age(film);
store.createOrGetReview(film, { by: 'Sam Rivera' });
const slug = slugOf(film);
const note = store.addComment(slug, { frame: 0, text: 'The pacing drags overall', scope: 'video', author: 'Mia Hartmann', severity: 'must' });
const SAID = /about the whole video, not frame 0/;

test('vr prompt: about the whole video, and no screenshot lines it has no files for', () => {
  const r = vr(['prompt', film], env);
  assert.equal(r.code, 0, r.err);
  const block = r.out.slice(r.out.indexOf(note.id));
  assert.match(block.split('\n')[0] as string, SAID);
  assert.doesNotMatch(r.out, /marked: null|clean: {2}null/);
});

test('INBOX.md and review.md say it too', () => {
  store.writeInbox();
  const inbox = fs.readFileSync(store.inboxPath(), 'utf8');
  const entry = inbox.slice(inbox.indexOf(note.id));
  assert.match(entry.slice(0, entry.indexOf('\n## ') > 0 ? entry.indexOf('\n## ') : undefined), SAID);
  const md = fs.readFileSync(path.join(reviewDir(slug), 'review.md'), 'utf8');
  assert.match(md.split('\n').find((l) => l.includes(note.id)) ?? '', SAID);
});

test('vr open names it overall', () => {
  const r = vr(['open', film], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out.split('\n').find((l) => l.includes(note.id)) ?? '', /OVERALL: about the whole video, not frame 0/);
});

test('on a hosted server too: "Copy for an agent" says it is overall and sends nobody for frames it has none of', async () => {
  const { claudePrompt } = await import('../../lib/prompt.ts');
  store.addComment(slug, { frame: 12, text: 'The logo is cut off', author: 'Mia Hartmann', severity: 'must' });
  const out = claudePrompt(store.loadReview(slug) as NonNullable<ReturnType<typeof store.loadReview>>, { hosted: 'https://review.example.test' });
  const block = (id: string) => {
    const from = out.indexOf(id);
    const next = out.slice(from + id.length).search(/\n\d+\. c_/);
    return out.slice(from, next < 0 ? undefined : from + id.length + next);
  };
  const framed = (store.loadReview(slug)?.comments ?? []).find((c) => c.text === 'The logo is cut off');
  assert.ok(framed);
  assert.match(block(note.id).split('\n')[0] as string, SAID);
  assert.doesNotMatch(block(note.id), /frames: /, 'no frames to download for the whole video');
  assert.match(block(framed.id), new RegExp(`frames: \\S+ show ${framed.id}`), 'a note on a frame still names its frames');
});
