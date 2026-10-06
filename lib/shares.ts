// Review links: people review without an account. A token grants one video, or every video in a folder (looked up
// on each request, so new renders and newly filed videos show up). Settings decide what visitors may do; links made
// before the settings existed behave exactly as they did (comment + approve, own notes, newest version, no download).
// Stored in data/shares.json; revoking keeps the entry (marked) for the record. The file holds no usable token: each
// entry is keyed by the token's SHA-256 and keeps the token sealed with a key derived from share-secret.key.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkKey, localOwner, startingName } from './auth.ts';
import { FoldersUnreadableError, folderIdOf } from './folderIds.ts';
import { currentWorkspace, DATA, DEFAULT_WORKSPACE, dataDir, inWorkspace, isoLocal, slugify, USER, WORKSPACE_ID } from './paths.ts';
import { summarizeActivity } from './shareActivity.ts';
import { approvalsOf } from './stage.ts';
import { listReviews, loadReview, withLock, writeAtomic } from './store.ts';
import { compareTime } from './time.ts';
import type {
  ApprovalEntry,
  Review,
  Share,
  ShareActivity,
  ShareDownloadRecord,
  ShareInfo,
  ShareInput,
  ShareSettings,
  ShareStats,
  SharesFile,
  ShareWithToken,
} from './types.ts';
import { mergeWatch } from './watch.ts';

const FILE = (): string => path.join(dataDir(), 'shares.json');
const LOCK_DIR = (): string => path.join(dataDir(), '.shares');
const SECRET_FILE = path.join(DATA, 'share-secret.key');
// Which workspace a link belongs to, for links of every workspace but #1 (lib/workspaces.ts): a visitor arrives with a
// token and nothing else, so the token says where to look first. Keyed by the token's hash like shares.json, so the
// index opens nothing by itself. A token not in it is workspace #1's (or nobody's).
const INDEX_FILE = path.join(DATA, 'links.json');
const INDEX_LOCK = path.join(DATA, '.links');

export const SHARE_DEFAULTS: ShareSettings = { comment: true, approve: true, notes: 'own', versions: 'latest', download: 'off', expires: null };

const HASHED = 'sha256:';
/** Where a link lives in shares.json: its token's SHA-256 (tokens are 144 random bits, a fast hash is enough). */
export const tokenKey = (token: string): string => `${HASHED}${crypto.createHash('sha256').update(token).digest('hex')}`;

const sealKey = () => crypto.createHmac('sha256', shareSecret()).update('video-review share tokens').digest();
function seal(token: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', sealKey(), iv);
  const body = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}
