// Every API route mapped to the action it needs (lib/permissions.ts says which roles have which action). One
// middleware checks it before any route runs, so a route can't forget; test/unit/permissions.test.ts fails when a
// writing route is missing from the table. Rules that depend on the content (whose note, which status) stay in the
// route and use the same actions.
import type { NextFunction, Request, Response } from 'express';
import { isGated } from '../lib/auth.ts';
import { type Action, can } from '../lib/permissions.ts';
import type { Role } from '../lib/types.ts';
import { suspensionOf } from '../lib/workspaces.ts';
import { GUEST_PATH } from './guard.ts';
import { fail } from './http.ts';

/**
 * `self`: needs a signed-in user but no particular action (your own profile, tokens, sign-out, OAuth consent).
 * `public`: authenticates itself (the OAuth endpoints check client, code and PKCE; they never use the session).
 */
type Rule = Action | 'self' | 'public';

// [method, path pattern (":name" = one segment, "*" = the rest), what it needs]. First match wins.
export const ROUTE_ACTIONS: [string, string, Rule][] = [
  ['*', '/api/auth/*', 'self'],
  ['*', '/api/admin/*', 'admin'],
  // OAuth for MCP clients: consenting is your own business; token, registration and revocation authenticate the client.
  ['*', '/api/oauth/*', 'self'],
  ['*', '/oauth/*', 'public'],
  // oEmbed for Embed links (server/routes/shares/embed.ts): the address it is asked about is its only key, like the
  // link's own pages; it answers signed in or not, and never for any other link.
  ['GET', '/oembed', 'public'],
  // Workspaces: yours to list, make and switch between; naming the one you work in is an admin's.
  ['GET', '/api/workspaces', 'self'],
  ['POST', '/api/workspaces', 'self'],
  ['POST', '/api/workspaces/switch', 'self'],
  ['PATCH', '/api/workspaces/current', 'admin'],
  // Who the workspace's videos are for (the setup): its owners' and admins' to say, like its name.
  ['PUT', '/api/workspaces/current/persona', 'admin'],
  // "Powered by Lampo" on the workspace's review links: anyone in it may see whether it shows (the link-opened moment
  // says so), its owners and admins hide it on a paid plan (A13 CLOUD-7).
  ['GET', '/api/workspaces/current/badge', 'view'],
  ['PUT', '/api/workspaces/current/badge', 'admin'],
  // Deleting the workspace one works in, with everything it holds (server/routes/yourData.ts): the route lets its owners
  // only. Your own account's export and deletion are `/api/auth/*`, yours (`self`).
  ['GET', '/api/workspaces/current/deletion', 'admin'],
  ['POST', '/api/workspaces/current/delete', 'admin'],
  // The server's health check and its test mail (the server's setup): the route answers whoever runs the server
  // (lib/operator.ts) — never a role in a workspace as such — and on a person's own machine its owner
  // (server/routes/serverHealth.ts).
  ['GET', '/api/server/health', 'self'],
  ['POST', '/api/server/mail-test', 'self'],
  // Conversion moments (server/routes/moments.ts): a person's own — what they put away (kept with the account), what
  // waits for them, what a moment did (counted per week, never who). The operator's pages (server/routes/operator.ts):
  // the funnel, every workspace and its plan, every account. The routes themselves answer only the server's operator
  // (lib/operator.ts: LAMPO_OPERATOR, else the owners of its first workspace), everyone else as if there were no page:
  // they read across workspaces on purpose, so no role of any one workspace is what lets anyone in.
  ['GET', '/api/moments', 'self'],
  ['PUT', '/api/moments/:id', 'self'],
  ['POST', '/api/moments/:id/seen', 'self'],
  ['POST', '/api/moments/event', 'self'],
  ['GET', '/api/operator/funnel', 'self'],
  ['GET', '/api/operator/workspaces', 'self'],
  ['GET', '/api/operator/workspaces/:id', 'self'],
  ['POST', '/api/operator/workspaces/:id/plan', 'self'],
  // The takedown (A13 CLOUD-5): what a deletion would take, suspending and lifting it, deleting it.
  ['GET', '/api/operator/workspaces/:id/deletion', 'self'],
  ['POST', '/api/operator/workspaces/:id/suspend', 'self'],
  ['POST', '/api/operator/workspaces/:id/unsuspend', 'self'],
  ['POST', '/api/operator/workspaces/:id/delete', 'self'],
  ['GET', '/api/operator/accounts', 'self'],
  ['GET', '/api/operator/accounts/:id', 'self'],
  ['POST', '/api/operator/accounts/:id/disable', 'self'],
  ['POST', '/api/operator/accounts/:id/enable', 'self'],

  ['POST', '/api/review/:slug/comments', 'comment'],
  ['PATCH', '/api/comments/:id', 'comment'],
  ['DELETE', '/api/comments/:id', 'comment'],
  // A reply's words, changed or taken back by its author alone (the route checks whose it is; never a role's).
  ['PATCH', '/api/comments/:id/replies/:n', 'comment'],
  ['DELETE', '/api/comments/:id/replies/:n', 'comment'],
  ['POST', '/api/voice', 'comment'],
  // Recorded feedback: made, heard, edited and sent by the person who recorded it (the routes check whose it is).
  ['GET', '/api/review/:slug/recordings', 'comment'],
  ['POST', '/api/review/:slug/recordings', 'comment'],
  ['*', '/api/review/:slug/recordings/:id', 'comment'],
  ['*', '/api/review/:slug/recordings/:id/*', 'comment'],
  // Drafts: notes kept by their author until sent (lib/drafts.ts; the routes serve only your own, never to a token).
  ['GET', '/api/drafts', 'comment'],
  ['GET', '/api/review/:slug/drafts', 'comment'],
  ['POST', '/api/review/:slug/drafts', 'comment'],
  ['POST', '/api/review/:slug/drafts/send', 'comment'],
  ['*', '/api/review/:slug/drafts/:id', 'comment'],
  ['*', '/api/review/:slug/drafts/:id/*', 'comment'],
  ['POST', '/api/qa/:slug/accept', 'comment'],
  // Questions with options (server/routes/asks.ts): asked by anyone who may comment (agents above all), answered or
  // closed by whoever may answer questions (the route checks `verify`), deleted by who asked (or `edit-notes`).
  ['POST', '/api/asks', 'comment'],
  ['POST', '/api/asks/:id/answer', 'comment'],
  ['POST', '/api/asks/:id/close', 'comment'],
  ['DELETE', '/api/asks/:id', 'comment'],
  // A still or clip of a fix is the editor's side, like marking it fixed; where a render came from, the uploader's.
  ['POST', '/api/comments/:id/previews', 'resolve'],
  // References: to your own note, or with a reply (the route checks whose note it is and who added a reference).
  ['POST', '/api/comments/:id/refs', 'comment'],
  ['PATCH', '/api/comments/:id/refs/:ref', 'comment'],
  ['DELETE', '/api/comments/:id/refs/:ref', 'comment'],
  ['PUT', '/api/review/:slug/versions/:v/source', 'upload'],
  // Where each named element of a version is (an elements map): its renderer's agent sends it, like the render itself.
  ['PUT', '/api/review/:slug/versions/:v/elements', 'upload'],
  ['PUT', '/api/review/:slug/approval', 'approve'],
  ['POST', '/api/review/:slug/approval/carry', 'approve'],
  ['PUT', '/api/review/:slug/final', 'finalize'],
  ['DELETE', '/api/review/:slug/final', 'finalize'],

  // A one-time upload URL is its own credential (minted for someone who may upload).
  ['*', '/api/uploads/direct/:ticket', 'public'],
  ['*', '/api/uploads', 'upload'],
  ['*', '/api/uploads/*', 'upload'],
  ['POST', '/api/library', 'upload'],
  // Members may remove what they uploaded; the route checks whose it is.
  ['DELETE', '/api/library/:slug', 'upload'],
  ['POST', '/api/library/:slug/restore', 'upload'],

  ['POST', '/api/folders', 'organize'],
  ['PATCH', '/api/folders', 'organize'],
  ['DELETE', '/api/folders', 'organize'],
  ['POST', '/api/folders/auto', 'organize'],
  ['PUT', '/api/review/:slug/folder', 'organize'],
  ['PUT', '/api/review/:slug/session', 'organize'],
  ['POST', '/api/review/:slug/sync', 'organize'],
  ['GET', '/api/browse', 'organize'],

  ['GET', '/api/review/:slug/shares', 'share'],
  ['GET', '/api/shares', 'share'],
  ['POST', '/api/review/:slug/shares', 'share'],
  ['DELETE', '/api/shares/:token', 'share'],
  ['PATCH', '/api/shares/:token', 'share'],
  ['GET', '/api/shares/:token/qr', 'share'],
  ['GET', '/api/folder-shares', 'share'],
  ['POST', '/api/folder-shares', 'share'],
  // Taking the renders home — whole folders as a zip, or one version's own file — is more than watching: reviewers see
  // and comment, they don't take the renders home. One rule for both.
  ['GET', '/api/folders/download', 'download'],
  ['GET', '/api/folders/download/info', 'download'],
  ['GET', '/api/review/:slug/download', 'download'],
  ['GET', '/api/review/:slug/download/info', 'download'],
  // MCP: connecting needs 'view'; every tool then checks its own action against the same table (mcp/core.ts allowed()).
  ['*', '/mcp', 'view'],
  // Your own devices' notifications; "Got it" in For you only hides things for you.
  ['*', '/api/push', 'self'],
  ['*', '/api/push/*', 'self'],
  ['POST', '/api/for-you/dismiss', 'view'],
  ['POST', '/api/for-you/snooze', 'view'],
  ['POST', '/api/for-you/unsnooze', 'view'],
  // Watching reports what you watched (Insights, a video's viewers): anyone who may watch.
  ['POST', '/api/review/:slug/watch', 'view'],
  ['*', '/api/tunnel', 'share'],
  ['*', '/api/tunnel/*', 'share'],

  ['POST', '/api/review/:slug/request', 'agents'],
  // Starting an agent on this machine (the routes also require the machine itself: server/wake.ts).
  ['POST', '/api/review/:slug/wake', 'agents'],
  ['POST', '/api/agent-runs/:id/stop', 'agents'],
  ['GET', '/api/agent-runs', 'agents'],
  ['GET', '/api/agent-activity', 'agents'],
  ['POST', '/api/agents/activity', 'agents'],
  ['GET', '/api/agent-runs/:id/log', 'agents'],
  ['PUT', '/api/review/:slug/agent-status', 'agents'],
  ['POST', '/api/agents/heartbeat', 'agents'],

  // Playbooks: the team edits and decides on suggestions; anyone who may comment suggests (agents above all).
  ['PUT', '/api/playbook/text', 'playbook'],
  ['PUT', '/api/playbook/skill', 'playbook'],
  ['DELETE', '/api/playbook/skill', 'playbook'],
  ['POST', '/api/playbook/skill/files', 'playbook'],
  ['DELETE', '/api/playbook/skill/files', 'playbook'],
  ['POST', '/api/playbook/refs', 'playbook'],
  ['DELETE', '/api/playbook/refs', 'playbook'],
  ['POST', '/api/playbook/proposals', 'comment'],
  ['POST', '/api/playbook/proposals/:id/accept', 'playbook'],
  ['POST', '/api/playbook/proposals/:id/reject', 'playbook'],

  // The first run: putting it away and bringing it back is your own; the sample is a video like an upload (made and
  // removed by whoever may add videos; the route only ever removes the sample).
  ['PUT', '/api/onboarding', 'self'],
  ['POST', '/api/onboarding/sample', 'upload'],
  ['DELETE', '/api/onboarding/sample', 'upload'],

  // Publishing a final video (server/routes/publish.ts): drafts and the kit are the team's (agents draft too); the
  // connections — the keys and sign-ins — and publishing itself are owners' and admins', and people's only (PERSON_ONLY).
  ['GET', '/api/publish/connections', 'post'],
  ['POST', '/api/publish/connections', 'publish'],
  ['PATCH', '/api/publish/connections/:id', 'publish'],
  ['DELETE', '/api/publish/connections/:id', 'publish'],
  ['POST', '/api/publish/connections/:id/check', 'publish'],
  ['POST', '/api/publish/connections/:id/authorize', 'publish'],
  ['GET', '/api/publish/oauth/callback', 'publish'],
  ['POST', '/api/review/:slug/posts', 'post'],
  ['PATCH', '/api/posts/:id', 'post'],
  ['DELETE', '/api/posts/:id', 'post'],
  ['POST', '/api/posts/:id/publish', 'publish'],
  ['POST', '/api/posts/:id/cancel', 'publish'],
  ['POST', '/api/posts/:id/retry', 'publish'],
  ['POST', '/api/posts/:id/kit', 'post'],
  ['GET', '/api/posts/:id/kit', 'post'],
  ['GET', '/api/posts/:id/kit/:file', 'post'],

  ['POST', '/api/qa/:slug/:v/rerun', 'qa'],
  ['POST', '/api/review/:slug/transcript/rerun', 'qa'],
  ['POST', '/api/qa/:slug/dismiss', 'qa'],

  // Footage search (server/routes/footage.ts): searching and its contact sheets are reading (view, the default for a
  // GET); turning the workspace's index on or off is its owners' and admins' (it costs the server's CPU).
  ['GET', '/api/footage/find', 'view'],
  ['GET', '/api/footage/sheet', 'view'],
  ['GET', '/api/footage/status', 'view'],
  ['PUT', '/api/footage/settings', 'admin'],
];

