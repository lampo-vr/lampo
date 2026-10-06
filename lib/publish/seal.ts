// Publishing secrets at rest (API keys, OAuth client secrets, refresh and access tokens, an upload's session URL):
// AES-256-GCM under a key of their own derived from the store secret (lib/auth.ts secret(), like invites and the mail
// queue), and bound to the workspace and the record they belong to (the additional data), so a sealed value copied
// into another workspace's file, or onto another connection, doesn't open. connections.json alone gives nothing away.
import crypto from 'node:crypto';
import { secret } from '../auth.ts';
import { currentWorkspace } from '../paths.ts';

const key = (): Buffer => crypto.createHmac('sha256', secret()).update('video-review publishing secrets').digest();
const aad = (id: string): Buffer => Buffer.from(`${currentWorkspace()}\n${id}`, 'utf8');

/** Seals a value for record `id` of the workspace running now. */
export function seal(id: string, value: unknown): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  c.setAAD(aad(id));
  const body = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}

/** The value sealed for record `id` of this workspace; null when it doesn't open (another record, another key). */
export function unseal<T>(id: string, sealed: string | undefined | null): T | null {
  if (!sealed) return null;
  try {
    const [iv, tag, body] = sealed.split('.').map((x) => Buffer.from(x, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', key(), iv as Buffer);
    d.setAAD(aad(id));
    d.setAuthTag(tag as Buffer);
    return JSON.parse(Buffer.concat([d.update(body as Buffer), d.final()]).toString('utf8')) as T;
  } catch {
    return null;
  }
}

/** The last four characters of a key, for people to tell keys apart ("…a1b2"); never more. */
export const keyHint = (s: string): string => (s.length >= 12 ? `…${s.slice(-4)}` : '…');
