// OAuth scopes as people read them (the consent screen, Settings → API tokens' connected apps). Apart from terms.ts,
// which the first paint loads: only those two screens, both loaded on demand, need these words.
import type { Scope } from '../../../lib/scopes.ts';
import { currentLang, t } from './index.ts';

/** An OAuth scope on the consent screen and in the connected-apps list. */
export const scopeLabel = (s: Scope): string =>
  ({ 'review:read': t('Read reviews'), 'review:comment': t('Write notes'), 'review:act': t('Act on feedback'), 'post:draft': t('Draft posts') })[s];

export const scopeHint = (s: Scope): string =>
  ({
    // sentences under each scope's name, in both languages (the English read as fragments beside German sentences)
    'review:read': t('See videos, notes and marked frames, and wait for new feedback.'),
    'review:comment': t('Ask questions, leave notes on frames and reply to notes.'),
    'review:act': t('Mark notes fixed or won’t fix, add and file versions, and report what the agent is doing.'),
    'post:draft': t('Write post drafts of final videos for YouTube, Instagram and Facebook. A person publishes them.'),
  })[s];

/** A scope inside a sentence ("read reviews" / "Reviews lesen"). */
export const scopeWord = (s: Scope): string => (currentLang() === 'de' ? scopeLabel(s) : scopeLabel(s).toLowerCase());
