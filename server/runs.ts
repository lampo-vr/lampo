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
import * as lib from '../lib/runs.ts';
import { boundToWorkspace, currentWorkspace, inWorkspace, wsKey } from '../lib/scope.ts';
import * as store from '../lib/store.ts';
import { isAgent, isIdea, isRequired } from '../lib/time.ts';
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

/** What an agent's own write is: these open a run when none is open (reads and waits never do). */
const WRITES = new Set<AgentActivityKind>(['note', 'fix', 'reply', 'ask', 'upload', 'render', 'error', 'status']);

/** Whether this request may open a run: a person (never an API token) whose role has the agents right. */
export const mayOpenRun = (req: Request): boolean => !!req.auth && req.auth.via !== 'token' && can(req.auth.role, 'agents');

export interface PersonOpen {
  how: RunOpenedHow;
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
  /** One recorded activity (server/activity.ts, any source): joins its run, or opens one for a write. */
  sign(a: AgentActivity): void;
  /** A wait of `agent` handed over what waited on these videos: their queued runs begin. */
  handed(agent: string, slugs: readonly string[]): void;
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
  news(agent: string, about?: { video?: string | null; note?: string | null; read?: boolean }): string | null;
  /** The clock: quiet runs go lost, an hour lost closes them; what changed is written. */
  sweep(now?: number): void;
  /** Writes everything not written yet (the process is stopping). */
  flushAll(): void;
  close(): void;
}

export interface RunsOptions {
  broadcast: Broadcast;
  /** The author for a write of this request (ctx.actor). */
  actor: (req: Request) => string;
}

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

