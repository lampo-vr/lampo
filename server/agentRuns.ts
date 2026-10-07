// Runs Lampo starts on the person's own machine: the assigned Claude Code session resumed with a request, because it
// wasn't running (lib/agentRun.ts decides the arguments and the prompt). One run per session at a time, stopped after
// 30 minutes without a sign of it (its output, or a call it makes through Lampo) and after 3 hours in all, the output
// in cache/agent-runs/<id>.log, an `agent_run` event when it starts and when it ends, and Stop ends the whole process
// group. Each is an agent run (server/runs.ts) with delivery `machine`: its process carries the run's id in LAMPO_RUN,
// so what it does through `vr` and the stdio MCP server joins that run. Runs belong to this process: when the app
// stops, its runs stop with it (nobody would be left to time them out).
import { type ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ActivityRecord } from '../lib/activity.ts';
import { words } from '../lib/activityText.ts';
import { claudeRunArgs, RUN_RATE_MAX, RUN_RATE_WINDOW_MS, RUN_TIMEOUT_MS } from '../lib/agentRun.ts';
import { CACHE, isoLocal } from '../lib/paths.ts';
import { RateLimit } from '../lib/rateLimit.ts';
import { createRunReader } from '../lib/runStream.ts';
import { type Exit, RUN_ID, RUN_TIMES } from '../lib/runs.ts';
import { boundToWorkspace } from '../lib/scope.ts';
import { findClaude } from '../lib/sessions.ts';
import * as store from '../lib/store.ts';
import { compareTime } from '../lib/time.ts';
import type { AgentRunInfo, AgentRunPhase, ClaudeSession } from '../lib/types.ts';
import type { Broadcast } from './events.ts';
import { fail } from './http.ts';

/** Variables the run doesn't inherit: the ones that would make it think it runs inside another Claude Code session. */
export const DROPPED_ENV = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_SESSION_ID|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT)$/;

export function runEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !DROPPED_ENV.test(k)));
}

/** How long a run may go without a sign of it: VR_AGENT_RUN_TIMEOUT in seconds (1 s – 24 h), else RUN_TIMEOUT_MS. */
export function runTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const s = Number(env.VR_AGENT_RUN_TIMEOUT);
  return Number.isFinite(s) && s >= 1 && s <= 86_400 ? Math.round(s * 1000) : RUN_TIMEOUT_MS;
}

/** Finished runs kept in memory for the UI (the logs stay in the cache until pruned). */
const KEEP_DONE = 20;
/** Log files kept in cache/agent-runs. */
const KEEP_LOGS = 50;
/** After SIGTERM, a run gets this long before SIGKILL. */
const GRACE_MS = 5000;
/** How often a running run's log is read for its live step and tokens (and the UI told, when something changed). */
const LIVE_MS = 500;
/** How long a run took, as its last activity line says it. */
const took = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);

interface Run {
  info: AgentRunInfo;
  /** The agent run it is (server/runs.ts): LAMPO_RUN in its environment. */
  run: string;
  /** When its output last grew. */
  heard: number;
  proc: ChildProcess | null;
  timer: NodeJS.Timeout | null;
  /** Why it was ended, when Lampo ended it (stop, timeout, the app stopping), and who stopped it. */
  ending: AgentRunPhase | null;
  stopper: string | null;
  /** Reads the run's log as it grows (stream-json): the step it is on and the tokens so far. */
  live: { reader: ReturnType<typeof createRunReader>; text: StringDecoder; offset: number; timer: NodeJS.Timeout | null; sent: string } | null;
}

export interface StartRun {
  slug: string;
  name: string;
  sessionId: string;
  cwd: string;
  /** Who asked (the event's author). */
  by: string;
  prompt: string;
  /** The agent run it starts for (server/runs.ts); without one, a run is opened for it. */
  run?: string;
}

