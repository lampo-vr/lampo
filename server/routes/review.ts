// One video's review: the full state for the player, notes (with exact-frame screenshots), approval, requests.

import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Router } from 'express';
import { z } from 'zod';
import { setAgentStatus } from '../../lib/agentStatus.ts';
import { CHOICE_MAX, CHOICES_MAX, CHOICES_MIN } from '../../lib/choices.ts';
import { cachedCuts } from '../../lib/cuts.ts';
import { byName, noteText, previewId, statusText, tagList } from '../../lib/inputs.ts';
import { isWhole, MAX_HANDLES, PART_HANDLES, snapToShots } from '../../lib/part.ts';
import { cacheDir, reviewDir, slugify } from '../../lib/paths.ts';
import { can, canSetStatus } from '../../lib/permissions.ts';
import { claudePrompt } from '../../lib/prompt.ts';
import { frameInRange, normalizeRange } from '../../lib/range.ts';
import { discardRefs, inlineRefs } from '../../lib/refs.ts';
import { followShots, shotsOrLater } from '../../lib/shots.ts';
import { approvalsOf } from '../../lib/stage.ts';
import { stageForReview } from '../../lib/stageContext.ts';
import * as store from '../../lib/store.ts';
import { NOTE_KINDS, SEVERITIES, STATUSES } from '../../lib/time.ts';
import { TEXT_EDIT_MAX } from '../../lib/transcript.ts';
import type { Comment, FrameRange, MediaInfo, NoteRecording, PartRequest, PartSuggestion, ReviewResponse, Version, VoiceNote } from '../../lib/types.ts';
import type { ServerContext } from '../context.ts';
import { countStep, noticeMoment } from '../funnel.ts';
import { accountOf, agentView, finalLock, getReview, getVersion, isOwn, metaOf, sanitizeDrawing, signOffByPerson, summary, versionBytes } from '../helpers.ts';
import { body, commentId, fail, failFrom, parse, query, router } from '../http.ts';
import { checkWake, startAgent } from '../wake.ts';
import { InlineRefInput } from './refs.ts';

const severity = z.enum(SEVERITIES);
const range = z.object({ in: z.number(), out: z.number() });
/** A partial render the person allows (lib/part.ts): frames of the version, snapped to its shots. */
export const PartBody = z.object({
  in: z.number().int().min(0),
  out: z.number().int().min(0),
  shot: z.number().int().min(1).max(100000).optional(),
  to_shot: z.number().int().min(1).max(100000).optional(),
  handles: z.number().int().min(0).max(MAX_HANDLES).optional(),
});
const PartQuery = z.object({
  v: z.coerce.number().int().min(1).optional(),
  in: z.coerce.number().int().min(0),
  out: z.coerce.number().int().min(0).optional(),
});
/** Agents label their own writes ("agent:reels-2"); anything else is ignored and the caller's name is used. */
const by = byName.nullish();

export const NewComment = z.object({
  v: z.number().int().nullish(),
  frame: z.number().optional(),
  range: range.nullish(),
  text: noteText.optional(),
  tags: tagList.optional(),
  severity: severity.optional(),
  kind: z.enum(NOTE_KINDS).optional(),
  drawing: z.array(z.unknown()).optional(),
  voiceId: z.string().nullish(),
  voiceTranscript: noteText.nullish(),
  /** Links and moments of renders that come with the note (images and clips follow through POST …/refs). */
  refs: z.array(InlineRefInput).max(8).optional(),
  /** About the whole video, not a moment of it. */
  scope: z.enum(['video']).optional(),
  /** A change to what is said (picked in the transcript): the words as heard and as they should be. */
  text_edit: z.object({ from: z.string().trim().min(1).max(TEXT_EDIT_MAX), to: z.string().max(TEXT_EDIT_MAX) }).optional(),
  /** Questions: answers the asker offers, picked with one click (lib/choices.ts). */
  choices: z.array(z.string().trim().min(1).max(CHOICE_MAX)).min(CHOICES_MIN).max(CHOICES_MAX).optional(),
  /** The person allows a partial render of these frames (opt-in; lib/part.ts). */
  part: PartBody.optional(),
  by,
});

export type NewCommentBody = z.infer<typeof NewComment>;

