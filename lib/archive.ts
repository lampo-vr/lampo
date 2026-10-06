// "Download all": the newest version of every video in a folder and its subfolders as one zip (lib/zip.ts), for a
// review link or for the team. Entries are named `<folder>/<subfolders>/<name>_v<N>.<ext>`, safe on every file system.
// CRC-32s are cached per file under cache/crc/, computed in the background: once all are known the archive is
// deterministic, so a download that breaks off (phones!) resumes with a range request instead of starting over.
// With remote storage the entries stream straight from the store in ranges, not through the working copies.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { heavy, PRIORITY, QueueFullError } from './jobs.ts';
import { cacheDir, slugify } from './paths.ts';
import { wsKey } from './scope.ts';
import { storage } from './storage/index.ts';
import * as store from './store.ts';
import type { Review, Version } from './types.ts';
import { planZip, type ZipEntry, type ZipPlan } from './zip.ts';

export type ArchiveKind = 'preview' | 'original';

/** Where an entry's bytes live: a storage key, and the local file when there is one on this disk. */
export interface ArchiveSource {
  key: string;
  file: string | null;
}

export interface ArchiveItem {
  review: Review;
  ver: Version;
  /** Path inside the zip. */
  name: string;
  src: ArchiveSource;
  kind: ArchiveKind;
}

export interface ArchiveListing {
  items: ArchiveItem[];
  /** File names whose preview copy is still being made. */
  preparing: string[];
  /** File names whose bytes are gone. */
  missing: string[];
}

// Windows device names, with or without an extension (COM¹–³ and LPT¹–³ count too).
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[\d¹²³]|lpt[\d¹²³])(\..*)?$/i;
// A whole entry name stays under Windows' 260-character path limit with room for the folder it is unpacked into.
const MAX_ENTRY = 200;
const trimEnds = (s: string) => s.trim().replace(/^[. ]+|[. ]+$/g, '');

/**
 * One path segment, safe to unpack anywhere: no separators, control or invisible formatting characters (bidi
 * overrides that make "gnp.exe" read backwards, zero-width joiners), dot names or Windows device names.
 */
export function safeSegment(raw: string, fallback = '_', max = 120): string {
  const cleaned = trimEnds(
    raw
      .normalize('NFC')
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' '),
  );
  // Cutting can leave a trailing dot or space, which Windows drops (two names would then collide).
  const cut = trimEnds([...cleaned].slice(0, max).join(''));
  if (!cut) return fallback;
  return RESERVED.test(cut) ? `_${cut}` : cut;
}

/** `<top>/<folders…>/<base>_v<N><ext>`: every segment safe, the extension plain, the whole name short enough. */
export function entryName(top: string, folders: string[], base: string, v: number, ext: string): string {
  const cleanExt = /^\.[a-z0-9]{1,8}$/i.test(ext) ? ext.toLowerCase() : '.mp4';
  const file = `${safeSegment(base, 'video', 100)}_v${v}${cleanExt}`;
  const dirs = [safeSegment(top, 'Review', 60), ...folders.map((s) => safeSegment(s))];
  // Deep folder trees: shorten the folders (never the file), evenly, down to 12 characters each.
  let each = 120;
  while (each > 12 && [...dirs, file].join('/').length > MAX_ENTRY) {
    each -= 4;
    for (let i = 1; i < dirs.length; i++) dirs[i] = safeSegment(dirs[i] as string, '_', each);
  }
  return [...dirs, file].join('/');
}

/** Same names (ignoring case, as macOS and Windows do) get " (2)", " (3)" before their extension. */
export function dedupe(names: string[]): string[] {
  const seen = new Set<string>();
  return names.map((n) => {
    const ext = path.posix.extname(n);
    const stem = n.slice(0, n.length - ext.length);
    let candidate = n;
    for (let i = 2; seen.has(candidate.toLowerCase()); i++) candidate = `${stem} (${i})${ext}`;
    seen.add(candidate.toLowerCase());
    return candidate;
  });
}

const leaf = (folder: string) => folder.split('/').filter(Boolean).pop() || 'Review';

