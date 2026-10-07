// Project files' rules that the server, the CLI and the browser share (lib/files.ts keeps the files; docs/files.md):
// the limits, what a path inside an area may be, what is junk, what kind a file is, and the name a copy gets.
// Browser-safe: no Node imports.
import { wellFormed } from './names.ts';
import type { FileKind } from './types.ts';

export const FILE_LIMITS = {
  /** Bytes of one file. */
  fileBytes: 250e9,
  /** Live files in one area, and in one workspace (all areas). */
  perArea: 20_000,
  perWorkspace: 200_000,
  /** A path inside an area: bytes (UTF-8) in all, bytes per name, names deep. */
  pathBytes: 1024,
  nameBytes: 255,
  depth: 32,
  /** Files named in one push (an upload's or a commit's request). */
  batch: 1000,
  /** Hashes in one "which are missing?" question. */
  hashes: 5000,
  /** Download URLs asked for at once. */
  urls: 100,
  /** A page of a listing: by default, and at most. */
  page: 200,
  pageMax: 1000,
  /** Days the trash and replaced versions are kept. */
  keptDays: 30,
  /** The share of the plan's storage the safety net (trash and replaced versions) may hold before the oldest go early. */
  keptShare: 0.25,
  /**
   * Without a plan that says (a server without plans, or one whose plan doesn't): the safety net holds at most as much as
   * the workspace's files count, and never less than this — so it is bounded whatever a plan says.
   */
  keptFloor: 5e9,
  /**
   * Older versions one file keeps besides the ones pinned: a day of an agent pushing a new version every hour or two,
   * a week of a person's saves. Past it the oldest goes early; each kept version is a line in its area's catalog,
   * read and written whole on every change.
   */
  versions: 10,
  /** Hours bytes a file stopped naming (purged, its last version dropped) are kept when a push just asked for them. */
  touchHours: 1,
  /**
   * Hours what went into the safety net (a file trashed, a version replaced) is never taken early, whatever the cap:
   * while such things hold the net over its cap, the excess counts toward the plan instead.
   */
  protectHours: 24,
  /** Hours bytes nothing names yet are kept (an upload committing now is never swept). */
  graceHours: 24,
  /** Changes of a file's journal its history shows. */
  history: 200,
} as const;

/** Every kind a file can be (FileKind), for filters. */
export const FILE_KINDS: readonly FileKind[] = ['footage', 'audio', 'image', 'graphic', 'font', 'project', 'document', 'archive', 'other'];

/**
 * Types a file may be shown as in the app (a preview, served inline): pictures a browser draws itself, video, sound,
 * PDF and plain text. Never SVG or HTML (they can run script): those, and anything else, only ever download.
 */
export const inlineType = (type: string): boolean =>
  /^(image\/(jpeg|png|gif|webp|avif)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf|text\/plain)$/.test(type);

/** A path someone named that can't be a file's place in an area (400, with the sentence). */
export class FilePathError extends Error {
  status = 400;
}

const BYTES = new TextEncoder();
const byteLength = (s: string): number => BYTES.encode(s).length;

// Controls and line breaks (a name reaches agents on one line), and the bidi controls that make a name read as another.
const UNFIT = /[\p{Cc}\p{Zl}\p{Zp}؜‎‏‪-‮⁦-⁩]/u;

const UNFIT_ALL = new RegExp(UNFIT.source, 'gu');

/** Names a file system or a tool leaves behind, never material: skipped by every way in, refused by the server. */
const JUNK_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized']);
const JUNK_DIRS = new Set(['.git', '__MACOSX', 'node_modules', '.Spotlight-V100', '.Trashes', '.fseventsd', '.lampo']);

/** True for a path the ways in skip (`.DS_Store`, `._A001.mov`, anything under `.git/` or `__MACOSX/` …). */
export function isJunkPath(path: string): boolean {
  const names = path.split('/');
  const last = names.at(-1) ?? '';
  return JUNK_NAMES.has(last) || last.startsWith('._') || names.slice(0, -1).some((n) => JUNK_DIRS.has(n));
}

/** Why `raw` can't be a path inside an area, or null when it can (as `cleanFilePath` keeps it). */
export function filePathProblem(raw: unknown): string | null {
  try {
    cleanFilePath(raw);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * A path inside an area as it is kept: the names as uploaded — a project's relative links must still work after a
 * pull — so nothing is rewritten but the Unicode form (NFC: a Mac's NFD names read the same everywhere) and a lone
 * surrogate (U+FFFD, as on the disk). Refused (FilePathError), never cut or changed to fit: empty, absolute, a
 * backslash, an empty, `.` or `..` name, a control character, a line break or a bidi control, a name that starts or
 * ends with a space, past FILE_LIMITS (1,024 bytes, 255 a name, 32 deep), and junk (`isJunkPath`).
 */
export function cleanFilePath(raw: unknown): string {
  if (typeof raw !== 'string') throw new FilePathError('a file needs a path');
  const p = wellFormed(raw).normalize('NFC');
  if (!p) throw new FilePathError('a file needs a path');
  if (p.startsWith('/')) throw new FilePathError('a path inside the files starts with a name, not "/"');
  if (p.includes('\\')) throw new FilePathError('a path is separated by "/" (no "\\")');
  if (UNFIT.test(p)) throw new FilePathError('a path can’t hold control characters, line breaks or direction marks');
  if (byteLength(p) > FILE_LIMITS.pathBytes) throw new FilePathError(`a path can be at most ${FILE_LIMITS.pathBytes} bytes`);
  const names = p.split('/');
  if (names.length > FILE_LIMITS.depth) throw new FilePathError(`a path can be at most ${FILE_LIMITS.depth} names deep`);
  for (const n of names) {
    if (!n) throw new FilePathError('a path has no empty names ("//", or "/" at its end)');
    if (n === '.' || n === '..') throw new FilePathError('a path has no "." or ".." in it');
    if (n !== n.trim()) throw new FilePathError('a name in a path doesn’t start or end with a space');
    if (byteLength(n) > FILE_LIMITS.nameBytes) throw new FilePathError(`a name in a path can be at most ${FILE_LIMITS.nameBytes} bytes`);
  }
  if (isJunkPath(p)) throw new FilePathError(`"${names.at(-1)}" is left out: it is a file system’s or a tool’s, not material`);
  return p;
}

/** The same path for a file system that ignores case (macOS, Windows): two paths that meet there can't both be kept. */
export const caseKey = (path: string): string => path.normalize('NFC').toLowerCase();

/** The folder part of a path ('' at the top) and its last name. */
export const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));
export const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** "spot.aep" → "spot", ".aep"; "Makefile" → "Makefile", "". A leading dot isn't an extension. */
function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
}

