// The small pieces Settings → Billing is drawn with: the days as a ruler (a trial's fourteen, a grace period's seven:
// frames on a timeline, today the playhead, the end a keyframe), a meter of what the workspace uses (dashed where the
// plan sets no limit, so three meters always read as three), the workspace against Free resource by resource, and a
// card's brand mark. Decorative parts are aria-hidden: the words beside them say the same.
import type { CSSProperties, ReactNode } from 'react';
import type { BillingInfo } from '../../../lib/types.ts';
import { t } from '../i18n/index.ts';
import type { Shape } from '../ui/glyphs.ts';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { dayOf, FREE_LIMITS, size } from './words.ts';

/**
 * Day `day` (1-based, today) of `of`; the end a keyframe in `tone` (hollow while calm). `sweep`: the days still to come
 * fill one after another (the checkout's done panel: the plan now runs on past the trial), each cell's place in `--i`.
 */
export function Ruler({
  day,
  of,
  end = 'outline',
  tone = '',
  sweep = false,
}: {
  day: number;
  of: number;
  end?: Shape;
  tone?: '' | 'should' | 'must';
  sweep?: boolean;
}) {
  const x = Math.min(1, Math.max(0, (day - 0.5) / of));
  return (
    <span className={`bill-ruler ${sweep ? 'sweep' : ''}`} style={{ '--n': of } as CSSProperties} aria-hidden="true">
      <span className="bill-ruler-cells">
        {Array.from({ length: of }, (_, i) => (
          <i
            // biome-ignore lint/suspicious/noArrayIndexKey: the days of one ruler, in order
            key={i}
            className={i < day - 1 ? 'past' : i === day - 1 ? 'today' : ''}
            style={sweep && i >= day ? ({ '--i': i - day } as CSSProperties) : undefined}
          />
        ))}
        <span className="bill-ruler-ph" style={{ insetInlineStart: `${(x * 100).toFixed(2)}%` }} />
      </span>
      <KeyGlyph shape={end} className={`bill-ruler-end ${tone}`} />
    </span>
  );
}

/** The ruler's dates: the start, "today" over the playhead, the end; an edge date steps aside when today is near it. */
export function RulerTicks({ day, of, start, end }: { day: number; of: number; start: string; end: string }) {
  const x = Math.min(1, Math.max(0, (day - 0.5) / of));
  return (
    <span className="bill-ticks" aria-hidden="true">
      <span>{x < 0.27 ? '' : dayOf(start, { short: true })}</span>
      <span className="bill-ticks-now" style={{ insetInlineStart: `${(x * 100).toFixed(1)}%` }}>
        {t('today')}
      </span>
      <span>{x > 0.72 ? '' : dayOf(end, { short: true })}</span>
    </span>
  );
}

/** One thing the workspace uses: the label and the number above, the bar below (`share` null: no limit, dashed). */
export function Meter({ label, value, share, testid, note }: { label: string; value: string; share: number | null; testid?: string; note?: ReactNode }) {
  const over = share !== null && share > 1;
  return (
    <div className="bill-meter" data-testid={testid}>
      <div className="bill-meter-head">
        <span>{label}</span>
        <b className={over ? 'over' : undefined}>{value}</b>
      </div>
      <div className={`bill-bar ${share === null ? 'none' : over ? 'over' : ''}`} aria-hidden="true">
        {share !== null && <span style={{ inlineSize: `${Math.max(2, Math.min(100, share * 100)).toFixed(1)}%` }} />}
      </div>
      {note && <div className="bill-meter-note">{note}</div>}
    </div>
  );
}

