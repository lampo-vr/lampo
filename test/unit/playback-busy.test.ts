// A scrub copy (or a ProRes proxy, a part's splice) a player waits on, and a workspace's job queue at its cap
// (lib/jobs.ts, A12-D2). The copy has places kept for it under the cap; when even those are taken it waits, says so
// once (`busy`), and the server asks for it again by itself — it must never announce the video again on every request
// that finds it missing: each announcement made every open player ask again, a refetch loop for as long as the queue
// stayed full (audit A12 VE1r2-1: 21 GETs in 5 s against 1).
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { age, isolatedEnv, makeVideo, sleep } from '../lib/helpers.ts';
import { client, type Request } from '../lib/http.ts';

const { dir } = isolatedEnv();
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const { COPY_RETRY } = await import('../../server/playback.ts');
const jobs = await import('../../lib/jobs.ts');
const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');

const ctx = createContext({ cfg: loadConfig(), token: 'test-token', loadSessions: async () => [] });
let server: http.Server;
let owner: Request;
before(async () => {
  server = http.createServer(createApp(ctx));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  owner = client((server.address() as AddressInfo).port);
});
after(() => {
  server.closeAllConnections();
  server.close();
});

/** The video's announcements, as every open player hears them. */
const heard: string[] = [];
ctx.hub.listen((type, data) => {
  if (type === 'review') heard.push(String((data as { slug?: string }).slug));
});

/** Holds the one job slot until released, and `n` more jobs wait behind it: the queue as full as asked. */
async function fill(n: number): Promise<() => Promise<void>> {
  let release = () => {};
  await new Promise<void>((started) =>
    jobs.heavy(
      () =>
        new Promise<void>((r) => {
          release = r;
          started();
        }),
      jobs.PRIORITY.scrub,
    ),
  );
  const waiting = Array.from({ length: n }, () => jobs.heavy(() => {}, jobs.PRIORITY.sprite, { mustRun: true }));
  return async () => {
    release();
    await Promise.all(waiting);
  };
}

function track(name: string, pattern: string): string {
  // keyframes far apart: it needs a scrub copy; other bytes for each test (a copy made is the next one's too)
  const file = makeVideo(path.join(dir, name), { w: 160, h: 90, dur: 1, pattern });
  age(file);
  store.createOrGetReview(file, { by: 'tester' });
  return slugify(file);
}

test('the other work fills the queue: a scrub copy still gets one of the places kept for it', async () => {
  jobs.QUEUE_LIMITS.perWorkspace = 3;
  jobs.QUEUE_LIMITS.reserved = 1;
  const release = await fill(2); // 2 waiting: the cap for other work
  try {
    assert.equal(jobs.jobRoom(), false, 'no room for other work');
    const before = jobs.queued();
    const r = await owner('GET', `/api/review/${encodeURIComponent(track('a/spot.mp4', 'testsrc'))}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json().media[1].scrub, 'building');
    assert.equal(r.json().media[1].busy, undefined);
    assert.equal(jobs.queued(), before + 1, 'queued in a kept place');
  } finally {
    jobs.QUEUE_LIMITS.perWorkspace = Number.POSITIVE_INFINITY;
    jobs.QUEUE_LIMITS.reserved = 0;
    await release();
  }
});

test('a queue full to the last place: the copy waits and says so once — no announcement per request, no refetch loop — and is queued by the server when room comes', async () => {
  COPY_RETRY.firstMs = 300;
  jobs.QUEUE_LIMITS.perWorkspace = 2;
  jobs.QUEUE_LIMITS.reserved = 1;
  const slug = track('b/promo.mp4', 'smptebars');
  const release = await fill(2);
  heard.length = 0;
  let gets = 0;
  try {
    // An open player: it asks for the review, and again on every announcement of the video (as web/src/api/live.ts).
    const ask = async () => {
      gets++;
      return (await owner('GET', `/api/review/${encodeURIComponent(slug)}`)).json();
    };
    const first = await ask();
    assert.equal(first.media[1].busy, true, 'the player is told the server is busy');
    assert.equal(first.media[1].ready, true, 'and plays the version’s own bytes meanwhile');
    for (let t = Date.now(); Date.now() - t < 1500; ) {
      if (heard.length > gets - 1) await ask();
      await sleep(50);
    }
    assert.equal(heard.length, 0, `nothing announced while it waits: ${heard.length}`);
    assert.equal(gets, 1, 'one request, not a loop');
    // room again: the server queues the copy itself, announces that once, and once more when it is made
    await release();
    for (let t = Date.now(); Date.now() - t < 20_000 && !heard.includes(slug); ) await sleep(50);
    assert.ok(heard.includes(slug), 'announced once it is queued');
    const now = await ask();
    assert.equal(now.media[1].busy, undefined);
    for (let t = Date.now(); Date.now() - t < 30_000 && jobs.queued(); ) await sleep(100);
    assert.equal((await ask()).media[1].scrub, 'ready');
  } finally {
    jobs.QUEUE_LIMITS.perWorkspace = Number.POSITIVE_INFINITY;
    jobs.QUEUE_LIMITS.reserved = 0;
    COPY_RETRY.firstMs = 5000;
  }
});
