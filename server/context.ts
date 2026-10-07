// Everything the routes share: config, the event hub, caches and background workers.
import crypto from 'node:crypto';
import path from 'node:path';
import type { Request } from 'express';
import * as auth from '../lib/auth.ts';
import type { Config } from '../lib/config.ts';
import { forYou, viewerFor } from '../lib/foryou.ts';
import { HOSTED_QUEUE_LIMIT, HOSTED_QUEUE_RESERVED, QUEUE_LIMITS } from '../lib/jobs.ts';
import { senderOf } from '../lib/mail/config.ts';
import { createMailer, type Mailer } from '../lib/mail/index.ts';
import { CACHE, DATA } from '../lib/paths.ts';
import { can } from '../lib/permissions.ts';
import { restrictFormats } from '../lib/probe.ts';
import { createAdapters, createPublisher, type Publisher } from '../lib/publish/queue.ts';
import { createPush, notFrom, type Push, type PushMessage, type StoredSub } from '../lib/push/index.ts';
import { RateLimit } from '../lib/rateLimit.ts';
import { currentWorkspace, DEFAULT_WORKSPACE } from '../lib/scope.ts';
import { GRAB_LIMITS } from '../lib/shots.ts';
import { listSlugs } from '../lib/store.ts';
import type { Capabilities, ClaudeSession, ReviewEvent } from '../lib/types.ts';
import { createWebhooks, envHook, type Webhooks } from '../lib/webhooks.ts';
import { roleIn } from '../lib/workspaces.ts';
import { type AccountMail, createAccountMail } from './accountMail.ts';
import { type ActivityStore, createActivityStore } from './activity.ts';
import { type AgentRuns, createAgentRuns } from './agentRuns.ts';
import { type AgentRegistry, createAgentRegistry } from './agents.ts';
import { actor, createIdentify, type Identify } from './auth.ts';
import { type Background, createBackground } from './background.ts';
import { type Broadcast, createEventHub, type EventHub } from './events.ts';
import { type Extension, NO_EXTENSION } from './extension.ts';
import { sampleForFirstRun } from './firstSample.ts';
import { createPlayback, type Playback } from './playback.ts';
import { createReadiness, type Readiness } from './ready.ts';
import { createRuns, type Runs } from './runs.ts';
import { createSessionCache, type SessionCache } from './sessionCache.ts';
import { createInFlight, type InFlight } from './shutdown.ts';
import { onSignup as defaultOnSignup, type OnSignup } from './signup.ts';
import { createTunnel, type Tunnel } from './tunnel.ts';
import { createUploadTickets, type UploadTickets } from './uploadTickets.ts';
import type { Watchers } from './watch.ts';

