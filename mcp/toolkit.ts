// What every group of MCP tools is built with: the server, the backend, who is calling, and the two rules all tools
// share — a tool runs only if the caller's role (and OAuth scopes) allow its entry in TOOL_ACCESS, and a write is
// attributed to the right author.
import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import { type ActivityRecord, processAgent } from '../lib/activity.ts';
import { agentName, ownedAgentName, toolActivity } from '../lib/activityText.ts';
import type { OptionTarget } from '../lib/askOptions.ts';
import type { Backend } from '../lib/backend/types.ts';
import { byName } from '../lib/inputs.ts';
import { cleanAuthor, wellFormed } from '../lib/names.ts';
import { isoLocal } from '../lib/paths.ts';
import type { PreviewTarget } from '../lib/previews.ts';
import { publicMessage } from '../lib/publicError.ts';
import type { RefTarget } from '../lib/refs.ts';
import { currentSession } from '../lib/sessions.ts';
import type { GrabCount } from '../lib/shots.ts';
import type { OptionGroup, Review, ReviewEvent } from '../lib/types.ts';
import { allowed, audienceOf, type Principal, TOOL_ACCESS } from './access.ts';
import type { Hold, Quiet, Told, Wake } from './feedback.ts';
import { clientName, fail } from './format.ts';
import { toolFilter, trimmed } from './lean.ts';

export interface ReviewServerOptions {
  backend: Backend;
  principal: Principal;
  /** Stdio inside a Claude Code session: attribute writes to that session (never for a shared HTTP server). */
  sessionAuthor?: boolean;
  /** Resolves early when new events may exist; wait_for_feedback re-checks either way. Default: plain polling. */
  wake?: Wake;
  /** A wait's place among those the server holds (caps per caller and workspace); absent: no cap (stdio). */
  hold?: Hold;
  /** Whether the caller would still get in (token, account, membership): asked again before a wait hands out events. */
  stillAllowed?: () => boolean;
  /** The web UI's origin for "open in player" links and the MCP App's media (null when unknown). */
  appUrl?: string | null;
  /** How events leave this server (hosted: screenshot paths become URLs). */
  publicEvent?: (e: ReviewEvent) => ReviewEvent;
  /** The inbox as this client may see it (hosted: rendered with screenshot URLs); default: the backend's INBOX.md. */
  inboxMarkdown?: () => Promise<string>;
  /** The HTTP server hands out one-time upload URLs (`request_upload`); absent over stdio, where `vr push` exists. */
  requestUpload?: (input: { filename: string; folder?: string | null; slug?: string | null; part_at?: number; handles?: number }) => {
    url: string;
    expires: string;
  };
  /** The same for a fix preview (`attach_preview` without a file): attributed to `by`. */
  requestPreviewUpload?: (target: PreviewTarget, by: string) => { url: string; expires: string };
  /** The same for an image or clip reference on a note (`attach_reference` without a file): attributed to `by`. */
  requestRefUpload?: (target: RefTarget, by: string) => { url: string; expires: string };
  /**
   * The same for the file of an item a question with options offers (`ask_options` with `upload`): attributed to `by`;
   * `offered` = the question's options while it isn't written yet (its URLs come first).
   */
  requestOptionUpload?: (target: OptionTarget, by: string, offered?: OptionGroup[]) => { url: string; expires: string };
  /** Takes back an upload URL handed out for something that wasn't made after all. */
  dropUpload?: (url: string) => void;
  /** Where this server's source is (AGPL-3.0 §13), announced as the implementation's website. */
  sourceUrl?: string | null;
  /** Which tools to offer: `all` (default), `lean` (the review loop only) or a comma-separated list; default VR_MCP_TOOLS. */
  tools?: string | null;
  /** Each tool call an agent makes, as live activity for the UI (lib/activity.ts): no extra tokens, the call itself. */
  activity?: (a: ActivityRecord) => void;
  /** The caller's new frames, counted per account (`get_frame`, like `GET /api/review/:slug/frame`); absent: not counted. */
  frameGrabs?: GrabCount;
  /**
   * A plan's upload gate (server/extension.ts `check(ws, 'upload', bytes)`), asked before a team file is taken — a
   * reference or a fix preview sent inline, or an upload URL for one — as `POST /api/comments/:id/refs|previews` ask
   * it. Rejects with the module's 402 sentence; absent (stdio, no module): everything may be uploaded.
   */
  checkUpload?: (bytes: number) => Promise<void>;
  /**
   * The agent this connection is, as the app lists it under connected agents and a video is assigned to it (over HTTP:
   * server/routes/mcp.ts). `session: "me"` and the first wait's "waiting for you" go by it; over stdio inside a Claude
   * Code session the session itself is (lib/sessions.ts currentSession).
   */
  me?: { name: string; sessionId: string | null } | null;
  /** A wait_for_feedback started: the app shows the agent as listening until the release (server/agents.ts). */
  onWait?: () => (o?: { handed?: boolean }) => void;
  /** What a wait already told this agent was waiting for it (mcp/feedback.ts Told): each thing once. */
  told?: Told;
  /** How long this agent has heard only "no new feedback" in a row (mcp/feedback.ts Quiet): after 30 min, stop. */
  quiet?: Quiet;
  /** One line per tool call: the tool, how long it took, how it ended — never what it was given or said. */
  log?: (line: string) => void;
  /**
   * Why nothing may be written now (the workspace is suspended by the server's operator: server/permissions.ts), or
   * null: a tool that writes answers with it; reading goes on. Asked at every call.
   */
  readOnly?: () => string | null;
}

