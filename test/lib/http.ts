// A tiny HTTP client for API tests: node:http rather than fetch, so tests can send the Host, Origin and forwarding
// headers a proxy, browser or attacker would.
import fs from 'node:fs';
import http from 'node:http';

export interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
  json: () => any;
}

export interface RequestOpts {
  body?: unknown;
  headers?: Record<string, string>;
}

export function client(port: number, base: Record<string, string> = {}) {
  return function request(method: string, url: string, { body, headers = {} }: RequestOpts = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const raw = Buffer.isBuffer(body);
      const data = body === undefined ? undefined : raw ? (body as Buffer) : typeof body === 'string' ? body : JSON.stringify(body);
      const h = { ...(data !== undefined && !raw ? { 'content-type': 'application/json' } : {}), ...base, ...headers };
      const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          text += d;
        });
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, text, json: () => JSON.parse(text) }));
      });
      req.on('error', reject);
      req.end(data);
    });
  };
}

export type Request = ReturnType<typeof client>;

/** A whole tus upload in two requests (create, then one PATCH with every byte). */
export async function tusUpload(request: Request, file: string, meta: Record<string, string>, headers: Record<string, string> = {}): Promise<Reply> {
  const size = fs.statSync(file).size;
  const metadata = Object.entries(meta)
    .map(([k, v]) => `${k} ${Buffer.from(v).toString('base64')}`)
    .join(',');
  const created = await request('POST', '/api/uploads', {
    headers: { ...headers, 'Tus-Resumable': '1.0.0', 'Upload-Length': String(size), 'Upload-Metadata': metadata },
  });
  if (created.status !== 201) return created;
  const location = String(created.headers.location);
  return request('PATCH', location, {
    body: fs.readFileSync(file),
    headers: { ...headers, 'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' },
  });
}

/** The session cookie from a Set-Cookie answer, ready for a Cookie header. */
export const cookieFrom = (r: Reply): string => String([r.headers['set-cookie']].flat()[0] || '').split(';')[0];