export interface ServerContext {
  cfg: Config;
  /**
   * A hosted server (`VR_MODE=server`): no access to anyone's machine — its files, its Claude Code sessions, its
   * speech hardware. Otherwise the app runs on the person's own machine: the same app (accounts, uploads, links …)
   * plus what the machine offers (see `capabilities`), and the machine's owner is signed in there automatically.
   */
  hosted: boolean;
  /** What this instance can do beyond the hosted app; the UI asks this instead of a mode. */
  capabilities: Capabilities;
  /** Who a request is (API token, session cookie, or on the person's own machine the machine itself). */
  identify: Identify;
  /** Vite dev middleware instead of the built UI. */
  dev: boolean;
  /** Reachable from the local network (phones via the QR link). */
  lan: boolean;
  /** LAN access token (from the QR link, then a cookie). */
  token: string;
  hub: EventHub;
  broadcast: Broadcast;
  sessions: SessionCache;
  agents: AgentRegistry;
  /** Agents Lampo started on this machine for a request (never on a hosted server). */
  agentRuns: AgentRuns;
  /** What agents are doing, live (server/activity.ts); the process starts tailing the machine's rolling file. */
  activity: ActivityStore;
  /** Agents' runs: one stretch of an agent's work on a video, kept per video (server/runs.ts, lib/runs.ts). */
  runs: Runs;
  playback: Playback;
  background: Background;
  tunnel: Tunnel;
  /** File watchers; a no-op until the server starts watching (tests don't). */
  watchers: Pick<Watchers, 'refresh'>;
  /** A hosted server before the first account exists: the one-time token that may create it (printed to the log). */
  setup: { token: string | null };
  /** The author for a write from this request (see auth.actor). */
  actor: (req: Request, by?: string | null) => string;
  /**
   * An event as anyone but the machine itself sees it (live streams, webhooks, tokens, other devices, every caller of a
   * hosted server): screenshot paths become URLs (`/data/<slug>/<file>`), never paths on this disk.
   */
  publicEvent: (e: ReviewEvent) => ReviewEvent;
  /** An event as a caller reached `via` may read it: the files on this disk for the machine itself only (`local`). */
  eventFor: (via: string | null | undefined) => (e: ReviewEvent) => ReviewEvent;
  /** How long the last upload request waits for the render to be registered before answering "pending". */
  uploadWaitMs: number;
  /** Tells Slack, Discord or any URL about client activity (fed from events.jsonl by the process). */
  webhooks: Webhooks;
  /** Push notifications to phones and browsers (fed from events.jsonl like the webhooks). */
  push: Push;
  /** Push service hosts accepted beyond the browsers' own (tests point this at a mock). */
  pushHosts: string[];
  /** Work a graceful shutdown waits for (uploads being registered). */
  inflight: InFlight;
  /** Set on SIGTERM: `/readyz` answers 503 while the process drains. */
  stopping: boolean;
  /** `/readyz` and the start-up self-check. */
  readiness: Readiness;
  /** One-time upload URLs (MCP `request_upload`, `POST /api/uploads/tickets`). */
  uploadTickets: UploadTickets;
  /** New frames grabbed per account (lib/shots.ts GRAB_LIMITS): `GET /api/review/:slug/frame` and MCP `get_frame`. */
  frameGrabs: RateLimit;
  /** What a private module (Lampo Cloud's billing) decides and hears; none on a self-hosted server (server/extension.ts). */
  extension: Extension;
  /** Email: a queue on disk sent in the background through SMTP, or written to <cache>/outbox/ (lib/mail/). */
  mail: Mailer;
  /** The emails accounts get (server/accountMail.ts). */
  accountMail: AccountMail;
  /** What a confirmed sign-up does: the workspaces' seam (server/signup.ts). */
  onSignup: OnSignup | null;
  /** Sends the posts people published, in every workspace (lib/publish/queue.ts); the process starts it. */
  publisher: Publisher;
}

export interface ContextOptions {
  cfg: Config;
  lan?: boolean;
  dev?: boolean;
  token: string;
  /** Where running Claude sessions come from (tests pass a stub instead of spawning `claude agents`). */
  loadSessions?: () => Promise<ClaudeSession[]>;
  /** Tests fill the sign-up seam themselves; the process takes server/signup.ts's. */
  onSignup?: OnSignup | null;
}

