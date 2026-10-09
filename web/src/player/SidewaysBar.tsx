// A phone's picture under a finger (both players): a tap plays or pauses, and says which for a moment over the picture.
// Held sideways the picture fills the screen (mobile.css "landscape phones"), and a slim bar over its foot — a frame
// back, play, a frame on, the timecode, the notes under it — comes with a tap and fades while the video plays. It is our
// player, not the browser's full screen: every step goes through the same playback hook as the dock, frame-exact.
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { timecode } from '../../../lib/time.ts';
import { t } from '../i18n/index.ts';
import { I } from '../ui/icons.tsx';
import { IconButton } from '../ui/primitives.tsx';
import { type FrameStore, useFrame } from './frameStore.ts';
import type { Playback } from './usePlayback.ts';
import '../styles/sideways.css';

/** How long the bar stays after the last touch while the video plays (the embed's bar: Embed.tsx IDLE_MS). */
const IDLE_MS = 2500;
/** Two taps closer than this are a double tap: one play or pause, not one and back at once. */
const DOUBLE_MS = 300;

/** A tap on the picture, once per double tap; `act` is the latest render's, so it reads the playback as it is now. Taps
 * are told apart by when the finger made them (`at`, the event's timeStamp), not by when they are handled: a busy page
 * handles two quick taps further apart than they were made. */
export function usePictureTap(act: () => void): (at: number) => void {
  const latest = useRef(act);
  latest.current = act;
  const last = useRef(Number.NEGATIVE_INFINITY);
  return useCallback((at: number) => {
    if (at - last.current < DOUBLE_MS) return;
    last.current = at;
    latest.current();
  }, []);
}

/** The bar's state: up while the video rests, and for IDLE_MS after each touch while it plays. `wake` is that touch. */
export function useBarAwake(on: boolean, running: boolean): { shown: boolean; wake: () => void } {
  const [awake, setAwake] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wake = useCallback(() => {
    setAwake(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setAwake(false), IDLE_MS);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { shown: on && (!running || awake), wake };
}

/** What a tap did, for a moment in the picture's middle (a new `key` each tap starts it again). Reduced motion: none
 * (the play button says it too). */
export function TapFlash({ playing }: { playing: boolean }) {
  return (
    <span className="tap-flash" aria-hidden="true" data-testid="tap-flash" data-playing={playing ? '' : undefined}>
      <I name={playing ? 'play' : 'pause'} size={26} />
    </span>
  );
}

/** Scrolls the page to the notes under the picture (smoothly, unless motion is reduced). */
export function scrollToNotes(el: Element | null | undefined) {
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el?.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' });
}

/** The timecode: the one part of the bar that follows playback frame by frame. */
function BarTimecode({ live, fps }: { live: FrameStore; fps: number }) {
  return <span className="sideways-tc">{timecode(useFrame(live), fps)}</span>;
}

interface SidewaysBarProps {
  pb: Playback;
  fps: number;
  N: number;
  shown: boolean;
  /** A touch on the bar keeps it up. */
  onWake: () => void;
  /** The notes under the picture: the button's word, the count beside it, its name. */
  notes: { word: string; n: number | null; label: string };
  onNotes: () => void;
  /** A review link's words. */
  client?: boolean;
  /** More controls before the notes (a review link's drawing tools). */
  children?: ReactNode;
}

export function SidewaysBar({ pb, fps, N, shown, onWake, notes, onNotes, client, children }: SidewaysBarProps) {
  const running = pb.playing || !!pb.revSpeed;
  // from the frame on screen when tapped (the bar doesn't render per frame)
  const step = (n: number) => {
    pb.seek(Math.max(0, Math.min(N - 1, pb.live.get() + n)));
    onWake();
  };
  return (
    <div className="sideways-bar" data-bar={shown ? 'shown' : 'hidden'} data-testid="sideways-bar" inert={!shown}>
      <IconButton
        className="btn ghost icon-only"
        label={client ? t('client::Previous frame') : t('Previous frame')}
        shortcut="←"
        icon="stepBack"
        size={20}
        onClick={() => step(-1)}
        data-testid="sideways-prev"
      />
      <IconButton
        className={`playbtn ${running ? 'playing' : ''}`}
        label={running ? (client ? t('client::Pause') : t('Pause')) : client ? t('client::Play') : t('Play')}
        shortcut="Space"
        icon={running ? 'pause' : 'play'}
        size={18}
        onClick={() => {
          if (running) pb.pause();
          else pb.play();
          onWake();
        }}
        data-testid="sideways-play"
      />
      <IconButton
        className="btn ghost icon-only"
        label={client ? t('client::Next frame') : t('Next frame')}
        shortcut="→"
        icon="stepFwd"
        size={20}
        onClick={() => step(1)}
        data-testid="sideways-next"
      />
      <BarTimecode live={pb.live} fps={fps} />
      <span className="grow" />
      {children}
      <button type="button" className="btn ghost sideways-notes" onClick={onNotes} aria-label={notes.label} data-testid="sideways-notes">
        <span>{notes.word}</span>
        {notes.n != null && <span className="sideways-n">{notes.n}</span>}
        <I name="down" size={14} />
      </button>
    </div>
  );
}
