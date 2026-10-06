// covers: lib/storage/mediaHost.ts
// The app's own media host (VR_MEDIA_ORIGIN): a second host name of the same server for video, when the app host sits
// behind a front that must not carry it. Players, review links, downloads and folder zips are redirected there with
// signed URLs that name nothing and end (hours for the team, minutes for a link's visitors, A12 GUEST-11); the host
// answers those URLs (ranges included) and one-time uploads, never a cookie, never anything else; the page's CSP lets
// the player load it; a revoked link's media stops within its window; bad settings refuse to start.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { mock, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { tusUpload } from '../lib/http.ts';

const APP = 'review.test';
const MEDIA = 'media.review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: `http://${APP}`, VR_MEDIA_ORIGIN: `http://${MEDIA}/` } });
const { loadConfig, startupProblems } = await import('../../lib/config.ts');
const { mediaFileUrl, mediaUrlEnd, openMedia, sealMedia } = await import('../../lib/storage/mediaHost.ts');
const { createStorage, storage, SIGNED_URL_SECONDS } = await import('../../lib/storage/index.ts');
const { inWorkspace } = await import('../../lib/scope.ts');
const { loggedPath } = await import('../../server/http.ts');
const auth = await import('../../lib/auth.ts');
const shares = await import('../../lib/shares.ts');

const { port, request } = await startApp();

interface Raw {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}
/** One request with the bytes as they came (video, zips); `host` names the host it is made to. */
function raw(method: string, url: string, { host = APP, headers = {}, body }: { host?: string; headers?: Record<string, string>; body?: Buffer } = {}) {
  return new Promise<Raw>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { Host: host, ...headers }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
/** The path of a URL on the media host (what the browser asks there). */
const onMedia = (location: unknown): string => {
  const u = new URL(String(location));
  assert.equal(u.host, MEDIA, `redirected to the media host: ${location}`);
  return u.pathname + u.search;
};
const sealedOf = (location: unknown) => String(new URL(String(location)).pathname.split('/')[3]);
const lifeOf = (location: unknown) => (openMedia(sealedOf(location))?.e ?? 0) - Math.floor(Date.now() / 1000);
/** Runs `fn` with the clock (Date) moved on by `ms`: the server, in this process, sees the same time. */
async function later<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  mock.timers.enable({ apis: ['Date'], now: Date.now() + ms });
  try {
    return await fn();
  } finally {
    mock.timers.reset();
  }
}

