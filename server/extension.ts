// The one extension point of the open app: what a private module (Lampo Cloud's plans and billing) may decide and
// hear. It is loaded only when VR_CLOUD_MODULE names one (a file whose default export is a CloudModuleFactory); without
// it the app is self-hosted and complete: no limits, no extra routes, hooks that do nothing.
//
// What the open app asks, and where:
//   check(ws, 'upload', bytes)  renders (tus, one-time URLs), project files (a push's bytes, at once and per file), the
//                               team's references on notes, fix previews, playbook files — not voice notes,
//                               recordings or a client's references: notes keep working
//   check(ws, 'video')          a new video
//   check(ws, 'member')         an invite made or accepted, an account added
//   check(ws, 'share')          a new review link
//   check(ws, 'publish')        a publishing connection added, a post published (canPublish is optional)
// A refusal is a 402 with the module's own sentence (and `reason`, `upgrade`; for the limit sheet `needed`, `room` and
// `fits`: lib/types.ts PlanRefusal). A read-only workspace (an unpaid or
// over-limit plan) refuses exactly those; reviewing, notes, answers, approvals, downloads and existing review links
// keep working, and nothing is ever deleted for billing reasons.
// What it hears (after the fact, never blocking): a workspace created, a workspace's member count changed, a workspace
// deleted (the module stops billing it and forgets its state).
// What it may do: answer a sign-up (`onSignup`, in place of server/signup.ts — it places the person through the host's
// `placeSignup`, then starts whatever the plan gives a newcomer), email a workspace's people through the app's mailer
// and layout (`mail`, its own words in each language), and say it provides billing (Settings → Billing then shows
// `GET /api/billing`, lib/types.ts BillingInfo) and which origins its payment form loads from (`contentSecurity`: the
// hosted app's own pages allow them in their Content-Security-Policy; review links never do), and tell the funnel's two
// steps only it sees (`funnel`: a trial's end, the first payment; lib/funnel.ts counts the rest where they happen),
// and answer the operator's page (`operator`, optional): every workspace's plan, a plan set by hand and its log.
// The shapes mirror the module's contract (framework-neutral; Express is adapted here, in one place).

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Request } from 'express';
import { filesUsage } from '../lib/files.ts';
import { recordStep } from '../lib/funnel.ts';
import { wellFormed } from '../lib/names.ts';
import { slugify } from '../lib/paths.ts';
import { RateLimit } from '../lib/rateLimit.ts';
import { runsFile } from '../lib/runs.ts';
import { currentWorkspace, inWorkspace } from '../lib/scope.ts';
import * as store from '../lib/store.ts';
import type { OperatorPlan, PlanChange, PlanLogEntry, PlanStamp } from '../lib/types.ts';
import * as workspaces from '../lib/workspaces.ts';
import { HttpError } from './http.ts';
import type { OnSignup } from './signup.ts';

export type Role = 'owner' | 'admin' | 'member' | 'reviewer';

/** Who a request is, as the open app's identify decided. */
export interface Caller {
  workspace: string;
  account: string;
  role: Role;
  via: 'cookie' | 'token' | 'local' | 'lan';
  email?: string;
}

/** What the open app counts for a workspace (the module never walks the store itself). */
export interface Usage {
  /**
   * Bytes the plan's storage counts: the renders kept for the workspace (not caches), its project files' counted
   * bytes (`files.bytes`) and what its agents' runs keep (`runs`). They share the plan's GB.
   */
  bytes: number;
  /** Bytes the agents' runs keep with the videos (data/<slug>/runs.jsonl, lib/runs.ts): each file bounded on its own. */
  runs: number;
  /**
   * Its project files (lib/files.ts): what counts (`bytes`: live files once per workspace, pinned versions), what the
   * safety net keeps and doesn't count (`kept`: the trash and replaced versions), and how many live files.
   */
  files: { bytes: number; kept: number; count: number };
  /** People with an account in the workspace (clients on review links and agents never count). */
  members: number;
  /** Videos under review: not final, not archived. */
  activeVideos: number;
  /** The room the workspace could make: its final or archived videos and the bytes their versions hold. */
  room: { videos: number; bytes: number };
}

export interface HostRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body?: unknown;
  rawBody?: Buffer;
  ip?: string;
}

