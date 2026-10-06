// An Embed link (lib/shares.ts `embed`): one video's player alone, framed by another site (/e/<token>, the page is
// web/embed.html), and oEmbed for sites that embed from a URL. What the player asks for is here — the newest version's
// frame facts, its media (the same signed copy a Watch only link plays), its chapters and captions when it has them, and
// whether the Lampo mark shows; the rest it shares with every link: posters, hover frames, visits, watch reports. Other
// links answer none of it (404), so a review link's token never opens a player on someone else's site.
import path from 'node:path';
import type { Request, Router } from 'express';
import { z } from 'zod';
import { BRAND_NAME, SITE_URL } from '../../../lib/brand.ts';
import { chapters } from '../../../lib/media.ts';
import { inWorkspace, slugify } from '../../../lib/paths.ts';
import { guestId, linkWorkspace, resolveShare } from '../../../lib/shares.ts';
import { SPRITE_VERSION } from '../../../lib/sprite.ts';
import { toVtt } from '../../../lib/transcript.ts';
import { cachedTranscript } from '../../../lib/transcripts.ts';
import type { Chapter, EmbedResponse, OEmbedResponse, Review, ShareWithToken, Version } from '../../../lib/types.ts';
import { suspensionOf } from '../../../lib/workspaces.ts';
import type { ServerContext } from '../../context.ts';
import { requestHost } from '../../guard.ts';
import { versionBytes } from '../../helpers.ts';
import { fail, query, router, VersionQuery } from '../../http.ts';
import { badgeShown, embedOf, target, version } from './access.ts';

/** The tokens' shape (lib/shares.ts resolveShare). */
const TOKEN = /^[A-Za-z0-9_-]{20,40}$/;

const OEmbedQuery = z.object({
  url: z.string().max(2000),
  format: z.string().max(20).optional(),
  maxwidth: z.coerce.number().int().positive().max(100_000).optional(),
  maxheight: z.coerce.number().int().positive().max(100_000).optional(),
});

/** The size an oEmbed answer offers when the consumer names no bounds: the video's own, at most this on each side. */
const OEMBED_MAX = 1280;

/** Where this server's pages are, as the visitor reaches them: its public URL, the machine's tunnel, else the request's host. */
export function pageBase(ctx: ServerContext, req: Request): string {
  if (ctx.cfg.public_url) return ctx.cfg.public_url.replace(/\/+$/, '');
  const host = String(req.headers.host || '');
  const tunnel = ctx.tunnel.url;
  try {
    if (tunnel && new URL(tunnel).host === host) return tunnel.replace(/\/+$/, '');
  } catch {}
  return `${req.protocol}://${host}`;
}

/**
 * The token an embed's page or watch page names (`/e/<token>` or `/g/<token>` on this server), or null. This server's
 * own addresses only, so an answer never names another site: its public URL, else the name it was asked by or the
 * machine's tunnel (whose name changes every time it starts).
 */
function tokenOf(ctx: ServerContext, req: Request, url: string): { token: string; base: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const ours = (other: string | null) => {
    try {
      return !!other && new URL(other).origin === u.origin;
    } catch {
      return false;
    }
  };
  if (ctx.cfg.public_url ? !ours(ctx.cfg.public_url) : u.hostname.replace(/^\[|\]$/g, '') !== requestHost(req) && !ours(ctx.tunnel.url)) return null;
  const m = /^\/[eg]\/([^/]+)$/.exec(u.pathname);
  return m && TOKEN.test(m[1] as string) ? { token: m[1] as string, base: u.origin } : null;
}

/** An Embed link's video and its newest version (a video gone or emptied is a 404 like an unknown link). */
function videoOf(share: ShareWithToken): { review: Review; ver: Version; id: string } {
  const review = target(share);
  const ver = review.versions.at(-1) as Version;
  return { review, ver, id: guestId(share, slugify(review.video)) };
}

/** The captions of a version: its transcript's lines, when it was heard and something is said (never heard here). */
const heard = (ver: Version) => {
  const t = cachedTranscript(ver);
  return t?.lines.length ? t : null;
};

