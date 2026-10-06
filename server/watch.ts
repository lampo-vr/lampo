// Re-renders and outside writes. Only the folders of added videos are watched (no scanning); a periodic stat
// catches anything fs.watch missed. Changes the CLI or other sessions make in data/ are pushed to the UI.
import fs from 'node:fs';
import path from 'node:path';
import { words } from '../lib/activityText.ts';
import { localOwner } from '../lib/auth.ts';
import { unlessBusy } from '../lib/jobs.ts';
import { DATA, isoLocal, slugify } from '../lib/paths.ts';
import * as store from '../lib/store.ts';
import type { ActivityStore } from './activity.ts';
import type { Background } from './background.ts';
import type { Broadcast } from './events.ts';

export interface Watchers {
  /** Re-read which folders hold videos under review and watch exactly those. */
  refresh(): void;
  stop(): void;
}

export function startWatching(broadcast: Broadcast, background: Background, activity?: ActivityStore): Watchers {
  const pendingSync = new Map<string, NodeJS.Timeout>();
  const scheduleSync = (slug: string, delay = 1500) => {
    clearTimeout(pendingSync.get(slug));
    pendingSync.set(
      slug,
      setTimeout(() => doSync(slug), delay),
    );
  };
  function doSync(slug: string): void {
    pendingSync.delete(slug);
    try {
      const r = store.sync(slug);
      if (!r) return;
      if (r.pending) {
        scheduleSync(slug, 2000);
        // A render still being written: its agent is rendering (the size says how far; no agent tokens involved).
        const who = r.review.session?.name;
        if (who && activity) {
          let mb = 0;
          try {
            mb = Math.round(fs.statSync(r.review.video).size / 1e6);
          } catch {}
          activity.record({
            at: isoLocal(),
            agent: who,
            slug,
            kind: 'render',
            ...(mb ? words('Rendering… {mb} MB, still growing', { mb }) : words('Rendering a new version')),
          });
        }
      } else if (r.changed) {
        broadcast('review', { slug });
        broadcast('library', { slug });
        if (r.version) {
          const v = r.version.v;
          console.log(`${isoLocal()} v${v} of ${r.review.video}`);
          background.warm(r.review);
          // tracked renders are the machine owner's: their text is expected in the owner's languages
          unlessBusy(() => background.startQa(r.review, v, localOwner()?.prefs?.voice_languages));
        }
      }
    } catch (e) {
      console.error('sync', slug, (e as Error).message);
    }
  }

  const dirWatchers = new Map<string, fs.FSWatcher>();
  function refresh(): void {
    const wanted = new Set(
      store
        .listReviews()
        .filter((r) => !r.archived && !store.isUpload(r))
        .map((r) => path.dirname(r.video)),
    );
    for (const [d, w] of dirWatchers)
      if (!wanted.has(d)) {
        w.close();
        dirWatchers.delete(d);
      }
    for (const d of wanted) {
      if (dirWatchers.has(d)) continue;
      try {
        const w = fs.watch(d, (_ev, name) => {
          if (!name) return;
          const slug = slugify(path.join(d, name.toString()));
          if (fs.existsSync(path.join(DATA, slug, 'review.json'))) scheduleSync(slug);
        });
        w.on('error', () => {});
        dirWatchers.set(d, w);
      } catch {}
    }
  }

  // Only files on disk can change behind our back; uploads get new versions through the upload route.
  const periodic = setInterval(() => {
    for (const slug of store.listSlugs()) if (!pendingSync.has(slug) && !store.isUploadSlug(slug)) doSync(slug);
  }, 20000);

  const dataDebounce = new Map<string, NodeJS.Timeout>();
  let dataWatcher: fs.FSWatcher | null = null;
  try {
    dataWatcher = fs.watch(DATA, { recursive: true }, (_ev, name) => {
      if (!name) return;
      const f = name.toString();
      // Workspace #1's own files only: data/w/ holds the other workspaces, which no stream of #1 may hear of.
      if (f.startsWith(`w${path.sep}`) || f === 'w') return;
      const key = f === 'events.jsonl' ? 'events' : f === 'folders.json' ? 'folders' : f.endsWith('review.json') ? f.split('/')[0] : null;
      if (!key) return;
      clearTimeout(dataDebounce.get(key));
      dataDebounce.set(
        key,
        setTimeout(() => {
          dataDebounce.delete(key);
          if (key === 'events') return broadcast('events');
          if (key === 'folders') return broadcast('library');
          broadcast('review', { slug: key });
          broadcast('library', { slug: key });
          refresh();
        }, 120),
      );
    });
  } catch (e) {
    console.error('cannot watch data/', (e as Error).message);
  }

  return {
    refresh,
    stop() {
      clearInterval(periodic);
      dataWatcher?.close();
      for (const w of dirWatchers.values()) w.close();
      for (const t of [...pendingSync.values(), ...dataDebounce.values()]) clearTimeout(t);
    },
  };
}