function unseal(sealed: string | undefined): string | null {
  try {
    const [iv, tag, body] = String(sealed)
      .split('.')
      .map((x) => Buffer.from(x, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', sealKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** The id of a link from before links had one: derived from its token (notes made through it carry this one). */
const legacyId = (token: string): string => `s_${crypto.createHash('sha256').update(token).digest('hex').slice(0, 10)}`;

/**
 * A JSON file of the store, or `{}` when there is none yet. Any other failure (unreadable, damaged, or a workspace that
 * can't be told) throws: read as "no links", the next new link would be written over every other one.
 */
function readJson<T>(file: string): Partial<T> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  return JSON.parse(text) as Partial<T>;
}

type Shares = SharesFile['shares'];

/**
 * Links by token hash, as the file holds them. A file from before (keyed by the tokens themselves) reads the same way
 * and is written in the hashed form by the next save; `migrateShareTokens()` does that at start-up.
 */
function readStore(file: string): Shares {
  const stored = readJson<SharesFile>(file).shares || {};
  const out: Shares = {};
  for (const [k, s] of Object.entries(stored)) {
    if (k.startsWith(HASHED)) out[k] = s;
    else out[tokenKey(k)] = { ...s, id: s.id || legacyId(k), sealed: seal(k) };
  }
  return out;
}

// shares.json is read on every request through a link (resolveShare) and changed by every visit, view, download and
// progress report of every visitor. So it is parsed once per change (inode, size, mtime: every write is an atomic
// rename, from this process or another) and held, and what visitors do (`recordStats`) waits in memory to be written in
// one go: STATS_WAIT_MS after the first change waiting, at once when STATS_BATCH wait, with any change to a link, and
// when the process ends. A progress beacon never rewrites the file. Reads here see what waits at once (it is applied
// to the held copy as it comes). Written compact: every byte is parsed again after each write.
const STATS_WAIT_MS = 2000;
const STATS_BATCH = 200;
interface StatsChange {
  key: string;
  at: string;
  fn: (stats: ShareStats, at: string) => void;
}
/** By file (one per workspace): the file as parsed (`stat` names that version of it) with what waits applied. */
const held = new Map<string, { stat: string; shares: Shares; version: number }>();
/** By file: what visitors did that isn't written yet, in order, and the workspace to write it in. */
const waiting = new Map<string, { ws: string; changes: StatsChange[]; timer: NodeJS.Timeout | null }>();

function statOf(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'none';
    throw e;
  }
}

function applyStats(shares: Shares, c: StatsChange): void {
  const s = shares[c.key];
  if (!s || s.revoked) return;
  const stats = s.stats || emptyStats();
  c.fn(stats, c.at);
  s.stats = stats;
}

/** Every link as this process knows it: the file, and what visitors did since it was written. Shared: read, never change. */
function load(): Shares {
  const file = FILE();
  const stat = statOf(file);
  const h = held.get(file);
  if (h?.stat === stat) return h.shares;
  const shares = readStore(file);
  for (const c of waiting.get(file)?.changes ?? []) applyStats(shares, c);
  held.set(file, { stat, shares, version: (h?.version ?? 0) + 1 });
  return shares;
}

/**
 * Changes links under the lock, on the file as it is now with what waits applied, and writes it with them when `fn`
 * changed something (returns true) or something was waiting. Throws, writing nothing, when the file can't be read.
 */
function change(fn: (all: Shares) => boolean): void {
  withLock(LOCK_DIR(), () => {
    const file = FILE();
    const q = waiting.get(file);
    const all = readStore(file);
    for (const c of q?.changes ?? []) applyStats(all, c);
    if (!fn(all) && !q?.changes.length) return;
    writeAtomic(file, `${JSON.stringify({ shares: all })}\n`);
    if (q) {
      if (q.timer) clearTimeout(q.timer);
      waiting.delete(file);
    }
    held.set(file, { stat: statOf(file), shares: all, version: (held.get(file)?.version ?? 0) + 1 });
  });
}

/** What a visitor did, for one link's stats: applied now for every reader, written with the next batch. */
function recordStats(token: string, fn: (stats: ShareStats, at: string) => void): void {
  const file = FILE();
  const c: StatsChange = { key: tokenKey(token), at: isoLocal(), fn };
  applyStats(load(), c);
  const h = held.get(file);
  if (h) h.version++;
  let q = waiting.get(file);
  if (!q) {
    q = { ws: currentWorkspace(), changes: [], timer: null };
    waiting.set(file, q);
    if (!exitHook) {
      exitHook = true;
      process.on('exit', flushShareStats);
    }
  }
  q.changes.push(c);
  if (q.changes.length >= STATS_BATCH) writeWaiting(file);
  else q.timer ??= setTimeout(() => writeWaiting(file), STATS_WAIT_MS).unref();
}
let exitHook = false;

function writeWaiting(file: string): void {
  const q = waiting.get(file);
  if (!q) return;
  if (q.timer) clearTimeout(q.timer);
  q.timer = null;
  try {
    inWorkspace(q.ws, () => change(() => false));
  } catch (e) {
    // Stats aren't worth failing a visitor's request for: kept (the latest few batches) and tried again later.
    console.error(`review links: what visitors did isn't written yet (${(e as Error).message}); trying again`);
    if (q.changes.length > STATS_BATCH * 5) q.changes.splice(0, q.changes.length - STATS_BATCH * 5);
    q.timer = setTimeout(() => writeWaiting(file), STATS_WAIT_MS * 5).unref();
  }
}

/** Writes what visitors did that waits, in every workspace (the process ends; tests). */
export function flushShareStats(): void {
  for (const file of [...waiting.keys()]) writeWaiting(file);
}

/** Changes whenever a link or its stats change, in this process or on disk: what a cache of the link list keys by. */
export function sharesVersion(): string {
  const shares = load();
  const h = held.get(FILE());
  return h?.shares === shares ? `${h.stat}#${h.version}` : 'none';
}

/**
 * Rewrites a shares.json that still holds tokens in clear (stores from before hashed keys), and stores the id of every
 * link from before link ids: a hashed key no longer tells it, and its old client notes are found by it (visibleNotes).
 */
export function migrateShareTokens(): boolean {
  let raw: SharesFile['shares'];
  try {
    raw = (JSON.parse(fs.readFileSync(FILE(), 'utf8')) as SharesFile).shares || {};
  } catch {
    return false;
  }
  const idless = (k: string, s: Share) => !s.id && (!k.startsWith(HASHED) || !!unseal(s.sealed));
  if (Object.keys(raw).every((k) => k.startsWith(HASHED)) && !Object.entries(raw).some(([k, s]) => idless(k, s))) return false;
  change((all) => {
    for (const s of Object.values(all)) {
      const token = s.id ? null : unseal(s.sealed);
      if (token) s.id = legacyId(token);
    }
    return true;
  });
  return true;
}

// The in-memory form every caller gets: the token back, never the sealed copy.
function withToken(token: string, s: Share): ShareWithToken {
  const { sealed: _sealed, ...rest } = s;
  return { token, ...rest };
}

/** An embed's settings, whatever was stored: it only plays the newest version, through a page on someone else's site. */
const EMBED_PLAYS = { comment: false, approve: false, notes: 'own', versions: 'latest', download: 'off' } as const;

export const settingsOf = (s: Share): ShareSettings =>
  s.embed
    ? { ...EMBED_PLAYS, expires: s.expires ?? null, embed: true }
    : {
        comment: s.comment ?? SHARE_DEFAULTS.comment,
        approve: s.approve ?? SHARE_DEFAULTS.approve,
        // a link that only plays shows its visitors no one else's notes or decisions, whatever was stored (A13 LINK-2: a
        // watch-only link kept "notes from all links" and showed them while the dialog said it doesn't)
        notes: (s.comment ?? SHARE_DEFAULTS.comment) ? (s.notes ?? SHARE_DEFAULTS.notes) : 'own',
        versions: s.versions ?? SHARE_DEFAULTS.versions,
        download: s.download ?? SHARE_DEFAULTS.download,
        expires: s.expires ?? null,
      };

/**
 * Why a link can't be an embed, or null: an embed plays one video for anyone who sees the page it is on, so it is never
 * a folder's and never has a password (a visitor in a frame on another site can't type one, and its unlock cookie
 * would be a third party's). `s` is the link as it would be after the change.
 */
export function embedRefusal(s: Pick<Share, 'embed' | 'folder' | 'password'>): string | null {
  if (!s.embed) return null;
  if (s.folder) return 'An embed is for one video: make it from the video’s share dialog.';
  if (s.password) return 'An embed plays for anyone who sees the page it is on, so it can’t have a password.';
  return null;
}

/** A link that can't be made or changed so (embedRefusal): the routes answer 400 with its sentence. */
export class LinkRefusedError extends Error {}

/** The link's public id (stored on notes made through it). Old links get one derived from the token. */
export const shareId = (s: ShareWithToken): string => s.id || legacyId(s.token);

export const isExpired = (s: Share, now = Date.now()): boolean => !!s.expires && Date.parse(s.expires) <= now;

// ---------------------------------------------------------------- passwords

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

/** A visitor's guess against the link's password. Async: scrypt runs in the thread pool, so guesses never stall the server. */
export function checkPassword(password: string, stored: string | undefined): Promise<boolean> {
  const [kind, n, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return Promise.resolve(false);
  const want = Buffer.from(hash, 'base64url');
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, Buffer.from(salt, 'base64url'), want.length, { N: Number(n) || 16384, r: 8, p: 1 }, (err, got) =>
      err ? reject(err) : resolve(crypto.timingSafeEqual(want, got)),
    ),
  );
}

// One key per store for unlock cookies; generated on first use, never leaves data/. A damaged one is refused (checkKey).
let secretCache: Buffer | null = null;
const LOST = 'visitors of links with a password type it again; links keep working but can’t be copied again';
const readKey = () => checkKey(Buffer.from(fs.readFileSync(SECRET_FILE, 'utf8').trim(), 'base64url'), SECRET_FILE, LOST);
export function shareSecret(): Buffer {
  if (secretCache) return secretCache;
  try {
    secretCache = readKey();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    fs.mkdirSync(DATA, { recursive: true });
    const key = crypto.randomBytes(32);
    try {
      fs.writeFileSync(SECRET_FILE, key.toString('base64url'), { mode: 0o600, flag: 'wx' });
      secretCache = key;
    } catch {
      // Another process won the race: use its key.
      secretCache = readKey();
    }
  }
  return secretCache;
}

/** Cookie that proves this browser knew the link's current password. */
export const unlockCookieName = (s: ShareWithToken): string => `vr_g_${shareId(s).replace(/[^A-Za-z0-9_]/g, '')}`;
export const unlockValue = (s: ShareWithToken): string =>
  crypto
    .createHmac('sha256', shareSecret())
    .update(`${s.token}:${s.password_v || 0}`)
    .digest('base64url');

export function isUnlocked(s: ShareWithToken, cookieHeader: string | undefined): boolean {
  if (!s.password) return true;
  const name = unlockCookieName(s);
  const m = new RegExp(`(?:^|;\\s*)${name}=([A-Za-z0-9_-]+)`).exec(cookieHeader || '');
  if (!m) return false;
  const want = Buffer.from(unlockValue(s));
  const got = Buffer.from(m[1]);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// ---------------------------------------------------------------- links

/** What a link is made for: a video (and the review there now: its id and `added`) or a folder (and its id). */
type Target = { slug: string; video_id?: string; video_added?: string } | { folder: string; folder_id?: string };

/** The longest name a link keeps. */
export const LABEL_MAX = 80;
/** A link's name as kept: a longer one ends at a word with "…" — cut at 80 characters, the gate's heading read "…second
 * pass with new mu" (the route takes 200 and the share dialog any length). */
export const cleanLabel = (label: string | undefined): string => {
  const chars = Array.from((label || '').trim());
  if (chars.length <= LABEL_MAX) return chars.join('');
  const cut = chars.slice(0, LABEL_MAX - 1).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > LABEL_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:·—–-]+$/u, '')}…`;
};

/** What a link is called when nobody named it. Links made before 2026-10 were called "Client" (a video) or "Review"
 * (a folder) then: neither is a name either. */
export const DEFAULT_LABEL = 'Review link';
const UNNAMED = new Set([DEFAULT_LABEL, 'Client', 'Review']);

/** The link's name as its visitors read it (a title, the line under the video's name): its own name when it was
 * given one, else '' — a default says nothing to a visitor, and "Client" told a colleague they were one. */
export const guestLabel = (s: Pick<Share, 'label'>): string => (UNNAMED.has(s.label) ? '' : s.label);

function applyInput(s: Share, input: ShareInput): void {
  if (input.label !== undefined) s.label = cleanLabel(input.label) || s.label;
  if (input.comment !== undefined) s.comment = input.comment;
  if (input.approve !== undefined) s.approve = input.approve;
  if (input.notes !== undefined) s.notes = input.notes;
  if (input.versions !== undefined) s.versions = input.versions;
  if (input.download !== undefined) s.download = input.download;
  if (input.expires !== undefined) s.expires = input.expires || null;
  if (input.embed !== undefined) {
    if (input.embed) s.embed = true;
    else delete s.embed;
  }
  if (input.password !== undefined) {
    if (input.password) s.password = hashPassword(input.password);
    else delete s.password;
    s.password_v = (s.password_v || 0) + 1;
  }
}

let index: { key: string; links: Record<string, string> } | null = null;
function readIndex(): Record<string, string> {
  let key = 'none';
  try {
    const st = fs.statSync(INDEX_FILE);
    key = `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {}
  if (index?.key === key) return index.links;
  // A failed read throws (readJson): taken as empty, every link outside workspace #1 would be lost at the next one.
  const links = readJson<{ links: Record<string, string> }>(INDEX_FILE).links || {};
  index = { key, links };
  return links;
}

