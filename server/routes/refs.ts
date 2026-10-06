// References on notes (lib/refs.ts): a reviewer or an agent attaches an image, a clip, a link or a moment of a render to
// a note — to the note itself (its author) or with a reply (anyone who may comment). Images and clips come inline
// (base64, up to 8 MB) or through a one-time upload URL; they are served to everyone who may watch the video.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { draftRefs, isDraftOwner } from '../../lib/drafts.ts';
import { byName, noteText, refCaption, refData, refUrl, refVideo } from '../../lib/inputs.ts';
import { can } from '../../lib/permissions.ts';
import { attachRefFile, frameRef, frameTarget, linkRef, REF_FILE, REF_LIMITS, type RefRequest, saveRefs } from '../../lib/refs.ts';
import * as store from '../../lib/store.ts';
import type { Comment, NoteRef } from '../../lib/types.ts';
import type { ServerContext } from '../context.ts';
import { gate } from '../extension.ts';
import { accountOf, getReview, isOwn } from '../helpers.ts';
import { body, commentId, fail, failFrom, parse, router, sendInternal } from '../http.ts';
import { sendMedia } from '../playback.ts';
import { issuerOf, teamGuard } from '../uploadTickets.ts';

const caption = refCaption.optional();
const note = noteText.optional();
const by = byName.nullish();
const LinkRef = z.object({ kind: z.literal('link'), url: refUrl, caption }).strict();
/** `video`: the owner's side names it by slug; a review link by the id the link gave it. */
const FrameRef = z
  .object({
    kind: z.literal('frame'),
    video: refVideo,
    v: z.number().int().positive().optional(),
    frame: z.number().int().min(0),
    to_frame: z.number().int().min(0).optional(),
    caption,
  })
  .strict();
/** A reference that comes with a new note (files follow once the note exists). */
export const InlineRefInput = z.union([LinkRef, FrameRef]);
const FileRef = z
  .object({
    /** image / clip: what it must be; file: whatever the file turns out to be. */
    kind: z.enum(['file', 'image', 'clip']),
    caption,
    /** The file, base64; without it the answer is a one-time upload URL instead. */
    data: refData.optional(),
  })
  .strict();
export const RefBody = z.union([LinkRef.extend({ note, by }), FrameRef.extend({ note, by }), FileRef.extend({ note, by })]);
const Caption = z.object({ caption: refCaption }).strict();

/** Writes an inline file to a temporary place and attaches it; the temporary copy goes either way. */
export async function attachInline(id: string, data: string, req: RefRequest & { kind?: 'image' | 'clip' }) {
  return withInlineFile(data, (file) => attachRefFile(id, file, req));
}

