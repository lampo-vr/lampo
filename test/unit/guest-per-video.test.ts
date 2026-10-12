// A review link checks the video, not only the link: a file that arrives later through a visitor's upload URL, a
// reference a visitor removes and a transcript a visitor asks for are each asked of the note's or the video's own place
// in the link, as every other guest write is. A video archived out of the link since takes no file (refused like an
// unknown note); a video in an archived project is watch only on each of these routes (403 with the usual words,
// nothing heard, nothing changed); videos the link still covers and allows work as before. Folder links and set links
// alike, and also for a file whose bytes were still on their way when the video left: asked again once they are in,
// nothing of it is kept. And a set link looks its videos up once per request, not again for every question about them.
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
const { CACHE, dataDir, slugify } = await import('../../lib/paths.ts');

const { port, ctx } = await startApp({ token: 'test-token', loadSessions: async () => [] });

// Every transcript a route asks for: a speech job starts only from here.
const heard: string[] = [];
const startTranscript = ctx.background.startTranscript;
ctx.background.startTranscript = (...args: Parameters<typeof startTranscript>) => {
  heard.push(slugify(args[0].video));
  return startTranscript(...args);
};

function track(rel: string, folder: string): string {
  const file = makeVideo(path.join(dir, rel), { w: 160, h: 90, dur: 1 });
  age(file);
  store.createOrGetReview(file, { by: 'tester' });
  const slug = slugOf(file);
  folders.moveVideo(slug, folder, 'tester');
  return slug;
}

interface Reply {
  status: number;
  text: string;
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
  json: () => any;
}
function request(method: string, url: string, { body, headers = {} }: { body?: unknown | Buffer; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const raw = Buffer.isBuffer(body);
    const data = body === undefined ? undefined : raw ? body : JSON.stringify(body);
    const type = body === undefined ? {} : { 'content-type': raw ? 'image/png' : 'application/json' };
    const length = data === undefined ? {} : { 'content-length': String(Buffer.byteLength(data)) };
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { ...type, ...length, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode || 0, text, json: () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}
// A visitor from elsewhere: guest routes are the only thing that answers them (loopback is the machine's owner).
const guest = (method: string, url: string, body?: unknown) => request(method, url, { body, headers: { 'x-forwarded-for': '203.0.113.9' } });
const enc = encodeURIComponent;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const WATCH_ONLY = 'This link is for watching only.';

type Kind = 'folder' | 'set';
const KINDS: Kind[] = ['folder', 'set'];

/** A link of `kind` over `slugs` (a folder link over their one folder). */
async function linkOver(kind: Kind, slugs: string[], folder: string): Promise<string> {
  const r = kind === 'set' ? await request('POST', '/api/set-shares', { body: { slugs } }) : await request('POST', '/api/folder-shares', { body: { folder } });
  assert.equal(r.status, 200, r.text);
  return r.json().token as string;
}
/** The id the link's room gives a video. */
async function idIn(token: string, slug: string): Promise<string> {
  const r = await guest('GET', `/api/g/${token}`);
  assert.equal(r.status, 200, r.text);
  const name = path.basename(must(store.loadReview(slug)).video);
  return must(
    (r.json().videos as { slug: string; name: string }[]).find((v) => v.name === name),
    `${name} in the room`,
  ).slug;
}
/** A visitor's note on a video of the link (with a link reference when `ref`). */
async function noteOn(token: string, slug: string, ref = false): Promise<{ id: string; ref?: string }> {
  const r = await guest('POST', `/api/g/${token}/comments`, {
    name: 'Mia',
    slug: await idIn(token, slug),
    frame: 1,
    text: 'mine',
    ...(ref ? { refs: [{ kind: 'link', url: 'https://example.com/look' }] } : {}),
  });
  assert.equal(r.status, 200, r.text);
  const id = r.json().id as string;
  return { id, ref: must(store.findComment(id)).comment.refs?.[0]?.id };
}
/** An upload URL for an image on the visitor's own note. */
async function uploadUrl(token: string, note: string, caption: string): Promise<string> {
  const r = await guest('POST', `/api/g/${token}/comments/${note}/refs`, { kind: 'image', name: 'Mia', caption });
  assert.equal(r.status, 200, r.text);
  return must(r.json().upload?.url as string | undefined, 'an upload URL');
}
const refsOf = (note: string) => must(store.findComment(note)).comment.refs ?? [];
const landed = (note: string, caption: string) => refsOf(note).some((x) => x.caption === caption);
const archiveProject = async (name: string) => assert.equal((await request('POST', '/api/folders/archive', { body: { path: name } })).status, 200);

test('a file upload URL handed out before its note’s video left the link takes nothing; on a video still in it, the file lands', async () => {
  for (const kind of KINDS) {
    const folder = `Left ${kind}`;
    const gone = track(`renders/left-${kind}-gone.mp4`, folder);
    const kept = track(`renders/left-${kind}-kept.mp4`, folder);
    const token = await linkOver(kind, [gone, kept], folder);
    const onGone = await noteOn(token, gone);
    const onKept = await noteOn(token, kept);
    const late = await uploadUrl(token, onGone.id, 'late file');
    const fine = await uploadUrl(token, onKept.id, 'fine file');
    // the video is archived (it has notes): out of the link
    assert.equal((await request('DELETE', `/api/library/${enc(gone)}`)).json().archived, true);
    const r = await request('PUT', late, { body: PNG });
    assert.equal(r.status, 404, `${kind}: ${r.text}`);
    assert.equal(r.json().error, 'no such note', `${kind}: refused like a note the link doesn’t show`);
    assert.ok(!landed(onGone.id, 'late file'), `${kind}: nothing landed on the archived video’s note`);
    const ok = await request('PUT', fine, { body: PNG });
    assert.equal(ok.status, 200, `${kind}: ${ok.text}`);
    assert.ok(landed(onKept.id, 'fine file'), `${kind}: the file on a video the link still covers landed`);
  }
});

/** A PUT that sends a few bytes, waits until the server took the URL (its first check passed and the bytes are being
 * read), runs `between`, then sends the rest. */
function slowPut(url: string, body: Buffer, between: () => Promise<void>): Promise<Reply> {
  const raw = must(url.split('/').pop());
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'PUT', path: url, headers: { 'content-type': 'image/png', 'content-length': String(body.length) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode || 0, text, json: () => JSON.parse(text) });
        });
      },
    );
    req.on('error', reject);
    req.write(body.subarray(0, 10));
    until(() => ctx.uploadTickets.get(raw)?.used, 'the PUT under way')
      .then(between)
      .then(() => req.end(body.subarray(10)), reject);
  });
}
/** Uploads whose bytes are on this disk now (server/routes/uploads.ts keeps a ticket's PUT there until it is used). */
const uploadsHeld = () => {
  const held = path.join(CACHE, 'uploads');
  return fs.existsSync(held) ? fs.readdirSync(held).filter((f) => f.startsWith('direct-')) : [];
};

