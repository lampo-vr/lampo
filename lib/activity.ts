// Where an agent's process reports what it did through Lampo (lib/activityText.ts): the app shows it live. On this
// machine the `lampo` CLI and the stdio MCP server append a line to a small rolling file in the cache, which the app
// tails; against a hosted server they send a batch now and then. The app's own MCP endpoint records in memory
// (server/activity.ts). None of it adds a single token to the agent's work: it is the calls it makes anyway.
import fs from 'node:fs';
import path from 'node:path';
import { readCredentials } from './backend/credentials.ts';
import { createApi } from './backend/remote.ts';
import { setting } from './env.ts';
import { cleanAgentName } from './names.ts';
import { CACHE, isoLocal } from './paths.ts';
import { currentSession } from './sessions.ts';
import { oneLine } from './time.ts';
import type { AgentActivity } from './types.ts';

/** The rolling file the app tails. */
export const ACTIVITY_FILE = path.join(CACHE, 'agent-activity.jsonl');
/** Rotated (to .1) past this size; the app reads only what was appended since it last looked. */
export const ACTIVITY_MAX_BYTES = 512 * 1024;

/** What an agent's process records: the server fills in the slug. */
export type ActivityRecord = Omit<AgentActivity, 'slug'> & { slug?: string | null; video?: string | null };

export interface ActivitySink {
  record(a: ActivityRecord): void;
  /** Sends what is still queued (a CLI waits for it, briefly, before it exits). Resolves with what the server had for
   * the agent: lines its answer ends with (the person stopped its work), once. */
  flush(): Promise<string[]>;
  /** Lines the server sent back with an earlier batch, not told yet (a long-lived process adds them to its next
   * answer). Taken once. */
  heard(): string[];
}

/** Appends one JSON line per activity to the rolling file (this machine). Never throws: activity is a courtesy. */
export function fileSink(file = ACTIVITY_FILE): ActivitySink {
  return {
    record(a) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        try {
          const st = fs.statSync(file);
          if (st.size > ACTIVITY_MAX_BYTES) fs.renameSync(file, `${file}.1`);
          // What an agent did on which video is its owner's alone, on a shared machine too (A12 AGENT-13): a file an
          // older version made readable for everyone is closed now.
          else if (st.mode & 0o077) fs.chmodSync(file, 0o600);
        } catch {}
        fs.appendFileSync(file, `${JSON.stringify(a)}\n`, { mode: 0o600 });
      } catch {}
    },
    flush: async () => [],
    heard: () => [],
  };
}

/** What a hosted server answers a batch with: the lines for its agent (server/routes/sessions.ts), a few short ones. */
const linesOf = (answer: unknown): string[] => {
  const lines = (answer as { lines?: unknown } | null)?.lines;
  return Array.isArray(lines)
    ? lines
        .filter((l): l is string => typeof l === 'string')
        .map((l) => oneLine(l).slice(0, 500))
        .slice(0, 2)
    : [];
};

/** Batches activity to a hosted server (one POST at most every 2 s, at most 20 entries). */
export function remoteSink(post: (entries: ActivityRecord[]) => Promise<unknown>): ActivitySink {
  let queue: ActivityRecord[] = [];
  let timer: NodeJS.Timeout | null = null;
  let sending: Promise<void> = Promise.resolve();
  // what the server answered with and nobody was told yet
  let heard: string[] = [];
  const send = () => {
    timer = null;
    const batch = queue.slice(-20);
    queue = [];
    if (!batch.length) return sending;
    sending = sending.then(() =>
      post(batch).then(
        (answer) => {
          heard = [...heard, ...linesOf(answer)].slice(-2);
        },
        () => {},
      ),
    );
    return sending;
  };
  const take = () => {
    const out = heard;
    heard = [];
    return out;
  };
  return {
    record(a) {
      queue.push(a);
      if (queue.length > 50) queue = queue.slice(-20);
      if (!timer) {
        timer = setTimeout(send, 2000);
        timer.unref?.();
      }
    },
    async flush() {
      if (timer) clearTimeout(timer);
      await Promise.race([send(), new Promise((r) => setTimeout(r, 800))]);
      return take();
    },
    heard: take,
  };
}

/** The sink for this process: the hosted server it is logged in to, else the file on this machine. Every line names the
 * run this process works for, when Lampo started it for one (`LAMPO_RUN`). */
export function openActivitySink(env: NodeJS.ProcessEnv = process.env): ActivitySink {
  const c = readCredentials();
  const sink = c ? remoteSink((entries) => createApi(c).call('POST', '/api/agents/activity', { entries })) : fileSink();
  return taggedWithRun(sink, lampoRun(env));
}

/** A run's id as the server makes them (lib/runs.ts `newRunId`): the one pattern every reader of a run id checks. */
export const RUN_ID = /^run_[0-9a-f]{12}$/;

/** The run Lampo started this process for (`LAMPO_RUN`), when it names one. Only a hint: the server binds a line to
 * that run only when it is the same agent's, on the same video, in the same workspace (server/runs.ts). */
export const lampoRun = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const run = setting('LAMPO_RUN', env);
  return run && RUN_ID.test(run) ? run : undefined;
};

/** Every activity of a process Lampo started for a run names that run: a hint the server checks (server/runs.ts). */
export function taggedWithRun(sink: ActivitySink, run = lampoRun()): ActivitySink {
  if (!run) return sink;
  return { record: (a) => sink.record({ ...a, run: a.run ?? run }), flush: () => sink.flush(), heard: () => sink.heard() };
}

/** The agent this process works for, by the name the UI shows: the Claude Code session, else LAMPO_BY's agent name.
 * Null for a person running `lampo` by hand: their commands are not agent activity. */
export function processAgent(env: NodeJS.ProcessEnv = process.env): string | null {
  const s = currentSession();
  const own = s?.name ? cleanAgentName(s.name) : '';
  if (own) return own;
  const by = setting('LAMPO_BY', env)?.match(/^agent:([\s\S]+)$/)?.[1];
  return (by && cleanAgentName(by)) || null;
}

/** Who a `lampo` command records as: the agent (processAgent), else, in a run Lampo started that names no agent, "agent".
 * Null for a person's own `lampo`. */
export function cliAgent(env: NodeJS.ProcessEnv = process.env): string | null {
  return processAgent(env) ?? (lampoRun(env) ? 'agent' : null);
}

export const stamp = (): string => isoLocal();
