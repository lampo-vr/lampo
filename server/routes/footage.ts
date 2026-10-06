// Footage search over HTTP (docs/footage.md): what `vr footage` and find_footage ask a hosted server. The shots of the
// workspace's own index only (its cache, lib/footage/db.ts); a render's path on this disk only for the machine itself.
import express from 'express';
import { z } from 'zod';
import { footageOffEverywhere } from '../../lib/footage/settings.ts';
import { MOTION_WORDS } from '../../lib/footage/types.ts';
import type { ServerContext } from '../context.ts';
import { body, fail, failFrom, query, router, sendInternal } from '../http.ts';

const blank = (x: unknown) => (x === '' ? undefined : x);
const FindQuery = z.object({
  q: z.string().max(500).default(''),
  aspect: z.preprocess(blank, z.enum(['16:9', '9:16', '1:1']).optional()),
  min_s: z.preprocess(blank, z.coerce.number().min(0).max(86400).optional()),
  max_s: z.preprocess(blank, z.coerce.number().min(0).max(86400).optional()),
  motion: z.preprocess(blank, z.enum(MOTION_WORDS).optional()),
  text: z.preprocess(blank, z.string().max(200).optional()),
  said: z.preprocess(blank, z.string().max(200).optional()),
  limit: z.preprocess(blank, z.coerce.number().int().min(1).max(50).optional()),
});
const SheetQuery = z.object({ ids: z.string().max(200) });
const Switch = z.object({ on: z.boolean(), by: z.string().max(200).optional() });

export function footageRoutes(ctx: ServerContext) {
  const r = router();
  const service = () => import('../../lib/footage/service.ts');

  r.get('/api/footage/find', async (req, res) => {
    const q = query(FindQuery, req);
    const { find } = await service();
    const answer = await find(
      {
        query: q.q,
        ...(q.aspect ? { aspect: q.aspect } : {}),
        ...(q.min_s !== undefined ? { min_s: q.min_s } : {}),
        ...(q.max_s !== undefined ? { max_s: q.max_s } : {}),
        ...(q.motion ? { motion: q.motion } : {}),
        ...(q.text ? { text: q.text } : {}),
        ...(q.said ? { said: q.said } : {}),
        ...(q.limit ? { limit: q.limit } : {}),
      },
      // paths on this disk are the machine's own business
      { local: req.auth?.via === 'local' },
    );
    res.json(answer);
  });

  r.get('/api/footage/sheet', async (req, res) => {
    const ids = query(SheetQuery, req)
      .ids.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!ids.length || ids.length > 9 || ids.some((id) => !/^s\d{1,12}$/.test(id))) throw fail(400, 'ids: one to nine shot ids like s412, comma-separated');
    const { sheet } = await service();
    let file: string;
    try {
      file = (await sheet(ids)).file;
    } catch (e) {
      throw failFrom(404, e);
    }
    res.type('image/jpeg').setHeader('Cache-Control', 'private, no-store');
    sendInternal(res, file);
  });

  r.get('/api/footage/status', async (_req, res) => {
    res.json((await service()).status());
  });

  // On or off for the workspace (owners and admins: it costs the server's CPU, permissions.ts). Turned on, every video
  // is queued; turned off, nothing new is indexed and searches answer that it is off (the index is kept).
  r.put('/api/footage/settings', express.json(), async (req, res) => {
    const { on } = body(Switch, req);
    if (on && footageOffEverywhere()) throw fail(409, 'footage search is off on this server (footage: "off" in its config)');
    const s = (await service()).setOn(on, ctx.actor(req));
    if (on) ctx.background.footage.queueAll();
    res.json(s);
  });

  return r;
}
