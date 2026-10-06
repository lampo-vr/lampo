// The small facts every library layout shows about a video: open notes, fixes to check, questions, and what the
// client's review link says (shared, opened, by whom). Icons with words or numbers, never colour alone.
import type { StageInfo } from '../../../lib/types.ts';
import type { VideoSummary } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { ago, pct } from '../lib/format.ts';
import { I } from '../ui/icons.tsx';

/** Chips on a poster: open notes (red when one is a must), fixes to check, questions from agents. */
export function PosterChips({ counts }: { counts: VideoSummary['counts'] }) {
  const { open, must, fixed, questions = 0 } = counts;
  return (
    <>
      {open > 0 && (
        <span
          className={`vchip notes ${must ? 'must' : ''}`}
          title={must ? t('{n} open note, {must} must-fix|{n} open notes, {must} must-fix', { n: open, must }) : t('{n} open note|{n} open notes', { n: open })}
        >
          <I name="notes" size={11} /> {open}
        </span>
      )}
      {fixed > 0 && (
        <span className="vchip ok" title={t('{n} fix to check|{n} fixes to check', { n: fixed })}>
          <I name="check" size={11} /> {fixed}
        </span>
      )}
      {questions > 0 && (
        <span
          className="vchip q"
          title={t('{n} question from agents, waiting for your answer|{n} questions from agents, waiting for your answer', { n: questions })}
        >
          <I name="help" size={11} /> {questions}
        </span>
      )}
    </>
  );
}

/**
 * What the review link says while the video waits for the client (the link icon says "shared"): "Link not opened", "V3 not
 * seen yet", "Opened by Mia · 2 h ago". Only views from outside the team count (lib/stage.ts), so "opened" means the
 * client looked.
 */
export function ShareState({ stage }: { stage: StageInfo }) {
  const s = stage.share;
  if (!s || (stage.stage !== 'team_approved' && stage.stage !== 'with_client')) return null;
  const opened = s.by ? t('Opened by {name}', { name: s.by }) : t('Opened');
  // How far they got says more than when. Beside the eye (opened) a card has room for "Mia · 85%"; the tooltip says it
  // in full, with the link and the time.
  const watched = s.opened && s.watched != null ? s.watched : null;
  const who = s.watched_by || s.by;
  const text = s.opened
    ? watched !== null
      ? who
        ? `${who} · ${pct(watched)}`
        : t('{pct} watched', { pct: pct(watched) })
      : s.last_opened
        ? `${opened} · ${ago(s.last_opened)}`
        : opened
    : s.seen_v
      ? t('V{v} not seen yet', { v: stage.v })
      : t('Link not opened');
  const title = [
    watched !== null
      ? who
        ? t('{name} watched {pct} of V{v}', { name: who, pct: pct(watched), v: stage.v })
        : t('{pct} watched', { pct: pct(watched) })
      : null,
    t('Review link “{label}”', { label: s.label }),
    watched !== null && s.last_opened ? ago(s.last_opened) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <span className={`share-state ${s.opened ? 'opened' : ''}`} title={title} data-testid="share-state">
      <I name={s.opened ? 'eye' : 'link'} size={12} />
      <span className="ellipsis">{text}</span>
    </span>
  );
}
