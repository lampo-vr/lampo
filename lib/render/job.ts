// One `vr render`, start to end: run the agent's command (lib/render/run.ts), tell Lampo how far it is (progress lines,
// at most every 500 ms on this machine and every 2 s to a server, through the activity sinks of lib/activity.ts), then
// put `--out` up as the next version of `--to` (a re-render to the tracked path is registered where it is; anything
// else goes up as `vr push --to` does, with the upload's progress) and say so in one line for the model, plus the
// hand-off line. A failure posts the tool's last meaningful lines, redacted, and says them in one line. The same code
// runs in the foreground and in a detached render's supervisor (lib/render/detach.ts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ActivityRecord, ActivitySink } from '../activity.ts';
import { type ActivityKey, excerpt, words } from '../activityText.ts';
import type { Backend } from '../backend/types.ts';
import { stillOpenLine, WATCH_NOW_LINE } from '../handoff.ts';
import { isoLocal } from '../paths.ts';
import { probe } from '../probe.ts';
import { isRequired, oneLine } from '../time.ts';
import type { ActivityWords, AgentActivityKind, Review, RunProgress } from '../types.ts';
import { etaOf } from './eta.ts';
import { ERROR_MAX, failureWords, redact } from './redact.ts';
import { runTool, type ToolRun } from './run.ts';
import { progressOf, type Reading, type RenderStage, type RenderTool } from './tools.ts';

/** What a render is asked to do, all decided before it starts. */
export interface RenderJob {
  argv: string[];
  cwd: string;
  /** The file it writes (absolute), and as the agent wrote it. */
  out: string | null;
  outShown: string | null;
  /** The video it becomes the next version of: its slug, the number it will get, and whether `out` is the very file
   * tracked on this machine (then it is registered where it is). */
  to: { slug: string; next: number; same: boolean } | null;
  /** The agent it reports as; null for a person's own `vr render` (nothing is recorded). */
  agent: string | null;
  /** The author of the version (`vr push`'s `--by`). */
  by: string;
}

export interface RenderHooks {
  backend: Backend;
  /** Where progress goes (null: nobody is told, a person's own render). */
  sink: ActivitySink | null;
  /** The least time between two progress lines to Lampo, in ms. */
  every: number;
  /** The tool's own output, shown (`--verbose`). */
  echo?: (chunk: Buffer) => void;
  /** The render as it goes, at most every 500 ms (a detached render's state file). */
  onProgress?: (p: RunProgress, more: { bytes?: number; elapsed_s: number }) => void;
  /** The tool started: how to reach it with a signal. */
  onStart?: (run: ToolRun) => void;
  /** True once someone stopped it (Ctrl-C, a signal to the supervisor). */
  stopped?: () => boolean;
}

export interface RenderOutcome {
  ok: boolean;
  /** What `vr` exits with: the tool's own code when it failed. */
  code: number;
  /** What the model reads: one line, and on success the hand-off line. */
  lines: string[];
  v?: number;
}

