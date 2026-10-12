// A review link for a chosen set of videos (Share.video_ids, POST /api/set-shares): made from the library's selection,
// it covers exactly those videos, by their ids, looked up on each request. Every guest route reaches only a video of
// the set (any other one answers like an unknown id), the room names no folder, the link's settings hold for each of
// its videos, a video removed or archived drops out (a set with none left answers like an expired link), and links
// of the other kinds — old ones too — behave as they did.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, must, slugOf, until } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const folders = await import('../../lib/folders.ts');
const shares = await import('../../lib/shares.ts');
const { DATA } = await import('../../lib/paths.ts');
const { SHARE_SET_MAX } = await import('../../lib/shareSet.ts');

function track(rel: string, folder: string | null): string {
  const file = makeVideo(path.join(dir, rel), { w: 160, h: 90, dur: 1 });
  age(file);
  store.createOrGetReview(file, { by: 'tester' });
  const slug = slugOf(file);
  if (folder) folders.moveVideo(slug, folder, 'tester');
  return slug;
}

// Folder names are client and project names: the room never says them.
const a = track('Clients/Acme/a.mp4', 'Acme Secret/Reels');
const b = track('Clients/Acme/b.mp4', 'Acme Secret/Cutdowns');
const c = track('Clients/Acme/c.mp4', 'Acme Secret/Reels');

const { port } = await startApp({ token: 'test-token', loadSessions: async () => [] });

interface Reply {
  status: number;
  text: string;
  headers: http.IncomingHttpHeaders;
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
  json: () => any;
}
function request(method: string, url: string, { body, headers = {} }: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, method, path: url, headers: { ...(data !== undefined ? { 'content-type': 'application/json' } : {}), ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode || 0, text, headers: res.headers, json: () => JSON.parse(text) });
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}
// A visitor from elsewhere: guest routes are the only thing that answers them.
const remote = { 'x-forwarded-for': '203.0.113.9' };
const guest = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
  request(method, url, { body, headers: { ...remote, ...headers } });
const enc = encodeURIComponent;

async function makeSet(slugs: string[], settings: object = {}) {
  const r = await request('POST', '/api/set-shares', { body: { slugs, ...settings } });
  assert.equal(r.status, 200, r.text);
  return r.json() as { token: string; id: string; kind: string; videos: { slug: string; name: string }[] };
}
/** The id `link` would give a video it doesn't cover — the strongest guess a visitor could make. */
const wouldBe = (link: { token: string; id: string }, slug: string) => shares.guestId({ token: link.token, id: link.id } as never, slug);
const room = async (token: string) => {
  const r = await guest('GET', `/api/g/${token}`);
  assert.equal(r.status, 200, r.text);
  return r.json() as {
    kind: string;
    folder: string | null;
    perms: Record<string, unknown>;
    videos: { slug: string; name: string; folder: string | null; poster: string; sprite: string }[];
  };
};
const idOf = async (token: string, name: string) => must((await room(token)).videos.find((v) => v.name === name)).slug;

test('made from slugs, kept as ids: listed with its videos for the owner, in each video’s links; the store holds no slug', async () => {
  const link = await makeSet([a, b, a], { label: 'Two spots' });
  assert.equal(link.kind, 'set');
  assert.deepEqual(
    link.videos.map((v) => [v.slug, v.name]),
    [
      [a, 'a.mp4'],
      [b, 'b.mp4'],
    ],
    'in the order picked, once each',
  );
  const all = (await request('GET', '/api/shares')).json().shares as { token: string; kind: string; slug: null; folder: null; videos: unknown[] }[];
  const listed = must(all.find((s) => s.token === link.token));
  assert.equal(listed.kind, 'set');
  assert.equal(listed.slug, null);
  assert.equal(listed.folder, null);
  assert.equal(listed.videos.length, 2);
  for (const slug of [a, b]) {
    const own = (await request('GET', `/api/review/${enc(slug)}/shares`)).json().shares as { token: string }[];
    assert.ok(
      own.some((s) => s.token === link.token),
      `listed in ${slug}'s links`,
    );
  }
  assert.ok(!((await request('GET', `/api/review/${enc(c)}/shares`)).json().shares as { token: string }[]).some((s) => s.token === link.token));
  // shares.json: the reviews' ids, nothing that names a video
  const stored = Object.values(JSON.parse(fs.readFileSync(path.join(DATA, 'shares.json'), 'utf8')).shares as Record<string, Record<string, unknown>>).find(
    (s) => s.id === link.id,
  );
  assert.ok(stored);
  assert.deepEqual(stored.video_ids, [must(store.loadReview(a)).id, must(store.loadReview(b)).id]);
  for (const key of ['slug', 'folder', 'video_id', 'folder_id']) assert.ok(!(key in stored), `no ${key}`);
  assert.ok(!JSON.stringify(stored).includes('Acme'), 'no path or folder');
});

