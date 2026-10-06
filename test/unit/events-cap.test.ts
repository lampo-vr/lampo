// /api/events streams are capped per person (A12-D13): one reviewer token held 716 of them open on a hosted server, each
// written every event (37 MB in 10 s at 10 events a second). A person's browsers, `vr watch` and the stdio MCP servers
// of their agents (one stream each) fit in EVENT_LIMITS.perPerson; one more is told so, and a closed one frees its place.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { isolatedEnv, sleep } from '../lib/helpers.ts';

isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: 'http://review.test' } });
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const { EVENT_LIMITS } = await import('../../server/events.ts');
const auth = await import('../../lib/auth.ts');

const ctx = createContext({ cfg: loadConfig(), token: 'unused' });
let server: http.Server;
let port = 0;
before(async () => {
  server = http.createServer(createApp(ctx));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

/** Opens /api/events with a token: its status, and the request to end it with. */
function stream(token: string): Promise<{ status: number; body: string; end: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/events', headers: { Host: 'review.test', Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          body += d;
        });
        // A refusal is a whole answer; a stream stays open: what it said first is enough.
        const answer = () => resolve({ status: res.statusCode || 0, body, end: () => req.destroy() });
        if (res.statusCode !== 200) res.on('end', answer);
        else setTimeout(answer, 50);
      },
    );
    req.on('error', (e) => (String(e).includes('socket hang up') ? undefined : reject(e)));
    req.end();
  });
}

test('A12-D13: a person holds at most EVENT_LIMITS.perPerson live streams, across their tokens; others aren’t touched', async () => {
  const was = EVENT_LIMITS.perPerson;
  EVENT_LIMITS.perPerson = 3;
  try {
    const rex = await auth.createUser({ email: 'rex@example.com', name: 'Rex', password: 'a long password', role: 'reviewer' });
    const ida = await auth.createUser({ email: 'ida@example.com', name: 'Ida', password: 'a long password', role: 'member' });
    const [one, two] = [auth.createToken(rex.id, 'one').token, auth.createToken(rex.id, 'two').token];
    const open = [await stream(one), await stream(one), await stream(two)];
    assert.deepEqual(
      open.map((s) => s.status),
      [200, 200, 200],
    );
    const over = await stream(two);
    assert.equal(over.status, 429, 'a fourth, from either token');
    assert.match(JSON.parse(over.body).error, /too many open live streams for your account: at most 3/);
    // Someone else in the workspace still follows.
    const theirs = await stream(auth.createToken(ida.id, 'agent').token);
    assert.equal(theirs.status, 200);
    theirs.end();
    // A closed stream frees its place.
    open[0]?.end();
    await sleep(200);
    const again = await stream(one);
    assert.equal(again.status, 200);
    for (const s of [again, ...open.slice(1)]) s.end();
  } finally {
    EVENT_LIMITS.perPerson = was;
  }
});
