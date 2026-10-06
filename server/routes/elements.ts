// Elements maps (lib/elements.ts): a renderer's agent attaches where each named element of a version is, and agents on
// another machine ask what the video's notes point at (the maps stay on the server; `vr` and MCP read the answer).
import express, { type Router } from 'express';
import { attachElements, pointersOf } from '../../lib/elementMaps.ts';
import { ELEMENT_LIMITS, ElementMapError } from '../../lib/elements.ts';
import type { ServerContext } from '../context.ts';
import { getReview, getVersion } from '../helpers.ts';
import { failFrom, router } from '../http.ts';

export function elementRoutes(_ctx: ServerContext): Router {
  const r = router();

  // The whole map as the body, checked whole (a bad one is refused and nothing of it kept); it replaces the version's.
  r.put('/api/review/:slug/versions/:v/elements', express.json({ limit: ELEMENT_LIMITS.bytes }), (req, res) => {
    const review = getReview(req.params.slug);
    const ver = getVersion(review, req.params.v);
    try {
      res.json(attachElements(review, ver.v, req.body));
    } catch (e) {
      if (e instanceof ElementMapError) throw failFrom(400, e);
      throw e;
    }
  });

  // What each note points at, by id, and the names of those elements: never the maps themselves.
  r.get('/api/review/:slug/elements', (req, res) => {
    const review = getReview(req.params.slug);
    res.json(pointersOf(review, review.comments));
  });

  return r;
}
