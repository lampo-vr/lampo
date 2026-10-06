// Who watched what, for everyone: the team's own player reports like a review link's guest player does (hundredths
// played and how often, never moments), kept next to the review (data/<slug>/views.json, not review.json); a video's
// audience puts both together (who, how often, how long, the retention curve, what was watched again); Insights
// lists it per video and per person, with the links nobody has opened.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, slugOf } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const watch = await import('../../lib/watch.ts');
const { ruleFor } = await import('../../server/permissions.ts');
const store = await import('../../lib/store.ts');
const folders = await import('../../lib/folders.ts');
const { DATA } = await import('../../lib/paths.ts');
const auth = await import('../../lib/auth.ts');

const T0 = '2026-09-29T10:00:00.000Z';
const later = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const parts = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// ---------------------------------------------------------------- the maths (browser-safe)

test('a report counts plays per hundredth; older players that only say what played count each part once', () => {
  const seen = watch.encodeParts(parts(0, 9));
  assert.deepEqual(watch.playsOfReport(seen).slice(0, 11), [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]);
  const plays = new Array(100).fill(0);
  plays[3] = 4;
  plays[4] = 999;
  const p = watch.playsOfReport(seen, plays);
  assert.equal(p[3], 4);
  assert.equal(p[4], watch.MAX_PLAYS_PER_REPORT, 'one report can only claim so much');
});

test('sittings: reports close together are one, half an hour apart two; a new version starts over, the totals go on', () => {
  const r = (v: number, at: string, secs = 10) => ({ v, seen: watch.encodeParts(parts(0, 19)), secs, at, name: 'Sam' });
  const a = watch.mergeWatch(undefined, r(1, T0));
  const b = watch.mergeWatch(a, r(1, later(5)));
  assert.deepEqual([b?.sessions, b?.total_sessions, b?.secs], [1, 1, 20], 'fifteen-second reports make one sitting');
  const c = watch.mergeWatch(b, r(1, later(60)));
  assert.deepEqual([c?.sessions, c?.total_sessions, c?.plays?.[0]], [2, 2, 3]);
  const d = watch.mergeWatch(c, r(2, later(65), 4));
  assert.deepEqual([d?.v, d?.sessions, d?.secs, d?.total_sessions, d?.total_secs], [2, 1, 4, 2, 34], 'V2 starts over; the video totals go on');
  assert.equal(d?.first, T0);
  // records from before sittings were counted: one sitting at least
  const old = { v: 1, seen: watch.encodeParts([1]), secs: 3, last: T0 };
  const e = watch.mergeWatch(old, r(1, later(90)));
  assert.deepEqual([e?.sessions, e?.total_sessions, e?.total_secs, e?.first], [2, 2, 13, T0]);
});

test('retention across viewers, and stretches watched again and again', () => {
  const mia = watch.mergeWatch(undefined, { v: 1, seen: watch.encodeParts(parts(0, 99)), secs: 30, at: T0 });
  const loops = new Array(100).fill(0);
  for (const i of parts(40, 49)) loops[i] = 5;
  for (const i of parts(0, 49)) loops[i] ||= 1;
  const jo = watch.mergeWatch(undefined, { v: 1, seen: watch.encodeParts(parts(0, 49)), plays: loops, secs: 40, at: T0 });
  const ws = [mia, jo].filter((x) => !!x);
  const retention = watch.retentionOf(ws, 1);
  assert.equal(retention[0], 1, 'both saw the opening');
  assert.equal(retention[75], 0.5, 'one of two made it past the middle');
  const plays = watch.playsOf(ws, 1);
  assert.equal(plays[45], 6);
  assert.deepEqual(watch.rewatchedOf(plays, watch.heatOf(ws, 1)), [{ from: 40, to: 49, plays: 6 }]);
  assert.deepEqual(watch.retentionOf(ws, 2), [], 'nobody watched V2');
  // watching the whole video twice is no stretch watched again
  const twice = new Array(100).fill(2);
  assert.deepEqual(watch.rewatchedOf(twice, new Array(100).fill(1)), []);
});

