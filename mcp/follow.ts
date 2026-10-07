// Change notifications over stdio. /mcp hears every review event from the app's feed (server/routes/mcp.ts); a stdio
// server has no app around it, so each connection follows the backend's event feed itself — the store's events.jsonl,
// or a hosted server's live events — from connect until the client goes away, and says the same: lampo://inbox and the
// event's lampo://review/<slug> were updated (and their older vr:// addresses), the list changed when a video arrived,
// left or moved.
// A 2026-07-28 client asks with subscriptions/listen, which serveStdio answers and filters on its own. A 2025 client
// asks with resources/subscribe, which the SDK leaves to us: it hears only about what it subscribed to.
import type { McpServer } from '@modelcontextprotocol/server';
import type { Backend } from '../lib/backend/types.ts';
import type { EventType, ReviewEvent } from '../lib/types.ts';
import { changedUris } from './format.ts';

/** Events that add a video to lampo://review/{slug}, take one away, or change how it is listed (its folder). */
const LIST_CHANGES: EventType[] = ['added', 'removed', 'moved'];

export function followChanges(
  server: McpServer,
  o: { backend: Backend; era: 'legacy' | 'modern'; onerror?: (e: Error) => void; onEvent?: (e: ReviewEvent) => void },
): void {
  const low = server.server;
  // 2025: only what the client subscribed to (the spec: "only … if the client previously sent resources/subscribe").
  const subscribed = o.era === 'legacy' ? new Set<string>() : null;
  if (subscribed) {
    low.setRequestHandler('resources/subscribe', (req) => {
      subscribed.add(req.params.uri);
      return {};
    });
    low.setRequestHandler('resources/unsubscribe', (req) => {
      subscribed.delete(req.params.uri);
      return {};
    });
  }
  const updated = (uri: string) => {
    if (subscribed && !subscribed.has(uri)) return;
    low.sendResourceUpdated({ uri }).catch(() => {});
  };

  const stop = new AbortController();
  const closed = low.onclose;
  low.onclose = () => {
    stop.abort();
    closed?.();
  };
  o.backend
    .watch(
      (e) => {
        o.onEvent?.(e);
        if (!server.isConnected()) return;
        for (const uri of changedUris(e.slug)) updated(uri);
        if (LIST_CHANGES.includes(e.type)) server.sendResourceListChanged();
      },
      { signal: stop.signal },
    )
    .catch((e: Error) => o.onerror?.(e));
}
