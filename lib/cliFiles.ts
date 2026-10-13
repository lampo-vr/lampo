// `lampo files` (docs/files.md "Agents"): the team's project files on any machine. `ls` shows what applies in a
// project or folder (or the House), `pull` fetches what an agent needs into a folder of its own, `push` saves files and
// folders from this disk into them as versions, `status` says what changed since a pull. The line the app's Copy for an
// agent hands out (web/src/files/model.ts pullCommand) runs as it is. Lines are a fixed format agents read: new words go
// at their end. With --json, stdout is one JSON document.
import path from 'node:path';
import { cacheRoot } from './backend/credentials.ts';
import type { Backend } from './backend/types.ts';
import { areaName, fileLine, summaryLines } from './fileLines.ts';
import { hashCache, type LeftOut } from './filesLocal.ts';
import { areaOf, areaWord, type PullResult, type PushResult, pull, push, RoomError, type StatusResult, shellWord, status } from './filesSync.ts';
import { fileSize } from './fileText.ts';
import { keepLines, oneLine } from './time.ts';

type OptValue = string | true | string[];
type Opts = Record<string, OptValue | undefined>;

interface Io {
  out: (s: string) => void;
  fail: (msg: string) => never;
  by: string;
}

const str = (v: OptValue | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
const list = (v: OptValue | undefined): string[] => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []);

export const FILES_USAGE = `lampo files ls [<area>] [<path>]   what applies there (inherited too), or one folder's files
lampo files pull <area> [<glob>…] [--only <glob>]… --to <dir> [--dry-run] [--force]
lampo files push <file|folder>… --to <area> [--path <folder>] [--copy | --replace] [--dry-run]
lampo files status [--to <dir>]   what changed here and there since a pull
(<area>: a project's or folder's path, or House for the workspace's own; docs/files.md)`;

/** `1 file`, `2 files`. */
const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** How long something took, as people say it. */
const took = (ms: number): string => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);

/** A person at a terminal sees how far it is (on stderr, one line redrawn); an agent reads only the result. */
function progressLine(what: string) {
  if (!process.stderr.isTTY) return { tell: () => {}, done: () => {} };
  let last = 0;
  return {
    tell(n: number, total: number) {
      const now = Date.now();
      if (now - last < 200 && n < total) return;
      last = now;
      const pct = total ? Math.floor((n / total) * 100) : 100;
      process.stderr.write(`\r${what} ${pct} % (${fileSize(n)} of ${fileSize(total)})\x1b[K`);
    },
    done: () => process.stderr.write('\r\x1b[K'),
  };
}

/** A stop (Ctrl-C) that ends a pull or push between pieces; it can be run again to go on. */
function stopOnSignal(): { signal: AbortSignal; release: () => void } {
  const ac = new AbortController();
  const stop = () => ac.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return {
    signal: ac.signal,
    release: () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    },
  };
}

/** Some names, the first few, then how many more. */
const some = (names: string[], n = 3): string =>
  names
    .slice(0, n)
    .map((x) => oneLine(x))
    .join(', ') + (names.length > n ? ` +${names.length - n}` : '');

/** What a push left where it is, in one line, or null. */
export function leftLine(l: LeftOut): string | null {
  const parts = [
    l.hidden.length && `${l.hidden.length} hidden (${some(l.hidden)}: name one to send it)`,
    l.links.length && `${l.links.length} link${l.links.length === 1 ? '' : 's'} (${some(l.links)}: never followed)`,
    l.junk.length && `${l.junk.length} junk (${some(l.junk)})`,
    l.special.length && `${l.special.length} not a file (${some(l.special)})`,
    l.big.length && `${l.big.length} too big (${some(l.big)})`,
    l.clash.length && `${l.clash.length} differing only in case from another (${some(l.clash.map((c) => c.path))})`,
    l.bad.length &&
      `${l.bad.length} with a name Lampo can't keep (${some(
        l.bad.map((b) => `${b.path}: ${b.why}`),
        2,
      )})`,
  ].filter(Boolean);
  return parts.length ? `left out: ${parts.join(' · ')}` : null;
}

