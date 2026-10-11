// Check mode: one fixed note at a time, before/after side by side. Y looks right · N still wrong · S skip. A fix that
// exists only as a preview (made in the project, not rendered yet) is checked against the render at that frame, and
// "Looks good" then means "on the preview": the next render is compared with it automatically.
//
// The card reads in one order: what is being checked — the note, in the words of whoever wrote it — then how it was
// answered (the agent's mark, its name, "fixed in V2" and its own words, quieter and clamped), then the decision. It
// floats in the stage's own material (the review HUD's and the compare bar's) at the foot of the stage, which keeps
// its room free (`onRoom`), so the before and after aren't covered; on a phone it is the notes sheet's content. Colour
// marks a state only: the severity's glyph, the small ✓ of the fix (styles/check.css).

import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { agentKindOf } from '../../../lib/agentKind.ts';
import { formatSeconds, rangeSeconds, rangeTimecodes } from '../../../lib/range.ts';
import { isAgent } from '../../../lib/time.ts';
import { usePeople } from '../api/auth.ts';
import type { FixPreview, PlacedComment } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { T } from '../i18n/T.tsx';
import { severityLabel } from '../i18n/terms.ts';
import { ago } from '../lib/format.ts';
import { Badge, type Tone } from '../ui/Badge.tsx';
import { AgentMark, I } from '../ui/icons.tsx';
import { Avatar } from '../ui/plain.tsx';
import { IconButton, Kbd, Segmented } from '../ui/primitives.tsx';
import { CheckDecision } from './CheckDecision.tsx';
import { clientOf, displayName, WordsChange } from './CommentCard.tsx';
import { lastStillWrong } from './fixCheck.ts';
import { previewSource } from './previews.ts';
import '../styles/check.css';

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
  /** The card's height as it rests (its long words folded): the stage keeps that much free under the pictures. */
  onRoom?: (px: number) => void;
  /** Still wrong's reason is being given: the version being checked takes a drawing meanwhile (Player.tsx). */
  onReopening?: (on: boolean) => void;
  /** The version Still wrong can be drawn on (the one being checked), and how many marks are on it so far. */
  drawOn?: number | null;
  drawn?: number;
}

