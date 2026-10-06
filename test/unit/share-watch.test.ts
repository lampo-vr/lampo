// Tracking through review links: how far visitors watched (hundredths of a version, lib/watch.ts), who they are (a key
// from their browser's random id, never an address), what they did (the link's activity), and what isn't recorded:
// the team's own previews. A browser's Do Not Track or Global Privacy Control signal changes nothing (decided
// 2026-10-03): such a visitor is recorded like any other.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, slugOf } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const watch = await import('../../lib/watch.ts');
const store = await import('../../lib/store.ts');
const folders = await import('../../lib/folders.ts');
const { DATA } = await import('../../lib/paths.ts');
const { flushShareStats } = await import('../../lib/shares.ts');
const { shareSignal } = await import('../../lib/stageContext.ts');

// ---------------------------------------------------------------- the parts of a version (browser-safe)

test('parts: a moment falls in its hundredth; the encoding round-trips and ORs', () => {
  assert.equal(watch.partOf(0, 10), 0);
  assert.equal(watch.partOf(4.99, 10), 49);
  assert.equal(watch.partOf(10, 10), 99, 'the very end is the last part');
  assert.equal(watch.partOf(3, 0), 0, 'no length: part 0, never NaN');
  const seen = watch.encodeParts([0, 1, 2, 50, 99, 150, -1, 2.5]);
  assert.match(seen, watch.SEEN_PATTERN);
  assert.deepEqual(watch.decodeParts(seen), [0, 1, 2, 50, 99], 'out of range and fractional parts are dropped');
  assert.deepEqual(watch.decodeParts(watch.orParts(watch.encodeParts([1, 2]), watch.encodeParts([2, 3]))), [1, 2, 3]);
  assert.equal(watch.watchedOf(watch.encodeParts(Array.from({ length: 80 }, (_, i) => i))), 0.8);
  assert.deepEqual(watch.decodeParts('not hex'), []);
});

test('merging reports: parts add up per version, a newer version starts over, an older one is ignored, seconds are capped', () => {
  const at = '2026-09-29T12:00:00+02:00';
  const a = watch.mergeWatch(undefined, { v: 2, seen: watch.encodeParts([0, 1]), secs: 10, at, name: 'Mia' });
  const b = watch.mergeWatch(a, { v: 2, seen: watch.encodeParts([1, 2]), secs: 5, at });
  assert.deepEqual(watch.decodeParts(b?.seen), [0, 1, 2]);
  assert.equal(b?.secs, 15);
  assert.equal(b?.name, 'Mia', 'the name stays once given');
  assert.equal(watch.mergeWatch(b, { v: 1, seen: watch.encodeParts([9]), secs: 5, at }), b, 'a report on an older version changes nothing');
  const c = watch.mergeWatch(b, { v: 3, seen: watch.encodeParts([7]), secs: 9999, at });
  assert.deepEqual(watch.decodeParts(c?.seen), [7], 'a newer version starts over');
  assert.equal(c?.secs, watch.MAX_SECS_PER_REPORT, 'one report adds at most MAX_SECS_PER_REPORT');
});

test('heat and the furthest viewer count only the version asked about', () => {
  const at = '2026-09-29T12:00:00+02:00';
  const ws = [
    { v: 2, seen: watch.encodeParts([0, 1, 2, 3]), secs: 4, last: at },
    { v: 2, seen: watch.encodeParts([2, 3]), secs: 2, last: at },
    { v: 1, seen: watch.encodeParts([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), secs: 9, last: at },
  ];
  const heat = watch.heatOf(ws, 2);
  assert.equal(heat.length, watch.PARTS);
  assert.deepEqual(heat.slice(0, 5), [1, 1, 2, 2, 0]);
  assert.equal(watch.bestWatched(ws, 2), 0.04);
  assert.deepEqual(watch.heatOf(ws, 3), [], 'nobody watched v3');
  assert.equal(watch.bestWatched(ws, 3), null);
});

// ---------------------------------------------------------------- over HTTP

function track(rel: string, folder: string | null): string {
  const file = makeVideo(path.join(dir, rel), { w: 160, h: 90, dur: 1 });
  age(file);
  store.createOrGetReview(file, { by: 'tester' });
  const slug = slugOf(file);
  if (folder) folders.moveVideo(slug, folder, 'tester');
  return slug;
}
const spot = track('proj/export/spot.mp4', 'Acme/Reels');
track('proj/export/cut.mp4', 'Acme/Reels');

const { port } = await startApp({ token: 'test-token', loadSessions: async () => [] });

function request(method: string, url: string, { body, headers = {} }: { body?: unknown; headers?: Record<string, string> } = {}) {
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
  return new Promise<{ status: number; text: string; json: () => any }>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, method, path: url, headers: { ...(data !== undefined ? { 'content-type': 'application/json' } : {}), ...headers } },
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
    req.end(data);
  });
}
// Visitors from elsewhere (the machine's own loopback requests are the owner previewing, which doesn't count).
const from = (ip: string, extra: Record<string, string> = {}) => ({ 'x-forwarded-for': ip, ...extra });
const guest = (method: string, url: string, body?: unknown, headers: Record<string, string> = from('203.0.113.9')) => request(method, url, { body, headers });
const enc = encodeURIComponent;
const infoOf = async (token: string) =>
  (await request('GET', `/api/review/${enc(spot)}/shares`)).json().shares.find((s: { token: string }) => s.token === token);

