// Workspaces as a person meets them (lib/workspaces.ts): the ones they belong to, making one, switching the session
// to another, naming the current one. A hosted server only; the app on a person's own machine is one workspace.
// Members and invites of the current workspace are Settings → Users (server/auth.ts, scoped to the workspace).
import express, { type Request, type Router } from 'express';
import { z } from 'zod';
import * as auth from '../../lib/auth.ts';
import { isOperator } from '../../lib/operator.ts';
import { RateLimit } from '../../lib/rateLimit.ts';
import { PERSONAS } from '../../lib/setupFlow.ts';
import type { BadgeSetting, Persona, WorkspacesResponse } from '../../lib/types.ts';
import * as workspaces from '../../lib/workspaces.ts';
import { type Auth, requireUser, sessionCookie, sessionOf, shownWorkspaces } from '../auth.ts';
import type { ServerContext } from '../context.ts';
import { body, fail, failFrom, router } from '../http.ts';

const Name = z.object({ name: z.string().max(200) }).strict();
const Switch = z.object({ id: z.string().max(40) }).strict();
const Badge = z.object({ hidden: z.boolean() }).strict();
// Who the videos are for: several picks, each once; "Something else" in a few words (lib/workspaces.ts setPersonas).
const Personas = z
  .object({
    personas: z
      .array(z.enum(PERSONAS as [Persona, ...Persona[]]))
      .max(PERSONAS.length)
      .refine((xs) => new Set(xs).size === xs.length, 'each pick once'),
    personaOther: z.string().max(workspaces.PERSONA_OTHER_MAX).optional(),
  })
  .strict();

