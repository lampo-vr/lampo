// Who may talk to the server — one guard for a hosted server and for the app on a person's own machine. Everything
// but the public paths (isPublicPath) needs a caller: a signed-in user (session cookie, API token) or, on the person's
// own machine, the machine itself / a phone with the LAN link (server/auth.ts createIdentify). Host and Origin checks
// keep random web pages from driving the API (DNS rebinding, CSRF), Fetch Metadata keeps them from reading as the
// machine's owner (foreignSite); review links (/g/<token>) do their own token check.
import crypto from 'node:crypto';
import os from 'node:os';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { THEME_BOOT } from '../lib/themeBoot.ts';
import { type Identify, LAN_COOKIE, sameToken, sessionUpdates } from './auth.ts';
import type { ContentSources } from './extension.ts';
import { EMBED_PAGE, GUEST_PATH, LanQuery, queryOr } from './http.ts';

export { isLocal } from './auth.ts';
export { EMBED_PAGE, GUEST_PATH };

// The one inline script the page may run: it sets the colour theme before the first paint (lib/themeBoot.ts).
export const THEME_BOOT_HASH = `'sha256-${crypto.createHash('sha256').update(THEME_BOOT).digest('base64')}'`;

/**
 * Paths are taken as spelled, never normalised: a doubled slash, a dot segment or a trailing slash must not reach a
 * route under another name (routers match exactly, server/http.ts router()). Such a path is a plain 404 before anything
 * looks at who is asking.
 */
const NON_CANONICAL = /\/\/|\/\.\.?(?:\/|$)|.\/$/;
export function canonicalPaths() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (NON_CANONICAL.test(req.path)) res.status(404).json({ error: 'not found' });
    else next();
  };
}

export const lanIps = (): string[] =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => !!i && i.family === 'IPv4' && !i.internal)
    .map((i) => (i as os.NetworkInterfaceInfo).address);

/** The names the app answers to on a person's own machine: loopback, the machine's name, its LAN addresses. */
const machineHosts = (): Set<string> =>
  new Set(['localhost', '127.0.0.1', '::1', os.hostname(), `${os.hostname().replace(/\.local$/, '')}.local`, ...lanIps()]);

// ---------------------------------------------------------------- the guard

/** A one-time upload URL: its ticket is its own credential (server/uploadTickets.ts). */
const TICKET_PATH = /^\/api\/uploads\/direct\/[\w-]+$/;
/**
 * oEmbed (server/routes/shares/embed.ts): it says of an Embed link only what the link's player shows, and an embed's
 * pages name it at the address they were reached by — on the machine, the tunnel's, whose name changes every time.
 * So, like a review link, it answers on any host there, identifying nobody.
 */
const oEmbedAsked = (req: Request): boolean => req.path === '/oembed' && (req.method === 'GET' || req.method === 'HEAD');
/**
 * Reachable without signing in: the app shell asks these before it knows who you are, and what an emailed link or a
 * signed-out person asks (sign-up, confirming an address, forgot password, a reset): each checks its own token or
 * answers alike for every address (server/routes/account.ts).
 */
const PUBLIC_API = /^\/api\/(auth\/(status|setup|login|token|logout|invite\/peek|invite\/accept|signup|verify|verify\/resend|forgot|reset|reset\/peek)|info)$/;
/** OAuth endpoints that browser-based MCP clients call from their own origin; they authenticate the client, never a cookie. */
const CROSS_ORIGIN_OAUTH = /^\/oauth\/(token|register|revoke)$/;
/** Machine endpoints that authenticate the caller themselves: MCP (bearer tokens), OAuth and its discovery metadata. */
const SELF_AUTHENTICATING = /^\/(mcp|oauth\/[\w-]+|\.well-known\/[\w-]+(\/mcp)?)$/;
/** Private however it is spelled. The routers only match the canonical spelling, but the guard doesn't rely on that. */
const PRIVATE = /^\/(api|media|data|mcp|oauth|\.well-known)(\/|$)/i;

/**
 * What a signed-out caller may reach: liveness and readiness, review links (their token is the credential), the
 * public API above, the machine endpoints that check credentials themselves, and reads of the app shell and its static
 * files (no data). Everything else needs a signed-in user, so a new route is never public by accident.
 */
