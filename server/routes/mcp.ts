// MCP over Streamable HTTP at /mcp: the same tools as bin/vr-mcp for any client that takes a URL (Codex, Cursor, VS
// Code, Antigravity, Claude Code, Windsurf, Gemini CLI, Zed, …). Local mode: this machine's agents (the guard limits it to loopback
// or the LAN token, like the rest of the app). Server mode: a signed-in account — an API token (`Bearer vr_…`), or an
// app connected through OAuth (`Bearer vro_…`, bound to this endpoint, capped by its scopes; see routes/oauth.ts).
// Speaks 2026-07-28 (stateless, `subscriptions/listen`) and serves 2025 clients too.
// A client that may work as an agent shows up among the connected agents while it talks to /mcp (so a video can be
// handed to it, and "an agent is on it" shows), and can upload renders through one-time URLs (`request_upload`).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { toWebRequest } from '@modelcontextprotocol/node';
import { type AuthInfo, createMcpHandler } from '@modelcontextprotocol/server';
import type { Request, Response, Router } from 'express';
import { accountTag } from '../../lib/activityText.ts';
import { agentKindOf } from '../../lib/agentKind.ts';
import { onAccessEnded, USERS_FILE } from '../../lib/auth.ts';
import { createLocalBackend } from '../../lib/backend/local.ts';
import { cleanAgentName } from '../../lib/names.ts';
import { GRANTS_FILE, verifyAccess } from '../../lib/oauth/store.ts';
import { can } from '../../lib/permissions.ts';
import { addressKey, RateLimit, Recent } from '../../lib/rateLimit.ts';
import { currentWorkspace, DEFAULT_WORKSPACE, inWorkspace } from '../../lib/scope.ts';
import { SCOPE_LIST, scopeAllows, scopeFor } from '../../lib/scopes.ts';
import { grabCount } from '../../lib/shots.ts';
import * as store from '../../lib/store.ts';
import type { AgentKind } from '../../lib/types.ts';
import * as workspaces from '../../lib/workspaces.ts';
import { type Access, allowed, createReviewServer, type Principal, reviewUri, TOOL_ACCESS, wayOf } from '../../mcp/core.ts';
import { type Hold, type QuietRun, quietIn, toldIn, type Wake } from '../../mcp/feedback.ts';
import type { Auth } from '../auth.ts';
import { sessionOf } from '../auth.ts';
import type { ServerContext } from '../context.ts';
import { router } from '../http.ts';
import { SUSPENDED_ERROR } from '../permissions.ts';
import { type TicketGuard, type TicketIssuer, teamGuard } from '../uploadTickets.ts';
import { oauthBase, resourceMetadataUrl } from './oauth.ts';

const MAX_BODY = 1024 * 1024;
/** Requests per minute per caller: plenty for an agent loop, not for a flood. */
const PER_MINUTE = 600;
/**
 * One log line per tool call — workspace, the agent's session id, the tool, how long, how it ended (a wait also when
 * it starts) — so "the agent never got my notes" can be answered from the log. Never what a tool was given or said,
 * no names, no tokens, no addresses. `VR_MCP_LOG=off` leaves it out.
 */
const LOG_CALLS = process.env.VR_MCP_LOG !== 'off';

/** A connected agent as a request names it (announce, below). */
interface CallingAgent {
  session_id: string;
  name: string;
  /** What its client says it is: how it is told the loop (mcp/loop.ts). */
  kind: AgentKind;
}
/**
 * What one connection and one person may hold open at once: waits (`wait_for_feedback`) and `subscriptions/listen`
 * streams. A connection is what an agent connects with — an API token, an app connected through OAuth, a browser
 * session —; a person is the account, across all of them and every workspace. Each agent has its own token or app, so
 * 4 per connection and 16 per person let a person run a dozen agents that each wait or listen, while no token can hold
 * hundreds (each holds a connection). A workspace holds `perWorkspace` of each (waits share one read of its log; the
 * SDK's 1024 listen places are the backstop), and the places are shared out by role so nobody can take the ones the
 * people who run its agents need (A12-D12): a reviewer — who may wait and listen but runs no agents — holds
 * `perReviewer`, reviewers together `reviewers`, and members and reviewers together `belowAdmins`: the rest are kept
 * for the workspace's owners and admins. The machine's own agents (via local: the owner, from the machine, which can't
 * be told apart) count only towards the workspace's whole. Tests lower them.
 */
