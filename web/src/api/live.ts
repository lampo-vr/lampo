// Keeping the cache in step with the server without refetch storms. One change is announced several times within half
// a second (the route, the data folder's watcher, the event feed): the first announcement is fetched at once, and
// whatever arrives while that is fresh is collected and fetched once more at the end of a short window. Precisely: the reviews that changed (only if this tab has them), the library entries of the videos
// that changed (GET /api/library?slug=…, patched into the cached list), the whole library only when folders changed,
// insights and For you only where a screen shows them. Every read revalidates with its ETag, so a repeat is a 304.
// Server events (events.ts) and this tab's own writes (mutations.ts) both come through here.
import type { QueryClient } from '@tanstack/react-query';
import { api } from './client.ts';
import { type EventData, on, onResync } from './events.ts';
import { keys } from './queries.ts';
import type { LibraryResponse } from './types.ts';

// Long enough for the data folder watcher's echo of the same write (120 ms after it).
const WINDOW = 250;
// For you follows every line of the event log, which arrives up to half a second after the change itself.
const FOR_YOU_WINDOW = 700;

interface Batch {
  reviews: Set<string>;
  entries: Set<string>;
  allReviews: boolean;
  library: boolean;
  insights: boolean;
}
const empty = (): Batch => ({ reviews: new Set(), entries: new Set(), allReviews: false, library: false, insights: false });

/** Runs at once, then at most once more at the end of `window` ms if it was asked for again meanwhile. */
function coalesced(fn: () => void, window: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let again = false;
  const run = () => {
    fn();
    timer = setTimeout(() => {
      timer = null;
      if (!again) return;
      again = false;
      run();
    }, window);
  };
  return () => {
    if (timer) again = true;
    else run();
  };
}

/** Replaces (or adds, or drops) the entries of `slugs` in the cached library with what the server says now. */
export async function patchLibrary(qc: QueryClient, slugs: string[]): Promise<void> {
  if (!slugs.length || !qc.getQueryData<LibraryResponse>(keys.library)) return;
  const q = new URLSearchParams();
  for (const s of slugs) q.append('slug', s);
  const got = await api<LibraryResponse>(`/api/library?${q}`);
  const fresh = new Map(got.videos.map((v) => [v.slug, v]));
  const asked = new Set(slugs);
  qc.setQueryData<LibraryResponse>(keys.library, (old) => {
    if (!old) return old;
    const videos = old.videos.flatMap((v) => (asked.has(v.slug) ? (fresh.has(v.slug) ? [fresh.get(v.slug) as (typeof got.videos)[number]] : []) : [v]));
    const known = new Set(old.videos.map((v) => v.slug));
    for (const v of got.videos) if (!known.has(v.slug)) videos.push(v);
    return { folders: got.folders, videos };
  });
}

export interface Live {
  /** One video's review changed (notes, verdicts, versions): its cached review and library entry follow. */
  review(slug: string): void;
  /** One video's library entry changed (not its notes: a move, a session, a poster). */
  entry(slug: string): void;
  /** The library as a whole changed (folders, several videos): refetched where shown. */
  library(): void;
  /** Every cached review (an event without a video). */
  allReviews(): void;
  forYou(): void;
  insights(): void;
}

export function createLive(qc: QueryClient): Live {
  let batch = empty();
  const inv = (queryKey: readonly unknown[], exact = false) => qc.invalidateQueries({ queryKey, exact });
  const flush = () => {
    const b = batch;
    batch = empty();
    if (b.allReviews) inv(keys.reviews);
    else for (const slug of b.reviews) if (qc.getQueryState(keys.review(slug))) inv(keys.review(slug), true);
    // A whole list on its way may have been read before this change: ask again rather than patch what it will replace.
    if (b.library || (b.entries.size && qc.getQueryState(keys.library)?.fetchStatus === 'fetching')) inv(keys.library);
    else
      patchLibrary(qc, [...b.entries]).catch(() => {
        inv(keys.library);
      });
    if (b.insights) inv(keys.insights);
  };
  const soon = coalesced(flush, WINDOW);
  const forYou = coalesced(() => inv(keys.forYou), FOR_YOU_WINDOW);
  return {
    review(slug) {
      batch.reviews.add(slug);
      batch.entries.add(slug);
      batch.insights = true;
      soon();
      forYou();
    },
    entry(slug) {
      batch.entries.add(slug);
      batch.insights = true;
      soon();
      forYou();
    },
    library() {
      batch.library = true;
      batch.insights = true;
      soon();
      forYou();
    },
    allReviews() {
      batch.allReviews = true;
      batch.library = true;
      soon();
      forYou();
    },
    forYou,
    insights() {
      batch.insights = true;
      soon();
    },
  };
}

