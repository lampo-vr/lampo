// Drafts on a hosted server, where several people review: a draft is its author's alone. Another member, a reviewer
// and the author's own API token (what an agent or a script holds: it acts for the person, so it must not read what
// they haven't sent) never see, change or send it — misses look like "no such draft". Reviewers keep drafts too (it
// is their `comment` right), and on a hosted server nothing starts an agent, so a send that asks to is refused before
// anything is sent.
import assert from 'node:assert/strict';
import path from 'node:path';
import { before, test } from 'node:test';
import type { Comment } from '../../lib/types.ts';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { cookieFrom, tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');
const store = await import('../../lib/store.ts');

const spot = makeVideo(path.join(dir, 'renders/spot.mp4'), { w: 160, h: 90, fps: 25, dur: 1 });
const { request } = await startApp({ headers: { Connection: 'close' } });
const as: Record<'olivia' | 'max' | 'rita' | 'token', Record<string, string>> = { olivia: {}, max: {}, rita: {}, token: {} };
let slug = '';
before(async () => {
  const people = [
    ['olivia', 'owner'],
    ['max', 'member'],
    ['rita', 'reviewer'],
  ] as const;
  for (const [name, role] of people) {
    const u = await auth.createUser({ email: `${name}@example.com`, name: name[0].toUpperCase() + name.slice(1), password: `${name}s password 1`, role });
    const login = await request('POST', '/api/auth/login', {
      body: { email: `${name}@example.com`, password: `${name}s password 1` },
      headers: { Origin: PUBLIC },
    });
    assert.equal(login.status, 200, login.text);
    as[name] = { Cookie: cookieFrom(login), Origin: PUBLIC };
    if (name === 'olivia') as.token = { Authorization: `Bearer ${auth.createToken(u.id, 'agent').token}` };
  }
  const up = await tusUpload(request, spot, { filename: 'spot.mp4', folder: 'Acme' }, as.token);
  assert.equal(up.status, 200, up.text);
  slug = encodeURIComponent(up.json().slug);
});

let draft: Comment;

test('only its author sees a draft; to everyone else it doesn’t exist', async () => {
  const made = await request('POST', `/api/review/${slug}/drafts`, { body: { frame: 4, text: 'draftmark Olivia’s', severity: 'must' }, headers: as.olivia });
  assert.equal(made.status, 200, made.text);
  draft = made.json();
  assert.equal(draft.draft, true);
  assert.equal(draft.author, 'Olivia');
  const list = (who: Record<string, string>) => request('GET', `/api/review/${slug}/drafts`, { headers: who });
  assert.equal((await list(as.olivia)).json().drafts.length, 1);
  for (const who of [as.max, as.rita]) {
    assert.deepEqual((await list(who)).json().drafts, []);
    assert.equal((await request('PATCH', `/api/review/${slug}/drafts/${draft.id}`, { body: { text: 'mine now' }, headers: who })).status, 404);
    assert.equal((await request('DELETE', `/api/review/${slug}/drafts/${draft.id}`, { headers: who })).status, 404);
    assert.equal((await request('GET', `/api/review/${slug}/drafts/${draft.id}/${draft.shots?.marked}`, { headers: who })).status, 404);
    assert.deepEqual((await request('GET', '/api/drafts', { headers: who })).json().videos, {});
    // Sending sends your own drafts only: none here.
    const sent = await request('POST', `/api/review/${slug}/drafts/send`, { body: {}, headers: who });
    assert.equal(sent.status, 200, sent.text);
    assert.deepEqual(sent.json().notes, []);
    // And nothing of it in what they read.
    for (const url of [`/api/review/${slug}`, '/api/library', '/api/for-you', '/api/inbox?all=1', '/api/inbox.md'])
      assert.doesNotMatch((await request('GET', url, { headers: who })).text, /draftmark/, url);
  }
  assert.equal((await list(as.olivia)).json().drafts.length, 1, 'still there');
  assert.deepEqual((await request('GET', '/api/drafts', { headers: as.olivia })).json().videos, { [decodeURIComponent(slug)]: 1 });
});

test('an API token — even the author’s own — never reads, changes or sends a draft', async () => {
  for (const [method, url, body] of [
    ['GET', '/api/drafts', undefined],
    ['GET', `/api/review/${slug}/drafts`, undefined],
    ['POST', `/api/review/${slug}/drafts`, { frame: 1, text: 'x' }],
    ['PATCH', `/api/review/${slug}/drafts/${draft.id}`, { text: 'x' }],
    ['DELETE', `/api/review/${slug}/drafts/${draft.id}`, undefined],
    ['GET', `/api/review/${slug}/drafts/${draft.id}/${draft.shots?.marked}`, undefined],
    ['POST', `/api/review/${slug}/drafts/${draft.id}/refs`, { kind: 'link', url: 'https://example.com' }],
    ['POST', `/api/review/${slug}/drafts/send`, {}],
  ] as const) {
    const r = await request(method, url, { body, headers: as.token });
    assert.equal(r.status, 403, `${method} ${url} with a token: ${r.status} ${r.text}`);
  }
  for (const url of [`/api/review/${slug}`, '/api/reviews', `/api/comments/${draft.id}`, `/api/review/${slug}/md`, '/api/inbox.md'])
    assert.doesNotMatch((await request('GET', url, { headers: as.token })).text, /draftmark/, url);
  assert.equal((await request('GET', `/api/comments/${draft.id}`, { headers: as.token })).status, 404);
});

test('a reviewer keeps drafts and sends them like anyone who comments', async () => {
  const made = await request('POST', `/api/review/${slug}/drafts`, { body: { frame: 2, text: 'draftmark Rita’s' }, headers: as.rita });
  assert.equal(made.status, 200, made.text);
  const starting = await request('POST', `/api/review/${slug}/drafts/send`, { body: { start: true }, headers: as.rita });
  assert.equal(starting.status, 403, 'starting an agent is not a reviewer’s');
  assert.match(starting.json().error, /can't start agents/);
  const sent = await request('POST', `/api/review/${slug}/drafts/send`, { body: {}, headers: as.rita });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.json().notes[0].author, 'Rita');
  assert.equal((await request('GET', `/api/review/${slug}/drafts`, { headers: as.olivia })).json().drafts.length, 1, 'Olivia’s draft stays hers');
});

test('on a hosted server a send that would start the agent is refused before anything is sent', async () => {
  const before = store.readEvents({ limit: 5000 }).length;
  const r = await request('POST', `/api/review/${slug}/drafts/send`, { body: { start: true }, headers: as.olivia });
  assert.equal(r.status, 403, r.text);
  assert.equal((await request('GET', `/api/review/${slug}/drafts`, { headers: as.olivia })).json().drafts.length, 1, 'the draft is still a draft');
  assert.equal(store.readEvents({ limit: 5000 }).length, before, 'no event');
  const sent = await request('POST', `/api/review/${slug}/drafts/send`, { body: { ids: [draft.id] }, headers: as.olivia });
  assert.equal(sent.status, 200, sent.text);
  assert.deepEqual(
    sent.json().notes.map((c: Comment) => c.id),
    [draft.id],
  );
});
