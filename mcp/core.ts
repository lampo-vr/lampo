// The review tools and resources every MCP transport serves: stdio (bin/lampo-mcp — one agent on this machine, or a
// hosted server behind `lampo login`) and Streamable HTTP (/mcp in the app — any client with a URL). One factory builds
// the server; the SDK calls it per HTTP request (2026-07-28 is stateless) or once per stdio connection.
//   access.ts   who may call what (TOOL_ACCESS, the permission table)
//   toolkit.ts  the options and the shared tool wrapper (access check, errors as results, authorship)
//   tools/      the tools: read.ts, notes.ts, videos.ts, footage.ts; feedback.ts (wait_for_feedback), app.ts (the MCP App card)
//   format.ts   what the tools say: note lines, headers, downscaled frames
//   follow.ts   change notifications over stdio (over HTTP, server/routes/mcp.ts sends them from the app's feed)
import fs from 'node:fs';
import path from 'node:path';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { archivedIn } from '../lib/archived.ts';
import { BRAND_NAME } from '../lib/brand.ts';
import { MCP_NAME } from '../lib/mcpConfig.ts';
import { forAgents } from '../lib/onboarding.ts';
import { slugify } from '../lib/paths.ts';
import { publicMessage } from '../lib/publicError.ts';
import { keepLines } from '../lib/time.ts';
import { allowed, audienceOf, backendFor } from './access.ts';
import { registerReviewApp } from './app.ts';
import { registerFeedback } from './feedback.ts';
import { INBOX_URI, markedPicture, OLD_INBOX_URI, preview, reviewUri } from './format.ts';
import { instructionsFor, WATCH_PROMPT, watchPromptText, wayOf } from './loop.ts';
import { createToolKit, type ReviewServerOptions } from './toolkit.ts';
import { registerAskTools } from './tools/asks.ts';
import { registerFootageTools } from './tools/footage.ts';
import { registerNoteTools } from './tools/notes.ts';
import { registerPlaybookTools } from './tools/playbooks.ts';
import { registerPostTools } from './tools/posts.ts';
import { registerReadingTools } from './tools/read.ts';
import { registerVideoTools } from './tools/videos.ts';

export { type Access, allowed, backendFor, hintsFor, MCP_SCOPES, NO_FILES, OVERWRITES, type Principal, TOOL_ACCESS, type ToolHints } from './access.ts';
export { changedUris, reviewUri } from './format.ts';
export { type AgentWay, instructionsFor, WATCH_PROMPT, watchPromptText, wayOf } from './loop.ts';
export type { ReviewServerOptions } from './toolkit.ts';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
export const SERVER_VERSION = pkg.version || '0.0.0';

