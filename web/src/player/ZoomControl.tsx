// The timeline's zoom: zoom out · the level · zoom in, and its one-time tip. It has a place of its own and never sits on
// the timeline: in the transport row beside the speed and the sound (Transport.tsx, GuestPlayer.tsx: Timeline.tsx
// renders it into their slot), on a phone in a quiet row above the ruler (`.tl-head`), as the reduced version — zoom in
// alone until it is zoomed. Its state is the timeline's (Timeline.tsx); the keys (− = Z ⇧Z 0) reach it through 'vr-zoom'.
import { type CSSProperties, type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n/index.ts';
import { T } from '../i18n/T.tsx';
import { IconButton, Kbd, Tip } from '../ui/primitives.tsx';
import type { ZoomLevel } from './timelineView.ts';

/** "Fit", "12 frames" or "4×". */
export function zoomWords(level: ZoomLevel, client?: boolean): string {
  if (level.kind === 'fit') return client ? t('client::Fit') : t('Fit');
  if (level.kind === 'frames') return client ? t('client::{n} frame|{n} frames', { n: level.n }) : t('{n} frame|{n} frames', { n: level.n });
  return client ? t('client::{z}×', { z: level.z }) : t('{z}×', { z: level.z });
}

/** The longest words the level can say for a video of `frames` frames ("100 frames", or "Einpassen"): the level keeps
 * that width, so the buttons beside it never move while zooming. Digits are tabular, so letters measure it well. */
function widestWords(frames: number, client?: boolean): string {
  const most = Math.max(1, frames / 101);
  const words = [
    zoomWords({ kind: 'fit' }, client),
    zoomWords({ kind: 'frames', n: Math.min(100, Math.max(10, Math.round(frames))) }, client),
    zoomWords({ kind: 'times', z: most < 10 ? '8.8' : String(Math.round(most)) }, client),
  ];
  return words.reduce((a, b) => (b.length > a.length ? b : a));
}

/** The key that turns scrolling into zooming: ⌘ on a Mac (and an iPad with a keyboard), Ctrl elsewhere. */
const SCROLL_KEY = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform) ? '⌘' : 'Ctrl';

/** The zoom's one-time tip: how to zoom without the buttons (a pointer: the key and the wheel, or a pinch). */
export interface ZoomHint {
  /** A finger: a pinch, no keys. */
  touch: boolean;
  onDismiss: () => void;
}

/**
 * Zoom out, the level (a click fits, or zooms to the section / the playhead), zoom in; each with its key in the tooltip,
 * in the buttons of the row it sits in. `compact` (a phone, the whole video shown): only zoom in, the level and zoom out
 * come once it is zoomed. `hint`: the first time zooming would help, a tip points at it (`ZoomTip`), until it is
 * dismissed or the timeline is zoomed.
 */
export function ZoomControl({
  level,
  frames,
  section,
  compact = false,
  client,
  hint,
  onIn,
  onOut,
  onToggle,
}: {
  level: ZoomLevel;
  /** The video's length: the level's width follows from it. */
  frames: number;
  section: boolean;
  compact?: boolean;
  client?: boolean;
  hint?: ZoomHint | null;
  onIn: () => void;
  onOut: () => void;
  onToggle: () => void;
}) {
  const box = useRef<HTMLFieldSetElement>(null);
  const fit = level.kind === 'fit';
  const words = zoomWords(level, client);
  const outWords = client ? t('client::Zoom out') : t('Zoom out');
  const inWords = client ? t('client::Zoom in') : t('Zoom in');
  // the buttons' tooltips say the level too: where the row is short, the level itself gives way (dock.css)
  const tip = (label: string) => (fit ? label : `${label} · ${words}`);
  const toggle = fit
    ? section
      ? client
        ? t('client::Zoom to the section')
        : t('Zoom to the section')
      : client
        ? t('client::Zoom in around the playhead')
        : t('Zoom in around the playhead')
    : client
      ? t('client::Fit the whole video')
      : t('Fit the whole video');
  return (
    <>
      <fieldset
        ref={box}
        className="zoomctl"
        aria-label={client ? t('client::Timeline zoom') : t('Timeline zoom')}
        data-testid="tl-zoom"
        data-level={fit ? 'fit' : level.kind === 'frames' ? `${level.n}f` : `${level.z}x`}
      >
        {!(compact && fit) && (
          <>
            <IconButton
              className="btn sm icon-only ghost"
              label={outWords}
              tip={tip(outWords)}
              shortcut="−"
              icon="zoomOut"
              onClick={onOut}
              disabled={fit}
              data-testid="tl-zoom-out"
            />
            <Tip content={toggle} shortcut={fit ? 'Z' : '⇧Z'}>
              <button
                type="button"
                className="btn sm ghost zoomctl-level"
                onClick={onToggle}
                aria-label={`${words} · ${toggle}`}
                data-wide={widestWords(frames, client)}
                data-testid="tl-zoom-level"
              >
                <span>{words}</span>
              </button>
            </Tip>
          </>
        )}
        <IconButton
          className="btn sm icon-only ghost"
          label={inWords}
          tip={tip(inWords)}
          shortcut="="
          icon="zoomIn"
          onClick={onIn}
          disabled={level.kind === 'frames' && level.n <= 10}
          data-testid="tl-zoom-in"
        />
      </fieldset>
      {/* after the control, so the control is there (its ref set) when the tip measures it */}
      {hint && <ZoomTip anchor={box} side={compact ? 'left' : 'top'} hint={hint} client={client} />}
    </>
  );
}

