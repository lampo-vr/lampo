// Answers an agent offers with a question (lib/choices.ts): cleaned in the store, checked on the API, kept only on a
// question, shown to agents in the note's lines; and the timecodes written in a note's text (lib/time.ts timecodesIn),
// which the inbox and the player turn into links to their frame.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import type { Comment } from '../../lib/types.ts';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, must } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const { cleanChoices, CHOICE_MAX } = await import('../../lib/choices.ts');
const { timecodesIn, posterFrame } = await import('../../lib/time.ts');
const store = await import('../../lib/store.ts');
const paths = await import('../../lib/paths.ts');

const video = makeVideo(path.join(dir, 'proj/export/choices.mp4'), { w: 320, h: 180, dur: 1 });
age(video);

const { port } = await startApp({ token: 'test-token', loadSessions: async () => [] });

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
function request(method: string, url: string, body?: unknown): Promise<{ status: number; text: string; json: () => any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, method, path: url, headers: data !== undefined ? { 'content-type': 'application/json' } : {} },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          text += d;
        });
        res.on('end', () => resolve({ status: res.statusCode || 0, text, json: () => JSON.parse(text) }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

test('choices are kept clean: one line each, trimmed, no repeats, 2–4 of them', () => {
  assert.deepEqual(cleanChoices(['  Yes ', 'No,\nit is "Kuro"', 'yes', '']), ['Yes', 'No, it is "Kuro"']);
  assert.deepEqual(cleanChoices(['a', 'b', 'c', 'd', 'e']), ['a', 'b', 'c', 'd'], 'at most four buttons');
  assert.equal(cleanChoices(['Only one']), null, 'one button is no choice');
  assert.equal(cleanChoices(['Same', 'same ']), null, 'repeats ignoring case leave one');
  assert.equal(cleanChoices('Yes'), null, 'not a list');
  assert.deepEqual(cleanChoices(['A', 42, null, 'B']), ['A', 'B'], 'only strings');
  const long = cleanChoices(['x'.repeat(200), 'y']);
  assert.equal(must(long)[0].length, CHOICE_MAX);
  assert.deepEqual(cleanChoices(['Ja\u2028genau', 'Nein\ttab']), ['Ja genau', 'Nein tab'], 'line separators and tabs are spaces');
});

test('a question keeps its choices in the store; other notes drop them; older notes load without', () => {
  store.createOrGetReview(video, { by: 'alex' });
  const slug = paths.slugify(video);
  const q = store.addComment(slug, { frame: 3, text: 'Name richtig?', author: 'agent:reel-2', choices: ['Ja', ' Nein, es ist … ', 'ja'] });
  assert.equal(q.kind, 'question');
  assert.deepEqual(q.choices, ['Ja', 'Nein, es ist …']);
  const fb = store.addComment(slug, { frame: 4, text: 'Logo später', author: 'alex', choices: ['a', 'b'] });
  assert.equal(fb.choices, undefined, 'feedback has nothing to choose from');
  const info = store.addComment(slug, { frame: 5, text: 'Changed the grade', author: 'agent:reel-2', kind: 'info', choices: ['a', 'b'] });
  assert.equal(info.choices, undefined, 'an info note asks nothing');
  const plain = store.addComment(slug, { frame: 6, text: 'Loop?', author: 'agent:reel-2' });
  assert.equal('choices' in plain, false, 'no field when none were offered');
});

test('the API takes 2–4 short choices on a question and refuses anything else', async () => {
  const slug = paths.slugify(video);
  const at = `/api/review/${encodeURIComponent(slug)}/comments`;
  const ok = await request('POST', at, { frame: 8, text: 'Hook oder Logo zuerst?', kind: 'question', choices: ['Hook', 'Logo'], by: 'agent:reel-2' });
  assert.equal(ok.status, 200, ok.text);
  const c: Comment = ok.json();
  assert.deepEqual(c.choices, ['Hook', 'Logo']);
  assert.equal((await request('POST', at, { frame: 8, text: 'x', kind: 'question', choices: ['only'] })).status, 400, 'one');
  assert.equal((await request('POST', at, { frame: 8, text: 'x', kind: 'question', choices: ['a', 'b', 'c', 'd', 'e'] })).status, 400, 'five');
  assert.equal((await request('POST', at, { frame: 8, text: 'x', kind: 'question', choices: ['a', 'b'.repeat(CHOICE_MAX + 1)] })).status, 400, 'too long');
  assert.equal((await request('POST', at, { frame: 8, text: 'x', kind: 'question', choices: ['a', ' '] })).status, 400, 'empty');
  assert.equal((await request('POST', at, { frame: 8, text: 'x', kind: 'question', choices: 'Yes' })).status, 400, 'not a list');
  // what the page reads comes back with them
  const review = (await request('GET', `/api/review/${encodeURIComponent(slug)}`)).json().review;
  assert.deepEqual(review.comments.find((x: Comment) => x.id === c.id)?.choices, ['Hook', 'Logo']);
  // and the inbox carries them with the question
  const fy = (await request('GET', '/api/for-you')).json();
  const item = fy.items.find((i: { id?: string }) => i.id === c.id);
  assert.deepEqual(item?.choices, ['Hook', 'Logo']);
});

test('timecodes in a note: the forms people and agents write, only frames the render has', () => {
  const at = (s: string, fps = 25, frames = 25 * 120) => timecodesIn(s, fps, frames).map((m) => [m.text, m.frame]);
  assert.deepEqual(at('Namenskarte (0:28:20) und Endkarte 00:28:20.'), [
    ['0:28:20', 720],
    ['00:28:20', 720],
  ]);
  assert.deepEqual(at('at 1:00:12:03', 25, 25 * 4000), [['1:00:12:03', 90303]], 'with hours');
  assert.deepEqual(at('um 10:30:00 Uhr'), [], 'a time of day past the render stays text');
  assert.deepEqual(at('00:12:30'), [], 'frames under the frame rate');
  assert.deepEqual(at('00:61:00'), [], 'seconds under 60');
  assert.deepEqual(at('12:30:00:00:00 or 1.12:03:04 or 00:01:02.5'), [], 'not inside longer numbers');
  assert.deepEqual(at('f360 and 12s'), [], 'only timecodes');
  assert.deepEqual(at('00:01:29', 29.97, 300), [['00:01:29', 59]], 'a fractional rate counts its frames like the app does');
  const m = must(timecodesIn('see 00:00:12!', 30, 90)[0]);
  assert.equal('see 00:00:12!'.slice(m.start, m.end), '00:00:12');
  assert.equal(posterFrame({ frames: 100, duration: 4, fps: 25 }), 15, 'a preview without a moment opens where the poster is');
});
