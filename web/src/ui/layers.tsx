// The Radix half of the UI primitives (see ui/primitives.tsx): dialogs, menus, popovers, hover cards, the one tooltip
// layer and the toasts. Its own chunk, loaded after the first paint. A menu, popover or hover card is mounted here the
// first time its trigger is used; its trigger stays the element the screen rendered: `Anchor` stands in for it inside
// Radix's trigger, handing Radix that element (for placement, focus return and "was that click outside?") and handing
// Radix's trigger handlers back to the element's own (ui/primitives.tsx).
import {
  AlertDialog,
  ContextMenu as ContextMenuPrimitive,
  Dialog,
  DropdownMenu,
  HoverCard as HoverCardPrimitive,
  Popover as PopoverPrimitive,
  Toast,
  Tooltip,
} from 'radix-ui';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type Ref,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import { t } from '../i18n/index.ts';
import { loader, useLoaded } from '../lib/lazy.ts';
import { usePhone } from '../lib/media.ts';
import { claimToasts, type LimitAsk, releaseToasts, type ToastItem } from '../lib/toast.ts';
import { Spinner } from './feedback.tsx';
import { I } from './icons.tsx';
import {
  type AnchorLink,
  type ConfirmProps,
  type DrawerProps,
  type MenuChoice,
  type MenuEntry,
  type MenuItem,
  type MenuSub,
  type ModalProps,
  type PopoverProps,
  type TriggerHandlers,
  tidy,
} from './primitives.tsx';
import { setRef } from './slot.ts';
import { IconButton, Kbd, type TipNote, tipOf, tipTarget, watchTip } from './tip.tsx';

// Where a billing provider runs: the library's banner, the trial's line and the moments of value (billing/Banner.tsx).
// Its import() lives here, after the first paint, rather than in the screens that ask for it (billing/code.ts): an
// import() in the first paint carries the list of everything its chunk needs, which the start's budget has no room for.
export const billingCode = loader(() => import('../billing/Banner.tsx'));

// Events from portalled content still bubble through the React tree; cards that open the player on click must not
// see clicks that happen inside their menus and dialogs.
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

/** Inside a Radix trigger (asChild): the screen's element is the trigger; Radix's handlers go back to it. */
export function Anchor({ link, ref, ...props }: { link: AnchorLink; ref?: Ref<HTMLElement> } & Record<string, unknown>) {
  const handlers: TriggerHandlers = {};
  for (const k in props) if (/^on[A-Z]/.test(k)) handlers[k] = props[k] as TriggerHandlers[string];
  link.handlers.current = handlers;
  useLayoutEffect(() => {
    setRef(ref, link.el.current);
    return () => setRef(ref, null);
  }, [ref, link]);
  return null;
}

// ---------------------------------------------------------------- modal, confirm, drawer

/** A dialog starts focused on itself (its title is read out), not on its first button: that is the close button, whose
 * tooltip would pop up over the title the moment the dialog opens. Fields that ask for focus (autoFocus) keep it. */
/** Esc in a dialog closes it — unless it was pressed in something inside that answers Esc itself (`data-escape="own"`:
 * a list folding back into its field, a name field going back to its row). Radix hears the key first (on the document,
 * capturing), so the dialog leaves the key to it instead of closing and swallowing it. */
const escapeInDialog = (e: KeyboardEvent) => {
  if (e.target instanceof Element && e.target.closest('[data-escape="own"]')) e.preventDefault();
  else e.stopPropagation();
};

const focusDialog = (e: Event) => {
  e.preventDefault();
  const root = e.currentTarget as HTMLElement | null;
  if (root && !root.contains(document.activeElement)) root.focus({ preventScroll: true });
};

/** ⌘↵ (Ctrl+Enter) anywhere in a dialog presses its primary action — the last primary button in its actions, the one
 * that shows the key cap (overlays.css). Only for keys typed in this dialog, not in one opened over it. */