// ---------------------------------------------------------------- over HTTP

function track(rel: string, folder: string): string {
  const file = makeVideo(path.join(dir, rel), { w: 160, h: 90, dur: 1 });
  age(file);
  store.createOrGetReview(file, { by: 'tester' });
  const slug = slugOf(file);
  folders.moveVideo(slug, folder, 'tester');
  return slug;
}
const spot = track('proj/export/spot.mp4', 'Acme/Reels');

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
const enc = encodeURIComponent;
const guest = (method: string, url: string, body?: unknown) => request(method, url, { body, headers: { 'x-forwarded-for': '203.0.113.9' } });

test('the team watches: the owner player reports, kept beside the review — not in review.json agents read', async () => {
  const plays = new Array(100).fill(0);
  for (const i of parts(0, 59)) plays[i] = 1;
  for (const i of parts(20, 29)) plays[i] = 3;
  const r = await request('POST', `/api/review/${enc(spot)}/watch`, { body: { v: 1, seen: watch.encodeParts(parts(0, 59)), plays, secs: 14 } });
  assert.equal(r.status, 204, r.text);
  const file = path.join(DATA, spot, 'views.json');
  assert.ok(fs.existsSync(file), 'views.json next to review.json');
  const views = JSON.parse(fs.readFileSync(file, 'utf8'));
  const [me] = Object.values(views.viewers) as { name: string; secs: number; plays: number[] }[];
  assert.ok(me?.name, 'the account and its name');
  assert.equal(me?.plays[25], 3);
  assert.ok(!fs.readFileSync(path.join(DATA, spot, 'review.json'), 'utf8').includes('"plays"'), 'review.json stays as it was');
  // agents with an API token don't watch
  const before = fs.readFileSync(file, 'utf8');
  const bot = await auth.createUser({ email: 'bot@example.com', name: 'Bot', password: 'bots password 1', role: 'member' });
  const bearer = `Bearer ${auth.createToken(bot.id, 'agent').token}`;
  const t = await request('POST', `/api/review/${enc(spot)}/watch`, {
    body: { v: 1, seen: watch.encodeParts([99]), secs: 2 },
    headers: { authorization: bearer },
  });
  assert.equal(t.status, 204);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'nothing recorded for a token');
  // what a report may say is checked
  assert.equal((await request('POST', `/api/review/${enc(spot)}/watch`, { body: { v: 1, seen: 'nope', secs: 2 } })).status, 400);
  assert.equal((await request('POST', `/api/review/${enc(spot)}/watch`, { body: { v: 9, seen: watch.encodeParts([1]), secs: 2 } })).status, 404);
  assert.equal(ruleFor('POST', `/api/review/${spot}/watch`).listed, true, 'the write is in the permission table');
});

test("a video's audience: the team and a review link's visitors together, the curve, and what was watched again", async () => {
  const link = (await request('POST', '/api/folder-shares', { body: { folder: 'Acme/Reels', label: 'For Mia' } })).json();
  const room = (await guest('GET', `/api/g/${link.token}`)).json();
  const gid = room.videos.find((v: { name: string }) => v.name === 'spot.mp4').slug;
  await guest('POST', `/api/g/${link.token}/visit`, { name: 'Mia', visitor: 'browser-mia-0001' });
  const plays = new Array(100).fill(0);
  for (const i of parts(0, 29)) plays[i] = 1;
  const p = await guest('POST', `/api/g/${link.token}/progress`, {
    visitor: 'browser-mia-0001',
    slug: gid,
    v: 1,
    seen: watch.encodeParts(parts(0, 29)),
    plays,
    secs: 9,
    name: 'Mia',
  });
  assert.equal(p.status, 204, p.text);

  const a = (await request('GET', `/api/review/${enc(spot)}/audience`)).json();
  assert.equal(a.v, 1);
  const kinds = a.viewers.map((x: { kind: string }) => x.kind).sort();
  assert.deepEqual(kinds, ['client', 'person']);
  const mia = a.viewers.find((x: { kind: string }) => x.kind === 'client');
  assert.deepEqual([mia.name, mia.link, mia.sessions, mia.watched], ['Mia', 'For Mia', 1, 0.3]);
  assert.ok(!JSON.stringify(a).includes('browser-mia-0001'), "a visitor's browser id never comes back");
  assert.equal(a.retention.length, 100);
  assert.equal(a.retention[10], 1, 'both saw the opening');
  assert.equal(a.retention[45], 0.5);
  assert.deepEqual(a.rewatched, [{ from: 20, to: 29, plays: 4 }], 'the team member went over one stretch three times');
});

