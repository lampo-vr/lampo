// A playbook suggestion beside the inbox list: which playbook, the change as a diff against what it says now, and
// Accept / Reject right here; "Open the playbook" goes to its page (the suggestions tab).
import { useProposal } from '../api/playbooks.ts';
import { t } from '../i18n/index.ts';
import { loader, useLoaded } from '../lib/lazy.ts';
import { I } from '../ui/icons.tsx';
import { IconButton } from '../ui/primitives.tsx';
import { SkeletonRegion, SkeletonText } from '../ui/Skeleton.tsx';
import { EmptyState } from '../ui/system.tsx';
import { openHref } from './items.tsx';
import type { PreviewProps } from './Preview.tsx';
import '../styles/playbook.css';

// The card and its diff are the playbook page's: loaded when a suggestion is first previewed.
const proposalCode = loader(() => import('../playbook/Proposal.tsx'));

export function PlaybookPreview({ item, onDone, onBack, backLabel }: PreviewProps) {
  const q = useProposal(item.proposal ?? null);
  const code = useLoaded(proposalCode);
  const scope = item.scope ?? '';
  const name = scope || t('House');
  return (
    <section className="inbox-preview" aria-label={t('{video}: preview', { video: name })} data-testid="inbox-playbook-preview">
      <header className="inbox-pv-head">
        {onBack && <IconButton className="btn ghost icon-only" label={backLabel ?? t('Back to the inbox')} icon="back" size={17} onClick={onBack} />}
        <div className="inbox-pv-title grow">
          <b className="ellipsis">{t('{name} playbook', { name })}</b>
          <span className="inbox-pv-sub">
            <span className="ellipsis">{t('A suggestion from {name}', { name: (item.by || '').replace(/^agent:/, '') })}</span>
          </span>
        </div>
        <a className="btn sm inbox-open" href={openHref(item)} data-testid="inbox-open-playbook">
          <I name="playbook" size={14} /> {t('Open the playbook')}
        </a>
      </header>
      <div className="inbox-pv-playbook">
        {q.data && code ? (
          <code.ProposalCard proposal={q.data} current={q.data.current} scope={scope} compact onDecided={() => onDone(item.key)} />
        ) : q.error ? (
          <EmptyState art="error" size="sm" className="inbox-empty" title={t('This didn’t load')}>
            {q.error.message}
          </EmptyState>
        ) : (
          <SkeletonRegion label={t('Loading the suggestion')}>
            <SkeletonText lines={5} />
          </SkeletonRegion>
        )}
      </div>
    </section>
  );
}
