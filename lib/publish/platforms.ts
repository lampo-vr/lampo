// What each platform takes, and what a post of a final video breaks: one place the server (before it publishes), the
// agents (draft_post's answer) and the UI (the composer's limits, inline) read alike. Browser-safe: no Node imports.
// The numbers come from the platforms' own documents as checked on 2 Oct 2026 (docs/publishing.md lists the sources);
// where a platform states two (Instagram's daily limit), the stricter one is used.
import type { PostFields, PostProblem, PostVisibility, PublishAccount, PublishPlatform } from '../types.ts';

export const PLATFORMS: readonly PublishPlatform[] = ['youtube', 'instagram', 'facebook'];

/** The platforms' names as people read them (brand names: never translated). */
export const PLATFORM_NAMES: Record<PublishPlatform, string> = { youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook' };

/** Short codes agents may use (`vr post draft --platform yt`, draft_post's `platform`). */
const SHORT: Record<string, PublishPlatform> = { yt: 'youtube', ig: 'instagram', fb: 'facebook' };

/** A platform from its name or short code; null when it isn't one. */
export function platformOf(s: string | null | undefined): PublishPlatform | null {
  const k = String(s || '')
    .trim()
    .toLowerCase();
  if ((PLATFORMS as readonly string[]).includes(k)) return k as PublishPlatform;
  return SHORT[k] ?? null;
}

export interface PlatformLimits {
  /** Characters of a title; 0 = the platform takes no title (Instagram: it is only in the kit's copy). */
  title: number;
  /** Characters of the description or caption. */
  description: number;
  /** Characters of all tags together (YouTube), or how many hashtags a caption may carry (Instagram). */
  tagsTotal?: number;
  tagEach?: number;
  hashtags?: number;
  /** Seconds. */
  minDuration: number;
  maxDuration: number;
  /** Above this a video still posts, differently (YouTube: needs a verified account; Facebook: a video, not a Reel). */
  softMaxDuration?: number;
  /** The shape it is made for (width / height), and what it says when a video isn't. */
  aspect?: { best: number; label: string };
  /** Visibilities the platform offers through its API. */
  visibilities: PostVisibility[];
  /** Whether the platform itself holds a scheduled post (YouTube's publishAt), as opposed to whoever sends it. */
  holdsSchedule: boolean;
}

export const PLATFORM_LIMITS: Record<PublishPlatform, PlatformLimits> = {
  youtube: {
    title: 100,
    description: 5000,
    tagsTotal: 500,
    tagEach: 100,
    minDuration: 1,
    maxDuration: 12 * 3600,
    softMaxDuration: 15 * 60,
    visibilities: ['public', 'unlisted', 'private'],
    holdsSchedule: true,
  },
  instagram: {
    title: 0,
    description: 2200,
    hashtags: 30,
    minDuration: 3,
    maxDuration: 15 * 60,
    aspect: { best: 9 / 16, label: '9:16' },
    visibilities: ['public'],
    holdsSchedule: false,
  },
  facebook: {
    title: 255,
    description: 63206,
    minDuration: 3,
    maxDuration: 4 * 3600,
    softMaxDuration: 90,
    aspect: { best: 9 / 16, label: '9:16' },
    visibilities: ['public'],
    holdsSchedule: false,
  },
};

/** YouTube's video categories (the ones its API lists for most regions); the id is what goes out. */
export const YOUTUBE_CATEGORIES: { id: string; name: string }[] = [
  { id: '1', name: 'Film & Animation' },
  { id: '2', name: 'Autos & Vehicles' },
  { id: '10', name: 'Music' },
  { id: '15', name: 'Pets & Animals' },
  { id: '17', name: 'Sports' },
  { id: '19', name: 'Travel & Events' },
  { id: '20', name: 'Gaming' },
  { id: '22', name: 'People & Blogs' },
  { id: '23', name: 'Comedy' },
  { id: '24', name: 'Entertainment' },
  { id: '25', name: 'News & Politics' },
  { id: '26', name: 'Howto & Style' },
  { id: '27', name: 'Education' },
  { id: '28', name: 'Science & Technology' },
  { id: '29', name: 'Nonprofits & Activism' },
];
export const DEFAULT_YOUTUBE_CATEGORY = '22';

/**
 * How the kit encodes for each platform (lib/publish/kit.ts): H.264 in MP4 with the index at the front, 4:2:0, AAC at
 * 48 kHz, a closed GOP of two seconds — what every one of them takes — within each one's size and rate limits.
 */
export interface EncodeSpec {
  /** The longer side at most (scaled down, never up). */
  maxLong: number;
  /** The shorter side at most. */
  maxShort: number;
  fpsMin: number;
  fpsMax: number;
  /** Video bit rate at most, bits per second. */
  maxRate: number;
  crf: number;
  audioRate: number;
  audioBitrate: number;
  /** Bytes at most (the encode is refused above it). */
  maxBytes: number;
}

export const ENCODE_SPECS: Record<PublishPlatform, EncodeSpec> = {
  youtube: { maxLong: 3840, maxShort: 2160, fpsMin: 1, fpsMax: 60, maxRate: 50_000_000, crf: 17, audioRate: 48000, audioBitrate: 384_000, maxBytes: 256e9 },
  instagram: { maxLong: 1920, maxShort: 1080, fpsMin: 23, fpsMax: 60, maxRate: 25_000_000, crf: 19, audioRate: 48000, audioBitrate: 128_000, maxBytes: 300e6 },
  facebook: { maxLong: 1920, maxShort: 1080, fpsMin: 24, fpsMax: 60, maxRate: 25_000_000, crf: 19, audioRate: 48000, audioBitrate: 192_000, maxBytes: 1e9 },
};

/** What a video is, for the checks (a version's geometry). */
export interface VideoFacts {
  duration: number;
  width: number;
  height: number;
  frames: number;
}

/** What a connection is, for the checks: never its secrets. */
export interface ConnectionFacts {
  state: 'needs_auth' | 'ready' | 'error';
  platforms: PublishPlatform[];
  accounts: PublishAccount[];
  audited?: boolean;
  holds_schedule: boolean;
}

/** What a post is, for the checks. */
export type PostFacts = Required<Pick<PostFields, 'title' | 'description' | 'tags' | 'visibility'>> &
  Pick<PostFields, 'cover_frame' | 'schedule_at' | 'ai_generated' | 'youtube' | 'instagram' | 'connection' | 'account'> & { platform: PublishPlatform };

const fmtSec = (s: number): string => (s >= 3600 ? `${Math.round((s / 3600) * 10) / 10} h` : s >= 60 ? `${Math.round((s / 60) * 10) / 10} min` : `${s} s`);

/** Hashtags in a text ("#launch"). */
export const hashtagsIn = (text: string): string[] => text.match(/(^|\s)#[\p{L}\p{N}_]+/gu)?.map((t) => t.trim()) ?? [];

/** How long a schedule may reach ahead. */
export const SCHEDULE_MAX_DAYS = 365;

/**
 * What a post breaks (`block`: it can't be published so) and the limits it is near (`warn`). `publishing`: the checks
 * that only matter when a person publishes (a connection and an account chosen, the required answers given) block
 * then, and are warnings while it is a draft — an agent's draft without them is fine, it says what is missing.
 */
export function postProblems(
  post: PostFacts,
  video: VideoFacts,
  o: { connection?: ConnectionFacts | null; publishing?: boolean; now?: number; hosted?: boolean } = {},
): PostProblem[] {
  const out: PostProblem[] = [];
  const L = PLATFORM_LIMITS[post.platform];
  const name = PLATFORM_NAMES[post.platform];
  const need = o.publishing ? 'block' : 'warn';
  const add = (field: PostProblem['field'], level: PostProblem['level'], code: string, message: string, vars?: PostProblem['vars']) =>
    out.push({ field, level, code, message, ...(vars ? { vars } : {}) });

  // what the platform takes
  const title = post.title.trim();
  if (L.title && [...title].length > L.title)
    add('title', 'block', 'title_long', `the title is ${[...title].length} characters: ${name} takes ${L.title}`, { n: [...title].length, max: L.title });
  if (post.platform === 'youtube' && /[<>]/.test(title)) add('title', 'block', 'title_angle', 'YouTube takes no < or > in a title');
  if (post.platform === 'youtube' && !title) add('title', need, 'title_missing', 'YouTube needs a title');
  if (post.platform === 'youtube' && /[<>]/.test(post.description))
    add('description', 'block', 'description_angle', 'YouTube takes no < or > in a description');
  const descLen = post.platform === 'youtube' ? new TextEncoder().encode(post.description).length : [...post.description].length;
  if (descLen > L.description)
    add(
      'description',
      'block',
      'description_long',
      `the ${post.platform === 'youtube' ? 'description' : 'caption'} is ${descLen} ${post.platform === 'youtube' ? 'bytes' : 'characters'}: ${name} takes ${L.description}`,
      {
        n: descLen,
        max: L.description,
      },
    );
  if (L.tagsTotal) {
    const total = post.tags.reduce((n, t) => n + [...t].length + (t.includes(' ') ? 2 : 0), 0) + Math.max(0, post.tags.length - 1);
    if (total > L.tagsTotal)
      add('tags', 'block', 'tags_long', `the tags are ${total} characters together: ${name} takes ${L.tagsTotal}`, { n: total, max: L.tagsTotal });
    const long = post.tags.find((t) => [...t].length > (L.tagEach ?? Number.POSITIVE_INFINITY));
    if (long)
      add('tags', 'block', 'tag_long', `the tag "${long.slice(0, 40)}" is longer than ${L.tagEach} characters`, {
        tag: long.slice(0, 40),
        max: L.tagEach ?? 0,
      });
  }
  if (L.hashtags) {
    const n = new Set([...hashtagsIn(post.description), ...post.tags.map((t) => `#${t.replace(/^#/, '')}`)]).size;
    if (n > L.hashtags) add('tags', 'block', 'hashtags_many', `${n} hashtags: ${name} takes ${L.hashtags}`, { n, max: L.hashtags });
  }
  if (!L.visibilities.includes(post.visibility))
    add('visibility', 'block', 'visibility_unknown', `${name} posts are ${L.visibilities.join(' or ')} only`, { allowed: L.visibilities.join(', ') });

  // the video itself
  const d = video.duration;
  if (d < L.minDuration)
    add('video', 'block', 'video_short', `the video is ${fmtSec(Math.round(d * 10) / 10)}: ${name} takes ${L.minDuration} s at least`, { min: L.minDuration });
  else if (d > L.maxDuration)
    add('video', 'block', 'video_long', `the video is ${fmtSec(Math.round(d))}: ${name} takes ${fmtSec(L.maxDuration)} at most`, { max: L.maxDuration });
  else if (L.softMaxDuration && d > L.softMaxDuration)
    add(
      'video',
      'warn',
      post.platform === 'youtube' ? 'youtube_verified' : 'facebook_not_reel',
      post.platform === 'youtube'
        ? `longer than ${fmtSec(L.softMaxDuration)}: the YouTube account must be verified`
        : `longer than ${L.softMaxDuration} s: it posts as a Facebook video, not a Reel`,
      { max: L.softMaxDuration },
    );
  if (L.aspect && video.width && video.height) {
    const ar = video.width / video.height;
    const wantsVertical = post.platform === 'facebook' || (post.instagram?.kind ?? 'reel') === 'reel';
    if (wantsVertical && Math.abs(ar - L.aspect.best) > 0.02)
      add('video', 'warn', 'aspect', `${video.width}×${video.height} isn't ${L.aspect.label}: ${name} shows it with bars or cropped`, {
        size: `${video.width}×${video.height}`,
        best: L.aspect.label,
      });
  }
  if (post.cover_frame !== null && post.cover_frame !== undefined && (post.cover_frame < 0 || post.cover_frame >= Math.max(1, video.frames)))
    add('cover_frame', 'block', 'cover_outside', `the cover frame ${post.cover_frame} isn't in the video (0–${video.frames - 1})`, {
      frame: post.cover_frame,
      last: video.frames - 1,
    });

  // when
  const now = o.now ?? Date.now();
  if (post.schedule_at) {
    const t = Date.parse(post.schedule_at);
    if (!Number.isFinite(t)) add('schedule_at', 'block', 'schedule_invalid', `"${post.schedule_at}" is no time`);
    else if (t < now - 60_000) add('schedule_at', need, 'schedule_past', 'the time to post is in the past');
    else if (t > now + SCHEDULE_MAX_DAYS * 86400e3)
      add('schedule_at', 'block', 'schedule_far', `a post can be scheduled ${SCHEDULE_MAX_DAYS} days ahead at most`, { max: SCHEDULE_MAX_DAYS });
    if (post.platform === 'youtube' && post.visibility !== 'public')
      add('visibility', 'block', 'schedule_public', 'YouTube makes a scheduled video public at its time: choose Public, or leave the time out');
  }

  // the answers a person gives, never a default
  if (post.ai_generated === null || post.ai_generated === undefined)
    add('ai_generated', need, 'ai_missing', 'say whether it contains realistic AI-generated or altered people, places or events');
  else if (post.ai_generated && post.platform !== 'youtube')
    add('ai_generated', 'warn', 'ai_caption', `Lampo can't set ${name}'s AI label yet: say it in the caption`);
  if (post.platform === 'youtube' && (post.youtube?.made_for_kids === null || post.youtube?.made_for_kids === undefined))
    add('youtube', need, 'kids_missing', 'say whether it is made for kids (YouTube asks it of every video)');

  // where it goes
  const c = o.connection;
  if (!post.connection || !c) add('connection', need, 'connection_missing', `choose a connection for ${name} (Settings → Publishing), or download the kit`);
  else if (!c.platforms.includes(post.platform)) add('connection', 'block', 'connection_platform', `that connection doesn't post to ${name}`);
  else {
    if (c.state !== 'ready') add('connection', need, 'connection_not_ready', 'that connection isn’t ready: open Settings → Publishing');
    const accounts = c.accounts.filter((a) => a.platform === post.platform);
    if (!post.account || !accounts.some((a) => a.id === post.account))
      add('account', need, 'account_missing', post.platform === 'facebook' ? 'choose the Facebook Page' : `choose the ${name} account`);
    if (post.platform === 'youtube' && !c.audited && (post.visibility !== 'private' || post.schedule_at))
      add(
        'visibility',
        'warn',
        'youtube_locked',
        "YouTube keeps uploads private until your Google project passes YouTube's API audit: a schedule won't go public, make it public in YouTube Studio",
      );
    if (post.schedule_at && !c.holds_schedule && !o.hosted)
      add('schedule_at', 'warn', 'schedule_awake', 'Lampo sends it at that time: this machine must be awake and Lampo running then');
  }
  return out;
}

/** Whether a post may be published as it is. */
export const publishable = (problems: PostProblem[]): boolean => !problems.some((p) => p.level === 'block');

/** One line of problems for agents: "missing: ai_generated, youtube.made_for_kids · warn: …". */
export function problemsLine(problems: PostProblem[]): string {
  const block = problems.filter((p) => p.level === 'block').map((p) => p.message);
  const warn = problems.filter((p) => p.level === 'warn').map((p) => p.message);
  return [block.length ? `to fix: ${block.join('; ')}` : '', warn.length ? `note: ${warn.join('; ')}` : ''].filter(Boolean).join(' · ');
}

/** The copy as text: what the kit's copy file holds, and what a person pastes by hand. */
export function copyText(post: Pick<PostFacts, 'platform' | 'title' | 'description' | 'tags'>): string {
  const tags = post.tags.map((t) => t.trim()).filter(Boolean);
  const lines: string[] = [];
  // Instagram takes no title: its copy is the caption alone
  if (post.title.trim() && PLATFORM_LIMITS[post.platform].title) lines.push(post.title.trim(), '');
  if (post.description.trim()) lines.push(post.description.trim(), '');
  if (tags.length)
    lines.push(post.platform === 'youtube' ? `Tags: ${tags.join(', ')}` : tags.map((t) => `#${t.replace(/^#/, '').replace(/\s+/g, '')}`).join(' '));
  return `${lines.join('\n').trim()}\n`;
}

/** Where a YouTube video is watched, and changed (YouTube Studio). */
export const youtubeWatchUrl = (id: string): string => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
export const youtubeStudioUrl = (id: string): string => `https://studio.youtube.com/video/${encodeURIComponent(id)}/edit`;
