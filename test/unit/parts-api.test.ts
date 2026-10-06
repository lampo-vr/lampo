// Partial renders over HTTP on a hosted server: the stretch the player suggests (snapped to the render's shots), a
// note and a request that allow one, the part arriving by tus and by a one-time upload URL (409 where nobody allowed
// it or its length changed), playing as the whole video, and refused as final.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { before, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { cutFrames, fixBox, isolatedEnv, makeShotsVideo, sleep } from '../lib/helpers.ts';
import { cookieFrom, tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');
const store = await import('../../lib/store.ts');

const base = makeShotsVideo(path.join(dir, 'renders/spot.mp4'));
const fixed = makeShotsVideo(path.join(dir, 'renders/spot-fixed.mp4'), { extra: fixBox(40, 79) });

const { server, request } = await startApp();
let owner: Record<string, string> = {};
let reviewer: Record<string, string> = {};
before(async () => {
  const o = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
  const r = await auth.createUser({ email: 'rita@example.com', name: 'Rita', password: 'a long password', role: 'reviewer' });
  owner = { Authorization: `Bearer ${auth.createToken(o.id, 'test').token}` };
  reviewer = { Authorization: `Bearer ${auth.createToken(r.id, 'test').token}` };
});

let slug = '';
const s = () => encodeURIComponent(slug);

test('the player asks which stretch a part would be: the shots around the frame', async () => {
  const up = await tusUpload(request, base, { filename: 'spot.mp4', folder: 'Acme' }, owner);
  assert.equal(up.status, 200, up.text);
  slug = up.json().slug;
  let r = await request('GET', `/api/review/${s()}/part?v=1&in=50`, { headers: reviewer });
  for (let i = 0; i < 100 && r.json().pending; i++) {
    await sleep(100);
    r = await request('GET', `/api/review/${s()}/part?v=1&in=50`, { headers: reviewer });
  }
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json(), { v: 1, part: { in: 40, out: 79, shot: 2, to_shot: 2, handles: 12 }, whole: false, shots: 3 });
  // a range across the cut takes both shots
  const both = await request('GET', `/api/review/${s()}/part?v=1&in=70&out=90`, { headers: reviewer });
  assert.deepEqual(both.json().part, { in: 40, out: 119, shot: 2, to_shot: 3, handles: 12 });
  assert.equal((await request('GET', `/api/review/${s()}/part?v=1`, { headers: reviewer })).status, 400, 'a frame is needed');
});

test('a note and a request allow a part; agents read one line', async () => {
  // what the player sends is snapped to the shots again on the server
  const c = await request('POST', `/api/review/${s()}/comments`, {
    body: { frame: 50, text: 'Logo missing', part: { in: 45, out: 60 } },
    headers: reviewer,
  });
  assert.equal(c.status, 200, c.text);
  assert.deepEqual(c.json().part, { in: 40, out: 79, shot: 2, to_shot: 2, handles: 12 });
  const bad = await request('POST', `/api/review/${s()}/comments`, { body: { frame: 50, text: 'x', part: { in: -1, out: 3 } }, headers: reviewer });
  assert.equal(bad.status, 400);
  const req = await request('POST', `/api/review/${s()}/request`, {
    body: { text: 'Quick check: render only this part', part: { in: 90, out: 90 } },
    headers: owner,
  });
  assert.equal(req.status, 200, req.text);
  const ev = store.readEvents().findLast((e) => e.type === 'request');
  assert.equal(ev?.text, 'Quick check: render only this part · PART RENDER OK: frames 80–119 (shot 3), handles 12');
  assert.deepEqual(ev?.part, { in: 80, out: 119, shot: 3, to_shot: 3, handles: 12 });
});

