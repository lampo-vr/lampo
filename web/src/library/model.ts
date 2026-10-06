// What the library shows, as plain functions (no React, no DOM): which videos a view covers, the filters, the order,
// and the sections they fall into. Library.tsx renders the result in one of four layouts; the unit tests pin the rules.
import { LANES, STAGES } from '../../../lib/stage.ts';
import { compareTime, instant } from '../../../lib/time.ts';
import type { Stage } from '../../../lib/types.ts';
import type { VideoSummary } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { isProject, type LibraryView, leaf, within } from '../lib/folders.ts';
import { fold } from '../lib/text.ts';
import { laneLabel, summaryLine as stageSummary } from '../status/stageText.ts';

// One collator each: localeCompare with options builds a new one per call, which at 1,000 videos was most of a sort.
const folderOrder = new Intl.Collator(undefined, { sensitivity: 'base' });
const nameOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export type Layout = 'grid' | 'compact' | 'list' | 'board';
export type GroupBy = 'folder' | 'stage' | 'none';
export type SortBy = 'recent' | 'name' | 'stage' | 'open';
export type LaneId = (typeof LANES)[number]['id'];
export type LaneFilter = 'all' | LaneId;

export const LAYOUTS: Layout[] = ['grid', 'compact', 'list', 'board'];

/** Where the library keeps its layout, filters and order (per browser: lib/prefs.ts). */
export const LIBRARY_PREFS = 'vr.library';
/** The filters are per tab: a new tab or a new day starts with everything in view. */
export const LIBRARY_PER_TAB = ['q', 'lane', 'session', 'rules'] as const;

export interface Filters {
  /** Words that must all appear in the name, folder or session (case- and accent-insensitive). */
  q: string;
  /** A session name, '-' for videos without one, '' for all. */
  session: string;
  lane: LaneFilter;
  archived: boolean;
  /** Filter chips ("Stage is In progress"): every rule must hold; within a rule any of its values. */
  rules?: FilterRule[];
  /** For "Updated": now, in ms (tests pass a fixed one). */
  now?: number;
}

// ---------------------------------------------------------------- filter chips, the way Linear builds them

export type FilterField = 'stage' | 'agent' | 'folder' | 'musts' | 'questions' | 'client' | 'updated';
export interface FilterRule {
  field: FilterField;
  values: string[];
}
export const FILTER_FIELDS: FilterField[] = ['stage', 'agent', 'folder', 'client', 'musts', 'questions', 'updated'];
/** Fields that are a yes/no: choosing one applies it, no value to pick. */
export const FLAG_FIELDS: FilterField[] = ['musts', 'questions'];
/** Fields where one value at a time makes sense (a time window). */
export const SINGLE_FIELDS: FilterField[] = ['updated'];
export const CLIENT_STATES = ['none', 'shared', 'opened', 'changes', 'approved'] as const;
export type ClientState = (typeof CLIENT_STATES)[number];
export const UPDATED_WINDOWS = ['today', '7d', '30d'] as const;
const WINDOW_MS: Record<string, number> = { '7d': 7 * 864e5, '30d': 30 * 864e5 };

/** Where a video stands with the client: not shared, shared, opened, or the client's verdict. */
export function clientState(v: VideoSummary): ClientState {
  const s = v.stage;
  if (s.client?.status === 'approved') return 'approved';
  if (s.client?.status === 'changes') return 'changes';
  if (s.share?.opened) return 'opened';
  if (s.share || s.linked) return 'shared';
  return 'none';
}

const project = (v: VideoSummary) => v.folder?.split('/')[0] ?? '-';

function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

function matches(v: VideoSummary, r: FilterRule, now: number): boolean {
  if (!r.values.length && !FLAG_FIELDS.includes(r.field)) return true;
  switch (r.field) {
    case 'stage':
      return r.values.includes(v.stage.stage);
    case 'agent':
      return r.values.some((a) => (a === '-' ? !v.session : v.session?.name === a));
    case 'folder':
      return r.values.includes(project(v));
    case 'client':
      return r.values.includes(clientState(v));
    case 'musts':
      return v.counts.must > 0;
    case 'questions':
      return (v.counts.questions || 0) > 0;
    case 'updated': {
      const at = Date.parse(activity(v) ?? '');
      if (Number.isNaN(at)) return false;
      return r.values.some((w) => (w === 'today' ? sameDay(at, now) : now - at <= (WINDOW_MS[w] ?? 0)));
    }
  }
}

