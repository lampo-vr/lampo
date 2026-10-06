// Any S3-compatible object store (Cloudflare R2, Hetzner Object Storage, MinIO, Backblaze B2, Bunny's S3 endpoint).
// A small SigV4 signer instead of the AWS SDK: we need five calls (put, multipart, get, list, delete) plus presigned
// GETs, and the SDK would add ~100 packages to a self-hosted image for that. Path-style URLs work with every store.
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { S3Config } from '../paths.ts';
import { expect, HttpStatusError, readRange, request } from './http.ts';
import type { RemoteStore } from './index.ts';

const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac('sha256', key).update(data).digest();
const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
// RFC 3986: encodeURIComponent leaves !'()* alone, SigV4 wants them encoded.
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export const encodeKey = (key: string): string => key.split('/').map(enc).join('/');

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
/**
 * XML text as it was written, in one pass: a listing writes a key's `&` as `&amp;`, so `&amp;lt;` is the key's own
 * "&lt;" — decoding entity by entity would turn it into "<" and delete a key that isn't there.
 */
export const xmlUnescape = (s: string): string =>
  s.replace(/&(?:(amp|lt|gt|quot|apos)|#(\d+)|#x([0-9a-fA-F]+));/g, (all, name: string | undefined, dec: string | undefined, hex: string | undefined) => {
    if (name) return ENTITIES[name] as string;
    const code = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex as string, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

const amzDate = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

function signingKey(c: Credentials, date: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${c.secretAccessKey}`, date), c.region), 's3'), 'aws4_request');
}

function canonicalQuery(u: URL): string {
  return [...u.searchParams]
    .map(([k, v]) => [enc(k), enc(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** Signed headers for a request (Authorization, x-amz-date, x-amz-content-sha256). */
export function signRequest(
  c: Credentials,
  method: string,
  url: string,
  headers: Record<string, string> = {},
  payloadHash = 'UNSIGNED-PAYLOAD',
  now = new Date(),
): Record<string, string> {
  const u = new URL(url);
  const t = amzDate(now);
  const date = t.slice(0, 8);
  const all: Record<string, string> = { ...headers, host: u.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': t };
  const names = Object.keys(all)
    .map((k) => k.toLowerCase())
    .sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const canonical = [method, u.pathname, canonicalQuery(u), names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${date}/${c.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', t, scope, sha256(canonical)].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(c, date)).update(toSign).digest('hex');
  const { host: _host, ...rest } = all;
  return { ...rest, Authorization: `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

/** Presigned GET (query-string auth), valid for `expires` seconds (max 7 days). */
export function presignGet(c: Credentials, url: string, expires: number, now = new Date()): string {
  const u = new URL(url);
  const t = amzDate(now);
  const date = t.slice(0, 8);
  const scope = `${date}/${c.region}/s3/aws4_request`;
  u.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  u.searchParams.set('X-Amz-Credential', `${c.accessKeyId}/${scope}`);
  u.searchParams.set('X-Amz-Date', t);
  u.searchParams.set('X-Amz-Expires', String(Math.min(604800, Math.max(1, Math.round(expires)))));
  u.searchParams.set('X-Amz-SignedHeaders', 'host');
  const canonical = ['GET', u.pathname, canonicalQuery(u), `host:${u.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', t, scope, sha256(canonical)].join('\n');
  u.searchParams.set('X-Amz-Signature', crypto.createHmac('sha256', signingKey(c, date)).update(toSign).digest('hex'));
  return u.toString();
}

const PART = 64 * 1024 * 1024;

/** Files above `partSize` (64 MB; S3's minimum part is 5 MB) go up as multipart uploads. */
export function createS3Store(cfg: S3Config | undefined, { partSize = PART } = {}): RemoteStore {
  if (!cfg?.endpoint || !cfg.bucket || !cfg.access_key_id || !cfg.secret_access_key)
    throw new Error('storage "s3" needs s3.endpoint, s3.bucket, s3.access_key_id and s3.secret_access_key (VR_S3_*)');
  const creds: Credentials = { accessKeyId: cfg.access_key_id, secretAccessKey: cfg.secret_access_key, region: cfg.region || 'auto' };
  const base = `${cfg.endpoint.replace(/\/+$/, '')}/${enc(cfg.bucket)}`;
  const prefix = (cfg.prefix || '').replace(/^\/+|\/+$/g, '');
  const full = (key: string) => (prefix ? `${prefix}/${key}` : key);
  const objectUrl = (key: string, query = '') => `${base}/${encodeKey(full(key))}${query}`;
  const send = (method: string, url: string, o: Parameters<typeof request>[1] = { method }) =>
    request(url, { ...o, method, headers: signRequest(creds, method, url, (o.headers as Record<string, string>) || {}) });

  async function multipart(key: string, file: string, size: number, contentType: string): Promise<void> {
    const created = expect(
      await send('POST', objectUrl(key, '?uploads='), { method: 'POST', headers: { 'content-type': contentType } }),
      [200],
      'S3 start upload',
    );
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(created.body.toString())?.[1];
    if (!uploadId) throw new Error('S3 start upload: no UploadId in the answer');
    const q = (n: number) => `?partNumber=${n}&uploadId=${encodeURIComponent(uploadId)}`;
    const etags: string[] = [];
    try {
      for (let start = 0, n = 1; start < size; start += partSize, n++) {
        const range = { start, end: Math.min(size, start + partSize) - 1 };
        const r = expect(await send('PUT', objectUrl(key, q(n)), { method: 'PUT', file, range }), [200], `S3 upload part ${n}`);
        etags.push(String(r.headers.etag || ''));
      }
      const xml = `<CompleteMultipartUpload>${etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
      const done = expect(
        await send('POST', objectUrl(key, `?uploadId=${encodeURIComponent(uploadId)}`), {
          method: 'POST',
          body: xml,
          headers: { 'content-type': 'application/xml' },
        }),
        [200],
        'S3 finish upload',
      );
      // S3 can answer 200 with an error document when completing fails late.
      if (/<Error>/.test(done.body.toString())) throw new HttpStatusError(502, `S3 finish upload: ${done.body.toString().slice(0, 200)}`);
    } catch (e) {
      await send('DELETE', objectUrl(key, `?uploadId=${encodeURIComponent(uploadId)}`)).catch(() => {});
      throw e;
    }
  }

  return {
    kind: 's3',
    async put(key, file, contentType = 'application/octet-stream') {
      const size = fs.statSync(file).size;
      if (size > partSize) return multipart(key, file, size, contentType);
      expect(await send('PUT', objectUrl(key), { method: 'PUT', file, headers: { 'content-type': contentType } }), [200], `S3 upload ${key}`);
    },
    async get(key, file) {
      expect(await send('GET', objectUrl(key), { method: 'GET', saveTo: file }), [200], `S3 download ${key}`);
    },
    read(key, start, end) {
      const url = objectUrl(key);
      return readRange(url, signRequest(creds, 'GET', url, { range: `bytes=${start}-${end}` }), start, end - start + 1, `S3 read ${key}`);
    },
    async check() {
      expect(await send('GET', `${base}?list-type=2&max-keys=1&prefix=${enc(prefix)}`), [200], 'S3 bucket');
    },
    async remove(keyOrPrefix) {
      if (!keyOrPrefix.endsWith('/')) {
        expect(await send('DELETE', objectUrl(keyOrPrefix)), [200, 204, 404], `S3 delete ${keyOrPrefix}`);
        return;
      }
      for (let token: string | null = null; ; ) {
        const q: string = `?list-type=2&prefix=${enc(full(keyOrPrefix))}${token ? `&continuation-token=${enc(token)}` : ''}`;
        const listed: string = expect(await send('GET', `${base}${q}`), [200], `S3 list ${keyOrPrefix}`).body.toString();
        for (const m of listed.matchAll(/<Key>([^<]+)<\/Key>/g)) {
          const k = xmlUnescape(m[1]);
          expect(await send('DELETE', `${base}/${encodeKey(k)}`), [200, 204, 404], `S3 delete ${k}`);
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(listed) ? xmlUnescape(/<NextContinuationToken>([^<]+)</.exec(listed)?.[1] || '') || null : null;
        if (!token) break;
      }
    },
    url: (key, expiresIn) => (cfg.presign === false ? null : presignGet(creds, objectUrl(key), expiresIn)),
    origins: () => (cfg.presign === false ? [] : [new URL(cfg.endpoint).origin]),
  };
}
