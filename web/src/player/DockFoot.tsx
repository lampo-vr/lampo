// Under the timeline: what changed since the previous version, loudness, freezes, and who watched.

import { FREEZE } from '../../../lib/findings.ts';
import type { Analysis, Diff, FreezeRange, VideoAudience, Waveform } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { T } from '../i18n/T.tsx';
import { useScrollEdges } from '../lib/hooks.ts';
import { Spinner } from '../ui/feedback.tsx';
import { I } from '../ui/icons.tsx';
import { Tip } from '../ui/primitives.tsx';
import { ViewersChip } from './Viewers.tsx';

interface DockFootProps {
  analysis: Analysis | undefined;
  wave: Waveform | undefined;
  freezes: FreezeRange[];
  /** Holds Auto-check lists as looking like a problem; null until it has said. */
  flaggedFreezes?: number | null;
  v: number;
  diff: Diff | null;
  diffPending: boolean;
  onNextFreeze: () => void;
  onNextChange: () => void;
  onPlayChanges: () => void;
  onHelp: () => void;
  /** Who watched the video (the chip shows once anyone has); `band` = the viewers band is on the timeline. */
  audience?: VideoAudience | null;
  band?: boolean;
  onBand?: () => void;
  /** An archived project's video: no note is written here, so the keys don't offer one. */
  readOnly?: boolean;
}

export function DockFoot({
  analysis,
  wave,
  freezes,
  flaggedFreezes = null,
  v,
  diff,
  diffPending,
  onNextFreeze,
  onNextChange,
  onPlayChanges,
  onHelp,
  audience = null,
  band = false,
  onBand,
  readOnly = false,
}: DockFootProps) {
  const loud = analysis?.loudness;
  // a phone scrolls this row sideways: a soft edge where there is more, never a chip cut off at the screen's edge
  const [edgesRef, edges] = useScrollEdges<HTMLDivElement>();
  return (
    <div ref={edgesRef} className={`dock-foot ${edges}`}>
      {/* what changed since the version before first: the analysis' chips settle last (a freeze's verdict waits for
          Auto-check), and standing after it they move nothing when their words arrive (Δ slid 18 px, then 70) */}
      {v > 1 &&
        (diff?.incomparable ? (
          <span className="badge">
            {t('Δ not comparable to V')}
            {v - 1}
          </span>
        ) : diff ? (
          diff.summary.identical ? (
            <span className="badge ok">{t('Δ identical to V{v}', { v: diff.old.v })}</span>
          ) : (
            <>
              <Tip content={t('Jump to the next change (⇧D: the previous one)')} shortcut="D">
                <button type="button" className="badge delta" onClick={onNextChange}>
                  {t('Δ vs V{v} · {n} change|Δ vs V{v} · {n} changes', { v: diff.old.v, n: diff.summary.changes })}
                  {diff.summary.changed_seconds ? ` · ${diff.summary.changed_seconds}s` : ''}
                  {diff.summary.audio_changes ? t(' · {audio_changes} audio', { audio_changes: diff.summary.audio_changes }) : ''}
                  {diff.summary.retimes ? t(' · {n} retime| · {n} retimes', { n: diff.summary.retimes }) : ''}
                </button>
              </Tip>
              <Tip content={t('Play only what changed, with 0.6 s around each change')}>
                <button type="button" className="badge delta" onClick={onPlayChanges}>
                  <I name="play" size={10} /> {t('Play changes')}
                </button>
              </Tip>
            </>
          )
        ) : diffPending ? (
          <span className="row muted">
            <Spinner /> {t('comparing with V')}
            {v - 1}…
          </span>
        ) : null)}
      {loud ? (
        <Tip content={loud.lra != null ? `${t('Integrated loudness (EBU R128)')} · LRA ${loud.lra} LU` : t('Integrated loudness (EBU R128)')}>
          <span className={`badge ${(loud.true_peak ?? -99) > -1 ? 'danger' : ''}`}>
            <I name="wave" size={13} /> {loud.lufs?.toFixed(1)} {t('LUFS · TP')} {loud.true_peak?.toFixed(1)} {t('dBTP')}
          </span>
        </Tip>
      ) : analysis?.pending ? (
        <span className="row muted">
          <Spinner /> {t('analysing loudness and freezes…')}
        </span>
      ) : wave && !wave.audio ? (
        <span className="badge">{t('no audio')}</span>
      ) : null}
      {analysis?.freezes && <FreezeChip freezes={freezes} flagged={flaggedFreezes} v={v} onNext={onNextFreeze} />}
      {audience && onBand && <ViewersChip audience={audience} v={v} band={band} onBand={onBand} />}
      <span className="grow" />
      <Tip content={t('All keyboard shortcuts')} shortcut="?">
        <button type="button" className="hint muted hide-sm" onClick={onHelp}>
          {readOnly ? (
            <T
              k={'<0>←</0><1>→</1> frame <2>I</2><3>O</3> section <4>?</4> all keys'}
              tags={[(c) => <kbd>{c}</kbd>, (c) => <kbd>{c}</kbd>, (c) => <kbd>{c}</kbd>, (c) => <kbd>{c}</kbd>, (c) => <kbd>{c}</kbd>]}
            />
          ) : (
            <T
              k={'<0>C</0> note <1>←</1><2>→</2> frame <3>I</3><4>O</4> section <5>?</5> all keys'}
              tags={[(c) => <kbd>{c}</kbd>, (c) => <kbd>{c}</kbd>, (c) => <kbd>{c}</kbd>, (c) => <kbd>{c}</kbd>, (c) => <kbd>{c}</kbd>, (c) => <kbd>{c}</kbd>]}
            />
          )}
        </button>
      </Tip>
    </div>
  );
}

/**
 * Where the picture stands still (3 frames or more, lib/findings.ts FREEZE), said so it agrees with Auto-check: in the
 * must colour only when Auto-check lists a hold as looking like a problem; an end card, a title or a pause is fine.
 * The tooltip says what it counts; a click goes to the next hold.
 */
function FreezeChip({ freezes, flagged, v, onNext }: { freezes: FreezeRange[]; flagged: number | null; v: number; onNext: () => void }) {
  const n = freezes.length;
  const what = t('Freezes: where the picture in V{v} stands still for {min} frames or more.', { v, min: FREEZE.minFrames });
  const tip = !n
    ? t('No freezes: nothing in V{v} stands still for {min} frames or more.', { v, min: FREEZE.minFrames })
    : `${what} ${
        flagged == null
          ? t('Auto-check is still deciding which look intended.')
          : flagged
            ? t('Auto-check lists {k} as looking like a problem; end cards, titles and pauses look intended.', { k: flagged })
            : t('None looks like a problem to Auto-check: end cards, titles and pauses look intended.')
      } ${t('Click: the next one.')}`;
  return (
    <Tip content={tip}>
      <button
        type="button"
        className={`badge ${!n ? 'ok' : flagged ? 'danger' : ''}`}
        style={{ border: 0, cursor: n ? 'pointer' : 'default' }}
        onClick={onNext}
        data-testid="freeze-chip"
      >
        <I name="freeze" size={13} />{' '}
        {!n
          ? t('no freezes')
          : flagged
            ? t('{n} freeze · {k} to check|{n} freezes · {k} to check', { n, k: flagged })
            : flagged === 0
              ? t('{n} freeze · looks intended|{n} freezes · look intended', { n })
              : t('{n} freeze|{n} freezes', { n })}
      </button>
    </Tip>
  );
}
