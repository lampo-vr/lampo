// Notes not sent yet (lib/drafts.ts): a person saves notes as drafts and sends them when they're ready, one batch for
// everything they kept (and, asked to, what their recordings said). Drafts are only ever their author's: in the app
// (a browser session, or the machine itself), never through an API token — agents and scripts use tokens, and a token
// acts for the person who made it, so it must not read or send what that person hasn't sent. Nothing here broadcasts
// before a send: a change is told to its author's own streams only (EventHub.tell).
import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Router } from 'express';
import { z } from 'zod';
import {
  addDraft,
  addDraftRefs,
  countDrafts,
  deleteDraft,
  draftFile,
  draftsDir,
  editDraft,
  isDraftOwner,
  listDrafts,
  removeDraftRef,
  sendDrafts,
} from '../../lib/drafts.ts';
import { slugify } from '../../lib/paths.ts';
import { can } from '../../lib/permissions.ts';
import { listRecordings } from '../../lib/recordings.ts';
import { attachDraftRefFile, discardRefs } from '../../lib/refs.ts';
import * as store from '../../lib/store.ts';
import { SEVERITIES } from '../../lib/time.ts';
import { TEXT_EDIT_MAX } from '../../lib/transcript.ts';
import type { AgentRunInfo, Comment, DraftsResponse, DraftsSent, NoteRef, UnsentResponse } from '../../lib/types.ts';
import type { ServerContext } from '../context.ts';
import { gate } from '../extension.ts';
import { accountOf, getReview, isOwn } from '../helpers.ts';
import { body, commentId, fail, failFrom, parse, router, sendInternal } from '../http.ts';
import { issuerOf, teamGuard } from '../uploadTickets.ts';
import { checkWake, startAgent } from '../wake.ts';
import { type PreparedRecording, prepareRecording, refusal, settleRecording } from './recordings.ts';
import { inlineRef, RefBody, withInlineFile } from './refs.ts';
import { NewComment, prepareNote, shotsToFollow } from './review.ts';

const DraftPatch = z.object({
  text: z.string().max(20000).optional(),
  tags: z.array(z.string().max(60)).max(12).optional(),
  severity: z.enum(SEVERITIES).optional(),
  text_edit_to: z.string().max(TEXT_EDIT_MAX).optional(),
});
const SendBody = z.object({
  /** Only these drafts (default: all of yours on the video). */
  ids: z.array(z.string()).max(500).optional(),
  /** Your recordings' drafts too (those heard and ready), in the same batch: all of them, or only these (`d_…` ids). */
  recordings: z.union([z.boolean(), z.array(z.string()).max(500)]).optional(),
  /** Then start the video's agent for the batch when it isn't running (on this machine only; server/wake.ts). */
  start: z.boolean().optional(),
});
const DRAFT_FILE = /^c_[a-f0-9]+(_clean\.png|_marked\.png|_range\.jpg|\.m4a)$/;

