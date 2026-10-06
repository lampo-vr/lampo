// Bunny CDN "advanced" token authentication (HMAC-SHA256), ported from the reference implementation
// (github.com/BunnyWay/BunnyCDN.TokenAuthentication, nodejs/token.js) and checked against its test vectors.
// IP locking is left out: viewers switch networks mid-review, and a pull zone with IP validation rejects everything
// signed without one.
import crypto from 'node:crypto';

export interface SignOptions {
  /** Seconds from now (ignored when expiresAt is given). */
  expiresIn?: number;
  /** Absolute expiry, unix seconds. */
  expiresAt?: number;
  /** Sign a path prefix instead of the exact path (one token for a whole directory). */
  pathAllowed?: string;
  /** Put the token into the path (/bcdn_token=…/file) so relative URLs inside the directory keep it. */
  isDirectory?: boolean;
  countriesAllowed?: string;
  countriesBlocked?: string;
  /** Sign `token_ignore_params=true` instead of the query, so parameters may be added later. */
  ignoreParams?: boolean;
  /** kB/s, 0 = unlimited. */
  speedLimit?: number;
}

export function signBunnyUrl(url: string, securityKey: string, o: SignOptions = {}): string {
  if (!securityKey) throw new Error('bunny token key is empty');
  const parsed = new URL(url);
  const query: Record<string, string> = {};
  for (const [k, v] of parsed.searchParams) {
    if (Object.hasOwn(query, k)) throw new Error(`duplicate query parameter "${k}"`);
    query[k] = v;
  }
  if (o.countriesAllowed) query.token_countries = o.countriesAllowed;
  if (o.countriesBlocked) query.token_countries_blocked = o.countriesBlocked;
  if (o.speedLimit && o.speedLimit > 0) query.limit = String(o.speedLimit);
  const expires = String(o.expiresAt ?? Math.floor(Date.now() / 1000) + (o.expiresIn ?? 86400));
  const params: Record<string, string> = o.ignoreParams ? { token_ignore_params: 'true' } : { ...query };
  if (o.pathAllowed) params.token_path = o.pathAllowed;
  // Signed with raw values, sent URL-encoded, both sorted by key.
  const sorted = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
  const signingData = sorted.map(([k, v]) => `${k}=${v}`).join('&');
  const urlData = sorted.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const digest = crypto
    .createHmac('sha256', securityKey)
    .update(o.pathAllowed || parsed.pathname)
    .update(expires)
    .update(signingData)
    .digest('base64url');
  const token = `HS256-${digest}`;
  const base = `${parsed.protocol}//${parsed.host}`;
  const tail = urlData ? `&${urlData}` : '';
  return o.isDirectory
    ? `${base}/bcdn_token=${token}${tail}&expires=${expires}${parsed.pathname}`
    : `${base}${parsed.pathname}?token=${token}${tail}&expires=${expires}`;
}
