// The publish queue: sends the posts people published, one upload at a time, in every workspace. A post goes when it
// is due — at once, or at its time when Lampo is the one to send it (a connection that doesn't hold a schedule) — and
// passing failures (the network, a 5xx, a rate limit, a quota) are tried again later with growing waits; an upload
// YouTube can resume goes on where it stopped, also after a restart. Before anything is sent the gate is asked again:
// a final reopened, or a newer render, pauses the post (cancelled, with why). After a send it asks the platform where
// the post stands: a schedule YouTube holds until its time, Zernio's post until it is out, YouTube's upload once more
// to see whether it was kept private (an unaudited Google project).
// Never twice (A12 PUB-1): once a send reached the request that can make the post exist (`committing`), a failure
// without the platform's answer is never sent again by itself — an upload session finds out where it stands, and
// without one the post is `sent` (not confirmed) for a person to look. So is one whose tries run out, or that is
// taken back or paused, after that point: never `failed` or `cancelled`, which a Retry or a new publish sends again as
// a new upload. A post the platform holds (`remote_id`) is never sent again by the queue: a look that fails keeps where
// the post stands and marks the connection.
// On a machine that sleeps, nothing runs while it sleeps: a post due then goes when it wakes (the UI says so).
import { QueueFullError, workspaceOwner } from '../jobs.ts';
import { inWorkspace } from '../paths.ts';
import { boundToWorkspace, wsKey } from '../scope.ts';
import { loadReview } from '../store.ts';
import { instant } from '../time.ts';
import type { ConnectionKind, PostFile, PublishAccount, Review } from '../types.ts';
import { suspensionOf, workspaceIds } from '../workspaces.ts';
import { type Adapter, keptAccounts, type Outcome, PublishError, type UploadSession } from './adapter.ts';
import { changeConnection, findConnection, type StoredConnection, secretOf } from './connections.ts';
import { cachedCover, platformFile } from './kit.ts';
import { endpointsFrom, type NetOptions } from './net.ts';
import { cancelQueued, changePost, gateOf, listPosts, logPostEvent, maybeOut, PostError, type StoredPost } from './posts.ts';
import { seal, unseal } from './seal.ts';
import { createYouTube, type YouTube } from './youtube.ts';
import { createZernio } from './zernio.ts';

/** The ways to the platforms, by kind of connection. */
export interface Adapters {
  youtube: YouTube;
  zernio: Adapter;
}

/** The adapters as this process is configured (VR_PUBLISH_ENDPOINTS for fakes and proxies). */
export function createAdapters(o: { env?: NodeJS.ProcessEnv; net?: NetOptions; chunkBytes?: number; resumeWaits?: number[] } = {}): Adapters {
  const { endpoints, named } = endpointsFrom(o.env);
  const net: NetOptions = { named, ...o.net };
  return {
    youtube: createYouTube({ endpoints, net, chunkBytes: o.chunkBytes, resumeWaits: o.resumeWaits }),
    zernio: createZernio({ endpoints, net }),
  };
}

export interface PublisherOptions {
  adapters: Adapters;
  /** A hosted server runs all the time; a machine may sleep (only what the UI says differs). */
  hosted?: boolean;
  now?: () => number;
  /** How often the queue looks (default 15 s). */
  intervalMs?: number;
  /** Waits after the 1st, 2nd … failed try (default 1 min, 5 min, 15 min, 1 h, 3 h). */
  backoff?: number[];
  /** Tries before a post fails for good (default 6). */
  maxAttempts?: number;
  /** A post changed (the server tells the browsers). */
  /** A post changed (the server tells the browsers); `progress`: only how far an upload got (the post's page cares). */
  changed?: (slug: string, o?: { progress?: boolean }) => void;
  /** The workspaces to work through (default: all of them). */
  workspaces?: () => string[];
  log?: (m: string) => void;
}

export interface Publisher {
  readonly adapters: Adapters;
  start(): void;
  /** Stops looking; resolves when the send running now is done. */
  stop(): Promise<void>;
  /** One pass over every workspace (the timer calls it; tests call it). */
  tick(): Promise<void>;
  /** Look again soon (a person just published). */
  poke(): void;
  /** Resolves when nothing is being sent. */
  idle(): Promise<void>;
  /** Takes back a post: one waiting here at once, one a platform holds through the platform when it lets us. */
  cancel(id: string, by: string): Promise<StoredPost>;
  /** Checks a connection against its platform: its accounts, or why it doesn't work (in the workspace running now). */
  check(id: string): Promise<StoredConnection>;
}

