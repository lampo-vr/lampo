// Live updates over Server-Sent Events: the UI refetches whatever an event names. Every stream belongs to the workspace
// its request worked in, and every event to the workspace of the work that told it (lib/scope.ts): a stream only ever
// hears its own workspace. An event told outside any workspace on a server with several reaches nobody.
import type { Request, Response } from 'express';
import { type Action, can } from '../lib/permissions.ts';
import { currentWorkspace, DEFAULT_WORKSPACE } from '../lib/scope.ts';
import type { ServerEvent } from '../lib/types.ts';

/** `need`: only streams whose role may do that hear it (the project files' changes: `files`, never a reviewer). */
export type Broadcast = (type: ServerEvent, data?: object, need?: Action) => void;

/**
 * Live streams one person holds open at once (A12-D13): their browsers (one per browser: the tabs share it), `lampo watch`
 * and the stdio MCP server of each agent (one each) fit; hundreds from one token don't. The machine itself isn't
 * counted (its owner, from the machine). Tests lower it.
 */
export const EVENT_LIMITS = { perPerson: 32 };

/** The workspace of the work telling an event, or null when it has none on a server with several (then: nobody). */
function tellingWorkspace(): string | null {
  try {
    return currentWorkspace();
  } catch {
    console.error('live update dropped: told outside any workspace');
    return null;
  }
}

export interface EventHub {
  /** To the streams of the workspace the work telling it runs for. */
  broadcast: Broadcast;
  /** To the streams of workspace `ws` (work that knows its workspace without running in it). */
  broadcastTo: (ws: string, type: ServerEvent, data?: object, need?: Action) => void;
  /**
   * To one account's own streams only (its browsers): what is nobody else's business, like its drafts. Never heard by
   * in-process listeners (MCP), never by an API token's stream.
   */
  tell: (userId: string, type: ServerEvent, data?: object) => void;
  /** In-process listeners (the MCP endpoint turns events into notifications), told the workspace; returns the unsubscribe. */
  listen: (fn: (type: ServerEvent, data: object, ws: string) => void) => () => void;
  /** GET /api/events */
  handler: (req: Request, res: Response) => void;
  /** Keep-alive comments so proxies don't drop idle streams (and each stream asked again: recheck). */
  startPing: (ms?: number) => void;
  /** Ends every stream whose caller wouldn't get it now: at once when access ended (lib/auth.ts onAccessEnded). */
  recheck: () => void;
  clients: () => number;
  /** Ends every stream (shutdown): browsers and `lampo watch` reconnect by themselves. */
  closeAll: () => void;
}

/**
 * `stillAllowed` asks again, on every keep-alive, whether the request that opened a stream would still get it: a
 * stream carries every note as it is written, so signing out, revoking the token or disabling the account ends it too.
 */
export function createEventHub({ stillAllowed }: { stillAllowed?: (req: Request) => boolean } = {}): EventHub {
  const clients = new Map<Response, Request>();
  const perPerson = new Map<string, number>();
  const listeners = new Set<(type: ServerEvent, data: object, ws: string) => void>();
  const streamWorkspace = (req: Request) => req.auth?.workspace ?? DEFAULT_WORKSPACE;
  const broadcastTo = (ws: string, type: ServerEvent, data: object = {}, need?: Action) => {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [res, req] of clients) if (streamWorkspace(req) === ws && (!need || can(req.auth?.role, need))) res.write(msg);
    for (const fn of listeners) {
      try {
        fn(type, data, ws);
      } catch {}
    }
  };
  // A stream whose caller can't be asked about right now (workspaces.json unreadable: lib/workspaces.ts) ends, as one
  // that may no longer read would: it comes back through the sign-in check, never past it.
  const allowed = (req: Request): boolean => {
    try {
      return !stillAllowed || stillAllowed(req);
    } catch {
      return false;
    }
  };
  const recheck = () => {
    for (const [res, req] of clients)
      if (!allowed(req)) {
        clients.delete(res);
        res.end();
      }
  };
  const broadcast: Broadcast = (type, data = {}, need) => {
    const ws = tellingWorkspace();
    if (ws) broadcastTo(ws, type, data, need);
  };
  return {
    broadcast,
    broadcastTo,
    tell(userId, type, data = {}) {
      const ws = tellingWorkspace();
      if (!ws) return;
      const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const [res, req] of clients) if (req.auth?.user?.id === userId && req.auth.via !== 'token' && streamWorkspace(req) === ws) res.write(msg);
    },
    listen(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    handler(req, res) {
      const person = req.auth && req.auth.via !== 'local' ? (req.auth.user?.id ?? null) : null;
      if (person && (perPerson.get(person) ?? 0) >= EVENT_LIMITS.perPerson) {
        res
          .status(429)
          .set('Retry-After', '30')
          .json({ error: `too many open live streams for your account: at most ${EVENT_LIMITS.perPerson} (close a tab, a lampo watch or an agent first)` });
        return;
      }
      // no-transform: a proxy or CDN in front passes each event on as it comes (nothing to compress or rewrite).
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      clients.set(res, req);
      if (person) perPerson.set(person, (perPerson.get(person) ?? 0) + 1);
      req.on('close', () => {
        clients.delete(res);
        if (!person) return;
        const n = (perPerson.get(person) ?? 1) - 1;
        if (n > 0) perPerson.set(person, n);
        else perPerson.delete(person);
      });
    },
    startPing(ms = 25000) {
      setInterval(() => {
        recheck();
        for (const res of clients.keys()) res.write(': ping\n\n');
      }, ms).unref();
    },
    recheck,
    clients: () => clients.size,
    closeAll() {
      for (const res of clients.keys()) res.end();
      clients.clear();
    },
  };
}
