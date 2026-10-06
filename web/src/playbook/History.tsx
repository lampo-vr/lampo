// Every change to a playbook, newest first: the revision, which section, what it says (the person's message, or a
// rule added or taken out), who made it and who accepted it; a click shows the diff. Suggestions that were turned down
// sit where they were decided, with the reason the agent read. In the pane beside the document on a wide screen, in a
// dialog on a narrow one.
import { useId, useState } from 'react';
import { compareTime } from '../../../lib/time.ts';
import type { Playbook, PlaybookProposal, PlaybookRevision, PlaybookSection } from '../../../lib/types.ts';
import { t } from '../i18n/index.ts';
import { ago } from '../lib/format.ts';
import { I, type IconName } from '../ui/icons.tsx';
import { IconButton, Modal } from '../ui/primitives.tsx';
import { Button } from '../ui/system.tsx';
import { sectionWords } from './PlaybookShell.tsx';
import { Diff } from './Proposal.tsx';
import { who } from './Sections.tsx';

const ICON: Record<string, IconName> = { brief: 'notes', rules: 'list', refs: 'image' };
const iconOf = (s: PlaybookSection): IconName => ICON[s] ?? 'terminal';

type Entry = { kind: 'rev'; at: string; rev: PlaybookRevision } | { kind: 'rejected'; at: string; p: PlaybookProposal };

export function HistoryList({ playbook: p }: { playbook: Playbook }) {
  const [open, setOpen] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  const entries: Entry[] = [
    ...p.history.map((rev) => ({ kind: 'rev' as const, at: rev.at, rev })),
    ...p.proposals.filter((x) => x.status === 'rejected').map((x) => ({ kind: 'rejected' as const, at: x.decided_at || x.at, p: x })),
  ].sort((a, b) => compareTime(b.at, a.at) || (a.kind === 'rev' && b.kind === 'rev' ? b.rev.rev - a.rev.rev : 0));
  const shown = all ? entries : entries.slice(0, 20);
  if (!entries.length) return <p className="pb-none">{t('No changes yet.')}</p>;
  return (
    <div className="pb-history" data-testid="pb-history">
      <ol>
        {shown.map((e) =>
          e.kind === 'rev' ? (
            <li key={`r${e.rev.rev}`} className={open === e.rev.rev ? 'open' : ''}>
              <button type="button" className="pb-h-row" onClick={() => setOpen(open === e.rev.rev ? null : e.rev.rev)} aria-expanded={open === e.rev.rev}>
                <span className="pb-h-rev mono">r{e.rev.rev}</span>
                <span className="pb-h-main">
                  <span className="pb-h-msg">
                    <I name={iconOf(e.rev.section)} size={13} />
                    <span className="ellipsis">{e.rev.message}</span>
                  </span>
                  <span className="pb-h-who">
                    {who(e.rev.by)}
                    {e.rev.accepted_by ? ` · ${t('accepted by {name}', { name: e.rev.accepted_by })}` : ''} · {ago(e.rev.at)}
                  </span>
                </span>
              </button>
              {open === e.rev.rev && <Diff before={e.rev.before} after={e.rev.after} context={2} />}
            </li>
          ) : (
            <li key={e.p.id} className="rejected">
              <div className="pb-h-row static">
                <span className="pb-h-rev">
                  <I name="x" size={12} />
                </span>
                <span className="pb-h-main">
                  <span className="pb-h-msg">
                    <span className="ellipsis">{t('Turned down: {name} on {what}', { name: who(e.p.by), what: sectionWords(e.p.section) })}</span>
                  </span>
                  <span className="pb-h-who">
                    {e.p.reject_reason ? `“${e.p.reject_reason}” · ` : ''}
                    {e.p.decided_by} · {ago(e.at)}
                  </span>
                </span>
              </div>
            </li>
          ),
        )}
      </ol>
      {entries.length > shown.length && (
        <Button variant="link" onClick={() => setAll(true)}>
          {t('Show all {n}', { n: entries.length })}
        </Button>
      )}
    </div>
  );
}

/** The history in the pane beside the document. */
export function HistoryPane({ playbook, onClose }: { playbook: Playbook; onClose: () => void }) {
  const id = useId();
  return (
    <section className="pb-pane-in" aria-labelledby={id} data-testid="pb-history-pane">
      <header className="pb-pane-head">
        <h2 id={id} className="pb-pane-title">
          {t('History')}
        </h2>
        <IconButton className="btn ghost sm icon-only" label={t('Back to what agents read')} icon="x" size={14} onClick={onClose} />
        <p className="pb-pane-sub">{t('{n} change|{n} changes', { n: playbook.history.length })}</p>
      </header>
      <div className="pb-pane-scroll">
        <HistoryList playbook={playbook} />
      </div>
    </section>
  );
}

/** The same on a narrow screen. */
export function HistoryDialog({ playbook, onClose }: { playbook: Playbook; onClose: () => void }) {
  return (
    <Modal
      title={t('History')}
      onClose={onClose}
      width={720}
      foot={
        <button type="button" className="btn primary" onClick={onClose}>
          {t('Done')}
        </button>
      }
    >
      <HistoryList playbook={playbook} />
    </Modal>
  );
}
