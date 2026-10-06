// "Download all": a folder as one zip. Guests on a folder link get it when the link offers downloads ('preview' = the
// browser-playable files, 'original' = the rendered bytes); the team gets it from the library ('download' action).
// The archive streams straight from the files (bounded memory, no temp copy), with its exact length up front. Once
// every CRC is cached it is deterministic: ETag + ranges, so a download that breaks off resumes (If-Range).
import path from 'node:path';
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import {
  type Archive,
  type ArchiveKind,
  type ArchiveListing,
  archiveItems,
  archiveName,
  buildArchive,
  isResumable,
  listingBytes,
  listingPin,
  prepareCrcs,
} from '../../lib/archive.ts';
import { folderName, shownFolders } from '../../lib/folders.ts';
import { Recent } from '../../lib/rateLimit.ts';
import { currentWorkspace, inWorkspace, WORKSPACE_ID, wsKey } from '../../lib/scope.ts';
import { guestName, isExpired, recordDownload, resolveShare, reviewsOf, settingsOf, shareId } from '../../lib/shares.ts';
import { SIGNED_URL_SECONDS } from '../../lib/storage/index.ts';
import { mediaArchiveUrl, openMedia } from '../../lib/storage/mediaHost.ts';
import * as store from '../../lib/store.ts';
import type { ArchiveInfo, Review, ShareWithToken, Version } from '../../lib/types.ts';
import type { ServerContext } from '../context.ts';
import { mediaHostOf, requestHost } from '../guard.ts';
import { attachment, fail, query, router } from '../http.ts';
import { issuerOf, issuerStill } from '../uploadTickets.ts';
import { ipOf, keptInMemory, open } from './shares/access.ts';

const Kind = z.enum(['preview', 'original']).optional();
const GuestQuery = z.object({ kind: Kind, name: z.string().max(200).optional() });
const TeamQuery = z.object({ folder: z.string().min(1).max(store.FOLDER_LIMITS.length), kind: Kind });
/** Who asked for a team's zip (server/uploadTickets.ts TicketIssuer): identified again when the zip is fetched. */
const ArchiveIssuer = z.object({
  via: z.enum(['local', 'lan', 'cookie', 'token', 'oauth']),
  user: z.string().max(200),
  ws: z.string().regex(WORKSPACE_ID),
  token: z.string().max(200).optional(),
  session: z.string().max(4096).optional(),
  grant: z.string().max(200).optional(),
  scopes: z.array(z.string().max(200)).max(50).readonly().optional(),
});
/**
 * What a folder's zip on the media host is (sealed into its URL, lib/storage/mediaHost.ts): the workspace, the kind,
 * and the review link with the visitor's name (checked again when the zip starts) or the team's folder with who asked
 * for it (`i`, asked again when the zip starts: a member removed, a token revoked or a session signed out since gets
 * nothing) and what the folder held then (`p`, listingPin: the zip never grows past what they could download).
 */
const ArchiveClaims = z.object({
  w: z.string().regex(WORKSPACE_ID),
  k: z.enum(['preview', 'original']),
  l: z.string().max(64).optional(),
  g: z.string().max(200).optional(),
  f: z.string().max(store.FOLDER_LIMITS.length).optional(),
  i: ArchiveIssuer.optional(),
  p: z.string().max(64).optional(),
});
type ArchiveClaims = z.infer<typeof ArchiveClaims>;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const gb = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);

