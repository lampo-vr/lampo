// "Archived · Restore": an archived project's page and its videos' player say so where their main action stands (Share on
// the project's page, the next step in the player), so nothing moves when it shows. Calm: no colour, one line, Restore
// only for whoever may (its owners and admins). Light: the library's first paint and the player both draw it.
import { t } from '../i18n/index.ts';
import { I } from '../ui/icons.tsx';
import { Tip } from '../ui/primitives.tsx';

export function ArchivedBanner({ onRestore }: { onRestore?: () => void }) {
  return (
    <div className="arch-banner" role="status" data-testid="archived-banner">
      <Tip content={t('Read only: nothing in it changes until it’s restored.')} side="bottom">
        <span className="arch-banner-word">
          <I name="archive" size={14} />
          {t('Archived')}
          <span className="sr-only">: {t('Read only: nothing in it changes until it’s restored.')}</span>
        </span>
      </Tip>
      {onRestore && (
        <>
          <span className="arch-banner-dot" aria-hidden="true">
            ·
          </span>
          <button type="button" className="arch-banner-act" onClick={onRestore} data-testid="archived-restore">
            {t('Restore')}
          </button>
        </>
      )}
    </div>
  );
}
