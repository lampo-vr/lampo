// Verify mode: one fixed note at a time, before/after side by side. Y looks right · N still wrong · S skip. A fix that
// exists only as a preview (made in the project, not rendered yet) is checked against the render at that frame, and
// "Looks good" then means "on the preview": the next render is compared with it automatically.

import { useEffect, useState } from 'react';
import { formatSeconds, rangeSeconds, rangeTimecodes } from '../../../lib/range.ts';
import type { FixPreview, PlacedComment } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { T } from '../i18n/T.tsx';
import { severityLabel } from '../i18n/terms.ts';
import { ago } from '../lib/format.ts';
import { Badge, type Tone } from '../ui/Badge.tsx';
import { I } from '../ui/icons.tsx';
import { IconButton, Kbd, Segmented } from '../ui/primitives.tsx';
import { CheckDecision } from './CheckDecision.tsx';
import { clientOf, displayName, WordsChange } from './CommentCard.tsx';
import { previewSource } from './previews.ts';

interface VerifyPanelProps {
  item: PlacedComment;
  index: number;
  total: number;
  before: number | null;
  after: number;
  busy: boolean;
  onVerify: () => void;
  onReopen: (note: string) => void;
  onSkip: () => void;
  onExit: () => void;
  /** Phones: before and after are stacked on the stage; this toggles which one shows (a swipe does too). */
  side?: 'before' | 'after';
  onSide?: (side: 'before' | 'after') => void;
  /** The fix preview being checked instead of a render, if any. */
  preview?: { p: FixPreview; url: string } | null;
  onVerifyPreview?: () => void;
  previewMode?: 'side' | 'wipe';
  onPreviewMode?: (mode: 'side' | 'wipe') => void;
  /** A range note: the frame rate (its duration) and playing the whole range, before and after in step. */
  fps?: number;
  onPlayRange?: () => void;
}

export function VerifyPanel({
  item,
  index,
  total,
  before,
  after,
  onVerify,
  onReopen,
  onSkip,
  onExit,
  busy,
  side,
  onSide,
  preview = null,
  onVerifyPreview,
  previewMode = 'side',
  onPreviewMode,
  fps,
  onPlayRange,
}: VerifyPanelProps) {
  const [reopening, setReopening] = useState(false);
  const yes = preview && onVerifyPreview ? onVerifyPreview : onVerify;
  // biome-ignore lint/correctness/useExhaustiveDependencies: close the form whenever the panel moves to another note
  useEffect(() => {
    setReopening(false);
  }, [item.id]);
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      // not from inside a dialog (the inbox over the player, help), a menu or a list: their keys are their own; a held
      // key repeats, which would verify fixes nobody looked at
      if ((e.target as Element | null)?.closest?.('input, textarea, [role=dialog], [role=menu], [role=listbox]') || e.metaKey || e.ctrlKey) return;
      // the reason is being given (typed or said: the focus may be on its microphone): Y must not verify meanwhile
      if (e.repeat || (e.target as Element | null)?.closest?.('.verify-reason')) return;
      if (e.key === 'y' || e.key === 'Y') {
        e.preventDefault();
        yes();
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        setReopening(true);
      } else if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        onSkip();
      }
    };
    window.addEventListener('keydown', f, true);
    return () => window.removeEventListener('keydown', f, true);
  }, [yes, onSkip]);
  const fix = [...(item.replies || [])].reverse().find((r) => r.status === 'fixed');
  const source = preview && previewSource(preview.p);
  return (
    <div className="verify grain">
      <div className="verify-head">
        <span className="eyebrow">
          {t('Check')} {index + 1} / {total}
        </span>
        <Badge size="sm" tone={item.severity as Tone}>
          {severityLabel(item.severity)}
        </Badge>
        {item.rangeHere && fps ? (
          <span className="note-range">
            <span className="c-tc range">
              {rangeTimecodes(item.rangeHere, fps)}
              <span className="note-range-len">{formatSeconds(rangeSeconds(item.rangeHere, fps))}</span>
            </span>
            {onPlayRange && (
              <IconButton
                className="btn sm ghost icon-only"
                label={t('Play the whole range, before and after')}
                icon="play"
                size={12}
                onClick={onPlayRange}
                data-testid="verify-range-play"
              />
            )}
          </span>
        ) : (
          <span className="c-tc">{item.timecodeHere}</span>
        )}
        {preview ? (
          <span className="eyebrow">{t('V{after} → fix preview', { after })}</span>
        ) : (
          before && (
            <span className="eyebrow">
              V{before} → V{after}
            </span>
          )
        )}
        <span className="grow" />
        <button type="button" className="btn ghost sm" onClick={onExit}>
          <T k={'Done <0>Esc</0>'} tags={[(c) => <Kbd>{c}</Kbd>]} />
        </button>
      </div>
      {side && onSide && (
        <Segmented
          label={t('Show before or after')}
          className="verify-side"
          value={side}
          onChange={(x) => onSide(x as 'before' | 'after')}
          options={[
            { value: 'before', label: preview ? t('Now · V{after}', { after }) : before ? t('Before · V{before}', { before }) : t('Before') },
            { value: 'after', label: preview ? t('Fix preview') : t('After · V{after}', { after }) },
          ]}
        />
      )}
      <div className="verify-body">
        {item.text_edit && <WordsChange edit={item.text_edit} />}
        {(item.text || !item.text_edit) && <div className="c-text">{item.text || t('(marked frame)')}</div>}
        {preview ? (
          <div className="verify-preview" data-testid="verify-preview">
            <I name="eye" size={14} />
            <span className="grow">
              <b>
                {preview.p.kind === 'clip' ? t('A clip of the fix, not rendered yet') : t('A still of the fix, not rendered yet')}
                {source ? ` · ${source}` : ''}
              </b>
              <span>
                {t('by {displayName} · {ago}. Looks right now, and the next version is compared with it by itself.', {
                  displayName: displayName(preview.p.by),
                  ago: ago(preview.p.at),
                })}
              </span>
            </span>
            {onPreviewMode && (
              <Segmented
                label={t('Compare the version and the preview')}
                value={previewMode}
                onChange={(m) => onPreviewMode(m as 'side' | 'wipe')}
                options={[
                  { value: 'side', label: t('Side by side'), icon: 'columns' },
                  { value: 'wipe', label: t('Wipe'), icon: 'compare' },
                ]}
              />
            )}
          </div>
        ) : fix ? (
          <div className="c-note fix">
            <b>
              <I name="fixed" size={12} />
              {t('{displayName} · fixed in V{fixed_in_v}', { displayName: displayName(fix.by), fixed_in_v: fix.fixed_in_v })}
            </b>
            {fix.text && <span>{fix.text}</span>}
          </div>
        ) : (
          item.check_again && <div className="banner check">{t('Carried to V{carried_to}: is it still there?', { carried_to: item.carried_to })}</div>
        )}
        {preview && fix?.text && <div className="c-note fix">{fix.text}</div>}
      </div>
      {/* the decision (CheckDecision.tsx), with its keys and Skip: while check mode runs, only here (the note's card in the panel shows where it stands) */}
      <CheckDecision
        id={item.id}
        keys
        fixed={item.status === 'fixed'}
        busy={busy}
        onRight={yes}
        onWrong={onReopen}
        reopening={reopening}
        onReopening={setReopening}
        client={clientOf(item.author)}
        rightLabel={preview ? t('Looks right (preview)') : undefined}
      >
        <span className="grow" />
        <button type="button" className="btn ghost sm" onClick={onSkip}>
          {t('Skip')} <Kbd>S</Kbd>
        </button>
      </CheckDecision>
    </div>
  );
}
