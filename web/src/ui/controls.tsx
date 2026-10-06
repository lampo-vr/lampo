// Form and display controls on Radix Primitives, in our tokens: checkbox, progress, slider, separator, a growing text
// field; the switch, avatar and scroll area are plain elements (ui/plain.tsx), re-exported here. Usage notes:
// web/README.md → "UI primitives".
import { Checkbox as CheckboxPrimitive, Progress as ProgressPrimitive, Separator as SeparatorPrimitive, Slider as SliderPrimitive } from 'radix-ui';
import { type Ref, type TextareaHTMLAttributes, useLayoutEffect, useRef } from 'react';
import { I } from './icons.tsx';
import type { ToggleProps } from './plain.tsx';

export { Avatar, type AvatarKind, avatarKind, initials, ScrollArea, Switch } from './plain.tsx';

// ---------------------------------------------------------------- checkbox

export function Checkbox({ checked, onCheckedChange, disabled, id, label }: ToggleProps) {
  return (
    <CheckboxPrimitive.Root
      className="checkbox"
      checked={checked}
      onCheckedChange={(c) => onCheckedChange(c === true)}
      disabled={disabled}
      id={id}
      aria-label={label}
    >
      <CheckboxPrimitive.Indicator className="checkbox-mark">
        <I name="check" size={12} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

// ---------------------------------------------------------------- progress

/** A thin bar; `value` null is indeterminate (a sweep). `tone` colours the fill. */
export function Progress({ value, label, tone, className = '' }: { value: number | null; label: string; tone?: 'ok' | 'claude' | 'must'; className?: string }) {
  const v = value === null ? null : Math.max(0, Math.min(100, value));
  return (
    <ProgressPrimitive.Root className={`progress ${tone || ''} ${className}`} value={v} max={100} aria-label={label}>
      <ProgressPrimitive.Indicator className="progress-fill" style={v === null ? undefined : { transform: `translateX(-${100 - v}%)` }} />
    </ProgressPrimitive.Root>
  );
}

// ---------------------------------------------------------------- slider

/** A value on a track (0–100 unless told otherwise): arrows step, shift+arrows step by ten, Home/End jump. */
export function Slider({
  value,
  onChange,
  label,
  min = 0,
  max = 100,
  step = 1,
  className = '',
}: {
  value: number;
  onChange: (v: number) => void;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
}) {
  return (
    <SliderPrimitive.Root className={`slider ${className}`} value={[value]} onValueChange={([v]) => onChange(v as number)} min={min} max={max} step={step}>
      <SliderPrimitive.Track className="slider-track">
        <SliderPrimitive.Range className="slider-range" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb className="slider-thumb" aria-label={label} />
    </SliderPrimitive.Root>
  );
}

// ---------------------------------------------------------------- separator

export const Separator = ({ vertical, className = '' }: { vertical?: boolean; className?: string }) => (
  <SeparatorPrimitive.Root className={`sep ${className}`} orientation={vertical ? 'vertical' : 'horizontal'} decorative />
);

// ---------------------------------------------------------------- growing text field

interface AutoTextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onSubmit'> {
  value: string;
  /** ⌘↵ / ctrl+↵. */
  onSubmit?: () => void;
  /** Esc: handled here, so it doesn't also reach the player's shortcuts. */
  onCancel?: () => void;
  ref?: Ref<HTMLTextAreaElement>;
}

/** A text field that grows with what is typed (no resize handle, no inner scrollbar): notes, replies, answers. */
export function AutoTextarea({ value, onSubmit, onCancel, onKeyDown, className = '', rows = 1, ref, ...rest }: AutoTextareaProps) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the height follows the text
  useLayoutEffect(() => {
    const el = own.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [value]);
  return (
    <textarea
      {...rest}
      ref={(el) => {
        own.current = el;
        if (typeof ref === 'function') ref(el);
        else if (ref) ref.current = el;
      }}
      rows={rows}
      value={value}
      className={`textarea autotext ${className}`}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && onSubmit) {
          e.preventDefault();
          onSubmit();
        } else if (e.key === 'Escape' && onCancel) {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    />
  );
}
