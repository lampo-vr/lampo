// Starting the assigned agent for a request, from this machine only: the checks every route that can start one runs
// first. On a hosted server, over the LAN link, with an API token or an MCP client nothing is ever started.
import path from 'node:path';
import type { Request } from 'express';
import { wakeBlocker, wakePrompt } from '../lib/agentRun.ts';
import { matchesSession } from '../lib/sessions.ts';
import type { AgentRunInfo, Review } from '../lib/types.ts';
import type { ServerContext } from './context.ts';
import { fail } from './http.ts';

/** Throws unless this request comes from the machine itself (the loopback owner) on an app that can start agents. */
export function requireMachine(req: Request, ctx: ServerContext): void {
  if (ctx.hosted || !ctx.capabilities.wakeAgents) throw fail(403, 'agents are started only by the app on your own machine');
  if (req.auth?.via !== 'local') throw fail(403, 'starting an agent needs this machine itself, not a token, the LAN link or another browser');
}

/** Throws unless the video's agent can be started from here (the machine, and a Claude Code session with an id and folder). */
export function checkWake(req: Request, ctx: ServerContext, review: Review): void {
  requireMachine(req, ctx);
  const why = wakeBlocker(review.session);
  if (why) throw fail(409, why);
}

/**
 * Starts the video's assigned Claude Code session with `text` as the request, unless it is running already (then it
 * gets the request the usual way and nothing is started: `null`).
 */
export async function startAgent(req: Request, ctx: ServerContext, slug: string, review: Review, text: string): Promise<AgentRunInfo | null> {
  checkWake(req, ctx, review);
  const session = review.session;
  if (!session?.id || !session.cwd) throw fail(409, 'this agent can’t be started from Lampo');
  if ((await ctx.sessions.get()).some((s) => matchesSession(session, s))) return null;
  const who = ctx.actor(req);
  const prompt = wakePrompt({ who, video: path.basename(review.video), slug, v: review.versions.at(-1)?.v, text });
  return ctx.agentRuns.start({ slug, name: session.name, sessionId: session.id, cwd: session.cwd, by: who, prompt });
}
