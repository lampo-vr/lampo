// Uploads over tus (resumable: renders are big and connections drop). Metadata: filename, and optionally folder
// ("Acme/Reels") or slug (upload a new version of that video). When the last byte arrives the render is checked
// (ffprobe: a real video container with frames) and becomes the next version of its review.
// The finishing request waits up to 45 s for that (proxies such as Cloudflare cut requests at 100 s); slower ingests
// (big renders into remote storage) finish in the background and are reported at GET /api/upload-results/:id.
// Upload tickets (server/uploadTickets.ts) take the same path with one plain PUT.
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { FileStore } from '@tus/file-store';
import { Server, type Upload } from '@tus/server';
import express, { type Response, type Router } from 'express';
import { excerpt, words } from '../../lib/activityText.ts';
import { attachOptionFile, type OptionAttached, type OptionTarget } from '../../lib/askOptions.ts';
import { getUser } from '../../lib/auth.ts';
import { type FileTarget, ingestFile } from '../../lib/files.ts';
import { FILE_LIMITS, nameOf } from '../../lib/fileText.ts';
import { checkNotArchived, checkReviewOpen } from '../../lib/folderIds.ts';
import { cursorAt, waitNowLine } from '../../lib/handoff.ts';
import { unlessBusy } from '../../lib/jobs.ts';
import { ingestPart } from '../../lib/parts.ts';
import { CACHE, isoLocal, slugify } from '../../lib/paths.ts';
import { can } from '../../lib/permissions.ts';
import { type Attached, attachPreview, PREVIEW_LIMITS, type PreviewTarget } from '../../lib/previews.ts';
import { publicMessage, statusOf } from '../../lib/publicError.ts';
import { attachDraftRefFile, attachRefFile, REF_LIMITS, type RefAttached, type RefTarget } from '../../lib/refs.ts';
import { currentWorkspace, DEFAULT_WORKSPACE, inWorkspace } from '../../lib/scope.ts';
import * as store from '../../lib/store.ts';
import type { FileUploadResult, Role, UploadResult } from '../../lib/types.ts';
import * as workspaces from '../../lib/workspaces.ts';
import type { ServerContext } from '../context.ts';
import { countStep } from '../funnel.ts';
import { body, fail, failFrom, HttpError, router } from '../http.ts';
import { SUSPENDED_ERROR } from '../permissions.ts';
import { freeBytes } from '../ready.ts';
import { issuerOf, type Outcome, TicketInput, teamGuard, type UploadMeta, uploadMeta } from '../uploadTickets.ts';

const UPLOAD_ID = /^[a-f0-9]{32}$/;

/** A tus hook error: sent to the client as status + body. */
const reject = (status_code: number, body: string) => ({ status_code, body });

/**
 * The most uploads one account may have started and not finished at once (tus keeps one 24 h): more than a person drops
 * into the app at once, far fewer than a script could hold open (A13 MEDIA-5).
 */
export const OPEN_UPLOADS_PER_ACCOUNT = 50;
/** How long tus keeps an unfinished upload (its sweep runs hourly). */
const KEPT_MS = 24 * 3600_000;
/**
 * What an upload under way holds of the disk's room (A13 VERIFY-1): only while it moves — an upload no byte reached
 * for `stalledMs` holds none (sent to again, its rest must fit beside the others then) —, and what one account's or one
 * workspace's uploads hold counts against anyone else's upload up to `share` of the room. Declared and never sent,
 * eleven 90 MB uploads of one account kept every other workspace's upload out for their day.
 */
export const UPLOAD_ROOM = { stalledMs: 10 * 60_000, share: 0.5 };

