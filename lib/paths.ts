// Where everything lives. The data contract: data/<slug>/review.json, slug = abs video path with "/" → "__".
//
// Store location (first match wins):
//   1. LAMPO_DATA=<dir>                → <dir>, versions in <dir>-versions (isolated stores, e.g. tests)
//   2. config.json "data_dir"       → that dir, versions next to it (or "versions_dir")
//   3. <app>/data exists (legacy)   → <app>/data, <app>/versions, <app>/cache  (a checkout used in place)
//   4. fresh install (e.g. npx)     → ~/.video-review/{data,versions,cache}  (LAMPO_HOME moves ~/.video-review, e.g. to a
//                                     container volume: LAMPO_HOME=/data → /data/{data,versions,cache,config.json})
// config.json is read from LAMPO_CONFIG, <app>/config.json or <home>/config.json (first that exists).
// This module reads config.json itself (instead of importing config.ts) so there is no import cycle.
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setting, settings, spelledAs } from './env.ts';
import type { WebhookConfig } from './types.ts';

/** Settings in config.json. Everything is optional; see config.ts for the defaults. */
export interface ConfigFile {
  data_dir?: string;
  versions_dir?: string;
  cache_dir?: string;
  browse_root?: string;
  user?: string;
  port?: number;
  /** Speech-to-text for voice notes (see docs/speech.md). */
  stt?: Partial<SttConfig>;
  /** Footage search (docs/footage.md): "auto" (default: on for the machine, per workspace on a hosted server) or "off"
   * (nothing is indexed, no model is downloaded); LAMPO_FOOTAGE overrides it. */
  footage?: 'auto' | 'off';
  /** Deprecated (the Python/MLX engine is gone): read only to migrate `whisper_language` into `stt.languages`. */
  whisper_python?: string | null;
  whisper_model?: string;
  whisper_language?: string;
  /** "local" (your machine, default) or "server" (hosted: logins, uploads, no file system access). */
  mode?: 'local' | 'server';
  /** Address to listen on (default 127.0.0.1 locally, 0.0.0.0 in server mode). */
  host?: string;
  /** The URL people open, e.g. https://review.example.com (server mode; Host/Origin checks and cookies use it). */
  public_url?: string | null;
  /** A second host name of this server that serves video by signed URLs only, e.g. https://media.example.com (server
   * mode; lib/storage/mediaHost.ts): for an app host behind a front that must not carry video. */
  media_origin?: string | null;
  /** Where people who use this instance over the network get its source code (AGPL-3.0 §13). Default: the
   * `repository` in package.json. Point it at your fork when you run a modified copy. */
  source_url?: string | null;
  /** The team's name (an agency, a studio) shown to clients on review links next to who shared them: org_name / LAMPO_ORG_NAME. */
  org_name?: string | null;
  /** Which proxies may set the client's address and https (addresses, subnets, loopback/uniquelocal/linklocal).
   * `true` and hop counts are read as "loopback, uniquelocal" (lib/config.ts trustProxy). */
  trust_proxy?: boolean | number | string;
  /** Largest accepted upload in bytes (default 20 GB). */
  upload_max_bytes?: number;
  /** Free disk space to keep (default 2 GB): below it the server reports not ready and refuses uploads that don't fit. */
  min_free_bytes?: number;
  /** Where renders and scrub copies live (default: local disk). */
  storage?: StorageConfig;
  /** Webhooks for client activity (see docs/sharing.md). */
  webhooks?: WebhookConfig[];
  /** Server mode: let webhooks go to private addresses too (an internal chat server). Off by default (SSRF). */
  webhooks_allow_private?: boolean;
  /** Contact for push services (VAPID "sub"): mailto:you@example.com or an https URL (see docs/mobile.md). */
  push_subject?: string;
  /** Who may make a new workspace on a hosted server: only whoever runs it (lib/operator.ts; default), or anyone signed in. */
  workspace_create?: 'anyone' | 'owners';
  /**
   * With workspace_create "anyone": how many workspaces one account may make (the one sign-up gave it counts; the owners
   * of workspace #1 have no limit). Default 3.
   */
  workspace_create_limit?: number;
  /** New accounts start with the first run (lib/onboarding.ts); default true. `false` (or LAMPO_ONBOARDING=off) for an
   * instance whose people already know Lampo. Accounts from before stay as they are either way. */
  onboarding?: boolean;
  /** A new first run finds the sample in its library (lib/sample.ts, made in the background when an account starts in a
   * workspace of its own); default true with `onboarding`. `false` (or LAMPO_ONBOARDING_SAMPLE=off): only on request. */
  onboarding_sample?: boolean;
  /** Email (docs/email.md): the SMTP relay and the sender; without smtp_url, messages go to <cache>/outbox/. */
  mail?: { smtp_url?: string; from?: string; reply_to?: string; per_hour?: number };
  /** Who may sign up: off (default), invite (addresses with a pending invite), open (anyone; needs workspaces). */
  signup?: string;
  /** The operator's terms and privacy policy: on the sign-up screen and the checkout; open sign-up needs both. */
  terms_url?: string;
  privacy_url?: string;
  /** The operator's imprint, withdrawal information and contract cancellation page (lib/legal.ts). */
  imprint_url?: string;
  withdrawal_url?: string;
  cancel_url?: string;
}

