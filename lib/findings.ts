// What Auto-check's findings mean (lib/qa.ts finds them): the limits it flags at, whether a freeze looks intended or
// like a problem, and whether a finding was dismissed — the same stretch in a later version too. Shared with the
// browser (no Node imports), so the player explains a finding with the very numbers the check used.
import type { FrameRange, HoldMotion, QaKind, QaWhy } from './types.ts';

/** What these rules read of a finding (the browser's QaItem is a looser shape of lib/types.ts's). */
export interface FindingLike {
  key: string;
  kind: string;
  frame: number;
  range?: FrameRange | null;
  holds?: FrameRange[];
}

/** The freeze detector (lib/media.ts `freezes`) and what Auto-check makes of the holds it finds. */
export const FREEZE = {
  /** Two frames look the same below this mean difference (blurred grey, 0–255): grain and noise aren't motion. */
  threshold: 0.35,
  /**
   * …and while no patch of the picture changes by this much on average (blurred grey, 0–255; a patch is two by two
   * `cell`s): a cursor or an icon moving on a still screen is motion, though the whole picture's mean barely moves.
   * Grain and codec noise stay under it.
   */
  patchThreshold: 1.5,
  /** A patch's cell, in pixels of the detector's picture (270 px on its short side: about 60 px of a 1080 px side). */
  cell: 15,
  /** A hold: at least this many frames in a row that look the same. */
  minFrames: 3,
  /** Holds from this long (and at least `listFrames` frames) are listed one by one; shorter ones are repeated frames. */
  listSeconds: 0.2,
  listFrames: 6,
  /** A hold that looks intended and lasts longer than this is a still shot (a title, a photo): not listed. */
  stillSeconds: 1.5,
  /** Below this share of its frames with sound, the sound pauses with the picture. */
  soundShare: 0.4,
  /** More holds than this at once: one summary (motion graphics and screen recordings pause on purpose). */
  many: 6,
  /** Up to this many places with repeated frames are worth a look; more is footage retimed on purpose (speed ramps). */
  fewRepeats: 3,
  /**
   * What a stall looks like (`HoldMotion`, steps in multiples of the still limit). `paceSeconds`: how long before and
   * after a hold its motion is measured. `same`: inside a stall, frames are copies of one another (the median step at
   * most this: grain and codec noise, nothing moving). `abrupt`: motion that moved on every frame stops dead when its
   * last step into the hold is at least this share of its fastest (eased motion slows down first, and motion placed on
   * whole pixels creeps in single steps with still frames between). `jump`: a catch-up jump out of it is at least this
   * many times the fastest step before and after it (the frames it skipped).
   */
  paceSeconds: 0.25,
  same: 0.25,
  abrupt: 0.5,
  jump: 2,
} as const;

/** The other limits Auto-check flags at (lib/qa.ts). */
export const LIMITS = {
  /** A flash: a foreign picture for at most this long, then the shot comes back. */
  flashSeconds: 0.07,
  /** Black frames: up to this long a gap between shots, longer a dip to black. */
  blackGapSeconds: 0.27,
  /** Black within this of the first or last frame is a fade in or out: not flagged. */
  edgeSeconds: 0.2,
  /** Silence: quieter than this for at least `silenceSeconds`, inside the video. */
  silenceDb: -50,
  silenceSeconds: 0.4,
  /** Integrated loudness outside `lufsLow`–`lufsHigh`; platforms play videos at about `lufsTarget`. */
  lufsLow: -16,
  lufsHigh: -12,
  lufsTarget: -14,
  /** True peak above this. */
  peakDb: -1,
} as const;

/** Frames from which a hold is listed on its own (6 at 25/30 fps, 12 at 60). */
export const listFrames = (fps: number): number => Math.max(FREEZE.listFrames, Math.round(fps * FREEZE.listSeconds));

/** A peak (0–1 of full scale) counts as sound at or above the silence limit. */
export const SOUND_PEAK = 10 ** (LIMITS.silenceDb / 20);

export interface HoldContext {
  /** The render's length in frames. */
  frames: number;
  fps: number;
  /** Share (0–1) of the hold's frames with sound; null when the render has no sound to go by. */
  sound: number | null;
  /** A cut on (or a frame from) the hold's first frame: the shot is still from its start. */
  fromCut: boolean;
  /** How the picture moves at the hold's edges; absent in a scan from before it was measured. */
  motion?: HoldMotion | null;
}

export interface Verdict {
  likely: 'intended' | 'problem';
  why: QaWhy;
}

/**
 * What marks a hold as a stall, or null: copies of one frame in the middle of motion that stops dead into them
 * (`stop`) or jumps on after them by the frames it skipped (`jump`). Motion that slows into a hold (an animation
 * settling), a picture that wasn't moving before it, or frames that still differ (a slow drift, grain) show neither.
 */
export function stallMark(m: HoldMotion): 'stop' | 'jump' | null {
  if (m.before < 1 || m.inside > FREEZE.same) return null;
  if (m.jump >= FREEZE.jump * Math.max(m.before, m.after)) return 'jump';
  if (m.steady >= 1 && m.lead >= FREEZE.abrupt * m.before) return 'stop';
  return null;
}

