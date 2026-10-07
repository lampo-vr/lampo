// Get started at the sidebar's foot, above the trial's line, while the first run has steps open: "Get started 2 of 5",
// the keyframe of where it stands and a 2 px hairline of the steps inside the row's own edge (never a ring, a spinner or
// the orange). This is the first paint's part: the row's face, its room held from the start by what this browser saw
// last (lib/chromeHint.ts). Its code comes after the first paint (Panel.tsx SideRow, in Get started's chunk): the steps
// in a panel above it (a sheet from a phone's or tablet's drawer), the count kept live, "You're set" at the end.
import { type ComponentProps, useEffect } from 'react';
import { useAuthStatus } from '../api/auth.ts';
import { t } from '../i18n/index.ts';
import { rememberStart } from '../lib/chromeHint.ts';
import { useLoaded, usePainted } from '../lib/lazy.ts';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import type { GetStartedProps } from './GetStarted.tsx';
import { getStartedCode, openGetStarted, useFirstRun } from './state.ts';

export type RowFaceProps = { count: { done: number; of: number }; all?: boolean; pop?: boolean } & ComponentProps<'button'>;

/** The row's face — the keyframe, the words, the steps' line — the same element before its code arrives and after. */
export function RowFace({ count, all, pop, ...button }: RowFaceProps) {
  return (
    <button type="button" className={`ob-side-row ${all ? 'ob-all' : ''}`} aria-haspopup="dialog" data-testid="ob-row" {...button}>
      <KeyGlyph key={count.done} shape={all ? 'diamond' : count.done ? 'half' : 'outline'} pop={pop} className="ob-side-kg" />
      <span className="ob-side-label">{all ? t('You’re set') : t('Get started')}</span>
      <span className="ob-side-count" data-testid="ob-row-count">
        {t('{done} of {n}', { done: count.done, n: count.of })}
      </span>
      <span className="ob-side-line" aria-hidden="true">
        {Array.from({ length: count.of }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a step's place on the line
          <i key={i} className={i < count.done ? 'ob-on' : undefined} />
        ))}
      </span>
    </button>
  );
}

export function StartRow(props: GetStartedProps) {
  const known = !!useAuthStatus().data;
  const run = useFirstRun();
  // what the next first paint holds room for
  const done = run.count?.done ?? 0;
  const of = run.count?.of ?? 0;
  useEffect(() => {
    if (known) rememberStart(run.side && of ? [done, of] : null);
  }, [known, run.side, done, of]);
  const Ob = useLoaded(getStartedCode, usePainted(run.side) && run.side);
  // its face handed on, so this module stays the library's alone (no chunk of its own in the first paint)
  if (Ob) return <Ob.SideRow {...props} Face={RowFace} />;
  if (!run.side || !run.count) return null;
  return (
    <div className="ob-side" data-testid="ob-row-wrap">
      <RowFace count={run.count} aria-expanded={false} onClick={openGetStarted} />
    </div>
  );
}