export interface BunnyConfig {
  /** Storage zone name. */
  zone: string;
  /** Storage zone password (FTP & API access), not the account API key. */
  access_key: string;
  /** Primary region: "" or "de" (Frankfurt), uk, ny, la, sg, se, br, jh, syd. */
  region?: string;
  /** Pull zone in front of the storage zone, e.g. https://acme-review.b-cdn.net; without it the server streams. */
  cdn_url?: string | null;
  /** Pull zone token authentication key; required when the pull zone has token auth on (recommended). */
  token_key?: string | null;
  /** Key prefix inside the zone, e.g. "review" (default: none). */
  prefix?: string;
  /** Override the storage API base URL (tests, or a new region). */
  storage_url?: string;
}

export interface S3Config {
  /** e.g. https://<account>.r2.cloudflarestorage.com, https://fsn1.your-objectstorage.com, http://127.0.0.1:9000 */
  endpoint: string;
  region?: string;
  bucket: string;
  access_key_id: string;
  secret_access_key: string;
  prefix?: string;
  /** Hand the browser presigned URLs instead of streaming through the server (default true). */
  presign?: boolean;
}

export interface SttHttpConfig {
  /** Base URL of an OpenAI-compatible server, e.g. http://gpu-box:8080 (…/v1/audio/transcriptions is appended). */
  url: string;
  api_key?: string;
  /** Model name the server expects (default "whisper-1"). */
  model?: string;
  /** "json" (default) or "verbose_json" (also returns the detected language). */
  response_format?: 'json' | 'verbose_json';
}

export interface SttConfig {
  /** "local" (transcribe.cpp in a worker process, default), "http" (OpenAI-compatible server) or "off". */
  backend: 'local' | 'http' | 'off';
  /** "auto" (Whisper-turbo with a GPU, Parakeet v3 on CPU), whisper-turbo, parakeet-v3, qwen3-asr-1.7b, or a .gguf path. */
  model: string;
  /** Languages the reviewer speaks; a note detected as anything else is transcribed again in the first one. [] = any. */
  languages: string[];
  /** Domain terms for Whisper's prompt (opt-in; guarded against the rare collapse it causes). */
  vocabulary: string[];
  /** CPU threads for the engine (0 = up to 4). */
  threads: number;
  /** Unload the model after this many idle minutes (it takes 1–3 GB of memory). */
  idle_unload_minutes: number;
  /** Download the model at server start instead of on the first voice note. */
  prefetch: boolean;
  /** Where downloaded models live (default <cache>/models). */
  models_dir: string | null;
  http: SttHttpConfig | null;
}

