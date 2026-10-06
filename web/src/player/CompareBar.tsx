// Compare two versions (or a sibling render) on the stage: side by side, a wipe, or one over the other (the
// difference shows exactly what changed; onion skin fades between them). Both videos play in sync (usePlayback).
// The owner's player and a review link share it: a link offers side by side and the wipe, either side picked from the
// versions it shows, in its own words (web/src/guest/GuestPlayer.tsx).
import type { VideoSummary } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { Slider } from '../ui/controls.tsx';
import { IconButton, type Option, Segmented } from '../ui/primitives.tsx';
import { Select } from '../ui/select.tsx';
import type { AbState, CompareMode } from './useVerify.ts';

interface CompareBarProps {
  ab: NonNullable<AbState>;
  setAb: (ab: AbState) => void;
  /** The versions either side can show, oldest first. */
  versions: { v: number }[];
  /** The version on the A side. */
  v: number;
  latestV: number;
  siblings?: VideoSummary[];
  /** Versions somebody approved: labelled, so the one to compare against is easy to find. */
  approved?: Set<number>;
  /** A ⇄ B: only between versions of this video. */
  onSwap?: () => void;
  onClose: () => void;
  /** Phones: in the strip under the top bar (the stage is too small to float over), "side by side" is a swipe. */
  inline?: boolean;
  /** The ways to compare offered (all three by default; a review link: side by side and the wipe). */
  modes?: CompareMode[];
  /** A is picked here too (a review link: either side from the versions it shows). */
  onPickA?: (v: number) => void;
  /** What a version is called in the pickers (default: `versionLabel`). */
  nameOf?: (v: number) => string;
  /** A review link's words (German addresses its visitors as "Sie"). */
  client?: boolean;
  /** The modes as icons (a phone's row); their names stay their accessible names. */
  iconModes?: boolean;
  /** "Side by side" puts the pictures one above the other (an upright phone, landscape pictures): it says so. */
  stacked?: boolean;
}

/** "V8 · approved", "V9 · newest": what a version is to the person comparing. */
export function versionLabel(v: number, latestV: number, approved: Set<number>): string {
  const tags = [v === latestV ? 'newest' : null, approved.has(v) ? 'approved' : null].filter(Boolean);
  return tags.length ? `V${v} · ${tags.join(' · ')}` : `V${v}`;
}

const NONE = new Set<number>();

export function CompareBar({
  ab,
  setAb,
  versions,
  v,
  latestV,
  siblings = [],
  approved = NONE,
  onSwap,
  onClose,
  inline = false,
  modes: offered = ['side', 'wipe', 'overlay'],
  onPickA,
  nameOf = (x) => versionLabel(x, latestV, approved),
  client = false,
  iconModes = false,
  stacked = false,
}: CompareBarProps) {
  const bV = ab.key.startsWith('v:') ? Number(ab.key.slice(2)) : null;
  const options: Option[] = [
    ...versions
      .filter((x) => x.v !== v)
      .reverse()
      .map((x) => ({ value: `v:${x.v}`, label: nameOf(x.v) })),
    ...siblings.map((s) => ({ value: `s:${s.slug}`, label: s.name })),
  ];
  const aOptions: Option[] = [...versions]
    .filter((x) => x.v !== bV)
    .reverse()
    .map((x) => ({ value: String(x.v), label: nameOf(x.v) }));
  const words = client
    ? {
        bar: t('client::Compare'),
        side: stacked ? t('client::One above the other') : t('client::Side by side'),
        wipe: t('client::Wipe'),
        mode: t('client::Compare mode'),
        a: t('client::Version on screen'),
        b: t('client::Compare with'),
        swap: t('client::Swap A and B'),
        close: t('client::Close compare'),
      }
    : {
        bar: t('Compare'),
        side: inline ? t('Swipe') : t('Side by side'),
        wipe: t('Wipe'),
        mode: t('Compare mode'),
        a: t('Version'),
        b: t('Compare with'),
        swap: t('Swap A and B'),
        close: t('Close compare'),
      };
  const all: { value: CompareMode; label: string; icon: 'columns' | 'compare' | 'blend' }[] = [
    { value: 'side', label: words.side, icon: 'columns' },
    { value: 'wipe', label: words.wipe, icon: 'compare' },
    { value: 'overlay', label: t('Overlay'), icon: 'blend' },
  ];
  const modes = all.filter((m) => offered.includes(m.value));
  return (
    <div
      className={inline ? 'compare-strip' : 'compare-bar'}
      role="toolbar"
      aria-label={words.bar}
      data-testid="compare-bar"
      data-stacked={stacked || undefined}
    >
      {!inline && (
        <>
          <span className="cmp-side" data-side="a">
            <span className="cmp-tag">A</span>
            {onPickA ? <Select label={words.a} value={String(v)} onChange={(x) => onPickA(Number(x))} options={aOptions} /> : nameOf(v)}
          </span>
          {onSwap ? (
            <IconButton className="btn sm ghost icon-only cmp-swap" label={words.swap} icon="swap" size={14} onClick={onSwap} />
          ) : (
            <span className="cmp-vs">{t('vs')}</span>
          )}
        </>
      )}
      <span className="cmp-side" data-side="b">
        <span className="cmp-tag">B</span>
        <Select label={words.b} value={ab.key} onChange={(key) => setAb({ ...ab, key })} options={options} />
      </span>
      <span className="cmp-sep" />
      {modes.length > 1 && (
        <Segmented
          label={words.mode}
          className="cmp-modes"
          value={ab.mode}
          onChange={(mode) => setAb({ ...ab, mode: mode as CompareMode })}
          options={modes}
          iconOnly={iconModes}
        />
      )}
      {ab.mode === 'overlay' && (
        <>
          <Segmented
            label={t('Overlay')}
            className="cmp-blend"
            value={ab.blend}
            onChange={(blend) => setAb({ ...ab, blend: blend as 'difference' | 'onion' })}
            options={[
              { value: 'difference', label: t('Difference') },
              { value: 'onion', label: t('Onion skin') },
            ]}
          />
          {ab.blend === 'onion' && (
            <Slider label={t('B opacity')} value={Math.round(ab.opacity * 100)} onChange={(x) => setAb({ ...ab, opacity: x / 100 })} className="cmp-opacity" />
          )}
        </>
      )}
      <span className="cmp-sep" />
      <IconButton className="btn sm ghost icon-only cmp-close" label={words.close} shortcut="B" icon="x" size={14} onClick={onClose} />
    </div>
  );
}