export const WAIT_LIMITS = { perCaller: 4, perPerson: 16, perReviewer: 4, perWorkspace: 64, reviewers: 16, belowAdmins: 48 };
export const LISTEN_LIMITS = { perCaller: 4, perPerson: 16, perReviewer: 4, perWorkspace: 256, reviewers: 64, belowAdmins: 192 };
type Limits = typeof WAIT_LIMITS;
/** Who an open wait or listen counts against (keys of the maps below; null: not counted that way), and in what role. */
interface Holder {
  caller: string | null;
  person: string | null;
  /** owner: an owner or admin of the workspace (or the machine itself); member: runs agents; reviewer: doesn't. */
  tier: 'owner' | 'member' | 'reviewer';
}

/**
 * The places an open wait or listen takes, each with its cap and what one over it is told; the first that is full
 * refuses. `noun`: "wait" or "listen".
 */
function placesFor(who: Holder, ws: string, L: Limits, noun: 'wait' | 'listen'): { key: string | null; cap: number; why: string }[] {
  const reviewer = who.tier === 'reviewer';
  const s = (n: number) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  return [
    {
      key: who.caller,
      cap: L.perCaller,
      why:
        noun === 'wait'
          ? `already waiting: this connection (its API token or app) has ${s(L.perCaller)} open, the most one holds. Let one of them answer, and wait with its cursor`
          : `too many open listens on this connection: at most ${L.perCaller} per API token or app (close one first)`,
    },
    reviewer
      ? {
          key: who.person,
          cap: L.perReviewer,
          why: `a reviewer holds at most ${s(L.perReviewer)} open at once: let one of them end before another starts`,
        }
      : {
          key: who.person,
          cap: L.perPerson,
          why:
            noun === 'wait'
              ? `your agents hold ${s(L.perPerson)} open across your tokens and apps, the most one person holds: let one of them answer before another waits`
              : `too many open listens for your account: at most ${L.perPerson} across your tokens and apps (close one of your agents' first)`,
        },
    {
      key: reviewer ? `${ws}\u0000reviewers` : null,
      cap: L.reviewers,
      why: `reviewers in this workspace hold ${s(L.reviewers)} open together, the most they hold (the rest are kept for the people who run its agents): try again in a minute`,
    },
    {
      key: who.tier === 'owner' ? null : `${ws}\u0000below-admins`,
      cap: L.belowAdmins,
      why: `this workspace keeps its last ${s(L.perWorkspace - L.belowAdmins)} for its owners and admins, and the rest are taken: try again in a minute${noun === 'wait' ? ', with your cursor' : ''}`,
    },
    {
      key: `${ws}\u0000*`,
      cap: L.perWorkspace,
      why: `this workspace has ${s(L.perWorkspace)} open (the most it holds): try again in a minute${noun === 'wait' ? ', with your cursor' : ''}`,
    },
  ];
}
/** How often open responses (waits, listens) ask again whether their caller would still get in, besides on events. */
const RECHECK_MS = 15_000;
/**
 * An open response asks again at most this often however many events there are (each answer is remembered that
 * long); access ended in this process (lib/auth.ts accessEnded) makes every one ask at once, and so does a change of
 * the files access is decided by (another process: `vr admin`, a restore). A yes is never remembered past the moment
 * the credential ends by itself (a token's expiry, an OAuth access token's hour, a session's end).
 */
export const RECHECK_MIN_MS = 5_000;
/** Who may get in is decided by these: accounts and tokens, app connections, memberships. */
const ACCESS_FILES = [USERS_FILE, GRANTS_FILE, workspaces.WORKSPACES_FILE];
const fileKey = (file: string): string => {
  try {
    const st = fs.statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return '-';
  }
};

