// The UI primitives with our own CSS (.modal, .menu, .popover, .input, .seg): focus handling, keyboard navigation,
// portals and collision-aware placement come from Radix Primitives, the look is the cutting-room design system. Usage
// notes for every primitive: web/README.md → "UI primitives".
//
// This half is what a screen renders before anyone uses a control: triggers are the plain elements they were (with
// the same roles, names, states and ids), tooltips a note on their element (ui/tip.tsx). The Radix half (ui/layers.tsx)
// is its own chunk, loaded after the first paint; a menu, popover or hover card mounts its Radix part the first time it
// is used — the event that opened it is played on to it — and keeps it from then on. So a library of a thousand cards
// renders no menu machinery until a card's menu is opened, and a keyboard shortcut still acts on its first press.

import { type ReactElement, type ReactNode, type RefObject, useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { useLoaded } from '../lib/lazy.ts';
import { I, type IconName } from './icons.tsx';
import { layerCode } from './layerCode.ts';
import { SkLine } from './Skeleton.tsx';
import { slot } from './slot.ts';
import { Tip } from './tip.tsx';
import { ToggleGroup, ToggleItem } from './toggle.tsx';

export { IconButton, Kbd, Tip } from './tip.tsx';

/** The Radix trigger's handlers, handed over by the layer's anchor once it is mounted (ui/layers.tsx `Anchor`). */
export type TriggerHandlers = Record<string, ((e: unknown) => void) | undefined>;
export interface AnchorLink {
  el: RefObject<HTMLElement | null>;
  handlers: RefObject<TriggerHandlers>;
}

export function useAnchor(): AnchorLink {
  const el = useRef<HTMLElement | null>(null);
  const handlers = useRef<TriggerHandlers>({});
  const link = useRef<AnchorLink>(null);
  if (!link.current) link.current = { el, handlers };
  return link.current;
}

// ---------------------------------------------------------------- modal, confirm, drawer

export interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  foot?: ReactNode;
  width?: number;
  head?: ReactNode;
  /** A room to look at things in (the audition's clips): the screen's height whatever it shows, so what switches inside
   * never resizes it; the content lays itself out in the body, with the gutters, and scrolls itself. */
  fill?: boolean;
  /**
   * A dialog to write in (a skill's instructions): its body is a column, and the part marked `.modal-grow` takes the
   * room the dialog has — growing with its text until the dialog meets the screen's edge, then scrolling inside, while
   * what stands above and below it stays put. The whole screen on a phone.
   */
  writing?: boolean;
}

/** A dialog: its code arrives with the layers (at once, when it opens before they did). */
export function Modal(props: ModalProps) {
  const L = useLoaded(layerCode);
  return L ? <L.ModalLayer {...props} /> : null;
}

export interface ConfirmOptions {
  title: string;
  /** What happens, in a sentence or two: what goes, what stays. */
  body?: ReactNode;
  /** The button's words ("Delete folder", "Revoke"). */
  action: string;
  /** Destructive: a red button, and Cancel has the focus. */
  danger?: boolean;
  cancel?: string;
}

export interface ConfirmProps extends ConfirmOptions {
  children?: ReactNode;
  busy?: boolean;
  /** The answer can't be given yet (a name to type first, a reason): the action waits, Cancel doesn't. */
  ready?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** "Are you sure?" for what can't be undone. Reversible actions don't ask: they do it and offer Undo in the toast. */
export function Confirm(props: ConfirmProps) {
  const L = useLoaded(layerCode);
  return L ? <L.ConfirmLayer {...props} /> : null;
}

/**
 * `const [ask, confirmation] = useConfirm()`: render `{confirmation}` once, then `if (await ask({...}))` wherever an
 * action needs a yes first.
 */
export function useConfirm(): [(o: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const ask = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...o, resolve })), []);
  const done = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };
  const confirmation = pending ? <Confirm {...pending} onConfirm={() => done(true)} onClose={() => done(false)} /> : null;
  return [ask, confirmation];
}

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}

/** A panel that slides in from the left edge (the library's folders on phones and small tablets). */
export function Drawer(props: DrawerProps) {
  const [used, setUsed] = useState(props.open);
  if (props.open && !used) setUsed(true);
  const L = useLoaded(layerCode, used);
  return L && used ? <L.DrawerLayer {...props} /> : null;
}

// ---------------------------------------------------------------- menus: dropdown (⋯) and context (right-click, long-press)