/** 3m12s, 45s, 1h02m. */
export function took(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** "The render failed (exit 1) “…”": the tool's words as the quote, kept whole (≤ ERROR_MAX), unlike other quotes. */
export function failedWords(code: number, quote: string): ActivityWords {
  const key: ActivityKey = 'The render failed (exit {code})';
  const filled = `The render failed (exit ${code})`;
  const room = ERROR_MAX - filled.length - 3;
  const shown = quote.length > room ? `${quote.slice(0, room - 1).trimEnd()}…` : quote;
  return { text: quote ? `${filled} “${shown}”` : filled, key, vars: { code }, ...(quote ? { quote } : {}) };
}

const probeInput = async (file: string) => {
  try {
    const p = await probe(file);
    return { duration: p.duration, fps: p.fps };
  } catch {
    return null;
  }
};

export async function executeRender(job: RenderJob, hooks: RenderHooks): Promise<RenderOutcome> {
  const { sink } = hooks;
  const v = job.to?.next ?? null;
  const told = !!(sink && job.agent);
  const say = (kind: AgentActivityKind, w: ActivityWords, more: Partial<ActivityRecord> = {}) => {
    if (!sink || !job.agent) return;
    sink.record({ ...w, ...more, kind, at: isoLocal(), agent: job.agent, target: more.target ?? null, video: job.to?.slug ?? null });
  };

  // ---- progress: per stage, its own ETA; to Lampo at most every `every` ms. A new stage goes at once, after the last
  // word of the stage before it (a reading held back by the pace is never lost at a stage's end, or the tool's)
  let tool: RenderTool | null = null;
  let stage: RenderStage | null = null;
  let eta = etaOf();
  // the newest progress, for the failure line and the state file (an object: it is written from callbacks)
  const latest: { p: RunProgress | null } = { p: null };
  let held: RunProgress | null = null;
  let sentAt = 0;
  let stateAt = 0;
  let bytes: number | undefined;
  const t0 = Date.now();
  const send = (p: RunProgress) => {
    held = null;
    sentAt = Date.now();
    const pct = p.pct === null ? {} : { pct: p.pct };
    if (p.stage === 'uploading') say('upload', words('Uploading {name}', { name: excerpt(path.basename(job.out ?? ''), 40) }), { progress: p, ...pct });
    else if (p.stage === 'checking') say('upload', words('Registering the new version'), { progress: p });
    else if (p.pct === null && bytes) say('render', words('Rendering… {mb} MB, still growing', { mb: Math.round(bytes / 1e6) }), { progress: p });
    else say('render', words('Rendering a new version'), { progress: p, ...pct });
  };
  const flush = () => {
    if (held) send(held);
  };
  const report = (r: Reading, b?: number, force = false) => {
    const now = Date.now();
    if (r.stage !== stage) {
      flush();
      stage = r.stage;
      eta = etaOf();
      force = true;
    }
    const eta_s = r.pct === null ? undefined : eta.push(now, r.pct);
    if (b !== undefined) bytes = b;
    const p = progressOf(r, { eta_s, tool, v });
    latest.p = p;
    if (hooks.onProgress && (force || now - stateAt >= 500)) {
      stateAt = now;
      hooks.onProgress(p, { ...(bytes !== undefined ? { bytes } : {}), elapsed_s: Math.round((now - t0) / 1000) });
    }
    if (!told) return;
    if (force || now - sentAt >= hooks.every) send(p);
    else held = p;
  };

  // ---- the render
  const run = runTool({
    argv: job.argv,
    cwd: job.cwd,
    env: process.env,
    out: job.out,
    onReading: (r, _from, b) => report(r, b),
    echo: hooks.echo,
    probe: probeInput,
  });
  tool = run.tool;
  report({ stage: 'rendering', pct: null }, undefined, true);
  hooks.onStart?.(run);
  const result = await run.done;
  flush();
  const elapsed = took(result.elapsedMs);
  const sees = told ? ' The person sees it in Lampo.' : '';

  const fail = (code: number, quote: string, line: string, w: ActivityWords = failedWords(code, quote)): RenderOutcome => {
    say('error', w, latest.p ? { progress: latest.p } : {});
    return { ok: false, code, lines: [oneLine(`Render failed (exit ${code})${line ? `: ${line.replace(/[.\s]+$/, '')}` : ''}.${sees}`)] };
  };

  if (result.code !== 0 || result.startError) {
    if (result.startError) return fail(result.code, redact(result.startError), redact(result.startError));
    const said = failureWords(result.tail, { home: os.homedir() });
    if (hooks.stopped?.() || (!said.line && result.signal)) {
      const why = `stopped${result.signal ? ` (${result.signal})` : ''}${said.quote ? ` · ${said.quote}` : ''}`;
      return fail(result.code, why.slice(0, ERROR_MAX), said.line ? `stopped · ${said.line}` : 'stopped');
    }
    return fail(result.code, said.quote, said.line);
  }

  const frames = latest.p?.frames?.[1];
  if (job.out && !fs.existsSync(job.out)) {
    const why = `it finished, but ${path.basename(job.out)} isn't there: check --out`;
    return fail(1, why, why, words('Stopped with an error', undefined, why));
  }
  if (!job.to) {
    say('render', words('Rendered in {time}', { time: elapsed }));
    const what = job.outShown ? ` ${job.outShown}` : '';
    return { ok: true, code: 0, lines: [oneLine(`Rendered${what} in ${elapsed}${frames ? ` (${frames} frames)` : ''}.`)] };
  }

  // ---- the next version
  const b = hooks.backend;
  const to = job.to;
  const out = job.out as string;
  let review: Review;
  let got: number;
  let duplicate = false;
  try {
    if (to.same) {
      // re-rendered where it is tracked: registered in place (the app's watcher may have been first)
      report({ stage: 'checking', pct: null }, undefined, true);
      const before = to.next - 1;
      const r = await b.sync(to.slug);
      if (!r) throw new Error(`${to.slug} is no longer under review`);
      if (r.archived) throw new Error(`its project ${r.archived} is archived: nothing new goes in until it is restored`);
      if (r.pending) throw new Error('the file is still being written; run vr sync <video> in a moment');
      review = r.review;
      got = review.versions.at(-1)?.v ?? before;
      duplicate = got <= before;
    } else {
      report({ stage: b.kind === 'remote' ? 'uploading' : 'checking', pct: b.kind === 'remote' ? 0 : null }, undefined, true);
      const r = await b.push(out, {
        by: job.by,
        to: to.slug,
        onProgress: (sent, total) => {
          if (sent >= total) report({ stage: 'checking', pct: null });
          else report({ stage: 'uploading', pct: total > 0 ? (sent / total) * 100 : null });
        },
      });
      review = r.review;
      got = r.v;
      duplicate = r.duplicate;
    }
  } catch (e) {
    const why = redact(oneLine((e as Error).message)).slice(0, ERROR_MAX);
    say('error', words('Stopped with an error', undefined, why), latest.p ? { progress: latest.p } : {});
    return { ok: false, code: 1, lines: [oneLine(`V${to.next} rendered in ${elapsed}, but putting it up failed: ${why.replace(/[.\s]+$/, '')}.${sees}`)] };
  }

  say('upload', words('Put a new version up for review'), { target: `v${got}` });
  if (duplicate) return { ok: true, code: 0, v: got, lines: [`V${got} rendered in ${elapsed}: unchanged, the same bytes as V${got}.`, WATCH_NOW_LINE] };
  const n = review.versions.find((x) => x.v === got)?.frames ?? frames;
  const open = review.comments.filter((c) => c.status === 'open' && isRequired(c)).length;
  return {
    ok: true,
    code: 0,
    v: got,
    lines: [
      `V${got} rendered in ${elapsed} and put up for review${n ? ` (${n} frames)` : ''}.${open ? ' Now mark each note fixed.' : ''}`,
      open ? stillOpenLine(open) : WATCH_NOW_LINE,
    ],
  };
}
