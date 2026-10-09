// Recorded feedback over HTTP on a hosted server, with a stand-in speech engine that answers with word timings: the
// event log, then the audio; heard in the background into drafts on the frames the log says were on screen (a spot
// from the pointer's rest); only its maker sees, edits, sends or discards it; sending makes ordinary notes, each with its
// own clip of the audio, the words as heard next to the edited text, `source: recording` and its stretch — and the
// recording is gone.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { FFMPEG, isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { cookieFrom, tusUpload } from '../lib/http.ts';

let heardCalls = 0;
const stt = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    heardCalls++;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        text: 'The logo lands too early. Make this title bigger.',
        language: 'english',
        words: [
          { word: 'The', start: 0.2, end: 0.4 },
          { word: 'logo', start: 0.4, end: 0.7 },
          { word: 'lands', start: 0.7, end: 0.9 },
          { word: 'too', start: 0.9, end: 1.0 },
          { word: 'early.', start: 1.0, end: 1.3 },
          { word: 'Make', start: 2.4, end: 2.6 },
          { word: 'this', start: 2.6, end: 2.8 },
          { word: 'title', start: 2.8, end: 3.1 },
          { word: 'bigger.', start: 3.1, end: 3.5 },
        ],
        segments: [],
      }),
    );
  });
});
await new Promise<void>((r) => stt.listen(0, '127.0.0.1', r));
const sttUrl = `http://127.0.0.1:${(stt.address() as AddressInfo).port}/v1`;

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_STT: 'http', VR_STT_URL: sttUrl } });
const auth = await import('../../lib/auth.ts');
const { reviewDir } = await import('../../lib/paths.ts');
const { EVENTS_FILE: EVENTS } = await import('../../lib/store.ts');

const video = makeVideo(path.join(dir, 'renders/spot.mp4'), { w: 160, h: 90, fps: 25, dur: 5 });
// the "microphone": four seconds of tone (the silence gate hears a voice; the stand-in says the words)
const audio = fs.readFileSync(makeVideo(path.join(dir, 'mic/take.mp4'), { w: 32, h: 32, fps: 5, dur: 4, freq: 330 }));
// longer than a recording may be, and small: tone as a WAV, well under the body's limit (made before the app runs: a
// synchronous encode meanwhile would hold its event loop)
const long = path.join(dir, 'mic/long.wav');
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=8000:duration=700', '-ac', '1', '-c:a', 'pcm_s16le', '-y', long]);

const { request } = await startApp();
// Recordings are people's, in the app (a browser session): an API token of the same person gets nowhere with them.
let olivia: Record<string, string> = {};
let max: Record<string, string> = {};
let oliviaToken: Record<string, string> = {};
let slug = '';
async function session(email: string): Promise<Record<string, string>> {
  const login = await request('POST', '/api/auth/login', { body: { email, password: 'a long password' }, headers: { Origin: PUBLIC } });
  assert.equal(login.status, 200, login.text);
  return { Cookie: cookieFrom(login), Origin: PUBLIC };
}
before(async () => {
  const o = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
  await auth.createUser({ email: 'max@example.com', name: 'Max', password: 'a long password', role: 'member' });
  oliviaToken = { Authorization: `Bearer ${auth.createToken(o.id, 'test').token}` };
  olivia = await session('olivia@example.com');
  max = await session('max@example.com');
  const up = await tusUpload(request, video, { filename: 'spot.mp4', folder: 'Acme' }, oliviaToken);
  assert.equal(up.status, 200, up.text);
  slug = up.json().slug;
});
after(() => stt.close());

const e = encodeURIComponent;
const base = () => `/api/review/${e(slug)}/recordings`;
// paused on F10 while the first sentence is said; a jump to F60, the pointer resting on the left third while the
// second one is said
const events = [
  { t: 0, k: 'frame', f: 0 },
  { t: 0.1, k: 'seek', f: 10 },
  { t: 0.1, k: 'frame', f: 10 },
  { t: 2.0, k: 'seek', f: 60 },
  { t: 2.0, k: 'frame', f: 60 },
  ...Array.from({ length: 14 }, (_, i) => ({ t: Math.round((2.3 + i * 0.1) * 10) / 10, k: 'pointer', x: 0.25, y: 0.5 })),
];
let id = '';