test('a file still on its way when its note’s video leaves the link takes nothing, and leaves nothing on the disk', async () => {
  for (const kind of KINDS) {
    const folder = `Slow ${kind}`;
    const gone = track(`renders/slow-${kind}-gone.mp4`, folder);
    const kept = track(`renders/slow-${kind}-kept.mp4`, folder);
    const token = await linkOver(kind, [gone, kept], folder);
    const onGone = await noteOn(token, gone);
    const onKept = await noteOn(token, kept);
    // the video is archived (it has notes) while the bytes are on their way: past the first check
    const r = await slowPut(await uploadUrl(token, onGone.id, 'slow file'), PNG, async () => {
      assert.equal((await request('DELETE', `/api/library/${enc(gone)}`)).json().archived, true);
    });
    assert.deepEqual([r.status, r.json().error], [404, 'no such note'], `${kind}: ${r.text}`);
    assert.ok(!landed(onGone.id, 'slow file'), `${kind}: nothing landed on the archived video’s note`);
    assert.deepEqual(uploadsHeld(), [], `${kind}: no upload left on the disk`);
    // the same slow upload onto a video the link still covers lands
    const ok = await slowPut(await uploadUrl(token, onKept.id, 'slow but fine'), PNG, async () => {});
    assert.equal(ok.status, 200, `${kind}: ${ok.text}`);
    assert.ok(landed(onKept.id, 'slow but fine'), `${kind}: the file landed`);
    assert.deepEqual(uploadsHeld(), [], `${kind}: its upload is gone once it landed`);
  }
});

test('a file upload URL on a video that takes no notes any more (its project archived) is refused before its bytes', async () => {
  for (const kind of KINDS) {
    const shut = `Shut upload ${kind}`;
    const p = track(`renders/up-${kind}-p.mp4`, shut);
    // a set link spans projects: its other video's project stays open, so only p is watch only
    const q = track(`renders/up-${kind}-q.mp4`, kind === 'set' ? `Open upload ${kind}` : shut);
    const token = await linkOver(kind, [p, q], shut);
    const note = await noteOn(token, p);
    const url = await uploadUrl(token, note.id, 'after the archive');
    await archiveProject(shut);
    const r = await request('PUT', url, { body: PNG });
    if (kind === 'set') assert.deepEqual([r.status, r.json().error], [403, WATCH_ONLY], `${kind}: ${r.text}`);
    // a folder link in an archived project is watch only as a whole: the link refuses it, as before
    else assert.equal(r.status, 410, `${kind}: ${r.text}`);
    assert.ok(!landed(note.id, 'after the archive'), `${kind}: nothing landed`);
  }
});

/** A link of `kind` with a video `p` in a project archived now (a set link's other video in an open one), and a
 * visitor's note on p made before, with a link reference. */
