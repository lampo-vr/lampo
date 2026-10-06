// Frame-exact playback. Seeks go to the middle of a frame ((N+0.5)/fps) so rounding can never land on a neighbour;
// the frame on screen comes from requestVideoFrameCallback (mediaTime of the frame actually presented), not from
// currentTime. Seeks coalesce while the decoder is busy (lib/seek.ts); where playback starts or jumps to (a range, a
// loop) goes at once and drops a seek still waiting (seekNow). The optional B element follows A.
// The frame is also in `live` (frameStore.ts); with `quiet`, a playing video updates only that, and `frame` follows
// seeks and pauses — the owner's player doesn't render itself again 25–60 times a second.
import { useCallback, useEffect, useRef, useState } from 'react';
import { presentedFrame, timeToFrame } from '../../../lib/time.ts';
import type { FrameRange, Version } from '../api/types.ts';
import { clamp } from '../lib/format.ts';
import { reseekThroughNeighbour, seekNow, seekVideo } from '../lib/seek.ts';
import { createFrameStore } from './frameStore.ts';
import { recoverOnError } from './recover.ts';

export const RATES = [0.25, 0.5, 0.75, 1, 1.5, 2];

// What the B side of an A/B comparison plays.
export interface BSource {
  src: string | null;
  W: number;
  H: number;
  fps: number;
  frames: number;
  label: string;
}

interface PlaybackOptions {
  ver: Version;
  url: string | null | undefined;
  startFrame: string | null;
  b: BSource | null;
  /** While playing, the frame goes to `live` only (its readers subscribe); `frame` changes on seeks and pauses. */
  quiet?: boolean;
}

