// Server facts for the UI (who am I, what works here, LAN links + QR code, is speech-to-text there) and the public tunnel
// switch (on the person's own machine only: a hosted server is public already).
import fs from 'node:fs';
import type express from 'express';
import type { Router } from 'express';
import QRCode from 'qrcode';
import { isOperator } from '../../lib/operator.ts';
import { DATA, HOME, ROOT } from '../../lib/paths.ts';
import { can } from '../../lib/permissions.ts';
import { rootStorage } from '../../lib/storage/index.ts';
import { publicSttStatus, sttAvailable, sttStatus } from '../../lib/stt/index.ts';
import type { InfoResponse } from '../../lib/types.ts';
import type { ServerContext } from '../context.ts';
import { lanIps } from '../guard.ts';
import { fail, router } from '../http.ts';

const VERSION = (JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string }).version || '0.0.0';

export function systemRoutes(ctx: ServerContext): Router {
  const r = router();
  const { cfg, tunnel } = ctx;
  // The tunnel publishes this machine: its owner's call, from the machine itself.
  const localOnly = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (ctx.hosted) throw fail(403, 'not available on a hosted server');
    if (req.auth?.via !== 'local') throw fail(403, 'only from the machine the app runs on');
    next();
  };

  // Public (the sign-in screen asks it): what only the machine's owner may know — its paths, the LAN link — is left
  // out for anyone else.
  r.get('/api/info', async (req, res) => {
    const caps = { ...ctx.capabilities, tunnel: ctx.capabilities.tunnel && tunnel.available };
    // The machine itself, not a phone that merely holds the LAN link: that one gets no paths either.
    const owner = !ctx.hosted && req.auth?.via === 'local';
    const urls = ctx.lan && owner ? lanIps().map((ip) => `http://${ip}:${cfg.port}/?t=${ctx.token}`) : [];
    // The speech engine's model path and last error (files, hosts) are the server's, not any workspace's: its operator
    // reads them — whoever runs a hosted server (lib/operator.ts), signed in in the browser, whichever workspace the
    // request works in; the machine's owner at the machine; anyone else the model's name only. An owner of another
    // workspace (every open sign-up has one), or one invited into the first, is a customer, not the operator (A12 VE2a-2).
    const a = req.auth;
    const operator = ctx.hosted ? a?.via === 'cookie' && isOperator(cfg, a.user?.id) : a?.via === 'local';
    const stt = sttStatus(cfg.stt);
    const out: InfoResponse = {
      lan: caps.lan,
      urls,
      qr: urls[0] ? await QRCode.toString(urls[0], { type: 'svg', margin: 1, color: { dark: '#000', light: '#fff' } }) : null,
      user: req.auth?.name || '',
      whisper: sttAvailable(cfg.stt),
      stt: { ...(operator ? stt : publicSttStatus(stt)), languages: cfg.stt.languages },
      dataDir: owner ? DATA : '',
      home: owner ? HOME : '',
      root: owner ? ROOT : '',
      mode: cfg.mode,
      capabilities: caps,
      features: {
        uploads: true,
        paths: caps.linkFiles,
        accounts: true,
        tunnel: caps.tunnel,
        sessions: caps.localAgents ? 'claude' : 'agents',
        upload_max_bytes: cfg.upload_max_bytes,
        storage: rootStorage().kind,
        oauth: true,
      },
      public_url: cfg.public_url,
      // Where one-time upload URLs point (server/context.ts): a chat app's sandbox must be allowed to reach it.
      ...(ctx.hosted && cfg.media_origin && req.auth ? { media_origin: cfg.media_origin } : {}),
      source_url: cfg.source_url,
      version: VERSION,
      mail: !!cfg.public_url,
      ...(req.auth && can(req.auth.role, 'admin') ? { mail_transport: ctx.mail.transport } : {}),
      signup: cfg.signup,
      terms_url: cfg.terms_url,
      privacy_url: cfg.privacy_url,
      imprint_url: cfg.imprint_url,
      withdrawal_url: cfg.withdrawal_url,
      cancel_url: cfg.cancel_url,
      ...(ctx.extension.billing ? { billing: true } : {}),
    };
    res.json(out);
  });

  r.get('/api/tunnel', (_req, res) => {
    res.json({ available: ctx.capabilities.tunnel && tunnel.available, running: !!tunnel.url, url: tunnel.url });
  });

  r.post('/api/tunnel/start', localOnly, async (_req, res) => {
    res.json({ url: await tunnel.start() });
  });

  r.post('/api/tunnel/stop', localOnly, (_req, res) => {
    tunnel.stop();
    res.json({ ok: true });
  });

  return r;
}