export interface ToolKit {
  server: McpServer;
  b: Backend;
  o: ReviewServerOptions;
  /** Registers a tool guarded by its TOOL_ACCESS entry; errors become tool results, so a bad id never breaks a session. */
  tool<S extends z.ZodObject>(
    name: string,
    config: { title: string; description: string; inputSchema: S },
    fn: (args: z.output<S>, ctx: ServerContext) => Promise<CallToolResult>,
  ): void;
  /** Who a write is attributed to. */
  author(by: string | undefined, ctx: ServerContext): string;
  /** The account to record with a write by `who`: the principal's, when it writes as itself. */
  accountOf(who: string): string | undefined;
  openReview(video: string): Promise<{ slug: string; review: Review }>;
  /** The optional `by` argument of every write: accepted, not announced (the default author is right; mcp/lean.ts). */
  byArg: z.ZodOptional<z.ZodString>;
  /** Whether this server offers a tool (the `tools` option). */
  offers(name: string): boolean;
  /** Records a call as live activity, for tools registered outside `tool` (the wait, the review card). */
  activity(name: string, args: Record<string, unknown>, ctx: ServerContext): void;
  /** The agent this connection is (`session: "me"`): null when the server can't tell (a client nobody assigns to). */
  me(): { name: string | null; sessionId: string | null } | null;
}

