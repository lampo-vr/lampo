// What a review link's visitors can make the server keep, and what it costs: every per-visitor and per-link record is
// bounded (count and size), a visitor can add only so many new ones, a progress report never rewrites shares.json
// (what visitors do is written in one batch at most every few seconds; reads see it at once), and the in-memory maps
// behind visits, views, names and the built UI's files stay bounded however many made-up keys arrive.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { age, FFMPEG, isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { client, type Request } from '../lib/http.ts';

const { dir } = isolatedEnv();
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const store = await import('../../lib/store.ts');
const folders = await import('../../lib/folders.ts');
const shares = await import('../../lib/shares.ts');
const watch = await import('../../lib/watch.ts');
const { DATA, slugify } = await import('../../lib/paths.ts');
const { addressKey, RateLimit, Recent } = await import('../../lib/rateLimit.ts');
const { builtFiles, rememberedFiles } = await import('../../server/respond.ts');
const { guestMemory } = await import('../../server/routes/shares/access.ts');

const FILE = path.join(DATA, 'shares.json');
const VIDEOS = 100;

// A folder link over 100 videos (copies of one clip: only the review records matter here).
const base = makeVideo(path.join(dir, 'src', 'base.mp4'), { w: 160, h: 90, dur: 1 });
const slugs: string[] = [];
for (let i = 0; i < VIDEOS; i++) {
  const f = path.join(dir, 'proj', `shot-${String(i).padStart(3, '0')}.mp4`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.copyFileSync(base, f);
  age(f);
  store.createOrGetReview(f, { by: 'tester' });
  slugs.push(slugify(f));
  folders.moveVideo(slugify(f), 'Acme', 'tester');
}

let server: http.Server;
let owner: Request;
let port = 0;
const ctx = createContext({ cfg: loadConfig(), token: 'test-token', loadSessions: async () => [] });
before(async () => {
  server = http.createServer(createApp(ctx));
  // as the app's own server does (server/index.ts): a kept-alive socket isn't closed under a client that waited
  server.keepAliveTimeout = 65_000;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  owner = client(port);
});
after(() => {
  server.closeAllConnections();
  server.close();
});

// A visitor from elsewhere (forwarding headers make a request not the machine's own; locally they don't name the
// address, so every visitor here is one address).
const from = (ip: string) => client(port, { 'x-forwarded-for': ip });
// A visitor through the machine's tunnel: Cloudflare names the address, so visitors here are told apart (ipOf).
const visitor = (ip: string) => client(port, { 'cf-ray': '8f00000000000000-AMS', 'cf-connecting-ip': ip });
const inode = () => fs.statSync(FILE).ino;
async function folderLink(label: string): Promise<{ token: string; ids: string[] }> {
  const l = await owner('POST', '/api/folder-shares', { body: { folder: 'Acme', label } });
  assert.equal(l.status, 200, l.text);
  const room = (await from('203.0.113.1')('GET', `/api/g/${l.json().token}`)).json();
  return { token: l.json().token, ids: room.videos.map((v: { slug: string }) => v.slug) };
}
const seenAll = 'f'.repeat(25);
const plays = Array.from({ length: watch.PARTS }, () => watch.MAX_PLAYS_PER_REPORT);

test('a progress report never rewrites shares.json: what visitors do waits in memory, is seen at once, and is written in one go', async () => {
  const { token, ids } = await folderLink('Beacons');
  shares.flushShareStats();
  const before = inode();
  for (let i = 0; i < 6; i++) {
    const visitor = `browser-beacon-${String(i).padStart(4, '0')}`;
    const r = await from(`198.51.100.${10 + i}`)('POST', `/api/g/${token}/progress`, {
      body: { visitor, slug: ids[i], v: 1, seen: seenAll, plays, secs: 30, name: `Viewer ${i}` },
    });
    assert.equal(r.status, 204, r.text);
  }
  assert.equal(inode(), before, 'six reports, not one write');
  const info = (await owner('GET', `/api/folder-shares?folder=Acme`)).json().shares.find((s: { token: string }) => s.token === token);
  assert.equal(info.activity.visitors.length, 6, 'the owner sees them at once');

  shares.flushShareStats();
  assert.notEqual(inode(), before, 'written once asked to (or after a few seconds by itself)');
  const stored = Object.values(JSON.parse(fs.readFileSync(FILE, 'utf8')).shares).find((s) => (s as { label: string }).label === 'Beacons') as {
    stats: { visitors: object };
  };
  assert.equal(Object.keys(stored.stats.visitors).length, 6);
});

test('a link keeps a bounded record however many visitors watch how many videos', async () => {
  const { token } = await folderLink('Crowd');
  const share = shares.resolveShare(token);
  assert.ok(share);
  // 50 visitors on each of 100 videos, through what the progress route calls: 5,000 watch records before.
  for (let w = 0; w < 50; w++)
    for (const slug of slugs)
      shares.recordWatch(token, slug, shares.visitorKey(share, `browser-crowd-${String(w).padStart(4, '0')}`), {
        v: 1,
        seen: seenAll,
        plays,
        secs: 120,
        name: 'A visitor name forty characters long xx',
      });
  for (let i = 0; i < 400; i++) shares.recordVisit(token, { open: true, name: 'x'.repeat(40), visitor: `v${i}`, act: { kind: 'open', name: 'x'.repeat(40) } });
  shares.flushShareStats();

  const link = Object.values(JSON.parse(fs.readFileSync(FILE, 'utf8')).shares).find((s) => (s as { label: string }).label === 'Crowd') as {
    stats: { visitors: object; videos: Record<string, { watch?: object }>; activity: unknown[]; reviewers: unknown[] };
  };
  const records = Object.values(link.stats.videos).reduce((n, v) => n + Object.keys(v.watch || {}).length, 0);
  assert.ok(records <= shares.SHARE_LIMITS.watchRecords, `${records} watch records`);
  assert.ok(Object.keys(link.stats.visitors).length <= shares.SHARE_LIMITS.visitors);
  assert.ok(Object.keys(link.stats.videos).length <= shares.SHARE_LIMITS.videos);
  assert.ok(link.stats.activity.length <= 200);
  const bytes = Buffer.byteLength(JSON.stringify(link));
  assert.ok(bytes < 400_000, `one link at its limits takes ${Math.round(bytes / 1024)} KB (13 MB before)`);
  assert.ok(fs.statSync(FILE).size < 600_000, `shares.json: ${Math.round(fs.statSync(FILE).size / 1024)} KB`);
  // the newest records are the ones kept
  const info = (await owner('GET', `/api/folder-shares?folder=Acme`)).json().shares.find((s: { token: string }) => s.token === token);
  assert.ok(info.activity.videos.length > 0);
});

test('a visitor can only bring so many new visitor ids per hour: made-up ids stop adding records', async () => {
  const { token, ids } = await folderLink('Made up');
  const one = from('192.0.2.50');
  const codes: number[] = [];
  for (let i = 0; i < 30; i++)
    codes.push(
      (
        await one('POST', `/api/g/${token}/progress`, {
          body: { visitor: `made-up-id-${String(i).padStart(4, '0')}`, slug: ids[0], v: 1, seen: seenAll, secs: 1 },
        })
      ).status,
    );
  assert.ok(codes.includes(429), codes.join(','));
  assert.equal(codes.filter((c) => c === 204).length, shares.SHARE_LIMITS.newVisitorsPerHour);
  // a visit with yet another made-up id still counts as an open, without a new visitor record
  assert.equal((await one('POST', `/api/g/${token}/visit`, { body: { visitor: 'made-up-id-9999' } })).status, 200);
  const info = (await owner('GET', `/api/folder-shares?folder=Acme`)).json().shares.find((s: { token: string }) => s.token === token);
  assert.equal(info.activity.visitors.length, shares.SHARE_LIMITS.newVisitorsPerHour);
  // a visitor the link knows keeps reporting
  const known = await one('POST', `/api/g/${token}/progress`, { body: { visitor: 'made-up-id-0000', slug: ids[1], v: 1, seen: seenAll, secs: 1 } });
  assert.equal(known.status, 204);
});

test('a link takes no notes once the disk is low, and a video takes so many client notes, not more', async () => {
  const { token, ids } = await folderLink('Notes');
  const guest = from('203.0.113.60');
  const cfg = loadConfig();
  const full = http.createServer(
    createApp(createContext({ cfg: { ...cfg, min_free_bytes: Number.MAX_SAFE_INTEGER }, token: 'test-token', loadSessions: async () => [] })),
  );
  await new Promise<void>((r) => full.listen(0, '127.0.0.1', r));
  try {
    const low = client((full.address() as AddressInfo).port, { 'x-forwarded-for': '203.0.113.60' });
    const r = await low('POST', `/api/g/${token}/comments`, { body: { name: 'Mia', slug: ids[1], frame: 3, text: 'too much' } });
    assert.equal(r.status, 507, r.text);
  } finally {
    full.closeAllConnections();
    full.close();
  }
  // a video that holds as many client notes through this link as a link may add (copies of one, written straight
  // into its review)
  const slug = slugs[2] as string;
  const here = shares.shareId(shares.resolveShare(token) as NonNullable<ReturnType<typeof shares.resolveShare>>);
  const one = store.addComment(slug, { frame: 0, text: 'n', author: 'guest:Mia', scope: 'video', share: here });
  store.mutate(slug, (r) => {
    for (let i = 1; i < shares.SHARE_LIMITS.guestNotesPerVideo; i++) r.comments.push({ ...one, id: `c_${(0xf0000000 + i).toString(16)}` });
  });
  const refused = await guest('POST', `/api/g/${token}/comments`, { body: { name: 'Mia', slug: ids[2], scope: 'video', text: 'one more' } });
  assert.equal(refused.status, 409, refused.text);
  const elsewhere = await guest('POST', `/api/g/${token}/comments`, { body: { name: 'Mia', slug: ids[3], scope: 'video', text: 'fine here' } });
  assert.equal(elsewhere.status, 200, elsewhere.text);
  // another link to the same video counts its own notes: one link at its limit closes no other
  const other = await folderLink('Notes too');
  const there = await guest('POST', `/api/g/${other.token}/comments`, { body: { name: 'Max', slug: other.ids[2], scope: 'video', text: 'mine' } });
  assert.equal(there.status, 200, there.text);
});

test('a day’s notes count only what landed: refused posts spend nobody’s share; a visitor, then the link, stop at theirs', async () => {
  const { token, ids } = await folderLink('Daily');
  const mem = guestMemory.get(ctx);
  assert.ok(mem, 'the app lists what its link routes keep');
  const visitorDay = mem.writesPerVisitorDay as InstanceType<typeof RateLimit>;
  const linkDay = mem.writesPerLinkDay as InstanceType<typeof RateLimit>;
  const note = (who: Request, name: string, n: number) =>
    who('POST', `/api/g/${token}/comments`, { body: { name, slug: ids[5 + (n % 20)], scope: 'video', text: `note ${n}` } });

  // Someone with the link sends 60 posts that are refused (no text, no mark): nothing lands, the team sees nothing…
  const stranger = visitor('198.51.100.66');
  const codes = new Set<number>();
  for (let i = 0; i < 60; i++) codes.add((await stranger('POST', `/api/g/${token}/comments`, { body: { name: 'X', slug: ids[4] } })).status);
  assert.deepEqual([...codes].sort(), [400, 429], 'refused, then slowed down: only its sender');
  // …and the client, from another address, writes as before.
  const mia = visitor('203.0.113.77');
  assert.equal((await note(mia, 'Mia', 0)).status, 200);

  // A visitor's share for the day: what landed counts (the rest of Mia's day stood in for), then 429 for her alone.
  const who = `${token}|203.0.113.77`;
  for (let i = 2; i < shares.SHARE_LIMITS.guestWritesPerDay; i++) visitorDay.hit(who);
  assert.equal((await note(mia, 'Mia', 1)).status, 200, 'her last one today');
  const over = await note(mia, 'Mia', 2);
  assert.equal(over.status, 429, over.text);
  assert.match(over.text, /from you today/);
  assert.equal((await note(visitor('203.0.113.78'), 'Max', 3)).status, 200, 'another visitor of the link still writes');

  // The link's ceiling, whoever the visitors are: three notes landed today (the refused posts and Mia's 429 are not
  // among them), the rest of the day stood in for — the last one lands, the next is refused.
  for (let i = 3; i < shares.SHARE_LIMITS.guestWritesPerLinkDay - 1; i++) linkDay.hit(token);
  assert.equal((await note(visitor('203.0.113.79'), 'Ana', 4)).status, 200, 'the link’s last one today: nothing refused was counted');
  const full = await note(visitor('203.0.113.80'), 'Ben', 5);
  assert.equal(full.status, 429, full.text);
  assert.match(full.text, /This link has taken all the notes it can for today/);
});

test('reference upload URLs count when their file lands, and an IPv6 /64 is one visitor (A12 VE2b-2)', async () => {
  const { token, ids } = await folderLink('Tickets');
  const mem = guestMemory.get(ctx);
  assert.ok(mem);
  const linkDay = mem.writesPerLinkDay as InstanceType<typeof RateLimit>;
  const v6 = (n: number) => visitor(`2001:db8:1:1::${(n + 2).toString(16)}`);
  const note = await v6(0)('POST', `/api/g/${token}/comments`, { body: { name: 'Mia', slug: ids[30], scope: 'video', text: 'see the picture' } });
  assert.equal(note.status, 200, note.text);
  const id = note.json().id as string;
  // 80 addresses of one /64 asking for upload URLs as fast as they can: one visitor, held to its minute's rate
  const codes: number[] = [];
  const urls: string[] = [];
  for (let n = 1; n <= 80; n++) {
    const r = await v6(n)('POST', `/api/g/${token}/comments/${id}/refs`, { body: { name: 'Mia', kind: 'image' } });
    codes.push(r.status);
    if (r.status === 200) urls.push(r.json().upload.url);
  }
  assert.ok(codes.filter((c) => c === 200).length < 30, `one /64, one visitor: ${codes.filter((c) => c === 200).length} URLs`);
  assert.ok(codes.includes(429));
  // none of them was used: the link's day is untouched — the rest of the day stood in for, its last note still lands
  for (let i = 1; i < shares.SHARE_LIMITS.guestWritesPerLinkDay - 1; i++) linkDay.hit(token);
  const last = await visitor('203.0.113.120')('POST', `/api/g/${token}/comments`, {
    body: { name: 'Ben', slug: ids[31], scope: 'video', text: 'still taken' },
  });
  assert.equal(last.status, 200, `unused upload URLs spent nothing: ${last.text}`);
  // a URL whose file arrives counts like any reference: now the link is at its day's end
  const png = path.join(dir, 'ticket.png');
  if (!fs.existsSync(png)) execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64', '-frames:v', '1', '-y', png]);
  const bytes = fs.readFileSync(png);
  const put = await from('203.0.113.121')('PUT', urls[0] as string, { body: bytes, headers: { 'content-length': String(bytes.length) } });
  assert.equal(put.status, 200, put.text);
  const over = await visitor('203.0.113.122')('POST', `/api/g/${token}/comments`, { body: { name: 'Ana', slug: ids[32], scope: 'video', text: 'one more' } });
  assert.equal(over.status, 429, over.text);
});

test('an address counts as itself (IPv4), or as its /64 (IPv6)', () => {
  assert.equal(addressKey('203.0.113.7'), '203.0.113.7');
  assert.equal(addressKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(addressKey('2001:db8:1:1::2'), '2001:db8:1:1::/64');
  assert.equal(addressKey('2001:0db8:0001:0001:aaaa:bbbb:cccc:dddd'), '2001:db8:1:1::/64');
  assert.equal(addressKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(addressKey('fe80::1%en0'), 'fe80:0:0:0::/64');
  assert.equal(addressKey('unknown'), 'unknown');
});

test('every map a link’s routes keep, keyed by what visitors send, is bounded and is the one requests fill', async () => {
  const { token, ids } = await folderLink('Maps');
  const mem = guestMemory.get(ctx);
  assert.ok(mem);
  const names = Object.keys(mem).sort();
  for (const want of ['visits', 'views', 'names', 'announced', 'downloads', 'archives', 'notesPerVisitor', 'writesPerVisitorDay', 'newVisitors'])
    assert.ok(names.includes(want), `${want} is listed: ${names.join(', ')}`);
  // the live maps: a visit, a view and a name land in them
  const before = { visits: mem.visits.size, views: mem.views.size, names: mem.names.size };
  const ana = visitor('192.0.2.140');
  assert.equal((await ana('POST', `/api/g/${token}/visit`, { body: { name: 'Ana' } })).status, 200);
  assert.equal((await ana('GET', `/api/g/${token}/review/${ids[0]}`)).status, 200);
  assert.equal(mem.visits.size, before.visits + 1, 'the visit is in the map listed');
  assert.equal(mem.views.size, before.views + 1, 'the view is in the map listed');
  assert.equal(mem.names.size, before.names + 1, 'the name is in the map listed');
  // bounded: a Recent keeps 10,000, a RateLimit 50,000 keys, however many made-up ones arrive
  for (const [name, map] of Object.entries(mem)) {
    if (map instanceof Recent) {
      for (let i = 0; i < 10_050; i++) map.set(`made-up|${i}`, 0);
      assert.ok(map.size <= 10_000, `${name}: ${map.size} entries`);
    } else if (map instanceof RateLimit) {
      for (let i = 0; i < 50_050; i++) map.hit(`made-up|${i}`);
      assert.ok(map.size <= 50_000, `${name}: ${map.size} keys`);
    } else assert.fail(`${name} is neither a Recent nor a RateLimit: a bare map grows with every made-up key`);
  }
});

test('in-memory maps keyed by what visitors send stay bounded', () => {
  const seen = new Recent<number>(3);
  for (let i = 0; i < 10; i++) seen.set(`k${i}`, i);
  assert.equal(seen.size, 3);
  assert.deepEqual([seen.get('k7'), seen.get('k8'), seen.get('k9'), seen.get('k0')], [7, 8, 9, undefined], 'the oldest go first');
  seen.set('k7', 70);
  seen.set('k10', 10);
  assert.equal(seen.get('k7'), 70, 'setting again makes it the newest');
  assert.equal(seen.get('k8'), undefined);

  // the built UI's files: a signed-out GET for a made-up path (any one is public) leaves nothing behind
  const dist = path.join(dir, 'dist');
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'x');
  const serve = builtFiles(dist, /sw\.js$/);
  const res = { type() {}, setHeader() {}, sendFile() {} } as never;
  let passed = 0;
  serve({ method: 'GET', path: '/assets/app.js', headers: {} } as never, res, () => passed++);
  const known = rememberedFiles();
  for (let i = 0; i < 10_000; i++) serve({ method: 'GET', path: `/made-up-${i}.js`, headers: { 'accept-encoding': 'br' } } as never, res, () => passed++);
  assert.equal(rememberedFiles(), known, 'misses are not remembered');
  assert.equal(passed, 10_001, 'all fall through to the app');
});