/**
 * What only a person does, signed in in the app (a session, or the machine itself) — never with an API token (an
 * agent, a script, a leaked token): whatever makes or changes credentials, roles, members, invites, tokens and apps,
 * or opens a lasting way out — a review link too: it lets whoever holds it act as the client (a client's approval),
 * and sign-off is people's (A12 VE2b-1). A token that could would outlast itself: set its account's password and sign in, mint a
 * lasting token, make an account (or an invite) it controls, hand itself a role. `PATCH /api/auth/me` is the person's
 * for a password or an address (server/auth.ts checks the body). test/unit/route-walk.test.ts holds every entry to a
 * registered route and asks each with an owner's token.
 */
export const PERSON_ONLY: [string, string][] = [
  ['POST', '/api/auth/tokens'],
  // Letting an app or `vr login` in (the consent screen) makes a lasting way in — a connection, or an API token.
  ['GET', '/api/oauth/requests/:id'],
  ['POST', '/api/oauth/requests/:id'],
  ['POST', '/api/auth/logout-everywhere'],
  ['POST', '/api/admin/users'],
  ['PATCH', '/api/admin/users/:id'],
  ['DELETE', '/api/admin/users/:id'],
  ['POST', '/api/admin/invites'],
  ['POST', '/api/admin/invites/:id/send'],
  ['GET', '/api/admin/invites/:id/link'],
  ['DELETE', '/api/admin/invites/:id'],
  ['DELETE', '/api/admin/tokens/:id'],
  ['DELETE', '/api/admin/apps/:id'],
  ['POST', '/api/admin/webhooks'],
  ['PATCH', '/api/admin/webhooks/:id'],
  ['POST', '/api/workspaces'],
  ['PUT', '/api/workspaces/current/persona'],
  ['PUT', '/api/workspaces/current/badge'],
  // A person's own data (A13 PEOPLE-1): taking it home, deleting the account, deleting the workspace they own — and
  // first, what that would take. Never a token's: one leaked would carry everything off, or end it.
  ['GET', '/api/auth/me/export'],
  ['GET', '/api/auth/me/deletion'],
  ['POST', '/api/auth/me/delete'],
  ['GET', '/api/workspaces/current/deletion'],
  ['POST', '/api/workspaces/current/delete'],
  // A person's first run (its setup's end, Get started put away, the agent picked): their own, never an agent's (ONB-2).
  ['PUT', '/api/onboarding'],
  // What the server runs on (its address, storage, mail relay) and a mail sent in its name: a person's to look at.
  ['GET', '/api/server/health'],
  ['POST', '/api/server/mail-test'],
  // A person's own conversion moments (what they put away, what they saw) and the operator's pages — every workspace
  // and account on the server, plans set by hand, accounts disabled: never a token's.
  ['PUT', '/api/moments/:id'],
  ['POST', '/api/moments/:id/seen'],
  ['POST', '/api/moments/event'],
  ['GET', '/api/operator/funnel'],
  ['GET', '/api/operator/workspaces'],
  ['GET', '/api/operator/workspaces/:id'],
  ['POST', '/api/operator/workspaces/:id/plan'],
  ['GET', '/api/operator/workspaces/:id/deletion'],
  ['POST', '/api/operator/workspaces/:id/suspend'],
  ['POST', '/api/operator/workspaces/:id/unsuspend'],
  ['POST', '/api/operator/workspaces/:id/delete'],
  ['GET', '/api/operator/accounts'],
  ['GET', '/api/operator/accounts/:id'],
  ['POST', '/api/operator/accounts/:id/disable'],
  ['POST', '/api/operator/accounts/:id/enable'],
  ['POST', '/api/review/:slug/shares'],
  ['POST', '/api/folder-shares'],
  ['PATCH', '/api/shares/:token'],
  ['DELETE', '/api/shares/:token'],
  // A device that gets the account's notifications (note texts on a lock screen) is a lasting way out too; agents have
  // no service worker to receive one.
  ['POST', '/api/push/subscribe'],
  // Publishing: a post going out on a platform is a person's act, and so is every key or sign-in it goes out through
  // (agents only draft: draft_post).
  ['POST', '/api/publish/connections'],
  ['PATCH', '/api/publish/connections/:id'],
  ['DELETE', '/api/publish/connections/:id'],
  ['POST', '/api/publish/connections/:id/check'],
  ['POST', '/api/publish/connections/:id/authorize'],
  ['GET', '/api/publish/oauth/callback'],
  ['POST', '/api/posts/:id/publish'],
  ['POST', '/api/posts/:id/cancel'],
  ['POST', '/api/posts/:id/retry'],
];
export const PERSON_ONLY_ERROR = 'only a person signed in in the app can do this, not an API token';

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const compile = (pattern: string) =>
  new RegExp(
    `^${pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/:[a-z]+/gi, '[^/]+')
      .replace(/\/\*$/, '/.+')}$`,
  );
