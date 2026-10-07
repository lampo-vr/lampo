// Agents — Claude Code sessions on this machine and agents that connected (MCP clients, `vr watch`): which are running
// (ranked for a video), which one a video is handed to, and the agent side of a remote setup (heartbeats, the inbox).
import fs from 'node:fs';
import express, { type Router } from 'express';
import { z } from 'zod';
import { ownedAgentName } from '../../lib/activityText.ts';
import { AGENT_KINDS } from '../../lib/agentKind.ts';
import { isInboxEvent } from '../../lib/eventLine.ts';
import { isoLocal } from '../../lib/paths.ts';
import { ERROR_MAX } from '../../lib/render/redact.ts';
import { RENDER_STAGES, RENDER_TOOLS } from '../../lib/render/tools.ts';
import { PROGRESS_ETA_MAX, RUN_ID } from '../../lib/runs.ts';
import { rankSessions } from '../../lib/sessions.ts';
import * as store from '../../lib/store.ts';
import type { AgentActivityResponse, AgentKind, SessionsResponse } from '../../lib/types.ts';
import type { ServerContext } from '../context.ts';
import { agentView, getReview } from '../helpers.ts';
import { body, fail, query, router } from '../http.ts';
import { checkWake, requireMachine, startAgent } from '../wake.ts';

const SessionsQuery = z.object({ fresh: z.string().optional(), video: z.string().optional() });
// `{}` (or no name) unassigns; extra fields the UI sends along (pid, kind, score …) are ignored.
const Kind = z.enum(AGENT_KINDS as [AgentKind, ...AgentKind[]]);
const Assign = z.object({
  name: z.string().max(200).nullish(),
  sessionId: z.string().max(200).nullish(),
  cwd: z.string().max(1000).nullish(),
  by: z.string().max(100).nullish(),
  agent: Kind.nullish(),
});
const Heartbeat = z.object({
  session_id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  cwd: z.string().max(1000).nullish(),
  host: z.string().max(200).nullish(),
  kind: Kind.optional(),
});
const RunsQuery = z.object({ slug: z.string().max(1000).optional() });
const ActivityQuery = z.object({ slug: z.string().max(1000).optional(), agent: z.string().max(200).optional() });
// A render or upload under way, as `vr render` posts it: only the contract's words and sane numbers (cleanProgress in
// lib/runs.ts keeps to the same rules for what comes in any other way).
const Progress = z
  .object({
    what: z.enum(['render', 'upload', 'check']),
    stage: z.enum(RENDER_STAGES),
    pct: z.number().min(0).max(100).nullable(),
    frames: z.tuple([z.number().int().min(0).max(1e8), z.number().int().min(0).max(1e8)]).optional(),
    eta_s: z.number().min(0).max(PROGRESS_ETA_MAX).optional(),
    tool: z.enum(RENDER_TOOLS).optional(),
    v: z.number().int().min(1).max(1e6).optional(),
  })
  .strict();
// What an agent of a hosted server did (lib/activity.ts remoteSink batches it): plain words, small, at most 20. Only
// the kinds an agent's own `vr` / MCP calls make (`vr render`'s progress and failure among them): what Lampo saw
// itself (a run, a render growing on disk) isn't for posting.
const ActivityBatch = z.object({
  entries: z
    .array(
      z.object({
        at: z.string().max(40).optional(),
        agent: z.string().min(1).max(200),
        kind: z.enum(['read', 'note', 'fix', 'reply', 'ask', 'upload', 'render', 'error', 'wait', 'playbook', 'status', 'tool']),
        text: z.string().min(1).max(300),
        key: z.string().max(80).optional(),
        vars: z.record(z.string().max(20), z.union([z.string().max(200), z.number()])).optional(),
        quote: z.string().max(ERROR_MAX).optional(),
        target: z.string().max(80).nullish(),
        video: z.string().max(1000).nullish(),
        pct: z.number().min(0).max(100).optional(),
        progress: Progress.optional(),
        // the run Lampo started it for (LAMPO_RUN): a hint, bound only to the poster's own agent's run (server/runs.ts)
        run: z.string().regex(RUN_ID).optional(),
      }),
    )
    .max(20),
});
const RunId = z.string().regex(RUN_ID);
// A nudge without a request of its own (after answering the agent's question): what to tell it, optional.
const WakeBody = z.object({ text: z.string().max(2000).optional() });
/** The most of a run's log the UI gets (its end: that's where it says what it did). */
const LOG_TAIL = 256 * 1024;
const InboxQuery = z.object({ limit: z.coerce.number().int().min(1).max(5000).optional(), since: z.string().max(40).optional(), all: z.string().optional() });

/** How far back a posted activity line may say it happened (a batch that waited out a short loss of connection). */
const POSTED_WINDOW_MS = 5 * 60_000;
/** A posted line's time, held to the last POSTED_WINDOW_MS (now when it names none). */
function postedAt(at: string | undefined, now = Date.now()): string {
  const t = at ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(t) || t > now) return isoLocal(new Date(now));
  return t < now - POSTED_WINDOW_MS ? isoLocal(new Date(now - POSTED_WINDOW_MS)) : (at as string);
}

