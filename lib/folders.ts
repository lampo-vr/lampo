// Projects & folders: a user-made tree, independent of where the files live on disk.
//   data/folders.json          {"folders": ["ACME", "ACME/Spring Sale", …]}  (explicit folders, so empty ones survive)
//                              "ids": {"ACME": "f_…"}  (folders review links were made on: lib/folderIds.ts)
//                              "archived": {"ACME": {"at": "…", "by": "…"}}  (projects put away: lib/archived.ts)
//   review.json "folder"       "ACME/Spring Sale" or null (= Unsorted)
// A folder path is "/"-separated; top-level folders are shown as projects. Nothing changes inside an archived project
// (made, renamed, moved, deleted, moved into) until it is restored; only its owners and admins take a video out of it.

import fs from 'node:fs';
import path from 'node:path';
import { projectOfFolder } from './archived.ts';
import { moveAskFolders } from './asks.ts';
import { checkNotArchived, cleanArchived, FoldersUnreadableError, foldersFile, newFolderId, parseFolders, readFoldersText } from './folderIds.ts';
import { cutChars } from './names.ts';
import { dataDir, isoLocal, projectOf, slugify, USER } from './paths.ts';
import { movePlaybooks, playbookRoot } from './playbookFiles.ts';
import { bindShareTargets, folderLinks, moveShareFolders, revokeShares } from './shares.ts';
import {
  FOLDER_LIMITS,
  FolderLimitError,
  folderParts,
  historyFiles,
  listReviews,
  listSlugs,
  loadReview,
  logEvent,
  mutate,
  withLock,
  writeAtomic,
} from './store.ts';
import { compareTime } from './time.ts';
import type { ArchivedProject, FolderSuggestion, Review } from './types.ts';

const FILE = foldersFile;
const LOCK_DIR = (): string => path.join(dataDir(), '.folders');

/**
 * One name of a folder path: one line — control characters (NEL among them) and the line and paragraph separators fold
 * to spaces like any other whitespace —, well-formed (a lone surrogate, which JSON can carry, would break every URL of
 * the folder and of its videos' slugs), at most 60 characters, never cut through one.
 */
const cleanName = (s: string): string =>
  cutChars(
    s
      .toWellFormed()
      .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
      .trim()
      .replace(/\s+/g, ' '),
    60,
  );

/**
 * A folder path named for a write (made, moved into, uploaded into, asked on): "/"-separated names cleaned by
 * `cleanName`, at most FOLDER_LIMITS (12 levels, 400 characters) — past either a FolderLimitError (400), never cut to fit.
 */
export function normFolder(p: unknown): string | null {
  if (p === null || p === undefined) return null;
  const parts = folderParts(String(p), cleanName);
  return parts.length ? parts.join('/') : null;
}

/**
 * A folder path named to find one (list, open, download, rename or delete it): cleaned as normFolder cleans it, without
 * the limits, so a folder a store holds from before them still answers to its name.
 */
export function folderName(p: unknown): string | null {
  if (p === null || p === undefined) return null;
  const parts = String(p).split('/').map(cleanName).filter(Boolean);
  return parts.length ? parts.join('/') : null;
}

/** A folder someone names to change it: one that exists as it is stored (named before names were cleaned), else as given now. */
const existingFolder = (p: unknown): string | null => (typeof p === 'string' && p && allFolders().includes(p) ? p : folderName(p));

/** "A", "A/B", "A/B/C" for "A/B/C": one pass, each a prefix of the path. */
const ancestors = (p: string): string[] => {
  const out: string[] = [];
  for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) out.push(p.slice(0, i));
  out.push(p);
  return out;
};
/** The order folders.json keeps (as `localeCompare(…, 'de')` did, with one collator instead of one per comparison). */
const byName = new Intl.Collator('de').compare;
const inside = (f: string, root: string) => f === root || f.startsWith(`${root}/`);
const parentOf = (p: string) => p.split('/').slice(0, -1).join('/') || null;

/**
 * folders.json, or no folders when there is none yet. Any other failure (unreadable, damaged) throws, as shares.json's
 * does (lib/shares.ts readJson): read as empty, the next change would write the file without the folders' ids, and
 * every folder review link of the workspace would end for good. Everything that changes folders reads it first.
 */
