// `lampo files pull`, `push` and `status` (docs/files.md "Agents"): an agent works from the same footage, music, fonts
// and project files as its team, on any machine, and saves what it makes back as versions of their own. The disk side
// — what may be written where, what a push reads — is lib/filesLocal.ts; the store or server, lib/backend/.
//
// A pull writes only below the folder it is given, only what the area names, and never over a file that changed here
// or that Lampo didn't write (unless `force`); it remembers what it wrote (`.lampo/files.json`) so a status knows what
// changed on either side, and a push knows which version each file was based on. A pull run again fetches only what
// changed, and goes on with a file it broke off (its part waits beside it).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Backend, FileSource, PushFileInput } from './backend/types.ts';
import { FilesConflict, StoppedError } from './backend/types.ts';
import { globMatcher, isExactPattern } from './fileGlob.ts';
import {
  contentsOf,
  findRecord,
  gatherPush,
  type HashCache,
  hashOf,
  LandingError,
  type LeftOut,
  type LocalFile,
  landingFor,
  landingProblem,
  landingRoot,
  openPart,
  type PulledFile,
  type PullRecord,
  partFile,
  placeFile,
  pulledEntry,
  readRecord,
  writeRecord,
} from './filesLocal.ts';
import { caseKey, cleanFilePath, FILE_LIMITS } from './fileText.ts';
import { folderName } from './folders.ts';
import type { FileConflict, FileInfo } from './types.ts';

/** How agents name the workspace's own files: `House` (exactly). A project that is called so is `House/`. */
export const HOUSE_WORD = 'House';

/** The area an agent names ('' = the House): `House` or nothing is the House, anything else a folder's path. */
export const areaOf = (arg: string | undefined | null): string => (!arg || arg === HOUSE_WORD ? '' : (folderName(arg) ?? ''));

/** A word for a shell, quoted when it needs to be: in single quotes, where nothing is special (as web/src/files/model.ts). */
export const shellWord = (w: string): string => (/^[\w./@:+-]+$/.test(w) ? w : `'${w.replaceAll("'", "'\\''")}'`);

/** An area as a command names it, one shell word: `House`, a folder's path (`House/` for a project called so). */
export const areaWord = (area: string): string => shellWord(area ? (area === HOUSE_WORD ? `${area}/` : area) : HOUSE_WORD);

/** Which store files come from, the same however its account is named: what a record of pulls belongs to. */
export const storeOf = (b: Pick<Backend, 'where'>): string => b.where.replace(/ \(as [^)]*\)$/, '');

/** Every file that applies in a folder (or only its own), page after page. */
export async function allFiles(b: Backend, area: string, { own = false }: { own?: boolean } = {}): Promise<FileInfo[]> {
  const out: FileInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await b.listFiles(area, { deep: true, own, limit: FILE_LIMITS.pageMax, ...(cursor ? { cursor } : {}) });
    out.push(...page.files);
    cursor = page.cursor;
  } while (cursor);
  return out;
}