export interface MenuItem {
  label: string;
  icon?: IconName;
  /** A mark in the icon's place (a severity's keyframe glyph). */
  mark?: ReactNode;
  danger?: boolean;
  /** Shown on the right, e.g. "⌘C" or "D". */
  shortcut?: string;
  disabled?: boolean;
  /** On or off: a menuitemcheckbox with a tick on the right (a tag, the note's severity, "About the whole video"). */
  checked?: boolean;
  /** The menu stays open after it is picked (several tags in a row). */
  keep?: boolean;
  onClick: () => void;
}
/** A titled one-of-many choice inside a menu (the theme): it stays open to show the result. */
export interface MenuChoice {
  choice: { label: string; value: string; options: { value: string; label: string; icon?: IconName }[]; onChange: (value: string) => void };
}
/** A quiet word over the items after it ("Move to"); shown only when an item follows it. */
export interface MenuHeading {
  heading: string;
}
/**
 * Items one step further in ("Download another version ›"): a menu of their own beside this one. On a phone, where a
 * menu is a sheet, they take the sheet's place, their label leading back (ui/layers.tsx). Shown only with items.
 */
export interface MenuSub {
  sub: { label: string; icon?: IconName; items: MenuEntry[] };
}
/** Items in order; 'sep' draws a line; false/null/undefined are skipped, so `cond && {...}` reads naturally. */
export type MenuEntry = MenuItem | MenuChoice | MenuHeading | MenuSub | 'sep' | false | null | undefined;
type Shown = MenuItem | MenuChoice | MenuHeading | MenuSub | 'sep';

// Separators only between groups that have items; headings only over items; a submenu only with items in it.
export function tidy(items: MenuEntry[]): Shown[] {
  const out: Shown[] = [];
  const bare = (x: Shown | undefined) => x !== undefined && x !== 'sep' && 'heading' in x;
  for (const it of items) {
    if (!it || (it !== 'sep' && 'sub' in it && !tidy(it.sub.items).length)) continue;
    if ((it === 'sep' || 'heading' in it) && bare(out.at(-1))) out.pop();
    if (it === 'sep' && (!out.length || out.at(-1) === 'sep')) continue;
    out.push(it);
  }
  while (out.at(-1) === 'sep' || bare(out.at(-1))) out.pop();
  return out;
}

export interface MenuProps {
  trigger: ReactElement;
  items: MenuEntry[];
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
  sideOffset?: number;
  onOpenChange?: (open: boolean) => void;
}

const OPEN_KEYS = ['Enter', ' ', 'ArrowDown'];

export function Menu({ trigger, items, side = 'bottom', align = 'end', sideOffset = 4, onOpenChange }: MenuProps) {
  const [open, setOpenState] = useState(false);
  const [used, setUsed] = useState(false);
  const anchor = useAnchor();
  // How it was opened: from the keyboard, the first item takes the focus.
  const via = useRef<'pointer' | 'keyboard'>('pointer');
  const id = useId();
  const L = useLoaded(layerCode, used);
  const live = used && !!L;
  const setOpen = (o: boolean) => {
    setOpenState(o);
    onOpenChange?.(o);
  };
  const props = {
    type: 'button',
    id: `${id}t`,
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? `${id}c` : undefined,
    'data-state': open ? 'open' : 'closed',
    onPointerDown: (e: React.PointerEvent) => {
      via.current = 'pointer';
      if (live) return anchor.handlers.current.onPointerDown?.(e);
      if (e.defaultPrevented || e.button !== 0 || e.ctrlKey) return;
      // As Radix does: the focus stays put, so the menu can take it.
      e.preventDefault();
      setUsed(true);
      setOpen(true);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (OPEN_KEYS.includes(e.key)) via.current = 'keyboard';
      if (live) return anchor.handlers.current.onKeyDown?.(e);
      if (e.defaultPrevented || !OPEN_KEYS.includes(e.key)) return;
      e.preventDefault();
      setUsed(true);
      setOpen(true);
    },
  };
  return (
    <>
      {slot(trigger, props, anchor.el)}
      {live && (
        <L.MenuLayer anchor={anchor} open={open} onOpenChange={setOpen} via={via} id={id} items={items} side={side} align={align} sideOffset={sideOffset} />
      )}
    </>
  );
}

