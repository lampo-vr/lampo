// A review link shows a client the videos it covers and nothing about the owner's machine. In local mode a video's
// slug is its absolute path (home folder, client and project names), so this walks everything a visitor of a folder
// link can reach — every JSON body, every URL in it, every header, the archive, writes and errors — and looks for
// the path, the home folder's name and a folder the link doesn't cover.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, FFMPEG, isolatedEnv, makeVideo, slugOf, tmpdir, until } from '../lib/helpers.ts';

// the team has a name (review links show it; an embed never does)
const { dir } = isolatedEnv({ vars: { VR_ORG_NAME: 'Example Studio' } });
const store = await import('../../lib/store.ts');
const folders = await import('../../lib/folders.ts');
const { loadConfig } = await import('../../lib/config.ts');
const { staticUi } = await import('../../server/app.ts');

// the pages as a build has them: a review link's (the app) and an embed's player
const dist = tmpdir('vr-privacy-dist-');
fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><head><title>app</title></head><body></body></html>');
fs.writeFileSync(path.join(dist, 'embed.html'), '<!doctype html><html><head><title>player</title></head><body></body></html>');

// Where an owner's renders typically live: their home folder, then one folder per client.
const HOME = path.join(dir, 'Users', 'olivia-home');
function track(rel: string, folder: string): { file: string; slug: string } {
  const file = makeVideo(path.join(HOME, rel), { w: 160, h: 90, dur: 1 });
  age(file);
  store.createOrGetReview(file, { by: 'tester' });
  const slug = slugOf(file);
  folders.moveVideo(slug, folder, 'tester');
  return { file, slug };
}
const spot = track('Clients/Acme/Reels/export/spot.mp4', 'Acme/Reels');
const teaser = track('Clients/Acme/Teaser/export/teaser.mp4', 'Acme');
const other = track('Clients/Globex/export/launch.mp4', 'Globex');

const { port } = await startApp({ token: 'test-token', loadSessions: async () => [], ui: staticUi(dist) });

