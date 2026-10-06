// The HTTP API end to end on a real socket: the main routes, input validation, and the guard (host/origin checks,
// remote requests, share-link scoping). The app is booted in-process on a random port with an isolated store.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import type { Comment, LibraryResponse, ReviewResponse } from '../../lib/types.ts';
import { startApp } from '../lib/app.ts';
import { age, FFMPEG, isolatedEnv, makeVideo, must } from '../lib/helpers.ts';

const { dir } = isolatedEnv();

const video = makeVideo(path.join(dir, 'proj/export/api.mp4'), { w: 320, h: 180, dur: 1 });
age(video);

const { port } = await startApp({ token: 'test-token', loadSessions: async () => [] });

interface Reply {
  status: number;
  text: string;
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
  json: () => any;
}

// node:http rather than fetch, so tests can send the Host and forwarding headers a proxy or attacker would.
function request(method: string, url: string, { body, headers = {} }: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, method, path: url, headers: { ...(data !== undefined ? { 'content-type': 'application/json' } : {}), ...headers } },
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

let slug = '';
let comment: Comment;

test('library: add a video, list it, reject bad paths', async () => {
  const added = await request('POST', '/api/library', { body: { path: video, folder: 'Proj' } });
  assert.equal(added.status, 200, added.text);
  slug = added.json().video.slug;
  assert.equal(added.json().created, true);
  const lib: LibraryResponse = (await request('GET', '/api/library')).json();
  assert.equal(lib.videos.length, 1);
  assert.equal(lib.videos[0].folder, 'Proj');
  assert.deepEqual(lib.folders, ['Proj']);
  assert.equal((await request('POST', '/api/library', { body: { path: 'relative/clip.mp4' } })).status, 400);
  assert.equal((await request('POST', '/api/library', { body: { path: path.join(dir, 'nope.mp4') } })).status, 404);
  assert.equal((await request('POST', '/api/library', { body: { path: 42 } })).status, 400, 'wrong type');
});

test('review: full state with playback info per version', async () => {
  const r = await request('GET', `/api/review/${encodeURIComponent(slug)}`);
  assert.equal(r.status, 200, r.text);
  const body: ReviewResponse = r.json();
  assert.equal(body.review.video, video);
  assert.equal(body.summary.frames, 30);
  const media = must(body.media[1], 'media for v1');
  assert.equal(media.ready, true);
  assert.match(must(media.url), /^\/media\/.+\/v1\?h=[0-9a-f]{10}/);
  assert.equal((await request('GET', '/api/review/nope')).status, 404);
});

test('media: range requests are answered with bounded 206 chunks', async () => {
  const r = await request('GET', `/media/${encodeURIComponent(slug)}/v1`, { headers: { range: 'bytes=0-99' } });
  assert.equal(r.status, 206);
  assert.equal(r.text.length > 0, true);
});

test('comments: create with a drawing, patch, validate, delete', async () => {
  const created = await request('POST', `/api/review/${encodeURIComponent(slug)}/comments`, {
    body: { v: 1, frame: 12, text: 'Logo zu früh', tags: ['timing'], severity: 'must', drawing: [{ type: 'box', x: 10, y: 10, w: 50, h: 30 }] },
  });
  assert.equal(created.status, 200, created.text);
  comment = created.json();
  assert.equal(comment.timecode, '00:00:12');
  assert.deepEqual(comment.drawing, [{ type: 'box', x: 10, y: 10, w: 50, h: 30 }]);
  assert.ok(comment.shots, 'the API makes screenshots');
  assert.ok(fs.existsSync(path.join(dir, 'data', slug, comment.shots.marked)));

  const bad = await request('POST', `/api/review/${encodeURIComponent(slug)}/comments`, { body: { frame: 3, severity: 'urgent' } });
  assert.equal(bad.status, 400);
  assert.match(bad.json().error, /severity/);
  const riddle = await request('POST', `/api/review/${encodeURIComponent(slug)}/comments`, { body: { frame: 3, kind: 'riddle' } });
  assert.equal(riddle.status, 400);
  assert.match(riddle.json().error, /kind/);
  const idea: Comment = (
    await request('POST', `/api/review/${encodeURIComponent(slug)}/comments`, { body: { frame: 4, text: 'Zeitlupe?', severity: 'idea' } })
  ).json();
  assert.equal(idea.severity, 'idea');
  const asked: Comment = (
    await request('POST', `/api/review/${encodeURIComponent(slug)}/comments`, { body: { frame: 5, text: 'Soll das so?', by: 'agent:api' } })
  ).json();
  assert.equal(asked.kind, 'question', 'an agent writing through the API asks by default');
  const malformed = await request('POST', `/api/review/${encodeURIComponent(slug)}/comments`, { body: '{"frame": 3' });
  assert.equal(malformed.status, 400, 'broken JSON is a 400 with a JSON error');
  assert.ok(malformed.json().error);

  const fixed = await request('PATCH', `/api/comments/${comment.id}`, { body: { status: 'fixed', note: 'moved' } });
  assert.equal(fixed.status, 200, fixed.text);
  assert.equal(fixed.json().status, 'fixed');
  assert.equal((await request('PATCH', '/api/comments/not-an-id', { body: { note: 'x' } })).status, 400);
  assert.equal((await request('PATCH', `/api/comments/${comment.id}`, { body: { status: 'done' } })).status, 400);

  const temp: Comment = (await request('POST', `/api/review/${encodeURIComponent(slug)}/comments`, { body: { frame: 2, text: 'temp' } })).json();
  assert.equal((await request('DELETE', `/api/comments/${temp.id}`)).json().ok, true);
  assert.ok(temp.shots);
  assert.ok(!fs.existsSync(path.join(dir, 'data', slug, temp.shots.marked)), 'its screenshots go with it');
});

