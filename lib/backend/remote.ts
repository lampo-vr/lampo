// A hosted video-review server, reached with an API token (`vr login`). Screenshots and frames are downloaded into
// ~/.cache/video-review/<host>/ so an agent can open them like local files; renders go up as resumable tus uploads.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import * as tus from 'tus-js-client';
import type { FootageAnswer, FootageStatus } from '../footage/types.ts';
import { slugify, validSlug } from '../paths.ts';
import { chainOf } from '../playbookFiles.ts';
import { FRAME_CACHE_BYTES, pruneDir } from '../prune.ts';
import { renderKey } from '../renderKey.ts';
import { stageOf } from '../stage.ts';
import { scopeSlug } from '../taste.ts';
import { oneLine } from '../time.ts';
import type {
  AgentStatus,
  AskCreated,
  AskView,
  ClaudeSession,
  Comment,
  DiffResult,
  ElementsAttached,
  FixPreview,
  NoteRef,
  PlaybookProposal,
  PlaybookProposalView,
  PlaybookSkillView,
  PlaybookSummary,
  PlaybookView,
  PostsResponse,
  PostView,
  QaResult,
  Review,
  ReviewEvent,
  ReviewPointers,
  StageInfo,
  Taste,
  TranscriptAnswer,
  UploadResult,
  Version,
} from '../types.ts';
import type { Credentials } from './credentials.ts';
import type { Backend, PlaybookWhere, PushResult } from './types.ts';

// Exported by tus-js-client's Node build, missing from its type declarations.
type UrlStorage = NonNullable<ConstructorParameters<typeof tus.Upload>[1]>['urlStorage'];
const { FileUrlStorage } = tus as unknown as { FileUrlStorage: new (file: string) => NonNullable<UrlStorage> };

/** A playbook question as query parameters / body fields: a video's slug, or a folder ('' = the House). */
const whereQuery = (w: PlaybookWhere) => (w.video ? `video=${encodeURIComponent(w.video)}` : `folder=${encodeURIComponent(w.folder || '')}`);
const whereBody = (w: PlaybookWhere) => (w.video ? { video: w.video } : { folder: w.folder || '' });

