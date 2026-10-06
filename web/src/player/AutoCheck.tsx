// Auto-check: what the machine found in this render before anyone watched it (lib/qa.ts, "pre-review" in the API).
// One chip in the notes panel's head says where it stands — quiet "✓ Auto-check · 5 minor", the problem colour for
// "◆ 2 to check", "Checking…" while it runs, nothing before it has started — and opens the findings in a popover (a
// sheet on a phone): the ones that look like problems first, the minor ones folded, Run again in its head, what the
// spelling check read in its foot. The timeline's diamonds open it on their finding.
// Every finding has one anatomy (findingWords.ts): what was found; where — exact timecodes and a picture of the frame,
// a click plays that stretch (or shows the spot on the frame for text); and, opened, why it was flagged (the limit in
// plain terms) and whether it looks intended or like a problem. Two ways out: "Ask the agent" turns it into a note,
// "That's intended" puts it away on this video for good — later versions too, on the same stretch; no agent hears of it.
import { type CSSProperties, Fragment, useEffect, useRef, useState } from 'react';
import { aboutWholeVideo, stretchOf } from '../../../lib/findings.ts';
import { formatSeconds, rangeSeconds, rangeTimecodes } from '../../../lib/range.ts';
import type { QaKind } from '../../../lib/types.ts';
import { enc } from '../api/client.ts';
import type { FrameRange, QaItem, QaProgress, QaResult } from '../api/types.ts';
import { locale, perLang, t } from '../i18n/index.ts';
import { cardClick } from '../lib/a11y.ts';
import { usePrefs } from '../lib/prefs.ts';
import { Progress } from '../ui/controls.tsx';
import { Spinner } from '../ui/feedback.tsx';
import { I, type IconName } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { Popover, Tip } from '../ui/primitives.tsx';
import { findingWords } from './findingWords.ts';
import { clearRangeHint, setRangeHint } from './rangeHint.ts';

export const AUTO_CHECK_SUMMARY = () =>
  t('Checks every version before you watch: spelling in on-screen text, safe zones, flash and black frames, freezes, loudness and clipping.');

export const FINDING = perLang(
  (): Record<QaKind, { label: string; icon: IconName; about: string }> => ({
    typo: { label: t('Spelling'), icon: 'typo', about: t('Burned-in text read from the frames and spell-checked against the project’s own words') },
    'safe-zone': { label: t('Safe zone'), icon: 'safeZone', about: t('Text or a logo where a platform’s buttons and captions cover the picture') },
    'flash-frame': { label: t('Flash frame'), icon: 'flash', about: t('A single frame that differs from both neighbours: usually a leftover from the edit') },
    'black-frames': { label: t('Black frames'), icon: 'blackFrame', about: t('Frames that are (nearly) black, outside a fade') },
    loudness: { label: t('Loudness'), icon: 'volume', about: t('Integrated loudness or true peak outside the delivery target (EBU R128)') },
    clipping: { label: t('Clipping'), icon: 'wave', about: t('Audio samples at full scale: distortion') },
    silence: { label: t('Silence'), icon: 'mute', about: t('Audio drops out where the picture goes on') },
    freeze: { label: t('Freeze'), icon: 'freeze', about: t('The picture stands still for several frames while it should move') },
  }),
);

