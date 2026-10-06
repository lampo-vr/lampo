// A suggestion for a playbook: who suggests what and why, the change as a diff against what the playbook says now,
// the notes behind it, and — for people who may edit — Accept, or Reject with a reason the agent reads. When the
// section changed after it was made (a person's edit, or another suggestion accepted for it), it says so before anyone
// clicks: the diff then shows what accepting it would replace, and *Accept anyway* replaces it on purpose. The
// playbook page and the inbox's preview show the same card, from the same playbook.
import { useEffect, useState } from 'react';
import { changedSince, diffStat, lineDiff, skillMarkdown, waitingFor } from '../../../lib/playbookText.ts';
import type { Playbook, PlaybookProposal, PlaybookSection } from '../../../lib/types.ts';
import { useCan } from '../api/auth.ts';
import { ApiError } from '../api/client.ts';
import { usePlaybookActions } from '../api/playbooks.ts';
import { t } from '../i18n/index.ts';
import { ago } from '../lib/format.ts';
import { toast, toastError } from '../lib/toast.ts';
import { AutoTextarea, Avatar } from '../ui/controls.tsx';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { Button } from '../ui/system.tsx';
import { sectionWords } from './PlaybookShell.tsx';

const who = (by: string) => by.replace(/^agent:/, '');

/**
 * What a section says now (a skill: its SKILL.md), the left side of a suggestion's diff. A SKILL.md ends with a line
 * break and a suggestion's text never does (cleanText): without it, every diff of a skill ends with a blank line out.
 */
export function currentText(p: Playbook, section: PlaybookSection): string {
  if (section === 'brief' || section === 'rules') return p[section];
  const s = p.skills.find((x) => `skill:${x.name}` === section);
  return s ? skillMarkdown(s).trimEnd() : '';
}

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
  playbook,
  scope,
  compact,
  onDecided,
}: {
  proposal: PlaybookProposal;
  /** The playbook it is for, as it stands: what the section says now, what changed since, the other suggestions. */
  playbook: Playbook;
  scope: string;
  /** Inside the inbox's preview: no outer panel, and it says itself when others wait for the same section. */
  compact?: boolean;
  onDecided?: (how: 'accepted' | 'rejected') => void;
}) {
  const can = useCan();
  const act = usePlaybookActions(scope);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  // Refused because the section changed after the playbook on this screen: who and when, until it is read again.
  const [refused, setRefused] = useState<{ by: string; rev: number; accepted: boolean } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a newer playbook says itself what changed
  useEffect(() => setRefused(null), [playbook.rev]);
  const pending = p.status === 'pending';
  const changed = pending ? changedSince(playbook, p) : null;
  const notice = changed ? { by: who(changed.accepted_by || changed.by), rev: changed.rev, accepted: !!changed.proposal } : refused;
  const same = pending ? waitingFor(playbook.proposals, p.section) : [];
  const newest = same.length > 1 && same[0]?.id === p.id;
  const what = sectionWords(p.section);
  const decide = async (how: 'accepted' | 'rejected') => {
    setBusy(true);
    try {
      // the revision whose text the diff on screen was made against: a change after it is refused, never replaced
      if (how === 'accepted') await act.accept(p.id, { base_rev: playbook.rev });
      else await act.reject(p.id, reason.trim() || undefined);
      toast(how === 'accepted' ? t('Accepted — the playbook says it now') : t('Rejected — {name} can read why', { name: who(p.by) }), 'ok');
      onDecided?.(how);
    } catch (e) {
      const d = e instanceof ApiError && e.status === 409 ? e.details : null;
      if (d && typeof d.changed_rev === 'number') setRefused({ by: who(String(d.by || '')), rev: d.changed_rev, accepted: !!d.proposal });
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
          <b>{t('{name} suggests a change to {what}', { name: who(p.by), what })}</b>
          <span>{ago(p.at)}</span>
        </div>
        {newest && (
          <span className="pb-prop-tag" data-testid="pb-newest">
            {t('Newest of {n}', { n: same.length })}
          </span>
        )}
      </header>
      <p className="pb-prop-reason">{p.reason}</p>
      {!!p.evidence.length && (
        <p className="pb-prop-evidence" title={p.evidence.join(' · ')}>
          <I name="notes" size={13} />
          {t('Based on {n} note|Based on {n} notes', { n: p.evidence.length })}
        </p>
      )}
      {compact && same.length > 1 && (
        <p className="pb-prop-note" data-testid="pb-same-section">
          <KeyGlyph shape="ease" size={10} className="pb-prop-note-key" />
          <span>
            {newest
              ? t('{n} suggestions for {what} are waiting, this one the newest. Whichever you accept, the others then show what they would replace.', {
                  n: same.length,
                  what,
                })
              : t('{n} suggestions for {what} are waiting, a newer one among them. Whichever you accept, the others then show what they would replace.', {
                  n: same.length,
                  what,
                })}
          </span>
        </p>
      )}
      {pending && notice && (
        <p className="pb-prop-note changed" role="status" data-testid="pb-overtaken">
          <KeyGlyph shape="half" size={10} className="pb-prop-note-key" />
          <span>
            {notice.accepted
              ? t('{name} accepted another suggestion for {what} in r{rev}. The diff shows what accepting this one would replace.', {
                  name: notice.by,
                  what,
                  rev: notice.rev,
                })
              : t('{name} changed {what} in r{rev}, after this suggestion was made. The diff shows what accepting it would replace.', {
                  name: notice.by,
                  what,
                  rev: notice.rev,
                })}
          </span>
        </p>
      )}
      <Diff before={currentText(playbook, p.section) || null} after={p.content} />
      {!pending ? (
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
          <div className="pb-prop-actions">
            <Button variant="ghost" size="sm" icon="x" onClick={() => setRejecting(true)} disabled={busy} data-testid="pb-reject">
              {t('Reject')}
            </Button>
            {notice ? (
              // what it would replace is on screen now: replacing it is a choice, never the default (once the playbook
              // was read again — until then the diff is the old one)
              <Button size="sm" icon="check" onClick={() => void decide('accepted')} disabled={busy || !changed} data-testid="pb-accept-anyway">
                {t('Accept anyway')}
              </Button>
            ) : (
              <Button variant="primary" size="sm" icon="check" onClick={() => void decide('accepted')} disabled={busy} data-testid="pb-accept">
                {t('Accept')}
              </Button>
            )}
          </div>
        )
      ) : (
        <p className="pb-prop-status muted">{t('Waiting for someone who edits playbooks')}</p>
      )}
    </article>
  );
}
