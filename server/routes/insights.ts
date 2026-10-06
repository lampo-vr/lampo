// Looking back across reviews: analytics, who watched what, and the reviewer's taste for a project.
import express, { type Router } from 'express';
import { z } from 'zod';
import { insights } from '../../lib/insights.ts';
import { watchingOf } from '../../lib/insightsWatch.ts';
import { slugify } from '../../lib/paths.ts';
import { layersFor, loadPlaybook } from '../../lib/playbooks.ts';
import { RateLimit } from '../../lib/rateLimit.ts';
import { assignedState } from '../../lib/sessions.ts';
import { linksWithStats } from '../../lib/shares.ts';
import { stageForReview } from '../../lib/stageContext.ts';
import * as store from '../../lib/store.ts';
import { buildTaste, scopeForVideo } from '../../lib/taste.ts';
import { audienceOf, recordTeamWatch } from '../../lib/views.ts';
import { MAX_PLAYS_PER_REPORT, PARTS, SEEN_PATTERN } from '../../lib/watch.ts';
import type { ServerContext } from '../context.ts';
import { getReview } from '../helpers.ts';
import { body, fail, query, router } from '../http.ts';

const TasteQuery = z.object({ video: z.string().optional(), folder: z.string().max(store.FOLDER_LIMITS.length).optional(), project: z.string().optional() });
// tz: the viewer's Date.getTimezoneOffset() (minutes; UTC−14 … UTC+14), so the sparkline's buckets are their days
const InsightsQuery = z.object({ period: z.enum(['7d', '30d', '90d', 'all']).optional(), tz: z.coerce.number().int().min(-840).max(840).optional() });
/** What the owner's player reports while it plays (web/src/lib/watchReport.ts), like a review link's guest player. */
const Watch = z
  .object({
    v: z.number().int().positive(),
    seen: z.string().regex(SEEN_PATTERN),
    plays: z.array(z.number().int().min(0).max(MAX_PLAYS_PER_REPORT)).length(PARTS).optional(),
    secs: z.number().min(0).max(3600),
  })
  .strict();
const AudienceQuery = z.object({ v: z.coerce.number().int().positive().optional() });

export function insightRoutes(ctx: ServerContext): Router {
  const r = router();

  // Stages as the library and the board see them (review links, running sessions), so `attention` agrees.
  r.get('/api/insights', async (req, res) => {
    const q = query(InsightsQuery, req);
    const sessions = await ctx.sessions.get();
    // the first run's sample is a playground, not work: it never shows in Insights
    const reviews = store.listReviews().filter((r) => !r.onboarding_sample);
    const links = linksWithStats();
    const live = reviews.filter((r) => !r.archived);
    res.json(
      insights(reviews, {
        period: q.period,
        tz: q.tz,
        stageFor: (review) => stageForReview(review, { sessionActive: !!assignedState(review.session, sessions).active }),
        links,
        // the asker's own viewing reads "You" (the key the owner's player records it by: the account, else "owner")
        watching: (from, to) => watchingOf(live, from, to, links, Date.now(), req.auth && req.auth.via !== 'token' ? req.auth.user?.id || 'owner' : null),
        rulesFor: (scope) => [...layersFor(scope).map((x) => x.rules), loadPlaybook(scope).rules].join('\n'),
        // an agent's mark: a session listed without a kind is a Claude Code session (lists from before kinds)
        connected: new Map(sessions.flatMap((s) => (s.name ? [[s.name, s.agent ?? 'claude-code'] as const] : []))),
      }),
    );
  });

  // The team's own watching: a person's player reports every 15 s while it plays. Agents (API tokens) don't watch;
  // a report is small, validated, and one person can't send more than a few a minute per video.
  const reports = new RateLimit(12, 60_000);
  r.post('/api/review/:slug/watch', express.json({ limit: '4kb' }), (req, res) => {
    const b = body(Watch, req);
    const review = getReview(req.params.slug as string);
    const auth = req.auth;
    if (!auth || auth.via === 'token') {
      res.status(204).end();
      return;
    }
    if (!review.versions.some((x) => x.v === b.v)) throw fail(404, 'unknown version');
    const id = auth.user?.id || 'owner';
    const slug = slugify(review.video);
    const k = `${id}|${slug}`;
    if (!reports.take(k)) throw Object.assign(fail(429, 'Too many reports.'), { retryAfter: reports.retryAfter(k) });
    recordTeamWatch(slug, { id, name: auth.name }, b);
    res.status(204).end();
  });

  // Who watched a video and how: the viewers chip, the band on the timeline and its list in the player.
  r.get('/api/review/:slug/audience', (req, res) => {
    const q = query(AudienceQuery, req);
    res.json(audienceOf(getReview(req.params.slug as string), q.v));
  });

  r.get('/api/taste', (req, res) => {
    const q = query(TasteQuery, req);
    const scope = q.video ? scopeForVideo(getReview(q.video).video) : q.project ? { project: q.project } : { folder: q.folder || '' };
    const t = buildTaste(store.listReviews(), scope);
    res.json({ scope: t.scope, markdown: t.markdown, stats: t.stats });
  });

  return r;
}
