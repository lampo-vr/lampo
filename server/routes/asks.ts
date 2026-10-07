// Questions with options (lib/options.ts, lib/askOptions.ts): an agent offers voices, music or looks before it spends a
// render — on a video (a note about the whole of it) or, before any render exists, on a project or folder
// (lib/asks.ts). The person auditions them (the files below) and picks; the picks are an ordinary answer.
//   POST   /api/asks                 ask (files inline up to 8 MB each, else one upload URL per item)
//   GET    /api/asks                 the questions waiting on folders (the library's strip)
//   GET    /api/asks/:id             one, as the audition reads it (AskView)
//   POST   /api/asks/:id/answer      the picks and the person's words
//   POST   /api/asks/:id/close       done without an answer
//   DELETE /api/asks/:id             gone, with its files (its author, or a role that edits notes)
//   GET    /api/asks/:id/files/:f    an item's picture, clip or sound
// Never on review links: clients don't see these (ROADMAP: options through a link, votes by several people).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { type Request, type Router } from 'express';
import { z } from 'zod';
import { askFileKey, askView, type ItemSource, makeAsk } from '../../lib/askOptions.ts';
import { answerAsk, asksIn, closeAsk, findAsk, removeAsk, shownAsks } from '../../lib/asks.ts';
import { askPrompt, askText, optionId, optionLabel, refData, refUrl, refVideo } from '../../lib/inputs.ts';
import { OPTION_LIMITS } from '../../lib/options.ts';
import { can, canSetStatus } from '../../lib/permissions.ts';
import { statusOf } from '../../lib/publicError.ts';
import { OPTION_FILE, REF_LIMITS } from '../../lib/refs.ts';
import { storage } from '../../lib/storage/index.ts';
import * as store from '../../lib/store.ts';
import type { AskCreated, AsksResponse, OptionGroup } from '../../lib/types.ts';
import type { ServerContext } from '../context.ts';
import { gate } from '../extension.ts';
import { accountOf, isOwn } from '../helpers.ts';
import { body, commentId, fail, failFrom, parse, router, sendInternal } from '../http.ts';
import { sendMedia } from '../playback.ts';
import { issuerOf, teamGuard } from '../uploadTickets.ts';

const id = optionId;
const label = optionLabel.optional();
const by = z.string().max(100).nullish();
/** An item's file: a link, a moment of a render in the library, or a file (inline, else an upload URL comes back). */
const ItemRef = z.union([
  z.object({ kind: z.literal('link'), url: refUrl }).strict(),
  z
    .object({
      kind: z.literal('frame'),
      video: refVideo,
      v: z.number().int().positive().optional(),
      frame: z.number().int().min(0),
      to_frame: z.number().int().min(0).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('file'),
      data: refData.optional(),
    })
    .strict(),
]);
const Item = z.object({ id, label, ref: ItemRef.optional() }).strict();
const Group = z.object({ id, label, pick: z.enum(['one', 'many']).optional(), items: z.array(Item).min(2).max(OPTION_LIMITS.items) }).strict();
export const NewAsk = z
  .object({
    /** A video (slug) — or `folder`, before any render. */
    video: refVideo.optional(),
    folder: z.string().min(1).max(store.FOLDER_LIMITS.length).optional(),
    text: askText,
    options: z.array(Group).min(1).max(OPTION_LIMITS.groups),
    answer_prompt: askPrompt.optional(),
    by,
  })
  .strict();
const Answer = z
  .object({
    picks: z.record(id, z.array(id).max(OPTION_LIMITS.items)).refine((p) => Object.keys(p).length <= OPTION_LIMITS.groups, 'too many groups'),
    note: z.string().max(OPTION_LIMITS.note).optional(),
    by,
  })
  .strict();
const Close = z.object({ by }).strict();

