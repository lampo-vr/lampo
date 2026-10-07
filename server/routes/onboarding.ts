// The first run (lib/onboarding.ts): where the asker stands — the facts found now, each step recorded on the account
// the first time it is seen done —, putting it away and bringing it back, and "Try it with a sample" (lib/sample.ts).
// A step never ticks because someone clicked it: only what is in the store, the agent registry, the links and invites.
import fs from 'node:fs';
import express, { type Request, type Router } from 'express';
import { z } from 'zod';
import { agentsFound } from '../../lib/agentsFound.ts';
import * as auth from '../../lib/auth.ts';
import { archivedNow } from '../../lib/folderIds.ts';
import { allFolders } from '../../lib/folders.ts';
import { needJobRoom } from '../../lib/jobs.ts';
import { listApps } from '../../lib/oauth/store.ts';
import { type OnboardingFacts, recordFacts, stateOf, stepsFor } from '../../lib/onboarding.ts';
import { CACHE, DATA, DEV, HOME, isoLocal, ROOT, slugify, VERSIONS } from '../../lib/paths.ts';
import { can } from '../../lib/permissions.ts';
import { RateLimit } from '../../lib/rateLimit.ts';
import { findRenderFolders } from '../../lib/renderFolders.ts';
import { createSampleOnce, findSample, sampleInMaking } from '../../lib/sample.ts';
import { currentWorkspace } from '../../lib/scope.ts';
import { isSetupAgent, SETUP_AGENTS } from '../../lib/setupFlow.ts';
import { madeALink, revokeVideoLinks } from '../../lib/shares.ts';
import * as store from '../../lib/store.ts';
import { compareTime, isAgent } from '../../lib/time.ts';
import type { Comment, OnboardingAgentsFound, OnboardingFolders, OnboardingPrefs, OnboardingResponse, Review, Role, SetupAgent } from '../../lib/types.ts';
import { getWorkspace, roleIn, workspaceNamed } from '../../lib/workspaces.ts';
import type { ServerContext } from '../context.ts';
import { countStep } from '../funnel.ts';
import { body, fail, router } from '../http.ts';

// The card put away / brought back, everything hidden for good / brought back, the setup over (finished or skipped), the
// agent picked in it: at least one of them.
const Update = z
  .object({
    hidden: z.boolean().optional(),
    dismissed: z.boolean().optional(),
    setup: z.literal('done').optional(),
    agent: z.enum(SETUP_AGENTS as [SetupAgent, ...SetupAgent[]]).optional(),
  })
  .strict()
  .refine((b) => b.hidden !== undefined || b.dismissed !== undefined || b.setup !== undefined || b.agent !== undefined, 'nothing to change');
const NewSample = z.object({ lang: z.enum(['en', 'de']).optional() }).strict();

type Person = { id: string; name: string };

/**
 * What the person did, from real state, in the workspace this request works in (lib/scope.ts): its videos, links,
 * invites, agents, tokens and apps — never another workspace's. A note counts by account (a sample's own notes were
 * written by its made-up teammate and agent, never by the person); replies and verdicts record names, which are unique
 * in a workspace.
 */
export function factsFor(ctx: ServerContext, req: Request, user: Person): OnboardingFacts {
  const machine = req.auth?.via === 'local';
  const ws = currentWorkspace();
  const reviews = store.listReviews();
  const mine = (r: Review, c: Comment) => (c.author_id ? c.author_id === user.id : !r.onboarding_sample && c.author === user.name);
  const said = (by: string | undefined) => by === user.name;
  const sample = reviews.find((r) => r.onboarding_sample);
  return {
    // the sample's loop closed by them: its fix checked (Looks right, or Still wrong with a reason), or its agent's
    // question answered (by account where a reply says whose, else by name — names are unique in a workspace)
    sample: !!sample && sample.comments.some((c) => (c.replies ?? []).some((x) => sampleReplyBy(x, user, c))),
    // a name a person chose (a sign-up's workspace starts with a placeholder: theirs)
    workspace: workspaceNamed(ws),
    // a project of their own: a top-level folder that isn't archived, and not only the sample's
    project: hasProject(reviews),
    video: reviews.some((r) => !r.onboarding_sample && !r.archived),
    // a video an agent is on: put up by the agent itself (its V1 is its own: lib/store.ts) or handed to one
    agent_video: reviews.some(
      (r) => !r.onboarding_sample && !r.archived && r.versions.length > 0 && (!!r.session || r.versions.some((v) => !!v.run || isAgent(v.by))),
    ),
    note: reviews.some((r) => r.comments.some((c) => mine(r, c))),
    agent: agentConnected(ctx, user, machine, ws),
    share: madeALink(user),
    invite: auth.hasInvited(user.id, ws),
    // a fix checked: Looks right, or Still wrong (the note goes back open with their reason)
    check: reviews.some((r) => r.comments.some((c) => c.replies?.some((x) => (x.status === 'verified' || x.status === 'open') && said(x.by)))),
    approve: reviews.some((r) => (r.approvals ?? []).some((a) => a.party === 'team' && said(a.by)) || said(r.approval?.by)),
  };
}