const submitOnModEnter = (e: ReactKeyboardEvent<HTMLElement>) => {
  if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.defaultPrevented) return;
  if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target)) return;
  const go = [...e.currentTarget.querySelectorAll<HTMLElement>('.modal-foot .btn:is(.primary, .danger-fill)')].at(-1);
  if (!go || (go as HTMLButtonElement).disabled) return;
  e.preventDefault();
  go.click();
};

export function ModalLayer({ title, onClose, children, foot, width, head, fill }: ModalProps) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="backdrop" onClick={stop}>
          <Dialog.Content
            className={fill ? 'modal fill' : 'modal'}
            style={width ? { width } : undefined}
            aria-describedby={undefined}
            onEscapeKeyDown={escapeInDialog}
            onOpenAutoFocus={focusDialog}
            onKeyDown={submitOnModEnter}
          >
            <div className="modal-head">
              <Dialog.Title asChild>
                <h3 className="grow">{title}</h3>
              </Dialog.Title>
              {head}
              <Dialog.Close asChild>
                <IconButton label={t('Close')} icon="x" size={18} shortcut="Esc" />
              </Dialog.Close>
            </div>
            <div className="modal-body">{children}</div>
            {foot && <div className="modal-foot">{foot}</div>}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * "Are you sure?" for what can't be undone: the question names the thing, one sentence says what happens. Destructive:
 * the focus starts on Cancel (Enter keeps things as they are) and ⌘↵ goes ahead; otherwise the focus starts on the
 * action and Enter goes ahead.
 */
