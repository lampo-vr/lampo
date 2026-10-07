// Optional settings in config.json (see paths.ts for where it is looked up), overridable by environment variables
// so a container can be configured without a file. Everything has a sane default.
import fs from 'node:fs';
import net from 'node:net';
import { type SettingName, settingsIn, spelledAs } from './env.ts';
import { type LegalUrls, legalConfig, legalProblems } from './legal.ts';
import { type MailConfig, mailConfig, mailProblems, type SignupMode, signupConfig } from './mail/config.ts';
import { type ConfigFile, readConfigFile, type StorageConfig, type SttConfig, USER } from './paths.ts';
import { endpointsProblems } from './publish/net.ts';

export type Mode = 'local' | 'server';

export interface Config extends Omit<ConfigFile, 'mail' | 'signup' | 'terms_url' | 'privacy_url' | keyof LegalUrls>, LegalUrls {
  mode: Mode;
  host: string;
  port: number;
  public_url: string | null;
  /** The app's own media host (LAMPO_MEDIA_ORIGIN): video by signed URLs on a host of its own (lib/storage/mediaHost.ts). */
  media_origin: string | null;
  /** Where network users get the source (AGPL-3.0 §13): source_url / LAMPO_SOURCE_URL, else package.json's repository
   * (the project's own: right for an unmodified copy; a fork points it at itself). */
  source_url: string | null;
  /** Proxies whose forwarding headers count (trustProxy), or false. */
  trust_proxy: false | string;
  /** trust_proxy was given in an old form (`true`, a hop count): the server warns at start. */
  trust_proxy_legacy: boolean;
  /** trust_proxy was set at all (`false` included): a hosted server behind https must say which proxy ends TLS. */
  trust_proxy_set: boolean;
  upload_max_bytes: number;
  storage: StorageConfig;
  stt: SttConfig;
  /** Author name for notes made in the local UI: config.json "user" > LAMPO_USER > OS account name. */
  user: string;
  /** How email goes out (lib/mail/config.ts): SMTP, or the log transport (<cache>/outbox/). */
  mail: MailConfig;
  /** Who may sign up on their own: off, invite (invited addresses), open (anyone; needs workspaces). */
  signup: SignupMode;
  terms_url: string | null;
  privacy_url: string | null;
  /**
   * Who runs this server, for its operator pages (lib/operator.ts): account addresses or ids from LAMPO_OPERATOR. Empty:
   * the owners of its first workspace.
   */
  operators: string[];
}

const DEFAULTS = {
  port: 4747,
  public_url: null,
  media_origin: null,
  source_url: null,
  upload_max_bytes: 20e9,
  min_free_bytes: 2e9,
};

const STT_DEFAULTS: SttConfig = {
  backend: 'local',
  model: 'auto',
  languages: [],
  vocabulary: [],
  threads: 0,
  idle_unload_minutes: 30,
  prefetch: false,
  models_dir: null,
  http: null,
};

/** "20GB", "500 MB", "1e9" or plain bytes. */
export function parseBytes(v: string | number | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  if (typeof v === 'number') return v;
  const m = /^\s*([\d.]+(?:e\d+)?)\s*([kmgt]?)i?b?\s*$/i.exec(v);
  if (!m) throw new Error(`not a size: ${v}`);
  return Math.round(Number(m[1]) * 1000 ** ' kmgt'.indexOf((m[2] || ' ').toLowerCase()));
}

/** Named ranges Express understands (proxy-addr): this machine, link-local, private networks. */
const TRUST_NAMES = new Set(['loopback', 'linklocal', 'uniquelocal']);
/** What the old forms (`true`, a hop count) mean now: a proxy on this machine or on a private network. */
const LEGACY_TRUST = 'loopback, uniquelocal';

/**
 * Which proxies may tell us the client's address and scheme (X-Forwarded-*): named ranges, addresses or subnets,
 * never "whoever connects". `true` and hop counts believed anyone who reached the port, so a client talking to the
 * app directly could name its own address and slip past every per-address limit; they now mean LEGACY_TRUST (the
 * setups the docs describe: Caddy on this machine or in the compose network), and the server warns at start.
 */
