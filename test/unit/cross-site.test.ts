// On a person's own machine the owner is signed in by address: any request from loopback is theirs. So a page the
// owner opens elsewhere must not be able to make the owner's requests either — embed a render, a frame or a poster,
// find out which videos exist, start ffmpeg work (A12 WEB-4). Browsers say where a request comes from (Fetch
// Metadata): every registered route is asked from another site and from this host on another port, the way an <img>, a
// <video>, a fetch() or a link would; only the app's pages and files, the public paths and review links answer. The same
// requests from the app itself, from an agent (no Fetch Metadata) and typed into the address bar still work, and the
// LAN link and review links keep working. Media, frames, posters and API answers say Cross-Origin-Resource-Policy:
// same-origin, so no other page can load them whatever it carries.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { age, isolatedEnv, makeVideo, tmpdir } from '../lib/helpers.ts';
import { registeredRoutes } from '../lib/routes.ts';

const { dir } = isolatedEnv({ vars: { VR_STT: 'off' } });
const store = await import('../../lib/store.ts');
const shares = await import('../../lib/shares.ts');
const { slugify } = await import('../../lib/paths.ts');
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp, staticUi } = await import('../../server/app.ts');
const { isPublicPath, RETURNS_FROM_ELSEWHERE } = await import('../../server/guard.ts');

const video = makeVideo(path.join(dir, 'proj/export/spot.mp4'), { w: 160, h: 90, dur: 1 });
age(video);
store.createOrGetReview(video, { by: 'tester' });
const slug = slugify(path.resolve(video));
const s = encodeURIComponent(slug);
const note = store.addComment(slug, { frame: 3, text: 'Logo später', author: 'tester' });
const link = shares.createShare(slug, { label: 'Client' });
const guestVideo = shares.guestId(link, slug);

const SHELL = '<!doctype html><title>shell</title><p>app shell</p>';
const dist = tmpdir('vr-dist-');
fs.writeFileSync(path.join(dist, 'index.html'), SHELL);
const LAN = 'lan-token-xsite';
const app = createApp(createContext({ cfg: loadConfig(), lan: true, token: LAN, loadSessions: async () => [] }), { ui: staticUi(dist) });
let server: http.Server;
let port = 0;
before(async () => {
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}
/** One request from loopback (the owner, by address); streams are cut after a moment, their status is what counts. */
function ask(method: string, url: string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve) => {
    const h: Record<string, string> = { Host: `127.0.0.1:${port}`, ...headers };
    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? '{}' : undefined;
    if (body) Object.assign(h, { 'content-type': 'application/json', 'content-length': '2' });
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h, agent: false }, (res) => {
      let text = '';
      const done = () => resolve({ status: res.statusCode || 0, headers: res.headers, text });
      const timer = setTimeout(() => {
        req.destroy();
        done();
      }, 400);
      res.setEncoding('utf8');
      res.on('data', (d) => {
        if (text.length < 4000) text += d;
      });
      res.on('end', () => {
        clearTimeout(timer);
        done();
      });
      res.on('error', () => {
        clearTimeout(timer);
        done();
      });
    });
    req.on('error', (e) => resolve({ status: 0, headers: {}, text: String(e) }));
    req.end(body);
  });
}

/** What another site's page makes the browser send: an <img>/<video> (no-cors), a fetch(), a link it navigates. */
const fromElsewhere = {
  image: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' },
  video: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'video' },
  fetch: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' },
  link: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' },
  // this host on another port (a dev server on localhost:3000) is another origin all the same
  otherPort: { 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' },
};
const fromTheApp = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' };
const typed = { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };

/** A route pattern with its parameters filled in with things that exist. */
function fill(pattern: string): string {
  return pattern
    .replace(/\{\*[a-z]+\}/gi, 'x/y')
    .replace(/\/g\/:token/g, `/g/${link.token}`)
    .replace(/:slug/g, s)
    .replace(/:id/g, note.id)
    .replace(/:file/g, 'x.png')
    .replace(/:v/g, '1')
    .replace(/:[a-z]+/gi, 'x');
}
const GUEST = /^\/(g|api\/g|media\/g|data\/g)\//;
const methodsOf = (m: string) => (m === '*' ? ['GET', 'POST'] : [m]);
const refused = (r: Answer) => r.status === 403 && r.text.includes('cross-site request');