/**
 * A deleted workspace's links leave the index (data/links.json): a token of theirs then names workspace #1's, where no
 * link has it — the same 404 as any unknown link. Never #1's (they aren't in the index). Returns how many went.
 */
export function forgetLinksIn(ws: string): number {
  if (ws === DEFAULT_WORKSPACE || !fs.existsSync(INDEX_FILE)) return 0;
  return withLock(INDEX_LOCK, () => {
    const all = readIndex();
    const keep = Object.fromEntries(Object.entries(all).filter(([, w]) => w !== ws));
    const gone = Object.keys(all).length - Object.keys(keep).length;
    if (gone) {
      writeAtomic(INDEX_FILE, `${JSON.stringify({ links: keep })}\n`);
      fs.chmodSync(INDEX_FILE, 0o600);
    }
    return gone;
  });
}

/** The workspace a review link's token belongs to: its own for links of a workspace other than #1, else #1. */
export function linkWorkspace(token: unknown): string {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,40}$/.test(token)) return DEFAULT_WORKSPACE;
  const ws = readIndex()[tokenKey(token)];
  return ws && WORKSPACE_ID.test(ws) ? ws : DEFAULT_WORKSPACE;
}

export function createShare(target: string | Target, { label, by = USER, byId, ...input }: ShareInput & { by?: string; byId?: string } = {}): ShareWithToken {
  const t: Target = typeof target === 'string' ? { slug: target } : { ...target };
  // A video link is for the video at that slug now, not for one added there later (madeFor).
  if ('slug' in t && !t.video_added) Object.assign(t, identityOf(loadReview(t.slug)));
  const token = crypto.randomBytes(18).toString('base64url');
  const share: Share = {
    ...t,
    label: cleanLabel(label) || DEFAULT_LABEL,
    created: isoLocal(),
    by,
    ...(byId ? { by_id: byId } : {}),
    id: `s_${crypto.randomBytes(5).toString('hex')}`,
    ...SHARE_DEFAULTS,
    stats: { opens: 0, last_opened: null, reviewers: [] },
  };
  applyInput(share, input);
  const refused = embedRefusal(share);
  if (refused) throw new LinkRefusedError(refused);
  const ws = currentWorkspace();
  // Indexed before the link exists: a visitor can never reach it through another workspace's links.
  if (ws !== DEFAULT_WORKSPACE)
    withLock(INDEX_LOCK, () => {
      fs.mkdirSync(DATA, { recursive: true });
      writeAtomic(INDEX_FILE, `${JSON.stringify({ links: { ...readIndex(), [tokenKey(token)]: ws } })}\n`);
      fs.chmodSync(INDEX_FILE, 0o600);
    });
  change((all) => {
    all[tokenKey(token)] = { ...share, sealed: seal(token) };
    return true;
  });
  return withToken(token, share);
}

