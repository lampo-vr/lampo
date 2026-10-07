// Webhooks managed in the UI (Settings → Notifications). Hooks from config.json and LAMPO_WEBHOOK_URL are listed too,
// read-only. Admins only: a webhook sends review content to another service.
import express, { type Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth.ts';
import type { ServerContext } from '../context.ts';
import { body, fail, failFrom, router } from '../http.ts';

const Hook = z.object({
  url: z.string().max(2000).optional(),
  label: z.string().max(200).optional(),
  format: z.enum(['json', 'slack', 'discord']).optional(),
  events: z.array(z.string().max(40)).max(20).optional(),
  /** Empty keeps the current secret, null removes it. */
  secret: z.string().max(200).nullable().optional(),
});

export function webhookRoutes(ctx: ServerContext): Router {
  const r = router();
  const { webhooks } = ctx;
  // Bad URLs and formats are the caller's mistake, not the server's.
  const checked = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      throw failFrom(400, e);
    }
  };

  r.get('/api/admin/webhooks', requireAdmin, (_req, res) => {
    res.json({ webhooks: webhooks.list() });
  });
  // A hosted server sends only to public addresses (lib/webhooks.ts guard): refused when saved, not only when sent.
  const allowedTarget = async (url: string | undefined) => {
    if (url) await webhooks.checkTarget(url).catch((e: Error) => Promise.reject(fail(400, `webhook URL not allowed: ${e.message}`)));
  };
  r.post('/api/admin/webhooks', express.json(), requireAdmin, async (req, res) => {
    const b = body(Hook, req);
    await allowedTarget(b.url);
    res.json(checked(() => webhooks.add({ ...b, secret: b.secret || undefined }, ctx.actor(req))));
  });
  r.patch('/api/admin/webhooks/:id', express.json(), requireAdmin, async (req, res) => {
    const b = body(Hook, req);
    await allowedTarget(b.url);
    res.json(checked(() => webhooks.update(String(req.params.id), b)));
  });
  r.delete('/api/admin/webhooks/:id', requireAdmin, (req, res) => {
    if (!webhooks.remove(String(req.params.id))) throw fail(404, 'only webhooks made in Settings can be removed here');
    res.json({ ok: true });
  });
  r.post('/api/admin/webhooks/:id/test', requireAdmin, async (req, res) => {
    if (!webhooks.list().some((h) => h.id === String(req.params.id))) throw fail(404, 'no such webhook');
    res.json(await webhooks.test(String(req.params.id)));
  });
  return r;
}
