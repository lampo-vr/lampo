// The sample's last moment: once its fix is checked and its agent's question answered (in this visit), the player says
// so — "That's the loop": a note on an exact frame, the agent's fix in V2, the check before and after — with the way
// back to the library, where Get started ticks the sample. Loaded by the player only for the sample.
import { useEffect, useRef, useState } from 'react';
import { sampleLoop } from '../../../lib/sampleLoop.ts';
import { t } from '../i18n/index.ts';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import '../styles/loopdone.css';

export default function LoopDone({ review, me, agent }: { review: Parameters<typeof sampleLoop>[0]; me: string; agent: string | null }) {
  const now = sampleLoop(review, me);
  const closed = !!now.checked && !!now.answered;
  // only when it closes while the person is here (coming back to a finished sample says nothing again)
  const wasClosed = useRef(closed);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (closed && !wasClosed.current) setShow(true);
    wasClosed.current = closed;
  }, [closed]);
  // the card takes the focus (a screen reader reads it; Tab reaches its two buttons): no button rings itself unasked
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (show) card.current?.focus();
  }, [show]);
  if (!show) return null;
  const who = agent ?? t('Agent');
  return (
    <div className="ob-loop-done" role="dialog" aria-modal="false" aria-label={t('That’s the loop')} data-testid="ob-loop-done">
      <div className="ob-loop-card" ref={card} tabIndex={-1}>
        <span className="ob-loop-steps" aria-hidden="true">
          <span className="ob-loop-st">
            <KeyGlyph shape="diamond" className="ob-loop-must" />
            {t('Note')}
          </span>
          <span className="ob-loop-sep" />
          <span className="ob-loop-st">
            <KeyGlyph shape="diamond" className="ob-loop-ask" />
            {who}
          </span>
          <span className="ob-loop-sep" />
          <span className="ob-loop-st">
            <KeyGlyph shape="half" className="ob-loop-ok" />
            V2
          </span>
          <span className="ob-loop-sep" />
          <span className="ob-loop-st">
            <KeyGlyph shape="diamond" className="ob-loop-ok" />
            {t('Checked')}
          </span>
        </span>
        <h2>{t('That’s the loop')}</h2>
        <p>
          {agent
            ? t('A note on an exact frame. {agent}’s fix in V2. Your check, before and after. Your own videos work the same way.', { agent })
            : t('A note on an exact frame. An agent’s fix in V2. Your check, before and after. Your own videos work the same way.')}
        </p>
        <div className="ob-loop-acts">
          <a className="ob-loop-go" href="#/" data-testid="ob-loop-library">
            {t('Back to the library')}
            <I name="right" size={15} />
          </a>
          <button type="button" className="ob-loop-stay" onClick={() => setShow(false)}>
            {t('Stay here')}
          </button>
        </div>
      </div>
    </div>
  );
}
