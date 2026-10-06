// A video id nobody tracks is a 404, whatever the route and however it is spelled (audit A12 verification, VERIFY-1
// and VERIFY-2). Asking must leave nothing behind: a GET of /api/review/<any valid slug> once made an empty folder
// named after it in the workspace's data folder, so any reader could make unlimited folders that every listing then
// walks. A malformed id (a dot segment or a NUL, encoded) or one longer than a folder name was answered 500, with a
// stack trace in the log on every request: a cheap way to flood the log.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';
import { registeredRoutes } from '../lib/routes.ts';

isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: 'http://review.test', VR_STT: 'off' } });
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const auth = await import('../../lib/auth.ts');
const paths = await import('../../lib/paths.ts');

const ctx = createContext({ cfg: loadConfig(), token: 'unused' });
const app = createApp(ctx);
let server: http.Server;
let port = 0;
let bearer: Record<string, string> = {};
before(async () => {
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  const owner = await auth.createUser({ email: 'owner@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
  bearer = { Authorization: `Bearer ${auth.createToken(owner.id, 'test').token}` };
});
after(() => {
  server.closeAllConnections();
  server.close();
});

function ask(method: string, url: string, body?: string): Promise<number> {
  return new Promise((resolve) => {
    const h: Record<string, string> = { Host: 'review.test', ...bearer };
    if (body !== undefined) {
      h['content-type'] = 'application/json';
      h['content-length'] = String(Buffer.byteLength(body));
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h, agent: false }, (res) => {
      const timer = setTimeout(() => {
        req.destroy();
        resolve(res.statusCode || 0);
      }, 400);
      res.resume();
      res.on('end', () => {
        clearTimeout(timer);
        resolve(res.statusCode || 0);
      });
    });
    req.on('error', () => resolve(0));
    req.end(body);
  });
}

const entries = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
};

/** Every route with a video id, asked with `id` in its place as the owner; what came back 5xx, and what was logged. */
async function walk(id: string): Promise<{ problems: string[]; logged: string[] }> {
  const routes = registeredRoutes(app).filter(([, p]) => p.includes(':slug'));
  assert.ok(routes.length > 30, `found ${routes.length} routes with a video id`);
  const logged: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => {
    logged.push(a.map(String).join(' '));
  };
  const problems: string[] = [];
  try {
    for (const [m, pattern] of routes)
      for (const method of m === '*' ? ['GET', 'POST'] : [m]) {
        const url = pattern
          .replace(/:slug/g, id)
          .replace(/:id/g, 'c_000000')
          .replace(/:v/g, '1')
          .replace(/:[a-z]+/gi, 'x');
        const status = await ask(method, url, ['GET', 'HEAD'].includes(method) ? undefined : '{}');
        if (status >= 500 || status === 0) problems.push(`${method} ${pattern} → ${status}`);
      }
  } finally {
    console.error = original;
  }
  return { problems, logged };
}
const disk = () => ({ data: entries(paths.DATA), versions: entries(paths.VERSIONS), cache: entries(paths.CACHE) });

test('a video nobody tracks: every route answers without leaving a folder behind', async () => {
  const before = disk();
  const { problems } = await walk(encodeURIComponent('__Users__nobody__Clients__spot.mp4'));
  assert.deepEqual(problems, [], problems.join('\n'));
  assert.deepEqual(disk(), before, 'nothing made on disk');
});

test('a malformed or overlong video id is a plain 404: never a 5xx, never a stack trace in the log, never a folder', async () => {
  const before = disk();
  const ids: [string, string][] = [
    ['dot segment', '..%2F..%2Fsecret'],
    ['NUL', 'x%00y'],
    ['overlong', encodeURIComponent(`__${'a'.repeat(300)}.mp4`)],
  ];
  for (const [what, id] of ids) {
    const { problems, logged } = await walk(id);
    assert.deepEqual(problems, [], `${what}:\n${problems.join('\n')}`);
    assert.deepEqual(
      logged.filter((l) => /\n\s+at /.test(l)),
      [],
      `${what}: no stack traces in the log`,
    );
    assert.equal(await ask('GET', `/api/review/${id}`), 404, what);
  }
  assert.deepEqual(disk(), before, 'nothing made on disk');
});