test('the log, then the audio: heard in the background into drafts on the frames the log says', async () => {
  const bad = await request('POST', base(), { body: { v: 1, duration: 4, events: [{ t: 1, k: 'pointer', x: 3, y: 0 }] }, headers: olivia });
  assert.equal(bad.status, 400, 'a pointer off the picture is refused');
  const made = await request('POST', base(), { body: { v: 1, duration: 4, events }, headers: olivia });
  assert.equal(made.status, 200, made.text);
  const rec = made.json();
  id = rec.id;
  assert.match(id, /^rec_[a-f0-9]{12}$/);
  assert.equal(rec.state, 'uploading');
  assert.equal(rec.events, undefined, 'the log stays on the server');

  const sent = await request('PUT', `${base()}/${id}/audio`, { body: audio, headers: { ...olivia, 'content-type': 'audio/mp4' } });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.json().state, 'hearing');
  const again = await request('PUT', `${base()}/${id}/audio`, { body: audio, headers: { ...olivia, 'content-type': 'audio/mp4' } });
  assert.equal(again.status, 409, 'the audio comes once');

  let ready = null;
  for (let i = 0; i < 600 && !ready; i++) {
    const list = (await request('GET', base(), { headers: olivia })).json().recordings;
    if (list[0]?.state === 'ready' || list[0]?.state === 'failed') ready = list[0];
    else await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, 'heard');
  assert.equal(ready.state, 'ready', JSON.stringify(ready));
  assert.equal(heardCalls >= 1, true);
  const [a, b] = ready.drafts;
  assert.equal(ready.drafts.length, 2);
  assert.equal(a.frame, 10);
  assert.equal(a.range, null);
  assert.equal(a.text, 'The logo lands too early.');
  assert.equal(a.heard, a.text);
  assert.ok(Array.isArray(a.tags));
  assert.equal(b.frame, 60);
  assert.deepEqual(b.spot, [0.25, 0.5]);
  assert.equal(b.drawing.length, 1, 'the spot as a ring');
  assert.equal(b.drawing[0].type, 'freehand');
});

test("only its maker sees, changes, hears or sends it; someone else's recording doesn't exist for them", async () => {
  assert.deepEqual((await request('GET', base(), { headers: max })).json().recordings, []);
  for (const [method, url] of [
    ['PATCH', `${base()}/${id}`],
    ['POST', `${base()}/${id}/send`],
    ['GET', `${base()}/${id}/audio`],
    ['DELETE', `${base()}/${id}`],
  ] as const) {
    const r = await request(method, url, { body: method === 'PATCH' ? { drafts: [] } : method === 'POST' ? {} : undefined, headers: max });
    assert.equal(r.status, 404, `${method} ${url}: ${r.text}`);
  }
  const audioBack = await request('GET', `${base()}/${id}/audio`, { headers: olivia });
  assert.equal(audioBack.status, 200);
});

test('edited drafts are kept; sending makes ordinary notes with their own clip, and the recording goes', async () => {
  const list = (await request('GET', base(), { headers: olivia })).json().recordings;
  const drafts = list[0].drafts.map((d: { text: string }, i: number) => (i === 0 ? { ...d, text: 'The logo lands a beat too early.', severity: 'must' } : d));
  const patched = await request('PATCH', `${base()}/${id}`, { body: { drafts }, headers: olivia });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.json().drafts[0].text, 'The logo lands a beat too early.');

  const sent = await request('POST', `${base()}/${id}/send`, { body: {}, headers: olivia });
  assert.equal(sent.status, 200, sent.text);
  const { notes, left } = sent.json();
  assert.equal(left.length, 0);
  assert.equal(notes.length, 2);
  const [n1, n2] = notes;
  assert.equal(n1.text, 'The logo lands a beat too early.');
  assert.equal(n1.severity, 'must');
  assert.equal(n1.frame, 10);
  assert.equal(n1.source, 'recording');
  assert.deepEqual(n1.recording, { id, t0: 0.2, t1: 1.3 });
  assert.equal(n1.voice.transcript, 'The logo lands too early.', 'the words as heard, next to the edited text');
  assert.ok(fs.existsSync(path.join(reviewDir(slug), n1.voice.file)), 'its own clip');
  assert.equal(n1.author, 'Olivia');
  assert.equal(n2.frame, 60);
  assert.equal(n2.drawing.length, 1);
  assert.ok(n2.shots?.marked, 'the marked frame shows the spot');
  assert.deepEqual((await request('GET', base(), { headers: olivia })).json().recordings, [], 'sent: gone');
  assert.ok(!fs.existsSync(path.join(reviewDir(slug), 'recordings', `${id}.m4a`)));
  const review = (await request('GET', `/api/review/${e(slug)}`, { headers: olivia })).json().review;
  assert.equal(review.comments.filter((c: { source?: string }) => c.source === 'recording').length, 2);
});