export class RemoteError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The HTTP client every remote call goes through. */
export function createApi(c: Credentials) {
  const base = c.server.replace(/\/+$/, '');
  const auth = { Authorization: `Bearer ${c.token}` };
  async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(base + url, {
        method,
        headers: { ...auth, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`cannot reach ${base}: ${(e as Error).cause ? String((e as Error & { cause: Error }).cause.message) : (e as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { error?: string; next?: string };
        msg = j.error || msg;
        // what to do instead, when the server says (a post drafted before final: the stage's next step)
        if (j.next) msg = `${msg} (next: ${j.next})`;
      } catch {}
      if (res.status === 401) msg = `${msg} (${base}: the token was rejected, run vr login again)`;
      throw new RemoteError(res.status, msg);
    }
    const type = res.headers.get('content-type') || '';
    return (type.includes('json') ? JSON.parse(text) : text) as T;
  }
  async function download(url: string, file: string): Promise<void> {
    const res = await fetch(base + url, { headers: auth });
    if (!res.ok) throw new RemoteError(res.status, `download ${url}: HTTP ${res.status}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    fs.renameSync(tmp, file);
  }
  return { base, auth, call, download, get: <T>(u: string) => call<T>('GET', u) };
}
type Api = ReturnType<typeof createApi>;

const enc = encodeURIComponent;
/** The files a question sends inline at most, together (raw bytes): as base64 with the rest of it, under 26 MB of JSON. */
const ASK_INLINE_TOTAL = 16 * 1024 * 1024;

// qa and diff are computed in the background on the server: ask until the answer is there.
async function poll<T>(
  api: Api,
  url: string,
  what: string,
  done: (x: T & { pending?: boolean; none?: boolean; error?: string }) => boolean,
  maxMs = 15 * 60000,
): Promise<T> {
  const until = Date.now() + maxMs;
  for (;;) {
    const x = await api.get<T & { pending?: boolean; none?: boolean; error?: string }>(url);
    if (x.none) throw new Error(x.error || `no ${what} for this version`);
    if (done(x)) return x as T;
    if (Date.now() > until) throw new Error(`the server is still working on the ${what}; try again later`);
    await sleep(2000);
  }
}

/** A render as a resumable tus upload: running vr push again continues an unfinished one. */
async function uploadRender(api: Api, cacheRoot: string, file: string, meta: Record<string, string>): Promise<UploadResult> {
  const size = fs.statSync(file).size;
  fs.mkdirSync(cacheRoot, { recursive: true });
  let resolveBody: (s: string) => void = () => {};
  let rejectBody: (e: Error) => void = () => {};
  const body = new Promise<string>((resolve, reject) => {
    resolveBody = resolve;
    rejectBody = reject;
  });
  const up = new tus.Upload(fs.createReadStream(file), {
    endpoint: `${api.base}/api/uploads`,
    uploadSize: size,
    chunkSize: 64 * 1024 * 1024,
    metadata: meta,
    headers: api.auth,
    retryDelays: [0, 1000, 3000, 5000, 10000],
    // Remembers unfinished uploads (by path, size, mtime and server): running vr push again continues them.
    urlStorage: new FileUrlStorage(path.join(cacheRoot, 'uploads.json')),
    removeFingerprintOnSuccess: true,
    onError: (e) => rejectBody(new Error(`upload failed: ${e.message.split('\n')[0]}`)),
    onSuccess: ({ lastResponse }) => resolveBody(lastResponse.getBody() || ''),
  });
  const previous = (await up.findPreviousUploads()).find((p) => JSON.stringify(p.metadata) === JSON.stringify(meta));
  if (previous) up.resumeFromPreviousUpload(previous);
  up.start();
  let r = JSON.parse((await body) || '{}') as UploadResult & { pending?: boolean; id?: string };
  // Big renders into remote storage finish after the last byte: ask until the version is registered.
  while (r.pending && r.id) {
    await sleep(2000);
    const o = await api.get<{ status: string; result?: UploadResult; error?: string }>(`/api/upload-results/${r.id}`);
    if (o.status === 'failed') throw new Error(o.error || 'the server could not register the upload');
    if (o.status === 'done' && o.result) r = o.result;
  }
  if (!r.slug) throw new Error('the server did not say what became of the upload');
  return r;
}

/** A fix preview through a one-time upload URL (one plain PUT): stills and clips alike, whatever their size. */
async function uploadPreview(api: Api, commentId: string, file: string, request: object): Promise<{ preview: FixPreview; comment: Comment }> {
  const { upload: ticket } = await api.call<{ upload: { url: string } }>('POST', `/api/comments/${enc(commentId)}/previews`, request);
  const bytes = fs.readFileSync(file);
  // The URL carries the server's public address; this machine may reach it under another (a tunnel, a proxy).
  const url = api.base + new URL(ticket.url, api.base).pathname;
  const res = await fetch(url, { method: 'PUT', body: bytes, headers: { 'content-length': String(bytes.length) } });
  const out = (await res.json().catch(() => ({}))) as { preview?: FixPreview; comment?: Comment; error?: string; pending?: boolean };
  if (!res.ok) throw new RemoteError(res.status, out.error || `upload failed: HTTP ${res.status}`);
  if (out.pending) {
    for (let i = 0; i < 120; i++) {
      await sleep(1000);
      const again = await fetch(url);
      const x = (await again.json().catch(() => ({}))) as typeof out;
      if (again.status === 422) throw new RemoteError(422, x.error || 'the preview was refused');
      if (x.preview && x.comment) return { preview: x.preview, comment: x.comment };
    }
    throw new Error('the server is still processing the preview; check the note later');
  }
  if (!out.preview || !out.comment) throw new Error('unexpected answer from the server');
  return { preview: out.preview, comment: out.comment };
}

// A reference file: inline up to 8 MB, else through a one-time upload URL (one PUT), waiting while the server works.
async function uploadRef(api: Api, commentId: string, file: string, request: Record<string, unknown>): Promise<{ ref: NoteRef; comment: Comment }> {
  const bytes = fs.readFileSync(file);
  if (bytes.length <= 8 * 1024 * 1024) {
    const out = await api.call<{ ref: NoteRef; comment: Comment }>('POST', `/api/comments/${enc(commentId)}/refs`, {
      ...request,
      data: bytes.toString('base64'),
    });
    return { ref: out.ref, comment: out.comment };
  }
  const { upload: ticket } = await api.call<{ upload: { url: string } }>('POST', `/api/comments/${enc(commentId)}/refs`, request);
  const url = api.base + new URL(ticket.url, api.base).pathname;
  const res = await fetch(url, { method: 'PUT', body: bytes, headers: { 'content-length': String(bytes.length) } });
  const out = (await res.json().catch(() => ({}))) as { ref?: NoteRef; comment?: Comment; error?: string; pending?: boolean };
  if (!res.ok) throw new RemoteError(res.status, out.error || `upload failed: HTTP ${res.status}`);
  for (let i = 0; out.pending && i < 180; i++) {
    await sleep(1000);
    const again = await fetch(url);
    const x = (await again.json().catch(() => ({}))) as typeof out;
    if (again.status === 422) throw new RemoteError(422, x.error || 'the reference was refused');
    if (x.ref && x.comment) return { ref: x.ref, comment: x.comment };
  }
  if (!out.ref || !out.comment)
    throw new Error(out.pending ? 'the server is still processing the file; check the note later' : 'unexpected answer from the server');
  return { ref: out.ref, comment: out.comment };
}

/**
 * The server's live events (SSE), reconnecting with backoff until the token is rejected. Inside a Claude Code session
 * a heartbeat says "I'm here", so the server can offer the session in its picker.
 */
async function watchEvents(
  api: Api,
  onEvent: (e: ReviewEvent) => void,
  session: { sessionId?: string | null; name?: string | null; cwd?: string | null } | null | undefined,
  localEvent: (e: ReviewEvent) => Promise<ReviewEvent>,
  signal?: AbortSignal,
): Promise<void> {
  const beat = () =>
    session?.sessionId &&
    api
      .call('POST', '/api/agents/heartbeat', {
        session_id: session.sessionId,
        name: session.name || 'agent',
        cwd: session.cwd || process.cwd(),
        host: os.hostname(),
        // `vr watch` announces itself only from inside a Claude Code session (lib/sessions.ts currentSession).
        kind: 'claude-code',
      })
      .catch(() => {});
  beat();
  const beating = setInterval(beat, 30_000);
  signal?.addEventListener('abort', () => clearInterval(beating), { once: true });
  for (let delay = 1000; !signal?.aborted; delay = Math.min(delay * 2, 30_000)) {
    try {
      const res = await fetch(`${api.base}/api/events`, { headers: { ...api.auth, Accept: 'text/event-stream' }, signal });
      if (res.status === 401) throw new Error('the token was rejected, run vr login again');
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      delay = 1000;
      let buf = '';
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk as Uint8Array, { stream: true });
        let i = buf.indexOf('\n\n');
        while (i >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          i = buf.indexOf('\n\n');
          const type = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (type === 'event' && data) onEvent(await localEvent(JSON.parse(data) as ReviewEvent));
        }
      }
    } catch (e) {
      if (signal?.aborted) return;
      if (/token was rejected/.test((e as Error).message)) throw e;
      process.stderr.write(`vr watch: connection lost (${(e as Error).message}), reconnecting…\n`);
    }
    await sleep(delay, undefined, { signal }).catch(() => {});
  }
}