test('library: archiving a video with notes can be undone (restore)', async () => {
  const other = makeVideo(path.join(dir, 'proj/export/undo.mp4'), { w: 320, h: 180, dur: 1 });
  age(other);
  const s2 = (await request('POST', '/api/library', { body: { path: other } })).json().video.slug as string;
  const url = `/api/library/${encodeURIComponent(s2)}`;
  assert.equal((await request('POST', `/api/review/${encodeURIComponent(s2)}/comments`, { body: { frame: 2, text: 'keep me' } })).status, 200);
  const gone = await request('DELETE', url);
  assert.equal(gone.json().archived, true, 'a video with notes is archived, not deleted');
  const listed = () => (request('GET', '/api/library') as Promise<Reply>).then((r) => (r.json() as LibraryResponse).videos.find((v) => v.slug === s2));
  assert.ok((await listed())?.archived);
  const back = await request('POST', `${url}/restore`);
  assert.equal(back.status, 200, back.text);
  assert.equal(back.json().video.archived ?? null, null);
  assert.ok(!(await listed())?.archived, 'back in the library');
  assert.equal((await request('POST', '/api/library/nope/restore')).status, 404);
});

test('folders and approval', async () => {
  const moved = await request('PUT', `/api/review/${encodeURIComponent(slug)}/folder`, { body: { folder: 'Proj/Final' } });
  assert.equal(moved.json().folder, 'Proj/Final');
  const approved = await request('PUT', `/api/review/${encodeURIComponent(slug)}/approval`, { body: { status: 'approved', note: 'passt', v: 1 } });
  assert.equal(approved.json().approval.status, 'approved');
  const cleared = await request('PUT', `/api/review/${encodeURIComponent(slug)}/approval`, { body: {} });
  assert.equal(cleared.json().approval, null);
  assert.equal((await request('POST', `/api/review/${encodeURIComponent(slug)}/request`, { body: { text: '  ' } })).status, 400);
});

test('guard: foreign hosts, cross-origin writes and proxied requests are refused', async () => {
  const host = await request('GET', '/api/library', { headers: { host: 'evil.example' } });
  assert.equal(host.status, 421, "DNS rebinding: only the machine's own names are served");
  assert.equal(host.json().error, 'unknown host');
  const csrf = await request('POST', '/api/folders', { body: { path: 'X' }, headers: { origin: 'https://evil.example' } });
  assert.equal(csrf.status, 403);
  assert.equal(csrf.json().error, 'bad origin');
  const sameOrigin = await request('POST', '/api/folders', { body: { path: 'X' }, headers: { origin: `http://127.0.0.1:${port}` } });
  assert.equal(sameOrigin.status, 200);
  const proxied = await request('GET', '/api/library', { headers: { 'x-forwarded-for': '203.0.113.9' } });
  assert.equal(proxied.status, 401, 'a request through a proxy or tunnel is remote: it signs in');
});

test('share links: a guest sees exactly one video and nothing else', async () => {
  const share = (await request('POST', `/api/review/${encodeURIComponent(slug)}/shares`, { body: { label: 'Client' } })).json();
  assert.match(share.token, /^[A-Za-z0-9_-]{24}$/);
  const remote = { 'x-forwarded-for': '203.0.113.9' };
  const g = await request('GET', `/api/g/${share.token}`, { headers: remote });
  assert.equal(g.status, 200, g.text);
  assert.equal(g.json().kind, 'video');
  assert.deepEqual(
    g.json().videos.map((v: { name: string }) => v.name),
    ['api.mp4'],
  );
  const reviewUrl = `/api/g/${share.token}/review/${encodeURIComponent(slug)}`;
  const gr = await request('GET', reviewUrl, { headers: remote });
  assert.equal(gr.json().name, 'api.mp4');
  assert.deepEqual(gr.json().notes, [], "the owner's internal notes are not shown to the client");
  const note = await request('POST', `/api/g/${share.token}/comments`, { body: { name: 'Mia', frame: 5, text: 'Bitte heller' }, headers: remote });
  assert.equal(note.status, 200, note.text);
  const notes = (await request('GET', reviewUrl, { headers: remote })).json().notes;
  assert.equal(notes.length, 1);
  assert.equal(notes[0].author, 'Mia');
  const shot = await request('GET', notes[0].marked, { headers: remote });
  assert.equal(shot.status, 200, 'their own marked frame is reachable');
  assert.ok(comment.shots);
  assert.equal((await request('GET', `/data/g/${share.token}/${comment.shots.marked}`, { headers: remote })).status, 404, 'other notes are not');
  assert.equal((await request('GET', `/data/g/${share.token}/review.json`, { headers: remote })).status, 404);
  assert.equal((await request('GET', `/api/review/${encodeURIComponent(slug)}`, { headers: remote })).status, 401, 'the token opens no owner routes');
  assert.equal((await request('GET', '/api/g/not-a-real-token-at-all-000', { headers: remote })).status, 404);
  assert.equal((await request('DELETE', `/api/shares/${share.token}`)).json().ok, true);
  assert.equal((await request('GET', `/api/g/${share.token}`, { headers: remote })).status, 404, 'revoked links stop working');
});

