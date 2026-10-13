// The disk side of `lampo files` (lib/filesSync.ts; docs/files.md "Agents"): where a file of an area lands under the
// folder a pull writes to and how it is written there, what of a folder a push reads, the hashes already worked out,
// and the record of what was pulled (`<folder>/.lampo/files.json`).
//
// A pull writes onto the agent's disk what a server names, and that server may not be honest (taken over, or not the
// one the agent thinks): every path is checked before anything is written — a name of a Lampo path and nothing else,
// never `..`, absolute, a drive letter, a NUL, a name Windows keeps for its devices (on Windows), never into or through
// a symbolic link, never onto a folder — and every byte goes to a new file in its folder (O_EXCL: nothing followed) and
// is moved into place only once its size and sha256 are right. A push reads only what it was named: a folder's
// symbolic links, hidden files (.env, .git) and anything but plain files stay where they are, said by name.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { caseKey, cleanFilePath, FILE_LIMITS, FilePathError, isJunkPath } from './fileText.ts';
import { isoLocal } from './paths.ts';

/** A place a server named that this side won't write to (the rest of a pull goes on). */
export class LandingError extends Error {}

/** Names Windows keeps for its devices, with any extension (`con.txt` is the console there). */
const WIN_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;
/** Characters a Windows name can't hold (a `:` names a drive or a hidden stream there). */
const WIN_CHARS = /[<>:"|?*]/;
/** The folder of the record of a pull, inside the folder pulled to: never written by a file a server names. */
export const RECORD_DIR = '.lampo';

/**
 * Why a path a server named can't be written under a folder here, or null. It must be a path a Lampo server keeps as it
 * keeps it (lib/fileText.ts cleanFilePath, unchanged by it): '/'-separated names, none empty, `.` or `..`, nothing
 * absolute, no backslash, no control character or NUL. Besides, here: no drive letter in front (`C:`), nothing in
 * `.lampo/` (the record of pulls), and on Windows (`win`) none of its device names (CON, NUL, COM1 …), no `<>:"|?*` and
 * no name that ends with a dot or a space (Windows would cut them, and two names would meet).
 */
export function landingProblem(p: unknown, { win = process.platform === 'win32' }: { win?: boolean } = {}): string | null {
  if (typeof p !== 'string' || !p) return 'no path';
  if (p.includes('\0')) return 'a NUL in its name';
  if (/^[a-z]:/i.test(p) || p.startsWith('\\\\')) return 'a drive or a share, not a path inside the folder';
  let clean: string;
  try {
    clean = cleanFilePath(p);
  } catch (e) {
    return (e as Error).message;
  }
  if (clean !== p) return 'not a path as Lampo keeps them';
  const names = p.split('/');
  if (names[0] === RECORD_DIR) return `${RECORD_DIR}/ holds the record of pulls here`;
  if (win)
    for (const n of names) {
      if (WIN_RESERVED.test(n)) return `"${n}" is a device's name on Windows`;
      if (WIN_CHARS.test(n)) return `"${n}" holds a character Windows names can't`;
      if (/[. ]$/.test(n)) return `"${n}" ends with a dot or a space, which Windows drops`;
    }
  return null;
}

const lstatOf = (p: string): fs.Stats | null => {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
};

/** The folder a pull writes to, made when missing, as its real path (it may be a link the person made: theirs to name). */
export function landingRoot(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const real = fs.realpathSync(dir);
  if (!fs.statSync(real).isDirectory()) throw new LandingError(`${dir} is not a folder`);
  return real;
}

const inside = (root: string, p: string): boolean => p === root || p.startsWith(root + path.sep);

/**
 * Where `rel` (a path an area keeps, checked with landingProblem) lands under `root` (landingRoot's): its folders made
 * one by one where missing, none of them a symbolic link or anything but a folder, and where it lands neither a link
 * nor a folder. Throws LandingError; writes nothing but those folders (`make: false`: nothing at all — what is missing on
 * the way is only checked as far as it exists).
 */
export function landingFor(root: string, rel: string, { make = true }: { make?: boolean } = {}): string {
  const names = rel.split('/');
  let at = root;
  for (const name of names.slice(0, -1)) {
    at = path.join(at, name);
    let st = lstatOf(at);
    if (!st && !make) return path.join(root, ...names);
    if (!st) {
      try {
        fs.mkdirSync(at);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      st = fs.lstatSync(at);
    }
    if (st.isSymbolicLink()) throw new LandingError(`${name} is a symbolic link here: nothing is written through one`);
    if (!st.isDirectory()) throw new LandingError(`${name} is a file here, not a folder`);
  }
  // what the folders resolve to now: inside the root, whatever happened on the way
  if (!inside(root, fs.realpathSync(at))) throw new LandingError('it would land outside the folder');
  const target = path.join(at, names.at(-1) as string);
  const st = lstatOf(target);
  if (st?.isSymbolicLink()) throw new LandingError('a symbolic link is there: it is never written through');
  if (st && !st.isFile()) throw new LandingError('a folder or something else than a file is there');
  return target;
}

/** The flags a new file is made with: it must not be there (a link there is never followed), nor a link on the way. */
const NEW_FILE = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
const MORE_OF_FILE = fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0);

/** Where a file's bytes wait while they come (beside where it lands, by its sha256: a pull run again goes on with it). */
export const partFile = (target: string, sha256: string): string => path.join(path.dirname(target), `.lampo-${sha256.slice(0, 16)}.part`);

/**
 * A file to write a file's bytes into, beside where it lands: a new one (none may be there), or (`resume`) the part
 * already there when it is a plain file — never through a link. Returns its descriptor and how many bytes it holds.
 */
export function openPart(part: string, { resume = false } = {}): { fd: number; have: number } {
  const st = lstatOf(part);
  if (st && (!resume || !st.isFile() || st.isSymbolicLink())) {
    if (st.isSymbolicLink() || !st.isFile()) throw new LandingError('something else than a file is where its bytes would wait');
    fs.rmSync(part);
  } else if (st && resume) return { fd: fs.openSync(part, MORE_OF_FILE), have: st.size };
  return { fd: fs.openSync(part, NEW_FILE, 0o644), have: 0 };
}

/**
 * The bytes in `part` become the file at `target` (landingFor's): checked once more that neither is a link and that its
 * folder is still inside `root`, then moved in one step (a rename replaces what is there, never what a link names).
 */
export function placeFile(root: string, part: string, target: string): void {
  const p = lstatOf(part);
  if (!p?.isFile()) throw new LandingError('its bytes went missing on the way');
  const t = lstatOf(target);
  if (t && (t.isSymbolicLink() || !t.isFile())) throw new LandingError('a link or a folder is there now');
  if (!inside(root, fs.realpathSync(path.dirname(target)))) throw new LandingError('it would land outside the folder');
  fs.renameSync(part, target);
}

/** sha256 of a file's first `bytes` (all of it when absent): what a part already holds before more is added. */
export async function hashOf(file: string, bytes?: number): Promise<crypto.Hash> {
  const h = crypto.createHash('sha256');
  if (bytes === 0) return h;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 << 20, ...(bytes !== undefined ? { end: bytes - 1 } : {}) }))
    h.update(chunk as Buffer);
  return h;
}