test('Send all: typed drafts and what a recording said go out together, in one batch of events', async () => {
  const person = olivia;
  const rec = (await request('POST', base(), { body: { v: 1, duration: 4, events }, headers: olivia })).json();
  await request('PUT', `${base()}/${rec.id}/audio`, { body: audio, headers: { ...olivia, 'content-type': 'audio/mp4' } });
  for (let i = 0; i < 600; i++) {
    const r = (await request('GET', base(), { headers: olivia })).json().recordings.find((x: { id: string }) => x.id === rec.id);
    if (r?.state === 'ready') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const typed = await request('POST', `/api/review/${e(slug)}/drafts`, { body: { frame: 30, text: 'Typed, kept for later' }, headers: person });
  assert.equal(typed.status, 200, typed.text);
  assert.deepEqual((await request('GET', '/api/drafts', { headers: person })).json().videos, { [slug]: 3 }, 'one typed + two said');
  const before = fs.readFileSync(EVENTS, 'utf8');
  const sent = await request('POST', `/api/review/${e(slug)}/drafts/send`, { body: { recordings: true }, headers: person });
  assert.equal(sent.status, 200, sent.text);
  const { notes, left } = sent.json();
  assert.equal(left, 0);
  assert.deepEqual(
    notes.map((n: { text: string; source?: string }) => [n.text, n.source ?? null]),
    [
      ['Typed, kept for later', null],
      ['The logo lands too early.', 'recording'],
      ['Make this title bigger.', 'recording'],
    ],
  );
  assert.ok(fs.existsSync(path.join(reviewDir(slug), notes[1].voice.file)), 'each said note keeps its own clip');
  const added = fs
    .readFileSync(EVENTS, 'utf8')
    .slice(before.length)
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    added.map((x: { type: string; id: string }) => [x.type, x.id]),
    notes.map((n: { id: string }) => ['comment', n.id]),
    'three comment events, in order, nothing between them',
  );
  assert.deepEqual((await request('GET', base(), { headers: olivia })).json().recordings, [], 'the recording is gone');
  assert.deepEqual((await request('GET', '/api/drafts', { headers: person })).json().videos, {});
});

test('a single Send: one recording draft or one typed draft alone, each a batch of one; the rest stay', async () => {
  const person = olivia;
  const rec = (await request('POST', base(), { body: { v: 1, duration: 4, events }, headers: olivia })).json();
  await request('PUT', `${base()}/${rec.id}/audio`, { body: audio, headers: { ...olivia, 'content-type': 'audio/mp4' } });
  let ready: { id: string; drafts: { id: string; text: string }[] } | undefined;
  for (let i = 0; i < 600 && !ready; i++) {
    const r = (await request('GET', base(), { headers: olivia })).json().recordings.find((x: { id: string; state: string }) => x.id === rec.id);
    if (r?.state === 'ready') ready = r;
    else await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready && ready.drafts.length === 2, 'heard into two drafts');
  const [said1, said2] = ready.drafts;
  const typed = (await request('POST', `/api/review/${e(slug)}/drafts`, { body: { frame: 40, text: 'Typed, one of two' }, headers: person })).json();
  const typed2 = (await request('POST', `/api/review/${e(slug)}/drafts`, { body: { frame: 50, text: 'Typed, two of two' }, headers: person })).json();
  const sendOne = async (body: object) => {
    const before = fs.readFileSync(EVENTS, 'utf8');
    const sent = await request('POST', `/api/review/${e(slug)}/drafts/send`, { body, headers: person });
    assert.equal(sent.status, 200, sent.text);
    const added = fs.readFileSync(EVENTS, 'utf8').slice(before.length).trim().split('\n').filter(Boolean);
    return { ...sent.json(), events: added.map((l) => JSON.parse(l)) };
  };

  // the recording's second draft, named by its id: one note, one event; the first draft and both typed ones stay
  const a = await sendOne({ ids: [], recordings: [said2.id] });
  assert.equal(a.left, 0, 'the drafts not named are not "left"');
  assert.deepEqual(
    a.notes.map((n: { text: string; source?: string }) => [n.text, n.source]),
    [[said2.text, 'recording']],
  );
  assert.deepEqual(
    a.events.map((x: { type: string; id: string }) => [x.type, x.id]),
    [['comment', a.notes[0].id]],
  );
  const kept = (await request('GET', base(), { headers: olivia })).json().recordings.find((x: { id: string }) => x.id === rec.id);
  assert.deepEqual(
    kept?.drafts.map((d: { id: string }) => d.id),
    [said1.id],
    'the recording keeps the draft not sent',
  );
  const drafts = () => request('GET', `/api/review/${e(slug)}/drafts`, { headers: person }).then((r) => r.json().drafts.map((d: { id: string }) => d.id));
  assert.deepEqual(await drafts(), [typed.id, typed2.id], 'the typed drafts stay');

  // one typed draft by its id, without the recordings: one note, one event
  const b = await sendOne({ ids: [typed.id], recordings: false });
  assert.deepEqual(
    b.notes.map((n: { text: string }) => n.text),
    ['Typed, one of two'],
  );
  assert.equal(b.events.length, 1);
  assert.deepEqual(await drafts(), [typed2.id]);
  assert.equal((await request('GET', base(), { headers: olivia })).json().recordings.find((x: { id: string }) => x.id === rec.id)?.drafts.length, 1);
  assert.deepEqual((await request('GET', '/api/drafts', { headers: person })).json().videos, { [slug]: 2 }, 'one typed + one said, still to send');

  // a recording draft nobody has (sent already, or someone else's): nothing goes, nothing breaks
  const none = await sendOne({ ids: [], recordings: [said2.id] });
  assert.deepEqual(none.notes, []);
  assert.equal(none.events.length, 0);

  // Send all: the rest in one batch
  const c = await sendOne({ recordings: true });
  assert.deepEqual(
    c.notes.map((n: { text: string }) => n.text),
    ['Typed, two of two', said1.text],
  );
  assert.equal(c.events.length, 2);
  assert.deepEqual((await request('GET', '/api/drafts', { headers: person })).json().videos, {});
});