/** "de" → "German" (in the viewer's language); the code itself when the browser can't name it. */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(locale(), { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
}

/** Text findings are a spot on a still frame (the box shows on it, paused); everything else plays. */
const isStill = (x: QaItem) => x.kind === 'typo' || x.kind === 'safe-zone';

/** What the check says about the on-screen text it read: what the spell check did with it. */
function spellingLine(spelling: QaResult['spelling'], language: string | null | undefined): string | null {
  if (!spelling) return language ? t('Spelling checked in {languageName}.', { languageName: languageName(language) }) : null;
  if (spelling.state === 'unavailable') return t('Spelling not checked: no text recognition or spell checker on this server.');
  if (!spelling.words) return t('No text on screen to spell-check.');
  if (spelling.state === 'skipped') return t('Spelling not checked: too many unknown words, likely a language without a dictionary here.');
  return language
    ? t('Spelling checked in {languageName}: {n} word of on-screen text.|Spelling checked in {languageName}: {n} words of on-screen text.', {
        languageName: languageName(language),
        n: spelling.words,
      })
    : t('Spelling checked: {n} word of on-screen text.|Spelling checked: {n} words of on-screen text.', { n: spelling.words });
}

interface AutoCheckProps {
  slug: string;
  v: number;
  fps: number;
  /** The picture's width / height (the findings' pictures keep it). */
  aspect: number;
  items: QaItem[] | null;
  pending: boolean;
  /** The check ran and couldn't read this version: said as such (Run again tries once more), never "Checking…". */
  failed?: boolean;
  progress: QaProgress | null;
  timecodeOf: (f: number) => string;
  active?: string;
  /** A finding picked on the timeline: a new number opens the findings on it. */
  asked?: number;
  /** Shows the finding: plays its stretch (`stretch`: one hold of a summary), or the spot on the frame for text. */
  onPlay: (x: QaItem, stretch?: FrameRange) => void;
  /** "Ask the agent": the finding becomes a note (absent: nothing new here, an archived project's video). */
  onAccept?: (x: QaItem) => void;
  /** "That's intended": absent when the role may not (reviewers only turn findings into notes). */
  onIntended?: (x: QaItem) => void;
  onRerun?: () => void;
  language?: string | null;
  spelling?: QaResult['spelling'];
}

/** Where the check stands, as the chip says it: nothing yet, running, problems to look at, minor ones only, clear, or
 * that it couldn't read the version. */
export type AutoCheckState = 'running' | 'problems' | 'minor' | 'clear' | 'failed';

export function AutoCheck(props: AutoCheckProps) {
  const { items, pending, failed, progress, asked } = props;
  const [open, setOpen] = useState(false);
  // a finding picked elsewhere (its diamond on the timeline) opens the findings on it — once the press is over: opened
  // inside the pointerdown, the focus the press then moves off it would close the popover at once
  useEffect(() => {
    if (!asked) return;
    const later = setTimeout(() => setOpen(true));
    return () => clearTimeout(later);
  }, [asked]);
  // the timeline's hover ghost belongs to a finding under the pointer: none once the findings close
  useEffect(() => {
    if (!open) clearRangeHint();
  }, [open]);
  useEffect(() => clearRangeHint, []);
  if (!items && !pending && !failed) return null;
  const list = items || [];
  const main = list.filter((x) => x.severity !== 'nice');
  const minor = list.length - main.length;
  const state: AutoCheckState = pending ? 'running' : failed ? 'failed' : main.length ? 'problems' : minor ? 'minor' : 'clear';
  const pct = progress?.total ? Math.round(((progress.done ?? 0) / progress.total) * 100) : null;
  // the words beside the name (problems stand alone: the count is the news)
  const count =
    state === 'running'
      ? t('Checking…')
      : state === 'problems'
        ? t('{n} to check|{n} to check', { n: main.length })
        : state === 'minor'
          ? t('{n} minor|{n} minor', { n: minor })
          : state === 'failed'
            ? t('Couldn’t read')
            : null;
  const name =
    state === 'running'
      ? pct !== null
        ? t('Auto-check: checking this version, {pct}%', { pct })
        : t('Auto-check: checking this version')
      : state === 'problems'
        ? t('Auto-check: {n} finding to check|Auto-check: {n} findings to check', { n: main.length })
        : state === 'minor'
          ? t('Auto-check: {n} minor finding|Auto-check: {n} minor findings', { n: minor })
          : state === 'failed'
            ? t('Auto-check couldn’t read V{v}', { v: props.v })
            : t('Auto-check: nothing found in V{v}', { v: props.v });
  const chip = (
    <button type="button" className={`ac-chip ${state}`} data-state={state} aria-label={name} data-testid="ac-chip">
      {state === 'running' ? (
        <Spinner />
      ) : state === 'problems' ? (
        <KeyGlyph shape="diamond" size={10} className="ac-chip-kg" />
      ) : state === 'failed' ? (
        <KeyGlyph shape="outline" size={10} className="ac-chip-kg" />
      ) : (
        <I name="fixed" size={14} className="ac-chip-ok" />
      )}
      {state !== 'problems' && <span className="ac-chip-name">{t('Auto-check')}</span>}
      {count && state !== 'problems' && <span className="ac-chip-sep">·</span>}
      {count && <span className="ac-chip-n">{count}</span>}
      {/* the narrowest heads: the number alone, the words in its label */}
      {(state === 'problems' || state === 'minor') && <span className="ac-chip-num">{state === 'problems' ? main.length : minor}</span>}
    </button>
  );
  return (
    <Popover open={open} onOpenChange={setOpen} className="ac-pop" align="end" trigger={<Tip content={AUTO_CHECK_SUMMARY()}>{chip}</Tip>}>
      <AutoCheckFindings {...props} />
    </Popover>
  );
}

/**
 * A finding's picture. Pictures made while someone waits take turns on a server with several teams, a few per team at
 * once (lib/probe.ts ON_DEMAND): a long list's thumbnails, all asked for at once, may hear "busy" for some. Those ask
 * again a moment later, a few times, as a new image (a failed load is never cached).
 */
function FindingPicture({ src }: { src: string }) {
  const [tries, setTries] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!failed || tries >= 4) return;
    const again = setTimeout(
      () => {
        setFailed(false);
        setTries((n) => n + 1);
      },
      2000 * (tries + 1),
    );
    return () => clearTimeout(again);
  }, [failed, tries]);
  return <img key={tries} src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

