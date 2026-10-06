// Collects what plays in a <video> in coarse pieces (lib/watch.ts): which hundredths of the version played, how often
// each one did, and for how long — never the moments themselves — and hands it to `send` every 15 s while it plays,
// when it stops, when the tab hides and when the page goes away. Both players report this way: the guest player to
// its review link, the owner's player to the video (lib/views.ts). Listening to `timeupdate` never touches playback.
import { type RefObject, useEffect, useRef } from 'react';
import { encodeParts, MAX_PLAYS_PER_REPORT, MAX_SECS_PER_REPORT, PARTS, partOf } from '../../../lib/watch.ts';

const EVERY = 15_000;

export interface WatchReport {
  seen: string;
  plays: number[];
  secs: number;
}

interface Pending {
  parts: Set<number>;
  plays: number[];
  secs: number;
}

const empty = (): Pending => ({ parts: new Set(), plays: new Array<number>(PARTS).fill(0), secs: 0 });

/** Posts a report so it survives the page going away: a beacon, or where there is none a fetch that outlives the page. */
export function beacon(url: string, body: object): void {
  const json = JSON.stringify(body);
  if (!navigator.sendBeacon?.(url, new Blob([json], { type: 'application/json' })))
    fetch(url, { method: 'POST', body: json, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {});
}

interface Options {
  video: RefObject<HTMLVideoElement | null>;
  playing: boolean;
  /** What the reports are about (a video and its version): a change sends what was collected for the one before. */
  about: string;
  /** Nothing is collected or sent while off (a viewer who isn't a person). */
  on: boolean;
  /** Sends a report; `about` is what it was collected for (the render may have moved on by the time it goes). */
  send: (r: WatchReport, about: string) => void;
}

export function useWatchReport({ video, playing, about, on, send }: Options): void {
  const pending = useRef<Pending>(empty());
  const flushRef = useRef<() => void>(() => {});
  const sendRef = useRef(send);
  sendRef.current = send;
  // The part counted last while playing on: stepping through a part counts it once; a seek or a loop back counts the
  // part it lands in again (that is someone watching it again). Kept across pauses, so resuming doesn't count twice.
  const counted = useRef(-1);
  // Parts that have had a play counted for this video and version. The ticks start a moment after playback does
  // (`playing` arrives a render later; a seek as it starts moves the tick's starting point), so on a short video the
  // first hundredths slip past them; the element's own record of what played (`played`) fills that in — as seen, and
  // as one play for a part no tick ever counted, never more.
  const credited = useRef(new Set<number>());

  // Collect while it plays: every hundredth between two ticks (a short video's hundredths are shorter than a tick),
  // forward steps only (a jump is a seek, not watching). Declared before the sender, so a change of video hands its
  // last parts to the report about that video.
  useEffect(() => {
    const el = video.current;
    if (!playing || !el || !on) return;
    let last = el.currentTime;
    const count = (i: number) => {
      const p = pending.current;
      p.plays[i] = Math.min(MAX_PLAYS_PER_REPORT, (p.plays[i] || 0) + 1);
      credited.current.add(i);
    };
    // Everything the element has played in one stretch up to here (the range of `played` holding the playhead).
    const fromPlayed = (t: number) => {
      const r = el.played;
      for (let k = 0; k < r.length; k++) {
        if (r.start(k) <= t + 1e-3 && t <= r.end(k) + 1e-3) {
          const p = pending.current;
          const here = partOf(t, el.duration);
          for (let i = partOf(r.start(k), el.duration); i <= here; i++) {
            p.parts.add(i);
            if (credited.current.has(i)) continue;
            count(i);
            // the part playing now: the next tick goes on from it, not over it again
            if (i === here) counted.current = i;
          }
          return;
        }
      }
    };
    const tick = () => {
      const t = el.currentTime;
      const step = t - last;
      if (step > 0 && step < 1.5) {
        const p = pending.current;
        p.secs += step;
        for (let i = partOf(last, el.duration); i <= partOf(t, el.duration); i++) {
          p.parts.add(i);
          if (i !== counted.current) {
            count(i);
            counted.current = i;
          }
        }
      } else if (step !== 0) counted.current = -1;
      fromPlayed(t);
      last = t;
    };
    fromPlayed(last);
    const seeked = () => {
      counted.current = -1;
      last = el.currentTime;
    };
    el.addEventListener('timeupdate', tick);
    el.addEventListener('seeking', seeked);
    return () => {
      tick();
      el.removeEventListener('timeupdate', tick);
      el.removeEventListener('seeking', seeked);
      flushRef.current();
    };
  }, [playing, video, on]);

  // Another video or version sends what was collected for the one before.
  useEffect(() => {
    if (!on) return;
    counted.current = -1;
    credited.current = new Set();
    const flush = () => {
      const p = pending.current;
      if (!p.parts.size) return;
      pending.current = empty();
      sendRef.current({ seen: encodeParts(p.parts), plays: p.plays, secs: Math.min(MAX_SECS_PER_REPORT, Math.round(p.secs * 10) / 10) }, about);
    };
    flushRef.current = flush;
    const hidden = () => document.visibilityState === 'hidden' && flush();
    const timer = setInterval(flush, EVERY);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', flush);
    return () => {
      flush();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', flush);
      flushRef.current = () => {};
    };
  }, [about, on]);
}
