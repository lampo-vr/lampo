// A select on Radix with our look (.input.select, .menu.select-menu). Its own module: the screens that use it (the
// player, settings, client pages) bring it along; the library's first paint doesn't need it (ui/primitives.tsx).
import { Select as SelectPrimitive } from 'radix-ui';
import type { CSSProperties } from 'react';
import { I } from './icons.tsx';
import type { Option } from './primitives.tsx';

// Radix reserves "" for "no value", so empty option values travel as a sentinel.
const NONE = '\u0000none';
const toRadix = (v: string) => (v === '' ? NONE : v);
const fromRadix = (v: string) => (v === NONE ? '' : v);

interface SelectProps {
  /** sm: the small control height (toolbars, the transport). */
  size?: 'sm' | 'md';
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  style?: CSSProperties;
  title?: string;
  label?: string;
}

// Focus does not return to the trigger after picking: the player's keyboard shortcuts (space, arrows) keep working.
export function Select({ value, onChange, options, style, title, label, size }: SelectProps) {
  return (
    <SelectPrimitive.Root value={toRadix(value)} onValueChange={(v) => onChange(fromRadix(v))}>
      <SelectPrimitive.Trigger className={`input select ${size === 'sm' ? 'sm' : ''}`} style={style} title={title} aria-label={label || title}>
        <span className="select-sizer">
          {options.map((o) => (
            <span key={o.value} aria-hidden>
              {o.label}
            </span>
          ))}
          <SelectPrimitive.Value />
        </span>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          className="menu select-menu"
          position="popper"
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <SelectPrimitive.Viewport>
            {options.map((o) => (
              <SelectPrimitive.Item key={o.value} value={toRadix(o.value)} className="select-item">
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="select-check">
                  <I name="check" size={13} />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