/** Bytes free where a folder is (null: can't tell). */
function freeAt(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** The room a pull leaves on the disk it fills: a gigabyte or 2 %, whichever is more. */
const reserveOf = (free: number) => Math.max(1e9, free * 0.02);

/** A pull whose bytes don't fit on the disk it writes to: nothing was fetched (its result says what it needed). */
export class RoomError extends Error {
  result: PullResult;
  constructor(result: PullResult) {
    super('not enough room on this disk');
    this.result = result;
  }
}

// ---------------------------------------------------------------- pull

export interface PullOptions {
  area: string;
  /** Paths and globs inside the area (lib/fileGlob.ts); none: every file that applies there. */
  patterns: string[];
  to: string;
  /** Replace files here that changed, or that Lampo didn't write. */
  force?: boolean;
  /** Say what it would fetch, fetch nothing. */
  dryRun?: boolean;
  hashes: HashCache;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  /** On Windows' rules for names (tests). */
  win?: boolean;
}

export interface PullResult {
  area: string;
  to: string;
  /** The files that applied and were asked for, and their bytes. */
  files: number;
  bytes: number;
  fetched: { path: string; v: number; size: number }[];
  /** Already here with the same bytes. */
  here: number;
  /** Left as they are: names this side won't write, a link or a folder in the way, two names that meet, a file changed here. */
  refused: { path: string; why: string }[];
  /** Names starting with a dot, left out because no pattern named them exactly. */
  hidden: string[];
  /** Patterns that matched nothing. */
  unmatched: string[];
  /** Bytes that didn't come (the rest came). */
  failed: { path: string; why: string }[];
  /** Bytes it would fetch, and what the disk has (dry run, or a pull refused for room). */
  needed: number;
  free: number | null;
  stopped?: boolean;
}

/** A name of a path that starts with a dot: pulled only when a pattern names it exactly, as a push sends one. */
function hiddenOk(p: string, pattern: string | undefined): boolean {
  const names = p.split('/');
  const hidden = names.findLastIndex((n) => n.startsWith('.'));
  if (hidden < 0) return true;
  if (pattern === undefined || !isExactPattern(pattern)) return false;
  return (
    pattern
      .replace(/^(\.\/)+/, '')
      .replace(/\/+$/, '')
      .split('/').length > hidden
  );
}

/** The files of an area a pull names, refused or left out, before anything is written. */
function pickFiles(all: FileInfo[], o: PullOptions) {
  const matcher = globMatcher(o.patterns);
  const used = new Set<number>();
  const refused: PullResult['refused'] = [];
  const hidden: string[] = [];
  const picked: FileInfo[] = [];
  // what is taken, by the path a disk that ignores case sees: a file's, and the folders it is in
  const files = new Map<string, string>();
  const dirs = new Map<string, string>();
  // deepest area first (the listing's order): where two names meet, the one that applies here wins
  for (const f of all) {
    let pattern: string | undefined;
    if (o.patterns.length) {
      const i = matcher.match(f.path);
      if (i < 0) continue;
      used.add(i);
      pattern = o.patterns[i];
    }
    // a name that can't land is said as such first, whatever else it is (`../x` is no hidden file)
    const why = landingProblem(f.path, o.win === undefined ? {} : { win: o.win });
    if (why) {
      refused.push({ path: f.path, why });
      continue;
    }
    if (!hiddenOk(f.path, pattern)) {
      hidden.push(f.path);
      continue;
    }
    const key = caseKey(f.path);
    const names = f.path.split('/');
    const above = names.slice(0, -1).map((_, i) => names.slice(0, i + 1).join('/'));
    const meets = files.get(key) ?? dirs.get(key) ?? above.map((a) => files.get(caseKey(a))).find((x) => x !== undefined);
    if (meets !== undefined) {
      refused.push({ path: f.path, why: `meets ${meets} on a disk that ignores case (only that one is pulled)` });
      continue;
    }
    files.set(key, f.path);
    for (const a of above) if (!dirs.has(caseKey(a))) dirs.set(caseKey(a), `${a}/`);
    picked.push(f);
  }
  const unmatched = o.patterns.filter((_, i) => !used.has(i));
  return { picked, refused, hidden, unmatched };
}

/** Is the file at `target` the bytes of `f` already, unchanged since a pull, or neither (Lampo didn't write these)? */
async function localState(target: string, f: FileInfo, was: PulledFile | undefined, hashes: HashCache): Promise<'none' | 'same' | 'ours' | 'theirs'> {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(target);
  } catch {
    return 'none';
  }
  if (was && st.size === was.size && st.mtimeMs === was.mtime) return was.sha256 === f.sha256 ? 'same' : 'ours';
  if (st.size !== f.size && !was) return 'theirs';
  const sha = await hashes.sha256({ abs: target, size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino });
  if (sha === f.sha256) return 'same';
  return was && sha === was.sha256 ? 'ours' : 'theirs';
}

