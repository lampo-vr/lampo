// Review mode (N): walk the open notes in timeline order, one at a time. Each stop lands on the note's exact frame
// (paused, with its drawing); Play shows a moment around it. Built for going through a cut with someone watching.
import type { PlacedComment } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { IconButton, Kbd } from '../ui/primitives.tsx';
import { displayName } from './CommentCard.tsx';

interface ReviewHudProps {
  note: PlacedComment;
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onPlay: () => void;
  onExit: () => void;
}

export function ReviewHud({ note, index, total, onPrev, onNext, onPlay, onExit }: ReviewHudProps) {
  return (
    <div className="review-hud" role="toolbar" aria-label={t('Walk-through of the open notes')} data-testid="review-hud">
      <span className="rh-count mono">
        {index + 1} / {total}
      </span>
      <span className="rh-note">
        <span className="c-tc">{note.timecodeHere}</span>
        <span className="rh-text ellipsis">
          <b>{displayName(note.author)}</b> {note.text || (note.text_edit ? `“${note.text_edit.from}” → “${note.text_edit.to}”` : t('(marked frame)'))}
        </span>
      </span>
      <span className="rh-tools">
        <IconButton className="btn sm ghost icon-only" label={t('Previous note')} shortcut="⇧N" icon="back" size={15} onClick={onPrev} disabled={index === 0} />
        <IconButton className="btn sm ghost icon-only" label={t('Play around this note')} icon="play" size={13} onClick={onPlay} />
        <button type="button" className="btn sm primary" onClick={onNext}>
          {index + 1 < total ? t('Next') : t('Done')} <Kbd>N</Kbd>
        </button>
        <IconButton className="btn sm ghost icon-only" label={t('Leave the walk-through')} shortcut="Esc" icon="x" size={14} onClick={onExit} />
      </span>
    </div>
  );
}