export function isPublicPath(method: string, p: string): boolean {
  if (p === '/healthz' || p === '/readyz') return true;
  if (GUEST_PATH.test(p) || PUBLIC_API.test(p) || TICKET_PATH.test(p) || SELF_AUTHENTICATING.test(p)) return true;
  return (method === 'GET' || method === 'HEAD') && !PRIVATE.test(p);
}
const MUTATION = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * A request another site made the browser send (Fetch Metadata): `cross-site`, or `same-site` — this host on another
 * port (a dev server on localhost:3000) is another origin all the same. Absent (an agent, curl, an old browser) or
 * `none` (typed, a bookmark) is not.
 */
const foreignSite = (req: Request): boolean => {
  const site = req.headers['sec-fetch-site'];
  return site === 'cross-site' || site === 'same-site';
};
/** What answers another site on the machine: the public paths (the app's pages and files among them), not /mcp — there
 * the machine's own address is the owner, like everywhere else. */
const openToOtherSites = (method: string, p: string): boolean => p !== '/mcp' && isPublicPath(method, p);
/**
 * Where a sign-in elsewhere sends the person back (publishing's Google sign-in, docs/publishing.md): by nature a
 * navigation from another site. Only that — a top-level page load —, and the route itself still asks who it is and
 * takes only the single-use state the person's own "Connect with Google" made.
 */
export const RETURNS_FROM_ELSEWHERE = new Set(['/api/publish/oauth/callback']);
const returnFromElsewhere = (req: Request): boolean =>
  req.method === 'GET' && RETURNS_FROM_ELSEWHERE.has(req.path) && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
/**
 * Answers no other site may embed or load (renders, frames, posters, screenshots, the API): a page elsewhere can't use
 * them as an <img> or <video>, whoever's cookie or address they would carry. Review links' own are loaded by their own
 * page, from the same origin.
 */
const SAME_ORIGIN_ONLY = /^\/(api|media|data)\//;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The host name a request was made to (the Host header without its port or IPv6 brackets). */
export const requestHost = (req: Request): string =>
  String(req.headers.host || '')
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '');

/** What the app's own media host (VR_MEDIA_ORIGIN, lib/storage/mediaHost.ts) answers: signed files, folder zips, project files. */
export const SIGNED_MEDIA_PATH = /^\/media\/[szf]\/[\w-]+\/[^/]+$/;
/** The media host's name, when one is configured. */
export const mediaHostOf = (mediaOrigin: string | null | undefined): string | null => {
  try {
    return mediaOrigin ? new URL(mediaOrigin).hostname.replace(/^\[|\]$/g, '') : null;
  } catch {
    return null;
  }
};

export interface HeaderOptions {
  publicUrl?: string | null;
  /** Extra origins the player may load video from (a CDN in front of the storage). */
  mediaOrigins?: string[];
  /** Vite dev server: its inline scripts and HMR socket need a looser policy. */
  dev?: boolean;
  /**
   * What a billing module's payment form loads (server/extension.ts contentSecurity, checked there): allowed on the
   * hosted app's own pages, never on review links. One document serves the whole app, so it is that page's policy.
   */
  moduleSources?: ContentSources | null;
}

export interface GuardOptions extends HeaderOptions {
  publicUrl: string | null;
  identify: Identify;
  /**
   * The app runs on the person's own machine: it answers to the machine's names and LAN addresses, a phone that opens
   * the LAN link (`?t=<token>`) gets its cookie, and review links work through the tunnel's host name.
   */
  machine?: { lanToken: string | null } | null;
  /** Further paths reachable signed out (an extension module's public routes: a payment provider's webhook). */
  alsoPublic?: (method: string, path: string) => boolean;
  /**
   * The app's own media host (VR_MEDIA_ORIGIN): another host name of this server that answers its signed media URLs and
   * one-time uploads only — each is its own credential — and nothing else, signed in or not.
   */
  mediaOrigin?: string | null;
}

