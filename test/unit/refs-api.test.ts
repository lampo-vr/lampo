// References on notes over HTTP on a hosted server: with a new note (links, moments, "about the whole video"), images
// inline and clips through a one-time upload URL, served (ranged), captions and removal by who may, the roles, and
// what a review link shows: its own videos only, never agents' references, never the owner's slugs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { FFMPEG, isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');

const ffmpeg = (...args: string[]) => execFileSync(FFMPEG, ['-v', 'error', ...args, '-y']);
const spot = makeVideo(path.join(dir, 'renders/spot.mp4'), { w: 320, h: 180, fps: 25, dur: 2, pattern: 'testsrc2' });
const other = makeVideo(path.join(dir, 'renders/other.mp4'), { w: 320, h: 180, fps: 25, dur: 2, freq: 660 });
const secret = makeVideo(path.join(dir, 'renders/secret.mp4'), { w: 320, h: 180, fps: 25, dur: 2, freq: 330 });
const png = path.join(dir, 'ref.png');
ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=400x300', '-frames:v', '1', png);
const clip = path.join(dir, 'ref.mov');
ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=2', '-c:v', 'mpeg4', clip);

const { request, base } = await startApp();
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

const slugs: Record<string, string> = {};
const e = encodeURIComponent;
let noteId = '';

test('a note with a link, a moment of another video and "about the whole video"', async () => {
  for (const [name, file, folder] of [
    ['spot', spot, 'Acme'],
    ['other', other, 'Acme'],
    ['secret', secret, 'Rival'],
  ] as const) {
    const up = await tusUpload(request, file, { filename: `${name}.mp4`, folder }, owner);
    assert.equal(up.status, 200, up.text);
    slugs[name] = up.json().slug;
  }
  const body = {
    scope: 'video',
    text: 'Insgesamt zu hektisch',
    refs: [
      { kind: 'link', url: 'https://www.example.com/pacing', caption: 'So ruhig' },
      { kind: 'frame', video: slugs.other, frame: 12, to_frame: 20, caption: 'Wie hier' },
    ],
  };
  const c = await request('POST', `/api/review/${e(slugs.spot)}/comments`, { body, headers: owner });
  assert.equal(c.status, 200, c.text);
  const note = c.json();
  noteId = note.id;
  assert.equal(note.scope, 'video');
  assert.equal(note.frame, 0);
  assert.equal(note.shots, null, 'no screenshots of frame 0 for a note about the whole video');
  assert.deepEqual(
    note.refs.map((r: { kind: string }) => r.kind),
    ['link', 'frame'],
  );
  const frame = note.refs[1];
  const still = await fetch(`${base}/api/refs/${e(slugs.spot)}/${frame.still}`, { headers: owner });
  assert.equal(still.status, 200);
  assert.equal(still.headers.get('content-type'), 'image/jpeg');
  const bad = await request('POST', `/api/review/${e(slugs.spot)}/comments`, {
    body: { text: 'x', refs: [{ kind: 'link', url: 'javascript:alert(1)' }] },
    headers: owner,
  });
  assert.equal(bad.status, 422);
  const nowhere = await request('POST', `/api/review/${e(slugs.spot)}/comments`, {
    body: { text: 'x', refs: [{ kind: 'frame', video: 'nope', frame: 1 }] },
    headers: owner,
  });
  assert.equal(nowhere.status, 422);
});

