// A video's poster URL, keyed by its newest render (a new version is a new URL). Shared by the library's cards, the
// sidebar's Recent and the palette, so it lives outside the Poster component.
import { enc } from '../api/client.ts';
import type { VideoSummary } from '../api/types.ts';

export const posterUrl = (v: Pick<VideoSummary, 'slug' | 'hash'>) => `/api/poster/${enc(v.slug)}.jpg?h=${v.hash.slice(0, 10)}`;
