// How a stage talks: the words on a pill. Which stage a video is in comes from lib/stage.ts;
// colours live in styles/status.css (keyed by data-stage), so every place shows the same thing.

import type { StageInfo } from '../../../lib/types.ts';
import { t } from '../i18n/index.ts';
import { stageLabel } from './stageText.ts';

/** The pill's words, with the version where it matters: "Approved V6", "Approved V6 via link", "Final V5". */
export function pillLabel(s: StageInfo): string {
  switch (s.stage) {
    case 'team_approved':
      return t('Approved V{v}', { v: s.team?.v ?? s.v });
    case 'client_approved':
      return t('Approved V{v} via link', { v: s.client?.v ?? s.v });
    case 'final':
      return t('Final V{v}', { v: s.final?.v ?? s.v });
    case 'check_fixes':
      return t('Check {n} fix|Check {n} fixes', { n: s.to_verify });
    default:
      return stageLabel(s.stage);
  }
}