/** Up to this many fixes are dots in the head; more are only counted. */
const MAX_DOTS = 12;

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
  onRoom,
  onReopening,
  drawOn = null,
  drawn = 0,
}: VerifyPanelProps) {
  const [reopening, setReopening] = useState(false);
  // the stage hears when the reason is being given (the picture takes a drawing then), and that it ended with the card
  const told = useRef(onReopening);
  told.current = onReopening;
  useEffect(() => {
    told.current?.(reopening);
  }, [reopening]);
  useEffect(() => () => told.current?.(false), []);
  // a long text unfolded ("More"): the card grows upwards from its foot, so the decision stays where it was
  const [open, setOpen] = useState(false);
  const yes = preview && onVerifyPreview ? onVerifyPreview : onVerify;
  // biome-ignore lint/correctness/useExhaustiveDependencies: close the form and fold the words whenever the panel moves to another note
  useEffect(() => {
    setReopening(false);
    setOpen(false);
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
  // the room the card takes as it rests (not while its words are unfolded: it grows over the pictures then, briefly)
  const card = useRef<HTMLElement>(null);
  const room = useRef(onRoom);
  room.current = onRoom;
  useLayoutEffect(() => {
    const el = card.current;
    if (!el || open || !room.current) return;
    const tell = () => room.current?.(Math.ceil(el.getBoundingClientRect().height));
    tell();
    const ro = new ResizeObserver(tell);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);
  const fix = [...(item.replies || [])].reverse().find((r) => r.status === 'fixed');
  // the last time it was found still wrong (on V2, say): read before the new answer, so the history reads in order
  const wrong = preview ? null : lastStillWrong(item);
  const wrongWords = wrong && wrong.reply.text !== t('Still wrong in V{latestV}.', { latestV: wrong.v }) ? wrong.reply.text : '';
  const source = preview && previewSource(preview.p);
  const avatarOf = usePeople();
  // which words are cut where they rest, and the one "More" that unfolds them all
  const [noteCut, setNoteCut] = useState(false);
  const [fixCut, setFixCut] = useState(false);
  const moreInFix = !preview && !!fix && (noteCut || fixCut);
  const more = (
    <button type="button" className="verify-more" onClick={() => setOpen(!open)} aria-expanded={open} data-testid="verify-more">
      {open ? t('Less') : t('More')}
    </button>
  );
  return (
    <section ref={card} className="verify" data-testid="verify-card" aria-label={t('Check {n} of {total}', { n: index + 1, total })}>
      <header className="verify-head">
        <span className="verify-step" data-testid="verify-step">
          {t('Check {n} of {total}', { n: index + 1, total })}
          {total > 1 && total <= MAX_DOTS && (
            <span className="verify-dots" aria-hidden="true">
              {Array.from({ length: total }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the dots are places, nothing else
                <i key={i} className={i === index ? 'on' : undefined} />
              ))}
            </span>
          )}
        </span>
        <span className="verify-meta" data-testid="verify-meta">
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
            <span className="verify-vs">{t('V{after} → fix preview', { after })}</span>
          ) : (
            before && (
              <span className="verify-vs">
                V{before} → V{after}
              </span>
            )
          )}
        </span>
        <span className="grow" />
        <button type="button" className="btn ghost sm" onClick={onExit} data-testid="verify-done">
          <T k={'Done <0>Esc</0>'} tags={[(c) => <Kbd>{c}</Kbd>]} />
        </button>
      </header>
      {/* what is being checked, in the words of whoever wrote it: first, and in the reading size */}
      <div className="verify-note" data-testid="verify-note">
        {item.text_edit && <WordsChange edit={item.text_edit} />}
        {(item.text || !item.text_edit) && (
          <Folded lines={3} open={open} onCut={setNoteCut} className="verify-note-text">
            {item.text || t('(marked frame)')}
          </Folded>
        )}
        {noteCut && !moreInFix && more}
      </div>
      {/* what was said last time, quietly: "Still wrong in V2 · drawn on it · “touches the logo”" (what it is compared with) */}
      {wrong && (
        <p className="verify-was" data-testid="verify-was">
          <I name="x" size={12} />
          <span className="ellipsis">
            <b>{t('Still wrong in V{v}', { v: wrong.v })}</b>
            {wrong.reply.drawing?.length ? ` · ${t('drawn on it')}` : ''}
            {wrongWords ? ` · “${wrongWords}”` : ''}
          </span>
        </p>
      )}
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
        // how it was answered: second, quieter — the agent's mark and name, "fixed in V2" with the one green mark
        <div className="verify-fix" data-testid="verify-fix">
          <div className="verify-fix-head">
            {isAgent(fix.by) ? <AgentMark kind={agentKindOf(displayName(fix.by))} size={14} /> : <Avatar name={fix.by} size={16} src={avatarOf(fix.by)} />}
            <b className="ellipsis" data-testid="verify-fix-by">
              {displayName(fix.by)}
            </b>
            <span className="verify-fix-done">
              <I name="fixed" size={12} />
              {t('fixed in V{v}', { v: item.fixed_in_v ?? fix.fixed_in_v ?? after })}
            </span>
            {/* one "More" for the card's long words, at the end of this line: it takes no line of its own */}
            {moreInFix && (
              <>
                <span className="grow" />
                {more}
              </>
            )}
          </div>
          {fix.text && (
            <Folded lines={3} open={open} onCut={setFixCut} className="verify-fix-text">
              {fix.text}
            </Folded>
          )}
        </div>
      ) : (
        item.check_again && (
          <div className="verify-again" data-testid="verify-again">
            <I name="refresh" size={12} />
            {t('Carried to V{carried_to}: is it still there?', { carried_to: item.carried_to })}
          </div>
        )
      )}
      {preview && fix?.text && (
        <div className="verify-fix" data-testid="verify-fix">
          <Folded lines={3} open={open} onCut={setFixCut} className="verify-fix-text">
            {fix.text}
          </Folded>
        </div>
      )}
      {/* a phone's stacked stage: which picture shows, by the decision it is for (the words above it come first) */}
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
      {/* the decision (CheckDecision.tsx), with its keys and Skip: while check mode runs, only here (the note's card in the panel shows where it stands) */}
      <CheckDecision
        id={item.id}
        keys
        primary
        fixed={item.status === 'fixed'}
        busy={busy}
        onRight={yes}
        onWrong={onReopen}
        reopening={reopening}
        onReopening={setReopening}
        client={clientOf(item.author)}
        rightLabel={preview ? t('Looks right (preview)') : undefined}
        drawOn={preview ? null : drawOn}
        drawn={drawn}
      >
        <span className="grow" />
        <button type="button" className="btn ghost sm" onClick={onSkip} data-testid="verify-skip">
          {t('Skip')} <Kbd>S</Kbd>
        </button>
      </CheckDecision>
    </section>
  );
}

/**
 * Words folded to a few lines while the card rests (`open` unfolds them). Measured, not guessed: `onCut` says whether
 * they really are cut, so "More" is there only then (the card places it).
 */
function Folded({
  lines,
  open,
  onCut,
  className,
  children,
}: {
  lines: number;
  open: boolean;
  onCut: (cut: boolean) => void;
  className: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  const cut = useRef(onCut);
  cut.current = onCut;
  useLayoutEffect(() => {
    const el = ref.current;
    // unfolded, it stays as cut as it was folded: "Less" folds it again
    if (!el || open) return;
    const look = () => cut.current(el.scrollHeight > el.clientHeight + 1);
    look();
    const ro = new ResizeObserver(look);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);
  return (
    <p ref={ref} className={`${className} folded${open ? ' open' : ''}`} style={{ WebkitLineClamp: open ? 'unset' : lines }}>
      {children}
    </p>
  );
}