export function workspaceRoutes(ctx: ServerContext): Router {
  const r = router();
  // A person makes a handful of workspaces, not hundreds: each is folders on the server.
  const creations = new RateLimit(10, 24 * 3600_000);
  const enabled = () => ctx.hosted && workspaces.workspacesEnabled();
  /** Who runs the server (lib/operator.ts), the most workspaces an account may have made, whether it may make one: one
   * rule for this route and the account menu (lib/workspaces.ts, /api/auth/status). */
  const operator = (userId: string) => isOperator(ctx.cfg, userId);
  const limitOf = (userId: string): number | undefined => workspaces.createLimitOf(userId, ctx.cfg);
  const mayCreate = (userId: string) => enabled() && workspaces.mayCreateWorkspace(userId, ctx.cfg);
  const secure = (req: Request) => req.secure || !!ctx.cfg.public_url?.startsWith('https:');

  /** Only a person signed in in the browser: a token acts in its one workspace, the machine has only #1. */
  const session = (req: Request): Auth & { user: auth.User } => {
    const a = req.auth;
    if (!a?.user) throw fail(401, 'please sign in');
    if (a.via !== 'cookie') throw fail(403, a.via === 'token' ? 'an API token works in its own workspace: switch in the app' : 'this app has one workspace');
    return a as Auth & { user: auth.User };
  };

  /** The session cookie again, now working in `ws` (same session, same end). */
  const moveSession = (req: Request, res: express.Response, ws: string) => {
    const now = auth.switchSession(sessionOf(req) || '', ws);
    if (!now) throw fail(401, 'please sign in');
    res.append('Set-Cookie', sessionCookie(now.value, now.maxAge, secure(req)));
  };

  r.get('/api/workspaces', requireUser, (req, res) => {
    const a = req.auth as Auth;
    const out: WorkspacesResponse = {
      workspaces: shownWorkspaces(a),
      enabled: enabled(),
      create: !!a.user && a.via === 'cookie' && mayCreate(a.user.id),
    };
    res.json(out);
  });

  // A new workspace, its owner the person asking; the session moves into it.
  r.post('/api/workspaces', express.json(), requireUser, (req, res) => {
    const a = session(req);
    if (!enabled()) throw fail(409, 'workspaces are for a hosted server');
    if (ctx.cfg.workspace_create !== 'anyone' && !operator(a.user.id)) throw fail(403, 'on this server only whoever runs it makes new workspaces');
    const wait = creations.retryAfter(a.user.id);
    if (wait) throw Object.assign(fail(429, `too many new workspaces today, try again in ${Math.ceil(wait / 3600)} h`), { retryAfter: wait });
    const { name } = body(Name, req);
    let made: ReturnType<typeof workspaces.createWorkspace>;
    try {
      made = workspaces.createWorkspace({ name, ownerId: a.user.id, limit: limitOf(a.user.id) });
    } catch (e) {
      throw fail(e instanceof workspaces.WorkspaceError ? e.status : 400, (e as Error).message);
    }
    creations.hit(a.user.id);
    moveSession(req, res, made.id);
    res.json({ workspace: workspaces.myWorkspaces(a.user.id, made.id).find((w) => w.current) });
  });

  // The session works in another of the person's workspaces from now on (every tab of this browser).
  r.post('/api/workspaces/switch', express.json(), requireUser, (req, res) => {
    const a = session(req);
    const { id } = body(Switch, req);
    // Not a member (or no such workspace): the same answer, so ids can't be probed.
    if (!workspaces.WORKSPACE_ID.test(id) || !workspaces.roleIn(id, a.user.id)) throw fail(404, 'no such workspace');
    moveSession(req, res, id);
    res.json({ workspace: workspaces.myWorkspaces(a.user.id, id).find((w) => w.current) });
  });

  // Naming the workspace one works in (owners and admins: the permission table).
  r.patch('/api/workspaces/current', express.json(), requireUser, (req, res) => {
    const a = req.auth as Auth;
    if (!a.user) throw fail(401, 'please sign in');
    // the app on a person's own machine stays one workspace: a rename would move its store to workspaces.json
    if (!enabled()) throw fail(409, 'workspaces are for a hosted server');
    const { name } = body(Name, req);
    try {
      workspaces.renameWorkspace(a.workspace, name);
    } catch (e) {
      throw fail(e instanceof workspaces.WorkspaceError ? e.status : 400, (e as Error).message);
    }
    res.json({ workspace: workspaces.myWorkspaces(a.user.id, a.workspace).find((w) => w.current) });
  });

  // Who the workspace's videos are for (the setup's "Who are the videos for?"): its words, Get started's order and the
  // role an invite starts with follow (lib/onboarding.ts). Owners and admins (the permission table), people only.
  r.put('/api/workspaces/current/persona', express.json(), requireUser, (req, res) => {
    const a = req.auth as Auth;
    if (!a.user) throw fail(401, 'please sign in');
    // the app on a person's own machine stays one workspace without workspaces.json (as with a rename)
    if (!enabled()) throw fail(409, 'workspaces are for a hosted server');
    const { personas, personaOther } = body(Personas, req);
    try {
      workspaces.setPersonas(a.workspace, personas, personaOther);
    } catch (e) {
      throw failFrom(e instanceof workspaces.WorkspaceError ? e.status : 400, e);
    }
    res.json({ workspace: workspaces.myWorkspaces(a.user.id, a.workspace).find((w) => w.current) });
  });

  // "Powered by Lampo" on the workspace's review links (A13 CLOUD-7): on by default on every plan; on a plan that may
  // hide it (the billing provider says: a paid one), its owners and admins may (the permission table, people only).
  const badgeSetting = async (ws: string): Promise<BadgeSetting> => {
    const hidden = workspaces.badgeHidden(ws);
    const may = await ctx.extension.badgeOptional(ws);
    return { shown: !(hidden && may), hidden, may };
  };
  r.get('/api/workspaces/current/badge', requireUser, async (req, res) => {
    res.json(await badgeSetting((req.auth as Auth).workspace));
  });
  r.put('/api/workspaces/current/badge', express.json(), requireUser, async (req, res) => {
    const a = req.auth as Auth;
    if (!a.user) throw fail(401, 'please sign in');
    if (!enabled()) throw fail(409, 'workspaces are for a hosted server');
    const { hidden } = body(Badge, req);
    // showing it again is always allowed; hiding it is a paid plan's
    if (hidden && !(await ctx.extension.badgeOptional(a.workspace))) throw fail(402, 'Hiding the Lampo badge comes with a paid plan.');
    try {
      workspaces.setBadgeHidden(a.workspace, hidden);
    } catch (e) {
      throw failFrom(e instanceof workspaces.WorkspaceError ? e.status : 400, e);
    }
    res.json(await badgeSetting(a.workspace));
  });

  return r;
}