export interface HostResponse {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
  /**
   * A 502 or 503 whose `error` the module vouches is for people (paying isn't set up; the payment provider refused,
   * with its reason for people): its sentence and code go out as they are. Any other 5xx answers with the app's
   * sentence and a ref, the module's text only in the log (BILL-6).
   */
  public?: boolean;
}

export interface Route {
  method: 'GET' | 'POST';
  path: string;
  /** The body arrives unparsed in `rawBody` (a payment provider signs the exact bytes). */
  raw?: boolean;
  /** Reachable without signing in (a webhook). Every other route is behind the app's guard. */
  public?: boolean;
  /**
   * The lowest workspace role that may call it (owner > admin > member > reviewer): the app's role table holds every
   * caller to it, whatever the module checks itself. Required on every route that isn't `public` (BILL-10).
   */
  role?: Role;
  /** Only a person signed in in the app, never an API token or an app's OAuth token (the app's PERSON_ONLY). */
  person?: boolean;
  handle(req: HostRequest): Promise<HostResponse>;
}

/** Where a confirmed sign-up was placed (lib/workspaces.ts placeSignup). */
export interface SignupPlacement {
  /** The workspace the person works in now; null when this server gives sign-ups none (and no invite placed them). */
  workspace: string | null;
  /** The workspace was made just now. */
  created: boolean;
  /** It is the workspace made for this person's own sign-up (made now, or by an earlier try of the same link). */
  own: boolean;
}

/** One message's words in one language: the app renders them in its own layout, with its own footer. */
export interface MailWords {
  subject: string;
  title: string;
  body: string[];
  /** The button's label (with `link`). */
  button?: string;
  /** The small print after the button. */
  note?: string;
}

/** A message about a workspace to its people, each in their own language. */
export interface WorkspaceMail {
  workspace: string;
  /** Who in the workspace gets it (default: owners and admins); only confirmed addresses, never a suspended member. */
  roles?: Role[];
  /** The words per language; `en` is required and used for anyone whose language has none. */
  text: Record<string, MailWords> & { en: MailWords };
  /** A screen of the app the button opens, e.g. `#/settings/billing` (never another site). */
  link?: string;
}

export interface HostContext {
  publicUrl: string;
  who(req: HostRequest): Caller | null;
  sameOrigin(req: HostRequest): boolean;
  usage(workspace: string): Promise<Usage>;
  allow(key: string, max: number, windowMs: number): boolean;
  log(event: string, fields?: Record<string, unknown>): void;
  /** The app's own sign-up placement (what server/signup.ts does without a module): idempotent, throws to keep the link. */
  placeSignup(account: string, opts?: { reset?: boolean }): Promise<SignupPlacement>;
  /** Queues a message to the workspace's people through the app's mailer; resolves with how many were queued. */
  mail(m: WorkspaceMail): Promise<number>;
  /**
   * The funnel's two steps only the module sees (lib/funnel.ts, the operator's page): `trial_end` when a workspace's
   * trial ends — counted when it was active (anything done in its last three days: the module's `active`, or when it
   * doesn't say, the workspace's own log, `activeLately`) — and `plan_paid` at its first payment, with the plan. Once
   * per workspace (later calls do nothing); nothing on a server that doesn't count.
   */
  funnel?(workspace: string, step: ModuleFunnelStep, o?: { plan?: string; active?: boolean }): void;
}

/** The funnel's steps a module tells (HostContext.funnel). */
export type ModuleFunnelStep = 'trial_end' | 'plan_paid';

export type Decision =
  | { ok: true }
  | {
      ok: false;
      reason: 'storage' | 'members' | 'videos' | 'read-only' | 'payment';
      /** The sentence people read (English). */
      message: string;
      /** The same sentence in other languages, by code (`de`): the page shows its own language's. */
      messages?: Record<string, string>;
      upgrade?: string;
      /** What was asked for: an upload's bytes (the app adds an invitee's address itself). */
      needed?: number;
      /** The room the workspace could make instead (Usage.room, passed back). */
      room?: { videos: number; bytes: number };
      /** The smallest step that fits: a plan id, or an add-on (`addon:storage_tb`). */
      fits?: string;
    };

