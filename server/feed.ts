// Every new line of data/events.jsonl goes out as an SSE "event" with the full event, whoever wrote it (the server,
// the CLI, another session). Remote `vr watch` and MCP clients follow the review this way. Each workspace has its own
// log (lib/workspaces.ts): its lines go out in that workspace only, and webhooks, push and checks run there.
import fs from 'node:fs';
import { inWorkspace } from '../lib/scope.ts';
import * as store from '../lib/store.ts';
import type { ReviewEvent } from '../lib/types.ts';
import { workspaceIds } from '../lib/workspaces.ts';
import type { ServerContext } from './context.ts';
import type { Broadcast } from './events.ts';

export interface Feed {
  stop(): void;
}

interface FeedOptions {
  interval?: number;
  /** What subscribers may see of an event (a hosted server swaps its screenshot paths for URLs). */
  publicEvent?: (e: ReviewEvent) => ReviewEvent;
  /** The raw event, for in-process consumers that publish on their own (webhooks, push). */
  onEvent?: (e: ReviewEvent) => void;
}

/**
 * The feed as the server process runs it: public events to browsers and agents, raw ones to webhooks and push. A new
 * render registered by another process (`vr push`, `vr sync`) is compared with the fix previews of its notes.
 */
export function startServerFeed(ctx: Pick<ServerContext, 'broadcast' | 'publicEvent' | 'webhooks' | 'push' | 'background' | 'runs'>, interval?: number): Feed {
  return startFeed(ctx.broadcast, {
    interval,
    publicEvent: ctx.publicEvent,
    onEvent: (e) => {
      ctx.webhooks.handle(e);
      ctx.push.handle(e);
      // versions, statuses, questions and answers from every process move agents' runs (server/runs.ts)
      ctx.runs.event(e);
      if (e.type === 'version' && e.slug) {
        const review = store.loadReview(e.slug);
        if (review) ctx.background.checkPreviews(review);
      }
    },
  });
}

const sizeOf = (file: string): number | null => {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
};

export function startFeed(broadcast: Broadcast, { interval = 500, publicEvent = (e) => e, onEvent }: FeedOptions = {}): Feed {
  // Where each workspace's log was read up to. Logs there at start are followed from their end; a workspace that
  // appears later is followed from its first line (everything in it is new). The start is the first moment the list of
  // workspaces can be read (it is at a server's start; never replay a log because it wasn't).
  const tails = new Map<string, { pos: number; partial: string }>();
  let started = false;
  const start = () => {
    for (const ws of workspaceIds()) tails.set(ws, { pos: sizeOf(store.eventsFile(ws)) ?? 0, partial: '' });
    started = true;
  };
  // While the list can't be read (lib/workspaces.ts WorkspacesLostError: requests answer 503), the feed waits and says
  // so once, and once more when it can be read again; nothing here may end the process.
  let down: string | null = null;
  const ids = (): string[] | null => {
    try {
      if (!started) start();
      const list = workspaceIds();
      if (down) console.log('workspaces: the list of workspaces can be read again');
      down = null;
      return list;
    } catch (e) {
      const why = (e as Error).message;
      if (why !== down) console.error(`video-review: ${why}`);
      down = why;
      return null;
    }
  };
  try {
    start();
  } catch {}
  const follow = (ws: string) => {
    const file = store.eventsFile(ws);
    let t = tails.get(ws);
    if (!t) {
      t = { pos: 0, partial: '' };
      tails.set(ws, t);
    }
    const size = sizeOf(file);
    if (size === null) return;
    if (size < t.pos) t.pos = 0;
    if (size === t.pos) return;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - t.pos);
    fs.readSync(fd, buf, 0, buf.length, t.pos);
    fs.closeSync(fd);
    t.pos = size;
    const lines = (t.partial + buf.toString('utf8')).split('\n');
    t.partial = lines.pop() || '';
    for (const l of lines) {
      let e: ReviewEvent;
      try {
        e = store.shownEvent(JSON.parse(l));
      } catch {
        continue;
      }
      // another store's history, which an earlier version's import appended here (store.appendHistory): never news
      if (e.imported) continue;
      broadcast('event', publicEvent(e));
      onEvent?.(e);
    }
  };
  const tick = () => {
    for (const ws of ids() ?? []) {
      try {
        inWorkspace(ws, () => follow(ws));
      } catch (e) {
        console.error(`events of ${ws}:`, (e as Error).message);
      }
    }
  };
  const timer = setInterval(tick, interval);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
