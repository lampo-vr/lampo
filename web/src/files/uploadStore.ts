// Files on their way into an area: a way in asked for a few files ahead of what is being sent (a way in lives 15
// minutes: asked for a whole big drop at once, the last would run out before their turn), then sent over tus, three at
// a time, resumable (a dropped connection goes on; the same folder dropped again after a reload continues where each
// file stopped), each committed as it arrives. A file the workspace holds already is
// committed without a byte sent. A replace names the version it was based on: if someone changed the file meanwhile the
// server refuses it (409) and the tray asks — keep both, or replace theirs. The upload tray (uploads/UploadTray.tsx)
// shows the batches, grouped by their top folders; the Files tab shows the rows still on their way.
import type { QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { DetailedError, type PreviousUpload, Upload } from 'tus-js-client';
import { FILE_LIMITS, nameOf } from '../../../lib/fileText.ts';
import type {
  FileCommitAnswer,
  FileCommitItem,
  FileConflict,
  FileConflictAnswer,
  FileConflictMode,
  FileUploadAnswer,
  FileUploadResult,
  FileUploadSlot,
} from '../../../lib/types.ts';
import { ApiError, api, UNAUTHORIZED } from '../api/client.ts';
import { t } from '../i18n/index.ts';
import { refusalText } from '../lib/refusal.ts';
import { onSignOut } from '../lib/signedOut.ts';
import { type LimitAsk, openLimit, toastError } from '../lib/toast.ts';
import { fileKeys } from './api.ts';
import { trayGroup } from './model.ts';

/** `later`: its account made the day's versions of the file already (429): it waits for a copy beside it, or the time. */
export type FileUploadState = 'waiting' | 'uploading' | 'done' | 'failed' | 'canceled' | 'conflict' | 'room' | 'later';

export interface FileUpload {
  key: string;
  batch: string;
  /** Its path in the area. */
  path: string;
  /** Where the tray lists it: its first folders under where it was dropped. */
  group: string;
  size: number;
  sent: number;
  /** Bytes per second, smoothed. */
  rate: number;
  state: FileUploadState;
  /** The version it replaces (null: a new file). */
  base: number | null;
  sha256?: string;
  /** What it became (added, a new version, the same bytes as there, a copy beside a changed file). */
  how?: FileCommitItem['state'];
  /** Who changed the file since this one was based on it (a 409). */
  conflict?: FileConflict;
  error?: string;
  /** When its account may make the file's next version (a 429's `retry_after`), as a time. */
  retryAt?: number;
  /** It continues an upload an earlier page left unfinished. */
  resumed?: boolean;
  /** No connection now: it goes on by itself when it's back. */
  offline?: boolean;
  /** When it arrived (the list shows it as on its way until its answer has it). */
  doneAt?: number;
  /** How it is asked for: as a version (`refuse` a changed file), or beside it as a copy. */
  mode?: FileConflictMode;
  /** Its way in ran out before it started (410) and was asked for again once. */
  reasked?: boolean;
}

export interface FileBatch {
  id: string;
  area: string;
  /** The folder of the area it was dropped into ('' = the top). */
  dir: string;
  /** The plan had no room: the refusal, to show its sheet again. */
  ask?: LimitAsk;
}

export interface FileUploads {
  batches: FileBatch[];
  uploads: FileUpload[];
}

/** One request's files at most, uploads at once, and ways in asked for ahead of them. */
const PER_REQUEST = FILE_LIMITS.batch;
const AT_ONCE = 3;
export const AHEAD = 3;
// Pieces stay below what reverse proxies take per request (Cloudflare: 100 MB).
const CHUNK = 48 * 1024 * 1024;

let state: FileUploads = { batches: [], uploads: [] };
const files = new Map<string, File>();
const slots = new Map<string, { slot: FileUploadSlot; tus: string; mode: FileConflictMode }>();
const running = new Map<string, Upload>();
const queue: string[] = [];
const subs = new Set<() => void>();
let qc: QueryClient | null = null;
/** A way-in request in flight (one at a time), and no new one before `heldUntil` (a 429 that isn't a file's day). */
let asking = false;
let heldUntil = 0;
let holdTimer: ReturnType<typeof setTimeout> | null = null;

/** What the store talks to: the API and tus (a unit test stands in for both). */
export const fileIo = { api, Upload };

const emit = () => {
  for (const f of subs) f();
};
const set = (next: Partial<FileUploads>) => {
  state = { ...state, ...next };
  emit();
};
const patch = (keys: Iterable<string>, p: Partial<FileUpload> | ((u: FileUpload) => Partial<FileUpload>)) => {
  const ks = new Set(keys);
  if (!ks.size) return;
  set({ uploads: state.uploads.map((u) => (ks.has(u.key) ? { ...u, ...(typeof p === 'function' ? p(u) : p) } : u)) });
};
const one = (key: string) => state.uploads.find((u) => u.key === key);
const batchOf = (id: string) => state.batches.find((b) => b.id === id);

/** The store as it is now (outside React: a test, a tally). */
export const fileUploadsNow = (): FileUploads => state;

export const useFileUploads = () =>
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
  );

