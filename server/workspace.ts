// Which workspace a request works in (lib/scope.ts), decided once the caller is known and carried by everything the
// request starts. A signed-in request works in its caller's workspace (an API token's own, the session's current one,
// the machine's #1); a review link — whoever opens it, signed in or not — works in the link's own workspace; an upload
// ticket in the one it was handed out for (its route says so). Anything else (sign-in, setup, /api/info) runs outside
// any workspace: on a server with several, touching a workspace's data there is refused, never workspace #1's.
import type { NextFunction, Request, Response } from 'express';
import { inWorkspace } from '../lib/scope.ts';
import { linkWorkspace } from '../lib/shares.ts';
import { suspensionOf } from '../lib/workspaces.ts';
import { GUEST_PATH } from './guard.ts';
import { fail } from './http.ts';

/** A review link's data (not its page: that loads, asks /api/g/<token> and shows the link as ended). */
const GUEST_DATA = /^\/(?:api|media|data)\/g\//;

/** The review link a guest path names: /g/<token>, /api/g/<token>/…, /media/g/<token>/…, /data/g/<token>/…. */
const GUEST_TOKEN = /^\/(?:api\/|media\/|data\/)?g\/([^/]+)/;

/** What a session reads: kept by the browser per session (`Vary: Cookie`), never per URL alone (below). */
const SESSION_CONTENT = /^\/(?:api|media|data)\//;

/** Requests a workspace's people and agents may make together per minute on a hosted server: far above a busy team
 * (a 1,000-video library scrolled through is a few thousand), low enough that one team can't crowd out the others. */
export const WORKSPACE_REQUESTS_PER_MINUTE = 20_000;

/** The workspace of a request: the link's for review-link paths, else the caller's; null for nobody's. */
export function requestWorkspace(req: Request): string | null {
  if (GUEST_PATH.test(req.path)) {
    const token = GUEST_TOKEN.exec(req.path)?.[1];
    return token ? linkWorkspace(token) : null;
  }
  return req.auth?.workspace ?? null;
}

/**
 * Runs the rest of the request in its workspace (after the guard has identified the caller). On a hosted server each
 * workspace's signed-in requests also share one budget per minute.
 */
export function workspaceScope({ hosted = false }: { hosted?: boolean } = {}) {
  // A fixed minute per workspace (one counter each, cheap at this volume; the sliding RateLimit keeps every hit).
  const minutes = new Map<string, { start: number; n: number }>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const ws = requestWorkspace(req);
    // Two workspaces can hold the same slug and version number, so the same URL (a waveform, a render's proxy, a frame)
    // is different bytes in each — and much of it is cached as immutable. Kept per session cookie, a browser shared by
    // two people, or a person who switches, never answers one workspace's URL from another's copy.
    if (hosted && req.auth?.via === 'cookie' && SESSION_CONTENT.test(req.path)) res.vary('Cookie');
    if (ws && hosted && req.auth) {
      const now = Date.now();
      let m = minutes.get(ws);
      if (!m || now - m.start >= 60_000) {
        if (minutes.size > 100_000) minutes.clear();
        m = { start: now, n: 0 };
        minutes.set(ws, m);
      }
      if (++m.n > WORKSPACE_REQUESTS_PER_MINUTE) {
        const wait = Math.max(1, Math.ceil((m.start + 60_000 - now) / 1000));
        throw Object.assign(fail(429, 'this workspace is making too many requests right now; try again in a moment'), { retryAfter: wait });
      }
    }
    // A suspended workspace's review links stop (the server's operator took it down, A13 CLOUD-5): every visitor gets
    // what an ended link answers, never why — the page shows "This link has expired" without a date or a name.
    if (ws && GUEST_DATA.test(req.path) && suspensionOf(ws)) throw fail(410, 'This review link isn’t available any more.');
    if (ws) inWorkspace(ws, next);
    else next();
  };
}
