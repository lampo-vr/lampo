// Automatic checks per version: loudness/freezes, the diff against the previous render, the QA pre-review.

import fs from 'node:fs';
import path from 'node:path';
import express, { type Router } from 'express';
import { z } from 'zod';
import { isStretchKey, stretchOf } from '../../lib/findings.ts';
import { cachedAnalysis } from '../../lib/media.ts';
import { cacheDir, reviewDir } from '../../lib/paths.ts';
import { cachedQa } from '../../lib/qa.ts';
import { frameInRange } from '../../lib/range.ts';
import { renderKey } from '../../lib/renderKey.ts';
import { shotsOrLater } from '../../lib/shots.ts';
import * as store from '../../lib/store.ts';
import type { FrameRange } from '../../lib/types.ts';
import type { ServerContext } from '../context.ts';
import { getReview, getVersion, metaOf, sanitizeDrawing, versionBytes } from '../helpers.ts';
import { body, fail, router } from '../http.ts';
import { shotsToFollow } from './review.ts';

const QaKey = z.object({ key: z.string().min(1, 'missing key').max(200) });
const QaAccept = QaKey.extend({ v: z.number().int().nullish() });

// A dismissal names the finding; "That's intended" also keeps where it was (its frames in the version it was dismissed
// on), so the same stretch stays dismissed in later versions (lib/findings.ts dismissedBy). Nothing is logged: the
// agent isn't told.
const dismiss = (slug: string, key: string, stretch?: FrameRange | null) =>
  store.mutate(slug, (r) => {
    r.qa_dismissed = [...new Set([...(r.qa_dismissed || []), key])];
    if (stretch) r.qa_stretches = { ...(r.qa_stretches || {}), [key]: { in: stretch.in, out: stretch.out } };
  });

export function analysisRoutes(ctx: ServerContext): Router {
  const r = router();
  const { broadcast, background } = ctx;

  r.get('/api/analysis/:slug/:v', (req, res) => {
    const review = getReview(req.params.slug);
    const ver = getVersion(review, req.params.v);
    const hit = cachedAnalysis(ver);
    if (hit) return void res.json(hit);
    if (!store.versionAvailable(review, ver.v)) throw fail(410, 'the bytes of this version are gone');
    background.startAnalysis(review, ver.v);
    res.json({ pending: true });
  });

  r.get('/api/diff/:slug/:v', (req, res) => {
    const started = background.startDiff(getReview(req.params.slug), Number(req.params.v));
    res.json('diff' in started && started.diff ? started.diff : started);
  });

  // whoever asks first: the on-screen text is expected in their languages too (prefs.voice_languages)
  const languagesOf = (req: express.Request) => req.auth?.user?.prefs?.voice_languages;

  r.get('/api/qa/:slug/:v', (req, res) => {
    const started = background.startQa(getReview(req.params.slug), Number(req.params.v), languagesOf(req));
    res.json('qa' in started && started.qa ? started.qa : started);
  });

  r.post('/api/qa/:slug/:v/rerun', (req, res) => {
    const review = getReview(req.params.slug);
    const ver = getVersion(review, req.params.v);
    fs.rmSync(path.join(cacheDir(), 'qa', `${renderKey(ver)}.json`), { force: true });
    // Run again tries a check that failed once more
    res.json(background.startQa(review, ver.v, languagesOf(req), true));
  });

  r.post('/api/qa/:slug/dismiss', express.json(), (req, res) => {
    const review = getReview(req.params.slug);
    const { key, v } = body(QaAccept, req);
    // the stretch as Auto-check found it in that version (from its own result, never from the request)
    const ver = v && isStretchKey(key) ? review.versions.find((x) => x.v === v) : undefined;
    const item = ver ? cachedQa(ver)?.items.find((x) => x.key === key) : undefined;
    dismiss(req.params.slug, key, item ? stretchOf(item) : null);
    broadcast('review', { slug: req.params.slug });
    res.json({ ok: true });
  });

  // Accepting a suggestion turns it into a normal note (with its box as the drawing) and hides it from the list.
  r.post('/api/qa/:slug/accept', express.json(), async (req, res) => {
    const slug = req.params.slug;
    const review = getReview(slug);
    const b = body(QaAccept, req);
    const ver = getVersion(review, b.v);
    const item = cachedQa(ver)?.items.find((x) => x.key === b.key);
    if (!item) throw fail(404, 'suggestion not found (re-run the pre-review?)');
    // A finding's range is clipped to the render (it came from the analysis of this very file).
    const range = item.range ? { in: Math.max(0, item.range.in), out: Math.min(ver.frames - 1, item.range.out) } : null;
    const frame = frameInRange(Math.max(0, Math.min(ver.frames - 1, item.frame)), range);
    const drawing = item.box ? sanitizeDrawing([{ type: 'box', ...item.box }], ver) : [];
    const id = store.reservedCommentId();
    const shots = await shotsOrLater({ file: await versionBytes(review, ver), frame, meta: metaOf(review, ver), drawing, dir: reviewDir(slug), id, range });
    const c = store.addComment(slug, {
      id,
      v: ver.v,
      frame,
      range,
      text: item.text + (item.detail ? ` (${item.detail})` : ''),
      tags: item.tags || [],
      severity: item.severity,
      drawing,
      author: ctx.actor(req),
      author_id: req.auth?.user?.id,
      shots,
    });
    dismiss(slug, item.key);
    broadcast('review', { slug });
    broadcast('library', { slug });
    shotsToFollow(ctx, slug, [c]);
    res.json(c);
  });

  return r;
}
