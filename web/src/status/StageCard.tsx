// The stage status's card in the player's top bar (StageControl.tsx), on the float layer like every hover card: the
// stage and its version once ("Changes requested · V4"), the steps, short facts one a line ("4 fixes to check", "1 note
// open") and the next step as quiet words. Nothing in it is pressed: it opens on hover and on keyboard focus, and the
// step it names has its own door (the top bar's button, the agent menu), so a button here would be one the keyboard
// can't reach. The History dialog says where the video stands with the same lines (StageSummary).
import type { StageInfo } from '../../../lib/types.ts';
import { StageStepper } from './StageStepper.tsx';
import { stageFacts, stageVersion } from './stageFacts.ts';
import { stageLabel } from './stageText.ts';

/** Where the video stands: the stage and its version once, the steps, one fact a line. */
export function StageSummary({ info }: { info: StageInfo }) {
  const facts = stageFacts(info);
  return (
    <>
      <p className="sc-head" data-testid="stage-head">
        <b>{stageLabel(info.stage)}</b> · {stageVersion(info)}
      </p>
      <StageStepper info={info} />
      {facts.length > 0 && (
        <ul className="sc-facts" data-testid="stage-facts">
          {facts.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
    </>
  );
}

export function StageCard({ info, next }: { info: StageInfo; next: string | null }) {
  return (
    <div className="sc" data-testid="stage-card" data-stage={info.stage}>
      <StageSummary info={info} />
      {next && (
        <p className="sc-next" data-testid="stage-card-next">
          {next}
        </p>
      )}
    </div>
  );
}