/** An inline file (base64) as a temporary file for `fn`; a refusal of it is a 422. */
export async function withInlineFile<T>(data: string, fn: (file: string) => Promise<T>): Promise<T> {
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length) throw fail(400, 'data is empty or not base64');
  if (bytes.length > REF_LIMITS.inlineBytes) throw fail(413, 'too big to send inline: ask for an upload URL (leave data out)');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-ref-in-'));
  try {
    const file = path.join(dir, 'ref');
    fs.writeFileSync(file, bytes);
    return await fn(file);
  } catch (e) {
    throw failFrom(422, e);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A stored reference file: clips ranged (or redirected to storage), pictures through the server (img-src 'self'). */
export async function sendRefFile(req: Request, res: Response, slug: string, file: string): Promise<void> {
  const key = store.refKey(slug, file);
  if (file.endsWith('.mp4')) return sendMedia(req, res, { key, file: null }, { immutable: true });
  const local = await store.ensureRefFile(slug, file);
  if (!local) throw fail(410, 'the reference file is gone');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  sendInternal(res, local);
}

/** The reference a file belongs to, among the given ones; null when none. */
export const refOfFile = (refs: NoteRef[], file: string): NoteRef | null =>
  REF_FILE.test(file) ? refs.find((r) => store.refFiles(r).includes(file)) || null : null;

/** A link or frame reference built and recorded on a note (the stills of a frame are grabbed first). */
export async function addInlineRef(slug: string, id: string, b: z.infer<typeof InlineRefInput>, request: RefRequest): Promise<NoteRef> {
  const ref = await inlineRef(slug, b, request);
  await saveRefs(id, slug, [ref], request);
  return ref;
}

/** A link or frame reference built (and a frame's stills stored), not recorded on anything yet. */
export async function inlineRef(slug: string, b: z.infer<typeof InlineRefInput>, request: RefRequest): Promise<NoteRef> {
  if (b.kind === 'link') return linkRef(b.url, request);
  frameTarget(b);
  return frameRef(slug, b, request);
}

export function refRoutes(ctx: ServerContext): Router {
  const r = router();
  const base = (req: Request) => ctx.cfg.public_url || `${req.protocol}://${req.get('host')}`;
  // Beyond `comment`: a note's own references are its author's (or a role that edits notes); with a reply, anyone's.
  const mayChangeNote = (req: Request, c: Comment) => isOwn(req, c.author, c.author_id) || can(req.auth?.role, 'edit-notes');
  const mayChangeRef = (req: Request, c: Comment, ref: NoteRef) => isOwn(req, ref.by, ref.by_id) || mayChangeNote(req, c);

  r.post(
    '/api/comments/:id/refs',
    gate(() => ctx.extension, 'upload'),
    express.json({ limit: '12mb' }),
    async (req, res) => {
      const id = parse(commentId, req.params.id, 'comment id');
      const hit = store.findComment(id);
      if (!hit) throw fail(404, 'no such note');
      const b = body(RefBody, req);
      const who = ctx.actor(req, b.by);
      const said = b.note?.trim() || undefined;
      if (!said && !mayChangeNote(req, hit.comment))
        throw fail(403, 'only its author can add references to this note; add yours with a reply (say what it is for)');
      const by_id = accountOf(req, who);
      const request = { caption: b.caption, by: who, by_id, note: said };
      if (b.kind === 'link' || b.kind === 'frame') {
        let ref: NoteRef;
        try {
          ref = await ctx.inflight.track(addInlineRef(hit.slug, id, b, request));
        } catch (e) {
          throw failFrom(422, e);
        }
        ctx.broadcast('review', { slug: hit.slug });
        return void res.json({ ref, comment: store.findComment(id)?.comment, slug: hit.slug });
      }
      const kind = b.kind === 'file' ? undefined : b.kind;
      if ((hit.comment.refs?.length || 0) >= store.REFS_PER_NOTE) throw fail(422, `a note carries at most ${store.REFS_PER_NOTE} references`);
      if (!b.data)
        return void res.json({
          upload: ctx.uploadTickets.issueRef(
            { comment: id, request: { caption: b.caption, note: said, kind, by_id } },
            who,
            base(req),
            teamGuard(issuerOf(req), 'comment'),
          ),
        });
      const out = await ctx.inflight.track(attachInline(id, b.data, { ...request, kind }));
      ctx.broadcast('review', { slug: out.slug });
      res.json(out);
    },
  );

  r.patch('/api/comments/:id/refs/:ref', express.json(), (req, res) => {
    const id = parse(commentId, req.params.id, 'comment id');
    const hit = store.findComment(id);
    const ref = hit?.comment.refs?.find((x) => x.id === req.params.ref);
    if (!hit || !ref) throw fail(404, 'no such reference');
    if (!mayChangeRef(req, hit.comment, ref)) throw fail(403, 'only who added it (or the author of the note) can change this reference');
    const comment = store.setRefCaption(id, ref.id, body(Caption, req).caption, ctx.actor(req));
    ctx.broadcast('review', { slug: hit.slug });
    res.json(comment);
  });

  r.delete('/api/comments/:id/refs/:ref', (req, res) => {
    const id = parse(commentId, req.params.id, 'comment id');
    const hit = store.findComment(id);
    const ref = hit?.comment.refs?.find((x) => x.id === req.params.ref);
    if (!hit || !ref) throw fail(404, 'no such reference');
    if (!mayChangeRef(req, hit.comment, ref)) throw fail(403, 'only who added it (or the author of the note) can remove this reference');
    const comment = store.removeRef(id, ref.id, ctx.actor(req));
    ctx.broadcast('review', { slug: hit.slug });
    res.json(comment);
  });

  r.get('/api/refs/:slug/:file', async (req, res) => {
    const { slug, file } = req.params;
    const review = getReview(slug);
    // A note's, or one on a draft of the person asking (lib/drafts.ts: in the app, never with a token).
    const drafts = req.auth?.via !== 'token' && isDraftOwner(req.auth?.user?.id) ? draftRefs(slug, req.auth.user.id) : [];
    if (!refOfFile([...review.comments.flatMap((c) => c.refs || []), ...drafts], file)) throw fail(404, 'not found');
    await sendRefFile(req, res, slug, file);
  });

  return r;
}
