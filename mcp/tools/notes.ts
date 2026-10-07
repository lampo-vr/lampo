// Tools that answer notes: fixed (optionally shown on a preview of the fix), won't fix, a reply, and new notes an
// agent pins to a frame (questions and info by default).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { RefInput } from '../../lib/backend/types.ts';
import { CHOICE_MAX, CHOICES_MAX, CHOICES_MIN } from '../../lib/choices.ts';
import { noteText, previewData, projectTime, refCaption, refData, refUrl, refVideo, sourceName, tagList } from '../../lib/inputs.ts';
import { slugify } from '../../lib/paths.ts';
import { describePreview, PREVIEW_LIMITS } from '../../lib/previews.ts';
import { describeRange, normalizeRange } from '../../lib/range.ts';
import { describeRef } from '../../lib/refLine.ts';
import { REF_LIMITS } from '../../lib/refs.ts';
import { isAgent, NOTE_KINDS, oneLine, SEVERITIES, TAGS } from '../../lib/time.ts';
import type { Comment, FixPreview, NoteKind, NoteRef, Severity, Shape } from '../../lib/types.ts';
import { allowed } from '../access.ts';
import { afterClosed, finalNotice, framePosition, ok, pickVersion, text } from '../format.ts';
import type { ToolKit } from '../toolkit.ts';