export async function pull(b: Backend, o: PullOptions): Promise<PullResult> {
  const store = storeOf(b);
  const all = await allFiles(b, o.area);
  const { picked, refused, hidden, unmatched } = pickFiles(all, o);
  const out: PullResult = {
    area: o.area,
    to: o.to,
    files: picked.length,
    bytes: picked.reduce((n, f) => n + f.size, 0),
    fetched: [],
    here: 0,
    refused,
    hidden,
    unmatched,
    failed: [],
    needed: 0,
    free: null,
  };
  if (!picked.length) return out;
  const root = o.dryRun && !fs.existsSync(o.to) ? path.resolve(o.to) : landingRoot(o.to);
  const record: PullRecord = readRecord(root, store);
  const wanted: { f: FileInfo; target: string }[] = [];
  for (const f of picked) {
    let target: string;
    try {
      target = o.dryRun && !fs.existsSync(root) ? path.join(root, ...f.path.split('/')) : landingFor(root, f.path, { make: !o.dryRun });
    } catch (e) {
      if (!(e instanceof LandingError)) throw e;
      refused.push({ path: f.path, why: e.message });
      continue;
    }
    const was = record.files[f.path];
    const state = await localState(target, f, was, o.hashes);
    if (state === 'same') {
      out.here++;
      if (!o.dryRun && (!was || was.sha256 !== f.sha256 || was.v !== f.v)) record.files[f.path] = pulledEntry(f, o.area, target);
      continue;
    }
    if (state === 'theirs' && !o.force) {
      refused.push({
        path: f.path,
        why: was ? 'changed here since it was pulled (push it, or --force)' : 'a file Lampo didn’t write is there (--force replaces it)',
      });
      continue;
    }
    wanted.push({ f, target });
  }
  // the bytes still to come, less what parts already hold
  out.needed = wanted.reduce((n, { f, target }) => {
    let have = 0;
    try {
      have = fs.lstatSync(partFile(target, f.sha256)).size;
    } catch {}
    return n + Math.max(0, f.size - have);
  }, 0);
  out.free = freeAt(fs.existsSync(root) ? root : path.dirname(root));
  if (o.dryRun) return { ...out, fetched: wanted.map(({ f }) => ({ path: f.path, v: f.v, size: f.size })) };
  if (out.free !== null && out.needed > out.free - reserveOf(out.free))
    throw new RoomError({ ...out, fetched: wanted.map(({ f }) => ({ path: f.path, v: f.v, size: f.size })) });

  // one download per content: the same bytes at two paths come once, and are copied for the other
  const bySha = new Map<string, { f: FileInfo; target: string }[]>();
  for (const w of wanted) bySha.set(w.f.sha256, [...(bySha.get(w.f.sha256) ?? []), w]);
  const groups = [...bySha.values()];
  const total = out.needed;
  let done = 0;
  const tick = (n: number) => {
    done += n;
    o.onProgress?.(done, total);
  };
  const queue = [...groups];
  const sources = new Map<string, FileSource>();
  /** Where the next files' bytes are read from, asked for a hundred at a time as they are needed (URLs expire). */
  const sourceFor = async (id: string, again = false): Promise<FileSource | null> => {
    if (!again && sources.has(id)) return sources.get(id) as FileSource;
    const ahead = again ? [id] : [id, ...queue.slice(0, FILE_LIMITS.urls - 1).map((g) => (g[0] as { f: FileInfo }).f.id)];
    const got = await b.fileSources(ahead.filter((x, i) => i === 0 || !sources.has(x)));
    for (const s of got.sources) sources.set(s.id, s);
    return sources.get(id) ?? null;
  };
  const one = async (group: { f: FileInfo; target: string }[]) => {
    const [{ f, target }] = group as [{ f: FileInfo; target: string }];
    try {
      let src = await sourceFor(f.id);
      if (!src || src.sha256 !== f.sha256) throw new Error('it changed or went while the pull ran: pull again');
      try {
        await fetchInto(root, src, target, o.signal, tick);
      } catch (e) {
        // a URL that ran out while it waited (an hour for a token's): asked for again, once
        if (!(e as { expired?: boolean }).expired) throw e;
        src = await sourceFor(f.id, true);
        if (!src) throw new Error('it went while the pull ran');
        await fetchInto(root, src, target, o.signal, tick);
      }
      record.files[f.path] = pulledEntry(f, o.area, target);
      out.fetched.push({ path: f.path, v: f.v, size: f.size });
      for (const twin of group.slice(1)) {
        const part = partFile(twin.target, twin.f.sha256);
        fs.rmSync(part, { force: true });
        fs.copyFileSync(target, part, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
        placeFile(root, part, twin.target);
        record.files[twin.f.path] = pulledEntry(twin.f, o.area, twin.target);
        out.fetched.push({ path: twin.f.path, v: twin.f.v, size: twin.f.size });
      }
    } catch (e) {
      if (e instanceof StoppedError || o.signal?.aborted) throw new StoppedError();
      for (const x of group) out.failed.push({ path: x.f.path, why: (e as Error).message });
    }
  };
  try {
    await Promise.all(
      Array.from({ length: Math.min(3, queue.length) }, async () => {
        for (let g = queue.shift(); g; g = queue.shift()) await one(g);
      }),
    );
  } catch (e) {
    if (!(e instanceof StoppedError)) throw e;
    out.stopped = true;
  } finally {
    writeRecord(root, record);
    o.hashes.save();
  }
  return out;
}

/**
 * One file's bytes into its part beside where it lands (going on with a part a pull left), checked — its size, never a
 * byte more, and its sha256 — then moved into place. A copy of the store's own bytes on this machine; else the URL,
 * whose redirects get nothing of the headers (the token goes only where the backend said).
 */
async function fetchInto(root: string, src: FileSource, target: string, signal: AbortSignal | undefined, onBytes: (n: number) => void): Promise<void> {
  if (signal?.aborted) throw new StoppedError();
  const part = partFile(target, src.sha256);
  if (src.file) {
    const { fd } = openPart(part);
    fs.closeSync(fd);
    fs.rmSync(part);
    fs.copyFileSync(src.file, part, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    if (fs.lstatSync(part).size !== src.size) {
      fs.rmSync(part, { force: true });
      throw new Error('its bytes here are not its size');
    }
    onBytes(src.size);
    placeFile(root, part, target);
    return;
  }
  let { fd, have } = openPart(part, { resume: true });
  try {
    if (have > src.size) {
      fs.closeSync(fd);
      ({ fd, have } = openPart(part));
    }
    let hash = await hashOf(part, have);
    if (have === src.size && hash.copy().digest('hex') !== src.sha256) {
      // a whole part that isn't the file: from the start
      fs.closeSync(fd);
      ({ fd, have } = openPart(part));
      hash = crypto.createHash('sha256');
    }
    if (have < src.size) {
      let res = await follow(src.url as string, src.headers ?? {}, have ? { Range: `bytes=${have}-` } : {}, signal);
      if (res.status === 200 && have) {
        // the whole file again: what the part held goes
        fs.closeSync(fd);
        ({ fd, have } = openPart(part));
        hash = crypto.createHash('sha256');
      } else if (res.status === 206) {
        const from = Number(/^bytes (\d+)-/.exec(res.headers.get('content-range') ?? '')?.[1]);
        if (from !== have) {
          await res.body?.cancel();
          fs.closeSync(fd);
          ({ fd, have } = openPart(part));
          hash = crypto.createHash('sha256');
          res = await follow(src.url as string, src.headers ?? {}, {}, signal);
        }
      }
      if (res.status !== 200 && res.status !== 206) {
        await res.body?.cancel();
        throw Object.assign(new Error(`the server answered ${res.status}`), { expired: res.status === 403 || res.status === 410 });
      }
      let size = have;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > src.size) throw new Error('more bytes came than the file has: nothing was kept');
        hash.update(chunk);
        fs.writeSync(fd, chunk);
        onBytes(chunk.length);
      }
      have = size;
    }
    fs.closeSync(fd);
    fd = -1;
    if (have !== src.size || hash.digest('hex') !== src.sha256) {
      fs.rmSync(part, { force: true });
      throw new Error('the bytes that came are not the file’s (size or sha256): nothing was kept');
    }
    placeFile(root, part, target);
  } catch (e) {
    if (signal?.aborted) throw new StoppedError();
    // bytes that can't be the file's go; a connection that broke off leaves its part for the next pull
    if (/more bytes came/.test((e as Error).message)) fs.rmSync(part, { force: true });
    throw e;
  } finally {
    if (fd >= 0) fs.closeSync(fd);
  }
}

