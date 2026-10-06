// The HTTP app without the process around it (listening, watchers, UI build), so tests can boot it on any port.
import fs from 'node:fs';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { ROLES } from '../lib/auth.ts';
import { DEFAULT_WORKSPACE, ROOT } from '../lib/paths.ts';
import { internal } from '../lib/publicError.ts';
import { rootStorage } from '../lib/storage/index.ts';
import type { Role } from '../lib/types.ts';
import { authRoutes } from './auth.ts';
import type { ServerContext } from './context.ts';
import { hostRequest, ModuleRouteError, requestOf } from './extension.ts';
import { sampleForFirstRun } from './firstSample.ts';
import { countFunnel } from './funnel.ts';
import { canonicalPaths, createGuard, type HeaderOptions, protectiveHeaders } from './guard.ts';
import { createErrorHandler, HttpError, sendInternal } from './http.ts';
import { authorize } from './permissions.ts';
import { builtFiles, fastJson, IMMUTABLE, sendPrecompressed } from './respond.ts';
import { registeredRoutes, routeFor } from './routeList.ts';
import { accountRoutes } from './routes/account.ts';
import { analysisRoutes } from './routes/analysis.ts';
import { askRoutes } from './routes/asks.ts';
import { downloadRoutes } from './routes/downloads.ts';
import { draftRoutes } from './routes/drafts.ts';
import { elementRoutes } from './routes/elements.ts';
import { footageRoutes } from './routes/footage.ts';
import { insightRoutes } from './routes/insights.ts';
import { libraryRoutes } from './routes/library.ts';
import { mcpRoutes } from './routes/mcp.ts';
import { mediaRoutes } from './routes/media.ts';
import { momentRoutes } from './routes/moments.ts';
import { oauthRoutes } from './routes/oauth.ts';
import { onboardingRoutes } from './routes/onboarding.ts';
import { operatorRoutes } from './routes/operator.ts';
import { phoneRoutes } from './routes/phone.ts';
import { playbookRoutes } from './routes/playbooks.ts';
import { previewRoutes } from './routes/previews.ts';
import { publishRoutes } from './routes/publish.ts';
import { recordingRoutes } from './routes/recordings.ts';
import { refRoutes } from './routes/refs.ts';
import { reviewRoutes } from './routes/review.ts';
import { serverHealthRoutes } from './routes/serverHealth.ts';
import { sessionRoutes } from './routes/sessions.ts';
import { discoveryTag } from './routes/shares/embed.ts';
import { shareRoutes } from './routes/shares.ts';
import { statusRoutes } from './routes/status.ts';
import { systemRoutes } from './routes/system.ts';
import { transcriptRoutes } from './routes/transcripts.ts';
import { uploadRoutes } from './routes/uploads.ts';
import { voiceRoutes } from './routes/voice.ts';
import { webhookRoutes } from './routes/webhooks.ts';
import { workspaceRoutes } from './routes/workspaces.ts';
import { yourDataRoutes } from './routes/yourData.ts';
import { workspaceScope } from './workspace.ts';

const ROBOTS = `# Nothing on this server is for search engines: every answer carries "X-Robots-Tag: noindex".
# Fetching stays allowed so they can see that (a page shut out here could still be listed by its address alone).
User-agent: *
Disallow:
`;

/**
 * Forwarding headers from a peer VR_TRUST_PROXY doesn't name are ignored, so every visitor looks like that peer and
 * per-address limits (sign-in, link passwords) hit everyone at once. Said once in the log: the proxy isn't named, or
 * the app's port is reachable without it.
 */
export function untrustedProxyWarning(trusts: (addr: string, i: number) => boolean, named: string | false, log = console.warn) {
  let warned = false;
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!warned && (req.headers['x-forwarded-for'] || req.headers.forwarded)) {
      const peer = req.socket.remoteAddress || 'unknown';
      if (!trusts(peer, 0)) {
        warned = true;
        log(
          `warning: a request came with forwarding headers from ${peer}, which VR_TRUST_PROXY (${named || 'not set'}) doesn't name: every visitor looks like ${peer} to sign-in limits. Name your proxy in VR_TRUST_PROXY, and make sure the app's port is only reachable through it (docs/go-live.md).`,
        );
      }
    }
    next();
  };
}

