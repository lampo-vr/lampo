// Uploads to a hosted server over tus: resumable (renders are big, connections drop), several at once, and they keep
// going while you move between the library and the player. Interrupted uploads (a reload, a closed tab) are
// remembered by the browser: dropping the same file again continues where it stopped.
import type { QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { DetailedError, defaultOptions, type PreviousUpload, Upload } from 'tus-js-client';
import { api, UNAUTHORIZED } from '../api/client.ts';
import { keys } from '../api/queries.ts';
import type { UploadResult } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { refusalText } from '../lib/refusal.ts';
import { onSignOut } from '../lib/signedOut.ts';
import { type LimitAsk, openLimit } from '../lib/toast.ts';

/** `room`: the plan has no room for it now; it waits (the file kept in this page) until there is, then starts again. */
export type UploadState = 'uploading' | 'processing' | 'done' | 'failed' | 'canceled' | 'room';

export interface UploadItem {
  id: string;
  name: string;
  size: number;
  sent: number;
  state: UploadState;
  /** Bytes per second, smoothed. */
  rate: number;
  folder: string | null;
  /** Set for "upload a new version" of an existing video. */
  slug: string | null;
  resumed: boolean;
  /** This browser is offline: the upload waits and goes on by itself when the connection is back. */
  waiting?: boolean;
  error?: string;
  result?: UploadResult;
}

/** An upload a previous page left unfinished. */
export interface Interrupted {
  key: string;
  name: string;
  size: number;
  sent: number | null;
  url: string | null;
  folder: string | null;
}

// Chunks stay below what reverse proxies accept per request (Cloudflare: 100 MB).
const CHUNK = 48 * 1024 * 1024;

let items: UploadItem[] = [];
let interrupted: Interrupted[] = [];
const running = new Map<string, Upload>();
// Uploads waiting for room: the file and where it goes, and what the plan said (to show its sheet again).
const roomless = new Map<string, { file: File; target: UploadTarget; ask: LimitAsk }>();
const subs = new Set<() => void>();
let qc: QueryClient | null = null;

const emit = () => {
  for (const f of subs) f();
};
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};
const patch = (id: string, p: Partial<UploadItem>) => {
  items = items.map((x) => (x.id === id ? { ...x, ...p } : x));
  emit();
};

export const useUploads = () => useSyncExternalStore(subscribe, () => items);
export const useInterrupted = () => useSyncExternalStore(subscribe, () => interrupted);

export function bindUploads(client: QueryClient) {
  qc = client;
}

// The connection gone (a train, a laptop lid, Wi-Fi switching): uploads say they wait instead of showing the last
// speed, and ones whose retries ran out while offline start again once it is back (tus asks where it stopped).
const stalled = new Set<string>();
const uploadingIds = () => items.filter((x) => x.state === 'uploading').map((x) => x.id);
if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => {
    for (const id of uploadingIds()) patch(id, { waiting: true });
  });
  window.addEventListener('online', () => {
    for (const id of uploadingIds()) patch(id, { waiting: false });
    for (const id of stalled) running.get(id)?.start();
    stalled.clear();
  });
}

/** What a refusal for room (a 402 for storage or videos under review) said, or null for any other failure. */
function roomRefusal(e: unknown): LimitAsk | null {
  if (!(e instanceof DetailedError) || e.originalResponse?.getStatus() !== 402) return null;
  try {
    const j = JSON.parse(e.originalResponse.getBody() || '') as LimitAsk & { error?: string };
    if (j.reason !== 'storage' && j.reason !== 'videos') return null;
    const { error, ...rest } = j;
    return { ...rest, message: error };
  } catch {
    return null;
  }
}

/** The plan's sheet again for an upload that waits for room (the tray's "See what fits"). */
export function showRoom(id: string) {
  const w = roomless.get(id);
  if (w) openLimit(w.ask);
}

/** Tries a waiting upload again: it starts over as a new upload (its sheet comes back if there is still no room). */
export function retryRoom(id: string) {
  const w = roomless.get(id);
  if (!w) return;
  roomless.delete(id);
  items = items.filter((x) => x.id !== id);
  emit();
  void startUpload(w.file, w.target);
}