function loadFile(): { folders: string[]; ids: Record<string, string>; archived: Record<string, ArchivedProject> } {
  const text = readFoldersText(FILE());
  if (text === null) return { folders: [], ids: {}, archived: {} };
  const f = parseFolders(text, FILE());
  return { folders: f.folders || [], ids: f.ids || {}, archived: cleanArchived(f.archived) };
}

export function loadFolders(): string[] {
  return loadFile().folders;
}

/**
 * The folders, the ids of those still there (an id ends with its folder) and the archived projects still there: every
 * change reads the file first and carries `archived` on as it found it, unless the change is the archive's own.
 */
function save(list: Iterable<string>, ids: Record<string, string>, archived: Record<string, ArchivedProject>): void {
  const set = new Set(list);
  const folders = [...set].sort(byName);
  const kept = Object.entries(ids).filter(([f]) => set.has(f));
  const shut = Object.entries(archived).filter(([f]) => set.has(f));
  fs.mkdirSync(dataDir(), { recursive: true });
  const file = { folders, ...(kept.length ? { ids: Object.fromEntries(kept) } : {}), ...(shut.length ? { archived: Object.fromEntries(shut) } : {}) };
  writeAtomic(FILE(), `${JSON.stringify(file, null, 2)}\n`);
}

/** Ids moved with their folders: `map` gives a folder's new path, or null for one whose id ends. */
function moveIds(ids: Record<string, string>, map: (f: string) => string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [f, id] of Object.entries(ids)) {
    const to = map(f);
    if (to) out[to] = id;
  }
  return out;
}

/** Every folder a video points at, and their parents. */
function foldersOf(reviews: Review[], explicit: string[] = []): string[] {
  const set = new Set<string>();
  for (const f of explicit) for (const a of ancestors(f)) set.add(a);
  for (const r of reviews) if (r.folder) for (const a of ancestors(r.folder)) set.add(a);
  return [...set].sort(byName);
}

// Explicit folders plus every folder a video points at (and their parents). Throws FoldersUnreadableError while
// folders.json can't be read: what checks a change goes through here, so the change refuses before anything moves.
export const allFolders = (reviews: Review[] = listReviews()): string[] => foldersOf(reviews, loadFolders());

const warned = new Map<string, string>();
/**
 * The folders as people see them — the library, search, lists, playbooks, downloads: allFolders while folders.json can
 * be read, else the folders videos are filed in (`degraded`; empty folders and their names wait for the file), logged
 * once per workspace and problem. A damaged file costs a moment's empty folders, never the library; changes still
 * refuse (allFolders), and `vr admin repair-folders` rebuilds the file.
 */
export function shownFolders(reviews: Review[] = listReviews()): { folders: string[]; degraded: boolean } {
  try {
    const folders = allFolders(reviews);
    warned.delete(FILE());
    return { folders, degraded: false };
  } catch (e) {
    if (!(e instanceof FoldersUnreadableError)) throw e;
    if (warned.get(FILE()) !== e.message) {
      console.error(
        `folders: ${e.message}: the library shows only the folders videos are in, and folders can't be changed, until it can be read (vr admin repair-folders rebuilds a damaged one)`,
      );
      warned.set(FILE(), e.message);
    }
    return { folders: foldersOf(reviews), degraded: true };
  }
}

export function createFolder(p: unknown): string {
  const f = normFolder(p);
  if (!f) throw new Error('folder name is empty');
  // nothing new in an archived project, a folder neither (and its own name is taken)
  checkNotArchived(f);
  withLock(LOCK_DIR(), () => {
    const { folders, ids, archived } = loadFile();
    const all = new Set(folders);
    // A folder made now is a new one, whatever an id left over under its name says (a file edited by hand).
    const made = new Set<string>();
    for (const a of ancestors(f))
      if (!all.has(a)) {
        all.add(a);
        made.add(a);
      }
    save(all, made.size ? Object.fromEntries(Object.entries(ids).filter(([x]) => !made.has(x))) : ids, archived);
  });
  return f;
}

/**
 * The id of a folder a review link is made on: its own, or a new one (the folder made explicit, so it can't vanish
 * when its last video moves out). The caller checks that the folder exists (allFolders).
 */