export const matchesRules = (v: VideoSummary, rules: FilterRule[] = [], now = Date.now()) => rules.every((r) => matches(v, r, now));

/** The values a field can take in these videos, with how many videos each would leave (the other rules applied). */
export function fieldOptions(videos: VideoSummary[], field: FilterField, rules: FilterRule[] = [], now = Date.now()): { value: string; count: number }[] {
  const others = rules.filter((r) => r.field !== field);
  const pool = videos.filter((v) => matchesRules(v, others, now));
  const count = (value: string) => pool.filter((v) => matches(v, { field, values: [value] }, now)).length;
  const values: string[] =
    field === 'stage'
      ? [...STAGES]
      : field === 'agent'
        ? [...new Set(videos.map((v) => v.session?.name).filter((x): x is string => !!x))].sort().concat('-')
        : field === 'folder'
          ? [...new Set(videos.map(project))].sort((a, b) => (a === '-' ? 1 : b === '-' ? -1 : folderOrder.compare(a, b)))
          : field === 'client'
            ? [...CLIENT_STATES]
            : field === 'updated'
              ? [...UPDATED_WINDOWS]
              : ['yes'];
  return values.map((value) => ({ value, count: count(value) }));
}

/** Rules as one string for the per-tab prefs; anything unreadable is dropped. */
export const encodeRules = (rules: FilterRule[]): string => (rules.length ? JSON.stringify(rules.map((r) => [r.field, r.values])) : '');
export function decodeRules(s: unknown): FilterRule[] {
  if (typeof s !== 'string' || !s) return [];
  try {
    const raw: unknown = JSON.parse(s);
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (x): x is [FilterField, string[]] =>
          Array.isArray(x) && FILTER_FIELDS.includes(x[0]) && Array.isArray(x[1]) && x[1].every((v) => typeof v === 'string'),
      )
      .map(([field, values]) => ({ field, values }));
  } catch {
    return [];
  }
}

/** Adds or removes one value of a field; a flag field toggles as a whole; a single-value field replaces its value. */
export function toggleRule(rules: FilterRule[], field: FilterField, value?: string): FilterRule[] {
  const i = rules.findIndex((r) => r.field === field);
  if (FLAG_FIELDS.includes(field)) return i >= 0 ? rules.filter((_, j) => j !== i) : [...rules, { field, values: [] }];
  if (value === undefined) return rules;
  if (i < 0) return [...rules, { field, values: [value] }];
  const cur = rules[i] as FilterRule;
  const values = SINGLE_FIELDS.includes(field)
    ? cur.values.includes(value)
      ? []
      : [value]
    : cur.values.includes(value)
      ? cur.values.filter((x) => x !== value)
      : [...cur.values, value];
  return values.length ? rules.map((r, j) => (j === i ? { field, values } : r)) : rules.filter((_, j) => j !== i);
}

export interface Section {
  key: string;
  /** Heading; none for a single ungrouped list. */
  title?: string;
  /** The folder the heading opens (and files dropped videos into). */
  folder?: string;
  videos: VideoSummary[];
}

export const laneOf = (s: Stage): LaneId => (LANES.find((l) => (l.stages as readonly Stage[]).includes(s)) ?? LANES[0]).id;

/** Newest activity on a video: a note, a new render, or when it was added. */
export const activity = (v: VideoSummary): string | null =>
  [v.lastComment, v.mtime, v.added]
    .filter((x): x is string => !!x)
    .sort((a, b) => compareTime(a, b))
    .at(-1) ?? null;

/** The videos a sidebar view is about, before any filter. Folder views include their subfolders. */
export function scope(videos: VideoSummary[], view: LibraryView): VideoSummary[] {
  switch (view.kind) {
    case 'unsorted':
      return videos.filter((v) => !v.folder);
    case 'session':
      return videos.filter((v) => v.session?.name === view.id);
    case 'folder':
    case 'playbook':
      return videos.filter((v) => within(v.folder, view.id));
    default:
      return videos;
  }
}