export function createToolKit(server: McpServer, o: ReviewServerOptions): ToolKit {
  const b = o.backend;
  const offers = toolFilter(o.tools ?? process.env.VR_MCP_TOOLS);

  function tool<S extends z.ZodObject>(
    name: string,
    config: { title: string; description: string; inputSchema: S },
    fn: (args: z.output<S>, ctx: ServerContext) => Promise<CallToolResult>,
  ): void {
    const access = TOOL_ACCESS[name];
    if (!access) throw new Error(`${name} is missing from TOOL_ACCESS`);
    if (!offers(name)) return;
    const annotations =
      access === 'view' ? { readOnlyHint: true, openWorldHint: false } : { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
    const cb = async (args: z.output<S>, ctx: ServerContext): Promise<CallToolResult> => {
      const started = Date.now();
      const out = await run(args, ctx);
      o.log?.(`${name} ${out.isError ? 'error' : 'ok'} ${took(started)}`);
      return out;
    };
    const run = async (args: z.output<S>, ctx: ServerContext): Promise<CallToolResult> => {
      if (!allowed(o.principal, access)) return fail(`your role (${o.principal.role}) may not ${name.replace(/_/g, ' ')}`);
      const frozen = access === 'view' ? null : (o.readOnly?.() ?? null);
      if (frozen) return fail(frozen);
      try {
        // as the HTTP API's bodies (server/http.ts parse): no lone surrogate goes into a name, a label or a note
        const given = wellFormed(args);
        const out = await fn(given, ctx);
        if (!out.isError) noteActivity(name, given as Record<string, unknown>, ctx);
        return out;
      } catch (e) {
        return fail(publicMessage(e, audienceOf(o.principal), { status: 400, where: `mcp ${name}` }));
      }
    };
    // The SDK's overloads are conditional on the schema type; for a generic schema TypeScript cannot pick one.
    (server.registerTool as (n: string, c: object, cb: unknown) => unknown)(name, { ...config, inputSchema: trimmed(config.inputSchema), annotations }, cb);
  }

  // Author for writes: `by` (hosted: only agent:… or yourself) > VR_BY > the Claude Code session (stdio) > the client.
  function author(by: string | undefined, ctx: ServerContext): string {
    // Writing as agent:… is an 'agents' action, as in the HTTP API: a reviewer's notes can't pass for an agent's.
    const asAgent = allowed(o.principal, 'agents');
    if (by) {
      // The machine's own agent may write as anyone: as one line, short (A12-D3).
      if (o.principal.via === 'local') return cleanAuthor(by) || o.principal.name;
      if (by === o.principal.name) return by;
      if (/^agent:[\w.@ -]{1,80}$/.test(by)) {
        if (asAgent) return by;
        throw new Error(`your role (${o.principal.role}) may not write as an agent; leave by out to write as yourself`);
      }
      throw new Error('by must be agent:<name> (or your own name)');
    }
    if (!asAgent) return o.principal.name;
    const vrBy = o.principal.via === 'local' ? cleanAuthor(process.env.VR_BY || '') : '';
    if (vrBy) return vrBy;
    if (o.sessionAuthor) {
      const s = currentSession();
      const own = s?.name ? cleanAuthor(`agent:${s.name}`) : '';
      if (own) return own;
    }
    // The client's own name, as it says it: one short line like every other agent's name (A12 VA2-5).
    return cleanAuthor(`agent:${clientName(server, ctx).replace(/[^\w.@-]+/g, '-')}`) || 'agent:mcp';
  }

  // Who is calling, by the name the app lists it under, the same for every call of the connection (a `by` on some
  // writes doesn't split it): the Claude Code session or VR_BY for the stdio server, else the MCP client as a
  // connected agent is named (server/routes/mcp.ts).
  function activityName(ctx: ServerContext): string | null {
    if (o.sessionAuthor) {
      const own = processAgent();
      if (own) return own;
    }
    const app = clientName(server, ctx);
    return o.principal.via !== 'local' && o.principal.name ? ownedAgentName(app, o.principal.name) : agentName(app);
  }

  // What the agent just did, in plain words, for the UI's live view. Only agents' calls (a person's MCP client reading
  // notes is not agent activity), and never a failure of its own to break the tool.
  function noteActivity(name: string, args: Record<string, unknown>, ctx: ServerContext) {
    if (!o.activity) return;
    try {
      if (!allowed(o.principal, 'agents') && o.principal.via !== 'local') return;
      const guess = toolActivity(name, args);
      if (!guess) return;
      const agent = activityName(ctx);
      if (!agent) return;
      o.activity?.({ ...guess, at: isoLocal(), agent, target: guess.target ?? null, video: guess.video ?? null });
    } catch {}
  }

  async function openReview(video: string): Promise<{ slug: string; review: Review }> {
    const { slug } = await b.resolve(video);
    return { slug, review: await b.review(slug) };
  }

  const accountOf = (who: string): string | undefined => (who === o.principal.name ? o.principal.id : undefined);

  return {
    server,
    b,
    o,
    tool,
    author,
    accountOf,
    openReview,
    offers,
    byArg: byName.optional().meta({ hidden: true }),
    activity: noteActivity,
    me: () => meOf(o),
  };
}

/** The agent a connection is (ReviewServerOptions.me), else the Claude Code session the stdio server runs in. */
export function meOf(o: Pick<ReviewServerOptions, 'me' | 'sessionAuthor'>): { name: string | null; sessionId: string | null } | null {
  if (o.me) return o.me;
  const s = o.sessionAuthor ? currentSession() : null;
  return s && (s.name || s.sessionId) ? { name: s.name, sessionId: s.sessionId } : null;
}

/** "0.21s" — how long a call took, for the log. */
export const took = (since: number): string => `${((Date.now() - since) / 1000).toFixed(2)}s`;