test('bounds and refusals: 2 to 100 different videos of this workspace, each with a version, an id, not archived; never an embed', async () => {
  const post = (body: object) => request('POST', '/api/set-shares', { body });
  assert.equal((await post({ slugs: [a] })).status, 400, 'one video is a video link');
  assert.equal((await post({ slugs: [a, a] })).status, 400, 'twice the same is one');
  assert.equal((await post({ slugs: Array.from({ length: SHARE_SET_MAX + 1 }, (_, i) => `${a}${i}`) })).status, 400, 'over the bound');
  assert.equal((await post({ slugs: [a, 'x'.repeat(601)] })).status, 400, 'a slug too long');
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ slugs: [a, b], embed: true })).status, 400, 'an embed plays one video');
  const unknown = await post({ slugs: [a, 'nobody__nothing.mp4'] });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json().error, 'no such video');
  assert.equal((await post({ slugs: [a, '../../etc'] })).text, unknown.text, 'a slug no store can have: the same answer');
  // archived: refused until restored
  const gone = track('Clients/Acme/archived.mp4', 'Acme Secret/Reels');
  store.addComment(gone, { frame: 1, text: 'keep me', author: 'tester' });
  assert.equal((await request('DELETE', `/api/library/${enc(gone)}`)).json().archived, true);
  const archived = await post({ slugs: [a, gone] });
  assert.equal(archived.status, 409, archived.text);
  // a review from before ids can't be named by one: refused, never kept by its slug
  const old = track('Clients/Acme/old.mp4', null);
  const file = path.join(DATA, old, 'review.json');
  const rv = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete rv.id;
  fs.writeFileSync(file, JSON.stringify(rv));
  const idless = await post({ slugs: [a, old] });
  assert.equal(idless.status, 409, idless.text);
  // a video in an archived project: the usual refusal
  const shut = track('Clients/Shut/s.mp4', 'Shut Project');
  assert.equal((await request('POST', '/api/folders/archive', { body: { path: 'Shut Project' } })).status, 200);
  assert.equal((await post({ slugs: [a, shut] })).status, 423);
  assert.equal((await request('POST', '/api/folders/restore', { body: { path: 'Shut Project' } })).status, 200);
  // nothing above made a link
  const all = (await request('GET', '/api/shares')).json().shares as { kind: string; videos?: { slug: string }[] }[];
  assert.ok(!all.some((s) => s.kind === 'set' && s.videos?.some((v) => [gone, old, shut].includes(v.slug))));
});

test('the room: exactly its videos, no folder names, no other video of their folders; each one opens', async () => {
  const link = await makeSet([b, a], { label: 'Spots for Mia', versions: 'all', download: 'preview' });
  const r = await room(link.token);
  assert.equal(r.kind, 'set');
  assert.equal(r.folder, null);
  assert.deepEqual(
    r.videos.map((v) => [v.name, v.folder]),
    [
      ['b.mp4', null],
      ['a.mp4', null],
    ],
  );
  const text = JSON.stringify(r);
  for (const word of ['Acme Secret', 'Reels', 'Cutdowns', 'c.mp4', 'Clients', dir]) assert.ok(!text.includes(word), `no ${word}`);
  for (const v of r.videos) {
    const page = await guest('GET', `/api/g/${link.token}/review/${v.slug}`);
    assert.equal(page.status, 200, page.text);
    assert.ok(!page.text.includes('Acme Secret'));
    assert.equal((await guest('GET', v.poster)).status, 200, 'its poster');
    assert.ok((await guest('GET', v.sprite)).status < 300, 'its sprite');
    assert.equal((await guest('GET', `/api/g/${link.token}/waveform/${v.slug}?v=1`)).status, 200, 'its waveform');
  }
  // its media once the preview copy is there
  const id = await idOf(link.token, 'a.mp4');
  const media = await until(async () => (await guest('GET', `/api/g/${link.token}/review/${id}`)).json().media as string | null, 'the preview copy', 60_000);
  assert.ok([200, 206].includes((await guest('GET', media, undefined, { range: 'bytes=0-1023' })).status));
  // a note's marked frame
  const n = await guest('POST', `/api/g/${link.token}/comments`, { name: 'Mia', slug: id, frame: 3, text: 'Logo später', drawing: [] });
  assert.equal(n.status, 200, n.text);
  const shot = await until(
    async () =>
      ((await guest('GET', `/api/g/${link.token}/review/${id}`)).json().notes as { id: string; marked: string | null }[]).find((x) => x.id === n.json().id)
        ?.marked,
    'the note’s marked frame',
  );
  assert.equal((await guest('GET', shot)).status, 200);
  // the owner's count: the note came through this link
  const listed = ((await request('GET', '/api/shares')).json().shares as { token: string; stats: { notes: number } }[]).find((s) => s.token === link.token);
  assert.equal(listed?.stats.notes, 1);
});