/**
 * Why a link's change is refused for its kind, or null. A link is an embed from the moment it is made or never: an embed's
 * token is published in other sites' pages, so a review link that became one would show anyone what its visitors wrote,
 * and an embed that became a review link would take notes and approvals from anyone who read a page's source.
 */
export function kindRefusal(s: Pick<Share, 'embed'>, input: Pick<ShareInput, 'embed'>): string | null {
  if (input.embed === undefined || !!input.embed === !!s.embed) return null;
  return s.embed ? 'An embed stays an embed: for another kind of link, make a new link.' : 'A link can’t become an embed: make a new link for it.';
}

export function updateShare(token: string, input: ShareInput): ShareWithToken | null {
  let out: ShareWithToken | null = null;
  change((all) => {
    const s = all[tokenKey(token)];
    if (!s || s.revoked) return false;
    // thrown before anything is written (and so is embedRefusal's below): the file is read afresh for every change
    const kind = kindRefusal(s, input);
    if (kind) throw new LinkRefusedError(kind);
    applyInput(s, input);
    const refused = embedRefusal(s);
    if (refused) throw new LinkRefusedError(refused);
    s.updated = isoLocal();
    out = withToken(token, s);
    return true;
  });
  return out;
}

/** Every link with what happened through it, revoked ones too (what a client watched stays true after the link goes).
 * No tokens: for looking back (Insights, a video's viewers), never for serving. */
export function linksWithStats(): Pick<Share, 'label' | 'slug' | 'folder' | 'created' | 'revoked' | 'expires' | 'stats' | 'id' | 'embed'>[] {
  return Object.values(load()).map((s) => ({
    label: s.label,
    slug: s.slug,
    folder: s.folder,
    created: s.created,
    revoked: s.revoked,
    expires: s.expires,
    stats: s.stats,
    id: s.id,
    ...(s.embed ? { embed: true } : {}),
  }));
}

/** Whether this account ever made a review link (revoked ones too): by account, by name for links without one. */
export const madeALink = (user: { id: string; name: string }): boolean =>
  Object.values(load()).some((s) => (s.by_id ? s.by_id === user.id : s.by === user.name));

/**
 * Active links; with a filter, the ones for exactly that video or folder. A folder link whose folder is gone isn't one
 * (while folders.json can't be read, every folder link is listed: shownGone).
 */
export function listShares(filter?: string | Target): ShareWithToken[] {
  const f: Target | null = typeof filter === 'string' ? { slug: filter } : filter || null;
  const out: ShareWithToken[] = [];
  for (const s of Object.values(load())) {
    if (s.revoked || shownGone(s) || (f && !('slug' in f ? s.slug === f.slug && !s.folder : s.folder === f.folder))) continue;
    // A copy sealed under another store's key (share-secret.key replaced) can't be shown again: the link stays usable
    // by whoever has it, but the owner has to make a new one to copy it.
    const token = unseal(s.sealed);
    if (token) out.push(withToken(token, s));
  }
  return out.sort((a, b) => compareTime(b.created, a.created));
}

