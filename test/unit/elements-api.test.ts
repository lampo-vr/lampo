// Elements maps over HTTP on a hosted server: `PUT /api/review/:slug/versions/:v/elements` takes a map from whoever may
// upload (an agent's API token too; reviewers and nobody not), refuses a bad or oversized one whole and keeps what was
// there, and `GET /api/review/:slug/elements` says what the notes point at. Two workspaces holding the same video keep
// their maps apart: each reads its own, and neither writes into the other's.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { SCENE_MAP } from '../lib/elements.ts';
import { age, isolatedEnv, makeVideo, must } from '../lib/helpers.ts';

const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: 'http://review.test' } });
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const store = await import('../../lib/store.ts');
const paths = await import('../../lib/paths.ts');
const { inWorkspace } = await import('../../lib/scope.ts');
const { renderKey } = await import('../../lib/renderKey.ts');

const { request } = await startApp();
const film = makeVideo(path.join(dir, 'proj/export/launch.mp4'), { w: 640, h: 360, fps: 30, dur: 4 });
const alone = makeVideo(path.join(dir, 'proj/export/alpha-only.mp4'), { w: 640, h: 360, fps: 30, dur: 1, pattern: 'testsrc2' });
age(film);
age(alone);
const slug = paths.slugify(film);
const aloneSlug = paths.slugify(alone);
const url = (s = slug, v: number | string = 1) => `/api/review/${encodeURIComponent(s)}/versions/${v}/elements`;
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const as: Record<string, Record<string, string>> = {};
let bravo = '';

before(async () => {
  const olivia = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
  const mike = await auth.createUser({ email: 'mike@example.com', name: 'Mike', password: 'a long password', role: 'member' });
  const rita = await auth.createUser({ email: 'rita@example.com', name: 'Rita', password: 'a long password', role: 'reviewer' });
  const bob = await auth.createUser({ email: 'bob@example.com', name: 'Bob', password: 'a long password', role: 'member' });
  bravo = ws.createWorkspace({ name: 'Bravo', ownerId: bob.id }).id;
  as.owner = bearer(auth.createToken(olivia.id, 'owner').token);
  as.agent = bearer(auth.createToken(mike.id, 'scene agent').token);
  as.reviewer = bearer(auth.createToken(rita.id, 'reviewer').token);
  as.bob = bearer(auth.createToken(bob.id, 'bob', { workspace: bravo }).token);
  // the same film in both workspaces (the same slug), one more only in workspace #1
  for (const w of ['w1', bravo])
    inWorkspace(w, () => {
      store.createOrGetReview(film, { by: 'tester' });
      store.addComment(slug, { frame: 30, text: `${w} price`, author: 'Rita', drawing: [{ type: 'box', x: 230, y: 127, w: 97, h: 57 }] });
    });
  inWorkspace('w1', () => store.createOrGetReview(alone, { by: 'tester' }));
});

const fileIn = (w: string, s = slug) =>
  inWorkspace(w, () => path.join(paths.reviewDir(s), 'elements', `${renderKey(must(must(store.loadReview(s)).versions[0]))}.json`));

test('whoever may upload attaches a map — an agent’s API token too; a reviewer and nobody may not', async () => {
  const r = await request('PUT', url(), { body: SCENE_MAP, headers: as.agent });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json(), { v: 1, elements: 7, keys: 17, scaled_from: [1920, 1080] });
  assert.equal(JSON.parse(fs.readFileSync(fileIn('w1'), 'utf8')).elements.length, 7);
  assert.equal((await request('PUT', url(), { body: SCENE_MAP, headers: as.owner })).status, 200);
  const reviewer = await request('PUT', url(), { body: SCENE_MAP, headers: as.reviewer });
  assert.equal(reviewer.status, 403, reviewer.text);
  assert.equal((await request('PUT', url(), { body: SCENE_MAP })).status, 401);
  assert.equal((await request('PUT', url(slug, 9), { body: SCENE_MAP, headers: as.agent })).status, 404);
  assert.equal((await request('PUT', url('no-such-video'), { body: SCENE_MAP, headers: as.agent })).status, 404);
});

