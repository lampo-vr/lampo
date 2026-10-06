// What changed since each area was last audited, so the next audit reads the new code and not the same code again.
// AUDITS.md is the ledger: the areas (what each covers, its paths, the audit and commit it was last read at), the log
// of audits and the queue of changes waiting for one. This script reads it and asks git.
//   node scripts/audits.ts             one line per area: its last audit, commits and files changed since; the queue
//   node scripts/audits.ts <area>      the files of that area changed since its audit, with how many commits touched each
//   node scripts/audits.ts --unmapped  tracked files no area covers, and paths that cover nothing (the unit test fails on both)
// A path is a file, a folder ending in `/`, or a name with `*` (any characters but `/`).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Area {
  id: string;
  paths: string[];
  /** The audit that last covered the area (`A9`), its commit and date. */
  audit: string;
  commit: string;
  date: string;
}

export interface Queued {
  date: string;
  commit: string;
  areas: string[];
  what: string;
}

export interface Ledger {
  areas: Area[];
  queue: Queued[];
}

const section = (text: string, title: string): string[] => {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${title}`);
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end);
};

const ticks = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');

export function parseLedger(text: string): Ledger {
  const areas: Area[] = [];
  for (const line of section(text, 'Areas')) {
    if (!line.startsWith('|') || /^\|\s*-/.test(line)) continue;
    const cells = line.split('|').slice(1, -1);
    const [id] = ticks(cells[0] ?? '');
    if (!id || cells.length < 4) continue; // the header row has no ticked id
    const last = cells[3] ?? '';
    areas.push({
      id,
      paths: ticks(cells[2] ?? ''),
      audit: last.match(/\bA\d+\b/)?.[0] ?? '',
      commit: last.match(/`([0-9a-f]{7,40})`/)?.[1] ?? '',
      date: last.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '',
    });
  }
  const queue: Queued[] = [];
  for (const line of section(text, 'Needs audit')) {
    // a line written before its merge names its branch in brackets instead of the commit: it is queued all the same
    const m = line.match(/^- (\d{4}-\d{2}-\d{2}) · (`[^`]+`|\([^)]+\))[^·]* · ([^·]+) · (.+)$/);
    if (m) queue.push({ date: m[1] ?? '', commit: (m[2] ?? '').replace(/`/g, ''), areas: (m[3] ?? '').split(',').map((a) => a.trim()), what: m[4] ?? '' });
  }
  return { areas, queue };
}

export function covers(spec: string, file: string): boolean {
  if (spec.endsWith('/')) return file.startsWith(spec);
  if (!spec.includes('*')) return file === spec;
  const re = new RegExp(
    `^${spec
      .split('*')
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*')}$`,
  );
  return re.test(file);
}

export const inArea = (area: Area, file: string): boolean => area.paths.some((p) => covers(p, file));

/** Tracked files no area covers. */
export const unmapped = (files: string[], areas: Area[]): string[] => files.filter((f) => !areas.some((a) => inArea(a, f)));

/** Paths in the ledger that cover no tracked file (renamed or deleted since). */
export const stale = (files: string[], areas: Area[]): string[] =>
  areas.flatMap((a) => a.paths.filter((p) => !files.some((f) => covers(p, f))).map((p) => `${a.id}: ${p}`));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args: string[]): string => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });

export const trackedFiles = (): string[] => git('ls-files').split('\n').filter(Boolean);

/** Each commit since `commit` with the files it touched; null when git doesn't have that commit (a shallow clone). */
function commitsSince(commit: string): { hash: string; files: string[] }[] | null {
  try {
    git('rev-parse', '--verify', '--quiet', `${commit}^{commit}`);
  } catch {
    return null;
  }
  const out = git('log', '--format=@%h', '--name-only', `${commit}..HEAD`);
  return out
    .split('@')
    .filter(Boolean)
    .map((chunk) => {
      const [hash = '', ...files] = chunk.split('\n').filter(Boolean);
      return { hash, files };
    });
}

function main(argv: string[]): number {
  const ledger = parseLedger(fs.readFileSync(path.join(ROOT, 'AUDITS.md'), 'utf8'));
  const files = trackedFiles();
  const cache = new Map<string, ReturnType<typeof commitsSince>>();
  const since = (commit: string) => {
    if (!cache.has(commit)) cache.set(commit, commitsSince(commit));
    return cache.get(commit) ?? null;
  };

  if (argv[0] === '--unmapped') {
    const loose = unmapped(files, ledger.areas);
    const gone = stale(files, ledger.areas);
    for (const f of loose) console.log(`no area: ${f}`);
    for (const p of gone) console.log(`covers nothing: ${p}`);
    if (!loose.length && !gone.length) console.log('every tracked file has an area, every path covers a file');
    return loose.length || gone.length ? 1 : 0;
  }

  if (argv[0]) {
    const area = ledger.areas.find((a) => a.id === argv[0]);
    if (!area) {
      console.error(`no area "${argv[0]}" (areas: ${ledger.areas.map((a) => a.id).join(', ')})`);
      return 1;
    }
    const commits = since(area.commit);
    if (!commits) {
      console.error(`git doesn't have ${area.commit} (a shallow clone?): fetch the history first`);
      return 1;
    }
    const touched = new Map<string, number>();
    for (const c of commits) for (const f of c.files) if (inArea(area, f)) touched.set(f, (touched.get(f) ?? 0) + 1);
    console.log(`${area.id}: last audited by ${area.audit} at ${area.commit} (${area.date})`);
    for (const [f, n] of [...touched].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)} ${f}${files.includes(f) ? '' : '  (gone)'}`);
    if (!touched.size) console.log('  nothing changed since');
    return 0;
  }

  const width = Math.max(...ledger.areas.map((a) => a.id.length));
  for (const area of ledger.areas) {
    const commits = since(area.commit);
    const head = `${area.id.padEnd(width)}  ${area.audit} ${area.commit} ${area.date}`;
    if (!commits) {
      console.log(`${head}  (commit not in this clone)`);
      continue;
    }
    const hits = commits.filter((c) => c.files.some((f) => inArea(area, f)));
    const changed = new Set(hits.flatMap((c) => c.files.filter((f) => inArea(area, f))));
    console.log(hits.length ? `${head}  ${hits.length} commits, ${changed.size} files since` : `${head}  unchanged`);
  }
  console.log(ledger.queue.length ? `\nNeeds audit (${ledger.queue.length}):` : '\nNeeds audit: nothing queued');
  for (const q of ledger.queue) console.log(`  ${q.date} ${q.commit} [${q.areas.join(', ')}] ${q.what}`);
  const loose = unmapped(files, ledger.areas);
  if (loose.length) console.log(`\n${loose.length} tracked files have no area: node scripts/audits.ts --unmapped`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
