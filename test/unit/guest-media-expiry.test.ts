// A hosted server on Bunny or S3 answers a review link's media, downloads and reference clips with a redirect to a
// signed storage URL. That URL carries no cookie and no check of the link: whoever has it plays the file until it
// expires — after the owner revoked the link, after it expired, after a password was added, and anyone it was passed
// on to. A visitor's URLs therefore live minutes, not the team's hours, so a revoked link's media stops within that
// window: a Bunny edge (token authentication, checked here the way the edge checks it) refuses the URL the visitor was
// given once the window has passed, and the link itself refuses to hand out another (A12 GUEST-11).
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { client, type Request, tusUpload } from '../lib/http.ts';
import { mockBunny, mockS3 } from '../lib/mockStores.ts';

const TOKEN_KEY = 'token-key';
const bunny = await mockBunny();
const { dir } = isolatedEnv({
  vars: {
    VR_MODE: 'server',
    VR_STORAGE: 'bunny',
    VR_BUNNY_ZONE: 'zone',
    VR_BUNNY_ACCESS_KEY: 'secret',
    VR_BUNNY_STORAGE_URL: bunny.url,
    VR_BUNNY_CDN_URL: 'https://cdn.review.test',
    VR_BUNNY_TOKEN_KEY: TOKEN_KEY,
  },
});
const { signBunnyUrl } = await import('../../lib/storage/bunnyToken.ts');
const { createS3Store } = await import('../../lib/storage/s3.ts');
const { createRemoteStorage, setStorage } = await import('../../lib/storage/index.ts');
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const auth = await import('../../lib/auth.ts');
const shares = await import('../../lib/shares.ts');
const { queued } = await import('../../lib/jobs.ts');

/** What a Bunny edge with token authentication decides about `url` at `at` (unix seconds): our signature, not expired. */
function edgeAccepts(url: string, at: number): boolean {
  const u = new URL(url);
  const expires = Number(u.searchParams.get('expires'));
  const bare = new URL(u.origin + u.pathname);
  for (const [k, v] of u.searchParams) if (k !== 'token' && k !== 'expires') bare.searchParams.set(k, v);
  const resigned = new URL(signBunnyUrl(bare.toString(), TOKEN_KEY, { expiresAt: expires }));
  return resigned.searchParams.get('token') === u.searchParams.get('token') && at <= expires;
}
const lifeOf = (url: string) => Number(new URL(url).searchParams.get('expires')) - Math.floor(Date.now() / 1000);
/** Minutes, not hours: the most a visitor's URL may live. */
const WINDOW = 10 * 60;

let server: http.Server;
let request: Request;
let bearer: Record<string, string>;
let slug = '';
before(async () => {
  server = http.createServer(createApp(createContext({ cfg: loadConfig(), token: 'unused' })));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  request = client((server.address() as AddressInfo).port);
  const user = await auth.createUser({ email: 'o@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
  bearer = { Authorization: `Bearer ${auth.createToken(user.id, 'test').token}` };
  const up = await tusUpload(request, makeVideo(path.join(dir, 'in/spot.mp4'), { w: 320, h: 180, dur: 1, gop: 10 }), { filename: 'spot.mp4' }, bearer);
  assert.equal(up.status, 200, up.text);
  slug = up.json().slug;
});
after(async () => {
  for (let i = 0; i < 600 && queued() > 0; i++) await new Promise((r) => setTimeout(r, 50));
  server.close();
  await bunny.close();
});

test('a review link’s render and download redirect to URLs that live minutes; the team’s live hours', async () => {
  const link = shares.createShare(slug, { label: 'Client', download: 'original' });
  const id = shares.guestId(link, slug);
  const played = await request('GET', `/media/g/${link.token}/${id}/v1`);
  assert.equal(played.status, 302, played.text);
  const url = String(played.headers.location);
  assert.match(url, /^https:\/\/cdn\.review\.test\/versions\//);
  assert.ok(lifeOf(url) > 60 && lifeOf(url) <= WINDOW, `the visitor's URL lives ${lifeOf(url)} s`);
  const down = await request('GET', `/api/g/${link.token}/download/${id}/v1?kind=original`);
  assert.equal(down.status, 302, down.text);
  assert.ok(lifeOf(String(down.headers.location)) <= WINDOW, 'a download’s URL too');
  const team = await request('GET', `/media/${encodeURIComponent(slug)}/v1`, { headers: bearer });
  assert.equal(team.status, 302);
  assert.ok(lifeOf(String(team.headers.location)) > 5 * 3600, 'the team’s player keeps its hours');
});

test('a revoked link’s media stops within the window: no new URL, and the one handed out is refused once it has passed', async () => {
  const link = shares.createShare(slug, { label: 'Leaving', download: 'original' });
  const media = `/media/g/${link.token}/${shares.guestId(link, slug)}/v1`;
  const given = String((await request('GET', media)).headers.location);
  const now = Math.floor(Date.now() / 1000);
  const life = lifeOf(given);
  assert.ok(edgeAccepts(given, now), 'the edge plays it now');
  assert.ok(shares.revokeShare(link.token));
  assert.ok([404, 410].includes((await request('GET', media)).status), 'the link hands out nothing more');
  assert.ok(edgeAccepts(given, now + life - 5), 'what was handed out runs to the end of its window');
  assert.equal(edgeAccepts(given, now + WINDOW + 1), false, 'and is refused once the window has passed');
  assert.equal(edgeAccepts(given, now + 6 * 3600 - 60), false, 'where it used to play for six hours');
  // the same for a link that expires or gets a password: every redirect checks the link again
  const timed = shares.createShare(slug, { label: 'Timed', download: 'original' });
  const timedMedia = `/media/g/${timed.token}/${shares.guestId(timed, slug)}/v1`;
  assert.equal((await request('GET', timedMedia)).status, 302);
  shares.updateShare(timed.token, { expires: new Date(Date.now() - 1000).toISOString() });
  assert.ok([403, 404, 410].includes((await request('GET', timedMedia)).status), 'an expired link hands out nothing more');
});

test('on S3 the same window: the presigned URL a visitor is sent to says X-Amz-Expires of minutes', async () => {
  const s3 = await mockS3();
  // The same working copies, signed by an S3 bucket instead of the Bunny CDN.
  setStorage(createRemoteStorage(createS3Store({ endpoint: s3.url, bucket: 'bucket', access_key_id: 'AKTEST', secret_access_key: 'secret', region: 'auto' })));
  try {
    const link = shares.createShare(slug, { label: 'On S3', download: 'original' });
    const guest = await request('GET', `/media/g/${link.token}/${shares.guestId(link, slug)}/v1`);
    assert.equal(guest.status, 302, guest.text);
    const expires = Number(new URL(String(guest.headers.location)).searchParams.get('X-Amz-Expires'));
    assert.ok(expires > 60 && expires <= WINDOW, `X-Amz-Expires=${expires}`);
    const team = await request('GET', `/media/${encodeURIComponent(slug)}/v1`, { headers: bearer });
    assert.equal(new URL(String(team.headers.location)).searchParams.get('X-Amz-Expires'), String(6 * 3600));
  } finally {
    setStorage(null);
    await s3.close();
  }
});