test('every guest route reaches only a video of the set: another one answers like an unknown id', async () => {
  const link = await makeSet([a, b], { versions: 'all', download: 'preview' });
  // c, the video beside a in its folder, by every name a visitor could try: its id on a folder link, its raw slug, the
  // id this link would give it, and a made-up one
  const folderLink = (await request('POST', '/api/folder-shares', { body: { folder: 'Acme Secret/Reels' } })).json();
  const cOnFolder = await idOf(folderLink.token, 'c.mp4');
  const cNote = await guest('POST', `/api/g/${folderLink.token}/comments`, { name: 'Mia', slug: cOnFolder, frame: 2, text: 'only on c' });
  assert.equal(cNote.status, 200, cNote.text);
  const t = link.token;
  const unknown = await guest('GET', `/api/g/${t}/review/v_AAAAAAAAAAAAAAAA`);
  assert.equal(unknown.status, 404);
  const aId = await idOf(t, 'a.mp4');
  for (const other of [cOnFolder, enc(c), wouldBe(link, c), 'v_AAAAAAAAAAAAAAAA']) {
    const gets = [
      `/api/g/${t}/review/${other}`,
      `/api/g/${t}/review/${other}/compare?v=1`,
      `/api/g/${t}/review/${other}/transcript`,
      `/api/g/${t}/poster/${other}`,
      `/api/g/${t}/sprite/${other}`,
      `/api/g/${t}/waveform/${other}`,
      `/media/g/${t}/${other}/v1`,
      `/data/g/${t}/${other}/x_marked.png`,
      `/api/g/${t}/refs/${other}/x.png`,
      `/api/g/${t}/download/${other}/v1?kind=preview`,
      `/api/g/${t}/captions/${other}`,
    ];
    for (const u of gets) {
      const r = await guest('GET', u);
      assert.equal(r.status, 404, `${u} → ${r.status}`);
      assert.ok(!r.text.includes('c.mp4') && !r.text.includes('only on c'), u);
    }
    const writes: [string, object][] = [
      [`/api/g/${t}/comments`, { name: 'Mia', slug: other, frame: 1, text: 'sneaky' }],
      [`/api/g/${t}/approval`, { name: 'Mia', slug: other, v: 1, status: 'approved' }],
      [`/api/g/${t}/visit`, { slug: other, v: 1 }],
      [`/api/g/${t}/progress`, { visitor: 'visitor-abcdefgh', slug: other, v: 1, seen: '0'.repeat(25), secs: 1 }],
      // a moment of the other video, on a note about one of the set's own
      [`/api/g/${t}/comments`, { name: 'Mia', slug: aId, frame: 1, text: 'see this', refs: [{ kind: 'frame', video: other, frame: 1 }] }],
    ];
    for (const [u, body] of writes) {
      const r = await guest('POST', u, body);
      assert.equal(r.status, 404, `POST ${u} ${JSON.stringify(body)} → ${r.status} ${r.text}`);
    }
  }
  // c's note through the set link: not there, whatever is asked about it
  for (const [u, body] of [
    [`/api/g/${t}/comments/${cNote.json().id}/replies`, { name: 'Mia', text: 'hi' }],
    [`/api/g/${t}/comments/${cNote.json().id}/check`, { name: 'Mia', verdict: 'confirm' }],
    [`/api/g/${t}/comments/${cNote.json().id}/refs`, { kind: 'link', url: 'https://example.com', name: 'Mia', note: 'see' }],
  ] as const) {
    const r = await guest('POST', u, body);
    assert.equal(r.status, 404, `${u} → ${r.status} ${r.text}`);
  }
  // nothing landed on c
  assert.ok(!must(store.loadReview(c)).comments.some((x) => x.text === 'sneaky'));
  // Download all is a folder link's; an embed's player and captions are an embed's
  for (const u of [`/api/g/${t}/archive/info`, `/api/g/${t}/archive`, `/api/g/${t}/embed`]) assert.equal((await guest('GET', u)).status, 404, u);
  // the old single-video URLs name no video: nothing
  for (const u of [`/api/g/${t}/waveform`, `/media/g/${t}/v1`, `/data/g/${t}/x_marked.png`]) assert.equal((await guest('GET', u)).status, 404, u);
});