export interface AppOptions {
  /** Serves the built UI (and the SPA fallback) after the API; omit for API-only (tests). */
  ui?: (app: Express) => void;
}

export function createApp(ctx: ServerContext, { ui }: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  // The conversion funnel counts while this app is hosted with a billing module (lib/funnel.ts); self-hosted, nothing.
  countFunnel(ctx);
  // Routes match exactly as written (server/http.ts router()); anything spelled differently is a 404 before any check.
  app.set('case sensitive routing', true);
  app.set('strict routing', true);
  // The same protective headers on every answer, those given before the guard included (health, robots.txt, a 404).
  // A billing module's payment form loads its provider's script and frames: on the hosted app's own pages only.
  const headers: HeaderOptions = {
    publicUrl: ctx.cfg.public_url,
    mediaOrigins: rootStorage().origins(),
    dev: ctx.dev,
    moduleSources: ctx.hosted ? ctx.extension.contentSecurity : null,
  };
  app.use(protectiveHeaders(headers));
  app.use(canonicalPaths());
  // Every JSON answer: ETag + 304, compressed when big, Server-Timing (server/respond.ts).
  app.use(fastJson());
  // Liveness for Docker / load balancers: no auth, no data.
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  // Readiness: one boolean per check, details only in the log (server/ready.ts). 503 while not ready or stopping.
  app.get('/readyz', async (_req, res) => {
    const { ok, stopping, checks } = await ctx.readiness.check();
    res.setHeader('Cache-Control', 'no-store');
    res.status(ok ? 200 : 503).json({ ok, stopping, checks });
  });
  // Behind Caddy/nginx the client's address and https come from forwarding headers; only trust them when told to.
  if (ctx.hosted) {
    app.set('trust proxy', ctx.cfg.trust_proxy);
    app.use(untrustedProxyWarning(app.get('trust proxy fn'), ctx.cfg.trust_proxy));
  }
  // Crawlers may fetch pages (so they see the noindex every answer carries), but there is nothing to index.
  app.get('/robots.txt', (_req, res) => {
    res.type('text/plain').send(ROBOTS);
  });
  // The machine's tunnel: review links tell its visitors apart by Cloudflare's header (ipOf, server/routes/shares).
  app.locals.tunnel = ctx.capabilities.tunnel;
  // An Embed link's pages carry their oEmbed discovery tag (staticUi below; server/routes/shares/embed.ts).
  app.locals.discovery = ((req, token, kind) => discoveryTag(ctx, req, token, kind)) satisfies Discovery;
  // One guard for a hosted server and the person's own machine; the machine adds its host names and the LAN link.
  app.use(
    createGuard({
      ...headers,
      publicUrl: ctx.cfg.public_url,
      identify: ctx.identify,
      machine: ctx.hosted ? null : { lanToken: ctx.lan ? ctx.token : null },
      alsoPublic: (method, p) => ctx.extension.routes.some((r) => r.public && r.method === method && r.path === p),
      mediaOrigin: ctx.hosted ? ctx.cfg.media_origin : null,
    }),
  );

  // Everything after this runs in the request's workspace (server/workspace.ts, lib/scope.ts).
  app.use(workspaceScope({ hosted: ctx.hosted }));
  // What the caller's role may do, checked once for every route (server/permissions.ts); an extension module's routes
  // check their callers themselves.
  // a module's routes are held to the role and person they declare (mountExtension refuses one that declares none)
  app.use(
    authorize({
      own: (method, p) => {
        const r = ctx.extension.routes.find((x) => x.method === method && x.path === p);
        return r ? (r.public ? 'public' : { role: r.role as Role, person: !!r.person }) : null;
      },
    }),
  );
  app.use(
    authRoutes({
      cfg: ctx.cfg,
      setupToken: () => ctx.setup.token,
      setupDone: () => {
        ctx.setup.token = null;
      },
      extension: () => ctx.extension,
      accountMail: ctx.accountMail,
      onSetup: (user) => void sampleForFirstRun(ctx, { workspace: DEFAULT_WORKSPACE, user }),
    }),
  );
  // Sign-up, confirming an address, forgot password: what emailed links start (server/routes/account.ts).
  app.use(accountRoutes(ctx));
  app.get('/api/events', ctx.hub.handler);
  for (const routes of [
    libraryRoutes,
    reviewRoutes,
    sessionRoutes,
    mediaRoutes,
    previewRoutes,
    elementRoutes,
    refRoutes,
    askRoutes,
    publishRoutes,
    analysisRoutes,
    transcriptRoutes,
    footageRoutes,
    shareRoutes,
    downloadRoutes,
    statusRoutes,
    voiceRoutes,
    recordingRoutes,
    draftRoutes,
    insightRoutes,
    onboardingRoutes,
    serverHealthRoutes,
    momentRoutes,
    operatorRoutes,
    playbookRoutes,
    systemRoutes,
    uploadRoutes,
    webhookRoutes,
    workspaceRoutes,
    yourDataRoutes,
    phoneRoutes,
    oauthRoutes,
    mcpRoutes,
  ])
    app.use(routes(ctx));
  mountExtension(app, ctx);
  ui?.(app);
  app.use(createErrorHandler({ hosted: ctx.hosted }));
  return app;
}

