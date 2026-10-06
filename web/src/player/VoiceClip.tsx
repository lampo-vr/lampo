// A voice note on a note card: play/pause, where it is, how long it is. The length shows before it plays — a recorded
// note's clip is its stretch of the recording (lib/recording.ts clipBounds); other voice notes read it from the file's
// header, a few kilobytes. (The browser's own audio controls said "0:00 / 0:00" until played.)
import { useRef, useState } from 'react';
import { t } from '../i18n/index.ts';
import { Slider } from '../ui/controls.tsx';
import { IconButton } from '../ui/primitives.tsx';

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function VoiceClip({ src, seconds }: { src: string; seconds?: number | null }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [length, setLength] = useState<number | null>(seconds ?? null);
  const toggle = () => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => setPlaying(false));
    else el.pause();
  };
  const started = playing || at > 0;
  return (
    <div className={`voice-clip${playing ? ' playing' : ''}`} data-testid="voice-clip">
      <IconButton
        className="btn sm ghost icon-only"
        label={playing ? t('Pause the voice note') : t('Play the voice note')}
        icon={playing ? 'pause' : 'play'}
        size={13}
        onClick={toggle}
      />
      <Slider
        className="voice-seek"
        label={t('Where in the voice note')}
        value={at}
        max={length || 1}
        step={0.01}
        onChange={(v) => {
          if (audio.current) audio.current.currentTime = v;
          setAt(v);
        }}
      />
      <span className="voice-time">{started && length ? `${clock(at)} / ${clock(length)}` : length ? clock(length) : '–:––'}</span>
      {/* biome-ignore lint/a11y/useMediaCaption: a reviewer's own voice; what it says is the note's text */}
      <audio
        ref={audio}
        src={src}
        preload={seconds ? 'none' : 'metadata'}
        onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setLength(e.currentTarget.duration)}
        onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setAt(0);
        }}
      />
    </div>
  );
}