/** What copies out (MCP get_file on this machine) may hold in all: past it, the least recently made go. */
const COPIES_KEPT_BYTES = 20e9;

/**
 * A version of a file as a file of its own on this machine, in `dir` (a cache: `<dir>/<sha256 16>/<its name>`): the
 * store's bytes copied (a clone where the disk can), or downloaded from its URL — checked like a pull's, never written
 * through a link. A copy there with the same bytes is used again. Yours to change: the store's are never handed out.
 */
export async function copyOut(src: FileSource, dir: string, hashes: HashCache): Promise<string> {
  const name = src.path.slice(src.path.lastIndexOf('/') + 1);
  const why = landingProblem(name);
  if (why) throw new Error(`${src.path}: ${why}`);
  const root = landingRoot(path.join(dir, src.sha256.slice(0, 16)));
  const target = landingFor(root, name);
  try {
    const st = fs.lstatSync(target);
    if (st.size === src.size && (await hashes.sha256({ abs: target, size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino })) === src.sha256)
      return target;
  } catch {}
  await fetchInto(root, src, target, undefined, () => {});
  hashes.save();
  // the oldest copies go past the cap (never the one just made)
  try {
    const all = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^[0-9a-f]{16}$/.test(d.name))
      .map((d) => {
        const p = path.join(dir, d.name);
        const files = fs.readdirSync(p).map((f) => fs.lstatSync(path.join(p, f)));
        return { p, bytes: files.reduce((n, s) => n + s.size, 0), at: Math.max(0, ...files.map((s) => s.mtimeMs)) };
      })
      .sort((a, c) => c.at - a.at);
    let kept = 0;
    for (const x of all) {
      kept += x.bytes;
      if (kept > COPIES_KEPT_BYTES && x.p !== root) fs.rmSync(x.p, { recursive: true, force: true });
    }
  } catch {}
  return target;
}