/** What the workspace holds against Free: the part over Free's notch hatched. */
function FitBar({ label, has, free, hasLabel, freeLabel }: { label: string; has: number; free: number; hasLabel: string; freeLabel: string }) {
  const scale = Math.max(has, free, 1) * 1.08;
  const h = (has / scale) * 100;
  const f = (free / scale) * 100;
  return (
    <div className="bill-fit">
      <div className="bill-fit-head">
        <span>{label}</span>
        <b>{hasLabel}</b>
      </div>
      <div className="bill-fit-bar" aria-hidden="true">
        <span className="bill-fit-in" style={{ inlineSize: `${Math.min(h, f)}%` }} />
        {has > free && <span className="bill-fit-over" style={{ insetInlineStart: `${f}%`, inlineSize: `${h - f}%` }} />}
        <span className="bill-fit-notch" style={{ insetInlineStart: `${f}%` }} />
      </div>
      <div className="bill-fit-free" style={{ '--x': `${f}%` } as CSSProperties}>
        {/* past the middle the label ends at the notch, so it never runs out of the bar */}
        <span className={f > 50 ? 'end' : undefined}>{freeLabel}</span>
      </div>
    </div>
  );
}

/** Members, storage and videos under review against what Free holds. */
export function FitGrid({ usage }: { usage: BillingInfo['usage'] }) {
  return (
    <div className="bill-fit-grid" data-testid="billing-fit">
      <FitBar
        label={t('Members')}
        has={usage.members}
        free={FREE_LIMITS.members}
        hasLabel={String(usage.members)}
        freeLabel={t('Free holds {n}', { n: FREE_LIMITS.members })}
      />
      <FitBar
        label={t('Storage')}
        has={usage.bytes}
        free={FREE_LIMITS.bytes}
        hasLabel={size(usage.bytes)}
        freeLabel={t('Free holds {n}', { n: size(FREE_LIMITS.bytes) })}
      />
      <FitBar
        label={t('Videos under review')}
        has={usage.activeVideos}
        free={FREE_LIMITS.activeVideos}
        hasLabel={String(usage.activeVideos)}
        freeLabel={t('Free holds {n}', { n: FREE_LIMITS.activeVideos })}
      />
    </div>
  );
}

/** A card's brand, as the card itself shows it (Visa, Mastercard); any other way to pay gets the card icon. */
export function CardMark({ brand }: { brand?: string }) {
  if (brand === 'visa')
    return (
      <svg className="bill-mark" viewBox="0 0 32 20" aria-hidden="true">
        <rect x="0.5" y="0.5" width="31" height="19" rx="3" fill="#fff" stroke="rgba(0,0,0,.12)" />
        <path
          d="M13.3 13.6h-1.9l1.2-7.2h1.9zm6.9-7c-.4-.1-1-.3-1.7-.3-1.9 0-3.2 1-3.2 2.4 0 1.1.9 1.6 1.7 2 .7.3 1 .6 1 .9 0 .5-.6.7-1.2.7-.8 0-1.2-.1-1.9-.4l-.3-.1-.3 1.6c.5.2 1.3.4 2.2.4 2 0 3.3-1 3.3-2.5 0-.8-.5-1.4-1.6-2-.7-.3-1.1-.6-1.1-.9 0-.3.3-.6 1.1-.6.6 0 1.1.1 1.4.3l.2.1zm4.9-.6h-1.5c-.5 0-.8.1-1 .6l-2.8 6.6h2l.4-1.1h2.4l.2 1.1h1.8zm-2.3 4.6.8-2 .4 2zm-11.8-4.6-1.9 4.9-.2-1c-.3-1.1-1.4-2.4-2.6-3l1.7 6.3h2l3-7.2z"
          fill="#1a1f71"
        />
        <path d="M7.6 6.4H4.5v.1c2.4.6 4 2.1 4.6 3.9l-.7-3.4c-.1-.5-.4-.6-.8-.6" fill="#f7a600" />
      </svg>
    );
  if (brand === 'mastercard')
    return (
      <svg className="bill-mark" viewBox="0 0 32 20" aria-hidden="true">
        <rect x="0.5" y="0.5" width="31" height="19" rx="3" fill="#fff" stroke="rgba(0,0,0,.12)" />
        <circle cx="13" cy="10" r="5.4" fill="#eb001b" />
        <circle cx="19" cy="10" r="5.4" fill="#f79e1b" />
        <path d="M16 5.5a5.4 5.4 0 0 1 0 9 5.4 5.4 0 0 1 0-9" fill="#ff5f00" />
      </svg>
    );
  return (
    <span className="bill-mark bill-mark-any" aria-hidden="true">
      <I name="billing" size={14} />
    </span>
  );
}
