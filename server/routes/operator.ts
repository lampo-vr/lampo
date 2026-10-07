// The operator's pages of a hosted server (web/src/operator/): the conversion funnel from first-party counts
// (lib/funnel.ts), every workspace with its plan (set by hand through a billing module), and every account (disabled and
// enabled again). For the people who run the server only (lib/operator.ts: LAMPO_OPERATOR, else the owners of its first
// workspace), signed in as themselves (PERSON_ONLY). Anyone else — an admin or member, the owner of any other workspace
// (every open sign-up has one), the app on a person's own machine — is answered as if there were no such page, before
// anything they sent is read: no answer here tells them whether a workspace or an account exists.
//
// The operator reads across workspaces on purpose: these routes go to the registry (lib/workspaces.ts) for every
// workspace and to lib/auth.ts for every account, and to each workspace's own store only for what it counts (usage, its
// log's newest event) — never a note, a video, a link or a token. Nothing here signs in as anyone; disabling an account
// ends its access through updateUser → accessEnded() (test/unit/access-ends.test.ts).
//
// The takedown (A13 CLOUD-5): a workspace suspended — read-only for its people, its review links stopped, its people
// told — and lifted again; a workspace deleted with everything it holds (lib/deletion.ts), confirmed by typing its name.
// Never the server's own workspace. Each says in the server's log what and by whom; the reason stays on the page.
import express, { type Request, type Router } from 'express';
import { z } from 'zod';
import * as auth from '../../lib/auth.ts';
import { deleteWorkspace, planWorkspaceDeletion } from '../../lib/deletion.ts';
import { FunnelUnreadableError, funnelReport } from '../../lib/funnel.ts';
import { isOperator } from '../../lib/operator.ts';
import { WORKSPACE_ID } from '../../lib/paths.ts';
import { inWorkspace } from '../../lib/scope.ts';
import * as store from '../../lib/store.ts';
import { compareTime } from '../../lib/time.ts';
import type {
  OperatorAccount,
  OperatorAccounts,
  OperatorMember,
  OperatorPerson,
  OperatorPlan,
  OperatorWorkspace,
  OperatorWorkspaceDetail,
  OperatorWorkspaces,
  PlanChange,
  PlanLogEntry,
  Role,
  StoredWorkspace,
} from '../../lib/types.ts';
import * as workspaces from '../../lib/workspaces.ts';
import type { ServerContext } from '../context.ts';
import { type Usage, usageOf } from '../extension.ts';
import { body, fail, failFrom, parse, query, router } from '../http.ts';

const Weeks = z.object({ weeks: z.enum(['4', '8', '12']).default('8') }).strict();
const WorkspaceParam = z.object({ id: z.string().regex(WORKSPACE_ID) }).strict();
const AccountParam = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }).strict();
/** Why, in one short line: it goes into the workspace's log and is shown on its page. */
const Reason = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^[^\r\n\u2028\u2029]*$/, 'one line');
const PlanBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('complimentary'), plan: z.enum(['solo', 'team', 'business']), reason: Reason }).strict(),
  // the last day of the trial (UTC): it runs to that day's end
  z.object({ kind: z.literal('trial'), until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason: Reason }).strict(),
  z.object({ kind: z.literal('normal'), reason: Reason }).strict(),
]);
const Nothing = z.object({}).strict();
const SuspendBody = z.object({ reason: Reason }).strict();
/** The workspace's name, typed as the page shows it: what confirms the deletion (compared trimmed, exactly). */
const DeleteBody = z.object({ name: z.string().max(200), reason: Reason }).strict();

/** A module's answer about a plan, checked before the page shows it (a module's mistake is a missing plan, not a crash). */
const Stamp = z.object({ account: z.string().max(64), name: z.string().max(120), email: z.string().max(254).optional() });
const OverrideShape = z.union([
  z.object({ kind: z.literal('complimentary'), plan: z.enum(['solo', 'team', 'business']) }),
  z.object({ kind: z.literal('trial'), until: z.string().max(40) }),
]);
const PlanShape = z.object({
  plan: z.string().max(40),
  name: z.string().max(60),
  state: z.enum(['active', 'trial', 'grace', 'read-only', 'complimentary']),
  reason: z.enum(['payment', 'over-limit', 'trial-ended', 'canceled']).optional(),
  trialEndsAt: z.string().max(40).optional(),
  graceUntil: z.string().max(40).optional(),
  storage: z.number().nonnegative().nullable(),
  override: z.intersection(OverrideShape, z.object({ at: z.string().max(40), by: Stamp, reason: z.string().max(300) })).optional(),
  fixed: z.enum(['own', 'env']).optional(),
  paying: z.boolean().optional(),
});
const LogShape = z.object({
  at: z.string().max(40),
  by: Stamp,
  change: z.union([OverrideShape, z.object({ kind: z.literal('normal') })]),
  reason: z.string().max(300),
});
/** The most log lines a workspace's page shows. */
const LOG_SHOWN = 100;

