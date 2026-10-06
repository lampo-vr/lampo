// Fix previews (lib/previews.ts): an agent attaches a still or a short clip of a fix to a note — inline (base64, up to
// 8 MB) or through a one-time upload URL — and records where a render was made (Version.source). The files are
// served to everyone who may watch the video.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { type Router } from 'express';
import { z } from 'zod';
import { byName, noteText, previewData, projectFps, projectTime, sourceName, startFrame } from '../../lib/inputs.ts';
import { attachPreview, PREVIEW_LIMITS } from '../../lib/previews.ts';
import * as store from '../../lib/store.ts';
import type { ServerContext } from '../context.ts';
import { gate } from '../extension.ts';
import { finalLock, getReview, getVersion } from '../helpers.ts';
import { body, commentId, fail, failFrom, HttpError, parse, router, sendInternal } from '../http.ts';
import { sendMedia } from '../playback.ts';
import { issuerOf, teamGuard } from '../uploadTickets.ts';

const PREVIEW_FILE = /^p_[a-f0-9]{10}\.(png|jpg|webp|mp4)$/;

export const PreviewSource = z.object({ app: sourceName, project: sourceName.optional(), comp: sourceName.optional(), time: projectTime.optional() }).strict();
export const RenderSourceBody = z
  .object({
    app: sourceName,
    project: sourceName.optional(),
    comp: sourceName.optional(),
    start_frame: startFrame.optional(),
    fps: projectFps.optional(),
  })
  .strict();

const NewPreview = z.object({
  kind: z.enum(['still', 'clip']).default('still'),
  frame: z.number().int().min(0).optional(),
  source: PreviewSource.optional(),
  fixed: z.boolean().optional(),
  note: noteText.optional(),
  /** The file, base64; without it the answer is a one-time upload URL instead. */
  data: previewData.optional(),
  by: byName.nullish(),
});

export function previewRoutes(ctx: ServerContext): Router {
  const r = router();
  const base = (req: express.Request) => ctx.cfg.public_url || `${req.protocol}://${req.get('host')}`;

  r.post(
    '/api/comments/:id/previews',
    gate(() => ctx.extension, 'upload'),
    express.json({ limit: '12mb' }),
    async (req, res) => {
      const id = parse(commentId, req.params.id, 'comment id');
      const hit = store.findComment(id);
      if (!hit) throw fail(404, 'no such note');
      const { data, by, ...request } = body(NewPreview, req);
      if (request.fixed) finalLock(req, hit.review);
      const who = ctx.actor(req, by);
      if (!data) {
        try {
          return void res.json({ upload: ctx.uploadTickets.issuePreview({ comment: id, request }, who, base(req), teamGuard(issuerOf(req), 'resolve')) });
        } catch (e) {
          if (e instanceof HttpError) throw e; // the ticket store's own answer (429: too many open)
          throw failFrom(400, e);
        }
      }
      const bytes = Buffer.from(data, 'base64');
      if (!bytes.length) throw fail(400, 'data is empty or not base64');
      if (bytes.length > PREVIEW_LIMITS.inlineBytes) throw fail(413, 'too big to send inline: ask for an upload URL (leave data out)');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-preview-in-'));
      try {
        const file = path.join(dir, 'preview');
        fs.writeFileSync(file, bytes);
        const out = await ctx.inflight.track(attachPreview(id, file, { ...request, by: who }));
        ctx.broadcast('review', { slug: out.slug });
        res.json(out);
      } catch (e) {
        throw failFrom(422, e);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  r.get('/api/previews/:slug/:file', async (req, res) => {
    const { slug, file } = req.params;
    const review = getReview(slug);
    const p = PREVIEW_FILE.test(file) ? review.comments.flatMap((c) => c.previews || []).find((x) => x.file === file) : null;
    if (!p) throw fail(404, 'not found');
    const key = store.previewKey(slug, file);
    if (p.kind === 'clip') return sendMedia(req, res, { key, file: null }, { immutable: true });
    // Stills go through the server (the page's img-src is 'self'): cached as a working copy with remote storage.
    const local = await store.ensurePreviewFile(slug, file);
    if (!local) throw fail(410, 'the preview file is gone');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    sendInternal(res, local);
  });

  r.put('/api/review/:slug/versions/:v/source', express.json(), (req, res) => {
    const review = getReview(req.params.slug);
    const ver = getVersion(review, req.params.v);
    const source = req.body && Object.keys(req.body).length ? body(RenderSourceBody, req) : null;
    const out = store.setVersionSource(req.params.slug, ver.v, source, ctx.actor(req));
    ctx.broadcast('review', { slug: req.params.slug });
    res.json(out);
  });

  return r;
}