test('an image inline, a clip through a one-time URL (one PUT), served ranged; captions and removal', async () => {
  const img = await request('POST', `/api/comments/${noteId}/refs`, {
    body: { kind: 'image', caption: 'Farbe', data: fs.readFileSync(png).toString('base64') },
    headers: owner,
  });
  assert.equal(img.status, 200, img.text);
  const image = img.json().ref;
  assert.equal(image.kind, 'image');
  const served = await fetch(`${base}/api/refs/${e(slugs.spot)}/${image.file}`, { headers: owner });
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${base}/api/refs/${e(slugs.spot)}/r_0000000000.png`, { headers: owner })).status, 404);
  assert.equal((await fetch(`${base}/api/refs/${e(slugs.spot)}/${image.file}`)).status, 401, 'signed out: nothing');

  const ticket = await request('POST', `/api/comments/${noteId}/refs`, { body: { kind: 'file', caption: 'Bewegung' }, headers: owner });
  assert.equal(ticket.status, 200, ticket.text);
  const url = String(ticket.json().upload.url).replace(PUBLIC, base);
  const bytes = fs.readFileSync(clip);
  const put = await fetch(url, { method: 'PUT', body: bytes, headers: { 'content-length': String(bytes.length) } });
  assert.equal(put.status, 200, await put.clone().text());
  const moving = ((await put.json()) as { ref: { kind: string; file: string; id: string } }).ref;
  assert.equal(moving.kind, 'clip');
  const ranged = await fetch(`${base}/api/refs/${e(slugs.spot)}/${moving.file}`, { headers: { ...owner, Range: 'bytes=0-99' } });
  assert.equal(ranged.status, 206);

  assert.equal((await request('PATCH', `/api/comments/${noteId}/refs/${image.id}`, { body: { caption: 'Wärmer' }, headers: owner })).status, 200);
  const hostile = await request('POST', `/api/comments/${noteId}/refs`, {
    body: { kind: 'image', data: Buffer.from('#EXTM3U\n').toString('base64') },
    headers: owner,
  });
  assert.equal(hostile.status, 422);
  assert.equal((await request('DELETE', `/api/comments/${noteId}/refs/${moving.id}`, { headers: owner })).status, 200);
  const after = (await request('GET', `/api/review/${e(slugs.spot)}`, { headers: owner })).json();
  const refs = after.review.comments.find((c: { id: string }) => c.id === noteId).refs;
  assert.deepEqual(
    refs.map((r: { kind: string; caption?: string }) => `${r.kind}:${r.caption}`),
    ['link:So ruhig', 'frame:Wie hier', 'image:Wärmer'],
  );
});

test('roles: a reviewer adds references with a reply, not to someone else’s note; removes only their own', async () => {
  const direct = await request('POST', `/api/comments/${noteId}/refs`, { body: { kind: 'link', url: 'https://example.com/a' }, headers: reviewer });
  assert.equal(direct.status, 403);
  const replied = await request('POST', `/api/comments/${noteId}/refs`, {
    body: { kind: 'link', url: 'https://example.com/a', note: 'So meine ich das' },
    headers: reviewer,
  });
  assert.equal(replied.status, 200, replied.text);
  const theirs = replied.json().ref;
  const note = (await request('GET', `/api/review/${e(slugs.spot)}`, { headers: owner })).json().review.comments.find((c: { id: string }) => c.id === noteId);
  assert.deepEqual(note.replies.at(-1).refs, [theirs.id]);
  const olivias = note.refs[0].id;
  assert.equal((await request('DELETE', `/api/comments/${noteId}/refs/${olivias}`, { headers: reviewer })).status, 403);
  assert.equal((await request('DELETE', `/api/comments/${noteId}/refs/${theirs.id}`, { headers: reviewer })).status, 200);
  const full = await request('POST', `/api/comments/${noteId}/refs`, { body: { kind: 'link', url: 'https://example.com/b', note: 'x' }, headers: owner });
  assert.equal(full.status, 200);
  for (let i = 0; i < 8; i++)
    await request('POST', `/api/comments/${noteId}/refs`, { body: { kind: 'link', url: `https://example.com/${i}` }, headers: owner });
  const over = await request('POST', `/api/comments/${noteId}/refs`, { body: { kind: 'file' }, headers: owner });
  assert.equal(over.status, 422, 'at most 8');
});

test('a review link: its videos only, no agents’ references, no owner slugs; clients add and remove their own', async () => {
  // A note on spot with a moment of the uncovered video and an agent's image: both stay internal.
  const c = await request('POST', `/api/review/${e(slugs.spot)}/comments`, {
    body: { frame: 5, text: 'Intern', refs: [{ kind: 'frame', video: slugs.secret, frame: 3 }] },
    headers: owner,
  });
  const internal = c.json();
  await request('POST', `/api/comments/${internal.id}/refs`, {
    body: { kind: 'image', note: 'agent pic', by: 'agent:edit', data: fs.readFileSync(png).toString('base64') },
    headers: owner,
  });
  const link = (await request('POST', '/api/folder-shares', { body: { folder: 'Acme', notes: 'all', label: 'Acme' }, headers: ownerApp })).json();
  const token = link.token;
  const g = (p: string) => `/api/g/${token}${p}`;
  const room = (await request('GET', g(''))).json();
  assert.equal(room.reviewer, 'Olivia', 'on a hosted server the sharer is an account: the name they chose is shown');
  const spotId = room.videos.find((v: { name: string }) => v.name === 'spot.mp4').slug;
  const otherId = room.videos.find((v: { name: string }) => v.name === 'other.mp4').slug;

  const made = await request('POST', g('/comments'), {
    body: { name: 'Mia', slug: spotId, frame: 8, text: 'Wie im anderen Film', refs: [{ kind: 'frame', video: otherId, frame: 4, caption: 'hier' }] },
  });
  assert.equal(made.status, 200, made.text);
  const mine = made.json().id;
  const outside = await request('POST', g('/comments'), {
    body: { name: 'Mia', slug: spotId, frame: 8, text: 'x', refs: [{ kind: 'frame', video: slugs.secret, frame: 1 }] },
  });
  assert.equal(outside.status, 404, 'a video the link does not cover (and never by the owner’s slug)');
  const pic = await request('POST', g(`/comments/${mine}/refs`), {
    body: { name: 'Mia', kind: 'image', caption: 'Farbe so', data: fs.readFileSync(png).toString('base64') },
  });
  assert.equal(pic.status, 200, pic.text);
  const onTheirs = await request('POST', g(`/comments/${noteId}/refs`), { body: { name: 'Mia', kind: 'link', url: 'https://example.com/c' } });
  assert.equal(onTheirs.status, 404, 'internal notes are not reachable through the link');

  const review = await request('GET', g(`/review/${spotId}`));
  assert.equal(review.status, 200);
  const text = review.text;
  for (const s of Object.values(slugs)) assert.ok(!text.includes(s), 'no owner slug in what the client sees');
  assert.ok(!text.includes(dir), 'no server path');
  const notes = review.json().notes;
  const client = notes.find((n: { id: string }) => n.id === mine);
  assert.deepEqual(
    client.refs.map((r: { kind: string; video: string | null; mine: boolean }) => [r.kind, r.video, r.mine]),
    [
      ['frame', otherId, true],
      ['image', null, true],
    ],
  );
  const served = await fetch(`${base}${client.refs[1].src}`);
  assert.equal(served.status, 200);
  const stillOfOther = await fetch(`${base}${client.refs[0].still}`);
  assert.equal(stillOfOther.status, 200);
  const team = await request('DELETE', g(`/comments/${mine}/refs/${client.refs[0].id}`));
  assert.equal(team.status, 200, 'their own reference');
  // The internal note's refs (the uncovered video's still, the agent's image) are not served through the link.
  const hit = (await request('GET', `/api/review/${e(slugs.spot)}`, { headers: owner }))
    .json()
    .review.comments.find((x: { id: string }) => x.id === internal.id);
  for (const r of hit.refs) assert.equal((await fetch(`${base}${g(`/refs/${spotId}/${r.still}`)}`)).status, 404, r.kind);
});

