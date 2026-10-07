// Publishing a final video (docs/publishing.md): connections, post drafts, publishing, the kit.
//   GET    /api/publish/connections                the workspace's connections (no secret ever)
//   POST   /api/publish/connections                add one (YouTube: client id + secret; Zernio: API key)
//   PATCH  /api/publish/connections/:id            its label, "my project passed the audit", a new key or client
//   DELETE /api/publish/connections/:id            remove it (YouTube: its sign-in revoked at Google)
//   POST   /api/publish/connections/:id/check      ask the platform: its accounts, or why it doesn't work
//   POST   /api/publish/connections/:id/authorize  YouTube: where the person signs in with Google
//   GET    /api/publish/oauth/callback             Google sends the person back here with a code
//   GET    /api/posts[?slug=]                      posts (status and history; the inbox's failed ones)
//   GET    /api/review/:slug/posts                 a video's posts
//   POST   /api/review/:slug/posts                 write the draft for one platform (made or changed)
//   PATCH  /api/posts/:id · DELETE /api/posts/:id  change or delete a draft
//   POST   /api/posts/:id/publish|cancel|retry     a person publishes, takes back, tries again
//   GET    /api/posts/:id/cover.jpg                the cover frame
//   POST   /api/posts/:id/kit · GET …/kit · GET …/kit/:file   the publish kit (kit.zip: all of it)
// Drafting is `post` (members and up, agents too); connections and publishing are `publish` (owners and admins) and
// PERSON_ONLY (server/permissions.ts): never an API token, so no agent can publish or touch a key.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Router } from 'express';
import { z } from 'zod';
import { postCategory, postFrame, postTags, postText, postTime, postTitle } from '../../lib/inputs.ts';
import { needJobRoom } from '../../lib/jobs.ts';
import { PublishError } from '../../lib/publish/adapter.ts';
import {
  addConnection,
  changeConnection,
  connectionInfo,
  findConnection,
  listConnections,
  removeConnection,
  secretOf,
  type YouTubeSecret,
  type ZernioSecret,
} from '../../lib/publish/connections.ts';
import { cachedCover, kitDir, kitInfo, kitPath, kitZip, makeKit } from '../../lib/publish/kit.ts';
import { platformOf } from '../../lib/publish/platforms.ts';
import {
  deletePost,
  draftPost,
  findPost,
  ofVideo,
  PostError,
  postsOf,
  publishPost,
  retryPost,
  type StoredPost,
  shownPosts,
  updatePost,
  viewOf,
} from '../../lib/publish/posts.ts';
import { pkce } from '../../lib/publish/youtube.ts';
import { RateLimit, Recent } from '../../lib/rateLimit.ts';
import { currentWorkspace } from '../../lib/scope.ts';
import * as store from '../../lib/store.ts';
import type { ConnectionsResponse, PostFields, PostsResponse, PostView } from '../../lib/types.ts';
import type { ServerContext } from '../context.ts';
import { gate } from '../extension.ts';
import { accountOf } from '../helpers.ts';
import { body, fail, failFrom, parse, query, router, sendInternal } from '../http.ts';

const postId = z.string().regex(/^po_[0-9a-f]{12}$/, 'expected a post id like po_1a2b3c4d5e6f');
const connId = z.string().regex(/^pc_[0-9a-f]{12}$/, 'expected a connection id like pc_1a2b3c4d5e6f');
const by = z.string().max(100).nullish();

const Fields = z
  .object({
    connection: z.string().max(40).nullable().optional(),
    account: z.string().max(120).nullable().optional(),
    title: postTitle.optional(),
    description: postText.optional(),
    tags: postTags.optional(),
    cover_frame: postFrame.nullable().optional(),
    visibility: z.enum(['public', 'unlisted', 'private']).optional(),
    schedule_at: postTime.nullable().optional(),
    ai_generated: z.boolean().nullable().optional(),
    youtube: z.object({ category: postCategory.optional(), made_for_kids: z.boolean().nullable().optional() }).strict().optional(),
    instagram: z
      .object({ kind: z.enum(['reel', 'feed']).optional(), share_to_feed: z.boolean().optional() })
      .strict()
      .optional(),
  })
  .strict();