export function folderIdFor(p: string): string {
  return withLock(LOCK_DIR(), () => {
    const { folders, ids, archived } = loadFile();
    if (ids[p] && folders.includes(p)) return ids[p];
    const id = newFolderId();
    save([...folders, ...ancestors(p)], { ...ids, [p]: id }, archived);
    return id;
  });
}

/** Review links from before they knew what they were made for, bound once at start-up (lib/shares.ts bindShareTargets). */
export function bindShareLinks(): { bound: number; ended: number } {
  const known = new Set(allFolders());
  return bindShareTargets((f) => (known.has(f) ? folderIdFor(f) : null));
}

function setFolderInto(review: Review, folder: string | null, by: string): void {
  const before = review.folder || null;
  review.folder = folder;
  if (before !== folder) logEvent({ type: 'moved', by, review, text: `${before || 'Unsorted'} → ${folder || 'Unsorted'}` });
}

/**
 * Files a video in `folder` (null: no project). Never into an archived project; out of one only with `out` — the
 * caller may take videos out of archived projects (owners and admins: the `archive` action) — and never to another
 * place in it.
 */
export function moveVideo(slug: string, folder: unknown, by = USER, { out = false }: { out?: boolean } = {}): Review {
  const f = normFolder(folder);
  checkNotArchived(f);
  if (!out) checkNotArchived(loadReview(slug)?.folder);
  if (f) createFolder(f);
  return mutate(slug, (r) => setFolderInto(r, f, by));
}

// Rename or move a folder (with everything inside it).
export function renameFolder(from: unknown, to: unknown, by = USER): string {
  const a = existingFolder(from);
  const b = normFolder(to);
  if (!a || !b) throw new Error('folder name is empty');
  if (a === b) return b;
  if (inside(b, a)) throw new Error('a folder cannot move into itself');
  // an archived project keeps its name and its folders, and takes no folder in, until it is restored
  checkNotArchived(a);
  checkNotArchived(b);
  const known = allFolders();
  if (known.includes(b)) throw new Error(`"${b}" already exists`);
  const map = (f: string) => (inside(f, a) ? b + f.slice(a.length) : f);
  // What moves with it stays within the limits — or, made before them, gets no deeper or longer than it was: moving a
  // tree under another, again and again, would otherwise build any depth out of names that each fit.
  for (const f of known) if (inside(f, a)) withinLimits(f, map(f));
  withLock(LOCK_DIR(), () => {
    const { folders, ids, archived } = loadFile();
    save([...folders.map(map), ...ancestors(b)], moveIds(ids, map), archived);
  });
  // Its playbooks go with it (and those of its subfolders), and so do review links and the questions asked on it.
  withLock(playbookRoot(), () => movePlaybooks(a, map));
  moveShareFolders(map);
  moveAskFolders(map);
  for (const slug of listSlugs()) {
    const r = loadReview(slug);
    if (r?.folder && inside(r.folder, a)) mutate(slug, (rv) => setFolderInto(rv, rv.folder && map(rv.folder), by));
  }
  return b;
}

/** `to`, the new path of folder `from`: within FOLDER_LIMITS, or no deeper and no longer than `from` was. */
function withinLimits(from: string, to: string): void {
  const depth = (p: string) => p.split('/').length;
  if (depth(to) > Math.max(FOLDER_LIMITS.depth, depth(from)))
    throw new FolderLimitError(`a folder can be at most ${FOLDER_LIMITS.depth} levels deep (with its subfolders)`);
  if (to.length > Math.max(FOLDER_LIMITS.length, from.length))
    throw new FolderLimitError(`a folder path can be at most ${FOLDER_LIMITS.length} characters (with its subfolders)`);
}