/**
 * What goes into the zip of `root` (a folder path): the newest version of each review, in folders relative to root.
 * `preview` answers a version's preview copy (never its own bytes), or null while it is still being made.
 */
export function archiveItems(
  reviews: Review[],
  { root, kind, preview }: { root: string; kind: ArchiveKind; preview: (review: Review, ver: Version) => ArchiveSource | null },
): ArchiveListing {
  const items: Omit<ArchiveItem, 'name'>[] = [];
  const names: string[] = [];
  const preparing: string[] = [];
  const missing: string[] = [];
  const top = leaf(root);
  const sorted = [...reviews].sort((a, b) => (a.folder || '').localeCompare(b.folder || '') || path.basename(a.video).localeCompare(path.basename(b.video)));
  for (const review of sorted) {
    const ver = review.versions.at(-1);
    if (!ver) continue;
    const file = path.basename(review.video);
    if (!store.versionAvailable(review, ver.v)) {
      missing.push(file);
      continue;
    }
    let src: ArchiveSource;
    let ext: string;
    if (kind === 'original') {
      ext = path.extname(review.video) || '.mp4';
      src = { key: store.versionKey(slugify(review.video), ver.v, path.extname(review.video)), file: store.versionFile(review, ver.v) };
    } else {
      const p = preview(review, ver);
      if (!p) {
        preparing.push(file);
        continue;
      }
      src = p;
      ext = path.extname(p.key) || '.mp4';
    }
    const folder = review.folder || '';
    const rel = folder === root ? [] : folder.startsWith(`${root}/`) ? folder.slice(root.length + 1).split('/') : [];
    names.push(entryName(top, rel, path.basename(review.video, path.extname(review.video)), ver.v, ext));
    items.push({ review, ver, src, kind });
  }
  const unique = dedupe(names);
  return { items: items.map((it, i) => ({ ...it, name: unique[i] })), preparing, missing };
}

/** The bytes as a file on this disk (remote stores fetch a working copy), or null when they are gone. */
async function localFile(item: ArchiveItem): Promise<string | null> {
  if (item.kind === 'original') return store.ensureVersionFile(item.review, item.ver.v);
  return item.src.file && fs.existsSync(item.src.file) ? item.src.file : storage().ensureLocal(item.src.key);
}

/** An entry's bytes as the archive sees them: size, where to read them, and the id its CRC is cached under. */
interface EntrySource {
  size: number;
  crcId: string;
  read(start: number, end: number): AsyncIterable<Buffer>;
}

/**
 * Where an entry reads from, known without downloading anything; null when that isn't possible (then the bytes are
 * fetched first). Objects in remote storage are streamed from it in ranges, never pulled through the working copies,
 * and never change under their key (renders by version, playback copies by renderKey): their CRC id is key + size, so it
 * survives a working copy being evicted and fetched again. Files on this disk keep the mtime in the id, because a
 * render tracked at its own path can change in place.
 */
function sourceOf(item: ArchiveItem): EntrySource | null {
  const s = storage();
  const render = item.src.key.startsWith('versions/');
  if (s.kind !== 'local' && (!render || item.ver.stored)) {
    const size = s.size(item.src.key) ?? (render ? item.ver.size : null);
    if (size === null) return null;
    return { size, crcId: `${item.src.key}|${size}`, read: (start, end) => s.read(item.src.key, start, end) };
  }
  const file = item.src.file && fs.existsSync(item.src.file) ? item.src.file : null;
  if (!file) return null;
  const st = fs.statSync(file);
  return {
    size: st.size,
    crcId: `${item.src.key}|${st.size}|${Math.round(st.mtimeMs)}`,
    read: (start, end) => fs.createReadStream(file, { start, end, highWaterMark: 1 << 20 }),
  };
}

// ---------------------------------------------------------------- CRC cache

const crcFile = (id: string) => path.join(cacheDir(), 'crc', `${crypto.createHash('sha1').update(id).digest('hex')}.json`);

