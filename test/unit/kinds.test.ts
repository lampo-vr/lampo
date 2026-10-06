// What a note is: feedback with a severity (must > should > nice > idea), or an agent's question / info note.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { Comment, Review } from '../../lib/types.ts';
import { age, isolatedEnv, makeVideo, must } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const paths = await import('../../lib/paths.ts');
const time = await import('../../lib/time.ts');
const { autoSeverity } = await import('../../lib/autotag.ts');
const { claudePrompt } = await import('../../lib/prompt.ts');

const note = (over: Partial<Comment>): Comment => ({ id: 'c_000000', severity: 'should', author: 'alex', status: 'open', t: 0, ...over }) as Comment;

test('severities run must > should > nice > idea; ideas, questions and info notes are not work', () => {
  assert.deepEqual(time.SEVERITIES, ['must', 'should', 'nice', 'idea']);
  const list = [
    note({ id: 'info', kind: 'info', author: 'agent:x' }),
    note({ id: 'q', kind: 'question', author: 'agent:x' }),
    note({ id: 'idea', severity: 'idea' }),
    note({ id: 'nice', severity: 'nice' }),
    note({ id: 'legacy', severity: 'nice', author: 'agent:old' }),
    note({ id: 'must', severity: 'must' }),
  ];
  const order = [...list].sort((a, b) => time.noteRank(a) - time.noteRank(b)).map((c) => c.id);
  assert.deepEqual(order.slice(0, 3), ['must', 'nice', 'idea']);
  assert.deepEqual(order.slice(-1), ['info']);
  assert.deepEqual(
    list.filter(time.isRequired).map((c) => c.id),
    ['nice', 'must'],
  );
  assert.deepEqual(
    list.filter(time.isIdea).map((c) => c.id),
    ['idea'],
  );
  assert.deepEqual(
    list.filter(time.isQuestion).map((c) => c.id),
    ['q', 'legacy'],
    'kind-less agent notes read as questions',
  );
  assert.equal(time.noteKind(note({ author: 'agent:old' })), 'agent');
  assert.equal(time.noteKind(note({ kind: 'feedback', author: 'agent:reviewer' })), 'feedback', 'an agent can file feedback explicitly');
  assert.equal(time.noteLabel({ kind: 'question', severity: 'nice' }), 'QUESTION');
  assert.equal(time.noteLabel({ severity: 'idea' }), 'IDEA');
  assert.equal(time.noteLabel({ severity: 'nice' }), 'NICE', 'legacy agent notes keep their old label');
});

test('autotag hears ideas (German and English) without swallowing small changes', () => {
  for (const t of [
    'Idee: der Titel könnte reinfliegen',
    'Vielleicht könnte man hier Musik unterlegen',
    'Was wäre, wenn wir mit dem Produkt starten?',
    'Nur so ein Gedanke, eine Zeitlupe am Ende',
    'Just an idea: slow motion here',
    'What if the logo spins in?',
    'How about a warmer grade?',
  ])
    assert.equal(autoSeverity(t), 'idea', t);
  assert.equal(autoSeverity('Vielleicht etwas kürzer'), 'nice');
  assert.equal(autoSeverity('Das muss unbedingt raus, ist falsch'), 'must', 'must wins over an idea phrase');
  assert.equal(autoSeverity('Etwas heller bitte'), 'should');
});

test('a review.json from before kinds loads unchanged and reads the old agent note as a question', () => {
  const video = makeVideo(path.join(dir, 'old/export/old.mp4'), { w: 160, h: 90, dur: 1 });
  age(video);
  const slug = paths.slugify(video);
  store.createOrGetReview(video, { by: 'alex' });
  store.addComment(slug, { frame: 3, text: 'Farbe kippt', severity: 'must', author: 'alex' });
  const agent = store.addComment(slug, { frame: 5, text: 'Absicht?', author: 'agent:old' });
  // Write the file the way an older version did: no `kind`, the agent's note filed as "nice".
  const file = paths.reviewFile(slug);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Review;
  for (const c of raw.comments) {
    delete c.kind;
    if (c.id === agent.id) c.severity = 'nice';
  }
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  const before = fs.readFileSync(file, 'utf8');

  const review = must(store.loadReview(slug));
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'loading does not rewrite the file');
  const n = store.counts(review);
  assert.equal(n.open, 1, 'only the human feedback is work');
  assert.equal(n.questions, 1);
  const md = store.renderReviewMd(review);
  assert.match(md, /## Open \(1\)[\s\S]*MUST · – · 00:00:03/);
  assert.match(md, /## Questions and notes from agents, waiting for .* \(1\)[\s\S]*NICE · – · 00:00:05 .*asked by agent:old/);

  // A human's new feedback is still stored without `kind`, exactly like before.
  const human = store.addComment(slug, { frame: 7, text: 'Idee: Zeitlupe', severity: 'idea', author: 'alex' });
  assert.equal(human.kind, undefined);
  const prompt = claudePrompt(must(store.loadReview(slug)));
  assert.match(prompt, /Open \(1, 1 must\)/);
  assert.match(prompt, /Ideas \(optional — your call\) \(1\)[\s\S]*IDEA · – · 00:00:07/);
  assert.match(prompt, /Questions to the reviewer, not answered yet \(1\)[\s\S]*00:00:05 f5 · asked by agent:old/);
});

test('an info note from an agent is neither work nor a question, and says what it is everywhere', () => {
  const video = makeVideo(path.join(dir, 'info/export/info.mp4'), { w: 160, h: 90, dur: 1 });
  age(video);
  const slug = paths.slugify(video);
  store.createOrGetReview(video, { by: 'alex' });
  const c = store.addComment(slug, { frame: 2, text: 'Farben angeglichen', kind: 'info', severity: 'must', author: 'agent:x' });
  assert.equal(c.kind, 'info');
  assert.equal(c.severity, 'nice', 'no priority for info notes (stored as nice for older readers)');
  const review = must(store.loadReview(slug));
  const n = store.counts(review);
  assert.deepEqual([n.open, n.ideas, n.questions, n.total], [0, 0, 0, 1]);
  assert.match(store.renderReviewMd(review), /INFO · – · 00:00:02 .* · by agent:x/);
  const ev = store.readEvents().find((e) => e.id === c.id);
  assert.equal(ev?.kind, 'info');
});
