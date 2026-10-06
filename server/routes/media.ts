// Bytes for the player: the video itself (range-streamed, or a redirect to signed storage URLs), poster frames,
// per-frame waveforms, project tracks, exact frames for agents.
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Router } from 'express';
import { z } from 'zod';
import { poster, projectTracks, waveform } from '../../lib/media.ts';
import { cacheDir, reviewDir } from '../../lib/paths.ts';
import { FRAME_CACHE_BYTES, pruneDir } from '../../lib/prune.ts';
import { renderKey } from '../../lib/renderKey.ts';
import { type GrabCount, grabCount, grabFrame } from '../../lib/shots.ts';
import { rootStorage } from '../../lib/storage/index.ts';
import { openMedia } from '../../lib/storage/mediaHost.ts';
import * as store from '../../lib/store.ts';
import type { ProjectTracks } from '../../lib/types.ts';
import type { ServerContext } from '../context.ts';
import { mediaHostOf, requestHost } from '../guard.ts';
import { getReview, getVersion, sendSprite, versionBytes } from '../helpers.ts';
import { attachment, fail, query, router, sendInternal } from '../http.ts';
import { sendMedia, streamFile } from '../playback.ts';
import { ipOf, keptInMemory } from './shares/access.ts';

// `size=thumb`: a small JPEG of the frame (Auto-check's findings show one each) instead of the full-size PNG.
const FrameQuery = z.object({ v: z.coerce.number().int().min(1).optional(), frame: z.coerce.number().int().min(0), size: z.enum(['thumb']).optional() });
const THUMB_SIDE = 320;
// Files a review folder may serve: screenshots and voice notes, nothing else (review.json, users.json, … stay private).
const SERVABLE = /^[\w-]+\.(png|jpe?g|webp|m4a)$/i;

/**
 * The new frames a caller asks for, counted per account (an address without one) against ctx.frameGrabs (A13 VERIFY-2:
 * one account's 300 frame requests at once); the machine's owner at the machine is not counted.
 */
export const grabsOf = (ctx: ServerContext, req: Request): GrabCount | null =>
  req.auth?.via === 'local' ? null : grabCount(ctx.frameGrabs, req.auth?.user?.id ? `account:${req.auth.user.id}` : `address:${ipOf(req)}`);

export function mediaRoutes(ctx: ServerContext): Router {
  const r = router();
  const { playback } = ctx;
  keptInMemory(ctx, { frameGrabs: ctx.frameGrabs });

  // The app's own media host (VR_MEDIA_ORIGIN, lib/storage/mediaHost.ts): a file by its signed URL, which is the whole
  // credential — the redirect that handed it out checked who asked (a session, a token, a review link). Only on that
  // host; on any other the path is nobody's.
  const mediaHost = ctx.hosted ? mediaHostOf(ctx.cfg.media_origin) : null;
  r.get('/media/s/:sealed/:name', async (req, res) => {
    if (!mediaHost || requestHost(req) !== mediaHost) throw fail(404, 'not found');
    const claims = openMedia<{ k?: unknown; n?: unknown }>(req.params.sealed);
    if (!claims || typeof claims.k !== 'string') throw fail(403, 'this media link has expired: open the page again');
    let file: string | null = null;
    try {
      const root = rootStorage();
      const here = root.localPath(claims.k);
      file = fs.existsSync(here) ? here : await root.ensureLocal(claims.k);
    } catch {
      file = null;
    }
    if (!file) throw fail(410, 'this file is gone');
    if (typeof claims.n === 'string') res.setHeader('Content-Disposition', attachment(claims.n));
    // The app's pages may read it too (a warm-up fetch); the URL is the credential, never a cookie.
    if (ctx.cfg.public_url) res.setHeader('Access-Control-Allow-Origin', new URL(ctx.cfg.public_url).origin);
    const left = Math.max(0, claims.e - Math.floor(Date.now() / 1000));
    streamFile(req, res, file, { cache: `private, max-age=${left}, immutable` });
  });

  r.get('/media/:slug/v:v', async (req, res) => {
    const review = getReview(req.params.slug);
    const ver = getVersion(review, req.params.v);
    const p = playback.playable(review, ver, { build: true });
    if (!p.ready) throw fail(p.preparing ? 425 : 410, p.error || 'preparing a browser-playable proxy');
    const src = playback.served(p, req);
    await sendMedia(req, res, src, { immutable: src.file !== review.video });
  });

  r.get('/api/poster/:slug.jpg', async (req, res) => {
    const review = getReview(req.params.slug);
    const ver = getVersion(review, undefined);
    const out = await poster(() => versionBytes(review, ver), ver, review.meta);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    sendInternal(res, out);
  });

  // The newest render's hover-scrub sprite (lib/sprite.ts: the layout). Made on first request, least urgent of all
  // background work: until then 202 + Retry-After, and the card keeps showing the poster. `?v=` only busts caches.
  r.get('/api/sprite/:slug.jpg', (req, res) => {
    sendSprite(res, ctx.background.startSprite(getReview(req.params.slug)));
  });

  r.get('/api/waveform/:slug/:v', async (req, res) => {
    const review = getReview(req.params.slug);
    const ver = getVersion(review, req.params.v);
    const peaks = await waveform(() => versionBytes(review, ver), ver);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.json(peaks);
  });

  // Remotion-style timeline/words next to the render: only for files on this machine, never on a hosted server.
  r.get('/api/tracks/:slug', (req, res) => {
    const review = getReview(req.params.slug);
    const none: ProjectTracks = { dir: '', timeline: null, words: null, segments: null };
    res.json(!ctx.capabilities.projectFiles || store.isUpload(review) ? none : projectTracks(review.video));
  });

  // One exact frame as PNG (what `get_frame` shows an agent that talks to a remote server), or a thumbnail of it.
  r.get('/api/review/:slug/frame', async (req, res) => {
    const review = getReview(req.params.slug);
    const q = query(FrameQuery, req);
    const ver = getVersion(review, q.v);
    if (q.frame >= ver.frames) throw fail(400, `frame ${q.frame} is outside 0–${ver.frames - 1}`);
    const thumb = q.size === 'thumb';
    const out = path.join(cacheDir(), 'frames', `${renderKey(ver).slice(0, 16)}_${q.frame}${thumb ? '_t.jpg' : '.png'}`);
    if (!fs.existsSync(out)) {
      // a frame nobody asked for yet is a grab: counted for the account once it is made (429 past its limit)
      const count = grabsOf(ctx, req);
      count?.check();
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await grabFrame(await versionBytes(review, ver), q.frame, { ...(review.meta || {}), ...ver }, out, thumb ? { side: THUMB_SIDE } : {});
      count?.landed();
      pruneDir(path.dirname(out), FRAME_CACHE_BYTES, (f) => /\.(png|jpg)$/.test(f) && f !== path.basename(out));
    }
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    sendInternal(res, out);
  });

  // Screenshots and voice notes of a review.
  r.get('/data/:slug/:file', (req, res) => {
    const { slug, file } = req.params;
    if (!SERVABLE.test(file) || !store.loadReview(slug)) throw fail(404, 'not found');
    const full = path.join(reviewDir(slug), file);
    if (!fs.existsSync(full)) throw fail(404, 'not found');
    res.setHeader('Cache-Control', 'no-cache');
    sendInternal(res, full);
  });

  return r;
}