const owner = await auth.createUser({ email: 'o@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
const bearer = { Authorization: `Bearer ${auth.createToken(owner.id, 'test').token}` };
const file = makeVideo(path.join(dir, 'in/spot.mp4'), { w: 320, h: 180, dur: 1, gop: 10 });
const bytes = fs.readFileSync(file);
const up = await tusUpload(request, file, { filename: 'spot.mp4', folder: 'Acme' }, bearer);
assert.equal(up.status, 200, up.text);
const slug: string = up.json().slug;

test('the setting: an origin of its own, https off this machine, never the app host; ignored on a person’s own machine', () => {
  const problems = (vars: Record<string, string>) =>
    startupProblems(loadConfig({ VR_MODE: 'server', VR_PUBLIC_URL: 'https://review.example.com', VR_TRUST_PROXY: 'loopback', ...vars }), vars);
  assert.deepEqual(problems({ VR_MEDIA_ORIGIN: 'https://media.example.com' }), []);
  assert.deepEqual(problems({ VR_MEDIA_ORIGIN: 'https://media.example.com/' }), [], 'a trailing slash is the same origin');
  assert.match(problems({ VR_MEDIA_ORIGIN: 'https://media.example.com/video' }).join(), /only the scheme and host/);
  assert.match(problems({ VR_MEDIA_ORIGIN: 'media.example.com' }).join(), /with its scheme/);
  assert.match(problems({ VR_MEDIA_ORIGIN: 'http://media.example.com' }).join(), /plain http/);
  assert.match(problems({ VR_MEDIA_ORIGIN: 'https://review.example.com:8443' }).join(), /host name of its own/);
  assert.deepEqual(problems({ VR_MEDIA_ORIGIN: 'http://127.0.0.1:4848' }), [], 'plain http on this machine is fine');
  assert.equal(createStorage({ kind: 'local' }, 'local', 'https://media.example.com').url('versions/x/v1.mp4'), null);
  assert.equal(loadConfig({ VR_MEDIA_ORIGIN: 'https://media.example.com///' }).media_origin, 'https://media.example.com');
});

test('a sealed URL names nothing, can’t be changed or made up, ends on time, and is the same within its step', () => {
  const now = Date.parse('2026-10-03T12:00:10Z');
  const token = sealMedia({ k: 'versions/acme-secret-launch/v1.mp4' }, 300, now);
  assert.doesNotMatch(Buffer.from(token, 'base64url').toString('latin1'), /acme|versions/, 'the key is encrypted, not only signed');
  assert.equal(openMedia<{ k: string }>(token, now)?.k, 'versions/acme-secret-launch/v1.mp4');
  assert.equal(sealMedia({ k: 'versions/acme-secret-launch/v1.mp4' }, 300, now + 20_000), token, 'the same minute: the same URL');
  assert.notEqual(sealMedia({ k: 'versions/acme-secret-launch/v1.mp4' }, 300, now + 60_000), token);
  const end = mediaUrlEnd(300, now);
  assert.ok(end * 1000 - now >= 300_000 && end * 1000 - now < 360_000, 'minutes: rounded up to the minute');
  assert.ok(mediaUrlEnd(6 * 3600, now) * 1000 - now < 7 * 3600_000, 'hours: rounded up to the hour');
  assert.equal(openMedia(token, end * 1000 + 1), null, 'ended');
  const bytes = Buffer.from(token, 'base64url');
  bytes[bytes.length - 1] ^= 1;
  assert.equal(openMedia(bytes.toString('base64url'), now), null, 'changed');
  assert.equal(openMedia('A'.repeat(80), now), null, 'made up');
  // Another workspace's file is sealed with its own prefix: the URL opens that workspace's bytes and no other's.
  const other = inWorkspace('w_abcdefghijkl', () => String(storage().url('versions/x/v1.mp4')));
  assert.equal(openMedia<{ k: string }>(sealedOf(other))?.k, 'w/w_abcdefghijkl/versions/x/v1.mp4');
  assert.match(mediaFileUrl('https://m.example', 'versions/x/v1.mp4', 60, 'Spot «final».mp4'), /\/Spot%20%C2%ABfinal%C2%BB\.mp4$/);
  assert.equal(loggedPath(`/media/s/${token}/v1.mp4`), '/media/s/…/v1.mp4', 'never in the log');
});

test('the team’s player is sent to the media host for hours, and gets the bytes there in ranges, without a cookie', async () => {
  const played = await raw('GET', `/media/${encodeURIComponent(slug)}/v1`, { headers: bearer });
  assert.equal(played.status, 302, played.body.toString());
  assert.equal(played.headers['cache-control'], 'no-store');
  assert.doesNotMatch(String(played.headers.location), new RegExp(slug), 'the URL names no video');
  assert.ok(lifeOf(played.headers.location) > 6 * 3600 - 60, `the team's URL lives ${lifeOf(played.headers.location)} s`);
  const at = onMedia(played.headers.location);

  const part = await raw('GET', at, { host: MEDIA, headers: { Range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers['content-range'], `bytes 0-99/${bytes.length}`);
  assert.deepEqual(part.body, bytes.subarray(0, 100), 'the render’s own bytes');
  const tail = await raw('GET', at, { host: MEDIA, headers: { Range: `bytes=${bytes.length - 10}-` } });
  assert.deepEqual(tail.body, bytes.subarray(bytes.length - 10));
  const whole = await raw('GET', at, { host: MEDIA });
  assert.equal(whole.status, 200);
  assert.deepEqual(whole.body, bytes);
  assert.equal(whole.headers['content-type'], 'video/mp4');
  assert.equal(whole.headers['accept-ranges'], 'bytes');
  assert.equal(whole.headers['set-cookie'], undefined, 'nobody is signed in on the media host');
  assert.equal(whole.headers['cross-origin-resource-policy'], 'cross-origin', 'the app’s pages may load it');
  assert.equal(whole.headers['access-control-allow-origin'], `http://${APP}`);
  assert.match(String(whole.headers['cache-control']), /^private, max-age=\d+, immutable$/);
  assert.equal((await raw('HEAD', at, { host: MEDIA })).status, 200);

  // the same file asked for again within the hour: the same URL, so the browser's cached ranges still count
  const again = await raw('GET', `/media/${encodeURIComponent(slug)}/v1`, { headers: bearer });
  assert.equal(again.headers.location, played.headers.location);
});

test('the page lets the player load the media host (CSP), and nothing else changes for the app host', async () => {
  const page = await raw('GET', '/healthz');
  const csp = String(page.headers['content-security-policy']);
  assert.match(csp, new RegExp(`media-src 'self' blob: http://${MEDIA.replace(/\./g, '\\.')}(;|$)`));
  assert.match(csp, new RegExp(`connect-src 'self' http://${MEDIA.replace(/\./g, '\\.')}(;|$)`));
  assert.match(csp, /img-src 'self' data: blob:(;|$)/, 'pictures still come from the app host only');
});

test('the media host answers its signed URLs and one-time uploads only: no app, no API, no sign-in, whoever asks', async () => {
  const played = await raw('GET', `/media/${encodeURIComponent(slug)}/v1`, { headers: bearer });
  const at = onMedia(played.headers.location);
  for (const [method, url] of [
    ['GET', '/'],
    ['GET', '/index.html'],
    ['GET', '/api/library'],
    ['GET', '/api/auth/status'],
    ['POST', '/api/auth/login'],
    ['GET', `/media/${encodeURIComponent(slug)}/v1`],
    ['GET', '/mcp'],
    ['GET', '/.well-known/oauth-authorization-server'],
    ['POST', '/api/uploads'],
    ['PUT', at],
    ['GET', `${at}/x`],
    ['GET', at.toUpperCase()],
  ] as const) {
    for (const headers of [{}, bearer]) {
      const r = await raw(method, url, { host: MEDIA, headers });
      assert.equal(r.status, 404, `${method} ${url} on the media host → ${r.status}`);
      assert.equal(r.headers['set-cookie'], undefined);
    }
  }
  assert.equal((await raw('GET', '/healthz', { host: MEDIA })).status, 200, 'its health answers, for a monitor');
  // and the signed path is no way around the app host's sign-in
  assert.equal((await raw('GET', at)).status, 401, 'on the app host, signed out');
  assert.equal((await raw('GET', at, { headers: bearer })).status, 404, 'on the app host, signed in');
  // a URL that was changed, or made up
  const sealed = sealedOf(played.headers.location);
  const bent = Buffer.from(sealed, 'base64url');
  bent[20] ^= 1;
  assert.equal((await raw('GET', at.replace(sealed, bent.toString('base64url')), { host: MEDIA })).status, 403);
  assert.equal((await raw('GET', `/media/s/${'A'.repeat(90)}/v1.mp4`, { host: MEDIA })).status, 403);
});

test('a URL that has ended is refused, and the player gets a fresh one by asking the app host again', async () => {
  const played = await raw('GET', `/media/${encodeURIComponent(slug)}/v1`, { headers: bearer });
  const at = onMedia(played.headers.location);
  await later(8 * 3600_000, async () => {
    assert.equal((await raw('GET', at, { host: MEDIA, headers: { Range: 'bytes=0-9' } })).status, 403);
    const fresh = await raw('GET', `/media/${encodeURIComponent(slug)}/v1`, { headers: bearer });
    assert.notEqual(fresh.headers.location, played.headers.location);
    assert.equal((await raw('GET', onMedia(fresh.headers.location), { host: MEDIA, headers: { Range: 'bytes=0-9' } })).status, 206);
  });
});

test('a review link’s visitor gets minutes, a named download, and a revoked link’s media stops within the window', async () => {
  const link = shares.createShare(slug, { label: 'Client', download: 'original' });
  const id = shares.guestId(link, slug);
  const media = `/media/g/${link.token}/${id}/v1`;
  const played = await raw('GET', media);
  assert.equal(played.status, 302, played.body.toString());
  const life = lifeOf(played.headers.location);
  assert.ok(life > 60 && life <= SIGNED_URL_SECONDS.guest + 60, `the visitor's URL lives ${life} s`);
  const at = onMedia(played.headers.location);
  assert.equal((await raw('GET', at, { host: MEDIA, headers: { Range: 'bytes=0-9' } })).status, 206);

  const down = await raw('GET', `/api/g/${link.token}/download/${id}/v1?kind=original`);
  assert.equal(down.status, 302);
  assert.ok(lifeOf(down.headers.location) <= SIGNED_URL_SECONDS.guest + 60, 'a download’s URL lives minutes too');
  const got = await raw('GET', onMedia(down.headers.location), { host: MEDIA });
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, bytes);
  assert.equal(got.headers['content-disposition'], `attachment; filename="spot-v1.mp4"; filename*=UTF-8''spot-v1.mp4`);

  assert.ok(shares.revokeShare(link.token));
  assert.ok([404, 410].includes((await raw('GET', media)).status), 'the link hands out nothing more');
  assert.equal((await raw('GET', at, { host: MEDIA, headers: { Range: 'bytes=0-9' } })).status, 206, 'what it handed out runs to its end');
  await later((life + 5) * 1000, async () => {
    assert.equal((await raw('GET', at, { host: MEDIA, headers: { Range: 'bytes=0-9' } })).status, 403, 'and stops there');
  });
});

test('folder zips stream from the media host: the team’s, and a link’s, which is asked again when the zip starts', async () => {
  const team = await raw('GET', '/api/folders/download?folder=Acme', { headers: bearer });
  assert.equal(team.status, 302, team.body.toString());
  assert.match(String(team.headers.location), new RegExp(`^http://${MEDIA.replace(/\./g, '\\.')}/media/z/[\\w-]+/Acme%20[^/]+\\.zip$`));
  const zip = await raw('GET', onMedia(team.headers.location), { host: MEDIA });
  assert.equal(zip.status, 200, zip.body.toString().slice(0, 200));
  assert.equal(zip.headers['content-type'], 'application/zip');
  assert.match(String(zip.headers['content-disposition']), /^attachment; filename="Acme _ [\d-]+\.zip"; filename\*=UTF-8''Acme%20%E2%80%93%20/);
  assert.equal(zip.body.subarray(0, 4).toString('latin1'), 'PK\u0003\u0004');
  assert.ok(zip.body.includes(bytes.subarray(0, 4096)), 'the render is in it, as uploaded');

  const room = shares.createShare({ folder: 'Acme' }, { label: 'Room', download: 'original' });
  const guest = await raw('GET', `/api/g/${room.token}/archive?kind=original&name=Mia`);
  assert.equal(guest.status, 302, guest.body.toString());
  assert.ok(lifeOf(guest.headers.location) <= SIGNED_URL_SECONDS.guest + 60);
  const at = onMedia(guest.headers.location);
  const theirs = await raw('GET', at, { host: MEDIA });
  assert.equal(theirs.status, 200);
  const stats = shares.listShares({ folder: 'Acme' }).find((x) => x.token === room.token)?.stats;
  assert.equal(stats?.recent_downloads?.at(-1)?.name, 'Mia', 'counted as the visitor’s download');
  assert.ok(shares.revokeShare(room.token));
  assert.equal((await raw('GET', at, { host: MEDIA })).status, 404, 'a revoked link’s zip doesn’t start, even within the window');
  assert.equal((await raw('GET', at)).status, 401, 'nor on the app host');
});

test('/api/info names the media host to someone signed in (Connect an agent: a chat app’s sandbox must reach it), not signed out', async () => {
  const info = async (headers: Record<string, string> = {}) => JSON.parse((await raw('GET', '/api/info', { headers })).body.toString());
  assert.equal((await info(bearer)).media_origin, `http://${MEDIA}`, 'the origin as upload URLs carry it');
  assert.equal((await info()).media_origin, undefined);
});

test('one-time upload URLs point at the media host, where a whole render goes up in one request', async () => {
  const ticket = await raw('POST', '/api/uploads/tickets', {
    headers: { ...bearer, 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ filename: 'spot.mp4', folder: 'Acme' })),
  });
  assert.equal(ticket.status, 200, ticket.body.toString());
  const url = JSON.parse(ticket.body.toString()).url as string;
  assert.match(url, new RegExp(`^http://${MEDIA.replace(/\./g, '\\.')}/api/uploads/direct/vrup_`));
  const second = makeVideo(path.join(dir, 'in/spot2.mp4'), { w: 320, h: 180, dur: 1, gop: 10, freq: 880 });
  const put = await raw('PUT', new URL(url).pathname, {
    host: MEDIA,
    body: fs.readFileSync(second),
    headers: { 'content-length': String(fs.statSync(second).size) },
  });
  assert.equal(put.status, 200, put.body.toString());
  assert.equal(JSON.parse(put.body.toString()).v, 2, 'the next version of the video');
  assert.equal((await raw('GET', new URL(url).pathname, { host: MEDIA })).status, 200, 'its outcome can be read there too');
});

test('a team zip URL is its asker’s for its hours: removed, revoked or signed out since gets nothing; it zips the folder as it was', async () => {
  const ws = await import('../../lib/workspaces.ts');
  const zipUrl = async (headers: Record<string, string>) => {
    const r = await raw('GET', '/api/folders/download?folder=Acme', { headers });
    assert.equal(r.status, 302, r.body.toString());
    return onMedia(r.headers.location);
  };
  const zip = (at: string) => raw('GET', at, { host: MEDIA });

  // a member removed from the workspace after asking
  const carol = await auth.createUser({ email: 'carol@example.com', name: 'Carol', password: 'a long password', role: 'member' });
  const asCarol = { Authorization: `Bearer ${auth.createToken(carol.id, 'test').token}` };
  const hers = await zipUrl(asCarol);
  assert.equal((await zip(hers)).status, 200, 'while she is a member');
  ws.removeMember('w1', carol.id);
  const after = await zip(hers);
  assert.equal(after.status, 403, `a removed member's URL: ${after.status}`);
  assert.ok(!after.body.includes(bytes.subarray(0, 4096)), 'not a byte of the folder');
  // an API token revoked after asking
  const dave = await auth.createUser({ email: 'dave@example.com', name: 'Dave', password: 'a long password', role: 'member' });
  const daves = auth.createToken(dave.id, 'test');
  const his = await zipUrl({ Authorization: `Bearer ${daves.token}` });
  assert.ok(auth.revokeToken(daves.info.id, dave.id));
  assert.equal((await zip(his)).status, 403, 'a revoked token’s URL');
  // a browser session signed out after asking
  const session = auth.signSession(owner);
  const theirs = await zipUrl({ Cookie: `vr_session=${session}` });
  assert.equal((await zip(theirs)).status, 200);
  auth.revokeSession(session);
  assert.equal((await zip(theirs)).status, 403, 'a signed-out session’s URL');

  // the folder as it was asked for: a render added since is in no zip of an older URL (asked again, it is)
  const mine = await zipUrl(bearer);
  const later = makeVideo(path.join(dir, 'in/later.mp4'), { w: 320, h: 180, dur: 1, gop: 10, pattern: 'smptebars', freq: 660 });
  const added = await tusUpload(request, later, { filename: 'later.mp4', folder: 'Acme' }, bearer);
  assert.equal(added.status, 200, added.text);
  const old = await zip(mine);
  assert.equal(old.status, 409, `an older URL of a folder that changed: ${old.status}`);
  assert.ok(!old.body.includes(fs.readFileSync(later).subarray(0, 4096)));
  const fresh = await zip(await zipUrl(bearer));
  assert.equal(fresh.status, 200);
  assert.ok(fresh.body.includes(fs.readFileSync(later).subarray(0, 4096)), 'a fresh URL zips it');

  // a URL sealed before the asker was (a team zip naming only the folder) is no longer taken
  const bare = String(new URL(`http://${MEDIA}${mine}`).pathname.split('/')[3]);
  const claims = openMedia<{ z: Record<string, unknown>; n: string }>(bare);
  assert.ok(claims?.z.i && claims.z.p, 'the asker and the listing are sealed in');
  const { i: _i, p: _p, ...unbound } = claims.z;
  const legacy = `/media/z/${sealMedia({ z: unbound, n: claims.n }, 3600)}/x.zip`;
  assert.equal((await zip(legacy)).status, 403);
});

test('scripts/smoke.ts --media checks the media host: alive, in the CSP, and serving nothing but signed media', async () => {
  const { smoke, getter } = await import('../../scripts/smoke.ts');
  const named = (checks: { name: string; level: string; detail: string }[]) =>
    checks.filter((c) => /media host/.test(c.name)).map((c) => `${c.level} ${c.name}: ${c.detail}`);
  const good = named(await smoke(`http://${APP}:${port}`, getter({ connect: '127.0.0.1' }), { media: `http://${MEDIA}:${port}` }));
  assert.equal(good.length, 3, good.join('\n'));
  assert.ok(
    good.every((c) => c.startsWith('ok ')),
    good.join('\n'),
  );
  // A media host this server doesn't know is the app itself to it: it serves the app's paths, and the CSP doesn't name it.
  const wrong = named(await smoke(`http://${APP}:${port}`, getter({ connect: '127.0.0.1' }), { media: `http://127.0.0.1:${port}` }));
  assert.ok(
    wrong.some((c) => c.startsWith('fail the player may load the media host')),
    wrong.join('\n'),
  );
  assert.ok(
    wrong.some((c) => c.startsWith('fail the media host serves signed media only')),
    wrong.join('\n'),
  );
});
