// Leaving a dialog for another page and coming back to it (lib/nav.ts, "The way back"): a dialog says how it opens
// again (`ReopenScope`), a link inside it goes through `LeaveLink`, and the dialog's host opens it once its entry is back
// (`useReopen`), by Settings' own back or the browser's. A link outside any scope just leaves; its way back still
// returns to the page.
import { type AnchorHTMLAttributes, createContext, type MouseEvent, type ReactNode, useContext, useEffect, useRef } from 'react';
import { leaveFor, type Reopen, takeReopen } from './nav.ts';

interface Scope {
  reopen: Reopen;
  /** The dialog closes as it is left (one that lives outside the page, like a limit's sheet, would stay over the next). */
  close?: () => void;
}
const ScopeContext = createContext<Scope | null>(null);

export function ReopenScope({ reopen, close, children }: Scope & { children: ReactNode }) {
  return <ScopeContext.Provider value={{ reopen, close }}>{children}</ScopeContext.Provider>;
}

/** A link to another page from inside a dialog: coming back opens the dialog again. A click that opens a new tab stays one. */
export function LeaveLink({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const scope = useContext(ScopeContext);
  const leave = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    scope?.close?.();
    leaveFor(href, scope?.reopen);
  };
  return <a href={href} onClick={leave} {...rest} />;
}

/** Opens the dialog of `kind` again when its entry is back (on mount, and while mounted when the address moves back). */
export function useReopen(kind: string, open: (r: Reopen) => void): void {
  const ref = useRef(open);
  ref.current = open;
  useEffect(() => {
    const check = () => {
      const r = takeReopen(kind);
      if (r) ref.current(r);
    };
    check();
    window.addEventListener('hashchange', check);
    return () => window.removeEventListener('hashchange', check);
  }, [kind]);
}
