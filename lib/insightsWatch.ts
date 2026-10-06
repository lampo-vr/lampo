// Insights' "Watching": who watched what in a period — the team (lib/views.ts) and review-link visitors alike — how
// often (sittings) and how long, how far into the newest version, and the links nobody has opened yet.
import { slugify } from './paths.ts';
import { renderKey } from './renderKey.ts';
import { linksWithStats } from './shares.ts';
import { compareTime } from './time.ts';
import type { InsightsUnopened, InsightsWatchedVideo, InsightsWatching, InsightsWatchPerson, Review, ShareWatch } from './types.ts';
import { teamViewerKey, type Watcher, watchersOf } from './views.ts';
import { heatOf, playsOf, retentionOf, rewatchedOf } from './watch.ts';

/** Videos and people the page lists (the busiest first); enough to scan, not a log. */
const VIDEOS = 20;
const PEOPLE = 20;
const VIEWERS_PER_VIDEO = 12;
const UNOPENED = 8;

const nameOf = (r: Review) => r.video.split('/').pop() || r.video;

/** What a client's record says about their viewing: the version, the share of it, the link, and per hundredth how often it
 * played for them, with the stretch they watched again and again. */
function clientWatch(v: number, watched: number, link: string | null, watch: ShareWatch) {
  const plays = playsOf([watch], v);
  const again = plays.length ? (rewatchedOf(plays, heatOf([watch], v)).sort((a, b) => b.plays - a.plays)[0] ?? null) : null;
  return { v, vWatched: watched, link, ...(plays.length ? { plays } : {}), again };
}

/** `me`: the account asking (its own viewing reads "You"); none for API tokens. */
export function watchingOf(
  reviews: Review[],
  from: number,
  to: number,
  links = linksWithStats(),
  now = Date.now(),
  me: string | null = null,
): InsightsWatching {
  const mine = me ? teamViewerKey(me) : null;
  const inside = (at: string) => {
    const x = Date.parse(at);
    return x >= from && x < to;
  };
  const videos: InsightsWatchedVideo[] = [];
  const people = new Map<string, InsightsWatchPerson>();
  let views = 0;
  let secs = 0;
  for (const r of reviews) {
    const watchers: Watcher[] = watchersOf(r, links).filter((w) => inside(w.viewer.last));
    if (!watchers.length) continue;
    const slug = slugify(r.video);
    const newest = r.versions.at(-1);
    const v = newest?.v ?? 1;
    const onNewest = watchers.filter((w) => w.watch.v === v).map((w) => w.watch);
    const plays = playsOf(onNewest, v);
    const heat = heatOf(onNewest, v);
    const vViews = watchers.reduce((s, w) => s + w.viewer.total_sessions, 0);
    const vSecs = Math.round(watchers.reduce((s, w) => s + w.viewer.total_secs, 0));
    views += vViews;
    secs += vSecs;
    const done = watchers.filter((w) => w.watch.v === v).map((w) => w.viewer.watched);
    videos.push({
      slug,
      video: nameOf(r),
      folder: r.folder ?? null,
      hash: newest ? renderKey(newest) : null,
      v,
      viewers: watchers.slice(0, VIEWERS_PER_VIDEO).map(({ viewer: x, watch }) => ({
        key: x.key,
        kind: x.kind,
        name: x.name,
        sessions: x.total_sessions,
        secs: Math.round(x.total_secs),
        watched: x.v === v ? x.watched : null,
        last: x.last,
        ...(x.key === mine ? { you: true } : {}),
        // a client: which version, how far, through which link, and what they watched again (the page's Clients)
        ...(x.kind === 'client' ? clientWatch(x.v, x.watched, x.link, watch) : {}),
      })),
      people: watchers.filter((w) => w.viewer.kind === 'person').length,
      clients: watchers.filter((w) => w.viewer.kind === 'client').length,
      views: vViews,
      secs: vSecs,
      completion: done.length ? Math.round((done.reduce((a, b) => a + b, 0) / done.length) * 100) / 100 : null,
      retention: retentionOf(onNewest, v),
      rewatched: plays.length ? rewatchedOf(plays, heat) : [],
      // the parts as recorded, for the chart of the hundredths: who saw each one and how often it played
      heat,
      plays,
      seenBy: onNewest.length,
      last: watchers[0]?.viewer.last as string,
      duration: newest?.duration ?? null,
      seenV: Math.max(...watchers.map((w) => w.watch.v)) || null,
    });
    for (const { viewer: x } of watchers) {
      const p: InsightsWatchPerson = people.get(x.key) || {
        key: x.key,
        kind: x.kind,
        name: x.name,
        videos: 0,
        views: 0,
        secs: 0,
        last: x.last,
        top: [],
        ...(x.key === mine ? { you: true } : {}),
      };
      p.videos++;
      p.views += x.total_sessions;
      p.secs += Math.round(x.total_secs);
      if (compareTime(x.last, p.last) > 0) p.last = x.last;
      p.name = p.name || x.name;
      p.top.push({ slug, video: nameOf(r), views: x.total_sessions, secs: Math.round(x.total_secs) });
      people.set(x.key, p);
    }
  }
  const bySlug = new Map(reviews.map((r) => [slugify(r.video), r]));
  const unopened: InsightsUnopened[] = links
    .filter((l) => !l.revoked && !(l.expires && Date.parse(l.expires) <= now) && !l.stats?.opens && (l.folder || (l.slug && bySlug.has(l.slug))))
    .sort((a, b) => compareTime(a.created, b.created))
    .slice(0, UNOPENED)
    .map((l) => {
      const r = l.slug ? bySlug.get(l.slug) : undefined;
      return { label: l.label, slug: l.folder ? null : (l.slug ?? null), video: r ? nameOf(r) : null, folder: l.folder ?? null, created: l.created };
    });
  return {
    videos: videos.sort((a, b) => compareTime(b.last, a.last)).slice(0, VIDEOS),
    people: [...people.values()]
      .map((p) => ({ ...p, top: p.top.sort((a, b) => b.secs - a.secs || b.views - a.views).slice(0, 3) }))
      .sort((a, b) => b.secs - a.secs || b.views - a.views)
      .slice(0, PEOPLE),
    unopened,
    viewers: people.size,
    views,
    secs,
  };
}
