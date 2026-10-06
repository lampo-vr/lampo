// Posts of final videos: one per platform per final version, kept per workspace in data/publish/posts.json under one
// lock. People and agents write drafts (draft_post, `vr post draft`, the composer); only a person publishes one, after
// the gate here says yes: the video is final and nothing newer arrived, the post names that final render, nothing in it
// breaks a platform's rule, the required answers are given, and the person confirmed the platform and account it now
// names. The queue (lib/publish/queue.ts) sends it; what happens is told as `post` events (webhooks, push, the inbox).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkReviewOpen } from '../folderIds.ts';
import { dataDir, isoLocal, slugify } from '../paths.ts';
import { renderKey } from '../renderKey.ts';
import { stageOf } from '../stage.ts';
import { listReviews, loadReview, logEvent, withLock, writeAtomic } from '../store.ts';
import { compareTime, oneLine } from '../time.ts';
import type {
  Post,
  PostEventInfo,
  PostFields,
  PostHistoryEntry,
  PostState,
  PostView,
  PublishConfirm,
  PublishedSignal,
  PublishPlatform,
  Review,
  Version,
} from '../types.ts';
import { connectionInfo, findConnection, holdsSchedule, listConnections, platformsOf, type StoredConnection } from './connections.ts';
import { kitInfo } from './kit.ts';
import {
  DEFAULT_YOUTUBE_CATEGORY,
  PLATFORM_LIMITS,
  PLATFORM_NAMES,
  postProblems,
  problemsLine,
  publishable,
  YOUTUBE_CATEGORIES,
  youtubeStudioUrl,
} from './platforms.ts';

/** A post as stored: the public fields, the upload to resume (sealed), and when the queue last asked the platform. */
export interface StoredPost extends Post {
  session?: string;
  checked_at?: string;
  checks?: number;
  /** Publishes and retries so far: a send's idempotency key is the post's and its round (a lost answer, same key). */
  round?: number;
  /** When this round's send reached the request that can make the post exist (A12 PUB-1: never sent again by itself). */
  committed_at?: string;
}

const dir = (): string => path.join(dataDir(), 'publish');
const FILE = (): string => path.join(dir(), 'posts.json');
const LOCK = (): string => path.join(dir(), '.posts');
/** Posts one workspace keeps (drafts and history together); the oldest finished ones go first past it. */
export const POSTS_MAX = 5000;
/** Field sizes stored at most (each platform's own, smaller limits are checked by postProblems). */
export const POST_FIELD_MAX = { title: 500, description: 70000, tags: 60, tag: 120 };
/** States a person or an agent may still change. */
const EDITABLE: PostState[] = ['draft', 'failed', 'cancelled'];
/** States the queue works on. */
export const LIVE: PostState[] = ['queued', 'uploading', 'scheduled'];
/** Kept past the cap like live ones: a person still has to look (sent, not confirmed). */
const OPEN: PostState[] = [...EDITABLE, ...LIVE, 'sent'];

/** A refusal with its HTTP status (409: the video or the post isn't where it must be). */
export class PostError extends Error {
  status: number;
  /** What to do instead, when there is something. */
  next?: string;
  constructor(status: number, message: string, next?: string) {
    super(message);
    this.status = status;
    if (next) this.next = next;
  }
}

