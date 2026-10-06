// Where the bytes of renders (and their scrub copies) live. Keys are store-relative paths:
//   versions/<slug>/v<N>.<ext>     every registered render (NOT regenerable)
//   previews/<slug>/<p_id>.<ext>   fix previews agents attach to notes (NOT regenerable; locally in data/<slug>/previews)
//   refs/<slug>/<r_id>[.t|.s|.e].<ext>   references on notes: images, clips and their stills (NOT regenerable; data/<slug>/refs)
//   scrub/<key>.mp4, proxies/<key>.mp4     playback copies (regenerable; lib/renderKey.ts)
//   avatars/<user>-<hash>.jpg     profile pictures (accounts belong to no workspace: rootStorage(); locally data/avatars)
//   asks/<c_id>/<r_id>[.t|.s].<ext>   pictures, clips and sounds of a question asked on a folder (lib/asks.ts; data/asks)
// Every workspace but #1 has its keys under `w/<id>/` (lib/workspaces.ts): `storage()` hands out a view that adds the
// prefix of the workspace running now, so no key of one team can name another's file. Workspace #1's keys stay as
// they always were.
// `local` keeps today's layout (versions/ and cache/ on this disk). `bunny` and `s3` keep the authoritative copy
// remotely and a size-capped local working copy for ffmpeg (grabbing frames, waveforms, pre-review, diffs), and hand
// the browser signed URLs so video bytes don't pass through the server.
// Remote storage is a server-mode feature: in local mode renders are files on your own disk anyway.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.ts';
import { CACHE, NotAVideoError, type StorageConfig, VERSIONS, validSlug, workspaceRoot } from '../paths.ts';
import { internal } from '../publicError.ts';
import { currentWorkspace, DEFAULT_WORKSPACE } from '../scope.ts';
import { createBunnyStore } from './bunny.ts';
import { mediaFileUrl } from './mediaHost.ts';
import { createS3Store } from './s3.ts';

/**
 * How long a signed storage URL the server hands out stays valid. The team's player gets hours. A review link's visitor
 * gets minutes (A12 GUEST-11): the URL carries no cookie and no check of the link, so it is what keeps working after
 * the link is revoked, expires or gets a password — and what a visitor can pass on. Short URLs keep the bytes coming
 * from the CDN or bucket (a proxy through the server would put every viewer's bytes on its own line and skip the CDN);
 * the server checks the link again on every redirect, and the player asks for a fresh one when an old one stops
 * working (web/src/player/recover.ts).
 */
export const SIGNED_URL_SECONDS = { team: 6 * 3600, guest: 5 * 60 } as const;

export interface RemoteStore {
  readonly kind: 'bunny' | 's3';
  /** Upload a local file under key. */
  put(key: string, file: string, contentType?: string): Promise<void>;
  /** Download key to a local file. */
  get(key: string, file: string): Promise<void>;
  /** Bytes start..end (inclusive) of key, streamed (a ranged GET; nothing is written to disk). */
  read(key: string, start: number, end: number): AsyncIterable<Buffer>;
  /** Throws when the store can't be reached or the credentials are wrong (readiness). */
  check(): Promise<void>;
  /** Delete one key, or everything under a prefix ending in "/". */
  remove(keyOrPrefix: string): Promise<void>;
  /** A URL the browser can fetch directly (signed, expiring), or null to stream through the server. */
  url(key: string, expiresIn: number): string | null;
  /** Origins url() points at (for the Content-Security-Policy). */
  origins(): string[];
}

export interface Storage {
  readonly kind: StorageConfig['kind'];
  /** Where key lives (or would be cached) on this disk. */
  localPath(key: string): string;
  /** True when the bytes exist somewhere (on disk, or stored remotely). */
  has(key: string): boolean;
  /** The bytes as a local file, downloading a working copy when needed; null when they are gone. */
  ensureLocal(key: string): Promise<string | null>;
  /** Bytes start..end (inclusive), from this disk when a copy is here, else streamed from the store (not cached). */
  read(key: string, start: number, end: number): AsyncIterable<Buffer>;
  /** The size in bytes when it is known without a download (a local copy, or recorded when stored), else null. */
  size(key: string): number | null;
  /** Throws when the storage isn't usable (readiness). */
  check(): Promise<void>;
  /**
   * Takes over a finished local file as `key` (moved, or copied when `keep`), and for remote stores uploads it before
   * resolving.
   */
  put(key: string, file: string, opts?: { keep?: boolean; contentType?: string }): Promise<void>;
  /** Marks a file written in place at localPath(key) as done (remote stores upload it). */
  commit(key: string, contentType?: string): Promise<void>;
  remove(keyOrPrefix: string): Promise<void>;
  /**
   * Signed direct URL for the browser, or null (stream the local file). `download`: the name a download gets, where the
   * URL's host sets it (the app's own media host; a bucket's URL keeps the key's name).
   */
  url(key: string, expiresIn?: number, download?: string): string | null;
  origins(): string[];
}

