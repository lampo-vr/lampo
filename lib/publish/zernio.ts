// Instagram and Facebook through a unified posting API with the person's own key: Zernio (formerly Late). No platform
// review is needed — the provider's apps passed them — and the file goes from this machine to the provider's storage
// (a presigned PUT, up to 5 GB), then one call posts it. Lampo sends at the post's time (publishNow), so a schedule
// follows the final: a reopened final or a newer render stops it here, before anything leaves. The cost: on a machine
// that sleeps, the post waits until it wakes (the UI says so).
// The request shapes follow Zernio's documentation as read on 2 Oct 2026 (docs/publishing.md); field names marked
// there as unconfirmed are checked in the one-day test against a real account before this is relied on.
import path from 'node:path';
import type { Post, PublishAccount, PublishPlatform } from '../types.ts';
import { type Adapter, type KeepSecret, type Outcome, PublishError, retryAfterOf } from './adapter.ts';
import type { ConnectionSecret, ZernioSecret } from './connections.ts';
import { type Endpoints, guardedRequest, NetError, type NetOptions, type Reply } from './net.ts';
import { hashtagsIn, PLATFORM_LIMITS } from './platforms.ts';

export interface ZernioOptions {
  endpoints: Endpoints;
  net: NetOptions;
}

interface ZernioPlatformEntry {
  platform?: string;
  accountId?: string;
  status?: string;
  platformPostId?: string;
  platformPostUrl?: string;
  errorMessage?: string;
  error?: string;
}
interface ZernioPost {
  _id?: string;
  id?: string;
  status?: string;
  platforms?: ZernioPlatformEntry[];
}

const OURS: Record<string, PublishPlatform> = { instagram: 'instagram', facebook: 'facebook' };

/** Zernio's answer as the reason a person reads. */
export function zernioError(r: Pick<Reply, 'status' | 'headers' | 'body'>, what: string): PublishError {
  let said = '';
  try {
    const b = JSON.parse(r.body.toString('utf8')) as { error?: string; message?: string };
    said = b.error || b.message || '';
  } catch {}
  const later = retryAfterOf(r.headers['retry-after']);
  if (r.status === 401 || r.status === 403) return new PublishError('Zernio refused the API key: add a working key in Settings → Publishing', { auth: true });
  if (r.status === 429) return new PublishError('Zernio asked to slow down: Lampo tries again in a moment', { transient: true, retryAfterMs: later });
  if (r.status >= 500)
    return new PublishError(`Zernio had a problem with the ${what} (${r.status}): Lampo tries again`, { transient: true, retryAfterMs: later });
  return new PublishError(said ? `Zernio refused the ${what}: ${said}` : `Zernio refused the ${what} (${r.status})`);
}

const offline = (e: unknown, what: string): PublishError => {
  if (e instanceof PublishError) return e;
  const n = e instanceof NetError ? e : new NetError(String((e as Error)?.message || e));
  return new PublishError(`${n.message} while sending the ${what}`, { transient: n.transient });
};

/** The caption a platform gets: the description, and the tags as hashtags it doesn't carry yet. */
export function captionOf(post: Pick<Post, 'description' | 'tags'>): string {
  const have = new Set(hashtagsIn(post.description).map((t) => t.toLowerCase()));
  const extra = post.tags.map((t) => `#${t.replace(/^#/, '').replace(/\s+/g, '')}`).filter((t) => t.length > 1 && !have.has(t.toLowerCase()));
  return [post.description.trim(), extra.join(' ')].filter(Boolean).join('\n\n');
}

/** What one platform gets besides the caption (Zernio's platformSpecificData). */
export function platformData(post: Post, coverMs: number | null, duration: number): Record<string, unknown> {
  if (post.platform === 'instagram') {
    const reel = (post.instagram?.kind ?? 'reel') === 'reel';
    return {
      ...(reel ? { contentType: 'reels', shareToFeed: post.instagram?.share_to_feed ?? true } : {}),
      ...(coverMs !== null ? { thumbOffset: Math.round(coverMs) } : {}),
    };
  }
  if (post.platform === 'facebook')
    return {
      ...(duration <= (PLATFORM_LIMITS.facebook.softMaxDuration ?? 90) ? { contentType: 'reel' } : {}),
      ...(post.title.trim() ? { title: post.title.trim() } : {}),
    };
  return {};
}

/** Where a Zernio post stands, for one platform. */
function outcomeOf(p: ZernioPost, platform: PublishPlatform): Outcome {
  const id = String(p._id ?? p.id ?? '');
  if (!id) throw new PublishError('Zernio answered without the post', { transient: true });
  const entry = p.platforms?.find((x) => x.platform === platform) ?? p.platforms?.[0];
  const state = entry?.status ?? p.status ?? '';
  // the platform's own answer about the post it holds: the outcome, with its id (Retry asks again, never sends: PUB-1)
  const answered = (msg: string) => Object.assign(new PublishError(msg), { remoteId: id });
  if (state === 'failed' || state === 'error') throw answered(entry?.errorMessage || entry?.error || `${platform} refused the post`);
  if (state === 'cancelled') throw answered('The post was cancelled at Zernio');
  if (state === 'published' || state === 'posted') return { state: 'posted', remote_id: id, url: entry?.platformPostUrl ?? null };
  return { state: 'processing', remote_id: id, url: entry?.platformPostUrl ?? null };
}