const NewDraft = Fields.extend({ platform: z.string().max(20), by }).strict();
const Change = Fields.extend({ by }).strict();
const Confirm = z
  .object({
    confirm: z
      .object({
        platform: z.enum(['youtube', 'instagram', 'facebook']),
        account: z.string().max(120).nullable(),
        /** The post's `digest` as the person saw it: what goes out is what they confirmed (A12 PUB-3). */
        digest: z.string().regex(/^[0-9a-f]{16}$/, 'the digest of the post as you saw it'),
      })
      .strict(),
    /** It went out before (A12 PUB-1): the person asks to post it again, knowingly. */
    again: z.literal(true).optional(),
  })
  .strict();
const Retry = z.object({ again: z.literal(true).optional() }).strict();

const secretText = z.string().trim().min(8).max(500);
const NewConnection = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('youtube'), label: z.string().max(80).optional(), client_id: secretText, client_secret: secretText }).strict(),
  z.object({ kind: z.literal('zernio'), label: z.string().max(80).optional(), api_key: secretText }).strict(),
]);
const ConnectionPatch = z
  .object({
    label: z.string().max(80).optional(),
    audited: z.boolean().optional(),
    client_id: secretText.optional(),
    client_secret: secretText.optional(),
    api_key: secretText.optional(),
  })
  .strict();

/** A Google sign-in started here and not finished yet (10 minutes at most). */
interface PendingSignIn {
  ws: string;
  connection: string;
  user: string;
  verifier: string;
  redirect: string;
  expires: number;
}
const SIGN_IN_MS = 10 * 60e3;

/** A post-store refusal as an HTTP error (the next step rides along, 4xx only). */
const asHttp = (e: unknown) => {
  if (e instanceof PostError) return fail(e.status, e.message, e.next ? { next: e.next } : undefined);
  if (e instanceof PublishError) return fail(502, e.message);
  return failFrom(400, e);
};
const run = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    throw asHttp(e);
  }
};

