// Tooltips and icon buttons. A tooltip costs its element nothing but a note of what it says: one shared tooltip layer
// (ui/layers.tsx, loaded after the first paint) shows the note of whatever is hovered or focused, with the timing,
// placement and look of a Radix tooltip. A library of cards thus mounts no tooltip machinery per button. Re-exported
// from primitives.tsx.
import { type ButtonHTMLAttributes, type HTMLAttributes, type ReactElement, type ReactNode, type Ref, useCallback, useRef } from 'react';
import { I, type IconName } from './icons.tsx';
import { setRef, slot } from './slot.ts';

/** Keyboard keys as they are printed on the key caps: "⇧V", "Esc", "⌘↵". */
export const Kbd = ({ children }: { children: ReactNode }) => <kbd className="kbd">{children}</kbd>;

export type Side = 'top' | 'bottom' | 'left' | 'right';

export interface TipNote {
  content: ReactNode;
  shortcut?: string;
  side: Side;
}

const notes = new WeakMap<Element, { current: TipNote | null }>();
// The note of the tooltip on screen: when its element renders new words ("Play" → "Pause"), the layer shows them.
let watched: { note: { current: TipNote | null }; changed: () => void } | null = null;

/** What the tooltip of `el` says (null: none), for the tooltip layer. */
export function tipOf(el: Element): TipNote | null {
  return notes.get(el)?.current ?? null;
}

/** Calls `changed` whenever `el` renders its tooltip anew, until `el` is watched no more (null). */
export function watchTip(el: Element | null, changed: () => void): void {
  const note = el && notes.get(el);
  watched = note ? { note, changed } : null;
}

/** The nearest element at or above `target` that has a tooltip. */
export function tipTarget(target: EventTarget | null): HTMLElement | null {
  for (let el = target instanceof Element ? target : null; el; el = el.parentElement) if (notes.has(el)) return el as HTMLElement;
  return null;
}

/** A ref that gives its element the tooltip `content` (with `shortcut`), handing the element on to `ref` too. */
function useTipRef<T extends HTMLElement>(content: ReactNode, shortcut: string | undefined, side: Side, ref?: Ref<T>) {
  const note = useRef<TipNote | null>(null);
  note.current = content ? { content, shortcut, side } : null;
  if (watched?.note === note) queueMicrotask(watched.changed);
  return useCallback(
    (el: T | null) => {
      if (el) notes.set(el, note);
      setRef(ref, el);
    },
    [ref],
  );
}

/**
 * A tooltip on any focusable element (`children`: one element that takes a ref). It shows under the pointer after a
 * moment or with keyboard focus; once the element is clicked it stays away until the pointer leaves (it would come back
 * when a menu the click opened hands the focus back). Props from a parent trigger go on to the element.
 */
export function Tip({
  content,
  shortcut,
  children,
  side = 'top',
  ref,
  ...rest
}: { content: ReactNode; shortcut?: string; children: ReactElement; side?: Side; ref?: Ref<HTMLElement> } & Omit<HTMLAttributes<HTMLElement>, 'content'>) {
  const tipRef = useTipRef(content, shortcut, side, ref);
  return slot(children, rest, tipRef);
}

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** The accessible name and the tooltip. */
  label: string;
  icon?: IconName;
  size?: number;
  /** The keyboard shortcut, shown in the tooltip. */
  shortcut?: string;
  /** A richer tooltip than the label (the label stays the accessible name). */
  tip?: ReactNode;
  side?: Side;
  /** Content instead of the icon (a badge with a count, a custom glyph). */
  children?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

/**
 * A button that is only an icon: always named for screen readers and always with a tooltip. Works as the trigger of a
 * Menu, Popover or Dialog. `className` defaults to a ghost icon button.
 */
export function IconButton({
  label,
  icon,
  size = 16,
  shortcut,
  tip,
  side = 'top',
  className = 'btn ghost icon-only',
  children,
  ref,
  ...rest
}: IconButtonProps) {
  const tipRef = useTipRef(tip ?? label, shortcut, side, ref);
  return (
    <button ref={tipRef} type="button" className={className} aria-label={label} data-tip="" {...rest}>
      {children ?? (icon && <I name={icon} size={size} />)}
    </button>
  );
}
