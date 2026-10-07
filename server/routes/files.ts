// Project files over HTTP (lib/files.ts; docs/files.md, docs/api.md "Project files"): the team's material per House,
// project and folder. Reading is `files`, every change `files-write` (server/permissions.ts); reviewers have neither and
// get 404, review links never reach any of it. Paths inside an area are names (lib/fileText.ts cleanFilePath), never a
// path on this disk; ids are this workspace's or nobody's (another workspace's answers 404 like a made-up one).
// The bytes come in through one-time upload tickets (server/uploadTickets.ts): one PUT, or tus with the ticket in its
// metadata (server/routes/uploads.ts), checked against the plan and the disk before any byte moves. They go out as
// attachments — `application/octet-stream`, `nosniff`, `sandbox` — from the media host by a signed URL that asks again
// who it was handed to (`/media/f/…`), from a bucket's own signed URL once files live in one, or streamed by the app.
// A preview (`inline=1`) is served as what it is only for pictures, video, sound, PDF and plain text; never SVG or HTML.
import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { AGENT_KINDS } from '../../lib/agentKind.ts';
import { scopeOf } from '../../lib/fileAreas.ts';
import {
  type AreaRef,
  areaRefOf,
  blobKey,
  bytesToCount,
  commitFiles,
  DIR_ID,
  dirInfoOf,
  FILE_ID,
  FileConflictError,
  FileError,
  type FileStampIn,
  fileInfo,
  filesSummary,
  filesUsage,
  findFile,
  heldBlob,
  historyOf,
  listFiles,
  makeDir,
  missingBlobs,
  moveDir,
  moveFile,
  namedFolder,
  purgeFiles,
  pushConflicts,
  readAreaRev,
  restoreDir,
  restoreFile,
  touchBlobs,
  trashDir,
  trashedInfo,
  trashFile,
  trashOf,
  versionOf,
} from '../../lib/files.ts';
import { cleanFilePath, FILE_KINDS, FILE_LIMITS, FilePathError, inlineType, nameOf } from '../../lib/fileText.ts';
import { checkNotArchived } from '../../lib/folderIds.ts';
import { folderName as folderInput } from '../../lib/inputs.ts';
import { cleanAgentName } from '../../lib/names.ts';
import { CACHE } from '../../lib/paths.ts';
import { can } from '../../lib/permissions.ts';
import { currentWorkspace, DEFAULT_WORKSPACE, inWorkspace, WORKSPACE_ID } from '../../lib/scope.ts';
import { filesStorage, SIGNED_URL_SECONDS } from '../../lib/storage/index.ts';
import { openMedia, sealMedia } from '../../lib/storage/mediaHost.ts';
import type { AgentKind, FileEntry, FileUploadAnswer, FileUploadSlot, FileUrl, FileUrls, FileVersion, TrashedFile } from '../../lib/types.ts';
import * as workspaces from '../../lib/workspaces.ts';
import type { ServerContext } from '../context.ts';
import { mediaHostOf, requestHost } from '../guard.ts';
import { body, fail, query, router } from '../http.ts';
import { streamFile } from '../playback.ts';
import { freeBytes } from '../ready.ts';
import { issuerOf, issuerStill, type TicketGuard, teamGuard } from '../uploadTickets.ts';

const Sha = z.string().regex(/^[0-9a-f]{64}$/, 'a sha256: 64 lowercase hex');
const PathIn = z.string().min(1).max(4096);
const FolderIn = folderInput.nullish();
const Base = z.number().int().min(0).nullish();
/** Who writes, as a caller may say it: the agent that does it with this account, its kind, the way and machine. */
const Writer = {
  agent: z.string().max(100).optional(),
  agent_kind: z.enum(AGENT_KINDS as [AgentKind, ...AgentKind[]]).optional(),
  via: z.enum(['vr', 'mcp']).optional(),
  machine: z.string().max(100).optional(),
};
const Flag = z.enum(['1', 'true', '0', 'false']).optional();
const on = (f: string | undefined) => f === '1' || f === 'true';