export function registerNoteTools({ b, o, tool, author, accountOf, byArg }: ToolKit): void {
  tool(
    'mark_fixed',
    {
      title: 'Mark a note fixed',
      description:
        'After you put up the next version: mark a note fixed, saying what you changed and where (e.g. "caption moved to y 1392"). Uses the newest version unless v; waits for a render still being written. Never verify: the reviewer does.',
      inputSchema: z.object({
        id: z.string(),
        note: noteText,
        v: z.number().int().min(1).optional(),
        preview: z.string().optional().describe('p_… when attach_preview showed this fix'),
        by: byArg,
      }),
    },
    async ({ id, note, v, preview: pid, by }, ctx) => {
      const hit = await b.findComment(id);
      if (!hit) throw new Error(`no note ${id}`);
      const lock = finalNotice(b.stage(hit.review), hit.review);
      if (lock) throw new Error(`${lock}: nothing to fix until the reviewer reopens it`);
      await b.review(hit.slug, { wait: true });
      const c = await b.updateComment(id, { status: 'fixed', note, fixed_in_v: v, preview: pid, by: author(by, ctx) });
      // the last line: how many of the video's notes are still open, or (none) to wait for the person now
      return ok(text(`${c.id}: fixed in v${c.fixed_in_v}${pid ? ` (shown on preview ${pid})` : ''}\n${await afterClosed(b, hit.slug)}`));
    },
  );

  // A still or short clip exported from the project: the reviewer checks the fix without waiting for a render.
  const requestPreviewUpload = o.requestPreviewUpload;
  const onThisMachine = o.principal.via === 'local';

  // ---------------------------------------------------------------- references ("like this")
  const requestRefUpload = o.requestRefUpload;
  // Over HTTP (where upload URLs are offered) /mcp takes 1 MB a request, base64 and all (server/routes/mcp.ts MAX_BODY):
  // about 700 KB of file, as mcp/tools/asks.ts says; over stdio a file's REF_LIMITS / PREVIEW_LIMITS.inlineBytes (8 MB).
  const inline = (upload: unknown) => (upload ? '≤ 700 KB (bigger: leave it out for an upload URL)' : '≤ 8 MB');
  // One reference, described once (attach_reference); add_note and reply take a list of the same.
  const ref = {
    url: refUrl.optional(),
    video: refVideo.optional(),
    v: z.number().int().min(1).optional(),
    frame: z.number().int().min(0).optional(),
    timecode: z.string().optional(),
    seconds: z.number().min(0).optional(),
    to_frame: z.number().int().min(0).optional(),
    path: z.string().optional(),
    data: refData.optional(),
    caption: refCaption.optional(),
  };
  const RefArg = z.object(ref);
  const references = z
    .array(RefArg)
    .max(8)
    .optional()
    .meta({ brief: true })
    .describe('up to 8 pictures, clips, links or moments of renders, each as in attach_reference');
  type RefArgs = z.infer<typeof RefArg>;

  // One reference from tool arguments: a link, a moment of a render, or a file (path here, data, or an upload URL).
  async function attachOne(id: string, a: RefArgs, by: string, note?: string): Promise<{ ref: NoteRef } | { upload: { url: string; expires: string } }> {
    const base = { caption: a.caption, note, by, by_id: accountOf(by) };
    let input: RefInput;
    if (a.url) input = { kind: 'link', url: a.url, ...base };
    else if (a.video) {
      const res = await b.resolve(a.video);
      const review = await b.review(res.slug);
      const ver = pickVersion(review, a.v);
      const frame = framePosition(a, ver.fps);
      if (frame === null || !Number.isFinite(frame)) throw new Error('a moment needs frame, timecode (mm:ss:ff) or seconds');
      input = { kind: 'frame', video: res.slug, v: ver.v, frame, to_frame: a.to_frame, ...base };
    } else if (a.path) {
      // A path means a file where this server runs: only the machine's own agent may name one.
      if (!onThisMachine) throw new Error('this server cannot read files on your machine: send data, or leave it out for an upload URL');
      input = { kind: 'file', path: path.resolve(a.path), ...base };
    } else if (a.data) {
      const bytes = Buffer.from(a.data, 'base64');
      if (!bytes.length || bytes.length > REF_LIMITS.inlineBytes) throw new Error(`data must be base64 of at most ${REF_LIMITS.inlineBytes / 1024 / 1024} MB`);
      await o.checkUpload?.(bytes.length);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-mcp-ref-'));
      try {
        fs.writeFileSync(path.join(dir, 'ref'), bytes);
        return await b.attachRef(id, { kind: 'file', path: path.join(dir, 'ref'), ...base });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } else if (requestRefUpload) {
      await o.checkUpload?.(0);
      return { upload: requestRefUpload({ comment: id, request: { caption: a.caption, note, by_id: accountOf(by) } }, by) };
    } else throw new Error('give url, video + frame, path or data');
    return b.attachRef(id, input);
  }

  const refResult = (id: string, out: Awaited<ReturnType<typeof attachOne>>): string =>
    'ref' in out
      ? `${id}: reference ${describeRef(out.ref)}`
      : `${id}: PUT the image or clip to this URL once (valid until ${out.upload.expires}):\n${out.upload.url}\n\ncurl -fT <file> '${out.upload.url}'`;

  tool(
    'attach_preview',
    {
      title: 'Show a fix before rendering',
      description: `Show your fix of a note before rendering: a still (PNG/JPEG/WebP) or a clip ≤ 10 s exported from your project (e.g. After Effects comp.saveFrameToPng at the project time get_note shows). The reviewer can verify on it and the next render is compared with it; a fix verified only on a preview keeps the video from final until a render has it. Same frame shape as the render. Default position: the note's frame in the newest render. ${onThisMachine ? 'File: path or' : 'File:'} base64 data ${inline(requestPreviewUpload)}.`,
      inputSchema: z.object({
        id: z.string(),
        kind: z.enum(['still', 'clip']).optional(),
        path: z.string().optional(),
        data: previewData.optional(),
        frame: z.number().int().min(0).optional().describe("the newest render's frame it shows (a clip: its first)"),
        timecode: z.string().optional(),
        seconds: z.number().min(0).optional(),
        fixed: z.boolean().optional().describe('also mark the note fixed (note: what changed)'),
        note: noteText.optional(),
        app: sourceName.optional().describe('e.g. "After Effects"'),
        project: sourceName.optional().describe('file name'),
        comp: sourceName.optional().describe('comp / sequence'),
        time: projectTime.optional().describe('seconds on the project timeline'),
        by: byArg,
      }),
    },
    async (args, ctx) => {
      const hit = await b.findComment(args.id);
      if (!hit) throw new Error(`no note ${args.id}`);
      const lock = args.fixed ? finalNotice(b.stage(hit.review), hit.review) : null;
      if (lock) throw new Error(`${lock}: nothing to fix until the reviewer reopens it`);
      const latest = pickVersion(await b.review(hit.slug, { wait: true }), undefined);
      const at = framePosition(args, latest.fps);
      const source = args.app ? { app: args.app, project: args.project, comp: args.comp, time: args.time } : undefined;
      const request = { kind: args.kind || ('still' as const), frame: at ?? undefined, source, fixed: args.fixed, note: args.note };
      const who = author(args.by, ctx);
      // A path means a file where this server runs: only the machine's own agent may name one.
      if (args.path && !onThisMachine) throw new Error('this server cannot read files on your machine: send data, or leave it out for an upload URL');
      let done: { preview: FixPreview; comment: Comment };
      if (args.path) done = await b.attachPreview(args.id, path.resolve(args.path), { ...request, by: who });
      else if (args.data) {
        const bytes = Buffer.from(args.data, 'base64');
        if (!bytes.length || bytes.length > PREVIEW_LIMITS.inlineBytes)
          throw new Error(`data must be base64 of at most ${PREVIEW_LIMITS.inlineBytes / 1024 / 1024} MB`);
        await o.checkUpload?.(bytes.length);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-mcp-preview-'));
        try {
          fs.writeFileSync(path.join(dir, 'preview'), bytes);
          done = await b.attachPreview(args.id, path.join(dir, 'preview'), { ...request, by: who });
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } else if (requestPreviewUpload) {
        await o.checkUpload?.(0);
        const t = requestPreviewUpload({ comment: args.id, request }, who);
        return ok(text(`PUT the ${request.kind} to this URL once (valid until ${t.expires}):\n${t.url}\n\ncurl -fT <file> '${t.url}'`));
      } else throw new Error(onThisMachine ? 'give the file as path or data' : 'give the file as base64 data');
      return ok(
        text(
          `${done.comment.id}: preview ${describePreview(done.preview)}${args.fixed ? ' · marked fixed' : ''}\nThe reviewer can verify the fix on it; the next render is compared with it automatically.`,
        ),
      );
    },
  );

  tool(
    'reply',
    {
      title: 'Reply to a note',
      description: 'Reply to a note without changing its status.',
      inputSchema: z.object({
        id: z.string(),
        note: noteText,
        references,
        by: byArg,
      }),
    },
    async ({ id, note, references, by }, ctx) => {
      const who = author(by, ctx);
      if (!references?.length) {
        const c = await b.updateComment(id, { note, by: who });
        return ok(text(`${c.id}: reply added`));
      }
      // The first reference carries the reply's text; the rest join the same note.
      const lines = [`${id}: reply added`];
      for (const [i, a] of references.entries()) lines.push(refResult(id, await attachOne(id, a, who, i === 0 ? note : undefined)));
      return ok(text(lines.join('\n')));
    },
  );

  tool(
    'wont_fix',
    {
      title: "Close a note as won't fix",
      description: "Close a note you deliberately won't change, with the reason (kept as a decision in the taste file).",
      inputSchema: z.object({ id: z.string(), reason: noteText, by: byArg }),
    },
    async ({ id, reason, by }, ctx) => {
      const hit = await b.findComment(id);
      const lock = hit ? finalNotice(b.stage(hit.review), hit.review) : null;
      if (lock) throw new Error(`${lock}: nothing to close until the reviewer reopens it`);
      const c = await b.updateComment(id, { status: 'wontfix', note: reason, by: author(by, ctx) });
      return ok(text(`${c.id}: wontfix${hit ? `\n${await afterClosed(b, hit.slug)}` : ''}`));
    },
  );

  tool(
    'attach_reference',
    {
      title: 'Show what you mean: a reference on a note',
      description: `Attach what "like this" means to a note (at most 8): a link (url), a moment of a render (video + frame, timecode or seconds; v; to_frame ends a range ≤ 60 s), or an image or clip ≤ 60 s (${onThisMachine ? 'path, or ' : ''}base64 data ${inline(requestRefUpload)}). On someone else's note, say why in note (it comes as a reply).`,
      inputSchema: z.object({
        id: z.string(),
        ...ref,
        caption: ref.caption.describe('what to look at'),
        note: noteText.optional(),
        by: byArg,
      }),
    },
    async ({ id, note, by, ...a }, ctx) => {
      const hit = await b.findComment(id);
      if (!hit) throw new Error(`no note ${id}`);
      const who = author(by, ctx);
      // As over HTTP (server/routes/refs.ts): on someone else's note, a reference comes with a reply saying what it is for.
      const own = hit.comment.author_id ? hit.comment.author_id === accountOf(who) : hit.comment.author === who;
      if (!note?.trim() && !own && !allowed(o.principal, 'edit-notes'))
        throw new Error('only its author can add references to this note; say what it is for in note (it comes as a reply)');
      return ok(text(refResult(id, await attachOne(id, a, who, note))));
    },
  );

  tool(
    'add_note',
    {
      title: 'Ask the reviewer about a frame, or tell them what you changed',
      description:
        'Pin a note to a frame (frame, timecode mm:ss:ff or seconds), a stretch (range {in, out}, or an end: to_frame / to_timecode / to_seconds) or the whole video (overall: true). kind question (default): what only the reviewer can decide; the answer comes as a reply. info: what you changed or decided. feedback with a severity: only when you review footage yourself. box/arrow in video px.',
      inputSchema: z.object({
        video: z.string().describe(o.principal.via === 'local' ? 'path (tracked if new), slug or part of the name' : 'slug or part of the name'),
        frame: z.number().int().min(0).optional(),
        timecode: z.string().optional(),
        seconds: z.number().min(0).optional(),
        text: noteText,
        tags: tagList.optional().describe(`e.g. ${TAGS.join(', ')}`),
        kind: z.enum(NOTE_KINDS as [NoteKind, ...NoteKind[]]).optional(),
        severity: z
          .enum(SEVERITIES as [Severity, ...Severity[]])
          .optional()
          .describe('feedback only'),
        box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
        arrow: z.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() }).optional(),
        range: z.object({ in: z.number().int(), out: z.number().int() }).optional(),
        to_frame: z.number().int().min(0).optional(),
        to_timecode: z.string().optional(),
        to_seconds: z.number().min(0).optional(),
        v: z.number().int().min(1).optional(),
        overall: z.boolean().optional(),
        references,
        choices: z
          .array(z.string().trim().min(1).max(CHOICE_MAX))
          .min(CHOICES_MIN)
          .max(CHOICES_MAX)
          .optional()
          .describe('a question with a few likely answers: one click each (a pick comes as a reply)'),
        by: byArg,
      }),
    },
    async (args, ctx) => {
      const who = author(args.by, ctx);
      // A render not under review yet is tracked where it is, by the machine's own agent only; anyone else names a
      // video of the library (the backend they get never looks at this server's disk: access.ts backendFor).
      const local = o.principal.via === 'local';
      const res = await b.resolve(args.video, { mustExist: !local });
      const review = res.fresh && local ? (await b.track(res.video, { by: who, byId: accountOf(who) })).review : await b.review(res.slug, { wait: true });
      const slug = slugify(review.video);
      const ver = pickVersion(review, args.v);
      const frame = args.overall ? 0 : framePosition(args, ver.fps);
      if (frame === null || !Number.isFinite(frame)) throw new Error('give frame, timecode (mm:ss:ff) or seconds (or overall: true)');
      if (frame < 0 || frame >= ver.frames) throw new Error(`frame ${frame} is outside 0–${ver.frames - 1}`);
      const drawing: Shape[] = [];
      if (args.box) drawing.push({ type: 'box', ...args.box });
      if (args.arrow) drawing.push({ type: 'arrow', ...args.arrow });
      // A range: given as frames, or from the position to an end given as frame, timecode or seconds.
      const end = framePosition({ frame: args.to_frame, timecode: args.to_timecode, seconds: args.to_seconds }, ver.fps);
      const range = args.overall ? null : normalizeRange(args.range || (end !== null ? { in: frame, out: end } : null), ver.frames);
      const { comment: c, review: after } = await b.addNote(slug, {
        v: ver.v,
        frame,
        range,
        text: args.text,
        tags: args.tags || [],
        severity: args.severity || 'should',
        // An agent's note is a question unless it says otherwise; a person's note is feedback.
        kind: args.kind ?? (isAgent(who) ? 'question' : undefined),
        drawing: args.overall ? [] : drawing,
        author: who,
        author_id: accountOf(who),
        ...(args.overall ? { scope: 'video' as const } : {}),
        ...(args.choices ? { choices: args.choices } : {}),
      });
      const where = o.principal.via === 'local' && !args.overall ? `\nmarked: ${b.shotFile(after, c.shots?.marked)}` : '';
      const lock = finalNotice(b.stage(after), after);
      const refs: string[] = [];
      for (const a of args.references || []) refs.push(refResult(c.id, await attachOne(c.id, a, who)));
      const at = args.overall
        ? 'about the whole video'
        : `pinned at ${c.timecode} (f${c.frame}, v${c.v})${c.range ? `, range ${describeRange(c.range, ver.fps)}` : ''}`;
      return ok(
        text(
          `${c.id} ${at} by ${c.author}${where}\nkind: ${c.kind || 'feedback'}${c.choices ? `\nchoices: ${c.choices.map(oneLine).join(' | ')}` : args.choices ? '\nchoices: not kept (only a question offers choices)' : ''}${lock ? `\nnote: ${lock}; this note waits until someone reopens it` : ''}${refs.length ? `\n${refs.join('\n')}` : ''}`,
        ),
      );
    },
  );
}