export async function filesCommand({ pos, opt }: { pos: string[]; opt: Opts }, b: Backend, io: Io): Promise<void> {
  const [sub, ...rest] = pos;
  const hashes = () => hashCache(path.join(cacheRoot(), 'hashes.json'));
  if (sub === 'ls') return ls(b, rest, opt, io);
  if (sub === 'pull') return pullCmd(b, rest, opt, io, hashes());
  if (sub === 'push') return pushCmd(b, rest, opt, io, hashes());
  if (sub === 'status') return statusCmd(b, opt, io, hashes());
  io.fail(`${sub ? `unknown files command "${oneLine(sub)}"` : 'say what to do'}:\n${FILES_USAGE}`);
}

async function ls(b: Backend, [where, inside]: string[], opt: Opts, io: Io): Promise<void> {
  const area = areaOf(where);
  const p = str(opt.path) ?? inside;
  if (p !== undefined || opt.q || opt.kind) {
    const page = await b.listFiles(area, {
      deep: true,
      ...(p ? { path: p.replace(/\/+$/, '') } : {}),
      ...(str(opt.q) ? { q: str(opt.q) } : {}),
      ...(str(opt.kind) ? { kind: str(opt.kind) as never } : {}),
      ...(str(opt.cursor) ? { cursor: str(opt.cursor) } : {}),
    });
    if (opt.json) return io.out(JSON.stringify(page, null, 2));
    io.out(`${areaName(area)} ${p ? `${oneLine(p.replace(/\/+$/, ''))}/ ` : ''}· ${page.total} file${page.total === 1 ? '' : 's'}`);
    for (const f of page.files) io.out(fileLine(f, area));
    if (page.cursor) io.out(`more: lampo files ls ${areaWord(area)}${p ? ` ${shellWord(p)}` : ''} --cursor ${page.cursor}`);
    return;
  }
  const s = await b.filesSummary(area);
  if (opt.json) return io.out(JSON.stringify(s, null, 2));
  const lines = summaryLines(s);
  if (!lines) return io.out(`no files for ${areaName(area)} yet. Add some: lampo files push <folder> --to ${areaWord(area)}`);
  for (const l of lines) io.out(l);
  io.out(`pull: lampo files pull ${areaWord(area)} --to <dir> --only '<glob>' · one folder's files: lampo files ls ${areaWord(area)} <path>`);
}

function pullLines(r: PullResult, ms: number, dry: boolean): string[] {
  const to = oneLine(r.to);
  const from = areaName(r.area);
  const lines = dry
    ? [
        `would pull ${r.fetched.length} of ${r.files} files from ${from} into ${to} · ${fileSize(r.needed)} to fetch · ${r.here} already here${r.free !== null ? ` · ${fileSize(r.free)} free there` : ''}`,
        ...r.fetched.slice(0, 50).map((f) => `fetch  ${oneLine(f.path)} V${f.v} ${fileSize(f.size)}`),
        ...(r.fetched.length > 50 ? [`fetch  … ${r.fetched.length - 50} more (--json lists all)`] : []),
      ]
    : [
        `${r.stopped ? 'stopped: ' : ''}pulled ${r.fetched.length} of ${r.files} files from ${from} into ${to} · ${fileSize(r.fetched.reduce((n, f) => n + f.size, 0))} · ${r.here} already here · ${took(ms)}${r.stopped ? ' · run it again to go on' : ''}`,
      ];
  for (const x of r.refused.slice(0, 20)) lines.push(`left out: ${oneLine(x.path)} — ${oneLine(x.why)}`);
  if (r.refused.length > 20) lines.push(`left out: … ${r.refused.length - 20} more (--json lists all)`);
  if (r.hidden.length) lines.push(`left out: ${r.hidden.length} hidden (${some(r.hidden)}): name one exactly to pull it (--only <its path>)`);
  for (const x of r.failed.slice(0, 20)) lines.push(`failed: ${oneLine(x.path)} — ${oneLine(x.why)}`);
  if (r.failed.length > 20) lines.push(`failed: … ${r.failed.length - 20} more (run it again: it goes on where it stopped)`);
  for (const u of r.unmatched) lines.push(`no file matches ${oneLine(u)}`);
  return lines;
}