/** The server's operator (lib/operator.ts), in person, on a hosted server; anyone else 404 (401 signed out). */
export function operatorOf(ctx: Pick<ServerContext, 'hosted' | 'cfg'>, req: Request) {
  const a = req.auth;
  if (!a?.user) throw fail(401, 'please sign in');
  if (!ctx.hosted || a.via !== 'cookie' || !isOperator(ctx.cfg, a.user.id)) throw fail(404, 'not found');
  return a.user;
}

const ROLE_ORDER: Record<Role, number> = { owner: 0, admin: 1, member: 2, reviewer: 3 };
const person = (u: auth.User): OperatorPerson => ({ id: u.id, name: u.name, email: u.email });

/**
 * Nothing recorded of an account made after the server began to keep when each was last active: it never signed in.
 * One made before may have, unrecorded (its page says so).
 */
function neverSignedIn(u: auth.User): boolean {
  const since = auth.seenSince();
  return !u.seen && !u.signed_in && !!since && compareTime(u.created, since) >= 0;
}

/** A workspace's first owner who can still act (not disabled there or everywhere). */
function ownerOf(w: StoredWorkspace): OperatorPerson | null {
  for (const m of w.members) {
    if (m.role !== 'owner' || m.suspended) continue;
    const u = auth.getUser(m.user);
    if (u && !u.disabled) return person(u);
  }
  return null;
}

/** When anything last happened in a workspace: its log's newest event (the first run's sample logs none). */
function lastActivity(ws: string): string | null {
  const last = inWorkspace(ws, () => store.readEvents({ limit: 1, tailBytes: 64 * 1024 })).at(-1);
  return last && Number.isFinite(Date.parse(last.at)) ? last.at : null;
}

/** A workspace as the list shows it, with what was counted for its plan. */
function rowOf(w: StoredWorkspace): { row: OperatorWorkspace; usage: Usage } {
  const usage = usageOf(w.id);
  const s = w.suspended;
  return {
    row: {
      id: w.id,
      name: w.name,
      created: w.created,
      owner: ownerOf(w),
      members: w.members.length,
      videos: usage.activeVideos + usage.room.videos,
      bytes: usage.bytes,
      active: lastActivity(w.id),
      // who suspended it: their name now (an operator who has gone since: the id they had)
      ...(s ? { suspended: { at: s.at, by: auth.getUser(s.by)?.name ?? s.by, reason: s.reason } } : {}),
    },
    usage,
  };
}