/** A project of the workspace's own: a top-level folder, not archived, holding more than the first run's sample. */
function hasProject(reviews: Review[]): boolean {
  const archived = archivedNow();
  const sampleOnly = new Set(reviews.filter((r) => r.onboarding_sample && r.folder).map((r) => (r.folder as string).split('/')[0]));
  for (const r of reviews) if (!r.onboarding_sample && r.folder) sampleOnly.delete(r.folder.split('/')[0] as string);
  return allFolders(reviews).some((f) => !f.includes('/') && !Object.hasOwn(archived, f) && !sampleOnly.has(f));
}

/** A reply on the sample that closes its loop for this person: a check of its fix, or an answer to its question. */
function sampleReplyBy(x: NonNullable<Comment['replies']>[number], user: Person, c: Comment): boolean {
  const theirs = x.by_id ? x.by_id === user.id : x.by === user.name;
  if (!theirs) return false;
  return x.status === 'verified' || x.status === 'open' || !!x.answer || c.kind === 'question';
}

/**
 * An agent talked to Lampo for this person: one is connected now (over /mcp or `lampo watch`; at the machine every local
 * agent is the owner's), or one of their API tokens or connected apps was used, or — at the machine — the live
 * monitor saw an agent at work (stdio MCP and `lampo` record there without connecting).
 */
function agentConnected(ctx: ServerContext, user: Person, machine: boolean, ws: string): boolean {
  // the agent registry lists this workspace's agents only (server/agents.ts)
  if (ctx.agents.list().some((a) => (a.user ? a.user === user.name : machine))) return true;
  if (auth.listTokens(user.id).some((t) => !!t.last_used && auth.tokenWorkspace(t) === ws)) return true;
  if (listApps(user.id, ws).some((a) => !!a.last_used)) return true;
  return machine && ctx.activity.live().length > 0;
}

/** The asker's steps: by their role in this workspace, whether it was made at their sign-up, and the agent they picked. */
const stepsOf = (req: Request, o: OnboardingPrefs | null) => {
  const role = (req.auth?.role ?? 'reviewer') as Role;
  const ws = getWorkspace(currentWorkspace());
  return stepsFor(role, { machine: req.auth?.via === 'local', signupWorkspace: !!ws?.signup, personas: ws?.personas, agent: o?.agent });
};

const named = (r: Review) => ({ slug: slugify(r.video), name: r.video.split('/').pop() || r.video });

/** The sample as Get started opens it: its fixed note while that waits for a check, and the agent's question. */
const sampleOf = (r: Review) => ({
  ...named(r),
  check: r.comments.find((c) => c.status === 'fixed')?.id ?? null,
  question: r.comments.find((c) => c.kind === 'question')?.id ?? null,
});

/** Who invited the account into the workspace it works in, as they are now (null when not invited here, or gone). */
function invitedBy(userId: string, ws: string): OnboardingResponse['invited_by'] {
  const hit = auth.invitedInto(userId, ws);
  if (!hit) return null;
  const role = roleIn(ws, hit.by);
  if (!role) return null;
  return { name: auth.getUser(hit.by)?.name || hit.byName, role };
}

/** The newest video that isn't the sample (else the sample): where "Leave a note" and "Share a review link" go. */
function newestVideo(): Review | undefined {
  const live = store.listReviews().filter((r) => !r.archived && r.versions.length);
  const real = live.filter((r) => !r.onboarding_sample).sort((a, b) => compareTime(b.added, a.added));
  return real[0] ?? live.find((r) => r.onboarding_sample);
}

