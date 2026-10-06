// Every request publishing makes leaves through here: to the platforms' fixed hosts and to the URLs they hand back (an
// upload session, a presigned upload URL — addresses someone else chose). Each goes through lib/netguard.ts: only to
// public internet addresses, the connection pinned to the address that was checked, https only, no redirect followed,
// answers read up to a bound. The hosts named in VR_PUBLISH_ENDPOINTS (tests' fake platforms, a staging proxy) may be
// private and plain http: the operator named them. Nothing here logs a header or a body: they carry keys and tokens.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { hostOf, isBlockedAddress, pinnedLookup, publicAddress, type Resolver } from '../netguard.ts';

/** Where the platforms are. Defaults are the real ones; VR_PUBLISH_ENDPOINTS (JSON) replaces any of them. */
export interface Endpoints {
  /** Google's sign-in page (only the browser goes there). */
  googleAuth: string;
  googleToken: string;
  googleRevoke: string;
  /** YouTube Data API v3, and its upload host. */
  youtube: string;
  youtubeUpload: string;
  /** Zernio's API (its /v1/… paths below it). */
  zernio: string;
}

export const DEFAULT_ENDPOINTS: Endpoints = {
  googleAuth: 'https://accounts.google.com/o/oauth2/v2/auth',
  googleToken: 'https://oauth2.googleapis.com/token',
  googleRevoke: 'https://oauth2.googleapis.com/revoke',
  youtube: 'https://www.googleapis.com/youtube/v3',
  youtubeUpload: 'https://www.googleapis.com/upload/youtube/v3',
  zernio: 'https://zernio.com/api',
};

/** The endpoints as configured: VR_PUBLISH_ENDPOINTS='{"youtube":"http://127.0.0.1:9000/youtube/v3", …}'. */
export function endpointsFrom(env: NodeJS.ProcessEnv = process.env): { endpoints: Endpoints; named: Set<string> } {
  const raw = env.VR_PUBLISH_ENDPOINTS;
  if (!raw) return { endpoints: DEFAULT_ENDPOINTS, named: new Set() };
  let given: Partial<Endpoints>;
  try {
    given = JSON.parse(raw) as Partial<Endpoints>;
  } catch {
    throw new Error('VR_PUBLISH_ENDPOINTS is not JSON');
  }
  const endpoints = { ...DEFAULT_ENDPOINTS };
  const named = new Set<string>();
  for (const k of Object.keys(DEFAULT_ENDPOINTS) as (keyof Endpoints)[]) {
    const v = given[k];
    if (typeof v !== 'string') continue;
    const u = new URL(v);
    endpoints[k] = v.replace(/\/+$/, '');
    named.add(u.host);
  }
  return { endpoints, named };
}

/** A failure on the way: `transient` ones (the network, a timeout, a 5xx, a rate limit) are tried again later. */
export class NetError extends Error {
  transient: boolean;
  status: number;
  constructor(message: string, { transient = false, status = 0 } = {}) {
    super(message);
    this.transient = transient;
    this.status = status;
  }
}

export interface NetOptions {
  /** Hosts (host:port) that may be private and plain http: the ones VR_PUBLISH_ENDPOINTS names. */
  named?: Set<string>;
  /** Tests: the resolver and what counts as private. */
  resolve?: Resolver;
  blocked?: (ip: string) => boolean;
  timeoutMs?: number;
}

/** A body sent from a file, bytes [start, end] inclusive (one chunk of an upload). */
export interface FileBody {
  file: string;
  start: number;
  end: number;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | FileBody;
  /** Called as a file body goes out (bytes of this request). */
  progress?: (sent: number) => void;
  /** An answer larger than this is cut off and fails (default 4 MB): platforms answer in small JSON. */
  maxBytes?: number;
  /**
   * How long the whole request may take, answer included (default 60 s), plus the time the body needs at the slowest
   * rate allowed (MIN_SEND_RATE). Wall-clock, not silence: an answer that drips a byte at a time ends there too (A12
   * PUB-4), so no platform can hold the send slot every workspace shares.
   */
  timeoutMs?: number;
}

