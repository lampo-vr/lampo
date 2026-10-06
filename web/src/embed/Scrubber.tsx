// The embed's timeline: one thin track across the player — what has played, what has loaded, the playhead — with the
// video's chapters as keyframe glyphs on it. Pressing anywhere goes to that frame (a press within a glyph's reach goes
// to its chapter's first frame), dragging scrubs frame by frame; pointing shows the frame there from the render's hover
// frames (lib/sprite.ts), its timecode and its chapter. Every move is a frame number handed to the player
// (usePlayback.seek: the middle of the frame), never a time.
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { spriteBackground, spriteTile } from '../../../lib/sprite.ts';
import { timecode } from '../../../lib/time.ts';
import type { Chapter } from '../../../lib/types.ts';
import { clamp } from '../lib/format.ts';
import { type FrameStore, useFrame } from '../player/frameStore.ts';

/** How close to a chapter's glyph (in px) a press goes to the chapter's first frame. */
const SNAP = 6;

/** The chapter a frame is in: the last one starting at or before it. */
export const chapterAt = (chapters: Chapter[], frame: number): Chapter | null => {
  let at: Chapter | null = null;
  for (const c of chapters) if (c.frame <= frame) at = c;
  return at;
};

/** The render's hover frames once they exist (the server makes them on first request: 202 until then), else null. */
function useSprite(url: string, wanted: boolean): string | null {
  const [ready, setReady] = useState<string | null>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (!wanted || asked.current) return;
    asked.current = true;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const ask = async () => {
      try {
        const res = await fetch(url);
        if (!live) return;
        if (res.status === 202 && ++tries < 10) timer = setTimeout(ask, Math.min(30, Number(res.headers.get('retry-after')) || 5) * 1000);
        else if (res.ok) {
          // in the HTTP cache now (immutable): the background that shows it costs no second download
          await res.blob();
          if (live) setReady(url);
        }
      } catch {}
    };
    void ask();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [url, wanted]);
  return ready;
}

interface Props {
  frames: number;
  fps: number;
  live: FrameStore;
  chapters: Chapter[];
  sprite: string;
  /** The video's width / height. */
  aspect: number;
  video: HTMLVideoElement | null;
  onSeek: (frame: number) => void;
  /** A drag starts (true) or ends: the player keeps its bar up meanwhile, and plays on after it if it was playing. */
  onScrub: (active: boolean) => void;
  label: string;
}

export function Scrubber({ frames, fps, live, chapters, sprite, aspect, video, onSeek, onScrub, label }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const f = useFrame(live);
  const last = Math.max(1, frames - 1);
  const [point, setPoint] = useState<{ x: number; frame: number; width: number } | null>(null);
  const [drag, setDrag] = useState(false);
  const [loaded, setLoaded] = useState(0);
  const sheet = useSprite(sprite, point !== null);

  // how much of the video has loaded around the playhead (the stretch of `buffered` it is in)
  useEffect(() => {
    if (!video) return;
    const measure = () => {
      const t = video.currentTime;
      const d = video.duration;
      let end = 0;
      for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= t + 0.5) end = Math.max(end, video.buffered.end(i));
      setLoaded(Number.isFinite(d) && d > 0 ? Math.min(1, end / d) : 0);
    };
    const on = ['progress', 'timeupdate', 'seeked'] as const;
    for (const type of on) video.addEventListener(type, measure);
    return () => {
      for (const type of on) video.removeEventListener(type, measure);
    };
  }, [video]);

  /** The frame under `clientX`, a chapter's first frame when it is within reach of its glyph. */
  const frameAt = (clientX: number): { x: number; frame: number; width: number } => {
    const r = (ref.current as HTMLDivElement).getBoundingClientRect();
    const x = clamp(clientX - r.left, 0, r.width);
    const near = chapters.find((c) => Math.abs((c.frame / last) * r.width - x) <= SNAP);
    return { x, frame: near ? near.frame : Math.round((x / Math.max(1, r.width)) * last), width: r.width };
  };

  const at = point ? point.frame : f;
  const chapter = chapterAt(chapters, at);
  // the peek's picture (once the hover frames are there) fits 160 × 100 (a reel's is narrower) inside its 4 px mat, and
  // the peek stays inside the track
  const peekW = sheet ? (aspect >= 1.6 ? 160 : Math.max(56, Math.round(100 * aspect))) + 8 : 88;
  const peekLeft = point ? clamp(point.x, peekW / 2, Math.max(peekW / 2, point.width - peekW / 2)) : 0;
  const tile = point && sheet ? spriteBackground(spriteTile(point.frame / last)) : null;

  return (
    <div
      ref={ref}
      className="em-scrub"
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={frames - 1}
      aria-valuenow={f}
      aria-valuetext={chapterAt(chapters, f) ? `${timecode(f, fps)}, ${chapterAt(chapters, f)?.title}` : timecode(f, fps)}
      data-active={drag || point ? '' : undefined}
      style={{ '--at': f / last, '--loaded': loaded } as CSSProperties}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = frameAt(e.clientX);
        setDrag(true);
        setPoint(p);
        onScrub(true);
        onSeek(p.frame);
      }}
      onPointerMove={(e) => {
        const p = frameAt(e.clientX);
        if (drag) onSeek(p.frame);
        if (drag || e.pointerType === 'mouse') setPoint(p);
      }}
      onPointerUp={(e) => {
        if (!drag) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        setDrag(false);
        if (e.pointerType !== 'mouse') setPoint(null);
        onScrub(false);
      }}
      onPointerCancel={() => {
        setDrag(false);
        setPoint(null);
        onScrub(false);
      }}
      onPointerLeave={() => !drag && setPoint(null)}
    >
      <div className="em-track">
        <div className="em-loaded" />
        <div className="em-played" />
      </div>
      {/* (a chapter on the first frame is where the timeline starts anyway: named, not marked) */}
      {chapters
        .filter((c) => c.frame > 0)
        .map((c) => (
          <span key={c.frame} className="em-ch" style={{ '--x': c.frame / last } as CSSProperties} data-passed={f >= c.frame ? '' : undefined} />
        ))}
      <div className="em-head" />
      {point && (
        <div className="em-peek" style={{ left: peekLeft, width: peekW }} aria-hidden="true">
          {tile && (
            <div
              className="em-peek-frame"
              style={{ aspectRatio: String(aspect), backgroundImage: `url("${sheet}")`, backgroundSize: tile.size, backgroundPosition: tile.position }}
            />
          )}
          <div className="em-peek-tc">{timecode(point.frame, fps)}</div>
          {chapter && <div className="em-peek-ch">{chapter.title}</div>}
        </div>
      )}
    </div>
  );
}