export function mcpRoutes(ctx: ServerContext): Router {
  const r = router();
  const backend = createLocalBackend();
  const limiter = new RateLimit(PER_MINUTE, 60_000);

  // Callers per account and workspace, and each workspace as a whole: one team's agents can't crowd out another's.
  const perWorkspace = new RateLimit(PER_MINUTE * 10, 60_000);

  // wait_for_feedback sleeps until the next event of its workspace instead of polling the log once a second.
  const waiters = new Map<string, Set<() => void>>();
  const wake: Wake = (ms, signal) =>
    new Promise((resolve) => {
      const ws = currentWorkspace();
      const mine = waiters.get(ws) ?? new Set<() => void>();
      waiters.set(ws, mine);
      const done = () => {
        clearTimeout(timer);
        mine.delete(done);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      mine.add(done);
      signal.addEventListener('abort', done, { once: true });
    });

  // What is held open now, by connection, by person and (waits) by workspace: one over a cap is answered at once, in
  // words that say whose cap it is.
  const waiting = new Map<string, number>();
  const listening = new Map<string, number>();
  const count = (m: Map<string, number>, key: string | null, by: number) => {
    if (!key) return;
    const n = (m.get(key) ?? 0) + by;
    if (n > 0) m.set(key, n);
    else m.delete(key);
  };
  const held = (m: Map<string, number>, key: string | null) => (key ? (m.get(key) ?? 0) : 0);
  /** Takes every place a wait or listen needs, or none: the release, or what the first full one says. */
  const take = (m: Map<string, number>, places: { key: string | null; cap: number; why: string }[]): (() => void) | string => {
    const full = places.find((p) => p.key && held(m, p.key) >= p.cap);
    if (full) return full.why;
    for (const p of places) count(m, p.key, 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      for (const p of places) count(m, p.key, -1);
    };
  };
  const holdFor =
    (who: Holder): Hold =>
    () =>
      take(waiting, placesFor(who, currentWorkspace(), WAIT_LIMITS, 'wait'));

  // One MCP handler per workspace: its notifications (resource updates, list changes) reach that workspace's clients
  // only — a review's URI names its video, and another team must never hear of it.
  const handlers = new Map<string, ReturnType<typeof makeHandler>>();
  const handlerFor = (ws: string) => {
    let h = handlers.get(ws);
    if (!h) {
      h = makeHandler(ws);
      handlers.set(ws, h);
    }
    return h;
  };
  const makeHandler = (ws: string) =>
    createMcpHandler(
      ({ authInfo, requestInfo }) => {
        const principal = principalOf(authInfo);
        const appUrl = ctx.cfg.public_url || (requestInfo ? new URL(requestInfo.url).origin : null);
        const still = authInfo?.extra?.still;
        // Who asks for an upload URL, kept as what identifies them again (not this request: server/uploadTickets.ts).
        const issuer = (authInfo?.extra?.issuer as TicketIssuer | null | undefined) ?? null;
        const holder = (authInfo?.extra?.holder as Holder | undefined) ?? { caller: null, person: null, tier: 'reviewer' };
        // The connected agent it is (members and up): what is assigned to it, and whether it listens (server/agents.ts).
        const agent = (authInfo?.extra?.agent as CallingAgent | null | undefined) ?? null;
        // Whose run of "no new feedback" a wait adds to: the connected agent, else the connection (a token, an app).
        const quietKey = agent ? `agent:${agent.session_id}` : holder.caller;
        return createReviewServer({
          backend,
          principal,
          // the loop as this kind of agent works it: a coding agent renders through `vr render`, any other uses MCP only
          way: wayOf(principal.via, agent?.kind),
          wake,
          hold: holdFor(holder),
          ...(quietKey ? { quiet: quietIn(quietMap, `${ws}\u0000${quietKey}`) } : {}),
          ...(agent
            ? {
                me: { name: agent.name, sessionId: agent.session_id, kind: agent.kind },
                onWait: () => ctx.agents.wait(agent.session_id),
                told: toldIn(toldMap, `${ws}\u0000${agent.session_id}`),
              }
            : {}),
          ...(LOG_CALLS ? { log: (line: string) => console.log(`mcp: ${ws} ${agent?.session_id ?? '-'} ${line}`) } : {}),
          ...(typeof still === 'function' ? { stillAllowed: still as () => boolean } : {}),
          appUrl,
          sourceUrl: ctx.cfg.source_url,
          // /mcp?tools=lean: the review loop only, for clients that carry every tool on every turn (mcp/lean.ts).
          tools: requestInfo ? new URL(requestInfo.url).searchParams.get('tools') : null,
          // Events with paths on this disk for the machine itself only; anyone else reads URLs (wait_for_feedback).
          publicEvent: ctx.eventFor(principal.via),
          // what it does is its account's (by id; none for the machine's own): agents' runs go by it (server/runs.ts)
          activity: (a) => ctx.activity.record(a, principal.via !== 'local' && principal.id ? { account: principal.id } : {}),
          // agents' runs: a wait handing work over begins them; notes added meanwhile end the next answer (server/runs.ts)
          handed: (name, slugs) => ctx.runs.handed(name, slugs, principal.via !== 'local' ? principal.id : undefined),
          news: (name, about) => ctx.runs.news(name, about, principal.via !== 'local' ? principal.id : undefined),
          // New frames count per account, as `GET /api/review/:slug/frame` counts them (A13 VERIFY-2); not the machine's own.
          ...(principal.via === 'local'
            ? {}
            : { frameGrabs: grabCount(ctx.frameGrabs, principal.id ? `account:${principal.id}` : `${principal.via}:${principal.name}`) }),
          // Used later, maybe by a shell elsewhere: the caller is asked again then — still let in (token, app, account,
          // membership) and still allowed the action in the URL's workspace (A12 VA2-3).
          requestUpload: (input) =>
            ctx.uploadTickets.issue(input, principal.name || ctx.cfg.user, appUrl, principal.id, guardFor(principal, issuer, 'upload'), input.session),
          requestPreviewUpload: (target, by) => ctx.uploadTickets.issuePreview(target, by, appUrl, guardFor(principal, issuer, 'resolve')),
          requestRefUpload: (target, by) => ctx.uploadTickets.issueRef(target, by, appUrl, guardFor(principal, issuer, 'comment')),
          requestOptionUpload: (target, by, offered) => ctx.uploadTickets.issueOption(target, by, appUrl, guardFor(principal, issuer, 'comment'), offered),
          dropUpload: (url) => ctx.uploadTickets.drop(url),
          // The plan's gate on team files, as `POST /api/comments/:id/refs|previews` ask it (A12 AGENT-6).
          checkUpload: (bytes) => ctx.extension.check(ws, 'upload', bytes),
          // A workspace the server's operator suspended: its agents read on, but write nothing (A13 CLOUD-5).
          readOnly: () => (workspaces.suspensionOf(ws) ? SUSPENDED_ERROR : null),
          // A client on another device (and anyone on a hosted server) gets it rendered like /api/inbox.md: screenshot
          // URLs, never paths on this server's disk. An agent on the machine itself reads the file.
          inboxMarkdown: ctx.hosted || principal.via !== 'local' ? async () => store.renderInbox(store.inboxEvents().map(ctx.publicEvent)) : undefined,
        });
      },
      {
        legacy: 'stateless',
        maxRequestBodySize: MAX_BODY,
        // Logged on every server: a hosted operator needs these as much as the machine's owner.
        onerror: (e) => console.error('mcp:', e.message),
      },
    );

  // Every response still open (a wait, a listen stream), by workspace: each asks again whether its caller would still
  // get in — the token not revoked, the account not disabled or removed, still a member there — before an event of its
  // workspace reaches anyone, and every RECHECK_MS; one that wouldn't is cut, as /api/events' streams are
  // (server/events.ts stillAllowed). Note text never goes to someone who has lost the right to read it. An answer is
  // remembered for RECHECK_MIN_MS (a busy workspace's events would otherwise ask hundreds of times a second), except that
  // access ended in this process — a token revoked, a member removed, an account disabled — makes all of them ask at
  // once (`ended`, below), before the next event.
  const streams = new Map<string, Set<{ still: () => boolean; end: () => void }>>();
  // The access files as they were when last looked at: once per event or pass, not per stream (a few stats each time).
  let accessKey = '';
  const lookAgain = () => {
    accessKey = ACCESS_FILES.map(fileKey).join('|');
  };
  const recheck = (ws: string) => {
    lookAgain();
    for (const s of [...(streams.get(ws) ?? [])]) {
      let still = false;
      try {
        still = s.still();
      } catch {} // can't be told (workspaces.json unreadable): cut, as for someone who lost the right
      if (!still) s.end();
    }
  };
  const recheckAll = () => {
    lookAgain();
    for (const ws of [...streams.keys()]) recheck(ws);
  };
  setInterval(recheckAll, RECHECK_MS).unref();
  let ended = 0;
  onAccessEnded(() => {
    ended++;
    recheckAll();
  });

  /**
   * Whether the request that opened a response would still get in, as the same caller in the same workspace — and until
   * when that holds by itself at most (`until`: the credential's own end; Infinity when it has none).
   */
  function stillHere(req: Request, who: Principal, ws: string): { yes: boolean; until: number } {
    const no = { yes: false, until: 0 };
    if (who.via === 'local') return { yes: true, until: Number.POSITIVE_INFINITY };
    if (who.via === 'oauth') {
      const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1];
      const hit = bearer ? verifyAccess(bearer, oauthBase(ctx, req).resource, { touch: false }) : null;
      return hit && hit.user.id === who.id && hit.workspace === ws && workspaces.roleIn(ws, hit.user.id) ? { yes: true, until: hit.expires } : no;
    }
    const now = ctx.identify(req, { touch: false });
    return now && (now.user?.id ?? now.name) === (who.id ?? who.name) && now.workspace === ws
      ? { yes: true, until: now.until ?? Number.POSITIVE_INFINITY }
      : no;
  }
  /**
   * stillHere for one open response, its "yes" remembered for RECHECK_MIN_MS — unless access ended in this process
   * meanwhile, the access files changed (another process), or the credential's own end came first (A12-D10).
   */
  function stillFor(req: Request, who: Principal, ws: string): () => boolean {
    let at = 0;
    let seen = -1;
    let key = '';
    let until = 0;
    let yes = false;
    return () => {
      const now = Date.now();
      if (yes && seen === ended && key === accessKey && now - at < RECHECK_MIN_MS && now < until) return true;
      at = now;
      seen = ended;
      key = accessKey;
      ({ yes, until } = stillHere(req, who, ws));
      return yes;
    };
  }

  // Every review event (from the UI, `vr`, other sessions — the feed tails events.jsonl) wakes the tool calls waiting in
  // its workspace and becomes a notification for that workspace's clients listening on `subscriptions/listen`.
  ctx.hub.listen((type, data, ws) => {
    const handler = handlers.get(ws);
    recheck(ws);
    if (type === 'event') {
      for (const w of [...(waiters.get(ws) ?? [])]) w();
      if (!handler) return;
      handler.notify.resourceUpdated('vr://inbox');
      const slug = (data as { slug?: string }).slug;
      if (slug) handler.notify.resourceUpdated(reviewUri(slug));
    } else if (type === 'library') handler?.notify.resourcesChanged();
  });

  // Legacy (2025) clients name themselves only in `initialize`; their later requests are known by who calls.
  const clientNames = new Map<string, string>();
  /** The agent a request comes from, as it is listed (and a video assigned to it): its session id and name. */
  function announce(req: Request, res: Response, who: Principal, client: string | null, app: { grant: string; name: string | null } | null): CallingAgent {
    const caller = app ? `oauth:${app.grant}` : req.auth?.user ? `user:${req.auth.user.id}` : `local:${req.ip}`;
    if (client) clientNames.set(caller, client);
    const name = client || app?.name || clientNames.get(caller) || 'MCP client';
    const agent = {
      session_id: `mcp-${crypto.createHash('sha1').update(`${caller}|${name}`).digest('hex').slice(0, 12)}`,
      // Whose it is, unless it runs on the machine itself (then it's the machine owner's, like every local agent).
      name: who.via !== 'local' && who.name ? `${name} · ${accountTag(who.name)}` : name,
      cwd: null,
      host: null,
      user: who.via !== 'local' ? who.name || null : null,
      kind: agentKindOf(name),
    };
    // whose agent it is, by account (not the machine's own): a run it is at is that account's (server/runs.ts)
    const account = who.via !== 'local' ? who.id : undefined;
    ctx.agents.heartbeat(agent, { account });
    // A long wait_for_feedback keeps it listed (heartbeats expire after 90 s).
    const timer = setInterval(() => ctx.agents.heartbeat(agent, { account }), 30_000);
    res.on('close', () => clearInterval(timer));
    return { session_id: agent.session_id, name: agent.name, kind: agent.kind };
  }
  // What each agent's waits told it was waiting for it (mcp/feedback.ts Told): by workspace and agent, bounded.
  const toldMap = new Recent<number>(20_000);
  // Each agent's (or connection's) run of waits that ended with nothing new (mcp/feedback.ts Quiet): bounded the same.
  const quietMap = new Recent<QuietRun>(20_000);

  r.all('/mcp', async (req: Request, res: Response) => {
    // An API token's or session's workspace is the request's already (server/workspace.ts); an OAuth app's is its grant's.
    let workspace: string | null = req.auth?.workspace ?? null;
    let principal: Principal | null = null;
    let app: { grant: string; name: string | null } | null = null;
    let scopeCheck: ((web: globalThis.Request) => Promise<boolean>) | null = null;
    {
      const { issuer, resource } = oauthBase(ctx, req);
      const challenge = (extra: string) =>
        `Bearer realm="video-review", resource_metadata="${resourceMetadataUrl(issuer)}", scope="${SCOPE_LIST.join(' ')}"${extra}`;
      if (!req.auth) {
        // Not an API token or a session: maybe an access token from our OAuth sign-in, valid only for this resource.
        const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1];
        const hit = bearer ? verifyAccess(bearer, resource) : null;
        if (!hit) {
          res.setHeader('WWW-Authenticate', challenge(req.headers.authorization ? ', error="invalid_token"' : ''));
          res
            .status(401)
            .json({ error: 'sign in: connect this app through OAuth, or send an API token as Authorization: Bearer vr_… (Settings → API tokens)' });
          return;
        }
        // The app acts in the workspace it was allowed into, with the role its person has there now (∩ its scopes).
        const role = workspaces.roleIn(hit.workspace, hit.user.id);
        if (!role) {
          res.setHeader('WWW-Authenticate', challenge(', error="invalid_token"'));
          res.status(401).json({ error: 'this app was allowed into a workspace its person no longer works in: connect it again' });
          return;
        }
        principal = { via: 'oauth', name: hit.user.name, id: hit.user.id, role, scopes: hit.scopes };
        app = { grant: hit.grant, name: hit.client_name || null };
        workspace = hit.workspace;
      } else principal = principalOf(authInfoOf(req.auth));
      // A tool the app's scopes don't cover (but the account's role does) asks for step-up authorization up front.
      const p = principal;
      if (p.scopes)
        scopeCheck = async (web) => {
          const tool = await toolName(req, web);
          const access = tool ? TOOL_ACCESS[tool] : undefined;
          if (!access || allowed(p, access) || !can(p.role as Parameters<typeof can>[0], access) || scopeAllows(p.scopes ?? [], access)) return true;
          const needed = scopeFor(access);
          const why = `${tool} needs the ${needed} scope`;
          res.setHeader(
            'WWW-Authenticate',
            `Bearer realm="video-review", error="insufficient_scope", scope="${needed}", resource_metadata="${resourceMetadataUrl(issuer)}", error_description="${why}"`,
          );
          res.status(403).json({ error: 'insufficient_scope', error_description: why });
          return false;
        };
    }
    const ws = workspace ?? DEFAULT_WORKSPACE;
    // Counted by account (an OAuth app's too: by its person's id, never a name that can change), else by address.
    const key = `${ws}\u0000${principal.id ? `user:${principal.id}` : req.ip || 'local'}`;
    // The connection and the person open waits and listens count against (LISTEN_LIMITS, WAIT_LIMITS).
    const tier: Holder['tier'] = can(principal.role as Parameters<typeof can>[0], 'admin')
      ? 'owner'
      : can(principal.role as Parameters<typeof can>[0], 'agents')
        ? 'member'
        : 'reviewer';
    const holder: Holder =
      principal.via === 'local'
        ? { caller: null, person: null, tier: 'owner' }
        : {
            // Each device with the LAN link is a connection of its own (they share one link's token): by its address.
            caller: app
              ? `app:${app.grant}`
              : req.auth?.tokenId
                ? `token:${req.auth.tokenId}`
                : principal.via === 'lan'
                  ? `lan:${addressKey(req.ip || '')}`
                  : `${principal.via}:${principal.id ?? req.ip}`,
            person: principal.id ? `person:${principal.id}` : null,
            tier,
          };
    limiter.hit(key);
    perWorkspace.hit(ws);
    const wait = Math.max(limiter.retryAfter(key), perWorkspace.retryAfter(ws));
    if (wait) {
      res.setHeader('Retry-After', String(wait));
      res.status(429).json({ error: 'too many requests' });
      return;
    }
    // Everything from here works in the caller's workspace (an OAuth app's: the one it was allowed into).
    await inWorkspace(ws, () => serve(req, res, ws, principal, app, scopeCheck, holder));
  });

  async function serve(
    req: Request,
    res: Response,
    ws: string,
    principal: Principal | null,
    app: { grant: string; name: string | null } | null,
    scopeCheck: ((web: globalThis.Request) => Promise<boolean>) | null,
    holder: Holder,
  ): Promise<void> {
    let web: globalThis.Request;
    try {
      // Our req.auth is the app's Auth, not the SDK's AuthInfo; toWebRequest only converts, it never reads it.
      web = await toWebRequest(req as unknown as Parameters<typeof toWebRequest>[0], undefined, { maxRequestBodySize: MAX_BODY });
    } catch (e) {
      const status = (e as { status?: number }).status === 413 ? 413 : 400;
      res.status(status).json({ error: status === 413 ? 'request too large' : 'bad request' });
      return;
    }
    if (scopeCheck && !(await scopeCheck(web))) return;
    const who = principal ?? principalOf(authInfoOf(req.auth));
    // A listen stream stays open as long as the client likes: a few per connection and per person.
    if ((await rpcMethod(req, web)) === 'subscriptions/listen') {
      const place = take(listening, placesFor(holder, ws, LISTEN_LIMITS, 'listen'));
      if (typeof place === 'string') {
        res.status(429).json({ error: place });
        return;
      }
      res.on('close', place);
    }
    // While it is open, this response asks again whether its caller would still get in (streams, above).
    const still = stillFor(req, who, ws);
    const stream = { still, end: () => res.destroy() };
    const mine = streams.get(ws) ?? new Set();
    streams.set(ws, mine.add(stream));
    res.on('close', () => {
      mine.delete(stream);
      if (!mine.size && streams.get(ws) === mine) streams.delete(ws);
    });
    const agent = allowed(who, 'agents') ? announce(req, res, who, await clientName(req, web), app) : null;
    const info = principal ? authInfoFor(principal) : authInfoOf(req.auth);
    // The tools ask too (a wait, before it hands out what is new): `still` rides along with the caller, `holder` is whom
    // its waits count against, `issuer` says who asks for an upload URL (an OAuth app by its grant, a token by its id),
    // and `agent` is the connected agent it is (its waits make it listen; `session: "me"`).
    const issuer: TicketIssuer | null =
      who.via === 'local'
        ? { via: 'local', user: who.id ?? '', ws }
        : app && who.id
          ? { via: 'oauth', user: who.id, ws, grant: app.grant, ...(who.scopes ? { scopes: who.scopes } : {}) }
          : req.auth?.user
            ? {
                via: req.auth.via,
                user: req.auth.user.id,
                ws,
                ...(req.auth.tokenId ? { token: req.auth.tokenId } : {}),
                ...(req.auth.via === 'cookie' ? { session: sessionOf(req) ?? undefined } : {}),
              }
            : null;
    const response = await handlerFor(ws).fetch(web, { authInfo: { ...info, extra: { ...info.extra, still, holder, issuer, agent } } });
    res.status(response.status);
    response.headers.forEach((value, name) => {
      res.setHeader(name, value);
    });
    if (!response.body) {
      res.end();
      return;
    }
    res.flushHeaders();
    const body = Readable.fromWeb(response.body as unknown as WebReadableStream);
    res.on('close', () => body.destroy());
    body.pipe(res);
  }

  return r;
}

