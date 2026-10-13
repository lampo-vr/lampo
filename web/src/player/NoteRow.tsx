// A note at rest, as one row — the notes panel's (CommentCard.tsx) and a review link's (guest/GuestNotes.tsx) alike: one
// button in two lines — its timecode, its kind's glyph and the first line of its words; under the words, quieter, what
// there is to say about it in words (who · V2 · 1.0 s · 2 replies) with where it stands as the system's label at the
// end, a row with nothing to say staying one line — and what the row does inside the end of line 1, shown on hover or
// focus on the row's own flat fill (notes.css .nr-line). The words come from the caller: the app's or the link's.

import { Fragment, type ReactNode } from 'react';
import { Badge, type Tone } from '../ui/Badge.tsx';

interface NoteRowProps {
  /** The timecode, or the words for a note about the whole video (`overall`). */
  tc: string;
  overall?: boolean;
  /** The kind's keyframe glyph, and its name for a screen reader. */
  glyph: ReactNode;
  kind?: string;
  /** Line 1: the first line of the note's words. */
  text: ReactNode;
  /** Line 2's left, in this order: [what it is (its class, `nr-<k>`), its words]. */
  about: [string, string][];
  /** Line 2's end: where the note stands, when that is news. */
  label: [string, Tone] | null;
  /** What the row does (Reply, ⋯), inside line 1's end, and how many buttons that is; none: a row to read and open. */
  acts?: ReactNode;
  actsCount?: number;
  onOpen: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  onBlur?: () => void;
  /** First in the button, unseen (the note's id for scripts and suites). */
  children?: ReactNode;
}

/** The quiet dot between the parts of line 2 (decoration: the words say it). */
const Dot = () => (
  <span className="nr-dot" aria-hidden="true">
    {' · '}
  </span>
);

export function NoteRow({
  tc,
  overall = false,
  glyph,
  kind,
  text,
  about,
  label,
  acts,
  actsCount = 0,
  onOpen,
  onPointerEnter,
  onPointerLeave,
  onBlur,
  children,
}: NoteRowProps) {
  return (
    <div className="nr-line" data-acts={acts ? actsCount : undefined}>
      <button
        type="button"
        className="nr nr-stack"
        onClick={onOpen}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onBlur={onBlur}
        aria-expanded={false}
        data-testid="note-row"
      >
        {children}
        <span className={`nr-tc ${overall ? 'overall' : ''}`}>{tc}</span>
        <span className="nr-kg">
          {glyph}
          {kind && <span className="sr-only">{kind}</span>}
        </span>
        <span className="nr-text">{text}</span>
        {(about.length > 0 || label) && (
          <span className="nr-sub" data-testid="note-sub">
            <span className="nr-about" data-testid="note-about">
              {about.map(([k, words], i) => (
                <Fragment key={k}>
                  {i > 0 && <Dot />}
                  <span className={`nr-${k}`}>{words}</span>
                </Fragment>
              ))}
            </span>
            {label && (
              <Badge size="sm" tone={label[1]} className="nr-state" testId="note-state">
                {label[0]}
              </Badge>
            )}
          </span>
        )}
      </button>
      {acts && <span className="nr-acts">{acts}</span>}
    </div>
  );
}