export function trustProxy(v: string | number | boolean): { value: false | string; legacy: boolean } {
  const s = String(v).trim();
  if (s === 'false' || s === '' || s === '0') return { value: false, legacy: false };
  if (s === 'true' || /^\d+$/.test(s)) return { value: LEGACY_TRUST, legacy: true };
  const entries = s.split(',').map((e) => e.trim());
  for (const e of entries) {
    const [ip, bits, extra] = e.split('/');
    const family = net.isIP(ip ?? '');
    const prefixOk = bits === undefined || (/^\d+$/.test(bits) && Number(bits) <= (family === 6 ? 128 : 32));
    if (!TRUST_NAMES.has(e) && !(family && prefixOk && extra === undefined))
      throw new Error(`LAMPO_TRUST_PROXY: "${e}" is not an address, a subnet or one of loopback, linklocal, uniquelocal`);
  }
  return { value: entries.join(', '), legacy: false };
}

/** The `repository` of package.json as a web URL ("git+https://host/x.git" → "https://host/x"), or null. */
export function repositoryUrl(pkg: { repository?: string | { url?: string } }): string | null {
  const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (!raw) return null;
  const url = raw
    .replace(/^git\+/, '')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\.git$/, '');
  return /^https?:\/\//.test(url) ? url : null;
}

const PACKAGE = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { repository?: string | { url?: string } };

// Only the variables that are set, so they layer over config.json.
function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as Partial<T>;
}

// LAMPO_STORAGE=bunny|s3 plus LAMPO_BUNNY_* / LAMPO_S3_* layer over the config.json "storage" section.
function storageConfig(base: StorageConfig | undefined, env: NodeJS.ProcessEnv): StorageConfig {
  const s = settingsIn(env);
  const kind = (s.LAMPO_STORAGE as StorageConfig['kind'] | undefined) || base?.kind || 'local';
  const out: StorageConfig = { ...base, kind };
  const bunny = {
    ...base?.bunny,
    ...defined({
      zone: s.LAMPO_BUNNY_ZONE,
      access_key: s.LAMPO_BUNNY_ACCESS_KEY,
      region: s.LAMPO_BUNNY_REGION,
      cdn_url: s.LAMPO_BUNNY_CDN_URL,
      token_key: s.LAMPO_BUNNY_TOKEN_KEY,
      prefix: s.LAMPO_BUNNY_PREFIX,
      storage_url: s.LAMPO_BUNNY_STORAGE_URL,
    }),
  };
  if (Object.keys(bunny).length) out.bunny = bunny as StorageConfig['bunny'];
  const s3 = {
    ...base?.s3,
    ...defined({
      endpoint: s.LAMPO_S3_ENDPOINT,
      region: s.LAMPO_S3_REGION,
      bucket: s.LAMPO_S3_BUCKET,
      access_key_id: s.LAMPO_S3_ACCESS_KEY_ID,
      secret_access_key: s.LAMPO_S3_SECRET_ACCESS_KEY,
      prefix: s.LAMPO_S3_PREFIX,
      presign: s.LAMPO_S3_PRESIGN === undefined ? undefined : s.LAMPO_S3_PRESIGN !== 'false',
    }),
  };
  if (Object.keys(s3).length) out.s3 = s3 as StorageConfig['s3'];
  const work = parseBytes(s.LAMPO_WORK_CACHE);
  if (work) out.work_cache_bytes = work;
  return out;
}

const list = (v: string) =>
  v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
const flag = (v: string) => !/^(0|false|no|off)$/i.test(v.trim());