/** The query cache this store refreshes when files arrive (the Files tab and the tray bind it). */
export function bindFileUploads(client: QueryClient) {
  qc = client;
}

// An area's lists ask again at most once a second while files arrive (the event stream says the same, later).
const dirty = new Set<string>();
let refreshing: ReturnType<typeof setTimeout> | null = null;
function refresh(area: string) {
  dirty.add(area);
  if (refreshing) return;
  refreshing = setTimeout(() => {
    refreshing = null;
    for (const a of dirty) void qc?.invalidateQueries({ queryKey: fileKeys.area(a) });
    dirty.clear();
  }, 1000);
}

/** A file to send: where it goes in the area, the version it replaces, and its hash when the browser has it. */
export interface Outgoing {
  file: File;
  path: string;
  base: number | null;
  sha256?: string | null;
  /** Its path from what was dropped (the tray groups by it). */
  rel: string;
}

/** Starts sending `items` into `area` (dropped into its folder `dir`). */
export function sendFiles(area: string, dir: string, items: Outgoing[]): string {
  const id = `fb_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const uploads: FileUpload[] = items.map((x) => {
    const key = `${id}:${x.path}`;
    files.set(key, x.file);
    return {
      key,
      batch: id,
      path: x.path,
      group: trayGroup(x.rel),
      size: x.file.size,
      sent: 0,
      rate: 0,
      state: 'waiting',
      base: x.base,
      ...(x.sha256 ? { sha256: x.sha256 } : {}),
    };
  });
  set({ batches: [...state.batches, { id, area, dir }], uploads: [...state.uploads, ...uploads] });
  pump();
  return id;
}

/** What the server answered a refused write with: a 409's conflicts, a 402's sentence and details. */
const conflictsOf = (e: unknown): FileConflict[] | null =>
  e instanceof ApiError && e.status === 409 && Array.isArray(e.details.conflicts) ? (e.details.conflicts as FileConflict[]) : null;

/** A 429's wait in seconds: the answer's Retry-After, else its `retry_after`. */
const waitOf = (header: number | string | null | undefined, json: Record<string, unknown> | null | undefined): number => {
  const n = Number(header ?? json?.retry_after ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
/** Files past their account's day of versions: they wait for a copy beside, or for the time it names. */
function later(keys: string[], wait: number, error: string) {
  patch(keys, { state: 'later', rate: 0, retryAt: Date.now() + wait * 1000, error });
}

/** The plan has no room: the batch waits, the plan's sheet opens (what fits, paying in place, making room). */
function noRoom(id: string, keys: string[], error: string, details: Record<string, unknown>) {
  const needed = keys.reduce((s, k) => s + (one(k)?.size ?? 0), 0);
  const ask: LimitAsk = {
    ...details,
    message: refusalText(error, details),
    needed,
    name: t('{n} file|{n} files', { n: keys.length }),
    retry: () => retryRoom(id),
  };
  set({ batches: state.batches.map((b) => (b.id === id ? { ...b, ask } : b)) });
  patch(keys, { state: 'room', rate: 0 });
  openLimit(ask);
}

/** A 429 that is a file's day of versions (the tray's 'later'); any other only means: not now. */
const isDay = (json: Record<string, unknown> | null | undefined) => json?.reason === 'versions';

/** A 429 that isn't a file's day (too many ways in open, a rate limit): no new asking until it says, then again. */
function holdAsking(wait: number) {
  heldUntil = Date.now() + Math.max(1, wait) * 1000;
  if (holdTimer) clearTimeout(holdTimer);
  holdTimer = setTimeout(() => {
    holdTimer = null;
    pump();
  }, heldUntil - Date.now());
}

/** Ways in of a batch not asked for yet: all of them wait for room when the plan has none. */
const unasked = (id: string) => state.uploads.filter((u) => u.batch === id && u.state === 'waiting' && !slots.has(u.key)).map((u) => u.key);

/**
 * Asks the server for a way in for `keys` (all of one batch), in requests of up to a thousand; `front`: they go next
 * (one asked for again because its way in ran out as it started).
 */
async function ask(id: string, keys: string[], conflict: FileConflictMode = 'refuse', front = false): Promise<void> {
  const b = batchOf(id);
  if (!b) return;
  for (let i = 0; i < keys.length; i += PER_REQUEST) {
    const part = keys.slice(i, i + PER_REQUEST).filter((k) => one(k)?.state === 'waiting');
    if (!part.length) continue;
    const ups = part.map((k) => one(k) as FileUpload);
    try {
      const answer = await fileIo.api<FileUploadAnswer>('/api/files/uploads', {
        method: 'POST',
        body: {
          folder: b.area,
          conflict,
          files: ups.map((u) => ({ path: u.path, size: u.size, base: u.base, ...(u.sha256 ? { sha256: u.sha256 } : {}) })),
        },
      });
      const stored: string[] = [];
      const ways: string[] = [];
      for (const slot of answer.uploads) {
        const key = `${id}:${slot.path}`;
        if (!one(key)) continue;
        if (slot.stored) stored.push(key);
        else {
          slots.set(key, { slot, tus: answer.tus, mode: conflict });
          ways.push(key);
        }
      }
      if (front) queue.unshift(...ways);
      else queue.push(...ways);
      // on their way while their commit runs: not asked for again meanwhile
      patch(stored, { state: 'uploading' });
      if (stored.length) void commit(id, stored, conflict);
      // a file the answer didn't name would be asked for forever
      const named = new Set([...ways, ...stored]);
      const left = part.filter((k) => !named.has(k));
      if (left.length) patch(left, { state: 'failed', error: t('no way in came for it: try again') });
      pump();
    } catch (e) {
      const conflicts = conflictsOf(e);
      if (conflicts) {
        // nothing was written: the files that changed meanwhile wait for a decision, the others are asked for again
        const hit = new Set<string>();
        for (const c of conflicts) {
          const key = `${id}:${c.path}`;
          hit.add(key);
          patch([key], { state: 'conflict', conflict: c });
        }
        const rest = part.filter((k) => !hit.has(k));
        if (rest.length === part.length) patch(part, { state: 'failed', error: (e as Error).message });
        else if (rest.length) await ask(id, rest, conflict);
        continue;
      }
      if (e instanceof ApiError && e.status === 402) {
        noRoom(id, unasked(id), e.message, e.details);
        return;
      }
      if (e instanceof ApiError && e.status === 429) {
        if (isDay(e.details)) await pastTheDay(part, waitOf(e.retryAfter, e.details), e.message, (ks) => ask(id, ks, conflict));
        // not now (too many ways in open, a rate limit): they stay waiting, and are asked for once it says
        else holdAsking(waitOf(e.retryAfter, e.details) || 30);
        return;
      }
      patch(part, { state: 'failed', error: (e as Error).message });
    }
  }
}

/**
 * A request refused because one of its files is past its account's day of versions (the answer doesn't say which):
 * one file waits; of several, the new files go again together and each new version alone, so only the refused wait.
 */
async function pastTheDay(part: string[], wait: number, error: string, again: (keys: string[]) => Promise<void>) {
  if (part.length === 1) return later(part, wait, error);
  const versions = part.filter((k) => one(k)?.base != null);
  const rest = part.filter((k) => one(k)?.base == null);
  if (!versions.length) return later(part, wait, error);
  if (rest.length) await again(rest);
  for (const k of versions) await again([k]);
}

/** Files whose bytes the workspace holds already: one change, nothing sent. */
async function commit(id: string, keys: string[], conflict: FileConflictMode) {
  const b = batchOf(id);
  if (!b) return;
  const ups = keys.map((k) => one(k)).filter((u): u is FileUpload => !!u?.sha256);
  try {
    const answer = await fileIo.api<FileCommitAnswer>('/api/files/commit', {
      method: 'POST',
      body: { folder: b.area, conflict, add: ups.map((u) => ({ path: u.path, sha256: u.sha256, size: u.size, base: u.base })) },
    });
    for (const f of answer.files) patch([`${id}:${f.asked ?? f.path}`], (u) => ({ state: 'done', how: f.state, sent: u.size, doneAt: Date.now() }));
    refresh(b.area);
  } catch (e) {
    const conflicts = conflictsOf(e);
    if (conflicts) for (const c of conflicts) patch([`${id}:${c.path}`], { state: 'conflict', conflict: c });
    else if (e instanceof ApiError && e.status === 429 && isDay(e.details))
      await pastTheDay(
        ups.map((u) => u.key),
        waitOf(e.retryAfter, e.details),
        e.message,
        (ks) => commit(id, ks, conflict),
      );
    else if (e instanceof ApiError && e.status === 429) {
      // not now: asked for again (its bytes are there: the next answer says so) once it says
      patch(
        ups.map((u) => u.key),
        { state: 'waiting' },
      );
      holdAsking(waitOf(e.retryAfter, e.details) || 30);
    } else
      patch(
        ups.map((u) => u.key),
        { state: 'failed', error: (e as Error).message },
      );
  }
}

// ---------------------------------------------------------------- tus

// The connection gone: uploads say they wait, and the ones whose retries ran out start again once it is back.
const stalled = new Set<string>();
if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => patch([...running.keys()], { offline: true, rate: 0 }));
  window.addEventListener('online', () => {
    patch([...running.keys(), ...stalled], { offline: false });
    for (const k of stalled) running.get(k)?.start();
    stalled.clear();
  });
}

function pump() {
  while (running.size < AT_ONCE && queue.length) {
    const key = queue.shift() as string;
    if (one(key)?.state === 'waiting') void start(key);
  }
  void topUp();
}

/** Ways in for the next files, so AHEAD of them wait ready beside the ones being sent (one request at a time). */
async function topUp() {
  if (asking || Date.now() < heldUntil) return;
  const room = AT_ONCE + AHEAD - running.size - queue.length;
  if (room <= 0) return;
  const first = state.uploads.find((u) => u.state === 'waiting' && !slots.has(u.key) && files.has(u.key));
  if (!first) return;
  const mode = first.mode ?? 'refuse';
  const keys = state.uploads
    .filter((u) => u.batch === first.batch && u.state === 'waiting' && !slots.has(u.key) && files.has(u.key) && (u.mode ?? 'refuse') === mode)
    .slice(0, room)
    .map((u) => u.key);
  asking = true;
  try {
    await ask(first.batch, keys, mode);
  } finally {
    asking = false;
  }
  pump();
}

/** A way in that ran out as its file started (410: it waited behind long uploads): asked for once more, to go next. */
function reask(key: string): boolean {
  const u = one(key);
  if (!u || u.reasked) return false;
  slots.delete(key);
  patch([key], { state: 'waiting', reasked: true, sent: 0, rate: 0 });
  void ask(u.batch, [key], u.mode ?? 'refuse', true).catch(toastError);
  return true;
}

/** A 429 as a file went that isn't its day of versions: asked for again once the server says. */
function notNow(key: string, wait: number) {
  slots.delete(key);
  patch([key], { state: 'waiting', sent: 0, rate: 0 });
  holdAsking(wait || 30);
}

/** The body of a tus answer that failed, as JSON (409: the conflict; 402: the plan's refusal). */
function bodyOf(e: unknown): { status: number; json: Record<string, unknown> | null } {
  const res = e instanceof DetailedError ? e.originalResponse : null;
  if (!res) return { status: 0, json: null };
  try {
    return { status: res.getStatus(), json: JSON.parse(res.getBody() || 'null') };
  } catch {
    return { status: res.getStatus(), json: null };
  }
}

async function start(key: string) {
  const u = one(key);
  const file = files.get(key);
  const way = slots.get(key);
  const b = u && batchOf(u.batch);
  if (!u || !file || !way || !b) return;
  if (!way.slot.ticket && way.slot.url) return put(key, file, way.slot.url);
  patch([key], { state: 'uploading' });
  let last = { t: performance.now(), sent: 0 };
  const upload = new fileIo.Upload(file, {
    endpoint: way.tus,
    chunkSize: CHUNK,
    // about four minutes of retries: long enough for the server's restart during a deploy
    retryDelays: [0, 1000, 3000, 6000, 12000, 20000, 30000, 60000, 60000, 60000],
    metadata: { ticket: way.slot.ticket ?? '', filename: nameOf(u.path) },
    // the same file dropped into the same place again continues where it stopped (not just any copy of its bytes); one
    // asked for again after a 409 (on another version, or as a copy) is a new upload, never the refused one resumed
    fingerprint: async () => `lampo-file:${b.area}:${u.path}:${file.size}:${file.lastModified}:${u.base ?? 0}:${way.mode}`,
    storeFingerprintForResuming: true,
    removeFingerprintOnSuccess: true,
    onShouldRetry: (err) => {
      const s = err.originalResponse?.getStatus() ?? 0;
      // a 429 for a moment is tried again; one for hours (the day's versions) waits in the tray
      if (s === 429) return waitOf(err.originalResponse?.getHeader('Retry-After'), null) <= 30;
      return !(s >= 400 && s < 500 && s !== 423);
    },
    onProgress: (sent) => {
      const now = performance.now();
      const dt = (now - last.t) / 1000;
      if (dt < 0.25) return;
      const inst = (sent - last.sent) / dt;
      last = { t: now, sent };
      patch([key], (x) => ({ sent, rate: x.rate ? x.rate * 0.7 + inst * 0.3 : inst, offline: false }));
    },
    onSuccess: ({ lastResponse }) => {
      running.delete(key);
      let result: FileUploadResult | null = null;
      try {
        result = JSON.parse(lastResponse.getBody() || 'null');
      } catch {}
      const made = result?.commit?.files.find((f) => (f.asked ?? f.path) === u.path);
      patch([key], {
        state: 'done',
        sent: file.size,
        how: made?.state ?? 'added',
        doneAt: Date.now(),
        ...(result?.stored ? { sha256: result.stored.sha256 } : {}),
      });
      files.delete(key);
      refresh(b.area);
      pump();
    },
    onError: (err) => {
      if (!navigator.onLine && !(err instanceof DetailedError && err.originalResponse)) {
        stalled.add(key);
        patch([key], { offline: true, rate: 0 });
        return;
      }
      running.delete(key);
      const { status, json } = bodyOf(err);
      if (status === 401) window.dispatchEvent(new Event(UNAUTHORIZED));
      if (status === 409 && Array.isArray(json?.conflicts)) {
        const c = (json as unknown as FileConflictAnswer).conflicts.find((x) => x.path === u.path) ?? (json as unknown as FileConflictAnswer).conflicts[0];
        patch([key], { state: 'conflict', conflict: c, rate: 0 });
      } else if (status === 402 && json) noRoom(u.batch, [key], String(json.error ?? ''), json);
      else if (status === 410 && reask(key)) return;
      else if (status === 429) {
        const wait = waitOf(err instanceof DetailedError ? err.originalResponse?.getHeader('Retry-After') : null, json);
        if (isDay(json)) later([key], wait, String(json?.error ?? ''));
        else notNow(key, wait);
      } else patch([key], { state: 'failed', rate: 0, error: typeof json?.error === 'string' ? json.error : messageOf(status) });
      pump();
    },
  });
  running.set(key, upload);
  const previous = await upload.findPreviousUploads().catch(() => [] as PreviousUpload[]);
  if (previous[0]) {
    upload.resumeFromPreviousUpload(previous[0]);
    patch([key], { resumed: true });
  }
  upload.start();
}

const messageOf = (status: number) =>
  !status
    ? t('the connection dropped; drop the file again to continue')
    : status === 413
      ? t('the file is larger than this server accepts')
      : t('upload failed ({status})', { status });

/** One plain PUT (a server that offers no tus for this file): progress from the request's upload. */
function put(key: string, file: File, url: string) {
  const u = one(key);
  const b = u && batchOf(u.batch);
  if (!u || !b) return;
  patch([key], { state: 'uploading' });
  const xhr = new XMLHttpRequest();
  // a stand-in for the tus upload in `running`, so a cancel and the count of uploads at once see it
  running.set(key, { abort: async () => xhr.abort() } as unknown as Upload);
  xhr.open('PUT', url);
  xhr.upload.onprogress = (e) => patch([key], { sent: e.loaded });
  xhr.onloadend = () => {
    running.delete(key);
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(xhr.responseText || 'null');
    } catch {}
    if (xhr.status >= 200 && xhr.status < 300) {
      patch([key], { state: 'done', sent: file.size, how: 'added', doneAt: Date.now() });
      refresh(b.area);
    } else if (xhr.status === 409 && json && Array.isArray(json.conflicts))
      patch([key], { state: 'conflict', conflict: (json.conflicts as FileConflict[])[0] });
    else if (xhr.status === 402 && json) noRoom(u.batch, [key], String(json.error ?? ''), json);
    else if (xhr.status === 410 && reask(key)) return;
    else if (xhr.status === 429 && isDay(json)) later([key], waitOf(xhr.getResponseHeader('Retry-After'), json), String(json?.error ?? ''));
    else if (xhr.status === 429) notNow(key, waitOf(xhr.getResponseHeader('Retry-After'), json));
    else if (one(key)?.state !== 'canceled') patch([key], { state: 'failed', error: typeof json?.error === 'string' ? json.error : messageOf(xhr.status) });
    pump();
  };
  xhr.send(file);
}

// ---------------------------------------------------------------- what the person does

/**
 * The files of a batch that changed since they were based on: `copy` keeps both (this one lands beside it, named for
 * whose it is), `replace` makes this one the next version after theirs.
 */
export function resolveConflicts(id: string, how: 'copy' | 'replace') {
  const keys = state.uploads.filter((u) => u.batch === id && u.state === 'conflict').map((u) => u.key);
  for (const k of keys) slots.delete(k);
  patch(keys, (u) => ({
    state: 'waiting',
    conflict: undefined,
    mode: how === 'copy' ? 'copy' : 'refuse',
    ...(how === 'replace' && u.conflict ? { base: u.conflict.v } : {}),
  }));
  pump();
}

/**
 * Files past their account's day of versions: saved beside the file as a copy (never refused for the day), or asked
 * for again as versions (`again`: once the time they wait for has come).
 */
export function resolveLater(id: string, how: 'copy' | 'again') {
  const keys = state.uploads.filter((u) => u.batch === id && u.state === 'later').map((u) => u.key);
  for (const k of keys) slots.delete(k);
  patch(keys, { state: 'waiting', retryAt: undefined, error: undefined, mode: how === 'copy' ? 'copy' : 'refuse' });
  pump();
}

/** A batch that waited for room is asked for again (its sheet comes back if there is still none). */
export function retryRoom(id: string) {
  const keys = state.uploads.filter((u) => u.batch === id && u.state === 'room').map((u) => u.key);
  set({ batches: state.batches.map((b) => (b.id === id ? { ...b, ask: undefined } : b)) });
  patch(keys, { state: 'waiting' });
  pump();
}

export function showRoom(id: string) {
  const ask = batchOf(id)?.ask;
  if (ask) openLimit(ask);
}

/** Failed files of a batch, once more. */
export function retryFailed(id: string) {
  const keys = state.uploads.filter((u) => u.batch === id && u.state === 'failed' && files.has(u.key)).map((u) => u.key);
  for (const k of keys) slots.delete(k);
  patch(keys, { state: 'waiting', error: undefined, sent: 0 });
  pump();
}

/** Stops a batch (or one file of it): what is on its way is dropped on the server too; what arrived stays. */
export async function cancelFiles(id: string, key?: string) {
  const keys = state.uploads.filter((u) => u.batch === id && (!key || u.key === key) && u.state !== 'done').map((u) => u.key);
  patch(keys, { state: 'canceled', rate: 0 });
  for (const k of keys) {
    const q = queue.indexOf(k);
    if (q >= 0) queue.splice(q, 1);
    stalled.delete(k);
    files.delete(k);
    const up = running.get(k);
    running.delete(k);
    // terminating also removes the partial file on the server and the resume entry here
    await up?.abort(true).catch(() => {});
  }
  pump();
}

/** The tray's Clear: batches with nothing left to do go. */
export function clearFileUploads() {
  const live = new Set(
    state.uploads
      .filter((u) => u.state === 'waiting' || u.state === 'uploading' || u.state === 'conflict' || u.state === 'room' || u.state === 'later')
      .map((u) => u.batch),
  );
  for (const u of state.uploads) if (!live.has(u.batch)) files.delete(u.key);
  set({ batches: state.batches.filter((b) => live.has(b.id)), uploads: state.uploads.filter((u) => live.has(u.batch)) });
}

/**
 * Signed out: nothing of the account's uploads stays in this tab — what is on its way stops (the server ends its
 * half-sent uploads by itself), the tray empties, and no Try again can send its files into the next account's
 * workspace. Its resume entries (`tus::` keys) go with the account's storage (lib/signedOut.ts).
 */
export function resetFileUploads() {
  for (const up of running.values()) void up.abort(false).catch(() => {});
  running.clear();
  queue.length = 0;
  files.clear();
  slots.clear();
  stalled.clear();
  dirty.clear();
  asking = false;
  heldUntil = 0;
  if (holdTimer) clearTimeout(holdTimer);
  holdTimer = null;
  set({ batches: [], uploads: [] });
}
onSignOut(resetFileUploads);
