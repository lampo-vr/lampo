// OAuth 2.1 for MCP clients of a hosted server (MCP authorization 2026-07-28): the server is its own authorization
// server, and /mcp is the protected resource. ChatGPT, Claude.ai / Claude Desktop, Cursor, Codex and any client that
// signs in instead of taking an API token go through here:
//   /.well-known/oauth-protected-resource[/mcp]   RFC 9728: which authorization server protects /mcp
//   /.well-known/oauth-authorization-server       RFC 8414: endpoints, PKCE S256, client ID metadata documents
//   GET  /oauth/authorize    validates client + redirect URI + PKCE + resource, then hands over to the consent screen
//                            (#/oauth/<request> in the app: sign in there if needed, Allow or Deny); nothing goes to
//                            the app's address until the person decides (any problem before is the app's own page).
//                            `client_id=vr` is `vr login` itself (lib/oauth/clients.ts VR_CLIENT): a loopback answer,
//                            `machine` and `days`, and a code redeemed for an API token at POST /api/auth/token
//   POST /oauth/token        authorization_code (PKCE) and refresh_token (rotation, reuse detection)
//   POST /oauth/register     RFC 7591 dynamic registration (deprecated by MCP, still used by some clients)
//   POST /oauth/revoke       RFC 7009
// Tokens are opaque, stored hashed, bound to <public url>/mcp, and only ever accepted there. Local mode has none of it.
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { BRAND_NAME } from '../../lib/brand.ts';
import { wellFormed } from '../../lib/names.ts';
import {
  ClientError,
  type ClientInfo,
  clientSecretMatches,
  isLoopbackRedirect,
  isVrRedirect,
  redirectMatches,
  registerClient,
  resolveClient,
  VR_CLIENT,
  VR_CLIENT_ID,
  vrMachine,
  vrTokenName,
} from '../../lib/oauth/clients.ts';
import * as grants from '../../lib/oauth/store.ts';
import { can } from '../../lib/permissions.ts';
import { addressKey, RateLimit } from '../../lib/rateLimit.ts';
import { parseScope, SCOPE_LIST, SCOPES, type Scope } from '../../lib/scopes.ts';
import type { OAuthRequestView } from '../../lib/types.ts';
import * as workspaces from '../../lib/workspaces.ts';
import { type Auth, requireAdmin, requireUser } from '../auth.ts';
import type { ServerContext } from '../context.ts';
import { CONSENT_PAGE } from '../guard.ts';
import { fail, router } from '../http.ts';
import { keptInMemory } from './shares/access.ts';

