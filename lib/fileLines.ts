// How project files read for agents, one line each, the same in `lampo files ls` and MCP `list_files` (docs/files.md
// "Agents"): the tree in short — each area of a folder's chain, deepest first, its top-level entries — and a file with
// its id, path, size, version, who made it and, when it is inherited, the area it comes from. A fixed format: new words
// go at a line's end, nothing is reworded. Every name someone chose is one line (`oneLine`).
import { fileSize } from './fileText.ts';
import { oneLine } from './time.ts';
import type { FileInfo, FilesSummary, FileTop } from './types.ts';

/** An area as agents read it: its folder's path, or House (a project called so is `House/`, as commands name it). */
export const areaName = (area: string): string => (area ? (area === 'House' ? 'House/' : oneLine(area)) : 'House');

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
