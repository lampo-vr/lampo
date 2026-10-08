// Who is asking for access: OAuth clients of the hosted server's MCP endpoint.
//   Client ID Metadata Documents (preferred, MCP 2026-07-28): the client_id is an https URL of a JSON document the
//     client hosts. We fetch it — carefully, it is a URL chosen by a stranger (SSRF): https only, every resolved address
//     checked against private/loopback/link-local ranges and the connection pinned to the checked address, no
//     redirects, small and fast, cached.
//   Dynamic Client Registration (RFC 7591, deprecated by MCP but still what some clients use): registrations are kept in
//     data/oauth/clients.json (0600). Their names are self-asserted, which the consent screen says.
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import { cutChars } from '../names.ts';
import { isBlockedAddress } from '../netguard.ts';
import { DATA, isoLocal } from '../paths.ts';
import { withLock, writeAtomic } from '../store.ts';

export const OAUTH_DIR = path.join(DATA, 'oauth');
const CLIENTS_FILE = path.join(OAUTH_DIR, 'clients.json');
const LOCK_DIR = path.join(DATA, '.oauth');

export type AuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

/** A client as the authorization endpoint and the consent screen see it. */
export interface ClientInfo {
  client_id: string;
  /** cimd: a metadata document; dcr: a registration; vr: `lampo login`, Lampo's own command line (VR_CLIENT). */
  kind: 'cimd' | 'dcr' | 'vr';
  name: string;
  /** The host that vouches for the client: the metadata document's host (CIMD), or the self-declared client_uri (DCR). */
  host: string | null;
  redirect_uris: string[];
  auth: AuthMethod;
}

export class ClientError extends Error {
  /** OAuth error code: invalid_client, invalid_client_metadata, invalid_redirect_uri. */
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- redirect URIs

const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'about:', 'blob:', 'ftp:', 'ws:', 'wss:', 'mailto:', 'http:']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Where an authorization response may be sent: https anywhere, http only to this machine (native apps on a loopback
 * port), or an app's own URI scheme (cursor://…, vscode://…). Never scripts, files or fragments.
 */
export function checkRedirectUri(uri: string): string {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    throw new ClientError('invalid_redirect_uri', `redirect URI is not an absolute URL: ${uri.slice(0, 200)}`);
  }
  if (u.hash || uri.includes('#')) throw new ClientError('invalid_redirect_uri', 'redirect URIs may not contain a fragment');
  if (u.username || u.password) throw new ClientError('invalid_redirect_uri', 'redirect URIs may not contain credentials');
  if (u.protocol === 'http:' && LOOPBACK.has(u.hostname)) return uri;
  if (u.protocol === 'https:') return uri;
  if (FORBIDDEN_SCHEMES.has(u.protocol) || !/^[a-z][a-z0-9+.-]{1,62}:$/.test(u.protocol))
    throw new ClientError('invalid_redirect_uri', `redirect URIs must use https, http on localhost, or the app's own scheme (${u.protocol} is not allowed)`);
  return uri;
}

/**
 * Exact match, except that a native app on a loopback address may pick its port at runtime (RFC 8252 §7.3): only the
 * port may differ, never the scheme, host, path or query.
 */
export function redirectMatches(registered: readonly string[], asked: string): boolean {
  if (registered.includes(asked)) return true;
  let a: URL;
  try {
    a = new URL(asked);
  } catch {
    return false;
  }
  if (a.protocol !== 'http:' || !LOOPBACK.has(a.hostname)) return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return u.protocol === 'http:' && u.hostname === a.hostname && u.pathname === a.pathname && u.search === a.search;
    } catch {
      return false;
    }
  });
}