export function revokeShare(token: string): boolean {
  let found = false;
  change((all) => {
    const s = all[tokenKey(token)];
    if (!s) return false;
    s.revoked = isoLocal();
    found = true;
    return true;
  });
  return found;
}

/** Revokes every active link `match` picks (what they were made for was deleted); how many. */
export function revokeShares(match: (s: Share) => boolean): number {
  let n = 0;
  change((all) => {
    const ended = Object.values(all).filter((s) => !s.revoked && match(s));
    const at = isoLocal();
    for (const s of ended) s.revoked = at;
    n = ended.length;
    return n > 0;
  });
  return n;
}

/** A video was deleted (not archived): its links end with it, so they can't come back with a video added there later. */
export const revokeVideoLinks = (review: Review): number => revokeShares((s) => !s.folder && s.slug === slugify(review.video) && madeFor(s, review));

/**
 * Every folder link not revoked, as stored and in the file's order (a link is added at its end), whatever its folder's
 * state, with the videos a visitor opened through it (`vr admin repair-folders` matches ids with them).
 */
export const folderLinks = (): { id?: string; label: string; folder: string; created: string; folder_id?: string; seen: string[] }[] =>
  Object.values(load())
    .filter((s) => !s.revoked && !!s.folder)
    .map((s) => ({
      ...(s.id ? { id: s.id } : {}),
      label: s.label,
      folder: s.folder as string,
      created: s.created,
      ...(s.folder_id ? { folder_id: s.folder_id } : {}),
      seen: Object.keys(s.stats?.videos ?? {}),
    }));

/**
 * Every link that hasn't been revoked, with whether what it was made for is gone (deleted outside the app: a hand-edited
 * store, an older version of the app). A gone link opens nothing, but the owner must still be able to find and revoke it.
 */
export function allShares(): (ShareWithToken & { gone: boolean })[] {
  const out: (ShareWithToken & { gone: boolean })[] = [];
  for (const s of Object.values(load())) {
    if (s.revoked) continue;
    const token = unseal(s.sealed);
    if (!token) continue;
    const review = !s.folder && s.slug ? loadReview(s.slug) : null;
    const gone = s.folder ? shownGone(s) : !review || !madeFor(s, review);
    out.push({ ...withToken(token, s), gone });
  }
  return out.sort((a, b) => compareTime(b.created, a.created));
}

/**
 * Links from before links knew what they were made for, each bound once (at start-up) to its video (Review.added) or
 * its folder (an id; `folderId` gives an existing folder's, made when it has none, or null when there's no such
 * folder). A link whose video or folder is already gone is revoked: it covers nothing now, and would cover the next
 * one of that name. So is one older than the video now at its slug: that video was added after the link was made — the
 * one it was made for was removed and the file added again — and a link is never for a video that came later. (A
 * folder has no time it was made: one deleted and made again before the upgrade can't be told apart, and is bound.) A
 * video that can't be read right now is left for the next start.
 */
export function bindShareTargets(folderId: (folder: string) => string | null): { bound: number; ended: number } {
  const loose = Object.values(load()).filter((s) => !s.revoked && (s.folder ? !s.folder_id : !s.video_added && !!s.slug));
  if (!loose.length) return { bound: 0, ended: 0 };
  // Looked up before the lock: making a folder's id takes the folders' lock.
  const ids = new Map<string, string | null>();
  const videos = new Map<string, Pick<Review, 'id' | 'added'> | null>();
  for (const s of loose) {
    if (s.folder) {
      if (!ids.has(s.folder)) ids.set(s.folder, folderId(s.folder));
    } else if (s.slug && !videos.has(s.slug)) {
      try {
        const review = loadReview(s.slug);
        videos.set(s.slug, review ? { id: review.id, added: review.added } : null);
      } catch {}
    }
  }
  /** The video a link from before is bound to: the one at its slug, unless that one was added after the link was made. */
  const videoOf = (s: Share): Pick<Share, 'video_id' | 'video_added'> | null | undefined => {
    const review = s.slug ? videos.get(s.slug) : undefined;
    if (!review) return review;
    return s.created && review.added && compareTime(review.added, s.created) > 0 ? null : identityOf(review);
  };
  let bound = 0;
  let ended = 0;
  change((all) => {
    const at = isoLocal();
    for (const s of Object.values(all)) {
      if (s.revoked) continue;
      const to = s.folder ? (s.folder_id ? undefined : ids.get(s.folder)) : s.video_added || !s.slug ? undefined : videoOf(s);
      if (to === undefined) continue;
      if (to === null) {
        s.revoked = at;
        ended++;
      } else {
        if (typeof to === 'string') s.folder_id = to;
        else Object.assign(s, to);
        bound++;
      }
    }
    return bound + ended > 0;
  });
  return { bound, ended };
}

/**
 * Folder links follow their folder when it is renamed or moved. `map` gives a folder's new path, or null to leave a
 * link where it is (the folder that was deleted: pointing its link at the parent would show more than was shared).
 */
export function moveShareFolders(map: (folder: string) => string | null): void {
  change((all) => {
    let moved = false;
    for (const s of Object.values(all)) {
      const to = s.folder && !s.revoked ? map(s.folder) : null;
      if (to && to !== s.folder) {
        s.folder = to;
        moved = true;
      }
    }
    return moved;
  });
}