export function operatorRoutes(ctx: ServerContext): Router {
  const r = router();

  /** Each row's plan from the module, checked; none when there is no module or it failed (logged). */
  const withPlans = async (rows: { row: OperatorWorkspace; usage: Usage }[]): Promise<OperatorWorkspace[]> => {
    const plans = ctx.extension.operator;
    if (!plans) return rows.map((x) => x.row);
    let answer: Record<string, unknown> = {};
    try {
      answer = (await plans.plans(rows.map((x) => ({ workspace: x.row.id, usage: x.usage })))) ?? {};
    } catch (e) {
      console.error(`operator: the billing module’s plans failed (${(e as Error)?.message})`);
    }
    return rows.map(({ row }) => {
      const p = PlanShape.safeParse(answer[row.id]);
      return p.success ? { ...row, plan: p.data as OperatorPlan } : row;
    });
  };

  const detailOf = async (w: StoredWorkspace): Promise<OperatorWorkspaceDetail> => {
    const [workspace] = await withPlans([rowOf(w)]);
    const members: OperatorMember[] = [];
    for (const m of w.members) {
      const u = auth.getUser(m.user);
      if (!u) continue;
      members.push({
        ...person(u),
        role: m.role,
        since: m.since,
        ...(m.suspended ? { suspended: m.suspended } : {}),
        ...(u.disabled ? { disabled: u.disabled } : {}),
      });
    }
    members.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name));
    let log: PlanLogEntry[] = [];
    if (ctx.extension.operator)
      try {
        const got = await ctx.extension.operator.log(w.id);
        log = (Array.isArray(got) ? got : [])
          .slice(0, LOG_SHOWN)
          .map((x) => LogShape.safeParse(x))
          .filter((x) => x.success)
          .map((x) => x.data as PlanLogEntry);
      } catch (e) {
        console.error(`operator: the billing module’s log failed (${(e as Error)?.message})`);
      }
    return { plans: !!ctx.extension.operator, workspace: workspace as OperatorWorkspace, members, log };
  };

  const accountOf = (u: auth.User, me: string): OperatorAccount => ({
    ...person(u),
    created: u.created,
    signedIn: u.signed_in ?? null,
    lastActive: auth.lastActive(u),
    ...(neverSignedIn(u) ? { neverSignedIn: true } : {}),
    disabled: u.disabled ?? null,
    ...(u.unverified ? { unverified: true } : {}),
    workspaces: workspaces.workspacesOf(u.id, { suspended: true }).map(({ workspace, role }) => {
      const suspended = workspace.members.find((m) => m.user === u.id)?.suspended;
      return { id: workspace.id, name: workspace.name, role, ...(suspended ? { suspended } : {}) };
    }),
    ...(isOperator(ctx.cfg, u.id) ? { operator: true } : {}),
    ...(u.id === me ? { you: true } : {}),
  });

  r.get('/api/operator/funnel', (req, res) => {
    operatorOf(ctx, req);
    const { weeks } = query(Weeks, req);
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(funnelReport(Number(weeks)));
    } catch (e) {
      if (e instanceof FunnelUnreadableError) throw fail(503, e.publicText);
      throw e;
    }
  });

  r.get('/api/operator/workspaces', async (req, res) => {
    operatorOf(ctx, req);
    query(Nothing, req);
    const list = await withPlans(workspaces.listWorkspaces().map(rowOf));
    const out: OperatorWorkspaces = { plans: !!ctx.extension.operator, workspaces: list };
    res.setHeader('Cache-Control', 'no-store');
    res.json(out);
  });

  r.get('/api/operator/workspaces/:id', async (req, res) => {
    operatorOf(ctx, req);
    const { id } = parse(WorkspaceParam, req.params, 'workspace');
    const w = workspaces.getWorkspace(id);
    if (!w) throw fail(404, 'no such workspace');
    res.setHeader('Cache-Control', 'no-store');
    res.json(await detailOf(w));
  });

  r.post('/api/operator/workspaces/:id/plan', express.json(), async (req, res) => {
    const me = operatorOf(ctx, req);
    const { id } = parse(WorkspaceParam, req.params, 'workspace');
    const b = body(PlanBody, req);
    const plans = ctx.extension.operator;
    if (!plans) throw fail(409, 'no billing module runs on this server: there are no plans to set');
    const w = workspaces.getWorkspace(id);
    if (!w) throw fail(404, 'no such workspace');
    let change: PlanChange;
    if (b.kind === 'trial') {
      const until = `${b.until}T23:59:59.999Z`;
      if (new Date(until).toISOString().slice(0, 10) !== b.until) throw fail(400, 'invalid body: until: not a day of the calendar');
      change = { kind: 'trial', until };
    } else change = b.kind === 'complimentary' ? { kind: 'complimentary', plan: b.plan } : { kind: 'normal' };
    const done = await plans.set(id, change, { account: me.id, name: me.name, ...(me.email ? { email: me.email } : {}) }, b.reason);
    if (!done.ok) throw fail(409, done.message, { reason: done.reason });
    // the reason stays in the module's log (it may name a person); the server's log says what and by whom
    console.log(
      `operator: ${me.id} set ${id} to ${change.kind}${change.kind === 'complimentary' ? ` (${change.plan})` : change.kind === 'trial' ? ` until ${change.until.slice(0, 10)}` : ''}`,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json(await detailOf(workspaces.getWorkspace(id) ?? w));
  });

  // ---------------------------------------------------------------- the takedown

  /** A workspace by its id in the path, or 404 (what the operator may act on: any but the one the registry lacks). */
  const workspaceOf = (req: Request): StoredWorkspace => {
    const { id } = parse(WorkspaceParam, req.params, 'workspace');
    const w = workspaces.getWorkspace(id);
    if (!w) throw fail(404, 'no such workspace');
    return w;
  };
  const refusedBy = (e: unknown) => {
    if (e instanceof workspaces.WorkspaceError) return failFrom(e.status, e);
    return e;
  };

  // What deleting it would take with it, counted: the page says it before anyone types the name.
  r.get('/api/operator/workspaces/:id/deletion', (req, res) => {
    operatorOf(ctx, req);
    query(Nothing, req);
    const w = workspaceOf(req);
    res.setHeader('Cache-Control', 'no-store');
    res.json(planWorkspaceDeletion(w.id));
  });

  // Suspended: read-only for its people (server/permissions.ts), its review links answer 410 (server/workspace.ts), its
  // agents write nothing (MCP), its posts wait; its people are told by email and see a banner. Lifted: all as before.
  for (const [path, on] of [
    ['/api/operator/workspaces/:id/suspend', true],
    ['/api/operator/workspaces/:id/unsuspend', false],
  ] as const)
    r.post(path, express.json(), async (req, res) => {
      const me = operatorOf(ctx, req);
      const w = workspaceOf(req);
      let reason = '';
      if (on) reason = body(SuspendBody, req).reason;
      else body(Nothing, req);
      let changed = false;
      try {
        changed = workspaces.suspendWorkspace(w.id, on ? { by: me.id, reason } : null);
      } catch (e) {
        throw refusedBy(e);
      }
      if (changed) {
        console.log(`operator: ${me.id} ${on ? 'suspended' : 'lifted the suspension of'} workspace ${w.id}`);
        ctx.accountMail.workspaceSuspended(w.id, on);
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json(await detailOf(workspaces.getWorkspace(w.id) ?? w));
    });

  // Deleted, with everything it holds (lib/deletion.ts): only once its name is typed as it is. Its people are told.
  r.post('/api/operator/workspaces/:id/delete', express.json(), async (req, res) => {
    const me = operatorOf(ctx, req);
    const w = workspaceOf(req);
    const b = body(DeleteBody, req);
    if (b.name.trim() !== w.name.trim()) throw fail(400, 'type the workspace’s name exactly as it is shown to delete it', { name: true });
    let done: Awaited<ReturnType<typeof deleteWorkspace>>;
    try {
      done = await deleteWorkspace(w.id, 'operator');
    } catch (e) {
      throw refusedBy(e);
    }
    console.log(`operator: ${me.id} deleted workspace ${w.id} (${done.people.filter((p) => p.accountGone).length} accounts went with it)`);
    ctx.accountMail.workspaceDeleted(w.name, 'operator', done.people);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ deleted: { id: w.id, name: w.name }, plan: done.plan, accountsGone: done.people.filter((p) => p.accountGone).length });
  });

  r.get('/api/operator/accounts', (req, res) => {
    const me = operatorOf(ctx, req);
    query(Nothing, req);
    const out: OperatorAccounts = { accounts: auth.listUsers().map((u) => accountOf(u, me.id)) };
    res.setHeader('Cache-Control', 'no-store');
    res.json(out);
  });

  r.get('/api/operator/accounts/:id', (req, res) => {
    const me = operatorOf(ctx, req);
    const { id } = parse(AccountParam, req.params, 'account');
    const u = auth.getUser(id);
    if (!u) throw fail(404, 'no such account');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ account: accountOf(u, me.id) });
  });

  // Disabling ends every way in at once (sessions, API tokens, apps, open agent streams, upload links: updateUser bumps
  // the account's epoch and calls accessEnded()); the account, its notes and its memberships stay. Enabling lets it sign
  // in again (sessions signed out stay signed out). Never your own account: the operator would lock themselves out.
  for (const [path, disabled] of [
    ['/api/operator/accounts/:id/disable', true],
    ['/api/operator/accounts/:id/enable', false],
  ] as const)
    r.post(path, express.json(), async (req, res) => {
      const me = operatorOf(ctx, req);
      const { id } = parse(AccountParam, req.params, 'account');
      body(Nothing, req);
      const u = auth.getUser(id);
      if (!u) throw fail(404, 'no such account');
      if (disabled && u.id === me.id) throw fail(409, 'you can’t disable your own account');
      if (!!u.disabled !== disabled) {
        await auth.updateUser(id, { disabled }, { memberships: true });
        console.log(`operator: ${me.id} ${disabled ? 'disabled' : 'enabled'} account ${id}`);
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({ account: accountOf(auth.getUser(id) as auth.User, me.id) });
    });

  return r;
}