const CommentPatch = z.object({
  status: z.enum(STATUSES).optional(),
  note: noteText.optional(),
  text: noteText.optional(),
  tags: tagList.optional(),
  severity: severity.optional(),
  ack: z.boolean().optional(),
  fixed_in_v: z.union([z.number().int().min(1), z.string().regex(/^\d+$/)]).nullish(),
  /** A fix preview of the note the fix or the verdict refers to (verified with one: verified on the preview only). */
  preview: previewId.optional(),
  /** A text edit's new words (what was heard stays as it is). */
  text_edit_to: z.string().max(TEXT_EDIT_MAX).optional(),
  by,
});

/** Which reply: its place in the thread, and when it was written (the thread may have moved since: lib/store.ts). */
const replyPlace = z.coerce.number().int().min(0).max(100_000);
const replyTime = z.string().min(1).max(40);
/** A reply's new words; none would be a deletion, which is its own request. */
const ReplyEdit = z.object({ at: replyTime, text: noteText.refine((s) => s.trim().length > 0, 'a reply needs words: delete it instead') });
const ReplyQuery = z.object({ at: replyTime });

const ApprovalBody = z.object({
  status: z.enum(['approved', 'changes']).optional(),
  note: z.string().max(5000).nullish(),
  v: z.number().int().min(1).nullish(),
});

// `start`: also start the assigned agent when it isn't running (on this machine only; server/wake.ts).
const RequestBody = z.object({ text: z.string().max(5000).optional(), start: z.boolean().optional(), part: PartBody.optional() });
const StatusBody = z.object({ text: statusText.nullish(), eta_seconds: z.number().min(0).max(86400).nullish(), by });

/** A stretch the person picked, on the render's shots when they are known (the suggestion came from them). */
function snapPart(ver: Version, p: PartRequest): PartRequest {
  const cuts = cachedCuts(ver);
  const out = cuts ? snapToShots(cuts, ver.frames, p, p.handles ?? PART_HANDLES) : p;
  return { ...out, handles: p.handles ?? PART_HANDLES };
}

/** A note as the composer (and every other way in the app) makes it: screenshots at its frame, a voice clip waiting in
 * cache/voice, references inline. `recording`: said while watching (the send of a recording, server/routes/recordings.ts). */
export async function createNote(
  ctx: ServerContext,
  req: Request,
  slug: string,
  b: NewCommentBody,
  extra: { recording?: NoteRecording } = {},
): Promise<Comment> {
  const input = await prepareNote(ctx, req, slug, b, extra);
  let c: Comment;
  try {
    c = store.addComment(slug, input);
  } catch (e) {
    await discardRefs(slug, input.refs || []);
    throw e;
  }
  shotsToFollow(ctx, slug, [c]);
  return c;
}

/**
 * Notes just saved without their screenshots — the on-demand gate had no place for them (lib/shots.ts shotsOrLater):
 * they follow from the job queue, and open players hear once they are in.
 */
export function shotsToFollow(ctx: ServerContext, slug: string, notes: readonly Comment[]): void {
  for (const c of notes) if (!c.shots && c.scope !== 'video') followShots(slug, c.id, () => ctx.broadcast('review', { slug }));
}

/**
 * Everything a note needs before it is written (createNote, drafts, a recording's batch): its screenshots and voice
 * clip in `dir` (the review's folder; a draft's folder for drafts), its references stored. Throws with a status. With
 * the on-demand gate full, the note goes without screenshots (`shotsToFollow` once it is saved): never a 503 for them.
 */
