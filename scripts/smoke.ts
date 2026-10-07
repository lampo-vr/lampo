// Read-only checks of a running hosted instance, from anywhere: after a deploy, after an update, from a monitor.
//   node scripts/smoke.ts https://review.example.com [--media https://media.example.com] [--connect <ip>] [--insecure] [--json]
// --connect talks to that address while naming the host (TLS and Host header): a new server before DNS points at it.
// --media also checks the app's own media host (LAMPO_MEDIA_ORIGIN): alive, its certificate, that the page's CSP lets the
// player load it, and that it serves nothing but signed media.
// It never signs in and never writes: health and readiness, the security headers, noindex, nothing loaded from other
// hosts, the API closed to strangers, the build's cache headers and compression, OAuth discovery for /mcp, http → https,
// and how long the TLS certificate has left. One line per check; exit 1 when one fails (a warning doesn't).
// docs/go-live.md uses it after every step that can break something.

import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import type { TLSSocket } from 'node:tls';

export interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** Days the server's certificate has left (https only). */
  certDays?: number;
}

export type Get = (url: string, headers?: Record<string, string>) => Promise<Reply>;

export interface Check {
  name: string;
  level: 'ok' | 'warn' | 'fail';
  detail: string;
}

/**
 * A GET with node:http(s): no redirects followed, the certificate's expiry kept; `insecure` for a test certificate,
 * `connect` to reach that address under the URL's host name.
 */
export function getter({ insecure = false, timeoutMs = 15000, connect = '' } = {}): Get {
  const family = connect.includes(':') ? 6 : 4;
  const lookup: LookupFunction | undefined = connect
    ? (_host, opts, cb) => (opts?.all ? cb(null, [{ address: connect, family }]) : cb(null, connect, family))
    : undefined;
  return (url, headers = {}) =>
    new Promise((resolve, reject) => {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const options = { method: 'GET', headers: { 'User-Agent': 'lampo-smoke', ...headers }, rejectUnauthorized: !insecure, timeout: timeoutMs, lookup };
      const req = lib.request(u, options, (res) => {
        // The socket is let go of once the body is read: ask for the certificate first.
        const cert = u.protocol === 'https:' ? (res.socket as TLSSocket | null)?.getPeerCertificate?.() : undefined;
        const certDays = cert?.valid_to ? Math.floor((Date.parse(cert.valid_to) - Date.now()) / 86400e3) : undefined;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), certDays });
        });
      });
      req.on('timeout', () => req.destroy(new Error(`no answer within ${timeoutMs / 1000} s`)));
      req.on('error', reject);
      req.end();
    });
}