const DEFAULT_BACKOFF = [60e3, 5 * 60e3, 15 * 60e3, 3600e3, 3 * 3600e3];
/** Waits between looks at a post the platform still works on (Zernio's), and how long to keep looking. */
const PROCESSING_EVERY = 60e3;
const PROCESSING_FOR = 6 * 3600e3;
/** A YouTube upload is looked at again this soon after it went out (kept private?), this many times. */
const LOCK_CHECKS = [60e3, 10 * 60e3];
/** A send whose encode couldn't be queued (the workspace's job queue is full) waits this long before asking again. */
const BUSY_WAIT = 60e3;
/** How often an upload's progress is saved (and told to its page). */
const PROGRESS_EVERY = 10_000;

/** A link people may be sent to: https, nothing else. */
const httpsLink = (u: string): boolean => {
  try {
    return new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
};

/** What a send needs before its turn: the file that goes out and the cover (A12 PUB-4). */
type Prepared = { state: 'making' } | { state: 'ready'; file: string; info: PostFile; cover: string | null } | { state: 'failed'; error: unknown };

export function createPublisher(o: PublisherOptions): Publisher {
  const now = o.now ?? Date.now;
  const backoff = o.backoff ?? DEFAULT_BACKOFF;
  const maxAttempts = o.maxAttempts ?? 6;
  const log = o.log ?? ((m: string) => console.error(m));
  const changed = o.changed ?? (() => {});
  // a workspace the server's operator suspended publishes nothing (A13 CLOUD-5): its posts wait until it is lifted
  const spaces = o.workspaces ?? (() => workspaceIds().filter((w) => !suspensionOf(w)));
  let timer: NodeJS.Timeout | null = null;
  let soon: NodeJS.Timeout | null = null;
  let running: Promise<void> = Promise.resolve();
  let ticking: Promise<void> | null = null;
  let stopped = false;
  // Files being made for sends due (the final fetched, or the platform's encode, and the cover), by post and round: made
  // outside the send slot every workspace shares, so a send that waits for ffmpeg holds nobody's upload back (PUB-4).
  const prepared = new Map<string, Prepared>();
  const preparing = new Set<Promise<void>>();
  /** Posts whose file is being made now (wsKey of the id): their turn comes once it is ready, not while it is made. */
  const making = new Set<string>();

  const adapterOf = (kind: ConnectionKind): Adapter => o.adapters[kind];
  const iso = (t: number) => new Date(t).toISOString();

  /** Saves a change of a post and tells the browsers. */
  const update = (id: string, fn: (p: StoredPost) => void, o: { progress?: boolean } = {}): StoredPost | null => {
    try {
      const p = changePost(id, (x) => {
        fn(x);
        if (!o.progress) x.updated = iso(now());
        return x;
      });
      changed(p.slug, o.progress ? { progress: true } : undefined);
      return p;
    } catch (e) {
      if (e instanceof PostError && e.status === 404) return null;
      throw e;
    }
  };

  const history = (p: StoredPost, state: StoredPost['state'], note?: string) => {
    p.history = [...(p.history ?? []), { at: iso(now()), state, by: 'system', ...(note ? { note } : {}) }].slice(-50);
  };

  /** A failure as the post keeps it: a sentence a person reads, never a path, a command line or a token. */
  const reasonOf = (e: unknown): { message: string; transient: boolean; auth: boolean; later?: number } => {
    if (e instanceof PublishError) return { message: e.message, transient: e.transient, auth: e.auth, later: e.retryAfterMs };
    const err = e as Error & { stderr?: string };
    log(`publish: ${err?.message ?? e}`);
    if (err && typeof err.stderr === 'string')
      return { message: "Lampo couldn't make the platform's encode of the final (ffmpeg failed).", transient: false, auth: false };
    const msg = String(err?.message || 'something went wrong').split('\n')[0] as string;
    // our own sentences ("V3's file is gone") are fine to show; anything naming a path is not
    return {
      message: /[/\\]/.test(msg) ? 'Lampo couldn’t prepare the file to send.' : `${msg.charAt(0).toUpperCase()}${msg.slice(1)}${/[.!?]$/.test(msg) ? '' : '.'}`,
      transient: false,
      auth: false,
    };
  };

  function settle(p: StoredPost, out: Outcome) {
    p.remote_id = out.remote_id;
    // only an https link is the post's (a platform's answer is shown to people as a link: A12 PUB-12)
    if (out.url && httpsLink(out.url)) p.url = out.url;
    if (out.locked) p.locked = true;
    if (out.state === 'processing') {
      p.state = 'uploading';
      p.next_try = iso(now() + PROCESSING_EVERY);
      return;
    }
    p.state = out.state;
    delete p.next_try;
    delete p.error;
    delete p.progress;
  }

  /** The file and cover a send needs: ready, being made (its turn comes when it is), or why it couldn't be made. */
  function prepare(p: StoredPost, review: Review): { key: string; prep: Prepared } {
    const key = wsKey(`${p.id}:${p.round ?? 1}`);
    const have = prepared.get(key);
    if (have) return { key, prep: have };
    prepared.set(key, { state: 'making' });
    const post = wsKey(p.id);
    making.add(post);
    const job: Promise<void> = boundToWorkspace(async () => {
      try {
        const { file, info } = await platformFile(p, review);
        const cover = await cachedCover(p, review);
        prepared.set(key, { state: 'ready', file, info, cover });
      } catch (error) {
        prepared.set(key, { state: 'failed', error });
      }
    })().finally(() => {
      preparing.delete(job);
      making.delete(post);
      publisher.poke();
    });
    preparing.add(job);
    return { key, prep: { state: 'making' } };
  }

  /** Sends one post (the gate asked again first). */
  async function send(id: string): Promise<void> {
    const p0 = listPosts().find((x) => x.id === id);
    if (!p0 || (p0.state !== 'queued' && p0.state !== 'uploading')) return;
    if (p0.committed_at && !p0.session && !p0.remote_id) {
      // a send cut off after it asked for the post, and nothing to ask where it stands: a person looks (PUB-1)
      sentUnknown(id, 'Lampo stopped while the platform was answering: it may have gone out.');
      return;
    }
    const review = loadReview(p0.slug);
    const why = gateOf(review, p0);
    if (why) {
      const p = cancelQueuedQuiet(id, `Paused: ${why}.`);
      if (p) changed(p.slug);
      return;
    }
    const conn = findConnection(p0.connection);
    const secret = conn ? secretOf(conn) : null;
    if (!conn || !secret || conn.state !== 'ready') {
      const msg = !conn
        ? 'The connection it was going through is gone: choose another one and publish again.'
        : !secret
          ? 'The connection’s key can’t be read any more (the store’s secret changed?): add the connection again.'
          : 'The connection isn’t ready: check it in Settings → Publishing, then try again.';
      fail(id, review as Review, msg);
      return;
    }
    const { key, prep } = prepare(p0, review as Review);
    if (prep.state === 'making') return;
    prepared.delete(key);
    if (prep.state === 'failed') {
      if (prep.error instanceof QueueFullError) {
        // the workspace's job queue is full: not a failure of the post, its turn comes again a little later
        update(id, (p) => {
          p.next_try = iso(now() + BUSY_WAIT);
        });
        return;
      }
      fail(id, review, reasonOf(prep.error).message);
      return;
    }
    const adapter = adapterOf(conn.kind);
    const account = conn.accounts.find((a) => a.id === p0.account && a.platform === p0.platform) ?? null;
    const started = update(id, (p) => {
      p.state = 'uploading';
      p.attempts = (p.attempts ?? 0) + 1;
      delete p.next_try;
      history(p, 'uploading', p.attempts > 1 ? `sending (try ${p.attempts})` : 'sending');
    });
    if (!started) return;
    const r = review as Review;
    const ver = r.versions.find((x) => x.v === started.v);
    let lastSaved = 0;
    try {
      const { file, info, cover } = prep;
      const out = await adapter.publish(
        {
          post: started,
          file,
          bytes: info.bytes,
          duration: ver?.duration ?? 0,
          cover,
          coverMs: started.cover_frame !== null && ver ? ((started.cover_frame + 0.5) / ver.fps) * 1000 : null,
          account,
          key: `lampo-${started.id}-${started.round ?? 1}`,
          session: unseal<UploadSession>(id, started.session),
          committed: !!started.committed_at,
          keepSession: (s) => {
            update(id, (p) => {
              if (s) p.session = seal(id, s);
              else delete p.session;
            });
          },
          committing: () => {
            update(id, (p) => {
              p.committed_at = iso(now());
            });
          },
          progress: (sent, total) => {
            // how far an upload got is worth a write every ten seconds, not every chunk (A12 PUB-11)
            if (now() - lastSaved < PROGRESS_EVERY && sent < total) return;
            lastSaved = now();
            update(
              id,
              (p) => {
                p.progress = { sent, total };
              },
              { progress: true },
            );
          },
        },
        secret,
        (s) => changeConnection(conn.id, { secret: s }),
      );
      const p = update(id, (x) => {
        x.file = info;
        // the id is kept: what was sent needs no resuming, whatever the adapter kept
        delete x.session;
        delete x.committed_at;
        settle(x, out);
        history(
          x,
          x.state,
          [
            x.state === 'scheduled'
              ? `uploaded: ${conn.kind === 'youtube' ? 'YouTube' : 'the platform'} holds it until ${x.schedule_at}`
              : x.state === 'uploading'
                ? 'sent: the platform is working on it'
                : 'posted',
            x.locked ? 'YouTube kept it private (the Google project hasn’t passed the API audit): make it public in YouTube Studio' : '',
            out.note ?? '',
          ]
            .filter(Boolean)
            .join(' · '),
        );
      });
      if (p && p.state !== 'uploading') logPostEvent(loadReview(p.slug), p, 'system');
    } catch (e) {
      const why = reasonOf(e);
      if (why.auth) {
        try {
          changeConnection(conn.id, { state: 'error', error: why.message });
        } catch {}
      }
      const p = listPosts().find((x) => x.id === id);
      const answer = e instanceof PublishError ? e : null;
      // the platform's "it failed" about a post it holds: the outcome; its id stays known (PUB-1)
      if (answer?.remoteId) {
        update(id, (x) => {
          x.remote_id = answer.remoteId;
        });
        fail(id, r, why.message);
        return;
      }
      // Past the request that makes the post without a clear "no", it may be out (PUB-1): a try again only resumes an
      // upload session, which finds out where it stands; without one, and once tries are over, fail() says `sent`.
      const unknown = !!p?.committed_at && !answer?.notSent;
      const tries = p?.attempts ?? 1;
      if (why.transient && tries < maxAttempts && !(unknown && !p?.session)) {
        const wait = why.later ?? backoff[Math.min(tries - 1, backoff.length - 1)] ?? 3600e3;
        update(id, (x) => {
          x.state = 'queued';
          x.next_try = iso(now() + wait);
          x.error = why.message;
          // the platform said no to the post itself: nothing was made, the next try starts clean
          if (answer?.notSent) delete x.committed_at;
          history(x, 'queued', `${why.message} Next try at ${x.next_try}.`);
        });
      } else fail(id, r, why.message, { notSent: answer?.notSent });
    }
  }

  /**
   * A post that won't go: `failed`, which Retry sends again — unless a try got as far as the post and no answer said
   * no (`maybeOut`): then it may be out, and it is `sent` for a person to look; never failed into a second post (PUB-1).
   */
  function fail(id: string, review: Review | null, message: string, o: { notSent?: boolean } = {}) {
    const p = update(id, (x) => {
      delete x.next_try;
      delete x.progress;
      if (!o.notSent && maybeOut(x)) {
        x.state = 'sent';
        x.error = `${message} It may have gone out: look on the platform.`;
        history(x, 'sent', x.error);
        return;
      }
      x.state = 'failed';
      x.error = message;
      delete x.committed_at;
      history(x, 'failed', message);
    });
    if (p) logPostEvent(review ?? loadReview(p.slug), p, 'system');
  }

  /** Sent, but the platform never said whether it is out: a person looks; nothing sends it again by itself (PUB-1). */
  function sentUnknown(id: string, message: string) {
    const p = update(id, (x) => {
      x.state = 'sent';
      x.error = message;
      delete x.next_try;
      delete x.progress;
      history(x, 'sent', message);
    });
    if (p) logPostEvent(loadReview(p.slug), p, 'system');
  }

  /** A look that failed at a post the platform holds: where it stands is kept, the connection says why (PUB-1). */
  function lookFailed(id: string, conn: StoredConnection, why: ReturnType<typeof reasonOf>) {
    if (why.auth) {
      try {
        changeConnection(conn.id, { state: 'error', error: why.message });
      } catch {}
    }
    const said = `${conn.kind === 'youtube' ? 'YouTube' : 'The platform'} couldn’t be asked where it stands: ${why.message}`;
    update(id, (x) => {
      x.checks = (x.checks ?? 0) + 1;
      x.checked_at = iso(now());
      if (x.state === 'uploading') x.next_try = iso(now() + PROCESSING_EVERY);
      // said once, not on every look
      if (x.history.at(-1)?.note !== said) history(x, x.state, said);
    });
  }

  function cancelQueuedQuiet(id: string, why: string): StoredPost | null {
    try {
      return cancelQueued(id, 'system', why);
    } catch {
      return null;
    }
  }

  /** Asks the platform where a sent post stands, and keeps the answer. */
  async function look(id: string): Promise<void> {
    const p0 = listPosts().find((x) => x.id === id);
    if (!p0?.remote_id) return;
    const sent = [...(p0.history ?? [])].reverse().find((h) => h.state === 'uploading')?.at ?? p0.updated;
    if (p0.state === 'uploading' && now() - instant(sent) > PROCESSING_FOR) {
      // given up on, not failed: it is at the platform, which never said how it went (PUB-1)
      sentUnknown(id, 'The platform still hasn’t said whether it went out: look on the platform.');
      return;
    }
    const conn = findConnection(p0.connection);
    const secret = conn ? secretOf(conn) : null;
    if (!conn || !secret) return;
    try {
      const out = await adapterOf(conn.kind).status(p0, secret, (s) => changeConnection(conn.id, { secret: s }));
      const before = p0.state;
      const wasLocked = !!p0.locked;
      const p = update(id, (x) => {
        x.checks = (x.checks ?? 0) + 1;
        x.checked_at = iso(now());
        settle(x, out);
        if (x.state !== before || (!!x.locked && !wasLocked))
          history(
            x,
            x.state,
            x.locked && !wasLocked ? 'YouTube kept it private (the Google project hasn’t passed the API audit): make it public in YouTube Studio' : undefined,
          );
      });
      if (p && (p.state !== before || (!!p.locked && !wasLocked)) && p.state !== 'uploading') logPostEvent(loadReview(p.slug), p, 'system');
    } catch (e) {
      const why = reasonOf(e);
      if (why.transient) {
        update(id, (x) => {
          x.checks = (x.checks ?? 0) + 1;
          x.checked_at = iso(now());
          if (x.state === 'uploading') x.next_try = iso(now() + PROCESSING_EVERY);
        });
        return;
      }
      // the platform's own "it failed" for a post it was still working on is the post's outcome; the id stays known, so
      // Retry asks again instead of sending (PUB-1). Anything else — a revoked key, a post that is out — keeps its state.
      if (p0.state === 'uploading' && !why.auth) fail(id, loadReview(p0.slug), why.message);
      else lookFailed(id, conn, why);
    }
  }

  /** What is due in the workspace running now: sends first, then looks. */
  function due(): { send: string[]; look: string[] } {
    const t = now();
    const out = { send: [] as string[], look: [] as string[] };
    const ready = new Map<string, boolean>();
    const works = (id: string | null): boolean => {
      if (!id) return false;
      if (!ready.has(id)) ready.set(id, findConnection(id)?.state === 'ready');
      return ready.get(id) as boolean;
    };
    for (const p of listPosts()) {
      const sinceCheck = p.checked_at ? t - instant(p.checked_at) : Number.POSITIVE_INFINITY;
      // a look through a connection that doesn't work waits for a person to fix it (giving up still comes on time)
      if (p.remote_id && p.state !== 'queued' && !works(p.connection)) {
        const sentAt = [...(p.history ?? [])].reverse().find((h) => h.state === 'uploading')?.at ?? p.updated;
        if (p.state === 'uploading' && t - instant(sentAt) > PROCESSING_FOR) out.look.push(p.id);
        continue;
      }
      if (p.state === 'queued') {
        // a post whose final moved is paused at once, not at its time
        if (gateOf(loadReview(p.slug), p)) out.send.push(p.id);
        else if (!p.next_try || instant(p.next_try) <= t) out.send.push(p.id);
      } else if (p.state === 'uploading') {
        if (!p.remote_id)
          out.send.push(p.id); // a send cut off (a restart): it resumes
        else if (!p.next_try || instant(p.next_try) <= t) out.look.push(p.id);
      } else if (p.state === 'scheduled') {
        if (p.schedule_at && instant(p.schedule_at) + 60e3 <= t && sinceCheck >= 5 * 60e3) out.look.push(p.id);
      } else if (p.state === 'posted' && p.platform === 'youtube' && p.remote_id && !p.locked) {
        const n = p.checks ?? 0;
        const wait = LOCK_CHECKS[n];
        if (wait !== undefined && t - instant(p.published_at ?? p.updated) >= wait && sinceCheck >= wait) out.look.push(p.id);
      }
    }
    return out;
  }

  // sends and looks one at a time (an upload holds the line; that is the point)
  const serial = (fn: () => Promise<void>): Promise<void> => {
    const next = running.then(fn, fn);
    running = next.catch((e) => log(`publish: ${(e as Error)?.message ?? e}`));
    return running;
  };

  /**
   * What is due in every workspace, per workspace with who runs it: not the posts this pass worked on already, nor a send
   * whose file is still being made (it comes back once it is ready).
   */
  function collect(handled: Set<string>): { ws: string; who: string; items: { look: boolean; id: string }[] }[] {
    const queues: { ws: string; who: string; items: { look: boolean; id: string }[] }[] = [];
    for (const ws of spaces()) {
      if (stopped) break;
      inWorkspace(ws, () => {
        let work: { send: string[]; look: string[] };
        try {
          work = due();
        } catch (e) {
          log(`publish (${ws}): ${(e as Error).message}`);
          return;
        }
        const items = [...work.send.map((id) => ({ look: false, id })), ...work.look.map((id) => ({ look: true, id }))].filter(
          (x) => !handled.has(itemKey(ws, x.id)) && (x.look || !making.has(wsKey(x.id))),
        );
        if (items.length) queues.push({ ws, who: workspaceOwner(ws) ?? `ws:${ws}`, items });
      });
    }
    return queues;
  }
  const itemKey = (ws: string, id: string) => `${ws}\n${id}`;

  /**
   * One pass: one send or look at a time, taking turns like the job queue's (lib/jobs.ts): the owner served longest ago
   * goes, within an owner their workspace served longest ago — so one team's backlog holds another's post back by one
   * send at most (A12 PUB-4). What is due is asked again before every turn: a post published while another team's
   * upload ran goes next, not after everything the pass found when it began. A post is worked on once a pass, except a
   * send whose turn only started making its file: it takes its turn again once the file is ready.
   */
  async function pass(): Promise<void> {
    const handled = new Set<string>();
    const servedWho = new Map<string, number>();
    const servedWs = new Map<string, number>();
    let turn = 0;
    for (;;) {
      if (stopped) return;
      const open = collect(handled);
      if (!open.length || stopped) return;
      const last = (m: Map<string, number>, k: string) => m.get(k) ?? -1;
      const q = open.reduce((a, b) => {
        const who = last(servedWho, a.who) - last(servedWho, b.who);
        if (who !== 0) return who < 0 ? a : b;
        return last(servedWs, b.ws) < last(servedWs, a.ws) ? b : a;
      });
      const item = q.items[0] as { look: boolean; id: string };
      handled.add(itemKey(q.ws, item.id));
      servedWho.set(q.who, ++turn);
      servedWs.set(q.ws, turn);
      await inWorkspace(q.ws, () => serial(() => (item.look ? look(item.id) : send(item.id))));
      if (!item.look && inWorkspace(q.ws, () => making.has(wsKey(item.id)))) handled.delete(itemKey(q.ws, item.id));
    }
  }

  const publisher: Publisher = {
    adapters: o.adapters,
    start() {
      stopped = false;
      if (timer) return;
      timer = setInterval(() => void publisher.tick(), o.intervalMs ?? 15_000);
      timer.unref();
      publisher.poke();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      if (soon) clearTimeout(soon);
      timer = soon = null;
      await running;
    },
    tick() {
      if (!ticking)
        ticking = pass()
          .catch((e) => log(`publish: ${(e as Error)?.message ?? e}`))
          .finally(() => {
            ticking = null;
          });
      return ticking;
    },
    poke() {
      if (soon || stopped) return;
      soon = setTimeout(() => {
        soon = null;
        void publisher.tick();
      }, 50);
      soon.unref();
    },
    async idle() {
      // a send whose file is being made goes on the tick its making asks for (poke): run that one too
      for (;;) {
        while (ticking) await ticking;
        await running;
        if (preparing.size) await Promise.allSettled([...preparing]);
        if (soon) {
          clearTimeout(soon);
          soon = null;
          await publisher.tick();
          continue;
        }
        if (!ticking && !preparing.size) return;
      }
    },
    async cancel(id, by) {
      const p = listPosts().find((x) => x.id === id);
      if (!p) throw new PostError(404, 'no such post');
      if (p.state === 'queued' || p.state === 'failed') {
        const out = cancelQueued(id, by);
        changed(out.slug);
        return out;
      }
      if (p.state === 'uploading') throw new PostError(409, 'it is being sent right now: wait a moment');
      if (p.state !== 'scheduled') throw new PostError(409, `the post is ${p.state}`);
      const conn = findConnection(p.connection);
      const secret = conn ? secretOf(conn) : null;
      const adapter = conn ? adapterOf(conn.kind) : null;
      if (!conn || !secret || !adapter?.cancel)
        throw new PostError(
          409,
          p.platform === 'youtube' ? 'YouTube holds this upload now: change or delete it in YouTube Studio' : 'the platform holds it now: change it there',
          p.platform === 'youtube' && p.remote_id ? `https://studio.youtube.com/video/${p.remote_id}/edit` : undefined,
        );
      try {
        await adapter.cancel(p, secret, (s) => changeConnection(conn.id, { secret: s }));
      } catch (e) {
        throw new PostError(502, reasonOf(e).message);
      }
      const out = changePost(id, (x) => {
        x.state = 'cancelled';
        x.error = `Cancelled by ${by}.`;
        x.updated = iso(now());
        history(x, 'cancelled', `cancelled by ${by}`);
        return x;
      });
      logPostEvent(loadReview(out.slug), out, by);
      changed(out.slug);
      return out;
    },
    async check(id) {
      const conn = findConnection(id);
      if (!conn) throw new PostError(404, 'no such connection');
      const secret = secretOf(conn);
      if (!secret) return changeConnection(id, { state: 'error', error: 'The key can’t be read any more (the store’s secret changed?): add it again.' });
      if (conn.kind === 'youtube' && !('refresh_token' in secret && secret.refresh_token))
        return changeConnection(id, { state: 'needs_auth', error: null, checked: iso(now()) });
      try {
        // what a platform names is kept bounded, whatever the adapter made of it (A12 PUB-16)
        const accounts: PublishAccount[] = keptAccounts(await adapterOf(conn.kind).accounts(secret, (s) => changeConnection(id, { secret: s })));
        if (!accounts.length)
          return changeConnection(id, {
            state: 'error',
            error:
              conn.kind === 'zernio'
                ? 'No Instagram or Facebook account is connected at Zernio yet: connect one there, then check again.'
                : 'No channel found.',
            accounts: [],
            checked: iso(now()),
          });
        return changeConnection(id, { state: 'ready', error: null, accounts, checked: iso(now()) });
      } catch (e) {
        const why = reasonOf(e);
        return changeConnection(id, { state: 'error', error: why.message, checked: iso(now()) });
      }
    },
  };
  return publisher;
}