/** An upload under way: whose, how big it said it is, how much of it has landed, and when a byte last did. */
interface UnderWay {
  id: string;
  kind: 'tus' | 'direct';
  ws: string;
  by: string;
  size: number;
  offset: number;
  moved: number;
}
/** What uploads under way still bring to the disk (what landed is in its free space already). */
const stillToCome = (open: UnderWay[]): number => open.reduce((n, o) => n + Math.max(0, o.size - o.offset), 0);
/** What a workspace's uploads under way will add to its storage, all of it: what the plan counts. */
const declaredIn = (open: UnderWay[], ws: string): number => open.reduce((n, o) => n + (o.ws === ws ? o.size : 0), 0);
/** What `open` still brings, per account (or per workspace for uploads no account made) or per workspace, each up to `cap`. */
const cappedBy = (open: UnderWay[], key: (o: UnderWay) => string, cap: number): number => {
  const per: Record<string, number> = {};
  for (const o of open) per[key(o)] = (per[key(o)] ?? 0) + Math.max(0, o.size - o.offset);
  return Object.values(per).reduce((n, v) => n + Math.min(v, cap), 0);
};

export function uploadRoutes(ctx: ServerContext): Router {
  const r = router();
  const dir = path.join(CACHE, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  // What became of an upload, for an hour: for the workspace and the person who uploaded it only.
  const outcomes = new Map<string, Outcome & { at: number; ws: string; by: string }>();
  const remember = (id: string, o: Outcome, ws: string, by: string) => {
    outcomes.set(id, { ...o, at: Date.now(), ws, by });
    for (const [k, v] of outcomes) if (Date.now() - v.at > 3600_000) outcomes.delete(k);
  };

  // The Express request behind a tus hook (it carries req.auth from the guard).
  const nodeReq = (req: Request) =>
    (req as Request & { runtime?: { node?: { req: IncomingMessage } } }).runtime?.node?.req as IncomingMessage & {
      auth?: { name: string; user: { id: string } | null; workspace: string; via?: string; role?: Role };
    };
  /** The workspace and account an upload belongs to (written into its metadata when it was made). */
  const ownerOf = (upload: Partial<Pick<Upload, 'metadata'>>) => ({ ws: upload.metadata?.vr_ws || DEFAULT_WORKSPACE, by: upload.metadata?.vr_by || '' });

  /** What a plan may limit before bytes are taken: the upload's size, and a new video (server/extension.ts). */
  async function plan(ws: string, meta: UploadMeta, size: number): Promise<void> {
    // nothing new in an archived project (no new video, no next version): refused before a byte is taken
    inWorkspace(ws, () => (meta.slug ? checkReviewOpen(store.loadReview(meta.slug)) : checkNotArchived(meta.folder)));
    await ctx.extension.check(ws, 'upload', size);
    if (!meta.part && inWorkspace(ws, () => store.uploadMakesVideo(meta))) await ctx.extension.check(ws, 'video');
  }

  function validate(meta: Upload['metadata']): UploadMeta {
    try {
      return uploadMeta(meta || {});
    } catch (e) {
      throw reject(400, (e as Error).message);
    }
  }

  // A finished upload (tus or ticket) becomes the next version of its review; the file (and tus's metadata file next
  // to it) is gone afterwards either way.
  async function ingest(
    file: string,
    { name, folder, slug, part }: UploadMeta,
    by: string,
    byId?: string,
    session?: store.SessionInput,
  ): Promise<UploadResult> {
    try {
      const o = { name, folder, slug, by, byId, ...(session ? { session } : {}) };
      const { review, created, version, duplicate } = part ? await ingestPart(file, { ...o, ...part }) : await store.ingestUpload(file, o);
      const s = slugify(review.video);
      // the workspace's first video of its own (the sample is made elsewhere): the funnel's step (lib/funnel.ts)
      if (created && !review.onboarding_sample) countStep(ctx, 'video_first');
      if (!duplicate) {
        ctx.background.warm(review);
        // the uploader's languages: the on-screen text is most likely in one of them
        unlessBusy(() => ctx.background.startQa(review, version.v, byId ? getUser(byId)?.prefs?.voice_languages : undefined));
      }
      ctx.broadcast('library', { slug: s });
      ctx.broadcast('review', { slug: s });
      return { slug: s, v: version.v, created, duplicate, video: review.video, ...(version.part ? { part: version.part } : {}) };
    } finally {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}.json`, { force: true });
    }
  }

  /**
   * A project file's bytes arrived (a ticket's PUT, or tus with its ticket): stored once per workspace, committed at its
   * path when its ticket says so (lib/files.ts); the file (and tus's metadata file next to it) is gone afterwards either
   * way. Its area hears it live (the team's streams only: reviewers don't see files).
   */
  async function ingestProjectFile(file: string, target: FileTarget): Promise<FileUploadResult> {
    try {
      const out = await ingestFile(file, target);
      if (out.commit) ctx.broadcast('files', { area: out.commit.folder, rev: out.commit.rev }, 'files');
      return out;
    } finally {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}.json`, { force: true });
    }
  }

  /**
   * The disk keeps its reserve: refused up front rather than failing at 90 %.
   * Whether `size` more bytes for `mine` (an account in a workspace) fit on the disk beside the uploads under way that
   * move (UPLOAD_ROOM): its own account's and workspace's count in full, anyone else's per account and per workspace up to
   * a share of the room each. What one holds beyond its share doesn't keep the others out; that one gives way instead,
   * at its next PATCH (the same check, `except` the upload itself).
   */
  const fitsBeside = (size: number, mine: { ws: string; by: string }, open: UnderWay[], except?: string): boolean => {
    const free = freeBytes(dir);
    if (free === null) return true;
    const room = free - (ctx.cfg.min_free_bytes ?? 0);
    const now = Date.now();
    const moving = open.filter((o) => o.id !== except && now - o.moved <= UPLOAD_ROOM.stalledMs);
    const own = (o: UnderWay) => o.ws === mine.ws || (!!mine.by && o.by === mine.by);
    const others = moving.filter((o) => !own(o));
    const cap = Math.max(0, room) * UPLOAD_ROOM.share;
    // One account across workspaces, or several accounts in one workspace: each grouping keeps one to its share.
    const theirs = Math.min(
      cappedBy(others, (o) => (o.by ? `a:${o.by}` : `w:${o.ws}`), cap),
      cappedBy(others, (o) => o.ws, cap),
    );
    return size + stillToCome(moving.filter(own)) + theirs <= room;
  };

  // Uploads under way hold their room (A13 MEDIA-5): every upload started and not finished still brings its remaining
  // bytes to the disk and its whole size to its workspace's storage, so the checks of a new one count them — a check
  // against what is stored alone let five 90 MB uploads through with room for one. tus's uploads are read from its
  // folder (each one's metadata file beside its bytes: they outlive a restart; the bytes' mtime says when it last
  // moved); `held` keeps what that doesn't list: a tus upload checked a moment ago whose metadata isn't written yet,
  // and a one-time URL's PUT while it streams.
  const held = new Map<string, UnderWay & { at: number }>();
  async function underWay(): Promise<UnderWay[]> {
    const found = new Map<string, UnderWay>();
    const now = Date.now();
    const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
    await Promise.all(
      names
        .filter((n) => n.endsWith('.json') && UPLOAD_ID.test(n.slice(0, -5)))
        .map(async (n) => {
          const id = n.slice(0, -5);
          try {
            const info = JSON.parse(await fs.promises.readFile(path.join(dir, n), 'utf8')) as Partial<Upload>;
            // past its day: tus's hourly sweep removes it
            if (info.creation_date && now - Date.parse(info.creation_date) > KEPT_MS) return;
            const bytes = await fs.promises.stat(path.join(dir, id));
            const o = ownerOf(info);
            found.set(id, { id, kind: 'tus', ws: o.ws, by: o.by, size: Number(info.size) || 0, offset: bytes.size, moved: bytes.mtimeMs });
          } catch {
            // finished and removed meanwhile, or half written: the next look sees it as it is
          }
        }),
    );
    for (const [id, h] of held) {
      // tus lists it now (POST_CREATE lets go of it too), or its creation failed after the check
      if (h.kind === 'tus' && (found.has(id) || now - h.at > 60_000)) held.delete(id);
      else if (!found.has(id)) {
        // a one-time URL's PUT: its file says how far it is and when a byte last came
        const bytes = h.kind === 'direct' ? await fs.promises.stat(path.join(dir, id)).catch(() => null) : null;
        found.set(id, bytes ? { ...h, offset: bytes.size, moved: Math.max(h.at, bytes.mtimeMs) } : h);
      }
    }
    return [...found.values()];
  }
  // One check at a time: two uploads checked at the same moment would each find room the other then takes.
  let turn: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = turn.then(fn, fn);
    turn = p.catch(() => {});
    return p;
  };

  // Uploads by agents (API tokens) whose progress shows live: id → who and what (forgotten when they finish).
  const uploaders = new Map<string, { agent: string; name: string; slug: string | null; ws: string }>();
  const datastore = new FileStore({ directory: dir, expirationPeriodInMilliseconds: 24 * 3600_000 });
  const tus = new Server({
    path: '/api/uploads',
    datastore,
    // a render is held to upload_max_bytes when it is made (onUploadCreate); a project file to FILE_LIMITS.fileBytes
    maxSize: Math.max(ctx.cfg.upload_max_bytes, FILE_LIMITS.fileBytes),
    relativeLocation: true,
    respectForwardedHeaders: ctx.hosted && !!ctx.cfg.trust_proxy,
    // Same origin only: no Access-Control-Allow-Origin header at all.
    allowedOrigins: [],
    // An agent's upload reports its progress (the tus events Lampo gets anyway) as live activity, once a second.
    postReceiveInterval: 1000,
    // Every upload belongs to the workspace and the person that started it: written into its metadata (whatever the
    // client sent there), and checked on every later request for it (onIncomingRequest).
    async onUploadCreate(req, upload) {
      const who = nodeReq(req)?.auth;
      const ws = who?.workspace ?? currentWorkspace();
      // what the server writes into an upload's metadata is its own: nothing a client sends under those names is kept
      const sent = Object.fromEntries(Object.entries(upload.metadata ?? {}).filter(([k]) => !k.startsWith('vr_')));
      if (upload.size === undefined) throw reject(400, 'the upload size must be known up front');
      const size = upload.size;
      const by = who?.user?.id ?? '';
      // A project file's bytes: its one-time ticket (POST /api/files/uploads) says where they go, and is spent now; the
      // upload then resumes for its day like any other, for the same account in the same workspace.
      const ticket = sent.ticket ? ctx.uploadTickets.get(sent.ticket) : null;
      if (sent.ticket) {
        const t = ticket;
        if (t?.target.kind !== 'file' || t.ws !== ws || (t.target.file.stamp.by_id ?? '') !== by)
          throw reject(404, 'unknown or expired upload ticket: ask for a new one');
        if (t.used || Date.now() > t.expires) throw reject(410, 'this upload ticket was used or has expired; ask for a new one');
        if (size !== t.target.file.size) throw reject(400, `this ticket is for ${t.target.file.size} bytes, not ${size}`);
        try {
          if (t.check) inWorkspace(t.ws, t.check);
        } catch (e) {
          throw reject(403, (e as Error).message);
        }
        t.used = true;
      } else if (size > ctx.cfg.upload_max_bytes) throw reject(413, 'the file is larger than this server accepts');
      const file = ticket?.target.kind === 'file' ? ticket.target.file : null;
      try {
        const meta = file ? null : inWorkspace(ws, () => validate(upload.metadata));
        await oneAtATime(async () => {
          const open = await underWay();
          const mine = by ? open.filter((o) => o.kind === 'tus' && o.by === by).length : 0;
          if (mine >= OPEN_UPLOADS_PER_ACCOUNT)
            throw reject(429, `${mine} of your uploads are under way (the most one account may have): let some finish, or cancel them`);
          if (!fitsBeside(size, { ws, by }, open)) throw reject(507, 'not enough disk space on the server for this upload');
          try {
            // the plan sees the workspace's uploads under way as stored already
            if (meta) await plan(ws, meta, size + declaredIn(open, ws));
            else await ctx.extension.check(ws, 'upload', size + declaredIn(open, ws));
          } catch (e) {
            const { status = 402, details } = e as { status?: number; details?: Record<string, unknown> };
            // A person's browser reads the refusal's reason and numbers (the limit's sheet); an agent and `vr` keep the sentence.
            const said = who?.via !== 'token' && status === 402 && details ? JSON.stringify({ error: (e as Error).message, ...details }) : (e as Error).message;
            throw reject(status, said);
          }
          held.set(upload.id, { id: upload.id, kind: 'tus', ws, by, size, offset: 0, moved: Date.now(), at: Date.now() });
        });
        if (who?.via === 'token')
          uploaders.set(upload.id, { agent: who.name, name: file ? nameOf(file.path) : (meta?.name ?? ''), slug: meta?.slug ?? null, ws });
      } catch (e) {
        if (ticket) ticket.used = false; // nothing was made: the ticket works again while it is valid
        throw e;
      }
      return { metadata: { ...sent, vr_ws: ws, vr_by: by, ...(file ? { vr_file: JSON.stringify(file) } : {}) } };
    },
    // An upload is reached only by whom it belongs to, in its workspace: anyone else (another team's token guessing an
    // id) finds nothing.
    async onIncomingRequest(req, id) {
      if (req.method === 'POST') return;
      let upload: Upload;
      try {
        upload = await datastore.getUpload(id);
      } catch {
        return; // unknown: tus answers 404 itself
      }
      const who = nodeReq(req)?.auth;
      const o = ownerOf(upload);
      if (!who || o.ws !== who.workspace || (o.by && o.by !== (who.user?.id ?? ''))) throw reject(404, 'Upload not found');
      // a project file's: only while its account may still write files there (not after its role was taken away)
      if (upload.metadata?.vr_file && !can(who.role, 'files-write')) throw reject(404, 'Upload not found');
      // The room it was given at its start may have gone since (something else filled the disk, it stood still and others
      // took the room, or it holds more than its share): its rest must still fit beside the others, or nothing more of it
      // is written.
      if (req.method === 'PATCH' && !fitsBeside(Math.max(0, (upload.size ?? 0) - (upload.offset ?? 0)), o, await underWay(), id))
        throw reject(507, 'not enough disk space on the server for the rest of this upload');
    },
    async onUploadFinish(req, upload) {
      const owner = ownerOf(upload);
      const up = uploaders.get(upload.id);
      uploaders.delete(upload.id);
      if (up)
        inWorkspace(up.ws, () =>
          ctx.activity.record({
            at: isoLocal(),
            agent: up.agent,
            slug: up.slug,
            kind: 'upload',
            ...words('Uploaded {name}', { name: excerpt(up.name, 40) }),
            pct: 100,
          }),
        );
      const who = nodeReq(req)?.auth;
      const by = who?.name || ctx.cfg.user;
      remember(upload.id, { status: 'processing' }, owner.ws, owner.by);
      // Registered in the workspace the upload belongs to, whatever the request around it.
      const target = upload.metadata?.vr_file ? (JSON.parse(upload.metadata.vr_file) as FileTarget) : null;
      const job = ctx.inflight
        .track(
          inWorkspace(owner.ws, () =>
            Promise.resolve().then(
              (): Promise<UploadResult | FileUploadResult> =>
                target ? ingestProjectFile(path.join(dir, upload.id), target) : ingest(path.join(dir, upload.id), validate(upload.metadata), by, who?.user?.id),
            ),
          ),
        )
        .then(
          (result) => {
            remember(upload.id, { status: 'done', result }, owner.ws, owner.by);
            return result;
          },
          (e: Error & { body?: string; status?: number; details?: Record<string, unknown> }) => {
            const status = statusOf(e, 422);
            const error = e.body || publicMessage(e, who?.via === 'local' ? 'owner' : 'other', { status, where: 'upload' });
            // 409: a part that can't be one, or a project file changed since its base (with who changed it); ≥ 500: the
            // server's fault (its storage), never "your file"; a project file's other refusals keep their own status
            const code = status === 409 || status >= 500 || target ? status : undefined;
            const details = target && status === 409 && e.details ? e.details : undefined;
            remember(upload.id, { status: 'failed', error, ...(code ? { code } : {}), ...(details ? { details } : {}) }, owner.ws, owner.by);
            throw Object.assign(e, { body: error, answer: details ? { ...details, error } : null });
          },
        );
      let timer: NodeJS.Timeout | undefined;
      const quick = await Promise.race([
        job.then(
          (x) => ({ x }),
          (e: Error & { body?: string; answer?: object | null }) => ({ e }),
        ),
        new Promise<null>((res) => {
          timer = setTimeout(res, ctx.uploadWaitMs, null);
        }),
      ]);
      clearTimeout(timer);
      job.catch(() => {});
      const json = { 'Content-Type': 'application/json' };
      if (!quick) return { status_code: 202, headers: json, body: JSON.stringify({ pending: true, id: upload.id }) };
      // 409: a partial render that can't be one (lib/parts.ts says why: send a full render), or a project file that
      // changed since its base: the body is its FileConflictAnswer. A project file's other refusals keep their status.
      if ('e' in quick) {
        const status = statusOf(quick.e, 422);
        if (target) throw { status_code: status, headers: json, body: JSON.stringify(quick.e.answer ?? { error: quick.e.body || quick.e.message }) };
        throw reject(status === 409 || status >= 500 ? status : 422, quick.e.body || quick.e.message);
      }
      return { status_code: 200, headers: json, body: JSON.stringify(quick.x) };
    },
  });

  // Unfinished uploads older than a day.
  setInterval(() => tus.cleanUpExpiredUploads().catch(() => {}), 3600_000).unref();

  // ---------------------------------------------------------------- tickets

  r.post('/api/uploads/tickets', express.json(), (req, res) => {
    if (!req.auth) throw fail(401, 'please sign in');
    const input = body(TicketInput, req);
    try {
      // Used later, maybe by a shell elsewhere: the one who asked is checked again then (removed, revoked, disabled).
      const guard = teamGuard(issuerOf(req), 'upload');
      res.json(ctx.uploadTickets.issue(input, req.auth.name, ctx.cfg.public_url || `${req.protocol}://${req.get('host')}`, req.auth.user?.id, guard));
    } catch (e) {
      if (e instanceof HttpError) throw e; // the ticket store's own answer (429: too many open)
      throw failFrom(400, e);
    }
  });

  const ticketOf = (raw: string) => {
    const t = ctx.uploadTickets.get(raw);
    if (!t) throw fail(404, 'unknown or expired upload URL');
    return t;
  };
  const answer = (res: Response, o: Outcome) => {
    if (o.status === 'done') return void res.json(o.result);
    if (o.status === 'failed') return void res.status(o.code ?? 422).json({ ...o.details, error: o.error });
    res.status(202).json({ pending: true });
  };

  // A fix preview: attached to its note, the uploaded file removed either way.
  async function preview(file: string, target: PreviewTarget, by: string) {
    try {
      const out = await attachPreview(target.comment, file, { ...target.request, by });
      ctx.broadcast('review', { slug: out.slug });
      return out;
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  // A reference on a note (an image or a clip): attached, the uploaded file removed either way.
  async function reference(file: string, target: RefTarget, by: string) {
    try {
      // A draft's reference: told to its author only (nobody else knows the draft exists).
      if (target.draft) {
        const out = await attachDraftRefFile(target.draft.slug, target.draft.owner, target.comment, file, { ...target.request, by });
        ctx.hub.tell(target.draft.owner, 'drafts', { slug: out.slug });
        return out;
      }
      const out = await attachRefFile(target.comment, file, { ...target.request, by });
      ctx.broadcast('review', { slug: out.slug });
      return out;
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  // The file of an item a question with options offers (lib/askOptions.ts): stored where the question lives.
  async function optionFile(file: string, target: OptionTarget, by: string) {
    try {
      const out = await attachOptionFile(target, file, by);
      if (out.slug) ctx.broadcast('review', { slug: out.slug });
      else ctx.broadcast('asks', {});
      return out;
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  /**
   * A render an agent put up with an upload URL is now the person's to review: its answer (read from curl's output)
   * says to wait for their notes now, with a wait_for_feedback cursor from this moment (lib/handoff.ts). The log is
   * read before the clock, so an event of this second that lands meanwhile is heard.
   */
  const handedOver = (ws: string): { cursor?: string; next?: string } => {
    try {
      const events = inWorkspace(ws, () => store.readEvents({ limit: 200, tailBytes: 256 * 1024 }));
      const cursor = cursorAt(events, Date.now());
      return { cursor, next: waitNowLine(cursor) };
    } catch {
      return {}; // the render is in either way: only the hint is missing
    }
  };

  r.put('/api/uploads/direct/:ticket', async (req, res) => {
    const t = ticketOf(req.params.ticket);
    if (t.used || Date.now() > t.expires) throw fail(410, 'this upload URL was used or has expired; ask for a new one');
    // its workspace deleted or suspended by the server's operator since (A13 CLOUD-5): nothing lands there any more
    if (t.ws !== DEFAULT_WORKSPACE && !workspaces.getWorkspace(t.ws)) throw fail(410, 'this upload URL was used or has expired; ask for a new one');
    if (workspaces.suspensionOf(t.ws)) throw fail(423, SUSPENDED_ERROR, { suspended: true });
    // The URL carries no sign-in, so this request runs in no workspace: the check (a review link still valid) runs in
    // the one the URL was handed out in, like the work below — outside it, a server with two workspaces refuses it.
    if (t.check) inWorkspace(t.ws, t.check);
    const size = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(size) || size <= 0) throw fail(411, 'send the file with its length (curl -T file URL)');
    const max =
      t.target.kind === 'preview'
        ? PREVIEW_LIMITS.uploadBytes
        : t.target.kind === 'ref' || t.target.kind === 'option'
          ? REF_LIMITS.clipBytes
          : t.target.kind === 'file'
            ? FILE_LIMITS.fileBytes
            : ctx.cfg.upload_max_bytes;
    if (size > max) throw fail(413, 'the file is larger than this server accepts');
    if (t.target.kind === 'file' && size !== t.target.file.size) throw fail(400, `this URL is for ${t.target.file.size} bytes, not ${size}`);
    // Taken before the first await (the plan's check may wait on a lookup): a second PUT sent at the same moment finds
    // it used. A refusal gives it back, as a broken stream does below (sweep 2 MH-3).
    t.used = true;
    const id = `direct-${crypto.randomBytes(12).toString('hex')}`;
    const target = t.target;
    try {
      await oneAtATime(async () => {
        // the uploads under way hold their room here too (A13 MEDIA-5)
        const open = await underWay();
        const by = target.kind === 'render' ? (target.byId ?? '') : target.kind === 'file' ? (target.file.stamp.by_id ?? '') : '';
        if (!fitsBeside(size, { ws: t.ws, by }, open)) throw fail(507, 'not enough disk space on the server for this upload');
        // The plan of the workspace the URL was handed out in (a 402 with its sentence).
        const pending = declaredIn(open, t.ws);
        if (target.kind === 'render') await plan(t.ws, target.meta, size + pending);
        else await ctx.extension.check(t.ws, 'upload', size + pending);
        held.set(id, { id, kind: 'direct', ws: t.ws, by, size, offset: 0, moved: Date.now(), at: Date.now() });
      });
    } catch (e) {
      t.used = false;
      throw e;
    }
    const file = path.join(dir, id);
    try {
      await pipeline(req, fs.createWriteStream(file));
      if (fs.statSync(file).size !== size) throw new Error('the upload broke off');
    } catch (e) {
      fs.rmSync(file, { force: true });
      t.used = false; // nothing was registered: the same URL may be tried again while it is valid
      throw failFrom(400, e);
    } finally {
      // its bytes are on the disk now (or gone): the disk's free space says the rest
      held.delete(id);
    }
    t.outcome = { status: 'processing' };
    // A one-time URL works in the workspace it was handed out in.
    const work: Promise<UploadResult | Attached | RefAttached | OptionAttached | FileUploadResult> = inWorkspace(t.ws, () =>
      target.kind === 'preview'
        ? preview(file, target.preview, t.by)
        : target.kind === 'ref'
          ? reference(file, target.ref, t.by)
          : target.kind === 'option'
            ? optionFile(file, target.option, t.by)
            : target.kind === 'file'
              ? ingestProjectFile(file, target.file)
              : ingest(file, target.meta, t.by, target.byId, target.session),
    );
    const job = ctx.inflight.track(work).then(
      (result) => {
        const present = t.present;
        t.outcome = {
          status: 'done',
          result:
            present && target.kind === 'ref'
              ? inWorkspace(t.ws, () => present(result as RefAttached))
              : target.kind === 'render'
                ? { ...(result as UploadResult), ...handedOver(t.ws) }
                : result,
        };
      },
      (e: Error & { status?: number; details?: Record<string, unknown> }) => {
        // Whoever holds a one-time URL (a review-link visitor, an agent elsewhere) is never identified: never the owner.
        const status = statusOf(e, 422);
        // a project file's refusals keep their status, and a conflict its files (FileConflictAnswer)
        const file = target.kind === 'file';
        t.outcome = {
          status: 'failed',
          error: publicMessage(e, 'other', { status, where: 'upload ticket' }),
          ...(status === 409 || status >= 500 || file ? { code: status } : {}),
          ...(file && status === 409 && e.details ? { details: e.details } : {}),
        };
      },
    );
    await Promise.race([job, new Promise((r) => setTimeout(r, ctx.uploadWaitMs).unref())]);
    answer(res, t.outcome);
  });

  r.get('/api/uploads/direct/:ticket', (req, res) => {
    const t = ticketOf(req.params.ticket);
    if (!t.outcome) throw fail(404, 'nothing was uploaded to this URL yet');
    answer(res, t.outcome);
  });

  // tus has written the upload's metadata file: its folder says it is under way from now on
  tus.on('POST_CREATE', (_req: unknown, upload: Upload) => {
    held.delete(upload.id);
  });

  tus.on('POST_RECEIVE', (_req: unknown, upload: Upload) => {
    const up = uploaders.get(upload.id);
    if (!up || !upload.size) return;
    const pct = Math.round(((upload.offset ?? 0) / upload.size) * 100);
    inWorkspace(up.ws, () =>
      ctx.activity.record({
        at: isoLocal(),
        agent: up.agent,
        slug: up.slug,
        kind: 'upload',
        ...words('Uploading {name}', { name: excerpt(up.name, 40) }),
        pct,
      }),
    );
  });

  r.all(['/api/uploads', '/api/uploads/{*rest}'], (req, res) => {
    if (!req.auth) throw fail(401, 'please sign in');
    tus.handle(req, res);
  });

  r.get('/api/upload-results/:id', (req, res) => {
    if (!UPLOAD_ID.test(req.params.id)) throw fail(404, 'unknown upload');
    const o = outcomes.get(req.params.id);
    // Only for whom it belongs to, in its workspace: anyone else finds nothing.
    if (!o || o.ws !== req.auth?.workspace || (o.by && o.by !== (req.auth.user?.id ?? ''))) throw fail(404, 'unknown upload');
    const { at: _at, ws: _ws, by: _by, ...out } = o;
    res.json(out);
  });

  return r;
}
