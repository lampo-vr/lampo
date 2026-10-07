// `vr` against a hosted server keeps what it downloads (screenshots, frames, skill files) in its own cache folder. The
// server names those files — a slug, a version hash, a skill name — so a name that climbs out (`../`) is never
// followed: whatever a server says, nothing lands outside the cache.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Review, ReviewEvent, Version } from '../../lib/types.ts';
import { isolatedEnv } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const { createRemoteBackend } = await import('../../lib/backend/remote.ts');

const cacheRoot = path.join(dir, 'home', '.cache', 'lampo');
const home = path.join(dir, 'home');
const event = (slug: string): ReviewEvent =>
  ({
    at: '2026-09-30T10:00:00+02:00',
    type: 'comment',
    by: 'olivia',
    video: '/@uploads/Acme/spot.mp4',
    slug,
    session: null,
    id: 'c_aaaaaa',
    v: 1,
    frame: 3,
    timecode: '00:00:03',
    text: 'Heller?',
    shots: { marked: `/data/${slug}/landed.txt`, clean: `/data/${slug}/landed-clean.txt` },
  }) as ReviewEvent;
let slugs: string[] = [];

// A server that answers every download with a few bytes and lists events with the slugs a test chooses.
let server: http.Server;
let base = '';
before(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/inbox')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ events: slugs.map(event) }));
    } else res.end('bytes from the server');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

/** Every file under `root`, relative to it. */
const files = (root: string): string[] => (fs.existsSync(root) ? (fs.readdirSync(root, { recursive: true }) as string[]) : []);
const outside = () => files(home).filter((f) => f.includes('landed') && !path.join(home, f).startsWith(cacheRoot));

test('screenshots of events: a slug that climbs out of the cache is not followed', async () => {
  const b = createRemoteBackend({ server: base, token: 'vr_test' }, { cacheRoot });
  slugs = ['__@uploads__Acme__spot.mp4', '../../..', '..', '../escape'];
  const events = await b.events(10);
  assert.deepEqual(outside(), [], 'nothing written outside the cache');
  const good = events.find((e) => e.slug === '__@uploads__Acme__spot.mp4');
  assert.ok(good?.shots?.marked?.startsWith(cacheRoot) && fs.existsSync(good.shots.marked), 'a proper slug still downloads into the cache');
  for (const e of events.filter((x) => x !== good)) assert.equal(e.shots?.marked, null, `no local path for ${e.slug}`);
});

test('frames and skill files: a version hash or skill name that climbs out is not followed', async () => {
  const b = createRemoteBackend({ server: base, token: 'vr_test' }, { cacheRoot });
  const review = { video: '/@uploads/Acme/spot.mp4' } as Review;
  const ver = { v: 1, hash: '../../../landed-' } as Version;
  await assert.rejects(b.frame(review, ver, 3));
  assert.equal(await b.skillFile('', '../../../../landed-skill', 'preset.txt'), null);
  assert.equal(await b.skillFile('', 'reels-export', '../landed-name.txt').then((p) => p?.startsWith(cacheRoot)), true, 'a name is its base name');
  assert.deepEqual(outside(), [], 'nothing written outside the cache');
});
