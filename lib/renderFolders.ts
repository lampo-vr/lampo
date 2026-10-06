// Where this machine's renders probably land, for the local setup's "Where do your renders land?": a few likely places
// looked into a little — ~/Movies, ~/Desktop, ~/Downloads and the folder "Add video" browses from (its projects, and
// their out/renders/exports folders) —, never the whole disk. Bounded: two levels at most, a budget of entries read in
// all, no dot folders or node_modules, symlinks never followed, nothing inside the app or its store. The machine's
// owner only (server/routes/onboarding.ts): a path on this disk is nobody else's business.
import fs from 'node:fs';
import path from 'node:path';
import type { OnboardingFolders } from './types.ts';

/** What counts as a video here (the add dialog's: POST /api/library takes the same). */
export const RENDER_EXT = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'];
/** The folders inside a project where exports land, looked into one level deeper. */
const RENDER_DIRS = new Set(['out', 'renders', 'render', 'exports', 'export', 'output']);
/** Folders in a home that hold no renders but many files (reading them would spend the budget for nothing). */
const NOT_RENDERS = new Set(['Library', 'Applications', 'Music', 'Pictures', 'Public', 'System', 'Volumes', 'Photos Library.photoslibrary']);
const MAX_FOLDERS = 6;
const MAX_FILES = 8;

export interface FindOptions {
  home: string;
  /** Where "Add video" browses from (config browse_root, else home). */
  root: string;
  /** Folders whose insides are never looked at (the app's own, the store's). */
  skip?: string[];
  /** Entries read in all, across every folder (default 2000). */
  budget?: number;
}

type Folder = OnboardingFolders['folders'][number];

export function findRenderFolders({ home, root, skip = [], budget = 2000 }: FindOptions): OnboardingFolders {
  let left = budget;
  const seen = new Set<string>();
  const found: (Folder & { newest: number })[] = [];
  const skipped = (dir: string) => skip.some((s) => dir === s || dir.startsWith(`${s}${path.sep}`));

  /** Reads one folder (never through a symlink): its videos, and its subfolders for the walk. */
  function read(dir: string): string[] {
    if (left <= 0 || seen.has(dir) || skipped(dir)) return [];
    seen.add(dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const subs: string[] = [];
    const files: Folder['files'] = [];
    let newest = 0;
    for (const e of entries) {
      if (left-- <= 0) break;
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!NOT_RENDERS.has(e.name) && !e.name.endsWith('.app')) subs.push(full);
      } else if (e.isFile() && RENDER_EXT.includes(path.extname(e.name).toLowerCase())) {
        let st: fs.Stats | null = null;
        try {
          st = fs.statSync(full);
        } catch {}
        const t = st?.mtimeMs ?? 0;
        newest = Math.max(newest, t);
        files.push({ name: e.name, path: full, size: st?.size ?? null, mtime: st ? st.mtime.toISOString() : null });
      }
    }
    if (files.length) {
      const time = (f: Folder['files'][number]) => (f.mtime ? Date.parse(f.mtime) : 0);
      files.sort((a, b) => time(b) - time(a));
      found.push({ path: dir, count: files.length, files: files.slice(0, MAX_FILES), newest });
    }
    return subs;
  }

  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  };
  const bases = [path.join(home, 'Movies'), path.join(home, 'Desktop'), path.join(home, 'Downloads'), root].map(real).filter((p): p is string => !!p);
  for (const base of [...new Set(bases)]) {
    // the base and its folders; inside those, only where exports land (a project's out/, renders/ …)
    for (const sub of read(base)) for (const deeper of read(sub)) if (RENDER_DIRS.has(path.basename(deeper).toLowerCase())) read(deeper);
  }
  found.sort((a, b) => b.newest - a.newest);
  return { folders: found.slice(0, MAX_FOLDERS).map(({ newest: _, ...f }) => f) };
}