export function applyFilters(videos: VideoSummary[], f: Filters): VideoSummary[] {
  const words = fold(f.q).split(/\s+/).filter(Boolean);
  const now = f.now ?? Date.now();
  return videos.filter((v) => {
    if (!f.archived && v.archived) return false;
    if (f.session && (f.session === '-' ? !!v.session : v.session?.name !== f.session)) return false;
    if (f.lane !== 'all' && laneOf(v.stage.stage) !== f.lane) return false;
    if (f.rules?.length && !matchesRules(v, f.rules, now)) return false;
    if (!words.length) return true;
    const hay = fold([v.name, v.folder, v.session?.name].filter(Boolean).join(' '));
    return words.every((w) => hay.includes(w));
  });
}

const stageRank = (s: Stage) => STAGES.indexOf(s);

export function sortVideos(videos: VideoSummary[], by: SortBy): VideoSummary[] {
  // Newest activity first. Each video's time is read once, not in each of the n·log n comparisons of a sort.
  const at = new Map(videos.map((v) => [v, Math.max(instant(v.lastComment), instant(v.mtime), instant(v.added))]));
  const recent = (a: VideoSummary, b: VideoSummary) => {
    const x = at.get(a) as number;
    const y = at.get(b) as number;
    return x === y ? 0 : x < y ? 1 : -1;
  };
  const list = [...videos];
  switch (by) {
    case 'name':
      return list.sort((a, b) => nameOrder.compare(a.name, b.name));
    case 'stage':
      // Where the work is first: to review, changes, … final last; the newest first within a stage.
      return list.sort((a, b) => stageRank(a.stage.stage) - stageRank(b.stage.stage) || recent(a, b));
    case 'open':
      return list.sort((a, b) => b.counts.must - a.counts.must || b.counts.open - a.counts.open || recent(a, b));
    default:
      return list.sort(recent);
  }
}

const byFolderName = (a: Section, b: Section) => (a.key === '~' ? 1 : b.key === '~' ? -1 : folderOrder.compare(a.key, b.key));

/**
 * Sections for grid, compact and list layouts (the board has its own lanes). By folder: the top-level project in the
 * library-wide views, the subfolder (relative to the open folder) in a folder view; by stage: one section per lane.
 * Videos keep the order they come in (sortVideos first).
 */
export function groupVideos(videos: VideoSummary[], by: GroupBy, view: LibraryView): Section[] {
  if (by === 'none' || !videos.length) return videos.length ? [{ key: 'all', videos }] : [];
  if (by === 'stage')
    return LANES.map((l) => ({ key: l.id, title: laneLabel(l.id), videos: videos.filter((v) => laneOf(v.stage.stage) === l.id) })).filter(
      (s) => s.videos.length,
    );
  const root = view.kind === 'folder' ? view.id : null;
  const m = new Map<string, VideoSummary[]>();
  for (const v of videos) {
    // In a folder view: the folder itself ('' key) and each direct subfolder; elsewhere: the top-level project.
    const k = root ? (v.folder === root ? '' : `${root}/${(v.folder ?? '').slice(root.length + 1).split('/')[0]}`) : (v.folder?.split('/')[0] ?? '~');
    m.set(k, [...(m.get(k) ?? []), v]);
  }
  const sections = [...m.entries()].map(([k, list]): Section => {
    if (k === '~') return { key: k, title: t('No project'), videos: list };
    // the folder's own videos, under the page that names it already: said as where they are, not its name again
    if (k === '')
      return { key: root as string, title: isProject(root as string) ? t('In this project') : t('In this folder'), folder: root as string, videos: list };
    return { key: k, title: leaf(k), folder: k, videos: list };
  });
  // In a folder view the folder's own videos come first, then its subfolders.
  return sections.sort((a, b) => (root && a.key === root ? -1 : root && b.key === root ? 1 : byFolderName(a, b)));
}

/** The board's lanes, each in the given order. */
export const lanes = (videos: VideoSummary[]) => LANES.map((l) => ({ ...l, videos: videos.filter((v) => laneOf(v.stage.stage) === l.id) }));

/** "4 final · 1 out for review · 1 in progress" for a group of videos. */
export const summaryLine = (videos: VideoSummary[]): string => stageSummary(videos.map((v) => v.stage.stage));

/** Counts per lane for the filter chips. */
export function laneCounts(videos: VideoSummary[]): Record<LaneFilter, number> {
  const c = { all: videos.length } as Record<LaneFilter, number>;
  for (const l of LANES) c[l.id] = 0;
  for (const v of videos) c[laneOf(v.stage.stage)]++;
  return c;
}
