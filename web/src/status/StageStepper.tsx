// The steps a video walks through (review → fixes → approved → shared → final) as keyframes on a track: settled ones
// solid in the stage's tone, the one it is at hollow and larger, the ones ahead hollow and quieter. "Shared" only where a
// review link is in it — one covers the video, or someone gave a verdict through one —, else four steps: most videos
// never go out for review. It sits on the float layer (the stage card, the History dialog): status.css `.st-steps`.
import { STAGE_STEP } from '../../../lib/stage.ts';
import type { StageInfo } from '../../../lib/types.ts';
import { stageLabel, stepLabels } from './stageText.ts';
import '../styles/status.css';
import { t } from '../i18n/index.ts';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';

const CLIENT_STEP = 3;

/** Whether a client is part of this video's way: a review link covers it, or a client already gave a verdict. */
export const clientInvolved = (info: StageInfo): boolean => !!info.share || !!info.client || info.stage === 'with_client' || info.stage === 'client_approved';

export function StageStepper({ info }: { info: StageInfo }) {
  const client = clientInvolved(info);
  const labels = client ? stepLabels() : stepLabels().filter((_, i) => i !== CLIENT_STEP);
  const full = STAGE_STEP[info.stage];
  const at = client || full < CLIENT_STEP ? full : full - 1;
  // A step the video has reached and that's settled: an approval through a link settles "Shared", final settles all.
  const settled = (i: number) => i < at || info.stage === 'final' || (info.stage === 'client_approved' && i === CLIENT_STEP);
  return (
    <ol
      className="st-steps"
      data-stage={info.stage}
      data-client={client ? '' : undefined}
      style={{ '--n': labels.length } as React.CSSProperties}
      aria-label={t('Stage: {x}', { x: stageLabel(info.stage) })}
    >
      {labels.map((label, i) => (
        <li
          key={label}
          // the track is drawn by each step towards its neighbours: lit into a step the video reached, and out of one
          // it went past
          className={[settled(i) && 'done', i === at && 'now', i <= at && 'in', i < at && 'out'].filter(Boolean).join(' ')}
          aria-current={i === at ? 'step' : undefined}
        >
          <KeyGlyph shape={settled(i) ? 'diamond' : 'outline'} />
          <span className="lbl">{label}</span>
        </li>
      ))}
    </ol>
  );
}