/**
 * Where a copy of `path` goes beside it ("spot.aep" → "spot (Alex).aep", then "spot (Alex 2).aep"), the first of those
 * `taken` says is free. `label`: whose it is (an agent's or a person's name), one line, short.
 */
export function copyPath(path: string, label: string, taken: (p: string) => boolean): string {
  const dir = dirOf(path);
  const [stem, ext] = splitExt(nameOf(path));
  const who = [...label.replace(/[/\\]/g, ' ').replace(UNFIT_ALL, ' ').replace(/\s+/g, ' ').trim()].slice(0, 40).join('').trim() || 'copy';
  for (let i = 1; ; i++) {
    const name = `${stem} (${i === 1 ? who : `${who} ${i}`})${ext}`;
    const p = dir ? `${dir}/${name}` : name;
    if (!taken(caseKey(p))) return p;
  }
}

const EXT_KINDS: [FileKind, string[]][] = [
  [
    'project',
    [
      'aep',
      'aepx',
      'aet',
      'prproj',
      'drp',
      'drt',
      'fcpxml',
      'fcpbundle',
      'blend',
      'c4d',
      'psd',
      'psb',
      'indd',
      'rpp',
      'mogrt',
      'motn',
      'veg',
      'kdenlive',
      'nk',
      'hip',
      'ma',
      'mb',
      'max',
      'als',
      'logicx',
      'ptx',
      'sesx',
      'aup3',
      'fig',
      'sketch',
      'xd',
      'riv',
    ],
  ],
  ['footage', ['mov', 'mp4', 'm4v', 'mxf', 'avi', 'mkv', 'webm', 'mts', 'm2ts', 'braw', 'r3d', 'ari', 'crm', 'mpg', 'mpeg', 'wmv', '3gp', 'insv', 'lrv']],
  ['audio', ['wav', 'aif', 'aiff', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'bwf', 'wma', 'caf', 'mid', 'midi']],
  [
    'image',
    ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'tif', 'tiff', 'bmp', 'exr', 'dpx', 'tga', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'hdr'],
  ],
  ['graphic', ['svg', 'ai', 'eps', 'lottie', 'cube', '3dl', 'look', 'lut']],
  ['font', ['ttf', 'otf', 'woff', 'woff2', 'ttc', 'otc', 'dfont']],
  [
    'document',
    [
      'pdf',
      'txt',
      'md',
      'rtf',
      'doc',
      'docx',
      'odt',
      'pages',
      'csv',
      'tsv',
      'xls',
      'xlsx',
      'numbers',
      'ppt',
      'pptx',
      'key',
      'srt',
      'vtt',
      'ass',
      'ssa',
      'json',
      'xml',
      'yaml',
      'yml',
      'html',
    ],
  ],
  ['archive', ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'dmg', 'iso']],
];
const KIND_OF_EXT = new Map<string, FileKind>(EXT_KINDS.flatMap(([kind, exts]) => exts.map((e) => [e, kind] as [string, FileKind])));

/**
 * What a file is: a project file by its extension (an After Effects project is a zip or a binary to its bytes), else
 * what its bytes say (`type`, from magic numbers: lib/files.ts), else its extension, else `other`.
 */
export function kindOf(path: string, type = ''): FileKind {
  const ext = splitExt(nameOf(path))[1].slice(1).toLowerCase();
  const byExt = KIND_OF_EXT.get(ext);
  if (byExt === 'project') return 'project';
  if (type === 'image/svg+xml') return 'graphic';
  if (type.startsWith('video/')) return 'footage';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('image/')) return byExt === 'graphic' ? 'graphic' : 'image';
  if (type.startsWith('font/')) return 'font';
  if (type === 'application/pdf') return 'document';
  if (/^application\/(zip|gzip|x-7z-compressed|vnd\.rar|x-xz|x-bzip2|x-tar)$/.test(type)) return byExt ?? 'archive';
  return byExt ?? (type.startsWith('text/') ? 'document' : 'other');
}

/** Byte counts as people read them: "4.2 GB", "48 MB", "12 KB", "0 B" (decimal, like a Mac's Finder). */
export function fileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1000;
  let u = 0;
  while (n >= 1000 && u < units.length - 1) {
    n /= 1000;
    u++;
  }
  return `${n >= 100 ? Math.round(n) : n.toFixed(1).replace(/\.0$/, '')} ${units[u]}`;
}