async function folderLink(label: string) {
  const r = await request('POST', '/api/folder-shares', { body: { folder: 'Acme/Reels', label } });
  assert.equal(r.status, 200, r.text);
  const l = r.json();
  const room = (await guest('GET', `/api/g/${l.token}`)).json();
  const gid = room.videos.find((v: { name: string }) => v.name === 'spot.mp4').slug;
  return { token: l.token as string, gid: gid as string };
}
const progress = (token: string, body: object, headers?: Record<string, string>) => guest('POST', `/api/g/${token}/progress`, body, headers);

test('a visitor who watches: the owner sees who, how far (the furthest viewer and a heat strip) and for how long', async () => {
  const { token, gid } = await folderLink('Watchers');
  await guest('POST', `/api/g/${token}/visit`, { name: 'Mia', visitor: 'browser-mia-0001' });
  await guest('GET', `/api/g/${token}/review/${gid}`);
  const first = watch.encodeParts(Array.from({ length: 40 }, (_, i) => i));
  assert.equal((await progress(token, { visitor: 'browser-mia-0001', slug: gid, v: 1, seen: first, secs: 12, name: 'Mia' })).status, 204);
  const more = watch.encodeParts(Array.from({ length: 40 }, (_, i) => 30 + i));
  assert.equal((await progress(token, { visitor: 'browser-mia-0001', slug: gid, v: 1, seen: more, secs: 8, name: 'Mia' })).status, 204);
  // a second visitor, from the same office address: told apart by their browser, not their address
  await guest('POST', `/api/g/${token}/visit`, { name: 'Jonas', visitor: 'browser-jonas-01' });
  await progress(token, { visitor: 'browser-jonas-01', slug: gid, v: 1, seen: watch.encodeParts([0, 1, 2, 3, 4]), secs: 2, name: 'Jonas' });

  const info = await infoOf(token);
  assert.equal(info.stats.videos, undefined, 'the raw records stay on the server');
  const a = info.activity;
  assert.deepEqual(a.visitors.map((v: { name: string }) => v.name).sort(), ['Jonas', 'Mia']);
  const mia = a.visitors.find((v: { name: string }) => v.name === 'Mia');
  assert.equal(mia.secs, 20);
  const video = a.videos.find((v: { name: string }) => v.name === 'spot.mp4');
  assert.equal(video.watched, 0.7, 'Mia played the first 70 %');
  assert.equal(video.heat.length, watch.PARTS);
  assert.deepEqual(video.heat.slice(0, 6), [2, 2, 2, 2, 2, 1], 'both played the opening');
  assert.equal(video.heat[69], 1);
  assert.equal(video.heat[70], 0);
  assert.deepEqual(
    video.viewers.map((v: { name: string; watched: number }) => [v.name, v.watched]),
    [
      ['Mia', 0.7],
      ['Jonas', 0.05],
    ],
  );
  assert.ok(a.events.some((e: { kind: string; video: string }) => e.kind === 'view' && e.video === 'spot.mp4'));
  assert.ok(
    a.events.some((e: { kind: string }) => e.kind === 'open'),
    'a folder link logs the room being opened',
  );

  // shares.json holds keys derived from the ids, never the ids or an address
  flushShareStats(); // what visitors did is written in batches: on disk now
  const raw = fs.readFileSync(path.join(DATA, 'shares.json'), 'utf8');
  assert.ok(!raw.includes('browser-mia-0001') && !raw.includes('203.0.113.9'), 'no browser id or address on disk');

  // the review link's signal says how far the newest version got, and who got there
  const sig = shareSignal(store.loadReview(spot) as never);
  assert.equal(sig?.watched, 0.7);
  assert.equal(sig?.watched_by, 'Mia');
});