// Delete a folder: its videos and subfolders move up one level (nothing is lost).
export function deleteFolder(p: unknown, by = USER): string | null {
  const a = existingFolder(p);
  if (!a) throw new Error('folder name is empty');
  // its videos would leave the archive on the way (a project's to No project): restored first, then deleted
  checkNotArchived(a);
  const parent = parentOf(a);
  const lift = (f: string) => (f === a ? parent : (parent ? `${parent}/` : '') + f.slice(a.length + 1));
  // Folders already there that a subfolder moving up would fall into (the two become one).
  const before = new Set(allFolders());
  const merges = (f: string) => f !== a && inside(f, a) && before.has(lift(f) as string);
  // Subfolders keep their playbooks one level up; the deleted folder's own is set aside (data/playbooks/archive/).
  withLock(playbookRoot(), () => movePlaybooks(a, (f) => (f === a ? null : lift(f))));
  // Review links end with their folder: one on the deleted folder, and one on a subfolder that falls into a folder
  // already there (it would show that folder's videos too). Links on the other subfolders follow them up.
  revokeShares((s) => !!s.folder && (s.folder === a || merges(s.folder)));
  moveShareFolders((f) => (f !== a && inside(f, a) && !merges(f) ? lift(f) : null));
  // Questions asked on it wait one level up (on the project, or with no project at all: '').
  moveAskFolders((f) => (inside(f, a) ? (lift(f) ?? '') : null));
  withLock(LOCK_DIR(), () => {
    const { folders, ids, archived } = loadFile();
    // A subfolder's id goes up with it; the deleted folder's ends, and so does one of a subfolder that merges.
    const lifted = (f: string) => (!inside(f, a) ? f : f === a || merges(f) ? null : lift(f));
    save(
      folders.map((f) => (inside(f, a) ? lift(f) : f)).filter((f): f is string => !!f),
      moveIds(ids, lifted),
      archived,
    );
  });
  for (const slug of listSlugs()) {
    const r = loadReview(slug);
    if (r?.folder && inside(r.folder, a)) mutate(slug, (rv) => setFolderInto(rv, rv.folder && lift(rv.folder), by));
  }
  return parent;
}

// ---------------------------------------------------------------- archiving a project

const refused = (status: number, message: string) => Object.assign(new Error(message), { status });

/** A project as someone names it to archive or restore it: one that is there, at the top level. */
function projectNamed(p: unknown): string {
  const name = existingFolder(p);
  if (!name) throw refused(400, 'which project? (path)');
  const top = projectOfFolder(name);
  if (top !== name) throw refused(400, `only a project can be archived: "${name}" is a folder in ${top}`);
  if (!allFolders().includes(name)) throw refused(404, `no project "${name}"`);
  return name;
}

/**
 * Archives a project (lib/archived.ts): it leaves the lists and becomes read-only, everything in it kept as it is.
 * `by`: the name shown with it, and the account. Archived already: it stays as it was archived first. Returns the
 * project's name and its record.
 */
export function archiveProject(p: unknown, by: { name: string; id?: string }): { project: string; archived: ArchivedProject } {
  const name = projectNamed(p);
  return withLock(LOCK_DIR(), () => {
    const { folders, ids, archived } = loadFile();
    const was = archived[name];
    if (was) return { project: name, archived: was };
    const record: ArchivedProject = { at: isoLocal(), by: by.name, ...(by.id ? { by_id: by.id } : {}) };
    // listed in the file (a project only its videos made is kept there from now on, so its mark has a place)
    save([...folders, name], ids, { ...archived, [name]: record });
    return { project: name, archived: record };
  });
}

/** Restores an archived project: back in the lists, open to work again, as it was. Not archived: nothing changes. */
export function restoreProject(p: unknown): { project: string; restored: boolean } {
  const name = projectNamed(p);
  return withLock(LOCK_DIR(), () => {
    const { folders, ids, archived } = loadFile();
    if (!archived[name]) return { project: name, restored: false };
    const { [name]: _restored, ...rest } = archived;
    save(folders, ids, rest);
    return { project: name, restored: true };
  });
}

// Where a new video probably belongs: the folder its siblings (same project dir) already live in, else a folder
// named after its project path without generic render folders, max three levels ("ACME/REELS/spring-sale",
// "Globex/launch-film"). Videos outside the home folder get just their folder name.
const GENERIC = /^(export|exports|out|output|render|renders|remotion|build|dist|final|finals|deliverables?)$/i;
export function suggestFolder(videoPath: string, reviews: Review[] = listReviews()): FolderSuggestion {
  const dirOf = (p: string) => {
    const i = p.lastIndexOf('/export/');
    return i >= 0 ? p.slice(0, i) : path.dirname(p);
  };
  const mine = dirOf(videoPath);
  const tally = new Map<string, number>();
  for (const r of reviews) if (r.folder && r.video !== videoPath && dirOf(r.video) === mine) tally.set(r.folder, (tally.get(r.folder) || 0) + 1);
  const best = [...tally.entries()].sort((x, y) => y[1] - x[1])[0];
  if (best) return { folder: best[0], reason: 'where its sibling renders are', exists: true };
  const rel = projectOf(videoPath); // relative to ~/Development or ~, absolute when outside home
  let parts = rel.split('/').filter(Boolean);
  while (parts.length > 1 && GENERIC.test(parts[parts.length - 1])) parts.pop();
  if (rel.startsWith('/')) parts = parts.slice(-1);
  // Three levels is enough to find things (e.g. ACME › REELS › inside-acme); episodes stay together.
  const folder = normFolder(parts.slice(0, 3).join('/'));
  return { folder, reason: 'from the project path', exists: !!folder && shownFolders(reviews).folders.includes(folder) };
}

