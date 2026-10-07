// Projects archived or restored a moment ago, their Undo toast still up (library/Archived.tsx sends the change once it
// is gone): the library shows them so at once, and keeps showing them so whatever its next answer says until the change
// has reached the server. Light: the sidebar and the library read it in the first paint.
import { useMemo, useSyncExternalStore } from 'react';
import { archivedWithHeld, projectOfFolder } from '../../../lib/archived.ts';
import type { ArchivedProjectInfo, LibraryResponse, VideoSummary } from '../api/types.ts';
import { loader } from '../lib/lazy.ts';

/** The Archived page, and archiving and restoring a project (Archived.tsx): asked for when one of them is. */
export const archivedCode = loader(() => import('./Archived.tsx'));

const waiting = new Map<string, ArchivedProjectInfo | null>();
const heard = new Set<() => void>();
let turn = 0;
const tell = () => {
  turn++;
  for (const f of heard) f();
};
/** Shows `project` archived (`state`) or restored (null) until `letGo`. */
export const holdArchive = (project: string, state: ArchivedProjectInfo | null): void => {
  waiting.set(project, state);
  tell();
};
export const letGo = (project: string): void => {
  if (waiting.delete(project)) tell();
};
const subscribe = (f: () => void) => {
  heard.add(f);
  return () => {
    heard.delete(f);
  };
};

/** What waits for `project`: archived (its state) or restored (null); undefined while nothing does. */
export function useHeldArchive(project: string | null): ArchivedProjectInfo | null | undefined {
  useSyncExternalStore(subscribe, () => turn);
  return project ? waiting.get(project) : undefined;
}

/** The library's archived projects (by name) and its videos (`project_archived` on theirs), as they are about to be. */
export function useArchived(data: LibraryResponse | null | undefined): { archived: Record<string, ArchivedProjectInfo>; videos: VideoSummary[] | null } {
  const now = useSyncExternalStore(subscribe, () => turn);
  return useMemo(() => {
    const videos = data?.videos ?? null;
    if (!now || !waiting.size) return { archived: archivedWithHeld(data?.archived_projects), videos };
    return {
      archived: archivedWithHeld(data?.archived_projects, waiting),
      videos:
        videos?.map((v) => {
          const p = projectOfFolder(v.folder);
          const s = p ? waiting.get(p) : undefined;
          if (s === undefined) return v;
          if (s) return v.project_archived ? v : { ...v, project_archived: s.at };
          const { project_archived: _was, ...open } = v;
          return v.project_archived ? open : v;
        }) ?? null,
    };
  }, [data, now]);
}
