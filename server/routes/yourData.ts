// A person's own data, in their hands (A13 PEOPLE-1: GDPR Art. 15, 17 and 20): Settings → Profile exports it (a zip) and
// deletes the account; Settings → Workspace deletes the workspace (its owner, by typing its name). Every route here is
// a person's in the app, never an API token's (PERSON_ONLY), and says what goes before anything does (the plans).
//
//   GET  /api/auth/me/export              your data as a zip (lib/accountExport.ts)
//   GET  /api/auth/me/deletion            what deleting your account means: the workspaces that go with it, those you
//                                         leave, those you must hand over or delete first
//   POST /api/auth/me/delete              {password} | {confirm: true}: deleted — your password, or a sign-in in the
//                                         last 10 minutes and an explicit yes (never an empty body)
//   GET  /api/workspaces/current/deletion what deleting this workspace takes with it (its owner)
//   POST /api/workspaces/current/delete   {name}: deleted — its owner, its name typed as it is
import express, { type Request, type Router } from 'express';
import { z } from 'zod';
import { accountExport, exportZip } from '../../lib/accountExport.ts';
import * as auth from '../../lib/auth.ts';
import { deleteAccount, deleteWorkspace, planAccountDeletion, planWorkspaceDeletion } from '../../lib/deletion.ts';
import { RateLimit } from '../../lib/rateLimit.ts';
import * as workspaces from '../../lib/workspaces.ts';
import { type Auth, CLEAR_SITE_DATA, requireUser, sessionCookies } from '../auth.ts';
import type { ServerContext } from '../context.ts';
import { body, fail, failFrom, query, router, sendStreamed } from '../http.ts';

const Nothing = z.object({}).strict();
/** Your password, or — for a sign-in in the last minutes — `confirm: true`: never an empty body (a stray request). */
const DeleteMe = z.union([z.object({ password: z.string().min(1).max(1024) }).strict(), z.object({ confirm: z.literal(true) }).strict()]);
const DeleteWorkspace = z.object({ name: z.string().max(200) }).strict();

export function yourDataRoutes(ctx: ServerContext): Router {
  const r = router();
  const cookies = sessionCookies(ctx.cfg);
  // A zip of every workspace a person works in: a few an hour is plenty, and it reads each video's notes.
  const exports = new RateLimit(5, 3600_000);
  // Wrong passwords on the delete form count like sign-ins that failed (per account): it is a password check.
  const wrongPasswords = new RateLimit(5, 15 * 60_000);

  /** The person, signed in in the app (a cookie, or the machine itself): never an API token. */
  const person = (req: Request): Auth & { user: auth.User } => {
    const a = req.auth;
    if (!a?.user) throw fail(401, 'please sign in');
    if (a.via === 'token') throw fail(403, 'only a person signed in in the app can do this, not an API token', { person: true });
    return a as Auth & { user: auth.User };
  };
  const refused = (e: unknown) => (e instanceof workspaces.WorkspaceError ? failFrom(e.status, e) : e);

  r.get('/api/auth/me/export', requireUser, async (req, res) => {
    const a = person(req);
    query(Nothing, req);
    const wait = exports.retryAfter(a.user.id);
    if (wait) throw Object.assign(fail(429, `you exported your data a few times this hour: try again in ${Math.ceil(wait / 60)} min`), { retryAfter: wait });
    exports.hit(a.user.id);
    const plan = exportZip(await accountExport(a.user.id));
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', String(plan.length));
    res.setHeader('Content-Disposition', `attachment; filename="lampo-data-${day}.zip"`);
    await sendStreamed(req, res, () => plan.bytes(), 'export');
  });

  r.get('/api/auth/me/deletion', requireUser, (req, res) => {
    const a = person(req);
    query(Nothing, req);
    res.setHeader('Cache-Control', 'no-store');
    res.json(
      ctx.hosted ? planAccountDeletion(a.user.id) : { ...planAccountDeletion(a.user.id), refused: 'This is the machine’s own account: it can’t be deleted.' },
    );
  });

  r.post('/api/auth/me/delete', express.json(), requireUser, async (req, res) => {
    const a = person(req);
    const b = body(DeleteMe, req);
    if (!ctx.hosted || a.via !== 'cookie') throw fail(409, 'This is the machine’s own account: it can’t be deleted.');
    const me = a.user;
    // Your password — or, for an account without one, a sign-in in the last minutes: someone at an unlocked browser
    // mustn't delete a person's work with a click.
    if ('password' in b) {
      const wait = wrongPasswords.retryAfter(me.id);
      if (wait) throw Object.assign(fail(429, `too many wrong passwords, try again in ${Math.ceil(wait / 60)} min`), { retryAfter: wait });
      if (!me.password || !(await auth.verifyPassword(b.password, me.password))) {
        wrongPasswords.hit(me.id);
        throw fail(403, 'that’s not your password', { password: true });
      }
    } else if (!(a.signedIn && Date.now() - a.signedIn < auth.RECENT_SIGN_IN_MS))
      throw fail(403, me.password ? 'type your password to delete your account' : 'sign in again to delete your account', { password: !!me.password });
    let plan: Awaited<ReturnType<typeof deleteAccount>>;
    try {
      plan = await deleteAccount(me.id, 'self');
    } catch (e) {
      throw refused(e);
    }
    console.log(`account: ${me.id} deleted itself (${plan.goWith.length} workspaces with it, ${plan.leave.length} left)`);
    ctx.accountMail.deleted(me);
    cookies.clear(req, res);
    res.setHeader('Clear-Site-Data', CLEAR_SITE_DATA);
    res.json({ deleted: true, workspaces: plan.goWith.length });
  });

  /** The current workspace, when the caller owns it (the route's own check: the table lets owners and admins in). */
  const owned = (req: Request) => {
    const a = person(req);
    if (!ctx.hosted || !workspaces.workspacesEnabled()) throw fail(409, 'workspaces are for a hosted server');
    if (a.role !== 'owner') throw fail(403, 'only an owner can delete the workspace');
    const w = workspaces.getWorkspace(a.workspace);
    if (!w) throw fail(404, 'no such workspace');
    return { a, w };
  };

  r.get('/api/workspaces/current/deletion', requireUser, (req, res) => {
    const { w } = owned(req);
    query(Nothing, req);
    res.setHeader('Cache-Control', 'no-store');
    res.json(planWorkspaceDeletion(w.id));
  });

  r.post('/api/workspaces/current/delete', express.json(), requireUser, async (req, res) => {
    const { a, w } = owned(req);
    const { name } = body(DeleteWorkspace, req);
    if (name.trim() !== w.name.trim()) throw fail(400, 'type the workspace’s name exactly as it is shown to delete it', { name: true });
    let done: Awaited<ReturnType<typeof deleteWorkspace>>;
    try {
      done = await deleteWorkspace(w.id, 'owner');
    } catch (e) {
      throw refused(e);
    }
    console.log(`workspace: ${a.user.id} deleted workspace ${w.id} they owned`);
    // everyone in it hears, the owner too (an owner whose account went with it gets that one message)
    ctx.accountMail.workspaceDeleted(w.name, 'owner', done.people, a.user.id);
    const gone = !auth.getUser(a.user.id);
    if (gone) {
      cookies.clear(req, res);
      res.setHeader('Clear-Site-Data', CLEAR_SITE_DATA);
    }
    res.json({ deleted: true, account: gone });
  });

  return r;
}
