// The inbox preview's small player, frame-exact like the main player: seeks go to (N + 0.5) / fps, the frame on screen
// is read back from requestVideoFrameCallback, WebKit's stale first frame is healed once. It rests on the item's
// frame; from there it plays and pauses (a pause parks on the frame on screen), steps by frames and seconds, is
// scrubbed to any frame, and plays "around it": from 1.5 s before the frame to 1.5 s after, once, then back on it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { presentedFrame } from '../../../lib/time.ts';
import { clamp } from '../lib/format.ts';
import { reseekThroughNeighbour, seekVideo } from '../lib/seek.ts';

const AROUND_S = 1.5;
const MUTED_KEY = 'vr.inbox.muted';

const mutedPref = () => {
  try {
    return localStorage.getItem(MUTED_KEY) === '1';
  } catch {
    return false;
  }
};

export function usePreviewPlayer({ fps, frames, frame }: { fps: number; frames: number; frame: number }) {
  const [video, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [target, setTarget] = useState(frame);
  const [shown, setShown] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMutedState] = useState(mutedPref);
  const targetRef = useRef(frame);
  const shownRef = useRef<number | null>(null);
  // "play around it" ends here and goes back to the frame; plain play runs on
  const stopAt = useRef<number | null>(null);
  const healed = useRef(-1);
  const last = Math.max(0, frames - 1);

  const park = useCallback(
    (f: number) => {
      const n = clamp(Math.round(f), 0, last);
      targetRef.current = n;
      stopAt.current = null;
      setTarget(n);
      if (video && video.readyState >= 1) {
        if (!video.paused) video.pause();
        seekVideo(video, (n + 0.5) / fps);
      }
    },
    [video, last, fps],
  );

  // A new item (or a new version of it): park on its frame.
  useEffect(() => park(frame), [frame, park]);

  useEffect(() => {
    if (video) video.muted = muted;
  }, [video, muted]);

  useEffect(() => {
    if (!video) return;
    const onMeta = () => seekVideo(video, (targetRef.current + 0.5) / fps);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    // The end of the render: "play around it" goes back on its frame, plain play rests on the last frame.
    const onEnded = () => {
      const back = stopAt.current != null;
      stopAt.current = null;
      if (!back) {
        targetRef.current = last;
        setTarget(last);
      }
      seekVideo(video, (targetRef.current + 0.5) / fps);
    };
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded);
    if (video.readyState >= 1) onMeta();
    let id = 0;
    let alive = true;
    const cb: VideoFrameRequestCallback = (_now, meta) => {
      if (!alive) return;
      const f = presentedFrame(meta.mediaTime, fps);
      shownRef.current = f;
      setShown(f);
      // the end of "play around it": back on the frame it was around
      if (stopAt.current != null && f >= stopAt.current) {
        stopAt.current = null;
        video.pause();
        seekVideo(video, (targetRef.current + 0.5) / fps);
      }
      id = video.requestVideoFrameCallback(cb);
    };
    if (video.requestVideoFrameCallback) id = video.requestVideoFrameCallback(cb);
    return () => {
      alive = false;
      if (id && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(id);
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onEnded);
    };
  }, [video, fps, last]);

  // Parked but a different frame on screen for a moment: WebKit's stale first seek. Heal once per frame.
  useEffect(() => {
    if (!video || playing || shown == null || shown === target || healed.current === target) return;
    const t = setTimeout(() => {
      if (!video.paused || video.seeking || video.readyState < 2 || targetRef.current !== target) return;
      healed.current = target;
      reseekThroughNeighbour(video, target, fps, () => targetRef.current === target);
    }, 250);
    return () => clearTimeout(t);
  }, [video, shown, target, playing, fps]);

  /** Where it is now: the frame on screen while it plays, the frame it rests on otherwise. */
  const current = useCallback(() => (video && !video.paused && shownRef.current != null ? shownRef.current : targetRef.current), [video]);

  const step = useCallback((d: number) => park(current() + d), [park, current]);

  const play = useCallback(() => {
    if (!video || video.readyState < 1) return;
    stopAt.current = null;
    // at the end, play starts over
    if (targetRef.current >= last) {
      targetRef.current = 0;
      setTarget(0);
      seekVideo(video, 0.5 / fps);
    }
    video.play().catch(() => {});
  }, [video, last, fps]);

  /** Pause where it is: parked on the frame on screen, so what you see is the frame you stopped on. */
  const pause = useCallback(() => park(current()), [park, current]);

  const toggle = useCallback(() => (video && !video.paused ? pause() : play()), [video, pause, play]);

  const playAround = useCallback(() => {
    if (!video || video.readyState < 1) return;
    const span = Math.round(AROUND_S * fps);
    const from = Math.max(0, targetRef.current - span);
    stopAt.current = Math.min(last, targetRef.current + span);
    seekVideo(video, (from + 0.5) / fps);
    video.play().catch(() => {});
  }, [video, fps, last]);

  const setMuted = useCallback((m: boolean) => {
    setMutedState(m);
    try {
      localStorage.setItem(MUTED_KEY, m ? '1' : '0');
    } catch {}
  }, []);

  return {
    setVideo: setVideoEl,
    /** The frame it rests on (or was asked to go to). */
    frame: target,
    shown,
    /** The frame asked for is the one on screen (the poster can go). */
    presented: shown === target && !playing,
    playing,
    muted,
    setMuted,
    current,
    /** Go to a frame and rest there (a scrub, a click on the timeline). */
    seek: park,
    step,
    play,
    pause,
    toggle,
    playAround,
  };
}

export type PreviewPlayer = ReturnType<typeof usePreviewPlayer>;
