// Reopening a final pauses the posts Lampo still has to send (Instagram, Facebook, or anything not out yet), but not a
// YouTube schedule: YouTube holds that upload itself and makes it public at its time whatever happens here
// (docs/publishing.md). Whoever reopens is told so first: here for the player's reopen; the board's move out of Final
// (library/moving.tsx) keeps its own copy, so the board carries none of publishing's code.
import type { StageInfo } from '../../../lib/types.ts';
import { t } from '../i18n/index.ts';

/** A YouTube post of this final waits on YouTube's own schedule. */
export const youtubeHeld = (s: StageInfo | undefined): boolean => !!s?.published?.posts.some((p) => p.platform === 'youtube' && p.state === 'scheduled');

export const heldWords = (): string =>
  t('YouTube holds its scheduled upload itself: it still goes public at its time unless you take it back in YouTube Studio.');