// Text fields, links and media keep the browser's own menu (paste, open in new tab, save video…).
const native = (e: { target: EventTarget; stopPropagation: () => void }) => {
  if ((e.target as Element).closest?.('input, textarea, [contenteditable="true"], a[href], video, audio')) e.stopPropagation();
};
const touchOrPen = (e: React.PointerEvent) => e.pointerType !== 'mouse';

/**
 * Right-click (long-press on touch) on `children` opens the same items as its ⋯ menu. `children` must be one element
 * that takes a ref (a DOM element or a component passing `ref` through).
 */
export function ContextMenu({
  items,
  children,
  onOpenChange,
  disabled,
}: {
  items: MenuEntry[];
  children: ReactElement;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}) {
  const [open, setOpenState] = useState(false);
  const [used, setUsed] = useState(false);
  const anchor = useAnchor();
  // Where it was asked for before the Radix part was there: played on to it once it is.
  const asked = useRef<{ clientX: number; clientY: number } | null>(null);
  const press = useRef(0);
  const L = useLoaded(layerCode, used);
  const live = used && !!L;
  useLayoutEffect(() => {
    const at = asked.current;
    if (!live || !at) return;
    asked.current = null;
    anchor.handlers.current.onContextMenu?.({ ...at, defaultPrevented: false, preventDefault() {} });
  });
  if (disabled || !tidy(items).length) return children;
  const setOpen = (o: boolean) => {
    setOpenState(o);
    onOpenChange?.(o);
  };
  const ask = (e: { clientX: number; clientY: number }) => {
    asked.current = { clientX: e.clientX, clientY: e.clientY };
    setUsed(true);
  };
  const cancelPress = () => window.clearTimeout(press.current);
  const pass = (name: string, e: React.SyntheticEvent) => anchor.handlers.current[name]?.(e);
  const props = {
    'data-state': open ? 'open' : 'closed',
    style: { WebkitTouchCallout: 'none' },
    onContextMenuCapture: native,
    onPointerDownCapture: native,
    onContextMenu: (e: React.MouseEvent) => {
      if (live) return pass('onContextMenu', e);
      if (e.defaultPrevented) return;
      cancelPress();
      e.preventDefault();
      ask(e);
    },
    onPointerDown: (e: React.PointerEvent) => {
      if (live) return pass('onPointerDown', e);
      if (e.defaultPrevented || !touchOrPen(e)) return;
      cancelPress();
      const at = { clientX: e.clientX, clientY: e.clientY };
      press.current = window.setTimeout(() => ask(at), 700);
    },
    onPointerMove: (e: React.PointerEvent) => (live ? pass('onPointerMove', e) : touchOrPen(e) && cancelPress()),
    onPointerCancel: (e: React.PointerEvent) => (live ? pass('onPointerCancel', e) : touchOrPen(e) && cancelPress()),
    onPointerUp: (e: React.PointerEvent) => (live ? pass('onPointerUp', e) : touchOrPen(e) && cancelPress()),
  };
  return (
    <>
      {slot(children, props, anchor.el)}
      {live && <L.ContextMenuLayer anchor={anchor} onOpenChange={setOpen} items={items} />}
    </>
  );
}

// ---------------------------------------------------------------- popover and hover card

export interface PopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactElement;
  children: ReactNode;
  className?: string;
  sideOffset?: number;
  /** Where it opens from its trigger (below it unless said: the sidebar's foot opens upward). */
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** Its name for a screen reader (a dialog without a heading of its own says what it is). */
  label?: string;
  align?: 'start' | 'center' | 'end';
  /** Escape inside it; `preventDefault()` keeps it open (a step back in a multi-step popover instead of closing). */
  onEscapeKeyDown?: (e: KeyboardEvent) => void;
  /** On opening; `preventDefault()` leaves the focus to what asks for it inside (a calendar's chosen day). */
  onOpenAutoFocus?: (e: Event) => void;
}

export function Popover({
  open,
  onOpenChange,
  trigger,
  children,
  className = '',
  sideOffset = 4,
  side = 'bottom',
  label,
  align = 'end',
  onEscapeKeyDown,
  onOpenAutoFocus,
}: PopoverProps) {
  const [used, setUsed] = useState(open);
  if (open && !used) setUsed(true);
  const anchor = useAnchor();
  const id = useId();
  const L = useLoaded(layerCode, used);
  const props = {
    type: 'button',
    'aria-haspopup': 'dialog',
    'aria-expanded': open,
    'aria-controls': open ? `${id}c` : undefined,
    'data-state': open ? 'open' : 'closed',
    onClick: (e: React.MouseEvent) => !e.defaultPrevented && onOpenChange(!open),
  };
  return (
    <>
      {slot(trigger, props, anchor.el)}
      {used && L && (
        <L.PopoverLayer
          anchor={anchor}
          id={id}
          open={open}
          onOpenChange={onOpenChange}
          className={className}
          sideOffset={sideOffset}
          side={side}
          label={label}
          align={align}
          onEscapeKeyDown={onEscapeKeyDown}
          onOpenAutoFocus={onOpenAutoFocus}
        >
          {children}
        </L.PopoverLayer>
      )}
    </>
  );
}