// LAMPO_STT_* layer over the config.json "stt" section. An old `whisper_language: "de"` (from the Python/MLX days)
// becomes languages ["de", "en"]: auto-detect, with German as the fallback.
export function sttConfig(file: ConfigFile, env: NodeJS.ProcessEnv = process.env): SttConfig {
  const s = settingsIn(env);
  const base = file.stt || {};
  const migrated = file.whisper_language ? [...new Set([file.whisper_language.toLowerCase(), 'en'])] : [];
  const out: SttConfig = {
    ...STT_DEFAULTS,
    ...base,
    languages: (base.languages ?? migrated).map((l) => l.toLowerCase()),
    vocabulary: base.vocabulary ?? [],
    http: base.http ? { ...base.http } : null,
  };
  if (s.LAMPO_STT) {
    if (!['local', 'http', 'off'].includes(s.LAMPO_STT)) throw new Error(`LAMPO_STT must be local, http or off (got "${s.LAMPO_STT}")`);
    out.backend = s.LAMPO_STT as SttConfig['backend'];
  }
  if (s.LAMPO_STT_MODEL) out.model = s.LAMPO_STT_MODEL;
  if (s.LAMPO_STT_LANGUAGES !== undefined) out.languages = list(s.LAMPO_STT_LANGUAGES.toLowerCase());
  if (s.LAMPO_STT_VOCABULARY !== undefined) out.vocabulary = list(s.LAMPO_STT_VOCABULARY);
  if (s.LAMPO_STT_THREADS) out.threads = Number(s.LAMPO_STT_THREADS);
  if (s.LAMPO_STT_IDLE_MINUTES) out.idle_unload_minutes = Number(s.LAMPO_STT_IDLE_MINUTES);
  if (s.LAMPO_STT_PREFETCH) out.prefetch = flag(s.LAMPO_STT_PREFETCH);
  if (s.LAMPO_STT_MODELS_DIR) out.models_dir = s.LAMPO_STT_MODELS_DIR;
  if (s.LAMPO_STT_URL) out.http = { ...out.http, url: s.LAMPO_STT_URL };
  if (out.http && s.LAMPO_STT_API_KEY) out.http.api_key = s.LAMPO_STT_API_KEY;
  if (out.http && s.LAMPO_STT_HTTP_MODEL) out.http.model = s.LAMPO_STT_HTTP_MODEL;
  return out;
}

/**
 * Settings the server must not start with. A hosted server without its public URL serves any Host header (DNS
 * rebinding), takes the OAuth issuer from the request and may not mark cookies Secure behind a TLS proxy; a local test
 * can still run one with LAMPO_ALLOW_NO_PUBLIC_URL=1 (and /readyz then says it isn't ready).
 */
export function startupProblems(cfg: Config, env: NodeJS.ProcessEnv = process.env, { signupSeam = false }: { signupSeam?: boolean } = {}): string[] {
  const s = settingsIn(env);
  // a setting named as the operator wrote it (VR_ or LAMPO_), a setting to set by its new name
  const say = (name: SettingName) => spelledAs(name, env);
  const problems: string[] = [];
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535)
    problems.push(`${say('LAMPO_PORT')} must be a port number from 1 to 65535 (got "${s.LAMPO_PORT ?? cfg.port}").`);
  if (!['local', 'bunny', 's3'].includes(cfg.storage.kind))
    problems.push(`${say('LAMPO_STORAGE')} must be local, bunny or s3 (got "${cfg.storage.kind}"); see docs/server-mode.md#storage.`);
  // Email and sign-up, in either mode (docs/email.md).
  problems.push(...mailProblems(cfg, { signupSeam }));
  problems.push(...legalProblems(cfg));
  // read by the publishing queue as the server starts: a stack trace then, after the store may have been moved
  problems.push(...endpointsProblems(env));
  if (cfg.mode !== 'server') return problems;
  if (!cfg.public_url) {
    if (!flag(s.LAMPO_ALLOW_NO_PUBLIC_URL || '0'))
      problems.push(
        `server mode needs ${say('LAMPO_PUBLIC_URL')}, the URL people open (e.g. https://review.example.com): without it any host name is served and cookies may not be Secure. For a local test only: ${say('LAMPO_ALLOW_NO_PUBLIC_URL')}=1.`,
      );
  } else problems.push(...publicUrlProblems(cfg, env));
  if (cfg.media_origin) problems.push(...mediaOriginProblems(cfg, env));
  const bunny = cfg.storage.kind === 'bunny' ? cfg.storage.bunny : undefined;
  if (bunny?.cdn_url && !bunny.token_key)
    problems.push(
      `${say('LAMPO_BUNNY_CDN_URL')} is set without ${say('LAMPO_BUNNY_TOKEN_KEY')}: the player would get unsigned CDN addresses, and anyone who has or guesses one could watch the render. Turn on Token Authentication on the pull zone and set its key, or leave ${say('LAMPO_BUNNY_CDN_URL')} out to stream through the server (docs/server-mode.md#bunny-storage--cdn).`,
    );
  return problems;
}

/** A host name that is this machine: plain http is fine there (nothing crosses a network). */
const loopbackHost = (host: string) => host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);