/**
 * The way to an app's consent screen: /oauth/authorize and the page it sends the person to (`/?consent`). An app may run
 * the sign-in in a popup and hear the answer through window.opener, which `same-origin` would cut for good — browsers
 * apply the policy at every hop of a navigation, the redirect included — and the connection would hang after Allow
 * (A12 WEB-10). Only these two let an opener keep its window; framing stays refused.
 */
export const CONSENT_PAGE = '/?consent';
const ConsentQuery = z.object({ consent: z.string().max(20).optional() });
const consentPage = (req: Request): boolean =>
  req.method === 'GET' && (req.path === '/oauth/authorize' || (req.path === '/' && queryOr(ConsentQuery, req)?.consent !== undefined));

function securityHeaders(req: Request, res: Response, { mediaOrigins = [], dev, publicUrl, moduleSources }: HeaderOptions): void {
  // An Embed link's player is made to sit in a frame on someone else's site, any site (docs/sharing.md): its page alone
  // may be framed. Everything else — the app, the API, the media, every other review page — never is.
  const framed = EMBED_PAGE.test(req.path);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (framed) res.removeHeader('X-Frame-Options');
  else res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', consentPage(req) ? 'unsafe-none' : 'same-origin');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
  // Nothing an instance serves is for search engines: sign-in, invites, review links, the app, its files.
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (publicUrl?.startsWith('https:')) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  if (dev) return;
  const media = ["'self'", 'blob:', ...mediaOrigins].join(' ');
  // a review link's visitors never pay: its pages keep the plain policy
  const extra = moduleSources && !GUEST_PATH.test(req.path) ? moduleSources : null;
  const plus = (list: string[] | undefined) => (list?.length ? ` ${list.join(' ')}` : '');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      `script-src 'self' ${THEME_BOOT_HASH}${plus(extra?.script)}`,
      "style-src 'self' 'unsafe-inline'",
      `img-src 'self' data: blob:${plus(extra?.img)}`,
      `media-src ${media}`,
      `connect-src 'self' ${mediaOrigins.join(' ')}`.trim() + plus(extra?.connect),
      ...(extra?.frame?.length ? [`frame-src 'self'${plus(extra.frame)}`] : []),
      "font-src 'self' data:",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      framed ? 'frame-ancestors *' : "frame-ancestors 'none'",
    ].join('; '),
  );
}

/**
 * The protective headers on every answer, also those given before the guard runs — the health checks, robots.txt and
 * canonicalPaths' 404 — so no answer of the app can be framed or sniffed: server/app.ts mounts this first (A12 WEB-9).
 * The guard sets them again, with what it adds per path.
 */
export function protectiveHeaders(opts: HeaderOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    securityHeaders(req, res, opts);
    next();
  };
}

/**
 * Everything but the public paths (isPublicPath) needs a caller (see createIdentify). Cookie-authenticated writes must
 * come from our own origin (CSRF), and only our own host names are served (DNS rebinding): the public URL's on a hosted
 * server, the machine's names and addresses on a person's own machine.
 */
