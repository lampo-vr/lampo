// Archiving a project and restoring it (lib/archived.ts), and the library's Archived page: the projects put away, each
// a row with how much it holds and when it went, to open or restore. Its own chunk: asked for when the page opens or
// when someone archives or restores (the library's first paint has only the sidebar's row and the project's banner).
// Both changes wait behind their Undo toast (lib/toast.ts later) and are shown at once meanwhile (./archiving.ts).
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { compareTime } from '../../../lib/time.ts';
import { useCan } from '../api/auth.ts';
import { api, enc } from '../api/client.ts';
import { keys } from '../api/queries.ts';
import type { ArchivedProjectInfo, VideoSummary } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { within } from '../lib/folders.ts';
import { ago } from '../lib/format.ts';
import { later } from '../lib/toast.ts';
import { I } from '../ui/icons.tsx';
import { EmptyState } from '../ui/system.tsx';
import { holdArchive, letGo } from './archiving.ts';

/** Sends the change once its toast is gone; shown as done until the library has heard it (or as before, on Undo). */
function change(qc: QueryClient, project: string, state: ArchivedProjectInfo | null, message: string): void {
  later({
    message,
    apply: () => holdArchive(project, state),
    revert: () => letGo(project),
    commit: async () => {
      await api(state ? '/api/folders/archive' : '/api/folders/restore', { method: 'POST', body: { path: project }, keepalive: true });
      // the library, the player of a video in it (read only, or not), and the lists that leave it out: the inbox, Insights,
      // search (the server's broadcast tells other tabs the same)
      await Promise.all([keys.library, keys.reviews, keys.forYou, keys.insights, ['search']].map((queryKey) => qc.invalidateQueries({ queryKey })));
      letGo(project);
    },
  });
}

/** Archives a project, with Undo: it leaves the sidebar and the lists, and nothing in it changes until it's restored. */
export const archiveProject = (qc: QueryClient, project: string, by: string | null): void =>
  change(qc, project, { at: new Date().toISOString(), ...(by ? { by } : {}) }, t('Archived {name}', { name: project }));

/** Restores an archived project, with Undo: back in the sidebar and the lists, as it was. */
export const restoreProject = (qc: QueryClient, project: string): void => change(qc, project, null, t('Restored {name}', { name: project }));

/** "Archived 3 d ago by Ada" (just "Archived 3 d ago" without a name). */
const whenBy = (a: ArchivedProjectInfo) => (a.by ? t('Archived {when} by {name}', { when: ago(a.at), name: a.by }) : t('Archived {when}', { when: ago(a.at) }));

/** The Archived page: every archived project, the one put away last first. */
export function ArchivedView({ videos, archived }: { videos: VideoSummary[]; archived: Record<string, ArchivedProjectInfo> }) {
  const can = useCan();
  const qc = useQueryClient();
  const rows = Object.entries(archived).sort(([, a], [, b]) => compareTime(b.at, a.at));
  if (!rows.length)
    return (
      <EmptyState
        art="filed"
        titleAs="h2"
        title={t('Nothing archived')}
        action={
          <a className="btn" href="#/">
            {t('Open the library')}
          </a>
        }
      >
        {t('Archive a project from its ⋯ menu: it leaves the sidebar and the lists, and stays as it is until it’s restored.')}
      </EmptyState>
    );
  return (
    <ul className="arch-list" data-testid="archived-list">
      {rows.map(([name, a]) => {
        const n = videos.filter((v) => within(v.folder, name)).length;
        return (
          <li key={name} className="arch-row" data-testid="archived-row">
            <a className="arch-open" href={`#/folder/${enc(name)}`}>
              <I name="archive" size={16} />
              <span className="arch-name ellipsis">{name}</span>
              <span className="arch-meta ellipsis">
                {t('{n} video|{n} videos', { n })} · {whenBy(a)}
              </span>
            </a>
            {can('archive') && (
              <button type="button" className="btn sm arch-restore" onClick={() => restoreProject(qc, name)}>
                {t('Restore')}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