export function draftRoutes(ctx: ServerContext): Router {
  const r = router();

  /** Whose drafts: the person asking, in the app. */
  const owner = (req: Request): string => {
    if (req.auth?.via === 'token') throw fail(403, 'drafts are kept in the app, for people: not with an API token');
    const id = req.auth?.user?.id;
    if (!isDraftOwner(id)) throw fail(403, 'sign in to keep drafts');
    return id;
  };
  const tell = (who: string, slug: string) => ctx.hub.tell(who, 'drafts', { slug });
  const idOf = (req: Request) => parse(commentId, req.params.id, 'draft id');
  /** A draft of this person on this video, or 404 (someone else's doesn't exist for you). */
  const mine = (slug: string, who: string, id: string): Comment => {
    const d = listDrafts(slug, who).find((x) => x.id === id);
    if (!d) throw fail(404, 'no such draft');
    return d;
  };

  // How many notes each video holds that you haven't sent (drafts and what your recordings said): the library's
  // "2 not sent".
  r.get('/api/drafts', (req, res) => {
    const who = owner(req);
    const videos: UnsentResponse['videos'] = {};
    for (const review of store.listReviews()) {
      const slug = slugify(review.video);
      const recorded = listRecordings(slug)
        .filter((x) => isOwn(req, x.by, x.by_id) && (x.state === 'ready' || x.state === 'failed'))
        .reduce((n, x) => n + x.drafts.filter((d) => d.text.trim() || d.drawing.length).length, 0);
      const n = countDrafts(slug, who) + recorded;
      if (n) videos[slug] = n;
    }
    const out: UnsentResponse = { videos };
    res.setHeader('Cache-Control', 'no-store');
    res.json(out);
  });

  r.get('/api/review/:slug/drafts', (req, res) => {
    getReview(req.params.slug);
    const out: DraftsResponse = { drafts: listDrafts(req.params.slug, owner(req)) };
    res.setHeader('Cache-Control', 'no-store');
    res.json(out);
  });

  // Save: a note like the composer's (screenshots, voice note, references), kept as a draft. No event.
  r.post('/api/review/:slug/drafts', express.json({ limit: '5mb' }), async (req, res) => {
    const slug = req.params.slug;
    const who = owner(req);
    getReview(slug);
    const b = body(NewComment, req);
    // Written as the person: a draft is never an agent's.
    const input = await prepareNote(ctx, req, slug, { ...b, by: null }, { dir: draftsDir(slug) });
    let c: Comment;
    try {
      c = addDraft(slug, who, input);
    } catch (e) {
      await discardRefs(slug, input.refs || []);
      for (const f of [input.shots?.clean, input.shots?.marked, input.shots?.range, input.voice?.file])
        if (f) fs.rmSync(path.join(draftsDir(slug), f), { force: true });
      throw e;
    }
    tell(who, slug);
    res.json(c);
  });

  r.patch('/api/review/:slug/drafts/:id', express.json(), (req, res) => {
    const slug = req.params.slug;
    const who = owner(req);
    getReview(slug);
    mine(slug, who, idOf(req));
    const c = editDraft(slug, who, idOf(req), body(DraftPatch, req));
    tell(who, slug);
    res.json(c);
  });

  r.delete('/api/review/:slug/drafts/:id', (req, res) => {
    const slug = req.params.slug;
    const who = owner(req);
    getReview(slug);
    mine(slug, who, idOf(req));
    deleteDraft(slug, who, idOf(req));
    tell(who, slug);
    res.json({ ok: true });
  });

  // A draft's screenshot or voice note, for its author.
  r.get('/api/review/:slug/drafts/:id/:file', (req, res) => {
    const slug = req.params.slug;
    const who = owner(req);
    getReview(slug);
    const d = mine(slug, who, idOf(req));
    const file = DRAFT_FILE.test(req.params.file) && req.params.file.startsWith(d.id) ? draftFile(slug, who, req.params.file) : null;
    if (!file) throw fail(404, 'not found');
    res.setHeader('Cache-Control', 'private, no-cache');
    sendInternal(res, file);
  });

  // References on a draft: links and moments as JSON, images and clips inline or through a one-time upload URL.
  r.post(
    '/api/review/:slug/drafts/:id/refs',
    gate(() => ctx.extension, 'upload'),
    express.json({ limit: '12mb' }),
    async (req, res) => {
      const slug = req.params.slug;
      const who = owner(req);
      getReview(slug);
      const id = idOf(req);
      const d = mine(slug, who, id);
      const b = body(RefBody, req);
      const by = ctx.actor(req);
      const request = { caption: b.caption, by, by_id: accountOf(req, by) };
      if ((d.refs?.length || 0) >= store.REFS_PER_NOTE) throw fail(422, `a note carries at most ${store.REFS_PER_NOTE} references`);
      if (b.kind === 'link' || b.kind === 'frame') {
        let ref: NoteRef;
        try {
          ref = await ctx.inflight.track(inlineRef(slug, b, request));
        } catch (e) {
          throw failFrom(422, e);
        }
        let comment: Comment;
        try {
          comment = addDraftRefs(slug, who, id, [ref]);
        } catch (e) {
          await discardRefs(slug, [ref]);
          throw failFrom(422, e);
        }
        tell(who, slug);
        return void res.json({ ref, comment, slug });
      }
      const kind = b.kind === 'file' ? undefined : b.kind;
      if (!('data' in b) || !b.data) {
        const base = ctx.cfg.public_url || `${req.protocol}://${req.get('host')}`;
        return void res.json({
          upload: ctx.uploadTickets.issueRef(
            { comment: id, request: { caption: b.caption, kind, by_id: request.by_id }, draft: { slug, owner: who } },
            by,
            base,
            teamGuard(issuerOf(req), 'comment'),
          ),
        });
      }
      const data = b.data;
      const out = await ctx.inflight.track(withInlineFile(data, (file) => attachDraftRefFile(slug, who, id, file, { ...request, kind })));
      tell(who, slug);
      res.json(out);
    },
  );

  r.delete('/api/review/:slug/drafts/:id/refs/:ref', (req, res) => {
    const slug = req.params.slug;
    const who = owner(req);
    getReview(slug);
    const id = idOf(req);
    const d = mine(slug, who, id);
    if (!d.refs?.some((x) => x.id === req.params.ref)) throw fail(404, 'no such reference');
    const comment = removeDraftRef(slug, who, id, req.params.ref);
    tell(who, slug);
    res.json(comment);
  });

  // Send: your drafts (all, or the ones named) and, asked to, what your recordings said (all, or the drafts named) —
  // one write, one batch of events, so an agent waiting for feedback gets them together. The panel's single Send is
  // the same send with one id: `ids: [id]`, or `ids: []` and `recordings: [id]` for a recording's draft. With `start`
  // the video's agent is started once for the batch (checked before anything is sent: a start that can't happen leaves
  // nothing half done).
  r.post('/api/review/:slug/drafts/send', express.json(), async (req, res) => {
    const slug = req.params.slug;
    const who = owner(req);
    const review = getReview(slug);
    const b = body(SendBody, req);
    // Starting an agent is the `agents` right (like a request), and the machine's own (checkWake).
    if (b.start && !can(req.auth?.role, 'agents')) throw fail(403, `your role (${req.auth?.role}) can't start agents`);
    if (b.start) checkWake(req, ctx, review);
    // A recording's drafts named one by one (a single Send in the panel): only the recordings that hold one of them.
    const pick = Array.isArray(b.recordings) ? new Set(b.recordings) : null;
    const recordings = b.recordings
      ? listRecordings(slug).filter(
          (x) => isOwn(req, x.by, x.by_id) && (x.state === 'ready' || x.state === 'failed') && (!pick || x.drafts.some((d) => pick.has(d.id))),
        )
      : [];
    const prepared: { rec: (typeof recordings)[number]; made: PreparedRecording }[] = [];
    for (const rec of recordings) prepared.push({ rec, made: await prepareRecording(ctx, req, rec, pick) });
    // One write; when it fails nothing was sent, and the drafts and the recordings stay as they were.
    const notes = sendDrafts(slug, who, { ids: b.ids ?? null, also: prepared.flatMap((p) => p.made.notes.map((x) => x.input)) });
    let left = 0;
    let error: string | undefined;
    for (const { rec, made } of prepared) {
      settleRecording(rec, made.left);
      // the ones not named stay by choice: only a named one that couldn't go counts as left
      left += pick ? made.left.filter((d) => pick.has(d.id)).length : made.left.length;
      error ??= made.error;
      ctx.broadcast('recording', { slug, id: rec.id });
    }
    if (notes.length) {
      ctx.broadcast('review', { slug });
      ctx.broadcast('library', { slug });
    }
    shotsToFollow(ctx, slug, notes);
    tell(who, slug);
    // Sent to the video's agent: its run opens, or the one it has open takes them (a person with the agents right only:
    // server/runs.ts — a reviewer's notes go out all the same, and the agent's own work opens its run then).
    const opened = notes.length ? ctx.runs.fromPerson(req, slug, { how: 'send', notes: notes.map((c) => c.id) }) : null;
    let run: AgentRunInfo | null | undefined;
    if (b.start && notes.length) {
      const text = `${notes.length === 1 ? '1 new note' : `${notes.length} new notes`}: ${notes.map((c) => c.id).join(', ')}`;
      try {
        run = await startAgent(req, ctx, slug, review, text, opened?.id);
      } catch (e) {
        error ??= refusal({ id: '-' }, e).error;
      }
    }
    const out: DraftsSent = { notes, left, ...(error ? { error } : {}), ...(b.start ? { run: run ?? null } : {}) };
    res.json(out);
  });

  return r;
}