/**
 * An extension module's routes (server/extension.ts), adapted from Express in this one place. Only routes of its own:
 * one the app answers already (its method, and a path one of the app's patterns matches) would be the app's handler
 * behind the module's exemptions — public, no role check (sweep 2 SW-6) — so the module is refused (ModuleRouteError).
 */
function mountExtension(app: Express, ctx: ServerContext): void {
  const own = registeredRoutes(app);
  for (const route of ctx.extension.routes) {
    const taken = routeFor(own, route.method, route.path);
    if (taken)
      throw new ModuleRouteError(
        `the module ${ctx.extension.name ?? ''} names ${route.method} ${route.path}, which is the app’s own (${taken[0]} ${taken[1]}): give the module routes of its own, such as /api/billing/…`,
      );
    // who may call it is the app's to hold it to: a signed-in route that says nothing is refused, not left open (BILL-10)
    if (!route.public && !ROLES.includes(route.role as Role))
      throw new ModuleRouteError(
        `the module ${ctx.extension.name ?? ''} doesn’t say who may call ${route.method} ${route.path}: give the route a role (${ROLES.join(', ')}), and person: true for what only a person signed in may do`,
      );
  }
  for (const route of ctx.extension.routes) {
    const parse = route.raw ? express.raw({ type: () => true, limit: '1mb' }) : express.json({ limit: '256kb' });
    const handler = async (req: express.Request, res: express.Response) => {
      const h = hostRequest(req, route.raw);
      requestOf.set(h, req);
      const out = await route.handle(h);
      for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, String(v));
      res.setHeader('Cache-Control', 'no-store');
      // A module's own 5xx is the server's business like any other: the error handler answers with a sentence and a
      // ref, and the module's text goes to the log under it (BILL-6). Its 4xx are its words to the caller, as they are.
      if (out.public && (out.status === 502 || out.status === 503)) {
        const { error, code } = (out.json ?? {}) as { error?: unknown; code?: unknown };
        if (typeof error === 'string' && error.trim()) {
          res.status(out.status).json({
            // a sentence for people: one line, no control characters, capped
            error: error
              .replace(/[\p{Cc}\s]+/gu, ' ')
              .trim()
              .slice(0, 300),
            ...(typeof code === 'string' && /^[a-z][a-z-]{0,39}$/.test(code) ? { code } : {}),
          });
          return;
        }
      }
      if (out.status >= 500) {
        const said = (out.json as { error?: unknown } | undefined)?.error;
        throw internal(new HttpError(out.status, `module ${ctx.extension.name ?? ''}: ${typeof said === 'string' ? said : JSON.stringify(out.json ?? {})}`));
      }
      res.status(out.status).json(out.json ?? {});
    };
    if (route.method === 'GET') app.get(route.path, handler);
    else app.post(route.path, parse, handler);
  }
}