/**
 * What a hosted server's public URL must be: an origin people open (no path: the app is served from the root of its
 * host), over https unless it is this machine (passwords and cookies would cross the network in the clear), and with
 * https the TLS proxy in front named in LAMPO_TRUST_PROXY (the app speaks plain http, so an https URL means a proxy, and
 * without trusting it every visitor shares its address: one person's wrong passwords would lock everyone out).
 */
function publicUrlProblems(cfg: Config, env: NodeJS.ProcessEnv): string[] {
  const s = settingsIn(env);
  // a setting named as the operator wrote it (VR_ or LAMPO_), a setting to set by its new name
  const say = (name: SettingName) => spelledAs(name, env);
  const raw = cfg.public_url ?? '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return [`${say('LAMPO_PUBLIC_URL')} must be the address people open, with its scheme, like https://review.example.com (got "${raw}").`];
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return [`${say('LAMPO_PUBLIC_URL')} must start with https:// (got "${raw}").`];
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    return [
      `${say('LAMPO_PUBLIC_URL')} must be only the scheme and host, like https://review.example.com (got "${raw}"): Lampo is served from the root of its own host name, not under a path.`,
    ];
  const problems: string[] = [];
  if (url.protocol === 'http:' && !loopbackHost(url.hostname) && !flag(s.LAMPO_ALLOW_HTTP || '0'))
    problems.push(
      `${say('LAMPO_PUBLIC_URL')} is plain http on a host other than this machine (${url.host}): passwords, session cookies and review-link passwords would cross the network unencrypted. Put the app behind a TLS proxy and use https:// (docs/go-live.md); on a closed test network only: ${say('LAMPO_ALLOW_HTTP')}=1.`,
    );
  if (url.protocol === 'https:' && !cfg.trust_proxy_set)
    problems.push(
      `${say('LAMPO_PUBLIC_URL')} is https, so a proxy in front of the app ends TLS (the app itself speaks plain http): name that proxy in ${say('LAMPO_TRUST_PROXY')} — loopback for Caddy on this machine, uniquelocal for the compose network, or its address. Without it every visitor looks like the proxy: one person guessing passwords would lock everyone out of signing in. If your proxy really forwards no addresses: ${say('LAMPO_TRUST_PROXY')}=false.`,
    );
  return problems;
}

/**
 * What the media host (LAMPO_MEDIA_ORIGIN) must be: an origin of its own (scheme and host, no path), https unless it is
 * this machine, and another host than the public URL's — it serves video by signed URLs and nothing else, and the
 * app's sign-in cookie must never reach it.
 */
function mediaOriginProblems(cfg: Config, env: NodeJS.ProcessEnv): string[] {
  const s = settingsIn(env);
  // a setting named as the operator wrote it (VR_ or LAMPO_), a setting to set by its new name
  const say = (name: SettingName) => spelledAs(name, env);
  const raw = cfg.media_origin ?? '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return [`${say('LAMPO_MEDIA_ORIGIN')} must be an address with its scheme, like https://media.example.com (got "${raw}").`];
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return [`${say('LAMPO_MEDIA_ORIGIN')} must start with https:// (got "${raw}").`];
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    return [
      `${say('LAMPO_MEDIA_ORIGIN')} must be only the scheme and host, like https://media.example.com (got "${raw}"): signed URLs are served from the root of its host.`,
    ];
  const problems: string[] = [];
  if (url.protocol === 'http:' && !loopbackHost(url.hostname) && !flag(s.LAMPO_ALLOW_HTTP || '0'))
    problems.push(
      `${say('LAMPO_MEDIA_ORIGIN')} is plain http on a host other than this machine (${url.host}): its signed URLs would cross the network readable by anyone on the way. Give it https (docs/server-mode.md#a-host-of-its-own-for-video).`,
    );
  let app: URL | null = null;
  try {
    app = cfg.public_url ? new URL(cfg.public_url) : null;
  } catch {}
  if (app && app.hostname === url.hostname)
    problems.push(
      `${say('LAMPO_MEDIA_ORIGIN')} must be a host name of its own, not ${say('LAMPO_PUBLIC_URL')}'s (${url.hostname}): it answers signed media URLs only, and the app's sign-in must never reach it.`,
    );
  return problems;
}

