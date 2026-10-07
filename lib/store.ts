// The data contract. Everything an agent needs is in plain files under data/:
//   data/<slug>/review.json   – source of truth per video
//   data/<slug>/review.md     – readable summary of open items (regenerated on every change)
//   data/<slug>/<id>_clean.png, <id>_marked.png, <id>.m4a
//   data/events.jsonl         – append-only log of everything that happened
//   data/events.imported.jsonl – another store's history, as `vr admin import` brought it in (never news)
//   data/INBOX.md             – newest human feedback across all videos
// Server and CLI both write here, so every mutation runs under a per-video lock and writes atomically.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectArchivedError } from './archived.ts';
import { cleanChoices } from './choices.ts';
import { describeShape } from './drawing.ts';
import { pointersOf } from './elementMaps.ts';
import { legendLine, onWords, pointerIn } from './elements.ts';
import { isInboxEvent, statusLabel } from './eventLine.ts';
import { archivedProjectOf, checkReviewOpen } from './folderIds.ts';
import { cleanAgentName, cleanFolderLine, cutChars, shownName } from './names.ts';
import { answeredAlready, checkPicks, cleanPrompt, OPTION_LIMITS, optionLines, optionRefs, picksLine, picksToRender } from './options.ts';
import { changeableReply } from './ownership.ts';
import { fullAtOrBefore, MAX_HANDLES, PART_HANDLES, partLine, partOk, partOkWords } from './part.ts';
import { DATA, dataDir, isoLocal, projectOf, reviewDir, reviewFile, slugify, USER, validSlug, versionsDir, workspaceRoot } from './paths.ts';
import { stampFor } from './playbookFiles.ts';
import { checkIncoming, isVideoContainer, probe, probeSync, quickHash, sampleHash } from './probe.ts';
import { describeRange, frameInRange, normalizeRange, rangeOnGrid } from './range.ts';
import { describeRef } from './refLine.ts';
import { currentWorkspace, inWorkspace, wsKey } from './scope.ts';
import { approvalsOf, partyOf, STAGE_LABELS, type StageContext, stageOf, verdictOn } from './stage.ts';
import { storage } from './storage/index.ts';
import { compareTime, frameToTime, isAgent, isAnswer, isIdea, isQuestion, isRequired, noteLabel, noteRank, oneLine, timecode, timeToFrame } from './time.ts';
import { TEXT_EDIT_MAX, textEditLine } from './transcript.ts';
import type {
  AgentKind,
  AgentRunPhase,
  Approval,
  ApprovalEntry,
  ApprovalParty,
  ApprovalStatus,
  Comment,
  CommentStatus,
  Counts,
  EventType,
  FolderAsk,
  FrameRange,
  NoteKind,
  NoteRecording,
  NoteRef,
  OptionAnswer,
  OptionGroup,
  PartRequest,
  PostEventInfo,
  ProbeResult,
  RenderSource,
  Reply,
  Review,
  ReviewEvent,
  SampleMark,
  Severity,
  Shape,
  Shots,
  TextEdit,
  Version,
  VersionPart,
  VoiceNote,
} from './types.ts';

/**
 * Workspace #1's event log and inbox (where they always were), for tests and tools that mean #1. Code that reads the
 * log for whoever runs now uses `eventsFile()` / `inboxPath()`: with VR_WORKSPACE these are another team's files.
 */
export const EVENTS_FILE = path.join(DATA, 'events.jsonl');
export const INBOX_FILE = path.join(DATA, 'INBOX.md');
/** The event log of the workspace this work runs for (lib/scope.ts). */
export const eventsFile = (ws = currentWorkspace()): string => path.join(workspaceRoot(ws).data, 'events.jsonl');
/**
 * Another store's history, as `vr admin import` brought it in (appendHistory): a file of its own next to the log, so
 * no reader of the log — what agents and people are told as news — ever counts it (sweep 2 SW-1r).
 */
export const importedEventsFile = (ws = currentWorkspace()): string => path.join(workspaceRoot(ws).data, 'events.imported.jsonl');
/** Its INBOX.md. */
export const inboxPath = (ws = currentWorkspace()): string => path.join(workspaceRoot(ws).data, 'INBOX.md');

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException)?.code;

// ---------------------------------------------------------------- io

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

let batchDepth = 0;
const pendingEvents: ReviewEvent[] = [];
/** The workspace each pending event belongs to: a lock's events always go to the log they were made for. */
const eventWorkspace = new WeakMap<ReviewEvent, string>();
function queueEvent(ev: ReviewEvent): void {
  eventWorkspace.set(ev, currentWorkspace());
  pendingEvents.push(ev);
}
/** Pending events whose lock finished (see withLock). */
const savedEvents = new WeakSet<ReviewEvent>();

// Locks are held for milliseconds. A lock left behind by a process that died (an OOM kill, a crash) is noticed by its
// owner file (pid@host) and taken over at once; without one, after 20 s. A restarted process can have the dead one's
// pid (a container keeps its hostname and hands out the same small pids): the `run` file next to the owner says which
// run of a pid holds it. A live pid that has held a lock for ten minutes isn't holding it: its number went to another
// process. Waiting blocks the thread, so it gives up after 5 s with a 503 the caller can retry, rather than freezing a
// server.
const LOCK_OWNER = `${process.pid}@${os.hostname()}`;
const LOCK_RUN = crypto.randomUUID();
const LOCK_LOST_MS = 10 * 60_000;

function staleLock(lock: string): boolean {
  let age: number;
  try {
    age = Date.now() - fs.statSync(lock).mtimeMs;
  } catch {
    return false;
  }
  try {
    const [pid, host] = fs.readFileSync(path.join(lock, 'owner'), 'utf8').split('@');
    if (host === os.hostname() && Number(pid) > 0) {
      if (Number(pid) === process.pid) return readRun(lock) !== LOCK_RUN;
      try {
        process.kill(Number(pid), 0);
        return age > LOCK_LOST_MS;
      } catch (e) {
        if (errCode(e) === 'ESRCH') return true;
      }
    }
  } catch {}
  return age > 20000;
}
function readRun(lock: string): string | null {
  try {
    return fs.readFileSync(path.join(lock, 'run'), 'utf8');
  } catch {
    return null;
  }
}

export function withLock<T>(dir: string, fn: () => T): T {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.lock');
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      try {
        fs.writeFileSync(path.join(lock, 'run'), LOCK_RUN);
        fs.writeFileSync(path.join(lock, 'owner'), LOCK_OWNER);
      } catch (e) {
        fs.rmSync(lock, { recursive: true, force: true });
        throw e;
      }
      break;
    } catch (e) {
      if (errCode(e) !== 'EEXIST') throw e;
      if (staleLock(lock)) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - start > 5000) throw Object.assign(new Error('the video is busy (locked by another writer); try again'), { status: 503, retryAfter: 1 });
      sleepSync(20);
    }
  }
  // Events wait for the outermost lock to finish. Those of work that throws are dropped: it saved nothing (an edit
  // refused halfway must not reach events.jsonl). An inner lock that finished saved its files, so its events stay.
  const mark = pendingEvents.length;
  batchDepth++;
  let ok = false;
  try {
    const out = fn();
    ok = true;
    return out;
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
    batchDepth--;
    if (ok) for (let i = mark; i < pendingEvents.length; i++) savedEvents.add(pendingEvents[i] as ReviewEvent);
    else pendingEvents.splice(mark, Infinity, ...pendingEvents.slice(mark).filter((e) => savedEvents.has(e)));
    if (!batchDepth) flushEvents();
  }
}

/** A review's own id (Review.id): what review links are made for, never reused like a slug. */
const newReviewId = (): string => `r_${crypto.randomBytes(6).toString('hex')}`;

export function writeAtomic(file: string, content: string | Buffer): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/**
 * The names a review holds as they may be shown (`shownName`): what an older version stored as sent reads as one short
 * line everywhere — agents' formats, the API, the app — and is written back so the next time a review is saved.
 */
function shownNames(r: Review): Review {
  for (const c of r.comments || []) {
    if (c.author) c.author = shownName(c.author);
    for (const rp of c.replies || []) if (rp.by) rp.by = shownName(rp.by);
    for (const ref of c.refs || []) if (ref.by) ref.by = shownName(ref.by);
  }
  if (r.session?.name) r.session.name = shownName(r.session.name);
  if (r.session?.by) r.session.by = shownName(r.session.by);
  if (r.agent_status?.by) r.agent_status.by = shownName(r.agent_status.by);
  if (r.added_by) r.added_by = shownName(r.added_by);
  if (r.approval?.by) r.approval.by = shownName(r.approval.by);
  for (const a of r.approvals || []) if (a.by) a.by = shownName(a.by);
  if (r.final?.by) r.final.by = shownName(r.final.by);
  for (const f of r.finals || []) if (f.by) f.by = shownName(f.by);
  // A path or folder an older version kept with a lone surrogate reads well-formed: the same directory on the disk (Node
  // writes one as U+FFFD), and the slug and every URL built from it can be encoded.
  if (typeof r.video === 'string') r.video = r.video.toWellFormed();
  if (typeof r.folder === 'string') r.folder = r.folder.toWellFormed();
  return r;
}

export function loadReview(slug: string): Review | null {
  if (!validSlug(slug)) return null;
  try {
    return shownNames(JSON.parse(fs.readFileSync(reviewFile(slug), 'utf8')));
  } catch (e) {
    if (errCode(e) === 'ENOENT') return null;
    throw e;
  }
}

