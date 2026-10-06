// The cards of one library section (grid and compact layouts). A long section renders only the rows of cards near the
// view, with the rest of its height kept as padding (lib/windowing.ts); a short one renders every card.
import { type ReactNode, useRef } from 'react';
import type { VideoSummary } from '../api/types.ts';
import { useGridMetrics, useWindowed } from '../lib/windowing.ts';

/** A card's height before one has been measured (a grid card at 1440 px; only the first paint of a long list uses it). */
const GUESS = 260;

interface FilmGridProps {
  videos: VideoSummary[];
  compact: boolean;
  /** Part of a long library (lib/windowing.ts WINDOW_FROM): only the cards near the view render. */
  long: boolean;
  card: (v: VideoSummary, i: number) => ReactNode;
}

export function FilmGrid({ videos, compact, long, card }: FilmGridProps) {
  const ref = useRef<HTMLDivElement>(null);
  const m = useGridMetrics(ref, long, compact ? 'compact' : 'grid');
  const cols = long ? m.cols || 1 : 1;
  const rows = long ? Math.ceil(videos.length / cols) : 0;
  const rowHeight = m.rowHeight || GUESS;
  const w = useWindowed(ref, { enabled: long, rows, height: () => rowHeight, gap: m.gap, version: m.version });
  const shown = w.on ? videos.slice(w.first * cols, (w.last + 1) * cols) : videos;
  return (
    <div
      ref={ref}
      className={`grid ${compact ? 'compact' : ''}`}
      style={w.on ? { paddingTop: w.before, paddingBottom: w.after } : undefined}
      data-windowed={w.on || undefined}
    >
      {shown.map((v, j) => card(v, (w.on ? w.first * cols : 0) + j))}
    </div>
  );
}
