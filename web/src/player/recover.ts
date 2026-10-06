// A <video> whose source stops working part-way loads it again and carries on. Review links hand out signed storage
// URLs that live minutes (SIGNED_URL_SECONDS in lib/storage/index.ts, A12 GUEST-11), and a browser keeps asking the URL
// a redirect gave it: once that has run out, its next range request fails and the element errors. Loading the
// element's own source again asks the server, which checks the link and redirects to a fresh URL; usePlayback's
// loadedmetadata handler puts it back on the frame it showed, and it plays on if it was playing. A source that never
// loaded is never retried, and one that keeps failing gets RELOADS tries a minute — a revoked link's media stops.

/** Reloads of one source within a minute before an error is left standing. */
export const RELOADS = 3;

type Media = Pick<HTMLMediaElement, 'paused' | 'readyState' | 'load' | 'play' | 'addEventListener' | 'removeEventListener'>;

/** Watches `el` until the returned function is called (on a new source or element). */
export function recoverOnError(el: Media, now: () => number = Date.now): () => void {
  let loaded = el.readyState >= 1;
  // Whether it should be playing: by its play and pause events — a browser that errors sets `paused` without a pause
  // event (Chrome), so `paused` at the error says nothing about what the person was doing.
  let playing = !el.paused;
  let resume = false;
  let tries: number[] = [];
  const onPlay = () => {
    playing = true;
  };
  const onPause = () => {
    playing = false;
  };
  const onMeta = () => {
    loaded = true;
    if (!resume) return;
    resume = false;
    el.play().catch(() => {});
  };
  const onError = () => {
    if (!loaded) return;
    const t = now();
    tries = tries.filter((x) => t - x < 60_000);
    if (tries.length >= RELOADS) return;
    tries.push(t);
    resume = resume || playing;
    el.load();
  };
  const on: [string, () => void][] = [
    ['play', onPlay],
    ['pause', onPause],
    ['loadedmetadata', onMeta],
    ['error', onError],
  ];
  for (const [type, fn] of on) el.addEventListener(type, fn);
  return () => {
    for (const [type, fn] of on) el.removeEventListener(type, fn);
  };
}
