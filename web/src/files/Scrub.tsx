// A clip's picture that scrubs: under a mouse (never a finger), the frame for where the pointer is across it, from a
// strip of frames the server makes on the first hover (GET /api/files/:id/scrub, lib/fileMedia.ts scrubOf), with a thin
// line and the time under it. Pictures and anything without a strip show their poster, still.
import { type PointerEvent, useRef, useState } from 'react';
import type { FileMedia } from '../../../lib/types.ts';
import { posterUrl, scrubUrl } from './api.ts';
import { type FileRow, lengthOf } from './model.ts';

/** How many frames the strip holds (lib/fileMedia.ts SCRUB_FRAMES). */
const FRAMES = 8;

export function ScrubPicture({ f, media, className = '' }: { f: FileRow; media: FileMedia | undefined; className?: string }) {
  const [shown, setShown] = useState<'wait' | 'ok' | 'none'>('wait');
  const [at, setAt] = useState<number | null>(null);
  const [strip, setStrip] = useState<'none' | 'wait' | 'ok'>('none');
  const asked = useRef(false);
  const clip = f.kind === 'footage' && !!media?.seconds;
  const move = (e: PointerEvent<HTMLSpanElement>) => {
    if (!clip || e.pointerType !== 'mouse') return;
    const r = e.currentTarget.getBoundingClientRect();
    setAt(Math.min(0.999, Math.max(0, (e.clientX - r.left) / r.width)));
    if (!asked.current) {
      asked.current = true;
      setStrip('wait');
      const img = new Image();
      img.onload = () => setStrip('ok');
      img.onerror = () => setStrip('none');
      img.src = scrubUrl(f.id, f.v);
    }
  };
  const frame = at === null ? 0 : Math.floor(at * FRAMES);
  return (
    <span
      className={`pf-scrub ${shown === 'ok' ? 'has-pic' : ''} ${at !== null && strip === 'ok' ? 'scrubbing ready' : ''} ${className}`}
      onPointerMove={move}
      onPointerLeave={() => setAt(null)}
    >
      {media?.poster && shown !== 'none' && (
        <img
          src={posterUrl(f.id, f.v)}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setShown('ok')}
          onError={() => setShown('none')}
        />
      )}
      {at !== null && strip === 'ok' && (
        <span
          className="pf-scrub-frame"
          style={{ backgroundImage: `url(${scrubUrl(f.id, f.v)})`, backgroundPosition: `${(frame / (FRAMES - 1)) * 100}% 0` }}
          aria-hidden="true"
        />
      )}
      {at !== null && clip && (
        <>
          <span className="pf-scrub-line" style={{ width: `${at * 100}%` }} aria-hidden="true" />
          <span className="pf-scrub-time" aria-hidden="true">
            {lengthOf((media?.seconds ?? 0) * at)}
          </span>
        </>
      )}
    </span>
  );
}
