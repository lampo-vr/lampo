// Fake platforms for publishing tests: Google's sign-in and token endpoints, YouTube's Data API with its resumable
// upload, and a unified posting API shaped like Zernio's — one local HTTP server, no network. Tests (and the browser
// suites, through VR_PUBLISH_ENDPOINTS) point Lampo here. Knobs make the platforms behave badly on purpose: a dropped
// connection mid-upload, a quota, a project YouTube keeps private (unaudited), a post Instagram refuses.
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeUpload {
  id: string;
  /** What the metadata said (snippet + status as sent). */
  meta: { snippet?: Record<string, unknown>; status?: Record<string, unknown> };
  total: number;
  bytes: Buffer;
  done: boolean;
  /** The video id once complete. */
  video?: string;
}

export interface FakeVideo {
  id: string;
  meta: FakeUpload['meta'];
  bytes: number;
  sha256: string;
  status: { privacyStatus: string; publishAt?: string; uploadStatus: string };
  thumbnail?: number;
}

export interface FakePost {
  id: string;
  body: Record<string, unknown>;
  media: { key: string; bytes: number; sha256: string } | null;
  status: string;
  error?: string;
}

export interface Knobs {
  /** YouTube keeps every upload private and drops publishAt (an API project that hasn't passed the audit). */
  lockPrivate?: boolean;
  /** Cut the connection once after this many bytes of an upload chunk have arrived (then behave). */
  dropAfter?: number;
  /** The next videos.insert answers 403 quotaExceeded. */
  quota?: boolean;
  /** Google refuses the refresh token (revoked by the person). */
  revoked?: boolean;
  /** The unified API's next post fails for its platform with this reason. */
  postFails?: string;
  /** The unified API answers a new post as still being published (then published on the next look). */
  postSlow?: boolean;
  /** The unified API refuses the key. */
  badKey?: boolean;
  /** The next upload session is named on another host (Lampo must refuse to send bytes there). */
  foreignSession?: string;
}

export interface FakePlatforms {
  url: string;
  /** What Lampo's environment needs to use these platforms (VR_PUBLISH_ENDPOINTS). */
  env: Record<string, string>;
  endpoints: Record<string, string>;
  knobs: Knobs;
  uploads: Map<string, FakeUpload>;
  videos: Map<string, FakeVideo>;
  posts: Map<string, FakePost>;
  /** Every request as it came in: method, path, headers (to check what Lampo sends, and never sends). */
  seen: { method: string; path: string; headers: http.IncomingHttpHeaders; body: string }[];
  /** The tokens and keys it accepts. */
  clientId: string;
  clientSecret: string;
  apiKey: string;
  close(): Promise<void>;
}

const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const googleError = (res: http.ServerResponse, status: number, reason: string, message: string) =>
  json(res, status, { error: { code: status, message, errors: [{ reason, message }] } });