test('the link’s settings hold for each of its videos: password, expiry, watch only, downloads, revoking', async () => {
  const ids = async (token: string, cookie = '') => {
    const r = await guest('GET', `/api/g/${token}`, undefined, cookie ? { cookie } : {});
    return (r.json().videos as { slug: string }[]).map((v) => v.slug);
  };
  // a password: nothing before it, every video after it
  const locked = await makeSet([a, b], { password: 'rushes-2026', download: 'preview' });
  const before = (await guest('GET', `/api/g/${locked.token}`)).json();
  assert.equal(before.locked, true);
  assert.deepEqual(before.videos, []);
  const cookie = String((await guest('POST', `/api/g/${locked.token}/unlock`, { password: 'rushes-2026' })).headers['set-cookie']).split(';')[0] as string;
  const unlockedIds = await ids(locked.token, cookie);
  assert.equal(unlockedIds.length, 2);
  for (const id of unlockedIds) {
    for (const u of [
      `/api/g/${locked.token}/review/${id}`,
      `/api/g/${locked.token}/poster/${id}`,
      `/media/g/${locked.token}/${id}/v1`,
      `/api/g/${locked.token}/download/${id}/v1`,
    ])
      assert.equal((await guest('GET', u)).status, 401, `${u} without the password`);
    assert.equal((await guest('GET', `/api/g/${locked.token}/review/${id}`, undefined, { cookie })).status, 200);
    assert.equal((await guest('POST', `/api/g/${locked.token}/comments`, { name: 'Mia', slug: id, frame: 1, text: 'x' })).status, 401);
  }
  // watch only: no notes on any of them; downloads off: none of them
  const watch = await makeSet([a, b], { comment: false, approve: false });
  for (const id of await ids(watch.token)) {
    assert.equal((await guest('POST', `/api/g/${watch.token}/comments`, { name: 'Mia', slug: id, frame: 1, text: 'x' })).status, 403);
    assert.equal((await guest('POST', `/api/g/${watch.token}/approval`, { name: 'Mia', slug: id, v: 1, status: 'approved' })).status, 403);
    assert.equal((await guest('GET', `/api/g/${watch.token}/download/${id}/v1?kind=preview`)).status, 403);
    assert.equal((await guest('GET', `/api/g/${watch.token}/review/${id}`)).json().perms.comment, false);
  }
  // expired: every route of every video answers 410
  const later = await makeSet([a, b]);
  const laterIds = await ids(later.token);
  assert.equal((await request('PATCH', `/api/shares/${later.token}`, { body: { expires: '2020-01-01T00:00:00Z' } })).status, 200);
  for (const id of laterIds)
    for (const u of [`/api/g/${later.token}`, `/api/g/${later.token}/review/${id}`, `/api/g/${later.token}/poster/${id}`, `/media/g/${later.token}/${id}/v1`])
      assert.equal((await guest('GET', u)).status, 410, u);
  // revoked: 404 everywhere at once
  const revoked = await makeSet([a, b]);
  const revokedIds = await ids(revoked.token);
  assert.equal((await request('DELETE', `/api/shares/${revoked.token}`)).status, 200);
  for (const id of revokedIds)
    for (const u of [`/api/g/${revoked.token}`, `/api/g/${revoked.token}/review/${id}`, `/api/g/${revoked.token}/poster/${id}`])
      assert.equal((await guest('GET', u)).status, 404, u);
});

