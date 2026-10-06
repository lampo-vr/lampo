// What was put aside for later ("Later": back tomorrow at 9:00 or once its video moves), under the list and in inbox
// zero: "3 later · back tomorrow at 09:00", opened on asking, each with Bring back.
import { useState } from 'react';
import type { ForYouItem } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { I } from '../ui/icons.tsx';
import { type InboxActions, Thumb, What, whenWords } from './items.tsx';

/** "3 later": what was put aside, shown on asking, each with Bring back. */
export function LaterLine({ later, actions, open: startOpen = false }: { later: ForYouItem[]; actions: InboxActions; open?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  if (!later.length) return <span />;
  const first = later.reduce((m, i) => (i.snoozed && (!m || Date.parse(i.snoozed) < Date.parse(m)) ? i.snoozed : m), '');
  return (
    <section className={`inbox-later ${open ? 'open' : ''}`} aria-label={t('For later')} data-testid="inbox-later">
      <button type="button" className="inbox-later-toggle" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="inbox-later-toggle">
        <I name="clock" size={13} />
        {t('{n} later|{n} later', { n: later.length })}
        {first && <span className="muted">{t('back {when}', { when: whenWords(first) })}</span>}
        <I name="down" size={12} />
      </button>
      {open && (
        <div className="inbox-later-list">
          {later.map((i) => (
            <div key={i.key} className="inbox-later-row" data-testid="inbox-later-row">
              <span className="inbox-thumb">
                <Thumb item={i} />
              </span>
              <span className="inbox-later-body">
                <span className="ellipsis">
                  <b>{i.video}</b> · <What item={i} />
                </span>
                {i.snoozed && <span className="muted ellipsis">{t('Back {when}, or once its video moves', { when: whenWords(i.snoozed) })}</span>}
              </span>
              <button type="button" className="btn ghost sm" onClick={() => actions.bringBack([i])} data-testid="inbox-bring-back">
                {t('Bring back')}
              </button>
            </div>
          ))}
          {later.length > 1 && (
            <button type="button" className="btn ghost sm inbox-later-all" onClick={() => actions.bringBack(later)}>
              {t('Bring all back')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
