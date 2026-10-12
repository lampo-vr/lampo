// How many videos a link for a chosen set of videos covers (Share.video_ids): the server holds a new link to it
// (POST /api/set-shares, lib/shares.ts createShare), the library's selection bar says so before it asks. Browser-safe.

/** At least two: one video is a video link. */
export const SHARE_SET_MIN = 2;
/** At most this many: a room of a hundred videos is a folder's, and a link's record per video stays bounded. */
export const SHARE_SET_MAX = 100;