export function createRuns({ broadcast, actor }: RunsOptions): Runs {
  const pendingEvent = new Map<string, NodeJS.Timeout>();
  const pendingFlush = new Map<string, { timer: NodeJS.Timeout; soon: boolean }>();

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

  /** A change to one run, then what it means: events for its phases, the SSE, the write. */
  function change(slug: string | null, id: string, fn: (r: lib.StoredRun) => RunPhase[] | boolean | undefined, by?: string): lib.StoredRun | null {
    let phases: RunPhase[] = [];
    let moved = false;
    const run = lib.changeRuns(slug, (runs) => {
      const r = runs.find((x) => x.id === id);
      if (!r) return null;
      const before = `${r.state}|${r.ended}`;
      const out = fn(r);
      if (Array.isArray(out)) phases = out;
      moved = phases.length > 0 || before !== `${r.state}|${r.ended}` || out === true;
      return r;
    });
    if (!run) return null;
    for (const p of phases) logPhase(slug, run, p, by);
    announce(slug, run.id);
    schedule(slug, moved);
    return run;
  }

  /** A `run` event in the video's log (folder runs have no video: their questions' own events say it). */
  function logPhase(slug: string | null, r: Run, phase: RunPhase, by?: string) {
    if (slug === null) return;
    const review = store.loadReview(slug);
    if (!review) return;
    const text = phase === 'ended' ? r.state : phase === 'opened' ? r.opened_by.how : undefined;
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

  /** The open runs of `agent` in this workspace, wherever they are. */
  function openOf(agent: string): { slug: string | null; run: lib.StoredRun }[] {
    const ws = currentWorkspace();
    const out: { slug: string | null; run: lib.StoredRun }[] = [];
    for (const p of lib.openPlaces()) {
      if (p.ws !== ws) continue;
      for (const run of lib.readRuns(p.slug)) if (run.ended === null && run.agent.name === agent) out.push({ slug: p.slug, run });
    }
    return out;
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
    const going = lib.readRuns(slug).find((r) => r.ended === null && r.agent.name === agent.name);
    if (going) {
      const r = change(slug, going.id, (x) => {
        const added = o.notes?.length ? lib.addNotes(x, o.notes) : [];
        if (o.request) x.request = lib.requestText(o.request);
        return added.length > 0 || !!o.request;
      });
      return r && lib.shownRun(r);
    }
    const notes = o.notes ?? (o.how === 'nudge' ? openNotes(review) : []);
    const r = openRun(
      {
        slug,
        agent,
        opened_by: { who: who.who, ...(who.id ? { id: who.id } : {}), how: o.how },
        notes,
        request: o.request,
        ...(o.follows ? { follows: o.follows } : {}),
      },
      who.who,
    );
    return lib.shownRun(r);
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
  function applyTo(slug: string, id: string, s: lib.Sign, agent: string) {
    const q = lib.stepTypeOf(s.kind) === 'elicitation' ? questionOf(slug, agent, s.at) : null;
    change(slug, id, (r) => {
      const sign: lib.Sign = {
        ...s,
        ...(s.words.key === 'Looking at frame {frame}' ? { atFrame: atFrame(slug, r, s.words.vars?.frame) } : {}),
        ...(q ? { needs: { kind: q.options ? ('options' as const) : ('question' as const), note: q.note } } : {}),
      };
      return lib.applySign(r, sign);
    });
  }

  function sign(a: AgentActivity) {
    const now = ms(a.at) || Date.now();
    const name = a.agent;
    const s = signOf(a, now);
    // Its run, named (LAMPO_RUN): a hint, taken only for the same agent (and account), the same video, in this workspace.
    if (a.run) {
      const hit = lib.findRun(a.run);
      if (hit && hit.slug !== null && hit.run.agent.name === name && (!a.slug || a.slug === hit.slug)) {
        if (hit.run.ended === null) return applyTo(hit.slug, hit.run.id, s, name);
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
      let run = runs.find((r) => r.ended === null && r.agent.name === name);
      const bare = a.kind === 'wait';
      if (!run && !bare) {
        // Sent to the video's agent and begun by nobody yet: the agent that turns up takes it, under its own name — the
        // same person's agent only.
        const queued = runs.filter((r) => r.ended === null && r.state === 'queued');
        const q = queued[0];
        if (queued.length === 1 && q && sameOwner(q.agent.name, name)) {
          change(slug, q.id, (r) => {
            r.agent = lib.runAgent(name);
            return true;
          });
          run = q;
        }
      }
      if (run) return applyTo(slug, run.id, s, name);
      if (!WRITES.has(a.kind)) return;
      const review = store.loadReview(slug);
      if (!review || review.onboarding_sample) return;
      // The agent's own write with no run open: an implicit run (an agent that puts up V1 on its own, fixes unasked).
      const r = openRun(
        {
          slug,
          agent: lib.runAgent(name),
          opened_by: { who: name, how: 'agent' },
          notes: openNotes(review),
          state: 'working',
        },
        `agent:${name}`,
      );
      return applyTo(slug, r.id, s, name);
    }
    // No video: a wait is for every run of the agent (it waits again after handing back), anything else joins its one
    // open run, or only says it is alive.
    const mine = openOf(name);
    if (a.kind === 'wait' || mine.length === 1) {
      for (const { slug, run } of mine) {
        if (slug === null) change(slug, run.id, (r) => lib.applySign(r, s));
        else applyTo(slug, run.id, s, name);
      }
      return;
    }
    for (const { slug, run } of mine) change(slug, run.id, (r) => lib.alive(r, now));
  }

  function handed(agent: string, slugs: readonly string[]) {
    const now = Date.now();
    for (const slug of new Set(slugs)) {
      if (!slug || !store.loadReview(slug)) continue;
      const runs = lib.readRuns(slug);
      const own = runs.find((r) => r.ended === null && r.agent.name === agent);
      const queued = runs.filter((r) => r.ended === null && r.state === 'queued');
      const run = own ?? (queued.length === 1 && queued[0] && sameOwner(queued[0].agent.name, agent) ? queued[0] : null);
      if (!run) continue;
      change(slug, run.id, (r) => {
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
    open(slug, { how: 'answer', agent, notes: prev ? carried(prev, review) : [], ...(prev ? { follows: prev.id } : {}) }, whoOf(req));
  }

  const whoOf = (req: Request) => ({ who: actor(req), ...(req.auth?.user?.id ? { id: req.auth.user.id } : {}) });

  function machineStarted(info: AgentRunInfo, run: string | undefined): string {
    const now = Date.now();
    const slug = info.slug;
    const known = run ? lib.readRuns(slug).find((r) => r.id === run && r.ended === null) : undefined;
    if (known) {
      change(slug, known.id, (r) => {
        lib.machineBegan(r, info.id, now);
        return true;
      });
      return known.id;
    }
    const r = openRun(
      {
        ...(run ? { id: run } : {}),
        slug,
        agent: lib.runAgent(info.name, 'claude-code', info.session_id),
        opened_by: { who: info.by, how: 'request' },
        delivery: 'machine',
        state: 'starting',
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

  function news(agent: string, about: { video?: string | null; note?: string | null; read?: boolean } = {}): string | null {
    const lines: string[] = [];
    const mine = openOf(agent).filter((x) => x.slug !== null && lib.untold(x.run));
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

  function sweep(now = Date.now()) {
    for (const p of lib.openPlaces()) {
      try {
        inWorkspace(p.ws, () => {
          settleAt(p.slug, now);
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
    sign(a) {
      try {
        sign(a);
      } catch (e) {
        console.error('runs: an activity was not bound:', (e as Error).message);
      }
    },
    handed(agent, slugs) {
      try {
        handed(agent, slugs);
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
          lib.endRun(x, 'stopped', Date.now());
          return ['ended'];
        },
        who,
      );
      if (!r) return null;
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
      const run = open(hit.slug, { how: 'retry', agent: r.agent, notes, follows: r.id, request: r.request ?? null }, whoOf(req));
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

/** Two agents of the same person (or of this machine): one may take a run sent to the other. */
function sameOwner(a: string, b: string): boolean {
  const owner = (n: string) => / · ([^·]*)$/.exec(n)?.[1]?.trim() ?? '';
  return owner(a) === owner(b);
}