// Unknown, malformed or revoked tokens resolve to null. Expiry and passwords are the routes' business (they answer
// differently: an expired link says so, a locked one asks for the password).
export function resolveShare(token: unknown): ShareWithToken | null {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,40}$/.test(token)) return null;
  const s = load()[tokenKey(token)];
  return s && !s.revoked && !folderGone(s) ? withToken(token, s) : null;
}

// ---------------------------------------------------------------- what visitors do (stats)

const emptyStats = (): ShareStats => ({ opens: 0, last_opened: null, reviewers: [] });

/**
 * What one link keeps of what its visitors do, and what a visitor may add: the newest records are kept. Anyone with the
 * link can make up visitor ids and report on every video it covers, so every record per visitor and per video is
 * bounded here, in count (and in size: names are 40 characters, `seen` 25 hex digits, `plays` 100 numbers ≤ 999), and
 * a link at its limits stays a few hundred KB. The routes enforce the per-visitor and per-link rates.
 */
export const SHARE_LIMITS = {
  /** Visitors told apart (stats.visitors). */
  visitors: 200,
  /** Videos with a record (stats.videos): a folder link over a huge folder. */
  videos: 500,
  /** Watch records per video, and per link across its videos. */
  watchersPerVideo: 50,
  watchRecords: 500,
  /** The link's activity, newest last. */
  activity: 200,
  /** New visitor ids one address may bring to one link in an hour (an office behind one address is a few people). */
  newVisitorsPerHour: 20,
  /**
   * Notes, replies and references one visitor (link + address) adds in a day (30 a minute is the rate; this is the
   * total). Only writes that landed count: a refused or invalid one costs nothing, so nobody spends a client's share.
   */
  guestWritesPerDay: 500,
  /** The same for the whole link, whoever the visitors are: what one link adds to the store in a day. */
  guestWritesPerLinkDay: 2000,
  /**
   * Approve / Request changes one visitor gives in a day (each is an event, a webhook and a push; they count in the
   * day's writes above too). People give a few; a flood gave thousands (A13 LINK-1).
   */
  guestVerdictsPerDay: 50,
  /** A link's verdicts kept per version (the newest; the one that stands is always among them). */
  guestVerdictsKept: 20,
  /** Client notes one video takes through one link (each link its own: one link at its limit closes no other). */
  guestNotesPerVideo: 2000,
} as const;
const MAX_ACTIVITY = SHARE_LIMITS.activity;
const MAX_VISITORS = SHARE_LIMITS.visitors;
const MAX_WATCHERS = SHARE_LIMITS.watchersPerVideo;

/**
 * The key a visitor is kept under: their browser's random id (a guest page makes one and keeps it), keyed with the
 * store's secret and the link, so shares.json holds nothing a browser sent and the same browser has a different key on
 * every link. Never derived from an address.
 */
export const visitorKey = (s: ShareWithToken, visitor: string): string =>
  crypto
    .createHmac('sha256', shareSecret())
    .update(`visitor:${shareId(s)}:${visitor}`)
    .digest('base64url')
    .slice(0, 16);

/** Whether the link already tells this visitor apart (a key from visitorKey): a new one counts against the address. */
export const knowsVisitor = (token: string, visitor: string): boolean => !!load()[tokenKey(token)]?.stats?.visitors?.[visitor];

/** Keeps the latest `max` entries of a record by a time field (drops the oldest). */
function bound<T>(rec: Record<string, T>, max: number, time: (x: T) => string): void {
  const keys = Object.keys(rec);
  if (keys.length <= max) return;
  const oldest = keys.sort((a, b) => Date.parse(time(rec[a] as T)) - Date.parse(time(rec[b] as T))).slice(0, keys.length - max);
  for (const k of oldest) delete rec[k];
}

/** The link's watch records across its videos: the latest SHARE_LIMITS.watchRecords (whose report came last). */
function boundWatches(videos: NonNullable<ShareStats['videos']>): void {
  const all: [string, string, number][] = [];
  for (const [slug, v] of Object.entries(videos)) for (const [key, w] of Object.entries(v.watch || {})) all.push([slug, key, Date.parse(w.last)]);
  if (all.length <= SHARE_LIMITS.watchRecords) return;
  all.sort((a, b) => a[2] - b[2]);
  for (const [slug, key] of all.slice(0, all.length - SHARE_LIMITS.watchRecords)) delete videos[slug]?.watch?.[key];
}

function remember(stats: ShareStats, name: string | undefined | null): void {
  if (name && name !== 'client') stats.reviewers = [...stats.reviewers.filter((n) => n !== name), name].slice(-50);
}

function log(stats: ShareStats, act: Omit<ShareActivity, 'at'> | undefined, at: string): void {
  if (!act) return;
  const entry: ShareActivity = { at, ...act };
  if (!entry.name || entry.name === 'client') delete entry.name;
  stats.activity = [...(stats.activity || []), entry].slice(-MAX_ACTIVITY);
}

/**
 * A visit (counted once per visitor per half hour by the route), a name given with a note, or something a visitor did
 * (`act`, for the link's activity). `visitor` is the visitor's key (visitorKey); a visit without one (no storage in
 * that browser) only counts as an open.
 */
