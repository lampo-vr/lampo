// Project files on a hosted server (server/routes/files.ts; docs/files.md), for `lampo files` and the stdio MCP server
// after `lampo login`. Reading goes through the API; bytes come from the signed URLs it hands out (a media host's or a
// bucket's: the token never goes there) or, where it has none, from its own download route with the token. A push asks
// once for room for a batch of files (the version check, the disk and the plan, before any byte moves; bytes the
// workspace holds already never move), sends each file over tus with its one-time ticket — resumable: a push run again
// goes on where an upload broke off — and then commits the batch as one change of the area.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import * as tus from 'tus-js-client';
import { FILE_LIMITS, nameOf } from '../fileText.ts';
import { cleanAgentName } from '../names.ts';
import { isAgent } from '../time.ts';
import type { FileCommitAnswer, FileConflict, FilesListing, FilesSummary, FileUploadAnswer, FileUploadResult, FileUploadSlot, FileUrls } from '../types.ts';
import type { Api } from './remote.ts';
import { type Backend, type FileSource, FilesConflict, type PushFileInput, StoppedError } from './types.ts';

type FileMethods = Pick<Backend, 'filesSummary' | 'listFiles' | 'fileSources' | 'pushFiles'>;

// Exported by tus-js-client's Node build, missing from its type declarations.
type UrlStorage = NonNullable<ConstructorParameters<typeof tus.Upload>[1]>['urlStorage'];
const { FileUrlStorage } = tus as unknown as { FileUrlStorage: new (file: string) => NonNullable<UrlStorage> };

/** Uploads at once, and the size of each piece (below what reverse proxies take per request: Cloudflare's 100 MB; a test makes it small). */
const AT_ONCE = 3;
export const TUS = { chunk: 48 * 1024 * 1024 };
/** The server's own download route: the one URL the token goes with. */
const OWN_DOWNLOAD = /^\/api\/files\/fl_[0-9a-f]{12}\/download$/;

const enc = encodeURIComponent;
const statusOf = (e: unknown): number | undefined => (e as { status?: number }).status;

/** Who writes, as the API takes it: the agent's name (the server records the account), `lampo`, this machine's name. */
function writer(by: string, via: 'vr' | 'mcp') {
  const agent = isAgent(by) ? cleanAgentName(by.replace(/^agent:?/, '')) : '';
  const machine = cleanAgentName(os.hostname(), 60);
  return { ...(agent ? { agent, agent_kind: via === 'mcp' ? ('mcp' as const) : ('cli' as const) } : {}), via, ...(machine ? { machine } : {}) };
}

/** A refusal of a commit or a push that names files changed since their base: FilesConflict with them. */
function conflictOf(e: unknown): unknown {
  const body = (e as { body?: { conflicts?: unknown } }).body;
  if (statusOf(e) === 409 && Array.isArray(body?.conflicts)) return new FilesConflict((e as Error).message, body.conflicts as FileConflict[]);
  return e;
}

export function remoteFiles(api: Api, cacheRoot: string): FileMethods {
  const files: FileMethods = {
    filesSummary: (folder) => api.get<FilesSummary>(`/api/files/summary?folder=${enc(folder)}`),
    listFiles(folder, o = {}) {
      const q = new URLSearchParams({ folder });
      if (o.path) q.set('path', o.path);
      if (o.deep) q.set('deep', '1');
      if (o.own) q.set('own', '1');
      if (o.kind) q.set('kind', o.kind);
      if (o.q) q.set('q', o.q);
      if (o.limit) q.set('limit', String(o.limit));
      if (o.cursor) q.set('cursor', o.cursor);
      return api.get<FilesListing>(`/api/files?${q}`);
    },

    async fileSources(ids, v) {
      const sources: FileSource[] = [];
      const missing: string[] = [];
      const unique = [...new Set(ids)];
      for (let i = 0; i < unique.length; i += FILE_LIMITS.urls) {
        const got = await api.call<FileUrls>('POST', '/api/files/urls', { ids: unique.slice(i, i + FILE_LIMITS.urls), ...(v ? { v } : {}) });
        missing.push(...got.missing);
        for (const u of got.urls) {
          let at: URL;
          try {
            at = new URL(u.url, api.base);
          } catch {
            missing.push(u.id);
            continue;
          }
          const { url: _, ...file } = u;
          // the server's own route takes the token, reached where this machine reaches the server (its public
          // address may be another); any other URL is its own credential and gets nothing of ours
          if (OWN_DOWNLOAD.test(at.pathname)) sources.push({ ...file, url: `${api.base}${at.pathname}${at.search}`, headers: { ...api.auth } });
          else if (at.protocol === 'https:' || at.protocol === 'http:') sources.push({ ...file, url: at.href });
          else missing.push(u.id);
        }
      }
      return { sources, missing };
    },

    async pushFiles(folder, list, o) {
      const who = writer(o.by, o.via ?? 'vr');
      const total = list.reduce((n, x) => n + x.size, 0);
      const commits: FileCommitAnswer[] = [];
      let sent = 0;
      let held = 0;
      // bytes of each file sent so far (a retry or a resume counts from where it is)
      const progress = new Map<string, number>();
      const tell = () => {
        sent = [...progress.values()].reduce((n, x) => n + x, 0);
        o.onProgress?.(sent, total);
      };
      for (let i = 0; i < list.length; i += FILE_LIMITS.batch) {
        if (o.signal?.aborted) throw new StoppedError();
        const chunk = list.slice(i, i + FILE_LIMITS.batch);
        const ask = (xs: PushFileInput[]) =>
          api
            .call<FileUploadAnswer>('POST', '/api/files/uploads', {
              folder,
              files: xs.map(({ path: p, size, sha256, base }) => ({ path: p, size, sha256, base })),
              commit: false,
              conflict: o.conflict,
              ...who,
            })
            .catch((e: unknown) => {
              throw conflictOf(e);
            });
        // the version check, the disk and the plan for the whole batch, before any byte moves
        const answer = await ask(chunk);
        const slots = new Map(answer.uploads.map((s) => [s.path, s]));
        const queue = [...chunk];
        const send = async (x: PushFileInput): Promise<void> => {
          let slot = slots.get(x.path);
          for (let tries = 0; ; tries++) {
            if (o.signal?.aborted) throw new StoppedError();
            if (!slot) throw new Error(`${x.path}: the server named no way in for it`);
            if (slot.stored) {
              held++;
              return;
            }
            try {
              await sendFile(
                api,
                cacheRoot,
                folder,
                x,
                slot,
                (n) => {
                  progress.set(x.path, n);
                  tell();
                },
                o,
              );
              return;
            } catch (e) {
              // its one-time ticket ran out while it waited behind the others (or the upload it went on was gone): asked
              // for again, once
              if (tries || (statusOf(e) !== 410 && statusOf(e) !== 404)) throw e;
              slot = (await ask([x])).uploads[0] as FileUploadSlot | undefined;
            }
          }
        };
        const workers = Array.from({ length: Math.min(AT_ONCE, queue.length) }, async () => {
          for (let x = queue.shift(); x; x = queue.shift()) await send(x);
        });
        await Promise.all(workers);
        try {
          commits.push(
            await api.call<FileCommitAnswer>('POST', '/api/files/commit', {
              folder,
              add: chunk.map(({ path: p, sha256, size, base }) => ({ path: p, sha256, size, base })),
              conflict: o.conflict,
              ...who,
            }),
          );
        } catch (e) {
          throw conflictOf(e);
        }
      }
      tell();
      return { commits, sent, held };
    },
  };
  return files;
}