/**
 * Whether a hold (frames that look the same) looks intended or like a problem, and why. Holds on the first or last
 * frames open or close the video (a title, an end card). Then the motion at its edges: without a stall's marks
 * (`stallMark`) a hold is intended — a held shot from a cut, a pause with the sound, the motion easing into it, or
 * nothing moving before it — whatever the sound does: a music bed goes on through every pause. A stall is a hitch when
 * it is short, a held shot from a cut, a beat when the sound pauses with it, and otherwise the picture stopping while
 * the sound goes on: frames a render dropped or stalled on. A scan from before the motion was measured: the sound
 * decides, as it did then.
 */
export function holdVerdict(r: FrameRange, c: HoldContext): Verdict {
  if (r.in <= 1) return { likely: 'intended', why: 'opening' };
  if (r.out >= c.frames - 2) return { likely: 'intended', why: 'end-card' };
  const short = r.out - r.in + 1 < listFrames(c.fps);
  if (c.motion && !stallMark(c.motion)) {
    if (!short && c.fromCut) return { likely: 'intended', why: 'held-shot' };
    if (!short && c.sound !== null && c.sound < FREEZE.soundShare) return { likely: 'intended', why: 'pause' };
    return { likely: 'intended', why: c.motion.before >= 1 ? 'eased' : 'still-before' };
  }
  if (short) return { likely: 'problem', why: 'repeated' };
  if (c.fromCut) return { likely: 'intended', why: 'held-shot' };
  if (c.sound === null) return { likely: 'problem', why: 'mid-shot' };
  if (c.sound < FREEZE.soundShare) return { likely: 'intended', why: 'pause' };
  return { likely: 'problem', why: 'sound-continues' };
}

/**
 * How Auto-check lists a hold: `one` on its own, `short` with the other repeated frames, or not at all (`none`):
 * openings and end cards, holds that look intended and are too short for a pause of their own, and still shots that
 * look intended and last longer than `FREEZE.stillSeconds`.
 */
export function holdListing(r: FrameRange, v: Verdict, fps: number): 'one' | 'short' | 'none' {
  if (v.why === 'opening' || v.why === 'end-card') return 'none';
  if (v.why === 'repeated') return 'short';
  const n = r.out - r.in + 1;
  if (v.likely === 'intended' && (n < listFrames(fps) || n > Math.round(fps * FREEZE.stillSeconds))) return 'none';
  return 'one';
}

// ---------------------------------------------------------------- where a finding is, and dismissals

/** A finding about the whole video (the integrated loudness): no frame to show or play. */
export const aboutWholeVideo = (x: Pick<FindingLike, 'key'>): boolean => x.key === 'loudness:lufs';

/** The frames a finding is about: its range, a summary's first hold, else its one frame; null for the whole video. */
export function stretchOf(x: FindingLike): FrameRange | null {
  if (aboutWholeVideo(x)) return null;
  if (x.range) return x.range;
  if (x.holds?.length) return x.holds[0];
  return { in: x.frame, out: x.frame };
}

/** Keys of findings about a stretch, which can move a little between versions (`freeze:120`); other keys name a word,
 * a line or a measure of the whole video and stay put. */
const STRETCH_KEY = /^(freeze|flash|black|clip|silence):(\d+)$/;
const KEY_KIND: Record<string, QaKind> = { freeze: 'freeze', flash: 'flash-frame', black: 'black-frames', clip: 'clipping', silence: 'silence' };

/** Whether a finding's key names a stretch (whose dismissal keeps where it was). */
export const isStretchKey = (key: string): boolean => STRETCH_KEY.test(key);

/** The slack between versions: a quarter of a second, at least two frames. */
const slack = (fps: number) => Math.max(2, Math.round(fps * 0.25));

/** Two stretches are the same one when both ends are within the slack (or a tenth of the longer one). */
export function sameStretch(a: FrameRange, b: FrameRange, fps: number): boolean {
  const tol = Math.max(slack(fps), Math.round(Math.max(a.out - a.in, b.out - b.in) * 0.1));
  return Math.abs(a.in - b.in) <= tol && Math.abs(a.out - b.out) <= tol;
}

export interface Dismissals {
  qa_dismissed?: string[];
  qa_stretches?: Record<string, FrameRange>;
}

/**
 * Whether a finding was dismissed on this video: its key, or — for a finding about a stretch — a dismissed finding of
 * the same kind on the same stretch in another version (the frames kept with the dismissal; for one from before they
 * were kept, its first frame within the slack).
 */
export function dismissedBy(x: FindingLike, d: Dismissals, fps: number): boolean {
  const keys = d.qa_dismissed;
  if (!keys?.length) return false;
  if (keys.includes(x.key)) return true;
  const mine = STRETCH_KEY.exec(x.key);
  if (!mine || KEY_KIND[mine[1]] !== x.kind) return false;
  const here = x.range ?? { in: x.frame, out: x.frame };
  for (const k of keys) {
    const m = STRETCH_KEY.exec(k);
    if (!m || m[1] !== mine[1]) continue;
    const there = d.qa_stretches?.[k];
    if (there ? sameStretch(there, here, fps) : Math.abs(Number(m[2]) - here.in) <= slack(fps)) return true;
  }
  return false;
}

/** The findings nobody dismissed. */
export const undismissed = <T extends FindingLike>(items: readonly T[], d: Dismissals, fps: number): T[] => items.filter((x) => !dismissedBy(x, d, fps));