test('a part nobody allowed, or one that changed its length, is refused with 409', async () => {
  const at0 = cutFrames(fixed, 0, 52, path.join(dir, 'parts/at0.mp4'));
  const r0 = await tusUpload(request, at0, { filename: 'part.mp4', slug, part_at: '0' }, owner);
  assert.equal(r0.status, 409, r0.text);
  assert.match(r0.text, /no note allows a part render at frame 0 of v1/);
  const longer = cutFrames(fixed, 28, 97, path.join(dir, 'parts/longer.mp4'));
  const rl = await tusUpload(request, longer, { filename: 'part.mp4', slug, part_at: '40' }, owner);
  assert.equal(rl.status, 409, rl.text);
  assert.match(rl.text, /the length changed/);
  // through a one-time upload URL the same
  const t = await request('POST', '/api/uploads/tickets', { body: { filename: 'part.mp4', slug, part_at: 40 }, headers: owner });
  assert.equal(t.status, 200, t.text);
  const put = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${new URL(t.json().url).pathname}`, {
    method: 'PUT',
    body: fs.readFileSync(longer),
  });
  assert.equal(put.status, 409);
  // a part without its video is refused before any byte
  const nowhere = await request('POST', '/api/uploads/tickets', { body: { filename: 'part.mp4', part_at: 40 }, headers: owner });
  assert.equal(nowhere.status, 400);
  assert.equal(store.loadReview(slug)?.versions.length, 1);
});

test('the part arrives, plays as the whole video, and is never final', async () => {
  const p = cutFrames(fixed, 28, 92, path.join(dir, 'parts/fixed.mp4'));
  const up = await tusUpload(request, p, { filename: 'part.mp4', slug, part_at: '40', handles: '12' }, owner);
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json().v, 2);
  assert.deepEqual(up.json().part, { of: 1, at: 40, frames: 40, handles: 12, seam: 'clean' });
  // the player waits for the whole video (made in the scrub copy's place), then plays it: a background job, so up to a
  // minute on a loaded machine
  let media = (await request('GET', `/api/review/${s()}`, { headers: reviewer })).json().media[2];
  for (let i = 0; i < 600 && !media.ready; i++) {
    await sleep(100);
    media = (await request('GET', `/api/review/${s()}`, { headers: reviewer })).json().media[2];
  }
  assert.ok(media.ready, JSON.stringify(media));
  assert.match(media.url, /\/media\/.+\/v2\?h=\w+&s=1$/);
  const bytes = await request('GET', media.url, { headers: { ...reviewer, Range: 'bytes=0-99' } });
  assert.equal(bytes.status, 206);
  const review = (await request('GET', `/api/review/${s()}`, { headers: reviewer })).json();
  // the note it fixes is still open: the person looks at V2 next
  assert.equal(review.summary.stage.detail, '1 note open on V2 (part)');
  assert.deepEqual(review.summary.stage.part, { of: 1, at: 40, frames: 40 });
  // the inbox lists it as the new version it is, a part (the carried note asks to be checked again on it)
  const fy = await request('GET', '/api/for-you', { headers: await cookieOwner() });
  const item = fy.json().items.find((i: { slug: string; v?: number }) => i.slug === slug && i.v === 2);
  assert.equal(item?.kind, 'version', fy.text);
  assert.equal(item?.part, true);
  // the team may approve it, but it can't ship
  assert.equal((await request('PUT', `/api/review/${s()}/approval`, { body: { status: 'approved' }, headers: await cookieOwner() })).status, 200);
  const fin = await request('PUT', `/api/review/${s()}/final`, { body: { confirm: true }, headers: await cookieOwner() });
  assert.equal(fin.status, 409);
  assert.match(fin.json().error, /^V2 is a part \(frames 40–79 rendered into V1\): only a full render can be final/);
});

// Sign-off is people's (an API token can't approve or mark final): a signed-in owner's session.
let ownerCookie: Record<string, string> | null = null;
async function cookieOwner(): Promise<Record<string, string>> {
  if (ownerCookie) return ownerCookie;
  const r = await request('POST', '/api/auth/login', { body: { email: 'olivia@example.com', password: 'a long password' }, headers: { Origin: PUBLIC } });
  assert.equal(r.status, 200, r.text);
  ownerCookie = { Cookie: cookieFrom(r), Origin: PUBLIC };
  return ownerCookie;
}