export function recordVisit(
  token: string,
  { open = false, name, visitor, act }: { open?: boolean; name?: string; visitor?: string; act?: Omit<ShareActivity, 'at'> } = {},
): void {
  recordStats(token, (stats, at) => {
    if (open) {
      stats.opens += 1;
      stats.last_opened = at;
    }
    remember(stats, name);
    if (visitor) {
      const visitors = stats.visitors || {};
      const prev = visitors[visitor];
      visitors[visitor] = {
        name: (name && name !== 'client' ? name : null) || prev?.name || null,
        first: prev?.first || at,
        last: at,
        opens: (prev?.opens || 0) + (open ? 1 : 0),
        secs: prev?.secs || 0,
      };
      bound(visitors, MAX_VISITORS, (x) => x.last);
      stats.visitors = visitors;
    }
    log(stats, act, at);
  });
}

/**
 * A visitor opened one video's page through the link (the route counts a visitor once per video and half hour). `by`:
 * the name they gave.
 */
export function recordView(token: string, slug: string, v: number, by?: string | null): void {
  recordStats(token, (stats, at) => {
    const videos = stats.videos || {};
    const prev = videos[slug];
    videos[slug] = { ...prev, views: (prev?.views || 0) + 1, last_viewed: at, seen_v: Math.max(prev?.seen_v || 0, v), by: by || prev?.by || null };
    // A folder link over a huge folder stays bounded: the least recently viewed go first.
    bound(videos, SHARE_LIMITS.videos, (x) => x.last_viewed);
    stats.videos = videos;
    log(stats, { kind: 'view', slug, v, name: by || null }, at);
  });
}

/**
 * How much of a video a visitor played since their last report (lib/watch.ts): which hundredths of version `v`, and
 * for how long. The route calls it for every visitor but the team's own previews.
 */
export function recordWatch(
  token: string,
  slug: string,
  visitor: string,
  r: { v: number; seen: string; secs: number; name?: string | null; plays?: number[] | null },
): void {
  recordStats(token, (stats, at) => {
    const videos = stats.videos || {};
    const video = videos[slug] || { views: 0, last_viewed: at, seen_v: r.v, by: null };
    const watch = video.watch || {};
    const before = watch[visitor];
    const merged = mergeWatch(before, { ...r, at });
    if (!merged || merged === before) return;
    const added = before && before.v === merged.v ? merged.secs - before.secs : merged.secs;
    watch[visitor] = merged;
    bound(watch, MAX_WATCHERS, (x) => x.last);
    videos[slug] = { ...video, watch, seen_v: Math.max(video.seen_v || 0, r.v) };
    bound(videos, SHARE_LIMITS.videos, (x) => x.last_viewed);
    boundWatches(videos);
    stats.videos = videos;
    const visitors = stats.visitors || {};
    const who = visitors[visitor];
    visitors[visitor] = {
      name: r.name || who?.name || null,
      first: who?.first || at,
      last: at,
      opens: who?.opens || 0,
      secs: Math.round(((who?.secs || 0) + Math.max(0, added)) * 10) / 10,
    };
    bound(visitors, MAX_VISITORS, (x) => x.last);
    stats.visitors = visitors;
    remember(stats, r.name);
  });
}

/** A download through the link. The routes call this once per download: a resumed range doesn't count again. */
export function recordDownload(token: string, d: Omit<ShareDownloadRecord, 'at'>): void {
  recordStats(token, (stats, at) => {
    stats.downloads = (stats.downloads || 0) + 1;
    stats.last_download = at;
    stats.recent_downloads = [...(stats.recent_downloads || []), { at, ...d }].slice(-20);
    remember(stats, d.name);
    log(stats, { kind: 'download', name: d.name, detail: d.what }, at);
  });
}

// ---------------------------------------------------------------- what a link covers

/** Does the link include this review? Folder links cover the folder and everything below it (a folder that is gone
 * is refused before: resolveShare, listShares); a video link only the video it was made for. */
export function covers(s: Share, review: Review): boolean {
  if (review.archived) return false;
  if (s.folder) return !!review.folder && (review.folder === s.folder || review.folder.startsWith(`${s.folder}/`));
  return slugify(review.video) === s.slug && madeFor(s, review);
}

/** A video link was made for this review, not for one removed before it and added again at the same slug: its id (and,
 * for reviews from before ids, when it was added). Links from before they knew (bindShareTargets binds them at
 * start-up) are taken at their word. */
export const madeFor = (s: Share, review: Pick<Review, 'id' | 'added'>): boolean =>
  (!s.video_id || s.video_id === review.id) && (!s.video_added || s.video_added === review.added);

/** What a video link stores of the review it is made for (madeFor). */
const identityOf = (review: Pick<Review, 'id' | 'added'> | null): Pick<Share, 'video_id' | 'video_added'> =>
  review ? { ...(review.id ? { video_id: review.id } : {}), video_added: review.added } : {};

/**
 * A folder link whose folder was deleted (and maybe made again under the same name): its id is no longer that path's.
 * Throws FoldersUnreadableError while folders.json can't be read: what opens a link refuses meanwhile.
 */
const folderGone = (s: Share): boolean => !!s.folder && !!s.folder_id && folderIdOf(s.folder) !== s.folder_id;

/**
 * The same for what is only shown — the owner's lists of links, the stages: while folders.json can't be read nobody can
 * tell, and the link is shown as it was (never "gone", never dropped), like the library's folders (A12 VE1r2-5).
 */
const shownGone = (s: Share): boolean => {
  try {
    return folderGone(s);
  } catch (e) {
    if (e instanceof FoldersUnreadableError) return false;
    throw e;
  }
};

// ---------------------------------------------------------------- how a link names its videos

const GUEST_ID = /^v_[A-Za-z0-9_-]{16}$/;

/** The name a link's visitors use for one of its videos. A slug is the owner's absolute path in local mode (their
 * username, client and project folders), so guests only ever see this: keyed with the store's secret, stable per link
 * and video, different between links, and not something a visitor can check a guessed path against. */