export function listSlugs(): string[] {
  let names: fs.Dirent[] = [];
  try {
    names = fs.readdirSync(dataDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  return names.filter((d) => d.isDirectory() && validSlug(d.name) && fs.existsSync(reviewFile(d.name))).map((d) => d.name);
}

// Listings (library, status, inbox, search, insights) run on every request and read every review.json: at 1,000
// videos, re-reading and parsing them blocked the server for ~90 ms a call. A review is parsed again only when its
// file changed (inode, size or mtime: every write is an atomic rename, from this process or `vr` in another). What a
// listing returns is shared between callers, so it is frozen: code that changes a review loads it fresh (loadReview).
// Keyed by the file's path: two workspaces can hold the same slug.
const listed = new Map<string, { key: string; review: Review }>();

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** Every review in the store, read-only (see above). */
export function listReviews(): Review[] {
  let names: fs.Dirent[] = [];
  const root = dataDir();
  try {
    names = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Review[] = [];
  const seen = new Set<string>();
  for (const d of names) {
    if (!d.isDirectory() || !validSlug(d.name)) continue;
    const file = path.join(root, d.name, 'review.json');
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    seen.add(file);
    const key = `${st.ino}:${st.size}:${st.mtimeMs}`;
    const hit = listed.get(file);
    if (hit?.key === key) {
      out.push(hit.review);
      continue;
    }
    const review = loadReview(d.name);
    if (!review) continue;
    listed.set(file, { key, review: deepFreeze(review) });
    out.push(review);
  }
  // Forget this workspace's reviews that are gone (its own files only: one folder deep under its root).
  for (const file of listed.keys()) if (path.dirname(path.dirname(file)) === root && !seen.has(file)) listed.delete(file);
  return out;
}

function saveReview(review: Review): void {
  const slug = slugify(review.video);
  review.updated = isoLocal();
  writeAtomic(reviewFile(slug), `${JSON.stringify(review, null, 2)}\n`);
  writeAtomic(path.join(reviewDir(slug), 'review.md'), renderReviewMd(review));
  listed.delete(reviewFile(slug));
}

export interface Resolved {
  video: string;
  slug: string;
  /** Not under review yet (a file on disk). */
  fresh?: boolean;
}

// Resolve what a user/agent typed: absolute or relative path, slug, or a unique substring of a reviewed path.
// `mustExist: false` is the machine's own caller about to track a file (`vr add`, stdio MCP): only then is the disk
// looked at. Otherwise a name is a review's or nothing, and a path answers the same whether or not a file is there.
export function resolveVideo(arg: string | undefined, { mustExist = true } = {}): Resolved {
  if (!arg) throw new Error('missing <video>');
  const asPath = path.resolve(arg);
  if (loadReview(slugify(asPath))) return { video: asPath, slug: slugify(asPath) };
  if (!arg.includes('/')) {
    const bySlug = loadReview(arg);
    if (bySlug) return { video: bySlug.video, slug: arg };
  }
  if (!mustExist && fs.existsSync(asPath) && fs.statSync(asPath).isFile()) return { video: asPath, slug: slugify(asPath), fresh: true };
  const hits = listReviews().filter((r) => r.video.includes(arg));
  if (hits.length === 1) return { video: hits[0].video, slug: slugify(hits[0].video) };
  // one line each: a file's name is someone's, and may hold a line break (a file on this machine, a name kept from before)
  if (hits.length > 1) throw new Error(`"${oneLine(arg)}" matches ${hits.length} videos:\n  ${hits.map((r) => oneLine(r.video)).join('\n  ')}`);
  if (!mustExist) return { video: asPath, slug: slugify(asPath), fresh: true };
  throw new Error(`no reviewed video matches "${arg}"`);
}

export function findComment(id: string): { slug: string; review: Review; comment: Comment } | null {
  for (const slug of listSlugs()) {
    const r = loadReview(slug);
    const c = r?.comments.find((x) => x.id === id);
    if (r && c) return { slug, review: r, comment: c };
  }
  return null;
}

// Note ids used outside review.json: the questions asked on folders (lib/asks.ts registers them).
const takenElsewhere: (() => Iterable<string>)[] = [];
/** Ids a new note must not take although no review holds them. */
export const alsoTaken = (ids: () => Iterable<string>): void => {
  takenElsewhere.push(ids);
};

function newCommentId(): string {
  const taken = new Set([...listReviews().flatMap((r) => r.comments.map((c) => c.id)), ...takenElsewhere.flatMap((f) => [...f()])]);
  for (;;) {
    const id = `c_${crypto.randomBytes(3).toString('hex')}`;
    if (!taken.has(id)) return id;
  }
}

// ---------------------------------------------------------------- versions

export const snapshotPath = (slug: string, v: number, ext: string): string => path.join(versionsDir(), slug, `v${v}${ext}`);
/** Storage key of a version's bytes (see lib/storage). */
export const versionKey = (slug: string, v: number, ext: string): string => `versions/${slug}/v${v}${ext}`;
/** A fix preview's storage key (data/<slug>/previews/ locally, the bucket in server mode with Bunny/S3). */
export const previewKey = (slug: string, file: string): string => `previews/${slug}/${file}`;
/** A fix preview's bytes as a file on this disk (a working copy with remote storage); null when they are gone. */
export const ensurePreviewFile = (slug: string, file: string): Promise<string | null> => storage().ensureLocal(previewKey(slug, file));
/** A reference's storage key (data/<slug>/refs/ locally, the bucket with Bunny/S3), see lib/refs.ts. */
export const refKey = (slug: string, file: string): string => `refs/${slug}/${file}`;
/** A reference file as a file on this disk (a working copy with remote storage); null when it is gone. */
export const ensureRefFile = (slug: string, file: string): Promise<string | null> => storage().ensureLocal(refKey(slug, file));
/** Every stored file of a reference (the file itself and its stills). */
export const refFiles = (r: NoteRef): string[] => [r.file, r.still, r.strip, r.end].filter((f): f is string => !!f);
/** At most this many references on one note. */
export const REFS_PER_NOTE = 8;
/** A project file's name without the folders it sits in on the agent's machine (reviewers see it). */
export const fileName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() || p;

export const isUpload = (review: Pick<Review, 'source'>): boolean => review.source?.kind === 'upload';

const versionOf = (review: Review, v: number) => review.versions.find((x) => x.v === v) || review.versions.at(-1);

// The file that holds the pixels of version v: a clone taken when the version was registered (so re-renders over
// the same path never destroy an old version), else the live file if it still matches. For renders kept in remote
// storage: the local working copy when there is one (ensureVersionFile() downloads it).
export function versionFile(review: Review, v: number): string | null {
  const slug = slugify(review.video);
  const ver = versionOf(review, v);
  if (!ver) return null;
  const ext = path.extname(review.video);
  const snap = ver.stored ? storage().localPath(versionKey(slug, ver.v, ext)) : snapshotPath(slug, ver.v, ext);
  if (fs.existsSync(snap)) return snap;
  if (isUpload(review)) return null;
  try {
    if (quickHash(review.video) === ver.hash && (!ver.sample || sampleHash(review.video) === ver.sample)) return review.video;
  } catch {}
  return null;
}

/** The bytes version v arrived with as a local file (a partial render: only its stretch), fetched from remote
 * storage when needed; null when they are gone. */
export async function ensureOwnFile(review: Review, v: number): Promise<string | null> {
  const hit = versionFile(review, v);
  if (hit) return hit;
  const ver = versionOf(review, v);
  if (!ver?.stored) return null;
  return storage().ensureLocal(versionKey(slugify(review.video), ver.v, path.extname(review.video)));
}

/**
 * The pixels of version v, the whole video, as a local file: its own bytes, or for a partial render the splice of
 * its stretch into the version it patches (lib/splice.ts: made once per renderKey in the playback copies' place,
 * never in versions/). What posters, frame grabs, analysis, diffs and transcripts read. Null when bytes are gone.
 */
export async function ensureVersionFile(review: Review, v: number): Promise<string | null> {
  const ver = versionOf(review, v);
  if (!ver?.part) return ensureOwnFile(review, v);
  const { ensureSplice } = await import('./splice.ts');
  return ensureSplice(review, ver);
}

/** Whether version v still has its bytes somewhere (this disk or remote storage); a part, with those it patches. */
export const versionAvailable = (review: Review, v: number, depth = 0): boolean => {
  const ver = versionOf(review, v);
  if (!ver?.stored && !versionFile(review, v)) return false;
  return !ver?.part || (depth < 64 && ver.part.of < ver.v && versionAvailable(review, ver.part.of, depth + 1));
};

function snapshot(slug: string, v: number, video: string, hash: string): void {
  const dst = snapshotPath(slug, v, path.extname(video));
  const review = loadReview(slug);
  if (review?.versions.some((x) => x.v === v)) throw new Error(`v${v} is registered already: its bytes are never written over`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.tmp`;
  try {
    fs.copyFileSync(video, tmp, fs.constants.COPYFILE_FICLONE);
    if (quickHash(tmp) !== hash) throw new Error('file changed while copying');
    fs.renameSync(tmp, dst);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export interface SyncResult {
  changed: boolean;
  version?: Version;
  carried?: number;
  /** The file looks mid-render; try again later. */
  pending?: boolean;
  /** A new render is on disk, but its project is archived (lib/archived.ts): it isn't registered until it is restored. */
  archived?: string;
}

interface NewVersion {
  hash: string;
  sample: string;
  mtime: string;
  size: number;
  meta: ProbeResult;
  by: string;
  stored?: Version['stored'];
  uploadedBy?: string;
  /** A partial render: where it goes in the version it patches (lib/part.ts). */
  part?: VersionPart;
}

// Appends the next version and carries open comments forward to it ("check again").
function registerVersion(review: Review, n: NewVersion): { version: Version; carried: number } {
  const v = (review.versions.at(-1)?.v || 0) + 1;
  const { meta } = n;
  // A part is the whole video on the screen: the frames, rate and size of the version it patches, whose file and
  // colours the review keeps describing (its own bytes are only a stretch).
  const base = n.part ? review.versions.find((x) => x.v === n.part?.of) : undefined;
  const whole = base ?? meta;
  const version: Version = {
    v,
    hash: n.hash,
    sample: n.sample,
    mtime: n.mtime,
    size: n.size,
    frames: whole.frames,
    fps: whole.fps,
    width: whole.width,
    height: whole.height,
    duration: whole.duration,
    registered: isoLocal(),
    ...(n.stored ? { stored: n.stored } : {}),
    ...(n.uploadedBy ? { by: n.uploadedBy } : {}),
    ...(n.part ? { part: n.part } : {}),
  };
  // What the render was made with: the playbooks of its folder, as they stand now (docs/playbooks.md).
  const stamp = stampFor(review.folder);
  if (stamp.length) version.playbook = stamp;
  review.versions.push(version);
  Object.assign(review, { fps: whole.fps, width: whole.width, height: whole.height, duration: whole.duration, frames: whole.frames });
  if (!base) review.meta = { codec: meta.codec, pix_fmt: meta.pix_fmt, color_space: meta.color_space, color_range: meta.color_range, audio: meta.audio };
  delete review.agent_status;
  let carried = 0;
  if (v > 1) {
    for (const c of review.comments) {
      if (c.status !== 'open') continue;
      c.check_again = true;
      c.carried_to = v;
      carried++;
    }
    const what = n.part ? ` (a part: frames ${n.part.at}–${n.part.at + n.part.frames - 1} of v${n.part.of})` : '';
    logEvent({ type: 'version', by: n.by, review, v, text: `v${v} registered${what}${carried ? `, ${carried} open comment(s) carried forward` : ''}` });
  }
  return { version, carried };
}

// Registers a new version when the file behind review.video changed. Uploads get new versions by being uploaded
// again (ingestUpload), never from the disk.
export function syncVersions(review: Review, { force = false, by = 'system' } = {}): SyncResult {
  if (isUpload(review)) return { changed: false };
  let st: fs.Stats;
  try {
    st = fs.statSync(review.video);
  } catch {
    if (!review.missing) {
      review.missing = true;
      return { changed: true };
    }
    return { changed: false };
  }
  let changed = false;
  if (review.missing) {
    delete review.missing;
    changed = true;
  }
  // The file on disk is the last full render: a partial render pushed since (lib/part.ts) never came from it.
  const last = fullAtOrBefore(review.versions, review.versions.at(-1)?.v ?? 0) ?? review.versions.at(-1);
  const mtime = new Date(st.mtimeMs).toISOString();
  if (last && last.size === st.size && last.mtime === mtime) return { changed };
  const hash = quickHash(review.video, st);
  if (last && last.hash === hash && sameInside(review, last, sampleHash(review.video, st))) {
    last.mtime = mtime;
    return { changed: true };
  }
  if (!force && Date.now() - st.mtimeMs < 3000) return { changed, pending: true };
  // nothing new in an archived project: the render waits on disk, and comes in as the next version once it is restored
  const shut = archivedProjectOf(review.folder);
  if (shut) return { changed, archived: shut };
  let meta: ProbeResult;
  try {
    meta = probeSync(review.video);
  } catch {
    return { changed, pending: true };
  }
  const slug = slugify(review.video);
  // numbered after the newest version (a part included), never after the full render compared above: that number is
  // taken, and versions/ is never written over
  const v = (review.versions.at(-1)?.v || 0) + 1;
  try {
    snapshot(slug, v, review.video, hash);
  } catch {
    return { changed, pending: true };
  }
  const sample = sampleHash(snapshotPath(slug, v, path.extname(review.video)));
  const { version, carried } = registerVersion(review, { hash, sample, mtime, size: st.size, meta, by });
  return { changed: true, version, carried };
}

/**
 * Whether bytes with version `ver`'s hash and this sample (sampleHash) are that version's: a re-render with a constant
 * frame size that changed only frames in the middle has the same hash. A version from before samples is sampled from
 * its bytes on this disk (not stored: that would move its cached files to a new key, see renderKey); without them
 * (remote storage, no working copy here) the hash has to do, as before.
 */
function sameInside(review: Review, ver: Version, sample: string): boolean {
  if (ver.sample) return ver.sample === sample;
  const slug = slugify(review.video);
  const ext = path.extname(review.video);
  const own = ver.stored ? storage().localPath(versionKey(slug, ver.v, ext)) : snapshotPath(slug, ver.v, ext);
  try {
    return sampleHash(own) === sample;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------- uploads

export const UPLOAD_EXT = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'];
const CONTENT_TYPE: Record<string, string> = { '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime' };

/** An uploaded file name as it may be stored: no directories, no control characters, a video extension. */
export function uploadName(name: string): string {
  const base = path
    .basename(String(name).replace(/\\/g, '/'))
    // a lone surrogate (JSON can carry one) would make every URL built from the name throw in the browser
    .toWellFormed()
    .normalize('NFC')
    .replace(/\p{Cc}/gu, '')
    // one line: a line or paragraph separator would start one wherever the name is printed
    .replace(/[\p{Zl}\p{Zp}]/gu, ' ')
    .trim();
  if (!base || base.startsWith('.')) throw new Error('the file needs a name');
  if (base.length > 180) throw new Error('the file name is too long');
  if (!UPLOAD_EXT.includes(path.extname(base).toLowerCase())) throw new Error(`not a video file (${UPLOAD_EXT.join(', ')})`);
  return base;
}

/**
 * How deep and how long a folder path named for a write may be (A12 OPT-3): one request naming thousands of levels
 * once held the process for minutes while every ancestor was made and saved. Past either is the caller's mistake, said
 * as such (a 400), never cut to fit. A folder a store holds from before stays as it is: it lists, opens, is renamed and
 * deleted; nothing new goes into it.
 */
export const FOLDER_LIMITS = { depth: 12, length: 400 } as const;

/** A folder path past FOLDER_LIMITS. */
export class FolderLimitError extends Error {
  status = 400;
}

/**
 * The names of a folder path, each cleaned by `clean` (empty ones dropped), held to FOLDER_LIMITS: read name by name
 * and stopped at the first past either limit, so a path of thousands of levels costs thirteen names.
 */
export function folderParts(raw: string, clean: (name: string) => string): string[] {
  const parts: string[] = [];
  let length = -1;
  for (let start = 0; start <= raw.length; ) {
    const slash = raw.indexOf('/', start);
    const end = slash === -1 ? raw.length : slash;
    const name = clean(raw.slice(start, end));
    start = end + 1;
    if (!name) continue;
    if (parts.length === FOLDER_LIMITS.depth) throw new FolderLimitError(`a folder can be at most ${FOLDER_LIMITS.depth} levels deep`);
    length += name.length + 1;
    if (length > FOLDER_LIMITS.length) throw new FolderLimitError(`a folder path can be at most ${FOLDER_LIMITS.length} characters`);
    parts.push(name);
  }
  return parts;
}

/**
 * A folder path from an upload: "/"-separated names, none of them "." or "..", within FOLDER_LIMITS. Well-formed, each
 * name cut at 60 characters, never through one (as uploadName: a lone surrogate in the slug breaks every URL of it).
 */
export function uploadFolder(folder: string | null | undefined): string | null {
  const parts = folderParts(String(folder || '').toWellFormed(), (s) =>
    cutChars(
      s
        .replace(/\p{Cc}/gu, '')
        .trim()
        .replace(/\s+/g, ' '),
      60,
    ),
  );
  if (parts.some((p) => p === '.' || p === '..')) throw new Error('folder names cannot be "." or ".."');
  if (parts.some((p) => p.includes('\\'))) throw new Error('folder names cannot contain a backslash');
  return parts.length ? parts.join('/') : null;
}

/** Uploads live under a virtual path, so slugs, events and review.md work exactly like for files on disk. */
export const uploadVideoPath = (folder: string | null, name: string): string => `/@uploads/${folder ? `${folder}/` : ''}${name}`;
/** An upload's slug, told apart without reading its review.json (uploads live under the virtual /@uploads/). */
export const isUploadSlug = (slug: string): boolean => slug.startsWith('__@uploads__');

export interface IngestOptions {
  name: string;
  folder?: string | null;
  /** Add as the next version of this (upload) review instead of looking it up by folder + name. */
  slug?: string | null;
  by?: string;
  /** The account of `by` (a signed-in person on the server): Review.added_by_id of a new video. */
  byId?: string;
  /** Copy instead of move (the CLI pushing a render that stays where it is). */
  keep?: boolean;
  /** A partial render of the review's newest version, checked by lib/parts.ts (`of` must still be the newest). */
  part?: VersionPart;
  /** The first run's sample (lib/sample.ts): a new review is marked as one from the start, so none of its events is logged. */
  sample?: SampleMark;
}

export interface IngestResult {
  review: Review;
  created: boolean;
  version: Version;
  duplicate: boolean;
}

/** Whether an upload would make a new video rather than the next version of one (what a plan may limit). */
export function uploadMakesVideo(o: Pick<IngestOptions, 'name' | 'folder' | 'slug'>): boolean {
  if (o.slug) return false;
  const name = uploadName(o.name);
  const folder = uploadFolder(o.folder);
  return !listReviews().some((r) => isUpload(r) && !r.archived && r.source?.name === name && (r.folder || null) === folder);
}

// The review an upload belongs to: explicit slug, else an existing upload with the same name in the same folder
// (also after it was moved there), else a new one.
function uploadTarget(o: IngestOptions): { slug: string; video: string; folder: string | null } {
  if (o.slug) {
    const r = loadReview(o.slug);
    if (!r) throw new Error('no such video');
    // A part is never the render on disk: it is kept like an upload, whichever way the video arrived.
    if (!isUpload(r) && !o.part) throw new Error('that video is tracked from a file on disk; re-render it to its path instead');
    return { slug: o.slug, video: r.video, folder: r.folder };
  }
  const name = uploadName(o.name);
  const folder = uploadFolder(o.folder);
  // A sample is always a video of its own, never the next version of someone's upload that happens to share its name.
  const same = !o.sample && listReviews().find((r) => isUpload(r) && !r.archived && r.source?.name === name && (r.folder || null) === folder);
  if (same) return { slug: slugify(same.video), video: same.video, folder };
  // A new video. When its path's id is taken already — a video moved or archived away from here, a "__" in a name
  // (the id writes "/" as "__"), a folder that differs only in case on a case-insensitive disk — it gets a path of its
  // own, one level deeper with the same name (`~2/`), never another video's next version.
  for (let n = 1; ; n++) {
    const video = uploadVideoPath(folder, n === 1 ? name : `~${n}/${name}`);
    const slug = slugify(video);
    if (!fs.existsSync(reviewDir(slug)) && !fs.existsSync(path.join(versionsDir(), slug))) return { slug, video, folder };
  }
}

const ingesting = new Map<string, Promise<unknown>>();

// Uploads in this process run one after another (ingesting). Another process (a `vr push` on the server) may upload
// the same video at the same moment, and version N's bytes are stored before the review's lock is taken: each upload
// holds data/.uploads/<slug> from choosing N until N is registered. Refused at once when held (409), never waited
// for: the lock's wait blocks the thread, an upload can take minutes. The holder touches it while it works; one left
// by a process that died, by an earlier run of this pid, or untouched for two minutes, is taken over. An import
// (`vr admin import`) marks the video ids it fills under the same hold (claimForImport), and holds data/.import while
// it runs.
const UPLOAD_IDLE_MS = 2 * 60_000;
const uploadReservation = (slug: string): string => path.join(dataDir(), '.uploads', slug);

function abandoned(dir: string): boolean {
  let age: number;
  try {
    age = Date.now() - fs.statSync(dir).mtimeMs;
  } catch {
    return true;
  }
  if (age > UPLOAD_IDLE_MS) return true;
  try {
    const [pid, host] = fs.readFileSync(path.join(dir, 'owner'), 'utf8').split('@');
    if (host === os.hostname() && Number(pid) > 0) {
      if (Number(pid) === process.pid) return readRun(dir) !== LOCK_RUN;
      process.kill(Number(pid), 0);
    }
  } catch (e) {
    if (errCode(e) === 'ESRCH') return true;
  }
  return false;
}

const reserveUpload = (slug: string): (() => void) =>
  reserve(uploadReservation(slug), 'another upload of this video is in progress; upload again once it has finished');

/** Holds `dir` for this process (refused at once, 409 with `busy`, while someone else does): the release. */
function reserve(dir: string, busy: string): () => void {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  for (let tries = 0; ; tries++) {
    try {
      fs.mkdirSync(dir);
      break;
    } catch (e) {
      if (errCode(e) !== 'EEXIST') throw e;
      if (tries || !abandoned(dir)) throw Object.assign(new Error(busy), { status: 409 });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const release = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    fs.writeFileSync(path.join(dir, 'run'), LOCK_RUN);
    fs.writeFileSync(path.join(dir, 'owner'), LOCK_OWNER);
  } catch (e) {
    release();
    throw e;
  }
  const touch = setInterval(() => {
    const now = new Date();
    fs.utimes(dir, now, now, () => {});
  }, UPLOAD_IDLE_MS / 4);
  touch.unref();
  return () => {
    clearInterval(touch);
    release();
  };
}

/** The sample of a partial render: its bytes, the version they patch and where (never the same for two splices). */
export const partSample = (sample: string, base: Pick<Version, 'sample' | 'hash'>, p: VersionPart): string =>
  crypto
    .createHash('sha1')
    .update(`part:${sample}:${base.sample || base.hash}:${p.at}:${p.frames}:${p.handles}`)
    .digest('hex');

/**
 * Registers an uploaded render: the first upload creates the review, later ones become its next versions (open
 * notes are carried forward, like a re-render on disk). Uploads of the same review run one after another.
 */
export function ingestUpload(file: string, o: IngestOptions): Promise<IngestResult> {
  const target = uploadTarget(o);
  // nothing new in an archived project: no new video, no next version
  const shut = archivedProjectOf(target.folder);
  if (shut) return Promise.reject(new ProjectArchivedError(shut));
  const queueKey = wsKey(target.slug);
  const before = ingesting.get(queueKey) || Promise.resolve();
  const job = before.catch(() => {}).then(() => ingest(file, target, o));
  ingesting.set(queueKey, job);
  const done = () => {
    if (ingesting.get(queueKey) === job) ingesting.delete(queueKey);
  };
  job.then(done, done);
  return job;
}

async function ingest(file: string, { slug, video, folder }: ReturnType<typeof uploadTarget>, o: IngestOptions): Promise<IngestResult> {
  const by = o.by || USER;
  let meta: ProbeResult;
  try {
    meta = await probe(file, { incoming: true });
  } catch {
    throw new Error('this is not a video ffmpeg can read');
  }
  if (!isVideoContainer(meta.format)) throw new Error(`not a video container (${meta.format || 'unknown'})`);
  if (!meta.frames || !meta.width || !meta.height) throw new Error('the video has no frames');
  checkIncoming(meta);
  const st = fs.statSync(file);
  const hash = quickHash(file, st);
  const sample = sampleHash(file, st);
  const release = reserveUpload(slug);
  try {
    return await ingestReserved(file, { slug, video, folder }, o, { by, meta, st, hash, sample });
  } finally {
    release();
  }
}

// Under the video's upload reservation: the number, the bytes, the version.
async function ingestReserved(
  file: string,
  { slug, video, folder }: ReturnType<typeof uploadTarget>,
  o: IngestOptions,
  { by, meta, st, hash, sample }: { by: string; meta: ProbeResult; st: fs.Stats; hash: string; sample: string },
): Promise<IngestResult> {
  const existing = loadReview(slug);
  // an import marked this id after the upload chose it: its bytes would go where the import puts its own (SW-7)
  if (!existing && importingFrom(slug))
    throw Object.assign(new Error('an import is filling this video id; upload again once it has finished'), { status: 409 });
  const last = existing?.versions.at(-1);
  const part = o.part;
  const same = part
    ? last?.part && last.hash === hash && last.part.at === part.at && last.part.frames === part.frames
    : last?.hash === hash && sameInside(existing as Review, last, sample);
  if (existing && last && same) {
    if (!o.keep) fs.rmSync(file, { force: true });
    return { review: existing, created: false, version: last, duplicate: true };
  }
  if (part && (!existing || last?.v !== part.of))
    throw Object.assign(new Error(`v${last?.v} arrived while the part was checked against v${part.of}: render the part against v${last?.v}`), { status: 409 });
  // A part's derived files (poster, diff, transcript, its playback splice) describe the whole video it makes: its
  // renderKey names its bytes and where they go (lib/renderKey.ts).
  const key = part && last ? partSample(sample, last, part) : sample;
  const v = (last?.v || 0) + 1;
  const ext = path.extname(video);
  const store = storage();
  await store.put(versionKey(slug, v, ext), file, { keep: o.keep, contentType: CONTENT_TYPE[ext.toLowerCase()] || 'video/mp4' });
  return withLock(reviewDir(slug), () => {
    let review = loadReview(slug);
    const created = !review;
    if (!review) {
      review = {
        video,
        source: { kind: 'upload', name: path.basename(video) },
        project: folder || 'Uploads',
        fps: 0,
        width: 0,
        height: 0,
        duration: 0,
        versions: [],
        comments: [],
        session: null,
        folder,
        added: isoLocal(),
        added_by: by,
        frames: 0,
        ...(o.byId ? { added_by_id: o.byId } : {}),
        ...(o.sample ? { onboarding_sample: o.sample } : {}),
        id: newReviewId(),
      };
    }
    // Another process (a CLI push on the server) registered this number meanwhile: its bytes are what's stored.
    if ((review.versions.at(-1)?.v || 0) + 1 !== v) throw new Error('another upload of this video finished at the same moment, please upload again');
    const stored = store.kind === 'local' ? undefined : store.kind;
    if (part && review.versions.at(-1)?.v !== part.of)
      throw Object.assign(new Error('another version arrived meanwhile: render the part against it'), { status: 409 });
    const { version } = registerVersion(review, {
      hash,
      sample: key,
      mtime: new Date(st.mtimeMs).toISOString(),
      size: st.size,
      meta,
      by,
      stored,
      uploadedBy: by,
      ...(part ? { part } : {}),
    });
    if (created) logEvent({ type: 'added', by, review, v: 1, text: `uploaded (${review.width}×${review.height}, ${review.fps} fps)` });
    saveReview(review);
    return { review, created, version, duplicate: false };
  });
}

// ---------------------------------------------------------------- mutations

/** A session to hand a video to: from `claude agents`, the UI, or just a name. */
export interface SessionInput {
  name: string;
  sessionId?: string | null;
  id?: string | null;
  cwd?: string | null;
  agent?: AgentKind | null;
}

export function createOrGetReview(
  videoPath: string,
  { by = USER, byId, session }: { by?: string; byId?: string; session?: SessionInput | null } = {},
): { review: Review; created: boolean } {
  const video = path.resolve(videoPath);
  if (!fs.existsSync(video)) throw new Error(`file not found: ${video}`);
  const slug = slugify(video);
  return withLock(reviewDir(slug), () => {
    let review = loadReview(slug);
    // The id writes "/" as "__": /work/a/b.mp4 and /work/a__b.mp4 share one. The same file spelled in another case (a
    // case-insensitive disk) is fine; another file is refused rather than mixed into this one's versions.
    if (review && review.video.toLowerCase() !== video.toLowerCase())
      throw Object.assign(new Error(`${video} and ${review.video} share one id: rename one of them to review both`), { status: 409 });
    let created = false;
    if (!review) {
      review = {
        video,
        project: projectOf(video),
        fps: 0,
        width: 0,
        height: 0,
        duration: 0,
        versions: [],
        comments: [],
        session: null,
        folder: null,
        added: isoLocal(),
        added_by: by,
        frames: 0, // after added_by: keeps the key order of review.json files written before the TypeScript port
        ...(byId ? { added_by_id: byId } : {}),
        id: newReviewId(),
      };
      const res = syncVersions(review, { force: true, by });
      if (!review.versions.length) throw new Error(res.pending ? 'video is not readable yet (still rendering?)' : 'could not read video');
      created = true;
      logEvent({ type: 'added', by, review, v: 1, text: `added to review (${review.width}×${review.height}, ${review.fps} fps)` });
    } else {
      syncVersions(review, { by });
    }
    if (session !== undefined) assignInto(review, session, by);
    saveReview(review);
    return { review, created };
  });
}

// A callback that returns nothing yields the review. `void` is exactly what such a callback's return type is.
// biome-ignore lint/suspicious/noConfusingVoidType: matching void-returning callbacks is the point here
type Mutated<T> = [T] extends [void] ? Review : T;

// Wraps load → sync → fn(review) → save under the lock. Returns what fn returns, or the review when that is undefined.
// `saved` runs once the review is written, still under the lock and before its events go out (lib/drafts.ts lets go of
// the drafts it sent there: a review that failed to save keeps them).
export function mutate<T>(slug: string, fn: (review: Review) => T, saved?: (review: Review) => void): Mutated<T> {
  // A video nobody tracks gets no folder: taking the lock would make one (the review's own creation is createOrGetReview).
  if (!fs.existsSync(reviewFile(slug))) throw new Error(`no review for ${slug}`);
  return withLock(reviewDir(slug), () => {
    const review = loadReview(slug);
    if (!review) throw new Error(`no review for ${slug}`);
    syncVersions(review);
    const out = fn(review);
    saveReview(review);
    saved?.(review);
    return (out === undefined ? review : out) as Mutated<T>;
  });
}

export function sync(slug: string): (SyncResult & { review: Review }) | null {
  // Asking about a video nobody tracks must leave nothing behind (the lock would make its folder, for any id asked).
  if (!fs.existsSync(reviewFile(slug))) return null;
  return withLock(reviewDir(slug), () => {
    const review = loadReview(slug);
    if (!review) return null;
    const res = syncVersions(review);
    if (res.changed) saveReview(review);
    return { review, ...res };
  });
}

function assignInto(review: Review, session: SessionInput | null, by: string): void {
  // no new work in an archived project: an agent is taken off it, never put on it
  if (session) checkReviewOpen(review);
  const prev = review.session?.name || null;
  // Whatever named the session (the app, `vr`, an MCP client, a heartbeat's agent): one line, short (A12-D3).
  const name = session ? cleanAgentName(session.name) : '';
  if (session && !name) throw Object.assign(new Error('a session needs a name'), { status: 400 });
  review.session = session
    ? {
        name,
        id: cleanAgentName(session.sessionId || session.id || '', 200) || null,
        cwd: session.cwd ? cleanFolderLine(session.cwd) || null : null,
        assigned: isoLocal(),
        by,
        ...(session.agent ? { agent: session.agent } : {}),
      }
    : null;
  if (prev !== (session ? name : null)) logEvent({ type: 'assigned', by, review, text: session ? `${ASSIGNED}${name}` : 'unassigned' });
}

export const assignSession = (slug: string, session: SessionInput | null, by = USER): Review => mutate(slug, (r) => assignInto(r, session, by));

export const reservedCommentId = (): string => newCommentId();

export interface CommentInput {
  id?: string;
  v?: number;
  frame: number;
  range?: FrameRange | null;
  text?: string;
  tags?: string[];
  severity?: Severity;
  /** Default: `question` when an agent writes the note, else `feedback`. */
  kind?: NoteKind;
  drawing?: Shape[];
  author?: string;
  /** The account of `author` (a signed-in person on the server; see Comment.author_id). */
  author_id?: string;
  voice?: VoiceNote | null;
  shots?: Shots;
  /** Client notes: the public id of the review link they came through. */
  share?: string;
  /** References that come with the note (links and frames; files are attached once the note exists). */
  refs?: NoteRef[];
  /** About the whole video, not a moment of it. */
  scope?: 'video';
  /** A change to what is said: the words as heard and as they should be (from the transcript). */
  text_edit?: TextEdit;
  /** Questions: answers the agent offers (lib/choices.ts; kept only on a question, cleaned). */
  choices?: string[];
  /** Questions: groups of options to audition and pick from (lib/options.ts; the caller cleaned them and stored their
   * files), and what the free-text field asks. */
  options?: OptionGroup[];
  answer_prompt?: string;
  /** Said while watching: the recording and its stretch of audio (lib/recordings.ts). */
  recording?: NoteRecording;
  /** The person allows a partial render of these frames (lib/part.ts; the caller snapped them to shots). */
  part?: PartRequest;
}

/** A partial-render opt-in as kept: whole frames inside the version, in ≤ out, handles in range. */
export function cleanPart(p: PartRequest | undefined | null, frames: number): PartRequest | null {
  if (!p || !Number.isInteger(p.in) || !Number.isInteger(p.out)) return null;
  const a = Math.max(0, Math.min(p.in, frames - 1));
  const b = Math.max(a, Math.min(p.out, frames - 1));
  const out: PartRequest = { in: a, out: b };
  if (Number.isInteger(p.shot) && (p.shot as number) > 0) out.shot = p.shot;
  if (Number.isInteger(p.to_shot) && (p.to_shot as number) >= (out.shot ?? 1)) out.to_shot = p.to_shot;
  out.handles = Number.isInteger(p.handles) ? Math.max(0, Math.min(MAX_HANDLES, p.handles as number)) : PART_HANDLES;
  return out;
}

/** A text edit as kept: both sides trimmed and bounded; null when there are no words to change. */
const cleanTextEdit = (e: TextEdit | undefined): TextEdit | null => {
  const from = cutChars((e?.from || '').trim(), TEXT_EDIT_MAX);
  return e && from ? { from, to: cutChars((e.to || '').trim(), TEXT_EDIT_MAX) } : null;
};

/**
 * A note as it is kept, built against the review it goes into (not added to it): its frame inside its version, the
 * kind and severity rules, a note on an older version carried to the newest. addComment and drafts (lib/drafts.ts) both
 * build notes with it.
 */
export function buildComment(review: Review, input: CommentInput): Comment {
  const latest = review.versions.at(-1) as Version;
  const v = input.v || latest.v;
  const ver = review.versions.find((x) => x.v === v);
  if (!ver) throw new Error(`unknown version v${v}`);
  // A range is whole frames inside this render (lib/range.ts: past the end is refused), and the note's own frame
  // lies inside it (its screenshots were made there by whoever called this).
  const range = input.scope === 'video' ? null : normalizeRange(input.range, ver.frames);
  const frame = frameInRange(Math.max(0, Math.min(Math.round(input.frame), ver.frames - 1)), range);
  const id = input.id || newCommentId();
  const author = input.author || USER;
  // Agents ask and report; reviewers give feedback. A human's feedback is stored without `kind` (as before kinds
  // existed); an agent's note always says what it is, so it isn't mistaken for a note from before.
  const kind: NoteKind = input.kind ?? (isAgent(author) ? 'question' : 'feedback');
  const c: Comment = {
    id,
    v,
    frame,
    timecode: timecode(frame, ver.fps),
    t: frameToTime(frame, ver.fps),
    range,
    text: (input.text || '').trim(),
    tags: input.tags || [],
    severity: kind === 'feedback' ? input.severity || 'should' : 'nice',
    ...(kind !== 'feedback' || isAgent(author) ? { kind } : {}),
    drawing: input.drawing || [],
    shots: input.shots ?? null,
    voice: input.voice || null,
    status: 'open',
    author,
    ...(input.author_id ? { author_id: input.author_id } : {}),
    created: isoLocal(),
    replies: [],
  };
  if (input.share) c.share = input.share;
  if (input.refs?.length) c.refs = input.refs.slice(0, REFS_PER_NOTE);
  if (input.scope === 'video') c.scope = 'video';
  const edit = cleanTextEdit(input.text_edit);
  if (edit) c.text_edit = edit;
  const choices = kind === 'question' ? cleanChoices(input.choices) : null;
  if (choices) c.choices = choices;
  if (kind === 'question' && input.options?.length) {
    c.options = input.options;
    const prompt = cleanPrompt(input.answer_prompt);
    if (prompt) c.answer_prompt = prompt;
  }
  if (input.recording) {
    c.source = 'recording';
    c.recording = { id: input.recording.id, t0: input.recording.t0, t1: input.recording.t1 };
  }
  const part = input.scope === 'video' ? null : cleanPart(input.part, ver.frames);
  if (part) c.part = part;
  if (v < latest.v) {
    c.check_again = true;
    c.carried_to = latest.v;
  }
  return c;
}

export function addComment(slug: string, input: CommentInput): Comment {
  return mutate(slug, (review) => {
    checkReviewOpen(review);
    const c = buildComment(review, input);
    review.comments.push(c);
    logEvent({ type: 'comment', by: c.author, review, comment: c });
    return c;
  });
}

/**
 * Several notes in one write: their events land in events.jsonl together and in this order, so whoever waits for
 * feedback (wait_for_feedback, `vr watch`) gets them as one batch. Nothing is added when one of them is refused.
 */
export function addComments(slug: string, inputs: CommentInput[]): Comment[] {
  return mutate(slug, (review) => {
    checkReviewOpen(review);
    const made = inputs.map((input) => buildComment(review, input));
    for (const c of made) {
      review.comments.push(c);
      logEvent({ type: 'comment', by: c.author, review, comment: c });
    }
    return made;
  });
}

export interface CommentPatch {
  status?: CommentStatus;
  note?: string;
  fixed_in_v?: number | string;
  text?: string;
  tags?: string[];
  severity?: Severity;
  drawing?: Shape[];
  /** "I looked at it again" without changing anything. */
  ack?: boolean;
  /** A fix preview of this note (FixPreview.id) the fix or the verdict refers to. Verified with one: the fix is
   * verified on the preview only, until a later render matches it. */
  preview?: string;
  /** The words a text edit asks for, changed (its `from` stays what was heard). */
  text_edit_to?: string;
  /** Picks from a question's options (lib/options.ts): an answer — the note is verified, the reply carries them. */
  answer?: OptionAnswer;
  by?: string;
  /** The account of `by` when a signed-in person writes (the reply then stays theirs: Reply.by_id). */
  by_id?: string;
}

/** Picks for a question with options, as kept (lib/options.ts checkPicks); throws on a note that offers none. */
export function answerOf(c: Pick<Comment, 'options'>, a: OptionAnswer): OptionAnswer {
  if (!c.options?.length) throw new Error('this note offers no options to pick from');
  const picks = checkPicks(c.options, a.picks || {});
  const note = cutChars((a.note || '').trim(), OPTION_LIMITS.note);
  if (!Object.keys(picks).length && !note) throw new Error('pick something, or say what you want instead');
  return { picks, ...(note ? { note } : {}) };
}

/**
 * The screenshots of a note saved without them, made afterwards (lib/shots.ts followShots): set when the note is still
 * there without any. No event: the note's own went out when it was saved. Whether they were set.
 */
export function attachShots(slug: string, id: string, shots: Shots): boolean {
  return mutate(slug, (review) => {
    const c = review.comments.find((x) => x.id === id);
    if (!c || c.shots) return false;
    c.shots = shots;
    return true;
  });
}

export function updateComment(id: string, patch: CommentPatch): Comment {
  const hit = findComment(id);
  if (!hit) throw new Error(`no comment ${id}`);
  const by = patch.by || USER;
  return mutate(hit.slug, (review) => {
    checkReviewOpen(review);
    const c = review.comments.find((x) => x.id === id);
    if (!c) throw new Error(`no comment ${id}`);
    if (patch.preview && !c.previews?.some((p) => p.id === patch.preview)) throw new Error(`${id} has no preview ${patch.preview}`);
    if (patch.preview && patch.status && patch.status !== 'fixed' && patch.status !== 'verified')
      throw new Error('a preview goes with "fixed" or "verified" only');
    // Picks answer the question: checked against what it offers, said as the line agents read, kept as they were made.
    const answer = patch.answer ? answerOf(c, patch.answer) : null;
    if (answer && c.replies.filter((r) => r.answer).length >= OPTION_LIMITS.answers)
      throw Object.assign(new Error(`this question was answered ${OPTION_LIMITS.answers} times already: ask a new one`), { status: 409 });
    if (answer) {
      patch = { ...patch, status: 'verified', note: picksLine(c.options ?? null, answer) };
      delete patch.preview;
    }
    const latest = (review.versions.at(-1) as Version).v;
    const edits: Partial<Pick<Comment, 'text' | 'tags' | 'severity' | 'drawing' | 'text_edit'>> = {};
    if (patch.text !== undefined) edits.text = patch.text;
    if (patch.tags !== undefined) edits.tags = patch.tags;
    if (patch.severity !== undefined) edits.severity = patch.severity;
    if (patch.drawing !== undefined) edits.drawing = patch.drawing;
    if (patch.text_edit_to !== undefined && c.text_edit) edits.text_edit = { from: c.text_edit.from, to: cutChars(patch.text_edit_to.trim(), TEXT_EDIT_MAX) };
    if (Object.keys(edits).length) {
      Object.assign(c, edits);
      c.edited = isoLocal();
      logEvent({ type: 'edit', by, review, comment: c });
    }
    if (patch.status && patch.status !== c.status) {
      const reply: Reply = { by, text: (patch.note || '').trim(), status: patch.status, at: isoLocal() };
      if (patch.by_id) reply.by_id = patch.by_id;
      if (answer) reply.answer = answer;
      if (patch.preview) reply.preview = patch.preview;
      if (patch.status === 'fixed') {
        reply.fixed_in_v = Number(patch.fixed_in_v) || latest;
        c.fixed_in_v = reply.fixed_in_v;
      }
      if (patch.status === 'open') delete c.fixed_in_v;
      // Verified on a preview: the fix is in the project, not in a render yet (the next render is compared with it).
      if (patch.status === 'verified' && patch.preview) c.verified_on = { preview: patch.preview, v: latest };
      else delete c.verified_on;
      c.status = patch.status;
      c.check_again = false;
      c.replies.push(reply);
      logEvent({ type: 'status', by, review, comment: c, reply });
    } else if (patch.note || patch.preview) {
      const reply: Reply = { by, text: (patch.note || '').trim(), at: isoLocal() };
      if (patch.by_id) reply.by_id = patch.by_id;
      // Picks again on a question already answered: a reply that says the new ones.
      if (answer) reply.answer = answer;
      if (patch.preview) reply.preview = patch.preview;
      if (patch.fixed_in_v) reply.fixed_in_v = Number(patch.fixed_in_v);
      if (patch.ack) c.check_again = false;
      c.replies.push(reply);
      logEvent({ type: 'reply', by, review, comment: c, reply });
    } else if (patch.ack) {
      c.check_again = false;
    }
    return c;
  });
}

/** An option's file, stored after the question was asked (an upload URL's PUT; lib/askOptions.ts). No event. */
export function setOptionRef(id: string, group: string, item: string, ref: NoteRef): Comment {
  const hit = findComment(id);
  if (!hit) throw new Error(`no note ${id}`);
  return mutate(hit.slug, (review) => {
    checkReviewOpen(review);
    const c = review.comments.find((x) => x.id === id);
    const it = c?.options?.find((g) => g.id === group)?.items.find((x) => x.id === item);
    if (!c || !it) throw new Error(`${id} has no item ${group}/${item}`);
    if (c.status !== 'open') throw answeredAlready();
    it.ref = ref;
    return c;
  });
}

/**
 * Adds references to a note. With `note`, they come as a reply (who adds them says why); without, they belong to the
 * note itself. Throws past REFS_PER_NOTE (the caller removes files it stored for them).
 */
export function addRefs(id: string, refs: NoteRef[], o: { by: string; by_id?: string; note?: string }): Comment {
  const hit = findComment(id);
  if (!hit) throw new Error(`no note ${id}`);
  return mutate(hit.slug, (review) => {
    checkReviewOpen(review);
    const c = review.comments.find((x) => x.id === id);
    if (!c) throw new Error(`no note ${id}`);
    if ((c.refs?.length || 0) + refs.length > REFS_PER_NOTE) throw new Error(`a note carries at most ${REFS_PER_NOTE} references`);
    c.refs = [...(c.refs || []), ...refs];
    const note = o.note?.trim();
    if (note) {
      const reply: Reply = { by: o.by, text: note, refs: refs.map((r) => r.id), at: isoLocal() };
      if (o.by_id) reply.by_id = o.by_id;
      c.replies.push(reply);
      logEvent({ type: 'reply', by: o.by, review, comment: c, reply });
    } else for (const ref of refs) logEvent({ type: 'ref', by: o.by, review, comment: c, ref });
    return c;
  });
}

/** Changes a reference's caption (empty = none). */
export function setRefCaption(id: string, refId: string, caption: string, by = USER): Comment {
  const hit = findComment(id);
  if (!hit) throw new Error(`no note ${id}`);
  return mutate(hit.slug, (review) => {
    checkReviewOpen(review);
    const c = review.comments.find((x) => x.id === id);
    const ref = c?.refs?.find((r) => r.id === refId);
    if (!c || !ref) throw new Error(`${id} has no reference ${refId}`);
    const text = caption.trim();
    if (text) ref.caption = text;
    else delete ref.caption;
    c.edited = isoLocal();
    logEvent({ type: 'edit', by, review, comment: c });
    return c;
  });
}

/** Removes a reference from a note, with its files. */
export function removeRef(id: string, refId: string, by = USER): Comment {
  const hit = findComment(id);
  if (!hit) throw new Error(`no note ${id}`);
  return mutate(hit.slug, (review) => {
    checkReviewOpen(review);
    const c = review.comments.find((x) => x.id === id);
    const ref = c?.refs?.find((r) => r.id === refId);
    if (!c || !ref) throw new Error(`${id} has no reference ${refId}`);
    c.refs = (c.refs || []).filter((r) => r.id !== refId);
    if (!c.refs.length) delete c.refs;
    for (const rp of c.replies) if (rp.refs) rp.refs = rp.refs.filter((x) => x !== refId);
    for (const f of refFiles(ref))
      storage()
        .remove(refKey(hit.slug, f))
        .catch((e: Error) => console.error(`removing reference ${refId}:`, e.message));
    c.edited = isoLocal();
    logEvent({ type: 'edit', by, review, comment: c });
    return c;
  });
}

export function deleteComment(id: string, by = USER): Comment {
  const hit = findComment(id);
  if (!hit) throw new Error(`no comment ${id}`);
  return mutate(hit.slug, (review) => {
    checkReviewOpen(review);
    const i = review.comments.findIndex((x) => x.id === id);
    if (i < 0) throw new Error(`no comment ${id}`);
    const [c] = review.comments.splice(i, 1);
    const dir = reviewDir(hit.slug);
    for (const f of [c.shots?.clean, c.shots?.marked, c.voice?.file]) if (f) fs.rmSync(path.join(dir, f), { force: true });
    for (const p of c.previews || [])
      storage()
        .remove(previewKey(hit.slug, p.file))
        .catch((e: Error) => console.error(`removing preview ${p.id}:`, e.message));
    for (const r of [...(c.refs || []), ...optionRefs(c.options)])
      for (const f of refFiles(r))
        storage()
          .remove(refKey(hit.slug, f))
          .catch((e: Error) => console.error(`removing reference ${r.id}:`, e.message));
    logEvent({ type: 'delete', by, review, comment: c });
    return c;
  });
}

const failWith = (status: number, message: string) => Object.assign(new Error(message), { status });

/**
 * Reply `n` of a note, when it is still the one written at `at`. Replies have no ids of their own (older stores' don't
 * either): the place says which, the time that nothing moved it — a thread only grows, but a reply deleted before it
 * moves it up, and then the caller looks again instead of changing someone else's words.
 */
function replyAt(c: Comment, n: number, at: string): Reply {
  const r = c.replies[n];
  if (!r) throw failWith(404, `${c.id} has no reply ${n}`);
  if (r.at !== at) throw failWith(409, 'this thread changed since you read it: look at it again');
  return r;
}

/** Whose reply `n` of note `id` is, for the route's rules (lib/ownership.ts): undefined when there is none. */
export function findReply(id: string, n: number): { slug: string; comment: Comment; reply: Reply } | null {
  const hit = findComment(id);
  const reply = hit?.comment.replies?.[n];
  return hit && reply ? { slug: hit.slug, comment: hit.comment, reply } : null;
}

/**
 * New words for a plain reply (its author's; the route checks who asks). Agents read the reply as it is now — `vr
 * open`, MCP get_note — and the change as an `edit` event that carries the reply ("EDITED REPLY", lib/eventLine.ts).
 */
export function editReply(id: string, n: number, at: string, text: string, by = USER): Comment {
  const hit = findComment(id);
  if (!hit) throw failWith(404, `no comment ${id}`);
  return mutate(hit.slug, (review) => {
    checkReviewOpen(review);
    const c = review.comments.find((x) => x.id === id);
    if (!c) throw failWith(404, `no comment ${id}`);
    const r = replyAt(c, n, at);
    if (!changeableReply(r)) throw failWith(409, 'a status change stays as it happened: only a plain reply can be edited');
    const words = text.trim();
    if (!words) throw failWith(400, 'a reply needs words: delete it instead');
    if (words === r.text) return c;
    r.text = words;
    r.edited = isoLocal();
    logEvent({ type: 'edit', by, review, comment: c, reply: r });
    return c;
  });
}

/** Takes a plain reply out of its thread (a `delete` event that carries it: "DELETED REPLY", never the note). */
export function deleteReply(id: string, n: number, at: string, by = USER): Comment {
  const hit = findComment(id);
  if (!hit) throw failWith(404, `no comment ${id}`);
  return mutate(hit.slug, (review) => {
    checkReviewOpen(review);
    const c = review.comments.find((x) => x.id === id);
    if (!c) throw failWith(404, `no comment ${id}`);
    const r = replyAt(c, n, at);
    if (!changeableReply(r, true))
      throw failWith(
        409,
        r.refs?.length ? 'this reply brought references: remove them first' : 'a status change stays as it happened: only a plain reply can be deleted',
      );
    c.replies.splice(n, 1);
    logEvent({ type: 'delete', by, review, comment: c, reply: r });
    return c;
  });
}

export function removeVideo(slug: string, by = USER): Review | null {
  return withLock(reviewDir(slug), () => {
    const review = loadReview(slug);
    if (!review) return null;
    if (review.comments.length) {
      review.archived = isoLocal();
      saveReview(review);
    } else {
      fs.rmSync(reviewDir(slug), { recursive: true, force: true });
      fs.rmSync(path.join(versionsDir(), slug), { recursive: true, force: true });
      if (review.versions.some((x) => x.stored))
        storage()
          .remove(`versions/${slug}/`)
          .catch((e: Error) => console.error(`could not delete the stored renders of ${slug}:`, e.message));
    }
    logEvent({ type: 'removed', by, review, text: review.comments.length ? 'archived (has comments)' : 'removed' });
    return review;
  });
}

/**
 * Deletes the first run's sample for good: its review (notes, screenshots, drafts) and its renders, wherever the
 * storage adapter keeps them. Refuses anything that isn't a sample. Its derived files in cache/ are disposable.
 */
export function removeSample(slug: string): Review | null {
  return withLock(reviewDir(slug), () => {
    const review = loadReview(slug);
    if (!review) return null;
    if (!review.onboarding_sample) throw Object.assign(new Error('that video is not a sample'), { status: 409 });
    fs.rmSync(reviewDir(slug), { recursive: true, force: true });
    fs.rmSync(path.join(versionsDir(), slug), { recursive: true, force: true });
    // remote storage keeps renders, fix previews and references under the video's own prefixes
    const st = storage();
    if (st.kind !== 'local')
      for (const prefix of ['versions', 'previews', 'refs'])
        st.remove(`${prefix}/${slug}/`).catch((e: Error) => console.error(`could not delete the stored ${prefix} of the sample ${slug}:`, e.message));
    return review;
  });
}

export const unarchive = (slug: string): Review =>
  mutate(slug, (r) => {
    delete r.archived;
  });

// ---------------------------------------------------------------- reviews from another store (`vr admin import`)

/** A note's files next to its review.json: its screenshots and its voice clip. */
export const NOTE_FILE = /^c_[a-f0-9]{4,16}(_clean\.png|_marked\.png|_range\.jpg|\.m4a)$/;
/** In a review's folder while an import fills it: the bundle's id (lib/bundleImport.ts), so a run that stopped can go on. */
const IMPORTING = '.importing';

/** The bundle a review folder is being filled from, or null (none, or a finished review). */
export function importingFrom(slug: string): string | null {
  try {
    return fs.readFileSync(path.join(reviewDir(slug), IMPORTING), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Marks a review folder as being filled from `bundle`: nothing lists it before its review.json is written. */
export function markImporting(slug: string, bundle: string): void {
  fs.mkdirSync(reviewDir(slug), { recursive: true });
  writeAtomic(path.join(reviewDir(slug), IMPORTING), bundle);
}

/**
 * Marks a video id for an import of `bundle` under its upload hold, after checking it is free (or this bundle's from a
 * run that stopped): an upload holding it now keeps it, and one that chose it before refuses to write into the import
 * (ingestReserved). Null when marked, else why not (sweep 2 SW-7: the mark came after the check).
 */
export function claimForImport(slug: string, bundle: string): string | null {
  let release: () => void;
  try {
    release = reserveUpload(slug);
  } catch {
    return 'an upload of this video id is under way';
  }
  try {
    const mark = importingFrom(slug);
    if (mark !== bundle && (fs.existsSync(reviewDir(slug)) || fs.existsSync(path.join(versionsDir(), slug))))
      return mark ? 'another import is filling this video id' : 'this workspace has files under this video id';
    markImporting(slug, bundle);
    return null;
  } finally {
    release();
  }
}

/** One import into a workspace at a time (data/.import): what an unfinished one left is then told from one under way. */
export const holdImport = (): (() => void) =>
  reserve(path.join(dataDir(), '.import'), 'another import into this workspace is running; run this one once it has finished');

/** The video ids an import marked and never finished (no review.json), and the bundle each is from. */
export function unfinishedImports(): { slug: string; bundle: string }[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dataDir());
  } catch {
    return [];
  }
  const out: { slug: string; bundle: string }[] = [];
  for (const slug of names) {
    if (slug.startsWith('.') || !validSlug(slug)) continue;
    const bundle = importingFrom(slug);
    if (bundle && !fs.existsSync(reviewFile(slug))) out.push({ slug, bundle });
  }
  return out;
}

/** Puts a note's file (a screenshot, a voice clip) next to its review.json, taking over `src`. */
export function placeNoteFile(slug: string, name: string, src: string): void {
  if (!NOTE_FILE.test(name)) throw new Error(`not a note's file: ${JSON.stringify(name).slice(0, 60)}`);
  fs.mkdirSync(reviewDir(slug), { recursive: true });
  try {
    fs.renameSync(src, path.join(reviewDir(slug), name));
  } catch (e) {
    if (errCode(e) !== 'EXDEV') throw e;
    fs.copyFileSync(src, path.join(reviewDir(slug), name));
    fs.rmSync(src, { force: true });
  }
}

/**
 * Writes a review brought over from another store as it is: its times as they were and no event (its notes are history,
 * lib/bundleImport.ts). Refuses a video id that already holds a review, so nothing is ever written over.
 */
export function importReview(review: Review): void {
  const slug = slugify(review.video);
  withLock(reviewDir(slug), () => {
    if (fs.existsSync(reviewFile(slug))) throw Object.assign(new Error(`${slug} holds a review already`), { status: 409 });
    writeAtomic(reviewFile(slug), `${JSON.stringify(review, null, 2)}\n`);
    writeAtomic(path.join(reviewDir(slug), 'review.md'), renderReviewMd(review));
    fs.rmSync(path.join(reviewDir(slug), IMPORTING), { force: true });
    listed.delete(reviewFile(slug));
  });
}

/**
 * Takes back what an import placed for a review it didn't finish (its folder still marked by `bundle`, no review.json):
 * the folder, its renders and the files kept through the storage adapter. Anything else is left alone.
 */
export async function dropUnfinishedImport(slug: string, bundle: string): Promise<boolean> {
  if (importingFrom(slug) !== bundle || fs.existsSync(reviewFile(slug))) return false;
  fs.rmSync(reviewDir(slug), { recursive: true, force: true });
  fs.rmSync(path.join(versionsDir(), slug), { recursive: true, force: true });
  const st = storage();
  if (st.kind !== 'local')
    for (const prefix of ['versions', 'previews', 'refs'])
      await st.remove(`${prefix}/${slug}/`).catch((e: Error) => console.error(`import: ${prefix} of ${slug}:`, e.message));
  return true;
}

/**
 * Appends another store's history to this workspace's imported history (`importedEventsFile`) in one write, each event
 * marked `imported` with the bundle's id. It never goes into events.jsonl: the log's readers take its newest events
 * within a limit and a tail, and a long history there pushed what happened just before out of them (sweep 2 SW-1r). So
 * nothing follows it — the server's feed (the live stream, webhooks, push), `vr watch`, the MCP feed — and nothing reads
 * it as news (`wait_for_feedback`, INBOX.md, `vr inbox`); For you, a person's part opt-ins, the folders' repair and
 * `vr export` read it as what happened (`readHistory`, `historyFiles`).
 */
export function appendHistory(events: ReviewEvent[], bundle: string): void {
  if (!events.length) return;
  const file = importedEventsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  withLock(path.join(dataDir(), '.inbox'), () => {
    fs.appendFileSync(file, events.map((e) => `${JSON.stringify({ ...e, imported: bundle })}\n`).join(''));
  });
}

/**
 * The workspace's history files, the imported history first, then the log: for readers that go through all of it (an
 * import run again, the folders' repair, `vr export`). A store an earlier version imported into holds such history in
 * events.jsonl itself, marked `imported`.
 */
export const historyFiles = (): string[] => [importedEventsFile(), eventsFile()];

/** The video ids whose history a bundle's import appended already (a run that stopped, then ran again). */
export function historyFrom(bundle: string): Set<string> {
  const out = new Set<string>();
  const mark = `"imported":${JSON.stringify(bundle)}`;
  for (const file of historyFiles()) {
    let log = '';
    try {
      log = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of log.split('\n')) {
      if (!line.includes(mark)) continue;
      try {
        const e = JSON.parse(line) as ReviewEvent;
        if (e.imported === bundle && e.slug) out.add(e.slug);
      } catch {}
    }
  }
  return out;
}

// ---------------------------------------------------------------- sign-off: verdicts, final, reopen

// review.approvals is the history (append-only); review.approval stays the newest standing verdict, as it was before
// the history existed, so older readers keep working. Stores without a history start it from their one `approval`.
function recordVerdict(review: Review, entry: ApprovalEntry): void {
  review.approvals = [...approvalsOf(review), entry];
  review.approval = standingApproval(review.approvals);
}

function standingApproval(history: ApprovalEntry[]): Approval | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i] as ApprovalEntry;
    if (e.status !== 'withdrawn' && verdictOn(history, e.party, e.v) === e) return { status: e.status, v: e.v, by: e.by, at: e.at, note: e.note };
  }
  return null;
}

const verdictWho = (party: ApprovalParty, by: string) => (party === 'client' ? `client: ${by.replace(/^guest:/, '')}` : 'team');

/**
 * A verdict on a version (default: the newest) by the team or a client; null withdraws that party's verdict there.
 * The event text keeps its tokens ("APPROVED v3", "CHANGES REQUESTED v3") and names the party: "APPROVED v3 (client: Mia)".
 */
export function setApproval(
  slug: string,
  approval: { status: ApprovalStatus; v?: number; note?: string | null } | null,
  by = USER,
  /** `keep`: a link's verdicts kept for this version (`share`), the newest; older ones of that link and version go. */
  o: { party?: ApprovalParty; share?: string; v?: number; keep?: number } = {},
): Approval | null {
  return mutate(slug, (review) => {
    checkReviewOpen(review);
    const v = approval?.v || o.v || (review.versions.at(-1) as Version).v;
    const party = o.party || partyOf(by);
    const note = (approval?.note || '').trim() || null;
    recordVerdict(review, { party, status: approval ? approval.status : 'withdrawn', v, by, at: isoLocal(), note, ...(o.share ? { share: o.share } : {}) });
    // One link's verdicts on one version are bounded (A13 LINK-1: a visitor's flood grew review.json to megabytes): the
    // newest stay, so the one that stands is among them.
    if (o.share && o.keep !== undefined) {
      const own = (review.approvals ?? []).filter((e) => e.party === party && e.share === o.share && e.v === v);
      if (own.length > o.keep) {
        const gone = new Set(own.slice(0, own.length - o.keep));
        review.approvals = (review.approvals ?? []).filter((e) => !gone.has(e));
        review.approval = standingApproval(review.approvals);
      }
    }
    const label = approval ? (approval.status === 'approved' ? 'APPROVED' : 'CHANGES REQUESTED') : 'approval withdrawn';
    logEvent({ type: 'approval', by, review, v, party, text: `${label} v${v} (${verdictWho(party, by)})${note ? `: ${note}` : ''}` });
    return review.approval ?? null;
  });
}

/**
 * The team's approval of an older version, carried to the newest because the render is identical (the caller checks).
 * `to` is the version the caller compared: a render that arrived since was never compared, so it isn't carried to.
 */
export function carryApproval(slug: string, from: number, by = USER, to?: number): Approval | null {
  return mutate(slug, (review) => {
    checkReviewOpen(review);
    const v = (review.versions.at(-1) as Version).v;
    if (to !== undefined && to !== v) throw Object.assign(new Error(`v${v} arrived since v${to} was compared: review it instead`), { status: 409 });
    const history = approvalsOf(review);
    if (!(['team', 'client'] as const).some((p) => verdictOn(history, p, from)?.status === 'approved'))
      throw new Error(`v${from} has no approval to carry over`);
    if (from >= v) throw new Error(`v${from} is not older than the newest version v${v}`);
    recordVerdict(review, { party: 'team', status: 'approved', v, by, at: isoLocal(), note: `identical to v${from}`, carried_from: from });
    logEvent({ type: 'approval', by, review, v, party: 'team', text: `APPROVED v${v} (team): carried over from v${from}, identical render` });
    return review.approval ?? null;
  });
}

/** Marks a version (default: the newest) as the one that ships. */
/** Notes verified on a fix preview that render `v` can't contain (the fix exists only in the project so far). */
export const fixesOnlyOnPreview = (review: Review, v: number): Comment[] =>
  review.comments.filter((c) => c.status === 'verified' && c.verified_on && c.verified_on.v >= v);

/** Why a partial render can't be the version that ships (lib/part.ts). */
export const partNotFinal = (ver: Version): string =>
  `V${ver.v} is a part (frames ${ver.part?.at}–${(ver.part?.at ?? 0) + (ver.part?.frames ?? 1) - 1} rendered into V${ver.part?.of}): only a full render can be final, ask for one first`;

export function setFinal(slug: string, o: { v?: number; note?: string | null } = {}, by = USER): Review {
  return mutate(slug, (review) => {
    checkReviewOpen(review);
    const v = o.v || (review.versions.at(-1) as Version).v;
    const ver = review.versions.find((x) => x.v === v);
    if (!ver) throw new Error(`no v${v}`);
    if (ver.part) throw Object.assign(new Error(partNotFinal(ver)), { status: 409 });
    const unrendered = fixesOnlyOnPreview(review, v);
    if (unrendered.length)
      throw new Error(
        `${unrendered.length} fix${unrendered.length === 1 ? ' was' : 'es were'} verified on a preview only (${unrendered.map((c) => c.id).join(', ')}): V${v} doesn't contain ${unrendered.length === 1 ? 'it' : 'them'}, render the next version first`,
      );
    const note = (o.note || '').trim() || null;
    const mark = { v, by, at: isoLocal(), note };
    review.final = mark;
    review.finals = [...(review.finals || []), { action: 'final', ...mark }];
    logEvent({ type: 'approval', by, review, v, text: `FINAL v${v}${note ? `: ${note}` : ''}` });
  });
}

/** Records where a render was made (Version.source), e.g. the After Effects comp it came from. */
export function setVersionSource(slug: string, v: number | undefined, source: RenderSource | null, by = USER): Version {
  return mutate(slug, (review) => {
    checkReviewOpen(review);
    const ver = v ? review.versions.find((x) => x.v === v) : review.versions.at(-1);
    if (!ver) throw new Error(`no v${v}`);
    if (source) ver.source = { ...source, ...(source.project ? { project: fileName(source.project) } : {}) };
    else delete ver.source;
    logEvent({ type: 'version', by, review, v: ver.v, text: source ? `v${ver.v} rendered from ${describeSource(source)}` : `v${ver.v}: source cleared` });
    return ver;
  });
}

/** "After Effects · spot.aep · Main (from frame 12)". */
export function describeSource(s: RenderSource): string {
  return [s.app, s.project, s.comp && `${s.comp}${s.start_frame ? ` (from frame ${s.start_frame})` : ''}`].filter(Boolean).join(' · ');
}

/** Takes the final mark back (a newer render needs review, or the client wants one more change). */
export function reopenFinal(slug: string, o: { note?: string | null } = {}, by = USER): Review {
  return mutate(slug, (review) => {
    checkReviewOpen(review);
    const was = review.final;
    if (!was) throw new Error('this video is not final');
    const note = (o.note || '').trim() || null;
    review.final = null;
    review.finals = [...(review.finals || []), { action: 'reopen', v: was.v, by, at: isoLocal(), note }];
    logEvent({ type: 'approval', by, review, v: was.v, text: `REOPENED v${was.v} (was final)${note ? `: ${note}` : ''}` });
  });
}

// Where the video stands for files written here (review.md). The server and the CLI register a provider that knows
// the review links (lib/stageContext.ts); without one, links are unknown.
let stageContextOf: (review: Review) => StageContext = () => ({});
export const setStageContextProvider = (fn: (review: Review) => StageContext): void => {
  stageContextOf = fn;
};
export const stageFor = (review: Review) => stageOf(review, stageContextOf(review));

// A request from the reviewer to the assigned session, e.g. "pre-review v3 before I watch it".
/** Logs a request; returns its words as agents read them (a partial-render opt-in adds its PART RENDER OK line). */
export function addRequest(slug: string, text: string, by = USER, part?: PartRequest | null): string {
  const review = loadReview(slug);
  if (!review) throw new Error(`no review for ${slug}`);
  checkReviewOpen(review);
  const latest = review.versions.at(-1);
  const p = part && latest ? cleanPart(part, latest.frames) : null;
  const said = String(text).trim();
  const words = p ? `${said}${said ? ' · ' : ''}${partLine(p)}` : said;
  logEvent({ type: 'request', by, review, v: latest?.v, text: words, ...(p ? { part: p } : {}) });
  return words;
}

// ---------------------------------------------------------------- events + INBOX

export const shotPath = (review: Review, file: string | null | undefined): string | null => (file ? path.join(reviewDir(slugify(review.video)), file) : null);

/** The frame rate of one version of a review (a note's frames count in its own version). */
const fpsOf = (review: Review, v: number): number => review.versions.find((x) => x.v === v)?.fps || review.fps;

interface EventInput {
  type: EventType;
  by: string;
  review: Review;
  comment?: Comment;
  reply?: Reply;
  v?: number;
  text?: string;
  /** Downloads: the review link, how many files and bytes. */
  share?: string;
  files?: number;
  bytes?: number;
  party?: ApprovalParty;
  /** ref events: the reference added. */
  ref?: NoteRef;
  /** agent_run events: which run, what happened, how it ended. */
  run?: string;
  phase?: AgentRunPhase;
  exit?: number | null;
  /** request events: the partial render the person allows with it. */
  part?: PartRequest;
  /** post events: the post and where it stands (lib/publish/posts.ts). */
  post?: PostEventInfo;
}

export function logEvent({ type, by, review, comment, reply, v, text, share, files, bytes, party, ref, run, phase, exit, part, post }: EventInput): void {
  // The first run's sample is a playground: nothing done on it reaches agents' feeds, INBOX.md, webhooks or push.
  if (review.onboarding_sample) return;
  const ev: ReviewEvent = { at: isoLocal(), type, by, video: review.video, slug: slugify(review.video), session: review.session?.name || null };
  if (review.session?.id) ev.session_id = review.session.id;
  if (comment) {
    Object.assign(ev, {
      id: comment.id,
      v: comment.v,
      frame: comment.frame,
      timecode: comment.timecode,
      range: comment.range,
      ...(comment.range ? { range_at: describeRange(comment.range, fpsOf(review, comment.v)) } : {}),
      ...(comment.text_edit ? { text_edit: comment.text_edit } : {}),
      ...(comment.part ? { part: comment.part } : {}),
      severity: comment.severity,
      ...(comment.kind ? { kind: comment.kind } : {}),
      tags: comment.tags,
      status: comment.status,
      text: comment.text,
      shots: {
        clean: shotPath(review, comment.shots?.clean),
        marked: shotPath(review, comment.shots?.marked),
        ...(comment.shots?.range ? { range: shotPath(review, comment.shots.range) } : {}),
      },
      ...(comment.refs?.length ? { refs: comment.refs.length } : {}),
      ...(comment.scope ? { scope: comment.scope } : {}),
      ...(comment.options?.length ? { options: comment.options.map((g) => g.id) } : {}),
    });
  }
  if (ref) ev.ref = ref;
  // whose account wrote it is for the store's rules, not for feeds, webhooks or agents
  if (reply) {
    const { by_id: _account, ...shown } = reply;
    ev.reply = shown;
  }
  if (v) ev.v = v;
  if (text && !comment) ev.text = text;
  if (share) ev.share = share;
  if (files !== undefined) ev.files = files;
  if (bytes !== undefined) ev.bytes = bytes;
  if (party) ev.party = party;
  if (run) ev.run = run;
  if (phase) ev.phase = phase;
  if (exit !== undefined) ev.exit = exit;
  if (part && !comment) ev.part = part;
  if (post) ev.post = post;
  queueEvent(ev);
  if (!batchDepth) flushEvents();
}

/** An event about a folder rather than one video: a client downloading a whole review room. */
export function logFolderEvent({
  type,
  by,
  folder,
  text,
  share,
  files,
  bytes,
}: {
  type: EventType;
  by: string;
  folder: string;
  text: string;
  share?: string;
  files?: number;
  bytes?: number;
}): void {
  queueEvent({
    at: isoLocal(),
    type,
    by,
    video: folder,
    slug: '',
    session: null,
    folder,
    text,
    ...(share ? { share } : {}),
    ...(files !== undefined ? { files } : {}),
    ...(bytes !== undefined ? { bytes } : {}),
  });
  if (!batchDepth) flushEvents();
}

/**
 * An event about a question asked on a folder before any render (lib/asks.ts): like a note's, with the folder where
 * the video would be (`video` names it, `slug` is empty) and no moment. Agents hear the answer as they hear any.
 */
export function logAskEvent(type: EventType, by: string, ask: FolderAsk, reply?: Reply): void {
  queueEvent({
    at: isoLocal(),
    type,
    by,
    video: ask.folder,
    slug: '',
    session: null,
    folder: ask.folder,
    id: ask.id,
    kind: 'question',
    status: ask.status,
    text: ask.text,
    scope: 'video',
    options: ask.options.map((g) => g.id),
    ...(reply ? { reply } : {}),
  });
  if (!batchDepth) flushEvents();
}

// Events are written after review.json is saved, so anyone reacting to an event reads the new state.
function flushEvents(): void {
  if (!pendingEvents.length) return;
  const all = pendingEvents.splice(0);
  // One append per workspace, in order: a lock's events always go to the log of the workspace they were made in.
  const byWorkspace = new Map<string, ReviewEvent[]>();
  for (const e of all) {
    const ws = eventWorkspace.get(e) ?? currentWorkspace();
    byWorkspace.set(ws, [...(byWorkspace.get(ws) ?? []), e]);
  }
  for (const [ws, evs] of byWorkspace) {
    fs.mkdirSync(workspaceRoot(ws).data, { recursive: true });
    fs.appendFileSync(eventsFile(ws), evs.map((e) => `${JSON.stringify(e)}\n`).join(''));
    if (!inboxFile || !evs.some((e) => !isAgent(e.by))) continue;
    // The change is saved and its event written: a busy inbox doesn't fail it. The next event's rewrite catches up.
    try {
      inWorkspace(ws, writeInbox);
    } catch (e) {
      console.error('INBOX.md not rewritten:', (e as Error).message);
    }
  }
}

// A hosted server renders the inbox per request (with URLs instead of its own paths) and nobody reads the file there:
// it stops rewriting data/INBOX.md on every event (server/index.ts).
let inboxFile = true;
export function setInboxFile(write: boolean): void {
  inboxFile = write;
}

// The tail of an events log as last read, per file and shape of the question: every reader asking while the log is
// unchanged (size and mtime) shares one read and one parse — a hundred agents waiting for feedback cost one, not a
// hundred. What it hands out is shared: callers filter and map, never change it (frozen).
const tails = new Map<string, { key: string; read: TailRead }>();

interface TailRead {
  /** What the reader keeps, oldest first. */
  kept: readonly ReviewEvent[];
  /** Another store's history it passed by on the way (lines an earlier version wrote into the log), oldest first. */
  passed: readonly ReviewEvent[];
}

const TAIL_CHUNK = 1024 * 1024;
/**
 * How much of another store's history a reader of the log passes by at most, on top of its tail. An earlier version
 * appended an import's history to events.jsonl itself. The readers pass it by before their limit and tail count instead
 * of moving it out: every process appends to the log without a lock (an event written while the log was rewritten
 * would be lost), and the live followers read it by byte offset (a log that shrank is read again from its start, and
 * every event in it told again as news).
 */
const PASSED_MAX = 64 * 1024 * 1024;

/**
 * The newest `limit` events of a log within `tailBytes`, read back from its end. `skipImported`: lines marked
 * `imported` count towards neither; they come back as `passed`.
 */
function readTail(file: string, limit: number, tailBytes: number, skipImported: boolean): TailRead {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return { kept: [], passed: [] };
  }
  try {
    const st = fs.fstatSync(fd);
    const key = `${st.ino}:${st.size}:${st.mtimeMs}`;
    const at = `${file}\0${limit}\0${tailBytes}\0${skipImported}`;
    const memo = tails.get(at);
    if (memo?.key === key) return memo.read;
    const kept: ReviewEvent[] = [];
    const passed: ReviewEvent[] = [];
    let keptBytes = 0;
    let passedBytes = 0;
    let end = st.size;
    // read, not yet split into lines: the start of a line that began before `end` (everything once `end` is 0)
    let rest = Buffer.alloc(0);
    let full = false;
    while (end > 0 && !full && keptBytes + rest.length < tailBytes && passedBytes <= PASSED_MAX) {
      const len = Math.min(TAIL_CHUNK, end);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, end - len);
      end -= len;
      rest = rest.length ? Buffer.concat([buf, rest]) : buf;
      const from = end > 0 ? rest.indexOf(10) + 1 : 0;
      if (from === 0 && end > 0) continue; // not one whole line yet
      const lines = rest.subarray(from).toString('utf8').split('\n');
      rest = rest.subarray(0, from);
      for (let i = lines.length - 1; i >= 0 && !full; i--) {
        const line = lines[i] as string;
        if (!line.trim()) continue;
        const bytes = Buffer.byteLength(line) + 1;
        let e: ReviewEvent;
        try {
          e = JSON.parse(line) as ReviewEvent;
        } catch {
          keptBytes += bytes; // a line being written, or broken: it takes its room
          continue;
        }
        if (skipImported && e.imported) {
          passed.push(Object.freeze(shownEvent(e)));
          passedBytes += bytes;
        } else if (kept.length >= limit || keptBytes + bytes > tailBytes) full = true;
        else {
          kept.push(Object.freeze(shownEvent(e)));
          keptBytes += bytes;
          full = kept.length >= limit;
        }
      }
    }
    const read: TailRead = { kept: Object.freeze(kept.reverse()), passed: Object.freeze(passed.reverse()) };
    if (tails.size > 64) tails.clear();
    tails.set(at, { key, read });
    return read;
  } catch {
    return { kept: [], passed: [] };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The workspace's newest `limit` events, oldest first, within `tailBytes` of its log: what happened here, and what all
 * that agents and people are told as news is made of (wait_for_feedback, INBOX.md, `vr inbox`, GET /api/inbox). Another
 * store's history is never among them and never counts towards the limit or the tail: it has its own file
 * (`importedEventsFile`), and the lines an earlier version wrote into the log itself are passed by.
 */
export function readEvents({ limit = 1000, tailBytes = 4 * 1024 * 1024 } = {}): ReviewEvent[] {
  return readTail(eventsFile(), limit, tailBytes, true).kept as ReviewEvent[];
}

/**
 * What happened, here and before a move: another store's imported history (its newest `limit` events within
 * `tailBytes`, and what the log's reader passed by), then `readEvents`. For the readers to whom history matters (For
 * you, a person's part opt-ins), never for what is told as news. Each part keeps its own order; an imported video's
 * history ends before anything happens to it here (an import takes only video ids the workspace doesn't hold).
 */
export function readHistory({ limit = 1000, tailBytes = 4 * 1024 * 1024 } = {}): ReviewEvent[] {
  const log = readTail(eventsFile(), limit, tailBytes, true);
  return [...readTail(importedEventsFile(), limit, tailBytes, false).kept, ...log.passed, ...log.kept];
}

const ASSIGNED = 'assigned to Claude session ';

/**
 * An event as it may be shown: who did it, the session, and the session an assignment's text names, cleaned
 * (`shownName`) — an older version stored them as they were sent. Every reader of events.jsonl goes through it.
 */
export function shownEvent(e: ReviewEvent): ReviewEvent {
  if (typeof e.by === 'string') e.by = shownName(e.by);
  if (typeof e.session === 'string') e.session = shownName(e.session);
  if (e.type === 'assigned' && typeof e.text === 'string' && e.text.startsWith(ASSIGNED)) e.text = ASSIGNED + shownName(e.text.slice(ASSIGNED.length));
  // as a review's own (shownNames): a slug an older version logged with a lone surrogate still makes a URL
  if (typeof e.slug === 'string') e.slug = e.slug.toWellFormed();
  if (typeof e.video === 'string') e.video = e.video.toWellFormed();
  if (typeof e.folder === 'string') e.folder = e.folder.toWellFormed();
  return e;
}

const tagList = (t: string[] | undefined) => (t?.length ? t.join(', ') : '–');

// Newest human feedback first, as INBOX.md shows it (never another store's imported history: isInboxEvent).
export const inboxEvents = (): ReviewEvent[] => readEvents({ limit: 3000 }).filter(isInboxEvent).reverse().slice(0, 150);

// Every process that writes an event rewrites INBOX.md (the server, `vr`, an MCP server). Reading the events and
// writing the file under one lock keeps an older rendering from landing after a newer one.
export function writeInbox(): void {
  withLock(path.join(dataDir(), '.inbox'), () => writeAtomic(inboxPath(), renderInbox(inboxEvents())));
}

// Screenshot fields are printed as given: absolute paths for data/INBOX.md, URLs when a server renders it for a
// remote agent (server paths mean nothing on the agent's machine).
export function renderInbox(events: ReviewEvent[]): string {
  const out = [
    '# Video review inbox',
    '',
    `Newest human feedback across all videos, newest first. Updated ${isoLocal()}.`,
    'Full detail per video: `vr open <video>`, or data/<slug>/review.json. Live stream: `vr watch`.',
    '',
  ];
  // A new note as its video says it now: what it points at in its version's elements map, where a part may go.
  let reviews: Map<string, Review> | null = null;
  const noteNow = (e: ReviewEvent): { r: Review; c: Comment } | null => {
    if (!e.slug || !e.id) return null;
    reviews ??= new Map(listReviews().map((r) => [slugify(r.video), r]));
    const r = reviews.get(e.slug);
    const c = r?.comments.find((x) => x.id === e.id);
    return r && c ? { r, c } : null;
  };
  for (const e of events) {
    const who = e.session ? ` → ${e.session}` : '';
    // A question asked on a folder before any render (lib/asks.ts): the folder where a video would be.
    // `folder` is '' once its project was deleted (the question waits on no folder).
    if (!e.slug && typeof e.folder === 'string' && e.id && (e.type === 'comment' || e.type === 'status' || e.type === 'reply')) {
      const label = e.type === 'comment' ? 'NEW QUESTION' : e.type === 'reply' ? 'REPLY' : isAnswer(e) ? 'ANSWERED' : statusLabel(e);
      out.push(`## ${e.at} · ${label} · ${e.id}`);
      out.push(e.folder ? `- folder: ${e.folder} (no video yet)` : '- folder: - (no project, no video yet)');
      out.push(`- ${e.type === 'comment' ? 'text' : 'comment'}: ${e.text || '(no text)'}`);
      if (e.type === 'comment' && e.options?.length) out.push(`- options: ${e.options.join(', ')} (the reviewer picks in Lampo)`);
      if (e.type !== 'comment' && e.reply?.text) out.push(`- ${e.type === 'reply' ? 'reply' : 'note'}: ${e.reply.text}`);
      out.push('');
      continue;
    }
    if (e.type === 'comment') {
      const now = noteNow(e);
      const points = now ? pointersOf(now.r, [now.c]) : null;
      const pointer = points && now ? pointerIn(points, now.c.id) : undefined;
      const part = now ? partOkWords(partOk(now.r.versions, now.c)) : '';
      out.push(`## ${e.at} · NEW ${noteLabel(e)} · ${tagList(e.tags)} · ${e.id}${who}`);
      out.push(`- video: ${e.video} (v${e.v})`);
      out.push(
        `- at: ${e.timecode} · frame ${e.frame}${e.range ? ` · range ${e.range.in}–${e.range.out}${e.range_at ? ` · ${e.range_at}` : ''}` : ''}${onWords(pointer)}${part}`,
      );
      if (pointer && points) out.push(`- ${legendLine([pointer], points.names)}`);
      out.push(`- text: ${e.text || '(no text)'}`);
      if (e.text_edit) out.push(`- CHANGE WORDS "${e.text_edit.from}" → "${e.text_edit.to}"`);
      if (e.part) out.push(`- ${partLine(e.part)}`);
      if (e.options?.length) out.push(`- options: ${e.options.join(', ')} (the reviewer picks in Lampo)`);
      if (e.shots?.marked) out.push(`- marked: ${e.shots.marked}`);
      if (e.shots?.clean) out.push(`- clean: ${e.shots.clean}`);
      if (e.shots?.range) out.push(`- range frames: ${e.shots.range}`);
    } else if (e.type === 'status') {
      const label = isAnswer(e) ? 'ANSWERED' : e.status === 'wontfix' ? "WON'T FIX" : statusLabel(e);
      out.push(`## ${e.at} · ${label} · ${e.id}${who}`);
      out.push(`- video: ${e.video} · ${e.timecode} · frame ${e.frame}`);
      out.push(`- comment: ${e.text || '(no text)'}`);
      if (e.reply?.text) out.push(`- note: ${e.reply.text}`);
    } else if (e.type === 'reply') {
      out.push(`## ${e.at} · REPLY · ${e.id}${who}`);
      out.push(`- video: ${e.video} · ${e.timecode} · frame ${e.frame}`);
      out.push(`- comment: ${e.text || '(no text)'}`);
      out.push(`- reply: ${e.reply?.text}`);
    } else if (e.type === 'ref') {
      out.push(`## ${e.at} · REFERENCE · ${e.id}${who}`);
      out.push(`- video: ${e.video} · ${e.timecode} · frame ${e.frame}`);
      out.push(`- comment: ${e.text || '(no text)'}`);
      if (e.ref) out.push(`- reference: ${describeRef(e.ref)}`);
    } else if (e.type === 'edit' && e.reply) {
      // a reply's words changed by its author (the note's own stay as they are)
      out.push(`## ${e.at} · EDITED REPLY · ${e.id}${who}`);
      out.push(`- video: ${e.video} · ${e.timecode} · frame ${e.frame}`);
      out.push(`- comment: ${e.text || '(no text)'}`);
      out.push(`- reply now: ${e.reply.text}`);
    } else if (e.type === 'edit') {
      out.push(`## ${e.at} · EDITED · ${e.id}${who}`);
      out.push(`- video: ${e.video} · ${e.timecode} · frame ${e.frame}`);
      out.push(`- text now: ${e.text || '(no text)'} · ${noteLabel(e)} · ${tagList(e.tags)}`);
      if (e.text_edit) out.push(`- CHANGE WORDS "${e.text_edit.from}" → "${e.text_edit.to}"`);
    } else if (e.type === 'request') {
      out.push(`## ${e.at} · REQUEST${who}`);
      out.push(`- video: ${e.video} (v${e.v})`);
      out.push(`- ${e.text}`);
    } else {
      out.push(`## ${e.at} · ${e.type.toUpperCase()}${who}`);
      out.push(`- video: ${e.video}`);
      if (e.text) out.push(`- ${e.text}`);
    }
    out.push('');
  }
  if (!events.length) out.push('_Nothing yet._', '');
  // Every entry is lines of `- field: value`: what people wrote keeps to its field's line.
  return out.map(oneLine).join('\n');
}

// ---------------------------------------------------------------- review.md

export function counts(review: Review): Counts {
  const n: Counts = { open: 0, fixed: 0, verified: 0, wontfix: 0, must: 0, check_again: 0, done: 0, total: 0, ideas: 0, questions: 0 };
  for (const c of review.comments) {
    if (c.status !== 'open') n[c.status] = (n[c.status] || 0) + 1;
    else if (isRequired(c)) {
      n.open++;
      if (c.severity === 'must') n.must++;
      if (c.check_again) n.check_again++;
    } else if (isIdea(c)) n.ideas++;
    else if (isQuestion(c)) n.questions++;
  }
  n.done = n.verified + n.wontfix;
  n.total = review.comments.length;
  return n;
}

/**
 * Where review.md says a review's files are. `paths` (the default): on this disk — the file itself, and the machine's
 * own callers. `urls`: what a client fetches them from (anyone else: a hosted server's paths are its own business).
 */
export type MdFiles = 'paths' | 'urls';
const mdFile = (review: Review, file: string, files: MdFiles): string | null =>
  files === 'urls' ? `/data/${encodeURIComponent(slugify(review.video))}/${encodeURIComponent(path.basename(file))}` : shotPath(review, file);

export function commentBlock(review: Review, c: Comment, { heading = '###', files = 'paths' as MdFiles } = {}): string {
  const latest = review.versions.at(-1)?.v;
  const lines: string[] = [];
  const where = `${c.timecode} (frame ${c.frame}${c.range ? `, range ${c.range.in}–${c.range.out}: ${describeRange(c.range, fpsOf(review, c.v))}` : ''}) · v${c.v}`;
  const flags: string[] = [];
  if (c.check_again) flags.push(`check again in v${c.carried_to || latest}`);
  if (c.status === 'fixed') flags.push(`fixed in v${c.fixed_in_v}, waiting for verification`);
  if (isAgent(c.author)) flags.push(isQuestion(c) ? `asked by ${c.author}` : `by ${c.author}`);
  lines.push(`${heading} ${c.id} · ${noteLabel(c)} · ${tagList(c.tags)} · ${where}${flags.length ? ` · ${flags.join(' · ')}` : ''}`);
  lines.push('');
  lines.push(c.text ? c.text : c.text_edit ? '_(a change to the words, below)_' : '_(no text, see drawing)_');
  lines.push('');
  if (c.text_edit) {
    lines.push(`- ${textEditLine(c.text_edit, c, fpsOf(review, c.v))}`);
    lines.push('');
  }
  if (c.part && c.status === 'open') lines.push(`- ${partLine(c.part)}`);
  for (const s of c.drawing || []) lines.push(`- drawing: ${describeShape(s)} (video px)`);
  if (c.voice?.transcript && c.voice.transcript !== c.text) lines.push(`- voice transcript: ${c.voice.transcript}`);
  if (c.options?.length) for (const l of optionLines(c.options)) lines.push(`- ${l}`);
  if (c.shots?.marked) lines.push(`- marked: ${mdFile(review, c.shots.marked, files)}`);
  if (c.shots?.clean) lines.push(`- clean: ${mdFile(review, c.shots.clean, files)}`);
  if (c.shots?.range) lines.push(`- range frames (first … last): ${mdFile(review, c.shots.range, files)}`);
  for (const r of c.replies || []) {
    const st = r.status ? ` [${r.status}${r.fixed_in_v ? ` in v${r.fixed_in_v}` : ''}]` : r.fixed_in_v ? ` [v${r.fixed_in_v}]` : '';
    lines.push(`- reply ${r.by}${st}: ${r.text || '–'}`);
  }
  lines.push('');
  return lines.map(oneLine).join('\n');
}

export function renderReviewMd(review: Review, { files = 'paths' }: { files?: MdFiles } = {}): string {
  const n = counts(review);
  const latest = review.versions.at(-1);
  const slug = slugify(review.video);
  const bySev = (a: Comment, b: Comment) => noteRank(a) - noteRank(b) || a.t - b.t;
  const openAll = review.comments.filter((c) => c.status === 'open').sort(bySev);
  const open = openAll.filter(isRequired);
  const ideas = openAll.filter(isIdea);
  const fromAgents = openAll.filter((c) => !isRequired(c) && !isIdea(c));
  const fixed = review.comments.filter((c) => c.status === 'fixed').sort((a, b) => a.t - b.t);
  const closed = review.comments.filter((c) => c.status === 'verified' || c.status === 'wontfix').sort((a, b) => a.t - b.t);
  // Questions whose options were picked since the newest render: what the next one is made of.
  const picked = closed.filter((c) => picksToRender(c, latest?.registered));
  const approval = review.approval;
  const stage = stageFor(review);
  const history = approvalsOf(review);
  // The top block names files, folders, a session and a stage: what people and agents typed stays on its line.
  const out = [
    oneLine(`# Review: ${path.basename(review.video)}`),
    '',
    oneLine(`- video: ${review.video}${review.missing ? ' (FILE MISSING)' : ''}`),
    oneLine(`- project: ${review.project}`),
    `- current: v${latest?.v} of ${review.versions.length} · ${review.width}×${review.height} · ${review.fps} fps · ${review.duration} s · ${review.frames} frames`,
    oneLine(`- Claude session: ${review.session ? `${review.session.name} (${review.session.cwd || '?'})` : 'none assigned'}`),
    oneLine(
      `- stage: ${STAGE_LABELS[stage.stage].toUpperCase()} — ${stage.detail}${stage.stage === 'final' ? ' (final: fix nothing until it is reopened)' : ''}`,
    ),
    ...(approval
      ? [
          `- approval: ${approval.status === 'approved' ? 'APPROVED' : 'CHANGES REQUESTED'} v${approval.v} by ${approval.by} (${approval.at})${approval.note ? ` — ${oneLine(approval.note)}` : ''}`,
        ]
      : []),
    ...(review.agent_status ? [oneLine(`- agent status: ${review.agent_status.text} (${review.agent_status.by}, ${review.agent_status.at})`)] : []),
    `- open: ${n.open} (must ${n.must}) · fixed, awaiting verification: ${n.fixed} · verified: ${n.verified} · won't fix: ${n.wontfix} · ideas: ${n.ideas} · questions from agents: ${n.questions}`,
    `- updated: ${review.updated || isoLocal()}`,
    oneLine(`- json: ${files === 'urls' ? `/api/review/${encodeURIComponent(slug)}` : reviewFile(slug)}`),
    '',
    'Frames are 0-based at the file fps; timecode is mm:ss:ff. Drawing coordinates are video pixels.',
    'Mark done: `vr fix <id> --note "what changed" [--v N]` · reply: `vr reply <id> --note "…"`',
    '',
    `## Open (${open.length})`,
    '',
    ...(open.length ? open.map((c) => commentBlock(review, c, { files })) : ['_None._', '']),
    ...(ideas.length ? [`## Ideas — optional, your call (${ideas.length})`, '', ...ideas.map((c) => commentBlock(review, c, { files }))] : []),
    ...(fromAgents.length
      ? [`## Questions and notes from agents, waiting for ${USER} (${fromAgents.length})`, '', ...fromAgents.map((c) => commentBlock(review, c, { files }))]
      : []),
    ...(picked.length
      ? [`## Picked since the last render — render with these (${picked.length})`, '', ...picked.map((c) => commentBlock(review, c, { files }))]
      : []),
    `## Fixed, waiting for ${USER} to verify (${fixed.length})`,
    '',
    ...(fixed.length ? fixed.map((c) => commentBlock(review, c, { files })) : ['_None._', '']),
    `## Closed (${closed.length})`,
    '',
    ...(closed.length
      ? closed.map((c) => {
          const last = c.replies.at(-1);
          return oneLine(`- ${c.id} · ${c.status} · ${c.timecode} · ${c.text || '(drawing)'}${last?.text ? ` → ${last.text}` : ''}`);
        })
      : ['_None._']),
    '',
    ...(history.length || review.finals?.length
      ? [
          '## Sign-off',
          '',
          ...[
            ...history.map((e) => ({
              at: e.at,
              line: oneLine(
                `- ${e.at} · v${e.v} · ${e.party} · ${e.status === 'approved' ? 'APPROVED' : e.status === 'changes' ? 'CHANGES REQUESTED' : 'withdrawn'} by ${e.by}${e.carried_from ? ` (carried over from v${e.carried_from})` : ''}${e.note ? ` — ${e.note}` : ''}`,
              ),
            })),
            ...(review.finals || []).map((f) => ({
              at: f.at,
              line: oneLine(`- ${f.at} · v${f.v} · ${f.action === 'final' ? 'FINAL' : 'REOPENED'} by ${f.by}${f.note ? ` — ${f.note}` : ''}`),
            })),
          ]
            .sort((a, b) => compareTime(a.at, b.at))
            .map((x) => x.line),
          '',
        ]
      : []),
    '## Versions',
    '',
    ...review.versions.map(
      (v) =>
        `- v${v.v} · ${v.registered} · ${v.width}×${v.height} · ${v.fps} fps · ${v.frames} frames · ${(v.size / 1e6).toFixed(1)} MB · ${v.hash.slice(0, 10)}`,
    ),
    '',
  ];
  return out.join('\n');
}

/** A note's range on another version's frame grid (same times in seconds), like frameIn; null without a range. */
export function rangeIn(review: Review, c: Comment, v: number): FrameRange | null {
  if (!c.range) return null;
  const ver = review.versions.find((x) => x.v === v);
  if (!ver || v === c.v) return c.range;
  const own = review.versions.find((x) => x.v === c.v);
  return rangeOnGrid(c.range, own?.fps || ver.fps, ver.fps, ver.frames);
}

// Re-map a comment made on one version to the frame grid of another (same timecode in seconds).
export function frameIn(review: Review, c: Comment, v: number): number {
  const ver = review.versions.find((x) => x.v === v);
  if (!ver || v === c.v) return c.frame;
  const own = review.versions.find((x) => x.v === c.v);
  return Math.min(timeToFrame(own ? c.frame / own.fps : c.t, ver.fps), ver.frames - 1);
}
