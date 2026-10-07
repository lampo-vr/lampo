// Runs as the server keeps them (lib/runs.ts holds the store and the rules): what opens one — something a person with
// the agents right did (Send, Ask, Nudge, Answer, Try again; never a reviewer, a review link or an API token), or an
// agent's own write — and what moves it: every activity Lampo records (server/activity.ts) joins the open run of that
// agent × video, a wait that hands the work over begins it, the events every process writes (versions, statuses,
// questions, answers) move its plan and its state, this machine's processes start and end theirs, and a clock finds
// the ones that went quiet. Each change is told as an SSE `run` {slug, id} (coalesced, like agent-activity); the
// phases (opened, started, needs_you, ended) become `run` events in the log. Agents spend no tokens on any of it.
import path from 'node:path';
import type { Request } from 'express';
import { agentName, words } from '../lib/activityText.ts';
import { agentKindOfRef } from '../lib/agentKind.ts';
import { can } from '../lib/permissions.ts';
import type { RunNotice } from '../lib/push/index.ts';
import { RateLimit, Recent } from '../lib/rateLimit.ts';
import * as lib from '../lib/runs.ts';
import { boundToWorkspace, currentWorkspace, inWorkspace, wsKey } from '../lib/scope.ts';
import * as store from '../lib/store.ts';
import { compareTime, isAgent, isIdea, isRequired } from '../lib/time.ts';
import type {
  ActivityWords,
  AgentActivity,
  AgentActivityKind,
  AgentRunInfo,
  Review,
  ReviewEvent,
  Run,
  RunDetail,
  RunOpenedHow,
  RunPhase,
  RunProgress,
} from '../lib/types.ts';
import type { Broadcast } from './events.ts';
import { fail } from './http.ts';

/** At most one `run` event per run within this long. */
const EVENT_MS = 300;
/** A change of state is written at once; steps within this long go out together. */
const FLUSH_MS = 1000;
/** How often the clock looks at open runs. */
const SWEEP_MS = 30_000;
/** Stops not heard yet kept in memory for calls that name no video (the oldest go first). */
const UNHEARD_MAX = 10_000;
/** One account's agents open at most this many runs by their own writes within OPENED_WINDOW_MS, in a workspace. */
const OPENED_MAX = 30;
const OPENED_WINDOW_MS = 10 * 60_000;
/** A ping that an agent's work failed: at most one per agent and video within this long. */
export const FAILED_PING_MS = 10 * 60_000;

/** What an agent's own write is: these open a run when none is open (reads and waits never do). */
const WRITES = new Set<AgentActivityKind>(['note', 'fix', 'reply', 'ask', 'upload', 'render', 'error', 'status']);

/** Whether this request may open a run: a person (never an API token) whose role has the agents right. */
export const mayOpenRun = (req: Request): boolean => !!req.auth && req.auth.via !== 'token' && can(req.auth.role, 'agents');

export interface PersonOpen {
  how: RunOpenedHow;
  /** The account whose agent it is, when known (an earlier run's, for Try again and an answer's follow-up). */
  owner?: string;
  /** The notes it is about: Send's batch (Nudge takes the video's open notes, Ask none). */
  notes?: readonly string[];
  /** The person's words (Ask, Nudge). */
  request?: string | null;
  follows?: string;
  /** Another agent than the video's (Try again, an answer to an agent's question). */
  agent?: Run['agent'];
}

export interface Runs {
  /** A person did something that opens a run for the video's agent, or adds to the one it has open (one per agent ×
   * video). Null when they may not (`mayOpenRun`) or the video has no agent. */
  fromPerson(req: Request, slug: string, o: PersonOpen): Run | null;
  /**
   * One recorded activity (server/activity.ts, any source): joins its run, or opens one for a write. When the person
   * stopped this agent's work and it hasn't heard yet, this call is its next step: the line it is told (once), else null.
   */
  sign(a: AgentActivity, from?: { account?: string }): string | null;
  /** A wait of `agent` (of `account`; none: this machine's own) handed over what waited on these videos: their queued
   * runs begin. */
  handed(agent: string, slugs: readonly string[], account?: string): void;
  /** One line of a workspace's event log (the server's feed): versions, statuses, questions and answers. */
  event(e: ReviewEvent): void;
  /** A person answered the agent's question `note` on the video: its run works again, or (with the right, and words:
   * `opens`) the answer opens the follow-up. */
  answered(req: Request, slug: string, note: string, opens: boolean): void;
  /** The same for a question on a folder before V1. */
  answeredFolder(folder: string, note: string): void;
  /** This machine started an agent process for run `run` (or for none: it opens one). The run's id. */
  machineStarted(info: AgentRunInfo, run: string | undefined): string;
  machineEnded(info: AgentRunInfo, run: string, exit: lib.Exit): void;
  /** A run this machine started was denied a permission (its own output says so): it needs the person, with the rule
   * that would allow it to copy. Only Lampo's reading of the run's output says this, never what anyone posts. */
  machineBlocked(info: AgentRunInfo, run: string, denied: { words: ActivityWords; allow: string }): void;
  /** When run `id` was last heard from (ms), for its process's clock. */
  seen(id: string): number | null;
  /** A video's runs (null: the folder runs, of `folder` when given), newest first. */
  list(slug: string | null, folder?: string): Run[];
  detail(id: string): { slug: string | null; detail: RunDetail } | null;
  /** A run by id in this workspace, with the process this machine started for it (its log), if any. */
  find(id: string): { slug: string | null; run: Run; proc: string | null } | null;
  /** The person stopped it: stopped at once. Its process, when this machine runs one, is the caller's to stop. */
  stop(id: string, who: string): { run: Run; proc: string | null } | null;
  /** Try again: the follow-up run on the notes still open (not while that agent has one open on the video). */
  retry(req: Request, id: string): Run;
  /**
   * The new-notes line for `agent`'s next answer (notes added to its run while it worked), once per batch. `about`: what
   * the call named (a video, a note); `read`: it read the video's open notes (they are told by that, no line).
   */
  news(agent: string, about?: { video?: string | null; note?: string | null; read?: boolean }, account?: string): string | null;
  /** The clock: quiet runs go lost, an hour lost closes them; what changed is written. */
  sweep(now?: number): void;
  /** Writes everything not written yet (the process is stopping). */
  flushAll(): void;
  close(): void;
}

