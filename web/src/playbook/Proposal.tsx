// A suggestion for a playbook: who suggests what and why, the change as a diff against what the playbook says now,
// the notes behind it, and — for people who may edit — Accept, or Reject with a reason the agent reads. The playbook
// page and the inbox's preview show the same card.
import { useState } from 'react';
import { diffStat, lineDiff } from '../../../lib/playbookText.ts';
import type { PlaybookProposal } from '../../../lib/types.ts';
import { useCan } from '../api/auth.ts';
import { ApiError } from '../api/client.ts';
import { usePlaybookActions } from '../api/playbooks.ts';
import { t } from '../i18n/index.ts';
import { ago } from '../lib/format.ts';
import { toast, toastError } from '../lib/toast.ts';
import { AutoTextarea, Avatar } from '../ui/controls.tsx';
import { I } from '../ui/icons.tsx';
import { Button } from '../ui/system.tsx';
import { sectionWords } from './PlaybookShell.tsx';

const who = (by: string) => by.replace(/^agent:/, '');

/** Lines added and removed, in the order of the text; unchanged stretches fold to a count. */
export function Diff({ before, after, context = 2 }: { before: string | null; after: string | null; context?: number }) {
  const d = lineDiff(before, after);
  const keep = d.map((l, i) => l.op !== 'same' || d.slice(Math.max(0, i - context), i + context + 1).some((x) => x.op !== 'same'));
  const rows: ({ fold: number; at: number } | { line: (typeof d)[number]; at: number })[] = [];
  for (let i = 0; i < d.length; i++) {
    if (keep[i]) rows.push({ line: d[i], at: i });
    else {
      const last = rows.at(-1);
      if (last && 'fold' in last) last.fold++;
      else rows.push({ fold: 1, at: i });
    }
  }
  const { add, del } = diffStat(d);
  return (
    <figure className="pb-diff" aria-label={t('{add} lines added, {del} removed', { add, del })}>
      {rows.map((r) =>
        'fold' in r ? (
          <div key={r.at} className="pb-diff-fold">
            {t('{n} unchanged line|{n} unchanged lines', { n: r.fold })}
          </div>
        ) : (
          <div key={r.at} className={`pb-diff-line ${r.line.op}`}>
            <span className="pb-diff-op" aria-hidden="true">
              {r.line.op === 'add' ? '+' : r.line.op === 'del' ? '−' : ' '}
            </span>
            <span className="pb-diff-text">{r.line.text || ' '}</span>
          </div>
        ),
      )}
    </figure>
  );
}

export function ProposalCard({
  proposal: p,
  current,
  scope,
  compact,
  onDecided,
}: {
  proposal: PlaybookProposal;
  /** What the section says now (the diff's left side). */
  current: string;
  scope: string;
  /** Inside the inbox's preview: no outer panel. */
  compact?: boolean;
  onDecided?: (how: 'accepted' | 'rejected') => void;
}) {
  const can = useCan();
  const act = usePlaybookActions(scope);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  // Accepting was refused because someone changed that section after the suggestion was made.
  const [overtaken, setOvertaken] = useState<{ by: string; rev: number } | null>(null);
  const decide = async (how: 'accepted' | 'rejected') => {
    setBusy(true);
    try {
      if (how === 'accepted') await act.accept(p.id);
      else await act.reject(p.id, reason.trim() || undefined);
      toast(how === 'accepted' ? t('Accepted — the playbook says it now') : t('Rejected — {name} can read why', { name: who(p.by) }), 'ok');
      onDecided?.(how);
    } catch (e) {
      const d = e instanceof ApiError && e.status === 409 ? e.details : null;
      if (d && typeof d.changed_rev === 'number') setOvertaken({ by: String(d.by || ''), rev: d.changed_rev });
      else toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className={`pb-prop ${compact ? 'compact' : ''}`} data-testid="pb-proposal" data-id={p.id}>
      <header className="pb-prop-head">
        <Avatar name={p.by} size={24} />
        <div className="pb-prop-who">
          <b>{t('{name} suggests a change to {what}', { name: who(p.by), what: sectionWords(p.section) })}</b>
          <span>{ago(p.at)}</span>
        </div>
      </header>
      <p className="pb-prop-reason">{p.reason}</p>
      {!!p.evidence.length && (
        <p className="pb-prop-evidence" title={p.evidence.join(' · ')}>
          <I name="notes" size={13} />
          {t('Based on {n} note|Based on {n} notes', { n: p.evidence.length })}
        </p>
      )}
      <Diff before={current || null} after={p.content} />
      {p.status !== 'pending' ? (
        <p className={`pb-prop-status ${p.status}`}>
          {p.status === 'accepted' ? t('Accepted by {name}', { name: p.decided_by || '' }) : t('Rejected by {name}', { name: p.decided_by || '' })}
          {p.reject_reason ? ` — “${p.reject_reason}”` : ''}
        </p>
      ) : can('playbook') ? (
        rejecting ? (
          <form
            className="pb-prop-reject"
            onSubmit={(e) => {
              e.preventDefault();
              void decide('rejected');
            }}
          >
            <AutoTextarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onSubmit={() => void decide('rejected')}
              onCancel={() => setRejecting(false)}
              placeholder={t('Why not? {name} reads this', { name: who(p.by) })}
              aria-label={t('Why you reject it')}
              className="textarea"
              rows={2}
              autoFocus
            />
            <div className="pb-prop-actions">
              <Button variant="ghost" size="sm" onClick={() => setRejecting(false)}>
                {t('Cancel')}
              </Button>
              <Button type="submit" variant="danger" size="sm" disabled={busy} data-testid="pb-reject-send">
                {t('Reject')}
              </Button>
            </div>
          </form>
        ) : (
          <>
            {overtaken && (
              <p className="pb-prop-status" role="alert" data-testid="pb-overtaken">
                {t(
                  '{name} changed this in r{rev}, after the suggestion was made. Accepting it would replace that change: the diff now shows what it would replace. Reject it, or ask for a new one.',
                  { name: who(overtaken.by), rev: overtaken.rev },
                )}
              </p>
            )}
            <div className="pb-prop-actions">
              <Button variant="ghost" size="sm" icon="x" onClick={() => setRejecting(true)} disabled={busy} data-testid="pb-reject">
                {t('Reject')}
              </Button>
              {!overtaken && (
                <Button variant="primary" size="sm" icon="check" onClick={() => void decide('accepted')} disabled={busy} data-testid="pb-accept">
                  {t('Accept')}
                </Button>
              )}
            </div>
          </>
        )
      ) : (
        <p className="pb-prop-status muted">{t('Waiting for someone who edits playbooks')}</p>
      )}
    </article>
  );
}