export function sessionRoutes(ctx: ServerContext): Router {
  const r = router();

  r.get('/api/sessions', async (req, res) => {
    const q = query(SessionsQuery, req);
    const list = await ctx.sessions.get({ fresh: q.fresh === '1' });
    const sessions = q.video ? rankSessions(list, q.video, store.listReviews()) : list.map((s) => ({ ...s, score: 0, reason: '' }));
    const out: SessionsResponse = { sessions: sessions.map((s) => agentView.session(req, s)), at: ctx.sessions.at, refreshing: ctx.sessions.refreshing };
    res.json(out);
  });

  r.put('/api/review/:slug/session', express.json(), (req, res) => {
    getReview(req.params.slug);
    const b = body(Assign, req);
    store.assignSession(
      req.params.slug,
      b.name ? { name: b.name, sessionId: b.sessionId || null, cwd: b.cwd || null, agent: b.agent || null } : null,
      ctx.actor(req, b.by),
    );
    ctx.broadcast('library', { slug: req.params.slug });
    ctx.broadcast('review', { slug: req.params.slug });
    res.json({ ok: true });
  });

  // `vr watch` says "I'm here" every 30 s; the session picker lists who is. It follows new notes as they come, so it
  // listens for as long as it is listed (only `vr watch` sends this: lib/backend/remote.ts watchEvents).
  r.post('/api/agents/heartbeat', express.json(), (req, res) => {
    const b = body(Heartbeat, req);
    ctx.agents.heartbeat(
      {
        session_id: b.session_id,
        name: b.name,
        cwd: b.cwd || null,
        host: b.host || null,
        // Whose agent it is, unless it runs on the machine itself (the machine owner's, like every local agent).
        user: req.auth?.via === 'local' ? null : req.auth?.user?.name || null,
        kind: b.kind ?? 'cli',
      },
      { listens: true },
    );
    res.json({ ok: true });
  });

  // What agents are doing, live (server/activity.ts): one video's agents with `slug` (plus `agent`, its assigned one,
  // even before it touched the video), else every agent's latest. Built from the calls Lampo serves; costs no tokens.
  // Only for those who see agents' details (`agents`): a run's steps name files in its folder.
  r.get('/api/agent-activity', (req, res) => {
    const q = query(ActivityQuery, req);
    const out: AgentActivityResponse = { agents: ctx.activity.live(q.slug ?? null, q.agent ? [q.agent.replace(/^agent:/, '')] : []) };
    res.json(out);
  });

  // An agent of a hosted server says what it did (its `vr` / stdio MCP batches it; no tokens of the agent's). What it
  // posts is its poster's (A12 AGENT-10): listed under `name · account` like an MCP connection, so one member can't put
  // words under another's agent, and at a time within the last few minutes (a batch waits ≤ 2 s; a line can't be
  // pinned to the future or slipped into the past).
  // The answer carries the lines its agent is told (the person stopped its work): its `vr` prints them, its stdio MCP
  // server adds them to its next answer.
  r.post('/api/agents/activity', express.json({ limit: '64kb' }), (req, res) => {
    const b = body(ActivityBatch, req);
    const account = req.auth?.via !== 'local' ? req.auth?.user?.name : null;
    const lines: string[] = [];
    for (const e of b.entries) {
      const agent = account ? ownedAgentName(e.agent, account) : e.agent;
      if (!agent) continue;
      const line = ctx.activity.record({ ...e, agent, at: postedAt(e.at), target: e.target ?? null, video: e.video ?? null, slug: null });
      if (line && lines.length < 2) lines.push(line);
    }
    res.json({ ok: true, ...(lines.length ? { lines } : {}) });
  });

  // Agents Lampo started on this machine for a request: what they're doing, Stop, and what they printed. Only the
  // machine itself sees them (they name folders on it).
  r.get('/api/agent-runs', (req, res) => {
    requireMachine(req, ctx);
    res.json({ runs: ctx.agentRuns.list(query(RunsQuery, req).slug) });
  });

  r.post('/api/agent-runs/:id/stop', (req, res) => {
    requireMachine(req, ctx);
    const id = RunId.safeParse(req.params.id);
    if (!id.success) throw fail(404, 'no such run');
    res.json({ run: ctx.agentRuns.stop(id.data, ctx.actor(req)) });
  });

  r.get('/api/agent-runs/:id/log', (req, res) => {
    requireMachine(req, ctx);
    const id = RunId.safeParse(req.params.id);
    const file = id.success ? ctx.agentRuns.logFile(id.data) : null;
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

  // Start the video's agent without a request of its own (it was asked something already, e.g. its question answered).
  r.post('/api/review/:slug/wake', express.json(), async (req, res) => {
    const review = getReview(req.params.slug);
    const text = (body(WakeBody, req).text || '').trim() || 'Your question was answered; read the answer and go on.';
    // checked first: a start that can't happen opens nothing
    checkWake(req, ctx, review);
    // the run it starts for: the agent's open one (an answer opened it), else a nudge's
    const opened = ctx.runs.fromPerson(req, req.params.slug, { how: 'nudge' });
    res.json({ run: await startAgent(req, ctx, req.params.slug, review, text, opened?.id) });
  });

  r.get('/api/agents', (req, res) => {
    res.json({ agents: ctx.agents.list().map((a) => agentView.agent(req, a)) });
  });

  // Newest human feedback across videos, as events (what `vr inbox` prints).
  r.get('/api/inbox', (req, res) => {
    const q = query(InboxQuery, req);
    let evs = store.readEvents({ limit: 5000 });
    if (!q.all) evs = evs.filter(isInboxEvent);
    if (q.since) evs = evs.filter((e) => new Date(e.at) > new Date(q.since as string));
    res.json({
      events: [...evs]
        .reverse()
        .slice(0, q.limit || 50)
        .map(ctx.eventFor(req.auth?.via)),
    });
  });

  // The machine itself reads INBOX.md as it is; anyone else (another device, a token, a hosted server) gets it with
  // screenshot URLs, never paths on this disk.
  r.get('/api/inbox.md', (req, res) => {
    if (ctx.hosted || req.auth?.via !== 'local') return void res.type('text/markdown').send(store.renderInbox(store.inboxEvents().map(ctx.publicEvent)));
    const file = store.inboxPath();
    res.type('text/markdown').send(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '_Nothing yet._\n');
  });

  return r;
}
