// Tools that act on videos: put a render under review (a path on this machine, or a one-time upload URL for a hosted
// server), file it into a folder, say which project it was rendered from, and show a status on its card.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ELEMENT_LIMITS, readElementMap } from '../../lib/elements.ts';
import { fileName, folderName, localPath, projectFps, sourceName, startFrame, statusText } from '../../lib/inputs.ts';
import { MAX_HANDLES } from '../../lib/part.ts';
import { seamLine } from '../../lib/parts.ts';
import { slugify } from '../../lib/paths.ts';
import { routeIn } from '../../lib/scope.ts';
import { currentSession } from '../../lib/sessions.ts';
import type { SessionInput } from '../../lib/store.ts';
import { describeSource, uploadFolder } from '../../lib/store.ts';
import { oneLine } from '../../lib/time.ts';
import type { RenderSource } from '../../lib/types.ts';
import { allowed, byPerson, NO_FILES } from '../access.ts';
import { handOff, ok, text } from '../format.ts';
import type { ToolKit } from '../toolkit.ts';

/** An elements map file on this machine: its size first, then the map checked whole (lib/elements.ts). */
function readElementMapFile(file: string) {
  const abs = path.resolve(file);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error(`no elements map at ${abs}`);
  }
  if (!st.isFile()) throw new Error(`no elements map at ${abs}`);
  if (st.size > ELEMENT_LIMITS.bytes) throw new Error('the elements map is refused: it is over 1 MB');
  return readElementMap(fs.readFileSync(abs, 'utf8'));
}

/** The app's page where a person uploads what `request_upload` was asked for: the video's (its next version), else the
 * folder's in the library (a new video there), else the library (no project). Hash routes as web/src/lib/nav.ts reads them. */
const uploadPage = (slug: string | null, folder: string | null | undefined): string => {
  if (slug) return `#/v/${encodeURIComponent(slug)}`;
  const f = uploadFolder(folder);
  return f ? `#/folder/${encodeURIComponent(f)}` : '#/';
};