export async function prepareNote(
  ctx: ServerContext,
  req: Request,
  slug: string,
  b: NewCommentBody,
  extra: { recording?: NoteRecording; dir?: string } = {},
): Promise<store.CommentInput> {
  const dir = extra.dir ?? reviewDir(slug);
  const review = getReview(slug);
  const ver = getVersion(review, b.v);
  const overall = b.scope === 'video';
  // A note about the whole video has no moment: frame 0, no screenshots, no drawing.
  // A range is whole frames inside the render (past the end is refused); the note's frame lies inside it.
  let range: FrameRange | null = null;
  try {
    range = overall ? null : normalizeRange(b.range, ver.frames);
  } catch (e) {
    throw failFrom(400, e);
  }
  const frame = overall ? 0 : frameInRange(Math.max(0, Math.min(ver.frames - 1, Math.round(b.frame || 0))), range);
  const drawing = overall ? [] : sanitizeDrawing(b.drawing, ver);
  const id = store.reservedCommentId();
  const shots = overall
    ? undefined
    : await shotsOrLater({
        file: await versionBytes(review, ver, `the bytes of v${ver.v} are gone, cannot grab the frame`),
        frame,
        meta: metaOf(review, ver),
        drawing,
        dir,
        id,
        range,
      });
  const author = ctx.actor(req, b.by);
  const author_id = accountOf(req, author);
  let refs: Awaited<ReturnType<typeof inlineRefs>> = [];
  try {
    refs = b.refs?.length ? await ctx.inflight.track(inlineRefs(slug, b.refs, { by: author, by_id: author_id })) : [];
  } catch (e) {
    throw failFrom(422, e);
  }
  // A voice note waits in cache/voice until its comment is saved.
  let voice: VoiceNote | null = null;
  if (b.voiceId && /^[a-f0-9]{16}$/.test(b.voiceId)) {
    const src = path.join(cacheDir(), 'voice', `${b.voiceId}.m4a`);
    if (fs.existsSync(src)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.renameSync(src, path.join(dir, `${id}.m4a`));
      voice = { file: `${id}.m4a`, transcript: b.voiceTranscript ?? null };
    }
  }
  return {
    id,
    v: ver.v,
    frame,
    range,
    text: b.text || '',
    tags: (b.tags || []).slice(0, 12),
    severity: b.severity || 'should',
    kind: b.kind,
    drawing,
    author,
    author_id,
    shots,
    voice,
    refs,
    ...(overall ? { scope: 'video' as const } : {}),
    ...(b.text_edit ? { text_edit: b.text_edit } : {}),
    ...(b.choices ? { choices: b.choices } : {}),
    ...(extra.recording ? { recording: extra.recording } : {}),
    ...(b.part && !overall ? { part: snapPart(ver, b.part) } : {}),
  };
}

