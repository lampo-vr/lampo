// What makes the app feel instant over a real network: JSON answers compressed (brotli, else gzip) with an ETag, so a
// tab that already has the data gets a 304 instead of the same megabyte again; the built UI served pre-compressed with
// hashed files cached for good; and a Server-Timing header that says where a slow answer spent its time.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Smaller answers aren't worth compressing (headers and a round trip cost more). */
const MIN_COMPRESS = 1024;
// Answers that carry secrets are never compressed: a compressed size that changes with attacker-chosen input next to a
// secret leaks the secret (BREACH). Tokens, sessions, invites, OAuth and review-link tokens live under these. They also
// say `no-transform`, so a CDN in front (which compresses JSON by itself) leaves them as they are too.
const NO_COMPRESS = /^\/(?:api\/(?:auth|admin|oauth|shares|folder-shares|push|tunnel)(?:\/|$)|api\/review\/[^/]+\/shares$|oauth(?:\/|$))/;

type Coding = 'br' | 'gzip';

/**
 * The encoding to answer with: brotli when the client takes it at least as gladly as gzip, else gzip, else none (q=0
 * honoured). Browsers list gzip first ("gzip, deflate, br, zstd") without preferring it, so the header's order doesn't
 * count, only q.
 */
export function pickCoding(req: Request): Coding | null {
  const q: Record<string, number> = {};
  for (const part of String(req.headers['accept-encoding'] || '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    const qp = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const v = qp ? Number(qp.slice(2)) : 1;
    q[name] = Number.isFinite(v) ? v : 0;
  }
  const of = (c: string) => q[c] ?? q['*'] ?? 0;
  if (of('br') > 0 && of('br') >= of('gzip')) return 'br';
  return of('gzip') > 0 ? 'gzip' : null;
}

function compress(buf: Buffer, coding: Coding): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const done = (e: Error | null, out: Buffer) => (e ? reject(e) : resolve(out));
    // Quality 5: within a few ms of gzip -1 for a 1 MB listing, and smaller than gzip -9 (bench/perf).
    if (coding === 'br')
      zlib.brotliCompress(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }, done);
    else zlib.gzip(buf, { level: 6 }, done);
  });
}

/**
 * Adds `no-transform` to the answer's Cache-Control: no proxy or CDN in front may change its body — compress what the
 * app leaves uncompressed on purpose (BREACH), or rewrite a page whose scripts the CSP pins by hash.
 */
export function noTransform(res: Response, fallback = 'private, no-cache'): void {
  const cc = String(res.getHeader('Cache-Control') || fallback);
  if (!/\bno-transform\b/.test(cc)) res.setHeader('Cache-Control', `${cc}, no-transform`);
}

const vary = (res: Response, field: string) => {
  const now = String(res.getHeader('Vary') || '');
  if (!now.split(/\s*,\s*/).includes(field)) res.setHeader('Vary', now ? `${now}, ${field}` : field);
};

/**
 * Replaces `res.json` for every request: a weak ETag over the exact bytes (a GET that already has them gets 304 and no
 * body), `Cache-Control: private, no-cache` unless the route set its own (the browser keeps the answer but asks again
 * each time), compression for bigger answers, and `Server-Timing: app;dur=…, json;dur=…, zip;dur=…` (handler,
 * serialising, compressing).
 */
