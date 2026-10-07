// What an agent reads of a footage answer: a head naming what the request was read as, one line per shot, and how far
// the index is (`lampo footage find`, find_footage). Browser-safe.
import { oneLine, timecode } from '../time.ts';
import { readFilters } from './query.ts';
import type { FootageAnswer, FootageRead, FootageShot } from './types.ts';

const clip = (s: string, n = 40): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One shot as the compact list says it: `s320 Folder/reel.mp4 00:20:14–00:23:13 3.0s 9:16 push-in fast · 3.3`. */
export function shotLine(s: FootageShot, read?: FootageRead): string {
  const where = oneLine(s.folder ? `${s.folder}/${s.name}` : s.name);
  const move = s.speed ? `${s.move} ${s.speed}` : s.move;
  const extra = [
    s.text && (s.matched?.includes('text') || !read?.no_text) ? `text "${oneLine(clip(s.text))}"` : '',
    s.said && s.matched?.includes('said') ? `said "${oneLine(clip(s.said))}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `${s.id} ${where}${s.v > 1 ? ` V${s.v}` : ''} ${timecode(s.in, s.fps)}–${timecode(s.out, s.fps)} ${s.length_s.toFixed(1)}s ${s.aspect} ${move}${extra ? ` ${extra}` : ''} · ${s.score.toFixed(1)}`;
}

/** The compact answer an agent reads: a head naming what was read, one line per shot, and how far the index is. */
export function compactList(a: FootageAnswer): string {
  const f = readFilters(a.read);
  const head = `${a.shots.length} of ${a.searched} shots${a.read.show ? ` · "${oneLine(a.read.show)}"` : ''}${f.length ? ` · ${f.map(oneLine).join(' · ')}` : ''}`;
  const i = a.index;
  const tail: string[] = [];
  if (!i.on) tail.push(`(${i.note ?? 'footage search is off here'})`);
  else {
    if (i.waiting || i.failed)
      tail.push(
        `(indexed ${i.indexed} of ${i.videos} videos${i.waiting ? `, ${i.waiting} still being indexed` : ''}${i.failed ? `, ${i.failed} failed` : ''})`,
      );
    if (i.note) tail.push(`(${i.note})`);
  }
  return [head, ...a.shots.map((s) => shotLine(s, a.read)), ...tail].join('\n');
}
