// Where the Files tab is: an area (a folder's files at #/files/<folder>, the House's in Settings → Files), the folder
// inside it (`path`), its trash, and the file opened beside the list (`open`). Back and forward walk the folders.
import { useSyncExternalStore } from 'react';
import { type FilesAt, readFilesAt } from './where.ts';

export { type FilesAt, filesHref, readFilesAt } from './where.ts';

const subscribe = (f: () => void) => {
  window.addEventListener('hashchange', f);
  return () => window.removeEventListener('hashchange', f);
};
let lastHash = '';
let lastAt: FilesAt = { path: '', trash: false, open: null };
const snapshot = () => {
  if (location.hash !== lastHash) {
    lastHash = location.hash;
    lastAt = readFilesAt(lastHash);
  }
  return lastAt;
};

/** Where the address says the tab is, following it. */
export const useFilesAt = () => useSyncExternalStore(subscribe, snapshot);

/** The file opened beside the list, said in the address without a step in the history (a reload keeps it open). */
export function noteOpen(id: string | null) {
  const [base, query = ''] = location.hash.split('?');
  const q = new URLSearchParams(query);
  if (id) q.set('open', id);
  else q.delete('open');
  const qs = q.toString().replace(/\+/g, '%20');
  history.replaceState(history.state, '', `${base}${qs ? `?${qs}` : ''}`);
}