async function pullCmd(b: Backend, [where, ...patterns]: string[], opt: Opts, io: Io, hashes: ReturnType<typeof hashCache>): Promise<void> {
  if (where === undefined) io.fail(`say which files: ${FILES_USAGE.split('\n')[1]}`);
  const to = str(opt.to) ?? io.fail('say where they go: --to <dir> (e.g. --to public/)');
  const area = areaOf(where);
  const all = [...patterns, ...list(opt.only)];
  const dry = !!opt.dry_run;
  const shown = progressLine('pulling');
  const stop = stopOnSignal();
  const t0 = Date.now();
  let r: PullResult;
  try {
    r = await pull(b, { area, patterns: all, to, force: !!opt.force, dryRun: dry, hashes, onProgress: shown.tell, signal: stop.signal });
  } catch (e) {
    if (!(e instanceof RoomError)) throw e;
    const x = e.result;
    if (opt.json) io.out(JSON.stringify({ ...x, refused_for_room: true }, null, 2));
    return io.fail(
      `needs ${fileSize(x.needed)}, ${fileSize(x.free ?? 0)} free in ${oneLine(to)}: pull only what this needs (--only '<glob>'; lampo files ls ${areaWord(area)} shows what is there), or make room. Nothing was fetched.`,
    );
  } finally {
    shown.done();
    stop.release();
  }
  if (opt.json) io.out(JSON.stringify(r, null, 2));
  else for (const l of pullLines(r, Date.now() - t0, dry)) io.out(l);
  if (!r.files && !r.unmatched.length && !opt.json) io.out(`nothing to pull: ${areaName(r.area)} has no files${all.length ? ' that match' : ''}`);
  if (r.refused.length || r.failed.length || r.unmatched.length || r.stopped) process.exitCode = 1;
}

function pushLines(r: PushResult, ms: number, dry: boolean, area: string): string[] {
  const to = areaWord(area);
  const n = (s: string) => r.planned.filter((p) => p.state === s).length;
  const lines: string[] = [];
  if (r.conflicts.length) {
    lines.push(`refused: ${r.conflicts.length} file${r.conflicts.length === 1 ? ' is' : 's are'} in the way, nothing was sent`);
    for (const c of r.conflicts.slice(0, 20))
      lines.push(
        oneLine(
          `conflict  ${c.path} V${c.v} by ${c.agent ? `agent:${c.agent} (${c.by})` : c.by} · ${c.at.slice(0, 16)}${c.base ? ` (yours is based on V${c.base})` : ' (yours is a new file)'}`,
        ),
      );
    lines.push('then: --replace makes yours its next version (theirs stays one of its versions), or --copy keeps both');
  } else if (dry) {
    lines.push(
      `would push ${n('new') + n('version') + n('copy')} of ${count(r.planned.length, 'file')} to ${to}: ${n('new')} new, ${count(n('version'), 'new version')}, ${count(n('copy'), 'copy', 'copies')} · ${n('same')} already there, ${n('unchanged')} unchanged since pulled`,
    );
    for (const p of r.planned.filter((x) => x.state === 'new' || x.state === 'version' || x.state === 'copy').slice(0, 50))
      lines.push(oneLine(`${p.state.padEnd(8)} ${p.path} ${fileSize(p.size)}${p.state === 'version' ? ` V${p.base} → V${(p.base ?? 0) + 1}` : ''}`));
  } else {
    const d = (s: string) => r.done.filter((x) => x.state === s).length;
    const moved = r.done.filter((x) => x.state !== 'same');
    const same = n('same') + n('unchanged') + d('same');
    lines.push(
      !moved.length && !r.stopped
        ? `nothing to push to ${to}: ${count(same, 'file')} unchanged`
        : `${r.stopped ? 'stopped: ' : ''}pushed ${count(moved.length, 'file')} to ${to}${r.rev !== null ? ` (r${r.rev})` : ''}: ${d('added')} added, ${count(d('version'), 'new version')}${d('copy') ? `, ${count(d('copy'), 'copy', 'copies')}` : ''} · ${fileSize(r.sent)} sent in ${took(ms)} · ${same} unchanged${r.stopped ? ' · run it again to go on' : ''}`,
    );
    for (const x of moved.slice(0, 50))
      lines.push(oneLine(`${(x.state === 'added' ? 'added' : x.state).padEnd(8)} ${x.path} V${x.v}${x.asked ? ` (${x.asked} changed: kept beside it)` : ''}`));
    if (moved.length > 50) lines.push(`… ${moved.length - 50} more (--json lists all)`);
  }
  const left = leftLine(r.left);
  if (left) lines.push(left);
  return lines;
}