test('a video archived, removed or added again later drops out; one moved stays; a set with none left answers like an expired link', async () => {
  const x = track('Clients/Later/x.mp4', 'Later');
  const y = track('Clients/Later/y.mp4', 'Later');
  const z = track('Clients/Later/z.mp4', 'Later');
  const link = await makeSet([x, y, z]);
  const xId = await idOf(link.token, 'x.mp4');
  const yId = await idOf(link.token, 'y.mp4');
  // moved to another project: the link is for the video, wherever it is
  folders.moveVideo(z, 'Elsewhere', 'tester');
  assert.equal((await room(link.token)).videos.length, 3);
  // archived (it has notes): out of the room, its page gone
  store.addComment(x, { frame: 1, text: 'a note', author: 'tester' });
  assert.equal((await request('DELETE', `/api/library/${enc(x)}`)).json().archived, true);
  assert.deepEqual(
    (await room(link.token)).videos.map((v) => v.name),
    ['y.mp4', 'z.mp4'],
  );
  assert.equal((await guest('GET', `/api/g/${link.token}/review/${xId}`)).status, 404);
  // restored: back
  assert.equal((await request('POST', `/api/library/${enc(x)}/restore`)).status, 200);
  assert.equal((await room(link.token)).videos.length, 3);
  // removed for good (no notes) and added again under the same name: another video, not the link's
  const yFile = must(store.loadReview(y)).video;
  assert.equal((await request('DELETE', `/api/library/${enc(y)}`)).json().archived, false);
  store.createOrGetReview(yFile, { by: 'tester' });
  assert.ok(must(store.loadReview(y)).id);
  assert.deepEqual(
    (await room(link.token)).videos.map((v) => v.name),
    ['x.mp4', 'z.mp4'],
  );
  assert.equal((await guest('GET', `/api/g/${link.token}/review/${yId}`)).status, 404);
  assert.equal((await guest('GET', `/api/g/${link.token}/review/${wouldBe(link, y)}`)).status, 404);
  // the owner still finds it (one is still its own)
  const listed = ((await request('GET', '/api/shares')).json().shares as { token: string; gone?: boolean; videos: unknown[] }[]).find(
    (s) => s.token === link.token,
  );
  assert.equal(listed?.videos.length, 2);
  assert.ok(!listed?.gone);
  // none left: like an expired link, before any password, every route
  for (const s of [x, z]) {
    store.addComment(s, { frame: 1, text: 'keep', author: 'tester' });
    assert.equal((await request('DELETE', `/api/library/${enc(s)}`)).json().archived, true);
  }
  const empty = await guest('GET', `/api/g/${link.token}`);
  assert.equal(empty.status, 410, empty.text);
  assert.equal(empty.json().expired, null);
  assert.equal((await guest('GET', `/api/g/${link.token}/review/${xId}`)).status, 410);
  // archived videos can come back: not "gone" for the owner
  const after = ((await request('GET', '/api/shares')).json().shares as { token: string; gone?: boolean }[]).find((s) => s.token === link.token);
  assert.ok(after && !after.gone);
});

test('a video in an archived project is watch only on its own: the set’s other videos still take notes', async () => {
  const p = track('Clients/P/p.mp4', 'Project P');
  const q = track('Clients/Q/q.mp4', 'Project Q');
  const link = await makeSet([p, q]);
  const pId = await idOf(link.token, 'p.mp4');
  const qId = await idOf(link.token, 'q.mp4');
  assert.equal((await request('POST', '/api/folders/archive', { body: { path: 'Project P' } })).status, 200);
  try {
    assert.equal((await room(link.token)).perms.comment, true, 'the link as a whole: one project of two is archived');
    assert.equal((await guest('GET', `/api/g/${link.token}/review/${pId}`)).json().perms.comment, false);
    assert.equal((await guest('GET', `/api/g/${link.token}/review/${qId}`)).json().perms.comment, true);
    assert.equal((await guest('POST', `/api/g/${link.token}/comments`, { name: 'Mia', slug: pId, frame: 1, text: 'x' })).status, 403);
    assert.equal((await guest('POST', `/api/g/${link.token}/comments`, { name: 'Mia', slug: qId, frame: 1, text: 'x' })).status, 200);
    assert.equal((await request('POST', '/api/folders/archive', { body: { path: 'Project Q' } })).status, 200);
    assert.equal((await room(link.token)).perms.comment, false, 'every video in an archived project: the link is watch only');
  } finally {
    await request('POST', '/api/folders/restore', { body: { path: 'Project P' } });
    await request('POST', '/api/folders/restore', { body: { path: 'Project Q' } });
  }
});

