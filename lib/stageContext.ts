// Where a video stands, with what only this machine knows: which review links are active (lib/shares.ts) and whether
// the newest render is identical to an approved older one (the version diff cache — never computed here, so listing
// stays fast). Importing this module also teaches the store, so review.md shows the same stage as the app.
import { cachedDiff } from './diff.ts';
import { slugify } from './paths.ts';
import { postSignal } from './publish/posts.ts';
import { currentWorkspace } from './scope.ts';
import { covers, isExpired, listShares, sharesVersion } from './shares.ts';
import { approvalsOf, type StageContext, stageOf, verdictOn } from './stage.ts';
import { setStageContextProvider } from './store.ts';
import { compareTime } from './time.ts';
import type { Review, Share, ShareSignal, ShareWatch, StageInfo, Version } from './types.ts';
import { watchedOf } from './watch.ts';

// The links are listed again only when they changed (a library of cards asks once per card) — on disk, or what visitors
// did, which waits in memory before it is written (sharesVersion); expiry is checked each time. One per workspace.
const linksOf = new Map<string, { key: string; list: Share[] }>();
let warned = false;
function activeLinks(): Share[] {
  const ws = currentWorkspace();
  let links = linksOf.get(ws);
  try {
    const key = sharesVersion();
    if (links?.key !== key) {
      links = { key, list: listShares() };
      linksOf.set(ws, links);
    }
  } catch (e) {
    // A shares.json that can't be read fails the link routes and every write to it (lib/shares.ts); a stage shown
    // without links is only a display, and a note or a library listing mustn't fail because of it. Asked again next time.
    // The error names its file (fs errors do; a parse error is shares.json's own).
    const why = e instanceof SyntaxError ? `shares.json is damaged (${e.message})` : (e as Error).message;
    if (!warned) console.error(`review links: ${why}; stages show no links until they can be read`);
    warned = true;
    return [];
  }
  warned = false;
  const now = Date.now();
  // an embed plays for whoever sees the site it is on and asks nobody for a verdict: it never says "out for review"
  return links.list.filter((s) => !isExpired(s, now) && !s.embed);
}

/** The newest approved version older than the newest render, if any (for carrying the approval over). */
export function approvedOlderVersion(review: Review): Version | null {
  if (review.versions.length < 2) return null;
  const history = approvalsOf(review);
  for (let i = review.versions.length - 2; i >= 0; i--) {
    const ver = review.versions[i] as Version;
    if ((['team', 'client'] as const).some((p) => verdictOn(history, p, ver.v)?.status === 'approved')) return ver;
  }
  return null;
}

/** What one link says about one video. Only per-video views count: they leave out the team's own previews. A link's
 * older opens (stats from before per-video views) can't tell the client from the team, so they never say "opened". */
function signalOf(s: Share, slug: string, latest: Version): ShareSignal {
  const stats = s.stats;
  const base = { label: s.label, kind: s.folder ? ('folder' as const) : ('video' as const), reviewers: stats?.reviewers ?? [] };
  const seen = stats?.videos?.[slug];
  if (!seen) return { ...base, opened: false, opens: 0, last_opened: null, seen_v: null, by: null };
  // How far the newest version was watched: the visitor who got furthest (lib/watch.ts).
  const watches = Object.values(seen.watch || {}).filter((w) => w.v === latest.v);
  const furthest = watches.reduce<ShareWatch | null>((a, w) => (!a || watchedOf(w.seen) > watchedOf(a.seen) ? w : a), null);
  return {
    ...base,
    opened: seen.seen_v >= latest.v,
    opens: seen.views,
    last_opened: seen.last_viewed,
    seen_v: seen.seen_v,
    by: seen.by ?? null,
    ...(furthest ? { watched: watchedOf(furthest.seen), watched_by: furthest.name ?? null } : {}),
  };
}

/** The link that tells the most: one opened on the newest version, else the latest opened, else the newest link. */
export function shareSignal(review: Review, list: Share[] = activeLinks()): ShareSignal | null {
  const latest = review.versions.at(-1);
  if (!latest) return null;
  const slug = slugify(review.video);
  const ranked = list
    .filter((s) => covers(s, review))
    .map((s) => ({ s, sig: signalOf(s, slug, latest) }))
    .sort((a, b) => Number(b.sig.opened) - Number(a.sig.opened) || compareTime(b.sig.last_opened, a.sig.last_opened) || compareTime(b.s.created, a.s.created));
  return ranked[0]?.sig ?? null;
}

export function stageContext(review: Review, o: { sessionActive?: boolean } = {}): StageContext {
  const latest = review.versions.at(-1);
  const older = approvedOlderVersion(review);
  const diff = latest && older ? cachedDiff(older, latest) : null;
  const identical = !!diff && 'summary' in diff && diff.summary.identical;
  const share = shareSignal(review);
  const published = postSignal(review);
  return { linked: !!share, share, identical, sessionActive: o.sessionActive, ...(published ? { published } : {}) };
}

/** Identical per the version diff (cached or not) — the rule for carrying an approval over. */
export const isIdentical = (d: { summary?: { identical: boolean } } | null | undefined): boolean => !!d?.summary?.identical;

export const stageForReview = (review: Review, o: { sessionActive?: boolean } = {}): StageInfo => stageOf(review, stageContext(review, o));

setStageContextProvider((review) => stageContext(review));
