// The line a video's card says about the agent's work on it — the board's card line, the grid's poster chip, the
// list's row — and the 2 px edge on the poster's foot while a render or an upload says how far it is. One component in
// every layout, light enough for the library's first paint (runState.ts): the state in a word or two, the percentage
// never cut. Only the board's line has room for the agent's own words after it (its step, what it said, why it failed;
// once the board has them, `say`), cut with an ellipsis; a poster's chip and a list's row say the state alone. The
// title says it all, whole. A card doesn't tick.
import type { CSSProperties } from 'react';
import type { ActivityWords } from '../api/types.ts';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { edgeOf, fullWords, LOOK, ownWords, pctOf, phaseOf, type RunLike, stateWords } from './runState.ts';

export function RunLine({ run, say, chip = false }: { run: RunLike; say?: (w: ActivityWords) => string; chip?: boolean }) {
  const phase = phaseOf(run);
  const look = LOOK[phase];
  const state = stateWords(run);
  // a poster's chip is a tight place: the state alone, never the agent's sentence (the title has it)
  const own = chip || !say ? null : ownWords(run, say);
  const words = own ? `${state} · ${own}` : state;
  // "V4 is ready" stands by itself; everything else is the agent's — but on a poster, where the card's agent chip under
  // it names the agent, the state alone has the room
  const name = chip || (phase === 'done' && run.result?.v) ? null : run.agent.name;
  const fig = pctOf(run);
  return (
    <span className={chip ? 'vchip run-line chip' : 'run-line'} data-testid="run-line" data-phase={phase} title={`${run.agent.name} · ${fullWords(run, say)}`}>
      <KeyGlyph shape={look.shape} className={`nav-kg run-kg ${look.tone}`} />
      <span className="run-words">
        {name && <b>{name}</b>}
        {name ? ' · ' : ''}
        {words}
      </span>
      {fig && <span className="run-fig">{fig}</span>}
    </span>
  );
}

/** The poster's foot while a render or an upload says how far it is: inside the poster, so nothing moves. */
export function RunEdge({ run }: { run: RunLike | null }) {
  const edge = run ? edgeOf(run) : null;
  if (edge === null) return null;
  return <span className="run-edge" data-testid="run-edge" style={{ '--edge': edge } as CSSProperties} aria-hidden="true" />;
}