export function createContext({ cfg, lan = false, dev = false, token, loadSessions, onSignup = defaultOnSignup }: ContextOptions): ServerContext {
  const server = cfg.mode === 'server';
  restrictFormats(server);
  // One workspace's queue of background jobs is bounded where many teams share the server (lib/jobs.ts), with places
  // kept for the scrub copies a player waits on.
  QUEUE_LIMITS.perWorkspace = server ? HOSTED_QUEUE_LIMIT : Number.POSITIVE_INFINITY;
  QUEUE_LIMITS.reserved = server ? HOSTED_QUEUE_RESERVED : 0;
  // New accounts start with the first run (lib/onboarding.ts) unless this instance turned it off.
  auth.setOnboarding(cfg.onboarding !== false);
  // The person's own machine: their owner account exists from the first start (named like the notes they wrote); a
  // store without a video yet is the machine's very first start, and the owner gets the first run.
  const hadOwner = !!auth.localOwner();
  const owner = server ? null : auth.ensureLocalOwner(cfg.user, { fresh: listSlugs().length === 0 });
  const newOwner = hadOwner ? null : owner;
  const identify = createIdentify({ machine: !server, lanToken: lan ? token : null });
  // An open event stream stays only while the one who opened it would still be let in, as the same person.
  const hub = createEventHub({
    stillAllowed: (req) => {
      const now = identify(req, { touch: false });
      // …in the same workspace: a stream opened in one is never carried into another (a switch, a membership ended).
      return !!now && (now.user?.id ?? now.name) === (req.auth?.user?.id ?? req.auth?.name) && now.workspace === req.auth?.workspace;
    },
  });
  const broadcast = hub.broadcast;
  const playback = createPlayback(broadcast);
  const agents = createAgentRegistry(broadcast);
  // Every activity joins its agent run (server/runs.ts); this machine's processes are runs too.
  const runs: Runs = createRuns({ broadcast, actor: (req) => actor(req) });
  const activity = createActivityStore(broadcast, { onRecord: (a) => runs.sign(a) });
  const agentRuns = createAgentRuns({
    broadcast,
    activity: activity.record,
    runs: { started: (i, r) => runs.machineStarted(i, r), ended: (i, r, e) => runs.machineEnded(i, r, e), seen: (r) => runs.seen(r) },
  });
  // Server mode lists the agents that connected (in memory, always current); locally `claude agents` plus those, plus
  // the sessions Lampo itself started for a request (running from the moment they start, not the next refresh).
  const sessions = createSessionCache(broadcast, loadSessions);
  const withAgents: SessionCache = server
    ? { get: async () => agents.sessions(), refresh: async () => agents.sessions(), at: 0, refreshing: false }
    : {
        ...sessions,
        async get(opts) {
          const local = await sessions.get(opts);
          const known = new Set(local.map((s) => s.sessionId));
          const started = agentRuns.sessions().filter((s) => !known.has(s.sessionId));
          for (const s of started) known.add(s.sessionId);
          return [...local, ...started, ...agents.sessions().filter((a) => !known.has(a.sessionId))];
        },
        refresh: sessions.refresh,
        get at() {
          return sessions.at;
        },
        get refreshing() {
          return sessions.refreshing;
        },
      };
  const url = (slug: string, file: string | null | undefined) => (file ? `/data/${encodeURIComponent(slug)}/${path.basename(file)}` : null);
  // Paths on this disk are for the machine itself (`via: 'local'`) only, whatever the mode: a phone on the LAN, a
  // token, the live stream and a webhook read URLs (A12: AGENT-4, VA2-7).
  const publicEvent = (e: ReviewEvent): ReviewEvent =>
    e.shots
      ? {
          ...e,
          shots: {
            clean: url(e.slug, e.shots.clean),
            marked: url(e.slug, e.shots.marked),
            ...(e.shots.range ? { range: url(e.slug, e.shots.range) } : {}),
          },
        }
      : e;
  const eventFor = (via: string | null | undefined) => (!server && via === 'local' ? (e: ReviewEvent) => e : publicEvent);
  const mail = createMailer({
    config: cfg.mail,
    dir: path.join(DATA, 'mail'),
    outbox: path.join(CACHE, 'outbox'),
    from: senderOf(cfg.mail, mailHost(cfg)),
    host: mailHost(cfg),
    secret: auth.secret,
  });
  let env: ReturnType<typeof envHook> = null;
  try {
    env = envHook();
  } catch (e) {
    console.error(`VR_WEBHOOK_URL ignored: ${(e as Error).message}`);
  }
  const ctx: ServerContext = {
    cfg,
    hosted: server,
    capabilities: capabilitiesOf(server, lan),
    identify,
    dev,
    lan,
    token,
    hub,
    broadcast,
    sessions: withAgents,
    agents,
    agentRuns,
    activity,
    runs,
    playback,
    background: createBackground(broadcast, playback, { projectFiles: !server, stt: () => cfg.stt }),
    tunnel: createTunnel(cfg.port, broadcast),
    watchers: { refresh() {} },
    setup: { token: server && !auth.hasUsers() ? crypto.randomBytes(18).toString('base64url') : null },
    actor,
    publicEvent,
    eventFor,
    uploadWaitMs: 45_000,
    webhooks: createWebhooks({
      config: cfg.webhooks,
      env,
      baseUrl: cfg.public_url || `http://localhost:${cfg.port}`,
      publicEvent,
      // A hosted server sends to public addresses only (SSRF); an instance that opts in for an internal chat server does
      // so for workspace #1's hooks, its operator's own team (A12 WS-9).
      guard: server ? {} : null,
      allowPrivate: !!cfg.webhooks_allow_private,
    }),
    push: createPush({ subject: pushSubject(cfg), eligible: eligible(server, cfg.user), count: badge(server, cfg.user) }),
    pushHosts: [],
    inflight: createInFlight(),
    stopping: false,
    readiness: createReadiness({
      minFree: cfg.min_free_bytes ?? 2e9,
      stopping: () => ctx.stopping,
      // AGPL-3.0 §13: people who use a hosted instance over the network must be offered its source.
      warnings: server && !cfg.source_url ? ['no source_url / VR_SOURCE_URL: set it to where people can get the source of this instance (AGPL-3.0 §13)'] : [],
      publicUrl: server ? !!cfg.public_url : undefined,
    }),
    // With a media host of its own (VR_MEDIA_ORIGIN) one-time upload URLs point there: a whole render in one request
    // never meets the request-size limit of a proxy in front of the app host.
    uploadTickets: createUploadTickets({ origin: server ? cfg.media_origin : null }),
    frameGrabs: new RateLimit(GRAB_LIMITS.perAccount, GRAB_LIMITS.windowMs),
    extension: NO_EXTENSION,
    mail,
    accountMail: createAccountMail(cfg, mail),
    onSignup,
    publisher: createPublisher({
      adapters: createAdapters(),
      hosted: server,
      // the post's video, its card and its stage line follow (all in the workspace the post is in)
      changed: (slug, o) => {
        broadcast('posts', { slug });
        // how far an upload got is the post's own news: no library-wide refetch per progress step (A12 PUB-11)
        if (!o?.progress) broadcast('library', { slug });
      },
    }),
  };
  // the machine's very first start: its owner's first run finds the sample in the library (server/firstSample.ts)
  if (newOwner) void sampleForFirstRun(ctx, { workspace: DEFAULT_WORKSPACE, user: newOwner });
  return ctx;
}