export interface StorageConfig {
  kind: 'local' | 'bunny' | 's3';
  bunny?: BunnyConfig;
  s3?: S3Config;
  /** Local working copies of remote renders (ffmpeg needs files): size cap in bytes (default 20 GB). */
  work_cache_bytes?: number;
}

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOME = os.homedir();
export const APP_HOME = settings.LAMPO_HOME ? path.resolve(settings.LAMPO_HOME) : path.join(HOME, '.video-review');

export const tildify = (p: string): string => (p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p);
export const untildify = (p: string): string => (p === '~' ? HOME : p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p);

export const CONFIG_FILE =
  [settings.LAMPO_CONFIG, path.join(ROOT, 'config.json'), path.join(APP_HOME, 'config.json')].find((f): f is string => !!f && fs.existsSync(f)) ||
  path.join(ROOT, 'config.json');

export function readConfigFile(): ConfigFile {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

const FILE_CFG = readConfigFile();
const cfgPath = (p: string | undefined): string | null => (p ? path.resolve(path.dirname(CONFIG_FILE), untildify(String(p))) : null);

type StoreMode = 'env' | 'config' | 'legacy' | 'home';

function resolveStore(): { mode: StoreMode; data: string; versions: string; cache: string } {
  const cacheOverride = settings.LAMPO_CACHE ? path.resolve(settings.LAMPO_CACHE) : cfgPath(FILE_CFG.cache_dir);
  const legacy = fs.existsSync(path.join(ROOT, 'data'));
  if (settings.LAMPO_DATA) {
    const data = path.resolve(settings.LAMPO_DATA);
    const cache = cacheOverride || (legacy ? path.join(ROOT, 'cache') : path.join(APP_HOME, 'cache'));
    return { mode: 'env', data, versions: `${data}-versions`, cache };
  }
  const versionsOverride = cfgPath(FILE_CFG.versions_dir);
  const dataDir = cfgPath(FILE_CFG.data_dir);
  if (dataDir) {
    const sibling = path.basename(dataDir) === 'data';
    return {
      mode: 'config',
      data: dataDir,
      versions: versionsOverride || (sibling ? path.join(path.dirname(dataDir), 'versions') : `${dataDir}-versions`),
      cache: cacheOverride || (sibling ? path.join(path.dirname(dataDir), 'cache') : `${dataDir}-cache`),
    };
  }
  if (legacy)
    return {
      mode: 'legacy',
      data: path.join(ROOT, 'data'),
      versions: versionsOverride || path.join(ROOT, 'versions'),
      cache: cacheOverride || path.join(ROOT, 'cache'),
    };
  return {
    mode: 'home',
    data: path.join(APP_HOME, 'data'),
    versions: versionsOverride || path.join(APP_HOME, 'versions'),
    cache: cacheOverride || path.join(APP_HOME, 'cache'),
  };
}

const STORE = resolveStore();
export const STORE_MODE = STORE.mode;
export const DATA = STORE.data;
export const CACHE = STORE.cache; // regenerable: posters, waveforms, analysis, proxies
// NOT regenerable: the bytes of every registered render. A separate store (LAMPO_DATA) gets its own, so test stores
// never write into the real one.
export const VERSIONS = STORE.versions;

// ---------------------------------------------------------------- workspaces (lib/scope.ts is the public face)

/** Today's store: `data/` itself, its storage keys and caches unchanged. */
export const DEFAULT_WORKSPACE = 'w1';
/** `w1`, or `w_` + 12 random lower-case letters and digits (never guessable from another tenant's ids). */
export const WORKSPACE_ID = /^w(?:1|_[a-z0-9]{12})$/;

const als = new AsyncLocalStorage<string>();
/** Whether work outside a workspace must be refused (set by lib/workspaces.ts: a hosted server with more than one). */
let strict: () => boolean = () => false;

export class NoWorkspaceError extends Error {
  status = 500;
  constructor() {
    super('no workspace for this work (refused: it would read another workspace)');
  }
}

export function setStrictWorkspaces(check: () => boolean): void {
  strict = check;
}

/** Whether this store has more than one workspace (what makes work outside one an error). */
export const severalWorkspaces = (): boolean => strict();

/**
 * The workspace a process that works on the store directly entered for good (enterProcessWorkspace). Work in such a
 * process whose async context doesn't carry it still belongs to it: a stdio transport's reads start from handles made
 * before the process entered its workspace, so every MCP request over stdio once ran as workspace #1's.
 */
let processWorkspace: string | null = null;

/** The workspace of the work running now. Throws when there is none and the server has several (lib/scope.ts). */
export function currentWorkspace(): string {
  const id = als.getStore() ?? processWorkspace;
  if (id) return id;
  if (strict()) throw new NoWorkspaceError();
  return DEFAULT_WORKSPACE;
}

/** The workspace work was explicitly started for, or null (work outside any request or job). */
export const explicitWorkspace = (): string | null => als.getStore() ?? processWorkspace;

/** Runs fn for workspace `id`: everything it starts (promises, timers, jobs) carries it too. */
export function inWorkspace<T>(id: string, fn: () => T): T {
  if (!WORKSPACE_ID.test(id)) throw new Error(`not a workspace id: ${JSON.stringify(id).slice(0, 40)}`);
  return als.run(id, fn);
}

/**
 * A process that works on the store directly (`lampo`, the stdio MCP server) works in one workspace from its start:
 * LAMPO_WORKSPACE, else workspace #1 — the machine's store, or on a hosted server the operator's own team.
 */
export function enterProcessWorkspace(env: NodeJS.ProcessEnv = process.env): string {
  const id = setting('LAMPO_WORKSPACE', env)?.trim() || DEFAULT_WORKSPACE;
  if (!WORKSPACE_ID.test(id)) throw new Error(`${spelledAs('LAMPO_WORKSPACE', env)} is not a workspace id: ${JSON.stringify(id).slice(0, 40)}`);
  processWorkspace = id;
  als.enterWith(id);
  return id;
}

/**
 * Where a workspace's files live (lib/workspaces.ts). Workspace #1 is the store as it always was: `data/`, `versions/`
 * and `cache/` themselves. Every other one has its own tree inside them, `w/<id>/`, so nothing of one team is ever
 * found by another's paths, and nothing of workspace #1 moves. `data/` itself also holds what belongs to no workspace
 * (accounts, sessions, OAuth, the workspace list).
 */
export function workspaceRoot(id: string): { data: string; versions: string; cache: string } {
  if (id === DEFAULT_WORKSPACE) return { data: DATA, versions: VERSIONS, cache: CACHE };
  if (!WORKSPACE_ID.test(id)) throw new Error(`not a workspace id: ${JSON.stringify(id).slice(0, 40)}`);
  return { data: path.join(DATA, 'w', id), versions: path.join(VERSIONS, 'w', id), cache: path.join(CACHE, 'w', id) };
}
/** The data folder of the workspace this work runs for (lib/scope.ts): reviews, events, links, playbooks, INBOX.md. */
export const dataDir = (): string => workspaceRoot(currentWorkspace()).data;
/** Its disposable caches (posters, waveforms, transcripts …): never shared between workspaces. */
export const cacheDir = (): string => workspaceRoot(currentWorkspace()).cache;
/** Its renders' bytes on this disk (NOT regenerable). */
export const versionsDir = (): string => workspaceRoot(currentWorkspace()).versions;

// Folder the "Add video" browser starts in; project names are relative to it.
// Where "Add video" starts browsing; project names are relative to it (browse_root in config.json, else home).
export const DEV = cfgPath(FILE_CFG.browse_root) || HOME;

// Author name for notes made in the UI: config.json "user" > LAMPO_USER > the OS account name.
export const USER: string =
  FILE_CFG.user ||
  settings.LAMPO_USER ||
  (() => {
    try {
      return os.userInfo().username;
    } catch {
      return 'reviewer';
    }
  })();

export const VIDEO_EXT = ['.mp4', '.mov', '.m4v'];

/** A slug is one directory name, and file systems allow 255 bytes for one (APFS, ext4, …). */
const MAX_SLUG_BYTES = 255;
/** The readable end kept in a long path's slug (the file name and its nearest folders). */
const LONG_SLUG_TAIL = 180;

/** The video's id: its absolute path with `/` → `__`. A path too long for one directory name (deep cloud-drive
 * folders) keeps its start's kind (`__@uploads__` for uploads), the end that says which video, and a hash of the whole
 * path, so two long paths never share a slug. Every slug that fits is exactly as it always was. */
export function slugify(videoPath: string): string {
  const full = path.resolve(videoPath).split('/').join('__');
  if (Buffer.byteLength(full) <= MAX_SLUG_BYTES) return full;
  const hash = crypto.createHash('sha256').update(full).digest('hex').slice(0, 16);
  const head = full.startsWith('__@uploads__') ? '__@uploads__' : '__';
  const chars = [...full];
  let tail = '';
  for (let i = chars.length - 1; i >= 0 && Buffer.byteLength(chars[i] + tail) <= LONG_SLUG_TAIL; i--) tail = chars[i] + tail;
  return `${head}${tail.replace(/^_+/, '')}~${hash}`;
}
/** A slug is one directory name under data/: never a path of its own (slugs arrive in URLs), never longer than a folder
 * name may be (slugify shortens), and never `w`, the folder other workspaces live in (a real slug starts with `__`). */
export const validSlug = (slug: string): boolean =>
  !!slug && slug !== '.' && slug !== '..' && slug !== 'w' && !/[/\\\0]/.test(slug) && Buffer.byteLength(slug) <= MAX_SLUG_BYTES;
/** An id no video can have: nothing by it exists, so whoever asked gets a plain 404 (no stack trace in the log). */
export class NotAVideoError extends Error {
  status = 404;
  constructor(slug: string) {
    super(`not a video id: ${JSON.stringify(slug).slice(0, 80)}`);
  }
}
function checkedSlug(slug: string): string {
  if (!validSlug(slug)) throw new NotAVideoError(slug);
  return slug;
}
export const reviewDir = (slug: string): string => path.join(dataDir(), checkedSlug(slug));
export const reviewFile = (slug: string): string => path.join(dataDir(), checkedSlug(slug), 'review.json');

// "ACME/REELS/acme-talks/ep02_morning-routine" for …/Development/ACME/REELS/acme-talks/ep02_morning-routine/export/x.mp4
export function projectOf(videoPath: string): string {
  const dir = projectDirOf(videoPath);
  for (const base of [DEV, HOME]) {
    if (dir === base) return path.basename(base);
    if (dir.startsWith(`${base}/`)) return dir.slice(base.length + 1);
  }
  return dir;
}

// Folder that holds the project's sources (parent of export/), used to find timeline.json / words.json.
export function projectDirOf(videoPath: string): string {
  const abs = path.resolve(videoPath);
  const i = abs.lastIndexOf('/export/');
  return i >= 0 ? abs.slice(0, i) : path.dirname(abs);
}

export function isoLocal(d = new Date()): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const p = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(off / 60)}:${p(off % 60)}`
  );
}

/**
 * Whether other accounts on this machine can open `dir` — every folder above it lets others through and it lets them
 * read or enter it — and so read the store's reviews, notes and agents' logs: the reason in words, or null. `stopAt`:
 * where the walk up ends (tests; default: the root).
 */
export function openToOthers(dir: string, stopAt = path.parse(path.resolve(dir)).root): string | null {
  const target = path.resolve(dir);
  let st: fs.Stats;
  try {
    st = fs.statSync(target);
  } catch {
    return null;
  }
  if (!(st.mode & 0o005)) return null;
  for (let d = path.dirname(target); ; d = path.dirname(d)) {
    try {
      if (!(fs.statSync(d).mode & 0o001)) return null;
    } catch {
      return null;
    }
    if (d === path.resolve(stopAt) || path.dirname(d) === d) break;
  }
  return `${target} can be opened by other accounts on this machine (mode ${(st.mode & 0o777).toString(8)})`;
}
