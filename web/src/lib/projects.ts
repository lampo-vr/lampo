// The projects a person names to their agent ("Use Lampo for …", lib/mcpConfig.ts lampoFor): top-level folders still
// in use — not archived, not the first run's sample on its own — the one worked on last first. Only lazy screens use
// it (Connect an agent, the setup, Get started): never the first paint.
import { compareTime } from '../../../lib/time.ts';
import type { LibraryResponse } from '../api/types.ts';

export function projectsOf(lib: LibraryResponse | undefined | null): string[] {
  if (!lib) return [];
  const archived = lib.archived_projects ?? {};
  const top = (folder: string | null | undefined) => (folder ? (folder.split('/')[0] as string) : null);
  const last = new Map<string, string>();
  const sampleOnly = new Set<string>();
  for (const v of lib.videos) {
    const p = top(v.folder);
    if (!p) continue;
    if (v.sample) {
      if (!last.has(p)) sampleOnly.add(p);
      continue;
    }
    sampleOnly.delete(p);
    const at = v.updated ?? v.added;
    if (!last.has(p) || compareTime(at, last.get(p) as string) > 0) last.set(p, at);
  }
  return lib.folders
    .filter((f) => !f.includes('/') && !Object.hasOwn(archived, f) && !sampleOnly.has(f))
    .sort((a, b) => compareTime(last.get(b) ?? '', last.get(a) ?? '') || a.localeCompare(b));
}