export function downloadRoutes(ctx: ServerContext): Router {
  const r = router();
  // With the app's own media host (VR_MEDIA_ORIGIN) a zip — video, and often gigabytes — is streamed from there, never
  // through a front of the app host that must not carry video: the route checks who asks and redirects to a signed URL.
  const mediaOrigin = ctx.hosted ? ctx.cfg.media_origin : null;
  const mediaHost = mediaHostOf(mediaOrigin);
  function toMediaHost(res: Response, listing: ArchiveListing, claims: ArchiveClaims, filename: string, seconds: number): void {
    archiveReady(listing);
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, mediaArchiveUrl(mediaOrigin as string, claims, filename, seconds));
  }
  // Concurrent archives: a phone retrying in a loop or a script can't tie up the disk. Per visitor, and per link.
  const active = new Map<string, number>();
  // One "downloaded" per download: resumed ranges and retries within half an hour don't count again. Keyed by what
  // visitors send (an address): the latest 10,000.
  const counted = new Recent<number>();
  keptInMemory(ctx, { archives: counted });

  // A copy, never the render's own bytes (what a link's player plays too): made on demand, listed as preparing till then.
  const preview = (review: Review, ver: Version) => {
    const p = ctx.playback.preview(review, ver);
    return p.ready && p.main ? p.main : null;
  };

  // ---------------------------------------------------------------- guests

  // The same answers as the rest of the link's routes (invalid, expired, locked), and only for folder links.
  function openLink(req: Request<{ token: string }>): ShareWithToken & { folder: string } {
    const share = open(req);
    if (!share.folder) throw fail(404, 'Only folder links have "Download all".');
    return share as ShareWithToken & { folder: string };
  }

  function guestKind(share: ShareWithToken, asked: ArchiveKind | undefined): ArchiveKind {
    const allowed = settingsOf(share).download;
    if (allowed === 'off') throw fail(403, 'This link does not offer downloads.');
    if (asked === 'original' && allowed !== 'original') throw fail(403, 'This link offers previews only.');
    return asked || (allowed === 'original' ? 'original' : 'preview');
  }

  // Scope is checked here, on every request: only what the folder link covers today (not archived, filed inside).
  const guestListing = (share: ShareWithToken & { folder: string }, kind: ArchiveKind) =>
    archiveItems(
      reviewsOf(share).filter((rv) => rv.versions.length),
      { root: share.folder, kind, preview },
    );

  const info = (listing: ArchiveListing, kind: ArchiveKind, url: string): ArchiveInfo => ({
    kind,
    url,
    files: listing.items.length,
    bytes: listingBytes(listing),
    preparing: listing.preparing.length,
    missing: listing.missing.length,
    resumable: isResumable(listing),
  });

  r.get('/api/g/:token/archive/info', (req, res) => {
    const share = openLink(req);
    const kind = guestKind(share, query(GuestQuery, req).kind);
    const listing = guestListing(share, kind);
    // Looking at the room is the moment to get the checksums ready, so "Download all" can resume.
    prepareCrcs(listing);
    res.setHeader('Cache-Control', 'no-store');
    res.json(info(listing, kind, `/api/g/${share.token}/archive?kind=${kind}`));
  });

  r.get('/api/g/:token/archive', async (req, res) => {
    const share = openLink(req);
    const q = query(GuestQuery, req);
    const kind = guestKind(share, q.kind);
    const name = guestName(q.name);
    if (mediaOrigin)
      return toMediaHost(
        res,
        guestListing(share, kind),
        { w: currentWorkspace(), k: kind, l: share.token, g: name },
        archiveName(share.folder),
        SIGNED_URL_SECONDS.guest,
      );
    await sendGuestArchive(req, res, share, kind, name);
  });

  async function sendGuestArchive(req: Request, res: Response, share: ShareWithToken & { folder: string }, kind: ArchiveKind, name: string) {
    await sendArchive(req, res, guestListing(share, kind), {
      filename: archiveName(share.folder),
      slots: [`${share.token}|${ipOf(req)}`, share.token],
      onStart: (a) => {
        const what = `all ${plural(a.files, 'video')}`;
        recordDownload(share.token, { name, what, files: a.files, bytes: a.bytes, kind });
        store.logFolderEvent({
          type: 'download',
          by: `guest:${name}`,
          folder: share.folder,
          text: `downloaded ${what} of ${share.folder} (${gb(a.bytes)}, ${kind === 'original' ? 'originals' : 'previews'})`,
          share: shareId(share),
          files: a.files,
          bytes: a.bytes,
        });
      },
    });
  }

  // ---------------------------------------------------------------- the team

  function teamListing(folder: string, kind: ArchiveKind): ArchiveListing {
    const reviews = store
      .listReviews()
      .filter((rv) => !rv.archived && rv.versions.length && !!rv.folder && (rv.folder === folder || rv.folder.startsWith(`${folder}/`)));
    return archiveItems(reviews, { root: folder, kind, preview });
  }
  function teamFolder(req: Request): { folder: string; kind: ArchiveKind } {
    const q = query(TeamQuery, req);
    // A folder that exists, however it was named (one from before the limits on folders made now downloads too).
    const folder = folderName(q.folder);
    if (!folder || !shownFolders().folders.includes(folder)) throw fail(404, 'no such folder');
    return { folder, kind: q.kind || 'original' };
  }

  r.get('/api/folders/download/info', (req, res) => {
    const { folder, kind } = teamFolder(req);
    const listing = teamListing(folder, kind);
    prepareCrcs(listing);
    res.json(info(listing, kind, `/api/folders/download?folder=${encodeURIComponent(folder)}&kind=${kind}`));
  });

  r.get('/api/folders/download', async (req, res) => {
    const { folder, kind } = teamFolder(req);
    const listing = teamListing(folder, kind);
    if (mediaOrigin) {
      const issuer = issuerOf(req);
      if (!issuer) throw fail(401, 'please sign in');
      const claims: ArchiveClaims = { w: currentWorkspace(), k: kind, f: folder, i: issuer, p: listingPin(listing) };
      return toMediaHost(res, listing, claims, archiveName(folder), SIGNED_URL_SECONDS.team);
    }
    await sendTeamArchive(req, res, folder, listing);
  });
  const sendTeamArchive = (req: Request, res: Response, folder: string, listing: ArchiveListing) =>
    sendArchive(req, res, listing, { filename: archiveName(folder), slots: [wsKey(`team|${ipOf(req)}`)] });

  // ---------------------------------------------------------------- on the media host

  // The zip a redirect above sealed into its URL, in the workspace it names. A review link is asked again here (revoked,
  // expired, no longer a folder link or offering this kind: refused); its password was checked by the redirect, which
  // is as long ago as the URL lives (SIGNED_URL_SECONDS.guest). The team's URL lives hours: whoever asked for it is
  // identified again (`issuerStill`, as for an upload URL) and the folder must hold what it held then (`p`) — a URL
  // from before either was sealed in is refused, and the browser asks the app host again. A zip already streaming runs
  // on, like any download.
  r.get('/media/z/:sealed/:name', async (req, res) => {
    if (!mediaHost || requestHost(req) !== mediaHost) throw fail(404, 'not found');
    const sealed = openMedia<{ z?: unknown; n?: unknown }>(req.params.sealed);
    const claims = ArchiveClaims.safeParse(sealed?.z).data;
    if (!claims || typeof sealed?.n !== 'string') throw fail(403, 'this download link has expired: start the download again');
    await inWorkspace(claims.w, async () => {
      if (claims.l !== undefined) {
        const share = resolveShare(claims.l);
        if (!share?.folder) throw fail(404, 'This review link is not valid any more.');
        if (isExpired(share)) throw fail(410, 'This review link has expired.');
        await sendGuestArchive(req, res, share as ShareWithToken & { folder: string }, guestKind(share, claims.k), guestName(claims.g));
        return;
      }
      if (!claims.i || claims.p === undefined) throw fail(403, 'this download link has expired: start the download again');
      if (claims.i.ws !== claims.w || !issuerStill(claims.i, 'download'))
        throw fail(403, 'whoever asked for this download may no longer download here: start the download again');
      const folder = claims.f === undefined ? null : folderName(claims.f);
      if (!folder || !shownFolders().folders.includes(folder)) throw fail(404, 'no such folder');
      const listing = teamListing(folder, claims.k);
      if (listingPin(listing) !== claims.p) throw fail(409, 'this folder changed since the download was asked for: start the download again');
      await sendTeamArchive(req, res, folder, listing);
    });
  });

  // ---------------------------------------------------------------- the archive response

  async function sendArchive(
    req: Request,
    res: Response,
    listing: ArchiveListing,
    { filename, slots, onStart }: { filename: string; slots: string[]; onStart?: (a: Archive) => void },
  ): Promise<void> {
    archiveReady(listing);
    const limits = [2, 6];
    slots.forEach((key, i) => {
      if ((active.get(key) || 0) >= (limits[i] ?? 6))
        throw Object.assign(fail(429, 'Another download of this folder is still running. Please wait for it to finish.'), { retryAfter: 10 });
    });

    const archive = await buildArchive(listing);
    const { plan, etag } = archive;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', attachment(filename));
    res.setHeader('Cache-Control', 'private, no-cache');
    let start = 0;
    let end = plan.length - 1;
    if (etag) {
      res.setHeader('ETag', etag);
      res.setHeader('Accept-Ranges', 'bytes');
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
      const ifRange = req.headers['if-range'];
      if (m && (!ifRange || ifRange === etag)) {
        if (m[1] === '' && m[2] === '') throw fail(416, 'bad range');
        start = m[1] === '' ? Math.max(0, plan.length - Number(m[2])) : Number(m[1]);
        end = m[1] !== '' && m[2] !== '' ? Math.min(Number(m[2]), plan.length - 1) : plan.length - 1;
        if (start > end || start >= plan.length) {
          res.status(416).setHeader('Content-Range', `bytes */${plan.length}`);
          res.end();
          return;
        }
        res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${plan.length}`);
      }
    } else res.setHeader('Accept-Ranges', 'none');
    res.setHeader('Content-Length', end - start + 1);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    // Counted when a download starts from the first byte, once per visitor and archive within half an hour.
    if (start === 0 && onStart) {
      const key = `${slots[0]}|${etag || `${archive.files}:${plan.length}`}`;
      const last = counted.get(key) || 0;
      if (Date.now() - last > 30 * 60_000) {
        counted.set(key, Date.now());
        onStart(archive);
      }
    }

    for (const key of slots) active.set(key, (active.get(key) || 0) + 1);
    let closed = false;
    const onClose = () => {
      closed = true;
    };
    res.on('close', onClose);
    try {
      for await (const chunk of plan.bytes({ start, end })) {
        if (closed) break;
        if (!res.write(chunk))
          await new Promise<void>((resolve) => {
            const done = () => {
              res.off('drain', done);
              res.off('close', done);
              resolve();
            };
            res.on('drain', done);
            res.on('close', done);
          });
      }
      if (!closed) res.end();
    } catch (e) {
      // Headers and bytes are out: all that's left is to break the connection, so the client sees a failed download
      // (its length won't match) rather than a zip that ends early.
      console.error('archive failed', (e as Error).message, path.basename(filename));
      res.destroy(e as Error);
    } finally {
      res.off('close', onClose);
      for (const key of slots) {
        const n = (active.get(key) || 1) - 1;
        if (n) active.set(key, n);
        else active.delete(key);
      }
    }
  }

  return r;
}

/** A listing that can go out as a zip now: nothing still being prepared (425), something in it (404). */
function archiveReady(listing: ArchiveListing): void {
  if (listing.preparing.length)
    throw fail(425, `${plural(listing.preparing.length, 'preview')} still being prepared (${listing.preparing.join(', ')}). Try again in a minute.`);
  if (!listing.items.length) throw fail(404, 'Nothing to download in this folder yet.');
}