/** A GET that follows up to three redirects, by hand: the headers go only to the URL they were given for. */
async function follow(url: string, headers: Record<string, string>, extra: Record<string, string>, signal?: AbortSignal): Promise<Response> {
  let at = url;
  let sent: Record<string, string> = headers;
  for (let hops = 0; ; hops++) {
    const res = await fetch(at, { headers: { ...sent, ...extra }, redirect: 'manual', ...(signal ? { signal } : {}) });
    const to = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!to) return res;
    await res.body?.cancel();
    if (hops >= 3) throw new Error('too many redirects');
    const next = new URL(to, at);
    if (next.protocol !== 'https:' && next.protocol !== 'http:') throw new Error('a redirect to something else than a web address');
    at = next.href;
    sent = {};
  }
}

// ---------------------------------------------------------------- push

export interface PushOptions {
  area: string;
  sources: string[];
  /** A folder inside the area the sources go into ('' the top). */
  into: string;
  /** A file changed since the version it is based on, or a path taken: kept beside it as a copy. */
  copy?: boolean;
  /** A path taken: the version there now is replaced (a new version; the old one is kept 30 days). */
  replace?: boolean;
  dryRun?: boolean;
  by: string;
  via?: 'vr' | 'mcp';
  hashes: HashCache;
  onHashing?: (done: number, total: number) => void;
  onProgress?: (sent: number, total: number) => void;
  onResume?: (path: string) => void;
  signal?: AbortSignal;
}

/**
 * What a file of a push is: new, the next version of the file there, a copy beside a file in the way (`copy`), the bytes
 * there already, unchanged since it was pulled, or in conflict — its path is taken, or the file changed there since the
 * version it is based on — refused before any byte moves.
 */
export type PushPlanState = 'new' | 'version' | 'copy' | 'same' | 'unchanged' | 'conflict';

export interface PushPlanned {
  path: string;
  size: number;
  sha256: string;
  state: PushPlanState;
  /** The version it replaces (a new version), or that is there (taken, same). */
  base: number | null;
  /** The file in the way (a conflict, a copy): its version now and who made it. */
  there?: FileConflict;
}

export interface PushResult {
  area: string;
  planned: PushPlanned[];
  left: LeftOut;
  /** What each file became, as the server committed it. */
  done: { path: string; id: string; v: number; state: 'added' | 'version' | 'same' | 'copy'; asked?: string }[];
  /** The area's revision after the push. */
  rev: number | null;
  sent: number;
  held: number;
  /** Refused: files changed since their base, or whose path is taken (nothing of that batch was written). */
  conflicts: FileConflict[];
  stopped?: boolean;
  /** Uploads an earlier push left unfinished that went on where they stopped. */
  resumed: string[];
}