export function registerVideoTools({ b, o, tool, author, accountOf, byArg, me }: ToolKit): void {
  // Tracking a path only makes sense where the file is: stdio on this machine, or the local app over loopback.
  if (o.principal.via === 'local')
    tool(
      'track_video',
      {
        title: 'Put a video under review',
        description:
          'Put a render under review (e.g. right after export), optionally into a folder and assigned to a session ("me": this one). On a hosted server it is uploaded; the same name again is its next version.',
        inputSchema: z.object({
          path: z.string().describe('absolute'),
          folder: folderName.optional().describe('e.g. "Acme/Reels" (created if new)'),
          session: z.string().optional(),
          // A partial render (only where a note says PART RENDER OK; SKILL.md): not announced, so the list stays small.
          part_of: z.string().optional().meta({ hidden: true }),
          part_at: z.number().int().min(0).optional().meta({ hidden: true }),
          handles: z.number().int().min(0).max(MAX_HANDLES).optional().meta({ hidden: true }),
          // Where the render's named elements are (an elements map, docs/agents.md): a file here, never the map inline.
          elements: localPath.optional().meta({ hidden: true }),
          by: byArg,
        }),
      },
      async ({ path: p, folder, session, part_of, part_at, handles, elements, by }, ctx) => {
        const who = author(by, ctx);
        // A path on this machine is the machine's own agent's to name (the tool exists only for it; checked again).
        if (elements !== undefined && o.principal.via !== 'local') throw new Error(NO_FILES);
        if (elements !== undefined && (part_at !== undefined || part_of)) throw new Error('a part takes no elements map: attach one to a full render');
        // Read and checked whole before the render goes anywhere.
        const map = elements !== undefined ? readElementMapFile(elements) : undefined;
        if (part_at !== undefined || part_of) {
          if (!part_of || part_at === undefined) throw new Error('a part needs part_of (the video) and part_at (the frame its stretch starts at)');
          const { slug } = await b.resolve(part_of);
          const r = await b.push(path.resolve(p), { by: who, to: slug, part: { at: part_at, ...(handles !== undefined ? { handles } : {}) } });
          const latest = r.review.versions.at(-1);
          // what the person reviews now (an unchanged one too): the last line says to wait for their notes
          const wait = await handOff(b);
          if (r.duplicate || !r.part || !latest) return ok(text(`unchanged: v${r.v} already has these bytes\n${wait}`));
          return ok(
            text(
              `v${r.v}: a part, frames ${r.part.at}–${r.part.at + r.part.frames - 1} of v${r.part.of} · ${seamLine(r.part, latest.fps)} · never final\n${wait}`,
            ),
          );
        }
        let s: SessionInput | undefined;
        if (session === 'me') {
          const me = o.sessionAuthor ? currentSession() : null;
          if (!me?.name) throw new Error('session:"me" only works when the server runs inside a Claude Code session');
          s = { name: me.name, sessionId: me.sessionId, cwd: me.cwd };
        } else if (session) s = { name: session };
        const tracked = await b.track(path.resolve(p), { by: who, byId: accountOf(who), session: s, folder });
        const { created } = tracked;
        let review = tracked.review;
        let attached = '';
        if (map) {
          // the render it was made for: one still being written settles first, so the map lands on its version
          review = await b.review(slugify(review.video), { wait: true });
          const a = await b.putElements(slugify(review.video), review.versions.at(-1)?.v, map);
          attached = ` · elements ${a.elements} on v${a.v}`;
        }
        return ok(
          text(
            `${oneLine(
              `${created ? 'added' : 'already under review'}: ${review.video} (v${review.versions.at(-1)?.v}) · folder ${review.folder || 'Unsorted'} · session ${review.session?.name || '-'}${attached}`,
            )}\n${await handOff(b)}`,
          ),
        );
      },
    );

  // Agents that reach a hosted server only through MCP but have a shell (a cloud sandbox, Codex or Claude Code signed
  // in with OAuth) upload their render with one plain PUT to a one-time URL.
  const requestUpload = o.requestUpload;
  if (requestUpload)
    tool(
      'request_upload',
      {
        title: 'Upload a render',
        description:
          'A one-time URL (15 min) to upload a render with one PUT: `curl -fT render.mp4 "<url>"`. A new video (in folder), or the next version of video. The PUT answers {slug, v, created, duplicate}, or {pending: true} for big files: then GET the URL until done. A 403 from your own sandbox or network proxy: ask the person to allow the URL’s host in their client’s network settings, or give them the app link.',
        inputSchema: z.object({
          filename: fileName.describe('e.g. "spot_v3.mp4"'),
          folder: folderName.optional(),
          video: z.string().optional().describe('an existing video this is the next version of'),
          // A partial render of `video` (only where a note says PART RENDER OK; SKILL.md): accepted, not announced.
          part_at: z.number().int().min(0).optional().meta({ hidden: true }),
          handles: z.number().int().min(0).max(MAX_HANDLES).optional().meta({ hidden: true }),
        }),
      },
      async ({ filename, folder, video, part_at, handles }) => {
        const slug = video ? (await b.resolve(video)).slug : null;
        if (part_at !== undefined && !slug) throw new Error('a part needs the video it patches (video)');
        // a new video the agent puts up (its V1) is assigned to it: the person's notes on it go to this agent
        const who = slug ? null : me();
        const t = requestUpload({
          filename,
          folder,
          slug,
          ...(who?.name ? { session: { name: who.name, sessionId: who.sessionId, ...(who.kind ? { agent: who.kind } : {}) } } : {}),
          ...(part_at !== undefined ? { part_at } : {}),
          ...(handles !== undefined ? { handles } : {}),
        });
        // The way out when the agent's own network refuses the PUT (a chat app's sandbox whose proxy doesn't let it reach
        // the media host): the person uploads the same thing in the app — on the video's page for its next version, else
        // in the folder (as the ticket names it), whose upload goes there.
        const page = o.appUrl
          ? `\n\nIf your network refuses the PUT, the person can upload it in the app: ${o.appUrl}/${routeIn(uploadPage(slug, folder))}`
          : '';
        return ok(
          text(`PUT the file to this URL once (valid until ${t.expires}):\n${t.url}\n\ncurl -fT '${filename.replace(/'/g, "'\\''")}' '${t.url}'${page}`),
        );
      },
    );

  tool(
    'move_video',
    {
      title: 'File a video into a folder',
      description: 'Move a video into a project or folder (created if new); folder "" = no project.',
      inputSchema: z.object({ video: z.string(), folder: folderName, by: byArg }),
    },
    async ({ video, folder, by }, ctx) => {
      const { slug } = await b.resolve(video);
      // out of an archived project: its owners' and admins', a person's as restoring it is — the machine's own agent,
      // never an API token's or an app's (never into one: the store refuses)
      const r = await b.move(slug, folder || null, author(by, ctx), { out: allowed(o.principal, 'archive') && byPerson(o.principal) });
      return ok(text(oneLine(`${r.video} → ${r.folder || 'Unsorted'}`)));
    },
  );

  tool(
    'set_render_source',
    {
      title: 'Say where a render came from',
      description:
        'Record the project a render came from; every note then shows its project time (to jump there and export a preview of the fix). Default: the newest version; clear: true removes it.',
      inputSchema: z.object({
        video: z.string(),
        v: z.number().int().min(1).optional(),
        app: sourceName.optional().describe('e.g. "After Effects"'),
        project: sourceName.optional().describe('file name, e.g. "spot.aep"'),
        comp: sourceName.optional().describe('comp / sequence rendered'),
        start_frame: startFrame.optional().describe('the project frame render frame 0 shows'),
        fps: projectFps.optional().describe('project fps, when not the render’s'),
        clear: z.boolean().optional(),
        by: byArg,
      }),
    },
    async ({ video, v, clear, by, app, project, comp, start_frame, fps }, ctx) => {
      const { slug } = await b.resolve(video);
      if (!clear && !app) throw new Error('give app (or clear: true)');
      const source: RenderSource | null = clear || !app ? null : { app, project, comp, start_frame, fps };
      if (source) for (const k of Object.keys(source) as (keyof RenderSource)[]) if (source[k] === undefined) delete source[k];
      const ver = await b.setSource(slug, v, source, author(by, ctx));
      return ok(text(`v${ver.v}: ${ver.source ? describeSource(ver.source) : 'source cleared'}`));
    },
  );

  tool(
    'set_status',
    {
      title: 'Show what you are doing',
      description:
        'Optional and rarely needed (people see your notes, fixes and renders as they happen): a status on the video card for a long step, e.g. "rendering v4". "" clears it; the new render does too.',
      inputSchema: z.object({
        video: z.string(),
        text: statusText,
        eta_seconds: z.number().min(0).max(86400).optional(),
        by: byArg,
      }),
    },
    async ({ video, text: t, eta_seconds, by }, ctx) => {
      const { slug } = await b.resolve(video);
      const s = await b.setStatus(slug, t ? { text: t, eta_seconds } : null, author(by, ctx));
      return ok(text(s ? oneLine(`status: "${s.text}"${s.until ? ` until ${s.until}` : ''}`) : 'status cleared'));
    },
  );
}
