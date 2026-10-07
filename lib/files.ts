// Project files (docs/files.md): the material a project is made from that isn't a render — footage, music, fonts,
// logos, project files — kept per workspace where playbooks are (the House, a project, a folder), so a team, its
// agents and the next person to pick a project up work from the same material without the laptop it came from.
//
// The bytes: once per workspace, by SHA-256 (`files/sha256/<ab>/<sha256>` through the storage adapter's
// `filesStorage()`, the seam where a bucket of their own plugs in), recorded in a small index (data/files/blobs/<ab>.json:
// size, type, when) that is the truth about what is stored. An upload hashes what arrived, checks it against what was
// named, and keeps it only once. Nothing is ever deleted but by the purge: a blob goes when no catalog names it any
// more and it is older than a day (an upload committing now is never swept).
// The catalogs (lib/fileAreas.ts): per area, its files at their paths, each with its versions. Every change is a
// version or a journal line, attributed (the person's account, the agent that wrote with it, how it came) and
// recoverable: a push names the version it was based on and never overwrites one it didn't see (409, or a copy beside
// it), the trash keeps 30 days, replaced versions too. What counts toward the plan: live files once per workspace and
// pinned versions; the safety net (trash, replaced versions) doesn't, and is held to a share of the plan.
// Everything here runs in the workspace of the work calling it (lib/scope.ts): its catalogs, its index, its storage.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  AREA_ID,
  areaForWrite,
  areaIdOf,
  emptyArea,
  FilesUnreadableError,
  filesDir,
  folderPathOf,
  HOUSE_AREA,
  journalOf,
  listAreas,
  readArea,
  saveArea,
  scopeOf,
  withFilesLock,
} from './fileAreas.ts';
import { caseKey, cleanFilePath, copyPath, dirOf, FILE_LIMITS, kindOf, nameOf } from './fileText.ts';
import { checkNotArchived, folderIdOf } from './folderIds.ts';
import { allFolders, folderIdFor, folderName } from './folders.ts';
import { isoLocal } from './paths.ts';
import { chainOf } from './playbookFiles.ts';
import { filesStorage } from './storage/index.ts';
import type {
  FileArea,
  FileAreaInfo,
  FileChange,
  FileCommitAnswer,
  FileCommitItem,
  FileConflict,
  FileConflictMode,
  FileDir,
  FileDirInfo,
  FileEntry,
  FileHistory,
  FileInfo,
  FileKind,
  FileStamp,
  FilesListing,
  FilesSummary,
  FilesTrash,
  FilesUsage,
  FileTop,
  FileUploadResult,
  FileVersion,
  FileVersionInfo,
  TrashedDir,
  TrashedDirInfo,
  TrashedFile,
  TrashedFileInfo,
} from './types.ts';

export { FilesUnreadableError, HOUSE_AREA } from './fileAreas.ts';

/** A file's id: fl_ + 12 hex, the same through renames, moves and versions. */
export const FILE_ID = /^fl_[0-9a-f]{12}$/;
/** A folder's id inside an area (FileDir): fd_ + 12 hex. */
export const DIR_ID = /^fd_[0-9a-f]{12}$/;
/** A sha256 as the API takes it: 64 lowercase hex. */
export const SHA256 = /^[0-9a-f]{64}$/;

/** A mistake the caller can fix, or a refusal: the routes answer `status` with its message (and `details`). */
export class FileError extends Error {
  status: number;
  details?: Record<string, unknown>;
  constructor(status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    if (details) this.details = details;
  }
}

/** A push that would replace a version it didn't see (409): the files there now and who made them. Nothing was written. */
export class FileConflictError extends FileError {
  constructor(conflicts: FileConflict[]) {
    const [c] = conflicts;
    const who = c ? `${c.agent ? `${c.agent} (${c.by})` : c.by}` : '';
    const one = c
      ? c.base
        ? `${c.path} changed since V${c.base}: it is V${c.v} now, by ${who}, ${c.at}`
        : `${c.path} is there already (V${c.v}, by ${who}): name the version you based yours on (base), or push it as a copy`
      : 'the files changed';
    super(409, conflicts.length > 1 ? `${one} (and ${conflicts.length - 1} more)` : one, { conflicts });
  }
}

/** Who makes a change and how (FileStamp without its time). */
export type FileStampIn = Omit<FileStamp, 'at'>;

const stamped = (s: FileStampIn, at: string): FileStamp => ({
  by: s.by,
  ...(s.by_id ? { by_id: s.by_id } : {}),
  ...(s.agent ? { agent: s.agent } : {}),
  ...(s.agent_kind ? { agent_kind: s.agent_kind } : {}),
  via: s.via,
  ...(s.machine ? { machine: s.machine } : {}),
  at,
});

const newFileId = (): string => `fl_${crypto.randomBytes(6).toString('hex')}`;
const DAY = 86_400_000;
const keptMs = FILE_LIMITS.keptDays * DAY;
const addDays = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();

// ---------------------------------------------------------------- areas

/** An area as the routes name it: its id, its folder's id (null: the House) and its path now. */
export interface AreaRef {
  id: string;
  folderId: string | null;
  scope: string;
}

/** A folder someone names: '' (absent, empty) is the House; else one that exists (404), however it was spelt then. */
export function namedFolder(raw: string | null | undefined): string {
  if (!raw) return '';
  const f = folderName(raw);
  if (!f) return '';
  if (!allFolders().includes(f)) throw new FileError(404, `there is no folder "${f}"`);
  return f;
}

/**
 * The area of a folder ('' = the House). `create`: one is made for a folder that has none yet (its folder gets an id
 * in folders.json, and so stays when its last video leaves). Without, null when it has none (no files).
 */
export function areaRefOf(folder: string, { create = false } = {}): AreaRef | null {
  if (!folder) return { id: HOUSE_AREA, folderId: null, scope: '' };
  let id = folderIdOf(folder);
  if (!id) {
    if (!create) return null;
    id = folderIdFor(folder);
  }
  return { id: areaIdOf(id), folderId: id, scope: folder };
}

/** The revision of a folder's area now ('' = the House; 0: none yet): what a live update tells. */
export function readAreaRev(folder: string): number {
  const ref = areaRefOf(folder);
  return ref ? (readArea(ref.id)?.rev ?? 0) : 0;
}

/** An area by its id, where it is now; FileError 404 when its folder is gone (deleted since). */
function liveRef(id: string): AreaRef {
  if (!AREA_ID.test(id)) throw new FileError(404, 'no such place for files');
  if (id === HOUSE_AREA) return { id, folderId: null, scope: '' };
  const folderId = `f_${id.slice(3)}`;
  const scope = folderPathOf(folderId);
  if (scope === null) throw new FileError(404, 'the folder these files were for is gone');
  return { id, folderId, scope };
}

// ---------------------------------------------------------------- the bytes

/** A blob's key in the workspace's files storage. */
export const blobKey = (hash: string): string => `files/sha256/${hash.slice(0, 2)}/${hash}`;

/**
 * What the index says of a blob: its size, its type (from its bytes), when it was stored or last asked for, and whether
 * its bytes are in (`stored`; without, an upload is putting them there now) or are being removed (`gone`).
 */
interface Blob {
  size: number;
  type: string;
  at: string;
  stored?: true;
  gone?: true;
}
type Shard = Record<string, Blob>;

const blobsDir = (): string => path.join(filesDir(), 'blobs');
const shardFile = (hash: string): string => path.join(blobsDir(), `${hash.slice(0, 2)}.json`);

function readShard(hash: string): Shard {
  const file = shardFile(hash);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return Object.create(null) as Shard;
    throw new FilesUnreadableError(`${file} can't be read (${(e as NodeJS.ErrnoException).code})`, { cause: e });
  }
  try {
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
    return Object.assign(Object.create(null) as Shard, raw);
  } catch (e) {
    throw new FilesUnreadableError(`${file} is damaged (${(e as Error).message})`, { cause: e });
  }
}