export function reviewRoutes(ctx: ServerContext): Router {
  const r = router();
  const { broadcast, playback } = ctx;
  const changed = (slug: string | undefined) => {
    broadcast('review', { slug });
    broadcast('library', slug ? { slug } : {});
  };
  // Where a review's files live on disk is for the machine's owner at the machine (agents there read them); a hosted
  // server tells nobody.
  const dataDir = (req: Request, slug: string) => (!ctx.hosted && req.auth?.via === 'local' ? reviewDir(slug) : '');

  r.get('/api/review/:slug', async (req, res) => {
    const slug = req.params.slug;
    const synced = store.sync(slug);
    if (!synced) throw fail(404, 'unknown video');
    const review = synced.review;
    // A full render after approved partial ones is compared with them (cheap when there is nothing to do).
    ctx.background.checkParts(review);
    const media: Record<number, MediaInfo> = {};
    for (const ver of review.versions) media[ver.v] = playback.mediaInfo(slug, ver, playback.playable(review, ver));
    const out: ReviewResponse = {
      slug,
      review: agentView.review(req, review),
      summary: agentView.summary(req, summary(review, await ctx.sessions.get())),
      approvals: approvalsOf(review),
      media,
      dataDir: dataDir(req, slug),
      user: ctx.actor(req),
    };
    res.json(out);
  });

  // Every review in full (remote `vr` and MCP read the library through this).
  r.get('/api/reviews', (req, res) => {
    res.json({
      reviews: store.listReviews().map((review) => ({ slug: slugify(review.video), review: agentView.review(req, review), stage: stageForReview(review) })),
    });
  });

  // The stretch to render for a partial render (opt-in): the shots around a frame or range, from the render's own
  // cuts (found once per render; `pending` meanwhile — the player asks again).
  r.get('/api/review/:slug/part', (req, res) => {
    const review = getReview(req.params.slug);
    const q = parse(PartQuery, req.query, 'query');
    const ver = getVersion(review, q.v);
    const started = ctx.background.startCuts(review, ver.v);
    if (!('cuts' in started) || !started.cuts) return void res.json(started);
    const part = snapToShots(started.cuts, ver.frames, { in: q.in, out: q.out ?? q.in });
    const out: PartSuggestion = { v: ver.v, part, whole: isWhole(part, ver.frames), shots: started.cuts.length + 1 };
    res.json(out);
  });

  r.get('/api/review/:slug/prompt', (req, res) => {
    // Paths on this disk for the machine itself (dataDir's rule); anyone else — a hosted server's callers, the LAN, a
    // token on the machine — is pointed at `vr` and this server instead (A12 VE2a-3).
    const hosted = dataDir(req, req.params.slug) ? undefined : ctx.cfg.public_url || `${req.protocol}://${req.get('host')}`;
    res.type('text/plain').send(claudePrompt(getReview(req.params.slug), { hosted }));
  });

  r.get('/api/review/:slug/md', (req, res) => {
    // Paths on this disk for the machine's owner at the machine; anyone else is told the URLs (dataDir's rule).
    const review = getReview(req.params.slug);
    const files = dataDir(req, req.params.slug) ? 'paths' : 'urls';
    res.type('text/markdown').send(store.renderReviewMd(agentView.review(req, review), { files }));
  });

  // Register a re-render now (files on disk). Uploads get new versions by being uploaded again.
  r.post('/api/review/:slug/sync', (req, res) => {
    const s = store.sync(req.params.slug);
    if (!s) throw fail(404, 'unknown video');
    if (s.changed) changed(req.params.slug);
    // A version registered here gets the same work as one the file watcher or an upload brings: poster, analysis, the
    // diff, and its transcript when the one before was heard (otherwise "what changed" waits for someone to ask).
    if (s.version) ctx.background.warm(s.review);
    res.json({ changed: s.changed, pending: !!s.pending, version: s.version || null, carried: s.carried || 0, review: s.review });
  });

  r.get('/api/comments/:id', (req, res) => {
    const hit = store.findComment(parse(commentId, req.params.id, 'comment id'));
    if (!hit) throw fail(404, 'no such note');
    res.json({ slug: hit.slug, review: agentView.review(req, hit.review), comment: hit.comment });
  });

  r.post('/api/review/:slug/comments', express.json({ limit: '5mb' }), async (req, res) => {
    const slug = req.params.slug;
    const c = await createNote(ctx, req, slug, body(NewComment, req));
    changed(slug);
    res.json(c);
  });

  // Beyond `comment` (checked for every route): changing someone else's note needs `edit-notes`, and statuses have
  // their own action (reviewers confirm or reopen; fixed / won't fix is the editor's side).
  const mayChangeNote = (req: express.Request, c: Comment) => isOwn(req, c.author, c.author_id) || can(req.auth?.role, 'edit-notes');

  r.patch('/api/comments/:id', express.json(), (req, res) => {
    const id = parse(commentId, req.params.id, 'comment id');
    const hit = store.findComment(id);
    if (!hit) throw fail(404, 'no such note');
    const b = body(CommentPatch, req);
    const role = req.auth?.role;
    if (b.status && !canSetStatus(role, b.status)) throw fail(403, `your role (${role}) can't mark notes ${b.status}`);
    // ack = "checked the new version, still wrong": the reviewer's side; fixed_in_v is the editor's.
    if (b.ack && !can(role, 'verify')) throw fail(403, `your role (${role}) can't do that`);
    if (b.fixed_in_v != null && !can(role, 'resolve')) throw fail(403, `your role (${role}) can't do that`);
    if ((b.text !== undefined || b.text_edit_to !== undefined || b.tags || b.severity) && !mayChangeNote(req, hit.comment))
      throw fail(403, 'only its author can edit this note');
    if (b.preview && !hit.comment.previews?.some((p) => p.id === b.preview)) throw fail(400, `this note has no preview ${b.preview}`);
    if (b.preview && b.status && b.status !== 'fixed' && b.status !== 'verified') throw fail(400, 'a preview goes with "fixed" or "verified" only');
    if (b.status === 'fixed' || b.status === 'wontfix') finalLock(req, hit.review);
    const who = ctx.actor(req, b.by);
    const c = store.updateComment(id, {
      status: b.status,
      note: b.note,
      text: b.text,
      tags: b.tags,
      severity: b.severity,
      ack: b.ack || undefined,
      fixed_in_v: b.fixed_in_v ?? undefined,
      preview: b.preview,
      text_edit_to: b.text_edit_to,
      by: who,
      by_id: accountOf(req, who),
    });
    changed(store.findComment(id)?.slug);
    // a fix checked "Looks right" on a video of the workspace's own (not the sample): the funnel's step the first time,
    // and the loop's moment for the first person of the workspace to check one (web/src/conversion/)
    const person = req.auth?.via !== 'token' ? req.auth?.user?.id : undefined;
    const checked = b.status === 'verified' && hit.comment.status === 'fixed' && hit.comment.kind !== 'question' && !hit.review.onboarding_sample;
    if (checked) countStep(ctx, 'fix_checked_first');
    if (checked && person) noticeMoment(ctx, 'loop', person, { slug: hit.slug });
    res.json(c);
  });

  // A reply is its author's alone to change or take back: never someone else's, whatever the role (edit-notes is for
  // notes) — by account where the reply names one, by name for older ones (isOwn). An API token acts for its person
  // here as it does with the person's own notes; an agent's replies name no account and stay as written. Only plain
  // words change: a status change, picks and fix previews stay as they happened (lib/ownership.ts changeableReply).
  const ownReply = (req: express.Request, id: string, n: number, at: string) => {
    const hit = store.findReply(id, n);
    if (!hit) throw fail(404, 'no such reply');
    // the thread moved (a reply above it was deleted): the one at this place is another, maybe someone else's
    if (hit.reply.at !== at) throw fail(409, 'this thread changed since you read it: look at it again');
    if (!isOwn(req, hit.reply.by, hit.reply.by_id)) throw fail(403, 'only its author can change this reply');
    return hit;
  };

  r.patch('/api/comments/:id/replies/:n', express.json(), (req, res) => {
    const id = parse(commentId, req.params.id, 'comment id');
    const n = parse(replyPlace, req.params.n, 'reply');
    const b = body(ReplyEdit, req);
    const hit = ownReply(req, id, n, b.at);
    const c = store.editReply(id, n, b.at, b.text, ctx.actor(req));
    changed(hit.slug);
    res.json(c);
  });

  r.delete('/api/comments/:id/replies/:n', (req, res) => {
    const id = parse(commentId, req.params.id, 'comment id');
    const n = parse(replyPlace, req.params.n, 'reply');
    const q = query(ReplyQuery, req);
    const hit = ownReply(req, id, n, q.at);
    const c = store.deleteReply(id, n, q.at, ctx.actor(req));
    changed(hit.slug);
    res.json(c);
  });

  r.delete('/api/comments/:id', (req, res) => {
    const id = parse(commentId, req.params.id, 'comment id');
    const hit = store.findComment(id);
    if (!hit) throw fail(404, 'no such note');
    if (!mayChangeNote(req, hit.comment)) throw fail(403, 'only its author can delete this note');
    store.deleteComment(id, ctx.actor(req));
    changed(hit.slug);
    res.json({ ok: true });
  });

  r.put('/api/review/:slug/approval', express.json(), (req, res) => {
    getReview(req.params.slug);
    signOffByPerson(req);
    const b = body(ApprovalBody, req);
    const who = ctx.actor(req);
    const approval = b.status
      ? store.setApproval(req.params.slug, { status: b.status, note: b.note, v: b.v ?? undefined }, who, { party: 'team' })
      : store.setApproval(req.params.slug, null, who, { party: 'team', v: b.v ?? undefined });
    changed(req.params.slug);
    res.json({ approval });
  });

  r.post('/api/review/:slug/request', express.json(), async (req, res) => {
    const review = getReview(req.params.slug);
    const b = body(RequestBody, req);
    const text = (b.text || '').trim();
    if (!text && !b.part) throw fail(400, 'empty request');
    // Checked before the request is logged: a start that can't happen leaves nothing half done.
    if (b.start) checkWake(req, ctx, review);
    const latest = review.versions.at(-1);
    const words = store.addRequest(req.params.slug, text, ctx.actor(req), b.part && latest ? snapPart(latest, b.part) : null);
    const run = b.start ? await startAgent(req, ctx, req.params.slug, review, words) : null;
    res.json({ ok: true, ...(b.start ? { run } : {}) });
  });

  // What an agent is doing with the video ("rendering v4"); empty text clears it.
  r.put('/api/review/:slug/agent-status', express.json(), (req, res) => {
    getReview(req.params.slug);
    const b = body(StatusBody, req);
    const status = setAgentStatus(req.params.slug, b.text ? { text: b.text, eta_seconds: b.eta_seconds ?? undefined } : null, ctx.actor(req, b.by));
    changed(req.params.slug);
    res.json({ status });
  });

  return r;
}
