// A render's poster in a frame of any aspect: close enough to the frame, it fills it; otherwise it sits whole inside,
// over a blurred copy of itself (a 9:16 reel in a 16:10 card). With `scrub`, moving the pointer across it flips
// through the render (the hover-scrub sprite, lib/sprite.ts), with a thin playhead along the bottom. Touch has no
// hover: there the poster stays still.
import { type CSSProperties, type PointerEvent, useState } from 'react';
import { spriteBackground, spriteTile } from '../../../lib/sprite.ts';
import { useSprite } from '../api/sprite.ts';

export { posterUrl } from '../lib/posterUrl.ts';

/** Cards frame posters at 16:10: wide renders fill it, reels and scope renders sit whole over their own blur. */
export const CARD_FRAME = 16 / 10;

/** The box a `w×h` picture takes in a frame of `frame` aspect, in % of the frame: filling it, or whole inside it. */
function box(w: number, h: number, frame: number, fill: boolean): CSSProperties {
  const a = w > 0 && h > 0 ? w / h : 16 / 9;
  const wider = a > frame;
  // Filling a wider frame means the picture is as wide as it (and taller); fitting means the other way round.
  const byWidth = fill ? !wider : wider;
  return byWidth ? { width: '100%', height: `${(frame / a) * 100}%` } : { height: '100%', width: `${(a / frame) * 100}%` };
}

interface PosterProps {
  src: string | null;
  /** The hover-scrub sprite; scrubbing is off without one. */
  sprite?: string | null;
  /** The video's slug (the `sprite` event names it). */
  slug: string;
  width: number;
  height: number;
  /** Width / height of the frame the poster sits in. */
  frame: number;
  className?: string;
  /** One of the first posters on screen: fetched at once and first, not when the browser gets round to it. */
  priority?: boolean;
}

export function Poster({ src, sprite: spriteSrc = null, slug, width, height, frame, className = '', priority = false }: PosterProps) {
  const scrub = !!spriteSrc;
  const a = width > 0 && height > 0 ? width / height : 16 / 9;
  // Within 15% of the frame's shape: fill it (a sliver cropped); a reel or a scope render: whole, over its blur.
  const fill = Math.abs(a - frame) / frame < 0.15;
  const [hover, setHover] = useState(false);
  const [at, setAt] = useState(0);
  const sprite = useSprite(spriteSrc, slug, scrub && hover);
  const style = box(width, height, frame, fill);
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse') return;
    const r = e.currentTarget.getBoundingClientRect();
    setAt(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
    setHover(true);
  };
  const tile = sprite && hover ? spriteBackground(spriteTile(at)) : null;
  return (
    <div
      className={`poster-frame ${className}`}
      style={{ aspectRatio: frame }}
      onPointerMove={scrub ? move : undefined}
      onPointerLeave={scrub ? () => setHover(false) : undefined}
    >
      {src && !fill && <img className="poster-blur" src={src} alt="" loading="lazy" decoding="async" draggable={false} />}
      {src && (
        <img
          className="poster-img"
          src={src}
          style={style}
          alt=""
          loading={priority ? 'eager' : 'lazy'}
          fetchPriority={priority ? 'high' : 'auto'}
          decoding="async"
          draggable={false}
        />
      )}
      {tile && (
        <div
          className="poster-img scrub"
          style={{ ...style, backgroundImage: `url("${sprite}")`, backgroundSize: tile.size, backgroundPosition: tile.position }}
          data-testid="scrub"
        />
      )}
      {scrub && hover && <div className="scrub-head" style={{ '--at': at } as CSSProperties} aria-hidden="true" />}
    </div>
  );
}