let current: Live | null = null;
/** The app's one Live (bindQueryClient below); before it is bound, writes fall back to invalidating. */
export const live = (): Live | null => current;
export const setLive = (l: Live): void => {
  current = l;
};

// Server → cache, precisely and once per burst (live.ts): a video's review and its library entry, the library only
// when folders changed, For you and insights where they're shown.
// Loaded (and bound) by boot.tsx just after the start; mutations import `live()` and fall back to invalidating before.
export function bindQueryClient(qc: QueryClient) {
  const live = createLive(qc);
  setLive(live);
  const inv = (queryKey: readonly unknown[]) => qc.invalidateQueries({ queryKey });
  const slugOf = (d: EventData) => (typeof d.slug === 'string' && d.slug ? d.slug : null);
  on('library', (d) => {
    const slug = slugOf(d);
    if (slug) live.entry(slug);
    else live.library();
  });
  on('poster', (d) => {
    const slug = slugOf(d);
    if (slug) live.entry(slug);
  });
  on('review', (d) => {
    const slug = slugOf(d);
    if (slug) live.review(slug);
    else live.allReviews();
  });
  on('analysis', (d) => d.slug && d.v && inv(keys.analysis(d.slug, d.v)));
  on('diff', (d) => d.slug && d.v && inv(keys.diff(d.slug, d.v)));
  on('qa', (d) => d.slug && d.v && inv(keys.qa(d.slug, d.v)));
  on('transcript', (d) => d.slug && d.v && inv(keys.transcript(d.slug, d.v)));
  // A recording's drafts count as not sent too (the library's "2 not sent").
  on('recording', (d) => {
    if (d.slug) inv(keys.recordings(d.slug));
    inv(keys.unsent);
  });
  // Your drafts changed (another tab, a send): only your own streams hear it.
  on('drafts', (d) => {
    if (d.slug) inv(keys.drafts(d.slug));
    inv(keys.unsent);
  });
  on('sessions', () => {
    inv(keys.sessions);
    inv(['agents']);
  });
  // "For you" follows everything that can add or settle an item: every line of events.jsonl, whoever wrote it.
  // a question asked on a folder (no video): the folder's line of questions too (options/api.ts)
  on('event', (d) => {
    live.forYou();
    if (!d.slug && d.folder) inv(['asks']);
  });
  on('asks', () => inv(['asks']));
  on('for-you', () => live.forYou());
  // Back after the stream was gone (a deploy, the network): everything shown is asked again, nothing waits for an event.
  onResync(() => {
    qc.invalidateQueries();
  });
  // An agent Lampo started began, moved on or ended: the runs shown in the agent menu (its step and tokens change
  // every few seconds while it works, so at most once a second).
  on(
    'agent-runs',
    coalesced(() => inv(['agent-runs']), 1000),
  );
  // What agents are doing (server/activity.ts): only the views that show it refetch, at most once a second — a video's
  // view when its agent did something there or nowhere in particular (a wait, the library), the all-agents view always.
  const moved = new Set<string>();
  const refetchActivity = coalesced(() => {
    const slugs = new Set(moved);
    moved.clear();
    qc.invalidateQueries({
      queryKey: ['agent-activity'],
      predicate: (q) => slugs.has('') || q.queryKey[1] === '' || slugs.has(String(q.queryKey[1])),
    });
  }, 1000);
  on('agent-activity', (d) => {
    moved.add(typeof d.slug === 'string' ? d.slug : '');
    refetchActivity();
  });
  // A playbook changed: its page, the folder tabs' badges (small, so all of them at once).
  on('playbook', () => {
    inv(['playbook']);
    inv(['playbooks']);
  });
}