test('discarding removes a recording and its audio', async () => {
  const made = (await request('POST', base(), { body: { v: 1, duration: 1, events: [{ t: 0, k: 'frame', f: 0 }] }, headers: max })).json();
  const gone = await request('DELETE', `${base()}/${made.id}`, { headers: max });
  assert.equal(gone.status, 200, gone.text);
  assert.deepEqual((await request('GET', base(), { headers: max })).json().recordings, []);
});

test('an API token is not the person here: with one, a recording is never listed, made, read, heard, changed, sent or discarded', async () => {
  const made = await request('POST', base(), { body: { v: 1, duration: 1, events: [{ t: 0, k: 'frame', f: 0 }] }, headers: olivia });
  assert.equal(made.status, 200, made.text);
  const rec = made.json().id;
  const calls: [string, string, unknown][] = [
    ['GET', base(), undefined],
    ['POST', base(), { v: 1, duration: 1, events: [{ t: 0, k: 'frame', f: 0 }] }],
    ['PUT', `${base()}/${rec}/audio`, audio],
    ['POST', `${base()}/${rec}/hear`, {}],
    ['GET', `${base()}/${rec}/audio`, undefined],
    ['PATCH', `${base()}/${rec}`, { drafts: [] }],
    ['POST', `${base()}/${rec}/send`, {}],
    ['DELETE', `${base()}/${rec}`, undefined],
  ];
  for (const [method, url, body] of calls) {
    const r = await request(method, url, { body, headers: { ...oliviaToken, ...(Buffer.isBuffer(body) ? { 'content-type': 'audio/mp4' } : {}) } });
    assert.equal(r.status, 403, `${method} ${url}: ${r.status} ${r.text}`);
    assert.doesNotMatch(r.text, /rec_|uploading|heard/, 'nothing of it in the answer');
  }
  const still = (await request('GET', base(), { headers: olivia })).json().recordings;
  assert.ok(
    still.some((x: { id: string }) => x.id === rec),
    'untouched, and hers in the app',
  );
  assert.equal((await request('DELETE', `${base()}/${rec}`, { headers: olivia })).status, 200);
});

test('audio longer than a recording may be is refused in plain words, and none of it is kept', async () => {
  const made = await request('POST', base(), { body: { v: 1, duration: 4, events: [] }, headers: olivia });
  assert.equal(made.status, 200, made.text);
  const rec = made.json().id;
  const put = await request('PUT', `${base()}/${rec}/audio`, { body: fs.readFileSync(long), headers: { ...olivia, 'content-type': 'audio/wav' } });
  assert.equal(put.status, 413, put.text);
  assert.equal(put.json().error, 'a recording is at most 10 minutes');
  const kept = fs.readdirSync(path.join(reviewDir(slug), 'recordings')).filter((f) => f.startsWith(rec) && !f.endsWith('.json'));
  assert.deepEqual(kept, [], 'no audio of it stays, cut or whole');
  assert.equal((await request('DELETE', `${base()}/${rec}`, { headers: olivia })).status, 200);
});