function cachedCrc(src: EntrySource): number | null {
  try {
    const hit = JSON.parse(fs.readFileSync(crcFile(src.crcId), 'utf8')) as { crc?: unknown };
    return typeof hit.crc === 'number' ? hit.crc : null;
  } catch {
    return null;
  }
}

async function computeCrc(src: EntrySource): Promise<number> {
  let crc = 0;
  if (src.size > 0) for await (const chunk of src.read(0, src.size - 1)) crc = zlib.crc32(chunk, crc);
  const out = crcFile(src.crcId);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(`${out}.tmp`, JSON.stringify({ crc, size: src.size }));
  fs.renameSync(`${out}.tmp`, out);
  return crc;
}

const pending = new Set<string>();

/** Computes an entry's CRC in the background (lowest priority of the heavy jobs), once. */
function scheduleCrc(src: EntrySource): void {
  const key = wsKey(src.crcId);
  if (pending.has(key) || cachedCrc(src) !== null) return;
  pending.add(key);
  heavy(() => computeCrc(src), PRIORITY.crc)
    // a full queue (said once in the log) only means the next download doesn't resume yet: asked again then
    .catch((e: Error) => e instanceof QueueFullError || console.error('crc failed', e.message))
    .finally(() => pending.delete(key));
}

/** Every CRC is known: the archive is deterministic and a broken-off download resumes. */
export function isResumable(listing: ArchiveListing): boolean {
  return listing.items.every((it) => {
    const src = sourceOf(it);
    return !!src && cachedCrc(src) !== null;
  });
}

/** Makes sure every file of a listing gets its CRC, so the next download of it can resume. */
export function prepareCrcs(listing: ArchiveListing): void {
  for (const item of listing.items) {
    const src = sourceOf(item);
    if (src) scheduleCrc(src);
  }
}

// ---------------------------------------------------------------- the archive

export interface Archive {
  plan: ZipPlan;
  /** Strong validator for ranges; null while the archive streams (not every CRC is known yet). */
  etag: string | null;
  files: number;
  bytes: number;
}

export async function buildArchive(listing: ArchiveListing): Promise<Archive> {
  const entries: ZipEntry[] = [];
  const id = crypto.createHash('sha1');
  let bytes = 0;
  for (const item of listing.items) {
    let src = sourceOf(item);
    if (!src) {
      const file = await localFile(item);
      src = file ? sourceOf({ ...item, src: { ...item.src, file } }) : null;
    }
    if (!src) throw Object.assign(new Error(`the bytes of ${path.basename(item.review.video)} are gone`), { status: 410 });
    const crc = cachedCrc(src);
    if (crc === null) scheduleCrc(src);
    const mtime = new Date(item.ver.registered);
    entries.push({ name: item.name, size: src.size, crc, mtime, read: src.read });
    id.update(`${item.name}\0${src.size}\0${crc}\0${mtime.getTime()}\n`);
    bytes += src.size;
  }
  const plan = planZip(entries);
  return { plan, etag: plan.deterministic ? `"z-${id.digest('hex').slice(0, 24)}"` : null, files: entries.length, bytes };
}

/**
 * What a listing holds, in 22 characters: every entry's name and the stored file behind it (a version, a playback copy).
 * A zip URL handed out for a listing seals it (server/routes/downloads.ts), so the zip it serves is the folder as it was
 * asked for, never one that grew since (a render added after the asker lost access).
 */
export function listingPin(listing: ArchiveListing): string {
  const h = crypto.createHash('sha256');
  for (const it of listing.items) h.update(`${it.name}\0${it.src.key}\n`);
  return h.digest('base64url').slice(0, 22);
}

/** Size of a listing without touching remote storage (entries whose size isn't known yet count as 0). */
export function listingBytes(listing: ArchiveListing): number {
  return listing.items.reduce((n, it) => n + (sourceOf(it)?.size ?? 0), 0);
}

/** "Reels – 2026-09-28.zip" */
export function archiveName(folder: string, now = new Date()): string {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `${safeSegment(leaf(folder), 'Review')} – ${day}.zip`;
}
