// In-memory stand-ins for Bunny Edge Storage and an S3-compatible bucket, just faithful enough for the adapters:
// they check credentials and checksums and keep the bytes, so tests can see exactly what was stored.
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockStore {
  url: string;
  objects: Map<string, Buffer>;
  requests: { method: string; path: string; headers: http.IncomingHttpHeaders }[];
  close(): Promise<void>;
}

const readBody = (req: http.IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

async function listen(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void) {
  const requests: MockStore['requests'] = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ method: req.method || '', path: req.url || '', headers: req.headers });
    handler(req, res, body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export interface MockBunny extends MockStore {
  /** Delay every download by this many ms, so tests can see how many run at the same time. */
  getDelayMs: number;
  /** The most downloads that were in flight at once. */
  maxParallelGets: number;
}

/** Bunny Storage API: /{zone}/{path}, header AccessKey, optional Checksum (uppercase hex sha256), Range on GET. */
export async function mockBunny({ zone = 'zone', accessKey = 'secret' } = {}): Promise<MockBunny> {
  const objects = new Map<string, Buffer>();
  let parallel = 0;
  const s = await listen((req, res, body) => {
    const u = new URL(req.url || '/', 'http://x');
    const parts = u.pathname.split('/').slice(1).map(decodeURIComponent);
    if (parts[0] !== zone || req.headers.accesskey !== accessKey) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    const key = parts.slice(1).join('/');
    if (req.method === 'PUT') {
      const sum = crypto.createHash('sha256').update(body).digest('hex').toUpperCase();
      if (req.headers.checksum && req.headers.checksum !== sum) {
        res.writeHead(400).end('checksum mismatch');
        return;
      }
      objects.set(key, body);
      res.writeHead(201).end('{"HttpCode":201,"Message":"File uploaded."}');
    } else if (req.method === 'GET') {
      const hit = objects.get(key);
      if (!hit) {
        res.writeHead(404).end('{"HttpCode":404,"Message":"Object Not Found"}');
        return;
      }
      parallel++;
      mock.maxParallelGets = Math.max(mock.maxParallelGets, parallel);
      setTimeout(() => {
        parallel--;
        const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || ''));
        if (!range) {
          res.writeHead(200, { 'Content-Length': hit.length }).end(hit);
          return;
        }
        const start = Number(range[1]);
        const end = Math.min(range[2] ? Number(range[2]) : hit.length - 1, hit.length - 1);
        const part = hit.subarray(start, end + 1);
        res.writeHead(206, { 'Content-Length': part.length, 'Content-Range': `bytes ${start}-${end}/${hit.length}` }).end(part);
      }, mock.getDelayMs);
    } else if (req.method === 'DELETE') {
      let n = 0;
      for (const k of [...objects.keys()])
        if (k === key || (key.endsWith('/') && k.startsWith(key))) {
          objects.delete(k);
          n++;
        }
      res.writeHead(n ? 200 : 404).end();
    } else res.writeHead(405).end();
  });
  const mock: MockBunny = { ...s, objects, getDelayMs: 0, maxParallelGets: 0 };
  return mock;
}

/** A key as S3 writes it into a listing: XML text, with what XML 1.0 can't hold as character references. */
const xmlText = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/[\r\n\t]/g, (c) => `&#${c.charCodeAt(0)};`);

/** Path-style S3: PUT/GET (with Range)/DELETE objects, multipart (uploads/partNumber/uploadId), ListObjectsV2. */
export async function mockS3({ bucket = 'bucket', accessKeyId = 'AKTEST' } = {}): Promise<MockStore & { parts: Map<string, Map<number, Buffer>> }> {
  const objects = new Map<string, Buffer>();
  const parts = new Map<string, Map<number, Buffer>>();
  const s = await listen((req, res, body) => {
    const u = new URL(req.url || '/', 'http://x');
    const [b, ...rest] = u.pathname.split('/').slice(1);
    const auth = String(req.headers.authorization || '');
    if (b !== bucket || !auth.startsWith(`AWS4-HMAC-SHA256 Credential=${accessKeyId}/`) || !req.headers['x-amz-date']) {
      res.writeHead(403).end('<Error><Code>AccessDenied</Code></Error>');
      return;
    }
    const key = rest.map(decodeURIComponent).join('/');
    const q = u.searchParams;
    if (req.method === 'GET' && q.get('list-type') === '2') {
      const prefix = q.get('prefix') || '';
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
      res
        .writeHead(200)
        .end(
          `<ListBucketResult>${keys.map((k) => `<Contents><Key>${xmlText(k)}</Key></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`,
        );
    } else if (req.method === 'POST' && q.has('uploads')) {
      const id = crypto.randomBytes(8).toString('hex');
      parts.set(id, new Map());
      res.writeHead(200).end(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    } else if (req.method === 'PUT' && q.has('partNumber')) {
      parts.get(q.get('uploadId') || '')?.set(Number(q.get('partNumber')), body);
      res.writeHead(200, { ETag: `"etag-${q.get('partNumber')}"` }).end();
    } else if (req.method === 'POST' && q.has('uploadId')) {
      const got = parts.get(q.get('uploadId') || '');
      const numbers = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => Number(m[1]));
      if (!got) {
        res.writeHead(404).end('<Error><Code>NoSuchUpload</Code></Error>');
        return;
      }
      objects.set(key, Buffer.concat(numbers.map((n) => got.get(n) || Buffer.alloc(0))));
      parts.delete(q.get('uploadId') || '');
      res.writeHead(200).end('<CompleteMultipartUploadResult><ETag>"x"</ETag></CompleteMultipartUploadResult>');
    } else if (req.method === 'PUT') {
      objects.set(key, body);
      res.writeHead(200, { ETag: '"x"' }).end();
    } else if (req.method === 'GET') {
      const hit = objects.get(key);
      const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range || ''));
      if (!hit) res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>');
      else if (range) res.writeHead(206).end(hit.subarray(Number(range[1]), Number(range[2]) + 1));
      else res.writeHead(200).end(hit);
    } else if (req.method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204).end();
    } else res.writeHead(405).end();
  });
  return { ...s, objects, parts };
}
