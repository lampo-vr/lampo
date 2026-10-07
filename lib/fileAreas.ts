// Project files' catalogs on the disk (lib/files.ts does everything else with them): where they are, reading and writing
// them, and following folders through renames and deletions (lib/folders.ts calls in, as it does for playbooks and asks).
//   data/files/areas/<area id>.json        one area's catalog (FileArea): its live files, their older versions, its trash
//   data/files/areas/<area id>.log.jsonl   its journal (one FileChange a line, append-only): history and audit
//   data/files/blobs/<ab>.json             which bytes the workspace holds (lib/files.ts)
//   <storage> files/sha256/<ab>/<sha256>   the bytes (lib/storage/index.ts filesStorage(); locally data/files/sha256/…)
// An area is the House (fa_house) or a folder, by the folder's id in folders.json (`ids`): the id follows the folder
// through renames and moves, so the catalog does too — `scope` is only the path it had last, kept in step. Every write
// holds the workspace's files lock (data/files/.lock) and replaces the catalog atomically. A catalog that can't be read
// is never "empty": reading and writing it refuse (503) until it is put right.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { folderIds } from './folderIds.ts';
import { dataDir, isoLocal } from './paths.ts';
import { withLock, writeAtomic } from './store.ts';
import type { FileArea, FileChange, TrashedDir, TrashedFile } from './types.ts';

export const HOUSE_AREA = 'fa_house';
/** An area's id: the House's, or fa_ + the 12 hex of its folder's id. */
export const AREA_ID = /^fa_(house|[0-9a-f]{12})$/;
const FOLDER_ID = /^f_([0-9a-f]{12})$/;

/** The area of a folder by the folder's id (folders.json `ids`); null: the House. */
export function areaIdOf(folderId: string | null): string {
  if (folderId === null) return HOUSE_AREA;
  const m = FOLDER_ID.exec(folderId);
  if (!m) throw new Error(`not a folder id: ${JSON.stringify(folderId).slice(0, 40)}`);
  return `fa_${m[1]}`;
}

export const filesDir = (): string => path.join(dataDir(), 'files');
const areasDir = (): string => path.join(filesDir(), 'areas');
export const areaFile = (id: string): string => path.join(areasDir(), `${id}.json`);
export const journalFile = (id: string): string => path.join(areasDir(), `${id}.log.jsonl`);

/** A catalog is there but can't be read or isn't one: nothing is taken from it, and nothing written over it. */
export class FilesUnreadableError extends Error {
  status = 503;
  /** What anyone but the machine's owner is told (lib/publicError.ts). */
  publicText = 'the files aren’t available right now: try again later';
}

/** Runs `fn` holding the workspace's files lock: every change of a catalog or of the index of stored bytes. */
export const withFilesLock = <T>(fn: () => T): T => withLock(filesDir(), fn);

function parseArea(text: string, file: string): FileArea {
  let a: Partial<FileArea> | null;
  try {
    a = JSON.parse(text) as Partial<FileArea> | null;
  } catch (e) {
    throw new FilesUnreadableError(`${file} is damaged (${(e as Error).message})`, { cause: e });
  }
  if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !AREA_ID.test(a.id) || !Array.isArray(a.files) || !Array.isArray(a.trash))
    throw new FilesUnreadableError(`${file} is damaged (not an area's catalog)`);
  if (typeof a.rev !== 'number') a.rev = 0;
  if (typeof a.scope !== 'string') a.scope = '';
  if (a.folder_id === undefined) a.folder_id = null;
  return a as FileArea;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new FilesUnreadableError(`${file} can't be read (${(e as NodeJS.ErrnoException).code || (e as Error).message})`, { cause: e });
  }
}

// Parsed catalogs, by file (one per workspace and area), again only when the file changed. What it returns is shared:
// never change it (writers read their own copy, `areaForWrite`). Bounded: the least recently read go first.
const parsed = new Map<string, { key: string; area: FileArea }>();
const PARSED_MAX = 256;

/** An area's catalog as stored (never change what it returns), or null when it has none. Throws FilesUnreadableError. */
export function readArea(id: string): FileArea | null {
  const file = areaFile(id);
  let key: string;
  try {
    const st = fs.statSync(file);
    key = `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new FilesUnreadableError(`${file} can't be read (${(e as NodeJS.ErrnoException).code})`, { cause: e });
  }
  const hit = parsed.get(file);
  if (hit?.key === key) {
    parsed.delete(file);
    parsed.set(file, hit);
    return hit.area;
  }
  const text = readText(file);
  if (text === null) return null;
  const area = parseArea(text, file);
  parsed.set(file, { key, area });
  if (parsed.size > PARSED_MAX) parsed.delete(parsed.keys().next().value as string);
  return area;
}

/** An area's catalog to change (its own copy), or null. Call it holding the files lock. */
export function areaForWrite(id: string): FileArea | null {
  const text = readText(areaFile(id));
  return text === null ? null : parseArea(text, areaFile(id));
}

/** The ids of every area the workspace has a catalog for. */
export function areaIds(): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(areasDir());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new FilesUnreadableError(`${areasDir()} can't be read (${(e as NodeJS.ErrnoException).code})`, { cause: e });
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -5))
    .filter((id) => AREA_ID.test(id))
    .sort();
}

/** Every area's catalog (never change what it returns). */
export const listAreas = (): FileArea[] => areaIds().flatMap((id) => readArea(id) ?? []);

/** Writes an area's catalog (atomically) and appends its changes to its journal. Call it holding the files lock. */
export function saveArea(area: FileArea, changes: FileChange[] = []): void {
  fs.mkdirSync(areasDir(), { recursive: true });
  writeAtomic(areaFile(area.id), JSON.stringify(area));
  if (changes.length) fs.appendFileSync(journalFile(area.id), changes.map((c) => `${JSON.stringify(c)}\n`).join(''));
}

