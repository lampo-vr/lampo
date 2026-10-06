// A plan's refusal (a 402 from server/extension.ts: the workspace's plan has no room for this, or it is read-only): the
// billing provider's own sentence in the page's language when it gave one, else ours for its reason. Only a server with
// a billing provider ever answers 402.
import { currentLang, t } from '../i18n/index.ts';

/** The sentence to show for a 402's body (`error`, and `reason` / `messages` beside it). */
export function refusalText(error: string, details: Record<string, unknown>): string {
  const said = (details.messages as Record<string, unknown> | undefined)?.[currentLang()];
  if (typeof said === 'string' && said) return said;
  if (currentLang() === 'en' && error) return error;
  switch (details.reason) {
    case 'storage':
      return t('This workspace’s plan has no storage left for this. Make room or choose a bigger plan.');
    case 'members':
      return t('This workspace’s plan has no room for another member.');
    case 'videos':
      return t('This workspace’s plan has no room for another video under review. Mark one final or archive one.');
    case 'payment':
      return t('The last payment failed, so this workspace is read-only until it is paid.');
    default:
      return t('This workspace is read-only for now: nothing new until it fits its plan again. Nothing is deleted.');
  }
}