/** What people may want a ping about (lib/push/index.ts): a run failed, waits for a permission, or went quiet. */
export type { RunNotice };

export interface RunsOptions {
  broadcast: Broadcast;
  /** The author for a write of this request (ctx.actor). */
  actor: (req: Request) => string;
  /** A run failed, waits for a permission, or has gone quiet for QUIET_MS: push (server/context.ts). In its workspace. */
  notify?: (n: RunNotice) => void;
  /** The account a connected agent is, by its session id (server/agents.ts): whose a run a person sends it is. */
  ownerOfSession?: (sessionId: string) => string | undefined;
}

/** No word from an agent at work this long: a ping for whoever asked for one (Settings → Notifications). */
export const QUIET_MS = 30 * 60_000;

const wordsOf = (a: ActivityWords): ActivityWords => ({
  text: a.text,
  ...(a.key ? { key: a.key } : {}),
  ...(a.vars ? { vars: a.vars } : {}),
  ...(a.quote ? { quote: a.quote } : {}),
});

/** What an activity says of a render or upload under way: its own progress, else what today's lines tell. */
function progressOf(a: AgentActivity): RunProgress | null | undefined {
  if (a.progress) return a.progress;
  if (a.kind === 'upload' && typeof a.pct === 'number') return { what: 'upload', stage: 'uploading', pct: a.pct };
  if (a.key === 'Rendering… {mb} MB, still growing') return { what: 'render', stage: 'rendering', pct: null };
  return undefined;
}

/** The notes a video waits on (the editor's side): what a nudge or an agent's own run is about. */
const openNotes = (review: Review | null): string[] =>
  (review?.comments ?? []).filter((c) => c.status === 'open' && (isRequired(c) || isIdea(c))).map((c) => c.id);

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0);

