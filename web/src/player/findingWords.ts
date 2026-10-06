// Auto-check's findings in words (player/AutoCheck.tsx), one anatomy for every kind: what was found, why it was
// flagged (the limit in plain terms, the very numbers lib/qa.ts used — lib/findings.ts), and what the guess "looks
// intended" or "looks like a problem" rests on. Built from the finding's fields, so it reads in the viewer's language;
// a result from before those fields existed falls back to the check's own English sentence.
import { FREEZE, LIMITS, listFrames } from '../../../lib/findings.ts';
import { formatSeconds, rangeFrames } from '../../../lib/range.ts';
import type { FrameRange, QaItem } from '../api/types.ts';
import { locale, t } from '../i18n/index.ts';

export interface FindingWords {
  /** What was found, in one sentence. */
  what: string;
  /** Why it was flagged: the limit it crossed. */
  why: string;
  /** Auto-check's guess, or null when it can't tell. */
  verdict: 'intended' | 'problem' | null;
  /** What the guess rests on (or why it can't tell); null when there is nothing to say. */
  reason: string | null;
  /** The line of on-screen text it is in (spelling, safe zones). */
  quote?: string;
}

const secs = (frames: number, fps: number) => formatSeconds(frames / fps);
const num = (n: number) => n.toLocaleString(locale(), { maximumFractionDigits: 1 }).replace('-', '−');

/** About a hold that stands for one stretch: the threshold in frames and seconds at this frame rate. */
const stillWhy = (r: FrameRange, fps: number) =>
  t('Nothing moved for {n} frames ({s}). Auto-check flags still stretches from {min} frames ({minS}) inside the video.', {
    n: rangeFrames(r),
    s: secs(rangeFrames(r), fps),
    min: listFrames(fps),
    minS: secs(listFrames(fps), fps),
  });

function freezeWords(x: QaItem, fps: number): FindingWords {
  if (x.key === 'freeze:short' && x.holds?.length) {
    const sizes = x.holds.map(rangeFrames);
    const lo = Math.min(...sizes);
    const hi = Math.max(...sizes);
    return {
      what:
        x.holds.length === 1
          ? t('The same frame shows {count} times in a row', { count: lo })
          : t('Frames repeat in {count} places, {lo}–{hi} at a time', { count: x.holds.length, lo, hi }),
      why: t('{min} or more identical frames in a row: too short for a pause (those start at {list} frames), so it reads as a hitch.', {
        min: FREEZE.minFrames,
        list: listFrames(fps),
      }),
      verdict: 'problem',
      reason: t('Looks like a problem: rendering and frame-rate conversion repeat frames, and in motion you see the hitch.'),
    };
  }
  if (x.key === 'freeze:holds' && x.holds?.length) {
    const lo = secs(Math.min(...x.holds.map(rangeFrames)), fps);
    const hi = secs(Math.max(...x.holds.map(rangeFrames)), fps);
    return {
      what:
        lo === hi
          ? t('The picture holds still {count} times, {s} each', { count: x.holds.length, s: lo })
          : t('The picture holds still {count} times, {lo} to {hi} each', { count: x.holds.length, lo, hi }),
      why: t('More than {many} still stretches in one video are listed together, not one by one.', { many: FREEZE.many }),
      verdict: 'intended',
      reason: t('Looks intended: this many pauses usually means motion graphics or a screen recording that pause on purpose.'),
    };
  }
  const r = x.range ?? { in: x.frame, out: x.frame };
  const s = secs(rangeFrames(r), fps);
  const why = stillWhy(r, fps);
  switch (x.why) {
    case 'sound-continues':
      return {
        what: t('The picture stops for {s} while the sound goes on', { s }),
        why,
        verdict: 'problem',
        reason: t(
          'Looks like a problem: the motion stops dead or jumps ahead after it while the sound carries on, so frames are likely missing or rendering stalled.',
        ),
      };
    case 'mid-shot':
      return {
        what: t('The picture stops for {s} in the middle of a moving shot', { s }),
        why,
        verdict: 'problem',
        reason: t('Looks like a problem: the motion stops dead or jumps ahead after it, so frames are likely missing or rendering stalled.'),
      };
    case 'eased':
      return {
        what: t('The motion comes to rest for {s}', { s }),
        why,
        verdict: 'intended',
        reason: t('Looks intended: the motion slows into it and goes on without a jump, as animation settles. A stall stops dead or jumps ahead.'),
      };
    case 'still-before':
      return {
        what: t('The picture stays still for {s}', { s }),
        why,
        verdict: 'intended',
        reason: t('Looks intended: nothing was moving just before it, so nothing stops dead or jumps ahead: a pause, not a stall.'),
      };
    case 'pause':
      return {
        what: t('The picture rests for {s} while the sound pauses', { s }),
        why,
        verdict: 'intended',
        reason: t('Looks intended: picture and sound pause together, like a beat.'),
      };
    case 'held-shot':
      return {
        what: t('The shot holds still for {s} from its first frame', { s }),
        why,
        verdict: 'intended',
        reason: t('Looks intended: the shot is still from its first frame, like a title, a photo or a held shot.'),
      };
    default:
      return { what: t('The picture stands still for {s}', { s }), why, verdict: null, reason: null };
  }
}