/** `w` × `h` scaled down to fit `maxW` × `maxH`, never up; whole pixels. */
function fit(w: number, h: number, maxW: number, maxH: number): { width: number; height: number } {
  const k = Math.min(1, maxW / w, maxH / h);
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The oEmbed discovery tag for an Embed link's pages (/e/<token>, and its watch page /g/<token>), or '' for any other
 * link: a site that is given the page's address finds the player through it. Asked in the link's workspace.
 */
export function discoveryTag(ctx: ServerContext, req: Request, token: string, kind: 'e' | 'g'): string {
  let share: ShareWithToken | null = null;
  try {
    share = resolveShare(token);
  } catch {
    return '';
  }
  if (!share?.embed || share.password || share.folder) return '';
  const page = `${pageBase(ctx, req)}/${kind}/${token}`;
  const href = `${pageBase(ctx, req)}/oembed?url=${encodeURIComponent(page)}&format=json`;
  return `<link rel="alternate" type="application/json+oembed" href="${attr(href)}" />`;
}

export function embedRoutes(ctx: ServerContext): Router {
  const r = router();
  const { playback } = ctx;

  // What the player plays and shows. A view isn't counted here: the page an embed sits on loads it for every visitor of
  // that page, watching or not — the player counts its visit on the first play (POST /api/g/:token/visit with the video).
  r.get('/api/g/:token/embed', async (req, res) => {
    const share = embedOf(req.params.token);
    const { review, ver, id } = videoOf(share);
    const play = playback.preview(review, ver);
    const token = share.token;
    // a part's own file holds a stretch of the video, not its chapters
    const marks: Chapter[] = ver.part ? [] : await chapters(() => versionBytes(review, ver), ver).catch(() => []);
    const words = heard(ver);
    const out: EmbedResponse = {
      title: path.basename(review.video),
      slug: id,
      v: ver.v,
      fps: ver.fps,
      frames: ver.frames,
      width: ver.width,
      height: ver.height,
      duration: ver.duration,
      media: play.ready ? `/media/g/${token}/${id}/v${ver.v}${playback.mediaQuery(ver, play)}` : null,
      ...(play.preparing ? { preparing: true } : {}),
      ...(play.busy ? { busy: true } : {}),
      poster: `/api/g/${token}/poster/${id}?v=${ver.v}`,
      sprite: `/api/g/${token}/sprite/${id}?v=${ver.v}&s=${SPRITE_VERSION}`,
      chapters: marks,
      captions: words ? `/api/g/${token}/captions/${id}?v=${ver.v}` : null,
      ...(words ? { captions_lang: /^[a-z]{2,3}$/.test(words.language) ? words.language : null } : {}),
      badge: await badgeShown(ctx),
    };
    res.setHeader('Cache-Control', 'no-store');
    res.json(out);
  });

  // The captions: what is said in the newest version, as WebVTT (the transcript's lines; never its engine or hash).
  r.get('/api/g/:token/captions/:slug', (req, res) => {
    const share = embedOf(req.params.token);
    const review = target(share, req.params.slug);
    const ver = version(share, review, query(VersionQuery, req).v);
    const words = heard(ver);
    if (!words) throw fail(404, 'This video has no captions.');
    res.setHeader('Cache-Control', 'no-cache');
    res.type('text/vtt').send(toVtt(words));
  });

  // oEmbed (https://oembed.com): a site given an Embed link's address (its player or its watch page) gets the player's
  // iframe, its size, the video's title as a Watch only visitor reads it, and its poster. Nothing for any other link,
  // address or format. Answers any origin: it says only what the player itself shows.
  r.get('/oembed', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    const q = query(OEmbedQuery, req);
    // (oEmbed's own answer for a format it doesn't offer: said here, it is the asker's choice, not a fault of ours)
    if (q.format && q.format !== 'json') return void res.status(501).json({ error: 'Only the JSON format is offered.' });
    const named = tokenOf(ctx, req, q.url);
    if (!named) throw fail(404, 'No embed at that address.');
    const ws = linkWorkspace(named.token);
    // a suspended workspace's links answer like ended ones (server/workspace.ts)
    if (suspensionOf(ws)) throw fail(404, 'No embed at that address.');
    const out = await inWorkspace(ws, async (): Promise<OEmbedResponse> => {
      let share: ShareWithToken;
      try {
        share = embedOf(named.token);
      } catch {
        throw fail(404, 'No embed at that address.');
      }
      const { review, ver, id } = videoOf(share);
      const size = fit(ver.width, ver.height, q.maxwidth ?? OEMBED_MAX, q.maxheight ?? OEMBED_MAX);
      const title = path.basename(review.video);
      // the poster (lib/media.ts) is 640 on its long side
      const upright = ver.height >= ver.width;
      const src = `${named.base}/e/${named.token}`;
      const badge = await badgeShown(ctx);
      return {
        version: '1.0',
        type: 'video',
        title,
        html: `<iframe src="${attr(src)}" width="${size.width}" height="${size.height}" title="${attr(title)}" frameborder="0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`,
        width: size.width,
        height: size.height,
        thumbnail_url: `${named.base}/api/g/${named.token}/poster/${id}?v=${ver.v}`,
        thumbnail_width: upright ? Math.round((640 * ver.width) / ver.height) : 640,
        thumbnail_height: upright ? 640 : Math.round((640 * ver.height) / ver.width),
        // who made the player, while the workspace shows the mark (A13 CLOUD-7)
        ...(badge ? { provider_name: BRAND_NAME, provider_url: SITE_URL } : {}),
      };
    });
    res.json(out);
  });

  return r;
}
