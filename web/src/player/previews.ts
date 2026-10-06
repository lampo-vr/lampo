// Fix previews (lib/previews.ts) in the player: where their files are, which one verify mode shows, and what became
// of each (a later render matched it, did not, or none has come yet).
import type { FixPreview } from '../../../lib/types.ts';
import { enc } from '../api/client.ts';
import { t } from '../i18n/index.ts';

export const previewUrl = (slug: string, p: Pick<FixPreview, 'file'>) => `/api/previews/${enc(slug)}/${p.file}`;

/** The preview verify mode checks: the newest one made against the render on screen that no render has settled yet. */
export function pendingPreview(c: { previews?: FixPreview[] }, latestV: number): FixPreview | null {
  const list = c.previews || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i] as FixPreview;
    if (p.v === latestV && !p.confirmed && !p.mismatch) return p;
  }
  return null;
}

/** Where it was made, for people: "After Effects · Main", or null. */
export const previewSource = (p: FixPreview): string | null => (p.source ? [p.source.app, p.source.comp].filter(Boolean).join(' · ') : null);

/** What became of a preview, in words, with the tone of a badge. */
export function previewState(p: FixPreview): { tone: 'ok' | 'must' | 'neutral'; text: string } {
  if (p.confirmed) return { tone: 'ok', text: t('Matched in V{v}', { v: p.confirmed.v }) };
  if (p.mismatch) return { tone: 'must', text: t("V{v} doesn't match: {reason}", { v: p.mismatch.v, reason: p.mismatch.reason }) };
  return { tone: 'neutral', text: t('Waiting for the next version') };
}
