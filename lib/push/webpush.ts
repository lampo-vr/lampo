// Web Push without a dependency: message encryption (RFC 8291, aes128gcm) and VAPID (RFC 8292), both on node:crypto.
// A push is one POST to the browser vendor's push service; its body is encrypted for the subscribing browser only.
// Verified against RFC 8291's example in test/unit/push.test.ts.
import crypto from 'node:crypto';
import https from 'node:https';
import net from 'node:net';
import { hostOf, isBlockedAddress, pinnedLookup, publicAddress, type Resolver, systemResolve } from '../netguard.ts';

const b64u = (b: Buffer): string => b.toString('base64url');
const hmac = (key: Buffer, data: Buffer): Buffer => crypto.createHmac('sha256', key).update(data).digest();
const ONE = Buffer.from([1]);

export interface PushSubscriptionKeys {
  /** The browser's P-256 public key, uncompressed, base64url. */
  p256dh: string;
  /** 16-byte authentication secret, base64url. */
  auth: string;
}

export interface EncryptOptions {
  /** Fixed salt and sender key: only for the RFC test vectors. */
  salt?: Buffer;
  senderPrivateKey?: Buffer;
  recordSize?: number;
}

/** One aes128gcm record: header (salt, record size, sender public key) + ciphertext of payload‖0x02. */
export function encrypt(payload: Buffer, keys: PushSubscriptionKeys, opts: EncryptOptions = {}): Buffer {
  const uaPublic = Buffer.from(keys.p256dh, 'base64url');
  const authSecret = Buffer.from(keys.auth, 'base64url');
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('p256dh must be an uncompressed P-256 public key');
  if (authSecret.length !== 16) throw new Error('auth must be 16 bytes');
  const ecdh = crypto.createECDH('prime256v1');
  if (opts.senderPrivateKey) ecdh.setPrivateKey(opts.senderPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  // HKDF with the auth secret as salt mixes both sides' keys into the input keying material (RFC 8291 §3.3).
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, ONE]));
  const salt = opts.salt ?? crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), ONE])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), ONE])).subarray(0, 12);
  const rs = opts.recordSize ?? 4096;
  // One record holds payload + delimiter + tag; push services cap bodies at 4 KB anyway.
  if (payload.length + 1 + 16 > rs) throw new Error('push payload too large');
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(rs, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url: the browser's applicationServerKey. */
  publicKey: string;
  /** The private scalar d, base64url. */
  privateKey: string;
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function privateKeyObject(keys: VapidKeys): crypto.KeyObject {
  const pub = Buffer.from(keys.publicKey, 'base64url');
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
}

/** `Authorization: vapid t=<ES256 JWT>, k=<public key>` for one push service (RFC 8292). */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Math.floor(Date.now() / 1000)): string {
  const enc = (o: object) => b64u(Buffer.from(JSON.stringify(o)));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: new URL(endpoint).origin, exp: now + 12 * 3600, sub: subject })}`;
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: privateKeyObject(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${keys.publicKey}`;
}

/**
 * Push services of the browsers that do Web Push. Subscriptions come from the browser, so an endpoint must never be
 * a way to make this server POST to arbitrary (internal) addresses.
 */
const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com'];

export function isPushEndpoint(endpoint: string, extraHosts: string[] = []): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  return [...PUSH_HOSTS, ...extraHosts].some((h) => (h.startsWith('.') ? u.hostname.endsWith(h) : u.hostname === h));
}

export interface SendOptions {
  vapid: VapidKeys;
  /** VAPID contact: mailto: or https: (Apple rejects pushes without one). */
  subject: string;
  /** Seconds the push service keeps an undelivered message. */
  ttl?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  /** Replaces an undelivered message with the same topic (≤ 32 base64url characters). */
  topic?: string;
  /** Tests: a stand-in push service (the address check still runs first). */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** How the push service's name is resolved (tests); every address must be public (lib/netguard.ts). */
  resolve?: Resolver;
  /** Tests that serve on loopback. */
  blocked?: (ip: string) => boolean;
  /** Tests: the certificate a stand-in service presents. */
  ca?: string | Buffer;
}

/** A push service this server won't send to: its name resolved to an address that isn't public. Not worth a retry. */
export class PushRefused extends Error {}

export interface SendResult {
  status: number;
  ok: boolean;
  /** The subscription is gone for good (404/410): forget it. */
  gone: boolean;
}

/**
 * One push. The endpoint's host is on the browsers' list (isPushEndpoint, at subscribe), but a name is only as good as
 * what it resolves to now: every address must be public, and the connection goes to the address checked, never
 * resolved again — so a subscription can't make this server POST into its own network (A12 MEDIA-4).
 */
export async function sendPush(endpoint: string, keys: PushSubscriptionKeys, payload: string, o: SendOptions): Promise<SendResult> {
  const u = new URL(endpoint);
  const addr = await publicAddress(hostOf(u), o.resolve ?? systemResolve, o.blocked ?? isBlockedAddress).catch((e: Error) => {
    throw new PushRefused(e.message);
  });
  const headers: Record<string, string> = {
    TTL: String(o.ttl ?? 24 * 3600),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    Authorization: vapidAuthorization(endpoint, o.vapid, o.subject),
    Urgency: o.urgency || 'normal',
  };
  if (o.topic) headers.Topic = o.topic;
  const body = encrypt(Buffer.from(payload, 'utf8'), keys);
  const timeout = o.timeoutMs ?? 10_000;
  const status = o.fetchImpl
    ? (
        await o.fetchImpl(endpoint, {
          method: 'POST',
          headers,
          body: new Uint8Array(body),
          redirect: 'error',
          signal: AbortSignal.timeout(timeout),
        })
      ).status
    : await pinnedPost(u, addr, headers, body, timeout, o.ca);
  return { status, ok: status >= 200 && status < 300, gone: status === 404 || status === 410 };
}

/** POSTs to the address that passed the check (TLS still verified for the name), following no redirect. */
function pinnedPost(
  u: URL,
  addr: { address: string; family: number },
  headers: Record<string, string>,
  body: Buffer,
  timeoutMs: number,
  ca?: string | Buffer,
): Promise<number> {
  const host = hostOf(u);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: addr.address,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: { ...headers, Host: u.host, 'Content-Length': String(body.length) },
        servername: net.isIP(host) ? undefined : host,
        lookup: pinnedLookup(addr),
        timeout: timeoutMs,
        ...(ca ? { ca } : {}),
      } as https.RequestOptions,
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode || 0));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { name: 'TimeoutError' })));
    req.on('error', reject);
    req.end(body);
  });
}