export function createRemoteBackend(c: Credentials, { cacheRoot }: { cacheRoot: string }): Backend {
  const api = createApi(c);
  // The server's screenshots, frames and taste files land here: the person's alone on a shared machine (A12 AGENT-13).
  try {
    fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
    if (fs.statSync(cacheRoot).mode & 0o077) fs.chmodSync(cacheRoot, 0o700);
  } catch {}
  const host = new URL(api.base).host.replace(/[^\w.-]/g, '_');
  const cache = path.resolve(cacheRoot, host);
  // Where a download lands: inside the cache, always. The server names these files (slugs, version hashes, skill names),
  // so a name that climbs out (`../`) gets no local path at all.
  const inCache = (...parts: string[]): string | null => {
    const p = path.resolve(cache, ...parts);
    return p.startsWith(cache + path.sep) ? p : null;
  };
  const shotFile = (slug: string, file: string | null | undefined) => (file && validSlug(slug) ? inCache(slug, path.basename(file)) : null);
  const slugOf = (r: Review) => slugify(r.video);

  async function fetchShot(slug: string, file: string | null | undefined): Promise<void> {
    const local = shotFile(slug, file);
    if (!local || fs.existsSync(local)) return;
    try {
      await api.download(`/data/${enc(slug)}/${enc(path.basename(file as string))}`, local);
    } catch {}
  }

  // Events carry screenshot URLs (/data/<slug>/<file>); agents want files.
  async function localEvent(e: ReviewEvent): Promise<ReviewEvent> {
    if (!e.shots) return e;
    await fetchShot(e.slug, e.shots.marked);
    if (e.shots.range) await fetchShot(e.slug, e.shots.range);
    return {
      ...e,
      shots: {
        clean: shotFile(e.slug, e.shots.clean),
        marked: shotFile(e.slug, e.shots.marked),
        ...(e.shots.range ? { range: shotFile(e.slug, e.shots.range) } : {}),
      },
    };
  }

  const stages = new Map<string, StageInfo>();
  const backend: Backend = {
    kind: 'remote',
    where: `server: ${api.base}${c.user ? ` (as ${c.user.name})` : ''}`,

    async listReviews() {
      const list = (await api.get<{ reviews: { slug: string; review: Review; stage?: StageInfo }[] }>('/api/reviews')).reviews;
      for (const x of list) if (x.stage) stages.set(x.slug, x.stage);
      return list.map((x) => x.review);
    },

    // The server knows the review links and running sessions; without its word, the stage from the review alone.
    stage: (review) => stages.get(slugOf(review)) ?? stageOf(review),

    async resolve(arg, { mustExist = true } = {}) {
      if (!arg) throw new Error('missing <video>');
      const reviews = await backend.listReviews();
      // The path as `vr ls` prints it, also without its leading slash ("@uploads/Acme/x.mp4" is that video, not every x.mp4).
      const exact = reviews.find((r) => slugOf(r) === arg || r.video === arg || r.video === `/${arg}`);
      if (exact) return { video: exact.video, slug: slugOf(exact) };
      const local = path.resolve(arg);
      // A part of a path first; only when nothing has it, the file name of a local render (./export/x.mp4).
      const parts = reviews.filter((r) => r.video.includes(arg));
      const hits = parts.length ? parts : reviews.filter((r) => r.video.endsWith(`/${path.basename(arg)}`));
      if (hits.length === 1) return { video: hits[0].video, slug: slugOf(hits[0]) };
      // one line each: a file's name is someone's, and may hold a line break (a name kept from before)
      if (hits.length > 1) throw new Error(`"${oneLine(arg)}" matches ${hits.length} videos:\n  ${hits.map((r) => oneLine(r.video)).join('\n  ')}`);
      // A render on this machine, about to be uploaded (vr add / track): only when the caller asked to track one.
      if (!mustExist) return { video: local, slug: '', fresh: true };
      throw new Error(`no reviewed video matches "${arg}" on ${api.base}`);
    },

    async review(slug) {
      const res = await api.get<{ review: Review; summary?: { stage?: StageInfo } }>(`/api/review/${enc(slug)}`);
      if (res.summary?.stage) stages.set(slug, res.summary.stage);
      return res.review;
    },

    async findComment(id) {
      try {
        return await api.get<{ slug: string; review: Review; comment: Comment }>(`/api/comments/${enc(id)}`);
      } catch (e) {
        if ((e as RemoteError).status === 404) return null;
        throw e;
      }
    },

    async ask(input) {
      // Files go inline up to 8 MB each while the question's request stays under ASK_INLINE_TOTAL (the server takes
      // 26 MB of JSON, and base64 is a third bigger); bigger ones and the rest go to the upload URL the server hands
      // back for each (A12 OPT-8).
      const later = new Map<string, string>();
      let inline = 0;
      const options = input.groups.map((g) => ({
        id: g.id,
        ...(g.label ? { label: g.label } : {}),
        ...(g.pick ? { pick: g.pick } : {}),
        items: g.items.map((it) => {
          const base = { id: it.id, ...(it.label ? { label: it.label } : {}) };
          if (it.url) return { ...base, ref: { kind: 'link', url: it.url } };
          if (it.video !== undefined && it.frame !== undefined)
            return { ...base, ref: { kind: 'frame', video: it.video, v: it.v, frame: it.frame, to_frame: it.to_frame } };
          if (!it.path) return it.upload ? { ...base, ref: { kind: 'file' } } : base;
          if (!fs.existsSync(it.path)) throw new Error(`file not found: ${it.path}`);
          const size = fs.statSync(it.path).size;
          if (size <= 8 * 1024 * 1024 && inline + size <= ASK_INLINE_TOTAL) {
            inline += size;
            return { ...base, ref: { kind: 'file', data: fs.readFileSync(it.path).toString('base64') } };
          }
          later.set(`${g.id}/${it.id}`, it.path);
          return { ...base, ref: { kind: 'file' } };
        }),
      }));
      const out = await api.call<AskCreated>('POST', '/api/asks', {
        ...(input.slug ? { video: input.slug } : { folder: input.folder }),
        text: input.text,
        options,
        ...(input.answer_prompt ? { answer_prompt: input.answer_prompt } : {}),
        by: input.by,
      });
      for (const [key, file] of later) {
        const ticket = out.uploads[key];
        if (!ticket) continue;
        const bytes = fs.readFileSync(file);
        const url = api.base + new URL(ticket.url, api.base).pathname;
        const res = await fetch(url, { method: 'PUT', body: bytes, headers: { 'content-length': String(bytes.length) } });
        let o = (await res.json().catch(() => ({}))) as { pending?: boolean; error?: string };
        if (!res.ok) throw new RemoteError(res.status, `${key}: ${o.error || `upload failed: HTTP ${res.status}`}`);
        for (let i = 0; o.pending && i < 180; i++) {
          await sleep(1000);
          const again = await fetch(url);
          o = (await again.json().catch(() => ({}))) as typeof o;
          if (again.status === 422) throw new RemoteError(422, `${key}: ${o.error || 'the file was refused'}`);
        }
        delete out.uploads[key];
      }
      return out;
    },

    async draftPost({ slug, platform, fields, by }) {
      // the server records the account it knows the caller by, never one a client names
      const post = await api.call<PostView>('POST', `/api/review/${enc(slug)}/posts`, { platform, ...fields, by });
      const created = post.history?.length === 1 && post.history[0]?.state === 'draft' && post.created === post.updated;
      return { post, created };
    },

    async posts(slug) {
      return (await api.get<PostsResponse>(`/api/posts${slug ? `?slug=${enc(slug)}` : ''}`)).posts;
    },

    async findFootage(req) {
      const q = new URLSearchParams({ q: req.query });
      for (const k of ['aspect', 'min_s', 'max_s', 'motion', 'text', 'said', 'limit'] as const) if (req[k] !== undefined) q.set(k, String(req[k]));
      // the server's shots never name files on it (the route leaves `file` out for anyone but the machine itself)
      const a = await api.get<FootageAnswer>(`/api/footage/find?${q}`);
      for (const s of a.shots) delete s.file;
      return a;
    },
    async footageSheet(ids, out) {
      const name = `${
        ids
          .map((i) => i.replace(/[^\w-]/g, ''))
          .join('-')
          .slice(0, 120) || 'sheet'
      }.jpg`;
      const file = out ? path.resolve(out) : inCache('footage', name);
      if (!file) throw new Error('could not name the sheet');
      await api.download(`/api/footage/sheet?ids=${enc(ids.join(','))}`, file);
      return { file };
    },
    footageStatus: () => api.get<FootageStatus>('/api/footage/status'),
    setFootage: (on, by) => api.call<FootageStatus>('PUT', '/api/footage/settings', { on, by }),

    async askView(id) {
      try {
        return await api.get<AskView>(`/api/asks/${enc(id)}`);
      } catch (e) {
        if ((e as RemoteError).status === 404) return null;
        throw e;
      }
    },

    async addNote(slug, n) {
      // The server records the account it knows the caller by, never one a client names.
      const { author, author_id: _, ...rest } = n;
      const comment = await api.call<Comment>('POST', `/api/review/${enc(slug)}/comments`, { ...rest, by: author });
      const review = await backend.review(slug);
      await backend.fetchShots(review, [comment]);
      return { comment, review };
    },

    updateComment: (id, p) =>
      api.call<Comment>('PATCH', `/api/comments/${enc(id)}`, { status: p.status, note: p.note, fixed_in_v: p.fixed_in_v, preview: p.preview, by: p.by }),

    attachPreview: (commentId, file, { by, ...p }) => uploadPreview(api, commentId, file, { ...p, by }),

    async attachRef(commentId, input) {
      const { caption, note, by } = input;
      if (input.kind === 'file') {
        if (!fs.existsSync(input.path)) throw new Error(`file not found: ${input.path}`);
        return uploadRef(api, commentId, input.path, { kind: input.as || 'file', caption, note, by });
      }
      const body =
        input.kind === 'link'
          ? { kind: 'link', url: input.url, caption, note, by }
          : { kind: 'frame', video: input.video, v: input.v, frame: input.frame, to_frame: input.to_frame, caption, note, by };
      const out = await api.call<{ ref: NoteRef; comment: Comment }>('POST', `/api/comments/${enc(commentId)}/refs`, body);
      return { ref: out.ref, comment: out.comment };
    },
    async refFile(review, file) {
      const local = inCache(slugOf(review), 'refs', path.basename(file));
      if (!local) return null;
      if (!fs.existsSync(local))
        try {
          await api.download(`/api/refs/${enc(slugOf(review))}/${enc(path.basename(file))}`, local);
        } catch {
          return null;
        }
      return local;
    },
    refLocation: (review, file) => `${api.base}/api/refs/${enc(slugOf(review))}/${enc(file)}`,

    // Attributed to the token's account, like every other write without `by`.
    async setSource(slug, v, source) {
      const ver = v ?? (await backend.review(slug)).versions.at(-1)?.v;
      if (!ver) throw new Error('this video has no versions');
      return api.call<Version>('PUT', `/api/review/${enc(slug)}/versions/${ver}/source`, source ?? {});
    },

    async track(videoPath, { by, session, folder }) {
      if (!fs.existsSync(videoPath)) throw new Error(`file not found: ${videoPath}`);
      const r = await backend.push(videoPath, { by, folder: folder ?? null });
      if (session !== undefined) await backend.assign(slugOf(r.review), session, by);
      return { review: session !== undefined ? await backend.review(slugOf(r.review)) : r.review, created: r.created };
    },

    async push(file, { folder, name, to, part }): Promise<PushResult> {
      const meta: Record<string, string> = { filename: name || path.basename(file) };
      if (folder) meta.folder = folder;
      if (to) meta.slug = to;
      if (part) {
        meta.part_at = String(part.at);
        if (part.handles !== undefined) meta.handles = String(part.handles);
      }
      const r = await uploadRender(api, cacheRoot, file, meta);
      return { review: await backend.review(r.slug), created: r.created, duplicate: r.duplicate, v: r.v, ...(r.part ? { part: r.part } : {}) };
    },

    async putElements(slug, v, map) {
      const ver = v ?? (await backend.review(slug)).versions.at(-1)?.v;
      if (!ver) throw new Error('this video has no versions');
      return api.call<ElementsAttached>('PUT', `/api/review/${enc(slug)}/versions/${ver}/elements`, map);
    },
    // Worked out by the server, where the maps are. A server from before elements maps answers 404: no pointers, then.
    async pointers(review, comments) {
      try {
        const all = await api.get<ReviewPointers>(`/api/review/${enc(slugOf(review))}/elements`);
        const notes = Object.fromEntries(comments.flatMap((c) => (Object.hasOwn(all.notes, c.id) ? [[c.id, all.notes[c.id]]] : [])));
        return { notes, names: all.names };
      } catch (e) {
        if ((e as RemoteError).status === 404) return { notes: {}, names: {} };
        throw e;
      }
    },

    async move(slug, folder, by) {
      await api.call('PUT', `/api/review/${enc(slug)}/folder`, { folder, by });
      return backend.review(slug);
    },

    async folders() {
      return (await api.get<{ folders: string[] }>('/api/folders')).folders;
    },

    async assign(slug, session, by) {
      await api.call(
        'PUT',
        `/api/review/${enc(slug)}/session`,
        session ? { name: session.name, sessionId: session.sessionId || session.id || null, cwd: session.cwd || null, by } : { by },
      );
    },

    async sync(slug) {
      return api.call('POST', `/api/review/${enc(slug)}/sync`);
    },

    async sessions() {
      return (await api.get<{ sessions: ClaudeSession[] }>('/api/sessions')).sessions;
    },

    async transcript(review, ver, { rerun = false, progress } = {}) {
      const slug = slugOf(review);
      if (rerun) await api.call('POST', `/api/review/${enc(slug)}/transcript/rerun?v=${ver.v}`);
      progress?.(`the server is listening to v${ver.v} (speech to text)…`);
      const until = Date.now() + 30 * 60_000;
      for (;;) {
        const a = await api.get<TranscriptAnswer>(`/api/review/${enc(slug)}/transcript?v=${ver.v}`);
        if (a.state === 'ready') return a.transcript;
        if (a.state !== 'pending') throw new Error(a.error || `no transcript for v${ver.v}`);
        if (Date.now() > until) throw new Error('the server is still listening; try again later');
        await sleep(2000);
      }
    },

    async qa(review, ver, { rerun = false, progress } = {}) {
      const slug = slugOf(review);
      if (rerun) await api.call('POST', `/api/qa/${enc(slug)}/${ver.v}/rerun`);
      progress?.(`the server is pre-reviewing v${ver.v} (OCR, safe zones, cuts, audio)…`);
      return poll<QaResult>(api, `/api/qa/${enc(slug)}/${ver.v}`, 'pre-review', (x) => Array.isArray(x.items));
    },

    async diff(review, _ov, nv) {
      return poll<DiffResult>(
        api,
        `/api/diff/${enc(slugOf(review))}/${nv.v}`,
        'diff',
        (x) => !x.pending && (Array.isArray((x as { ranges?: unknown }).ranges) || 'incomparable' in x),
      );
    },

    async taste(scope) {
      const q = scope.folder ? `folder=${enc(scope.folder)}` : scope.project ? `project=${enc(scope.project)}` : '';
      const t = await api.get<Taste>(`/api/taste?${q}`);
      const file = path.join(cache, 'taste', `${scopeSlug(t.scope)}.md`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, t.markdown);
      return { taste: t, file };
    },

    playbook: (where) => api.get<PlaybookView>(`/api/playbook?${whereQuery(where)}`),
    skill: (where, name) => api.get<PlaybookSkillView>(`/api/playbook/skill?${whereQuery(where)}&name=${enc(name)}`),
    async skillFile(scope, skill, name) {
      const local = inCache('playbooks', slugify(scope || 'house'), skill, path.basename(name));
      if (!local) return null;
      try {
        await api.download(`/api/playbook/skill/files?folder=${enc(scope)}&skill=${enc(skill)}&name=${enc(name)}`, local);
      } catch {
        return null;
      }
      return local;
    },
    async playbookStamp(folder) {
      const all = (await api.get<{ playbooks: PlaybookSummary[] }>('/api/playbooks')).playbooks;
      return chainOf(folder).flatMap((scope) => all.filter((p) => p.scope === scope && p.rev > 0).map((p) => ({ scope, rev: p.rev })));
    },
    proposePlaybook: (where, input) => api.call<PlaybookProposal>('POST', '/api/playbook/proposals', { ...whereBody(where), ...input }),
    proposal: (id) => api.get<PlaybookProposalView>(`/api/playbook/proposals/${enc(id)}`),

    async setStatus(slug, status, by) {
      return (await api.call<{ status: AgentStatus | null }>('PUT', `/api/review/${enc(slug)}/agent-status`, { ...(status || { text: null }), by })).status;
    },

    async events(limit, o) {
      const since = o?.since ? `&since=${enc(o.since)}` : '';
      const evs = (await api.get<{ events: ReviewEvent[] }>(`/api/inbox?all=1&limit=${Math.min(limit, 5000)}${since}`)).events.reverse();
      return Promise.all(evs.map(localEvent));
    },

    watch: (onEvent, { session, signal } = {}) => watchEvents(api, onEvent, session, localEvent, signal),

    shotFile: (review, file) => shotFile(slugOf(review), file),
    async fetchShots(review, comments) {
      const slug = slugOf(review);
      await Promise.all(comments.flatMap((cm) => [fetchShot(slug, cm.shots?.marked), fetchShot(slug, cm.shots?.clean), fetchShot(slug, cm.shots?.range)]));
    },
    async frame(review, ver, frame) {
      const png = inCache('frames', `${renderKey(ver).slice(0, 16)}_${frame}.png`);
      if (!png) throw new Error(`the server named v${ver.v} oddly (hash ${JSON.stringify(renderKey(ver).slice(0, 16))}); not downloading it`);
      if (!fs.existsSync(png)) {
        await api.download(`/api/review/${enc(slugOf(review))}/frame?v=${ver.v}&frame=${frame}`, png);
        pruneDir(path.dirname(png), FRAME_CACHE_BYTES, (f) => f.endsWith('.png') && f !== path.basename(png));
      }
      return png;
    },
    reviewData: (review) => `${api.base}/api/review/${enc(slugOf(review))}`,
    inboxMarkdown: () => api.get<string>('/api/inbox.md'),
    // The server leaves agent details out by the token's role.
    reviewMarkdown: (slug) => api.get<string>(`/api/review/${enc(slug)}/md`),
  };
  return backend;
}
