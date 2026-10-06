// A review link's activity as its owner sees it: who came (told apart by a key their browser's random id gives, never
// an address), how far each of the link's videos was watched (lib/watch.ts), and what happened, newest first.
// shares.json keeps the raw records (lib/shares.ts); this sums them up for the share dialog.
import path from 'node:path';
import { slugify } from './paths.ts';
import { compareTime } from './time.ts';
import type { Review, ShareActivityInfo, ShareStats, ShareVideoWatch, ShareWatch } from './types.ts';
import { bestWatched, heatOf, watchedOf } from './watch.ts';

/** Events the dialog lists; the rest stay on record for later. */
const EVENTS = 60;

export function summarizeActivity(stats: ShareStats, reviews: Review[]): ShareActivityInfo {
  const bySlug = new Map(reviews.map((r) => [slugify(r.video), r]));
  const nameOf = (slug?: string) => {
    const r = slug ? bySlug.get(slug) : undefined;
    return r ? path.basename(r.video) : null;
  };

  const videos: ShareVideoWatch[] = [];
  for (const [slug, s] of Object.entries(stats.videos || {})) {
    const review = bySlug.get(slug);
    const latest = review?.versions.at(-1);
    // Videos the link no longer covers (moved out of its folder, archived) aren't the link's business any more.
    if (!review || !latest) continue;
    const watches: ShareWatch[] = Object.values(s.watch || {});
    videos.push({
      slug,
      name: path.basename(review.video),
      v: latest.v,
      views: s.views,
      last_viewed: s.last_viewed || null,
      watched: bestWatched(watches, latest.v),
      heat: heatOf(watches, latest.v),
      viewers: watches
        .filter((w) => w.v === latest.v)
        .map((w) => ({ name: w.name ?? null, watched: watchedOf(w.seen), secs: w.secs, last: w.last }))
        .sort((a, b) => b.watched - a.watched || compareTime(b.last, a.last)),
      secs: Math.round(watches.reduce((n, w) => n + w.secs, 0)),
    });
  }
  videos.sort((a, b) => compareTime(b.last_viewed, a.last_viewed));

  const visitors = Object.values(stats.visitors || {}).sort((a, b) => compareTime(b.last, a.last));
  const events = (stats.activity || [])
    .slice(-EVENTS)
    .reverse()
    .map((e) => ({ ...e, video: nameOf(e.slug) }));
  return { visitors, videos, events, secs: Math.round(visitors.reduce((n, v) => n + v.secs, 0)) };
}
