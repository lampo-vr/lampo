// The owner's side of review links (behind the guard / sign-in): create, change and revoke links for a video or a
// folder, list the links that cover a video — or every link, including one whose video or folder is gone — and a QR
// code for handing one to someone in the room.
import express, { type Router } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { allFolders, folderIdFor, folderName } from '../../../lib/folders.ts';
import {
  allShares,
  covers,
  createShare,
  LinkRefusedError,
  listShares,
  madeFor,
  resolveShare,
  revokeShare,
  shareInfo,
  sharerName,
  updateShare,
} from '../../../lib/shares.ts';
import { FOLDER_LIMITS } from '../../../lib/store.ts';
import type { ShareInfo, SharesResponse } from '../../../lib/types.ts';
import type { ServerContext } from '../../context.ts';
import { gate } from '../../extension.ts';
import { countStep } from '../../funnel.ts';
import { lanIps } from '../../guard.ts';
import { getReview } from '../../helpers.ts';
import { body, fail, failFrom, query, router } from '../../http.ts';

/** Where the owner reaches this server from, for a link's QR code. */
const BaseQuery = z.object({ base: z.string().max(2000).optional() });

import { changed } from './access.ts';

const when = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'expected a date');
const Settings = z.object({
  label: z.string().max(200).optional(),
  comment: z.boolean().optional(),
  approve: z.boolean().optional(),
  notes: z.enum(['own', 'all']).optional(),
  versions: z.enum(['latest', 'all']).optional(),
  download: z.enum(['off', 'preview', 'original']).optional(),
  expires: when.nullable().optional(),
  password: z.string().min(4, 'at least 4 characters').max(200).nullable().optional(),
  /** An embed (lib/shares.ts embedRefusal: one video, no password). */
  embed: z.boolean().optional(),
});

/** Makes or changes a link: one the kind can't be (an embed of a folder, or with a password) is a 400 with its reason. */
function refusable<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof LinkRefusedError) throw failFrom(400, e);
    throw e;
  }
}
const NewFolderShare = Settings.extend({ folder: z.string().min(1).max(FOLDER_LIMITS.length) });
const FolderSharesQuery = z.object({ folder: z.string().max(FOLDER_LIMITS.length).optional() });

/**
 * A link as a listing shows it to whoever asks. Its token opens it to anyone holding it: a person's own browser (a
 * session, or the machine itself) gets it, since the share dialog and Settings → Review links copy, edit and revoke by
 * it; an API token doesn't — one call would hand an agent every client link of the workspace, and with one it could
 * act as the client (approve, for one), which sign-off by people forbids (A12 VB-4). A link just made keeps its token.
 */
const listedFor =
  (req: express.Request) =>
  (s: ShareInfo): ShareInfo => {
    if (req.auth?.via !== 'token') return s;
    const { token: _token, ...rest } = s;
    return rest;
  };

export function ownerShareRoutes(ctx: ServerContext): Router {
  const r = router();
  const reach = (req: express.Request): Omit<SharesResponse, 'shares'> => ({
    tunnel: ctx.tunnel.url,
    lan: ctx.lan ? lanIps().map((ip) => `http://${ip}:${ctx.cfg.port}`) : [],
    sharer: sharerName({ by: ctx.actor(req) }),
  });

  // Links that include this video: its own (made for it, not for a video removed before it under the same slug), and
  // folder links whose folder it is filed in.
  r.get('/api/review/:slug/shares', (req, res) => {
    const review = getReview(req.params.slug);
    const own = listShares(req.params.slug).filter((s) => madeFor(s, review));
    const viaFolder = listShares().filter((s) => s.folder && covers(s, review));
    const out: SharesResponse = { shares: [...own, ...viaFolder].map(shareInfo).map(listedFor(req)), ...reach(req) };
    res.json(out);
  });

  // A new link is what a read-only plan stops (server/extension.ts); existing links keep working.
  r.post(
    '/api/review/:slug/shares',
    gate(() => ctx.extension, 'share'),
    express.json(),
    (req, res) => {
      getReview(req.params.slug);
      const b = body(Settings, req);
      // Made for this video, by its id (createShare): never for one added later under the same name.
      const s = refusable(() => createShare({ slug: req.params.slug }, { ...b, by: ctx.actor(req), byId: req.auth?.user?.id }));
      changed(ctx, req.params.slug);
      countStep(ctx, 'link_first');
      res.json(shareInfo(s));
    },
  );

  // Every link of the workspace that hasn't been revoked, newest first. `gone`: its video or folder was deleted outside
  // the app — it opens nothing, and this is where it can still be found and revoked.
  r.get('/api/shares', (req, res) => {
    const out: SharesResponse = {
      shares: allShares().map(({ gone, ...s }) => ({ ...listedFor(req)(shareInfo(s)), ...(gone ? { gone } : {}) })),
      ...reach(req),
    };
    res.json(out);
  });

  r.get('/api/folder-shares', (req, res) => {
    const folder = folderName(query(FolderSharesQuery, req).folder);
    if (!folder) throw fail(400, 'which folder?');
    const out: SharesResponse = { shares: listShares({ folder }).map(shareInfo).map(listedFor(req)), ...reach(req) };
    res.json(out);
  });

  r.post(
    '/api/folder-shares',
    gate(() => ctx.extension, 'share'),
    express.json(),
    (req, res) => {
      const b = body(NewFolderShare, req);
      // A link is on a folder that exists (one from before the limits on folders made now too): nothing is made here.
      const folder = folderName(b.folder);
      if (!folder || !allFolders().includes(folder)) throw fail(404, 'no such folder');
      const { folder: _f, ...input } = b;
      // The link is on this folder by its id: wherever it moves, and never on another folder made under its name later.
      const s = refusable(() => createShare({ folder, folder_id: folderIdFor(folder) }, { ...input, by: ctx.actor(req), byId: req.auth?.user?.id }));
      ctx.broadcast('library');
      countStep(ctx, 'link_first');
      res.json(shareInfo(s));
    },
  );

  r.patch('/api/shares/:token', express.json(), (req, res) => {
    const input = body(Settings, req);
    const s = refusable(() => updateShare(req.params.token, input));
    if (!s) throw fail(404, 'no such link');
    changed(ctx, s.slug);
    res.json(shareInfo(s));
  });

  r.delete('/api/shares/:token', (req, res) => {
    const s = resolveShare(req.params.token);
    const ok = revokeShare(req.params.token);
    if (ok) changed(ctx, s?.slug);
    res.json({ ok });
  });

  // A QR code for handing a link to someone in the room (the base is wherever the owner reaches this server from).
  r.get('/api/shares/:token/qr', async (req, res) => {
    if (!resolveShare(req.params.token)) throw fail(404, 'no such link');
    let base: URL;
    try {
      base = new URL(query(BaseQuery, req).base || '');
    } catch {
      throw fail(400, 'base must be a URL');
    }
    if (!/^https?:$/.test(base.protocol)) throw fail(400, 'base must be http(s)');
    const url = `${base.origin}/g/${req.params.token}`;
    res.json({ url, svg: await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#000', light: '#fff' } }) });
  });

  return r;
}
