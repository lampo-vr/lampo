// Signed, short-lived URLs on the app's own media host (VR_MEDIA_ORIGIN): a second host name served by this same app,
// which answers nothing but these URLs and one-time uploads. It is for a server whose app host sits behind a front
// that must not carry video (a CDN proxy whose terms or limits keep video off it): the player, review links and
// downloads are redirected there exactly as they are to Bunny's or S3's own signed URLs (SIGNED_URL_SECONDS), and the
// bytes go from this server straight to the browser. The URL is its own credential: no cookie reaches that host.
//
// A URL is /media/s/<sealed>/<name> (a file) or /media/z/<sealed>/<name> (a folder's zip). The sealed part is
// AES-256-GCM under a key derived from the store's secret: it names no video, folder or workspace (a review link's
// visitor sees ids, never names), and nobody without the key can make or change one. Its end is rounded up to a step
// (a minute for URLs that live minutes, an hour for hours) and its IV derived from what it seals, so the same file
// asked for again within a step gets the same URL and the browser's cache keeps the ranges it fetched.
import crypto from 'node:crypto';
import { secret } from '../auth.ts';

/** What a sealed media URL carries besides its end (`e`, unix seconds). */
export type MediaClaims = Record<string, unknown>;

const subkey = (label: string): Buffer => crypto.createHmac('sha256', secret()).update(`video-review media urls: ${label}`).digest();
const AAD = Buffer.from('video-review media url v1');

/** When a URL that should live `seconds` from `now` (ms) ends: rounded up to the minute, or the hour past an hour. */
export function mediaUrlEnd(seconds: number, now = Date.now()): number {
  const step = seconds >= 3600 ? 3600 : 60;
  return Math.ceil((Math.floor(now / 1000) + Math.max(1, Math.round(seconds))) / step) * step;
}

/** Seals `claims` with an end `seconds` from now. The same claims within the same step seal to the same string. */
export function sealMedia(claims: MediaClaims, seconds: number, now = Date.now()): string {
  const plain = Buffer.from(JSON.stringify({ ...claims, e: mediaUrlEnd(seconds, now) }), 'utf8');
  const iv = crypto.createHmac('sha256', subkey('iv')).update(plain).digest().subarray(0, 12);
  const c = crypto.createCipheriv('aes-256-gcm', subkey('key'), iv);
  c.setAAD(AAD);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}

/** The claims a URL sealed, or null when it wasn't sealed with this store's key, was changed, or has ended. A team zip's
 * claims carry who asked (a session, too) and a folder path of up to 400 characters: room for 6 KB, well inside the
 * 16 KB a request's line and headers may have. */
export function openMedia<T extends MediaClaims>(token: string, now = Date.now()): (T & { e: number }) | null {
  if (!/^[\w-]{40,8192}$/.test(token)) return null;
  try {
    const raw = Buffer.from(token, 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', subkey('key'), raw.subarray(0, 12));
    d.setAAD(AAD);
    d.setAuthTag(raw.subarray(12, 28));
    const claims = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')) as T & { e: unknown };
    if (typeof claims.e !== 'number' || claims.e * 1000 < now) return null;
    return claims as T & { e: number };
  } catch {
    return null;
  }
}

/** A name for the URL's last segment: only for people who save the file (the sealed part decides what is served). */
const urlName = (name: string): string => encodeURIComponent(name.replace(/[/\\\0]/g, '_').slice(0, 200) || 'file');

/**
 * A signed URL on `origin` for storage key `key` (the whole key, its workspace prefix included), living `seconds`.
 * `download`: the file's name when it is handed out as a download (Content-Disposition on the media host).
 */
export function mediaFileUrl(origin: string, key: string, seconds: number, download?: string): string {
  const claims: MediaClaims = download ? { k: key, n: download } : { k: key };
  return `${origin}/media/s/${sealMedia(claims, seconds)}/${urlName(download || key.split('/').pop() || 'file')}`;
}

/** A signed URL on `origin` for a folder's zip: what to put in it (the claims), its file name, how long it lives. */
export function mediaArchiveUrl(origin: string, claims: MediaClaims, filename: string, seconds: number): string {
  return `${origin}/media/z/${sealMedia({ z: claims, n: filename }, seconds)}/${urlName(filename)}`;
}
