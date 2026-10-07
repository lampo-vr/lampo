// What a review link plays and hands out (/media/g/…, /api/g/…/waveform|poster|sprite|download, /data/g/…): only
// for the videos and versions the link covers, screenshots only of the notes it shows, downloads only when it offers
// them. A folder's "Download all" is in ../downloads.ts.
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { poster, waveform } from '../../../lib/media.ts';
import { reviewDir, slugify } from '../../../lib/paths.ts';
import { Recent } from '../../../lib/rateLimit.ts';
import { guestName, noteShotShown, recordDownload, settingsOf, shareId, visibleNotes } from '../../../lib/shares.ts';
import { SIGNED_URL_SECONDS } from '../../../lib/storage/index.ts';
import * as store from '../../../lib/store.ts';
import type { Version } from '../../../lib/types.ts';
import type { ServerContext } from '../../context.ts';
import { sendSprite, versionBytes } from '../../helpers.ts';
import { fail, query, router, sendInternal, VersionQuery } from '../../http.ts';
import { type Playable, type Source, sendDownload, sendMedia, versionOriginal } from '../../playback.ts';

/** A download through a link: which file (the original, else the copy made for playing) and the name typed on the page. */
const DownloadQuery = z.object({ kind: z.enum(['preview', 'original']).optional(), name: z.string().max(200).optional() });

import { ipOf, keptInMemory, open, target, version } from './access.ts';

export function guestMediaRoutes(ctx: ServerContext): Router {
  const r = router();
  const { playback } = ctx;
  // Keyed by address, link, video and version: the latest 10,000 downloads, so made-up addresses can't grow it.
  const downloads = new Recent<number>();
  keptInMemory(ctx, { downloads });

  // The render's own bytes only stream through links that offer them as a download anyway; every other link plays
  // the copy its "Preview" download is, so the player can't be used to save the original.
  async function media(req: Request<{ token: string }>, res: Response, id: string | undefined, v: unknown) {
    const share = open(req);
    const review = target(share, id);
    const ver = version(share, review, v);
    const originals = settingsOf(share).download === 'original';
    const p = originals ? playback.playable(review, ver, { build: true }) : playback.preview(review, ver);
    if (!p.ready || !p.main) throw notYet(p);
    const src = originals ? playback.served(p, req) : p.main;
    await sendMedia(req, res, src, { immutable: src.file !== review.video });
  }
  r.get('/media/g/:token/:slug/v:v', (req, res) => media(req, res, req.params.slug, req.params.v));
  // Links from before folder links: /media/g/<token>/v<n>.
  r.get('/media/g/:token/v:v', (req, res) => media(req, res, undefined, req.params.v));

  async function wave(req: Request<{ token: string }>, res: Response, id: string | undefined) {
    const share = open(req);
    const review = target(share, id);
    const ver = version(share, review, query(VersionQuery, req).v);
    res.json(await waveform(() => versionBytes(review, ver), ver));
  }
  r.get('/api/g/:token/waveform/:slug', (req, res) => wave(req, res, req.params.slug));
  r.get('/api/g/:token/waveform', (req, res) => wave(req, res, undefined));

  r.get('/api/g/:token/poster/:slug', async (req, res) => {
    const share = open(req);
    const review = target(share, req.params.slug);
    const ver = review.versions.at(-1) as Version;
    const out = await poster(() => versionBytes(review, ver), ver, review.meta);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    // An embed's poster is its oEmbed thumbnail: other sites show it as an <img>. Only that picture may leave the app's
    // own pages; every other answer of a link stays same-origin (server/guard.ts).
    if (share.embed) res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    sendInternal(res, out);
  });

  // The newest render's hover-scrub sprite for the room's cards: the same videos the link's posters cover.
  r.get('/api/g/:token/sprite/:slug', (req, res) => {
    const share = open(req);
    sendSprite(res, ctx.background.startSprite(target(share, req.params.slug)));
  });

  // Screenshots of the notes the link shows, nothing else from the review's folder: the marked one, of a version the
  // link shows (noteShotShown).
  function shot(req: Request<{ token: string }>, res: Response, id: string | undefined, file: string) {
    const share = open(req);
    const review = target(share, id);
    const allowed = new Set(
      visibleNotes(share, review)
        .filter((c) => noteShotShown(share, review, c))
        .flatMap((c) => (c.shots?.marked ? [c.shots.marked] : [])),
    );
    if (!allowed.has(file)) throw fail(404, 'not found');
    sendInternal(res, path.join(reviewDir(slugify(review.video)), file));
  }
  r.get('/data/g/:token/:slug/:file', (req, res) => shot(req, res, req.params.slug, req.params.file));
  r.get('/data/g/:token/:file', (req, res) => shot(req, res, undefined, req.params.file));

  r.get('/api/g/:token/download/:slug/v:v', async (req, res) => {
    const share = open(req);
    const allowed = settingsOf(share).download;
    const q = query(DownloadQuery, req);
    const kind = q.kind === 'original' ? 'original' : 'preview';
    if (allowed === 'off' || (kind === 'original' && allowed !== 'original')) throw fail(403, 'This link does not offer downloads.');
    const review = target(share, req.params.slug);
    const ver = version(share, review, req.params.v);
    const slug = slugify(review.video);
    const base = path.basename(review.video, path.extname(review.video)).replace(/[^\p{L}\p{N} ._-]/gu, '_');
    let src: Source;
    let ext: string;
    if (kind === 'original') {
      if (!store.versionAvailable(review, ver.v)) throw fail(410, 'the bytes of this version are gone');
      ext = path.extname(review.video) || '.mp4';
      src = versionOriginal(review, ver);
    } else {
      const p = playback.preview(review, ver);
      if (!p.ready || !p.main) throw notYet(p, 'The preview is still being prepared. Try again in a minute.');
      src = p.main;
      ext = path.extname(src.key) || '.mp4';
    }
    const filename = `${base}-v${ver.v}${kind === 'preview' ? '-preview' : ''}${ext}`;
    // Counted when a download starts from the first byte (a resumed range isn't a new download), once per visitor,
    // file and half hour, so retries don't inflate it.
    const first = !/^bytes=[1-9]/.test(String(req.headers.range || ''));
    const key = `${share.token}|${ipOf(req)}|${slug}|${ver.v}|${kind}`;
    if (first && Date.now() - (downloads.get(key) || 0) > 30 * 60_000) {
      downloads.set(key, Date.now());
      const name = guestName(q.name);
      const bytes = src.file && fs.existsSync(src.file) ? fs.statSync(src.file).size : ver.size || 0;
      recordDownload(share.token, { name, what: filename, files: 1, bytes, kind });
      store.logEvent({ type: 'download', by: `guest:${name}`, review, v: ver.v, text: `downloaded ${filename}`, share: shareId(share), files: 1, bytes });
    }
    // minutes: asking again goes through the link, which is checked again
    await sendDownload(req, res, src, filename, SIGNED_URL_SECONDS.guest);
  });

  return r;
}

/** A copy still being made: 425 and when to ask again; one that can't be made (or bytes that are gone): 410. */
function notYet(p: Playable, message = 'preparing'): Error {
  return p.preparing ? Object.assign(fail(425, message), { retryAfter: 5 }) : fail(410, p.error || 'This version cannot be played.');
}
