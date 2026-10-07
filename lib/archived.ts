// Archived projects (docs/data-format.md, "folders.json"): a project put away by its owners or admins. It leaves the
// sidebar, the library's lists, the inbox and agents' lists, stays reachable (the library's Archived, ⌘K, a direct
// link), and is read-only until a person restores it: nothing new in it — no version, note, reply, draft, stage
// change, move into it or review link. Restoring is one click and loses nothing. Browser-safe: the app reads the same
// rules (no Node imports); lib/folderIds.ts reads the state from folders.json.
import { oneLine } from './time.ts';
import type { ArchivedProject } from './types.ts';

/** The project a folder path is in (its first name), or null for none (no project). */
export const projectOfFolder = (folder: string | null | undefined): string | null => (folder ? folder.split('/')[0] || null : null);

/** The archived project a folder path is in, given the archived projects; null when it isn't in one. */
export function archivedIn(folder: string | null | undefined, archived: Readonly<Record<string, ArchivedProject>> | null | undefined): string | null {
  const p = projectOfFolder(folder);
  return p && archived && Object.hasOwn(archived, p) ? p : null;
}

/**
 * The archived projects by name with `held` laid over them: projects archived (their record) or restored (null) a
 * moment ago, whose change waits behind its Undo (web/src/library/archiving.ts). A record without a prototype, so any
 * name a project can have holds, `constructor` and `__proto__` among them (lib/folderIds.ts folderRecord).
 */
export function archivedWithHeld<T extends Pick<ArchivedProject, 'at'>>(
  archived: Readonly<Record<string, T>> | null | undefined,
  held: ReadonlyMap<string, T | null> = new Map(),
): Record<string, T> {
  const out: Record<string, T> = Object.assign(Object.create(null), archived);
  for (const [p, s] of held)
    if (s) out[p] = s;
    else delete out[p];
  return out;
}

/**
 * The one sentence every refusal says, to people and agents alike (the API, `lampo`, MCP): what is archived and who can
 * change that. The name is a person's: one line, whatever it holds.
 */
export const archivedWords = (project: string): string => `the project "${oneLine(project)}" is archived: it is read-only until a person restores it`;

/**
 * A write into an archived project (lib/folderIds.ts checkNotArchived): 423 — the request itself was fine, the project
 * is locked, as a suspended workspace answers. `project` goes to the app beside the sentence (`archived` in the body).
 */
export class ProjectArchivedError extends Error {
  status = 423;
  project: string;
  constructor(project: string) {
    super(archivedWords(project));
    this.project = project;
  }
}
