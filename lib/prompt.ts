// The compact hand-off text behind "Copy for Claude" (UI) and `vr prompt` (CLI).
import path from 'node:path';
import { describeShape } from './drawing.ts';
import { partLine } from './part.ts';
import { reviewDir, slugify } from './paths.ts';
import { counts } from './store.ts';
import { isIdea, isQuestion, isRequired, noteLabel, noteRank, oneLine } from './time.ts';
import { textEditLine } from './transcript.ts';
import type { Comment, Review } from './types.ts';

export interface PromptOptions {
  includeFixed?: boolean;
  /** Where a screenshot of this review is on this machine (a remote review's downloaded copies). */
  shot?: (file: string | undefined) => string | null;
  /** Where review.json can be read (a path, or a URL for a remote review). */
  dataFile?: string;
  /** Rendered by a hosted server for a Claude on another machine: point at `vr` instead of server paths. */
  hosted?: string;
}

export function claudePrompt(review: Review, { includeFixed = true, shot, dataFile, hosted }: PromptOptions = {}): string {
  const latest = review.versions.at(-1);
  const dir = reviewDir(slugify(review.video));
  const abs = shot || ((f: string | undefined) => (f ? path.join(dir, f) : null));
  const openAll = review.comments.filter((c) => c.status === 'open').sort((a, b) => noteRank(a) - noteRank(b) || a.t - b.t);
  const open = openAll.filter(isRequired);
  const ideas = openAll.filter(isIdea);
  const questions = openAll.filter(isQuestion);
  const fixed = review.comments.filter((c) => c.status === 'fixed');
  const n = counts(review);
  const L: string[] = [];
  L.push(`Video review feedback, frame-exact. Please work through the open items.`);
  if (hosted) L.push(`Hosted review: ${hosted}. If vr isn't signed in there yet: vr login ${hosted} (token from Settings → API tokens).`);
  L.push(`Video: ${review.video}`);
  L.push(`Current: v${latest?.v} · ${review.width}×${review.height} · ${review.fps} fps · ${review.frames} frames · ${review.duration}s`);
  if (hosted)
    L.push(
      `Review data: vr open "${review.video}" (vr prompt "${review.video}" prints this list with local screenshot paths). Frames are 0-based, timecode mm:ss:ff, drawings in video px.`,
    );
  else L.push(`Review data: ${dataFile || path.join(dir, 'review.json')} (summary: review.md). Frames are 0-based, timecode mm:ss:ff, drawings in video px.`);
  L.push('');
  const item = (c: Comment, i: number) => {
    const range = c.range ? ` (range f${c.range.in}–${c.range.out})` : '';
    const flags = [
      c.check_again ? `carried from v${c.v}, check again` : null,
      c.v !== latest?.v && !c.check_again ? `made on v${c.v}` : null,
      isQuestion(c) ? `asked by ${c.author}` : null,
      c.scope === 'video' ? 'overall: about the whole video, not frame 0' : null,
    ].filter(Boolean);
    L.push(
      `${i + 1}. ${c.id} · ${noteLabel(c)} · ${c.tags.join(', ') || '–'} · ${c.timecode} f${c.frame}${range}${flags.length ? ` · ${flags.join(', ')}` : ''}`,
    );
    L.push(`   ${c.text || (c.text_edit ? '(a change to the words, below)' : '(no text, see marked frame)')}`);
    if (c.text_edit) L.push(`   ${textEditLine(c.text_edit, c, review.versions.find((x) => x.v === c.v)?.fps || review.fps)}`);
    if (c.part && c.status === 'open') L.push(`   ${partLine(c.part)}`);
    for (const s of c.drawing || []) L.push(`   drawing: ${describeShape(s)}`);
    const last = c.replies?.at(-1);
    if (last) L.push(`   last reply (${last.by}): ${last.text || last.status}`);
    // a note about the whole video has no frame of its own to show
    if (hosted) {
      if (c.scope !== 'video') L.push(`   frames: vr show ${c.id} (downloads the marked and the clean frame)`);
    } else if (c.shots) {
      L.push(`   marked: ${abs(c.shots.marked)}`);
      L.push(`   clean:  ${abs(c.shots.clean)}`);
    }
  };
  L.push(`Open (${n.open}${n.must ? `, ${n.must} must` : ''}):`);
  open.forEach(item);
  if (!open.length) L.push('   none');
  if (ideas.length) {
    L.push('');
    L.push(`Ideas (optional — your call) (${ideas.length}): suggestions to consider, not required changes.`);
    ideas.forEach(item);
  }
  if (questions.length) {
    L.push('');
    L.push(`Questions to the reviewer, not answered yet (${questions.length}): no work item; wait for the answer (vr watch).`);
    questions.forEach(item);
  }
  if (includeFixed && fixed.length) {
    L.push('');
    L.push(`Already marked fixed, waiting for verification (${fixed.length}): ${fixed.map((c) => `${c.id} (${c.timecode}, v${c.fixed_in_v})`).join(', ')}`);
  }
  L.push('');
  if (review.source?.kind === 'upload')
    L.push(`When an item is done: upload the new render with vr push <file> --to "${review.video}", then vr fix <id> --note "what you changed".`);
  else L.push(`When an item is done (after re-rendering to the same path): vr fix <id> --note "what you changed" (version is picked up automatically).`);
  L.push(`Question about a frame: vr add "${review.video}" --frame <N> --text "…"   ·   Live feedback: vr watch`);
  // One line per entry: what people wrote can't start a numbered item of its own.
  return L.map(oneLine).join('\n');
}