/** The agent runs these processes are (server/runs.ts). */
export interface MachineRuns {
  /** A process started for run `run` (or for none): the run's id. */
  started(info: AgentRunInfo, run: string | undefined): string;
  ended(info: AgentRunInfo, run: string, exit: Exit): void;
  /** When the run was last heard from (its calls through Lampo), in ms. */
  seen(run: string): number | null;
}

export interface AgentRuns {
  start(o: StartRun): AgentRunInfo;
  stop(id: string, by: string): AgentRunInfo;
  get(id: string): AgentRunInfo | null;
  /** Running and recent runs, newest first (one video's with `slug`). */
  list(slug?: string): AgentRunInfo[];
  /** The run of this session that is going, if any. */
  running(sessionId: string): AgentRunInfo | null;
  logFile(id: string): string | null;
  /** Sessions with a run going, as running sessions: the picker and "running" see them at once. */
  sessions(): ClaudeSession[];
  /** Ends every run (the app is stopping). */
  stopAll(): void;
}

export interface AgentRunOptions {
  broadcast: Broadcast;
  /** The binary (VR_CLAUDE_BIN or the one found; tests point it at a stand-in). */
  bin?: () => string;
  /** Stopped after this long without a sign (its output, its calls). */
  timeoutMs?: number;
  /** … and after this long in all. */
  capMs?: number;
  dir?: string;
  /** Where a run's steps go as live activity (server/activity.ts). */
  activity?: (a: ActivityRecord) => void;
  /** The agent runs (server/runs.ts). */
  runs?: MachineRuns;
}

