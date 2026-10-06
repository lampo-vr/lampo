// A link being made or changed in the share dialog: what its form holds, shared by the dialog (ShareModal.tsx) and its
// settings (LinkSettings.tsx).
import { t } from '../i18n/index.ts';

export type Access = 'review' | 'comment' | 'watch';
export interface Draft {
  label: string;
  access: Access;
  notes: 'own' | 'all';
  versions: 'latest' | 'all';
  download: 'off' | 'preview' | 'original';
  /** yyyy-mm-dd or '' for never */
  expires: string;
  /** The password in its field: used when passwordAction is 'set' (a new link's password is added the same way). */
  password: string;
  /** 'keep': as it is (none on a new link); 'set': the field is open, its password goes with the link; 'remove'. */
  passwordAction: 'keep' | 'set' | 'remove';
}

/** What is wrong with the password in its field, if anything: it goes with the link only once it is long enough. */
export function passwordProblem(d: Draft): string | null {
  if (d.passwordAction !== 'set') return null;
  if (!d.password) return t('Type a password, or turn it off');
  return d.password.length < 4 ? t('At least 4 characters') : null;
}
