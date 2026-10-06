// `claude agents --json` takes seconds, so the list is cached and refreshed in the background.
import { listSessions } from '../lib/sessions.ts';
import type { ClaudeSession } from '../lib/types.ts';
import type { Broadcast } from './events.ts';

export interface SessionCache {
  /**
   * The cached list; refreshed in the background when older than 15 s, awaited when `fresh`. The first ask waits at
   * most `firstWaitMs` (a second) for the first load, then answers with nothing yet: the library's first load waits
   * on it, and the CLI may hang (A12 INV-7); a `sessions` event says when the list arrives.
   */
  get(opts?: { fresh?: boolean }): Promise<ClaudeSession[]>;
  refresh(): Promise<ClaudeSession[]>;
  readonly at: number;
  readonly refreshing: boolean;
}

export function createSessionCache(
  broadcast: Broadcast,
  load: () => Promise<ClaudeSession[]> = listSessions,
  { firstWaitMs = 1000 }: { firstWaitMs?: number } = {},
): SessionCache {
  let at = 0;
  let list: ClaudeSession[] = [];
  let loading: Promise<ClaudeSession[]> | null = null;

  const refresh = (): Promise<ClaudeSession[]> => {
    if (loading) return loading;
    loading = load()
      .then((fresh) => {
        at = Date.now();
        list = fresh;
        loading = null;
        broadcast('sessions');
        return fresh;
      })
      .catch(() => {
        loading = null;
        return list;
      });
    return loading;
  };

  return {
    async get({ fresh = false } = {}) {
      if (fresh) return refresh();
      if (!at) {
        let timer: NodeJS.Timeout | undefined;
        const waited = new Promise<ClaudeSession[]>((done) => {
          timer = setTimeout(() => done(list), firstWaitMs);
        });
        return Promise.race([refresh(), waited]).finally(() => clearTimeout(timer));
      }
      if (Date.now() - at > 15000) refresh();
      return list;
    },
    refresh,
    get at() {
      return at;
    },
    get refreshing() {
      return !!loading;
    },
  };
}