// The SDK carries auth as pass-through AuthInfo; ours rides along in `extra`. A caller nobody identified is nobody:
// never the machine's owner by default (that one names files on the disk, mcp/access.ts).
export function authInfoOf(auth: Auth | undefined): AuthInfo {
  if (!auth) return { token: '', clientId: 'nobody', scopes: [], extra: { via: 'token', name: '', role: '' } };
  return {
    token: '',
    clientId: auth.user?.id || auth.name || 'local',
    scopes: [auth.role],
    extra: { via: auth.via, name: auth.name || '', role: auth.role, ...(auth.user ? { id: auth.user.id } : {}) },
  };
}

function authInfoFor(p: Principal): AuthInfo {
  return { token: '', clientId: p.name || 'local', scopes: [...(p.scopes || [p.role])], extra: { ...p } };
}

/**
 * The guard of a one-time upload URL an MCP caller asks for: when it is used, the caller would still get in — its token,
 * session or OAuth grant (not the access token of the moment, which lives an hour), its account and membership — and may
 * still do `action` in the URL's workspace, by the role it has there now (and an app's scopes). The machine itself
 * always may.
 */
function guardFor(principal: Principal, issuer: TicketIssuer | null, action: Access): TicketGuard {
  if (principal.via === 'local') return {};
  return teamGuard(issuer, action);
}