/** An error a tus request ended with, with the status the server answered (a ticket that ran out: 410). */
function tusError(e: Error): Error {
  const res = (e as { originalResponse?: { getStatus(): number; getBody(): string } | null }).originalResponse;
  const status = res?.getStatus();
  let said = '';
  try {
    said = (JSON.parse(res?.getBody() || '') as { error?: string }).error || '';
  } catch {
    said = (res?.getBody() || '').slice(0, 200);
  }
  return Object.assign(new Error(said || `upload failed: ${e.message.split('\n')[0]}`), status ? { status } : {});
}

/**
 * One file's bytes over tus with its ticket, stored and not committed (the batch commits at once). An upload of the same
 * file to the same place that broke off before goes on where it stopped (tus keeps it a day, for this account).
 */
async function sendFile(
  api: Api,
  cacheRoot: string,
  folder: string,
  x: PushFileInput,
  slot: FileUploadSlot,
  onBytes: (n: number) => void,
  o: { signal?: AbortSignal; onResume?: (path: string) => void },
): Promise<void> {
  if (!slot.ticket) throw new Error(`${x.path}: the server named no ticket for it`);
  fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  let done: (body: string) => void = () => {};
  let failed: (e: Error) => void = () => {};
  const finished = new Promise<string>((resolve, reject) => {
    done = resolve;
    failed = reject;
  });
  const up = new tus.Upload(fs.createReadStream(x.file), {
    endpoint: `${api.base}/api/uploads`,
    uploadSize: x.size,
    chunkSize: TUS.chunk,
    metadata: { ticket: slot.ticket, filename: nameOf(x.path) },
    headers: api.auth,
    retryDelays: [0, 1000, 3000, 5000, 10000],
    // the same bytes for the same place on the same server: a push run again continues the upload it left
    fingerprint: async () => `lampo-file:${api.base}:${folder}:${x.path}:${x.sha256}:${x.size}`,
    urlStorage: new FileUrlStorage(path.join(cacheRoot, 'uploads.json')),
    removeFingerprintOnSuccess: true,
    onProgress: (n: number) => onBytes(n),
    onError: (e) => failed(tusError(e)),
    onSuccess: ({ lastResponse }) => done(lastResponse.getBody() || ''),
  });
  const previous = (await up.findPreviousUploads())[0];
  if (previous) {
    up.resumeFromPreviousUpload(previous);
    o.onResume?.(x.path);
  }
  const stop = () => {
    // kept on the server for its day: the same push run again goes on with it
    void up.abort(false).catch(() => {});
    failed(new StoppedError());
  };
  if (o.signal?.aborted) throw new StoppedError();
  o.signal?.addEventListener('abort', stop, { once: true });
  let r: FileUploadResult & { pending?: boolean; id?: string };
  try {
    up.start();
    r = JSON.parse((await finished) || '{}') as FileUploadResult & { pending?: boolean; id?: string };
  } finally {
    o.signal?.removeEventListener('abort', stop);
  }
  // a big file is hashed and stored after its last byte: asked until it is
  while (r.pending && r.id) {
    if (o.signal?.aborted) throw new StoppedError();
    await sleep(2000);
    const got = await api.get<{ status: string; result?: FileUploadResult; error?: string; code?: number }>(`/api/upload-results/${r.id}`);
    if (got.status === 'failed')
      throw Object.assign(new Error(`${x.path}: ${got.error || 'the server could not keep it'}`), got.code ? { status: got.code } : {});
    if (got.status === 'done' && got.result) r = got.result;
  }
  if (r.stored?.sha256 !== x.sha256) throw new Error(`${x.path}: the server kept other bytes than were sent`);
  onBytes(x.size);
}