export function createZernio(o: ZernioOptions): Adapter {
  const base = `${o.endpoints.zernio}/v1`;
  const keyOf = (s: ConnectionSecret) => (s as ZernioSecret).api_key;
  const call = async (secret: ConnectionSecret, what: string, url: string, r: Parameters<typeof guardedRequest>[1] = {}): Promise<Reply> => {
    try {
      return await guardedRequest(
        url,
        {
          ...r,
          headers: {
            Accept: 'application/json',
            ...(r.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...r.headers,
            Authorization: `Bearer ${keyOf(secret)}`,
          },
        },
        o.net,
      );
    } catch (e) {
      throw offline(e, what);
    }
  };

  return {
    kind: 'zernio',

    async accounts(secret, _keep: KeepSecret): Promise<PublishAccount[]> {
      const r = await call(secret, 'account list', `${base}/accounts`);
      if (r.status !== 200) throw zernioError(r, 'account list');
      const body = r.json<unknown>();
      const list = (Array.isArray(body) ? body : ((body as { accounts?: unknown[] })?.accounts ?? [])) as Record<string, unknown>[];
      const out: PublishAccount[] = [];
      for (const a of list) {
        const platform = OURS[String(a.platform ?? '')];
        const id = String(a._id ?? a.accountId ?? a.id ?? '');
        if (!platform || !id) continue;
        const handle = typeof a.username === 'string' && a.username ? a.username : '';
        const name = String(a.displayName ?? a.name ?? handle ?? id).slice(0, 120) || id;
        out.push({ id, platform, name, ...(handle && handle !== name ? { detail: `@${handle.replace(/^@/, '')}` } : {}) });
      }
      return out;
    },

    async publish(t, secret) {
      const post = t.post;
      if (!t.account) throw new PublishError('Choose the account to post to');
      // 1. a place for the file at the provider, 2. the file, straight from this machine, 3. the post.
      const pre = await call(secret, 'upload', `${base}/media/presign`, {
        method: 'POST',
        body: JSON.stringify({ filename: path.basename(t.file).replace(/[^\w.-]+/g, '_') || 'video.mp4', contentType: 'video/mp4', size: t.bytes }),
      });
      if (pre.status !== 200 && pre.status !== 201) throw zernioError(pre, 'upload');
      const slot = pre.json<{ uploadUrl?: string; publicUrl?: string }>();
      if (!slot.uploadUrl || !slot.publicUrl) throw new PublishError('Zernio answered without an upload address', { transient: true });
      let put: Reply;
      try {
        put = await guardedRequest(
          slot.uploadUrl,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'video/mp4' },
            body: { file: t.file, start: 0, end: t.bytes - 1 },
            progress: (n) => t.progress(n, t.bytes),
            timeoutMs: 600_000,
          },
          o.net,
        );
      } catch (e) {
        throw offline(e, 'video');
      }
      if (put.status < 200 || put.status >= 300) throw zernioError(put, 'video');
      t.progress(t.bytes, t.bytes);
      const body = {
        content: captionOf(post),
        ...(post.title.trim() ? { title: post.title.trim() } : {}),
        mediaItems: [{ type: 'video', url: slot.publicUrl }],
        platforms: [{ platform: post.platform, accountId: t.account.id, platformSpecificData: platformData(post, t.coverMs, t.duration) }],
        publishNow: true,
        ...(post.tags.length ? { tags: post.tags } : {}),
      };
      // From here the post may exist at Zernio whatever happens to the answer: a failure without a clear "no" is never
      // sent again by itself (A12 PUB-1). The key asks Zernio not to make it twice; nothing here depends on it.
      t.committing();
      const r = await call(secret, 'post', `${base}/posts`, {
        method: 'POST',
        headers: { 'Idempotency-Key': t.key },
        body: JSON.stringify(body),
      });
      if (![200, 201, 207].includes(r.status)) {
        const e = zernioError(r, 'post');
        // a clear "no" (a refused key, a slow-down, a request it won't take) made nothing; a 5xx, a timeout or a conflict may have
        if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 409) e.notSent = true;
        throw e;
      }
      const answer = r.json<{ post?: ZernioPost } & ZernioPost>();
      return outcomeOf(answer.post ?? answer, post.platform);
    },

    async status(post, secret) {
      const r = await call(secret, 'post', `${base}/posts/${encodeURIComponent(post.remote_id as string)}`);
      if (r.status === 404) throw new PublishError('The post is gone from Zernio');
      if (r.status !== 200) throw zernioError(r, 'post');
      const answer = r.json<{ post?: ZernioPost } & ZernioPost>();
      return outcomeOf(answer.post ?? answer, post.platform);
    },

    async cancel(post, secret) {
      if (!post.remote_id) return;
      const r = await call(secret, 'post', `${base}/posts/${encodeURIComponent(post.remote_id)}`, { method: 'DELETE' });
      if (r.status !== 200 && r.status !== 204 && r.status !== 404) throw zernioError(r, 'post');
    },
  };
}