// The server answers errors as plain text (tus) or {error} (JSON).
function messageOf(e: unknown): string {
  if (e instanceof DetailedError) {
    const res = e.originalResponse;
    if (res?.getStatus() === 401) window.dispatchEvent(new Event(UNAUTHORIZED));
    const body = res?.getBody() || '';
    try {
      const j = JSON.parse(body) as { error?: string };
      // a plan's refusal: the provider's sentence in the page's language (lib/refusal.ts)
      if (res?.getStatus() === 402) return refusalText(j.error ?? '', j);
      if (j.error) return j.error;
    } catch {}
    if (body && body.length < 300) return body.trim();
    if (res?.getStatus() === 413) return t('the file is larger than this server accepts');
    if (!res) return t('the connection dropped; drop the file again to continue');
    return t('upload failed ({status})', { status: res.getStatus() });
  }
  return e instanceof Error ? e.message : String(e);
}

const settled = (id: string, result: UploadResult) => {
  patch(id, { state: 'done', result, sent: items.find((x) => x.id === id)?.size ?? 0 });
  qc?.invalidateQueries({ queryKey: keys.library });
  qc?.invalidateQueries({ queryKey: keys.review(result.slug) });
};

// Very large renders into remote storage finish in the background: ask until the server knows.
async function waitForResult(id: string, uploadId: string) {
  for (let i = 0; i < 400; i++) {
    await new Promise((r) => setTimeout(r, Math.min(1000 + i * 250, 5000)));
    try {
      const o = await api<{ status: 'processing' | 'done' | 'failed'; result?: UploadResult; error?: string }>(`/api/upload-results/${uploadId}`);
      if (o.status === 'done' && o.result) return settled(id, o.result);
      if (o.status === 'failed') return patch(id, { state: 'failed', error: o.error || 'the server could not use this file' });
    } catch (e) {
      return patch(id, { state: 'failed', error: messageOf(e) });
    }
  }
  patch(id, { state: 'failed', error: t('the server is still processing; it will appear in the library when done') });
}

export interface UploadTarget {
  folder?: string | null;
  slug?: string | null;
}

export async function startUpload(file: File, target: UploadTarget): Promise<void> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const folder = target.slug ? null : (target.folder ?? null);
  const metadata: Record<string, string> = { filename: file.name };
  if (target.slug) metadata.slug = target.slug;
  else if (folder) metadata.folder = folder;
  items = [...items, { id, name: file.name, size: file.size, sent: 0, state: 'uploading', rate: 0, folder, slug: target.slug ?? null, resumed: false }];
  emit();

  let last = { t: performance.now(), sent: 0 };
  const upload = new Upload(file, {
    endpoint: '/api/uploads',
    chunkSize: CHUNK,
    // About four minutes of retries: long enough for the server's restart during a deploy.
    retryDelays: [0, 1000, 3000, 6000, 12000, 20000, 30000, 60000, 60000, 60000],
    metadata,
    storeFingerprintForResuming: true,
    removeFingerprintOnSuccess: true,
    // Retrying cannot fix a refused file (not a video, too big, signed out, no such video).
    onShouldRetry: (err) => {
      const s = err.originalResponse?.getStatus() ?? 0;
      if (!navigator.onLine) patch(id, { waiting: true });
      return !(s >= 400 && s < 500 && s !== 409 && s !== 423 && s !== 429);
    },
    onProgress: (sent) => {
      const now = performance.now();
      const dt = (now - last.t) / 1000;
      if (dt < 0.25) return;
      const cur = items.find((x) => x.id === id);
      const inst = (sent - last.sent) / dt;
      last = { t: now, sent };
      patch(id, { sent, rate: cur?.rate ? cur.rate * 0.7 + inst * 0.3 : inst, waiting: false });
    },
    onSuccess: ({ lastResponse }) => {
      running.delete(id);
      forgetInterrupted(file);
      let body: (UploadResult & { pending?: undefined }) | { pending: true; id: string } | null = null;
      try {
        body = JSON.parse(lastResponse.getBody() || 'null');
      } catch {}
      if (body && 'pending' in body && body.pending) {
        patch(id, { state: 'processing', sent: file.size });
        void waitForResult(id, body.id);
      } else if (body && 'slug' in body) settled(id, body);
      // A resumed upload whose bytes were all there already: the server registered it on the first try.
      else patch(id, { state: 'done', sent: file.size });
    },
    onError: (err) => {
      // Offline: it waits for the connection rather than failing (the 'online' handler starts it again).
      if (!navigator.onLine && !(err instanceof DetailedError && err.originalResponse)) {
        stalled.add(id);
        patch(id, { waiting: true, rate: 0 });
        return;
      }
      running.delete(id);
      // no room on the plan: it waits here and the plan's sheet opens (what fits, paying in place, making room)
      const room = roomRefusal(err);
      if (room) {
        const ask: LimitAsk = { ...room, needed: file.size, name: file.name, upload: id, retry: () => retryRoom(id) };
        roomless.set(id, { file, target, ask });
        patch(id, { state: 'room', rate: 0 });
        openLimit(ask);
        return;
      }
      patch(id, { state: 'failed', error: messageOf(err) });
    },
  });
  running.set(id, upload);
  const previous = await upload.findPreviousUploads().catch(() => [] as PreviousUpload[]);
  if (previous[0]) {
    upload.resumeFromPreviousUpload(previous[0]);
    patch(id, { resumed: true });
  }
  forgetInterrupted(file);
  upload.start();
}

