// Project files on the server (lib/types.ts "project files", server/routes/files.ts): an area's summary (its numbers and
// what it inherits), a page of its files at a path, its trash, a file's history; the writes, each answered with the
// file as it now stands. The event stream says `files {area, rev}`: only the queries of that area and the folders
// inside it (which inherit it) ask again, and none whose answer is that revision already (this tab's own write).
import { type InfiniteData, type QueryClient, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { FILE_LIMITS } from '../../../lib/fileText.ts';
import type { FileDirInfo, FileHistory, FileKind, FilesListing, FilesSummary, FilesTrash, TrashedFileInfo } from '../../../lib/types.ts';
import { ApiError, api, enc } from '../api/client.ts';
import type { FileRow, TrashRow } from './model.ts';

export interface ListArgs {
  path: string;
  /** Words to look for, in every folder of the area. */
  q: string;
  kind: FileKind | '';
}

export const fileKeys = {
  all: ['files'] as const,
  area: (area: string) => ['files', area] as const,
  summary: (area: string) => ['files', area, 'summary'] as const,
  list: (area: string, l: ListArgs) => ['files', area, 'list', l.path, l.q, l.kind] as const,
  trash: (area: string) => ['files', area, 'trash'] as const,
  history: (id: string) => ['file-history', id] as const,
};

export type Listing = Omit<FilesListing, 'files'> & { files: FileRow[] };

/** The area in numbers and the chain above it, deepest first, with their top-level entries. */
export const useFilesSummary = (area: string, enabled = true) =>
  useQuery({ queryKey: fileKeys.summary(area), queryFn: () => api<FilesSummary>(`/api/files/summary?folder=${enc(area)}`), enabled });

/** The area's own files at `path` (with `q` or `kind`: every file under it that matches), a page at a time. */
export function useFilesList(area: string, l: ListArgs, enabled = true) {
  return useInfiniteQuery({
    queryKey: fileKeys.list(area, l),
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ folder: area, own: '1', path: l.path, limit: String(FILE_LIMITS.page) });
      if (l.q || l.kind) q.set('deep', '1');
      if (l.q) q.set('q', l.q);
      if (l.kind) q.set('kind', l.kind);
      if (pageParam) q.set('cursor', pageParam);
      return api<Listing>(`/api/files?${q}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.cursor || undefined,
    enabled,
  });
}

/** Every file of the area under `path` (paged through): what an upload replaces. At most `cap` files. */
export async function filesUnder(area: string, path: string, cap = 20_000): Promise<FileRow[]> {
  const out: FileRow[] = [];
  let cursor = '';
  do {
    const q = new URLSearchParams({ folder: area, own: '1', path, deep: '1', limit: String(FILE_LIMITS.pageMax) });
    if (cursor) q.set('cursor', cursor);
    const page = await api<Listing>(`/api/files?${q}`);
    out.push(...page.files);
    cursor = page.cursor ?? '';
  } while (cursor && out.length < cap);
  return out;
}

export const useFilesTrash = (area: string, enabled = true) =>
  useQuery({
    queryKey: fileKeys.trash(area),
    queryFn: () => api<Omit<FilesTrash, 'files'> & { files: TrashRow[] }>(`/api/files/trash?folder=${enc(area)}`),
    enabled,
  });

export const useFileHistory = (id: string | null) =>
  useQuery({
    queryKey: fileKeys.history(id ?? ''),
    queryFn: () => api<FileHistory>(`/api/files/${enc(id ?? '')}/history`),
    enabled: !!id,
    // a file that isn't here stays not here: said at once, not after a retry
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 1,
  });

// ---------------------------------------------------------------- where bytes come from

/** A version's bytes as a download (the server answers with a short-lived link to them, as an attachment). */
export const downloadUrl = (id: string, v?: number) => `/api/files/${enc(id)}/download${v ? `?v=${v}` : ''}`;
/** The same bytes for the browser to show (images, video, audio, PDF and plain text only; anything else stays a
 * download). */
export const inlineUrl = (id: string, v: number) => `/api/files/${enc(id)}/download?v=${v}&inline=1`;

/** Starts a download of one version, as a click on a link would. */
export function download(id: string, v?: number) {
  const a = document.createElement('a');
  a.href = downloadUrl(id, v);
  a.download = '';
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
}

// ---------------------------------------------------------------- writes

// A file's id (fl_…) or a folder's (fd_…: everything under it goes with it) — the same routes.
/** A new path, another area (`folder`), or both. */
export const moveFile = (id: string, to: { path?: string; folder?: string | null }) =>
  api<FileRow | FileDirInfo>(`/api/files/${enc(id)}`, { method: 'PATCH', body: to });
export const trashFile = (id: string) => api<TrashedFileInfo>(`/api/files/${enc(id)}`, { method: 'DELETE', keepalive: true });
/** Out of the trash ({}: at its path, or beside it as "name (restored)" when that is taken), or an older version back
 * as the newest ({v}). */
export const restoreFile = (id: string, v?: number) => api<FileRow>(`/api/files/${enc(id)}/restore`, { method: 'POST', body: v ? { v } : {} });

/** An empty folder in an area: an entry of its own, kept while it is empty (one that is there answers as it is). */
export const createFolder = (area: string, path: string) => api<FileDirInfo>('/api/files/dirs', { method: 'POST', body: { folder: area, path } });

// ---------------------------------------------------------------- the cache

/** Every cached page of the area's lists, changed by `fn` (a rename or a move shown before the server answers). */
export function patchLists(qc: QueryClient, area: string, fn: (files: FileRow[]) => FileRow[]) {
  qc.setQueriesData<InfiniteData<Listing>>({ queryKey: [...fileKeys.area(area), 'list'] }, (d) =>
    d ? { ...d, pages: d.pages.map((p) => ({ ...p, files: fn(p.files) })) } : d,
  );
}

/** The area's answers are old: they ask again (and, through the stream, every tab's). */
export const refreshArea = (qc: QueryClient, area: string) => qc.invalidateQueries({ queryKey: fileKeys.area(area) });

/**
 * The stream said an area changed: the queries of that area and of every folder inside it (they inherit it) ask again,
 * unless their summary has that revision already (this tab's own write came back).
 */
export function heardFiles(qc: QueryClient, area: string, rev: number) {
  const inside = (a: string) => area === '' || a === area || a.startsWith(`${area}/`);
  const current = (a: string) => (qc.getQueryData<FilesSummary>(fileKeys.summary(a))?.areas.find((x) => x.area === area)?.rev ?? -1) >= rev;
  void qc.invalidateQueries({
    predicate: (q) => q.queryKey[0] === 'files' && typeof q.queryKey[1] === 'string' && inside(q.queryKey[1]) && !current(q.queryKey[1]),
  });
  void qc.invalidateQueries({ queryKey: ['file-history'] });
}