const ZONE: Record<string, () => string> = {
  'ig-icons': () => t('Text sits under Instagram’s buttons on the right'),
  'ig-caption': () => t('Text sits under Instagram’s caption'),
  'ig-topbar': () => t('Text sits under Instagram’s top bar'),
  'ig-crop': () => t('Text is cut off in the profile grid’s cropped preview'),
};

/** The words for one finding. `language`: the on-screen text's language as Auto-check read it (ISO 639-1), named. */
export function findingWords(x: QaItem, fps: number, languageName?: string | null): FindingWords {
  const r = x.range ?? { in: x.frame, out: x.frame };
  const n = rangeFrames(r);
  switch (x.kind) {
    case 'freeze':
      return freezeWords(x, fps);
    case 'flash-frame':
      return {
        what:
          n === 1
            ? t('One frame doesn’t belong: another picture flashes up, then the shot goes on')
            : t('{count} frames don’t belong: another picture flashes up, then the shot goes on', { count: n }),
        why: t('A picture that differs from the frames on both sides for up to {s} is flagged, while the shot around it stays the same.', {
          s: formatSeconds(LIMITS.flashSeconds),
        }),
        verdict: 'problem',
        reason: t('Looks like a problem: usually a stray frame left over from the edit.'),
      };
    case 'black-frames':
      return x.why === 'black-dip' || (!x.why && x.severity === 'nice')
        ? {
            what: t('The picture dips to black for {s}', { s: secs(n, fps) }),
            why: t('Black for longer than {gap} inside the video is a dip; fades at the very start and end are left out.', {
              gap: formatSeconds(LIMITS.blackGapSeconds),
            }),
            verdict: 'intended',
            reason: t('Looks intended: a dip to black is a common transition. A problem only if the cut should be straight.'),
          }
        : {
            what: t('{count} black frames between two shots', { count: n }),
            why: t('Black for up to {gap} between shots is a gap; fades at the very start and end are left out.', {
              gap: formatSeconds(LIMITS.blackGapSeconds),
            }),
            verdict: 'problem',
            reason: t('Looks like a problem: a hole in the edit, a clip missing or too short.'),
          };
    case 'loudness':
      if (x.key === 'loudness:peak')
        return {
          what: x.value != null ? t('The loudest peak reaches {v} dBTP', { v: num(x.value) }) : x.text,
          why: t('Peaks above {max} dBTP can distort once a platform encodes the sound.', { max: num(LIMITS.peakDb) }),
          verdict: 'problem',
          reason: t('Looks like a problem: bring the loudest peak below {max} dBTP.', { max: num(LIMITS.peakDb) }),
        };
      return {
        what:
          x.value == null
            ? x.text
            : x.value < LIMITS.lufsTarget
              ? t('The whole video is quiet: {v} LUFS', { v: num(x.value) })
              : t('The whole video is loud: {v} LUFS', { v: num(x.value) }),
        why: t('Platforms play videos at about {target} LUFS; Auto-check flags anything outside {low} to {high} LUFS.', {
          target: num(LIMITS.lufsTarget),
          low: num(LIMITS.lufsLow),
          high: num(LIMITS.lufsHigh),
        }),
        verdict: null,
        reason:
          x.value != null && x.value < LIMITS.lufsTarget
            ? t('Played next to other videos it sounds quieter, unless the platform turns it up.')
            : t('Platforms turn it down to their level, and what is squeezed loud stays squeezed.'),
      };
    case 'clipping':
      return {
        what: t('The sound hits full scale for {n} frame|The sound hits full scale for {n} frames', { n }),
        why: t('Two or more samples at full scale (0 dBFS) in one frame are flagged: the sound distorts there.'),
        verdict: 'problem',
        reason: t('Looks like a problem: clipped sound is distortion you can hear.'),
      };
    case 'silence':
      return {
        what: t('Nothing is heard for {s}', { s: secs(n, fps) }),
        why: t('Quieter than {db} dB for {min} or longer inside the video is flagged.', {
          db: num(LIMITS.silenceDb),
          min: formatSeconds(LIMITS.silenceSeconds),
        }),
        verdict: null,
        reason: t('Can’t tell: fine for a pause, a problem if music or a voice should carry on.'),
      };
    case 'typo':
      if (!x.word) break;
      return {
        what: x.guess ? t('“{word}” may be misspelled: “{guess}”?', { word: x.word, guess: x.guess }) : t('“{word}” may be misspelled', { word: x.word }),
        why: languageName
          ? t('No {language} dictionary knows the word, nor do the project’s own captions; read again at twice the size, it still says so.', {
              language: languageName,
            })
          : t('No dictionary knows the word, nor do the project’s own captions; read again at twice the size, it still says so.'),
        verdict: 'problem',
        reason: t('Looks like a problem, unless it’s a name or a made-up word.'),
        quote: x.line,
      };
    case 'safe-zone':
      if (!x.zone || !ZONE[x.zone]) break;
      return {
        what: ZONE[x.zone](),
        why:
          x.zone === 'ig-crop'
            ? t('The profile grid shows a reel cropped at both sides; text this close to the edge is cut there.')
            : t('Instagram Reels lays its own buttons and caption over this part of the picture; flagged when text is under it on two samples or more.'),
        verdict: 'problem',
        reason: t('Looks like a problem if it goes on Instagram: people can’t read it there.'),
        quote: x.line,
      };
  }
  // a result from before these fields: the check's own sentence
  return { what: x.text, why: x.detail || '', verdict: null, reason: null };
}
