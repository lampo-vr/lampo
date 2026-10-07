// Server state: one query per resource. SSE events (events.ts → live.ts) refresh exactly what changed, so views stay
// live without polling; data that never changes for a given key (waveforms, project tracks, server info) is cached for
// good. The screens' data also outlives the tab (persist.ts).

import { keepPreviousData, QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { BillingInfo } from '../../../lib/types.ts';
import { askAgainIn } from '../lib/busy.ts';
import { api, enc } from './client.ts';
import type {
  Analysis,
  BrowseResponse,
  Diff,
  FoldersResponse,
  ForYouResponse,
  GuestLink,
  GuestReview,
  Info,
  Insights,
  InsightsPeriod,
  LibraryResponse,
  PartAnswer,
  QaResult,
  ReviewResponse,
  SessionsResponse,
  SharesResponse,
  Tracks,
  TranscriptAnswer,
  Tunnel,
  VideoAudience,
  Waveform,
  WebhookInfo,
} from './types.ts';

export const keys = {
  library: ['library'] as const,
  insights: ['insights'] as const,
  info: ['info'] as const,
  billing: ['billing'] as const,
  stt: ['stt'] as const,
  search: (q: string) => ['search', q] as const,
  tunnel: ['tunnel'] as const,
  reviews: ['review'] as const,
  review: (slug: string) => ['review', slug] as const,
  waveform: (slug: string, v: number) => ['waveform', slug, v] as const,
  analysis: (slug: string, v: number) => ['analysis', slug, v] as const,
  diff: (slug: string, v: number) => ['diff', slug, v] as const,
  qa: (slug: string, v: number) => ['qa', slug, v] as const,
  transcript: (slug: string, v: number) => ['transcript', slug, v] as const,
  audience: (slug: string, v: number) => ['audience', slug, v] as const,
  part: (slug: string, v: number, a: number, b: number) => ['part', slug, v, a, b] as const,
  recordings: (slug: string) => ['recordings', slug] as const,
  /** Your notes on a video that aren't sent yet (api/drafts.ts). */
  drafts: (slug: string) => ['drafts', slug] as const,
  /** How many notes you haven't sent, per video (the library's "2 not sent"). */
  unsent: ['unsent'] as const,
  tracks: (slug: string) => ['tracks', slug] as const,
  shares: (slug: string) => ['shares', slug] as const,
  folderShares: (folder: string) => ['shares', 'folder', folder] as const,
  /** Every review link still out there (Settings → Review links); under 'shares', so any link change refreshes it. */
  allShares: ['shares', { every: true }] as const,
  webhooks: ['webhooks'] as const,
  forYou: ['for-you'] as const,
  sessions: ['sessions'] as const,
  sessionsFor: (video: string | null) => ['sessions', video] as const,
  folderSuggestion: (video: string) => ['folders', video] as const,
  browse: (dir: string) => ['browse', dir] as const,
  guest: (token: string) => ['guest', token] as const,
  guestReview: (token: string, slug: string, v: number | null) => ['guest', token, 'review', slug, v] as const,
  guestWaveform: (url: string) => ['guest', 'waveform', url] as const,
};

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      // SSE keeps mounted data fresh; a short staleTime only covers a lost event stream when a view remounts.
      queries: { staleTime: 2000, refetchOnWindowFocus: false, retry: 1 },
    },
  });
}

const forever = { staleTime: Number.POSITIVE_INFINITY } as const;

const libraryQuery = { queryKey: keys.library, queryFn: () => api<LibraryResponse>('/api/library') };
export const useLibrary = (enabled = true) => useQuery({ ...libraryQuery, enabled });
/** Insights for one period; the numbers of the period shown stay while the next one loads (no flash, no jump). */
export const useInsights = (period: InsightsPeriod, enabled = true) =>
  useQuery({
    queryKey: [...keys.insights, period],
    // the sparkline's buckets are this viewer's days (the server doesn't know the time zone)
    queryFn: () => api<Insights>(`/api/insights?period=${period}&tz=${new Date().getTimezoneOffset()}`),
    placeholderData: keepPreviousData,
    enabled,
  });
/** Who watched a video and how (the player's viewers chip and band). Quiet: watching changes every 15 s while someone
 * plays, the chip doesn't need to follow it that closely. */
export const useAudience = (slug: string, v: number, enabled = true) =>
  useQuery({
    queryKey: keys.audience(slug, v),
    queryFn: () => api<VideoAudience>(`/api/review/${enc(slug)}/audience?v=${v}`),
    staleTime: 60_000,
    enabled,
  });