/** Who a request's AuthInfo says is calling (exported for its test: nothing missing ever reads as the machine's owner). */
export function principalOf(info: AuthInfo | undefined): Principal {
  const x = (info?.extra || {}) as Partial<Principal>;
  // Missing fields fail closed: a token with no role, never the machine's owner.
  return { via: x.via || 'token', name: x.name || '', ...(x.id ? { id: x.id } : {}), role: x.role || '', ...(x.scopes ? { scopes: x.scopes } : {}) };
}

/**
 * The client's own name: 2026-07-28 clients send it with every request (`_meta`), 2025 clients in `initialize`.
 * Read from a clone, like toolName().
 */
async function clientName(req: Request, web: globalThis.Request): Promise<string | null> {
  if (req.method !== 'POST') return null;
  try {
    const body = (await web.clone().json()) as unknown;
    const msg = (Array.isArray(body) ? body[0] : body) as {
      method?: string;
      params?: { _meta?: Record<string, { name?: unknown }>; clientInfo?: { name?: unknown } };
    };
    const name = msg?.params?._meta?.['io.modelcontextprotocol/clientInfo']?.name ?? (msg?.method === 'initialize' ? msg.params?.clientInfo?.name : null);
    // Shown in the session picker: printable text only, and short.
    return typeof name === 'string' ? cleanAgentName(name, 60) || null : null;
  } catch {
    return null;
  }
}

