// The moment a note is about, in the composer's head, as one chip: the frame ("00:12:03 ⌄") or the section with its
// length ("00:12:03 → 00:14:10 · 2.3 s ⌄"). Its menu (built by the composer, with `rangeItems`) changes it, every item
// naming the frame it uses and its key: "End at 00:13:20" (O) / "Start at 00:11:00" (I) from the frame on screen, "Only
// the first frame, 00:12:03" (the end comes off). With no section yet, one quiet affordance beside the chip
// (`RangeExtend`): "→ 00:13:03", a second from here (or "← …" from a second before, at the very end); pointing at it
// draws that section on the timeline (rangeHint.ts), where its ends then drag. Shared by the player and the client page
// (`client`: the client pages' own words).
import { useEffect, useState, useSyncExternalStore } from 'react';
import { formatSeconds, rangeSeconds, rangeTimecodes } from '../../../lib/range.ts';
import { timecode } from '../../../lib/time.ts';
import type { FrameRange } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { type MenuEntry, Tip } from '../ui/primitives.tsx';
import type { FrameStore } from './frameStore.ts';
import { rangeAction } from './rangeAction.ts';
import { clearRangeHint, setRangeHint } from './rangeHint.ts';
import '../styles/range.css';

/** In the composer's head: the frame, or the range with its length. */
export function RangeControl({ frame, fps, range }: { frame: number; fps: number; range: FrameRange | null }) {
  if (range)
    return (
      <span className="range-ctl" data-testid="range-ctl">
        <span className="c-tc range">
          {rangeTimecodes(range, fps)}
          <span className="note-range-len">{formatSeconds(rangeSeconds(range, fps))}</span>
        </span>
      </span>
    );
  return (
    <span className="range-ctl">
      <span className="c-tc">{timecode(frame, fps)}</span>
    </span>
  );
}

const noop = () => () => {};

/** The frame on screen: live while `on` (a menu open, an affordance shown), else the frame the page last rendered. */
export const useFrameOnScreen = (frame: number, live: FrameStore | undefined, on: boolean): number =>
  useSyncExternalStore(on && live ? live.subscribe : noop, on && live ? live.get : () => frame);

/**
 * What a section's menu offers to change it, from the frame on screen `now`: its end or start moved there (O / I) — or,
 * on its first or last frame, a line saying what to do — and "Only the first frame", which takes the end off.
 */
export function rangeItems({
  now,
  range,
  fps,
  frames,
  onRange,
  onSeek,
  touch,
  client,
}: {
  now: number;
  range: FrameRange;
  fps: number;
  frames: number;
  onRange: (r: FrameRange | null) => void;
  onSeek?: (f: number) => void;
  touch: boolean;
  client?: boolean;
}): MenuEntry[] {
  const act = rangeAction(now, range, fps, frames);
  const first = timecode(range.in, fps);
  return [
    act.kind === 'end' || act.kind === 'start'
      ? {
          label:
            act.kind === 'end'
              ? client
                ? t('client::End at {tc}', { tc: timecode(act.at, fps) })
                : t('End at {tc}', { tc: timecode(act.at, fps) })
              : client
                ? t('client::Start at {tc}', { tc: timecode(act.at, fps) })
                : t('Start at {tc}', { tc: timecode(act.at, fps) }),
          shortcut: act.kind === 'end' ? 'O' : 'I',
          onClick: () => onRange(act.range),
        }
      : {
          label:
            act.kind === 'at-end'
              ? client
                ? t('client::Ends on this frame')
                : t('Ends on this frame')
              : touch
                ? client
                  ? t('client::Play to a new end')
                  : t('Play to a new end')
                : client
                  ? t('client::Step to a new end')
                  : t('Step to a new end'),
          disabled: true,
          onClick: () => {},
        },
    {
      label: client ? t('client::Just {tc}', { tc: first }) : t('Only the first frame, {tc}', { tc: first }),
      onClick: () => {
        onRange(null);
        onSeek?.(range.in);
      },
    },
  ];
}

interface RangeExtendProps {
  /** The frame on screen when the page last rendered. */
  frame: number;
  /** The frame on screen, live while it plays (the player renders only when playback stops or seeks). */
  live?: FrameStore;
  fps: number;
  /** Frames in the render (the section stays inside it). */
  frames: number;
  onRange: (r: FrameRange) => void;
  client?: boolean;
}

/** Beside a frame's chip: the quiet way to make it a section — "→ 00:13:03", a second from the frame on screen. */
export function RangeExtend({ frame, live, fps, frames, onRange, client }: RangeExtendProps) {
  const now = useFrameOnScreen(frame, live, true);
  const act = rangeAction(now, null, fps, frames);
  // Pointing at it draws the section it would make on the timeline; the ghost follows the frame on screen and goes
  // with the affordance.
  const [pointing, setPointing] = useState(false);
  const gIn = 'range' in act ? act.range.in : null;
  const gOut = 'range' in act ? act.range.out : null;
  useEffect(() => setRangeHint({ ghost: pointing && gIn != null && gOut != null ? { in: gIn, out: gOut } : null }), [pointing, gIn, gOut]);
  useEffect(() => () => clearRangeHint(), []);
  if (act.kind !== 'until' && act.kind !== 'from') return null;
  const tc = timecode(act.at, fps);
  const label =
    act.kind === 'until'
      ? client
        ? t('client::Until {tc}', { tc })
        : t('Until {tc}', { tc })
      : client
        ? t('client::From {tc}', { tc })
        : t('From {tc}', { tc });
  const range = rangeTimecodes(act.range, fps);
  return (
    <Tip
      content={
        client
          ? t('client::Make it a section, {range} — then drag its ends on the timeline', { range })
          : t('Make it a section, {range} — then drag its ends on the timeline', { range })
      }
      side="bottom"
    >
      <button
        type="button"
        className="range-more"
        onClick={() => onRange(act.range)}
        data-testid="range-add"
        aria-label={label}
        onPointerEnter={() => setPointing(true)}
        onPointerLeave={() => setPointing(false)}
        onFocus={() => setPointing(true)}
        onBlur={() => setPointing(false)}
      >
        {/* the rest of a section's chip, not there yet: the arrow reads as the chip's own "→" */}
        <span className="range-more-chip">
          <span className="range-more-arrow" aria-hidden="true">
            {act.kind === 'until' ? '→' : '←'}
          </span>
          {tc}
        </span>
      </button>
    </Tip>
  );
}
