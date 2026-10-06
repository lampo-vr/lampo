import { t } from '../i18n/index.ts'; // Folder paths ("Acme/Reels/Q3") and the library's sidebar views, without the DOM: shared by the router (nav.ts) and
// the library model, which the unit tests run in Node.

export type LibraryView =
  | { kind: 'all' | 'inbox' | 'unsorted' | 'insights' }
  | { kind: 'folder'; id: string }
  /** A folder's playbook, beside its videos (#/playbook/<folder>). */
  | { kind: 'playbook'; id: string }
  | { kind: 'session'; id: string };

export const leaf = (folder: string | null | undefined) => (folder ? folder.split('/').at(-1) || folder : t('No project'));
/** A top-level entry of the tree is a project; anything inside one is a folder (the words the UI uses for them). */
export const isProject = (folder: string) => !folder.includes('/');
export const within = (f: string | null | undefined, root: string) => !!f && (f === root || f.startsWith(`${root}/`));
export const crumbs = (folder: string) => folder.split('/').join(' › ');
