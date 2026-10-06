// <KeyGlyph shape="diamond" />: a keyframe glyph (ui/glyphs.ts) in the current text colour — set `color` (or a status
// token) on it or its parent. Drawn by a CSS mask, so it costs no SVG per badge and matches the pseudo-element glyphs
// exactly. Decorative: the words next to it always say the same thing.
import { type CSSProperties, useState } from 'react';
import type { Severity } from '../../../lib/types.ts';
import { SEVERITY_SHAPE, type Shape } from './glyphs.ts';

export function KeyGlyph({ shape, size, className = '', pop }: { shape: Shape; size?: number; className?: string; pop?: boolean }) {
  const style = size ? ({ '--kg-size': `${size}px` } as CSSProperties) : undefined;
  return <span className={`kg ${pop ? 'kg-pop' : ''} ${className}`} data-shape={shape} style={style} aria-hidden="true" />;
}

/** True from the render in which `value` changed on (not on the first): pass it as `pop`, with `key={value}` on the
 * glyph so the pop animation starts again. React's pattern for information from the previous render. */
export function useChanged<T>(value: T): boolean {
  const [prev, setPrev] = useState(value);
  const [changed, setChanged] = useState(false);
  if (prev !== value) {
    setPrev(value);
    setChanged(true);
  }
  return changed;
}

/** A severity's keyframe glyph in its colour (the notes' cards and the timeline use the same shapes). */
export const SevMark = ({ s, size }: { s: Severity; size?: number }) => <KeyGlyph shape={SEVERITY_SHAPE[s]} size={size} className={`sev-mark sev-${s}`} />;