test('every route from another site: only the app pages, the public paths and review links answer, nothing runs as the owner', async () => {
  const routes = registeredRoutes(app);
  assert.ok(routes.length > 100, `found ${routes.length} routes`);
  const problems: string[] = [];
  let walked = 0;
  for (const [m, pattern] of routes) {
    for (const method of methodsOf(m)) {
      const url = fill(pattern);
      const anyone = GUEST.test(url) || (url !== '/mcp' && isPublicPath(method, url.split('?')[0]));
      for (const [how, headers] of Object.entries(fromElsewhere)) {
        // a sign-in elsewhere sending the person back: a page load from there, and only that
        const open = anyone || (how === 'link' && method === 'GET' && RETURNS_FROM_ELSEWHERE.has(url));
        const r = await ask(method, url, headers);
        walked++;
        if (open && refused(r)) problems.push(`${how} ${method} ${url}: refused, but anyone may ask it`);
        if (!open && !refused(r)) problems.push(`${how} ${method} ${url} → ${r.status} ${r.text.slice(0, 60)}`);
      }
    }
  }
  assert.ok(walked > 500, `${walked} requests`);
  assert.deepEqual(problems, [], `from another site:\n${problems.join('\n')}`);
});

test('what the audit showed: a render, a poster and a frame grab from another site are refused; from the app, an agent and the address bar they work', async () => {
  const targets = [
    [`/media/${s}/v1`, fromElsewhere.video],
    [`/api/poster/${s}.jpg`, fromElsewhere.image],
    [`/api/review/${s}/frame?frame=7`, fromElsewhere.image],
    [`/api/review/${s}`, fromElsewhere.fetch],
    [`/api/review/${s}/frame?frame=8`, fromElsewhere.otherPort],
  ] as const;
  for (const [url, headers] of targets) {
    const r = await ask('GET', url, headers);
    assert.ok(refused(r), `${url} from elsewhere → ${r.status} ${r.text.slice(0, 80)}`);
    // a guessed name and a real one look the same from there: nothing to probe
    const guess = await ask('GET', url.replace(s, encodeURIComponent('__@uploads__Sample__Lampo sample.mp4')), headers);
    assert.ok(refused(guess), `a guessed slug → ${guess.status}`);
  }
  for (const headers of [fromTheApp, {}, typed]) {
    const media = await ask('GET', `/media/${s}/v1`, { ...headers, Range: 'bytes=0-99' });
    assert.ok([200, 206].includes(media.status), `render ${JSON.stringify(headers)} → ${media.status} ${media.text.slice(0, 80)}`);
    const review = await ask('GET', `/api/review/${s}`, headers);
    assert.equal(review.status, 200, review.text);
  }
});

test('Google sending the person back to publishing’s sign-in return: a page load from there arrives, nothing else does', async () => {
  const url = '/api/publish/oauth/callback?state=made-up&code=x';
  const back = await ask('GET', url, fromElsewhere.link);
  assert.ok(!refused(back), `${back.status} ${back.text.slice(0, 80)}`);
  // without the state the person's own sign-in made, it changes nothing and says so in Settings
  assert.equal(back.status, 303);
  assert.match(String(back.headers.location), /#\/settings\/publishing\?publish_error=/);
  for (const how of ['image', 'fetch', 'otherPort'] as const) assert.ok(refused(await ask('GET', url, fromElsewhere[how])), how);
});

test('the LAN link, review links and the app’s pages still open from another site', async () => {
  // A phone opening the LAN link from a chat app or a QR scanner: a cross-site navigation that sets the cookie.
  const lan = await ask('GET', `/?t=${LAN}`, fromElsewhere.link);
  assert.equal(lan.status, 200);
  assert.equal(lan.text, SHELL);
  assert.match(String(lan.headers['set-cookie']), new RegExp(`=${LAN};.*HttpOnly`));
  // Links into the app from a mail or a chat open the app (it then asks with its own, same-origin requests).
  assert.equal((await ask('GET', '/', fromElsewhere.link)).text, SHELL);
  // A client opening a review link from an email, and that page's player.
  assert.equal((await ask('GET', `/g/${link.token}`, fromElsewhere.link)).status, 200);
  const guest = await ask('GET', `/api/g/${link.token}`, fromElsewhere.fetch);
  assert.equal(guest.status, 200, guest.text);
  const played = await ask('GET', `/media/g/${link.token}/${guestVideo}/v1`, { ...fromElsewhere.video, Range: 'bytes=0-99' });
  assert.ok([200, 206, 425].includes(played.status), `${played.status} ${played.text.slice(0, 80)}`);
});

test('media, frames, posters and API answers may only be loaded by this origin (CORP), review links’ own included', async () => {
  const corp = async (url: string, headers: Record<string, string> = fromTheApp) => (await ask('GET', url, headers)).headers['cross-origin-resource-policy'];
  for (const url of [`/media/${s}/v1`, `/api/poster/${s}.jpg`, `/api/review/${s}/frame?frame=3`, `/api/review/${s}`, `/api/g/${link.token}`]) {
    assert.equal(await corp(url), 'same-origin', url);
  }
  assert.equal(await corp(`/media/${s}/v1`, fromElsewhere.video), 'same-origin', 'on the refusal too');
});
