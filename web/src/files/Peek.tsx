// The list made perfect: a row's larger picture under the pointer, beside its name (a hover card, not a click). A clip
// flips through its strip of frames (lib/fileMedia.ts scrubOf, made on the first hover) as a short silent preview; a
// picture shows larger. Never on touch: a finger has Quick Look.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FileMedia } from '../../../lib/types.ts';
import { posterUrl, scrubUrl } from './api.ts';
import { type FileRow, lengthOf, nameOf, size } from './model.ts';

/** The card's width (its picture's, 16:9); where it stands is worked out from the row. */
export const PEEK_W = 320;
const PEEK_H = 180 + 56;

/** The top of the window's content (under the app's bar): a card never goes behind it. */
const TOP = 64;

/**
 * Where the card stands for a row: from its name's start, above the row (the rows below, where the pointer goes on,
 * stay in sight), or under it when the window's top leaves no room; kept inside the window either way.
 */
export function peekAt(row: Element): { x: number; y: number; below: boolean } {
  const name = row.querySelector('.pf-name')?.getBoundingClientRect() ?? row.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  const x = Math.max(8, Math.min(window.innerWidth - PEEK_W - 16, name.left - 8));
  // above: its foot a gap over the row (whatever its height); under: its top a gap under the row
  const below = r.top - PEEK_H - 8 < TOP;
  return { x, y: below ? Math.min(window.innerHeight - PEEK_H - 8, r.bottom + 8) : r.top - 8, below };
}

export function Peek({ f, media, at }: { f: FileRow; media: FileMedia | undefined; at: { x: number; y: number; below: boolean } }) {
  const clip = f.kind === 'footage' && !!media?.seconds;
  const [poster, setPoster] = useState(false);
  const [strip, setStrip] = useState(false);
  useEffect(() => {
    setStrip(false);
    if (!clip) return;
    const img = new Image();
    img.onload = () => setStrip(true);
    img.src = scrubUrl(f.id, f.v);
  }, [clip, f.id, f.v]);
  const facts = [...(media?.seconds ? [lengthOf(media.seconds)] : []), size(f.size), ...(media?.width ? [`${media.width}×${media.height}`] : [])];
  return createPortal(
    <div
      className={`pf-peek ${at.below ? 'below' : 'above'} ${(clip ? strip : poster) ? 'ready' : ''}`}
      style={at.below ? { left: at.x, top: at.y } : { left: at.x, bottom: window.innerHeight - at.y }}
      aria-hidden="true"
      data-testid="files-peek"
    >
      <span className="pf-peek-pic">
        <img src={posterUrl(f.id, f.v)} alt="" decoding="async" onLoad={() => setPoster(true)} />
        {strip && <span className="pf-peek-flip" style={{ backgroundImage: `url(${scrubUrl(f.id, f.v)})` }} />}
      </span>
      <span className="pf-peek-name">{nameOf(f.path)}</span>
      <span className="pf-peek-facts">{facts.join(' · ')}</span>
    </div>,
    document.body,
  );
}
