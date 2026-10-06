// A small, calm label with a keyframe glyph (ui/glyphs.ts): the glyph carries the hue and, by its shape, the
// meaning; the words stay in the body colour, so a wall of cards doesn't turn into a wall of colour. Tinted from the
// status tokens (tone) or from a workflow stage (stage: the colours of styles/status.css). Never colour alone: the
// words always say it.
import type { ReactNode } from 'react';
import type { Stage } from '../../../lib/types.ts';
import { STAGE_SHAPE, TONE_SHAPE } from './glyphs.ts';
import { KeyGlyph, useChanged } from './KeyGlyph.tsx';

export type Tone = 'neutral' | 'must' | 'should' | 'nice' | 'idea' | 'ok' | 'claude';

interface BadgeProps {
  children: ReactNode;
  tone?: Tone;
  /** Colours of a workflow stage instead of a tone. */
  stage?: Stage;
  size?: 'sm' | 'md';
  /** A quieter second part: "Final V5 · V6 new". */
  note?: ReactNode;
  title?: string;
  className?: string;
  testId?: string;
}

export function Badge({ children, tone = 'neutral', stage, size = 'md', note, title, className = '', testId }: BadgeProps) {
  const shape = stage ? STAGE_SHAPE[stage] : (TONE_SHAPE[tone] ?? 'outline');
  // Only a change pops (a keyframe being set), not the first paint of a whole list.
  const changed = useChanged(shape);
  return (
    <span className={`sbadge ${size} ${className}`} data-tone={stage ? undefined : tone} data-stage={stage} title={title} data-testid={testId}>
      <KeyGlyph key={shape} shape={shape} pop={changed} />
      <span className="sb-label">{children}</span>
      {note && <span className="sb-note">{note}</span>}
    </span>
  );
}
