// Transcripts over HTTP on a hosted server, with a stand-in speech server (an OpenAI-compatible endpoint that answers
// with word timings): heard once per render's bytes and shared, served as JSON and as captions, a note that changes the
// words (made, changed by its author only), and what a review link shows — only on links that take notes, without the
// render's hash or the engine.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { tusUpload } from '../lib/http.ts';

// The stand-in speech server: counts what it is asked, answers every clip with the same four timed words.
const asked: string[] = [];
const stt = http.createServer((req, res) => {
  let body = '';
  req.setEncoding('latin1');
  req.on('data', (d) => {
    body += d;
  });
  req.on('end', () => {
    asked.push(body);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        text: 'Every morning we start.',
        language: 'english',
        words: [
          { word: 'Every', start: 0.1, end: 0.32 },
          { word: 'morning', start: 0.32, end: 0.64 },
          { word: 'we', start: 0.64, end: 0.8 },
          { word: 'start.', start: 0.8, end: 1.04 },
        ],
        segments: [{ text: 'Every morning we start.', start: 0.1, end: 1.04 }],
      }),
    );
  });
});
await new Promise<void>((r) => stt.listen(0, '127.0.0.1', r));
const sttUrl = `http://127.0.0.1:${(stt.address() as AddressInfo).port}/v1`;

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_STT: 'http', VR_STT_URL: sttUrl } });
const auth = await import('../../lib/auth.ts');

// a tone is "speech" enough for the silence gate; the stand-in says the words
const voice = makeVideo(path.join(dir, 'renders/voice.mp4'), { w: 160, h: 90, fps: 25, dur: 2, freq: 440 });

const { request } = await startApp();
let owner: Record<string, string> = {};
let ownerApp: Record<string, string> = {};
let reviewer: Record<string, string> = {};
before(async () => {
  const o = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
  const r = await auth.createUser({ email: 'rita@example.com', name: 'Rita', password: 'a long password', role: 'reviewer' });
  owner = { Authorization: `Bearer ${auth.createToken(o.id, 'test').token}` };
  // review links are a person's to make, signed in in the app (server/permissions.ts PERSON_ONLY)
  ownerApp = { Cookie: `vr_session=${auth.signSession(o)}`, Origin: PUBLIC };
  reviewer = { Authorization: `Bearer ${auth.createToken(r.id, 'test').token}` };
});
after(() => stt.close());

const e = encodeURIComponent;
const slugs: Record<string, string> = {};
const ready = async (url: string, headers: Record<string, string> = {}) => {
  // queued behind the uploads' own work (posters, the Auto-check): up to a minute on a busy machine
  for (let i = 0; i < 600; i++) {
    const a = await request('GET', url, { headers });
    assert.equal(a.status, 200, a.text);
    const j = a.json();
    if (j.state !== 'pending') return j;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`still pending: ${url}`);
};

test('a render is heard once, with word timings on its frames; the same bytes elsewhere share it', async () => {
  for (const [name, folder] of [
    ['voice', 'Acme'],
    ['copy', 'Acme/Other'],
  ] as const) {
    const up = await tusUpload(request, voice, { filename: `${name}.mp4`, folder }, owner);
    assert.equal(up.status, 200, up.text);
    slugs[name] = up.json().slug;
  }
  const first = await request('GET', `/api/review/${e(slugs.voice)}/transcript`, { headers: owner });
  assert.equal(first.status, 200, first.text);
  assert.ok(['pending', 'ready'].includes(first.json().state));
  const a = await ready(`/api/review/${e(slugs.voice)}/transcript`, owner);
  assert.equal(a.state, 'ready', JSON.stringify(a));
  const t = a.transcript;
  assert.equal(t.engine, 'http:whisper-1');
  assert.equal(t.timing, 'word');
  assert.equal(t.language, 'en');
  assert.deepEqual(
    t.words.map((w: { text: string; f0: number; f1: number }) => [w.text, w.f0, w.f1]),
    [
      ['Every', 2, 7],
      ['morning', 8, 15],
      ['we', 16, 19],
      ['start.', 20, 25],
    ],
  );
  assert.equal(asked.length, 1);
  assert.match(asked[0], /verbose_json/, 'asked for timings');
  assert.match(asked[0], /timestamp_granularities\[\]/);
  const copy = await ready(`/api/review/${e(slugs.copy)}/transcript`, owner);
  assert.equal(copy.state, 'ready');
  assert.equal(asked.length, 1, 'the same render is not heard twice');
});