export function onboardingRoutes(ctx: ServerContext): Router {
  const r = router();

  const answer = (req: Request, o: OnboardingPrefs | null): OnboardingResponse => {
    const user = req.auth?.user;
    const steps = user && o ? stepsOf(req, o) : [];
    const sample = findSample();
    const video = newestVideo();
    return {
      onboarding: o,
      steps: stateOf(o, steps),
      sample: sample ? sampleOf(sample) : null,
      video: video ? named(video) : null,
      can_sample: !!user && !!req.auth && can(req.auth.role, 'upload'),
      plan: o?.plan ?? null,
      invited_by: user ? invitedBy(user.id, currentWorkspace()) : null,
    };
  };

  r.get('/api/onboarding', (req, res) => {
    const user = req.auth?.user;
    let o = user ? (auth.getUser(user.id)?.prefs?.onboarding ?? null) : null;
    // what was done since the last look is recorded now (once; a finished first run is left alone)
    if (user && o && !o.complete) {
      const steps = stepsOf(req, o);
      const facts = factsFor(ctx, req, user);
      const now = isoLocal();
      o = auth.updateOnboarding(user.id, (cur) => recordFacts(cur, steps, facts, now))?.prefs?.onboarding ?? o;
    }
    res.json(answer(req, o));
  });

  // The card put away (its ×) or brought back (the account menu's "Get started"); hidden for good, the sidebar's row too
  // ("Hide for good"), or brought back; the setup over (Welcome and its steps, finished or skipped: it doesn't show
  // again); the agent picked in it (Get started and the sample name it). Accounts from before the first run have none.
  r.put('/api/onboarding', express.json(), (req, res) => {
    const user = req.auth?.user;
    if (!user) throw fail(401, 'please sign in');
    const { hidden, dismissed, setup, agent } = body(Update, req);
    const now = isoLocal();
    const u = auth.updateOnboarding(user.id, (o) => {
      let next = o;
      if (hidden === true && !next.hidden) next = { ...next, hidden: now };
      if (hidden === false && next.hidden) {
        const { hidden: _, ...rest } = next;
        next = rest;
      }
      if (dismissed === true && !next.dismissed) next = { ...next, dismissed: now };
      if (dismissed === false && next.dismissed) {
        const { dismissed: _, ...rest } = next;
        next = rest;
      }
      if (setup === 'done' && !next.setup_done) next = { ...next, setup_done: now };
      if (agent && isSetupAgent(agent) && next.agent !== agent) next = { ...next, agent };
      return next;
    });
    const o = u?.prefs?.onboarding ?? null;
    if (!o) throw fail(404, 'this account has no first run');
    // the funnel's "setup done" (finished or skipped), once per workspace (lib/funnel.ts)
    if (setup === 'done') countStep(ctx, 'setup_done');
    res.json(answer(req, o));
  });

  // Folders on this machine that hold videos (the local setup's "Where do your renders land?"): the machine's owner at
  // the machine only — anyone else, a phone with the LAN link or a hosted server, is answered as if there were no such
  // page (a path on this disk is nobody else's business). Linking one stays POST /api/library.
  r.get('/api/onboarding/folders', (req, res) => {
    if (!ctx.capabilities.linkFiles || req.auth?.via !== 'local') throw fail(404, 'not found');
    const skip = [ROOT, DATA, VERSIONS, CACHE].map((p) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return p;
      }
    });
    const out: OnboardingFolders = findRenderFolders({ home: HOME, root: DEV, skip });
    res.set('Cache-Control', 'no-store').json(out);
  });

  // The agents installed on this machine (the local setup's tiles say "Found"): looked for, never run; the machine's owner
  // at the machine only, like the folders.
  r.get('/api/onboarding/agents', (req, res) => {
    if (!ctx.capabilities.linkFiles || req.auth?.via !== 'local') throw fail(404, 'not found');
    const out: OnboardingAgentsFound = agentsFound();
    res.set('Cache-Control', 'no-store').json(out);
  });

  // Making the sample copies two renders through storage and runs ffprobe and ffmpeg; removing it deletes them again.
  // A person tries it once or twice: a few of each per workspace in ten minutes, and a loop (an agent's token can upload)
  // runs out (ONB-3). Only what does something counts: handing back the sample that is there, or removing none, is free.
  const sampleMakes = new RateLimit(5, 10 * 60_000);
  const sampleRemovals = new RateLimit(5, 10 * 60_000);
  const turn = (limit: RateLimit, what: string) => {
    const ws = currentWorkspace();
    const wait = limit.retryAfter(ws);
    if (wait) throw Object.assign(fail(429, `the sample was ${what} often just now: try again in ${Math.ceil(wait / 60)} min`), { retryAfter: wait });
    limit.hit(ws);
  };

  // "Try it with a sample": made once per store (a second ask gets the one there is), in the asker's language.
  r.post('/api/onboarding/sample', express.json(), async (req, res) => {
    const { lang } = body(NewSample, req);
    if (!findSample() && !sampleInMaking()) {
      // its making is work like any other job: never started past a full queue (a hosted server's), never too often
      needJobRoom();
      turn(sampleMakes, 'made');
    }
    // asks while it is being made share that making: only the one that started it made it (ONB-4)
    const { review, made } = await ctx.inflight.track(createSampleOnce({ by: ctx.actor(req), byId: req.auth?.user?.id, lang }));
    const slug = slugify(review.video);
    if (made) {
      ctx.background.warm(review);
      ctx.broadcast('library', { slug });
    }
    res.json({ ...named(review), created: made });
  });

  // One click: the sample and everything on it are gone for good (it is never archived).
  r.delete('/api/onboarding/sample', (_req, res) => {
    const sample = findSample();
    if (!sample) return void res.json({ ok: true, removed: null });
    turn(sampleRemovals, 'removed');
    const slug = slugify(sample.video);
    store.removeSample(slug);
    revokeVideoLinks(sample);
    ctx.broadcast('library', { slug });
    ctx.broadcast('review', { slug });
    res.json({ ok: true, removed: slug });
  });

  return r;
}