interface Seen {
  status: number;
  text: string;
  headers: http.IncomingHttpHeaders;
}
function request(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Seen> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, method, path: url, headers: { ...(data !== undefined ? { 'content-type': 'application/json' } : {}), ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('latin1'), headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

// Everything a visitor received (status, headers, body), and every guest URL found in it (fetched once each). The
// requests themselves aren't part of it: a few below deliberately name what the link doesn't cover.
const surface: string[] = [];
const fetched = new Set<string>();
const visitor = { 'x-forwarded-for': '203.0.113.7' };
async function guest(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Seen> {
  const r = await request(method, url, body, { ...visitor, ...headers });
  surface.push(String(r.status), JSON.stringify(r.headers), r.text);
  return r;
}
async function crawl(text: string): Promise<void> {
  for (const [url] of text.matchAll(/\/(?:api|media|data)\/g\/[^"\s\\]+/g)) {
    if (fetched.has(url)) continue;
    fetched.add(url);
    const r = await guest('GET', url, undefined, { range: 'bytes=0-65535' });
    if (r.headers['content-type']?.includes('json')) await crawl(r.text);
  }
}

test('nothing a folder link shows or answers carries the owner’s paths, home folder or other clients', async () => {
  const made = await request('POST', '/api/folder-shares', { folder: 'Acme', download: 'original', notes: 'all', versions: 'all', label: 'Acme' });
  assert.equal(made.status, 200, made.text);
  const { token } = JSON.parse(made.text);

  const link = await guest('GET', `/api/g/${token}`);
  const room = JSON.parse(link.text);
  assert.equal(room.videos.length, 2);
  for (const v of room.videos) assert.match(v.slug, /^v_[A-Za-z0-9_-]{16}$/, 'videos are named by an opaque id');
  await guest('POST', `/api/g/${token}/visit`, { name: 'Mia' });
  await crawl(link.text);

  // Writes, and what they bring back: a marked note, a reply, a fix check, a verdict.
  const id = room.videos[0].slug;
  const noted = await guest('POST', `/api/g/${token}/comments`, {
    name: 'Mia',
    slug: id,
    frame: 3,
    text: 'Logo später',
    drawing: [{ type: 'arrow', x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5, color: '#ff0000' }],
  });
  assert.equal(noted.status, 200, noted.text);
  const noteId = JSON.parse(noted.text).id;
  store.updateComment(noteId, { status: 'fixed', note: 'moved', by: 'tester' });
  await guest('POST', `/api/g/${token}/comments/${noteId}/replies`, { name: 'Mia', text: 'Danke' });
  await guest('POST', `/api/g/${token}/comments/${noteId}/check`, { name: 'Mia', verdict: 'confirm' });
  await guest('POST', `/api/g/${token}/approval`, { name: 'Mia', slug: id, v: 1, status: 'approved' });
  const review = await guest('GET', `/api/g/${token}/review/${id}`);
  assert.equal(review.status, 200, review.text);
  assert.match(review.text, /"marked":"\/data\/g\//, 'the marked screenshot is reachable');
  await crawl(review.text);
  await guest('GET', `/api/g/${token}/archive?kind=original`);
  await guest('GET', `/g/${token}`);

  // Misses look the same for "doesn't exist" and "not in this link", and name nothing.
  await guest('GET', `/api/g/${token}/review/v_AAAAAAAAAAAAAAAA`);
  await guest('GET', `/api/g/${token}/review/${encodeURIComponent(other.slug)}`);
  await guest('POST', `/api/g/${token}/comments`, { name: 'Mia', slug: other.slug, frame: 1, text: 'x' });

  assert.ok(fetched.size >= 8, `crawled the guest URLs (${fetched.size})`);
  const all = surface.join('\n');
  for (const secret of [dir, HOME, 'olivia-home', 'Clients', 'Globex', spot.slug, teaser.slug, other.slug, path.basename(dir)]) {
    const at = all.indexOf(secret);
    assert.ok(at < 0, `a visitor must never see ${JSON.stringify(secret)}: …${all.slice(Math.max(0, at - 300), at + 80)}…`);
  }
});

test('ids are stable per link and differ between links; slugs from before ids still open the video', async () => {
  const a = JSON.parse((await request('POST', '/api/folder-shares', { folder: 'Acme', label: 'A' })).text).token;
  const b = JSON.parse((await request('POST', '/api/folder-shares', { folder: 'Acme', label: 'B' })).text).token;
  const ids = async (t: string) => JSON.parse((await guest('GET', `/api/g/${t}`)).text).videos.map((v: { slug: string }) => v.slug) as string[];
  const [a1, a2, b1] = [await ids(a), await ids(a), await ids(b)];
  assert.deepEqual(a1, a2, 'stable');
  assert.ok(
    a1.every((x) => !b1.includes(x)),
    'another link names the same videos differently',
  );
  // Another link's id doesn't open anything here.
  assert.equal((await guest('GET', `/api/g/${a}/review/${b1[0]}`)).status, 404);
  // A tab opened before ids existed still works (the visitor was shown that slug then).
  const legacy = await guest('GET', `/api/g/${a}/review/${encodeURIComponent(spot.slug)}`);
  assert.equal(legacy.status, 200, legacy.text);
  assert.match(JSON.parse(legacy.text).slug, /^v_/, 'and from then on it is named by its id');
  // A single-video link answers its own id and refuses any other.
  const one = JSON.parse((await request('POST', `/api/review/${encodeURIComponent(spot.slug)}/shares`, {})).text).token;
  const own = JSON.parse((await guest('GET', `/api/g/${one}`)).text).videos[0].slug;
  assert.equal((await guest('GET', `/api/g/${one}/review/${own}`)).status, 200);
  assert.equal((await guest('GET', `/api/g/${one}/review/${a1[0] === own ? a1[1] : a1[0]}`)).status, 404);
});

// Folder names are often client and project names. A link names no folder above what it shares: a video link none, a
// folder link its own name and its videos' places below it, and nothing at all before the password (A12 GUEST-13).
test('a link names no folder above what it shares, and none before its password', async () => {
  const make = async (url: string, body: object) => JSON.parse((await request('POST', url, body)).text).token as string;
  const seen = async (token: string) => {
    const r = await guest('GET', `/api/g/${token}`);
    return { text: r.text, json: JSON.parse(r.text) };
  };
  const video = await seen(await make(`/api/review/${encodeURIComponent(spot.slug)}/shares`, { label: 'One cut' }));
  assert.equal(video.json.folder, null, 'a video link');
  assert.equal(video.json.videos[0].folder, null, 'its video');
  for (const name of ['Acme', 'Reels']) assert.ok(!video.text.includes(name), `a video link never says ${name}`);

  const sub = await seen(await make('/api/folder-shares', { folder: 'Acme/Reels', label: 'Sub' }));
  assert.equal(sub.json.folder, 'Reels', 'a folder link: its own name');
  assert.equal(sub.json.videos[0].folder, null, 'a video right in it');
  assert.ok(!sub.text.includes('Acme'), 'never the folders above it');

  const top = await seen(await make('/api/folder-shares', { folder: 'Acme', label: 'Top' }));
  const places = Object.fromEntries(top.json.videos.map((v: { name: string; folder: string | null }) => [v.name, v.folder]));
  assert.deepEqual(places, { 'spot.mp4': 'Reels', 'teaser.mp4': null }, 'where each video is, below the shared folder');

  const locked = await seen(await make('/api/folder-shares', { folder: 'Acme/Reels', label: 'Locked', password: 'open sesame' }));
  assert.equal(locked.json.locked, true);
  assert.equal(locked.json.kind, 'folder', 'the kind, for the gate’s scene');
  assert.equal(locked.json.folder, null, 'no folder before the password');
  for (const name of ['Acme', 'Reels']) assert.ok(!locked.text.includes(name), `a locked link never says ${name}`);
});

// AGPL-3.0 §13: everyone who uses an instance over the network is offered its source — clients on review links are
// most of them. The link's answer carries the instance's source URL, before the password too (A12-D5).
test('a review link offers the source of the server it runs on, locked or not', async () => {
  const source = loadConfig().source_url;
  assert.match(source ?? '', /^https:\/\//, 'the instance has a source URL (package.json’s repository by default)');
  const open = JSON.parse((await request('POST', '/api/folder-shares', { folder: 'Acme', label: 'Source' })).text).token;
  const locked = JSON.parse((await request('POST', '/api/folder-shares', { folder: 'Acme', label: 'Locked', password: 'open sesame' })).text).token;
  const a = JSON.parse((await guest('GET', `/api/g/${open}`)).text);
  const b = JSON.parse((await guest('GET', `/api/g/${locked}`)).text);
  assert.equal(b.locked, true);
  assert.equal(a.source, source);
  assert.equal(b.source, source);
});

test('the owner’s drafts never reach a review link: not their words, not their id, not their frames', async () => {
  const made = await request('POST', `/api/review/${encodeURIComponent(spot.slug)}/drafts`, {
    frame: 2,
    text: 'draftmark not sent yet',
    drawing: [{ type: 'arrow', x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5, color: '#ff0000' }],
  });
  assert.equal(made.status, 200, made.text);
  const draft = JSON.parse(made.text);
  const { token } = JSON.parse((await request('POST', '/api/folder-shares', { folder: 'Acme', notes: 'all', versions: 'all', label: 'Drafts' })).text);
  surface.length = 0;
  fetched.clear();
  const link = await guest('GET', `/api/g/${token}`);
  await crawl(link.text);
  for (const v of JSON.parse(link.text).videos) await crawl((await guest('GET', `/api/g/${token}/review/${v.slug}`)).text);
  assert.equal((await guest('GET', `/data/g/${token}/${draft.shots.marked}`)).status, 404, 'its frame is not served');
  const all = surface.join('\n');
  assert.ok(fetched.size >= 2, `crawled the guest URLs (${fetched.size})`);
  for (const secret of ['draftmark', draft.id]) assert.ok(!all.includes(secret), `a visitor must never see ${secret}`);
});

// A newest-only link refuses older versions (docs/sharing.md). A note another link brought in can hold a frame of
// one, and its still was a V1 frame served all the same (A12 GUEST-12): the link shows the moment, never its picture.
test('a newest-only link serves no still of a version it doesn’t show', async () => {
  const twice = track('Clients/Acme/Twice/export/twice.mp4', 'Acme/Twice');
  makeVideo(twice.file, { w: 160, h: 90, dur: 1, freq: 880 });
  age(twice.file);
  assert.equal(store.sync(twice.slug)?.review.versions.length, 2, 'two versions');
  const make = async (body: object) =>
    JSON.parse((await request('POST', '/api/folder-shares', { folder: 'Acme/Twice', notes: 'all', ...body })).text).token as string;
  const all = await make({ versions: 'all', label: 'All' });
  const newest = await make({ label: 'Newest' });
  const idIn = async (token: string) => JSON.parse((await guest('GET', `/api/g/${token}`)).text).videos[0].slug as string;
  const [gAll, gNewest] = [await idIn(all), await idIn(newest)];
  const noted = await guest('POST', `/api/g/${all}/comments`, {
    name: 'Mia',
    slug: gAll,
    frame: 3,
    text: 'Wie in V1, und wie jetzt',
    refs: [
      { kind: 'frame', video: gAll, v: 1, frame: 10 },
      { kind: 'frame', video: gAll, v: 2, frame: 12 },
    ],
  });
  assert.equal(noted.status, 200, noted.text);
  const raw = store.loadReview(twice.slug)?.comments.find((c) => c.id === JSON.parse(noted.text).id)?.refs ?? [];
  const old = raw.find((r) => r.v === 1)?.still ?? '';
  const now = raw.find((r) => r.v === 2)?.still ?? '';
  assert.ok(old && now, 'both moments have their stills');

  const refsOn = async (token: string, gid: string) => {
    const review = JSON.parse((await guest('GET', `/api/g/${token}/review/${gid}`)).text);
    return review.notes.find((n: { text: string }) => n.text.startsWith('Wie in V1')).refs as { v: number; still: string | null }[];
  };
  const file = (token: string, gid: string, f: string) => guest('GET', `/api/g/${token}/refs/${gid}/${f}`);
  // the link that shows every version: both stills
  assert.ok(
    (await refsOn(all, gAll)).every((r) => r.still),
    'shown where every version is',
  );
  assert.equal((await file(all, gAll, old)).status, 200);
  // the newest-only link: the moment of V1 without its picture, V2's with it
  const seen = await refsOn(newest, gNewest);
  assert.equal(seen.find((r) => r.v === 1)?.still, null, 'no V1 still in the answer');
  assert.ok(seen.find((r) => r.v === 2)?.still, 'the newest version’s still stays');
  assert.equal((await file(newest, gNewest, old)).status, 404, 'nor served by its name');
  assert.equal((await file(newest, gNewest, now)).status, 200);
});

/** Bytes to a one-time upload URL, as the review page sends a file: a fresh request, no cookie, no address of the visit. */
function put(url: string, data: Buffer): Promise<Seen> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'PUT', path: url, headers: { 'content-length': String(data.length) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('latin1'), headers: res.headers }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

// The rest of the guest surface the first crawl didn't reach (A12 GUEST-15): references of every kind and the one-time
// upload URLs with their outcomes, a file the server can't convert, a transcript, the archive's facts, a progress
// report, an agent's status reply on the client's note. None of it names the owner's machine, the folders above the
// link, another client's video, or the agent's own name.
test('references, upload URLs, transcripts, the archive and agents’ replies name nothing of the owner’s', async () => {
  const { token } = JSON.parse(
    (await request('POST', '/api/folder-shares', { folder: 'Acme', download: 'original', notes: 'all', versions: 'all', label: 'Rest' })).text,
  );
  surface.length = 0;
  fetched.clear();
  const room = await guest('GET', `/api/g/${token}`);
  const id = JSON.parse(room.text).videos[0].slug as string;
  const noted = await guest('POST', `/api/g/${token}/comments`, {
    name: 'Mia',
    slug: id,
    frame: 4,
    text: 'Wie auf dem Bild',
    refs: [
      { kind: 'link', url: 'https://example.com/look' },
      { kind: 'frame', video: id, frame: 6 },
    ],
  });
  assert.equal(noted.status, 200, noted.text);
  const note = JSON.parse(noted.text).id as string;

  // a picture through the one-time URL, and its outcome
  const png = path.join(dir, 'look.png');
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64', '-frames:v', '1', '-y', png]);
  const ticket = await guest('POST', `/api/g/${token}/comments/${note}/refs`, { name: 'Mia', kind: 'image' });
  assert.equal(ticket.status, 200, ticket.text);
  const url = new URL(JSON.parse(ticket.text).upload.url, 'http://x').pathname;
  const landed = await put(url, fs.readFileSync(png));
  surface.push(String(landed.status), JSON.stringify(landed.headers), landed.text);
  assert.equal(landed.status, 200, landed.text);
  await guest('GET', url);
  // a "clip" no tool can read: the answer is the server's sentence, never the tool's words, paths or addresses
  const clip = await guest('POST', `/api/g/${token}/comments/${note}/refs`, { name: 'Mia', kind: 'clip' });
  const broken = await put(new URL(JSON.parse(clip.text).upload.url, 'http://x').pathname, Buffer.from('not a video at all, just words'.repeat(40)));
  surface.push(String(broken.status), JSON.stringify(broken.headers), broken.text);
  assert.ok(broken.status >= 400, `refused: ${broken.status}`);
  for (const tool of ['ffmpeg', 'ffprobe', 'exited', '@ 0x', 'Invalid data']) assert.ok(!broken.text.includes(tool), `no tool output: ${broken.text}`);

  // an agent answers the client's note: shown as the editor, never by the agent's own name
  store.updateComment(note, { status: 'fixed', note: 'The logo sits higher now', by: 'agent:acme-edit-session' });
  await guest('POST', `/api/g/${token}/progress`, { visitor: 'browser-mia-0001', slug: id, v: 1, seen: '1'.padEnd(25, '0'), secs: 1 });
  for (const p of [
    `/api/g/${token}/review/${id}`,
    `/api/g/${token}/review/${id}/transcript`,
    `/api/g/${token}/archive/info`,
    `/api/g/${token}/refs/${id}/nothing.jpg`,
  ])
    await crawl((await guest('GET', p)).text);
  const review = JSON.parse((await guest('GET', `/api/g/${token}/review/${id}`)).text);
  const shown = review.notes.find((n: { id: string }) => n.id === note);
  assert.ok(
    shown.refs.some((r: { kind: string }) => r.kind === 'image') && shown.refs.some((r: { kind: string }) => r.kind === 'frame'),
    'the references are there',
  );
  assert.ok(
    shown.replies.some((r: { by: string; status?: string }) => r.by === 'editor' && r.status === 'fixed'),
    'the agent as the editor',
  );

  assert.ok(fetched.size >= 4, `crawled the guest URLs (${fetched.size})`);
  const all = surface.join('\n');
  for (const secret of [dir, HOME, 'olivia-home', 'Clients', 'Globex', spot.slug, teaser.slug, other.slug, 'acme-edit-session', 'agent:', path.basename(dir)]) {
    const at = all.indexOf(secret);
    assert.ok(at < 0, `a visitor must never see ${JSON.stringify(secret)}: …${all.slice(Math.max(0, at - 300), at + 80)}…`);
  }
});

// What a link says of a version: its number, when it came and its frame size (a note's marked frame keeps its room on
// the page before the picture arrives); never its file, hash, size on disk or source. A newest-only link names the newest alone.
test('a link says of each version its number, when it came and its frame size, nothing more', async () => {
  const resized = track('Clients/Acme/Resized/export/resized.mp4', 'Acme/Resized');
  makeVideo(resized.file, { w: 90, h: 160, dur: 1, freq: 880 });
  age(resized.file);
  assert.equal(store.sync(resized.slug)?.review.versions.length, 2, 'two versions');
  const make = async (body: object) => JSON.parse((await request('POST', '/api/folder-shares', { folder: 'Acme/Resized', ...body })).text).token as string;
  const versionsOn = async (token: string) => {
    const id = JSON.parse((await guest('GET', `/api/g/${token}`)).text).videos[0].slug as string;
    return JSON.parse((await guest('GET', `/api/g/${token}/review/${id}`)).text).versions as { v: number; width?: number; height?: number }[];
  };
  const all = await versionsOn(await make({ versions: 'all', label: 'Every size' }));
  const newest = await versionsOn(await make({ label: 'Newest size' }));
  const sizes = (list: typeof all) => list.map(({ v, width, height }) => ({ v, width, height }));
  assert.deepEqual(sizes(all), [
    { v: 1, width: 160, height: 90 },
    { v: 2, width: 90, height: 160 },
  ]);
  assert.deepEqual(sizes(newest), [{ v: 2, width: 90, height: 160 }]);
  for (const x of [...all, ...newest]) assert.deepEqual(Object.keys(x).sort(), ['height', 'registered', 'v', 'width'], `nothing else: ${JSON.stringify(x)}`);
});

// Compare on a review link (web/src/guest/GuestCompare.tsx) plays another version beside the one on screen. Its route
// answers only links that show every version, about a version such a link shows, with what a player needs — the frame
// facts and the link's own media URL for it (which plays like the page's) — never notes, a verdict, a download, a file or
// a hash. A newest-only link has no compare at all and hands out no other version's media, by this route or by the
// media URL itself.
test('compare: a link that shows every version plays another one beside it; a newest-only link has none', async () => {
  const both = track('Clients/Acme/Compared/export/compared.mp4', 'Acme/Compared');
  makeVideo(both.file, { w: 160, h: 90, dur: 1, freq: 660 });
  age(both.file);
  assert.equal(store.sync(both.slug)?.review.versions.length, 2, 'two versions');
  const make = async (body: object) => JSON.parse((await request('POST', '/api/folder-shares', { folder: 'Acme/Compared', ...body })).text).token as string;
  const idIn = async (token: string) => JSON.parse((await guest('GET', `/api/g/${token}`)).text).videos[0].slug as string;
  surface.length = 0;
  fetched.clear();

  for (const body of [
    { versions: 'all', label: 'Compare' },
    { versions: 'all', comment: false, approve: false, label: 'Watch and compare' },
    { versions: 'all', download: 'original', label: 'Deliver and compare' },
  ]) {
    const token = await make(body);
    const id = await idIn(token);
    const compare = (v: string) => guest('GET', `/api/g/${token}/review/${id}/compare${v}`);
    // the copy a visitor plays is made on demand: asked again until it is there, as the page does
    const answer = await until(async () => {
      const r = await compare('?v=1');
      assert.equal(r.status, 200, `${body.label}: ${r.text}`);
      const x = JSON.parse(r.text);
      return x.media ? x : null;
    }, `${body.label}: V1's media`);
    assert.deepEqual(Object.keys(answer).sort(), ['fps', 'frames', 'height', 'media', 'v', 'width'], `${body.label}: nothing else: ${JSON.stringify(answer)}`);
    assert.deepEqual([answer.v, answer.width, answer.height, answer.fps], [1, 160, 90, 30], body.label);
    assert.match(answer.media, new RegExp(`^/media/g/${token}/${id}/v1\\?`), `${body.label}: the link's own media URL for V1`);
    const media = await guest('GET', answer.media, undefined, { range: 'bytes=0-1023' });
    assert.ok(media.status === 206 || media.status === 200, `${body.label}: V1 plays through the link (${media.status})`);
    assert.equal((await compare('')).status, 400, `${body.label}: a compare names its version`);
    assert.equal((await compare('?v=9')).status, 404, `${body.label}: a version the video doesn't have`);
    // another video (not in the folder), and a slug from outside the link, are not part of it
    assert.equal((await guest('GET', `/api/g/${token}/review/${encodeURIComponent(other.slug)}/compare?v=1`)).status, 404);
  }

  const newest = await make({ label: 'Newest only' });
  const id = await idIn(newest);
  for (const v of ['?v=1', '?v=2', '']) {
    const r = await guest('GET', `/api/g/${newest}/review/${id}/compare${v}`);
    assert.equal(r.status, 403, `a newest-only link compares nothing (${v || 'no version'}): ${r.status} ${r.text}`);
  }
  assert.equal((await guest('GET', `/media/g/${newest}/${id}/v1`, undefined, { range: 'bytes=0-1023' })).status, 403, 'nor plays V1 by its URL');
  assert.ok(!JSON.parse((await guest('GET', `/api/g/${newest}/review/${id}`)).text).versions.some((x: { v: number }) => x.v === 1), 'nor names V1');

  const all = surface.join('\n');
  for (const secret of [dir, HOME, 'olivia-home', 'Clients', both.slug, 'hash', 'versions/']) {
    const at = all.indexOf(secret);
    assert.ok(at < 0, `a visitor must never see ${JSON.stringify(secret)}: …${all.slice(Math.max(0, at - 300), at + 80)}…`);
  }
});

// A watch-only link that kept "notes from all links" showed its visitors every other link's notes and names while the
// dialog said it doesn't (A13 LINK-2): a link that only plays shows no one else's notes or decisions.
test('a watch-only link shows no other link’s notes, whatever its notes setting says', async () => {
  const enc = encodeURIComponent(teaser.slug);
  const legal = JSON.parse((await request('POST', `/api/review/${enc}/shares`, { label: 'Legal' })).text);
  const legalVideo = JSON.parse((await guest('GET', `/api/g/${legal.token}`)).text).videos[0].slug;
  const said = await guest('POST', `/api/g/${legal.token}/comments`, { name: 'Mia Legal', slug: legalVideo, frame: 2, text: 'legal: do not show the claim' });
  assert.equal(said.status, 200, said.text);
  const press = JSON.parse((await request('POST', `/api/review/${enc}/shares`, { label: 'Press', comment: false, approve: false, notes: 'all' })).text);
  assert.equal(press.notes, 'own', 'a link that only plays keeps its own notes, as the dialog says');
  const room = await guest('GET', `/api/g/${press.token}`);
  const video = JSON.parse(room.text).videos[0].slug;
  const seen = `${room.text}\n${(await guest('GET', `/api/g/${press.token}/review/${video}`)).text}`;
  for (const secret of ['do not show the claim', 'Mia Legal']) assert.ok(!seen.includes(secret), `a watch-only visitor must not see “${secret}”`);
});

// An Embed link's player (/e/<token>) and its oEmbed are what any site that frames it, and anyone who asks oEmbed about
// it, can read: the video's name and nothing else of the owner's — no slug or path, no folder, not the link's own name,
// no other link's notes or names, nor who shared it or the team's name, nor when the team worked on it (the video's
// `updated`, a version's `registered`) — on its watch page's routes too, and once it ended.
test('an embed and its oEmbed name the video and nothing else of the owner’s', async () => {
  const enc = encodeURIComponent(spot.slug);
  const other = JSON.parse((await request('POST', `/api/review/${enc}/shares`, { label: 'Legal team' })).text);
  const otherId = JSON.parse((await guest('GET', `/api/g/${other.token}`)).text).videos[0].slug;
  const said = await guest('POST', `/api/g/${other.token}/comments`, { name: 'Ola Other', slug: otherId, frame: 2, text: 'other link secret note' });
  assert.equal(said.status, 200, said.text);
  // the sharer goes by a name of their own now: a review link's visitors read it and the team's name (the control)…
  const auth = await import('../../lib/auth.ts');
  const owner = auth.localOwner();
  assert.ok(owner);
  await auth.updateUser(owner.id, { name: 'Olivia Sharer' });
  const told = JSON.parse((await request('GET', `/api/g/${other.token}`)).text);
  assert.deepEqual([told.label, told.reviewer, told.org], ['Legal team', 'Olivia Sharer', 'Example Studio'], 'a review link names them');
  // …an embed's token never does, whichever of its routes is asked, nor once it has ended
  const made = await request('POST', `/api/review/${enc}/shares`, { label: 'Homepage hero', embed: true });
  assert.equal(made.status, 200, made.text);
  const { token } = JSON.parse(made.text);
  const ended = JSON.parse(
    (await request('POST', `/api/review/${enc}/shares`, { label: 'Spring campaign hero', embed: true, expires: new Date(Date.now() - 60_000).toISOString() }))
      .text,
  );
  surface.length = 0;
  fetched.clear();

  const page = await guest('GET', `/e/${token}`);
  assert.equal(page.status, 200);
  const discovery = /type="application\/json\+oembed" href="([^"]+)"/.exec(page.text)?.[1]?.replace(/&amp;/g, '&');
  assert.ok(discovery, 'the page names its oEmbed');
  const answer = await until(async () => {
    const r = await guest('GET', `/api/g/${token}/embed`);
    assert.equal(r.status, 200, r.text);
    const d = JSON.parse(r.text);
    return d.media ? d : null;
  }, 'the player’s media');
  await crawl(JSON.stringify(answer));
  await guest('POST', `/api/g/${token}/visit`, { visitor: 'embed-privacy-01', slug: answer.slug, v: answer.v });
  await guest('POST', `/api/g/${token}/progress`, { visitor: 'embed-privacy-01', slug: answer.slug, v: answer.v, seen: '1'.padEnd(25, '0'), secs: 1 });
  const asked = new URL(discovery as string);
  const oembed = await guest('GET', asked.pathname + asked.search);
  assert.equal(oembed.status, 200, oembed.text);
  await crawl(oembed.text);
  await guest('GET', `/oembed?url=${encodeURIComponent(`http://127.0.0.1/g/${token}`)}`);
  // its watch page (/g/<token>, which oEmbed and the page's head name too) and what that page asks
  await guest('GET', `/g/${token}`);
  const room = await guest('GET', `/api/g/${token}`);
  assert.equal(room.status, 200, room.text);
  const link = JSON.parse(room.text);
  assert.deepEqual([link.label, link.reviewer, link.org], ['', null, null], 'no link name, sharer or team');
  assert.ok(!link.videos.some((v: object) => 'updated' in v), 'nor when the video last changed');
  await crawl(room.text);
  const watch = await guest('GET', `/api/g/${token}/review/${answer.slug}`);
  assert.equal(watch.status, 200, watch.text);
  const video = JSON.parse(watch.text);
  assert.deepEqual([video.label, video.reviewer, video.org], ['', null, null]);
  assert.ok(video.versions.length, 'it lists the version it plays');
  for (const x of video.versions) assert.deepEqual(Object.keys(x).sort(), ['height', 'v', 'width'], `nor when a version came: ${JSON.stringify(x)}`);
  await crawl(watch.text);
  // an embed that ended says so and names nobody to ask
  for (const url of [`/api/g/${ended.token}`, `/api/g/${ended.token}/review/${answer.slug}`, `/api/g/${ended.token}/embed`]) {
    const r = await guest('GET', url);
    assert.equal(r.status, 410, `${url}: ${r.text}`);
    assert.equal(JSON.parse(r.text).by, undefined, r.text);
  }

  assert.ok(fetched.size >= 3, `crawled the player’s URLs (${fetched.size})`);
  const all = surface.join('\n');
  assert.ok(all.includes('spot.mp4'), 'the video’s name is its title');
  const came = store.loadReview(spot.slug)?.versions.at(-1)?.registered;
  assert.ok(came);
  for (const secret of [
    came,
    dir,
    HOME,
    'olivia-home',
    'Clients',
    'Acme',
    'Reels',
    'Globex',
    spot.slug,
    teaser.slug,
    other.slug,
    'other link secret note',
    'Ola Other',
    'Legal team',
    'Homepage hero',
    'Spring campaign hero',
    'Olivia Sharer',
    'Example Studio',
    'tester',
    path.basename(dir),
  ]) {
    const at = all.indexOf(secret);
    assert.ok(at < 0, `an embed must never show ${JSON.stringify(secret)}: …${all.slice(Math.max(0, at - 300), at + 80)}…`);
  }
});