test('Do Not Track / GPC change nothing: the visit, the name, watching and downloads are recorded as for anyone', async () => {
  const made = await request('POST', '/api/folder-shares', { body: { folder: 'Acme/Reels', label: 'Signals', download: 'original' } });
  assert.equal(made.status, 200, made.text);
  const token = made.json().token as string;
  const dnt = from('198.51.100.4', { dnt: '1' });
  const gpc = from('198.51.100.5', { 'sec-gpc': '1' });
  const gid = (await guest('GET', `/api/g/${token}`, undefined, dnt)).json().videos.find((v: { name: string }) => v.name === 'spot.mp4').slug;
  await guest('POST', `/api/g/${token}/visit`, { name: 'Ada', visitor: 'browser-ada-0001' }, dnt);
  await guest('POST', `/api/g/${token}/visit`, { visitor: 'browser-bea-0001' }, gpc);
  assert.equal((await progress(token, { visitor: 'browser-ada-0001', slug: gid, v: 1, seen: watch.encodeParts([0, 1, 2]), secs: 3 }, dnt)).status, 204);
  assert.equal((await guest('GET', `/api/g/${token}/review/${gid}`, undefined, dnt)).status, 200);
  const one = await guest('GET', `/api/g/${token}/download/${gid}/v1?kind=original&name=${enc('Ada')}`, undefined, gpc);
  assert.equal(one.status, 200, one.text.slice(0, 200));
  const info = await infoOf(token);
  assert.equal(info.activity.visitors.length, 2, 'both browsers are told apart');
  assert.ok(info.stats.reviewers.includes('Ada'), `the name is kept with the link: ${JSON.stringify(info.stats.reviewers)}`);
  assert.ok(
    info.activity.videos.some((v: { name: string; watched: number | null }) => v.name === 'spot.mp4' && v.watched !== null),
    'watching is recorded',
  );
  assert.equal(info.stats.downloads, 1);
  assert.equal(info.stats.recent_downloads?.at(-1)?.name, 'Ada', 'the download names who typed their name');
});

test("the team's own preview isn't the client: no watching recorded from the machine or a signed-in account", async () => {
  const { token, gid } = await folderLink('Team');
  const r = await request('POST', `/api/g/${token}/progress`, {
    body: { visitor: 'browser-team-001', slug: gid, v: 1, seen: watch.encodeParts([0]), secs: 1 },
  });
  assert.equal(r.status, 204);
  assert.deepEqual((await infoOf(token)).activity.visitors, []);
});

test('reports are checked: shape, the link’s own videos and versions, other sites, and how often', async () => {
  const { token, gid } = await folderLink('Checked');
  const ok = { visitor: 'browser-chk-0001', slug: gid, v: 1, seen: watch.encodeParts([0]), secs: 1 };
  assert.equal((await progress(token, { ...ok, seen: 'zz' })).status, 400, 'parts must be 25 hex digits');
  assert.equal((await progress(token, { ...ok, visitor: 'x' })).status, 400, 'a visitor id has a shape');
  assert.equal((await progress(token, { ...ok, extra: 1 })).status, 400, 'nothing else rides along');
  assert.equal((await progress(token, { ...ok, slug: 'v_AAAAAAAAAAAAAAAA' })).status, 404, 'only videos the link covers');
  assert.equal((await progress(token, { ...ok, v: 9 })).status, 404, 'only versions that exist');
  assert.equal((await progress(token, ok, from('203.0.113.9', { origin: 'https://evil.example' }))).status, 403, 'not from another site');
  assert.equal((await progress('A'.repeat(24), ok)).status, 404, 'not for unknown links');
  let limited = 0;
  for (let i = 0; i < 16; i++) if ((await progress(token, ok, from('203.0.113.77'))).status === 429) limited++;
  assert.ok(limited > 0, 'a visitor sends at most a few reports a minute');
});

test('the activity keeps what visitors did, newest first: notes, ideas, checks, verdicts', async () => {
  const { token, gid } = await folderLink('Log');
  await guest('POST', `/api/g/${token}/comments`, { name: 'Mia', slug: gid, frame: 3, text: 'Logo später' });
  await guest('POST', `/api/g/${token}/comments`, { name: 'Mia', slug: gid, frame: 5, text: 'Maybe blue?', idea: true });
  await guest('POST', `/api/g/${token}/approval`, { name: 'Mia', slug: gid, v: 1, status: 'changes' });
  const events = (await infoOf(token)).activity.events.map((e: { kind: string; detail?: string; name?: string }) => [e.kind, e.detail ?? null, e.name]);
  assert.deepEqual(events.slice(0, 3), [
    ['approval', 'changes', 'Mia'],
    ['note', 'idea', 'Mia'],
    ['note', null, 'Mia'],
  ]);
});