/** The issuer and the MCP resource, from the public URL (or, without one, from the request). */
export function oauthBase(ctx: ServerContext, req: Request): { issuer: string; resource: string } {
  const issuer = (ctx.cfg.public_url || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return { issuer, resource: `${issuer}/mcp` };
}

/** RFC 9728 metadata URL for /mcp (path-inserted), as the 401 challenge advertises it. */
export const resourceMetadataUrl = (issuer: string): string => `${issuer}/.well-known/oauth-protected-resource/mcp`;

/** Resource indicators compare case-insensitively in scheme and host and ignore one trailing slash (MCP 2026-07-28). */
function sameResource(asked: string, resource: string): boolean {
  try {
    const a = new URL(asked);
    const r = new URL(resource);
    if (a.hash) return false;
    const path = (p: string) => p.replace(/\/+$/, '') || '/';
    return a.protocol === r.protocol && a.host === r.host && path(a.pathname) === path(r.pathname) && a.search === r.search;
  } catch {
    return false;
  }
}

/** What the app's error page (#/oauth/error, web/src/lib/nav.ts) can be told: a code of this set, never words. */
type OAuthErrorCode = 'invalid_client' | 'invalid_request' | 'slow_down' | 'unsupported_response_type' | 'invalid_target' | 'invalid_scope';

class OAuthFailure extends Error {
  status: number;
  code: string;
  basic: boolean;
  constructor(status: number, code: string, message: string, basic = false) {
    super(message);
    this.status = status;
    this.code = code;
    this.basic = basic;
  }
}

function oauthError(res: Response, e: unknown): void {
  const f =
    e instanceof OAuthFailure
      ? e
      : e instanceof grants.GrantError
        ? new OAuthFailure(400, e.code, e.message)
        : e instanceof ClientError
          ? new OAuthFailure(e.code === 'invalid_client' ? 401 : 400, e.code, e.message)
          : new OAuthFailure(400, 'invalid_request', (e as Error).message);
  if (f.basic) res.setHeader('WWW-Authenticate', 'Basic realm="video-review"');
  res.setHeader('Cache-Control', 'no-store');
  res.status(f.status).json({ error: f.code, error_description: f.message });
}

// Browser-based MCP clients (the Inspector, web apps) call these from other origins; nothing here uses cookies.
function cors(req: Request, res: Response): boolean {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

const form = [express.urlencoded({ extended: false, limit: '16kb' }), express.json({ limit: '16kb' })];
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Client authentication at the token and revocation endpoints: Basic, a secret in the body, or none (public + PKCE). */
async function authenticateClient(req: Request): Promise<string> {
  const basic = /^Basic\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1];
  let id = str(req.body?.client_id);
  let secret = str(req.body?.client_secret) ?? null;
  if (basic) {
    const raw = Buffer.from(basic, 'base64').toString('utf8');
    const i = raw.indexOf(':');
    if (i < 0) throw new OAuthFailure(401, 'invalid_client', 'malformed Basic credentials', true);
    id = decodeURIComponent(raw.slice(0, i));
    secret = decodeURIComponent(raw.slice(i + 1));
  }
  if (!id) throw new OAuthFailure(401, 'invalid_client', 'client_id is required', !!basic);
  let client: ClientInfo;
  try {
    client = await resolveClient(id);
  } catch (e) {
    throw new OAuthFailure(401, 'invalid_client', (e as Error).message, !!basic);
  }
  if (client.kind === 'dcr' && !clientSecretMatches(id, client.auth === 'none' ? null : secret))
    throw new OAuthFailure(401, 'invalid_client', 'client authentication failed', !!basic);
  return id;
}

/** Scopes the account's role can't fully use: the consent screen lists them as capped. */
const cappedFor = (auth: Auth, scopes: Scope[]): Scope[] => scopes.filter((s) => SCOPES[s].actions.some((a) => !can(auth.role, a)));

/** Authorization requests one address may have waiting (made in the last ten minutes, as long as one lives). */
export const PENDING_PER_ADDRESS = 50;

export function oauthRoutes(ctx: ServerContext): Router {
  const r = router();
  // Everywhere: MCP clients on other devices sign in through it; on the person's own machine the machine itself needs none.
  const authorizeTries = new RateLimit(120, 60_000);
  const tokenTries = new RateLimit(240, 60_000);
  const registrations = new RateLimit(30, 3600_000);
  // Requests one address (an IPv6 /64) has waiting for a consent: a request lives ten minutes, and anyone signed out
  // makes them (A13 AUTH-2). Counted when one is made.
  const pendingByAddress = new RateLimit(PENDING_PER_ADDRESS, 10 * 60_000);
  keptInMemory(ctx, { oauthRequests: grants.pendingRequests, oauthPendingByAddress: pendingByAddress, oauthAuthorizeTries: authorizeTries });
  const limited = (lim: RateLimit, req: Request) => {
    const key = addressKey(req.ip || 'unknown');
    lim.hit(key);
    const wait = lim.retryAfter(key);
    if (wait) throw Object.assign(new OAuthFailure(429, 'slow_down', 'too many requests'), { retryAfter: wait });
  };

  // ---------------------------------------------------------------- discovery

  const protectedResource = (req: Request, res: Response) => {
    if (cors(req, res)) return;
    const { issuer, resource } = oauthBase(ctx, req);
    res.json({
      resource,
      authorization_servers: [issuer],
      scopes_supported: SCOPE_LIST,
      bearer_methods_supported: ['header'],
      resource_name: BRAND_NAME,
    });
  };
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    r.get(path, protectedResource);
    r.options(path, protectedResource);
  }

  const serverMetadata = (req: Request, res: Response) => {
    if (cors(req, res)) return;
    const { issuer } = oauthBase(ctx, req);
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
      scopes_supported: SCOPE_LIST,
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${issuer}/#/settings/tokens`,
    });
  };
  r.get('/.well-known/oauth-authorization-server', serverMetadata);
  r.options('/.well-known/oauth-authorization-server', serverMetadata);

  // ---------------------------------------------------------------- authorization request → consent screen

  const Authorize = z.object({
    response_type: z.string().optional(),
    client_id: z.string().max(500).optional(),
    redirect_uri: z.string().max(2000).optional(),
    state: z.string().max(1000).optional(),
    code_challenge: z.string().max(200).optional(),
    code_challenge_method: z.string().max(20).optional(),
    scope: z.string().max(1000).optional(),
    resource: z.string().max(2000).optional(),
    // vr login's own: the computer it runs on, and the days its token works (absent: until revoked)
    machine: z.string().max(200).optional(),
    days: z
      .string()
      .regex(/^[1-9]\d{0,3}$/)
      .refine((d) => Number(d) <= 3650)
      .optional(),
  });

  // Until the person has decided, nothing goes to the app's address — not even an error: anyone may register a client
  // (open registration, or a metadata document of their own) with an address of their choosing, and a redirect from
  // here would make this server's authorize URL a link to it (A12 WEB-3; RFC 9700 §4.11.2). Problems are shown on our
  // own page instead, by a code of a fixed set and nothing else from the request (WEB-6: no text of anyone's in the
  // app's frame).
  const showError = (res: Response, code: OAuthErrorCode) => res.redirect(302, `/#/oauth/error?${new URLSearchParams({ error: code })}`);

  const answer = (redirect: string, params: Record<string, string | null | undefined>) => {
    const u = new URL(redirect);
    for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
    return u.toString();
  };

  r.get('/oauth/authorize', async (req, res) => {
    try {
      limited(authorizeTries, req);
    } catch {
      return showError(res, 'slow_down');
    }
    const q = Authorize.safeParse(req.query);
    if (!q.success) return showError(res, 'invalid_request');
    const p = q.data;
    const vr = p.client_id === VR_CLIENT_ID;
    let client: ClientInfo;
    try {
      client = vr ? VR_CLIENT : await resolveClient(p.client_id || '');
    } catch {
      return showError(res, 'invalid_client');
    }
    // vr's answer goes to a loopback port of the person's own computer and nowhere else, whatever else it asks
    if (!p.redirect_uri || !(vr ? isVrRedirect(p.redirect_uri) : redirectMatches(client.redirect_uris, p.redirect_uri)))
      return showError(res, 'invalid_request');
    const { resource } = oauthBase(ctx, req);
    if (p.response_type !== 'code') return showError(res, 'unsupported_response_type');
    if (!p.code_challenge || p.code_challenge_method !== 'S256') return showError(res, 'invalid_request');
    if (!/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge)) return showError(res, 'invalid_request');
    const from = addressKey(req.ip || 'unknown');
    if (!pendingByAddress.allows(from)) return showError(res, 'slow_down');
    if (vr) {
      // no scopes and no resource: what vr gets is an API token, the account's role in the workspace the screen names
      const machine = vrMachine(p.machine);
      if (!machine || p.state === undefined) return showError(res, 'invalid_request');
      const vrAsk = { machine, days: p.days === undefined ? null : Number(p.days) };
      const pending = grants.createRequest({
        client,
        redirect_uri: p.redirect_uri,
        state: p.state,
        code_challenge: p.code_challenge,
        scopes: [],
        resource,
        vr: vrAsk,
      });
      pendingByAddress.hit(from);
      return res.redirect(302, `${CONSENT_PAGE}#/oauth/${pending.id}`);
    }
    if (p.resource !== undefined && !sameResource(p.resource, resource)) return showError(res, 'invalid_target');
    const scopes = p.scope === undefined ? SCOPE_LIST : parseScope(p.scope);
    if (!scopes.length) return showError(res, 'invalid_scope');
    const pending = grants.createRequest({ client, redirect_uri: p.redirect_uri, state: p.state ?? null, code_challenge: p.code_challenge, scopes, resource });
    pendingByAddress.hit(from);
    // the consent page under its own opener policy (CONSENT_PAGE in server/guard.ts): an app's popup keeps its opener
    res.redirect(302, `${CONSENT_PAGE}#/oauth/${pending.id}`);
  });

  // The consent screen: only a person in a browser decides — signed in, or the owner at the machine the app runs on —
  // never an API token or another app.
  const consenting = (req: Request): Auth => {
    const a = req.auth;
    if (!a?.user) throw fail(401, 'please sign in');
    if (a.via !== 'cookie' && a.via !== 'local') throw fail(403, 'consent is given in the browser, signed in');
    return a;
  };

  r.get('/api/oauth/requests/:id', requireUser, (req, res) => {
    const a = consenting(req);
    const p = grants.getRequest(req.params.id as string);
    if (!p) throw fail(404, 'this authorization request has expired or was already answered: start again from the app');
    const out: OAuthRequestView = {
      client_name: p.client.name,
      client_host: p.client.host,
      verified: p.client.kind === 'cimd',
      redirect_uri: p.redirect_uri,
      redirect_host: (() => {
        try {
          const u = new URL(p.redirect_uri);
          return u.host || `${u.protocol}//`;
        } catch {
          return p.redirect_uri;
        }
      })(),
      local_redirect: isLoopbackRedirect(p.redirect_uri),
      scopes: p.scopes,
      capped: cappedFor(a, p.scopes),
      resource: p.resource,
      // vr login: the computer and the token it gets (named as Settings → API tokens will list it)
      ...(p.vr ? { vr: { machine: p.vr.machine, days: p.vr.days, token: vrTokenName(p.vr.machine) } } : {}),
    };
    // The app will act in the workspace the person works in now (and only there), so the screen names it.
    const w = workspaces.listWorkspaces().length > 1 ? workspaces.getWorkspace(a.workspace) : null;
    if (w) out.workspace = workspaces.workspaceInfo(w);
    res.json(out);
  });

  // `workspace`: the one the consent screen named (absent when it named none). An app is allowed for the workspace the
  // person saw, never another: a switch in another tab between seeing and allowing is refused, and the request waits
  // for the screen to show where the app would work now (A12 WS-12).
  const Decision = z.object({ allow: z.boolean(), workspace: z.string().max(40).optional() }).strict();
  r.post('/api/oauth/requests/:id', express.json(), requireUser, (req, res) => {
    const a = consenting(req);
    const d = Decision.safeParse(req.body ?? {});
    if (!d.success) throw fail(400, 'invalid body: allow must be true or false');
    if (!grants.getRequest(req.params.id as string))
      throw fail(404, 'this authorization request has expired or was already answered: start again from the app');
    const several = workspaces.listWorkspaces().length > 1;
    if (d.data.allow && (d.data.workspace ?? (several ? null : a.workspace)) !== a.workspace)
      throw fail(409, 'you switched to another workspace since this screen was shown: check where the app will work, then answer again', {
        state: 'workspace',
        workspace: a.workspace,
      });
    const p = grants.takeRequest(req.params.id as string);
    if (!p) throw fail(404, 'this authorization request has expired or was already answered: start again from the app');
    const { issuer } = oauthBase(ctx, req);
    if (!d.data.allow) {
      res.json({ redirect: answer(p.redirect_uri, { error: 'access_denied', error_description: 'the user denied access', state: p.state, iss: issuer }) });
      return;
    }
    const code = grants.createCode(p, a.user as NonNullable<Auth['user']>, a.workspace);
    res.json({ redirect: answer(p.redirect_uri, { code, state: p.state, iss: issuer }) });
  });

  // ---------------------------------------------------------------- token, registration, revocation

  r.all('/oauth/token', ...form, async (req, res) => {
    if (cors(req, res)) return;
    try {
      if (req.method !== 'POST') throw new OAuthFailure(405, 'invalid_request', 'use POST');
      limited(tokenTries, req);
      const client_id = await authenticateClient(req);
      const b = req.body ?? {};
      const grantType = str(b.grant_type);
      let tokens: grants.Tokens;
      if (grantType === 'authorization_code')
        tokens = grants.redeemCode({
          code: str(b.code) || '',
          client_id,
          redirect_uri: str(b.redirect_uri),
          code_verifier: str(b.code_verifier),
          resource: str(b.resource),
        });
      else if (grantType === 'refresh_token')
        tokens = grants.refresh({ refresh_token: str(b.refresh_token) || '', client_id, scope: str(b.scope), resource: str(b.resource) });
      else throw new OAuthFailure(400, 'unsupported_grant_type', 'use authorization_code or refresh_token');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
      res.json(tokens);
    } catch (e) {
      if ((e as { retryAfter?: number }).retryAfter) res.setHeader('Retry-After', String((e as { retryAfter: number }).retryAfter));
      oauthError(res, e);
    }
  });

  r.all('/oauth/register', express.json({ limit: '16kb' }), (req, res) => {
    if (cors(req, res)) return;
    try {
      if (req.method !== 'POST') throw new OAuthFailure(405, 'invalid_request', 'use POST');
      limited(registrations, req);
      res.setHeader('Cache-Control', 'no-store');
      const connected = grants.connectedClientIds();
      res.status(201).json(registerClient(wellFormed(req.body ?? {}), { inUse: (id) => connected.has(id) }));
    } catch (e) {
      if ((e as { retryAfter?: number }).retryAfter) res.setHeader('Retry-After', String((e as { retryAfter: number }).retryAfter));
      oauthError(res, e);
    }
  });

  r.all('/oauth/revoke', ...form, async (req, res) => {
    if (cors(req, res)) return;
    try {
      if (req.method !== 'POST') throw new OAuthFailure(405, 'invalid_request', 'use POST');
      limited(tokenTries, req);
      const client_id = await authenticateClient(req);
      grants.revokeToken(str(req.body?.token) || '', client_id);
      res.json({});
    } catch (e) {
      oauthError(res, e);
    }
  });

  // ---------------------------------------------------------------- connected apps

  // Apps act in one workspace each: the lists are the workspace's the request works in.
  const wsOf = (req: Request) => (req.auth as Auth).workspace;
  r.get('/api/auth/apps', requireUser, (req, res) => {
    const me = req.auth?.user;
    res.json({ apps: me ? grants.listApps(me.id, wsOf(req)) : [] });
  });

  r.delete('/api/auth/apps/:id', requireUser, (req, res) => {
    const me = req.auth?.user;
    if (!me) throw fail(400, 'local mode has no connected apps');
    if (!grants.revokeApp(req.params.id as string, me.id, wsOf(req))) throw fail(404, 'no such connected app');
    res.json({ ok: true });
  });

  // An owner's connected apps are an owner's business, like their tokens (server/auth.ts): admins see everyone else's.
  const ownersApp = (req: Request, user: string) => req.auth?.role !== 'owner' && workspaces.roleIn(wsOf(req), user) === 'owner';
  r.get('/api/admin/apps', requireAdmin, (req, res) => {
    res.json({ apps: grants.listApps(undefined, wsOf(req)).filter((a) => !ownersApp(req, a.user)) });
  });

  r.delete('/api/admin/apps/:id', requireAdmin, (req, res) => {
    const app = grants.listApps(undefined, wsOf(req)).find((a) => a.id === req.params.id);
    if (app && ownersApp(req, app.user)) throw fail(403, 'only owners can manage owners');
    if (!grants.revokeApp(req.params.id as string, undefined, wsOf(req))) throw fail(404, 'no such connected app');
    res.json({ ok: true });
  });

  return r;
}