export function createGuard(opts: GuardOptions) {
  const pub = opts.publicUrl ? new URL(opts.publicUrl) : null;
  const machine = opts.machine ?? null;
  // The machine's LAN addresses can change while it runs (Wi-Fi): asked again at most once a minute.
  let hosts = { at: 0, set: new Set<string>() };
  const machineHost = (host: string) => {
    if (Date.now() - hosts.at > 60_000) hosts = { at: Date.now(), set: machineHosts() };
    return hosts.set.has(host);
  };
  // A hosted server without a public URL (a local test, VR_ALLOW_NO_PUBLIC_URL) serves any host, as before.
  const hostOk = (host: string) => LOOPBACK_HOSTS.has(host) || (pub ? host === pub.hostname : machine ? machineHost(host) : true);
  const hostOf = requestHost;
  const mediaHost = mediaHostOf(opts.mediaOrigin);
  const originOf = (req: Request) => pub?.origin || `${req.protocol}://${req.headers.host}`;

  // Our own origin: the public URL's, or the very host this request was made to (the machine answers to several).
  function ownOrigin(req: Request, origin: string): boolean {
    if (origin === originOf(req)) return true;
    if (!machine) return false;
    try {
      const o = new URL(origin);
      return o.host === req.headers.host && hostOk(o.hostname.replace(/^\[|\]$/g, ''));
    } catch {
      return false;
    }
  }

  function sameOrigin(req: Request): boolean {
    const origin = req.headers.origin;
    if (origin) return ownOrigin(req, origin);
    // Browsers send Origin on every cross-site write; Sec-Fetch-Site tells the rest apart.
    const site = req.headers['sec-fetch-site'];
    return site === 'same-origin' || site === 'none';
  }

  // [status, message] when the request is refused, null when it may pass (identifying the caller on the way).
  function refusal(req: Request, res: Response): [number, string] | null {
    if (req.path === '/healthz') return null;
    // Review links answer on any host the machine is reached by (the tunnel's name changes every time), and so do the
    // upload URLs a link hands its visitors for files (the ticket is the credential) and an embed's oEmbed: nobody is
    // identified there.
    const guest = GUEST_PATH.test(req.path);
    if (!hostOk(hostOf(req))) {
      if (!machine || !(guest || TICKET_PATH.test(req.path) || oEmbedAsked(req))) return [421, 'unknown host'];
      if (!guest) return null;
    }
    if (guest) {
      res.setHeader('Referrer-Policy', 'no-referrer');
      return null;
    }
    // On the machine the owner is signed in by address: any page the owner opens elsewhere could make the owner's GETs —
    // embed renders, frames and posters, probe which videos exist, start ffmpeg work (A12 WEB-4). From another site only
    // the paths that answer anyone do (the app's pages and files, sign-in, OAuth; review links, above, on any host).
    if (machine && foreignSite(req) && !openToOtherSites(req.method, req.path) && !returnFromElsewhere(req) && !opts.alsoPublic?.(req.method, req.path))
      return [403, 'cross-site request'];
    // Foreign pages may not even try to log in or set up (login CSRF), nor drive the machine owner's session.
    if (MUTATION.has(req.method) && req.headers.origin && !ownOrigin(req, req.headers.origin) && !CROSS_ORIGIN_OAUTH.test(req.path)) return [403, 'bad origin'];
    // The LAN link: its token becomes an HttpOnly cookie, so a script on the page never reads the key to the owner.
    if (machine?.lanToken && sameToken(queryOr(LanQuery, req)?.t, machine.lanToken))
      res.append('Set-Cookie', `${LAN_COOKIE}=${machine.lanToken}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
    req.auth = opts.identify(req) ?? undefined;
    // A session in use keeps going: its idle clock restarts (at most twice a day, see lib/auth.ts).
    for (const c of sessionUpdates(req.auth, req.secure || pub?.protocol === 'https:')) res.append('Set-Cookie', c);
    if (isPublicPath(req.method, req.path) || opts.alsoPublic?.(req.method, req.path)) return null;
    if (!req.auth) return [401, 'please sign in'];
    // Writes on a cookie — a session or the LAN link — come from our own pages only.
    if (MUTATION.has(req.method) && (req.auth.via === 'cookie' || req.auth.via === 'lan') && !sameOrigin(req)) return [403, 'bad origin'];
    return null;
  }

  // The media host: its URLs are their own credential and are loaded by the app's pages, another origin (no CORP
  // same-origin); nobody is identified there (the app's cookies are the app host's own), and nothing else answers.
  function mediaRequest(req: Request, res: Response): boolean {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // a project file's URL is also asked about first by the app's pages (a preview's Range: CORS)
    const signed =
      (req.method === 'GET' || req.method === 'HEAD' || (req.method === 'OPTIONS' && req.path.startsWith('/media/f/'))) && SIGNED_MEDIA_PATH.test(req.path);
    if (signed || TICKET_PATH.test(req.path)) return true;
    res.setHeader('Cache-Control', 'no-store');
    res.status(404).json({ error: 'not found' });
    return false;
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    securityHeaders(req, res, opts);
    if (mediaHost && hostOf(req) === mediaHost) {
      if (mediaRequest(req, res)) next();
      return;
    }
    if (SAME_ORIGIN_ONLY.test(req.path)) res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const why = refusal(req, res);
    if (why) res.status(why[0]).json({ error: why[1] });
    else next();
  };
}