export function createAgentRuns({
  broadcast,
  bin = findClaude,
  timeoutMs = runTimeoutMs(),
  capMs = RUN_TIMES.cap,
  dir = path.join(CACHE, 'agent-runs'),
  activity,
  runs: agentRunsOf,
}: AgentRunOptions): AgentRuns {
  const runs = new Map<string, Run>();
  const starts = new RateLimit(RUN_RATE_MAX, RUN_RATE_WINDOW_MS, { maxKeys: 1000 });

  const going = (sessionId: string) => [...runs.values()].find((r) => r.info.session_id === sessionId && r.info.state === 'running') || null;
  const logPath = (id: string) => path.join(dir, `${id}.log`);

  const event = (r: Run, phase: AgentRunPhase, by: string) => {
    const review = store.loadReview(r.info.slug);
    if (!review) return;
    store.logEvent({ type: 'agent_run', by, review, v: review.versions.at(-1)?.v, run: r.info.id, phase, exit: phase === 'started' ? undefined : r.info.exit });
  };
  // Running or not shows on the video (its summary), the agents list and the run itself.
  const changed = (r: Run) => {
    broadcast('agent-runs', { slug: r.info.slug });
    broadcast('sessions');
    broadcast('library', { slug: r.info.slug });
    broadcast('review', { slug: r.info.slug });
  };

  function prune() {
    const done = [...runs.values()].filter((r) => r.info.state !== 'running').sort((a, b) => compareTime(a.info.started, b.info.started));
    for (const r of done.slice(0, Math.max(0, done.length - KEEP_DONE))) runs.delete(r.info.id);
    try {
      const logs = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.log'))
        .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => a.t - b.t);
      for (const { f } of logs.slice(0, Math.max(0, logs.length - KEEP_LOGS))) fs.rmSync(path.join(dir, f), { force: true });
    } catch {}
  }

  // The run and everything it started: the process group (it runs detached, as the group's leader).
  const killGroup = (r: Run, signal: NodeJS.Signals) => {
    const pid = r.proc?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        r.proc?.kill(signal);
      } catch {}
    }
  };

  const end = (r: Run, phase: AgentRunPhase) => {
    if (r.info.state !== 'running' || r.ending) return;
    r.ending = phase;
    killGroup(r, 'SIGTERM');
    setTimeout(() => r.info.state === 'running' && killGroup(r, 'SIGKILL'), GRACE_MS).unref();
  };

  // What the run printed since the last look, into its live step and tokens; each new step is activity too.
  const readLive = (r: Run) => {
    const l = r.live;
    if (!l) return;
    let size = 0;
    try {
      size = fs.statSync(logPath(r.info.id)).size;
    } catch {
      return;
    }
    if (size <= l.offset) return;
    r.heard = Date.now();
    const len = Math.min(size - l.offset, 512 * 1024);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(logPath(r.info.id), 'r');
    try {
      fs.readSync(fd, buf, 0, len, l.offset);
    } finally {
      fs.closeSync(fd);
    }
    l.offset += len;
    for (const { kind, ...step } of l.reader.feed(l.text.write(buf)))
      if (kind !== 'run') activity?.({ at: isoLocal(), agent: r.info.name, slug: r.info.slug, kind, ...step, run: r.run });
    const st = l.reader.state();
    r.info.live = { step: st.step, tokens: st.tokens, cost_usd: st.cost_usd, turns: st.turns, updated: isoLocal() };
    const sig = JSON.stringify([st.step, st.tokens, st.cost_usd]);
    if (sig !== l.sent) {
      l.sent = sig;
      broadcast('agent-runs', { slug: r.info.slug });
    }
  };

  const finished = (r: Run, code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
    if (r.info.state !== 'running') return;
    if (r.live) {
      try {
        readLive(r);
      } catch {}
      if (r.live.timer) clearInterval(r.live.timer);
      r.live.timer = null;
    }
    if (r.timer) clearInterval(r.timer);
    r.timer = null;
    r.info.exit = code;
    r.info.ended = isoLocal();
    r.info.state = error ? 'failed' : r.ending || (code === 0 ? 'finished' : signal ? 'stopped' : 'finished');
    if (error)
      try {
        fs.appendFileSync(logPath(r.info.id), `\n[lampo] could not start: ${error.message}\n`);
      } catch {}
    event(r, r.info.state, r.stopper || 'system');
    const time = took((Date.parse(r.info.ended || '') || Date.now()) - (Date.parse(r.info.started) || Date.now()));
    const how =
      r.info.state === 'finished'
        ? words('Finished after {time}', { time })
        : r.info.state === 'timeout'
          ? words('Stopped at the time limit')
          : r.info.state === 'failed'
            ? words('Couldn’t start')
            : words('Stopped after {time}', { time });
    activity?.({ at: isoLocal(), agent: r.info.name, slug: r.info.slug, kind: 'run', ...how, run: r.run });
    const st = r.live?.reader.state();
    const phase = r.info.state;
    agentRunsOf?.ended({ ...r.info }, r.run, {
      phase: phase === 'started' ? 'finished' : phase,
      code,
      summary: st?.summary ?? null,
      ...(st ? { tokens: st.tokens, cost_usd: st.cost_usd } : {}),
    });
    changed(r);
    prune();
  };

  return {
    start(o) {
      if (going(o.sessionId)) throw fail(409, `${o.name} is already working on a request from Lampo`);
      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(o.cwd);
      } catch {}
      if (!stat?.isDirectory()) throw fail(400, `${o.name}'s folder isn't there any more`);
      if (!starts.take(o.sessionId))
        throw fail(429, `${o.name} was started ${RUN_RATE_MAX} times in ${RUN_RATE_WINDOW_MS / 60_000} minutes; wait a little`, {
          retryAfter: starts.retryAfter(o.sessionId),
        });
      const args = claudeRunArgs(o.sessionId, o.prompt);
      // A log is the agent's whole transcript (what it read, what commands printed): its owner's alone (A12 AGENT-13).
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      // the agent run's own id when it is free (one process per run), so its log and its run read the same
      const id = o.run && RUN_ID.test(o.run) && !runs.has(o.run) ? o.run : `run_${crypto.randomBytes(6).toString('hex')}`;
      const info: AgentRunInfo = {
        id,
        slug: o.slug,
        name: o.name,
        session_id: o.sessionId,
        cwd: o.cwd,
        by: o.by,
        started: isoLocal(),
        ended: null,
        state: 'running',
        exit: null,
      };
      const run = agentRunsOf ? agentRunsOf.started({ ...info }, o.run ?? id) : (o.run ?? id);
      const out = fs.openSync(logPath(id), 'a', 0o600);
      const r: Run = {
        info,
        run,
        heard: Date.now(),
        proc: null,
        timer: null,
        ending: null,
        stopper: null,
        live: { reader: createRunReader(o.cwd), text: new StringDecoder('utf8'), offset: 0, timer: null, sent: '' },
      };
      runs.set(id, r);
      try {
        // An argument list, never a shell; its own process group, so Stop reaches whatever it starts.
        // what it does through `vr` and the stdio MCP server names its run (a hint the server checks: server/runs.ts)
        r.proc = spawn(bin(), args, { cwd: o.cwd, env: { ...runEnv(process.env), LAMPO_RUN: run }, detached: true, stdio: ['ignore', out, out] });
      } catch (e) {
        fs.closeSync(out);
        finished(r, null, null, e as Error);
        throw fail(500, `couldn't start ${o.name}`);
      }
      fs.closeSync(out);
      r.proc.on('error', (e) => finished(r, null, null, e));
      r.proc.on('exit', (code, signal) => finished(r, code, signal));
      // Stopped after timeoutMs without a sign — its output growing, or a call it made through Lampo — and at capMs in all.
      const began = Date.now();
      r.timer = setInterval(
        boundToWorkspace(() => {
          if (r.info.state !== 'running') return;
          const now = Date.now();
          const heard = Math.max(r.heard, agentRunsOf?.seen(r.run) ?? 0);
          if (now - heard >= timeoutMs || now - began >= capMs) end(r, 'timeout');
        }),
        Math.max(50, Math.min(Math.round(timeoutMs / 3), 30_000)),
      );
      r.timer.unref();
      if (r.live) {
        r.live.timer = setInterval(() => {
          try {
            readLive(r);
          } catch {}
        }, LIVE_MS);
        r.live.timer.unref();
      }
      activity?.({ at: isoLocal(), agent: o.name, slug: o.slug, kind: 'run', ...words('Started by Lampo'), run });
      event(r, 'started', o.by);
      changed(r);
      return { ...r.info };
    },

    stop(id, by) {
      const r = runs.get(id);
      if (!r) throw fail(404, 'no such run');
      if (r.info.state === 'running') {
        r.stopper = by;
        end(r, 'stopped');
      }
      return { ...r.info };
    },

    get: (id) => {
      const r = runs.get(id);
      return r ? { ...r.info } : null;
    },

    // Newest first. `started` has whole seconds: of two runs started in the same second the later one comes first (the
    // agent menu shows runs[0] as the latest; insertion order put the older one there).
    list: (slug) =>
      [...runs.values()]
        .reverse()
        .map((r) => ({ ...r.info }))
        .filter((i) => !slug || i.slug === slug)
        .sort((a, b) => compareTime(b.started, a.started)),

    running: (sessionId) => {
      const r = going(sessionId);
      return r ? { ...r.info } : null;
    },

    logFile: (id) => (runs.has(id) && fs.existsSync(logPath(id)) ? logPath(id) : null),

    sessions: () =>
      [...runs.values()]
        .filter((r) => r.info.state === 'running')
        .map((r) => ({
          name: r.info.name,
          sessionId: r.info.session_id,
          pid: r.proc?.pid ?? null,
          cwd: r.info.cwd,
          kind: 'lampo',
          status: 'working',
          startedAt: Date.parse(r.info.started) || null,
          agent: 'claude-code' as const,
        })),

    stopAll() {
      for (const r of runs.values()) if (r.info.state === 'running') end(r, 'stopped');
    },
  };
}