test('links of the other kinds, old ones too, behave as they did beside set links', async () => {
  await makeSet([a, b]);
  // a link from before v2, in the file's old form (keyed by its token, no settings): one video, its defaults
  const token = 'OldStyleToken_setsbeside';
  const file = path.join(DATA, 'shares.json');
  shares.flushShareStats();
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  old.shares[token] = { slug: a, label: 'Legacy client', created: '2026-09-01T10:00:00+02:00', by: 'tester' };
  fs.writeFileSync(file, JSON.stringify(old));
  const g = (await guest('GET', `/api/g/${token}`)).json();
  assert.equal(g.kind, 'video');
  assert.equal(g.videos.length, 1);
  assert.deepEqual(g.perms, { comment: true, approve: true, notes: 'own', versions: 'latest', download: 'off' });
  // its raw slug still opens it (bookmarks from before ids); a set link never takes one
  assert.equal((await guest('GET', `/api/g/${token}/review/${enc(a)}`)).status, 200);
  // a folder link: its room and its folder's name, as before
  const folderLink = (await request('POST', '/api/folder-shares', { body: { folder: 'Acme Secret' } })).json();
  const fr = await room(folderLink.token);
  assert.equal(fr.kind, 'folder');
  assert.equal(fr.folder, 'Acme Secret');
  assert.ok(fr.videos.some((v) => v.name === 'c.mp4'));
  // and the old entry keeps no video_ids
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')).shares as Record<string, Record<string, unknown>>;
  for (const s of Object.values(stored)) if (s.slug || s.folder) assert.ok(!('video_ids' in s));
});

// With `notes: 'all'` a link shows every visitor's notes on its videos, so what keeps another video's notes out is the
// set itself (covers): a note on a video outside the set takes no reply, check or reference through the set's token,
// and a reference to that video on a note the set shows never shows.
test('notes: all — a note of a video outside the set takes no reply, check or reference through it; a reference to that video never shows', async () => {
  const o = track('Clients/Out/o.mp4', 'Outside Project');
  const i1 = track('Clients/In/i1.mp4', 'Inside');
  const i2 = track('Clients/In/i2.mp4', 'Inside');
  // a visitor's note on o, through a folder link of its own
  const folderLink = (await request('POST', '/api/folder-shares', { body: { folder: 'Outside Project', notes: 'all' } })).json();
  const oNote = await guest('POST', `/api/g/${folderLink.token}/comments`, {
    name: 'Eve',
    slug: await idOf(folderLink.token, 'o.mp4'),
    frame: 1,
    text: 'O-OUTSIDE',
  });
  assert.equal(oNote.status, 200, oNote.text);
  // the set's own note on i1, which the team gives a reference to a moment of o
  const link = await makeSet([i1, i2], { notes: 'all' });
  const i1Id = await idOf(link.token, 'i1.mp4');
  const mine = await guest('POST', `/api/g/${link.token}/comments`, { name: 'Mia', slug: i1Id, frame: 1, text: 'mine' });
  assert.equal(mine.status, 200, mine.text);
  store.addRefs(mine.json().id, [{ id: 'r_toOutside01', kind: 'frame', video: o, v: 1, frame: 1, by: 'tester', name: 'o.mp4' } as never], { by: 'tester' });
  // every problem is listed, not only the first: each of these is a way out of the set on its own
  const problems: string[] = [];
  const page = await guest('GET', `/api/g/${link.token}/review/${i1Id}`);
  assert.equal(page.status, 200, page.text);
  for (const word of ['O-OUTSIDE', 'r_toOutside01', 'o.mp4', 'Outside Project']) if (page.text.includes(word)) problems.push(`the set's page shows ${word}`);
  // every write about o's note, each through a fresh link of the same set (a visitor's minute is per link)
  for (const [u, body] of [
    [`/comments/${oNote.json().id}/replies`, { name: 'Mia', text: 'REPLY-ONTO-O' }],
    [`/comments/${oNote.json().id}/check`, { name: 'Mia', verdict: 'reopen', text: 'REOPEN-O' }],
    [`/comments/${oNote.json().id}/refs`, { kind: 'link', url: 'https://example.com/o', name: 'Mia', note: 'REF-ONTO-O' }],
  ] as const) {
    const fresh = await makeSet([i1, i2], { notes: 'all' });
    const r = await guest('POST', `/api/g/${fresh.token}${u}`, body);
    if (r.status !== 404 || r.text.includes('O-OUTSIDE')) problems.push(`POST ${u.split('/').at(-1)} on o's note → ${r.status}`);
  }
  const after = JSON.stringify(must(must(store.loadReview(o)).comments.find((x) => x.id === oNote.json().id)));
  for (const word of ['REPLY-ONTO-O', 'REOPEN-O', 'REF-ONTO-O']) if (after.includes(word)) problems.push(`${word} landed on o's note`);
  assert.deepEqual(problems, []);
});

