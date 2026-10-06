// The review as an MCP App: hosts that support the `io.modelcontextprotocol/ui` extension (Claude, ChatGPT, VS Code,
// Goose, …) render an interactive card inline — the frame with its drawing, the notes, frame stepping, reply and
// "mark fixed". Frames travel as images through the tool bridge (review_frame), so the card needs no network access,
// no media URLs and no auth of its own; every other host gets the same content as text + an image.
import fs from 'node:fs';
import path from 'node:path';
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Backend } from '../lib/backend/types.ts';
import { ROOT, slugify } from '../lib/paths.ts';
import { routeIn } from '../lib/scope.ts';
import { counts } from '../lib/store.ts';
import { isAgent, noteKind, oneLine, timecode } from '../lib/time.ts';
import type { Comment, Review, Version } from '../lib/types.ts';

// What the card calls a note: its severity for feedback, else what it is (older agent notes read as questions).
const label = (c: Comment): string => {
  const kind = noteKind(c);
  return kind === 'feedback' ? c.severity : kind === 'agent' ? 'question' : kind;
};

import { publicMessage } from '../lib/publicError.ts';
import { type Access, audienceOf, type Principal } from './access.ts';
import { text } from './format.ts';
import { trimmed } from './lean.ts';

// The card's address keeps `video-review` now that the MCP name is lampo, like the `vr://` resources: hosts may hold
// the UI resource by its URI (tools name it in `_meta.ui.resourceUri`), and no person ever reads it.
export const APP_URI = 'ui://video-review/review.html';
const BUILT = path.join(ROOT, 'web', 'dist-mcp', 'review.html');

export interface ReviewAppOptions {
  backend: Backend;
  appUrl: string | null;
  preview: (file: string, width: number) => Promise<{ type: 'image'; data: string; mimeType: string }>;
  principal: Principal;
  allowed: (a: Access) => boolean;
  /** The agent showing a review, as live activity (the card stepping frames is the person, not the agent). */
  activity?: (tool: string, args: Record<string, unknown>, ctx: ServerContext) => void;
}

/** The data the card renders (also the tool's structuredContent, so any host can use it). */
export interface ReviewCard {
  video: string;
  slug: string;
  name: string;
  v: number;
  versions: number[];
  fps: number;
  frames: number;
  width: number;
  height: number;
  counts: { open: number; must: number; fixed: number; done: number };
  notes: {
    id: string;
    status: string;
    severity: string;
    frame: number;
    timecode: string;
    text: string;
    author: string;
    agent: boolean;
    v: number;
    replies: { by: string; text: string; status: string | null }[];
  }[];
  selected: string | null;
  still: FrameStill;
  playerUrl: string | null;
  canAct: boolean;
  canComment: boolean;
}

export interface FrameStill {
  frame: number;
  timecode: string;
  v: number;
  /** "marked" = the note's screenshot with its drawing, "clean" = the exact frame grabbed now. */
  kind: 'marked' | 'clean';
  note: string | null;
  image: string;
}