test('range notes: from a frame to a frame; a strip of frames for agents; past the end is refused, for clients too', async () => {
  const url = `/api/review/${encodeURIComponent(slug)}/comments`;
  // Written with the playhead outside its range (at 2): the note sits at the range's start.
  const r = await request('POST', url, { body: { v: 1, frame: 2, text: 'Musik zu laut', range: { in: 20, out: 10 } } });
  assert.equal(r.status, 200, r.text);
  const c: Comment = r.json();
  assert.deepEqual(c.range, { in: 10, out: 20 }, 'a backwards range is turned round');
  assert.equal(c.frame, 10, 'the note sits inside its range');
  assert.ok(c.shots?.range, 'a strip of frames across the range');
  assert.ok(fs.existsSync(path.join(dir, 'data', slug, c.shots.range as string)));
  const shown = await request('GET', `/data/${encodeURIComponent(slug)}/${c.shots.range}`);
  assert.equal(shown.status, 200, 'the strip is served like the screenshots');
  const past = await request('POST', url, { body: { v: 1, frame: 5, text: 'x', range: { in: 25, out: 400 } } });
  assert.equal(past.status, 400, 'a range past the end of the render is refused');
  assert.match(past.json().error, /ends after the last frame/);
  const one = (await request('POST', url, { body: { v: 1, frame: 7, text: 'nur hier', range: { in: 7, out: 7 } } })).json();
  assert.equal(one.shots.range, undefined, 'one frame needs no strip');

  const share = (await request('POST', `/api/review/${encodeURIComponent(slug)}/shares`, { body: { label: 'Client' } })).json();
  const remote = { 'x-forwarded-for': '203.0.113.9' };
  const note = await request('POST', `/api/g/${share.token}/comments`, {
    body: { name: 'Mia', frame: 12, text: 'Von hier bis da zu schnell', range: { in: 12, out: 18 } },
    headers: remote,
  });
  assert.equal(note.status, 200, note.text);
  const notes = (await request('GET', `/api/g/${share.token}/review/${encodeURIComponent(slug)}`, { headers: remote })).json().notes;
  const mine = notes.find((n: { id: string }) => n.id === note.json().id);
  assert.deepEqual(mine.range, { in: 12, out: 18 });
  assert.deepEqual(mine.rangeHere, { in: 12, out: 18 });
  const bad = await request('POST', `/api/g/${share.token}/comments`, {
    body: { name: 'Mia', frame: 3, text: 'x', range: { in: 3, out: 99 } },
    headers: remote,
  });
  assert.equal(bad.status, 400, "a client's range past the end is refused too");
  await request('DELETE', `/api/shares/${share.token}`);
});

test('voice: a browser recording (WebM/Opus) is kept; empty or non-audio bodies are refused', async () => {
  assert.equal((await request('POST', '/api/voice', { body: '', headers: { 'content-type': 'audio/webm' } })).status, 400);
  const webm = path.join(dir, 'note.webm');
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=1', '-c:a', 'libopus', '-y', webm]);
  const r = await request('POST', '/api/voice', { body: fs.readFileSync(webm), headers: { 'content-type': 'audio/webm' } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json().transcript, null, 'speech-to-text is off in tests');
  assert.equal(r.json().whisper, false);
  assert.ok(fs.existsSync(path.join(dir, 'cache/voice', `${r.json().id}.m4a`)), 'kept for playback');
  const text = await request('POST', '/api/voice', { body: Buffer.from('{"not":"audio"}'), headers: { 'content-type': 'audio/webm' } });
  assert.equal(text.status, 400);
});

test('machine endpoints never fall back to the web page', async () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>app</title>');
  const { staticUi } = await import('../../server/app.ts');
  const app = express();
  staticUi(dist)(app);
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const at = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    for (const url of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/oauth/authorize', '/mcp'])
      assert.equal((await fetch(at + url)).status, 404, url);
    const page = await fetch(`${at}/some/page`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') || '', /text\/html/, 'client-side routes still get the app');
  } finally {
    srv.close();
    fs.rmSync(dist, { recursive: true, force: true });
  }
});
