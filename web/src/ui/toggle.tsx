// A row of mutually exclusive toggles (segmented controls, the theme and language switches): the DOM, roles and
// keyboard of a Radix single-choice ToggleGroup — role=group with role=radio items, data-state on/off, one tab stop
// that moves with the arrow keys (Home/End too, wrapping) — without Radix, so the library's toolbar and sidebar don't
// load it for their first paint.
import {
  type ButtonHTMLAttributes,
  createContext,
  type FocusEvent,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  use,
  useMemo,
  useRef,
  useState,
} from 'react';
import { slot } from './slot.ts';

interface Group {
  value: string;
  select: (v: string) => void;
  stop: string | null;
  setStop: (v: string) => void;
  shiftTab: () => void;
}
const GroupContext = createContext<Group | null>(null);

const INTENT: Record<string, 'prev' | 'next' | 'first' | 'last'> = {
  ArrowLeft: 'prev',
  ArrowUp: 'prev',
  ArrowRight: 'next',
  ArrowDown: 'next',
  PageUp: 'first',
  Home: 'first',
  PageDown: 'last',
  End: 'last',
};

const itemsOf = (group: Element | null) => [...(group?.querySelectorAll<HTMLElement>('[role=radio]:not(:disabled)') ?? [])];

function focusFirst(candidates: HTMLElement[]) {
  const before = document.activeElement;
  for (const c of candidates) {
    if (c === before) return;
    c.focus();
    if (document.activeElement !== before) return;
  }
}

/** The group: `value` is the pressed item; picking the pressed one again changes nothing (like `v && onChange(v)`). */
export function ToggleGroup({
  value,
  onValueChange,
  children,
  ...rest
}: { value: string; onValueChange: (v: string) => void; children: ReactNode } & Omit<HTMLAttributes<HTMLDivElement>, 'onChange'>) {
  const [stop, setStop] = useState<string | null>(null);
  const [out, setOut] = useState(false);
  const clickFocus = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const change = useRef(onValueChange);
  change.current = onValueChange;
  const ctx = useMemo<Group>(() => ({ value, select: (v) => change.current(v), stop, setStop, shiftTab: () => setOut(true) }), [value, stop]);
  return (
    <GroupContext value={ctx}>
      {/* biome-ignore lint/a11y/useSemanticElements: the same element Radix renders (a fieldset would bring its own box) */}
      <div
        role="group"
        dir="ltr"
        tabIndex={out ? -1 : 0}
        {...rest}
        ref={ref}
        style={{ outline: 'none', ...rest.style }}
        onMouseDown={(e) => {
          rest.onMouseDown?.(e);
          clickFocus.current = true;
        }}
        onFocus={(e: FocusEvent<HTMLDivElement>) => {
          rest.onFocus?.(e);
          // Tabbing onto the group lands on the pressed item (or the last one focused, or the first).
          if (e.target === e.currentTarget && !clickFocus.current && !out) {
            const items = itemsOf(e.currentTarget);
            const pressed = items.find((i) => i.getAttribute('aria-checked') === 'true');
            const current = items.find((i) => i.dataset.value === stop);
            focusFirst([pressed, current, ...items].filter((x): x is HTMLElement => !!x));
          }
          clickFocus.current = false;
        }}
        onBlur={(e) => {
          rest.onBlur?.(e);
          setOut(false);
        }}
      >
        {children}
      </div>
    </GroupContext>
  );
}

/** One toggle: a button of its own, or (`asChild`) the one element passed in, which takes the item's props. */
export function ToggleItem({
  value,
  asChild,
  children,
  ...rest
}: { value: string; asChild?: boolean; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const g = use(GroupContext);
  if (!g) throw new Error('ToggleItem outside a ToggleGroup');
  const on = g.value === value;
  // The item's own props go on as well (with asChild, slot() merges the child's over them, as Radix does); its handlers
  // run before the toggle's.
  const own: ButtonHTMLAttributes<HTMLButtonElement> = rest;
  const props = {
    type: 'button',
    role: 'radio',
    'aria-checked': on,
    'data-state': on ? 'on' : 'off',
    'data-disabled': rest.disabled ? '' : undefined,
    'data-value': value,
    tabIndex: g.stop === value ? 0 : -1,
    ...own,
    onClick: (e: MouseEvent<HTMLButtonElement>) => {
      own.onClick?.(e);
      if (!e.defaultPrevented && !on && !rest.disabled) g.select(value);
    },
    onMouseDown: (e: MouseEvent<HTMLButtonElement>) => {
      own.onMouseDown?.(e);
      if (rest.disabled) e.preventDefault();
      else g.setStop(value);
    },
    onFocus: (e: FocusEvent<HTMLButtonElement>) => {
      own.onFocus?.(e);
      g.setStop(value);
    },
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      own.onKeyDown?.(e);
      if (e.key === 'Tab' && e.shiftKey) return g.shiftTab();
      if (e.target !== e.currentTarget) return;
      const intent = INTENT[e.key];
      if (!intent || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      let items = itemsOf(e.currentTarget.closest('[role=group]'));
      if (intent === 'last' || intent === 'prev') items.reverse();
      if (intent === 'prev' || intent === 'next') {
        const at = items.indexOf(e.currentTarget);
        items = [...items.slice(at + 1), ...items.slice(0, at + 1)];
      }
      setTimeout(() => focusFirst(items));
    },
  };
  if (asChild) return slot(children as ReactElement, props);
  return <button {...(props as ButtonHTMLAttributes<HTMLButtonElement>)}>{children}</button>;
}
