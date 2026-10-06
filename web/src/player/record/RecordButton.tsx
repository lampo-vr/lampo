// The Record button beside + Note: starts recorded feedback (⇧R), and while it records says so — its red dot only, the
// words in its tooltip (the panel's head is one calm row). Without speech-to-text it can't hear anything: it says why
// and takes you to where it is turned on.
import { t } from '../../i18n/index.ts';
import { Spinner } from '../../ui/feedback.tsx';
import { I } from '../../ui/icons.tsx';
import { Tip } from '../../ui/primitives.tsx';
import type { RecordFeedback } from './useRecordFeedback.ts';

export function RecordButton({ rec, speech, ready, compact }: { rec: RecordFeedback; speech: boolean; ready: boolean; compact: boolean }) {
  if (!speech)
    return (
      <Tip content={t('Recorded feedback needs speech-to-text on this server. Turn it on in Settings → Voice notes.')}>
        <button
          type="button"
          className={`btn sm ghost rec-btn${compact ? ' icon-only' : ''}`}
          aria-disabled="true"
          aria-label={t('Record feedback (needs speech-to-text)')}
          data-tip=""
          onClick={() => {
            location.hash = '#/settings/speech';
          }}
          data-testid="record"
        >
          <I name="record" size={12} className="rec-glyph off" />
          {!compact && t('Record')}
        </button>
      </Tip>
    );
  const on = rec.active || rec.phase === 'saving';
  return (
    <Tip content={on ? t('Finish the recording') : t('Record feedback')} shortcut="⇧R">
      <button
        type="button"
        className={`btn sm ghost rec-btn${compact ? ' icon-only' : ''}${on ? ' on' : ''}`}
        onClick={rec.toggle}
        disabled={!ready || rec.phase === 'starting' || rec.phase === 'saving'}
        aria-pressed={on}
        aria-label={on ? t('Finish the recording') : t('Record feedback')}
        data-tip=""
        data-testid="record"
      >
        {rec.phase === 'starting' || rec.phase === 'saving' ? <Spinner /> : <I name="record" size={12} className="rec-glyph" />}
        {!compact && (on ? t('Done') : t('Record'))}
      </button>
    </Tip>
  );
}
