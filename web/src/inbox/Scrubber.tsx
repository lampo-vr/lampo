// The small player's timeline: where the playhead is, the item's moment on it (a keyframe at its frame, a band for a
// range), dragged or clicked to any frame (touch too), keys like a slider (←/→ a frame, ⇧ a second, Home/End), and
// on hover the frame under the pointer from the render's sprite with its timecode.
import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react';
import { spriteBackground, spriteTile } from '../../../lib/sprite.ts';
import { timecode } from '../../../lib/time.ts';
import type { ForYouKind } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { clamp } from '../lib/format.ts';

export interface ScrubMark {
  frame: number;
  range?: { in: number; out: number } | null;
  kind: ForYouKind;
}

interface ScrubberProps {
  frames: number;
  fps: number;
  /** The playhead's frame. */
  at: number;
  mark: ScrubMark | null;
  /** The render's sprite once it exists (lib/sprite.ts), and the picture's shape for its tile. */
  sprite: string | null;
  width: number;
  height: number;
  onSeek: (frame: number) => void;
}

export function Scrubber({ frames, fps, at, mark, sprite, width, height, onSeek }: ScrubberProps) {
  const last = Math.max(0, frames - 1);
  const pct = (f: number) => `${last ? (clamp(f, 0, last) / last) * 100 : 0}%`;
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [hover, setHover] = useState<{ f: number; x: number } | null>(null);

  const pointAt = (e: PointerEvent) => {
    const r = (box.current as HTMLDivElement).getBoundingClientRect();
    const x = clamp(e.clientX - r.left, 0, r.width);
    return { f: Math.round((x / (r.width || 1)) * last), x, w: r.width };
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    onSeek(pointAt(e).f);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = pointAt(e);
    if (dragging.current) onSeek(p.f);
    // the frame under a mouse (a finger is on the playhead already)
    if (e.pointerType === 'mouse') setHover({ f: p.f, x: clamp(p.x, 44, Math.max(44, p.w - 44)) });
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onKey = (e: KeyboardEvent) => {
    const by = e.shiftKey ? Math.round(fps) : 1;
    const to =
      e.key === 'ArrowLeft' || e.key === 'ArrowDown'
        ? at - by
        : e.key === 'ArrowRight' || e.key === 'ArrowUp'
          ? at + by
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null;
    if (to == null || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    // the preview's own keys (←/→ on the page) must not step a second time
    e.stopPropagation();
    onSeek(clamp(to, 0, last));
  };
  const tile = hover && sprite ? spriteBackground(spriteTile(hover.f / (last || 1))) : null;
  const range = mark?.range && mark.range.out > mark.range.in ? mark.range : null;
  return (
    <div
      ref={box}
      className="inbox-scrub"
      role="slider"
      tabIndex={0}
      aria-label={t('Position in the video')}
      aria-valuemin={0}
      aria-valuemax={last}
      aria-valuenow={at}
      aria-valuetext={`${timecode(at, fps)} · F${at}`}
      data-testid="inbox-scrub"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onPointerLeave={() => setHover(null)}
      onKeyDown={onKey}
    >
      <div className="inbox-scrub-track">
        <div className="inbox-scrub-fill" style={{ width: pct(at) }} />
        {range && <div className="inbox-scrub-range" style={{ left: pct(range.in), width: `calc(${pct(range.out)} - ${pct(range.in)})` }} />}
        {mark && <span className={`inbox-scrub-mark k-${mark.kind}`} style={{ left: pct(mark.frame) }} data-testid="inbox-scrub-mark" />}
        <span className="inbox-scrub-head" style={{ left: pct(at) }} />
      </div>
      {hover && (
        <div className="inbox-scrub-tip" style={{ left: hover.x }} aria-hidden="true">
          {tile && (
            <span
              className="inbox-scrub-frame"
              style={{
                aspectRatio: `${width} / ${height}`,
                backgroundImage: `url("${sprite}")`,
                backgroundSize: tile.size,
                backgroundPosition: tile.position,
              }}
            />
          )}
          <span className="mono">{timecode(hover.f, fps)}</span>
        </div>
      )}
    </div>
  );
}