export function askRoutes(ctx: ServerContext): Router {
  const r = router();
  const base = (req: Request) => ctx.cfg.public_url || `${req.protocol}://${req.get('host')}`;
  const told = (slug: string | null) => {
    if (slug) {
      ctx.broadcast('review', { slug });
      ctx.broadcast('library', { slug });
    } else ctx.broadcast('asks', {});
  };
  const askId = (req: Request) => parse(commentId, req.params.id, 'question id');
  /** Answering is a reviewer's side, like closing a question in the inbox (a status of `verified`). */
  const mayAnswer = (req: Request) => {
    if (!canSetStatus(req.auth?.role, 'verified')) throw fail(403, `your role (${req.auth?.role}) can't answer questions`);
  };

  r.post(
    '/api/asks',
    gate(() => ctx.extension, 'upload'),
    express.json({ limit: '26mb' }),
    async (req, res) => {
      const b = body(NewAsk, req);
      if (!b.video === !b.folder) throw fail(400, 'name the video, or the project or folder it is for (not both)');
      if (b.video && !store.loadReview(b.video)) throw fail(404, 'unknown video');
      const author = ctx.actor(req, b.by);
      const author_id = accountOf(req, author);
      // Inline files go to a scratch folder for as long as the question is made; the rest come through upload URLs.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-ask-'));
      const sources: Record<string, ItemSource> = {};
      const later: [string, string][] = [];
      try {
        let n = 0;
        for (const g of b.options)
          for (const it of g.items) {
            const key = `${g.id}/${it.id}`;
            const ref = it.ref;
            if (!ref) continue;
            if (ref.kind === 'link') sources[key] = { url: ref.url };
            else if (ref.kind === 'frame') sources[key] = { frame: { video: ref.video, v: ref.v, frame: ref.frame, to_frame: ref.to_frame } };
            else if (ref.data) {
              const bytes = Buffer.from(ref.data, 'base64');
              if (!bytes.length) throw fail(400, `${key}: data is empty or not base64`);
              if (bytes.length > REF_LIMITS.inlineBytes) throw fail(413, `${key}: too big to send inline; leave data out for an upload URL`);
              const file = path.join(dir, `item-${n++}`);
              fs.writeFileSync(file, bytes);
              sources[key] = { file };
            } else later.push([g.id, it.id]);
          }
        // Upload URLs come before the question is written (makeAsk's `mint`): one refused leaves nothing behind.
        const uploads: AskCreated['uploads'] = {};
        const mint = (id: string, offered: OptionGroup[]) => {
          for (const [group, item] of later)
            uploads[`${group}/${item}`] = ctx.uploadTickets.issueOption(
              { ask: id, group, item, request: { ...(author_id ? { by_id: author_id } : {}) } },
              author,
              base(req),
              teamGuard(issuerOf(req), 'comment'),
              offered,
            );
        };
        let made: Awaited<ReturnType<typeof makeAsk>>;
        try {
          made = await ctx.inflight.track(
            makeAsk({
              slug: b.video ?? null,
              folder: b.folder ?? null,
              makeFolder: can(req.auth?.role, 'organize'),
              text: b.text,
              groups: b.options,
              sources,
              answer_prompt: b.answer_prompt,
              author,
              author_id,
              mint,
            }),
          );
        } catch (e) {
          for (const t of Object.values(uploads)) ctx.uploadTickets.drop(t.url);
          // A failure that says whose it is keeps its status (a store's refusal: the server's, 500; a full job queue: 503
          // and when to try again; too many upload URLs open: 429); the rest was the caller's file or words (422). Either
          // way by audience (lib/publicError.ts).
          // A folder past the limits is the request's mistake like any bad field.
          if (e instanceof store.FolderLimitError) throw failFrom(400, e);
          throw statusOf(e, 0) ? e : failFrom(422, e);
        }
        told(made.slug);
        const out: AskCreated = { id: made.id, slug: made.slug, folder: made.folder, uploads };
        res.json(out);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  r.get('/api/asks', (_req, res) => {
    const out: AsksResponse = { asks: asksIn(null, shownAsks()) };
    res.json(out);
  });

  r.get('/api/asks/:id', (req, res) => {
    const view = askView(askId(req));
    if (!view) throw fail(404, 'no such question');
    res.json(view);
  });

  r.post('/api/asks/:id/answer', express.json({ limit: '64kb' }), (req, res) => {
    const qid = askId(req);
    const b = body(Answer, req);
    mayAnswer(req);
    const by = ctx.actor(req, b.by);
    const answer = { picks: b.picks, ...(b.note ? { note: b.note } : {}) };
    const hit = store.findComment(qid);
    try {
      if (hit) {
        if (!hit.comment.options?.length) throw fail(404, 'no such question');
        store.updateComment(qid, { answer, by });
      } else if (findAsk(qid)) answerAsk(qid, answer, by);
      else throw fail(404, 'no such question');
    } catch (e) {
      if ((e as { status?: number }).status) throw e;
      throw failFrom(400, e);
    }
    told(hit?.slug ?? null);
    // the agent that asked goes on (its run works again), or the answer opens its follow-up (server/runs.ts)
    if (hit) ctx.runs.answered(req, hit.slug, qid, true);
    else {
      const ask = findAsk(qid);
      if (ask) ctx.runs.answeredFolder(ask.folder, qid);
    }
    res.json(askView(qid));
  });

  r.post('/api/asks/:id/close', express.json(), (req, res) => {
    const qid = askId(req);
    const b = body(Close, req);
    mayAnswer(req);
    const by = ctx.actor(req, b.by);
    const hit = store.findComment(qid);
    if (hit?.comment.options?.length) store.updateComment(qid, { status: 'verified', by });
    else if (!hit && findAsk(qid)) closeAsk(qid, by);
    else throw fail(404, 'no such question');
    told(hit?.slug ?? null);
    res.json(askView(qid));
  });

  r.delete('/api/asks/:id', (req, res) => {
    const qid = askId(req);
    const hit = store.findComment(qid);
    const ask = hit ? null : findAsk(qid);
    const who = hit ? hit.comment : ask;
    if (!who || (hit && !hit.comment.options?.length)) throw fail(404, 'no such question');
    if (!isOwn(req, who.author, who.author_id) && !can(req.auth?.role, 'edit-notes')) throw fail(403, 'only who asked it can delete this question');
    if (hit) store.deleteComment(qid, ctx.actor(req));
    else removeAsk(qid, ctx.actor(req));
    told(hit?.slug ?? null);
    res.json({ ok: true });
  });

  r.get('/api/asks/:id/files/:file', async (req, res) => {
    const qid = askId(req);
    const file = req.params.file;
    const key = OPTION_FILE.test(file) ? askFileKey(qid, file) : null;
    if (!key) throw fail(404, 'not found');
    // Clips and sounds in ranges (an audition seeks), from the bucket when the storage hands out URLs; pictures here.
    if (file.endsWith('.mp4') || file.endsWith('.m4a')) return sendMedia(req, res, { key, file: null }, { immutable: true });
    const local = await storage().ensureLocal(key);
    if (!local) throw fail(410, 'the file is gone');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    sendInternal(res, local);
  });

  return r;
}