function writeShard(hash: string, shard: Shard): void {
  fs.mkdirSync(blobsDir(), { recursive: true });
  const tmp = `${shardFile(hash)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(shard));
  fs.renameSync(tmp, shardFile(hash));
}

/** The blob, when its bytes are in the workspace (stored, not being removed). */
function storedBlob(hash: string): Blob | null {
  const b = readShard(hash)[hash];
  return b?.stored && !b.gone ? b : null;
}

/** Which of `hashes` the workspace doesn't hold (the dedupe question before a push: asked by `files-write` only). */
export function missingBlobs(hashes: string[]): string[] {
  const shards = new Map<string, Shard>();
  return [...new Set(hashes)].filter((h) => {
    const key = h.slice(0, 2);
    let shard = shards.get(key);
    if (!shard) {
      shard = readShard(h);
      shards.set(key, shard);
    }
    const b = shard[h];
    return !(b?.stored && !b.gone);
  });
}

/**
 * The blobs of `hashes` the workspace holds, made fresh for the purge (asked for now: a push commits them next), with
 * their sizes. What isn't held is left out.
 */
export function touchBlobs(hashes: string[]): Map<string, Blob> {
  const out = new Map<string, Blob>();
  if (!hashes.length) return out;
  withFilesLock(() => {
    const at = isoLocal();
    const byShard = new Map<string, string[]>();
    for (const h of new Set(hashes)) byShard.set(h.slice(0, 2), [...(byShard.get(h.slice(0, 2)) ?? []), h]);
    for (const list of byShard.values()) {
      const shard = readShard(list[0] as string);
      let changed = false;
      for (const h of list) {
        const b = shard[h];
        if (!b?.stored || b.gone) continue;
        b.at = at;
        changed = true;
        out.set(h, b);
      }
      if (changed) writeShard(list[0] as string, shard);
    }
  });
  return out;
}

/** sha256 and size of a file on this disk, read once. */
export async function hashFile(file: string): Promise<{ sha256: string; size: number }> {
  const h = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 << 20 })) {
    h.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: h.digest('hex'), size };
}

const TEXT = new TextDecoder('utf-8', { fatal: true });

/**
 * What a file is, from its first bytes (magic numbers), never from its name or what a client says: what lists and
 * agents group it by, and how its preview may one day be made. Unknown: application/octet-stream.
 */
export function sniffType(file: string): string {
  const buf = Buffer.alloc(512);
  let n = 0;
  const fd = fs.openSync(file, 'r');
  try {
    n = fs.readSync(fd, buf, 0, buf.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const b = buf.subarray(0, n);
  const at = (off: number, s: string) => b.length >= off + s.length && b.subarray(off, off + s.length).toString('latin1') === s;
  if (at(0, '\x89PNG\r\n\x1a\n')) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return 'image/gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  if (at(0, 'RIFF') && at(8, 'WAVE')) return 'audio/wav';
  if (at(0, 'RIFF') && at(8, 'AVI ')) return 'video/x-msvideo';
  if (at(0, 'FORM') && (at(8, 'AIFF') || at(8, 'AIFC'))) return 'audio/aiff';
  if (at(4, 'ftyp')) {
    const brand = b.subarray(8, 12).toString('latin1');
    if (brand === 'qt  ') return 'video/quicktime';
    if (brand === 'M4A ' || brand === 'M4B ') return 'audio/mp4';
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (/^(heic|heix|hevc|mif1|msf1)$/.test(brand)) return 'image/heic';
    if (brand === 'crx ') return 'image/x-canon-cr3';
    return 'video/mp4';
  }
  if (at(0, '\x1aE\xdf\xa3')) return b.includes('webm') ? 'video/webm' : 'video/x-matroska';
  if (at(0, 'ID3') || (b[0] === 0xff && (b[1] === 0xfb || b[1] === 0xf3 || b[1] === 0xf2 || b[1] === 0xfa))) return 'audio/mpeg';
  if (at(0, 'fLaC')) return 'audio/flac';
  if (at(0, 'OggS')) return 'audio/ogg';
  if (at(0, '%PDF-')) return 'application/pdf';
  if (at(0, 'PK\x03\x04') || at(0, 'PK\x05\x06')) return 'application/zip';
  if (b[0] === 0x1f && b[1] === 0x8b) return 'application/gzip';
  if (at(0, "7z\xbc\xaf'\x1c")) return 'application/x-7z-compressed';
  if (at(0, 'Rar!\x1a\x07')) return 'application/vnd.rar';
  if (at(0, '\xfd7zXZ\x00')) return 'application/x-xz';
  if (at(0, 'BZh')) return 'application/x-bzip2';
  if (at(0, 'II*\x00') || at(0, 'MM\x00*')) return 'image/tiff';
  if (at(0, '8BPS')) return 'image/vnd.adobe.photoshop';
  if (at(0, 'v/1\x01')) return 'image/x-exr';
  if (at(0, 'SDPX') || at(0, 'XPDS')) return 'image/x-dpx';
  if (at(0, '\x00\x01\x00\x00') || at(0, 'true')) return 'font/ttf';
  if (at(0, 'OTTO')) return 'font/otf';
  if (at(0, 'wOFF')) return 'font/woff';
  if (at(0, 'wOF2')) return 'font/woff2';
  if (at(0, 'ttcf')) return 'font/collection';
  if (at(0, '\x06\x0e\x2b\x34')) return 'application/mxf';
  if (at(0, '\x00\x00\x01\xba') || at(0, '\x00\x00\x01\xb3')) return 'video/mpeg';
  if (b[0] === 0x47 && b.length > 188 && b[188] === 0x47) return 'video/mp2t';
  if (b.length && !b.includes(0)) {
    try {
      // a character cut by the end of the window doesn't make it binary
      const text = TEXT.decode(b.length === buf.length ? b.subarray(0, b.length - 4) : b);
      return /<svg[\s>]/i.test(text.slice(0, 400)) ? 'image/svg+xml' : 'text/plain';
    } catch {}
  }
  return 'application/octet-stream';
}

/**
 * Keeps the bytes in `file` as the workspace's blob of their sha256 (once: bytes it holds already are dropped), after
 * checking them against what was named (`size`, `sha256`: a mismatch is refused, nothing kept). `file` is gone after.
 */
export async function storeBlob(file: string, expect: { size?: number; sha256?: string } = {}): Promise<{ hash: string; size: number; type: string }> {
  let keep = false;
  try {
    const { sha256: hash, size } = await hashFile(file);
    if (expect.size !== undefined && size !== expect.size) throw new FileError(400, `the bytes that came are ${size} long, not the ${expect.size} named`);
    if (expect.sha256 && hash !== expect.sha256) throw new FileError(400, 'the bytes that came don’t have the sha256 named: nothing was kept');
    const type = sniffType(file);
    // Claimed in the index before the bytes move, so the purge leaves them alone; held already: only made fresh.
    const held = withFilesLock(() => {
      const shard = readShard(hash);
      const b = shard[hash];
      if (b?.gone) throw Object.assign(new FileError(503, 'the files are being tidied up right now: try again in a moment'), { retryAfter: 2 });
      const now = isoLocal();
      if (b?.stored) {
        b.at = now;
        writeShard(hash, shard);
        return b;
      }
      shard[hash] = { size, type, at: now };
      writeShard(hash, shard);
      return null;
    });
    if (held) return { hash, size: held.size, type: held.type };
    try {
      keep = true;
      await filesStorage().put(blobKey(hash), file, { contentType: 'application/octet-stream' });
    } catch (e) {
      keep = false;
      withFilesLock(() => {
        const shard = readShard(hash);
        if (shard[hash] && !shard[hash].stored) {
          delete shard[hash];
          writeShard(hash, shard);
        }
      });
      throw e;
    }
    withFilesLock(() => {
      const shard = readShard(hash);
      shard[hash] = { size, type, at: isoLocal(), stored: true };
      writeShard(hash, shard);
    });
    return { hash, size, type };
  } finally {
    if (!keep) fs.rmSync(file, { force: true });
  }
}

/** Where an upload's bytes go (an upload ticket's target: server/uploadTickets.ts): the place, what was named, how to commit. */
export interface FileTarget {
  /** The area's id (it follows its folder through renames). */
  area: string;
  /** Its path when the upload was asked for (for messages). */
  folder: string;
  path: string;
  size: number;
  sha256?: string;
  base?: number | null;
  /** The bytes become the file at once (else only stored, a later commit names them). */
  commit: boolean;
  conflict: FileConflictMode;
  stamp: FileStampIn;
}

/** An upload's bytes arrived (a ticket's PUT, tus): stored, and committed when its ticket said so. */
export async function ingestFile(file: string, t: FileTarget): Promise<FileUploadResult> {
  const b = await storeBlob(file, { size: t.size, ...(t.sha256 ? { sha256: t.sha256 } : {}) });
  const stored = { path: t.path, sha256: b.hash, size: b.size, type: b.type, kind: kindOf(t.path, b.type) };
  if (!t.commit) return { stored };
  const commit = commitFiles(t.area, [{ path: t.path, sha256: b.hash, size: b.size, base: t.base ?? null }], { conflict: t.conflict, stamp: t.stamp });
  return { stored, commit };
}

// ---------------------------------------------------------------- committing

export interface CommitItem {
  path: string;
  sha256: string;
  size: number;
  base?: number | null;
}

/** The fields of one version, set as a file's current one. */
function setCurrent(e: FileEntry, v: FileVersion, type: string): void {
  for (const k of ['by_id', 'agent', 'agent_kind', 'machine', 'pinned', 'replaced'] as const) delete e[k];
  Object.assign(e, { v: v.v, hash: v.hash, size: v.size, by: v.by, via: v.via, at: v.at, type, kind: kindOf(e.path, type) });
  if (v.by_id) e.by_id = v.by_id;
  if (v.agent) e.agent = v.agent;
  if (v.agent_kind) e.agent_kind = v.agent_kind;
  if (v.machine) e.machine = v.machine;
}

/** The current version of a live file as an older one, replaced now. */
function asOlder(e: FileEntry, replaced: string): FileVersion {
  return {
    v: e.v,
    hash: e.hash,
    size: e.size,
    by: e.by,
    ...(e.by_id ? { by_id: e.by_id } : {}),
    ...(e.agent ? { agent: e.agent } : {}),
    ...(e.agent_kind ? { agent_kind: e.agent_kind } : {}),
    via: e.via,
    ...(e.machine ? { machine: e.machine } : {}),
    at: e.at,
    ...(e.pinned?.length ? { pinned: e.pinned } : {}),
    replaced,
  };
}

const conflictOf = (e: FileEntry, base: number | null): FileConflict => ({
  path: e.path,
  id: e.id,
  v: e.v,
  base,
  by: e.by,
  ...(e.agent ? { agent: e.agent } : {}),
  at: e.at,
});

/** Who a journal line names. */
const whoOf = (s: FileStampIn) => ({
  by: s.by,
  ...(s.by_id ? { by_id: s.by_id } : {}),
  ...(s.agent ? { agent: s.agent } : {}),
  ...(s.agent_kind ? { agent_kind: s.agent_kind } : {}),
  via: s.via,
});

/** Live files in every area of the workspace. */
const liveCount = (areas: FileArea[]): number => areas.reduce((n, a) => n + a.files.length, 0);

const tooMany = () => new FileError(409, `a folder’s files can be at most ${FILE_LIMITS.perArea.toLocaleString('en')}`);

/** "A", "A/B" for the path "A/B/c.mov": the folders a path is in, top first. */
function ancestors(p: string): string[] {
  const out: string[] = [];
  for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) out.push(p.slice(0, i));
  return out;
}

const newDirId = (): string => `fd_${crypto.randomBytes(6).toString('hex')}`;

/** An area's folders by their path for a file system that ignores case. */
const dirsByCase = (a: FileArea): Map<string, FileDir> => new Map((a.dirs ?? []).map((d) => [caseKey(d.path), d]));

/**
 * The folders `paths` are in (and, `self`, the paths themselves as folders), made where missing: a file's folders are
 * entries of the area like the file, so a folder stays when its last file leaves. Journal lines for each made.
 */
function ensureDirs(a: FileArea, paths: string[], stamp: FileStampIn, at: string, changes: FileChange[], self = false): void {
  const have = dirsByCase(a);
  for (const p of paths)
    for (const d of self ? [...ancestors(p), p] : ancestors(p)) {
      if (have.has(caseKey(d))) continue;
      const dir: FileDir = {
        id: newDirId(),
        path: d,
        at,
        by: stamp.by,
        ...(stamp.by_id ? { by_id: stamp.by_id } : {}),
        ...(stamp.agent ? { agent: stamp.agent } : {}),
      };
      a.dirs = [...(a.dirs ?? []), dir];
      have.set(caseKey(d), dir);
      changes.push({ rev: a.rev, at, op: 'add', id: dir.id, path: d, dir: true, ...whoOf(stamp) });
    }
}

/**
 * Whether a file may be at `p` in an area beside what is there: not where a folder is, and not under a path a file
 * has (a file system can't hold "Footage" as both). Throws 409.
 */
function checkPlace(a: FileArea, p: string, files: Map<string, FileEntry>, except?: string): void {
  if (dirsByCase(a).has(caseKey(p))) throw new FileError(409, `${p} is a folder here`);
  for (const d of ancestors(p)) {
    const f = files.get(caseKey(d));
    if (f && f.id !== except) throw new FileError(409, `${d} is a file here, so it can’t hold ${p}`);
  }
}

/**
 * Files whose bytes the workspace holds, as one change of an area: each a new file, the next version of the one at its
 * path (its `base` must be the version there now), or nothing when it holds those bytes already. A file that changed
 * since its base — or a path taken when none was named — is a conflict: all refused (FileConflictError, nothing
 * written), or with `conflict: 'copy'` kept beside it under the writer's name ("spot (Alex).aep").
 */
export function commitFiles(areaId: string, items: CommitItem[], o: { conflict?: FileConflictMode; stamp: FileStampIn }): FileCommitAnswer {
  if (!items.length) throw new FileError(400, 'nothing to commit');
  if (items.length > FILE_LIMITS.batch) throw new FileError(400, `at most ${FILE_LIMITS.batch} files at once`);
  const named = items.map((it) => ({ ...it, path: cleanFilePath(it.path) }));
  const seen = new Set<string>();
  for (const it of named) {
    if (!SHA256.test(it.sha256)) throw new FileError(400, `${it.path}: not a sha256`);
    if (seen.has(caseKey(it.path))) throw new FileError(400, `${it.path} is named twice`);
    seen.add(caseKey(it.path));
  }
  return withFilesLock(() => {
    const ref = liveRef(areaId);
    checkNotArchived(ref.scope);
    const a = areaForWrite(ref.id) ?? emptyArea(ref.id, ref.folderId, ref.scope);
    a.scope = ref.scope;
    const blobs = new Map<string, Blob>();
    for (const it of named) {
      const b = storedBlob(it.sha256);
      if (!b) throw new FileError(400, `${it.path}: its bytes aren’t here yet (upload them first)`);
      if (b.size !== it.size) throw new FileError(400, `${it.path}: its bytes are ${b.size} long, not ${it.size}`);
      blobs.set(it.sha256, b);
    }
    const byPath = new Map(a.files.map((e) => [caseKey(e.path), e]));
    const conflicts: FileConflict[] = [];
    const plan: Planned[] = [];
    for (const it of named) {
      const e = byPath.get(caseKey(it.path));
      const base = it.base ?? null;
      if (!e) plan.push({ it, state: 'added' });
      else if (e.hash === it.sha256 && e.path === it.path) plan.push({ it, e, state: 'same' });
      else if (base && base === e.v && e.path === it.path) plan.push({ it, e, state: 'version' });
      else if (o.conflict === 'copy') plan.push({ it, state: 'copy', asked: it.path });
      else conflicts.push(conflictOf(e, base));
    }
    if (conflicts.length) throw new FileConflictError(conflicts);
    const adding = plan.filter((p) => p.state === 'added' || p.state === 'copy').length;
    if (a.files.length + adding > FILE_LIMITS.perArea) throw tooMany();
    if (adding && liveCount(listAreas().filter((x) => x.id !== a.id)) + a.files.length + adding > FILE_LIMITS.perWorkspace)
      throw new FileError(409, `a workspace’s files can be at most ${FILE_LIMITS.perWorkspace.toLocaleString('en')}`);
    if (!plan.some((p) => p.state !== 'same')) return answerOf(a, plan);
    const at = isoLocal();
    a.rev++;
    const changes: FileChange[] = [];
    const dirs = dirsByCase(a);
    for (const p of plan) {
      const blob = blobs.get(p.it.sha256) as Blob;
      const version: FileVersion = { v: 1, hash: p.it.sha256, size: blob.size, ...stamped(o.stamp, at) };
      if (p.state === 'same') continue;
      if (p.state === 'version' && p.e) {
        const e = p.e;
        e.older = [asOlder(e, at), ...(e.older ?? [])];
        setCurrent(e, { ...version, v: e.v + 1 }, blob.type);
        changes.push({ rev: a.rev, at, op: 'version', id: e.id, path: e.path, v: e.v, hash: e.hash, size: e.size, ...whoOf(o.stamp) });
        continue;
      }
      const where = p.state === 'copy' ? copyPath(p.it.path, o.stamp.agent || o.stamp.by, (k) => byPath.has(k) || dirs.has(k)) : p.it.path;
      checkPlace(a, where, byPath);
      const e: FileEntry = {
        id: newFileId(),
        path: where,
        ...version,
        type: blob.type,
        kind: kindOf(where, blob.type),
        added_by: o.stamp.by,
        ...(o.stamp.by_id ? { added_by_id: o.stamp.by_id } : {}),
      };
      a.files.push(e);
      byPath.set(caseKey(where), e);
      p.e = e;
      ensureDirs(a, [where], o.stamp, at, changes);
      changes.push({ rev: a.rev, at, op: 'add', id: e.id, path: e.path, v: 1, hash: e.hash, size: e.size, ...whoOf(o.stamp) });
    }
    saveArea(a, changes);
    return answerOf(a, plan);
  });
}

interface Planned {
  it: CommitItem;
  e?: FileEntry;
  state: FileCommitItem['state'];
  asked?: string;
}

function answerOf(a: FileArea, plan: Planned[]): FileCommitAnswer {
  return {
    folder: a.scope,
    rev: a.rev,
    files: plan.map(({ e, state, asked }) => {
      const x = e as FileEntry;
      return { path: x.path, id: x.id, v: x.v, state, ...(asked ? { asked } : {}), sha256: x.hash, size: x.size };
    }),
  };
}

/**
 * Whether the files a push names conflict with what is there now (the version check before any byte moves): the
 * conflicts it would meet (empty: none). The commit checks again, with what is there then.
 */
export function pushConflicts(folder: string, items: { path: string; sha256?: string; base?: number | null }[]): FileConflict[] {
  const ref = areaRefOf(folder);
  const a = ref ? readArea(ref.id) : null;
  if (!a) return [];
  const byPath = new Map(a.files.map((e) => [caseKey(e.path), e]));
  const out: FileConflict[] = [];
  for (const it of items) {
    const e = byPath.get(caseKey(it.path));
    if (!e || (it.sha256 && e.hash === it.sha256 && e.path === it.path)) continue;
    const base = it.base ?? null;
    if (!(base && base === e.v && e.path === it.path)) out.push(conflictOf(e, base));
  }
  return out;
}

/** The bytes the commit of `items` would add to what counts toward the plan (blobs not counted now): what a plan checks. */
export function bytesToCount(items: { sha256: string; size: number }[]): number {
  const counted = countedHashes();
  const sizes = new Map(items.map((i) => [i.sha256, i.size]));
  let n = 0;
  for (const [h, size] of sizes) if (!counted.has(h)) n += size;
  return n;
}

// ---------------------------------------------------------------- folders inside an area

/** An empty folder inside an area ('' = the House): made with the folders it is in; one there already answers as it is. */
export function makeDir(areaId: string, rawPath: string, stamp: FileStampIn): FileDirInfo {
  const p = cleanFilePath(rawPath);
  return withFilesLock(() => {
    const ref = liveRef(areaId);
    checkNotArchived(ref.scope);
    const a = areaForWrite(ref.id) ?? emptyArea(ref.id, ref.folderId, ref.scope);
    a.scope = ref.scope;
    const files = new Map(a.files.map((e) => [caseKey(e.path), e]));
    if (files.has(caseKey(p))) throw new FileError(409, `${p} is a file here`);
    const there = dirsByCase(a).get(caseKey(p));
    if (there) return dirInfo(a, there, ref.scope);
    for (const d of ancestors(p)) if (files.has(caseKey(d))) throw new FileError(409, `${d} is a file here, so it can’t hold ${p}`);
    if ((a.dirs?.length ?? 0) + 1 > FILE_LIMITS.perArea) throw tooMany();
    const at = isoLocal();
    a.rev++;
    const changes: FileChange[] = [];
    ensureDirs(a, [p], stamp, at, changes, true);
    saveArea(a, changes);
    return dirInfo(a, dirsByCase(a).get(caseKey(p)) as FileDir, ref.scope);
  });
}

/** A folder of an area in numbers: everything under it. */
function dirInfo(a: FileArea, d: FileDir, scope: string): FileDirInfo {
  const under = a.files.filter((e) => e.path.startsWith(`${d.path}/`));
  return { id: d.id, area: scope, path: d.path, files: under.length, bytes: under.reduce((n, e) => n + e.size, 0) };
}

const isUnder = (p: string, root: string) => p === root || p.startsWith(`${root}/`);
const moved = (p: string, from: string, to: string) => (p === from ? to : `${to}${p.slice(from.length)}`);

/** A folder by its id in this workspace (live, or in a trash). */
function findDir(id: string): { area: FileArea; dir: FileDir | TrashedDir; trashed: boolean } | null {
  if (!DIR_ID.test(id)) return null;
  for (const area of listAreas()) {
    const dir = area.dirs?.find((d) => d.id === id);
    if (dir) return { area, dir, trashed: false };
    const t = area.trash_dirs?.find((d) => d.id === id);
    if (t) return { area, dir: t, trashed: true };
  }
  return null;
}

/**
 * A folder inside an area renamed, moved inside it, or moved to another area, with every file and folder under it
 * (ids, versions and history go along). A path taken there by anything that isn't moving is a conflict (409): nothing
 * moves.
 */
export function moveDir(id: string, to: { path?: string; area?: AreaRef }, stamp: FileStampIn): FileDirInfo {
  const newPath = to.path === undefined ? undefined : cleanFilePath(to.path);
  return withFilesLock(() => {
    const found = findDir(id);
    if (!found || found.trashed) throw notFound();
    const src = areaForWrite(found.area.id) as FileArea;
    const d = src.dirs?.find((x) => x.id === id);
    if (!d) throw notFound();
    const fromScope = scopeOf(src);
    checkNotArchived(fromScope);
    const dest = to.area && to.area.id !== src.id ? to.area : null;
    if (dest) checkNotArchived(dest.scope);
    const target = dest ? (areaForWrite(dest.id) ?? emptyArea(dest.id, dest.folderId, dest.scope)) : src;
    const from = d.path;
    const p = newPath ?? from;
    if (!dest && p === from) return dirInfo(src, d, fromScope);
    if (!dest && isUnder(p, from)) throw new FileError(400, 'a folder can’t move into itself');
    const files = src.files.filter((e) => isUnder(e.path, from));
    const dirs = (src.dirs ?? []).filter((x) => isUnder(x.path, from));
    const movingIds = new Set([...files.map((e) => e.id), ...dirs.map((x) => x.id)]);
    const taken = new Map<string, FileEntry | FileDir>();
    for (const e of target.files) if (!movingIds.has(e.id)) taken.set(caseKey(e.path), e);
    for (const x of target.dirs ?? []) if (!movingIds.has(x.id)) taken.set(caseKey(x.path), x);
    const clash = [...files, ...dirs].map((x) => moved(x.path, from, p)).find((q) => taken.has(caseKey(q)));
    if (clash) {
      const there = taken.get(caseKey(clash));
      if (there && 'hash' in there) throw new FileConflictError([conflictOf(there, null)]);
      throw new FileError(409, `${clash} is there already`);
    }
    for (const q of ancestors(p)) {
      const there = taken.get(caseKey(q));
      if (there && 'hash' in there) throw new FileError(409, `${q} is a file here, so it can’t hold ${p}`);
    }
    if (dest && target.files.length + files.length > FILE_LIMITS.perArea) throw tooMany();
    const at = isoLocal();
    const out: FileChange[] = [];
    const into: FileChange[] = [];
    src.rev++;
    if (dest) target.rev++;
    const entries: (FileDir | FileEntry)[] = [...dirs, ...files];
    for (const x of entries) {
      const was = x.path;
      x.path = moved(was, from, p);
      if ('hash' in x) (x as FileEntry).kind = kindOf(x.path, (x as FileEntry).type);
      const line: FileChange = {
        rev: target.rev,
        at,
        op: 'move',
        id: x.id,
        path: x.path,
        from: was,
        ...('hash' in x ? {} : { dir: true as const }),
        ...whoOf(stamp),
      };
      if (!dest) out.push(line);
      else {
        out.push({ ...line, rev: src.rev, to_area: dest.scope });
        into.push({ ...line, from_area: fromScope });
      }
    }
    if (dest) {
      src.files = src.files.filter((e) => !movingIds.has(e.id));
      src.dirs = (src.dirs ?? []).filter((x) => !movingIds.has(x.id));
      target.scope = dest.scope;
      target.files.push(...files);
      target.dirs = [...(target.dirs ?? []), ...dirs];
    }
    ensureDirs(target, [p], stamp, at, dest ? into : out);
    if (dest) saveArea(target, into);
    saveArea(src, out);
    return dirInfo(target, d, dest ? dest.scope : fromScope);
  });
}

/**
 * A folder inside an area to the trash with everything under it (files and folders), kept 30 days and restored
 * together. `mayAny`: the caller may trash what someone else added; without, only a folder whose every file they added.
 */
export function trashDir(id: string, stamp: FileStampIn, { mayAny }: { mayAny: boolean }): TrashedDirInfo {
  return withFilesLock(() => {
    const found = findDir(id);
    if (!found || found.trashed) throw notFound();
    const a = areaForWrite(found.area.id) as FileArea;
    const d = a.dirs?.find((x) => x.id === id);
    if (!d) throw notFound();
    const scope = scopeOf(a);
    checkNotArchived(scope);
    const files = a.files.filter((e) => isUnder(e.path, d.path));
    if (!mayAny && files.some((e) => !(stamp.by_id && e.added_by_id === stamp.by_id)))
      throw new FileError(403, 'only owners and admins move files someone else added to the trash');
    const dirs = (a.dirs ?? []).filter((x) => isUnder(x.path, d.path));
    const at = isoLocal();
    const by = {
      trashed_at: at,
      trashed_by: stamp.by,
      ...(stamp.by_id ? { trashed_by_id: stamp.by_id } : {}),
      ...(stamp.agent ? { trashed_agent: stamp.agent } : {}),
    };
    a.rev++;
    const changes: FileChange[] = [];
    const gone = new Set([...files.map((e) => e.id), ...dirs.map((x) => x.id)]);
    for (const e of files) {
      a.trash.push({ ...e, ...by, why: 'removed', with_dir: id });
      changes.push({ rev: a.rev, at, op: 'trash', id: e.id, path: e.path, v: e.v, ...whoOf(stamp) });
    }
    const top: TrashedDir = { ...d, ...by, why: 'removed' };
    a.trash_dirs = [...(a.trash_dirs ?? []), top, ...dirs.filter((x) => x.id !== id).map((x): TrashedDir => ({ ...x, ...by, why: 'removed', with_dir: id }))];
    changes.push({ rev: a.rev, at, op: 'trash', id, path: d.path, dir: true, ...whoOf(stamp) });
    a.files = a.files.filter((e) => !gone.has(e.id));
    a.dirs = (a.dirs ?? []).filter((x) => !gone.has(x.id));
    saveArea(a, changes);
    return trashedDirInfo(a, top, scope);
  });
}

/** A trashed folder with what came into the trash with it (its files and folders), or null. */
function trashedGroup(a: FileArea, top: string): { dirs: TrashedDir[]; files: TrashedFile[] } {
  return {
    dirs: (a.trash_dirs ?? []).filter((x) => x.id === top || x.with_dir === top),
    files: a.trash.filter((t) => t.with_dir === top),
  };
}

function trashedDirInfo(a: FileArea, d: TrashedDir, scope: string): TrashedDirInfo {
  const files = trashedGroup(a, d.with_dir ?? d.id).files;
  return {
    id: d.id,
    area: scope,
    path: d.path,
    files: files.length,
    bytes: files.reduce((n, t) => n + t.size, 0),
    trashed_at: d.trashed_at,
    trashed_by: d.trashed_by,
    ...(d.trashed_agent ? { trashed_agent: d.trashed_agent } : {}),
    ...(d.why ? { why: d.why } : {}),
    purge_at: addDays(d.trashed_at, keptMs),
  };
}

// ---------------------------------------------------------------- finding, moving, trashing, restoring files

export interface Found {
  area: FileArea;
  entry: FileEntry | TrashedFile;
  trashed: boolean;
}

/** A file by its id in this workspace (live, or in a trash), or null — another workspace's ids are nobody's here. */
export function findFile(id: string): Found | null {
  if (!FILE_ID.test(id)) return null;
  for (const area of listAreas()) {
    const entry = area.files.find((e) => e.id === id);
    if (entry) return { area, entry, trashed: false };
    const t = area.trash.find((e) => e.id === id);
    if (t) return { area, entry: t, trashed: true };
  }
  return null;
}

const notFound = () => new FileError(404, 'no such file');

/**
 * A file's new path, its new area, or both (a move to another folder, or the House). Its id, versions and history go
 * with it. A path taken there (also differing only in case) is a conflict (409): nothing moves.
 */
export function moveFile(id: string, to: { path?: string; area?: AreaRef }, stamp: FileStampIn): FileInfo {
  const newPath = to.path === undefined ? undefined : cleanFilePath(to.path);
  return withFilesLock(() => {
    const found = findFile(id);
    if (!found || found.trashed) throw notFound();
    const src = areaForWrite(found.area.id) as FileArea;
    const e = src.files.find((x) => x.id === id);
    if (!e) throw notFound();
    const fromScope = scopeOf(src);
    checkNotArchived(fromScope);
    const dest = to.area && to.area.id !== src.id ? to.area : null;
    if (dest) checkNotArchived(dest.scope);
    const target = dest ? (areaForWrite(dest.id) ?? emptyArea(dest.id, dest.folderId, dest.scope)) : src;
    const p = newPath ?? e.path;
    if (!dest && p === e.path) return fileInfo(e, fromScope);
    const others = new Map(target.files.filter((x) => x.id !== id).map((x) => [caseKey(x.path), x]));
    const twin = others.get(caseKey(p));
    if (twin) throw new FileConflictError([conflictOf(twin, null)]);
    checkPlace(target, p, others);
    if (dest && target.files.length + 1 > FILE_LIMITS.perArea) throw tooMany();
    const at = isoLocal();
    const from = e.path;
    e.path = p;
    e.kind = kindOf(p, e.type);
    src.rev++;
    if (!dest) {
      const changes: FileChange[] = [];
      ensureDirs(src, [p], stamp, at, changes);
      saveArea(src, [...changes, { rev: src.rev, at, op: 'move', id, path: p, from, ...whoOf(stamp) }]);
      return fileInfo(e, fromScope);
    }
    src.files = src.files.filter((x) => x.id !== id);
    target.scope = dest.scope;
    target.rev++;
    target.files.push(e);
    const into: FileChange[] = [];
    ensureDirs(target, [p], stamp, at, into);
    saveArea(target, [...into, { rev: target.rev, at, op: 'move', id, path: p, from, from_area: fromScope, ...whoOf(stamp) }]);
    saveArea(src, [{ rev: src.rev, at, op: 'move', id, path: p, from, to_area: dest.scope, ...whoOf(stamp) }]);
    return fileInfo(e, dest.scope);
  });
}

/**
 * A live file to its area's trash: kept 30 days, then purged (its versions with it). `mayAny`: the caller may trash
 * what someone else added (`remove`); without, only what their own account added.
 */
export function trashFile(id: string, stamp: FileStampIn, { mayAny }: { mayAny: boolean }): TrashedFileInfo {
  return withFilesLock(() => {
    const found = findFile(id);
    if (!found || found.trashed) throw notFound();
    const a = areaForWrite(found.area.id) as FileArea;
    const e = a.files.find((x) => x.id === id);
    if (!e) throw notFound();
    const scope = scopeOf(a);
    checkNotArchived(scope);
    if (!mayAny && !(stamp.by_id && e.added_by_id === stamp.by_id))
      throw new FileError(403, 'only owners and admins move files someone else added to the trash');
    const at = isoLocal();
    const t: TrashedFile = { ...e, trashed_at: at, trashed_by: stamp.by, why: 'removed' };
    if (stamp.by_id) t.trashed_by_id = stamp.by_id;
    if (stamp.agent) t.trashed_agent = stamp.agent;
    a.files = a.files.filter((x) => x.id !== id);
    a.trash.push(t);
    a.rev++;
    saveArea(a, [{ rev: a.rev, at, op: 'trash', id, path: e.path, v: e.v, ...whoOf(stamp) }]);
    return trashedInfo(t, scope);
  });
}

/**
 * A file back: out of the trash (at its path, or beside it as "name (restored)" when that is taken again), or — `v` of a
 * live file — an older version as its newest (V5 with V2's bytes; V4 stays one of its versions). A folder's id (fd_):
 * the folder out of the trash with everything that went there with it.
 */
export function restoreFile(id: string, v: number | undefined, stamp: FileStampIn): { file: FileInfo; state: 'restored' | 'copy' | 'version' | 'same' } {
  return withFilesLock(() => {
    const found = findFile(id);
    if (!found) throw notFound();
    const a = areaForWrite(found.area.id) as FileArea;
    const scope = scopeOf(a);
    checkNotArchived(scope);
    const at = isoLocal();
    if (found.trashed) {
      const t = a.trash.find((x) => x.id === id);
      if (!t) throw notFound();
      if (a.files.length + 1 > FILE_LIMITS.perArea) throw tooMany();
      const changes: FileChange[] = [];
      a.rev++;
      const { live, state } = backFromTrash(a, t, stamp, at, changes);
      a.trash = a.trash.filter((x) => x.id !== id);
      saveArea(a, changes);
      return { file: fileInfo(live, scope), state };
    }
    const e = a.files.find((x) => x.id === id);
    if (!e) throw notFound();
    if (v === undefined) throw new FileError(409, 'this file isn’t in the trash: name the version to bring back (v)');
    if (v === e.v) return { file: fileInfo(e, scope), state: 'same' };
    const old = e.older?.find((x) => x.v === v);
    const blob = old ? storedBlob(old.hash) : null;
    if (!old || !blob) throw new FileError(404, `V${v} of this file isn’t kept any more`);
    e.older = [asOlder(e, at), ...(e.older ?? [])];
    setCurrent(e, { v: e.v + 1, hash: old.hash, size: old.size, ...stamped(stamp, at) }, blob.type);
    a.rev++;
    saveArea(a, [{ rev: a.rev, at, op: 'revert', id, path: e.path, v: e.v, hash: e.hash, size: e.size, ...whoOf(stamp) }]);
    return { file: fileInfo(e, scope), state: 'version' };
  });
}

/** A trashed file live again in its area (at its path, or beside it when that is taken), with the folders it is in. */
function backFromTrash(a: FileArea, t: TrashedFile, stamp: FileStampIn, at: string, changes: FileChange[]): { live: FileEntry; state: 'restored' | 'copy' } {
  const { trashed_at: _a, trashed_by: _b, trashed_by_id: _c, trashed_agent: _d, why: _w, with_dir: _g, ...live } = t;
  const files = new Map(a.files.map((x) => [caseKey(x.path), x]));
  const dirs = dirsByCase(a);
  const taken = (k: string) => files.has(k) || dirs.has(k);
  let state: 'restored' | 'copy' = 'restored';
  if (ancestors(live.path).some((d) => files.has(caseKey(d)))) {
    // a file has the name of a folder it was in: it comes back at the top, beside everything
    state = 'copy';
    live.path = taken(caseKey(nameOf(live.path))) ? copyPath(nameOf(live.path), 'restored', taken) : nameOf(live.path);
  } else if (taken(caseKey(live.path))) {
    state = 'copy';
    live.path = copyPath(live.path, 'restored', taken);
  }
  a.files.push(live);
  ensureDirs(a, [live.path], stamp, at, changes);
  changes.push({ rev: a.rev, at, op: 'restore', id: live.id, path: live.path, v: live.v, ...whoOf(stamp) });
  return { live, state };
}

/** A trashed folder back with everything that went to the trash with it; files whose place is taken land beside it. */
export function restoreDir(id: string, stamp: FileStampIn): FileDirInfo {
  return withFilesLock(() => {
    const found = findDir(id);
    if (!found) throw notFound();
    const a = areaForWrite(found.area.id) as FileArea;
    const scope = scopeOf(a);
    checkNotArchived(scope);
    if (!found.trashed) {
      const d = a.dirs?.find((x) => x.id === id);
      if (!d) throw notFound();
      return dirInfo(a, d, scope);
    }
    const t = a.trash_dirs?.find((x) => x.id === id);
    if (!t) throw notFound();
    const top = t.with_dir ?? t.id;
    const group = trashedGroup(a, top);
    const head = group.dirs.find((x) => x.id === top) ?? t;
    if (a.files.some((e) => caseKey(e.path) === caseKey(head.path))) throw new FileError(409, `${head.path} is a file here now: rename it first`);
    if (a.files.length + group.files.length > FILE_LIMITS.perArea) throw tooMany();
    const at = isoLocal();
    a.rev++;
    const changes: FileChange[] = [];
    const have = dirsByCase(a);
    for (const x of group.dirs.sort((p, q) => p.path.length - q.path.length)) {
      if (have.has(caseKey(x.path))) continue;
      const { trashed_at: _a, trashed_by: _b, trashed_by_id: _c, trashed_agent: _d, why: _w, with_dir: _g, ...dir } = x;
      a.dirs = [...(a.dirs ?? []), dir];
      have.set(caseKey(dir.path), dir);
      changes.push({ rev: a.rev, at, op: 'restore', id: dir.id, path: dir.path, dir: true, ...whoOf(stamp) });
    }
    ensureDirs(a, [head.path], stamp, at, changes, true);
    for (const f of group.files) backFromTrash(a, f, stamp, at, changes);
    const back = new Set([...group.dirs.map((x) => x.id), ...group.files.map((x) => x.id)]);
    a.trash = a.trash.filter((x) => !back.has(x.id));
    a.trash_dirs = (a.trash_dirs ?? []).filter((x) => !back.has(x.id));
    saveArea(a, changes);
    return dirInfo(a, dirsByCase(a).get(caseKey(head.path)) as FileDir, scope);
  });
}

/** A version of a file to download: the current one, or an older one still kept (null: not kept). */
export function versionOf(e: FileEntry, v?: number): FileVersion | null {
  if (v === undefined || v === e.v) return e;
  return e.older?.find((x) => x.v === v) ?? null;
}

// ---------------------------------------------------------------- what the API shows

export function fileInfo(e: FileEntry, area: string): FileInfo {
  return {
    id: e.id,
    area,
    path: e.path,
    v: e.v,
    size: e.size,
    sha256: e.hash,
    type: e.type,
    kind: e.kind,
    by: e.by,
    ...(e.by_id ? { by_id: e.by_id } : {}),
    ...(e.agent ? { agent: e.agent } : {}),
    ...(e.agent_kind ? { agent_kind: e.agent_kind } : {}),
    via: e.via,
    at: e.at,
    added_by: e.added_by,
    versions: 1 + (e.older?.length ?? 0),
    ...(e.editing ? { editing: e.editing } : {}),
  };
}

export function trashedInfo(t: TrashedFile, area: string): TrashedFileInfo {
  return {
    ...fileInfo(t, area),
    trashed_at: t.trashed_at,
    trashed_by: t.trashed_by,
    ...(t.trashed_agent ? { trashed_agent: t.trashed_agent } : {}),
    ...(t.why ? { why: t.why } : {}),
    purge_at: addDays(t.trashed_at, keptMs),
  };
}

function versionInfo(x: FileVersion, current: boolean): FileVersionInfo {
  return {
    v: x.v,
    size: x.size,
    sha256: x.hash,
    by: x.by,
    ...(x.by_id ? { by_id: x.by_id } : {}),
    ...(x.agent ? { agent: x.agent } : {}),
    ...(x.agent_kind ? { agent_kind: x.agent_kind } : {}),
    via: x.via,
    at: x.at,
    ...(current ? { current: true as const } : {}),
    ...(!current && !x.pinned?.length && x.replaced ? { kept_until: addDays(x.replaced, keptMs) } : {}),
    ...(x.pinned?.length ? { pinned: x.pinned } : {}),
  };
}

const byPath = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare;

function areaInfo(a: FileArea | null, scope: string): FileAreaInfo {
  const sum = (list: { size: number }[]) => list.reduce((n, x) => n + x.size, 0);
  return {
    area: scope,
    rev: a?.rev ?? 0,
    files: a?.files.length ?? 0,
    bytes: sum(a?.files ?? []),
    trash: a?.trash.length ?? 0,
    trash_bytes: sum(a?.trash ?? []),
  };
}

/** The areas of a folder's chain, deepest first: each scope with its catalog (null: none yet). */
function chainAreas(folder: string, own: boolean): { scope: string; area: FileArea | null }[] {
  const scopes = own ? [folder] : chainOf(folder).reverse();
  return scopes.map((scope) => {
    const ref = areaRefOf(scope);
    return { scope, area: ref ? readArea(ref.id) : null };
  });
}

/** The folder part of a listing's `path`: '' for the top, else a path inside the area (refused like a file's). */
function listedPath(raw: string | undefined): string {
  const p = (raw ?? '').replace(/\/+$/, '');
  return p ? cleanFilePath(p) : '';
}

export interface ListOptions {
  path?: string;
  deep?: boolean;
  own?: boolean;
  kind?: FileKind;
  q?: string;
  limit?: number;
  cursor?: string;
}

/**
 * The files that apply in a folder ('' = the House): its own and every area's above it, deepest first, a deeper path
 * hiding the same path above (as playbooks do); the folders directly under `path` (empty ones too); a page of files
 * directly in `path`, or every one under it (`deep`, and with `q` or `kind`).
 */
export function listFiles(folder: string, o: ListOptions = {}): FilesListing {
  const chain = chainAreas(folder, !!o.own);
  const p = listedPath(o.path);
  const under = (x: string) => !p || x.startsWith(`${p}/`);
  const seen = new Set<string>();
  const all: { e: FileEntry; scope: string; depth: number }[] = [];
  const dirs = new Map<string, FileDirInfo>();
  const cut = p ? p.length + 1 : 0;
  /** The folder directly under `p` that `x` (a path under it) is in, or null when `x` is directly in `p`. */
  const childOf = (x: string): string | null => {
    const slash = x.indexOf('/', cut);
    return slash === -1 ? null : x.slice(0, slash);
  };
  chain.forEach(({ scope, area }, depth) => {
    for (const e of area?.files ?? []) {
      if (seen.has(e.path)) continue;
      seen.add(e.path);
      if (under(e.path)) all.push({ e, scope, depth });
    }
    for (const d of area?.dirs ?? []) {
      if (p && !d.path.startsWith(`${p}/`)) continue;
      const child = childOf(d.path) ?? d.path;
      const x = dirs.get(child) ?? { area: scope, path: child, files: 0, bytes: 0 };
      if (child === d.path && !x.id) x.id = d.id;
      dirs.set(child, x);
    }
  });
  for (const { e, scope } of all) {
    const d = childOf(e.path);
    if (!d) continue;
    const x = dirs.get(d) ?? { area: scope, path: d, files: 0, bytes: 0 };
    x.files++;
    x.bytes += e.size;
    dirs.set(d, x);
  }
  const deep = !!(o.deep || o.q || o.kind);
  const q = o.q?.toLowerCase();
  const picked = all
    .filter(({ e }) => (deep || dirOf(e.path) === p) && (!o.kind || e.kind === o.kind) && (!q || e.path.toLowerCase().includes(q)))
    .sort((a, b) => a.depth - b.depth || byPath(a.e.path, b.e.path));
  const limit = Math.min(Math.max(1, o.limit ?? FILE_LIMITS.page), FILE_LIMITS.pageMax);
  const from = o.cursor ? Number(o.cursor) || 0 : 0;
  const page = picked.slice(from, from + limit);
  return {
    folder,
    areas: chain.filter(({ scope, area }) => scope === folder || area?.files.length || area?.trash.length).map(({ scope, area }) => areaInfo(area, scope)),
    path: p,
    dirs: [...dirs.values()].sort((a, b) => byPath(a.path, b.path)),
    files: page.map(({ e, scope }) => fileInfo(e, scope)),
    total: picked.length,
    ...(from + limit < picked.length ? { cursor: String(from + limit) } : {}),
  };
}

/** The tree in short: per area of the chain (deepest first, those with files or folders), its top-level entries. */
export function filesSummary(folder: string): FilesSummary {
  return {
    folder,
    areas: chainAreas(folder, false)
      .filter(({ scope, area }) => scope === folder || area?.files.length || area?.dirs?.length)
      .map(({ scope, area }) => {
        const tops = new Map<string, FileTop & { kindSet: Set<FileKind> }>();
        const top = (name: string, dir: boolean) => {
          const t = tops.get(name) ?? { path: name, dir, files: 0, bytes: 0, kinds: [], kindSet: new Set<FileKind>() };
          tops.set(name, t);
          return t;
        };
        for (const d of area?.dirs ?? []) if (!d.path.includes('/')) top(`${d.path}/`, true);
        for (const e of area?.files ?? []) {
          const slash = e.path.indexOf('/');
          const t = top(slash !== -1 ? `${e.path.slice(0, slash)}/` : e.path, slash !== -1);
          t.files++;
          t.bytes += e.size;
          t.kindSet.add(e.kind);
        }
        return {
          ...areaInfo(area, scope),
          tops: [...tops.values()]
            .sort((a, b) => Number(b.dir) - Number(a.dir) || byPath(a.path, b.path))
            .map(({ kindSet, ...t }) => ({ ...t, kinds: [...kindSet].sort() })),
        };
      }),
  };
}

/** One area's trash, newest first: its files and the folders trashed whole. */
export function trashOf(folder: string): FilesTrash {
  const ref = areaRefOf(folder);
  const a = ref ? readArea(ref.id) : null;
  const files = (a?.trash ?? []).map((t) => trashedInfo(t, folder)).sort((x, y) => Date.parse(y.trashed_at) - Date.parse(x.trashed_at));
  const dirs = a ? (a.trash_dirs ?? []).filter((d) => !d.with_dir).map((d) => trashedDirInfo(a, d, folder)) : [];
  return {
    folder,
    files,
    bytes: files.reduce((n, f) => n + f.size, 0),
    ...(dirs.length ? { dirs: dirs.sort((x, y) => Date.parse(y.trashed_at) - Date.parse(x.trashed_at)) } : {}),
  };
}

/** A file's versions (newest first) and its journal (newest first). */
export function historyOf(id: string): FileHistory {
  const found = findFile(id);
  if (!found) throw notFound();
  const { entry: e, area } = found;
  return {
    file: found.trashed ? trashedInfo(e as TrashedFile, scopeOf(area)) : fileInfo(e, scopeOf(area)),
    versions: [versionInfo(e, true), ...(e.older ?? []).map((x) => versionInfo(x, false))],
    changes: journalOf(area.id, (c) => c.id === id, FILE_LIMITS.history),
  };
}

/** A trashed or live folder's info by its id (the answer of a dir's DELETE or restore). */
export function dirInfoOf(id: string): FileDirInfo | TrashedDirInfo {
  const found = findDir(id);
  if (!found) throw notFound();
  const scope = scopeOf(found.area);
  return found.trashed ? trashedDirInfo(found.area, found.dir as TrashedDir, scope) : dirInfo(found.area, found.dir, scope);
}

// ---------------------------------------------------------------- usage and the purge

/** The bytes that count toward the plan, by hash: every live file's current version, and pinned versions. */
function countedHashes(areas = listAreas()): Map<string, number> {
  const counted = new Map<string, number>();
  for (const a of areas)
    for (const e of a.files) {
      counted.set(e.hash, e.size);
      for (const x of e.older ?? []) if (x.pinned?.length) counted.set(x.hash, x.size);
    }
  return counted;
}

/** The safety net, by hash: the trash and replaced versions, minus what counts anyway. */
function keptHashes(areas: FileArea[], counted: Map<string, number>): { kept: Map<string, number>; items: number } {
  const kept = new Map<string, number>();
  let items = 0;
  for (const a of areas) {
    for (const e of a.files)
      for (const x of e.older ?? [])
        if (!x.pinned?.length) {
          items++;
          kept.set(x.hash, x.size);
        }
    for (const t of a.trash) {
      items++;
      kept.set(t.hash, t.size);
      for (const x of t.older ?? []) {
        items++;
        kept.set(x.hash, x.size);
      }
    }
  }
  for (const h of counted.keys()) kept.delete(h);
  return { kept, items };
}

const total = (m: Map<string, number>) => [...m.values()].reduce((n, x) => n + x, 0);

/**
 * What the workspace's files hold: counted (live files once per workspace, pinned versions) and kept (the trash and
 * replaced versions, not counted). `cap`: the most the safety net may hold (a quarter of the plan), when known.
 */
export function filesUsage(cap: number | null = null): FilesUsage {
  const areas = listAreas();
  const counted = countedHashes(areas);
  const { kept, items } = keptHashes(areas, counted);
  return { files: liveCount(areas), bytes: total(counted), kept: total(kept), kept_files: items, kept_cap: cap };
}

/** What the purge did. */
export interface Purged {
  trash: number;
  versions: number;
  blobs: number;
}

/** A thing the safety net keeps, for the purge: when it went there, its bytes, and how to take it out. */
interface KeptItem {
  at: number;
  hash: string;
  size: number;
  drop: () => void;
}

/**
 * The purge, in the workspace running now: what was trashed or replaced 30 days ago goes (pinned versions stay), then,
 * when the safety net still holds more than `cap` bytes, the oldest of it, early; then every blob nothing names any more
 * and that is older than a day (FILE_LIMITS.graceHours) is removed from the storage. A catalog that can't be read stops
 * it before anything is removed (FilesUnreadableError).
 */
export async function purgeFiles({ now = Date.now(), cap = null }: { now?: number; cap?: number | null } = {}): Promise<Purged> {
  const out: Purged = { trash: 0, versions: 0, blobs: 0 };
  const old = (iso: string | undefined) => !!iso && now - Date.parse(iso) > keptMs;
  const doomed = withFilesLock(() => {
    const areas = listAreas().map((x) => areaForWrite(x.id) as FileArea);
    const lines = new Map<FileArea, FileChange[]>();
    const changed = (a: FileArea) => {
      if (!lines.has(a)) lines.set(a, []);
      return lines.get(a) as FileChange[];
    };
    const at = isoLocal();
    const purged = (a: FileArea, x: { id: string; path: string; via?: FileVersion['via'] }, dir = false): FileChange => ({
      rev: a.rev,
      at,
      op: 'purge',
      id: x.id,
      path: x.path,
      by: 'purge',
      ...(dir ? { dir: true as const } : {}),
    });
    const items: KeptItem[] = [];
    for (const a of areas) {
      for (const e of [...a.files, ...a.trash]) {
        const before = e.older?.length ?? 0;
        if (!before) continue;
        e.older = (e.older ?? []).filter((x) => x.pinned?.length || !old(x.replaced));
        if (e.older.length !== before) {
          out.versions += before - e.older.length;
          changed(a);
        }
        if (!e.older.length) delete e.older;
      }
      const expired = a.trash.filter((t) => old(t.trashed_at));
      const expiredDirs = (a.trash_dirs ?? []).filter((d) => old(d.trashed_at));
      if (expired.length || expiredDirs.length) {
        a.rev++;
        a.trash = a.trash.filter((t) => !old(t.trashed_at));
        a.trash_dirs = (a.trash_dirs ?? []).filter((d) => !old(d.trashed_at));
        out.trash += expired.length;
        changed(a).push(...expired.map((t) => purged(a, t)), ...expiredDirs.map((d) => purged(a, d, true)));
      }
      // what stays in the safety net, for when it holds too much (the oldest go first)
      for (const e of a.files)
        for (const x of e.older ?? [])
          if (!x.pinned?.length)
            items.push({
              at: Date.parse(x.replaced ?? x.at),
              hash: x.hash,
              size: x.size,
              drop: () => {
                e.older = (e.older ?? []).filter((y) => y !== x);
                if (!e.older.length) delete e.older;
                out.versions++;
                changed(a);
              },
            });
      for (const t of a.trash)
        items.push({
          at: Date.parse(t.trashed_at),
          hash: t.hash,
          size: t.size,
          drop: () => {
            if (!a.trash.includes(t)) return;
            a.trash = a.trash.filter((y) => y !== t);
            a.rev++;
            out.trash++;
            changed(a).push(purged(a, t));
          },
        });
    }
    if (cap !== null && cap >= 0) {
      const counted = countedHashes(areas);
      const refs = new Map<string, number>();
      for (const it of items) if (!counted.has(it.hash)) refs.set(it.hash, (refs.get(it.hash) ?? 0) + 1);
      let kept = total(keptHashes(areas, counted).kept);
      for (const it of items.sort((x, y) => x.at - y.at)) {
        if (kept <= cap) break;
        it.drop();
        if (counted.has(it.hash)) continue;
        const left = (refs.get(it.hash) ?? 1) - 1;
        refs.set(it.hash, left);
        if (!left) kept -= it.size;
      }
    }
    for (const [a, changes] of lines) saveArea(a, changes);
    // the sweep: blobs no catalog names (live, older, trashed), past the grace; marked gone before their bytes go
    const named = new Set<string>();
    for (const a of areas)
      for (const e of [...a.files, ...a.trash]) {
        named.add(e.hash);
        for (const x of e.older ?? []) named.add(x.hash);
      }
    const grace = FILE_LIMITS.graceHours * 3600_000;
    const doomed: string[] = [];
    let shards: string[] = [];
    try {
      shards = fs.readdirSync(blobsDir()).filter((n) => /^[0-9a-f]{2}\.json$/.test(n));
    } catch {}
    for (const name of shards) {
      const first = `${name.slice(0, 2)}${'0'.repeat(62)}`;
      const shard = readShard(first);
      let marked = false;
      for (const [h, b] of Object.entries(shard)) {
        if (named.has(h)) continue;
        if (!b.gone && now - Date.parse(b.at) <= grace) continue;
        b.gone = true;
        marked = true;
        doomed.push(h);
      }
      if (marked) writeShard(first, shard);
    }
    return doomed;
  });
  for (const h of doomed) {
    try {
      await filesStorage().remove(blobKey(h));
      withFilesLock(() => {
        const shard = readShard(h);
        if (shard[h]?.gone) {
          delete shard[h];
          writeShard(h, shard);
        }
      });
      out.blobs++;
    } catch (e) {
      // marked gone still: the next purge tries again; an upload of the same bytes waits for it (503, try again)
      console.error(`files: a blob's bytes weren't removed (${(e as Error).message})`);
    }
  }
  return out;
}

/** Every live file's and kept version's bytes in the workspace (the deletion's plan). */
export function filesHeld(): { count: number; bytes: number } {
  const u = filesUsage();
  return { count: u.files, bytes: u.bytes + u.kept };
}

/** The blob of `hash` when the workspace holds it now: a download checks it, and serves its type. */
export function heldBlob(hash: string): { size: number; type: string } | null {
  if (!SHA256.test(hash)) return null;
  const b = storedBlob(hash);
  return b ? { size: b.size, type: b.type } : null;
}
