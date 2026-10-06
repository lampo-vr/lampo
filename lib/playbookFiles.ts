// Where playbooks live and which revisions are in force, without the store: lib/store.ts stamps every new render
// with the revisions of its folder's playbooks, and lib/folders.ts moves them with a folder. lib/playbooks.ts is the
// rest (editing, proposals, what agents read).
//   data/playbooks/house.json            the House playbook (the whole studio)
//   data/playbooks/f_<sha1 of path>.json a folder's playbook ({ scope: "ACME/REELS", … })
//   data/playbooks/<id>/…                its files (skill attachments, reference images), through the storage adapter
//   data/playbooks/archive/…             playbooks of deleted folders, kept aside
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { shownName } from './names.ts';
import { dataDir } from './paths.ts';
import type { Playbook, PlaybookScope, PlaybookStamp } from './types.ts';

/** The playbooks of the workspace this work runs for. */
export const playbookRoot = (): string => path.join(dataDir(), 'playbooks');
export const HOUSE: PlaybookScope = '';

const inside = (f: string, root: string) => f === root || f.startsWith(`${root}/`);

/** The House, then every folder from the top down to `folder` ("ACME", "ACME/REELS"). */
export function chainOf(folder: string | null | undefined): PlaybookScope[] {
  const parts = String(folder || '')
    .split('/')
    .filter(Boolean);
  return [HOUSE, ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))];
}

/** The file a scope's playbook is kept in (a hash of the path: folder names may hold anything a path can't). */
export function playbookFile(scope: PlaybookScope): string {
  if (scope === HOUSE) return path.join(playbookRoot(), 'house.json');
  return path.join(playbookRoot(), `f_${crypto.createHash('sha1').update(scope).digest('hex').slice(0, 20)}.json`);
}

/** The names a playbook holds (who wrote, suggested, decided) as they may be shown: see `shownName` (A12 VA2-5). */
function shownNames(p: Playbook): Playbook {
  const n = (x: string | null | undefined) => (typeof x === 'string' ? shownName(x) : x);
  p.by = n(p.by) ?? null;
  for (const s of p.skills || []) if (s.by) s.by = shownName(s.by);
  for (const r of p.refs || []) if (r.by) r.by = shownName(r.by);
  for (const h of p.history || []) {
    if (h.by) h.by = shownName(h.by);
    if (h.accepted_by) h.accepted_by = shownName(h.accepted_by);
  }
  for (const x of p.proposals || []) {
    if (x.by) x.by = shownName(x.by);
    if (x.decided_by) x.decided_by = shownName(x.decided_by);
  }
  return p;
}

/** The stored playbook of a scope, or null when it has none (never written, or unreadable). */
export function readPlaybook(scope: PlaybookScope): Playbook | null {
  try {
    const p = JSON.parse(fs.readFileSync(playbookFile(scope), 'utf8')) as Playbook;
    return p && typeof p === 'object' && p.scope === scope ? shownNames(p) : null;
  } catch {
    return null;
  }
}

/** Every stored playbook (House and folders). */
export function listPlaybooks(): Playbook[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(playbookRoot()).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: Playbook[] = [];
  for (const n of names) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(playbookRoot(), n), 'utf8')) as Playbook;
      if (p && typeof p.scope === 'string' && path.join(playbookRoot(), n) === playbookFile(p.scope)) out.push(shownNames(p));
    } catch {}
  }
  return out;
}

/** What a render arriving in `folder` now is made with: every playbook of the chain that has a revision. */
export function stampFor(folder: string | null | undefined): PlaybookStamp[] {
  const out: PlaybookStamp[] = [];
  for (const scope of chainOf(folder)) {
    const rev = readPlaybook(scope)?.rev || 0;
    if (rev > 0) out.push({ scope, rev });
  }
  return out;
}

function writeFileAtomic(file: string, p: Playbook): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(p, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * A folder moved or was renamed (lib/folders.ts): its playbook and those of its subfolders go with it. `map` gives the
 * new path of a folder inside the one that moved, null for one whose playbook is set aside (a deleted folder's own).
 */
export function movePlaybooks(root: string, map: (folder: string) => string | null): void {
  for (const p of listPlaybooks()) {
    if (p.scope === HOUSE || !inside(p.scope, root)) continue;
    const from = playbookFile(p.scope);
    const to = map(p.scope);
    if (to === null || to === HOUSE) {
      // Nothing is lost: kept aside, readable, out of every chain.
      fs.mkdirSync(path.join(playbookRoot(), 'archive'), { recursive: true });
      const aside = path.join(playbookRoot(), 'archive', `${path.basename(from, '.json')}-${Date.now()}.json`);
      fs.renameSync(from, aside);
      continue;
    }
    if (to === p.scope) continue;
    // A folder that already has a playbook where this one lands keeps its own; this one is set aside.
    if (readPlaybook(to)) {
      fs.mkdirSync(path.join(playbookRoot(), 'archive'), { recursive: true });
      fs.renameSync(from, path.join(playbookRoot(), 'archive', `${path.basename(from, '.json')}-${Date.now()}.json`));
      continue;
    }
    writeFileAtomic(playbookFile(to), { ...p, scope: to, proposals: p.proposals.map((x) => ({ ...x, scope: to })) });
    fs.rmSync(from, { force: true });
  }
}