export interface HoverCardProps {
  trigger: ReactElement;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  className?: string;
}

/** Details on hover (pointer only; touch and keyboard users get the same facts elsewhere): sessions, agents, people. */
export function HoverCard({ trigger, children, side = 'bottom', align = 'start', className = '' }: HoverCardProps) {
  const [open, setOpen] = useState(false);
  const [used, setUsed] = useState(false);
  const anchor = useAnchor();
  const asked = useRef<'enter' | 'focus' | null>(null);
  const L = useLoaded(layerCode, used);
  const live = used && !!L;
  // The pointer or the focus that came before the Radix part: played on to it, if it is still there.
  useLayoutEffect(() => {
    const how = asked.current;
    const el = anchor.el.current;
    if (!live || !how || !el) return;
    asked.current = null;
    const h = anchor.handlers.current;
    if (how === 'enter' && el.matches(':hover')) h.onPointerEnter?.({ pointerType: 'mouse', defaultPrevented: false });
    if (how === 'focus' && document.activeElement === el) h.onFocus?.({ defaultPrevented: false });
  });
  const first = (how: 'enter' | 'focus') => {
    asked.current = how;
    setUsed(true);
  };
  const props = {
    'data-state': open ? 'open' : 'closed',
    onPointerEnter: (e: React.PointerEvent) =>
      live ? anchor.handlers.current.onPointerEnter?.(e) : !e.defaultPrevented && e.pointerType !== 'touch' && first('enter'),
    onPointerLeave: (e: React.PointerEvent) => live && anchor.handlers.current.onPointerLeave?.(e),
    onFocus: (e: React.FocusEvent) => (live ? anchor.handlers.current.onFocus?.(e) : !e.defaultPrevented && first('focus')),
    onBlur: (e: React.FocusEvent) => live && anchor.handlers.current.onBlur?.(e),
    onTouchStart: (e: React.TouchEvent) => e.preventDefault(),
  };
  return (
    <>
      {slot(trigger, props, anchor.el)}
      {live && (
        <L.HoverCardLayer anchor={anchor} onOpenChange={setOpen} side={side} align={align} className={className}>
          {children}
        </L.HoverCardLayer>
      )}
    </>
  );
}

// ---------------------------------------------------------------- segmented control

export interface Option {
  value: string;
  label: string;
}

interface SegmentedProps {
  value: string;
  onChange: (value: string) => void;
  /** `count: null`: a number on its way (a placeholder the width of two digits). */
  options: (Option & { icon?: IconName; shortcut?: string; count?: number | null })[];
  className?: string;
  label: string;
  /** Icons only: each label becomes the item's accessible name and tooltip (with its shortcut). */
  iconOnly?: boolean;
}

export function Segmented({ value, onChange, options, className = '', label, iconOnly }: SegmentedProps) {
  return (
    <ToggleGroup className={`seg ${iconOnly ? 'icons' : ''} ${className}`} value={value} onValueChange={onChange} aria-label={label}>
      {options.map((o) =>
        iconOnly && o.icon ? (
          <ToggleItem key={o.value} value={o.value} className={value === o.value ? 'on' : ''} aria-label={o.label} asChild>
            <Tip content={o.label} shortcut={o.shortcut}>
              <button type="button" className={value === o.value ? 'on' : ''} aria-label={o.label} data-tip="">
                <I name={o.icon} size={15} />
              </button>
            </Tip>
          </ToggleItem>
        ) : (
          <ToggleItem key={o.value} value={o.value} className={value === o.value ? 'on' : ''}>
            {o.icon && <I name={o.icon} size={14} />}
            {o.label}
            {o.count !== undefined && <span className="seg-count">{o.count === null ? <SkLine w="2ch" /> : o.count}</span>}
          </ToggleItem>
        ),
      )}
    </ToggleGroup>
  );
}
