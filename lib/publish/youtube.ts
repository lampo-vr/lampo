// YouTube directly, through the person's own Google Cloud OAuth client (bring your own client id and secret): the
// Google sign-in (authorization code + PKCE, a refresh token kept sealed), the Data API's resumable upload — chunks
// that resume after a dropped connection, a session kept between tries —, `publishAt` scheduling (YouTube holds it),
// the cover through thumbnails.set, and where an upload stands afterwards.
// An API project that hasn't passed YouTube's API audit (every project made after 28 July 2020, a person's own
// included) gets its uploads locked private: a schedule never goes public. The upload still works; the post says it is
// private and links to YouTube Studio (`locked`). Scopes: youtube.upload (upload, cover) and youtube.readonly (the
// channel's name, an upload's state). Quota: videos.insert has its own 100 calls a day per project (since 1 Jun 2026).
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { PublishAccount } from '../types.ts';
import { type Adapter, type KeepSecret, type Outcome, PublishError, retryAfterOf } from './adapter.ts';
import type { ConnectionSecret, YouTubeSecret } from './connections.ts';
import { type Endpoints, form, guardedRequest, NetError, type NetOptions, type Reply } from './net.ts';
import { DEFAULT_YOUTUBE_CATEGORY, youtubeWatchUrl } from './platforms.ts';

export const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];

/** Chunks are multiples of 256 KiB (the protocol's rule); 8 MiB by default. */
export const CHUNK_UNIT = 256 * 1024;

export interface YouTubeOptions {
  endpoints: Endpoints;
  net: NetOptions;
  /** Bytes per chunk (a multiple of 256 KiB; tests use one unit). */
  chunkBytes?: number;
  /** Resumes within one try after a dropped connection, and the waits between them. */
  resumeWaits?: number[];
  now?: () => number;
}

/** A PKCE pair for one sign-in. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

interface GoogleError {
  error?: { code?: number; message?: string; errors?: { reason?: string; message?: string }[] } | string;
  error_description?: string;
}

/** Google's answer as the reason a person reads, and whether to try again. */
export function youtubeError(r: Pick<Reply, 'status' | 'headers' | 'body'>, what: string): PublishError {
  let g: GoogleError = {};
  try {
    g = JSON.parse(r.body.toString('utf8')) as GoogleError;
  } catch {}
  const err = typeof g.error === 'object' ? g.error : undefined;
  const reason = err?.errors?.[0]?.reason ?? (typeof g.error === 'string' ? g.error : '');
  const said = err?.message ?? g.error_description ?? '';
  const later = retryAfterOf(r.headers['retry-after']);
  switch (reason) {
    case 'quotaExceeded':
    case 'dailyLimitExceeded':
      return new PublishError("YouTube's daily quota for your Google project is used up: Lampo tries again in a few hours", {
        transient: true,
        retryAfterMs: later ?? 6 * 3600e3,
      });
    case 'uploadLimitExceeded':
      return new PublishError('This YouTube channel reached its upload limit for today: Lampo tries again later', {
        transient: true,
        retryAfterMs: later ?? 6 * 3600e3,
      });
    case 'rateLimitExceeded':
    case 'userRateLimitExceeded':
      return new PublishError('YouTube asked to slow down: Lampo tries again in a moment', { transient: true, retryAfterMs: later });
    case 'youtubeSignupRequired':
      return new PublishError('The Google account has no YouTube channel yet: create one on YouTube, then connect again', { auth: true });
    case 'invalid_grant':
    case 'unauthorized_client':
    case 'invalid_client':
      return new PublishError('Google no longer accepts this connection’s sign-in: connect it again in Settings → Publishing', { auth: true });
    case 'insufficientPermissions':
    case 'forbidden':
      return new PublishError('Google didn’t allow uploads for this connection: connect it again and allow them', { auth: true });
  }
  if (r.status === 401)
    return new PublishError('Google no longer accepts this connection’s sign-in: connect it again in Settings → Publishing', { auth: true });
  if (r.status === 429) return new PublishError('YouTube asked to slow down: Lampo tries again in a moment', { transient: true, retryAfterMs: later });
  if (r.status >= 500)
    return new PublishError(`YouTube had a problem with the ${what} (${r.status}): Lampo tries again`, { transient: true, retryAfterMs: later });
  return new PublishError(said ? `YouTube refused the ${what}: ${said}` : `YouTube refused the ${what} (${r.status})`);
}

