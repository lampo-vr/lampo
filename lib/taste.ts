// The taste file: what the reviewer asked for, loved, accepted and refused on a project, distilled from the notes.
// Agents read it before rendering so round-trips shrink over time. Deterministic: same notes → same markdown.
//   data/taste/<scope-slug>.md (+ .json)
// Scope = a top-level project folder (e.g. "Acme"), a sub-folder path, or a project path for unfiled videos.
import fs from 'node:fs';
import path from 'node:path';
import { cachedLoudness } from './media.ts';
import { dataDir } from './paths.ts';
import { listReviews, loadReview, resolveVideo, writeAtomic } from './store.ts';
import { compareTime, isAgent, oneLine } from './time.ts';
import type { Comment, Reply, Review, Severity, Taste, TasteScope, TasteStats, TasteSuggestion } from './types.ts';

const SEV: Severity[] = ['must', 'should', 'nice', 'idea'];
const top = (p: string | null | undefined) => (p ? String(p).split('/').filter(Boolean)[0] || '' : '');
const lc = (s: string | null | undefined) => String(s || '').toLowerCase();
const byCreated = (a: Comment, b: Comment) => compareTime(a.created, b.created) || a.id.localeCompare(b.id);
const clip = (s: string | null | undefined, n = 160) => {
  const t = String(s || '')
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const quote = (s: string | null | undefined) => `“${clip(s)}”`;
const vname = (r: Review) => path.basename(r.video);

/** A note together with the review it belongs to. */
interface Note {
  c: Comment;
  r: Review;
}

// Which reviews belong to a scope.
//   folder "Acme"          → videos filed under Acme/…, plus unfiled videos whose project path starts with "acme"
//   folder "Acme/Reels"    → only videos filed inside that folder
//   project "ACME/REELS"   → videos whose project path starts with it
function inScope(r: Review, { folder, project }: TasteScope): boolean {
  if (folder) {
    const f = String(folder).split('/').filter(Boolean).join('/');
    if (!f.includes('/')) return lc(top(r.folder)) === lc(f) || (!r.folder && lc(top(r.project)) === lc(f));
    return !!r.folder && (r.folder === f || r.folder.startsWith(`${f}/`));
  }
  if (project) return lc(r.project) === lc(project) || lc(r.project).startsWith(`${lc(project)}/`);
  return true;
}

const lastReply = (c: Comment, pred: (r: Reply) => boolean) => [...(c.replies || [])].reverse().find(pred);

// Newest first, one example per distinct text.
function examples(list: Note[], n: number): Note[] {
  const seen = new Set<string>();
  const out: Note[] = [];
  for (const x of [...list].reverse()) {
    const k = lc(x.c.text).replace(/\s+/g, ' ').trim() || x.c.id;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
    if (out.length >= n) break;
  }
  return out;
}

// Number phrases worth remembering: "y 1392", "x=540", "40px", "2 dB", "-14 LUFS", "4 Frames", "0.5s".
const NUM_RE =
  /\b(?:x|y|top|bottom|left|right|höhe|breite)\s*[:=]?\s*-?\d{1,4}(?:\s?px)?\b|-?\d+(?:[.,]\d+)?\s?(?:px|db|lufs|dbtp|frames?|f\b|sek(?:unden)?|s\b|ms\b|%)/gi;
function numberPhrases(text: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of String(text || '').matchAll(NUM_RE)) out.push(m[0].replace(/\s+/g, ' ').trim());
  return out;
}

function boxStats(comments: Note[]) {
  // Marked regions in video px: vertical extent as px and % of frame height.
  const ys: [number, number, number][] = [];
  const xs: [number, number, number][] = [];
  for (const { c, r } of comments) {
    const H = r.height || 1920;
    const W = r.width || 1080;
    for (const s of c.drawing || []) {
      if (s.type === 'box') {
        ys.push([s.y / H, (s.y + s.h) / H, H]);
        xs.push([s.x / W, (s.x + s.w) / W, W]);
      } else if (s.type === 'arrow') {
        ys.push([s.y2 / H, s.y2 / H, H]);
        xs.push([s.x2 / W, s.x2 / W, W]);
      }
    }
  }
  if (!ys.length) return null;
  const pct = (v: number) => Math.round(v * 100);
  const y0 = Math.min(...ys.map((y) => y[0]));
  const y1 = Math.max(...ys.map((y) => y[1]));
  const x0 = Math.min(...xs.map((x) => x[0]));
  const x1 = Math.max(...xs.map((x) => x[1]));
  const H = ys[0][2];
  const W = xs[0][2];
  return {
    marks: ys.length,
    y: [Math.round(y0 * H), Math.round(y1 * H)],
    yPct: [pct(y0), pct(y1)],
    x: [Math.round(x0 * W), Math.round(x1 * W)],
    xPct: [pct(x0), pct(x1)],
    ref: `${W}×${H}`,
  };
}