export function publishRoutes(ctx: ServerContext): Router {
  const r = router();
  const base = (req: Request) => ctx.cfg.public_url || `${req.protocol}://${req.get('host')}`;
  const redirectOf = (req: Request) => `${base(req)}/api/publish/oauth/callback`;
  // Sign-ins waiting for Google, by their state (ours, random): bounded like every map keyed by what comes back in.
  const pending = new Recent<PendingSignIn>(500);
  // Asking a platform costs the person's quota and our patience: a few checks and sign-ins a minute per workspace. A new
  // Zernio key or connection is checked at once, so it counts as a check (A12 PUB-16).
  const asking = new RateLimit(30, 10 * 60e3, { maxKeys: 10_000 });
  const askRoom = (what: string) => {
    if (!asking.take(`${currentWorkspace()}:${what}`)) throw fail(429, 'too many checks for now: try again in a few minutes');
  };
  const told = (slug?: string) => {
    if (slug) {
      ctx.broadcast('posts', { slug });
      ctx.broadcast('library', { slug });
    }
  };
  const toldConnections = () => ctx.broadcast('connections', {});
  const viewAll = (posts: StoredPost[]): PostView[] => {
    const connections = safe(listConnections, []);
    return posts.map((p) => viewOf(p, { connections, hosted: ctx.hosted }));
  };
  const postOf = (req: Request): StoredPost => {
    const p = findPost(parse(postId, req.params.id, 'post id'));
    if (!p) throw fail(404, 'no such post');
    return p;
  };
  const view = (p: StoredPost): PostView => viewOf(p, { hosted: ctx.hosted });
  /** The video a post is of, for what is made from its file (the kit, the cover): 404 once that video is gone, and
   * what was made of it goes too — never served for a later video of the same name (A12 PUB-7). */
  const videoOf = (p: StoredPost) => {
    const review = store.loadReview(p.slug);
    if (review && ofVideo(p, review)) return review;
    fs.rmSync(kitDir(p.id), { recursive: true, force: true });
    throw fail(404, 'the video is gone');
  };

  // ---------------------------------------------------------------- connections

  r.get('/api/publish/connections', (req, res) => {
    const redirect = redirectOf(req);
    const out: ConnectionsResponse = { connections: safe(listConnections, []).map((c) => connectionInfo(c, redirect)), hosted: ctx.hosted };
    res.json(out);
  });

  r.post(
    '/api/publish/connections',
    gate(() => ctx.extension, 'publish'),
    express.json({ limit: '16kb' }),
    async (req, res) => {
      const b = body(NewConnection, req);
      if (b.kind === 'zernio') askRoom('check');
      const who = ctx.actor(req);
      const secret: YouTubeSecret | ZernioSecret = b.kind === 'youtube' ? { client_id: b.client_id, client_secret: b.client_secret } : { api_key: b.api_key };
      const c = run(() => addConnection({ kind: b.kind, label: b.label ?? '', secret, by: who, by_id: accountOf(req, who) }));
      // a key is checked at once (its accounts are what the composer offers); a YouTube client waits for the sign-in
      const checked = b.kind === 'zernio' ? await ctx.publisher.check(c.id) : c;
      toldConnections();
      res.json(connectionInfo(checked, redirectOf(req)));
    },
  );

  r.patch('/api/publish/connections/:id', express.json({ limit: '16kb' }), async (req, res) => {
    const id = parse(connId, req.params.id, 'connection id');
    const b = body(ConnectionPatch, req);
    const c = findConnection(id);
    if (!c) throw fail(404, 'no such connection');
    if (c.kind === 'zernio' && b.api_key) askRoom('check');
    let renewed = false;
    const out = run(() =>
      changeConnection(id, (now, secret) => {
        const ch: Parameters<typeof changeConnection>[1] & object = { ...(b.label !== undefined ? { label: b.label } : {}) };
        if (b.audited !== undefined && now.kind === 'youtube') ch.audited = b.audited;
        if (now.kind === 'youtube' && (b.client_id || b.client_secret)) {
          const old = (secret ?? {}) as Partial<YouTubeSecret>;
          // another client: the sign-in made with the old one is no use any more
          ch.secret = { client_id: b.client_id ?? old.client_id ?? '', client_secret: b.client_secret ?? old.client_secret ?? '' };
          ch.state = 'needs_auth';
          ch.accounts = [];
          ch.error = null;
        }
        if (now.kind === 'zernio' && b.api_key) {
          ch.secret = { api_key: b.api_key };
          renewed = true;
        }
        if (now.kind === 'youtube' && b.api_key !== undefined) throw fail(400, 'a YouTube connection has a client id and secret, not an API key');
        if (now.kind === 'zernio' && (b.client_id || b.client_secret || b.audited !== undefined)) throw fail(400, 'a Zernio connection has an API key only');
        return ch;
      }),
    );
    const checked = renewed ? await ctx.publisher.check(id) : out;
    toldConnections();
    res.json(connectionInfo(checked, redirectOf(req)));
  });

  r.delete('/api/publish/connections/:id', async (req, res) => {
    const id = parse(connId, req.params.id, 'connection id');
    const c = findConnection(id);
    if (!c) throw fail(404, 'no such connection');
    if (c.kind === 'youtube') {
      const s = secretOf<YouTubeSecret>(c);
      if (s) await ctx.publisher.adapters.youtube.revoke(s);
    }
    removeConnection(id);
    toldConnections();
    res.json({ ok: true });
  });

  r.post('/api/publish/connections/:id/check', async (req, res) => {
    const id = parse(connId, req.params.id, 'connection id');
    if (!findConnection(id)) throw fail(404, 'no such connection');
    askRoom('check');
    const out = await ctx.publisher.check(id);
    toldConnections();
    res.json(connectionInfo(out, redirectOf(req)));
  });

  r.post('/api/publish/connections/:id/authorize', (req, res) => {
    const id = parse(connId, req.params.id, 'connection id');
    const c = findConnection(id);
    if (!c) throw fail(404, 'no such connection');
    if (c.kind !== 'youtube') throw fail(400, 'only a YouTube connection signs in with Google');
    const secret = secretOf<YouTubeSecret>(c);
    if (!secret) throw fail(409, 'the connection’s client can’t be read any more: add it again');
    askRoom('authorize');
    const state = crypto.randomBytes(24).toString('base64url');
    const { verifier, challenge } = pkce();
    const redirect = redirectOf(req);
    pending.set(state, {
      ws: currentWorkspace(),
      connection: id,
      user: req.auth?.user?.id ?? req.auth?.name ?? '',
      verifier,
      redirect,
      expires: Date.now() + SIGN_IN_MS,
    });
    res.json({ url: ctx.publisher.adapters.youtube.authUrl({ clientId: secret.client_id, redirectUri: redirect, state, challenge }) });
  });

  // Google sends the browser back here. Whatever happens, the person lands on Settings → Publishing with a word on it.
  r.get('/api/publish/oauth/callback', async (req, res) => {
    const q = query(
      z.object({ state: z.string().max(200).optional(), code: z.string().max(2000).optional(), error: z.string().max(200).optional() }).passthrough(),
      req,
    );
    const back = (params: Record<string, string>) => res.redirect(303, `/#/settings/publishing?${new URLSearchParams(params)}`);
    const sign = q.state ? pending.get(q.state) : undefined;
    // a state is good once: a second visit of the same address finds it spent
    if (q.state && sign) pending.set(q.state, { ...sign, expires: 0 });
    const me = req.auth?.user?.id ?? req.auth?.name ?? '';
    if (!sign || sign.expires < Date.now() || sign.user !== me || sign.ws !== currentWorkspace()) return back({ publish_error: 'expired' });
    if (q.error || !q.code) return back({ publish_error: q.error === 'access_denied' ? 'denied' : 'failed', connection: sign.connection });
    const c = findConnection(sign.connection);
    const secret = c ? secretOf<YouTubeSecret>(c) : null;
    if (!c || !secret) return back({ publish_error: 'gone' });
    try {
      const kept = await ctx.publisher.adapters.youtube.exchange({ secret, code: q.code, redirectUri: sign.redirect, verifier: sign.verifier });
      changeConnection(c.id, { secret: kept, state: 'needs_auth', error: null });
      const checked = await ctx.publisher.check(c.id);
      toldConnections();
      if (checked.state !== 'ready') return back({ publish_error: 'check', connection: c.id });
      back({ connected: c.id });
    } catch (e) {
      changeConnection(c.id, { state: 'error', error: e instanceof PublishError ? e.message : 'The Google sign-in didn’t finish: try again.' });
      toldConnections();
      back({ publish_error: 'failed', connection: c.id });
    }
  });

  // ---------------------------------------------------------------- posts

  r.get('/api/posts', (req, res) => {
    const q = query(z.object({ slug: z.string().max(600).optional() }).strict(), req);
    const posts = q.slug ? postsOf(q.slug) : shownPosts();
    const out: PostsResponse = { posts: viewAll(posts) };
    res.json(out);
  });

  r.get('/api/review/:slug/posts', (req, res) => {
    const slug = String(req.params.slug);
    if (!store.loadReview(slug)) throw fail(404, 'unknown video');
    const out: PostsResponse = { posts: viewAll(postsOf(slug)) };
    res.json(out);
  });

  r.post('/api/review/:slug/posts', express.json({ limit: '256kb' }), (req, res) => {
    const slug = String(req.params.slug);
    const { platform: name, by: asBy, ...fields } = body(NewDraft, req);
    const platform = platformOf(name);
    if (!platform) throw fail(400, `${name} isn't a platform Lampo posts to (youtube, instagram, facebook)`);
    const who = ctx.actor(req, asBy);
    const { post, created } = run(() =>
      draftPost({ slug, platform, fields: fields as PostFields, by: who, by_id: accountOf(req, who), person: req.auth?.via !== 'token' }),
    );
    told(slug);
    res.status(created ? 201 : 200).json(view(post));
  });

  r.patch('/api/posts/:id', express.json({ limit: '256kb' }), (req, res) => {
    const p = postOf(req);
    const { by: asBy, ...fields } = body(Change, req);
    const out = run(() => updatePost(p.id, fields as PostFields, ctx.actor(req, asBy), { person: req.auth?.via !== 'token' }));
    told(out.slug);
    res.json(view(out));
  });

  r.delete('/api/posts/:id', (req, res) => {
    const p = postOf(req);
    run(() => deletePost(p.id, { person: req.auth?.via !== 'token' }));
    fs.rmSync(kitDir(p.id), { recursive: true, force: true });
    told(p.slug);
    res.json({ ok: true });
  });

  r.post(
    '/api/posts/:id/publish',
    gate(() => ctx.extension, 'publish'),
    express.json({ limit: '4kb' }),
    (req, res) => {
      const p = postOf(req);
      const { confirm, again } = body(Confirm, req);
      const who = ctx.actor(req);
      const out = run(() => publishPost(p.id, { confirm, by: who, by_id: accountOf(req, who), hosted: ctx.hosted, again }));
      ctx.publisher.poke();
      told(out.slug);
      res.json(view(out));
    },
  );

  r.post('/api/posts/:id/cancel', async (req, res) => {
    const p = postOf(req);
    const out = await ctx.publisher.cancel(p.id, ctx.actor(req)).catch((e) => {
      throw asHttp(e);
    });
    told(out.slug);
    res.json(view(out));
  });

  r.post(
    '/api/posts/:id/retry',
    gate(() => ctx.extension, 'publish'),
    express.json({ limit: '1kb' }),
    (req, res) => {
      const p = postOf(req);
      const { again } = body(Retry, req);
      const out = run(() => retryPost(p.id, ctx.actor(req), { again }));
      ctx.publisher.poke();
      told(out.slug);
      res.json(view(out));
    },
  );

  r.get('/api/posts/:id/cover.jpg', async (req, res) => {
    const p = postOf(req);
    const review = videoOf(p);
    if (p.cover_frame === null) throw fail(404, 'no cover chosen');
    const file = await cachedCover(p, review).catch(() => null);
    if (!file) throw fail(404, 'no cover');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    sendInternal(res, file);
  });

  r.post('/api/posts/:id/kit', (req, res) => {
    const p = postOf(req);
    const review = videoOf(p);
    // an encode is a job like any other: a workspace whose queue is full is told so (503), nothing queued past the cap
    needJobRoom();
    void makeKit(p, review).then(() => told(p.slug));
    res.status(202).json(kitInfo(p.id) ?? { state: 'making', files: [] });
  });

  r.get('/api/posts/:id/kit', (req, res) => {
    const p = postOf(req);
    videoOf(p);
    res.json(kitInfo(p.id) ?? { state: 'none', files: [] });
  });

  r.get('/api/posts/:id/kit/:file', async (req, res) => {
    const p = postOf(req);
    const review = videoOf(p);
    const name = String(req.params.file);
    const filename = (n: string) => `attachment; filename="${n.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(n)}`;
    if (name === 'kit.zip') {
      if (kitInfo(p.id)?.state !== 'ready') throw fail(404, 'the kit isn’t made yet');
      const plan = kitZip(p.id);
      const zipName = `${path.basename(review.video).replace(/\.[^.]+$/, '') || 'video'}-${p.platform}-kit.zip`;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', String(plan.length));
      res.setHeader('Content-Disposition', filename(zipName));
      // a HEAD gets the headers only: Node would drop the body, but the loop below would still read the whole kit
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      for await (const chunk of plan.bytes()) if (!res.write(chunk)) await new Promise((ok) => res.once('drain', ok));
      res.end();
      return;
    }
    const file = kitPath(p.id, name);
    if (!file) throw fail(404, 'no such file in the kit');
    res.setHeader('Content-Disposition', filename(name));
    sendInternal(res, file);
  });

  return r;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