export function createRuns({ broadcast, actor, notify, ownerOfSession }: RunsOptions): Runs {
  // runs opened by an account's agents' own writes, per workspace and account (a member's token can't flood a store)
  const opened = new RateLimit(OPENED_MAX, OPENED_WINDOW_MS, { maxKeys: 10_000 });
  // when each agent's work on a video last pinged that it failed (by workspace, video and agent)
  const failedPinged = new Recent<number>(10_000);
  const pendingEvent = new Map<string, NodeJS.Timeout>();
  const pendingFlush = new Map<string, { timer: NodeJS.Timeout; soon: boolean }>();
  // Runs the person stopped whose agent hasn't heard yet (by workspace and run id), for its next call that names no
  // video. The runs files keep `stop_pending` too: a call about the video finds it there after a restart.
  const unheard = new Map<string, { ws: string; slug: string; agent: string; owner?: string; id: string }>();
  // The inbox shows runs that failed, wait for a permission or went quiet: it is told when a run's state moves.
  const forYouSoon = new Map<string, NodeJS.Timeout>();
  const tellForYou = () => {
    const ws = currentWorkspace();
    if (forYouSoon.has(ws)) return;
    const t = setTimeout(
      boundToWorkspace(() => {
        forYouSoon.delete(ws);
        broadcast('for-you');
      }),
      EVENT_MS,
    );
    t.unref?.();
    forYouSoon.set(ws, t);
  };

  /** Tells the app run `id` changed (coalesced). */
  const announce = (slug: string | null, id: string) => {
    const k = wsKey(id);
    if (pendingEvent.has(k)) return;
    pendingEvent.set(
      k,
      setTimeout(
        boundToWorkspace(() => {
          pendingEvent.delete(k);
          broadcast('run', { slug, id });
        }),
        EVENT_MS,
      ),
    );
  };

  const flush = (slug: string | null) => {
    try {
      lib.flushRuns(slug);
    } catch (e) {
      // a busy video: the next change (or the clock) writes it
      console.error(`runs of ${slug ?? 'folders'} not written:`, (e as Error).message);
    }
  };
  /** Writes a video's runs soon: a change of state at once, steps together. */
  const schedule = (slug: string | null, soon: boolean) => {
    const k = wsKey(slug ?? '');
    const p = pendingFlush.get(k);
    if (p && (p.soon || !soon)) return;
    if (p) clearTimeout(p.timer);
    const timer = setTimeout(
      boundToWorkspace(() => {
        pendingFlush.delete(k);
        flush(slug);
      }),
      soon ? 0 : FLUSH_MS,
    );
    timer.unref?.();
    pendingFlush.set(k, { timer, soon });
  };

  /** A change to one run, then what it means: events for its phases, the SSE, the write, the inbox and a push. */
  function change(slug: string | null, id: string, fn: (r: lib.StoredRun) => RunPhase[] | boolean | undefined, by?: string): lib.StoredRun | null {
    let phases: RunPhase[] = [];
    let moved = false;
    let stateMoved = false;
    let wasFailed = false;
    let wasBlocked = false;
    const run = lib.changeRuns(slug, (runs) => {
      const r = runs.find((x) => x.id === id);
      if (!r) return null;
      const before = `${r.state}|${r.ended}`;
      wasFailed = r.state === 'failed';
      wasBlocked = r.state === 'needs_you' && r.needs?.kind === 'permission';
      const out = fn(r);
      if (Array.isArray(out)) phases = out;
      stateMoved = before !== `${r.state}|${r.ended}`;
      moved = phases.length > 0 || stateMoved || out === true;
      return r;
    });
    if (!run) return null;
    for (const p of phases) logPhase(slug, run, p, by);
    announce(slug, run.id);
    schedule(slug, moved);
    const blocked = run.state === 'needs_you' && run.needs?.kind === 'permission';
    if ((stateMoved || blocked !== wasBlocked) && slug !== null) {
      tellForYou();
      if (run.state === 'failed' && !wasFailed) tell(slug, run, 'failed');
      else if (blocked && !wasBlocked) tell(slug, run, 'permission');
    }
    return run;
  }

  /** A push for what people may want to hear of (lib/push): never one that breaks a change. */
  function tell(slug: string, r: lib.StoredRun, kind: RunNotice['kind'], minutes?: number) {
    if (!notify) return;
    try {
      if (kind === 'failed') {
        // one ping per agent and video for a while: work that fails again and again says it once
        const k = wsKey(`${slug}\u0000${r.clock.owner ?? ''}\u0000${lib.agentBase(r.agent.name)}`);
        const last = failedPinged.get(k) ?? 0;
        if (Date.now() - last < FAILED_PING_MS) return;
        failedPinged.set(k, Date.now());
      }
      const review = store.loadReview(slug);
      if (!review) return;
      const said = kind === 'failed' ? r.error : kind === 'permission' ? r.needs?.text : undefined;
      notify({
        kind,
        slug,
        video: path.basename(review.video),
        agent: r.agent.name,
        run: r.id,
        ...(said ? { words: said } : {}),
        ...(kind === 'permission' && r.needs?.allow ? { allow: r.needs.allow } : {}),
        ...(minutes ? { minutes } : {}),
      });
    } catch (e) {
      console.error('runs: a ping was not sent:', (e as Error).message);
    }
  }

  /** A `run` event in the video's log (folder runs have no video: their questions' own events say it). */
  function logPhase(slug: string | null, r: Run, phase: RunPhase, by?: string) {
    if (slug === null) return;
    const review = store.loadReview(slug);
    if (!review) return;
    // what it needs, for a needs_you (a question, options, a permission): webhooks read it there
    const text = phase === 'ended' ? r.state : phase === 'opened' ? r.opened_by.how : phase === 'needs_you' ? r.needs?.kind : undefined;
    store.logEvent({ type: 'run', by: by ?? `agent:${r.agent.name}`, review, v: review.versions.at(-1)?.v, run: r.id, phase, ...(text ? { text } : {}) });
  }

  /** Opens a run (and tells it). */
  function openRun(o: lib.OpenRun, by: string, sign?: lib.Sign): lib.StoredRun {
    const now = Date.now();
    const r = lib.newRun(o, now);
    lib.changeRuns(o.slug, (runs) => runs.push(r));
    const phases: RunPhase[] = ['opened'];
    if (r.state === 'working' || r.state === 'needs_you') phases.push('started');
    for (const p of phases) logPhase(o.slug, r, p, p === 'opened' ? by : undefined);
    announce(o.slug, r.id);
    schedule(o.slug, true);
    if (sign) change(o.slug, r.id, (x) => lib.applySign(x, sign));
    return r;
  }

  /** The open runs of `agent` (of `account`) in this workspace, wherever they are. */
  function openOf(agent: string, account: string | undefined): { slug: string | null; run: lib.StoredRun }[] {
    const ws = currentWorkspace();
    const out: { slug: string | null; run: lib.StoredRun }[] = [];
    for (const p of lib.openPlaces()) {
      if (p.ws !== ws) continue;
      for (const run of lib.readRuns(p.slug)) if (run.ended === null && run.agent.name === agent && lib.ownerOk(run, account)) out.push({ slug: p.slug, run });
    }
    return out;
  }

  /** How many open runs `account`'s agents hold in this workspace. */
  function openOfAccount(account: string): number {
    const ws = currentWorkspace();
    let n = 0;
    for (const p of lib.openPlaces()) {
      if (p.ws !== ws) continue;
      for (const run of lib.readRuns(p.slug)) if (run.ended === null && run.clock.owner === account) n++;
    }
    return n;
  }

  /** Time's moves on a video's runs, written and told (before a read answers). */
  function settleAt(slug: string | null, now = Date.now()) {
    for (const r of lib.readRuns(slug)) if (lib.due(r, now)) change(slug, r.id, (x) => (lib.settle(x, now) === 'ended' ? ['ended'] : true), 'system');
  }

  /** The video's agent as a run names it. */
  const assigned = (review: Review): Run['agent'] | null =>
    review.session?.name ? lib.runAgent(review.session.name, agentKindOfRef(review.session), review.session.id) : null;

  /** The notes of an earlier run its follow-up carries: what it hadn't done, and what it asked about (now answered). */
  const carried = (r: Run, review: Review | null) => {
    const open = new Set(openNotes(review));
    return r.plan.filter((p) => (p.state === 'todo' || p.state === 'doing' || p.state === 'asked') && (open.has(p.id) || p.state === 'asked')).map((p) => p.id);
  };

  function open(slug: string, o: PersonOpen, who: { who: string; id?: string }): Run | null {
    const review = store.loadReview(slug);
    if (!review || review.onboarding_sample) return null;
    const agent = o.agent ?? assigned(review);
    if (!agent) return null;
    // whose agent it is: an earlier run's, else the connected agent's account (never the name it is listed under)
    const owner = o.agent ? o.owner : review.session?.id ? ownerOfSession?.(review.session.id) : undefined;
    const ask = (x: lib.StoredRun, at: number) => {
      if (o.request) lib.keepAsk(x, { ...(who.id ? { by_id: who.id } : {}), who: who.who, at: new Date(at).toISOString(), text: lib.requestText(o.request) });
    };
    // What the person does now outweighs a stop its agent hasn't heard yet: it hears this instead.
    for (const r of lib.readRuns(slug))
      if (r.stop_pending && r.agent.name === agent.name)
        change(slug, r.id, (x) => {
          delete x.stop_pending;
          unheard.delete(wsKey(x.id));
          return true;
        });
    const going = lib.readRuns(slug).find((r) => r.ended === null && r.agent.name === agent.name);
    if (going) {
      // "Tell it…" (an Ask, a nudge) while it works joins that work: its words are the request, and a step of its own
      const now = Date.now();
      const r = change(slug, going.id, (x) => {
        const added = o.notes?.length ? lib.addNotes(x, o.notes, now) : [];
        if (o.request) {
          x.request = lib.requestText(o.request);
          lib.keepStep(x, { ...words('{name} asked', { name: who.who }, x.request), at: new Date(now).toISOString(), type: 'action' });
          ask(x, now);
        }
        return added.length > 0 || !!o.request;
      });
      return r && lib.shownRun(r);
    }
    const notes = o.notes ?? (o.how === 'nudge' ? openNotes(review) : []);
    // Runs people sent that no agent picked up yet are bounded per video: the newest is what the person wants now, so
    // the one waiting longest makes room (nothing was done on it; its notes and requests went out all the same).
    const waiting = lib
      .readRuns(slug)
      .filter((x) => x.ended === null && x.state === 'queued')
      .sort((a, b) => compareTime(a.started, b.started));
    for (const x of waiting.slice(0, Math.max(0, waiting.length - lib.RUN_LIMITS.queuedPerVideo + 1)))
      change(
        slug,
        x.id,
        (y) => {
          lib.endRun(y, 'stopped', Date.now());
          return ['ended'];
        },
        who.who,
      );
    const r = openRun(
      {
        slug,
        agent,
        opened_by: { who: who.who, ...(who.id ? { id: who.id } : {}), how: o.how },
        notes,
        request: o.request,
        ...(o.follows ? { follows: o.follows } : {}),
        ...(owner !== undefined ? { owner } : {}),
      },
      who.who,
    );
    if (o.request)
      change(slug, r.id, (x) => {
        ask(x, Date.now());
        return false;
      });
    return lib.shownRun(lib.readRuns(slug).find((x) => x.id === r.id) ?? r);
  }

  /** The newest open question of the run's agent on the video, asked in the last minute: what its question is about. */
  function questionOf(slug: string, agent: string, now: number): { note: string; options: boolean } | null {
    const review = store.loadReview(slug);
    const q = (review?.comments ?? [])
      .filter((c) => c.status === 'open' && c.kind === 'question' && isAgent(c.author) && lib.sameAgent(agent, c.author) && now - ms(c.created) < 60_000)
      .sort((a, b) => ms(b.created) - ms(a.created))[0];
    return q ? { note: q.id, options: !!q.options?.length } : null;
  }

  /** Plan notes at the frame the agent looked at. */
  function atFrame(slug: string, r: lib.StoredRun, frame: unknown): string[] {
    const f = Number(frame);
    if (!Number.isFinite(f)) return [];
    const review = store.loadReview(slug);
    const ids = new Set(r.plan.map((p) => p.id));
    return (review?.comments ?? []).filter((c) => ids.has(c.id) && (c.frame === f || (!!c.range && f >= c.range.in && f <= c.range.out))).map((c) => c.id);
  }

  function signOf(a: AgentActivity, now: number): lib.Sign {
    const progress = progressOf(a);
    const target = a.target ?? (typeof a.vars?.id === 'string' && /^c_[0-9a-f]+$/i.test(a.vars.id) ? a.vars.id : null);
    return { at: now, kind: a.kind, words: wordsOf(a), target, ...(progress !== undefined ? { progress } : {}) };
  }

  /** Applies a sign to a video's run, with what the video itself says (the frame's notes, the question's id). */
  function applyTo(slug: string, id: string, s: lib.Sign, agent: string, account: string | undefined) {
    const q = lib.stepTypeOf(s.kind) === 'elicitation' ? questionOf(slug, agent, s.at) : null;
    change(slug, id, (r) => {
      // the first agent heard at a run nobody holds yet: its account's from now on
      lib.claim(r, account);
      const sign: lib.Sign = {
        ...s,
        ...(s.words.key === 'Looking at frame {frame}' ? { atFrame: atFrame(slug, r, s.words.vars?.frame) } : {}),
        ...(q ? { needs: { kind: q.options ? ('options' as const) : ('question' as const), note: q.note } } : {}),
      };
      return lib.applySign(r, sign);
    });
  }

  /**
   * The person stopped this agent's work and it hasn't heard yet: this call is its next step. It hears it now (the line,
   * once: `claimStop`), the step is kept with the stopped work, and nothing new opens for it — nor for a write in the
   * moment after (calls it made before it read the line). A wait hears nothing: it went back to waiting, and the work
   * is over either way. Undefined when the call has nothing to do with a stop.
   */
  function stopHeard(a: AgentActivity, s: lib.Sign, account: string | undefined): string | null | undefined {
    const name = a.agent;
    const ws = currentWorkspace();
    const at = new Date(s.at).toISOString();
    const keep = (r: lib.StoredRun) => {
      if (!s.quiet && s.words.key !== 'Thinking' && a.kind !== 'wait') lib.keepStep(r, { ...s.words, at, type: lib.stepTypeOf(s.kind) });
    };
    const places: { slug: string; id: string }[] = [];
    if (a.slug) {
      for (const r of lib.readRuns(a.slug)) if (r.stop_pending && r.agent.name === name && lib.ownerOk(r, account)) places.push({ slug: a.slug, id: r.id });
    } else
      for (const u of unheard.values())
        if (u.ws === ws && u.agent === name && (u.owner === undefined || u.owner === (account ?? ''))) places.push({ slug: u.slug, id: u.id });
    if (!places.length) {
      // a write in the moment after it heard: kept with the stopped work, nothing opened
      if (!a.slug || !WRITES.has(a.kind)) return undefined;
      const runs = lib.readRuns(a.slug);
      if (runs.some((r) => r.ended === null && r.agent.name === name && lib.ownerOk(r, account))) return undefined;
      const just = runs.find(
        (r) =>
          r.agent.name === name && lib.ownerOk(r, account) && r.state === 'stopped' && !!r.clock.stopTold && s.at - ms(r.clock.stopTold) <= lib.RUN_TIMES.late,
      );
      if (!just) return undefined;
      change(a.slug, just.id, (r) => {
        keep(r);
        return false;
      });
      return null;
    }
    const lines: string[] = [];
    for (const p of places) {
      const r = change(p.slug, p.id, (x) => {
        keep(x);
        lib.heardStop(x, s.at);
        return true;
      });
      unheard.delete(wsKey(p.id));
      if (!r || a.kind === 'wait' || !lib.claimStop(r.id)) continue;
      const review = store.loadReview(p.slug);
      if (review && lines.length < 2) lines.push(lib.stopLine(review.video));
    }
    return lines.length ? lines.join('\n') : null;
  }

  function sign(a: AgentActivity, account: string | undefined): string | null {
    const now = ms(a.at) || Date.now();
    const s = signOf(a, now);
    const stop = stopHeard(a, s, account);
    // about the stopped video: that is all this call is; about none: its other work hears it too
    if (stop !== undefined && a.slug) return stop;
    signRest(a, s, now, account);
    return stop ?? null;
  }

  function signRest(a: AgentActivity, s: lib.Sign, now: number, account: string | undefined) {
    const name = a.agent;
    // Its run, named (LAMPO_RUN): a hint, taken only for the same agent (and account), the same video, in this workspace.
    if (a.run) {
      const hit = lib.findRun(a.run);
      if (hit && hit.slug !== null && hit.run.agent.name === name && lib.ownerOk(hit.run, account) && (!a.slug || a.slug === hit.slug)) {
        if (hit.run.ended === null) return applyTo(hit.slug, hit.run.id, s, name, account);
        // its last lines arrive after its process ended: kept, nothing opened
        if (now - ms(hit.run.ended) <= lib.RUN_TIMES.late) {
          change(hit.slug, hit.run.id, (r) => {
            if (!s.quiet && s.words.key !== 'Thinking') lib.keepStep(r, { ...s.words, at: new Date(now).toISOString(), type: lib.stepTypeOf(s.kind) });
            return false;
          });
          return;
        }
      }
    }
    if (a.slug) {
      const slug = a.slug;
      const runs = lib.readRuns(slug);
      let run = runs.find((r) => r.ended === null && r.agent.name === name && lib.ownerOk(r, account));
      const bare = a.kind === 'wait';
      if (!run && !bare) {
        // Sent to the video's agent and begun by nobody yet: the agent that turns up takes it, under its own name — the
        // same person's agent only (by the account when the run knows it; names are one per workspace otherwise).
        const queued = runs.filter((r) => r.ended === null && r.state === 'queued');
        const q = queued[0];
        if (queued.length === 1 && q && takes(q, name, account)) {
          change(slug, q.id, (r) => {
            r.agent = lib.runAgent(name);
            return true;
          });
          run = q;
        }
      }
      if (!run && !name.includes(' · ')) {
        // Named by a person's account (an upload with their API token): the run of that account's agent on the video —
        // by its id where the run knows it.
        const theirs = runs.filter(
          (r) =>
            r.ended === null &&
            r.state !== 'queued' &&
            (r.clock.owner !== undefined ? account !== undefined && r.clock.owner === account : ownerOfName(r.agent.name) === name),
        );
        if (theirs.length === 1) run = theirs[0];
      }
      if (run) return applyTo(slug, run.id, s, name, account);
      // a write opens a run; how far an upload got (Lampo's own observation) doesn't
      if (!WRITES.has(a.kind) || (a.kind === 'upload' && (a.pct !== undefined || a.progress))) return;
      const review = store.loadReview(slug);
      if (!review || review.onboarding_sample) return;
      // Bounded: a video holds so many open runs, an account's agents so many, opened so often; past that the activity
      // still shows live, it opens nothing (a person's Send always does).
      if (runs.filter((r) => r.ended === null).length >= lib.RUN_LIMITS.openPerVideo) return;
      if (account !== undefined && (openOfAccount(account) >= lib.RUN_LIMITS.openPerAccount || !opened.take(wsKey(account)))) return;
      // The agent's own write with no run open: an implicit run (an agent that puts up V1 on its own, fixes unasked).
      const r = openRun(
        {
          slug,
          agent: lib.runAgent(name),
          opened_by: { who: name, how: 'agent' },
          notes: openNotes(review),
          state: 'working',
          owner: account ?? '',
        },
        `agent:${name}`,
      );
      return applyTo(slug, r.id, s, name, account);
    }
    // No video: a wait is for every run of the agent (it waits again after handing back), anything else joins its one
    // open run, or only says it is alive.
    const mine = openOf(name, account);
    if (a.kind === 'wait' || mine.length === 1) {
      for (const { slug, run } of mine) {
        if (slug === null) change(slug, run.id, (r) => lib.applySign(r, s));
        else applyTo(slug, run.id, s, name, account);
      }
      return;
    }
    for (const { slug, run } of mine) change(slug, run.id, (r) => lib.alive(r, now));
  }

  function handed(agent: string, slugs: readonly string[], account: string | undefined) {
    const now = Date.now();
    for (const slug of new Set(slugs)) {
      if (!slug || !store.loadReview(slug)) continue;
      const runs = lib.readRuns(slug);
      const own = runs.find((r) => r.ended === null && r.agent.name === agent && lib.ownerOk(r, account));
      const queued = runs.filter((r) => r.ended === null && r.state === 'queued');
      const run = own ?? (queued.length === 1 && queued[0] && takes(queued[0], agent, account) ? queued[0] : null);
      if (!run) continue;
      change(slug, run.id, (r) => {
        lib.claim(r, account);
        if (r.agent.name !== agent) r.agent = lib.runAgent(agent);
        // what it was handed was told of too: no new-notes line for it
        r.clock.told = r.plan.length;
        return lib.applySign(r, { at: now, kind: 'wait', words: words('Waiting for your answer'), handed: true, quiet: true });
      });
    }
  }

  /** The person answered question `note` on the video: the runs that needed them for it work again. */
  function resolve(slug: string | null, note: string, folder?: string) {
    const now = Date.now();
    const review = slug ? store.loadReview(slug) : null;
    for (const r of lib.readRuns(slug)) {
      if (r.ended !== null || r.state !== 'needs_you') continue;
      if (slug === null && r.folder !== folder) continue;
      const mine = r.needs?.note === note || !!r.clock.qs?.includes(note) || !r.needs?.note;
      if (!mine) continue;
      // another of its questions still open keeps it needing the person
      const still =
        (review?.comments ?? []).find((c) => c.id !== note && c.status === 'open' && c.kind === 'question' && r.clock.qs?.includes(c.id))?.id ?? null;
      change(slug, r.id, (x) => lib.answered(x, now, still));
    }
  }

  function event(e: ReviewEvent) {
    if (e.imported || e.type === 'run' || e.type === 'agent_run') return;
    const now = ms(e.at) || Date.now();
    if (!e.slug) return folderEvent(e, now);
    const slug = e.slug;
    if (e.type === 'removed') return;
    const runs = lib.readRuns(slug);
    if (!runs.length) return;
    if (e.type === 'version' && e.v) {
      const id = store.loadReview(slug)?.versions.find((x) => x.v === e.v)?.run ?? lib.versionRunOf(slug, e.by);
      if (id) change(slug, id, (r) => lib.versionLanded(r, e.v as number, now));
      return;
    }
    if (e.type === 'status' && e.id) {
      const to = e.status === 'fixed' ? 'fixed' : e.status === 'wontfix' ? 'wontfix' : e.status === 'open' && !isAgent(e.by) ? 'todo' : null;
      if (to)
        for (const r of runs)
          if (r.ended === null && r.plan.some((p) => p.id === e.id))
            change(slug, r.id, (x) => {
              const moved = lib.noteMoved(x, e.id as string, to, now);
              return lib.checkDone(x, now) ? ['ended'] : moved;
            });
      if (e.status === 'verified' && e.kind === 'question' && !isAgent(e.by)) resolve(slug, e.id);
      return;
    }
    // a note deleted leaves the plans it was in (nobody can answer it any more)
    if (e.type === 'delete' && e.id && !e.reply) {
      for (const r of runs)
        if (r.ended === null && r.plan.some((p) => p.id === e.id))
          change(slug, r.id, (x) => {
            const at = x.plan.findIndex((p) => p.id === e.id);
            x.plan.splice(at, 1);
            // what it was told of counts by place: one place fewer before it
            if (x.clock.told && at < x.clock.told) x.clock.told--;
            return lib.checkDone(x, now) ? ['ended'] : true;
          });
      return;
    }
    if (e.type === 'reply' && e.id && isAgent(e.by)) {
      for (const r of runs)
        if (r.ended === null && r.plan.some((p) => p.id === e.id && (p.state === 'todo' || p.state === 'doing')))
          change(slug, r.id, (x) => {
            const moved = lib.noteMoved(x, e.id as string, 'replied', now);
            return lib.checkDone(x, now) ? ['ended'] : moved;
          });
      return;
    }
    if (e.type === 'comment' && e.id && isAgent(e.by) && (e.kind === 'question' || e.options?.length)) {
      const going = runs.filter((r) => r.ended === null && r.state !== 'queued');
      const run = going.find((r) => lib.sameAgent(r.agent.name, e.by)) ?? (going.length === 1 ? going[0] : undefined);
      if (run)
        change(slug, run.id, (r) =>
          lib.askedPerson(r, now, { kind: e.options?.length ? 'options' : 'question', note: e.id as string }) ? ['needs_you'] : true,
        );
    }
  }

  /** Questions on a folder before V1: the asking agent's folder run needs the person; their answer lets it go on. */
  function folderEvent(e: ReviewEvent, now: number) {
    if (!e.folder || !e.id) return;
    if (e.type === 'comment' && isAgent(e.by)) {
      const name = agentName(e.by);
      if (!name) return;
      const needs = { kind: 'options' as const, note: e.id };
      const run = lib.readRuns(null).find((r) => r.ended === null && r.folder === e.folder && lib.sameAgent(r.agent.name, name));
      if (run) {
        change(null, run.id, (r) => (lib.askedPerson(r, now, needs) ? ['needs_you'] : true));
        return;
      }
      const r = openRun({ slug: null, folder: e.folder, agent: lib.runAgent(name), opened_by: { who: name, how: 'agent' }, state: 'working' }, e.by);
      change(null, r.id, (x) => (lib.askedPerson(x, now, needs) ? ['needs_you'] : true));
      return;
    }
    if (e.type === 'status' && !isAgent(e.by) && (e.status === 'verified' || e.reply)) resolve(null, e.id, e.folder);
  }

  function answered(req: Request, slug: string, note: string, opens: boolean) {
    resolve(slug, note);
    if (!opens || !mayOpenRun(req)) return;
    const review = store.loadReview(slug);
    const q = review?.comments.find((c) => c.id === note);
    if (!review || !q || !isAgent(q.author)) return;
    const runs = lib.newestFirst(lib.readRuns(slug));
    const prev = runs.find((r) => r.needs?.note === note || r.clock.qs?.includes(note)) ?? runs.find((r) => lib.sameAgent(r.agent.name, q.author)) ?? null;
    const agent = prev?.agent ?? assigned(review) ?? lib.runAgent(agentName(q.author) ?? 'agent');
    if (runs.some((r) => r.ended === null && r.agent.name === agent.name)) return;
    open(
      slug,
      {
        how: 'answer',
        agent,
        notes: prev ? carried(prev, review) : [],
        ...(prev ? { follows: prev.id, ...(prev.clock.owner !== undefined ? { owner: prev.clock.owner } : {}) } : {}),
      },
      whoOf(req),
    );
  }

  const whoOf = (req: Request) => ({ who: actor(req), ...(req.auth?.user?.id ? { id: req.auth.user.id } : {}) });

  function machineStarted(info: AgentRunInfo, run: string | undefined): string {
    const now = Date.now();
    const slug = info.slug;
    const agent = lib.runAgent(info.name, 'claude-code', info.session_id);
    // the run it was started for, else the one its agent has open on the video: one open run per agent × video
    const runs = lib.readRuns(slug);
    const known =
      (run ? runs.find((r) => r.id === run && r.ended === null) : undefined) ??
      runs.find((r) => r.ended === null && r.agent.name === agent.name && lib.ownerOk(r, undefined));
    if (known) {
      change(slug, known.id, (r) => {
        lib.claim(r, undefined);
        lib.machineBegan(r, info.id, now);
        return true;
      });
      return known.id;
    }
    // its process's id when no run has it yet (the log and the run read the same); this machine's own
    const r = openRun(
      {
        ...(run && !lib.findRun(run) ? { id: run } : {}),
        slug,
        agent,
        opened_by: { who: info.by, how: 'request' },
        delivery: 'machine',
        state: 'starting',
        owner: '',
      },
      info.by,
    );
    change(slug, r.id, (x) => {
      lib.machineBegan(x, info.id, now);
      return true;
    });
    return r.id;
  }

  function machineEnded(info: AgentRunInfo, run: string, exit: lib.Exit) {
    const slug = info.slug;
    const r = lib.readRuns(slug).find((x) => x.id === run || x.clock.proc === info.id);
    if (r) change(slug, r.id, (x) => lib.processEnded(x, exit, Date.now()));
  }

  function machineBlocked(info: AgentRunInfo, run: string, denied: { words: ActivityWords; allow: string }) {
    const slug = info.slug;
    const r = lib.readRuns(slug).find((x) => x.id === run || x.clock.proc === info.id);
    if (!r || r.ended !== null) return;
    const now = Date.now();
    change(slug, r.id, (x) => {
      const at = new Date(now).toISOString();
      lib.keepStep(x, { ...denied.words, at, type: 'elicitation' });
      x.now = { ...denied.words, type: 'elicitation', at };
      return lib.needsPermission(x, now, { text: denied.words, allow: denied.allow }) ? ['needs_you'] : true;
    });
  }

  function find(id: string) {
    const hit = lib.findRun(id);
    if (!hit) return null;
    settleAt(hit.slug);
    return { slug: hit.slug, run: lib.shownRun(hit.run), proc: hit.run.log ? (hit.run.clock.proc ?? hit.run.id) : null };
  }

  /** The video a call named (a slug, a path, a name; or a note's), or null. */
  function slugNamed(about: { video?: string | null; note?: string | null }): string | null {
    if (about.note && /^c_[0-9a-f]+$/i.test(about.note)) return store.findComment(about.note)?.slug ?? null;
    if (!about.video) return null;
    try {
      return store.resolveVideo(about.video).slug;
    } catch {
      return null;
    }
  }

  function news(agent: string, about: { video?: string | null; note?: string | null; read?: boolean } = {}, account?: string): string | null {
    const lines: string[] = [];
    const mine = openOf(agent, account).filter((x) => x.slug !== null && lib.untold(x.run));
    if (!mine.length) return null;
    const named = about.video || about.note ? slugNamed(about) : null;
    for (const { slug: s, run } of mine) {
      if (s === null || (named && s !== named)) continue;
      const u = lib.untold(run);
      if (!u) continue;
      const told = () =>
        change(s, run.id, (r) => {
          r.clock.told = r.plan.length;
          return false;
        });
      // it just read the video's open notes: the new ones among them
      if (about.read && named === s) {
        told();
        continue;
      }
      const review = store.loadReview(s);
      if (!review) continue;
      const tcs = u.ids.map((id) => review.comments.find((c) => c.id === id)?.timecode).filter((t): t is string => !!t);
      if (!tcs.length) continue;
      lines.push(lib.newNotesLine({ video: path.basename(review.video), timecodes: tcs, since: u.since }));
      told();
      if (lines.length >= 2) break;
    }
    return lines.length ? lines.join('\n') : null;
  }

  /** Lost runs without a word for QUIET_MS: a ping for whoever asked for one, once per run. */
  function quietAt(slug: string | null, now: number) {
    if (slug === null || !notify) return;
    for (const r of lib.readRuns(slug))
      if (r.ended === null && r.state === 'lost' && !r.clock.quiet && now - ms(r.seen) >= QUIET_MS) {
        const run = change(slug, r.id, (x) => {
          x.clock.quiet = new Date(now).toISOString();
          return false;
        });
        if (run) tell(slug, run, 'quiet', Math.floor((now - ms(run.seen)) / 60_000));
      }
  }

  function sweep(now = Date.now()) {
    for (const p of lib.openPlaces()) {
      try {
        inWorkspace(p.ws, () => {
          settleAt(p.slug, now);
          quietAt(p.slug, now);
          if (lib.isDirty(p.slug) && !pendingFlush.has(wsKey(p.slug ?? ''))) flush(p.slug);
        });
      } catch (e) {
        console.error('runs: the clock skipped a video:', (e as Error).message);
      }
    }
  }

  const timer = setInterval(() => sweep(), SWEEP_MS);
  timer.unref();

  return {
    fromPerson(req, slug, o) {
      if (!mayOpenRun(req)) return null;
      return open(slug, o, whoOf(req));
    },
    sign(a, from) {
      try {
        return sign(a, from?.account);
      } catch (e) {
        console.error('runs: an activity was not bound:', (e as Error).message);
        return null;
      }
    },
    handed(agent, slugs, account) {
      try {
        handed(agent, slugs, account);
      } catch (e) {
        console.error('runs: a hand-over was not told:', (e as Error).message);
      }
    },
    event(e) {
      try {
        event(e);
      } catch (err) {
        console.error('runs: an event was not applied:', (err as Error).message);
      }
    },
    answered(req, slug, note, opens) {
      try {
        answered(req, slug, note, opens);
      } catch (e) {
        console.error('runs: an answer was not applied:', (e as Error).message);
      }
    },
    answeredFolder(folder, note) {
      try {
        resolve(null, note, folder);
      } catch (e) {
        console.error('runs: an answer was not applied:', (e as Error).message);
      }
    },
    machineStarted,
    machineBlocked(info, run, denied) {
      try {
        machineBlocked(info, run, denied);
      } catch (e) {
        console.error('runs: a permission it lacks was not told:', (e as Error).message);
      }
    },
    machineEnded(info, run, exit) {
      try {
        machineEnded(info, run, exit);
      } catch (e) {
        console.error('runs: a process end was not applied:', (e as Error).message);
      }
    },
    seen(id) {
      const hit = lib.findRun(id);
      return hit ? ms(hit.run.seen) || null : null;
    },
    list(slug, folder) {
      settleAt(slug);
      return lib
        .newestFirst(lib.readRuns(slug))
        .filter((r) => slug !== null || !folder || r.folder === folder)
        .map((r) => lib.shownRun(r));
    },
    detail(id) {
      const hit = lib.findRun(id);
      if (!hit) return null;
      settleAt(hit.slug);
      return { slug: hit.slug, detail: { run: lib.shownRun(hit.run), steps: [...hit.run.steps].reverse() } };
    },
    find,
    stop(id, who) {
      const hit = lib.findRun(id);
      if (!hit) return null;
      const r = change(
        hit.slug,
        id,
        (x) => {
          if (x.ended !== null) return false;
          // stopped at once; an agent that listens hears it with its next call (`stop_pending`)
          lib.stoppedByPerson(x, Date.now());
          return ['ended'];
        },
        who,
      );
      if (!r) return null;
      if (r.stop_pending && hit.slug !== null) {
        // bounded: an agent that never calls again leaves its entry (the runs file still says it)
        if (unheard.size >= UNHEARD_MAX) unheard.delete(unheard.keys().next().value as string);
        unheard.set(wsKey(r.id), {
          ws: currentWorkspace(),
          slug: hit.slug,
          agent: r.agent.name,
          ...(r.clock.owner !== undefined ? { owner: r.clock.owner } : {}),
          id: r.id,
        });
      }
      const proc = r.delivery === 'machine' ? (r.clock.proc ?? r.id) : null;
      return { run: lib.shownRun(r), proc };
    },
    retry(req, id) {
      const hit = lib.findRun(id);
      if (!hit || hit.slug === null) throw fail(404, 'no such run');
      const r = hit.run;
      if (r.ended === null) throw fail(409, 'it is still at it: stop it first');
      const review = store.loadReview(hit.slug);
      if (!review) throw fail(404, 'unknown video');
      if (lib.readRuns(hit.slug).some((x) => x.ended === null && x.agent.name === r.agent.name)) throw fail(409, 'that agent is at this video already');
      const still = new Set(openNotes(review));
      const notes = r.plan.filter((p) => still.has(p.id)).map((p) => p.id);
      const run = open(
        hit.slug,
        { how: 'retry', agent: r.agent, notes, follows: r.id, request: r.request ?? null, ...(r.clock.owner !== undefined ? { owner: r.clock.owner } : {}) },
        whoOf(req),
      );
      if (!run) throw fail(409, 'no agent to try again with');
      return run;
    },
    news,
    sweep,
    flushAll() {
      for (const [k, p] of pendingFlush) {
        clearTimeout(p.timer);
        pendingFlush.delete(k);
      }
      for (const p of lib.openPlaces()) {
        try {
          inWorkspace(p.ws, () => flush(p.slug));
        } catch {}
      }
    },
    close() {
      clearInterval(timer);
    },
  };
}

/** Whose agent a listed name is (`claude-code · Mia` → `Mia`); '' for an agent of this machine. */
const ownerOfName = (n: string) => / · ([^·]*)$/.exec(n)?.[1]?.trim() ?? '';

/** Two agents of the same person (or of this machine): one may take a run sent to the other. */
const sameOwner = (a: string, b: string): boolean => ownerOfName(a) === ownerOfName(b);

/** Whether the agent `name` (of `account`) may take a queued run sent to another agent: the same account's, by its id
 * when the run knows it, else by the name it is listed under (one per workspace). */
const takes = (q: lib.StoredRun, name: string, account: string | undefined): boolean =>
  q.clock.owner !== undefined ? q.clock.owner === (account ?? '') : sameOwner(q.agent.name, name);