async function shutScene(kind: Kind, name: string) {
  const shut = `Shut ${name} ${kind}`;
  const p = track(`renders/shut-${name}-${kind}-p.mp4`, shut);
  const q = track(`renders/shut-${name}-${kind}-q.mp4`, kind === 'set' ? `Open ${name} ${kind}` : shut);
  const token = await linkOver(kind, [p, q], shut);
  const pId = await idIn(token, p);
  const note = await noteOn(token, p, true);
  await archiveProject(shut);
  return { token, p, pId, note: note.id, ref: must(note.ref, 'the note’s reference') };
}

test('a reference removed on a watch-only video (its project archived): 403 with the usual words, the store untouched', async () => {
  for (const kind of KINDS) {
    const { token, note, ref } = await shutScene(kind, 'delete');
    const before = JSON.stringify(refsOf(note));
    const del = await guest('DELETE', `/api/g/${token}/comments/${note}/refs/${ref}`);
    assert.deepEqual([del.status, del.json().error], [403, WATCH_ONLY], `${kind}: ${del.text}`);
    assert.equal(JSON.stringify(refsOf(note)), before, `${kind}: the reference is still there`);
  }
});

test('a transcript asked for on a watch-only video (its project archived): 403 with the usual words, nothing heard', async () => {
  for (const kind of KINDS) {
    const { token, pId } = await shutScene(kind, 'transcript');
    const before = heard.length;
    const tr = await guest('GET', `/api/g/${token}/review/${pId}/transcript`);
    assert.deepEqual([tr.status, tr.json().error], [403, WATCH_ONLY], `${kind}: ${tr.text}`);
    assert.deepEqual(heard.slice(before), [], `${kind}: no speech job for a watch-only video`);
  }
});

test('the same calls on a video the link still covers and allows work as before', async () => {
  for (const kind of KINDS) {
    const folder = `Open calls ${kind}`;
    const p = track(`renders/open-${kind}-p.mp4`, folder);
    const q = track(`renders/open-${kind}-q.mp4`, folder);
    const token = await linkOver(kind, [p, q], folder);
    if (kind === 'set') {
      // the set's other video in an archived project changes nothing for this one
      const other = track('renders/open-set-shut.mp4', 'Open calls set shut');
      const both = await linkOver(kind, [p, other], folder);
      await archiveProject('Open calls set shut');
      const note = await noteOn(both, p, true);
      const del = await guest('DELETE', `/api/g/${both}/comments/${note.id}/refs/${must(note.ref)}`);
      assert.equal(del.status, 200, del.text);
      assert.equal(refsOf(note.id).length, 0, 'the set’s open video: its reference removed');
    }
    const note = await noteOn(token, p, true);
    const del = await guest('DELETE', `/api/g/${token}/comments/${note.id}/refs/${must(note.ref)}`);
    assert.equal(del.status, 200, `${kind}: ${del.text}`);
    assert.equal(refsOf(note.id).length, 0, `${kind}: the reference is removed`);
    const before = heard.length;
    const tr = await guest('GET', `/api/g/${token}/review/${await idIn(token, p)}/transcript`);
    assert.equal(tr.status, 200, `${kind}: ${tr.text}`);
    assert.deepEqual(heard.slice(before), [p], `${kind}: the transcript was asked for`);
  }
});

test('a set link looks its videos up once per request: one listing of the workspace’s reviews, whatever the route asks', async (t) => {
  const s = track('renders/once-s.mp4', 'Once');
  const u = track('renders/once-u.mp4', 'Once');
  const token = await linkOver('set', [s, u], 'Once');
  const id = await idIn(token, s);
  // Listings of the workspace's reviews made to find the set's videos: work in the background lists them too (a copy
  // being made asks whether another video shares its render), and is no part of the request's cost.
  let listings = 0;
  const readdir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', ((...args: unknown[]) => {
    if (String(args[0]) === dataDir() && /\bsetReviews\b/.test(new Error().stack ?? '')) listings++;
    return Reflect.apply(readdir, fs, args);
  }) as typeof fs.readdirSync);
  const routes: [string, string, unknown?][] = [
    ['GET', `/api/g/${token}`],
    ['GET', `/api/g/${token}/review/${id}`],
    ['POST', `/api/g/${token}/progress`, { visitor: 'visitor-once-0001', slug: id, v: 1, seen: '0'.repeat(25), secs: 1 }],
    ['GET', `/api/g/${token}/poster/${id}`],
    ['GET', `/media/g/${token}/${id}/v1`],
  ];
  for (const [method, url, body] of routes) {
    listings = 0;
    const r = await guest(method, url, body);
    assert.ok(r.status < 400 || r.status === 425, `${url}: ${r.status} ${r.text}`);
    assert.equal(listings, 1, `${method} ${url.replace(token, '<token>')}: the set looked up ${listings} times`);
  }
  t.mock.restoreAll();
});