test('a bad map is refused whole with what is wrong; an oversized one too; the map in place stays', async () => {
  const before = fs.readFileSync(fileIn('w1'));
  const dup = await request('PUT', url(), { body: { ...SCENE_MAP, elements: [SCENE_MAP.elements[1], SCENE_MAP.elements[1]] }, headers: as.agent });
  assert.equal(dup.status, 400);
  assert.equal(dup.json().error, 'the elements map is refused: elements.1.id: "title" is used twice: ids are unique');
  const fps = await request('PUT', url(), { body: { ...SCENE_MAP, fps: 25 }, headers: as.agent });
  assert.equal(fps.status, 400);
  assert.match(fps.json().error, /it is at 25 fps, v1 at 30/);
  const v2 = await request('PUT', url(), { body: { ...SCENE_MAP, v: 2 }, headers: as.agent });
  assert.equal(v2.status, 400);
  const notJson = await request('PUT', url(), { body: '{"v":1,', headers: { ...as.agent, 'content-type': 'application/json' } });
  assert.equal(notJson.status, 400);
  const big = { ...SCENE_MAP, padding: 'x'.repeat(1024 * 1024) };
  assert.equal((await request('PUT', url(), { body: big, headers: as.agent })).status, 413);
  assert.ok(fs.readFileSync(fileIn('w1')).equals(before), 'unchanged');
});

test('GET …/elements: what each note points at, and the names of those elements', async () => {
  const r = await request('GET', `/api/review/${encodeURIComponent(slug)}/elements`, { headers: as.reviewer });
  assert.equal(r.status, 200, r.text);
  const id = must(must(inWorkspace('w1', () => store.loadReview(slug))).comments[0]).id;
  assert.deepEqual(r.json(), { notes: { [id]: { elements: ['card'] } }, names: { card: 'Price card' } });
});

test('two workspaces with the same video keep their maps apart: each reads and writes its own', async () => {
  // Bravo's video has no map yet: Bob reads nothing of workspace #1's
  const empty = await request('GET', `/api/review/${encodeURIComponent(slug)}/elements`, { headers: as.bob });
  assert.equal(empty.status, 200, empty.text);
  assert.deepEqual(empty.json(), { notes: {}, names: {} });
  // Bob's own map lands in Bravo's tree; workspace #1's is the same as before
  const before = fs.readFileSync(fileIn('w1'));
  const bravoMap = { ...SCENE_MAP, elements: SCENE_MAP.elements.map((e) => (e.id === 'card' ? { ...e, id: 'bravoCard', name: 'BRAVO card' } : e)) };
  assert.equal((await request('PUT', url(), { body: bravoMap, headers: as.bob })).status, 200);
  assert.ok(fs.existsSync(fileIn(bravo)));
  assert.ok(fileIn(bravo).startsWith(paths.workspaceRoot(bravo).data));
  assert.ok(fs.readFileSync(fileIn('w1')).equals(before), 'workspace #1’s map is untouched');
  const inBravo = (await request('GET', `/api/review/${encodeURIComponent(slug)}/elements`, { headers: as.bob })).json();
  assert.deepEqual(Object.values(inBravo.notes), [{ elements: ['bravoCard'] }]);
  const inAlpha = await request('GET', `/api/review/${encodeURIComponent(slug)}/elements`, { headers: as.owner });
  assert.doesNotMatch(inAlpha.text, /bravo/i);
  // a video only workspace #1 holds is no video at all to Bravo, and nothing is written for it
  assert.equal((await request('PUT', url(aloneSlug), { body: SCENE_MAP, headers: as.bob })).status, 404);
  assert.equal((await request('GET', `/api/review/${encodeURIComponent(aloneSlug)}/elements`, { headers: as.bob })).status, 404);
  assert.equal(fs.existsSync(path.join(paths.workspaceRoot(bravo).data, aloneSlug, 'elements')), false);
  assert.equal(fs.existsSync(path.join(paths.workspaceRoot('w1').data, aloneSlug, 'elements')), false);
});
