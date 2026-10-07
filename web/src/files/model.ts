// The Files tab's thinking, without the DOM (test/unit/files-model.test.ts): what a file is called by its kind, sizes
// as people read them, who made a version (a person, or an agent with its mark), the order of a list, the check before
// an upload (what is new, what replaces what, what is left out, whether it fits), and the commands that hand files to an
// agent. Words go through t().
import { agentKindOf, agentShown } from '../../../lib/agentKind.ts';
import { caseKey, dirOf, FILE_LIMITS, filePathProblem, nameOf } from '../../../lib/fileText.ts';
import type { AgentKind, FileInfo, FileKind, FileVersionInfo, TrashedFileInfo } from '../../../lib/types.ts';
import { locale, t } from '../i18n/index.ts';

/** A file as the API answers it (its last change's agent, and that agent's kind, included). */
export type FileRow = FileInfo;
export type TrashRow = TrashedFileInfo;
export type VersionRow = FileVersionInfo;

// ---------------------------------------------------------------- words

/** The kinds a list can be narrowed to, in the order the chips show them. */
export const KINDS: readonly FileKind[] = ['footage', 'audio', 'image', 'graphic', 'font', 'project', 'document', 'archive', 'other'];

/** A kind as a chip says it (plural: what it narrows the list to). */
export function kindWords(k: FileKind): string {
  switch (k) {
    case 'footage':
      return t('Footage');
    case 'audio':
      return t('Audio');
    case 'image':
      return t('Images');
    case 'graphic':
      return t('Graphics');
    case 'font':
      return t('Fonts');
    case 'project':
      return t('Project files');
    case 'document':
      return t('Documents');
    case 'archive':
      return t('Archives');
    default:
      return t('Other');
  }
}

/** What a file is, in a word or two, from its extension ("After Effects project", "WAV audio"), else from its kind. */
export function typeLabel(path: string, kind: FileKind): string {
  const ext = extOf(path);
  switch (ext) {
    case 'aep':
    case 'aepx':
      return t('After Effects project');
    case 'aet':
      return t('After Effects template');
    case 'mogrt':
      return t('Motion graphics template');
    case 'prproj':
      return t('Premiere Pro project');
    case 'drp':
      return t('DaVinci Resolve project');
    case 'fcpxml':
    case 'fcpbundle':
      return t('Final Cut Pro project');
    case 'c4d':
      return t('Cinema 4D scene');
    case 'blend':
      return t('Blender scene');
    case 'psd':
    case 'psb':
      return t('Photoshop document');
    case 'ai':
      return t('Illustrator file');
    case 'indd':
      return t('InDesign document');
    case 'fig':
      return t('Figma file');
    case 'riv':
      return t('Rive file');
    case 'nk':
      return t('Nuke script');
    case 'als':
      return t('Ableton Live set');
    case 'logicx':
      return t('Logic Pro project');
    case 'ptx':
      return t('Pro Tools session');
    case 'mov':
      return t('QuickTime movie');
    case 'mp4':
    case 'm4v':
      return t('MP4 video');
    case 'mxf':
      return t('MXF video');
    case 'braw':
      return t('Blackmagic RAW');
    case 'r3d':
      return t('RED RAW');
    case 'ari':
      return t('ARRIRAW');
    case 'wav':
    case 'bwf':
      return t('WAV audio');
    case 'aif':
    case 'aiff':
      return t('AIFF audio');
    case 'mp3':
      return t('MP3 audio');
    case 'm4a':
    case 'aac':
      return t('AAC audio');
    case 'otf':
      return t('OpenType font');
    case 'ttf':
      return t('TrueType font');
    case 'woff':
    case 'woff2':
      return t('Web font');
    case 'cube':
    case '3dl':
    case 'look':
      return t('LUT');
    case 'svg':
      return t('SVG graphic');
    case 'lottie':
      return t('Lottie animation');
    case 'pdf':
      return t('PDF');
    case 'srt':
    case 'vtt':
      return t('Subtitles');
    case 'exr':
      return t('OpenEXR image');
    case 'png':
      return t('PNG image');
    case 'jpg':
    case 'jpeg':
      return t('JPEG image');
    case 'tif':
    case 'tiff':
      return t('TIFF image');
    case 'webp':
      return t('WebP image');
    case 'heic':
      return t('HEIC image');
    case 'txt':
      return t('Text');
    case 'md':
      return t('Markdown');
    case 'docx':
    case 'doc':
      return t('Word document');
    case 'xlsx':
    case 'xls':
      return t('Excel sheet');
    case 'key':
      return t('Keynote');
    case 'pptx':
      return t('PowerPoint');
    case 'dpx':
      return t('DPX frame');
    case 'zip':
      return t('ZIP archive');
    default:
      return ext ? `${ext.toUpperCase()} · ${kindWord(kind)}` : kindWord(kind);
  }
}