export async function cancelUpload(id: string) {
  roomless.delete(id);
  const u = running.get(id);
  running.delete(id);
  stalled.delete(id);
  patch(id, { state: 'canceled' });
  // Terminating also removes the partial file on the server and the resume entry in this browser.
  await u?.abort(true).catch(() => {});
}

export const clearFinished = () => {
  // what waits for room stays until it goes on or is cancelled
  items = items.filter((x) => x.state === 'uploading' || x.state === 'processing' || x.state === 'room');
  emit();
};

export const dismiss = (id: string) => {
  roomless.delete(id);
  items = items.filter((x) => x.id !== id);
  emit();
};

// ---------------------------------------------------------------- interrupted uploads (a previous page)

function forgetInterrupted(file: File) {
  const before = interrupted.length;
  interrupted = interrupted.filter((x) => !(x.name === file.name && x.size === file.size));
  if (interrupted.length !== before) emit();
}

/** Lists uploads an earlier page started and did not finish, with how far each got (asks the server). */
export async function loadInterrupted() {
  const stored = await defaultOptions.urlStorage.findAllUploads().catch(() => [] as PreviousUpload[]);
  const found: Interrupted[] = [];
  for (const p of stored) {
    if (!p.uploadUrl) continue;
    const r = await fetch(p.uploadUrl, { method: 'HEAD', headers: { 'Tus-Resumable': '1.0.0' } }).catch(() => null);
    if (!r?.ok) {
      // Expired or finished elsewhere: nothing to resume.
      if (r && r.status !== 401) await defaultOptions.urlStorage.removeUpload(p.urlStorageKey).catch(() => {});
      continue;
    }
    const sent = Number(r.headers.get('upload-offset'));
    found.push({
      key: p.urlStorageKey,
      name: p.metadata.filename || 'video',
      size: p.size || 0,
      sent: Number.isFinite(sent) ? sent : null,
      url: p.uploadUrl,
      folder: p.metadata.folder || null,
    });
  }
  interrupted = found;
  emit();
}

export async function forget(x: Interrupted) {
  interrupted = interrupted.filter((y) => y.key !== x.key);
  emit();
  await defaultOptions.urlStorage.removeUpload(x.key).catch(() => {});
  if (x.url) await Upload.terminate(x.url).catch(() => {});
}

/**
 * Signed out: the account's renders on their way stop (the server ends their half-sent uploads by itself), the tray
 * forgets them and what an earlier page left unfinished; their resume entries go with the account's storage.
 */
export function resetUploads() {
  for (const up of running.values()) void up.abort(false).catch(() => {});
  running.clear();
  roomless.clear();
  items = [];
  interrupted = [];
  emit();
}
onSignOut(resetUploads);