export function ConfirmLayer({ title, body, children, action, danger, cancel = t('Cancel'), busy, ready = true, onConfirm, onClose }: ConfirmProps) {
  const text = body ?? children;
  return (
    <AlertDialog.Root open onOpenChange={(open) => !open && onClose()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="backdrop" onClick={stop}>
          <AlertDialog.Content
            className="modal alert"
            data-testid="confirm"
            // without a sentence there is nothing to describe it (Radix asks for a Description or this)
            {...(text ? {} : { 'aria-describedby': undefined })}
            onEscapeKeyDown={stop}
            onOpenAutoFocus={(e) => {
              // a field the answer waits for (a name to type, a password) has the focus; else as below
              const field = (e.currentTarget as HTMLElement).querySelector<HTMLElement>('[data-autofocus]');
              if (field) {
                e.preventDefault();
                field.focus();
                return;
              }
              if (danger) return;
              e.preventDefault();
              (e.currentTarget as HTMLElement).querySelector<HTMLElement>('[data-testid=confirm-action]')?.focus();
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || busy || !ready) return;
              e.preventDefault();
              onConfirm();
            }}
          >
            <div className="alert-body">
              <AlertDialog.Title asChild>
                <h3>{title}</h3>
              </AlertDialog.Title>
              {text && (
                <AlertDialog.Description asChild>
                  <div className="alert-text">{text}</div>
                </AlertDialog.Description>
              )}
            </div>
            <div className="modal-foot alert-foot">
              <AlertDialog.Cancel asChild>
                <button type="button" className="btn" data-keys="Esc">
                  {cancel}
                </button>
              </AlertDialog.Cancel>
              <button
                type="button"
                className={`btn ${danger ? 'danger-fill' : 'primary'}`}
                onClick={onConfirm}
                disabled={busy || !ready}
                data-testid="confirm-action"
                data-keys={danger ? '⌘↵' : '↵'}
              >
                {busy && <Spinner />} {action}
              </button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Overlay>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export function DrawerLayer({ open, onOpenChange, title, children }: DrawerProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="backdrop drawer-backdrop" onClick={stop} />
        <Dialog.Content
          className="drawer"
          aria-describedby={undefined}
          onEscapeKeyDown={stop}
          onOpenAutoFocus={focusDialog}
          // Menus and dialogs opened from inside the drawer render in portals; using them isn't "outside".
          onInteractOutside={(e) => {
            if ((e.target as Element | null)?.closest?.('.menu, .modal, .popover, [data-radix-popper-content-wrapper]')) e.preventDefault();
          }}
        >
          <div className="drawer-head">
            <Dialog.Title asChild>
              <h3 className="grow">{title}</h3>
            </Dialog.Title>
            <Dialog.Close asChild>
              <IconButton label={t('Close')} icon="x" size={18} />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------- menus

type Parts = typeof DropdownMenu | typeof ContextMenuPrimitive;

function Choice({ P, choice }: { P: Parts; choice: MenuChoice['choice'] }) {
  return (
    <>
      <P.Label className="menu-label">{choice.label}</P.Label>
      <P.RadioGroup className="menu-theme" value={choice.value} onValueChange={choice.onChange}>
        {choice.options.map((o) => (
          <P.RadioItem key={o.value} value={o.value} asChild onSelect={(e: Event) => e.preventDefault()}>
            <button type="button" className={choice.value === o.value ? 'on' : ''}>
              {o.icon && <I name={o.icon} size={14} />}
              {o.label}
            </button>
          </P.RadioItem>
        ))}
      </P.RadioGroup>
    </>
  );
}

/**
 * A menu on a phone is a sheet (mobile.css): a submenu opens in its place there — its row leads back — rather than as a
 * second sheet over the first, and the sheet stays as short as the list it shows. `shown` is what the sheet lists now;
 * `drill` opens a submenu by its label (null: back), absent where submenus open beside the menu.
 */
function useDrill(items: MenuEntry[], open: boolean): { shown: MenuEntry[]; drill: ((label: string | null) => void) | null } {
  const phone = usePhone();
  const [inside, setInside] = useState<string | null>(null);
  // a menu opens at its top, whichever submenu it showed when it closed (kept while it closes: no jump on the way out)
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setInside(null);
  }
  // the submenu as the menu has it now (its items can change while it is open)
  const sub = phone && inside ? items.find((it): it is MenuSub => !!it && it !== 'sep' && 'sub' in it && it.sub.label === inside)?.sub : undefined;
  const back: MenuItem = { label: sub?.label ?? '', icon: 'back', keep: true, onClick: () => setInside(null) };
  return { shown: sub ? [back, 'sep', ...sub.items] : items, drill: phone ? setInside : null };
}

function menuItems(P: Parts, items: MenuEntry[], drill: ((label: string | null) => void) | null): ReactNode[] {
  return tidy(items).map((it, i) =>
    it === 'sep' ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity of their own
      <P.Separator key={`sep${i}`} className="menu-sep" />
    ) : 'choice' in it ? (
      <Choice key={`choice-${it.choice.label}`} P={P} choice={it.choice} />
    ) : 'heading' in it ? (
      <P.Label key={`head-${it.heading}`} className="menu-label">
        {it.heading}
      </P.Label>
    ) : 'sub' in it ? (
      drill ? (
        <Item key={`sub-${it.sub.label}`} P={P} it={{ label: it.sub.label, icon: it.sub.icon, keep: true, onClick: () => drill(it.sub.label) }} opens />
      ) : (
        <Sub key={`sub-${it.sub.label}`} P={P} sub={it.sub} />
      )
    ) : (
      <Item key={it.label} P={P} it={it} />
    ),
  );
}

/** A submenu: its row names it and points the way it opens (→, or ← when there is no room to the right). */
function Sub({ P, sub }: { P: Parts; sub: MenuSub['sub'] }) {
  return (
    <P.Sub>
      <P.SubTrigger asChild>
        <button type="button" className="menu-sub">
          {sub.icon ? <I name={sub.icon} size={15} /> : <span className="menu-icon-gap" />}
          <span className="grow">{sub.label}</span>
          <I name="right" size={14} className="menu-sub-arrow" />
        </button>
      </P.SubTrigger>
      <P.Portal>
        {/* beside the menu's edge (its row sits inside 4 px of padding and a 1 px line), its first row level with this one */}
        <P.SubContent className="menu menu-subs" sideOffset={5} alignOffset={-5} collisionPadding={8} onClick={stop}>
          {menuItems(P, sub.items, null)}
        </P.SubContent>
      </P.Portal>
    </P.Sub>
  );
}

// A tap that opens a menu as a phone's sheet sends its click where the finger is lifted, and by then an item of the sheet
// may be there (a card's "Move to Approved"): an item takes a touch's click only when the press began on the menu
// itself. The keys (and code) select without a press: they always count.
let press = { touch: false, onMenu: false, at: 0 };
let clicked = false;
if (typeof window !== 'undefined')
  window.addEventListener(
    'pointerdown',
    (e) => {
      press = { touch: e.pointerType !== 'mouse', onMenu: !!(e.target as Element | null)?.closest?.('.menu'), at: performance.now() };
    },
    true,
  );
const ghostTap = () => clicked && press.touch && !press.onMenu && performance.now() - press.at < GHOST_MS;
const GHOST_MS = 800;

/** `opens`: the row opens a submenu in the sheet's place (a phone's), and says so with its arrow. */
function Item({ P, it, opens = false }: { P: Parts; it: MenuItem; opens?: boolean }) {
  const select = (e: Event) => {
    const ghost = ghostTap();
    clicked = false;
    if (ghost) return e.preventDefault();
    if (it.keep) e.preventDefault();
    it.onClick();
  };
  const click = (e: ReactMouseEvent) => {
    clicked = e.nativeEvent.isTrusted;
  };
  // A menu on its way out stops taking the pointer (ui.css), so the item under it is "left": Radix would then focus the
  // closing menu and take the focus from the field its item just opened.
  const leave = (e: ReactPointerEvent) => {
    if ((e.currentTarget as Element).closest('[data-state=closed]')) e.preventDefault();
  };
  const face = (
    <button type="button" className={it.danger ? 'danger' : opens ? 'menu-sub' : ''} onClickCapture={click}>
      {it.mark ?? (it.icon ? <I name={it.icon} size={15} /> : <span className="menu-icon-gap" />)}
      <span className="grow">{it.label}</span>
      {it.shortcut && <kbd className="menu-kbd">{it.shortcut}</kbd>}
      {it.checked !== undefined && <I name="check" size={14} className="menu-tick" />}
      {opens && <I name="right" size={14} className="menu-sub-arrow" />}
    </button>
  );
  if (it.checked !== undefined)
    return (
      <P.CheckboxItem asChild checked={it.checked} onSelect={select} onPointerLeave={leave} disabled={it.disabled}>
        {face}
      </P.CheckboxItem>
    );
  return (
    <P.Item asChild onSelect={select} onPointerLeave={leave} disabled={it.disabled}>
      {face}
    </P.Item>
  );
}

// A menu gives the focus back to what opened it only when nothing else took it: an item that opens a field of its own
// ("Link…" in the composer's paperclip) keeps the field focused instead of the menu's button getting it back a moment
// later, under the typing.
const focusTaken = () => {
  const el = document.activeElement;
  return !!el && el !== document.body && !el.closest('.menu');
};
const keepTakenFocus = (e: Event) => {
  if (focusTaken()) e.preventDefault();
};

// Closing a menu that was opened with the pointer: inside a composer the typing goes on — its text field takes the
// focus (not on touch screens, where that throws up the keyboard over the picture); elsewhere the trigger gets it back
// without a focus ring (Firefox showed one after a click). From the keyboard Radix gives it back, ring and all.
const closeFocus = (via: RefObject<'pointer' | 'keyboard'>, anchor: AnchorLink) => (e: Event) => {
  if (focusTaken()) return e.preventDefault();
  const trigger = anchor.el.current;
  if (via.current !== 'pointer' || !trigger?.isConnected) return;
  e.preventDefault();
  const typing = matchMedia('(pointer: coarse)').matches ? null : trigger.closest('.composer')?.querySelector<HTMLElement>('.composer-text');
  // focusVisible: false is Firefox's (and the spec's) way to say "no ring"; other browsers don't draw one after a click
  (typing ?? trigger).focus({ preventScroll: true, focusVisible: false } as FocusOptions);
};

// Opened from the keyboard before the menu's Radix part was mounted, Radix hasn't seen the key: the first item takes
// the focus here, as Radix gives it when it has.
const focusFirstItem = (e: Event) => {
  e.preventDefault();
  const content = e.target as HTMLElement;
  content.focus({ preventScroll: true });
  content.querySelector<HTMLElement>('[role^=menuitem]:not([data-disabled])')?.focus({ preventScroll: true });
};

export function MenuLayer({
  anchor,
  open,
  onOpenChange,
  via,
  id,
  items,
  side,
  align,
  sideOffset,
}: {
  anchor: AnchorLink;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  via: RefObject<'pointer' | 'keyboard'>;
  id: string;
  items: MenuEntry[];
  side: 'top' | 'bottom';
  align: 'start' | 'end';
  sideOffset: number;
}) {
  const { shown, drill } = useDrill(items, open);
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenu.Trigger asChild>
        <Anchor link={anchor} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          id={`${id}c`}
          aria-labelledby={`${id}t`}
          className="menu"
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={8}
          onClick={stop}
          // Not in DropdownMenuContent's types, but handed on to the menu's content, which composes it with its own.
          {...{ onOpenAutoFocus: (e: Event) => via.current === 'keyboard' && focusFirstItem(e) }}
          onCloseAutoFocus={closeFocus(via, anchor)}
        >
          {menuItems(DropdownMenu, shown, drill)}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function ContextMenuLayer({ anchor, onOpenChange, items }: { anchor: AnchorLink; onOpenChange: (open: boolean) => void; items: MenuEntry[] }) {
  const [open, setOpen] = useState(false);
  const { shown, drill } = useDrill(items, open);
  const change = (o: boolean) => {
    setOpen(o);
    onOpenChange(o);
  };
  return (
    <ContextMenuPrimitive.Root onOpenChange={change} modal={false}>
      <ContextMenuPrimitive.Trigger asChild>
        <Anchor link={anchor} />
      </ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content
          className="menu context-menu"
          collisionPadding={8}
          onClick={stop}
          onCloseAutoFocus={keepTakenFocus}
          data-testid="context-menu"
        >
          {menuItems(ContextMenuPrimitive, shown, drill)}
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}

// ---------------------------------------------------------------- popover and hover card

export function PopoverLayer({
  anchor,
  id,
  open,
  onOpenChange,
  children,
  className,
  sideOffset,
  align,
  onEscapeKeyDown,
  onOpenAutoFocus,
}: Omit<PopoverProps, 'trigger'> & { anchor: AnchorLink; id: string }) {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>
        <Anchor link={anchor} />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          id={`${id}c`}
          className={`popover ${className}`}
          side="bottom"
          align={align}
          sideOffset={sideOffset}
          collisionPadding={8}
          onClick={stop}
          onEscapeKeyDown={onEscapeKeyDown}
          onOpenAutoFocus={onOpenAutoFocus}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

export function HoverCardLayer({
  anchor,
  onOpenChange,
  children,
  side,
  align,
  className,
}: {
  anchor: AnchorLink;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  side: 'top' | 'bottom' | 'left' | 'right';
  align: 'start' | 'center' | 'end';
  className: string;
}) {
  return (
    <HoverCardPrimitive.Root openDelay={350} closeDelay={120} onOpenChange={onOpenChange}>
      <HoverCardPrimitive.Trigger asChild>
        <Anchor link={anchor} />
      </HoverCardPrimitive.Trigger>
      <HoverCardPrimitive.Portal>
        <HoverCardPrimitive.Content className={`hovercard ${className}`} side={side} align={align} sideOffset={6} collisionPadding={8} onClick={stop}>
          {children}
        </HoverCardPrimitive.Content>
      </HoverCardPrimitive.Portal>
    </HoverCardPrimitive.Root>
  );
}

// ---------------------------------------------------------------- tooltips

/** The tooltip's trigger: the hovered element, described by the tooltip while it shows (as Radix's trigger is). */
function TipAnchor({ el, ref, 'aria-describedby': describedBy }: { el: HTMLElement; ref?: Ref<HTMLElement>; 'aria-describedby'?: string }) {
  useLayoutEffect(() => {
    setRef(ref, el);
    return () => setRef(ref, null);
  }, [ref, el]);
  useLayoutEffect(() => {
    if (!describedBy) return;
    const before = el.getAttribute('aria-describedby');
    el.setAttribute('aria-describedby', describedBy);
    return () => (before === null ? el.removeAttribute('aria-describedby') : el.setAttribute('aria-describedby', before));
  }, [el, describedBy]);
  return null;
}

interface Shown {
  id: number;
  el: HTMLElement;
  open: boolean;
}

const OPEN_DELAY = 450;
const SKIP_DELAY = 250;

/**
 * Every tooltip of the app, one at a time: the note (ui/tip.tsx) of the element under the pointer (after a moment; at
 * once when another tooltip showed just before) or with keyboard focus, shown by a Radix tooltip anchored to it. Once
 * an element is clicked (or Enter/Space pressed on it) its tooltip stays away until the pointer leaves or it loses
 * focus. Radix's tooltip content does the rest: the pointer may cross over to it, Escape, a scroll or a press
 * elsewhere closes it.
 */
export function TooltipLayer() {
  const [shown, setShown] = useState<Shown[]>([]);
  const [, redraw] = useState(0);
  const close = useRef<(id: number) => void>(() => {});
  useEffect(() => {
    let seq = 0;
    let current: Shown | null = null;
    let hovered: HTMLElement | null = null;
    let quiet: HTMLElement | null = null;
    let openTimer = 0;
    let skipTimer = 0;
    let gone = 0;
    // Whether the next tooltip waits: not when another one showed a moment ago.
    let delayed = true;
    let pointerDown = false;
    const wanted = (el: HTMLElement) => el.isConnected && quiet !== el && !!tipOf(el) && el.matches(':hover, :focus-visible');
    const show = (el: HTMLElement) => {
      window.clearTimeout(openTimer);
      if (current?.el === el || !wanted(el)) return;
      window.clearTimeout(skipTimer);
      delayed = false;
      current = { id: ++seq, el, open: true };
      const next = current;
      // The one before fades out (its content unmounts after its animation); older ones are gone by now.
      setShown((list) => [...list.filter((s) => s.open).map((s) => ({ ...s, open: false })), next]);
      watchTip(el, () => redraw((n) => n + 1));
      window.clearInterval(gone);
      // An element that leaves the page takes its tooltip with it.
      gone = window.setInterval(() => current && !current.el.isConnected && hide(), 250);
    };
    const hide = () => {
      window.clearTimeout(openTimer);
      if (!current) return;
      current = null;
      watchTip(null, () => {});
      window.clearInterval(gone);
      setShown((list) => list.filter((s) => s.open).map((s) => ({ ...s, open: false })));
      window.clearTimeout(skipTimer);
      skipTimer = window.setTimeout(() => {
        delayed = true;
      }, SKIP_DELAY);
    };
    close.current = (id) => current?.id === id && hide();
    const enter = (el: HTMLElement) => {
      if (current?.el === el || quiet === el) return;
      window.clearTimeout(openTimer);
      if (delayed) openTimer = window.setTimeout(() => show(el), OPEN_DELAY);
      else show(el);
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = tipTarget(e.target);
      if (el === hovered) return;
      if (hovered && quiet === hovered && document.activeElement !== hovered) quiet = null;
      hovered = el;
      window.clearTimeout(openTimer);
      if (el) enter(el);
    };
    const out = (e: PointerEvent) => {
      if (!hovered || (e.relatedTarget instanceof Node && hovered.contains(e.relatedTarget))) return;
      if (quiet === hovered) quiet = null;
      hovered = null;
      // Leaving before it showed cancels it; once shown, Radix closes it (the pointer may cross over to it).
      window.clearTimeout(openTimer);
    };
    const hush = (el: HTMLElement) => {
      quiet = el;
      if (current?.el === el) hide();
      else window.clearTimeout(openTimer);
    };
    const down = (e: PointerEvent) => {
      const el = tipTarget(e.target);
      if (!el) return;
      pointerDown = true;
      hush(el);
    };
    const up = () => {
      pointerDown = false;
    };
    const focus = (e: FocusEvent) => {
      const el = tipTarget(e.target);
      if (el && !pointerDown && el === e.target) show(el);
    };
    const blur = (e: FocusEvent) => {
      const el = tipTarget(e.target);
      if (!el || el !== e.target) return;
      if (quiet === el && hovered !== el) quiet = null;
      if (current?.el === el) hide();
    };
    const key = (e: KeyboardEvent) => {
      // A tooltip on its way out (its element just lost the focus or the pointer) is still a Radix layer that takes
      // Escape: the Esc meant for the page (leave a field, close the composer) would do nothing. It goes now,
      // synchronously, so this same key press reaches what it was meant for. An open tooltip keeps its Escape.
      if (e.key === 'Escape' && !current) return flushSync(() => setShown((list) => (list.length ? [] : list)));
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const el = tipTarget(e.target);
      if (el && el === e.target) hush(el);
    };
    const click = (e: MouseEvent) => {
      const el = tipTarget(e.target);
      if (el && current?.el === el) hide();
    };
    const opts = { capture: true, passive: true };
    document.addEventListener('pointerover', over, opts);
    document.addEventListener('pointerout', out, opts);
    document.addEventListener('pointerdown', down, opts);
    document.addEventListener('pointerup', up, opts);
    document.addEventListener('focusin', focus, true);
    document.addEventListener('focusout', blur, true);
    document.addEventListener('keydown', key, true);
    document.addEventListener('click', click, true);
    // Already under the pointer when the layer arrived.
    const under = [...document.querySelectorAll(':hover')].at(-1);
    if (under) {
      hovered = tipTarget(under);
      if (hovered) enter(hovered);
    }
    return () => {
      window.clearTimeout(openTimer);
      window.clearTimeout(skipTimer);
      window.clearInterval(gone);
      watchTip(null, () => {});
      document.removeEventListener('pointerover', over, opts);
      document.removeEventListener('pointerout', out, opts);
      document.removeEventListener('pointerdown', down, opts);
      document.removeEventListener('pointerup', up, opts);
      document.removeEventListener('focusin', focus, true);
      document.removeEventListener('focusout', blur, true);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('click', click, true);
    };
  }, []);
  // Closed ones are dropped once their fade-out has run.
  useEffect(() => {
    if (!shown.some((s) => !s.open)) return;
    const t = window.setTimeout(() => setShown((list) => list.filter((s) => s.open)), 200);
    return () => window.clearTimeout(t);
  }, [shown]);
  return (
    <Tooltip.Provider delayDuration={0} skipDelayDuration={0}>
      {shown.map((s) => {
        const note: TipNote | null = tipOf(s.el);
        return (
          <Tooltip.Root key={s.id} open={s.open && !!note} onOpenChange={(o) => !o && close.current(s.id)}>
            <Tooltip.Trigger asChild>
              <TipAnchor el={s.el} />
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content className="tip" side={note?.side ?? 'top'} sideOffset={6} collisionPadding={8}>
                {note?.content}
                {note?.shortcut && <Kbd>{note.shortcut}</Kbd>}
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        );
      })}
    </Tooltip.Provider>
  );
}

// ---------------------------------------------------------------- toasts

const MAX = 3;
// Gone without its action used (timed out, swiped, closed, pushed out): a change it deferred goes through now.
const dismissed = (acted: Set<number>, t: ToastItem) => {
  if (!acted.delete(t.id)) t.onDismiss?.();
};
const lifetime = (t: ToastItem) => t.duration ?? (t.kind === 'error' ? 7000 : t.action ? 6500 : 3200);
// A limit reached opens its sheet instead of a toast (conversion/limits/): its code comes the first time one is asked for.
const limitCode = loader(() => import('../conversion/limits/LimitSheet.tsx'));

/** Toasts (Radix Toast: announced to screen readers, paused while hovered or focused, swipe to dismiss, F8 jumps to
 * them), including the ones asked for before this layer arrived. */
export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  // the limit asked about now (a newer one takes its place), and its sheet's code once here
  const [limit, setLimit] = useState<{ id: number; ask: LimitAsk } | null>(null);
  const Limit = useLoaded(limitCode, !!limit);
  // Phones: toasts drop in under the top bar (and are swiped up), clear of the notes sheet and the transport.
  const phone = usePhone();
  const shown = useRef<ToastItem[]>([]);
  shown.current = items;
  // Toasts whose action was used: closing them is not a dismissal.
  const acted = useRef(new Set<number>());
  useEffect(() => {
    const add = (t: ToastItem) => {
      if (t.limit) return setLimit({ id: t.id, ask: t.limit });
      // The oldest make room; a deferred change they carried goes through now.
      const next = [...shown.current, t];
      for (const old of next.slice(0, Math.max(0, next.length - MAX))) dismissed(acted.current, old);
      shown.current = next.slice(-MAX);
      setItems(shown.current);
    };
    const onToast = (e: Event) => add((e as CustomEvent<ToastItem>).detail);
    // Radix makes every toast a dismissable layer, the newest one on top: it would take Escape from a dialog, menu or
    // popover that is open under it. An Escape meant for those clears the toasts first, synchronously, so the layer
    // below handles this same key press.
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !shown.current.length || (e.target as Element | null)?.closest?.('.toasts')) return;
      if (!document.querySelector('[role=dialog], [role=alertdialog], [role=menu], [role=listbox], [data-radix-popper-content-wrapper]')) return;
      for (const t of shown.current) dismissed(acted.current, t);
      shown.current = [];
      flushSync(() => setItems([]));
    };
    // Taken away by whoever showed it (closeToast): not a dismissal.
    const onClose = (e: Event) => {
      const id = (e as CustomEvent<number>).detail;
      if (!shown.current.some((x) => x.id === id)) return;
      acted.current.add(id);
      shown.current = shown.current.filter((x) => x.id !== id);
      setItems(shown.current);
    };
    for (const t of claimToasts()) add(t);
    window.addEventListener('vr-toast', onToast);
    window.addEventListener('vr-toast-close', onClose);
    window.addEventListener('keydown', onEscape, true);
    return () => {
      releaseToasts();
      window.removeEventListener('vr-toast', onToast);
      window.removeEventListener('vr-toast-close', onClose);
      window.removeEventListener('keydown', onEscape, true);
    };
  }, []);
  const closeToast = (t: ToastItem) => {
    dismissed(acted.current, t);
    setItems((xs) => xs.filter((x) => x.id !== t.id));
  };
  return (
    <Toast.Provider swipeDirection={phone ? 'up' : 'down'} label={t('Notification')}>
      {items.map((item) => (
        <Toast.Root
          key={item.id}
          className={`toast ${item.kind}`}
          duration={lifetime(item)}
          type={item.kind === 'error' ? 'foreground' : 'background'}
          onOpenChange={(open) => !open && closeToast(item)}
          data-testid="toast"
        >
          {item.kind === 'ok' && <I name="check" size={15} />}
          {item.kind === 'error' && <I name="x" size={15} />}
          <Toast.Title className="toast-title">{item.message}</Toast.Title>
          {item.action && (
            <Toast.Action
              asChild
              altText={t('{label} (also in the page’s own controls)', { label: item.action.label })}
              onClick={() => {
                acted.current.add(item.id);
                item.action?.onClick();
              }}
            >
              <button type="button" className="toast-act">
                {item.action.undo && <I name="undo" size={13} />}
                {item.action.label}
              </button>
            </Toast.Action>
          )}
          <Toast.Close asChild>
            <IconButton className="toast-x" label={t('Dismiss')} icon="x" size={13} />
          </Toast.Close>
        </Toast.Root>
      ))}
      <Toast.Viewport className="toasts" />
      {limit && Limit && <Limit.LimitSheet key={limit.id} ask={limit.ask} onClose={() => setLimit(null)} />}
    </Toast.Provider>
  );
}