export interface EntitlementsProvider {
  get(workspace: string): Promise<unknown>;
  canUpload(workspace: string, bytes: number): Promise<Decision>;
  canAddMember(workspace: string): Promise<Decision>;
  canAddVideo(workspace: string): Promise<Decision>;
  canShare(workspace: string): Promise<Decision>;
  /** Connecting a publishing account and publishing a post (optional: a module without it allows both). */
  canPublish?(workspace: string): Promise<Decision>;
  /**
   * The workspace's plan lets its admins hide "Powered by Lampo" on its review links (a paid plan; A13 CLOUD-7).
   * Optional: a module without it, and a server without a module, show the badge on every link.
   */
  canHideBadge?(workspace: string): Promise<boolean>;
  /**
   * The storage the workspace's plan includes, in bytes (null: no limit). Optional: the project files' safety net (the
   * trash and replaced versions, not counted) is held to a quarter of it; without it, only to 30 days.
   */
  storageBytes?(workspace: string): Promise<number | null>;
}

export interface WorkspaceEvent {
  workspace: string;
  members?: number;
  email?: string;
}

export interface WorkspaceHooks {
  created?(e: WorkspaceEvent): Promise<void>;
  membersChanged?(e: WorkspaceEvent): Promise<void>;
  deleted?(e: WorkspaceEvent): Promise<void>;
}

/** A held account whose address was just proven (server/signup.ts's contract). */
export interface ModuleSignupEvent {
  account: string;
  email?: string;
  /** Proven with a reset link (a new password), not the confirm link. */
  reset: boolean;
}

/** Why a module refused the operator's change (each has the page's own words). */
export type OperatorRefusal = 'fixed' | 'paying' | 'date' | 'none' | 'reason';

export type OperatorResult = { ok: true } | { ok: false; reason: OperatorRefusal; message: string };

/**
 * What the operator's page asks of a module that bills (server/routes/operator.ts): every workspace's plan, a
 * workspace's log of plans set by hand, and a change — complimentary on a plan, the trial run to a date, or back to
 * normal billing, each with the operator's reason. The module keeps the override and its log in its own state; the
 * page only shows them.
 */
export interface OperatorPlans {
  /** The plan of each workspace named, with what the open app counted for it (unknown ones may be left out). */
  plans(workspaces: { workspace: string; usage: Usage }[]): Promise<Record<string, OperatorPlan>>;
  /** The plans set by hand, newest first. */
  log(workspace: string): Promise<PlanLogEntry[]>;
  /** Sets an override, or ends it (`normal`), and logs it; a refusal says why. */
  set(workspace: string, change: PlanChange, by: PlanStamp, reason: string): Promise<OperatorResult>;
}

export interface CloudModule {
  name: string;
  entitlements: EntitlementsProvider;
  routes: Route[];
  workspaces: WorkspaceHooks;
  /** The operator page's plans (optional: without it the page lists workspaces without plans). */
  operator?: OperatorPlans;
  /**
   * Answers a sign-up in place of the app's own placement: it places the person (`host.placeSignup`) and does what its
   * plans give a newcomer. Same contract as server/signup.ts: before the person is let in, idempotent, a throw keeps the
   * link unused.
   */
  onSignup?(e: ModuleSignupEvent): Promise<void>;
  /** It provides billing: Settings → Billing shows its `GET /api/billing` (lib/types.ts BillingInfo). */
  billing?: boolean;
  /**
   * What the billing page's payment form loads (a payment provider's script, its frames, its API): https origins, at
   * most one leading `*.` each. The hosted app's own pages allow them; review links and a person's own machine never.
   */
  contentSecurity?: ContentSources;
  /** Stops its timers (the server stops, a test ends). */
  stop?(): void;
}

/** Origins per Content-Security-Policy directive. */
export interface ContentSources {
  script?: string[];
  frame?: string[];
  connect?: string[];
  img?: string[];
}

