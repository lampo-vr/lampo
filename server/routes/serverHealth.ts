// The server setup's health check (web/src/onboarding/): what a team on this server will need — the public address,
// storage, mail and the speech engine — checked now, and a test mail to the asker. For whoever runs a hosted server
// (lib/operator.ts: LAMPO_OPERATOR, else the owners of its first workspace), signed in as themselves (PERSON_ONLY); on a
// person's own machine, its owner. Anyone else — the owner of any other workspace (every open sign-up has one), an owner
// or admin invited into the first — is a customer, not the operator: they get 404, as if there were no such page, since
// the answer describes the operator's machine (its disk, relay, speech model). Nothing secret leaves: the relay by host
// and port, buckets by name, never a key or a password.
import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Router } from 'express';
import { z } from 'zod';
import { senderOf } from '../../lib/mail/config.ts';
import { undeliverable } from '../../lib/mail/index.ts';
import { relayOf, sendTestMail } from '../../lib/mail/testMail.ts';
import { isOperator } from '../../lib/operator.ts';
import { dataDir, versionsDir } from '../../lib/paths.ts';
import { can } from '../../lib/permissions.ts';
import { RateLimit } from '../../lib/rateLimit.ts';
import { DEFAULT_WORKSPACE } from '../../lib/scope.ts';
import { storage } from '../../lib/storage/index.ts';
import { publicSttStatus, sttStatus } from '../../lib/stt/index.ts';
import type { MailTestResult, ServerHealth } from '../../lib/types.ts';
import { mailHost, type ServerContext } from '../context.ts';
import { body, fail, router } from '../http.ts';
import { freeBytes } from '../ready.ts';

const MailTest = z.object({ lang: z.enum(['en', 'de']).optional() }).strict();

/** Review links and emails point at the public address: fine when it is https, or plain http on this machine. */
function publicUrlOk(url: string | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  } catch {
    return false;
  }
}

export function serverHealthRoutes(ctx: ServerContext): Router {
  const r = router();
  // A test mail is a real message through the relay: a few in ten minutes per person is plenty for "I've set it".
  const tests = new RateLimit(3, 10 * 60_000);

  /** The operator: whoever runs a hosted server (lib/operator.ts); on the machine, its owner or an admin there. */
  const operator = (req: Request) => {
    const a = req.auth;
    if (!a?.user) throw fail(401, 'please sign in');
    const runs = ctx.hosted ? isOperator(ctx.cfg, a.user.id) : a.workspace === DEFAULT_WORKSPACE && can(a.role, 'admin');
    if (!runs) throw fail(404, 'not found');
    return a.user;
  };

  /**
   * Where renders are stored, written to and read back now (a remote store: its own check). A path on this disk is the
   * machine's own business (`via === 'local'`): everyone else — a phone through the LAN link, a hosted server's admins —
   * reads the kind, the free space and a bucket's or zone's name, never the folder (ONB-1).
   */
  async function checkStorage(atMachine: boolean): Promise<ServerHealth['storage']> {
    const s = storage();
    const kind = s.kind;
    const conf = ctx.cfg.storage;
    if (kind !== 'local') {
      const where = kind === 's3' ? (conf.s3?.bucket ?? null) : (conf.bunny?.zone ?? null);
      try {
        await s.check();
        return { ok: true, kind, writable: true, free_bytes: null, where };
      } catch {
        return { ok: false, kind, writable: false, free_bytes: null, where };
      }
    }
    const dir = versionsDir();
    let writable = false;
    const probe = path.join(dir, `.health-${process.pid}-${Date.now()}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(probe, 'ok');
      writable = fs.readFileSync(probe, 'utf8') === 'ok';
    } catch {
      writable = false;
    } finally {
      fs.rmSync(probe, { force: true });
    }
    return { ok: writable, kind, writable, free_bytes: freeBytes(dir), where: atMachine ? dataDir() : null };
  }

  r.get('/api/server/health', async (req, res) => {
    operator(req);
    const { cfg } = ctx;
    const stt = publicSttStatus(sttStatus(cfg.stt));
    const out: ServerHealth = {
      public_url: { ok: publicUrlOk(cfg.public_url), url: cfg.public_url },
      storage: await checkStorage(req.auth?.via === 'local'),
      mail: {
        ok: cfg.mail.transport === 'smtp' && !!cfg.mail.smtp_url,
        transport: ctx.mail.transport,
        from: senderOf(cfg.mail, mailHost(cfg)).address,
        relay: relayOf(cfg.mail),
      },
      stt: {
        ok: stt.available && stt.state !== 'error' && !stt.error,
        state: stt.state,
        model: stt.model,
        device: stt.device,
        progress: stt.progress,
      },
    };
    res.set('Cache-Control', 'no-store').json(out);
  });

  // One test mail to the asker's own confirmed address, sent now through the server's mail settings (the log transport
  // writes it to the outbox): "I've set it, check again" in the setup, `lampo admin mail-test` in a terminal.
  r.post('/api/server/mail-test', express.json(), async (req, res) => {
    const user = operator(req);
    const { lang } = body(MailTest, req);
    if (user.unverified || !user.email) throw fail(409, 'confirm your email address first');
    if (ctx.mail.transport === 'smtp' && undeliverable(user.email)) throw fail(409, 'your address can’t receive mail: set a real one in Settings → Profile');
    const wait = tests.retryAfter(user.id);
    if (wait) throw Object.assign(fail(429, `a test mail went out just now: try again in ${Math.ceil(wait / 60)} min`), { retryAfter: wait });
    tests.hit(user.id);
    const site = ctx.cfg.public_url || `http://localhost:${ctx.cfg.port}`;
    try {
      await sendTestMail({ mail: ctx.cfg.mail, site, org: ctx.cfg.org_name ?? null }, user.email, ctx.accountMail.langOf(user, lang));
    } catch (e) {
      // What the relay said goes to the log; the answer stays a sentence (it can name hosts and replies).
      console.error(`mail test: ${(e as Error).message}`);
      const why = 'the test mail couldn’t be sent through the relay: check LAMPO_SMTP_URL and LAMPO_MAIL_FROM (lampo admin mail-test shows why)';
      throw Object.assign(fail(502, why), { publicText: why });
    }
    const out: MailTestResult = { ok: true, to: user.email };
    res.json(out);
  });

  return r;
}