/** The JSON-RPC method a request calls: the Mcp-Method header (2026-07-28), else the body (read from a clone). */
async function rpcMethod(req: Request, web: globalThis.Request): Promise<string | null> {
  const method = req.headers['mcp-method'];
  if (typeof method === 'string') return method;
  if (req.method !== 'POST') return null;
  try {
    const msg = (await web.clone().json()) as { method?: unknown } | { method?: unknown }[];
    const first = Array.isArray(msg) ? msg[0] : msg;
    return typeof first?.method === 'string' ? first.method : null;
  } catch {
    return null;
  }
}

/**
 * The tool a request calls, if it is a tools/call: 2026-07-28 clients say so in headers (Mcp-Method, Mcp-Name), older
 * ones only in the JSON-RPC body (read from a clone, so the SDK still gets the original).
 */
async function toolName(req: Request, web: globalThis.Request): Promise<string | null> {
  const method = req.headers['mcp-method'];
  if (typeof method === 'string') return method === 'tools/call' && typeof req.headers['mcp-name'] === 'string' ? (req.headers['mcp-name'] as string) : null;
  if (req.method !== 'POST') return null;
  try {
    const msg = (await web.clone().json()) as { method?: string; params?: { name?: unknown } };
    return msg.method === 'tools/call' && typeof msg.params?.name === 'string' ? msg.params.name : null;
  } catch {
    return null;
  }
}
