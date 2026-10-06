// The status workflow over HTTP: where every video stands (GET /api/status), carrying an approval over to an identical
// render, and marking a video final or reopening it. Approving itself stays PUT /api/review/:slug/approval (the team) and
// POST /api/g/:token/approval (a client). The rules are in docs/workflow.md; the stage comes from lib/stage.ts.

import path from 'node:path';
import express, { type Router } from 'express';
import { z } from 'zod';
import { archivedIn } from '../../lib/archived.ts';
import { archivedNow } from '../../lib/folderIds.ts';
import { slugify } from '../../lib/paths.ts';
import { renderKey } from '../../lib/renderKey.ts';
import { assignedState } from '../../lib/sessions.ts';
import { emptyStageCounts } from '../../lib/stage.ts';
import { approvedOlderVersion, stageForReview } from '../../lib/stageContext.ts';
import * as store from '../../lib/store.ts';
import { compareTime } from '../../lib/time.ts';
import type { StatusFolder, StatusResponse, StatusVideo } from '../../lib/types.ts';
import type { ServerContext } from '../context.ts';
import { getReview, signOffByPerson } from '../helpers.ts';
import { body, fail, failFrom, router } from '../http.ts';

const FinalBody = z.object({
  v: z.number().int().min(1).nullish(),
  note: z.string().max(2000).nullish(),
  /** Mark final although required notes are still open. */
  confirm: z.boolean().optional(),
});
const ReopenBody = z.object({ note: z.string().max(2000).nullish() });
const CarryBody = z.object({ from: z.number().int().min(1).nullish() });

export function statusRoutes(ctx: ServerContext): Router {
  const r = router();
  const changed = (slug: string) => {
    ctx.broadcast('review', { slug });
    ctx.broadcast('library', { slug });
  };

  r.get('/api/status', async (_req, res) => {
    const sessions = await ctx.sessions.get();
    // archived projects are put away (lib/archived.ts): not listed here either
    const shut = archivedNow();
    const videos: StatusVideo[] = store
      .listReviews()
      .filter((review) => !review.archived && !archivedIn(review.folder, shut))
      .map((review) => {
        const latest = review.versions.at(-1);
        const sessionActive = !!assignedState(review.session, sessions).active;
        return {
          slug: slugify(review.video),
          name: path.basename(review.video),
          folder: review.folder || null,
          project: review.project,
          v: latest?.v ?? 1,
          hash: latest ? renderKey(latest) : null,
          width: latest?.width ?? review.width,
          height: latest?.height ?? review.height,
          updated: review.updated || latest?.registered || null,
          stage: stageForReview(review, { sessionActive }),
        };
      })
      .sort((a, b) => compareTime(b.updated, a.updated));
    // One summary line per top-level folder (with everything below it), and one for Unsorted.
    const counts = emptyStageCounts();
    const folders = new Map<string | null, StatusFolder>();
    for (const v of videos) {
      counts[v.stage.stage]++;
      const key = v.folder ? (v.folder.split('/')[0] as string) : null;
      const f = folders.get(key) || { folder: key, counts: emptyStageCounts(), total: 0 };
      f.counts[v.stage.stage]++;
      f.total++;
      folders.set(key, f);
    }
    const out: StatusResponse = {
      videos,
      folders: [...folders.values()].sort((a, b) => (a.folder === null ? 1 : b.folder === null ? -1 : a.folder.localeCompare(b.folder))),
      counts,
    };
    res.json(out);
  });

  // Final = the version that ships. Open required notes need an explicit confirmation (409 tells the UI to ask).
  r.put('/api/review/:slug/final', express.json(), (req, res) => {
    const review = getReview(req.params.slug);
    signOffByPerson(req);
    const b = body(FinalBody, req);
    const v = b.v ?? (review.versions.at(-1)?.v as number);
    const ver = review.versions.find((x) => x.v === v);
    if (!ver) throw fail(404, `no v${v}`);
    // Not even with confirm: a partial render is a quick check, the version that ships is rendered in full.
    if (ver.part) throw fail(409, store.partNotFinal(ver));
    const open = store.counts(review).open;
    if (open && !b.confirm) {
      res
        .status(409)
        .json({ error: `${open} required note${open === 1 ? ' is' : 's are'} still open: confirm to mark v${v} final anyway`, open, needs_confirm: true });
      return;
    }
    // Not even with confirm: the version that ships can't contain a fix that exists only in the project.
    const unrendered = store.fixesOnlyOnPreview(review, v).length;
    if (unrendered)
      throw fail(409, `${unrendered} fix${unrendered === 1 ? ' was' : 'es were'} verified on a preview only: render the next version before marking one final`);
    const after = store.setFinal(req.params.slug, { v, note: b.note }, ctx.actor(req));
    changed(req.params.slug);
    res.json({ final: after.final, stage: stageForReview(after) });
  });

  r.delete('/api/review/:slug/final', express.json(), (req, res) => {
    const review = getReview(req.params.slug);
    signOffByPerson(req);
    if (!review.final) throw fail(409, 'this video is not final');
    const b = body(ReopenBody, req);
    const after = store.reopenFinal(req.params.slug, { note: b.note }, ctx.actor(req));
    changed(req.params.slug);
    res.json({ final: null, stage: stageForReview(after) });
  });

  // An approval moves to a new render only when the version diff calls it identical (same picture, same sound).
  r.post('/api/review/:slug/approval/carry', express.json(), async (req, res) => {
    const review = getReview(req.params.slug);
    signOffByPerson(req);
    const b = body(CarryBody, req);
    const latest = review.versions.at(-1);
    const from = b.from ? review.versions.find((x) => x.v === b.from) : approvedOlderVersion(review);
    if (!latest || !from || from.v >= latest.v) throw fail(409, 'there is no approved older version to carry over');
    let diff: Awaited<ReturnType<typeof ctx.background.compare>>;
    try {
      diff = await ctx.background.compare(review, from.v, latest.v);
    } catch (e) {
      throw failFrom(409, e, `could not compare v${from.v} and v${latest.v}: ${(e as Error).message}`);
    }
    if (!('summary' in diff) || !diff.summary.identical) {
      // summary.changes counts picture ranges only; a render that differs in sound or timing alone must not read "0 changes"
      const n = 'summary' in diff ? diff.summary.changes + diff.summary.audio_changes + diff.summary.retimes : 0;
      throw fail(409, `v${latest.v} is not identical to v${from.v}${n ? ` (${n} change${n === 1 ? '' : 's'})` : ''}: review it instead`);
    }
    const approval = store.carryApproval(req.params.slug, from.v, ctx.actor(req), latest.v);
    changed(req.params.slug);
    res.json({ approval, stage: stageForReview(getReview(req.params.slug)) });
  });

  return r;
}
