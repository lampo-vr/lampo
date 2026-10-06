// The video someone is about to open, fetched before they do. A card under the pointer, or reached with the keyboard,
// gets its review (the player's data) at once; if the pointer stays a moment, also the first megabyte of the render
// and the timeline's sprite, so the player opens with its first frame at hand instead of starting a download then.
import type { QueryClient } from '@tanstack/react-query';
import { renderKey } from '../../../lib/renderKey.ts';
import { keys, prefetchReview } from './queries.ts';
import { spriteUrl, warmSprite } from './sprite.ts';
import type { ReviewResponse } from './types.ts';

/** How long the pointer rests on a card before the render's first bytes are worth fetching. */
const DWELL = 180;
/** The start of a render: enough for the first frames of most exports. */
const HEAD_BYTES = 1024 * 1024;
const warmed = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;

function warmMedia(qc: QueryClient, slug: string) {
  const r = qc.getQueryData<ReviewResponse>(keys.review(slug));
  const latest = r?.review.versions.at(-1);
  const url = latest && r?.media[latest.v]?.url;
  if (!url || warmed.has(url)) return;
  warmed.add(url);
  // Into the HTTP cache, where the player's own range requests find it.
  fetch(url, { headers: { Range: `bytes=0-${HEAD_BYTES - 1}` }, priority: 'low' } as RequestInit)
    .then((res) => res.arrayBuffer())
    .catch(() => warmed.delete(url));
  if (latest?.hash) void warmSprite(spriteUrl(slug, renderKey(latest)));
}

/** `now`: keyboard focus (the next key opens it); otherwise a pointer, which may only be passing over. */
export function prefetchVideo(qc: QueryClient, slug: string, { now = false } = {}): void {
  const review = prefetchReview(qc, slug);
  clearTimeout(timer);
  timer = setTimeout(() => void review.then(() => warmMedia(qc, slug)), now ? 0 : DWELL);
}

/** The pointer left before the moment was up: its render isn't fetched. */
export function cancelPrefetch(): void {
  clearTimeout(timer);
}