test('Insights: watching per video and per person, and links nobody has opened', async () => {
  const unopened = (await request('POST', '/api/folder-shares', { body: { folder: 'Acme', label: 'Nobody yet' } })).json();
  assert.ok(unopened.token);
  const b = (await request('GET', '/api/insights?period=30d')).json().board;
  const v = b.watching.videos.find((x: { slug: string }) => x.slug === spot);
  assert.ok(v, 'the watched video is listed');
  assert.deepEqual([v.people, v.clients], [1, 1]);
  assert.equal(v.retention.length, 100);
  // the parts as recorded, for the chart: who saw each hundredth (of the two who watched V1) and how often it played
  assert.equal(v.seenBy, 2);
  assert.deepEqual([v.heat[10], v.heat[45], v.heat[70]], [2, 1, 0], 'both saw the opening, one the middle, nobody the end');
  assert.deepEqual([v.plays[10], v.plays[25], v.plays[45]], [2, 4, 1], 'the stretch the team member went over three times');
  assert.ok(v.views >= 2 && v.secs >= 23);
  assert.equal(b.watching.viewers, 2);
  assert.ok(b.watching.people.some((x: { name: string; kind: string }) => x.kind === 'client' && x.name === 'Mia'));
  assert.ok(b.watching.unopened.some((x: { label: string }) => x.label === 'Nobody yet'));
  assert.ok(!b.watching.unopened.some((x: { label: string }) => x.label === 'For Mia'), 'an opened link is not "not opened"');
  assert.ok(b.flow && Array.isArray(b.agents) && Array.isArray(b.repeats));
  // the asker's own viewing reads "You", on the video and among the people; a visitor never does
  const me = v.viewers.find((x: { kind: string }) => x.kind === 'person');
  assert.equal(me.you, true, 'the owner watching is the one asking');
  assert.equal(v.viewers.find((x: { kind: string }) => x.kind === 'client').you, undefined);
  assert.equal(b.watching.people.filter((x: { you?: boolean }) => x.you).length, 1);
  // the version's length (for places in seconds) and the newest version anyone watched
  assert.ok(v.duration > 0.5 && v.duration < 1.5, `duration ${v.duration}`);
  assert.equal(v.seenV, 1);
  // an API token asks as nobody: no one reads "You"
  const bot = await auth.createUser({ email: 'bot2@example.com', name: 'Bot Two', password: 'bots password 2', role: 'member' });
  const t = (await request('GET', '/api/insights?period=30d', { headers: { authorization: `Bearer ${auth.createToken(bot.id, 'agent').token}` } })).json();
  assert.ok(!JSON.stringify(t.board.watching).includes('"you"'), 'a token is nobody watching');
});

test('Insights: a newer version nobody has watched yet says which version was', async () => {
  const file = path.join(dir, 'proj/export/spot.mp4');
  makeVideo(file, { w: 160, h: 90, dur: 2, freq: 880 });
  age(file);
  store.sync(spot);
  const b = (await request('GET', '/api/insights?period=30d')).json().board;
  const v = b.watching.videos.find((x: { slug: string }) => x.slug === spot);
  assert.equal(v.v, 2, 'the newest version');
  assert.equal(v.seenV, 1, 'what was watched: V1');
  assert.equal(v.completion, null, 'nobody has watched V2');
  assert.deepEqual(v.retention, [], 'no curve for V2 yet');
  assert.deepEqual([v.heat, v.plays, v.seenBy], [[], [], 0], 'no parts for V2 yet');
  assert.ok(v.duration > 1.5, "the newest version's length");
});
