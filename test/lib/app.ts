// One in-process app for an API test, started the way server/index.ts starts it. Call it at the top level of a test
// file (top-level await), after isolatedEnv(): it imports lib/* only then, and registers its own `after` to stop the
// server. Not inside a hook: that `after` would run when the hook ends. Below some tests, nothing else may be awaited
// at the top level between it and the tests that use it: node:test runs a file's `after` as soon as the tests
// registered so far are done. Inside a test() body it is that test's own server.
//
// Kept-alive connections stay open like production's (65 s). Node's default is 5 s, and the test and the server share
// one event loop: when a synchronous ffmpeg, `vr` or scrypt in the test blocks that loop for longer than 5 s on a
// loaded machine, the next request goes out on a pooled socket at the very moment the server's idle timer closes it,
// and the test fails with ECONNRESET ("fetch failed") although nothing is wrong.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after } from 'node:test';
import type { Express } from 'express';
import type { AppOptions } from '../../server/app.ts';
import type { ContextOptions, ServerContext } from '../../server/context.ts';
import type { Feed } from '../../server/feed.ts';
// only types above it: importing it loads no lib/* before isolatedEnv()
import { type ServerTimeouts, serverTimeouts } from '../../server/listen.ts';
import { client, type Request } from './http.ts';

export interface TestApp {
  ctx: ServerContext;
  app: Express;
  server: http.Server;
  port: number;
  /** http://127.0.0.1:<port> */
  base: string;
  /** node:http requests (test/lib/http.ts) that send `headers` with every one */
  request: Request;
  /** The live feed when one was asked for (`feed`): events.jsonl → SSE, webhooks, push. */
  feed: Feed | null;
  /** Stops the feed and the server, open event streams included; registered as an `after` already. */
  close(): Promise<void>;
}

export interface StartOptions extends Partial<ContextOptions> {
  /** A context made by the test (to wrap its hooks first); otherwise one from `cfg` (default: loadConfig()). */
  ctx?: ServerContext;
  ui?: AppOptions['ui'];
  /** Headers on every `request` (Host, Origin, Connection: close …). */
  headers?: Record<string, string>;
  /** Start the server's feed, polling events.jsonl every this many ms. */
  feed?: number;
  /** Other timeouts than production's (a test of them, scaled down). */
  timeouts?: ServerTimeouts;
}

/**
 * The production timeouts on any server a test starts itself (see the top of this file; server/listen.ts): keep-alive,
 * headers, and a body's time — an upload's hours only for a render's body.
 */
export const productionTimeouts = (server: http.Server, timeouts?: ServerTimeouts): http.Server => serverTimeouts(server, timeouts);

export async function startApp({ ctx, ui, headers, feed, timeouts, cfg, token = 'unused', ...rest }: StartOptions = {}): Promise<TestApp> {
  const { loadConfig } = await import('../../lib/config.ts');
  const { createContext } = await import('../../server/context.ts');
  const { createApp } = await import('../../server/app.ts');
  const { startServerFeed } = await import('../../server/feed.ts');
  const context = ctx ?? createContext({ cfg: cfg ?? loadConfig(), token, ...rest });
  const app = createApp(context, ui ? { ui } : {});
  const server = productionTimeouts(http.createServer(app), timeouts);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const running = feed === undefined ? null : startServerFeed(context, feed);
  let closed: Promise<void> | null = null;
  const close = () =>
    (closed ??= new Promise<void>((resolve) => {
      running?.stop();
      server.closeAllConnections();
      server.close(() => resolve());
    }));
  after(close);
  return { ctx: context, app, server, port, base: `http://127.0.0.1:${port}`, request: client(port, headers), feed: running, close };
}
