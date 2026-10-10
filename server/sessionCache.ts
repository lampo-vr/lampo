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
  /**
   * The sessions as they are now, for a decision about what runs (is that agent running already?): only from a load
   * that began after this call. One still running from before is waited out and then asked again (it may predate a
   * session started since), and one that fails is asked again; when none answers, `SessionsUnknownError`, never the
   * old list and never "none".
   */
  current(): Promise<ClaudeSession[]>;
  refresh(): Promise<ClaudeSession[]>;
  readonly at: number;
  readonly refreshing: boolean;
}

/** The sessions couldn't be listed just now: whether an agent is running is unknown, so nothing is decided on it. */
export class SessionsUnknownError extends Error {
  constructor(cause?: unknown) {
    super('couldn’t tell which agents are running just now', { cause });
  }
}

export function createSessionCache(
  broadcast: Broadcast,
  load: () => Promise<ClaudeSession[]> = listSessions,
  { firstWaitMs = 1000, tries = 3, againMs = 1000 }: { firstWaitMs?: number; tries?: number; againMs?: number } = {},
): SessionCache {
  let at = 0;
  let list: ClaudeSession[] = [];
  let loading: Promise<ClaudeSession[]> | null = null;
  // the load running now as it settles (a failure rejects), and how many have begun: `current` tells a load that began
  // after it was asked from one that was already on its way
  let attempt: Promise<ClaudeSession[]> | null = null;
  let begun = 0;

  const refresh = (): Promise<ClaudeSession[]> => {
    if (loading) return loading;
    begun++;
    attempt = load();
    loading = attempt
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

  const current = async (): Promise<ClaudeSession[]> => {
    const asked = begun;
    let failed: unknown;
    for (let i = 0; i < tries; i++) {
      if (i) await new Promise((r) => setTimeout(r, againMs));
      // begun before this ask: it may not know a session started since, so it ends first and we ask again
      if (loading && begun === asked) await loading;
      refresh();
      try {
        return await (attempt as Promise<ClaudeSession[]>);
      } catch (e) {
        failed = e;
      }
    }
    throw new SessionsUnknownError(failed);
  };

  return {
    current,
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