test('captions come as SRT and WebVTT downloads', async () => {
  const srt = await request('GET', `/api/review/${e(slugs.voice)}/transcript.srt`, { headers: owner });
  assert.equal(srt.status, 200, srt.text);
  assert.match(String(srt.headers['content-type']), /subrip/);
  assert.equal(srt.text, '1\n00:00:00,100 --> 00:00:01,040\nEvery morning we start.\n');
  const vtt = await request('GET', `/api/review/${e(slugs.voice)}/transcript.vtt`, { headers: owner });
  assert.ok(vtt.text.startsWith('WEBVTT\n\n00:00:00.100 --> 00:00:01.040\n'));
});

test('hearing it again needs the Auto-check right; a reviewer only reads', async () => {
  const no = await request('POST', `/api/review/${e(slugs.voice)}/transcript/rerun`, { headers: reviewer });
  assert.equal(no.status, 403);
  const yes = await request('POST', `/api/review/${e(slugs.voice)}/transcript/rerun`, { headers: owner });
  assert.equal(yes.status, 200, yes.text);
  assert.equal((await ready(`/api/review/${e(slugs.voice)}/transcript`, reviewer)).state, 'ready');
  assert.equal(asked.length, 2, 'heard again once');
});

test('a note that changes the words: made with its range, changed by its author only, one line for agents', async () => {
  const made = await request('POST', `/api/review/${e(slugs.voice)}/comments`, {
    body: { frame: 8, range: { in: 8, out: 15 }, text: 'Evening, please', text_edit: { from: 'morning', to: 'evening' } },
    headers: owner,
  });
  assert.equal(made.status, 200, made.text);
  const note = made.json();
  assert.deepEqual(note.text_edit, { from: 'morning', to: 'evening' });
  const bad = await request('POST', `/api/review/${e(slugs.voice)}/comments`, { body: { frame: 8, text_edit: { from: ' ', to: 'x' } }, headers: owner });
  assert.equal(bad.status, 400, 'no words heard, no edit');
  const theirs = await request('PATCH', `/api/comments/${note.id}`, { body: { text_edit_to: 'night' }, headers: reviewer });
  assert.equal(theirs.status, 403, 'someone else’s note');
  const mine = await request('PATCH', `/api/comments/${note.id}`, { body: { text_edit_to: 'late evening' }, headers: owner });
  assert.equal(mine.status, 200, mine.text);
  assert.deepEqual(mine.json().text_edit, { from: 'morning', to: 'late evening' });
});

test('a review link that takes notes shows what is said (no hash, no engine); a watch-only link does not', async () => {
  const link = (await request('POST', '/api/folder-shares', { body: { folder: 'Acme', notes: 'own', label: 'Acme' }, headers: ownerApp })).json();
  const g = (p: string) => `/api/g/${link.token}${p}`;
  const room = (await request('GET', g(''))).json();
  const id = room.videos.find((v: { name: string }) => v.name === 'voice.mp4').slug;
  const a = await ready(g(`/review/${id}/transcript`));
  assert.equal(a.state, 'ready');
  assert.equal(a.transcript.words.length, 4);
  assert.equal(a.transcript.hash, undefined);
  assert.equal(a.transcript.engine, undefined);
  const edit = await request('POST', g('/comments'), {
    body: { name: 'Mia', slug: id, frame: 8, range: { in: 8, out: 15 }, text_edit: { from: 'morning', to: 'evening' } },
  });
  assert.equal(edit.status, 200, edit.text);
  const watch = (
    await request('POST', '/api/folder-shares', { body: { folder: 'Acme', notes: 'own', label: 'Watch', comment: false }, headers: ownerApp })
  ).json();
  const w = (await request('GET', `/api/g/${watch.token}`)).json();
  const wid = w.videos.find((v: { name: string }) => v.name === 'voice.mp4').slug;
  const no = await request('GET', `/api/g/${watch.token}/review/${wid}/transcript`);
  assert.equal(no.status, 403, 'a link without notes shows no transcript');
});