// ---------------------------------------------------------------- what a push reads

/** A file a push sends: where it is here, its path in the area, and what it is on this disk now. */
export interface LocalFile {
  abs: string;
  /** Its path in the area (lib/fileText.ts cleanFilePath's). */
  path: string;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

/** What a push leaves where it is, by its path as it would be in the area (each list sorted, as found). */
export interface LeftOut {
  /** Names starting with a dot inside a folder (.env, .git/, .cache/): sent only when named themselves. */
  hidden: string[];
  /** Symbolic links inside a folder: never followed. */
  links: string[];
  /** Neither a file nor a folder (a socket, a pipe, a device). */
  special: string[];
  /** A file system's or a tool's (.DS_Store, node_modules/, __MACOSX/). */
  junk: string[];
  /** Names a path in Lampo can't have, with why. */
  bad: { path: string; why: string }[];
  /** A second name that differs from one already sent only in case: the area would hold them as one. */
  clash: { path: string; with: string }[];
  /** Past the most one file may be (FILE_LIMITS.fileBytes). */
  big: string[];
}

export const noneLeft = (): LeftOut => ({ hidden: [], links: [], special: [], junk: [], bad: [], clash: [], big: [] });

/** Folders a push never walks into: a file system's or a tool's (lib/fileText.ts junk), and what is hidden. */
const SKIP_DIRS = new Set(['node_modules', '__MACOSX', '.Spotlight-V100', '.Trashes', '.fseventsd']);

/** The most a push names at once (an area holds at most this many files). */
export const PUSH_MAX = FILE_LIMITS.perArea;

/** A source named on the command line: a folder with a slash at its end (or `.`) sends what is in it, else itself. */
export const contentsOf = (src: string): boolean => /[/\\]$/.test(src) || /(^|[/\\])\.$/.test(src);

/**
 * What a push of `sources` (files and folders named here) sends, each at its path in the area: under `into` (a folder of
 * the area, '' its top), a folder by its name with everything in it (or, named with a slash at its end, what is in it),
 * a file by its name. Inside a folder only plain files and folders are taken, and none whose name starts with a dot;
 * links are never followed. Throws for a source that isn't there, or a push past PUSH_MAX files.
 */
export function gatherPush(sources: readonly string[], { into = '' }: { into?: string } = {}): { files: LocalFile[]; left: LeftOut } {
  const files: LocalFile[] = [];
  const left = noneLeft();
  const seen = new Map<string, string>();
  let visited = 0;
  const take = (abs: string, area: string, st: fs.Stats) => {
    let p: string;
    try {
      p = cleanFilePath(area);
    } catch (e) {
      if (e instanceof FilePathError && isJunkPath(area)) left.junk.push(area);
      else left.bad.push({ path: area, why: (e as Error).message });
      return;
    }
    const key = caseKey(p);
    const twin = seen.get(key);
    if (twin !== undefined) return void left.clash.push({ path: p, with: twin });
    if (st.size > FILE_LIMITS.fileBytes) return void left.big.push(p);
    seen.set(key, p);
    if (files.length >= PUSH_MAX) throw new Error(`more than ${PUSH_MAX.toLocaleString('en')} files: push a smaller folder, or its folders one by one`);
    files.push({ abs, path: p, size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino });
  };
  const join = (a: string, b: string) => (a ? `${a}/${b}` : b);
  const walk = (dir: string, area: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of entries) {
      if (++visited > PUSH_MAX * 10) throw new Error(`more than ${(PUSH_MAX * 10).toLocaleString('en')} names in ${dir}: push a smaller folder`);
      const at = join(area, d.name);
      const abs = path.join(dir, d.name);
      // the record of a pull, and the parts of one under way: this side's own, never material
      if (d.name === RECORD_DIR || /^\.lampo-[0-9a-f]{16}\.part$/.test(d.name)) continue;
      if (isJunkPath(d.isDirectory() ? `${at}/-` : at) || SKIP_DIRS.has(d.name)) left.junk.push(d.isDirectory() ? `${at}/` : at);
      else if (d.name.startsWith('.')) left.hidden.push(d.isDirectory() ? `${at}/` : at);
      else if (d.isSymbolicLink()) left.links.push(at);
      else if (d.isDirectory()) walk(abs, at);
      else if (d.isFile()) take(abs, at, fs.lstatSync(abs));
      else left.special.push(at);
    }
  };
  for (const src of sources) {
    const abs = path.resolve(src);
    let st: fs.Stats;
    try {
      // what was named is followed (the person named it); nothing inside it is
      st = fs.statSync(abs);
    } catch (e) {
      throw new Error(`${src}: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file or folder' : (e as Error).message}`);
    }
    if (st.isFile()) take(abs, join(into, path.basename(abs)), st);
    else if (st.isDirectory()) walk(abs, contentsOf(src) ? into : join(into, path.basename(abs)));
    else left.special.push(join(into, path.basename(abs)));
  }
  return { files, left };
}