// What a set link's visitor can reach, crawled from its room as guest-privacy.test.ts crawls a link: every address any
// answer names, followed. With every setting open (all notes, all versions, originals), nothing names a folder, a path,
// a video outside the set, a note or verdict made on one, a moment of one, or a review id.
test('a crawl of everything a set link’s visitor can reach names nothing outside the set', async () => {
  // outside the set: c (beside a in its folder) with a visitor's note and verdict; and a note on a with a moment of c
  const folderLink = (await request('POST', '/api/folder-shares', { body: { folder: 'Acme Secret/Reels', notes: 'all' } })).json();
  const cOnFolder = await idOf(folderLink.token, 'c.mp4');
  const aOnFolder = await idOf(folderLink.token, 'a.mp4');
  for (const [u, body] of [
    ['comments', { name: 'Eve', slug: cOnFolder, frame: 2, text: 'C-SECRET-NOTE' }],
    ['approval', { name: 'Eve', slug: cOnFolder, v: 1, status: 'changes', note: 'C-SECRET-VERDICT' }],
    ['comments', { name: 'Eve', slug: aOnFolder, frame: 3, text: 'about a', refs: [{ kind: 'frame', video: cOnFolder, frame: 1 }] }],
  ] as const) {
    const r = await guest('POST', `/api/g/${folderLink.token}/${u}`, body);
    assert.equal(r.status, 200, r.text);
  }
  const link = await makeSet([a, b], { notes: 'all', versions: 'all', download: 'original' });
  const seen: string[] = [];
  const fetched = new Set<string>();
  const crawl = async (text: string): Promise<void> => {
    for (const [url] of text.matchAll(/\/(?:api|media|data)\/g\/[^"\s\\]+/g)) {
      if (fetched.has(url)) continue;
      fetched.add(url);
      const r = await guest('GET', url, undefined, { range: 'bytes=0-65535' });
      seen.push(url, String(r.status), JSON.stringify(r.headers), r.text);
      if (String(r.headers['content-type']).includes('json')) await crawl(r.text);
    }
  };
  const start = await guest('GET', `/api/g/${link.token}`);
  assert.equal(start.status, 200, start.text);
  seen.push(JSON.stringify(start.headers), start.text);
  await crawl(start.text);
  for (const v of start.json().videos as { slug: string }[])
    for (const u of [
      `/api/g/${link.token}/review/${v.slug}`,
      `/api/g/${link.token}/review/${v.slug}?v=1`,
      `/api/g/${link.token}/review/${v.slug}/compare?v=1`,
    ]) {
      const r = await guest('GET', u);
      assert.equal(r.status, 200, `${u} → ${r.status}`);
      seen.push(u, JSON.stringify(r.headers), r.text);
      await crawl(r.text);
    }
  assert.ok(fetched.size > 5, `the crawl followed what the answers name (${fetched.size} addresses)`);
  const all = seen.join('\n');
  // every link's notes on a are this link's to show (notes: all); the moment of c on one of them is not
  assert.ok(all.includes('about a'), 'a’s notes from the folder link show');
  const ids = [a, b, c].map((s) => must(must(store.loadReview(s)).id));
  for (const word of [dir, 'Acme Secret', 'Reels', 'Cutdowns', 'Clients', 'c.mp4', 'C-SECRET-NOTE', 'C-SECRET-VERDICT', ...ids]) {
    const hit = all.indexOf(word);
    assert.ok(hit < 0, `no ${word} in ${fetched.size} addresses: …${all.slice(Math.max(0, hit - 80), hit + 40)}…`);
  }
});
