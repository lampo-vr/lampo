// Nothing waits: a calm "All caught up" — and when something was put aside for later, when it comes back, with the
// way to see it (and bring it back) under it. Someone new (the first run shows) is told what lands here once they do
// their next step, with the way to it.
import type { ReactNode } from 'react';
import type { OnboardingStep } from '../../../lib/types.ts';
import type { ForYouItem } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { useFirstRun } from '../onboarding/state.ts';
import { EmptyState } from '../ui/system.tsx';

/** The first run's next step, said for the inbox: what lands here once it is done, and the way to it. */
function firstRunHint(next: OnboardingStep | null, primary: boolean): { body: string; action?: ReactNode } | null {
  const go = (href: string, label: string) => (
    <a className={`btn ${primary ? 'primary' : 'sm'}`} href={href} data-testid="inbox-next-step">
      {label}
    </a>
  );
  switch (next) {
    case 'sample':
      return { body: t('Try the sample first: a fix to check and the agent’s question wait for you there.'), action: go('#/', t('Open the library')) };
    case 'video':
      return {
        body: t('Add your first video: what needs you about it (versions to review, fixes to check) lands here.'),
        action: go('#/?add', t('Add video')),
      };
    case 'note':
      return { body: t('Leave a note on a frame: the agent’s answers and the fixes to check land here.'), action: go('#/', t('Open the library')) };
    case 'agent':
      return { body: t('Connect an agent: its questions and the fixes it makes land here for you.'), action: go('#/settings/mcp', t('Connect an agent')) };
    case 'share':
      return { body: t('Share a review link: the notes and approvals that come through it land here.') };
    case 'invite':
      return { body: t('Invite a teammate: what they ask of you lands here.'), action: go('#/settings/users', t('Invite a teammate')) };
    case 'check':
    case 'approve':
      return { body: t('Fixes to check and versions to review land here as your team adds them.') };
    default:
      return null;
  }
}

import { type InboxActions, whenWords } from './items.tsx';
import { LaterLine } from './Later.tsx';

export function InboxZero({
  later,
  wake,
  actions,
  size = 'md',
  action,
  body,
}: {
  later: ForYouItem[];
  wake?: string;
  actions: InboxActions;
  size?: 'sm' | 'md';
  action?: ReactNode;
  /** The words when nothing is put aside either. */
  body?: string;
}) {
  const run = useFirstRun();
  const hint = run.shown && !later.length ? firstRunHint(run.next, size === 'md') : null;
  return (
    <div className={`inbox-zero ${size}`}>
      <EmptyState
        art="inbox"
        size={size}
        titleAs={size === 'md' ? 'h2' : 'p'}
        className="inbox-empty"
        testId="inbox-empty"
        title={hint ? t('Nothing waits for you yet') : t('All caught up')}
        action={hint ? (hint.action ?? action) : action}
      >
        {hint
          ? hint.body
          : later.length
            ? t(
                '{n} item is put aside for later — back {when}, or sooner if its video moves.|{n} items are put aside for later — the first is back {when}, or sooner if its video moves.',
                {
                  n: later.length,
                  when: whenWords(wake ?? later[0]?.snoozed ?? ''),
                },
              )
            : (body ?? t('New videos, questions from agents, fixes to check and feedback from review links land here.'))}
      </EmptyState>
      {later.length > 0 && <LaterLine later={later} actions={actions} />}
    </div>
  );
}