const ListQuery = z.object({
  folder: z.string().max(400).optional(),
  path: z.string().max(4096).optional(),
  deep: Flag,
  own: Flag,
  kind: z.enum(FILE_KINDS as [string, ...string[]]).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(FILE_LIMITS.pageMax).optional(),
  cursor: z
    .string()
    .regex(/^\d{1,7}$/)
    .optional(),
});
const FolderQuery = z.object({ folder: z.string().max(400).optional() });
const UploadsBody = z.object({
  folder: FolderIn,
  files: z
    .array(z.object({ path: PathIn, size: z.number().int().min(0).max(FILE_LIMITS.fileBytes), sha256: Sha.optional(), base: Base }))
    .min(1)
    .max(FILE_LIMITS.batch),
  commit: z.boolean().optional(),
  conflict: z.enum(['refuse', 'copy']).optional(),
  ...Writer,
});
const CommitBody = z.object({
  folder: FolderIn,
  add: z
    .array(z.object({ path: PathIn, sha256: Sha, size: z.number().int().min(0).max(FILE_LIMITS.fileBytes), base: Base }))
    .min(1)
    .max(FILE_LIMITS.batch),
  conflict: z.enum(['refuse', 'copy']).optional(),
  ...Writer,
});
const MissingBody = z.object({ hashes: z.array(Sha).max(FILE_LIMITS.hashes) });
const UrlsBody = z.object({ ids: z.array(z.string().max(40)).min(1).max(FILE_LIMITS.urls), v: z.number().int().min(1).optional() });
const MoveBody = z
  .object({ path: PathIn.optional(), folder: z.string().max(400).nullable().optional(), ...Writer })
  .refine((b) => b.path !== undefined || b.folder !== undefined, 'name a new path, another folder, or both');
const RestoreBody = z.object({ v: z.number().int().min(1).optional(), ...Writer });
const DirBody = z.object({ folder: FolderIn, path: PathIn, ...Writer });
const DownloadQuery = z.strictObject({
  v: z.preprocess((x) => (x === '' ? undefined : x), z.coerce.number().int().positive().optional()),
  inline: Flag,
});
/** A file's or a folder's id as a route takes it: anything else is nobody's (404). */
const ANY_ID = /^f[ld]_[0-9a-f]{12}$/;

/** What a project file's URL on the media host carries (sealed): the workspace, the blob, who asked, how to serve it. */
const FileClaims = z.object({
  w: z.string().regex(WORKSPACE_ID),
  k: Sha,
  i: z.object({
    via: z.enum(['local', 'lan', 'cookie', 'token', 'oauth']),
    user: z.string().max(200),
    ws: z.string().regex(WORKSPACE_ID),
    token: z.string().max(200).optional(),
    session: z.string().max(4096).optional(),
    grant: z.string().max(200).optional(),
    scopes: z.array(z.string().max(200)).max(50).readonly().optional(),
  }),
  /** Inline, as this type (a preview); absent: an attachment. */
  t: z.string().max(100).optional(),
});

/** How long a project file's signed URL lives when handed out for a pull: hours for a person, an hour for a token. */
const URL_SECONDS = { person: 6 * 3600, token: 3600 } as const;

/** A file's or a folder's id from the route, or 404 (another workspace's ids are nobody's here too). */
function idOf(req: Request<{ id: string }>): string {
  const id = req.params.id;
  if (!ANY_ID.test(id)) throw fail(404, 'no such file');
  return id;
}

/** lib/files.ts's refusals as the API answers them: their status, their sentence, a conflict's files. */
function asHttp(e: unknown): unknown {
  if (e instanceof FileError) return Object.assign(fail(e.status, e.message, e.details), { cause: e, retryAfter: (e as { retryAfter?: number }).retryAfter });
  if (e instanceof FilePathError) return Object.assign(fail(400, e.message), { cause: e });
  return e;
}
async function run<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw asHttp(e);
  }
}

/** The headers every project file's bytes go out with: never run, never sniffed, never framed into a page. */
function inert(res: Response, name: string, inline: boolean): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  const safe = name.replace(/[^\x20-\x7e]|"/g, '_');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(name)}`);
}

/** The type a preview is served as (text with its charset), or null: it only ever downloads. */
const shownAs = (type: string): string | null => (inlineType(type) ? (type === 'text/plain' ? 'text/plain; charset=utf-8' : type) : null);

const urlName = (name: string): string => encodeURIComponent(name.replace(/[/\\\0]/g, '_').slice(0, 200) || 'file');

