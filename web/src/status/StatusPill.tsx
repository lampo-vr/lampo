// Where a video stands, as a badge: library cards, rows and the board, the inbox, the player's stage control.
import type { StageInfo } from '../../../lib/types.ts';
import { t } from '../i18n/index.ts';
import { Badge } from '../ui/Badge.tsx';
import { stageDetail } from './stageText.ts';
import { pillLabel } from './stageUi.ts';
import '../styles/status.css';

/** "V6 new" after a final V5, "V5 approved" when an approval sits on an older version. */
export function stageNote(info: StageInfo): string | null {
  if (info.final_superseded) return t('V{v} new', { v: info.final_superseded });
  if (info.approval_stale) return t('V{v} approved', { v: info.approval_stale.v });
  return null;
}

export function StatusPill({ info, size = 'md' }: { info: StageInfo; size?: 'sm' | 'md' }) {
  return (
    <Badge stage={info.stage} size={size} note={stageNote(info)} title={stageDetail(info)} testId="status-pill">
      {pillLabel(info)}
    </Badge>
  );
}
