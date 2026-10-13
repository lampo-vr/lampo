// How project files read for agents, one line each, the same in `lampo files ls` and MCP `list_files` (docs/files.md
// "Agents"): the tree in short — each area of a folder's chain, deepest first, its top-level entries — and a file with
// its id, path, size, version, who made it and, when it is inherited, the area it comes from. A fixed format: new words
// go at a line's end, nothing is reworded. Every name someone chose is one line (`oneLine`). And the `lampo files`
// commands handed to agents (the app's Copy for an agent, what `lampo files` and the tools say to run next): every name
// in them is one shell word that `lampo` reads as a value, never as an option. Browser-safe.
import { fileSize } from './fileText.ts';
import { oneLine } from './time.ts';
import type { FileInfo, FilesSummary, FileTop } from './types.ts';

/** How agents name the workspace's own files: `House` (exactly). A project that is called so is `House/`. */
export const HOUSE_WORD = 'House';

/** An area as agents read it: its folder's path, or House (a project called so is `House/`, as commands name it). */
export const areaName = (area: string): string => (area ? (area === HOUSE_WORD ? 'House/' : oneLine(area)) : HOUSE_WORD);

/**
 * A word for a shell, quoted when it needs to be ('Acme/Spring sale', 'Footage/**'): in single quotes, where nothing is
 * special (`$`, a backtick, and `!` in an interactive zsh or bash), a quote itself as `'\''`.
 */
export const shellWord = (w: string): string => (/^[\w./@:+-]+$/.test(w) ? w : `'${w.replaceAll("'", "'\\''")}'`);

/** An area as a command names it: `House`, a folder's path (`House/` for a project called so). */
const areaArg = (area: string): string => (area ? (area === HOUSE_WORD ? `${area}/` : area) : HOUSE_WORD);

/** The same, one shell word. */
export const areaWord = (area: string): string => shellWord(areaArg(area));

// The names in a command are other people's (a folder, a file): each is the value of its option (`--only=<word>`) or
// comes after `--`, where `lampo` takes nothing for an option (lib/cli.ts parseArgs). A name that begins with dashes
// stays a name, and the line does what it says.

/** `--only=<word>`: an option with its value in the same word. */
const attached = (option: string, value: string): string => ` --${option}=${shellWord(value)}`;

/**
 * `lampo files pull --to=public/ --only='Music/**' -- 'Acme/Spring sale'`: what applies in `area` ('' = the House) into
 * `to`, only the paths and globs in `only` (none: everything).
 */
export function pullLine(area: string, to: string, only: readonly string[] = []): string {
  return `lampo files pull${attached('to', to)}${only.map((p) => attached('only', p)).join('')} -- ${areaWord(area)}`;
}

/** `lampo files push --to='Acme/Spring sale' --path=Footage/ -- ./Shoot`: what is named here into `area`, under `into`. */
export function pushLine(area: string, sources: readonly string[], into = ''): string {
  return `lampo files push${attached('to', areaArg(area))}${into ? attached('path', into) : ''} -- ${sources.map(shellWord).join(' ')}`;
}

/** Who made a version: the agent with its person, or the person. */
export const madeBy = (f: Pick<FileInfo, 'by' | 'agent'>): string => oneLine(f.agent && f.by !== `agent:${f.agent}` ? `agent:${f.agent} (${f.by})` : f.by);

/** `Footage/  214 files  182.4 GB  footage, audio`: one top-level entry of an area. */
const topLine = (area: string, t: FileTop): string =>
  `${areaName(area)}  ${oneLine(t.path)}  ${t.dir ? `${t.files} file${t.files === 1 ? '' : 's'}  ` : ''}${fileSize(t.bytes)}  ${t.kinds.join(', ')}`;

/**
 * The tree in short, or null when no area of the chain has a file or folder: a head line (each area with its revision,
 * deepest first) and a line per top-level entry.
 */
export function summaryLines(s: FilesSummary): string[] | null {
  const areas = s.areas.filter((a) => a.tops.length);
  if (!areas.length) return null;
  const head = `files for ${areaName(s.folder)} · ${s.areas.map((a) => `${areaName(a.area)} r${a.rev}`).join(' · ')} (deepest wins)`;
  return [head, ...areas.flatMap((a) => a.tops.map((t) => topLine(a.area, t)))];
}

/**
 * One file: `fl_8c2e… Footage/Day 1/A001.mov 4.2 GB footage V2 by Mia · 2026-10-13T14:02` and, inherited from an
 * area above `folder`, `· from House`.
 */
export function fileLine(f: FileInfo, folder: string): string {
  return oneLine(
    `${f.id} ${f.path} ${fileSize(f.size)} ${f.kind} V${f.v} by ${madeBy(f)} · ${f.at.slice(0, 16)}${f.area !== folder ? ` · from ${areaName(f.area)}` : ''}`,
  );
}
