// "That's intended" over HTTP: dismissing an Auto-check finding keeps where it was (its stretch, from the check's own
// result for that version — never from the request), logs nothing an agent reads, and `vr`-side filtering keeps it
// dismissed on the same stretch in the next version. And the small picture each finding shows (`size=thumb`).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { client, type Request, tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const auth = await import('../../lib/auth.ts');
const { cacheDir } = await import('../../lib/paths.ts');
const { renderKey } = await import('../../lib/renderKey.ts');
const { QA_VERSION } = await import('../../lib/qa.ts');
const { undismissed } = await import('../../lib/findings.ts');

const spot = makeVideo(path.join(dir, 'renders/spot.mp4'), { w: 320, h: 180, fps: 25, dur: 2, pattern: 'testsrc2' });

let server: http.Server;
let request: Request;
let base = '';
let owner: Record<string, string> = {};
let reviewer: Record<string, string> = {};
before(async () => {
  server = http.createServer(createApp(createContext({ cfg: loadConfig(), token: 'unused' })));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  request = client(port);
  base = `http://127.0.0.1:${port}`;
  const o = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
  const r = await auth.createUser({ email: 'rita@example.com', name: 'Rita', password: 'a long password', role: 'reviewer' });
  owner = { Authorization: `Bearer ${auth.createToken(o.id, 'test').token}` };
  reviewer = { Authorization: `Bearer ${auth.createToken(r.id, 'test').token}` };
});
after(() => server.close());

const e = encodeURIComponent;
let slug = '';

test('"That’s intended" keeps the finding’s stretch from the check’s result; the agent hears nothing', async () => {
  const up = await tusUpload(request, spot, { filename: 'spot.mp4', folder: 'Acme' }, owner);
  assert.equal(up.status, 200, up.text);
  slug = up.json().slug;
  const review = (await request('GET', `/api/review/${e(slug)}`, { headers: owner })).json().review;
  const ver = review.versions[0];
  // Auto-check's result for V1, as lib/qa.ts writes it: a freeze while the sound goes on
  const qa = {
    qa_version: QA_VERSION,
    hash: ver.hash,
    at: new Date().toISOString(),
    duration_ms: 1,
    samples: 4,
    text_language: null,
    items: [
      {
        key: 'freeze:10',
        kind: 'freeze',
        severity: 'should',
        tags: ['freeze'],
        frame: 10,
        range: { in: 10, out: 25 },
        text: 'Picture freezes for 16 frames (0.64 s) while the sound goes on',
        likely: 'problem',
        why: 'sound-continues',
      },
    ],
    spelling: { state: 'checked', words: 0 },
  };
  fs.mkdirSync(path.join(cacheDir(), 'qa'), { recursive: true });
  fs.writeFileSync(path.join(cacheDir(), 'qa', `${renderKey(ver)}.json`), JSON.stringify(qa));
  const got = (await request('GET', `/api/qa/${e(slug)}/1`, { headers: owner })).json();
  assert.equal(got.items[0].why, 'sound-continues');

  const events = () => (fs.existsSync(path.join(dir, 'data', 'events.jsonl')) ? fs.readFileSync(path.join(dir, 'data', 'events.jsonl'), 'utf8') : '');
  const before = events();
  // reviewers turn findings into notes; putting one away is the team's
  assert.equal((await request('POST', `/api/qa/${e(slug)}/dismiss`, { body: { key: 'freeze:10', v: 1 }, headers: reviewer })).status, 403);
  const r = await request('POST', `/api/qa/${e(slug)}/dismiss`, { body: { key: 'freeze:10', v: 1 }, headers: owner });
  assert.equal(r.status, 200, r.text);
  const after = (await request('GET', `/api/review/${e(slug)}`, { headers: owner })).json().review;
  assert.deepEqual(after.qa_dismissed, ['freeze:10']);
  assert.deepEqual(after.qa_stretches, { 'freeze:10': { in: 10, out: 25 } });
  assert.equal(events(), before, 'nothing logged: no agent is told');

  // the next version's freeze, two frames later, stays dismissed; another one doesn't
  const next = [
    { key: 'freeze:12', kind: 'freeze', frame: 12, range: { in: 12, out: 27 } },
    { key: 'freeze:40', kind: 'freeze', frame: 40, range: { in: 40, out: 47 } },
  ];
  assert.deepEqual(
    undismissed(next, after, 25).map((x) => x.key),
    ['freeze:40'],
  );
});

test('a dismissal without a version, or of a key the check doesn’t know, keeps no stretch', async () => {
  for (const body of [{ key: 'freeze:99' }, { key: 'freeze:77', v: 1 }, { key: 'typo:abcd1234', v: 1 }]) {
    const r = await request('POST', `/api/qa/${e(slug)}/dismiss`, { body, headers: owner });
    assert.equal(r.status, 200, r.text);
  }
  const review = (await request('GET', `/api/review/${e(slug)}`, { headers: owner })).json().review;
  assert.deepEqual(Object.keys(review.qa_stretches), ['freeze:10']);
  assert.ok(review.qa_dismissed.includes('typo:abcd1234'));
  assert.equal((await request('POST', `/api/qa/${e(slug)}/dismiss`, { body: { key: 'freeze:10', v: 'one' }, headers: owner })).status, 400);
});

test('a finding’s picture: a small JPEG of the exact frame; only the sizes the app names', async () => {
  const res = await fetch(`${base}/api/review/${e(slug)}/frame?frame=10&size=thumb`, { headers: owner });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /image\/jpeg/);
  const jpg = Buffer.from(await res.arrayBuffer());
  assert.equal(jpg[0], 0xff, 'a JPEG');
  assert.equal(jpg[1], 0xd8);
  const full = await fetch(`${base}/api/review/${e(slug)}/frame?frame=10`, { headers: owner });
  assert.match(full.headers.get('content-type') || '', /image\/png/, 'the full frame stays a PNG');
  assert.equal((await fetch(`${base}/api/review/${e(slug)}/frame?frame=10&size=huge`, { headers: owner })).status, 400);
});
