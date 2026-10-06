// A switch, an avatar and a scroll area as plain elements: the DOM, classes, roles, aria-* and data-state of the Radix
// versions they replace, so their CSS and the tests apply unchanged, without Radix — the library (the screen the first
// paint waits for: its toolbar, sidebar, user menu and inbox) renders them. ui/controls.tsx re-exports them.
import { type CSSProperties, type ReactNode, type Ref, type UIEventHandler, useEffect, useLayoutEffect, useState } from 'react';
import { I } from './icons.tsx';

// ---------------------------------------------------------------- switch

export interface ToggleProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  /** When there is no visible <label htmlFor> for it. */
  label?: string;
}

/** On/off that takes effect at once (a setting). For a choice that is submitted later, use Checkbox. */
export function Switch({ checked, onCheckedChange, disabled, id, label }: ToggleProps) {
  const state = checked ? 'checked' : 'unchecked';
  const off = disabled ? '' : undefined;
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      data-state={state}
      data-disabled={off}
      disabled={disabled}
      value="on"
      onClick={() => onCheckedChange(!checked)}
    >
      <span className="switch-thumb" data-state={state} data-disabled={off} />
    </button>
  );
}

// ---------------------------------------------------------------- avatar

/** Initials of a name ("guest:Mia Lang" → "ML"); agents keep their mark. */
export function initials(name: string): string {
  const n = name.replace(/^(guest|agent):/, '').trim();
  const words = n.split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length > 1 ? words[0][0] + words[1][0] : n.slice(0, 2)).toUpperCase();
}

export type AvatarKind = 'person' | 'agent' | 'client';
export const avatarKind = (author: string): AvatarKind => (author.startsWith('agent:') ? 'agent' : author.startsWith('guest:') ? 'client' : 'person');

/** A picture's state: shown once it has loaded, never broken. */
function usePicture(src: string | null | undefined): 'loading' | 'loaded' | 'error' {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>(src ? 'loading' : 'error');
  useLayoutEffect(() => {
    if (!src) return setStatus('error');
    let live = true;
    const img = new Image();
    img.onload = () => live && setStatus('loaded');
    img.onerror = () => live && setStatus('error');
    setStatus('loading');
    img.src = src;
    return () => {
      live = false;
    };
  }, [src]);
  return status;
}

/** A person, an agent or a client at a glance: initials in a disc (an agent gets its mark), an image when there is one. */
export function Avatar({ name, src, size = 22, kind = avatarKind(name) }: { name: string; src?: string | null; size?: number; kind?: AvatarKind }) {
  const picture = usePicture(src);
  // With a picture on its way, the initials wait a moment: one that is cached shows without them flashing first.
  const [waiting, setWaiting] = useState(!!src);
  useEffect(() => {
    setWaiting(!!src);
    if (!src) return;
    const t = setTimeout(() => setWaiting(false), 400);
    return () => clearTimeout(t);
  }, [src]);
  return (
    <span className={`avatar ${kind}`} style={{ '--av': `${size}px` } as CSSProperties} title={name.replace(/^(guest|agent):/, '')}>
      {src && picture === 'loaded' && <img className="avatar-img" src={src} alt="" />}
      {picture !== 'loaded' && !waiting && (
        <span className="avatar-fb">
          {/* no name yet: a person, not a "?" (a glyph that never sits in the disc's optical middle) */}
          {kind === 'agent' ? (
            <I name="spark" size={Math.round(size * 0.55)} />
          ) : initials(name) === '?' ? (
            <I name="user" size={Math.round(size * 0.5)} />
          ) : (
            initials(name)
          )}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- scroll area

export interface ScrollAreaProps {
  children: ReactNode;
  /** On the root (the box that has the size). */
  className?: string;
  /** On the viewport (the element that scrolls: give it the old scroller's class). */
  viewportClassName?: string;
  viewportRef?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
  horizontal?: boolean;
  style?: CSSProperties;
}

/**
 * Native scrolling (touch, wheel, keyboard and scrollIntoView all work) with a thin scrollbar that shows while the
 * pointer is on it (ui.css `.sa-viewport`); the content sits in one wrapper, as it did in Radix's.
 */
export function ScrollArea({ children, className = '', viewportClassName = '', viewportRef, onScroll, horizontal, style }: ScrollAreaProps) {
  return (
    <div className={`sa ${className}`} dir="ltr" style={style}>
      <div className={`sa-viewport ${viewportClassName}`} data-horizontal={horizontal ? '' : undefined} ref={viewportRef} onScroll={onScroll}>
        <div>{children}</div>
      </div>
    </div>
  );
}
