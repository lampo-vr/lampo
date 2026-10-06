// Folders by id, for review links (lib/shares.ts). A link on a folder covers that folder wherever it moves, and ends
// with it: a folder deleted and made again under the same name is another folder, and the old link must not show it.
// The ids live in folders.json beside the names (FoldersFile.ids, only for folders a link was made on); lib/folders.ts
// writes them — made for a new link, carried through renames and moves, dropped with their folder. They are read here
// because lib/folders.ts imports lib/shares.ts, which can't import it back.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths.ts';
import type { FoldersFile } from './types.ts';

export const foldersFile = (): string => path.join(dataDir(), 'folders.json');

export const newFolderId = (): string => `f_${crypto.randomBytes(6).toString('hex')}`;

/**
 * folders.json is there but can't be read or parsed (a busy disk, a permission after a restore, a damaged file). Nothing
 * is taken from it then: a folder change refuses (lib/folders.ts), and a folder link can't be checked, so its visitor is
 * told to come back rather than that the link is gone. Display reads fall back to the videos' own folders
 * (shownFolders); `vr admin repair-folders` rebuilds a damaged file.
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
  return f;
}

// Asked on every request through a folder link: parsed again only when the file changed (by path: one per workspace).
// A failure is never kept: the next request reads again.
const read = new Map<string, { key: string; ids: Record<string, string> }>();

/** The ids of the folders review links are on, by folder path; none without a file. Throws FoldersUnreadableError. */
export function folderIds(): Record<string, string> {
  const file = foldersFile();
  let key: string;
  try {
    const st = fs.statSync(file);
    key = `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new FoldersUnreadableError(`${file} can't be read (${(e as NodeJS.ErrnoException).code})`, { cause: e });
  }
  const hit = read.get(file);
  if (hit?.key === key) return hit.ids;
  const text = readFoldersText(file);
  const ids = text === null ? {} : parseFolders(text, file).ids || {};
  read.set(file, { key, ids });
  return ids;
}

export const folderIdOf = (folder: string): string | null => folderIds()[folder] ?? null;