/** The slowest a body may go out before a request is given up on (bytes per second). */
export const MIN_SEND_RATE = 64 * 1024;

export interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  json<T = unknown>(): T;
}

const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNABORTED']);

/** One request through the guard. Never follows a redirect; never logs what it sends or gets. */
export async function guardedRequest(url: string, o: RequestOptions = {}, n: NetOptions = {}): Promise<Reply> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new NetError('the platform gave an address that is no URL');
  }
  const named = n.named?.has(u.host) ?? false;
  if (u.protocol !== 'https:' && !(named && u.protocol === 'http:')) throw new NetError(`only https is used for publishing (${u.protocol} given)`);
  if (u.username || u.password) throw new NetError('an address with a user name or password is refused');
  const host = hostOf(u);
  const addr = await publicAddress(host, n.resolve, named ? () => false : (n.blocked ?? isBlockedAddress)).catch((e: Error) => {
    throw new NetError(`${host} can't be reached for publishing: ${e.message}`, { transient: /does not resolve|ENOTFOUND|EAI_AGAIN/.test(e.message) });
  });
  const secure = u.protocol === 'https:';
  const body = o.body;
  const length = body === undefined ? 0 : typeof body === 'string' ? Buffer.byteLength(body) : Buffer.isBuffer(body) ? body.length : body.end - body.start + 1;
  const max = o.maxBytes ?? 4 * 1024 * 1024;
  const timeout = o.timeoutMs ?? n.timeoutMs ?? 60_000;
  const deadline = timeout + Math.ceil((length / MIN_SEND_RATE) * 1000);
  return new Promise<Reply>((resolveOut, rejectOut) => {
    let timer: NodeJS.Timeout | null = null;
    const settle = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const resolve = (r: Reply) => {
      settle();
      resolveOut(r);
    };
    const reject = (e: Error) => {
      settle();
      rejectOut(e);
    };
    const req = (secure ? https : http).request(
      {
        host: addr.address,
        port: u.port || (secure ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: o.method ?? (body === undefined ? 'GET' : 'POST'),
        headers: {
          ...o.headers,
          Host: u.host,
          ...(body !== undefined || o.method === 'PUT' || o.method === 'POST' ? { 'Content-Length': String(length) } : {}),
        },
        servername: secure && !net.isIP(host) ? host : undefined,
        lookup: pinnedLookup(addr),
        timeout,
      } as https.RequestOptions,
      (res) => {
        const chunks: Buffer[] = [];
        let got = 0;
        res.on('data', (d: Buffer) => {
          got += d.length;
          if (got > max) {
            req.destroy(new NetError('the platform answered with more than expected'));
            return;
          }
          chunks.push(d);
        });
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: buf,
            json<T>() {
              try {
                return JSON.parse(buf.toString('utf8')) as T;
              } catch {
                throw new NetError(`the platform answered ${res.statusCode} with something that isn't JSON`, { transient: (res.statusCode || 0) >= 500 });
              }
            },
          });
        });
        res.on('error', (e) => reject(asNetError(e)));
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => reject(asNetError(e)));
    timer = setTimeout(() => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })), deadline);
    timer.unref?.();
    if (body === undefined) req.end();
    else if (typeof body === 'string' || Buffer.isBuffer(body)) req.end(body);
    else {
      const stream = fs.createReadStream(body.file, { start: body.start, end: body.end });
      let sent = 0;
      stream.on('data', (d) => {
        sent += (d as Buffer).length;
        o.progress?.(sent);
      });
      stream.on('error', (e) => req.destroy(e));
      stream.pipe(req);
    }
  });
}

function asNetError(e: Error): NetError {
  if (e instanceof NetError) return e;
  const code = (e as NodeJS.ErrnoException).code ?? '';
  if (code === 'ETIMEDOUT') return new NetError('the platform took too long to answer', { transient: true });
  if (TRANSIENT_CODES.has(code)) return new NetError('the connection to the platform dropped', { transient: true });
  return new NetError('the connection to the platform failed', { transient: true });
}

/** A form body (OAuth token requests). */
export const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();
