// Reading tools: the videos under review, their notes (with the marked frames as images), exact frames, the
// reviewer's taste and the folder tree. None of them writes anything.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { archivedIn } from '../../lib/archived.ts';
import { legendLine, pointerFields, pointerIn } from '../../lib/elements.ts';
import { folderName } from '../../lib/inputs.ts';
import { forAgents } from '../../lib/onboarding.ts';
import { picksToRender } from '../../lib/options.ts';
import { partOk } from '../../lib/part.ts';
import { matchesSession } from '../../lib/sessions.ts';
import { counts } from '../../lib/store.ts';
import { scopeOf } from '../../lib/taste.ts';
import { compareTime, instant, isIdea, isQuestion, isRequired, noteRank, oneLine, timecode } from '../../lib/time.ts';
import { toSrt, toVtt } from '../../lib/transcript.ts';
import type { Comment } from '../../lib/types.ts';
import {
  askLines,
  changedAt,
  framePosition,
  header,
  idle,
  markedPicture,
  noteLines,
  ok,
  pickVersion,
  playbookPointer,
  preview,
  previewWidth,
  rangePicture,
  refPictures,
  screenshotsLine,
  text,
} from '../format.ts';
import type { ToolKit } from '../toolkit.ts';

export function registerReadingTools({ b, o, tool, openReview, me }: ToolKit): void {
  // Paths on this machine mean something only to an agent on it (and a hosted server's must stay its own).
  const files = o.principal.via === 'local';
  tool(
    'list_videos',
    {
      title: 'List videos under review',
      description: 'The videos under review: note counts, version, folder, assigned session and stage (final = done: fix nothing).',
      inputSchema: z.object({
        open_only: z.boolean().optional(),
        folder: folderName.optional().describe('e.g. "Acme/Reels" (with subfolders)'),
        session: z.string().optional().describe('a session name, or "me": assigned to you'),
        // archived projects' videos too (for the few who need them: accepted, not announced — mcp/lean.ts)
        archived: z.boolean().optional().meta({ hidden: true }),
      }),
    },
    async ({ open_only, folder, session, archived }) => {
      // archived videos and archived projects' only when asked (read-only: nothing to work on there)
      const shut = await b.archivedProjects();
      const away = (r: { archived?: string; folder?: string | null }) => !!r.archived || !!archivedIn(r.folder, shut);
      let reviews = forAgents(await b.listReviews()).filter((r) => archived || !away(r));
      if (open_only) reviews = reviews.filter((r) => counts(r).open > 0);
      if (folder) reviews = reviews.filter((r) => r.folder && (r.folder === folder || r.folder.startsWith(`${folder}/`)));
      if (session) {
        // "me": the agent this connection is listed as (HTTP), or the Claude Code session the stdio server runs in.
        const who = session === 'me' ? me() : { name: session, sessionId: null };
        if (!who?.name && !who?.sessionId)
          throw new Error('session:"me" needs to know who you are: run the server inside a Claude Code session, or connect over HTTP');
        reviews = reviews.filter((r) => matchesSession(r.session, who));
      }
      reviews.sort((a, c) => compareTime(c.updated, a.updated));
      // nothing open on any of them (or none at all): the answer ends with the next step (mcp/toolkit.ts)
      const quiet = (answer: ReturnType<typeof ok>) => (reviews.some((r) => counts(r).open > 0 && b.stage(r).stage !== 'final') ? answer : idle(answer));
      if (!reviews.length) return quiet(ok(text('No videos match.')));
      const lines = reviews.map((r) => {
        const n = counts(r);
        const st = b.stage(r);
        // Two lines per video, each its own: a file name, a folder, a session or a status can't start a third.
        return `${oneLine(r.video)}\n  ${oneLine(`v${r.versions.at(-1)?.v} · open ${n.open} (must ${n.must}) · fixed ${n.fixed} · done ${n.done} · folder ${r.folder || 'Unsorted'} · session ${r.session?.name || '-'}${r.agent_status ? ` · status "${r.agent_status.text}"` : ''} · stage ${st.stage} (${st.detail})${away(r) ? ' · archived' : ''}`)}`;
      });
      return quiet(ok(text(lines.join('\n'))));
    },
  );

  tool(
    'get_open_notes',
    {
      title: 'Open notes of a video (with marked frames)',
      description:
        'Open notes of a video: work first (must → nice), then ideas (optional) and your questions still waiting; frame, timecode, tags, text, drawing (video px). Notes with a drawing come with their marked frame, cropped to it. since: the "as of" of an earlier answer → only what changed.',
      inputSchema: z.object({
        video: z.string().describe('path, slug or part of the name'),
        images: z
          .enum(['drawn', 'all', 'none'])
          .optional()
          .describe('drawn (default): marked frames of notes with a drawing; all: every frame, range and reference'),
        max_images: z.number().int().min(0).max(20).optional().describe('default 6'),
        since: z.string().optional(),
        all: z.boolean().optional().describe('every status, not just open'),
        // Older clients: true = images "all", false = "none". Still accepted, no longer announced (mcp/lean.ts).
        include_images: z.boolean().optional().meta({ deprecated: true }),
      }),
    },
    async ({ video, images, include_images, max_images = 6, since, all = false }) => {
      const mode = images ?? (include_images === undefined ? 'drawn' : include_images ? 'all' : 'none');
      const { slug, review } = await openReview(video);
      // the onboarding sample: a demo for the person, its notes examples — nothing here is an agent's to work on
      if (review.onboarding_sample) return ok(text(`${header(review, b.stage(review))}\n\nNo work here.`));
      // Read: a wait that starts later doesn't hand these over again as waiting for it (mcp/feedback.ts).
      o.told?.mark(slug, Date.now());
      // Read now: the next answer's `since` (inclusive, so a change in this very second is shown again, never lost).
      const asOf = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
      const after = since ? instant(since) : null;
      if (since && !Number.isFinite(after)) throw new Error(`since must be the "as of" of an earlier answer (a timestamp), got "${since}"`);
      const changed = (c: Comment) => after === null || changedAt(c) >= (after as number);
      // Picks answered since the newest render: what the next one is made of (lib/options.ts picksToRender).
      const newest = review.versions.at(-1)?.registered;
      const picked = (c: Comment) => c.status !== 'open' && picksToRender(c, newest);
      const kept = review.comments
        .filter((c) => all || c.status === 'open' || picked(c))
        .sort((a, c) => (all ? a.t - c.t : noteRank(a) - noteRank(c) || a.t - c.t));
      const list = kept.filter(changed);
      await b.fetchShots(review, list);
      // What each note points at in its version's elements map (" · on #card"), the names once in the header.
      const pointers = await b.pointers(review, list);
      const lines = (l: typeof list) => l.map((c) => noteLines(b, review, c, { files, pointer: pointerIn(pointers, c.id) })).join('\n\n');
      let body: string;
      if (all) body = list.length ? lines(list) : after === null ? 'No notes.' : 'No note changed.';
      else {
        // Required work first; ideas and open questions are separate so they are never mistaken for work items.
        const open = list.filter((c) => !picked(c));
        const required = open.filter(isRequired);
        const ideas = open.filter(isIdea);
        const questions = open.filter(isQuestion);
        const picks = list.filter(picked);
        const parts = [required.length ? lines(required) : after === null ? 'No open notes.' : 'No open work item changed.'];
        if (ideas.length) parts.push(`Ideas (optional — your call): suggestions to consider, not required changes.\n\n${lines(ideas)}`);
        if (questions.length) parts.push(`Questions to the reviewer, not answered yet: no work item; wait for the answer.\n\n${lines(questions)}`);
        if (picks.length) parts.push(`Picked since the last render: render with these.\n\n${lines(picks)}`);
        list.splice(0, list.length, ...required, ...ideas, ...questions, ...picks);
        body = parts.join('\n\n');
      }
      if (after !== null) {
        const same = kept.filter((c) => !changed(c));
        const closed = all ? [] : review.comments.filter((c) => c.status !== 'open' && changed(c));
        if (same.length) body += `\n\nUnchanged since ${since}: ${same.map((c) => c.id).join(', ')}`;
        if (closed.length) body += `\nNo longer open: ${closed.map((c) => `${c.id} ${c.status}`).join(', ')}`;
      }
      const shown = mode === 'drawn' ? list.filter((c) => c.drawing?.length) : mode === 'all' ? list : [];
      // Where the screenshots are: the old answer's paths once (images: all), else get_note's business.
      let frames = '';
      if (list.length && mode === 'all') frames = files ? screenshotsLine(b, review) : '';
      else if (list.length)
        frames = `\nframes: ${shown.length ? 'notes with a drawing below, cropped to it; ' : ''}get_note <id> shows a note in full (its frames${files ? ' and files' : ''})`;
      const legend = legendLine(Object.values(pointers.notes), pointers.names);
      const content = [text(`${header(review, b.stage(review), legend)}${await playbookPointer(b, review)}${frames}\n\n${body}\n\nas of ${asOf}`)];
      // The same notes as data, for a client that reads it: what each points at, and where a part render may go.
      const notes = list.map((c) => {
        const part = partOk(review.versions, c);
        return { id: c.id, ...pointerFields(pointerIn(pointers, c.id)), ...(part ? { part_ok: part } : {}) };
      });
      const structured = { notes, as_of: asOf };
      let budget = max_images;
      for (const c of shown) {
        if (budget <= 0) break;
        if (mode === 'drawn') {
          const pic = await markedPicture(b, review, c);
          if (pic.length) budget--;
          content.push(...pic);
          continue;
        }
        const f = b.shotFile(review, c.shots?.marked);
        if (f && fs.existsSync(f)) {
          content.push(text(`${c.id} · ${c.timecode} · f${c.frame} · v${c.v} (marked frame, downscaled; coordinates stay in video px)`));
          content.push(await preview(b, f, previewWidth(review)));
          budget--;
        }
        // A note about a stretch: its frames across the range, so the motion it is about is visible.
        if (budget > 0) {
          const strip = await rangePicture(b, review, c);
          if (strip.length) budget--;
          content.push(...strip);
        }
        // What the reviewer means by "like this": the note's references, within the same budget.
        const refs = await refPictures(b, review, c, budget);
        budget -= refs.filter((x) => x.type === 'image').length;
        content.push(...refs);
      }
      const answer = { ...ok(content), structuredContent: structured };
      // nothing left to work on here (no work item, no idea, no pick to render with): the next step (mcp/toolkit.ts)
      const left = b.stage(review).stage !== 'final' && review.comments.some((c) => (c.status === 'open' && (isRequired(c) || isIdea(c))) || picked(c));
      return left ? answer : idle(answer);
    },
  );

  tool(
    'get_note',
    {
      title: 'One note in full',
      description: 'One note in full: every reply, its marked frame (clean: the untouched one too), a range as frames across it, its references as pictures.',
      inputSchema: z.object({ id: z.string(), clean: z.boolean().optional() }),
    },
    async ({ id, clean = false }) => {
      const hit = await b.findComment(id);
      if (!hit) {
        // A question asked on a folder before any render (lib/asks.ts): no video, no frames — its options and answers.
        const ask = await b.askView(id);
        if (!ask) throw new Error(`no note ${id}`);
        return ok(text(askLines(ask)));
      }
      const { review, comment: c } = hit;
      await b.fetchShots(review, [c]);
      const pointers = await b.pointers(review, [c]);
      const legend = legendLine(Object.values(pointers.notes), pointers.names);
      const content = [
        text(
          `${header(review, b.stage(review), legend)}${await playbookPointer(b, review)}\n\n${noteLines(b, review, c, { full: true, files: o.principal.via === 'local', pointer: pointerIn(pointers, c.id) })}`,
        ),
      ];
      const frames: [string, string | null][] = [['marked', b.shotFile(review, c.shots?.marked)]];
      if (clean) frames.push(['clean', b.shotFile(review, c.shots?.clean)]);
      for (const [kind, f] of frames)
        if (f && fs.existsSync(f)) {
          content.push(text(`${kind} frame`));
          content.push(await preview(b, f, previewWidth(review)));
        }
      content.push(...(await rangePicture(b, review, c)));
      content.push(...(await refPictures(b, review, c)));
      return ok(content);
    },
  );

  tool(
    'get_frame',
    {
      title: 'Look at an exact frame',
      description: 'One exact frame as an image: frame, timecode (mm:ss:ff) or seconds; v for an older version.',
      inputSchema: z.object({
        video: z.string(),
        frame: z.number().int().min(0).optional(),
        timecode: z.string().optional(),
        seconds: z.number().min(0).optional(),
        v: z.number().int().min(1).optional(),
      }),
    },
    async (args) => {
      const { review } = await openReview(args.video);
      const ver = pickVersion(review, args.v);
      const frame = framePosition(args, ver.fps);
      if (frame === null || !Number.isFinite(frame)) throw new Error('give frame, timecode (mm:ss:ff) or seconds');
      if (frame < 0 || frame >= ver.frames) throw new Error(`frame ${frame} is outside 0–${ver.frames - 1}`);
      const png = await b.frame(review, ver, frame, { count: o.frameGrabs });
      return ok(
        text(
          oneLine(
            `${path.basename(review.video)} · v${ver.v} · f${frame} · ${timecode(frame, ver.fps)} · ${ver.width}×${ver.height} (downscaled; coordinates in video px)`,
          ),
        ),
        await preview(b, png, previewWidth(ver)),
      );
    },
  );

  tool(
    'get_taste',
    {
      title: "The reviewer's taste for a project",
      description:
        'What the reviewer loved, keeps asking for, accepted and refused on a project, from all its notes. Read it before rendering. A video (its project) or a folder; known: the stamp of the taste you have → only whether it changed.',
      inputSchema: z.object({ video: z.string().optional(), folder: folderName.optional(), known: z.string().optional() }),
    },
    async ({ video, folder, known }) => {
      if (!video && !folder) throw new Error('give video or folder');
      const scope = video ? scopeOf((await openReview(video)).review) : { folder };
      const { taste: t, file } = await b.taste(scope);
      // What is open right now is get_open_notes' answer (per video, with the frames): here only how many.
      const md = t.markdown.replace(/\n## Open right now \((\d+)\)\n[\s\S]*?(?=\n## |$)/, (_, n) => `\n## Open right now: ${n} (get_open_notes per video)\n`);
      // The taste is deterministic (same notes → same markdown), so its hash says whether anything changed.
      const stamp = `taste ${crypto.createHash('sha1').update(md).digest('hex').slice(0, 8)}`;
      if (known && known.trim().replace(/^taste\s+/, '') === stamp.slice(6)) return ok(text(`Unchanged (${stamp}): what you read still applies.`));
      return ok(text(`${md.trimEnd()}\n\n${stamp}${o.principal.via === 'local' ? ` (saved to ${file})` : ''}`));
    },
  );

  tool(
    'get_transcript',
    {
      title: 'What is said in a video',
      description:
        'What is said in a render, line by line with timecodes and frames (or words, srt, vtt): finds the line a CHANGE WORDS note means. The first call per render can take a while.',
      inputSchema: z.object({
        video: z.string(),
        v: z.number().int().min(1).optional(),
        format: z.enum(['lines', 'words', 'srt', 'vtt']).optional(),
      }),
    },
    async ({ video, v, format = 'lines' }) => {
      const { review } = await openReview(video);
      const ver = pickVersion(review, v);
      const t = await b.transcript(review, ver, {});
      if (format === 'srt') return ok(text(toSrt(t)));
      if (format === 'vtt') return ok(text(toVtt(t)));
      const head = oneLine(
        `${path.basename(review.video)} · v${ver.v} · ${ver.fps} fps · ${t.language || 'language not reported'} · ${t.timing === 'word' ? 'word timings from the engine' : 'the engine timed lines only: word times are spread over each line'}`,
      );
      if (!t.words.length) return ok(text(`${head}\nNothing is said in this render (no voice).`));
      const body =
        format === 'words'
          ? t.words.map((w) => `${timecode(w.f0, t.fps)} f${w.f0}–f${w.f1}  ${oneLine(w.text)}`)
          : t.lines.map((l) => `${timecode(l.f0, t.fps)}–${timecode(l.f1, t.fps)} (f${l.f0}–f${l.f1})  ${oneLine(l.text)}`);
      return ok(text(`${head}\n${body.join('\n')}`));
    },
  );

  tool(
    'list_folders',
    {
      title: 'Project/folder tree',
      description: 'The folder tree with video and open-note counts.',
      // archived projects too: accepted, not announced (mcp/lean.ts)
      inputSchema: z.object({ archived: z.boolean().optional().meta({ hidden: true }) }),
    },
    async ({ archived }) => {
      // archived projects (and what is in them) only when asked
      const shut = await b.archivedProjects();
      const reviews = forAgents(await b.listReviews()).filter((r) => !r.archived && (archived || !archivedIn(r.folder, shut)));
      const folders = (await b.folders(reviews)).filter((f) => archived || !archivedIn(f, shut));
      const inside = (f: string) => reviews.filter((r) => r.folder && (r.folder === f || r.folder.startsWith(`${f}/`)));
      const lines = folders.map((f) => {
        const l = inside(f);
        // a folder's name is a person's (or an agent's: organize): one line, whatever it holds
        return oneLine(
          `${'  '.repeat(f.split('/').length - 1)}${f.split('/').at(-1)}  (${l.length} video${l.length === 1 ? '' : 's'}, ${l.reduce((s, r) => s + counts(r).open, 0)} open)  [${f}]${archivedIn(f, shut) === f ? '  archived' : ''}`,
        );
      });
      const unsorted = reviews.filter((r) => !r.folder).length;
      if (unsorted) lines.push(`Unsorted  (${unsorted})`);
      const answer = ok(text(lines.join('\n') || 'No folders yet.'));
      // nothing open anywhere (an empty project waits for its V1): the next step (mcp/toolkit.ts)
      return reviews.some((r) => counts(r).open > 0 && b.stage(r).stage !== 'final') ? answer : idle(answer);
    },
  );
}
