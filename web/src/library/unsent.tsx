// The library's "2 not sent": how many of your notes on a video wait to be sent (the drafts you saved and what your
// recordings said; api/drafts.ts). A quiet reminder, never in the way: one request for every video, asked once the
// library has painted, and each card reads its own number from a small store — no query per card.
import { useEffect, useSyncExternalStore } from 'react';
import { useUnsent } from '../api/drafts.ts';
import { t } from '../i18n/index.ts';
import { usePainted } from '../lib/lazy.ts';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';

let counts: Readonly<Record<string, number>> = {};
const subs = new Set<() => void>();
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};

/** The library asks for the counts (once for all its cards), after the cards' first paint: never in its chain of requests. */
export function useUnsentCounts(enabled: boolean, cards: boolean): void {
  const painted = usePainted(cards);
  const data = useUnsent(enabled && painted).data;
  useEffect(() => {
    if (!data) return;
    counts = data.videos;
    for (const f of subs) f();
  }, [data]);
}

/** Your notes on this video that aren't sent yet. */
export const useUnsentOf = (slug: string): number => useSyncExternalStore(subscribe, () => counts[slug] ?? 0);

/** "2 not sent" with a hollow keyframe: on a poster (`chip`, the cards' dark island) or in a row's line. */
export function UnsentMark({ slug, chip = false }: { slug: string; chip?: boolean }) {
  const n = useUnsentOf(slug);
  if (!n) return null;
  return (
    <span
      className={chip ? 'vchip unsent-chip' : 'unsent-mark'}
      title={t('{n} note of yours is not sent yet|{n} notes of yours are not sent yet', { n })}
      data-testid="unsent-mark"
    >
      <KeyGlyph shape="outline" />
      {t('{n} not sent', { n })}
    </span>
  );
}