/** Where a pushed file sits in a folder a pull wrote, and what the pull wrote there. */
function recordedAt(records: Map<string, { root: string; record: PullRecord }>, abs: string): { root: string; record: PullRecord; rel: string } | null {
  for (let dir = path.dirname(abs); ; ) {
    const hit = records.get(dir);
    if (hit) return { ...hit, rel: path.relative(dir, abs).split(path.sep).join('/') };
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export async function push(b: Backend, o: PushOptions): Promise<PushResult> {
  const into = o.into ? cleanFilePath(o.into.replace(/\/+$/, '')) : '';
  const { files, left } = gatherPush(o.sources, { into });
  const store = storeOf(b);
  // what pulls wrote where these come from: each file's base, and whether it changed since
  const records = new Map<string, { root: string; record: PullRecord }>();
  for (const src of o.sources) {
    const abs = path.resolve(src);
    const dir = fs.statSync(abs).isDirectory() && contentsOf(src) ? abs : path.dirname(abs);
    const found = findRecord(dir, store);
    if (found) records.set(found.root, found);
  }
  const total = files.reduce((n, f) => n + f.size, 0);
  let hashed = 0;
  const shas: string[] = [];
  for (const f of files) {
    if (o.signal?.aborted) throw new StoppedError();
    shas.push(
      await o.hashes.sha256(f, (n) => {
        hashed += n;
        o.onHashing?.(hashed, total);
      }),
    );
  }
  o.hashes.save();
  const own = new Map((await allFiles(b, o.area, { own: true })).map((f) => [caseKey(f.path), f]));
  const planned: PushPlanned[] = files.map((f, i) => {
    const sha256 = shas[i] as string;
    const at = recordedAt(records, f.abs);
    const was = at?.record.files[at.rel];
    const there = own.get(caseKey(f.path));
    const base = (state: PushPlanState, v: number | null): PushPlanned => ({ path: f.path, size: f.size, sha256, state, base: v });
    // as it was pulled: nothing of it is new (an inherited file's copy goes nowhere)
    if (was && was.sha256 === sha256) return base('unchanged', was.v);
    if (there && there.sha256 === sha256 && there.path === f.path) return base('same', there.v);
    if (!there) return base('new', null);
    // the version a pull wrote here, when it was this area's file at this path
    const based = was && was.area === o.area && was.id === there.id && there.path === f.path ? was.v : null;
    if (o.replace) return base('version', there.v);
    if (based === there.v) return base('version', based);
    const conflict: FileConflict = {
      path: there.path,
      id: there.id,
      v: there.v,
      base: based,
      by: there.by,
      ...(there.agent ? { agent: there.agent } : {}),
      at: there.at,
    };
    return { ...base(o.copy ? 'copy' : 'conflict', null), there: conflict };
  });
  const out: PushResult = { area: o.area, planned, left, done: [], rev: null, sent: 0, held: 0, conflicts: [], resumed: [] };
  // refused before any byte moves (the server checks again, and once more as it commits)
  const conflicts = planned.filter((p) => p.state === 'conflict');
  if (conflicts.length) {
    out.conflicts = conflicts.map((p) => p.there as FileConflict);
    return out;
  }
  const sending = planned.flatMap((p, i): PushFileInput[] =>
    p.state === 'new' || p.state === 'version' || p.state === 'copy'
      ? [{ file: (files[i] as { abs: string }).abs, path: p.path, size: p.size, sha256: p.sha256, base: p.state === 'version' ? p.base : null }]
      : [],
  );
  if (o.dryRun || !sending.length) return out;
  try {
    const r = await b.pushFiles(o.area, sending, {
      conflict: o.copy ? 'copy' : 'refuse',
      by: o.by,
      ...(o.via ? { via: o.via } : {}),
      ...(o.onProgress ? { onProgress: o.onProgress } : {}),
      onResume: (p: string) => {
        out.resumed.push(p);
        o.onResume?.(p);
      },
      ...(o.signal ? { signal: o.signal } : {}),
    });
    out.sent = r.sent;
    out.held = r.held;
    for (const c of r.commits) {
      out.rev = c.rev;
      for (const f of c.files) out.done.push({ path: f.path, id: f.id, v: f.v, state: f.state, ...(f.asked ? { asked: f.asked } : {}) });
    }
  } catch (e) {
    if (e instanceof FilesConflict) out.conflicts = e.conflicts;
    else if (e instanceof StoppedError || o.signal?.aborted) out.stopped = true;
    else throw e;
  }
  // a folder a pull wrote: what went up is what it is based on from now on (the record only; nothing else there changes)
  // (a copy beside a file is not the file: the record keeps what it was based on)
  const committed = new Map(out.done.filter((d) => d.state !== 'copy').map((d) => [d.path, d]));
  const touched = new Set<string>();
  for (const [i, p] of planned.entries()) {
    const d = committed.get(p.path);
    const abs = (files[i] as { abs: string }).abs;
    const at = d ? recordedAt(records, abs) : null;
    // where it is in the folder is where it is in the area, as a pull writes them
    if (!at || !d || at.rel !== p.path) continue;
    const from = at.record.files[at.rel]?.from ?? o.area;
    at.record.files[at.rel] = {
      area: o.area,
      from,
      id: d.id,
      v: d.v,
      sha256: p.sha256,
      size: p.size,
      mtime: fs.statSync(abs).mtimeMs,
      at: new Date().toISOString(),
    };
    touched.add(at.root);
  }
  for (const root of touched) writeRecord(root, (records.get(root) as { record: PullRecord }).record);
  return out;
}

// ---------------------------------------------------------------- status

export type StatusState = 'unchanged' | 'changed here' | 'changed there' | 'both changed' | 'missing here' | 'gone there' | 'new here';

export interface StatusLine {
  path: string;
  state: StatusState;
  /** The version pulled, and the one there now (when it changed there). */
  v?: number;
  now?: { v: number; by: string; agent?: string; at: string };
}

export interface StatusResult {
  to: string;
  /** The areas pulled into it. */
  areas: string[];
  lines: StatusLine[];
}

/** What changed since a pull into `to`: here (the files on this disk), there (the area's files now), or both. */
export async function status(b: Backend, o: { to: string; hashes: HashCache }): Promise<StatusResult | null> {
  if (!fs.existsSync(o.to)) return null;
  const root = fs.realpathSync(o.to);
  const record = readRecord(root, storeOf(b));
  const entries = Object.entries(record.files);
  if (!entries.length) return null;
  const areas = [...new Set(entries.map(([, x]) => x.from))].sort();
  const now = new Map<string, Map<string, FileInfo>>();
  for (const a of areas) {
    try {
      now.set(a, new Map((await allFiles(b, a)).map((f) => [f.path, f])));
    } catch {
      now.set(a, new Map());
    }
  }
  const { files } = gatherPush([`${root}${path.sep}`]);
  const local = new Map(files.map((f) => [f.path, f]));
  const lines: StatusLine[] = [];
  /** A file a pull wrote, as it is now: looked at itself (one named on purpose may be hidden), never through a link. */
  const at = (p: string): LocalFile | undefined => {
    const abs = path.join(root, ...p.split('/'));
    try {
      const st = fs.lstatSync(abs);
      return st.isFile() ? { abs, path: p, size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino } : undefined;
    } catch {
      return undefined;
    }
  };
  for (const [p, was] of entries.sort(([a], [c]) => (a < c ? -1 : 1))) {
    const here = local.get(p) ?? at(p);
    local.delete(p);
    const there = now.get(was.from)?.get(p);
    let changedHere = false;
    if (here && !(here.size === was.size && here.mtimeMs === was.mtime)) changedHere = (await o.hashes.sha256(here)) !== was.sha256;
    const changedThere = !!there && (there.id !== was.id || there.v !== was.v || there.sha256 !== was.sha256);
    const nowOf = there ? { v: there.v, by: there.by, ...(there.agent ? { agent: there.agent } : {}), at: there.at } : undefined;
    const state: StatusState = !there
      ? 'gone there'
      : !here
        ? 'missing here'
        : changedHere && changedThere
          ? 'both changed'
          : changedHere
            ? 'changed here'
            : changedThere
              ? 'changed there'
              : 'unchanged';
    lines.push({ path: p, state, v: was.v, ...(changedThere && nowOf ? { now: nowOf } : {}) });
  }
  for (const p of [...local.keys()].sort()) lines.push({ path: p, state: 'new here' });
  o.hashes.save();
  return { to: o.to, areas, lines };
}