/** An Embed link's oEmbed discovery tag for its page (`e`) or its watch page (`g`); '' for any other link. */
type Discovery = (req: Request, token: string, kind: 'e' | 'g') => string;

/**
 * A page of the build (`file`, read anew: a few KB), with an Embed link's oEmbed discovery tag in its head when `token`
 * names one, else as built (pre-compressed when the browser takes it). `no-transform`: a CDN in front must not inject
 * scripts into it or rewrite it (its one inline script is pinned by the CSP's hash; Rocket Loader, email obfuscation and
 * the like would break the page or be refused).
 */
function sendPage(req: Request, res: Response, file: string, link?: { token: string; kind: 'e' | 'g' }): void {
  const headers = { 'Cache-Control': 'no-cache, no-transform' };
  const discovery = req.app.locals.discovery as Discovery | undefined;
  const tag = link && discovery ? discovery(req, link.token, link.kind) : '';
  if (tag) {
    let html: string;
    try {
      html = fs.readFileSync(file, 'utf8');
    } catch {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res
      .set(headers)
      .type('html')
      .send(html.replace('</head>', `    ${tag}\n  </head>`));
    return;
  }
  if (sendPrecompressed(req, res, file, headers)) return;
  res.set(headers);
  sendInternal(res, file);
}

/** Built UI from web/dist with a fallback to index.html for client-side routes. */
export function staticUi(dist = path.join(ROOT, 'web', 'dist')) {
  return (app: Express): void => {
    // The service worker, the manifest and the offline page must never be stale: a new build is only picked up
    // when the browser sees a new sw.js.
    const fresh = /(?:^|\/)(sw\.js|manifest\.webmanifest|offline\.(html|js))$/;
    // Pre-compressed copies from the build first (brotli/gzip), then the files as they are.
    app.use(builtFiles(dist, fresh));
    app.use(
      express.static(dist, {
        index: false,
        maxAge: '1h',
        setHeaders: (res, file) => {
          // Hashed file names change with their content: nothing to revalidate, ever.
          if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', IMMUTABLE);
          if (fresh.test(file)) res.setHeader('Cache-Control', 'no-cache');
          if (file.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json');
          // Stripe's payment frames (js.stripe.com) draw their fields in our Instrument Sans: a font may be read across origins
          if (file.endsWith('.woff2')) res.setHeader('Access-Control-Allow-Origin', '*');
        },
      }),
    );
    // Machine endpoints never fall back to the page, however they are spelled: a client probing /.well-known, /oauth
    // or /API must get a clean 404. The page itself is revalidated every time (it names the current build's files).
    const index = path.join(dist, 'index.html');
    // An Embed link's player: a page of its own (web/embed.html), the one other sites may frame (server/guard.ts). Any
    // token gets it: the player asks for the link and says when it isn't one (or isn't any more) inside the frame.
    const embed = path.join(dist, 'embed.html');
    app.get('/e/:token', (req, res) => {
      if (!fs.existsSync(embed)) res.status(404).json({ error: 'not found' });
      else sendPage(req, res, embed, { token: req.params.token, kind: 'e' });
    });
    // a review link's page names its token: an Embed link's watch page carries the discovery tag too
    const watchPage = /^\/g\/([A-Za-z0-9_-]+)$/;
    app.get(/^\/(?!api(?:\/|$)|media(?:\/|$)|data(?:\/|$)|mcp(?:\/|$)|oauth(?:\/|$)|\.well-known(?:\/|$)).*/i, (req, res) => {
      const token = watchPage.exec(req.path)?.[1];
      sendPage(req, res, index, token ? { token, kind: 'g' } : undefined);
    });
  };
}
