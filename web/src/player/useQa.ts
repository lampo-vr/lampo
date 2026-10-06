// Auto-check of a version (the pre-review: OCR typos, safe zones, flash/black frames, loudness…): the findings, what is
// picked on screen, and turning findings into notes ("Ask the agent") or putting them away ("That's intended": held
// back with Undo, then sent; the same stretch stays away in later versions — lib/findings.ts).
import { useEffect, useMemo, useState } from 'react';
import { isStretchKey, stretchOf, undismissed } from '../../../lib/findings.ts';
import { shownTextLanguage } from '../../../lib/text/language.ts';
import { api, enc } from '../api/client.ts';
import { useSSE } from '../api/events.ts';
import { useQaActions } from '../api/mutations.ts';
import { useQaQuery } from '../api/queries.ts';
import type { FrameRange, QaItem, QaProgress, Review, Severity } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { later, toast, toastError } from '../lib/toast.ts';

const RANK: Record<Severity, number> = { must: 0, should: 1, nice: 2, idea: 3 };

export function useQa({ slug, v, fps, review, onAccepted }: { slug: string; v: number; fps: number; review: Review; onAccepted: (id: string) => void }) {
  const { data } = useQaQuery(slug, v);
  const actions = useQaActions(slug, v);
  const [pick, setPick] = useState<QaItem | null>(null);
  const [progress, setProgress] = useState<QaProgress | null>(null);
  // "That's intended" on this page, sent or about to be: hidden at once, and kept hidden while the review refetches
  const [held, setHeld] = useState<{ key: string; stretch: FrameRange | null }[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a pick belongs to the version it was made on
  useEffect(() => setPick(null), [slug, v]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: what was put away belongs to its video
  useEffect(() => setHeld([]), [slug]);
  useSSE('qa-progress', (d) => d.slug === slug && d.v === v && setProgress(d as unknown as QaProgress));
  useSSE('qa', (d) => d.slug === slug && d.v === v && setProgress(null));

  const suggestions = useMemo(() => {
    if (!data?.items) return null;
    const dismissals = {
      qa_dismissed: [...(review.qa_dismissed || []), ...held.map((h) => h.key)],
      qa_stretches: { ...review.qa_stretches, ...Object.fromEntries(held.filter((h) => h.stretch).map((h) => [h.key, h.stretch as FrameRange])) },
    };
    return undismissed(data.items, dismissals, fps).sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.frame - b.frame);
  }, [data, review.qa_dismissed, review.qa_stretches, held, fps]);

  const accept = async (x: QaItem) => {
    try {
      const c = await actions.accept.mutateAsync(x.key);
      toast(t('Note {id} at {timecode}', { id: c.id, timecode: c.timecode }), 'ok');
      setPick(null);
      onAccepted(c.id);
    } catch (e) {
      toastError(e);
    }
  };
  // Nothing reaches the server until the toast is gone (Undo puts it back), and the agent never hears of it.
  const intended = (x: QaItem) => {
    if (pick?.key === x.key) setPick(null);
    const h = { key: x.key, stretch: isStretchKey(x.key) ? stretchOf(x) : null };
    later({
      message: t('Marked intended: it won’t come back on this video'),
      apply: () => setHeld((xs) => [...xs, h]),
      revert: () => setHeld((xs) => xs.filter((y) => y !== h)),
      commit: () => api(`/api/qa/${enc(slug)}/dismiss`, { method: 'POST', body: { key: x.key, v }, keepalive: true }),
    });
  };
  const rerun = () => actions.rerun.mutate();

  return {
    suggestions,
    pending: !!data?.pending,
    progress,
    // a result from before the language rules may name a language the check guessed: only a dictionary's is shown
    language: shownTextLanguage(data),
    spelling: data?.spelling,
    pick,
    setPick,
    accept,
    intended,
    rerun,
  };
}
