// Folders by id, for review links (lib/shares.ts). A link on a folder covers that folder wherever it moves, and ends
// with it: a folder deleted and made again under the same name is another folder, and the old link must not show it.
// The ids live in folders.json beside the names (FoldersFile.ids, only for folders a link was made on); lib/folders.ts
// writes them — made for a new link, carried through renames and moves, dropped with their folder. They are read here
// because lib/folders.ts imports lib/shares.ts, which can't import it back. So are the archived projects
// (FoldersFile.archived, lib/archived.ts): lib/store.ts and lib/shares.ts ask them before a write.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { archivedIn, ProjectArchivedError } from './archived.ts';
import { wellFormed } from './names.ts';
import { dataDir } from './paths.ts';
import type { ArchivedProject, FoldersFile, Review } from './types.ts';

export const foldersFile = (): string => path.join(dataDir(), 'folders.json');

export const newFolderId = (): string => `f_${crypto.randomBytes(6).toString('hex')}`;

/**
 * folders.json is there but can't be read or parsed (a busy disk, a permission after a restore, a damaged file). Nothing
 * is taken from it then: a folder change refuses (lib/folders.ts), and a folder link can't be checked, so its visitor is
 * told to come back rather than that the link is gone. Display reads fall back to the videos' own folders
 * (shownFolders); `lampo admin repair-folders` rebuilds a damaged file.
 */
export class FoldersUnreadableError extends Error {
  status = 503;
  /** What anyone but the machine's owner is told (lib/publicError.ts): the server's state, no path, no ref. */
  publicText = 'that isn’t available right now: try again later';
}

/** folders.json's text, or null when there is none; FoldersUnreadableError when it can't be read. */
export function readFoldersText(file = foldersFile()): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new FoldersUnreadableError(`${file} can't be read (${(e as NodeJS.ErrnoException).code || (e as Error).message})`, { cause: e });
  }
}

/** folders.json parsed, or FoldersUnreadableError for a file that isn't one (damaged: cut short, not JSON, no list). */
export function parseFolders(text: string, file = foldersFile()): Partial<FoldersFile> {
  let f: Partial<FoldersFile> | null;
  try {
    f = JSON.parse(text) as Partial<FoldersFile> | null;
  } catch (e) {
    throw new FoldersUnreadableError(`${file} is damaged (${(e as Error).message})`, { cause: e });
  }
  if (!f || typeof f !== 'object' || (f.folders !== undefined && !Array.isArray(f.folders)))
    throw new FoldersUnreadableError(`${file} is damaged (no list of folders in it)`);
  // a folder an older version kept with a lone surrogate reads well-formed, as its videos' (lib/store.ts shownNames)
  return wellFormed(f);
}

/**
 * A record keyed by folder names, without a prototype: a name is whatever a person typed, `constructor`, `toString` and
 * `__proto__` included, and on a plain object those read as something every object has, or set its prototype instead
 * of a key. Every name-keyed record of folders.json is one (lib/folders.ts too).
 */
export function folderRecord<T>(entries: Iterable<readonly [string, T]> = []): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  for (const [name, v] of entries) out[name] = v;
  return out;
}

/**
 * The archived projects a file holds, as far as they are well formed: a name without "/" (a project), with when. A
 * file edited by hand never makes a folder inside a project count as one, nor anything else.
 */
export function cleanArchived(raw: unknown): Record<string, ArchivedProject> {
  const out = folderRecord<ArchivedProject>();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    const x = v as Partial<ArchivedProject> | null;
    if (!name || name.includes('/') || !x || typeof x !== 'object' || typeof x.at !== 'string') continue;
    out[name] = { at: x.at, ...(typeof x.by === 'string' ? { by: x.by } : {}), ...(typeof x.by_id === 'string' ? { by_id: x.by_id } : {}) };
  }
  // the project's name and who archived it well-formed, as every folder's (parseFolders), also from a damaged file
  return wellFormed(out);
}

// Asked on every request through a folder link and before every write into a project: parsed again only when the file
// changed (by path: one per workspace). A failure is never kept: the next request reads again.
const read = new Map<string, { key: string; ids: Record<string, string>; archived: Record<string, ArchivedProject> }>();
const NONE = { ids: folderRecord<string>(), archived: folderRecord<ArchivedProject>() } as const;

function current(): { ids: Record<string, string>; archived: Record<string, ArchivedProject> } {
  const file = foldersFile();
  let key: string;
  try {
    const st = fs.statSync(file);
    key = `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return NONE;
    throw new FoldersUnreadableError(`${file} can't be read (${(e as NodeJS.ErrnoException).code})`, { cause: e });
  }
  const hit = read.get(file);
  if (hit?.key === key) return hit;
  const text = readFoldersText(file);
  const f = text === null ? {} : parseFolders(text, file);
  const got = { key, ids: folderRecord(Object.entries(f.ids ?? {})), archived: cleanArchived(f.archived) };
  read.set(file, got);
  return got;
}

/** The ids of the folders review links are on, by folder path; none without a file. Throws FoldersUnreadableError. */
export const folderIds = (): Record<string, string> => current().ids;

export const folderIdOf = (folder: string): string | null => {
  const ids = folderIds();
  return Object.hasOwn(ids, folder) ? (ids[folder] as string) : null;
};

/** The archived projects by name (never change what it returns); none without a file. Throws FoldersUnreadableError. */
export const archivedProjects = (): Readonly<Record<string, ArchivedProject>> => current().archived;

/**
 * The archived projects as a check or a list reads them: while folders.json can't be read, none — a damaged file costs
 * the archive's lock for a moment, never every note and upload of the workspace (folder changes still refuse:
 * lib/folders.ts, and `lampo admin repair-folders` keeps what it still says).
 */
export function archivedNow(): Readonly<Record<string, ArchivedProject>> {
  try {
    return archivedProjects();
  } catch (e) {
    if (e instanceof FoldersUnreadableError) return NONE.archived;
    throw e;
  }
}

/** The archived project a folder is in, or null. */
export const archivedProjectOf = (folder: string | null | undefined): string | null => archivedIn(folder, archivedNow());

/** Throws ProjectArchivedError (423) when the folder is in an archived project: nothing new goes in there. */
export function checkNotArchived(folder: string | null | undefined): void {
  const p = archivedProjectOf(folder);
  if (p) throw new ProjectArchivedError(p);
}

/** The same for a video: nothing new on one whose project is archived. */
export const checkReviewOpen = (review: Pick<Review, 'folder'> | null | undefined): void => checkNotArchived(review?.folder);