/** Builds one MCP server instance over a backend. Tools report errors as results, so a bad id never breaks a session. */
export function createReviewServer(options: ReviewServerOptions): McpServer {
  // Files on this server's disk are the machine's own business: everyone else reaches videos by name (access.ts).
  // How this agent works decides what it is told (mcp/loop.ts): the machine for `via: local`, else the MCP way.
  const o: ReviewServerOptions = {
    ...options,
    backend: backendFor(options.principal, options.backend),
    way: options.way ?? wayOf(options.principal.via, null),
  };
  const b = o.backend;
  const server = new McpServer(
    // `name` is the identifier (the key people give it in their configs, MCP_NAME); `title` is what a client shows.
    { name: MCP_NAME, title: BRAND_NAME, version: SERVER_VERSION, ...(o.sourceUrl ? { websiteUrl: o.sourceUrl } : {}) },
    {
      // Sent once per connection (every tool description goes on every turn): the loop, told the way this agent works.
      instructions: instructionsFor(o.way ?? 'chat'),
      capabilities: { resources: { subscribe: true, listChanged: true } },
      cacheHints: { 'tools/list': { ttlMs: 3_600_000, cacheScope: 'private' } },
    },
  );

  const kit = createToolKit(server, o);
  registerReadingTools(kit);
  registerNoteTools(kit);
  registerAskTools(kit);
  registerVideoTools(kit);
  registerPlaybookTools(kit);
  registerPostTools(kit);
  registerFootageTools(kit);
  if (kit.offers('wait_for_feedback'))
    registerFeedback(server, {
      backend: b,
      wake: o.wake,
      hold: o.hold,
      stillAllowed: o.stillAllowed,
      preview: (f, w) => preview(b, f, w),
      drawn: async (id) => {
        const hit = await b.findComment(id);
        if (!hit?.comment.drawing?.length) return [];
        await b.fetchShots(hit.review, [hit.comment]);
        return markedPicture(b, hit.review, hit.comment);
      },
      allowed: allowed(o.principal, 'view'),
      audience: audienceOf(o.principal),
      publicEvent: o.publicEvent,
      activity: (args, ctx) => kit.activity('wait_for_feedback', args, ctx),
      ...(o.handed ? { handed: (slugs: string[], ctx: Parameters<typeof kit.agentName>[0]) => kit.handed(slugs, ctx) } : {}),
      me: kit.me,
      told: o.told,
      quiet: o.quiet,
      onWait: o.onWait,
      log: o.log,
      chat: o.way === 'chat',
    });
  if (kit.offers('wait_for_feedback')) registerWatchPrompt(server, o.log);
  if (kit.offers('show_review'))
    registerReviewApp(server, {
      backend: b,
      appUrl: o.appUrl ?? null,
      preview: (f, w) => preview(b, f, w),
      principal: o.principal,
      allowed: (a) => allowed(o.principal, a),
      activity: kit.activity,
      frameGrabs: o.frameGrabs,
    });

  const readInbox = async (uri: URL) => {
    // A failure reading it goes out by audience, as a review's does.
    const text = await (o.inboxMarkdown ?? b.inboxMarkdown)().catch((e: unknown) => {
      throw new Error(publicMessage(e, audienceOf(o.principal), { status: 500, where: 'mcp lampo://inbox' }));
    });
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: keepLines(text) }] };
  };
  const readReview = async (uri: URL, { slug }: { slug?: string | string[] }) => {
    const s = decodeURIComponent(String(slug));
    // Where the assigned agent works is for those who work with agents, as over HTTP (server/helpers.ts agentView).
    const text = await b.reviewMarkdown(s, { agentDetails: allowed(o.principal, 'agents') }).catch((e: unknown) => {
      throw new Error(publicMessage(e, audienceOf(o.principal), { status: 404, where: 'mcp lampo://review' }));
    });
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: keepLines(text) }] };
  };

  server.registerResource(
    'inbox',
    INBOX_URI,
    {
      title: 'Review inbox',
      description: 'Newest human feedback across all videos (INBOX.md). Subscribe to hear about new feedback.',
      mimeType: 'text/markdown',
    },
    readInbox,
  );

  server.registerResource(
    'review',
    new ResourceTemplate('lampo://review/{slug}', {
      list: async () => {
        // archived projects are put away: their videos are read by name, not listed
        const shut = await b.archivedProjects();
        return {
          resources: forAgents(await b.listReviews())
            .filter((r) => !r.archived && !archivedIn(r.folder, shut))
            .map((r) => ({
              uri: reviewUri(slugify(r.video)),
              name: path.basename(r.video),
              description: r.folder || r.project,
              mimeType: 'text/markdown',
            })),
        };
      },
    }),
    {
      title: 'Review summary',
      description: 'review.md of one video: open items, fixed-awaiting-verification, closed, versions. Subscribe to hear about changes.',
      mimeType: 'text/markdown',
    },
    readReview,
  );

  // The addresses from before the command was `lampo`: a client set up then still reads them (templates without a
  // list, so neither shows twice among the resources).
  server.registerResource(
    'inbox-vr',
    new ResourceTemplate(OLD_INBOX_URI, { list: undefined }),
    { title: 'Review inbox', mimeType: 'text/markdown' },
    readInbox,
  );
  server.registerResource(
    'review-vr',
    new ResourceTemplate('vr://review/{slug}', { list: undefined }),
    { title: 'Review summary', mimeType: 'text/markdown' },
    readReview,
  );

  return server;
}

function registerWatchPrompt(server: McpServer, log?: (line: string) => void): void {
  server.registerPrompt(
    WATCH_PROMPT,
    {
      title: `Work on ${BRAND_NAME} notes and keep listening`,
      description: `Works the notes on the videos assigned to you in ${BRAND_NAME}, then waits for new ones until you say stop.`,
      argsSchema: z.object({ video: z.string().max(1000).optional().describe('only this video (its name)') }),
    },
    ({ video }) => {
      log?.(`prompt ${WATCH_PROMPT}`);
      return { messages: [{ role: 'user', content: { type: 'text', text: keepLines(watchPromptText(video)) } }] };
    },
  );
}
