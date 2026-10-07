// The line a video's card says about the agent's work on it — the board's card line, the grid's poster chip, the
// list's row — and the 2 px edge on the poster's foot while a render or an upload says how far it is. One component in
// every layout, light enough for the library's first paint (runState.ts): the state in a word or two, the agent's own
// words (its step, why it failed) once the board has them (`say`), the percentage never cut. A card doesn't tick.
import type { CSSProperties } from 'react';
import type { ActivityWords } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { edgeOf, LOOK, pctOf, phaseOf, type RunLike, runShort } from './runState.ts';

export function RunLine({ run, say, chip = false }: { run: RunLike; say?: (w: ActivityWords) => string; chip?: boolean }) {
  const phase = phaseOf(run);
  const look = LOOK[phase];
  const n = run.now;
  // what it did in its own words: its step while it works (what it said, quoted), why it failed
  const own = !say
    ? null
    : phase === 'working' && n && n.type !== 'progress'
      ? n.type === 'thought'
        ? t('“{quote}”', { quote: say(n) })
        : say(n)
      : phase === 'failed' && run.error
        ? say(run.error)
        : null;
  const words = own ? `${runShort(run)} · ${own}` : runShort(run);
  // "V4 is ready" stands by itself; everything else is the agent's — but on a poster, where the card's agent chip under
  // it names the agent, the state alone has the room
  const name = chip || (phase === 'done' && run.result?.v) ? null : run.agent.name;
  const fig = pctOf(run);
  return (
    <span
      className={chip ? 'vchip run-line chip' : 'run-line'}
      data-testid="run-line"
      data-phase={phase}
      title={[run.agent.name, words, fig].filter(Boolean).join(' · ')}
    >
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
