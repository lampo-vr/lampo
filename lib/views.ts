// Who watched a video, how often and how long: the team's own watching (reported by the owner's player, kept next to
// the review in `data/<slug>/views.json` — not in review.json, which agents read) and review-link visitors (kept with
// their link in shares.json, lib/shares.ts). Coarse pieces only (lib/watch.ts): hundredths played and how often, never
// the moments. What watching adds up to is for the people who may see Insights; no addresses are ever kept.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isoLocal, reviewDir, slugify } from './paths.ts';
import { wsKey } from './scope.ts';
import { linksWithStats } from './shares.ts';
import { withLock, writeAtomic } from './store.ts';
import { compareTime } from './time.ts';
import type { AudienceViewer, Review, ShareWatch, TeamWatch, VideoAudience, VideoViews } from './types.ts';
import { heatOf, mergeWatch, playsOf, retentionOf, rewatchedOf, SEEN_PATTERN, watchedOf } from './watch.ts';

const FILE = 'views.json';
/** Team members kept per video; the least recently watching go first. */
export const MAX_TEAM_VIEWERS = 100;

const fileOf = (slug: string) => path.join(reviewDir(slug), FILE);

// Insights reads every video's file on each request: parse a file again only when it changed.
const cache = new Map<string, { mtime: number; size: number; views: VideoViews }>();

const isWatch = (w: unknown): w is TeamWatch => {
  const x = w as TeamWatch;
  return !!x && typeof x === 'object' && Number.isInteger(x.v) && typeof x.seen === 'string' && SEEN_PATTERN.test(x.seen) && typeof x.last === 'string';
};

/** The team's watching of one video; nothing when nobody watched it (or the file can't be read). */
export function readViews(slug: string): VideoViews {
  const file = fileOf(slug);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    cache.delete(wsKey(slug));
    return { viewers: {} };
  }
  const hit = cache.get(wsKey(slug));
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.views;
  let views: VideoViews = { viewers: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<VideoViews>;
    const viewers: Record<string, TeamWatch> = {};
    for (const [id, w] of Object.entries(raw.viewers || {})) if (isWatch(w)) viewers[id] = { ...w, name: String(w.name || '') };
    views = { viewers };
  } catch {
    // a broken file counts as nobody watched; the next report writes a good one
  }
  cache.set(wsKey(slug), { mtime: st.mtimeMs, size: st.size, views });
  return views;
}

/** One team member's report (the owner's player, every 15 s while it plays): folded into their record for the video. */
export function recordTeamWatch(
  slug: string,
  who: { id: string; name: string },
  r: { v: number; seen: string; secs: number; plays?: number[] | null },
  at = isoLocal(),
): void {
  // A lock of its own: reports are frequent and must never wait for (or hold up) a note being saved.
  withLock(path.join(reviewDir(slug), '.views'), () => {
    const views = readViews(slug);
    const viewers = { ...views.viewers };
    const prev = viewers[who.id];
    const merged = mergeWatch(prev, { ...r, at, name: who.name });
    if (!merged || merged === prev) return;
    viewers[who.id] = { ...merged, name: who.name };
    const keep = Object.entries(viewers)
      .sort((a, b) => compareTime(b[1].last, a[1].last))
      .slice(0, MAX_TEAM_VIEWERS);
    writeAtomic(fileOf(slug), `${JSON.stringify({ viewers: Object.fromEntries(keep) } satisfies VideoViews)}\n`);
    cache.delete(wsKey(slug));
  });
}

/**
 * A team member's account went (lib/erasure.ts): their watching of the video stays in the team's numbers, under no name
 * and no account — a key of its own that nothing can be traced back with. Returns whether there was any.
 */