/** Our name toward mail relays and in Message-IDs: the public URL's host. */
export const mailHost = (cfg: Config): string => (cfg.public_url ? new URL(cfg.public_url).hostname : 'localhost');

// Apple wants a real contact (mailto: or https:); push_subject says who runs this instance.
function pushSubject(cfg: Config): string {
  if (cfg.push_subject) return cfg.push_subject;
  return cfg.public_url?.startsWith('https:') ? cfg.public_url : 'mailto:video-review@localhost';
}

// Each account hears only what its role may act on, in the workspace the news is from (a device of someone who isn't
// a member there hears nothing of it), and never about its own actions. On the person's own machine a device that
// subscribed before the machine had accounts belongs to its owner.
function eligible(server: boolean, localUser: string) {
  const fromOwner = notFrom(localUser);
  return (sub: StoredSub, msg: PushMessage): boolean => {
    if (!sub.user) return !server && currentWorkspace() === DEFAULT_WORKSPACE && fromOwner(sub, msg);
    const user = auth.getUser(sub.user);
    if (!user || user.disabled) return false;
    if (msg.authors.every((a) => a === user.name)) return false;
    const need = msg.category === 'fixes' ? 'verify' : msg.category === 'questions' ? 'comment' : msg.category === 'posts' ? 'post' : 'view';
    return can(roleIn(currentWorkspace(), user.id), need);
  };
}

// The app icon's badge: how much waits in "For you" for that device's person, in the workspace the news is from.
export function badge(server: boolean, localUser: string) {
  return (sub: StoredSub): number => {
    const user = sub.user ? auth.getUser(sub.user) : server ? null : auth.localOwner();
    if (!user && server) return 0;
    const role = user ? roleIn(currentWorkspace(), user.id) : null;
    if (user && !role) return 0;
    return forYou(viewerFor(user && role ? { ...user, role } : user, localUser), { server: true }).counts.total;
  };
}

/**
 * What the person's own machine adds to the hosted app. A hosted server has none of these: it can't see anyone's
 * disk, Claude Code sessions or Finder, and its speech runs on whatever it has (reported by /api/info.stt).
 */
export function capabilitiesOf(hosted: boolean, lan: boolean): Capabilities {
  const machine = !hosted;
  return {
    linkFiles: machine,
    localAgents: machine,
    reveal: machine && process.platform === 'darwin',
    visionOcr: machine && process.platform === 'darwin',
    projectFiles: machine,
    inboxFile: machine,
    tunnel: machine,
    lan: machine && lan,
    wakeAgents: machine,
  };
}