// How far the tip stands off the control, and from the window's edges.
const GAP = 8;
const EDGE = 8;

/**
 * The one-time tip, in the tooltips' material: a small popover pointing at the control — above it in the transport row
 * (over the picture's foot, never over the timeline), left of it in a phone's row above the ruler, where that row is
 * empty. Laid over the page (it is placed against the window, so the dock's stacking and the stage's overlays don't
 * hide it); it never takes room, so nothing moves when it comes or goes.
 */
function ZoomTip({ anchor, side, hint, client }: { anchor: RefObject<HTMLElement | null>; side: 'top' | 'left'; hint: ZoomHint; client?: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ x: number; y: number; arrow: number } | null>(null);
  useLayoutEffect(() => {
    const a = anchor.current;
    const tip = el.current;
    if (!a || !tip) return;
    const place = () => {
      const r = a.getBoundingClientRect();
      // The control out of sight (a phone's notes sheet pulled up takes the dock away, or the page scrolled past it):
      // so is its tip. Placed against nothing it stood half off the screen, over the title.
      if (!r.width || !r.height || r.bottom <= 0 || r.top >= window.innerHeight) {
        setAt(null);
        return;
      }
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      // never past the window's top or bottom edge
      const inside = (y: number) => Math.max(EDGE, Math.min(y, window.innerHeight - EDGE - h));
      if (side === 'left') {
        const x = Math.max(EDGE, r.left - GAP - w);
        const y = inside(r.top + r.height / 2 - h / 2);
        const arrow = Math.min(Math.max(8, r.top + r.height / 2 - y), h - 8);
        setAt((o) => (o && o.x === x && o.y === y && o.arrow === arrow ? o : { x, y, arrow }));
        return;
      }
      // over the control's own column (the dock): never out over the notes beside it
      const col = a.closest('.dock')?.getBoundingClientRect();
      const lo = Math.max(EDGE, (col?.left ?? 0) + EDGE);
      const hi = Math.min(window.innerWidth, col?.right ?? window.innerWidth) - EDGE;
      const mid = r.left + r.width / 2;
      const x = Math.max(lo, Math.min(mid - w / 2, hi - w));
      const y = inside(r.top - GAP - h);
      const arrow = Math.min(Math.max(12, mid - x), w - 12);
      setAt((o) => (o && o.x === x && o.y === y && o.arrow === arrow ? o : { x, y, arrow }));
    };
    place();
    // the control moves with the row around it (the notes panel, a wrap, the page scrolling on a phone)
    const ro = new ResizeObserver(place);
    ro.observe(a);
    ro.observe(tip);
    ro.observe(document.documentElement);
    const row = a.closest('.dock');
    if (row) ro.observe(row);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, side]);
  const style = { left: at?.x ?? 0, top: at?.y ?? 0, visibility: at ? undefined : 'hidden', '--zoomtip-arrow': `${at?.arrow ?? 0}px` } as CSSProperties;
  return createPortal(
    <div ref={el} className="zoomtip" role="note" data-side={side} data-testid="tl-zoom-hint" style={style}>
      <span className="zoomtip-words">
        {hint.touch ? (
          client ? (
            t('client::Pinch to zoom the timeline')
          ) : (
            t('Pinch to zoom the timeline')
          )
        ) : client ? (
          <T k={'client::{key} + scroll or pinch to zoom the timeline'} values={{ key: <Kbd>{SCROLL_KEY}</Kbd> }} />
        ) : (
          <T k={'{key} + scroll or pinch to zoom the timeline'} values={{ key: <Kbd>{SCROLL_KEY}</Kbd> }} />
        )}
      </span>
      <IconButton
        className="zoomtip-x"
        label={client ? t('client::Hide this tip') : t('Hide this tip')}
        icon="x"
        size={12}
        onClick={hint.onDismiss}
        data-testid="tl-zoom-hint-x"
      />
    </div>,
    document.body,
  );
}