export function forgetTeamViewer(slug: string, accountId: string): boolean {
  if (!readViews(slug).viewers[accountId]) return false;
  return withLock(path.join(reviewDir(slug), '.views'), () => {
    const viewers = { ...readViews(slug).viewers };
    const w = viewers[accountId];
    if (!w) return false;
    delete viewers[accountId];
    viewers[`x_${crypto.randomBytes(6).toString('hex')}`] = { ...w, name: '' };
    writeAtomic(fileOf(slug), `${JSON.stringify({ viewers } satisfies VideoViews)}\n`);
    cache.delete(wsKey(slug));
    return true;
  });
}

/**
 * The team's watching of a video brought over from another store (`lampo admin import`), by the account each record is
 * now: written only where nobody has watched the video here yet, so nothing recorded here is ever written over.
 */
export function importViews(slug: string, viewers: Record<string, TeamWatch>): boolean {
  if (!Object.keys(viewers).length) return false;
  return withLock(path.join(reviewDir(slug), '.views'), () => {
    if (Object.keys(readViews(slug).viewers).length) return false;
    const keep = Object.entries(viewers)
      .filter(([, w]) => isWatch(w))
      .sort((a, b) => compareTime(b[1].last, a[1].last))
      .slice(0, MAX_TEAM_VIEWERS);
    writeAtomic(fileOf(slug), `${JSON.stringify({ viewers: Object.fromEntries(keep) } satisfies VideoViews)}\n`);
    cache.delete(wsKey(slug));
    return true;
  });
}

/** A key to tell viewers apart in an answer without handing out what they are stored under. */
const keyOf = (kind: 'p' | 'c', raw: string) => `${kind}_${crypto.createHash('sha256').update(`${kind}|${raw}`).digest('hex').slice(0, 12)}`;
/** The key a team member's viewing goes by (never their account id): Insights marks the asker's own with it. */
export const teamViewerKey = (accountId: string) => keyOf('p', accountId);

const viewerOf = (key: string, kind: AudienceViewer['kind'], name: string | null, link: string | null, w: ShareWatch): AudienceViewer => ({
  key,
  kind,
  name,
  link,
  v: w.v,
  watched: watchedOf(w.seen),
  secs: w.secs,
  sessions: w.sessions ?? 1,
  total_secs: w.total_secs ?? w.secs,
  total_sessions: w.total_sessions ?? w.sessions ?? 1,
  first: w.first ?? w.last,
  last: w.last,
});

export interface Watcher {
  viewer: AudienceViewer;
  watch: ShareWatch;
}

type Links = ReturnType<typeof linksWithStats>;

/** Everyone who watched one video, the team and review-link visitors, the most recent first. */
export function watchersOf(review: Pick<Review, 'video'>, links: Links = linksWithStats()): Watcher[] {
  const slug = slugify(review.video);
  const out: Watcher[] = [];
  for (const [id, w] of Object.entries(readViews(slug).viewers)) out.push({ viewer: viewerOf(keyOf('p', id), 'person', w.name || null, null, w), watch: w });
  for (const link of links) {
    const watch = link.stats?.videos?.[slug]?.watch;
    if (!watch) continue;
    for (const [visitor, w] of Object.entries(watch)) {
      const name = w.name || link.stats?.visitors?.[visitor]?.name || null;
      out.push({ viewer: viewerOf(keyOf('c', `${link.id || link.created}|${visitor}`), 'client', name, link.label || null, w), watch: w });
    }
  }
  return out.sort((a, b) => compareTime(b.viewer.last, a.viewer.last));
}

/** Who watched one video and how: the viewers, and the curve of one version (the newest anyone watched, or `v`). */
export function audienceOf(review: Pick<Review, 'video'>, v?: number, links?: Links): VideoAudience {
  const watchers = watchersOf(review, links);
  const on = v ?? Math.max(0, ...watchers.map((w) => w.watch.v));
  const watches = watchers.map((w) => w.watch);
  const plays = playsOf(watches, on);
  const heat = heatOf(watches, on);
  return {
    v: on,
    viewers: watchers.map((w) => w.viewer),
    retention: retentionOf(watches, on),
    plays,
    rewatched: plays.length ? rewatchedOf(plays, heat) : [],
  };
}
