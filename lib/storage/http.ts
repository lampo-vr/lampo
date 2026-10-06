// Minimal HTTP client for object stores: streams file bodies with an exact Content-Length (multi-GB renders; some
// stores reject chunked uploads) and streams downloads to disk. Retries idempotent requests on network errors and 5xx.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';

export interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/**
 * An object store's answer that wasn't a success. Its message names the storage key and carries the store's own words
 * (a bucket's name, its error XML): the server's business, never a visitor's, an agent's or a token's (lib/publicError.ts).
 */
export class HttpStatusError extends Error {
  status: number;
  readonly internal = true;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface RequestOptions {
  method: string;
  headers?: Record<string, string | number>;
  /** A file to send as the body (optionally only bytes start…end, inclusive), or a buffer/string. */
  file?: string;
  range?: { start: number; end: number };
  body?: Buffer | string;
  /** Write a successful response body to this file instead of buffering it. */
  saveTo?: string;
}

function once(url: string, o: RequestOptions): Promise<HttpResult> {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  const headers: Record<string, string | number> = { ...o.headers };
  if (o.file) headers['Content-Length'] = o.range ? o.range.end - o.range.start + 1 : fs.statSync(o.file).size;
  else if (o.body !== undefined) headers['Content-Length'] = Buffer.byteLength(o.body);
  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method: o.method, headers }, (res) => {
      const status = res.statusCode || 0;
      if (o.saveTo && status >= 200 && status < 300) {
        pipeline(res, fs.createWriteStream(o.saveTo)).then(() => resolve({ status, headers: res.headers, body: Buffer.alloc(0) }), reject);
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(10 * 60000, () => req.destroy(new Error('request timed out')));
    if (o.file) pipeline(fs.createReadStream(o.file, o.range), req).catch(reject);
    else req.end(o.body);
  });
}

/** Sends a request, retrying up to 3 times on network errors and 5xx answers. */
export async function request(url: string, o: RequestOptions, { retries = 3 } = {}): Promise<HttpResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await once(url, o);
      if (r.status < 500 || attempt >= retries) return r;
    } catch (e) {
      if (attempt >= retries) throw e;
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
}

const collect = (res: http.IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on('data', (d: Buffer) => chunks.push(d));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });

function openGet(url: string, headers: Record<string, string>): Promise<http.IncomingMessage> {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method: 'GET', headers }, resolve);
    req.on('error', reject);
    req.setTimeout(10 * 60000, () => req.destroy(new Error('request timed out')));
    req.end();
  });
}

/**
 * Streams `length` bytes of a ranged GET (the caller signs `headers`, including Range, starting at `start`) without
 * buffering or writing to disk. Connecting is retried like request(); once bytes flow, a broken stream is an error for
 * the consumer. A store that ignores Range and answers 200 is accepted only for a range that starts at 0.
 */
export async function* readRange(url: string, headers: Record<string, string>, start: number, length: number, what: string): AsyncGenerator<Buffer> {
  let res: http.IncomingMessage | null = null;
  for (let attempt = 0; !res; attempt++) {
    try {
      const r = await openGet(url, headers);
      const status = r.statusCode || 0;
      if (status === 206 || (status === 200 && start === 0)) res = r;
      else {
        const body = await collect(r);
        const err = new HttpStatusError(status, `${what}: HTTP ${status} ${body.toString('utf8').slice(0, 200)}`);
        if (status < 500 || attempt >= 3) throw err;
      }
    } catch (e) {
      if ((e instanceof HttpStatusError && e.status < 500) || attempt >= 3) throw e;
    }
    if (!res) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  let left = length;
  try {
    for await (const chunk of res as AsyncIterable<Buffer>) {
      const part = chunk.length > left ? chunk.subarray(0, left) : chunk;
      left -= part.length;
      yield part;
      if (left <= 0) break;
    }
  } finally {
    res.destroy();
  }
  if (left > 0) throw new Error(`${what}: the stream ended ${left} bytes early`);
}

/** Throws unless the status is one of `ok` (the body's first bytes go into the message). */
export function expect(r: HttpResult, ok: number[], what: string): HttpResult {
  if (!ok.includes(r.status)) throw new HttpStatusError(r.status, `${what}: HTTP ${r.status} ${r.body.toString('utf8').slice(0, 200)}`);
  return r;
}
