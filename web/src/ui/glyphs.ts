// Keyframe glyphs: how the app marks what something is — a note's severity, a video's stage, a lane, an agent at work.
// Borrowed from the keyframes motion designers read all day: shape carries the meaning (so it survives colour
// blindness and print), a status colour tints it, nothing glows. One geometry on a 12-unit grid for three renderers:
// the <KeyGlyph> component and CSS pseudo-elements (masks in styles/base.css, --kg-*: a test keeps them identical to
// these paths) and the timeline canvas (Path2D). No DOM, no React.
import type { Severity, Stage } from '../../../lib/types.ts';

export type Shape = 'diamond' | 'half' | 'outline' | 'circle' | 'ease' | 'hold';

/** Even-odd paths on a 12 × 12 grid, centred on 6,6. */
export const SHAPES: Record<Shape, string> = {
  // a linear keyframe: settled, decided
  diamond: 'M6 .8 11.2 6 6 11.2 .8 6Z',
  // half filled: half done (fixed, waiting for a check)
  half: 'M6 .8 11.2 6 6 11.2 .8 6ZM6 3 9 6 6 9Z',
  // hollow: open, not decided yet
  outline: 'M6 .8 11.2 6 6 11.2 .8 6ZM6 3 9 6 6 9 3 6Z',
  // auto-bezier: optional, the idea
  circle: 'M6 1.2A4.8 4.8 0 1 1 6 10.8 4.8 4.8 0 1 1 6 1.2ZM6 3.3A2.7 2.7 0 1 0 6 8.7 2.7 2.7 0 1 0 6 3.3Z',
  // easy ease (an hourglass): someone is on it, time is passing
  ease: 'M1.6 1.4h8.8L6 6l4.4 4.6H1.6L6 6Z',
  // hold: nothing moves any more
  hold: 'M3.1 1.6h5.8c.8 0 1.5.7 1.5 1.5v5.8c0 .8-.7 1.5-1.5 1.5H3.1c-.8 0-1.5-.7-1.5-1.5V3.1c0-.8.7-1.5 1.5-1.5Z',
};

/** Severity by shape: must > should > nice > idea read without colour. */
export const SEVERITY_SHAPE: Record<Severity, Shape> = { must: 'diamond', should: 'half', nice: 'outline', idea: 'circle' };

/** Where a video stands: open work hollow, half-done half, someone on it an hourglass, approved solid, final on hold. */
export const STAGE_SHAPE: Record<Stage, Shape> = {
  to_review: 'outline',
  changes: 'diamond',
  in_progress: 'ease',
  check_fixes: 'half',
  team_approved: 'diamond',
  with_client: 'ease',
  client_approved: 'diamond',
  final: 'hold',
};

/** The board's lanes. */
export const LANE_SHAPE: Record<string, Shape> = { needs_you: 'outline', fixing: 'ease', approved: 'diamond', final: 'hold' };

/** Badge tones without a stage. */
export const TONE_SHAPE: Record<string, Shape> = {
  neutral: 'outline',
  must: 'diamond',
  should: 'half',
  nice: 'outline',
  idea: 'circle',
  ok: 'diamond',
  claude: 'ease',
};

/** Notes that aren't feedback: a question waits (hourglass), an info note just is (hold); agent notes of old stores too. */
export const KIND_SHAPE = { question: 'ease', info: 'hold', agent: 'ease' } as const satisfies Record<string, Shape>;