/** One file of a kind ("Footage", "a font"): the singular beside an unknown extension. */
function kindWord(k: FileKind): string {
  switch (k) {
    case 'footage':
      return t('footage');
    case 'audio':
      return t('audio');
    case 'image':
      return t('image');
    case 'graphic':
      return t('graphic');
    case 'font':
      return t('font');
    case 'project':
      return t('project file');
    case 'document':
      return t('document');
    case 'archive':
      return t('archive');
    default:
      return t('file');
  }
}

export const extOf = (path: string): string => {
  const name = nameOf(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

/** Byte counts as people read them, decimal like a Mac's Finder: "0 B", "12 KB", "48 MB", "4.2 GB", "1.31 TB". */
export function size(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const f = (x: number, digits: number) => x.toLocaleString(locale(), { maximumFractionDigits: digits });
  if (n < 1e3) return `${Math.round(n)} B`;
  if (n < 1e6) return `${f(n / 1e3, 0)} KB`;
  if (n < 1e9) return `${f(n / 1e6, n < 1e7 ? 1 : 0)} MB`;
  if (n < 1e12) return `${f(n / 1e9, n < 1e11 ? 1 : 0)} GB`;
  return `${f(n / 1e12, 2)} TB`;
}

/** "Mia", or an agent: its cleaned name and the kind its mark is drawn for. */
export interface Who {
  name: string;
  agent: AgentKind | null;
}

/** Who made a version: the agent when an agent did (with its person's account), else the person. */
export function whoOf(x: { by: string; agent?: string; agent_kind?: AgentKind; via?: string }): Who {
  // (an agent that didn't say its kind: the CLI's glyph for `lampo`, else what its name says)
  // (the data's `via` stays 'vr'; a client's own id reads as its kind's name: agentShown)
  if (x.agent) {
    const kind = x.agent_kind ?? (x.via === 'vr' ? 'cli' : agentKindOf(x.agent));
    return { name: agentShown(x.agent, kind), agent: kind };
  }
  return { name: x.by, agent: null };
}

/** When a file may take its next version again: "at 14:20" today, "tomorrow at 09:05" after midnight. */
export function againAt(at: number, now = Date.now()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date(now).toDateString() ? t('at {time}', { time }) : t('tomorrow at {time}', { time });
}

// ---------------------------------------------------------------- the list

export type SortBy = 'name' | 'size' | 'changed';

const collator = () => new Intl.Collator(locale(), { numeric: true, sensitivity: 'base' });

/** Files in the list's order: by name (numbers as numbers: A001C2 before A001C10), size (largest first) or the newest. */
export function sortFiles<T extends { path: string; size: number; at: string }>(files: T[], by: SortBy): T[] {
  const c = collator();
  const byName = (a: T, b: T) => c.compare(nameOf(a.path), nameOf(b.path));
  return [...files].sort((a, b) => (by === 'size' ? b.size - a.size : by === 'changed' ? Date.parse(b.at) - Date.parse(a.at) : 0) || byName(a, b));
}

export function sortDirs<T extends { path: string; bytes: number }>(dirs: T[], by: SortBy): T[] {
  const c = collator();
  return [...dirs].sort((a, b) => (by === 'size' ? b.bytes - a.bytes : 0) || c.compare(nameOf(a.path), nameOf(b.path)));
}

/** The names of a path as a breadcrumb: [["Footage", "Footage"], ["Day 1", "Footage/Day 1"]]. */
export const crumbsOf = (path: string): [string, string][] =>
  path ? path.split('/').map((name, i, all) => [name, all.slice(0, i + 1).join('/')] as [string, string]) : [];

/** The rows from `from` to `to` in the list's order, both included (⇧-click). */
export function between(ids: string[], from: string, to: string): string[] {
  const a = ids.indexOf(from);
  const b = ids.indexOf(to);
  if (a < 0 || b < 0) return [to];
  return ids.slice(Math.min(a, b), Math.max(a, b) + 1);
}

// ---------------------------------------------------------------- what agents get

/** A word for a shell, quoted when it needs to be ("Acme/Spring sale", "Footage/**"). */
export function shellWord(s: string): string {
  if (/^[\w./@:+-]+$/.test(s)) return s;
  return `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** The area's name for `lampo files`: the folder's path, or "House" for the House's. */
const areaArg = (area: string) => (area ? shellWord(area) : 'House');

/**
 * What an agent needs to fetch these, nothing more: one `lampo files pull` (files by their path, folders as a glob of
 * everything in them), and the MCP form under it.
 */
export function pullCommand(area: string, files: string[], dirs: string[] = []): string {
  const only = [...dirs.map((d) => `${d}/**`), ...files].map((p) => ` --only ${shellWord(p)}`).join('');
  return `lampo files pull ${areaArg(area)} --to public/${only}`;
}

export function mcpCall(area: string, path: string): string {
  const folder = JSON.stringify(area || '');
  return path ? `list_files({folder: ${folder}, path: ${JSON.stringify(path)}})` : `list_files({folder: ${folder}})`;
}

/** The same upload from a terminal: `--path` is where in the area it goes. */
export function pushCommand(area: string, dir: string, source: string): string {
  return `lampo files push ${shellWord(source)} --to ${areaArg(area)}${dir ? ` --path ${shellWord(`${dir}/`)}` : ''}`;
}

// ---------------------------------------------------------------- the check before an upload

/** One dropped file as it would go in. */
export interface Planned<F = File> {
  file: F;
  /** Its path in the area. */
  path: string;
  size: number;
  /** The version it replaces (the file at that path now); null: a new file. */
  base: number | null;
  /** The file it replaces, when it does. */
  replaces: { id: string; v: number; sha256: string; size: number } | null;
}

export interface DropPlan<F = File> {
  /** What goes in (new files and new versions). */
  add: Planned<F>[];
  /** Left out: junk (said by name), names a path can't have (with why), names that differ only in case from one there. */
  junk: string[];
  bad: { path: string; why: string }[];
  clash: { path: string; with: string }[];
  /** The top folders the drop holds ("Footage/Day 1", "Footage/Day 2"), or its files' names for loose files. */
  tops: string[];
  bytes: number;
}

/** What is in the area now, by path: each file's id, version, bytes. */
export type Existing = Map<string, { id: string; v: number; sha256: string; size: number; path: string }>;

/**
 * The check before any byte moves: `picked` (paths relative to what was dropped) go under `dir` of the area; a path
 * that is there becomes the next version of that file (based on the version there now), one that differs from a file
 * there only in case can't be kept beside it (macOS and Windows would make them one), one a path can't be is said why.
 */
export function planDrop<F extends { size: number }>(picked: { file: F; rel: string }[], dir: string, existing: Existing, junk: string[] = []): DropPlan<F> {
  const byCase = new Map<string, string>();
  for (const p of existing.keys()) byCase.set(caseKey(p), p);
  const add: Planned<F>[] = [];
  const bad: DropPlan['bad'] = [];
  const clash: DropPlan['clash'] = [];
  const seen = new Map<string, string>();
  const tops = new Set<string>();
  for (const { file, rel: raw } of picked) {
    // as the server keeps it (a Mac names files in NFD): its answers name the same paths
    const rel = raw.normalize('NFC');
    const path = dir ? `${dir}/${rel}` : rel;
    const why = filePathProblem(path);
    if (why) {
      bad.push({ path: rel, why });
      continue;
    }
    if (file.size > FILE_LIMITS.fileBytes) {
      bad.push({ path: rel, why: t('larger than {size}, the most one file can be', { size: size(FILE_LIMITS.fileBytes) }) });
      continue;
    }
    const k = caseKey(path);
    const there = existing.get(path) ?? null;
    const other = byCase.get(k);
    if ((!there && other && other !== path) || seen.has(k)) {
      // the one it meets: another of this drop (its path from the drop), or a file there (its path in the area, less `dir`)
      clash.push({ path: rel, with: seen.get(k) ?? (other ?? '').slice(dir ? dir.length + 1 : 0) });
      continue;
    }
    seen.set(k, rel);
    const names = rel.split('/');
    tops.add(names.length > 2 ? names.slice(0, 2).join('/') : names.length === 2 ? (names[0] as string) : rel);
    add.push({
      file,
      path,
      size: file.size,
      base: there ? there.v : null,
      replaces: there ? { id: there.id, v: there.v, sha256: there.sha256, size: there.size } : null,
    });
  }
  return { add, junk, bad, clash, tops: [...tops], bytes: add.reduce((s, x) => s + x.size, 0) };
}

/**
 * What the plan comes to once hashes are known: files whose bytes are that file's already (nothing to do), files the
 * workspace holds elsewhere (committed without sending: counted once per workspace), the bytes still to send, and what
 * the replaced versions held (they are kept up to 30 days, not counted, so a new version counts only by what it adds).
 */
export function settlePlan<F>(plan: DropPlan<F>, hashOf: (f: F) => string | null | undefined, stored: ReadonlySet<string>) {
  let same = 0;
  let known = 0;
  let send = 0;
  let freed = 0;
  for (const x of plan.add) {
    const h = hashOf(x.file);
    if (h && x.replaces?.sha256 === h) {
      same++;
      continue;
    }
    freed += x.replaces?.size ?? 0;
    if (h && stored.has(h)) known++;
    else send += x.size;
  }
  return { same, known, send, freed, isSame: (x: Planned<F>) => !!x.replaces && x.replaces.sha256 === hashOf(x.file) };
}

/** Room on the plan after an upload that adds `send` bytes and frees `freed` (null: no plan says). */
export const roomAfter = (limit: number | null | undefined, used: number, send: number, freed: number): number | null =>
  limit == null ? null : limit - used - send + freed;

/** Where a file being uploaded is shown in the tray: under its first two folders ("Footage/Day 1"), or its own folder. */
export function trayGroup(rel: string): string {
  const names = rel.split('/');
  return names.length > 2 ? names.slice(0, 2).join('/') : names.length === 2 ? (names[0] as string) : '';
}

/** A path's folder part for display: "Footage / Day 1". */
export const spaced = (path: string) => path.split('/').join(' / ');

export { dirOf, nameOf };