/** At most this many items of each kind (the newest); the counts are always whole (lib/foryou.ts). */
export const FOR_YOU_LIMIT = 200;
const forYouQuery = { queryKey: keys.forYou, queryFn: () => api<ForYouResponse>(`/api/for-you?limit=${FOR_YOU_LIMIT}`) };
export const useForYou = (enabled = true) => useQuery({ ...forYouQuery, enabled });
const infoQuery = { queryKey: keys.info, queryFn: () => api<Info>('/api/info'), ...forever };
/** What the server can do; `enabled: false` while a screen draws its loading state before anyone signed in. */
export const useInfo = (enabled = true) => useQuery({ ...infoQuery, enabled }).data ?? null;
/**
 * The workspace's plan where a billing provider runs (lib/types.ts BillingInfo; Settings → Billing and its banner).
 * `poll`: every two seconds, back from the provider's page until the plan shows.
 */
export const useBilling = (enabled = true, poll = false) =>
  useQuery({ queryKey: keys.billing, queryFn: () => api<BillingInfo>('/api/billing'), enabled, staleTime: 60_000, refetchInterval: poll ? 2000 : false });
/** The speech engine right now; while it downloads or loads its model (the first voice note) it is asked every second. */
export const useSttStatus = (active: boolean) =>
  useQuery({
    queryKey: keys.stt,
    queryFn: () => api<Info>('/api/info').then((i) => i.stt ?? null),
    enabled: active,
    refetchInterval: (q) => (active && ['starting', 'downloading', 'loading'].includes(q.state.data?.state || 'starting') ? 1000 : false),
  }).data ?? null;
const reviewQuery = (slug: string) => ({ queryKey: keys.review(slug), queryFn: () => api<ReviewResponse>(`/api/review/${enc(slug)}`) });
export const useReview = (slug: string | null) => useQuery({ ...reviewQuery(slug || ''), enabled: !!slug, retry: false });
/** A card under the pointer: its review is probably next, so the player opens with its data already here. */
export const prefetchReview = (qc: QueryClient, slug: string) => qc.prefetchQuery({ ...reviewQuery(slug), staleTime: 10_000 });