const TABLE = ROUTE_ACTIONS.map(([method, pattern, rule]) => ({ method, re: compile(pattern), rule, pattern }));
const PERSON = PERSON_ONLY.map(([method, pattern]) => ({ method, re: compile(pattern) }));

/** Whether a request is one only a person makes (PERSON_ONLY). */
export const personOnly = (method: string, path: string): boolean => {
  const m = method === 'HEAD' ? 'GET' : method;
  return PERSON.some((r) => r.method === m && r.re.test(path));
};

/**
 * What a request needs. Reads are `view` unless listed; a write that isn't listed is refused to everyone (`none`), so
 * a new route stays closed until someone decides who may use it (and test/unit/accounts.test.ts asks them to). Paths
 * are compared exactly as written, like the routers (server/http.ts router()).
 */
export function ruleFor(method: string, path: string): { rule: Rule | 'none'; listed: boolean } {
  const m = method === 'HEAD' ? 'GET' : method;
  const hit = TABLE.find((r) => (r.method === '*' || r.method === m) && r.re.test(path));
  if (hit) return { rule: hit.rule, listed: true };
  return { rule: WRITES.has(m) ? 'none' : 'view', listed: false };
}

/**

 * What a sign-up whose address isn't confirmed yet may reach (lib/auth.ts isGated): who it is, its own profile (a
 * mistyped address can be changed, which sends a new link), the links themselves, signing out. Nothing with data.
 */