async function pushCmd(b: Backend, sources: string[], opt: Opts, io: Io, hashes: ReturnType<typeof hashCache>): Promise<void> {
  if (!sources.length) io.fail(`say what to push: ${FILES_USAGE.split('\n')[2]}`);
  const target = str(opt.to) ?? io.fail('say where it goes: --to <project|folder|House>');
  if (opt.copy && opt.replace) io.fail('either --copy (keep both) or --replace (a new version), not both');
  const area = areaOf(target);
  const dry = !!opt.dry_run;
  const hashing = progressLine('hashing');
  const sending = progressLine('pushing');
  const stop = stopOnSignal();
  const t0 = Date.now();
  let r: PushResult;
  try {
    r = await push(b, {
      area,
      sources,
      into: str(opt.path) ?? '',
      copy: !!opt.copy,
      replace: !!opt.replace,
      dryRun: dry,
      by: io.by,
      hashes,
      onHashing: hashing.tell,
      onProgress: (n, total) => {
        hashing.done();
        sending.tell(n, total);
      },
      signal: stop.signal,
    });
  } finally {
    hashing.done();
    sending.done();
    stop.release();
  }
  if (opt.json) io.out(JSON.stringify(r, null, 2));
  else for (const l of pushLines(r, Date.now() - t0, dry, area)) io.out(l);
  if (!r.planned.length && !opt.json) io.out('nothing to push: no file here that Lampo can keep');
  if (r.conflicts.length || r.stopped) process.exitCode = 1;
}

function statusLines(r: StatusResult): string[] {
  const counts = new Map<string, number>();
  for (const l of r.lines) counts.set(l.state, (counts.get(l.state) ?? 0) + 1);
  const from = r.areas.map((a) => areaWord(a)).join(', ');
  const lines = [`${oneLine(r.to)} · pulled from ${from} · ${[...counts].map(([s, n]) => `${n} ${s}`).join(' · ')}`];
  for (const l of r.lines) {
    if (l.state === 'unchanged') continue;
    const now = l.now ? ` V${l.v} → V${l.now.v} by ${l.now.agent ? `agent:${l.now.agent} (${l.now.by})` : l.now.by}` : '';
    lines.push(oneLine(`${l.state.padEnd(13)} ${l.path}${now}`));
  }
  const here = r.lines.some((l) => l.state === 'changed here' || l.state === 'new here');
  const there = r.lines.some((l) => l.state === 'changed there' || l.state === 'missing here');
  const both = r.lines.some((l) => l.state === 'both changed');
  if (here) lines.push(`push: lampo files push ${shellWord(r.to.endsWith('/') ? r.to : `${r.to}/`)} --to ${areaWord(r.areas[0] ?? '')}`);
  if (there) lines.push(`pull: lampo files pull ${areaWord(r.areas[0] ?? '')} --to ${shellWord(r.to)}`);
  if (both) lines.push('both changed: push --copy keeps both, or pull --force takes theirs');
  return lines;
}

async function statusCmd(b: Backend, opt: Opts, io: Io, hashes: ReturnType<typeof hashCache>): Promise<void> {
  const to = str(opt.to) ?? '.';
  const r = await status(b, { to, hashes });
  if (!r) return io.fail(`nothing was pulled into ${oneLine(to)} yet: lampo files pull <project> --to ${oneLine(to)}`);
  if (opt.json) return io.out(JSON.stringify(r, null, 2));
  for (const l of statusLines(r)) io.out(keepLines(l));
}