/** An origin a module may add to a CSP directive: https, a host name (or `*.` and one), an optional port. Nothing else. */
const SOURCE = /^https:\/\/(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/;
const DIRECTIVES = ['script', 'frame', 'connect', 'img'] as const;
/**
 * The only bases a `*.` may stand in front of: a payment provider's own domains. Over shared hosting (`*.github.io`,
 * `*.workers.dev`, `*.amazonaws.com`) or a public suffix (`*.co.uk`) a wildcard would let anyone's script in (BILL-9).
 */
const WILDCARD_BASES = new Set(['stripe.com', 'js.stripe.com', 'stripe.network', 'stripecdn.com']);
/** A host that is an address, not a name (an IPv4 literal; IPv6 needs brackets, which SOURCE never takes). */
const IP_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Why an origin can't go into the policy, or null when it can. */
function sourceProblem(o: unknown): string | null {
  if (typeof o !== 'string' || !SOURCE.test(o)) return 'only https origins are allowed';
  const host = o.slice('https://'.length).replace(/:\d+$/, '');
  if (IP_LITERAL.test(host)) return 'an address is no origin of a payment provider';
  if (host.startsWith('*.') && !WILDCARD_BASES.has(host.slice(2))) return `a wildcard is allowed only over ${[...WILDCARD_BASES].join(', ')}`;
  return null;
}

/**
 * A module's content sources, checked: anything but plain https origins (a keyword, a scheme, a path, a bare `*`, a
 * quote that would end the header's value, an IP address, a wildcard over anyone's hosting) stops the server rather than
 * loosening the policy.
 */
export function contentSourcesOf(x: unknown): ContentSources | null {
  if (x === undefined || x === null) return null;
  if (typeof x !== 'object') throw new Error('the cloud module’s contentSecurity is not an object');
  const out: ContentSources = {};
  for (const [k, v] of Object.entries(x)) {
    if (!(DIRECTIVES as readonly string[]).includes(k)) throw new Error(`the cloud module asks for a CSP directive it may not set: ${k}`);
    if (!Array.isArray(v) || v.length > 8) throw new Error(`the cloud module’s ${k} sources are not a short list`);
    for (const o of v) {
      const problem = sourceProblem(o);
      if (problem) throw new Error(`the cloud module asks the pages to load ${JSON.stringify(o)}: ${problem}`);
    }
    if (v.length) out[k as (typeof DIRECTIVES)[number]] = [...v];
  }
  return Object.keys(out).length ? out : null;
}

export type CloudModuleFactory = (host: HostContext, env: Record<string, string | undefined>) => Promise<CloudModule>;

/** What a workspace is about to do that a plan may limit. */
export type Gate = 'upload' | 'video' | 'member' | 'share' | 'publish';

export interface Extension {
  /** The module's name, or null for none (self-hosted). */
  name: string | null;
  /**
   * Throws a 402 with the module's sentence when the workspace may not do that now; resolves when it may. `asked`: the
   * invitee's address of a new member, said back in the refusal (`needed`) to whoever asked.
   */
  check(workspace: string, gate: Gate, bytes?: number, asked?: string): Promise<void>;
  /** What the workspace's plan includes, as the module tells it (null without a module). */
  entitlements(workspace: string): Promise<unknown>;
  /** The workspace's plan lets its admins hide "Powered by Lampo" (false without a module, or when the module fails). */
  badgeOptional(workspace: string): Promise<boolean>;
  /** The plan's storage in bytes, as the module tells it (null without a module, one that doesn't say, or a failure). */
  storageBytes(workspace: string): Promise<number | null>;
  /** The module's routes (mounted by the app under its guard; `public` ones are reachable signed out). */
  routes: Route[];
  /** The module's sign-up answer (server/signup.ts's seam), or null to keep the app's own. */
  onSignup: OnSignup | null;
  /** A billing provider runs: /api/info says so and Settings → Billing shows. */
  billing: boolean;
  /** Origins the hosted app's own pages allow for the billing page's payment form (checked: contentSourcesOf). */
  contentSecurity: ContentSources | null;
  /** The operator page's plans, or null (no module, or one without them): the page lists workspaces without plans. */
  operator: OperatorPlans | null;
  /** Stops hearing workspace changes, and the module's timers. */
  stop(): void;
  /** Resolves once the module's hooks heard so far have ended (`vr admin` waits before it exits). */
  idle(): Promise<void>;
}

/** Without a module: everything is allowed, nothing is mounted, nothing is heard. */
export const NO_EXTENSION: Extension = {
  name: null,
  check: async () => {},
  entitlements: async () => null,
  badgeOptional: async () => false,
  storageBytes: async () => null,
  routes: [],
  onSignup: null,
  billing: false,
  contentSecurity: null,
  operator: null,
  stop: () => {},
  idle: async () => {},
};

/**
 * What the open app counts for a workspace: its renders' and project files' bytes, its people, its videos under review,
 * and the room it could make (final or archived videos and their bytes: what a limit sheet offers to archive or remove
 * instead).
 */
export function usageOf(workspace: string): Usage {
  return inWorkspace(workspace, () => {
    let bytes = 0;
    let runs = 0;
    let activeVideos = 0;
    const room = { videos: 0, bytes: 0 };
    for (const r of store.listReviews()) {
      // the first run's sample (lib/sample.ts) is Lampo's, not the team's: never counted against a plan — but renders
      // someone put on it before it refused them are the team's
      if (r.onboarding_sample) {
        for (const v of store.versionsOnSample(r)) bytes += Number.isFinite(v.size) ? v.size : 0;
        continue;
      }
      let size = 0;
      for (const v of r.versions) size += Number.isFinite(v.size) ? v.size : 0;
      bytes += size;
      try {
        runs += fs.statSync(runsFile(slugify(r.video))).size;
      } catch {}
      if (!r.archived && !r.final) activeVideos++;
      else {
        room.videos++;
        room.bytes += size;
      }
    }
    const f = filesUsage();
    return {
      bytes: bytes + f.bytes + runs,
      runs,
      files: { bytes: f.bytes, kept: f.kept, count: f.files },
      members: workspaces.membersOf(workspace).length,
      activeVideos,
      room,
    };
  });
}

/**
 * Whether anything happened in a workspace in the last three days (its log's newest event; the first run's sample logs
 * none): what makes a trial's end the funnel's "active at trial end" when the module doesn't say (HostContext.funnel).
 */
export function activeLately(workspace: string, now = Date.now()): boolean {
  const last = inWorkspace(workspace, () => store.readEvents({ limit: 1, tailBytes: 64 * 1024 })).at(-1);
  const at = last ? Date.parse(last.at) : Number.NaN;
  return Number.isFinite(at) && now - at <= 3 * 86_400_000;
}

/**
 * A module names a route the app answers itself: the app's handler would answer it while the guard's `public` and the
 * role table's `own` went by the module's word (server/app.ts mountExtension), so the module is refused at start.
 */
export class ModuleRouteError extends Error {}

const count = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/**
 * The 402 a refusal becomes: the module's sentence, and what it refused for (the UI shows it with an upgrade). For the
 * limit sheet also what was asked for (`needed`: an upload's bytes, or `asked`, the invitee the caller named), the room
 * the workspace could make and the smallest step that fits — each only in its plain shape (lib/types.ts PlanRefusal).
 */
export function refusal(d: Exclude<Decision, { ok: true }>, asked?: string): HttpError {
  const messages = d.messages && Object.fromEntries(Object.entries(d.messages).filter(([k, v]) => /^[a-z]{2}$/.test(k) && typeof v === 'string'));
  const needed = count(d.needed) ? d.needed : asked;
  return new HttpError(402, d.message, {
    reason: d.reason,
    ...(d.upgrade ? { upgrade: d.upgrade } : {}),
    ...(messages && Object.keys(messages).length ? { messages } : {}),
    ...(needed !== undefined ? { needed } : {}),
    ...(d.room && count(d.room.videos) && count(d.room.bytes) ? { room: { videos: Math.floor(d.room.videos), bytes: d.room.bytes } } : {}),
    ...(typeof d.fits === 'string' && /^[a-z][a-z0-9_:]{0,39}$/.test(d.fits) ? { fits: d.fits } : {}),
  });
}

export interface HostOptions {
  publicUrl: string;
  who: (req: HostRequest) => Caller | null;
  sameOrigin: (req: HostRequest) => boolean;
  log?: (event: string, fields?: Record<string, unknown>) => void;
  /** Sends a workspace message (server/accountMail.ts workspaceNotice); none given: nothing is sent. */
  mail?: (m: WorkspaceMail) => number;
}

/** A screen of this app a module's message may link to (`#/…`): nothing that leaves the app or runs as a script. */
export const APP_LINK = /^#\/[A-Za-z0-9/_?=&.-]*$/;

/** Where `placeSignup` put an account, with whether it is the workspace of its own sign-up. */
export function placeSignupOf(account: string, { reset = false }: { reset?: boolean } = {}): SignupPlacement {
  const placed = workspaces.placeSignup(account, { reset });
  // a sign-up's own workspace, made now: the funnel's first step (lib/funnel.ts; nothing where it doesn't count)
  if (placed.created && placed.workspace) recordStep(placed.workspace, 'signup');
  return { ...placed, own: !!placed.workspace && workspaces.signupWorkspaceOf(account) === placed.workspace };
}

/** The host a module is given: who is asking, the same-origin check, usage, the rate limiter, a log, sign-up and mail. */
export function hostContext(o: HostOptions): HostContext {
  const limits = new Map<string, RateLimit>();
  const log = o.log ?? ((event: string, fields?: Record<string, unknown>) => console.log(JSON.stringify({ event, ...fields })));
  return {
    publicUrl: o.publicUrl,
    who: o.who,
    sameOrigin: o.sameOrigin,
    usage: async (w) => usageOf(w),
    allow(key, max, windowMs) {
      const id = `${max}/${windowMs}`;
      let l = limits.get(id);
      if (!l) {
        l = new RateLimit(max, windowMs);
        limits.set(id, l);
      }
      if (l.retryAfter(key)) return false;
      l.hit(key);
      return true;
    },
    log,
    placeSignup: async (account, opts) => placeSignupOf(account, opts),
    funnel(workspace, step, o = {}) {
      // a module's mistake is its own: anything but its two steps, a workspace that isn't one, an idle trial — nothing
      if ((step !== 'trial_end' && step !== 'plan_paid') || typeof workspace !== 'string' || !workspaces.getWorkspace(workspace)) return;
      if (step === 'trial_end' && !(typeof o?.active === 'boolean' ? o.active : activeLately(workspace))) return;
      recordStep(workspace, step, { plan: typeof o?.plan === 'string' ? o.plan : undefined });
    },
    async mail(m) {
      // A module's mistake is its own: logged, nothing sent, never a failed request in the app.
      if (!m?.text?.en || !workspaces.getWorkspace(m.workspace) || (m.link !== undefined && !APP_LINK.test(m.link))) {
        log('extension.mail.refused', { workspace: m?.workspace });
        return 0;
      }
      return o.mail ? o.mail(m) : 0;
    },
  };
}

/**
 * The extension around a loaded module: its decisions as 402s, its routes, and the workspace changes it hears. A
 * hook that fails is logged and never fails the app (the module retries what it must).
 */
export function createExtension(module: CloudModule, host: HostContext): Extension {
  const contentSecurity = contentSourcesOf(module.contentSecurity);
  const running = new Set<Promise<unknown>>();
  const off = workspaces.onWorkspaceChange((e) => {
    // a deleted workspace: the module stops billing it and forgets what it kept (A13 CLOUD-5, PEOPLE-1)
    const hook = e.type === 'created' ? module.workspaces.created : e.type === 'deleted' ? module.workspaces.deleted : module.workspaces.membersChanged;
    if (!hook) return;
    const event: WorkspaceEvent =
      e.type === 'deleted'
        ? { workspace: e.workspace }
        : { workspace: e.workspace, members: e.members, ...(e.type === 'created' && e.email ? { email: e.email } : {}) };
    const p = hook
      .call(module.workspaces, event)
      .catch((err: Error) => host.log('extension.hook.failed', { hook: e.type, workspace: e.workspace, error: err?.message }))
      .finally(() => running.delete(p));
    running.add(p);
  });
  const ask = (workspace: string, gate: Gate, bytes = 0): Promise<Decision> => {
    const e = module.entitlements;
    if (gate === 'upload') return e.canUpload(workspace, bytes);
    if (gate === 'video') return e.canAddVideo(workspace);
    if (gate === 'member') return e.canAddMember(workspace);
    // a module from before publishing has no say in it: allowed
    if (gate === 'publish') return e.canPublish ? e.canPublish(workspace) : Promise.resolve({ ok: true as const });
    return e.canShare(workspace);
  };
  const signup = module.onSignup;
  return {
    name: module.name,
    async check(workspace, gate, bytes, asked) {
      const d = await ask(workspace, gate, bytes);
      if (!d.ok) throw refusal(d, gate === 'member' ? asked : undefined);
    },
    entitlements: (workspace) => module.entitlements.get(workspace),
    // a module's failure shows the badge: it is the default, and a visitor's page never waits on billing's mistakes
    badgeOptional: async (workspace) => {
      try {
        return (await module.entitlements.canHideBadge?.(workspace)) === true;
      } catch (e) {
        host.log('extension.badge.failed', { workspace, error: (e as Error)?.message });
        return false;
      }
    },
    // a module's failure keeps the safety net as it is (30 days): nothing is purged early on billing's mistake
    storageBytes: async (workspace) => {
      try {
        const n = await module.entitlements.storageBytes?.(workspace);
        return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
      } catch (e) {
        host.log('extension.storage.failed', { workspace, error: (e as Error)?.message });
        return null;
      }
    },
    routes: module.routes,
    onSignup: signup ? ({ user, reset }) => signup.call(module, { account: user.id, ...(user.email ? { email: user.email } : {}), reset: !!reset }) : null,
    billing: !!module.billing,
    contentSecurity,
    operator: module.operator ?? null,
    stop() {
      off();
      module.stop?.();
    },
    async idle() {
      while (running.size) await Promise.allSettled([...running]);
    },
  };
}

/** Puts a loaded extension in place: its decisions, and its sign-up answer instead of the app's own when it has one. */
export function installExtension(ctx: { extension: Extension; onSignup: OnSignup | null }, ext: Extension): void {
  ctx.extension = ext;
  if (ext.onSignup) ctx.onSignup = ext.onSignup;
}

/** Loads the module VR_CLOUD_MODULE names (none: NO_EXTENSION). A module that fails to load stops the server. */
export async function loadExtension(host: HostContext, env: NodeJS.ProcessEnv = process.env): Promise<Extension> {
  const file = env.VR_CLOUD_MODULE?.trim();
  if (!file) return NO_EXTENSION;
  const mod = (await import(pathToFileURL(file).href)) as { default?: CloudModuleFactory };
  if (typeof mod.default !== 'function') throw new Error(`VR_CLOUD_MODULE (${file}) has no default export to call`);
  return createExtension(await mod.default(host, { ...env }), host);
}

/**
 * A route's guard for what a plan limits, before the body is read: `upload` counts the request's announced length.
 * Runs in the request's workspace (server/workspace.ts). `ext` is read on every request: the module is loaded at start.
 */
export function gate(ext: () => Extension, what: Gate) {
  return async <P>(req: Request<P>, _res: unknown, next: () => void): Promise<void> => {
    // a new member's address, when the caller named one (an invite, an account added): the refusal says it back
    const email = what === 'member' ? (req.body as { email?: unknown } | undefined)?.email : undefined;
    const asked = typeof email === 'string' && email.trim() ? email.trim().slice(0, 254) : undefined;
    await ext().check(currentWorkspace(), what, what === 'upload' ? Number(req.headers['content-length']) || 0 : undefined, asked);
    next();
  };
}

/** The Express request behind a module's HostRequest (for `who` and `sameOrigin`). */
export const requestOf = new WeakMap<HostRequest, Request>();

/** Who a module's request is: the caller as identified, in the workspace the request works in. */
export function callerOf(h: HostRequest): Caller | null {
  const a = requestOf.get(h)?.auth;
  if (!a?.user) return null;
  return { workspace: a.workspace, account: a.user.id, role: a.role, via: a.via, ...(a.user.email ? { email: a.user.email } : {}) };
}

/** Writes on a cookie come from our own pages (the guard's CSRF rule, for a module's own routes). */
export function sameOriginOf(publicUrl: string | null): (h: HostRequest) => boolean {
  return (h) => {
    const req = requestOf.get(h);
    if (!req) return false;
    const origin = req.headers.origin;
    if (origin) return !!publicUrl && origin === new URL(publicUrl).origin;
    const site = req.headers['sec-fetch-site'];
    return site === 'same-origin' || site === 'none';
  };
}

/** A request as a module sees it (no Express types cross the boundary). */
export function hostRequest(req: Request, raw = false): HostRequest {
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
  return {
    method: req.method,
    path: req.path,
    headers,
    ...(raw ? { rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0) } : { body: wellFormed(req.body) }),
    ip: req.ip,
  };
}