const HELD_MAY = new Set([
  'GET /api/auth/status',
  'GET /api/auth/me',
  'PATCH /api/auth/me',
  'POST /api/auth/logout',
  'POST /api/auth/logout-everywhere',
  'POST /api/auth/verify',
  'POST /api/auth/verify/resend',
  'POST /api/auth/email/cancel',
  'POST /api/auth/forgot',
  'POST /api/auth/reset',
  'POST /api/auth/reset/peek',
  'GET /api/info',
]);
const PRIVATE_PATH = /^\/(api|media|data|mcp|oauth|\.well-known)(\/|$)/i;

/** What an extension module's route declares about its callers (server/extension.ts Route): public, or a role and a person. */
export type ModuleAccess = 'public' | { role: Role; person: boolean };

/**
 * What a suspended workspace's people are told when they try to change something there (A13 CLOUD-5): the operator
 * holds it read-only. Never the operator's reason.
 */
export const SUSPENDED_ERROR =
  'this workspace is suspended by whoever runs this server: you can read and download what is in it, but nothing can change for now';

/**
 * A write in a workspace the server's operator suspended: refused (423) — every action of the table but reading
 * (`view`: what you watched, what you put away), your own account and its sessions (`self`), and what authenticates
 * itself (`public`). A module's routes (billing) are refused too.
 */
