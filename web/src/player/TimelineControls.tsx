// What sits on the timeline besides its canvas: the marked section's chip (its times and length; a menu with what to do
// with it, each item naming its frame and its key). Timeline.tsx places it. The zoom has a place of its own
// (ZoomControl.tsx).
import { type CSSProperties, type Ref, useState, useSyncExternalStore } from 'react';
import { formatSeconds, rangeSeconds, rangeTimecodes } from '../../../lib/range.ts';
import { timecode } from '../../../lib/time.ts';
import type { FrameRange } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { I } from '../ui/icons.tsx';
import { Menu, type MenuEntry } from '../ui/primitives.tsx';
import type { FrameStore } from './frameStore.ts';
import { rangeAction } from './rangeAction.ts';

const still = () => () => {};

interface SectionChipProps {
  section: FrameRange;
  fps: number;
  frames: number;
  /** The frame on screen when the timeline last rendered, and live while it plays. */
  frame: number;
  live?: FrameStore;
  /** A note is being written about the section (its composer is open): no "Write a note", Esc is the composer's. */
  writing: boolean;
  /** A finger: the chip only says what is marked (the composer's chip has the actions). */
  touch: boolean;
  client?: boolean;
  onNote?: () => void;
  onClear?: () => void;
  onEdge?: (edge: 'in' | 'out', f: number) => void;
  onZoom: () => void;
  style: CSSProperties;
  ref?: Ref<HTMLElement>;
}

/** The marked section, low inside it on the timeline: "00:23:22 → 00:24:22 · 1.0 s ⌄". */
export function SectionChip({ section, fps, frames, frame, live, writing, touch, client, onNote, onClear, onEdge, onZoom, style, ref }: SectionChipProps) {
  const [open, setOpen] = useState(false);
  // the frame on screen, followed only while the menu is open (its start/end item names it)
  const now = useSyncExternalStore(open && live ? live.subscribe : still, open && live ? live.get : () => frame);
  const words = (
    <>
      <span className="tl-mark-tc">{rangeTimecodes(section, fps)}</span>
      <span className="tl-mark-len">{formatSeconds(rangeSeconds(section, fps))}</span>
    </>
  );
  if (touch)
    return (
      <span className="tl-mark" data-testid="tl-mark" ref={ref} style={style}>
        {words}
      </span>
    );
  const act = rangeAction(now, section, fps, frames);
  const tc = 'at' in act ? timecode(act.at, fps) : '';
  const items: MenuEntry[] = [
    !writing && onNote && { label: client ? t('client::Write a note on it') : t('Write a note on it'), icon: 'edit', shortcut: 'C', onClick: onNote },
    'sep',
    act.kind === 'end'
      ? { label: client ? t('client::End at {tc}', { tc }) : t('End at {tc}', { tc }), shortcut: 'O', onClick: () => onEdge?.('out', act.range.out) }
      : act.kind === 'start'
        ? { label: client ? t('client::Start at {tc}', { tc }) : t('Start at {tc}', { tc }), shortcut: 'I', onClick: () => onEdge?.('in', act.range.in) }
        : {
            label:
              act.kind === 'at-end'
                ? client
                  ? t('client::Ends on this frame')
                  : t('Ends on this frame')
                : client
                  ? t('client::Step to a new end')
                  : t('Step to a new end'),
            disabled: true,
            onClick: () => {},
          },
    { label: client ? t('client::Zoom to it') : t('Zoom to it'), icon: 'expand', shortcut: 'Z', onClick: onZoom },
    'sep',
    onClear && { label: client ? t('client::Clear the section') : t('Clear the section'), icon: 'x', shortcut: writing ? undefined : 'Esc', onClick: onClear },
  ];
  return (
    <Menu
      side="top"
      align="start"
      onOpenChange={setOpen}
      trigger={
        <button
          type="button"
          className="tl-mark"
          data-testid="tl-mark"
          ref={ref as Ref<HTMLButtonElement>}
          style={style}
          aria-label={
            client
              ? t('client::Marked section {range}', { range: rangeTimecodes(section, fps) })
              : t('Marked section {range}', { range: rangeTimecodes(section, fps) })
          }
        >
          {words}
          <I name="down" size={11} className="tl-mark-chev" />
        </button>
      }
      items={items}
    />
  );
}
