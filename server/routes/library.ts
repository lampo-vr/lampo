// The library: adding and removing videos, the folder browser for "Add video", projects & folders.
import fs from 'node:fs';
import path from 'node:path';
import express, { type Router } from 'express';
import { z } from 'zod';
import { AGENT_KINDS } from '../../lib/agentKind.ts';
import { archivedNow, checkNotArchived } from '../../lib/folderIds.ts';
import {
  allFolders,
  archiveProject,
  createFolder,
  deleteFolder,
  folderName,
  moveVideo,
  normFolder,
  renameFolder,
  restoreProject,
  shownFolders,
  suggestFolder,
} from '../../lib/folders.ts';
import { DEV, HOME, ROOT, reviewFile, slugify, untildify, VIDEO_EXT } from '../../lib/paths.ts';
import { can } from '../../lib/permissions.ts';
import { search } from '../../lib/search.ts';
import { revokeVideoLinks } from '../../lib/shares.ts';
import * as store from '../../lib/store.ts';
import type { AgentKind, ArchivedProject, BrowseEntry, BrowseResponse, LibraryResponse, SearchResponse } from '../../lib/types.ts';
import type { ServerContext } from '../context.ts';
import { countStep } from '../funnel.ts';
import { accountOf, agentView, getReview, isOwn, summary } from '../helpers.ts';
import { body, fail, query, router } from '../http.ts';

const ALL_EXT = [...VIDEO_EXT, '.webm', '.mkv'];

export const sessionInput = z.object({
  name: z.string().min(1),
  sessionId: z.string().nullish(),
  id: z.string().nullish(),
  cwd: z.string().nullish(),
  agent: z.enum(AGENT_KINDS as [AgentKind, ...AgentKind[]]).nullish(),
});

// A folder path as it comes in: no longer than a folder may be (lib/store.ts FOLDER_LIMITS; normFolder holds the depth).
const folderPath = z.string().max(store.FOLDER_LIMITS.length);

const AddVideo = z.object({
  path: z.string().optional(),
  session: sessionInput.nullish(),
  folder: folderPath.nullish(),
});

const FolderPath = z.object({ path: folderPath });

/** The archived projects as callers see them: when, and by whom (a name; never the account). */
export function archivedList(all: Readonly<Record<string, ArchivedProject>> = archivedNow()): LibraryResponse['archived_projects'] {
  const list = Object.entries(all);
  return list.length ? Object.fromEntries(list.map(([name, a]) => [name, { at: a.at, ...(a.by ? { by: a.by } : {}) }])) : undefined;
}
const FolderRename = z.object({ from: folderPath, to: folderPath });
const FolderQuery = z.object({ path: folderPath.optional() });
const MoveVideo = z.object({ folder: folderPath.nullish() });
const BrowseQuery = z.object({ dir: z.string().optional() });
const SuggestQuery = z.object({ video: z.string().optional() });
// Only these videos (the UI patches its cached list with them after an event names a video); a slug that isn't in the
// library any more is simply missing from the answer.
const LibraryQuery = z.object({ slug: z.union([z.string().max(1024), z.array(z.string().max(1024)).max(200)]).optional() });
const SearchQuery = z.object({ q: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(20).optional() });