export function registerReviewApp(server: McpServer, o: ReviewAppOptions): void {
  const b = o.backend;

  async function still(review: Review, ver: Version, frame: number, noteId: string | null): Promise<FrameStill> {
    const note = noteId ? review.comments.find((c) => c.id === noteId) : null;
    if (note) {
      await b.fetchShots(review, [note]);
      const f = b.shotFile(review, note.shots?.marked);
      if (f && fs.existsSync(f)) {
        const img = await o.preview(f, 960);
        return { frame: note.frame, timecode: note.timecode, v: note.v, kind: 'marked', note: note.id, image: `data:${img.mimeType};base64,${img.data}` };
      }
    }
    const png = await b.frame(review, ver, frame);
    const img = await o.preview(png, 960);
    return { frame, timecode: timecode(frame, ver.fps), v: ver.v, kind: 'clean', note: null, image: `data:${img.mimeType};base64,${img.data}` };
  }

  function card(review: Review, ver: Version, s: FrameStill, selected: string | null): ReviewCard {
    const slug = slugify(review.video);
    const n = counts(review);
    return {
      video: review.video,
      slug,
      name: path.basename(review.video),
      v: ver.v,
      versions: review.versions.map((x) => x.v),
      fps: ver.fps,
      frames: ver.frames,
      width: ver.width,
      height: ver.height,
      counts: { open: n.open, must: n.must, fixed: n.fixed, done: n.done },
      notes: review.comments
        .filter((c) => c.status === 'open' || c.status === 'fixed')
        .sort((a, c) => a.t - c.t)
        .map((c) => ({
          id: c.id,
          status: c.status,
          severity: label(c),
          frame: c.frame,
          timecode: c.timecode,
          text: c.text,
          author: c.author,
          agent: isAgent(c.author),
          v: c.v,
          replies: (c.replies || []).slice(-3).map((r) => ({ by: r.by, text: r.text || '', status: r.status || null })),
        })),
      selected,
      still: s,
      playerUrl: o.appUrl ? `${o.appUrl}/${routeIn(`#/v/${encodeURIComponent(slug)}?f=${s.frame}`)}` : null,
      canAct: o.allowed('resolve'),
      canComment: o.allowed('comment'),
    };
  }

  async function load(video: string, v?: number): Promise<{ review: Review; ver: Version }> {
    const { slug } = await b.resolve(video);
    const review = await b.review(slug);
    const ver = v ? review.versions.find((x) => x.v === v) : review.versions.at(-1);
    if (!ver) throw new Error(`no v${v}`);
    return { review, ver };
  }

  const guard = async (fn: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    if (!o.allowed('view')) return { content: [{ type: 'text', text: 'Error: your role may not read reviews' }], isError: true };
    try {
      return await fn();
    } catch (e) {
      return {
        content: [text(`Error: ${publicMessage(e, audienceOf(o.principal), { status: 400, where: 'mcp show_review' })}`)],
        isError: true,
      };
    }
  };

  registerAppTool(
    server,
    'show_review',
    {
      title: 'Show a review',
      description:
        "Shows the person you work with one video's review as an interactive card (in hosts with MCP Apps): frame, drawing, open notes. Only when they want to look together; for your own work get_open_notes is enough.",
      inputSchema: trimmed(
        z.object({
          video: z.string(),
          note: z.string().optional(),
          frame: z.number().int().min(0).optional(),
        }),
      ),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: APP_URI } },
    },
    async ({ video, note, frame }, ctx: ServerContext) =>
      guard(async () => {
        const { review, ver } = await load(video);
        o.activity?.('show_review', { video }, ctx);
        const first = review.comments.filter((c) => c.status === 'open').sort((a, c) => a.t - c.t)[0];
        const pick = note ?? (frame === undefined ? first?.id : undefined) ?? null;
        const s = await still(review, ver, frame ?? review.comments.find((c) => c.id === pick)?.frame ?? 0, pick);
        const c = card(review, ver, s, pick);
        const lines = [
          `${c.name} · v${c.v} · ${c.width}×${c.height} · ${c.fps} fps · open ${c.counts.open} (must ${c.counts.must}) · fixed ${c.counts.fixed}`,
          ...c.notes.map((n) => `${n.id} ${n.status.toUpperCase()} ${n.severity.toUpperCase()} ${n.timecode} f${n.frame} — ${n.text || '(drawing only)'}`),
          c.playerUrl ? `Open in the player: ${c.playerUrl}` : '',
        ]
          .filter(Boolean)
          // a note's text is a person's (a client's, on a review link): it never starts a line of its own
          .map(oneLine);
        const [, mime, data] = /^data:([^;]+);base64,(.*)$/.exec(s.image) || [];
        return {
          content: [text(lines.join('\n')), ...(data ? [{ type: 'image' as const, data, mimeType: mime }] : [])],
          structuredContent: c as unknown as Record<string, unknown>,
        };
      }),
  );

  registerAppTool(
    server,
    'review_frame',
    {
      title: 'Frame for the review card',
      description: 'For the review card only: one frame as an image.',
      inputSchema: trimmed(
        z.object({
          video: z.string(),
          frame: z.number().int().min(0).optional(),
          note: z.string().optional(),
          v: z.number().int().min(1).optional(),
        }),
      ),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: APP_URI, visibility: ['app'] } },
    },
    async ({ video, frame, note, v }) =>
      guard(async () => {
        const { review, ver } = await load(video, v);
        const at = Math.max(0, Math.min(ver.frames - 1, frame ?? review.comments.find((c) => c.id === note)?.frame ?? 0));
        const s = await still(review, ver, at, note ?? null);
        return { content: [{ type: 'text', text: `f${s.frame} · ${s.timecode} · v${s.v}` }], structuredContent: s as unknown as Record<string, unknown> };
      }),
  );

  registerAppResource(
    server,
    'review-card',
    APP_URI,
    { title: 'Review card', description: 'Interactive review card (MCP App)', mimeType: RESOURCE_MIME_TYPE, _meta: { ui: { prefersBorder: true } } },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: appHtml(), _meta: { ui: { prefersBorder: true, csp: {} } } }],
    }),
  );
}

// Built by `npm run build` (web/mcp-app → web/dist-mcp/review.html, one self-contained file). Without a build the
// card says so instead of failing; tool results still carry text and an image.
let cached: { mtime: number; html: string } | null = null;
export function appHtml(): string {
  try {
    const st = fs.statSync(BUILT);
    if (!cached || cached.mtime !== st.mtimeMs) cached = { mtime: st.mtimeMs, html: fs.readFileSync(BUILT, 'utf8') };
    return cached.html;
  } catch {
    return '<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;background:#0b0b0c;color:#eeebe4;padding:16px">The review card is not built yet: run <code>npm run build</code> in video-review.</body>';
  }
}