/** The data the screen at `hash` shows first, asked for now (alongside who is signed in, instead of after it). */
export function prefetchScreen(qc: QueryClient, hash: string): void {
  const player = /^#\/v\/([^?]+)/.exec(hash);
  if (player) {
    let slug = '';
    try {
      slug = decodeURIComponent(player[1] as string);
    } catch {}
    if (slug) void qc.prefetchQuery(reviewQuery(slug));
  } else if (/^(#\/?)?$|^#\/(\?|inbox|open|verify|unsorted|insights|folder\/|files\/|session\/)/.test(hash)) void qc.prefetchQuery(libraryQuery);
  void qc.prefetchQuery(infoQuery);
  void qc.prefetchQuery(forYouQuery);
}

// Waveforms are cached by content hash on the server; a failed one (no audio track) renders as "no audio".
export const useWaveform = (slug: string, v: number) =>
  useQuery({
    queryKey: keys.waveform(slug, v),
    queryFn: () => api<Waveform>(`/api/waveform/${enc(slug)}/${v}`).catch((): Waveform => ({ peaks: [] })),
    ...forever,
  });
export const useAnalysis = (slug: string, v: number) =>
  useQuery({ queryKey: keys.analysis(slug, v), queryFn: () => api<Analysis>(`/api/analysis/${enc(slug)}/${v}`) });
export const useDiffQuery = (slug: string, v: number) =>
  useQuery({ queryKey: keys.diff(slug, v), queryFn: () => api<Diff>(`/api/diff/${enc(slug)}/${v}`), enabled: v > 1 });
/** The Auto-check of a version. Its end is announced (a `qa` event); while it runs the answer is asked for again now and
 * then too, so an event lost with a dropped stream doesn't leave "Checking this version…" up for good. */
export const useQaQuery = (slug: string, v: number) =>
  useQuery({
    queryKey: keys.qa(slug, v),
    queryFn: () => api<QaResult>(`/api/qa/${enc(slug)}/${v}`),
    refetchInterval: (q) => (q.state.data?.pending ? 10_000 : false),
  });
/** What is said in a version (heard once per render on the server). Its end is announced (a `transcript` event); while
 * it is being heard the answer is asked for again now and then too. `enabled`: only once someone looks at it. */
export const useTranscript = (slug: string, v: number, enabled = true) =>
  useQuery({
    queryKey: keys.transcript(slug, v),
    queryFn: () => api<TranscriptAnswer>(`/api/review/${enc(slug)}/transcript?v=${v}`),
    enabled: enabled && !!slug && v > 0,
    refetchInterval: (q) => (q.state.data?.state === 'pending' ? 10_000 : false),
  });
/** The stretch a partial render would cover around frames a–b, snapped to the version's shots (lib/part.ts). Asked for
 * only once someone opens a way to ask for one; while the shots are being found it asks again every 0.8 s. */
export const usePartSuggestion = (slug: string, v: number, a: number, b: number, enabled: boolean) =>
  useQuery({
    queryKey: keys.part(slug, v, a, b),
    queryFn: () => api<PartAnswer>(`/api/review/${enc(slug)}/part?v=${v}&in=${a}&out=${b}`),
    enabled: enabled && !!slug && v > 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    refetchInterval: (q) => (q.state.data && 'pending' in q.state.data ? 800 : false),
  });
export const useTracks = (slug: string) =>
  useQuery({ queryKey: keys.tracks(slug), queryFn: () => api<Tracks>(`/api/tracks/${enc(slug)}`), ...forever }).data ?? null;
export const useShares = (slug: string) =>
  useQuery({ queryKey: keys.shares(slug), queryFn: () => api<SharesResponse>(`/api/review/${enc(slug)}/shares`), enabled: !!slug });
export const useTunnel = () => useQuery({ queryKey: keys.tunnel, queryFn: () => api<Tunnel>('/api/tunnel') });
export const useBrowse = (dir: string) =>
  useQuery({ queryKey: keys.browse(dir), queryFn: () => api<BrowseResponse>(`/api/browse${dir ? `?dir=${enc(dir)}` : ''}`), retry: false });
export const useFolderSuggestion = (video: string | null) =>
  useQuery({
    queryKey: keys.folderSuggestion(video || ''),
    queryFn: () => api<FoldersResponse>(`/api/folders?video=${enc(video || '')}`),
    enabled: !!video,
    retry: false,
  });
export const useAllShares = () => useQuery({ queryKey: keys.allShares, queryFn: () => api<SharesResponse>('/api/shares') });
export const useFolderShares = (folder: string) =>
  useQuery({ queryKey: keys.folderShares(folder), queryFn: () => api<SharesResponse>(`/api/folder-shares?folder=${enc(folder)}`), enabled: !!folder });
export const useWebhooks = () => useQuery({ queryKey: keys.webhooks, queryFn: () => api<{ webhooks: WebhookInfo[] }>('/api/admin/webhooks') });

// Client links have no event stream (no account): they look again every 20 s, so replies and fixes show up.
const guestPoll = { retry: false, refetchInterval: 20_000, refetchIntervalInBackground: false } as const;
// A link the server can't check this moment (503, 429) is asked for again as soon as it says, not in 20 s.
export const useGuestLink = (token: string) =>
  useQuery({
    queryKey: keys.guest(token),
    queryFn: () => api<GuestLink>(`/api/g/${token}`),
    ...guestPoll,
    refetchInterval: (q) => askAgainIn(q.state.error, guestPoll.refetchInterval),
  });
export const useGuestReview = (token: string, slug: string | null, v: number | null) =>
  useQuery({
    queryKey: keys.guestReview(token, slug || '', v),
    queryFn: () => api<GuestReview>(`/api/g/${token}/review/${enc(slug || '')}${v ? `?v=${v}` : ''}`),
    enabled: !!slug,
    ...guestPoll,
    // While the video's copy is being made (a few seconds), the page asks again soon so it plays once it's there.
    // A busy server makes the copy when it has room: no need to ask every 3 s meanwhile.
    refetchInterval: (q) =>
      q.state.error
        ? askAgainIn(q.state.error, guestPoll.refetchInterval)
        : q.state.data?.busy
          ? 15_000
          : q.state.data?.preparing
            ? 3000
            : guestPoll.refetchInterval,
  });
export const useGuestWaveform = (url: string | null) =>
  useQuery({
    queryKey: keys.guestWaveform(url || ''),
    queryFn: () => api<Waveform>(url || '').catch((): Waveform => ({ peaks: [] })),
    enabled: !!url,
    ...forever,
  });

// Claude sessions: `claude agents` takes seconds, the server caches it; "Refresh" asks for a fresh list.
export function useSessions(video: string | null) {
  const qc = useQueryClient();
  const [manual, setManual] = useState(false);
  const url = (fresh: boolean) => `/api/sessions?${video ? `video=${enc(video)}&` : ''}${fresh ? 'fresh=1' : ''}`;
  const q = useQuery({ queryKey: keys.sessionsFor(video), queryFn: () => api<SessionsResponse>(url(false)) });
  const refresh = async () => {
    setManual(true);
    try {
      qc.setQueryData(keys.sessionsFor(video), await api<SessionsResponse>(url(true)));
    } finally {
      setManual(false);
    }
  };
  return { sessions: q.data?.sessions ?? (q.isError ? [] : null), refreshing: manual || !!q.data?.refreshing, refresh };
}