export const isLoopbackRedirect = (uri: string): boolean => {
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && LOOPBACK.has(u.hostname);
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------- lampo login

/**
 * `lampo login <url>` in the browser (lib/browserLogin.ts): Lampo's own command line, not a registration — registrations
 * are `vrc_…` and metadata documents https URLs, so nobody can take this id. Its answer goes only to a loopback address
 * of the computer the browser runs on (RFC 8252 §7.3: 127.0.0.1 or [::1], any port, the path `/`, nothing else), and its
 * code is redeemed for an API token at POST /api/auth/token (lib/oauth/store.ts redeemVrCode), never at /oauth/token.
 */
export const VR_CLIENT_ID = 'vr';
const VR_REDIRECTS = ['http://127.0.0.1/', 'http://[::1]/'];
export const VR_CLIENT: ClientInfo = { client_id: VR_CLIENT_ID, kind: 'vr', name: 'lampo', host: null, redirect_uris: VR_REDIRECTS, auth: 'none' };

/** Where `lampo login`'s answer may go: http://127.0.0.1:<port>/ or http://[::1]:<port>/, as written — never `localhost`. */
export function isVrRedirect(uri: string): boolean {
  try {
    checkRedirectUri(uri);
    const u = new URL(uri);
    // in its normalized form only (no 0x7f.1, no default port spelled out): what is shown is where it goes
    return u.href === uri && (u.hostname === '127.0.0.1' || u.hostname === '[::1]') && redirectMatches(VR_REDIRECTS, uri);
  } catch {
    return false;
  }
}

/** The name of the API token `lampo login` makes, from the browser or with a password: the same for both. */
export const vrTokenName = (machine: string): string => `lampo on ${machine}`;

/** The computer's name as `lampo login` says it (anyone can start one): one line, no control or direction characters. */
export const vrMachine = (raw: unknown): string => cutChars(cleanName(raw), 64).trim();

const cleanName = (name: unknown): string =>
  cutChars(
    String(name ?? '')
      .toWellFormed()
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters from a self-declared name is the point
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
    100,
  );

const hostOf = (url: unknown): string | null => {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.host : null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- Client ID Metadata Documents

/** Addresses a metadata fetch may never reach: this machine, private networks, link-local (cloud metadata), and more. */
export interface CimdOptions {
  /** Resolves a host name (tests inject addresses). Default: the system resolver, every address. */
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
  /** Extra certificate authorities to trust (tests serve the document with a self-signed certificate). */
  ca?: string | Buffer;
  /** Test servers listen on loopback: allow exactly these `host:port` origins despite the address check. */
  allowOrigins?: string[];
  timeoutMs?: number;
  maxBytes?: number;
}

let cimd: CimdOptions = {};
/** Tests only: how many clients the metadata cache holds. */
export const cachedClients = (): number => cache.size;
/** Tests only: how metadata documents are fetched. Clears the cache. */
export function configureCimd(o: CimdOptions): void {
  cimd = o;
  cache.clear();
}

const defaultResolve = async (host: string) => dns.promises.lookup(host, { all: true, verbatim: true });

/** A client_id that is a metadata document URL: https, a real path, no fragment, credentials or dot segments. */
export function isMetadataClientId(id: string): boolean {
  return /^https:\/\//i.test(id);
}

function checkClientIdUrl(id: string): URL {
  let u: URL;
  try {
    u = new URL(id);
  } catch {
    throw new ClientError('invalid_client', 'client_id is not a valid URL');
  }
  if (u.protocol !== 'https:') throw new ClientError('invalid_client', 'a client_id URL must use https');
  if (u.href !== id) throw new ClientError('invalid_client', 'the client_id URL must be in its normalized form');
  if (u.pathname === '/' || !u.pathname) throw new ClientError('invalid_client', 'a client_id URL needs a path');
  if (u.hash || u.username || u.password) throw new ClientError('invalid_client', 'a client_id URL may not contain a fragment or credentials');
  if (/(^|\/)\.\.?(\/|$)/.test(decodeURIComponent(u.pathname))) throw new ClientError('invalid_client', 'a client_id URL may not contain dot segments');
  return u;
}

interface Cached {
  info?: ClientInfo;
  error?: ClientError;
  until: number;
}
const cache = new Map<string, Cached>();
// Strangers choose the ids (GET /oauth/authorize needs no account): what is remembered stays bounded.
const CACHE_MAX = 500;
function remember(id: string, c: Cached): void {
  if (cache.size >= CACHE_MAX) for (const [k, v] of cache) if (v.until <= Date.now()) cache.delete(k);
  while (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(id, c);
}
const MIN_TTL = 60_000;
const MAX_TTL = 24 * 3600_000;
const DEFAULT_TTL = 3600_000;
const ERROR_TTL = 60_000;

function ttlOf(cacheControl: string | undefined): number {
  const h = String(cacheControl || '');
  if (/no-store|no-cache/.test(h)) return MIN_TTL;
  const m = /max-age=(\d+)/.exec(h);
  return m ? Math.min(MAX_TTL, Math.max(MIN_TTL, Number(m[1]) * 1000)) : DEFAULT_TTL;
}

/** GETs the document over https, connecting only to an address that passed the check. */
function getDocument(u: URL): Promise<{ status: number; body: string; cacheControl?: string }> {
  const timeoutMs = cimd.timeoutMs ?? 5000;
  const maxBytes = cimd.maxBytes ?? 16 * 1024;
  const allowed = cimd.allowOrigins?.includes(u.host) ?? false;
  const resolve = cimd.resolve ?? defaultResolve;
  return new Promise((ok, fail) => {
    const pick = async (host: string): Promise<{ address: string; family: number }> => {
      const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await resolve(host);
      if (!addrs.length) throw new ClientError('invalid_client', `${host} does not resolve`);
      // Every address must be public: a mixed answer is how rebinding attacks sneak an internal one in.
      if (!allowed && addrs.some((a) => isBlockedAddress(a.address))) throw new ClientError('invalid_client', `${host} resolves to a private address`);
      return addrs[0];
    };
    const host = u.hostname.replace(/^\[|\]$/g, '');
    pick(host).then((addr) => {
      const req = https.request(
        {
          host: addr.address,
          servername: net.isIP(host) ? undefined : host,
          port: u.port || 443,
          path: `${u.pathname}${u.search}`,
          method: 'GET',
          headers: { Host: u.host, Accept: 'application/json', 'User-Agent': 'lampo (oauth client metadata)' },
          ca: cimd.ca,
          timeout: timeoutMs,
          // The address is already chosen; never let the agent resolve again.
          lookup: (_h, opts, cb) => (opts?.all ? cb(null, [addr]) : cb(null, addr.address, addr.family)),
        } as https.RequestOptions,
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (d: Buffer) => {
            size += d.length;
            if (size > maxBytes) {
              req.destroy(new ClientError('invalid_client', 'the client metadata document is too large'));
              return;
            }
            chunks.push(d);
          });
          res.on('end', () => ok({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8'), cacheControl: res.headers['cache-control'] }));
          res.on('error', fail);
        },
      );
      // `timeout` is the socket's idle time: a server that sends a byte now and then keeps it from firing. The whole
      // fetch has the same deadline.
      const late = () => req.destroy(new ClientError('invalid_client', 'the client metadata document did not load in time'));
      const deadline = setTimeout(late, timeoutMs);
      req.on('close', () => clearTimeout(deadline));
      req.on('timeout', late);
      req.on('error', (e) =>
        fail(e instanceof ClientError ? e : new ClientError('invalid_client', `could not load the client metadata document: ${e.message}`)),
      );
      req.end();
    }, fail);
  });
}

/** The client behind a metadata-document client_id, validated (MCP 2026-07-28 client registration, draft-ietf-oauth-client-id-metadata-document). */
async function fetchMetadataClient(id: string): Promise<ClientInfo> {
  const hit = cache.get(id);
  if (hit && hit.until > Date.now()) {
    if (hit.error) throw hit.error;
    if (hit.info) return hit.info;
  }
  const u = checkClientIdUrl(id);
  try {
    const res = await getDocument(u);
    if (res.status !== 200) throw new ClientError('invalid_client', `the client metadata document answered ${res.status}`);
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(res.body);
    } catch {
      throw new ClientError('invalid_client', 'the client metadata document is not JSON');
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new ClientError('invalid_client', 'the client metadata document is not a JSON object');
    if (doc.client_id !== id) throw new ClientError('invalid_client', 'the client metadata document names a different client_id');
    if ('client_secret' in doc || 'client_secret_expires_at' in doc)
      throw new ClientError('invalid_client', 'a client metadata document may not carry a secret');
    // The methods the client can use: the plural list when it gives one (MCP SEP-3149: ChatGPT's document lists `none`
    // and `private_key_jwt`, with the singular as its preference among them), else its one method. This server takes
    // public clients with PKCE only, and its metadata says so: a client that can't be one is refused.
    const methods = Array.isArray(doc.token_endpoint_auth_methods_supported)
      ? doc.token_endpoint_auth_methods_supported
      : [doc.token_endpoint_auth_method ?? 'none'];
    if (!methods.includes('none'))
      throw new ClientError(
        'invalid_client',
        `this server accepts public clients with PKCE only (token_endpoint_auth_method "${String(doc.token_endpoint_auth_method ?? methods.join(' '))}")`,
      );
    const name = cleanName(doc.client_name);
    if (!name) throw new ClientError('invalid_client', 'the client metadata document has no client_name');
    const uris = doc.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 20 || !uris.every((x) => typeof x === 'string'))
      throw new ClientError('invalid_client', 'the client metadata document needs redirect_uris');
    const info: ClientInfo = { client_id: id, kind: 'cimd', name, host: u.host, redirect_uris: uris.map((x) => checkRedirectUri(x as string)), auth: 'none' };
    remember(id, { info, until: Date.now() + ttlOf(res.cacheControl) });
    return info;
  } catch (e) {
    const err = e instanceof ClientError ? e : new ClientError('invalid_client', (e as Error).message);
    remember(id, { error: err, until: Date.now() + ERROR_TTL });
    throw err;
  }
}

// ---------------------------------------------------------------- Dynamic Client Registration

interface StoredClient {
  client_id: string;
  client_name: string;
  client_uri: string | null;
  redirect_uris: string[];
  application_type: 'web' | 'native';
  token_endpoint_auth_method: AuthMethod;
  /** sha256 of the client secret (confidential clients only). */
  secret_hash: string | null;
  grant_types: string[];
  created: string;
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

function loadClients(): StoredClient[] {
  try {
    return (JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8')) as { clients?: StoredClient[] }).clients || [];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

function saveClients(clients: StoredClient[]): void {
  fs.mkdirSync(OAUTH_DIR, { recursive: true, mode: 0o700 });
  writeAtomic(CLIENTS_FILE, `${JSON.stringify({ clients }, null, 2)}\n`);
  fs.chmodSync(CLIENTS_FILE, 0o600);
}

/** At most this many registrations are kept; the oldest unused ones go first (registration needs no account). */
const MAX_CLIENTS = 500;

export interface RegisterOptions {
  /** Whether someone is connected with this client (a live grant): it is never evicted to make room. */
  inUse?: (clientId: string) => boolean;
  /** Registrations kept at most (tests). */
  max?: number;
}

/** The ids of the registered clients, oldest first. */
export const knownClientIds = (): string[] => loadClients().map((c) => c.client_id);

/**
 * An RFC 7591 registration body, by its schema (zod on every input, A12 INV-9): lists are lists of strings, one value
 * is one string. Metadata this server doesn't know (logo_uri, contacts, …) is ignored, as the RFC asks. `client_name`
 * stays any value: whatever an app calls itself is cleaned to one line of text (cleanName), or "Unnamed app".
 */
const Registration = z.object({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(20),
  client_name: z.unknown().optional(),
  client_uri: z.string().max(2000).optional(),
  application_type: z.string().max(40).optional(),
  token_endpoint_auth_method: z.string().max(60).optional(),
  grant_types: z.array(z.string().max(60)).max(10).optional(),
  response_types: z.array(z.string().max(60)).max(10).optional(),
  scope: z.string().max(1000).optional(),
});
export type RegistrationRequest = Record<string, unknown>;

/** RFC 7591 registration. Returns the response body (with the secret, shown once, for confidential clients). */
export function registerClient(body: RegistrationRequest, { inUse = () => false, max = MAX_CLIENTS }: RegisterOptions = {}): Record<string, unknown> {
  const parsed = Registration.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.path[0] === 'redirect_uris') throw new ClientError('invalid_redirect_uri', 'redirect_uris must be a list of 1–20 URIs');
    throw new ClientError('invalid_client_metadata', `${issue?.path.join('.') || 'the registration'}: ${issue?.message || 'malformed'}`);
  }
  const req = parsed.data;
  const redirect_uris = req.redirect_uris.map((x) => checkRedirectUri(x));
  const method = req.token_endpoint_auth_method ?? 'none';
  if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method))
    throw new ClientError(
      'invalid_client_metadata',
      `token_endpoint_auth_method ${method} is not supported (use none, client_secret_post or client_secret_basic)`,
    );
  const grants = req.grant_types ?? ['authorization_code', 'refresh_token'];
  if (!grants.includes('authorization_code') || grants.some((g) => g !== 'authorization_code' && g !== 'refresh_token'))
    throw new ClientError('invalid_client_metadata', 'grant_types may only be authorization_code and refresh_token');
  if (req.response_types?.some((r) => r !== 'code')) throw new ClientError('invalid_client_metadata', 'response_types may only be code');
  // OIDC registration: a web client must not use loopback or custom-scheme redirects, a native one may (MCP 2026-07-28).
  const nativeUris = redirect_uris.some((u) => isLoopbackRedirect(u) || !u.startsWith('https:'));
  const application_type = req.application_type === 'web' || req.application_type === 'native' ? req.application_type : nativeUris ? 'native' : 'web';
  if (application_type === 'web' && nativeUris)
    throw new ClientError(
      'invalid_redirect_uri',
      'a web application registers https redirect URIs only; use application_type "native" for localhost or app schemes',
    );
  const client_name = cleanName(req.client_name) || 'Unnamed app';
  const client_uri = req.client_uri && hostOf(req.client_uri) ? req.client_uri : null;
  const client_id = `vrc_${crypto.randomBytes(16).toString('base64url')}`;
  const secret = method === 'none' ? null : `vrs_${crypto.randomBytes(24).toString('base64url')}`;
  const stored: StoredClient = {
    client_id,
    client_name,
    client_uri,
    redirect_uris,
    application_type,
    token_endpoint_auth_method: method as AuthMethod,
    secret_hash: secret ? sha256(secret) : null,
    grant_types: [...new Set(grants)],
    created: isoLocal(),
  };
  withLock(LOCK_DIR, () => {
    const all = loadClients();
    // Full: the oldest registration nobody is connected with makes room. A flood of strangers' registrations must
    // never disconnect someone's app, so when every kept client is in use, the new one is refused instead.
    while (all.length >= max) {
      const i = all.findIndex((c) => !inUse(c.client_id));
      if (i < 0) throw new ClientError('invalid_client_metadata', 'too many registered apps right now; try again later');
      all.splice(i, 1);
    }
    all.push(stored);
    saveClients(all);
  });
  return {
    client_id,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name,
    ...(client_uri ? { client_uri } : {}),
    redirect_uris,
    application_type,
    token_endpoint_auth_method: method,
    grant_types: stored.grant_types,
    response_types: ['code'],
  };
}

function registeredClient(id: string): ClientInfo | null {
  const c = loadClients().find((x) => x.client_id === id);
  if (!c) return null;
  return {
    client_id: c.client_id,
    kind: 'dcr',
    name: c.client_name,
    host: hostOf(c.client_uri),
    redirect_uris: c.redirect_uris,
    auth: c.token_endpoint_auth_method,
  };
}

/** Checks a registered client's secret (confidential DCR clients). Public clients have none and pass with none. */
export function clientSecretMatches(id: string, secret: string | null): boolean {
  const c = loadClients().find((x) => x.client_id === id);
  if (!c) return false;
  if (!c.secret_hash) return secret === null;
  if (!secret) return false;
  const a = Buffer.from(sha256(secret));
  const b = Buffer.from(c.secret_hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The client behind a client_id: a metadata document URL or a registration. Throws ClientError when unknown. */
export async function resolveClient(id: string): Promise<ClientInfo> {
  if (!id || id.length > 500) throw new ClientError('invalid_client', 'missing or overlong client_id');
  if (isMetadataClientId(id)) return fetchMetadataClient(id);
  const c = registeredClient(id);
  if (!c) throw new ClientError('invalid_client', 'unknown client_id: register first (or use a client ID metadata document URL)');
  return c;
}