export function fileRoutes(ctx: ServerContext): Router {
  const r = router();
  const mediaOrigin = ctx.hosted ? ctx.cfg.media_origin : null;
  const mediaHost = mediaHostOf(mediaOrigin);
  const appOrigin = ctx.cfg.public_url ? new URL(ctx.cfg.public_url).origin : null;
  const baseOf = (req: Request) => ctx.cfg.public_url || `${req.protocol}://${req.get('host')}`;

  /** Who writes: the account, the agent it says it is (who may hand work to agents only: `actor`'s rule), how. */
  function stampOf(req: Request, b: { agent?: string; agent_kind?: AgentKind; via?: 'vr' | 'mcp'; machine?: string }): FileStampIn {
    const a = req.auth;
    if (!a) throw fail(401, 'please sign in');
    const named = b.agent ? cleanAgentName(b.agent.replace(/^agent:/, '')) : '';
    const agent = named && can(a.role, 'agents') ? named : undefined;
    const via = b.via ?? (a.via === 'token' ? 'vr' : 'browser');
    const kind = b.agent_kind ?? (agent ? (via === 'mcp' ? 'mcp' : a.via === 'token' ? 'cli' : undefined) : undefined);
    const machine = b.machine && a.via !== 'cookie' ? cleanAgentName(b.machine, 60) : '';
    return {
      by: a.name,
      ...(a.user?.id ? { by_id: a.user.id } : {}),
      ...(agent ? { agent } : {}),
      ...(agent && kind ? { agent_kind: kind } : {}),
      via,
      ...(machine ? { machine } : {}),
    };
  }

  /** The area of a folder someone names for a write: there (404 otherwise), not archived (423), made when new. */
  function writeArea(raw: string | null | undefined): AreaRef {
    const folder = namedFolder(raw);
    checkNotArchived(folder);
    return areaRefOf(folder, { create: true }) as AreaRef;
  }

  /** An area's change, heard live by the team's streams (never a reviewer's: they don't see files). */
  const told = (area: string) => ctx.broadcast('files', { area, rev: readAreaRev(area) }, 'files');

  /**
   * Where a version of a file is fetched from, living `seconds`: the bucket's own signed URL (files in a bucket), else
   * the media host's (it asks again who it was handed to), else null (the app streams it, to whoever is signed in).
   */
  function urlFor(req: Request, version: FileVersion, name: string, type: string, seconds: number, inline: boolean): string | null {
    const key = blobKey(version.hash);
    const s = filesStorage();
    if (s.kind !== 'local' && !inline) {
      const u = s.url(key, seconds, name);
      if (u && !(mediaOrigin && u.startsWith(`${mediaOrigin}/`))) return u;
    }
    if (!mediaOrigin) return null;
    const issuer = issuerOf(req);
    if (!issuer) throw fail(401, 'please sign in');
    const as = inline ? shownAs(type) : null;
    const claims = { w: currentWorkspace(), k: version.hash, i: issuer, ...(as ? { t: as } : {}) };
    return `${mediaOrigin}/media/f/${sealMedia({ f: claims, n: name }, seconds)}/${urlName(name)}`;
  }

  /** The bytes of a version, streamed by this app: ranges (a download picks up where it broke off), HEAD reads nothing. */
  async function sendBytes(req: Request, res: Response, hash: string, name: string, as: string | null): Promise<void> {
    const key = blobKey(hash);
    const s = filesStorage();
    const here = s.localPath(key);
    const file = fs.existsSync(here) ? here : await s.ensureLocal(key);
    if (!file) throw fail(410, 'the bytes of this file are gone');
    inert(res, name, !!as);
    streamFile(req, res, file, { cache: 'private, no-cache', whole: true, type: as ?? 'application/octet-stream' });
  }

  // ---------------------------------------------------------------- reading

  r.get('/api/files', (req, res) =>
    run(() => {
      const q = query(ListQuery, req);
      const folder = namedFolder(q.folder);
      res.setHeader('Cache-Control', 'no-store');
      res.json(
        listFiles(folder, {
          ...(q.path !== undefined ? { path: q.path } : {}),
          deep: on(q.deep),
          own: on(q.own),
          ...(q.kind ? { kind: q.kind as FileEntry['kind'] } : {}),
          ...(q.q ? { q: q.q } : {}),
          ...(q.limit ? { limit: q.limit } : {}),
          ...(q.cursor ? { cursor: q.cursor } : {}),
        }),
      );
    }),
  );

  r.get('/api/files/summary', (req, res) =>
    run(() => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(filesSummary(namedFolder(query(FolderQuery, req).folder)));
    }),
  );

  r.get('/api/files/trash', (req, res) =>
    run(() => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(trashOf(namedFolder(query(FolderQuery, req).folder)));
    }),
  );

  r.get('/api/files/usage', (req, res) =>
    run(async () => {
      const plan = await ctx.extension.storageBytes(req.auth?.workspace ?? currentWorkspace());
      res.setHeader('Cache-Control', 'no-store');
      res.json(filesUsage(plan === null ? null : Math.floor(plan * FILE_LIMITS.keptShare)));
    }),
  );

  r.get('/api/files/:id', (req, res) =>
    run(() => {
      const id = idOf(req);
      res.setHeader('Cache-Control', 'no-store');
      if (DIR_ID.test(id)) return void res.json(dirInfoOf(id));
      const found = findFile(id);
      if (!found) throw fail(404, 'no such file');
      const area = scopeOf(found.area);
      res.json(found.trashed ? trashedInfo(found.entry as TrashedFile, area) : fileInfo(found.entry, area));
    }),
  );

  r.get('/api/files/:id/history', (req, res) =>
    run(() => {
      const id = idOf(req);
      if (!FILE_ID.test(id)) throw fail(404, 'no such file');
      res.setHeader('Cache-Control', 'no-store');
      res.json(historyOf(id));
    }),
  );

  // One version's bytes: a redirect to a short-lived signed URL (the media host's, or a bucket's), else streamed here.
  // `inline=1`: a preview, as what it is — only for types a browser shows without running anything (inlineType).
  r.get('/api/files/:id/download', (req, res) =>
    run(async () => {
      const id = idOf(req);
      const q = query(DownloadQuery, req);
      const found = FILE_ID.test(id) ? findFile(id) : null;
      if (!found) throw fail(404, 'no such file');
      const version = versionOf(found.entry, q.v);
      if (!version) throw fail(404, `V${q.v} of this file isn’t kept any more`);
      const blob = heldBlob(version.hash);
      if (!blob) throw fail(410, 'the bytes of this file are gone');
      const name = nameOf(found.entry.path);
      const as = on(q.inline) ? shownAs(blob.type) : null;
      const url = urlFor(req, version, name, blob.type, SIGNED_URL_SECONDS.download, !!as);
      if (url) {
        res.setHeader('Cache-Control', 'no-store');
        return void res.redirect(302, url);
      }
      await sendBytes(req, res, version.hash, name, as);
    }),
  );

  // Signed URLs for one pull step (≤ 100): what an agent fetches with curl, or a render streams with ranges.
  r.post('/api/files/urls', express.json(), (req, res) =>
    run(() => {
      const b = body(UrlsBody, req);
      const seconds = req.auth?.via === 'token' ? URL_SECONDS.token : URL_SECONDS.person;
      const urls: FileUrl[] = [];
      const missing: string[] = [];
      for (const id of [...new Set(b.ids)]) {
        const found = FILE_ID.test(id) ? findFile(id) : null;
        const version = found && !found.trashed ? versionOf(found.entry, b.v) : null;
        const blob = version ? heldBlob(version.hash) : null;
        if (!found || !version || !blob) {
          missing.push(id);
          continue;
        }
        const e = found.entry;
        const url = urlFor(req, version, nameOf(e.path), blob.type, seconds, false) ?? `${baseOf(req)}/api/files/${e.id}/download?v=${version.v}`;
        const expires = new Date(Date.now() + seconds * 1000).toISOString();
        urls.push({ id: e.id, area: scopeOf(found.area), path: e.path, v: version.v, size: version.size, sha256: version.hash, url, expires });
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({ urls, missing } satisfies FileUrls);
    }),
  );

  // ---------------------------------------------------------------- pushing

  // Which of these bytes the workspace lacks: asked by those who may write files, about their own workspace only.
  r.post('/api/files/missing', express.json({ limit: '1mb' }), (req, res) =>
    run(() => {
      res.json({ missing: missingBlobs(body(MissingBody, req).hashes) });
    }),
  );

  // A push: the version check (409 before any byte moves), the disk and the plan for all of it at once (507, 402 with
  // the limit sheet's numbers), then per file nothing to send (its bytes are here: commit it) or a one-time ticket.
  r.post('/api/files/uploads', express.json({ limit: '2mb' }), (req, res) =>
    run(async () => {
      const b = body(UploadsBody, req);
      const items = b.files.map((f, i) => {
        try {
          return { ...f, path: cleanFilePath(f.path) };
        } catch (e) {
          throw fail(400, `files.${i}: ${(e as Error).message}`);
        }
      });
      const seen = new Set<string>();
      for (const it of items) {
        if (seen.has(it.path.toLowerCase())) throw fail(400, `${it.path} is named twice`);
        seen.add(it.path.toLowerCase());
      }
      const area = writeArea(b.folder);
      const conflict = b.conflict ?? 'refuse';
      if (conflict === 'refuse') {
        const conflicts = pushConflicts(area.scope, items);
        if (conflicts.length) throw new FileConflictError(conflicts);
      }
      // bytes the workspace holds already: nothing to send (made fresh, so the purge leaves them while this push commits)
      const held = touchBlobs(items.flatMap((i) => (i.sha256 ? [i.sha256] : [])));
      const stored = (i: (typeof items)[number]) => !!i.sha256 && held.get(i.sha256)?.size === i.size;
      const sending = items.filter((i) => !stored(i));
      const bytes = sending.reduce((n, i) => n + i.size, 0);
      const free = freeBytes(path.join(CACHE, 'uploads'));
      if (bytes && free !== null && bytes > free - (ctx.cfg.min_free_bytes ?? 0)) throw fail(507, 'not enough disk space on the server for these files');
      const counted = bytes + bytesToCount(items.filter(stored).map((i) => ({ sha256: i.sha256 as string, size: i.size })));
      if (counted) await ctx.extension.check(req.auth?.workspace ?? currentWorkspace(), 'upload', counted);
      const stamp = stampOf(req, b);
      const issuer = issuerOf(req);
      const team = teamGuard(issuer, 'files-write');
      // a ticket per file of a push: more open at once than other upload URLs, still bounded per account and workspace
      const guard: TicketGuard = {
        ...team,
        ...(issuer ? { owner: `files:user:${issuer.user}` } : {}),
        pool: 'files',
        limits: { owner: FILE_LIMITS.batch, pool: FILE_LIMITS.batch * 5 },
      };
      const uploads: FileUploadSlot[] = [];
      try {
        for (const it of items) {
          if (stored(it)) {
            uploads.push({ path: it.path, stored: true });
            continue;
          }
          const t = ctx.uploadTickets.issueFile(
            {
              area: area.id,
              folder: area.scope,
              path: it.path,
              size: it.size,
              ...(it.sha256 ? { sha256: it.sha256 } : {}),
              base: it.base ?? null,
              commit: b.commit ?? true,
              conflict,
              stamp,
            },
            stamp.by,
            baseOf(req),
            guard,
          );
          uploads.push({ path: it.path, url: t.url, ticket: t.ticket, expires: t.expires });
        }
      } catch (e) {
        for (const u of uploads) if (u.url) ctx.uploadTickets.drop(u.url);
        throw e;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({ folder: area.scope, uploads, tus: `${baseOf(req)}/api/uploads` } satisfies FileUploadAnswer);
    }),
  );

  // Files whose bytes the workspace holds, as one change: the version check again (409), the plan for what starts counting.
  r.post('/api/files/commit', express.json({ limit: '2mb' }), (req, res) =>
    run(async () => {
      const b = body(CommitBody, req);
      const area = writeArea(b.folder);
      const counted = bytesToCount(b.add);
      if (counted) await ctx.extension.check(req.auth?.workspace ?? currentWorkspace(), 'upload', counted);
      const out = commitFiles(area.id, b.add, { conflict: b.conflict ?? 'refuse', stamp: stampOf(req, b) });
      told(out.folder);
      res.json(out);
    }),
  );

  // An empty folder inside an area ("New folder"): an entry of its own, kept while it is empty.
  r.post('/api/files/dirs', express.json(), (req, res) =>
    run(() => {
      const b = body(DirBody, req);
      const area = writeArea(b.folder);
      const out = makeDir(area.id, b.path, stampOf(req, b));
      told(area.scope);
      res.json(out);
    }),
  );

  // ---------------------------------------------------------------- changing

  r.patch('/api/files/:id', express.json(), (req, res) =>
    run(() => {
      const id = idOf(req);
      const b = body(MoveBody, req);
      const to = { ...(b.path !== undefined ? { path: b.path } : {}), ...(b.folder !== undefined ? { area: writeArea(b.folder) } : {}) };
      const stamp = stampOf(req, b);
      const before = DIR_ID.test(id) ? null : findFile(id);
      const out = DIR_ID.test(id) ? moveDir(id, to, stamp) : moveFile(id, to, stamp);
      if (before) told(scopeOf(before.area));
      told(out.area ?? '');
      res.json(out);
    }),
  );

  r.delete('/api/files/:id', (req, res) =>
    run(() => {
      const id = idOf(req);
      const stamp = stampOf(req, {});
      const mayAny = can(req.auth?.role, 'remove');
      const out = DIR_ID.test(id) ? trashDir(id, stamp, { mayAny }) : trashFile(id, stamp, { mayAny });
      told(out.area);
      res.json(out);
    }),
  );

  r.post('/api/files/:id/restore', express.json(), (req, res) =>
    run(() => {
      const id = idOf(req);
      const b = body(RestoreBody, req);
      const stamp = stampOf(req, b);
      const out = DIR_ID.test(id) ? restoreDir(id, stamp) : restoreFile(id, b.v, stamp).file;
      told(out.area ?? '');
      res.json(out);
    }),
  );

  // ---------------------------------------------------------------- on the media host

  // A project file by its signed URL, in the workspace it names: whoever it was handed to is identified again (a member
  // removed, a token revoked, a session signed out since gets nothing), and the bytes must still be held. Attachments
  // answer CORS for any origin (the URL is the credential and carries no cookie: a render may stream it); a preview
  // only for the app's own pages.
  const corsFor = (res: Response, inline: boolean) => {
    const origin = inline ? appOrigin : '*';
    if (!origin) return;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, Content-Disposition');
    if (inline) res.setHeader('Vary', 'Origin');
  };
  const claimsOf = (sealed: string) => {
    const opened = openMedia<{ f?: unknown; n?: unknown }>(sealed);
    const claims = FileClaims.safeParse(opened?.f).data;
    return claims && typeof opened?.n === 'string' ? { claims, name: opened.n } : null;
  };
  r.options('/media/f/:sealed/:name', (req, res) => {
    if (!mediaHost || requestHost(req) !== mediaHost) throw fail(404, 'not found');
    const got = claimsOf(req.params.sealed);
    if (!got) throw fail(403, 'this file link has expired: ask for it again');
    corsFor(res, !!got.claims.t);
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Max-Age', '600');
    res.status(204).end();
  });
  r.get('/media/f/:sealed/:name', async (req, res) => {
    if (!mediaHost || requestHost(req) !== mediaHost) throw fail(404, 'not found');
    const got = claimsOf(req.params.sealed);
    if (!got) throw fail(403, 'this file link has expired: ask for it again');
    const { claims, name } = got;
    if (claims.w !== DEFAULT_WORKSPACE && !workspaces.getWorkspace(claims.w)) throw fail(410, 'this file is gone');
    await inWorkspace(claims.w, async () => {
      if (claims.i.ws !== claims.w || !issuerStill(claims.i, 'files')) throw fail(403, 'whoever asked for this file may no longer read it: ask for it again');
      if (!heldBlob(claims.k)) throw fail(410, 'this file is gone');
      const as = claims.t && inlineType(claims.t.split(';')[0] as string) ? claims.t : null;
      corsFor(res, !!as);
      await sendBytes(req, res, claims.k, name, as);
    });
  });

  return r;
}

/**
 * The purge for every workspace (lib/files.ts purgeFiles): the safety net after 30 days, or past a quarter of the plan,
 * and bytes nothing names. Each in its own workspace; one that fails is logged and the next goes on.
 */
export async function purgeEveryWorkspace(ctx: ServerContext): Promise<void> {
  let ids: string[];
  try {
    ids = workspaces.workspaceIds();
  } catch (e) {
    console.error(`files: the purge waits for the workspaces (${(e as Error).message})`);
    return;
  }
  for (const ws of ids) {
    try {
      const plan = await ctx.extension.storageBytes(ws);
      const cap = plan === null ? null : Math.floor(plan * FILE_LIMITS.keptShare);
      const out = await inWorkspace(ws, () => purgeFiles({ cap }));
      if (out.trash || out.versions || out.blobs)
        console.log(`files: purged ${out.trash} trashed, ${out.versions} older versions, ${out.blobs} unused blobs in ${ws}`);
    } catch (e) {
      console.error(`files: the purge of ${ws} failed (${(e as Error).message})`);
    }
  }
}