/** A new, empty catalog. */
export const emptyArea = (id: string, folderId: string | null, scope: string): FileArea => ({ id, folder_id: folderId, scope, rev: 0, files: [], trash: [] });

/** The last lines of an area's journal that `keep` takes, newest first, at most `max` (read from its last 8 MB). */
export function journalOf(id: string, keep: (c: FileChange) => boolean, max: number): FileChange[] {
  const file = journalFile(id);
  let text: string;
  try {
    const size = fs.statSync(file).size;
    const from = Math.max(0, size - 8 * 1024 * 1024);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const out: FileChange[] = [];
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < max; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const c = JSON.parse(line) as FileChange;
      if (c && typeof c === 'object' && typeof c.id === 'string' && keep(c)) out.push(c);
    } catch {
      // a line cut short by a crash: the rest of the journal still reads
    }
  }
  return out;
}

// ---------------------------------------------------------------- folders: where an area is now

const pathsById = new WeakMap<object, Map<string, string>>();

/** The path of the folder with id `folderId` now (folders.json `ids`), or null when no folder has it any more. */
export function folderPathOf(folderId: string): string | null {
  const ids = folderIds();
  let byId = pathsById.get(ids);
  if (!byId) {
    byId = new Map(Object.entries(ids).map(([p, id]) => [id, p]));
    pathsById.set(ids, byId);
  }
  return byId.get(folderId) ?? null;
}

/** Where an area is now: '' for the House, its folder's path, or (its folder gone) the path it had last. */
export const scopeOf = (a: Pick<FileArea, 'folder_id' | 'scope'>): string => (a.folder_id === null ? '' : (folderPathOf(a.folder_id) ?? a.scope));

const inside = (f: string, root: string) => f === root || f.startsWith(`${root}/`);

/**
 * A folder was renamed or moved (lib/folders.ts, after folders.json has its new name): the areas of it and of the
 * folders inside it are where their ids are now; their catalogs say so too (`scope`). Nothing else changes.
 */
export function followFolders(root: string): void {
  const moved = listAreas().filter((a) => a.folder_id !== null && inside(a.scope, root) && scopeOf(a) !== a.scope);
  if (!moved.length) return;
  withFilesLock(() => {
    for (const { id } of moved) {
      const a = areaForWrite(id);
      if (!a) continue;
      const now = scopeOf(a);
      if (now === a.scope) continue;
      a.scope = now;
      saveArea(a);
    }
  });
}

/**
 * A folder was deleted (lib/folders.ts, after folders.json lost it): the areas of folders that ended — the deleted one,
 * and one of a subfolder that fell into a folder already there — go to the trash whole, nothing lost: into the area of
 * the folder `into` names ('' = the House), their paths under `prefix` (the deleted folder's name, so they can be told
 * apart and restored), kept 30 days like anything trashed. Subfolders that moved up keep their areas (`followFolders`).
 * `idFor` gives the id of the folder they go into (making one when it has none).
 */
export function dropFolderAreas(
  root: string,
  into: (scope: string) => { folder: string; prefix: string },
  idFor: (folder: string) => string,
  by: { name: string; id?: string },
): void {
  const areas = listAreas().filter((a) => a.folder_id !== null && inside(a.scope, root));
  const gone = areas.filter((a) => folderPathOf(a.folder_id as string) === null);
  // where each goes, asked before the lock (making a folder's id takes the folders' lock)
  const plans = gone.map((a) => {
    const { folder, prefix } = into(a.scope);
    const folderId = folder ? idFor(folder) : null;
    return { from: a.id, to: areaIdOf(folderId), folderId, folder, prefix };
  });
  withFilesLock(() => {
    const at = isoLocal();
    for (const p of plans) {
      const g = areaForWrite(p.from);
      if (!g || (g.folder_id !== null && folderPathOf(g.folder_id) !== null)) continue;
      const t = areaForWrite(p.to) ?? emptyArea(p.to, p.folderId, p.folder);
      const changes: FileChange[] = [];
      t.rev++;
      const who = { trashed_at: at, trashed_by: by.name, ...(by.id ? { trashed_by_id: by.id } : {}), why: 'folder' as const };
      // the deleted folder's files come into its parent's trash as one folder of its name, restored together
      const group: TrashedDir | null = p.prefix
        ? { id: `fd_${crypto.randomBytes(6).toString('hex')}`, path: p.prefix.replace(/\/$/, ''), at, by: by.name, ...(by.id ? { by_id: by.id } : {}), ...who }
        : null;
      if (group) t.trash_dirs = [...(t.trash_dirs ?? []), group];
      for (const f of g.files) {
        const trashed: TrashedFile = { ...f, path: `${p.prefix}${f.path}`, ...who, ...(group ? { with_dir: group.id } : {}) };
        t.trash.push(trashed);
        changes.push({
          rev: t.rev,
          at,
          op: 'trash',
          id: f.id,
          path: trashed.path,
          from_area: g.scope,
          v: f.v,
          by: by.name,
          ...(by.id ? { by_id: by.id } : {}),
        });
      }
      if (group) for (const d of g.dirs ?? []) t.trash_dirs = [...(t.trash_dirs ?? []), { ...d, path: `${p.prefix}${d.path}`, ...who, with_dir: group.id }];
      for (const x of g.trash) t.trash.push({ ...x, path: `${p.prefix}${x.path}` });
      for (const x of g.trash_dirs ?? []) t.trash_dirs = [...(t.trash_dirs ?? []), { ...x, path: `${p.prefix}${x.path}` }];
      saveArea(t, changes);
      fs.rmSync(areaFile(g.id), { force: true });
    }
  });
  followFolders(root);
}
