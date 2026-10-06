// The conversion moments' routes (web/src/conversion/moments.ts): what this person put away in the session's workspace
// and what waits for them (GET), putting a moment away until a date and bringing it back (PUT: "Not now" and its Undo,
// kept with the account so it holds on every device), marking a one-time moment shown, and counting what a moment did
// (per week, never who: lib/funnel.ts). A person's own business: the writes are PERSON_ONLY (server/permissions.ts).
import express, { type Request, type Router } from 'express';
import { z } from 'zod';
import * as auth from '../../lib/auth.ts';
import { MOMENT_EVENTS, MOMENT_IDS, recordMoment } from '../../lib/funnel.ts';
import { markSeen, pendingFor } from '../../lib/moments.ts';
import { RateLimit } from '../../lib/rateLimit.ts';
import type { MomentEvent, MomentId, MomentsState } from '../../lib/types.ts';
import type { ServerContext } from '../context.ts';
import { body, fail, parse, router } from '../http.ts';
import { tooMany } from './shares/access.ts';

/** The furthest a moment is put away: "Not now" is 14 days; nothing is put away for good. */
const MAX_HIDE_MS = 90 * 86_400_000;

const Id = z.enum(MOMENT_IDS as [MomentId, ...MomentId[]]);
const OneTime = z.enum(['loop', 'link_open']);
const Hide = z.object({ until: z.iso.datetime({ offset: true }).nullable() }).strict();
const Event = z
  .object({
    e: z.enum(MOMENT_EVENTS as [MomentEvent, ...MomentEvent[]]),
    id: Id,
    where: z
      .string()
      .regex(/^[a-z0-9_-]{1,24}$/)
      .optional(),
  })
  .strict();

export function momentRoutes(_ctx: ServerContext): Router {
  const r = router();
  // a page counts a few moments per visit; more than this a minute is a loop, not a person
  const events = new RateLimit(60, 60_000);

  const person = (req: Request) => {
    const a = req.auth;
    if (!a?.user) throw fail(401, 'please sign in');
    return { user: a.user, workspace: a.workspace };
  };

  r.get('/api/moments', (req, res) => {
    const { user, workspace } = person(req);
    const now = Date.now();
    const mine = auth.getUser(user.id)?.prefs?.moments?.[workspace] ?? {};
    const hidden = Object.fromEntries(Object.entries(mine).filter(([, until]) => !!until && Date.parse(until) > now));
    const out: MomentsState = { hidden, pending: pendingFor(user.id, now) };
    res.setHeader('Cache-Control', 'no-store');
    res.json(out);
  });

  r.put('/api/moments/:id', express.json(), (req, res) => {
    const { user, workspace } = person(req);
    const id = parse(Id, req.params.id, 'moment');
    const { until } = body(Hide, req);
    if (until && (Date.parse(until) <= Date.now() || Date.parse(until) - Date.now() > MAX_HIDE_MS)) throw fail(400, 'put it away for up to 90 days');
    if (!auth.setMomentHidden(user.id, workspace, id, until ? new Date(until).toISOString() : null)) throw fail(404, 'no such account');
    res.json({ ok: true });
  });

  r.post('/api/moments/:id/seen', (req, res) => {
    const { user } = person(req);
    const id = parse(OneTime, req.params.id, 'moment');
    res.json({ ok: markSeen(id, user.id) });
  });

  r.post('/api/moments/event', express.json(), (req, res) => {
    const { user } = person(req);
    if (!events.take(user.id)) throw tooMany('Too many at once.', events.retryAfter(user.id));
    const b = body(Event, req);
    // counted where this server counts (a hosted server with billing), silently not elsewhere: never who
    recordMoment(b.e, b.id, b.where);
    res.json({ ok: true });
  });

  return r;
}