// ---------------------------------------------------------------- repair (vr admin repair-folders)

export interface FolderRepairLink {
  /** The link's public id: what `--take-back` names. */
  id?: string;
  label: string;
  folder: string;
  /** It opens its folder with the file as it is, or as rebuilt. */
  works: boolean;
  /**
   * A rebuilt file only, for a link whose id the damaged text no longer holds: `taken back` — its folder's id came back
   * from it; `ended` — its folder had ended before the damage (`why`); `unsure` — nothing left in the store shows that its
   * folder is the one of that name now, so it isn't taken back: a person decides (`--take-back`).
   */
  state?: 'taken back' | 'ended' | 'unsure';
  why?: string;
}

export interface FolderRepair {
  file: string;
  /** The file as found: fine, not there (the folders are the videos'), or damaged (it can't be parsed). */
  state: 'ok' | 'missing' | 'damaged';
  problem?: string;
  /** The folders the file holds, or would hold once rebuilt. */
  folders: string[];
  /** The review links' folder ids it holds, or would: kept from the damaged file, or recovered from a link. */
  ids: { folder: string; id: string; from: 'file' | 'link' }[];
  /** Every folder review link not revoked, and whether it opens its folder with that file. */
  links: FolderRepairLink[];
  /** Where the damaged file was kept, once the rebuilt one was written. */
  kept?: string;
}