function refuseIfSuspended(req: Request, rule: Rule | 'none' | 'module'): void {
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  if (!WRITES.has(method) || rule === 'self' || rule === 'public' || rule === 'view') return;
  const ws = req.auth?.workspace;
  if (ws && suspensionOf(ws)) throw fail(423, SUSPENDED_ERROR, { suspended: true });
}

/** owner > admin > member > reviewer: a module route's `role` is the lowest that may call it. */
const ROLE_RANK: Record<Role, number> = { reviewer: 0, member: 1, admin: 2, owner: 3 };

/**
 * Runs after the caller is known (guard + identify) and before every route, whatever the path. `own`: an extension
 * module's routes (server/extension.ts), held to the role and person they declare instead of the table's actions.
 */
export function authorize({ own }: { own?: (method: string, path: string) => ModuleAccess | null } = {}) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    // Review links carry their own scoped token; signed-out requests are the guard's business.
    if (req.auth && !GUEST_PATH.test(req.path)) {
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      if (isGated(req.auth.user) && PRIVATE_PATH.test(req.path) && !HELD_MAY.has(`${method} ${req.path}`))
        throw fail(403, 'confirm your email address first: the link is in your inbox', { unconfirmed: true });
      const module = own?.(req.method, req.path) ?? null;
      if (module) {
        if (module !== 'public') {
          // the workspace's role from the request (req.auth.role), never the account's mirror (user.role)
          if (ROLE_RANK[req.auth.role] === undefined || ROLE_RANK[req.auth.role] < ROLE_RANK[module.role])
            throw fail(403, `your role (${req.auth.role}) can't do that`);
          if (module.person && req.auth.via === 'token') throw fail(403, PERSON_ONLY_ERROR, { person: true });
          refuseIfSuspended(req, 'module');
        }
      } else {
        const { rule } = ruleFor(req.method, req.path);
        if (rule === 'none') throw fail(403, 'not in the permission table');
        if (rule !== 'self' && rule !== 'public' && !can(req.auth.role, rule)) throw fail(403, `your role (${req.auth.role}) can't do that`);
        if (req.auth.via === 'token' && personOnly(req.method, req.path)) throw fail(403, PERSON_ONLY_ERROR, { person: true });
        refuseIfSuspended(req, rule);
      }
    }
    next();
  };
}