export const guestId = (s: ShareWithToken, slug: string): string =>
  `v_${crypto
    .createHmac('sha256', shareSecret())
    .update(`video:${shareId(s)}:${slug}`)
    .digest('base64url')
    .slice(0, 16)}`;

/** The slug a visitor's id stands for, if the link covers it. Slugs themselves are still accepted (tabs and bookmarks
 * from before ids): a visitor can only name what they were shown, and a miss looks the same either way. */
export function slugOfGuestId(s: ShareWithToken, id: string): string | null {
  if (!GUEST_ID.test(id)) return id;
  if (!s.folder) return s.slug && guestId(s, s.slug) === id ? s.slug : null;
  for (const r of reviewsOf(s)) {
    const slug = slugify(r.video);
    if (guestId(s, slug) === id) return slug;
  }
  return null;
}

export function reviewsOf(s: Share): Review[] {
  if (!s.folder) {
    const r = s.slug ? loadReview(s.slug) : null;
    return r && covers(s, r) ? [r] : [];
  }
  return listReviews()
    .filter((r) => covers(s, r))
    .sort((a, b) => (a.folder || '').localeCompare(b.folder || '') || path.basename(a.video).localeCompare(path.basename(b.video)));
}

/**
 * Whether this is the only link that ever covered the video, active or revoked. Client notes and verdicts from before
 * they carried their link's id can't say whose they are: they count as a link's own only then — otherwise they could be
 * another client's. Asked lazily (`() => boolean`): most reviews have nothing that old.
 */
function onlyLinkEver(s: ShareWithToken, review: Review): () => boolean {
  let only: boolean | undefined;
  const id = shareId(s);
  // Other links by their stored ids (a key is the token's hash, not the token), this one also by its key.
  const own = tokenKey(s.token);
  return () => {
    only ??= Object.entries(load()).every(([key, x]) => key === own || x.id === id || !covers(x, review));
    return only;
  };
}

/**
 * The client notes a link shows: its own (or every client note with notes: 'all'), older ones by onlyLinkEver. An embed
 * shows none, whatever came in through it (a store edited by hand, or from before a link's kind was fixed when it was
 * made): its token is in other sites' pages — and so none of their screenshots or references (the routes ask this).
 */
export function visibleNotes(s: ShareWithToken, review: Review) {
  if (s.embed) return [];
  const id = shareId(s);
  const all = settingsOf(s).notes === 'all';
  const legacyIsOurs = onlyLinkEver(s, review);
  return review.comments.filter((c) => c.author?.startsWith('guest:') && (all || c.share === id || (!c.share && legacyIsOurs())));
}

/**
 * The clients' verdicts a link shows (lib/stage.ts approvalsOf, the team's left in): with notes: 'own', only the ones
 * given through it — a client of another link has their own name, words and decision ("You asked for changes" would
 * be a lie to this one); with 'all', every client's. A withdrawal without a link applies to every link.
 */
export function visibleVerdicts(s: ShareWithToken, review: Review): ApprovalEntry[] {
  // an embed asks nobody for a decision and shows nobody's (visibleNotes)
  if (s.embed) return [];
  const history = approvalsOf(review);
  if (settingsOf(s).notes === 'all') return history;
  const id = shareId(s);
  const legacyIsOurs = onlyLinkEver(s, review);
  return history.filter((e) => e.party !== 'client' || (e.share ? e.share === id : e.status === 'withdrawn' || legacyIsOurs()));
}

/**
 * Who shared a link, as its visitors see it (before any password too): a name someone chose to go by. The machine's
 * owner starts out named after the OS account (startingName); that name is never shown, their own once they choose
 * one in Profile, also on links made before. On a hosted server every sharer is an account with a chosen name.
 */
export function sharerName(s: Pick<Share, 'by'>): string | null {
  const unchosen = startingName(USER);
  if (s.by && s.by !== unchosen) return s.by;
  const owner = localOwner();
  return owner?.local && owner.name !== unchosen ? owner.name : null;
}

export function shareInfo(s: ShareWithToken): ShareInfo {
  const reviews = reviewsOf(s);
  const id = shareId(s);
  // The video's name, archived or not, but never that of another video added later under the same slug.
  const at = !s.folder && s.slug ? loadReview(s.slug) : null;
  const review = at && madeFor(s, at) ? at : null;
  const newest = review?.versions.at(-1);
  const stats = s.stats || emptyStats();
  // The records per visitor and per video stay on the server; the owner gets them summed up in `activity`.
  const { visitors: _visitors, videos: _videos, activity: _activity, ...counts } = stats;
  return {
    ...settingsOf(s),
    token: s.token,
    id,
    label: s.label,
    created: s.created,
    by: s.by,
    sharer: sharerName(s),
    updated: s.updated || null,
    kind: s.folder ? 'folder' : 'video',
    slug: s.folder ? null : s.slug || null,
    folder: s.folder || null,
    name: review ? path.basename(review.video) : null,
    ...(newest ? { width: newest.width, height: newest.height } : {}),
    password: !!s.password,
    expired: isExpired(s),
    stats: {
      ...counts,
      notes: reviews.reduce((n, r) => n + r.comments.filter((c) => c.author?.startsWith('guest:') && (c.share === id || (!c.share && !s.folder))).length, 0),
    },
    activity: summarizeActivity(stats, reviews),
  };
}

export const guestName = (name: unknown): string =>
  String(name || '')
    .replace(/[^\p{L}\p{N} ._-]/gu, '')
    .trim()
    .slice(0, 40) || 'client';
