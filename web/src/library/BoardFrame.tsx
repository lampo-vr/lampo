// The board's frame (library/Board.tsx): a lane with its head, and the four lanes as they stand while the library or
// the board's own code is on its way. This part rides with the library; the board itself is a chunk of its own.
import type { ReactNode } from 'react';
import { LANES } from '../../../lib/stage.ts';
import { useScrollEdges } from '../lib/hooks.ts';
import { laneLabel } from '../status/stageText.ts';
import { LANE_SHAPE } from '../ui/glyphs.ts';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { SkLine } from '../ui/Skeleton.tsx';

/** A lane: its head, then its cards in a box of their own that scrolls under it (a soft edge where there is more).
 * While a card is dragged, `drop` says what the lane is to it: `from` its own, `lit` the one that would take it, `ok`
 * one that could, `no` one it can't go to. */
export function Lane({
  id,
  label,
  count,
  note,
  drop,
  children,
}: {
  id: string;
  label?: string;
  count: ReactNode;
  /** A quiet word beside the count ("2 agents working"). */
  note?: string | null;
  drop?: string;
  children: ReactNode;
}) {
  const [scrollRef, edges] = useScrollEdges<HTMLDivElement>('y');
  return (
    <section className="lane" data-lane={id} data-drop={drop} aria-label={label}>
      <h2 className="lane-head">
        <KeyGlyph shape={LANE_SHAPE[id] ?? 'outline'} />
        {laneLabel(id)}
        {note && (
          <span className="lane-note" data-testid="lane-note">
            {note}
          </span>
        )}
        <span className="lane-count">{count}</span>
      </h2>
      <div ref={scrollRef} className={`lane-scroll ${edges}`} data-testid="lane-scroll">
        {children}
      </div>
    </section>
  );
}

/** The board while the library (or the board's code) loads: the four lanes with their real heads, a couple of cards of
 * the cards' shape. */
export function BoardPending() {
  return (
    <div className="board" aria-hidden="true">
      {LANES.map((l) => (
        <Lane key={l.id} id={l.id} count={<SkLine w="1.2em" />}>
          <div className="lane-cards">
            {['80%', '64%'].map((w) => (
              <div key={w} className="bcard pending">
                <div className="sk bthumb" style={{ aspectRatio: 16 / 10 }} />
                <div className="bcard-row">
                  <b className="bcard-name">
                    <SkLine w={w} />
                  </b>
                </div>
                <div className="bcard-line">
                  <SkLine w="50%" />
                </div>
              </div>
            ))}
          </div>
        </Lane>
      ))}
    </div>
  );
}
