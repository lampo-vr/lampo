// Binding the port, with an answer a person can act on. Express 5 hands a listen error to the callback instead of
// throwing, so a callback that ignores its argument leaves a process that says it's serving and isn't (with watchers
// and jobs running on the store behind nobody's back).
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Express } from 'express';

/**
 * The server's timeouts. Kept-alive connections stay open longer than a proxy keeps its idle upstream ones (Caddy,
 * nginx: ≤ 60 s): if Node closed first, the proxy could send the next request into a closing socket and answer 502.
 * A request's headers come within a minute, its body within Node's own 5 minutes (`request`). A render's body may
 * stream for hours (`upload`, `uploadBody`): a whole render in one PUT to a one-time upload URL (up to LAMPO_UPLOAD_MAX,
 * 20 GB) or a tus piece on an ordinary uplink, which Node's 5 minutes cut off. Uploads have their own bounds (size, a
 * URL's 15 minutes to start, tus resuming), so the long time only ends a body that never finishes; given to every
 * request, it let a JSON body trickled in byte by byte hold a connection for hours (sweep 2 MH-4).
 */
export const SERVER_TIMEOUTS = { keepAlive: 65_000, headers: 66_000, request: 300_000, upload: 6 * 3600_000 } as const;

export interface ServerTimeouts {
  keepAlive: number;
  headers: number;
  request: number;
  upload: number;
}

/** The requests whose body is a render: tus's (a new upload with its first bytes, each piece after) and a one-time
 * upload URL's PUT (server/routes/uploads.ts), on the app host and the media host alike. Exact paths only: any other
 * spelling is refused before its body is read (server/guard.ts canonicalPaths). */
const UPLOAD_BODIES: readonly [string, RegExp][] = [
  ['POST', /^\/api\/uploads$/],
  ['PATCH', /^\/api\/uploads\/[a-f0-9]{32}$/],
  ['PUT', /^\/api\/uploads\/direct\/vrup_[\w-]{32}$/],
];

export const uploadBody = (method: string | undefined, url: string | undefined): boolean => {
  const p = (url ?? '').split('?')[0] as string;
  return UPLOAD_BODIES.some(([m, re]) => m === method && re.test(p));
};

/**
 * Sets the timeouts on `server`. Node's own check (every 30 s) holds every body to the longest, an upload's; before it,
 * each request's own deadline cuts a body that hasn't arrived in its time, as Node does: 408, and the connection closed.
 */
export function serverTimeouts<S extends Server>(server: S, t: ServerTimeouts = SERVER_TIMEOUTS): S {
  server.keepAliveTimeout = t.keepAlive;
  server.headersTimeout = t.headers;
  server.requestTimeout = t.upload;
  server.prependListener('request', (req: IncomingMessage, res: ServerResponse) => bodyDeadline(req, res, t));
  return server;
}

function bodyDeadline(req: IncomingMessage, res: ServerResponse, t: ServerTimeouts): void {
  const start = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const cutAfter = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (req.complete) return;
      const socket = req.socket;
      if (!socket.destroyed && socket.writable && !res.headersSent) socket.write('HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }, ms);
    timer.unref();
  };
  const upload = uploadBody(req.method, req.url);
  cutAfter(upload ? t.upload : t.request);
  // An upload answered before its body is in (refused, say) has the rest thrown away within a body's time from its start.
  if (upload)
    res.once('finish', () => {
      if (!req.complete) cutAfter(Math.max(0, start + t.request - Date.now()));
    });
  // the body arrived (read, or thrown away after the answer), or the connection ended
  req.once('close', () => clearTimeout(timer));
}

export function listen(app: Express, port: number, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, (err?: Error) => {
      if (!err) return resolve(server);
      const code = (err as NodeJS.ErrnoException).code;
      const where = `${host}:${port}`;
      reject(
        new Error(
          code === 'EADDRINUSE'
            ? `${where} is already in use (another Lampo?). Stop it, or pick a free port with LAMPO_PORT.`
            : code === 'EACCES'
              ? `not allowed to listen on ${where} (ports below 1024 need privileges). Pick another with LAMPO_PORT.`
              : `can't listen on ${where}: ${err.message}`,
        ),
      );
    });
  });
}