/** A JSON string's body (escapes kept), in a RegExp's source. */
const STRING = String.raw`"((?:[^"\\]|\\.)*)"`;
/** What a damaged folders.json still says, as far as its text is whole: the folders listed, and the ids. */
function recover(text: string): { folders: string[]; ids: [string, string][]; archived: Record<string, ArchivedProject> } {
  const str = (raw: string): string | null => {
    try {
      // well-formed as parseFolders reads a whole file: a name kept with a lone surrogate is recovered, not dropped
      const s = (JSON.parse(`"${raw}"`) as string).toWellFormed();
      return folderName(s) === s ? s : null;
    } catch {
      return null;
    }
  };
  const folders: string[] = [];
  const list = /"folders"\s*:\s*\[/g.exec(text);
  if (list) {
    const item = new RegExp(`\\s*${STRING}\\s*([,\\]])`, 'y');
    item.lastIndex = list.index + list[0].length;
    for (let m = item.exec(text); m; m = m[2] === ']' ? null : item.exec(text)) {
      const s = str(m[1] as string);
      if (s) folders.push(s);
    }
  }
  const ids: [string, string][] = [];
  const map = /"ids"\s*:\s*\{/g.exec(text);
  if (map) {
    const pair = new RegExp(`\\s*${STRING}\\s*:\\s*"(f_[0-9a-f]{12})"\\s*([,}])`, 'y');
    pair.lastIndex = map.index + map[0].length;
    for (let m = pair.exec(text); m; m = m[3] === '}' ? null : pair.exec(text)) {
      const s = str(m[1] as string);
      if (s) ids.push([s, m[2] as string]);
    }
  }
  // the archived projects, each entry as far as its text reads whole (a name, then an object without nesting)
  const archived: Record<string, ArchivedProject> = {};
  const shut = /"archived"\s*:\s*\{/g.exec(text);
  if (shut) {
    const entry = new RegExp(`\\s*${STRING}\\s*:\\s*(\\{[^{}]*\\})\\s*([,}])`, 'y');
    entry.lastIndex = shut.index + shut[0].length;
    for (let m = entry.exec(text); m; m = m[3] === '}' ? null : entry.exec(text)) {
      const name = str(m[1] as string);
      if (!name) continue;
      try {
        Object.assign(archived, cleanArchived({ [name]: JSON.parse(m[2] as string) }));
      } catch {}
    }
  }
  return { folders, ids, archived };
}

/**
 * When each video got the folder it is in now: its last move (the history, a moved store's included), else when it was
 * added (filed as it came).
 */
function filedSince(reviews: Review[]): Map<string, string> {
  const since = new Map<string, string>();
  for (const r of reviews) if (r.added) since.set(slugify(r.video), r.added);
  for (const file of historyFiles()) {
    let log = '';
    try {
      log = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of log.split('\n')) {
      if (!line.includes('"moved"')) continue;
      try {
        const e = JSON.parse(line) as { type?: string; slug?: string; at?: string };
        if (e.type === 'moved' && e.slug && e.at && since.has(e.slug)) since.set(e.slug, e.at);
      } catch {}
    }
  }
  return since;
}

/**
 * Looks at the workspace's folders.json and, when it is damaged, rebuilds it: the folders it still lists, every folder
 * a video is filed in, and the review links' ids — those the damaged text still holds, and for a folder that lost its
 * id there, one its folder links carry, but **never an id whose folder had ended: a link must not open another folder
 * that took its name** (GUEST-1, A12 VE1r2-2). A folder's id is made with its first link when it has none, so:
 * - of the ids that name one folder, only the newest can be its own (a later one was made because the earlier had
 *   ended), and the ids the file holds are in the order they were made — one made before the newest it still holds
 *   would be there, had its folder not ended;
 * - the newest is taken back when it is one of several (the others ended for it), or when the store shows that the
 *   folder is the one the link was made on: a video filed in it since before the link (its last move, else its
 *   arrival, earlier by the clock's whole seconds) or one the link's visitors already opened. Otherwise it is `unsure`
 *   and left for a person: `takeBack` names the links (their public ids) whose folders are theirs.
 * `write`: writes it (the damaged file kept beside it as folders.json.damaged-<time>); otherwise a dry run that says
 * what it would write. A file that can't be read at all (permissions, a failing disk) isn't rebuilt:
 * FoldersUnreadableError, fix that first.
 */
export function repairFolders({ write = false, takeBack = [] }: { write?: boolean; takeBack?: string[] } = {}): FolderRepair {
  const file = FILE();
  const text = readFoldersText(file);
  const reviews = listReviews();
  const links = folderLinks();
  const works = (ids: Map<string, string>): FolderRepairLink[] =>
    links.map((l) => ({ ...(l.id ? { id: l.id } : {}), label: l.label, folder: l.folder, works: !l.folder_id || ids.get(l.folder) === l.folder_id }));
  if (text === null) return { file, state: 'missing', folders: [], ids: [], links: works(new Map()) };
  try {
    const f = parseFolders(text, file);
    const ids = Object.entries(f.ids || {});
    return {
      file,
      state: 'ok',
      folders: f.folders || [],
      ids: ids.map(([folder, id]) => ({ folder, id, from: 'file' as const })),
      links: works(new Map(ids)),
    };
  } catch (e) {
    if (!(e instanceof FoldersUnreadableError)) throw e;
    const was = recover(text);
    const known = new Set(foldersOf(reviews, was.folders));
    const ids = new Map<string, { id: string; from: 'file' | 'link' }>();
    for (const [folder, id] of was.ids) ids.set(folder, { id, from: 'file' });
    const held = new Set(was.ids.map(([, id]) => id));
    // The order the ids were made in: their first links', by time, then by place in shares.json (a link is added at its
    // end) for links made in the same second.
    const first = new Map<string, { n: number; at: string }>();
    links
      .map((l, i) => ({ l, i }))
      .sort((a, b) => compareTime(a.l.created, b.l.created) || a.i - b.i)
      .forEach(({ l }, n) => {
        if (l.folder_id && !first.has(l.folder_id)) first.set(l.folder_id, { n, at: l.created });
      });
    const after = Math.max(-1, ...[...held].map((id) => first.get(id)?.n ?? -1));
    const since = filedSince(reviews);
    const sameFolder = (folder: string, id: string): boolean => {
      const at = first.get(id)?.at;
      const seen = new Set(links.filter((l) => l.folder_id === id).flatMap((l) => l.seen));
      return reviews.some((r) => {
        if (r.onboarding_sample || !r.folder || !inside(r.folder, folder)) return false;
        const slug = slugify(r.video);
        const t = since.get(slug);
        return seen.has(slug) || (!!at && !!t && compareTime(t, at) < 0);
      });
    };
    const verdict = new Map<string, { state: 'taken back' | 'ended' | 'unsure'; why?: string }>();
    const ended = (why: string) => ({ state: 'ended' as const, why });
    const named = new Map<string, string[]>(); // folder → the ids its links carry that the text lost
    for (const l of links) {
      const id = l.folder_id;
      if (!id || held.has(id) || verdict.has(id) || named.get(l.folder)?.includes(id)) continue;
      if (!known.has(l.folder)) verdict.set(id, ended('there is no folder of that name now'));
      else if (ids.has(l.folder)) verdict.set(id, ended('the damaged file still holds another id for that folder'));
      else if ((first.get(id)?.n ?? -1) < after)
        verdict.set(id, ended('its id is older than the newest one the damaged file still holds, so its folder had ended'));
      else named.set(l.folder, [...(named.get(l.folder) ?? []), id]);
    }
    for (const [folder, list] of named) {
      const order = list.sort((a, b) => (first.get(a)?.n ?? 0) - (first.get(b)?.n ?? 0));
      const newest = order.at(-1) as string;
      for (const id of order.slice(0, -1)) verdict.set(id, ended('a later link was made on a folder of that name, so its folder had ended'));
      if (order.length > 1 || sameFolder(folder, newest)) {
        ids.set(folder, { id: newest, from: 'link' });
        verdict.set(newest, { state: 'taken back' });
      } else verdict.set(newest, { state: 'unsure' });
    }
    // A person's word, for links nothing in the store could vouch for.
    const chosen = new Map<string, string>();
    for (const want of takeBack) {
      const l = links.find((x) => x.id === want);
      if (!l) throw new Error(`no folder review link ${want} (repair-folders prints their ids)`);
      const id = l.folder_id;
      if (!id || held.has(id) || !known.has(l.folder) || ids.get(l.folder)?.from === 'file')
        throw new Error(
          `${want} has nothing to take back: ${!id || held.has(id) ? 'it works as it is' : 'its folder isn’t there, or keeps the id the damaged file holds'}`,
        );
      const other = chosen.get(l.folder);
      if (other && other !== id) throw new Error(`two links on ${l.folder} with different ids: take back one`);
      chosen.set(l.folder, id);
      const before = ids.get(l.folder)?.id;
      if (before && before !== id) verdict.set(before, ended('another link on that folder was taken back'));
      ids.set(l.folder, { id, from: 'link' });
      verdict.set(id, { state: 'taken back', why: 'by --take-back' });
    }
    const folders = foldersOf(reviews, [...was.folders, ...ids.keys()]);
    const now = new Map([...ids].map(([folder, v]) => [folder, v.id]));
    const out: FolderRepair = {
      file,
      state: 'damaged',
      problem: e.message.replace(`${file} is damaged `, '').replace(/^\((.*)\)$/, '$1'),
      folders,
      ids: [...ids].map(([folder, v]) => ({ folder, ...v })),
      links: works(now).map((l, i) => {
        const v = verdict.get(links[i]?.folder_id ?? '');
        return v ? { ...l, state: v.state, ...(v.why ? { why: v.why } : {}) } : l;
      }),
    };
    if (write)
      out.kept = withLock(LOCK_DIR(), () => {
        if (readFoldersText(file) !== text) throw new Error(`${file} changed meanwhile: run repair-folders again`);
        const stamp = `${file}.damaged-${isoLocal().replace(/[:+]/g, '').replace(/\..*$/, '')}`;
        // Never over a copy kept before (two repairs in one second).
        for (let n = 1; ; n++) {
          const kept = n === 1 ? stamp : `${stamp}-${n}`;
          try {
            fs.copyFileSync(file, kept, fs.constants.COPYFILE_EXCL);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
            throw err;
          }
          // the archived projects the damaged text still names in whole stay archived
          save(folders, Object.fromEntries(now), was.archived);
          return kept;
        }
      });
    return out;
  }
}