test('what a client gets back for a reference is what the link shows: never the note, its agent replies or the owner’s slugs', async () => {
  const link = (await request('POST', '/api/folder-shares', { body: { folder: 'Acme', notes: 'all', label: 'Acme answers' }, headers: ownerApp })).json();
  const g = (p: string) => `/api/g/${link.token}${p}`;
  const room = (await request('GET', g(''))).json();
  const spotId = room.videos.find((v: { name: string }) => v.name === 'spot.mp4').slug;
  const otherId = room.videos.find((v: { name: string }) => v.name === 'other.mp4').slug;
  const made = await request('POST', g('/comments'), { body: { name: 'Mia', slug: spotId, frame: 3, text: 'Heller?' } });
  assert.equal(made.status, 200, made.text);
  const id = made.json().id;
  // The editor's agent asks the team something on the client's note: internal, never shown on the link.
  const asked = await request('PATCH', `/api/comments/${id}`, { body: { note: 'INTERNAL: budget is tight', by: 'agent:edit' }, headers: owner });
  assert.equal(asked.status, 200, asked.text);
  const leaks = (what: string, text: string) => {
    assert.ok(!text.includes('INTERNAL'), `${what}: no agent reply`);
    assert.ok(!text.includes('"comment"'), `${what}: not the note`);
    for (const s of Object.values(slugs)) assert.ok(!text.includes(s), `${what}: no owner slug`);
    assert.ok(!text.includes(dir), `${what}: no server path`);
  };

  const moment = await request('POST', g(`/comments/${id}/refs`), { body: { name: 'Mia', kind: 'frame', video: otherId, frame: 4 } });
  assert.equal(moment.status, 200, moment.text);
  leaks('a moment', moment.text);
  assert.equal(moment.json().ref.video, otherId, 'the moment names the video by the link’s id');
  const url = await request('POST', g(`/comments/${id}/refs`), { body: { name: 'Mia', kind: 'link', url: 'https://example.com/look' } });
  assert.equal(url.status, 200, url.text);
  leaks('a link', url.text);

  const ticket = await request('POST', g(`/comments/${id}/refs`), { body: { name: 'Mia', kind: 'file', caption: 'So' } });
  assert.equal(ticket.status, 200, ticket.text);
  const put = new URL(ticket.json().upload.url).pathname;
  const bytes = fs.readFileSync(png);
  const upload = { body: bytes, headers: { 'content-length': String(bytes.length) } };
  const sent = await request('PUT', put, upload);
  assert.equal(sent.status, 200, sent.text);
  leaks('an uploaded file', sent.text);
  assert.equal(sent.json().ref.kind, 'image');
  assert.ok(sent.json().ref.src.startsWith(`/api/g/${link.token}/refs/`), 'served through the link');
  const again = await request('GET', put);
  assert.equal(again.status, 200);
  leaks('the upload URL read again', again.text);

  // An upload URL handed out before the link was revoked takes nothing afterwards.
  const late = (await request('POST', g(`/comments/${id}/refs`), { body: { name: 'Mia', kind: 'file' } })).json().upload.url;
  assert.equal((await request('DELETE', `/api/shares/${link.token}`, { headers: ownerApp })).status, 200);
  const refused = await request('PUT', new URL(late).pathname, upload);
  assert.equal(refused.status, 410, refused.text);
});