/** The most entries LAMPO_OPERATOR may name (a few people run a server; the rest is ignored). */
export const OPERATORS_MAX = 20;

/**
 * LAMPO_OPERATOR: the accounts that run this server, by address or id, separated by commas or spaces. Lower case (ids
 * are lower case, addresses compare so), each at most an address long, the first OPERATORS_MAX of them.
 */
export function operatorList(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? '').split(/[\s,;]+/)) {
    const v = part.trim().toLowerCase();
    if (v && v.length <= 254 && !out.includes(v)) out.push(v);
  }
  return out.slice(0, OPERATORS_MAX);
}

/** How many workspaces one account may make where anyone may make them (LAMPO_WORKSPACE_CREATE=anyone). */
export const WORKSPACE_CREATE_LIMIT = 3;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const s = settingsIn(env);
  const file = readConfigFile();
  const mode: Mode = (s.LAMPO_MODE || file.mode) === 'server' ? 'server' : 'local';
  const trustRaw = s.LAMPO_TRUST_PROXY || file.trust_proxy;
  const trust = trustProxy(trustRaw || false);
  const cfg: Config = {
    ...DEFAULTS,
    ...file,
    trust_proxy: trust.value,
    trust_proxy_legacy: trust.legacy,
    trust_proxy_set: trustRaw !== undefined && trustRaw !== null && String(trustRaw).trim() !== '',
    mode,
    host: s.LAMPO_HOST || file.host || (mode === 'server' ? '0.0.0.0' : '127.0.0.1'),
    storage: storageConfig(file.storage, env),
    stt: sttConfig(file, env),
    user: USER,
    mail: mailConfig(file, env),
    ...signupConfig(file, env),
    ...legalConfig(file, env),
    operators: operatorList(s.LAMPO_OPERATOR),
  };
  if (s.LAMPO_PORT) cfg.port = Number(s.LAMPO_PORT);
  if (s.LAMPO_PUBLIC_URL) cfg.public_url = s.LAMPO_PUBLIC_URL;
  if (cfg.public_url) cfg.public_url = cfg.public_url.replace(/\/+$/, '');
  cfg.media_origin = (s.LAMPO_MEDIA_ORIGIN || file.media_origin || '').trim().replace(/\/+$/, '') || null;
  cfg.source_url = s.LAMPO_SOURCE_URL || file.source_url || repositoryUrl(PACKAGE);
  if (s.LAMPO_ORG_NAME !== undefined) cfg.org_name = s.LAMPO_ORG_NAME.trim() || null;
  if (s.LAMPO_PUSH_SUBJECT) cfg.push_subject = s.LAMPO_PUSH_SUBJECT;
  if (s.LAMPO_WEBHOOK_ALLOW_PRIVATE) cfg.webhooks_allow_private = flag(s.LAMPO_WEBHOOK_ALLOW_PRIVATE);
  // Making a workspace is the operator's to hand out (A12-D9): whoever runs one invites people, mails them and takes turns
  // in the job queue, so only whoever runs the server (lib/operator.ts) makes them unless the instance says anyone may — and then each
  // account makes a few. Lampo Cloud's sign-up makes each person's own through placeSignup, not through this.
  const create = s.LAMPO_WORKSPACE_CREATE || file.workspace_create;
  cfg.workspace_create = create === 'anyone' ? 'anyone' : 'owners';
  const limit = s.LAMPO_WORKSPACE_CREATE_LIMIT?.trim() || file.workspace_create_limit;
  cfg.workspace_create_limit = limit !== undefined && Number.isInteger(Number(limit)) && Number(limit) >= 0 ? Number(limit) : WORKSPACE_CREATE_LIMIT;
  if (s.LAMPO_ONBOARDING) cfg.onboarding = flag(s.LAMPO_ONBOARDING);
  if (s.LAMPO_ONBOARDING_SAMPLE) cfg.onboarding_sample = flag(s.LAMPO_ONBOARDING_SAMPLE);
  const max = parseBytes(s.LAMPO_UPLOAD_MAX);
  if (max) cfg.upload_max_bytes = max;
  const minFree = parseBytes(s.LAMPO_MIN_FREE);
  if (minFree !== undefined) cfg.min_free_bytes = minFree;
  return cfg;
}