// ---------------------------------------------------------------- hashes worked out before

/**
 * sha256es of files on this disk, by what says a file is unchanged (its device, inode, size and time): a push or a
 * status run again reads no file twice. Kept in the user's cache (never beside the files: a push changes nothing in the
 * folder it reads), the newest HASHES_KEPT.
 */
const HASHES_KEPT = 50_000;

export interface HashCache {
  sha256(f: Pick<LocalFile, 'abs' | 'size' | 'mtimeMs' | 'dev' | 'ino'>, onBytes?: (n: number) => void): Promise<string>;
  save(): void;
}

export function hashCache(file: string | null): HashCache {
  let known = new Map<string, string>();
  try {
    if (file) known = new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>));
  } catch {}
  let changed = false;
  const keyOf = (f: Pick<LocalFile, 'abs' | 'size' | 'mtimeMs' | 'dev' | 'ino'>) => `${f.dev}:${f.ino}:${f.size}:${f.mtimeMs}:${f.abs}`;
  return {
    async sha256(f, onBytes) {
      const k = keyOf(f);
      const hit = known.get(k);
      if (hit && /^[0-9a-f]{64}$/.test(hit)) return hit;
      const h = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(f.abs, { highWaterMark: 4 << 20 })) {
        h.update(chunk as Buffer);
        onBytes?.((chunk as Buffer).length);
      }
      const sha = h.digest('hex');
      known.delete(k);
      known.set(k, sha);
      changed = true;
      return sha;
    },
    save() {
      if (!file || !changed) return;
      const keep = [...known].slice(-HASHES_KEPT);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(keep)), { mode: 0o600 });
        fs.renameSync(tmp, file);
        changed = false;
      } catch {}
    },
  };
}

