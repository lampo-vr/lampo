// Agents' runs (server/runs.ts, lib/runs.ts): one stretch of an agent's work on a video, its plan, steps and result.
//   GET  /api/runs?slug=          a video's runs, newest first (RunsResponse); ?folder= the runs on a folder's question
//   GET  /api/runs/:id            one run with its kept steps (RunDetail)
//   GET  /api/runs/:id/log        the raw log of a run this machine started (the machine itself only, like its agent-run log)
//   POST /api/runs/:id/stop       the person stops it: stopped at once, its process (this machine's) ended
//   POST /api/runs/:id/retry      Try again: the follow-up run on the notes still open, delivered like a Send
//   POST /api/runs/:id/nudge      today's nudge for this agent and video, on the same run
// Reading is for whoever may read the video (never through a review link: those paths are /api/g/…); the writes are a
// person's with the agents right, never an API token's (server/permissions.ts). No path on this disk is ever shown.
import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Router } from 'express';
import { z } from 'zod';
import { checkReviewOpen } from '../../lib/folderIds.ts';
import { plainHead, RUN_ID } from '../../lib/runs.ts';
import * as store from '../../lib/store.ts';
import type { Run, RunDetail, RunsResponse, RunWriteResponse } from '../../lib/types.ts';
import type { ServerContext } from '../context.ts';
import { getReview, seesAgentDetails } from '../helpers.ts';
import { body, fail, query, router } from '../http.ts';
import { checkWake, requireMachine, startAgent } from '../wake.ts';

const RunsQuery = z.object({ slug: z.string().max(1024).optional(), folder: z.string().max(store.FOLDER_LIMITS.length).optional() });
const RetryBody = z.object({ start: z.boolean().optional() });
const NudgeBody = z.object({ text: z.string().max(2000).optional(), start: z.boolean().optional() });
/** The most of a run's log the UI gets (its end: that's where it says what it did). */
const LOG_TAIL = 256 * 1024;

/**
 * A run as this reader sees it. Who works with agents (the agents right) reads all of it; anyone else (a reviewer) reads
 * what it is and where it stands, never what it worked on in the project (lib/runs.ts plainHead) nor which session and
 * computer its agent runs in — as GET /api/agent-activity, which is the agents right's alone.
 */
export const runFor =
  (req: Request) =>
  (r: Run): Run => {
    if (seesAgentDetails(req)) return r;
    const { session_id: _s, runner: _r, ...agent } = r.agent;
    return plainHead({ ...r, agent });
  };

export function runRoutes(ctx: ServerContext): Router {
  const r = router();
  const idOf = (req: Request): string => {
    const id = req.params.id;
    if (typeof id !== 'string' || !RUN_ID.test(id)) throw fail(404, 'no such run');
    return id;
  };
  /** A run of a video (a folder's has nothing to stop, try again or nudge here). */
  const ofVideo = (id: string) => {
    const hit = ctx.runs.find(id);
    if (!hit) throw fail(404, 'no such run');
    if (hit.slug === null) throw fail(409, 'that run is about a question on a folder: answer it there');
    return { slug: hit.slug, run: hit.run, proc: hit.proc };
  };

  r.get('/api/runs', (req, res) => {
    const q = query(RunsQuery, req);
    if (!q.slug && !q.folder) throw fail(400, 'name the video (slug) or the folder');
    if (q.slug) getReview(q.slug);
    const out: RunsResponse = { runs: ctx.runs.list(q.slug ?? null, q.folder).map(runFor(req)) };
    res.json(out);
  });

  r.get('/api/runs/:id', (req, res) => {
    const hit = ctx.runs.detail(idOf(req));
    if (!hit) throw fail(404, 'no such run');
    // its steps (files, commands, a tool's last words, its own words) are for who works with agents
    const out: RunDetail = { run: runFor(req)(hit.detail.run), steps: seesAgentDetails(req) ? hit.detail.steps : [] };
    res.json(out);
  });

  // What the agent printed: only where today's agent-run log is served (this machine, from the machine itself).
  r.get('/api/runs/:id/log', (req, res) => {
    requireMachine(req, ctx);
    const hit = ctx.runs.find(idOf(req));
    const file = hit?.run.log && hit.proc ? ctx.agentRuns.logFile(hit.proc) : null;
    if (!file) throw fail(404, 'no log for that run');
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(size, LOG_TAIL);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      res.type('text/plain; charset=utf-8').set('Cache-Control', 'no-store').send(buf);
    } finally {
      fs.closeSync(fd);
    }
  });

  r.post('/api/runs/:id/stop', (req, res) => {
    const id = idOf(req);
    const who = ctx.actor(req);
    // A process this machine runs for it is stopped from the machine itself only, as at /api/agent-runs/:id/stop:
    // checked before anything changes.
    const before = ctx.runs.find(id);
    if (before?.proc && ctx.agentRuns.get(before.proc)?.state === 'running') requireMachine(req, ctx);
    const done = ctx.runs.stop(id, who);
    if (!done) throw fail(404, 'no such run');
    // the process this machine started for it ends with it (a listening agent hears it at its next call: later)
    if (done.proc && ctx.agentRuns.get(done.proc)?.state === 'running') ctx.agentRuns.stop(done.proc, who);
    const out: RunWriteResponse = { run: runFor(req)(done.run) };
    res.json(out);
  });

  r.post('/api/runs/:id/retry', express.json(), async (req, res) => {
    const id = idOf(req);
    const b = body(RetryBody, req);
    const { slug } = ofVideo(id);
    const review = getReview(slug);
    // checked first: nothing new goes into an archived project, and a start that can't happen opens nothing
    checkReviewOpen(review);
    if (b.start) checkWake(req, ctx, review);
    const run = ctx.runs.retry(req, id);
    // a listening agent hears it as a request (what wait_for_feedback and `vr watch` hand over)
    const n = run.plan.length;
    const text = n ? `Try again: ${n} note${n === 1 ? '' : 's'} still open.` : `Try again${run.request ? `: ${run.request}` : '.'}`;
    const words = store.addRequest(slug, text, ctx.actor(req));
    if (b.start) await startAgent(req, ctx, slug, review, words, run.id);
    const out: RunWriteResponse = { run: runFor(req)(ctx.runs.find(run.id)?.run ?? run) };
    res.json(out);
  });

  r.post('/api/runs/:id/nudge', express.json(), async (req, res) => {
    const id = idOf(req);
    const b = body(NudgeBody, req);
    const { slug, run } = ofVideo(id);
    if (run.ended !== null) throw fail(409, 'that run has ended: try again instead');
    const review = getReview(slug);
    checkReviewOpen(review);
    if (b.start) checkWake(req, ctx, review);
    // the same run: a lost one waits for the agent's next sign to work again
    const words = store.addRequest(
      slug,
      (b.text || '').trim() || `${path.basename(review.video)}: are you still on it? Go on where you left off.`,
      ctx.actor(req),
    );
    if (b.start) await startAgent(req, ctx, slug, review, words, run.id);
    const out: RunWriteResponse = { run: runFor(req)(ctx.runs.find(id)?.run ?? run) };
    res.json(out);
  });

  return r;
}