const json = (r: Reply): Record<string, unknown> | null => {
  try {
    return JSON.parse(r.body) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** The certificate's verdict: under a week fails, under three weeks warns. */
const certLevel = (days: number | undefined): Check['level'] => (days === undefined ? 'warn' : days < 7 ? 'fail' : days < 21 ? 'warn' : 'ok');

/** Every check against `base` (an origin like https://review.example.com), and its media host when `media` names one. */
export async function smoke(base: string, get: Get, { media }: { media?: string } = {}): Promise<Check[]> {
  const origin = new URL(base).origin;
  const https_ = origin.startsWith('https:');
  const out: Check[] = [];
  const add = (name: string, level: Check['level'], detail = ''): void => {
    out.push({ name, level, detail });
  };
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      add(name, 'fail', err.message || err.code || String(e));
    }
  };

  await step('alive (/healthz)', async () => {
    const r = await get(`${origin}/healthz`);
    add('alive (/healthz)', r.status === 200 && json(r)?.ok === true ? 'ok' : 'fail', `HTTP ${r.status}`);
  });

  await step('ready (/readyz)', async () => {
    const t = Date.now();
    const r = await get(`${origin}/readyz`);
    const ms = Date.now() - t;
    const checks = (json(r)?.checks ?? {}) as Record<string, boolean>;
    const failing = Object.entries(checks)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    add(
      'ready (/readyz)',
      r.status === 200 && !failing.length ? 'ok' : 'fail',
      failing.length ? `not ready: ${failing.join(', ')} (the app's log says why)` : `${ms} ms`,
    );
  });

  let page: Reply | null = null;
  await step('the page and its headers', async () => {
    page = await get(`${origin}/`);
    const h = page.headers;
    const csp = String(h['content-security-policy'] || '');
    const missing = [
      ["Content-Security-Policy frame-ancestors 'none'", csp.includes("frame-ancestors 'none'")],
      ["Content-Security-Policy default-src 'self'", csp.includes("default-src 'self'")],
      ['X-Frame-Options: DENY', h['x-frame-options'] === 'DENY'],
      ['X-Content-Type-Options: nosniff', h['x-content-type-options'] === 'nosniff'],
      ['Referrer-Policy', !!h['referrer-policy']],
      ['Cache-Control: no-cache', String(h['cache-control']).includes('no-cache')],
      ...(https_ ? [['Strict-Transport-Security', /max-age=\d{7,}/.test(String(h['strict-transport-security']))] as const] : []),
    ]
      .filter(([, ok]) => !ok)
      .map(([what]) => what);
    add(
      'the page and its headers',
      page.status === 200 && !missing.length ? 'ok' : 'fail',
      missing.length ? `missing: ${missing.join('; ')}` : `HTTP ${page.status}`,
    );
    add('not for search engines', h['x-robots-tag'] === 'noindex, nofollow' ? 'ok' : 'fail', `X-Robots-Tag: ${h['x-robots-tag'] ?? 'none'}`);
  });

  await step('nothing from other hosts', async () => {
    const p = page as Reply | null;
    if (!p) return;
    // The page's own references: scripts, styles, fonts, icons. Absolute URLs to anywhere else would be a third party.
    const foreign = [...p.body.matchAll(/\b(?:src|href)="(https?:)?\/\/([^/"]+)/g)].map((m) => m[2]).filter((host) => host !== new URL(origin).host);
    add(
      'nothing from other hosts',
      foreign.length ? 'fail' : 'ok',
      foreign.length ? `the page loads from ${[...new Set(foreign)].join(', ')}` : 'scripts, styles and fonts are the build’s',
    );
    const asset = /\/assets\/[\w.-]+\.js/.exec(p.body)?.[0];
    if (!asset) return add('the build’s files', 'fail', 'no /assets/*.js on the page');
    const a = await get(`${origin}${asset}`, { 'Accept-Encoding': 'br, gzip' });
    const immutable = String(a.headers['cache-control']).includes('immutable');
    const packed = !!a.headers['content-encoding'];
    add(
      'the build’s files',
      a.status === 200 && immutable && packed ? 'ok' : 'fail',
      `${asset}: ${a.headers['cache-control']} · ${a.headers['content-encoding'] || 'not compressed'}`,
    );
  });

  await step('the API is closed to strangers', async () => {
    const r = await get(`${origin}/api/library`);
    const s = await get(`${origin}/api/auth/status`);
    const status = json(s);
    add('the API is closed to strangers', r.status === 401 ? 'ok' : 'fail', `/api/library without signing in: HTTP ${r.status}`);
    if (status?.setup) add('an owner exists', 'warn', 'no account yet: finish the setup with the token from the log');
    else add('an owner exists', status ? 'ok' : 'fail', status ? 'setup done' : `/api/auth/status: HTTP ${s.status}`);
    if (s.headers['set-cookie']) add('no cookie for strangers', 'fail', 'a signed-out request got a cookie');
  });

  await step('what the server says about itself', async () => {
    const info = json(await get(`${origin}/api/info`));
    if (!info) return add('what the server says about itself', 'fail', '/api/info is not JSON');
    add(
      'its public URL is this one',
      info.public_url === origin ? 'ok' : 'fail',
      `LAMPO_PUBLIC_URL is ${info.public_url ?? 'not set'}${info.public_url === origin ? '' : `, this is ${origin}`}`,
    );
    add(
      'hosted mode',
      info.mode === 'server' ? 'ok' : 'fail',
      `mode ${info.mode} · version ${info.version} · storage ${(info.features as { storage?: string })?.storage}`,
    );
    add('source offered (AGPL §13)', info.source_url ? 'ok' : 'warn', info.source_url ? String(info.source_url) : 'set LAMPO_SOURCE_URL');
  });

  await step('robots.txt', async () => {
    const r = await get(`${origin}/robots.txt`);
    add(
      'robots.txt',
      r.status === 200 && String(r.headers['content-type']).startsWith('text/plain') ? 'ok' : 'fail',
      `HTTP ${r.status} ${r.headers['content-type']}`,
    );
  });

  await step('OAuth discovery for /mcp', async () => {
    const prm = json(await get(`${origin}/.well-known/oauth-protected-resource/mcp`));
    const asm = json(await get(`${origin}/.well-known/oauth-authorization-server`));
    const mcp = await get(`${origin}/mcp`);
    const ok =
      prm?.resource === `${origin}/mcp` &&
      asm?.issuer === origin &&
      mcp.status === 401 &&
      String(mcp.headers['www-authenticate']).includes('resource_metadata=');
    add('OAuth discovery for /mcp', ok ? 'ok' : 'fail', `resource ${prm?.resource} · issuer ${asm?.issuer} · /mcp without a token: HTTP ${mcp.status}`);
    if (!https_) add('apps can sign in (OAuth)', 'warn', 'ChatGPT, Claude and other OAuth clients need an https address');
  });

  if (https_) {
    await step('http goes to https', async () => {
      const u = new URL(origin);
      const r = await get(`http://${u.hostname}/`);
      const to = String(r.headers.location || '');
      add(
        'http goes to https',
        [301, 302, 307, 308].includes(r.status) && to.startsWith(`https://${u.hostname}`) ? 'ok' : 'fail',
        `HTTP ${r.status} → ${to || 'nowhere'}`,
      );
    });
    await step('certificate', async () => {
      const r = await get(`${origin}/healthz`);
      const days = r.certDays;
      add('certificate', certLevel(days), days === undefined ? 'not known' : `${days} days left`);
    });
  }

  if (media) {
    const m = new URL(media).origin;
    await step('the media host', async () => {
      const csp = String((await get(`${origin}/healthz`)).headers['content-security-policy'] || '');
      const src = /(?:^|;)\s*media-src ([^;]*)/.exec(csp)?.[1]?.split(/\s+/) ?? [];
      // By scheme and host name: a test reaches the host on another port than the one the server names.
      const named = (s: string) => URL.canParse(s) && new URL(s).protocol === new URL(m).protocol && new URL(s).hostname === new URL(m).hostname;
      add('the player may load the media host (CSP)', src.some(named) ? 'ok' : 'fail', `media-src ${src.join(' ') || 'not set'}`);
      const h = await get(`${m}/healthz`);
      add('media host alive', h.status === 200 && json(h)?.ok === true ? 'ok' : 'fail', `${m}/healthz: HTTP ${h.status}`);
      const asked = await Promise.all(['/', '/api/library', '/api/auth/status'].map((p) => get(`${m}${p}`)));
      const served = asked.filter((r) => r.status !== 404);
      add(
        'the media host serves signed media only',
        !served.length && asked.every((r) => !r.headers['set-cookie']) ? 'ok' : 'fail',
        served.length ? `it answers ${served.map((r) => `HTTP ${r.status}`).join(', ')} for the app's paths` : 'the app’s paths are 404 there',
      );
      if (m.startsWith('https:')) {
        add('media host certificate', certLevel(h.certDays), h.certDays === undefined ? 'not known' : `${h.certDays} days left`);
        const plain = await get(`http://${new URL(m).hostname}/healthz`);
        const to = String(plain.headers.location || '');
        add(
          'media host: http goes to https',
          [301, 302, 307, 308].includes(plain.status) && to.startsWith(`${m}/`) ? 'ok' : 'fail',
          `HTTP ${plain.status} → ${to || 'nowhere'}`,
        );
      }
    });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const valued = new Set(['--connect', '--media']);
  const base = args.find((a, i) => !a.startsWith('--') && !valued.has(args[i - 1] ?? ''));
  const value = (flag: string) => (args.includes(flag) ? (args[args.indexOf(flag) + 1] ?? '') : '');
  const media = value('--media');
  if (!base || !/^https?:\/\//.test(base) || (args.includes('--media') && !/^https?:\/\//.test(media))) {
    console.error('usage: node scripts/smoke.ts https://review.example.com [--media https://media.example.com] [--connect <ip>] [--insecure] [--json]');
    process.exit(2);
  }
  const checks = await smoke(base, getter({ insecure: args.includes('--insecure'), connect: value('--connect') }), media ? { media } : {});
  if (args.includes('--json')) console.log(JSON.stringify(checks, null, 2));
  else for (const c of checks) console.log(`${c.level === 'ok' ? '✓' : c.level === 'warn' ? '!' : '✗'} ${c.name}${c.detail ? `  ${c.detail}` : ''}`);
  const failed = checks.filter((c) => c.level === 'fail').length;
  if (!args.includes('--json')) console.log(failed ? `\n${failed} of ${checks.length} checks failed` : `\nall ${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