/** Moves a file, falling back to copy + delete across file systems (Docker volumes). */
export function moveFile(src: string, dst: string, { keep = false } = {}): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.${process.pid}.tmp`;
  if (!keep) {
    try {
      fs.renameSync(src, dst);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    }
  }
  try {
    fs.copyFileSync(src, tmp, fs.constants.COPYFILE_FICLONE);
    fs.renameSync(tmp, dst);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  if (!keep) fs.rmSync(src, { force: true });
}

// ---------------------------------------------------------------- local disk

const WORKSPACE_KEY = /^w\/(w_[a-z0-9]{12})\/(.+)$/;
/** Every key of one workspace other than #1 (`w/<id>/`): what removing a deleted workspace's objects names. */
const WORKSPACE_PREFIX = /^w\/(w_[a-z0-9]{12})\/$/;

/** The key a file of workspace `ws` has in the store: workspace #1's as it always was, any other's under `w/<id>/`. */
export const workspaceKey = (key: string, ws = currentWorkspace()): string => (ws === DEFAULT_WORKSPACE ? key : `w/${ws}/${key}`);
/** A key without its workspace prefix (what the key names inside its workspace). */
export const bareKey = (key: string): string => WORKSPACE_KEY.exec(key)?.[2] ?? key;

export function localPathOf(key: string): string {
  const scoped = WORKSPACE_KEY.exec(key);
  const root = workspaceRoot(scoped?.[1] ?? DEFAULT_WORKSPACE);
  const k = scoped?.[2] ?? key;
  // A key names a place inside the store, never outside it: a video by an id a review could have, and no part that
  // climbs (the app builds every key from slugify() and its own ids; this holds for a caller that someday doesn't).
  const parts = k.split('/');
  if (parts.some((p) => p === '..' || p === '.' || /[\\\0]/.test(p))) throw new Error(`not a storage key: ${JSON.stringify(k).slice(0, 80)}`);
  if (k.startsWith('versions/') || k.startsWith('previews/') || k.startsWith('refs/')) {
    const [top = '', slug = '', ...rest] = parts;
    if (!validSlug(slug)) throw new NotAVideoError(slug);
    return top === 'versions' ? path.join(root.versions, slug, ...rest) : path.join(root.data, slug, top, ...rest);
  }
  // Playbooks' files (skill attachments, reference images) and profile pictures come from people: data/, never the
  // disposable cache (which backups skip).
  if (k.startsWith('playbooks/') || k.startsWith('avatars/') || k.startsWith('asks/')) return path.join(root.data, k);
  return path.join(root.cache, k);
}

export function createLocalStorage(): Storage {
  return {
    kind: 'local',
    localPath: localPathOf,
    has: (key) => fs.existsSync(localPathOf(key)),
    async ensureLocal(key) {
      const p = localPathOf(key);
      return fs.existsSync(p) ? p : null;
    },
    async put(key, file, { keep = false } = {}) {
      moveFile(file, localPathOf(key), { keep });
    },
    async commit() {},
    async remove(keyOrPrefix) {
      // A whole workspace's prefix (it was deleted: lib/erasure.ts): on this disk its keys live in its versions, data and
      // cache folders, so all three go — never workspace #1's (its keys have no prefix, and its folders are the store).
      const whole = WORKSPACE_PREFIX.exec(keyOrPrefix);
      if (whole) {
        const root = workspaceRoot(whole[1] as string);
        for (const dir of [root.versions, root.data, root.cache]) fs.rmSync(dir, { recursive: true, force: true });
        return;
      }
      fs.rmSync(localPathOf(keyOrPrefix.replace(/\/$/, '')), { recursive: true, force: true });
    },
    read: (key, start, end) => fs.createReadStream(localPathOf(key), { start, end, highWaterMark: 1 << 20 }),
    size: (key) => sizeOf(localPathOf(key)),
    async check() {
      fs.mkdirSync(VERSIONS, { recursive: true });
      fs.accessSync(VERSIONS, fs.constants.W_OK);
    },
    url: () => null,
    origins: () => [],
  };
}

function sizeOf(file: string): number | null {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- remote + working copies

// A working copy with a ".stored" marker next to it is safe to evict: the remote store has it. Without the marker the
// upload has not finished (or failed) and the file is the only copy. The marker outlives the copy and records its size
// ({"size": n}; markers from before are empty), so archives can be planned without downloading anything.
const marker = (file: string) => `${file}.stored`;
const markStored = (file: string) => fs.writeFileSync(marker(file), JSON.stringify({ size: fs.statSync(file).size }));
function storedSize(file: string): number | null {
  try {
    const { size } = JSON.parse(fs.readFileSync(marker(file), 'utf8')) as { size?: unknown };
    return typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : null;
  } catch {
    return null;
  }
}

function pruneWorkCache(dir: string, capBytes: number): void {
  const files: { f: string; size: number; at: number }[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (!e.name.endsWith('.stored') && !e.name.endsWith('.tmp') && fs.existsSync(marker(f))) {
        const st = fs.statSync(f);
        files.push({ f, size: st.size, at: st.atimeMs });
      }
    }
  };
  walk(dir);
  let total = files.reduce((s, x) => s + x.size, 0);
  for (const x of files.sort((a, b) => a.at - b.at)) {
    if (total <= capBytes) break;
    fs.rmSync(x.f, { force: true });
    total -= x.size;
  }
}

/**
 * Whatever an object store's request fails with — a status it answered, an error document in a 200, a stream that broke
 * off, a host that can't be reached — names storage keys (the project's and client's folders), the bucket and the store's
 * own words: the server's business (lib/publicError.ts), and the server's fault (502 when the store gave no status).
 */
function storeFault(e: unknown): unknown {
  if (e && typeof e === 'object') {
    internal(e);
    if (typeof (e as { status?: unknown }).status !== 'number') (e as { status?: number }).status = 502;
  }
  return e;
}

/** The store with every failure marked as the server's (storeFault). */
function faultsMarked(remote: RemoteStore): RemoteStore {
  const marked =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      try {
        return await fn(...a);
      } catch (e) {
        throw storeFault(e);
      }
    };
  return {
    kind: remote.kind,
    put: marked(remote.put.bind(remote)),
    get: marked(remote.get.bind(remote)),
    check: marked(remote.check.bind(remote)),
    remove: marked(remote.remove.bind(remote)),
    async *read(key, start, end) {
      try {
        yield* remote.read(key, start, end);
      } catch (e) {
        throw storeFault(e);
      }
    },
    url: (key, expiresIn) => remote.url(key, expiresIn),
    origins: () => remote.origins(),
  };
}

export function createRemoteStorage(store: RemoteStore, { workCacheBytes = 20e9, workDir = path.join(CACHE, 'work') } = {}): Storage {
  const remote = faultsMarked(store);
  const localPath = (key: string) => path.join(workDir, key);
  const downloads = new Map<string, Promise<string | null>>();
  const touch = (f: string) => {
    const now = new Date();
    try {
      fs.utimesSync(f, now, fs.statSync(f).mtime);
    } catch {}
  };

  async function upload(key: string, file: string, contentType?: string) {
    await remote.put(key, file, contentType);
    markStored(file);
    pruneWorkCache(workDir, workCacheBytes);
  }

  return {
    kind: remote.kind,
    localPath,
    // Registered versions are uploaded before they are registered, so a key the store asks about exists remotely;
    // playback copies are known by their marker.
    has: (key) => fs.existsSync(localPath(key)) || fs.existsSync(marker(localPath(key))) || bareKey(key).startsWith('versions/'),
    ensureLocal(key) {
      const p = localPath(key);
      if (fs.existsSync(p)) {
        touch(p);
        return Promise.resolve(p);
      }
      const running = downloads.get(key);
      if (running) return running;
      const job = (async () => {
        const tmp = `${p}.${process.pid}.tmp`;
        fs.mkdirSync(path.dirname(p), { recursive: true });
        try {
          await remote.get(key, tmp);
          fs.renameSync(tmp, p);
          markStored(p);
          pruneWorkCache(workDir, workCacheBytes);
          return p;
        } catch (e) {
          fs.rmSync(tmp, { force: true });
          if ((e as { status?: number }).status === 404) return null;
          throw e;
        }
      })().finally(() => downloads.delete(key));
      downloads.set(key, job);
      return job;
    },
    // Upload first: when it fails, the caller still has its file and nothing half-done is left in the cache.
    async put(key, file, { keep = false, contentType } = {}) {
      await remote.put(key, file, contentType);
      const p = localPath(key);
      moveFile(file, p, { keep });
      markStored(p);
      pruneWorkCache(workDir, workCacheBytes);
    },
    async commit(key, contentType) {
      await upload(key, localPath(key), contentType);
    },
    async remove(keyOrPrefix) {
      await remote.remove(keyOrPrefix);
      fs.rmSync(localPath(keyOrPrefix.replace(/\/$/, '')), { recursive: true, force: true });
    },
    read(key, start, end) {
      const p = localPath(key);
      if (fs.existsSync(p)) {
        touch(p);
        return fs.createReadStream(p, { start, end, highWaterMark: 1 << 20 });
      }
      return remote.read(key, start, end);
    },
    size: (key) => sizeOf(localPath(key)) ?? storedSize(localPath(key)),
    check: () => remote.check(),
    url: (key, expiresIn = SIGNED_URL_SECONDS.team) => remote.url(key, expiresIn),
    origins: () => remote.origins(),
  };
}

// ---------------------------------------------------------------- the app's own media host

/**
 * `base` with the app's own media host (VR_MEDIA_ORIGIN, lib/storage/mediaHost.ts): whatever `base` would stream
 * through the app itself (the disk, a bucket without signed URLs) gets a signed URL on that host instead, so the
 * player, review links and downloads are redirected there like to a CDN. A store's own signed URLs stay as they are.
 */
export function withMediaOrigin(base: Storage, origin: string): Storage {
  return {
    ...base,
    url: (key, expiresIn = SIGNED_URL_SECONDS.team, download) => base.url(key, expiresIn, download) ?? mediaFileUrl(origin, key, expiresIn, download),
    origins: () => [...new Set([...base.origins(), origin])],
  };
}

// ---------------------------------------------------------------- the configured storage

export function createStorage(cfg: StorageConfig, mode: 'local' | 'server', mediaOrigin: string | null = null): Storage {
  if (mode !== 'server') return createLocalStorage();
  const s =
    cfg.kind === 'local'
      ? createLocalStorage()
      : createRemoteStorage(cfg.kind === 'bunny' ? createBunnyStore(cfg.bunny) : createS3Store(cfg.s3), { workCacheBytes: cfg.work_cache_bytes });
  return mediaOrigin ? withMediaOrigin(s, mediaOrigin) : s;
}

let current: Storage | null = null;
const views = new Map<string, { base: Storage; view: Storage }>();

/** The whole store, keys as given: for what belongs to no workspace (profile pictures). */
export function rootStorage(): Storage {
  if (!current) {
    const cfg = loadConfig();
    current = createStorage(cfg.storage, cfg.mode, cfg.media_origin);
  }
  return current;
}

/** `base` as one workspace sees it: every key it is given is that workspace's (`workspaceKey`). */
export function workspaceStorage(base: Storage, ws: string): Storage {
  if (ws === DEFAULT_WORKSPACE) return base;
  const k = (key: string) => workspaceKey(key, ws);
  return {
    kind: base.kind,
    localPath: (key) => base.localPath(k(key)),
    has: (key) => base.has(k(key)),
    ensureLocal: (key) => base.ensureLocal(k(key)),
    read: (key, start, end) => base.read(k(key), start, end),
    size: (key) => base.size(k(key)),
    check: () => base.check(),
    put: (key, file, opts) => base.put(k(key), file, opts),
    commit: (key, contentType) => base.commit(k(key), contentType),
    remove: (keyOrPrefix) => base.remove(k(keyOrPrefix)),
    url: (key, expiresIn, download) => base.url(k(key), expiresIn, download),
    origins: () => base.origins(),
  };
}

/**
 * The storage this process uses (from config.json / VR_STORAGE), as the workspace running now sees it (lib/scope.ts);
 * tests may swap it with setStorage().
 */
export function storage(): Storage {
  const base = rootStorage();
  const ws = currentWorkspace();
  if (ws === DEFAULT_WORKSPACE) return base;
  const hit = views.get(ws);
  if (hit?.base === base) return hit.view;
  const view = workspaceStorage(base, ws);
  views.set(ws, { base, view });
  return view;
}

export function setStorage(s: Storage | null): void {
  current = s;
  views.clear();
}
