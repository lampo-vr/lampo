// What the phone needs: "For you" (everything waiting for this person) and push notifications per device.
// Locally the person is the machine's reviewer; on a server it is the signed-in account.
import express, { type Request, type Router } from 'express';
import { z } from 'zod';
import { dismiss, type ForYouViewer, forYou, SNOOZE_MAX, snooze, unsnooze, viewerFor } from '../../lib/foryou.ts';
import { countSubs, findSub, subscribe, unsubscribe, updatePrefs, vapidKeys } from '../../lib/push/index.ts';
import { assignedState } from '../../lib/sessions.ts';
import { stageForReview } from '../../lib/stageContext.ts';
import type { PushState, Review } from '../../lib/types.ts';
import { stillSignedIn } from '../auth.ts';
import type { ServerContext } from '../context.ts';
import { body, fail, failFrom, query, router } from '../http.ts';

const Endpoint = z.string().url().max(2000);
const Prefs = z
  .object({
    questions: z.boolean(),
    fixes: z.boolean(),
    versions: z.boolean(),
    clients: z.boolean(),
    answers: z.boolean(),
    posts: z.boolean(),
    agents: z.boolean(),
    quiet: z.boolean(),
  })
  .partial();
const Subscribe = z.object({
  subscription: z.object({ endpoint: Endpoint, keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) }),
  name: z.string().max(60).optional(),
  prefs: Prefs.optional(),
});
const ForEndpoint = z.object({ endpoint: Endpoint });
const EndpointQuery = z.object({ endpoint: Endpoint.optional() });
const PrefsPatch = ForEndpoint.extend({ prefs: Prefs });
const Dismiss = z.object({ keys: z.array(z.string().max(200)).min(1).max(500) });
// "Later": until a time the browser picks in the person's own day (tomorrow 9:00), or until the video moves
const Snooze = Dismiss.extend({ until: z.string().max(40) });
const ForYouQuery = z.object({ limit: z.coerce.number().int().min(0).max(10000).optional() });

/** The person behind a request, as "For you" and push know them (lib/foryou.ts viewerFor). */
export function viewerOf(ctx: ServerContext, req: Request): ForYouViewer {
  if (!req.auth) throw fail(401, 'please sign in');
  // with the role in the workspace the request works in (an account's own `role` is workspace #1's)
  return viewerFor(req.auth.user ? { ...req.auth.user, role: req.auth.role } : null, ctx.cfg.user);
}

export function phoneRoutes(ctx: ServerContext): Router {
  const r = router();
  // The machine owner's devices are stored as the machine's (no account id), like before the machine had accounts.
  const userOf = (req: Request) => (req.auth?.user && !req.auth.user.local ? req.auth.user.id : null);
  const state = (req: Request, endpoint: string | null): PushState => {
    const hit = endpoint ? findSub(endpoint, userOf(req)) : null;
    return {
      publicKey: vapidKeys().publicKey,
      subscription: hit ? { id: hit.id, name: hit.sub.name, prefs: hit.sub.prefs, created: hit.sub.created, last_ok: hit.sub.last_ok } : null,
      devices: countSubs(userOf(req)),
    };
  };

  // Stages as the library sees them (review links, running sessions): a stalled video waits on the client only once
  // someone opened its link, on the agent that is running.
  const stageFor = async () => {
    const sessions = await ctx.sessions.get();
    return (review: Review) => stageForReview(review, { sessionActive: !!assignedState(review.session, sessions).active });
  };

  r.get('/api/for-you', async (req, res) => {
    res.json(forYou(viewerOf(ctx, req), { server: true, limit: query(ForYouQuery, req).limit, stageFor: await stageFor() }));
  });

  r.post('/api/for-you/dismiss', express.json(), async (req, res) => {
    dismiss(viewerOf(ctx, req).key, body(Dismiss, req).keys);
    ctx.broadcast('for-you');
    res.json(forYou(viewerOf(ctx, req), { server: true, limit: query(ForYouQuery, req).limit, stageFor: await stageFor() }));
  });

  r.post('/api/for-you/snooze', express.json(), async (req, res) => {
    const b = body(Snooze, req);
    const until = Date.parse(b.until);
    const now = Date.now();
    if (!Number.isFinite(until) || until <= now || until - now > SNOOZE_MAX) throw fail(400, 'until must be a time in the next 30 days');
    const viewer = viewerOf(ctx, req);
    const opts = { server: true, stageFor: await stageFor() };
    snooze(viewer, b.keys, new Date(until).toISOString(), opts);
    ctx.broadcast('for-you');
    res.json(forYou(viewer, { ...opts, limit: query(ForYouQuery, req).limit }));
  });

  r.post('/api/for-you/unsnooze', express.json(), async (req, res) => {
    const viewer = viewerOf(ctx, req);
    unsnooze(viewer, body(Dismiss, req).keys);
    ctx.broadcast('for-you');
    res.json(forYou(viewer, { server: true, limit: query(ForYouQuery, req).limit, stageFor: await stageFor() }));
  });

  r.get('/api/push', (req, res) => {
    const endpoint = query(EndpointQuery, req).endpoint ?? null;
    res.json(state(req, endpoint));
  });

  r.post('/api/push/subscribe', express.json(), (req, res) => {
    const b = body(Subscribe, req);
    // A device is a lasting way out (what a reset and "sign out everywhere" end): never one for a session that ended
    // while its request came in.
    stillSignedIn(req);
    try {
      subscribe({ endpoint: b.subscription.endpoint, keys: b.subscription.keys, user: userOf(req), name: b.name, prefs: b.prefs }, ctx.pushHosts);
    } catch (e) {
      throw failFrom(400, e);
    }
    res.json(state(req, b.subscription.endpoint));
  });

  r.patch('/api/push/prefs', express.json(), (req, res) => {
    const b = body(PrefsPatch, req);
    if (!updatePrefs(b.endpoint, userOf(req), b.prefs)) throw fail(404, 'this device is not subscribed');
    res.json(state(req, b.endpoint));
  });

  r.post('/api/push/unsubscribe', express.json(), (req, res) => {
    const b = body(ForEndpoint, req);
    unsubscribe(b.endpoint, userOf(req));
    res.json(state(req, null));
  });

  r.post('/api/push/test', express.json(), async (req, res) => {
    const b = body(ForEndpoint, req);
    let sent: boolean;
    try {
      sent = await ctx.push.test(b.endpoint, userOf(req));
    } catch (e) {
      throw failFrom(404, e);
    }
    if (!sent) throw fail(502, 'the push service did not accept the notification');
    res.json({ ok: true });
  });

  return r;
}
