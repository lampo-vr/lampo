// Words for values that come from the data (severities, tags, roles): the stored value stays English, the label is in
// the UI's language. One place, so every screen says the same. The first paint loads this file, so words only a screen
// loaded on demand needs live with it: OAuth scopes in scopeTerms.ts, a role's hint in Users, a status in the printout.
import type { Role, Severity } from '../../../lib/types.ts';
import { currentLang, t } from './index.ts';

export const severityLabel = (s: Severity | string): string => ({ must: t('Must'), should: t('Should'), nice: t('Nice'), idea: t('Idea') })[s] ?? s;

/** A note's tag as people read it; the stored tag (what agents and `lampo` see) stays as it is. Unknown tags as they are. */
export const tagLabel = (tag: string): string =>
  ({
    cut: t('cut'),
    timing: t('timing'),
    freeze: t('freeze'),
    'text/typo': t('text/typo'),
    'layout/overlap': t('layout/overlap'),
    'color/grade': t('color/grade'),
    'audio/music': t('audio/music'),
    sfx: t('sfx'),
    graphic: t('graphic'),
    idea: t('idea'),
    'love-it': t('love it'),
  })[tag] ?? tag;

/** "Member", "Reviewer": a role as a title. */
export const roleLabel = (r: Role): string => ({ owner: t('Owner'), admin: t('Admin'), member: t('Member'), reviewer: t('Reviewer') })[r];

/** A role inside a sentence: "is now a member" / "ist jetzt Mitglied" (German nouns keep their capital). */
export const roleWord = (r: Role): string => (currentLang() === 'de' ? roleLabel(r) : roleLabel(r).toLowerCase());