// ---------------------------------------------------------------- the record of pulls

/** One file a pull wrote: where it came from and what it was then, and what it is on this disk since. */
export interface PulledFile {
  /** The area it lives in ('' = the House), and the one the pull named (a folder sees the areas above it). */
  area: string;
  from: string;
  id: string;
  v: number;
  sha256: string;
  size: number;
  /** Its time on this disk once written: unchanged size and time, unchanged file. */
  mtime: number;
  at: string;
}

/** `<folder>/.lampo/files.json`: what pulls wrote into this folder, by its path there, and from which store. */
export interface PullRecord {
  v: 1;
  /** The server or store it came from (`lampo whoami`'s, without the account): another's files are never taken as these. */
  store: string;
  files: Record<string, PulledFile>;
}

export const recordFile = (root: string): string => path.join(root, RECORD_DIR, 'files.json');

/** The record of pulls into `root` (empty when none, or another store's), never read through a link. */
export function readRecord(root: string, store: string): PullRecord {
  const empty: PullRecord = { v: 1, store, files: {} };
  const dir = lstatOf(path.join(root, RECORD_DIR));
  const f = lstatOf(recordFile(root));
  if (!dir?.isDirectory() || !f?.isFile()) return empty;
  try {
    const r = JSON.parse(fs.readFileSync(recordFile(root), 'utf8')) as Partial<PullRecord>;
    if (r?.v !== 1 || r.store !== store || !r.files || typeof r.files !== 'object') return empty;
    const files: Record<string, PulledFile> = {};
    for (const [p, x] of Object.entries(r.files))
      if (x && typeof x.id === 'string' && typeof x.sha256 === 'string' && typeof x.v === 'number' && typeof x.area === 'string' && !landingProblem(p))
        files[p] = x;
    return { v: 1, store, files };
  } catch {
    return empty;
  }
}

/** Writes the record (atomically), never into or through a link: a `.lampo` that is one is left alone (false). */
export function writeRecord(root: string, record: PullRecord): boolean {
  const dir = path.join(root, RECORD_DIR);
  let st = lstatOf(dir);
  if (!st) {
    fs.mkdirSync(dir);
    st = fs.lstatSync(dir);
  }
  if (!st.isDirectory() || st.isSymbolicLink()) return false;
  const target = recordFile(root);
  const t = lstatOf(target);
  if (t && (t.isSymbolicLink() || !t.isFile())) return false;
  const tmp = path.join(dir, `.files.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, NEW_FILE, 0o644);
  try {
    fs.writeSync(fd, `${JSON.stringify(record, null, 1)}\n`);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  return true;
}

/** The record of a pull nearest above `dir` (or in it), with the folder it is for: what a push of part of it reads. */
export function findRecord(dir: string, store: string): { root: string; record: PullRecord } | null {
  let at = path.resolve(dir);
  for (let i = 0; i < 32; i++) {
    if (lstatOf(recordFile(at))?.isFile()) {
      const record = readRecord(at, store);
      return Object.keys(record.files).length ? { root: at, record } : null;
    }
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
  return null;
}

/** A file just written by a pull, as the record keeps it. */
export function pulledEntry(file: { area: string; id: string; v: number; sha256: string; size: number }, from: string, target: string): PulledFile {
  return { area: file.area, from, id: file.id, v: file.v, sha256: file.sha256, size: file.size, mtime: fs.statSync(target).mtimeMs, at: isoLocal() };
}