// "file:///…", quoted, URL-encoded or ~/… paths pasted from Finder or a terminal.
function cleanPath(raw: string | undefined): string {
  const p = String(raw || '')
    .trim()
    .replace(/^file:\/\//, '');
  let decoded: string;
  try {
    decoded = decodeURIComponent(p);
  } catch {
    throw fail(400, 'that path is not valid');
  }
  return untildify(decoded.replace(/^["']|["']$/g, ''));
}

export function libraryRoutes(ctx: ServerContext): Router {
  const r = router();
  const { broadcast } = ctx;
  // Linking a file and browsing folders read this machine's disk: only on the person's own machine, and only from the
  // machine itself — an invited teammate or a phone never names a path on it.
  const localOnly = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (!ctx.capabilities.linkFiles) throw fail(403, 'not available on a hosted server: upload the video instead');
    if (req.auth?.via !== 'local') throw fail(403, 'files on this machine are linked from the machine itself: upload the video instead');
    next();
  };

  r.get('/api/library', async (req, res) => {
    const only = query(LibraryQuery, req).slug;
    const wanted = only === undefined ? null : new Set(Array.isArray(only) ? only : [only]);
    const sessions = await ctx.sessions.get();
    const reviews = store.listReviews();
    const listed = wanted ? reviews.filter((rv) => wanted.has(slugify(rv.video))) : reviews;
    const shown = shownFolders(reviews);
    const archived = archivedNow();
    const projects = archivedList(archived);
    const out: LibraryResponse = {
      videos: listed.map((rv) => agentView.summary(req, summary(rv, sessions, archived))),
      folders: shown.folders,
      ...(projects ? { archived_projects: projects } : {}),
      ...(shown.degraded ? { degraded: ['folders' as const] } : {}),
    };
    res.json(out);
  });

  // The ⌘K palette: videos, folders and notes matching every word (lib/search.ts). Whoever may view the library.
  r.get('/api/search', (req, res) => {
    const q = query(SearchQuery, req);
    const out: SearchResponse = search(q.q || '', { limit: q.limit });
    res.setHeader('Cache-Control', 'no-store');
    res.json(out);
  });

  r.post('/api/library', localOnly, express.json(), async (req, res) => {
    const b = body(AddVideo, req);
    const p = cleanPath(b.path);
    if (!path.isAbsolute(p)) throw fail(400, 'please give an absolute path');
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw fail(404, `file not found: ${p}`);
    if (!ALL_EXT.includes(path.extname(p).toLowerCase())) throw fail(400, `not a video file (${ALL_EXT.join(', ')})`);
    if (p.startsWith(`${ROOT}/`)) throw fail(400, 'that file lives inside video-review itself');
    // A folder that can't be made, or one in an archived project, is refused before the video is added, not after.
    if (b.folder) checkNotArchived(normFolder(b.folder));
    const who = ctx.actor(req);
    const { review, created } = store.createOrGetReview(p, { by: who, byId: accountOf(req, who), session: b.session });
    if (created && !review.onboarding_sample) countStep(ctx, 'video_first');
    if (review.archived) store.unarchive(slugify(p));
    if (b.folder !== undefined) moveVideo(slugify(p), b.folder, who);
    ctx.watchers.refresh();
    ctx.background.warm(review);
    broadcast('library', { slug: slugify(p) });
    res.json({ created, video: summary(getReview(slugify(p)), await ctx.sessions.get()) });
  });

  // Admins, or whoever added the video.
  r.delete('/api/library/:slug', (req, res) => {
    const review = getReview(req.params.slug);
    if (!can(req.auth?.role, 'remove') && !isOwn(req, review.added_by, review.added_by_id)) throw fail(403, 'only admins or the uploader can remove a video');
    const removed = store.removeVideo(req.params.slug, ctx.actor(req));
    // Deleted (it had no notes; with notes it is archived and can come back): its review links end with it, so one
    // can't show a video added later under the same name.
    if (removed && !removed.comments.length) revokeVideoLinks(removed);
    ctx.watchers.refresh();
    broadcast('library', { slug: req.params.slug });
    res.json({ ok: !!removed, archived: !!removed?.comments.length });
  });

  // Undo for an archive (the library's toast): the review is back in the library. Same rights as archiving it.
  r.post('/api/library/:slug/restore', async (req, res) => {
    const review = getReview(req.params.slug);
    if (!can(req.auth?.role, 'remove') && !isOwn(req, review.added_by, review.added_by_id)) throw fail(403, 'only admins or the uploader can restore a video');
    if (review.archived) store.unarchive(req.params.slug);
    ctx.watchers.refresh();
    broadcast('library', { slug: req.params.slug });
    res.json({ ok: true, video: summary(getReview(req.params.slug), await ctx.sessions.get()) });
  });

  // Plain folder browser for "Add video" (lists folders and video files only; nothing is scanned in the background).
  r.get('/api/browse', localOnly, (req, res) => {
    const dir = path.resolve(untildify(query(BrowseQuery, req).dir || DEV));
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      throw fail(404, `cannot open ${dir}`);
    }
    const out: BrowseEntry[] = [];
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          isDir = fs.statSync(full).isDirectory();
        } catch {
          continue;
        }
      }
      if (isDir) out.push({ name: e.name, path: full, type: 'dir' });
      else if (ALL_EXT.includes(path.extname(e.name).toLowerCase())) {
        let st: fs.Stats | null = null;
        try {
          st = fs.statSync(full);
        } catch {}
        out.push({
          name: e.name,
          path: full,
          type: 'video',
          size: st?.size,
          mtime: st?.mtime.toISOString(),
          reviewed: fs.existsSync(reviewFile(slugify(full))),
        });
      }
    }
    const time = (x: BrowseEntry) => (x.mtime ? new Date(x.mtime).getTime() : 0);
    out.sort((a, b) => (a.type === b.type ? (a.type === 'video' ? time(b) - time(a) : a.name.localeCompare(b.name)) : a.type === 'dir' ? -1 : 1));
    const response: BrowseResponse = { dir, parent: dir === '/' ? null : path.dirname(dir), home: HOME, dev: DEV, entries: out };
    res.json(response);
  });

  // ---------------------------------------------------------------- folders

  r.get('/api/folders', (req, res) => {
    const { video } = query(SuggestQuery, req);
    // Suggestions come from where a linked file sits on disk; uploads (and hosted servers) have no such thing.
    const suggest = video && ctx.capabilities.linkFiles && !video.startsWith('/@uploads/');
    const shown = shownFolders();
    const projects = archivedList();
    res.json({
      folders: shown.folders,
      ...(projects ? { archived_projects: projects } : {}),
      ...(shown.degraded ? { degraded: ['folders'] } : {}),
      ...(suggest ? { suggestion: suggestFolder(video) } : {}),
    });
  });

  // One video moved: its library entry (the answer carries the folder list too); otherwise the whole library.
  const foldersChanged = (res: express.Response, extra: object = {}, slug?: string) => {
    broadcast('library', slug ? { slug } : {});
    const projects = archivedList();
    res.json({ folders: allFolders(), ...(projects ? { archived_projects: projects } : {}), ...extra });
  };

  // Archiving a project and restoring it (lib/archived.ts): every open player of a video in it reads its state again
  // (one `review` for all: it happens once in a while, never per request), and the library its folders.
  const archiveChanged = (res: express.Response, extra: object) => {
    broadcast('review', {});
    foldersChanged(res, extra);
  };
  r.post('/api/folders/archive', express.json(), (req, res) => {
    const who = ctx.actor(req);
    const done = archiveProject(body(FolderPath, req).path, { name: who, id: accountOf(req, who) });
    archiveChanged(res, { project: done.project, archived: { at: done.archived.at, ...(done.archived.by ? { by: done.archived.by } : {}) } });
  });
  r.post('/api/folders/restore', express.json(), (req, res) => {
    const done = restoreProject(body(FolderPath, req).path);
    archiveChanged(res, { project: done.project, restored: done.restored });
  });

  r.post('/api/folders', express.json(), (req, res) => foldersChanged(res, { folder: createFolder(body(FolderPath, req).path) }));

  r.patch('/api/folders', express.json(), (req, res) => {
    const { from, to } = body(FolderRename, req);
    foldersChanged(res, { folder: renameFolder(from, to, ctx.actor(req)) });
  });

  r.delete('/api/folders', (req, res) => {
    // Which folder: a missing or empty name is the caller's mistake (400), not the server's. One from before the limits
    // on folders made now is deleted like any other.
    const p = folderName(query(FolderQuery, req).path || '');
    if (!p) throw fail(400, 'which folder? (?path=)');
    foldersChanged(res, { parent: deleteFolder(p, ctx.actor(req)) });
  });

  // One click for "Unsorted": file each unsorted video where suggestFolder() says it belongs (files on disk only).
  r.post('/api/folders/auto', (req, res) => {
    let moved = 0;
    const archived = archivedNow();
    for (const rv of store.listReviews()) {
      if (rv.folder || rv.archived || store.isUpload(rv)) continue;
      const s = suggestFolder(rv.video);
      // never into an archived project: such a video stays where it is
      if (!s.folder || Object.hasOwn(archived, s.folder.split('/')[0] as string)) continue;
      moveVideo(slugify(rv.video), s.folder, ctx.actor(req));
      moved++;
    }
    foldersChanged(res, { moved });
  });

  r.put('/api/review/:slug/folder', express.json(), (req, res) => {
    getReview(req.params.slug);
    // out of an archived project: its owners' and admins' (the role in this workspace), never into one
    const moved = moveVideo(req.params.slug, body(MoveVideo, req).folder ?? null, ctx.actor(req), { out: can(req.auth?.role, 'archive') });
    broadcast('review', { slug: req.params.slug });
    foldersChanged(res, { folder: moved.folder }, req.params.slug);
  });

  return r;
}