/** Every post of this workspace (none when there is no file; a file that can't be read throws). */
export function listPosts(): StoredPost[] {
  let text: string;
  try {
    text = fs.readFileSync(FILE(), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const parsed = JSON.parse(text) as { posts?: StoredPost[] };
  return Array.isArray(parsed?.posts) ? parsed.posts : [];
}

/** The posts as lists show them: a damaged file costs the list (logged once), never the page. */
let warned = '';
export function shownPosts(): StoredPost[] {
  try {
    return listPosts();
  } catch (e) {
    const msg = (e as Error).message;
    if (warned !== msg) console.error(`posts: ${FILE()} can't be read (${msg}); posts are hidden until it can`);
    warned = msg;
    return [];
  }
}

export const findPost = (id: string): StoredPost | null => shownPosts().find((p) => p.id === id) ?? null;
/**
 * Whether a post is of this video: its slug, and its video's id when both carry one. A video deleted and another of the
 * same name added later is another video: the old posts stay the old one's (A12 PUB-7).
 */
export const ofVideo = (p: Pick<Post, 'slug' | 'video_id'>, review: Pick<Review, 'id' | 'video'> | null): boolean =>
  !!review && p.slug === slugify(review.video) && (!p.video_id || !review.id || p.video_id === review.id);

/** A video's posts (its own: see ofVideo); none when the video is gone. */
export const postsOf = (slug: string): StoredPost[] => {
  const review = loadReview(slug);
  return review ? shownPosts().filter((p) => ofVideo(p, review)) : [];
};

function save(all: StoredPost[]): void {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  // past the cap, the oldest finished posts go (drafts and live ones stay)
  let kept = all;
  if (kept.length > POSTS_MAX) {
    const done = kept.filter((p) => !OPEN.includes(p.state)).sort((a, b) => compareTime(a.updated, b.updated));
    const drop = new Set(done.slice(0, kept.length - POSTS_MAX).map((p) => p.id));
    kept = kept.filter((p) => !drop.has(p.id));
  }
  writeAtomic(FILE(), `${JSON.stringify({ posts: kept }, null, 2)}\n`);
  shapeCache.delete(FILE());
}

/** Changes one post under the lock (read fresh); throws a 404 when this workspace has none with that id. */
export function changePost<T>(id: string, fn: (p: StoredPost, all: StoredPost[]) => T): T {
  return withLock(LOCK(), () => {
    const all = listPosts();
    const p = all.find((x) => x.id === id);
    if (!p) throw new PostError(404, 'no such post');
    const out = fn(p, all);
    save(all);
    return out;
  });
}

const note = (p: StoredPost, state: PostState, by: string, text?: string): void => {
  const h: PostHistoryEntry = { at: isoLocal(), state, by, ...(text ? { note: oneLine(text).slice(0, 400) } : {}) };
  p.history = [...(p.history ?? []), h].slice(-50);
};

// ---------------------------------------------------------------- what goes out, as the person saw it (A12 PUB-3)

/** The fields that go out, with the word the history uses for each. */
const OUTGOING = [
  ['connection', 'connection'],
  ['account', 'account'],
  ['title', 'title'],
  ['description', 'description'],
  ['tags', 'tags'],
  ['cover_frame', 'cover'],
  ['visibility', 'visibility'],
  ['schedule_at', 'time'],
  ['ai_generated', 'AI answer'],
  ['youtube', 'YouTube fields'],
  ['instagram', 'Instagram fields'],
] as const;

/** JSON with the keys in one order, so the same fields always hash the same. */
const stable = (v: unknown): string =>
  v === null || typeof v !== 'object'
    ? JSON.stringify(v ?? null)
    : Array.isArray(v)
      ? `[${v.map(stable).join(',')}]`
      : `{${Object.keys(v as Record<string, unknown>)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
          .join(',')}}`;

/**
 * A hash of everything that goes out (and of which final it is). The person's confirm carries the one they saw, so an
 * edit after they looked — an agent's, or another tab's — is a 409, never what goes out under their name.
 */
export function digestOf(p: Post): string {
  const out: Record<string, unknown> = { platform: p.platform, v: p.v, render: p.render };
  for (const [k] of OUTGOING) out[k] = p[k] ?? null;
  return crypto.createHash('sha256').update(stable(out)).digest('hex').slice(0, 16);
}

/** The words for the outgoing fields an edit changed. */
function changedFields(before: Post, after: Post): string[] {
  return OUTGOING.filter(([k]) => stable(before[k] ?? null) !== stable(after[k] ?? null)).map(([, word]) => word);
}

/** While one person keeps editing (the composer saves as they type), their edits are one line, kept up to date. */
const EDIT_RUN_MS = 10 * 60e3;

/** An edit in the history, with who made it: "changed: title, description". */
function noteEdit(p: StoredPost, by: string, words: string[], wasDraft: boolean): void {
  if (!words.length && wasDraft) return;
  const last = p.history?.at(-1);
  const prefix = 'changed: ';
  if (wasDraft && last?.state === 'draft' && last.by === by && last.note?.startsWith(prefix) && Date.now() - Date.parse(last.at) < EDIT_RUN_MS) {
    const had = last.note.slice(prefix.length).split(', ');
    last.note = oneLine(`${prefix}${[...new Set([...had, ...words])].join(', ')}`).slice(0, 400);
    last.at = isoLocal();
    return;
  }
  note(p, 'draft', by, `${prefix}${words.length ? words.join(', ') : 'nothing'}${wasDraft ? '' : ' · a draft again'}`);
}

// ---------------------------------------------------------------- the final, and what a post may say

/** The final version a post is for, or why there is none: the reason as a sentence, and the stage's next step. */
export function finalOf(review: Review): { v: number; ver: Version } | { why: string; next: string } {
  const final = review.final;
  const stage = stageOf(review);
  const name = path.basename(review.video);
  if (!final) return { why: `${name} isn't final (${stage.stage}): posts are drafted for a final version`, next: stage.next.label };
  const latest = review.versions.at(-1);
  if (latest && latest.v > final.v) return { why: `${name}: V${latest.v} arrived after the final V${final.v}`, next: stage.next.label };
  const ver = review.versions.find((x) => x.v === final.v);
  if (!ver) return { why: `${name}: the final V${final.v} is gone`, next: 'Reopen it' };
  return { v: final.v, ver };
}

/** Why a post can't go out any more (its final moved), or null while it still can. */
export function gateOf(review: Review | null, p: Pick<Post, 'v' | 'render'> & Partial<Pick<Post, 'slug' | 'video_id'>>): string | null {
  if (!review || (p.slug !== undefined && !ofVideo({ slug: p.slug, video_id: p.video_id }, review))) return 'the video is gone';
  const f = finalOf(review);
  if ('why' in f) return review.final ? f.why : 'the video was reopened: it isn’t final any more';
  if (f.v !== p.v) return `V${f.v} is final now, not V${p.v}`;
  if (renderKey(f.ver) !== p.render) return `the final V${p.v} isn't the render it was drafted for`;
  return null;
}

const clip = (s: string | undefined, max: number): string => [...String(s ?? '')].slice(0, max).join('');

/** What was sent, made safe to keep: lengths bounded, tags cleaned, the time normalised, platform fields of the platform only. */
export function cleanFields(platform: PublishPlatform, f: PostFields): PostFields {
  const out: PostFields = {};
  if (f.connection !== undefined) out.connection = f.connection ? String(f.connection).slice(0, 40) : null;
  if (f.account !== undefined) out.account = f.account ? String(f.account).slice(0, 120) : null;
  if (f.title !== undefined) out.title = clip(f.title.replace(/\s+/g, ' ').trim(), POST_FIELD_MAX.title);
  if (f.description !== undefined) out.description = clip(f.description.replace(/\r\n?/g, '\n'), POST_FIELD_MAX.description);
  if (f.tags !== undefined)
    out.tags = [
      ...new Set(
        f.tags
          .map((t) => clip(String(t).replace(/^#/, '').replace(/\s+/g, ' ').trim(), POST_FIELD_MAX.tag))
          .filter(Boolean)
          .slice(0, POST_FIELD_MAX.tags),
      ),
    ];
  if (f.cover_frame !== undefined) out.cover_frame = f.cover_frame === null ? null : Math.max(0, Math.floor(Number(f.cover_frame)) || 0);
  if (f.visibility !== undefined) out.visibility = f.visibility;
  if (f.schedule_at !== undefined) {
    if (f.schedule_at === null || f.schedule_at === '') out.schedule_at = null;
    else {
      const t = Date.parse(f.schedule_at);
      if (!Number.isFinite(t))
        throw new PostError(400, `"${oneLine(String(f.schedule_at)).slice(0, 40)}" is no time (ISO 8601, e.g. 2026-10-09T14:00:00+02:00)`);
      out.schedule_at = new Date(t).toISOString();
    }
  }
  if (f.ai_generated !== undefined) out.ai_generated = f.ai_generated;
  if (platform === 'youtube' && f.youtube) {
    out.youtube = {};
    if (f.youtube.category !== undefined) {
      const c = String(f.youtube.category);
      if (!YOUTUBE_CATEGORIES.some((x) => x.id === c))
        throw new PostError(400, `${c} is no YouTube category (${YOUTUBE_CATEGORIES.map((x) => `${x.id} ${x.name}`).join(', ')})`);
      out.youtube.category = c;
    }
    if (f.youtube.made_for_kids !== undefined) out.youtube.made_for_kids = f.youtube.made_for_kids;
  }
  if (platform === 'instagram' && f.instagram) {
    out.instagram = {};
    if (f.instagram.kind !== undefined) out.instagram.kind = f.instagram.kind;
    if (f.instagram.share_to_feed !== undefined) out.instagram.share_to_feed = f.instagram.share_to_feed;
  }
  return out;
}

function apply(p: StoredPost, f: PostFields): void {
  if (f.connection !== undefined) {
    p.connection = f.connection;
    // another connection: its account for this platform, unless one was named too
    if (f.account === undefined) p.account = defaultAccount(f.connection ? findConnection(f.connection) : null, p.platform);
  }
  if (f.account !== undefined) p.account = f.account;
  if (f.title !== undefined) p.title = f.title;
  if (f.description !== undefined) p.description = f.description;
  if (f.tags !== undefined) p.tags = f.tags;
  if (f.cover_frame !== undefined) p.cover_frame = f.cover_frame;
  if (f.visibility !== undefined) p.visibility = f.visibility;
  if (f.schedule_at !== undefined) p.schedule_at = f.schedule_at;
  if (f.ai_generated !== undefined) p.ai_generated = f.ai_generated;
  if (f.youtube) p.youtube = { ...p.youtube, ...f.youtube };
  if (f.instagram) p.instagram = { ...p.instagram, ...f.instagram };
}

const defaultAccount = (c: StoredConnection | null, platform: PublishPlatform): string | null => c?.accounts.find((a) => a.platform === platform)?.id ?? null;

/** The cover frame inside the version: a frame past its end is its last (A12 PUB-9). */
function holdCover(p: StoredPost, ver: Pick<Version, 'frames'>): void {
  if (p.cover_frame !== null && ver.frames > 0) p.cover_frame = Math.min(p.cover_frame, ver.frames - 1);
}

/** The one ready connection that posts to the platform, if there is exactly one. */
function defaultConnection(platform: PublishPlatform): StoredConnection | null {
  let all: StoredConnection[] = [];
  try {
    all = listConnections();
  } catch {}
  const fits = all.filter((c) => c.state === 'ready' && platformsOf(c).includes(platform));
  return fits.length === 1 ? (fits[0] as StoredConnection) : null;
}

const newId = (): string => `po_${crypto.randomBytes(6).toString('hex')}`;

/** A video's name without its extension: the title a post starts with. */
const titleOf = (review: Review): string =>
  path
    .basename(review.video)
    .replace(/\.[^.]+$/, '')
    .replace(/[_]+/g, ' ')
    .trim();

export interface DraftInput {
  slug: string;
  platform: PublishPlatform;
  fields: PostFields;
  by: string;
  by_id?: string;
  /** A person in the app (not an API token, an MCP tool or `vr`): only a person changes a failed or cancelled post. */
  person?: boolean;
}

/** A failed or cancelled post is the inbox's work for who may publish: an agent turning it into a draft would take it
 * out of there, so only a person changes it (A12 PUB-6). Drafts are everyone's who may draft. */
function agentKeepsOff(p: StoredPost, person: boolean | undefined): void {
  if (!person && p.state !== 'draft') throw new PostError(403, `the post is ${p.state}: a person changes it in the app (agents change drafts only)`);
}

/**
 * Writes the draft of the video's final version for one platform: made the first time (from the same platform's post
 * of an earlier final when there is one), changed after. Refused (409) when the video isn't final, or when that post
 * was published already.
 */
export function draftPost(input: DraftInput): { post: StoredPost; created: boolean } {
  const review = loadReview(input.slug);
  if (!review) throw new PostError(404, 'unknown video');
  checkReviewOpen(review);
  const f = finalOf(review);
  if ('why' in f) throw new PostError(409, f.why, f.next);
  const fields = cleanFields(input.platform, input.fields);
  const out = withLock(LOCK(), () => {
    const all = listPosts();
    const here = all.find((p) => ofVideo(p, review) && p.v === f.v && p.platform === input.platform);
    if (here) {
      if (!EDITABLE.includes(here.state))
        throw new PostError(
          409,
          `the ${PLATFORM_NAMES[input.platform]} post of V${f.v} is ${here.state} already: ${here.state === 'posted' ? 'it is out' : 'cancel it first to change it'}`,
        );
      agentKeepsOff(here, input.person);
      const was = structuredClone(here);
      apply(here, fields);
      holdCover(here, f.ver);
      noteEdit(here, input.by, changedFields(was, here), was.state === 'draft');
      if (here.state !== 'draft') {
        here.state = 'draft';
        delete here.error;
      }
      here.updated = isoLocal();
      save(all);
      return { post: here, created: false };
    }
    const before = all
      .filter((p) => ofVideo(p, review) && p.platform === input.platform && p.v < f.v)
      .sort((a, b) => b.v - a.v || compareTime(b.updated, a.updated))[0];
    const conn = before?.connection ? findConnection(before.connection) : defaultConnection(input.platform);
    const now = isoLocal();
    const post: StoredPost = {
      id: newId(),
      slug: input.slug,
      ...(review.id ? { video_id: review.id } : {}),
      v: f.v,
      render: renderKey(f.ver),
      platform: input.platform,
      connection: conn?.id ?? null,
      account: before?.account && conn?.accounts.some((a) => a.id === before.account) ? before.account : defaultAccount(conn, input.platform),
      title: before?.title ?? (PLATFORM_LIMITS[input.platform].title ? titleOf(review) : ''),
      description: before?.description ?? '',
      tags: before?.tags ?? [],
      cover_frame: before?.cover_frame !== null && before?.cover_frame !== undefined && before.cover_frame < f.ver.frames ? before.cover_frame : null,
      visibility: before?.visibility ?? (PLATFORM_LIMITS[input.platform].visibilities.includes('public') ? 'public' : 'private'),
      schedule_at: null,
      ai_generated: before?.ai_generated ?? null,
      ...(input.platform === 'youtube'
        ? { youtube: { category: before?.youtube?.category ?? DEFAULT_YOUTUBE_CATEGORY, made_for_kids: before?.youtube?.made_for_kids ?? null } }
        : {}),
      ...(input.platform === 'instagram'
        ? { instagram: { kind: before?.instagram?.kind ?? 'reel', share_to_feed: before?.instagram?.share_to_feed ?? true } }
        : {}),
      state: 'draft',
      created: now,
      by: input.by,
      ...(input.by_id ? { by_id: input.by_id } : {}),
      updated: now,
      history: [],
    };
    apply(post, fields);
    holdCover(post, f.ver);
    note(post, 'draft', input.by, before ? `drafted from V${before.v}'s post` : 'drafted');
    all.push(post);
    save(all);
    logPostEvent(review, post, input.by);
    return { post, created: true };
  });
  return out;
}

/** Changes a draft (or a failed or cancelled post, which becomes a draft again). */
export function updatePost(id: string, fields: PostFields, by: string, o: { person?: boolean } = {}): StoredPost {
  return changePost(id, (p) => {
    if (!EDITABLE.includes(p.state)) throw new PostError(409, `the post is ${p.state}: ${p.state === 'posted' ? 'it is out' : 'cancel it first to change it'}`);
    agentKeepsOff(p, o.person);
    const was = structuredClone(p);
    apply(p, cleanFields(p.platform, fields));
    const ver = loadReview(p.slug)?.versions.find((x) => x.v === p.v);
    if (ver) holdCover(p, ver);
    noteEdit(p, by, changedFields(was, p), was.state === 'draft');
    if (p.state !== 'draft') {
      p.state = 'draft';
      delete p.error;
    }
    p.updated = isoLocal();
    return p;
  });
}

/**
 * Removes a draft, or a failed or cancelled post (a person's only). A post that went out, is on its way, or that the
 * platform holds (`remote_id`) stays: it is history, and the only record of what is out there (A12 PUB-6).
 */
export function deletePost(id: string, o: { person?: boolean } = {}): StoredPost {
  return withLock(LOCK(), () => {
    const all = listPosts();
    const p = all.find((x) => x.id === id);
    if (!p) throw new PostError(404, 'no such post');
    if (!EDITABLE.includes(p.state)) throw new PostError(409, `the post is ${p.state}: only a draft is deleted`);
    if (p.remote_id) throw new PostError(409, `it went out before (${p.remote_id} at the platform): it stays as the record of that`);
    agentKeepsOff(p, o.person);
    save(all.filter((x) => x.id !== id));
    return p;
  });
}

// ---------------------------------------------------------------- what a post looks like to people and agents

/** A post as the API shows it: what it breaks, the connection's and account's names, the kit; never the upload session. */
export function viewOf(p: StoredPost, o: { review?: Review | null; connections?: StoredConnection[]; hosted?: boolean; now?: number } = {}): PostView {
  const found = o.review === undefined ? loadReview(p.slug) : o.review;
  // an orphan (its video deleted, maybe another of the same name since) knows no video
  const review = found && ofVideo(p, found) ? found : null;
  const conn = (o.connections ?? safeConnections()).find((c) => c.id === p.connection) ?? null;
  const ver = review?.versions.find((x) => x.v === p.v);
  const facts = ver ? { duration: ver.duration, width: ver.width, height: ver.height, frames: ver.frames } : { duration: 0, width: 0, height: 0, frames: 0 };
  const info = conn ? connectionInfo(conn) : null;
  const problems = EDITABLE.includes(p.state) ? postProblems(p, facts, { connection: info, now: o.now, hosted: o.hosted }) : [];
  if (EDITABLE.includes(p.state) && review) {
    const why = gateOf(review, p);
    if (why) problems.unshift({ field: 'final', level: 'block', code: 'not_final', message: why });
  }
  const { session: _s, checked_at: _c, checks: _n, round: _r, committed_at: _m, ...pub } = p;
  return {
    ...pub,
    problems,
    video: review ? path.basename(review.video) : p.slug,
    connection_label: conn?.label ?? null,
    account_name: conn?.accounts.find((a) => a.id === p.account)?.name ?? null,
    holds_schedule: conn ? holdsSchedule(conn.kind) : PLATFORM_LIMITS[p.platform].holdsSchedule,
    digest: digestOf(p),
    ...(p.platform === 'youtube' && p.remote_id ? { studio_url: youtubeStudioUrl(p.remote_id) } : {}),
    kit: kitInfo(p.id),
  };
}

function safeConnections(): StoredConnection[] {
  try {
    return listConnections();
  } catch {
    return [];
  }
}

/** The post's problems when a person publishes it now (stricter than a draft's). */
export function publishProblems(p: StoredPost, review: Review, o: { hosted?: boolean; now?: number } = {}) {
  const conn = findConnection(p.connection);
  const ver = review.versions.find((x) => x.v === p.v);
  const facts = ver ? { duration: ver.duration, width: ver.width, height: ver.height, frames: ver.frames } : { duration: 0, width: 0, height: 0, frames: 0 };
  return postProblems(p, facts, { connection: conn ? connectionInfo(conn) : null, publishing: true, hosted: o.hosted, now: o.now });
}

// ---------------------------------------------------------------- a person publishes, cancels, tries again

export interface PublishInput {
  confirm: PublishConfirm;
  by: string;
  by_id?: string;
  hosted?: boolean;
  /** The person asks to post it again although it went out before (`remote_id`, or `sent`): never assumed. */
  again?: boolean;
}

/** Why a post that went out before isn't sent again unless a person asks: what Lampo knows of it, as a sentence. */
function wentOutBefore(p: StoredPost): string {
  const where = p.url ? ` (${p.url})` : '';
  return p.state === 'sent' || !p.remote_id
    ? `it went out before and the platform never said whether it is out${where}: look on the platform, and post it again only if it isn't there`
    : `it went out before${where}: the platform holds it as ${p.remote_id}; post it again only if it isn't there`;
}

/**
 * Whether a post may be out without Lampo knowing: a try reached the request that makes the post (YouTube's last bytes,
 * Zernio's post call) and no answer named it. Such a post is never failed or cancelled into something Retry or a new
 * publish sends again as if nothing went out: it is `sent`, for a person to look (A12 PUB-1).
 */
export const maybeOut = (p: Pick<StoredPost, 'committed_at' | 'remote_id'>): boolean => !!p.committed_at && !p.remote_id;

/** Whether a post went out before, or may have: what the platform holds, `sent`, or a try that got as far as the post. */
const wentOut = (p: StoredPost): boolean => !!p.remote_id || p.state === 'sent' || maybeOut(p);

/** The fields a new round of a post leaves behind: what the platform answered the round before. */
function freshRound(p: StoredPost): void {
  delete p.error;
  delete p.url;
  delete p.remote_id;
  delete p.locked;
  delete p.progress;
  delete p.file;
  delete p.session;
  delete p.committed_at;
}

/**
 * A person publishes a post: the gate, then `queued` (the queue sends it now, or at its time when Lampo is the one to
 * send it). Refused with 409 and the reason when the video isn't final, the post breaks a rule, a required answer is
 * missing, or the post no longer names what the person confirmed.
 */
export function publishPost(id: string, input: PublishInput): StoredPost {
  const p0 = findPost(id);
  if (!p0) throw new PostError(404, 'no such post');
  const review = loadReview(p0.slug);
  const why = gateOf(review, p0);
  if (why || !review) throw new PostError(409, why ?? 'the video is gone');
  return changePost(id, (p) => {
    if (!['draft', 'failed', 'cancelled', 'sent'].includes(p.state)) throw new PostError(409, `the post is ${p.state} already`);
    if (wentOut(p) && !input.again) throw new PostError(409, wentOutBefore(p));
    if (input.confirm.platform !== p.platform || (input.confirm.account ?? null) !== (p.account ?? null))
      throw new PostError(409, 'the post changed since you confirmed it: look at it again');
    // no digest, no publish: a confirm that doesn't say what the person saw can't say it is what goes out (PUB-3)
    if (typeof input.confirm.digest !== 'string' || input.confirm.digest !== digestOf(p))
      throw new PostError(409, 'the post changed since you looked at it: look at it again');
    const problems = publishProblems(p, review, { hosted: input.hosted });
    if (!publishable(problems))
      throw new PostError(
        409,
        `it can't be published yet: ${problems
          .filter((x) => x.level === 'block')
          .map((x) => x.message)
          .join('; ')}`,
      );
    const conn = findConnection(p.connection) as StoredConnection;
    const now = isoLocal();
    const again = wentOut(p);
    p.state = 'queued';
    p.published_by = input.by;
    if (input.by_id) p.published_by_id = input.by_id;
    else delete p.published_by_id;
    p.published_at = now;
    p.attempts = 0;
    p.round = (p.round ?? 0) + 1;
    // Lampo sends it at its time when the connection doesn't hold a schedule; else now (the platform holds it).
    const later = p.schedule_at && !holdsSchedule(conn.kind) && Date.parse(p.schedule_at) > Date.now() ? p.schedule_at : null;
    p.next_try = later ?? now;
    freshRound(p);
    p.updated = now;
    note(
      p,
      'queued',
      input.by,
      `${again ? 'published again, although it went out before' : 'published'}${later ? `: Lampo sends it at ${p.schedule_at}` : ''}`,
    );
    logPostEvent(review, p, input.by);
    return p;
  });
}

/**
 * Takes back a post that hasn't gone out (queued, or failed): cancelled. A schedule the platform holds is the queue's.
 * One that may be out already (its try got as far as the post: `maybeOut`) stops trying and is `sent`, not confirmed.
 */
export function cancelQueued(id: string, by: string, why = 'cancelled'): StoredPost {
  return changePost(id, (p) => {
    if (p.state !== 'queued' && p.state !== 'failed') throw new PostError(409, `the post is ${p.state}`);
    const said = why === 'cancelled' ? `Cancelled by ${by}.` : why;
    delete p.next_try;
    p.updated = isoLocal();
    if (maybeOut(p)) {
      p.state = 'sent';
      p.error = `${said} A try before got as far as the post: it may have gone out — look on the platform.`;
      delete p.progress;
      note(p, 'sent', by, p.error);
    } else {
      p.state = 'cancelled';
      p.error = said;
      delete p.session;
      note(p, 'cancelled', by, why);
    }
    logPostEvent(loadReview(p.slug), p, by);
    return p;
  });
}

/**
 * Retry of a failed post, or of one sent but not confirmed. A post that never reached the platform is sent again (a new
 * round). One the platform holds (`remote_id`) is never sent again by Retry: the queue asks the platform where it
 * stands (A12 PUB-1). One sent without an answer can't be asked about: it is sent again only when a person asks
 * (`again`), after looking on the platform.
 */
export function retryPost(id: string, by: string, o: { again?: boolean } = {}): StoredPost {
  const p0 = findPost(id);
  if (!p0) throw new PostError(404, 'no such post');
  const review = loadReview(p0.slug);
  return changePost(id, (p) => {
    if (p.state !== 'failed' && p.state !== 'sent') throw new PostError(409, `the post is ${p.state}: only a failed post is tried again`);
    const t = isoLocal();
    if (p.remote_id && !o.again) {
      // asked again: the platform's answer decides, nothing is sent
      p.state = 'uploading';
      p.next_try = t;
      delete p.error;
      p.updated = t;
      note(p, 'uploading', by, 'asked the platform again where it stands');
      return p;
    }
    if (wentOut(p) && !o.again) throw new PostError(409, wentOutBefore(p));
    const why = gateOf(review, p);
    if (why) throw new PostError(409, why);
    const again = wentOut(p);
    p.state = 'queued';
    p.attempts = 0;
    p.round = (p.round ?? 0) + 1;
    p.next_try = t;
    freshRound(p);
    p.updated = t;
    note(p, 'queued', by, again ? 'sent again, although it went out before' : 'tried again');
    logPostEvent(review, p, by);
    return p;
  });
}

// ---------------------------------------------------------------- what others hear and see

/** The event of a post's new state (webhooks, push, the feed): who, which post, where it stands. Never a secret. */
export function logPostEvent(review: Review | null, p: Post, by: string): void {
  if (!review) return;
  const conn = findConnectionQuiet(p.connection);
  const account = conn?.accounts.find((a) => a.id === p.account)?.name ?? null;
  const info: PostEventInfo = {
    id: p.id,
    platform: p.platform,
    state: p.state,
    ...(p.url ? { url: p.url } : {}),
    ...(account ? { account } : {}),
    ...(p.error && (p.state === 'failed' || p.state === 'cancelled') ? { error: p.error } : {}),
  };
  logEvent({ type: 'post', by, review, v: p.v, text: postLine(p, account), post: info });
}

function findConnectionQuiet(id: string | null): StoredConnection | null {
  try {
    return findConnection(id);
  } catch {
    return null;
  }
}

/** One line for a post, as agents, webhooks and `vr` read it: "YouTube posted (Brand channel) https://…". */
export function postLine(p: Pick<Post, 'platform' | 'state' | 'url' | 'schedule_at' | 'error' | 'locked' | 'v'>, account?: string | null): string {
  const name = PLATFORM_NAMES[p.platform];
  const to = account ? ` (${account})` : '';
  switch (p.state) {
    case 'draft':
      return `${name} V${p.v} drafted${to}`;
    case 'queued':
      return `${name} V${p.v} published${to}${p.schedule_at ? ` for ${p.schedule_at}` : ''}`;
    case 'uploading':
      return `${name} V${p.v} uploading${to}`;
    case 'scheduled':
      return `${name} V${p.v} scheduled${to} for ${p.schedule_at}${p.url ? ` ${p.url}` : ''}`;
    case 'posted':
      return `${name} V${p.v} posted${to}${p.url ? ` ${p.url}` : ''}${p.locked ? ' (kept private by YouTube: make it public in YouTube Studio)' : ''}`;
    case 'failed':
      return `${name} V${p.v} failed${to}: ${p.error ?? 'no reason given'}`;
    case 'cancelled':
      return `${name} V${p.v} cancelled${to}${p.error ? `: ${p.error}` : ''}`;
    case 'sent':
      return `${name} V${p.v} sent, not confirmed${to}${p.url ? ` ${p.url}` : ''}: ${p.error ?? 'look on the platform'}`;
  }
}

/** One post in a line, as agents read it (draft_post, get_posts, `vr post`): where it stands, what it still needs, where a
 * person opens it. */
export function postLines(p: PostView, appUrl?: string | null): string {
  const head = `${p.id} ${postLine(p, p.account_name)}`;
  const needs = p.state === 'draft' || p.state === 'failed' || p.state === 'cancelled' ? problemsLine(p.problems) : '';
  const link = appUrl ? ` · ${appUrl}/#/v/${encodeURIComponent(p.slug)}?publish=${p.id}` : '';
  return oneLine(`${head}${needs ? ` · ${needs}` : p.state === 'draft' ? ' · ready for a person to publish' : ''}${link}`);
}

// The stage's "Published" line is asked for on every card of a library: the posts are grouped by video once per change.
const shapeCache = new Map<string, { key: string; bySlug: Map<string, StoredPost[]> }>();
function postsBySlug(): Map<string, StoredPost[]> {
  const file = FILE();
  let key = '';
  try {
    const st = fs.statSync(file);
    key = `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return new Map();
  }
  const hit = shapeCache.get(file);
  if (hit?.key === key) return hit.bySlug;
  const bySlug = new Map<string, StoredPost[]>();
  for (const p of shownPosts()) bySlug.set(p.slug, [...(bySlug.get(p.slug) ?? []), p]);
  shapeCache.set(file, { key, bySlug });
  return bySlug;
}

/** What the stage says of a video's posts: those of its final version (else its newest with posts) that left the draft. */
export function postSignal(review: Review): PublishedSignal | undefined {
  const mine = postsBySlug().get(slugify(review.video));
  if (!mine?.length) return undefined;
  const out = mine.filter((p) => p.state !== 'draft' && ofVideo(p, review));
  if (!out.length) return undefined;
  const v = review.final && out.some((p) => p.v === review.final?.v) ? review.final.v : Math.max(...out.map((p) => p.v));
  return {
    v,
    posts: out
      .filter((p) => p.v === v)
      .map((p) => ({
        id: p.id,
        platform: p.platform,
        state: p.state,
        at: p.updated,
        ...(p.url ? { url: p.url } : {}),
        ...(p.locked ? { locked: true } : {}),
      })),
  };
}

/** Failed posts, newest first, with the video they are of (the inbox's `post` items). */
export function failedPosts(): { post: StoredPost; review: Review; account: string | null }[] {
  const failed = shownPosts().filter((p) => p.state === 'failed' || p.state === 'sent');
  if (!failed.length) return [];
  const reviews = new Map(listReviews().map((r) => [slugify(r.video), r]));
  const conns = safeConnections();
  return failed
    .map((p) => ({
      post: p,
      review: reviews.get(p.slug) as Review,
      account: conns.find((c) => c.id === p.connection)?.accounts.find((a) => a.id === p.account)?.name ?? null,
    }))
    .filter((x) => ofVideo(x.post, x.review ?? null))
    .sort((a, b) => compareTime(b.post.updated, a.post.updated));
}