/** The NetError of a request as the reason a person reads. */
const offline = (e: unknown, what: string): PublishError => {
  if (e instanceof PublishError) return e;
  const n = e instanceof NetError ? e : new NetError(String((e as Error)?.message || e));
  return new PublishError(`${n.message} while sending the ${what}`, { transient: n.transient });
};

export interface YouTube extends Adapter {
  /** Where the person signs in with Google (the browser goes there; the server never fetches it). */
  authUrl(o: { clientId: string; redirectUri: string; state: string; challenge: string }): string;
  /** The code Google sent back, exchanged for tokens: the secret to keep. */
  exchange(o: { secret: YouTubeSecret; code: string; redirectUri: string; verifier: string }): Promise<YouTubeSecret>;
  /** Tells Google the connection is gone (best effort: its tokens stop working). */
  revoke(secret: YouTubeSecret): Promise<void>;
}

export function createYouTube(o: YouTubeOptions): YouTube {
  const ep = o.endpoints;
  const now = o.now ?? Date.now;
  const chunk = Math.max(CHUNK_UNIT, Math.floor((o.chunkBytes ?? 32 * CHUNK_UNIT) / CHUNK_UNIT) * CHUNK_UNIT);
  const waits = o.resumeWaits ?? [1000, 3000, 8000, 15000];
  const req = (url: string, r: Parameters<typeof guardedRequest>[1] = {}) => guardedRequest(url, r, o.net);
  const uploadHost = new URL(ep.youtubeUpload).host;

  /** A working access token: the kept one while it lasts, else a fresh one from the refresh token. */
  async function token(secret: ConnectionSecret, keep: KeepSecret): Promise<string> {
    const s = secret as YouTubeSecret;
    if (s.access_token && (s.access_expires ?? 0) > now() + 60_000) return s.access_token;
    if (!s.refresh_token) throw new PublishError('This YouTube connection isn’t signed in: connect it in Settings → Publishing', { auth: true });
    let r: Reply;
    try {
      r = await req(ep.googleToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form({ client_id: s.client_id, client_secret: s.client_secret, refresh_token: s.refresh_token, grant_type: 'refresh_token' }),
      });
    } catch (e) {
      throw offline(e, 'sign-in');
    }
    if (r.status !== 200) throw youtubeError(r, 'sign-in');
    const t = r.json<{ access_token?: string; expires_in?: number }>();
    if (!t.access_token) throw new PublishError('Google answered the sign-in without a token', { transient: true });
    s.access_token = t.access_token;
    s.access_expires = now() + (t.expires_in ?? 3600) * 1000;
    keep(s);
    return s.access_token;
  }

  /** A Data API call with the token, refreshed once when Google says it ran out. */
  async function api(secret: ConnectionSecret, keep: KeepSecret, what: string, url: string, r: Parameters<typeof guardedRequest>[1] = {}): Promise<Reply> {
    for (let i = 0; ; i++) {
      const bearer = await token(secret, keep);
      let res: Reply;
      try {
        res = await req(url, { ...r, headers: { ...r.headers, Authorization: `Bearer ${bearer}` } });
      } catch (e) {
        throw offline(e, what);
      }
      if (res.status === 401 && i === 0) {
        (secret as YouTubeSecret).access_expires = 0;
        continue;
      }
      return res;
    }
  }

  const accounts = async (secret: ConnectionSecret, keep: KeepSecret): Promise<PublishAccount[]> => {
    const r = await api(secret, keep, 'channel', `${ep.youtube}/channels?part=snippet&mine=true`);
    if (r.status !== 200) throw youtubeError(r, 'channel');
    const items = r.json<{ items?: { id: string; snippet?: { title?: string; customUrl?: string } }[] }>().items ?? [];
    if (!items.length) throw new PublishError('The Google account has no YouTube channel yet: create one on YouTube, then connect again', { auth: true });
    return items.map((c) => ({
      id: c.id,
      platform: 'youtube' as const,
      name: c.snippet?.title || c.id,
      ...(c.snippet?.customUrl ? { detail: c.snippet.customUrl } : {}),
    }));
  };

  /** Where the upload stands: the bytes YouTube has, or the finished video. */
  async function ask(secret: ConnectionSecret, keep: KeepSecret, session: string, total: number): Promise<{ next: number } | { done: Reply } | { gone: true }> {
    const r = await api(secret, keep, 'video', session, { method: 'PUT', headers: { 'Content-Range': `bytes */${total}` }, body: Buffer.alloc(0) });
    if (r.status === 200 || r.status === 201) return { done: r };
    if (r.status === 308) return { next: nextByte(r) };
    if (r.status === 404 || r.status === 410) return { gone: true };
    throw youtubeError(r, 'video');
  }

  const nextByte = (r: Reply): number => {
    const range = String(r.headers.range || '');
    const m = /bytes=0-(\d+)/.exec(range);
    return m ? Number(m[1]) + 1 : 0;
  };

  const youtube: YouTube = {
    kind: 'youtube',
    accounts,

    async publish(t, secret, keep) {
      const post = t.post;
      const scheduled = !!post.schedule_at && Date.parse(post.schedule_at) > now();
      const wanted = post.visibility !== 'private' || scheduled;
      const meta = {
        snippet: {
          title: post.title,
          description: post.description,
          ...(post.tags.length ? { tags: post.tags } : {}),
          categoryId: post.youtube?.category || DEFAULT_YOUTUBE_CATEGORY,
        },
        status: {
          // YouTube holds a schedule only on a private video; it makes it public at publishAt.
          privacyStatus: scheduled ? 'private' : post.visibility,
          ...(scheduled ? { publishAt: new Date(post.schedule_at as string).toISOString() } : {}),
          selfDeclaredMadeForKids: !!post.youtube?.made_for_kids,
          containsSyntheticMedia: !!post.ai_generated,
        },
      };
      let session = t.session && t.session.total === t.bytes ? t.session.url : null;
      let done: Reply | null = null;
      let next = 0;
      if (session) {
        const at = await ask(secret, keep, session, t.bytes);
        if ('done' in at) done = at.done;
        else if ('gone' in at && t.committed) {
          // its last bytes went out before: the video may be on the channel, so no second upload (A12 PUB-1)
          t.keepSession(null);
          throw new PublishError('YouTube no longer knows the upload, and it may have finished: look on the channel');
        } else if ('gone' in at) session = null;
        else next = at.next;
      }
      if (!session && !done) {
        const r = await api(secret, keep, 'video', `${ep.youtubeUpload}/videos?uploadType=resumable&part=snippet,status`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Length': String(t.bytes),
            'X-Upload-Content-Type': 'video/mp4',
          },
          body: JSON.stringify(meta),
        });
        if (r.status !== 200) throw youtubeError(r, 'video');
        const loc = String(r.headers.location || '');
        let u: URL;
        try {
          u = new URL(loc);
        } catch {
          throw new PublishError('YouTube answered without an upload address', { transient: true });
        }
        // The bytes only ever go to YouTube's upload host, whatever an answer names.
        if (u.host !== uploadHost) throw new PublishError('YouTube named an upload address that isn’t its own: nothing was sent');
        session = u.toString();
        next = 0;
        t.keepSession({ url: session, total: t.bytes });
      }
      let resumes = 0;
      while (!done && session) {
        const end = Math.min(t.bytes, next + chunk) - 1;
        // the last bytes make the video: from here the session is what finds it again (A12 PUB-1)
        if (end === t.bytes - 1) t.committing();
        let r: Reply;
        try {
          r = await api(secret, keep, 'video', session, {
            method: 'PUT',
            headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${next}-${end}/${t.bytes}` },
            body: { file: t.file, start: next, end },
            progress: (sent) => t.progress(next + sent, t.bytes),
            timeoutMs: 120_000,
          });
        } catch (e) {
          const err = offline(e, 'video');
          if (!err.transient || resumes >= waits.length) throw err;
          // A dropped connection: ask how far YouTube got and go on from there.
          await new Promise((res) => setTimeout(res, waits[resumes++]));
          const at = await ask(secret, keep, session, t.bytes).catch((x) => {
            throw offline(x, 'video');
          });
          if ('done' in at) done = at.done;
          else if ('gone' in at) {
            t.keepSession(null);
            throw new PublishError('YouTube let the upload go: Lampo starts it again', { transient: true });
          } else next = at.next;
          continue;
        }
        if (r.status === 308) {
          next = nextByte(r);
          t.progress(next, t.bytes);
        } else if (r.status === 200 || r.status === 201) done = r;
        else if (r.status === 404 || r.status === 410) {
          t.keepSession(null);
          throw new PublishError('YouTube let the upload go: Lampo starts it again', { transient: true });
        } else if (r.status >= 500 && resumes < waits.length) {
          await new Promise((res) => setTimeout(res, waits[resumes++]));
          const at = await ask(secret, keep, session, t.bytes);
          if ('done' in at) done = at.done;
          else if ('gone' in at) {
            t.keepSession(null);
            throw new PublishError('YouTube let the upload go: Lampo starts it again', { transient: true });
          } else next = at.next;
        } else throw youtubeError(r, 'video');
      }
      if (!done) throw new PublishError('The upload to YouTube didn’t finish', { transient: true });
      // The session stays until the queue keeps the video's id: a stop while the cover is set finds this upload again
      // through it, instead of uploading the final a second time (A12 PUB-2).
      t.progress(t.bytes, t.bytes);
      const video = done.json<{ id?: string; status?: { privacyStatus?: string; publishAt?: string; uploadStatus?: string; rejectionReason?: string } }>();
      if (!video.id) throw new PublishError('YouTube took the upload but named no video', { transient: true });
      let note: string | undefined;
      if (t.cover) {
        const r = await api(secret, keep, 'cover', `${ep.youtubeUpload}/thumbnails/set?videoId=${encodeURIComponent(video.id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'image/jpeg' },
          body: fs.readFileSync(t.cover),
        }).catch((e: Error) => e);
        if (r instanceof Error || r.status !== 200)
          note = `the cover wasn't set: ${r instanceof Error ? r.message : youtubeError(r, 'cover').message} (custom covers need a verified YouTube account)`;
      }
      const locked = wanted && video.status?.privacyStatus === 'private' && !(scheduled && video.status?.publishAt);
      return {
        state: scheduled && !locked ? 'scheduled' : 'posted',
        remote_id: video.id,
        url: youtubeWatchUrl(video.id),
        ...(locked ? { locked: true } : {}),
        ...(note ? { note } : {}),
      };
    },

    async status(post, secret, keep): Promise<Outcome> {
      const id = post.remote_id as string;
      const r = await api(secret, keep, 'video', `${ep.youtube}/videos?part=status&id=${encodeURIComponent(id)}`);
      if (r.status !== 200) throw youtubeError(r, 'video');
      const item = r.json<{
        items?: { status?: { privacyStatus?: string; publishAt?: string; uploadStatus?: string; failureReason?: string; rejectionReason?: string } }[];
      }>().items?.[0];
      if (!item) throw new PublishError('The video is gone from YouTube (deleted on the channel?)');
      const s = item.status ?? {};
      if (s.uploadStatus === 'rejected') throw new PublishError(`YouTube rejected the video${s.rejectionReason ? ` (${s.rejectionReason})` : ''}`);
      if (s.uploadStatus === 'failed') throw new PublishError(`YouTube couldn’t process the video${s.failureReason ? ` (${s.failureReason})` : ''}`);
      const due = !post.schedule_at || Date.parse(post.schedule_at) <= now();
      const wanted = post.visibility !== 'private' || !!post.schedule_at;
      const locked = wanted && s.privacyStatus === 'private' && !(s.publishAt && !due);
      if (!due && s.publishAt && !locked) return { state: 'scheduled', remote_id: id, url: youtubeWatchUrl(id) };
      return { state: 'posted', remote_id: id, url: youtubeWatchUrl(id), ...(locked ? { locked: true } : {}) };
    },

    authUrl({ clientId, redirectUri, state, challenge }) {
      const q = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: YOUTUBE_SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      return `${ep.googleAuth}?${q}`;
    },

    async exchange({ secret, code, redirectUri, verifier }) {
      let r: Reply;
      try {
        r = await req(ep.googleToken, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form({
            code,
            client_id: secret.client_id,
            client_secret: secret.client_secret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
            code_verifier: verifier,
          }),
        });
      } catch (e) {
        throw offline(e, 'sign-in');
      }
      if (r.status !== 200) throw youtubeError(r, 'sign-in');
      const t = r.json<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }>();
      if (!t.refresh_token)
        throw new PublishError('Google gave no lasting sign-in: remove Lampo’s access in your Google account and connect again', { auth: true });
      const granted = String(t.scope || '').split(/\s+/);
      if (t.scope && !granted.includes(YOUTUBE_SCOPES[0] as string))
        throw new PublishError('Google didn’t allow uploads for this connection: connect it again and allow them', { auth: true });
      return {
        ...secret,
        refresh_token: t.refresh_token,
        ...(t.access_token ? { access_token: t.access_token, access_expires: now() + (t.expires_in ?? 3600) * 1000 } : {}),
      };
    },

    async revoke(secret) {
      const tok = secret.refresh_token || secret.access_token;
      if (!tok) return;
      await req(ep.googleRevoke, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ token: tok }) }).catch(
        () => {},
      );
    },
  };
  return youtube;
}
