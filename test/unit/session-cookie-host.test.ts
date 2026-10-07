// On a server reached over https the session cookie is `__Host-vr_session`: the browser takes it only from this exact
// host, Secure, for the whole site — a sibling subdomain (another tenant's site on a shared domain) can't set or
// overwrite it, which a plain `vr_session` allowed (session fixation). So over https a `vr_session` is never read,
// never moved to the new name — a sibling could have set it to a session of its own — and the answer expires it.
// Over plain http (the machine, a local test) the name stays `vr_session`: browsers refuse `__Host-` cookies there.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';
import { client, type Request } from '../lib/http.ts';

const PUBLIC = 'https://review.test';
isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const auth = await import('../../lib/auth.ts');

let server: http.Server;
let request: Request;
let user: Awaited<ReturnType<typeof auth.createUser>>;
before(async () => {
  server = http.createServer(createApp(createContext({ cfg: loadConfig(), token: 'unused' })));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  request = client((server.address() as AddressInfo).port, { Host: 'review.test', Origin: PUBLIC });
  user = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
});
after(() => server.close());

const setCookies = (r: { headers: http.IncomingHttpHeaders }) => ([] as string[]).concat(r.headers['set-cookie'] || []);
const named = (r: { headers: http.IncomingHttpHeaders }, name: string) => setCookies(r).find((h) => h.startsWith(`${name}=`));
const cookieValue = (h: string) => h.split(';')[0]?.split('=').slice(1).join('=') ?? '';

test('signing in over https sets __Host-vr_session: Secure, the whole site, no Domain', async () => {
  const r = await request('POST', '/api/auth/login', { body: { email: 'olivia@example.com', password: 'a long password' } });
  assert.equal(r.status, 200, r.text);
  const h = named(r, '__Host-vr_session');
  assert.ok(h, `the session cookie: ${setCookies(r).join(' | ')}`);
  assert.match(h, /; Path=\/;/);
  assert.match(h, /; Secure/);
  assert.match(h, /HttpOnly; SameSite=Lax/);
  assert.doesNotMatch(h, /Domain=/i);
  assert.equal(named(r, 'vr_session') ?? '', '', 'no cookie under the old name');
  const me = await request('GET', '/api/auth/me', { headers: { Cookie: `__Host-vr_session=${cookieValue(h)}` } });
  assert.equal(me.status, 200);
  assert.equal(named(me, '__Host-vr_session'), undefined, 'nothing to move');
});

test('over https a session under the old name is nobody’s: never read, never moved, expired', async () => {
  // what a sibling subdomain can set for the whole domain: a session of its own account under the plain name
  const mallory = await auth.createUser({ email: 'mallory@example.com', name: 'Mallory', password: 'a long password', role: 'owner' });
  const planted = auth.signSession(mallory);
  const me = await request('GET', '/api/auth/me', { headers: { Cookie: `vr_session=${planted}` } });
  assert.equal(me.status, 401, me.text);
  assert.equal(named(me, '__Host-vr_session'), undefined, `never moved to the new name: ${setCookies(me).join(' | ')}`);
  const write = await request('POST', '/api/folders', { body: { name: 'Planted' }, headers: { Cookie: `vr_session=${planted}` } });
  assert.equal(write.status, 401, 'nothing lands as the planted account');
  // beside the person's own session: theirs is the one read, and the planted one goes
  const own = auth.signSession(user);
  const both = await request('GET', '/api/auth/me', { headers: { Cookie: `vr_session=${planted}; __Host-vr_session=${own}` } });
  assert.equal(both.status, 200, both.text);
  assert.equal(both.json().user.id, user.id);
  assert.match(named(both, 'vr_session') ?? '', /Max-Age=0/, 'the planted cookie expired');
  assert.equal(named(both, '__Host-vr_session'), undefined, 'the own session stays as it is');
});

test('signing out ends the session under either name and clears both', async () => {
  const value = auth.signSession(user);
  const out = await request('POST', '/api/auth/logout', { headers: { Cookie: `__Host-vr_session=${value}` } });
  assert.equal(out.status, 200);
  // the browser's HTTP cache goes too: the account's renders and pictures are kept there as immutable
  assert.equal(out.headers['clear-site-data'], '"cache"');
  assert.match(named(out, '__Host-vr_session') ?? '', /Max-Age=0/);
  assert.match(named(out, 'vr_session') ?? '', /Max-Age=0/);
  assert.equal((await request('GET', '/api/auth/me', { headers: { Cookie: `__Host-vr_session=${value}` } })).status, 401, 'revoked');
  const legacy = auth.signSession(user);
  await request('POST', '/api/auth/logout', { headers: { Cookie: `vr_session=${legacy}` } });
  assert.equal((await request('GET', '/api/auth/me', { headers: { Cookie: `vr_session=${legacy}` } })).status, 401, 'the old name’s too');
});
