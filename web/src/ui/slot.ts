// Props handed on to a child element, the way Radix's Slot does it (the same merge rules, so every trigger behaves as
// before): the child's own handlers run first, then the slot's; styles and class names are combined; any other prop of
// the child wins; refs are composed. Without Radix, so the start of the app doesn't carry it (ui/primitives.tsx).
import { cloneElement, isValidElement, type ReactElement, type ReactNode, type Ref, type RefCallback } from 'react';

type AnyProps = Record<string, unknown>;
type Handler = (...args: unknown[]) => unknown;

export function setRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

export function composeRefs<T>(...refs: (Ref<T> | undefined)[]): RefCallback<T> {
  return (node: T | null) => {
    for (const r of refs) setRef(r, node);
  };
}

function mergeProps(slot: AnyProps, child: AnyProps): AnyProps {
  const over: AnyProps = { ...child };
  for (const name in child) {
    const s = slot[name];
    const c = child[name];
    if (/^on[A-Z]/.test(name)) {
      if (s && c)
        over[name] = (...args: unknown[]) => {
          const result = (c as Handler)(...args);
          (s as Handler)(...args);
          return result;
        };
      else if (s) over[name] = s;
    } else if (name === 'style') over[name] = { ...(s as object), ...(c as object) };
    else if (name === 'className') over[name] = [s, c].filter(Boolean).join(' ');
  }
  return { ...slot, ...over };
}

/** `child` with `props` merged in (see above) and `refs` composed with its own ref. */
export function slot(child: ReactNode, props: AnyProps, ...refs: (Ref<unknown> | undefined)[]): ReactElement | null {
  if (!isValidElement(child)) return null;
  const own = (child.props as { ref?: Ref<unknown> }).ref;
  const wanted = refs.filter(Boolean);
  const merged = mergeProps(props, child.props as AnyProps);
  if (wanted.length) merged.ref = own ? composeRefs(...wanted, own) : wanted.length === 1 ? wanted[0] : composeRefs(...wanted);
  return cloneElement(child, merged);
}
