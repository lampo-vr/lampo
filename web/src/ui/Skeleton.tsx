// The building blocks of loading states. A screen loads as itself — its real top bar, sidebar, titles, toolbars, cards
// and panels, with only what the data decides drawn as these placeholders at their own size — so nothing moves when
// the data arrives (test/e2e/quality-load.mjs compares the two). A busy region fades in after a beat: fast loads show nothing.
import type { CSSProperties, ReactNode } from 'react';

type Size = number | string;
const px = (v: Size | undefined) => (typeof v === 'number' ? `${v}px` : v);

/** One grey shape with a slow shimmer. Decorative: the region around it says it is busy (aria-busy). */
export function Skeleton({ w, h = 12, r, className = '', style }: { w?: Size; h?: Size; r?: Size; className?: string; style?: CSSProperties }) {
  return <span className={`sk ${className}`} style={{ width: px(w), height: px(h), borderRadius: px(r), ...style }} aria-hidden="true" />;
}

/**
 * A word or line that hasn't arrived, inside the element that will hold it: it takes that element's line box (same
 * font, same height, same baseline), so the text replaces it without moving anything. `w`: how wide the bar is.
 */
export function SkLine({ w = '6em' }: { w?: Size }) {
  return (
    <span className="sk-line" style={{ width: px(w) }} aria-hidden="true">
      {'\u00a0'}
      <span className="sk sk-line-bar" />
    </span>
  );
}

/** Lines of text; the last one shorter, like a paragraph. */
export function SkeletonText({ lines = 2, w = '100%', h = 10, gap = 8 }: { lines?: number; w?: Size; h?: number; gap?: number }) {
  return (
    <span className="sk-text" style={{ gap, width: px(w) }} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder lines have no identity
        <Skeleton key={i} h={h} w={i === lines - 1 && lines > 1 ? '62%' : '100%'} />
      ))}
    </span>
  );
}

/** The busy region: labelled for screen readers, visible after a beat. */
export function SkeletonRegion({ label, children, className = '', style }: { label: string; children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={`sk-region ${className}`} role="status" aria-busy="true" aria-label={label} data-testid="skeleton" style={style}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- pieces shared by several screens

/** Rows of a list (inbox items, links, tokens, users): a thumbnail or avatar, two lines, an action. */
export function RowsSkeleton({ n = 4, thumb = 44, action = true }: { n?: number; thumb?: number | false; action?: boolean }) {
  return (
    <div className="sk-rows">
      {Array.from({ length: n }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
        <div key={i} className="sk-row">
          {thumb !== false && <Skeleton w={thumb} h={thumb} r={8} />}
          <span className="sk-row-main">
            <Skeleton h={11} w={`${70 - ((i * 13) % 30)}%`} />
            <Skeleton h={8} w={`${45 - ((i * 7) % 20)}%`} />
          </span>
          {action && <Skeleton w={54} h={24} r={7} />}
        </div>
      ))}
    </div>
  );
}