/**
 * Recurring asks as rules waiting to be written (the playbook's "make it a rule"): notes that share a tag, at least
 * `min` of them, most frequent first, with their newest distinct texts. Untagged notes and love-its aren't asks.
 */
export function recurringAsks(reviews: Review[], scope: TasteScope = {}, min = 3): TasteSuggestion[] {
  const scoped = reviews.filter((r) => !r.archived && !r.onboarding_sample && inScope(r, scope));
  const groups = new Map<string, Note[]>();
  for (const r of scoped)
    for (const c of r.comments || []) {
      if (isAgent(c.author) || c.author.startsWith('guest:') || !c.tags?.length || c.tags.includes('love-it')) continue;
      for (const t of c.tags) groups.set(t, [...(groups.get(t) || []), { c, r }]);
    }
  return [...groups.entries()]
    .filter(([, list]) => list.length >= min)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([tag, list]) => ({
      tag,
      count: list.length,
      examples: examples(
        [...list].sort((a, b) => byCreated(a.c, b.c)),
        3,
      ).map(({ c, r }) => ({ id: c.id, text: clip(c.text, 200), video: vname(r) })),
    }));
}

export function buildTaste(reviews: Review[], { folder, project, title }: TasteScope = {}): Taste {
  // the first run's sample teaches the loop; what its made-up notes ask for is nobody's taste
  const scoped = reviews.filter((r) => !r.archived && !r.onboarding_sample && inScope(r, { folder, project }));
  const scope = title || folder || project || 'all videos';
  const all: Note[] = [];
  for (const r of scoped) for (const c of r.comments || []) all.push({ c, r });
  all.sort((a, b) => byCreated(a.c, b.c));
  const human = all.filter(({ c }) => !isAgent(c.author));
  const versions = scoped.reduce((s, r) => s + (r.versions?.length || 0), 0);

  const stats: TasteStats = {
    videos: scoped.length,
    notes: human.length,
    agent_questions: all.length - human.length,
    versions,
    round_trips: scoped.length ? Math.round((versions / scoped.length) * 10) / 10 : 0,
    notes_per_version: versions ? Math.round((human.length / versions) * 10) / 10 : 0,
    open: human.filter(({ c }) => c.status === 'open').length,
    by_tag: {},
    by_severity: {},
    last_note: human.at(-1)?.c.created || null,
  };

  const loved = human.filter(({ c }) => (c.tags || []).includes('love-it'));
  const asks = human.filter(({ c }) => !(c.tags || []).includes('love-it'));
  const groups = new Map<string, Note[]>();
  for (const x of asks) {
    const tags = x.c.tags?.length ? x.c.tags : ['untagged'];
    for (const t of tags) {
      const list = groups.get(t) || [];
      list.push(x);
      groups.set(t, list);
    }
    stats.by_severity[x.c.severity] = (stats.by_severity[x.c.severity] || 0) + 1;
  }
  for (const [t, l] of groups) stats.by_tag[t] = l.length;
  const tagOrder = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  const stands = all.filter(({ c }) => c.status === 'wontfix');
  const worked = all.filter(({ c }) => c.status === 'verified' && lastReply(c, (r) => r.status === 'fixed' && !!r.text));
  const open = human.filter(({ c }) => c.status === 'open').sort((a, b) => SEV.indexOf(a.c.severity) - SEV.indexOf(b.c.severity) || byCreated(a.c, b.c));

  const L: string[] = [];
  L.push(`# Taste: ${scope}`);
  L.push('');
  L.push(`What the reviewer asked for, loved, accepted and refused on ${scope === 'all videos' ? 'all videos' : `"${scope}"`}. Read it before rendering.`);
  L.push(`Follow "Decisions that stand" (never "fix" those), repeat "Keep doing", and pre-empt "Recurring asks".`);
  L.push('');
  L.push(
    `- ${stats.videos} video${stats.videos === 1 ? '' : 's'} · ${stats.notes} notes (${stats.open} open) · ${versions} renders · ${stats.round_trips} renders per video · ${stats.notes_per_version} notes per render`,
  );
  if (stats.last_note) L.push(`- last note: ${stats.last_note}`);
  L.push('');

  L.push('## Keep doing');
  L.push('');
  if (loved.length) for (const { c, r } of examples(loved, 10)) L.push(`- ${quote(c.text || '(marked frame)')} — ${vname(r)} ${c.timecode} (v${c.v})`);
  else L.push('_No love-it notes yet._');
  L.push('');

  L.push('## Recurring asks');
  L.push('');
  if (!tagOrder.length) L.push('_No notes yet._');
  for (const [tag, list] of tagOrder) {
    const sev = SEV.map((s) => [s, list.filter(({ c }) => c.severity === s).length] as const).filter(([, n]) => n);
    L.push(`### ${tag} — ${list.length} note${list.length === 1 ? '' : 's'} (${sev.map(([s, n]) => `${s} ${n}`).join(' · ')})`);
    for (const { c, r } of examples(list, 5)) L.push(`- ${quote(c.text || '(marked frame)')} — ${vname(r)} ${c.timecode} · ${c.status}`);
    L.push('');
  }

  L.push('## Decisions that stand');
  L.push('');
  if (stands.length)
    for (const { c, r } of examples(stands, 10)) {
      const why = lastReply(c, (x) => x.status === 'wontfix');
      L.push(`- ${quote(c.text || '(marked frame)')} → won't fix${why?.text ? `: ${quote(why.text)}` : ''} (${why?.by || '?'}, ${vname(r)} ${c.timecode})`);
    }
  else L.push('_None yet._');
  L.push('');

  L.push('## Fixes that worked');
  L.push('');
  if (worked.length)
    for (const { c, r } of examples(worked, 10)) {
      const fix = lastReply(c, (x) => x.status === 'fixed' && !!x.text);
      L.push(`- ${quote(c.text || '(marked frame)')} → ${quote(fix?.text)} (v${fix?.fixed_in_v || '?'}, verified · ${vname(r)} ${c.timecode})`);
    }
  else L.push('_No verified fixes yet._');
  L.push('');

  // Numbers: where marks cluster, values that were accepted, loudness of the current renders.
  const nums: string[] = [];
  for (const [tag, list] of tagOrder) {
    const b = boxStats(list.filter(({ c }) => c.drawing?.length));
    if (b)
      nums.push(
        `- ${tag}: ${b.marks} mark${b.marks === 1 ? '' : 's'} between y ${b.y[0]}–${b.y[1]} (${b.yPct[0]}–${b.yPct[1]}% of height) · x ${b.x[0]}–${b.x[1]} (ref ${b.ref})`,
      );
  }
  const accepted: string[] = [];
  for (const { c } of worked) {
    const fix = lastReply(c, (x) => x.status === 'fixed' && !!x.text);
    for (const p of numberPhrases(fix?.text)) accepted.push(`${p} (${c.id})`);
  }
  if (accepted.length) nums.push(`- accepted values in verified fixes: ${[...new Set(accepted)].slice(0, 12).join(' · ')}`);
  const asked: string[] = [];
  for (const { c } of asks) for (const p of numberPhrases(c.text)) asked.push(p);
  if (asked.length) nums.push(`- values the reviewer asked for: ${[...new Set(asked)].slice(0, 12).join(' · ')}`);
  const loud = scoped
    .map((r) => {
      const ver = r.versions?.at(-1);
      const l = ver ? cachedLoudness(ver) : null;
      return l?.lufs != null ? { lufs: l.lufs, tp: l.true_peak } : null;
    })
    .filter((x) => !!x);
  if (loud.length) {
    const avg = Math.round((loud.reduce((s, x) => s + x.lufs, 0) / loud.length) * 10) / 10;
    const tp = Math.max(...loud.map((x) => x.tp ?? -99));
    nums.push(`- loudness of the current renders: ${avg} LUFS on average, true peak max ${tp} dBTP (${loud.length} video${loud.length === 1 ? '' : 's'})`);
  }
  L.push('## Numbers');
  L.push('');
  L.push(...(nums.length ? nums : ['_Not enough marked frames yet._']));
  L.push('');

  L.push(`## Open right now (${open.length})`);
  L.push('');
  if (open.length) {
    for (const { c, r } of open.slice(0, 15))
      L.push(`- ${c.id} ${c.severity.toUpperCase()} ${c.timecode} ${vname(r)} — ${clip(c.text || '(marked frame)', 90)}`);
    if (open.length > 15) L.push(`- … ${open.length - 15} more (lampo ls --open)`);
  } else L.push('_Nothing open._');
  L.push('');

  // One entry, one line: a folder, a file name or a note's words never start a line of their own (agents read it).
  return { scope, markdown: L.map(oneLine).join('\n'), stats, generated: new Date().toISOString() };
}

// The scope a video's taste comes from: its top-level project folder, else the first segment of its project path.
export function scopeForVideo(videoPath: string): TasteScope {
  const { slug } = resolveVideo(videoPath);
  return scopeOf(loadReview(slug));
}

export function scopeOf(r: Pick<Review, 'folder' | 'project'> | null): TasteScope {
  if (r?.folder) return { folder: top(r.folder) };
  return { folder: top(r?.project) || r?.project };
}

export const scopeSlug = (s: string | null | undefined): string =>
  String(s || 'all')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'all';

// scope: "Acme" | "Acme/Reels" | {folder} | {project} | {video}
export function writeTaste(scope: string | (TasteScope & { video?: string }) | null | undefined): string {
  const opts: TasteScope = typeof scope === 'string' ? { folder: scope } : scope?.video ? scopeForVideo(scope.video) : scope || {};
  const t = buildTaste(listReviews(), opts);
  const dir = path.join(dataDir(), 'taste');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${scopeSlug(t.scope)}.md`);
  writeAtomic(file, t.markdown);
  writeAtomic(file.replace(/\.md$/, '.json'), `${JSON.stringify({ scope: t.scope, stats: t.stats, generated: t.generated }, null, 2)}\n`);
  return file;
}