export async function startFakePlatforms(): Promise<FakePlatforms> {
  const knobs: Knobs = {};
  const uploads = new Map<string, FakeUpload>();
  const videos = new Map<string, FakeVideo>();
  const posts = new Map<string, FakePost>();
  const storage = new Map<string, Buffer>();
  const seen: FakePlatforms['seen'] = [];
  const clientId = 'fake-client-1234567890.apps.example';
  const clientSecret = 'fake-client-secret-abcdef';
  const apiKey = `sk_${'0123456789abcdef'.repeat(4)}`;
  const codes = new Map<string, { redirect: string; challenge: string }>();
  const refreshTokens = new Set<string>();
  const accessTokens = new Set<string>();
  let url = '';

  const bearer = (req: http.IncomingMessage) => String(req.headers.authorization || '').replace(/^Bearer /, '');
  const read = (req: http.IncomingMessage, cap = 64 * 1024 * 1024): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let n = 0;
      req.on('data', (d: Buffer) => {
        n += d.length;
        if (n <= cap) chunks.push(d);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url || '/', url);
    const p = u.pathname;
    // an upload chunk is read as it streams (to drop it halfway); everything else whole
    const isChunk = req.method === 'PUT' && p === '/upload/youtube/v3/videos' && u.searchParams.has('upload_id');
    const body = isChunk ? Buffer.alloc(0) : await read(req);
    seen.push({ method: req.method || '', path: `${p}${u.search}`, headers: req.headers, body: isChunk ? '' : body.toString('utf8').slice(0, 2000) });

    // ---------------------------------------------------------------- Google sign-in
    if (p === '/google/auth' && req.method === 'GET') {
      // consent given at once: back to Lampo with a code
      const code = crypto.randomBytes(8).toString('hex');
      codes.set(code, { redirect: String(u.searchParams.get('redirect_uri')), challenge: String(u.searchParams.get('code_challenge')) });
      const back = new URL(String(u.searchParams.get('redirect_uri')));
      back.searchParams.set('code', code);
      back.searchParams.set('state', String(u.searchParams.get('state')));
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (p === '/google/token' && req.method === 'POST') {
      const f = new URLSearchParams(body.toString('utf8'));
      if (f.get('client_id') !== clientId || f.get('client_secret') !== clientSecret)
        return json(res, 401, { error: 'invalid_client', error_description: 'The OAuth client was not found.' });
      if (f.get('grant_type') === 'authorization_code') {
        const c = codes.get(String(f.get('code')));
        codes.delete(String(f.get('code')));
        const challenge = crypto
          .createHash('sha256')
          .update(String(f.get('code_verifier')))
          .digest('base64url');
        if (!c || c.redirect !== f.get('redirect_uri') || c.challenge !== challenge)
          return json(res, 400, { error: 'invalid_grant', error_description: 'Bad code.' });
        const refresh = `rt-${crypto.randomBytes(8).toString('hex')}`;
        const access = `at-${crypto.randomBytes(8).toString('hex')}`;
        refreshTokens.add(refresh);
        accessTokens.add(access);
        return json(res, 200, {
          access_token: access,
          refresh_token: refresh,
          expires_in: 3599,
          scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
          token_type: 'Bearer',
        });
      }
      if (f.get('grant_type') === 'refresh_token') {
        if (knobs.revoked || !refreshTokens.has(String(f.get('refresh_token'))))
          return json(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        const access = `at-${crypto.randomBytes(8).toString('hex')}`;
        accessTokens.add(access);
        return json(res, 200, { access_token: access, expires_in: 3599, token_type: 'Bearer' });
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (p === '/google/revoke' && req.method === 'POST') {
      const t = new URLSearchParams(body.toString('utf8')).get('token') || '';
      refreshTokens.delete(t);
      accessTokens.delete(t);
      return json(res, 200, {});
    }

    // ---------------------------------------------------------------- YouTube Data API
    if (p.startsWith('/youtube/v3/') || p.startsWith('/upload/youtube/v3/')) {
      if (!accessTokens.has(bearer(req))) return googleError(res, 401, 'authError', 'Invalid Credentials');
    }
    if (p === '/youtube/v3/channels' && req.method === 'GET')
      return json(res, 200, { items: [{ id: 'UC_fake_channel', snippet: { title: 'Studio Channel', customUrl: '@studiochannel' } }] });
    if (p === '/youtube/v3/videos' && req.method === 'GET') {
      const v = videos.get(String(u.searchParams.get('id')));
      if (!v) return json(res, 200, { items: [] });
      // a publishAt in the past: the video is public now (unless locked)
      if (v.status.publishAt && Date.parse(v.status.publishAt) <= Date.now() && !knobs.lockPrivate) {
        v.status.privacyStatus = 'public';
        delete v.status.publishAt;
      }
      return json(res, 200, { items: [{ id: v.id, status: v.status }] });
    }
    if (p === '/upload/youtube/v3/videos' && req.method === 'POST' && u.searchParams.get('uploadType') === 'resumable') {
      if (knobs.quota) {
        knobs.quota = false;
        return googleError(res, 403, 'quotaExceeded', 'The request cannot be completed because you have exceeded your quota.');
      }
      const id = crypto.randomBytes(6).toString('hex');
      const meta = JSON.parse(body.toString('utf8') || '{}');
      uploads.set(id, { id, meta, total: Number(req.headers['x-upload-content-length']), bytes: Buffer.alloc(0), done: false });
      const host = knobs.foreignSession ?? url;
      knobs.foreignSession = undefined;
      res.writeHead(200, { Location: `${host}/upload/youtube/v3/videos?uploadType=resumable&upload_id=${id}` });
      return res.end();
    }
    if (isChunk) {
      const up = uploads.get(String(u.searchParams.get('upload_id')));
      if (!up) {
        await read(req);
        return googleError(res, 404, 'notFound', 'Upload session not found.');
      }
      const range = String(req.headers['content-range'] || '');
      const status = /^bytes \*\/(\d+)$/.exec(range);
      const finish = () => {
        if (!up.video) {
          up.done = true;
          const vid = `vid_${crypto.randomBytes(5).toString('hex')}`;
          up.video = vid;
          const st = (up.meta.status ?? {}) as { privacyStatus?: string; publishAt?: string };
          const lockedNow = knobs.lockPrivate;
          videos.set(vid, {
            id: vid,
            meta: up.meta,
            bytes: up.bytes.length,
            sha256: crypto.createHash('sha256').update(up.bytes).digest('hex'),
            status: {
              privacyStatus: lockedNow ? 'private' : String(st.privacyStatus || 'private'),
              ...(st.publishAt && !lockedNow ? { publishAt: String(st.publishAt) } : {}),
              uploadStatus: 'uploaded',
            },
          });
        }
        const v = videos.get(up.video as string) as FakeVideo;
        return json(res, 201, { id: v.id, status: v.status, snippet: up.meta.snippet });
      };
      if (status) {
        await read(req);
        if (up.done) return finish();
        if (!up.bytes.length) {
          res.writeHead(308);
          return res.end();
        }
        res.writeHead(308, { Range: `bytes=0-${up.bytes.length - 1}` });
        return res.end();
      }
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
      if (!m || Number(m[1]) !== up.bytes.length) {
        await read(req);
        return googleError(res, 400, 'badRequest', `Expected the bytes from ${up.bytes.length}.`);
      }
      // read the chunk as it comes; drop the connection halfway once when asked to
      const got: Buffer[] = [];
      let n = 0;
      let dropped = false;
      await new Promise<void>((resolve) => {
        req.on('data', (d: Buffer) => {
          if (dropped) return;
          got.push(d);
          n += d.length;
          if (knobs.dropAfter !== undefined && n >= knobs.dropAfter) {
            knobs.dropAfter = undefined;
            dropped = true;
            // keep what arrived up to the last whole 256 KiB, as YouTube would
            const kept = Buffer.concat(got);
            up.bytes = Buffer.concat([up.bytes, kept.subarray(0, Math.floor(kept.length / (256 * 1024)) * 256 * 1024)]);
            req.socket.destroy();
            resolve();
          }
        });
        req.on('end', () => resolve());
        req.on('error', () => resolve());
      });
      if (dropped) return;
      up.bytes = Buffer.concat([up.bytes, ...got]);
      if (up.bytes.length >= up.total) return finish();
      res.writeHead(308, { Range: `bytes=0-${up.bytes.length - 1}` });
      return res.end();
    }
    if (p === '/upload/youtube/v3/thumbnails/set' && req.method === 'POST') {
      const v = videos.get(String(u.searchParams.get('videoId')));
      if (!v) return googleError(res, 404, 'videoNotFound', 'Video not found.');
      v.thumbnail = body.length;
      return json(res, 200, { items: [{ default: { url: `${url}/thumb.jpg` } }] });
    }

    // ---------------------------------------------------------------- the unified posting API (Zernio's shape)
    if (p.startsWith('/zernio/v1/')) {
      if (knobs.badKey || bearer(req) !== apiKey) return json(res, 401, { code: 'unauthorized', error: 'Invalid API key' });
    }
    if (p === '/zernio/v1/accounts' && req.method === 'GET')
      return json(res, 200, {
        accounts: [
          { _id: 'acc_ig_1', platform: 'instagram', username: 'studio.reels', displayName: 'Studio Reels' },
          { _id: 'acc_fb_1', platform: 'facebook', displayName: 'Studio Page' },
          { _id: 'acc_tt_1', platform: 'tiktok', username: 'studio' },
        ],
      });
    if (p === '/zernio/v1/media/presign' && req.method === 'POST') {
      const key = `m_${crypto.randomBytes(6).toString('hex')}`;
      return json(res, 200, { uploadUrl: `${url}/zernio-storage/${key}?sig=fake`, publicUrl: `${url}/zernio-media/${key}`, key, expiresIn: 3600 });
    }
    if (p.startsWith('/zernio-storage/') && req.method === 'PUT') {
      // presigned: no key needed (and none must be sent)
      storage.set(p.slice('/zernio-storage/'.length), body);
      res.writeHead(200, { ETag: '"fake"' });
      return res.end();
    }
    if (p === '/zernio/v1/posts' && req.method === 'POST') {
      const b = JSON.parse(body.toString('utf8') || '{}') as Record<string, unknown>;
      const idem = String(req.headers['idempotency-key'] || '');
      const again = idem ? [...posts.values()].find((x) => x.body.__idem === idem) : undefined;
      if (again) return json(res, 200, { post: answerOf(again) });
      const media = (b.mediaItems as { url: string }[] | undefined)?.[0];
      const key = media?.url.split('/zernio-media/')[1] ?? '';
      const bytes = storage.get(key);
      const id = `zp_${crypto.randomBytes(5).toString('hex')}`;
      const platform = (b.platforms as { platform: string }[])[0]?.platform;
      const post: FakePost = {
        id,
        body: { ...b, __idem: idem },
        media: bytes ? { key, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') } : null,
        status: knobs.postFails ? 'failed' : knobs.postSlow ? 'publishing' : 'published',
        ...(knobs.postFails ? { error: knobs.postFails } : {}),
      };
      knobs.postFails = undefined;
      knobs.postSlow = undefined;
      posts.set(id, post);
      void platform;
      return json(res, 201, { post: answerOf(post) });
    }
    const one = /^\/zernio\/v1\/posts\/([\w-]+)$/.exec(p);
    if (one) {
      const post = posts.get(one[1] as string);
      if (!post) return json(res, 404, { code: 'not_found', error: 'Post not found' });
      if (req.method === 'DELETE') {
        post.status = 'cancelled';
        return json(res, 200, { ok: true });
      }
      // a post being published is out on the next look
      if (post.status === 'publishing') post.status = 'published';
      return json(res, 200, { post: answerOf(post) });
    }
    json(res, 404, { error: `fake platforms: nothing at ${req.method} ${p}` });
  });

  function answerOf(post: FakePost) {
    const platform = (post.body.platforms as { platform: string; accountId: string }[])[0];
    return {
      _id: post.id,
      status: post.status,
      platforms: [
        {
          platform: platform?.platform,
          accountId: platform?.accountId,
          status: post.status,
          ...(post.status === 'published'
            ? { platformPostId: `${platform?.platform}-${post.id}`, platformPostUrl: `https://${platform?.platform}.example/p/${post.id}` }
            : {}),
          ...(post.error ? { errorMessage: post.error } : {}),
        },
      ],
    };
  }

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const endpoints = {
    googleAuth: `${url}/google/auth`,
    googleToken: `${url}/google/token`,
    googleRevoke: `${url}/google/revoke`,
    youtube: `${url}/youtube/v3`,
    youtubeUpload: `${url}/upload/youtube/v3`,
    zernio: `${url}/zernio`,
  };
  return {
    url,
    env: { VR_PUBLISH_ENDPOINTS: JSON.stringify(endpoints) },
    endpoints,
    knobs,
    uploads,
    videos,
    posts,
    seen,
    clientId,
    clientSecret,
    apiKey,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
