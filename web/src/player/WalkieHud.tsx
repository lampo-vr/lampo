import { t } from '../i18n/index.ts';
import { Spinner } from '../ui/feedback.tsx';
import { SttProgress } from './SttProgress.tsx';
import type { WalkieState } from './useWalkie.ts';

export function WalkieHud({ state, level, timecodeOf }: { state: WalkieState | null; level: number; timecodeOf: (f: number) => string }) {
  if (!state) return null;
  return (
    <div className="walkie">
      {state.phase === 'rec' ? (
        <>
          <span className="rec-dot" />
          <span>{t('Talking at {timecodeOf}', { timecodeOf: timecodeOf(state.frame) })}</span>
          <span className="meter">
            {[0, 1, 2, 3, 4].map((i) => (
              <i key={i} style={{ transform: `scaleY(${Math.max(0.15, Math.min(1, level * 3 - i * 0.15))})` }} />
            ))}
          </span>
          <span className="muted">{t('release T to pin')}</span>
        </>
      ) : (
        <span className="walkie-busy">
          <span className="row">
            <Spinner /> {t('Transcribing the note for {timecodeOf}…', { timecodeOf: timecodeOf(state.frame) })}
          </span>
          <SttProgress active />
        </span>
      )}
    </div>
  );
}