export function usePlayback({ ver, url, startFrame, b, quiet = false }: PlaybackOptions) {
  const { fps, frames: N } = ver;
  // Callback refs: the <video> elements remount when the layout changes (phone view, A/B), and the
  // listeners below must follow the element that is actually on screen.
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const bRef = useRef<HTMLVideoElement | null>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [bEl, setBEl] = useState<HTMLVideoElement | null>(null);
  const setVideo = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    setVideoEl(el);
  }, []);
  const setB = useCallback((el: HTMLVideoElement | null) => {
    bRef.current = el;
    setBEl(el);
  }, []);

  const [frame, setFrame] = useState(() => clamp(Number.parseInt(startFrame || '', 10) || 0, 0, N - 1));
  const frameRef = useRef(frame);
  const [live] = useState(() => createFrameStore(frame));
  const quietRef = useRef(quiet);
  quietRef.current = quiet;
  const [shown, setShown] = useState<number | null>(null);
  const [drift, setDriftState] = useState(false);
  // The drift check below runs on every frame while playing. Setting the unchanged value right after a render still
  // costs React a second commit (it can't skip an update that arrives while the previous one is being finished), so
  // only real changes go through.
  const driftRef = useRef(false);
  const setDrift = (d: boolean) => {
    if (driftRef.current === d) return;
    driftRef.current = d;
    setDriftState(d);
  };
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [muted, setMuted] = useState(false);
  const [loop, setLoop] = useState(false);
  const [inPt, setIn] = useState<number | null>(null);
  const [outPt, setOut] = useState<number | null>(null);
  const loopRef = useRef({ loop, inPt, outPt });
  // In and out as a range, whichever was set first (the timeline and the transport read them so): a loop with in after
  // out would jump back on every frame and never play.
  const both = inPt != null && outPt != null;
  loopRef.current = { loop, inPt: both ? Math.min(inPt, outPt) : inPt, outPt: both ? Math.max(inPt, outPt) : outPt };
  const reverse = useRef<ReturnType<typeof setInterval> | null>(null);
  const [revSpeed, setRevSpeed] = useState(0);
  const segments = useRef<FrameRange[] | null>(null); // "play changes": segments still to play
  // A range note playing on repeat: the one segment starts over instead of ending (any pause ends it).
  const loopSegment = useRef(false);
  const [rangeLoop, setRangeLoop] = useState<FrameRange | null>(null);

  // Another version switches at once; the smooth-scrub copy of the same version only replaces the original while
  // paused, so playback never restarts under you.
  const shownSrc = useRef({ v: ver.v, url });
  if (shownSrc.current.v !== ver.v || !shownSrc.current.url || (!playing && !revSpeed)) shownSrc.current = { v: ver.v, url };
  const src = shownSrc.current.url;

  const syncB = useCallback(
    (f: number) => {
      const el = bRef.current;
      if (!el || !b || el.readyState < 1) return;
      seekVideo(el, (Math.min(timeToFrame(f / fps, b.fps), (b.frames || 1e9) - 1) + 0.5) / b.fps);
    },
    [fps, b],
  );
  // The element's own listeners (below) are set up once per element and source, before a compare may open: they reach
  // B's sync through this ref, or a pause would leave B wherever playing left it (up to the drift check's 1.5 frames
  // off, more when B came late), with the B of when A's element arrived — none.
  const syncBRef = useRef(syncB);
  syncBRef.current = syncB;

  const stopReverse = useCallback(() => {
    if (reverse.current) clearInterval(reverse.current);
    reverse.current = null;
    setRevSpeed(0);
  }, []);

  const seek = useCallback(
    (to: number) => {
      const f = clamp(Math.round(to), 0, N - 1);
      segments.current = null;
      frameRef.current = f;
      setFrame(f);
      live.set(f);
      const vid = videoRef.current;
      if (vid && vid.readyState >= 1) {
        if (!vid.paused) vid.pause();
        seekVideo(vid, (f + 0.5) / fps);
      }
      syncB(f);
    },
    [N, fps, syncB, live],
  );

  const play = useCallback(() => {
    stopReverse();
    const vid = videoRef.current;
    if (!vid) return;
    const { loop: lp, inPt: a, outPt: z } = loopRef.current;
    if (lp && a != null && z != null && (frameRef.current >= z || frameRef.current < a)) seekNow(vid, (a + 0.5) / fps);
    else if (frameRef.current >= N - 1) seekNow(vid, 0.5 / fps);
    vid.playbackRate = rate;
    vid.play().catch(() => {});
    const bv = bRef.current;
    if (bv) {
      bv.playbackRate = rate;
      bv.play().catch(() => {});
    }
  }, [fps, N, rate, stopReverse]);

  const pause = useCallback(() => {
    segments.current = null;
    loopSegment.current = false;
    setRangeLoop(null);
    stopReverse();
    videoRef.current?.pause();
    bRef.current?.pause();
  }, [stopReverse]);

  const startReverse = useCallback(
    (speed: number) => {
      videoRef.current?.pause();
      bRef.current?.pause();
      if (reverse.current) clearInterval(reverse.current);
      setRevSpeed(speed);
      reverse.current = setInterval(
        () => {
          const f = frameRef.current - 1;
          if (f < 0) return stopReverse();
          seek(f);
        },
        1000 / (fps * speed),
      );
    },
    [fps, seek, stopReverse],
  );

  // Plays only the given ranges, one after the other, then pauses on the last frame of the last one. `loop`: one range
  // over and over until something pauses it (a range note's "Play range ⟲").
  const playSegments = useCallback(
    (segs: FrameRange[], { loop = false }: { loop?: boolean } = {}) => {
      const vid = videoRef.current;
      if (!vid || !segs.length) return;
      stopReverse();
      seekNow(vid, (segs[0].in + 0.5) / fps);
      segments.current = [...segs];
      loopSegment.current = loop && segs.length === 1;
      setRangeLoop(loopSegment.current ? segs[0] : null);
      vid.playbackRate = rate;
      vid.play().catch(() => {});
      // Before and after play together (compare, verify): B starts at the same moment and is kept in step.
      const bv = bRef.current;
      if (bv) {
        seekNow(bv, vid.currentTime);
        bv.playbackRate = rate;
        bv.play().catch(() => {});
      }
    },
    [fps, rate, stopReverse],
  );

  // video element events + frame tracking via requestVideoFrameCallback (reports the frame actually presented)
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-attach per element/source; rate is read at event time on purpose, B's sync through its ref
  useEffect(() => {
    const vid = videoEl;
    if (!vid) return;
    const onMeta = () => {
      vid.currentTime = (clamp(frameRef.current, 0, N - 1) + 0.5) / fps;
      vid.playbackRate = rate;
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => {
      setPlaying(false);
      // Quiet: where playback stopped is the player's frame again.
      setFrame(frameRef.current);
      // Whatever paused it (the end of a range, a key, the end of the file), a range on repeat stops too.
      segments.current = null;
      loopSegment.current = false;
      setRangeLoop(null);
      seekVideo(vid, (frameRef.current + 0.5) / fps); // snap to the middle of the frame on screen
      bRef.current?.pause();
      syncBRef.current(frameRef.current);
    };
    const onEnded = () => {
      const { loop: lp, inPt: a } = loopRef.current;
      if (lp) {
        seekNow(vid, ((a ?? 0) + 0.5) / fps);
        vid.play().catch(() => {});
      }
    };
    vid.addEventListener('loadedmetadata', onMeta);
    vid.addEventListener('play', onPlay);
    vid.addEventListener('pause', onPause);
    vid.addEventListener('ended', onEnded);
    if (vid.readyState >= 1) onMeta();
    let id = 0;
    let alive = true;
    const cb: VideoFrameRequestCallback = (_now, meta) => {
      if (!alive) return;
      const f = clamp(presentedFrame(meta.mediaTime, fps), 0, N - 1);
      // What is shown only matters paused (the drift check); playing, a quiet player doesn't render per frame for it.
      if (vid.paused || !quietRef.current) setShown(f);
      // Playing, and the frame is the one playback reached — not one a seek still on its way put up: a seek superseded
      // by the range's own (End, then Play range at once) can present its frame after play() began, and taken as where
      // playback is, it ended the range before it played (its out was behind f119).
      if (!vid.paused && !vid.seeking) {
        const { loop: lp, inPt: a, outPt: z } = loopRef.current;
        if (lp && z != null && f >= z) seekNow(vid, ((a ?? 0) + 0.5) / fps);
        const segs = segments.current;
        let at = f;
        if (segs && f >= segs[0].out) {
          const done = segs[0];
          if (loopSegment.current) {
            seekNow(vid, (done.in + 0.5) / fps);
            at = Math.min(f, done.out);
          } else {
            segs.shift();
            if (segs.length) seekNow(vid, (segs[0].in + 0.5) / fps);
            else {
              // End exactly on the range's last frame (a frame presented late may already be past it): the pause
              // handler snaps the picture to frameRef.
              segments.current = null;
              at = Math.min(f, done.out);
              vid.pause();
            }
          }
        }
        if (at !== frameRef.current) {
          frameRef.current = at;
          live.set(at);
          if (!quietRef.current) setFrame(at);
        }
        const bv = bRef.current;
        if (bv && bv.readyState >= 2 && Math.abs(bv.currentTime - vid.currentTime) > 1.5 / fps) seekNow(bv, vid.currentTime);
      }
      id = vid.requestVideoFrameCallback(cb);
    };
    if (vid.requestVideoFrameCallback) id = vid.requestVideoFrameCallback(cb);
    return () => {
      alive = false;
      if (id && vid.cancelVideoFrameCallback) vid.cancelVideoFrameCallback(id);
      vid.removeEventListener('loadedmetadata', onMeta);
      vid.removeEventListener('play', onPlay);
      vid.removeEventListener('pause', onPause);
      vid.removeEventListener('ended', onEnded);
    };
  }, [videoEl, src, fps, N]);

  // A source that stops working part-way (a review link's signed URL ran out) is loaded again and plays on (recover.ts).
  // biome-ignore lint/correctness/useExhaustiveDependencies: one watch per element and source
  useEffect(() => (videoEl ? recoverOnError(videoEl) : undefined), [videoEl, src]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one watch per element and source
  useEffect(() => (bEl ? recoverOnError(bEl) : undefined), [bEl, b?.src]);

  // The B element seeks to A's frame once it can; one that comes while A plays (compare opened, or its view changed,
  // mid-play) starts where A is and plays along.
  useEffect(() => {
    if (!bEl) return;
    const f = () => {
      const a = videoRef.current;
      if (!a || a.paused) return syncB(frameRef.current);
      seekNow(bEl, a.currentTime);
      bEl.playbackRate = a.playbackRate;
      bEl.play().catch(() => {});
    };
    bEl.addEventListener('loadedmetadata', f);
    if (bEl.readyState >= 1) f();
    return () => bEl.removeEventListener('loadedmetadata', f);
  }, [bEl, syncB]);

  useEffect(() => {
    if (videoEl) videoEl.muted = muted;
  }, [muted, videoEl]);
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
    if (bRef.current) bRef.current.playbackRate = rate;
  }, [rate]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new source element needs the loop flag again
  useEffect(() => {
    if (videoRef.current) videoRef.current.loop = loop && inPt == null && outPt == null;
  }, [loop, inPt, outPt, src]);
  useEffect(
    () => () => {
      if (reverse.current) clearInterval(reverse.current);
    },
    [],
  );
  // Warn only when the presented frame stays different from the requested one (a real mismatch, not a seek in flight).
  // WebKit can leave the old frame presented after the first seek (see reseekThroughNeighbour): heal once per
  // requested frame; the badge is for when that fails too.
  const healed = useRef(-1);
  // biome-ignore lint/correctness/useExhaustiveDependencies: fps is fixed per source; the refs are read at fire time
  useEffect(() => {
    if (playing || shown == null || shown === frame) {
      healed.current = -1;
      return setDrift(false);
    }
    const t = setTimeout(() => setDrift(true), 600);
    if (healed.current === frame) return () => clearTimeout(t);
    const retry = setTimeout(() => {
      const vid = videoRef.current;
      if (!vid?.paused || vid.seeking || vid.readyState < 2 || frameRef.current !== frame) return;
      healed.current = frame;
      // not cleared with the effect: the next-door frame showing up re-runs it
      reseekThroughNeighbour(vid, frame, fps, () => frameRef.current === frame);
    }, 250);
    return () => {
      clearTimeout(retry);
      clearTimeout(t);
    };
  }, [shown, frame, playing]);
  // A shorter version: stay inside it.
  useEffect(() => {
    if (frameRef.current > N - 1) seek(N - 1);
  }, [N, seek]);

  return {
    setVideo,
    setB,
    videoRef,
    frame,
    frameRef,
    /** The frame on screen, also while playing (frameStore.ts). */
    live,
    shown,
    drift,
    playing,
    rate,
    setRate,
    muted,
    setMuted,
    loop,
    setLoop,
    inPt,
    setIn,
    outPt,
    setOut,
    revSpeed,
    src,
    seek,
    play,
    pause,
    startReverse,
    playSegments,
    /** The range playing on repeat right now, or null. */
    rangeLoop,
  };
}

export type Playback = ReturnType<typeof usePlayback>;