/** The findings, as the chip's popover shows them. */
function AutoCheckFindings({
  slug,
  v,
  fps,
  aspect,
  items,
  pending,
  failed,
  progress,
  timecodeOf,
  active,
  onPlay,
  onAccept,
  onIntended,
  onRerun,
  language,
  spelling,
}: AutoCheckProps) {
  // the minor findings fold away under the ones that look like problems (with none of those, they are the list)
  const [all, setAll] = useState(false);
  // the finding opened to its why and actions (one at a time)
  const [opened, setOpened] = useState<string | null>(active ?? null);
  // What it checks is said once (this browser), in the foot; after the first results it is the chip's tooltip.
  const [prefs, setPref] = usePrefs('vr.autocheck');
  const [explain] = useState(() => !prefs.seen);
  const done = !!items && !pending;
  // once: setPref is a new function every render (usePrefs), so it can't be what the effect waits on
  const noted = useRef(false);
  useEffect(() => {
    if (!done || !explain || noted.current) return;
    noted.current = true;
    setPref('seen', true);
  });
  // a finding picked elsewhere (its diamond on the timeline) opens here too, a minor one with the minor ones shown
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new pick opens a finding, not new results
  useEffect(() => {
    if (!active) return;
    setOpened(active);
    if (items?.some((x) => x.key === active && x.severity === 'nice')) setAll(true);
  }, [active]);
  const list = items || [];
  const main = list.filter((x) => x.severity !== 'nice');
  const minor = list.filter((x) => x.severity === 'nice');
  const pct = progress?.total ? Math.round(((progress.done ?? 0) / progress.total) * 100) : null;
  const summary = pending
    ? progress?.step
      ? `${progress.step}…`
      : t('Checking this version…')
    : failed
      ? t('Couldn’t read V{v}', { v })
      : main.length
        ? minor.length
          ? t('{n} finding + {minor} minor|{n} findings + {minor} minor', { n: main.length, minor: minor.length })
          : t('{n} finding|{n} findings', { n: main.length })
        : minor.length
          ? t('{n} minor finding|{n} minor findings', { n: minor.length })
          : t('No issues found in V{v}', { v });
  const textLine = done ? spellingLine(spelling, language) : null;
  const named = language ? languageName(language) : null;
  // Where a finding is, in pieces that never break inside — the timecodes, the length, the rest — so a narrow card
  // wraps between them (under the kind first, then the length under the timecodes), never into its padding.
  const where = (x: QaItem): string[] => {
    if (aboutWholeVideo(x)) return [t('Whole video')];
    const r = stretchOf(x);
    if (!r) return [timecodeOf(x.frame)];
    const more = x.holds && x.holds.length > 1 ? [t('· and {n} more', { n: x.holds.length - 1 })] : [];
    return r.out > r.in ? [rangeTimecodes(r, fps), `· ${formatSeconds(rangeSeconds(r, fps))}`, ...more] : [timecodeOf(r.in), ...more];
  };
  const show = (x: QaItem, stretch?: FrameRange) => {
    setOpened(x.key);
    onPlay(x, stretch);
  };
  const row = (x: QaItem) => {
    const f = FINDING()[x.kind as QaKind] || { label: x.kind, icon: 'autoCheck' as IconName, about: '' };
    const w = findingWords(x, fps, named);
    const stretch = stretchOf(x);
    const isOpen = opened === x.key;
    const plays = !!stretch && !isStill(x);
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: the picture is the keyboard's way in (a button that does the same)
      <li
        key={x.key}
        className={`ac-row sev-${x.severity} ${isOpen ? 'open' : ''} ${active === x.key ? 'active' : ''}`}
        data-kind={x.kind}
        data-key={x.key}
        data-likely={w.verdict ?? undefined}
        onClick={cardClick(() => show(x), '.ac-acts, .ac-holds, .ac-thumb')}
        onPointerEnter={() => stretch && setRangeHint({ ghost: stretch })}
        onPointerLeave={() => setRangeHint({ ghost: null })}
      >
        <button
          type="button"
          className="ac-thumb"
          style={{ '--ar': aspect } as CSSProperties}
          onClick={() => show(x)}
          aria-label={
            plays
              ? t('Play {label} at {where}', { label: f.label, where: where(x).join(' ') })
              : t('Show {label} at {where}', { label: f.label, where: where(x).join(' ') })
          }
          aria-expanded={isOpen}
          data-testid="ac-play"
        >
          {stretch ? <FindingPicture src={`/api/review/${enc(slug)}/frame?v=${v}&frame=${stretch.in}&size=thumb`} /> : <I name={f.icon} size={18} />}
          {plays && (
            <span className="ac-thumb-play" aria-hidden="true">
              <I name="play" size={11} />
            </span>
          )}
        </button>
        <div className="ac-main">
          <span className="ac-line">
            <Tip content={f.about}>
              <span className="ac-label" data-severity={x.severity}>
                <I name={f.icon} size={12} />
                {f.label}
              </span>
            </Tip>
            <span className="ac-where">
              {/* the spaces read in its text; on screen the gap keeps the pieces apart */}
              {where(x).map((part, i) => (
                <Fragment key={part}>
                  {i > 0 && ' '}
                  <span>{part}</span>
                </Fragment>
              ))}
            </span>
          </span>
          <span className="ac-what">{w.what}</span>
          {w.quote && <q className="ac-quote">{w.quote}</q>}
          {(w.verdict || (isOpen && w.reason)) && (
            <span className={`ac-verdict ${w.verdict ?? 'unsure'}`} data-testid="ac-verdict">
              {w.verdict && <KeyGlyph shape={w.verdict === 'problem' ? 'diamond' : 'hold'} size={9} />}
              {isOpen && w.reason ? w.reason : w.verdict === 'problem' ? t('Looks like a problem') : t('Looks intended')}
            </span>
          )}
          {isOpen && (
            <>
              {w.why && (
                <span className="ac-why" data-testid="ac-why">
                  {w.why}
                </span>
              )}
              {x.holds && x.holds.length > 1 && (
                <span className="ac-holds">
                  {x.holds.map((h) => (
                    <button key={h.in} type="button" className="c-tc" onClick={() => show(x, h)}>
                      {timecodeOf(h.in)}
                    </button>
                  ))}
                </span>
              )}
              <span className="ac-acts">
                {onAccept && (
                  <Tip content={t('Turns it into a note for the agent to fix')}>
                    <button type="button" className={`btn sm ${w.verdict === 'intended' ? 'ghost' : ''}`} onClick={() => onAccept(x)}>
                      <I name="plus" size={13} /> {t('Ask the agent')}
                    </button>
                  </Tip>
                )}
                {onIntended && (
                  <Tip content={t('Auto-check won’t list it again on this video, not in later versions either. The agent isn’t told.')}>
                    <button
                      type="button"
                      className={`btn sm ${w.verdict === 'intended' ? '' : 'ghost'}`}
                      onClick={() => onIntended(x)}
                      data-testid="ac-intended"
                    >
                      <I name="check" size={13} /> {t('That’s intended')}
                    </button>
                  </Tip>
                )}
              </span>
            </>
          )}
        </div>
      </li>
    );
  };
  return (
    <section className={`autocheck ${pending ? 'running' : failed ? 'failed' : list.length ? 'found' : 'clear'}`} aria-label={t('Auto-check')}>
      <header className="ac-pop-head">
        <I name={!pending && !failed && !list.length ? 'fixed' : 'autoCheck'} size={15} className="ac-icon" />
        <b>{t('Auto-check')}</b>
        <span className="ac-summary">{summary}</span>
        {onRerun && !pending && (
          <button type="button" className="btn sm ghost ac-rerun" onClick={onRerun}>
            <I name="refresh" size={13} /> {t('Run again')}
          </button>
        )}
      </header>
      <div className="ac-body">
        {pending && <Progress value={pct} label={t('Auto-check progress')} tone="claude" />}
        {main.length > 0 && <ul className="ac-list">{main.map(row)}</ul>}
        {/* the fold only under findings that look like problems: alone, the minor ones are the list */}
        {minor.length > 0 && main.length > 0 && (
          <button type="button" className="ac-more" onClick={() => setAll(!all)} aria-expanded={all}>
            <I name="right" size={12} className={`ac-more-chev ${all ? 'open' : ''}`} />
            {t('{n} minor finding|{n} minor findings', { n: minor.length })}
          </button>
        )}
        {(all || !main.length) && minor.length > 0 && <ul className="ac-list minor">{minor.map(row)}</ul>}
        {!pending && failed && (
          <p className="ac-clear ac-failed" data-testid="ac-failed">
            {t('Auto-check couldn’t read this version’s file, so nothing was checked. Playing it and its notes aren’t affected.')}
          </p>
        )}
        {!pending && !failed && !list.length && <p className="ac-clear">{t('Nothing to fix. Watch it for everything a machine can’t judge.')}</p>}
      </div>
      {!pending && (explain || textLine) && (
        <p className="ac-about">
          {explain && `${AUTO_CHECK_SUMMARY()} `}
          {textLine}
        </p>
      )}
    </section>
  );
}
