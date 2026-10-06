// Settings → Playbook: the House playbook, the studio's brief, rules, skills and references that every folder
// inherits (a folder's own playbook sits beside its videos). The same page as a folder's (playbook/PlaybookPage.tsx):
// the page says its job in one line; what it inherits and gives is shown on the page itself.
import { t } from '../i18n/index.ts';
import { PlaybookPage } from '../playbook/PlaybookPage.tsx';

export function HousePlaybook() {
  return (
    <>
      <header className="set-head">
        <h1>{t('Playbook')}</h1>
        <p>{t('Tell your agents how you work, once: every version follows it.')}</p>
      </header>
      <PlaybookPage scope="" />
    </>
  );
}