export function fastJson(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const t0 = performance.now();
    res.json = (body: unknown) => {
      const t1 = performance.now();
      const buf = Buffer.from(JSON.stringify(body) ?? 'null', 'utf8');
      const t2 = performance.now();
      const timing = [`app;dur=${(t1 - t0).toFixed(1)}`, `json;dur=${(t2 - t1).toFixed(1)}`];
      if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const cacheable = (req.method === 'GET' || req.method === 'HEAD') && res.statusCode === 200;
      if (cacheable) {
        res.setHeader('ETag', `W/"${crypto.createHash('sha1').update(buf).digest('base64url')}"`);
        if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'private, no-cache');
        if (req.fresh) {
          res.setHeader('Server-Timing', timing.join(', '));
          res.status(304).end();
          return res;
        }
      }
      const secret = NO_COMPRESS.test(req.path);
      if (secret) noTransform(res);
      const coding = buf.length >= MIN_COMPRESS && !secret ? pickCoding(req) : null;
      const send = (out: Buffer, zip?: number) => {
        if (res.headersSent) return;
        if (zip !== undefined) timing.push(`zip;dur=${zip.toFixed(1)}`);
        res.setHeader('Server-Timing', timing.join(', '));
        res.setHeader('Content-Length', out.length);
        res.end(req.method === 'HEAD' ? undefined : out);
      };
      if (!coding) {
        send(buf);
        return res;
      }
      vary(res, 'Accept-Encoding');
      const t3 = performance.now();
      compress(buf, coding).then(
        (out) => {
          if (res.headersSent) return;
          res.setHeader('Content-Encoding', coding);
          send(out, performance.now() - t3);
        },
        () => send(buf),
      );
      return res;
    };
    next();
  };
}

// Text files of the built UI that the build also wrote as .br and .gz (web/vite.config.ts).
const COMPRESSIBLE = /\.(?:js|mjs|css|html|svg|json|webmanifest|txt)$/;

/**
 * Serves `file` (inside the built UI) pre-compressed when the build made a .br/.gz next to it and the client takes it.
 * Returns false when there is nothing pre-compressed to send (the caller serves the file as is).
 */
export function sendPrecompressed(req: Request, res: Response, file: string, headers: Record<string, string> = {}): boolean {
  if (!COMPRESSIBLE.test(file)) return false;
  const coding = pickCoding(req);
  if (!coding) return false;
  const packed = `${file}${coding === 'br' ? '.br' : '.gz'}`;
  if (!exists(packed)) return false;
  res.type(path.extname(file));
  vary(res, 'Accept-Encoding');
  res.setHeader('Content-Encoding', coding);
  res.sendFile(packed, { headers, acceptRanges: false, dotfiles: 'allow' });
  return true;
}

// The build doesn't change under a running server (a new build means a restart): remember the files that exist. Only
// those: any signed-out GET reaches this with a path of its choosing, so remembering misses grew without end.
const known = new Set<string>();
function exists(file: string): boolean {
  if (known.has(file)) return true;
  const hit = fs.existsSync(file);
  if (hit) known.add(file);
  return hit;
}

/** How many built files are remembered (tests: misses never are). */
export const rememberedFiles = (): number => known.size;

/** Hashed build files (web/dist/assets): the name changes with the content, so they may be kept for good. */
export const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * The built UI's static files, pre-compressed where the build made copies, `/assets/*` immutable. `fresh` files (the
 * service worker, the manifest, the offline page) are always revalidated. Everything else falls through.
 */
export function builtFiles(dist: string, fresh: RegExp): RequestHandler {
  const root = path.resolve(dist);
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let rel: string;
    try {
      rel = decodeURIComponent(req.path);
    } catch {
      return next();
    }
    const file = path.join(root, rel);
    if (!file.startsWith(`${root}${path.sep}`) || !exists(file)) return next();
    const kept = rel.startsWith('/assets/') ? IMMUTABLE : fresh.test(rel) ? 'no-cache' : 'public, max-age=3600';
    // A page carries the CSP's script hash: nothing in front may inject into it or rewrite it.
    const cache = rel.endsWith('.html') ? `${kept}, no-transform` : kept;
    // a font may be read across origins (Stripe's payment frames draw their fields in it): never anything else
    const headers: Record<string, string> = { 'Cache-Control': cache };
    if (rel.endsWith('.woff2')) headers['Access-Control-Allow-Origin'] = '*';
    if (sendPrecompressed(req, res, file, headers)) return;
    next();
  };
}
